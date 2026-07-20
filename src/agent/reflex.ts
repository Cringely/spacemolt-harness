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
 * config.repairBelowHullPct -- seven total, all read fresh from the status
 * agent.ts fetches every runOnce() call; nothing here is cached.
 */
export function evaluateReflex(status: StatusSnapshot | null, config: ReflexConfig): ReflexFire | null {
  if (!status || !status.docked) return null;
  const { fuel, maxFuel, hull, maxHull } = status;
  if (config.keepFuelAbovePct != null && maxFuel > 0 && (fuel / maxFuel) * 100 < config.keepFuelAbovePct) {
    return { action: "refuel", reason: "low_fuel" };
  }
  if (config.repairBelowHullPct != null && maxHull > 0 && (hull / maxHull) * 100 < config.repairBelowHullPct) {
    return { action: "repair", reason: "low_hull" };
  }
  return null;
}
