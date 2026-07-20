import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

const baseConfig: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  reflex: { keepFuelAbovePct: 25 },
};

function makeApi(status: StatusSnapshot, opts?: { failRefuel?: boolean }) {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> {
      calls.push(name);
      if (name === "refuel" && opts?.failRefuel) throw new SpacemoltError("command_error", "can't afford fuel");
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

const lowFuelDocked: StatusSnapshot = {
  credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

describe("Agent reflex integration", () => {
  test("docked + low fuel: reflex refuels, suppresses the wake, planner not called", async () => {
    const { api, calls } = makeApi(lowFuelDocked);
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]);
    expect(planner.contexts.length).toBe(0);
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toEqual(["reflex"]);
  });

  test("undocked + low fuel: reflex does not fire, low_fuel wake replans as in Plan 1", async () => {
    const { api, calls } = makeApi({ ...lowFuelDocked, docked: false });
    const store = new Store(":memory:");
    // Seed a running plan before constructing the Agent. Derivation:
    // evaluateWake's branches are checked in a fixed unconditional order
    // (src/agent/wake.ts, evaluateWake body: instruction -> blocked ->
    // planState "none" -> "done" -> notifications -> low_fuel/low_hull ->
    // heartbeat), so a fresh agent with no plan wakes with reason "no_plan"
    // and never reaches the fuel-threshold check. A plan loaded from the
    // store sets planState "running" in the Agent constructor, letting
    // low_fuel be the first branch that fires. Same seeding pattern as
    // Task 4's backoff test.
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual([]); // no refuel attempted, no plan step executed (the wake preempts execution)
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.wake.reason).toBe("low_fuel");
  });

  test("failed reflex ('can't afford') marks itself failed and still lets the wake fire", async () => {
    const { api, calls } = makeApi(lowFuelDocked, { failRefuel: true });
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]); // attempted once, no second mutation this tick
    expect(planner.contexts.length).toBe(1); // wake still fired despite the failed reflex
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toContain("reflex_failed");
  });

  // Closes a coverage gap flagged by independent review (Batch G, Task 8):
  // the two `!reflexSpentTick && this.plan && this.planState === "running"`
  // guards in runOnce() (src/agent/agent.ts) were previously unexercised by
  // any test with an actual running plan present, because the prior "failed
  // reflex" test never seeded one -- `this.plan` was already null there, so
  // that guard was never the thing preventing executeOne. This test uses a
  // fuel level between the reflex threshold (25%) and the wake threshold
  // (fuelPct: 20%) so the reflex fires-and-fails while evaluateWake's
  // low_fuel branch (wake.ts:42-43) does NOT trip -- wake is null, so
  // control reaches the final `if (!reflexSpentTick && ...)` at
  // agent.ts:149. Removing that guard would let the seeded "mine" step
  // execute, which this test would catch via `calls`.
  test("failed reflex with a running plan and no wake: executeOne is skipped, not just plan-absent", async () => {
    const { api, calls } = makeApi({ ...lowFuelDocked, fuel: 22 }, { failRefuel: true });
    const store = new Store(":memory:");
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]); // reflex attempted; "mine" (the plan step) must NOT run
    expect(planner.contexts.length).toBe(0); // no wake reason fired (22% is below reflex's 25% but above wake's 20%)
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toContain("reflex_failed");
  });

  test("no reflex configured: identical to Plan-1 behavior, no reflex events", async () => {
    const { api } = makeApi(lowFuelDocked);
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const configNoReflex: AgentConfig = { ...baseConfig, reflex: undefined };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: configNoReflex, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(1);
    expect(store.recentEvents("a1", 10).map((e) => e.type)).not.toContain("reflex");
  });
});
