import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { fitmentRequirement, fitmentRequirements, fitmentVerdict } from "../src/registry/fitment";
import { failureClass } from "../src/server/failures";
import type { FittedModule, GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Module-fitment guard (issues #757 and #736 -- one defect, two live reports).
//
// #757: the scout planned `survey_system` 204 times lifetime and the game
// refused all 204 with `no_scanner: "No survey scanner equipped."` -- 90 of
// them inside one 72h window, over half of everything it did.
// #736: the miner planned `tow` 6 times and the game refused all 6 with
// `no_tow_rig: "Your ship needs a tow rig module fitted (utility slot)."`
//
// Each test below names the breakage it catches. What is deliberately NOT
// tested: that the table's rows are spelled the way the reference spells them
// (a restatement of the data), or that every row blocks (mine's row is already
// covered by executor.test.ts and one more copy of it proves nothing new).

type Overrides = {
  status?: StatusSnapshot | null;
  capabilities?: readonly string[] | undefined;
  capabilitiesThrow?: boolean;
  omitCapabilityApi?: boolean;
};

const BASE: StatusSnapshot = {
  credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

function stubApi(o: Overrides = {}) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const classLookups: string[] = [];
  const status = o.status === undefined ? BASE : o.status;
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() {
      if (status === null) throw new Error("status unavailable");
      return status;
    },
    async notifications() { return []; },
    ...(o.omitCapabilityApi ? {} : {
      async getShipClassCapabilities(classId: string) {
        classLookups.push(classId);
        if (o.capabilitiesThrow) throw new Error("catalog down");
        return o.capabilities;
      },
    }),
  };
  return { api, calls, classLookups };
}

const plan = (action: string, params: Record<string, unknown> = {}): Plan =>
  ({ goal: "g", steps: [{ action, params }] });

const scanner: FittedModule = {
  typeId: "survey_scanner_i", type: "scanner", slot: "utility", name: "Survey Scanner I",
  stats: { survey_power: 12 },
};
const towRig: FittedModule = {
  typeId: "basic_tow_rig", type: "utility", slot: "utility", name: "Basic Tow Rig",
  stats: { tow_speed_penalty: 20 },
};
const shieldBooster: FittedModule = { typeId: "shield_booster_i", type: "defense", slot: "defense" };

describe("module-fitment guard: the blocked cases the two issues report", () => {
  // #757. Catches: the guard failing to fire for survey_system at all, which
  // is the shipped-today behaviour (204/204 doomed calls reached the game).
  // The call-count assertion is the load-bearing half -- `blocked` alone would
  // also be satisfied by a guard that blocks AFTER spending the tick.
  test("survey_system with no scanner fitted and a hull that integrates none is refused before the call", async () => {
    const { api, calls, classLookups } = stubApi({
      status: { ...BASE, shipClassId: "prospect", modules: [shieldBooster] },
      capabilities: ["ore_yield_bonus"], // a real capability list, no survey scanner in it
    });
    const r = await executeTick(api, plan("survey_system"), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.guard).toBe(true); // #571/#581: OUR refusal, not the game's
    expect(r.kind === "blocked" && r.reason).toContain("needs a survey scanner module");
    expect(calls.length).toBe(0);
    expect(classLookups).toEqual(["prospect"]); // the hull WAS consulted before refusing
  });

  // #736. Same shape, and the row carries no hullCapability, so the catalog
  // must not be consulted at all. Catches a table that gives every row the
  // hull lookup (a free query, but one fired on a question the reference does
  // not raise for tow).
  test("tow with no tow rig fitted is refused before the call, with no hull lookup", async () => {
    const { api, calls, classLookups } = stubApi({
      status: { ...BASE, shipClassId: "prospect", modules: [shieldBooster] },
    });
    const r = await executeTick(api, plan("tow", { id: "wreck_1" }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("needs a tow rig module");
    expect(calls.length).toBe(0);
    expect(classLookups).toEqual([]);
  });

  // The taxonomy seam (src/server/failures.ts:43, /needs a .+ module/i ->
  // `missing_module`). Catches a future reword that drops the phrase: the
  // refusals would each become their own sentence-shaped class in the
  // prevented-steps table instead of grouping under one name.
  test("every table row's reason carries the phrase the failure taxonomy groups on", () => {
    for (const req of fitmentRequirements()) {
      // Through the real classifier, not a copy of its regex: a duplicated
      // pattern goes on passing after the producer's own changes.
      expect(failureClass(req.reason)).toBe("missing_module");
    }
  });
});

describe("module-fitment guard: fail-open, because absence of data is not a verdict", () => {
  // The direction that matters. Catches a guard that reads an unreadable fit
  // as an empty one -- which would refuse EVERY gated action for as long as
  // get_status's modules block stays unparsed, exactly the paralysis a wasted
  // tick is cheaper than.
  // Both actions, on purpose. `tow` has no hull substitute, so nothing but the
  // UNKNOWN verdict can let it through; survey_system is paired with a hull
  // that provably integrates nothing, so the hull lookup cannot rescue a
  // verdict that wrongly read the unreadable fit as empty.
  test.each(["tow", "survey_system"])(
    "unknown fit (modules absent) lets %s through to the game",
    async (action) => {
      const { api, calls } = stubApi({
        status: { ...BASE, shipClassId: "prospect" }, // modules omitted -> UNKNOWN
        capabilities: [],
      });
      const r = await executeTick(api, plan(action, action === "tow" ? { id: "wreck_1" } : {}),
        { step: 0, iteration: 0 });
      expect(r.kind).toBe("plan_done");
      expect(calls.map((c) => c.name)).toEqual([action]);
    },
  );

  // The reference says survey_system works on "a survey scanner module OR a
  // ship with an integrated survey scanner" (openapi-v2.json:47331). Catches a
  // guard built on the fitted set alone, which would refuse a legal action on
  // an exploration hull and permanently cost that pilot deep-core surveying.
  test("a hull that integrates a survey scanner is allowed with nothing fitted", async () => {
    const { api, calls } = stubApi({
      status: { ...BASE, shipClassId: "pathfinder", modules: [shieldBooster] },
      capabilities: ["integrated_survey_scanner"],
    });
    const r = await executeTick(api, plan("survey_system"), { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "survey_system", params: {} }]);
  });

  // Three distinct ways the hull question can come back unanswered. Each must
  // allow, and `undefined` is the interesting one: it is what a ShipClass
  // carrying no inherent_capabilities key maps to, and collapsing it to "this
  // hull integrates nothing" is the unknown-becomes-absent bug.
  test.each([
    ["the catalog query throws", { capabilitiesThrow: true } as Overrides],
    ["the class has no capability list at all", { capabilities: undefined } as Overrides],
    ["the api cannot answer the question", { omitCapabilityApi: true } as Overrides],
  ])("unknown hull (%s) lets survey_system through", async (_label, extra) => {
    const { api, calls } = stubApi({
      status: { ...BASE, shipClassId: "prospect", modules: [shieldBooster] },
      ...extra,
    });
    const r = await executeTick(api, plan("survey_system"), { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "survey_system", params: {} }]);
  });

  // An EMPTY capability list is knowledge, not absence: a hull that integrates
  // nothing reports one. Catches a `!capabilities.length -> fail open` shortcut
  // that would make the survey_system guard unable to fire on any such hull.
  test("an empty capability list is a real answer and still refuses survey_system", async () => {
    const { api, calls } = stubApi({
      status: { ...BASE, shipClassId: "prospect", modules: [shieldBooster] },
      capabilities: [],
    });
    expect((await executeTick(api, plan("survey_system"), { step: 0, iteration: 0 })).kind).toBe("blocked");
    expect(calls.length).toBe(0);
  });
});

describe("module-fitment recognition: the three evidence channels", () => {
  // Each channel is the ONLY signal on its module here, so removing any one
  // from the table turns a satisfied fit into a false refusal. Catches exactly
  // that: the stat channel is inferred from the catalog's Module schema rather
  // than captured live, so the type_id channel has to carry a scanner whose
  // stats block reports nothing, and vice versa.
  //
  // `capabilities: []` is load-bearing, not scenery -- a hull that provably
  // integrates nothing. Leave it out and the hull lookup returns UNKNOWN and
  // waves the action through whatever the channels decide, so the test would
  // pass against a table with no channels at all.
  test.each([
    ["stat channel alone", { typeId: "unknown_mk2", type: "", stats: { survey_power: 3 } }],
    ["type_id channel alone", { typeId: "deep_core_survey_scanner", type: "", stats: {} }],
  ])("survey_system is satisfied by the %s", async (_label, module) => {
    const { api, calls } = stubApi({
      status: { ...BASE, shipClassId: "prospect", modules: [module as FittedModule] },
      capabilities: [],
    });
    const r = await executeTick(api, plan("survey_system"), { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" });
    expect(calls).toEqual([{ name: "survey_system", params: {} }]);
  });

  // A zero stat is not a module. Catches a `key in stats` presence test, which
  // would let a module reporting survey_power: 0 satisfy the requirement.
  test("a zero-valued stat does not satisfy the requirement", () => {
    const req = fitmentRequirement("survey_system")!;
    const zeroed: FittedModule = { typeId: "unknown_mk2", type: "", stats: { survey_power: 0 } };
    expect(fitmentVerdict(req, [zeroed])).toBe("absent");
  });

  // The legacy alias. client.ts has mapped stats.mining_power onto its own
  // FittedModule.miningPower field since 2026-07-12 and the eval fixtures and
  // several consumers still write only that one. Catches a stat lookup that
  // reads the stats block alone and would stop recognising those modules.
  test("mine is satisfied by the legacy miningPower alias with no stats block", () => {
    const req = fitmentRequirement("mine")!;
    expect(fitmentVerdict(req, [{ typeId: "hyper_mining_laser_iii", type: "", miningPower: 40 }]))
      .toBe("satisfied");
  });

  // Three values, never two -- the distinction the whole guard rests on.
  test("verdict separates an unreadable fit from an empty one", () => {
    const req = fitmentRequirement("tow")!;
    expect(fitmentVerdict(req, undefined)).toBe("unknown");
    expect(fitmentVerdict(req, [])).toBe("absent");
    expect(fitmentVerdict(req, [towRig])).toBe("satisfied");
    expect(fitmentVerdict(req, [scanner])).toBe("absent"); // another module is not this one
  });

  // Catches the table growing a row for an action the reference does not gate
  // on a module -- `scan` and `attack` are the two that read equipment-shaped
  // and are not gated (see fitment.ts's audit).
  test("an action with no documented module requirement has no row", () => {
    expect(fitmentRequirement("scan")).toBeUndefined();
    expect(fitmentRequirement("attack")).toBeUndefined();
    expect(fitmentRequirement("dock")).toBeUndefined();
  });
});
