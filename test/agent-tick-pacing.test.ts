import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { executeTick } from "../src/agent/executor";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

// SM-12 (operator-reported 2026-07-12): `mine` returns a SUCCESS envelope whose
// result text is "Action pending. Resolves next tick" -- the yield lands a tick
// LATER, in status, not in this result. The prior code counted that as an
// ordinary `continue` and re-fired the SAME repeated step on the very next ~10s
// loop, racing the still-resolving ~10s tick; when the re-fire beat the
// resolution the game answered "Another action is already in progress for this
// player" -- caught as a transient wait (no lost action, no replan) but a wasted
// submission and dashboard noise every racing loop. The fix paces to the tick:
// on a pending accept the executor flags the continue with `settle`, so the loop
// SKIPS exactly one submission before re-firing. These tests prove the churn is
// REDUCED (half as many submissions, zero self-race), not merely relabeled.

const PENDING = "Action pending. Resolves next tick.";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const healthy: StatusSnapshot = {
  credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 10, cargoCapacity: 50, docked: false, inTransit: false,
};

describe("executeTick: pending accept paces to the tick (SM-12)", () => {
  // Ablation for the settle producer. A pending accept on a step that STAYS
  // (repeat not yet exhausted / until not yet met) advances the iteration AND
  // carries `settle` -- the signal that tells the loop to skip one submission.
  function pendingApi(resultText: string, status: StatusSnapshot): { api: GameApi; calls: string[] } {
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> { calls.push(name); return { result: resultText }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    return { api, calls };
  }

  test("a 'Resolves next tick' accept on a repeat step returns a same-step continue flagged settle", async () => {
    const { api } = pendingApi(PENDING, healthy);
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {}, repeat: 3 }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({
      kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: PENDING, settle: true,
    });
  });

  test("a 'Resolves next tick' accept on an until step (condition unmet) is also flagged settle", async () => {
    // cargoUsed 10 < capacity 50 -> cargo_full unmet -> stays on the step.
    const { api } = pendingApi(PENDING, healthy);
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("continue");
    expect((r as { settle?: true }).settle).toBe(true);
  });

  test("a NON-pending success on the same repeat step does NOT set settle (no false pacing)", async () => {
    const { api } = pendingApi("ok", healthy);
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {}, repeat: 3 }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });
    expect((r as { settle?: true }).settle).toBeUndefined();
  });

  test("a pending accept that COMPLETES the step (advances) carries no settle -- the next action differs", async () => {
    // Final repeat iteration: stepDone true -> advance to the next step. No
    // self-race to pace against, so settle is absent even though the text is
    // pending. (cargo_full unmet is irrelevant here; this is a repeat step.)
    const { api } = pendingApi(PENDING, healthy);
    const plan: Plan = { goal: "g", steps: [
      { action: "mine", params: {}, repeat: 2 },
      { action: "dock", params: {} },
    ]};
    const r = await executeTick(api, plan, { step: 0, iteration: 1 }); // iteration -> 2 == repeat
    expect(r).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 }, resultText: PENDING });
    expect((r as { settle?: true }).settle).toBeUndefined();
  });
});

describe("Agent: pending action does not re-fire the next tick (SM-12)", () => {
  test("a pending mine submits on alternating ticks -- never two ticks in a row -- with zero replans and zero 'already in progress'", async () => {
    let now = 0;
    let tickNo = 0;
    const tick = async (agent: Agent) => { now += 1_000; tickNo++; await agent.runOnce(); };

    // The fake models the game's one-mutation-per-tick lock: a mine submitted on
    // the tick IMMEDIATELY after a prior mine (before "next tick" resolution)
    // is the race that produces "Another action is already in progress". If the
    // loop ever re-fires without a settle gap, alreadyInProgress increments --
    // the exact churn the fix must eliminate. cargo never fills, so the mine
    // step never completes on its own (the pacing, not completion, is on trial).
    const mineTicks: number[] = [];
    let alreadyInProgress = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "mine") {
          if (mineTicks.length && tickNo === mineTicks[mineTicks.length - 1]! + 1) {
            alreadyInProgress++;
            throw new SpacemoltError("command_error", "Another action is already in progress for this player");
          }
          mineTicks.push(tickNo);
          return { result: PENDING };
        }
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> { return healthy; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const plan: Plan = { goal: "mine here", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    const planner = new MockPlanner([plan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1). cursor step 0.
    expect(planner.contexts.length).toBe(1);

    // 8 execution ticks. With pacing, mine fires on ticks 2,4,6,8 (4 times) and
    // ticks 3,5,7,9 are settle skips -- never two mines back to back.
    for (let n = 0; n < 8; n++) await tick(agent);

    expect(alreadyInProgress).toBe(0);          // the race never happened -- reduced, not relabeled
    expect(mineTicks.length).toBe(4);           // ~half the 8 execution ticks, not one per tick
    // No two submissions on consecutive ticks (the pacing invariant).
    for (let i = 1; i < mineTicks.length; i++) {
      expect(mineTicks[i]! - mineTicks[i - 1]!).toBeGreaterThanOrEqual(2);
    }
    expect(planner.contexts.length).toBe(1);    // zero replans across the whole run
    expect(agent.snapshot().planState).toBe("running");
    expect(agent.snapshot().stepIndex).toBe(0); // still on the mine step

    // The settle ticks are visible as `wait` action events, and NONE carry the
    // "already in progress" churn text (proving the skips replaced the race).
    const actions = store.recentEvents("a1", 200)
      .filter((e) => e.type === "action")
      .map((e) => e.payload as { outcome: string; result?: string });
    const waits = actions.filter((a) => a.outcome === "wait");
    expect(waits.length).toBe(4);               // one settle per pending fire
    expect(waits.every((w) => !/already in progress/i.test(w.result ?? ""))).toBe(true);
  });

  test("a pending accept that NEVER resolves does not hold forever -- the heartbeat wake still escalates", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const calls: string[] = [];
    const api: GameApi = {
      // Always pending: models an async action whose yield never lands. The
      // fire/settle alternation must NOT become a permanent hold -- lastPlanAt
      // stays frozen (never written on a fire or a settle tick), so once the
      // heartbeat window elapses the heartbeat wake fires and replans.
      async action(name): Promise<V2Result> { calls.push(name); return { result: PENDING }; },
      async status(): Promise<StatusSnapshot> { return healthy; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    const plan: Plan = { goal: "mine forever", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    const planner = new MockPlanner([plan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan (1). lastPlanAt = now.
    expect(planner.contexts.length).toBe(1);

    for (let n = 0; n < 20; n++) await tick(agent); // well inside the heartbeat window
    expect(planner.contexts.length).toBe(1);            // zero replans across the hold
    expect(agent.snapshot().planState).toBe("running"); // never latched to blocked
    expect(agent.snapshot().stepIndex).toBe(0);         // held on the mine step
    expect(calls.length).toBeGreaterThan(0);            // it DID keep firing (every other tick), not frozen

    now += config.heartbeatMinutes * 60_000; // cross the heartbeat boundary
    await tick(agent);
    expect(planner.contexts.length).toBe(2);            // heartbeat escalated the stuck pending
    const wakes = store.recentEvents("a1", 300).filter((e) => e.type === "wake");
    expect((wakes.at(-1)!.payload as { reason: string }).reason).toBe("heartbeat");
  });
});
