import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executeTick, BUY_PRICE_SANITY_MULTIPLIER } from "../src/agent/executor";
import { UNTRUSTED_TEXT_SNIPPET_LEN } from "../src/planner/digest";
import type { CurrentPoiInfo, GameApi, PurchaseCostEstimate, StatusSnapshot, SystemInfo } from "../src/client/client";
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
  unfilled?: number;
  estimateThrows?: boolean;
  omitEstimateApi?: boolean;
  // Fuel_cell refuel-steer overrides (issue #1116). currentPoi feeds
  // getSystem()'s response; omitGetSystemApi/getSystemThrows exercise the
  // guard's fail-open paths the same way estimateThrows/omitEstimateApi do
  // above. docked defaults true (BASE), same as every other test in this
  // file -- only the undocked test overrides it.
  currentPoi?: CurrentPoiInfo;
  omitGetSystemApi?: boolean;
  getSystemThrows?: boolean;
  docked?: boolean;
};

const BASE: StatusSnapshot = {
  credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

function stubApi(o: Overrides = {}) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  let estimateLookups = 0;
  let getSystemLookups = 0;
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() {
      return { ...BASE, docked: o.docked ?? BASE.docked };
    },
    async notifications() { return []; },
    ...(o.omitEstimateApi ? {} : {
      async estimatePurchaseCost(): Promise<PurchaseCostEstimate | undefined> {
        estimateLookups++;
        if (o.estimateThrows) throw new Error("estimate unreadable");
        if (o.totalCost === undefined && o.quantityRequested === undefined) {
          return undefined;
        }
        return { quantityRequested: o.quantityRequested, totalCost: o.totalCost, unfilled: o.unfilled };
      },
    }),
    ...(o.omitGetSystemApi ? {} : {
      async getSystem(): Promise<SystemInfo> {
        getSystemLookups++;
        if (o.getSystemThrows) throw new Error("system unreadable");
        return { id: "sys1", name: "System", connections: [], pois: [], currentPoi: o.currentPoi };
      },
    }),
  };
  return {
    api, calls,
    lookups: () => estimateLookups,
    getSystemCalls: () => getSystemLookups,
  };
}

const buy = (id: string, quantity: number): Plan =>
  ({ goal: "g", steps: [{ action: "buy", params: { id, quantity } }] });

describe("buy price-sanity guard: the incidents it exists to stop", () => {
  // The larger of the two titanium_ore incidents (#458): 12 units for
  // 120,600cr against a real 25cr catalog base -- 4,020cr/unit, ~161x.
  test("titanium_ore at ~161x catalog base is refused before the buy goes out", async () => {
    const { api, calls, lookups } = stubApi({ quantityRequested: 12, totalCost: 120_600 });
    const r = await executeTick(api, buy("titanium_ore", 12), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.guard).toBe(true); // OUR refusal, not the game's
    expect(r.kind === "blocked" && r.reason).toContain("over 8x catalog value 25cr");
    expect(r.kind === "blocked" && r.reason).toContain("create_buy_order for titanium_ore");
    expect(calls.length).toBe(0); // the buy itself never reached the game
    expect(lookups()).toBe(1); // one free query, not a retry loop
  });

  // The fuel_cell incident (#458, "third incident"): 49 units for 220,108cr
  // against a real 43cr catalog base -- ~4,492cr/unit, ~104x.
  test("fuel_cell at ~104x catalog base is refused before the buy goes out", async () => {
    const { api, calls } = stubApi({ quantityRequested: 49, totalCost: 220_108 });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("over 8x catalog value 43cr");
    expect(calls.length).toBe(0);
  });

  // Partial-fill dilution (review finding on this same issue): the book only
  // had 5 fuel_cell at ~104x base (4,492cr/unit) to sell, the plan requested
  // 70, and estimate_purchase prices only what it can actually FILL --
  // total_cost 22,460cr for 5 units, unfilled 65. Dividing by the REQUESTED
  // 70 (22,460/70 = 321cr/unit) reads as under the 344cr ceiling and lets the
  // buy through; dividing by the FILLED 5 (22,460/5 = 4,492cr/unit) catches
  // the same ~104x ask the undiluted incident above catches.
  test("a partial fill is priced by the FILLED quantity, not the requested one", async () => {
    const { api, calls } = stubApi({ quantityRequested: 70, totalCost: 22_460, unfilled: 65 });
    const r = await executeTick(api, buy("fuel_cell", 70), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("over 8x catalog value 43cr");
    expect(calls.length).toBe(0);
  });

  // Fail-open twin: unfilled >= the requested quantity means NOTHING filled,
  // so there is no per-unit price to compare -- the guard must skip rather
  // than divide by zero or a negative number.
  test("nothing filled at all (unfilled === quantity_requested) is not price-checked", async () => {
    const { api, lookups } = stubApi({ quantityRequested: 70, totalCost: 0, unfilled: 70 });
    const r = await executeTick(api, buy("fuel_cell", 70), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(lookups()).toBe(1); // the query ran; the guard just had nothing to check
  });
});

describe("buy price-sanity guard: the buys it must let through", () => {
  // The issue's own positive control: Mining Laser III bought the same night
  // for 13,458cr against a real 7,900cr base -- ~1.7x, a legitimate premium
  // the guard must not treat as absurd.
  test("Mining Laser III at ~1.7x catalog base (the issue's positive control) is not refused", async () => {
    const { api, calls } = stubApi({ quantityRequested: 1, totalCost: 13_458 });
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
    const { api } = stubApi({ quantityRequested: 1, totalCost: ceiling });
    const r = await executeTick(api, buy("titanium_ore", 1), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
  });

  // One credit over the ceiling refuses -- the boundary's other side, so the
  // two tests together pin the exact threshold rather than "somewhere near 8x".
  test("one credit over BUY_PRICE_SANITY_MULTIPLIER x base_value is refused", async () => {
    const ceiling = 25 * BUY_PRICE_SANITY_MULTIPLIER;
    const { api } = stubApi({ quantityRequested: 1, totalCost: ceiling + 1 });
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
    const { api, lookups } = stubApi({ quantityRequested: 1, totalCost: 999_999 });
    const r = await executeTick(api, buy("not_a_real_catalog_item", 1), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(lookups()).toBe(0); // never spent the query: the catalog check comes first
  });

  // Reversed from the guard's original iteration-0-only shape (review finding
  // on this same issue): a repeat/until buy re-enters this same step and buys
  // fresh units deeper in the book, so a later iteration is priced and
  // refused exactly like the first -- unlike mineDepositBlock's mine guard,
  // which stays iteration-0-only because the game's own error reports
  // mid-run depletion the moment it happens; an overpriced buy has no such
  // error, it just succeeds.
  test("a repeat iteration of the same buy step is priced and blocked like the first", async () => {
    const { api, calls, lookups } = stubApi({ quantityRequested: 12, totalCost: 120_600 });
    const r = await executeTick(api, buy("titanium_ore", 12), { step: 0, iteration: 1 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("over 8x catalog value 25cr");
    expect(calls.length).toBe(0); // the buy itself never reached the game
    expect(lookups()).toBe(1); // the guard ran again on this iteration
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

    const { api } = stubApi({ quantityRequested: 999_999, totalCost: 999_999_000_000 });
    const r = await executeTick(api, buy(longest, 999_999), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason.length).toBeLessThanOrEqual(UNTRUSTED_TEXT_SNIPPET_LEN);
    // Both halves must survive: the refusal number and the remedy.
    expect(reason).toContain("over 8x catalog value");
    expect(reason).toContain(`create_buy_order for ${longest}`);
  });

  // Issue #1116: the remedy used to render as
  // `create_buy_order{item_id=<id>, quantity=<qty>, price_each=<price>}` -- a
  // filled-in, action-name-followed-by-brace command the planner could copy
  // and send verbatim. That is the exact shape issue #681 already burned this
  // project for (the GAME's own item_not_available error shipped a filled
  // create_buy_order template and it was obeyed six times, locking ~21,800cr).
  // This asserts the refusal never renders ANY action{param=...} template
  // form, regardless of which item or branch produced it -- a regex, not a
  // substring, so it also catches a future guard reintroducing the shape
  // under a different action name. Ablated: reverting buyPriceGuard's reason
  // strings to the pre-#1116 `create_buy_order{item_id=...}` text fails this
  // test (checked against the old text above before it was rewritten).
  test("the refusal never renders an action-name-followed-by-brace template", async () => {
    const { api } = stubApi({ quantityRequested: 12, totalCost: 120_600 });
    const r = await executeTick(api, buy("titanium_ore", 12), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).not.toMatch(/[a-z_]+\{[a-z_]+\s*=/i);
  });
});

describe("buy price-sanity guard: the fuel_cell refuel steer (issue #1116)", () => {
  // Docked, and get_system's current POI reports a base -- the harness's own
  // established "the docked reflex can refuel here" signal (client.ts's
  // CurrentPoiInfo comment, agent.ts's stall-watcher currentPoiHasBase). The
  // refusal steers to refuel instead of a buy order: refuel spends straight
  // from the wallet, a buy order escrows the bid until a seller fills it, and
  // a pilot rescued with just enough credits to refuel could lock that
  // balance in a dead bid and strand itself again (#703 x #681).
  test("docked with a confirmed station base steers to refuel, not create_buy_order", async () => {
    const { api } = stubApi({
      quantityRequested: 49, totalCost: 220_108,
      currentPoi: { id: "poi1", name: "Station", type: "station", hasBase: true },
    });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).toContain("Refuel here instead");
    expect(reason).not.toContain("create_buy_order");
  });

  // Same signal, the fuel_reserve half: no has_base, but a positive
  // fuel_reserve at the current POI is the same trusted "can refuel" proof
  // (client.ts's CurrentPoiInfo comment).
  test("docked with a positive fuel_reserve at the current POI also steers to refuel", async () => {
    const { api } = stubApi({
      quantityRequested: 49, totalCost: 220_108,
      currentPoi: { id: "poi1", name: "Station", type: "station", fuelReserve: 40 },
    });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).toContain("Refuel here instead");
  });

  // Docked, but get_system reports neither has_base nor a positive
  // fuel_reserve at the current POI -- the harness's own signal says NO
  // station pump here, so the refusal falls back to the generic
  // create_buy_order remedy rather than steering somewhere that will fail.
  test("docked with no confirmed base falls back to the generic remedy", async () => {
    const { api } = stubApi({
      quantityRequested: 49, totalCost: 220_108,
      currentPoi: { id: "poi1", name: "Belt", type: "belt", hasBase: false, fuelReserve: 0 },
    });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).toContain("create_buy_order for fuel_cell");
    expect(reason).not.toContain("Refuel here instead");
  });

  // Fail-open, the direction that matters most (#94): no getSystem capability
  // at all means the guard cannot ask the question, so it must not claim an
  // answer either way -- it names BOTH remedies in prose rather than
  // asserting refuel will work.
  test("no getSystem capability names both remedies rather than asserting either", async () => {
    const { api } = stubApi({
      quantityRequested: 49, totalCost: 220_108, omitGetSystemApi: true,
    });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).toContain("refuel");
    expect(reason).toContain("create_buy_order for fuel_cell");
  });

  // Fail-open twin: a getSystem query that throws is UNKNOWN, not "no base
  // here" -- same convention as every other guard's query failure.
  test("a getSystem query that throws names both remedies rather than assuming no base", async () => {
    const { api } = stubApi({
      quantityRequested: 49, totalCost: 220_108, getSystemThrows: true,
    });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).toContain("refuel");
    expect(reason).toContain("create_buy_order for fuel_cell");
  });

  // Undocked: refuel is never offered as a remedy for a ship that is not at
  // a station at all -- falls back to the generic create_buy_order remedy,
  // and the guard must not spend a getSystem query to find out (docked is
  // decidable for free from the snapshot already in hand).
  test("undocked never steers to refuel, and spends no getSystem query", async () => {
    const { api, getSystemCalls } = stubApi({
      quantityRequested: 49, totalCost: 220_108,
      currentPoi: { id: "poi1", name: "Station", type: "station", hasBase: true },
      docked: false,
    });
    const r = await executeTick(api, buy("fuel_cell", 49), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).toContain("create_buy_order for fuel_cell");
    expect(reason).not.toContain("Refuel here instead");
    expect(getSystemCalls()).toBe(0);
  });

  // A non-fuel_cell item never gets the refuel steer, confirmed base or not
  // -- the steer is scoped to fuel specifically (issue #1116's own scope),
  // and no getSystem query is spent finding that out.
  test("a non-fuel_cell item never steers to refuel, and spends no getSystem query", async () => {
    const { api, getSystemCalls } = stubApi({
      quantityRequested: 12, totalCost: 120_600,
      currentPoi: { id: "poi1", name: "Station", type: "station", hasBase: true },
    });
    const r = await executeTick(api, buy("titanium_ore", 12), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason).not.toContain("refuel");
    expect(getSystemCalls()).toBe(0);
  });
});
