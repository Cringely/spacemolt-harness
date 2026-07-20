import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

function stubApi(overrides?: Partial<{ status: StatusSnapshot; failWith: SpacemoltError }>) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const status: StatusSnapshot = overrides?.status ?? {
    credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      if (overrides?.failWith) throw overrides.failWith;
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

describe("executeTick", () => {
  test("single-shot step advances cursor", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [
      { action: "dock", params: {} },
      { action: "undock", params: {} },
    ]};
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 }, resultText: "ok" });
    expect(calls).toEqual([{ name: "dock", params: {} }]);
  });

  test("until step repeats while condition unmet, completes when met", async () => {
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    const notFull = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 10, cargoCapacity: 50, docked: false, inTransit: false,
    }});
    const r1 = await executeTick(notFull.api, plan, { step: 0, iteration: 0 });
    expect(r1).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });

    const full = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 50, cargoCapacity: 50, docked: false, inTransit: false,
    }});
    const r2 = await executeTick(full.api, plan, { step: 0, iteration: 3 });
    expect(r2).toEqual({ kind: "plan_done", resultText: "ok" }); // only step, now complete
  });

  test("repeat step counts iterations", async () => {
    const { api } = stubApi();
    const plan: Plan = { goal: "g", steps: [
      { action: "mine", params: {}, repeat: 3 },
      { action: "dock", params: {} },
    ]};
    const r1 = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r1).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });
    const r3 = await executeTick(api, plan, { step: 0, iteration: 2 });
    expect(r3).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 }, resultText: "ok" });
  });

  test("last step completion returns plan_done", async () => {
    const { api } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "dock", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
  });

  test("game error blocks the plan with reason", async () => {
    const { api } = stubApi({ failWith: new SpacemoltError("command_error", "not enough fuel") });
    const plan: Plan = { goal: "g", steps: [{ action: "jump", params: { id: "sys-2" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "not enough fuel", resultText: "not enough fuel" });
  });

  test("cursor past plan end returns plan_done without acting", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "dock", params: {} }] };
    const r = await executeTick(api, plan, { step: 5, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done" });
    expect(calls.length).toBe(0);
  });

  // Undock precondition guard: undock while already undocked is a guaranteed
  // game error, so the executor must treat it as a satisfied no-op and advance
  // WITHOUT sending the call (the fake records every api.action call).
  test("undock while not docked advances without sending the API call", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [
      { action: "undock", params: {} },
      { action: "mine", params: {} },
    ]};
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 }, resultText: "already undocked; undock is a no-op" });
    expect(calls.length).toBe(0); // no undock request was made
  });

  test("undock while docked still sends the undock call", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "undock", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "undock", params: {} }]);
  });

  // withdraw precondition guard (capability audit, Workflow A 2026-07-19):
  // storage.md:46 says deposits/withdrawals always require docking, a
  // guaranteed game error while undocked -- same class as the undock/
  // install_mod docked guards above. Blocks WITHOUT sending the doomed call.
  test("withdraw while not docked blocks without sending the API call", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "withdraw", params: { item_id: "mining_laser_iii", quantity: 1 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({
      kind: "blocked",
      reason: "withdraw blocked: you must be DOCKED at a station with storage service. Plan dock first, then withdraw{item_id=...}.",
      resultText: "withdraw blocked: you must be DOCKED at a station with storage service. Plan dock first, then withdraw{item_id=...}.",
    });
    expect(calls.length).toBe(0); // no withdraw request was made
  });

  // Dispatch check: withdraw while docked reaches the game with item_id/
  // quantity intact -- the whole point of registering it (buy->install chain).
  test("withdraw while docked sends the API call with item_id/quantity", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "withdraw", params: { item_id: "mining_laser_iii", quantity: 1 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "withdraw", params: { item_id: "mining_laser_iii", quantity: 1 } }]);
  });

  // Mine precondition guard: a mine with a KNOWN-empty fitted set (no mining
  // laser) is a guaranteed game error, so the executor must block WITHOUT
  // sending the doomed call (the fake records every api.action call). Contrast
  // undock (a satisfiable no-op that advances) -- a laser-less mine is not
  // satisfiable, so it blocks for a replan.
  test("mine with no mining module fitted blocks without sending the API call", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
      modules: [{ typeId: "shield_booster_i", type: "defense" }], // fitted, but not a laser
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({
      kind: "blocked",
      reason: "no mining equipment fitted; a mine action needs a mining laser module",
      resultText: "no mining equipment fitted; a mine action needs a mining laser module",
    });
    expect(calls.length).toBe(0); // no mine request was made
  });

  test("mine with a mining laser fitted sends the mine call", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
      modules: [{ typeId: "mining_laser_i", type: "mining", miningPower: 5 }],
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "mine", params: {} }]);
  });

  // Fail-safe: when the fitted set is UNKNOWN (status.modules undefined -- the
  // block was absent or malformed), the guard must NOT fire. It lets the mine
  // through so classifyGameError can catch any real block at the call site,
  // rather than fabricating a "no equipment" block from missing data.
  test("mine with unknown modules (undefined) is not short-circuited", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
      // modules omitted -> undefined -> UNKNOWN
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "mine", params: {} }]);
  });

  // accept_mission precondition guard (live diagnosis 2026-07-12): the game
  // enforces "at least one of id/template_id" at runtime even though the
  // registered request shape marks both optional. An empty-param accept_mission
  // is a guaranteed invalid_payload, so the executor must short-circuit to
  // blocked WITHOUT sending the doomed call, and must still let a call carrying
  // a template_id (or id) through untouched.
  test("accept_mission with empty params blocks without sending the API call", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "accept_mission", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    // #147: the reason text must point at the harness-fetched listing, never
    // at get_missions -- it reaches the digest as a blocked wake's detail, and
    // get_missions is a query the planner structurally cannot plan.
    expect(r).toEqual({
      kind: "blocked",
      reason: "accept_mission needs a template_id (or id) copied from the mission listing in your briefing",
      resultText: "accept_mission needs a template_id (or id) copied from the mission listing in your briefing",
    });
    expect(calls.length).toBe(0); // the doomed call was never sent
  });

  test("accept_mission with an empty-string template_id is treated as absent and blocks", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "accept_mission", params: { template_id: "", id: "" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(calls.length).toBe(0);
  });

  test("accept_mission WITH a template_id passes through to the API", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "accept_mission", params: { template_id: "haul_ore_5" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "accept_mission", params: { template_id: "haul_ore_5" } }]);
  });

  test("accept_mission WITH an id (offered mission) also passes through to the API", async () => {
    const { api, calls } = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
    }});
    const plan: Plan = { goal: "g", steps: [{ action: "accept_mission", params: { id: "mission-abc" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "accept_mission", params: { id: "mission-abc" } }]);
  });
});

// complete_mission precondition guard (issue #291 regression, live 2026-07-17):
// 12 complete_mission calls fired against ONE titanium contract still under
// 20/20, each rejected `mission_incomplete`, each burning a tick + a replan.
// The guard refuses a KNOWN shortfall before the wire and fails OPEN on unknown
// data. It reads get_active_missions fresh; the stub adds that method on top of
// the shared stubApi (spreading keeps the same `calls`-recording action fn).
describe("executeTick: complete_mission objective guard (#291 regression)", () => {
  const undocked: StatusSnapshot = {
    credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 20, cargoCapacity: 50, docked: false, inTransit: false,
  };
  function apiWithMissions(objectives: unknown[]) {
    const { api, calls } = stubApi({ status: undocked });
    const withMissions: GameApi = {
      ...api,
      async getActiveMissions() {
        return {
          text: "1. Titanium Extraction Contract (id: m-titanium-1)",
          missions: [{ missionId: "m-titanium-1", objectives: objectives as never }],
        };
      },
    };
    return { api: withMissions, calls };
  }

  test("objective short of required blocks before the wire with a self-describing shortfall", async () => {
    const { api, calls } = apiWithMissions([
      { itemId: "titanium_ore", required: 20, current: 14, completed: false },
    ]);
    const plan: Plan = { goal: "g", steps: [{ action: "complete_mission", params: { id: "m-titanium-1" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect((r as { reason: string }).reason).toContain("titanium_ore 14/20 (mine 6 more)");
    expect(calls.some((c) => c.name === "complete_mission")).toBe(false); // doomed call never sent
  });

  test("every objective met passes complete_mission through to the API", async () => {
    const { api, calls } = apiWithMissions([
      { itemId: "titanium_ore", required: 20, current: 20, completed: false },
    ]);
    const plan: Plan = { goal: "g", steps: [{ action: "complete_mission", params: { id: "m-titanium-1" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toContainEqual({ name: "complete_mission", params: { id: "m-titanium-1" } });
  });

  test("fails OPEN when the mission is absent from the parsed active list (no fabricated block)", async () => {
    const { api, calls } = apiWithMissions([
      { itemId: "titanium_ore", required: 20, current: 14, completed: false },
    ]);
    // completing a DIFFERENT mission id -> guard cannot prove a shortfall -> allow
    const plan: Plan = { goal: "g", steps: [{ action: "complete_mission", params: { id: "m-other" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toContainEqual({ name: "complete_mission", params: { id: "m-other" } });
  });
});

// Buy-id correction (issue #152): 86/86 lifetime buy failures, the decisive
// class an invalid_item on 'fuel_cells' -- one character off the catalog's
// fuel_cell, taught by the game's own refuel prose. The executor must surface
// the nearest catalog id in the blocked detail so the planner self-corrects
// next plan, and must NEVER auto-retry the buy (a mutation retry has
// at-least-once double-spend hazards, #137). The positive case drives the
// LIVE captured failure text verbatim
// (test/fixtures/market-capture-2026-07-13.json).
describe("executeTick: buy invalid_item correction (#152)", () => {
  const capturedInvalidItem =
    "invalid_item: Unknown item 'fuel_cells'. Use exact item ID (e.g. 'iron_ore') or full name (e.g. 'Iron Ore').";

  test("the live captured fuel_cells failure surfaces the fuel_cell correction without retrying the buy", async () => {
    const { api, calls } = stubApi({ failWith: new SpacemoltError("command_error", capturedInvalidItem) });
    const plan: Plan = { goal: "g", steps: [{ action: "buy", params: { id: "fuel_cells", quantity: 50 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain("did you mean 'fuel_cell'");
    // correction leads, game text follows -- the digest clips a blocked
    // wake's detail at 200 chars, so a trailing suggestion could be cut
    expect(reason.indexOf("did you mean")).toBeLessThan(reason.indexOf("Game said"));
    // the game's own error text is preserved for diagnosis
    expect(reason).toContain(capturedInvalidItem);
    // exactly ONE buy submission: surfaced, never auto-retried (#137)
    expect(calls).toEqual([{ name: "buy", params: { id: "fuel_cells", quantity: 50 } }]);
  });

  test("no suggestion when nothing in the catalog is within edit distance 1 -- the raw block passes through", async () => {
    const msg = "invalid_item: Unknown item 'unobtainium_crystal_xl'. Use exact item ID (e.g. 'iron_ore') or full name (e.g. 'Iron Ore').";
    const { api } = stubApi({ failWith: new SpacemoltError("command_error", msg) });
    const plan: Plan = { goal: "g", steps: [{ action: "buy", params: { id: "unobtainium_crystal_xl", quantity: 1 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: msg, resultText: msg });
  });

  test("a non-invalid_item buy block is untouched (the other live captured class: not_docked)", async () => {
    const msg = "not_docked: You must be docked at a station to perform this action.";
    const { api } = stubApi({ failWith: new SpacemoltError("command_error", msg) });
    const plan: Plan = { goal: "g", steps: [{ action: "buy", params: { id: "fuel_cell", quantity: 5 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: msg, resultText: msg });
  });
});

// Catalog-gated jettison guard (issue #94, operator mandate 2026-07-13).
// Invariant: valuable cargo must never be destroyed, established at the
// executor jettison seam. Live incident: 28 palladium_ore (catalog base_value
// 200cr) framed as "dead weight" across plans. The guard must refuse the
// destroying call BEFORE the wire for a valuable item, let a genuinely
// worthless item through, and surface alternatives the planner can act on.
describe("executeTick: catalog-gated jettison guard (#94)", () => {
  test("jettison of a valuable item (palladium_ore, 200cr) blocks without sending the API call", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "jettison", params: { id: "palladium_ore", quantity: 28 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(calls.length).toBe(0); // the destroying call was never sent
    const reason = (r as { reason: string }).reason;
    // The refusal must tell the planner WHY (the value) and WHAT INSTEAD
    // (hold / re-check markets / create_sell_order), and the actionable steer
    // must survive the digest's 200-char blocked-detail clip.
    expect(reason).toContain("200cr");
    expect(reason).toMatch(/hold/i);
    expect(reason).toContain("create_sell_order");
    expect(reason.indexOf("create_sell_order")).toBeLessThan(200);
  });

  test("jettison of a worthless item (carbon_ore, 4cr) passes through to the API", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "jettison", params: { id: "carbon_ore", quantity: 47 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "jettison", params: { id: "carbon_ore", quantity: 47 } }]);
  });

  // Fail-open: an item the catalog doesn't value must NOT be blocked -- a
  // fabricated block from missing data could deadlock disposal of genuinely
  // worthless unknown junk (same convention as the mine guard's
  // unknown-modules case).
  test("jettison of an item unknown to the catalog is not short-circuited", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "jettison", params: { id: "mystery_debris", quantity: 1 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls.length).toBe(1);
  });
});

// create_sell_order price default (issue #94): an omitted price_each is
// filled deterministically from the catalog base_value -- the planner never
// invents a price -- and an explicit price is respected. With neither a
// price nor a catalog value there is nothing deterministic to send, so the
// step blocks for a replan instead of firing an unpriced listing.
describe("executeTick: create_sell_order price default (#94)", () => {
  test("omitted price_each is filled from the catalog base_value", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "create_sell_order", params: { item_id: "palladium_ore", quantity: 28 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "create_sell_order", params: { item_id: "palladium_ore", quantity: 28, price_each: 200 } }]);
  });

  test("an explicit price_each passes through untouched", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "create_sell_order", params: { item_id: "palladium_ore", quantity: 28, price_each: 350 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "create_sell_order", params: { item_id: "palladium_ore", quantity: 28, price_each: 350 } }]);
  });

  test("no price and no catalog value blocks without sending the call", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "create_sell_order", params: { item_id: "mystery_debris", quantity: 1 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect((r as { reason: string }).reason).toContain("price_each");
    expect(calls.length).toBe(0);
  });
});

// create_buy_order price default (issue #316): same deterministic pricing
// rule as create_sell_order (#94), extended to the buy side -- an omitted
// price_each is filled from the catalog base_value, an explicit price passes
// through, and no catalog value blocks for a replan instead of firing an
// unpriced order.
describe("executeTick: create_buy_order price default (#316)", () => {
  test("omitted price_each is filled from the catalog base_value", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "create_buy_order", params: { item_id: "palladium_ore", quantity: 28 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "create_buy_order", params: { item_id: "palladium_ore", quantity: 28, price_each: 200 } }]);
  });

  test("an explicit price_each passes through untouched", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "create_buy_order", params: { item_id: "palladium_ore", quantity: 28, price_each: 350 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "create_buy_order", params: { item_id: "palladium_ore", quantity: 28, price_each: 350 } }]);
  });

  test("no price and no catalog value blocks without sending the call", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "create_buy_order", params: { item_id: "mystery_debris", quantity: 1 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect((r as { reason: string }).reason).toContain("price_each");
    expect(calls.length).toBe(0);
  });
});

describe("executeTick: travel_to macro", () => {
  // VERIFIED 2026-07-10 (live find_route capture, SM-2 flight diagnosis --
  // see docs/STATE.md): { found, total_jumps, estimated_fuel, fuel_available,
  // message, route: [{jumps, name, system_id}], target_system }. route[0] is
  // the CURRENT system (jumps: 0); route[1] is the next hop. The previous
  // ASSUMED shape ({ route: string[] }, route[0] = next hop) was wrong.
  function stubRouteApi(opts: {
    systemId: string; nextHopId?: string; notFoundMessage?: string;
    failFind?: SpacemoltError; failJump?: SpacemoltError;
  }) {
    const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
    let systemId = opts.systemId;
    const api: GameApi = {
      async action(name, params) {
        calls.push({ name, params });
        if (name === "find_route") {
          if (opts.failFind) throw opts.failFind;
          if (!opts.nextHopId) {
            return { structuredContent: { found: false, message: opts.notFoundMessage ?? "No route found", route: [] } };
          }
          return {
            structuredContent: {
              found: true, total_jumps: 1, estimated_fuel: 1, fuel_available: 130,
              message: "Route found: 1 jump(s).",
              route: [
                { jumps: 0, name: systemId, system_id: systemId },
                { jumps: 1, name: opts.nextHopId, system_id: opts.nextHopId },
              ],
              target_system: opts.nextHopId,
            },
          };
        }
        if (name === "jump") {
          if (opts.failJump) throw opts.failJump;
          systemId = params!["id"] as string; // fake: arrives at the hop immediately
          return { result: "ok" };
        }
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId,
        };
      },
      async notifications() { return []; },
    };
    return { api, calls };
  }

  test("already at target completes the step immediately", async () => {
    const { api, calls } = stubRouteApi({ systemId: "sys-3" });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-3" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done" });
    expect(calls).toEqual([]); // no find_route/jump needed
  });

  test("jumps one hop per tick toward the target", async () => {
    const { api, calls } = stubRouteApi({ systemId: "sys-1", nextHopId: "sys-2" });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-3" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });
    expect(calls.map((c) => c.name)).toEqual(["find_route", "jump"]);
    expect(calls[1]!.params).toEqual({ id: "sys-2" });
  });

  test("arrival on a later tick advances the plan", async () => {
    const { api } = stubRouteApi({ systemId: "sys-3" }); // already there this tick
    const plan: Plan = { goal: "g", steps: [
      { action: "travel_to", params: { system_id: "sys-3" } },
      { action: "dock", params: {} },
    ]};
    const r = await executeTick(api, plan, { step: 0, iteration: 2 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 } });
  });

  test("no route found blocks the plan with the game's message", async () => {
    const { api } = stubRouteApi({ systemId: "sys-1", notFoundMessage: "No route exists to sys-9" });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-9" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "No route exists to sys-9", resultText: "No route exists to sys-9" });
  });

  test("a malformed/empty route response blocks with a generic reason", async () => {
    // No `found` flag and no route at all -- exercises nextHop()'s fallback
    // when the response doesn't match either the success or found:false shape.
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-9" } }] };
    const bareApi: GameApi = {
      async action(name: string) {
        if (name === "find_route") return { structuredContent: {} };
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId: "sys-1",
        };
      },
      async notifications() { return []; },
    };
    const r = await executeTick(bareApi, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "no route to sys-9", resultText: "no route to sys-9" });
  });

  test("jump failure blocks the plan with the game's reason", async () => {
    const { api } = stubRouteApi({
      systemId: "sys-1", nextHopId: "sys-2",
      failJump: new SpacemoltError("command_error", "not enough fuel"),
    });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-3" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "not enough fuel", resultText: "not enough fuel" });
  });
});

// SM-9 fix (live diagnosis 2026-07-11): the executor treated any non-error
// `sell` envelope as success -- ground truth is 17 sell steps over ~20min,
// every one returning a non-error envelope, cargo completely unchanged
// (trade_crystal 2, vanadium_ore 31, palladium_ore 20, carbon_ore 47 before
// AND after) and credits flat at 304. verifySellEffect (executor.ts) queries
// the free/unlimited get_status endpoint before AND after the sell mutation
// and compares the target item's quantity -- these tests exercise both the
// unchanged-quantity (phantom success) and decreased-quantity (real success)
// paths, plus the result-text-snippet fallback when the envelope has none.
describe("executeTick: sell effect verification (SM-9)", () => {
  function stubSellApi(opts: { beforeQty: number; afterQty: number; sellResultText?: string }) {
    let statusCalls = 0;
    const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
    const cargoFor = (qty: number) => (qty > 0 ? [{ itemId: "carbon_ore", name: "carbon_ore", quantity: qty }] : []);
    const api: GameApi = {
      async action(name, params): Promise<V2Result> {
        calls.push({ name, params });
        if (name === "sell") return { result: opts.sellResultText ?? "ok" };
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        statusCalls++;
        const qty = statusCalls === 1 ? opts.beforeQty : opts.afterQty; // 1st call: pre-sell, 2nd: post-sell
        return {
          credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: qty, cargoCapacity: 50, docked: true, inTransit: false,
          cargo: cargoFor(qty),
        };
      },
      async notifications() { return []; },
    };
    return { api, calls };
  }

  test("envelope ok but cargo quantity unchanged is blocked with the envelope's result text as the reason", async () => {
    const { api } = stubSellApi({ beforeQty: 47, afterQty: 47, sellResultText: "No buy orders for carbon_ore" });
    const plan: Plan = { goal: "g", steps: [{ action: "sell", params: { id: "carbon_ore", quantity: 47 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({
      kind: "blocked",
      reason: "No buy orders for carbon_ore",
      resultText: "No buy orders for carbon_ore",
    });
  });

  test("envelope ok, cargo unchanged, and no envelope text falls back to a generic blocked reason", async () => {
    const { api } = stubSellApi({ beforeQty: 47, afterQty: 47, sellResultText: "" });
    const plan: Plan = { goal: "g", steps: [{ action: "sell", params: { id: "carbon_ore", quantity: 47 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({
      kind: "blocked",
      reason: "sell of carbon_ore had no effect (cargo unchanged)",
      resultText: "sell of carbon_ore had no effect (cargo unchanged)",
    });
  });

  test("cargo quantity decreased is a verified real success, not just a non-error envelope", async () => {
    const { api, calls } = stubSellApi({ beforeQty: 47, afterQty: 0, sellResultText: "Sold 47 carbon_ore for 94cr" });
    const plan: Plan = { goal: "g", steps: [{ action: "sell", params: { id: "carbon_ore", quantity: 47 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "Sold 47 carbon_ore for 94cr" });
    expect(calls.map((c) => c.name)).toEqual(["sell"]); // exactly one mutation; the two status() calls are free queries
  });

  test("an over-length result text is truncated to the ~120 char snippet cap", async () => {
    const longText = "x".repeat(200);
    const { api } = stubSellApi({ beforeQty: 47, afterQty: 47, sellResultText: longText });
    const plan: Plan = { goal: "g", steps: [{ action: "sell", params: { id: "carbon_ore", quantity: 47 } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect((r as { reason: string }).reason.length).toBe(120);
  });
});
