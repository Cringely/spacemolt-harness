import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

const baseConfig: AgentConfig = {
  fuelPct: 25, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  maxPlansPerWindow: 12, planBudgetWindowMinutes: 60,
};

// Layer 1 (producer fix). Ground truth: 231/233 wakes were low_fuel, fuel
// pinned at 32/130, the plan frozen at step 0 (dock). evaluateWake returned
// low_fuel every tick unaware the in-flight plan already carried a refuel step;
// any wake replanned and reset the cursor to 0 before executeOne() ran, so the
// executor never reached the refuel and fuel never changed -- a livelock. This
// test reproduces the exact shape and asserts the fix: the planner is called
// exactly once (the initial no_plan), the executor advances through dock ->
// refuel -> mine, and refuel actually fires. On pre-fix code the low_fuel wake
// preempts every tick: the planner call count climbs and no game action ever
// executes -- both assertions fail.
describe("Layer 1: plan-remedy suppresses the reflex-class wake (low_fuel livelock)", () => {
  test("low fuel + undocked, plan carries refuel: planner called once, executor advances past dock and refuels", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };

    let fuel = 20; // 20/130 ~= 15% < fuelPct 25 -> low_fuel would fire without the gate
    const actions: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        actions.push(name);
        if (name === "refuel") fuel = 130; // the plan's own remedy, once reached, fixes fuel
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 0, fuel, maxFuel: 130, hull: 130, maxHull: 130,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId: "s1",
        };
      },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    // repeat: 5 keeps the plan running past tick 5 so no plan_done wake triggers
    // a second (legitimate) replan and muddies the "called exactly once" assert.
    const plan: Plan = { goal: "dock, refuel, then mine", steps: [
      { action: "dock", params: {} },
      { action: "refuel", params: {} },
      { action: "mine", params: {}, repeat: 5 },
    ]};
    const planner = new MockPlanner([plan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => now });

    await tick(agent); // no_plan wake -> replan (the one and only planner call)
    await tick(agent); // running, refuel still ahead -> low_fuel suppressed -> executeOne: dock
    await tick(agent); // running, refuel still ahead -> suppressed -> executeOne: refuel (fuel -> full)
    await tick(agent); // running, no remedy left but fuel now full -> executeOne: mine (1/5)
    await tick(agent); // executeOne: mine (2/5)

    expect(planner.contexts.length).toBe(1);              // initial no_plan only -- never preempted
    expect(planner.contexts[0]!.wake.reason).toBe("no_plan");
    expect(actions).toContain("refuel");                   // executor advanced past dock and ran the remedy
    expect(agent.snapshot().stepIndex).toBe(2);            // cursor reached the mine step, not stuck at 0
  });

  // The suppression is scoped to a *running* plan carrying the remedy AHEAD of
  // the cursor -- it must not silently mute a genuine low_fuel when no remedy
  // is in-flight, or the planner would never be told about a real fuel problem.
  test("low fuel + undocked with a plan that has no refuel step: low_fuel still wakes the planner", async () => {
    const status: StatusSnapshot = {
      credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    // Seed a running plan with no refuel step so planState is "running" and the
    // low_fuel branch (not no_plan) is the one that fires.
    store.savePlan("a1", { goal: "mine", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.wake.reason).toBe("low_fuel");
  });
});

// Layer 3 (per-agent rolling ceiling). A wake reason the thrash damper misses
// -- low_fuel here -- replans every tick unbounded on pre-Layer-3 code. The
// ceiling counts this agent's `wake` events in a trailing window from the
// events table and skips the planner call once the count reaches the cap,
// while keeping any in-flight plan executing. It is self-clearing: as old
// wakes age out of the window, replanning resumes.
describe("Layer 3: per-agent rolling plan-budget ceiling", () => {
  test("a wake fired every tick never exceeds the ceiling in any trailing window, and replanning resumes after the window drains", async () => {
    const maxPlans = 5;
    const windowMinutes = 60;
    const windowMs = windowMinutes * 60_000;
    const dt = 60_000; // 1 minute per tick

    let now = 0;
    const tick = async (agent: Agent) => { now += dt; await agent.runOnce(); };

    const status: StatusSnapshot = {
      credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100, // pinned low fuel -> low_fuel every tick
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; }, // mine always "succeeds" -> plan stays running
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    // Plan carries no refuel step (so Layer 1 never suppresses the low_fuel
    // wake) and never completes (cargo never fills, so no plan_done wake ever
    // changes the wake reason) -- exactly the runaway case the ceiling bounds.
    const runawayPlan: Plan = { goal: "mine forever", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    store.savePlan("a1", runawayPlan, []);
    const planner = new MockPlanner([runawayPlan]);
    const config: AgentConfig = {
      ...baseConfig, fuelPct: 20, maxPlansPerWindow: maxPlans, planBudgetWindowMinutes: windowMinutes,
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    for (let i = 0; i < 200; i++) await tick(agent);

    const wakeTs = store.recentEvents("a1", 10_000).filter((e) => e.type === "wake").map((e) => e.ts);

    // Hard cap: no trailing window ending at any wake ever holds more than the ceiling.
    for (const t of wakeTs) {
      const inWindow = wakeTs.filter((x) => x >= t - windowMs && x <= t).length;
      expect(inWindow).toBeLessThanOrEqual(maxPlans);
    }

    // Not a permanent latch: replanning resumed more than a full window after
    // the first burst (old wakes aged out and the planner was called again).
    expect(wakeTs.length).toBeGreaterThan(maxPlans);
    expect(Math.max(...wakeTs) - Math.min(...wakeTs)).toBeGreaterThan(windowMs);

    // Throttled event: one per over-budget episode, NOT one per capped tick
    // (~180 ticks were capped).
    const budgetEvents = store.recentEvents("a1", 10_000).filter((e) => e.type === "plan_budget_exceeded");
    expect(budgetEvents.length).toBeGreaterThanOrEqual(1);
    expect(budgetEvents.length).toBeLessThan(20);
  });

  // The operator is the escape hatch. A low_fuel wake at/over budget is capped
  // (the guard works), but an instruction wake at the SAME budget must still
  // reach the planner so a human can steer a thrashing agent.
  test("an instruction wake bypasses the cap even when a same-budget low_fuel wake is deferred", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 60_000; await agent.runOnce(); };

    const status: StatusSnapshot = {
      credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100, // low fuel -> low_fuel every tick
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const runawayPlan: Plan = { goal: "mine forever", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    store.savePlan("a1", runawayPlan, []); // running plan, no refuel -> low_fuel fires every tick
    const planner = new MockPlanner([runawayPlan]);
    const config: AgentConfig = { ...baseConfig, fuelPct: 20, maxPlansPerWindow: 1, planBudgetWindowMinutes: 60 };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // low_fuel -> replan (fills the budget of 1)
    expect(planner.contexts.length).toBe(1);

    await tick(agent); // low_fuel again, now at budget -> capped, no replan
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts.at(-1)!.wake.reason).toBe("low_fuel");

    agent.instruct("dock and hold");
    await tick(agent); // instruction wake at the same budget -> bypasses the cap -> replan
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts.at(-1)!.wake.reason).toBe("instruction");
  });
});
