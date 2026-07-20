// Steward PR-prep contract (#261). The prep script exists so the backlog
// regen is no longer a prose checklist step a tired steward can drop; what
// these tests pin is the property that makes that stick: every step must
// yield its EVIDENCE receipt or the run FAILS — a skipped or broken regen
// can never produce a clean-looking report. Exec is injected, so the suite
// stays offline (no gh, no python, no network).
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertInsideTree,
  outputsEscapingTree,
  runPrep,
  stewardSteps,
  type Exec,
} from "../scripts/steward-prep";

function recordingExec(impl: Exec): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: (cmd) => {
      calls.push(cmd);
      return impl(cmd);
    },
  };
}

describe("steward-prep (#261: backlog regen is automated, not prose)", () => {
  test("happy path: all steps run in order and the backlog count becomes an evidence line", () => {
    const { exec, calls } = recordingExec((cmd) => ({
      status: 0,
      output: cmd.includes("scripts/gen-backlog.py")
        ? "wrote docs/backlog.md (58 open issues)\n"
        : "ok\n",
    }));
    const result = runPrep(stewardSteps("python3"), exec);
    expect(result.ok).toBe(true);
    expect(result.evidence).toEqual([
      "backlog regenerated: 58 open issues",
      "roadmap SVGs regenerated from the gate table",
      "doc-size gate: green",
    ]);
    // The backlog regen is the step that was dropped three passes running —
    // it must be a step the runner executes, not a comment.
    expect(calls[0]).toEqual(["python3", "scripts/gen-backlog.py"]);
    expect(calls.length).toBe(3);
  });

  test("a failing step aborts the run: later steps never execute, failure is named", () => {
    const { exec, calls } = recordingExec(() => ({ status: 1, output: "gh: not logged in\n" }));
    const result = runPrep(stewardSteps("python3"), exec);
    expect(result.ok).toBe(false);
    expect(result.failed).toBe("backlog regen");
    expect(result.evidence).toEqual([]);
    expect(calls.length).toBe(1);
  });

  test("a zero-exit backlog run WITHOUT the receipt line fails — evidence is never silently blank", () => {
    const { exec } = recordingExec(() => ({ status: 0, output: "nothing useful\n" }));
    const result = runPrep(stewardSteps("python3"), exec);
    expect(result.ok).toBe(false);
    expect(result.failed).toContain("backlog regen");
    expect(result.evidence).toEqual([]);
  });

  // #321: a steward in a linked worktree once regenerated docs/backlog.md into
  // the MAIN checkout; the EVIDENCE line passed while the file missed the PR
  // (landed manually via #320). The guard must make an out-of-tree write a hard
  // error, so this test fails if output resolution ever escapes the commit tree.
  test("#321: the worktree-boundary guard throws when a producer writes outside the commit tree", () => {
    // Derive genuinely-absolute paths on whichever OS runs the suite. A hardcoded
    // "E:/…" literal is absolute only on Windows, so the guard once classified an
    // escape on the host but not in the Linux CI container (#342). tmpdir()+resolve()
    // yield a real absolute tree on both platforms; the paths need not exist, the
    // guard only compares normalized strings. `main` is the shared checkout, `worktree`
    // a linked worktree under it — the #321 topology (a write into main misses the PR).
    const main = resolve(tmpdir(), "sm-guard-main");
    const worktree = resolve(main, ".claude", "worktrees", "agent-x");
    const inTree = resolve(worktree, "docs", "backlog.md");
    const escaping = resolve(main, "docs", "backlog.md");

    // In-tree write (the fixed behavior): accepted.
    expect(() => assertInsideTree(worktree, inTree)).not.toThrow();
    // The exact #321 leak: regen landed in the MAIN checkout while the steward
    // commits from a linked worktree — must be rejected, not silently passed.
    expect(() => assertInsideTree(worktree, escaping)).toThrow(/OUTSIDE the worktree/);

    // The guard as steward-prep actually applies it: reading a producer's
    // `wrote <abs> (...)` receipt back and rejecting a main-checkout target.
    const leak = outputsEscapingTree(worktree, [`wrote ${escaping} (61 open issues)\n`]);
    expect(leak.length).toBe(1);
    const clean = outputsEscapingTree(worktree, [`wrote ${inTree} (61 open issues)\n`]);
    expect(clean).toEqual([]);
  });
});
