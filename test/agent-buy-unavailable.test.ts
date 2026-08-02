import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Unfillable-buy-order guard (issue #681). Production incident: docked at a
// station with no fuel_cell seller, the planner posted six create_buy_order
// bids across 90 minutes (varying price_each 50/60/100/50/100/60cr), locking
// ~21,800cr in escrow that could never fill -- there is no counterparty at
// any price when the station has no seller at all. The fix is two seams:
//   - learnBuyUnavailable (agent.ts): a `buy` blocked with the game's
//     item_not_available code persists a narrow buy_unavailable event keyed
//     `${stationKey}:${itemId}`.
//   - the create_buy_order guard (executor.ts): refuses the order when the
//     current station+item already has such a record.
// Exercised end-to-end here (not just at the executor unit level in
// executor.test.ts) because the interesting bug lives in the SEAM: whether a
// live blocked buy actually produces the record the later guard reads.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const STATION = "haven_grand_exchange";
// The exact game error text from the live incident (issue #669's capture):
// "item_not_available: No one is selling Fuel Cell at this station. To place
// a standing buy order, use: ...". The game's own message carries the code
// as its own prefix (classifyGameError forwards e.message verbatim, never
// e.code -- same message-text-matching convention as TRANSIENT_BLOCK_MARKERS
// in executor.ts), so the transport-level code argument here is the generic
// "command_error" every other message-classified test in this suite uses.
const ITEM_NOT_AVAILABLE = new SpacemoltError(
  "command_error",
  "item_not_available: No one is selling Fuel Cell at this station. To place a standing buy order, use: {\"type\": \"create_buy_order\"...",
);

function dockedStatus(overrides?: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    credits: 200_000, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, dockedAt: STATION,
    ...overrides,
  };
}

function makeApi(status: StatusSnapshot, action: GameApi["action"]): { api: GameApi; calls: string[] } {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push(name);
      return action(name, params);
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

const buyFuelCell: Plan = { goal: "secure fuel", steps: [{ action: "buy", params: { id: "fuel_cell", quantity: 85 } }] };
const bidFuelCell: Plan = {
  goal: "post a standing order",
  steps: [{ action: "create_buy_order", params: { item_id: "fuel_cell", quantity: 85, price_each: 60 } }],
};

describe("Agent buy-unavailable memory + create_buy_order guard (#681)", () => {
  test("a buy blocked as item_not_available persists a keyed buy_unavailable event", async () => {
    const status = dockedStatus();
    const { api } = makeApi(status, async (name) => {
      if (name === "buy") throw ITEM_NOT_AVAILABLE;
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan (buyFuelCell)
    await agent.runOnce(); // buy step executes -> blocked

    const events = store.recentEvents("a1", 20).filter((e) => e.type === "buy_unavailable");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ key: `${STATION}:fuel_cell`, stationKey: STATION, itemId: "fuel_cell" });
  });

  // Fail-open correctness (AGENTS.md convention every guard here follows):
  // a buy blocked for a DIFFERENT reason is not evidence a standing bid would
  // fail too (insufficient funds blocks buy AND would block the escrow on a
  // create_buy_order identically -- it says nothing about seller existence).
  test("a buy blocked for a DIFFERENT reason (not item_not_available) records nothing", async () => {
    const status = dockedStatus();
    const { api } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("insufficient_funds", "You cannot afford this purchase.");
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    await agent.runOnce();

    expect(store.recentEvents("a1", 20).filter((e) => e.type === "buy_unavailable").length).toBe(0);
  });

  // The end-to-end reproduction: the SAME item at the SAME station, blocked
  // on tick N, must refuse a create_buy_order on a later replan without ever
  // reaching the API (the escrow-locking call itself must not fire).
  test("end-to-end: a later create_buy_order for the same item at the same station is refused, never reaches the API", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async (name) => {
      if (name === "buy") throw ITEM_NOT_AVAILABLE;
      return { result: "ok" }; // create_buy_order would "succeed" if the guard failed to catch it
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell, bidFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan (buyFuelCell)
    await agent.runOnce(); // buy blocks, buy_unavailable recorded
    await agent.runOnce(); // blocked wake -> replan (bidFuelCell)
    await agent.runOnce(); // create_buy_order step: must be refused pre-call

    expect(calls).not.toContain("create_buy_order"); // the escrow-locking call never went out
    const actionEvents = store.recentEvents("a1", 20).filter((e) => e.type === "action");
    const buyOrderOutcome = actionEvents.find((e) => (e.payload as { action?: string }).action === "create_buy_order");
    expect(buyOrderOutcome).toBeDefined();
    expect((buyOrderOutcome!.payload as { outcome: string }).outcome).toBe("blocked");
    expect((buyOrderOutcome!.payload as { guard?: boolean }).guard).toBe(true); // our refusal, not the game's
    expect((buyOrderOutcome!.payload as { result?: string }).result).toContain("no seller at this station");
  });

  // Scoping proof: the guard is keyed on (station, item), not "any prior
  // blocked buy anywhere" -- a different item at the SAME proven-dead station
  // must still be allowed to bid.
  test("a create_buy_order for a DIFFERENT item at the same station is NOT blocked", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async (name) => {
      if (name === "buy") throw ITEM_NOT_AVAILABLE; // records fuel_cell unavailable at STATION
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const bidOre: Plan = {
      goal: "post a standing order",
      steps: [{ action: "create_buy_order", params: { item_id: "iron_ore", quantity: 10, price_each: 15 } }],
    };
    const planner = new MockPlanner([buyFuelCell, bidOre]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // replan (buyFuelCell)
    await agent.runOnce(); // buy blocks, buy_unavailable recorded for fuel_cell
    await agent.runOnce(); // blocked wake -> replan (bidOre)
    await agent.runOnce(); // create_buy_order for iron_ore: must go through

    expect(calls).toContain("create_buy_order");
    const actionEvents = store.recentEvents("a1", 20).filter((e) => e.type === "action");
    const buyOrderOutcome = actionEvents.find((e) => (e.payload as { action?: string }).action === "create_buy_order");
    expect((buyOrderOutcome!.payload as { outcome: string }).outcome).not.toBe("blocked");
  });
});
