// Multi-dimensional no-progress detector -- the substrate (stall-watcher v4).
//
// Operator reframe (docs/superpowers/specs/2026-07-12-pilot-stall-watcher.md):
// the failure is NOT "not earning credits." A pilot training skills, running
// missions, or exploring earns zero credits yet is progressing. So "stuck" =
// no advance in ANY real dimension over a long window. The load-bearing part is
// what counts as a dimension.
//
// The signature is a single MONOTONIC scalar: the sum of every progress
// dimension. Because each dimension is a lifetime counter that only ever rises,
// the sum rises iff at least one dimension advanced, and is unchanged iff EVERY
// dimension is flat. So "scalar unchanged over the window" is exactly "no
// dimension advanced" -- no per-dimension bookkeeping, no equality sprawl.
//
// The one thing this must NOT do is count movement as progress. jumps_completed
// / distance_traveled / systems_explored rise on mere movement, so folding them
// in would let a forever-hopping pilot read as "progressing" -- the wandering
// blind spot the whole detector exists to close. They are EXCLUDED, and that
// exclusion is load-bearing (see the allowlist below and the wander-forever
// regression test).

// The PROGRESS counters (allowlist). Each rises only on a productive OUTCOME --
// earning, extracting, completing a mission/trade, crafting/producing,
// destroying a target, salvaging. A parked or wandering pilot moves none of
// them. Sourced from get_status.player.stats (VERIFIED against the live probe
// fixture test/fixtures/spacemolt-probe-2026-07-12.json).
//
// An ALLOWLIST, not "everything except movement" -- deliberately. The stats
// block also carries time_played, which increments every tick regardless of
// what the pilot does; a denylist that forgot it would make the scalar rise
// forever and the detector NEVER fire -- the dangerous direction, silence on a
// real stall. The allowlist's only failure mode is the reverse and far safer:
// forget to add a productive counter and its advance goes unseen, so the
// detector may flag a genuinely-progressing pilot -- a false alarm (a re-steer
// or alert), never silence. New productive counters can be added here freely;
// passive/movement/clock counters must never be. (A non-monotonic value
// slipping in is also caught downstream: runSteward re-seeds on ANY change to
// the scalar, including a drop, so it can only ever flag less, not falsely.)
export const PROGRESS_COUNTERS = [
  "credits_earned",
  "ore_mined",
  "missions_completed",
  "trades_completed",
  "exchange_items_sold",
  "items_crafted",
  "facilities_built",
  "facility_items_produced",
  "wrecks_sold",
  "wrecks_scrapped",
  "wreck_items_looted",
  "npcs_destroyed",
  "pirates_destroyed",
  "ships_destroyed",
  "bases_destroyed",
  "scans_performed",
  "deep_core_pois_discovered",
  "contraband_sold",
] as const;

// EXCLUDED, load-bearing. jumps_completed/distance_traveled/systems_explored
// rise on movement alone (re-opening the wandering blind spot); time_played
// rises every tick. None of these is progress. Documented here so a future
// edit that "helpfully" adds one to the allowlist has to confront why it's out.
export const EXCLUDED_MOVEMENT_COUNTERS = [
  "jumps_completed",
  "distance_traveled",
  "systems_explored",
  "prayer_distance_traveled",
  "time_played",
] as const;

/**
 * Sum of the allowlisted progress counters. Returns null when the stats block is
 * absent (dimension UNKNOWN -> the caller must SUPPRESS, per the fail-safe).
 * Absent individual keys count as 0 (that counter simply isn't moving), which
 * keeps the scalar well-defined without treating a missing block as flat.
 */
export function progressCountersTotal(stats: Record<string, number> | undefined): number | null {
  if (!stats) return null;
  let total = 0;
  for (const k of PROGRESS_COUNTERS) {
    const v = stats[k];
    if (typeof v === "number") total += v;
  }
  return total;
}

/**
 * The allowlisted progress counters as a plain object, for the status_snapshot
 * event payload the dashboard charts. undefined when the stats block is absent
 * (nothing to record) -- which keeps the snapshot payload byte-identical to the
 * pre-v4 shape for callers with no stats, so existing consumers are unaffected.
 * Absent individual keys are omitted rather than zero-filled.
 */
export function progressCounters(
  stats: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!stats) return undefined;
  const out: Record<string, number> = {};
  for (const k of PROGRESS_COUNTERS) {
    const v = stats[k];
    if (typeof v === "number") out[k] = v;
  }
  return out;
}

/**
 * Monotonic scalar over per-skill progress: sum(level). Returns null when skills
 * are UNKNOWN (the query failed / was never sampled) so the caller suppresses.
 *
 * LEVEL only, NOT xp -- load-bearing (#250). Skill XP is not a productive-outcome
 * signal: every skill "trains passively by doing the thing it governs," and some
 * accrue XP with no action at all (docs/game-reference/upstream/docs/skills.md:100
 * -- Corporation Management XP "accrues passively over time per facility owned").
 * Folding raw XP into the grand-total scalar let a steady sub-level trickle in
 * any one of 28 skills lift the sum every window, re-seed the baseline, and mask
 * a real stall forever: on 2026-07-14 a pilot sat docked with empty cargo and an
 * active mining mission for ~a day and the detector never escalated. A skill
 * LEVEL-UP is a real threshold crossing -- a productive outcome, and one the
 * spec's "training skills IS progress" reframe actually meant -- and it is rare
 * enough that a passive level-up inside a 30-60min window is negligible, whereas
 * passive XP drip is continuous. Levels never regress (skill progress survives
 * death), so sum(level) is monotonic with no xp-reset guard needed.
 */
export function skillsSignature(
  skills: Record<string, { level: number; xp: number }> | null | undefined,
): number | null {
  if (!skills) return null;
  let levels = 0;
  for (const s of Object.values(skills)) {
    if (typeof s.level === "number") levels += s.level;
  }
  return levels;
}
