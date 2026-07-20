// Stage 3 (#114): the dispatch circuit breaker. Offline — temp dirs, injected
// clock. Distinct failure modes: schema tolerance, the fail-streak and per-day
// caps that latch OPEN, the never-auto-reset property, and the evaluateDispatch
// permit order (gate → quota floor → windowed caps).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BREAKER_CONFIG_FILE,
  BREAKER_FILE,
  type BreakerState,
  DEFAULT_BREAKER_CONFIG,
  defaultBreaker,
  evaluateDispatch,
  loadBreakerConfig,
  loadBreakers,
  manualReset,
  recordDispatchResult,
  saveBreakers,
  tripOpen,
} from "../src/scheduler/breaker";
import { JOB_IDS } from "../src/scheduler/state";

const tmp = () => mkdtempSync(join(tmpdir(), "sched-breaker-"));
const NOW = Date.UTC(2026, 6, 18, 12, 0);
const cfg = DEFAULT_BREAKER_CONFIG;

function ctx(over: Partial<Parameters<typeof evaluateDispatch>[0]> = {}) {
  return {
    gateOn: true,
    breaker: defaultBreaker(),
    inFlightCount: 0,
    dispatchesThisTick: 0,
    dispatchesLast24h: 0,
    quotaFraction: 1 as number | null,
    cfg,
    now: NOW,
    ...over,
  };
}

describe("dispatch breaker (stage 3)", () => {
  // Catches: a corrupt breaker.json bricking dispatch accounting; and a file
  // predating failStreak resetting the WHOLE job (which would silently un-latch
  // an open breaker — the one thing a never-auto-reset breaker must not do).
  test("corrupt/predating breaker.json degrades per-field, keeps a latched status", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, BREAKER_FILE),
      JSON.stringify({ strategy: { status: "open", openedAt: 1000, reason: "fail-streak" } }), // no failStreak
    );
    const b = loadBreakers(dir);
    expect(b.strategy.status).toBe("open"); // latch survives the predating load
    expect(b.strategy.failStreak).toBe(0); // missing field → default, entry kept
    for (const id of JOB_IDS) if (id !== "strategy") expect(b[id]).toEqual(defaultBreaker());
  });

  // Catches finding #1 (PR #407): a breaker.json whose `status` field ALONE is
  // corrupt must fail toward OPEN, never silently un-latch. The latch evidence
  // (openedAt/reason/failStreak) survives, the status stays "open", and
  // evaluateDispatch keeps denying — the never-auto-reset invariant. Before the
  // fix this loaded as "closed" and dispatch re-opened.
  test("a corrupt status with latch evidence loads OPEN; dispatch stays blocked", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, BREAKER_FILE),
      JSON.stringify({ strategy: { status: "OPEN_TYPO", openedAt: 12345, reason: "per-day-cap", failStreak: 5 } }),
    );
    const b = loadBreakers(dir);
    expect(b.strategy.status).toBe("open"); // unknown status → fail-safe OPEN, never un-latch
    expect(b.strategy.openedAt).toBe(12345); // latch evidence survives intact
    expect(b.strategy.reason).toBe("per-day-cap");
    expect(b.strategy.failStreak).toBe(5);
    // The reloaded breaker keeps denying — the status --health surfaces is open.
    expect(evaluateDispatch(ctx({ breaker: b.strategy }))).toMatchObject({
      permit: false,
      reason: "breaker-open",
    });
  });

  test("missing breaker.json loads all-closed defaults", () => {
    const b = loadBreakers(tmp());
    for (const id of JOB_IDS) expect(b[id]).toEqual(defaultBreaker());
  });

  // Catches: a broken dispatch class dispatching forever (L-3) — the streak
  // must latch OPEN on the Nth consecutive failure, and a clean run resets it.
  test("recordDispatchResult latches OPEN on the fail-streak trip; ok resets", () => {
    let s = defaultBreaker();
    s = recordDispatchResult(s, "fail", cfg, NOW);
    s = recordDispatchResult(s, "orphaned", cfg, NOW);
    expect(s.status).toBe("closed"); // 2 < trip(3)
    expect(s.failStreak).toBe(2);
    s = recordDispatchResult(s, "killed", cfg, NOW); // 3rd consecutive
    expect(s.status).toBe("open");
    expect(s.reason).toBe("fail-streak");
    // A clean outcome after latching still zeroes the streak, but the latch
    // itself only clears via manualReset (tested below).
    expect(recordDispatchResult(defaultBreaker(), "ok", cfg, NOW).failStreak).toBe(0);
  });

  test("tripOpen is idempotent — a re-trip keeps the first reason and time", () => {
    const first = tripOpen(defaultBreaker(), "per-day-cap", 1000);
    const second = tripOpen(first, "fail-streak", 2000);
    expect(second).toBe(first); // same object, unchanged
    expect(second.reason).toBe("per-day-cap");
    expect(second.openedAt).toBe(1000);
  });

  // Catches: an auto-reset — the breaker must NEVER close on its own; only the
  // explicit operator reset returns it to closed. Persisting an OPEN breaker
  // and reloading must keep it OPEN.
  test("an OPEN breaker survives save/load; only manualReset closes it", () => {
    const dir = tmp();
    const breakers = loadBreakers(dir);
    breakers.strategy = tripOpen(defaultBreaker(), "per-day-cap", NOW);
    saveBreakers(dir, breakers);
    expect(loadBreakers(dir).strategy.status).toBe("open"); // no auto-reset across a reload
    const reset = manualReset(loadBreakers(dir).strategy, NOW);
    expect(reset).toEqual(defaultBreaker());
  });

  test("config: defaults when missing, per-field degrade, valid override honored", () => {
    expect(loadBreakerConfig(tmp())).toEqual(DEFAULT_BREAKER_CONFIG);
    const dir = tmp();
    writeFileSync(join(dir, BREAKER_CONFIG_FILE), JSON.stringify({ perDayCap: 5, quotaReserveFloor: 2 }));
    const c = loadBreakerConfig(dir);
    expect(c.perDayCap).toBe(5); // override honored
    expect(c.quotaReserveFloor).toBe(DEFAULT_BREAKER_CONFIG.quotaReserveFloor); // >1 invalid → default
  });

  // Catches: the permit order being wrong — the whole point is that the gate
  // and the pilot-protecting floor deny BEFORE the softer caps, and only the
  // per-day cap latches.
  test("evaluateDispatch: gate → breaker → quota → caps, with per-day latch", () => {
    expect(evaluateDispatch(ctx({ gateOn: false }))).toMatchObject({ permit: false, reason: "gate-off" });
    expect(evaluateDispatch(ctx({ breaker: tripOpen(defaultBreaker(), "manual", NOW) }))).toMatchObject({
      permit: false,
      reason: "breaker-open",
    });
    // Fail SAFE: unreadable quota refuses (D4 load-bearing unknown 3).
    expect(evaluateDispatch(ctx({ quotaFraction: null }))).toMatchObject({ permit: false, reason: "quota-unreadable" });
    expect(evaluateDispatch(ctx({ quotaFraction: 0.1 }))).toMatchObject({ permit: false, reason: "quota-floor" });
    expect(evaluateDispatch(ctx({ inFlightCount: cfg.maxConcurrent }))).toMatchObject({
      permit: false,
      reason: "concurrency-cap",
      trip: null, // soft, self-clearing — no manual reset for a busy tick
    });
    expect(evaluateDispatch(ctx({ dispatchesThisTick: cfg.perTickCap }))).toMatchObject({
      permit: false,
      reason: "per-tick-cap",
      trip: null,
    });
    // Per-day cap is the runaway signal: deny AND latch.
    expect(evaluateDispatch(ctx({ dispatchesLast24h: cfg.perDayCap }))).toMatchObject({
      permit: false,
      reason: "per-day-cap",
      trip: "per-day-cap",
    });
    expect(evaluateDispatch(ctx())).toMatchObject({ permit: true, reason: "ok", trip: null });
  });

  test("save→load round-trip is byte-stable", () => {
    const dir = tmp();
    const b = loadBreakers(dir);
    b.council = tripOpen(defaultBreaker(), "fail-streak", NOW) as BreakerState;
    saveBreakers(dir, b);
    const first = loadBreakers(dir);
    saveBreakers(dir, first);
    expect(loadBreakers(dir)).toEqual(first);
  });
});
