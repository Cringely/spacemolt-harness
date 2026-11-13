import { describe, expect, test } from "bun:test";
import { FUEL_PRICE_FLOOR_CR, LISTING_FEE_BPS } from "../src/agent/net-trip";
import { executeTick } from "../src/agent/executor";
import { buildDigest } from "../src/planner/digest";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";
import type { PlanContext } from "../src/planner/types";

// Net-trip profitability (issue #112): the ADVISORY-ONLY contract on the
// executor path, and the digest's briefing verdict.
//
// PR #361 review (REVISE) removed the first cut's deterministic travel_to
// block: it priced revenue at catalog base_value, and catalog value does not
// BOUND revenue in a player-driven market (markets.md:3,7 -- no global fixed
// price; station price gaps are the arbitrage profession), so the "provably
// lossy" premise failed and the block could refuse profitable arbitrage
// (#155, conservative suppression). The divergence test below PINS the chosen
// behavior so a future guard cannot come back without confronting it.

// ---------------------------------------------------------------------------
// Executor contract: ADVISORY ONLY -- no deterministic net-trip block exists.
// ---------------------------------------------------------------------------

function tripApi() {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const status: StatusSnapshot = {
    credits: 100, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 1, cargoCapacity: 50, docked: false, inTransit: false, systemId: "sys-here",
  };
  const api: GameApi = {
    async action(name, params) {
      calls.push({ name, params });
      if (name === "find_route") {
        return {
          structuredContent: {
            found: true, total_jumps: 2, estimated_fuel: 30, fuel_available: 100,
            message: "Route found: 2 jump(s).",
            route: [
              { jumps: 0, name: "sys-here", system_id: "sys-here" },
              { jumps: 1, name: "sys-mid", system_id: "sys-mid" },
              { jumps: 2, name: "sys-far", system_id: "sys-far" },
            ],
            target_system: "sys-far",
          },
        };
      }
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

describe("net-trip: advisory only, no executor block (#112, PR #361 review)", () => {
  // Divergence pin (review finding 3): catalog says LOSS -- 1x carbon_ore
  // (base_value 4cr) against a 30-fuel trip (60cr at the 2cr floor) -- but a
  // live destination bid can still say PROFIT, because prices are
  // player-driven and station gaps are the arbitrage profession
  // (markets.md:3,7). The executor must therefore let the trip DEPART; the
  // digest verdict owns the steer. If a deterministic block is ever
  // reintroduced, this test forces it to be based on data that actually
  // bounds revenue (a live destination bid), not on catalog value.
  test("a catalog-loss pure sell trip still departs: catalog value is an estimate, not a bound", async () => {
    const { api, calls } = tripApi();
    const plan: Plan = {
      goal: "sell the leftovers",
      steps: [
        { action: "travel_to", params: { system_id: "sys-far" } },
        { action: "dock", params: {} },
        { action: "sell", params: { id: "carbon_ore", quantity: 1 } },
      ],
    };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("continue");
    expect(calls.map((c) => c.name)).toEqual(["find_route", "jump"]);
  });
});

// ---------------------------------------------------------------------------
// Digest verdict: the briefing owns the lesson (advisory), interpolating the
// fee-model constants from net-trip.ts so prose and model cannot disagree.
// ---------------------------------------------------------------------------

describe("digest net-profit briefing (#112)", () => {
  const ctx: PlanContext = {
    persona: "a trader",
    goals: [],
    wake: { reason: "heartbeat" },
    statusSummary: "credits 100, fuel 50/100, hull 100/100, cargo 1/50, docked",
    recentEvents: [],
  };

  test("names the anti-pattern and interpolates the fee model's own constants", () => {
    const text = buildDigest(ctx);
    expect(text).toContain(`"selling one last item across a paid border"`);
    expect(text).toContain(`${FUEL_PRICE_FLOOR_CR}cr per fuel unit`);
    expect(text).toContain(`${LISTING_FEE_BPS / 100}% listing fee`);
    // The fee facts the reference grounds: no fee on instant fills, customs
    // touch contraband only (markets.md:18; police.md:67-75).
    expect(text).toContain("NO market fee");
    expect(text).toContain("CONTRABAND only");
    // The exemptions are taught, not hidden.
    expect(text).toContain("standing goal or bundles with profitable work");
  });

  test("names the no-trip recovery and the player-driven price caveat (review findings 1+2)", () => {
    const text = buildDigest(ctx);
    // The recovery that needs no trip at all -- the planner must not have to
    // infer it from a generic runbook line.
    expect(text).toContain("list it with create_sell_order and fly on");
    // Catalog value is an estimate, never a bound; a seen bid outranks it.
    expect(text).toContain("PLAYER-DRIVEN");
    expect(text).toContain("catalog value only ESTIMATES");
  });
});
