// Durable scheduler (#114) Task C3: charter-armed spawn composer + runner.
// A job spawn is a fresh headless `claude -p` against the host checkout:
// charter inlined VERBATIM (charters/README.md dispatch rule — paraphrase
// drift is the failure charters exist to kill), STATE `## NOW` extract,
// backlog pointer, and a per-job work order carrying the standing
// observe-and-file-only clause (D1: stages 1-2 never dispatch, never merge).
//
// Security posture (spec §Security, binding):
// - Prompt travels via STDIN; argv stays flags-only (the ENAMETOOLONG lesson,
//   src/planner/claude-subscription.ts:44 — an argv prompt overflows spawn
//   limits, and argv is visible in `ps`).
// - Secret VALUES travel by child env only — never argv, never logs.
// - allowedTools is a closed per-job list (jobs.ts); the spawn passes it
//   verbatim, because LLM output is untrusted input (security-baseline.md).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeActiveCycle } from "./filing";
import type { JobDef } from "./jobs";
import { POLICY_PATHS } from "./policy-paths";
import { loadAnchors, saveAnchors } from "./state";

export interface SpawnHandle {
  // stdout is the child's captured output — the `claude -p --output-format json`
  // result envelope, from which runJob reads the spawn's spend. Optional so a
  // fake spawner (and the timeout path, where nothing is read) can omit it.
  exited: Promise<{ exitCode: number; stdout?: string }>;
  kill(): void;
}

/** The seam: runJob calls this instead of Bun.spawn. Tests inject a stub. */
export type Spawner = (argv: string[], opts: { cwd: string; env: Record<string, string>; stdin: string }) => SpawnHandle;

// Actual spend for one spawn, read from the `claude -p --output-format json`
// result envelope. costUsd is total_cost_usd when the CLI reports it; on the
// subscription (OAuth) path it can be absent or 0 (no per-token billing) while
// the token counts are still present — so we capture BOTH and let the reader
// pick (#183 tracks exactly what the subscription path exposes). Every field is
// nullable: a timed-out, crashed, or unparseable run degrades to all-null, and
// a cost read must NEVER fail a job.
export interface SpawnUsage {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

export const EMPTY_USAGE: SpawnUsage = {
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
};

const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The result envelope is a single JSON object on stdout. Parse it defensively:
// try the whole string first, then fall back to the last brace-line that looks
// like a result object (interleaved logs, or a stream-json tail). Anything
// unparseable yields the whole object if present, else null — never a throw.
function extractResultObject(stdout: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(stdout.trim());
  if (whole && ("total_cost_usd" in whole || "usage" in whole)) return whole;
  const braceLines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
  for (let i = braceLines.length - 1; i >= 0; i--) {
    const o = tryParse(braceLines[i]!);
    if (o && (o["type"] === "result" || "total_cost_usd" in o || "usage" in o)) return o;
  }
  return whole;
}

/** Read cost + token usage from a `claude -p --output-format json` result. Never throws. */
export function parseClaudeUsage(stdout: string): SpawnUsage {
  const obj = extractResultObject(stdout);
  if (!obj) return { ...EMPTY_USAGE };
  const usage = (typeof obj["usage"] === "object" && obj["usage"] !== null ? obj["usage"] : {}) as Record<string, unknown>;
  return {
    costUsd: asNum(obj["total_cost_usd"]),
    inputTokens: asNum(usage["input_tokens"]),
    outputTokens: asNum(usage["output_tokens"]),
    cacheReadInputTokens: asNum(usage["cache_read_input_tokens"]),
    cacheCreationInputTokens: asNum(usage["cache_creation_input_tokens"]),
  };
}

export interface RunDeps {
  spawner: Spawner;
  clock: () => number;
  stateDir: string;
  checkoutDir: string;
  secretsDir: string;
  /** Injectable timeout waiter so tests fire the per-job timeout without waiting minutes. */
  waitTimeout?: (ms: number) => Promise<"timeout">;
}

export interface RunOutcome {
  result: "ok" | "fail";
  exitCode: number | null;
  timedOut: boolean;
  cycleId: string;
  /** Actual spend for this spawn (all-null on timeout/crash/unparseable). */
  usage: SpawnUsage;
}

export const STATE_NOW_MISSING = "STATE NOW MISSING — flag this in your report";

// The standing D1 clause, in ALL four work orders for stages 1-2 (plan §C3,
// verbatim requirement). Council's Task-tool subagents are its review method,
// not capability-(b) dispatch — the clause still applies to agent dispatch.
export const OBSERVE_AND_FILE_ONLY =
  "Capability gate D1: dispatch is OFF. Where your charter says dispatch an agent (reviewer, next wave, redispatch), instead FLAG it: comment on the PR or file via `bun scripts/file-finding.ts`. Never dispatch agents. Never merge.";

// Extract the `## NOW` section of docs/STATE.md: from its heading to the next
// `## ` heading. Empty or absent degrades to "" — the composer substitutes
// the MISSING marker, never a throw (STATE.md shipped 0 bytes in #375).
export function extractStateNow(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## NOW"));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

const FILING_HOWTO =
  "File findings ONLY via `bun scripts/file-finding.ts --dedup-key <stable-key> --title <title> --body-b64 <base64>` — the WHOLE command on ONE LINE. base64-encode your finding body (standard base64, no line wrapping) and pass it as the --body-b64 value. Do NOT use a heredoc, a pipe, or any newline anywhere in the command: a headless job's permission layer treats a newline as a command boundary and denies the run. Template (one line): `bun scripts/file-finding.ts --dedup-key <k> --title <t> --body-b64 <base64 of the body>`. It runs under the scheduler-recorded job/cycle identity and enforces the #114 verdict-(a) conditions (dedup incl. recently-closed, machine-filed label + provenance, bump-not-refile, per-cycle cap). Never `gh issue create` directly.";

function workOrder(job: JobDef, cycleId: string): string {
  const common = [
    `Job: ${job.id}. Cycle id: ${cycleId} — use it verbatim in every file-finding call and report line.`,
    "You run headless on the scheduler host against a dedicated checkout (your cwd). `gh` is authenticated via GH_TOKEN in your environment.",
  ];
  const perJob: Record<JobDef["id"], string[]> = {
    standup: [
      "Target: this 2h stand-up window — liveness, PRs, pipeline, blockers, hygiene, per your charter.",
      "Reporting channel: gh comments on the PRs/issues you triage. Flag merge-ready with a PR comment; the PM merges.",
    ],
    strategy: [
      "Target: this 6h strategy review window, per your charter (step-0 gate first).",
      "Authorized store access (#114 A1): the ONE transport is `bun scripts/strategy-store.ts <op> <agentId>` — the WHOLE command on ONE LINE. Three fixed ops: `gate` (step-0 precheck; exit 0 = run, 1 = skip, 2 = error), `mark` (advance the cursor, post-run only), `dump` (the review dataset JSON — heartbeat trend + failure taxonomy). It calls an authenticated HTTP route on the harness server (bearer token in the `X-Store-Token` header); no SSH, no `docker exec`, no arbitrary read. If you need to read the store, that is what `dump` is for — do not reach past these three ops.",
      "Steer lever status (#114 A1): the instruct-channel steer (POST /api/agents/<id>/instruct) is temporarily UNAVAILABLE — dropping docker exec removed its only transport across the scheduler→container boundary, and the replacement plus its bearer token are a pending follow-up. Do NOT attempt a steer; escalate every finding via the issue/note levers (ladder steps 2-3) instead.",
      "Reporting channel: write your dated report via `bun scripts/write-report.ts --file <YYYY-MM-DD>-strategy-review.md --body-b64 <base64>` — the WHOLE command on ONE LINE, the report body base64-encoded as the --body-b64 value (no heredoc, no pipe, no newline in the command). It lands under $SCHEDULER_STATE_DIR/reports/ and the writer accepts nothing outside it. Issue-worthy findings go through file-finding.",
    ],
    council: [
      "Target: today's daily council review, per the brief above (outsider seat, insider seat, synthesis).",
      "Reporting channel: write your dated report via `bun scripts/write-report.ts --file <YYYY-MM-DD>-council-review.md --body-b64 <base64>` — the WHOLE command on ONE LINE, the report body base64-encoded as the --body-b64 value (no heredoc, no pipe, no newline in the command). It lands under $SCHEDULER_STATE_DIR/reports/ — and FLAG it for PM pickup in your final output; your PAT cannot push, so committing it to docs/council/ stays a workstation action. Findings go through file-finding.",
    ],
    steward: [
      "Target: the merge cluster since the last steward anchor — reconcile the living docs per your charter.",
      "Authorized write path: one docs-only branch + PR — `git checkout -b docs/<name>`, `git add`/`git commit`, `git push origin <branch>`, `gh pr create`. Open the PR and STOP: never merge it.",
      "Reporting channel: the PR body (plus your five-field completion report on stdout).",
    ],
  };
  return [...common, ...perJob[job.id], FILING_HOWTO, OBSERVE_AND_FILE_ONLY].join("\n\n");
}

export function composePrompt(
  job: JobDef,
  parts: { charterText: string; stateNow: string; cycleId: string },
): string {
  const stateNow = parts.stateNow.trim() === "" ? STATE_NOW_MISSING : parts.stateNow;
  return [
    `You are a headless scheduled job spawned by the durable scheduler (#114). Your identity and rules are the charter below — follow it, as amended by the work order at the end.`,
    `=== CHARTER (verbatim) ===\n${parts.charterText}\n=== END CHARTER ===`,
    `## Handoff — docs/STATE.md \`## NOW\`\n\n${stateNow}`,
    `## Backlog\n\nGitHub Issues are the SSOT; \`docs/backlog.md\` in this checkout is the generated view.`,
    `## Work order\n\n${workOrder(job, parts.cycleId)}`,
  ].join("\n\n");
}

// Argv is flags-only, verbatim per plan §C3 — the prompt goes to stdin.
// The Edit deny over POLICY_PATHS is fleet-wide HERE, not per-job: the
// steward keeps bare Edit (its docs remit needs it), and an on-disk edit of
// docs/charters/* by a prompt-injected run bypasses the commit-time D3 fence
// — the next spawn readFileSync's the tampered charter. Deny wins over allow
// and Edit(path) scoping IS honored (verified live, Batch C review), so
// composing it inside buildArgv means a future job gaining Edit or Write
// cannot reopen the hole by omission. POLICY_PATHS is imported, never
// hand-copied — the fence list has one definition (policy-paths.ts).
export function buildArgv(job: JobDef): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    job.model,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--allowedTools",
    ...job.allowedTools,
    "--disallowedTools",
    ...POLICY_PATHS.map((p) => `Edit(${p})`),
  ];
}

// Secret values are read from files and travel by ENV only. A missing secret
// file aborts BEFORE spawning (never start a job that cannot authenticate);
// the error names the FILE, never a value.
function readSecret(secretsDir: string, name: string): string {
  try {
    return readFileSync(join(secretsDir, name), "utf8").trim();
  } catch {
    throw new Error(`missing or unreadable secret file: ${name}`);
  }
}

function buildEnv(job: JobDef, secretsDir: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_OAUTH_TOKEN: readSecret(secretsDir, "claude_oauth_token"),
    GH_TOKEN: readSecret(secretsDir, job.patSecret),
  };
  // extraSecrets: each file exported under its uppercased filename — the
  // strategy job's instruct_bearer → INSTRUCT_BEARER, and nothing else gets it
  // (spec §Security: no secret over-broadcast).
  for (const name of job.extraSecrets ?? []) env[name.toUpperCase()] = readSecret(secretsDir, name);
  return env;
}

const defaultWaitTimeout = (ms: number) => new Promise<"timeout">((res) => setTimeout(() => res("timeout"), ms));

type SpawnExit = Awaited<SpawnHandle["exited"]>;

async function raceTimeout(
  exited: SpawnHandle["exited"],
  ms: number,
  wait: ((ms: number) => Promise<"timeout">) | undefined,
): Promise<SpawnExit | "timeout"> {
  if (wait) return Promise.race([exited, wait(ms)]);
  // Real timer path: clear it once the job finishes so a per-tick process
  // does not linger up to timeoutMs after its last job exits.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function appendRunLog(stateDir: string, entry: Record<string, unknown>, ts: number): void {
  const logsDir = join(stateDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const day = new Date(ts).toISOString().slice(0, 10); // one file per UTC day → prunable by age (task D)
  appendFileSync(join(logsDir, `runs-${day}.jsonl`), `${JSON.stringify(entry)}\n`);
}

export async function runJob(job: JobDef, deps: RunDeps): Promise<RunOutcome> {
  const startedAt = deps.clock();
  const cycleId = `${job.id}-${startedAt}`;

  let exitCode: number | null = null;
  let timedOut = false;
  let result: "ok" | "fail" = "fail";
  let error: string | undefined;
  let usage: SpawnUsage = { ...EMPTY_USAGE };

  try {
    // Charter read failure is a job failure, recorded, never a throw — a
    // charterless spawn would run an unarmed identity at full cadence.
    const charterText = readFileSync(join(deps.checkoutDir, job.charterPath), "utf8");
    let stateNow = "";
    try {
      stateNow = extractStateNow(readFileSync(join(deps.checkoutDir, "docs", "STATE.md"), "utf8"));
    } catch {
      stateNow = ""; // missing STATE.md → MISSING marker; the ceremony still runs
    }
    const prompt = composePrompt(job, { charterText, stateNow, cycleId });
    const env = buildEnv(job, deps.secretsDir);
    // Scheduler-owned filing identity: the file-finding CLI reads this
    // instead of trusting caller-supplied --job/--cycle flags, so a spawned
    // agent cannot mint fresh cycle ids past the (a)(4) flood cap.
    writeActiveCycle(deps.stateDir, { jobId: job.id, cycleId });
    const handle = deps.spawner(buildArgv(job), { cwd: deps.checkoutDir, env, stdin: prompt });
    const raced = await raceTimeout(handle.exited, job.timeoutMs, deps.waitTimeout);
    if (raced === "timeout") {
      handle.kill(); // one hung `claude -p` must never outlive its budget (plan decision 2)
      timedOut = true;
    } else {
      exitCode = raced.exitCode;
      result = raced.exitCode === 0 ? "ok" : "fail";
      // Spend is read from the child's result envelope. A parse miss (or the
      // subscription path reporting no cost) leaves usage all-null — recorded
      // as such, never a job failure.
      usage = parseClaudeUsage(raced.stdout ?? "");
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e); // file/spawn failure — no secret values in messages
  }

  // Anchor advances on ATTEMPT (plan decision 3): a failing job retries at the
  // next grid point, never every 10-min tick.
  const anchors = loadAnchors(deps.stateDir);
  const anchor = anchors[job.id];
  anchor.lastAttemptAt = startedAt;
  anchor.lastResult = result;
  if (result === "ok") {
    anchor.lastSuccessAt = deps.clock();
    anchor.failStreak = 0;
  } else {
    anchor.failStreak += 1;
  }
  saveAnchors(deps.stateDir, anchors);

  // Flat cost/token fields on every run line so "sum cost by day/job" is a
  // trivial filter over runs-*.jsonl (jobId + ts + costUsd are all right here).
  // Consistent schema: the keys are always present, null when unknown.
  //
  // `model` is the tier we spawned with (job.model — the producer knows it; #410).
  // Without it the spend-tally estimate path (scripts/spend-tally.ts) prices every
  // token at the "unknown" rate ($0), because on the subscription path the CLI
  // reports no total_cost_usd (#183) and the estimator needs a rate family. Writing
  // the model the scheduler already holds is the producer fix — the alternative
  // (spend-tally re-deriving model via a jobId→JOBS lookup) duplicates scheduler
  // knowledge downstream and breaks on per-run overrides.
  appendRunLog(
    deps.stateDir,
    {
      ts: startedAt,
      jobId: job.id,
      cycleId,
      model: job.model,
      result,
      exitCode,
      timedOut,
      durationMs: deps.clock() - startedAt,
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      ...(error !== undefined ? { error } : {}),
    },
    startedAt,
  );

  return { result, exitCode, timedOut, cycleId, usage };
}
