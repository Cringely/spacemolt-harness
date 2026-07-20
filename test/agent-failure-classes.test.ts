import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { Store } from "../src/store/store";
import { TransientPlannerError, SubscriptionLimitError, TokenInvalidError } from "../src/planner/errors";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner } from "../src/planner/types";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 3, subscriptionCooldownMinutes: 60,
};

function stubApi(status?: Partial<StatusSnapshot>) {
  const s: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, ...status,
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return s; },
    async notifications() { return []; },
  };
  return api;
}

const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };
const alwaysThrows = (err: Error): Planner => ({ plan: async () => { throw err; } });
const alwaysSucceeds = (plan: Plan): Planner => ({ plan: async () => ({ plan, promptChars: 0, responseChars: 0 }) });

describe("Agent failure classification", () => {
  test("transient failures back off exponentially, then stall after stallThreshold", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("network down")),
      config, now: () => now,
    });

    await agent.runOnce(); // no_plan wake -> replan -> transient failure #1
    now += 15 * 60_000 + 1; // well past the 30s-base backoff and the heartbeat
    await agent.runOnce(); // #2
    now += 15 * 60_000 + 1;
    await agent.runOnce(); // #3 -> reaches stallThreshold (3)

    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(3);
    expect(types).toContain("stalled");
  });

  test("backoff suppresses replan spam while a running plan keeps executing", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const calls: string[] = [];
    const status: StatusSnapshot = {
      credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100, // low fuel -> wake fires every tick
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(name) { calls.push(name); return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const agent = new Agent({
      id: "a1", persona: "p", api, store,
      planner: alwaysThrows(new TransientPlannerError("down")),
      config, now: () => now,
    });

    await agent.runOnce(); // low_fuel wake -> replan attempted -> fails, backoff set (~30s from now=0)
    now += 1_000; // still inside the 30s backoff window
    await agent.runOnce(); // low_fuel wake fires again, backoff suppresses replan -> executes plan step instead
    expect(calls).toEqual(["mine"]); // the saved plan kept running despite the failing planner
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(1); // not retried during backoff
  });

  test("subscription_limit switches to the fallback planner for the next replan attempt", async () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new SubscriptionLimitError("usage limit")),
      fallbackPlanner: alwaysSucceeds(okPlan),
      config, now: () => 1,
    });
    await agent.runOnce(); // primary fails -> usingFallback = true, no plan yet
    expect(store.loadPlan("a1")).toBeNull();
    await agent.runOnce(); // no_plan wake still active -> now routed to fallback -> succeeds
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok");
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("planner_subscription_limit");
  });

  test("subscription_limit with no fallback enters a long cooldown -- no hot retry loop", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new SubscriptionLimitError("usage limit")),
      config, now: () => now,
    });
    await agent.runOnce(); // sets cooldown = 60 min from now=0
    now = 15 * 60_000 + 1; // a heartbeat would normally re-wake here
    await agent.runOnce(); // still inside the 60min cooldown -> no second attempt
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_subscription_limit").length).toBe(1);
  });

  test("token_invalid disables the primary planner permanently and falls back if configured", async () => {
    const store = new Store(":memory:");
    let primaryCalls = 0;
    const primary: Planner = { plan: async () => { primaryCalls++; throw new TokenInvalidError("bad token"); } };
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: alwaysSucceeds(okPlan),
      config, now: () => 1,
    });
    await agent.runOnce(); // token_invalid -> claudeDisabled = true, operator_alert emitted
    await agent.runOnce(); // this and every future replan routes straight to the fallback
    expect(primaryCalls).toBe(1); // never called again
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok");
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("operator_alert");
  });

  test("plan violating PlanSchema bounds is rejected at the replan seam: planner_error, nothing executed", async () => {
    const store = new Store(":memory:");
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
      async status() {
        return {
          credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
    };
    const hallucinating: Planner = {
      plan: async () => ({
        plan: { goal: "grind forever", steps: [{ action: "mine", params: {}, repeat: 999999 }] } as unknown as Plan,
        promptChars: 0, responseChars: 0,
      }),
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: hallucinating, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan -> PlanSchema.parse rejects
    expect(store.loadPlan("a1")).toBeNull(); // never persisted
    expect(calls).toEqual([]); // no game mutation executed
    const types = store.recentEvents("a1", 10).map((e) => e.type);
    expect(types).toContain("planner_error"); // existing catch-all path, not a crash
  });
});
