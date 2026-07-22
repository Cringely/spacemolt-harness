// Durable scheduler (#459): the HOST-SIDE tick bootstrap
// (scripts/scheduler-tick-bootstrap.sh) that un-strands the shared checkout from
// OUTSIDE it, so the fix's deployment path no longer runs through the broken
// state it repairs. The 32h outage (2026-07-19 -> 20): cron ran the wrapper from
// inside the checkout; a checkout stranded on a PR branch kept executing the OLD
// wrapper, whose `git pull --ff-only` aborted under `set -eu` before any
// self-heal (old OR the already-merged fix) could run.
//
// Like the refresh-checkout suite, these drive the REAL POSIX-sh scripts against
// REAL local git repos (a bare "origin" + a working checkout) -- no network, no
// auth, a local clone fast-forwards over a filesystem path. The checkout's
// scheduler-tick.sh is replaced with a STUB that prints a marker, so the exec
// handoff is observable without bun/secrets. Guarded with skipIf so a host
// lacking `sh`/`git` skips rather than fails.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOOTSTRAP = join(import.meta.dir, "..", "scripts", "scheduler-tick-bootstrap.sh");
const STALENESS = join(import.meta.dir, "..", "scripts", "scheduler-bootstrap-staleness.sh");
const HAVE_SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;

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

// Marker the stub wrapper prints; its presence in stdout proves the bootstrap
// reached the `exec sh .../scheduler-tick.sh` handoff.
const WRAPPER_MARKER = "STUB-WRAPPER-RAN";

/** Bare origin + a working checkout cloned from it, both on main. The origin's
 *  scripts/scheduler-tick.sh is a stub that prints WRAPPER_MARKER, so the
 *  bootstrap's handoff is observable. Returns paths, a runner, and helpers. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sched-bootstrap-"));
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  mkdirSync(origin, { recursive: true });
  git(origin, ["-c", "init.defaultBranch=main", "init", "--bare"]);
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["-c", "init.defaultBranch=main", "init"]);
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  // Stub wrapper committed on main -- checkout -f main + pull always restore it.
  writeFileSync(
    join(checkout, "scripts", "scheduler-tick.sh"),
    `#!/bin/sh\necho "${WRAPPER_MARKER} cwd=$(pwd)"\n`,
  );
  git(checkout, ["add", "scripts/scheduler-tick.sh"]);
  git(checkout, ["commit", "-m", "seed stub wrapper"]);
  git(checkout, ["branch", "-M", "main"]);
  git(checkout, ["remote", "add", "origin", origin]);
  git(checkout, ["push", "-u", "origin", "main"]);

  const envFile = join(root, "env");
  writeFileSync(envFile, `SCHEDULER_CHECKOUT=${toPosix(checkout)}\n`);

  const run = () => {
    const r = spawnSync("sh", [toPosix(BOOTSTRAP)], {
      encoding: "utf8",
      env: { ...process.env, SPACEMOLT_SCHED_ENV: toPosix(envFile) },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const branchOf = () => git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const headOf = () => git(checkout, ["rev-parse", "HEAD"]).stdout.trim();

  // Push a new commit to origin/main from a throwaway clone so the pull has a
  // real fast-forward target. Returns the new origin/main sha.
  const advanceOrigin = (): string => {
    const clone2 = join(root, "clone2");
    git(root, ["clone", origin, clone2]);
    commit(clone2, "upstream.txt", "upstream\n", "upstream advance");
    git(clone2, ["push", "origin", "main"]);
    return git(clone2, ["rev-parse", "HEAD"]).stdout.trim();
  };

  return { root, origin, checkout, envFile, run, branchOf, headOf, advanceOrigin };
}

describe.skipIf(!HAVE_SH || !HAVE_GIT)("scheduler host-side tick bootstrap (#459)", () => {
  // Catches: the bootstrap breaking the ordinary case -- on main it must pull,
  // stay on main, raise no false strand marker, and hand off to the wrapper.
  test("on main, clean: pulls, stays on main, hands off to the wrapper", () => {
    const f = fixture();
    const newSha = f.advanceOrigin();
    const r = f.run();
    expect(r.status).toBe(0);
    expect(f.branchOf()).toBe("main");
    expect(f.headOf()).toBe(newSha); // the pull fast-forwarded
    expect(r.stdout).toContain(WRAPPER_MARKER); // handoff reached
    expect(r.stderr).not.toContain("CHECKOUT-STRANDED");
  });

  // Catches THE outage (#459): a checkout stranded on a PR branch must be forced
  // back to main, fast-forwarded to the latest wrapper, and then handed off --
  // loudly (distinct marker), never aborting before the handoff. This is the
  // exact state the OLD in-checkout wrapper could not escape.
  test("stranded on a PR branch: forces main, pulls, then hands off (loudly)", () => {
    const f = fixture();
    git(f.checkout, ["checkout", "-b", "docs/steward-strand"]);
    commit(f.checkout, "steward.txt", "unpushed\n", "docs(steward): stranded work");
    expect(f.branchOf()).toBe("docs/steward-strand"); // precondition
    const newSha = f.advanceOrigin();

    const r = f.run();
    expect(r.status).toBe(0); // self-heal + handoff, NOT the old abort
    expect(f.branchOf()).toBe("main"); // un-stranded
    expect(f.headOf()).toBe(newSha); // and fast-forwarded to the newest wrapper
    expect(r.stderr).toContain("CHECKOUT-STRANDED"); // loudly, never silently
    expect(r.stdout).toContain(WRAPPER_MARKER); // handoff happened AFTER the heal
  });

  // Catches: a genuine non-fast-forward (upstream force-push / divergent local
  // main) must abort LOUDLY and refuse the handoff, never force-rewrite history
  // and never silently run a stale wrapper.
  test("genuine non-fast-forward: aborts loudly, does not hand off", () => {
    const f = fixture();
    f.advanceOrigin(); // origin main advances
    commit(f.checkout, "local.txt", "divergent\n", "divergent local commit"); // local main diverges
    const r = f.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("BOOTSTRAP-PULL-FAILED");
    expect(r.stdout).not.toContain(WRAPPER_MARKER); // no handoff on failure
    expect(f.branchOf()).toBe("main");
  });
});

/** Two files under a temp dir; a runner for the staleness check. */
function stalenessFixture() {
  const root = mkdtempSync(join(tmpdir(), "sched-stale-"));
  const repo = join(root, "repo-bootstrap.sh");
  const installed = join(root, "installed-bootstrap.sh");
  const run = (repoPath: string, installedPath: string) => {
    const r = spawnSync("sh", [toPosix(STALENESS), toPosix(repoPath), toPosix(installedPath)], {
      encoding: "utf8",
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { root, repo, installed, run };
}

describe.skipIf(!HAVE_SH)("scheduler bootstrap-staleness check (#459)", () => {
  // Catches: a false alarm on a correctly-installed bootstrap.
  test("identical copies: no drift warning, exits 0", () => {
    const f = stalenessFixture();
    writeFileSync(f.repo, "#!/bin/sh\necho hi\n");
    writeFileSync(f.installed, "#!/bin/sh\necho hi\n");
    const r = f.run(f.repo, f.installed);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("BOOTSTRAP-STALE");
  });

  // Catches THE drift the manual re-install can leave: installed copy behind the
  // repo copy must warn loudly (so the trap-one-level-up is visible) but never
  // abort -- the check is advisory.
  test("installed differs from repo: warns BOOTSTRAP-STALE, still exits 0", () => {
    const f = stalenessFixture();
    writeFileSync(f.repo, "#!/bin/sh\necho NEW\n");
    writeFileSync(f.installed, "#!/bin/sh\necho OLD\n");
    const r = f.run(f.repo, f.installed);
    expect(r.status).toBe(0); // advisory, never fatal
    expect(r.stderr).toContain("BOOTSTRAP-STALE");
  });

  // Catches: cron still pointing at the checkout copy (no install done at all).
  test("installed missing: warns BOOTSTRAP-MISSING, exits 0", () => {
    const f = stalenessFixture();
    writeFileSync(f.repo, "#!/bin/sh\necho hi\n");
    const r = f.run(f.repo, join(f.root, "does-not-exist.sh"));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("BOOTSTRAP-MISSING");
  });

  // Catches: the SCHEDULER_BOOTSTRAP override going dead. When $2 is omitted the
  // script must resolve the installed path from the env var (the manual-check
  // path, and the operator's documented non-default-install override). If the
  // env fallback is dropped it would silently compare against the ~/bin default
  // and miss a real drift. Invoked with $1 only, SCHEDULER_BOOTSTRAP in the env.
  test("no $2: honors SCHEDULER_BOOTSTRAP env for the installed path", () => {
    const f = stalenessFixture();
    writeFileSync(f.repo, "#!/bin/sh\necho NEW\n");
    writeFileSync(f.installed, "#!/bin/sh\necho OLD\n");
    const r = spawnSync("sh", [toPosix(STALENESS), toPosix(f.repo)], {
      encoding: "utf8",
      env: { ...process.env, SCHEDULER_BOOTSTRAP: toPosix(f.installed) },
    });
    expect(r.status ?? -1).toBe(0);
    expect(r.stderr ?? "").toContain("BOOTSTRAP-STALE"); // env-resolved path was compared
  });
});
