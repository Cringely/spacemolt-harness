// Durable scheduler (#114) Task A2: pure due evaluation. The poller decides
// only THAT a job is due, never what it should do (spec §Architecture).
import type { JobDef } from "./jobs";
import type { JobAnchor, JobId } from "./state";

export interface MainStatus {
  headSha: string;
  headCommitAt: number;
  newSubjectsSinceAnchor: string[];
  /** #1136: true when a docs/steward-* PR is already open and fresh enough
   *  (steward-standdown.ts's STEWARD_STANDDOWN_WINDOW_MS) to be an in-flight
   *  reconciliation of this same stretch of main -- the PM's own dispatched
   *  pass, or an earlier ceremony run nobody has merged or closed yet.
   *  Undefined/false behaves exactly as before firing: a probe that never
   *  ran (no ghRunner wired, or the call failed) must never make the
   *  ceremony stand down on missing information -- same "a spare pass is
   *  cheap" direction as the self-merge branch below. */
  stewardPrInFlight?: boolean;
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
        // subjects[0] is the NEWEST commit (git log's default order): when it
        // is the steward's own merge, that PR was authored against a main
        // that already included everything else in this delta, so it covers
        // the whole stretch even when older, non-steward subjects sit behind
        // it (#1136 fix-round: #135's "docs(steward)" merge was the newest
        // commit over a delta that also held #132's "spec: ..." subject.
        // The old subjects.every(...) check refused to absorb because not
        // EVERY subject matched, so the ceremony misfired into that cluster
        // a second time as #134). A steward subject sitting BEHIND a newer
        // real one is the opposite case and still falls through to fire
        // below: that real merge is provably unreconciled by any pass on
        // record.
        // An EMPTY subject list with a sha delta (rebase/force-push, git
        // hiccup) is not proof of a self-merge, so it falls through and
        // fires — a spare steward pass is cheap; a silently skipped one
        // advances the anchor past a real merge forever.
        if (subjects.length > 0 && STEWARD_SELF_SUBJECT.test(subjects[0]!)) {
          absorb.push({ jobId: job.id, sha: main.headSha });
        } else if (now - main.headCommitAt >= settleMs) {
          // Settle window: one steward per merge CLUSTER, not one per PR.
          // #1136: an open docs/steward-* PR already covers this stretch of
          // main -- firing here would just be the ceremony-vs-dispatched-pass
          // duplicate the issue named. Leave the anchor alone, same as
          // "still settling" below, so the NEXT tick re-checks fresh; the
          // probe's own recency window is what stops this deferring forever
          // once that PR goes stale (steward-standdown.ts).
          if (!main.stewardPrInFlight) fire.push(job);
        }
        // else: still settling — leave the anchor alone; a later tick fires.
      }
    }
  }
  return { fire, absorb };
}
