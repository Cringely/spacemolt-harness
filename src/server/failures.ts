import type { AgentEvent } from "../store/store";
import { NO_BUYERS_CLASS, isNoBuyersBlock } from "../agent/wake";

// Failure mining (#158): deterministic blocked-action taxonomy over `action`
// events, for the dashboard and the 6h strategy review (which previously
// re-derived this per run via ad-hoc SQL). CLASSIFICATION generalizes freely
// -- a class does not need to be proven to thrash to be COUNTED (the same
// detection-vs-suppression split as the #95 loop-breaker in wake.ts). The
// thrash DAMPER is deliberately not generalized here: suppression stays bound
// to classes with a live-incident receipt (#155).
//
// Evidence discipline (AGENTS.md "check the vendored reference"): every prose
// rule below cites a live capture or the vendored reference. Ground truth:
//   - "Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)"   live 2026-07-13 (#146)
//   - "invalid_item: Unknown item 'fuel_cells'. Use exact item ID ..."
//     live capture, test/fixtures/market-capture-2026-07-13.json (#152)
//   - "not_docked: You must be docked at a station to perform this action."
//     live capture (#152, test/executor.test.ts)
//   - "deposits too sparse to mine here"                  live (#155 era)
//   - "the beam disperses what little remains"            vendored reference,
//     docs/game-reference/upstream/guides/miner.md ("Too Sparse" section)
//   - "Another action is already in progress for this player"  live 2026-07-11
//   - "Your ship is mid-travel to <POI> (~10s until arrival)"  live 2026-07-11
//   - "Error: no_resources: Nothing to mine here"         MCP text shape,
//     test/mcp-game-api.test.ts; bare "nothing to mine here" via HTTP v2
//   - error-code table (not_docked, no_fuel, no_credits, ...):
//     docs/game-reference/upstream/api.md "Common Error Codes"

/** Class for a blocked outcome whose text carries no classifiable signal. */
export const UNCLASSIFIED = "unclassified";

// Tier 1 -- prose rules for live-seen classes whose text embeds a VARYING
// item/POI name with no stable leading code. The simpler alternative (the
// tier-3 normalizer alone) was rejected per rule because it only strips
// QUOTED names and digits: "mid-travel to Kepler-442" or "needs a mining
// laser module" would fragment into one class per destination/module name.
// Order matters: these run before code extraction so "Error: no_resources:
// Nothing to mine here" (MCP shape) and bare "nothing to mine here" (HTTP
// shape) land in ONE class -- same game condition, two transport shapes.
const PROSE_RULES: ReadonlyArray<{ re: RegExp; cls: string }> = [
  { re: /deposits too sparse|beam disperses/i, cls: "too_sparse" },
  { re: /nothing to mine/i, cls: "nothing_to_mine" },
  { re: /needs a .+ module/i, cls: "missing_module" },
  // The next two are normally classified transient by the executor (outcome
  // `wait`, excluded from this aggregation); the rules exist so a phrasing
  // that slips past executor.ts's TRANSIENT_BLOCK_MARKERS allowlist still
  // groups under a crisp name instead of a per-destination sentence class.
  { re: /already in progress/i, cls: "action_in_progress" },
  { re: /mid-travel|mid travel|mid-jump|mid jump|resubmit this command/i, cls: "in_transit" },
];

// Tier 2 -- a leading `snake_case:` error code names its own class. This is
// the generalization channel: a code we have never seen (the game's error
// vocabulary is large -- insufficient_credits, citizenship_closed, ... per
// docs/game-reference/upstream/docs/empires.md) becomes a stable class with
// zero new rules, which is exactly the "new class = the game teaching us a
// rule" signal #158 wants surfaced. The optional "Error:" head is the MCP
// text-transport wrapper. Anchored to the START of the text; the #152
// executor correction re-prefixes its rewritten reason with "invalid_item:"
// (src/agent/executor.ts, nearestCatalogItemId seam), so both the raw and the
// corrected shape resolve to the same class.
const CODE_PREFIX_RE = /^(?:error:\s*)?([a-z][a-z0-9_]{2,}):/i;

/**
 * Normalize one blocked/error result text to a stable class token. Pure;
 * strips the parts that vary per attempt (item names, quantities, prices,
 * destinations) so "sell gold ore, no buyers" and "sell vanadium ore, no
 * buyers" are ONE row in the frequency table. The no-buyers class is imported
 * from wake.ts (#155 seed) -- defined once, both consumers can't drift.
 */
export function failureClass(text: string | undefined): string {
  if (!text || text.trim().length === 0) return UNCLASSIFIED;
  if (isNoBuyersBlock(text)) return NO_BUYERS_CLASS;
  for (const r of PROSE_RULES) if (r.re.test(text)) return r.cls;
  const code = CODE_PREFIX_RE.exec(text);
  if (code) return code[1]!.toLowerCase();
  // Tier 3 -- normalized-prose fallback for uncoded free text ("not enough
  // fuel", "cargo full"): lowercase, drop quoted names ('fuel_cells') and
  // numbers (quantities/prices/coordinates), collapse whitespace, cap length.
  // Deterministic and stable across attempts; readable enough to be a row.
  const norm = text
    .toLowerCase()
    .replace(/'[^']*'|"[^"]*"/g, "")
    .replace(/\d+(?:\.\d+)?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return norm.length > 0 ? norm : UNCLASSIFIED;
}

// Broken capability = the pilot cannot do that thing AT ALL (the buy action
// failed 86/86 over days before a manual audit noticed, #152/#158).
// Floor of 5 attempts: same rationale as usage.ts's WAKE_REASON_ALERT_MIN_WAKES
// -- 2/2 failures is one bad afternoon, not a broken capability, and must not
// page the operator. Rate 0.95, not 1.0: "~100%" per the issue -- one fluke
// success in 20+ attempts (a race the game let through once) must not hide a
// capability that is broken for every practical purpose. At the 5-attempt
// floor 0.95 requires 5/5, so the floor and the rate never fight.
export const BROKEN_CAPABILITY_MIN_ATTEMPTS = 5;
export const BROKEN_CAPABILITY_FAILURE_RATE = 0.95;

export interface FailureClassRow {
  class: string;
  count: number; // blocked occurrences inside the window
  actions: string[]; // distinct action names seen with this class in-window
  lastSeenTs: number;
  sample: string; // most recent raw result text -- the human-readable receipt
}

export interface BrokenCapability {
  action: string;
  attempts: number; // lifetime blocked + succeeded (waits excluded -- pacing, not attempts)
  failures: number; // lifetime blocked
  failureRate: number; // failures / attempts, LIFETIME
  windowAttempts: number; // blocked + succeeded INSIDE windowHours (always >= 1 here)
  windowFailures: number; // blocked inside windowHours
  topClass: string; // dominant failure class IN-WINDOW -- same span as windowFailures
}

export interface FailureTaxonomy {
  agentId: string;
  windowHours: number;
  classes: FailureClassRow[]; // window frequency table, count desc
  newClasses: string[]; // classes whose FIRST lifetime occurrence is inside the window
  brokenCapabilities: BrokenCapability[];
}

// The subset of the `action` event payload this aggregation reads. All fields
// optional: persisted events outlive the schema that wrote them (AGENTS.md
// persisted-state tolerance) -- an old/foreign shape is skipped, never a crash.
interface ActionPayload {
  action?: unknown;
  outcome?: unknown;
  result?: unknown;
}

/**
 * One pass over an agent's LIFETIME `action` events (ascending), three
 * signals out: window class frequencies, never-seen-before classes, and
 * broken capabilities. Lifetime input is deliberate -- newness and lifetime
 * failure rates are unanswerable from a window alone (the 86/86 buy history
 * predates any dashboard window). Only `blocked` outcomes count as failures;
 * `continue`/`plan_done` count as successes for the capability denominator;
 * `wait` (transient pacing, SM-10/SM-12) is neither -- the same semantics as
 * the #95 loop-breaker's counter in agent.ts.
 *
 * Broken capabilities carry BOTH pairs (lifetime and in-window) and are gated
 * on both (#518): the lifetime pair is how deep the evidence goes, the window
 * pair is whether it is still true. A reader that quotes one number against the
 * other window is making a claim this data does not support.
 */
export function failureTaxonomy(
  agentId: string,
  events: Array<AgentEvent & { id: number }>,
  now: number,
  windowHours: number,
): FailureTaxonomy {
  const cutoff = now - windowHours * 60 * 60 * 1000;

  const firstSeen = new Map<string, number>(); // class -> earliest blocked ts (lifetime)
  const windowRows = new Map<string, { count: number; actions: Set<string>; lastSeenTs: number; sample: string }>();
  const byAction = new Map<
    string,
    { failures: number; successes: number; winFailures: number; winSuccesses: number; classCounts: Map<string, number> }
  >();
  const newCap = () => ({ failures: 0, successes: 0, winFailures: 0, winSuccesses: 0, classCounts: new Map<string, number>() });

  for (const e of events) {
    const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as ActionPayload;
    const outcome = typeof p.outcome === "string" ? p.outcome : undefined;
    if (outcome === undefined) continue;
    const action = typeof p.action === "string" ? p.action : undefined;

    if (outcome === "blocked") {
      const cls = failureClass(typeof p.result === "string" ? p.result : undefined);
      if (!firstSeen.has(cls)) firstSeen.set(cls, e.ts);
      if (action !== undefined) {
        const cap = byAction.get(action) ?? newCap();
        cap.failures++;
        // Window-scoped, in lockstep with winFailures above -- topClass names
        // the failure in a finding that is published as a window claim, so it
        // has to come from the same span as the counts beside it (#518 review).
        // Total, not just safer: the filter below drops any entry with
        // winFailures === 0 (a rate over a non-zero denominator cannot reach
        // 0.95 with a zero numerator), and this increment fires under exactly
        // the same guard as winFailures, so every entry that SHIPS has at least
        // one in-window class count and a real topClass. Entries left with the
        // UNCLASSIFIED default are precisely the ones the filter discards.
        if (e.ts >= cutoff) {
          cap.winFailures++;
          cap.classCounts.set(cls, (cap.classCounts.get(cls) ?? 0) + 1);
        }
        byAction.set(action, cap);
      }
      if (e.ts >= cutoff) {
        const row = windowRows.get(cls) ?? { count: 0, actions: new Set<string>(), lastSeenTs: 0, sample: "" };
        row.count++;
        if (action !== undefined) row.actions.add(action);
        if (e.ts >= row.lastSeenTs) {
          row.lastSeenTs = e.ts;
          if (typeof p.result === "string") row.sample = p.result;
        }
        windowRows.set(cls, row);
      }
    } else if (outcome === "continue" || outcome === "plan_done") {
      if (action !== undefined) {
        const cap = byAction.get(action) ?? newCap();
        cap.successes++;
        if (e.ts >= cutoff) cap.winSuccesses++;
        byAction.set(action, cap);
      }
    }
    // `wait` and any unknown outcome: ignored -- pacing/holds are not attempts.
  }

  const classes: FailureClassRow[] = [...windowRows.entries()]
    .map(([cls, r]) => ({
      class: cls, count: r.count, actions: [...r.actions].sort(), lastSeenTs: r.lastSeenTs, sample: r.sample,
    }))
    .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));

  const newClasses = classes
    .map((r) => r.class)
    .filter((cls) => (firstSeen.get(cls) ?? 0) >= cutoff)
    .sort();

  const brokenCapabilities: BrokenCapability[] = [...byAction.entries()]
    .map(([action, c]) => {
      const attempts = c.failures + c.successes;
      let topClass = UNCLASSIFIED;
      let topCount = -1;
      for (const [cls, n] of c.classCounts) {
        if (n > topCount || (n === topCount && cls < topClass)) { topClass = cls; topCount = n; }
      }
      return {
        action, attempts, failures: c.failures,
        failureRate: attempts > 0 ? c.failures / attempts : 0,
        windowAttempts: c.winFailures + c.winSuccesses, windowFailures: c.winFailures,
        topClass,
      };
    })
    // The lifetime pair is the DEPTH of the evidence (#158: the buy action's
    // 86/86 accrued over days, invisible to any one window). The window pair is
    // its CURRENCY, and #518 is what happens without it: the 6h strategy review
    // reads this list and files "~100% failure over 72h" findings, so an entry
    // whose numerator and denominator come from different spans is a false
    // claim published into the backlog. Issue #491 filed `scan 27/27` with ZERO
    // scan attempts inside the claimed window (last attempt eleven days back),
    // and `survey_system 11/11` while its two most recent attempts had
    // SUCCEEDED once the scanner was fitted. The window rate clause is the one
    // that does the work, and it covers both halves:
    //   - recent successes are the game telling us the capability works now,
    //     and they must not be outvoted by a dead history;
    //   - an action nobody tried recently is NOT ATTEMPTED, never 100% failed.
    // The `windowAttempts > 0` clause is REDUNDANT today and kept deliberately:
    // with a zero denominator the rate is 0/0 = NaN, and every NaN comparison
    // is false, so the rate clause already excludes those entries -- by
    // accident of IEEE-754, not by intent. Dropping the guard leaves the suite
    // green (verified by deleting this line: 73 pass, 0 fail across
    // failures/server/strategy-review-dump), which is exactly why it stays. An
    // explicit "a rate with an empty denominator is not a rate" beats resting
    // the not-attempted case on NaN semantics that a later reshape of the rate
    // clause would silently take away. It is a guard, not a second filter.
    // The window is deliberately NOT held to BROKEN_CAPABILITY_MIN_ATTEMPTS --
    // that floor guards against "one bad afternoon" and the lifetime pair
    // already carries it. Applying it here too was the simpler alternative
    // (one filter clause, no new fields) and it is rejected: a capability
    // failing slowly across days would fall under the floor in every 72h slice
    // and vanish, which is exactly the 86/86 case #158 exists to catch.
    .filter((c) =>
      c.attempts >= BROKEN_CAPABILITY_MIN_ATTEMPTS
      && c.failureRate >= BROKEN_CAPABILITY_FAILURE_RATE
      && c.windowAttempts > 0
      && c.windowFailures / c.windowAttempts >= BROKEN_CAPABILITY_FAILURE_RATE)
    .sort((a, b) => b.attempts - a.attempts || a.action.localeCompare(b.action));

  return { agentId, windowHours, classes, newClasses, brokenCapabilities };
}
