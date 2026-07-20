// Batch A / Task A1 (#114): flat-JSON scheduler state — anchors, lock, stop sentinel.
// Offline per plan §Global constraints: temp dirs only, no mocks needed.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOB_IDS,
  acquireLock,
  defaultAnchor,
  loadAnchors,
  releaseLock,
  saveAnchors,
  stopRequested,
} from "../src/scheduler/state";

const tmp = () => mkdtempSync(join(tmpdir(), "sched-state-"));

describe("scheduler state (A1)", () => {
  // Catches: a half-written state file bricking every future tick (the
  // chat-enum crash-loop class, AGENTS.md persisted-state rule).
  test("truncated/corrupt anchors.json loads as defaults with no throw", () => {
    const dir = tmp();
    writeFileSync(join(dir, "anchors.json"), '{"standup":{"lastAttemptAt":17'); // truncated mid-write
    const anchors = loadAnchors(dir);
    for (const id of JOB_IDS) expect(anchors[id]).toEqual(defaultAnchor());
  });

  test("missing anchors.json (fresh install) loads as defaults", () => {
    const anchors = loadAnchors(tmp());
    for (const id of JOB_IDS) expect(anchors[id]).toEqual(defaultAnchor());
  });

  // Catches: schema tightening crashing on persisted state that predates it
  // (binding AGENTS.md rule) — the pre-failStreak artifact must load, keeping
  // its healthy fields, with failStreak defaulted rather than the whole entry
  // (or process) lost.
  test("anchors entry missing failStreak (predates the schema) loads with default 0", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "anchors.json"),
      JSON.stringify({
        standup: { lastAttemptAt: 1000, lastSuccessAt: 1000, lastResult: "ok", stewardAnchorSha: null },
      }),
    );
    const anchors = loadAnchors(dir);
    expect(anchors.standup.failStreak).toBe(0);
    expect(anchors.standup.lastAttemptAt).toBe(1000);
    expect(anchors.standup.lastResult).toBe("ok");
  });

  test("an entry with a corrupt field keeps its healthy fields", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "anchors.json"),
      JSON.stringify({
        strategy: { lastAttemptAt: 2000, lastSuccessAt: null, lastResult: "sideways", failStreak: -3, stewardAnchorSha: null },
      }),
    );
    const anchors = loadAnchors(dir);
    expect(anchors.strategy.lastAttemptAt).toBe(2000);
    expect(anchors.strategy.lastResult).toBe(null); // invalid enum value → field default
    expect(anchors.strategy.failStreak).toBe(0); // negative streak → field default
  });

  // Catches: a save/load cycle that mutates the file (ordering churn, tmp
  // residue) — the atomic-write contract is tmp file + rename, byte-stable.
  test("save→load round-trip is byte-stable and leaves no tmp file", () => {
    const dir = tmp();
    const anchors = loadAnchors(dir);
    anchors.standup.lastAttemptAt = 123;
    anchors.standup.lastResult = "fail";
    anchors.standup.failStreak = 2;
    anchors.steward.stewardAnchorSha = "abc123";
    saveAnchors(dir, anchors);
    const first = readFileSync(join(dir, "anchors.json"), "utf8");
    saveAnchors(dir, loadAnchors(dir));
    const second = readFileSync(join(dir, "anchors.json"), "utf8");
    expect(second).toBe(first);
    expect(existsSync(join(dir, "anchors.json.tmp"))).toBe(false);
  });

  // Catches: a crashed tick holding the lock forever = scheduler silently dead;
  // and the inverse — a live tick's lock not being respected (double-fire).
  test("stale lock is broken, fresh lock is respected", () => {
    const dir = tmp();
    const t0 = 1_000_000;
    const staleMs = 60_000;
    expect(acquireLock(dir, t0, staleMs)).toBe(true);
    expect(acquireLock(dir, t0 + 30_000, staleMs)).toBe(false); // fresh → respected
    expect(acquireLock(dir, t0 + 61_000, staleMs)).toBe(true); // age > staleMs → broken
    releaseLock(dir);
    expect(acquireLock(dir, t0 + 62_000, staleMs)).toBe(true); // released → reacquirable
    releaseLock(dir);
    releaseLock(dir); // double release is a no-op, not a throw
  });

  test("stop sentinel is seen when present, absent otherwise", () => {
    const dir = tmp();
    expect(stopRequested(dir)).toBe(false);
    writeFileSync(join(dir, "stop"), "");
    expect(stopRequested(dir)).toBe(true);
  });
});
