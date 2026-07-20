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
