import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { buildDigest } from "../src/planner/digest";
import type { GameApi, StatusSnapshot, SystemInfo } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Station geography (issue #517). The state every test here drives is the one
// the live pilot was actually in (miner, 2026-07-25 00:10-00:58 UTC): cargo
// 100/100, fuel 10/100 (below reserve), sitting in a system with no dockable
// POI -- and 8 jumps + 70 planner calls spent hunting for a station it had
// already docked at and refuelled at nine hours earlier.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const dockPlan: Plan = { goal: "dock at the hub", steps: [{ action: "dock", params: {} }] };

// The incident's system: a real one from the pilot's 8-jump walk, with no POI
// carrying has_base -- nowhere to dock, which is what makes the destination
// shortlist the only thing in the prompt that can answer "so where do I go".
const segin: SystemInfo = {
  id: "segin", name: "Segin", connections: ["gsc_0051", "alkaid"],
  pois: [{ id: "segin_belt_a", name: "Segin Belt A", type: "asteroid_belt" }],
  currentPoi: { id: "segin_belt_a", name: "Segin Belt A", type: "asteroid_belt" },
};

// The system the pilot had confirmed by docking: gold_run / Gold Run Extraction
// Hub, one of the 12 station systems a query over the live store recovered from
// successful dock results alone.
const goldRun: SystemInfo = {
  id: "gold_run", name: "Gold Run", connections: ["xihe"],
  pois: [{ id: "gold_run_hub", name: "Gold Run Extraction Hub", type: "station", hasBase: true }],
  currentPoi: { id: "gold_run_hub", name: "Gold Run Extraction Hub", type: "station", hasBase: true },
};

/**
 * A fake game whose position, dock state and per-action result text the test
 * drives directly. `results` maps an action name to the game's result string --
 * the live wording is what the station-name parse has to survive.
 */
function fakeGame(opts: {
  system: SystemInfo;
  status: Partial<StatusSnapshot>;
  results?: Record<string, string>;
}) {
  const state = {
    system: opts.system,
    status: {
      credits: 5_000, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 100, docked: false, inTransit: false,
      systemId: opts.system.id,
      ...opts.status,
    } as StatusSnapshot,
  };
  const api: GameApi = {
    async action(name): Promise<V2Result> { return { result: opts.results?.[name] ?? "ok" }; },
    async status() { return state.status; },
    async notifications() { return []; },
    async getSystem() { return state.system; },
  };
  return { api, state };
}

/** Drives one dock at `system`, so the agent learns that station. */
async function dockOnce(store: Store, system: SystemInfo, resultText: string, now: number): Promise<void> {
  const { api } = fakeGame({ system, status: { systemId: system.id }, results: { dock: resultText } });
  const agent = new Agent({
    id: "a1", persona: "miner", api, store, planner: new MockPlanner([dockPlan]), config, now: () => now,
  });
  await agent.runOnce(); // wake: no_plan -> replan
  await agent.runOnce(); // dock -> success, station learned
}

describe("station geography (issue #517)", () => {
  // THE regression test. It drives the live-recorded state end to end -- a dock
  // that succeeded, then the stranded-with-full-cargo replan that followed --
  // and asserts the prompt names a system the pilot can actually fly to.
  //
  // ABLATION (2026-07-24): reverted the digest's `if (ctx.knownStations?.length)`
  // render line, leaving today's connText-only surroundings block. This test
  // fails on the gold_run assertion:
  //   error: expect(received).toContain(expected)  Expected to contain: "gold_run"
  // The two adjacency systems (gsc_0051, alkaid) still render, which is exactly
  // the starvation the issue describes: the planner is shown one hop and told to
  // use travel_to for anything further.
  test("a confirmed station system reaches the digest when the pilot is stranded with no station here", async () => {
    const store = new Store(":memory:");
    await dockOnce(store, goldRun, "Docked at Gold Run Extraction Hub", 1_000_000);

    // The incident state, one system away: hold full, fuel below reserve,
    // nowhere here to dock -- and a plan already running, so the replan comes
    // from the fuel wake preempting it, exactly as it did live.
    const { api } = fakeGame({
      system: segin,
      status: { systemId: "segin", fuel: 10, cargoUsed: 100, cargoCapacity: 100 },
    });
    store.savePlan("a1", { goal: "keep mining", steps: [{ action: "mine", params: {} }] }, []);
    const planner = new MockPlanner([dockPlan]);
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner, config, now: () => 2_000_000,
    });
    await agent.runOnce();

    const ctx = planner.contexts.at(-1)!;
    expect(ctx.wake.reason).toBe("low_fuel");
    const digest = buildDigest(ctx);
    expect(digest).toContain("gold_run");
    expect(digest).toContain("Gold Run Extraction Hub");
    // and it must be usable: the id is offered as a travel_to target, not just
    // mentioned somewhere in the prose.
    expect(digest).toContain("travel_to{system_id=");
  });

  // Restart safety is the whole point of persisting this: the knowledge the live
  // pilot could not see was nine hours and at least one restart old.
  test("a station confirmed by docking survives a restart", async () => {
    const store = new Store(":memory:");
    await dockOnce(store, goldRun, "Docked at Gold Run Extraction Hub", 1_000_000);
    expect(store.recentEventsByType("a1", "station_observed", 10).length).toBe(1);

    // "restart": a fresh Agent over the same store, elsewhere in the galaxy.
    const { api } = fakeGame({ system: segin, status: { systemId: "segin" } });
    const planner = new MockPlanner([dockPlan]);
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner, config, now: () => 3_000_000,
    });
    await agent.runOnce();
    expect(planner.contexts.at(-1)!.knownStations).toEqual([
      { systemId: "gold_run", station: "Gold Run Extraction Hub", services: [], lastSeen: 1_000_000 },
    ]);
  });

  // Persisted-state schema tolerance (AGENTS.md): stored observations outlive the
  // schema that wrote them. A row that no longer validates is DISCARDED, never
  // fatal -- a crash here is a crash on the boot path, which is how the
  // 2026-07-12 chat-enum incident took production down.
  test("stored observations that no longer validate are discarded, not fatal", async () => {
    const store = new Store(":memory:");
    // Three artifacts an older or hand-edited build could have left behind:
    // no systemId at all, a services list of the wrong shape, and a good row.
    store.appendEvent({ agentId: "a1", ts: 100, type: "station_observed", payload: { station: "Nameless" } });
    store.appendEvent({
      agentId: "a1", ts: 200, type: "station_observed",
      payload: { systemId: "haven", station: "Grand Exchange Station", services: "refuel" },
    });
    store.appendEvent({
      agentId: "a1", ts: 300, type: "station_observed",
      payload: { systemId: "market_prime", station: "Market Prime Exchange", services: ["market"] },
    });

    const { api } = fakeGame({ system: segin, status: { systemId: "segin" } });
    const planner = new MockPlanner([dockPlan]);
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner, config, now: () => 4_000_000,
    });
    await agent.runOnce();

    const known = planner.contexts.at(-1)!.knownStations!;
    // The unusable row is gone; the bad-shape services degraded to empty rather
    // than riding a string into the prompt; the good row is intact.
    expect(known.map((s) => s.systemId)).toEqual(["market_prime", "haven"]);
    expect(known.find((s) => s.systemId === "haven")!.services).toEqual([]);
    expect(known.find((s) => s.systemId === "market_prime")!.services).toEqual(["market"]);
  });

  // The docked guard on service attribution. refuel has two modes (openapi-v2,
  // /api/v2/spacemolt/refuel): docked at a refuel station, or burning fuel cells
  // from cargo. Only the first says anything about geography, so an undocked
  // refuel must not stamp a system as having a pump -- that would send the pilot
  // back to a station that cannot sell it fuel.
  test("refuel confirms a fuel pump only when it succeeded while docked", async () => {
    const refuelPlan: Plan = { goal: "top up", steps: [{ action: "refuel", params: {} }] };

    const undockedStore = new Store(":memory:");
    const undocked = fakeGame({
      system: goldRun,
      status: { systemId: "gold_run", docked: false, fuel: 40 },
      results: { refuel: "Refueled 86 fuel for 602cr." },
    });
    const a1 = new Agent({
      id: "a1", persona: "miner", api: undocked.api, store: undockedStore,
      planner: new MockPlanner([refuelPlan]), config, now: () => 1_000,
    });
    await a1.runOnce();
    await a1.runOnce();
    expect(undockedStore.recentEventsByType("a1", "station_observed", 10)).toEqual([]);

    const dockedStore = new Store(":memory:");
    const docked = fakeGame({
      system: goldRun,
      status: { systemId: "gold_run", docked: true, dockedAt: "gold_run_hub", fuel: 40 },
      results: { refuel: "Refueled 86 fuel for 602cr." },
    });
    const a2 = new Agent({
      id: "a1", persona: "miner", api: docked.api, store: dockedStore,
      planner: new MockPlanner([refuelPlan]), config, now: () => 1_000,
    });
    await a2.runOnce();
    await a2.runOnce();
    expect(dockedStore.recentEventsByType("a1", "station_observed", 10).map((e) => e.payload)).toEqual([
      { systemId: "gold_run", station: undefined, services: ["refuel"] },
    ]);
  });

  // The station NAME is parsed from game prose; the FACT is not. A reworded dock
  // result must cost us the display name and nothing else -- the system id is
  // what travel_to takes, and it comes from the pilot's own position plus the
  // executor's success classification.
  test("an unrecognized dock wording still confirms the system, just without a name", async () => {
    const store = new Store(":memory:");
    await dockOnce(store, goldRun, "Docking clamps engaged, welcome aboard.", 1_000_000);
    expect(store.recentEventsByType("a1", "station_observed", 10).map((e) => e.payload)).toEqual([
      { systemId: "gold_run", station: undefined, services: [] },
    ]);
  });

  // A list of places to GO must not include where you already are: offering the
  // current system as a travel_to candidate invites a step the executor will
  // short-circuit as a no-op.
  test("the shortlist excludes the system the pilot is in right now", async () => {
    const store = new Store(":memory:");
    await dockOnce(store, goldRun, "Docked at Gold Run Extraction Hub", 1_000_000);
    await dockOnce(store, segin, "Docked at Segin Waystation", 1_100_000);

    const { api } = fakeGame({ system: segin, status: { systemId: "segin" } });
    const planner = new MockPlanner([dockPlan]);
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner, config, now: () => 2_000_000,
    });
    await agent.runOnce();

    const ctx = planner.contexts.at(-1)!;
    expect(ctx.knownStations!.map((s) => s.systemId)).toEqual(["gold_run"]);
    expect(buildDigest(ctx)).not.toContain("Segin Waystation");
  });
});
