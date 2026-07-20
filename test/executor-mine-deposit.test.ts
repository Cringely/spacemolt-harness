import { describe, expect, test } from "bun:test";
import {
  executeTick, canLockDeposit, totalMiningPower, miningEquipmentKey,
  SPARSE_LOCK_MULTIPLIER, type LearnedSparseRule,
} from "../src/agent/executor";
import type { GameApi, StatusSnapshot, FittedModule, PoiDepositsResult } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Mine deposit precondition (issue #188). The incident: the pilot spent a tick
// on `mine` and got "Deposits here are too sparse for your mining array ...
// The richest deposit holds 24 units; your array needs at least 25 to get a
// lock" -- both numbers knowable BEFORE the call (get_poi supported_power,
// mining.md:38; fitted mining_power summed, miner.md:161), rule mining.md:42
// (blocked iff total power > 4x supported_power). Two rungs under test:
//   1. deterministic: all supported_power known + array power known -> block
//      only when NO deposit here can feed the array;
//   2. learned fallback: live data undecidable -> refuse only the exact
//      (poi, mining-fit) repeat of a block the game already taught.
// Fail-open on every unknown (#94): a guard fabricating a block from missing
// data would strand mining entirely.

const minePlan: Plan = { goal: "mine", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };

const laser100: FittedModule = { typeId: "mining_laser_iv", type: "mining", miningPower: 100, slot: "utility" };
const laser5: FittedModule = { typeId: "mining_laser_i", type: "mining", miningPower: 5, slot: "utility" };

function stubApi(opts: {
  modules?: FittedModule[];
  deposits?: () => Promise<PoiDepositsResult | undefined>;
}) {
  const calls: Array<{ name: string }> = [];
  let depositCalls = 0;
  const status: StatusSnapshot = {
    credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    modules: opts.modules,
  };
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push({ name }); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    ...(opts.deposits ? { async getPoiDeposits() { depositCalls++; return opts.deposits!(); } } : {}),
  };
  return { api, calls, depositCalls: () => depositCalls };
}

const belt = (poiId: string, deposits: Array<{ resourceId: string; supportedPower?: number }>): PoiDepositsResult =>
  ({ poiId, deposits });

describe("deposit-lock rule primitives (#188)", () => {
  test("canLockDeposit matches mining.md:42 exactly at the boundary (blocked iff power > 4x support)", () => {
    // the incident's numbers: array ~100, richest 24 -> blocked; 25 -> lockable
    expect(canLockDeposit(100, 24)).toBe(false);
    expect(canLockDeposit(100, 25)).toBe(true); // 100 == 4x25: NOT "more than 4x over"
  });

  test("totalMiningPower sums fitted mining modules and treats unknown power as 0 (a lower bound)", () => {
    expect(totalMiningPower([laser100, laser5])).toBe(105);
    expect(totalMiningPower([laser100, { typeId: "gas_harvester_i", type: "mining", slot: "utility" }])).toBe(100);
    expect(totalMiningPower(undefined)).toBe(0);
    expect(totalMiningPower([{ typeId: "shield_i", type: "defense", slot: "defense" }])).toBe(0);
  });

  test("miningEquipmentKey is order-stable over the MINING fit only, undefined without one", () => {
    expect(miningEquipmentKey([laser100, laser5])).toBe("mining_laser_i+mining_laser_iv");
    expect(miningEquipmentKey([laser5, laser100])).toBe("mining_laser_i+mining_laser_iv");
    expect(miningEquipmentKey([{ typeId: "shield_i", type: "defense", slot: "defense" }])).toBeUndefined();
    expect(miningEquipmentKey(undefined)).toBeUndefined();
  });
});

describe("deterministic mine deposit guard (#188 part 2)", () => {
  test("blocks WITHOUT the doomed call when the array over-powers every deposit, numbers + relocate steer in the reason", async () => {
    const { api, calls } = stubApi({
      modules: [laser100],
      deposits: async () => belt("gr_fields", [
        { resourceId: "gold_ore", supportedPower: 24 },
        { resourceId: "carbon_ore", supportedPower: 10 },
      ]),
    });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain("too sparse");           // classifies to the taxonomy's too_sparse class
    expect(reason).toContain("relocate");             // steer survives the digest's 200-char clip (front-loaded)
    expect(reason).toContain(`mining_power 100`);
    expect(reason).toContain(`${SPARSE_LOCK_MULTIPLIER}x`);
    expect(reason).toContain("richest 24");
    expect(calls.length).toBe(0);                     // the tick was saved
  });

  test("allows the mine when ANY deposit can feed the array (boundary: power == 4x support)", async () => {
    const { api, calls } = stubApi({
      modules: [laser100],
      deposits: async () => belt("gr_fields", [
        { resourceId: "gold_ore", supportedPower: 24 },
        { resourceId: "iron_ore", supportedPower: 25 }, // 100 <= 4x25 -> lockable
      ]),
    });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("continue");
    expect(calls).toEqual([{ name: "mine" }]);
  });

  test("fail-open: one deposit with UNKNOWN supported_power disarms the block (it might feed the array)", async () => {
    const { api, calls } = stubApi({
      modules: [laser100],
      deposits: async () => belt("gr_fields", [
        { resourceId: "gold_ore", supportedPower: 24 },
        { resourceId: "mystery_ore" }, // supported_power absent
      ]),
    });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("continue");
    expect(calls).toEqual([{ name: "mine" }]);
  });

  test("fail-open: unknown array power, missing getPoiDeposits, and a thrown fetch all skip the guard", async () => {
    // unknown fitted power (modules absent entirely would trip the no-laser
    // guard, so use a mining module with no reported power)
    const unknownPower = stubApi({
      modules: [{ typeId: "mining_laser_x", type: "mining", slot: "utility" }],
      deposits: async () => belt("gr_fields", [{ resourceId: "gold_ore", supportedPower: 1 }]),
    });
    expect((await executeTick(unknownPower.api, minePlan, { step: 0, iteration: 0 })).kind).toBe("continue");

    const noApi = stubApi({ modules: [laser100] }); // no getPoiDeposits at all
    expect((await executeTick(noApi.api, minePlan, { step: 0, iteration: 0 })).kind).toBe("continue");

    const throwing = stubApi({ modules: [laser100], deposits: async () => { throw new Error("down"); } });
    expect((await executeTick(throwing.api, minePlan, { step: 0, iteration: 0 })).kind).toBe("continue");
  });

  test("fires on the step's FIRST submission only -- no get_poi on repeat iterations", async () => {
    const { api, depositCalls } = stubApi({
      modules: [laser100],
      deposits: async () => belt("gr_fields", [{ resourceId: "gold_ore", supportedPower: 25 }]),
    });
    await executeTick(api, minePlan, { step: 0, iteration: 0 });
    expect(depositCalls()).toBe(1);
    await executeTick(api, minePlan, { step: 0, iteration: 3 });
    expect(depositCalls()).toBe(1); // unchanged: iteration > 0 skips the fetch
  });
});

describe("learned sparse-rule refusal (#188 part 3)", () => {
  const rule: LearnedSparseRule = {
    poiId: "gr_fields",
    equipmentKey: "mining_laser_iv",
    detail: "Deposits here are too sparse for your mining array",
  };
  // Live data undecidable: supported_power absent from the entry.
  const undecidable = async () => belt("gr_fields", [{ resourceId: "gold_ore" }]);

  test("refuses the exact (poi, mining-fit) repeat with a self-describing reason, no call spent", async () => {
    const { api, calls } = stubApi({ modules: [laser100], deposits: undecidable });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 }, undefined, [rule]);
    expect(r.kind).toBe("blocked");
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain("learned");
    expect(reason).toContain("gr_fields");
    expect(reason).toContain("relocate");
    expect(reason).toContain("too sparse"); // cites the game's own lesson
    expect(calls.length).toBe(0);
  });

  test("a DIFFERENT mining fit does not match the learned rule (refit is a real escape)", async () => {
    const { api, calls } = stubApi({ modules: [laser5], deposits: undecidable });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 }, undefined, [rule]);
    expect(r.kind).toBe("continue");
    expect(calls).toEqual([{ name: "mine" }]);
  });

  test("a different POI does not match the learned rule (never a generalization)", async () => {
    const { api, calls } = stubApi({
      modules: [laser100],
      deposits: async () => belt("other_belt", [{ resourceId: "gold_ore" }]),
    });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 }, undefined, [rule]);
    expect(r.kind).toBe("continue");
    expect(calls).toEqual([{ name: "mine" }]);
  });

  test("fresh live data proving a lockable deposit OVERRIDES the learned rule (capture beats lesson)", async () => {
    const { api, calls } = stubApi({
      modules: [laser100],
      deposits: async () => belt("gr_fields", [{ resourceId: "gold_ore", supportedPower: 25 }]),
    });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 }, undefined, [rule]);
    expect(r.kind).toBe("continue");
    expect(calls).toEqual([{ name: "mine" }]);
  });

  test("no poi id in the response -> the learned check fails open", async () => {
    const { api, calls } = stubApi({
      modules: [laser100],
      deposits: async () => ({ poiId: undefined, deposits: [{ resourceId: "gold_ore" }] }),
    });
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 }, undefined, [rule]);
    expect(r.kind).toBe("continue");
    expect(calls).toEqual([{ name: "mine" }]);
  });
});
