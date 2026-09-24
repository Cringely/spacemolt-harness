// Offline guards on .githooks/ — the directory git actually reads here.
//
// WHY THIS FILE EXISTS
// Two silent-inertness failures, both of which leave a security gate present,
// committed, and never executed. Neither shows up in a diff, a test run, or a
// code review, because the hook's own content is correct.
//
//   1. MODE. A hook without an exec bit is never run by git, with no error.
//      Windows checkouts flatten it through `git add` — .githooks/commit-msg
//      was first staged 100644 here for exactly that reason.
//
//   2. CHAIN TARGET. git reads hooks from exactly one directory, and this repo
//      points core.hooksPath at .githooks. agent-harness-core installs its own
//      hooks under .claude/hooks/, so each reaches git only through a shim here
//      that invokes it by path. A rename on the core side turns that
//      `[ -f ... ] || exit 0` guard into a silent no-op: the shim keeps exiting
//      0 and the gate stops existing. The chained gates are the AI-attribution
//      refusal and the identity sweep over the outgoing push range, so failing
//      closed on a missing target is the point.
//
// WHY TWO MODE INSTRUMENTS
// Neither one answers everywhere, and the first draft of this file assumed the
// git index did. It does not:
//   - On Windows the working tree is the unreliable half. `statSync` reports an
//     exec bit that says nothing about what was committed, so only the index
//     catches a flattened mode. The index is authoritative there.
//   - In CI the index is the unreliable half. `git ls-files` exits 128 inside
//     the test container (ownership rules), and the production image carries
//     .githooks with no .git at all, so git cannot answer. The filesystem mode
//     is real there, because the checkout set it from the index.
// So: prefer the index, fall back to the filesystem, and return null when
// NEITHER answered rather than quietly passing. A guard that cannot say which
// instrument it used is the failure it exists to catch.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOOK_DIR = join(ROOT, ".githooks");

/**
 * Verdict on one hook's executability.
 *
 * `indexMode` is a six-digit git mode string, or null when git could not
 * answer. `fsMode` is a `statSync().mode`, or null when the file is absent.
 * Returns null when neither instrument produced a reading — the caller must
 * treat that as a failure, not as a pass.
 */
export function hookExecutable(
  indexMode: string | null,
  fsMode: number | null,
): boolean | null {
  if (indexMode !== null) return indexMode === "100755";
  if (fsMode !== null) return (fsMode & 0o111) !== 0;
  return null;
}

/** Index modes by basename, or null when git cannot answer here. */
function stagedModes(): Map<string, string> | null {
  const out = spawnSync("git", ["ls-files", "-s", ".githooks"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  // 128 is git's fatal: no repository, or dubious ownership in a container.
  if (out.status !== 0 || !out.stdout.trim()) return null;
  const modes = new Map<string, string>();
  for (const line of out.stdout.split("\n")) {
    // "<mode> <oid> <stage>\t<path>" — tab before the path.
    const m = /^(\d{6}) \S+ \d+\t(.+)$/.exec(line.trim());
    const [, mode, path] = m ?? [];
    if (mode && path) modes.set(path.split("/").pop()!, mode);
  }
  return modes.size > 0 ? modes : null;
}

function fsMode(hook: string): number | null {
  try {
    return statSync(join(HOOK_DIR, hook)).mode;
  } catch {
    return null;
  }
}

describe("hookExecutable — instrument selection", () => {
  // Unit-tested because the integration tests below can only exercise whichever
  // instrument the current host happens to offer. These cover both, and the
  // both-absent case that must never read as a pass.
  test("prefers the index when git answers", () => {
    expect(hookExecutable("100755", 0o100644)).toBe(true);
    expect(hookExecutable("100644", 0o100755)).toBe(false);
  });

  test("falls back to the filesystem when git cannot answer", () => {
    expect(hookExecutable(null, 0o100755)).toBe(true);
    expect(hookExecutable(null, 0o100644)).toBe(false);
  });

  test("returns null when neither instrument answered", () => {
    expect(hookExecutable(null, null)).toBeNull();
  });
});

describe(".githooks wiring", () => {
  const hooks = readdirSync(HOOK_DIR);

  test("the hook directory is not empty", () => {
    // Guards the per-hook tests below: `test.each([])` registers nothing and
    // the file would pass having asserted nothing about any hook.
    expect(hooks.length).toBeGreaterThan(0);
  });

  test.each(hooks)("%s is executable", (hook) => {
    const modes = stagedModes();
    // Per hook, not per run: git may answer for the directory yet not list
    // THIS file (untracked, gitignored, `git rm --cached`), in which case the
    // verdict falls to the filesystem for this hook alone. That is the right
    // answer to the question actually being asked -- will git execute it --
    // since an untracked hook with a real exec bit does run.
    const verdict = hookExecutable(modes?.get(hook) ?? null, fsMode(hook));
    // null means no instrument could read this hook's mode. Failing here is
    // correct: an unreadable mode is indistinguishable from a bad one, and
    // git skips a non-executable hook without saying so.
    expect(verdict).toBe(true);
  });

  test("every chained core hook exists at the path its shim invokes", () => {
    // Read the shims rather than hard-coding pairs, so a NEW shim is covered
    // the day it is added instead of the day someone remembers.
    const missing: string[] = [];
    let chained = 0;
    for (const hook of hooks) {
      const body = readFileSync(join(HOOK_DIR, hook), "utf8");
      // Unanchored on purpose. Requiring a preceding space or line start
      // narrows this to the bare form today's three shims happen to use, and
      // misses every other realistic one: double-quoted, single-quoted,
      // $CLAUDE_PROJECT_DIR-prefixed, ./-prefixed, or assigned to a variable.
      // A future shim written with quotes would pass this test while its chain
      // went unchecked, which is the failure this test exists to catch.
      for (const m of body.matchAll(/\.claude\/hooks\/[\w.-]+/g)) {
        // Comments name these paths too. Both a mention and an invocation must
        // resolve: a comment citing a path that no longer exists is itself the
        // stale-documentation half of the same drift.
        const target = m[0];
        chained++;
        if (!existsSync(join(ROOT, target))) missing.push(`${hook} -> ${target}`);
      }
    }
    expect(chained).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

// --- end to end: a rejection from the chained hook must reach git ----------
//
// The tests above prove the shims exist, are executable, and name a target
// that exists. None of them run the shim, so none would have caught the real
// gap: `.githooks/pre-commit` called `sh .claude/hooks/pre-commit` and never
// looked at its exit status. `.claude/hooks/pre-commit`'s identity gate is
// real, not advisory -- it can and does `exit 1` -- but this shim discarded
// that and moved on to the D3 policy-path fence regardless, so a refusal
// from the chained hook never reached git. Fixed with `|| exit 1` on the
// chained call. These three describe blocks run each shim for real, against
// an isolated temp git repo, and pin both a refusal reaching exit 1 and a
// pass staying exit 0.

const shPath = Bun.which("sh");
const gitOk = (() => {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
})();
// git-for-windows runs hooks through its own bundled sh, so a PATH probe for
// `sh` proves nothing on win32 — same reasoning as test/policy-path-gate.test.ts.
const shOk =
  process.platform === "win32"
    ? true
    : (() => {
        try {
          return spawnSync("sh", ["-c", "exit 0"]).status === 0;
        } catch {
          return false;
        }
      })();

function runShim(
  scriptPath: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
) {
  return spawnSync(shPath ?? "sh", [scriptPath.replaceAll("\\", "/"), ...args], {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    encoding: "utf8",
  });
}

/** Isolated temp git repo: no global hooksPath/gpgsign/templateDir leaking in. */
function makeRepo(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const emptyCfg = join(dir, "empty-gitconfig");
  writeFileSync(emptyCfg, "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_SYSTEM: emptyCfg };
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  return { dir, env, git };
}

/** Copy a real hook (shim or chained target) into a fixture repo, executable. */
function installHook(destDir: string, relPath: string, content: string) {
  const dest = join(destDir, relPath);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, content);
  chmodSync(dest, 0o755);
  return dest;
}

describe.skipIf(!gitOk || !shOk)(".githooks/pre-commit propagates the chained hook's exit code", () => {
  // The chained hook is stubbed so this test is about THIS shim's control
  // flow, not identity-patterns.sh's own missing-file/broken-file behavior
  // (covered separately by identity-patterns.sh's own design, not by this
  // file). scripts/policy-path-gate.ts is stubbed to always exit 0, so the
  // only way the overall run can be non-zero is the propagation under test —
  // before the fix, this red-cases test passed a chained exit 1 straight
  // through to a shim exit 0.
  const setup = (chainedExit: 0 | 1) => {
    const { dir, env } = makeRepo("pre-commit-chain-");
    installHook(
      dir,
      ".claude/hooks/pre-commit",
      `#!/bin/sh\necho "stub core pre-commit: exit ${chainedExit}" >&2\nexit ${chainedExit}\n`,
    );
    writeFileSync(
      (() => {
        mkdirSync(join(dir, "scripts"), { recursive: true });
        return join(dir, "scripts", "policy-path-gate.ts");
      })(),
      "process.exit(0);\n",
    );
    const shimPath = installHook(dir, ".githooks/pre-commit", readFileSync(join(ROOT, ".githooks", "pre-commit"), "utf8"));
    return { dir, env, shimPath };
  };

  test("chained core hook refuses (exit 1): the shim must also refuse, not fall through to the D3 fence", () => {
    const { dir, env, shimPath } = setup(1);
    const r = runShim(shimPath, [], { cwd: dir, env });
    expect(r.stderr).toContain("stub core pre-commit: exit 1");
    expect(r.status).toBe(1);
  });

  test("chained core hook passes (exit 0): the shim still runs the D3 fence normally", () => {
    const { dir, env, shimPath } = setup(0);
    const r = runShim(shimPath, [], { cwd: dir, env });
    expect(r.status).toBe(0);
  });
});

describe.skipIf(!gitOk || !shOk)(".githooks/commit-msg chains the AI-attribution refusal", () => {
  const setup = () => {
    const { dir, env } = makeRepo("commit-msg-chain-");
    installHook(
      dir,
      ".claude/hooks/commit-msg",
      readFileSync(join(ROOT, ".claude", "hooks", "commit-msg"), "utf8"),
    );
    const shimPath = installHook(dir, ".githooks/commit-msg", readFileSync(join(ROOT, ".githooks", "commit-msg"), "utf8"));
    return { dir, env, shimPath };
  };

  test("a message carrying a Co-Authored-By trailer naming Claude is refused", () => {
    const { dir, env, shimPath } = setup();
    const msgFile = join(dir, "MSG");
    writeFileSync(msgFile, "chore: test\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
    const r = runShim(shimPath, [msgFile.replaceAll("\\", "/")], { cwd: dir, env });
    expect(r.stderr).toContain("Co-Authored-By");
    expect(r.status).toBe(1);
  });

  test("a clean message passes", () => {
    const { dir, env, shimPath } = setup();
    const msgFile = join(dir, "MSG");
    writeFileSync(msgFile, "chore: test\n");
    const r = runShim(shimPath, [msgFile.replaceAll("\\", "/")], { cwd: dir, env });
    expect(r.status).toBe(0);
  });
});

describe.skipIf(!gitOk || !shOk)(
  ".githooks/pre-push chains the identity sweep and keeps the main-branch block",
  () => {
    const setup = () => {
      const { dir, env, git } = makeRepo("pre-push-chain-");
      installHook(
        dir,
        ".claude/hooks/pre-push",
        readFileSync(join(ROOT, ".claude", "hooks", "pre-push"), "utf8"),
      );
      installHook(
        dir,
        ".claude/hooks/identity-patterns.sh",
        readFileSync(join(ROOT, ".claude", "hooks", "identity-patterns.sh"), "utf8"),
      );
      const shimPath = installHook(dir, ".githooks/pre-push", readFileSync(join(ROOT, ".githooks", "pre-push"), "utf8"));
      writeFileSync(join(dir, "README.md"), "seed\n");
      git("add", "-A");
      git("commit", "-q", "-m", "seed");
      const head = git("rev-parse", "HEAD").stdout.trim();
      return { dir, env, shimPath, head };
    };

    // Both tests spawn the real identity-patterns.sh sweep, which the fixture
    // isolates from this workstation's own git config (GIT_CONFIG_GLOBAL/
    // SYSTEM point at an empty file, same as makeRepo elsewhere in this
    // file). Measured on Windows: that isolation alone costs 9-14s here,
    // independent of range size — every one of the dozen-plus git/grep
    // subprocesses this sweep spawns pays Windows process-spawn overhead
    // (antivirus real-time scanning is the usual cause), and losing the
    // workstation's config loses whatever locally tuned it away. Real HEAD
    // as both local and remote oid keeps the RANGE itself empty (HEAD..HEAD)
    // so only that fixed per-process cost is paid, not a scan of any actual
    // content — bun's 5s default test timeout is well under it regardless.
    test(
      "a ref line pushing to refs/heads/main is blocked",
      () => {
        const { dir, env, shimPath, head } = setup();
        const refLine = `refs/heads/work ${head} refs/heads/main ${head}\n`;
        const r = runShim(shimPath, ["origin", "https://example.invalid"], { cwd: dir, env, input: refLine });
        expect(r.stderr).toContain("direct push to main blocked");
        expect(r.status).toBe(1);
      },
      20000,
    );

    test(
      "a ref line pushing to a non-main branch passes",
      () => {
        const { dir, env, shimPath, head } = setup();
        const refLine = `refs/heads/work ${head} refs/heads/work ${head}\n`;
        const r = runShim(shimPath, ["origin", "https://example.invalid"], { cwd: dir, env, input: refLine });
        expect(r.status).toBe(0);
      },
      20000,
    );
  },
);
