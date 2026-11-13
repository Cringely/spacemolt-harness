// Batch C / Task C3 (#114): spawn composer + runner. Offline: injected
// spawner/clock/fs, zero live `claude -p` spawns, zero tokens.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BODY_DIR } from "../src/scheduler/body-arg";
import { BREAKER_CONFIG_FILE, BREAKER_FILE } from "../src/scheduler/breaker";
import { LEDGER_FILE } from "../src/scheduler/dispatch-ledger";
import { ACTIVE_CYCLE_FILE, FILING_LOG_FILE, SUPPRESSION_NOTICE_FILE, readActiveCycle } from "../src/scheduler/filing";
import type { GitRunner } from "../src/scheduler/git";
import { BODY_EDIT, JOBS, toolNames, type JobDef } from "../src/scheduler/jobs";
import { HEADLESS_WRITE_ALLOWLIST, POLICY_PATHS } from "../src/scheduler/policy-paths";
import { CODE_DENY_PATHS, buildArgv, composePrompt, parseClaudeUsage, runJob, type Spawner } from "../src/scheduler/spawn";
import { ANCHORS_FILE, LOCK_FILE, STOP_FILE, loadAnchors } from "../src/scheduler/state";
import { LAST_TICK_FILE } from "../src/scheduler/tick";
import { INSTALL_ARGV, type CommandRunner } from "../src/scheduler/worktree";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

// Sentinel secret VALUES (never real): if one of these strings ever shows up
// on an argv, the security-baseline env-only rule is broken. sm_store_url is a
// base URL, not a credential, but it rides the same extraSecrets file→env seam
// (#476) and must stay off argv too, so it lives here beside the bearer.
const SENTINELS = {
  claude_oauth_token: "SENTINEL_OAUTH_TOKEN_VALUE",
  gh_pat_readcomment: "SENTINEL_PAT_READCOMMENT",
  gh_pat_steward: "SENTINEL_PAT_STEWARD",
  instruct_bearer: "SENTINEL_INSTRUCT_BEARER",
  store_bearer: "SENTINEL_STORE_BEARER", // #114 A1 pivot: strategy job's store-API bearer
  sm_store_url: "http://sentinel-store.invalid:9999", // #476: strategy job's store base URL
} as const;

const CHARTER_TEXT = "# Charter: test\r\n\ttabs — em dash, `backticks`\nNEVER merge.\n";

const TEST_PINNED_SHA = "test-pinned-sha";

// #585: runJob now creates an ephemeral worktree per run via deps.gitRunner
// instead of reading the shared checkout directly. These tests care about
// runJob's OWN contract (charter composition, secrets, timeout, logging),
// not real git worktree semantics (covered separately in
// test/scheduler-worktree.test.ts against a real repo), so this fake
// simulates "git worktree add" with a real `cpSync` of the fixture checkout
// into the target path — enough for runJob's real fs.readFileSync calls to
// find the charter/STATE.md fixtures created below. Remove/prune are no-ops
// here: runJob's own removeJobWorktree always backstops with a real rmSync
// regardless of what the git call returns, so cleanup still happens for real.
function fakeWorktreeGit(checkoutDir: string): GitRunner {
  return (args) => {
    if (args[0] === "worktree" && args[1] === "add") {
      const path = args[args.length - 2]!;
      cpSync(checkoutDir, path, { recursive: true });
      return { stdout: "", exitCode: 0 };
    }
    return { stdout: "", exitCode: 0 }; // remove/prune — no-op, fs backstop does the real work
  };
}

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
  // commandRunner is the dependency-install seam: a no-op success here, because
  // these tests are not about dependency resolution. The install tests at the
  // end of this file override it.
  const commandRunner: CommandRunner = () => ({ stdout: "", exitCode: 0 });
  return { checkoutDir, secretsDir, stateDir, gitRunner: fakeWorktreeGit(checkoutDir), commandRunner, pinnedSha: TEST_PINNED_SHA };
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

// A fixed sandbox fence for the argv-only tests; runJob builds the real one from its deps.
const FENCE = {
  secretsDir: "/srv/sched/secrets",
  stateDir: "/srv/sched/state",
  hostEnvFile: "/home/sched/.config/spacemolt-sched.env",
};

// Fix round on PR #143: dedupe carries no file-finding.ts grant (jobs.ts), so
// its work order carries neither FILING_HOWTO nor OBSERVE_AND_FILE_ONLY (see
// spawn.ts's workOrder — both would name a command its closed allowedTools
// list denies). The three filing/dispatch-clause tests below predate dedupe
// (#1135) and looped over every job unconditionally; they now exclude it
// here, on the one line, rather than each growing its own ad hoc filter.
const FILING_JOBS = JOBS.filter((j) => j.id !== "dedupe");

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
  test("all four filing-capable work orders carry the observe-and-file-only clause; dedupe carries neither it nor the filing how-to", () => {
    for (const j of FILING_JOBS) {
      const prompt = composePrompt(j, { charterText: "x", stateNow: "y", cycleId: `${j.id}-1` });
      expect(prompt.includes(OBSERVE_AND_FILE_ONLY)).toBe(true);
    }
    // dedupe holds no file-finding.ts grant (jobs.ts) — the dispatch-off
    // clause's own "file via file-finding.ts" sentence would be wrong for it.
    const dedupePrompt = composePrompt(job("dedupe"), { charterText: "x", stateNow: "y", cycleId: "dedupe-1" });
    expect(dedupePrompt.includes(OBSERVE_AND_FILE_ONLY)).toBe(false);
    expect(dedupePrompt).not.toContain("bun scripts/file-finding.ts");
  });

  // Catches: the ON-ARRIVAL filing defect returning (#114). The work order must
  // teach a method that runs headless: a single-line `--body-file <path>` command
  // whose body the job wrote with the Write tool. Never a heredoc/STDIN body
  // (denied: the headless permission layer splits a Bash command on newlines),
  // never the dead outbox jail (no tool could create a file there), and never
  // text inside a shell argument (`printf '<text>' | base64`: injection).
  test("every filing-capable work order instructs single-line --body-file filing, never heredoc/STDIN/outbox", () => {
    for (const j of FILING_JOBS) {
      const prompt = composePrompt(j, { charterText: "x", stateNow: "y", cycleId: `${j.id}-1` });
      expect(prompt).toMatch(/bun scripts\/file-finding\.ts[^\n]*--body-file/);
      expect(prompt).toContain("ONE LINE"); // the single-line instruction agents must follow
      expect(prompt).toContain("Write tool"); // the body is written, not computed in a shell
      expect(prompt).not.toContain("<<"); // no heredoc anywhere
      expect(prompt).not.toContain("STDIN"); // the denied-headless method is gone
      expect(prompt).not.toContain("outbox");
    }
  });

  // Catches (#635): a work order minting a dedup-key with no guidance on the
  // condition-only, no-severity-word shape — the wording half of the drift no
  // code can enforce (the mechanical half, severity-word normalization, is
  // enforced in fileFinding() itself — see test/scheduler-filing.test.ts's
  // "severity-word near-match auto-bump" block, which is the test that
  // actually proves the invariant; this one only proves the guidance text
  // reached the prompt).
  test("every filing-capable work order names the dedup-key shape (condition-only, no severity word)", () => {
    for (const j of FILING_JOBS) {
      const prompt = composePrompt(j, { charterText: "x", stateNow: "y", cycleId: `${j.id}-1` });
      expect(prompt).toContain("leave severity/priority");
      expect(prompt).toContain("auto-normalizes a severity word");
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

  // Catches (#585): a job's cwd regressing back to the shared control clone
  // instead of a disposable per-run worktree — the whole point of the fix.
  // Also proves the worktree is actually removed once the job finishes: a
  // leaked ephemeral directory per run is exactly the unbounded-disk-growth
  // failure the reap/removal contract exists to prevent.
  test("job runs in a fresh per-run worktree under stateDir/worktrees, removed after it finishes", async () => {
    const dirs = makeDirs();
    const { spawner, calls } = fakeSpawner(0);
    const outcome = await runJob(job("standup"), { spawner, clock: () => 1_000_000, ...dirs });
    expect(outcome.result).toBe("ok");
    const cwd = calls[0]!.opts.cwd;
    expect(cwd).toContain(join(dirs.stateDir, "worktrees"));
    expect(cwd).not.toBe(dirs.checkoutDir); // never the shared control clone
    expect(existsSync(cwd)).toBe(false); // removed once the run completed
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

  // Catches: the instruct bearer regressing back into ANY job's env. A secret
  // with no use-path is pure exfil risk (a prompt-injected run with `Bash(gh *)`
  // could leak an env-held token via a gh comment).
  //
  // No job may hold it, PERMANENTLY -- there is no longer an expiry condition
  // on this rule. #114 A1 removed the docker-exec steer, and the earlier version
  // of this comment said "until the steer-transport follow-up restores a real
  // use-path". That follow-up is #495, and it deliberately did NOT restore
  // INSTRUCT_BEARER: the steer rides the store bearer the strategy job already
  // holds (STORE_BEARER, `POST /api/store/:agentId/steer`), so INSTRUCT_BEARER
  // has no use-path on any job and never gets one by this route. Left as
  // written, that sentence read as pre-granted permission for the next agent to
  // put the token back, which is the exact regression the assertion prevents.
  test("no job's env carries INSTRUCT_BEARER (the #495 steer rides STORE_BEARER, so this never expires)", async () => {
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
  //
  // #476: SM_STORE_URL rides the same extraSecrets seam and must land on the
  // strategy job's env (defined source, not an unset host env var that ERRORs
  // the step-0 gate) and NOWHERE else. Both assertions in one test because it
  // is one seam: extraSecrets → buildEnv uppercase-file-to-env. A regression
  // that drops sm_store_url from jobs.ts, or leaks either to another job,
  // fails here.
  test("only the strategy job's env carries STORE_BEARER and SM_STORE_URL", async () => {
    for (const j of JOBS) {
      const dirs = makeDirs();
      const { spawner, calls } = fakeSpawner(0);
      await runJob(j, { spawner, clock: () => 1_000_000, ...dirs });
      if (j.id === "strategy") {
        expect(calls[0]!.opts.env.STORE_BEARER).toBe(SENTINELS.store_bearer);
        expect(calls[0]!.opts.env.SM_STORE_URL).toBe(SENTINELS.sm_store_url);
      } else {
        expect(calls[0]!.opts.env.STORE_BEARER).toBeUndefined();
        expect(calls[0]!.opts.env.SM_STORE_URL).toBeUndefined();
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

  // Catches: the #490 bypass — a bare `Bash(gh *)` (or a direct issue-write/
  // pr-merge grant) on ANY job lets the spawned agent run `gh issue create` /
  // `gh issue comment` / `gh pr merge` / `gh pr close` itself, unscoped, past
  // the mechanical filer (scripts/file-finding.ts → src/scheduler/filing.ts)
  // that scopes every gh issue call to Cringely/spacemolt (the exact failure
  // spacemolt-harness#14 fixed for the code path). Every job's gh grant must
  // be an enumerated, non-write subcommand list — mirroring steward's style —
  // so a future edit can't silently reopen the bypass by re-adding the
  // wildcard or a write verb.
  test("no job's allowedTools carries a bare Bash(gh *) wildcard or a direct issue-write/pr-merge grant (#490)", () => {
    const forbiddenGh = /^Bash\(gh (issue create|issue comment|pr merge|pr close)\b/;
    for (const j of JOBS) {
      expect(j.allowedTools.includes("Bash(gh *)")).toBe(false);
      for (const entry of j.allowedTools) {
        expect(forbiddenGh.test(entry)).toBe(false);
      }
    }
  });

  // Catches (security review of PR 171, CRITICAL): a file-writing grant wider
  // than the body dir. A bare `Write` let a job overwrite scripts/file-finding.ts
  // and run it through its own Bash grant, or write gates.json and the state dir.
  // Claude Code accepts a `Write(path)` rule and never matches it (permissions
  // docs), so a scoped Write() entry would grant nothing and read as protection:
  // the only scoped form is `Edit(<path>)`, which covers the Write tool. Pinned
  // on every job: no bare Write/Edit (or the multi-file variants), no Write(...)
  // entry, and every Edit(...) grant sits under the body dir or, for the steward,
  // the doc-steward write allowlist, never on a path a job executes or that
  // steers how it runs.
  test("no job has an unscoped Write or Edit grant, no Write(...) entry, and every Edit grant is body dir or the steward allowlist", () => {
    const unscoped = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    for (const j of JOBS) {
      expect(j.allowedTools.filter((t) => unscoped.has(t))).toEqual([]);
      expect(j.allowedTools.filter((t) => /^(Write|MultiEdit|NotebookEdit)\(/.test(t))).toEqual([]);
      const edits = j.allowedTools.filter((t) => t.startsWith("Edit("));
      expect(edits).toContain(BODY_EDIT);
      const allowedPaths = new Set([`./${BODY_DIR}/**`, ...(j.id === "steward" ? HEADLESS_WRITE_ALLOWLIST : [])]);
      for (const e of edits) expect(allowedPaths.has(e.slice("Edit(".length, -1))).toBe(true);
      // No allowed edit path may fall under a denied code path.
      for (const e of edits) {
        const path = e.slice("Edit(".length, -1).replace(/^\.\//, "");
        for (const d of [...CODE_DENY_PATHS, ...POLICY_PATHS]) {
          const prefix = d.endsWith("/**") ? d.slice(0, -2) : d;
          expect(path.startsWith(prefix)).toBe(false);
        }
      }
    }
  });

  // Catches: --tools closing the Write tool the body-dir grant exists for. The
  // grant is `Edit(...)`, so a --tools list derived from tool names alone would
  // name Edit and drop Write, leaving the job no way to create the body file.
  test("toolNames exposes Write beside a scoped Edit grant, and every job's --tools list carries it", () => {
    expect(toolNames(["Read", "Edit(./x/**)"]).sort()).toEqual(["Edit", "Read", "Write"]);
    expect(toolNames(["Read", "Bash(gh pr list *)"])).not.toContain("Write");
    for (const j of JOBS) {
      const argv = buildArgv(j, FENCE);
      expect(argv[argv.indexOf("--tools") + 1]!.split(",")).toContain("Write");
    }
  });

  // Catches: the second layer dropping out of buildArgv. The allow scoping is
  // the first layer; these denies keep scripts a job runs, the code they import
  // and the manifests that steer bun out of reach even if a later edit widens a
  // grant. Edit denies cover the Write tool too (docs).
  test("every job's argv denies Edit on scripts, src, .claude, the manifests and every state-dir file", () => {
    expect([...CODE_DENY_PATHS].sort()).toEqual([".claude/**", "bun.lock", "bunfig.toml", "package.json", "scripts/**", "src/**"]);
    // Each state-dir name is the value of an exported constant; spawn.ts lists them as literals.
    const stateNames = [
      ANCHORS_FILE,
      LOCK_FILE,
      STOP_FILE,
      LAST_TICK_FILE,
      ACTIVE_CYCLE_FILE,
      FILING_LOG_FILE,
      SUPPRESSION_NOTICE_FILE,
      BREAKER_FILE,
      BREAKER_CONFIG_FILE,
      LEDGER_FILE,
      "reports/**",
      "logs/**",
    ];
    for (const j of JOBS) {
      const argv = buildArgv(j, FENCE);
      const denies = argv.slice(argv.indexOf("--disallowedTools") + 1);
      for (const p of CODE_DENY_PATHS) expect(denies).toContain(`Edit(${p})`);
      for (const n of stateNames) expect(denies).toContain(`Edit(//srv/sched/state/${n})`);
      // Never Write(path): accepted by Claude Code and never matched.
      expect(denies.filter((d) => d.startsWith("Write("))).toEqual([]);
    }
  });

  // Catches: a deny that swallows the job's own body dir. The worktree lives
  // under the state dir (stateDir/worktrees/<cycle>), so a blanket
  // `Edit(<state>/**)` would deny the very file the grant lets it write, and a
  // deny wins over an allow. Nothing the argv denies may be a prefix of the
  // worktree path, and the body dir's own grant must not be shadowed by a code deny.
  test("no deny covers the job's worktree body dir under the state dir", () => {
    const bodyFile = `/srv/sched/state/worktrees/standup-1/${BODY_DIR}/finding.md`;
    for (const j of JOBS) {
      const argv = buildArgv(j, FENCE);
      const denies = argv.slice(argv.indexOf("--disallowedTools") + 1).filter((d) => d.startsWith("Edit("));
      for (const d of denies) {
        const path = d.slice("Edit(".length, -1);
        if (!path.startsWith("//")) continue; // relative rules anchor at the job's cwd, not the state dir
        const abs = path.slice(1);
        if (abs.endsWith("/**")) expect(bodyFile.startsWith(abs.slice(0, -2))).toBe(false);
        else expect(bodyFile).not.toBe(abs);
      }
    }
  });

  // Catches: runJob forgetting to create the body dir. The write grant covers the
  // directory, not its creation, and readBodyFile needs a real dir to resolve.
  test("runJob creates the body dir in the job's worktree before the spawn", async () => {
    const dirs = makeDirs();
    let existed: boolean | undefined;
    const spawner: Spawner = (_argv, opts) => {
      existed = existsSync(join(opts.cwd, BODY_DIR));
      return { exited: Promise.resolve({ exitCode: 0 }), kill() {} };
    };
    await runJob(job("council"), { spawner, clock: () => 1_000_000, ...dirs });
    expect(existed).toBe(true);
  });

  test("the council and strategy jobs hold the report writer", () => {
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

  // Catches (#495) the same seam one lever over: the work order telling the
  // strategy job the steer lever is UNAVAILABLE after the transport shipped.
  // That text stood from the A1 pivot (2026-07-19) to #495 and was correct
  // then; left in place afterwards it silently disables the sharpest lever
  // the job holds, with every offline test still green. Two files with no
  // shared schema forcing agreement: this prose, and the route in
  // src/server/server.ts + scripts/strategy-store.ts.
  test("strategy work order advertises the steer lever as USABLE and names the real command", () => {
    const prompt = composePrompt(job("strategy"), { charterText: "x", stateNow: "y", cycleId: "strategy-1" });
    expect(prompt).toContain("bun scripts/strategy-store.ts steer");
    expect(prompt).toMatch(/strategy-store\.ts steer <agentId> --body-file/);
    expect(prompt).toContain("500 characters"); // the bound the server enforces
    expect(prompt).toContain("#527"); // the query-action content rule
    // The dead advisories, gone. Both are exact strings from the pre-#495
    // work order, so this fails the moment either is restored.
    expect(prompt).not.toContain("UNAVAILABLE");
    expect(prompt).not.toContain("Do NOT attempt a steer");
  });

  // Catches the L-39 failure the whole base64/one-line convention exists to
  // prevent: a work order teaching a command form the closed allowedTools
  // list does not match, which the headless permission layer DENIES at run
  // time while every offline test stays green. Derives the granted prefix
  // from the grant string itself rather than hardcoding it, so renaming the
  // script in one file and not the other turns this red.
  test("the steer command the work order teaches is covered by the strategy job's existing grant", () => {
    const grant = "Bash(bun scripts/strategy-store.ts *)";
    expect(job("strategy").allowedTools).toContain(grant);
    const grantedPrefix = grant.slice("Bash(".length, -" *)".length); // "bun scripts/strategy-store.ts"
    const prompt = composePrompt(job("strategy"), { charterText: "x", stateNow: "y", cycleId: "strategy-1" });
    expect(prompt).toContain(`${grantedPrefix} steer <agentId> --body-file`);
  });

  // Catches (#654): stand-up's council-freshness command drifting out of sync
  // with its actual grant, the same L-39 shape as the steer test above — a
  // work order teaching a command the closed allowedTools list no longer
  // matches is DENIED at run time while this offline test stays green.
  test("stand-up's council-freshness command is covered by its own read-latest-report grant", () => {
    const grant = "Bash(bun scripts/read-latest-report.ts *)";
    expect(job("standup").allowedTools).toContain(grant);
    const grantedPrefix = grant.slice("Bash(".length, -" *)".length); // "bun scripts/read-latest-report.ts"
    const prompt = composePrompt(job("standup"), { charterText: "x", stateNow: "y", cycleId: "standup-1" });
    expect(prompt).toContain(`${grantedPrefix} --glob '*-council-review.md'`);
    // No job gets a general ls/find/printenv grant into the state dir — the
    // whole point of #654 is that stand-up must never need to resolve
    // $SCHEDULER_STATE_DIR itself.
    expect(job("standup").allowedTools.some((t) => /^Bash\((ls|find|printenv) /.test(t))).toBe(false);
  });

  // Catches (Cringely/spacemolt#798, #880, #899, #507, #1120, #1123, #1147,
  // #1148, #980): a work order demanding a body the job has no safe way to
  // produce. Agents then hand-encoded base64 (one slipped character corrupted a
  // filed body, #980) or rediscovered an ungranted pipe by trial. The first fix
  // granted `Bash(printf *)` + `base64` and taught `printf '<text>' | base64`:
  // untrusted text inside a single-quoted shell argument is injection, and
  // `printf *` is a free-form wildcard (security review of PR 171, HIGH). The
  // method is now a file the job writes with the Write tool, passed by path.
  // This pins both halves: no job grants a shell encoder, and every body-taking
  // script a job is granted is named in its work order with the file flag the
  // script really accepts (a flag renamed on one side only fails here).
  const SHELL_ENCODER = /^Bash\((printf|base64|echo|cat|tee|xxd|od|openssl|python3?|node|perl|ruby|sh|bash|env)\b/;
  test("no job grants a shell encoder, and no work order teaches piping text through one", () => {
    for (const j of JOBS) {
      expect(j.allowedTools.filter((t) => SHELL_ENCODER.test(t))).toEqual([]);
      const prompt = composePrompt(j, { charterText: "x", stateNow: "y", cycleId: `${j.id}-1` });
      expect(prompt).not.toContain("printf");
      expect(prompt).not.toContain("| base64");
      expect(prompt).not.toContain("base64 -w");
    }
  });

  const BODY_SCRIPTS = [
    { script: "file-finding.ts", flag: "--body-file" },
    { script: "write-report.ts", flag: "--body-file" },
    { script: "strategy-store.ts", flag: "--body-file" },
    { script: "backlog-dedupe.ts", flag: "--semantic-file" },
  ];
  test("each body-taking script a job is granted is named in its work order with a file flag the script accepts", () => {
    for (const j of JOBS) {
      const prompt = composePrompt(j, { charterText: "x", stateNow: "y", cycleId: `${j.id}-1` });
      expect(j.allowedTools).toContain(BODY_EDIT); // the grant that lets Write create the body file
      expect(prompt).toContain(`${BODY_DIR}/`); // where the work order says to write it
      for (const { script, flag } of BODY_SCRIPTS) {
        if (!j.allowedTools.some((t) => t === `Bash(bun scripts/${script} *)`)) continue;
        expect(prompt).toMatch(new RegExp(`scripts/${script.replace(".", "\\.")}[^\\n]*${flag}`));
        const src = readFileSync(join(import.meta.dir, "..", "scripts", script), "utf8");
        expect(src).toContain(flag.slice(2)); // the script parses the flag the prompt names
      }
    }
  });

  // Catches: the fleet-wide policy-path Edit deny dropping out of buildArgv.
  // Steward's Edit is scoped to its docs allowlist, and an on-disk charter edit
  // bypasses the commit-time D3 fence — the deny (deny wins over allow;
  // Edit(path) scoping honored, verified live) must cover every POLICY_PATHS
  // entry on EVERY job so a job gaining Edit later cannot reopen the hole.
  test("every job's argv denies Edit on every POLICY_PATHS entry via --disallowedTools", () => {
    for (const j of JOBS) {
      const argv = buildArgv(j, FENCE);
      const denyFlagIdx = argv.indexOf("--disallowedTools");
      expect(denyFlagIdx).toBeGreaterThan(-1);
      for (const p of POLICY_PATHS) {
        expect(argv.indexOf(`Edit(${p})`)).toBeGreaterThan(denyFlagIdx);
      }
    }
  });

  // Catches (Cringely/spacemolt#865, appsec P1): `--allowedTools` is an additive
  // allow list, so a job's tool set was never closed. `--restricted` confines
  // the file tools to the worktree and ignores project settings; `--tools` makes
  // the built-in set an explicit list. Deleting either flag from buildArgv
  // reopens unscoped Read/Edit of the secrets dir, gates.json and the host env
  // file while every grant-content test stays green.
  test("every job's argv passes --restricted and a --tools list equal to its granted tool names", () => {
    for (const j of JOBS) {
      const argv = buildArgv(j, FENCE);
      expect(argv).toContain("--restricted");
      const toolsIdx = argv.indexOf("--tools");
      expect(toolsIdx).toBeGreaterThan(-1);
      // Derived independently of the implementation: the part before "(" of each grant, deduped.
      // Plus Write when the job holds a scoped Edit grant: Claude Code checks Write against Edit rules.
      const expected = [...new Set([...j.allowedTools.map((t) => t.replace(/\(.*$/, "")), "Write"])];
      expect(argv[toolsIdx + 1]!.split(",").sort()).toEqual(expected.sort());
      // One comma-joined value, then the next flag: nothing else is swept into the set.
      expect(argv[toolsIdx + 2]!.startsWith("--")).toBe(true);
    }
  });

  // Catches (#865): Task in the council grant. A Task subagent runs Bash that
  // is not held to the job's allowedTools list (live evidence in #865), so no
  // job may be granted it until that is fixed.
  test("no job holds Task, in its grant or in its --tools set", () => {
    for (const j of JOBS) {
      expect(j.allowedTools.some((t) => t === "Task" || t.startsWith("Task("))).toBe(false);
      const argv = buildArgv(j, FENCE);
      expect(argv[argv.indexOf("--tools") + 1]!.split(",")).not.toContain("Task");
    }
  });

  // Catches: the deny rules for the paths a prompt-injected job must never
  // read or edit (secrets dir, gates.json, host env file) dropping out of argv.
  // `--restricted` is the primary control for the file tools. These rules are
  // the defence in depth behind it, and Claude Code also applies Read denies to
  // cat/head/tail/sed named in Bash. `//path` is its absolute-path rule syntax.
  // No Bash(...) deny belongs here: Bash rules match command text literally,
  // so a path-shaped one never matches (PR #158 round 1).
  test("every job's argv denies Read/Edit on the secrets dir, gates.json and the host env file, and no Bash deny", () => {
    for (const j of JOBS) {
      const argv = buildArgv(j, FENCE);
      const denies = argv.slice(argv.indexOf("--disallowedTools") + 1);
      for (const tool of ["Read", "Edit"]) {
        expect(denies).toContain(`${tool}(//srv/sched/secrets/**)`);
        expect(denies).toContain(`${tool}(//srv/sched/state/gates.json)`);
        expect(denies).toContain(`${tool}(//home/sched/.config/spacemolt-sched.env)`);
      }
      expect(denies.filter((d) => d.startsWith("Bash(") && d.includes("srv/sched"))).toEqual([]);
    }
  });

  // Catches: a relative SCHEDULER_SECRETS / SCHEDULER_STATE_DIR / env-file path
  // reaching the fence unresolved. `Read(/rel/secrets/**)` anchors at the job's
  // cwd and matches nothing, so the deny rules silently fail open.
  test("a relative fence path is resolved to an absolute path before the rule is built", () => {
    const argv = buildArgv(job("steward"), { secretsDir: "rel/secrets", stateDir: "rel/state", hostEnvFile: "rel/host.env" });
    const denies = argv.slice(argv.indexOf("--disallowedTools") + 1);
    const cwd = process.cwd().replaceAll("\\", "/");
    for (const rel of ["rel/secrets/**", "rel/state/gates.json", "rel/host.env"]) {
      const rule = denies.find((d) => d.startsWith("Read(") && d.endsWith(`${rel})`));
      expect(rule).toBeDefined();
      expect(rule!.includes(`${cwd}/${rel}`)).toBe(true);
    }
  });

  // Catches (#158 round 1): --restricted confines the file tools only, not
  // Bash. blockReadsOutsideWorkingDirectories, passed through --settings (which
  // --restricted still loads), makes recognized file-reading Bash commands on
  // outside paths prompt, and a -p run denies a prompt. Dropping the flag
  // leaves `cat ../../secrets/x` running unprompted.
  test("every job's argv passes --settings with permissions.blockReadsOutsideWorkingDirectories true", () => {
    for (const j of JOBS) {
      const argv = buildArgv(j, FENCE);
      const idx = argv.indexOf("--settings");
      expect(idx).toBeGreaterThan(-1);
      expect(JSON.parse(argv[idx + 1]!)).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
    }
  });

  // Catches: SCHEDULER_SECRETS (the literal secrets path, exported by
  // scheduler-tick.sh) riding process.env into the child. The child's scripts
  // never read it, so handing it over only tells an injected job where the
  // PAT files are. Also pins that runJob builds the argv fence from ITS OWN
  // secretsDir rather than a constant.
  test("the child env drops SCHEDULER_SECRETS and the argv fence is built from the run's own secrets dir", async () => {
    const dirs = makeDirs();
    process.env.SCHEDULER_SECRETS = dirs.secretsDir;
    try {
      const { spawner, calls } = fakeSpawner(0);
      await runJob(job("steward"), { spawner, clock: () => 1_000_000, ...dirs });
      expect("SCHEDULER_SECRETS" in calls[0]!.opts.env).toBe(false);
      expect(calls[0]!.opts.env.GH_TOKEN).toBe(SENTINELS.gh_pat_steward); // the real secrets still arrive
      const posixSecrets = dirs.secretsDir.replaceAll("\\", "/");
      expect(calls[0]!.argv.some((a) => a.startsWith("Read(") && a.includes(posixSecrets))).toBe(true);
    } finally {
      delete process.env.SCHEDULER_SECRETS;
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

  // Catches: a job worktree spawning with no node_modules, so bun falls back to
  // its global cache and resolves zod 4 (Cringely/spacemolt#1110 and its
  // duplicates). The install must run FIRST, inside the very directory the
  // spawn then uses as cwd, and must be the lockfile-frozen form.
  test("locked deps are installed in the job worktree before claude spawns", async () => {
    const dirs = makeDirs();
    const events: string[] = [];
    const installs: Array<{ argv: string[]; cwd: string }> = [];
    const commandRunner: CommandRunner = (argv, cwd) => {
      events.push("install");
      installs.push({ argv, cwd });
      return { stdout: "", exitCode: 0 };
    };
    const calls: SpawnCall[] = [];
    const spawner: Spawner = (argv, opts) => {
      events.push("spawn");
      calls.push({ argv, opts });
      return { exited: Promise.resolve({ exitCode: 0 }), kill() {} };
    };
    const outcome = await runJob(job("strategy"), { spawner, clock: () => 1_000_000, ...dirs, commandRunner });
    expect(outcome.result).toBe("ok");
    expect(events).toEqual(["install", "spawn"]);
    expect(installs[0]!.argv).toEqual(INSTALL_ARGV);
    expect(installs[0]!.argv).toContain("--frozen-lockfile");
    expect(installs[0]!.cwd).toBe(calls[0]!.opts.cwd);
  });

  // Catches: a failed install being swallowed and the job spawning anyway
  // against a half-installed or cache-resolved tree. It must fail the job
  // loudly: no spawn, result fail, error on the run row, failStreak bumped,
  // and the worktree still cleaned up.
  test("a failed install fails the job: no spawn, error recorded, worktree removed", async () => {
    const dirs = makeDirs();
    const commandRunner: CommandRunner = () => ({ stdout: "error: lockfile had changes, but lockfile is frozen", exitCode: 1 });
    const { spawner, calls } = fakeSpawner(0);
    const outcome = await runJob(job("strategy"), { spawner, clock: () => 1_000_000, ...dirs, commandRunner });
    expect(outcome.result).toBe("fail");
    expect(calls.length).toBe(0);
    const logText = readdirSync(join(dirs.stateDir, "logs"))
      .map((f) => readFileSync(join(dirs.stateDir, "logs", f), "utf8"))
      .join("");
    const line = JSON.parse(logText.trim());
    expect(line.error).toContain("bun install --frozen-lockfile failed (exit 1)");
    expect(line.error).toContain("lockfile is frozen");
    expect(loadAnchors(dirs.stateDir).strategy.failStreak).toBe(1);
    expect(existsSync(join(dirs.stateDir, "worktrees", outcome.cycleId))).toBe(false);
  });
});
