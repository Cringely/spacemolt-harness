import { test, expect, describe } from "bun:test";
import type { StatusSnapshot } from "../src/client/client";
import {
  progressFingerprint, progressGrandTotal, fuelBelowReserve, isStranded, noProgressJudge,
} from "../src/agent/stall-monitor";

// These unit-pin the branches of the pure stall-watcher substrate that the
// agent-level behavioral tests (no-progress, stall-watcher, progress-heartbeat)
// reach only indirectly: the null-propagation of the progress scalar, the
// judge's fail-safe/re-seed table, the divide-by-zero and boundary of the fuel
// predicate, the strand truth table, and the enumerated fingerprint inputs.

function mkStatus(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    credits: 100, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 100, docked: false, inTransit: false,
    systemId: "sys_a", dockedAt: null,
    ...over,
  };
}

describe("progressGrandTotal", () => {
  test("null when stats absent (UNKNOWN counters -> suppress)", () => {
    expect(progressGrandTotal(undefined, 5, 2)).toBeNull();
  });
  test("null when skills UNKNOWN, even with known counters/achievements", () => {
    expect(progressGrandTotal({ credits_earned: 10 }, null, 2)).toBeNull();
  });
  test("null when achievements UNKNOWN", () => {
    expect(progressGrandTotal({ credits_earned: 10 }, 5, null)).toBeNull();
  });
  test("sums allowlisted counters + skill levels + achievements when all known", () => {
    // credits_earned(10) + ore_mined(3) allowlisted = 13; +skills 5 +ach 2 = 20.
    // jumps_completed is EXCLUDED movement, must not count.
    expect(progressGrandTotal({ credits_earned: 10, ore_mined: 3, jumps_completed: 99 }, 5, 2)).toBe(20);
  });
});

describe("noProgressJudge", () => {
  const windowMs = 30 * 60_000;
  test("null total refreshes the clock and drops the baseline (fail-safe, never stuck)", () => {
    const r = noProgressJudge({ total: null, prevTotal: 40, prevAt: 0, now: 999, windowMs });
    expect(r).toEqual({ total: undefined, at: 999, noProgress: false });
  });
  test("first known sample seeds baseline, no stall", () => {
    const r = noProgressJudge({ total: 40, prevTotal: undefined, prevAt: undefined, now: 100, windowMs });
    expect(r).toEqual({ total: 40, at: 100, noProgress: false });
  });
  test("any change re-seeds baseline and clock", () => {
    const r = noProgressJudge({ total: 41, prevTotal: 40, prevAt: 0, now: 5000, windowMs });
    expect(r).toEqual({ total: 41, at: 5000, noProgress: false });
  });
  test("anomalous DROP is treated as a change (re-seed), never as flat", () => {
    const r = noProgressJudge({ total: 39, prevTotal: 40, prevAt: 0, now: 5000, windowMs });
    expect(r).toEqual({ total: 39, at: 5000, noProgress: false });
  });
  test("exactly flat but inside the window: not yet stuck, baseline held", () => {
    const r = noProgressJudge({ total: 40, prevTotal: 40, prevAt: 1000, now: 1000 + windowMs - 1, windowMs });
    expect(r).toEqual({ total: 40, at: 1000, noProgress: false });
  });
  test("exactly flat for a full window: stuck, baseline held", () => {
    const r = noProgressJudge({ total: 40, prevTotal: 40, prevAt: 1000, now: 1000 + windowMs, windowMs });
    expect(r).toEqual({ total: 40, at: 1000, noProgress: true });
  });
});

describe("fuelBelowReserve", () => {
  test("maxFuel 0 reads as NOT below reserve (no divide-by-zero, no phantom signal)", () => {
    expect(fuelBelowReserve(mkStatus({ fuel: 0, maxFuel: 0 }), 25)).toBe(false);
  });
  test("strictly below the pct is true", () => {
    expect(fuelBelowReserve(mkStatus({ fuel: 24, maxFuel: 100 }), 25)).toBe(true);
  });
  test("exactly at the pct is NOT below (strict <)", () => {
    expect(fuelBelowReserve(mkStatus({ fuel: 25, maxFuel: 100 }), 25)).toBe(false);
  });
});

describe("isStranded", () => {
  const base = {
    docked: false, fuelBelowReserve: true, fuelBlockedMoves: 3,
    currentPoiHasBase: false, fuelBlockThreshold: 3,
  };
  test("all four conditions -> stranded", () => {
    expect(isStranded(base)).toBe(true);
  });
  test("docked cancels the strand (reflex can refuel)", () => {
    expect(isStranded({ ...base, docked: true })).toBe(false);
  });
  test("fuel above reserve cancels the strand", () => {
    expect(isStranded({ ...base, fuelBelowReserve: false })).toBe(false);
  });
  test("below the fuel-block threshold cancels the strand", () => {
    expect(isStranded({ ...base, fuelBlockedMoves: 2 })).toBe(false);
  });
  test("a base at the current POI cancels the strand", () => {
    expect(isStranded({ ...base, currentPoiHasBase: true })).toBe(false);
  });
});

describe("progressFingerprint", () => {
  test("a fingerprinted field (cargoUsed) changing changes the fingerprint", () => {
    expect(progressFingerprint(mkStatus({ cargoUsed: 5 }), 0))
      .not.toBe(progressFingerprint(mkStatus({ cargoUsed: 6 }), 0));
  });
  test("cursor.step advancing reads as progress (different fingerprint)", () => {
    expect(progressFingerprint(mkStatus(), 0)).not.toBe(progressFingerprint(mkStatus(), 1));
  });
  test("a NON-enumerated field (maxFuel/cargoCapacity) leaves the fingerprint identical", () => {
    // The freeze detector must read these two frozen ships as identical -- only
    // the enumerated progress fields count.
    expect(progressFingerprint(mkStatus({ maxFuel: 100, cargoCapacity: 100 }), 2))
      .toBe(progressFingerprint(mkStatus({ maxFuel: 80, cargoCapacity: 50 }), 2));
  });
});
