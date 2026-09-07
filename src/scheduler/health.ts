// Durable scheduler (#114) Task D-Health: the operator probe. Until stage 2
// ships a staleness alarm, `bun scripts/scheduler.ts health` is the ONLY
// window into headless job failure — so every line is a positive signal,
// never inferred from silence (L-17): a job that never ran says "never", a
// nonzero failStreak gets a loud !! FAILING line at the top, the gates line
// states each capability's posture, stop/lock/last-tick are stated outright.
// Ledger summary arrives with stage 3; deliberately not printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBreakers } from "./breaker";
import { ledgerTotals, loadLedger, sweepLedger } from "./dispatch-ledger";
import { latestGridPoint } from "./due";
import { readFilingLog, type FilingLogEntry } from "./filing";
import { canDispatch, canFile, loadGates } from "./gates";
import type { JobDef } from "./jobs";
import { JOB_IDS, LOCK_FILE, STOP_FILE, loadAnchors, type JobAnchor } from "./state";
import { LAST_TICK_FILE } from "./tick";

function age(ms: number): string {
  const m = Math.round(Math.max(0, ms) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Timestamp + its age, or the explicit word "never" — no blanks. */
function when(ts: number | null, now: number): string {
  return ts === null ? "never" : `${new Date(ts).toISOString()} (${age(now - ts)} ago)`;
}

const DAY_MS = 86_400_000;

/**
 * The `gates:` line above states filing's on/off POLICY; it says nothing
 * about whether filing has actually happened or is stuck. This reads the
 * local finding-log (filing.ts's own writer) to answer that — three cases,
 * kept as three distinct strings rather than one collapsed "no data" line,
 * because "never filed anything" and "filed things but this log is
 * unreadable" call for different operator responses.
 */
function filingSummary(log: ReturnType<typeof readFilingLog>, now: number): string {
  if (!log.present) return "filing: never (no findings recorded)";
  if (log.entries.length === 0) return `filing: log present but no readable entries (${log.unreadable} unreadable lines)`;
  const newest = log.entries.at(-1)!;
  const recent = log.entries.filter((e) => now - Date.parse(e.ts) <= DAY_MS);
  const count = (outcome: FilingLogEntry["outcome"]) => recent.filter((e) => e.outcome === outcome).length;
  const summary = `filing: last ${newest.outcome} ${when(Date.parse(newest.ts), now)} | 24h created ${count("created")} bumped ${count("bumped")} suppressed ${count("suppressed")} capped ${count("capped")} | consumer ${newest.consumer}`;
  // A torn tail (truncated last write) can make `.at(-1)` the SECOND-newest
  // readable entry, silently dropping the actual newest one — e.g. the
  // `consumer:"error"` record that should have triggered the loud line
  // below. Some garbage lines alongside otherwise-good ones must stay
  // visible here, not just on the all-garbage branch above.
  return log.unreadable > 0 ? `${summary} (${log.unreadable} unreadable lines)` : summary;
}

function nextDue(job: JobDef, anchor: JobAnchor, now: number): string {
  if (job.schedule.kind === "main-merge") return "on next main merge";
  const { periodMs, offsetMs } = job.schedule;
  // Shared with due.ts's dueJobs() — one grid-point definition, not a
  // hand-paired duplicate. Due when the latest grid point postdates the
  // last attempt (null ⇒ due).
  const latest = latestGridPoint(now, periodMs, offsetMs);
  if (anchor.lastAttemptAt === null || latest > anchor.lastAttemptAt) return "due NOW";
  return new Date(latest + periodMs).toISOString();
}

export function health(stateDir: string, jobs: JobDef[], now: number): string {
  const anchors = loadAnchors(stateDir);
  const gates = loadGates(stateDir);
  const filingLog = readFilingLog(stateDir);

  let lastTick: number | null = null;
  try {
    const n = Number(readFileSync(join(stateDir, LAST_TICK_FILE), "utf8"));
    if (Number.isFinite(n)) lastTick = n;
  } catch {
    // never ticked (or unreadable) — reported as the explicit "never" below
  }

  const lines: string[] = [
    `scheduler health @ ${new Date(now).toISOString()}`,
    `last tick: ${when(lastTick, now)}`,
    `stop: ${existsSync(join(stateDir, STOP_FILE)) ? "PRESENT (scheduler paused)" : "absent"} | lock: ${existsSync(join(stateDir, LOCK_FILE)) ? "PRESENT (tick running, or crashed within the stale window)" : "absent"}`,
    // canAmend is unconditionally false by construction (gates.ts, verdict
    // (c)) — printed as the literal NEVER, not a state read.
    `gates: filing ${canFile(gates) ? "ON" : "OFF"} / dispatch ${canDispatch(gates) ? "ON" : "OFF"} / amend NEVER`,
    filingSummary(filingLog, now),
  ];

  // Failures first, loudly — a probe that buries the failing job in a table
  // row is worse than none (plan §D-Health).
  for (const j of jobs) {
    const a = anchors[j.id];
    if (a.failStreak > 0) {
      lines.push(`!! FAILING: ${j.id} failStreak ${a.failStreak} — last attempt ${when(a.lastAttemptAt, now)}, last success ${when(a.lastSuccessAt, now)}`);
    }
  }

  // Stage-3 dispatch accounting (spec §--health: "a ledger summary"). A latched
  // breaker is a loud line like FAILING — it means dispatch is HALTED until an
  // operator runs reset-breaker; burying it in a row would hide the halt.
  const breakers = loadBreakers(stateDir);
  for (const id of JOB_IDS) {
    const b = breakers[id];
    if (b.status === "open") {
      lines.push(`!! BREAKER OPEN: ${id} — dispatch halted (${b.reason ?? "unknown"}, since ${when(b.openedAt, now)}); reset with \`scheduler.ts reset-breaker ${id}\``);
    }
  }

  // The consumer probe degrades to "error" rather than throwing (see
  // filing.ts probeConsumerAction) specifically so a dead gh PAT gets
  // RECORDED as a suppression instead of vanishing into an uncaught
  // exception with nothing logged. That design only pays off if something
  // reads the record back loudly — this is that read.
  const newestFiling = filingLog.entries.at(-1);
  if (newestFiling?.consumer === "error") {
    lines.push(
      `!! CONSUMER PROBE ERROR: filing is suppressed because the consumer probe could not run (last attempt ${when(Date.parse(newestFiling.ts), now)}) — check gh auth on this host`,
    );
  }

  const ledger = loadLedger(stateDir);
  const t = ledgerTotals(ledger, now);
  const sweep = sweepLedger(ledger, now);
  lines.push(
    `dispatch ledger: ${t.total} total | ${t.inFlight} in-flight | ${t.last24h} in last 24h | ok ${t.ok} fail ${t.fail} killed ${t.killed} orphaned ${t.orphaned}`,
    `dispatch spend: $${t.costUsd.toFixed(4)} total | $${t.costLast24h.toFixed(4)} last 24h (null on the subscription path — see runs-*.jsonl tokens, #183)`,
    `dispatch sweep: active ${sweep.active} | quiet ${sweep.quiet} | stale ${sweep.stale}`,
    `breakers: ${JOB_IDS.map((id) => `${id} ${breakers[id].status.toUpperCase()}`).join(" | ")}`,
  );

  for (const j of jobs) {
    const a = anchors[j.id];
    lines.push(
      `${j.id.padEnd(8)}  attempt ${when(a.lastAttemptAt, now)}  success ${when(a.lastSuccessAt, now)}  result ${a.lastResult ?? "none"}  failStreak ${a.failStreak}  next due ${nextDue(j, a, now)}`,
    );
  }

  return lines.join("\n");
}
