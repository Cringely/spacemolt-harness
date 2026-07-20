import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot, SystemInfo } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

// F-1 fix (2026-07-10 shape fix): get_system's own system.pois list carries
// POI type/class (VERIFIED live capture), so gatherSurroundings() no longer
// needs a separate getPoi() call -- SystemInfo.pois is the sole source now.
function stubApiWithMap(opts: { system: SystemInfo; status?: Partial<StatusSnapshot> }) {
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, dockedAt: "base-1", ...opts.status,
  };
  let getSystemCalls = 0;
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    async getSystem() { getSystemCalls++; return opts.system; },
  };
  return { api, counts: () => ({ getSystemCalls }) };
}

describe("Agent surroundings (F-1)", () => {
  test("populates ctx.surroundings from getSystem + status.dockedAt on replan", async () => {
    const { api } = stubApiWithMap({
      system: {
        id: "sys-1", name: "Alpha Prime", connections: ["sys-2"],
        pois: [{ id: "poi-1", name: "Rusty Belt", type: "asteroid_belt", class: "metallic" }],
        // SM-4 fix: get_system's top-level current-location POI.
        currentPoi: { id: "poi-1", name: "Rusty Belt", type: "asteroid_belt" },
      },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.surroundings).toEqual({
      systemId: "sys-1",
      systemName: "Alpha Prime",
      connections: ["sys-2"],
      pois: [{ id: "poi-1", name: "Rusty Belt", type: "asteroid_belt", class: "metallic" }],
      dockedAt: "base-1",
      currentPoi: { id: "poi-1", name: "Rusty Belt", type: "asteroid_belt" },
    });
  });

  test("surroundings is gathered fresh on every replan (no caching)", async () => {
    const { api, counts } = stubApiWithMap({
      system: { id: "sys-1", name: "Alpha Prime", connections: [], pois: [] },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan, { goal: "obey", steps: [{ action: "dock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // replan #1
    agent.instruct("go explore");
    await agent.runOnce(); // instruction wake -> replan #2
    expect(planner.contexts.length).toBe(2);
    expect(counts()).toEqual({ getSystemCalls: 2 });
  });

  test("GameApi without getSystem degrades to undefined surroundings, not a crash", async () => {
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() {
        return {
          credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.surroundings).toBeUndefined();
  });

  // SM-2 flight diagnosis receipt: pre-fix, a getSystem() failure degraded to
  // undefined surroundings via a bare `catch { return undefined }` -- no
  // visible signal at all, which is exactly how the planner flew an entire
  // flight blind without anyone noticing. This test is the guard against that
  // regressing silently again.
  test("a getSystem() rejection degrades to undefined surroundings, emits surroundings_error, and doesn't block replan", async () => {
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() {
        return {
          credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
      async getSystem(): Promise<SystemInfo> { throw new Error("map query down"); },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // must not throw
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.surroundings).toBeUndefined();
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok"); // replan still succeeded

    const events = store.recentEvents("a1", 20).filter((e) => e.type === "surroundings_error");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ message: "map query down" });
  });

  // Guards the other silent-degrade mode named in the diagnosis: a parse that
  // returns without throwing but yields nothing usable (the exact shape of
  // the original bug -- the wrong ASSUMED schema parsed "successfully" to all
  // defaults). system.id === null is that signal.
  test("a getSystem() parse with no usable location data emits surroundings_error too", async () => {
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() {
        return {
          credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
      async getSystem(): Promise<SystemInfo> { return { id: null, name: null, connections: [], pois: [] }; },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts[0]!.surroundings).toBeUndefined();
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "surroundings_error");
    expect(events.length).toBe(1);
  });
});

// Mission-funnel fix (issue #147): the digest used to instruct the planner to
// plan get_missions -- a kind:"query" action PlanSchema structurally rejects,
// so mission listing was unreachable (11 planner_errors/48h, zero mission
// steps ever executed). The harness now fetches the listing itself, once per
// DOCKED replan (same cadence as gatherSurroundings), and hands the raw text
// to the planner as ctx.missionsText. These tests guard the three behaviors
// the fix hangs on: docked -> fetched and passed through; undocked -> no call
// at all (missions need a station; no wasted per-tick traffic); a failed
// fetch -> fail-soft (no section, visible missions_error, replan proceeds).
describe("Agent mission listing (#147)", () => {
  const system: SystemInfo = { id: "sys-1", name: "Alpha Prime", connections: [], pois: [] };

  function stubApiWithMissions(opts: {
    docked: boolean;
    missions: () => Promise<string>;
    // #170: optional so the pre-existing #147 tests keep exercising an api
    // WITHOUT getActiveMissions (the degrade-when-absent path, for free).
    activeMissions?: () => Promise<string>;
  }) {
    let getMissionsCalls = 0;
    let getActiveMissionsCalls = 0;
    const status: StatusSnapshot = {
      credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: opts.docked, inTransit: false,
      dockedAt: opts.docked ? "base-1" : null,
    };
    const active = opts.activeMissions;
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
      async getSystem() { return system; },
      async getMissions() { getMissionsCalls++; return opts.missions(); },
      // #291: getActiveMissions returns { text, missions? } now; these tests
      // exercise the raw-text path, so the stub wraps the string.
      ...(active ? { async getActiveMissions() { getActiveMissionsCalls++; return { text: await active() }; } } : {}),
    };
    return { api, counts: () => ({ getMissionsCalls }), activeCounts: () => ({ getActiveMissionsCalls }) };
  }

  test("docked replan fetches the listing once and hands the raw text to the planner", async () => {
    const listing = "1. Haul 20 iron_ore to Vega Depot (template_id: haul_iron_20, reward 900cr)";
    const { api, counts } = stubApiWithMissions({ docked: true, missions: async () => listing });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan
    expect(counts()).toEqual({ getMissionsCalls: 1 });
    expect(planner.contexts[0]!.missionsText).toBe(listing);
    // The end of the funnel: the digest the planner reads carries the listing.
    expect(buildDigest(planner.contexts[0]!)).toContain(listing);
  });

  test("undocked replan makes NO missions fetch and passes no listing", async () => {
    const { api, counts } = stubApiWithMissions({ docked: false, missions: async () => "should never be fetched" });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ getMissionsCalls: 0 });
    expect(planner.contexts[0]!.missionsText).toBeUndefined();
  });

  test("a getMissions() rejection degrades to no mission section, emits missions_error, and doesn't block replan", async () => {
    const { api } = stubApiWithMissions({ docked: true, missions: async () => { throw new Error("missions query down"); } });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // must not throw
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.missionsText).toBeUndefined();
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok"); // replan still succeeded

    const events = store.recentEvents("a1", 20).filter((e) => e.type === "missions_error");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ message: "missions query down" });
  });

  // Active-mission visibility fix (issue #170, the predicted #147 follow-up):
  // accepted missions were invisible at plan time -- nothing fetched
  // get_active_missions, so the planner treated every dock as a fresh start and
  // complete_mission had no id source. The invariant: the planner must always
  // see work-in-progress. These tests guard the behaviors the fix hangs on:
  // active missions reach the planner docked AND undocked (objectives are
  // worked in space, so unlike #147's listing this fetch has NO docked gate,
  // while the available listing stays docked-only); a failed active fetch
  // degrades ONLY the active section (available listing survives) with a
  // visible active_missions_error.
  describe("Agent active-mission listing (#170)", () => {
    const availableListing = "1. Courier run to Haven (template_id: courier_haven)";
    const activeListing = "1. Haul 20 iron_ore to Vega Depot (id: m-77, expires tick 9400)";

    test("docked replan passes BOTH listings to the planner and the digest", async () => {
      const { api, counts, activeCounts } = stubApiWithMissions({
        docked: true,
        missions: async () => availableListing,
        activeMissions: async () => activeListing,
      });
      const store = new Store(":memory:");
      const planner = new MockPlanner([okPlan]);
      const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

      await agent.runOnce();
      expect(counts()).toEqual({ getMissionsCalls: 1 });
      expect(activeCounts()).toEqual({ getActiveMissionsCalls: 1 });
      expect(planner.contexts[0]!.missionsText).toBe(availableListing);
      expect(planner.contexts[0]!.activeMissionsText).toBe(activeListing);
      expect(buildDigest(planner.contexts[0]!)).toContain(activeListing);
    });

    test("undocked replan still fetches active missions (no docked gate) while the available listing stays docked-only", async () => {
      const { api, counts, activeCounts } = stubApiWithMissions({
        docked: false,
        missions: async () => "should never be fetched",
        activeMissions: async () => activeListing,
      });
      const store = new Store(":memory:");
      const planner = new MockPlanner([okPlan]);
      const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

      await agent.runOnce();
      expect(counts()).toEqual({ getMissionsCalls: 0 });
      expect(activeCounts()).toEqual({ getActiveMissionsCalls: 1 });
      expect(planner.contexts[0]!.missionsText).toBeUndefined();
      expect(planner.contexts[0]!.activeMissionsText).toBe(activeListing);
      // the end of the funnel: the work-in-progress reaches the digest in space
      expect(buildDigest(planner.contexts[0]!)).toContain(activeListing);
    });

    test("a getActiveMissions() rejection degrades ONLY the active section, emits active_missions_error, and doesn't block replan", async () => {
      const { api } = stubApiWithMissions({
        docked: true,
        missions: async () => availableListing,
        activeMissions: async () => { throw new Error("active missions query down"); },
      });
      const store = new Store(":memory:");
      const planner = new MockPlanner([okPlan]);
      const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

      await agent.runOnce(); // must not throw
      expect(planner.contexts.length).toBe(1);
      expect(planner.contexts[0]!.activeMissionsText).toBeUndefined();
      // failure of one fetch degrades that section only
      expect(planner.contexts[0]!.missionsText).toBe(availableListing);
      expect(store.loadPlan("a1")!.plan.goal).toBe("ok"); // replan still succeeded

      const events = store.recentEvents("a1", 20).filter((e) => e.type === "active_missions_error");
      expect(events.length).toBe(1);
      expect(events[0]!.payload).toEqual({ message: "active missions query down" });
    });
  });
});
