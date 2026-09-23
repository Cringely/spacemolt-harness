import type { StatusSnapshot } from "../client/client";

export interface ReflexConfig {
  // Issue #670 (percent-of-tank inverted the real emergency: 19/130 = 14.6%
  // read as critical while being 19 JUMPS of range on a 1-fuel/jump hull).
  // keepFuelAboveJumps is the producer fix -- range measured in jumps, the
  // thing that actually determines whether the pilot can reach a station, not
  // tank capacity. keepFuelAbovePct stays: percent is still the correct signal
  // until this ship's own per-jump cost has ever been observed (see
  // evaluateReflex below), so it is not a second knob for the same job but the
  // bootstrap this ship falls back to before any measurement exists.
  keepFuelAbovePct?: number;
  keepFuelAboveJumps?: number;
  repairBelowHullPct?: number;
}

export interface ReflexFire {
  action: "refuel" | "repair";
  reason: "low_fuel" | "low_hull";
}

/**
 * Zero-token, executor-level rule evaluated every loop iteration before wake
 * conditions. Fires only while docked, because refuel/repair are docked-only
 * game actions -- a threshold breach while undocked is left for the
 * low_fuel/low_hull wake conditions to hand to the planner. Fuel is checked
 * before hull (first match wins), matching evaluateWake's "first reason
 * wins" convention. Enumerated inputs: status.fuel, status.maxFuel,
 * status.hull, status.maxHull, status.docked, config.keepFuelAbovePct,
 * config.keepFuelAboveJumps, fuelPerJump, planRemediesFuel, planRemediesHull,
 * fuelGaveUpHere, hullGaveUpHere -- thirteen total, all read fresh each
 * runOnce() call; nothing here is cached.
 *
 * Issue #670 (live 2026-08-01): the miner sat at market_prime for 28.5h,
 * fuel 19/130 (14.6%), while `find_route` to every neighbour showed
 * `fuel_per_jump: 1` -- 19 jumps of real range, not an emergency. Percent of
 * tank cannot tell "19 fuel on a 1-fuel/jump hull" (abundant) from "19 fuel on
 * a 15-fuel/jump hull" (one jump from stranded); both read as the same
 * percentage of ANY tank size. `fuelPerJump` is this ship's own measured
 * fuel-per-jump (agent.ts's `lastMeasuredFuelPerJump`, derived from the
 * `find_route` response travelToTick already fetches for every travel_to hop
 * -- zero new game calls). When it is known, jumpsRemaining = floor(fuel /
 * fuelPerJump) is the real signal and REPLACES the percent check entirely for
 * this evaluation (a jump count is strictly more informative than a
 * percentage once it exists, so percent no longer gets a vote). When it is
 * NOT yet known (this ship has never completed a jump this session --
 * possible right after boot or a switch_ship), the check falls back to
 * config.keepFuelAbovePct, UNCHANGED from before this fix -- not a permanent
 * revert to the old bug, because it governs only the narrow window before the
 * ship's first measured jump and is superseded the moment one lands. The
 * alternative rejected: firing on neither signal when unmeasured, which would
 * silently disarm the reflex for a ship that only ever moves via intra-system
 * `travel` (never registers a jump) -- the #526 lesson ("a fallback that never
 * warns recreates the strand") applies here too, so an unmeasured ship keeps
 * exactly today's protection rather than losing it.
 *
 * Issue #543 (livelock): a docked, out-of-station-reserve refuel
 * (`station_fuel_empty`) cannot succeed no matter how many times this fires
 * -- the station's tank is empty, not the pilot's wallet. A pending plan
 * already carrying an unexecuted refuel step (planRemediesFuel, the same
 * signal evaluateWake's Layer-1 fix uses) is the ONLY thing that can supply
 * the fuel cells a real fix needs, e.g. a "buy fuel_cell" step ahead of it.
 * Without this guard, the reflex re-fires every tick, fails every tick
 * (reason unchanged, nothing it can do about that), and each failure still
 * spends the tick (agent.ts's reflexSpentTick), so the plan's own buy step
 * never gets a turn -- a livelock the reflex causes but cannot resolve.
 * Deferring here (not just at the wake) is the producer-side fix: the wake
 * was already correctly suppressed, but the reflex sat upstream of it,
 * unconditionally re-attempting the same doomed action.
 *
 * Issue #672 (the #543 livelock in a new costume): planRemediesFuel
 * originally recognized only a plan that already carries an unexecuted
 * refuel step. A plan that instead TRAVELS toward fuel (no refuel step yet
 * -- the destination hasn't been reached) was invisible to it, so the
 * reflex kept retrying a terminal `station_fuel_empty` every tick while a
 * correct travel-then-refuel plan sat frozen at step 0.
 * fuelGaveUpHere/hullGaveUpHere are agent.ts's per-station backstop for a
 * DIFFERENT slice of that gap (see reflexGaveUpAt below): once a reflex
 * attempt has failed with a TERMINAL reason at the CURRENT (docked) station,
 * withhold further attempts there -- retrying a call the game has already
 * told us cannot succeed here spends the tick for nothing and blocks
 * whatever the plan itself could do instead. planRemediesFuel itself
 * (agent.ts) now also recognizes a plan traveling toward a DIFFERENT,
 * destination-proven-to-have-fuel system, so the two mechanisms cover
 * complementary ground: the give-up here protects the station the pilot is
 * AT, the destination check there protects a station it is headed TO.
 */
// Issue #526: the same jumps-vs-percent urgency check evaluateReflex uses
// below (issue #670) also has to drive an UNDOCKED consumer -- the mine-step
// fuel-floor guard in executor.ts -- so it is extracted rather than
// duplicated. One urgency computation feeding both the docked auto-refuel
// reflex and the undocked mine guard means the two can never quietly drift
// to different verdicts on the same ship state.
export function fuelUrgent(
  fuel: number, maxFuel: number, fuelPerJump: number | undefined,
  keepAboveJumps: number | undefined, keepAbovePct: number | undefined,
): boolean {
  return keepAboveJumps != null && fuelPerJump != null && fuelPerJump > 0
    ? Math.floor(fuel / fuelPerJump) < keepAboveJumps
    : keepAbovePct != null && maxFuel > 0 && (fuel / maxFuel) * 100 < keepAbovePct;
}

export function evaluateReflex(
  status: StatusSnapshot | null, config: ReflexConfig, fuelPerJump?: number,
  planRemediesFuel?: boolean, planRemediesHull?: boolean,
  fuelGaveUpHere?: boolean, hullGaveUpHere?: boolean,
): ReflexFire | null {
  if (!status || !status.docked) return null;
  const { fuel, maxFuel, hull, maxHull } = status;
  if (fuelUrgent(fuel, maxFuel, fuelPerJump, config.keepFuelAboveJumps, config.keepFuelAbovePct)
    && !planRemediesFuel && !fuelGaveUpHere) {
    return { action: "refuel", reason: "low_fuel" };
  }
  if (
    config.repairBelowHullPct != null && maxHull > 0 &&
    (hull / maxHull) * 100 < config.repairBelowHullPct && !planRemediesHull && !hullGaveUpHere
  ) {
    return { action: "repair", reason: "low_hull" };
  }
  return null;
}

/** The subset of a persisted `reflex_failed` event payload the give-up below
 * reads. All fields optional: persisted events outlive the schema that wrote
 * them (AGENTS.md persisted-state tolerance) -- an event from before this
 * fix carries neither `stationKey` nor `terminal` and is silently ignored,
 * never a crash. */
export interface ReflexFailureRecord {
  action?: string;
  stationKey?: string | null;
  terminal?: boolean;
  // Issue #1115: the failure's classified cause (see classifyReflexFailureCause
  // below) and the credits balance this ship held AT the failed attempt.
  // Both optional and both required together for reflexGaveUpAt's
  // invalidation below to apply -- a pre-#1115 row carries neither, and reads
  // exactly like a non-affordability failure (the #672 dry-station give-up,
  // unchanged): persisted-state tolerance (AGENTS.md), no migration needed.
  cause?: string;
  creditsAtFailure?: number;
}

// Issue #1115: the one failure class reflexGaveUpAt below treats as
// invalidated by a later, observable state change. A dry station (#672's
// station_fuel_empty) has no such signal reachable from a StatusSnapshot --
// the station's tank refilling isn't something this ship can see without a
// live query -- so it keeps latching permanently, unchanged from #672. An
// affordability refusal is different: the ship's own credits balance IS the
// signal, already read every tick for the fingerprint (stall-monitor.ts's
// progressFingerprint) and the reflex's own urgency check.
export const AFFORDABILITY_CAUSE = "insufficient_credits";

// Classifies a reflex failure's cause from the game's own error text -- the
// same substring-match convention classifyGameError already uses for
// transient-vs-terminal (executor.ts's TRANSIENT_BLOCK_MARKERS): no stable
// error CODE separates an affordability refusal from a dry-station one at
// this seam, only the message text does (see classifyGameError's comment).
// Case-insensitive: the live capture that named this bug (#1115) carried
// "insufficient credits" verbatim, but the game's casing is not a contract.
export function classifyReflexFailureCause(message: string): string | undefined {
  return message.toLowerCase().includes("insufficient credits") ? AFFORDABILITY_CAUSE : undefined;
}

/**
 * True once a TERMINAL reflex failure has been recorded for this exact
 * (stationKey, action) pair, read from the persisted `reflex_failed` event
 * stream rather than an in-memory counter -- PR #32's lesson (stall-monitor.ts's
 * dockNoStationStreak doc comment): a first-cut in-memory streak reset on any
 * interleaving outcome and was measured completely inert over 5000 ticks. A
 * single terminal failure is sufficient here, so there is no threshold to
 * tune: `terminal` already means classifyGameError (executor.ts) classified
 * the error as `blocked`, i.e. retrying will not change the outcome (the
 * station's tank does not refill on a 10-second cadence). Self-clearing by
 * construction, with no reset code needed -- a fresh stationKey (redocked
 * elsewhere) is a different key entirely, and a vital that recovers above its
 * threshold by other means simply stops evaluateReflex's own condition from
 * firing regardless of this latch.
 *
 * Issue #1115. The latch above is otherwise permanent: a terminal record
 * keeps matching forever, even once the condition that earned it has
 * provably changed. `currentCredits` is this tick's known balance (pass
 * `undefined` when unknown, e.g. a failed status fetch), and a matching
 * record is skipped -- NOT counted as a give-up -- when it was classified as
 * an affordability refusal AND credits have since risen past what failed.
 * Both the cause and the recorded balance must be present on the row, and
 * `currentCredits` must be known: any one missing (a legacy row predating
 * this fix, a #672 dry-station cause, or an unknown current balance) falls
 * through to the unconditional give-up below, same "never invalidate a
 * block on a guess" rule the #94 fitment guards use for missing data. A
 * retry that still can't afford it writes a FRESH terminal row at the new,
 * higher balance, so the latch self-corrects without ever needing the exact
 * refused price.
 */
export function reflexGaveUpAt(
  records: ReadonlyArray<ReflexFailureRecord | null | undefined>,
  stationKey: string, action: "refuel" | "repair",
  currentCredits?: number,
): boolean {
  return records.some((r) => {
    if (!r || r.terminal !== true || r.action !== action || r.stationKey !== stationKey) return false;
    if (r.cause === AFFORDABILITY_CAUSE && r.creditsAtFailure !== undefined && currentCredits !== undefined) {
      return currentCredits <= r.creditsAtFailure; // still gives up unless credits genuinely rose
    }
    return true;
  });
}
