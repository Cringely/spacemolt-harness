// #558 part 2: a ceremony run that fails, times out, or increments
// failStreak must surface through the same channel a successful run uses —
// filing an issue — not only anchors.json and a run log nobody reads by
// default. Confirmed unfixed at c01a2ea: spawn.ts:332-344 bumps failStreak
// and spawn.ts:357-376 appends a run log, neither files anything; tick.ts's
// fire loop collects `{jobId, result}` and returns it to nobody;
// health.ts:65-70 prints `!! FAILING` only when an operator runs the probe
// (pull, not push). tick.ts calls fileFailureAlarm once per fired job, right
// after runJob's outcome and the fresh failStreak are known.
//
// Dedup, not a threshold, is what bounds volume here. The key is
// `scheduler-<jobId>-fail` — stable per job id, never per run, per
// timestamp, or per severity word, which is exactly the regeneration bug
// #635 root-caused for the 39-duplicate storm this backlog just cleaned up
// (largest cluster: 14 near-identical false BLOCKERs from a key minted
// fresh each run). A job that fails once, or fails daily for a month, files
// exactly ONE issue; every later failure lands as a comment on that same
// issue via fileFinding's own dedup path (filing.ts findDedupMatch +
// fileFinding's "bumped" branch).
//
// Filing on the FIRST failure — not gating behind a failStreak >= 2 (or
// breaker.ts's failStreakTrip = 3) threshold — is deliberate. #558's own
// motivating incident was `failStreak: 1`: one 45-minute council timeout,
// invisible for a full day until an unrelated audit found it. A threshold
// would leave that exact incident unsurfaced on its only occurrence, since
// it never got a second consecutive failure. The dedup key is what keeps a
// flaky job from becoming a duplicate storm; a threshold on top would only
// delay the alarm for zero volume benefit — a second primitive earning
// nothing, so it is not added.
import { canFile, loadGates } from "./gates";
import { fileFinding, type GhRunner } from "./filing";
import type { JobId } from "./state";

export interface FailureAlarmInput {
  jobId: JobId;
  cycleId: string;
  failStreak: number;
  timedOut: boolean;
  exitCode: number | null;
}

/** Stable per job id — the whole dedup guarantee lives in this NEVER varying per call. */
export function failureAlarmDedupKey(jobId: JobId): string {
  return `scheduler-${jobId}-fail`;
}

// Callers (tick.ts) wrap this in try/catch: a gh outage filing the alarm must
// never be allowed to abort the tick that is trying to report the ORIGINAL
// failure — same no-throw-out-of-the-fire-loop contract runJob already holds.
export function fileFailureAlarm(gh: GhRunner, stateDir: string, input: FailureAlarmInput): void {
  // Same D1 kill switch every other filing path honors (scripts/file-finding.ts
  // checks it before its one gh call) — a second caller of fileFinding that
  // skipped this check would keep filing after an operator turned filing off.
  if (!canFile(loadGates(stateDir))) return;
  const { jobId, cycleId, failStreak, timedOut, exitCode } = input;
  const body = [
    `Ceremony job \`${jobId}\` failed.`,
    "",
    `- cycleId: ${cycleId}`,
    `- failStreak: ${failStreak}`,
    `- timedOut: ${timedOut}`,
    `- exitCode: ${exitCode ?? "null"}`,
    "",
    "Filed by the scheduler's own failure alarm (#558 part 2) so a failing ceremony surfaces " +
      "the same way a successful one does, instead of only anchors.json and a run log an " +
      "operator has to go read.",
  ].join("\n");
  fileFinding(gh, stateDir, {
    jobId,
    cycleId,
    dedupKey: failureAlarmDedupKey(jobId),
    title: `scheduler: ${jobId} ceremony run failed`,
    body,
  });
}
