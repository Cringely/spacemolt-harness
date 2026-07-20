import { isTransientServerFailure, SpacemoltError, type V2Result } from "../client/http";
import type { FittedModule, GameApi, ModuleSpec, ShipFit, StatusSnapshot } from "../client/client";
import type { Plan, PlanStep } from "../registry/plan";
import type { PlanCursor } from "../store/store";
import { catalog } from "../catalog/catalog";

// Invariant: resultText carries a short snippet (capped ~120 chars, see
// snippet() below) of the game's human-readable `result` text on every
// outcome kind, not just blocked. See docs/archive/decisions-2026-07-10-to-2026-07-11.md
// (2026-07-11, "Correction to SM-8") for why -- a trusted envelope with no
// state-change check hid 17 phantom "successful" sells.
export type StepResult =
  // `settle` rides on a same-step continue when the action was ACCEPTED but
  // still resolving ("Action pending. Resolves next tick" -- see
  // ACTION_PENDING_MARKER below); tells executeOne to skip one submission
  // before re-firing. See docs/archive/decisions-2026-07-12.md (2026-07-12,
  // "Pacing repeated actions to the game tick", SM-12).
  | { kind: "continue"; cursor: PlanCursor; resultText?: string; settle?: true }
  // A transient, self-resolving block (prior tick's action not yet finished,
  // or ship still mid-travel). Holds the CURRENT step; no cursor advance, no
  // blocked wake. See classifyGameError below and
  // docs/archive/decisions-2026-07-10-to-2026-07-11.md (2026-07-11,
  // "Transient-block thrash", SM-10/SM-11).
  | { kind: "wait"; resultText?: string }
  // #431 fix (live 2026-07-19, second occurrence of the class): the step's call
  // died on a TRANSIENT SERVER failure -- HTTP 5xx, network error, or the open
  // circuit breaker (see isTransientServerFailure, http.ts) -- surfaced only
  // after http.ts's own in-call retries were spent. The step itself may be
  // perfectly valid; replanning adds zero information for a 503 (each live 503
  // cost a full planner call whose new plan's step 1 was byte-identical to the
  // failed step). The executor is stateless across ticks, so the caller
  // (executeOne, agent.ts) owns the retry policy: for MOVEMENT steps it
  // retries the SAME step after a tick backoff, degrading to the ordinary
  // blocked wake at the cap; for every other mutation it degrades
  // immediately (a blind resubmit after an ambiguous 5xx is the #137
  // double-spend class -- see the gate in executeOne).
  | { kind: "server_retry"; code: string; resultText?: string }
  | { kind: "plan_done"; resultText?: string }
  | { kind: "blocked"; reason: string; resultText?: string };

const RESULT_SNIPPET_LEN = 120;

function snippet(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > RESULT_SNIPPET_LEN ? text.slice(0, RESULT_SNIPPET_LEN) : text;
}

// Invariant: a transient, self-resolving block must WAIT, never replan -- see
// docs/archive/decisions-2026-07-10-to-2026-07-11.md (2026-07-11,
// "Transient-block thrash", SM-10/SM-11) for the incident. The game surfaces
// these through the SAME generic command_error
// code as terminal blocks (rate_limited/action_pending are retried in http.ts
// and never reach here), so no stable code separates them at this catch seam --
// the only signal in the error is the message text.
//
// The PRIMARY guard is now the flag-based pre-step check in executeTick (hold
// ANY step while status.inTransit) -- see there. This text match is the
// fallback for a transient block that still reaches a catch site: an action
// issued during a busy window that the flag didn't cover (e.g. the ~10s
// resolution window of a NON-movement action -- "already in progress" -- where
// nothing sets in_transit at all).
//
// Narrow allowlist of substrings that terminal blocks (can't afford, invalid
// target, deposits too sparse, cargo full, no route) never carry:
//   "already in progress"  -- prior action's ~10s tick not yet resolved
//   "mid-travel"/"mid-jump" -- ship between locations (the "~10s until arrival"
//                              tail varies per tick, so match the stable prefix
//                              only; that varying tail is also what partly
//                              defeated the identical-string thrash damper)
//   "resubmit this command" -- the canonical retry instruction the game appends
//                              to transient blocks. A terminal block tells you
//                              to do something DIFFERENT; only a transient one
//                              says the SAME command will work if resubmitted.
//                              Preferred over enumerating every "mid-<X>"
//                              phrasing because it generalizes to future ones.
// Transient -> WAIT (hold the step, retry next tick); terminal -> blocked wake
// -> replan, unchanged. Misclassification is bounded, not permanent: a block
// that matches here but never actually clears is picked up by the heartbeat
// wake (agent.ts) instead of holding forever.
const TRANSIENT_BLOCK_MARKERS = [
  "already in progress",
  "mid-travel", "mid travel",
  "mid-jump", "mid jump",
  "resubmit this command",
];

// `mine` (and any async-yield action) returns a SUCCESS envelope whose result
// text is "Action pending. Resolves next tick" -- the yield lands a tick LATER
// in status/notifications, not in this result. Invariant: PACE to the tick, on
// a pending accept flag the continue with `settle` so the loop skips one
// submission before re-firing (see executeOne in agent.ts), rather than
// re-firing the same step and racing the still-resolving tick. Match the
// distinctive stable substring only; http.ts already consumes the
// `action_pending` error CODE separately (that path never reaches here). NOT a
// permanent hold: an action that stays pending forever alternates fire/settle
// with frozen game state, which the heartbeat wake and no-progress detector
// still escalate. See docs/archive/decisions-2026-07-12.md (2026-07-12,
// "Pacing repeated actions to the game tick", SM-12) for the incident.
const ACTION_PENDING_MARKER = "resolves next tick";

function classifyGameError(e: SpacemoltError): StepResult {
  // #431: transient server-side failure, classified by CODE (the transport's
  // own taxonomy, not message text -- a bodyless 503 carries no game prose for
  // the marker allowlist below to read) and checked FIRST: server health and
  // game-rule blocks are different classes with different remedies.
  if (isTransientServerFailure(e.code)) {
    return { kind: "server_retry", code: e.code, resultText: snippet(e.message) };
  }
  const transient = TRANSIENT_BLOCK_MARKERS.some((m) => e.message.toLowerCase().includes(m));
  if (transient) return { kind: "wait", resultText: snippet(e.message) };
  return { kind: "blocked", reason: e.message, resultText: e.message };
}

// Buy-id correction (issue #152). Invariant: a buy's `id` param should be an
// exact catalog item id, established by the planner when it writes the plan.
// The producer of the bad state is the planner's prose-guess -- 86/86 lifetime
// buy failures, every one `id:'fuel_cells'`, one character off the catalog's
// `fuel_cell` because the game's own refuel error says "Buy fuel cells"
// (plural prose teaching a wrong id). The executor cannot patch the planner's
// weights, so the writable producer-side seam is the blocked detail the next
// replan reads: on an invalid_item buy block, nearest-match the attempted id
// against the catalog SSOT and surface the correction so the planner
// self-corrects next plan. Deliberately NO auto-retry of the corrected buy --
// buy is a mutation, and a harness-initiated retry has at-least-once hazards
// (#137: a double-spend if the first submission actually landed); surfacing
// the correction is the smaller change and costs one replan, not credits.
// Receipt for the edit-distance scan (simplicity rule 3): a bare "check the
// catalog" instruction was already IN the game's error text ("Use exact item
// ID") and failed 86 times; the deterministic nearest-match is the smallest
// mechanism that turns the rejection into the exact id.
function nearestCatalogItemId(attempted: string): string | undefined {
  // Exact singular/plural strip first: the live incident class, and
  // deterministic when several ids sit within distance 1.
  const stripped = attempted.replace(/s$/, "");
  if (stripped !== attempted && catalog.itemMeta(stripped)) return stripped;
  for (const item of catalog.items()) {
    if (withinEditDistanceOne(attempted, item.id)) return item.id;
  }
  return undefined;
}

// True when a and b differ by at most one insert/delete/substitute.
function withinEditDistanceOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (s.length === l.length) i++; // substitution consumes both
    j++; // insert/delete consumes only the longer
  }
  return edits + (l.length - j) <= 1;
}

async function conditionMet(api: GameApi, until: NonNullable<PlanStep["until"]>): Promise<boolean> {
  const s = await api.status(); // query: free, unlimited
  if (until === "cargo_full") return s.cargoCapacity > 0 && s.cargoUsed >= s.cargoCapacity;
  return s.cargoUsed === 0; // cargo_empty
}

// VERIFIED 2026-07-10 (live find_route capture, SM-2 flight diagnosis -- see
// docs/STATE.md): the previous ASSUMED shape ({ route: string[] }, route[0] =
// next hop) was wrong. Real shape:
//   { found, total_jumps, estimated_fuel, fuel_available, message,
//     route: [{jumps, name, system_id}], target_system }
// route[0] is the CURRENT system (jumps: 0), not the next hop -- route[1] is
// the next hop. found:false means no route exists at all; its message is the
// block reason.
function nextHop(structuredContent: unknown): { hop: string | null; reason?: string } {
  const sc = structuredContent as
    | { found?: boolean; message?: string; route?: Array<{ system_id?: unknown }> }
    | undefined;
  if (sc?.found === false) return { hop: null, reason: sc.message };
  const candidate = sc?.route?.[1]?.system_id;
  return { hop: typeof candidate === "string" ? candidate : null };
}

function advance(plan: Plan, cursor: PlanCursor, resultText?: string): StepResult {
  const next = cursor.step + 1;
  if (next >= plan.steps.length) return { kind: "plan_done", resultText };
  return { kind: "continue", cursor: { step: next, iteration: 0 }, resultText };
}

function cargoQty(status: StatusSnapshot, itemId: string): number {
  return status.cargo?.find((c) => c.itemId === itemId)?.quantity ?? 0;
}

// Catalog-gated jettison guard (issue #94, operator mandate 2026-07-13).
// Invariant: valuable cargo must never be destroyed -- established here, at
// the executor jettison seam, the last deterministic point before the
// destroying call goes out. Live incident: the pilot held 28 palladium_ore
// (catalog base_value 200cr, rare, input to 5 recipes) framed as "dead
// weight" across plans, one briefing rewording away from dumping ~5600cr.
// The digest's value-aware teaching (digest.ts) is the "pick right the first
// time" nudge; this floor is the backstop a prose rule can't be.
//
// Receipt for the constant (simplicity rule 3): the live junk class (common
// ores, base_value 4-8cr -- the cargo jettison exists to clear) sits an order
// of magnitude below 50; the live incident item (palladium_ore, 200cr) sits
// 4x above it. A floor of 50 splits the observed classes with wide margin;
// no smaller mechanism (a hardcoded item list, a rarity check) covers items
// the catalog values but we haven't met yet. Fail-open on an item the
// catalog doesn't value (same convention as the mine guard's unknown-modules
// case): a fabricated block from missing data could deadlock disposal of
// genuinely worthless unknown junk, and the digest rule still covers it.
export const JETTISON_VALUE_FLOOR = 50;

// Mining-precondition fix (2026-07-12): a mine action is a guaranteed error
// unless a mining laser is fitted. A module is a mining laser when the game
// tags it type "mining" OR reports a positive mining_power -- either alone
// identifies one (see FittedModule, client.ts). Only meaningful when the
// fitted set is KNOWN: status.modules === undefined means the modules block
// was absent/malformed, and the caller must NOT treat that as "no laser".
function hasMiningModule(status: StatusSnapshot): boolean {
  return (status.modules ?? []).some((m) => m.type === "mining" || (m.miningPower ?? 0) > 0);
}

// Deposit-lock rule (issue #188). REFERENCE-CHECKED: "an array more than 4x
// over a heavily depleted deposit's supported power cannot extract at all --
// the server returns a `deposit_too_sparse` error" (mining.md:42; same rule
// with per-laser summing in guides/miner.md:161-163). Corroborated by the
// 2026-07-13 live incident prose ("The richest deposit holds 24 units; your
// array needs at least 25 to get a lock" -- consistent with blocked iff
// power > 4 x supported_power at an array power of 97-100). Exported and
// imported by the digest's deposit check (planner/digest.ts), so the verdict
// the planner reads and the guard the executor enforces can never disagree
// about the threshold -- a shared function instead of a prose seam.
export const SPARSE_LOCK_MULTIPLIER = 4;
export function canLockDeposit(totalMiningPower: number, supportedPower: number): boolean {
  return totalMiningPower <= SPARSE_LOCK_MULTIPLIER * supportedPower;
}

/**
 * The array's total mining_power, summed over fitted mining modules
 * (guides/miner.md:161: "add them up if you've got more than one"). A module
 * with an unreported mining_power contributes 0, so the sum is a LOWER bound
 * on the true total -- safe for the sparse check, whose blocking condition
 * (total > 4x support) can only be UNDER-triggered by an under-count, never
 * false-fired. Returns 0 when the fitted set is unknown; callers treat 0 as
 * "power unknown" and fail open (the no-laser case is the mine guard's, not
 * this check's).
 */
export function totalMiningPower(modules: FittedModule[] | undefined): number {
  return (modules ?? [])
    .filter((m) => m.type === "mining" || (m.miningPower ?? 0) > 0)
    .reduce((sum, m) => sum + (m.miningPower ?? 0), 0);
}

/**
 * The equipment-relevant identity a learned sparse-deposit rule is keyed on
 * (issue #188): the sorted type ids of the fitted MINING modules. A rule
 * learned under one fit must not block a mine under another -- refitting
 * smaller modules is one of the game's own suggested escapes -- so the key
 * changes when the mining fit changes and the stale rule simply stops
 * matching (the same fit-is-a-cache-input lesson as #253's self-heal).
 * undefined when the fitted set is unknown OR carries no mining module:
 * with no key there is nothing to learn against, and the check fails open.
 */
export function miningEquipmentKey(modules: FittedModule[] | undefined): string | undefined {
  if (modules === undefined) return undefined;
  const mining = modules
    .filter((m) => m.type === "mining" || (m.miningPower ?? 0) > 0)
    .map((m) => m.typeId)
    .sort();
  return mining.length ? mining.join("+") : undefined;
}

// Learned sparse-deposit rule (issue #188, part 3): a fact the game taught
// via failure prose -- "a mine at THIS poi with THIS mining fit was refused
// as too sparse". Produced and persisted by the Agent (learnSparseDeposit,
// agent.ts: TTL, cap, event-sourced restart safety all live there); the
// executor receives only the CURRENTLY-VALID rules as plain data each tick,
// so it stays clockless and storeless. detail is clipped game text, carried
// so the refusal can cite the original lesson.
export interface LearnedSparseRule {
  poiId: string;
  equipmentKey: string;
  detail: string;
}

// Mine deposit precondition (issue #188, parts 2+3 -- the fuller check the
// 2026-07-12 mine guard's SCOPE note deferred "pending the get_poi response
// shape"; #291/PR #302 landed that shape, reference-cited at
// PoiDepositsSchema in client.ts, and live use has since confirmed the
// resources[] read at real belts).
//
// Invariant: a mine must name a deposit the fitted array can actually lock --
// established by the game's own rule (mining.md:42: an array more than 4x
// over a deposit's supported_power cannot extract; the server answers
// deposit_too_sparse). Both sides are one free query away at the moment of
// the call, so the check is ours to make before the tick is spent.
//
// Two rungs, live data FIRST (evidence precedence: a fresh capture beats a
// learned lesson):
//   1. Deterministic (part 2): when EVERY deposit's supported_power is known
//      and the array's total mining_power is known, block only when NO
//      deposit here can feed the array -- numbers in the reason, relocate/
//      refit steer first. When the numbers prove a lockable deposit exists,
//      the mine goes through EVEN IF a learned rule exists (the deposit
//      regenerated; fresh data wins and the rule ages out by TTL).
//   2. Learned fallback (part 3): when the live data cannot decide (absent
//      resources, an entry without supported_power, unknown array power),
//      refuse only the EXACT (poi, mining-fit) repeat of a block the game
//      already taught -- never a generalization (#361 REVISE lesson: a
//      deterministic block needs data that provably bounds the decision;
//      prose-learned rules bound only the observed case).
//
// Fired on the step's FIRST submission only (cursor.iteration === 0).
// Receipt (simplicity rule 3): the incident class is arriving at a POI whose
// deposits are ALREADY too sparse -- one check at entry catches it; re-firing
// the query on every repeat tick of an `until: cargo_full` loop would double
// the hottest path's traffic to guard against mid-run depletion, which the
// game's own error reports the moment it happens (and the learned rule then
// blocks the doomed RE-plan at this POI).
//
// Fail-open everywhere, like every pre-step guard here (#94): no
// getPoiDeposits on the api, a thrown fetch, an unparsed response, a missing
// poi id, an unknown supported_power, or an unknown fitted set all skip the
// respective rung -- never fabricate a block from missing data.
async function mineDepositBlock(
  api: GameApi, preStatus: StatusSnapshot | null, learnedSparse: LearnedSparseRule[] | undefined,
): Promise<StepResult | null> {
  if (!api.getPoiDeposits) return null;
  let info: Awaited<ReturnType<NonNullable<GameApi["getPoiDeposits"]>>>;
  try {
    info = await api.getPoiDeposits();
  } catch {
    return null; // query failed -> UNKNOWN deposits -> no guard
  }

  const power = totalMiningPower(preStatus?.modules);
  const deposits = info?.deposits ?? [];
  const allKnown = deposits.length > 0 && deposits.every((d) => d.supportedPower !== undefined);
  if (allKnown && power > 0) {
    if (deposits.some((d) => canLockDeposit(power, d.supportedPower!))) return null; // provably minable -> fresh data wins
    const richest = Math.max(...deposits.map((d) => d.supportedPower!));
    const list = deposits.map((d) => `${d.resourceId} supports ${d.supportedPower}`).join(", ");
    const reason =
      `mine blocked: deposits too sparse for your mining array -- relocate to a denser field or refit smaller ` +
      `mining modules; do not retry mine here with this fit. Your total mining_power ${power} exceeds ` +
      `${SPARSE_LOCK_MULTIPLIER}x every deposit's supported_power here (richest ${richest}; ${list}), so no lock is possible.`;
    return { kind: "blocked", reason, resultText: reason };
  }

  // Live data could not decide -- fall back to the learned rule for exactly
  // this (poi, mining fit), if the Agent passed a currently-valid one.
  const poiId = info?.poiId;
  const key = miningEquipmentKey(preStatus?.modules);
  if (!poiId || !key || !learnedSparse?.length) return null;
  const rule = learnedSparse.find((r) => r.poiId === poiId && r.equipmentKey === key);
  if (!rule) return null;
  const reason =
    `mine blocked (learned): a mine at ${poiId} with your current mining fit was already refused as too sparse -- ` +
    `relocate to a denser field or refit smaller mining modules; repeating it here fails identically. ` +
    `The game said: ${snippet(rule.detail)}`;
  return { kind: "blocked", reason, resultText: reason };
}

/**
 * The pilot's Engineering level (0-100), or null when it cannot be known.
 *
 * VERIFIED (test/fixtures/spacemolt-probe-2026-07-12.json, get_skills): the game
 * returns ONLY TRAINED skills -- the live envelope's own header reads "Skills
 * (5 trained, 0-100 scale)" and carries exactly 5 keys. So an ABSENT key is not
 * missing data, it is a real level of 0 (untrained), and a pilot who has never
 * crafted has no Engineering entry at all. That distinction is the whole reason
 * this returns 0-vs-null rather than collapsing both to 0: only a getSkills we
 * could not CALL is unknown.
 */
async function engineeringLevel(api: GameApi): Promise<number | null> {
  if (!api.getSkills) return null; // e.g. McpGameApi, which does not implement it
  let skills: Record<string, { level: number; xp: number }>;
  try {
    skills = await api.getSkills();
  } catch {
    return null; // query failed -> UNKNOWN discount
  }
  const level = skills["engineering"]?.level ?? 0; // absent == untrained == 0
  return Math.min(100, Math.max(0, level));
}

/**
 * The SMALLEST value a module's live CPU/power cost could take, given a catalog
 * figure and an Engineering level. Safe under BOTH readings of the catalog:
 *
 *   - catalog is RAW      -> live cost is usage * (100 - eng)/100, i.e. this floor.
 *   - catalog is DISCOUNTED -> live cost is `usage` itself, which is >= this floor.
 *
 * so `floor > free` implies "does not fit" either way, and the guard cannot
 * false-fire on the unsettled question. Math.floor absorbs the third unknown --
 * whether the game rounds the discount up, down, or to nearest -- since every
 * rounding of x is >= Math.floor(x).
 *
 * The capture that would settle this and let the guard tighten: get_ship's
 * reported cpu/power usage for a module already fitted by a pilot with
 * Engineering > 0, next to spacemolt_catalog(type:items, id=<that module>). If
 * the two agree, the catalog is discounted; if the catalog is higher, it is raw.
 */
function moduleGridFloor(usage: number, engLevel: number): number {
  return Math.floor((usage * (100 - engLevel)) / 100);
}

// Fit precondition guard (issue #219, and the deterministic half of #188).
//
// Invariant: an install_mod must name a module the ship can actually take FROM
// WHERE IT IS and WITH THE GRID IT HAS -- established by the game's own rules
// (upstream/docs/ships.md: "You must be docked, and the module's CPU and power
// must fit your remaining grid"; slot counts are fixed per hull). There is no
// dry_run on install_mod the way there is on craft, so a bad fit is a spent
// tick and a blocked wake; the check is ours to make, client-side, before the
// call goes out. That is the whole point of this seam.
//
// Both inputs are already cheap: the ship's grid rides on THIS TICK's
// get_status snapshot (StatusSnapshot.fit -- get_status and get_ship return the
// same V2GameState envelope, VERIFIED in the live probe fixture), and the
// module's requirements come from one free catalog query fired only on an
// install_mod step (GameApi.getModuleSpec). Receipt for that one query
// (simplicity rule 3): the alternative -- shipping the ~265 modules' CPU/power
// stats into src/catalog/catalog.data.json -- means a full catalog refetch and
// a much larger vendored blob to keep fresh, for data one live query answers
// exactly. Rejected.
//
// Fail-open everywhere, like every other pre-step guard here: an unknown grid,
// an unknown module, an unknown Engineering level, or a thrown catalog query all
// skip the check. A guard that fabricates a block from missing data is worse
// than no guard -- it deadlocks the very purchase this epic exists to unblock.
//
// THE ENGINEERING DISCOUNT (PR #235 review finding 1). upstream/docs/ships.md:26
// says each Engineering level cuts a module's CPU and power usage by 1%, and
// that "the usage numbers shown by get_ship and install_mod already reflect your
// bonus." It does NOT say whether the CATALOG lookup is pre- or post-discount,
// and no live capture settles it (see moduleGridFloor below). Rather than pick a
// side, the guard is built so that BOTH readings give the same verdict: it
// compares free grid against the module's cost floor -- the smallest number the
// live cost could possibly be under either reading. A block therefore means "no
// Engineering level you have could make this fit," which is true whichever way
// the catalog reports. A false fire is structurally impossible, not merely
// unlikely; the price is that a fit inside the discount band is waved through to
// the game, whose rejection is authoritative and self-describing anyway.
//
// NOT guarded (deliberately): the SKILL gate. The vendored spec DOES give
// Module.required_skills a value shape (`additionalProperties: {type: integer}`
// -- a skill level), but not its KEY namespace: which skill names appear, and
// whether they match get_skills' keys, is uncaptured. That is only half the
// problem, though. The bigger one is that this guard would have to be right
// about a gate the game already enforces cheaply, and being wrong means blocking
// a legal install -- the same false-fire risk as the grid check, with no cost
// floor available to make it safe. A live capture of a skill-gated module
// (Mining Laser II, `mining 2`) plus a get_skills key comparison would settle it.
async function installModBlock(
  api: GameApi, step: PlanStep, preStatus: StatusSnapshot | null,
): Promise<StepResult | null> {
  const id = (step.params as { id?: unknown }).id;
  if (typeof id !== "string" || !id) return null;

  // Docked is a hard precondition and costs nothing to check -- ships.md is
  // explicit, and the game answers an undocked install with a guaranteed error.
  if (preStatus?.docked === false) {
    const reason =
      `install_mod blocked: you must be DOCKED at a station to fit a module. ` +
      `Plan dock first, then install_mod{id=${id}}.`;
    return { kind: "blocked", reason, resultText: reason };
  }

  const fit = preStatus?.fit;
  if (!fit || !api.getModuleSpec) return null; // UNKNOWN grid -> no guard

  let spec: ModuleSpec | undefined;
  try {
    spec = await api.getModuleSpec(id);
  } catch {
    return null; // catalog query failed -> UNKNOWN module -> no guard
  }
  if (!spec) return null; // not a module id we can read -> no guard

  // Cargo-presence precondition (issue #402). install_mod fits a module you are
  // HOLDING: the vendored reference is explicit -- upstream/openapi-v1.json:44141,
  // "Module must be in your cargo. Requires CPU/power grid capacity." The live
  // miss: the pilot planned install_mod for Mining Laser III TWICE while it was
  // not in cargo (the buy step was skipped or failed upstream and the plan ran
  // on), spending a tick each time on a guaranteed `module_not_found: You don't
  // have Mining Laser III in your cargo.` The grid/slot checks below cannot catch
  // this -- a module you do not own has no CPU/power/slot to weigh; presence is a
  // separate precondition, so it gets a separate check. Placed BEFORE the
  // engineeringLevel query so a not-held module costs zero extra queries.
  //
  // getModuleSpec above already confirmed `id` is a real catalog module TYPE id
  // (a get_ship module-INSTANCE id, which install does not take, fail-opens at the
  // !spec return), so for an install it must appear in cargo under that same id --
  // cargo entries are keyed by the catalog itemId (client.ts CargoItem).
  //
  // Block ONLY on a NON-EMPTY hold that lacks the module. An empty cargo array is
  // ambiguous and is treated as UNKNOWN, not "empty hold": StatusSnapshot.cargo
  // parses with `.catch([])` (client.ts), which was chosen deliberately for an
  // INFORMATIONAL manifest, and collapses a shape-surprise (the cargo key present
  // but the wrong type, or every entry dropped by the per-entry filter) to the
  // SAME [] as a genuinely empty hold. The sibling `modules` field spells the rule
  // out (client.ts:546-552): "'unknown' is the safe default for a guard that
  // short-circuits an action, 'empty' for a manifest that only informs" -- a guard
  // reading a collapsed [] as "empty" would falsely block a legal install and
  // deadlock the very upgrade #219 exists to unblock. So a NON-EMPTY hold is the
  // only cargo state trusted here: it proves the array parsed to real entries and
  // the module is genuinely absent from them. An empty (or undefined) cargo
  // fail-opens and lets the game rule -- worst case one wasted tick, same as today,
  // never a fabricated deadlock. Switching to the dedicated getCargo() query does
  // NOT help: it reuses this same `.catch([])` schema, so it can return the same
  // ambiguous [] -- and it would refetch cargo this tick's get_status already holds.
  const cargo = preStatus?.cargo;
  if (cargo && cargo.length > 0 && !cargo.some((c) => c.itemId === id)) {
    // Alternatives FIRST -- the digest clips a blocked wake's detail at 200 chars
    // (same ordering receipt as the fit and jettison reasons), so the
    // buy-it-first steer must survive the clip.
    const reason =
      `install_mod of ${id} blocked: it is not in your cargo, and install fits a module you are HOLDING. ` +
      `Buy it first -- dock where the market sells it, buy{id=${id}, quantity=1} (it lands in your cargo), ` +
      `then install_mod{id=${id}} while still docked.`;
    return { kind: "blocked", reason, resultText: reason };
  }

  // The pilot's Engineering level, needed for the cost floor. A free, unlimited
  // query (same class as get_status), fired only on an install_mod step that has
  // already cleared docked + catalog -- so at most once per install, never on a
  // normal mine/travel tick. Receipt (simplicity rule 3): the alternative is
  // caching the level on StatusSnapshot, which means a new cache whose inputs
  // include a skill that levels up mid-session from crafting or high power
  // utilization (skills.md) -- an uncaptured input, i.e. the exact staleness bug
  // the enumerate-every-cache-input rule exists to stop. One free query on a
  // rare step is smaller than a cache that can go stale.
  const eng = await engineeringLevel(api);
  if (eng === null) return null; // UNKNOWN discount -> no grid guard

  const cpuFree = fit.cpuCapacity - fit.cpuUsed;
  const powerFree = fit.powerCapacity - fit.powerUsed;
  const cpuMin = moduleGridFloor(spec.cpuUsage, eng);
  const powerMin = moduleGridFloor(spec.powerUsage, eng);
  if (cpuMin > cpuFree || powerMin > powerFree) {
    // Alternatives FIRST: the digest clips a blocked wake's detail at 200 chars
    // (digest.ts), so the actionable steer must survive the clip -- same
    // ordering receipt as the jettison guard and the buy-id correction.
    const discounted = eng > 0 ? ` (best case at Engineering ${eng}; catalog says cpu ${spec.cpuUsage} / power ${spec.powerUsage})` : "";
    const reason =
      `install_mod of ${id} does not fit: uninstall_mod a fitted module to free grid, or pick a smaller module. ` +
      `It needs cpu ${cpuMin} / power ${powerMin}${discounted}; you have cpu ${cpuFree} / power ${powerFree} free ` +
      `(cpu ${fit.cpuUsed}/${fit.cpuCapacity}, power ${fit.powerUsed}/${fit.powerCapacity} in use).`;
    return { kind: "blocked", reason, resultText: reason };
  }

  // Slot occupancy: counted from the fitted modules' own `slot` field (the
  // game's answer, VERIFIED live -- the miner's Mining Laser I reports slot
  // "utility", NOT the "weapon" ships.md's prose table would imply). Only
  // checked when BOTH the candidate's slot and the fitted set are known.
  const slot = spec.slot;
  const capacity = slot ? fit.slots[slot as keyof ShipFit["slots"]] : undefined;
  if (slot && capacity !== undefined && preStatus?.modules !== undefined) {
    const used = preStatus.modules.filter((m) => m.slot === slot).length;
    if (used >= capacity) {
      const reason =
        `install_mod of ${id} has nowhere to go: uninstall_mod one of your fitted ${slot} modules first, ` +
        `or buy a hull with more ${slot} slots. All ${capacity} ${slot} slot(s) on this ship are full.`;
      return { kind: "blocked", reason, resultText: reason };
    }
  }

  return null;
}

/**
 * Invariant: a `sell` envelope alone can't be trusted for success -- the only
 * ground truth is the target item's cargo quantity, queried via the SAME
 * free/unlimited get_status call the `until: cargo_full` condition
 * (conditionMet, above) already relies on post-action; this adds the matching
 * pre-action query. Returns null (verified real success) or a blocked-reason
 * string sourced from the envelope's `result` text. See
 * docs/archive/decisions-2026-07-10-to-2026-07-11.md (2026-07-11, "Correction
 * to SM-8") for the incident this closes.
 *
 * Scoping note: this closes the ZERO-effect case only -- it does not verify
 * the decrease matches the requested `quantity`, so a partial fill still
 * reads as verified success. The SM-9 plan_done thrash damper (agent.ts) is a
 * backstop if a partial-fill loop ever repeats the same goal 3 times.
 */
async function verifySellEffect(
  api: GameApi, itemId: string, before: StatusSnapshot, result: V2Result,
): Promise<string | null> {
  const beforeQty = cargoQty(before, itemId);
  const after = await api.status(); // query: free, unlimited
  const afterQty = cargoQty(after, itemId);
  if (afterQty < beforeQty) return null; // verified decrease: real success
  return snippet(result.result) ?? `sell of ${itemId} had no effect (cargo unchanged)`;
}

// Net-negative trips (issue #112) have NO deterministic executor guard --
// deliberately (PR #361 review, REVISE). The shipped first cut blocked a
// travel_to whose sell revenue, priced at catalog base_value, could not cover
// one-way fuel at the price floor. The review killed it: catalog value does
// not BOUND revenue in this game -- prices are player-driven with no global
// fixed price, and station price gaps are the arbitrage profession
// (markets.md:3,7) -- so "provably lossy" was not provable and the block
// could refuse a genuinely profitable first-visit arbitrage sell. A sound
// block needs a live destination bid, which the harness has no producer for
// (marketRows cover only the CURRENT docked station; building a per-station
// bid cache adds a staleness-prone mechanism for prices that move). Per the
// conservative-suppression rule (#155), a guard that cannot fire beats a
// guard that blocks profit: the lesson ships as the digest's advisory
// net-profit verdict (digest.ts, interpolating net-trip.ts's constants) and
// the improv briefing rule. estimateNetTrip (net-trip.ts) stays the model
// SSOT, ready for wiring if a live-bid producer ever lands.

/**
 * travel_to expands into repeated "jump" calls, one hop per tick, re-querying
 * find_route from the CURRENT position every time -- no route is persisted
 * beyond the plan's ordinary {step, iteration} cursor. A crash mid-route
 * resumes correctly for free (the next executeTick call just re-derives the
 * route from wherever the ship actually is), and a route that changes
 * mid-flight self-heals on the next tick instead of driving into a stale path.
 */
async function travelToTick(
  api: GameApi, plan: Plan, cursor: PlanCursor, targetSystemId: string, preStatus: StatusSnapshot | null,
): Promise<StepResult> {
  // Reuse executeTick's pre-step snapshot when it has one (already used for the
  // general inTransit guard, so the ship is NOT in transit here) -- one free
  // query per tick, not two. Fall back to a fresh fetch only if that pre-step
  // read failed (a status blip), preserving travel_to's original self-suffiency.
  const status = preStatus ?? await api.status();
  if (status.systemId === targetSystemId) return advance(plan, cursor);

  let route: unknown;
  try {
    const res = await api.action("find_route", { id: targetSystemId });
    route = res.structuredContent;
  } catch (e) {
    if (e instanceof SpacemoltError) return classifyGameError(e);
    throw e;
  }
  const { hop, reason } = nextHop(route);
  if (!hop) {
    const blockedReason = reason ?? `no route to ${targetSystemId}`;
    return { kind: "blocked", reason: blockedReason, resultText: blockedReason };
  }

  let jumpResult: V2Result;
  try {
    jumpResult = await api.action("jump", { id: hop });
  } catch (e) {
    if (e instanceof SpacemoltError) return classifyGameError(e);
    throw e;
  }
  return {
    kind: "continue",
    cursor: { step: cursor.step, iteration: cursor.iteration + 1 },
    resultText: snippet(jumpResult.result),
  };
}

// Target-locality guard (issue #176). ONE root cause, two symptoms -- both are
// an action sent against a target the ship cannot act on FROM WHERE IT IS.
//
// Violated invariant: every mutation the executor sends must name a target the
// ship can act on from its position AT THE MOMENT OF THE CALL. Plan-time
// validity is not execution-time validity.
//
// travel (~30 cross-system blocks/72h, e.g. "Gold Run Mineral Fields is in the
// Gold Run system (gold_run), but you are in market_prime"): the producer is
// the plan-admission normalizer (normalize-plan.ts), which resolves a travel
// step's POI id against the surroundings gathered AT PLAN TIME. That is correct
// only while the ship stays put -- and a round-trip plan (mine here -> travel_to
// the market -> dock -> sell -> travel back to the belt) MOVES it. The trailing
// `travel <belt_poi>` was a genuine POI of the plan-time system when it was
// admitted, so the normalizer passed it; by the time it RAN the ship was in
// another system and the game rejected it. The normalizer cannot fix this (it
// would have to simulate every step's effect on position); the executor can,
// because at call time the ship's real system is a free query away.
//
// scan (16/16 lifetime attempts blocked, all `invalid_target: Target
// '<poi_id>' not found at your current location`): a POI is a PLACE, not an
// entity. scan resolves entities AT the current location -- the game's own
// error names get_nearby as the target source. The planner scanned POI ids
// because POI ids were the only ids it was ever shown (the digest's
// surroundings block); the paired producer fix is the get_nearby listing now in
// the digest (see planner/digest.ts, Agent.gatherNearby). Widened by #368: the
// local-POI check misses POI ids carried from OTHER systems, so the scan
// branch also requires the id to appear in the fresh get_nearby text (the
// nearby-membership extension below).
//
// Receipt for the extra query (simplicity rule 3): get_status (already fetched
// this tick) does NOT carry the current system's POI list, so membership cannot
// be decided from it -- get_system is the smallest source, and it is a free,
// unlimited query fired ONLY on a travel/scan step. Alternatives rejected: (a)
// mapping a remote POI id -> its system so the executor could auto-issue
// travel_to would need get_poi's response shape, which is uncaptured (no
// load-bearing unknowns); (b) reading the target system out of the game's own
// error text is a consumer-side patch AFTER the wasted call, which is exactly
// the waste this closes.
//
// Fail-open, like the other pre-step guards: no getSystem on the api, a thrown
// query, or a system with no known POIs all skip the check -- never fabricate a
// block from missing data. The reasons are written alternatives-FIRST because
// the digest clips a blocked wake's detail at 200 chars (digest.ts), so the
// actionable steer must survive the clip.
async function targetLocalityBlock(api: GameApi, step: PlanStep): Promise<StepResult | null> {
  if (!api.getSystem) return null;
  const id = (step.params as { id?: unknown }).id;
  if (typeof id !== "string") return null;

  let poiIds: Set<string>;
  let here: string;
  try {
    const sys = await api.getSystem();
    poiIds = new Set(sys.pois.map((p) => p.id));
    // The current POI is a POI of this system even if the pois list came back
    // short -- it is also the id most likely to be scanned ("scan the belt I'm
    // sitting in"), which is exactly the invalid_target class.
    if (sys.currentPoi) poiIds.add(sys.currentPoi.id);
    here = sys.id ?? "your current system";
  } catch {
    return null;
  }
  if (!poiIds.size) return null; // UNKNOWN map -> no guard, no fabricated block

  if (step.action === "travel" && !poiIds.has(id)) {
    const reason =
      `travel blocked: to reach a POI in ANOTHER system, plan travel_to{system_id=<that system>} first, ` +
      `then travel to the POI once you have arrived. '${id}' is not a POI in your current system (${here}) -- ` +
      `travel{id} only reaches POIs HERE: ${[...poiIds].join(", ")}. ` +
      `A plan's ids resolve when the step RUNS, not when it was written: never leave a POI of the system you started in ` +
      `sitting after a travel_to/jump step.`;
    return { kind: "blocked", reason, resultText: reason };
  }

  if (step.action === "scan") {
    if (poiIds.has(id)) {
      const reason =
        `scan blocked: scan targets an ENTITY at your current location -- a ship, wreck or object from the Nearby list ` +
        `in your briefing -- never a POI id and never a system id. '${id}' is a POI in ${here}: a PLACE. ` +
        `Travel to a POI, don't scan it. If your briefing shows no Nearby list, there is nothing to scan here.`;
      return { kind: "blocked", reason, resultText: reason };
    }

    // Nearby-membership extension (issue #368). The POI check above knows only
    // THIS system's POIs, so a POI id carried from ANOTHER system sails
    // through it and dies at the game: 27/27 lifetime scans failed
    // `invalid_target: Target '<id>' not found at your current location ...
    // Use get_nearby` -- the rejected ids (factory_belt_haze,
    // colony_debris_field, ...) were POI names from other locations. The
    // game's own error names get_nearby as the target source (scanning.md:16
    // says the same), so the positive precondition IS membership in the fresh
    // get_nearby listing. That listing is raw UNPARSED text (shape never
    // captured live; parsing it would be a guessed schema, the SM-2 mistake --
    // see GameApi.getNearby), so membership is a substring test. That is the
    // right predicate, not a shortcut: the planner can only learn entity ids
    // by copying them off this same text in its briefing (digest), so an id
    // the text does not contain anywhere was invented or carried from
    // elsewhere -- exactly the doomed class. Receipt for the extra query
    // (simplicity rule 3): get_nearby is free (kind:"query", no tick), fired
    // only on a scan step about to spend one. Briefing-only was rejected: the
    // digest has labelled this listing "the ONLY valid scan targets" since
    // #176 and live failures continued anyway. Fail-open like the rest of
    // this guard: no getNearby on the api, a thrown query, or an EMPTY
    // listing (ambiguous -- "nothing visible" vs a shape divergence; absence
    // is never a verdict, #94) all pass the call through to the game.
    // ponytail: substring membership can false-open on an id embedded in
    // unrelated text (fail-open, safe direction) and would false-block a
    // cloaked target known by id -- accepted: the digest never surfaces
    // cloaked ids, so this planner cannot legitimately name one.
    if (api.getNearby) {
      let nearby: string;
      try {
        nearby = await api.getNearby();
      } catch {
        return null;
      }
      if (nearby.trim() && !nearby.includes(id)) {
        const reason =
          `scan blocked: pick a target id straight OFF the Nearby list in your briefing -- scan reaches only entities ` +
          `AT your current location, and '${id}' is not on that list here in ${here}. A POI of another system is a ` +
          `PLACE: travel_to that system first, then scan what its Nearby list shows. ` +
          `If your briefing shows no Nearby list, there is nothing to scan here.`;
        return { kind: "blocked", reason, resultText: reason };
      }
    }
  }

  return null;
}

// complete_mission precondition guard (issue #291 regression, live 2026-07-17).
// Invariant: complete_mission needs every objective satisfied -- an objective's
// `current` at or above its `required`, or its `completed` flag set. The game
// rejects an unmet mission with `mission_incomplete: Objective incomplete: Mine
// N units of X`. Live regression: 12 complete_mission calls fired against ONE
// titanium contract still under 20/20 over a 14.6h window (roughly hourly),
// each blocked by the game, each burning a tick AND a replan -- the digest's
// progress numbers and the game's own rejection did not stop the premature
// call. Same family as the accept_mission / mine / undock guards: refuse a
// provably-doomed call BEFORE it spends a tick and hand the planner a
// self-describing reason it can act on ("14/20 -- mine 6 more before
// completing"). Spends ONE free get_active_missions query (kind:"query", no
// tick) resolved FRESH at execution time -- more correct than the replan-time
// snapshot, since cargo/progress can change between plan and completion.
// Fail-OPEN on missing data (#94, absence is never a verdict): no
// getActiveMissions on the api, no id in the step, a fetch failure, a mission
// absent from the parsed active list, or objective counts unparsed -> no block;
// the call goes through and classifyGameError catches any real rejection at the
// site. Only a KNOWN shortfall (required and current both parsed, current <
// required, not completed) blocks. SCOPE: the quantity gate only -- a
// target-base/location precondition is a separate class the regression does not
// evidence, so an at-quantity complete elsewhere still reaches the game.
async function completeMissionBlock(api: GameApi, step: PlanStep): Promise<StepResult | null> {
  if (!api.getActiveMissions) return null;
  const id = (step.params as { id?: unknown }).id;
  if (typeof id !== "string" || !id) return null; // no id -> let the game answer
  let missions;
  try {
    missions = (await api.getActiveMissions()).missions;
  } catch {
    return null; // fetch failed -> no fabricated block
  }
  const mission = missions?.find((m) => m.missionId === id);
  if (!mission) return null; // not in the parsed active list -> no verdict
  const shortfalls: string[] = [];
  for (const o of mission.objectives) {
    if (o.completed) continue;
    if (o.required === undefined || o.current === undefined) continue; // unknown -> no verdict
    if (o.current < o.required) {
      shortfalls.push(`${o.itemId ?? o.type ?? "objective"} ${o.current}/${o.required} (mine ${o.required - o.current} more)`);
    }
  }
  if (!shortfalls.length) return null; // satisfied, or numbers unknown -> allow
  const reason =
    `complete_mission blocked: objective not met -- ${shortfalls.join("; ")}. ` +
    `Gather the shortfall first; complete_mission returns mission_incomplete until every objective's count is met.`;
  return { kind: "blocked", reason, resultText: reason };
}

/**
 * Runs exactly one game mutation and reports where the plan stands.
 *
 * `tickStatus` is this tick's status snapshot, already fetched by the caller
 * (runOnce/executeOne pass it, so the common path adds no extra query). Omit
 * it and executeTick reads status itself, best-effort -- kept optional so the
 * direct-call unit tests and any other caller need no status plumbing.
 *
 * `learnedSparse` (issue #188) is the Agent's currently-valid learned
 * sparse-deposit rules, plain data (see LearnedSparseRule above). Optional
 * for the same reason as tickStatus: absent means no learned rules, and only
 * the mine deposit guard reads it.
 */
export async function executeTick(
  api: GameApi, plan: Plan, cursor: PlanCursor, tickStatus?: StatusSnapshot | null,
  learnedSparse?: LearnedSparseRule[],
): Promise<StepResult> {
  const step = plan.steps[cursor.step];
  if (!step) return { kind: "plan_done" };

  // SM-11 fix: GENERAL flag-based transient guard, before ANY step. The ship is
  // between locations -- mid-travel (intra-system) or mid-jump (inter-system).
  // The docs expose a single location transit flag, `in_transit` (see
  // docs/wiki/spacemolt-api.md and client.ts's location mapping); there is no
  // separate mid-jump flag, so `in_transit` is the one signal for both. No
  // mutation succeeds in that window, so hold the CURRENT step whatever it is.
  // The live miss this closes: travel_to had its own guard but `mine` issued
  // mid-jump did not -- it fell through to the action, ate the transient block,
  // and replanned.
  //
  // The snapshot is resolved ONCE and reused as travel_to's position check and
  // sell's pre-action cargo baseline below. Best-effort: a status blip must NOT
  // abort the step (runOnce already tolerates a failed fetch by degrading to
  // null); a null snapshot just skips the flag guard -- the prose fallback in
  // classifyGameError still catches an in-transit action at the catch site.
  let preStatus: StatusSnapshot | null;
  if (tickStatus !== undefined) {
    preStatus = tickStatus; // caller already paid for this tick's fetch
  } else {
    try { preStatus = await api.status(); } catch { preStatus = null; }
  }
  if (preStatus?.inTransit) {
    return { kind: "wait", resultText: "ship in transit; wait for arrival to complete" };
  }

  // Undock precondition guard (station-awareness pattern, cf. PR #72's dock
  // briefing). Live miss: the pilot planned `undock` while already undocked;
  // the game answers that with a guaranteed error, so the step blocked and
  // replanned for nothing. Invariant: undock is a no-op when not docked --
  // never send a guaranteed-error call. When preStatus says docked === false,
  // treat the step as already satisfied and advance without hitting the API
  // (mirror a completed single-shot step). Best-effort like the inTransit
  // guard above: a null snapshot (status read failed) skips the check and lets
  // classifyGameError catch the block at the call site.
  if (step.action === "undock" && preStatus && preStatus.docked === false) {
    return advance(plan, cursor, "already undocked; undock is a no-op");
  }

  // accept_mission precondition guard (live diagnosis 2026-07-12): the pilot
  // reached for missions but called accept_mission with EMPTY params and the
  // game answered "invalid_payload: Must provide template_id (or mission_id)
  // to accept a mission." The OpenAPI slim marked both params optional (either
  // an offered mission's id OR a template_id is accepted), so the registry
  // request shape is conformant -- but the game enforces at-least-one at
  // runtime. accept_mission needs a template_id (or id); with neither, the
  // call is guaranteed to fail. Invariant:
  // never send an accept_mission that carries neither id nor template_id.
  // Short-circuit to a blocked wake (planner replans, threading a template_id
  // from the listing) instead of spending the doomed submission. Fail-safe:
  // only when BOTH are genuinely absent/empty -- a present id OR template_id
  // passes straight through to the API, same as any other action.
  // Mission-funnel fix (issue #147): the reason text no longer names
  // get_missions -- it flows into the digest as a blocked wake's detail, and
  // get_missions is a query the planner structurally cannot plan (PlanSchema
  // admits only mutations). The listing is harness-fetched into the digest
  // when docked (Agent.gatherMissions), so the reason points there instead.
  if (step.action === "accept_mission") {
    const p = step.params as { id?: unknown; template_id?: unknown };
    const hasId = typeof p.id === "string" && p.id.length > 0;
    const hasTemplate = typeof p.template_id === "string" && p.template_id.length > 0;
    if (!hasId && !hasTemplate) {
      const reason = "accept_mission needs a template_id (or id) copied from the mission listing in your briefing";
      return { kind: "blocked", reason, resultText: reason };
    }
  }

  // complete_mission precondition guard (issue #291 regression) -- see
  // completeMissionBlock above. Sits with the other pre-step preconditions; the
  // only mission-completion path, and it spends one free get_active_missions
  // query on the complete_mission step alone.
  if (step.action === "complete_mission") {
    const block = await completeMissionBlock(api, step);
    if (block) return block;
  }

  // Mine precondition guard (preconditions-are-checked-deterministically, not
  // remembered -- same family as the undock guard above and the station-
  // awareness dock briefing). Live miss: the pilot planned `mine` with no
  // mining laser fitted; the game answers that with a guaranteed error, so the
  // step blocked and replanned for nothing. Invariant: mine needs a fitted
  // mining module -- never send a guaranteed-error call. Fires ONLY when the
  // fitted set is known (preStatus.modules !== undefined) and none of them is a
  // mining laser; a null/absent-modules snapshot skips the check and lets
  // classifyGameError catch any real block at the call site (best-effort, like
  // the guards above). Unlike undock (a satisfiable no-op -> advance), a mine
  // with no laser is NOT satisfiable, so it is a `blocked` wake: the planner
  // must acquire/fit a laser or change goal, not silently skip the step.
  //
  // SCOPE: this is the cheap "is a laser fitted at all" check. The fuller
  // "does your mining_power suit THIS deposit's supported_power" pre-check --
  // deferred here until the get_poi shape was cited -- now exists below
  // (mineDepositBlock, issue #188), built on the PoiDepositsSchema citation
  // that #291/PR #302 landed.
  if (step.action === "mine" && preStatus?.modules !== undefined && !hasMiningModule(preStatus)) {
    const reason = "no mining equipment fitted; a mine action needs a mining laser module";
    return { kind: "blocked", reason, resultText: reason };
  }

  // Mine deposit precondition (issue #188) -- see mineDepositBlock above.
  // After the cheap no-laser guard (no point pricing a deposit the ship
  // cannot mine at all) and only on the step's first submission: one free
  // get_poi per mine STEP, not per repeat tick.
  if (step.action === "mine" && cursor.iteration === 0) {
    const block = await mineDepositBlock(api, preStatus, learnedSparse);
    if (block) return block;
  }

  // Catalog-gated jettison guard (issue #94): refuse to destroy an item the
  // catalog says is valuable (see JETTISON_VALUE_FLOOR above). The reason is
  // written alternatives-FIRST -- the digest clips a blocked wake's detail at
  // 200 chars, so the actionable steer (hold / re-check markets /
  // create_sell_order) must fit inside the clip (same ordering receipt as the
  // buy-id correction below). Fail-open when the catalog has no value for the
  // id: never fabricate a block from missing data.
  if (step.action === "jettison") {
    const id = (step.params as { id: string }).id;
    const value = catalog.itemValue(id);
    if (value !== undefined && value >= JETTISON_VALUE_FLOOR) {
      const reason =
        `jettison of ${id} refused (catalog base_value ${value}cr >= ${JETTISON_VALUE_FLOOR}cr floor): ` +
        `HOLD it and re-check markets when docked, or list it with create_sell_order -- ` +
        `valuable cargo is never destroyed.`;
      return { kind: "blocked", reason, resultText: reason };
    }
  }

  // Fit precondition guard (issue #219) -- see installModBlock above. Sits with
  // the other pre-step preconditions; the only one that spends a (free) query,
  // and only on the step that needs it.
  if (step.action === "install_mod") {
    const block = await installModBlock(api, step, preStatus);
    if (block) return block;
  }

  // withdraw precondition guard (capability audit, Workflow A 2026-07-19):
  // storage.md:46, "Deposits and withdrawals always require docking at a base
  // with storage service" -- a guaranteed error the same class as undock's and
  // install_mod's docked checks above. Fires only when preStatus is known
  // (fail-open, same convention as every guard here): an unknown dock state
  // skips the check and lets classifyGameError catch the real block.
  if (step.action === "withdraw" && preStatus?.docked === false) {
    const reason =
      `withdraw blocked: you must be DOCKED at a station with storage service. ` +
      `Plan dock first, then withdraw{item_id=...}.`;
    return { kind: "blocked", reason, resultText: reason };
  }

  // Target-locality guard (issue #176) -- see targetLocalityBlock above. Sits
  // with the other pre-step preconditions and ahead of the travel_to macro
  // (travel_to is not guarded here: its reachability authority is find_route,
  // per the normalize-plan.ts receipt).
  if (step.action === "travel" || step.action === "scan") {
    const block = await targetLocalityBlock(api, step);
    if (block) return block;
  }

  if (step.action === "travel_to") {
    return travelToTick(api, plan, cursor, step.params.system_id, preStatus);
  }

  // create_sell_order / create_buy_order price default (issue #94, extended to
  // the buy side by #316): the deterministic pricing rule promised by both
  // registry entries (actions.ts) -- an omitted price_each is filled from the
  // catalog base_value, so the planner never has to guess a number. When the
  // catalog has no value either, there is nothing deterministic to default
  // from: block for a replan with an explicit price_each rather than send an
  // unpriced order (the game's behavior on a missing price is uncaptured --
  // no load-bearing unknowns).
  let sendParams = step.params as Record<string, unknown>;
  if ((step.action === "create_sell_order" || step.action === "create_buy_order") && sendParams.price_each === undefined) {
    const itemId = (step.params as { item_id: string }).item_id;
    const value = catalog.itemValue(itemId);
    if (value === undefined) {
      const reason =
        `${step.action} for ${itemId} needs an explicit price_each -- ` +
        `the catalog has no base_value to default from. Plan it again with price_each set.`;
      return { kind: "blocked", reason, resultText: reason };
    }
    sendParams = { ...sendParams, price_each: value };
  }

  let result: V2Result;
  try {
    result = await api.action(step.action, sendParams);
  } catch (e) {
    if (e instanceof SpacemoltError) {
      const classified = classifyGameError(e);
      // Buy-id correction (issue #152, see nearestCatalogItemId above): an
      // invalid_item buy block gets the nearest catalog id prepended to the
      // blocked detail -- correction FIRST so the digest's 200-char untrusted-
      // text clip can never cut it, the game's own text kept after it for
      // diagnosis. Surfacing only; the buy is never auto-retried (#137).
      if (classified.kind === "blocked" && step.action === "buy" && e.message.includes("invalid_item")) {
        const attempted = (step.params as { id?: unknown }).id;
        const suggestion = typeof attempted === "string" ? nearestCatalogItemId(attempted) : undefined;
        if (suggestion && suggestion !== attempted) {
          const reason =
            `invalid_item: '${attempted}' is not a catalog item id -- did you mean '${suggestion}'? ` +
            `Plan the buy again with id ${suggestion} exactly. Game said: ${e.message}`;
          return { kind: "blocked", reason, resultText: reason };
        }
      }
      return classified;
    }
    throw e; // non-game errors (bugs) propagate
  }

  const resultText = snippet(result.result);

  // Sell verifies against a pre-action cargo snapshot -- preStatus, fetched
  // above before the mutation, is exactly that (no separate query). Skipped
  // only if that read failed (preStatus null); the plan_done thrash damper
  // still backstops a phantom-sell loop (see verifySellEffect above).
  if (step.action === "sell" && preStatus) {
    const blockedReason = await verifySellEffect(api, (step.params as { id: string }).id, preStatus, result);
    if (blockedReason) return { kind: "blocked", reason: blockedReason, resultText: blockedReason };
  }

  // SM-12: the action was accepted but resolves next tick (async yield).
  const pending = (result.result ?? "").toLowerCase().includes(ACTION_PENDING_MARKER);

  const iteration = cursor.iteration + 1;
  let stepDone: boolean;
  if (step.until) stepDone = await conditionMet(api, step.until);
  else if (step.repeat) stepDone = iteration >= step.repeat;
  else stepDone = true;

  // A still-resolving accept that keeps the SAME repeated step gets `settle`, so
  // the loop waits one tick for the prior submission to resolve before
  // re-firing (pacing to the tick, not re-racing it). A completing/advancing
  // continue omits it -- the next step's action differs, so there is no
  // same-action self-race to pace against.
  if (!stepDone) {
    return { kind: "continue", cursor: { step: cursor.step, iteration }, resultText, ...(pending ? { settle: true as const } : {}) };
  }
  return advance(plan, cursor, resultText);
}
