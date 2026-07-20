#!/usr/bin/env bun
// codex-review — a cross-model PR review seat (ADVISORY).
//
// Given a PR number, it gathers `gh pr diff <n>` plus the PR title/body,
// wraps them in the same review contract our task-reviewer briefs use, and
// asks OpenAI's Codex CLI (GPT-backed, $0 marginal on the operator's ChatGPT
// subscription) for a second opinion from a DIFFERENT model family than the
// Claude implement+review pairs. Its findings feed the Claude reviewer, who
// keeps ADVANCE/REVISE authority — this seat never decides a merge.
// See docs/wiki/cross-model-outsider.md and docs/wiki/review-council.md.
//
// Invocation contract (SAME as the codex-subscription planner, verified live
// 2026-07-17 on codex-cli 0.144.3 — src/planner/codex-subscription.ts documents
// each flag):
//   codex exec --json --ignore-user-config --skip-git-repo-check --ephemeral
//              --sandbox read-only --cd <neutral dir> --model <m> -
// with the review prompt on stdin (trailing `-`), argv flags-only.
//   --sandbox read-only     tightest sandbox codex exec offers: model-generated
//                           shell still runs but on a read-only FS with NO
//                           network. It cannot write files or reach anything
//                           beyond the model endpoint.
//   --ignore-user-config    the operator's ~/.codex/config.toml declares MCP
//                           servers and a notify hook a headless review must
//                           never start. Auth still reads from CODEX_HOME.
//   --cd <neutral dir>      codex treats cwd as a workspace; an empty temp dir
//                           keeps it from discovering this repo. Its whole world
//                           is the diff we hand it on stdin.
//   --skip-git-repo-check   the neutral dir is not a git repo.
//   --ephemeral             no session files persisted under CODEX_HOME.
//
// Secret hygiene: the codex subprocess gets a CURATED env allowlist, never the
// full process.env. Repo secrets (SpaceMolt session token, LLM keys, anything
// the harness reads from secrets/) never reach it. Auth is codex's own on-disk
// artifact under CODEX_HOME, existence-checked but never read or logged.

import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunner, type Runner } from "../src/planner/runner";
import { lastAgentMessage } from "../src/planner/codex-subscription";

export const DEFAULT_MODEL = "gpt-5.6-terra";

// Only these pass to the codex subprocess. Everything else in process.env —
// including any repo secret — is dropped. The list is the minimum codex needs
// to find its binary, its auth (CODEX_HOME / home dir), and a temp path.
const ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT",
  "CODEX_HOME",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SystemRoot", "SystemDrive", "windir", "ComSpec",
  "TEMP", "TMP", "TMPDIR",
  "APPDATA", "LOCALAPPDATA",
  "LANG", "LC_ALL", "TERM",
] as const;

export interface ReviewInput {
  number: number;
  title: string;
  body: string;
  diff: string;
}

export interface CliArgs {
  prNumber: number;
  model?: string;
}

/** Validate the PR number: a positive integer, nothing else. */
export function parsePrNumber(arg: string | undefined): number {
  if (arg === undefined) throw new Error(USAGE);
  if (!/^[0-9]+$/.test(arg)) throw new Error(`invalid PR number: ${JSON.stringify(arg)} (want a positive integer)`);
  const n = Number(arg);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid PR number: ${arg}`);
  return n;
}

const USAGE = "usage: bun scripts/codex-review.ts <pr-number> [--model <m>]";

/** Pure CLI parse: `<pr-number> [--model <m>]`. */
export function parseArgs(argv: string[]): CliArgs {
  let model: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--model requires a value");
      model = v;
      continue;
    }
    positional.push(a);
  }
  if (positional.length === 0) throw new Error(USAGE);
  return { prNumber: parsePrNumber(positional[0]), model };
}

/**
 * The review contract, mirroring docs/charters/task-reviewer.md: report every
 * finding with severity + confidence, no filtering, file:line cites, verdict
 * line ADVANCE or REVISE. Framed as advisory so the model knows a Claude
 * reviewer holds final authority.
 */
export function buildReviewPrompt(input: ReviewInput): string {
  return [
    "You are an independent cross-model code reviewer. You did NOT author this change and never saw it being made — that outside view is your entire value.",
    "You are an ADVISORY second opinion from a different model family. A Claude reviewer holds final ADVANCE/REVISE authority and will read your findings; be the outside eye that questions what the author's own model family takes for granted.",
    "",
    "Contract:",
    "- Report EVERY finding, including low-severity and low-confidence ones. Do not filter for importance or confidence; a downstream reviewer ranks them.",
    "- For each finding give: severity (critical/high/medium/low), confidence (high/medium/low), and a file:line cite drawn from the diff.",
    "- The bar is correct-AND-smallest: a change that is correct but larger than it needs to be is REVISE. Name the smaller alternative when you see one.",
    "- Zero real findings = say zero. Do not manufacture nits; a fake finding buries a real one.",
    "- End your reply with a single final line containing exactly ADVANCE or REVISE and nothing else.",
    "",
    `PR #${input.number}: ${input.title}`,
    "",
    "=== PR DESCRIPTION ===",
    input.body.trim() || "(no description)",
    "",
    "=== DIFF ===",
    input.diff,
  ].join("\n");
}

/** codex exec argv — flags only; the prompt travels via stdin (trailing `-`). */
export function buildCodexArgs(model: string, workDir: string): string[] {
  return [
    "exec",
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox", "read-only",
    "--cd", workDir,
    "--model", model,
    "-",
  ];
}

/** Curated env: allowlist only, so no repo secret reaches the subprocess. */
export function buildCodexEnv(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function neutralWorkDir(): string {
  const dir = join(tmpdir(), "smcodex-review-workdir");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function defaultGh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.slice(0, 300)}`);
  return stdout;
}

export interface ReviewDeps {
  run?: Runner;
  gh?: (args: string[]) => Promise<string>;
  env?: Record<string, string | undefined>;
  authPath?: string;
  workDir?: string;
  model?: string;
}

/**
 * Gather the PR, ask codex, return its verdict text. Every external edge is a
 * seam (run, gh) so tests exercise the full path with zero live calls.
 */
export async function reviewPr(prNumber: number, deps: ReviewDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const model = deps.model ?? DEFAULT_MODEL;
  const codexHome = env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const authPath = deps.authPath ?? join(codexHome, "auth.json");
  // Fail fast before any gh call or spawn: no auth artifact means codex 401s.
  // Existence only — the file's contents are codex's business, never read.
  if (!existsSync(authPath)) {
    throw new Error(`missing codex auth artifact: ${authPath}\nRun: codex login --device-auth`);
  }

  const gh = deps.gh ?? defaultGh;
  const diff = await gh(["pr", "diff", String(prNumber)]);
  const metaRaw = await gh(["pr", "view", String(prNumber), "--json", "title,body"]);
  const meta = JSON.parse(metaRaw) as { title?: string; body?: string };
  const prompt = buildReviewPrompt({
    number: prNumber,
    title: meta.title ?? "",
    body: meta.body ?? "",
    diff,
  });

  const run = deps.run ?? defaultRunner("codex");
  const workDir = deps.workDir ?? neutralWorkDir();
  const args = buildCodexArgs(model, workDir);
  const { stdout, exitCode } = await run(args, buildCodexEnv(env), prompt);
  if (exitCode !== 0) {
    throw new Error(`codex exec failed (exit ${exitCode}): ${stdout.slice(0, 400)}`);
  }
  const verdict = lastAgentMessage(stdout);
  if (verdict === undefined) {
    throw new Error(`codex produced no agent_message: ${stdout.slice(0, 200)}`);
  }
  return verdict;
}

async function main(): Promise<void> {
  const { prNumber, model } = parseArgs(process.argv.slice(2));
  const verdict = await reviewPr(prNumber, model === undefined ? {} : { model });
  process.stdout.write(verdict.endsWith("\n") ? verdict : verdict + "\n");
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
