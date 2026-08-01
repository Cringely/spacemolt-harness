// PreToolUse hook (matcher: Write|Edit|NotebookEdit) — the scratch-scope gate.
//
// A subagent that only needs somewhere to drop a report should not hold an
// unrestricted write. The obvious lever, dropping Write from its `tools:`
// grant, over-corrects: an agent with no write tool has no file to leave its
// findings in, so its whole report comes back as a message, into the
// dispatcher's context and the operator's view. That is the problem the
// scratch file existed to solve, reintroduced by the fix.
//
// So the grant stays and the PATH gets constrained. An agent definition
// declaring `writeScope: scratch` may write inside a scratch directory and
// nowhere else; every other file write it attempts is denied here, before the
// permission system is consulted.
//
// Why a hook rather than a permission rule: `Edit(path)` rules do exactly this
// job, but they live in settings.json and apply session-wide. There is no
// per-subagent permission block, so a rule tight enough for a research agent
// would also bind the main session. A PreToolUse hook is the only layer that
// sees `agent_type` on the call and can scope by it. (Note the umbrella
// oddity while you are here: a `Write(path)` permission rule is accepted and
// never matched — `Edit(path)` is what governs Write, Edit, and NotebookEdit
// alike. That trap is why this gate keys on the tool call instead.)
//
// Scope is DERIVED from `.claude/agents/<type>.md` frontmatter, not from a
// list kept in this file. A hand-maintained list drifts the first time
// someone adds an agent and forgets to update it, which is the failure class
// the gate exists to close. An agent with no `writeScope` declared gets no
// opinion from this hook at all, so adding it to a project changes nothing
// until a definition opts in.
//
// Coverage boundary, stated because it is easy to over-trust: this gate sees
// the Claude Code tool call. It does not see a shell redirect or a script that
// opens a file itself. An agent holding Bash can write wherever the OS lets
// it regardless of what this hook says. Pair `writeScope` with a tools grant
// that excludes Bash, or with OS-level sandbox filesystem rules, if the agent
// is untrusted rather than merely narrow.
//
// Fail-open contract, matching agent-worktree-gate.ts: malformed stdin,
// missing fields, an unreadable definition, or our own bugs all log to stderr
// and exit 0 with no stdout, which Claude Code reads as "no opinion" and the
// normal permission flow proceeds. Only a well-formed deny emits JSON. A
// broken gate must never brick writing.
//
// Decision logic is the exported pure decide(); `bun test
// test/agent-write-scope.test.ts` exercises it with no spawn and no filesystem.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** Directory names that count as scratch. A path is in scope if any segment matches. */
const SCRATCH_SEGMENTS = new Set(["scratchpad", ".scratch"]);

export type Decision = { action: "allow" } | { action: "deny"; reason: string };

/**
 * Is `filePath` inside a scratch directory? Resolved against `cwd` when
 * relative, so a bare `../../etc/hosts` cannot slip through as "not absolute".
 */
export function inScratch(filePath: string, cwd: string): boolean {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  return abs
    .split(/[\\/]+/)
    .some((segment) => SCRATCH_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * The `writeScope` value declared in an agent definition's frontmatter, or null
 * when the file is absent, unreadable, or declares nothing. Null means this
 * hook has no opinion — absence of a declaration is not a reason to block.
 */
export function readWriteScope(agentType: string, projectDir: string): string | null {
  if (!agentType) return null;
  const defPath = join(projectDir, ".claude", "agents", `${agentType}.md`);
  if (!existsSync(defPath)) return null;
  try {
    const head = readFileSync(defPath, "utf8").slice(0, 4096);
    return head.match(/^writeScope:\s*(\S+)\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Deny a write that a scratch-scoped agent aims outside its scratch directory.
 * Every other combination allows: unscoped agents, the main session (no
 * agent_type), and in-scope writes.
 */
export function decide(
  scope: string | null,
  filePath: string | undefined,
  cwd: string,
): Decision {
  if (scope !== "scratch") return { action: "allow" };
  if (!filePath) return { action: "allow" };
  if (inScratch(filePath, cwd)) return { action: "allow" };
  return {
    action: "deny",
    reason:
      `This agent declares writeScope: scratch, so it may only write inside a ` +
      `scratch directory. ${filePath} is outside one. Write your report to the ` +
      `session scratchpad and send the path, or report your findings in a message ` +
      `if they are short enough to fit in one.`,
  };
}

if (import.meta.main) {
  try {
    const payload = JSON.parse(await Bun.stdin.text());
    const cwd = payload.cwd ?? process.cwd();
    const scope = readWriteScope(
      payload.agent_type ?? "",
      process.env.CLAUDE_PROJECT_DIR ?? cwd,
    );
    const verdict = decide(scope, payload.tool_input?.file_path, cwd);
    if (verdict.action === "deny") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: verdict.reason,
          },
        }),
      );
    }
  } catch (err) {
    console.error(`agent-write-scope: ${err}`);
  }
  process.exit(0);
}
