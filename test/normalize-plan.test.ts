import { describe, expect, test } from "bun:test";
import { admitPlan, normalizeGiftTargets, normalizePlanItems, normalizePlanLocations, type FleetPilot } from "../src/agent/normalize-plan";
import type { Surroundings } from "../src/planner/types";
import type { Plan } from "../src/registry/plan";

// SM-3 flight diagnosis, VERIFIED 2026-07-10 (live): planner produced
// `travel {id: "Commerce Fields"}` -- the digest's display NAME -- where the
// game requires the snake_case id "commerce_fields". Game rejected with
// "Unknown destination: Commerce Fields". This fixture is that case verbatim.
const commerceFieldsSurroundings: Surroundings = {
  systemId: "sys-1",
  systemName: "Alpha Prime",
  connections: ["sys-2"],
  pois: [{ id: "commerce_fields", name: "Commerce Fields", type: "asteroid_belt", class: "metallic" }],
  dockedAt: "base-1",
};

describe("normalizePlanLocations", () => {
  test("VERIFIED 2026-07-10: rewrites the display name to the id and reports the rewrite", () => {
    const plan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "Commerce Fields" } }] };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan.steps[0]).toEqual({ action: "travel", params: { id: "commerce_fields" } });
    expect(result.rewrites).toEqual([
      { step: 0, action: "travel", param: "id", from: "Commerce Fields", to: "commerce_fields" },
    ]);
  });

  test("an exact id match passes through untouched with no rewrites", () => {
    const plan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "commerce_fields" } }] };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan).toEqual(plan);
    expect(result.rewrites).toEqual([]);
  });

  test("jump.id resolves against surroundings.connections (case-insensitive id match)", () => {
    const plan: Plan = { goal: "explore", steps: [{ action: "jump", params: { id: "SYS-2" } }] };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rewrites).toEqual([{ step: 0, action: "jump", param: "id", from: "SYS-2", to: "sys-2" }]);
  });

  test("travel_to.system_id resolves the same way as jump.id", () => {
    const plan: Plan = { goal: "explore", steps: [{ action: "travel_to", params: { system_id: "sys-2" } }] };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rewrites).toEqual([]); // already exact
  });

  test("an unresolvable ref reports the unknown id and the known ids for that referent kind", () => {
    const plan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "Nonexistent Place" } }] };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("unknown id 'Nonexistent Place'");
    expect(result.error).toContain("commerce_fields");
  });

  // Review finding (arbitrated): a case-insensitive match landing on two
  // distinct ids (candidates differing only by case) must be unresolvable,
  // not silently resolved to whichever candidate happens to come first -- a
  // wrong guess sends the ship to the wrong place with no error at all.
  test("an ambiguous ref (two ids differing only by case) is unresolvable and names both candidates", () => {
    const surroundings: Surroundings = {
      ...commerceFieldsSurroundings,
      pois: [
        { id: "rusty_belt", name: "Rusty Belt", type: "asteroid_belt" },
        { id: "Rusty_Belt", name: "Rusty Belt Mk2", type: "asteroid_belt" },
      ],
    };
    const plan: Plan = { goal: "mine", steps: [{ action: "travel", params: { id: "RUSTY_BELT" } }] };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("ambiguous reference 'RUSTY_BELT'");
    expect(result.error).toContain("rusty_belt");
    expect(result.error).toContain("Rusty_Belt");
  });

  // SM live diagnosis (2026-07-11): the pilot correctly planned
  // `travel_to traders_rest` (a proven market several jumps away) while the
  // current system's connections listed only other systems. The old normalizer
  // hard-rejected with "unknown id 'traders_rest' -- known ids: ..." because it
  // validated travel_to's system_id against connections-only. travel_to is the
  // multi-hop macro (executor.ts travelToTick + nextHop): find_route from the
  // current system is the reachability authority, so a far destination MUST
  // pass admission and reach the executor.
  test("SM live case: travel_to to a system absent from connections passes admission (not rejected)", () => {
    const surroundings: Surroundings = {
      systemId: "steadyburn",
      systemName: "Steadyburn",
      connections: ["ashfall", "greylock"],
      pois: [],
      dockedAt: "base-1",
    };
    const plan: Plan = { goal: "trade", steps: [{ action: "travel_to", params: { system_id: "traders_rest" } }] };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // passes through untouched -- executor.ts find_route resolves the route
    expect(result.plan.steps[0]).toEqual({ action: "travel_to", params: { system_id: "traders_rest" } });
    expect(result.rewrites).toEqual([]);
  });

  test("travel_to to a connections-known system is still case-normalized to the canonical id", () => {
    const surroundings: Surroundings = {
      systemId: "sys-1",
      systemName: "Alpha Prime",
      connections: ["sys-2"],
      pois: [],
      dockedAt: "base-1",
    };
    const plan: Plan = { goal: "explore", steps: [{ action: "travel_to", params: { system_id: "SYS-2" } }] };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan.steps[0]).toEqual({ action: "travel_to", params: { system_id: "sys-2" } });
    expect(result.rewrites).toEqual([{ step: 0, action: "travel_to", param: "system_id", from: "SYS-2", to: "sys-2" }]);
  });

  test("jump to a system absent from connections still hard-rejects (single-hop adjacency is strict)", () => {
    const surroundings: Surroundings = {
      systemId: "steadyburn",
      systemName: "Steadyburn",
      connections: ["ashfall", "greylock"],
      pois: [],
      dockedAt: "base-1",
    };
    const plan: Plan = { goal: "explore", steps: [{ action: "jump", params: { id: "traders_rest" } }] };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("unknown id 'traders_rest'");
    expect(result.error).toContain("ashfall");
  });

  // SM live diagnosis (2026-07-11, second occurrence): the pilot planned
  // `travel {id: "traders_rest"}` (in-system POI hop) instead of `travel_to`
  // (inter-system macro) while docked in a system whose real POIs are
  // steadyburn/assembly_world/factory_belt_haze/factory_belt_manufacturing_hub.
  // travel correctly hard-rejects (traders_rest is not a POI anywhere) -- the
  // fix is the retry hint pointing at the right verb, not loosening travel's
  // POI-only guard.
  test("SM live case: travel with a system-shaped id hard-rejects with a hint to switch to travel_to", () => {
    const surroundings: Surroundings = {
      systemId: "sys-9",
      systemName: "Some System",
      connections: ["neighbor_a", "neighbor_b"],
      pois: [
        { id: "steadyburn", name: "Steadyburn", type: "star" },
        { id: "assembly_world", name: "Assembly World", type: "planet" },
        { id: "factory_belt_haze", name: "Factory Belt Haze", type: "asteroid_belt" },
        { id: "factory_belt_manufacturing_hub", name: "Factory Belt Manufacturing Hub", type: "station" },
      ],
      dockedAt: "factory_belt_manufacturing_hub",
    };
    const plan: Plan = { goal: "trade", steps: [{ action: "travel", params: { id: "traders_rest" } }] };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("unknown id 'traders_rest'");
    expect(result.error).toContain("factory_belt_haze");
    expect(result.error).toContain("is not a POI in this system");
    expect(result.error).toContain("use travel_to with a system_id");
  });

  test("jump's unknown-id hint points at travel_to too, phrased for the adjacency case", () => {
    const surroundings: Surroundings = {
      systemId: "steadyburn",
      systemName: "Steadyburn",
      connections: ["ashfall", "greylock"],
      pois: [],
      dockedAt: "base-1",
    };
    const plan: Plan = { goal: "explore", steps: [{ action: "jump", params: { id: "traders_rest" } }] };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("is not an adjacent system");
    expect(result.error).toContain("use travel_to with a system_id instead of jump");
  });

  test("actions without a location param (mine, dock) pass through unexamined", () => {
    const plan: Plan = { goal: "mine", steps: [{ action: "mine", params: {}, repeat: 3 }, { action: "dock", params: {} }] };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan).toEqual(plan);
    expect(result.rewrites).toEqual([]);
  });

  // Issue #813, live capture 2026-08-10T22:01:19Z (corsair): the planner's
  // `travel mobile_capital` step targets a POI in `horizon`, the system the
  // PRECEDING travel_to step moves the pilot to -- but the passed-in
  // surroundings snapshot is still `frontier` (the pre-plan system). The old
  // normalizer checked mobile_capital against frontier's POI list and
  // hard-rejected it as unknown, discarding an otherwise-valid plan.
  test("issue #813 live case: a travel step after a cross-system travel_to is not checked against the stale snapshot", () => {
    const surroundings: Surroundings = {
      systemId: "frontier",
      systemName: "Frontier",
      connections: ["horizon"],
      pois: [
        { id: "frontier_star", name: "Frontier Star", type: "star" },
        { id: "old_survey_station", name: "Old Survey Station", type: "station" },
        { id: "veil_nebula", name: "Veil Nebula", type: "nebula" },
        { id: "drifters_haze", name: "Drifters Haze", type: "asteroid_belt" },
        { id: "icecap_drift", name: "Icecap Drift", type: "asteroid_belt" },
        { id: "pioneer_fields", name: "Pioneer Fields", type: "asteroid_belt" },
      ],
      dockedAt: "old_survey_station",
    };
    const plan: Plan = {
      goal: "Dock at Frontier Station to acquire and fit a combat weapon before resuming the grazer cull",
      steps: [
        { action: "travel_to", params: { system_id: "horizon" } },
        { action: "travel", params: { id: "mobile_capital" } },
        { action: "dock", params: {} },
      ],
    };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan.steps[1]).toEqual({ action: "travel", params: { id: "mobile_capital" } });
  });

  // Proves the fix does not over-suppress validation: a travel_to that stays
  // IN the current system leaves the snapshot correct, so a bad POI in a
  // later step must still hard-reject exactly as it does with no travel_to
  // at all.
  test("a same-system travel_to does not suppress validation for a later bad POI", () => {
    const plan: Plan = {
      goal: "mine",
      steps: [
        { action: "travel_to", params: { system_id: "sys-1" } },
        { action: "travel", params: { id: "Nonexistent Place" } },
      ],
    };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("unknown id 'Nonexistent Place'");
    expect(result.error).toContain("commerce_fields");
  });

  // The latch is the fail-OPEN direction -- once set, every later step skips
  // validation -- so it must not engage on a casing difference. `raw` is
  // planner-written and its casing is untrusted, which is why the candidate
  // match lowercases both sides; this pins the same rule at the latch.
  test("a same-system travel_to in different CASE still does not suppress validation", () => {
    const plan: Plan = {
      goal: "mine",
      steps: [
        { action: "travel_to", params: { system_id: "SYS-1" } },
        { action: "travel", params: { id: "Nonexistent Place" } },
      ],
    };
    const result = normalizePlanLocations(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("unknown id 'Nonexistent Place'");
  });

  // systemId is `string | null`. An unknown current system cannot tell us whether
  // a travel_to crossed one, and guessing "crossed" would switch validation off on
  // no evidence, so the latch stays closed.
  test("an unknown current system does not latch: validation stays on", () => {
    const plan: Plan = {
      goal: "mine",
      steps: [
        { action: "travel_to", params: { system_id: "sys-9" } },
        { action: "travel", params: { id: "Nonexistent Place" } },
      ],
    };
    const result = normalizePlanLocations(plan, { ...commerceFieldsSurroundings, systemId: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("unknown id 'Nonexistent Place'");
  });

  // jump shares the identical stale-snapshot exposure as travel: its target
  // system id is only ever meaningful against the CURRENT system's
  // connections, which the pre-plan snapshot no longer reflects once an
  // earlier cross-system travel_to has run.
  test("a jump step after a cross-system travel_to is exempted the same way travel is", () => {
    const surroundings: Surroundings = {
      systemId: "frontier",
      systemName: "Frontier",
      connections: ["horizon"],
      pois: [],
      dockedAt: "old_survey_station",
    };
    const plan: Plan = {
      goal: "explore",
      steps: [
        { action: "travel_to", params: { system_id: "horizon" } },
        { action: "jump", params: { id: "some_far_system" } },
      ],
    };
    const result = normalizePlanLocations(plan, surroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan.steps[1]).toEqual({ action: "jump", params: { id: "some_far_system" } });
  });
});

// Issue #982/#1003, root-caused #1054: the planner sold/withdrew/deposited
// item ids that are not real catalog items -- 'wreck' (a salvage ENTITY per
// docs/game-reference, never an item) and 'exotic_matter_sample' (no such id
// exists at all). Both are LIVE catalog facts, not invented for the test:
// verified against src/catalog/catalog.data.json (710 items) -- 'wreck' and
// 'exotic_matter_sample' are absent, 'fuel_cell'/'iron_ore'/'exotic_matter'
// are present.
describe("normalizePlanItems (issue #982/#1003)", () => {
  test("a real catalog item id on every item-bearing action passes through unchanged", () => {
    const plan: Plan = {
      goal: "trade",
      steps: [
        { action: "buy", params: { id: "fuel_cell", quantity: 1 } },
        { action: "sell", params: { id: "iron_ore", quantity: 1 } },
        { action: "jettison", params: { id: "iron_ore", quantity: 1 } },
        { action: "create_sell_order", params: { item_id: "iron_ore", quantity: 1, price_each: 10 } },
        { action: "create_buy_order", params: { item_id: "iron_ore", quantity: 1, price_each: 10 } },
        { action: "withdraw", params: { item_id: "iron_ore", quantity: 1 } },
        { action: "deposit", params: { item_id: "iron_ore", quantity: 1 } },
      ],
    };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan).toEqual(plan);
    expect(result.rewrites).toEqual([]);
  });

  // Live case: 'wreck' is a salvage ENTITY (docs/game-reference/commands.md's
  // spacemolt_salvage section), not a catalog id at all -- no edit-distance-1
  // catalog id exists for it, so the guard must NOT guess one, only tell the
  // planner to copy a real id.
  test("live case #982: sell id 'wreck' rejects with no guessed correction", () => {
    const plan: Plan = { goal: "salvage", steps: [{ action: "sell", params: { id: "wreck", quantity: 1 } }] };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("sell.id: 'wreck' is not a catalog item id");
    expect(result.error).not.toContain("did you mean");
    expect(result.error).toContain("never invent one");
  });

  // Live case #1003: same class, a different fabricated id, on withdraw --
  // proves the guard is not buy-only (the ONLY prior backstop, executor.ts's
  // nearestCatalogItemId correction, never ran for withdraw at all).
  test("live case #1003: withdraw item_id 'exotic_matter_sample' rejects (no near match, distinct from real 'exotic_matter')", () => {
    const plan: Plan = { goal: "stock", steps: [{ action: "withdraw", params: { item_id: "exotic_matter_sample", quantity: 1 } }] };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("withdraw.item_id: 'exotic_matter_sample' is not a catalog item id");
    expect(result.error).not.toContain("did you mean");
  });

  // The #152 fuel_cells/fuel_cell precedent, now caught at PLAN ADMISSION
  // instead of post-hoc after the game rejects a buy: a genuine near-miss (one
  // character off) gets a guessed correction in the retry text, unlike the two
  // outright fabrications above.
  test("a near-miss (one character off a real id) suggests the correction", () => {
    const plan: Plan = { goal: "refuel", steps: [{ action: "buy", params: { id: "fuel_cells", quantity: 1 } }] };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("buy.id: 'fuel_cells' is not a catalog item id");
    expect(result.error).toContain("did you mean 'fuel_cell'");
  });

  test("deposit's gift form (no item_id, target+credits only) is not checked -- it is a different step shape, not a bad id", () => {
    const plan: Plan = { goal: "fund", steps: [{ action: "deposit", params: { target: "Corvus Marrek", credits: 100 } }] };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan).toEqual(plan);
  });

  test("actions with no item param (travel, mine, dock) pass through unexamined", () => {
    const plan: Plan = { goal: "mine", steps: [{ action: "mine", params: {}, repeat: 2 }, { action: "dock", params: {} }] };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan).toEqual(plan);
  });

  // install_mod/uninstall_mod are deliberately excluded from ITEM_PARAM_BY_ACTION
  // (catalog.ts's comment): their id can be a fitted-module INSTANCE id, not a
  // catalog key, so checking them would manufacture false failures.
  test("install_mod's id is never checked against the catalog (it may be a fitted-instance id)", () => {
    const plan: Plan = { goal: "fit", steps: [{ action: "install_mod", params: { id: "not_a_catalog_id_at_all" } }] };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
  });

  test("the first bad item id in a multi-step plan is reported (fail fast, same pattern as normalizePlanLocations)", () => {
    const plan: Plan = {
      goal: "trade",
      steps: [
        { action: "sell", params: { id: "iron_ore", quantity: 1 } },
        { action: "jettison", params: { id: "wreck", quantity: 1 } },
        { action: "withdraw", params: { item_id: "exotic_matter_sample", quantity: 1 } },
      ],
    };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("jettison.id: 'wreck'");
  });

  // Review finding, fix round on #982/#1003: `raw` is planner-authored text
  // that can itself have been copied out of QUOTED, untrusted game data
  // (#669's template-obedience class). This error string is spliced into
  // ctx.instruction one call later and rendered by digest.ts as "Operator
  // instruction: ..." with no quoting or clip of its own, so an unbounded id
  // here returns under the prompt's strongest label. Bounded via
  // clipUntrusted's default snippet length (imported by the fixture below).
  test("a long id is clipped in the rejection error, not echoed unbounded", () => {
    const longId = "a".repeat(400);
    const plan: Plan = { goal: "salvage", steps: [{ action: "sell", params: { id: longId, quantity: 1 } }] };
    const result = normalizePlanItems(plan);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).not.toContain(longId);
    expect(result.error.length).toBeLessThan(longId.length);
  });
});

describe("normalizeGiftTargets (issue #788)", () => {
  const roster: FleetPilot[] = [
    { id: "miner", username: "Rockhopper Kess" },
    { id: "corsair", username: "Corvus Marrek" },
  ];

  // Breakage caught: the username-first early return collapsing into one pass.
  // `fleet.find((p) => p.id === raw || p.username === raw)` reads as a harmless
  // simplification and is correct on every non-colliding roster -- but on one
  // where an agent's id equals another agent's username it redirects a
  // correctly-addressed gift to the WRONG fleet-mate. `rewrites` is the
  // discriminating assertion, and toEqual([]) rather than a length check: the
  // collapsed form records a no-op self-rewrite (from "Corvus Marrek" to
  // "Corvus Marrek"), so asserting the params object alone would pass it, the
  // rewritten value being identical to the input. This is why an ordinary
  // roster catches an edit whose harmful outcome needs a rare config.
  test("a target that is already a roster username is never rewritten", () => {
    const plan: Plan = {
      goal: "fund the corsair",
      steps: [{ action: "deposit", params: { target: "Corvus Marrek", credits: 27 } }],
    };
    const result = normalizeGiftTargets(plan, roster);
    expect(result.rewrites).toEqual([]);
    expect(result.plan.steps[0]).toEqual({
      action: "deposit", params: { target: "Corvus Marrek", credits: 27 },
    });
  });
});

// Unit-level coverage for the fold itself (Agent.replan's admission call is
// covered end-to-end in test/agent-plan-normalization.test.ts's "fix round
// on #982/#1003" describe block; these pin admitPlan's own composition
// rules directly).
describe("admitPlan (fix round on #982/#1003: one admission pass, not two)", () => {
  test("a location rewrite AND a passing item id combine into one ok result", () => {
    const plan: Plan = {
      goal: "salvage run",
      steps: [
        { action: "travel", params: { id: "Commerce Fields" } },
        { action: "sell", params: { id: "iron_ore", quantity: 1 } },
      ],
    };
    const result = admitPlan(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.plan.steps[0]).toEqual({ action: "travel", params: { id: "commerce_fields" } });
    expect(result.rewrites).toEqual([
      { step: 0, action: "travel", param: "id", from: "Commerce Fields", to: "commerce_fields" },
    ]);
  });

  test("a bad location fails admission before the item check ever runs", () => {
    const plan: Plan = {
      goal: "salvage run",
      steps: [
        { action: "travel", params: { id: "Nonexistent Place" } },
        { action: "sell", params: { id: "wreck", quantity: 1 } }, // also bad, must not be what's reported
      ],
    };
    const result = admitPlan(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("unknown id 'Nonexistent Place'");
  });

  test("a good location with a bad item id fails on the item check, carrying the location's rewrite state internally", () => {
    const plan: Plan = {
      goal: "salvage run",
      steps: [
        { action: "travel", params: { id: "Commerce Fields" } }, // rewritten en route
        { action: "sell", params: { id: "wreck", quantity: 1 } }, // then fails here
      ],
    };
    const result = admitPlan(plan, commerceFieldsSurroundings);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("sell.id: 'wreck' is not a catalog item id");
  });

  test("surroundings undefined skips the location check but still runs the item check", () => {
    const plan: Plan = { goal: "salvage", steps: [{ action: "sell", params: { id: "wreck", quantity: 1 } }] };
    const result = admitPlan(plan, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("sell.id: 'wreck' is not a catalog item id");
  });
});
