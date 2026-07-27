// Stall-monitor decision substrate (stall-watcher v4).
//
// The PURE half of the stall-watcher: the fingerprint, the combined progress
// scalar, the fuel-reserve / strand predicates, and the long-window no-progress
// time judge. Sibling to no-progress-detector.ts (which owns the progress
// counters this layer sums). Everything here is a pure function with explicit
// inputs -- an injected clock (`now`), thresholds, and current state passed in --
// so each decision is unit-testable in isolation (test/stall-monitor.test.ts)
// with no hidden Agent-state reads.
//
// The stateful ORCHESTRATION built on these -- emitting operator_alerts, arming
// planner backoff, firing distress_signal / self_destruct, and re-steering the
// planner -- stays in agent.ts (runOnce/runSteward), where the counters live and
// the side effects belong. This module decides; agent.ts acts.

import type { StatusSnapshot } from "../client/client";
import { progressCountersTotal } from "./no-progress-detector";
import { failureClass } from "../server/failures";

// Layer 4 (no-progress detector). Consecutive replan boundaries carrying an
// IDENTICAL game-state fingerprint before the detector arms backoff and flags
// the agent stuck. 6 at a 10s tick is ~60s of provably zero game progress --
// long enough that a slow-but-advancing loop (e.g. a multi-hop transit that
// replans between jumps, where systemId/fuel move each time) never trips it,
// short enough to catch the low_fuel-livelock class in about a minute rather
// than the ~3 hours the live incident ran.
export const NO_PROGRESS_REPLANS = 6;

// NOTE: the tunable defaults the stall path also uses -- the undocked fuel
// reserve (fuelReservePct) and the long stuck window (stuckWindowMinutes) --
// are NOT defined here. They live in config.ts's AGENT_DEFAULTS, the single
// source shared with the Zod loader; agent.ts passes them into fuelBelowReserve
// and noProgressJudge as explicit inputs. Only the stall-INTERNAL constants
// below (never surfaced as agent tuning knobs) live in this module.

// Consecutive fuel-blocked movement attempts before a strand is CONFIRMED. 3
// mirrors the thrash-damper threshold: enough to rule out a one-off blip, few
// enough to catch the strand before the pilot burns the afternoon dead in space
// (the 2026-07-12 incident ran ~3h). The steward sits ahead of the thrash gate,
// so at this threshold the strand path pre-empts the generic damper.
export const STRAND_FUEL_BLOCK_THRESHOLD = 3;
// self_destruct (when opted in) waits this many stuck-windows of confirmed
// strand past rung 1 -- a longer fuse than the re-steer, since it's the
// destructive last resort.
export const STRAND_SELF_DESTRUCT_WINDOW_MULT = 2;

// Dock dead-end (issue #551): the pilot keeps retrying `dock` at a POI with no
// station -- 68 occurrences in the single worst 72h window on record, more
// than double the next failure class, and the immediate cause of an 8h,
// zero-delta stall that ended in an operator-authorized self_destruct. The
// signal is deliberately NOT isStranded's fuelBlockedMoves: that counter only
// increments on a REFUSED MOVE, and a pilot retrying `dock` in place never
// attempts one -- fuelBlockedMoves stayed 0 for the entire incident
// (operator_alert class=stranded: 0 for all time, confirmed live). A COMPLIANT
// pilot generates this streak just by doing what it was told, with no refused
// move anywhere in it.
// 3 matches STRAND_FUEL_BLOCK_THRESHOLD/BLOCKED_THRASH_THRESHOLD's own
// convention -- enough to rule out a one-off blip, few enough to act before
// the hunt burns the fuel tank.
export const DOCK_NO_STATION_STREAK_THRESHOLD = 3;

// The classifier token for the refusal itself. The SAME classifier the failure
// taxonomy uses (failureClass, src/server/failures.ts) resolves the game's
// verbatim "No station at this location" (live capture, test/fixtures/
// market-capture-2026-07-13.json, 108 occurrences; no code prefix, no
// PROSE_RULES match, so it falls to the tier-3 normalized-prose class) to this
// exact token -- test/stall-watcher.test.ts's dock-dead-end suite drives that
// literal string through the real pipeline and pins the resulting
// classification, so a failures.ts wording change that desyncs the two goes red
// there. Lives here rather than in agent.ts because it is a stall-INTERNAL
// constant, like the thresholds above.
export const DOCK_NO_STATION_CLASS = "no station at this location";

/** The fields of a persisted `action` event payload this counter reads. */
export interface ActionOutcomeRecord {
  action?: string;
  outcome?: string;
  result?: string;
}

/**
 * How many `dock` -> blocked -> "no station here" refusals stand since the last
 * dock that WORKED, over the persisted action stream in chronological order.
 *
 * INTERLEAVE-TOLERANT, and that is the whole point (PR #32 review). The first
 * cut of this guard was an in-memory counter incremented in executeOne and
 * reset by ANY other outcome. A blocked step ends the plan, so the next executed
 * step is always step 0 of the next plan -- meaning any leading step zeroed the
 * counter every cycle and the streak only ever advanced when `dock` was step 0
 * of three consecutive replans. The shape the system itself asks for defeated
 * it: the station digest (stations.ts) instructs the planner to emit
 * `travel_to{system_id}`, so the production plan is `[travel_to X, dock]`, whose
 * leading no-op travel short-circuits to a `continue` and reset the count on
 * every pass. Measured on the fake API: 5000 ticks, 107 refusals, ZERO
 * reroutes.
 *
 * So this counts the way issue #95's same-error repeat-breaker counts (see
 * agent.ts's repeat-block gate): read the durable event stream and IGNORE other
 * keys' events entirely rather than treating them as a reset. The repo has now
 * learned this three times -- SM-4 abandoned cursor-consecutiveness for exactly
 * this reason (agent.ts executeOne), #95 built the repeat-breaker
 * interleave-tolerant on purpose, and stations.ts names the defeating shape.
 *
 * Only a dock that SUCCEEDED resets: it is positive proof a station is reachable
 * here, which is the one observation that falsifies "this system has no
 * station." A `wait` (transient hold) neither counts nor resets, matching #95. A
 * dock blocked for some OTHER reason does neither: it is not a no-station
 * refusal, and it is not proof of a station either.
 */
export function dockNoStationStreak(
  payloads: ReadonlyArray<ActionOutcomeRecord | null | undefined>,
): number {
  let count = 0;
  for (const p of payloads) {
    if (!p || p.action !== "dock") continue; // other actions are INVISIBLE, never a reset
    if (p.outcome === "blocked") {
      if (failureClass(p.result) === DOCK_NO_STATION_CLASS) count++;
    } else if (p.outcome === "continue" || p.outcome === "plan_done") {
      count = 0;
    }
  }
  return count;
}

/**
 * True once `streak` dock refusals for "no station at this location" stand
 * unresolved. Pure so the threshold boundary is testable without an Agent --
 * see agent.ts's maybeForceDockReroute for the producer-side action this
 * predicate gates.
 */
export function isDockDeadEnd(input: { streak: number; threshold: number }): boolean {
  return input.streak >= input.threshold;
}

// Layer 4 fingerprint: the salient GAME state plus plan position at a replan
// boundary. Inputs ENUMERATED (simplicity rule 5) -- every field whose change
// means real progress: from StatusSnapshot, fuel/credits/hull (vitals move as
// the ship acts), systemId/docked/inTransit/dockedAt (location changes), and
// cargoUsed (mining/selling moves it); plus cursor.step so advancing to a new
// step within a plan reads as progress. Fetched fresh each tick (client.ts),
// so nothing here can go stale.
//
// DELIBERATELY EXCLUDES the planner-emitted plan goal text. Receipt: this
// detector's whole job is the freeze the string-keyed thrash damper misses --
// a livelock that keeps replanning with slightly-reworded goals (the damper
// keys on the string, so a varying key never builds a streak and never arms).
// Folding goal text into the fingerprint would reintroduce exactly that
// string-equality fragility here: rephrased goals would make the fingerprint
// differ every boundary and the freeze would evade detection. A genuinely
// progressing agent moves credits/cargo/fuel/system/cursor.step regardless of
// how its goal is worded, so game state + cursor.step is the honest signal.
//
// DELIBERATELY EXCLUDES cursor.iteration. Receipt: a phantom-repeat freeze --
// a `repeat`/`until` step whose iteration advances every tick while the game
// state stays frozen (the SM-9 shape) -- must still be caught. Folding
// iteration into the fingerprint would make it change on every such replan and
// evade detection; cursor.step alone separates "advanced to a new step" from
// "frozen on one," which is exactly the distinction this detector needs.
export function progressFingerprint(status: StatusSnapshot, cursorStep: number): string {
  return JSON.stringify([
    status.fuel, status.credits, status.hull,
    status.systemId ?? null, status.docked, status.inTransit, status.dockedAt ?? null,
    status.cargoUsed,
    cursorStep,
  ]);
}

// The combined monotonic progress scalar, or null when ANY dimension is
// UNKNOWN (stats absent, or skills/achievements never sampled / query failed).
// null is the fail-safe signal: the caller must SUPPRESS, never treat an
// unknown dimension as flat. Explicit inputs (no cached-field reads): the
// agent supplies its sampled slow-dimension values.
export function progressGrandTotal(
  stats: Record<string, number> | undefined,
  skillsSig: number | null,
  achievementsEarned: number | null,
): number | null {
  const counters = progressCountersTotal(stats);
  if (counters === null) return null;
  if (skillsSig === null || achievementsEarned === null) return null;
  return counters + skillsSig + achievementsEarned;
}

// True when fuel sits below the given reserve percentage of capacity. maxFuel
// of 0 (unknown/uninitialised) reads as NOT below reserve, so an unknown tank
// never fabricates a low-fuel signal.
export function fuelBelowReserve(status: StatusSnapshot, reservePct: number): boolean {
  return status.maxFuel > 0 && (status.fuel / status.maxFuel) * 100 < reservePct;
}

// The behavioral strand predicate: undocked, below the fuel reserve, having hit
// the fuel-blocked-movement threshold, with no refuelling base at the current
// POI. All four must hold -- a base here means the docked reflex can refuel (not
// a strand), and the fuel-block streak is what separates "low but moving" from
// "cannot move." Pure over the caller's already-computed inputs.
export function isStranded(input: {
  docked: boolean;
  fuelBelowReserve: boolean;
  fuelBlockedMoves: number;
  currentPoiHasBase: boolean;
  fuelBlockThreshold: number;
}): boolean {
  return (
    !input.docked &&
    input.fuelBelowReserve &&
    input.fuelBlockedMoves >= input.fuelBlockThreshold &&
    !input.currentPoiHasBase
  );
}

// Long-window no-progress judge. Steps the (total, at) baseline forward given a
// fresh scalar sample and returns whether the pilot has been EXACTLY flat for at
// least windowMs. Only an exactly-unchanged scalar counts as no-progress: the
// sum is unchanged iff every dimension is flat, so "exactly flat for >= windowMs"
// is exactly "no dimension advanced for a window." Any CHANGE -- an advance, or
// an anomalous drop from a malformed sample (the scalar should be monotonic, so
// a decrease is a data glitch, not real regress) -- re-seeds the baseline and
// clock. Treating a drop as a reset rather than as "flat" keeps the detector
// fail-safe even if a non-monotonic value ever slips into the sum: it can only
// ever flag LESS often, never falsely flag stuck.
//
// A null total is the fail-safe UNKNOWN: a dimension is unmeasurable, so we
// cannot rule out progress -- refresh the clock (never accumulate a stuck window
// across an unknown gap) and drop the baseline so the next known sample re-seeds
// cleanly. Returns the NEW (total, at) baseline the caller stores back.
export function noProgressJudge(input: {
  total: number | null;
  prevTotal: number | undefined;
  prevAt: number | undefined;
  now: number;
  windowMs: number;
}): { total: number | undefined; at: number | undefined; noProgress: boolean } {
  const { total, prevTotal, prevAt, now, windowMs } = input;
  if (total === null) {
    return { total: undefined, at: now, noProgress: false };
  }
  if (prevTotal === undefined || total !== prevTotal) {
    // First known sample, or ANY change (advance / anomalous drop): re-seed.
    return { total, at: now, noProgress: false };
  }
  // Exactly unchanged: stalled since prevAt. Baseline held.
  const noProgress = prevAt !== undefined && now - prevAt >= windowMs;
  return { total: prevTotal, at: prevAt, noProgress };
}
