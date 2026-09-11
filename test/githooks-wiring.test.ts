// Offline guards on .githooks/ — the directory git actually reads here.
//
// WHY THIS FILE EXISTS
// Two silent-inertness failures, both of which leave a security gate present,
// committed, and never executed. Neither shows up in a diff, a test run, or
// a code review, because the hook's own content is correct.
//
//   1. MODE. A hook staged 100644 is never run by git. Windows checkouts
//      flatten the exec bit through `git add` (see the identical fix applied
//      to .githooks/commit-msg, staged 644 on first write), so the mode has
//      to be pinned in the INDEX, not read off the working tree — the
//      working tree can report 755 on a file the index holds at 644.
//
//   2. CHAIN TARGET. git reads hooks from exactly one directory, and this
//      repo points core.hooksPath at .githooks. agent-harness-core installs
//      its own hooks under .claude/hooks/, so each one reaches git only
//      through a shim here that invokes it by path. A rename or removal on
//      the core side turns that `[ -f ... ] || exit 0` guard into a silent
//      no-op: the shim keeps exiting 0 and the gate stops existing. The
//      chained gates are the AI-attribution refusal and the identity sweep
//      over the outgoing push range — both enforce standing operator
//      mandates, so failing closed on a missing target is the point.
//
// Ablated: chmod the index entry back to 100644 and the mode test goes red;
// rename .claude/hooks/commit-msg and the chain test goes red naming it.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOOK_DIR = join(ROOT, ".githooks");

/** Index modes, keyed by basename. The index is authoritative: a working-tree
 *  stat can read 755 on Windows for a file committed at 644. */
function stagedModes(): Map<string, string> {
  const out = spawnSync("git", ["ls-files", "-s", ".githooks"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(out.status).toBe(0);
  const modes = new Map<string, string>();
  for (const line of out.stdout.split("\n")) {
    // "<mode> <oid> <stage>\t<path>" — tab before the path, spaces before it.
    const m = /^(\d{6}) \S+ \d+\t(.+)$/.exec(line.trim());
    const [, mode, path] = m ?? [];
    if (mode && path) modes.set(path.split("/").pop()!, mode);
  }
  return modes;
}

describe(".githooks wiring", () => {
  const hooks = readdirSync(HOOK_DIR);

  test("every hook is present in the index", () => {
    // Guards the whole file: an empty or partial `git ls-files` would make
    // the mode test below vacuous by iterating nothing.
    const modes = stagedModes();
    expect([...modes.keys()].sort()).toEqual([...hooks].sort());
  });

  test.each(hooks)("%s is staged executable", (hook) => {
    // 100644 here means git skips the hook entirely and the push or commit
    // proceeds ungated — the exact shape of the bug this pins.
    expect(stagedModes().get(hook)).toBe("100755");
  });

  test("every chained core hook exists at the path its shim invokes", () => {
    // Read the shims rather than hard-coding the pairs, so a NEW shim is
    // covered the day it is added instead of the day someone remembers.
    const missing: string[] = [];
    let chained = 0;
    for (const hook of hooks) {
      const body = readFileSync(join(HOOK_DIR, hook), "utf8");
      for (const m of body.matchAll(/(?:^|\s)(\.claude\/hooks\/[\w.-]+)/g)) {
        // Comments name these paths too; both mentions and invocations must
        // resolve, and a comment citing a path that no longer exists is
        // itself stale. Counting them keeps the assertion below honest.
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
