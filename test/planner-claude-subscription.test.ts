import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSubscriptionPlanner } from "../src/planner/claude-subscription";
import type { PlanContext } from "../src/planner/types";
import type { Runner } from "../src/planner/runner";
import { TokenInvalidError, SubscriptionLimitError, TransientPlannerError } from "../src/planner/errors";

function tokenFile(contents = "test-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "smtok-"));
  const path = join(dir, "claude_oauth_token");
  writeFileSync(path, contents);
  return path;
}

const ctx: PlanContext = {
  persona: "miner", goals: [], wake: { reason: "no_plan" },
  statusSummary: "credits 0, fuel 100/100, hull 100/100, cargo 0/50, undocked",
  recentEvents: [],
};

const validPlanJson = JSON.stringify({ goal: "mine", steps: [{ action: "mine", params: {} }] });

function envelope(result: string, opts?: { isError?: boolean }): string {
  return JSON.stringify({
    type: "result",
    subtype: opts?.isError ? "error" : "success",
    is_error: !!opts?.isError,
    result,
  });
}

describe("ClaudeSubscriptionPlanner", () => {
  // Derivation: Global Constraints + spike doc mandate the exact invocation
  // `claude -p --output-format json --model <model>` plus --strict-mcp-config,
  // --tools "", --no-session-persistence, with the token in env only and the
  // prompt via stdin (not an inline argument to -p). This test is the
  // enforcement point for that contract.
  test("invokes claude with the exact spike flags and passes the token via env, not argv", async () => {
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string> = {};
    const run: Runner = async (args, env) => {
      seenArgs = args;
      seenEnv = env;
      return { stdout: envelope(validPlanJson), exitCode: 0 };
    };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile("secret-tok"), run });
    await planner.plan(ctx);

    expect(seenArgs).toContain("-p");
    expect(seenArgs).toContain("--output-format");
    expect(seenArgs).toContain("json");
    expect(seenArgs).toContain("--model");
    expect(seenArgs).toContain("sonnet");
    expect(seenArgs).toContain("--strict-mcp-config");
    expect(seenArgs.includes("--mcp-config")).toBe(false); // zero MCP servers
    expect(seenArgs).toContain("--tools");
    expect(seenArgs).toContain("--no-session-persistence");
    expect(seenEnv["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("secret-tok");
    expect(seenArgs.join(" ")).not.toContain("secret-tok"); // never in argv
  });

  // ENAMETOOLONG regression (live planner_error, 2026-07-11): the prompt must
  // travel via stdin, never as an argv element, so a grown digest can't
  // overflow the platform's spawn argv limit again.
  test("passes the prompt via stdin, never as an argv element", async () => {
    let seenArgs: string[] = [];
    let seenStdin: string | undefined;
    const run: Runner = async (args, _env, stdin) => {
      seenArgs = args;
      seenStdin = stdin;
      return { stdout: envelope(validPlanJson), exitCode: 0 };
    };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await planner.plan(ctx);

    // "-p" appears bare (flag only) -- no prompt text follows it in argv.
    expect(seenArgs.join(" ")).not.toContain("credits 0"); // from ctx.statusSummary
    expect(seenArgs.join(" ")).not.toContain("miner"); // from ctx.persona
    expect(seenStdin).toContain("credits 0");
    expect(seenStdin).toContain("miner");
  });

  // Regression guard for the ENAMETOOLONG failure mode itself: a digest large
  // enough to have overflowed Windows' argv limit must construct and flow
  // through to stdin without error now that it never touches argv.
  test("handles a 100KB digest without error (would have overflowed argv previously)", async () => {
    const longCtx: PlanContext = { ...ctx, instruction: "x".repeat(100_000) };
    let seenArgsLen = 0;
    let seenStdinLen = 0;
    const run: Runner = async (args, _env, stdin) => {
      seenArgsLen = args.join(" ").length;
      seenStdinLen = stdin?.length ?? 0;
      return { stdout: envelope(validPlanJson), exitCode: 0 };
    };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    const { plan } = await planner.plan(longCtx);
    expect(plan.goal).toBe("mine");
    expect(seenStdinLen).toBeGreaterThan(100_000);
    expect(seenArgsLen).toBeLessThan(200); // flags only, never grows with the digest
  });

  test("parses the envelope's result field as the plan JSON", async () => {
    const run: Runner = async () => ({ stdout: envelope(validPlanJson), exitCode: 0 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    const { plan } = await planner.plan(ctx);
    expect(plan.goal).toBe("mine");
  });

  test("retries once with the validation error appended, then succeeds", async () => {
    let calls = 0;
    const run: Runner = async (_args, _env, stdin) => {
      calls++;
      if (calls === 1) return { stdout: envelope(JSON.stringify({ goal: "x", steps: [] })), exitCode: 0 }; // invalid: empty steps
      expect(stdin).toContain("failed validation"); // retry prompt travels via stdin, not argv
      return { stdout: envelope(validPlanJson), exitCode: 0 };
    };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    const { plan } = await planner.plan(ctx);
    expect(calls).toBe(2);
    expect(plan.goal).toBe("mine");
  });

  // Layer 5 cost seam: plan() reports the model and the prompt/response chars
  // it actually consumed, ACCUMULATED across the validation retry -- the retry
  // is real subscription spend, so a single-call count would understate cost.
  // Breakage caught: if a planner stops summing the retry (or drops model),
  // the cost/calls-per-model dashboard silently under-reports the most
  // expensive case (a thrashing agent that retries).
  test("reports model and prompt/response chars summed across the retry round", async () => {
    let calls = 0;
    const invalidResult = JSON.stringify({ goal: "x", steps: [] }); // invalid -> forces a retry
    const run: Runner = async () => {
      calls++;
      return { stdout: envelope(calls === 1 ? invalidResult : validPlanJson), exitCode: 0 };
    };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    const result = await planner.plan(ctx);
    expect(calls).toBe(2);
    expect(result.model).toBe("sonnet");
    // responseChars measures the model's actual output (the envelope's `result`
    // content, what invoke() returns -- not the CLI framing). It must be the SUM
    // of both rounds: the load-bearing assertion -- it fails if the retry
    // round's chars aren't accumulated onto the first call's.
    expect(result.responseChars).toBe(invalidResult.length + validPlanJson.length);
    // Two prompts were sent (original digest + the longer retry-with-error
    // prompt), so promptChars is certainly positive -- a zero would mean the
    // prompt side wasn't captured at all.
    expect(result.promptChars).toBeGreaterThan(0);
  });

  test("throws after a second consecutive invalid response", async () => {
    const run: Runner = async () => ({ stdout: envelope(JSON.stringify({ goal: "x", steps: [] })), exitCode: 0 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow();
  });
});

describe("ClaudeSubscriptionPlanner failure classes", () => {
  test("missing token file throws TokenInvalidError before spawning", async () => {
    let ran = false;
    const run: Runner = async () => { ran = true; return { stdout: "", exitCode: 0 }; };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: "/no/such/file", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TokenInvalidError);
    expect(ran).toBe(false); // never spawned a call we already know will fail
  });

  test("non-zero exit with usage-limit text throws SubscriptionLimitError", async () => {
    const run: Runner = async () => ({ stdout: "Error: usage limit reached, resets at 6pm", exitCode: 1 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow(SubscriptionLimitError);
  });

  test("non-zero exit with an unrecognized message throws TransientPlannerError", async () => {
    const run: Runner = async () => ({ stdout: "network unreachable", exitCode: 1 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow(TransientPlannerError);
  });

  test("is_error envelope with auth text throws TokenInvalidError even on exit 0", async () => {
    const run: Runner = async () => ({ stdout: envelope("invalid oauth token", { isError: true }), exitCode: 0 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow(TokenInvalidError);
  });
});
