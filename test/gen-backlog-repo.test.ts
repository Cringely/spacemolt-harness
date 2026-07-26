// #550 spanning test: gen-backlog.py's repo target vs the issues SSOT.
// gen-backlog.py silently regenerated docs/backlog.md from spacemolt-harness's
// own 3 leftover issues instead of the private spacemolt backlog (48 open at
// the time) because its `gh issue list` call carried no `--repo` and CWD
// inference resolved against whichever repo the script happened to run from.
// This is the SAME failure class src/scheduler/filing.ts:61 (FILING_REPO)
// already fixed once for the issue-filing path — two independent hardcoded
// "Cringely/spacemolt" string literals, nothing forcing them to agree if the
// repo ever moves again (docs/wiki/seam-manifest.md #13). Offline: reads
// source text only, no gh/network calls, mirrors the regex-on-source pattern
// in test/scheduler-briefs.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILING_REPO } from "../src/scheduler/filing";

const root = join(import.meta.dir, "..");
const genBacklogSrc = readFileSync(join(root, "scripts", "gen-backlog.py"), "utf8");

describe("gen-backlog.py repo target (#550)", () => {
  test("BACKLOG_REPO is pinned to the private issues SSOT", () => {
    const m = genBacklogSrc.match(/^BACKLOG_REPO = "([^"]+)"/m);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("Cringely/spacemolt");
  });

  // Catches: the exact #550 regression — dropping `--repo` (or the constant)
  // from the gh call reintroduces CWD-inferred repo resolution. Ablated: with
  // `--repo` removed from the subprocess.run args (matching #550's original
  // code), this assertion fails because BACKLOG_REPO no longer appears
  // immediately after `"list"`.
  test("the gh issue list call always passes --repo BACKLOG_REPO, never relies on CWD inference", () => {
    expect(genBacklogSrc).toMatch(
      /\["gh", "issue", "list", "--repo", BACKLOG_REPO, "--state", "all"/,
    );
  });

  // Catches: the two independent repo-pin copies (gen-backlog.py's
  // BACKLOG_REPO, filing.ts's FILING_REPO) drifting apart after a future repo
  // move updates one and not the other — the seam-manifest #13 pairing.
  test("BACKLOG_REPO agrees with filing.ts's FILING_REPO (same issues SSOT, two hand-pinned copies)", () => {
    const m = genBacklogSrc.match(/^BACKLOG_REPO = "([^"]+)"/m);
    expect(m![1]).toBe(FILING_REPO);
  });
});
