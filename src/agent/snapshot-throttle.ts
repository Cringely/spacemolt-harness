// status_snapshot throttle (SM-10 efficiency fix).
//
// status_snapshot is pure telemetry -- the raw material for the dashboard's
// credits/fuel/hull trend charts. It was emitted on every wake, and the
// heartbeat wake fires on a fixed floor cadence even when the ship is parked
// and idle, so an untouched ship stamped out ~150 byte-identical snapshots per
// 30 minutes. That bloats the events table and the feed without adding a single
// new data point to any trend.
//
// The rule: emit at most once per SNAPSHOT_MIN_INTERVAL_MS PER AGENT, OR
// immediately when a salient value changed since the last emitted snapshot --
// whichever comes first. A real change (a sale, a jump, a refuel, docking)
// still lands promptly; a frozen ship falls back to the slow cadence floor.
//
// This is deliberately separate from the Layer-4 no-progress detector and the
// wake logic: those decide whether to REPLAN. This only decides whether to
// record a telemetry sample. Pure function, no I/O, so the decision is
// unit-testable in isolation (see test/snapshot-throttle.test.ts).

export const SNAPSHOT_MIN_INTERVAL_MS = 60_000;

// The subset of ship state a snapshot's "did anything meaningful change?"
// question depends on. Every field here is already on the StatusSnapshot the
// loop fetched this tick -- no new game call.
export interface SnapshotVitals {
  credits: number;
  systemId: string | null;
  cargoUsed: number;
  docked: boolean;
  fuel: number;
  maxFuel: number;
  hull: number;
  maxHull: number;
}

export interface SnapshotThrottleState {
  lastEmitAt: number; // epoch ms of the last EMITTED snapshot
  lastKey: string;    // salient fingerprint of that snapshot
}

// Fuel and hull are bucketed into 10% bands of capacity rather than compared
// raw: a slowly-draining tank must NOT count as "changed" every tick (that
// would defeat the throttle for any moving ship), but crossing a band -- the
// granularity the trend chart actually shows -- does. maxFuel/maxHull of 0
// (uninitialised or unknown) collapses to bucket 0 so it never divides by zero.
function bucket(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.floor((value / max) * 10);
}

// Salient fingerprint: two snapshots with the same key carry no new information
// for the operator's trend view, so the later one can wait for the cadence
// floor. credits/systemId/cargoUsed/docked are compared exactly; fuel/hull by
// band (see bucket).
export function snapshotKey(v: SnapshotVitals): string {
  return [
    v.credits,
    v.systemId ?? "",
    v.cargoUsed,
    v.docked ? 1 : 0,
    bucket(v.fuel, v.maxFuel),
    bucket(v.hull, v.maxHull),
  ].join("|");
}

// Returns true when this snapshot should be emitted. `prev` is null before the
// first snapshot of the process, which always emits (a trend needs a starting
// point). Otherwise: emit on any salient change immediately; on no change, emit
// only once the cadence floor has elapsed since the last emitted snapshot.
export function shouldEmitSnapshot(
  prev: SnapshotThrottleState | null,
  v: SnapshotVitals,
  now: number,
): boolean {
  if (!prev) return true;
  if (snapshotKey(v) !== prev.lastKey) return true;
  return now - prev.lastEmitAt >= SNAPSHOT_MIN_INTERVAL_MS;
}
