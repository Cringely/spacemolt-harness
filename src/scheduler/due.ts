// Durable scheduler (#114) Task A2: pure due evaluation. The poller decides
// only THAT a job is due, never what it should do (spec §Architecture).
import type { JobDef } from "./jobs";
import type { JobAnchor, JobId } from "./state";

export interface MainStatus {
  headSha: string;
  headCommitAt: number;
  newSubjectsSinceAnchor: string[];
}

// The steward's own merged PRs are titled `docs(steward): ...`; a delta made
// entirely of those must never re-trigger it (L-3 self-trigger loop).
const STEWARD_SELF_SUBJECT = /^docs\(steward\)/;

// Latest grid point ≤ now on the epoch-anchored grid (t ≡ offset mod period).
// Exported so health.ts's "next due" arithmetic shares this ONE definition
// instead of a hand-paired duplicate (review finding, Batch D).
export function latestGridPoint(now: number, periodMs: number, offsetMs: number): number {
  return Math.floor((now - offsetMs) / periodMs) * periodMs + offsetMs;
}

// Grid due-ness anchors on ATTEMPT, not success (plan decision 3): a failing
// job retries at the next grid point, never hot-loops every 10-min tick.
// Catch-up is inherent — after an outage the newest missed grid point is
// simply "a grid point after lastAttemptAt", so the job fires immediately,
// exactly once (a day down costs one cycle, never two).
export function dueJobs(
  jobs: JobDef[],
  anchors: Record<JobId, JobAnchor>,
  now: number,
  main: MainStatus,
): { fire: JobDef[]; absorb: Array<{ jobId: JobId; sha: string }> } {
  const fire: JobDef[] = [];
  const absorb: Array<{ jobId: JobId; sha: string }> = [];
  for (const job of jobs) {
    const anchor = anchors[job.id];
    if (job.schedule.kind === "grid") {
      const { periodMs, offsetMs } = job.schedule;
      const gridPoint = latestGridPoint(now, periodMs, offsetMs);
      if (anchor.lastAttemptAt === null || gridPoint > anchor.lastAttemptAt) fire.push(job);
    } else {
      const { settleMs } = job.schedule;
      if (anchor.stewardAnchorSha === null) {
        // First run: adopt the current head without firing — a fresh scheduler
        // has no merge delta to steward (tick test 1, plan Batch D).
        absorb.push({ jobId: job.id, sha: main.headSha });
      } else if (main.headSha !== anchor.stewardAnchorSha) {
        const subjects = main.newSubjectsSinceAnchor;
        if (subjects.length > 0 && subjects.every((s) => STEWARD_SELF_SUBJECT.test(s))) {
          // Entire delta is the steward's own merged PR: absorb, never fire.
          // An EMPTY subject list with a sha delta (rebase/force-push, git
          // hiccup) is not proof of a self-merge, so it falls through and
          // fires — a spare steward pass is cheap; a silently skipped one
          // advances the anchor past a real merge forever.
          absorb.push({ jobId: job.id, sha: main.headSha });
        } else if (now - main.headCommitAt >= settleMs) {
          // Settle window: one steward per merge CLUSTER, not one per PR.
          fire.push(job);
        }
        // else: still settling — leave the anchor alone; a later tick fires.
      }
    }
  }
  return { fire, absorb };
}
