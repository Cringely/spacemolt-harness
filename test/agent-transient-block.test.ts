import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { executeTick } from "../src/agent/executor";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

// SM-10/SM-11 fix (live diagnosis 2026-07-11): with low_fuel gone, ALL of the
// miner's wakes were `blocked` -- "Another action is already in progress for
// this player", "Your ship is mid-travel to <X> (~10s until arrival)", and
// (SM-11) "Your ship is mid-JUMP to Ross 128 ... resubmit this command". Each
// such block replanned (an LLM call) instead of waiting one ~10s tick for the
// prior action to resolve. The executor now holds the current step while the
// ship is inTransit (the general flag guard) or on a transient block message
// (classifyGameError), and only escalates terminal blocks. These tests catch a
// regression in either direction: a transient block/state that wrongly
// replans (the bug), OR a widened transient match that wrongly swallows a
// terminal block (would strand the agent holding a step that can never
// succeed).

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const status: StatusSnapshot = {
  credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

describe("Agent transient-block hold-and-retry (SM-10/SM-11)", () => {
  // SM-11 live miss, at the loop level: a `mine` step issued while the ship is
  // mid-jump must be held (no mutation, no replan) until inTransit clears, then
  // execute. This is the integration counterpart to the executeTick unit guard
  // -- it fails if the wait result ever reaches the loop as anything that
  // advances the cursor or triggers a replan.
  test("mine issued mid-jump is held (no mutation, no replan) until inTransit clears, then runs", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    let inTransit = true;
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
      async status(): Promise<StatusSnapshot> { return { ...status, systemId: "ross_128", inTransit }; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const plan: Plan = { goal: "mine at ross 128", steps: [{ action: "mine", params: {} }] };
    const planner = new MockPlanner([plan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1). cursor step 0.
    expect(planner.contexts.length).toBe(1);

    await tick(agent); // mid-jump: mine held (wait), not issued
    await tick(agent); // still mid-jump: held again
    expect(calls).toEqual([]);                          // mine never issued while in transit
    expect(planner.contexts.length).toBe(1);            // no replan across the hold
    expect(agent.snapshot().planState).toBe("running");
    expect(agent.snapshot().stepIndex).toBe(0);         // held on step 0

    inTransit = false; // the jump completes
    await tick(agent); // mine now runs -> plan_done
    expect(calls).toEqual(["mine"]);                    // exactly one mutation, only after arrival
    expect(planner.contexts.length).toBe(1);            // completing the step is not a replan
    expect(agent.snapshot().planState).toBe("done");
  });


  test("a transient block holds the SAME step and retries next tick without invoking the planner; terminal blocks still replan", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };

    // `undock` is transiently blocked on its first attempt (prior tick's action
    // still resolving), then succeeds. Everything else succeeds.
    const calls: string[] = [];
    let undockAttempts = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        calls.push(name);
        if (name === "undock") {
          undockAttempts++;
          if (undockAttempts === 1) {
            throw new SpacemoltError("command_error", "Another action is already in progress for this player");
          }
        }
        return { result: "ok" };
      },
      // Ship is docked, so the undock precondition guard passes and undock is
      // genuinely attempted (then transiently blocked) -- this test exercises
      // the transient-block hold, not the not-docked no-op guard.
      async status() { return { ...status, docked: true }; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const plan: Plan = { goal: "leave the base", steps: [
      { action: "undock", params: {} },
      { action: "dock", params: {} },
    ]};
    const planner = new MockPlanner([plan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (planner call 1). cursor step 0.
    expect(planner.contexts.length).toBe(1);

    await tick(agent); // executeOne step 0: undock TRANSIENTLY blocked -> wait (held)
    expect(planner.contexts.length).toBe(1);              // NOT replanned
    expect(agent.snapshot().planState).toBe("running");   // not "blocked"
    expect(agent.snapshot().stepIndex).toBe(0);           // cursor held on step 0

    await tick(agent); // executeOne step 0 again: undock now succeeds -> advance to step 1
    expect(planner.contexts.length).toBe(1);              // still no LLM call across the whole hold
    expect(agent.snapshot().stepIndex).toBe(1);           // advanced only after the real success
    expect(calls.filter((c) => c === "undock").length).toBe(2); // SAME step retried, not skipped

    const events = store.recentEvents("a1", 100).map((e) => e.type);
    expect(events.filter((t) => t === "wake").length).toBe(1); // only the initial no_plan wake -> one replan total
  });

  test("a terminal block (not in the transient allowlist) still escalates to a blocked wake and replan", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const api: GameApi = {
      async action(): Promise<V2Result> { throw new SpacemoltError("command_error", "nothing to mine here"); },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const plan: Plan = { goal: "mine", steps: [{ action: "mine", params: {} }] };
    const planner = new MockPlanner([plan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // mine TERMINALLY blocks
    expect(agent.snapshot().planState).toBe("blocked");
    await tick(agent); // blocked wake -> replan (2)
    expect(planner.contexts.length).toBe(2); // terminal path unchanged: it replans
  });
  test("a transient block that NEVER clears is bounded by the heartbeat wake: held with zero replans, then escalated once now - lastPlanAt > heartbeatMs", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const api: GameApi = {
      // Always transiently blocked -- models the safety-critical case: a
      // "transient" match that in fact never resolves. Without the heartbeat
      // backstop this is a silent freeze (step held forever, zero tokens, no
      // visible escalation) -- the exact failure this batch exists to prevent.
      async action(): Promise<V2Result> {
        throw new SpacemoltError("command_error", "Another action is already in progress for this player");
      },
      // Docked so the undock precondition guard passes and undock is genuinely
      // attempted every tick (then transiently blocked), modelling a transient
      // match that never resolves -- not the not-docked no-op path.
      async status() { return { ...status, docked: true }; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const plan: Plan = { goal: "undock and go", steps: [{ action: "undock", params: {} }] };
    const planner = new MockPlanner([plan]); // repeats the same plan forever
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1). lastPlanAt = now.
    expect(planner.contexts.length).toBe(1);

    // Hold for many ticks well inside the heartbeat window: every tick the step
    // transiently blocks -> wait -> held, and NOTHING replans.
    for (let n = 0; n < 20; n++) await tick(agent);
    expect(planner.contexts.length).toBe(1);            // zero replans across the whole hold
    expect(agent.snapshot().planState).toBe("running"); // never latched to "blocked"
    expect(agent.snapshot().stepIndex).toBe(0);         // still held on step 0

    // Cross the heartbeat boundary: now the frozen lastPlanAt makes
    // now - lastPlanAt > heartbeatMs, so a `heartbeat` wake fires and replans.
    // If someone writes lastPlanAt on the wait path (or otherwise defeats the
    // escalation), this boundary never trips and the assertion fails.
    now += config.heartbeatMinutes * 60_000;
    await tick(agent);
    expect(planner.contexts.length).toBe(2);            // heartbeat escalated the frozen hold
    const wakes = store.recentEvents("a1", 200).filter((e) => e.type === "wake");
    expect((wakes.at(-1)!.payload as { reason: string }).reason).toBe("heartbeat");
  });
});

describe("executeTick transient guard (SM-10/SM-11)", () => {
  function inTransitApi(calls: string[]): GameApi {
    return {
      async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
      async status(): Promise<StatusSnapshot> {
        return { ...status, systemId: "sys-1", inTransit: true }; // between locations
      },
      async notifications() { return []; },
    };
  }

  test("travel_to holds on the authoritative inTransit flag instead of issuing a doomed jump", async () => {
    const calls: string[] = [];
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-3" } }] };
    const r = await executeTick(inTransitApi(calls), plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("wait");
    expect(calls).toEqual([]); // no find_route, no jump while in transit
  });

  // SM-11 core fix: the live miss was a NON-travel step (`mine`) issued while
  // the ship was mid-jump. travel_to had a guard; mine didn't, so it fell
  // through to the action, ate the transient block, and replanned. The general
  // pre-step inTransit guard now holds ANY step while in transit -- flag-based,
  // no prose. This test fails if the guard is ever narrowed back to travel_to.
  test("a NON-travel step (mine) is held while inTransit, never issuing the mutation", async () => {
    const calls: string[] = [];
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {} }] };
    const r = await executeTick(inTransitApi(calls), plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("wait");
    expect(calls).toEqual([]); // mine never issued while the ship is mid-jump
  });

  // SM-11 prose fallback: even if a transient block reaches the catch site
  // (flag not set, or a movement variant the flag doesn't cover), the game's
  // canonical mid-jump message maps to `wait`, not `blocked`. Not inTransit
  // here, so this exercises classifyGameError, not the flag guard.
  test("a mid-jump block that reaches the action catch is classified transient (wait), not terminal", async () => {
    const midJump = "Your ship is mid-JUMP to Ross 128 (~10s until arrival). Wait for the jump to complete, then resubmit this command.";
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "mine") throw new SpacemoltError("command_error", midJump);
        return { result: "ok" };
      },
      async status() { return status; }, // inTransit false -> flag guard does NOT fire
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("wait");
  });

  test("a terminal block reaching the action catch still maps to blocked (allowlist stays narrow)", async () => {
    const api: GameApi = {
      async action(): Promise<V2Result> { throw new SpacemoltError("command_error", "deposits too sparse to mine"); },
      async status() { return status; },
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "deposits too sparse to mine", resultText: "deposits too sparse to mine" });
  });
});
