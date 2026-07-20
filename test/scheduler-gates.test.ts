// Batch C / Task C1 (#114): D1 capability gates — filing on, dispatch off,
// amend never (spec §Self-correction boundary). Offline: temp dirs only.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canAmend, canDispatch, canFile, defaultGates, loadGates } from "../src/scheduler/gates";

const tmp = () => mkdtempSync(join(tmpdir(), "sched-gates-"));

describe("D1 capability gates (C1)", () => {
  // Catches: shipping stage 1 with the gate inverted (filing off or dispatch on).
  test("defaults: filing on, dispatch off", () => {
    const g = loadGates(tmp()); // no gates.json yet → defaults
    expect(g).toEqual(defaultGates());
    expect(canFile(g)).toBe(true);
    expect(canDispatch(g)).toBe(false);
  });

  // Catches: a flag flip enabling dispatch without stage-3 live verification
  // (verdict (b) condition 1 — observed live, not merged).
  test("canDispatch false with enabled true but verifiedLiveAt null", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "gates.json"),
      JSON.stringify({
        fileFindings: { enabled: true },
        dispatchFixAgents: { enabled: true, verifiedLiveAt: null },
        amendOwnCharter: {},
      }),
    );
    expect(canDispatch(loadGates(dir))).toBe(false);
  });

  // Catches: canDispatch hardcoded false — stage 3's one wire-up point would
  // silently never open even after live verification.
  test("canDispatch true when enabled AND verifiedLiveAt set", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "gates.json"),
      JSON.stringify({
        fileFindings: { enabled: true },
        dispatchFixAgents: { enabled: true, verifiedLiveAt: 1_752_800_000_000 },
        amendOwnCharter: {},
      }),
    );
    expect(canDispatch(loadGates(dir))).toBe(true);
  });

  // Catches: verdict (c) "never" degrading into a config flag.
  test("canAmend false even when a forged file claims enabled", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "gates.json"),
      JSON.stringify({
        fileFindings: { enabled: true },
        dispatchFixAgents: { enabled: true, verifiedLiveAt: 123 },
        amendOwnCharter: { enabled: true, verifiedLiveAt: 123 },
      }),
    );
    expect(canAmend(loadGates(dir))).toBe(false);
    expect(canAmend()).toBe(false);
  });

  // Catches: a half-written or predating gates.json bricking the tick (the
  // chat-enum crash-loop class; binding AGENTS.md persisted-state rule).
  test("corrupt gates.json loads as defaults, never a throw", () => {
    const dir = tmp();
    writeFileSync(join(dir, "gates.json"), '{"fileFindings":{"ena'); // truncated mid-write
    expect(loadGates(dir)).toEqual(defaultGates());
  });

  test("gates.json predating the dispatch/amend keys keeps its one field, defaults the rest", () => {
    const dir = tmp();
    writeFileSync(join(dir, "gates.json"), JSON.stringify({ fileFindings: { enabled: false } }));
    const g = loadGates(dir);
    expect(canFile(g)).toBe(false); // the operator's explicit off is honored
    expect(canDispatch(g)).toBe(false); // missing key → default off, not a throw
  });
});
