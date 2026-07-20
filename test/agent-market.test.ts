import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { parseMarketText } from "../src/client/mcp-text-parser";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot, MarketRow, CargoItem } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import fixture from "./fixtures/mcp-probe-2026-07-12.json";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

// Buyable-here surfacing (issue #93): the harness fetches THIS station's
// market once per docked-with-cargo replan and hands the parsed rows to the
// planner, so a sell decision runs on data instead of hope (the no-buyers
// thrash class: 38 identical "Sold 0 Palladium Ore ... (no buyers)" blocks at
// one station). These tests guard the behaviors the fix hangs on:
//   - docked WITH cargo -> exactly one getMarket call, rows reach the planner
//     and the digest renders the sell verdicts;
//   - undocked, or docked with an EMPTY hold -> no call at all (the feature's
//     no-extra-call property: the one market query is spent only when a sell
//     is decidable);
//   - a thrown fetch, or a fetch that parses to zero rows, degrades to no
//     market section WITH a visible market_error (never a silent blank, and
//     never a NO BUYER claim from missing data) and the replan proceeds.
describe("Agent market listing (#93)", () => {
  const heldCargo: CargoItem[] = [
    { itemId: "palladium_ore", name: "Palladium Ore", quantity: 22 },
    { itemId: "iron_ore", name: "Iron Ore", quantity: 3 },
  ];
  // Sell-relevant subset of the captured Market Prime Exchange listing:
  // iron_ore carries the fixture's real standing bid; palladium_ore is
  // (correctly) absent, exactly as in the live capture.
  const marketRows: MarketRow[] = [{ itemId: "iron_ore", bestBuy: 11, buyQty: 200 }];

  function stubApi(opts: {
    docked: boolean;
    cargo: CargoItem[];
    market?: () => Promise<MarketRow[]>;
  }) {
    let getMarketCalls = 0;
    const status: StatusSnapshot = {
      credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: opts.cargo.reduce((n, c) => n + c.quantity, 0), cargoCapacity: 50,
      docked: opts.docked, inTransit: false, dockedAt: opts.docked ? "base-1" : null,
      cargo: opts.cargo,
    };
    const market = opts.market;
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
      ...(market ? { async getMarket() { getMarketCalls++; return market(); } } : {}),
    };
    return { api, counts: () => ({ getMarketCalls }) };
  }

  test("docked replan with cargo fetches the market once; the digest renders the fixture bid and the NO BUYER verdict", async () => {
    const { api, counts } = stubApi({ docked: true, cargo: heldCargo, market: async () => marketRows });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan
    expect(counts()).toEqual({ getMarketCalls: 1 });
    expect(planner.contexts[0]!.marketRows).toEqual(marketRows);
    // The end of the funnel: the sell verdicts the planner actually reads.
    const digest = buildDigest(planner.contexts[0]!);
    expect(digest).toContain("iron_ore: buyer here at 11cr/unit (demand 200)");
    expect(digest).toContain("palladium_ore: NO BUYER at this station");
  });

  test("undocked replan makes NO market fetch", async () => {
    const { api, counts } = stubApi({
      docked: false, cargo: heldCargo,
      market: async () => { throw new Error("must never be fetched"); },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ getMarketCalls: 0 });
    expect(planner.contexts[0]!.marketRows).toBeUndefined();
  });

  test("docked replan with an EMPTY hold makes NO market fetch (no sell decision, no extra query)", async () => {
    const { api, counts } = stubApi({
      docked: true, cargo: [],
      market: async () => { throw new Error("must never be fetched"); },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ getMarketCalls: 0 });
    expect(planner.contexts[0]!.marketRows).toBeUndefined();
  });

  test("a getMarket() rejection degrades to no market section, emits market_error, and doesn't block replan", async () => {
    const { api } = stubApi({
      docked: true, cargo: heldCargo,
      market: async () => { throw new Error("market query down"); },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // must not throw
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.marketRows).toBeUndefined();
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok"); // replan still succeeded

    const events = store.recentEvents("a1", 20).filter((e) => e.type === "market_error");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ message: "market query down" });
  });

  // PR #197 review (L-24 gap): a plausible LIVE shape divergence is not total
  // absence — it's the real fixture text with one column renamed. HTTP has
  // never been captured for view_market; if it serves the same "Market
  // summary" intro and tab-table but names the bid column differently,
  // header-keyed cell lookup yields non-empty rows whose bestBuy is
  // universally undefined, and without the header guard the digest inverts
  // missing data into "NO BUYER at this station" for EVERY held item — the
  // exact false-fire class (#175) this feature exists to close, silently.
  // This test drives the near-miss through the REAL parser into the agent:
  // kill the header guard in parseMarketText and it fails on a false NO BUYER.
  test("near-miss shape (real fixture, renamed bid column) parses to [] -> market_error, NOT a false NO BUYER", async () => {
    const marketText: string = (fixture as { read_only_calls: Record<string, { raw: { result: { content: { text: string }[] } } }> })
      .read_only_calls["spacemolt_market/view_market"]!.raw.result.content[0]!.text;
    // Rename best_buy in the HEADER line only; intro, structure, and all 482
    // data rows stay byte-identical to the capture.
    const lines = marketText.split("\n");
    const headerIdx = lines.findIndex((l) => /^Market summary at /i.test(l)) + 1;
    lines[headerIdx] = lines[headerIdx]!.replace("best_buy", "best_bid");
    const nearMiss = lines.join("\n");
    expect(lines[headerIdx]).toContain("best_bid"); // the rename actually landed
    expect(parseMarketText(nearMiss)).toEqual([]); // the guard, at the parse seam

    const { api, counts } = stubApi({ docked: true, cargo: heldCargo, market: async () => parseMarketText(nearMiss) });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ getMarketCalls: 1 });
    expect(planner.contexts[0]!.marketRows).toBeUndefined();
    const digest = buildDigest(planner.contexts[0]!);
    expect(digest).not.toContain("Station market check"); // no market section at all
    expect(digest).not.toContain("NO BUYER"); // and no inverted verdict
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "market_error");
    expect(events.length).toBe(1);
  });

  test("a fetch that parses to ZERO rows degrades to no section AND a visible market_error (live shape divergence must not be silent)", async () => {
    const { api, counts } = stubApi({ docked: true, cargo: heldCargo, market: async () => [] });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ getMarketCalls: 1 });
    expect(planner.contexts[0]!.marketRows).toBeUndefined();
    // No data means no verdicts: the digest must not claim NO BUYER here.
    expect(buildDigest(planner.contexts[0]!)).not.toContain("NO BUYER");
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "market_error");
    expect(events.length).toBe(1);
  });
});

// Market-intelligence injection (issue #269): the no-buyers remedy commanded
// view_orders/analyze_market -- both kind:"query", unplannable -- so the pilot
// was told to plan what it could not express. Producer fix (the #147/#176
// pattern): the harness runs analyze_market (the ONE query that yields regional
// buyer demand; view_orders is the pilot's OWN orders per openapi-v2/markets.md)
// once per docked-with-cargo replan and injects the raw insight text. Same gate
// as gatherMarket (docked because analyze_market reads the current station;
// cargo because the insight exists to answer "where do I sell what I hold").
describe("Agent market-intelligence gather (#269)", () => {
  const heldCargo: CargoItem[] = [{ itemId: "palladium_ore", name: "Palladium Ore", quantity: 22 }];

  function stubApi(opts: { docked: boolean; cargo: CargoItem[]; analyze?: () => Promise<string> }) {
    let analyzeCalls = 0;
    const status: StatusSnapshot = {
      credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: opts.cargo.reduce((n, c) => n + c.quantity, 0), cargoCapacity: 50,
      docked: opts.docked, inTransit: false, dockedAt: opts.docked ? "base-1" : null,
      cargo: opts.cargo,
    };
    const analyze = opts.analyze;
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
      ...(analyze ? { async analyzeMarket() { analyzeCalls++; return analyze(); } } : {}),
    };
    return { api, counts: () => ({ analyzeCalls }) };
  }

  test("docked replan with cargo fetches analyze_market once; the insight reaches the planner and the digest", async () => {
    const insight = "Regional demand: Titan Yard (titan_yard) buys palladium_ore at 210cr.";
    const { api, counts } = stubApi({ docked: true, cargo: heldCargo, analyze: async () => insight });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ analyzeCalls: 1 });
    expect(planner.contexts[0]!.marketInsightsText).toBe(insight);
    expect(buildDigest(planner.contexts[0]!)).toContain("Titan Yard (titan_yard) buys palladium_ore");
  });

  test("undocked replan makes NO analyze_market fetch", async () => {
    const { api, counts } = stubApi({
      docked: false, cargo: heldCargo,
      analyze: async () => { throw new Error("must never be fetched"); },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ analyzeCalls: 0 });
    expect(planner.contexts[0]!.marketInsightsText).toBeUndefined();
  });

  test("docked with an EMPTY hold makes NO analyze_market fetch (no sell decision, no extra query)", async () => {
    const { api, counts } = stubApi({
      docked: true, cargo: [],
      analyze: async () => { throw new Error("must never be fetched"); },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ analyzeCalls: 0 });
    expect(planner.contexts[0]!.marketInsightsText).toBeUndefined();
  });

  test("an analyzeMarket() rejection degrades to no section, emits analyze_market_error, and doesn't block replan", async () => {
    const { api } = stubApi({
      docked: true, cargo: heldCargo,
      analyze: async () => { throw new Error("insight query down"); },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // must not throw
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.marketInsightsText).toBeUndefined();
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok"); // replan still succeeded
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "analyze_market_error");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ message: "insight query down" });
  });

  test("a fetch that returns empty/whitespace degrades to no section and makes no error (absence is not a verdict)", async () => {
    const { api, counts } = stubApi({ docked: true, cargo: heldCargo, analyze: async () => "   " });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ analyzeCalls: 1 });
    expect(planner.contexts[0]!.marketInsightsText).toBeUndefined();
    // The injected SECTION's signature, not the bare phrase (runbook lines
    // legitimately reference "the Market intelligence section").
    expect(buildDigest(planner.contexts[0]!)).not.toMatch(/Market intelligence -- live analyze_market/i);
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "analyze_market_error");
    expect(events.length).toBe(0);
  });
});
