// Offline tests for the repo-hygiene planner (scripts/repo-hygiene.ts). Pure —
// no git calls, no network. planHygiene is fed fixtures and asserted against the
// safety rules that keep the cleanup from deleting live work. Each test is built
// so it FAILS if its safety rule is removed from the planner (noted per test).

import { describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  execute,
  gatherInput,
  main,
  parseMergedHeadRefs,
  parseWorktrees,
  planHygiene,
  type CommandRunner,
  type HygieneInput,
  type HygienePlan,
  type RunResult,
  type Worktree,
} from "../scripts/repo-hygiene";

const MAIN: Worktree = { path: "E:/projects/spacemolt", branch: "main", locked: false, bare: false };

// A helper to build an input with sane defaults, overridden per test. NOTE the
// `"openHeadRefs" in over` check: openHeadRefs is `Set | null`, and a `?? new Set`
// default would silently turn an explicit `null` (the "open-PR fetch FAILED" case)
// into an empty set — the exact confusion the fix exists to prevent. The `in`
// check keeps an intentional `null` intact.
function input(over: Partial<HygieneInput>): HygieneInput {
  return {
    worktrees: over.worktrees ?? [MAIN],
    branches: over.branches ?? [],
    mergedHeadRefs: over.mergedHeadRefs ?? new Set<string>(),
    openHeadRefs: "openHeadRefs" in over ? (over.openHeadRefs as Set<string> | null) : new Set<string>(),
    currentBranch: over.currentBranch ?? "main",
  };
}

const agentWt = (id: string, over: Partial<Worktree> = {}): Worktree => ({
  path: `E:/projects/spacemolt/.claude/worktrees/agent-${id}`,
  branch: `worktree-agent-${id}`,
  locked: false,
  bare: false,
  ...over,
});

describe("planHygiene — worktree safety", () => {
  test("a LOCKED worktree is NEVER in worktreesToRemove (locked = live agent)", () => {
    // Fails if the `!w.locked` guard is dropped.
    const live = agentWt("live", { locked: true });
    const plan = planHygiene(input({ worktrees: [MAIN, live] }));
    expect(plan.worktreesToRemove).toEqual([]);
  });

  test("an unlocked agent worktree IS removed", () => {
    const dead = agentWt("dead");
    const plan = planHygiene(input({ worktrees: [MAIN, dead] }));
    expect(plan.worktreesToRemove.map((w) => w.path)).toEqual([dead.path]);
  });

  test("the main worktree is never removed (not an agent scaffold)", () => {
    const plan = planHygiene(input({ worktrees: [MAIN] }));
    expect(plan.worktreesToRemove).toEqual([]);
  });

  test("a non-agent worktree elsewhere is left alone (conservative — only agent scaffolds)", () => {
    const human: Worktree = {
      path: "E:/work/some-feature",
      branch: "feature/thing",
      locked: false,
      bare: false,
    };
    const plan = planHygiene(input({ worktrees: [MAIN, human] }));
    expect(plan.worktreesToRemove).toEqual([]);
  });

  test("the CURRENT agent worktree is never removed even though it is a scaffold", () => {
    // Fails if the `w.branch !== currentBranch` guard is dropped: an agent running
    // the hygiene pass from inside its own worktree must not delete itself.
    const self = agentWt("self");
    const plan = planHygiene(
      input({ worktrees: [MAIN, self], currentBranch: "worktree-agent-self" }),
    );
    expect(plan.worktreesToRemove).toEqual([]);
  });

  test("an agent-path worktree holding an UNMERGED batch/* branch is PRESERVED, never removed (the HIGH-sev fixture)", () => {
    // The bug this whole revision closes: an implementer worktree checked out to
    // its `batch/*` PR branch (the NORMAL end state of every finished task) is
    // unlocked and lives under .claude/worktrees/, so the OLD filter reaped it —
    // force-removing an open PR's uncommitted files. It is non-scaffold and not in
    // the merged set, so it is now preserved + reported instead.
    // ABLATION: revert the worktree gate to the old
    // `!locked && !bare && isAgentWorktree && branch!=current` filter and this
    // worktree lands in worktreesToRemove — this assertion then fails.
    const openWork = agentWt("openpr", { branch: "batch/some-task" });
    const plan = planHygiene(input({ worktrees: [MAIN, openWork] }));
    expect(plan.worktreesToRemove).toEqual([]);
    expect(plan.worktreesPreserved.map((w) => w.path)).toEqual([openWork.path]);
  });

  test("an agent worktree whose branch has a MERGED PR IS removed (provably dead)", () => {
    // The intended cleanup: once a task's PR merges, its worktree is safe to reap.
    const done = agentWt("merged", { branch: "batch/merged-task" });
    const plan = planHygiene(
      input({ worktrees: [MAIN, done], mergedHeadRefs: new Set(["batch/merged-task"]) }),
    );
    expect(plan.worktreesToRemove.map((w) => w.path)).toEqual([done.path]);
    expect(plan.worktreesPreserved).toEqual([]);
  });

  test("a scaffold worktree whose branch has an OPEN PR is PRESERVED (open-PR gate)", () => {
    // A raw `worktree-agent-*` branch is normally a throwaway scaffold, but if a PR
    // was opened directly against it, it carries live work — the open-PR gate must
    // spare it. Fails if worktreeBranchIsDead ignores openHeadRefs for scaffolds.
    const scaffoldPr = agentWt("directpr");
    const plan = planHygiene(
      input({ worktrees: [MAIN, scaffoldPr], openHeadRefs: new Set(["worktree-agent-directpr"]) }),
    );
    expect(plan.worktreesToRemove).toEqual([]);
    expect(plan.worktreesPreserved.map((w) => w.path)).toEqual([scaffoldPr.path]);
  });

  test("open-PR fetch FAILURE (openHeadRefs=null): a scaffold worktree is PRESERVED, never reaped (fail-safe)", () => {
    // The NEW fail-unsafe defect this revision closes: when `gh pr list --state open`
    // fails, gatherInput yields openHeadRefs === null. Absence from a set we could
    // not build is NOT proof of "no open PR", so the scaffold must be preserved.
    // ABLATION: drop the `if (openHeadRefs === null) return false` guard in
    // worktreeBranchIsDead and this scaffold lands in worktreesToRemove — the exact
    // fail-unsafe reap the fix prevents.
    const scaffold = agentWt("unknown");
    const plan = planHygiene(input({ worktrees: [MAIN, scaffold], openHeadRefs: null }));
    expect(plan.worktreesToRemove).toEqual([]);
    expect(plan.worktreesPreserved.map((w) => w.path)).toEqual([scaffold.path]);
  });

  test("null vs empty is the whole point: an EMPTY (fetched, no open PRs) set DOES reap the same scaffold", () => {
    // Distinguishes "fetch succeeded, genuinely no open PRs" (reap) from "fetch
    // failed" (preserve). If the fix over-corrected and treated an empty set like a
    // failure, the tool would never reap anything — this pins that it still does.
    const scaffold = agentWt("unknown");
    const plan = planHygiene(input({ worktrees: [MAIN, scaffold], openHeadRefs: new Set<string>() }));
    expect(plan.worktreesToRemove.map((w) => w.path)).toEqual([scaffold.path]);
    expect(plan.worktreesPreserved).toEqual([]);
  });
});

describe("planHygiene — branch safety", () => {
  test("main and the current branch are NEVER deleted", () => {
    // main appears in the branch list; current is a batch branch checked out in
    // the main worktree. Fails if either the `b === "main"` or the
    // `b === currentBranch` guard is dropped.
    const wt: Worktree = { ...MAIN, branch: "batch/current-work" };
    const plan = planHygiene(
      input({
        worktrees: [wt],
        branches: ["main", "batch/current-work"],
        currentBranch: "batch/current-work",
        // even if both were (wrongly) reported as merged, they must not delete:
        mergedHeadRefs: new Set(["main", "batch/current-work"]),
      }),
    );
    expect(plan.branchesToDelete).toEqual([]);
    expect(plan.unmergedNoPrBranches).toEqual([]);
  });

  test("an open-PR branch (not merged, not a scaffold) is REPORTED, never deleted", () => {
    // The planner only knows the MERGED set, so an open PR is indistinguishable
    // from no PR — both must land in unmergedNoPrBranches, never in the delete
    // list. Fails if the else-branch routes unknowns to deletion.
    const plan = planHygiene(input({ branches: ["main", "batch/open-pr"] }));
    expect(plan.branchesToDelete).toEqual([]);
    expect(plan.unmergedNoPrBranches).toEqual(["batch/open-pr"]);
  });

  test("an orphan worktree-agent-* branch with no live worktree IS deleted", () => {
    // The scaffold branch's worktree is gone (it is not held by any surviving
    // worktree), so it is orphaned. Fails if the orphan-scaffold rule is removed
    // (it would fall through to unmergedNoPrBranches instead).
    const plan = planHygiene(
      input({ worktrees: [MAIN], branches: ["main", "worktree-agent-orphan"] }),
    );
    expect(plan.branchesToDelete).toEqual([{ name: "worktree-agent-orphan", reason: "orphan-scaffold" }]);
    expect(plan.unmergedNoPrBranches).toEqual([]);
  });

  test("an orphan worktree-agent-* branch that has an OPEN PR is REPORTED, never deleted (open-PR gate)", () => {
    // Finding #2: a PR opened directly against a raw scaffold branch (bypassing the
    // batch/* rename) whose worktree is gone must not be silently reaped as an
    // orphan scaffold. Fails if the orphan-scaffold branch rule ignores openHeadRefs.
    const plan = planHygiene(
      input({
        worktrees: [MAIN],
        branches: ["main", "worktree-agent-haspr"],
        openHeadRefs: new Set(["worktree-agent-haspr"]),
      }),
    );
    expect(plan.branchesToDelete).toEqual([]);
    expect(plan.unmergedNoPrBranches).toEqual(["worktree-agent-haspr"]);
  });

  test("a worktree-agent-* branch STILL held by a surviving worktree is NOT deleted", () => {
    // Guards the survivingBranches protection: a live (locked) agent's scaffold
    // branch must be protected, not reaped as an orphan.
    const live = agentWt("live", { locked: true });
    const plan = planHygiene(
      input({ worktrees: [MAIN, live], branches: ["main", "worktree-agent-live"] }),
    );
    expect(plan.branchesToDelete).toEqual([]);
    expect(plan.unmergedNoPrBranches).toEqual([]);
  });

  test("a merged-PR branch IS deleted", () => {
    // Fails if the merged-PR deletion rule is removed.
    const plan = planHygiene(
      input({ branches: ["main", "batch/done"], mergedHeadRefs: new Set(["batch/done"]) }),
    );
    expect(plan.branchesToDelete).toEqual([{ name: "batch/done", reason: "merged-pr" }]);
    expect(plan.unmergedNoPrBranches).toEqual([]);
  });

  test("removing a worktree this run orphans its scaffold branch, which is then deleted", () => {
    // End-to-end within the planner: a dead (unlocked) agent worktree is removed,
    // so its branch is no longer held by a surviving worktree and gets reaped as
    // an orphan scaffold in the same plan.
    const dead = agentWt("dead");
    const plan = planHygiene(
      input({ worktrees: [MAIN, dead], branches: ["main", "worktree-agent-dead"] }),
    );
    expect(plan.worktreesToRemove.map((w) => w.path)).toEqual([dead.path]);
    expect(plan.branchesToDelete).toEqual([{ name: "worktree-agent-dead", reason: "orphan-scaffold" }]);
  });

  test("open-PR fetch FAILURE (openHeadRefs=null): an orphan scaffold branch is REPORTED, never deleted (fail-safe)", () => {
    // The branch-deletion side of the same fail-unsafe defect: with openHeadRefs
    // empty, `!openHeadRefs.has(b)` was TRUE for every scaffold, so a failed open-PR
    // fetch used to `git branch -D` a scaffold branch that might carry an open PR.
    // ABLATION: drop the `openHeadRefs !== null &&` guard in the branch loop and
    // this branch moves from unmergedNoPrBranches into branchesToDelete.
    const plan = planHygiene(
      input({ worktrees: [MAIN], branches: ["main", "worktree-agent-orphan"], openHeadRefs: null }),
    );
    expect(plan.branchesToDelete).toEqual([]);
    expect(plan.unmergedNoPrBranches).toEqual(["worktree-agent-orphan"]);
  });

  test("merged-set fetch FAILURE (empty merged set): a would-be-merged branch is REPORTED, never deleted", () => {
    // The merged set is a POSITIVE signal, so its fetch fails safe as an empty set:
    // a branch whose PR really merged is proven merged only when it is IN the set.
    // On a merged-fetch failure the set is empty, so the branch is reported, not
    // reaped. Fails if a merged-fetch failure were ever made to default-delete.
    const plan = planHygiene(
      input({ branches: ["main", "batch/was-merged"], mergedHeadRefs: new Set<string>() }),
    );
    expect(plan.branchesToDelete).toEqual([]);
    expect(plan.unmergedNoPrBranches).toEqual(["batch/was-merged"]);
  });
});

describe("parseWorktrees", () => {
  test("a locked line WITH a reason still sets locked=true (the load-bearing parse)", () => {
    // The real porcelain emits `locked <reason>`, not a bare `locked`. If this
    // parse regressed to `=== "locked"`, a LIVE worktree would read unlocked and
    // be reaped — the worst failure this whole tool can have.
    const porcelain = [
      "worktree E:/projects/spacemolt",
      "HEAD 779f118e9a0e1e67b4138fabac2bcd53d7447289",
      "branch refs/heads/main",
      "",
      "worktree E:/projects/spacemolt/.claude/worktrees/agent-abc",
      "HEAD 8d1f2d23185a058f2d7da0d2b3674c1f9a475a54",
      "branch refs/heads/worktree-agent-abc",
      "locked claude agent agent-abc (pid 11448 start 639198820103467090)",
      "",
    ].join("\n");
    const wts = parseWorktrees(porcelain);
    expect(wts).toHaveLength(2);
    expect(wts[0]).toEqual({ path: "E:/projects/spacemolt", branch: "main", locked: false, bare: false });
    expect(wts[1]).toEqual({
      path: "E:/projects/spacemolt/.claude/worktrees/agent-abc",
      branch: "worktree-agent-abc",
      locked: true,
      bare: false,
    });
  });

  test("detached and bare records parse with branch=null", () => {
    const porcelain = [
      "worktree /repo/bare",
      "bare",
      "",
      "worktree /repo/detached",
      "HEAD abc123",
      "detached",
      "",
    ].join("\n");
    const wts = parseWorktrees(porcelain);
    expect(wts).toEqual([
      { path: "/repo/bare", branch: null, locked: false, bare: true },
      { path: "/repo/detached", branch: null, locked: false, bare: false },
    ]);
  });

  test("CRLF line endings parse the same as LF (Windows git output)", () => {
    const porcelain = "worktree /repo/main\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n";
    expect(parseWorktrees(porcelain)).toEqual([
      { path: "/repo/main", branch: "main", locked: false, bare: false },
    ]);
  });
});

describe("parseMergedHeadRefs", () => {
  test("extracts headRefName from the gh JSON array", () => {
    const json = JSON.stringify([{ headRefName: "batch/a" }, { headRefName: "revise/b" }]);
    expect(parseMergedHeadRefs(json)).toEqual(new Set(["batch/a", "revise/b"]));
  });

  test("malformed or empty output yields an empty set (safe direction, no throw)", () => {
    expect(parseMergedHeadRefs("not json")).toEqual(new Set());
    expect(parseMergedHeadRefs("[]")).toEqual(new Set());
    expect(parseMergedHeadRefs("{}")).toEqual(new Set());
  });
});

describe("execute — the git-mutating executor (offline, injected runner)", () => {
  // A fake runner that records every command and returns status 0, so execute
  // runs without touching real git.
  const okRunner = (): { runner: CommandRunner; calls: string[][] } => {
    const calls: string[][] = [];
    const runner: CommandRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: "", stderr: "" } satisfies RunResult;
    };
    return { runner, calls };
  };

  test("a locked worktree that reaches execute is REFUSED (the force-safe re-guard)", () => {
    // Independent of the planner's lock exclusion: even if a planner bug placed a
    // locked worktree in the plan, execute must never run `worktree remove` on it.
    // Fails if the `if (w.locked)` re-guard in execute is dropped.
    const { runner, calls } = okRunner();
    const locked: Worktree = {
      path: "E:/projects/spacemolt/.claude/worktrees/agent-live",
      branch: "worktree-agent-live",
      locked: true,
      bare: false,
    };
    const plan: HygienePlan = {
      worktreesToRemove: [locked],
      worktreesPreserved: [],
      branchesToDelete: [],
      unmergedNoPrBranches: [],
    };
    const result = execute(plan, runner);
    expect(result.worktreesRemoved).toBe(0);
    expect(result.failures.some((f) => f.includes("refused to remove locked worktree"))).toBe(true);
    // The runner must never have been asked to remove the locked path.
    expect(calls.some((c) => c.includes("remove") && c.includes(locked.path))).toBe(false);
  });

  test("planned removals are applied through the runner (no real git)", () => {
    const { runner, calls } = okRunner();
    const dead: Worktree = {
      path: "E:/projects/spacemolt/.claude/worktrees/agent-dead",
      branch: "worktree-agent-dead",
      locked: false,
      bare: false,
    };
    const plan: HygienePlan = {
      worktreesToRemove: [dead],
      worktreesPreserved: [],
      branchesToDelete: [{ name: "batch/done", reason: "merged-pr" }],
      unmergedNoPrBranches: [],
    };
    const result = execute(plan, runner);
    expect(result).toEqual({ worktreesRemoved: 1, branchesDeleted: 1, failures: [] });
    expect(calls).toContainEqual(["git", "worktree", "remove", dead.path]);
    expect(calls).toContainEqual(["git", "worktree", "prune"]);
    expect(calls).toContainEqual(["git", "branch", "-D", "batch/done"]);
  });
});

describe("gatherInput — gh fetch failure maps to the fail-safe input (the producer of the bug)", () => {
  // Builds a fake CommandRunner so gatherInput runs with no real git/gh. Every git
  // call succeeds with benign output; the two `gh pr list` calls are controllable
  // per-state so a test can force a failure on exactly one of them. This tests the
  // PRODUCER seam that shipped the defect: a failed open-PR fetch must become
  // openHeadRefs === null, not an empty set.
  const fakeRunner = (opts: {
    merged?: RunResult;
    open?: RunResult;
  }): CommandRunner => {
    const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
    return (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n");
      }
      if (cmd === "git" && args[0] === "branch" && args.includes("--show-current")) return ok("main\n");
      if (cmd === "git" && args[0] === "branch") return ok("main\n");
      if (cmd === "gh" && args.includes("merged")) return opts.merged ?? ok("[]");
      if (cmd === "gh" && args.includes("open")) return opts.open ?? ok("[]");
      throw new Error(`unexpected command in test: ${cmd} ${args.join(" ")}`);
    };
  };

  const fail: RunResult = { status: 1, stdout: "", stderr: "gh: not authenticated" };

  test("open-PR fetch FAILS -> openHeadRefs is null (NOT an empty set)", () => {
    // The exact bug: on ghOpen.status !== 0 the old code left openHeadRefs an empty
    // set, which the planner then read as "no branch has an open PR" and reaped.
    // Fails if gatherInput's open branch ever defaults to a set again.
    const input = gatherInput(fakeRunner({ open: fail }));
    expect(input.openHeadRefs).toBeNull();
  });

  test("open-PR fetch SUCCEEDS -> openHeadRefs is a Set (even when empty)", () => {
    const input = gatherInput(fakeRunner({ open: { status: 0, stdout: "[]", stderr: "" } }));
    expect(input.openHeadRefs).toBeInstanceOf(Set);
    expect(input.openHeadRefs).toEqual(new Set());
  });

  test("merged fetch FAILS -> mergedHeadRefs is an empty Set, never null (positive signal fails safe)", () => {
    // The merged set stays a Set: an empty set is already the safe direction for a
    // positive-proof signal, so it must not become null (that would be a type lie
    // and force needless handling downstream).
    const input = gatherInput(fakeRunner({ merged: fail }));
    expect(input.mergedHeadRefs).toBeInstanceOf(Set);
    expect(input.mergedHeadRefs).toEqual(new Set());
  });

  test("end-to-end: an open-PR fetch failure preserves a scaffold worktree the plan would otherwise reap", () => {
    // Producer + planner together, no real git: worktree list holds a scaffold, the
    // open-PR fetch fails, so the resulting plan preserves rather than reaps it.
    const runner: CommandRunner = (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") {
        return {
          status: 0,
          stdout:
            "worktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n" +
            "worktree /repo/.claude/worktrees/agent-x\nHEAD def\nbranch refs/heads/worktree-agent-x\n\n",
          stderr: "",
        };
      }
      if (cmd === "git" && args[0] === "branch" && args.includes("--show-current")) {
        return { status: 0, stdout: "main\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "branch") {
        return { status: 0, stdout: "main\nworktree-agent-x\n", stderr: "" };
      }
      if (cmd === "gh" && args.includes("merged")) return { status: 0, stdout: "[]", stderr: "" };
      if (cmd === "gh" && args.includes("open")) return fail;
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    };
    const plan = planHygiene(gatherInput(runner));
    expect(plan.worktreesToRemove).toEqual([]);
    expect(plan.worktreesPreserved.map((w) => w.path)).toEqual(["/repo/.claude/worktrees/agent-x"]);
    expect(plan.branchesToDelete).toEqual([]);
    // The scaffold branch is held by the (now preserved) worktree, so the surviving-
    // worktree guard protects it before the scaffold rule is even reached — it is
    // neither deleted nor reported. The preserved worktree is the visible signal.
    expect(plan.unmergedNoPrBranches).toEqual([]);
  });
});

describe("main — dry-run gate", () => {
  const deadInput = (): HygieneInput =>
    input({
      worktrees: [MAIN, agentWt("dead")],
      branches: ["main", "worktree-agent-dead"],
    });

  test("--dry-run runs the planner but executes NOTHING", () => {
    // The PR's dry-run safety claim, now a regression test: with --dry-run the
    // executor is never invoked. Fails if the `if (!dryRun)` gate in main is dropped.
    const exec = mock(() => ({ worktreesRemoved: 0, branchesDeleted: 0, failures: [] }));
    main({ gather: deadInput, exec, argv: ["bun", "repo-hygiene.ts", "--dry-run"] });
    expect(exec).not.toHaveBeenCalled();
  });

  test("without --dry-run the executor IS invoked with the plan", () => {
    const exec = mock(() => ({ worktreesRemoved: 1, branchesDeleted: 1, failures: [] }));
    main({ gather: deadInput, exec, argv: ["bun", "repo-hygiene.ts"] });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// Wiring guard: the forcing function is only real if the charter tells the
// stand-up to run it and the guardrails record the --delete-branch habit. Reads
// docs, so it is presence-gated (the .dockerignore keeps docs/ and .claude/ out
// of the image; these inputs are absent inside the container build).
const root = join(import.meta.dir, "..");
const charter = join(root, "docs/charters/soc-monitor.md");
const guardrails = join(root, ".claude/guardrails.md");
const wiringPresent = existsSync(charter) && existsSync(guardrails);

describe.skipIf(!wiringPresent)("wiring", () => {
  test("the SOC-monitor charter tells the stand-up to run the hygiene script", () => {
    expect(readFileSync(charter, "utf8")).toContain("scripts/repo-hygiene.ts");
  });

  test("guardrails records the gh pr merge --delete-branch habit", () => {
    expect(readFileSync(guardrails, "utf8")).toContain("--delete-branch");
  });
});
