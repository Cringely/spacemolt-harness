import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

function stubApi() {
  const calls: string[] = [];
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls, status };
}

const miningPlan: Plan = { goal: "mine a bit", steps: [
  { action: "mine", params: {}, repeat: 2 },
  { action: "dock", params: {} },
]};

function makeAgent(plans: Plan[]) {
  const { api, calls } = stubApi();
  const store = new Store(":memory:");
  const planner = new MockPlanner(plans);
  const agent = new Agent({
    id: "a1", persona: "test miner", api, store, planner, config, now: () => 1_000_000,
  });
  return { agent, store, planner, calls };
}

describe("Agent.runOnce", () => {
  test("no plan -> plans, then executes tick by tick to completion", async () => {
    const { agent, store, planner, calls } = makeAgent([miningPlan]);

    await agent.runOnce(); // wake: no_plan -> replan (no action yet)
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.wake.reason).toBe("no_plan");
    expect(store.loadPlan("a1")!.plan.goal).toBe("mine a bit");
    expect(calls.filter((c) => c !== "get_status" && c !== "get_notifications")).toEqual([]);

    await agent.runOnce(); // mine (iteration 1 of 2)
    await agent.runOnce(); // mine (iteration 2 of 2)
    await agent.runOnce(); // dock -> plan done
    const mutations = calls.filter((c) => c !== "get_status" && c !== "get_notifications");
    expect(mutations).toEqual(["mine", "mine", "dock"]);
    expect(store.loadPlan("a1")).toBeNull(); // done plan cleared

    await agent.runOnce(); // wake: plan_done -> replans (MockPlanner repeats last)
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts[1]!.wake.reason).toBe("plan_done");
  });

  test("cursor persists across restart (new Agent, same store)", async () => {
    const { api } = stubApi();
    const store = new Store(":memory:");
    const planner = new MockPlanner([miningPlan]);
    const a1 = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });
    await a1.runOnce(); // plan
    await a1.runOnce(); // mine 1/2
    expect(store.loadPlan("a1")!.cursor).toEqual({ step: 0, iteration: 1 });

    // "restart": fresh Agent instance on the same store resumes mid-plan
    const a2 = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 2 });
    await a2.runOnce();
    expect(store.loadPlan("a1")!.cursor).toEqual({ step: 1, iteration: 0 }); // mine done, dock next
  });

  test("instruction aborts plan and replans with instruction in context", async () => {
    const { agent, planner } = makeAgent([miningPlan, {
      goal: "obey", steps: [{ action: "undock", params: {} }],
    }]);
    await agent.runOnce(); // initial plan
    agent.instruct("stop mining, go explore");
    await agent.runOnce(); // instruction wake -> replan
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts[1]!.wake.reason).toBe("instruction");
    expect(planner.contexts[1]!.instruction).toBe("stop mining, go explore");
  });

  // Instruction supersession (issue #186, live 2026-07-13): every instruction
  // used to accrue into goals forever (until restart), so a stale steer could
  // outvote a newer contradicting one in the digest. The retained history is
  // now capped at the 5 most recent -- when the cap evicts, it evicts oldest.
  test("goal history keeps only the 5 most recent instructions, evicting oldest", async () => {
    let credits = 100;
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      // credits move every tick so the Layer-4 no-progress fingerprint differs
      // at each replan boundary -- this test is about the goal cap, not the
      // freeze detector, and a frozen fake status would arm Layer 4 at the
      // sixth identical boundary and swallow the last instruction.
      async status(): Promise<StatusSnapshot> {
        credits += 1;
        return { credits, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false };
      },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const planner = new MockPlanner([miningPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1_000_000 });
    await agent.runOnce(); // initial no_plan replan (no instruction, no goal)
    for (let i = 1; i <= 6; i++) {
      agent.instruct(`steer ${i}`);
      await agent.runOnce(); // instruction wake -> replan pushes the goal
    }
    const expected = ["steer 2", "steer 3", "steer 4", "steer 5", "steer 6"];
    expect(agent.snapshot().goals).toEqual(expected);
    // the capped, chronological list is what the planner actually saw on the
    // last replan (digest.ts reverses to newest-first at render time)
    expect(planner.contexts.at(-1)!.goals).toEqual(expected);
  });

  // Persisted-state check (issue #186): a stored goals list written BEFORE the
  // cap existed can exceed it. The loader trims to the newest 5 rather than
  // resurrecting the full stale archive -- and nothing tightens the schema
  // (goals stay a plain string[]), so an old artifact still loads.
  test("a persisted goals list longer than the cap loads trimmed to the newest 5", () => {
    const { api } = stubApi();
    const store = new Store(":memory:");
    store.savePlan("a1", miningPlan, ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"]);
    const agent = new Agent({
      id: "a1", persona: "p", api, store, planner: new MockPlanner([miningPlan]), config, now: () => 1,
    });
    expect(agent.snapshot().goals).toEqual(["g4", "g5", "g6", "g7", "g8"]);
  });

  test("emits wake, plan, and action events", async () => {
    const { agent, store } = makeAgent([miningPlan]);
    await agent.runOnce();
    await agent.runOnce();
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("wake");
    expect(types).toContain("plan");
    expect(types).toContain("action");
  });

  // SM-9 fix (live diagnosis 2026-07-11): 17 phantom "successful" sell steps
  // gave the operator/dashboard nothing to look at besides "outcome: continue"
  // repeated forever -- the game's own human-readable response text (the
  // envelope's `result` field) was captured nowhere. executeOne() (agent.ts)
  // now forwards executeTick's resultText (executor.ts) into every "action"
  // event's payload, not just blocked ones, since a future silent-failure
  // class won't necessarily surface as "blocked" either.
  test("action events carry a result-text snippet from the game's envelope", async () => {
    const { agent, store } = makeAgent([miningPlan]);
    await agent.runOnce(); // plan
    await agent.runOnce(); // mine 1/2 -> action event
    const actionEvent = store.recentEvents("a1", 50).find((e) => e.type === "action")!;
    expect((actionEvent.payload as { result?: string }).result).toBe("ok"); // stubApi's action() returns {result:"ok"}
  });

  test("statusSummary passed to the planner is a compact summary, not a JSON dump", async () => {
    const { agent, planner } = makeAgent([miningPlan]);
    await agent.runOnce();
    expect(planner.contexts[0]!.statusSummary).not.toContain("{");
    expect(planner.contexts[0]!.statusSummary).toContain("fuel");
  });

  // SM-6 fix: ctx.cargo is built from the same StatusSnapshot statusSummary
  // is built from (src/agent/agent.ts's replan()) -- not a second fetch.
  test("ctx.cargo is populated from status.cargoUsed/cargoCapacity/cargo", async () => {
    const store = new Store(":memory:");
    const planner = new MockPlanner([miningPlan]);
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() {
        return {
          credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 19, cargoCapacity: 50, docked: true, inTransit: false,
          cargo: [{ itemId: "gold_ore", name: "gold_ore", quantity: 19 }],
        };
      },
      async notifications() { return []; },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });
    await agent.runOnce();
    expect(planner.contexts[0]!.cargo).toEqual({
      used: 19, capacity: 50, items: [{ itemId: "gold_ore", name: "gold_ore", quantity: 19 }],
    });
  });

  // GameApi implementations that predate the SM-6 fix (or fakes/mocks in the
  // rest of the test suite) don't set StatusSnapshot.cargo at all -- ctx.cargo
  // should degrade to an empty items list, not throw on the missing field.
  test("ctx.cargo defaults items to [] when StatusSnapshot.cargo is absent", async () => {
    const { agent, planner } = makeAgent([miningPlan]);
    await agent.runOnce();
    expect(planner.contexts[0]!.cargo).toEqual({ used: 0, capacity: 50, items: [] });
  });

  // Broken-fuel-chain fix (issue #152): ctx.lowFuel is threaded from the same
  // StatusSnapshot statusSummary is built from. Without the thread, the
  // digest's fuel-id briefing can never fire -- a silent drop the digest's own
  // gating tests can't see (they receive the flag pre-set).
  test("ctx.lowFuel reflects fuel below/above the reserve threshold", async () => {
    const mk = (fuel: number) => {
      const store = new Store(":memory:");
      const planner = new MockPlanner([miningPlan]);
      const api: GameApi = {
        async action(): Promise<V2Result> { return { result: "ok" }; },
        async status() {
          return {
            credits: 100, fuel, maxFuel: 100, hull: 100, maxHull: 100,
            cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
          };
        },
        async notifications() { return []; },
      };
      const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });
      return { agent, planner };
    };
    const low = mk(10); // 10% of max, below the default 25% reserve
    await low.agent.runOnce();
    expect(low.planner.contexts[0]!.lowFuel).toBe(true);
    const high = mk(80); // comfortably above reserve
    await high.agent.runOnce();
    expect(high.planner.contexts[0]!.lowFuel).toBe(false);
  });

  test("planner failure emits planner_error without throwing", async () => {
    const { api } = stubApi();
    const store = new Store(":memory:");
    const failing = { plan: async () => { throw new Error("provider down"); } };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: failing, config, now: () => 1 });
    await agent.runOnce(); // must not throw
    const types = store.recentEvents("a1", 10).map((e) => e.type);
    expect(types).toContain("planner_error");
  });

  test("status() rejection emits status_error and does not throw", async () => {
    const { api } = stubApi();
    const store = new Store(":memory:");
    const planner = new MockPlanner([miningPlan]);
    const failingApi: GameApi = { ...api, status: async () => { throw new Error("status down"); } };
    const agent = new Agent({ id: "a1", persona: "p", api: failingApi, store, planner, config, now: () => 1 });
    await agent.runOnce(); // must not throw
    const events = store.recentEvents("a1", 10);
    const statusError = events.find((e) => e.type === "status_error");
    expect(statusError).toBeDefined();
    expect((statusError!.payload as { message: string }).message).toBe("status down");
  });
});

// SM-6 fix: cross-wake amnesia -- a wake with no cargo/status change (an
// instruction, a heartbeat) gave the planner zero memory of the outgoing
// plan. Agent.derivePreviousGoal (src/agent/agent.ts) derives completed from
// a "plan_done" wake, blocked from a "blocked" wake, and superseded from
// everything else -- these three tests exercise each branch via the same
// runOnce()/replan()/executeOne() flow the other Agent tests above use.
describe("Agent previousGoal wiring (SM-6)", () => {
  test("no outgoing plan (first-ever replan): previousGoal is undefined", async () => {
    const { agent, planner } = makeAgent([miningPlan]);
    await agent.runOnce(); // no_plan wake -> replan
    expect(planner.contexts[0]!.previousGoal).toBeUndefined();
  });

  test("plan_done wake: previousGoal is {goal, outcome: completed} (goal read via lastCompletedGoal, since this.plan is already null by replan time)", async () => {
    const { agent, planner } = makeAgent([miningPlan]);
    await agent.runOnce(); // plan
    await agent.runOnce(); // mine 1/2
    await agent.runOnce(); // mine 2/2
    await agent.runOnce(); // dock -> plan_done (this.plan nulled in executeOne)
    await agent.runOnce(); // plan_done wake -> replan; MockPlanner repeats last plan

    expect(planner.contexts[1]!.wake.reason).toBe("plan_done");
    expect(planner.contexts[1]!.previousGoal).toEqual({ goal: "mine a bit", outcome: "completed" });
  });

  test("blocked wake: previousGoal is {goal, outcome: blocked} (this.plan is still set -- executeOne's blocked branch never nulls it)", async () => {
    const status: StatusSnapshot = {
      credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { throw new SpacemoltError("command_error", "nothing to mine here"); },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const blockedPlan: Plan = { goal: "mine at a barren base", steps: [{ action: "mine", params: {} }] };
    const planner = new MockPlanner([blockedPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan A
    await agent.runOnce(); // A's step blocks
    await agent.runOnce(); // blocked wake, streak=1 (below F-3's threshold=3) -> replan B

    expect(planner.contexts[1]!.wake.reason).toBe("blocked");
    expect(planner.contexts[1]!.previousGoal).toEqual({ goal: "mine at a barren base", outcome: "blocked" });
  });

  test("instruction wake (a 'superseded' reason): previousGoal is {goal, outcome: superseded}", async () => {
    const { agent, planner } = makeAgent([miningPlan, {
      goal: "obey", steps: [{ action: "undock", params: {} }],
    }]);
    await agent.runOnce(); // initial plan, still running (only 1 of 2 mine iterations would have executed by now -- none, since this is the plan itself)
    agent.instruct("stop mining, go explore");
    await agent.runOnce(); // instruction wake -> replan; outgoing plan ("mine a bit") never finished or blocked

    expect(planner.contexts[1]!.wake.reason).toBe("instruction");
    expect(planner.contexts[1]!.previousGoal).toEqual({ goal: "mine a bit", outcome: "superseded" });
  });

  // Review-caught regression (not hypothetical): evaluateWake (src/agent/
  // wake.ts) checks `instruction` before `planState`, so an operator
  // instruction landing in the inbox right after a plan finishes -- but
  // before the next tick evaluates the resulting "plan_done" wake -- makes
  // that next wake come back "instruction", not "plan_done". instruct() is
  // called from outside the 10s tick loop (dashboard/operator input), so this
  // ordering is reachable in production, not a contrived edge case. An
  // earlier version of derivePreviousGoal gated on wake.reason ===
  // "plan_done" specifically and silently dropped the just-completed goal in
  // this race; derivePreviousGoal now branches on `this.plan` truthiness
  // first, so a null this.plan falls back to lastCompletedGoal regardless of
  // which wake reason got there first.
  test("an instruction racing ahead of the plan_done wake still reports the just-completed goal, not superseded/undefined", async () => {
    const { agent, planner } = makeAgent([miningPlan, {
      goal: "obey", steps: [{ action: "undock", params: {} }],
    }]);
    await agent.runOnce(); // plan
    await agent.runOnce(); // mine 1/2
    await agent.runOnce(); // mine 2/2
    await agent.runOnce(); // dock -> plan_done (this.plan nulled, lastCompletedGoal set)
    agent.instruct("go refuel"); // arrives before the next tick sees "plan_done"
    await agent.runOnce(); // wake comes back "instruction" (evaluateWake checks it first), not "plan_done"

    expect(planner.contexts[1]!.wake.reason).toBe("instruction");
    expect(planner.contexts[1]!.previousGoal).toEqual({ goal: "mine a bit", outcome: "completed" });
  });
});

describe("Agent.start/stop", () => {
  test("running guard serializes overlapping ticks; stop() halts the loop", async () => {
    const store = new Store(":memory:");
    const planner = new MockPlanner([miningPlan]);
    let inFlight = 0;
    let maxInFlight = 0;
    let statusCalls = 0;
    const api: GameApi = {
      async action() { return { result: "ok" }; },
      async status() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        statusCalls++;
        await new Promise((r) => setTimeout(r, 30)); // slower than the tick interval below
        inFlight--;
        return { credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100, cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false };
      },
      async notifications() { return []; },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config });

    agent.start(10); // interval shorter than status()'s 30ms, so ticks would overlap without the guard
    await new Promise((r) => setTimeout(r, 100));
    agent.stop();
    expect(maxInFlight).toBe(1); // guard prevented a second tick from starting while one was in flight

    const callsAtStop = statusCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(statusCalls).toBe(callsAtStop); // no further ticks fired after stop()
  });
});
