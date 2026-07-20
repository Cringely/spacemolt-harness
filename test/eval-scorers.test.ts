import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadCases } from "../src/eval/cases";
import { scorePlan, scoreGoalDiversity, normalizeGoal, THRASH_WINDOW } from "../src/eval/scorers";
import { scoreRecorded } from "../src/eval/run";
import type { EvalCase, ScoreResult } from "../src/eval/types";

// THE SM-9 REPLAY (issue #263). SM-9 (2026-07-14) put a local model on the live
// pilot and learned in 15 minutes that it ignores the digest's structured
// markers. Every failure it committed is replayed here through the scorers, and
// every one must be CAUGHT. This is the ablation: break a scorer, and the exact
// live incident it exists to prevent stops being detected -- loudly, here,
// offline, for free.

export const CASES_PATH = join(import.meta.dir, "fixtures", "eval-cases.json");
const CASES = loadCases(CASES_PATH);

function caseById(id: string): EvalCase {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`fixture case not found: ${id}`);
  return c;
}

function scoresFor(id: string): ScoreResult[] {
  const c = caseById(id);
  if (!c.recordedPlan) throw new Error(`case ${id} has no recorded plan`);
  return scorePlan(c.recordedPlan, c);
}

function verdict(scores: ScoreResult[], scorer: string): ScoreResult {
  const s = scores.find((x) => x.scorer === scorer);
  if (!s) throw new Error(`no such scorer: ${scorer}`);
  return s;
}

describe("SM-9 replay: the scorers catch every failure the live incident produced", () => {
  test("dock at a POI the state marks with no [station] (M-21 class, SM-9 did it 3x)", () => {
    const s = scoresFor("sm9-1-full-hold-no-station");
    expect(verdict(s, "dock_requires_station").verdict).toBe("fail");
    expect(verdict(s, "dock_requires_station").reason).toContain("[station]");
  });

  test("mine into a FULL cargo hold (SM-9; the sonnet plan on the same state sold first)", () => {
    const s = scoresFor("sm9-1-full-hold-no-station");
    expect(verdict(s, "no_mine_into_full_hold").verdict).toBe("fail");
    expect(verdict(s, "no_mine_into_full_hold").reason).toContain("100/100");
  });

  test("travel_to an INVENTED system id ('trappist_prime_belt' -> Target system not found)", () => {
    const s = scoresFor("sm9-2-invented-system-id");
    expect(verdict(s, "known_system_ref").verdict).toBe("fail");
    expect(verdict(s, "known_system_ref").reason).toContain("trappist_prime_belt");
  });

  test("mine at a gas POI with only a mining laser fitted (#253 markers ignored)", () => {
    const s = scoresFor("sm9-3-mine-wrong-extraction");
    const v = verdict(s, "mine_needs_matching_module");
    expect(v.verdict).toBe("fail");
    expect(v.reason).toContain("gas_harvester");
  });

  test("item id derived from prose: 'fuel_cells' is not a catalog item, 'fuel_cell' is (#179)", () => {
    const s = scoresFor("prose-item-id-fuel-cells");
    expect(verdict(s, "known_item_id").verdict).toBe("fail");
    expect(verdict(s, "known_item_id").reason).toContain("fuel_cells");
  });

  test("invented action name ('Sell cargo') and a sell with no quantity", () => {
    const s = scoresFor("invented-action-and-bad-params");
    expect(verdict(s, "known_action").verdict).toBe("fail");
    expect(verdict(s, "required_params").verdict).toBe("fail");
  });

  // Added in the PR #267 review: known_poi_ref survived its own ablation (break
  // it, 21/21 still green) because nothing asserted a FAIL on it. A scorer no
  // test can break is decoration, and this eval GATES which model flies the
  // pilot. This is the case that pins it -- the maiden flight's own incident.
  test("travel to an INVENTED POI id ('alpha_mining', the maiden-flight hallucination)", () => {
    const s = scoresFor("maiden-invented-poi");
    const v = verdict(s, "known_poi_ref");
    expect(v.verdict).toBe("fail");
    expect(v.reason).toContain("alpha_mining");
    // And it is the ONLY scorer that can see this defect: the plan is otherwise
    // clean (real action, valid params, empty hold, laser fitted). Neuter this
    // scorer and the eval scores a guaranteed-error plan 100%.
    expect(s.filter((x) => x.verdict === "fail").map((x) => x.scorer)).toEqual(["known_poi_ref"]);
  });

  test("three consecutive blocked wakes with the same goal -- the thrash the progress latch was blind to", () => {
    const report = scoreRecorded(CASES.filter((c) => c.id.startsWith("sm9-")));
    expect(report.thrash.verdict).toBe("fail");
    expect(report.thrash.reason).toContain("3 consecutive");
  });
});

// The other half of the eval's value, and the harder half: a scorer that cries
// wolf is worse than no scorer, because a model comparison built on false
// failures picks the wrong model. M-34: a check that cannot evaluate ABSTAINS.
describe("no false positives: a known-good plan is never failed", () => {
  test("sonnet's recovery plan on a full hold at a station that buys the ore", () => {
    const s = scoresFor("good-sonnet-sell-docked");
    expect(s.filter((x) => x.verdict === "fail")).toEqual([]);
    // It really did sell + list a real item -- not merely abstain its way to clean.
    expect(verdict(s, "known_item_id").verdict).toBe("pass");
    expect(verdict(s, "required_params").verdict).toBe("pass");
  });

  test("a correct mining plan PASSES the location and extraction scorers, it does not abstain them", () => {
    const s = scoresFor("good-sonnet-mine-belt");
    expect(s.filter((x) => x.verdict === "fail")).toEqual([]);
    expect(verdict(s, "known_poi_ref").verdict).toBe("pass");
    expect(verdict(s, "mine_needs_matching_module").verdict).toBe("pass");
    expect(verdict(s, "known_system_ref").verdict).toBe("pass"); // travel_to market_prime, a real system
  });

  test("a state with no map data ABSTAINS the map scorers instead of failing the plan", () => {
    const thin: EvalCase = {
      id: "thin",
      ctx: {
        persona: "p", goals: [], wake: { reason: "no_plan" },
        statusSummary: "status unavailable", recentEvents: [],
      },
    };
    const s = scorePlan({ goal: "g", steps: [{ action: "dock", params: {} }, { action: "mine", params: {} }] }, thin);
    expect(s.filter((x) => x.verdict === "fail")).toEqual([]);
    expect(verdict(s, "dock_requires_station").verdict).toBe("abstain");
    expect(verdict(s, "mine_needs_matching_module").verdict).toBe("abstain");
    expect(verdict(s, "no_mine_into_full_hold").verdict).toBe("abstain");
  });

  test("a dock AFTER leaving the system is not scored -- the destination is unknowable from this state", () => {
    const c = caseById("sm9-1-full-hold-no-station"); // a system with no station at all
    const s = scorePlan(
      { goal: "leave and sell", steps: [{ action: "travel_to", params: { system_id: "market_prime" } }, { action: "dock", params: {} }] },
      c,
    );
    expect(verdict(s, "dock_requires_station").verdict).toBe("abstain");
  });
});

// The sequence-coherence hole PR #267 left open (issue #268): every per-step
// scorer can pass while the plan disposes of cargo it never had. These pin the
// scorer that closes it.
describe("cargo coherence (#268): a plan incoherent as a SEQUENCE is caught, a coherent one is not", () => {
  test("sell an item the hold never held, BEFORE any mine (the 'sell before mining anything' class)", () => {
    const s = scoresFor("cargo-incoherent-sell-before-mine");
    const v = verdict(s, "cargo_coherence");
    expect(v.verdict).toBe("fail");
    expect(v.reason).toContain("titanium_ore");
    // The ablation, in one assertion: cargo_coherence is the ONLY scorer that
    // can see this defect. Every step is a real action with valid params at a
    // real place, into a hold with room -- neuter this scorer and a plan that
    // sells phantom cargo scores a clean 100%.
    expect(s.filter((x) => x.verdict === "fail").map((x) => x.scorer)).toEqual(["cargo_coherence"]);
  });

  test("no false positive: a real sonnet plan that sells + lists items IT HOLDS passes, not merely abstains", () => {
    const s = scoresFor("good-sonnet-sell-docked");
    expect(verdict(s, "cargo_coherence").verdict).toBe("pass");
  });

  test("a mine BEFORE the sell makes the hold's contents unprovable -- it must not fail (M-34)", () => {
    const c = caseById("cargo-incoherent-sell-before-mine"); // hold holds only palladium
    // Same phantom titanium sell, but now a mine precedes it: the mine could
    // have supplied the titanium, so the shortfall is no longer provable.
    const s = scorePlan(
      {
        goal: "mine then sell",
        steps: [
          { action: "travel", params: { id: "bunda_belt" } },
          { action: "mine", params: {}, until: "cargo_full" },
          { action: "sell", params: { id: "titanium_ore", quantity: 50 } },
        ],
      },
      c,
    );
    expect(verdict(s, "cargo_coherence").verdict).toBe("abstain");
  });

  test("repeat:N multiplies the removal -- selling N of an item the hold holds 1 of FAILs (#349)", () => {
    // Hold holds ONE titanium_ore. A bare `sell` scores clean (removes 1); the
    // executor fires a `repeat:5` sell FIVE times (executor.ts:752), removing 5.
    // Counting 1 was the false NEGATIVE this fixes.
    const oneTitanium: EvalCase = {
      id: "one-titanium",
      ctx: {
        persona: "p", goals: [], wake: { reason: "no_plan" },
        statusSummary: "docked", recentEvents: [],
        cargo: { used: 1, capacity: 50, items: [{ itemId: "titanium_ore", name: "Titanium Ore", quantity: 1 }] },
      },
    };
    const repeated = scorePlan(
      { goal: "g", steps: [{ action: "sell", params: { id: "titanium_ore" }, repeat: 5 }] },
      oneTitanium,
    );
    expect(verdict(repeated, "cargo_coherence").verdict).toBe("fail");
    expect(verdict(repeated, "cargo_coherence").reason).toContain("sells 5");
    // The same step WITHOUT repeat removes exactly 1 -> coherent.
    const bare = scorePlan(
      { goal: "g", steps: [{ action: "sell", params: { id: "titanium_ore" } }] },
      oneTitanium,
    );
    expect(verdict(bare, "cargo_coherence").verdict).toBe("pass");
  });

  test("until (cargo_empty) drains the item -- a later sell of what it drained FAILs (#349)", () => {
    // `sell X until cargo_empty` loops until the hold empties (executor.ts:751),
    // so it disposes of the WHOLE titanium holding, not one unit. A later sell of
    // titanium then references a hold the first step drained. Counting the until
    // sell as a single unit left 2 behind and false-PASSed the second sell.
    const threeTitanium: EvalCase = {
      id: "three-titanium",
      ctx: {
        persona: "p", goals: [], wake: { reason: "no_plan" },
        statusSummary: "docked", recentEvents: [],
        cargo: { used: 3, capacity: 50, items: [{ itemId: "titanium_ore", name: "Titanium Ore", quantity: 3 }] },
      },
    };
    const s = scorePlan(
      {
        goal: "g",
        steps: [
          { action: "sell", params: { id: "titanium_ore" }, until: "cargo_empty" },
          { action: "sell", params: { id: "titanium_ore", quantity: 2 } },
        ],
      },
      threeTitanium,
    );
    expect(verdict(s, "cargo_coherence").verdict).toBe("fail");
    expect(verdict(s, "cargo_coherence").reason).toContain("titanium_ore");
  });

  test("a buy with repeat:N supplies a matching repeat:N sell -- no false FAIL on the add side (#349)", () => {
    // Buy 1 titanium five times, sell 1 titanium five times: coherent. If the buy
    // add ignored repeat (added 1) while the sell removal honored it (needed 5),
    // the sim would false-FAIL a legitimate arbitrage plan.
    const emptyHold: EvalCase = {
      id: "empty-hold",
      ctx: {
        persona: "p", goals: [], wake: { reason: "no_plan" },
        statusSummary: "docked", recentEvents: [],
        cargo: { used: 0, capacity: 50, items: [] },
      },
    };
    const s = scorePlan(
      {
        goal: "g",
        steps: [
          { action: "buy", params: { id: "titanium_ore", quantity: 1 }, repeat: 5 },
          { action: "sell", params: { id: "titanium_ore" }, repeat: 5 },
        ],
      },
      emptyHold,
    );
    expect(verdict(s, "cargo_coherence").verdict).toBe("pass");
  });

  test("buy until:cargo_full fills only the REMAINING hold -- a second until-buy that overflows is caught (#349)", () => {
    const emptyHold: EvalCase = {
      id: "empty-hold-50",
      ctx: {
        persona: "p", goals: [], wake: { reason: "no_plan" },
        statusSummary: "docked", recentEvents: [],
        cargo: { used: 0, capacity: 50, items: [] },
      },
    };
    // Happy path: `buy X until cargo_full` fills the hold with X, so a later
    // sell of what it bought is coherent (this buy-until path was untested).
    const coherent = scorePlan(
      {
        goal: "g",
        steps: [
          { action: "buy", params: { id: "palladium_ore" }, until: "cargo_full" },
          { action: "sell", params: { id: "palladium_ore", quantity: 30 } },
        ],
      },
      emptyHold,
    );
    expect(verdict(coherent, "cargo_coherence").verdict).toBe("pass");
    // Overflow: the first until-buy fills all 50, so the second adds NOTHING (no
    // room left). A later sell of the second item is then provably short. The
    // pre-fix code added a full capacity per until-buy, so BOTH "fit" a 50-cap
    // hold -- a false PASS on an unshippable overflow plan.
    const overflow = scorePlan(
      {
        goal: "g",
        steps: [
          { action: "buy", params: { id: "palladium_ore" }, until: "cargo_full" },
          { action: "buy", params: { id: "titanium_ore" }, until: "cargo_full" },
          { action: "sell", params: { id: "titanium_ore", quantity: 10 } },
        ],
      },
      emptyHold,
    );
    expect(verdict(overflow, "cargo_coherence").verdict).toBe("fail");
    expect(verdict(overflow, "cargo_coherence").reason).toContain("titanium_ore");
  });

  test("unknown starting cargo ABSTAINS, never fails -- absence of data is not a negative verdict (M-34)", () => {
    const noCargo: EvalCase = {
      id: "no-cargo",
      ctx: {
        persona: "p", goals: [], wake: { reason: "no_plan" },
        statusSummary: "status unavailable", recentEvents: [],
      },
    };
    const s = scorePlan({ goal: "g", steps: [{ action: "sell", params: { id: "titanium_ore", quantity: 10 } }] }, noCargo);
    expect(verdict(s, "cargo_coherence").verdict).toBe("abstain");
    expect(s.filter((x) => x.verdict === "fail")).toEqual([]);
  });
});

describe("goal diversity (thrash signal)", () => {
  test("only BLOCKED wakes count: repeating a goal after a plan completes is continuing a strategy", () => {
    const entries = Array.from({ length: 5 }, () => ({ wakeReason: "plan_done", goal: "mine titanium" }));
    expect(scoreGoalDiversity(entries).verdict).toBe("abstain");
  });

  test(`fewer than ${THRASH_WINDOW} blocked wakes abstains -- too little evidence to call thrash`, () => {
    const entries = [
      { wakeReason: "blocked", goal: "mine titanium at bunda belt" },
      { wakeReason: "blocked", goal: "mine titanium at bunda belt" },
    ];
    expect(scoreGoalDiversity(entries).verdict).toBe("abstain");
  });

  test("cosmetic rewording of the same goal is still thrash (normalized comparison)", () => {
    const entries = [
      { wakeReason: "blocked", goal: "Mine Titanium at Bunda Belt" },
      { wakeReason: "blocked", goal: "mine titanium at bunda belt!" },
      { wakeReason: "blocked", goal: "Mine  titanium  at  Bunda  Belt." },
    ];
    expect(scoreGoalDiversity(entries).verdict).toBe("fail");
    expect(normalizeGoal("Mine  Titanium at Bunda Belt!")).toBe("mine titanium at bunda belt");
  });

  test("a planner that adapts after each block passes", () => {
    const entries = [
      { wakeReason: "blocked", goal: "mine titanium at bunda belt" },
      { wakeReason: "blocked", goal: "travel to market prime and sell the ore" },
      { wakeReason: "blocked", goal: "list palladium on the exchange" },
    ];
    expect(scoreGoalDiversity(entries).verdict).toBe("pass");
  });
});
