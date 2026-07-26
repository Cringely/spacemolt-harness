import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { Store } from "../src/store/store";
import { TransientPlannerError, SubscriptionLimitError, TokenInvalidError } from "../src/planner/errors";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner } from "../src/planner/types";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 3, subscriptionCooldownMinutes: 60,
};

function stubApi(status?: Partial<StatusSnapshot>) {
  const s: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, ...status,
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return s; },
    async notifications() { return []; },
  };
  return api;
}

const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };
const alwaysThrows = (err: Error): Planner => ({ plan: async () => { throw err; } });
const alwaysSucceeds = (plan: Plan): Planner => ({ plan: async () => ({ plan, promptChars: 0, responseChars: 0 }) });

describe("Agent failure classification", () => {
  test("transient failures back off exponentially, then stall after stallThreshold", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("network down")),
      config, now: () => now,
    });

    await agent.runOnce(); // no_plan wake -> replan -> transient failure #1
    now += 15 * 60_000 + 1; // well past the 30s-base backoff and the heartbeat
    await agent.runOnce(); // #2
    now += 15 * 60_000 + 1;
    await agent.runOnce(); // #3 -> reaches stallThreshold (3)

    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(3);
    expect(types).toContain("stalled");
  });

  test("backoff suppresses replan spam while a running plan keeps executing", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const calls: string[] = [];
    const status: StatusSnapshot = {
      credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100, // low fuel -> wake fires every tick
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(name) { calls.push(name); return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const agent = new Agent({
      id: "a1", persona: "p", api, store,
      planner: alwaysThrows(new TransientPlannerError("down")),
      config, now: () => now,
    });

    await agent.runOnce(); // low_fuel wake -> replan attempted -> fails, backoff set (~30s from now=0)
    now += 1_000; // still inside the 30s backoff window
    await agent.runOnce(); // low_fuel wake fires again, backoff suppresses replan -> executes plan step instead
    expect(calls).toEqual(["mine"]); // the saved plan kept running despite the failing planner
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(1); // not retried during backoff
  });

  test("subscription_limit switches to the fallback planner for the next replan attempt", async () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new SubscriptionLimitError("usage limit")),
      fallbackPlanner: alwaysSucceeds(okPlan),
      config, now: () => 1,
    });
    await agent.runOnce(); // primary fails -> usingFallback = true, no plan yet
    expect(store.loadPlan("a1")).toBeNull();
    await agent.runOnce(); // no_plan wake still active -> now routed to fallback -> succeeds
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok");
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("planner_subscription_limit");
  });

  test("subscription_limit with no fallback enters a long cooldown -- no hot retry loop", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new SubscriptionLimitError("usage limit")),
      config, now: () => now,
    });
    await agent.runOnce(); // sets cooldown = 60 min from now=0
    now = 15 * 60_000 + 1; // a heartbeat would normally re-wake here
    await agent.runOnce(); // still inside the 60min cooldown -> no second attempt
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_subscription_limit").length).toBe(1);
  });

  test("token_invalid disables the primary planner permanently and falls back if configured", async () => {
    const store = new Store(":memory:");
    let primaryCalls = 0;
    const primary: Planner = { plan: async () => { primaryCalls++; throw new TokenInvalidError("bad token"); } };
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: alwaysSucceeds(okPlan),
      config, now: () => 1,
    });
    await agent.runOnce(); // token_invalid -> claudeDisabled = true, operator_alert emitted
    await agent.runOnce(); // this and every future replan routes straight to the fallback
    expect(primaryCalls).toBe(1); // never called again
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok");
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("operator_alert");
  });

  test("plan violating PlanSchema bounds is rejected at the replan seam: planner_error, nothing executed", async () => {
    const store = new Store(":memory:");
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
      async status() {
        return {
          credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
    };
    const hallucinating: Planner = {
      plan: async () => ({
        plan: { goal: "grind forever", steps: [{ action: "mine", params: {}, repeat: 999999 }] } as unknown as Plan,
        promptChars: 0, responseChars: 0,
      }),
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: hallucinating, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan -> PlanSchema.parse rejects
    expect(store.loadPlan("a1")).toBeNull(); // never persisted
    expect(calls).toEqual([]); // no game mutation executed
    const types = store.recentEvents("a1", 10).map((e) => e.type);
    expect(types).toContain("planner_error"); // existing catch-all path, not a crash
  });
});

describe("Reversible endpoint fallback (#240)", () => {
  const MIN = 60_000;
  const HEARTBEAT = 15 * MIN + 1; // one guaranteed wake, matching config.heartbeatMinutes

  // Fails the first `failures` calls, then succeeds -- lets a test bring the
  // primary back up without swapping the object out mid-run.
  function flakyPlanner(failures: number, plan: Plan): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan() {
        p.calls++;
        if (p.calls <= failures) throw new TransientPlannerError("connect ECONNREFUSED");
        return { plan, promptChars: 0, responseChars: 0 };
      },
    };
    return p;
  }

  function countingPlanner(plan: Plan): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan() { p.calls++; return { plan, promptChars: 0, responseChars: 0 }; },
    };
    return p;
  }

  function throwingCounter(): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan(): Promise<never> { p.calls++; throw new TransientPlannerError("fallback blip"); },
    };
    return p;
  }

  // Answers every time, but its plans never validate -- the catch-all failure
  // class, and the marginal-local-model shape Stage 2 can produce.
  function invalidPlanCounter(): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan(): Promise<never> {
        p.calls++;
        throw new Error("openai-compat: plan validation failed after retry");
      },
    };
    return p;
  }

  test("two consecutive primary failures route the next replan to the fallback; one does not", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: fallback, config, now: () => now,
    });

    await agent.runOnce();               // primary failure #1
    expect(fallback.calls).toBe(0);      // one failure is a blip, not a down endpoint
    now += HEARTBEAT;
    await agent.runOnce();               // primary failure #2 -> arms the countdown
    expect(fallback.calls).toBe(0);      // arming happens after the call, not during it
    now += HEARTBEAT;
    await agent.runOnce();               // this replan is served by the fallback

    expect(fallback.calls).toBe(1);
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("planner_endpoint_down");
  });

  test("planner_endpoint_down is emitted once per transition, not once per failure or re-arm", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: countingPlanner(okPlan), config, now: () => now,
    });

    // Long enough to drain the countdown, fail a probe replan against the
    // still-dead primary, and re-arm -- five times over. A re-arm must not
    // re-announce.
    for (let i = 0; i < 16; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const downs = store.recentEvents("a1", 200).filter((e) => e.type === "planner_endpoint_down");
    expect(downs.length).toBe(1);
  });

  test("a dual outage announces the endpoint down once, and keeps probing", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const fallback = throwingCounter();
    const primary = throwingCounter();
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    // Both planners dead. consecutivePrimaryFailures counts only the primary,
    // so the fallback's failures neither arm nor re-announce; the probe replan
    // is the only thing that re-enters the arming block, and it must not
    // re-announce either.
    for (let i = 0; i < 16; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const downs = store.recentEvents("a1", 300).filter((e) => e.type === "planner_endpoint_down");
    expect(downs.length).toBe(1);
    expect(primary.calls).toBeGreaterThan(2); // still probing, not wedged on the fallback
    expect(fallback.calls).toBeGreaterThan(0); // still trying the fallback too
  });

  test("the probe replan reaches a recovered primary and emits planner_endpoint_recovered", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan); // dies twice, then healthy
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    // 5 heartbeat-spaced ticks at ENDPOINT_RETRY_REPLANS = 3: two primary
    // failures arm the countdown (ticks 0-1), the fallback serves two replans
    // (ticks 2-3), and tick 4 is the probe that reaches the recovered primary.
    for (let i = 0; i < 5; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const types = store.recentEvents("a1", 200).map((e) => e.type);
    expect(types).toContain("planner_endpoint_recovered");
    expect(primary.calls).toBe(3); // two failures plus the one successful probe

    const fallbackAtRecovery = fallback.calls;
    for (let i = 0; i < 4; i++) { await agent.runOnce(); now += HEARTBEAT; }
    expect(fallback.calls).toBe(fallbackAtRecovery); // never served again
    expect(store.recentEvents("a1", 200).filter((e) => e.type === "planner_endpoint_recovered").length).toBe(1);
  });

  test("a fallback success does not end the down state", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan); // healthy from call 3 on
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }
    expect(fallback.calls).toBe(1);      // the fallback has served once and succeeded
    const primaryAtHandover = primary.calls;

    // One more replan, still inside the countdown (D reaches 1 only on the
    // NEXT one). The primary is healthy again from call 3, so anything that let
    // a fallback success clear the state would hand this replan back to it.
    await agent.runOnce();
    now += HEARTBEAT;

    expect(primary.calls).toBe(primaryAtHandover);
    expect(fallback.calls).toBe(2);
    const types = store.recentEvents("a1", 200).map((e) => e.type);
    expect(types).not.toContain("planner_endpoint_recovered");
  });

  test("a fallback failure does not arm the down state against the primary", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan);
    const fallback = throwingCounter(); // the fallback has a blip of its own
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    for (let i = 0; i < 10; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const types = store.recentEvents("a1", 200).map((e) => e.type);
    // Fallback failures must not keep re-arming the countdown: the primary
    // still gets its probe replan and still recovers. Blaming the primary for
    // the fallback's blip would re-arm on every fallback call and lock it out.
    expect(primary.calls).toBeGreaterThan(2);
    expect(types).toContain("planner_endpoint_recovered");
  });

  test("with no fallback configured, transient failures behave exactly as before", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      config, now: () => now, // no fallbackPlanner
    });

    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(3);
    expect(types).toContain("stalled");
    expect(types).not.toContain("planner_endpoint_down");
  });

  test("a primary that only ever answers with unusable plans still reaches the fallback", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const answersButFails = invalidPlanCounter();
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: answersButFails, fallbackPlanner: fallback, config, now: () => now,
    });

    // The pure catch-all shape, armed by nothing else: HTTP 200 on every
    // replan, plans that never validate. consecutiveTransientFailures is never
    // touched, so a counter derived from it never arms and the pilot produces
    // ZERO plans while still answering endpoint checks. That is the likeliest
    // Stage 2 failure (LM Studio up, the model marginal), so it is asserted
    // here rather than admitted in prose.
    for (let i = 0; i < 20; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const evs = store.recentEvents("a1", 400);
    expect(evs.filter((e) => e.type === "planner_endpoint_down").length).toBe(1);
    expect(fallback.calls).toBeGreaterThan(0);                     // the fallback is reached
    expect(evs.filter((e) => e.type === "plan").length).toBeGreaterThan(0); // and plans land
    expect(answersButFails.calls).toBeGreaterThan(2);              // the primary is still probed
  });

  test("a primary that goes from unreachable to unusable keeps reaching the fallback", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const answersButFails = invalidPlanCounter();
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: fallback, config, now: () => now,
    });

    // Arm on a dead endpoint, then swap the primary for one that ANSWERS but
    // returns unusable plans: the failure class changes mid-outage. A counter
    // that only the transient branch maintains parks at 1 here.
    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }
    (agent as unknown as { planner: Planner }).planner = answersButFails;

    // Let the state settle well past the countdown, THEN measure. The harm is
    // not "the fallback is never served again" (it still drains the countdown
    // once); it is that the pilot stops producing plans at all from there on.
    for (let i = 0; i < 10; i++) { await agent.runOnce(); now += HEARTBEAT; }
    const settled = Math.max(0, ...store.recentEvents("a1", 400).map((e) => e.id));
    const fallbackAtSettle = fallback.calls;

    for (let i = 0; i < 10; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const late = store.recentEvents("a1", 400).filter((e) => e.id > settled);
    expect(answersButFails.calls).toBeGreaterThan(1); // the primary is still probed
    expect(late.filter((e) => e.type === "plan").length).toBeGreaterThan(0); // still planning
    expect(fallback.calls).toBeGreaterThan(fallbackAtSettle); // via the fallback
  });

  test("one primary failure after a recovery does not re-arm the down state", async () => {
    let now = 0;
    const store = new Store(":memory:");
    // Fails calls 1-2 (arms), succeeds on call 3 (the probe -> recovery), fails
    // call 4 (a single post-recovery blip), succeeds after.
    let calls = 0;
    const primary: Planner & { calls: number } = {
      calls: 0,
      async plan() {
        calls++;
        primary.calls = calls;
        if (calls <= 2 || calls === 4) throw new TransientPlannerError("blip");
        return { plan: okPlan, promptChars: 0, responseChars: 0 };
      },
    };
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    for (let i = 0; i < 5; i++) { await agent.runOnce(); now += HEARTBEAT; }
    expect(store.recentEvents("a1", 400).filter((e) => e.type === "planner_endpoint_recovered").length).toBe(1);
    const fallbackAtRecovery = fallback.calls;

    // Call 4 is the single blip. Without the post-recovery counter reset the
    // stale count is still at the threshold, so this one failure re-arms and
    // hands the next replans back to the paid fallback.
    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }

    expect(store.recentEvents("a1", 400).filter((e) => e.type === "planner_endpoint_down").length).toBe(1);
    expect(fallback.calls).toBe(fallbackAtRecovery);
  });

  // Breakage caught: hoisting the counting block above the TokenInvalid and
  // SubscriptionLimit branches. That placement is the whole of "a latch is a
  // verdict on the subscription, not evidence an endpoint is unreachable", and
  // nothing else in the suite can see it -- every other test drives the
  // threshold with two failures of ONE counted class, which the hoist does not
  // change. The threshold needs two counted failures, NOT two of the same
  // class, so a transient failure followed by a latching one is the sequence
  // that separates the two placements. Reachable in the shape running in
  // production today (Claude-subscription primary, fallback configured); NOT
  // reachable in Stage 2's local-primary shape, because openai-compat.ts
  // classifies everything as transient.
  test("a mixed-class primary outage never counts the latching failure", async () => {
    let now = 0;
    const store = new Store(":memory:");
    let calls = 0;
    const primary: Planner & { calls: number } = {
      calls: 0,
      async plan(): Promise<never> {
        calls++;
        primary.calls = calls;
        // Failure 1 is counted (count -> 1). Failure 2 is a latch: it must
        // return BEFORE the counting block, leaving the count at 1. Hoisted,
        // it reaches 2 and announces the endpoint down.
        if (calls === 1) throw new TransientPlannerError("connect ECONNREFUSED");
        throw new SubscriptionLimitError("weekly quota exhausted");
      },
    };
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    await agent.runOnce();               // transient failure -> count 1
    now += HEARTBEAT;
    await agent.runOnce();               // subscription limit -> latches, must NOT count
    now += HEARTBEAT;

    const types = store.recentEvents("a1", 200).map((e) => e.type);
    expect(types).toContain("planner_subscription_limit"); // the real cause is reported
    expect(types).not.toContain("planner_endpoint_down");  // and not mislabelled
    expect(primary.calls).toBe(2);
  });
});
