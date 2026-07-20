import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanContext, Planner, PlanResult } from "./types";
import { buildDigest } from "./digest";
import { defaultRunner, type Runner } from "./runner";
import { classifyCodexFailure, TokenInvalidError, SubscriptionLimitError, TransientPlannerError } from "./errors";
import { planWithSingleRetry } from "./parse";

// The second zero-marginal-cost vendor (#311): OpenAI's Codex CLI signed in
// with the operator's ChatGPT subscription -- the claude-subscription trick
// (M-03) on the other vendor's plan. A SIBLING of ClaudeSubscriptionPlanner:
// same shell-out Runner seam, same buildDigest -> planWithSingleRetry flow,
// different CLI contract.
//
// Invocation contract (VERIFIED live 2026-07-17, codex-cli 0.144.3, 3-call
// spike authorized by #311):
//   codex exec --json --ignore-user-config --skip-git-repo-check --ephemeral
//              --sandbox read-only --cd <neutral dir> --model <m> -
// with the prompt on stdin (the trailing `-`; argv stays flags-only, the same
// ENAMETOOLONG defense claude-subscription carries). Flags are each
// load-bearing:
//   --ignore-user-config  the operator's ~/.codex/config.toml declares MCP
//                         servers, plugins, and a notify hook; a headless
//                         planner must start NONE of them. Auth still reads
//                         from CODEX_HOME (per `codex exec --help`).
//   --cd <neutral dir>    codex treats its cwd as a workspace and would
//                         otherwise discover the harness repo (AGENTS.md,
//                         docs). The planner's world is the digest, nothing
//                         else, so cwd is an empty temp dir.
//   --sandbox read-only   the tightest sandbox codex exec offers for model-
//                         generated shell: commands still RUN, but on a read-
//                         only filesystem with NO network. Unlike the claude
//                         sibling's `--tools ""`, codex exec has no flag to
//                         disable the shell/tool loop -- verified against
//                         codex-cli 0.144.3 `codex exec --help`, whose only
//                         sandbox choices are read-only | workspace-write |
//                         danger-full-access. So the model CAN run a read-only
//                         shell command and READ any container-readable file
//                         (e.g. the sibling /run/secrets) -- a strictly weaker
//                         read boundary than the claude sibling. Accepted,
//                         documented tradeoff: the read-only sandbox has no
//                         network, so a read secret can't be exfiltrated over
//                         the wire; the only egress is the plan text we already
//                         parse and length-bound, and the planner's sole input
//                         is our own game-state digest, not attacker input.
//                         Rationale in docs/wiki/security-baseline.md.
//   --skip-git-repo-check the neutral dir is not a git repo; without this
//                         codex refuses to run there.
//   --ephemeral           no session files persisted under ~/.codex/sessions.
//
// Output (captured live): JSONL events on stdout. The plan text arrives as
// {"type":"item.completed","item":{"type":"agent_message","text":...}};
// success ends with turn.completed, failure with turn.failed whose message
// embeds the backend's JSON error carrying a numeric `status`.
export interface CodexSubscriptionOptions {
  model: string;
  /** Auth artifact to pre-check (default $CODEX_HOME/auth.json, else ~/.codex/auth.json).
   * Managed by `codex login`, NOT by our secrets/ dir -- never read, only existence-checked. */
  authPath?: string;
  /** Neutral working dir handed to --cd. Default: a fresh empty temp dir. */
  workDir?: string;
  run?: Runner;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
}

export class CodexSubscriptionPlanner implements Planner {
  private authPath: string;
  private run: Runner;
  private workDirPath?: string;

  constructor(private opts: CodexSubscriptionOptions) {
    // CODEX_HOME resolves BOTH our existence-check (below) and codex's own
    // auth read/write to $CODEX_HOME/auth.json. codex refreshes its OAuth token
    // during use and rewrites auth.json in place, so in the container CODEX_HOME
    // MUST be a writable, persistent bind-mount (not a read-only Docker secret,
    // not ephemeral /tmp) or the refresh fails / the rotated token is lost on
    // restart. See the compose files and docs/wiki/operations.md.
    const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
    this.authPath = opts.authPath ?? join(codexHome, "auth.json");
    this.run = opts.run ?? defaultRunner("codex");
    this.workDirPath = opts.workDir;
  }

  async plan(ctx: PlanContext): Promise<PlanResult> {
    // Shared invoke->parse->retry-once seam (parse.ts). The retry round is real
    // subscription spend; the seam counts it into the char totals.
    return planWithSingleRetry("codex-subscription", this.opts.model, buildDigest(ctx), (p) => this.invoke(p));
  }

  /**
   * Lazily created so a test-injected runner never touches the filesystem.
   * ONE deterministic path, reused across every plan() call and every process
   * restart -- not mkdtempSync (issue #314 followup from #313's review: a
   * fresh mkdtemp dir per restart accumulated on disk forever with no cleanup
   * path). Safe to share: codex's --sandbox read-only means nothing is ever
   * written here, so there is no concurrent-process state to collide over,
   * and reusing the path is the smaller fix than adding a dispose lifecycle
   * (ponytail: one line beats fifty).
   */
  private workDir(): string {
    if (!this.workDirPath) {
      const dir = join(tmpdir(), "smcodex-workdir");
      mkdirSync(dir, { recursive: true });
      this.workDirPath = dir;
    }
    return this.workDirPath;
  }

  private async invoke(prompt: string): Promise<string> {
    // Fail-fast parity with the sibling's token-file check: no auth artifact
    // means every spawn would fail, so never spawn one. Existence only -- the
    // file's contents are codex's business and must never be read or logged.
    if (!existsSync(this.authPath)) {
      throw new TokenInvalidError(`missing codex auth artifact: ${this.authPath} (run \`codex login\`)`);
    }
    const args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "read-only",
      "--cd", this.workDir(),
      "--model", this.opts.model,
      "-",
    ];
    let stdout: string;
    let exitCode: number;
    try {
      // No token in env (auth is codex's on-disk artifact); the cast strips
      // ProcessEnv's `| undefined` index for the Runner signature.
      ({ stdout, exitCode } = await this.run(args, { ...process.env } as Record<string, string>, prompt));
    } catch (e) {
      // Spawn itself failed (codex not on PATH): transient, not a crash -- the
      // agent's normal backoff applies while the operator fixes the install.
      throw new TransientPlannerError(`codex-subscription: spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (exitCode !== 0) throw fromClass(classifyCodexFailure(stdout), stdout.slice(0, 400));

    const text = lastAgentMessage(stdout);
    if (text === undefined) {
      throw new TransientPlannerError(`codex-subscription: no agent_message in output: ${stdout.slice(0, 200)}`);
    }
    return text;
  }
}

/**
 * The model's final say: the LAST agent_message in the JSONL stream. Codex may
 * emit several (a preamble, then the answer); the siblings' envelope carries
 * one result field, and "last message wins" is this stream's equivalent.
 * Non-JSON lines are skipped rather than fatal -- only the events we key on
 * need to parse.
 */
export function lastAgentMessage(stdout: string): string | undefined {
  let text: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
      text = ev.item.text;
    }
  }
  return text;
}

function fromClass(cls: ReturnType<typeof classifyCodexFailure>, detail: string): Error {
  if (cls === "token_invalid") return new TokenInvalidError(detail);
  if (cls === "subscription_limit") return new SubscriptionLimitError(detail);
  return new TransientPlannerError(detail);
}
