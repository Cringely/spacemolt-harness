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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
      for (const m of body.matchAll(/(?:^|\s)(\.claude\/hooks\/[\w.-]+)/g)) {
        // Comments name these paths too. Both a mention and an invocation must
        // resolve: a comment citing a path that no longer exists is itself the
        // stale-documentation half of the same drift.
        const target = m[1];
        if (!target) continue;
        chained++;
        if (!existsSync(join(ROOT, target))) missing.push(`${hook} -> ${target}`);
      }
    }
    expect(chained).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
