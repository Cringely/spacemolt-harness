// Batch C / Task C3 (#114): spawn composer + runner. Offline: injected
// spawner/clock/fs, zero live `claude -p` spawns, zero tokens.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readActiveCycle } from "../src/scheduler/filing";
import { JOBS, type JobDef } from "../src/scheduler/jobs";
import { POLICY_PATHS } from "../src/scheduler/policy-paths";
import { loadAnchors } from "../src/scheduler/state";
import { buildArgv, composePrompt, parseClaudeUsage, runJob, type Spawner } from "../src/scheduler/spawn";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// Sentinel secret VALUES (never real): if one of these strings ever shows up
// on an argv, the security-baseline env-only rule is broken.
const SENTINELS = {
  claude_oauth_token: "SENTINEL_OAUTH_TOKEN_VALUE",
  gh_pat_readcomment: "SENTINEL_PAT_READCOMMENT",
  gh_pat_steward: "SENTINEL_PAT_STEWARD",
  instruct_bearer: "SENTINEL_INSTRUCT_BEARER",
  store_bearer: "SENTINEL_STORE_BEARER", // #114 A1 pivot: strategy job's store-API bearer
} as const;

const CHARTER_TEXT = "# Charter: test\r\n\ttabs — em dash, `backticks`\nNEVER merge.\n";

function makeDirs(stateNowBody = "now-block-content-marker") {
  const checkoutDir = tmp("sched-checkout-");
  const secretsDir = tmp("sched-secrets-");
  const stateDir = tmp("sched-state-");
  for (const job of JOBS) {
    const p = join(checkoutDir, job.charterPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, CHARTER_TEXT);
  }
  writeFileSync(
    join(checkoutDir, "docs", "STATE.md"),
    `# Project State\n\n## NOW — live status\n\n${stateNowBody}\n\n## History\n\nold stuff\n`,
  );
  for (const [name, value] of Object.entries(SENTINELS)) {
    writeFileSync(join(secretsDir, name), `${value}\n`); // trailing newline like a real secret file
  }
  return { checkoutDir, secretsDir, stateDir };
}

interface SpawnCall {
  argv: string[];
  opts: { cwd: string; env: Record<string, string>; stdin: string };
}

function fakeSpawner(exitCode = 0, stdout?: string) {
  const calls: SpawnCall[] = [];
  const spawner: Spawner = (argv, opts) => {
    calls.push({ argv, opts });
    return { exited: Promise.resolve({ exitCode, ...(stdout !== undefined ? { stdout } : {}) }), kill() {} };
  };
  return { spawner, calls };
}

// A realistic `claude -p --output-format json` result envelope.
const RESULT_JSON = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  session_id: "abc",
  total_cost_usd: 0.0731,
  usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 },
});

const job = (id: JobDef["id"]): JobDef => JOBS.find((j) => j.id === id)!;

const OBSERVE_AND_FILE_ONLY =
  "Capability gate D1: dispatch is OFF. Where your charter says dispatch an agent (reviewer, next wave, redispatch), instead FLAG it: comment on the PR or file via `bun scripts/file-finding.ts`. Never dispatch agents. Never merge.";

describe("spawn composer + runner (C3)", () => {
  // Catches: paraphrase drift, the failure charters exist to kill.
  test("charter text appears byte-identical inside the composed prompt", () => {
    const prompt = composePrompt(job("standup"), {
      charterText: CHARTER_TEXT,
      stateNow: "## NOW\n\nfine",
      cycleId: "standup-1",
    });
    expect(prompt.includes(CHARTER_TEXT)).toBe(true);
  });

  // Catches: the headless stand-up following its charter's "dispatch the next
  // wave" step — a capability-(b) leak at stage 1.
  test("all four composed work orders carry the observe-and-file-only clause", () => {
    for (const j of JOBS) {
      const prompt = composePrompt(j, { charterText: "x", stateNow: "y", cycleId: `${j.id}-1` });
      expect(prompt.includes(OBSERVE_AND_FILE_ONLY)).toBe(true);
    }
  });

  // Catches: the ON-ARRIVAL filing defect returning (#114). The work order must
  // teach the WORKING method — a single-line `--body-b64 <base64>` argv token —
  // never a heredoc/STDIN body (denied: the headless permission layer splits a
  // Bash command on newlines) nor the dead `--body-file <under outbox/>` form.
  test("every work order instructs single-line --body-b64 filing, never heredoc/STDIN/--body-file", () => {
    for (const j of JOBS) {
      const prompt = composePrompt(j, { charterText: "x", stateNow: "y", cycleId: `${j.id}-1` });
      expect(prompt).toContain("bun scripts/file-finding.ts");
      expect(prompt).toContain("--body-b64");
      expect(prompt).toContain("ONE LINE"); // the single-line instruction agents must follow
      expect(prompt).not.toContain("<<"); // no heredoc anywhere
      expect(prompt).not.toContain("STDIN"); // the denied-headless method is gone
      expect(prompt).not.toContain("--body-file");
      expect(prompt).not.toContain("outbox");
    }
  });

  // Catches: an empty handoff crashing every ceremony. Not hypothetical:
  // STATE.md shipped 0 bytes to main in #375 (restored by #377).
  test("empty docs/STATE.md ⇒ prompt carries the MISSING marker and the spawn proceeds", async () => {
    const dirs = makeDirs();
    writeFileSync(join(dirs.checkoutDir, "docs", "STATE.md"), ""); // the #375 artifact
    const { spawner, calls } = fakeSpawner(0);
    const outcome = await runJob(job("standup"), { spawner, clock: () => 1_000_000, ...dirs });
    expect(outcome.result).toBe("ok");
    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.stdin).toContain("STATE NOW MISSING — flag this in your report");
  });

  // Catches: a secret on a command line (security-baseline: env-only; argv is
  // visible in `ps` and logs) — and the right PAT reaching the right job.
  test("no token value appears in argv; env carries the tokens", async () => {
    const dirs = makeDirs();
    const { spawner, calls } = fakeSpawner(0);
    await runJob(job("steward"), { spawner, clock: () => 1_000_000, ...dirs });
    const call = calls[0]!;
    const joinedArgv = call.argv.join(" ");
    for (const value of Object.values(SENTINELS)) expect(joinedArgv.includes(value)).toBe(false);
    expect(call.opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SENTINELS.claude_oauth_token);
    expect(call.opts.env.GH_TOKEN).toBe(SENTINELS.gh_pat_steward); // steward gets the contents:write PAT
    expect(call.opts.stdin.includes(SENTINELS.claude_oauth_token)).toBe(false); // nor in the prompt
  });

  // Catches: the instruct bearer regressing back into ANY job's env. #114 A1
  // removed its only transport (the docker-exec steer), so a secret with no
  // use-path is pure exfil risk (a prompt-injected run with `Bash(gh *)` could
  // leak an env-held token via a gh comment). No job may hold it until the
  // steer-transport follow-up restores a real use-path.
  test("no job's env carries INSTRUCT_BEARER (A1 removed the strategy steer transport, #114)", async () => {
    for (const j of JOBS) {
      const dirs = makeDirs();
      const { spawner, calls } = fakeSpawner(0);
      await runJob(j, { spawner, clock: () => 1_000_000, ...dirs });
      expect(calls[0]!.opts.env.INSTRUCT_BEARER).toBeUndefined();
    }
  });

  // #114 A1 pivot: the strategy job's ONLY store-transport secret is now an
  // HTTP bearer, not an SSH key. Only strategy gets it (extraSecrets); every
  // other job must NOT -- a secret with no use-path on another job is pure
  // exfil risk (same reasoning as the INSTRUCT_BEARER test above).
  test("only the strategy job's env carries STORE_BEARER", async () => {
    for (const j of JOBS) {
      const dirs = makeDirs();
      const { spawner, calls } = fakeSpawner(0);
      await runJob(j, { spawner, clock: () => 1_000_000, ...dirs });
      if (j.id === "strategy") {
        expect(calls[0]!.opts.env.STORE_BEARER).toBe(SENTINELS.store_bearer);
      } else {
        expect(calls[0]!.opts.env.STORE_BEARER).toBeUndefined();
      }
    }
  });

  // Catches: one hung `claude -p` blocking every later tick — fatal under the
  // single-instance lock (plan decision 2).
  test("spawner that never resolves ⇒ killed at timeoutMs, fail recorded, anchor advanced", async () => {
    const dirs = makeDirs();
    let killed = false;
    const spawner: Spawner = () => ({ exited: new Promise(() => {}), kill: () => (killed = true) });
    const outcome = await runJob(job("standup"), {
      spawner,
      clock: () => 5_000_000,
      waitTimeout: () => Promise.resolve("timeout"), // fires "at timeoutMs" without waiting 15 min
      ...dirs,
    });
    expect(killed).toBe(true);
    expect(outcome.result).toBe("fail");
    expect(outcome.timedOut).toBe(true);
    const anchors = loadAnchors(dirs.stateDir);
    expect(anchors.standup.lastAttemptAt).toBe(5_000_000); // anchor ADVANCES on attempt (no hot-loop)
    expect(anchors.standup.lastResult).toBe("fail");
    expect(anchors.standup.failStreak).toBe(1);
    expect(anchors.standup.lastSuccessAt).toBe(null);
    // The failed run is visible in the jsonl log (until stage 2's alarm,
    // logs + --health are the only failure window).
    const logsDir = join(dirs.stateDir, "logs");
    expect(existsSync(logsDir)).toBe(true);
    const logText = readdirSync(logsDir)
      .map((f) => readFileSync(join(logsDir, f), "utf8"))
      .join("");
    expect(logText).toContain(outcome.cycleId);
    expect(logText).toContain('"fail"');
  });

  test("exit 0 records ok and resets failStreak", async () => {
    const dirs = makeDirs();
    const { spawner } = fakeSpawner(0);
    const outcome = await runJob(job("strategy"), { spawner, clock: () => 9_000_000, ...dirs });
    expect(outcome.result).toBe("ok");
    const anchors = loadAnchors(dirs.stateDir);
    expect(anchors.strategy.lastResult).toBe("ok");
    expect(anchors.strategy.failStreak).toBe(0);
    expect(anchors.strategy.lastSuccessAt).toBe(9_000_000);
    // Scheduler-owned filing identity: runJob records the cycle so the
    // file-finding CLI never trusts caller-supplied --job/--cycle (the (a)(4)
    // cap would be mintable otherwise; security review, Batch C).
    expect(readActiveCycle(dirs.stateDir)).toEqual({ jobId: "strategy", cycleId: outcome.cycleId });
  });

  // Catches: closed-execution-list violations (spec §Security: LLM output is
  // untrusted input) and wildcard regression on the one contents:write job.
  test("every job's allowedTools is explicit and closed — no package managers, no unscoped shell, no bare git wildcard on steward", () => {
    for (const j of JOBS) {
      expect(j.allowedTools.length).toBeGreaterThan(0); // deny-all placeholder is gone
      for (const entry of j.allowedTools) {
        expect(/bun (add|install|update|remove)\b/.test(entry)).toBe(false);
        expect(/\b(npm|npx|pnpm|yarn)\b/.test(entry)).toBe(false);
        expect(entry === "Bash" || entry === "Bash(*)").toBe(false); // unscoped shell
      }
    }
    expect(job("steward").allowedTools.includes("Bash(git *)")).toBe(false);
    expect(job("steward").allowedTools.includes("Bash(gh *)")).toBe(false); // contents:write PAT: gh stays per-subcommand
  });

  // Catches: bare `Write` regressing into ANY job's list. Claude Code does
  // not honor Write(path) scoping (only Edit(path) rules match), so an
  // unscoped Write lets a prompt-injected run overwrite docs/charters/* ON
  // DISK in the checkout — the D3 fence is commit-time and never sees a
  // plain filesystem write; the next spawn readFileSync's the tampered
  // charter. Reports go through the jailed scripts/write-report.ts instead.
  test("no job's allowedTools contains bare Write; report-writing jobs carry the jailed writer", () => {
    for (const j of JOBS) {
      expect(j.allowedTools.includes("Write")).toBe(false);
      expect(j.allowedTools.some((t) => /^Write\(/.test(t))).toBe(false); // scoped Write is not honored either
    }
    for (const id of ["strategy", "council"] as const) {
      expect(job(id).allowedTools.includes("Bash(bun scripts/write-report.ts *)")).toBe(true);
    }
  });

  // Catches: an A1 store-access regression (#114). The strategy job reaches the
  // store ONLY through the authenticated-HTTP thin caller
  // (scripts/strategy-store.ts → src/server/server.ts /api/store/*). A bare
  // `Bash(ssh *)`/`Bash(docker exec *)` grant, or a local gate/mark grant,
  // would reopen an arbitrary-command boundary the HTTP pivot exists to close.
  test("strategy store access is the A1 thin caller only, no ssh/docker exec (#114)", () => {
    const tools = job("strategy").allowedTools;
    expect(tools.includes("Bash(bun scripts/strategy-store.ts *)")).toBe(true);
    expect(tools.includes("Bash(docker exec *)")).toBe(false);
    expect(tools.some((t) => /^Bash\(ssh /.test(t))).toBe(false);
    expect(tools.some((t) => /strategy-review-(gate|mark)\.ts/.test(t))).toBe(false);
  });

  // Catches: this exact seam breaking (#114 A1 revise, PR #425 adversarial
  // review) -- the strategy job's own briefed prompt describing a store-access
  // mechanism the code no longer implements. The tool grant test above proves
  // the ALLOWED tools; this proves the PROMPT TEXT the job reads matches them.
  // Two files with no shared schema forcing agreement (seam-manifest pattern):
  // the workOrder() prose here, and the real transport in
  // src/server/server.ts/scripts/strategy-store.ts.
  test("strategy work order describes the real HTTP transport, never the dead SSH/forced-command one", () => {
    const prompt = composePrompt(job("strategy"), { charterText: "x", stateNow: "y", cycleId: "strategy-1" });
    // Names the real mechanism.
    expect(prompt).toContain("authenticated HTTP route");
    expect(prompt).toContain("X-Store-Token");
    // Never claims the replaced mechanism is how store access actually works
    // (a bare "no SSH" negation in the real sentence is fine; the stale
    // affirmative claim is not).
    expect(prompt).not.toContain("SSHes to the store host");
    expect(prompt).not.toContain("forced-command key");
  });

  // Catches: the fleet-wide policy-path Edit deny dropping out of buildArgv.
  // Steward keeps bare Edit for its docs remit, and an on-disk charter edit
  // bypasses the commit-time D3 fence — the deny (deny wins over allow;
  // Edit(path) scoping honored, verified live) must cover every POLICY_PATHS
  // entry on EVERY job so a job gaining Edit later cannot reopen the hole.
  test("every job's argv denies Edit on every POLICY_PATHS entry via --disallowedTools", () => {
    for (const j of JOBS) {
      const argv = buildArgv(j);
      const denyFlagIdx = argv.indexOf("--disallowedTools");
      expect(denyFlagIdx).toBeGreaterThan(-1);
      for (const p of POLICY_PATHS) {
        expect(argv.indexOf(`Edit(${p})`)).toBeGreaterThan(denyFlagIdx);
      }
    }
  });

  // Catches: cost/usage parsing breaking on the real result-envelope shape, or
  // the subscription path (no total_cost_usd) crashing instead of degrading.
  test("parseClaudeUsage reads cost + tokens; subscription path (no cost) → null cost, tokens kept; junk → all null", () => {
    const u = parseClaudeUsage(RESULT_JSON);
    expect(u.costUsd).toBeCloseTo(0.0731);
    expect(u.inputTokens).toBe(1200);
    expect(u.outputTokens).toBe(340);
    expect(u.cacheReadInputTokens).toBe(8000);
    // Subscription path: the envelope reports usage but no total_cost_usd.
    const sub = parseClaudeUsage(JSON.stringify({ type: "result", usage: { input_tokens: 5, output_tokens: 2 } }));
    expect(sub.costUsd).toBe(null);
    expect(sub.inputTokens).toBe(5);
    // A result line buried under interleaved log noise still parses.
    const noisy = parseClaudeUsage(`starting run...\nsome log line\n${RESULT_JSON}\n`);
    expect(noisy.costUsd).toBeCloseTo(0.0731);
    // Unparseable output degrades to all-null, never a throw.
    expect(parseClaudeUsage("not json at all")).toEqual({
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
    });
  });

  // Catches: the spawn result's spend being dropped instead of landing on the
  // RunOutcome and the runs-*.jsonl line (the expenditure-over-time record).
  test("runJob carries parsed cost/usage into RunOutcome and the run log", async () => {
    const dirs = makeDirs();
    const { spawner } = fakeSpawner(0, RESULT_JSON);
    const outcome = await runJob(job("strategy"), { spawner, clock: () => 1_000_000, ...dirs });
    expect(outcome.usage.costUsd).toBeCloseTo(0.0731);
    expect(outcome.usage.inputTokens).toBe(1200);
    const logText = readdirSync(join(dirs.stateDir, "logs"))
      .map((f) => readFileSync(join(dirs.stateDir, "logs", f), "utf8"))
      .join("");
    const line = JSON.parse(logText.trim());
    expect(line.costUsd).toBeCloseTo(0.0731);
    expect(line.outputTokens).toBe(340);
    expect(line.cacheReadInputTokens).toBe(8000);
  });

  // Catches: the run row losing the model tier (#410). Without `model` the
  // spend-tally estimator prices every token at the $0 "unknown" rate on the
  // subscription path — so the producer MUST stamp job.model onto the row.
  test("runJob stamps the spawned model onto the run row", async () => {
    const dirs = makeDirs();
    const { spawner } = fakeSpawner(0, RESULT_JSON);
    await runJob(job("strategy"), { spawner, clock: () => 1_000_000, ...dirs }); // strategy = sonnet
    const logText = readdirSync(join(dirs.stateDir, "logs"))
      .map((f) => readFileSync(join(dirs.stateDir, "logs", f), "utf8"))
      .join("");
    const line = JSON.parse(logText.trim());
    expect(line.model).toBe("sonnet");
    expect(line.model).toBe(job("strategy").model);
  });

  // Catches: a timed-out job inventing a cost — no result envelope was read,
  // so spend must be null (not zero, not stale).
  test("a timed-out job records null spend", async () => {
    const dirs = makeDirs();
    const spawner: Spawner = () => ({ exited: new Promise(() => {}), kill() {} });
    const outcome = await runJob(job("standup"), {
      spawner,
      clock: () => 5_000_000,
      waitTimeout: () => Promise.resolve("timeout"),
      ...dirs,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.usage.costUsd).toBe(null);
    expect(outcome.usage.inputTokens).toBe(null);
  });

  // Catches: the prompt sneaking back onto argv (the ENAMETOOLONG lesson,
  // src/planner/claude-subscription.ts:44) — argv stays flags-only.
  test("prompt travels via stdin; argv carries flags and tool list only", async () => {
    const dirs = makeDirs();
    const { spawner, calls } = fakeSpawner(0);
    await runJob(job("council"), { spawner, clock: () => 1_000_000, ...dirs });
    const call = calls[0]!;
    expect(call.opts.stdin.length).toBeGreaterThan(0);
    expect(call.argv[0]).toBe("-p");
    expect(call.argv.includes(CHARTER_TEXT)).toBe(false);
    expect(call.argv).toContain("--allowedTools");
    for (const tool of job("council").allowedTools) expect(call.argv).toContain(tool);
  });
});
