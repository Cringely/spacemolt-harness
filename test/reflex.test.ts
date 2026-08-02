import { describe, expect, test } from "bun:test";
import { evaluateReflex, fuelUrgent, reflexGaveUpAt } from "../src/agent/reflex";
import type { StatusSnapshot } from "../src/client/client";

function status(overrides: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    credits: 0, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, ...overrides,
  };
}

describe("evaluateReflex", () => {
  test("fires refuel when docked and fuel below threshold (percent fallback, unmeasured)", () => {
    expect(evaluateReflex(status({ fuel: 10 }), { keepFuelAbovePct: 25 }))
      .toEqual({ action: "refuel", reason: "low_fuel" });
  });

  test("fires repair when docked and hull below threshold", () => {
    expect(evaluateReflex(status({ hull: 20 }), { repairBelowHullPct: 30 }))
      .toEqual({ action: "repair", reason: "low_hull" });
  });

  test("fuel takes priority over hull when both breach", () => {
    const r = evaluateReflex(status({ fuel: 5, hull: 5 }), { keepFuelAbovePct: 25, repairBelowHullPct: 30 });
    expect(r?.action).toBe("refuel");
  });

  test("does not fire while undocked, even below threshold", () => {
    expect(evaluateReflex(status({ fuel: 5, docked: false }), { keepFuelAbovePct: 25 })).toBeNull();
  });

  test("does not fire when no threshold is configured", () => {
    expect(evaluateReflex(status({ fuel: 5 }), {})).toBeNull();
  });

  test("does not fire on a null status", () => {
    expect(evaluateReflex(null, { keepFuelAbovePct: 25 })).toBeNull();
  });

  // Issue #672: the per-station give-up flags withhold firing the same way
  // planRemediesFuel/Hull already do.
  test("withholds refuel when fuelGaveUpHere is set, even below threshold", () => {
    expect(evaluateReflex(status({ fuel: 10 }), { keepFuelAbovePct: 25 }, undefined, false, false, true))
      .toBeNull();
  });

  test("withholds repair when hullGaveUpHere is set, even below threshold", () => {
    expect(evaluateReflex(status({ hull: 20 }), { repairBelowHullPct: 30 }, undefined, false, false, false, true))
      .toBeNull();
  });

  // Issue #670: the actual live incident and its inverse. Same fuel, same
  // percent of tank (19/130 = 14.6%, below any percent floor anyone would
  // configure) -- the jump cost is what must flip the verdict.
  describe("jump-based urgency (issue #670)", () => {
    test("19/130 fuel at 1 fuel/jump (19 jumps of range) is NOT urgent", () => {
      expect(evaluateReflex(
        status({ fuel: 19, maxFuel: 130 }), { keepFuelAboveJumps: 2 }, 1,
      )).toBeNull();
    });

    test("19/130 fuel at 15 fuel/jump (1 jump of range) IS urgent -- same percent, opposite verdict", () => {
      expect(evaluateReflex(
        status({ fuel: 19, maxFuel: 130 }), { keepFuelAboveJumps: 2 }, 15,
      )).toEqual({ action: "refuel", reason: "low_fuel" });
    });

    test("measured fuelPerJump REPLACES percent, not ORs with it: a measured-abundant ship does not fire even below the configured percent floor", () => {
      // 19/130 = 14.6%, well under a 25% percent floor -- the old code would
      // fire here unconditionally. With a measurement showing 19 jumps of
      // range, it must not.
      expect(evaluateReflex(
        status({ fuel: 19, maxFuel: 130 }), { keepFuelAbovePct: 25, keepFuelAboveJumps: 2 }, 1,
      )).toBeNull();
    });

    test("unmeasured (fuelPerJump undefined) falls back to percent-of-tank, unchanged from before this fix", () => {
      expect(evaluateReflex(
        status({ fuel: 19, maxFuel: 130 }), { keepFuelAbovePct: 25, keepFuelAboveJumps: 2 }, undefined,
      )).toEqual({ action: "refuel", reason: "low_fuel" });
    });
  });
});

// fuelUrgent (issue #526 extraction): evaluateReflex's own tests above
// exercise this formula thoroughly through the docked wrapper. These are
// direct-call tests on the exported name itself -- the contract a SECOND
// consumer (executor.ts's mine fuel-floor guard) now also depends on, so a
// signature or precedence change here would need to be caught without
// routing through evaluateReflex's docked-only gate.
describe("fuelUrgent", () => {
  test("jump-aware boundary: floor(fuel/fuelPerJump) < keepAboveJumps is the exact cutoff", () => {
    // Killing mutation: `<` -> `<=` flips this exact boundary (floor(9/3)=3).
    expect(fuelUrgent(9, 100, 3, 3, undefined)).toBe(false); // exactly 3 jumps of range, threshold is 3: not urgent
    expect(fuelUrgent(8, 100, 3, 3, undefined)).toBe(true); // 2 jumps of range, under the threshold: urgent
  });

  test("measured fuelPerJump REPLACES the percent check, never ORs with it", () => {
    // Killing mutation: `||` instead of the ternary's replace semantics.
    // 19/130 = 14.6%, under a 25% floor, but 19 jumps of range at 1/jump.
    expect(fuelUrgent(19, 130, 1, 2, 25)).toBe(false);
  });

  test("unmeasured (fuelPerJump undefined) falls back to percent-of-tank", () => {
    // Killing mutation: dropping the `fuelPerJump != null` guard so an
    // undefined fuelPerJump reaches the jump branch (NaN comparisons are
    // always false, which would silently disable the percent fallback).
    expect(fuelUrgent(19, 130, undefined, 2, 25)).toBe(true);
  });

  test("neither threshold configured: never urgent", () => {
    // Killing mutation: a `??` default substituted for either threshold.
    expect(fuelUrgent(1, 100, undefined, undefined, undefined)).toBe(false);
  });
});

describe("reflexGaveUpAt", () => {
  test("false with no matching terminal failure recorded", () => {
    expect(reflexGaveUpAt([], "station_a", "refuel")).toBe(false);
    expect(reflexGaveUpAt(
      [{ action: "refuel", stationKey: "station_a", terminal: false }],
      "station_a", "refuel",
    )).toBe(false); // recorded but NOT terminal -- a transient failure must not arm the give-up
  });

  test("true once a terminal failure is recorded for this exact (stationKey, action)", () => {
    expect(reflexGaveUpAt(
      [{ action: "refuel", stationKey: "station_a", terminal: true }],
      "station_a", "refuel",
    )).toBe(true);
  });

  test("does not cross station keys: a terminal failure elsewhere doesn't give up here", () => {
    expect(reflexGaveUpAt(
      [{ action: "refuel", stationKey: "station_b", terminal: true }],
      "station_a", "refuel",
    )).toBe(false);
  });

  test("does not cross actions: a terminal refuel failure doesn't give up repair at the same station", () => {
    expect(reflexGaveUpAt(
      [{ action: "refuel", stationKey: "station_a", terminal: true }],
      "station_a", "repair",
    )).toBe(false);
  });

  test("tolerates a legacy record (no stationKey/terminal fields) without crashing or matching", () => {
    expect(reflexGaveUpAt(
      [null, undefined, { action: "refuel" }],
      "station_a", "refuel",
    )).toBe(false);
  });
});
