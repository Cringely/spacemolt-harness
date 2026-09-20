// Offline shape test for the read-only review dataset (scripts/strategy-review-dump.ts,
// #114 A1). Seeds an in-memory events table matching src/store/store.ts and drives
// readDump directly: zero live calls, zero tokens, no /app/data store.
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readDump, REVIEW_WINDOW_HOURS } from "../scripts/strategy-review-dump";
import { clipUntrusted, UNTRUSTED_TEXT_SNIPPET_LEN } from "../src/planner/digest";

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

  // #1053: a class row's `sample` is the full raw game result text
  // (src/server/failures.ts's tally() keeps it whole), and this dump is read
  // directly as an LLM's input -- so the copy that reaches the reviewer must
  // be bound the same way digest.ts bounds every other untrusted game-text
  // seam, without the aggregation itself (failures.ts) losing any fidelity
  // for its OTHER consumer (the dashboard tooltip, which wants the full text).
  describe("class-row `sample` is bound before it reaches the LLM-facing dump (#1053)", () => {
    test("a sample past the bound is clipped in the dump, matching clipUntrusted exactly", () => {
      const db = freshDb();
      const now = 1_000_000_000; // big enough that `now - HOUR` stays positive (#1053 test self-bug: 2_000_000 underflowed lastSeenTs=0)
      // Well past UNTRUSTED_TEXT_SNIPPET_LEN (200) so the clip is exercised for
      // real, not just past some arbitrary shorter number.
      const longResult = `insufficient_storage: Storage only has 0 x ${"nickel_ore".repeat(30)}.`;
      expect(longResult.length).toBeGreaterThan(UNTRUSTED_TEXT_SNIPPET_LEN);
      insert(db, "miner", now - HOUR, "action", { action: "withdraw", outcome: "blocked", result: longResult });

      const dump = readDump(db, "miner", now, REVIEW_WINDOW_HOURS);
      const row = dump.failures.classes.find((c) => c.class === "insufficient_storage");
      expect(row).toBeDefined();
      // Exact match against the real producer of the bound, not just "shorter
      // than the input" -- a matcher that only checked length would pass on a
      // clip to any length, including one that cuts mid-word differently from
      // what digest.ts's own quoting actually shows the planner elsewhere.
      expect(row!.sample).toBe(clipUntrusted(longResult));
      expect(row!.sample.length).toBe(UNTRUSTED_TEXT_SNIPPET_LEN + 1); // +1 for the ellipsis
    });

    test("prevented rows (guard blocks) get the same bound as game-refusal rows", () => {
      const db = freshDb();
      const now = 1_000_000_000; // big enough that `now - HOUR` stays positive (#1053 test self-bug: 2_000_000 underflowed lastSeenTs=0)
      const longGuardText = `deposit gift refused: ${"x".repeat(220)}`;
      insert(db, "miner", now - HOUR, "action", {
        action: "deposit", outcome: "blocked", guard: true, result: longGuardText,
      });

      const dump = readDump(db, "miner", now, REVIEW_WINDOW_HOURS);
      expect(dump.failures.prevented).toHaveLength(1);
      expect(dump.failures.prevented[0]!.sample).toBe(clipUntrusted(longGuardText));
      expect(dump.failures.prevented[0]!.sample.length).toBeLessThan(longGuardText.length);
    });

    test("a sample already under the bound reaches the dump byte-for-byte (no over-truncation)", () => {
      const db = freshDb();
      const now = 1_000_000_000; // big enough that `now - HOUR` stays positive (#1053 test self-bug: 2_000_000 underflowed lastSeenTs=0)
      const shortResult = "not_docked: You must be docked at a station to perform this action.";
      insert(db, "miner", now - HOUR, "action", { action: "sell", outcome: "blocked", result: shortResult });

      const dump = readDump(db, "miner", now, REVIEW_WINDOW_HOURS);
      const row = dump.failures.classes.find((c) => c.class === "not_docked");
      expect(row!.sample).toBe(shortResult); // byte-for-byte, no ellipsis appended
    });
  });
});
