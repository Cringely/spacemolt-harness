import { describe, expect, test } from "bun:test";
import { evaluateWake, type WakeInput } from "../src/agent/wake";

const base: WakeInput = {
  planState: "running",
  notifications: [],
  status: {
    credits: 0, fuel: 80, maxFuel: 100, hull: 90, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  },
  lastPlanAt: 1_000_000,
  now: 1_000_000 + 60_000, // 1 min since last plan
  heartbeatMs: 15 * 60_000,
  fuelPct: 20,
  hullPct: 30,
  wakeNotificationTypes: ["combat", "chat"],
};

describe("evaluateWake", () => {
  test("healthy running plan does not wake", () => {
    expect(evaluateWake(base)).toBeNull();
  });

  test("instruction beats everything", () => {
    const r = evaluateWake({ ...base, planState: "blocked", instruction: "go home" });
    expect(r).toEqual({ reason: "instruction", detail: "go home" });
  });

  test("blocked plan wakes with reason", () => {
    const r = evaluateWake({ ...base, planState: "blocked", blockedReason: "no fuel" });
    expect(r).toEqual({ reason: "blocked", detail: "no fuel" });
  });

  test("no plan and plan done wake", () => {
    expect(evaluateWake({ ...base, planState: "none" })).toEqual({ reason: "no_plan" });
    expect(evaluateWake({ ...base, planState: "done" })).toEqual({ reason: "plan_done" });
  });

  test("only configured notification types wake", () => {
    const combat = { id: "n1", type: "combat", msg_type: "combat_update", timestamp: "t" };
    const tip = { id: "n2", type: "tip", msg_type: "tip", timestamp: "t" };
    expect(evaluateWake({ ...base, notifications: [tip] })).toBeNull();
    const r = evaluateWake({ ...base, notifications: [tip, combat] });
    expect(r).toEqual({ reason: "notification", detail: "combat_update" });
  });

  test("critical msg_types wake regardless of type filter", () => {
    // player_died arrives as type "system", which is not in the default
    // type filter — it must wake anyway
    const died = { id: "n3", type: "system", msg_type: "player_died", timestamp: "t" };
    const r = evaluateWake({ ...base, notifications: [died] });
    expect(r).toEqual({ reason: "notification", detail: "player_died" });
  });

  test("low fuel and low hull thresholds", () => {
    const low = { ...base.status!, fuel: 19 };
    expect(evaluateWake({ ...base, status: low })).toEqual({ reason: "low_fuel", detail: "19/100" });
    const hurt = { ...base.status!, hull: 25 };
    expect(evaluateWake({ ...base, status: hurt })).toEqual({ reason: "low_hull", detail: "25/100" });
  });

  test("issue #670: 19 jumps of measured range is not a fuel emergency", () => {
    // Live incident shape: fuel 19/100, but fuelPerJump 1 means 19 jumps of
    // real range -- floor(19/1)=19 is not below the 5-jump floor, so no wake,
    // even though the raw percent (19%) is below fuelPct (20).
    const low = { ...base.status!, fuel: 19 };
    const r = evaluateWake({ ...base, status: low, fuelPerJump: 1, keepFuelAboveJumps: 5 });
    expect(r).toBeNull();
  });

  test("issue #670: unmeasured ship falls back to percent-of-tank", () => {
    // Same fuel, but fuelPerJump omitted (this ship has never completed a
    // measured jump) -- keepFuelAboveJumps alone can't drive fuelUrgent, so
    // the percent check (fuelPct) still applies, unchanged from before.
    const low = { ...base.status!, fuel: 19 };
    const r = evaluateWake({ ...base, status: low, keepFuelAboveJumps: 5 });
    expect(r).toEqual({ reason: "low_fuel", detail: "19/100" });
  });

  test("issue #1045: a measured, well-ranged ship still wakes below its reserve floor", () => {
    // The issue's own receipt: undocked, fuel 3/130 (2.3%), fuelReservePct 25,
    // fuelPerJump 1, keepFuelAboveJumps 2 -- floor(3/1)=3 is not below 2, so
    // fuelUrgent's jumps branch says "fine" nine times over on the 25% floor.
    // Before this fix that verdict alone decided the outcome (null, no wake);
    // reserveUrgent must now fire independently since 2.3% < 25%.
    const low = { ...base.status!, fuel: 3, maxFuel: 130 };
    const r = evaluateWake({
      ...base, status: low, fuelReservePct: 25, fuelPerJump: 1, keepFuelAboveJumps: 2,
    });
    expect(r).toEqual({ reason: "low_fuel", detail: "3/130" });
  });

  test("issue #1045: docked stays on fuelPct even with a reserve configured", () => {
    // reserveUrgent is gated !docked -- a docked ship below the reserve but
    // above fuelPct must NOT wake (the reflex refuels it there instead).
    const dockedLow = { ...base.status!, fuel: 3, maxFuel: 130, docked: true };
    const r = evaluateWake({
      ...base, status: dockedLow, fuelReservePct: 25, fuelPerJump: 1, keepFuelAboveJumps: 2,
    });
    expect(r).toBeNull();
  });

  test("heartbeat fires after interval", () => {
    const r = evaluateWake({ ...base, now: base.lastPlanAt + base.heartbeatMs + 1 });
    expect(r).toEqual({ reason: "heartbeat" });
  });

  test("null status skips threshold checks", () => {
    expect(evaluateWake({ ...base, status: null })).toBeNull();
  });
});
