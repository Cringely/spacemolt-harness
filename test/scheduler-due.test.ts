// Batch A / Task A2 (#114): job table + grid/main-merge due evaluation.
// Fake clock (plain epoch-ms via Date.UTC — timezone-independent), zero IO.
import { describe, expect, test } from "bun:test";
import { dueJobs, type MainStatus } from "../src/scheduler/due";
import { JOBS } from "../src/scheduler/jobs";
import { defaultAnchor, JOB_IDS, type JobAnchor, type JobId } from "../src/scheduler/state";

const MIN = 60_000;

const freshAnchors = (): Record<JobId, JobAnchor> => {
  const out = {} as Record<JobId, JobAnchor>;
  for (const id of JOB_IDS) out[id] = defaultAnchor();
  return out;
};

const utc = (day: number, h: number, m: number) => Date.UTC(2026, 6, day, h, m);

// A quiet main: sha already anchored, nothing new — keeps the steward inert
// in the grid-focused tests.
const quietMain = (anchors: Record<JobId, JobAnchor>): MainStatus => {
  anchors.steward.stewardAnchorSha = "base";
  return { headSha: "base", headCommitAt: 0, newSubjectsSinceAnchor: [] };
};

const firedIds = (r: ReturnType<typeof dueJobs>) => r.fire.map((j) => j.id);

// Marks all currently-due jobs attempted at `at` — what the tick does after
// spawning (anchor advances on ATTEMPT, plan decision 3).
const attemptDue = (anchors: Record<JobId, JobAnchor>, at: number, main: MainStatus) => {
  for (const job of dueJobs(JOBS, anchors, at, main).fire) anchors[job.id].lastAttemptAt = at;
};

describe("due evaluation (A2)", () => {
  // Catches: first install scheduling nothing — fresh anchors ⇒ every periodic
  // job due once. This IS the ceremony-ledger absorption (plan decision 6).
  // The steward instead adopts the current head without firing: a fresh
  // scheduler has no merge delta to steward.
  test("fresh anchors: all periodic jobs due, steward absorbs the current sha", () => {
    const anchors = freshAnchors();
    const main: MainStatus = { headSha: "abc", headCommitAt: 0, newSubjectsSinceAnchor: [] };
    const r = dueJobs(JOBS, anchors, utc(18, 9, 0), main);
    expect(firedIds(r)).toEqual(["standup", "strategy", "council"]);
    expect(r.absorb).toEqual([{ jobId: "steward", sha: "abc" }]);
  });

  // Catches: both failure modes the anchored-schedules directive names — a
  // make-up burst (13 stand-ups after 26h down) and a counter reset costing a
  // second cycle (nothing firing until the NEXT grid point after a wake).
  test("26h outage: exactly one catch-up fire per periodic job, then normal cadence", () => {
    const anchors = freshAnchors();
    const main = quietMain(anchors);
    // Last normal attempts on day 18: standup 08:07, strategy 06:27, council 06:19.
    anchors.standup.lastAttemptAt = utc(18, 8, 7);
    anchors.strategy.lastAttemptAt = utc(18, 6, 27);
    anchors.council.lastAttemptAt = utc(18, 6, 19);
    // Scheduler wakes ~26h later.
    const wake = utc(19, 10, 40);
    expect(firedIds(dueJobs(JOBS, anchors, wake, main))).toEqual(["standup", "strategy", "council"]);
    attemptDue(anchors, wake, main);
    // Next 10-min tick: no make-up burst.
    expect(firedIds(dueJobs(JOBS, anchors, wake + 10 * MIN, main))).toEqual([]);
    // Normal cadence resumes on the grid: standup at 12:07, nothing at 11:57.
    expect(firedIds(dueJobs(JOBS, anchors, utc(19, 11, 57), main))).toEqual([]);
    expect(firedIds(dueJobs(JOBS, anchors, utc(19, 12, 7), main))).toEqual(["standup"]);
  });

  // Catches: drift off the mandated :07/2h grid. (Plan labels 09:07/10:57/11:07;
  // the epoch-anchored 2h grid puts :07 on even UTC hours, so the same walk
  // reads 08:07/09:57/10:07 — identical semantics, one grid-parity shift.)
  test("standup fired on the grid is not due mid-cycle, due at the next :07 point", () => {
    const anchors = freshAnchors();
    const main = quietMain(anchors);
    anchors.standup.lastAttemptAt = utc(18, 8, 7);
    anchors.strategy.lastAttemptAt = utc(18, 8, 7);
    anchors.council.lastAttemptAt = utc(18, 8, 7);
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 9, 57), main))).toEqual([]);
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 10, 7), main))).toEqual(["standup"]);
  });

  // Catches: cron-phase ↔ grid-offset seam drift (runbook E1 cites these
  // constants) — each job due exactly at its mandated phase, not 10 min early.
  test("grid offsets hold the mandated phase (:07, :27, 06:19)", () => {
    const anchors = freshAnchors();
    const main = quietMain(anchors);
    anchors.standup.lastAttemptAt = utc(18, 10, 7);
    anchors.strategy.lastAttemptAt = utc(18, 6, 27);
    anchors.council.lastAttemptAt = utc(18, 6, 19);
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 12, 0), main))).toEqual([]); // :07 not yet
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 12, 7), main))).toEqual(["standup"]);
    anchors.standup.lastAttemptAt = utc(18, 12, 7);
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 12, 17), main))).toEqual([]); // :27 not yet
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 12, 27), main))).toEqual(["strategy"]);
    // Jump to the next council point; refresh the faster grids so only the
    // council phase is under test.
    anchors.standup.lastAttemptAt = utc(19, 6, 7);
    anchors.strategy.lastAttemptAt = utc(19, 0, 27);
    expect(firedIds(dueJobs(JOBS, anchors, utc(19, 6, 9), main))).toEqual([]); // 06:19 not yet
    expect(firedIds(dueJobs(JOBS, anchors, utc(19, 6, 19), main))).toEqual(["council"]);
  });

  // Catches: mid-cluster steward spam (fires inside the settle window) AND the
  // steward self-trigger loop (its own merged docs(steward) PR re-triggering
  // it forever, L-3).
  test("steward: settle window, self-skip absorption, real merges fire", () => {
    const anchors = freshAnchors();
    anchors.steward.stewardAnchorSha = "old";
    const mergedAt = utc(18, 9, 0);
    const merge: MainStatus = {
      headSha: "new",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: ["feat(agent): thing (#380)"],
    };
    // 5 min old: inside the 20-min settle — not due, not absorbed.
    let r = dueJobs(JOBS, anchors, mergedAt + 5 * MIN, merge);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([]);
    // 20 min old: due.
    expect(firedIds(dueJobs(JOBS, anchors, mergedAt + 20 * MIN, merge))).toContain("steward");
    // All-new-subjects steward self-merge: never fires, sha absorbed.
    const selfMerge: MainStatus = {
      headSha: "new2",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: ["docs(steward): reconcile cluster (#381)"],
    };
    r = dueJobs(JOBS, anchors, mergedAt + 25 * MIN, selfMerge);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([{ jobId: "steward", sha: "new2" }]);
    // Mixed cluster (steward PR + a real one): fires.
    const mixed: MainStatus = {
      headSha: "new3",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: ["docs(steward): reconcile (#381)", "fix(agent): real (#382)"],
    };
    expect(firedIds(dueJobs(JOBS, anchors, mergedAt + 25 * MIN, mixed))).toContain("steward");
    // Unchanged sha: inert.
    const unchanged: MainStatus = { headSha: "old", headCommitAt: 0, newSubjectsSinceAnchor: [] };
    r = dueJobs(JOBS, anchors, mergedAt + 60 * MIN, unchanged);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([]);
  });

  // Catches: dropping the `subjects.length > 0` guard in due.ts — an EMPTY
  // subject list makes `every(...)` vacuously true, silently absorbing a real
  // sha delta (rebase/force-push, git hiccup) and advancing the anchor past a
  // real merge forever. A sha change with no subjects must FIRE, never absorb.
  test("empty-subject sha delta fires -- vacuous self-merge must not absorb", () => {
    const anchors = freshAnchors();
    anchors.steward.stewardAnchorSha = "old";
    const mergedAt = utc(18, 9, 0);
    const emptyDelta: MainStatus = {
      headSha: "new",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: [],
    };
    // Past the settle window: must be in fire, not absorb.
    const r = dueJobs(JOBS, anchors, mergedAt + 20 * MIN, emptyDelta);
    expect(firedIds(r)).toContain("steward");
    expect(r.absorb).toEqual([]);
  });

  // Catches: a failing job re-spawning every 10-min tick (L-3, token burn) —
  // due-ness keys on lastAttemptAt regardless of result; a fail retries at the
  // NEXT grid point, never hot-loops.
  test("a just-attempted failing job is not due until the next grid point", () => {
    const anchors = freshAnchors();
    const main = quietMain(anchors);
    for (const id of JOB_IDS) anchors[id].lastAttemptAt = utc(18, 8, 7);
    anchors.standup.lastResult = "fail";
    anchors.standup.failStreak = 1;
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 8, 17), main))).toEqual([]); // next tick: no retry
    expect(firedIds(dueJobs(JOBS, anchors, utc(18, 10, 7), main))).toEqual(["standup"]); // next grid point
  });
});
