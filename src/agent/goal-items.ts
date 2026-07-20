import { catalog, type ItemMeta } from "../catalog/catalog";

// Purchase discovery (issue #220): which catalog item(s) do the operator's
// goals actually name?
//
// The live incident: the pilot's milestone goal was to buy a Deep Core
// Extractor, and its plan was "mine ore, then dock at the Extraction Hub and
// CHECK FOR the Deep Core Extractor" -- a travel-and-hope loop. The game's
// estimate_purchase answers "is it purchasable, how much, from whom" for free
// with no dock and no travel, but it is kind:"query" (actions.ts) and the
// planner structurally cannot plan a query (PlanSchema, plan.ts). So the
// harness must fetch it -- and to fetch it, the harness needs an item id.
//
// The item source is the goal text itself, matched against the catalog (the
// item SSOT, src/catalog/catalog.ts). Receipt for the alternative: an explicit
// `goal_item` field in agents.yaml would be exact, but it adds a config knob
// for a value the goal text already carries and it would have to be kept in
// sync with the goal by hand -- a second SSOT for the same fact.
//
// NEVER GUESS is the whole discipline here (M-34): a match must be something
// the operator literally wrote. Two match forms, both literal:
//   1. exact  -- the goal text contains a catalog item's name or id
//                ("buy a Deep Core Extractor Mk I", "buy deep_core_extractor_ii").
//   2. family -- the goal text contains a catalog name with its TIER suffix
//                stripped ("Deep Core Extractor" -> the Mk I / II / III items).
//                A goal names the thing, not the tier; all members of the family
//                are real candidates and the harness estimates each, so the
//                planner is handed facts for every one and picks. This is not a
//                guess: every candidate's name is in the goal text verbatim.
// Family matches are used only when there is no exact match (a goal naming an
// exact tier means that tier). "Contains" is WHOLE-PHRASE, token-bounded --
// never raw substring. Issue #216: roman-numeral tiers are substrings of each
// other ("mining laser i" sits inside "mining laser iii"), so a naive
// includes() matched every lower tier of a named item, overflowed
// MAX_CANDIDATES, and the drop-all overflow guard of the day silently
// disabled purchase estimates entirely.
//
// Strict by design, not a gap: plural prose ("buy some fuel cells") does not
// match "Fuel Cell". The documented convention (agents.example.yaml) is to name
// the exact catalog name or id; production goal strings embed the raw id in
// parens, which matches regardless of prose plurals. The old substring
// tolerance for loose prose was an accident of the #216 bug, not a feature.
//
// Overflow past MAX_CANDIDATES truncates (first-named goals win; within a
// family, catalog tier order) and REPORTS the cut via `dropped` -- the caller
// makes it visible. The pre-#216 mode dropped the whole list with no signal
// ("too vague to act on"), and that silence hid the matcher bug for a day and
// zeroed out legitimate goals over 4+-tier families ("buy a Mining Laser" has
// five tiers). Partial facts beat no facts, and a reported cut beats silence.

/** Free queries, but this runs on the replan path -- keep the fan-out tiny. */
export const MAX_CANDIDATES = 3;

/** Trailing tier markers on module names: "Mk I", "II", "III", "V". */
const TIER_SUFFIX = /\s+(?:mk\s+)?[ivx]+$/;

/**
 * Lowercase; underscores and punctuation -> spaces; collapse whitespace. Ids,
 * names, and goal prose all reduce to plain space-separated word tokens, so
 * "(mining_laser_iii," in goal prose and the name "Mining Laser III" normalize
 * to the same phrase.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Does `text` contain `phrase` as a WHOLE token-bounded phrase? Space-padding
 * both sides makes token boundaries mandatory: "mining laser i" does not match
 * inside "mining laser iii" (#216). Both strings must already be normalized.
 */
function phraseIn(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

export interface GoalPurchaseMatches {
  /** Items the goals literally name, capped at MAX_CANDIDATES (first-named first). */
  candidates: ItemMeta[];
  /**
   * Ids that matched but were cut by the cap. Non-empty means the goals name
   * more items than one replan estimates -- the caller must surface it
   * (silent truncation is the failure mode that hid #216).
   */
  dropped: string[];
}

/**
 * Catalog items the operator's goals literally name. `candidates` is capped at
 * MAX_CANDIDATES; anything cut by the cap is reported in `dropped`. Empty
 * candidates when the goals name no catalog item at all.
 */
export function goalPurchaseCandidates(goals: string[], items: ItemMeta[] = catalog.items()): GoalPurchaseMatches {
  // Per-goal texts (not joined): a phrase must never straddle two goals.
  const texts = goals.map(normalize).filter((t) => t.length > 0);
  if (!texts.length) return { candidates: [], dropped: [] };

  // Index of the earliest goal containing `phrase` as a whole token-bounded
  // phrase, or -1. Earlier goal = higher priority on truncation.
  const firstGoal = (phrase: string): number => texts.findIndex((t) => phraseIn(t, phrase));

  type Hit = { item: ItemMeta; goal: number };
  const exact: Hit[] = [];
  const family: Hit[] = [];
  for (const item of items) {
    const name = item.name ? normalize(item.name) : "";
    const id = normalize(item.id);
    const g = name ? firstGoal(name) : -1;
    const pos = g >= 0 ? g : firstGoal(id);
    if (pos >= 0) {
      exact.push({ item, goal: pos });
      continue;
    }
    const base = name.replace(TIER_SUFFIX, "");
    // The strip must have removed something and left a real phrase -- otherwise
    // a one-word item ("iron ore" has no tier) would family-match on itself,
    // which the exact pass already covers.
    if (base && base !== name) {
      const b = firstGoal(base);
      if (b >= 0) family.push({ item, goal: b });
    }
  }

  // Stable sort by goal index ALONE: items sharing a goal keep catalog (push)
  // order, which is exactly the documented tie-break -- family members of one
  // base all resolve the same phrase to the same goal, so catalog tier order
  // holds within a family. Array.prototype.sort is stable per the spec.
  const hits = (exact.length ? exact : family).sort((a, b) => a.goal - b.goal);
  return {
    candidates: hits.slice(0, MAX_CANDIDATES).map((h) => h.item),
    dropped: hits.slice(MAX_CANDIDATES).map((h) => h.item.id),
  };
}
