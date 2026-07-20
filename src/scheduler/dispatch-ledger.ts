// Durable scheduler (#114) Stage 3: the dispatch ledger + orphan sweep (spec
// §Sequencing stage 3; #114 squad-council "dispatch ledger" comment). This is
// the ACCOUNTING the operator flips the dispatch gate ON against — capability
// (b) stays OFF in gates.json (gates.ts); Stage 3 ships the machinery, never
// the switch. The ledger records every charter-armed fix-agent spawn (id,
// target defect, expected duration, cost bucket, outcome) so a windowed cap
// and a breaker can bound unattended spend, and so a crash-orphaned entry gets
// reaped instead of blocking the concurrency cap forever.
//
// Persisted-state tolerance (binding AGENTS.md rule, the 2026-07-12 chat-enum
// crash-loop class): a corrupt or PREDATING entry is SKIPPED, never a throw —
// the ledger outlives the schema that wrote it, and one bad line must not
// brick the sweep the whole breaker depends on. An entry lacking a stable id
// or spawn time is meaningless and dropped whole; a single bad FIELD degrades
// to its default while healthy siblings survive (mirrors state.ts).
//
// Flat JSON array, atomically rewritten (tmp + rename) like anchors.json — NOT
// a database and NOT append-JSONL: entries mutate (heartbeat, poke count,
// outcome), spec §Non-goals bans new persistence tech, and #114 says "same
// shape as the interim ledger" (a JSON object on disk). Consistency with the
// existing state files beats the brief's loose "SQLite or jsonl".
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { JOB_IDS, type JobId } from "./state";

export const LEDGER_FILE = "dispatch-ledger.json";

export type DispatchOutcome = "ok" | "fail" | "killed" | "orphaned";
export type CostBucket = "small" | "medium" | "large";

export interface DispatchEntry {
  /** Unique per spawn — the sweep, the dedup, and remediation all key on it. */
  dispatchId: string;
  /** The ceremony job that requested the dispatch (breaker is per-job). */
  jobId: JobId;
  /** The issue the fix agent targets — ledger dedup, verdict (b)(4). */
  issueRef: string;
  /** The named, closed defect class the dispatch is bounded to, verdict (b)(3). */
  defectClass: string;
  spawnedAt: number;
  /** Sweep window for the D2 dead-vs-quiet call: silent-but-inside-window = working. */
  expectedDurationMs: number;
  /** Estimated spend, per brief — a coarse bucket, not a token count we cannot read. */
  costBucket: CostBucket;
  /** D2 heartbeat; null until the agent first beats (a spawned-but-mute agent). */
  lastHeartbeatAt: number | null;
  /** Poke-first ladder position (D2): 0 = un-poked, advances per poke. */
  pokeCount: number;
  /** null = in-flight; a terminal outcome closes the entry. */
  outcome: DispatchOutcome | null;
  completedAt: number | null;
  // ACTUAL spend, captured from the claude -p result at completion
  // (recordOutcome), distinct from the pre-spawn costBucket estimate. costUsd
  // may stay null on the subscription path (#183); the token counts are the
  // fallback. With costUsd + jobId + spawnedAt on every row, "sum cost by
  // day/job" is a trivial filter — no aggregation subsystem needed.
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Spend fields recordOutcome writes onto a closing entry (from RunOutcome.usage). */
export interface DispatchSpend {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

// A JobId that a forged/predating ledger cannot smuggle past — an unknown
// jobId fails the whole entry (dropped), never lands in a Record<JobId,...>.
const JobIdSchema = z.custom<JobId>((v) => typeof v === "string" && (JOB_IDS as readonly string[]).includes(v));

// dispatchId / jobId / spawnedAt carry NO .catch(): an entry missing any of
// them is not a dispatch record and is dropped whole (safeParse fails). Every
// other field degrades to a default so a partial/predating entry still loads.
const EntrySchema = z.object({
  dispatchId: z.string().min(1),
  jobId: JobIdSchema,
  issueRef: z.string().catch(""),
  defectClass: z.string().catch(""),
  spawnedAt: z.number(),
  expectedDurationMs: z.number().nonnegative().catch(0),
  costBucket: z.enum(["small", "medium", "large"]).catch("medium"),
  lastHeartbeatAt: z.number().nullable().catch(null),
  pokeCount: z.number().int().nonnegative().catch(0),
  // Fail-safe direction (mirrors breaker.ts status): a corrupt outcome degrades
  // to the terminal "orphaned", NOT to null. null means in-flight (inFlight()),
  // so defaulting a bad value to null would resurrect a closed entry into the
  // concurrency count and sweep, then reap it as a false failure. An explicit
  // null still parses (nullable) — only an unreadable value fails toward closed.
  outcome: z.enum(["ok", "fail", "killed", "orphaned"]).nullable().catch("orphaned"),
  completedAt: z.number().nullable().catch(null),
  costUsd: z.number().nullable().catch(null),
  inputTokens: z.number().nullable().catch(null),
  outputTokens: z.number().nullable().catch(null),
});

export function loadLedger(dir: string): DispatchEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, LEDGER_FILE), "utf8"));
  } catch {
    return []; // missing, truncated, or corrupt file → empty ledger, never a throw
  }
  if (!Array.isArray(raw)) return [];
  const out: DispatchEntry[] = [];
  for (const item of raw) {
    const parsed = EntrySchema.safeParse(item);
    if (parsed.success) out.push(parsed.data); // one bad entry is skipped, the rest survive
  }
  return out;
}

// Atomic write (tmp + rename) so a crash mid-write leaves the previous ledger
// intact rather than the truncated file loadLedger defends against.
export function saveLedger(dir: string, entries: DispatchEntry[]): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${LEDGER_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(entries, null, 2));
  renameSync(tmp, join(dir, LEDGER_FILE));
}

/** Append a fresh in-flight dispatch. The write API a future (b)-enabled executor uses. */
export function recordDispatch(dir: string, entry: DispatchEntry): void {
  const entries = loadLedger(dir);
  entries.push(entry);
  saveLedger(dir, entries);
}

// Close a dispatch with its terminal outcome and (for a clean completion) its
// actual spend. Feeds the breaker's fail streak upstream. An orphaned/killed
// entry passes no spend — there was no result envelope to read.
export function recordOutcome(
  dir: string,
  dispatchId: string,
  outcome: DispatchOutcome,
  at: number,
  spend?: DispatchSpend,
): boolean {
  const entries = loadLedger(dir);
  const e = entries.find((x) => x.dispatchId === dispatchId && x.outcome === null);
  if (!e) return false;
  e.outcome = outcome;
  e.completedAt = at;
  if (spend) {
    if (spend.costUsd !== undefined) e.costUsd = spend.costUsd;
    if (spend.inputTokens !== undefined) e.inputTokens = spend.inputTokens;
    if (spend.outputTokens !== undefined) e.outputTokens = spend.outputTokens;
  }
  saveLedger(dir, entries);
  return true;
}

/** Record a liveness beat from an in-flight agent (D2). No-op on an unknown/closed id. */
export function recordHeartbeat(dir: string, dispatchId: string, at: number): boolean {
  const entries = loadLedger(dir);
  const e = entries.find((x) => x.dispatchId === dispatchId && x.outcome === null);
  if (!e) return false;
  e.lastHeartbeatAt = at;
  saveLedger(dir, entries);
  return true;
}

export const inFlight = (entries: DispatchEntry[]): DispatchEntry[] => entries.filter((e) => e.outcome === null);

/** Count dispatches spawned within the trailing window ending at `now`. */
export function dispatchesInWindow(entries: DispatchEntry[], windowMs: number, now: number): number {
  return entries.filter((e) => e.spawnedAt > now - windowMs).length;
}

// --- Sweep + poke-first remediation (D2) ------------------------------------
//
// The sweep is a PURE classifier: given the ledger and the clock, it labels
// each in-flight entry and picks the next remediation rung. It writes nothing.
// tick.ts applies the one action that works offline today — the hard-deadline
// reap — and the poke/re-poke/kill rungs are returned for the live executor
// that lands with the (b) enablement. The live poke TRANSPORT (an in-band
// message to a running agent) is deferred exactly like the strategy job's
// steer channel (#114 A1): no headless→agent channel exists yet, so remediation
// degrades to the reap until it does. That deferral is the honest state of the
// D2 load-bearing unknown — the classifier ships and is observable; the live
// poke does not pretend to work before its channel exists.

// 5 min: a healthy dispatched agent (a plan-execute loop) beats at least every
// few minutes. 5 min of silence flips active→quiet — NOT active→stale: quiet
// is "no recent beat", which alone cannot tell dead from between-beats.
export const HEARTBEAT_STALE_MS = 5 * 60_000;
// 10 min grace past a job's own expected duration before quiet becomes stale.
// This is the D2 dead-vs-quiet line: inside expected+grace a silent agent is
// PRESUMED working (the incident where a poke revived two agents a kill-sweep
// would have destroyed); only past it does the poke ladder start.
export const QUIET_GRACE_MS = 10 * 60_000;
// Two pokes, then kill — the council's "poke, wait, re-poke, kill only after
// pokes fail" ladder made concrete.
export const MAX_POKES = 2;
// Absolute reap line: 2x the expected budget plus 30 min. Past it, a still
// in-flight entry means the COMPLETION WRITE never landed (crash/restart) —
// the spawner's own timeoutMs would have killed a merely-slow process at ~1x
// expected. Reaping to "orphaned" unblocks the concurrency cap; it is the one
// remediation that is legitimate without a live poke, because at 2x+30m there
// is no "quietly working" agent left to protect.
export const HARD_DEADLINE_MULT = 2;
export const HARD_DEADLINE_FLOOR_MS = 30 * 60_000;

export type SweepClass = "active" | "quiet" | "stale";
export type PokeAction = "none" | "poke" | "repoke" | "kill";

export interface SweepItem {
  dispatchId: string;
  klass: SweepClass;
  /** The poke-first rung for a stale entry; "none" for active/quiet. */
  action: PokeAction;
}

export interface SweepResult {
  items: SweepItem[];
  /** dispatchIds past the absolute reap line — tick marks these "orphaned". */
  reaped: string[];
  active: number;
  quiet: number;
  stale: number;
}

function hardDeadlineMs(e: DispatchEntry): number {
  return Math.max(e.expectedDurationMs * HARD_DEADLINE_MULT, 0) + HARD_DEADLINE_FLOOR_MS;
}

function pokeAction(pokeCount: number): PokeAction {
  if (pokeCount <= 0) return "poke";
  if (pokeCount < MAX_POKES) return "repoke";
  return "kill";
}

/** Classify every in-flight entry (dead-vs-quiet, D2) and list the ones to reap. Pure. */
export function sweepLedger(entries: DispatchEntry[], now: number): SweepResult {
  const items: SweepItem[] = [];
  const reaped: string[] = [];
  let active = 0;
  let quiet = 0;
  let stale = 0;
  for (const e of inFlight(entries)) {
    if (now - e.spawnedAt > hardDeadlineMs(e)) {
      reaped.push(e.dispatchId); // absolute deadline: no living agent to protect
      continue;
    }
    // Silence measured from the last beat, or from spawn if it never beat.
    const silenceMs = now - (e.lastHeartbeatAt ?? e.spawnedAt);
    if (silenceMs <= HEARTBEAT_STALE_MS) {
      active++;
      items.push({ dispatchId: e.dispatchId, klass: "active", action: "none" });
    } else if (now - e.spawnedAt <= e.expectedDurationMs + QUIET_GRACE_MS) {
      quiet++; // silent but inside its own window → presumed working (D2)
      items.push({ dispatchId: e.dispatchId, klass: "quiet", action: "none" });
    } else {
      stale++;
      items.push({ dispatchId: e.dispatchId, klass: "stale", action: pokeAction(e.pokeCount) });
    }
  }
  return { items, reaped, active, quiet, stale };
}

export interface LedgerTotals {
  total: number;
  inFlight: number;
  last24h: number;
  ok: number;
  fail: number;
  killed: number;
  orphaned: number;
  /** Sum of recorded costUsd across all rows (null costs skipped); null on the subscription path. */
  costUsd: number;
  costLast24h: number;
}

/** Rollup for --health (spec §--health: "a ledger summary"). */
export function ledgerTotals(entries: DispatchEntry[], now: number): LedgerTotals {
  const by = (o: DispatchOutcome) => entries.filter((e) => e.outcome === o).length;
  const sumCost = (rows: DispatchEntry[]) => rows.reduce((acc, e) => acc + (e.costUsd ?? 0), 0);
  return {
    total: entries.length,
    inFlight: inFlight(entries).length,
    last24h: dispatchesInWindow(entries, 24 * 3_600_000, now),
    ok: by("ok"),
    fail: by("fail"),
    killed: by("killed"),
    orphaned: by("orphaned"),
    costUsd: sumCost(entries),
    costLast24h: sumCost(entries.filter((e) => e.spawnedAt > now - 24 * 3_600_000)),
  };
}
