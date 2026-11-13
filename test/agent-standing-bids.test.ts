import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { buildDigest } from "../src/planner/digest";
import type { GameApi, MarketRow, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Standing-bid depth and aging (Cringely/spacemolt#1013, #726, #808, #918,
// #1025, #986, #949, #833). The digest-side rendering is pinned in
// digest.test.ts with a hand-built ctx; these tests drive the PRODUCER,
// Agent.replan, because the bug class lives in the seam: whether the ctx the
// planner is handed carries each open bid's age, where it sits, and the market
// rows needed to say whether anyone sells the item. Open bids are read off the
// buy_order stream learnBuyOrderOpened already writes (#681), no new memory.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const HOME = "market_prime";
const HOUR_MS = 3_600_000;

function dockedStatus(dockedAt: string = HOME): StatusSnapshot {
  return {
    credits: 5_000, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, dockedAt,
  };
}

function makeApi(status: StatusSnapshot, market?: () => Promise<MarketRow[]>) {
  const counts = { getMarket: 0 };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    ...(market ? { async getMarket() { counts.getMarket++; return market(); } } : {}),
  };
  return { api, counts };
}

const bidScanner: Plan = {
  goal: "post a standing order",
  steps: [{ action: "create_buy_order", params: { item_id: "survey_scanner_i", quantity: 1, price_each: 4_400 } }],
};
const cancelAll: Plan = { goal: "release escrow", steps: [{ action: "cancel_order", params: { order_id: "all" } }] };
const idle: Plan = { goal: "wait", steps: [{ action: "undock", params: {} }] };

describe("PlanContext.openBuyOrders (standing-bid aging)", () => {
  test("a placed bid reaches the next replan with its age in hours and here=true at the placing station", async () => {
    const status = dockedStatus();
    let t = 1_000_000;
    const { api } = makeApi(status);
    const store = new Store(":memory:");
    const planner = new MockPlanner([bidScanner, idle]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => t });

    await agent.runOnce(); // no_plan -> replan (ctx0: nothing open yet)
    await agent.runOnce(); // bid placed at t
    t += 30 * HOUR_MS;
    await agent.runOnce(); // plan_done -> replan (ctx1)

    expect(planner.contexts[0]!.openBuyOrders ?? []).toEqual([]);
    expect(planner.contexts[1]!.openBuyOrders).toEqual([
      { itemId: "survey_scanner_i", stationKey: HOME, ageHours: 30, here: true },
    ]);
  });

  test("after the pilot roams, the same bid reports here=false and still ages from placement", async () => {
    const status = dockedStatus();
    let t = 1_000_000;
    const { api } = makeApi(status);
    const store = new Store(":memory:");
    const planner = new MockPlanner([bidScanner, idle]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => t });

    await agent.runOnce();
    await agent.runOnce(); // bid placed at HOME
    t += 50 * HOUR_MS;
    status.dockedAt = "far_outpost"; // scout roamed on and docked elsewhere
    await agent.runOnce(); // replan

    expect(planner.contexts[1]!.openBuyOrders).toEqual([
      { itemId: "survey_scanner_i", stationKey: HOME, ageHours: 50, here: false },
    ]);
    // The producer-to-digest funnel the planner actually reads.
    const digest = buildDigest(planner.contexts[1]!);
    expect(digest).toContain(HOME);
    expect(digest).toContain("STALE");
  });

  test("a successful cancel_order closes the record: the next replan carries no open bids", async () => {
    const status = dockedStatus();
    let t = 1_000_000;
    const { api } = makeApi(status);
    const store = new Store(":memory:");
    const planner = new MockPlanner([bidScanner, cancelAll, idle]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => t });

    await agent.runOnce(); // replan (bid)
    await agent.runOnce(); // bid placed
    await agent.runOnce(); // plan_done -> replan (cancelAll), ctx1 carries the bid
    await agent.runOnce(); // cancel_order succeeds, record closed
    t += 5 * HOUR_MS;
    await agent.runOnce(); // plan_done -> replan (ctx2)

    expect(planner.contexts[1]!.openBuyOrders).toHaveLength(1);
    expect(planner.contexts[2]!.openBuyOrders ?? []).toEqual([]);
  });

  // The seller-depth half needs market rows, and the old gate (docked AND cargo
  // aboard) never fetched them for the pilots that bid: a scout with an empty
  // hold. #918's scout held nothing while 4,556cr sat behind its bid.
  test("an empty-hold pilot docked at the bid's station fetches the market, so the digest can say NO SELLERS", async () => {
    const status = dockedStatus();
    const { api, counts } = makeApi(status, async () => [{ itemId: "survey_scanner_i", buyQty: 1, bestBuy: 4_400, sellQty: 0 }]);
    const store = new Store(":memory:");
    const planner = new MockPlanner([bidScanner, idle]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1_000_000 });

    await agent.runOnce(); // replan, no bid yet: empty hold -> no fetch
    expect(counts.getMarket).toBe(0);
    await agent.runOnce(); // bid placed
    await agent.runOnce(); // replan with a bid here: fetch

    expect(counts.getMarket).toBe(1);
    expect(planner.contexts[1]!.marketRows).toHaveLength(1);
    expect(buildDigest(planner.contexts[1]!)).toContain("NO SELLERS");
  });

  test("an empty-hold pilot docked ELSEWHERE does not fetch the market for a bid it cannot act on here", async () => {
    const status = dockedStatus();
    const { api, counts } = makeApi(status, async () => { throw new Error("must not be fetched"); });
    const store = new Store(":memory:");
    const planner = new MockPlanner([bidScanner, idle]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1_000_000 });

    await agent.runOnce();
    await agent.runOnce(); // bid placed at HOME
    status.dockedAt = "far_outpost";
    await agent.runOnce(); // replan elsewhere

    expect(counts.getMarket).toBe(0);
    expect(planner.contexts[1]!.marketRows).toBeUndefined();
  });
});
