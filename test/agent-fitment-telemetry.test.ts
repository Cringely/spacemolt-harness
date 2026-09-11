import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

// Fitment fail-open telemetry (issues #757/#736).
//
// The module-fitment guard refuses only a PROVEN-absent module and lets an
// unreadable fit through, which is the right direction and is also invisible:
// from outside, "checked and allowed" and "could not check" look identical,
// and the second silently restores the whole waste the guard exists to stop
// (the scout's 204 doomed survey_system calls). One `fitment_unknown` event at
// the seam that knows makes the difference observable.
//
// Offline: fake api, MockPlanner, zero live traffic.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const BASE: StatusSnapshot = {
  credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

async function run(plan: Plan, status: StatusSnapshot) {
  let now = 0;
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  const store = new Store(":memory:");
  const agent = new Agent({
    id: "a1", persona: "p", api, store, planner: new MockPlanner([plan]), config, now: () => now,
  });
  now += 1_000; await agent.runOnce(); // no_plan -> replan, cursor at step 0
  now += 1_000; await agent.runOnce(); // the step runs
  const fitment = store.recentEvents("a1", 100_000).filter((e) => e.type === "fitment_unknown");
  return { calls, fitment };
}

describe("fitment fail-open telemetry", () => {
  // Catches a silent fail-open: the action reaches the game (correct) with no
  // record that the harness could not check it (the defect). Both halves are
  // asserted -- an event WITHOUT the call through would mean the guard blocked,
  // which is the opposite failure.
  test("an unreadable fit emits fitment_unknown and still lets the action through", async () => {
    const plan: Plan = { goal: "survey", steps: [{ action: "survey_system", params: {} }] };
    const { calls, fitment } = await run(plan, { ...BASE }); // modules omitted -> UNKNOWN
    expect(calls).toEqual(["survey_system"]);
    expect(fitment.length).toBe(1);
    expect(fitment[0]!.payload).toMatchObject({ action: "survey_system", module: "survey scanner" });
  });

  // Catches an event emitted on every gated step regardless of verdict, which
  // would make the stream useless as a fail-open signal -- the thing it exists
  // to be. A KNOWN fit is not an unknown one, whichever way the verdict lands.
  test("a readable fit emits nothing, whether it satisfies the requirement or not", async () => {
    const satisfied = await run(
      { goal: "survey", steps: [{ action: "survey_system", params: {} }] },
      { ...BASE, modules: [{ typeId: "survey_scanner_i", type: "scanner", stats: { survey_power: 9 } }] },
    );
    expect(satisfied.calls).toEqual(["survey_system"]);
    expect(satisfied.fitment.length).toBe(0);

    const absent = await run(
      { goal: "tow", steps: [{ action: "tow", params: { id: "wreck_1" } }] },
      { ...BASE, modules: [] },
    );
    expect(absent.calls).toEqual([]); // guard refused it
    expect(absent.fitment.length).toBe(0);
  });

  // Catches the event firing for every step in the plan. Only an action the
  // reference actually gates on a module has anything to be unknown about.
  test("an action with no module requirement emits nothing even on an unreadable fit", async () => {
    const plan: Plan = { goal: "dock", steps: [{ action: "dock", params: {} }] };
    const { calls, fitment } = await run(plan, { ...BASE });
    expect(calls).toEqual(["dock"]);
    expect(fitment.length).toBe(0);
  });
});
