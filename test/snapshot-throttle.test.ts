import { describe, expect, test } from "bun:test";
import {
  shouldEmitSnapshot,
  snapshotKey,
  SNAPSHOT_MIN_INTERVAL_MS,
  type SnapshotVitals,
  type SnapshotThrottleState,
} from "../src/agent/snapshot-throttle";

// A parked idle ship: full fuel/hull, docked, no cargo, unchanging credits.
const idle: SnapshotVitals = {
  credits: 1000, systemId: "sol", cargoUsed: 0, docked: true,
  fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
};

// Helper: the throttle state produced by emitting `v` at `now`, mirroring what
// agent.ts records after an emit.
function stateAfter(v: SnapshotVitals, now: number): SnapshotThrottleState {
  return { lastEmitAt: now, lastKey: snapshotKey(v) };
}

describe("status_snapshot throttle decision", () => {
  test("emits the first snapshot (no prior state) -- a trend needs a start point", () => {
    expect(shouldEmitSnapshot(null, idle, 0)).toBe(true);
  });

  test("SKIPS an unchanged snapshot within the 60s floor", () => {
    const prev = stateAfter(idle, 0);
    // 59s later, nothing changed -> no new data point, must not emit.
    expect(shouldEmitSnapshot(prev, idle, SNAPSHOT_MIN_INTERVAL_MS - 1_000)).toBe(false);
  });

  test("EMITS a changed vital within the 60s floor (salience beats cadence)", () => {
    const prev = stateAfter(idle, 0);
    const sold = { ...idle, credits: 1340 }; // a sale landed 10s in
    expect(shouldEmitSnapshot(prev, sold, 10_000)).toBe(true);
  });

  test("EMITS again after 60s of no change (the cadence floor)", () => {
    const prev = stateAfter(idle, 0);
    expect(shouldEmitSnapshot(prev, idle, SNAPSHOT_MIN_INTERVAL_MS)).toBe(true);
  });

  // Guards against the throttle silently regressing to "never emit after the
  // first" -- an idle ship over half an hour must still produce the slow-cadence
  // trend floor, one sample per 60s, not zero.
  test("an idle ship over 30 min still yields ~30 snapshots, not 0 and not ~150", () => {
    let prev: SnapshotThrottleState | null = null;
    let emitted = 0;
    // Simulate a 10s tick for 30 minutes.
    for (let t = 0; t < 30 * 60_000; t += 10_000) {
      if (shouldEmitSnapshot(prev, idle, t)) {
        emitted++;
        prev = stateAfter(idle, t);
      }
    }
    // 180 ticks at 10s each; ~one emit per 60s -> right around 30, and far below
    // the ~180 the per-tick emission produced.
    expect(emitted).toBeGreaterThanOrEqual(29);
    expect(emitted).toBeLessThanOrEqual(31);
  });
});

describe("snapshotKey salience", () => {
  test("each salient field flips the key so its change forces an emit", () => {
    const base = snapshotKey(idle);
    expect(snapshotKey({ ...idle, credits: 1001 })).not.toBe(base);
    expect(snapshotKey({ ...idle, systemId: "vega" })).not.toBe(base);
    expect(snapshotKey({ ...idle, cargoUsed: 1 })).not.toBe(base);
    expect(snapshotKey({ ...idle, docked: false })).not.toBe(base);
  });

  test("fuel drift within a 10% band is NOT salient; crossing a band is", () => {
    const v = { ...idle, fuel: 95 }; // 95/100 -> floor(9.5) = band 9
    // 91/100 -> floor(9.1) = band 9, same band -> no emit-forcing change.
    expect(snapshotKey({ ...v, fuel: 91 })).toBe(snapshotKey(v));
    // 88/100 -> floor(8.8) = band 8, dropped a band -> salient.
    expect(snapshotKey({ ...v, fuel: 88 })).not.toBe(snapshotKey(v));
  });

  test("hull band change is salient", () => {
    const base = snapshotKey(idle);
    expect(snapshotKey({ ...idle, hull: 40 })).not.toBe(base);
  });

  test("maxFuel/maxHull of 0 does not divide by zero (collapses to one band)", () => {
    const zeroed: SnapshotVitals = { ...idle, fuel: 0, maxFuel: 0, hull: 0, maxHull: 0 };
    expect(() => snapshotKey(zeroed)).not.toThrow();
    // Two zero-capacity snapshots share a band regardless of raw value.
    expect(snapshotKey(zeroed)).toBe(snapshotKey({ ...zeroed, fuel: 5, hull: 9 }));
  });
});
