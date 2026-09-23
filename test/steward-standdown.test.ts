// #1136: the ceremony-vs-dispatched-pass duplicate-PR gate. Offline: an
// injected GhRunner, zero network, zero tokens. Mirrors the probeConsumerAction
// tests (test/scheduler-filing.test.ts) -- the same consumer-gate shape #94
// established, applied here to steward PRs instead of filed issues.
import { describe, expect, test } from "bun:test";
import type { GhRunner } from "../src/scheduler/filing";
import { STEWARD_PR_REPO, STEWARD_STANDDOWN_WINDOW_MS, stewardPrInFlight } from "../src/scheduler/steward-standdown";

const NOW = Date.UTC(2026, 8, 23, 12, 0);
const HOUR = 3_600_000;

function rowsGh(rows: Array<{ headRefName: string; createdAt: string }>, expectRepo = STEWARD_PR_REPO): GhRunner {
  return (args) => {
    expect(args).toContain("--repo");
    expect(args).toContain(expectRepo);
    expect(args).toContain("open");
    return { stdout: JSON.stringify(rows), exitCode: 0 };
  };
}

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("stewardPrInFlight (#1136)", () => {
  // Catches: probing without a wired ghRunner (most tick tests, and any host
  // mid-provisioning) treated as "something is in flight" -- it must instead
  // degrade to false so the ceremony keeps firing exactly as it did pre-fix.
  test("no ghRunner wired ⇒ false (the ceremony fires, unchanged)", () => {
    expect(stewardPrInFlight(undefined, NOW)).toBe(false);
  });

  // Catches: dropping the branch-prefix filter -- an open PR that just
  // happens to be open right now (a batch fix PR, a spec PR) must not
  // suppress the ceremony. Only a docs/steward-* head counts as evidence.
  test("an open PR whose branch is not docs/steward-* ⇒ false", () => {
    const gh = rowsGh([{ headRefName: "fix/some-bug-123", createdAt: ago(5 * 60_000) }]);
    expect(stewardPrInFlight(gh, NOW)).toBe(false);
  });

  // The core case: a fresh open docs/steward-* PR is exactly what #1136's
  // fix stands the ceremony down for.
  test("a fresh open docs/steward-* PR ⇒ true", () => {
    const gh = rowsGh([{ headRefName: "docs/steward-2026-09-23-wave", createdAt: ago(20 * 60_000) }]);
    expect(stewardPrInFlight(gh, NOW)).toBe(true);
  });

  // Catches: an unbounded "any open steward PR blocks firing" check -- this
  // is the exact pre-fix failure shape (#106 sat open eight days) turned
  // into the NEW bug the "notices its own inactivity" requirement names.
  // Just past the window: no longer counts.
  test("an open docs/steward-* PR older than the standdown window ⇒ false", () => {
    const gh = rowsGh([{ headRefName: "docs/steward-stale", createdAt: ago(STEWARD_STANDDOWN_WINDOW_MS + 60_000) }]);
    expect(stewardPrInFlight(gh, NOW)).toBe(false);
  });

  // The boundary itself: exactly at the window age still counts (age <= window).
  test("an open docs/steward-* PR exactly at the standdown window ⇒ true", () => {
    const gh = rowsGh([{ headRefName: "docs/steward-edge", createdAt: ago(STEWARD_STANDDOWN_WINDOW_MS) }]);
    expect(stewardPrInFlight(gh, NOW)).toBe(true);
  });

  // Catches: backward host-clock skew read as fresh evidence -- a
  // future-dated createdAt must not count as extra-fresh, mirroring
  // filing.ts's own consumer-probe guard against the same failure.
  test("a docs/steward-* PR created 1h in the future ⇒ false", () => {
    const gh = rowsGh([{ headRefName: "docs/steward-skewed", createdAt: new Date(NOW + HOUR).toISOString() }]);
    expect(stewardPrInFlight(gh, NOW)).toBe(false);
  });

  // Catches: a non-zero gh exit (auth failure, rate limit, network) read as
  // "nothing open" being trusted, when it is really "unknown" -- both must
  // fail toward firing (the safe direction), so this simply asserts false,
  // but the point is it never throws and never blocks the ceremony forever.
  test("gh exits non-zero ⇒ false, not a throw", () => {
    const gh: GhRunner = () => ({ stdout: "", exitCode: 1 });
    expect(stewardPrInFlight(gh, NOW)).toBe(false);
  });

  // Catches: an unparsable answer (truncated JSON, an HTML error page from a
  // proxy) crashing the tick instead of degrading like every other probe in
  // this module does.
  test("unparsable JSON ⇒ false, not a throw", () => {
    const gh: GhRunner = () => ({ stdout: "not json", exitCode: 0 });
    expect(stewardPrInFlight(gh, NOW)).toBe(false);
  });

  // Catches: a non-array answer (gh printing a single object instead of a
  // list on some error path) iterated as if it were rows.
  test("a JSON object instead of an array ⇒ false, not a throw", () => {
    const gh: GhRunner = () => ({ stdout: JSON.stringify({ number: 1 }), exitCode: 0 });
    expect(stewardPrInFlight(gh, NOW)).toBe(false);
  });

  // Multiple open PRs, only one of which is a fresh steward branch: the scan
  // must not stop at (or be confused by) an unrelated row.
  test("a mixed PR list finds the steward row regardless of position", () => {
    const gh = rowsGh([
      { headRefName: "fix/unrelated-1", createdAt: ago(10 * 60_000) },
      { headRefName: "docs/steward-2026-09-23", createdAt: ago(10 * 60_000) },
      { headRefName: "fix/unrelated-2", createdAt: ago(10 * 60_000) },
    ]);
    expect(stewardPrInFlight(gh, NOW)).toBe(true);
  });
});
