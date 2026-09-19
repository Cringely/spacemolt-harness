import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTick, BUY_PRICE_SANITY_MULTIPLIER } from "../src/agent/executor";
import { UNTRUSTED_TEXT_SNIPPET_LEN } from "../src/planner/digest";
import type { GameApi, PurchaseCostEstimate, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Buy price-sanity guard (issue #458).
//
// Three live incidents drove this: 10 titanium_ore for 100,500cr (~400x a
// 25cr catalog base, resold minutes later for 500cr), 12 more titanium_ore
// for 120,600cr at the same ~400x ask, and 49 fuel_cell for 220,108cr against
// a 43cr base (~104x) -- 89% of the pilot's gross earnings that window. Every
// price below is a REAL catalog value (src/catalog/catalog.data.json), not a
// stand-in, so the guard is pinned against the numbers that actually burned
// credits rather than a synthetic item the guard could special-case.
//
// Deliberately NOT tested: that `buy` is registered with the params the
// registry declares (actions.ts, already covered there), or that guard:true
// routes into failureTaxonomy's `prevented` table (generic, already pinned in
// test/failures.test.ts and test/executor-withdraw-storage.test.ts).

type Overrides = {
  totalCost?: number;
  quantityRequested?: number;
  itemId?: string;
  estimateThrows?: boolean;
  omitEstimateApi?: boolean;
};

const BASE: StatusSnapshot = {
  credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

function stubApi(o: Overrides = {}) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  let estimateLookups = 0;
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() {
      return { ...BASE };
    },
    async notifications() { return []; },
    ...(o.omitEstimateApi ? {} : {
      async estimatePurchaseCost(): Promise<PurchaseCostEstimate | undefined> {
        estimateLookups++;
        if (o.estimateThrows) throw new Error("estimate unreadable");
        if (o.totalCost === undefined && o.quantityRequested === undefined && o.itemId === undefined) {
          return undefined;
        }
        return { itemId: o.itemId, quantityRequested: o.quantityRequested, totalCost: o.totalCost };
      },
    }),
  };
  return { api, calls, lookups: () => estimateLookups };
}

const buy = (id: string, quantity: number): Plan =>
  ({ goal: "g", steps: [{ action: "buy", params: { id, quantity } }] });

describe("buy price-sanity guard: the incidents it exists to stop", () => {
  // The larger of the two titanium_ore incidents (#458): 12 units for
  // 120,600cr against a real 25cr catalog base -- 4,020cr/unit, ~161x.
  test("titanium_ore at ~161x catalog base is refused before the buy goes out", async () => {
    const { api, calls, lookups } = stubApi({ itemId: "titanium_ore", quantityRequested: 12, totalCost: 120_600 });
    const r = await executeTick(api, buy("titanium_ore", 12), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.guard).toBe(true); // OUR refusal, not the game's
    expect(r.kind === "blocked" && r.reason).toContain("over 8x catalog value 25cr");
    expect(r.kind === "blocked" && r.reason).toContain("create_buy_order{item_id=titanium_ore, quantity=12");
    expect(calls.length).toBe(0); // the buy itself never reached the game
    expect(lookups()).toBe(1); // one free query, not a retry loop
  });

  // The fuel_cell incident (#458, "third incident"): 49 units for 220,108cr
  // against a real 43cr catalog base -- ~4,492cr/unit, ~104x.
  test("fuel_cell at ~104x catalog base is refused before the buy goes out", async () => {
    const { api, calls } = stubApi({ itemId: "fuel_cell", quantityRequested: 49, totalCost: 220_108 });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("over 8x catalog value 43cr");
    expect(calls.length).toBe(0);
  });
});

describe("buy price-sanity guard: the buys it must let through", () => {
  // The issue's own positive control: Mining Laser III bought the same night
  // for 13,458cr against a real 7,900cr base -- ~1.7x, a legitimate premium
  // the guard must not treat as absurd.
  test("Mining Laser III at ~1.7x catalog base (the issue's positive control) is not refused", async () => {
    const { api, calls } = stubApi({ itemId: "mining_laser_iii", quantityRequested: 1, totalCost: 13_458 });
    const r = await executeTick(api, buy("mining_laser_iii", 1), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(calls.map((c) => c.name)).toEqual(["buy"]);
  });

  // Boundary: exactly BUY_PRICE_SANITY_MULTIPLIER x base_value must pass --
  // the guard blocks only what CLEARS the ceiling (`perUnit <= ceiling` skips
  // the guard), so an off-by-one that used `<` here would refuse a buy priced
  // at exactly the stated multiplier, one this guard's own reason text
  // advertises as the line.
  test("exactly BUY_PRICE_SANITY_MULTIPLIER x base_value is not refused", async () => {
    // titanium_ore base_value is 25cr; 8x25 = 200cr total for 1 unit.
    const ceiling = 25 * BUY_PRICE_SANITY_MULTIPLIER;
    const { api } = stubApi({ itemId: "titanium_ore", quantityRequested: 1, totalCost: ceiling });
    const r = await executeTick(api, buy("titanium_ore", 1), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
  });

  // One credit over the ceiling refuses -- the boundary's other side, so the
  // two tests together pin the exact threshold rather than "somewhere near 8x".
  test("one credit over BUY_PRICE_SANITY_MULTIPLIER x base_value is refused", async () => {
    const ceiling = 25 * BUY_PRICE_SANITY_MULTIPLIER;
    const { api } = stubApi({ itemId: "titanium_ore", quantityRequested: 1, totalCost: ceiling + 1 });
    const r = await executeTick(api, buy("titanium_ore", 1), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
  });

  // Fail-open, the direction that matters most: an unreadable estimate is not
  // proof of an absurd price. Four unknown-shaped inputs, each arriving by a
  // different route and each a distinct failure mode a fix for one does not
  // imply the others: no capability at all (every fake/mock predating this
  // guard), a query that throws, a response that parsed but carried no cost
  // fields, and an item the catalog has no base_value for (nothing to compare
  // against, so the estimate is moot either way).
  test.each([
    ["the api has no estimatePurchaseCost", { omitEstimateApi: true }],
    ["the query throws", { estimateThrows: true }],
    ["the response carries no cost fields", {}],
  ])("buy goes through when %s", async (_label, overrides: Overrides) => {
    const { api, calls } = stubApi(overrides);
    const r = await executeTick(api, buy("titanium_ore", 12), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(calls.map((c) => c.name)).toEqual(["buy"]);
  });

  test("an item absent from the catalog is not price-checked at all", async () => {
    // "not_a_real_catalog_item" has no base_value entry, so there is no floor
    // to compare an estimate against -- the guard must not invent one.
    const { api, lookups } = stubApi({ itemId: "not_a_real_catalog_item", quantityRequested: 1, totalCost: 999_999 });
    const r = await executeTick(api, buy("not_a_real_catalog_item", 1), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(lookups()).toBe(0); // never spent the query: the catalog check comes first
  });

  // Rationing: a repeat submission of the SAME buy step (executeOne re-firing
  // after e.g. a transient block) must not re-spend the free query -- only
  // the step's first submission (cursor.iteration === 0) prices it, the same
  // rationing mineDepositBlock's call site uses for `mine`.
  test("a repeat submission of the same buy step does not re-query the estimate", async () => {
    const { api, lookups } = stubApi({ itemId: "titanium_ore", quantityRequested: 12, totalCost: 120_600 });
    const r = await executeTick(api, buy("titanium_ore", 12), { step: 0, iteration: 1 });
    expect(r.kind).not.toBe("blocked"); // the guard never ran, so nothing refused it
    expect(lookups()).toBe(0);
  });
});

describe("buy price-sanity guard: the refusal text the planner actually reads", () => {
  // digest.ts clips a blocked wake's detail at 200 chars on the NEXT replan
  // (UNTRUSTED_TEXT_SNIPPET_LEN) -- the same measured-not-eyeballed check
  // test/executor-withdraw-storage.test.ts runs for its own guard, against the
  // REAL catalog's longest item id and a six-digit quantity/price, not a
  // hand-picked short case.
  test("the refusal survives the digest clip at the worst case the catalog allows", async () => {
    const data = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "src/catalog/catalog.data.json"), "utf8"),
    ) as { items: Array<{ id?: unknown }> };
    const longest = data.items
      .map((i) => i.id)
      .filter((id): id is string => typeof id === "string")
      .reduce((a, b) => (b.length > a.length ? b : a), "");
    expect(longest.length).toBeGreaterThan(20); // the catalog really was read

    const { api } = stubApi({ itemId: longest, quantityRequested: 999_999, totalCost: 999_999_000_000 });
    const r = await executeTick(api, buy(longest, 999_999), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason.length).toBeLessThanOrEqual(UNTRUSTED_TEXT_SNIPPET_LEN);
    // Both halves must survive: the refusal number and the remedy command.
    expect(reason).toContain("over 8x catalog value");
    expect(reason).toContain(`create_buy_order{item_id=${longest}, quantity=999999, price_each=<price>}`);
  });
});
