import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSubscriptionPlanner } from "../src/planner/codex-subscription";
import type { PlanContext } from "../src/planner/types";
import type { Runner } from "../src/planner/runner";
import { TokenInvalidError, SubscriptionLimitError, TransientPlannerError } from "../src/planner/errors";

function authFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "smcodex-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, "{}");
  return path;
}

const ctx: PlanContext = {
  persona: "miner", goals: [], wake: { reason: "no_plan" },
  statusSummary: "credits 0, fuel 100/100, hull 100/100, cargo 0/50, undocked",
  recentEvents: [],
};

const validPlanJson = JSON.stringify({ goal: "mine", steps: [{ action: "mine", params: {} }] });

/** JSONL success stream as captured live 2026-07-17 (spike, codex-cli 0.144.3). */
function jsonl(agentText: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: agentText } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n") + "\n";
}

/** JSONL failure stream as captured live 2026-07-17 (invalid model, exit 1). */
function failJsonl(embeddedStatus: number, message: string): string {
  const inner = JSON.stringify({ type: "error", status: embeddedStatus, error: { type: "err", message } });
  return [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "error", message: inner }),
    JSON.stringify({ type: "turn.failed", error: { message: inner } }),
  ].join("\n") + "\n";
}

describe("CodexSubscriptionPlanner", () => {
  // Derivation: the 2026-07-17 spike (issue #311) mandates the exact
  // invocation `codex exec --json --ignore-user-config --skip-git-repo-check
  // --ephemeral --sandbox read-only --cd <neutral dir> --model <m> -` with the
  // prompt via stdin. --ignore-user-config is load-bearing: the operator's
  // ~/.codex/config.toml declares MCP servers and plugins a headless planner
  // must never start. This test is the enforcement point for that contract.
  test("invokes codex with the exact spike flags; prompt travels via stdin, never argv", async () => {
    let seenArgs: string[] = [];
    let seenStdin: string | undefined;
    const run: Runner = async (args, _env, stdin) => {
      seenArgs = args;
      seenStdin = stdin;
      return { stdout: jsonl(validPlanJson), exitCode: 0 };
    };
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/neutral", run });
    await planner.plan(ctx);

    expect(seenArgs[0]).toBe("exec");
    expect(seenArgs).toContain("--json");
    expect(seenArgs).toContain("--ignore-user-config");
    expect(seenArgs).toContain("--skip-git-repo-check");
    expect(seenArgs).toContain("--ephemeral");
    expect(seenArgs).toContain("--sandbox");
    expect(seenArgs).toContain("read-only");
    expect(seenArgs).toContain("--cd");
    expect(seenArgs).toContain("/neutral");
    expect(seenArgs).toContain("--model");
    expect(seenArgs).toContain("gpt-5.6-terra");
    expect(seenArgs[seenArgs.length - 1]).toBe("-"); // read prompt from stdin
    expect(seenArgs.join(" ")).not.toContain("credits 0"); // digest never in argv
    expect(seenStdin).toContain("credits 0");
    expect(seenStdin).toContain("miner");
  });

  // The codex working directory must never be the harness cwd (the repo): a
  // repo cwd would hand the model AGENTS.md and project context, and read-only
  // sandbox or not, the planner must see only its digest.
  test("defaults --cd to a temp dir outside the current working directory", async () => {
    let seenArgs: string[] = [];
    const run: Runner = async (args) => {
      seenArgs = args;
      return { stdout: jsonl(validPlanJson), exitCode: 0 };
    };
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), run });
    await planner.plan(ctx);
    const cd = seenArgs[seenArgs.indexOf("--cd") + 1]!;
    expect(cd.length).toBeGreaterThan(0);
    expect(cd).not.toBe(process.cwd());
    expect(cd.startsWith(process.cwd())).toBe(false);
  });

  test("extracts the last agent_message from the JSONL stream", async () => {
    // Two agent messages: a preamble and the plan. The plan is the final say.
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "thinking..." } }),
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: validPlanJson } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const run: Runner = async () => ({ stdout, exitCode: 0 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    const { plan } = await planner.plan(ctx);
    expect(plan.goal).toBe("mine");
  });

  // Coverage for lastAgentMessage's try/catch-continue (issue #314 followup
  // from #313's review: the tolerance existed but no test proved it). Garbage
  // lines land BETWEEN two valid agent_message events; the fix must skip them
  // and still key on the LAST valid one. Ablated: removing the try/catch makes
  // JSON.parse throw on the garbage line, which rejects planner.plan() instead
  // of resolving -- this test fails the moment that guard is removed.
  test("skips interleaved non-JSON lines and extracts the last agent_message", async () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "thinking..." } }),
      "not json at all {{{",
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: validPlanJson } }),
      "another garbage line, also not JSON",
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const run: Runner = async () => ({ stdout, exitCode: 0 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    const { plan } = await planner.plan(ctx);
    expect(plan.goal).toBe("mine");
  });

  test("retries once with the validation error appended, then succeeds", async () => {
    let calls = 0;
    const run: Runner = async (_args, _env, stdin) => {
      calls++;
      if (calls === 1) return { stdout: jsonl(JSON.stringify({ goal: "x", steps: [] })), exitCode: 0 }; // invalid: empty steps
      expect(stdin).toContain("failed validation"); // retry prompt travels via stdin
      return { stdout: jsonl(validPlanJson), exitCode: 0 };
    };
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    const { plan } = await planner.plan(ctx);
    expect(calls).toBe(2);
    expect(plan.goal).toBe("mine");
  });

  test("throws after a second consecutive invalid response", async () => {
    const run: Runner = async () => ({ stdout: jsonl(JSON.stringify({ goal: "x", steps: [] })), exitCode: 0 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow();
  });

  // Layer 5 cost seam parity with the siblings: model + chars summed across
  // the validation retry. responseChars measures the model's text (the
  // agent_message content), not the JSONL framing around it.
  test("reports model and prompt/response chars summed across the retry round", async () => {
    let calls = 0;
    const invalidResult = JSON.stringify({ goal: "x", steps: [] });
    const run: Runner = async () => {
      calls++;
      return { stdout: jsonl(calls === 1 ? invalidResult : validPlanJson), exitCode: 0 };
    };
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-luna", authPath: authFile(), workDir: "/n", run });
    const result = await planner.plan(ctx);
    expect(calls).toBe(2);
    expect(result.model).toBe("gpt-5.6-luna");
    expect(result.responseChars).toBe(invalidResult.length + validPlanJson.length);
    expect(result.promptChars).toBeGreaterThan(0);
  });
});

describe("CodexSubscriptionPlanner writable persistent CODEX_HOME (#311 security review, PR #354)", () => {
  // The prod refresh fix: codex refreshes its OAuth token during use and
  // rewrites auth.json IN PLACE, so the container mounts CODEX_HOME as a
  // writable, persistent bind-mount (not a read-only Docker secret, not
  // ephemeral /tmp). The planner must resolve BOTH its own existence-check and
  // codex's read/write to $CODEX_HOME/auth.json. Break either wire and codex
  // reads/writes the wrong path and 401s after the first token rotation.

  test("existence-check resolves $CODEX_HOME/auth.json when no authPath is given", async () => {
    const prev = process.env["CODEX_HOME"];
    const home = mkdtempSync(join(tmpdir(), "smcodex-home-")); // empty: no auth.json inside
    process.env["CODEX_HOME"] = home;
    try {
      let ran = false;
      const run: Runner = async () => { ran = true; return { stdout: "", exitCode: 0 }; };
      const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", workDir: "/n", run });
      const err = await planner.plan(ctx).then(() => undefined).catch((e: Error) => e);
      // fail-fast before spawning, and the message names the CODEX_HOME path,
      // proving the check resolved $CODEX_HOME/auth.json, not ~/.codex/auth.json
      expect(err).toBeInstanceOf(TokenInvalidError);
      expect((err as Error).message).toContain(home);
      expect(ran).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = prev;
    }
  });

  test("passes CODEX_HOME through to the codex spawn env so refresh writes persist", async () => {
    const prev = process.env["CODEX_HOME"];
    const home = mkdtempSync(join(tmpdir(), "smcodex-home-"));
    writeFileSync(join(home, "auth.json"), "{}"); // seed so the existence-check passes
    process.env["CODEX_HOME"] = home;
    try {
      let seenEnv: Record<string, string> | undefined;
      const run: Runner = async (_args, env) => {
        seenEnv = env;
        return { stdout: jsonl(validPlanJson), exitCode: 0 };
      };
      const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", workDir: "/n", run });
      await planner.plan(ctx);
      // codex inherits CODEX_HOME, so it reads AND writes the refreshed token in
      // the writable persistent mount rather than falling back to ~/.codex
      expect(seenEnv?.["CODEX_HOME"]).toBe(home);
    } finally {
      if (prev === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = prev;
    }
  });
});

describe("CodexSubscriptionPlanner failure classes", () => {
  test("missing auth file throws TokenInvalidError before spawning", async () => {
    let ran = false;
    const run: Runner = async () => { ran = true; return { stdout: "", exitCode: 0 }; };
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: "/no/such/auth.json", workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TokenInvalidError);
    expect(ran).toBe(false); // never spawned a call we already know will fail
  });

  // The turn.failed error message embeds the backend's JSON with a numeric
  // status (captured live: {"type":"error","status":400,...} inside the
  // message string). Classification keys on that number first, like
  // classifyClaudeFailure keys on api_error_status.
  test("exit 1 with embedded status 429 throws SubscriptionLimitError", async () => {
    const run: Runner = async () => ({ stdout: failJsonl(429, "usage limit reached"), exitCode: 1 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow(SubscriptionLimitError);
  });

  test("exit 1 with embedded status 401 throws TokenInvalidError", async () => {
    const run: Runner = async () => ({ stdout: failJsonl(401, "token expired"), exitCode: 1 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TokenInvalidError);
  });

  test("exit 1 with auth prose but no status throws TokenInvalidError (text fallback)", async () => {
    const run: Runner = async () => ({ stdout: "error: not logged in, run `codex login`", exitCode: 1 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TokenInvalidError);
  });

  test("exit 1 with an unrecognized message throws TransientPlannerError", async () => {
    const run: Runner = async () => ({ stdout: failJsonl(400, "model not supported"), exitCode: 1 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TransientPlannerError);
  });

  // CLI absent: Bun.spawn throws ENOENT before any RunResult exists. The
  // planner maps it to TransientPlannerError with a hint, not a raw crash.
  test("a runner that throws (binary missing) surfaces as TransientPlannerError", async () => {
    const run: Runner = async () => { throw new Error("spawn codex ENOENT"); };
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TransientPlannerError);
  });

  test("exit 0 with no agent_message in the stream throws TransientPlannerError", async () => {
    const stdout = JSON.stringify({ type: "turn.completed", usage: {} });
    const run: Runner = async () => ({ stdout, exitCode: 0 });
    const planner = new CodexSubscriptionPlanner({ model: "gpt-5.6-terra", authPath: authFile(), workDir: "/n", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TransientPlannerError);
  });
});
