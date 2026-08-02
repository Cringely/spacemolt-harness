// #654: the read-side counterpart to write-report.ts. Root defect this guards
// against — stand-up had no way to resolve $SCHEDULER_STATE_DIR into a real
// path, so every freshness check it attempted was DENIED, and the denial got
// reported as "council stalled" (a false P0, nine-plus times). These tests pin
// that a lookup through this script always returns one of two unambiguous
// outcomes — FOUND or the literal NO_MATCHING_REPORT_FOUND sentinel — never
// silence and never an error masquerading as "nothing there".
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegExp, NO_MATCH, pickNewest } from "../scripts/read-latest-report";

const SCRIPT = join(import.meta.dir, "..", "scripts", "read-latest-report.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "sched-report-read-"));

function run(args: string[], stateDir?: string) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.SCHEDULER_STATE_DIR;
  if (stateDir !== undefined) env.SCHEDULER_STATE_DIR = stateDir;
  const res = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT, ...args],
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

describe("pickNewest (pure planner)", () => {
  // Catches: picking the FIRST match (or an unsorted match) instead of the
  // newest — filenames are date-prefixed, so lexical max == chronological max.
  test("picks the lexically-newest of several matches", () => {
    const names = ["2026-07-13-council-review.md", "2026-07-31-council-review.md", "2026-07-20-council-review.md"];
    expect(pickNewest(names, "*-council-review.md")).toBe("2026-07-31-council-review.md");
  });

  // Catches: the glob wildcard failing to anchor, matching a filename that
  // only shares a substring (e.g. a strategy report) with the pattern.
  test("does not match a filename the glob only partially covers", () => {
    const names = ["2026-07-31-strategy-review.md"];
    expect(pickNewest(names, "*-council-review.md")).toBe(null);
  });

  test("empty input ⇒ null, not a throw", () => {
    expect(pickNewest([], "*-council-review.md")).toBe(null);
  });
});

describe("globToRegExp", () => {
  // Catches: a literal glob character (`.`) being treated as regex-any-char.
  // The second assertion changes ONLY the `.` to `X` — every other byte,
  // including the hyphen before "council", stays identical to the glob's
  // literal suffix — so an unescaped dot (matching any single character,
  // including "X") is the ONLY way this could wrongly return true. A prior
  // version of this test also swapped the leading hyphen for "X", which
  // broke the literal-prefix match on its own and made the assertion fail
  // regardless of whether the dot was escaped — it could not catch the bug
  // it claimed to guard (found in review, PR #66).
  test("escapes regex metacharacters outside the wildcard", () => {
    const re = globToRegExp("*-council-review.md");
    expect(re.test("2026-07-31-council-review.md")).toBe(true);
    expect(re.test("2026-07-31-council-reviewXmd")).toBe(false);
  });
});

describe("read-latest-report CLI (#654 evidence-gap fix)", () => {
  // Catches: FOUND not firing on a real match, or the mtime/body missing.
  test("happy path: single match ⇒ FOUND line + body, exit 0", () => {
    const stateDir = tmp();
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    writeFileSync(join(stateDir, "reports", "2026-07-31-council-review.md"), "## Triage\n\n#1 — outranks\n");
    const res = run(["--glob", "*-council-review.md"], stateDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^FOUND 2026-07-31-council-review\.md mtime=/);
    expect(res.stdout).toContain("## Triage");
    expect(res.stdout).toContain("#1 — outranks");
  });

  // Catches: the exact defect #654 root-caused — an absent/undiscoverable
  // report degrading to blank stdout, which a reader (or an LLM) can mistake
  // for "the command was silently denied" rather than "genuinely nothing here".
  test("no matching report, and no reports/ dir at all ⇒ NO_MATCHING_REPORT_FOUND sentinel, exit 0", () => {
    const stateDir = tmp(); // reports/ never created
    const res = run(["--glob", "*-council-review.md"], stateDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(NO_MATCH);
  });

  test("reports/ exists but nothing matches the glob ⇒ same sentinel", () => {
    const stateDir = tmp();
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    writeFileSync(join(stateDir, "reports", "2026-07-31-strategy-review.md"), "unrelated");
    const res = run(["--glob", "*-council-review.md"], stateDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(NO_MATCH);
  });

  // Catches: a `--glob` crafted with `/` or `..` reaching outside reports/
  // into a sibling state-dir directory (secrets/, logs/) — the untrusted-input
  // boundary this script's whole jail exists to hold (spec §Security).
  test("--glob outside the safe character set ⇒ exit 2, nothing read", () => {
    const stateDir = tmp();
    mkdirSync(join(stateDir, "secrets"), { recursive: true });
    writeFileSync(join(stateDir, "secrets", "gh_pat_readcomment"), "SENTINEL-TOKEN");
    const res = run(["--glob", "../secrets/*"], stateDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage");
    expect(res.stdout).not.toContain("SENTINEL-TOKEN");
  });

  // Catches: a bare workstation invocation reading a phantom jail — same
  // refusal posture as write-report.ts and scheduler.ts.
  test("SCHEDULER_STATE_DIR unset ⇒ exit 2, no output", () => {
    const res = run(["--glob", "*-council-review.md"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("SCHEDULER_STATE_DIR");
    expect(res.stdout).toBe("");
  });

  test("missing --glob ⇒ exit 2 with usage", () => {
    const stateDir = tmp();
    const res = run([], stateDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage");
  });

  // Catches: following a symlink planted inside reports/ and leaking a file
  // from elsewhere on the host — defense in depth (write-report.ts already
  // refuses to CREATE one there; this proves reading one back is refused too).
  test("a symlinked entry inside reports/ is excluded, never followed", () => {
    const stateDir = tmp();
    const outsideDir = tmp();
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    writeFileSync(join(outsideDir, "secret.md"), "HOST SECRET CONTENT");
    try {
      symlinkSync(join(outsideDir, "secret.md"), join(stateDir, "reports", "2026-07-31-council-review.md"));
    } catch {
      return; // no symlink privilege on this host (Windows non-admin); logic still runs on the Linux host
    }
    const res = run(["--glob", "*-council-review.md"], stateDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(NO_MATCH);
    expect(res.stdout).not.toContain("HOST SECRET CONTENT");
  });

  // Catches: #654's exact defect rebuilt inside its own fix — a genuine I/O
  // failure reading the target (not "nothing matched") collapsing into
  // NO_MATCHING_REPORT_FOUND, which is indistinguishable from an empty
  // reports/ dir and would recreate "denied read looks like nothing there".
  // Portable across platforms (no chmod/icacls, no admin privilege needed):
  // a directory whose name matches the glob passes the symlink filter (it's
  // a real directory, not a link) and is picked as "newest", so the actual
  // open+read in production code hits a real EISDIR — the same code path an
  // EACCES/EPERM permission denial would hit, just a portable trigger for it.
  test("target exists but can't be read as a file ⇒ REPORT_READ_FAILED sentinel, not NO_MATCH", () => {
    const stateDir = tmp();
    mkdirSync(join(stateDir, "reports", "2026-07-31-council-review.md"), { recursive: true });
    const res = run(["--glob", "*-council-review.md"], stateDir);
    expect(res.exitCode).toBe(1);
    expect(res.stdout.trim()).toBe("REPORT_READ_FAILED EISDIR 2026-07-31-council-review.md");
    expect(res.stdout).not.toContain(NO_MATCH);
  });

  test("reports/ directory presence alone does not create false negatives: newest of three wins", () => {
    const stateDir = tmp();
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    for (const day of ["2026-07-13", "2026-07-20", "2026-07-31"]) {
      writeFileSync(join(stateDir, "reports", `${day}-council-review.md`), `body-${day}`);
    }
    const res = run(["--glob", "*-council-review.md"], stateDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^FOUND 2026-07-31-council-review\.md/);
    expect(res.stdout).toContain("body-2026-07-31");
    expect(existsSync(join(stateDir, "reports"))).toBe(true);
  });
});
