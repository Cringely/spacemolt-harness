import { REGISTRY } from "../registry/actions";

/**
 * Operator-steer gate for query actions (issue #527).
 *
 * An operator steers the live pilot by POSTing free text to
 * /api/agents/<id>/instruct. That text is spliced into the planner prompt, and
 * the planner's vocabulary is MUTATIONS ONLY -- digest.ts builds ACTION_VOCAB
 * from `REGISTRY.filter(a => a.kind === "mutation")`, and PlanStepSchema is
 * generated from the same filter. So a steer that tells the pilot to run a
 * QUERY action is structurally unplannable: the model either drops it or emits
 * a step the plan schema rejects, the instruction never retires, and it
 * re-raises into every later plan until a human notices and supersedes it.
 * Five occurrences, the last one from the PM's own seat ("Use find_route with
 * id gold_run"). Prose guidance failed five times, so it becomes a gate:
 * reject at the boundary and hand the operator a 400 while they are still
 * typing, instead of a silent multi-hour degradation.
 *
 * Queries are not forbidden in general -- the harness fetches them itself into
 * the briefing. The defect is specifically an operator TELLING THE PILOT to
 * perform one.
 *
 * FALSE POSITIVES ARE THE EXPENSIVE FAILURE. This gate sits between a human
 * and a pilot that may be in trouble; a steer wrongly rejected at 3am is worse
 * than the bug it prevents. Every judgment call below therefore leans toward
 * ACCEPTING an ambiguous steer, and the known false negatives are enumerated
 * rather than closed.
 */

/**
 * The gated set, derived from the registry at module load. Same SSOT and the
 * exact complement of the predicate digest.ts uses for ACTION_VOCAB, so an
 * action that flips `kind` moves between "plannable" and "gated" in one edit
 * with no second list to update. Precomputed once: REGISTRY is a static array
 * with no mutation path anywhere in the codebase, so the sole input is
 * provably constant for the process lifetime (simplicity rule 5).
 *
 * Two structural exclusions, both false-positive defence:
 *   - the catalog action's registry name is the EMPTY STRING (CATALOG_ACTION,
 *     the one endpoint with no action segment). An empty needle is not a word
 *     anyone can type.
 *   - names with no underscore are ordinary English. `view` is the only one
 *     today, and "use the market view I'm looking at" is a steer about the
 *     DASHBOARD, not the game action. Requiring snake_case means the needle is
 *     an identifier a human only writes on purpose. Accepted cost: "use view
 *     on the market" slips through. That is the trade this gate is supposed to
 *     make. The rule is structural, not a hand-maintained skip list, so a
 *     future multi-word query action is gated the day it lands.
 */
export const GATED_QUERY_ACTIONS: readonly string[] = REGISTRY
  .filter((a) => a.kind === "query" && a.name.includes("_"))
  .map((a) => a.name);

const GATED = new Set(GATED_QUERY_ACTIONS);

/**
 * Base-form verbs that make the following words an order. Base form ONLY, on
 * purpose: "run find_route" is a directive, "I ran find_route" is a report of
 * something the operator already did, and English marks the difference with
 * tense. No inflected forms here, ever.
 */
const DIRECTIVE_VERBS = new Set([
  "use", "run", "call", "execute", "perform", "issue", "invoke",
  "do", "try", "check", "query", "fetch", "request", "send", "start",
]);

/**
 * Negation cues. Any of these BEFORE the action mention, in the same sentence,
 * flips the reading from "do this" to "do not do this" -- which is a perfectly
 * good steer and must be accepted. Scoped to before-the-mention rather than
 * anywhere-in-the-sentence so that "Use find_route on gold_run, don't waste
 * fuel" is still caught.
 */
const NEGATIONS = new Set([
  "not", "no", "never", "none", "nor", "without", "avoid", "skip",
  "stop", "disregard", "ignore", "cannot", "dont", "don't", "doesnt",
  "doesn't", "wont", "won't", "cant", "can't", "shouldnt", "shouldn't",
]);

/**
 * A first-person subject in front of the verb makes it narration, not an
 * order: "I use find_route to sanity-check the map" is the operator telling
 * the pilot how THEY work, and rejecting it would be a false positive.
 */
const DESCRIPTIVE_SUBJECTS = new Set(["i", "i've", "i’ve", "ive", "we", "we've", "we’ve", "weve"]);

/**
 * How far in front of the action name a directive verb still binds to it.
 * Three covers "use find_route", "run the find_route action", and "call the
 * game's find_route"; beyond that the verb is plausibly governing a different
 * clause and the safe reading is to accept.
 */
const DIRECTIVE_WINDOW = 3;

const SENTENCE_SPLIT = /[.!?;\n]+/;
// Underscore and apostrophe are word characters here: `find_route` must stay
// one token (so a substring of a longer identifier can never match), and
// `don't` must stay one token (so the negation survives tokenisation).
const TOKEN = /[a-z0-9_'’]+/g;

/**
 * THE RULE, in one sentence: reject only when a registry query action's exact
 * snake_case name appears as a whole word within three words after a
 * base-form directive verb ("use", "run", "call", ...), in a sentence with no
 * negation before that mention and no first-person subject in front of the
 * verb.
 *
 * Deliberately accepted (false negatives, each the price of a false positive
 * avoided): a bare imperative with no verb ("find_route to Duskmere then
 * jump") -- because "find_route returned nothing" has the identical shape and
 * is a report; inflected verbs ("using find_route"); hyphenated or pluralised
 * spellings ("find-route", "find_routes"); the single-word `view` action; and
 * any directive that a negation elsewhere in the sentence makes ambiguous.
 *
 * @returns the offending action name, or null to accept.
 */
export function findDirectedQueryAction(text: string): string | null {
  for (const sentence of text.toLowerCase().split(SENTENCE_SPLIT)) {
    const tokens = sentence.match(TOKEN);
    if (!tokens) continue;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!GATED.has(token)) continue;
      // Negated earlier in this sentence -> the operator is steering the pilot
      // AWAY from the query. Accept.
      if (tokens.slice(0, i).some((t) => NEGATIONS.has(t))) continue;
      for (let j = Math.max(0, i - DIRECTIVE_WINDOW); j < i; j++) {
        if (!DIRECTIVE_VERBS.has(tokens[j]!)) continue;
        if (j > 0 && DESCRIPTIVE_SUBJECTS.has(tokens[j - 1]!)) continue;
        return token;
      }
    }
  }
  return null;
}

// Example mutations for the error body, read from the same registry rather
// than typed into the prose -- an operator following this advice is following
// the actual plannable vocabulary, not a snapshot of it.
const MUTATION_EXAMPLES = REGISTRY
  .filter((a) => a.kind === "mutation")
  .slice(0, 6)
  .map((a) => a.name)
  .join(", ");

/**
 * The 400 body's real payload. An operator who reads only this should be able
 * to fix their steer without opening any docs: it names the offending word,
 * says why it cannot work, and shows the two shapes that do work (an outcome,
 * or a mutation) plus the escape hatch for describing a lookup they already
 * did themselves.
 */
export function queryActionRejectionDetail(action: string): string {
  return (
    `This instruction tells the pilot to run "${action}", which is a QUERY action. ` +
    `The planner can only be told to take MUTATIONS -- actions that change the world ` +
    `(${MUTATION_EXAMPLES}, ...). Query actions are read-only lookups the harness already ` +
    `runs on its own and folds into the pilot's briefing, so a plan step naming one is ` +
    `rejected by the plan schema: the instruction never completes and re-raises into every ` +
    `later plan until a human supersedes it. Rewrite it as the OUTCOME you want ` +
    `("get to a station and refuel") or as the MUTATION to take ("jump to gold_run, then ` +
    `dock and refuel"). If you are describing a lookup you already did yourself, drop the ` +
    `action name and state the fact ("there is a route to gold_run").`
  );
}
