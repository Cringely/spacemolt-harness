import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { buildDigest } from "../src/planner/digest";
import type { GameApi, StatusSnapshot, SystemInfo } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { StationSighting } from "../src/planner/types";
import { MAX_STATION_SIGHTINGS, rememberStation } from "../src/agent/stations";

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
      // The ship's real position: get_status.location.poi_id, live-verified to
      // be in get_system's POI id space.
      poiId: opts.system.currentPoi?.id ?? null,
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
 * Drives one dock at `system`, so the agent learns that station. Two ticks: the
 * dock on the second one carries the whole sighting, because the ship's own
 * pre-action position IS the station it docked at.
 */
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
  // ABLATION (re-run 2026-07-25 against the one-seam shape): revert the digest's
  // `if (ctx.knownStations?.length)` render line and this test fails on the
  // gold_run assertion --
  //   error: expect(received).toContain(expected)  Expected to contain: "gold_run"
  // -- with the two adjacency systems (gsc_0051, alkaid) still rendering. That
  // is exactly the starvation the issue describes: the planner is shown one hop
  // and told to use travel_to for anything further. Removing the learn seam
  // instead fails it too, from the other side.
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
    // One seam, one event: the dock itself carries the system AND the station
    // POI (the ship was standing at that POI, or the dock could not have worked).
    expect(store.recentEventsByType("a1", "station_observed", 10).length).toBe(1);

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
    // Four artifacts an older or hand-edited build could have left behind: no
    // systemId at all, a systemId of the wrong TYPE, a services list of the
    // wrong shape, and a row written before stationPoiId existed at all (the
    // shape this branch itself shipped first, so it is a real predecessor, not
    // an invented one).
    //
    // The two bad-systemId rows are discarded by different things, and only one
    // of them exercises the loader. `json_extract(payload,'$.systemId')` is NULL
    // for the missing key, so SQL drops that row before the loader ever sees it
    // -- keep it to pin that behavior, but it proves nothing about the guard.
    // The NUMERIC one is what the guard is for: json_extract returns 12345, the
    // row passes the WHERE clause, and `typeof p.systemId !== "string"` is the
    // only thing between it and `travel_to{system_id=12345}` in a live prompt.
    store.appendEvent({ agentId: "a1", ts: 100, type: "station_observed", payload: { station: "Nameless" } });
    store.appendEvent({
      agentId: "a1", ts: 150, type: "station_observed",
      payload: { systemId: 12345, station: "Numeric Station", services: ["market"] },
    });
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
    // The unusable rows are gone; the bad-shape services degraded to empty rather
    // than riding a string into the prompt; the good rows are intact and simply
    // carry no station POI until a replan in those systems supplies one.
    //
    // toStrictEqual, not toEqual, and the length assertion above it (PR #18
    // review addendum). Bun mirrors Jest here: `expect(["a","b",undefined])
    // .toEqual(["a","b"])` PASSES, so the obvious assertion is structurally
    // incapable of failing when a discarded row leaks through as `undefined`.
    // The test named the right behavior and could not detect its absence.
    expect(known).toHaveLength(2);
    expect(known.map((s) => s.systemId)).toStrictEqual(["market_prime", "haven"]);
    expect(known.find((s) => s.systemId === "haven")!.services).toEqual([]);
    expect(known.find((s) => s.systemId === "market_prime")!.services).toEqual(["market"]);
    expect(known.every((s) => s.stationPoiId === undefined)).toBe(true);
    // and the digest still routes usefully without it, rather than inventing a POI
    expect(buildDigest(planner.contexts.at(-1)!)).toContain("read it off that system's POI list");
  });

  // Service attribution, and the line between an action that PROVES a station
  // service and one that merely succeeded near it. A refuel while docked at a
  // base with no pump (or with no credits) falls through to burning fuel cells
  // from cargo and reports success -- openapi-v2 /refuel mode 4 is "Otherwise",
  // not "undocked" -- so `docked` cannot tell mode 3 from mode 4 and a `refuel`
  // tag here would route the pilot back for fuel it cannot buy. A sell has no
  // such fallback: it needs a market. Same tick, same station, same docked flag,
  // opposite verdicts.
  test("a docked sell proves a market; a docked refuel proves nothing", async () => {
    const runDocked = async (action: string, resultText: string) => {
      const store = new Store(":memory:");
      const { api, state } = fakeGame({
        system: goldRun,
        status: {
          systemId: "gold_run", docked: true, dockedAt: "gold_run_base", fuel: 40,
          cargoUsed: 1, cargo: [{ itemId: "iron_ore", name: "Iron Ore", quantity: 1 }],
        },
        results: { [action]: resultText },
      });
      // The hold really empties on a sell. The executor verifies the effect
      // (verifySellEffect re-queries status and demands the quantity dropped),
      // so a fake whose cargo never moves gets the sell classified as a phantom
      // -- a blocked outcome that teaches nothing, which would make this test
      // pass for the wrong reason.
      const inner = api.action.bind(api);
      api.action = async (name, params) => {
        const res = await inner(name, params);
        if (name === "sell") { state.status = { ...state.status, cargoUsed: 0, cargo: [] }; }
        return res;
      };
      const agent = new Agent({
        id: "a1", persona: "miner", api, store, config, now: () => 1_000,
        planner: new MockPlanner([{ goal: "g", steps: [{ action, params: { id: "iron_ore", quantity: 1 } }] }]),
      });
      await agent.runOnce();
      await agent.runOnce();
      return store.recentEventsByType("a1", "station_observed", 10).map((e) => e.payload);
    };

    expect(await runDocked("sell", "Sold 1 Iron Ore for 40cr.")).toEqual([{
      systemId: "gold_run", stationPoiId: "gold_run_extraction_hub",
      station: undefined, services: ["market"],
    }]);
    // Nothing learned at all: the success is real, the geography claim is not.
    expect(await runDocked("refuel", "Refueled 86 fuel for 602cr.")).toEqual([]);
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

  // Two stations in one system is NOT ambiguous when the POI comes from the
  // ship's own position: you docked at exactly one of them, and `dock` requires
  // already being at it ("`dock` requires being at a POI with a base",
  // upstream/docs/travel.md:51). The map-elimination design had to give up here.
  test("a system with two bases still teaches the station the pilot actually docked at", async () => {
    const twoBases: SystemInfo = {
      id: "haven", name: "Haven", connections: ["segin"],
      // The pilot is docked at the SECOND base, not the first. Deliberate: with
      // the docked station at pois[0] this test passes just as happily against
      // "take the first POI with a base", which is the wrong rule and the one a
      // map-elimination design would have used. Ordered this way, only the
      // ship's own position satisfies it.
      pois: [
        { id: "grand_exchange", name: "Grand Exchange Station", type: "station", hasBase: true },
        { id: "haven_outpost", name: "Haven Outpost", type: "station", hasBase: true },
      ],
      currentPoi: { id: "haven_outpost", name: "Haven Outpost", type: "station", hasBase: true },
    };
    const store = new Store(":memory:");
    await dockOnce(store, twoBases, "Docked at Haven Outpost", 1_000_000);
    expect(store.recentEventsByType("a1", "station_observed", 10).at(-1)!.payload)
      .toEqual({
        systemId: "haven", stationPoiId: "haven_outpost",
        station: "Haven Outpost", services: [],
      });
  });

  // Services belong to the station that proved them, not to the system. The
  // record describes ONE station, so moving to a different station in the same
  // system drops the previous one's name and proven services with it. Without
  // the reset the fields drift apart -- POI and name are last-write-wins while
  // services accumulate -- and the digest renders the survivor as offering
  // everything ever proven anywhere in that system: a confident route to a
  // station that cannot do the thing, which is this fix's own bug in miniature.
  test("moving to another station in the same system does not inherit its services", async () => {
    const store = new Store(":memory:");
    // A market proven at Grand Exchange.
    store.appendEvent({
      agentId: "a1", ts: 1_000, type: "station_observed",
      payload: {
        systemId: "haven", stationPoiId: "grand_exchange",
        station: "Grand Exchange Station", services: ["market"],
      },
    });

    // Now dock at the OTHER station in haven. Nothing here proves a market.
    const outpost: SystemInfo = {
      id: "haven", name: "Haven", connections: ["segin"],
      pois: [
        { id: "grand_exchange", name: "Grand Exchange Station", type: "station", hasBase: true },
        { id: "haven_outpost", name: "Haven Outpost", type: "station", hasBase: true },
      ],
      currentPoi: { id: "haven_outpost", name: "Haven Outpost", type: "station", hasBase: true },
    };
    await dockOnce(store, outpost, "Docked at Haven Outpost", 2_000);

    expect(store.recentEventsByType("a1", "station_observed", 10).at(-1)!.payload).toEqual({
      systemId: "haven", stationPoiId: "haven_outpost",
      station: "Haven Outpost", services: [],
    });
  });

  // The reload window, which is where F1 lived. This memory emits one event per
  // FACT, so a system worked hard (name, POI, several services) spends many rows
  // while a system docked at once spends one. Under a most-recent-N-ROWS read the
  // quiet system is evicted FIRST -- and that is the incident's own system,
  // gold_run: confirmed once, never revisited, forgotten on restart by the
  // memory built to remember it. Grouping by systemId makes rows-per-system
  // irrelevant.
  test("a chatty system cannot evict a quiet one from the reload window", () => {
    const store = new Store(":memory:");
    let ts = 1_000;
    // gold_run first and quiet: one row, the oldest in the table.
    store.appendEvent({
      agentId: "a1", ts: ts++, type: "station_observed",
      payload: { systemId: "gold_run", stationPoiId: "gold_run_extraction_hub", station: "Gold Run Extraction Hub", services: [] },
    });
    // Seven busy systems after it, 6 rows each (a station, a name, four service
    // updates) -- 43 rows total, well past any cap-sized row window.
    const busy = ["haven", "market_prime", "cargo_lanes", "factory_belt", "traders_rest", "the_levy", "first_step"];
    for (const sys of busy) {
      for (let i = 0; i < 6; i++) {
        store.appendEvent({
          agentId: "a1", ts: ts++, type: "station_observed",
          payload: { systemId: sys, stationPoiId: `${sys}_hub`, station: `${sys} station`, services: ["market"].slice(0, i % 2) },
        });
      }
    }
    expect(store.recentEventsByType("a1", "station_observed", 100).length).toBe(43);

    const { api } = fakeGame({ system: segin, status: { systemId: "segin" } });
    const planner = new MockPlanner([dockPlan]);
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner, config, now: () => 9_000_000,
    });
    return agent.runOnce().then(() => {
      const known = planner.contexts.at(-1)!.knownStations!;
      expect(known.length).toBe(8);
      expect(known.map((s) => s.systemId).sort()).toEqual([...busy, "gold_run"].sort());
      // and it came back whole, not as a bare system id
      expect(known.find((s) => s.systemId === "gold_run")).toEqual({
        systemId: "gold_run", stationPoiId: "gold_run_extraction_hub",
        station: "Gold Run Extraction Hub", services: [], lastSeen: 1_000,
      });
    });
  });

  // The live eviction path, driven directly because nothing else in this file
  // gets near the cap. Eviction is silent by nature -- a forgotten station looks
  // exactly like one never visited -- so an untested cap is a memory that can
  // quietly stop being one.
  test("rememberStation keeps the newest sightings at the cap and drops the oldest", () => {
    const sightings = new Map<string, StationSighting>();
    // One more system than the cap, oldest first.
    for (let i = 0; i <= MAX_STATION_SIGHTINGS; i++) {
      rememberStation(sightings, { systemId: `sys_${i}`, stationPoiId: `sys_${i}_hub`, now: 1_000 + i });
    }
    expect(sightings.size).toBe(MAX_STATION_SIGHTINGS);
    expect(sightings.has("sys_0")).toBe(false); // the oldest, evicted
    expect(sightings.has(`sys_${MAX_STATION_SIGHTINGS}`)).toBe(true);

    // Re-observing an entry refreshes its recency, so it is no longer the one
    // the next eviction takes.
    rememberStation(sightings, { systemId: "sys_1", service: "market", now: 9_000 });
    rememberStation(sightings, { systemId: "brand_new", now: 9_001 });
    expect(sightings.has("sys_1")).toBe(true);
    expect(sightings.has("sys_2")).toBe(false); // now the oldest
  });

  // The reload's own cap: the SQL LIMIT, and now the only thing capping the
  // reload path. This test USED to pass with that limit raised to 100, because
  // a redundant `.slice(0, MAX)` in knownStationSystems silently re-capped the
  // result -- a guard covering for the guard under test. The slice is gone, so
  // this now fails if the LIMIT is loosened.
  test("past the cap, the oldest sighting is evicted and the newest survive", () => {
    const store = new Store(":memory:");
    // Twelve systems, oldest first -- the count a query over the live store
    // actually recovered from dock results.
    const systems = ["gold_run", "haven", "market_prime", "cargo_lanes", "factory_belt", "traders_rest",
      "the_levy", "treasure_cache", "first_step", "last_light", "deep_range", "unknown_edge"];
    systems.forEach((sys, i) => store.appendEvent({
      agentId: "a1", ts: 1_000 + i, type: "station_observed",
      payload: { systemId: sys, stationPoiId: `${sys}_hub`, services: [] },
    }));

    const { api } = fakeGame({ system: segin, status: { systemId: "segin" } });
    const planner = new MockPlanner([dockPlan]);
    const agent = new Agent({
      id: "a1", persona: "miner", api, store, planner, config, now: () => 9_000_000,
    });
    return agent.runOnce().then(() => {
      const known = planner.contexts.at(-1)!.knownStations!;
      // the newest 8, newest first -- the four oldest are gone
      expect(known.map((s) => s.systemId)).toEqual([...systems].slice(4).reverse());
    });
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
