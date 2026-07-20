// Durable scheduler (#114) Task A1: flat-JSON state on the host, outside the
// checkout (plan decision 7). Files, not a database: restart-safe, `cat`-able.
// Loaders are schema-tolerant per the binding AGENTS.md rule — persisted state
// outlives the schema that wrote it, so anything invalid degrades to defaults,
// never a throw (the chat-enum crash-loop class).
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const JOB_IDS = ["standup", "strategy", "council", "steward"] as const;
export type JobId = (typeof JOB_IDS)[number];

export interface JobAnchor {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastResult: "ok" | "fail" | null;
  failStreak: number;
  stewardAnchorSha: string | null;
}

export const ANCHORS_FILE = "anchors.json";
export const LOCK_FILE = "lock";
export const STOP_FILE = "stop";

export function defaultAnchor(): JobAnchor {
  return { lastAttemptAt: null, lastSuccessAt: null, lastResult: null, failStreak: 0, stewardAnchorSha: null };
}

// Per-field .catch(): a corrupt or missing FIELD falls back alone while its
// healthy siblings survive — an anchors file that predates failStreak keeps
// its lastAttemptAt instead of resetting the whole job to "never ran" (which
// would fire a spurious catch-up burst on upgrade).
const AnchorSchema = z.object({
  lastAttemptAt: z.number().nullable().catch(null),
  lastSuccessAt: z.number().nullable().catch(null),
  lastResult: z.enum(["ok", "fail"]).nullable().catch(null),
  failStreak: z.number().int().nonnegative().catch(0),
  stewardAnchorSha: z.string().nullable().catch(null),
});

export function loadAnchors(dir: string): Record<JobId, JobAnchor> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, ANCHORS_FILE), "utf8"));
  } catch {
    raw = undefined; // missing, truncated, or corrupt file → all defaults
  }
  const entries = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out = {} as Record<JobId, JobAnchor>;
  for (const id of JOB_IDS) {
    const parsed = AnchorSchema.safeParse(entries[id]);
    out[id] = parsed.success ? parsed.data : defaultAnchor();
  }
  return out;
}

// Atomic write: tmp file + rename, so a crash mid-write leaves the previous
// anchors intact instead of the truncated file loadAnchors defends against.
export function saveAnchors(dir: string, anchors: Record<JobId, JobAnchor>): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${ANCHORS_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(anchors, null, 2));
  renameSync(tmp, join(dir, ANCHORS_FILE));
}

// Single-instance tick lock (plan decision 2). The lock file holds the
// acquiring tick's clock so a later tick can age it: a crashed tick's lock
// (age > staleMs) is broken, a live one is respected.
// ponytail: the stale-break is check-then-write, not compare-and-swap — cron
// serializes ticks 10 minutes apart, so two pollers racing a stale lock is
// not a real scenario on this host.
export function acquireLock(dir: string, now: number, staleMs: number): boolean {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LOCK_FILE);
  try {
    writeFileSync(path, String(now), { flag: "wx" });
    return true;
  } catch {
    let heldAt = Number.NaN;
    try {
      heldAt = Number(readFileSync(path, "utf8"));
    } catch {
      // unreadable lock → treated as stale below
    }
    if (!Number.isFinite(heldAt) || now - heldAt > staleMs) {
      writeFileSync(path, String(now));
      return true;
    }
    return false;
  }
}

export function releaseLock(dir: string): void {
  try {
    unlinkSync(join(dir, LOCK_FILE));
  } catch {
    // already gone — release is idempotent
  }
}

// Stop sentinel (squad checklist 1/3): touching this file makes the poller
// exit clean before doing any work; removing it resumes service.
export function stopRequested(dir: string): boolean {
  return existsSync(join(dir, STOP_FILE));
}
