import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner, PlanContext } from "../src/planner/types";
import { TransientPlannerError } from "../src/planner/errors";

// maxPlansPerWindow is set high so the Layer 3 ceiling (a coarser guard) never
// fires before Layer 4's NO_PROGRESS_REPLANS=6 threshold -- these tests isolate
// the no-progress detector.
const baseConfig: AgentConfig = {
  fuelPct: 25, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  maxPlansPerWindow: 1000, planBudgetWindowMinutes: 60,
};

// Layer 4 (no-progress detector). The low_fuel livelock shape: a wake fires
// every tick and replans, resetting the cursor to 0, so executeOne never runs
// and the game state never changes -- an identical fingerprint every replan
// boundary. After NO_PROGRESS_REPLANS the detector must arm backoff, flag the
// agent stuck, emit operator_alert{no_progress}, and STOP calling the planner.
describe("Layer 4: no-progress detector", () => {
  test("frozen fingerprint -> operator_alert{no_progress}, stuck flag, and planner calls stop under backoff", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };

    // Frozen low-fuel state, plan carries no refuel -> low_fuel wakes every tick
    // and replans, which resets the cursor and re-preempts executeOne forever.
    const status: StatusSnapshot = {
      credits: 100, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId: "s1",
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const runawayPlan: Plan = { goal: "mine forever", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    store.savePlan("a1", runawayPlan, []);
    const planner = new MockPlanner([runawayPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: { ...baseConfig, fuelPct: 20 }, now: () => now });

    for (let i = 0; i < 6; i++) await tick(agent);

    const alerts = store.recentEvents("a1", 10_000).filter((e) => e.type === "operator_alert");
    expect(alerts.length).toBe(1);
    expect((alerts[0]!.payload as { class: string }).class).toBe("no_progress");
    expect((alerts[0]!.payload as { replans: number }).replans).toBe(6);
    expect(agent.snapshot().plannerHealth.stuck).toBe(true);

    // Calls plateau: the arming tick did not replan, and backoff (heartbeat
    // cadence) suppresses every subsequent tick. Drive well past the alert and
    // confirm the planner is not called again.
    const callsAtAlert = planner.contexts.length;
    for (let i = 0; i < 20; i++) await tick(agent);
    expect(planner.contexts.length).toBe(callsAtAlert);
    // Exactly one alert -- the reset-after-arm means it does not re-fire every
    // tick while backoff holds.
    expect(store.recentEvents("a1", 10_000).filter((e) => e.type === "operator_alert").length).toBe(1);
  });

  // Ablation for the freeze the string-keyed thrash damper CANNOT catch: a
  // plan_done loop that reruns to completion every cycle with DIFFERENT goal
  // text (the planner rewords the goal each replan) while game state stays
  // frozen. The damper keys on the goal string -> a varying key never builds a
  // streak -> it never arms. Layer 4 keys on game state + cursor.step (goal
  // text excluded), so the frozen fingerprint accumulates across the 6 replan
  // boundaries and Layer 4 arms as the backstop. This test FAILS on the earlier
  // revision that excluded plan_done from Layer 4 (no alert ever) and passes now.
  test("phantom-progress: plan_done loop with reworded goals but frozen game state trips Layer 4 (damper can't)", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };

    // Frozen, healthy status: healthy fuel/hull so no low_fuel/low_hull wake
    // intrudes -- the only wakes are no_plan then plan_done, and game state
    // never moves.
    const status: StatusSnapshot = {
      credits: 304, fuel: 90, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 12, cargoCapacity: 50, docked: true, inTransit: false, systemId: "s1",
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; }, // dock "succeeds" -> plan_done
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    // Each replan gets a freshly-reworded goal -> the damper's goal-key streak
    // never builds; single dock step so the plan completes to plan_done each cycle.
    let i = 0;
    const planner: Planner = {
      async plan(_ctx: PlanContext) {
        const goal = `sell all cargo (attempt ${i++})`;
        return { plan: { goal, steps: [{ action: "dock", params: {} }] }, promptChars: 0, responseChars: 0 };
      },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => now });

    for (let t = 0; t < 12; t++) await tick(agent);

    const events = store.recentEvents("a1", 10_000);
    const alerts = events.filter((e) => e.type === "operator_alert");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect((alerts[0]!.payload as { class: string }).class).toBe("no_progress");
    expect(agent.snapshot().plannerHealth.stuck).toBe(true);
    // The damper genuinely could not catch this (varying goal key) -- Layer 4
    // is the sole line of defense here.
    expect(events.filter((e) => e.type === "plan_thrash_backoff").length).toBe(0);
  });

  // The counterpart arm: real progress (cargoUsed climbing each replan boundary)
  // yields a DIFFERENT fingerprint every time, so the detector must never arm --
  // no alert, stuck stays false, and replanning proceeds unthrottled.
  test("changing fingerprint (cargoUsed increments) never trips the detector", async () => {
    let now = 0;
    let cargo = 0;
    const tick = async (agent: Agent) => { now += 1_000; cargo += 1; await agent.runOnce(); };

    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      // Low fuel keeps a wake firing every tick (so we exercise the replan
      // boundary), but cargoUsed advances so the fingerprint differs each time.
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 100, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: cargo, cargoCapacity: 5000, docked: false, inTransit: false, systemId: "s1",
        };
      },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const plan: Plan = { goal: "mine forever", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    store.savePlan("a1", plan, []);
    const planner = new MockPlanner([plan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: { ...baseConfig, fuelPct: 20 }, now: () => now });

    for (let i = 0; i < 15; i++) await tick(agent);

    expect(store.recentEvents("a1", 10_000).filter((e) => e.type === "operator_alert").length).toBe(0);
    expect(agent.snapshot().plannerHealth.stuck).toBe(false);
    // Replans proceeded every tick -- the planner was called once per tick.
    expect(planner.contexts.length).toBe(15);
  });

  // Compatibility with the executor's `wait` outcome (a ship in transit holds
  // its step, emitting no wake and no replan). The detector fingerprints at
  // REPLAN boundaries only, so a long transit -- many wait ticks, zero replans
  // -- must NOT accumulate toward the no-progress threshold and must never
  // false-trigger, even though the game state is legitimately "frozen" while the
  // ship flies.
  test("a long run of wait outcomes (no replans) does not trip the detector", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };

    // Healthy fuel/hull (no low_fuel/low_hull wake), inTransit true so the
    // executor returns `wait` and holds the step -- no wake, no replan.
    const status: StatusSnapshot = {
      credits: 100, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: true, systemId: "s1",
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    // A running plan whose current step is a normal mutation; the inTransit
    // guard in executeTick holds it as `wait` every tick.
    store.savePlan("a1", { goal: "go mine", steps: [{ action: "mine", params: {}, until: "cargo_full" }] }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => now });

    for (let i = 0; i < 50; i++) await tick(agent);

    // No wake ever fired (heartbeat not reached, fuel/hull healthy), so no
    // replan and no fingerprinting -- the detector stayed dormant.
    expect(store.recentEvents("a1", 10_000).filter((e) => e.type === "operator_alert").length).toBe(0);
    expect(agent.snapshot().plannerHealth.stuck).toBe(false);
    expect(planner.contexts.length).toBe(0); // planner never called during transit
    // The step was held, not advanced -- confirms the wait path was exercised.
    const actions = store.recentEvents("a1", 10_000).filter((e) => e.type === "action");
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((e) => (e.payload as { outcome: string }).outcome === "wait")).toBe(true);
  });
});

// status_snapshot (Layer 5): a lightweight game-state sample emitted on each
// wake from the status already fetched at tick start (no extra get_status).
describe("status_snapshot event", () => {
  test("emits credits/fuel/hull/cargoUsed/systemId on a wake", async () => {
    const status: StatusSnapshot = {
      credits: 512, fuel: 88, maxFuel: 100, hull: 91, maxHull: 100,
      cargoUsed: 17, cargoCapacity: 50, docked: true, inTransit: false, systemId: "sol",
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    // No plan -> a no_plan wake fires on the first tick.
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();

    const snaps = store.recentEvents("a1", 100).filter((e) => e.type === "status_snapshot");
    expect(snaps.length).toBe(1);
    expect(snaps[0]!.payload).toEqual({
      credits: 512, fuel: 88, hull: 91, cargoUsed: 17, systemId: "sol",
    });
  });

  test("is skipped when the status fetch failed (no phantom point in the series)", async () => {
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status(): Promise<StatusSnapshot> { throw new Error("status boom"); },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce(); // no_plan wake fires, but status is null

    expect(store.recentEvents("a1", 100).filter((e) => e.type === "status_snapshot").length).toBe(0);
  });

  // SM-10 throttle wired end-to-end through the loop. A throwing planner keeps
  // planState "none", so a no_plan wake fires every tick and the snapshot emit
  // path runs every tick -- exactly the parked-idle-ship case the throttle is
  // for. This catches a wiring regression the pure snapshot-throttle test
  // can't: if the loop stopped recording throttle state (or reverted to
  // per-tick emission), an unchanged idle ship would emit on every tick again.
  test("throttles idle snapshots in the loop: first emits, unchanged within 60s skips, change and 60s-elapsed re-emit", async () => {
    const status: StatusSnapshot = {
      credits: 512, fuel: 88, maxFuel: 100, hull: 91, maxHull: 100,
      cargoUsed: 17, cargoCapacity: 50, docked: true, inTransit: false, systemId: "sol",
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    // Planner always throws -> planState stays "none" -> a no_plan wake every
    // tick, so the throttle (not wake absence) is what suppresses snapshots.
    const throwingPlanner: Planner = {
      async plan() { throw new TransientPlannerError("no planner in this test"); },
    };
    let now = 1_000;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: throwingPlanner, config: baseConfig, now: () => now });
    const snaps = () => store.recentEvents("a1", 200).filter((e) => e.type === "status_snapshot");

    await agent.runOnce();                       // first ever snapshot -> emits
    expect(snaps().length).toBe(1);

    now = 31_000;                                // +30s, nothing changed
    await agent.runOnce();
    expect(snaps().length).toBe(1);              // within 60s floor -> skipped

    now = 41_000; status.credits = 999;          // +10s but credits moved
    await agent.runOnce();
    expect(snaps().length).toBe(2);              // salient change -> emits now

    now = 101_500;                               // >60s since last emit, unchanged
    await agent.runOnce();
    expect(snaps().length).toBe(3);              // cadence floor -> emits again
  });
});
