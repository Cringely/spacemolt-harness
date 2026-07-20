import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot, SystemInfo, FittedModule } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { PlanContext } from "../src/planner/types";

// POI-extraction awareness (issue #253). The incident: a pilot with only a
// mining laser repeatedly planned `mine` at a gas POI -> blocked "You need a
// gas harvester module to collect resources here" -> replan -> plan-budget
// ceiling -> a day of silent idle (39 module-mismatch blocks in 72h: 27 gas +
// 12 ice). Two layers under test here:
//   1. Producer (digest): the system map marks what each POI yields and what
//      module extraction needs, derived from the POI `type` get_system already
//      returns (reference: upstream/api.md:1059 POI types;
//      upstream/docs/mining.md:13-17 type->equipment; gas_cloud VERIFIED live
//      in test/fixtures/spacemolt-probe-2026-07-12.json).
//   2. Deterministic backstop (agent map memory): a blocked extraction
//      refusal marks that POI incompatible so subsequent briefings steer away
//      -- bounded, restart-safe via persisted poi_incompatible events, and
//      self-healing when the named module gets fitted.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const GAS_BLOCK = "You need a gas harvester module to collect resources here";

const minePlan: Plan = { goal: "mine here", steps: [{ action: "mine", params: {} }] };

const miningLaser: FittedModule = { typeId: "mining_laser_i", type: "mining", miningPower: 5, slot: "utility" };
const gasHarvester: FittedModule = { typeId: "gas_harvester_i", type: "mining", slot: "utility" };

// The incident geometry: the pilot sits AT a gas-yielding POI. The POI type is
// deliberately NOT one of the digest's mapped types, so these tests prove the
// learned-memory marker works on its own -- the backstop exists exactly for
// POIs the type->module map cannot cover.
function gasPoiSystem(): SystemInfo {
  return {
    id: "market_prime", name: "Market Prime", connections: ["gold_run"],
    pois: [
      { id: "mp_plume", name: "Prime Plume", type: "anomaly" },
      { id: "mp_station", name: "Prime Exchange", type: "station", hasBase: true },
    ],
    currentPoi: { id: "mp_plume", name: "Prime Plume", type: "anomaly" },
  };
}

function stubApi(opts: {
  system?: () => SystemInfo;
  modules?: FittedModule[];
  onAction?: (name: string) => Promise<V2Result>;
}): GameApi {
  const status: StatusSnapshot = {
    credits: 36326, fuel: 115, maxFuel: 120, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 100, docked: false, inTransit: false,
    modules: opts.modules,
  };
  return {
    async action(name): Promise<V2Result> {
      if (opts.onAction) return opts.onAction(name);
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
    ...(opts.system ? { getSystem: async () => opts.system!() } : {}),
  };
}

// --- Layer 1: the producer -- type-derived extraction markers ---------------

describe("digest extraction markers (#253 producer)", () => {
  // Shapes mirror the live capture (spacemolt-probe-2026-07-12.json:
  // gas_cloud/molecular_cloud) and the reference type enum (api.md:1059).
  const ctx: PlanContext = {
    persona: "p", goals: [], wake: { reason: "no_plan" },
    statusSummary: "s", recentEvents: [],
    surroundings: {
      systemId: "moonshadow", systemName: "Moonshadow", connections: [],
      pois: [
        { id: "moonshadow_gas_plume", name: "Moonshadow Gas Plume", type: "gas_cloud", class: "molecular_cloud" },
        { id: "moonshadow_ice", name: "Moonshadow Shelf", type: "ice_field" },
        { id: "moonshadow_belt", name: "Rusty Belt", type: "asteroid_belt", class: "metallic" },
        { id: "moonshadow_iii", name: "Moonshadow III", type: "planet", class: "terran" },
      ],
      dockedAt: null,
    },
  };
  const digest = buildDigest(ctx);

  test("gas, ice and ore POIs are marked with the module extraction needs", () => {
    expect(digest).toContain(`moonshadow_gas_plume ("Moonshadow Gas Plume", gas_cloud/molecular_cloud) [gas -- needs gas_harvester]`);
    expect(digest).toContain(`moonshadow_ice ("Moonshadow Shelf", ice_field) [ice -- needs ice_harvester]`);
    expect(digest).toContain(`moonshadow_belt ("Rusty Belt", asteroid_belt/metallic) [ore]`);
  });

  test("a non-mineable POI gets no extraction marker, and the paired rule line is briefed", () => {
    expect(digest).toContain(`moonshadow_iii ("Moonshadow III", planet/terran)`);
    expect(digest).not.toContain(`moonshadow_iii ("Moonshadow III", planet/terran) [`);
    // the rule that makes the markers actionable: match module to marker
    expect(digest).toContain("A mining laser can NOT extract gas or ice");
    expect(digest).toContain("Only plan mine at a POI whose required module is in the Fitted list");
  });

  test("without surroundings the extraction rule line is not briefed", () => {
    const bare = buildDigest({ ...ctx, surroundings: undefined });
    expect(bare).not.toContain("A mining laser can NOT extract gas or ice");
  });
});

// --- Layer 2: the deterministic backstop -- learned map memory --------------

describe("incompatible-POI map memory (#253 backstop)", () => {
  test("incident replay: after one blocked mine at a gas POI, the next briefing marks the POI and the lesson is learned once", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const api = stubApi({
      system: gasPoiSystem,
      modules: [miningLaser], // passes the has-a-mining-module guard, exactly like the live pilot
      onAction: async (name) => {
        if (name === "mine") throw new SpacemoltError("command_error", GAS_BLOCK);
        return { result: "ok" };
      },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan A (plans mine at the gas POI)
    // pre-block: the planner has no idea the POI is incompatible
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "mp_plume")!.incompatible).toBeUndefined();

    await tick(agent); // mine blocks with the live refusal text
    await tick(agent); // blocked wake -> replan B: the lesson must be in THIS briefing

    const ctxB = planner.contexts[1]!;
    expect(ctxB.wake.reason).toBe("blocked");
    expect(ctxB.surroundings!.pois.find((p) => p.id === "mp_plume")!.incompatible).toBe("gas harvester");
    expect(buildDigest(ctxB)).toContain(`mp_plume ("Prime Plume", anomaly) [mine blocked here for your ship: needs gas harvester]`);
    // steering rule for the learned marker is briefed alongside it
    expect(buildDigest(ctxB)).toContain("NEVER plan mine there again with your current fit");

    await tick(agent); // B's mine blocks again
    await tick(agent); // blocked wake -> replan C
    // one persisted lesson per fact, not one per replay
    const learned = store.recentEvents("a1", 100).filter((e) => e.type === "poi_incompatible");
    expect(learned.length).toBe(1);
    expect(learned[0]!.payload).toEqual({ poiId: "mp_plume", module: "gas harvester" });
  });

  test("the memory survives a restart: a fresh Agent over the same store briefs the marker before any new block", async () => {
    const store = new Store(":memory:");
    // the lesson a previous process learned and persisted
    store.appendEvent({ agentId: "a1", ts: 1, type: "poi_incompatible", payload: { poiId: "mp_plume", module: "gas harvester" } });

    const api = stubApi({ system: gasPoiSystem, modules: [miningLaser] });
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> the very first replan of the new process
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "mp_plume")!.incompatible).toBe("gas harvester");
  });

  test("persisted-state tolerance: stored poi_incompatible events without the expected fields load without crashing and are skipped", async () => {
    const store = new Store(":memory:");
    // artifacts predating (or diverging from) the current shape
    store.appendEvent({ agentId: "a1", ts: 1, type: "poi_incompatible", payload: null });
    store.appendEvent({ agentId: "a1", ts: 2, type: "poi_incompatible", payload: { poiId: "mp_plume" } }); // no module
    store.appendEvent({ agentId: "a1", ts: 3, type: "poi_incompatible", payload: "gas harvester" }); // not an object
    store.appendEvent({ agentId: "a1", ts: 4, type: "poi_incompatible", payload: { poiId: "mp_station", module: "ice harvester" } }); // valid

    const api = stubApi({ system: gasPoiSystem, modules: [miningLaser] });
    const planner = new MockPlanner([minePlan]);
    // must not throw through the constructor (the chat-enum incident class)
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    const pois = planner.contexts[0]!.surroundings!.pois;
    expect(pois.find((p) => p.id === "mp_plume")!.incompatible).toBeUndefined(); // malformed rows skipped
    expect(pois.find((p) => p.id === "mp_station")!.incompatible).toBe("ice harvester"); // valid row survives
  });

  test("self-heal: fitting the named harvester clears the marker instead of briefing a stale refusal", async () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "poi_incompatible", payload: { poiId: "mp_plume", module: "gas harvester" } });

    const api = stubApi({ system: gasPoiSystem, modules: [miningLaser, gasHarvester] });
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "mp_plume")!.incompatible).toBeUndefined();
  });

  test("a ship-wide equipment block (no mining module at all) never poisons the map memory", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // no modules fitted -> the executor's own mine guard blocks with "a mine
    // action needs a mining laser module", a fact about the SHIP, not this POI
    const api = stubApi({ system: gasPoiSystem, modules: [] });
    const store = new Store(":memory:");
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // replan A
    await tick(agent); // mine guard blocks (ship-wide reason)
    await tick(agent); // blocked wake -> replan B

    expect(planner.contexts[1]!.wake.reason).toBe("blocked");
    expect(planner.contexts[1]!.surroundings!.pois.find((p) => p.id === "mp_plume")!.incompatible).toBeUndefined();
    expect(store.recentEvents("a1", 100).filter((e) => e.type === "poi_incompatible").length).toBe(0);
  });
});
