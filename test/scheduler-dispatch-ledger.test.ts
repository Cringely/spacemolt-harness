// Stage 3 (#114): the dispatch ledger + orphan sweep. Offline — temp dirs,
// injected clock, no live spawns. Each test pins a distinct failure mode:
// schema tolerance on a predating/corrupt ledger, the write API's in-flight
// matching, and the sweep's D2 dead-vs-quiet classification + hard-deadline
// reap.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CostBucket,
  type DispatchEntry,
  HARD_DEADLINE_FLOOR_MS,
  LEDGER_FILE,
  dispatchesInWindow,
  inFlight,
  ledgerTotals,
  loadLedger,
  recordDispatch,
  recordHeartbeat,
  recordOutcome,
  saveLedger,
  sweepLedger,
} from "../src/scheduler/dispatch-ledger";
import type { JobId } from "../src/scheduler/state";

const MIN = 60_000;
const tmp = () => mkdtempSync(join(tmpdir(), "sched-ledger-"));
const NOW = Date.UTC(2026, 6, 18, 12, 0);

function entry(over: Partial<DispatchEntry> = {}): DispatchEntry {
  return {
    dispatchId: "d1",
    jobId: "strategy" as JobId,
    issueRef: "#500",
    defectClass: "flaky-test",
    spawnedAt: NOW - 10 * MIN,
    expectedDurationMs: 20 * MIN,
    costBucket: "medium" as CostBucket,
    lastHeartbeatAt: null,
    pokeCount: 0,
    outcome: null,
    completedAt: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    ...over,
  };
}

describe("dispatch ledger (stage 3)", () => {
  // Catches: a half-written ledger bricking the sweep (chat-enum crash class).
  test("truncated/corrupt ledger loads as [] with no throw", () => {
    const dir = tmp();
    writeFileSync(join(dir, LEDGER_FILE), '[{"dispatchId":"d1","spawnedAt":17');
    expect(loadLedger(dir)).toEqual([]);
  });

  test("missing ledger (fresh install) loads as []", () => {
    expect(loadLedger(tmp())).toEqual([]);
  });

  // Catches: a stored ledger that PREDATES the schema crashing the loader — an
  // entry lacking the stable id (or a corrupt jobId) is dropped WHOLE, the
  // healthy entries survive (binding AGENTS.md persisted-state rule).
  test("predating/invalid entries are skipped; valid entries survive", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, LEDGER_FILE),
      JSON.stringify([
        { spawnedAt: NOW, jobId: "strategy", outcome: null }, // no dispatchId → dropped
        { dispatchId: "bad-job", jobId: "not-a-job", spawnedAt: NOW }, // unknown jobId → dropped
        entry({ dispatchId: "good", outcome: "ok" }), // healthy → kept
      ]),
    );
    const loaded = loadLedger(dir);
    expect(loaded.map((e) => e.dispatchId)).toEqual(["good"]);
  });

  // Catches: a single bad FIELD nuking an otherwise usable entry — it should
  // degrade to the field default, keeping the entry (mirrors AnchorSchema).
  test("a corrupt field degrades to its default, entry kept", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, LEDGER_FILE),
      JSON.stringify([entry({ dispatchId: "d1", costBucket: "gigantic" as CostBucket, pokeCount: -5 })]),
    );
    const [e] = loadLedger(dir);
    expect(e?.dispatchId).toBe("d1");
    expect(e?.costBucket).toBe("medium"); // invalid bucket → default
    expect(e?.pokeCount).toBe(0); // negative → default
  });

  // Catches: recordOutcome closing the wrong (or an already-closed) entry, and
  // dropping the actual spend a clean completion carries.
  test("write API: append, heartbeat, and outcome+spend only touch the live match", () => {
    const dir = tmp();
    recordDispatch(dir, entry({ dispatchId: "a" }));
    recordDispatch(dir, entry({ dispatchId: "b" }));
    expect(recordHeartbeat(dir, "a", NOW)).toBe(true);
    expect(recordOutcome(dir, "a", "ok", NOW, { costUsd: 0.42, inputTokens: 100, outputTokens: 50 })).toBe(true);
    expect(recordOutcome(dir, "a", "fail", NOW)).toBe(false); // already closed → no re-close
    expect(recordOutcome(dir, "nope", "ok", NOW)).toBe(false); // unknown id
    const loaded = loadLedger(dir);
    const a = loaded.find((e) => e.dispatchId === "a");
    expect(a?.outcome).toBe("ok");
    expect(a?.lastHeartbeatAt).toBe(NOW);
    expect(a?.costUsd).toBe(0.42); // actual spend carried onto the row
    expect(a?.outputTokens).toBe(50);
    expect(inFlight(loaded).map((e) => e.dispatchId)).toEqual(["b"]);
  });

  // Catches: a ledger written BEFORE cost tracking failing to load (the exact
  // predating-artifact class the persisted-state rule protects) — the cost
  // fields must default to null, the entry must survive.
  test("a pre-cost-tracking entry (no cost fields) loads with null spend", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, LEDGER_FILE),
      JSON.stringify([
        {
          dispatchId: "old",
          jobId: "strategy",
          spawnedAt: NOW,
          expectedDurationMs: 1000,
          pokeCount: 0,
          outcome: "ok",
        },
      ]),
    );
    const [e] = loadLedger(dir);
    expect(e?.dispatchId).toBe("old");
    expect(e?.costUsd).toBe(null);
    expect(e?.inputTokens).toBe(null);
  });

  // Catches finding #2 (PR #407): a corrupt terminal outcome must NOT default to
  // null (in-flight). null would resurrect a closed entry into the concurrency
  // count and the sweep, which then reaps it as a false "orphaned" failure fed
  // to the breaker. It degrades to a terminal classification instead. An
  // explicit null (a genuinely in-flight entry) still parses and stays null.
  test("a corrupt outcome degrades to a terminal, never resurrects as in-flight", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, LEDGER_FILE),
      JSON.stringify([{ ...entry({ dispatchId: "corrupt" }), outcome: "DONE_TYPO", completedAt: NOW }]),
    );
    const [e] = loadLedger(dir);
    expect(e?.dispatchId).toBe("corrupt"); // single bad field degrades, entry kept
    expect(e?.outcome).toBe("orphaned"); // terminal, NOT null/in-flight
    expect(inFlight([e!])).toEqual([]); // not counted against the concurrency cap
    expect(sweepLedger([e!], NOW).items).toEqual([]); // a closed entry is not swept
    // An explicit in-flight null still parses through the loader (nullable) —
    // only an UNREADABLE value fails closed, so genuine in-flight is preserved.
    const live = tmp();
    saveLedger(live, [entry({ dispatchId: "live", outcome: null })]);
    expect(loadLedger(live)[0]?.outcome).toBe(null);
  });

  test("save→load round-trip is byte-stable", () => {
    const dir = tmp();
    saveLedger(dir, [entry({ dispatchId: "x" })]);
    const first = loadLedger(dir);
    saveLedger(dir, first);
    expect(loadLedger(dir)).toEqual(first);
  });

  // Catches: the D2 dead-vs-quiet miscall — the whole reason stage 3 exists.
  // A recently-beating agent is active; a silent-but-in-window agent is quiet
  // (presumed working, NOT killed); only past its window is it stale.
  test("sweep classifies active / quiet / stale by heartbeat and window (D2)", () => {
    const entries = [
      entry({ dispatchId: "active", lastHeartbeatAt: NOW - 1 * MIN, spawnedAt: NOW - 3 * MIN }),
      entry({ dispatchId: "quiet", lastHeartbeatAt: NOW - 8 * MIN, spawnedAt: NOW - 12 * MIN }), // age 12 < 20+10
      entry({ dispatchId: "stale", lastHeartbeatAt: NOW - 8 * MIN, spawnedAt: NOW - 40 * MIN }), // age 40 > 30, < 70
    ];
    const s = sweepLedger(entries, NOW);
    expect([s.active, s.quiet, s.stale]).toEqual([1, 1, 1]);
    expect(s.reaped).toEqual([]);
    const byId = Object.fromEntries(s.items.map((i) => [i.dispatchId, i]));
    expect(byId["active"]?.klass).toBe("active");
    expect(byId["quiet"]?.klass).toBe("quiet");
    expect(byId["stale"]?.klass).toBe("stale");
  });

  // Catches: the poke-first ladder skipping a rung (killing before poking) —
  // the incident that destroyed working agents (D2: poke, re-poke, then kill).
  test("stale poke ladder advances poke → repoke → kill by pokeCount", () => {
    const mk = (pokeCount: number) =>
      sweepLedger([entry({ dispatchId: "s", spawnedAt: NOW - 40 * MIN, lastHeartbeatAt: NOW - 8 * MIN, pokeCount })], NOW)
        .items[0]?.action;
    expect(mk(0)).toBe("poke");
    expect(mk(1)).toBe("repoke");
    expect(mk(2)).toBe("kill");
    expect(mk(9)).toBe("kill");
  });

  // Catches: a crash-orphaned dispatch (never wrote its outcome) stuck
  // in-flight forever, blocking the concurrency cap. Past the absolute
  // deadline the sweep reaps it regardless of heartbeat.
  test("sweep reaps entries past the absolute hard deadline", () => {
    const past = NOW - (20 * MIN * 2 + HARD_DEADLINE_FLOOR_MS + MIN); // > 2x expected + floor
    const s = sweepLedger([entry({ dispatchId: "orphan", spawnedAt: past, lastHeartbeatAt: NOW - MIN })], NOW);
    expect(s.reaped).toEqual(["orphan"]); // reaped even with a "recent" beat — deadline wins
    expect(s.stale + s.quiet + s.active).toBe(0);
  });

  test("totals + window + cost rollup for --health", () => {
    const entries = [
      entry({ dispatchId: "a", outcome: "ok", spawnedAt: NOW - 2 * 3_600_000, costUsd: 0.5 }),
      entry({ dispatchId: "b", outcome: "fail", spawnedAt: NOW - 26 * 3_600_000, costUsd: 0.25 }), // outside 24h
      entry({ dispatchId: "c", outcome: null, spawnedAt: NOW - MIN, costUsd: null }), // null cost skipped
    ];
    const t = ledgerTotals(entries, NOW);
    expect(t).toMatchObject({ total: 3, inFlight: 1, last24h: 2, ok: 1, fail: 1, orphaned: 0 });
    expect(t.costUsd).toBeCloseTo(0.75); // sum across all rows, null skipped
    expect(t.costLast24h).toBeCloseTo(0.5); // only the in-window row's cost
    expect(dispatchesInWindow(entries, 24 * 3_600_000, NOW)).toBe(2);
  });
});
