import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// No-op admission guards (tracker Cringely/spacemolt#995/#848/#888/#938:
// 99 + 87 wasted refuel calls per 72h fleet-wide, all answered
// "tank_full: Fuel tank is already full (130/130). No refueling needed.").
// Invariant: the executor never SUBMITS a call whose precondition the pilot's
// own fresh status already proves unmet. Every test here asserts the stub game
// client saw zero calls -- the refusal happens before the wire, which is the
// whole point (a refusal AFTER the call is what the game already does).

function stubApi(status: StatusSnapshot) {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

function status(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    credits: 500, fuel: 130, maxFuel: 130, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, ...overrides,
  };
}

describe("refuel on a full tank (#995 #848 #888 #938)", () => {
  const plan: Plan = {
    goal: "top up then leave",
    steps: [{ action: "refuel", params: {} }, { action: "undock", params: {} }],
  };

  test("a full tank skips the refuel and advances to the next step with no game call", async () => {
    const { api, calls } = stubApi(status({ fuel: 130, maxFuel: 130 }));
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("continue");
    if (r.kind !== "continue") throw new Error("unreachable");
    expect(r.cursor).toEqual({ step: 1, iteration: 0 });
    expect(r.resultText).toContain("130/130");
    expect(calls).toEqual([]);
  });

  test("a tank one unit short still reaches the game", async () => {
    const { api, calls } = stubApi(status({ fuel: 129, maxFuel: 130 }));
    await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(calls).toEqual(["refuel"]);
  });

  test("an unreadable ship block (maxFuel 0) is UNKNOWN, never full: the call goes through", async () => {
    // status() defaults a missing ship.fuel/max_fuel to 0/0, and 0 >= 0 would
    // otherwise read as a full tank.
    const { api, calls } = stubApi(status({ fuel: 0, maxFuel: 0 }));
    await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(calls).toEqual(["refuel"]);
  });

  test("a ship-to-ship transfer (target set) is not a tank refill: the guard stays out of it", async () => {
    const transfer: Plan = { goal: "rescue", steps: [{ action: "refuel", params: { target: "Rescuee" } }] };
    const { api, calls } = stubApi(status({ fuel: 130, maxFuel: 130 }));
    await executeTick(api, transfer, { step: 0, iteration: 0 });
    expect(calls).toEqual(["refuel"]);
  });
});

describe("espionage while unaffiliated (#1004)", () => {
  // espionage.md:5, "All of these are faction systems: they require
  // membership in a faction", and the game's own answer: "You must be in a
  // faction to conduct espionage".
  const plan: Plan = { goal: "spy", steps: [{ action: "espionage", params: {} }] };

  test("a pilot known to be in no faction is refused before the game, in prose", async () => {
    const { api, calls } = stubApi(status({ factionId: null }));
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(calls).toEqual([]);
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.guard).toBe(true);
    expect(r.reason).toContain("faction");
    // #1116: a refusal hands back prose, never an action{...} call to resubmit.
    expect(r.reason).not.toMatch(/\w+\{/);
  });

  test("a faction member reaches the game", async () => {
    const { api, calls } = stubApi(status({ factionId: "f_crimson" }));
    await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(calls).toEqual(["espionage"]);
  });

  test("an unknown affiliation (factionId undefined) is no verdict: the call goes through", async () => {
    const { api, calls } = stubApi(status());
    await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(calls).toEqual(["espionage"]);
  });
});

describe("distress_signal on cooldown (#792)", () => {
  // missions.md:70: "one active distress signal at a time, a 1-hour cooldown
  // between calls". The executor is store-free; agent.ts hands it the minutes
  // left (see test/agent-distress-cooldown.test.ts for the producing seam).
  const plan: Plan = { goal: "sos", steps: [{ action: "distress_signal", params: { distress_type: "fuel" } }] };
  const run = (api: GameApi, minutes: number | undefined) =>
    executeTick(
      api, plan, { step: 0, iteration: 0 }, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, minutes,
    );

  test("minutes left on the cooldown refuse the call before the game, naming the wait in prose", async () => {
    const { api, calls } = stubApi(status({ docked: false }));
    const r = await run(api, 42);
    expect(calls).toEqual([]);
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.guard).toBe(true);
    expect(r.reason).toContain("42 minutes");
    expect(r.reason).not.toMatch(/\w+\{/);
  });

  test("no cooldown on record, or an expired one, reaches the game", async () => {
    for (const minutes of [undefined, 0]) {
      const { api, calls } = stubApi(status({ docked: false }));
      await run(api, minutes);
      expect(calls).toEqual(["distress_signal"]);
    }
  });

  test("the guard is scoped to distress_signal: another step ignores the cooldown", async () => {
    const { api, calls } = stubApi(status({ fuel: 10 }));
    await executeTick(
      api, { goal: "fill", steps: [{ action: "refuel", params: {} }] }, { step: 0, iteration: 0 },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 42,
    );
    expect(calls).toEqual(["refuel"]);
  });
});

describe("actions the game rejects with in_battle (#892)", () => {
  // The four named in the tracker issue's 72h sample: distress_signal, jump,
  // scan, travel_to. agent.ts decides whether a battle is on (see
  // test/agent-in-battle-guard.test.ts for the producing seam) and hands the
  // executor a boolean.
  const steps: Array<[string, Plan]> = [
    ["distress_signal", { goal: "g", steps: [{ action: "distress_signal", params: { distress_type: "combat" } }] }],
    ["jump", { goal: "g", steps: [{ action: "jump", params: { id: "sys_b" } }] }],
    ["scan", { goal: "g", steps: [{ action: "scan", params: { id: "p1" } }] }],
    ["travel_to", { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys_b" } }] }],
  ];
  const run = (api: GameApi, plan: Plan, inBattle: boolean | undefined) =>
    executeTick(
      api, plan, { step: 0, iteration: 0 }, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, inBattle,
    );

  for (const [name, plan] of steps) {
    test(`${name} is refused before the game while a battle is on, in prose`, async () => {
      const { api, calls } = stubApi(status({ docked: false }));
      const r = await run(api, plan, true);
      expect(calls).toEqual([]);
      expect(r.kind).toBe("blocked");
      if (r.kind !== "blocked") throw new Error("unreachable");
      expect(r.guard).toBe(true);
      expect(r.reason).toContain(name);
      expect(r.reason).not.toMatch(/\w+\{/);
    });
  }

  test("a combat action is never refused: it is how the battle ends", async () => {
    const attack: Plan = { goal: "g", steps: [{ action: "attack", params: { id: "pirate_1" } }] };
    const { api, calls } = stubApi(status({ docked: false }));
    await run(api, attack, true);
    expect(calls).toEqual(["attack"]);
  });
});
