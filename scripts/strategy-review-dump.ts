// Read-only review dataset for the 6h strategy review
// (docs/charters/strategy-reviewer.md). ONE fixed output shape the reviewer
// consumes locally, so no arbitrary SQL or script crosses the trust boundary.
//
// Two datasets, both derived from the existing events table:
//   1. Method §1 (trend the vitals): the `progress_heartbeat` series inside the
//      review window -- each carries its progressing/stalled verdict, per-
//      dimension deltas, and a position snapshot (src/agent/agent.ts emit).
//   2. Method §2 (failure-mining, #158): the DETERMINISTIC failure taxonomy,
//      reusing src/server/failures.ts VERBATIM (SSOT -- the dashboard's
//      /failures endpoint calls the same function). Lifetime `action` events go
//      in; the window is applied inside the aggregation, exactly as server.ts
//      does, because newness and lifetime failure rates are unanswerable from a
//      window alone (the 86/86 buy history predates any window).
//
// Remote use (#114 A1 pivot, 2026-07-19): the scheduler host no longer SSHes
// anywhere for this. `readDump` below is called directly, in-process, by the
// authenticated GET /api/store/:agentId/dump route (src/server/server.ts),
// which scripts/strategy-store.ts reaches over HTTP with a bearer token. The
// `import.meta.main` CLI entry at the bottom of this file still works for
// local/manual runs against a store file, but is no longer the remote path --
// the old SSH forced-command dispatcher (sm-store-dispatch.sh) is deleted.
// The store is opened READONLY (the `Store` class constructor writes -- PRAGMA
// + CREATE TABLE -- so it cannot open the persisted volume read-only; the gate
// script sets the same precedent). An absent/unreadable store exits 2 LOUDLY:
// an empty store looks exactly like a healthy quiet pilot (L-21), never a skip.
import { Database } from "bun:sqlite";
import { failureTaxonomy, type FailureTaxonomy } from "../src/server/failures";
import type { AgentEvent } from "../src/store/store";

// Trend window for BOTH datasets. Charter Method §1 trends "over 48-72h"; 72h
// is the upper bound and the default here. Overridable via REVIEW_WINDOW_HOURS
// for an ad-hoc wider/narrower pull without a code change.
export const REVIEW_WINDOW_HOURS = 72;

export interface HeartbeatPoint {
  ts: number;
  windowMinutes: number | null;
  progressing: boolean;
  stalled: boolean;
  deltas: Record<string, number>;
  position: Record<string, unknown>;
}

export interface StrategyReviewDump {
  agentId: string;
  generatedAt: number; // epoch ms this dataset was assembled
  windowHours: number;
  heartbeats: HeartbeatPoint[]; // progress_heartbeat inside the window, ascending
  failures: FailureTaxonomy; // deterministic taxonomy (window applied inside)
}

type Row = { id: number; agent_id: string; ts: number; type: string; payload: string };

// Rows -> the event shape the pure aggregation functions expect. Payload is
// parsed defensively: a row written by an older/foreign schema is kept as-is
// (its unknown payload skipped downstream), never a crash -- persisted state
// outlives the schema that wrote it (AGENTS.md persisted-state tolerance).
function rowsToEvents(rows: Row[]): Array<AgentEvent & { id: number }> {
  return rows.map((r) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = null;
    }
    return { id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload };
  });
}

// One progress_heartbeat event -> one trend point. Every field read defensively
// so an old-shape heartbeat degrades to a benign point rather than throwing.
function toHeartbeatPoint(e: AgentEvent & { id: number }): HeartbeatPoint {
  const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
  return {
    ts: e.ts,
    windowMinutes: typeof p.windowMinutes === "number" ? p.windowMinutes : null,
    progressing: p.progressing === true,
    stalled: p.stalled === true,
    deltas: p.deltas && typeof p.deltas === "object" ? (p.deltas as Record<string, number>) : {},
    position: p.position && typeof p.position === "object" ? (p.position as Record<string, unknown>) : {},
  };
}

/**
 * Assemble the fixed dump dataset from a readable DB handle. Pure over the DB:
 * two indexed reads (idx_events_agent_ts), no writes -- safe on a readonly
 * handle. The two SELECTs mirror Store.eventsByTypeSince; the Store methods are
 * not reused directly because that class's constructor writes to the file. The
 * real aggregation LOGIC (failureTaxonomy) is imported, not duplicated.
 */
export function readDump(
  db: Database,
  agentId: string,
  now: number,
  windowHours: number = REVIEW_WINDOW_HOURS,
): StrategyReviewDump {
  // Method §2: lifetime `action` events; the window is applied inside
  // failureTaxonomy (same call shape as src/server/server.ts /failures).
  const actionRows = db
    .query("SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? AND type = 'action' ORDER BY id ASC")
    .all(agentId) as Row[];
  const failures = failureTaxonomy(agentId, rowsToEvents(actionRows), now, windowHours);

  // Method §1: progress_heartbeat inside the window only -- the trend, not the
  // lifetime series (a multi-day heartbeat history would bloat the payload the
  // reviewer reads).
  const cutoff = now - windowHours * 60 * 60 * 1000;
  const hbRows = db
    .query(
      "SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? AND type = 'progress_heartbeat' AND ts >= ? ORDER BY id ASC",
    )
    .all(agentId, cutoff) as Row[];
  const heartbeats = rowsToEvents(hbRows).map(toHeartbeatPoint);

  return { agentId, generatedAt: now, windowHours, heartbeats, failures };
}

// CLI entry -- guarded so importing this module in a test never opens the prod
// store. Mirrors the gate/mark scripts' argv + HARNESS_DB env contract.
if (import.meta.main) {
  const agentId = process.argv[2] ?? "miner";
  const path = process.env.HARNESS_DB ?? "/app/data/harness.sqlite";
  const windowHours = Number(process.env.REVIEW_WINDOW_HOURS) || REVIEW_WINDOW_HOURS;
  try {
    const db = new Database(path, { readonly: true });
    console.log(JSON.stringify(readDump(db, agentId, Date.now(), windowHours)));
  } catch (e) {
    console.error(
      JSON.stringify({ error: "store_unreadable", path, message: e instanceof Error ? e.message : String(e) }),
    );
    process.exit(2);
  }
}
