// #558 part 2: a ceremony run that fails must surface through the same
// channel a successful run uses (filing an issue), not only anchors.json and
// a run log nobody reads by default. Offline: fake gh runner, fake spawner,
// temp state dirs, zero live gh, zero live spawns.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { failureAlarmDedupKey, fileFailureAlarm } from "../src/scheduler/failure-alarm";
import type { GhRunner } from "../src/scheduler/filing";
import { JOBS } from "../src/scheduler/jobs";
import type { Spawner } from "../src/scheduler/spawn";
import { defaultAnchor, saveAnchors, type JobAnchor, type JobId } from "../src/scheduler/state";
import { tick, type GitRunner } from "../src/scheduler/tick";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

interface GhCall {
  args: string[];
  body?: string;
}

// Static-answer fake, mirroring test/scheduler-filing.test.ts's fakeGh — used
// for the unit-level assertions on fileFailureAlarm itself.
function fakeGh(listResponse: Array<{ number: number; state: string; closedAt: string | null }> = []) {
  const calls: GhCall[] = [];
  let nextIssue = 900;
  const gh: GhRunner = (args) => {
    const bodyIdx = args.indexOf("--body-file");
    const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, "utf8") : undefined;
    calls.push({ args, body });
    if (args[0] === "issue" && args[1] === "list") return { stdout: JSON.stringify(listResponse), exitCode: 0 };
    if (args[0] === "issue" && args[1] === "create")
      return { stdout: `https://github.com/x/y/issues/${nextIssue++}\n`, exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  return { gh, calls };
}

// Stateful fake: `create` actually mints an OPEN issue with the real dedup
// marker in its body, and `list --search` answers from that live issue set —
// this is what lets the integration test below prove a SECOND failure finds
// the FIRST failure's issue instead of blind-creating another one.
function statefulFakeGh() {
  const issues: Array<{ number: number; state: "OPEN" | "CLOSED"; closedAt: string | null; body: string }> = [];
  let nextIssue = 500;
  const calls: GhCall[] = [];
  const gh: GhRunner = (args) => {
    const bodyIdx = args.indexOf("--body-file");
    const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, "utf8") : undefined;
    calls.push({ args, body });
    if (args[0] === "issue" && args[1] === "list") {
      // Real search string is `"<!-- sm-dedup:<key> -->" in:body` (filing.ts
      // findDedupMatch) — pull the marker back out and match it against each
      // issue's stored body, same as gh's real full-text search would.
      const search = args[args.indexOf("--search") + 1] ?? "";
      const marker = /<!-- sm-dedup:[^ ]+ -->/.exec(search)?.[0];
      const hits = marker ? issues.filter((i) => i.body.includes(marker)) : [];
      return {
        stdout: JSON.stringify(hits.map((h) => ({ number: h.number, state: h.state, closedAt: h.closedAt }))),
        exitCode: 0,
      };
    }
    if (args[0] === "issue" && args[1] === "create") {
      const issue = { number: nextIssue++, state: "OPEN" as const, closedAt: null, body: body ?? "" };
      issues.push(issue);
      return { stdout: `https://github.com/x/y/issues/${issue.number}\n`, exitCode: 0 };
    }
    if (args[0] === "issue" && args[1] === "comment") return { stdout: "", exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  return { gh, calls, issues };
}

const input = (overrides: Partial<Parameters<typeof fileFailureAlarm>[2]> = {}) => ({
  jobId: "council" as JobId,
  cycleId: "council-1000",
  failStreak: 1,
  timedOut: false,
  exitCode: 1,
  ...overrides,
});

describe("fileFailureAlarm unit (#558 part 2)", () => {
  // Ablation: delete the jobId-only key (e.g. append cycleId) and this test
  // goes red — it pins the exact string the whole dedup guarantee rests on.
  test("dedup key is stable per job id, independent of cycleId", () => {
    expect(failureAlarmDedupKey("council")).toBe("scheduler-council-fail");
    expect(failureAlarmDedupKey("council")).toBe(failureAlarmDedupKey("council")); // same jobId, any call ⇒ same key
    expect(failureAlarmDedupKey("standup")).not.toBe(failureAlarmDedupKey("council"));
  });

  // Ablation: remove the canFile() check and this test goes red — filing
  // would proceed even with fileFindings.enabled=false.
  test("D1 filing gate OFF ⇒ no gh call at all", () => {
    const dir = tmp("fa-gate-");
    writeFileSync(join(dir, "gates.json"), JSON.stringify({ fileFindings: { enabled: false } }));
    const { gh, calls } = fakeGh();
    fileFailureAlarm(gh, dir, input());
    expect(calls.length).toBe(0);
  });

  // Ablation: drop failStreak/timedOut/exitCode from the body template and
  // this test goes red — it is the only place these fields are asserted at all.
  test("filed body carries failStreak, timedOut, exitCode, cycleId", () => {
    const dir = tmp("fa-body-");
    const { gh, calls } = fakeGh([]);
    fileFailureAlarm(gh, dir, input({ failStreak: 3, timedOut: true, exitCode: null, cycleId: "council-42" }));
    const create = calls.find((c) => c.args[1] === "create")!;
    expect(create.body).toContain("failStreak: 3");
    expect(create.body).toContain("timedOut: true");
    expect(create.body).toContain("exitCode: null");
    expect(create.body).toContain("council-42");
    expect(create.body).toContain("<!-- sm-dedup:scheduler-council-fail -->");
  });

  // Ablation: a repeat call with an OPEN match already present but the code
  // creating anyway (e.g. dedup search skipped) turns this red.
  test("existing open alarm issue for the job ⇒ bump, never a second create", () => {
    const dir = tmp("fa-bump-");
    const { gh, calls } = fakeGh([{ number: 777, state: "OPEN", closedAt: null }]);
    fileFailureAlarm(gh, dir, input());
    expect(calls.some((c) => c.args[1] === "create")).toBe(false);
    expect(calls.some((c) => c.args[1] === "comment" && c.args[2] === "777")).toBe(true);
  });
});

// --- tick.ts integration: the invariant itself -----------------------------

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHARTER_TEXT = "# Charter: test\nNEVER merge.\n";

function makeDirs() {
  const checkoutDir = tmp("fa-tick-checkout-");
  const secretsDir = tmp("fa-tick-secrets-");
  const stateDir = tmp("fa-tick-state-");
  for (const job of JOBS) {
    const p = join(checkoutDir, job.charterPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, CHARTER_TEXT);
  }
  writeFileSync(join(checkoutDir, "docs", "STATE.md"), "# State\n\n## NOW\n\nfine\n");
  for (const name of ["claude_oauth_token", "gh_pat_readcomment", "gh_pat_steward", "instruct_bearer", "store_bearer", "sm_store_url"]) {
    writeFileSync(join(secretsDir, name), "SENTINEL\n");
  }
  return { checkoutDir, secretsDir, stateDir };
}

function fakeGit(repo: { sha: string; commitAtMs: number; subjects: string[] }, checkoutDir?: string): GitRunner {
  return (args) => {
    if (args[0] === "fetch") return { stdout: "", exitCode: 0 };
    if (args[0] === "rev-parse") return { stdout: `${repo.sha}\n`, exitCode: 0 };
    if (args[0] === "log" && args[1] === "-1") return { stdout: `${Math.floor(repo.commitAtMs / 1000)}\n`, exitCode: 0 };
    if (args[0] === "log") return { stdout: repo.subjects.map((s) => `${s}\n`).join(""), exitCode: 0 };
    if (args[0] === "worktree" && args[1] === "add" && checkoutDir) {
      cpSync(checkoutDir, args[args.length - 2]!, { recursive: true });
      return { stdout: "", exitCode: 0 };
    }
    if (args[0] === "worktree") return { stdout: "", exitCode: 0 };
    return { stdout: "", exitCode: 1 };
  };
}

// Rejects ONLY the named job's spawn (read back from its work-order stdin,
// same `Job: <id>.` line test/scheduler-tick.test.ts's jobOf() reads) — a
// full day later standup (2h grid) and strategy (6h grid) are ALSO due, and
// a spawner that failed every job would mint its own alarm issue for each of
// them too, muddying what this test is actually pinning: council's OWN
// repeat-failure behavior.
function spawnerRejectingJob(jobId: string): Spawner {
  return (_argv, opts) => {
    const isTarget = new RegExp(`Job: ${jobId}\\.`).test(opts.stdin);
    return {
      exited: isTarget ? Promise.reject(new Error("spawn EACCES")) : Promise.resolve({ exitCode: 0 }),
      kill() {},
    };
  };
}
const failingSpawner = spawnerRejectingJob("council");

const T = Date.UTC(2026, 6, 18, 10, 20);

describe("tick failure alarm (#558 part 2, integration)", () => {
  // The test that matters most: a job failing on two SEPARATE tick cycles
  // (not two calls within one tick — the real recurrence shape) must file
  // exactly once and bump thereafter. Ablation: revert the dedup key to
  // include cycleId (e.g. `scheduler-${jobId}-${cycleId}-fail`) and this
  // goes red with 2 creates instead of 1 — that is the exact duplicate-storm
  // regression (#635) this design exists to prevent.
  test("council fails on two separate ticks ⇒ one issue created, second failure only bumps it", async () => {
    const dirs = makeDirs();
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: defaultAnchor(), // never attempted ⇒ due immediately
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet);
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const { gh, calls, issues } = statefulFakeGh();
    const deps = (now: number) => ({
      clock: () => now,
      gitRunner: fakeGit(repo, dirs.checkoutDir),
      spawner: failingSpawner,
      ghRunner: gh,
      ...dirs,
    });

    const r1 = await tick(deps(T));
    expect(r1.fired.find((f) => f.jobId === "council")).toEqual({ jobId: "council", result: "fail" });
    expect(calls.filter((c) => c.args[1] === "create").length).toBe(1);
    expect(issues.length).toBe(1);
    const firstIssue = issues[0]!.number;

    // One full grid period later: council is due again (period 24h), fails again.
    // standup (2h grid) and strategy (6h grid) are also due by now but SUCCEED
    // under this spawner, so they mint no alarm of their own.
    const r2 = await tick(deps(T + DAY));
    expect(r2.fired.find((f) => f.jobId === "council")).toEqual({ jobId: "council", result: "fail" });
    expect(calls.filter((c) => c.args[1] === "create").length).toBe(1); // still exactly one
    expect(issues.length).toBe(1); // no second issue minted
    expect(calls.some((c) => c.args[1] === "comment" && c.args[2] === String(firstIssue))).toBe(true);
  });

  // Ablation checked and reported (does NOT go red): removing the
  // `deps.ghRunner &&` guard still passes this test, because the surrounding
  // try/catch (pinned by the "ghRunner throws" test below) absorbs the
  // resulting `undefined is not a function` the same way it absorbs a real
  // gh outage — `toEqual` on `r.fired` cannot see which of the two silenced
  // it. The guard's actual job is avoiding a pointless throw-and-swallow per
  // failing job, not correctness (the try/catch alone already makes a
  // missing runner harmless); this test therefore only pins the WEAKER
  // claim in its title — tick completes, no throw reaches the caller — not
  // that the guard specifically is what does it.
  test("no ghRunner wired ⇒ failing job still recorded, tick completes, no throw", async () => {
    const dirs = makeDirs();
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: defaultAnchor(),
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet);
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const r = await tick({ clock: () => T, gitRunner: fakeGit(repo, dirs.checkoutDir), spawner: failingSpawner, ...dirs });
    expect(r.fired).toEqual([{ jobId: "council", result: "fail" }]);
  });

  // Ablation: drop the try/catch around fileFailureAlarm at the tick.ts call
  // site and this test goes red — a throwing gh runner would blow up the tick.
  test("ghRunner throws ⇒ tick still completes, lock released, other jobs unaffected", async () => {
    const dirs = makeDirs();
    const quiet: Record<JobId, JobAnchor> = {
      standup: { ...defaultAnchor(), lastAttemptAt: T },
      strategy: { ...defaultAnchor(), lastAttemptAt: T },
      council: defaultAnchor(),
      steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
    };
    saveAnchors(dirs.stateDir, quiet);
    const repo = { sha: "aaa", commitAtMs: T - HOUR, subjects: [] as string[] };
    const throwingGh: GhRunner = () => {
      throw new Error("gh: network unreachable");
    };
    const r = await tick({
      clock: () => T,
      gitRunner: fakeGit(repo, dirs.checkoutDir),
      spawner: failingSpawner,
      ghRunner: throwingGh,
      ...dirs,
    });
    expect(r.fired).toEqual([{ jobId: "council", result: "fail" }]);
    expect(r.skipped).toBe(null);
  });
});
