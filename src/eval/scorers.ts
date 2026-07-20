import { REGISTRY, getAction } from "../registry/actions";
import { catalog } from "../catalog/catalog";
import { EXTRACTION_MODULE_BY_POI_TYPE } from "../planner/digest";
import type { CandidatePlan, CandidateStep, EvalCase, ScoreResult, Scorer } from "./types";

// Deterministic scorers for the offline planner eval (issue #263).
//
// EVERY scorer below is derived from a failure a planner ACTUALLY committed on
// the live pilot -- the class it catches is named in its comment. No scorer
// exists because it seemed like a good idea (AGENTS.md value-density rule): if
// it cannot name a real incident, it is not here.
//
// THREE verdicts, not two. `abstain` is load-bearing: a scorer whose input is
// missing from the case (no surroundings, no cargo manifest, no ground-truth
// system list) must NOT report a violation it cannot see. That is the M-34
// lesson -- absence of data must never render a negative verdict -- and without
// it the eval would punish a good plan on a thin case and quietly become noise.

const MUTATION_NAMES = new Set(REGISTRY.filter((a) => a.kind === "mutation").map((a) => a.name));
// travel_to is executor vocabulary, not a REGISTRY action (see registry/plan.ts).
const TRAVEL_TO = "travel_to";

function pass(scorer: string, reason: string): ScoreResult { return { scorer, verdict: "pass", reason }; }
function fail(scorer: string, reason: string): ScoreResult { return { scorer, verdict: "fail", reason }; }
function abstain(scorer: string, reason: string): ScoreResult { return { scorer, verdict: "abstain", reason }; }

function stepLabel(i: number, s: CandidateStep): string {
  return `step ${i} (${s.action} ${JSON.stringify(s.params)})`;
}

function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }

/**
 * CLASS: invented action name. The local model under test emitted `Sell cargo`
 * for `sell_cargo` when unconstrained (#240, 2026-07-14 workstation note); a
 * grammar constraint hides this at runtime but a model that reaches for
 * unregistered verbs is a model that will reach for unregistered params too.
 */
const knownAction: Scorer = (plan) => {
  const bad = plan.steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !MUTATION_NAMES.has(s.action) && s.action !== TRAVEL_TO);
  if (!bad.length) return pass("known_action", `${plan.steps.length} step(s), all registered`);
  return fail("known_action", bad.map(({ s, i }) => `${stepLabel(i, s)}: not a registered mutation`).join("; "));
};

/**
 * CLASS: a step the game would reject on shape -- a missing required param or a
 * wrong type. The registry's zod schema IS the shape contract (src/registry/
 * actions.ts), so this scorer asks the schema rather than re-stating it.
 * Unknown-action steps are skipped here (knownAction owns them); a plan of only
 * unknown actions therefore abstains rather than double-counting one defect.
 */
const requiredParams: Scorer = (plan) => {
  const checked: string[] = [];
  const bad: string[] = [];
  plan.steps.forEach((s, i) => {
    if (s.action === TRAVEL_TO) {
      checked.push(s.action);
      if (!str(s.params.system_id)) bad.push(`${stepLabel(i, s)}: travel_to needs a string system_id`);
      return;
    }
    if (!MUTATION_NAMES.has(s.action)) return; // knownAction's business
    checked.push(s.action);
    const res = getAction(s.action).params.safeParse(s.params);
    if (!res.success) bad.push(`${stepLabel(i, s)}: ${res.error.issues.map((e) => e.message).join(", ")}`);
  });
  if (!checked.length) return abstain("required_params", "no step with a known action to check");
  if (bad.length) return fail("required_params", bad.join("; "));
  return pass("required_params", `${checked.length} step(s) match their registry schema`);
};

/**
 * CLASS: invented system id. SM-9 planned `travel_to trappist_prime_belt`, then
 * `travel_to trappist_prime` -- "Target system not found", twice. jump is checked
 * against the case's own connections (a jump is ONE hop, by definition an
 * adjacent system); travel_to is checked against the ground-truth system list
 * because it legitimately reaches systems beyond the connections -- and with no
 * such list on the case, this scorer abstains on travel_to rather than fail a
 * plan for naming a real distant system we simply cannot see.
 */
const knownSystemRef: Scorer = (plan, c) => {
  const conns = c.ctx.surroundings?.connections;
  const known = c.groundTruth?.knownSystemIds;
  const bad: string[] = [];
  let checked = 0;
  plan.steps.forEach((s, i) => {
    if (s.action === "jump") {
      const id = str(s.params.id);
      if (!id || !conns) return;
      checked++;
      if (!conns.includes(id)) bad.push(`${stepLabel(i, s)}: '${id}' is not an adjacent system (${conns.join(", ") || "none known"})`);
    }
    if (s.action === TRAVEL_TO) {
      const id = str(s.params.system_id);
      if (!id || !known) return;
      checked++;
      if (!known.includes(id)) bad.push(`${stepLabel(i, s)}: '${id}' is not a system that exists`);
    }
  });
  if (!checked) return abstain("known_system_ref", "no checkable system reference (no jump/travel_to, or no map/ground truth)");
  if (bad.length) return fail("known_system_ref", bad.join("; "));
  return pass("known_system_ref", `${checked} system reference(s) resolve`);
};

/**
 * CLASS: invented POI id. The digest's whole POI list exists because the maiden
 * flight hallucinated "alpha_mining"; `travel` reaches a POI in THIS system, so
 * an id absent from the case's POI list is a guaranteed error.
 */
const knownPoiRef: Scorer = (plan, c) => {
  const pois = c.ctx.surroundings?.pois;
  if (!pois) return abstain("known_poi_ref", "no surroundings on this case");
  const travels = plan.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.action === "travel" && str(s.params.id));
  if (!travels.length) return abstain("known_poi_ref", "no travel step to check");
  const ids = new Set(pois.map((p) => p.id));
  const bad = travels.filter(({ s }) => !ids.has(str(s.params.id)!));
  if (bad.length) {
    return fail("known_poi_ref", bad.map(({ s, i }) => `${stepLabel(i, s)}: '${s.params.id}' is not a POI in this system`).join("; "));
  }
  return pass("known_poi_ref", `${travels.length} POI reference(s) resolve`);
};

// Which params carry an ITEM id. install_mod/uninstall_mod are deliberately
// EXCLUDED: their `id` accepts a module type id OR a fitted-module INSTANCE id
// from get_ship (registry/actions.ts, upstream openapi-v1 uninstall_mod
// description), and an instance id is not a catalog key -- scoring them would
// manufacture false failures.
const ITEM_PARAM_BY_ACTION: Record<string, string> = {
  buy: "id",
  sell: "id",
  jettison: "id",
  create_sell_order: "item_id",
  create_buy_order: "item_id",
};

/**
 * CLASS: item id derived from prose. The game's own refuel error says "Buy fuel
 * cells"; the item id is `fuel_cell`, singular -- 86/86 lifetime buy failures on
 * `fuel_cells` (#179/#152). The catalog (src/catalog/) is the id SSOT.
 */
const knownItemId: Scorer = (plan) => {
  const checked: Array<{ s: CandidateStep; i: number; id: string }> = [];
  plan.steps.forEach((s, i) => {
    const param = ITEM_PARAM_BY_ACTION[s.action];
    const id = param ? str(s.params[param]) : undefined;
    if (id) checked.push({ s, i, id });
  });
  if (!checked.length) return abstain("known_item_id", "no item-bearing step to check");
  const bad = checked.filter(({ id }) => !catalog.itemMeta(id));
  if (bad.length) {
    return fail("known_item_id", bad.map(({ s, i, id }) => `${stepLabel(i, s)}: '${id}' is not a catalog item`).join("; "));
  }
  return pass("known_item_id", `${checked.length} item id(s) exist in the catalog`);
};

/**
 * CLASS: dock where nothing is dockable (M-21; SM-9 did it 3x in 15 minutes).
 * get_system's POIs carry has_base, the digest renders it as [station], and the
 * briefing says dock only at a [station]. A plan that docks in a system whose POI
 * list carries no station at all is a guaranteed block. Deliberately narrow: it
 * fails only on the unambiguous case (NO station anywhere in this system). Where
 * a station exists, whether the ship reaches THAT POI before the dock step is a
 * routing question this scorer does not pretend to answer -- and a scorer that
 * guessed would be inventing failures (M-34).
 */
const dockRequiresStation: Scorer = (plan, c) => {
  const s = c.ctx.surroundings;
  if (!s) return abstain("dock_requires_station", "no surroundings on this case");
  // Only docks that execute in THIS system are checkable: a dock after a jump or
  // travel_to happens somewhere this case cannot see, and failing it would be a
  // fabricated verdict (M-34).
  const leaves = plan.steps.findIndex((st) => st.action === "jump" || st.action === TRAVEL_TO);
  const local = leaves < 0 ? plan.steps : plan.steps.slice(0, leaves);
  const docks = local.map((st, i) => ({ st, i })).filter(({ st }) => st.action === "dock");
  if (!docks.length) return abstain("dock_requires_station", "no dock step in this system to check");
  if (s.dockedAt) return pass("dock_requires_station", "already docked at a station");
  if (s.pois.some((p) => p.hasBase)) return pass("dock_requires_station", "this system has a [station] POI");
  return fail(
    "dock_requires_station",
    docks.map(({ st, i }) => `${stepLabel(i, st)}: no POI in ${s.systemId ?? "this system"} is marked [station]`).join("; "),
  );
};

/** The POI a step at index `i` executes at, as far as the plan itself determines it. */
function poiAtStep(plan: CandidatePlan, i: number, c: EvalCase): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const s = plan.steps[j]!;
    // A step that leaves the system makes the position unknowable from this case.
    if (s.action === "jump" || s.action === TRAVEL_TO) return undefined;
    if (s.action === "travel") return str(s.params.id);
  }
  return c.ctx.surroundings?.currentPoi?.id;
}

/**
 * CLASS: mine what your ship cannot extract (#253 -- 39 blocks in 72h: 27 gas +
 * 12 ice, from a pilot carrying only a mining laser; the SM-9 model ignored the
 * same markers). The POI-type -> required-module rule is imported from digest.ts,
 * so the scorer grades against the exact rule the planner was briefed on.
 * Abstains when the mine's POI can't be resolved from the plan (a mine after a
 * jump) or the fit is unknown -- an unknowable position is not a violation.
 */
const mineNeedsMatchingModule: Scorer = (plan, c) => {
  const s = c.ctx.surroundings;
  const fitted = c.ctx.fittedModules;
  if (!s || !fitted) return abstain("mine_needs_matching_module", "no surroundings or no fitted-module list on this case");
  const mines = plan.steps.map((st, i) => ({ st, i })).filter(({ st }) => st.action === "mine");
  if (!mines.length) return abstain("mine_needs_matching_module", "no mine step to check");
  const byId = new Map(s.pois.map((p) => [p.id, p]));
  const bad: string[] = [];
  let checked = 0;
  for (const { st, i } of mines) {
    const poiId = poiAtStep(plan, i, c);
    const poi = poiId ? byId.get(poiId) : undefined;
    if (!poi) continue; // position unknowable from this case -> not a violation
    checked++;
    // The learned backstop: the game already refused THIS ship's fit here.
    if (poi.incompatible) {
      bad.push(`${stepLabel(i, st)}: ${poi.id} already blocked this ship's fit (needs ${poi.incompatible})`);
      continue;
    }
    const needed = EXTRACTION_MODULE_BY_POI_TYPE[poi.type];
    if (!needed) continue; // unmarked POI: unknown yield, not known-empty -> no verdict
    if (!fitted.some((m) => m.typeId.startsWith(needed))) {
      bad.push(`${stepLabel(i, st)}: ${poi.id} is a ${poi.type} and needs a ${needed}_* module; fitted: ${fitted.map((m) => m.typeId).join(", ") || "nothing"}`);
    }
  }
  if (!checked) return abstain("mine_needs_matching_module", "mine step's POI is not resolvable from this plan");
  if (bad.length) return fail("mine_needs_matching_module", bad.join("; "));
  return pass("mine_needs_matching_module", `${checked} mine step(s) match the fitted extraction module`);
};

/**
 * CLASS: mine into a full hold (SM-9 did it; the sonnet plan on the same state
 * sold first). A mine with a full hold is a wasted tick and a guaranteed block.
 * Anything that frees hold space first (sell, jettison) clears the verdict --
 * create_sell_order does NOT: it lists cargo on the exchange, it does not remove
 * it from the hold.
 */
const noMineIntoFullHold: Scorer = (plan, c) => {
  const cargo = c.ctx.cargo;
  if (!cargo) return abstain("no_mine_into_full_hold", "no cargo manifest on this case");
  const mineIdx = plan.steps.findIndex((s) => s.action === "mine");
  if (mineIdx < 0) return abstain("no_mine_into_full_hold", "no mine step to check");
  if (cargo.used < cargo.capacity) return pass("no_mine_into_full_hold", `hold has room (${cargo.used}/${cargo.capacity})`);
  const freesHold = plan.steps.slice(0, mineIdx).some((s) => s.action === "sell" || s.action === "jettison");
  if (freesHold) return pass("no_mine_into_full_hold", "plan frees hold space before mining");
  return fail(
    "no_mine_into_full_hold",
    `${stepLabel(mineIdx, plan.steps[mineIdx]!)}: hold is FULL (${cargo.used}/${cargo.capacity}) and no sell/jettison precedes it`,
  );
};

// Which actions REMOVE (or commit) an item from the hold, and the param that
// names it. sell/jettison physically remove the units; create_sell_order
// commits them to an exchange listing -- for COHERENCE (do you possess what you
// dispose of?) all three require the item in the hold, even though
// create_sell_order does not free hold SPACE (that is noMineIntoFullHold's
// distinction). buy/create_buy_order are NOT here: they ADD, not remove.
const REMOVAL_ITEM_PARAM: Record<string, string> = {
  sell: "id",
  jettison: "id",
  create_sell_order: "item_id",
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * CLASS: a plan that is valid step-by-step but incoherent as a SEQUENCE -- it
 * sells, jettisons, or lists an item the hold never held (issue #268, found by
 * the PR #267 review). This is the SM-9 class an eval that GATES model swaps
 * must catch: "sell before mining anything" passes every OTHER scorer (each step
 * is a real action, valid params, at a real place), because no other scorer
 * looks at the RUNNING cargo state across steps -- only this one simulates it.
 *
 * The sim: seed a hold from the case's cargo manifest, walk the steps in order.
 * buy ADDS the bought item (an arbitrage plan legitimately sells what it just
 * bought). mine ADDS an UNKNOWN item -- its yield is not in the step, so after
 * any mine a shortfall can no longer be PROVEN: the mine may have supplied it,
 * and M-34 forbids a verdict on what we cannot see. A removal of an item the
 * hold does not hold in sufficient quantity, with NO prior producer that could
 * have supplied it, is the provable incoherence -> FAIL.
 *
 * Every add/remove honors the step's loop count the way the executor does
 * (executor.ts:1024-1027, #349): `repeat: N` multiplies the per-iteration amount
 * by N; `until` (cargo_full/cargo_empty) loops against live state, so a removal
 * drains its item and a buy fills the REMAINING hold capacity. Counting each
 * step as a single add/remove under-detected a `repeat:N` sell of an item the
 * hold holds one of.
 *
 * ABSTAINS (never fails) when cargo is unknown -- absence of the starting state
 * is not a negative verdict (M-34); a false FAIL here would wrongly gate a good
 * model. Also abstains when there is no removal step, or when every removal
 * trails a mine and so is unprovable.
 */
const cargoCoherence: Scorer = (plan, c) => {
  const cargo = c.ctx.cargo;
  if (!cargo) return abstain("cargo_coherence", "no cargo manifest on this case");
  const hasRemoval = plan.steps.some((s) => {
    const p = REMOVAL_ITEM_PARAM[s.action];
    return p !== undefined && str(s.params[p]) !== undefined;
  });
  if (!hasRemoval) return abstain("cargo_coherence", "no sell/jettison/create_sell_order step to check");

  const hold = new Map<string, number>();
  for (const it of cargo.items) hold.set(it.itemId, (hold.get(it.itemId) ?? 0) + it.quantity);
  let minedUnknown = false;
  const bad: string[] = [];
  let checked = 0;

  plan.steps.forEach((s, i) => {
    if (s.action === "mine") { minedUnknown = true; return; }
    if (s.action === "buy") {
      const id = str(s.params.id);
      if (!id) return;
      // Mirror the executor loop (executor.ts:1024-1027). Symmetry with the
      // removal branch below: a buy ADDS perIter*N units under `repeat: N`, or
      // fills the hold under `until` (cargo_full/cargo_empty). Under-counting
      // the add would false-FAIL a later sell of what was legitimately bought
      // (M-34: never fabricate a shortfall). An `until` buy can add only the
      // REMAINING capacity, not the whole hold -- so a second until-buy fills
      // only what the first left (else two until-buys of 100 each both "fit" a
      // 50-cap hold, a false PASS on an overflow plan). Remaining is capacity
      // minus what the simulated hold already carries.
      if (s.until) {
        let held = 0;
        for (const qty of hold.values()) held += qty;
        const room = Math.max(0, cargo.capacity - held);
        if (room > 0) hold.set(id, (hold.get(id) ?? 0) + room);
        return;
      }
      const bq = num(s.params.quantity);
      if (bq && bq > 0) hold.set(id, (hold.get(id) ?? 0) + bq * (s.repeat ?? 1));
      return;
    }
    const param = REMOVAL_ITEM_PARAM[s.action];
    if (param === undefined) return;
    const id = str(s.params[param]);
    if (!id) return; // no item named -> a shape defect requiredParams owns, not an incoherence
    const q = num(s.params.quantity);
    const perIter = q && q > 0 ? q : 1; // absent quantity -> presence check (>=1); requiredParams owns the missing param
    // Mirror the executor loop (executor.ts:1024-1027): `until` (cargo_full/
    // cargo_empty) re-fires the removal against live state -> it drains this
    // item toward 0; `repeat: N` fires it exactly N times; a bare step fires
    // once. So a removal disposes of perIter*N units (repeat) or the whole
    // holding (until) -- counting 1 under-detected a plan that removes more than
    // the hold holds (#349). For `until` only the FIRST iteration is provable
    // (the executor submits, THEN checks the condition), so its shortfall test
    // uses perIter while its effect drains the item to 0. A mid-until game block
    // halts the loop early (executor.ts:987-1005 returns `blocked`), but the
    // plan still DECLARED a full drain, so drain-to-0 faithfully models the
    // plan's intent -- and a plan that empties the hold then references the same
    // item again is incoherent however far the runtime got.
    const need = s.until ? perIter : perIter * (s.repeat ?? 1);
    const have = hold.get(id) ?? 0;
    if (have >= need) { hold.set(id, s.until ? 0 : have - need); checked++; return; }
    if (minedUnknown) { hold.set(id, 0); return; } // a prior mine may have supplied it -> unprovable, never a fail (M-34)
    const verb = s.action === "jettison" ? "jettisons" : s.action === "create_sell_order" ? "lists" : "sells";
    const amount = s.until ? `at least ${need}` : `${need}`;
    bad.push(`${stepLabel(i, s)}: ${verb} ${amount} ${id} but the hold holds ${have} and no mine/buy precedes it`);
    hold.set(id, 0);
    checked++;
  });

  if (bad.length) return fail("cargo_coherence", bad.join("; "));
  if (!checked) return abstain("cargo_coherence", "every removal trails a mine -- hold contents unprovable");
  return pass("cargo_coherence", `${checked} removal(s) coherent with the simulated hold`);
};

export const SCORERS: Scorer[] = [
  knownAction,
  requiredParams,
  knownSystemRef,
  knownPoiRef,
  knownItemId,
  dockRequiresStation,
  mineNeedsMatchingModule,
  noMineIntoFullHold,
  cargoCoherence,
];

export function scorePlan(plan: CandidatePlan, c: EvalCase): ScoreResult[] {
  return SCORERS.map((s) => s(plan, c));
}

// --- sequence-level quality signal ------------------------------------------
//
// CLASS: replan-instead-of-adapt thrash. SM-9's most expensive failure was
// invisible to every per-plan check: three consecutive blocked wakes, three
// IDENTICAL goals, the whole hourly plan budget burned in six minutes -- while
// the experiment's progress-counter revert latch stayed green because ore had
// been mined. A planner that answers a block by re-issuing the same goal is not
// planning; a quality signal has to look ACROSS plans.
//
// Receipt for the threshold (simplicity rule 3): 3, matching the harness's own
// BLOCKED_THRASH_THRESHOLD (src/agent/agent.ts:151) and SM-9's observed run of
// exactly 3. Two identical goals in a row can be legitimate (a transient block,
// re-attempted); three is the signature. The two checks are complementary, not
// duplicate: the damper keys on the GAME's block detail, this keys on the
// PLANNER's goal -- a model can vary its block reason and still be stuck.
export const THRASH_WINDOW = 3;

/** Lowercase, collapse everything that isn't a letter or digit. "Mine Titanium at Bunda Belt!" -> "mine titanium at bunda belt". */
export function normalizeGoal(goal: string): string {
  return goal.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Scores plan DIVERSITY over the blocked-wake cases, in fixture order. Only
 * blocked wakes count: repeating a goal after a plan COMPLETES is continuing a
 * strategy, not thrashing -- it is a block that makes a repeat a failure to adapt.
 */
export function scoreGoalDiversity(entries: Array<{ wakeReason: string; goal: string }>): ScoreResult {
  const blocked = entries.filter((e) => e.wakeReason === "blocked");
  if (blocked.length < THRASH_WINDOW) {
    return abstain("goal_diversity", `needs ${THRASH_WINDOW} blocked-wake cases, saw ${blocked.length}`);
  }
  let run = 1;
  for (let i = 1; i < blocked.length; i++) {
    run = normalizeGoal(blocked[i]!.goal) === normalizeGoal(blocked[i - 1]!.goal) ? run + 1 : 1;
    if (run >= THRASH_WINDOW) {
      return fail("goal_diversity", `${run} consecutive blocked wakes with the same goal: "${blocked[i]!.goal}"`);
    }
  }
  return pass("goal_diversity", `${blocked.length} blocked-wake goals, no run of ${THRASH_WINDOW} identical`);
}
