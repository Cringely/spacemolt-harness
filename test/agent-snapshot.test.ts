import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { TransientPlannerError } from "../src/planner/errors";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner } from "../src/planner/types";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 2, subscriptionCooldownMinutes: 60,
};

function stubApi(status?: StatusSnapshot): GameApi {
  const s: StatusSnapshot = status ?? {
    credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return s; },
    async notifications() { return []; },
  };
}

const alwaysThrows = (err: Error): Planner => ({ plan: async () => { throw err; } });

describe("Agent.snapshot", () => {
  test("reports none/no-plan state and zeroed planner health before any wake", () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    const snap = agent.snapshot();
    expect(snap.id).toBe("a1");
    expect(snap.planState).toBe("none");
    expect(snap.goal).toBeUndefined();
    expect(snap.plannerHealth).toEqual({
      stalled: false, usingFallback: false, claudeDisabled: false,
      backoffUntil: 0, consecutiveTransientFailures: 0, stuck: false,
    });
  });

  test("reports goal/step/total mid-plan", async () => {
    const store = new Store(":memory:");
    // repeat: 2 keeps the plan "running" (not plan_done) after exactly one
    // executeOne() tick, so the assertion below observes a stable mid-plan
    // cursor {step: 0, iteration: 1} instead of a state that flips to "done"
    // on the same tick (see src/agent/executor.ts's advance()).
    const plan: Plan = { goal: "mine a bit", steps: [
      { action: "mine", params: {}, repeat: 2 },
      { action: "dock", params: {} },
    ]};
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([plan]), config, now: () => 0,
    });
    await agent.runOnce(); // wake: no_plan -> replan (cursor {0,0}, no tick executed)
    await agent.runOnce(); // executeOne: mine iteration 1 of 2 (cursor {0,1}, step index unchanged)
    const snap = agent.snapshot();
    expect(snap.planState).toBe("running");
    expect(snap.goal).toBe("mine a bit");
    expect(snap.stepIndex).toBe(0);
    expect(snap.totalSteps).toBe(2);
  });

  test("surfaces the sticky planner-health flags (backoff, then stalled)", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("down")),
      config, now: () => now,
    });
    await agent.runOnce(); // no_plan wake -> replan -> transient failure #1
    let snap = agent.snapshot();
    expect(snap.plannerHealth.consecutiveTransientFailures).toBe(1);
    expect(snap.plannerHealth.backoffUntil).toBeGreaterThan(0);
    expect(snap.plannerHealth.stalled).toBe(false);

    // Clear the transient backoff (src/agent/agent.ts's
    // TRANSIENT_BACKOFF_BASE_MS, 30s base) so the next tick replans.
    // Note: the heartbeat check is NOT in play here -- planState stays
    // "none" after a failed replan, so evaluateWake returns no_plan
    // (wake.ts:32) before the heartbeatMs branch is ever reached.
    now += 15 * 60_000 + 1;
    await agent.runOnce(); // failure #2 -> reaches stallThreshold (2, configured above)
    snap = agent.snapshot();
    expect(snap.plannerHealth.stalled).toBe(true);
  });

  test("exposes only fields with a dashboard consumer -- no inbox, no internal thrash counters", () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    const snap = agent.snapshot();
    expect(Object.keys(snap).sort()).toEqual(
      ["blockedReason", "goal", "goals", "id", "planState", "plannerHealth", "status", "stepIndex", "totalSteps"].sort(),
    );
    expect(Object.keys(snap.plannerHealth).sort()).toEqual(
      ["backoffUntil", "claudeDisabled", "consecutiveTransientFailures", "stalled", "stuck", "usingFallback"].sort(),
    );
  });

  test("status is null before the first fetch, then exposes the retained ship vitals", async () => {
    const store = new Store(":memory:");
    const status: StatusSnapshot = {
      credits: 4200, fuel: 40, maxFuel: 100, hull: 75, maxHull: 100,
      cargoUsed: 12, cargoCapacity: 50, docked: true, inTransit: false,
      systemId: "commerce_fields",
      cargo: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 12 }],
    };
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(status), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    // Null until runOnce() has actually fetched status at least once.
    expect(agent.snapshot().status).toBeNull();

    await agent.runOnce(); // fetches status, retains it, then replans
    expect(agent.snapshot().status).toEqual({
      credits: 4200, system: "commerce_fields", docked: true, inTransit: false,
      fuel: 40, maxFuel: 100, hull: 75, maxHull: 100,
      cargoUsed: 12, cargoCapacity: 50,
      cargo: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 12 }],
    });
  });

  // Ship-details panel (operator request 2026-07-17): the dashboard's SHIP
  // card renders identity/fit/modules off /api/agents, which serves exactly
  // this snapshot -- if these stop flowing through, the panel silently
  // regresses to vitals-only.
  test("status exposes ship identity, fitting grid and modules when the loop retained them", async () => {
    const store = new Store(":memory:");
    const status: StatusSnapshot = {
      credits: 10, fuel: 80, maxFuel: 100, hull: 95, maxHull: 95,
      cargoUsed: 0, cargoCapacity: 100, docked: true, inTransit: false,
      shipName: "Prospect", shipClass: "Prospect",
      fit: { cpuUsed: 2, cpuCapacity: 13, powerUsed: 5, powerCapacity: 26,
             slots: { weapon: 1, defense: 1, utility: 2 } },
      modules: [{ typeId: "mining_laser_i", type: "mining", miningPower: 5, slot: "utility", name: "Mining Laser I" }],
    };
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(status), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    await agent.runOnce();
    const st = agent.snapshot().status!;
    expect(st.shipName).toBe("Prospect");
    expect(st.shipClass).toBe("Prospect");
    expect(st.fit).toEqual(status.fit!);
    expect(st.modules).toEqual(status.modules!);
  });

  // The inverse: a StatusSnapshot predating the ship-details fields (the
  // default stub omits all four) still snapshots cleanly, with the fields
  // absent rather than fabricated -- the dashboard then skips those sections.
  test("status leaves ship identity/fit/modules undefined when the fetch never carried them", async () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    await agent.runOnce();
    const st = agent.snapshot().status!;
    expect(st.shipName).toBeUndefined();
    expect(st.shipClass).toBeUndefined();
    expect(st.fit).toBeUndefined();
    expect(st.modules).toBeUndefined();
  });

  test("status maps a missing systemId to null and a missing cargo[] to []", async () => {
    const store = new Store(":memory:");
    // The default stub omits systemId and cargo (the common minimal shape).
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    await agent.runOnce();
    const st = agent.snapshot().status!;
    expect(st.system).toBeNull();
    expect(st.cargo).toEqual([]);
  });

  test("a failed status fetch keeps the last good telemetry rather than blanking it", async () => {
    const store = new Store(":memory:");
    let fail = false;
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status(): Promise<StatusSnapshot> {
        if (fail) throw new Error("network down");
        return {
          credits: 100, fuel: 55, maxFuel: 100, hull: 90, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
    };
    const agent = new Agent({
      id: "a1", persona: "p", api, store,
      planner: new MockPlanner([
        { goal: "g", steps: [{ action: "undock", params: {} }] },
        { goal: "h", steps: [{ action: "dock", params: {} }] },
      ]),
      config, now: () => 0,
    });
    await agent.runOnce(); // good fetch -> retained
    expect(agent.snapshot().status!.fuel).toBe(55);
    fail = true;
    await agent.runOnce(); // status() throws -> lastStatus unchanged
    expect(agent.snapshot().status!.fuel).toBe(55);
  });
});
