// Stage 4 (#183): the usage-endpoint capture slice. Offline — the endpoint is
// a fake injected fetcher, temp state/secrets dirs, zero live network, zero
// tokens on the wire. Each test targets a distinct failure mode of the capture
// mechanism (cadence, retry-after honoring, capture-once, token-leak, schema
// tolerance) plus one tick-level wiring proof.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOBS } from "../src/scheduler/jobs";
import type { Spawner } from "../src/scheduler/spawn";
import { defaultAnchor, saveAnchors, type JobAnchor, type JobId } from "../src/scheduler/state";
import { tick, type GitRunner } from "../src/scheduler/tick";
import {
  loadUsagePollState,
  POLL_INTERVAL_MS,
  pollUsage,
  redactUsageBody,
  saveUsagePollState,
  USAGE_CAPTURE_FILE,
  USAGE_POLL_STATE_FILE,
  type UsageFetcher,
  type UsageResponse,
} from "../src/scheduler/usage-poll";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const T = Date.UTC(2026, 6, 20, 12, 0);
const TOKEN = "sk-ant-oat01-THISVALUEMUSTNEVERLEAK-0123456789abcdef";

function makeDirs(token: string | null = TOKEN) {
  const stateDir = tmp("usage-state-");
  const secretsDir = tmp("usage-secrets-");
  if (token !== null) writeFileSync(join(secretsDir, "claude_oauth_token"), `${token}\n`);
  return { stateDir, secretsDir };
}

/** Fake endpoint: plan[i] is the i-th response; records the token it was handed. */
function fakeFetcher(plan: UsageResponse[]) {
  const tokensSeen: string[] = [];
  let i = 0;
  const fetcher: UsageFetcher = async (token) => {
    tokensSeen.push(token);
    const res = plan[Math.min(i, plan.length - 1)];
    i++;
    return res!;
  };
  return { fetcher, tokensSeen, get calls() {return i;} };
}

const ok200 = (body: string): UsageResponse => ({ status: 200, body, retryAfterSec: null });
const throttled = (sec: number | null): UsageResponse => ({ status: 429, body: "", retryAfterSec: sec });

describe("usage poll (#183 Stage 4 capture)", () => {
  // Catches: the poll ignoring its own cadence and hammering the endpoint every
  // 10-min tick — which guarantees a 429 storm and never captures anything.
  test("cadence: nextAllowedPollAt in the future ⇒ no network call, no state write", async () => {
    const dirs = makeDirs();
    saveUsagePollState(dirs.stateDir, { nextAllowedPollAt: T + POLL_INTERVAL_MS, capturedAt: null });
    const f = fakeFetcher([ok200("{}")]);
    const r = await pollUsage({ now: T, ...dirs, fetcher: f.fetcher });
    expect(f.calls).toBe(0);
    expect(r.polled).toBe(false);
    expect(r.reason).toBe("cadence");
  });

  // Catches: the first-200 shape not being captured, or captured un-redacted.
  test("first 200 ⇒ redacted capture file written, capturedAt set, next poll deferred one interval", async () => {
    const dirs = makeDirs();
    const body = JSON.stringify({ five_hour: { utilization: 0.6, resets_at: "2026-07-20T17:00:00Z" }, account_id: "acct_12345" });
    const f = fakeFetcher([ok200(body)]);
    const r = await pollUsage({ now: T, ...dirs, fetcher: f.fetcher, log: () => {} });
    expect(r.captured).toBe(true);
    expect(r.status).toBe(200);
    const capturePath = join(dirs.stateDir, USAGE_CAPTURE_FILE);
    expect(existsSync(capturePath)).toBe(true);
    const captured = readFileSync(capturePath, "utf8");
    expect(captured).toContain('"utilization": 0.6'); // usage numbers preserved
    expect(captured).toContain('"resets_at": "2026-07-20T17:00:00Z"'); // dates preserved
    expect(captured).toContain('"account_id": "<redacted>"'); // PII masked
    expect(loadUsagePollState(dirs.stateDir).capturedAt).toBe(T);
    expect(r.nextAllowedPollAt).toBe(T + POLL_INTERVAL_MS);
  });

  // Catches: re-writing the capture on every subsequent 200 (spec: written
  // ONCE) — a later 200 with a different body must not clobber the first shape.
  test("second 200 after capture ⇒ capture file NOT re-written", async () => {
    const dirs = makeDirs();
    const first = JSON.stringify({ marker: "FIRST", utilization: 0.1 });
    const second = JSON.stringify({ marker: "SECOND", utilization: 0.9 });
    const f = fakeFetcher([ok200(first), ok200(second)]);
    await pollUsage({ now: T, ...dirs, fetcher: f.fetcher, log: () => {} });
    // Next window elapses so cadence permits a second poll.
    const r2 = await pollUsage({ now: T + POLL_INTERVAL_MS, ...dirs, fetcher: f.fetcher, log: () => {} });
    expect(f.calls).toBe(2); // it DID poll again
    expect(r2.captured).toBe(false); // but did not capture again
    const captured = readFileSync(join(dirs.stateDir, USAGE_CAPTURE_FILE), "utf8");
    expect(captured).toContain("FIRST");
    expect(captured).not.toContain("SECOND");
  });

  // Catches: retry-after ignored — the 429 window-reset signal must be honored
  // EXACTLY and persisted so the next tick inside the window does not re-poll.
  test("429 with retry-after ⇒ next poll deferred by exactly retry-after; honored across ticks", async () => {
    const dirs = makeDirs();
    const f = fakeFetcher([throttled(1800), ok200("{}")]);
    const r1 = await pollUsage({ now: T, ...dirs, fetcher: f.fetcher, log: () => {} });
    expect(r1.status).toBe(429);
    expect(r1.nextAllowedPollAt).toBe(T + 1800 * 1000); // exact retry-after
    // A tick 29 min later is still inside the window ⇒ no poll.
    const r2 = await pollUsage({ now: T + 29 * 60_000, ...dirs, fetcher: f.fetcher, log: () => {} });
    expect(r2.reason).toBe("cadence");
    expect(f.calls).toBe(1);
    // A tick just past the window ⇒ polls (and here captures the 200).
    const r3 = await pollUsage({ now: T + 1800 * 1000 + 1, ...dirs, fetcher: f.fetcher, log: () => {} });
    expect(f.calls).toBe(2);
    expect(r3.status).toBe(200);
  });

  // Catches: a 429 with no retry-after header stalling forever or re-polling
  // instantly — it must fall back to the normal interval.
  test("429 without retry-after ⇒ falls back to the poll interval", async () => {
    const dirs = makeDirs();
    const f = fakeFetcher([throttled(null)]);
    const r = await pollUsage({ now: T, ...dirs, fetcher: f.fetcher, log: () => {} });
    expect(r.nextAllowedPollAt).toBe(T + POLL_INTERVAL_MS);
  });

  // Catches: a network throw crashing the tick — it must degrade to a deferred
  // retry, never propagate.
  test("fetcher throws ⇒ no throw, next poll deferred one interval", async () => {
    const dirs = makeDirs();
    const fetcher: UsageFetcher = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await pollUsage({ now: T, ...dirs, fetcher, log: () => {} });
    expect(r.reason).toBe("network-error");
    expect(r.nextAllowedPollAt).toBe(T + POLL_INTERVAL_MS);
  });

  // Catches: THE security invariant — the OAuth token leaking into any log line
  // or into the capture file, even when the response body echoes a token-shaped
  // value. Nothing the operator/PM reads may carry the secret.
  test("token never appears in any log line or the capture file (even when the body echoes one)", async () => {
    const dirs = makeDirs();
    const logs: string[] = [];
    // Body deliberately contains a token-shaped string under an innocuous key.
    const body = JSON.stringify({ note: "leaked?", session_token: TOKEN, blob: "zzzz-sk-ant-oat01-EMBEDDEDLEAK-9999999999" });
    const f = fakeFetcher([ok200(body)]);
    await pollUsage({ now: T, ...dirs, fetcher: f.fetcher, log: (l) => logs.push(l) });
    for (const line of logs) expect(line).not.toContain(TOKEN);
    expect(logs.join("\n")).toContain("token=loaded"); // the SAFE form is logged
    const captured = readFileSync(join(dirs.stateDir, USAGE_CAPTURE_FILE), "utf8");
    expect(captured).not.toContain(TOKEN); // sensitive-key value masked
    expect(captured).not.toContain("EMBEDDEDLEAK"); // token-shaped value masked too
    expect(f.tokensSeen).toEqual([TOKEN]); // the fetcher DID receive it (header path)
  });

  // Catches: a missing/rotated token file crashing the poll — it must skip
  // cleanly with a token=unset log, never a throw.
  test("missing token file ⇒ skip with no-token reason, no capture, no throw", async () => {
    const dirs = makeDirs(null); // no claude_oauth_token written
    const logs: string[] = [];
    const f = fakeFetcher([ok200("{}")]);
    const r = await pollUsage({ now: T, ...dirs, fetcher: f.fetcher, log: (l) => logs.push(l) });
    expect(r.reason).toBe("no-token");
    expect(f.calls).toBe(0);
    expect(existsSync(join(dirs.stateDir, USAGE_CAPTURE_FILE))).toBe(false);
    expect(logs.join("\n")).toContain("token=unset");
  });

  // Catches: persisted-state intolerance — a state file predating this slice
  // (absent), or a corrupt one, must load to defaults, never crash (binding
  // AGENTS.md rule). Absent ⇒ poll-immediately default.
  test("persisted-state tolerance: absent file ⇒ defaults; corrupt file ⇒ defaults", async () => {
    const dirs = makeDirs();
    // Absent: no usage-poll.json exists (the pre-change reality).
    expect(loadUsagePollState(dirs.stateDir)).toEqual({ nextAllowedPollAt: 0, capturedAt: null });
    // Corrupt / wrong-typed fields degrade per-field.
    writeFileSync(join(dirs.stateDir, USAGE_POLL_STATE_FILE), '{"nextAllowedPollAt":"soon","capturedAt":"garbage"}');
    expect(loadUsagePollState(dirs.stateDir)).toEqual({ nextAllowedPollAt: 0, capturedAt: null });
    // Truncated JSON.
    writeFileSync(join(dirs.stateDir, USAGE_POLL_STATE_FILE), "{not json");
    expect(loadUsagePollState(dirs.stateDir)).toEqual({ nextAllowedPollAt: 0, capturedAt: null });
  });

  // Catches: an unparseable body throwing in the redactor instead of redacting
  // wholesale.
  test("redactUsageBody: unparseable body ⇒ wholesale redaction, no throw", () => {
    const out = redactUsageBody("<html>429 too many requests</html>");
    expect(out).toContain("unparseable usage body redacted");
    expect(out).not.toContain("429 too many requests");
  });
});

// ---- Tick-level wiring: prove tick actually drives the poll when a fetcher is
// wired, and skips it (no capture) when none is. -------------------------------

const CHARTER_TEXT = "# Charter: test\nNEVER merge.\n";

function makeTickDirs() {
  const checkoutDir = tmp("uptick-checkout-");
  const secretsDir = tmp("uptick-secrets-");
  const stateDir = tmp("uptick-state-");
  const { mkdirSync } = require("node:fs");
  const { dirname } = require("node:path");
  for (const job of JOBS) {
    const p = join(checkoutDir, job.charterPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, CHARTER_TEXT);
  }
  mkdirSync(join(checkoutDir, "docs"), { recursive: true });
  writeFileSync(join(checkoutDir, "docs", "STATE.md"), "# State\n\n## NOW\n\nfine\n");
  for (const name of ["claude_oauth_token", "gh_pat_readcomment", "gh_pat_steward", "instruct_bearer", "store_bearer"]) {
    writeFileSync(join(secretsDir, name), name === "claude_oauth_token" ? `${TOKEN}\n` : "SENTINEL\n");
  }
  // Quiesce every job so the poll is the tick's only observable effect.
  const quiet: Record<JobId, JobAnchor> = {
    standup: { ...defaultAnchor(), lastAttemptAt: T },
    strategy: { ...defaultAnchor(), lastAttemptAt: T },
    council: { ...defaultAnchor(), lastAttemptAt: T },
    steward: { ...defaultAnchor(), stewardAnchorSha: "aaa" },
  };
  saveAnchors(stateDir, quiet);
  return { checkoutDir, secretsDir, stateDir };
}

const quietGit: GitRunner = (args) => {
  if (args[0] === "fetch") return { stdout: "", exitCode: 0 };
  if (args[0] === "rev-parse") return { stdout: "aaa\n", exitCode: 0 };
  if (args[0] === "log" && args[1] === "-1") return { stdout: `${Math.floor((T - 3_600_000) / 1000)}\n`, exitCode: 0 };
  if (args[0] === "log") return { stdout: "", exitCode: 0 };
  return { stdout: "", exitCode: 1 };
};
const noopSpawner: Spawner = () => ({ exited: Promise.resolve({ exitCode: 0 }), kill() {} });

describe("tick wiring (#183 Stage 4)", () => {
  // Catches: tick not driving the poll at all — a wired fetcher must produce a
  // capture on a first 200.
  test("fetcher wired ⇒ tick polls and writes the capture; usagePoll surfaced in the result", async () => {
    const dirs = makeTickDirs();
    const f = fakeFetcher([ok200(JSON.stringify({ utilization: 0.42 }))]);
    const r = await tick({ clock: () => T, gitRunner: quietGit, spawner: noopSpawner, usageFetcher: f.fetcher, ...dirs });
    expect(r.usagePoll.captured).toBe(true);
    expect(existsSync(join(dirs.stateDir, USAGE_CAPTURE_FILE))).toBe(true);
  });

  // Catches: an accidental poll when no fetcher is wired (the existing tick
  // tests' path) — it must be a clean no-fetcher skip, no capture file.
  test("no fetcher ⇒ tick skips the poll cleanly (no-fetcher), no capture file", async () => {
    const dirs = makeTickDirs();
    const r = await tick({ clock: () => T, gitRunner: quietGit, spawner: noopSpawner, ...dirs });
    expect(r.usagePoll.reason).toBe("no-fetcher");
    expect(existsSync(join(dirs.stateDir, USAGE_CAPTURE_FILE))).toBe(false);
  });
});
