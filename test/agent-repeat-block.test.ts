import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner, PlanContext } from "../src/planner/types";
import { NO_BUYERS_CLASS } from "../src/agent/wake";

// Same-error-repeat loop-breaker (issue #95). The GENERAL mechanism the
// consecutive thrash damper (agent-thrash.test.ts) is a special case of: it
// counts blocked (action, normalized-target) outcomes in a trailing window and
// breaks the loop at threshold K, catching the INTERLEAVED repeats the
// consecutive damper misses -- a doomed action retried with other work (other
// actions, or the SAME action with a differently-worded block reason) between
// attempts, which resets the consecutive streak so it never arms. Detection is
// keyed on (action, target), which stays stable across attempts where the
// reason text does not; escalation is a bounded transient re-steer, never a
// hard abandon.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  // K=3, 30-min window (the production defaults, made explicit for the test).
  repeatBlockThreshold: 3, repeatBlockWindowMinutes: 30,
};

// Advancing credits keep the Layer 4 freeze detector out of the frame (it keys
// on game state, not the block key), so a failure here is unambiguously the
// #95 breaker, not the no-progress backstop -- the same isolation the
// agent-thrash suite uses.
function advancingStatusApi(action: GameApi["action"]): GameApi {
  let now = 100;
  return {
    action,
    async status(): Promise<StatusSnapshot> {
      return {
        credits: (now += 7), fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
        cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
      };
    },
    async notifications() { return []; },
  };
}

const sellGold: Plan = { goal: "sell the hold", steps: [{ action: "sell", params: { id: "gold_ore", quantity: 33 } }] };

describe("Agent same-error-repeat loop-breaker (#95)", () => {
  test("K-1 interleaved repeats of the same (action,target) do NOT trip", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // Same key (sell:gold_ore), DIFFERENT reasons each time -- so the
    // consecutive damper's streak keeps resetting and never arms; the #95
    // count is the only thing tracking these two blocks.
    const reasons = ["no market here for gold", "still no gold buyer nearby"];
    let calls = 0;
    const api = advancingStatusApi(async () => {
      throw new SpacemoltError("command_error", reasons[calls++]!);
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([sellGold]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // sell blocks (#1)
    await tick(agent); // blocked wake -> #95 count=1 -> replan (2)
    await tick(agent); // sell blocks (#2)
    await tick(agent); // blocked wake -> #95 count=2 -> replan (3)

    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "repeat_block_break").length).toBe(0); // 2 < K=3
    expect(planner.contexts.length).toBe(3);
  });

  test("K interleaved repeats DO trip -- the case the consecutive damper misses", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // Identical key, reasons cycle A/B/A so no reason ever repeats consecutively
    // 3x: the consecutive damper NEVER arms here. Only #95 (keyed on
    // action+target, blind to the reason wording) catches the loop.
    const reasons = ["no market A", "no market B", "no market A"];
    let calls = 0;
    const api = advancingStatusApi(async () => {
      throw new SpacemoltError("command_error", reasons[calls++]!);
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([sellGold]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // sell blocks (#1, reason A)
    await tick(agent); // blocked wake -> #95 count=1 -> replan (2)
    await tick(agent); // sell blocks (#2, reason B)
    await tick(agent); // blocked wake -> #95 count=2 -> replan (3)
    await tick(agent); // sell blocks (#3, reason A)
    await tick(agent); // blocked wake -> #95 count=3 -> TRIP (enriched re-steer replan)

    const breaks = store.recentEvents("a1", 100).filter((e) => e.type === "repeat_block_break");
    expect(breaks.length).toBe(1);
    expect((breaks[0]!.payload as { key: string }).key).toBe("sell:gold_ore");
    expect((breaks[0]!.payload as { count: number }).count).toBe(3);
    // The consecutive damper did NOT fire -- this is exclusively the #95 catch.
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
    // The escalation actually STEERED the planner: the trip's replan (contexts[3])
    // carried the transient break instruction, not a persisted goal.
    expect(planner.contexts.length).toBe(4);
    expect(planner.contexts[3]!.instruction ?? "").toContain("repeated the same failing action");
  });

  test("two DIFFERENT keys do not cross-count toward the threshold", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // Alternate sell (key sell:gold_ore) and mine (key mine:), each blocking
    // TWICE. Four blocks total, but split across two keys -- neither reaches K,
    // so #95 must not trip. Reasons differ so the consecutive damper is quiet too.
    const minePlan: Plan = { goal: "mine here", steps: [{ action: "mine", params: {} }] };
    const contexts: PlanContext[] = [];
    let i = 0;
    const plans = [sellGold, minePlan];
    const planner: Planner = {
      async plan(ctx: PlanContext) {
        contexts.push(ctx);
        const plan = plans[i % plans.length]!;
        i++;
        return { plan, promptChars: 0, responseChars: 0, model: "mock" };
      },
    };
    const api = advancingStatusApi(async (name) => {
      throw new SpacemoltError("command_error", name === "sell" ? "no gold market" : "deposits too sparse");
    });
    const store = new Store(":memory:");
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan sellPlan (1)
    await tick(agent); // sell blocks (sell:gold_ore #1)
    await tick(agent); // blocked wake -> replan minePlan (2)
    await tick(agent); // mine blocks (mine: #1)
    await tick(agent); // blocked wake -> replan sellPlan (3)
    await tick(agent); // sell blocks (sell:gold_ore #2)
    await tick(agent); // blocked wake -> replan minePlan (4)
    await tick(agent); // mine blocks (mine: #2)
    await tick(agent); // blocked wake -> (both keys at 2) -> replan (5)

    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "repeat_block_break").length).toBe(0);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
    expect(contexts.length).toBe(5);
  });

  test("a same-key SUCCESS between blocks resets the running count", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // dock: block, block, SUCCESS, block, block. Without the same-key success
    // reset that would be 4 blocks -> a trip; WITH it the count resets at the
    // success and only reaches 2 on each side, so #95 must NOT trip. (Test 2
    // above proves 3 uninterrupted blocks DO trip -- the contrast isolates the
    // reset.) dock is used because a successful dock is a clean plan_done with
    // no executor-side effect verification.
    const script: Array<"blockA" | "blockB" | "ok"> = ["blockA", "blockB", "ok", "blockA", "blockB"];
    let calls = 0;
    const api = advancingStatusApi(async (): Promise<V2Result> => {
      const s = script[calls++]!;
      if (s === "ok") return { result: "docked" };
      throw new SpacemoltError("command_error", s === "blockA" ? "bay busy A" : "bay busy B");
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "dock at station", steps: [{ action: "dock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // dock blocks (#1)
    await tick(agent); // blocked wake -> count=1 -> replan (2)
    await tick(agent); // dock blocks (#2)
    await tick(agent); // blocked wake -> count=2 -> replan (3)
    await tick(agent); // dock SUCCEEDS -> plan_done
    await tick(agent); // plan_done wake -> replan (4)
    await tick(agent); // dock blocks (#3)
    await tick(agent); // blocked wake -> count reset by success, now 1 -> replan (5)
    await tick(agent); // dock blocks (#4)
    await tick(agent); // blocked wake -> count 2 -> no trip -> replan (6)

    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "repeat_block_break").length).toBe(0);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
  });

  test("no-buyers blocks on DIFFERENT items collapse to one class and trip through the breaker (#146/#348)", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // Three sells of DIFFERENT items (gold/vanadium/palladium), each blocked with
    // a no-buyers reason, INTERLEAVED with mine blocks. Keyed on (action,target)
    // the three sells would be three separate keys (each reaching only 1, never
    // K) -- but the no-buyers CLASS collapse folds them into NO_BUYERS_CLASS, so
    // the loop is caught as one. The mine interleave gives the consecutive damper
    // an alternating key (blocked:sell:no_buyers / blocked:deposits...) so its
    // streak never reaches 3: this trip is EXCLUSIVELY the #95 breaker's, and it
    // proves the collapse is what catches a per-item-varying no-buyers loop.
    const sellVanadium: Plan = { goal: "sell vanadium", steps: [{ action: "sell", params: { id: "vanadium_ore", quantity: 5 } }] };
    const sellPalladium: Plan = { goal: "sell palladium", steps: [{ action: "sell", params: { id: "palladium_ore", quantity: 5 } }] };
    const minePlan: Plan = { goal: "mine here", steps: [{ action: "mine", params: {} }] };
    const plans = [sellGold, minePlan, sellVanadium, minePlan, sellPalladium];
    const contexts: PlanContext[] = [];
    let i = 0;
    const planner: Planner = {
      async plan(ctx: PlanContext) {
        contexts.push(ctx);
        const plan = plans[i % plans.length]!;
        i++;
        return { plan, promptChars: 0, responseChars: 0, model: "mock" };
      },
    };
    // Sells throw a per-item no-buyers reason (all match the no-buyers regex ->
    // NO_BUYERS_CLASS); mine throws a different reason (a distinct key the #95
    // count ignores and the consecutive damper sees as a streak-breaker).
    const api = advancingStatusApi(async (name, params) => {
      if (name === "mine") throw new SpacemoltError("command_error", "deposits too sparse to mine here");
      const id = (params as { id?: string } | undefined)?.id ?? "";
      throw new SpacemoltError("command_error", `Sold 0 ${id} for 0cr (no buyers here)`);
    });
    const store = new Store(":memory:");
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan sellGold (1)
    await tick(agent); // sell gold blocks (NO_BUYERS_CLASS #1)
    await tick(agent); // blocked wake -> replan mine (2)
    await tick(agent); // mine blocks (mine: -- ignored by the class count)
    await tick(agent); // blocked wake -> replan sellVanadium (3)
    await tick(agent); // sell vanadium blocks (NO_BUYERS_CLASS #2)
    await tick(agent); // blocked wake -> replan mine (4)
    await tick(agent); // mine blocks (mine:)
    await tick(agent); // blocked wake -> replan sellPalladium (5)
    await tick(agent); // sell palladium blocks (NO_BUYERS_CLASS #3)
    await tick(agent); // blocked wake -> class count = 3 -> TRIP

    const breaks = store.recentEvents("a1", 100).filter((e) => e.type === "repeat_block_break");
    expect(breaks.length).toBe(1);
    // The break key is the collapsed CLASS, not any single item -- the proof the
    // per-item keys were folded into one.
    expect((breaks[0]!.payload as { key: string }).key).toBe(NO_BUYERS_CLASS);
    expect((breaks[0]!.payload as { count: number }).count).toBe(3);
    // The consecutive damper stayed silent: the mine interleave broke its streak.
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
  });

  test("a successful SALE resets the no-buyers-class repeat count (#95 review, #348)", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // Sell gold_ore: no-buyers block, no-buyers block, a genuine SALE, then two
    // more no-buyers blocks. All four blocks collapse to NO_BUYERS_CLASS. The SALE
    // keys to sell:gold_ore (a real sale never carries the no-buyers text), so
    // WITHOUT the class-aware reset it is invisible to the class counter and the
    // four blocks trip at K=3; WITH it the sale resets the class count so neither
    // run reaches K -> no trip. This is the #348 scenario the review flagged as
    // structurally unreachable. Contrast: test 2 proves three uninterrupted blocks
    // DO trip -- here the sale is the load-bearing difference. A stateful cargo
    // mock (gold_ore 40 -> 20 on the sale) lets verifySellEffect see a real
    // decrease, so the sale reads as a genuine success, not an SM-9 phantom.
    let goldQty = 40;
    let creditsBase = 100;
    const script: Array<"block" | "sale"> = ["block", "block", "sale", "block", "block"];
    let calls = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name !== "sell") throw new SpacemoltError("command_error", "unexpected action");
        const step = script[calls]!;
        calls++;
        if (step === "sale") { goldQty -= 20; return { result: "Sold 20 Gold Ore for 400cr" }; }
        throw new SpacemoltError("command_error", "Sold 0 Gold Ore for 0cr (no buyers)");
      },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: (creditsBase += 7), fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: goldQty, cargoCapacity: 50, docked: false, inTransit: false,
          cargo: [{ itemId: "gold_ore", name: "Gold Ore", quantity: goldQty }],
        };
      },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const planner = new MockPlanner([sellGold]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // sell blocks (no buyers #1)
    await tick(agent); // blocked wake -> class count=1 -> replan (2)
    await tick(agent); // sell blocks (no buyers #2)
    await tick(agent); // blocked wake -> class count=2 -> replan (3)
    await tick(agent); // sell SUCCEEDS -> plan_done (cargo 40 -> 20)
    await tick(agent); // plan_done wake -> replan (4)
    await tick(agent); // sell blocks (no buyers #3)
    await tick(agent); // blocked wake -> sale reset the class count, now 1 -> replan (5)
    await tick(agent); // sell blocks (no buyers #4)
    await tick(agent); // blocked wake -> class count 2 -> no trip -> replan (6)

    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "repeat_block_break").length).toBe(0);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
  });

  // No-buyers damper steer (issue #348). When the #95 breaker trips on the
  // collapsed no-buyers class, the escalation must nudge LIST / RELOCATE / HOLD
  // -- the correct remedy for held cargo no market buys -- NOT the generic
  // "drop it and pursue a different goal", which is wrong for valuable cargo
  // (#94) and does not name the re-search failure the pilot is stuck in. This
  // is the behavior #348 adds on top of #95's detection: same trip, branched
  // steer text. dock successes interleave to keep the CONSECUTIVE thrash gate's
  // streak broken (so plan_thrash_backoff never fires) -- the trip is
  // exclusively the #95 breaker's, and the steer under test is its output.
  test("a tripped no-buyers class steers to list/relocate, not 'drop it' (#348)", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const dockPlan: Plan = { goal: "dock at station", steps: [{ action: "dock", params: {} }] };
    const plans = [sellGold, dockPlan];
    const contexts: PlanContext[] = [];
    let i = 0;
    const planner: Planner = {
      async plan(ctx: PlanContext) {
        contexts.push(ctx);
        const plan = plans[i % plans.length]!;
        i++;
        return { plan, promptChars: 0, responseChars: 0, model: "mock" };
      },
    };
    // Same item every time; the block text matches the no-buyers regex so it
    // collapses to NO_BUYERS_CLASS. dock succeeds cleanly (a different key that
    // does not reset the class count) and breaks the consecutive streak.
    const api = advancingStatusApi(async (name): Promise<V2Result> => {
      if (name === "dock") return { result: "docked" };
      throw new SpacemoltError("command_error", "Sold 0 gold_ore for 0cr (no buyers here)");
    });
    const store = new Store(":memory:");
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan sellGold (ctx1)
    await tick(agent); // sell blocks (no buyers #1)
    await tick(agent); // blocked wake -> class count=1 -> replan dock (ctx2)
    await tick(agent); // dock SUCCEEDS -> plan_done (breaks consecutive streak)
    await tick(agent); // plan_done wake -> replan sellGold (ctx3)
    await tick(agent); // sell blocks (no buyers #2)
    await tick(agent); // blocked wake -> class count=2 -> replan dock (ctx4)
    await tick(agent); // dock SUCCEEDS -> plan_done
    await tick(agent); // plan_done wake -> replan sellGold (ctx5)
    await tick(agent); // sell blocks (no buyers #3)
    await tick(agent); // blocked wake -> class count=3 -> TRIP (ctx6 enriched)

    const breaks = store.recentEvents("a1", 100).filter((e) => e.type === "repeat_block_break");
    expect(breaks.length).toBe(1);
    expect((breaks[0]!.payload as { key: string }).key).toBe(NO_BUYERS_CLASS);
    expect((breaks[0]!.payload as { count: number }).count).toBe(3);
    // Exclusively the #95 catch -- the consecutive gate stayed silent.
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
    // The trip's steer names the list/relocate remedy and drops the generic
    // "drop it" advice that contradicts holding valuable cargo.
    const steer = contexts.at(-1)!.instruction ?? "";
    expect(steer).toContain("create_sell_order");
    expect(steer).toMatch(/no buyers/i);
    expect(steer).toMatch(/HOLD/);
    expect(steer).not.toContain("drop it and pursue");
    expect(steer).not.toContain("repeated the same failing action");
  });

  // Persisted-state schema tolerance (AGENTS.md): the breaker reads persisted
  // `action` events. A stored event predating (or foreign to) the current
  // payload shape -- no action/params fields -- must be SKIPPED, never crash the
  // loop, and must not corrupt the count of real repeats.
  test("tolerates a malformed/old action event in the window without crashing or miscounting", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const store = new Store(":memory:");
    // Seed events written by an older schema: an action event with NO action
    // field and NO params, and one with a null payload. Both must be ignored.
    store.appendEvent({ agentId: "a1", ts: now, type: "action", payload: { outcome: "blocked", result: "legacy blob" } });
    store.appendEvent({ agentId: "a1", ts: now, type: "action", payload: null });

    const reasons = ["no market A", "no market B", "no market A"];
    let calls = 0;
    const api = advancingStatusApi(async () => {
      throw new SpacemoltError("command_error", reasons[calls++]!);
    });
    const planner = new MockPlanner([sellGold]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    // Same drive as test 2: three real sell:gold_ore blocks. The malformed
    // events sit in the window; the breaker must still trip exactly once on the
    // real key and never throw.
    await tick(agent);
    await tick(agent);
    await tick(agent);
    await tick(agent);
    await tick(agent);
    await tick(agent);
    await tick(agent);

    const breaks = store.recentEvents("a1", 100).filter((e) => e.type === "repeat_block_break");
    expect(breaks.length).toBe(1);
    expect((breaks[0]!.payload as { key: string }).key).toBe("sell:gold_ore");
    expect((breaks[0]!.payload as { count: number }).count).toBe(3); // malformed events not counted
  });

  // #291 third occurrence: the rate-mismatch regression. Accrual must NOT be
  // bounded by the 30-min window -- a doomed action that blocks slower than
  // ~1 per 15 min (live: 5 complete_mission blocks over 4+ hours, never 2 in
  // any 30-min window) still has zero same-key successes in between and must
  // accumulate to K. Blocks here are 40 min apart (wider than the 30-min
  // window) with a SUCCESSFUL different-key action between attempts, mirroring
  // the live shape (mining succeeded between the doomed completes) and keeping
  // the consecutive damper's streak broken. Under the old windowed count each
  // wake saw at most 1 block in-window and the breaker never fired.
  test("same-key blocks slower than the window still accrue and trip (#291 third occurrence)", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // heartbeatMinutes raised so the 40-min gaps never trigger heartbeat wakes
    // (which would insert extra replans and blur what drove each plan); the
    // breaker's own config stays at the production K=3 / 30-min window.
    const cfg: AgentConfig = { ...config, heartbeatMinutes: 720 };
    const dockPlan: Plan = { goal: "dock at station", steps: [{ action: "dock", params: {} }] };
    const plans = [sellGold, dockPlan];
    const contexts: PlanContext[] = [];
    let i = 0;
    const planner: Planner = {
      async plan(ctx: PlanContext) {
        contexts.push(ctx);
        const plan = plans[i % plans.length]!;
        i++;
        return { plan, promptChars: 0, responseChars: 0, model: "mock" };
      },
    };
    // Identical reason every time (the live shape: the same mission_incomplete
    // text on every attempt); the reason deliberately does NOT match the
    // no-buyers class regex, so the key stays sell:gold_ore.
    const api = advancingStatusApi(async (name): Promise<V2Result> => {
      if (name === "dock") return { result: "docked" };
      throw new SpacemoltError("command_error", "market closed for maintenance");
    });
    const store = new Store(":memory:");
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: cfg, now: () => now });

    await tick(agent); // no_plan -> replan sellGold (1)
    await tick(agent); // sell blocks (#1)
    await tick(agent); // blocked wake -> count=1 -> replan dock (2)
    await tick(agent); // dock SUCCEEDS (different key -- must not reset sell's count)
    await tick(agent); // plan_done wake (consecutive streak broken) -> replan sellGold (3)
    now += 40 * 60_000; // 40 min -- wider than the 30-min window
    await tick(agent); // sell blocks (#2)
    await tick(agent); // blocked wake -> count=2 (windowed count would see 1) -> replan dock (4)
    await tick(agent); // dock SUCCEEDS
    await tick(agent); // plan_done wake -> replan sellGold (5)
    now += 40 * 60_000; // another 40 min
    await tick(agent); // sell blocks (#3)
    await tick(agent); // blocked wake -> count=3 -> TRIP (windowed count: 1, never fires)

    const breaks = store.recentEvents("a1", 100).filter((e) => e.type === "repeat_block_break");
    expect(breaks.length).toBe(1);
    expect((breaks[0]!.payload as { key: string }).key).toBe("sell:gold_ore");
    expect((breaks[0]!.payload as { count: number }).count).toBe(3);
    // Exclusively the #95 catch: the interleaved plan_done wakes kept the
    // consecutive damper's streak at 1 throughout.
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
    // The trip enriched the replan with the transient re-steer.
    expect(contexts.length).toBe(6);
    expect(contexts[5]!.instruction ?? "").toContain("repeated the same failing action");
    expect(contexts[5]!.instruction ?? "").toContain("no success in between");
  });
});
