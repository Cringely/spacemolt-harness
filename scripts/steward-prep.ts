// Steward PR-prep: the doc-steward's mechanical regen steps as ONE command
// (charter step 7). Exists because a prose checklist step gets dropped —
// three consecutive steward passes skipped the backlog regen (#261). A
// script step either runs or visibly doesn't: each step must yield its
// EVIDENCE line (pasted verbatim into the completion report), so a skipped
// run shows up as a missing line the PM can see, not a silently stale doc.
//
// Steps: gen-backlog.py (docs/backlog.md from GitHub Issues), gen-roadmap.ts
// (README road-to-fleet SVGs from the milestones gate table), and the
// doc-size gate (test/doc-size.test.ts). All idempotent; run after doc
// edits, before prose-lint and the PR.
//
// Worktree-boundary invariant (#321): every regenerated file MUST land inside
// the tree steward-prep will commit from. That tree is `git rev-parse
// --show-toplevel` run from the CURRENT working directory — NOT
// `import.meta.dir`, which anchors to wherever the script FILE physically
// lives and points at the MAIN checkout when a linked worktree runs a script
// resolved through the shared checkout. When root was file-anchored, a steward
// in a worktree wrote docs/backlog.md into the main checkout: the EVIDENCE line
// ("backlog regenerated: N issues") passed while the artifact missed the PR
// (PR #318, landed manually via #320). Resolving root from CWD makes the write
// follow the tree; the guard below turns any residual escape into a hard error.
import { spawnSync } from "node:child_process";

export interface Step {
  name: string;
  cmd: string[];
  /** Turns the step's combined output into its report EVIDENCE line.
   *  Returning null means the expected receipt is missing — treated as a
   *  FAILURE, so evidence is never silently blank. */
  evidence: (output: string) => string | null;
}

export function stewardSteps(python: string): Step[] {
  return [
    {
      name: "backlog regen",
      cmd: [python, "scripts/gen-backlog.py"],
      evidence: (out) => {
        // Path is captured loosely (.+?) so the receipt survives gen-backlog.py
        // printing an absolute path (its worktree-safe form) as well as a bare
        // relative one; the count is what the EVIDENCE line reports.
        const m = out.match(/wrote .+? \((\d+) open issues\)/);
        return m ? `backlog regenerated: ${m[1]} open issues` : null;
      },
    },
    {
      name: "roadmap regen",
      cmd: ["bun", "scripts/gen-roadmap.ts"],
      evidence: () => "roadmap SVGs regenerated from the gate table",
    },
    {
      name: "doc-size gate",
      cmd: ["bun", "test", "test/doc-size.test.ts"],
      evidence: () => "doc-size gate: green",
    },
  ];
}

export type Exec = (cmd: string[]) => { status: number | null; output: string };

export interface PrepResult {
  ok: boolean;
  evidence: string[];
  /** Raw combined output of each step that ran, in order — so the caller can
   *  read back where a producer actually wrote and guard the worktree boundary
   *  (#321). */
  outputs: string[];
  failed?: string;
}

/** Run the steps in order; abort on the first failure (nonzero exit OR a
 *  missing evidence receipt). Exec is injectable so the offline test suite
 *  can exercise the contract without gh/python/network. */
export function runPrep(steps: Step[], exec: Exec): PrepResult {
  const evidence: string[] = [];
  const outputs: string[] = [];
  for (const step of steps) {
    const r = exec(step.cmd);
    outputs.push(r.output);
    if (r.status !== 0) return { ok: false, evidence, outputs, failed: step.name };
    const line = step.evidence(r.output);
    if (line === null) {
      return { ok: false, evidence, outputs, failed: `${step.name} (expected receipt missing from output)` };
    }
    evidence.push(line);
  }
  return { ok: true, evidence, outputs };
}

/** The tree steward-prep will COMMIT from: the invoking worktree's toplevel,
 *  resolved from CWD. Throws if not in a git tree — a steward that cannot name
 *  its commit tree must not silently regenerate files somewhere else (#321). */
export function worktreeToplevel(cwd: string = process.cwd()): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `steward-prep: 'git rev-parse --show-toplevel' failed in ${cwd}: ${(r.stderr ?? "").trim() || "not a git working tree"}`,
    );
  }
  return (r.stdout ?? "").trim();
}

/** Throw if `targetPath` is not inside `toplevel`. This is the guard that turns
 *  a silent worktree-boundary leak (#321) into a hard error: a regenerated file
 *  written into the MAIN checkout while the steward commits from a linked
 *  worktree would otherwise pass its EVIDENCE line while missing the PR.
 *  Paths are separator-normalized so a git toplevel (forward slashes) compares
 *  correctly against a node/os.path result (backslashes on Windows). */
export function assertInsideTree(toplevel: string, targetPath: string): void {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(toplevel);
  const target = norm(targetPath);
  const inside = target === root || target.startsWith(root + "/");
  if (!inside) {
    throw new Error(
      `steward-prep: regenerated file ${targetPath} is OUTSIDE the worktree it will commit from (${toplevel}). ` +
        `A generated file must land inside the tree the PR is built from (#321) — refusing to report a clean run.`,
    );
  }
}

/** Scan step outputs for every `wrote <path> (...)` receipt a producer emits
 *  and assert each landed inside `toplevel`. Returns the guard-violation
 *  messages (empty when all writes are in-tree). Kept pure/injectable-free so
 *  the offline suite can drive it with canned output. */
export function outputsEscapingTree(toplevel: string, outputs: string[]): string[] {
  const problems: string[] = [];
  for (const out of outputs) {
    for (const m of out.matchAll(/^wrote (.+?) \(/gm)) {
      const written = m[1]!;
      // Producers emit an ABSOLUTE path (anchored to the CWD git toplevel), so
      // the receipt is compared directly. A prior `isAbsolute ? : resolve(toplevel,…)`
      // fallback was dead in production AND broke under POSIX — a Windows-style
      // path is not POSIX-absolute, so resolve re-rooted it inside toplevel and
      // hid a real escape (#342). assertInsideTree's string compare is
      // platform-independent; no path-absoluteness check belongs here.
      try {
        assertInsideTree(toplevel, written);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  // Commit tree is CWD-anchored, not file-anchored — this is the producer fix.
  const root = worktreeToplevel();
  const python = Bun.which("python3") ?? Bun.which("python");
  if (!python) {
    console.error("steward-prep: python3/python not found (scripts/gen-backlog.py needs it)");
    process.exit(1);
  }
  const exec: Exec = (cmd) => {
    console.log(`steward-prep: running ${cmd.join(" ")}`);
    const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: root, encoding: "utf8" });
    const output = (r.stdout ?? "") + (r.stderr ?? "");
    process.stdout.write(output);
    return { status: r.status, output };
  };
  const result = runPrep(stewardSteps(python), exec);
  if (!result.ok) {
    console.error(`steward-prep: FAILED at ${result.failed}`);
    process.exit(1);
  }
  // GUARD (#321): every file a producer reported writing must be inside the
  // tree we will commit from, or this run is a silent miss dressed as success.
  const escaped = outputsEscapingTree(root, result.outputs);
  if (escaped.length > 0) {
    for (const line of escaped) console.error(line);
    process.exit(1);
  }
  console.log("\nsteward-prep: all steps ran. EVIDENCE (paste verbatim into the completion report):");
  for (const line of result.evidence) console.log(`- ${line}`);
}
