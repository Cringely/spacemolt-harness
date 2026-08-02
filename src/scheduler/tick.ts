// Durable scheduler (#114) Task D-Tick: one poller pass. Cron runs this every
// 10 minutes as a fresh process (plan decision 1): evaluate, spawn what is
// due, exit. Order is load-bearing and verbatim from the plan (extended by
// #585's worktree reap — see the comment at that call site):
//   stop sentinel (BEFORE any work) → lock-or-exit → reap stale worktrees →
//   git fetch + head read (injected gitRunner; `git pull` of the checkout
//   belongs to E1's wrapper, never to tick) → dueJobs → run due jobs
//   SEQUENTIALLY via runJob, each in its own ephemeral worktree → absorb
//   steward self-shas → prune 14d-old logs/reports → release lock.
import { readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBreakerConfig, loadBreakers, recordDispatchResult, saveBreakers } from "./breaker";
import { loadLedger, recordOutcome, sweepLedger } from "./dispatch-ledger";
import { dueJobs, type MainStatus } from "./due";
import { fileFailureAlarm } from "./failure-alarm";
import type { GhRunner } from "./filing";
import type { GitResult, GitRunner } from "./git";
import { JOBS } from "./jobs";
import { runJob, type Spawner } from "./spawn";
import { acquireLock, loadAnchors, releaseLock, saveAnchors, stopRequested, type JobId } from "./state";
import { pollUsage, USAGE_POLL_SKIPPED, type UsageFetcher, type UsagePollResult } from "./usage-poll";
import { reapStaleWorktrees } from "./worktree";

// Re-exported so scripts/scheduler.ts's existing `import type { GitRunner }
// from "../src/scheduler/tick"` keeps working — the interfaces now live in
// ./git (spawn.ts needs them too, and importing tick.ts's copy from spawn.ts
// would be a module cycle; see git.ts's header).
export type { GitResult, GitRunner };

export interface TickDeps {
  clock: () => number;
  stateDir: string;
  /** The shared control clone. #585: tick.ts's own logic no longer reads this
   *  directly — gitRunner is already bound to it by the caller (scheduler.ts)
   *  — kept as a Deps-bag fact for callers/observability rather than removed,
   *  which would force every test's TickDeps literal to drop it for no
   *  functional gain. */
  checkoutDir: string;
  secretsDir: string;
  gitRunner: GitRunner;
  spawner: Spawner;
  /** Stage-4 usage-endpoint capture (#183). Optional: when absent the poll is
   *  skipped entirely — production wires the real fetcher (scripts/scheduler.ts),
   *  tick tests that don't exercise the poll leave it unset. */
  usageFetcher?: UsageFetcher;
  /** Passed through to runJob so tests fire per-job timeouts instantly. */
  waitTimeout?: (ms: number) => Promise<"timeout">;
  /** #558 part 2: files/bumps a failure-alarm issue for a job that fails this
   *  tick. Optional like usageFetcher above — production wires the real `gh`
   *  runner (scripts/scheduler.ts), tick tests that don't exercise the alarm
   *  leave it unset and the fire loop just skips filing. */
  ghRunner?: GhRunner;
}

export interface TickResult {
  skipped: "stop" | "lock" | null;
  fired: Array<{ jobId: JobId; result: "ok" | "fail" }>;
  absorbed: JobId[];
  pruned: number;
  /** Stage-3 dispatch sweep counts (spec: "every tick and every restart, sweep it"). */
  swept: { active: number; quiet: number; stale: number; reaped: number };
  /** Stage-4 usage poll outcome (#183) — no-fetcher/cadence skip, or the poll result. */
  usagePoll: UsagePollResult;
  /** #585: ephemeral worktrees reaped at tick start — nonzero means the PREVIOUS tick crashed or was killed mid-job. */
  worktreesReaped: number;
}

/** Written on every real tick; --health reads it (positive signal, L-17). */
export const LAST_TICK_FILE = "last-tick";

// ponytail: 3h stale threshold — the four job timeouts sum to 2h (15+30+45+30
// min), so a lock older than 3h is a crashed tick, not a slow one. A crashed
// tick therefore silences the scheduler for at most 3h before self-healing.
export const LOCK_STALE_MS = 3 * 3_600_000;

// 14d prune horizon (squad checklist 5; receipt in the plan): spans two
// operator morning-read gaps of vacation length, and any run worth keeping
// longer has already been filed as an issue or picked up as a report.
export const PRUNE_MAX_AGE_MS = 14 * 24 * 3_600_000;

// Read origin/main via the injected runner: fetch, then head sha + commit
// time + subjects since the steward anchor. Any unreadable piece ⇒ null and
// the steward is simply not evaluated this tick (grid jobs never need git) —
// a network-down tick must not poison the anchor with a bogus sha.
function readMainStatus(git: GitRunner, stewardAnchorSha: string | null): MainStatus | null {
  git(["fetch", "origin", "main"]); // failure tolerated: evaluate the last-fetched ref
  const head = git(["rev-parse", "origin/main"]);
  const headSha = head.stdout.trim();
  if (head.exitCode !== 0 || headSha === "") return null;
  const at = git(["log", "-1", "--format=%ct", "origin/main"]);
  const headCommitSec = Number(at.stdout.trim());
  if (at.exitCode !== 0 || !Number.isFinite(headCommitSec)) return null;
  let subjects: string[] = [];
  if (stewardAnchorSha !== null) {
    const log = git(["log", "--format=%s", `${stewardAnchorSha}..origin/main`]);
    // A failed range read (anchor gone after a force-push) degrades to [],
    // which due.ts treats as fire-not-absorb: a spare steward pass is cheap,
    // a silently absorbed real merge is not.
    subjects =
      log.exitCode === 0
        ? log.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s !== "")
        : [];
  }
  return { headSha, headCommitAt: headCommitSec * 1000, newSubjectsSinceAnchor: subjects };
}

// Steward anchor updates load anchors FRESH each time: runJob saves its own
// attempt record per job, and a stale in-memory copy here would clobber it.
function setStewardSha(stateDir: string, jobId: JobId, sha: string): void {
  const anchors = loadAnchors(stateDir);
  anchors[jobId].stewardAnchorSha = sha;
  saveAnchors(stateDir, anchors);
}

function pruneOld(stateDir: string, now: number): number {
  let pruned = 0;
  for (const sub of ["logs", "reports"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(stateDir, sub));
    } catch {
      continue; // dir not created yet — nothing to prune
    }
    for (const name of entries) {
      const p = join(stateDir, sub, name);
      try {
        const st = statSync(p);
        if (st.isFile() && now - st.mtimeMs > PRUNE_MAX_AGE_MS) {
          unlinkSync(p);
          pruned++;
        }
      } catch {
        // raced away or unreadable — skip, never abort the tick over scratch
      }
    }
  }
  return pruned;
}

const NO_SWEEP = { active: 0, quiet: 0, stale: 0, reaped: 0 };
const NO_WORKTREES_REAPED = 0;

// Stage-3 dispatch sweep (spec §Sequencing stage 3): every tick, classify the
// in-flight ledger (D2 dead-vs-quiet) and reap entries past their absolute
// deadline — a crash/restart-orphaned dispatch that never wrote its outcome
// would otherwise block the concurrency cap forever. Reaping counts as a
// failed dispatch, so it feeds the per-job breaker's fail streak. On an empty
// ledger (the current gate-OFF reality) this is a pure no-op: no ledger, no
// writes. The poke/re-poke/kill rungs the sweep also computes need the live
// poke transport that does not exist yet (deferred like the strategy steer
// channel), so tick applies only the reap today.
function sweepDispatch(stateDir: string, now: number): TickResult["swept"] {
  const entries = loadLedger(stateDir);
  const swept = sweepLedger(entries, now);
  if (swept.reaped.length > 0) {
    const breakers = loadBreakers(stateDir);
    const cfg = loadBreakerConfig(stateDir);
    for (const id of swept.reaped) {
      const entry = entries.find((e) => e.dispatchId === id);
      recordOutcome(stateDir, id, "orphaned", now);
      if (entry) breakers[entry.jobId] = recordDispatchResult(breakers[entry.jobId], "orphaned", cfg, now);
    }
    saveBreakers(stateDir, breakers);
  }
  return { active: swept.active, quiet: swept.quiet, stale: swept.stale, reaped: swept.reaped.length };
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  // Stop sentinel BEFORE any work: zero spawns, zero state writes (the
  // operator's pause lever must be absolute — squad checklist 1/3).
  if (stopRequested(deps.stateDir))
    return {
      skipped: "stop",
      fired: [],
      absorbed: [],
      pruned: 0,
      swept: NO_SWEEP,
      usagePoll: USAGE_POLL_SKIPPED,
      worktreesReaped: NO_WORKTREES_REAPED,
    };

  const now = deps.clock();
  if (!acquireLock(deps.stateDir, now, LOCK_STALE_MS)) {
    return {
      skipped: "lock",
      fired: [],
      absorbed: [],
      pruned: 0,
      swept: NO_SWEEP,
      usagePoll: USAGE_POLL_SKIPPED,
      worktreesReaped: NO_WORKTREES_REAPED,
    };
  }

  try {
    writeFileSync(join(deps.stateDir, LAST_TICK_FILE), String(now));

    // #585: reap any ephemeral worktree left behind by a tick that crashed or
    // was killed mid-job, BEFORE evaluating or firing anything this NEXT
    // SUCCESSFULLY-ACQUIRED tick. Safe because acquireLock above already
    // guarantees single-tick concurrency. On a hard crash (SIGKILL) this
    // wrapper's own finally{releaseLock} never runs, so reap waits out the
    // existing LOCK_STALE_MS (3h) stale-lock window like every other crash
    // recovery here — not a new risk, just this comment's old claim was wrong.
    const worktreesReaped = reapStaleWorktrees(deps.gitRunner, deps.stateDir);

    // Stage-4 usage capture (#183): one low-frequency poll from the tick path,
    // guarded so a network subsystem can never break a governance tick. Skipped
    // when no fetcher is wired. This catch is LOAD-BEARING (PR #450 review):
    // pollUsage catches its own fetch, but its state/file writes
    // (saveUsagePollState, writeCaptureFile) are unguarded and can throw on an
    // fs error -- this keeps that from killing the tick.
    let usagePoll: UsagePollResult = USAGE_POLL_SKIPPED;
    if (deps.usageFetcher) {
      try {
        usagePoll = await pollUsage({ now, stateDir: deps.stateDir, secretsDir: deps.secretsDir, fetcher: deps.usageFetcher });
      } catch {
        usagePoll = { ...USAGE_POLL_SKIPPED, reason: "network-error" };
      }
    }

    const anchors = loadAnchors(deps.stateDir);
    const main = readMainStatus(deps.gitRunner, anchors.steward.stewardAnchorSha);
    if (main === null) {
      // Unreadable origin/main (expired PAT, DNS, corrupt checkout): the
      // steward is silently skipped below. Bump its failStreak so the
      // existing `!! FAILING` banner in health.ts surfaces this for free —
      // otherwise this failure mode has zero signal anywhere (L-17).
      anchors.steward.failStreak += 1;
      saveAnchors(deps.stateDir, anchors);
    }
    // No usable origin/main ref ⇒ evaluate grid jobs only this tick.
    const evalJobs = main === null ? JOBS.filter((j) => j.schedule.kind === "grid") : JOBS;
    const { fire, absorb } = dueJobs(evalJobs, anchors, now, main ?? { headSha: "", headCommitAt: 0, newSubjectsSinceAnchor: [] });

    const absorbed: JobId[] = [];
    for (const { jobId, sha } of absorb) {
      setStewardSha(deps.stateDir, jobId, sha);
      absorbed.push(jobId);
    }

    // Every job this tick pins its ephemeral worktree to the SAME commit —
    // computed once, not per-job, since nothing in this tick's own control
    // flow advances origin/main mid-loop. main.headSha (this tick's fresh
    // fetch) is preferred; the readMainStatus-unreadable fallback reads the
    // checkout's current HEAD, which the E1 wrapper's refresh-checkout.sh
    // already fast-forwarded to origin/main before this process started, so
    // grid jobs still get a real, current commit to run against even when
    // this tick's own git reads failed. Computed lazily (only when a job is
    // actually about to fire) so a quiet tick issues zero extra git calls.
    let pinnedSha: string | null = null;
    const resolvePinnedSha = (): string => {
      if (pinnedSha === null) {
        pinnedSha = main !== null ? main.headSha : deps.gitRunner(["rev-parse", "HEAD"]).stdout.trim();
      }
      return pinnedSha;
    };

    // SEQUENTIALLY, by design: one `claude -p` at a time on the host (plan
    // §D-Tick). runJob's contract is no-throw — a rejecting spawner records a
    // fail + failStreak and the loop moves to the next job. #585: each job now
    // runs in its OWN disposable worktree (runJob creates + removes it), so
    // the shared checkout in deps.checkoutDir is never written to by a job —
    // the producer-side "restore shared checkout to main after the steward"
    // this loop used to issue (#413) is gone because there is nothing left
    // for it to restore; scripts/scheduler-refresh-checkout.sh's consumer-side
    // strand guard stays as defense in depth against anything else touching
    // the shared checkout, but no ceremony job can trigger it anymore.
    const fired: TickResult["fired"] = [];
    for (const job of fire) {
      const outcome = await runJob(job, {
        spawner: deps.spawner,
        clock: deps.clock,
        stateDir: deps.stateDir,
        gitRunner: deps.gitRunner,
        pinnedSha: resolvePinnedSha(),
        secretsDir: deps.secretsDir,
        ...(deps.waitTimeout ? { waitTimeout: deps.waitTimeout } : {}),
      });
      if (job.schedule.kind === "main-merge" && main !== null) {
        // Steward anchor advances on ATTEMPT, like the grids (plan decision 3):
        // a failing steward retries on the NEXT merge, never every tick. (main
        // is non-null here: evalJobs drops main-merge jobs when main === null.)
        setStewardSha(deps.stateDir, job.id, main.headSha);
      }
      fired.push({ jobId: job.id, result: outcome.result });

      // #558 part 2: a failed run must surface the same way a successful one
      // does. Reload anchors FRESH (not the tick-start `anchors` var above) —
      // runJob already saved this job's post-attempt failStreak, and reusing
      // the stale in-memory copy here would read the streak from BEFORE this
      // attempt (same staleness reasoning as setStewardSha's own comment).
      if (outcome.result === "fail" && deps.ghRunner) {
        try {
          const failStreak = loadAnchors(deps.stateDir)[job.id].failStreak;
          fileFailureAlarm(deps.ghRunner, deps.stateDir, {
            jobId: job.id,
            cycleId: outcome.cycleId,
            failStreak,
            timedOut: outcome.timedOut,
            exitCode: outcome.exitCode,
          });
        } catch {
          // A gh outage filing the ALARM must never abort the tick that is
          // trying to report the original failure — no-throw, like runJob.
        }
      }
    }

    const pruned = pruneOld(deps.stateDir, now);
    const swept = sweepDispatch(deps.stateDir, now);
    return { skipped: null, fired, absorbed, pruned, swept, usagePoll, worktreesReaped };
  } finally {
    releaseLock(deps.stateDir);
  }
}
