import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTick } from "../src/agent/executor";
import { failureClass } from "../src/server/failures";
import { UNTRUSTED_TEXT_SNIPPET_LEN } from "../src/planner/digest";
import type { GameApi, StatusSnapshot, StorageItem } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// withdraw storage-contents guard (issue #706).
//
// The reported symptom was "withdraw fails 100% with insufficient_storage",
// with a parenthetical asserting the cause. The code is undocumented, and its
// NAME reads two opposite ways -- a shortfall in the locker, or (as in HTTP
// 507) no room at the destination -- which need opposite fixes. The live
// capture from the production miner's event store settles it; all 21
// occurrences between 2026-09-05 and 2026-09-09 read:
//
//     insufficient_storage: Storage only has 0 x nickel_ore.
//     Use 'view_storage' to check.
//
// A source-side shortfall. These tests pin the guard that stops the doomed
// call, and -- just as load-bearing -- the three ways it must NOT fire.
//
// Deliberately NOT tested: that storage.view is registered with the params the
// OpenAPI declares (a restatement of actions.ts, already covered there), or
// that guard:true routes a refusal into failureTaxonomy's `prevented` table
// (the mechanism is generic and test/failures.test.ts:295-319 already pins it;
// a second copy keyed to this guard would prove nothing new).

type Overrides = {
  storage?: readonly StorageItem[] | undefined;
  storageThrows?: boolean;
  omitStorageApi?: boolean;
  docked?: boolean;
};

const BASE: StatusSnapshot = {
  credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

function stubApi(o: Overrides = {}) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  let storageLookups = 0;
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() {
      return { ...BASE, docked: o.docked ?? true };
    },
    async notifications() { return []; },
    ...(o.omitStorageApi ? {} : {
      async getStorage() {
        storageLookups++;
        if (o.storageThrows) throw new Error("storage unreadable");
        return o.storage;
      },
    }),
  };
  return { api, calls, lookups: () => storageLookups };
}

const withdraw = (params: Record<string, unknown>): Plan =>
  ({ goal: "g", steps: [{ action: "withdraw", params }] });

const held = (itemId: string, quantity: number): StorageItem => ({ itemId, quantity });

describe("withdraw storage guard: the refusals #706 asks for", () => {
  // The headline case, and the one the live capture is of: the locker is
  // EMPTY. Catches shipped-today behaviour, where 21 of these reached the game.
  //
  // `[]` is the hard half. A guard that read an empty array as UNKNOWN would
  // look more cautious and would fail open on the exact state behind every one
  // of the 21 refusals. The call-count assertion is what makes this a guard
  // test rather than a wording test -- `blocked` alone is also satisfied by
  // something that refuses AFTER spending the tick.
  test("an empty locker refuses the withdraw before the call goes out", async () => {
    const { api, calls, lookups } = stubApi({ storage: [] });
    const r = await executeTick(api, withdraw({ item_id: "nickel_ore", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.guard).toBe(true); // #571/#581: OUR refusal, not the game's
    expect(r.kind === "blocked" && r.reason).toContain("storage holds 0, not 10");
    expect(calls.length).toBe(0);
    expect(lookups()).toBe(1);
  });

  // A stocked locker that simply lacks this item. Distinct from the empty case:
  // it proves the guard matches on item identity, not merely on emptiness.
  test("a stocked locker missing the requested item refuses it", async () => {
    const { api, calls } = stubApi({ storage: [held("iron_ore", 40), held("copper_wiring", 5)] });
    const r = await executeTick(api, withdraw({ item_id: "nickel_ore", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("storage holds 0, not 10");
    expect(calls.length).toBe(0);
  });

  // Quantity, not presence. Catches a guard that stops at "is it there at all"
  // and waves through a withdraw for more than the locker holds -- the same
  // guaranteed `insufficient_storage`, whose live text ("only has 0 x") reports
  // a COUNT precisely because the game compares counts.
  test("holding fewer than requested refuses it", async () => {
    const { api, calls } = stubApi({ storage: [held("nickel_ore", 3)] });
    const r = await executeTick(api, withdraw({ item_id: "nickel_ore", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("storage holds 3, not 10");
    expect(calls.length).toBe(0);
  });
});

describe("withdraw storage guard: the withdrawals it must let through", () => {
  // The #221 deposit -> craft -> withdraw loop is the whole reason withdraw is
  // registered. Catches an off-by-one that refuses an exactly-sufficient
  // holding, which would deadlock the crafting loop this action exists for.
  test.each([
    ["exactly enough", 10],
    ["more than enough", 40],
  ])("a locker holding %s sends the withdraw", async (_label, stock) => {
    const { api, calls } = stubApi({ storage: [held("nickel_ore", stock)] });
    const r = await executeTick(api, withdraw({ item_id: "nickel_ore", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("plan_done");
    expect(calls.map((c) => c.name)).toEqual(["withdraw"]);
  });

  // Fail-open, the direction that matters most. An unreadable locker is not an
  // empty one: reading it as empty would refuse EVERY withdraw for as long as
  // the response stayed unparsed, and a wasted tick is far cheaper than a
  // capability deadlocked on missing data.
  //
  // All three unknown-shaped inputs, because they arrive by different routes
  // and a fix for one does not imply the others: a response that is not a
  // personal-storage listing (undefined), a query that throws, and a GameApi
  // with no getStorage at all (every fake and mock in this suite predating it).
  test.each([
    ["the response is not a storage listing", { storage: undefined }],
    ["the query throws", { storageThrows: true }],
    ["the api has no getStorage", { omitStorageApi: true }],
  ])("withdraw goes through when %s", async (_label, overrides: Overrides) => {
    const { api, calls } = stubApi(overrides);
    const r = await executeTick(api, withdraw({ item_id: "nickel_ore", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("plan_done");
    expect(calls.map((c) => c.name)).toEqual(["withdraw"]);
  });

  // Ordering. The docked check is free (it reads the snapshot already in hand),
  // so an undocked withdraw must be refused on that, and must not spend the
  // storage query to be told the same thing. Catches a reorder that puts the
  // paid check first.
  test("an undocked withdraw is refused on docking, with no storage lookup", async () => {
    const { api, calls, lookups } = stubApi({ docked: false, storage: [] });
    const r = await executeTick(api, withdraw({ item_id: "nickel_ore", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("must be DOCKED");
    expect(calls.length).toBe(0);
    expect(lookups()).toBe(0);
  });
});

describe("withdraw storage guard: the refusal text the planner actually reads", () => {
  // digest.ts clips a blocked wake's detail at 200 chars before the planner
  // sees it, and the #757 change shipped three reasons at 250-295 that lost
  // their remedy half to that clip. Measured against the REAL catalog's longest
  // item id and a six-digit quantity, not eyeballed and not against a
  // hand-picked short id.
  test("the refusal survives the digest clip at the worst case the catalog allows", async () => {
    const data = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "src/catalog/catalog.data.json"), "utf8"),
    ) as { items: Array<{ id?: unknown }> };
    const longest = data.items
      .map((i) => i.id)
      .filter((id): id is string => typeof id === "string")
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    expect(longest.length).toBeGreaterThan(20); // the catalog really was read

    const { api } = stubApi({ storage: [] });
    const r = await executeTick(api, withdraw({ item_id: longest, quantity: 999999 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason.length).toBeLessThanOrEqual(UNTRUSTED_TEXT_SNIPPET_LEN);
    // The three things that must survive: the id inside a complete command,
    // the quantity, and the producer steer. A length cap alone would be
    // satisfied by a reason truncated to nothing useful.
    expect(reason).toContain(`deposit{item_id=${longest}, quantity=999999}`);
    expect(reason).toContain("a pending buy order stores nothing");
  });

  // Our refusal must never wear the game's own error code. failures.ts routes a
  // leading `snake_case:` prefix straight into a class name, so a reword that
  // opened with "insufficient_storage:" would file our prevented steps under
  // the identical class the GAME's refusals use -- the #571/#581 confusion that
  // had a working guard reported as a broken capability.
  test("the refusal does not classify as the game's insufficient_storage", async () => {
    const { api } = stubApi({ storage: [] });
    const r = await executeTick(api, withdraw({ item_id: "nickel_ore", quantity: 10 }), { step: 0, iteration: 0 });
    const reason = r.kind === "blocked" ? r.reason : "";
    // Through the real classifier, never a copy of its regex: a duplicated
    // pattern goes on passing after the producer changes.
    expect(failureClass(reason)).not.toBe("insufficient_storage");
  });

  // The tier-3 normalizer keys a class on the first 60 normalized chars, so the
  // item id has to stay OUT of that window or every item gets its own row and
  // the prevented table fragments per item -- the exact fragmentation
  // failures.ts's normalizer exists to prevent.
  test("two different items refuse under one failure class", async () => {
    const reasons: string[] = [];
    for (const id of ["nickel_ore", "contained_highly_enriched_uranium"]) {
      const { api } = stubApi({ storage: [] });
      const r = await executeTick(api, withdraw({ item_id: id, quantity: 10 }), { step: 0, iteration: 0 });
      reasons.push(r.kind === "blocked" ? r.reason : "");
    }
    expect(reasons[0]).not.toBe(reasons[1]); // the two really did differ
    expect(failureClass(reasons[0]!)).toBe(failureClass(reasons[1]!));
  });
});
