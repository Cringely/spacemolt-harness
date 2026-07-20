import { describe, expect, test } from "bun:test";
import { normalizePlanLocations } from "../src/agent/normalize-plan";
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
});
