import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { evaluateReviewGate, markReviewRan, REVIEW_MIN_NEW_PLANS } from "../src/review/review-gate";

// Minimal stand-in for the real events table (src/store/store.ts). The gate
// reads only (agent_id, ts, type), so that is all we seed.
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT);`);
  return db;
}

function seed(db: Database, agentId: string, type: string, count: number, baseTs: number): void {
  for (let i = 0; i < count; i++) {
    db.query("INSERT INTO events (agent_id, ts, type, payload) VALUES (?, ?, ?, '{}')")
      .run(agentId, baseTs + i, type);
  }
}

test("no marker + no plans: skip, counts zero", () => {
  const db = freshDb();
  const g = evaluateReviewGate(db, "miner");
  expect(g.run).toBe(false);
  expect(g.newPlans).toBe(0);
  expect(g.lastReviewTs).toBe(0);
});

test("below threshold: skip", () => {
  const db = freshDb();
  seed(db, "miner", "plan_context", REVIEW_MIN_NEW_PLANS - 1, 1000);
  expect(evaluateReviewGate(db, "miner").run).toBe(false);
});

test("exactly at threshold: run (boundary)", () => {
  const db = freshDb();
  seed(db, "miner", "plan_context", REVIEW_MIN_NEW_PLANS, 1000);
  const g = evaluateReviewGate(db, "miner");
  expect(g.newPlans).toBe(REVIEW_MIN_NEW_PLANS);
  expect(g.run).toBe(true);
});

test("only plans AFTER the last marker count", () => {
  const db = freshDb();
  seed(db, "miner", "plan_context", 100, 1000); // old plans, ts 1000..1099
  markReviewRan(db, "miner", 5000); // review ran at ts 5000
  // Only a handful of new plans after the marker -> not enough yet.
  seed(db, "miner", "plan_context", REVIEW_MIN_NEW_PLANS - 1, 6000);
  const g = evaluateReviewGate(db, "miner");
  expect(g.lastReviewTs).toBe(5000);
  expect(g.newPlans).toBe(REVIEW_MIN_NEW_PLANS - 1);
  expect(g.run).toBe(false);
});

test("a plan at exactly the marker ts is excluded (strict boundary)", () => {
  // Locks `ts > lastReviewTs` against a silent flip to `>=`: a plan_context
  // stamped at the SAME ms as the marker belongs to the reviewed window, not
  // the new one, so it must NOT count toward the next run.
  const db = freshDb();
  markReviewRan(db, "miner", 5000);
  // All plans stamped at exactly the marker ts (seed() would spread them by +i).
  for (let i = 0; i < REVIEW_MIN_NEW_PLANS; i++) {
    db.query("INSERT INTO events (agent_id, ts, type, payload) VALUES ('miner', 5000, 'plan_context', '{}')").run();
  }
  const g = evaluateReviewGate(db, "miner");
  expect(g.lastReviewTs).toBe(5000);
  expect(g.newPlans).toBe(0);
  expect(g.run).toBe(false);
});

test("work accumulates across a skipped run (marker only advances on run)", () => {
  const db = freshDb();
  markReviewRan(db, "miner", 5000);
  seed(db, "miner", "plan_context", REVIEW_MIN_NEW_PLANS, 6000); // enough new plans
  // No new marker written (previous run skipped) -> these still count and trip the gate.
  expect(evaluateReviewGate(db, "miner").run).toBe(true);
});

test("newest marker wins when several exist", () => {
  const db = freshDb();
  markReviewRan(db, "miner", 1000);
  markReviewRan(db, "miner", 9000);
  seed(db, "miner", "plan_context", REVIEW_MIN_NEW_PLANS, 2000); // between the two markers
  const g = evaluateReviewGate(db, "miner");
  expect(g.lastReviewTs).toBe(9000);
  expect(g.newPlans).toBe(0); // all plans predate the latest marker
  expect(g.run).toBe(false);
});

test("another agent's plans do not count", () => {
  const db = freshDb();
  seed(db, "other", "plan_context", REVIEW_MIN_NEW_PLANS * 2, 1000);
  seed(db, "miner", "plan_context", 1, 1000);
  expect(evaluateReviewGate(db, "miner").newPlans).toBe(1);
});

test("non-plan events do not count as work", () => {
  const db = freshDb();
  seed(db, "miner", "wake", REVIEW_MIN_NEW_PLANS * 3, 1000);
  seed(db, "miner", "ledger", REVIEW_MIN_NEW_PLANS * 3, 2000);
  expect(evaluateReviewGate(db, "miner").run).toBe(false);
});

test("custom threshold is honored", () => {
  const db = freshDb();
  seed(db, "miner", "plan_context", 3, 1000);
  expect(evaluateReviewGate(db, "miner", 3).run).toBe(true);
  expect(evaluateReviewGate(db, "miner", 4).run).toBe(false);
});
