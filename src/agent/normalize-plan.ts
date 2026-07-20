import type { Plan, PlanStep } from "../registry/plan";
import type { Surroundings } from "../planner/types";

// SM-3 flight diagnosis (2026-07-10): an otherwise-perfect plan passed the
// display NAME as a location id -- `travel {id: "Commerce Fields"}` where the
// game requires `commerce_fields`. The digest shows both id and name; the
// model picked the label. This is the fix: name/id confusion eliminated
// deterministically at plan-admission time, not re-prompted away.
//
// Receipt (simplicity rule 3): only 3 action/param pairs carry a location
// reference the game resolves by id -- travel.id (POI), jump.id (system),
// travel_to.system_id (system, executor-only vocabulary per registry/plan.ts).
// A registry-level "this param is a location ref" flag was considered and
// rejected: it would need a new field threaded through ActionDef (actions.ts)
// and TravelToStepSchema (plan.ts, which isn't even a REGISTRY entry) for 3
// total call sites that don't change without a matching change to this file
// anyway -- a new location-bearing action needs executor wiring too, so this
// map growing in lockstep isn't a maintenance surprise.
//
// SM live diagnosis (2026-07-11, planner_error "unknown id 'traders_rest' --
// known ids: steadyburn, ..."): jump and travel_to are BOTH kind "system" but
// have different reachability semantics, so they cannot share the same
// admission rule. `jump` is a single hop -- its target MUST be in
// surroundings.connections (the immediate neighbours), so an unknown id is a
// genuine failure worth rejecting before we spend a game call. `travel_to` is
// the MULTI-HOP macro (executor.ts travelToTick, lines 92-130): it re-queries
// find_route from the CURRENT system every tick and follows nextHop
// (executor.ts nextHop, lines 40-47, route[1].system_id) -- find_route, NOT
// this normalizer, is the reachability authority for travel_to, and its whole
// point is destinations BEYOND the immediate neighbours. Validating a
// travel_to target against connections-only therefore rejects every legitimate
// far destination (exactly the SM failure: traders_rest is a proven market
// several jumps away, absent from the current system's connections). A bad
// travel_to id is not silently dropped either: find_route returns found:false,
// nextHop yields a null hop with the game's message, and travelToTick returns
// a clean `blocked` (executor.ts lines 113-116). So travel_to sets
// rejectUnknown:false -- an id absent from surroundings PASSES THROUGH to the
// executor untouched; only a case-normalization rewrite still applies when
// surroundings DOES know the system.
//
// SM live diagnosis (2026-07-11, SECOND occurrence, same target): the above
// fix covers a planner that correctly chose travel_to. This is the case where
// the planner instead chose the wrong verb -- `travel {id: "traders_rest"}`
// (kind poi, rejectUnknown:true) -- confusing the IN-SYSTEM POI hop with the
// inter-system macro. traders_rest isn't a POI in any system, so travel
// correctly hard-rejects (loosening travel's rejection would let genuinely
// bad POI ids through, which is not this bug). The retry then repeated the
// identical wrong verb: the digest gave the planner no way to tell `travel`,
// `jump`, and `travel_to` apart (digest.ts's ACTION_VOCAB renders bare
// `name(params)` signatures with no per-verb reachability semantics), and the
// rejection error carried only a known-ids list, no signal to switch verbs.
// Fix is two-part, both at the comprehension seam rather than loosening the
// guard: (1) digest.ts gets one instruction line naming which verb reaches
// POIs vs adjacent systems vs any system, so a planner that hasn't confused
// them yet won't; (2) this file's rejection error for a rejectUnknown miss
// now appends a verb-switch hint (kind poi -> suggests travel_to; kind system
// -> suggests travel_to over jump) so a planner that already confused them
// gets a chance to correct on retry instead of doubling down.
const LOCATION_PARAMS: Record<
  string,
  { param: string; kind: "poi" | "system"; rejectUnknown: boolean }
> = {
  travel: { param: "id", kind: "poi", rejectUnknown: true },
  jump: { param: "id", kind: "system", rejectUnknown: true },
  travel_to: { param: "system_id", kind: "system", rejectUnknown: false },
};

export interface PlanRewrite {
  step: number;
  action: string;
  param: string;
  from: string;
  to: string;
}

export type NormalizeResult =
  | { ok: true; plan: Plan; rewrites: PlanRewrite[] }
  // error is the full retry-ready message (unknown ref with known ids, or an
  // ambiguous ref naming every candidate) -- built here where the candidate
  // data lives, so the caller routes it into the retry verbatim.
  | { ok: false; error: string };

interface Referent {
  id: string;
  name?: string;
}

/**
 * Resolves every location-bearing param in `plan` against THIS call's
 * `surroundings`. Enumerated inputs: plan.steps and surroundings.pois /
 * .connections -- both arguments, no cached state; the caller (agent.ts's
 * replan()) is responsible for passing the same fresh surroundings it
 * gathered this replan, not a stale copy.
 *
 * - Exact id match (case-sensitive): passes through untouched.
 * - Exactly one case-insensitive match on a known id or a POI's display
 *   name: rewritten to the canonical id and recorded as a PlanRewrite.
 * - Ambiguous (two or more distinct ids match case-insensitively, e.g.
 *   candidates differing only by case): for a rejectUnknown param (jump,
 *   travel) treated as unresolvable -- a wrong guess here would silently send
 *   the ship to the wrong place, which is worse than one retry; the error
 *   names every candidate. For travel_to it passes through untouched (see
 *   below).
 * - No match at all: for a rejectUnknown param (jump, travel) reports the
 *   unknown id and the known ids for that param's referent kind, so the caller
 *   can retry the planner instead of silently discarding the plan. For
 *   travel_to (rejectUnknown:false) it passes through untouched -- travel_to
 *   is the multi-hop macro whose reachability authority is the executor's
 *   find_route, not this connections-only view (LOCATION_PARAMS receipt).
 */
export function normalizePlanLocations(plan: Plan, surroundings: Surroundings): NormalizeResult {
  const rewrites: PlanRewrite[] = [];
  const newSteps: PlanStep[] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const loc = LOCATION_PARAMS[step.action];
    if (!loc) {
      newSteps.push(step);
      continue;
    }

    const params = step.params as Record<string, unknown>;
    const raw = params[loc.param];
    if (typeof raw !== "string") {
      newSteps.push(step);
      continue;
    }

    const candidates: Referent[] = loc.kind === "poi"
      ? surroundings.pois.map((p) => ({ id: p.id, name: p.name }))
      : surroundings.connections.map((id) => ({ id }));

    if (candidates.some((c) => c.id === raw)) {
      newSteps.push(step);
      continue;
    }

    const lower = raw.toLowerCase();
    const matchIds = [...new Set(
      candidates
        .filter((c) => c.id.toLowerCase() === lower || c.name?.toLowerCase() === lower)
        .map((c) => c.id),
    )];

    // rejectUnknown:false (travel_to) never hard-rejects: an id surroundings
    // can't resolve -- whether unknown or case-ambiguous -- passes through
    // untouched to the executor, where find_route is the reachability authority
    // (see LOCATION_PARAMS receipt above). rejectUnknown:true (jump, travel)
    // rejects so the caller can retry the planner with the known ids.
    if (matchIds.length === 0) {
      if (!loc.rejectUnknown) {
        newSteps.push(step);
        continue;
      }
      const knownIds = [...new Set(candidates.map((c) => c.id))];
      // SM live diagnosis (2026-07-11, second occurrence): the planner sent
      // `travel {id: "traders_rest"}` -- traders_rest is a real, several-hops
      // -away market, just not a POI in THIS system, so it hard-rejected and
      // the RETRY repeated the identical wrong verb instead of switching. The
      // retry error is the only channel back to the planner here (no game
      // call spent yet), so it now carries a verb-switch hint instead of just
      // the known-ids list the planner already failed to act on once.
      const verbHint = loc.kind === "poi"
        ? `'${raw}' is not a POI in this system -- to reach another system, use travel_to with a system_id.`
        : `'${raw}' is not an adjacent system -- if it is several jumps away, use travel_to with a system_id instead of jump.`;
      return {
        ok: false,
        error: `unknown id '${raw}' -- known ids: ${knownIds.length ? knownIds.join(", ") : "none"}. ${verbHint}`,
      };
    }
    if (matchIds.length > 1) {
      if (!loc.rejectUnknown) {
        newSteps.push(step);
        continue;
      }
      return {
        ok: false,
        error: `ambiguous reference '${raw}' matches multiple ids: ${matchIds.join(", ")} -- give the exact id`,
      };
    }

    const resolvedId = matchIds[0]!;
    rewrites.push({ step: i, action: step.action, param: loc.param, from: raw, to: resolvedId });
    newSteps.push({ ...step, params: { ...params, [loc.param]: resolvedId } } as PlanStep);
  }

  return { ok: true, plan: { ...plan, steps: newSteps }, rewrites };
}
