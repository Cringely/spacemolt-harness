import type { FittedModule } from "../client/client";

// Module-fitment SSOT (issues #757, #736).
//
// Invariant: a plan step must not be SUBMITTED when the ship's fitted loadout
// is known and the module the game requires for that action is provably
// absent -- established here, the one place that says which action needs which
// module and how a fitted module is recognised as that module.
//
// Two live reports, one cause. The scout planned `survey_system` 204 times
// lifetime and failed 204 times (90 of them inside one 72h window, over half
// of every action it logged) on `no_scanner: "No survey scanner equipped."`;
// the miner planned `tow` 6 times and failed 6 times on `no_tow_rig: "Your
// ship needs a tow rig module fitted (utility slot)."` In both the planner
// proposed an action gated on a module the ship does not carry and nothing
// checked fitment before the call went out. Only `mine` had such a check
// (executor.ts's hasMiningModule since 2026-07-12), and it was written as one
// bespoke predicate, so every later module-gated action had to rediscover the
// idea -- twice, so far, both times as a live 100%-failure capability.
//
// WHY A TABLE AND NOT TWO MORE PREDICATES (simplicity rule 3): the rejected
// alternative was a `survey_system` guard beside the `mine` one and a `tow`
// guard beside that. It is fewer lines TODAY and it is the shape that produced
// both issues: the requirement lives in the reference, the reference names
// seven of them, and a per-action predicate cannot be audited against that
// list. A table can, and the audit is this file's comment block below.
//
// EVERY REGISTERED ACTION THE VENDORED REFERENCE GATES ON A FITTED MODULE,
// audited 2026-09-11 by reading the `description` of every registry mutation's
// own path in docs/game-reference/upstream/openapi-v2.json. Seven exist; four
// are in the table below, three are deliberately out and say why:
//
//   mine           mining laser / ice harvester / gas harvester
//                  (openapi-v2.json:43212) -- IN
//   survey_system  survey scanner module or an integrated-survey-scanner hull
//                  (openapi-v2.json:47331; upstream/docs/exploration.md:46,56;
//                  upstream/docs/mining.md:54,113) -- IN
//   tow            tow rig utility module fitted
//                  (openapi-v2.json:104541; upstream/docs/wrecks.md:48,111) -- IN
//   cloak          cloaking device module or an integrated-cloak hull
//                  (openapi-v2.json:32683; upstream/docs/scanning.md:32,112) -- IN
//   refuel         Refueling Pump module, but ONLY in the ship-to-ship form
//                  (`target` naming a player -- openapi-v2.json:44483's mode
//                  list; upstream/docs/travel.md:62) -- OUT. Two reasons, and
//                  either alone is enough: the gate is conditional on a param
//                  value rather than on the action, and the module's IDENTITY
//                  is undecidable from anything this repo holds -- the Module
//                  schema carries no fuel-transfer stat to key on and no
//                  capture names a Refueling Pump's `type` (the finding that
//                  killed round 1 of the #595 guard, see refuelTargetBlock in
//                  executor.ts). The observed failure class is a bad `target`,
//                  which that guard already catches.
//   repair         Repair Arm module, same ship-to-ship-only shape
//                  (openapi-v2.json:44929's mode list) -- OUT: conditional on
//                  the same `target` param, and no live failure evidences it.
//   jump           Pathfinder Drive module, but ONLY when `id` is a compass
//                  BEARING rather than a system id (openapi-v2.json:42134's
//                  PATHFINDER DRIVE note) -- OUT: conditional on the param's
//                  FORM, never observed from our planner, and the Module
//                  schema carries no pathfinder-specific stat.
//
// Checked and NOT module-gated, so deliberately absent rather than missed:
// `scan` (scanner modules add POWER to a contest, they are not a precondition
// -- "scanning fauna always succeeds", openapi-v2.json:45776) and `attack` (no
// module requirement in its description, openapi-v2.json:31825, and
// upstream/docs/combat.md:51,96 describes weapons as deciding what FIRES, not
// what may engage). Neither is guessed into the table on the strength of
// sounding equipment-shaped.

/**
 * How the game's requirement for ONE action is recognised on a fitted module.
 *
 * THREE signal channels, because no single one is both complete and captured.
 * A module satisfies the requirement when ANY channel matches; the verdict is
 * `absent` only when the fitted set is known and none of the three fires on
 * any fitted module. Each channel and its evidence tier:
 *
 *   `types`      the game's own `type` tag on a fitted module. Strongest
 *                available (a LIVE capture: the miner's Mining Laser I reports
 *                `type: "mining"` -- test/fixtures/spacemolt-probe-2026-07-12
 *                .json, get_status.modules[0]) and the least complete: that
 *                probe is the ONLY fitted module this repo has ever captured,
 *                so "mining" is the only `type` value anything here can cite.
 *                The OpenAPI declares Module.type a bare string with no enum
 *                (openapi-v2.json:20172), so inventing "survey" or "salvage"
 *                to fill the other rows would be a guess of exactly the shape
 *                that cost this project 86 buys on `fuel_cells` -- left empty
 *                instead.
 *   `stats`      a stat key whose positive value can only belong to that
 *                module. Every key here is a real field of the catalog's
 *                Module schema (openapi-v2.json:20172 -- cloak_strength:20196,
 *                mining_power:20259, survey_power:20349, tow_speed_penalty:
 *                20355). What is INFERRED, and flagged as such rather than
 *                presented as captured: that a fitted module's `stats` block
 *                carries those same field names. The one live capture shows
 *                `stats: { mining_power: 5 }` on a mining laser -- the bucket
 *                holds Module stat fields under their Module names -- but no
 *                capture of a survey scanner, tow rig or cloak exists to
 *                confirm it for theirs.
 *   `typeIdAny`  a substring of the fitted module's `type_id`. The live probe
 *                reports `type_id: "mining_laser_i"`, byte-identical to the
 *                catalog item id of the same name, so a module's type_id IS
 *                its catalog id; the substrings below are read off the
 *                vendored catalog snapshot (src/catalog/catalog.data.json,
 *                game catalog 0.493.0) and cover every module it lists for
 *                each requirement.
 *
 * The channels exist to make the ABSENT verdict hard to reach by accident,
 * which is the only direction that hurts: a false `satisfied` costs the one
 * wasted tick we already pay today, a false `absent` costs a capability the
 * pilot actually has. Any one channel firing is enough.
 */
export interface FitmentRequirement {
  /** Registry action name this requirement gates. */
  action: string;
  /** The module as the game names it, quoted back to the planner. */
  module: string;
  /** Fitted-module `type` values that satisfy it (live-captured values only). */
  types: readonly string[];
  /** Fitted-module stat keys whose positive value satisfies it. */
  stats: readonly string[];
  /** Catalog type_id substrings that satisfy it. */
  typeIdAny: readonly string[];
  /**
   * The ShipClass `inherent_capabilities[].type` that makes the module
   * unnecessary, when the reference documents a hull-integrated substitute
   * (openapi-v2.json:25746, the capability list at :25755). undefined = the
   * reference documents no hull substitute, so the fitted set alone decides.
   *
   * This field is why the guard is not a pure function of `modules`. Blocking
   * `survey_system` on a hull carrying `integrated_survey_scanner` would be a
   * guard contradicting the very reference it was built from -- and the hull's
   * capability list is NOT in get_status (the live ship block carries
   * class_id and no capabilities), so it has to be looked up.
   */
  hullCapability?: string;
  /**
   * The blocked-wake text, written REMEDY-FIRST: the digest clips an untrusted
   * block detail at 200 chars (digest.ts's UNTRUSTED_TEXT_SNIPPET_LEN), so the
   * actionable steer has to survive the clip and the diagnosis goes after it --
   * the same ordering receipt the jettison, install_mod and deposit-gift
   * reasons carry.
   *
   * Each one contains the literal phrase "needs a <thing> module" on purpose:
   * the failure taxonomy's tier-1 prose rule (/needs a .+ module/i,
   * src/server/failures.ts:43) groups exactly that into `missing_module`, which
   * is the class the game itself used for the `tow` half of this fix. Without
   * it each refusal would become its own sentence-shaped class in the
   * prevented-steps table.
   *
   * Whole strings rather than a template, so the `mine` row can carry its
   * pre-existing wording byte-for-byte. That text has been live since
   * 2026-07-12 and is a provenance case in the taxonomy's own test
   * (test/failures.test.ts) -- rewording it is a separate change from
   * generalising the guard, and bundling the two would hide one behind the
   * other.
   */
  reason: string;
}

/**
 * `satisfied` -- a fitted module (or the hull) provides it.
 * `absent`    -- the fitted set is KNOWN and nothing in it provides it.
 * `unknown`   -- the fitted set could not be read at all.
 *
 * Three values, never two. `unknown` and `absent` are the same shape of "we
 * found no matching module" and the opposite verdicts: absence of data is
 * never a verdict here (issue #94's rule), so only `absent` may block.
 */
export type FitmentVerdict = "satisfied" | "absent" | "unknown";

const REQUIREMENTS: readonly FitmentRequirement[] = [
  {
    action: "mine",
    module: "mining laser (or the ice/gas harvester the POI's type needs)",
    // Preserves executor.ts's original hasMiningModule predicate exactly
    // (`type === "mining"` OR a positive mining_power) -- the type_id channel
    // is deliberately EMPTY here rather than filled with "mining_laser": this
    // row is a lift-and-shift of a guard that has been live since 2026-07-12,
    // and widening what counts as a mining module is a behaviour change that
    // belongs to its own issue, not to this one.
    types: ["mining"],
    stats: ["mining_power"],
    typeIdAny: [],
    reason: "no mining equipment fitted; a mine action needs a mining laser module",
  },
  {
    action: "survey_system",
    module: "survey scanner",
    types: [],
    stats: ["survey_power", "survey_range"],
    // survey_scanner_i, survey_scanner_ii and deep_core_survey_scanner are
    // every survey scanner in the vendored catalog; all three contain this.
    typeIdAny: ["survey_scanner"],
    hullCapability: "integrated_survey_scanner",
    reason:
      "survey_system blocked: stop planning it on this ship -- fit a scanner first or pick a goal " +
      "that needs none. It needs a survey scanner module (buy{id=survey_scanner_i, quantity=1} " +
      "while docked, then install_mod{id=survey_scanner_i}); this hull has none, so every " +
      "survey_system returns no_scanner.",
  },
  {
    action: "tow",
    module: "tow rig (utility slot)",
    types: [],
    stats: ["tow_speed_penalty"],
    // basic_tow_rig and advanced_tow_rig are both tow rigs in the catalog.
    typeIdAny: ["tow_rig"],
    reason:
      "tow blocked: loot the wreck where it lies instead -- looting takes its cargo and modules " +
      "with no tow at all. Towing needs a tow rig module in a utility slot " +
      "(buy{id=basic_tow_rig, quantity=1} while docked, then install_mod{id=basic_tow_rig}); " +
      "this hull has none, so every tow returns no_tow_rig.",
  },
  {
    action: "cloak",
    module: "cloaking device",
    types: [],
    stats: ["cloak_strength"],
    // cloaking_device_i, cloaking_device_ii and phase_cloaking_device all
    // contain this; cloaking_charge/cloaking_dust are consumables and cannot
    // appear in a FITTED module list at all.
    typeIdAny: ["cloaking_device"],
    hullCapability: "integrated_cloak",
    reason:
      "cloak blocked: travel openly, or fit a cloak before planning to hide. Cloaking needs a " +
      "cloaking device module (buy{id=cloaking_device_i, quantity=1} while docked, then " +
      "install_mod{id=cloaking_device_i}); this hull has none and does not integrate one.",
  },
];

const BY_ACTION = new Map(REQUIREMENTS.map((r) => [r.action, r]));

/** The fitment requirement for an action, or undefined when it has none. */
export function fitmentRequirement(action: string): FitmentRequirement | undefined {
  return BY_ACTION.get(action);
}

/** Every requirement in the table, for tests and for any future briefing. */
export function fitmentRequirements(): readonly FitmentRequirement[] {
  return REQUIREMENTS;
}

/**
 * Does this ONE fitted module provide the requirement? Any of the three
 * channels is enough (see FitmentRequirement).
 *
 * `miningPower` is read alongside `stats.mining_power` because it is the same
 * number under an older name: client.ts has mapped `stats.mining_power` onto
 * the dedicated field since 2026-07-12 and several consumers still read it, so
 * a module carrying only the alias must still satisfy the mine row.
 */
function provides(module: FittedModule, req: FitmentRequirement): boolean {
  if (req.types.includes(module.type)) return true;
  for (const key of req.stats) {
    const value = key === "mining_power" && module.miningPower !== undefined
      ? module.miningPower
      : module.stats?.[key];
    if ((value ?? 0) > 0) return true;
  }
  return req.typeIdAny.some((fragment) => module.typeId.includes(fragment));
}

/**
 * Can the FITTED SET alone decide this requirement?
 *
 * `modules === undefined` means the get_status modules block was absent or
 * malformed, which client.ts maps to UNKNOWN on purpose (never to an empty
 * fit). A present array -- including an empty one, a real hull with nothing
 * fitted -- is knowledge, and yields `absent` when nothing in it matches.
 *
 * The hull's own integrated capability is NOT considered here: it is not in
 * get_status and costs a query to read, so a caller that can afford the query
 * resolves `absent` further (see fitmentBlock, executor.ts) and one that
 * cannot treats `absent` as inconclusive for a row carrying hullCapability.
 */
export function fitmentVerdict(
  req: FitmentRequirement, modules: FittedModule[] | undefined,
): FitmentVerdict {
  if (modules === undefined) return "unknown";
  return modules.some((m) => provides(m, req)) ? "satisfied" : "absent";
}
