// Batch D / Task D-Tick (#114): tick orchestration + entry script. Offline:
// injected clock/gitRunner/spawner, temp dirs, zero live spawns, zero git
// network, zero tokens. The scenario walk runs against the REAL JOBS table so
// the mandated cadences (2h @ :07, 6h @ :27, daily 06:19, merge+20min settle)
// are what is under test, not a fixture's idea of them.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadBreakers } from "../src/scheduler/breaker";
import { HARD_DEADLINE_FLOOR_MS, LEDGER_FILE, loadLedger, recordDispatch } from "../src/scheduler/dispatch-ledger";
import { JOBS } from "../src/scheduler/jobs";
import type { Spawner } from "../src/scheduler/spawn";
import { defaultAnchor, loadAnchors, saveAnchors, type JobAnchor, type JobId } from "../src/scheduler/state";
import { tick, type GitRunner } from "../src/scheduler/tick";
import { worktreesRoot } from "../src/scheduler/worktree";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

const CHARTER_TEXT = "# Charter: test\nNEVER merge.\n";

function makeDirs() {
  const checkoutDir = tmp("tick-checkout-");
  const secretsDir = tmp("tick-secrets-");
  const stateDir = tmp("tick-state-");
  for (const job of JOBS) {
    const p = join(checkoutDir, job.charterPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, CHARTER_TEXT);
  }
  writeFileSync(join(checkoutDir, "docs", "STATE.md"), "# State\n\n## NOW\n\nfine\n");
  // store_bearer + sm_store_url: the strategy job's HTTP store-API bearer
  // (#114 A1) and store base URL (#476), both extraSecrets read via buildEnv()
  // before the spawner is ever called; an absent file here makes runJob fail
  // closed before spawning, which is exactly what a missing-secret job SHOULD
  // do, but it means every scenario walk below needs both files present to
  // spawn strategy at all.
  for (const name of ["claude_oauth_token", "gh_pat_readcomment", "gh_pat_steward", "instruct_bearer", "store_bearer", "sm_store_url"]) {
    writeFileSync(join(secretsDir, name), "SENTINEL\n");
  }
  return { checkoutDir, secretsDir, stateDir };
}

interface SpawnCall {
  argv: string[];
  opts: { cwd: string; env: Record<string, string>; stdin: string };
}

/** plan[i] steers the i-th spawn; default "ok" (exit 0). */
function fakeSpawner(plan: Array<"ok" | "reject"> = []) {
  const calls: SpawnCall[] = [];
  const spawner: Spawner = (argv, opts) => {
    const mode = plan[calls.length] ?? "ok";
    calls.push({ argv, opts });
    return {
      exited: mode === "reject" ? Promise.reject(new Error("spawn EACCES")) : Promise.resolve({ exitCode: 0 }),
      kill() {},
    };
  };
  return { spawner, calls };
}

/** Which job a spawn belonged to, read from its work order (`Job: <id>.`). */
function jobOf(call: SpawnCall): JobId {
  const m = /Job: (standup|strategy|council|steward)\./.exec(call.opts.stdin);
  if (!m) throw new Error("spawn stdin carries no work-order job line");
  return m[1] as JobId;
}

/**
 * Fake origin/main: mutate the object between ticks to simulate merges.
 *
 * #585: runJob now creates an ephemeral worktree per fired job via THIS SAME
 * gitRunner (tick.ts passes deps.gitRunner straight through). "git worktree
 * add" is faked with a real `cpSync` of checkoutDir (the fixture's real
 * charter/STATE.md files) into the target path — that is what lets runJob's
 * genuine fs.readFileSync calls succeed without a real git repo in these
 * tests. "remove"/"prune" are no-ops here; runJob's own removeJobWorktree
 * always backstops with a real rmSync regardless of the git call's answer,
 * so cleanup still happens for real. checkoutDir is optional so tests that
 * never fire a job (and so never touch worktree lifecycle) don't need it.
 */
function fakeGit(repo: { sha: string; commitAtMs: number; subjects: string[] }, checkoutDir?: string): GitRunner {
  return (args) => {
    if (args[0] === "fetch") return { stdout: "", exitCode: 0 };
    if (args[0] === "rev-parse") return { stdout: `${repo.sha}\n`, exitCode: 0 };
    if (args[0] === "log" && args[1] === "-1") return { stdout: `${Math.floor(repo.commitAtMs / 1000)}\n`, exitCode: 0 };
    if (args[0] === "log") return { stdout: repo.subjects.map((s) => `${s}\n`).join(""), exitCode: 0 };
    if (args[0] === "worktree" && args[1] === "add" && checkoutDir) {
      cpSync(checkoutDir, args[args.length - 2]!, { recursive: true }); // args: worktree add --detach <path> <sha>
      return { stdout: "", exitCode: 0 };
    }
    if (args[0] === "worktree") return { stdout: "", exitCode: 0 };
    return { stdout: "", exitCode: 1 };
  };
}

// 10:20:00Z — deliberately OFF every grid point so a fire at T never re-fires
// at T+10min by accident (grid points nearby: standup 10:07, strategy 06:27,
// council 06:19).
const T = Date.UTC(2026, 6, 18, 10, 20);

describe("tick orchestration (D-Tick)", () => {
  // Catches: the whole stage-1 contract ("never more than N hours unreviewed")
  // miswired end to end — catch-up burst, quiet tick, grid re-fire, steward
  // settle window, and steward self-merge absorption, in one walk.
  test("scenario walk: catch-up burst → quiet → grid re-fires → steward settle/fire/self-absorb", async () => {
    const dirs = makeDirs();
    const repo = { sha: "aaa", commitAtMs: T - 3 * HOUR, subjects: [] as string[] };
    const { spawner, calls } = fakeSpawner();
    const deps = (now: number) => ({ clock: () => now, gitRunner: fakeGit(repo, dirs.checkoutDir), spawner, ...dirs });

    // T: fresh anchors ⇒ the three periodic jobs fire once each (the ledger
    // absorption, plan decision 6); steward adopts the head without firing.
    let r = await tick(deps(T));
    expect(r.skipped).toBe(null);
    expect(calls.map(jobOf).sort()).toEqual(["council", "standup", "strategy"]);
    expect(r.absorbed).toEqual(["steward"]);
    let anchors = loadAnchors(dirs.stateDir);
    expect(anchors.steward.stewardAnchorSha).toBe("aaa");
    expect(anchors.standup.lastAttemptAt).toBe(T);
    // lock released after the walk — a held lock here kills every later tick
    expect(existsSync(join(dirs.stateDir, "lock"))).toBe(false);
    // #585 disk-bound proof: three jobs fired and finished, and each one's
    // ephemeral worktree was removed on the way out — steady state is EMPTY,
    // not "three leftover directories."
    expect(readdirSync(worktreesRoot(dirs.stateDir))).toEqual([]);
    expect(r.worktreesReaped).toBe(0); // nothing stale — this is the first tick

    // T+10min: no grid point crossed ⇒ zero spawns.
    calls.length = 0;
    r = await tick(deps(T + 10 * MIN));
    expect(calls.length).toBe(0);
    expect(r.fired).toEqual([]);

    // 12:20 — stand-up's 12:07 grid point passed; strategy (12:27) and
    // council (tomorrow 06:19) have not ⇒ stand-up only.
    calls.length = 0;
    await tick(deps(T + 2 * HOUR));
    expect(calls.map(jobOf)).toEqual(["standup"]);

    // 12:30 — strategy's 12:27 grid point passed ⇒ strategy only.
    calls.length = 0;
    await tick(deps(T + 2 * HOUR + 10 * MIN));
    expect(calls.map(jobOf)).toEqual(["strategy"]);

    // Merge lands at 12:32; tick at 12:45 sits inside the 20-min settle
    // window ⇒ no steward (and no grid job is due) — zero spawns.
    repo.sha = "bbb";
    repo.commitAtMs = T + 2 * HOUR + 12 * MIN;
    repo.subjects = ["feat(agent): real change (#390)"];
    calls.length = 0;
    await tick(deps(T + 2 * HOUR + 25 * MIN));
    expect(calls.length).toBe(0);
    expect(loadAnchors(dirs.stateDir).steward.stewardAnchorSha).toBe("aaa"); // anchor NOT advanced mid-settle

    // 12:55 — settle passed (23 min) ⇒ steward fires, alone; sha advances.
    calls.length = 0;
    r = await tick(deps(T + 2 * HOUR + 35 * MIN));
    expect(calls.map(jobOf)).toEqual(["steward"]);
    expect(r.fired).toEqual([{ jobId: "steward", result: "ok" }]);
    expect(loadAnchors(dirs.stateDir).steward.stewardAnchorSha).toBe("bbb");

    // The steward's own merged PR (all-new-subjects docs(steward)) must be
    // absorbed, never fired — the L-3 self-trigger loop.
    repo.sha = "ccc";
    repo.commitAtMs = T + 2 * HOUR + 40 * MIN;
    repo.subjects = ["docs(steward): reconcile cluster (#391)"];
    calls.length = 0;
    r = await tick(deps(T + 3 * HOUR + 5 * MIN));
    expect(calls.length).toBe(0);
    expect(r.absorbed).toEqual(["steward"]);
    expect(loadAnchors(dirs.stateDir).steward.stewardAnchorSha).toBe("ccc");
  });

  // Catches (#585, replaces the retired #413 "restore shared checkout"
  // test): the steward — the ONE job with git-write allowedTools — must run
  // in its OWN ephemeral worktree, never in the shared checkout, and that
  // worktree must be gone once the tick ends. Before #585 the fix for a
  // steward strand was "force the shared checkout back to main after it
  // runs" (`checkout -f main`); that restore is gone here because there is
  // structurally nothing left in the shared checkout for it to restore — the
  // steward never touched it. If a regression puts the steward back in the
  // shared checkout, this test only proves the OLD restore call is absent,
  // which is why scheduler-worktree.test.ts's ablation is the one that
  // proves divergence is actually impossible, not just unrestored.
  test("steward fires ⇒ runs in its own ephemeral worktree, never the shared checkout", async () => {
    const dirs = makeDirs();
    // Steward-due state: a merge landed + settled (>20min old, new subjects,
    // sha ahead of the anchor); grids quiesced so the steward fires alone.
    const anchors: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: { ...defaultAnchor(), lastAttemptAt: T },
      steward: { ...defaultAnchor(), stewardAnchorSha: "old" },
    };
    saveAnchors(dirs.stateDir, anchors);
    const repo = { sha: "new", commitAtMs: T - 30 * MIN, subjects: ["feat(agent): a real merge (#1)"] };
    const base = fakeGit(repo, dirs.checkoutDir);
    const gitCalls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      gitCalls.push(args);
      return base(args);
    };
    const { spawner, calls } = fakeSpawner();
    const r = await tick({ clock: () => T, gitRunner: recordingGit, spawner, ...dirs });
    expect(calls.map(jobOf)).toEqual(["steward"]); // steward fired, alone
    expect(r.fired).toEqual([{ jobId: "steward", result: "ok" }]);
    const cwd = calls[0]!.opts.cwd;
    expect(cwd).toContain(join(dirs.stateDir, "worktrees"));
    expect(cwd).not.toBe(dirs.checkoutDir);
    expect(existsSync(cwd)).toBe(false); // removed once the steward's run finished
    expect(gitCalls).not.toContainEqual(["checkout", "-f", "main"]); // the old restore is dead code — nothing to restore
    expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "add")).toBe(true);
    expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
  });

  // Catches (#585): a worktree left behind by a tick that was killed mid-job
  // (the crash case runJob's own finally can never cover — this process
  // itself died, not just the spawned child) piling up forever instead of
  // being cleaned at the next opportunity. Simulated directly: a stray
  // directory is dropped under stateDir/worktrees BEFORE calling tick(), with
  // no job ever having been fired in this test — the only way it can vanish
  // is the reap step, not runJob's per-run cleanup.
  test("a worktree left behind by a crashed prior tick is reaped at the start of the next tick", async () => {
    const dirs = makeDirs();
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: { ...defaultAnchor(), lastAttemptAt: T },
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet); // quiesced: this tick fires nothing itself
    const stray = join(worktreesRoot(dirs.stateDir), "steward-crashed-run");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "marker"), "left behind by a killed tick");
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const { spawner, calls } = fakeSpawner();
    const r = await tick({ clock: () => T, gitRunner: fakeGit(repo, dirs.checkoutDir), spawner, ...dirs });
    expect(calls.length).toBe(0); // nothing fired this tick — the reap alone did the cleanup
    expect(r.worktreesReaped).toBe(1);
    expect(existsSync(stray)).toBe(false);
  });

  // Catches: sentinel ignored — the operator's pause/graceful-shutdown lever
  // doing nothing while four LLM jobs fire anyway.
  test("stop file present ⇒ zero spawns, zero git calls, zero state writes", async () => {
    const dirs = makeDirs();
    writeFileSync(join(dirs.stateDir, "stop"), "");
    const { spawner, calls } = fakeSpawner();
    let gitCalls = 0;
    const git: GitRunner = () => {
      gitCalls++;
      return { stdout: "", exitCode: 1 };
    };
    const r = await tick({ clock: () => T, gitRunner: git, spawner, ...dirs });
    expect(r.skipped).toBe("stop");
    expect(calls.length).toBe(0);
    expect(gitCalls).toBe(0);
    expect(readdirSync(dirs.stateDir)).toEqual(["stop"]); // no lock, no anchors, no last-tick
  });

  // Catches: overlapping pollers double-firing a job — and the second tick
  // must LEAVE the live lock, not release it out from under the first.
  test("lock held by a live tick ⇒ second tick exits without spawning, lock intact", async () => {
    const dirs = makeDirs();
    writeFileSync(join(dirs.stateDir, "lock"), String(T - MIN)); // 1 min old — live, not stale
    const { spawner, calls } = fakeSpawner();
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const r = await tick({ clock: () => T, gitRunner: fakeGit(repo), spawner, ...dirs });
    expect(r.skipped).toBe("lock");
    expect(calls.length).toBe(0);
    expect(readFileSync(join(dirs.stateDir, "lock"), "utf8")).toBe(String(T - MIN));
  });

  // Catches: one failing job silencing all ceremonies (fire loop aborting on
  // the first rejection instead of recording and moving on).
  test("first job's spawner rejects ⇒ later jobs still run; failStreak recorded; lock released", async () => {
    const dirs = makeDirs();
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const { spawner, calls } = fakeSpawner(["reject"]);
    const r = await tick({ clock: () => T, gitRunner: fakeGit(repo, dirs.checkoutDir), spawner, ...dirs });
    expect(calls.map(jobOf)).toEqual(["standup", "strategy", "council"]); // all attempted, in JOBS order
    const anchors = loadAnchors(dirs.stateDir);
    expect(anchors.standup.lastResult).toBe("fail");
    expect(anchors.standup.failStreak).toBe(1);
    expect(anchors.strategy.lastResult).toBe("ok");
    expect(anchors.council.lastResult).toBe("ok");
    expect(r.fired).toEqual([
      { jobId: "standup", result: "fail" },
      { jobId: "strategy", result: "ok" },
      { jobId: "council", result: "ok" },
    ]);
    expect(existsSync(join(dirs.stateDir, "lock"))).toBe(false);
  });

  // Catches: unbounded scratch growth (squad checklist 5) — and the prune
  // deleting fresh files it must keep.
  test("prune: 20d-old log and report removed, 2d-old kept", async () => {
    const dirs = makeDirs();
    // Quiesce the schedule: every grid job freshly attempted, steward anchored
    // on the current sha — prune is the tick's only effect.
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: { ...defaultAnchor(), lastAttemptAt: T },
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet);
    const logs = join(dirs.stateDir, "logs");
    const reports = join(dirs.stateDir, "reports");
    mkdirSync(logs);
    mkdirSync(reports);
    const oldSec = (T - 20 * DAY) / 1000;
    const newSec = (T - 2 * DAY) / 1000;
    const put = (dir: string, name: string, mtimeSec: number) => {
      const p = join(dir, name);
      writeFileSync(p, "x");
      utimesSync(p, mtimeSec, mtimeSec);
    };
    put(logs, "runs-old.jsonl", oldSec);
    put(logs, "runs-new.jsonl", newSec);
    put(reports, "old-review.md", oldSec);
    put(reports, "new-review.md", newSec);
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const { spawner, calls } = fakeSpawner();
    const r = await tick({ clock: () => T, gitRunner: fakeGit(repo), spawner, ...dirs });
    expect(calls.length).toBe(0);
    expect(r.pruned).toBe(2);
    expect(existsSync(join(logs, "runs-old.jsonl"))).toBe(false);
    expect(existsSync(join(logs, "runs-new.jsonl"))).toBe(true);
    expect(existsSync(join(reports, "old-review.md"))).toBe(false);
    expect(existsSync(join(reports, "new-review.md"))).toBe(true);
  });

  // Catches: the L-17 silence class — an unreadable origin/main (expired PAT,
  // DNS, corrupt checkout) leaving the steward silently and permanently
  // unevaluated, with zero signal in --health and zero log line.
  test("origin/main unreadable ⇒ steward.failStreak increments; tick completes without crash", async () => {
    const dirs = makeDirs();
    // Quiesce the grid jobs so the only observable effect is the failStreak
    // bump, not an incidental catch-up spawn.
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: { ...defaultAnchor(), lastAttemptAt: T },
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet);
    const failingGit: GitRunner = (args) => {
      if (args[0] === "fetch") return { stdout: "", exitCode: 0 }; // fetch failure is tolerated
      return { stdout: "", exitCode: 1 }; // rev-parse (and everything downstream) fails
    };
    const { spawner, calls } = fakeSpawner();
    const r = await tick({ clock: () => T, gitRunner: failingGit, spawner, ...dirs });
    expect(r.skipped).toBe(null);
    expect(calls.length).toBe(0); // no grid job due; steward cannot fire without a readable main
    expect(loadAnchors(dirs.stateDir).steward.failStreak).toBe(1);
    expect(existsSync(join(dirs.stateDir, "lock"))).toBe(false); // tick still released the lock
  });

  // Catches: the stage-3 sweep touching state on an empty (gate-OFF) ledger —
  // it must be a pure no-op: all-zero counts, no ledger file created.
  test("empty ledger ⇒ swept is all-zero and no dispatch-ledger file is written", async () => {
    const dirs = makeDirs();
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: { ...defaultAnchor(), lastAttemptAt: T },
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet);
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const { spawner } = fakeSpawner();
    const r = await tick({ clock: () => T, gitRunner: fakeGit(repo), spawner, ...dirs });
    expect(r.swept).toEqual({ active: 0, quiet: 0, stale: 0, reaped: 0 });
    expect(existsSync(join(dirs.stateDir, LEDGER_FILE))).toBe(false);
  });

  // Catches: a crash-orphaned dispatch stuck in-flight forever, silently
  // eating the concurrency cap. The tick sweep reaps it past the hard deadline
  // and feeds the failure into the requesting job's breaker (never auto-fixes).
  test("tick reaps a past-deadline in-flight dispatch and bumps its breaker", async () => {
    const dirs = makeDirs();
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: { ...defaultAnchor(), lastAttemptAt: T },
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet);
    recordDispatch(dirs.stateDir, {
      dispatchId: "orphan-1",
      jobId: "strategy",
      issueRef: "#600",
      defectClass: "flaky-test",
      spawnedAt: T - (20 * MIN * 2 + HARD_DEADLINE_FLOOR_MS + MIN),
      expectedDurationMs: 20 * MIN,
      costBucket: "medium",
      lastHeartbeatAt: null,
      pokeCount: 0,
      outcome: null,
      completedAt: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
    });
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const { spawner } = fakeSpawner();
    const r = await tick({ clock: () => T, gitRunner: fakeGit(repo), spawner, ...dirs });
    expect(r.swept.reaped).toBe(1);
    expect(loadLedger(dirs.stateDir).find((e) => e.dispatchId === "orphan-1")?.outcome).toBe("orphaned");
    expect(loadBreakers(dirs.stateDir).strategy.failStreak).toBe(1);
  });

  // Catches: accidental live workstation run — a bare `bun scripts/scheduler.ts`
  // must never fire four LLM jobs (the no-live-calls rule as an exit code).
  test("scripts/scheduler.ts with SCHEDULER_STATE_DIR unset ⇒ exit 2 + usage, no side effects", () => {
    const root = join(import.meta.dir, "..");
    const env: Record<string, string | undefined> = { ...process.env };
    delete env["SCHEDULER_STATE_DIR"];
    delete env["SCHEDULER_CHECKOUT"];
    delete env["SCHEDULER_SECRETS"];
    const r = spawnSync(process.execPath, [join(root, "scripts", "scheduler.ts"), "tick"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SCHEDULER_STATE_DIR");
    expect(r.stderr).toContain("usage:");
  });
});
