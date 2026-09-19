import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError, type V2Result, type EnvelopeNotification } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

// Repeated-buy guard (issue #669). The `item_not_available` error's own text
// ships the game's documented remedy (create_buy_order, markets.md:86) -- the
// pilot following it was correct behavior, not injection (that framing was
// this task's own false start, corrected mid-session). The real, still-open
// defect is repetition: production logged 17 blocked `buy` attempts for
// fuel_cell at one station in ~10 minutes, and a later episode drove
// plan_budget_exceeded over 40 times, because nothing stopped the SAME (buy,
// station, item) that had already failed from being resubmitted. Exercised
// end-to-end (not just the executor unit level in executor.test.ts) because
// the #681 sibling guard's round-1 bug lived in the SEAM -- whether agent.ts
// computes the right boolean from real game outcomes -- not in the executor's
// boolean-consuming guard itself.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const STATION = "market_prime";

function dockedStatus(overrides?: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    credits: 200_000, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, dockedAt: STATION,
    ...overrides,
  };
}

function makeApi(
  status: StatusSnapshot, action: GameApi["action"], notifications?: () => EnvelopeNotification[],
): { api: GameApi; calls: string[] } {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push(name);
      return action(name, params);
    },
    async status() { return status; },
    async notifications() { return notifications?.() ?? []; },
  };
  return { api, calls };
}

const buyFuelCell: Plan = { goal: "buy fuel", steps: [{ action: "buy", params: { id: "fuel_cell", quantity: 50 } }] };

// Live capture shape (2026-08-01, issue #669): the game prefixes its
// human-readable message with the code, same convention already relied on
// for invalid_item in executor.ts's buy-id correction.
const ITEM_NOT_AVAILABLE_MSG =
  "item_not_available: No one is selling Fuel Cell at this station. To place a standing buy order, use: " +
  '{"type": "create_buy_order", "item_id": "fuel_cell", "quantity": 50, "price_each": 60}';

describe("Agent repeated-buy guard (#669)", () => {
  test("a buy blocked item_not_available learns the (station, item) as unavailable", async () => {
    const status = dockedStatus();
    const { api } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan
    await agent.runOnce(); // buy step executes, blocks

    const events = store.recentEvents("a1", 20).filter((e) => e.type === "item_unavailable");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ key: `${STATION}:fuel_cell`, stationKey: STATION, itemId: "fuel_cell" });
  });

  test("a second buy for the same item at the same station is refused before the API call", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell, buyFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan (buy #1)
    await agent.runOnce(); // buy #1 reaches the API, blocks, learns unavailable
    await agent.runOnce(); // blocked -> replan (buy #2)
    await agent.runOnce(); // buy #2: must be refused pre-call

    expect(calls).toEqual(["buy"]); // exactly one live call reached the game
    const actionEvents = store.recentEvents("a1", 20).filter((e) => e.type === "action");
    const buyEvents = actionEvents.filter((e) => (e.payload as { action?: string }).action === "buy");
    expect(buyEvents.length).toBe(2);
    expect((buyEvents[1]!.payload as { outcome: string }).outcome).toBe("blocked");
    expect((buyEvents[1]!.payload as { guard?: boolean }).guard).toBe(true); // our refusal, not the game's
    expect((buyEvents[1]!.payload as { result?: string }).result).toContain("create_buy_order");
  });

  // The guard's failure direction: PR #58's sibling guard converted a credit
  // leak into a permanent inability to buy an item at a station in its FIRST
  // revision (reviewer REVISE), because it had no expiry. This memory has no
  // real invalidation signal at all (no galaxy-wide stock query -- see the
  // guard's own comment), so a time window is the only thing standing between
  // "steer away from a proven-doomed repeat" and "never try here again."
  test("after the memory window expires, a later buy for the same item reaches the API again", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell, buyFuelCell]);
    let now = 1;
    // heartbeatMinutes raised past the 30-min item-unavailable window this
    // test deliberately jumps across -- otherwise the jump itself trips a
    // heartbeat wake first (config.heartbeatMinutes=15 < the 30-min window),
    // which replans instead of executing the pending step and would consume
    // MockPlanner's queue for the wrong reason.
    const longHeartbeatConfig: AgentConfig = { ...config, heartbeatMinutes: 60 };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: longHeartbeatConfig, now: () => now });

    await agent.runOnce(); // replan (buy #1)
    await agent.runOnce(); // buy #1 blocked, learns unavailable at ts=1
    await agent.runOnce(); // blocked -> replan (buy #2)
    now += 30 * 60_000 + 1; // past AGENT_DEFAULTS.repeatBlockWindowMinutes (30)
    await agent.runOnce(); // buy #2: window expired, must reach the API again

    expect(calls).toEqual(["buy", "buy"]); // second attempt was NOT refused
  });

  // Round-2 review finding (PR #73): the test above only proves expiry for a
  // SINGLE original block followed directly by the post-window attempt -- it
  // never issues a guard-refused attempt INSIDE the window, so it could not
  // catch a producer that re-arms itself. It did not: learnItemUnavailable
  // matched on the reason text alone (`.includes("item_not_available")`) with
  // no check for `result.guard`, and the guard's own refusal text also names
  // item_not_available (it steers toward the same remedy the original block
  // named). Every guard-refused attempt re-emitted item_unavailable with a
  // fresh timestamp, and the read side keeps only the LATEST event per key
  // (store.ts's latestEventPerPayloadKey, `HAVING id = MAX(id)`), so each
  // guard-block pushed the window's start forward -- a station could be
  // blocked forever as long as the planner kept trying. This test constructs
  // exactly that scenario: TWO guard-refused attempts land inside the
  // original 30-minute window before the check at 31 minutes past the
  // ORIGINAL block (not the last guard-block) -- the shape the reviewer
  // reproduced live and the shape the test above cannot express.
  test("guard-refused attempts inside the window do not re-arm it: the window still expires from the ORIGINAL block", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    // MockPlanner repeats its last (only) plan forever once its list is
    // exhausted -- one entry drives every replan in this sequence, guard-
    // refused replans included.
    const planner = new MockPlanner([buyFuelCell]);
    let now = 1;
    const longHeartbeatConfig: AgentConfig = { ...config, heartbeatMinutes: 60 };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: longHeartbeatConfig, now: () => now });

    await agent.runOnce(); // no_plan -> replan
    await agent.runOnce(); // buy #1: reaches the API, real game block, learns unavailable at ts=1
    await agent.runOnce(); // blocked -> replan

    now = 300_000; // 5 minutes after the original block
    await agent.runOnce(); // buy attempt: guard-refused pre-call, no API call
    await agent.runOnce(); // blocked -> replan

    now = 600_000; // 10 minutes after the original block
    await agent.runOnce(); // buy attempt: guard-refused pre-call, no API call
    await agent.runOnce(); // blocked -> replan

    now = 1_860_002; // 31 minutes past the ORIGINAL block (ts=1) -- past the 30-min window
    await agent.runOnce(); // buy attempt: the window has expired -- must reach the API again

    expect(calls).toEqual(["buy", "buy"]); // exactly two live calls: the original block and this one
  });

  // Scoping proof: the guard is keyed on (station, item), not "any
  // item_not_available this pilot has ever hit" -- a DIFFERENT item at the
  // same station must still be allowed its own first attempt.
  test("a DIFFERENT item at the same station is not blocked by this memory", async () => {
    const status = dockedStatus();
    const { api, calls } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const buyOre: Plan = { goal: "buy ore", steps: [{ action: "buy", params: { id: "iron_ore", quantity: 10 } }] };
    const planner = new MockPlanner([buyFuelCell, buyOre]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // replan (buyFuelCell)
    await agent.runOnce(); // fuel_cell blocked, learns unavailable
    await agent.runOnce(); // blocked -> replan (buyOre)
    await agent.runOnce(); // iron_ore buy: must reach the API too (different item)

    expect(calls).toEqual(["buy", "buy"]);
  });
});

// Digest-visibility remainder (skeptic finding on #669's triage, upheld): the
// guard above stops the LIVE resubmission, but the planner was never TOLD
// before proposing it -- digest construction never received this memory (see
// PlanContext.unavailableItemsAtStation, types.ts, and
// Agent.unavailableItemIdsAtStation, agent.ts). These tests exercise the SEAM
// the skeptic named directly testable: MockPlanner.contexts[n] is the exact
// PlanContext each replan built, so this asserts on the harness's real
// producer (Agent.replan), not a hand-built ctx (digest.test.ts pins
// buildDigest's own rendering contract for the field in isolation).
describe("PlanContext digest visibility (#669 remainder)", () => {
  test("the docked-station replan after a blocked item_not_available buy carries the item in unavailableItemsAtStation", async () => {
    const status = dockedStatus();
    const { api } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell, buyFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan (buy #1); ctx0: nothing learned yet
    await agent.runOnce(); // buy #1 reaches the API, blocks, learns unavailable
    await agent.runOnce(); // blocked -> replan (buy #2); ctx1: built AFTER the block

    expect(planner.contexts).toHaveLength(2);
    expect(planner.contexts[0]!.unavailableItemsAtStation ?? []).not.toContain("fuel_cell");
    expect(planner.contexts[1]!.unavailableItemsAtStation).toEqual(["fuel_cell"]);
  });

  test("the item drops out of unavailableItemsAtStation once the memory window expires", async () => {
    const status = dockedStatus();
    // First `buy` call blocks item_not_available (learns the memory); every
    // later `buy` call succeeds (the station "restocked") -- deliberately
    // asymmetric so the post-expiry attempt does NOT re-learn a fresh
    // item_unavailable event, which would make the post-expiry ctx show the
    // item again for the RIGHT reason (a genuine new game block) and mask
    // whether the STALE ts=1 record correctly stopped counting on its own.
    let buyCalls = 0;
    const { api } = makeApi(status, async (name) => {
      if (name === "buy") {
        buyCalls++;
        if (buyCalls === 1) throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      }
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell, buyFuelCell, buyFuelCell]);
    let now = 1;
    // Same heartbeat-widening reason as the expiry test above: the jump past
    // the 30-min window must not itself trip a heartbeat wake first.
    const longHeartbeatConfig: AgentConfig = { ...config, heartbeatMinutes: 60 };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: longHeartbeatConfig, now: () => now });

    await agent.runOnce(); // no_plan -> replan (buy #1)
    await agent.runOnce(); // buy #1 blocked, learns unavailable at ts=1
    await agent.runOnce(); // blocked -> replan (buy #2); ctx1: inside the window

    now += 30 * 60_000 + 1; // 31 minutes past the original block
    await agent.runOnce(); // buy #2 reaches the API again (window expired) and SUCCEEDS
    await agent.runOnce(); // plan done -> replan (buy #3); ctx2: no new block was learned

    expect(planner.contexts).toHaveLength(3);
    expect(planner.contexts[1]!.unavailableItemsAtStation).toEqual(["fuel_cell"]);
    // Matcher's blind spot closed: toEqual on the exact array (not
    // toContain's count-blind presence check) proves the entry is gone, not
    // merely that some other truthy value survives.
    expect(planner.contexts[2]!.unavailableItemsAtStation).toEqual([]);
  });

  test("an item proven unavailable at one station does not appear in a replan docked at a DIFFERENT station", async () => {
    const OTHER_STATION = "frontier_outpost";
    const status = dockedStatus();
    const { api } = makeApi(status, async (name) => {
      if (name === "buy") throw new SpacemoltError("command_error", ITEM_NOT_AVAILABLE_MSG);
      return { result: "ok" };
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([buyFuelCell, buyFuelCell]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan (buy #1) at market_prime
    await agent.runOnce(); // buy #1 blocked, learns unavailable at market_prime
    status.dockedAt = OTHER_STATION; // pilot redocks elsewhere before the next replan
    await agent.runOnce(); // blocked -> replan (buy #2); ctx1: docked at the OTHER station

    expect(planner.contexts).toHaveLength(2);
    expect(planner.contexts[1]!.unavailableItemsAtStation).toEqual([]);
  });
});
