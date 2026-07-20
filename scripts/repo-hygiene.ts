// Repo-hygiene forcing function (AUTOMATE rung, .claude/guardrails.md).
//
// The repo accumulated 41 git worktrees and ~50 local branches before a manual
// cleanup. Three producers, none self-cleaning: (1) the harness creates a
// `.claude/worktrees/agent-*` worktree per isolated agent and does NOT remove it
// after the agent commits; (2) `gh pr merge` without `--delete-branch` leaves the
// branch behind; (3) nothing prunes on a cadence. A one-time cleanup refills, so
// this runs every stand-up (SOC-monitor charter) and reaps only what is provably
// dead — never a live agent's worktree, never an unmerged branch.
//
// SHAPE: a PURE decision function (`planHygiene`) that touches no git state and
// encodes every safety rule, plus a thin executor that gathers git/gh facts,
// calls the planner, and runs the removals. The planner is what the unit tests
// exercise (test/repo-hygiene.test.ts) — no git, no network, fully offline.
//
// SAFETY RULES (a bug here deletes live work — these are the whole point):
//   - A LOCKED worktree is a live agent. It is NEVER removed. The executor never
//     passes --force to a locked worktree (only to discard a dead worktree's
//     dirty files), and the planner never puts a locked worktree in the plan, so
//     the two guards are independent.
//   - A WORKTREE is removed only when its branch is provably dead — the SAME
//     proof bar as branch deletion: EITHER (a) its branch has a MERGED PR, OR
//     (b) it is a pure throwaway scaffold (a `worktree-agent-*` branch or a
//     detached HEAD) that is NOT itself an open-PR head. A worktree holding an
//     unmerged non-scaffold branch (`batch/*`, `revise/*`, `docs/*`, `fix/*`, …)
//     — the normal end state of every finished task, an open PR or unpushed work
//     — is PRESERVED and reported, never removed. (Before this gate the planner
//     reaped any unlocked agent-path worktree regardless of its branch's PR
//     status, which force-removed open-PR worktrees and their uncommitted files.)
//   - NEVER delete: `main`, the current branch, a branch with an OPEN PR, or a
//     branch checked out by a worktree that survives this run.
//   - A local branch is deleted only when EITHER (a) it is an orphan
//     `worktree-agent-*` scaffold whose worktree no longer exists AND has no open
//     PR, OR (b) its PR is MERGED. Anything else (unmerged-no-PR, open-PR) is
//     REPORTED, not deleted — when unsure, report.
//
// FINDING for upstream (agent-harness-core, out of scope here): the deeper fix is
// the harness auto-removing an agent worktree once that agent's PR merges, which
// would stop producer (1) at the source. This script is the cadence backstop.

import { spawnSync } from "node:child_process";

// --- data shapes ------------------------------------------------------------

export interface Worktree {
  /** Absolute path git reports for the worktree. */
  path: string;
  /** Short branch name (refs/heads/ stripped), or null when detached/bare. */
  branch: string | null;
  /** True when git reports the worktree locked — a live agent holds it. */
  locked: boolean;
  /** True for the bare administrative worktree (has no working copy). */
  bare: boolean;
}

export interface HygieneInput {
  /** Parsed `git worktree list --porcelain`. */
  worktrees: Worktree[];
  /** All local branch names (`git branch --format='%(refname:short)'`). */
  branches: string[];
  /** headRefName of every MERGED PR (`gh pr list --state merged`). */
  mergedHeadRefs: Set<string>;
  /** headRefName of every OPEN PR (`gh pr list --state open`), or `null` when that
   *  fetch FAILED. A branch with an open PR is live work regardless of naming
   *  convention — never removed/deleted; this set is the gate that protects a
   *  scaffold branch that (unconventionally) had a PR opened directly against it.
   *  ASYMMETRY (this is the whole safety point): unlike the merged set, this set is
   *  consulted as a NEGATIVE signal — a scaffold reaps precisely because it is NOT
   *  in the set — so an EMPTY set is only safe when it is COMPLETE. `null` means the
   *  fetch could not confirm the set, so no scaffold can be proven disposable this
   *  run → every scaffold is PRESERVED and reported. An empty NON-null set means
   *  "fetch succeeded, genuinely no open PRs" and scaffolds may then be reaped. */
  openHeadRefs: Set<string> | null;
  /** `git branch --show-current`, or null on a detached HEAD. */
  currentBranch: string | null;
}

export type DeleteReason = "merged-pr" | "orphan-scaffold";
export interface BranchDeletion {
  name: string;
  reason: DeleteReason;
}

export interface HygienePlan {
  worktreesToRemove: Worktree[];
  /** Agent worktrees NOT reaped because their branch could not be proven dead:
   *  an unmerged non-scaffold branch (an open PR or unpushed work — the normal
   *  end state of a finished task), a scaffold branch that has an open PR, or ANY
   *  scaffold when the open-PR fetch failed (openHeadRefs === null — can't prove
   *  it has no open PR). Surfaced for a human, never removed — conservative. */
  worktreesPreserved: Worktree[];
  branchesToDelete: BranchDeletion[];
  /** Branches whose safety could not be proven — surfaced for a human, never
   *  auto-deleted. Catches genuinely-unmerged locals, open-PR branches, scaffold
   *  branches that (unconventionally) hold an open PR, and every scaffold branch
   *  when the open-PR fetch failed (openHeadRefs === null). */
  unmergedNoPrBranches: string[];
}

// --- classification ---------------------------------------------------------

/** git names a worktree's throwaway scaffold branch `worktree-agent-<id>`. The
 *  agent's real work lands on a `batch/*` or `revise/*` branch via PR, so an
 *  ORPHANED scaffold (its worktree gone) is dead weight, safe to reap. Kept
 *  strict — only the exact git-generated prefix — so it never matches a human
 *  branch. */
const SCAFFOLD_BRANCH_RE = /^worktree-agent-/;

/** Claude Code isolation puts agent worktrees under `.claude/worktrees/`.
 *  Separator-normalized so a Windows path compares the same as a POSIX one. */
export function isAgentWorktreePath(p: string): boolean {
  return p.replace(/\\/g, "/").includes("/.claude/worktrees/");
}

/** A worktree the hygiene pass may CONSIDER reaping: an agent scaffold, identified
 *  by its path OR its branch. Either signal alone is enough. Being a candidate is
 *  necessary but not sufficient — the branch must also be provably dead (see
 *  `worktreeBranchIsDead`). */
function isAgentWorktree(w: Worktree): boolean {
  return isAgentWorktreePath(w.path) || (w.branch !== null && SCAFFOLD_BRANCH_RE.test(w.branch));
}

/** True iff a candidate worktree's branch is PROVABLY dead, so removing the
 *  worktree cannot destroy live work. The same proof bar branch deletion uses:
 *    (a) the branch has a MERGED PR (its work is in main — safe), OR
 *    (b) it is a pure throwaway scaffold — a `worktree-agent-*` branch or a
 *        detached HEAD (branch === null) — that is NOT itself an open-PR head.
 *  Everything else (an unmerged `batch/*`/`revise/*`/etc. branch, or a scaffold
 *  with an open PR) is NOT provably dead → the worktree is preserved. When
 *  unsure, this returns false (preserve), never true. */
function worktreeBranchIsDead(
  w: Worktree,
  mergedHeadRefs: Set<string>,
  openHeadRefs: Set<string> | null,
): boolean {
  const branch = w.branch;
  if (branch !== null && mergedHeadRefs.has(branch)) return true; // (a) merged PR — positive proof, independent of the open-PR fetch
  const isScaffold = branch === null || SCAFFOLD_BRANCH_RE.test(branch);
  if (isScaffold) {
    // (b) throwaway scaffold — reapable only when we can POSITIVELY confirm it holds
    //     no open PR. openHeadRefs === null means the open-PR fetch FAILED: absence
    //     from a set we could not build is not proof, so it is NOT provably dead and
    //     is preserved (fail-safe, mirrors the merged set's empty-on-failure).
    if (openHeadRefs === null) return false;
    return branch === null || !openHeadRefs.has(branch);
  }
  return false; // unmerged non-scaffold branch → live work, preserve
}

// --- the pure planner (this is what the tests pin) --------------------------

/**
 * Decide what to remove and what to report. Touches NO git state — it only
 * reasons over the facts handed in. Every safety rule above lives here.
 */
export function planHygiene(input: HygieneInput): HygienePlan {
  const { worktrees, branches, mergedHeadRefs, openHeadRefs, currentBranch } = input;

  // 1. Worktree decisions. A candidate is an agent scaffold that is NOT locked
  //    (locked = live agent), NOT bare, and NOT the current worktree (a worktree
  //    is the current one iff it holds the current branch — a branch is checked
  //    out in at most one worktree). Locked/current are excluded up front so the
  //    plan itself is force-safe and never self-deletes. A candidate is then
  //    REMOVED only if its branch is provably dead (merged, or an orphan scaffold
  //    with no open PR); otherwise the worktree holds live work (an unmerged
  //    `batch/*` branch — an open PR or unpushed files) and is PRESERVED + reported.
  const worktreesToRemove: Worktree[] = [];
  const worktreesPreserved: Worktree[] = [];
  for (const w of worktrees) {
    if (w.locked || w.bare || !isAgentWorktree(w)) continue; // not a candidate
    if (currentBranch !== null && w.branch === currentBranch) continue; // the running worktree
    if (worktreeBranchIsDead(w, mergedHeadRefs, openHeadRefs)) {
      worktreesToRemove.push(w);
    } else {
      worktreesPreserved.push(w);
    }
  }

  // Branches held by SURVIVING worktrees (everything we are not removing). git
  // refuses `branch -D` on a branch checked out in a worktree, and more to the
  // point these are live — off-limits for deletion. This derived set is the
  // "branches checked out by surviving worktrees" the safety rules consult.
  const removedPaths = new Set(worktreesToRemove.map((w) => w.path));
  const survivingBranches = new Set(
    worktrees
      .filter((w) => !removedPaths.has(w.path))
      .map((w) => w.branch)
      .filter((b): b is string => b !== null),
  );

  // 2. Branch decisions.
  const branchesToDelete: BranchDeletion[] = [];
  const unmergedNoPrBranches: string[] = [];

  for (const b of branches) {
    if (b === "main") continue; // never touch the trunk
    if (currentBranch !== null && b === currentBranch) continue; // never the current branch
    if (survivingBranches.has(b)) continue; // held by a surviving worktree

    if (mergedHeadRefs.has(b)) {
      branchesToDelete.push({ name: b, reason: "merged-pr" });
    } else if (openHeadRefs !== null && SCAFFOLD_BRANCH_RE.test(b) && !openHeadRefs.has(b)) {
      // A `worktree-agent-*` branch not held by any surviving worktree AND with no
      // open PR: its worktree is gone (or removed this run), so the scaffold is
      // orphaned. The open-PR gate guards the rare case of a PR opened directly
      // against a raw scaffold branch (bypassing the batch/* rename convention).
      // Requires openHeadRefs !== null: if the open-PR fetch FAILED we cannot prove
      // the scaffold has no open PR, so it is reported (below), not deleted.
      branchesToDelete.push({ name: b, reason: "orphan-scaffold" });
    } else {
      // No merged PR, and not a reapable orphan scaffold: an open-PR branch, a
      // genuinely unmerged local, a scaffold that holds an open PR, or ANY scaffold
      // when the open-PR fetch failed (openHeadRefs === null). Cannot prove it safe
      // → REPORT, never delete.
      unmergedNoPrBranches.push(b);
    }
  }

  return { worktreesToRemove, worktreesPreserved, branchesToDelete, unmergedNoPrBranches };
}

// --- parsers (pure; exported for offline tests) -----------------------------

/**
 * Parse `git worktree list --porcelain`. Records are separated by a blank line;
 * each is a set of `label value` lines. The `locked` label is LOAD-BEARING and
 * arrives WITH a reason in practice (`locked claude agent ... (pid ...)`), so a
 * naive `=== "locked"` match would read a live worktree as unlocked and reap it
 * — this matches the label at line start instead.
 */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  const records = porcelain.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const rec of records) {
    const lines = rec.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length === 0) continue;
    let path: string | null = null;
    let branch: string | null = null;
    let locked = false;
    let bare = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      } else if (line === "bare") bare = true;
      else if (line === "locked" || line.startsWith("locked ") || line.startsWith("locked\t")) {
        locked = true;
      }
    }
    if (path !== null) out.push({ path, branch, locked, bare });
  }
  return out;
}

/**
 * Parse `gh pr list --state <merged|open> --json headRefName` into a head-ref set
 * (used for both the merged set and the open set — same JSON shape). Defensive: a
 * non-array or a row without a string headRefName yields an empty/partial set
 * rather than throwing — the executor already treats a gh failure as "prove
 * nothing", the conservative direction.
 */
export function parseMergedHeadRefs(json: string): Set<string> {
  const set = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return set;
  }
  if (!Array.isArray(parsed)) return set;
  for (const row of parsed) {
    if (
      row &&
      typeof row === "object" &&
      typeof (row as Record<string, unknown>).headRefName === "string"
    ) {
      set.add((row as Record<string, unknown>).headRefName as string);
    }
  }
  return set;
}

// --- thin executor ----------------------------------------------------------

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command and returns its result. Injectable so `execute` can be unit
 *  tested offline (no real git) — the default is the real spawnSync runner. */
export type CommandRunner = (cmd: string, args: string[]) => RunResult;

const run: CommandRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function gatherInput(runner: CommandRunner = run): HygieneInput {
  const wt = runner("git", ["worktree", "list", "--porcelain"]);
  const worktrees = parseWorktrees(wt.stdout);

  const br = runner("git", ["branch", "--format=%(refname:short)"]);
  const branches = br.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

  const cur = runner("git", ["branch", "--show-current"]);
  const curName = cur.stdout.trim();
  const currentBranch = curName === "" ? null : curName;

  // gh is external and may be missing or unauthenticated. The two sets are used
  // asymmetrically, so a fetch failure fails DIFFERENTLY for each — this is the
  // whole safety point (a prior bug treated both as an empty set and reaped on the
  // open-PR failure):
  //   - mergedHeadRefs is a POSITIVE signal (a branch deletes BECAUSE it is in the
  //     set). An empty set on failure proves nothing merged → zero merged deletions.
  //     Safe as an empty set; no null needed.
  //   - openHeadRefs is a NEGATIVE signal (a scaffold reaps BECAUSE it is NOT in the
  //     set). An empty set is only safe when COMPLETE, so a failed fetch is `null`
  //     (see below), never an empty set — else absence-from-the-set reaps everything.
  // A merged-set failure still lets orphan-scaffold cleanup run: that path needs the
  // OPEN set and the naming convention, not the merged set.
  const gh = runner("gh", ["pr", "list", "--state", "merged", "--limit", "500", "--json", "headRefName"]);
  let mergedHeadRefs = new Set<string>();
  if (gh.status === 0) {
    mergedHeadRefs = parseMergedHeadRefs(gh.stdout);
  } else {
    console.warn(
      "repo-hygiene: WARN could not list merged PRs (gh missing/unauthenticated?) — " +
        "no branch will be deleted as merged-PR this run.",
    );
  }

  // A FAILED open-PR fetch is `null`, NOT an empty set: an empty set would read as
  // "no branch has an open PR" and make every scaffold look reapable (fail-UNSAFE).
  // `null` forces the planner to PRESERVE every scaffold this run and report them.
  const ghOpen = runner("gh", ["pr", "list", "--state", "open", "--limit", "500", "--json", "headRefName"]);
  let openHeadRefs: Set<string> | null = null;
  if (ghOpen.status === 0) {
    openHeadRefs = parseMergedHeadRefs(ghOpen.stdout);
  } else {
    console.warn(
      "repo-hygiene: WARN could not list OPEN PRs (gh missing/unauthenticated?) — " +
        "NO scaffold worktree or branch will be reaped this run; all are PRESERVED and " +
        "reported (cannot prove none has an open PR). Re-run once gh works to reap them.",
    );
  }

  return { worktrees, branches, mergedHeadRefs, openHeadRefs, currentBranch };
}

export interface ExecuteResult {
  worktreesRemoved: number;
  branchesDeleted: number;
  failures: string[];
}

/** Apply a plan against git. `runner` is injectable for offline tests; it
 *  defaults to the real command runner. The lock re-guard below is independent
 *  of the planner's lock exclusion — a --force must NEVER override a lock, so it
 *  is re-asserted here before any force path even runs. */
export function execute(plan: HygienePlan, runner: CommandRunner = run): ExecuteResult {
  const failures: string[] = [];
  let worktreesRemoved = 0;

  for (const w of plan.worktreesToRemove) {
    // Belt-and-suspenders: the planner already excludes locked worktrees, but a
    // --force must NEVER override a lock, so re-assert before any force path.
    if (w.locked) {
      failures.push(`refused to remove locked worktree ${w.path} (planner bug — skipped)`);
      continue;
    }
    const r = runner("git", ["worktree", "remove", w.path]);
    if (r.status !== 0) {
      // A clean removal was refused (dirty/untracked files in a dead worktree).
      // --force is authorized here precisely because w is unlocked.
      const forced = runner("git", ["worktree", "remove", "--force", w.path]);
      if (forced.status !== 0) {
        failures.push(`git worktree remove failed for ${w.path}: ${(forced.stderr || r.stderr).trim()}`);
        continue;
      }
      console.log(`  removed worktree ${w.path} (forced — had dirty/untracked files)`);
    } else {
      console.log(`  removed worktree ${w.path}`);
    }
    worktreesRemoved++;
  }

  // Reap admin entries for worktrees whose directories are already gone.
  const pruned = runner("git", ["worktree", "prune"]);
  if (pruned.status !== 0) failures.push(`git worktree prune failed: ${pruned.stderr.trim()}`);

  let branchesDeleted = 0;
  for (const b of plan.branchesToDelete) {
    const r = runner("git", ["branch", "-D", b.name]);
    if (r.status !== 0) {
      failures.push(`git branch -D failed for ${b.name}: ${r.stderr.trim()}`);
      continue;
    }
    console.log(`  deleted branch ${b.name} (${b.reason})`);
    branchesDeleted++;
  }

  return { worktreesRemoved, branchesDeleted, failures };
}

function printPlan(plan: HygienePlan, dryRun: boolean): void {
  const verb = dryRun ? "would remove" : "removing";
  console.log(`repo-hygiene: ${plan.worktreesToRemove.length} worktree(s) to reap, ${verb}:`);
  for (const w of plan.worktreesToRemove) {
    console.log(`  - ${w.path} (branch ${w.branch ?? "<detached>"})`);
  }
  console.log(
    `repo-hygiene: ${plan.branchesToDelete.length} branch(es) to delete` + (dryRun ? " (dry-run):" : ":"),
  );
  for (const b of plan.branchesToDelete) console.log(`  - ${b.name} (${b.reason})`);
}

/** Injection seam for the offline tests: `main` reads its facts and its effects
 *  through these, so a test can prove --dry-run runs no effects and that a live
 *  run does, without touching real git. Defaults are the real implementations. */
export interface MainDeps {
  gather: () => HygieneInput;
  exec: (plan: HygienePlan) => ExecuteResult;
  argv: string[];
}

export function main(deps: MainDeps = { gather: gatherInput, exec: execute, argv: process.argv }): void {
  const dryRun = deps.argv.includes("--dry-run");
  console.log(`repo-hygiene: ${dryRun ? "DRY RUN (planning only, no changes)" : "cleaning"}`);

  const input = deps.gather();
  const plan = planHygiene(input);

  printPlan(plan, dryRun);

  let worktreesRemoved = plan.worktreesToRemove.length;
  let branchesDeleted = plan.branchesToDelete.length;
  let failures: string[] = [];

  if (!dryRun) {
    const result = deps.exec(plan);
    worktreesRemoved = result.worktreesRemoved;
    branchesDeleted = result.branchesDeleted;
    failures = result.failures;
  }

  console.log("");
  console.log("repo-hygiene: SUMMARY");
  console.log(`  worktrees removed: ${dryRun ? `${worktreesRemoved} (planned)` : worktreesRemoved}`);
  console.log(`  branches deleted:  ${dryRun ? `${branchesDeleted} (planned)` : branchesDeleted}`);

  // Worktrees we refused to reap because their branch could not be proven dead
  // (an open PR or unpushed work) — surfaced so a human sees they were spared.
  if (plan.worktreesPreserved.length === 0) {
    console.log("  agent worktrees preserved (unmerged/open-PR work): none");
  } else {
    console.log(
      `  agent worktrees preserved (NOT removed — hold unmerged/open-PR work): ${plan.worktreesPreserved.length}`,
    );
    for (const w of plan.worktreesPreserved) {
      console.log(`    - ${w.path} (branch ${w.branch ?? "<detached>"})`);
    }
  }

  // The whole reason this is not "just prune everything": these need a human.
  if (plan.unmergedNoPrBranches.length === 0) {
    console.log("  unmerged / open-PR branches to review: none");
  } else {
    console.log(
      `  unmerged / open-PR branches to review (NOT deleted — a human decides): ${plan.unmergedNoPrBranches.length}`,
    );
    for (const b of plan.unmergedNoPrBranches) console.log(`    - ${b}`);
  }

  if (failures.length > 0) {
    console.log(`  failures (non-fatal, ${failures.length}):`);
    for (const f of failures) console.log(`    - ${f}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    // A stand-up hygiene pass must never brick the stand-up. Report and exit 0.
    console.error(`repo-hygiene: error, no changes guaranteed: ${String(err)}`);
  }
  process.exit(0);
}
