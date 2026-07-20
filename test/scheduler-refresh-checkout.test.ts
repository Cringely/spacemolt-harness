// Durable scheduler (#114 / #413): the checkout self-heal
// (scripts/scheduler-refresh-checkout.sh) that keeps a stranded shared checkout
// from silently killing every tick. The 2026-07-19 outage: a headless steward
// branched+committed the shared `~/checkout`, could not push, and left HEAD on
// a local branch; the tick wrapper's `git pull --ff-only` then aborted under
// `set -e` and every later tick died before reaching the scheduler.
//
// These tests drive the REAL POSIX-sh script end to end against REAL local git
// repos (a bare "origin" + a working checkout), so no network and no auth: a
// local clone fast-forwards over a filesystem path. Guarded with skipIf so a
// host without `sh` or `git` skips rather than fails.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "scheduler-refresh-checkout.sh");
const HAVE_SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;

// sh gets POSIX paths; git/Node keep native ones. On Linux CI/Docker cygpath is
// absent and paths are already POSIX, so this is identity.
function toPosix(p: string): string {
  if (process.platform !== "win32") return p;
  const r = spawnSync("cygpath", ["-u", p], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : p;
}

function git(cwd: string, args: string[]) {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=", ...args],
    { cwd, encoding: "utf8" },
  );
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function commit(cwd: string, file: string, body: string, msg: string) {
  writeFileSync(join(cwd, file), body);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", msg]);
}

/** A bare origin + a working checkout cloned from it, both on main with one
 *  commit. Returns paths and a runner that invokes the real refresh script. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sched-refresh-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  mkdirSync(origin, { recursive: true });
  git(origin, ["-c", "init.defaultBranch=main", "init", "--bare"]);
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["-c", "init.defaultBranch=main", "init"]);
  commit(checkout, "seed.txt", "seed\n", "seed");
  git(checkout, ["branch", "-M", "main"]);
  // Native path for the remote: the same git.exe reads it from config whether
  // invoked directly here or from inside the sh script, so keep it native (a
  // posix /c/... URL is what native git can't resolve).
  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "-u", "origin", "main"]);

  const run = () => {
    const r = spawnSync("sh", [toPosix(SCRIPT), toPosix(checkout)], { encoding: "utf8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const branchOf = () => git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const headOf = () => git(checkout, ["rev-parse", "HEAD"]).stdout.trim();

  /** Push a new commit to origin/main from a throwaway second clone, so the
   *  checkout's `git pull` has something real to fast-forward to. Returns the
   *  new origin/main sha. */
  const advanceOrigin = (): string => {
    const clone2 = join(root, "clone2");
    git(root, ["clone", origin, clone2]);
    commit(clone2, "upstream.txt", "upstream\n", "upstream advance");
    git(clone2, ["push", "origin", "main"]);
    return git(clone2, ["rev-parse", "HEAD"]).stdout.trim();
  };

  return { root, origin, checkout, run, branchOf, headOf, advanceOrigin };
}

describe.skipIf(!HAVE_SH || !HAVE_GIT)("scheduler checkout self-heal (#413)", () => {
  // Catches: the guard breaking the ordinary case — on main, it must simply
  // pull and leave the checkout on main, with no false stranded marker.
  test("on main, clean: pulls and stays on main, no strand marker", () => {
    const f = fixture();
    const newSha = f.advanceOrigin();
    const r = f.run();
    expect(r.status).toBe(0);
    expect(f.branchOf()).toBe("main");
    expect(f.headOf()).toBe(newSha); // the pull actually fast-forwarded
    expect(r.stderr).not.toContain("CHECKOUT-STRANDED");
  });

  // Catches THE outage (#413): a stranded local branch must self-heal to main
  // and still fast-forward, loudly (distinct marker), never abort the tick.
  test("stranded on a local branch: recovers to main, pulls, logs the strand", () => {
    const f = fixture();
    // Simulate the headless steward: branch the shared checkout and commit,
    // leaving HEAD on a local branch it never pushed.
    git(f.checkout, ["checkout", "-b", "docs/steward-strand"]);
    commit(f.checkout, "steward.txt", "unpushed\n", "docs(steward): stranded work");
    expect(f.branchOf()).toBe("docs/steward-strand"); // precondition
    const newSha = f.advanceOrigin();

    const r = f.run();
    expect(r.status).toBe(0); // self-heal, NOT the old abort
    expect(f.branchOf()).toBe("main"); // recovered
    expect(f.headOf()).toBe(newSha); // and still pulled latest
    expect(r.stderr).toContain("CHECKOUT-STRANDED"); // loudly, never silently
  });

  // Catches: a "fix" that force-heals a GENUINE non-fast-forward (upstream
  // force-push) and silently discards it. --ff-only must still abort loudly.
  test("genuine non-fast-forward on main: aborts loudly, does not force", () => {
    const f = fixture();
    f.advanceOrigin(); // origin main = seed -> upstream
    // Local main diverges: a different commit on the same base ⇒ not a ff.
    commit(f.checkout, "local.txt", "divergent\n", "divergent local commit");
    const r = f.run();
    expect(r.status).not.toBe(0); // loud abort preserved (the original invariant)
    expect(f.branchOf()).toBe("main");
  });
});
