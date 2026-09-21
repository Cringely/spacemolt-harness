import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { UNTRUSTED_TEXT_SNIPPET_LEN } from "../src/planner/digest";
import type { GameApi, StatusSnapshot, StorageItem } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Craft deposit-precondition guard (issue #1076, dupes #932/#997).
//
// Three separate 72h scheduler windows filed the identical cannot_craft
// failure (98, 24, 35 occurrences), all the same game text:
//
//     cannot_craft: Not enough materials in your station storage to craft
//     this. Deposit the inputs into station storage first (crafting no
//     longer pulls from cargo).
//
// No brokenCapabilities entry accompanies any of them -- craft succeeds
// elsewhere -- so this is a planner-comprehension gap the guard backstops
// for the one provable case: personal storage read as [], which cannot
// supply ANY recipe's materials. A stocked-but-short locker is NOT provable
// without a per-recipe input list this codebase has no producer for, and the
// guard fails open on it, same as every guard in this file.

type Overrides = {
  storage?: readonly StorageItem[] | undefined;
  storageThrows?: boolean;
  omitStorageApi?: boolean;
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
      return { ...BASE };
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

const craft = (params: Record<string, unknown>): Plan =>
  ({ goal: "g", steps: [{ action: "craft", params }] });

const held = (itemId: string, quantity: number): StorageItem => ({ itemId, quantity });

describe("craft deposit guard: the refusal #1076 asks for", () => {
  // The headline case, and the one every one of the 98+24+35 live refusals
  // matches: storage never received the deposit. `[]` is KNOWLEDGE (a
  // real, well-formed empty locker), not UNKNOWN -- same three-valued
  // reading getStorage's own doc comment establishes for withdrawStorageBlock.
  test("empty storage refuses the craft before the call goes out", async () => {
    const { api, calls, lookups } = stubApi({ storage: [] });
    const r = await executeTick(api, craft({ id: "iron_plates", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.guard).toBe(true);
    expect(r.kind === "blocked" && r.reason).toContain("deposit{item_id=<material>, quantity=<n>}");
    expect(r.kind === "blocked" && r.reason).toContain("craft{id=iron_plates}");
    expect(calls.length).toBe(0);
    expect(lookups()).toBe(1);
  });

  // A stocked-but-irrelevant locker is NOT a provable shortfall: the guard
  // has no recipe-inputs producer to compare against, so it must fail open
  // rather than guess. Catches a guard that (wrongly) blocks on "storage
  // doesn't hold enough of item X" without ever knowing what X is.
  test("a non-empty locker of unrelated items lets the craft through", async () => {
    const { api, calls } = stubApi({ storage: [held("copper_wiring", 3)] });
    const r = await executeTick(api, craft({ id: "iron_plates", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(calls.map((c) => c.name)).toEqual(["craft"]);
  });
});

describe("craft deposit guard: fail-open on unreadable data", () => {
  test.each([
    ["the response is not a storage listing", { storage: undefined }],
    ["the query throws", { storageThrows: true }],
    ["the api has no getStorage", { omitStorageApi: true }],
  ])("craft goes through when %s", async (_label, overrides: Overrides) => {
    const { api, calls } = stubApi(overrides);
    const r = await executeTick(api, craft({ id: "iron_plates", quantity: 10 }), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(calls.map((c) => c.name)).toEqual(["craft"]);
  });
});

describe("craft deposit guard: scope, on purpose", () => {
  // dry_run spends nothing (crafting.md: "without queuing or spending
  // anything") -- never worth refusing regardless of storage.
  test("a dry_run quote is never blocked, even against empty storage", async () => {
    const { api, calls } = stubApi({ storage: [] });
    const r = await executeTick(
      api, craft({ id: "iron_plates", quantity: 10, dry_run: true }), { step: 0, iteration: 0 },
    );
    expect(r.kind).not.toBe("blocked");
    expect(calls.map((c) => c.name)).toEqual(["craft"]);
  });

  // A job explicitly routed to faction storage/treasury draws from a store
  // this guard does not read (crafting.md:16) -- blocking it on the
  // PERSONAL locker being empty would be a false block this codebase's own
  // fail-open discipline forbids.
  test.each([
    ["deliver_to=faction", { deliver_to: "faction" }],
    ["deliver_to=faction:bucket", { deliver_to: "faction:Crafting" }],
    ["source=faction", { source: "faction" }],
  ])("a job naming %s is never blocked on the personal locker", async (_label, extra) => {
    const { api, calls } = stubApi({ storage: [] });
    const r = await executeTick(api, craft({ id: "iron_plates", quantity: 10, ...extra }), { step: 0, iteration: 0 });
    expect(r.kind).not.toBe("blocked");
    expect(calls.map((c) => c.name)).toEqual(["craft"]);
  });

  // Same receipt as mineDepositBlock: storage cannot change between repeat
  // ticks of the SAME step (nothing else runs in between), so re-querying
  // past the first submission would only double the hottest path's traffic.
  test("a repeat submission of the same step is not re-checked", async () => {
    const { api, calls, lookups } = stubApi({ storage: [] });
    const r = await executeTick(api, craft({ id: "iron_plates", quantity: 10 }), { step: 0, iteration: 1 });
    expect(r.kind).not.toBe("blocked");
    expect(calls.map((c) => c.name)).toEqual(["craft"]);
    expect(lookups()).toBe(0);
  });
});

describe("craft deposit guard: the refusal text the planner actually reads", () => {
  // Remedy-first ordering: digest.ts clips a blocked wake's detail at 200
  // chars, so the actionable steer (deposit, then retry craft) has to
  // survive the clip even for a long recipe id.
  test("the refusal survives the digest clip with a long recipe id", async () => {
    const longId = "contained_highly_enriched_uranium_refinement_process";
    const { api } = stubApi({ storage: [] });
    const r = await executeTick(api, craft({ id: longId, quantity: 1 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const reason = r.kind === "blocked" ? r.reason : "";
    expect(reason.slice(0, UNTRUSTED_TEXT_SNIPPET_LEN)).toContain(`craft{id=${longId}}`);
  });
});
