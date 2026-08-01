import type { StatusSnapshot } from "../client/client";

export interface ReflexConfig {
  keepFuelAbovePct?: number;
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
 * config.repairBelowHullPct, planRemediesFuel, planRemediesHull,
 * fuelGaveUpHere, hullGaveUpHere -- eleven total, all read fresh each
 * runOnce() call; nothing here is cached.
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
 * Issue #672 (the #543 livelock in a new costume): planRemediesFuel only
 * recognizes a plan that already carries an unexecuted refuel step. A plan
 * that instead TRAVELS toward fuel (no refuel step yet -- the destination
 * hasn't been reached) is invisible to it, so the reflex kept retrying a
 * terminal `station_fuel_empty` every tick while a correct
 * travel-then-refuel plan sat frozen at step 0. fuelGaveUpHere/hullGaveUpHere
 * are agent.ts's per-station backstop for exactly that gap (see
 * reflexGaveUpAt below): once a reflex attempt has failed with a TERMINAL
 * reason at the CURRENT station, withhold further attempts there -- retrying
 * a call the game has already told us cannot succeed here spends the tick
 * for nothing and blocks whatever the plan itself could do instead.
 */
export function evaluateReflex(
  status: StatusSnapshot | null, config: ReflexConfig,
  planRemediesFuel?: boolean, planRemediesHull?: boolean,
  fuelGaveUpHere?: boolean, hullGaveUpHere?: boolean,
): ReflexFire | null {
  if (!status || !status.docked) return null;
  const { fuel, maxFuel, hull, maxHull } = status;
  if (
    config.keepFuelAbovePct != null && maxFuel > 0 &&
    (fuel / maxFuel) * 100 < config.keepFuelAbovePct && !planRemediesFuel && !fuelGaveUpHere
  ) {
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
 */
export function reflexGaveUpAt(
  records: ReadonlyArray<ReflexFailureRecord | null | undefined>,
  stationKey: string, action: "refuel" | "repair",
): boolean {
  return records.some((r) => !!r && r.terminal === true && r.action === action && r.stationKey === stationKey);
}
