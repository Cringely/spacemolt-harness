import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

// distress_signal cooldown guard (tracker Cringely/spacemolt#792: 43 corsair +
// 24 scout failed retries in one window, "cooldown: Distress signal on
// cooldown. Try again in Nm0s." and "already_active"). missions.md:70: "one
// active distress signal at a time, a 1-hour cooldown between calls". Nothing
// in get_status says a signal is out, so the memory is this agent's own
// event stream: a distress_signal that SUCCEEDED (or the strand steward's
// direct one) starts a one-hour window in which the executor refuses another
// before the call. Exercised through Agent, not just the executor, because the
// risk lives in the seam: whether agent.ts reads the right events and
// converts them to the minutes the executor consumes.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 600, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const MIN = 60_000;

// Undocked, because distress_signal "cannot be used while docked".
const status: StatusSnapshot = {
  credits: 500, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

function makeApi(): { api: GameApi; calls: string[] } {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

const sos: Plan = { goal: "call for rescue", steps: [{ action: "distress_signal", params: { distress_type: "fuel" } }] };

function build(now: () => number, store = new Store(":memory:")) {
  const { api, calls } = makeApi();
  const agent = new Agent({ id: "a1", persona: "p", api, store, planner: new MockPlanner([sos]), config, now });
  return { agent, calls, store };
}

describe("Agent distress_signal cooldown guard (#792)", () => {
  test("a second distress_signal inside the hour is refused before the game, in prose", async () => {
    let now = 1_000;
    const { agent, calls, store } = build(() => now);

    await agent.runOnce(); // no_plan -> replan
    await agent.runOnce(); // distress_signal #1 reaches the game and succeeds
    now += 10 * MIN;
    await agent.runOnce(); // plan_done -> replan
    await agent.runOnce(); // distress_signal #2: inside the cooldown

    expect(calls).toEqual(["distress_signal"]); // exactly one live call
    const refused = store.recentEvents("a1", 50)
      .filter((e) => e.type === "action")
      .map((e) => e.payload as { action: string; outcome: string; guard?: boolean; result: string })
      .filter((p) => p.action === "distress_signal" && p.outcome === "blocked");
    expect(refused.length).toBe(1);
    expect(refused[0]!.guard).toBe(true);
    expect(refused[0]!.result).toContain("50 minutes"); // 60 - 10 elapsed
    expect(refused[0]!.result).not.toMatch(/\w+\{/); // #1116: prose, no resubmittable call
  });

  test("the window ends an hour after the call, and a refused attempt does not slide it", async () => {
    let now = 1_000;
    const { agent, calls } = build(() => now);

    await agent.runOnce(); // replan
    await agent.runOnce(); // call #1 at t=1s
    now += 30 * MIN;
    await agent.runOnce(); // plan_done -> replan
    await agent.runOnce(); // refused at +30m (must NOT restart the clock)
    await agent.runOnce(); // blocked -> replan
    now += 31 * MIN; // +61m from the real call, +31m from the refusal
    await agent.runOnce(); // the step runs again: window over

    expect(calls).toEqual(["distress_signal", "distress_signal"]);
  });

  test("the strand steward's own distress call counts toward the cooldown", async () => {
    const now = 5 * MIN;
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 2 * MIN, type: "steward_distress", payload: { distress_type: "fuel" } });
    const { agent, calls } = build(() => now, store);

    await agent.runOnce(); // replan
    await agent.runOnce(); // planner's distress_signal: refused, the steward already sent one

    expect(calls).toEqual([]);
  });

  test("a distress_signal the game REFUSED does not start a cooldown", async () => {
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        calls.push(name);
        throw new SpacemoltError("command_error", "not_undocked: no");
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: new MockPlanner([sos]), config, now: () => 1_000 });
    await agent.runOnce(); // replan
    await agent.runOnce(); // call #1: game error
    await agent.runOnce(); // blocked -> replan
    await agent.runOnce(); // call #2: nothing proves a signal is out, so it reaches the game
    expect(calls.length).toBe(2);
  });
});
