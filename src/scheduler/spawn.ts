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
// - allowedTools is a per-job ALLOW list (jobs.ts), passed verbatim because
//   LLM output is untrusted input (security-baseline.md). It is additive, not
//   closed: buildArgv adds `--restricted` (file tools confined to the
//   worktree, project/user settings ignored) and `--tools` (the built-in set
//   as an explicit list) to close it, plus deny rules for the secrets dir,
//   gates.json and the host env file (Cringely/spacemolt#865). Bash is NOT
//   path-confined by --restricted. See the note above buildArgv.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { BODY_DIR } from "./body-arg";
import { writeActiveCycle } from "./filing";
import { GATES_FILE } from "./gates";
import type { GitRunner } from "./git";
import { toolNames, type JobDef } from "./jobs";
import { POLICY_PATHS } from "./policy-paths";
import { loadAnchors, saveAnchors } from "./state";
import { createJobWorktree, installJobDependencies, removeJobWorktree, type CommandRunner } from "./worktree";

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
  /** The one seam runJob uses to create/destroy its ephemeral worktree (#585) — no direct filesystem git calls here. */
  gitRunner: GitRunner;
  /** Runs the dependency install inside the fresh worktree, before the job spawns. Required (not optional): an absent installer would silently restore the no-node_modules spawn. */
  commandRunner: CommandRunner;
  /** Commit every job this tick is pinned to (tick.ts reads it once per tick from origin/main). */
  pinnedSha: string;
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

// The ONE way a job passes a long body (finding, report, steer text, dedupe
// pairs) to its script, shared by every job: write it with the Write tool into
// BODY_DIR, name the file with a file flag. Every job's write grant is scoped to
// that directory (jobs.ts BODY_EDIT, note above JobDef), runJob pre-creates it,
// and the scripts read only from it (body-arg.ts readBodyFile). Nothing here has
// the job run a shell step on its text: an earlier version taught
// `printf '<text>' | base64 -w 0`, which puts untrusted text inside a
// single-quoted shell argument (injection, PR 171 security review).
// test/scheduler-spawn.test.ts pins that no job grants a shell encoder and that
// every script a job holds is named here with a file flag the script parses.
// BODY_DIR is gitignored, so the steward's `git add` cannot sweep a body in.
const BODY_FILE_HOWTO =
  "Long bodies (every finding body, report body, steer text and dedupe pair list): write the text with the Write tool to a file under `" + BODY_DIR + "/` in your checkout (your cwd), e.g. `" + BODY_DIR + "/finding.md`, then pass its path to the script as the file flag shown in that script's command below. The command carries only the path, never the text. Write the file once per body, as plain text. Do not base64-encode anything and do not build a body with a shell command (heredoc, pipe, redirect): no such command is granted. A body path outside `" + BODY_DIR + "/` is rejected.";

const FILING_HOWTO =
  "File findings ONLY via `bun scripts/file-finding.ts --dedup-key <stable-key> --title <title> --body-file <path>` — the WHOLE command on ONE LINE. Write your finding body to a file with the Write tool as described above and pass its path as the --body-file value. Do NOT use a heredoc, a pipe, or any newline anywhere in the file-finding command: a headless job's permission layer treats a newline as a command boundary and denies the run. Template (one line): `bun scripts/file-finding.ts --dedup-key <k> --title <t> --body-file " + BODY_DIR + "/finding.md`. It runs under the scheduler-recorded job/cycle identity and enforces the #114 verdict-(a) conditions (dedup incl. recently-closed, machine-filed label + provenance, bump-not-refile, per-cycle cap). Every filed issue gets a fixed priority label automatically — there is no flag to set it. Never `gh issue create` directly." +
  " Dedup-key rule (#635): mint the key as a lowercase-kebab-case slug naming the CONDITION ONLY (e.g. `core-harvest-unimplemented`) — leave severity/priority (p0, blocker) out of it, it belongs in the title. You do not need to search for a prior key yourself: filing already auto-normalizes a severity word out of the key before matching, so `core-harvest-unimplemented-p0` and `p0-core-harvest-unimplemented` land on the same open issue even without you reusing the exact prior spelling. That normalization does not cover a genuinely different WORDING for the same condition (`core-harvest-unimplemented` vs `core-harvest-job-unimplemented` still file as two) — keep the key short and literal to the condition to avoid that.";

function workOrder(job: JobDef, cycleId: string): string {
  // dedupe holds no file-finding.ts grant (see the filingTail note below), so
  // its cycle-id line drops the "file-finding call" clause the other four
  // jobs still get — naming a call this job cannot make would contradict its
  // own allowedTools list.
  const cycleIdLine =
    job.id === "dedupe"
      ? `Job: ${job.id}. Cycle id: ${cycleId} — use it verbatim in your report line.`
      : `Job: ${job.id}. Cycle id: ${cycleId} — use it verbatim in every file-finding call and report line.`;
  const common = [
    cycleIdLine,
    "You run headless on the scheduler host against a dedicated checkout (your cwd). `gh` is authenticated via GH_TOKEN in your environment.",
    BODY_FILE_HOWTO,
  ];
  const perJob: Record<JobDef["id"], string[]> = {
    standup: [
      "Target: this 2h stand-up window — liveness, PRs, pipeline, blockers, hygiene, per your charter.",
      "Reporting channel: gh comments on the PRs you triage. Flag merge-ready with a PR comment; the PM merges. (#490: no issue-read/write grant — file an issue only via file-finding.ts.)",
      "Council-ordering check (#654): `bun scripts/read-latest-report.ts --glob '*-council-review.md'` is the ONE way to look for a fresh council report — the WHOLE command on ONE LINE. You have no `ls`/`find`/`printenv` grant for `$SCHEDULER_STATE_DIR/reports/`; any attempt at those is DENIED, and a denial there is not evidence a report is missing. Read the result per your charter's step 3.",
    ],
    strategy: [
      "Target: this 6h strategy review window, per your charter (step-0 gate first).",
      "Authorized store access (#114 A1): the ONE transport is `bun scripts/strategy-store.ts <op> <agentId>` — the WHOLE command on ONE LINE. Three fixed ops: `gate` (step-0 precheck; exit 0 = run, 1 = skip, 2 = error), `mark` (advance the cursor, post-run only), `dump` (the review dataset JSON — heartbeat trend + failure taxonomy). It calls an authenticated HTTP route on the harness server (bearer token in the `X-Store-Token` header); no SSH, no `docker exec`, no arbitrary read. If you need to read the store, that is what `dump` is for — do not reach past these three ops.",
      "Steer lever (#495), ladder step 1: `bun scripts/strategy-store.ts steer <agentId> --body-file <path>` — the WHOLE command on ONE LINE, your steer text written to a file as described above and the file's path as the --body-file value (no heredoc, no pipe, no newline in the command). It is a fourth op on the SAME authenticated route family and the SAME bearer as the three above; nothing else is needed. Hard cap 500 characters, enforced both sides. A 204 means ACCEPTED AND QUEUED, not applied — the pilot consumes it at its next replan, and there is nothing to read back to confirm it.",
      "Steer content rule (#527): a steer must NOT order a query action (a read-only lookup such as find_route or view_market). The planner can only be told to take MUTATIONS, so an instruction naming a query is rejected 400 and never reaches the pilot. Write the OUTCOME you want (\"get to a station and refuel\") or the MUTATION to take (\"jump to gold_run, then dock and refuel\").",
      "When to steer: this is the SHARPEST lever you hold and the only one that acts inside this window. Reach for it when a finding needs correcting NOW and the issue lever is too slow — an issue waits on a human reading a backlog item, which can be hours or days, and a pilot burning credits or stranded does not have that long. Everything else about the ladder stands: a steer is transient and situational, never a standing rule, and a finding that needs a durable fix (a briefing line, a guard, a missing capability) still goes to the issue lever whether or not you also steer. A finding steered twice wanted an issue the first repeat.",
      "Reporting channel: write your dated report via `bun scripts/write-report.ts --file <YYYY-MM-DD>-strategy-review.md --body-file <path>` — the WHOLE command on ONE LINE, the report body written to a file as described above and the file's path as the --body-file value (no heredoc, no pipe, no newline in the command). It lands under $SCHEDULER_STATE_DIR/reports/ and the writer accepts nothing outside it. Issue-worthy findings go through file-finding.",
    ],
    council: [
      "Target: today's daily council review, per the brief above (outsider seat, insider seat, synthesis).",
      "Reporting channel: write your dated report via `bun scripts/write-report.ts --file <YYYY-MM-DD>-council-review.md --body-file <path>` — the WHOLE command on ONE LINE, the report body written to a file as described above and the file's path as the --body-file value (no heredoc, no pipe, no newline in the command). It lands under $SCHEDULER_STATE_DIR/reports/. That directory is the record: nothing is committed or collected from it. Findings go through file-finding.",
    ],
    steward: [
      "Target: the merge cluster since the last steward anchor — reconcile the living docs per your charter.",
      "Authorized write path: one docs-only branch + PR — `git checkout -b docs/<name>`, `git add`/`git commit`, `git push origin <branch>`, `gh pr create`. Open the PR and STOP: never merge it.",
      "Reporting channel: the PR body (plus your five-field completion report on stdout).",
    ],
    dedupe: [
      "Target: this week's backlog dedupe pass, per your charter. You are the semantic pass only. The script runs the deterministic passes and does every tracker read and write.",
      "Commands, each the WHOLE command on ONE LINE: first `bun scripts/backlog-dedupe.ts candidates`, then `bun scripts/backlog-dedupe.ts run`, adding `--semantic-file <path>` only when the candidates output says the semantic pass is due and you found pairs. The file holds a JSON array of {\"member\":N,\"target\":M} pairs, written with the Write tool as described above. No heredoc, no pipe.",
      "Whether anything reaches the tracker is the operator's gates.json dedupePosting gate, OFF by default. With it off the run is a dry run: it writes $SCHEDULER_STATE_DIR/reports/backlog-dedupe.md and nothing else. You cannot and must not change that.",
      "Reporting channel: the script's own report, plus your five-field completion report on stdout carrying the `run` command's JSON summary.",
    ],
  };
  // Fix round on PR #143: dedupe holds no file-finding.ts grant (jobs.ts) —
  // the script is the only thing that writes to the tracker, gated by
  // dedupePosting, not by the separate (default-on) fileFindings gate
  // FILING_HOWTO assumes. Teaching that how-to here would name a command its
  // closed allowedTools list denies, and OBSERVE_AND_FILE_ONLY's own sentence
  // ("file via `bun scripts/file-finding.ts`") would be actively wrong for
  // this job — its charter's own NEVER section already forbids commenting,
  // editing and dispatching. See seam-manifest.md §9.
  const filingTail = job.id === "dedupe" ? [] : [FILING_HOWTO, OBSERVE_AND_FILE_ONLY];
  return [...common, ...perJob[job.id], ...filingTail].join("\n\n");
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
// The Edit denies below are fleet-wide HERE, not per-job. No job holds a bare
// Edit or Write (jobs.ts: body dir for all, the steward's docs allowlist for
// one), so these are the second layer, not the first: deny wins over allow and
// Edit(path) scoping IS honored (verified live, Batch C review), and Edit rules
// cover every built-in file-editing tool, Write included. Composing them in
// buildArgv means a future job gaining a broader Edit or Write cannot reopen
// either hole by omission.
//  - POLICY_PATHS: an on-disk edit of docs/charters/* bypasses the commit-time
//    D3 fence, since the next spawn readFileSync's the tampered charter.
//    Imported, never hand-copied: the fence list has one definition
//    (policy-paths.ts).
//  - CODE_DENY_PATHS: code a job executes through its own Bash grant. A job that
//    can overwrite scripts/file-finding.ts and then run it holds the harness
//    process's authority (security review of PR 171, CRITICAL). src/ is what
//    those scripts import, package.json/bunfig.toml/bun.lock steer what `bun`
//    resolves and runs, .claude/ is hook and guard config.
//  - the state dir (fenceDenies): gates.json, anchors, the active-cycle filing
//    identity and the reports all live there and are written only by harness
//    processes.
// A Write(path) rule is never used here: Claude Code accepts it and never
// matches it (permissions docs), so only the Edit form does anything.
//
// `--restricted` + `--tools` close the tool set (an --allowedTools list alone
// is additive; Cringely/spacemolt#865). --restricted confines Read/Grep/Glob/
// Edit to the worktree (cwd) and ignores user/project/local settings, so the
// worktree's .claude/settings.json hooks (workstation dev-team gates, none of
// which a job depends on) no longer load. --restricted does NOT confine Bash:
// read-only commands (cat, head, tail, grep, ...) run unprompted on any path.
// BLOCK_OUTSIDE_READS (via --settings, which --restricted still loads) makes
// recognized file-reading Bash commands on paths outside the worktree, and
// commands the shell parser cannot trace, prompt. A -p run denies a prompt.
// That is a prompt-and-deny gate on recognized commands, not a boundary:
// commands outside Claude Code's recognized set (base64, od, ...) are
// unverified, so a separate uid or the sandbox stays the structural fix. The
// Read/Edit deny rules are defence in depth: Claude Code applies them to the
// file tools and to cat/head/tail/sed/tee named in Bash, not to Bash rules on
// the same paths (Bash rules match command text literally, so a path-shaped
// Bash deny cannot match).
const BLOCK_OUTSIDE_READS = JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: true } });

/** Repo paths a job runs code from or that steer how it runs. Deny rules, so a bare name matches at any depth. */
export const CODE_DENY_PATHS = ["scripts/**", "src/**", ".claude/**", "package.json", "bunfig.toml", "bun.lock"] as const;

// What the scheduler keeps directly under the state dir, as Edit denies. NOT a
// blanket `<state>/**`: the job's own cwd is stateDir/worktrees/<cycle> (worktree.ts),
// so that rule would deny the body dir too (a deny wins), and Claude Code cannot
// carve it back out (a `!` pattern is read relative to the cwd and cannot reach a
// `//` rule; permissions docs). Each name is the value of an exported constant
// (state.ts, tick.ts, filing.ts, breaker.ts, dispatch-ledger.ts), listed as
// literals because tick.ts imports this file; test/scheduler-spawn.test.ts ties
// every literal to its constant. A NEW state file needs a line here. gates.json is
// already in fenceDenies.
const STATE_ENTRIES = [
  "anchors.json",
  "lock",
  "stop",
  "last-tick",
  "active-cycle.json",
  "finding-log.jsonl",
  "suppression-notice.json",
  "breaker.json",
  "breaker-config.json",
  "dispatch-ledger.json",
  "reports/**",
  "logs/**",
] as const;

export interface SandboxFence {
  secretsDir: string;
  stateDir: string;
  /** Holds the SCHEDULER_* paths and SCHEDULER_SERVICE_USER (whose absence fails the D3 fence open). */
  hostEnvFile: string;
}

/** The same default the cron wrappers use (scheduler-tick.sh ENV_FILE). */
export function hostEnvFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPACEMOLT_SCHED_ENV ?? join(homedir(), ".config", "spacemolt-sched.env");
}

// Claude Code's absolute-path rule syntax is `//path`: a single leading slash
// means project-relative, so an absolute path gets one more slash prepended.
// A relative path (a relative SCHEDULER_SECRETS in the env file) is resolved
// first: left alone it would anchor at the job's cwd and match nothing, so the
// fence would fail open. An absolute path is passed through as-is (resolve()
// would add a drive letter on a Windows dev box and change the rule).
const absPath = (p: string) => `/${(isAbsolute(p) ? p : resolve(p)).replaceAll("\\", "/")}`;

function fenceDenies(fence: SandboxFence): string[] {
  const dir = absPath(fence.secretsDir);
  const files = [absPath(join(fence.stateDir, GATES_FILE)), absPath(fence.hostEnvFile)];
  const state = STATE_ENTRIES.map((e) => `Edit(${absPath(fence.stateDir)}/${e})`);
  return [...["Read", "Edit"].flatMap((tool) => [`${tool}(${dir}/**)`, ...files.map((f) => `${tool}(${f})`)]), ...state];
}

export function buildArgv(job: JobDef, fence: SandboxFence): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    job.model,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--restricted",
    "--settings",
    BLOCK_OUTSIDE_READS,
    "--tools",
    toolNames(job.allowedTools).join(","),
    "--allowedTools",
    ...job.allowedTools,
    "--disallowedTools",
    ...POLICY_PATHS.map((p) => `Edit(${p})`),
    ...CODE_DENY_PATHS.map((p) => `Edit(${p})`),
    ...fenceDenies(fence),
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
  // SCHEDULER_SECRETS (the literal secrets path, exported by scheduler-tick.sh)
  // is dropped: no child script reads it, and passing it only tells an
  // injected job where the PAT files are. A full env allowlist was rejected:
  // the child needs PATH/HOME/proxy/bun vars this repo cannot enumerate for
  // the host, and a wrong list breaks every job.
  const { SCHEDULER_SECRETS: _dropped, ...inherited } = process.env;
  const env: Record<string, string> = {
    ...(inherited as Record<string, string>),
    CLAUDE_CODE_OAUTH_TOKEN: readSecret(secretsDir, "claude_oauth_token"),
    GH_TOKEN: readSecret(secretsDir, job.patSecret),
  };
  // extraSecrets: each file exported under its uppercased filename — the
  // strategy job's store_bearer → STORE_BEARER and sm_store_url → SM_STORE_URL
  // (#476), and no other job gets either (spec §Security: no secret
  // over-broadcast). readSecret THROWS on a missing file, so an unprovisioned
  // entry aborts the spawn (naming the file) rather than running unauthenticated
  // or against an unset URL.
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
  let worktreePath: string | null = null;

  try {
    // Ephemeral worktree (#585): the job's cwd is a disposable checkout
    // pinned to deps.pinnedSha, never the shared control clone — a worktree
    // creation failure is caught below exactly like a charter-read failure
    // (never a throw out of runJob), so no separate error path is needed.
    worktreePath = createJobWorktree(deps.gitRunner, deps.stateDir, cycleId, deps.pinnedSha);
    // A fresh worktree has no node_modules; install the locked deps before
    // anything spawns (see worktree.ts). Throws → recorded as a job failure.
    installJobDependencies(deps.commandRunner, worktreePath);
    // The one directory the job's write grant covers (jobs.ts BODY_EDIT). Created
    // here, by the harness, so the job never needs a grant wider than the
    // directory itself to make it, and so readBodyFile has a real dir to resolve.
    mkdirSync(join(worktreePath, BODY_DIR), { recursive: true });
    // Charter read failure is a job failure, recorded, never a throw — a
    // charterless spawn would run an unarmed identity at full cadence.
    const charterText = readFileSync(join(worktreePath, job.charterPath), "utf8");
    let stateNow = "";
    try {
      stateNow = extractStateNow(readFileSync(join(worktreePath, "docs", "STATE.md"), "utf8"));
    } catch {
      stateNow = ""; // missing STATE.md → MISSING marker; the ceremony still runs
    }
    const prompt = composePrompt(job, { charterText, stateNow, cycleId });
    const env = buildEnv(job, deps.secretsDir);
    // Scheduler-owned filing identity: the file-finding CLI reads this
    // instead of trusting caller-supplied --job/--cycle flags, so a spawned
    // agent cannot mint fresh cycle ids past the (a)(4) flood cap.
    writeActiveCycle(deps.stateDir, { jobId: job.id, cycleId });
    const fence = { secretsDir: deps.secretsDir, stateDir: deps.stateDir, hostEnvFile: hostEnvFile() };
    const handle = deps.spawner(buildArgv(job, fence), { cwd: worktreePath, env, stdin: prompt });
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
  } finally {
    // Unconditional: a job that timed out, threw, or never got a worktree at
    // all (worktreePath stays null) must never leave disk growth behind.
    if (worktreePath) removeJobWorktree(deps.gitRunner, worktreePath);
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
