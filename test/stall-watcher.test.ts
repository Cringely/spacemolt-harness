import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { getAction } from "../src/registry/actions";
import { evaluateWake } from "../src/agent/wake";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";
import type { Planner, PlanContext } from "../src/planner/types";

// stall-watcher v4 (docs/superpowers/specs/2026-07-12-pilot-stall-watcher.md).
// Four parts, each with its load-bearing ablation:
//   1. strand guard (fuel-reserve floor + behavioral strand detector)
//   2. multi-dimensional no-progress detector (movement is NOT progress)
//   3. bounded steward (one re-steer per window; config-gated self_destruct)
//   4. recovery actions in the registry (distress_signal/self_destruct/tow)
// Offline throughout: fake api + mock/throwing planner, zero live traffic.

// Small windows keep tick counts sane; the ceiling is set unreachably high so
// Layer 3 never pre-empts the parts under test.
const cfg: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  maxPlansPerWindow: 1_000_000, planBudgetWindowMinutes: 60,
  fuelReservePct: 25, stuckWindowMinutes: 1, strandAutoSelfDestruct: false,
};
const WINDOW_MS = 60_000; // stuckWindowMinutes: 1

// A planner that throws a PLAIN error -> planner_error (no backoff), so the plan
// state stays "none" and a no_plan wake fires EVERY tick. That gives the steward
// a clean once-per-tick evaluation cadence without a backoff gate suppressing it.
function throwingPlanner(): Planner {
  return { async plan() { throw new Error("no live planner in this offline test"); } };
}

// Base lifetime stats. The four named PROGRESS counters plus the three EXCLUDED
// movement counters and the ever-rising clock (time_played).
function stats(over: Record<string, number> = {}): Record<string, number> {
  return {
    credits_earned: 100, ore_mined: 10, missions_completed: 0, trades_completed: 5,
    jumps_completed: 0, distance_traveled: 0, systems_explored: 0, time_played: 0,
    ...over,
  };
}

const flatSkills = () => ({ mining: { level: 2, xp: 21 }, piloting: { level: 3, xp: 427 } });

// A healthy, undocked pilot whose SYSTEM changes every tick (wandering). The
// changing systemId keeps Layer 4's fingerprint moving so it never arms -- which
// is the whole point: the long-window steward, not Layer 4, is the only thing
// that can catch a forever-moving-but-not-progressing pilot.
function wanderApi(ctrl: {
  tick: number;
  stats: (tick: number) => Record<string, number>;
  skills?: (tick: number) => Record<string, { level: number; xp: number }>; // omit / throw => UNKNOWN
  achievements?: (tick: number) => number;
  skillsThrows?: boolean;
}): GameApi {
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status(): Promise<StatusSnapshot> {
      return {
        credits: 500, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
        cargoUsed: 0, cargoCapacity: 100, docked: false, inTransit: false,
        systemId: `sys_${ctrl.tick}`, // moves every tick -> Layer 4 stays dormant
        stats: ctrl.stats(ctrl.tick),
      };
    },
    async notifications() { return []; },
    async getSkills() {
      if (ctrl.skillsThrows) throw new SpacemoltError("command_error", "skills query boom");
      return (ctrl.skills ?? flatSkills)(ctrl.tick);
    },
    async getAchievements() { return (ctrl.achievements ?? (() => 3))(ctrl.tick); },
  };
}

const resteers = (store: Store) =>
  store.recentEvents("a1", 100_000).filter((e) => e.type === "steward_resteer");
const alerts = (store: Store, cls: string) =>
  store.recentEvents("a1", 100_000).filter(
    (e) => e.type === "operator_alert" && (e.payload as { class?: string }).class === cls);

describe("multi-dimensional no-progress detector", () => {
  test("WANDER-FOREVER: movement counters rise every tick, progress flat -> FIRES stuck_no_progress (the blind-spot regression)", async () => {
    const ctrl = { tick: 0, stats: (t: number) => stats({ jumps_completed: t, distance_traveled: t * 500, systems_explored: t }) };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: wanderApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    for (let i = 0; i < 20; i++) { ctrl.tick = i + 1; now += 6_000; await agent.runOnce(); } // 120s of pure wandering

    const fired = resteers(store);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect((fired[0]!.payload as { class: string }).class).toBe("stuck_no_progress");
    // Layer 4 did NOT catch this -- the fingerprint moved every tick. This is
    // the exact case Layer 4 misses and the steward exists for.
    expect(agent.snapshot().plannerHealth.stuck).toBe(false);
    expect(alerts(store, "no_progress").length).toBe(0);
  });

  // One ablation per PROGRESS dimension: any single one advancing clears the
  // stall and the steward must stay silent, even across several windows.
  const ablations: Array<[
    string,
    (t: number) => Record<string, number>,
    undefined | ((t: number) => Record<string, { level: number; xp: number }>),
    undefined | ((t: number) => number),
  ]> = [
    ["credits_earned", (t) => stats({ credits_earned: 100 + t }), undefined, undefined],
    ["ore_mined", (t) => stats({ ore_mined: 10 + t }), undefined, undefined],
    ["missions_completed", (t) => stats({ missions_completed: t }), undefined, undefined],
    ["trades_completed", (t) => stats({ trades_completed: 5 + t }), undefined, undefined],
    // A skill LEVEL gain is a productive outcome and still counts as progress.
    // (Sub-level XP drip does NOT -- see the #250 replay below.)
    ["skill level", (_t) => stats(), (t) => ({ mining: { level: 2 + t, xp: 21 }, piloting: { level: 3, xp: 427 } }), undefined],
    ["achievements.earned", (_t) => stats(), undefined, (t) => 3 + t],
  ];
  for (const [label, statsFn, skillsFn, achFn] of ablations) {
    test(`does NOT fire when ${label} advances every tick`, async () => {
      const ctrl = { tick: 0, stats: statsFn, skills: skillsFn, achievements: achFn };
      const store = new Store(":memory:");
      let now = 0;
      const agent = new Agent({ id: "a1", persona: "p", api: wanderApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });
      for (let i = 0; i < 40; i++) { ctrl.tick = i + 1; now += 6_000; await agent.runOnce(); } // 240s = 4 windows
      expect(resteers(store).length).toBe(0);
      expect(alerts(store, "stuck_no_progress").length).toBe(0);
    });
  }

  test("FAIL-SAFE: a needed query (get_skills) failing makes that dimension UNKNOWN -> suppress (never fires)", async () => {
    const ctrl = { tick: 0, stats: (_t: number) => stats(), skillsThrows: true }; // counters/achievements flat, skills UNKNOWN
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: wanderApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });
    for (let i = 0; i < 40; i++) { ctrl.tick = i + 1; now += 6_000; await agent.runOnce(); }
    // Everything else is flat and the window elapsed many times over, yet an
    // UNKNOWN dimension suppresses the flag entirely (fail toward not-flagging).
    expect(resteers(store).length).toBe(0);
    expect(store.recentEvents("a1", 100_000).some(
      (e) => e.type === "progress_sample_error" && (e.payload as { dim?: string }).dim === "skills")).toBe(true);
  });

  test("BURN-BOUND: persistent no-progress across many ticks yields at most ONE steward_resteer per window", async () => {
    const ctrl = { tick: 0, stats: (_t: number) => stats() }; // fully flat progress
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: wanderApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    // 60 ticks x 6s = 360s = 6 windows of continuous stall.
    for (let i = 0; i < 60; i++) { ctrl.tick = i + 1; now += 6_000; await agent.runOnce(); }

    const wakes = store.recentEvents("a1", 100_000).filter((e) => e.type === "wake").length;
    const fired = resteers(store).length;
    // The instruction-class re-steer bypasses the ceiling and thrash damper, so
    // the timestamp latch is the ONLY bound. It holds re-steers to roughly one
    // per 60s window (~6 over 360s), NOT one per wake (~60) -- the burn.
    expect(fired).toBeGreaterThanOrEqual(4);
    expect(fired).toBeLessThanOrEqual(7);
    expect(fired).toBeLessThan(wakes / 4);
  });

  test("steward injects a TRANSIENT instruction, never a persisted goal", async () => {
    const ctrl = { tick: 0, stats: (_t: number) => stats() };
    const api = wanderApi(ctrl);
    const store = new Store(":memory:");
    // A planner that RECORDS its context then throws (plain Error -> planner_error,
    // no backoff): lets us read the instruction the re-steer passed, without a
    // successful plan_done loop tripping the thrash damper.
    const contexts: PlanContext[] = [];
    const planner: Planner = { async plan(ctx) { contexts.push(ctx); throw new Error("offline"); } };
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: cfg, now: () => now });

    for (let i = 0; i < 20; i++) { ctrl.tick = i + 1; now += 6_000; await agent.runOnce(); }

    expect(resteers(store).length).toBeGreaterThanOrEqual(1);
    // The re-steer reached the planner as ctx.instruction ...
    const steered = contexts.filter((c) => c.instruction?.includes("No measurable progress"));
    expect(steered.length).toBeGreaterThanOrEqual(1);
    // ... but was NEVER persisted as a standing goal.
    expect(agent.snapshot().goals.some((g) => g.includes("No measurable progress"))).toBe(false);
    expect(agent.snapshot().goals).toEqual([]);
  });

  // --- #250 incident replay: docked, idle, empty cargo, ambient skill-XP drip ---
  // On 2026-07-14 the pilot sat DOCKED at Market Prime Exchange, cargo 0/100,
  // holding an active Titanium Extraction mining mission, and made no sale for
  // ~a day. The multi-dimensional detector never escalated. Root cause: the
  // grand-total progress scalar folded in per-skill XP, and skill XP drips
  // PASSIVELY (docs/game-reference/upstream/docs/skills.md:100 -- Corporation
  // Management XP "accrues passively over time per facility owned"; every skill
  // "trains passively by doing the thing it governs"). A steady sub-level XP
  // trickle in any one of 28 skills made the grand total rise every window,
  // re-seeding the baseline, so "no progress in any real dimension" could never
  // latch. The fix credits skill LEVEL (a productive outcome) but NOT ambient
  // sub-level XP.
  //
  // Faithful replay: DOCKED and stationary, all PROGRESS counters + achievements
  // flat, one skill's XP creeping up each sample, level flat. Fuel jitters by 1
  // each tick -- the pilot idles/tops up -- which keeps Layer 4's game-state
  // fingerprint moving so the SHORT-window freeze detector stays dormant (it did
  // in the incident: the pilot was busy-but-unproductive, not frozen),
  // isolating the LONG-window steward that actually owns this failure.
  test("#250 ambient skill-XP drip does NOT count as progress -> the steward FIRES stuck_no_progress", async () => {
    const ctrl = { tick: 0 };
    const dockedIdleApi: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 2720, fuel: 60 + (ctrl.tick % 2), maxFuel: 130, hull: 95, maxHull: 95,
          cargoUsed: 0, cargoCapacity: 100, docked: true, inTransit: false,
          dockedAt: "market_prime", systemId: "market_prime",
          stats: stats(), // every PROGRESS counter flat -- no sale, no mine, no mission
        };
      },
      async notifications() { return []; },
      // Ambient XP drip: mining XP creeps up each sample, NO level gain.
      async getSkills() { return { mining: { level: 2, xp: 21 + ctrl.tick * 2 }, piloting: { level: 3, xp: 427 } }; },
      async getAchievements() { return 3; }, // flat
    };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: dockedIdleApi, store, planner: throwingPlanner(), config: cfg, now: () => now });

    // 40 ticks x 6s = 240s = 4 windows of docked idling while XP trickles.
    for (let i = 0; i < 40; i++) { ctrl.tick = i + 1; now += 6_000; await agent.runOnce(); }

    // Ablation: on the pre-fix build (grand total folds in per-skill XP) the XP
    // trickle re-seeds every window and NEITHER of these ever fires.
    expect(resteers(store).length).toBeGreaterThanOrEqual(1);
    expect(alerts(store, "stuck_no_progress").length).toBeGreaterThanOrEqual(1);
    // Layer 4 stayed dormant (the fuel jitter kept its fingerprint moving),
    // proving this is the long-window steward's catch, not the freeze detector's.
    expect(agent.snapshot().plannerHealth.stuck).toBe(false);
    expect(alerts(store, "no_progress").length).toBe(0);
  });

  test("LAYER-4-ARMED: the steward stands down while Layer 4 owns a state-frozen episode", async () => {
    // Frozen low-fuel livelock (Layer 4's home turf): fingerprint identical every
    // replan, so Layer 4 arms. Skills/achievements flat so the steward's
    // no-progress condition is ALSO met -- proving it's the stand-down guard,
    // not a missing signal, that keeps the steward silent.
    const status: StatusSnapshot = {
      credits: 100, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId: "s1",
      stats: stats(),
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
      async getSkills() { return flatSkills(); },
      async getAchievements() { return 3; },
    };
    const store = new Store(":memory:");
    store.savePlan("a1", { goal: "mine", steps: [{ action: "mine", params: {}, until: "cargo_full" }] }, []);
    const planner = new MockPlanner([{ goal: "mine", steps: [{ action: "mine", params: {}, until: "cargo_full" }] }]);
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: { ...cfg, fuelPct: 20 }, now: () => now });

    // Phase 1 -- small ticks: the frozen low-fuel livelock replans every tick, so
    // Layer 4 (6 replan boundaries, ~6s) arms LONG before the steward's 60s
    // window could elapse. Layer 4 gets the freeze first, by design.
    for (let i = 0; i < 8; i++) { now += 1_000; await agent.runOnce(); }
    expect(agent.snapshot().plannerHealth.stuck).toBe(true);

    // Phase 2 -- ticks longer than the heartbeat, so any Layer-4 backoff has
    // expired and runSteward IS reached each tick, and the steward's own window
    // has elapsed many times over. The ONLY thing keeping the steward silent now
    // is the this.stuck stand-down guard.
    for (let i = 0; i < 10; i++) { now += 16 * 60_000; await agent.runOnce(); }

    expect(agent.snapshot().plannerHealth.stuck).toBe(true);
    expect(alerts(store, "no_progress").length).toBeGreaterThanOrEqual(1); // Layer 4 owns it
    expect(resteers(store).length).toBe(0); // steward stood down throughout
  });
});

describe("strand guard", () => {
  // A stranded pilot: undocked, out of fuel, and every travel_to jump fails for
  // lack of fuel. The plan carries a refuel step so the low_fuel wake is
  // suppressed (planRemediesFuel) and the plan actually EXECUTES the doomed
  // jump -- which is how the "insufficient fuel" block reaches the executor,
  // exactly the live-incident shape.
  function strandApi(jumpBehavior: (attempt: number) => "fuel-block" | "ok"): { api: GameApi; jumps: () => number } {
    let attempts = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "find_route") {
          return { structuredContent: { found: true, route: [{ system_id: "moonshadow", jumps: 0 }, { system_id: "fafnir", jumps: 1 }] } };
        }
        if (name === "jump") {
          attempts++;
          if (jumpBehavior(attempts) === "fuel-block") {
            throw new SpacemoltError("command_error", "Not enough fuel to jump to fafnir");
          }
          return { result: "ok" };
        }
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 2720, fuel: 0, maxFuel: 130, hull: 95, maxHull: 95,
          cargoUsed: 24, cargoCapacity: 100, docked: false, inTransit: false, systemId: "moonshadow",
        };
      },
      async notifications() { return []; },
    };
    return { api, jumps: () => attempts };
  }

  const strandPlan: Plan = { goal: "reach fuel", steps: [{ action: "travel_to", params: { system_id: "fafnir" } }, { action: "refuel", params: {} }] };

  test("undocked + out of fuel + repeated fuel-blocked jumps -> operator_alert{stranded} + steward re-steer to distress", async () => {
    const { api } = strandApi(() => "fuel-block");
    const store = new Store(":memory:");
    store.savePlan("a1", strandPlan, []);
    const planner = new MockPlanner([strandPlan]);
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: cfg, now: () => now });

    for (let i = 0; i < 12; i++) { now += 2_000; await agent.runOnce(); }

    expect(alerts(store, "stranded").length).toBeGreaterThanOrEqual(1);
    const fired = resteers(store).filter((e) => (e.payload as { class: string }).class === "stranded");
    expect(fired.length).toBeGreaterThanOrEqual(1);
    // The re-steer cues the pilot to reach fuel (distress itself is sent
    // deterministically -- covered by the next test).
    expect((fired[0]!.payload as { instruction: string }).instruction.toLowerCase()).toContain("refuel");
  });

  test("the steward sends distress_signal DETERMINISTICALLY on a confirmed strand, independent of the planner's plan", async () => {
    // The primary rescue action must not depend on planner compliance: with fuel
    // ~0 the low_fuel wake preempts execution unless the returned plan carries a
    // downstream refuel step, so a re-steer that merely INSTRUCTS distress could
    // be starved and the SOS never sent. The steward fires it itself. Here the
    // planner returns strandPlan -- which has NO distress_signal step anywhere --
    // yet distress_signal must still go out via api.action.
    const calls: string[] = [];
    const { api } = strandApi(() => "fuel-block");
    const wrapped: GameApi = { ...api, async action(name, p) { calls.push(name); return api.action(name, p); } };
    expect(strandPlan.steps.some((s) => s.action === "distress_signal")).toBe(false); // no plan step sends it
    const store = new Store(":memory:");
    store.savePlan("a1", strandPlan, []);
    const planner = new MockPlanner([strandPlan]);
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: wrapped, store, planner, config: cfg, now: () => now });

    for (let i = 0; i < 16; i++) { now += 2_000; await agent.runOnce(); }

    expect(alerts(store, "stranded").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c === "distress_signal").length).toBeGreaterThanOrEqual(1); // deterministic mayday
    const distressEvents = store.recentEvents("a1", 100_000).filter((e) => e.type === "steward_distress");
    expect(distressEvents.length).toBeGreaterThanOrEqual(1);
    expect((distressEvents[0]!.payload as { distress_type: string }).distress_type).toBe("fuel");
  });

  test("BURN-BOUND: distress_signal is sent at most once per window, not per tick", async () => {
    // Distress is a game mutation; the once-per-window rung-1 latch must hold it
    // to ~one per strand window across a long, continuously-stranded run.
    const calls: string[] = [];
    const { api } = strandApi(() => "fuel-block");
    const wrapped: GameApi = { ...api, async action(name, p) { calls.push(name); return api.action(name, p); } };
    const store = new Store(":memory:");
    store.savePlan("a1", strandPlan, []);
    const planner = new MockPlanner([strandPlan]);
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: wrapped, store, planner, config: cfg, now: () => now });

    // ~6 windows of continuous strand at a dense tick.
    for (let i = 0; i < 120; i++) { now += 3_000; await agent.runOnce(); }

    const distress = calls.filter((c) => c === "distress_signal").length;
    expect(distress).toBeGreaterThanOrEqual(4);
    expect(distress).toBeLessThanOrEqual(8); // ~one per 60s window over 360s, NOT one per tick
  });

  test("TRANSIENT: fuel-blocked twice then a jump succeeds -> the counter resets, no strand fires", async () => {
    // Third jump onward succeeds -> the movement advances -> fuelBlockedMoves
    // never reaches the threshold, so this is a transient hiccup, not a strand.
    const { api } = strandApi((attempt) => (attempt <= 2 ? "fuel-block" : "ok"));
    const store = new Store(":memory:");
    store.savePlan("a1", strandPlan, []);
    const planner = new MockPlanner([strandPlan]);
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: cfg, now: () => now });

    for (let i = 0; i < 12; i++) { now += 2_000; await agent.runOnce(); }

    expect(alerts(store, "stranded").length).toBe(0);
    expect(resteers(store).filter((e) => (e.payload as { class: string }).class === "stranded").length).toBe(0);
  });

  test("self_destruct stays OFF by default even after a long strand (destructive, opt-in only)", async () => {
    const calls: string[] = [];
    const { api } = strandApi(() => "fuel-block");
    const wrapped: GameApi = { ...api, async action(name, p) { calls.push(name); return api.action(name, p); } };
    const store = new Store(":memory:");
    store.savePlan("a1", strandPlan, []);
    const planner = new MockPlanner([strandPlan]);
    let now = 0;
    // strandAutoSelfDestruct defaults false in cfg.
    const agent = new Agent({ id: "a1", persona: "p", api: wrapped, store, planner, config: cfg, now: () => now });

    // Drive well past 2 windows of confirmed strand.
    for (let i = 0; i < 80; i++) { now += 5_000; await agent.runOnce(); }

    expect(alerts(store, "stranded").length).toBeGreaterThanOrEqual(1); // it IS alerting
    expect(calls.includes("self_destruct")).toBe(false);                // but never auto-destroys
    expect(store.recentEvents("a1", 100_000).some((e) => e.type === "steward_self_destruct")).toBe(false);
  });

  test("self_destruct fires once, after a longer window, when the operator opts in", async () => {
    const calls: string[] = [];
    const { api } = strandApi(() => "fuel-block");
    const wrapped: GameApi = { ...api, async action(name, p) { calls.push(name); return api.action(name, p); } };
    const store = new Store(":memory:");
    store.savePlan("a1", strandPlan, []);
    const planner = new MockPlanner([strandPlan]);
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: wrapped, store, planner, config: { ...cfg, strandAutoSelfDestruct: true }, now: () => now });

    for (let i = 0; i < 80; i++) { now += 5_000; await agent.runOnce(); }

    expect(calls.filter((c) => c === "self_destruct").length).toBe(1); // once, latched
    expect(store.recentEvents("a1", 100_000).filter((e) => e.type === "steward_self_destruct").length).toBe(1);
  });

  test("docked low-fuel does NOT trip the strand (the docked reflex refuels there)", async () => {
    const store = new Store(":memory:");
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "find_route") return { structuredContent: { found: true, route: [{ system_id: "s0", jumps: 0 }, { system_id: "s1", jumps: 1 }] } };
        if (name === "jump") throw new SpacemoltError("command_error", "Not enough fuel to jump");
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        return { credits: 100, fuel: 0, maxFuel: 100, hull: 100, maxHull: 100, cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, systemId: "s0" };
      },
      async notifications() { return []; },
    };
    store.savePlan("a1", strandPlan, []);
    const planner = new MockPlanner([strandPlan]);
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: cfg, now: () => now });
    for (let i = 0; i < 12; i++) { now += 2_000; await agent.runOnce(); }
    expect(alerts(store, "stranded").length).toBe(0);
  });
});

describe("fuel-reserve floor (strand prevention)", () => {
  const base = {
    planState: "running" as const, notifications: [], lastPlanAt: 0, now: 1,
    heartbeatMs: 15 * 60_000, fuelPct: 20, fuelReservePct: 25, hullPct: 30,
    wakeNotificationTypes: [] as string[],
  };
  const withFuel = (fuel: number, docked: boolean): StatusSnapshot => ({
    credits: 0, fuel, maxFuel: 100, hull: 100, maxHull: 100, cargoUsed: 0, cargoCapacity: 50, docked, inTransit: false,
  });

  test("undocked below the reserve floor (22%) but above fuelPct (20%) raises low_fuel", () => {
    const w = evaluateWake({ ...base, status: withFuel(22, false) });
    expect(w?.reason).toBe("low_fuel");
  });

  test("docked at the same 22% does NOT (reserve floor is undocked-only; the reflex refuels docked)", () => {
    const w = evaluateWake({ ...base, status: withFuel(22, true) });
    expect(w).toBeNull();
  });

  test("undocked above the reserve floor (30%) does not raise low_fuel", () => {
    const w = evaluateWake({ ...base, status: withFuel(30, false) });
    expect(w).toBeNull();
  });
});

describe("recovery actions registered", () => {
  test("distress_signal parses a valid type and REJECTS a bad distress_type", () => {
    const def = getAction("distress_signal");
    expect(def.tool).toBe("spacemolt");
    expect(def.kind).toBe("mutation");
    expect(def.params.safeParse({ distress_type: "fuel" }).success).toBe(true);
    expect(def.params.safeParse({ distress_type: "nonsense" }).success).toBe(false);
    expect(def.params.safeParse({}).success).toBe(false); // required on our side
  });

  test("self_destruct takes no params; tow routes to spacemolt_salvage and requires an id", () => {
    expect(getAction("self_destruct").params.safeParse({}).success).toBe(true);
    const tow = getAction("tow");
    expect(tow.tool).toBe("spacemolt_salvage");
    expect(tow.params.safeParse({ id: "wreck_1" }).success).toBe(true);
    expect(tow.params.safeParse({}).success).toBe(false);
  });
});
