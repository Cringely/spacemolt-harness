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

  test("heartbeat fires after interval", () => {
    const r = evaluateWake({ ...base, now: base.lastPlanAt + base.heartbeatMs + 1 });
    expect(r).toEqual({ reason: "heartbeat" });
  });

  test("null status skips threshold checks", () => {
    expect(evaluateWake({ ...base, status: null })).toBeNull();
  });
});
