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
 * a step the plan schema rejects. Nothing marks the instruction done, so it
 * re-raises into every later plan until a human notices and supersedes it, or
 * until five newer steers evict it from the goal window (agent.ts MAX_GOALS).
 * In practice that is the rest of the session.
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
export const DIRECTIVE_VERBS = new Set([
  "use", "run", "call", "execute", "perform", "issue", "invoke",
  "do", "try", "check", "query", "fetch", "request", "send", "start",
]);

/**
 * Negation cues. Any of these between the verb and the action mention flips
 * the reading from "do this" to "do not do this" -- a perfectly good steer
 * that must be accepted. "do not run find_route" is the shape: the clause does
 * open with a directive verb, and only the negation tells it apart from a real
 * order.
 */
const NEGATIONS = new Set([
  "not", "no", "never", "none", "nor", "without", "avoid", "skip",
  "stop", "disregard", "ignore", "cannot", "dont", "don't", "doesnt",
  "doesn't", "wont", "won't", "cant", "can't", "shouldnt", "shouldn't",
]);

/**
 * How far after the directive verb the action name still binds to it. Three
 * covers "use find_route", "run the find_route action", and "call the game's
 * find_route"; beyond that the name is plausibly the object of something else
 * and the safe reading is to accept.
 */
const DIRECTIVE_WINDOW = 3;

/**
 * Small words that can sit in FRONT of an imperative without changing that it
 * is one: "then run get_status" is the same order as "run get_status". The
 * matcher skips them when it looks for the clause-initial verb.
 *
 * They are a skipped LEAD-IN, not a clause boundary. A previous revision made
 * them boundaries, on the reasoning that one mechanism could do both jobs --
 * catching "dock and refuel. then run get_nearby" AND "dock and run
 * get_status". It does, and the second job costs far more than it pays,
 * because a boundary STRANDS whatever preceded the joiner:
 *
 *   "Do not dock and run get_status."  -> the negation is in clause 1, the
 *      matcher only ever sees "run get_status", and a steer telling the pilot
 *      to STAY PUT is rejected as an order.
 *   "I handle the routing and run find_route before every steer." -> the
 *      subject is in clause 1, so first-person narration reads as an order.
 *
 * Measured on 63 steers (the suite below plus a reviewer attack set): as a
 * boundary, 18 false positives; as a lead-in, 4. The boundary bought exactly
 * two true rejects. See the trade recorded in KNOWN LIMITS.
 *
 * The punctuation split stays, and the comma and colon matter as much as the
 * full stop: "check your fuel, get_status said 2 units left" is a report
 * riding on the back of an unrelated imperative, and splitting only on [.!?;]
 * rejected it.
 *
 * Exported so the test iterates this array rather than a copy of it: a joiner
 * added here is covered the moment it is added.
 */
export const LEAD_IN_JOINERS: readonly string[] = ["please", "then", "now", "also", "and", "first", "next"];

const JOINERS = new Set(LEAD_IN_JOINERS);
const CLAUSE_BREAK = /[.!?;,:\n]+/;
// Underscore and apostrophe are word characters here: `find_route` must stay
// one token (so a substring of a longer identifier can never match), and
// `don't` must stay one token (so the negation survives tokenisation).
const TOKEN = /[a-z0-9_'’]+/g;

/**
 * THE RULE, in one sentence: reject only when a clause BEGINS -- after any
 * lead-in joiner -- with a base-form directive verb, and a gated action name
 * falls within the next three words with no negation in between.
 *
 * Clause-initial is the whole idea, and it is what makes the rule small. An
 * imperative in English starts its clause -- that is what distinguishes an
 * order from every other thing a sentence can do with the same verb. So the
 * position of the verb carries the work that an earlier revision tried to do
 * with lookaside lists, and those lists are gone:
 *
 *   - No first-person guard. A clause that begins "I ...", "we ...", "your
 *     last instruction ..." does not begin with a base verb, so narration is
 *     excluded by construction rather than by a set of pronouns that one
 *     adverb ("I ALREADY use find_route") walked straight past.
 *   - No backward scan for the verb. Looking three words back from the name
 *     found verbs sitting in someone else's clause; looking forward from a
 *     clause-initial verb cannot.
 *   - Negation is checked only between the verb and the name, not across the
 *     whole sentence, which is what let "run find_route; that was my mistake,
 *     drop it" -- the operator's own remedy for this very bug -- be rejected.
 *
 * KNOWN LIMITS, accepted rather than closed. This list is meant to be
 * EXHAUSTIVE -- it is the whole value of the block, so a shape that starts
 * rejecting wrongly gets added here rather than left for the next reader to
 * rediscover at 3am. Three shapes reject wrongly today, and all three would
 * cost a list of report-verbs or dashboard-nouns to fix, which is more
 * mechanism than the failure is worth:
 *
 *   1. Pasted log or error text where the quoted line is itself an imperative:
 *      "Fix this: call find_route failed with no_route." The operator is
 *      quoting the game, not ordering the pilot, but the quoted fragment is
 *      shaped exactly like an order.
 *   2. Dashboard talk that names a panel after an imperative: "check the
 *      get_map panel on my dashboard". Genuinely ambiguous -- the same words
 *      are a real directive if there is no dashboard.
 *   3. A clause that opens with a lead-in joiner and then uses a base-form
 *      verb as a NOUN: "Then use find_route was the old steer, ignore it."
 *      Skipping the joiner lands the matcher on `use`, which is doing subject
 *      duty, not ordering anything. Present under the old boundary rule too,
 *      so this is a pre-existing limit made visible, not a regression.
 *
 * In all three the operator gets a 400 that names the offending word and
 * shows the rewrite, so the cost is one rephrase, not a silent failure.
 *
 * Deliberately accepted false negatives, each the price of a false positive
 * avoided: a bare imperative with no verb ("find_route to Duskmere then jump")
 * -- because "find_route returned nothing" has the identical shape and is a
 * report; inflected verbs ("using find_route"); hyphenated or pluralised
 * spellings; and the single-word `view` action.
 *
 * TWO MORE FALSE NEGATIVES, BOUGHT ON PURPOSE in the revision that made the
 * joiners a lead-in rather than a clause boundary. Both of these are real
 * orders and both are now accepted:
 *
 *     "dock and run get_status"
 *     "jump to gold_run then call view_market"
 *
 * A second imperative hanging off a joiner MID-CLAUSE is no longer seen. That
 * is the deal, stated as a decision rather than left as a gap: the boundary
 * rule that caught these two also rejected 16 legitimate steers out of a
 * 63-steer corpus -- every "do not X and run <query>" (the negation strands in
 * the clause before the joiner) and every "I do X myself and run <query>" (the
 * subject strands the same way). Four false positives remain under the lead-in
 * rule. Against a gate whose stated premise is that FALSE POSITIVES ARE THE
 * EXPENSIVE FAILURE, and which already accepts worse false negatives than
 * these two, 14 recovered steers for 2 missed orders is the right side of the
 * trade. Full measurement in docs/decisions.md.
 *
 * @returns the offending action name, or null to accept.
 */
export function findDirectedQueryAction(text: string): string | null {
  for (const clause of text.toLowerCase().split(CLAUSE_BREAK)) {
    const tokens = clause.match(TOKEN);
    if (!tokens) continue;
    // Skip any lead-in joiners to find the word the clause really starts on.
    let start = 0;
    while (start < tokens.length && JOINERS.has(tokens[start]!)) start++;
    // Not an imperative: the clause opens with something other than an order.
    if (start >= tokens.length || !DIRECTIVE_VERBS.has(tokens[start]!)) continue;
    for (let i = start + 1; i <= start + DIRECTIVE_WINDOW && i < tokens.length; i++) {
      const token = tokens[i]!;
      // "do not run find_route" -> steering the pilot AWAY from the query.
      if (NEGATIONS.has(token)) break;
      if (GATED.has(token)) return token;
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
    `rejected by the plan schema. Nothing marks the instruction done, so it re-raises into every ` +
    `later plan until a human supersedes it. Rewrite it as the OUTCOME you want ` +
    `("get to a station and refuel") or as the MUTATION to take ("jump to gold_run, then ` +
    `dock and refuel"). If you are describing a lookup you already did yourself, drop the ` +
    `action name and state the fact ("there is a route to gold_run").`
  );
}
