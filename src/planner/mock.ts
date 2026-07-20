import type { Plan } from "../registry/plan";
import type { PlanContext, Planner, PlanResult } from "./types";

export class MockPlanner implements Planner {
  contexts: PlanContext[] = [];
  private i = 0;

  constructor(private plans: Plan[]) {
    if (plans.length === 0) throw new Error("MockPlanner needs at least one plan");
  }

  async plan(ctx: PlanContext): Promise<PlanResult> {
    this.contexts.push(ctx);
    const plan = this.plans[Math.min(this.i, this.plans.length - 1)]!;
    this.i++;
    // No real LLM call, so zero real tokens: a mock reports zero prompt/response
    // chars and model "mock" (priced free in usage.ts). Cost-metric tests seed
    // plan events with explicit char counts rather than driving through the mock.
    return { plan, promptChars: 0, responseChars: 0, model: "mock" };
  }
}
