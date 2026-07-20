import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Planner } from "../src/planner/types";
import {
  progressCountersTotal,
  EXCLUDED_MOVEMENT_COUNTERS,
} from "../src/agent/no-progress-detector";

// Deterministic A/B exit (#240, the #251 lesson): the config-expressed revert
// condition must be evaluated by the harness and fire EXACTLY ONCE -- switch
// to the fallback planner, emit experiment_reverted, and never flap back.
// Offline: fake api, planners that never produce a plan (so every tick is a
// no_plan wake -> one activePlanner() call), fake clock.

const HOUR = 3_600_000;

const cfg = (experiment?: { revertIfNo: string; withinHours: number }): AgentConfig => ({
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
  stallThreshold: 1_000_000, subscriptionCooldownMinutes: 60,
  maxPlansPerWindow: 1_000_000, planBudgetWindowMinutes: 60,
  // Steward + heartbeat windows unreachably large so neither contaminates the
  // event stream or consumes ticks under test.
  fuelReservePct: 25, stuckWindowMinutes: 10_000_000, strandAutoSelfDestruct: false,
  progressHeartbeatMinutes: 10_000_000,
  experiment,
});

// Every plan() call throws a PLAIN error (the "validation failed after retry"
// class): planState stays "none", so each runOnce wakes no_plan and calls the
// active planner exactly once -- a per-tick probe of WHICH planner is live.
function countingPlanner(): Planner & { calls: number } {
  return {
    calls: 0,
    async plan() { (this as { calls: number }).calls++; throw new Error("test planner declines"); },
  };
}

function api(ctrl: { stats: Record<string, number> | undefined }): GameApi {
  return {
    async action() { return { result: "ok" }; },
    async status(): Promise<StatusSnapshot> {
      return {
        credits: 500, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
        cargoUsed: 0, cargoCapacity: 100, docked: true, inTransit: false,
        systemId: "sys_a", stats: ctrl.stats,
      };
    },
    async notifications() { return []; },
  };
}

const reverts = (store: Store) =>
  store.recentEvents("a1", 100_000).filter((e) => e.type === "experiment_reverted");

describe("deterministic A/B exit (experiment revert)", () => {
  // Breakage caught: the exit not firing (SM-8's failure shape -- a revert
  // condition nobody evaluates), firing more than once, or failing to move the
  // agent onto the fallback planner.
  test("no progress for the window -> fires exactly once, event emitted, fallback selected", async () => {
    const ctrl = { stats: { missions_completed: 3 } as Record<string, number> | undefined };
    const store = new Store(":memory:");
    const primary = countingPlanner();
    const fallback = countingPlanner();
    let now = 0;
    const agent = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary, fallbackPlanner: fallback,
      config: cfg({ revertIfNo: "missions_completed", withinHours: 2 }), now: () => now,
    });

    await agent.runOnce(); // t=0: seeds the experiment baseline; primary plans
    expect(primary.calls).toBe(1);
    expect(reverts(store).length).toBe(0);

    now += 2 * HOUR; // counter flat for the whole window
    await agent.runOnce();
    expect(reverts(store).length).toBe(1);
    expect(fallback.calls).toBe(1); // the SAME tick already plans with the fallback
    expect(primary.calls).toBe(1);

    const payload = reverts(store)[0]!.payload as { counter: string; withinHours: number; stalledMs: number };
    expect(payload.counter).toBe("missions_completed");
    expect(payload.withinHours).toBe(2);
    expect(payload.stalledMs).toBe(2 * HOUR);

    // Many more stalled ticks: still exactly one event, still the fallback.
    for (let i = 0; i < 5; i++) { now += HOUR; await agent.runOnce(); }
    expect(reverts(store).length).toBe(1);
    expect(primary.calls).toBe(1);
  });

  // Breakage caught: the latch being removed or made two-way (flap). Ablation:
  // disable the one-way latch (un-revert on progress) and this fails --
  // progress under the FALLBACK would hand the failed primary the pilot back.
  test("one-way latch: progress after the revert never flaps back to the primary", async () => {
    const ctrl = { stats: { missions_completed: 0 } as Record<string, number> | undefined };
    const store = new Store(":memory:");
    const primary = countingPlanner();
    const fallback = countingPlanner();
    let now = 0;
    const agent = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary, fallbackPlanner: fallback,
      config: cfg({ revertIfNo: "missions_completed", withinHours: 2 }), now: () => now,
    });

    await agent.runOnce();
    now += 2 * HOUR;
    await agent.runOnce(); // trips
    expect(reverts(store).length).toBe(1);

    // The pilot now progresses (the fallback is working) -- that is evidence
    // FOR the fallback, not for the planner under test.
    ctrl.stats = { missions_completed: 7 };
    now += HOUR;
    await agent.runOnce();
    ctrl.stats = { missions_completed: 9 };
    now += HOUR;
    await agent.runOnce();

    expect(primary.calls).toBe(1); // never reinstated
    expect(fallback.calls).toBe(3);
    expect(reverts(store).length).toBe(1); // and never re-emitted
  });

  // Breakage caught: the window not being rolling -- a pilot progressing
  // steadily must never be reverted just because total elapsed time exceeds
  // the window.
  test("progress inside the window re-seeds the clock; a later full dry window still trips", async () => {
    const ctrl = { stats: { missions_completed: 0 } as Record<string, number> | undefined };
    const store = new Store(":memory:");
    const primary = countingPlanner();
    const fallback = countingPlanner();
    let now = 0;
    const agent = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary, fallbackPlanner: fallback,
      config: cfg({ revertIfNo: "missions_completed", withinHours: 2 }), now: () => now,
    });

    await agent.runOnce(); // seed
    now += HOUR;
    ctrl.stats = { missions_completed: 1 }; // progress at t=1h -> clock re-seeds
    await agent.runOnce();
    now += 1.9 * HOUR; // t=2.9h total, but only 1.9h since the last advance
    await agent.runOnce();
    expect(reverts(store).length).toBe(0);
    expect(fallback.calls).toBe(0);

    now += 0.1 * HOUR; // 2h flat since the advance: NOW it trips
    await agent.runOnce();
    expect(reverts(store).length).toBe(1);
  });

  // Breakage caught: revert_if_no watching the wrong signal -- a NAMED counter
  // must trip on ITS flatline even while other progress dimensions climb
  // ("no mission progress in N hours", the issue's example, means missions).
  test("a named counter trips on its own flatline even when other counters advance", async () => {
    const ctrl = { stats: { missions_completed: 2, ore_mined: 0 } as Record<string, number> | undefined };
    const store = new Store(":memory:");
    const primary = countingPlanner();
    const fallback = countingPlanner();
    let now = 0;
    const agent = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary, fallbackPlanner: fallback,
      config: cfg({ revertIfNo: "missions_completed", withinHours: 2 }), now: () => now,
    });

    await agent.runOnce(); // seed
    for (let i = 1; i <= 4; i++) {
      ctrl.stats = { missions_completed: 2, ore_mined: i * 100 }; // busy mining, zero missions
      now += HOUR;
      await agent.runOnce();
    }
    expect(reverts(store).length).toBe(1); // tripped at the 2h mark despite the ore
  });

  // Breakage caught: treating UNMEASURABLE progress as flat. Missing stats
  // must refresh the clock (steward fail-safe semantics), never accumulate a
  // revert window across a gap where progress can't be ruled out.
  test("fail-safe: no stats block -> never trips, however long the gap", async () => {
    const ctrl = { stats: undefined as Record<string, number> | undefined };
    const store = new Store(":memory:");
    const primary = countingPlanner();
    const fallback = countingPlanner();
    let now = 0;
    const agent = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary, fallbackPlanner: fallback,
      config: cfg({ revertIfNo: "any", withinHours: 2 }), now: () => now,
    });

    for (let i = 0; i < 6; i++) { now += 2 * HOUR; await agent.runOnce(); }
    expect(reverts(store).length).toBe(0);
    expect(fallback.calls).toBe(0);
  });

  // Breakage caught: a harness restart silently granting the failed planner a
  // fresh trial (the latch must be durable via the events table), OR a config
  // CHANGE failing to re-arm (a new experiment must get its fresh trial).
  test("restart: same experiment config stays reverted; a changed config re-arms", async () => {
    const ctrl = { stats: { missions_completed: 0 } as Record<string, number> | undefined };
    const store = new Store(":memory:");
    let now = 0;

    const primary1 = countingPlanner();
    const fallback1 = countingPlanner();
    const agent1 = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary1, fallbackPlanner: fallback1,
      config: cfg({ revertIfNo: "missions_completed", withinHours: 2 }), now: () => now,
    });
    await agent1.runOnce();
    now += 2 * HOUR;
    await agent1.runOnce(); // trips and persists the event
    expect(reverts(store).length).toBe(1);

    // "Restart" with the SAME experiment: the constructor re-latches from the
    // persisted event -- the primary is never called again.
    const primary2 = countingPlanner();
    const fallback2 = countingPlanner();
    const agent2 = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary2, fallbackPlanner: fallback2,
      config: cfg({ revertIfNo: "missions_completed", withinHours: 2 }), now: () => now,
    });
    await agent2.runOnce();
    expect(primary2.calls).toBe(0);
    expect(fallback2.calls).toBe(1);

    // "Restart" with a CHANGED experiment (different window): a new trial --
    // the primary planner is live again.
    const primary3 = countingPlanner();
    const fallback3 = countingPlanner();
    const agent3 = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary3, fallbackPlanner: fallback3,
      config: cfg({ revertIfNo: "missions_completed", withinHours: 3 }), now: () => now,
    });
    await agent3.runOnce();
    expect(primary3.calls).toBe(1);
    expect(fallback3.calls).toBe(0);
  });

  // ---- revert_if_no: "any" against LIVE multi-counter data ----
  // The "any" path aggregates via progressCountersTotal (SSOT with the stall
  // watcher). The fail-safe test above never reaches that aggregation, so an
  // implementation bug in the sum-vs-flag semantics (e.g. watching a single
  // counter, or counting movement) would ship green without these.

  // Breakage caught: the #250 wandering blind spot -- movement counters
  // (jumps_completed, distance_traveled, systems_explored) rising every tick
  // must NOT read as progress. A forever-hopping pilot with every productive
  // counter flat is exactly the "no progress in ANY dimension" the exit
  // watches for, so the latch must FIRE.
  test('"any": all allowlisted counters flat while movement counters climb -> trips on schedule', async () => {
    const ctrl = {
      stats: {
        missions_completed: 2, ore_mined: 500, credits_earned: 1_000,
        jumps_completed: 0, distance_traveled: 0, systems_explored: 0, time_played: 0,
      } as Record<string, number> | undefined,
    };
    const store = new Store(":memory:");
    const primary = countingPlanner();
    const fallback = countingPlanner();
    let now = 0;
    const agent = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary, fallbackPlanner: fallback,
      config: cfg({ revertIfNo: "any", withinHours: 2 }), now: () => now,
    });

    await agent.runOnce(); // t=0: seeds the aggregate baseline
    expect(reverts(store).length).toBe(0);

    // The pilot wanders hard: movement counters climb every tick, every
    // productive counter stays flat.
    for (let i = 1; i <= 2; i++) {
      ctrl.stats = {
        missions_completed: 2, ore_mined: 500, credits_earned: 1_000,
        jumps_completed: i * 10, distance_traveled: i * 5_000,
        systems_explored: i * 3, time_played: i * 3_600,
      };
      now += HOUR;
      await agent.runOnce();
    }
    expect(reverts(store).length).toBe(1); // tripped at exactly the 2h mark
    expect((reverts(store)[0]!.payload as { counter: string }).counter).toBe("any");
    expect(fallback.calls).toBe(1);
    expect(primary.calls).toBe(2); // the seed tick + the mid-window tick; never after the trip
  });

  // Breakage caught: the aggregate degrading to a single-counter (or
  // wrong-counter) check. ONE allowlisted counter advancing -- while every
  // other counter, including the config example's missions, stays flat --
  // must re-seed the window and hold the latch open.
  test('"any": one allowlisted counter advancing holds the latch open (no revert)', async () => {
    const ctrl = {
      stats: { missions_completed: 0, ore_mined: 0, jumps_completed: 0 } as Record<string, number> | undefined,
    };
    const store = new Store(":memory:");
    const primary = countingPlanner();
    const fallback = countingPlanner();
    let now = 0;
    const agent = new Agent({
      id: "a1", persona: "p", api: api(ctrl), store, planner: primary, fallbackPlanner: fallback,
      config: cfg({ revertIfNo: "any", withinHours: 2 }), now: () => now,
    });

    await agent.runOnce(); // seed
    // Mining advances every 1.5h -- inside the 2h window each time -- while
    // missions stay at zero. 4 windows' worth of elapsed time, zero reverts.
    for (let i = 1; i <= 5; i++) {
      ctrl.stats = { missions_completed: 0, ore_mined: i * 100, jumps_completed: 0 };
      now += 1.5 * HOUR;
      await agent.runOnce();
    }
    expect(reverts(store).length).toBe(0);
    expect(fallback.calls).toBe(0);

    // And once mining ALSO stops, the window runs dry and it trips -- the
    // hold-open above was the advance, not a dead code path.
    now += 2 * HOUR;
    await agent.runOnce();
    expect(reverts(store).length).toBe(1);
  });
});

// Direct coverage for the aggregation primitive itself (SSOT: the stall
// watcher, the progress heartbeat, and the "any" experiment exit all lean on
// its invariant -- "the sum rises iff at least one allowlisted dimension
// advanced, and is unchanged iff EVERY allowlisted dimension is flat").
describe("progressCountersTotal", () => {
  const base: Record<string, number> = {
    credits_earned: 1_000, ore_mined: 250, missions_completed: 4,
    jumps_completed: 50, distance_traveled: 90_000, systems_explored: 12, time_played: 86_400,
  };

  // Breakage caught: an allowlisted counter's advance not moving the sum
  // (e.g. a key dropped from the allowlist, or a non-numeric guard eating it).
  test("advancing exactly one allowlisted counter raises the sum by that delta", () => {
    const before = progressCountersTotal(base);
    const after = progressCountersTotal({ ...base, ore_mined: 251 });
    expect(before).not.toBeNull();
    expect(after).toBe(before! + 1);
  });

  // Breakage caught: the #250 wandering blind spot re-opening -- a movement
  // or clock counter slipping into the sum would let a forever-hopping pilot
  // read as progressing (and would silence the "any" experiment exit).
  // Pinned per excluded counter so the failure names the leak.
  test("movement/clock counters advancing leave the sum exactly flat", () => {
    const before = progressCountersTotal(base);
    for (const mv of EXCLUDED_MOVEMENT_COUNTERS) {
      const after = progressCountersTotal({ ...base, [mv]: (base[mv] ?? 0) + 1_000 });
      expect(after).toBe(before!);
    }
  });

  // Breakage caught: the null fail-safe contract eroding -- absent stats must
  // be UNKNOWN (null), while an absent individual key is just a flat 0.
  test("missing stats block -> null; missing individual keys count as 0", () => {
    expect(progressCountersTotal(undefined)).toBeNull();
    expect(progressCountersTotal({ ore_mined: 7, jumps_completed: 99 })).toBe(7);
  });
});
