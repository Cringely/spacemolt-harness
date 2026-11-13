import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Steer lifecycle (Cringely/spacemolt#535, #542, #821). The goals list is the
// operator's steer channel; these tests pin how a steer ENTERS it (supersedes
// the one before), LEAVES it (a one-shot destructive order, once spent), and
// how the standing config goals ride it (restored without churn).

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};
const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

function stubApi() {
  const actions: string[] = [];
  const status: StatusSnapshot = {
    credits: 1000, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, dockedAt: null, cargo: [],
  };
  const api: GameApi = {
    async action(name: string): Promise<V2Result> { actions.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, actions };
}

describe("superseding steers (#535)", () => {
  // Breakage caught: the live #535 capture -- three "jump and spend fuel"
  // steers and the "do NOT jump" correction sat in goals[] together, because
  // retirement depended on the planner reporting each one done. A newer
  // unpinned steer must replace the older unpinned ones outright.
  test("a newer steer retires the older contradictory steers", async () => {
    const agent = new Agent({
      id: "m1", persona: "p", api: stubApi().api, store: new Store(":memory:"),
      planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    agent.instruct("jump to minkar and spend the fuel");
    await agent.runOnce();
    agent.instruct("CORRECTION: do NOT jump, hold position");
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual(["CORRECTION: do NOT jump, hold position"]);
  });

  // Breakage caught: over-reach. Supersede is for operator errands only. A
  // config goal (agents.yaml) and a pinned "standing until revoked" rule
  // (#817) are not contradicted by a newer errand and must survive it.
  test("config goals and pinned rules survive a newer steer", async () => {
    const agent = new Agent({
      id: "m1", persona: "p", goals: ["MILESTONE"], api: stubApi().api, store: new Store(":memory:"),
      planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    agent.instruct("RULE: keep 10 fuel in reserve", { standing: true });
    await agent.runOnce();
    agent.instruct("errand one");
    await agent.runOnce();
    agent.instruct("errand two");
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual(["MILESTONE", "RULE: keep 10 fuel in reserve", "errand two"]);
  });

  // Breakage caught: the pin is a property of the NEWEST steer too. A pinned
  // steer is additive (it never retires an errand), so one standing rule sent
  // after an errand must not erase it.
  test("a pinned steer does not supersede anything", async () => {
    const agent = new Agent({
      id: "m1", persona: "p", api: stubApi().api, store: new Store(":memory:"),
      planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    agent.instruct("errand one");
    await agent.runOnce();
    agent.instruct("RULE: keep 10 fuel in reserve", { standing: true });
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual(["errand one", "RULE: keep 10 fuel in reserve"]);
  });
});
