// Offline shape test for the read-only review dataset (scripts/strategy-review-dump.ts,
// #114 A1). Seeds an in-memory events table matching src/store/store.ts and drives
// readDump directly: zero live calls, zero tokens, no /app/data store.
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readDump, REVIEW_WINDOW_HOURS } from "../scripts/strategy-review-dump";

const HOUR = 60 * 60 * 1000;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT);`);
  return db;
}

function insert(db: Database, agentId: string, ts: number, type: string, payload: unknown): void {
  db.query("INSERT INTO events (agent_id, ts, type, payload) VALUES (?, ?, ?, ?)")
    .run(agentId, ts, type, JSON.stringify(payload));
}

describe("readDump — fixed review dataset", () => {
  test("assembles heartbeat trend + failure taxonomy in one shape", () => {
    const db = freshDb();
    const now = 1_000_000_000;

    // Two in-window heartbeats + one older than the window (must be excluded).
    insert(db, "miner", now - 10 * HOUR, "progress_heartbeat", {
      windowMinutes: 30, progressing: true, stalled: false,
      deltas: { credits: 120 }, position: { credits: 500, cargoUsed: 2, systemId: "sys-1" },
    });
    insert(db, "miner", now - 2 * HOUR, "progress_heartbeat", {
      windowMinutes: 30, progressing: false, stalled: true,
      deltas: {}, position: { credits: 500, cargoUsed: 0, systemId: "sys-1" },
    });
    insert(db, "miner", now - 200 * HOUR, "progress_heartbeat", {
      windowMinutes: 30, progressing: true, stalled: false, deltas: { credits: 1 }, position: {},
    });

    // A broken capability: buy blocked 5x lifetime (attempts>=5, rate 1.0).
    // Inside the 72h window so it also shows in the window class-frequency table.
    for (let i = 0; i < 5; i++) {
      insert(db, "miner", now - (20 - i) * HOUR, "action", {
        action: "buy", outcome: "blocked", result: "no_credits: You cannot afford that.",
      });
    }
    // A successful action so the denominator has variety (not itself broken).
    insert(db, "miner", now - 1 * HOUR, "action", { action: "mine", outcome: "continue" });
    // Another agent's data must not leak in.
    insert(db, "other", now - 1 * HOUR, "action", { action: "buy", outcome: "blocked", result: "x" });

    const dump = readDump(db, "miner", now, REVIEW_WINDOW_HOURS);

    // Top-level shape.
    expect(dump.agentId).toBe("miner");
    expect(dump.generatedAt).toBe(now);
    expect(dump.windowHours).toBe(REVIEW_WINDOW_HOURS);

    // §1: only the two in-window heartbeats, ascending, with trend fields.
    expect(dump.heartbeats).toHaveLength(2);
    expect(dump.heartbeats[0]!.ts).toBeLessThan(dump.heartbeats[1]!.ts);
    expect(dump.heartbeats[0]).toMatchObject({
      progressing: true, stalled: false, windowMinutes: 30,
      deltas: { credits: 120 }, position: { credits: 500, systemId: "sys-1" },
    });
    expect(dump.heartbeats[1]!.stalled).toBe(true);

    // §2: deterministic taxonomy for THIS agent only.
    expect(dump.failures.agentId).toBe("miner");
    const broken = dump.failures.brokenCapabilities.find((b) => b.action === "buy");
    expect(broken).toBeDefined();
    expect(broken!.attempts).toBe(5);
    expect(broken!.failureRate).toBe(1);
    // Window class frequency present for the blocked buys inside the window.
    expect(dump.failures.classes.some((c) => c.class === "no_credits")).toBe(true);
  });

  test("empty store yields empty datasets, never a throw", () => {
    const db = freshDb();
    const dump = readDump(db, "ghost", 1_000, REVIEW_WINDOW_HOURS);
    expect(dump.heartbeats).toEqual([]);
    expect(dump.failures.classes).toEqual([]);
    expect(dump.failures.brokenCapabilities).toEqual([]);
  });

  test("a malformed payload row is tolerated, not fatal (persisted-state tolerance)", () => {
    const db = freshDb();
    const now = 1_000_000;
    // Raw insert with non-JSON payload — an old/foreign write shape.
    db.query("INSERT INTO events (agent_id, ts, type, payload) VALUES ('miner', ?, 'progress_heartbeat', 'not-json')")
      .run(now - HOUR);
    const dump = readDump(db, "miner", now, REVIEW_WINDOW_HOURS);
    // The row is kept but its fields degrade to the safe defaults.
    expect(dump.heartbeats).toHaveLength(1);
    expect(dump.heartbeats[0]!.progressing).toBe(false);
    expect(dump.heartbeats[0]!.deltas).toEqual({});
  });
});
