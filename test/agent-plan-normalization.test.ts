import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot, SystemInfo } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// SM-3 flight diagnosis (2026-07-10): planner produced an otherwise-perfect
// plan but passed the display NAME as the id -- `travel {id: "Commerce
// Fields"}` where the game requires "commerce_fields". Game rejected:
// "Unknown destination: Commerce Fields". These tests guard the fix: plan
// admission normalization in Agent.replan() (src/agent/agent.ts), backed by
// src/agent/normalize-plan.ts.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

function stubApiWithMap(system: SystemInfo) {
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, dockedAt: "base-1",
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    async getSystem() { return system; },
  };
  return api;
}

const commerceFieldsSystem: SystemInfo = {
  id: "sys-1", name: "Alpha Prime", connections: ["sys-2"],
  pois: [{ id: "commerce_fields", name: "Commerce Fields", type: "asteroid_belt", class: "metallic" }],
};

describe("Agent plan admission normalization (SM-3)", () => {
  test("VERIFIED 2026-07-10: rewrites the display name to the id and emits plan_normalized", async () => {
    const api = stubApiWithMap(commerceFieldsSystem);
    const store = new Store(":memory:");
    const badPlan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "Commerce Fields" } }] };
    const planner = new MockPlanner([badPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan
    expect(planner.contexts.length).toBe(1); // resolved on the first attempt, no retry needed

    const saved = store.loadPlan("a1")!.plan;
    expect(saved.steps[0]).toEqual({ action: "travel", params: { id: "commerce_fields" } });

    const events = store.recentEvents("a1", 20).filter((e) => e.type === "plan_normalized");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({
      rewrites: [{ step: 0, action: "travel", param: "id", from: "Commerce Fields", to: "commerce_fields" }],
    });
  });

  test("an exact id match commits untouched with no plan_normalized event", async () => {
    const api = stubApiWithMap(commerceFieldsSystem);
    const store = new Store(":memory:");
    const goodPlan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "commerce_fields" } }] };
    const planner = new MockPlanner([goodPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(1);
    expect(store.loadPlan("a1")!.plan.steps[0]).toEqual({ action: "travel", params: { id: "commerce_fields" } });
    expect(store.recentEvents("a1", 20).filter((e) => e.type === "plan_normalized")).toEqual([]);
  });

  test("an unresolvable ref retries the planner once with the known-ids error, then commits the corrected plan", async () => {
    const api = stubApiWithMap(commerceFieldsSystem);
    const store = new Store(":memory:");
    const badPlan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "Nonexistent Place" } }] };
    const goodPlan: Plan = { goal: "mine (corrected)", steps: [{ action: "travel", params: { id: "commerce_fields" } }] };
    const planner = new MockPlanner([badPlan, goodPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(2); // original attempt + the one retry
    expect(planner.contexts[1]!.instruction).toContain("unknown id 'Nonexistent Place'");
    expect(planner.contexts[1]!.instruction).toContain("commerce_fields");

    expect(store.loadPlan("a1")!.plan.goal).toBe("mine (corrected)");
    expect(store.recentEvents("a1", 20).filter((e) => e.type === "plan_normalized")).toEqual([]); // 2nd attempt was exact
  });

  test("an unresolvable ref that fails again on retry falls through to the existing planner_error path", async () => {
    const api = stubApiWithMap(commerceFieldsSystem);
    const store = new Store(":memory:");
    const badPlan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "Nonexistent Place" } }] };
    const planner = new MockPlanner([badPlan]); // MockPlanner repeats the last plan on the retry too
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // must not throw
    expect(planner.contexts.length).toBe(2);
    expect(store.loadPlan("a1")).toBeNull(); // never committed
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "planner_error");
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { message: string }).message).toContain("unknown id 'Nonexistent Place'");
  });

  test("surroundings undefined (no getSystem on GameApi) skips normalization -- plan commits as-is", async () => {
    const store = new Store(":memory:");
    const nameLikePlan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "Commerce Fields" } }] };
    const planner = new MockPlanner([nameLikePlan]);
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() {
        return {
          credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
      // no getSystem -- gatherSurroundings() degrades to undefined
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // must not throw, must not retry
    expect(planner.contexts.length).toBe(1);
    expect(store.loadPlan("a1")!.plan.steps[0]).toEqual({ action: "travel", params: { id: "Commerce Fields" } });
    expect(store.recentEvents("a1", 20).filter((e) => e.type === "plan_normalized")).toEqual([]);
  });
});
