import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner, PlanContext } from "../src/planner/types";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const status: StatusSnapshot = {
  credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

const alwaysBlockedPlan: Plan = { goal: "mine at a barren base", steps: [{ action: "mine", params: {} }] };

function stubApiAlwaysBlocks(): GameApi {
  return {
    async action(): Promise<V2Result> { throw new SpacemoltError("command_error", "nothing to mine here"); },
    async status() { return status; },
    async notifications() { return []; },
  };
}

// F-3 ground truth: maiden-flight, every blocked step immediately woke the
// planner -- ~60 replans/hr observed vs a 4-10/hr design target.
//
// SM-4 revision: the trigger moved from cursor-position ("blocked at {0,0}")
// to BLOCK-REASON REPETITION ("3 consecutive blocked wakes with an identical
// detail string"), because the cursor version had a bypass -- see the
// dedicated regression test below. That change means the tick-by-tick
// cadence differs from the pre-SM-4 version of this file: counting now
// happens at the blocked-WAKE tick (runOnce()'s "blocked" branch), not at the
// block tick (executeOne()), so a replan that resumes a streak after backoff
// expiry consumes streak position 1 itself instead of being "free". These
// tests derive their expected counts from that mechanism directly, not from
// the old cursor-based cadence.
describe("Agent blocked-plan thrash damping (F-3, SM-4 revision)", () => {
  // Advancing clock (1s per tick, jumped past the backoff window where noted):
  // a frozen clock would hide the same class of defect the original F-3 fix
  // found (the gate re-arming forever because a counter never reset), so this
  // test crosses the window boundary for real, not sitting at t=0.
  test("3 blocked wakes with identical detail defer replanning for the window, then replanning resumes; sustained thrash re-arms", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const api = stubApiAlwaysBlocks();
    const store = new Store(":memory:");
    const planner = new MockPlanner([alwaysBlockedPlan]); // MockPlanner repeats the last plan forever
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan wake -> replan A (a no_plan wake is unconditional, doesn't touch the streak)
    await tick(agent); // A's only step blocks ("nothing to mine here")
    await tick(agent); // blocked wake, new detail -> streak=1 -> replan B
    await tick(agent); // B blocks (same detail)
    await tick(agent); // blocked wake, same detail -> streak=2 -> replan C
    await tick(agent); // C blocks (same detail)
    expect(planner.contexts.length).toBe(3); // A, B, C

    await tick(agent); // blocked wake, same detail -> streak=3 -> threshold reached, gate arms, no replan
    expect(planner.contexts.length).toBe(3); // no new replan attempt
    let types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(1);

    await tick(agent); // still inside the window: backoff branch suppresses the replan
    expect(planner.contexts.length).toBe(3);

    now += config.heartbeatMinutes * 60_000; // jump past the backoff window
    await tick(agent); // blocked wake, backoff expired, streak was reset at arm -> replans normally (streak=1) -> replan D
    expect(planner.contexts.length).toBe(4); // NOT permanently grounded

    // Sustained thrash: the new plan keeps blocking with the SAME detail.
    // Streak position 1 was already consumed by replan D's own wake (the
    // resuming replan is itself the first occurrence of the new streak), so
    // re-arming this time needs only 2 more identical-detail blocked wakes,
    // not another 3 -- an asymmetry that falls directly out of counting at
    // the wake tick instead of the block tick.
    await tick(agent); // D blocks (same detail)
    await tick(agent); // blocked wake, same detail -> streak=2 -> replan E
    await tick(agent); // E blocks (same detail)
    await tick(agent); // blocked wake, same detail -> streak=3 -> re-arm (2nd backoff event), no replan F
    expect(planner.contexts.length).toBe(5); // D, E -- no replan F this time
    types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(2);
  });

  test("a blocked wake with a DIFFERENT detail resets the streak instead of accumulating toward it", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const reasons = ["too sparse", "too sparse", "hull critical", "too sparse", "too sparse", "too sparse"];
    let calls = 0;
    const api: GameApi = {
      async action(): Promise<V2Result> { throw new SpacemoltError("command_error", reasons[calls++]!); },
      // Advancing credits: this test exercises the damper's block-REASON key
      // reset (varying reason strings), so the ship must look like it's making
      // real game progress -- otherwise the Layer 4 freeze detector (which keys
      // on game state, not the reason string) would legitimately arm on the
      // frozen-state-plus-churning-key pattern and mask what the damper does.
      async status() { return { ...status, credits: now }; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const planner = new MockPlanner([alwaysBlockedPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // blocks: "too sparse"
    await tick(agent); // blocked wake, new -> streak=1 -> replan (2)
    await tick(agent); // blocks: "too sparse" (same)
    await tick(agent); // blocked wake, same -> streak=2 -> replan (3)
    await tick(agent); // blocks: "hull critical" (DIFFERENT)
    await tick(agent); // blocked wake, different -> streak RESETS to 1 -> replan (4)
    await tick(agent); // blocks: "too sparse" (different from "hull critical")
    await tick(agent); // blocked wake, different -> streak RESETS to 1 -> replan (5)
    await tick(agent); // blocks: "too sparse" (same)
    await tick(agent); // blocked wake, same -> streak=2 -> replan (6)
    await tick(agent); // blocks: "too sparse" (same, 3rd in this sub-run)
    await tick(agent); // blocked wake, same -> streak=3 -> gate arms, no replan (7)

    // 6 total blocked wakes occurred, well past the threshold of 3 -- but
    // because 2 of them broke the streak with a different reason, the gate
    // only arms once, not twice.
    expect(planner.contexts.length).toBe(6);
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(1);
  });

  // SM-4 ground truth (live 2026-07-10 21:01): a plan of [travel_to(own
  // position), mine] loops indefinitely. travelToTick's same-position
  // short-circuit (executor.ts) makes the travel step succeed as a no-op
  // every single cycle, advancing the cursor off {0,0} before "mine" blocks
  // with the SAME reason -- the pre-fix cursor-based check never saw zero
  // progress and never engaged, burning ~2 planner calls/cycle with no
  // damping at all. This is the regression guard: the damper must still
  // engage here despite the interleaved successful step every cycle.
  test("SM-4 regression: a no-op travel-to-own-position followed by an identical block still engages the damper", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "mine") throw new SpacemoltError("command_error", "deposits too sparse");
        return { result: "ok" };
      },
      async status() { return { ...status, systemId: "commerce_fields" }; },
      async notifications() { return []; },
    };
    const plan: Plan = {
      goal: "relocate then mine",
      steps: [
        { action: "travel_to", params: { system_id: "commerce_fields" } }, // no-op: already there
        { action: "mine", params: {} },
      ],
    };
    const store = new Store(":memory:");
    const planner = new MockPlanner([plan]); // repeats the same self-defeating plan forever
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // travel_to no-ops (continue, cursor -> step 1)
    await tick(agent); // mine blocks ("deposits too sparse")
    await tick(agent); // blocked wake, streak=1 -> replan (2)
    await tick(agent); // travel_to no-ops again
    await tick(agent); // mine blocks (same reason)
    await tick(agent); // blocked wake, streak=2 -> replan (3)
    await tick(agent); // travel_to no-ops again
    await tick(agent); // mine blocks (same reason)
    await tick(agent); // blocked wake, streak=3 -> gate arms, no replan (4)

    expect(planner.contexts.length).toBe(3); // damped after exactly 3 cycles, not "indefinitely"
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(1);

    // Confirm the suppression actually holds for the next tick too (not just
    // a one-off skip).
    await tick(agent);
    expect(planner.contexts.length).toBe(3);
  });

  // Issue #146 ground truth (live 2026-07-13 15:17-15:58Z): a full hold at a
  // station buying NONE of it cycled sell -> "Sold 0 X Ore for 0cr ... (no
  // buyers)" -> replan -> DIFFERENT ore -> no buyers -> replan every 30-60s
  // for 40+ min, credits pinned, and no plan_thrash_backoff ever fired --
  // each attempt's detail string named a different item, so the string-keyed
  // damper never built a streak. The fix collapses every no-buyers-class
  // block to ONE outcome-class key ("sell:no_buyers"), so the streak builds
  // across items. This test replays the incident: 3 no-buyers blocks on 3
  // DIFFERENT items must arm the gate exactly like 3 identical details would.
  // (The third detail omits the "(no buyers)" tail to cover the truncated
  // message shape -- the "Sold 0 X for 0cr" head alone must classify too.)
  test("issue #146: 3 no-buyers blocks across DIFFERENT items still arm the damper (outcome-class key)", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const reasons = [
      "Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)",
      "Sold 0 Vanadium Ore for 0cr, 20 unsold (no buyers)",
      "Sold 0 Carbon Ore for 0cr, 47 unsold",
    ];
    let calls = 0;
    const api: GameApi = {
      async action(): Promise<V2Result> { throw new SpacemoltError("command_error", reasons[calls++]!); },
      // Advancing credits keep the Layer 4 freeze detector out of the frame
      // (same isolation trick as the streak-reset test above), so a failure
      // here is unambiguously the damper's key, not the backstop.
      async status() { return { ...status, credits: now }; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const sellPlan: Plan = { goal: "sell the hold", steps: [{ action: "sell", params: { id: "gold_ore", quantity: 33 } }] };
    const planner = new MockPlanner([sellPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // sell blocks: no buyers for Gold Ore
    await tick(agent); // blocked wake -> class key -> streak=1 -> replan (2)
    await tick(agent); // sell blocks: no buyers for Vanadium Ore (DIFFERENT item, same class)
    await tick(agent); // blocked wake -> same class key -> streak=2 -> replan (3)
    await tick(agent); // sell blocks: no buyers for Carbon Ore (third item, truncated shape)
    await tick(agent); // blocked wake -> same class key -> streak=3 -> gate arms, no replan

    expect(planner.contexts.length).toBe(3); // damped after 3 cycles despite 3 different items
    const backoffs = store.recentEvents("a1", 100).filter((e) => e.type === "plan_thrash_backoff");
    expect(backoffs.length).toBe(1);
    // The event reports the CLASS the gate armed on, not one arbitrary
    // item's string -- the operator sees WHAT kept repeating.
    expect((backoffs[0]!.payload as { detail?: string }).detail).toBe("sell:no_buyers");
  });

  // The class boundary: normalization applies ONLY to the no-buyers class. A
  // genuinely different block class interrupting a no-buyers streak must
  // still reset it (no arm), exactly as any different detail does. Catches
  // both an over-broad pattern (if "hull critical" classified as no-buyers,
  // the streak would hit 3 and arm here) and a sticky-class bug (a class key
  // that survives an unrelated block).
  test("issue #146 boundary: a different-class block still resets a building no-buyers streak", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const reasons = [
      "Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)",
      "Sold 0 Vanadium Ore for 0cr, 20 unsold (no buyers)",
      "hull critical",
    ];
    let calls = 0;
    const api: GameApi = {
      async action(): Promise<V2Result> { throw new SpacemoltError("command_error", reasons[calls++]!); },
      async status() { return { ...status, credits: now }; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const sellPlan: Plan = { goal: "sell the hold", steps: [{ action: "sell", params: { id: "gold_ore", quantity: 33 } }] };
    const planner = new MockPlanner([sellPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1)
    await tick(agent); // blocks: no buyers (Gold Ore)
    await tick(agent); // blocked wake -> streak=1 -> replan (2)
    await tick(agent); // blocks: no buyers (Vanadium Ore, same class)
    await tick(agent); // blocked wake -> streak=2 -> replan (3)
    await tick(agent); // blocks: "hull critical" (DIFFERENT class)
    await tick(agent); // blocked wake -> streak RESETS to 1 -> replan (4), no arm

    expect(planner.contexts.length).toBe(4); // replanning continued -- the gate did not arm
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);
  });
});

// SM-9 fix (live diagnosis 2026-07-11 -- ground truth: 17 phantom "successful"
// sell steps looped ~20min, cargo/credits verified unchanged via live
// get_status, ~44 planner calls/hr burned undetected). The blocked-loop
// damper above only engages when evaluateWake (wake.ts) returns "blocked" --
// a plan that reports plan_done every cycle never trips it, no matter how
// many times it repeats. This is the general second line of defense for that
// failure class (effect-verification in executor.ts closes the loophole for
// `sell` specifically; this damper catches any OTHER action whose
// verification the executor doesn't yet cover): 3 consecutive plan_done wakes
// completing the IDENTICAL goal text arm the SAME backoff mechanism as the
// blocked-streak fix, via agent.ts's runOnce() compound "reason:detail" key
// (this.lastThrashKey) -- see BLOCKED_THRASH_THRESHOLD's comment in agent.ts
// for the full derivation of why one counter serves both streak kinds.
describe("Agent success-plan thrash damping (SM-9: the blocked damper's blind twin)", () => {
  function stubApiAlwaysSucceeds(): GameApi {
    return {
      async action(): Promise<V2Result> { return { result: "ok" }; }, // envelope always looks fine
      async status() { return status; },
      async notifications() { return []; },
    };
  }

  test("3 plan_done wakes completing an identical goal defer replanning for the window, then replanning resumes; sustained thrash re-arms", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const api = stubApiAlwaysSucceeds();
    const store = new Store(":memory:");
    // Single-step, single-shot plan: one tick to execute -> plan_done. Models
    // the ground-truth bug generically (any action whose envelope looks fine
    // every cycle while the goal never actually changes), not sell-specific.
    const sameGoalPlan: Plan = { goal: "sell all cargo", steps: [{ action: "dock", params: {} }] };
    const planner = new MockPlanner([sameGoalPlan]); // repeats the same "successful" plan forever
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan wake -> replan A (unconditional, doesn't touch the streak)
    await tick(agent); // A's only step ("dock") succeeds -> plan_done
    await tick(agent); // plan_done wake, new goal -> streak=1 -> replan B
    await tick(agent); // B's step succeeds -> plan_done
    await tick(agent); // plan_done wake, same goal -> streak=2 -> replan C
    await tick(agent); // C's step succeeds -> plan_done
    expect(planner.contexts.length).toBe(3); // A, B, C

    await tick(agent); // plan_done wake, same goal -> streak=3 -> threshold reached, gate arms, no replan
    expect(planner.contexts.length).toBe(3);
    let types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(1);

    await tick(agent); // still inside the window: backoff branch suppresses the replan
    expect(planner.contexts.length).toBe(3);

    now += config.heartbeatMinutes * 60_000; // jump past the backoff window
    await tick(agent); // plan_done wake, backoff expired, streak was reset at arm -> replans normally (streak=1) -> replan D
    expect(planner.contexts.length).toBe(4); // NOT permanently grounded

    // Sustained thrash: streak position 1 was already consumed by replan D's
    // own wake, so re-arming needs only 2 more identical-goal completions --
    // the same asymmetry the blocked-streak test above documents.
    await tick(agent); // D's step succeeds -> plan_done
    await tick(agent); // plan_done wake, same goal -> streak=2 -> replan E
    await tick(agent); // E's step succeeds -> plan_done
    await tick(agent); // plan_done wake, same goal -> streak=3 -> re-arm (2nd backoff event), no replan F
    expect(planner.contexts.length).toBe(5); // D, E -- no replan F this time
    types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(2);
  });

  test("a plan_done wake completing a DIFFERENT goal resets the success-streak instead of accumulating toward it", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    // Advancing credits (unlike stubApiAlwaysSucceeds' frozen status): this test
    // drives varying goal text through completed plans to exercise the damper's
    // goal-key reset. The agent is genuinely progressing (credits climbing), so
    // the Layer 4 freeze detector -- which keys on game state, not goal wording
    // -- correctly stays quiet and leaves the damper's behavior observable. With
    // a frozen status here, frozen-state-plus-churning-goal is exactly Layer 4's
    // target and it would arm before the damper, masking this assertion.
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return { ...status, credits: now }; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const goals = [
      "sell all cargo", "sell all cargo", "explore nearby systems",
      "sell all cargo", "sell all cargo", "sell all cargo",
    ];
    const contexts: PlanContext[] = [];
    let i = 0;
    const planner: Planner = {
      async plan(ctx: PlanContext) {
        contexts.push(ctx);
        const goal = goals[Math.min(i, goals.length - 1)]!;
        i++;
        return { plan: { goal, steps: [{ action: "dock", params: {} }] }, promptChars: 0, responseChars: 0 };
      },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1) goal "sell all cargo"
    await tick(agent); // completes: "sell all cargo"
    await tick(agent); // plan_done wake, new -> streak=1 -> replan (2) goal "sell all cargo"
    await tick(agent); // completes: "sell all cargo" (same)
    await tick(agent); // plan_done wake, same -> streak=2 -> replan (3) goal "explore nearby systems"
    await tick(agent); // completes: "explore nearby systems" (DIFFERENT)
    await tick(agent); // plan_done wake, different -> streak RESETS to 1 -> replan (4) goal "sell all cargo"
    await tick(agent); // completes: "sell all cargo" (different from "explore nearby systems")
    await tick(agent); // plan_done wake, different -> streak RESETS to 1 -> replan (5) goal "sell all cargo"
    await tick(agent); // completes: "sell all cargo" (same)
    await tick(agent); // plan_done wake, same -> streak=2 -> replan (6) goal "sell all cargo"
    await tick(agent); // completes: "sell all cargo" (same, 3rd in this sub-run)
    await tick(agent); // plan_done wake, same -> streak=3 -> gate arms, no replan (7)

    // 6 total plan_done wakes occurred, well past the threshold of 3 -- but
    // because 2 of them broke the streak with a different goal, the gate only
    // arms once, not twice.
    expect(contexts.length).toBe(6);
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(1);
  });

  // The compound "reason:detail" key (agent.ts runOnce()) is what makes the
  // spec's "any blocked wake resets the success-streak" true for free: a
  // blocked wake's key ("blocked:...") never matches a plan_done streak's key
  // ("plan_done:..."), so switching kinds always looks like "a genuinely
  // different identity" -- no separate reset branch to keep in sync. This
  // test proves the reset actually happens rather than asserting the
  // implementation detail directly: after 2 identical-goal completions (streak
  // at 2, one shy of arming) a blocked step interrupts, and re-arming from
  // there needs a FULL fresh run of 3 identical-reason blocked wakes -- if the
  // streak had carried over instead of resetting, arming would happen one
  // wake sooner.
  test("a blocked wake interrupts a run of identical plan_done completions and resets the streak (not just a different detail -- a different thrash KIND)", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    let blocking = false;
    const api: GameApi = {
      async action(): Promise<V2Result> {
        if (blocking) throw new SpacemoltError("command_error", "nothing to mine here");
        return { result: "ok" };
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const succeedPlan: Plan = { goal: "sell all cargo", steps: [{ action: "dock", params: {} }] };
    const blockPlan: Plan = { goal: "mine at a barren base", steps: [{ action: "mine", params: {} }] };
    // MockPlanner cycles through this list, repeating the last entry forever.
    const planner = new MockPlanner([succeedPlan, succeedPlan, blockPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan A (succeedPlan)
    await tick(agent); // A completes -> plan_done
    await tick(agent); // plan_done wake, new -> streak=1 -> replan B (succeedPlan)
    await tick(agent); // B completes -> plan_done
    await tick(agent); // plan_done wake, same goal -> streak=2 -> replan C (blockPlan)
    blocking = true; // C's step now blocks instead of succeeding
    await tick(agent); // C's "mine" step blocks
    await tick(agent); // blocked wake, DIFFERENT kind -> streak RESETS to 1 -> replan D (blockPlan repeats)
    expect(planner.contexts.length).toBe(4); // A, B, C, D -- no backoff armed yet
    let types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(0);

    await tick(agent); // D blocks (same reason)
    await tick(agent); // blocked wake, same -> streak=2 -> replan E (blockPlan repeats)
    await tick(agent); // E blocks (same reason)
    await tick(agent); // blocked wake, same -> streak=3 -> gate arms, no replan F
    expect(planner.contexts.length).toBe(5); // D, E -- confirms the reset cost a full fresh run, not just one more wake
    types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "plan_thrash_backoff").length).toBe(1);
  });
});
