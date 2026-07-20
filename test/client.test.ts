import { afterEach, describe, expect, test } from "bun:test";
import { SpacemoltHttp, SpacemoltError } from "../src/client/http";
import { SpacemoltClient } from "../src/client/client";
import { startFakeServer, type FakeServer } from "./fake-server";
import probe from "./fixtures/spacemolt-probe-2026-07-12.json";
import mcpProbeRaw from "./fixtures/mcp-probe-2026-07-12.json";

// Typed view of the MCP probe's read-only captures (same access pattern as
// mcp-text-parser.test.ts) -- the view_market listing text lives here.
const mcpProbe = mcpProbeRaw as unknown as {
  read_only_calls: Record<string, { raw: { result: { content: { text: string }[] } } }>;
};

let server: FakeServer;
afterEach(() => server?.stop());

function makeClient() {
  const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
  return new SpacemoltClient(http);
}

describe("SpacemoltClient", () => {
  test("register returns password from structuredContent", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "a1b2c3", message: "welcome" },
    }));
    const client = makeClient();
    const { password } = await client.register("TestPilot", "solarian", "REGCODE");
    expect(password).toBe("a1b2c3");
    expect(server.calls.at(-1)!.body).toMatchObject({
      username: "TestPilot", empire: "solarian", registration_code: "REGCODE",
    });
  });

  test("login wires onReauth so session recovery re-authenticates", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "a1b2c3");
    expect(server.calls.at(-1)).toMatchObject({ tool: "spacemolt_auth", action: "login" });

    server.failNextWith({ code: "session_invalid", message: "expired" });
    await client.action("dock");
    // after failure: new session created, login replayed, dock retried
    const actions = server.calls.map((c) => c.action);
    expect(actions.filter((a) => a === "login").length).toBe(2);
    expect(actions.at(-1)).toBe("dock");
  });

  test("chat routes to spacemolt_social and carries target_id through to the transport", async () => {
    // The whole point of the fix: a `private` send must reach the game with its
    // recipient. Fails if target_id is dropped anywhere on the send path.
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    await client.action("chat", { target: "private", content: "o7", target_id: "player_42" });
    const call = server.calls.at(-1)!;
    expect(call).toMatchObject({ tool: "spacemolt_social", action: "chat" });
    expect(call.body).toMatchObject({ target: "private", content: "o7", target_id: "player_42" });
  });

  test("action validates params locally before sending", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const before = server.calls.length;
    await expect(client.action("sell", { id: "iron_ore" })).rejects.toThrow(SpacemoltError);
    expect(server.calls.length).toBe(before); // nothing sent
  });

  test("status() extracts snapshot from get_status", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 5, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false, system_id: "sys-alpha" },
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s).toEqual({
      credits: 1234, fuel: 40, maxFuel: 100, hull: 80, maxHull: 100,
      cargoUsed: 5, cargoCapacity: 50, docked: true, inTransit: false, systemId: "sys-alpha",
      dockedAt: "base-1", cargo: [],
    });
  });

  // SM-6 fix: get_status's structuredContent carries a `cargo` array --
  // ASSUMED shape (item_id, item_name, quantity, size), not independently
  // verified against a live capture the way get_system was (see client.ts's
  // CargoItemSchema comment). `size` has no consumer yet and is dropped
  // (subset, mirrors CurrentPoiInfo's has_base/base_id/fuel_price note).
  test("status() parses the cargo manifest into itemId/name/quantity", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 19, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false, system_id: "sys-alpha" },
        cargo: [
          { item_id: "gold_ore", item_name: "Gold Ore", quantity: 19, size: 1 },
        ],
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.cargo).toEqual([{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }]);
  });

  test("status() drops a cargo entry missing a required field rather than throwing", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 19, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false, system_id: "sys-alpha" },
        cargo: [
          { item_id: "gold_ore", item_name: "Gold Ore", quantity: 19 },
          { item_id: "broken_entry" }, // missing item_name/quantity
        ],
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.cargo).toEqual([{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }]);
  });

  test("status() defaults cargo to an empty array when the whole key is the wrong shape", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 0, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false, system_id: "sys-alpha" },
        cargo: "not-an-array",
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.cargo).toEqual([]);
    expect(s.credits).toBe(1234); // rest of the parse still succeeds
  });

  // Capability audit (Workflow A, 2026-07-19): get_cargo is a dedicated
  // endpoint (openapi-v2.json:35994, /api/v2/spacemolt/get_cargo) returning
  // the same V2GameState envelope as get_status -- these three tests pin
  // getCargo() to that shared StatusSchema parse (SSOT, no second schema).
  test("getCargo() parses items + used/capacity from the get_cargo response", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_cargo", () => ({
      structuredContent: {
        ship: { cargo_used: 19, cargo_capacity: 50 },
        cargo: [
          { item_id: "mining_laser_iii", item_name: "Mining Laser III", quantity: 1, size: 3 },
          { item_id: "gold_ore", item_name: "Gold Ore", quantity: 19, size: 1 },
        ],
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    expect(await client.getCargo()).toEqual({
      used: 19, capacity: 50,
      items: [
        { itemId: "mining_laser_iii", name: "Mining Laser III", quantity: 1 },
        { itemId: "gold_ore", name: "Gold Ore", quantity: 19 },
      ],
    });
    expect(server.calls.at(-1)).toMatchObject({ tool: "spacemolt", action: "get_cargo" });
  });

  test("getCargo() drops a malformed cargo entry rather than throwing, same as status()", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_cargo", () => ({
      structuredContent: {
        ship: { cargo_used: 1, cargo_capacity: 50 },
        cargo: [
          { item_id: "gold_ore", item_name: "Gold Ore", quantity: 1 },
          { item_id: "broken_entry" }, // missing item_name/quantity
        ],
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    expect(await client.getCargo()).toEqual({
      used: 1, capacity: 50,
      items: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 1 }],
    });
  });

  test("getCargo() returns undefined when the response has no structuredContent at all", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_cargo", () => ({}));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    // StatusSchema's top-level blocks all default -- an empty structuredContent
    // still parses (used:0, capacity:0, items:[]), matching status()'s own
    // tolerance for a sparse envelope; this is NOT a failure case.
    expect(await client.getCargo()).toEqual({ used: 0, capacity: 0, items: [] });
  });

  // Mining-precondition fix (2026-07-12): the executor's mine guard keys on the
  // fitted-modules set from get_status.modules[]. These pin the client mapping
  // to the VERIFIED live-probe shape (type_id/type/stats.mining_power) and the
  // UNKNOWN-vs-known distinction the guard's fail-safe depends on.
  test("status() maps the live-probe fitted modules (type_id/type/mining_power)", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: probe.get_status.structuredContent,
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.modules).toEqual([
      { typeId: "mining_laser_i", type: "mining", miningPower: 5, slot: "utility", name: "Mining Laser I" },
    ]);
  });

  // Ship tool (issue #219): the fit guard and the digest's fit section BOTH read
  // this off get_status -- there is no second get_ship fetch -- so if the ship
  // block's grid ever stops being mapped, the guard silently stops guarding.
  // The numbers are the live probe's own (cpu 2/13, power 5/26, 1 weapon /
  // 1 defense / 2 utility slots), not invented ones.
  test("status() maps the live-probe fitting grid (get_status carries it -- no get_ship fetch)", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: probe.get_status.structuredContent,
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.fit).toEqual({
      cpuUsed: 2, cpuCapacity: 13, powerUsed: 5, powerCapacity: 26,
      slots: { weapon: 1, defense: 1, utility: 2 },
    });
  });

  // A ship block with no CPU/power caps is UNKNOWN, not a zero grid: a fit read
  // as 0/0 would block every install_mod forever (a fabricated block from
  // missing data -- the failure mode every guard in the executor avoids).
  test("status() leaves fit undefined when the ship block carries no grid (UNKNOWN, not a zero grid)", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: { ship: { fuel: 10, max_fuel: 100 }, player: { credits: 5 } },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    expect((await client.status()).fit).toBeUndefined();
  });

  // Ship-details panel (operator request 2026-07-17): the dashboard's identity
  // line reads ship.name / ship.class_name off the same get_status fetch. The
  // values are the live probe's own (name "Prospect", class_name "Prospect" --
  // a stock hull keeps its class as its name).
  test("status() maps the live-probe ship identity (name + class_name)", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: probe.get_status.structuredContent,
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.shipName).toBe("Prospect");
    expect(s.shipClass).toBe("Prospect");
  });

  // Schema tolerance: a status shape predating the identity fields (or a game
  // build that drops them) must still parse, with the identity UNKNOWN --
  // never a thrown parse or a fabricated name.
  test("status() leaves ship identity undefined when the ship block carries none", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: { ship: { fuel: 10, max_fuel: 100 }, player: { credits: 5 } },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.shipName).toBeUndefined();
    expect(s.shipClass).toBeUndefined();
  });

  // Ship tool (issue #219): spacemolt_catalog is the ONE game route with no
  // action segment -- the URL is a bare `/api/v2/spacemolt_catalog`. A trailing
  // slash (the naive `${tool}/${action}` build) would 404 against the real API,
  // and this is the only place that transport shape can be caught offline.
  test("getModuleSpec() calls the BARE catalog route and reads the module's fit cost", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_catalog", "", () => ({
      structuredContent: { items: [{ cpu_usage: 6, power_usage: 14, slot: "utility" }] },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    expect(await client.getModuleSpec("mining_laser_iii")).toEqual({
      cpuUsage: 6, powerUsage: 14, slot: "utility",
    });
    const call = server.calls.find((c) => c.tool === "spacemolt_catalog");
    expect(call).toBeDefined();
    expect(call!.action).toBe(""); // bare route, no trailing path segment
    expect(call!.body).toEqual({ type: "items", id: "mining_laser_iii" });
  });

  // A non-module id (ore, a fuel cell) has no cpu_usage: UNKNOWN, so the fit
  // guard fails open rather than blocking on a row it cannot read.
  test("getModuleSpec() returns undefined for a catalog entry that is not a module", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_catalog", "", () => ({
      structuredContent: { items: [{ id: "iron_ore", base_value: 8 }] },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    expect(await client.getModuleSpec("iron_ore")).toBeUndefined();
  });

  test("status() leaves modules undefined when the block is absent (UNKNOWN, not empty)", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 0, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false, system_id: "sys-alpha" },
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    // undefined = UNKNOWN so the mine guard fails safe and skips -- distinct
    // from an empty array (known: nothing fitted), which fires the guard.
    expect(s.modules).toBeUndefined();
  });

  test("status() degrades a malformed modules block to undefined (UNKNOWN), not a thrown parse", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 0, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false, system_id: "sys-alpha" },
        modules: "not-an-array",
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s.modules).toBeUndefined();
    expect(s.credits).toBe(1234); // rest of the parse still succeeds
  });

  // F-1: get_system backs Agent.gatherSurroundings() (src/agent/agent.ts) so
  // the planner has real ids to ground a destination in. Fixture below is
  // VERIFIED 2026-07-10 (live get_system capture, SM-2 flight diagnosis --
  // see docs/STATE.md): connections/pois are objects, not bare id strings,
  // and pois carry type/class -- the previous ASSUMED shape guessed wrong on
  // both counts and the mismatch failed silently.
  test("getSystem() extracts id/name/connections/pois from the real get_system nesting", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_system", () => ({
      structuredContent: {
        action: "get_system",
        poi: { id: "grand_exchange", name: "Grand Exchange", type: "station", has_base: true, base_id: "grand_exchange_station", fuel_price: 3 },
        security_status: "Maximum Security (empire capital)",
        system: {
          id: "haven", name: "Haven", empire: "nebula",
          connections: [
            { distance: 407, name: "Market Prime", system_id: "market_prime" },
            { distance: 514, name: "Trader's Rest", system_id: "traders_rest" },
          ],
          pois: [
            { id: "haven_star", name: "Haven Star", type: "sun", class: "G5V", has_base: false },
            { id: "grand_exchange", name: "Grand Exchange", type: "station", has_base: true },
            { id: "commerce_fields", name: "Commerce Fields", type: "asteroid_belt", class: "metallic", has_base: false },
            { id: "trade_winds", name: "Trade Winds", type: "gas_cloud", class: "molecular_cloud", has_base: false },
            { id: "frostmarket_flats", name: "Frostmarket Flats", type: "ice_field", class: "kuiper", has_base: false },
          ],
        },
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const system = await client.getSystem();
    expect(system).toEqual({
      id: "haven", name: "Haven",
      connections: ["market_prime", "traders_rest"],
      // station-awareness fix: has_base is carried through onto every POI in
      // the list (not just the current-location poi). This is the ablation --
      // it fails if the get_system POI-list mapping drops has_base again, the
      // exact regression that left the planner unable to tell dockable POIs
      // apart and kept it planning `dock` in stationless systems.
      pois: [
        { id: "haven_star", name: "Haven Star", type: "sun", class: "G5V", hasBase: false },
        { id: "grand_exchange", name: "Grand Exchange", type: "station", hasBase: true },
        { id: "commerce_fields", name: "Commerce Fields", type: "asteroid_belt", class: "metallic", hasBase: false },
        { id: "trade_winds", name: "Trade Winds", type: "gas_cloud", class: "molecular_cloud", hasBase: false },
        { id: "frostmarket_flats", name: "Frostmarket Flats", type: "ice_field", class: "kuiper", hasBase: false },
      ],
      // SM-4 fix: top-level `poi` (current location) is a sibling of `system`
      // in the real payload, above -- this is the ground truth for the fix
      // (get_system's own current-location field had no consumer until now).
      // stall-watcher v4: currentPoi now also carries has_base/fuel_reserve for
      // the strand detector (fixture poi has has_base:true, no fuel_reserve).
      currentPoi: { id: "grand_exchange", name: "Grand Exchange", type: "station", hasBase: true, fuelReserve: undefined },
    });
  });

  test("getSystem() defaults missing fields rather than throwing", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_system", () => ({ structuredContent: {} }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const system = await client.getSystem();
    expect(system).toEqual({ id: null, name: null, connections: [], pois: [], currentPoi: undefined });
  });

  // stall-watcher v4: the no-progress detector reads real shapes off the live
  // probe fixture -- these tests pin the client's mapping to those exact shapes
  // so a schema drift (or a wrong assumption in the mapping) fails here, not
  // silently in production.
  test("status() maps the live-probe player.stats block, dropping the non-numeric nested category", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: probe.get_status.structuredContent,
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    // The four named progress counters plus the excluded movement ones are all
    // present as numbers on the mapped stats map.
    expect(s.stats!.credits_earned).toBe(3348);
    expect(s.stats!.ore_mined).toBe(246);
    expect(s.stats!.trades_completed).toBe(15);
    expect(s.stats!.missions_completed).toBe(0);
    expect(s.stats!.jumps_completed).toBe(103);
    expect(s.stats!.distance_traveled).toBe(39537);
    // credits_earned_taxable_by_category is an object in the live block; it must
    // be dropped, not carried as a non-number that would break the record type.
    expect(s.stats!.credits_earned_taxable_by_category as unknown).toBeUndefined();
    expect(s.fuel).toBe(0);
  });

  test("getSkills() maps the live-probe per-skill level/xp", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_skills", () => ({
      structuredContent: probe.get_skills.structuredContent,
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const skills = await client.getSkills();
    expect(skills.navigation).toEqual({ level: 3, xp: 181 });
    expect(skills.piloting).toEqual({ level: 3, xp: 427 });
    expect(skills.trading).toEqual({ level: 0, xp: 29 });
  });

  test("getAchievements() reads summary.earned from the live probe", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_achievements", () => ({
      structuredContent: probe.get_achievements.structuredContent,
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    expect(await client.getAchievements()).toBe(3);
  });

  // Mission-funnel fix (issue #147): getMissions passes the listing through
  // RAW -- the payload shape is uncaptured, so the only safe extraction is
  // the envelope-level `result` text (VERIFIED on every v2 response), with
  // stringified structuredContent as the fallback when result is absent.
  // Fails if a future edit starts parsing a guessed mission schema here or
  // drops the fallback.
  test("getMissions() returns the raw result text, falling back to stringified structuredContent", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const listing = "1. Haul 20 iron_ore to Vega Depot (template_id: haul_iron_20, reward 900cr)";
    server.setHandler("spacemolt", "get_missions", () => ({ result: listing }));
    expect(await client.getMissions()).toBe(listing);
    server.setHandler("spacemolt", "get_missions", () => ({
      structuredContent: { missions: [{ template_id: "haul_iron_20" }] },
    }));
    expect(await client.getMissions()).toBe('{"missions":[{"template_id":"haul_iron_20"}]}');
  });

  // Capability-audit fix (Workflow A, 2026-07-19): same raw pass-through as
  // getMissions/getShipyard -- ListShipsResponse exists in the vendored spec
  // but is schema-example data, never a live capture, so this stays unparsed.
  // The load-bearing assertion is the WIRING (only the list_ships handler on
  // spacemolt_ship answers, so a copy-paste calling browse_ships fails) and the
  // fallback: no result text -> stringified structuredContent, same as
  // getMissions/getShipyard.
  test("getOwnedShips() returns the raw result text, falling back to stringified structuredContent", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const listing = "Prospect (ship_id: ship_a1, active) at First Step\nExcavator (ship_id: ship_b2) at First Step";
    server.setHandler("spacemolt_ship", "list_ships", () => ({ result: listing }));
    expect(await client.getOwnedShips()).toBe(listing);
    server.setHandler("spacemolt_ship", "list_ships", () => ({
      structuredContent: { ships: [{ ship_id: "ship_a1", is_active: true }] },
    }));
    expect(await client.getOwnedShips()).toBe('{"ships":[{"ship_id":"ship_a1","is_active":true}]}');
  });

  // Active-mission visibility fix (issue #170): same raw pass-through as
  // getMissions. The load-bearing assertion is the WIRING -- only the
  // get_active_missions handler answers here, so a copy-paste that still
  // calls get_missions fails, not just a wrong extraction.
  test("getActiveMissions() calls get_active_missions and returns the raw result text", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const listing = "1. Haul 20 iron_ore to Vega Depot (id: m-77, expires tick 9400)";
    server.setHandler("spacemolt", "get_active_missions", () => ({ result: listing }));
    expect((await client.getActiveMissions()).text).toBe(listing);
    server.setHandler("spacemolt", "get_active_missions", () => ({
      structuredContent: { missions: [{ id: "m-77" }] },
    }));
    expect((await client.getActiveMissions()).text).toBe('{"missions":[{"id":"m-77"}]}');
    // PR #175 revision: the captured zero-active envelope (result
    // "No active missions." + structuredContent.missions.active = []) maps
    // to text "" -- the non-empty English text is NOT a listing.
    server.setHandler("spacemolt", "get_active_missions", () => probe.get_active_missions);
    expect((await client.getActiveMissions()).text).toBe("");
  });

  // Mission-progress bridge (issue #291): the parsed second read off the same
  // envelope. Shape citation: openapi-v2.json V2GameState.missions.active --
  // mission_id, title, accepted_at, expires_in_ticks, percent_complete,
  // objectives[] with item_id/item_name/description/required/current/in_cargo/
  // completed/target_base. No live
  // capture of a non-empty active list exists yet, so the fixture below is
  // built to that vendored shape (evidence precedence: reference > assumption).
  test("getActiveMissions() parses the openapi-shaped missions.active array into structured facts", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const listing = "1. Titanium Extraction Contract: mine 20 titanium_ore (id: m-titanium-1)";
    server.setHandler("spacemolt", "get_active_missions", () => ({
      result: listing,
      structuredContent: {
        missions: {
          active: [{
            mission_id: "m-titanium-1",
            template_id: "mining_titanium",
            title: "Titanium Extraction Contract",
            accepted_at: "2026-07-14T12:00:00Z",
            expires_in_ticks: 9400,
            percent_complete: 0,
            objectives: [{
              type: "mine",
              description: "Mine 20 Titanium Ore",
              item_id: "titanium_ore",
              required: 20,
              current: 0,
              in_cargo: 0,
              completed: false,
              target_base: "gold_run_station",
            }],
          }],
          max_missions: 5,
        },
      },
    }));
    const res = await client.getActiveMissions();
    expect(res.text).toBe(listing);
    expect(res.missions).toEqual([{
      missionId: "m-titanium-1",
      title: "Titanium Extraction Contract",
      acceptedAt: "2026-07-14T12:00:00Z",
      expiresInTicks: 9400,
      percentComplete: 0,
      objectives: [{
        type: "mine",
        itemId: "titanium_ore",
        itemName: undefined,
        description: "Mine 20 Titanium Ore",
        required: 20,
        current: 0,
        inCargo: 0,
        completed: false,
        targetBase: "gold_run_station",
        systemId: undefined,
      }],
    }]);
  });

  // Mission-progress bridge (issue #291), schema tolerance: an active array
  // whose entries don't parse (a live shape divergence) must degrade to
  // missions:undefined with the raw text still flowing -- the parse must
  // never take down the #170 listing.
  test("getActiveMissions() degrades to missions:undefined on an unparseable active array, text intact", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const listing = "1. Some mission";
    server.setHandler("spacemolt", "get_active_missions", () => ({
      result: listing,
      structuredContent: { missions: { active: ["not-an-object"], max_missions: 5 } },
    }));
    const res = await client.getActiveMissions();
    expect(res.text).toBe(listing);
    expect(res.missions).toBeUndefined();
  });

  // Mission-progress bridge (issue #291) / mining preconditions (issue #188):
  // get_poi's deposit list. Shape citation: openapi-v2.json GetPOIResponse
  // branch 0's top-level resources[] (resource_id required, supported_power
  // OPTIONAL per entry) and the sibling poi.id; branch 1 (in transit) has no
  // resources.
  test("getPoiDeposits() returns poi id + deposits with supported_power, undefined when the response has none", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    server.setHandler("spacemolt", "get_poi", () => ({
      structuredContent: {
        poi: { id: "gold_run_fields", name: "Gold Run Mineral Fields", type: "asteroid_belt" },
        resources: [
          { resource_id: "palladium_ore", name: "Palladium Ore", remaining: 500, richness: 3, supported_power: 24 },
          // supported_power is optional in the vendored spec -- an entry
          // without it must still parse, with supportedPower undefined
          { resource_id: "vanadium_ore", name: "Vanadium Ore", remaining: 200, richness: 2 },
        ],
      },
    }));
    expect(await client.getPoiDeposits()).toEqual({
      poiId: "gold_run_fields",
      deposits: [
        { resourceId: "palladium_ore", supportedPower: 24 },
        { resourceId: "vanadium_ore", supportedPower: undefined },
      ],
    });
    // the in-transit response branch carries no resources array -> undefined
    server.setHandler("spacemolt", "get_poi", () => ({
      structuredContent: { action: "get_poi", in_transit: true, ticks_remaining: 3 },
    }));
    expect(await client.getPoiDeposits()).toBeUndefined();
    // a response with resources but no poi block still yields the deposits
    // (poiId undefined -> the learned check fails open, the power check runs)
    server.setHandler("spacemolt", "get_poi", () => ({
      structuredContent: { resources: [{ resource_id: "gold_ore", name: "Gold Ore", remaining: 10, richness: 1, supported_power: 5 }] },
    }));
    expect(await client.getPoiDeposits()).toEqual({
      poiId: undefined,
      deposits: [{ resourceId: "gold_ore", supportedPower: 5 }],
    });
  });

  // Capability-audit follow-up (2026-07-19): get_location's parsed subset --
  // nearby-entity counts and transit_* fields. Shape is ASSUMED from the
  // openapi-v2.json example (no live get_location capture exists), so this
  // fixture is hand-built from that reference, not a probe replay.
  describe("getLocation()", () => {
    test("returns nearby-entity counts and transit fields when present", async () => {
      server = startFakeServer();
      const client = makeClient();
      await client.login("TestPilot", "pw");
      server.setHandler("spacemolt", "get_location", () => ({
        structuredContent: {
          location: {
            poi_type: "asteroid_belt",
            nearby_player_count: 2,
            nearby_pirate_count: 1,
            nearby_empire_npc_count: 0,
            in_transit: false,
          },
        },
      }));
      expect(await client.getLocation()).toEqual({
        poiType: "asteroid_belt",
        nearbyPlayerCount: 2,
        nearbyPirateCount: 1,
        nearbyEmpireNpcCount: 0,
        inTransit: false,
        transitDestPoiName: undefined,
        transitArrivalTick: undefined,
      });
    });

    test("returns undefined when nothing is worth telling the planner (no nearby entities, not in transit)", async () => {
      server = startFakeServer();
      const client = makeClient();
      await client.login("TestPilot", "pw");
      server.setHandler("spacemolt", "get_location", () => ({
        structuredContent: {
          location: { poi_type: "station", nearby_player_count: 0, nearby_pirate_count: 0, in_transit: false },
        },
      }));
      expect(await client.getLocation()).toBeUndefined();
    });

    test("surfaces transit destination + arrival tick while in transit", async () => {
      server = startFakeServer();
      const client = makeClient();
      await client.login("TestPilot", "pw");
      server.setHandler("spacemolt", "get_location", () => ({
        structuredContent: {
          location: { in_transit: true, transit_dest_poi_name: "Grand Exchange", transit_arrival_tick: 42 },
        },
      }));
      expect(await client.getLocation()).toEqual({
        poiType: undefined,
        nearbyPlayerCount: undefined,
        nearbyPirateCount: undefined,
        nearbyEmpireNpcCount: undefined,
        inTransit: true,
        transitDestPoiName: "Grand Exchange",
        transitArrivalTick: 42,
      });
    });

    test("degrades to undefined on an unparseable response, never throws", async () => {
      server = startFakeServer();
      const client = makeClient();
      await client.login("TestPilot", "pw");
      server.setHandler("spacemolt", "get_location", () => ({
        structuredContent: { location: "not-an-object" },
      }));
      expect(await client.getLocation()).toBeUndefined();
    });
  });

  test("getSystem() surfaces the current POI has_base/fuel_reserve (strand inputs) from the live probe", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_system", () => ({
      structuredContent: probe.get_system.structuredContent,
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const system = await client.getSystem();
    // The stranded location: no base, zero fuel reserve -> nowhere to refuel.
    expect(system.currentPoi).toMatchObject({ id: "moonshadow_iii", hasBase: false, fuelReserve: 0 });
  });

  // Buyable-here surfacing (issue #93): getMarket calls view_market and parses
  // the envelope's result text against the ONE captured shape (the MCP probe's
  // 482-row Market Prime Exchange listing -- parseMarketText's own oracle
  // tests live in mcp-text-parser.test.ts). The load-bearing assertions here
  // are the WIRING (only the view_market handler on the spacemolt_market tool
  // answers, so a copy-paste calling another query fails) and the
  // no-guessed-schema contract: a response with no result text -- including a
  // structuredContent-only one -- yields zero rows rather than a parse through
  // an invented structured schema.
  test("getMarket() calls view_market and parses the captured listing text; no result text -> no rows", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const marketText = mcpProbe.read_only_calls["spacemolt_market/view_market"]!.raw.result.content[0]!.text;
    server.setHandler("spacemolt_market", "view_market", () => ({ result: marketText }));
    const rows = await client.getMarket();
    expect(rows.length).toBe(482);
    expect(rows.find((r) => r.itemId === "iron_ore")).toEqual({ itemId: "iron_ore", bestBuy: 11, buyQty: 200 });
    server.setHandler("spacemolt_market", "view_market", () => ({
      structuredContent: { items: [{ item_id: "iron_ore" }] },
    }));
    expect(await client.getMarket()).toEqual([]);
  });

  test("notifications() polls get_notifications", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_notifications", () => ({
      notifications: [
        { id: "n1", type: "combat", msg_type: "combat_update", timestamp: "2026-07-10T00:00:00Z", data: {} },
      ],
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const notes = await client.notifications();
    expect(notes.length).toBe(1);
    expect(notes[0]!.type).toBe("combat");
  });
});
