// #585: ephemeral per-job git worktrees. Unlike scheduler-tick.test.ts and
// scheduler-spawn.test.ts (which fake ALL git calls — they test runJob's/
// tick's own orchestration, not git itself), these tests run REAL git
// against a REAL temp repo, using a GitRunner shaped exactly like
// scripts/scheduler.ts's production one (spawnSync bound to a fixed cwd).
// That is deliberate: the core claim under test — "a job that commits
// without branching inside its worktree cannot diverge the shared
// checkout" — is a genuine git-semantics claim (detached HEAD, worktree
// isolation) that a string-matching fake cannot prove either way.
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "../src/scheduler/git";
import { createJobWorktree, reapStaleWorktrees, removeJobWorktree, worktreesRoot } from "../src/scheduler/worktree";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** The exact shape scripts/scheduler.ts wires in production: git bound to one fixed cwd. */
function realGit(cwd: string): GitRunner {
  return (args) => {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { stdout: res.stdout ?? "", exitCode: res.status ?? 1 };
  };
}

function run(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  // Two different failures wear the same exit code here. `res.error` is set
  // when the process never STARTED (git missing from PATH → ENOENT), and then
  // `stderr` is null — which the old one-liner rendered as "failed: null",
  // reading like a git error and sending diagnosis after the git command
  // instead of after the environment. That cost real time when CI turned out
  // to have no git at all (main red from PR #40, 2026-07-28).
  if (res.error) {
    throw new Error(`git ${args.join(" ")} could not be started (is git on PATH?): ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${res.status}): ${res.stderr || "<no stderr>"}`);
  }
}

/** A real one-commit repo on `main`, with a file the tests can diff. */
function makeRepo(): { checkoutDir: string; headSha: string } {
  const checkoutDir = tmp("worktree-repo-");
  run(checkoutDir, ["init", "-q", "-b", "main"]);
  run(checkoutDir, ["config", "user.email", "test@example.invalid"]);
  run(checkoutDir, ["config", "user.name", "Test"]);
  run(checkoutDir, ["config", "core.autocrlf", "false"]); // Windows CI: keep LF bytes exact for the content assertion below
  writeFileSync(join(checkoutDir, "tracked.txt"), "v1\n");
  run(checkoutDir, ["add", "tracked.txt"]);
  run(checkoutDir, ["commit", "-q", "-m", "initial"]);
  const headSha = realGit(checkoutDir)(["rev-parse", "HEAD"]).stdout.trim();
  return { checkoutDir, headSha };
}

describe("ephemeral worktree lifecycle (#585)", () => {
  test("createJobWorktree checks out the pinned commit into a fresh directory", () => {
    const { checkoutDir, headSha } = makeRepo();
    const stateDir = tmp("worktree-state-");
    const path = createJobWorktree(realGit(checkoutDir), stateDir, "job-1", headSha);
    expect(existsSync(join(path, "tracked.txt"))).toBe(true);
    expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("v1\n");
    // Detached, not on a branch — the property the "committed instead of
    // branched" scenario below depends on.
    expect(realGit(path)(["symbolic-ref", "-q", "HEAD"]).exitCode).not.toBe(0);
  });

  // THE core invariant (issue #585's whole point), and the ablation-worthy
  // test: a job that reproduces the ORIGINAL incident exactly — commits
  // directly instead of running `git checkout -b <name>` first — must not be
  // able to move the shared checkout's `main` ref. Matcher's blind spot this
  // guards against: comparing headSha strings with `toBe` is exact-equality,
  // not "close enough" — a diverged shared checkout fails loudly here, it
  // can't slip through as a near-match.
  //
  // Ablation performed: pointed the "job" at `checkoutDir` instead of the
  // ephemeral `worktreePath` (i.e. reproduced the PRE-#585 shared-checkout
  // dispatch). Result: `git -C checkoutDir rev-parse main` after the
  // "job" ran returned the NEW commit's sha, not headSha — the assertion
  // below went red exactly as expected:
  //   expect(received).toBe(expected)
  //   Expected: "<headSha>"
  //   Received: "<the job's new commit sha>"
  // Reverted to the real fix (job runs against worktreePath) before this
  // landed; see PR body for the literal diff used for the ablation.
  test("a job that commits without branching inside its worktree cannot diverge the shared checkout", () => {
    const { checkoutDir, headSha } = makeRepo();
    const stateDir = tmp("worktree-state-");
    const worktreePath = createJobWorktree(realGit(checkoutDir), stateDir, "steward-1", headSha);

    // Reproduce the #585 incident exactly: no `git checkout -b`, straight to
    // add+commit on whatever HEAD the worktree started on.
    writeFileSync(join(worktreePath, "tracked.txt"), "v2 — steward forgot to branch\n");
    run(worktreePath, ["add", "tracked.txt"]);
    run(worktreePath, ["commit", "-q", "-m", "docs(steward): reconcile (forgot to branch)"]);

    const worktreeHeadAfter = realGit(worktreePath)(["rev-parse", "HEAD"]).stdout.trim();
    expect(worktreeHeadAfter).not.toBe(headSha); // the job DID make a real commit

    // The invariant: the shared checkout's own main is untouched.
    const checkoutMainAfter = realGit(checkoutDir)(["rev-parse", "main"]).stdout.trim();
    expect(checkoutMainAfter).toBe(headSha);

    removeJobWorktree(realGit(checkoutDir), worktreePath);

    // Still untouched after cleanup — the dangling commit is discarded with
    // the worktree, not merged/rebased/preserved onto any shared ref.
    expect(realGit(checkoutDir)(["rev-parse", "main"]).stdout.trim()).toBe(headSha);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test("removeJobWorktree deletes the directory and clears git's worktree admin metadata", () => {
    const { checkoutDir, headSha } = makeRepo();
    const stateDir = tmp("worktree-state-");
    const git = realGit(checkoutDir);
    const path = createJobWorktree(git, stateDir, "job-2", headSha);
    expect(git(["worktree", "list", "--porcelain"]).stdout).toContain(path.replace(/\\/g, "/"));
    removeJobWorktree(git, path);
    expect(existsSync(path)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"]).stdout).not.toContain(path.replace(/\\/g, "/"));
  });

  // Ablation: removed the `for (const name of entries) removeJobWorktree(...)`
  // line from reapStaleWorktrees (returning 0 unconditionally). The assertion
  // `expect(existsSync(stray)).toBe(false)` below went red:
  //   expect(received).toBe(expected)
  //   Expected: false
  //   Received: true
  // Restored the loop before this landed.
  test("reapStaleWorktrees cleans up a worktree left behind by a crashed tick", () => {
    const { checkoutDir, headSha } = makeRepo();
    const stateDir = tmp("worktree-state-");
    const git = realGit(checkoutDir);
    const stray = createJobWorktree(git, stateDir, "crashed-run", headSha);
    expect(existsSync(stray)).toBe(true); // precondition: it really is there before reaping
    const reaped = reapStaleWorktrees(git, stateDir);
    expect(reaped).toBe(1);
    expect(existsSync(stray)).toBe(false);
    expect(readdirSync(worktreesRoot(stateDir))).toEqual([]);
  });

  test("reapStaleWorktrees on a never-used worktrees dir is a no-op, not a throw", () => {
    const { checkoutDir } = makeRepo();
    const stateDir = tmp("worktree-state-");
    expect(reapStaleWorktrees(realGit(checkoutDir), stateDir)).toBe(0);
  });
});
