// Batch D / Task D-Health (#114): the --health probe. Until stage 2's alarm
// exists this is the operator's ONLY window into headless job failure, so the
// contract under test is positive signal, never inferred from silence (L-17):
// a job that never ran says "never", a failing job is flagged loudly, the
// gates line states each capability's posture explicitly.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBreaker, loadBreakers, saveBreakers, tripOpen } from "../src/scheduler/breaker";
import { saveLedger } from "../src/scheduler/dispatch-ledger";
import { health } from "../src/scheduler/health";
import { JOBS } from "../src/scheduler/jobs";
import { defaultAnchor, saveAnchors } from "../src/scheduler/state";
import { LAST_TICK_FILE } from "../src/scheduler/tick";

const NOW = Date.UTC(2026, 6, 18, 9, 0); // 09:00:00Z

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "sched-health-"));
  saveAnchors(stateDir, {
    // healthy: attempted+succeeded at its 08:07 grid point → next due 10:07
    standup: {
      lastAttemptAt: Date.UTC(2026, 6, 18, 8, 7),
      lastSuccessAt: Date.UTC(2026, 6, 18, 8, 7),
      lastResult: "ok",
      failStreak: 0,
      stewardAnchorSha: null,
    },
    // failing: last attempt 03:27, the 06:27 grid point since passed → due NOW
    strategy: {
      lastAttemptAt: Date.UTC(2026, 6, 18, 3, 27),
      lastSuccessAt: null,
      lastResult: "fail",
      failStreak: 2,
      stewardAnchorSha: null,
    },
    // never ran
    council: defaultAnchor(),
    // event-driven
    steward: {
      lastAttemptAt: Date.UTC(2026, 6, 17, 20, 0),
      lastSuccessAt: Date.UTC(2026, 6, 17, 20, 5),
      lastResult: "ok",
      failStreak: 0,
      stewardAnchorSha: "abc1234",
    },
  });
  writeFileSync(join(stateDir, LAST_TICK_FILE), String(Date.UTC(2026, 6, 18, 8, 57)));
  writeFileSync(join(stateDir, "lock"), String(Date.UTC(2026, 6, 18, 8, 57)));
  return stateDir;
}

describe("--health probe (D-Health)", () => {
  // Catches: a probe that hides a job — worse than no probe (plan §D-Health).
  test("renders a row per job: last attempt/success with ages, result, next due", () => {
    const out = health(fixture(), JOBS, NOW);
    for (const j of JOBS) expect(out).toContain(j.id);
    expect(out).toContain("2026-07-18T08:07:00.000Z (53m ago)"); // anchor age, not just a timestamp
    expect(out).toContain("next due 2026-07-18T10:07:00.000Z"); // grid arithmetic surfaced
    expect(out).toContain("due NOW"); // strategy missed its 06:27 point
    expect(out).toContain("on next main merge"); // steward is event-driven, never a grid time
    // council never ran: stated positively, not blank (L-17)
    expect(out).toContain("never");
    expect(out).toContain("result none");
  });

  test("gates summary, stop/lock presence, and last tick time are explicit", () => {
    const out = health(fixture(), JOBS, NOW);
    expect(out).toContain("filing ON / dispatch OFF / amend NEVER");
    expect(out).toContain("lock: PRESENT");
    expect(out).toContain("stop: absent");
    expect(out).toContain("last tick: 2026-07-18T08:57:00.000Z (3m ago)");
  });

  // Catches: silent job failure invisible to the operator — the one failure
  // window before stage 2's alarm exists.
  test("failStreak > 0 is surfaced prominently as a !! FAILING line naming job and streak", () => {
    const out = health(fixture(), JOBS, NOW);
    expect(out).toContain("!! FAILING: strategy failStreak 2");
  });

  // Catches: the probe crashing on a fresh install — the first thing an
  // operator runs (runbook E1 step 7) is health against a near-empty dir.
  test("empty state dir renders without throwing — everything 'never', nothing inferred", () => {
    const out = health(mkdtempSync(join(tmpdir(), "sched-health-empty-")), JOBS, NOW);
    for (const j of JOBS) expect(out).toContain(j.id);
    expect(out).toContain("last tick: never");
    expect(out).toContain("stop: absent");
    expect(out).not.toContain("!! FAILING");
    // Stage-3 lines present even on an empty ledger, all zeroed, no OPEN breaker.
    expect(out).toContain("dispatch ledger: 0 total | 0 in-flight");
    expect(out).toContain("breakers: standup CLOSED");
    expect(out).not.toContain("!! BREAKER OPEN");
  });

  // Catches: a latched dispatch breaker (dispatch HALTED) buried in a table row
  // instead of flagged loudly, and the ledger/sweep rollups going missing.
  test("stage-3: ledger totals, sweep counts, and an OPEN breaker are surfaced", () => {
    const dir = fixture();
    // One completed + one in-flight dispatch, and a latched strategy breaker.
    saveLedger(dir, [
      {
        dispatchId: "done",
        jobId: "strategy",
        issueRef: "#1",
        defectClass: "x",
        spawnedAt: NOW - 60_000,
        expectedDurationMs: 1_200_000,
        costBucket: "medium",
        lastHeartbeatAt: null,
        pokeCount: 0,
        outcome: "ok",
        completedAt: NOW,
        costUsd: 0.1234,
        inputTokens: 100,
        outputTokens: 50,
      },
      {
        dispatchId: "live",
        jobId: "council",
        issueRef: "#2",
        defectClass: "y",
        spawnedAt: NOW - 60_000,
        expectedDurationMs: 1_200_000,
        costBucket: "small",
        lastHeartbeatAt: NOW - 30_000,
        pokeCount: 0,
        outcome: null,
        completedAt: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
    const breakers = loadBreakers(dir);
    breakers.strategy = tripOpen(defaultBreaker(), "per-day-cap", NOW - 120_000);
    saveBreakers(dir, breakers);

    const out = health(dir, JOBS, NOW);
    expect(out).toContain("dispatch ledger: 2 total | 1 in-flight | 2 in last 24h | ok 1");
    expect(out).toContain("dispatch spend: $0.1234 total"); // actual cost summed onto the health probe
    expect(out).toContain("dispatch sweep: active 1 | quiet 0 | stale 0");
    expect(out).toContain("!! BREAKER OPEN: strategy — dispatch halted (per-day-cap");
    expect(out).toContain("strategy OPEN");
  });

  // Catches: subcommand wiring rot — health must run with ONLY the state dir
  // set (no checkout/secrets), exit 0, and print the report (runbook step 7).
  test("scripts/scheduler.ts health: exit 0 with only SCHEDULER_STATE_DIR set", () => {
    const root = join(import.meta.dir, "..");
    const env: Record<string, string | undefined> = { ...process.env, SCHEDULER_STATE_DIR: fixture() };
    delete env["SCHEDULER_CHECKOUT"];
    delete env["SCHEDULER_SECRETS"];
    const r = spawnSync(process.execPath, [join(root, "scripts", "scheduler.ts"), "health"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scheduler health");
    expect(r.stdout).toContain("filing ON / dispatch OFF / amend NEVER");
  });

  // Catches: the operator's ONLY path to close a latched breaker rotting — a
  // tripped breaker with no working reset means dispatch is halted forever.
  test("scripts/scheduler.ts reset-breaker: closes a latched breaker, exit 0", () => {
    const root = join(import.meta.dir, "..");
    const dir = fixture();
    const breakers = loadBreakers(dir);
    breakers.strategy = tripOpen(defaultBreaker(), "fail-streak", NOW);
    saveBreakers(dir, breakers);
    const env: Record<string, string | undefined> = { ...process.env, SCHEDULER_STATE_DIR: dir };
    delete env["SCHEDULER_CHECKOUT"];
    delete env["SCHEDULER_SECRETS"];
    const r = spawnSync(process.execPath, [join(root, "scripts", "scheduler.ts"), "reset-breaker", "strategy"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reset-breaker: strategy → closed");
    expect(loadBreakers(dir).strategy.status).toBe("closed");
  });

  // Catches: reset-breaker accepting a bogus job id (typo silently no-ops).
  test("scripts/scheduler.ts reset-breaker: unknown job ⇒ exit 2 + usage", () => {
    const root = join(import.meta.dir, "..");
    const env: Record<string, string | undefined> = { ...process.env, SCHEDULER_STATE_DIR: fixture() };
    const r = spawnSync(process.execPath, [join(root, "scripts", "scheduler.ts"), "reset-breaker", "bogus"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown job");
  });
});
