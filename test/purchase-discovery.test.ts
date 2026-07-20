import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { goalPurchaseCandidates } from "../src/agent/goal-items";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Purchase discovery (issue #220). The live incident: the pilot's milestone goal
// was to buy a Deep Core Extractor, and its plan was "mine ore, then dock at the
// Extraction Hub and CHECK FOR the Deep Core Extractor" -- a travel-and-hope
// loop, because view_market (this station, docked) was the only purchase
// discovery it had, so LOOKING and TRAVELLING were the same act.
// estimate_purchase answers the buy-side question for free (no credits, no
// tick), but it is kind:"query" -- unplannable -- so the harness fetches it and
// the digest renders the answer.
//
// GATED ON DOCKED (issue #315, live-falsified 2026-07-17): the "from anywhere"
// framing above described the vendored reference, not reality -- 15 live calls
// while undocked all returned purchase_estimate_error ("You must be docked at
// a station..."). stubApi below defaults `docked: true` so the estimate-flow
// tests exercise the now-gated call; the dedicated undocked test below is the
// one that pins the new invariant.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};
const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

const ESTIMATE_TEXT = "Deep Core Extractor Mk I -- 2 available, total 6,400cr (Haven Exchange 3,200cr each)";

function stubApi(opts: { estimate?: (itemId: string) => Promise<string>; docked?: boolean }) {
  const calls: string[] = [];
  const status: StatusSnapshot = {
    credits: 17306, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: opts.docked ?? true, inTransit: false, dockedAt: null, cargo: [],
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    ...(opts.estimate
      ? { async estimatePurchase(itemId: string) { calls.push(itemId); return opts.estimate!(itemId); } }
      : {}),
  };
  return { api, calls };
}

async function replanWithGoal(goal: string, opts: Parameters<typeof stubApi>[0]) {
  const { api, calls } = stubApi(opts);
  const store = new Store(":memory:");
  const planner = new MockPlanner([okPlan, okPlan]);
  const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });
  await agent.runOnce();          // no_plan wake -> replan (no goals yet)
  agent.instruct(goal);
  await agent.runOnce();          // instruction wake -> replan WITH the goal
  return { ctx: planner.contexts.at(-1)!, calls, store };
}

// Breakage caught: the matcher is the one place a WRONG item id could be
// invented and then fetched/rendered as fact. A goal names a thing, not a tier
// ("a Deep Core Extractor"), so the family case must resolve to the real catalog
// tiers -- and a goal naming nothing catalogued must resolve to nothing at all.
describe("goal item candidates (#220)", () => {
  test("a tier-less goal resolves to the real catalog tiers; an exact tier wins alone", () => {
    const family = goalPurchaseCandidates(["save credits, then buy a Deep Core Extractor"]);
    expect(family.candidates.map((i) => i.id).sort()).toEqual([
      "deep_core_extractor_ii", "deep_core_extractor_iii", "deep_core_extractor_mk_i",
    ]);
    // Naming the tier means that tier -- no family spray.
    expect(goalPurchaseCandidates(["buy a Deep Core Extractor II"]).candidates.map((i) => i.id)).toEqual([
      "deep_core_extractor_ii",
    ]);
    // The snake_case id the operator might paste from the catalog also matches.
    expect(goalPurchaseCandidates(["buy deep_core_extractor_ii"]).candidates.map((i) => i.id)).toEqual([
      "deep_core_extractor_ii",
    ]);
  });

  test("goals naming no catalog item resolve to NOTHING (never a guess)", () => {
    expect(goalPurchaseCandidates(["get rich and make friends"]).candidates).toEqual([]);
    expect(goalPurchaseCandidates([]).candidates).toEqual([]);
    // "extractor" alone is not an item name: no substring/fuzzy matching.
    expect(goalPurchaseCandidates(["buy an extractor"]).candidates).toEqual([]);
  });

  // CHOSEN STRICTNESS, not a bug (PM decision, PR #304): plural prose does not
  // match the singular catalog name "Fuel Cell". The contract is the documented
  // convention (agents.example.yaml): name the exact catalog name or id --
  // production goal strings embed the raw id in parens, which matches
  // regardless of prose plurals. The old substring matcher tolerated plurals
  // only by accident of the #216 bug; loosening this again is a decision, not
  // a fix.
  test("plural prose does not match the singular catalog name (strict by design)", () => {
    expect(goalPurchaseCandidates(["buy some fuel cells"]).candidates).toEqual([]);
    // The guaranteed path: the exact name or the raw id in parens.
    expect(goalPurchaseCandidates(["buy some fuel cells (fuel_cell)"]).candidates.map((i) => i.id)).toEqual([
      "fuel_cell",
    ]);
  });

  // Breakage caught (#216, strategy review 2026-07-16 22:19Z): roman-numeral
  // tiers are substrings of each other ("mining laser i" sits inside "mining
  // laser iii"), so the naive includes() matcher turned the two live milestone
  // goals into FOUR exact hits (mining_laser_i, _ii, _iii + the extractor),
  // overflowed MAX_CANDIDATES=3, and the whole-list guard silently returned []
  // -- zero estimate_purchase calls across 15/15 live replans. A match must be
  // whole-phrase: an id that is merely a prefix of a longer id present in the
  // text is not named by the goal.
  test("the two live milestone goals resolve to exactly their two items; lower tiers never substring-match (#216)", () => {
    const goals = [
      "Milestone step 1: buy a Deep Core Extractor Mk I (deep_core_extractor_mk_i, ~3,000cr) and fit it",
      "Milestone step 2 (after step 1): save up and buy a Mining Laser III (mining_laser_iii, ~8,000cr)",
    ];
    const { candidates, dropped } = goalPurchaseCandidates(goals);
    expect(candidates.map((i) => i.id)).toEqual(["deep_core_extractor_mk_i", "mining_laser_iii"]);
    expect(dropped).toEqual([]);
  });

  // Breakage caught: the overflow mode itself. Pre-#216-fix, more hits than
  // MAX_CANDIDATES dropped the WHOLE list with no signal -- the silence that
  // hid the bug for a day. A legitimate tier-less goal over a 5-tier family
  // (Mining Laser I..V) must keep the first MAX_CANDIDATES and report the cut
  // ids, never zero out.
  test("overflow truncates (first-named first) and reports the cut ids instead of silently zeroing", () => {
    const { candidates, dropped } = goalPurchaseCandidates(["buy a Mining Laser"]);
    expect(candidates.map((i) => i.id)).toEqual(["mining_laser_i", "mining_laser_ii", "mining_laser_iii"]);
    expect(dropped).toEqual(["mining_laser_iv", "mining_laser_v"]);
  });
});

describe("Agent purchase discovery (#220)", () => {
  // Breakage caught: a docked replan still estimates the goal item and the
  // digest still renders cost + the anti-tour instruction (the #220 payoff
  // survives the #315 dock gate).
  test("a docked replan estimates the goal item and the digest renders cost + the never-travel-to-look rule", async () => {
    const { ctx, calls } = await replanWithGoal("save for a Deep Core Extractor II", {
      estimate: async () => ESTIMATE_TEXT,
    });
    expect(calls).toEqual(["deep_core_extractor_ii"]); // docked, one free query
    expect(ctx.purchaseEstimates).toEqual([
      { itemId: "deep_core_extractor_ii", name: "Deep Core Extractor II", text: ESTIMATE_TEXT },
    ]);
    const digest = buildDigest(ctx);
    expect(digest).toContain("live estimate_purchase"); // the section, not the runbook's reference to it
    expect(digest).toContain("buy id: deep_core_extractor_ii");
    expect(digest).toContain("3,200cr each");
    expect(digest).toMatch(/NEVER travel to a station merely to LOOK/);
  });

  // Breakage caught (issue #315): the producer fix itself -- an undocked
  // replan must skip the estimate_purchase call entirely (it live-falsified to
  // "You must be docked at a station..." 15/15 times), not fire it and eat the
  // error. Same goal as the docked test above, only the dock state differs.
  test("an undocked replan makes NO estimate_purchase call at all (issue #315 dock gate)", async () => {
    const { ctx, calls, store } = await replanWithGoal("save for a Deep Core Extractor II", {
      estimate: async () => ESTIMATE_TEXT,
      docked: false,
    });
    expect(calls).toEqual([]); // the call itself is skipped, not attempted-and-caught
    expect(ctx.purchaseEstimates).toBeUndefined();
    const digest = buildDigest(ctx);
    expect(digest).not.toContain("live estimate_purchase");
    expect(store.recentEvents("a1", 20).filter((e) => e.type === "purchase_estimate_error").length).toBe(0);
  });

  // Breakage caught (M-34, the false-verdict class): a failed or absent estimate
  // must render NOTHING. Inverting missing data into "not purchasable" would
  // teach the pilot its milestone module does not exist -- worse than the tour.
  test("a failed estimate emits purchase_estimate_error, renders NO purchase section, and never claims unavailable", async () => {
    const { ctx, store } = await replanWithGoal("save for a Deep Core Extractor II", {
      estimate: async () => { throw new Error("market query down"); },
    });
    expect(ctx.purchaseEstimates).toBeUndefined();
    const digest = buildDigest(ctx);
    expect(digest).not.toContain("live estimate_purchase"); // no section rendered at all
    expect(digest).not.toMatch(/no seller|not purchasable|unavailable/i);

    const events = store.recentEvents("a1", 20).filter((e) => e.type === "purchase_estimate_error");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ itemId: "deep_core_extractor_ii", message: "market query down" });
  });

  // Breakage caught (M-34, the other half): an EMPTY answer is not a failure and
  // not a verdict either. The game returning "" (or whitespace) must render NO
  // section -- rendering an empty estimate would read as "no sellers", teaching
  // the pilot its milestone item is unbuyable. Distinct from the throw path
  // above: no error is emitted, because nothing went wrong.
  test("an EMPTY estimate renders NO purchase section and emits no error (absence is not a verdict)", async () => {
    const { ctx, store } = await replanWithGoal("save for a Deep Core Extractor II", {
      estimate: async () => "",
    });
    expect(ctx.purchaseEstimates).toBeUndefined();
    const digest = buildDigest(ctx);
    expect(digest).not.toContain("live estimate_purchase");
    expect(digest).not.toContain("deep_core_extractor_ii");
    expect(digest).not.toMatch(/no seller|not purchasable|unavailable/i);
    // Nothing failed -- an empty answer is not an error.
    expect(store.recentEvents("a1", 20).filter((e) => e.type === "purchase_estimate_error").length).toBe(0);
  });

  // Breakage caught: a goal naming no item must cost NO game query -- this runs
  // on every replan, on the pilot's hot path.
  test("a goal naming no catalog item makes no estimate call at all", async () => {
    const { ctx, calls } = await replanWithGoal("get rich and make friends", {
      estimate: async () => ESTIMATE_TEXT,
    });
    expect(calls).toEqual([]);
    expect(ctx.purchaseEstimates).toBeUndefined();
  });

  // Breakage caught: the caller half of the overflow remedy (#216) -- the kept
  // candidates must still be estimated, and the cut must surface in the event
  // feed (once per overflowing replan), not vanish.
  test("an overflowing goal still estimates the kept candidates and emits purchase_candidate_overflow", async () => {
    const { calls, store } = await replanWithGoal("buy a Mining Laser", {
      estimate: async () => ESTIMATE_TEXT,
    });
    expect(calls).toEqual(["mining_laser_i", "mining_laser_ii", "mining_laser_iii"]);
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "purchase_candidate_overflow");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({
      kept: ["mining_laser_i", "mining_laser_ii", "mining_laser_iii"],
      dropped: ["mining_laser_iv", "mining_laser_v"],
    });
  });
});
