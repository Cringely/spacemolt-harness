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
