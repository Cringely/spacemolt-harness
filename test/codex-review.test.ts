import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/planner/runner";
import {
  parsePrNumber,
  parseArgs,
  buildReviewPrompt,
  buildCodexArgs,
  buildCodexEnv,
  reviewPr,
  DEFAULT_MODEL,
} from "../scripts/codex-review";

function authFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "smcodex-review-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, "{}");
  return path;
}

/** codex JSONL success stream (same shape the planner captured live). */
function jsonl(agentText: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: agentText } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n") + "\n";
}

describe("parsePrNumber / parseArgs", () => {
  test("accepts a positive integer", () => {
    expect(parsePrNumber("446")).toBe(446);
  });

  test.each(["0", "-5", "12.5", "abc", "", "1e3", " 7 ", "446;rm"])(
    "rejects non-positive-integer %j",
    (bad) => {
      expect(() => parsePrNumber(bad)).toThrow();
    },
  );

  test("undefined arg throws usage", () => {
    expect(() => parsePrNumber(undefined)).toThrow(/usage/);
  });

  test("parseArgs pulls the PR number and optional --model", () => {
    expect(parseArgs(["446"])).toEqual({ prNumber: 446, model: undefined });
    expect(parseArgs(["446", "--model", "gpt-x"])).toEqual({ prNumber: 446, model: "gpt-x" });
    expect(parseArgs(["--model", "gpt-x", "446"])).toEqual({ prNumber: 446, model: "gpt-x" });
  });

  test("parseArgs requires a value after --model", () => {
    expect(() => parseArgs(["446", "--model"])).toThrow(/--model requires a value/);
  });

  test("parseArgs with no positional throws usage", () => {
    expect(() => parseArgs(["--model", "gpt-x"])).toThrow(/usage/);
  });
});

describe("buildReviewPrompt", () => {
  const prompt = buildReviewPrompt({
    number: 446,
    title: "docs: tidy the state block",
    body: "Presentation-only refresh.",
    diff: "diff --git a/docs/STATE.md b/docs/STATE.md\n+hello",
  });

  test("carries the diff, the PR body, and the number", () => {
    expect(prompt).toContain("PR #446: docs: tidy the state block");
    expect(prompt).toContain("Presentation-only refresh.");
    expect(prompt).toContain("diff --git a/docs/STATE.md");
  });

  test("states the review contract: every finding, severity+confidence, file:line, ADVANCE/REVISE", () => {
    expect(prompt).toContain("Report EVERY finding");
    expect(prompt).toMatch(/severity/i);
    expect(prompt).toMatch(/confidence/i);
    expect(prompt).toMatch(/file:line/i);
    expect(prompt).toContain("ADVANCE or REVISE");
  });

  test("frames the seat as advisory, Claude keeps authority", () => {
    expect(prompt).toMatch(/advisory/i);
    expect(prompt).toMatch(/Claude reviewer holds final/i);
  });

  test("empty body becomes a placeholder, not a blank", () => {
    const p = buildReviewPrompt({ number: 1, title: "t", body: "   ", diff: "d" });
    expect(p).toContain("(no description)");
  });
});

describe("buildCodexArgs — the verified sandbox contract", () => {
  const args = buildCodexArgs("gpt-5.6-terra", "/neutral");

  test("matches the read-only spike flags; prompt via stdin (trailing -)", () => {
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ephemeral");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("--cd") + 1]).toBe("/neutral");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-terra");
    expect(args[args.length - 1]).toBe("-");
  });
});

describe("buildCodexEnv — secret hygiene", () => {
  test("drops everything not on the allowlist; keeps what codex needs", () => {
    const src = {
      PATH: "/usr/bin",
      CODEX_HOME: "/home/u/.codex",
      SPACEMOLT_SESSION: "sekret-session",
      ANTHROPIC_API_KEY: "sk-should-not-pass",
      OPENAI_API_KEY: "sk-should-not-pass-either",
      SOME_REPO_TOKEN: "nope",
    };
    const out = buildCodexEnv(src);
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["CODEX_HOME"]).toBe("/home/u/.codex");
    expect(out["SPACEMOLT_SESSION"]).toBeUndefined();
    expect(out["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(out["OPENAI_API_KEY"]).toBeUndefined();
    expect(out["SOME_REPO_TOKEN"]).toBeUndefined();
  });
});

describe("reviewPr — full path with mocked spawn (zero live calls)", () => {
  const gh = async (args: string[]): Promise<string> => {
    if (args[1] === "diff") return "diff --git a/x b/x\n+line";
    if (args[1] === "view") return JSON.stringify({ title: "a title", body: "a body" });
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };

  test("passes the gathered diff+body to codex on stdin, returns the verdict", async () => {
    let seenArgs: string[] = [];
    let seenStdin: string | undefined;
    let seenEnv: Record<string, string> = {};
    const run: Runner = async (args, env, stdin) => {
      seenArgs = args;
      seenStdin = stdin;
      seenEnv = env;
      return { stdout: jsonl("finding: none.\nADVANCE"), exitCode: 0 };
    };
    const verdict = await reviewPr(446, {
      run,
      gh,
      authPath: authFile(),
      workDir: "/n",
      env: { PATH: "/usr/bin", SPACEMOLT_SESSION: "secret" },
    });
    expect(verdict).toContain("ADVANCE");
    expect(seenArgs[0]).toBe("exec");
    expect(seenArgs[seenArgs.length - 1]).toBe("-");
    expect(seenArgs).toContain(DEFAULT_MODEL);
    expect(seenStdin).toContain("a body");
    expect(seenStdin).toContain("diff --git a/x b/x");
    // secret hygiene end to end: the injected repo secret never reaches codex
    expect(seenEnv["SPACEMOLT_SESSION"]).toBeUndefined();
    expect(seenEnv["PATH"]).toBe("/usr/bin");
  });

  test("returns the LAST agent_message when codex emits a preamble then the verdict", async () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "let me look..." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "medium/high src/x.ts:10 off-by-one\nREVISE" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const run: Runner = async () => ({ stdout, exitCode: 0 });
    const verdict = await reviewPr(1, { run, gh, authPath: authFile(), workDir: "/n" });
    expect(verdict).toContain("REVISE");
    expect(verdict).not.toContain("let me look");
  });

  test("missing auth artifact fails fast with the login command, no gh/spawn", async () => {
    let ghCalled = false;
    let ran = false;
    const run: Runner = async () => { ran = true; return { stdout: "", exitCode: 0 }; };
    const trackingGh = async (a: string[]): Promise<string> => { ghCalled = true; return gh(a); };
    await expect(
      reviewPr(1, { run, gh: trackingGh, authPath: "/no/such/auth.json", workDir: "/n" }),
    ).rejects.toThrow(/codex login --device-auth/);
    expect(ghCalled).toBe(false);
    expect(ran).toBe(false);
  });

  test("non-zero codex exit surfaces as an error", async () => {
    const run: Runner = async () => ({ stdout: "boom", exitCode: 1 });
    await expect(
      reviewPr(1, { run, gh, authPath: authFile(), workDir: "/n" }),
    ).rejects.toThrow(/codex exec failed/);
  });

  test("exit 0 but no agent_message surfaces as an error", async () => {
    const run: Runner = async () => ({ stdout: JSON.stringify({ type: "turn.completed" }), exitCode: 0 });
    await expect(
      reviewPr(1, { run, gh, authPath: authFile(), workDir: "/n" }),
    ).rejects.toThrow(/no agent_message/);
  });
});
