import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { Store } from "../src/store/store";
import { PROGRESS_COUNTERS } from "../src/agent/no-progress-detector";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Planner } from "../src/planner/types";

// Progress heartbeat: a deterministic, dashboard-visible pulse that REPORTS the
// per-window progress delta (it never acts -- that's the steward's job). These
// tests drive a fake clock across heartbeat windows and assert the emitted
// progress_heartbeat events.
//
// Since #96 the progressing/stalled verdict is the stall-watcher's own scalar
// (progressGrandTotal: PROGRESS_COUNTERS + skill LEVELS + achievements earned),
// so the two load-bearing ablations are:
//   1. MOVEMENT counters (jumps/distance/systems/time_played) do NOT count as
//      progress -- a pilot that only ever moves reads `stalled`.
//   2. Ambient sub-level skill XP does NOT count (#250) -- an XP drip with no
//      level-up reads `stalled` -- while a skill LEVEL-UP or a new achievement
//      alone reads `progressing` (the #96 alignment: previously counters-only,
//      a skills-only window falsely read stalled while the steward stood down).
//
// Offline: fake api + a planner that is never allowed to matter (the heartbeat
// runs BEFORE the wake/steward/planner gates), zero live traffic.

const HB_MIN = 30;
const HB_MS = HB_MIN * 60_000;

// Steward window set unreachably large so the stall-watcher never fires and can't
// contaminate the progress_heartbeat event stream under test.
const cfg: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  maxPlansPerWindow: 1_000_000, planBudgetWindowMinutes: 60,
  fuelReservePct: 25, stuckWindowMinutes: 10_000_000, strandAutoSelfDestruct: false,
  progressHeartbeatMinutes: HB_MIN,
};

// Full lifetime stats: every PROGRESS counter (seeded) plus the excluded movement
// counters and the ever-rising clock. `over` bumps individual counters per tick.
function stats(over: Record<string, number> = {}): Record<string, number> {
  return {
    credits_earned: 100, ore_mined: 10, missions_completed: 0, trades_completed: 5,
    exchange_items_sold: 0, items_crafted: 0, facilities_built: 0, facility_items_produced: 0,
    wrecks_sold: 0, wrecks_scrapped: 0, wreck_items_looted: 0,
    npcs_destroyed: 0, pirates_destroyed: 0, ships_destroyed: 0, bases_destroyed: 0,
    scans_performed: 0, deep_core_pois_discovered: 0, contraband_sold: 0,
    jumps_completed: 0, distance_traveled: 0, systems_explored: 0, time_played: 0,
    ...over,
  };
}

// A docked, healthy pilot (no reflex/wake side effects to worry about) whose
// stats/credits/system -- and, for the slow dimensions, skills/achievements --
// are driven by the controller so each test scripts exactly what changed
// between windows.
function api(ctrl: {
  stats: Record<string, number>;
  credits: number;
  cargoUsed: number;
  systemId: string;
  skills?: Record<string, { level: number; xp: number }>;
  achievements?: number;
}): GameApi {
  return {
    async action() { return { result: "ok" }; },
    async status(): Promise<StatusSnapshot> {
      return {
        credits: ctrl.credits, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
        cargoUsed: ctrl.cargoUsed, cargoCapacity: 100, docked: true, inTransit: false,
        systemId: ctrl.systemId, stats: ctrl.stats,
      };
    },
    async notifications() { return []; },
    async getSkills() { return ctrl.skills ?? { mining: { level: 1, xp: 0 } }; },
    async getAchievements() { return ctrl.achievements ?? 0; },
  };
}

const throwingPlanner = (): Planner => ({ async plan() { throw new Error("no live planner offline"); } });

const heartbeats = (store: Store) =>
  store.recentEvents("a1", 100_000).filter((e) => e.type === "progress_heartbeat");

type HbPayload = {
  windowMinutes: number;
  progressing: boolean;
  stalled: boolean;
  deltas: Record<string, number>;
  position: { credits: number; cargoUsed: number; systemId: string | null };
};

// The slow dimensions are sampled on the snapshot cadence AFTER the heartbeat
// runs in a tick, so the first runOnce fills the cache and the second seeds the
// heartbeat baseline (in production these are consecutive ~seconds ticks).
async function seed(agent: Agent, store: Store): Promise<void> {
  await agent.runOnce(); // fills the skills/achievements cache
  await agent.runOnce(); // seeds the heartbeat baseline; emits nothing
  expect(heartbeats(store).length).toBe(0);
}

describe("progress heartbeat", () => {
  test("PROGRESSING: a progress counter advancing over the window -> progressing:true with the right delta", async () => {
    const ctrl = { stats: stats(), credits: 500, cargoUsed: 0, systemId: "sys_a" };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: api(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await seed(agent, store); // t=0: cache + baseline, emits nothing

    // Advance a full window; ore + credits_earned rose (real productive outcomes).
    ctrl.stats = stats({ ore_mined: 17, credits_earned: 150 });
    ctrl.credits = 550; ctrl.cargoUsed = 7;
    now += HB_MS;
    await agent.runOnce();

    const hb = heartbeats(store);
    expect(hb.length).toBe(1);
    const p = hb[0]!.payload as HbPayload;
    expect(p.progressing).toBe(true);
    expect(p.stalled).toBe(false);
    expect(p.windowMinutes).toBe(HB_MIN);
    // Only the two counters that moved appear, with exact deltas since baseline.
    expect(p.deltas).toEqual({ ore_mined: 7, credits_earned: 50 });
    expect(p.position).toEqual({ credits: 550, cargoUsed: 7, systemId: "sys_a" });
  });

  test("STALLED (movement-only ablation): only excluded movement counters move -> stalled:true, empty deltas", async () => {
    const ctrl = { stats: stats(), credits: 500, cargoUsed: 0, systemId: "sys_a" };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: api(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await seed(agent, store);

    // A busy WANDERER: jumps/distance/systems/time all climb, every PROGRESS
    // counter flat. This is the blind spot the allowlist closes -- movement is
    // motion, not progress.
    ctrl.stats = stats({ jumps_completed: 12, distance_traveled: 9000, systems_explored: 4, time_played: HB_MS });
    ctrl.systemId = "sys_z"; // moved systems, but that isn't progress either
    now += HB_MS;
    await agent.runOnce();

    const hb = heartbeats(store);
    expect(hb.length).toBe(1);
    const p = hb[0]!.payload as HbPayload;
    expect(p.stalled).toBe(true);
    expect(p.progressing).toBe(false);
    expect(p.deltas).toEqual({}); // no progress dimension moved
  });

  test("SKILLS-ONLY window (#96): a level-up with every counter flat -> progressing:true, skill_levels delta", async () => {
    // The alignment this file exists to guard: before #96 the heartbeat was
    // counters-only, so this exact window read `stalled` on the dashboard while
    // the stall-watcher (correctly) stood down -- the two disagreed.
    const ctrl = { stats: stats(), credits: 500, cargoUsed: 0, systemId: "sys_a", skills: { mining: { level: 1, xp: 0 } } };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: api(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await seed(agent, store);

    // The pilot grinds mining to level 2. Counters, credits, position: all flat.
    ctrl.skills = { mining: { level: 2, xp: 5 } };
    now += 61_000;         // past the snapshot throttle: the cache re-samples...
    await agent.runOnce(); // ...but the window hasn't elapsed, so no emit yet
    now += HB_MS;
    await agent.runOnce();

    const hb = heartbeats(store);
    expect(hb.length).toBe(1);
    const p = hb[0]!.payload as HbPayload;
    expect(p.progressing).toBe(true);
    expect(p.stalled).toBe(false);
    expect(p.deltas).toEqual({ skill_levels: 1 });
  });

  test("ACHIEVEMENTS-ONLY window (#96): a new achievement with everything else flat -> progressing:true", async () => {
    const ctrl = { stats: stats(), credits: 500, cargoUsed: 0, systemId: "sys_a", achievements: 3 };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: api(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await seed(agent, store);

    ctrl.achievements = 4;
    now += 61_000;         // past the snapshot throttle: re-sample
    await agent.runOnce();
    now += HB_MS;
    await agent.runOnce();

    const hb = heartbeats(store);
    expect(hb.length).toBe(1);
    const p = hb[0]!.payload as HbPayload;
    expect(p.progressing).toBe(true);
    expect(p.deltas).toEqual({ achievements_earned: 1 });
  });

  test("AMBIENT-XP guard (#250): sub-level XP drip with no level-up -> still stalled:true", async () => {
    // The regression #96 must not resurrect: skill XP accrues passively (some
    // skills with no action at all), so an XP trickle masked real stalls until
    // #250 made the skills dimension LEVEL-only. The heartbeat inherits that
    // exclusion through progressGrandTotal; this pins it at the heartbeat too.
    const ctrl = { stats: stats(), credits: 500, cargoUsed: 0, systemId: "sys_a", skills: { mining: { level: 1, xp: 0 } } };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: api(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await seed(agent, store);

    // XP climbs all window; the level threshold is never crossed.
    ctrl.skills = { mining: { level: 1, xp: 500 } };
    now += 61_000;
    await agent.runOnce();
    now += HB_MS;
    await agent.runOnce();

    const hb = heartbeats(store);
    expect(hb.length).toBe(1);
    const p = hb[0]!.payload as HbPayload;
    expect(p.stalled).toBe(true);
    expect(p.progressing).toBe(false);
    expect(p.deltas).toEqual({});
  });

  test("no heartbeat before the window elapses", async () => {
    const ctrl = { stats: stats(), credits: 500, cargoUsed: 0, systemId: "sys_a" };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: api(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await seed(agent, store); // seed at t=0
    // Real progress, but only a fraction of the window has passed.
    ctrl.stats = stats({ credits_earned: 999 });
    now += HB_MS - 1;
    await agent.runOnce();
    expect(heartbeats(store).length).toBe(0);
  });

  test("baseline advances each window: delta is per-window, not cumulative", async () => {
    const ctrl = { stats: stats(), credits: 500, cargoUsed: 0, systemId: "sys_a" };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: api(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await seed(agent, store); // seed credits_earned=100

    // Window 1: +50 -> progressing.
    ctrl.stats = stats({ credits_earned: 150 });
    now += HB_MS;
    await agent.runOnce();

    // Window 2: credits_earned holds at 150 (flat) -> stalled, and the delta is
    // measured from window 1's re-seeded baseline (0), NOT from the original 100.
    now += HB_MS;
    await agent.runOnce();

    const hb = heartbeats(store).map((e) => e.payload as HbPayload);
    expect(hb.length).toBe(2);
    expect(hb[0]!.progressing).toBe(true);
    expect(hb[0]!.deltas).toEqual({ credits_earned: 50 });
    expect(hb[1]!.stalled).toBe(true);
    expect(hb[1]!.deltas).toEqual({});
  });

  test("FAIL-SAFE: no stats block -> no heartbeat (never a phantom pulse from unmeasurable progress)", async () => {
    // Stats absent means progress is UNMEASURABLE this cycle. The heartbeat must
    // skip rather than emit a `stalled` (or any) pulse the operator would read as
    // real. Guards the progressGrandTotal-null fail-safe against regression.
    const ctrl: { stats: Record<string, number> | undefined } = { stats: undefined };
    const noStatsApi: GameApi = {
      async action() { return { result: "ok" }; },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 500, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 100, docked: true, inTransit: false,
          systemId: "sys_a", stats: ctrl.stats,
        };
      },
      async notifications() { return []; },
      async getSkills() { return { mining: { level: 1, xp: 0 } }; },
      async getAchievements() { return 0; },
    };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: noStatsApi, store, planner: throwingPlanner(), config: cfg, now: () => now });

    // Several full windows with no stats at all -> zero heartbeats.
    for (let i = 0; i < 5; i++) { now += HB_MS; await agent.runOnce(); }
    expect(heartbeats(store).length).toBe(0);
  });

  test("FAIL-SAFE (#96): skills dimension UNKNOWN (query fails) -> no heartbeat, same suppress rule as the steward", async () => {
    // With stats PRESENT but a slow dimension unknown, the grand total is null
    // and the steward suppresses; the aligned heartbeat must suppress too rather
    // than emit a verdict from a partial signal.
    const brokenSkillsApi: GameApi = {
      async action() { return { result: "ok" }; },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 500, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 100, docked: true, inTransit: false,
          systemId: "sys_a", stats: stats(),
        };
      },
      async notifications() { return []; },
      async getSkills(): Promise<Record<string, { level: number; xp: number }>> { throw new Error("skills query down"); },
      async getAchievements() { return 0; },
    };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: brokenSkillsApi, store, planner: throwingPlanner(), config: cfg, now: () => now });

    for (let i = 0; i < 5; i++) { now += HB_MS; await agent.runOnce(); }
    expect(heartbeats(store).length).toBe(0);
  });

  test("heartbeat and stuck-watcher share the same progress definition (SSOT)", () => {
    // The heartbeat imports PROGRESS_COUNTERS rather than redefining it, so the
    // movement exclusions can never drift apart. This guards that import: if a
    // movement counter were ever added to the allowlist, the STALLED ablation
    // above would start reading movement as progress.
    for (const mv of ["jumps_completed", "distance_traveled", "systems_explored", "time_played"]) {
      expect(PROGRESS_COUNTERS as readonly string[]).not.toContain(mv);
    }
  });
});
