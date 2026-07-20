import { describe, expect, test } from "bun:test";
import { MockPlanner } from "../src/planner/mock";
import type { Plan } from "../src/registry/plan";

const p1: Plan = { goal: "one", steps: [{ action: "dock", params: {} }] };
const p2: Plan = { goal: "two", steps: [{ action: "undock", params: {} }] };

describe("MockPlanner", () => {
  test("returns queued plans in order, repeats last, records contexts", async () => {
    const planner = new MockPlanner([p1, p2]);
    const ctx = {
      persona: "test", goals: [], wake: { reason: "no_plan" as const },
      statusSummary: "", recentEvents: [],
    };
    expect((await planner.plan(ctx)).plan.goal).toBe("one");
    expect((await planner.plan(ctx)).plan.goal).toBe("two");
    expect((await planner.plan(ctx)).plan.goal).toBe("two"); // repeats last
    expect(planner.contexts.length).toBe(3);
    expect(planner.contexts[0]!.wake.reason).toBe("no_plan");
  });

  test("throws on empty plan array", () => {
    expect(() => new MockPlanner([])).toThrow();
  });
});
