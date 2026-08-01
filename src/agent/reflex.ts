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
 * config.repairBelowHullPct, planRemediesFuel, planRemediesHull -- nine
 * total, all read fresh each runOnce() call; nothing here is cached.
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
 */
export function evaluateReflex(
  status: StatusSnapshot | null, config: ReflexConfig,
  planRemediesFuel?: boolean, planRemediesHull?: boolean,
): ReflexFire | null {
  if (!status || !status.docked) return null;
  const { fuel, maxFuel, hull, maxHull } = status;
  if (
    config.keepFuelAbovePct != null && maxFuel > 0 &&
    (fuel / maxFuel) * 100 < config.keepFuelAbovePct && !planRemediesFuel
  ) {
    return { action: "refuel", reason: "low_fuel" };
  }
  if (
    config.repairBelowHullPct != null && maxHull > 0 &&
    (hull / maxHull) * 100 < config.repairBelowHullPct && !planRemediesHull
  ) {
    return { action: "repair", reason: "low_hull" };
  }
  return null;
}
