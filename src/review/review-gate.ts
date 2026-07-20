import type { Database } from "bun:sqlite";

// The 6h strategy review (docs/charters/strategy-reviewer.md) fires on a timer
// regardless of whether the pilot actually did anything since the last run. On
// a parked or slow pilot that spends an LLM review pass to conclude "nothing
// changed" -- pure waste, and worse under a token ration. This gate is the
// deterministic precheck the charter runs first: it answers "has enough NEW
// work happened to be worth reviewing?" from data the harness already logs, so
// the decision costs one indexed COUNT and zero tokens.
//
// Signal: every planner run emits a `plan_context` event (src/agent/agent.ts).
// Counting those since the last review is the cheapest true measure of new
// pilot activity -- more plans means more decisions and more trend to read.
// The cursor is a `strategy_review` marker event written at the END of a run
// (markReviewRan), so skipped runs let work ACCUMULATE toward the threshold
// rather than resetting the window -- "enough work has been done since we last
// looked", robust to an irregular review schedule.
export const REVIEW_MIN_NEW_PLANS = 6;

const MARKER_TYPE = "strategy_review";
const PLAN_TYPE = "plan_context";

export interface ReviewGate {
  run: boolean;
  newPlans: number;
  lastReviewTs: number; // epoch ms; 0 if never reviewed (counts all history)
  threshold: number;
}

/**
 * Decide whether the strategy review is worth running for `agentId`. Pure read:
 * MAX(ts) of the last review marker, then COUNT(plan_context) strictly after it.
 * Runs only when new plans reach the threshold.
 */
export function evaluateReviewGate(
  db: Database,
  agentId: string,
  threshold: number = REVIEW_MIN_NEW_PLANS,
): ReviewGate {
  const marker = db
    .query("SELECT MAX(ts) AS ts FROM events WHERE agent_id = ? AND type = ?")
    .get(agentId, MARKER_TYPE) as { ts: number | null };
  const lastReviewTs = marker.ts ?? 0;
  const row = db
    .query("SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND type = ? AND ts > ?")
    .get(agentId, PLAN_TYPE, lastReviewTs) as { n: number };
  return { run: row.n >= threshold, newPlans: row.n, lastReviewTs, threshold };
}

/**
 * Record that a review ran so the next gate counts only plans after `ts`. Called
 * AFTER a successful review (not at the gate) so a crashed review doesn't advance
 * the cursor past a window it never analyzed. Requires a writable handle.
 */
export function markReviewRan(db: Database, agentId: string, ts: number): void {
  db.query("INSERT INTO events (agent_id, ts, type, payload) VALUES (?, ?, ?, ?)")
    .run(agentId, ts, MARKER_TYPE, JSON.stringify({ marker: "strategy_review_ran" }));
}
