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
    expect(firedIds(r)).toEqual(["standup", "strategy", "council", "dedupe"]);
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
    anchors.dedupe.lastAttemptAt = utc(13, 3, 47); // weekly: its last Monday point, none crossed in this walk
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
    anchors.dedupe.lastAttemptAt = utc(18, 8, 7);
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
    anchors.dedupe.lastAttemptAt = utc(18, 6, 19);
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

  // Catches (#1135): the weekly dedupe ceremony drifting off its Monday 03:47
  // UTC phase, or firing more than once a week. July 2026: the 13th and the
  // 20th are Mondays.
  test("dedupe fires weekly at Monday 03:47 UTC, once", () => {
    const anchors = freshAnchors();
    const main = quietMain(anchors);
    for (const id of ["standup", "strategy", "council"] as const) anchors[id].lastAttemptAt = utc(31, 0, 0); // attempted after every point in this walk
    anchors.dedupe.lastAttemptAt = utc(13, 3, 47);
    expect(firedIds(dueJobs(JOBS, anchors, utc(20, 3, 37), main))).toEqual([]); // Monday, 10 min early
    expect(firedIds(dueJobs(JOBS, anchors, utc(20, 3, 47), main))).toEqual(["dedupe"]);
    anchors.dedupe.lastAttemptAt = utc(20, 3, 47);
    expect(firedIds(dueJobs(JOBS, anchors, utc(26, 23, 59), main))).toEqual([]); // the rest of the week
    expect(firedIds(dueJobs(JOBS, anchors, utc(27, 3, 47), main))).toEqual(["dedupe"]);
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
    // 25 min old: inside the #1136-fix-round 60-min settle — not due, not
    // absorbed. (25 min, not 5: this is past the OLD 20-min settle, pinning
    // that the widened window, not just any positive age, is what defers.)
    let r = dueJobs(JOBS, anchors, mergedAt + 25 * MIN, merge);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([]);
    // 60 min old: due.
    expect(firedIds(dueJobs(JOBS, anchors, mergedAt + 60 * MIN, merge))).toContain("steward");
    // All-new-subjects steward self-merge: never fires, sha absorbed.
    // Absorption never depends on settle time (it is checked first), so a
    // short 25-min age still proves the branch, not just the 60-min-old case.
    const selfMerge: MainStatus = {
      headSha: "new2",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: ["docs(steward): reconcile cluster (#381)"],
    };
    r = dueJobs(JOBS, anchors, mergedAt + 25 * MIN, selfMerge);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([{ jobId: "steward", sha: "new2" }]);
    // Mixed cluster, steward subject NEWEST (subjects[0]): absorbed even
    // though an older real subject sits behind it -- #1136 fix-round, the
    // #132/#135 shape (a steward pass merges last and covers everything
    // before it in the same delta).
    const mixedStewardNewest: MainStatus = {
      headSha: "new3",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: ["docs(steward): reconcile (#381)", "fix(agent): real (#382)"],
    };
    r = dueJobs(JOBS, anchors, mergedAt + 25 * MIN, mixedStewardNewest);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([{ jobId: "steward", sha: "new3" }]);
    // Mixed cluster, REAL subject newest: fires once settled -- a steward
    // pass sitting behind a newer real merge cannot have reconciled it.
    const mixedRealNewest: MainStatus = {
      headSha: "new4",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: ["fix(agent): real (#382)", "docs(steward): reconcile (#381)"],
    };
    r = dueJobs(JOBS, anchors, mergedAt + 25 * MIN, mixedRealNewest);
    expect(firedIds(r)).not.toContain("steward"); // still settling
    expect(r.absorb).toEqual([]);
    expect(firedIds(dueJobs(JOBS, anchors, mergedAt + 60 * MIN, mixedRealNewest))).toContain("steward");
    // Unchanged sha: inert.
    const unchanged: MainStatus = { headSha: "old", headCommitAt: 0, newSubjectsSinceAnchor: [] };
    r = dueJobs(JOBS, anchors, mergedAt + 90 * MIN, unchanged);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([]);
  });

  // Catches: dropping the `subjects.length > 0` guard in due.ts — reading
  // `subjects[0]` on an EMPTY list silently absorbs a real sha delta
  // (rebase/force-push, git hiccup) and advances the anchor past a real
  // merge forever. A sha change with no subjects must FIRE, never absorb.
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
    const r = dueJobs(JOBS, anchors, mergedAt + 60 * MIN, emptyDelta);
    expect(firedIds(r)).toContain("steward");
    expect(r.absorb).toEqual([]);
  });

  // Catches (#1136): the ceremony firing a competing PR while a dispatched
  // steward pass is already open for this cluster -- the four-PRs-in-four-
  // days duplicate. stewardPrInFlight gates the fire; unset/false must
  // behave exactly as every test above (default firing), and true must
  // neither fire NOR absorb -- the anchor stays put so a later tick, once
  // the in-flight PR ages out of the standdown window, re-evaluates fresh.
  test("stewardPrInFlight: true suppresses firing without advancing the anchor", () => {
    const anchors = freshAnchors();
    anchors.steward.stewardAnchorSha = "old";
    const mergedAt = utc(18, 9, 0);
    const covered: MainStatus = {
      headSha: "new",
      headCommitAt: mergedAt,
      newSubjectsSinceAnchor: ["feat(agent): thing (#380)"],
      stewardPrInFlight: true,
    };
    // Past the settle window, but a steward PR already covers it: neither
    // fired nor absorbed.
    let r = dueJobs(JOBS, anchors, mergedAt + 60 * MIN, covered);
    expect(firedIds(r)).not.toContain("steward");
    expect(r.absorb).toEqual([]);
    expect(anchors.steward.stewardAnchorSha).toBe("old"); // untouched

    // Same delta, flag false: fires exactly as the un-gated test above does
    // -- proves the new field is additive, not a silent behavior change.
    const uncovered: MainStatus = { ...covered, stewardPrInFlight: false };
    r = dueJobs(JOBS, anchors, mergedAt + 60 * MIN, uncovered);
    expect(firedIds(r)).toContain("steward");
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
