import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { REGISTRY, getAction } from "../src/registry/actions";
import { PlanSchema } from "../src/registry/plan";

describe("registry", () => {
  test("every action fully defined, no duplicate names", () => {
    const names = REGISTRY.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const a of REGISTRY) {
      expect(a.tool.length).toBeGreaterThan(0);
      expect(a.eventLabel.length).toBeGreaterThan(0);
      expect(["mutation", "query"]).toContain(a.kind);
    }
  });

  test("getAction returns def and throws on unknown", () => {
    expect(getAction("mine").tool).toBe("spacemolt");
    expect(() => getAction("warp_drive")).toThrow();
  });

  test("core v1 actions present", () => {
    for (const n of ["travel", "jump", "dock", "undock", "mine", "sell", "buy",
      "refuel", "repair", "attack", "scan", "get_status", "get_system",
      "get_poi", "find_route", "get_notifications"]) {
      expect(() => getAction(n)).not.toThrow();
    }
  });

  // Purchase discovery (issue #220). Breakage caught: a params schema that lets
  // a malformed estimate_purchase reach the game (quantity 0 / fractional /
  // missing, empty item_id) and burns the free query on a 400, and a kind that
  // drifts to "mutation" -- which would make the query PLANNABLE (PlanSchema
  // admits mutations) and spend a tick on a read. The spec is the authority for
  // both: /api/v2/spacemolt_market/estimate_purchase carries required
  // [item_id, quantity], quantity minimum 1, and NO x-is-mutation.
  test("estimate_purchase is a free query requiring item_id and quantity >= 1", () => {
    const a = getAction("estimate_purchase");
    expect(a.tool).toBe("spacemolt_market");
    expect(a.kind).toBe("query");
    expect(a.params.safeParse({ item_id: "deep_core_extractor_mk_i", quantity: 1 }).success).toBe(true);
    expect(a.params.safeParse({ item_id: "Deep Core Extractor Mk I", quantity: 5 }).success).toBe(true);
    expect(a.params.safeParse({ item_id: "x", quantity: 0 }).success).toBe(false);
    expect(a.params.safeParse({ item_id: "x", quantity: 1.5 }).success).toBe(false);
    expect(a.params.safeParse({ item_id: "", quantity: 1 }).success).toBe(false);
    expect(a.params.safeParse({ item_id: "x" }).success).toBe(false);
    expect(a.params.safeParse({ item_id: "x", quantity: 1, station_id: "s" }).success).toBe(false);
  });

  // No-buyer remedy #1 (capability audit, Workflow A 2026-07-19): cancel_order
  // reclaims escrow from a dead create_sell_order/create_buy_order. VERIFIED
  // against the vendored OpenAPI (openapi-v2.json:99291-99704): a mutation
  // (x-is-mutation true), properties [order_id, order_ids], required [] --
  // both optional on our side too, matching the API exactly.
  test("cancel_order is a mutation accepting order_id, order_ids (max 50), or neither", () => {
    const a = getAction("cancel_order");
    expect(a.tool).toBe("spacemolt_market");
    expect(a.kind).toBe("mutation");
    expect(a.params.safeParse({}).success).toBe(true); // API requires nothing
    expect(a.params.safeParse({ order_id: "abc123" }).success).toBe(true);
    expect(a.params.safeParse({ order_id: "all" }).success).toBe(true);
    expect(a.params.safeParse({ order_ids: ["a", "b", "c"] }).success).toBe(true);
    expect(a.params.safeParse({ order_ids: Array.from({ length: 50 }, (_, i) => `o${i}`) }).success).toBe(true);
    expect(a.params.safeParse({ order_ids: Array.from({ length: 51 }, (_, i) => `o${i}`) }).success).toBe(false);
    expect(a.params.safeParse({ order_id: "abc123", extra: 1 }).success).toBe(false); // strict
  });

  // Ship-to-ship rescue (issue #233): refuel was registered name-only
  // (params:none), so `refuel target=<player>` -- the transfer that powers
  // mission-runner.md's distress-rescue economy -- could never reach the
  // game. VERIFIED against the vendored OpenAPI
  // (openapi-v2.json:44481-44510, operationId spacemolt_refuel): properties
  // [id, quantity, target], no required array (all three optional).
  test("refuel accepts id/quantity/target (ship-to-ship transfer + fleet status), or none", () => {
    const a = getAction("refuel");
    expect(a.tool).toBe("spacemolt");
    expect(a.kind).toBe("mutation");
    expect(a.params.safeParse({}).success).toBe(true); // station/cargo auto-refuel, no args
    expect(a.params.safeParse({ id: "fuel_cell", quantity: 3 }).success).toBe(true);
    expect(a.params.safeParse({ target: "some_player" }).success).toBe(true); // ship-to-ship rescue
    expect(a.params.safeParse({ target: "fleet" }).success).toBe(true); // fleet fuel status
    expect(a.params.safeParse({ quantity: 0 }).success).toBe(false); // domain floor
    expect(a.params.safeParse({ quantity: 1.5 }).success).toBe(false);
    expect(a.params.safeParse({ target: "p", extra: 1 }).success).toBe(false); // strict
  });

  // No-buyer remedy #2 (capability audit, Workflow A 2026-07-19): a query
  // over the pilot's faction trade-intel pool -- reads recorded prices, not a
  // live market call. VERIFIED against the vendored OpenAPI
  // (openapi-v2.json:97637-97789): no x-is-mutation -> query, properties
  // [base_id, item_id, limit, offset, source_faction_id, station_name],
  // required []. kind:"query" means PlanSchema cannot admit it as a plan
  // step -- see the "queries never become plan steps" test in this file.
  test("query_trade_intel is a free query with bounded limit/offset", () => {
    const a = getAction("query_trade_intel");
    expect(a.tool).toBe("spacemolt_intel");
    expect(a.kind).toBe("query");
    expect(a.params.safeParse({}).success).toBe(true);
    expect(a.params.safeParse({ base_id: "confederacy_central_command" }).success).toBe(true);
    expect(a.params.safeParse({ item_id: "palladium_ore", limit: 50, offset: 0 }).success).toBe(true);
    expect(a.params.safeParse({ limit: 0 }).success).toBe(false); // spec minimum 1
    expect(a.params.safeParse({ limit: 51 }).success).toBe(false); // spec maximum 50
    expect(a.params.safeParse({ offset: -1 }).success).toBe(false);
    expect(a.params.safeParse({ station_name: "s", bogus: true }).success).toBe(false); // strict
  });

  // Explorer's second rung (issue #222). VERIFIED against the vendored OpenAPI
  // (docs/game-reference/upstream/openapi-v2.json:32681-32706): x-is-mutation
  // true, properties [enable, quantity], required []. Breakage caught: a
  // kind drift to "query" would make cloak un-plannable (PlanSchema admits
  // only mutations), and a strict-schema regression would let an unrelated
  // field pass silently.
  test("cloak is a mutation with optional enable/quantity, no other fields", () => {
    const a = getAction("cloak");
    expect(a.tool).toBe("spacemolt");
    expect(a.kind).toBe("mutation");
    expect(a.params.safeParse({}).success).toBe(true);
    expect(a.params.safeParse({ enable: true }).success).toBe(true);
    expect(a.params.safeParse({ quantity: 1 }).success).toBe(true);
    expect(a.params.safeParse({ enable: false, quantity: 0 }).success).toBe(true);
    expect(a.params.safeParse({ enable: "yes" }).success).toBe(false);
    expect(a.params.safeParse({ enable: true, bogus: 1 }).success).toBe(false); // strict
  });

  // get_map (issue #222). VERIFIED against openapi-v2.json:37237-37256: no
  // x-is-mutation -> query, properties [system_id], required []. Breakage
  // caught: a kind drift to "mutation" would burn a tick on a free galaxy-map
  // read; a required system_id would break the "all systems" bare call the
  // spec describes.
  test("get_map is a free query with an optional system_id", () => {
    const a = getAction("get_map");
    expect(a.tool).toBe("spacemolt");
    expect(a.kind).toBe("query");
    expect(a.params.safeParse({}).success).toBe(true);
    expect(a.params.safeParse({ system_id: "36_ophiuchi" }).success).toBe(true);
    expect(a.params.safeParse({ system_id: 5 }).success).toBe(false);
  });

  // search_systems (issue #222). VERIFIED against openapi-v2.json:46203-46225:
  // no x-is-mutation -> query, properties [text], required [text]. Breakage
  // caught: an optional `text` would let a malformed empty-body call reach
  // the game; a kind drift to "mutation" would burn a tick on a free lookup.
  test("search_systems is a free query requiring text", () => {
    const a = getAction("search_systems");
    expect(a.tool).toBe("spacemolt");
    expect(a.kind).toBe("query");
    expect(a.params.safeParse({ text: "Sol" }).success).toBe(true);
    expect(a.params.safeParse({}).success).toBe(false);
    expect(a.params.safeParse({ text: "" }).success).toBe(false);
    expect(a.params.safeParse({ text: "Sol", extra: 1 }).success).toBe(false); // strict
  });

  // survey_system (issue #222). VERIFIED against openapi-v2.json:47329-47342:
  // x-is-mutation true, empty request schema. Breakage caught: a kind drift
  // to "query" would make it un-plannable, and any params leaking in would
  // reject the empty-body call the game actually expects.
  test("survey_system is a no-param mutation", () => {
    const a = getAction("survey_system");
    expect(a.tool).toBe("spacemolt");
    expect(a.kind).toBe("mutation");
    expect(a.params.safeParse({}).success).toBe(true);
    expect(a.params.safeParse({ id: "x" }).success).toBe(false); // strict, no params exist
  });

  // Intel & espionage, the rest of the group (issue #229). VERIFIED against
  // the vendored OpenAPI (docs/game-reference/upstream/openapi-v2.json) and
  // test/fixtures/openapi-slim.json:1387-1451 -- see the registry comments
  // for exact line anchors. Breakage caught: a wrong kind on espionage/
  // scan_poi/submit_intel/submit_trade_intel would make a rate-limited
  // mutation look like a free query (or vice versa), and a permissive schema
  // on scan_poi/submit_intel/submit_trade_intel would let a malformed
  // (missing poi_id, empty systems/stations) call burn a tick on a 400.
  test("espionage, intel_status, trade_intel_status take no params and have the right kind", () => {
    for (const [name, kind] of [
      ["espionage", "mutation"],
      ["intel_status", "query"],
      ["trade_intel_status", "query"],
    ] as const) {
      const a = getAction(name);
      expect(a.tool).toBe("spacemolt_intel");
      expect(a.kind).toBe(kind);
      expect(a.params.safeParse({}).success).toBe(true);
      expect(a.params.safeParse({ extra: 1 }).success).toBe(false); // strict
    }
  });

  test("query_intel is a free query with bounded limit/offset", () => {
    const a = getAction("query_intel");
    expect(a.tool).toBe("spacemolt_intel");
    expect(a.kind).toBe("query");
    expect(a.params.safeParse({}).success).toBe(true);
    expect(a.params.safeParse({ system_name: "alpha", source_faction_id: "f1" }).success).toBe(true);
    expect(a.params.safeParse({ limit: 100, offset: 0 }).success).toBe(true);
    expect(a.params.safeParse({ limit: 0 }).success).toBe(false); // spec minimum 1
    expect(a.params.safeParse({ limit: 101 }).success).toBe(false); // spec maximum 100
    expect(a.params.safeParse({ offset: -1 }).success).toBe(false);
    expect(a.params.safeParse({ system_id: "s", bogus: true }).success).toBe(false); // strict
  });

  test("scan_poi is a mutation requiring a non-empty poi_id", () => {
    const a = getAction("scan_poi");
    expect(a.tool).toBe("spacemolt_intel");
    expect(a.kind).toBe("mutation");
    expect(a.params.safeParse({ poi_id: "sol_central" }).success).toBe(true);
    expect(a.params.safeParse({}).success).toBe(false); // spec requires poi_id
    expect(a.params.safeParse({ poi_id: "" }).success).toBe(false);
    expect(a.params.safeParse({ poi_id: "sol_central", extra: 1 }).success).toBe(false); // strict
  });

  test("submit_intel and submit_trade_intel are mutations requiring a non-empty array", () => {
    const intel = getAction("submit_intel");
    expect(intel.tool).toBe("spacemolt_intel");
    expect(intel.kind).toBe("mutation");
    expect(intel.params.safeParse({ systems: [{ system_id: "sys_xxx", name: "Alpha Centauri" }] }).success).toBe(true);
    expect(intel.params.safeParse({}).success).toBe(false); // spec requires systems
    expect(intel.params.safeParse({ systems: [] }).success).toBe(false);
    expect(intel.params.safeParse({ systems: [{}], extra: 1 }).success).toBe(false); // strict

    const trade = getAction("submit_trade_intel");
    expect(trade.tool).toBe("spacemolt_intel");
    expect(trade.kind).toBe("mutation");
    expect(trade.params.safeParse({ stations: [{ base_id: "confederacy_central_command" }] }).success).toBe(true);
    expect(trade.params.safeParse({}).success).toBe(false); // spec requires stations
    expect(trade.params.safeParse({ stations: [] }).success).toBe(false);
  });

  describe("social actions", () => {
    test("chat requires target and content, target_id optional", () => {
      const chat = getAction("chat");
      expect(chat.tool).toBe("spacemolt_social");
      const shape = (chat.params as z.ZodObject<z.ZodRawShape>).shape;
      expect(shape.target!.isOptional()).toBe(false);
      expect(shape.content!.isOptional()).toBe(false);
      expect(shape.target_id!.isOptional()).toBe(true);
    });

    // VERIFIED 2026-07-12 (live probe): the pilot sent `chat target:"broadcast"`
    // and the game rejected it ("Invalid chat channel"), so no message sent.
    // The permissive z.string() was the bug -- these guard against a regression
    // back to it (a permissive target would let "broadcast" through here).
    test("VERIFIED 2026-07-12: chat rejects an off-channel target and names the valid channels", () => {
      const chat = getAction("chat");
      const bad = chat.params.safeParse({ target: "broadcast", content: "hi" });
      expect(bad.success).toBe(false);
      if (bad.success) throw new Error("unreachable");
      const msg = JSON.stringify(bad.error.issues);
      for (const ch of ["local", "system", "faction", "private", "emergency"]) {
        expect(msg).toContain(ch);
      }
    });

    test("chat accepts a real channel and carries target_id for a directed send", () => {
      const chat = getAction("chat");
      expect(chat.params.safeParse({ target: "system", content: "hi" }).success).toBe(true);
      const priv = chat.params.safeParse({ target: "private", content: "psst", target_id: "player_42" });
      expect(priv.success).toBe(true);
      if (!priv.success) throw new Error("unreachable");
      expect(priv.data).toMatchObject({ target: "private", target_id: "player_42" });
    });

    test("captains_log_add requires content and rejects an oversized entry", () => {
      const log = getAction("captains_log_add");
      expect(log.tool).toBe("spacemolt_social");
      expect(() => log.params.parse({ content: "a".repeat(2000) })).not.toThrow();
      expect(() => log.params.parse({ content: "a".repeat(2001) })).toThrow();
      expect(() => log.params.parse({ content: "" })).toThrow();
    });
  });

  // Crafting & refining loop (issue #221). VERIFIED against the vendored
  // OpenAPI (docs/game-reference/upstream/openapi-v2.json:33612 craft,
  // :44015 recycle -- both required []): the API leaves `id` (the recipe id)
  // optional, but we require it stricter than the spec because an id-less
  // craft/recycle call only lists or cancels queued jobs, not the "queue a
  // job" use case this registers. Breakage this catches: a regression back to
  // an optional id would let a bare craft() reach the game as a silent
  // queue-list instead of a compile-time-caught mistake in the planner's own
  // step.
  describe("crafting & refining loop (issue #221)", () => {
    test("craft is a mutation requiring id, everything else optional", () => {
      const craft = getAction("craft");
      expect(craft.tool).toBe("spacemolt");
      expect(craft.kind).toBe("mutation");
      expect(craft.params.safeParse({ id: "iron_plates" }).success).toBe(true);
      expect(craft.params.safeParse({
        id: "iron_plates", quantity: 10, deliver_to: "storage", source: "storage",
        facility_id: "fac_1", dry_run: true,
      }).success).toBe(true);
      expect(craft.params.safeParse({}).success).toBe(false); // id required on our side
      expect(craft.params.safeParse({ id: "iron_plates", quantity: 0 }).success).toBe(false);
      expect(craft.params.safeParse({ id: "iron_plates", jobs: [] }).success).toBe(false); // strict, unsupported here
    });

    test("recycle is a mutation requiring id, everything else optional", () => {
      const recycle = getAction("recycle");
      expect(recycle.tool).toBe("spacemolt");
      expect(recycle.kind).toBe("mutation");
      expect(recycle.params.safeParse({ id: "iron_plates" }).success).toBe(true);
      expect(recycle.params.safeParse({ id: "iron_plates", quantity: 5 }).success).toBe(true);
      expect(recycle.params.safeParse({}).success).toBe(false);
      expect(recycle.params.safeParse({ id: "iron_plates", quantity: -1 }).success).toBe(false);
    });

    // Symmetric with the existing withdraw registration: item_id + quantity
    // required, matching the one real use case (deposit a specific item from
    // cargo into personal storage before crafting).
    test("storage.deposit is a mutation requiring item_id and quantity", () => {
      const deposit = getAction("deposit");
      expect(deposit.tool).toBe("spacemolt_storage");
      expect(deposit.kind).toBe("mutation");
      expect(deposit.params.safeParse({ item_id: "iron_ore", quantity: 5 }).success).toBe(true);
      expect(deposit.params.safeParse({ item_id: "iron_ore" }).success).toBe(false); // quantity required
      expect(deposit.params.safeParse({ quantity: 5 }).success).toBe(false); // item_id required
      expect(deposit.params.safeParse({ item_id: "iron_ore", quantity: 0 }).success).toBe(false);
      expect(deposit.params.safeParse({ item_id: "iron_ore", quantity: 5, target: "faction" }).success).toBe(false); // strict
    });

    // kind:"query" means PlanSchema cannot admit it as a plan step -- same
    // contract as estimate_purchase/query_trade_intel above.
    test("storage.view is a free query, both params optional", () => {
      const view = getAction("view");
      expect(view.tool).toBe("spacemolt_storage");
      expect(view.kind).toBe("query");
      expect(view.params.safeParse({}).success).toBe(true);
      expect(view.params.safeParse({ station_id: "st_1", target: "faction" }).success).toBe(true);
      expect(view.params.safeParse({ station_id: "st_1", bogus: true }).success).toBe(false); // strict
    });
  });
});

describe("plan schema", () => {
  test("accepts a valid mining plan", () => {
    const plan = PlanSchema.parse({
      goal: "fill cargo with ore and sell it",
      steps: [
        { action: "travel", params: { id: "poi-belt-1" } },
        { action: "mine", params: {}, until: "cargo_full" },
        { action: "dock", params: {} },
        { action: "sell", params: { id: "iron_ore", quantity: 50 } },
      ],
    });
    expect(plan.steps.length).toBe(4);
  });

  // Capability-audit fix (Workflow A, 2026-07-19): switch_ship is the
  // activation half of a bought hull -- a registry entry alone proves nothing
  // if PlanSchema (derived from REGISTRY) rejects the step it produces.
  test("accepts a switch_ship step", () => {
    const plan = PlanSchema.parse({
      goal: "activate the ship I just bought",
      steps: [{ action: "switch_ship", params: { id: "ship_a1" } }],
    });
    expect(plan.steps.length).toBe(1);
  });

  test("rejects queries as plan steps", () => {
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "get_status", params: {} }] })
    ).toThrow();
    // Mission-funnel fix (issue #147), the other side of the invariant: the
    // digest no longer instructs planning get_missions BECAUSE PlanSchema
    // rejects query steps -- if a future change quietly admitted queries, the
    // producer-side fix's premise would be gone. Named explicitly since this
    // exact rejection produced 11 planner_errors/48h before the fix.
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "get_missions", params: {} }] })
    ).toThrow();
    // Capability-audit fix (Workflow A, 2026-07-19): list_ships is kind:"query"
    // (does not require docking, costs no tick) -- if it were ever mislabeled
    // "mutation" the planner could plan it directly and gatherOwnedShips'
    // producer-side fetch would go stale.
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "list_ships", params: {} }] })
    ).toThrow();
    // query_trade_intel (capability audit, Workflow A 2026-07-19): a query,
    // same invariant -- registering it must never make it plannable.
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "query_trade_intel", params: {} }] })
    ).toThrow();
    // Explorer's second rung (issue #222): get_map and search_systems are
    // both kind:"query" -- if either drifted to "mutation" the planner could
    // plan a step meant to be a harness-side gather, same invariant as above.
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "get_map", params: {} }] })
    ).toThrow();
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "search_systems", params: { text: "Sol" } }] })
    ).toThrow();
    // Intel & espionage queries (issue #229): same invariant for the 3
    // query-kind actions in this group -- registering them must never make
    // them plannable.
    for (const name of ["intel_status", "query_intel", "trade_intel_status"]) {
      expect(() =>
        PlanSchema.parse({ goal: "x", steps: [{ action: name, params: {} }] })
      ).toThrow();
    }
  });

  // Explorer's second rung (issue #222): cloak and survey_system are the two
  // mutations this epic adds -- both must be usable plan steps, the same
  // proof cancel_order's admission test gives above.
  test("cloak and survey_system are usable plan steps (derived automatically from REGISTRY)", () => {
    const plan = PlanSchema.parse({
      goal: "slip past the pirates and scan for a deep-core deposit",
      steps: [
        { action: "cloak", params: { enable: true } },
        { action: "survey_system", params: {} },
      ],
    });
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0]).toEqual({ action: "cloak", params: { enable: true } });
  });

  // Intel & espionage mutations (issue #229): the plannable half of the
  // group -- a plan using each must validate and admit into PlanSchema,
  // matching cancel_order's admission below.
  test("espionage, scan_poi, submit_intel, submit_trade_intel are usable plan steps", () => {
    const plan = PlanSchema.parse({
      goal: "run the faction's intel loop",
      steps: [
        { action: "scan_poi", params: { poi_id: "sol_central" } },
        { action: "espionage", params: {} },
        { action: "submit_intel", params: { systems: [{ system_id: "sys_xxx", name: "Alpha Centauri" }] } },
        { action: "submit_trade_intel", params: { stations: [{ base_id: "confederacy_central_command" }] } },
      ],
    });
    expect(plan.steps.length).toBe(4);
  });

  // cancel_order (capability audit, Workflow A 2026-07-19): the no-buyer
  // remedy's plannable half -- a plan using it must validate and admit into
  // PlanSchema, matching create_sell_order/create_buy_order's admission above.
  test("cancel_order is a usable plan step (derived automatically from REGISTRY)", () => {
    const plan = PlanSchema.parse({
      goal: "reclaim escrow from a dead sell order and relist elsewhere",
      steps: [
        { action: "cancel_order", params: { order_id: "abc123" } },
        { action: "travel", params: { id: "poi-belt-2" } },
        { action: "create_sell_order", params: { item_id: "palladium_ore", quantity: 28 } },
      ],
    });
    expect(plan.steps.length).toBe(3);
    expect(plan.steps[0]).toEqual({ action: "cancel_order", params: { order_id: "abc123" } });
  });

  test("rejects unknown action and bad params", () => {
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "teleport", params: {} }] })
    ).toThrow();
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "sell", params: { id: "iron_ore" } }] })
    ).toThrow(); // sell requires quantity
  });

  test("rejects empty and oversized plans", () => {
    expect(() => PlanSchema.parse({ goal: "x", steps: [] })).toThrow();
    const steps = Array.from({ length: 31 }, () => ({ action: "mine", params: {} }));
    expect(() => PlanSchema.parse({ goal: "x", steps })).toThrow();
  });

  test("chat and captains_log_add are usable plan steps (derived automatically from REGISTRY)", () => {
    const plan = PlanSchema.parse({
      goal: "greet a nearby trader and log the encounter",
      steps: [
        { action: "chat", params: { target: "local", content: "o7 fellow traveler" } },
        { action: "captains_log_add", params: { content: "Made first contact near the Rusty Belt." } },
      ],
    });
    expect(plan.steps.length).toBe(2);
  });

  test("rejects a captains_log_add step over the length guard", () => {
    expect(() =>
      PlanSchema.parse({
        goal: "x",
        steps: [{ action: "captains_log_add", params: { content: "a".repeat(2001) } }],
      })
    ).toThrow();
  });

  test("VERIFIED 2026-07-12: an off-channel chat step is rejected at plan admission", () => {
    // The PlanSchema seam is where a whole plan is admitted (agent.ts parses
    // planner output here). An illegal channel dies here, never reaching the
    // game -- the fix for messages silently vanishing.
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "chat", params: { target: "broadcast", content: "hi" } }] })
    ).toThrow();
  });

  test("accepts travel_to even though it isn't a registry action", () => {
    const plan = PlanSchema.parse({
      goal: "go explore",
      steps: [{ action: "travel_to", params: { system_id: "sys-9" } }],
    });
    expect(plan.steps[0]).toEqual({ action: "travel_to", params: { system_id: "sys-9" } });
  });

  test("rejects travel_to with the wrong param shape", () => {
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "travel_to", params: { id: "sys-9" } }] })
    ).toThrow(); // wrong key: must be system_id
  });
});
