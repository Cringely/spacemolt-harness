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
// successful dock results alone. Its POI list carries the sun the 2026-07-25
// 01:00 jump actually landed at, so the fixture reproduces the trap: arriving in
// this system does NOT put the ship at the station.
const goldRun: SystemInfo = {
  id: "gold_run", name: "Gold Run", connections: ["xihe"],
  pois: [
    { id: "aurelia", name: "Aurelia", type: "sun" },
    { id: "gold_run_extraction_hub", name: "Gold Run Extraction Hub", type: "station", hasBase: true },
  ],
  currentPoi: { id: "gold_run_extraction_hub", name: "Gold Run Extraction Hub", type: "station", hasBase: true },
};

// gold_run as seen from the sun, where a jump drops you: same POI list, but the
// ship is at `aurelia` and undocked. This is the 01:00-01:01 position.
const goldRunAtSun: SystemInfo = {
  ...goldRun,
  currentPoi: { id: "aurelia", name: "Aurelia", type: "sun" },
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

/**
 * Drives one dock at `system`, so the agent learns that station.
 *
 * Three ticks, because the two halves of a sighting are learned at two
 * different seams: the dock itself teaches the SYSTEM (the executor holds the
 * action and the status but no map), and the replan after it teaches the
 * in-system STATION POI (a replan holds fresh get_system data).
 */
async function dockOnce(store: Store, system: SystemInfo, resultText: string, now: number): Promise<void> {
  const { api } = fakeGame({ system, status: { systemId: system.id }, results: { dock: resultText } });
  const agent = new Agent({
    id: "a1", persona: "miner", api, store, planner: new MockPlanner([dockPlan]), config, now: () => now,
  });
  await agent.runOnce(); // wake: no_plan -> replan
  await agent.runOnce(); // dock -> success, system learned
  await agent.runOnce(); // wake: plan_done -> replan, station POI learned
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
    // Usable, not merely mentioned: the prompt has to carry the WHOLE route.
    // A system id alone leaves the planner one failed dock short -- live
    // 2026-07-25 01:00, a jump into gold_run landed at the sun and the bare
    // dock that followed returned "No station at this location".
    expect(digest).toContain("travel_to{system_id=gold_run}");
    expect(digest).toContain("travel{id=gold_run_extraction_hub}");
  });

  // Restart safety is the whole point of persisting this: the knowledge the live
  // pilot could not see was nine hours and at least one restart old.
  test("a station confirmed by docking survives a restart", async () => {
    const store = new Store(":memory:");
    await dockOnce(store, goldRun, "Docked at Gold Run Extraction Hub", 1_000_000);
    // Two facts, two events: the system from the dock, the station POI from the
    // replan that followed it.
    expect(store.recentEventsByType("a1", "station_observed", 10).length).toBe(2);

    // "restart": a fresh Agent over the same store, elsewhere in the galaxy,
    // with no plan in flight so its first tick replans (the resumed dock plan
    // would otherwise execute first, and this test is about the memory).
    store.clearPlan("a1");
    const { api } = fakeGame({ system: segin, status: { systemId: "segin" } });
    const planner = new MockPlanner([dockPlan]);
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner, config, now: () => 3_000_000,
    });
    await agent.runOnce();
    expect(planner.contexts.at(-1)!.knownStations).toEqual([{
      systemId: "gold_run",
      stationPoiId: "gold_run_extraction_hub",
      station: "Gold Run Extraction Hub",
      services: [],
      lastSeen: 1_000_000,
    }]);
  });

  // Persisted-state schema tolerance (AGENTS.md): stored observations outlive the
  // schema that wrote them. A row that no longer validates is DISCARDED, never
  // fatal -- a crash here is a crash on the boot path, which is how the
  // 2026-07-12 chat-enum incident took production down.
  test("stored observations that no longer validate are discarded, not fatal", async () => {
    const store = new Store(":memory:");
    // Three artifacts an older or hand-edited build could have left behind:
    // no systemId at all, a services list of the wrong shape, and a row written
    // before stationPoiId existed at all (the shape this branch itself shipped
    // first, so it is a real predecessor, not an invented one).
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
    // than riding a string into the prompt; the good rows are intact and simply
    // carry no station POI until a replan in those systems supplies one.
    expect(known.map((s) => s.systemId)).toEqual(["market_prime", "haven"]);
    expect(known.find((s) => s.systemId === "haven")!.services).toEqual([]);
    expect(known.find((s) => s.systemId === "market_prime")!.services).toEqual(["market"]);
    expect(known.every((s) => s.stationPoiId === undefined)).toBe(true);
    // and the digest still routes usefully without it, rather than inventing a POI
    expect(buildDigest(planner.contexts.at(-1)!)).toContain("read it off that system's POI list");
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
      { systemId: "gold_run", stationPoiId: undefined, station: undefined, services: ["refuel"] },
    ]);
  });

  // The station NAME is parsed from game prose; the FACT is not. A reworded dock
  // result must cost us the display name and nothing else -- the system id is
  // what travel_to takes, and it comes from the pilot's own position plus the
  // executor's success classification.
  test("an unrecognized dock wording still confirms the system, just without a name", async () => {
    const store = new Store(":memory:");
    await dockOnce(store, goldRun, "Docking clamps engaged, welcome aboard.", 1_000_000);
    expect(store.recentEventsByType("a1", "station_observed", 10).at(-1)!.payload).toEqual({
      systemId: "gold_run",
      // read from get_system's structured POI data, so it survives the wording change
      stationPoiId: "gold_run_extraction_hub",
      station: undefined,
      services: [],
    });
  });

  // The in-system leg, learned the way the live trace says it must be. A jump
  // drops the ship at an arbitrary POI (2026-07-25 01:00: `aurelia`, the sun),
  // so the station POI id is read from get_system's structured POI list rather
  // than from where the ship happens to be standing.
  test("the station POI is learned from the system's POI data, not from the ship's position", async () => {
    const store = new Store(":memory:");
    // A sighting stored before the POI id existed -- system confirmed, in-system
    // leg unknown. This is both the older artifact and the state any dock leaves
    // behind before the next replan.
    store.appendEvent({
      agentId: "a1", ts: 1_000_000, type: "station_observed",
      payload: { systemId: "gold_run", station: "Gold Run Extraction Hub", services: ["refuel"] },
    });

    // A pass through gold_run that never docks: parked at the sun, exactly the
    // 01:01 position. The station POI still resolves, by elimination over
    // hasBase -- the field that could have saved the whole three-minute detour,
    // sitting in a response the pilot had already fetched.
    const { api } = fakeGame({ system: goldRunAtSun, status: { systemId: "gold_run", docked: false } });
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner: new MockPlanner([dockPlan]), config, now: () => 2_000_000,
    });
    await agent.runOnce();

    expect(store.recentEventsByType("a1", "station_observed", 10).at(-1)!.payload).toEqual({
      systemId: "gold_run",
      stationPoiId: "gold_run_extraction_hub",
      station: "Gold Run Extraction Hub",
      services: ["refuel"],
    });
  });

  // Ambiguity teaches nothing. A wrong station POI is worse than an absent one:
  // absent leaves the planner reading the POI list on arrival (which works),
  // while wrong routes it confidently to the wrong rock and earns the same
  // "No station at this location" this whole fix exists to stop.
  test("a system with two bases teaches no station POI unless the pilot is docked at one", async () => {
    const twoBases: SystemInfo = {
      id: "haven", name: "Haven", connections: ["segin"],
      pois: [
        { id: "grand_exchange", name: "Grand Exchange Station", type: "station", hasBase: true },
        { id: "haven_outpost", name: "Haven Outpost", type: "station", hasBase: true },
      ],
      currentPoi: { id: "haven_drift", name: "Haven Drift", type: "asteroid_belt" },
    };
    const store = new Store(":memory:");
    await dockOnce(store, twoBases, "Docked at Grand Exchange Station", 1_000_000);
    // No stationPoiId key at all: the replan looked, found two candidates and
    // declined to guess.
    expect(store.recentEventsByType("a1", "station_observed", 10).at(-1)!.payload)
      .toEqual({ systemId: "haven", station: "Grand Exchange Station", services: [] });

    // Docked, the ambiguity is gone: the POI you are docked at IS the station
    // ("`dock` requires being at a POI with a base", upstream/docs/travel.md:51).
    store.clearPlan("a1"); // replan on the first tick rather than resuming
    const { api } = fakeGame({
      system: { ...twoBases, currentPoi: { id: "grand_exchange", name: "Grand Exchange Station", type: "station", hasBase: true } },
      status: { systemId: "haven", docked: true, dockedAt: "grand_exchange" },
    });
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner: new MockPlanner([dockPlan]), config, now: () => 2_000_000,
    });
    await agent.runOnce();
    expect(store.recentEventsByType("a1", "station_observed", 10).at(-1)!.payload)
      .toMatchObject({ systemId: "haven", stationPoiId: "grand_exchange" });
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
