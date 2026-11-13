import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

// in_battle guard (tracker Cringely/spacemolt#892: 26 corsair actions in 72h
// rejected with "in_battle: cannot perform this action while in combat. Use
// the battle command to fight or flee."). get_status has no battle flag
// (V2GameState.player carries none, checked against openapi-v2.json), so the
// only evidence a pilot is in a battle is the game having just said so. The
// memory is the pilot's own persisted refusal, windowed by
// repeatBlockWindowMinutes: the same bounded-memory shape as the #669 repeated
// buy guard, for the same reason (no real signal says the battle ended).
// Exercised through Agent because the risk is the seam: which events arm it,
// and that our own refusals never re-arm it.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 600, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const MIN = 60_000;
const WINDOW = 30 * MIN; // AGENT_DEFAULTS.repeatBlockWindowMinutes

const status: StatusSnapshot = {
  credits: 500, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

const IN_BATTLE = "in_battle: cannot perform this action while in combat. Use the battle command to fight or flee.";

function build(plan: Plan, behave: (name: string) => void) {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push(name); behave(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  const store = new Store(":memory:");
  let now = 1_000;
  const agent = new Agent({
    id: "a1", persona: "p", api, store, planner: new MockPlanner([plan]), config, now: () => now,
  });
  return { agent, calls, store, setNow: (t: number) => { now = t; } };
}

const jump: Plan = { goal: "leave", steps: [{ action: "jump", params: { id: "sys_b" } }] };
const inBattleFor = (...names: string[]) => (name: string) => {
  if (names.includes(name)) throw new SpacemoltError("command_error", IN_BATTLE);
};

function refusals(store: Store) {
  return store.recentEvents("a1", 100)
    .filter((e) => e.type === "action")
    .map((e) => e.payload as { action: string; outcome: string; guard?: boolean; result: string });
}

describe("Agent in_battle guard (#892)", () => {
  test("after the game says in_battle, the next blocked-set action is refused before the game, in prose", async () => {
    const { agent, calls, store } = build(jump, inBattleFor("jump"));

    await agent.runOnce(); // replan
    await agent.runOnce(); // jump #1 reaches the game: in_battle
    await agent.runOnce(); // blocked -> replan
    await agent.runOnce(); // jump #2: refused pre-call

    expect(calls).toEqual(["jump"]);
    const guarded = refusals(store).filter((p) => p.guard === true);
    expect(guarded.length).toBe(1);
    expect(guarded[0]!.action).toBe("jump");
    expect(guarded[0]!.result).not.toMatch(/\w+\{/); // #1116: no resubmittable call
  });

  test("the evidence is battle-wide: in_battle on one action also refuses the others in the set", async () => {
    const plans = [jump, { goal: "sos", steps: [{ action: "distress_signal", params: { distress_type: "combat" } }] } as Plan];
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        calls.push(name);
        if (name === "jump") throw new SpacemoltError("command_error", IN_BATTLE);
        return { result: "ok" };
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: new MockPlanner(plans), config, now: () => 1_000 });
    await agent.runOnce(); // replan -> jump
    await agent.runOnce(); // jump: in_battle
    await agent.runOnce(); // blocked -> replan -> distress_signal
    await agent.runOnce(); // distress_signal: refused pre-call
    expect(calls).toEqual(["jump"]);
  });

  test("an action outside the proven-blocked set still reaches the game", async () => {
    const attack: Plan = { goal: "fight", steps: [{ action: "attack", params: { id: "pirate_1" } }] };
    const plans = [jump, attack];
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        calls.push(name);
        if (name === "jump") throw new SpacemoltError("command_error", IN_BATTLE);
        return { result: "ok" };
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: new MockPlanner(plans), config, now: () => 1_000 });
    await agent.runOnce(); // replan -> jump
    await agent.runOnce(); // jump: in_battle
    await agent.runOnce(); // blocked -> replan -> attack
    await agent.runOnce(); // attack: combat is how a battle is resolved, never refused
    expect(calls).toEqual(["jump", "attack"]);
  });

  test("a block that is not in_battle arms nothing", async () => {
    const { agent, calls } = build(jump, (name) => {
      if (name === "jump") throw new SpacemoltError("command_error", "no_fuel: not enough fuel");
    });
    await agent.runOnce();
    await agent.runOnce(); // jump: no_fuel
    await agent.runOnce(); // blocked -> replan
    await agent.runOnce(); // jump again: nothing says in_battle, so it reaches the game
    expect(calls).toEqual(["jump", "jump"]);
  });

  test("only the game's refusal arms it: a guard-tagged block, whatever its text says, does not", async () => {
    // Our own refusal text happens not to start with the in_battle code today,
    // so this pins the invariant itself rather than leaning on the wording.
    const { agent, calls, store } = build(jump, () => {});
    store.appendEvent({
      agentId: "a1", ts: 1_000, type: "action",
      payload: { action: "jump", outcome: "blocked", guard: true, result: IN_BATTLE },
    });
    await agent.runOnce(); // replan
    await agent.runOnce(); // jump: nothing the GAME said arms the memory, so it goes out
    expect(calls).toEqual(["jump"]);
  });

  test("the memory expires from the game's refusal, and our own refusals do not slide it", async () => {
    const { agent, calls, setNow } = build(jump, inBattleFor("jump"));

    await agent.runOnce(); // replan
    await agent.runOnce(); // jump #1: in_battle at t=1s (arms the window)
    await agent.runOnce(); // blocked -> replan
    setNow(1_000 + 10 * MIN);
    await agent.runOnce(); // jump: refused pre-call (must NOT restart the clock)
    await agent.runOnce(); // blocked -> replan
    setNow(1_000 + WINDOW + 1);
    await agent.runOnce(); // window over: reaches the game again, re-probing

    expect(calls).toEqual(["jump", "jump"]);
  });
});
