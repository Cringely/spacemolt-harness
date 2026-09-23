// #1136: the scheduler's own "steward" ceremony (src/scheduler/jobs.ts,
// main-merge schedule) and the PM's manually-dispatched doc-steward pass
// (AGENTS.md's unconditional post-merge-cluster gate) both reconcile the SAME
// living docs against the SAME merges, with nothing coordinating them. Four
// PRs closed as superseded in four days (#106/#110/#111 -> #117, #125 -> #126,
// #130/#134 -> #135) -- every one of them the ceremony's own PR, since the
// dispatched pass always wins on content (it carries facts the ceremony
// cannot produce: production capture, review reasoning, which of several
// issues is canonical).
//
// This is the SAME consumer-gate shape PR #94 used for a sibling duplicate-
// producer problem (filing.ts's probeConsumerAction: check for a live
// consumer before producing a competing artifact, rather than trying to make
// the producer smarter). Here the "consumer" is a reconciliation already in
// flight: before the ceremony opens a competing PR, it checks whether one is
// already open.
import type { GhRunner } from "./filing";

// The public code repo the steward job's docs-only PRs land against --
// distinct from filing.ts's FILING_REPO (the PRIVATE backlog tracker; steward
// PRs are code-repo docs changes, never backlog issues).
export const STEWARD_PR_REPO = "Cringely/spacemolt-harness";

// How long an open docs/steward-* PR counts as "someone is already
// reconciling this" before the ceremony treats it as abandoned and fires
// anyway. Bounded ON PURPOSE: an unbounded "any open steward PR blocks
// firing" check would let a PR nobody ever merges or closes -- the exact
// pre-fix failure, #106 sat open eight days before #117 superseded it --
// suppress the ceremony forever, which is the "notices its own inactivity"
// requirement #1136 names (the same shape #1049 names for a sibling
// ceremony: a gate that cannot tell nothing-to-do from doing-nothing). 24h
// comfortably covers every observed PM turnaround (2-17 minutes from a
// cluster's last merge to the dispatched PR's creation, replayed against
// the three #1136 pairs during the fix round) while staying far short of
// the week-long horizon the issue's own done-when measures against, so a
// genuinely-stalled PM cannot wedge the ceremony off for longer than a day.
export const STEWARD_STANDDOWN_WINDOW_MS = 24 * 3_600_000;

/**
 * True when an open, same-repository PR on STEWARD_PR_REPO has a
 * `docs/steward-` head branch created within STEWARD_STANDDOWN_WINDOW_MS of
 * `now`. Degrades to false (the ceremony fires) on ANY missing or
 * unreadable signal -- no gh runner wired, the call failing, or unparsable
 * JSON -- the same direction due.ts's own settle-window comment already
 * argues: a spare reconciliation pass is cheap, a ceremony that silently
 * stands down forever on bad information is not.
 *
 * #1136 fix-round: `gh pr list` on a public repo includes PRs opened from
 * forks, and headRefName is the FORK's own branch name -- so anyone could
 * open a `docs/steward-*` branch PR from a fork and stand this ceremony
 * down for a day, repeatably. isCrossRepository marks exactly that case.
 * Skipping it keeps the probe scoped to PRs this repo's own contributors
 * (the PM's dispatched pass, or the ceremony's own prior attempt) opened.
 */
export function stewardPrInFlight(gh: GhRunner | undefined, now: number): boolean {
  if (!gh) return false;
  const res = gh([
    "pr",
    "list",
    "--repo",
    STEWARD_PR_REPO,
    "--state",
    "open",
    "--json",
    "headRefName,createdAt,isCrossRepository",
    "--limit",
    "20",
  ]);
  if (res.exitCode !== 0) return false;
  let rows: unknown;
  try {
    rows = JSON.parse(res.stdout);
  } catch {
    return false;
  }
  if (!Array.isArray(rows)) return false;
  for (const row of rows as Array<{ headRefName?: unknown; createdAt?: unknown; isCrossRepository?: unknown }>) {
    if (typeof row?.headRefName !== "string" || !row.headRefName.startsWith("docs/steward-")) continue;
    if (row.isCrossRepository !== false) continue; // only an explicit same-repo row counts; missing/true both fall back to firing
    const t = Date.parse(typeof row?.createdAt === "string" ? row.createdAt : "");
    // age >= 0 guards backward host-clock skew the same way filing.ts's own
    // consumer probe does: a future-dated createdAt reads as NOT fresh,
    // never as extra-fresh evidence of an in-flight PR.
    const age = now - t;
    if (Number.isFinite(t) && age >= 0 && age <= STEWARD_STANDDOWN_WINDOW_MS) return true;
  }
  return false;
}
