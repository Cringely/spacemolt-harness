import { Database } from "bun:sqlite";
import { PlanSchema, type Plan } from "../registry/plan";

export interface AgentEvent {
  agentId: string;
  ts: number; // epoch ms
  type: string;
  payload: unknown;
}

export interface PlanCursor {
  step: number;
  iteration: number;
}

/**
 * One row of the dock trail (see Store.dockTrail, issue #525) -- either a
 * position sample or a dock attempt, in the order they happened. Every field
 * past `type`/`ts` comes straight out of json_extract, so it is `unknown` and
 * the caller narrows: a payload written by an older build, or a game that
 * reworded its prose, must not be able to type-lie its way into the pilot's map.
 */
export interface DockTrailRow {
  type: string;
  ts: number;
  systemId: unknown;
  outcome: unknown;
  result: unknown;
}

export class Store {
  private db: Database;
  /** Broadcast hook: dashboard server subscribes here (Plan 3). */
  onEvent?: (e: AgentEvent & { id: number }) => void;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent_id, ts);
      CREATE TABLE IF NOT EXISTS plans (
        agent_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        iteration INTEGER NOT NULL DEFAULT 0,
        goals TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  appendEvent(e: AgentEvent): number {
    const row = this.db
      .query("INSERT INTO events (agent_id, ts, type, payload) VALUES (?, ?, ?, ?) RETURNING id")
      .get(e.agentId, e.ts, e.type, JSON.stringify(e.payload ?? null)) as { id: number };
    this.onEvent?.({ ...e, id: row.id });
    return row.id;
  }

  recentEvents(agentId: string, limit: number): Array<AgentEvent & { id: number }> {
    const rows = this.db
      .query("SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
      .all(agentId, limit) as Array<{ id: number; agent_id: string; ts: number; type: string; payload: string }>;
    return rows.reverse().map((r) => ({
      id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload),
    }));
  }

  /**
   * All events for one agent at or after `cutoffTs`, ascending. Distinct from
   * recentEvents (id-DESC, hard LIMIT, built for "show me the last N in the
   * feed UI"): usage aggregation (Plan 3 Task 3) needs every event inside a
   * time window, which can exceed any reasonable "recent" cap on a busy
   * agent. Zero new persisted state -- same events table, a second read
   * shape over it, exactly like recentEvents already is.
   */
  eventsSince(agentId: string, cutoffTs: number): Array<AgentEvent & { id: number }> {
    const rows = this.db
      .query("SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? AND ts >= ? ORDER BY id ASC")
      .all(agentId, cutoffTs) as Array<{ id: number; agent_id: string; ts: number; type: string; payload: string }>;
    return rows.map((r) => ({
      id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload),
    }));
  }

  /**
   * Count `wake` events for one agent at or after `cutoffTs`. Backs the Layer 3
   * per-agent rolling ceiling (src/agent/agent.ts): one index-assisted
   * COUNT(*) over the existing idx_events_agent_ts index on (agent_id, ts) --
   * no new persisted state, no scan of payloads. Sourced from the events table
   * rather than an in-memory counter so the cap is restart-safe.
   */
  countWakesSince(agentId: string, cutoffTs: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND type = 'wake' AND ts >= ?")
      .get(agentId, cutoffTs) as { n: number };
    return row.n;
  }

  /**
   * The last `limit` events of ONE type for one agent, ascending. Backs the
   * agent's incompatible-POI map memory (issue #253): rebuilt at construction
   * from persisted `poi_incompatible` events, following countWakesSince's
   * pattern -- sourced from the events table rather than an in-memory
   * structure so the memory is restart-safe, with zero new persisted state
   * (the incident this serves was a restart landing the pilot back at the
   * same gas POI it had already been blocked at). Same index, same read
   * discipline as recentEvents; ascending so callers replaying into an
   * insertion-ordered structure keep oldest-first eviction correct.
   */
  recentEventsByType(agentId: string, type: string, limit: number): Array<AgentEvent & { id: number }> {
    const rows = this.db
      .query("SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? AND type = ? ORDER BY id DESC LIMIT ?")
      .all(agentId, type, limit) as Array<{ id: number; agent_id: string; ts: number; type: string; payload: string }>;
    return rows.reverse().map((r) => ({
      id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload),
    }));
  }

  /**
   * All events of ONE type for one agent at or after `cutoffTs`, ascending. The
   * time-windowed sibling of recentEventsByType (which takes a hard LIMIT, no
   * time bound) and the type-filtered sibling of eventsSince: the same-error-
   * repeat loop-breaker (#95, src/agent/agent.ts) needs every `action` event
   * inside a trailing window to count blocked (action, target) repeats. Sourced
   * from the events table -- not an in-memory counter -- so the count is
   * restart-safe: a doomed-action loop can span a restart (the #291 mission loop
   * ran 54h). Zero new persisted state -- same events table and the
   * idx_events_agent_ts index, a read shape over it exactly like countWakesSince.
   */
  eventsByTypeSince(agentId: string, type: string, cutoffTs: number): Array<AgentEvent & { id: number }> {
    const rows = this.db
      .query("SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? AND type = ? AND ts >= ? ORDER BY id ASC")
      .all(agentId, type, cutoffTs) as Array<{ id: number; agent_id: string; ts: number; type: string; payload: string }>;
    return rows.map((r) => ({
      id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload),
    }));
  }

  /**
   * The LATEST event of one type per distinct `payload[key]` value, most recent
   * first, capped at `limit` DISTINCT KEYS.
   *
   * The difference from recentEventsByType matters, and a live-shaped bug is
   * why this exists (PR #18 review). That method takes the most recent N EVENTS
   * globally, which is exactly right for a memory that writes one event per key
   * (poi_incompatible, mine_sparse_learned) and silently wrong for one that
   * writes several. The station memory (#517) emits per fact learned -- the
   * station, its name, each proven service -- so a busy system can spend a
   * dozen rows while a system docked at once spends one. Under a global row
   * window the quiet system is evicted FIRST, which is precisely backwards:
   * it is the rarely-revisited destination the pilot most needs reminding of.
   *
   * Grouping on the key makes that impossible rather than unlikely. Each key
   * contributes exactly one row (its newest, `HAVING id = MAX(id)`), so `limit`
   * bounds distinct keys and no amount of chatter about one key can push
   * another out of the window. Ascending by id, like recentEventsByType, so a
   * caller replaying into an insertion-ordered structure keeps oldest-first
   * eviction correct.
   *
   * Requires each payload to be a JSON object carrying `key`; rows where it is
   * absent or null are skipped, which is the same tolerance the callers' own
   * loaders apply. `key` is restricted to an identifier because it is
   * interpolated into the JSON path.
   */
  latestEventPerPayloadKey(
    agentId: string, type: string, key: string, limit: number,
  ): Array<AgentEvent & { id: number }> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid payload key: ${key}`);
    const rows = this.db
      .query(`SELECT id, agent_id, ts, type, payload FROM events
              WHERE agent_id = ? AND type = ? AND json_extract(payload, '$.${key}') IS NOT NULL
              GROUP BY json_extract(payload, '$.${key}')
              HAVING id = MAX(id)
              ORDER BY id DESC LIMIT ?`)
      .all(agentId, type, limit) as Array<{ id: number; agent_id: string; ts: number; type: string; payload: string }>;
    return rows.reverse().map((r) => ({
      id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload),
    }));
  }

  /**
   * The agent's dock trail: every `status_snapshot` and every `dock` action it
   * has recorded, ascending, projected down to the five fields the station
   * backfill reads (issue #525).
   *
   * WHY A RAW TRAIL AND NOT AN ANSWER. Where the ship WAS when a dock succeeded
   * is not stored on the dock row -- all 482 historical docks in the live store
   * carry `params: {}` -- so the system has to come from the nearest PRECEDING
   * status_snapshot, and joining a row to its nearest predecessor is what SQL
   * here is worst at. Two shapes were measured against the 98,920-event
   * production snapshot:
   *
   *   correlated subquery (one statement, the obvious form):  9,713 ms
   *   this projected trail + a linear walk in the caller:        37 ms
   *
   * 263x, and the reason is structural rather than tunable: idx_events_agent_ts
   * is on (agent_id, ts), so the per-dock "latest snapshot before id N" lookup
   * has no index to stand on and re-scans. Adding a covering index to make the
   * elegant query fast would be new persisted state (and a migration) to save
   * 37 ms once per process start. Projecting in SQL rather than returning
   * payloads is the other half of the win: the caller never parses the ~1 KB
   * `progress` block that rides on every snapshot.
   *
   * The projection is deliberately untyped past `string | null`: json_extract
   * returns whatever the payload held, and `result` in particular is game-
   * authored text whose shape is not a contract. Callers narrow it themselves.
   */
  dockTrail(agentId: string): DockTrailRow[] {
    return this.db
      .query(`SELECT type, ts,
                     json_extract(payload, '$.systemId') AS systemId,
                     json_extract(payload, '$.outcome')  AS outcome,
                     json_extract(payload, '$.result')   AS result
              FROM events
              WHERE agent_id = ?
                AND (type = 'status_snapshot'
                     OR (type = 'action' AND json_extract(payload, '$.action') = 'dock'))
              ORDER BY id ASC`)
      .all(agentId) as DockTrailRow[];
  }

  savePlan(agentId: string, plan: Plan, goals: string[]): void {
    this.db
      .query(`INSERT INTO plans (agent_id, plan, step, iteration, goals) VALUES (?, ?, 0, 0, ?)
              ON CONFLICT(agent_id) DO UPDATE SET plan = excluded.plan, step = 0, iteration = 0, goals = excluded.goals`)
      .run(agentId, JSON.stringify(plan), JSON.stringify(goals));
  }

  saveCursor(agentId: string, cursor: PlanCursor): void {
    this.db
      .query("UPDATE plans SET step = ?, iteration = ? WHERE agent_id = ?")
      .run(cursor.step, cursor.iteration, agentId);
  }

  loadPlan(agentId: string): { plan: Plan; cursor: PlanCursor; goals: string[] } | null {
    const row = this.db
      .query("SELECT plan, step, iteration, goals FROM plans WHERE agent_id = ?")
      .get(agentId) as { plan: string; step: number; iteration: number; goals: string } | null;
    if (!row) return null;
    let plan: Plan;
    let goals: string[];
    try {
      plan = PlanSchema.parse(JSON.parse(row.plan));
      goals = JSON.parse(row.goals) as string[];
    } catch (err) {
      // Persisted state outlives the schema that wrote it. A schema tightening
      // (e.g. the 2026-07-12 chat.target enum) can invalidate a plan stored by
      // an older build; parsing it would throw through the Agent constructor
      // and crash-loop the whole harness on boot. Per the AGENTS.md
      // "persisted-state schema tolerance" convention, discard the bad row
      // rather than crash: clear it so it can't re-crash next boot, and return
      // no-plan so the agent starts fresh and replans on its next natural wake.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[store] discarding invalid persisted plan for agent ${agentId}: ${reason}`);
      this.appendEvent({ agentId, ts: Date.now(), type: "plan_discarded", payload: { reason } });
      this.clearPlan(agentId);
      return null;
    }
    return {
      plan,
      cursor: { step: row.step, iteration: row.iteration },
      goals,
    };
  }

  clearPlan(agentId: string): void {
    this.db.query("DELETE FROM plans WHERE agent_id = ?").run(agentId);
  }

  pruneEvents(olderThanDays: number): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const res = this.db.query("DELETE FROM events WHERE ts < ?").run(cutoff);
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}
