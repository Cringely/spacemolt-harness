import { describe, expect, test } from "bun:test";
import { evaluateReflex, reflexGaveUpAt } from "../src/agent/reflex";
import type { StatusSnapshot } from "../src/client/client";

function status(overrides: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    credits: 0, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, ...overrides,
  };
}

describe("evaluateReflex", () => {
  test("fires refuel when docked and fuel below threshold", () => {
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
    expect(evaluateReflex(status({ fuel: 10 }), { keepFuelAbovePct: 25 }, false, false, true))
      .toBeNull();
  });

  test("withholds repair when hullGaveUpHere is set, even below threshold", () => {
    expect(evaluateReflex(status({ hull: 20 }), { repairBelowHullPct: 30 }, false, false, false, true))
      .toBeNull();
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
