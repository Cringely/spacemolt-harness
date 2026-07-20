// Durable scheduler (#114) Stage 3: the dispatch circuit breaker (spec
// §Sequencing stage 3; verdict (b) conditions 4-5; defect D4). The tripwire
// that makes turning capability (b) — headless charter-armed fix dispatch — ON
// defensible: it bounds unattended spend with windowed caps, latches OPEN on
// the runaway signal (a full day's dispatch budget spent while nobody watched)
// or on a dispatch failure streak, and NEVER auto-resets — closing it is an
// explicit operator action (`scripts/scheduler.ts reset-breaker`), the L-3
// terminal back-off ("a loop that can call itself forever will").
//
// Per-job by design (spec §State, "per-job breaker state"): a failing dispatch
// class from one ceremony must not latch every other job's dispatch shut. Same
// shape and same schema tolerance as anchors.json (state.ts) — a corrupt or
// predating breaker.json degrades per-field, never a throw. The one asymmetry:
// a corrupt `status` field fails toward OPEN, not closed (see StateSchema),
// because un-latching a tripped breaker is the never-auto-reset invariant's one
// forbidden move.
//
// The caps are CONFIG, not hardcoded (breaker-config.json): the operator tunes
// the spend ceiling without a code change. Each default carries its receipt.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DispatchOutcome } from "./dispatch-ledger";
import { JOB_IDS, type JobId } from "./state";

export const BREAKER_FILE = "breaker.json";
export const BREAKER_CONFIG_FILE = "breaker-config.json";
export const DAY_MS = 24 * 3_600_000;

export interface BreakerConfig {
  /** Dispatches permitted in one tick — soft, self-clearing (routine flow control). */
  perTickCap: number;
  /** Dispatches permitted per rolling 24h — HARD: reaching it latches the breaker OPEN. */
  perDayCap: number;
  /** Max simultaneously in-flight dispatches — soft (verdict (b)(5), D5 concurrency cap). */
  maxConcurrent: number;
  /** Consecutive failed dispatches that latch the breaker OPEN. */
  failStreakTrip: number;
  /** Shared-quota fraction (0..1) below which dispatch refuses — protects the pilot (D4). */
  quotaReserveFloor: number;
}

// Receipts (spec §D4; verdict (b)(5); brief "receipt each constant"):
// - perTickCap 2: a tick is 10 min; two fix agents per tick is already a busy
//   unattended cadence — more is a runaway, not a workload.
// - perDayCap 12: an unattended day authoring more than a dozen fix agents is
//   the runaway the operator named; reaching it latches OPEN for a human look.
// - maxConcurrent 2: matches the host's one-`claude`-at-a-time posture plus a
//   little headroom; the ceremony ticks already run jobs sequentially.
// - failStreakTrip 3: two failures can be flaky; three in a row is a broken
//   class or environment — stop dispatching and escalate (tiered back-off).
// - quotaReserveFloor 0.2: keep a fifth of the shared weekly quota reserved for
//   the pilot's planner so dispatch can never starve it (D4, minimal pull-fwd).
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  perTickCap: 2,
  perDayCap: 12,
  maxConcurrent: 2,
  failStreakTrip: 3,
  quotaReserveFloor: 0.2,
};

const ConfigSchema = z
  .object({
    perTickCap: z.number().int().positive().catch(DEFAULT_BREAKER_CONFIG.perTickCap),
    perDayCap: z.number().int().positive().catch(DEFAULT_BREAKER_CONFIG.perDayCap),
    maxConcurrent: z.number().int().positive().catch(DEFAULT_BREAKER_CONFIG.maxConcurrent),
    failStreakTrip: z.number().int().positive().catch(DEFAULT_BREAKER_CONFIG.failStreakTrip),
    quotaReserveFloor: z.number().min(0).max(1).catch(DEFAULT_BREAKER_CONFIG.quotaReserveFloor),
  })
  .catch(DEFAULT_BREAKER_CONFIG);

export function loadBreakerConfig(dir: string): BreakerConfig {
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(join(dir, BREAKER_CONFIG_FILE), "utf8")));
  } catch {
    return { ...DEFAULT_BREAKER_CONFIG }; // missing/corrupt config → the receipted defaults
  }
}

export type BreakerReason = "per-day-cap" | "fail-streak" | "manual";

export interface BreakerState {
  status: "closed" | "open";
  openedAt: number | null;
  reason: BreakerReason | null;
  /** Consecutive failed dispatch outcomes; resets to 0 on a clean one. */
  failStreak: number;
}

export function defaultBreaker(): BreakerState {
  return { status: "closed", openedAt: null, reason: null, failStreak: 0 };
}

// Per-field .catch() mirrors AnchorSchema: a breaker.json that predates a field
// keeps its healthy siblings rather than resetting the whole job to closed
// (which would silently un-latch a tripped breaker on upgrade — the one thing a
// never-auto-reset breaker must never do). The `status` field itself fails
// toward OPEN, not closed: an unparseable/unknown status (typo, foreign edit,
// future migration) with a latched breaker's evidence (openedAt/reason/
// failStreak) intact must STAY blocked — mirroring evaluateDispatch's D4
// fail-safe direction. Defaulting a corrupt status to "closed" would silently
// un-latch a tripped breaker, the exact forbidden auto-reset above.
const StateSchema = z.object({
  status: z.enum(["closed", "open"]).catch("open"), // fail-safe: unknown status → OPEN, never un-latch
  openedAt: z.number().nullable().catch(null),
  reason: z.enum(["per-day-cap", "fail-streak", "manual"]).nullable().catch(null),
  failStreak: z.number().int().nonnegative().catch(0),
});

export function loadBreakers(dir: string): Record<JobId, BreakerState> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, BREAKER_FILE), "utf8"));
  } catch {
    raw = undefined;
  }
  const entries = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = {} as Record<JobId, BreakerState>;
  for (const id of JOB_IDS) {
    const parsed = StateSchema.safeParse(entries[id]);
    out[id] = parsed.success ? parsed.data : defaultBreaker();
  }
  return out;
}

export function saveBreakers(dir: string, breakers: Record<JobId, BreakerState>): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${BREAKER_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(breakers, null, 2));
  renameSync(tmp, join(dir, BREAKER_FILE));
}

/** Latch OPEN. Idempotent — re-tripping an open breaker keeps its first reason/time. */
export function tripOpen(state: BreakerState, reason: BreakerReason, now: number): BreakerState {
  if (state.status === "open") return state;
  return { ...state, status: "open", openedAt: now, reason };
}

/** The ONLY path back to closed — an explicit operator action, never automatic. */
export function manualReset(state: BreakerState, now: number): BreakerState {
  void now;
  return defaultBreaker();
}

// Fold a completed dispatch outcome into the breaker: a clean outcome zeroes
// the streak, a failure grows it, and the failStreakTrip'th consecutive
// failure latches OPEN. This is outcome-driven (solid ground), distinct from
// the sweep's classification (the D2 dead-vs-quiet unknown) — the breaker only
// ever trips on a RECORDED outcome, never on a sweep's guess.
export function recordDispatchResult(
  state: BreakerState,
  outcome: DispatchOutcome,
  cfg: BreakerConfig,
  now: number,
): BreakerState {
  if (outcome === "ok") return { ...state, failStreak: 0 };
  const failStreak = state.failStreak + 1;
  const next = { ...state, failStreak };
  if (failStreak >= cfg.failStreakTrip) return tripOpen(next, "fail-streak", now);
  return next;
}

export interface DispatchContext {
  /** canDispatch(gates) — the D1 gate. OFF in this build; permit refuses when false. */
  gateOn: boolean;
  breaker: BreakerState;
  inFlightCount: number;
  dispatchesThisTick: number;
  dispatchesLast24h: number;
  /** Readable shared-quota fraction (0..1), or null when the counter is unreadable. */
  quotaFraction: number | null;
  cfg: BreakerConfig;
  now: number;
}

export interface DispatchDecision {
  permit: boolean;
  reason:
    | "ok"
    | "gate-off"
    | "breaker-open"
    | "quota-unreadable"
    | "quota-floor"
    | "concurrency-cap"
    | "per-tick-cap"
    | "per-day-cap";
  /** Non-null when the denial should ALSO latch the breaker OPEN (the runaway signal). */
  trip: BreakerReason | null;
}

// The one dispatch permit decision — a future (b)-enabled executor consults
// this and NOTHING else before spawning a fix agent. Order is deliberate:
// hard gate first, then the reserve floor that protects the pilot, then the
// windowed caps. Only the per-day cap latches (the runaway); the per-tick and
// concurrency caps are soft, self-clearing flow control that must not demand a
// manual reset on a routine busy window.
export function evaluateDispatch(ctx: DispatchContext): DispatchDecision {
  if (!ctx.gateOn) return { permit: false, reason: "gate-off", trip: null };
  if (ctx.breaker.status === "open") return { permit: false, reason: "breaker-open", trip: null };
  // Fail SAFE on an unreadable quota (D4 load-bearing unknown 3): if we cannot
  // prove we are above the floor, we do not dispatch — protect the pilot.
  if (ctx.quotaFraction === null) return { permit: false, reason: "quota-unreadable", trip: null };
  if (ctx.quotaFraction < ctx.cfg.quotaReserveFloor) return { permit: false, reason: "quota-floor", trip: null };
  if (ctx.inFlightCount >= ctx.cfg.maxConcurrent) return { permit: false, reason: "concurrency-cap", trip: null };
  if (ctx.dispatchesThisTick >= ctx.cfg.perTickCap) return { permit: false, reason: "per-tick-cap", trip: null };
  if (ctx.dispatchesLast24h >= ctx.cfg.perDayCap) return { permit: false, reason: "per-day-cap", trip: "per-day-cap" };
  return { permit: true, reason: "ok", trip: null };
}
