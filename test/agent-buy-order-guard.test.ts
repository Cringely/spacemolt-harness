import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { EnvelopeNotification } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Duplicate-buy-order guard (issue #681, round 2). Round 1 keyed the guard on
// "a buy was ever blocked here" and refused the pilot's legitimate FIRST
// create_buy_order -- a standing buy order is the game's own documented
// remedy for item_not_available (markets.md:86, "Place a create_buy_order
// instead and let sellers come to you"), confirmed by task-reviewer on PR #58
// with the round-1 test as its own receipt (agent-buy-unavailable.test.ts:
// 111-126 drove exactly ONE blocked buy and asserted the FIRST order was
// refused). The corrected invariant: refuse a SECOND create_buy_order for a
// (station, item) pair that ALREADY has one open; the first always goes
// through. Production incident: six create_buy_order posts for fuel_cell at
// one station in 90 minutes, none of them cancelling the last, locked
// ~21,800cr in duplicate escrow.
//
// Exercised end-to-end (not just the executor unit level in executor.test.ts)
// because the bug that shipped in round 1 lived in the SEAM: whether the
// producer (agent.ts) computes the right boolean from real game outcomes,
// not in the executor's boolean-consuming guard itself.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const STATION = "haven_grand_exchange";

function dockedStatus(overrides?: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    credits: 200_000, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, dockedAt: STATION,
    ...overrides,
  };
}

function makeApi(
  status: StatusSnapshot, action: GameApi["action"], notifications?: () => EnvelopeNotification[],
): { api: GameApi; calls: string[] } {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push(name);
      return action(name, params);
    },
    async status() { return status; },
    async notifications() { return notifications?.() ?? []; },
  };
  return { api, calls };
}

const orderFuelCell: Plan = {
  goal: "post a standing order",
  steps: [{ action: "create_buy_order", params: { item_id: "fuel_cell", quantity: 85, price_each: 60 } }],
};
const orderFuelCellAgain: Plan = {
  goal: "post a second standing order",
  steps: [{ action: "create_buy_order", params: { item_id: "fuel_cell", quantity: 50, price_each: 100 } }],
};
const cancelAll: Plan = { goal: "release escrow", steps: [{ action: "cancel_order", params: { order_id: "all" } }] };

describe("Agent duplicate-buy-order guard (#681 round 2)", () => {
  // The exact case round 1 got wrong: no prior order, so the FIRST attempt
  // must reach the API, never be refused.
  test("the legitimate first create_buy_order is NOT refused", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async () => ({ result: "ok" }));
    const store = new Store(":memory:");
    const planner = new MockPlanner([orderFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan
    await agent.runOnce(); // create_buy_order step executes

    expect(calls).toEqual(["create_buy_order"]); // reached the API, not refused
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "buy_order");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ key: `${STATION}:fuel_cell`, stationKey: STATION, itemId: "fuel_cell", open: true });
  });

  test("a SECOND create_buy_order for the same item at the same station, with the first still open, is refused before the API call", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async () => ({ result: "ok" }));
    const store = new Store(":memory:");
    const planner = new MockPlanner([orderFuelCell, orderFuelCellAgain]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan (orderFuelCell)
    await agent.runOnce(); // first order placed, opens the record
    await agent.runOnce(); // plan_done -> replan (orderFuelCellAgain)
    await agent.runOnce(); // second order: must be refused pre-call

    expect(calls).toEqual(["create_buy_order"]); // exactly one API call, not two
    const actionEvents = store.recentEvents("a1", 20).filter((e) => e.type === "action");
    const second = actionEvents.filter((e) => (e.payload as { action?: string }).action === "create_buy_order")[1];
    expect(second).toBeDefined();
    expect((second!.payload as { outcome: string }).outcome).toBe("blocked");
    expect((second!.payload as { guard?: boolean }).guard).toBe(true); // our refusal, not the game's
    expect((second!.payload as { result?: string }).result).toContain("already open at this station");
  });

  // The other required regression: a cancelled order must unblock a later
  // legitimate re-order -- the failure mode round 1 shipped with no recovery
  // path at all (task-reviewer finding 2).
  test("cancel_order clears the open record: a later create_buy_order for the same item is NOT refused", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async () => ({ result: "ok" }));
    const store = new Store(":memory:");
    const planner = new MockPlanner([orderFuelCell, cancelAll, orderFuelCellAgain]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // replan (orderFuelCell)
    await agent.runOnce(); // order placed, opens the record
    await agent.runOnce(); // plan_done -> replan (cancelAll)
    await agent.runOnce(); // cancel_order succeeds, closes the record
    await agent.runOnce(); // plan_done -> replan (orderFuelCellAgain)
    await agent.runOnce(); // re-order: must reach the API, not be refused

    expect(calls).toEqual(["create_buy_order", "cancel_order", "create_buy_order"]);
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "buy_order");
    expect(events.map((e) => (e.payload as { open: boolean }).open)).toEqual([true, false, true]);
  });

  // A resting order filling elsewhere (the pilot need not even be at the
  // station) must also clear the record -- the vendored buy_filled
  // notification, not a cancel.
  test("a buy_filled notification clears the open record: a later create_buy_order for the same item is NOT refused", async () => {
    const status = dockedStatus();
    let tick = 0;
    const { api, calls } = makeApi(status, async () => ({ result: "ok" }), () => {
      tick++;
      // Delivered starting the tick after the first order opens; the dedupe
      // in emitNewNotifications means it is only processed once regardless
      // of how many ticks keep returning it.
      return tick >= 3
        ? [{ id: "n1", type: "trade", msg_type: "buy_filled", timestamp: "t" }]
        : [];
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([orderFuelCell, orderFuelCellAgain]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // tick 1: no_plan -> replan (orderFuelCell)
    await agent.runOnce(); // tick 2: order placed, opens the record
    await agent.runOnce(); // tick 3: buy_filled notification clears it; plan_done -> replan (orderFuelCellAgain)
    await agent.runOnce(); // tick 4: re-order: must reach the API, not be refused

    expect(calls).toEqual(["create_buy_order", "create_buy_order"]);
    // [true, false, true]: the first order opens it, the buy_filled
    // notification closes it, the second (unrefused) order reopens it.
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "buy_order");
    expect(events.map((e) => (e.payload as { open: boolean }).open)).toEqual([true, false, true]);
  });

  // Scoping proof: the guard is keyed on (station, item), not "any order this
  // pilot has open anywhere" -- a DIFFERENT item at the same station must
  // still be allowed to post its own first order.
  test("an open order for a DIFFERENT item at the same station does not block a first order for this item", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async () => ({ result: "ok" }));
    const store = new Store(":memory:");
    const orderOre: Plan = {
      goal: "post a standing order",
      steps: [{ action: "create_buy_order", params: { item_id: "iron_ore", quantity: 10, price_each: 15 } }],
    };
    const planner = new MockPlanner([orderFuelCell, orderOre]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // replan (orderFuelCell)
    await agent.runOnce(); // fuel_cell order opens its own record
    await agent.runOnce(); // plan_done -> replan (orderOre)
    await agent.runOnce(); // iron_ore order: must reach the API too

    expect(calls).toEqual(["create_buy_order", "create_buy_order"]);
  });
});
