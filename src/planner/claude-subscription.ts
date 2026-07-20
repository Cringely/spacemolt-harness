import { readFileSync } from "node:fs";
import type { PlanContext, Planner, PlanResult } from "./types";
import { buildDigest } from "./digest";
import { defaultRunner, type Runner } from "./runner";
import { classifyClaudeFailure, TokenInvalidError, SubscriptionLimitError, TransientPlannerError } from "./errors";
import { planWithSingleRetry } from "./parse";

export interface ClaudeSubscriptionOptions {
  model: string;
  tokenPath?: string;
  run?: Runner;
}

interface ClaudeResultEnvelope {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

export class ClaudeSubscriptionPlanner implements Planner {
  private tokenPath: string;
  private run: Runner;

  constructor(private opts: ClaudeSubscriptionOptions) {
    this.tokenPath = opts.tokenPath ?? "secrets/claude_oauth_token";
    this.run = opts.run ?? defaultRunner();
  }

  async plan(ctx: PlanContext): Promise<PlanResult> {
    // Shared invoke->parse->retry-once seam (parse.ts). The retry round is real
    // spend on the subscription; the seam counts it into the char totals.
    return planWithSingleRetry("claude-subscription", this.opts.model, buildDigest(ctx), (p) => this.invoke(p));
  }

  private async invoke(prompt: string): Promise<string> {
    let token: string;
    try {
      token = readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      // missing/unreadable token file: never spawn a call we know will fail
      throw new TokenInvalidError(`missing or unreadable token file: ${this.tokenPath}`);
    }
    // Live failure 2026-07-11 (planner_error event): "ENAMETOOLONG: name too
    // long, uv_spawn" -- a grown digest (surroundings+cargo+chat+retry-
    // appended error text) as an argv element overflows Windows' spawn argv
    // limit. Fix: prompt travels via stdin (Runner already supports it, see
    // runner.ts); `-p` with no inline argument tells the claude CLI to read
    // the prompt from stdin instead. argv stays flags-only, so it can never
    // grow with the digest again regardless of platform argv limits.
    const args = [
      "-p",
      "--output-format", "json",
      "--model", this.opts.model,
      "--strict-mcp-config",
      "--tools", "",
      "--no-session-persistence",
    ];
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
    const { stdout, exitCode } = await this.run(args, env, prompt);

    if (exitCode !== 0) throw fromClass(classifyClaudeFailure(stdout), stdout);

    let envelope: ClaudeResultEnvelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new TransientPlannerError(`claude-subscription: non-JSON output: ${stdout.slice(0, 200)}`);
    }
    if (envelope.is_error || envelope.subtype !== "success") {
      const detail = envelope.result ?? stdout;
      throw fromClass(classifyClaudeFailure(detail), detail);
    }
    return envelope.result ?? "";
  }
}

function fromClass(cls: ReturnType<typeof classifyClaudeFailure>, detail: string): Error {
  if (cls === "token_invalid") return new TokenInvalidError(detail);
  if (cls === "subscription_limit") return new SubscriptionLimitError(detail);
  return new TransientPlannerError(detail);
}
