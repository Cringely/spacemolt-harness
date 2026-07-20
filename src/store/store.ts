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
