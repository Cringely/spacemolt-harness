import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { Store } from "../src/store/store";
import { TransientPlannerError } from "../src/planner/errors";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner, PlanContext, PlanResult } from "../src/planner/types";

// #815 live symptom: /instruct returned 204 but a corsair's goals were
// unchanged ten minutes later -- the planner backoff gate blocked EVERY wake
// reason, including "instruction", so a queued operator steer sat in the
// inbox until TRANSIENT_BACKOFF_MAX_MS (10 min) expired on its own. The
// plan-budget ceiling a few lines below already carves out
// `wake.reason !== "instruction"`; the backoff gate didn't.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

function stubApi(): GameApi {
  const status: StatusSnapshot = {
    credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
}

// Fails on the first call (arming backoff), serves a real plan on every call
// after -- models a planner endpoint down for exactly one replan.
function throwOnceThenPlan(err: Error, plan: Plan): Planner & { calls: number } {
  return {
    calls: 0,
    async plan(_ctx: PlanContext): Promise<PlanResult> {
      this.calls++;
      if (this.calls === 1) throw err;
      return { plan, promptChars: 0, responseChars: 0, model: "mock" };
    },
  };
}

describe("Agent operator-instruction bypass of planner backoff (#815)", () => {
  test("an /instruct steer queued during an active backoff window reaches the planner on the next tick, not after backoff expires", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const plan: Plan = { goal: "dock immediately", steps: [{ action: "dock", params: {} }] };
    const planner = throwOnceThenPlan(new TransientPlannerError("down"), plan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store, planner, config, now: () => now,
    });

    await agent.runOnce(); // no_plan wake -> replan (call 1) -> transient failure, arms backoff
    expect(planner.calls).toBe(1);
    expect(agent.snapshot().plannerHealth.backoffUntil).toBeGreaterThan(0);

    const instructionText = "abandon current goal, dock immediately";
    agent.instruct(instructionText);

    now += 1; // 1ms later -- deep inside the 30s TRANSIENT_BACKOFF_BASE_MS window
    await agent.runOnce();

    // 1. the instruction wake reached the planner despite active backoff
    expect(planner.calls).toBe(2);
    // 2. the wake that drove that replan really is instruction-class
    const wakes = store.recentEvents("a1", 100).filter((e) => e.type === "wake");
    expect((wakes.at(-1)!.payload as { reason: string }).reason).toBe("instruction");
    // 3. the instruction was CONSUMED (pushed into goals by replan()), not
    // merely re-peeked and left queued -- this is what proves it was acted on.
    expect(agent.snapshot().goals).toContain(instructionText);
  });
});
