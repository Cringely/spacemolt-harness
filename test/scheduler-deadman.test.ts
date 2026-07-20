// Durable scheduler (#114) Stage 2: dead-man staleness alarm
// (scripts/scheduler-deadman.sh). The script is the watcher-of-the-watcher --
// it runs from its own cron entry, independent of bun, so these tests drive
// the real POSIX-sh script end to end. Zero network: SCHEDULER_ALARM_SINK
// redirects every would-be ntfy POST to a file, so the suite POSTs nothing and
// needs no token. Guarded with skipIf so a host without `sh` (a bare Windows
// box) skips rather than fails.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "scheduler-deadman.sh");
const HAVE_SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;
const NOW_SEC = () => Math.floor(Date.now() / 1000);

// sh gets POSIX paths; Node's fs keeps native ones. On the Linux CI/Docker
// host cygpath is absent and paths are already POSIX, so this is identity.
function toPosix(p: string): string {
  if (process.platform !== "win32") return p;
  const r = spawnSync("cygpath", ["-u", p], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : p;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  sink: string[]; // notifications the run would have POSTed: "TYPE|title|message"
}

/** A wired scheduler state dir + env file; helpers write the artifacts a real
 *  tick would leave behind. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sched-deadman-"));
  const stateDir = join(root, "state");
  const secretsDir = join(root, "secrets");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  const envFile = join(root, "env");
  writeFileSync(envFile, `SCHEDULER_STATE_DIR=${toPosix(stateDir)}\nSCHEDULER_SECRETS=${toPosix(secretsDir)}\n`);
  const sinkFile = join(root, "sink");

  // Write last-tick / lock with a given AGE in seconds (mtime is what the
  // script reads). Content mirrors what the real code writes (epoch ms).
  const setAge = (name: string, ageSec: number) => {
    const p = join(stateDir, name);
    const whenSec = NOW_SEC() - ageSec;
    writeFileSync(p, String(whenSec * 1000));
    utimesSync(p, whenSec, whenSec);
  };

  const spawn = (cmd: string, argv: string[], env: Record<string, string>): Run => {
    writeFileSync(sinkFile, ""); // truncate so each run's sink is only its own POSTs
    const r = spawnSync(cmd, argv, {
      encoding: "utf8",
      env: {
        ...process.env,
        SPACEMOLT_SCHED_ENV: toPosix(envFile),
        SCHEDULER_ALARM_SINK: toPosix(sinkFile),
        ...env,
      },
    });
    const sink = existsSync(sinkFile)
      ? readFileSync(sinkFile, "utf8").split("\n").filter((l) => l.trim() !== "")
      : [];
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", sink };
  };

  // Normal path: invoke via `sh SCRIPT` (portable to the Windows dev host).
  const run = (env: Record<string, string> = {}): Run => spawn("sh", [toPosix(SCRIPT)], env);
  // Cron's REAL path: invoke the script BY ITS PATH with no `sh` prefix, so the
  // committed exec bit + shebang are what run it. A mode regression fails here
  // ("Permission denied") -- the sh-wrapped cases would mask it. Linux only.
  const runDirect = (env: Record<string, string> = {}): Run => spawn(SCRIPT, [], env);

  return {
    stateDir,
    secretsDir,
    run,
    runDirect,
    setLastTickAge: (s: number) => setAge("last-tick", s),
    setLockAge: (s: number) => setAge("lock", s),
    touch: (name: string) => writeFileSync(join(stateDir, name), ""),
    sentinelExists: () => existsSync(join(stateDir, "deadman-alerted")),
  };
}

describe.skipIf(!HAVE_SH)("dead-man staleness alarm (stage 2)", () => {
  // Catches: alarming on a host that never ticked (fresh-install false alarm).
  test("no last-tick yet: skips, does not alarm", () => {
    const f = fixture();
    const r = f.run();
    expect(r.status).toBe(0);
    expect(r.sink).toHaveLength(0);
    expect(r.stdout).toContain("has not ticked yet");
  });

  // Catches: alarming during normal operation.
  test("fresh tick within threshold: healthy, no alarm", () => {
    const f = fixture();
    f.setLastTickAge(120); // 2m ago, threshold 30m
    const r = f.run();
    expect(r.sink).toHaveLength(0);
    expect(r.stdout).toContain("healthy");
  });

  // Catches: the core failure -- tick died early / cron stopped, no lock held.
  // This is exactly the 2026-07-19 silent-outage class (#394).
  test("stale tick, no lock: fires a stale alarm and opens a breach", () => {
    const f = fixture();
    f.setLastTickAge(3600); // 1h stale
    const r = f.run();
    expect(r.sink).toHaveLength(1);
    expect(r.sink[0]).toContain("stale|");
    expect(r.sink[0]).toContain("STALE");
    expect(f.sentinelExists()).toBe(true);
  });

  // Catches: false alarm during a legitimate long catch-up burst -- a fresh
  // lock proves a tick is mid-run, so old last-tick is expected.
  test("stale tick but a FRESH lock is held: suppressed (tick legitimately running)", () => {
    const f = fixture();
    f.setLastTickAge(3600);
    f.setLockAge(300); // 5m -> well under LOCK_FRESH_SEC (3h)
    const r = f.run();
    expect(r.sink).toHaveLength(0);
    expect(f.sentinelExists()).toBe(false);
  });

  // Catches: a crashed tick's STALE lock silencing the alarm forever. A lock
  // older than the 3h self-heal window is a dead tick and must still alarm.
  test("stale tick with a STALE lock (older than self-heal window): still alarms", () => {
    const f = fixture();
    f.setLastTickAge(4 * 3600);
    f.setLockAge(4 * 3600); // > LOCK_FRESH_SEC 3h
    const r = f.run();
    expect(r.sink).toHaveLength(1);
    expect(r.sink[0]).toContain("stale|");
  });

  // Catches: alarm spam every 10 minutes across a long outage.
  test("still stale within cooldown: no repeat alarm", () => {
    const f = fixture();
    f.setLastTickAge(3600);
    expect(f.run().sink).toHaveLength(1); // first breach
    f.setLastTickAge(3660); // still stale a run later
    const r2 = f.run();
    expect(r2.sink).toHaveLength(0); // cooldown holds
    expect(r2.stdout).toContain("within");
  });

  // Catches: cooldown never letting a long outage re-ping the operator.
  test("still stale past cooldown: re-alarms", () => {
    const f = fixture();
    f.setLastTickAge(3600);
    expect(f.run().sink).toHaveLength(1);
    f.setLastTickAge(3600);
    const r2 = f.run({ ALERT_COOLDOWN_SEC: "0" }); // cooldown elapsed
    expect(r2.sink).toHaveLength(1);
    expect(r2.sink[0]).toContain("stale|");
  });

  // Catches: no signal that an outage ended -- the operator must learn recovery
  // without an ssh.
  test("recovery: an open breach that clears sends one recovery ping and closes", () => {
    const f = fixture();
    f.setLastTickAge(3600);
    expect(f.run().sink).toHaveLength(1);
    expect(f.sentinelExists()).toBe(true);
    f.setLastTickAge(60); // ticks resumed
    const r2 = f.run();
    expect(r2.sink).toHaveLength(1);
    expect(r2.sink[0]).toContain("recovery|");
    expect(r2.sink[0]).toContain("RECOVERED");
    expect(f.sentinelExists()).toBe(false);
  });

  // Catches: alarming while the operator has intentionally paused the scheduler.
  test("stop sentinel present: never alarms and resets any open breach", () => {
    const f = fixture();
    f.setLastTickAge(3600);
    expect(f.run().sink).toHaveLength(1); // breach opened
    f.touch("stop");
    const r2 = f.run();
    expect(r2.sink).toHaveLength(0);
    expect(r2.stdout).toContain("paused");
    expect(f.sentinelExists()).toBe(false); // breach reset so resume is clean
  });

  // Catches: a fake threshold not taking effect -- the runbook's documented
  // test path (run with a small threshold against an artificially aged file).
  test("STALE_THRESHOLD_SEC override is honored", () => {
    const f = fixture();
    f.setLastTickAge(120); // 2m -- healthy at default 30m
    expect(f.run().sink).toHaveLength(0);
    const r = f.run({ STALE_THRESHOLD_SEC: "60" }); // now 2m > 1m threshold
    expect(r.sink).toHaveLength(1);
  });

  // Catches: the script committed non-executable, so cron's direct exec fails
  // with "Permission denied" and the watchdog is DOA -- the sh-wrapped cases
  // above would pass anyway and hide it (the L-39 boundary the commit cites).
  // Skipped on Windows (no exec bit / shebang); stays live on Linux CI.
  test.skipIf(process.platform === "win32")(
    "runs via its own exec bit (cron's path, no sh prefix): fires the alarm",
    () => {
      const f = fixture();
      f.setLastTickAge(3600);
      const r = f.runDirect();
      expect(r.status).toBe(0); // 126 = not executable
      expect(r.sink).toHaveLength(1);
      expect(r.sink[0]).toContain("stale|");
    },
  );

  // Catches: a missing ntfy token crashing the run instead of degrading loudly.
  test("missing token (real POST path): degrades loudly in logs, no crash, retries", () => {
    const f = fixture();
    f.setLastTickAge(3600);
    // Drop the sink so the real curl/wget path runs; no token file exists.
    const r = f.run({ SCHEDULER_ALARM_SINK: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ALARM SUPPRESSED");
    expect(f.sentinelExists()).toBe(false); // un-advanced so it retries once wired
  });
});
