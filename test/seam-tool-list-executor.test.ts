import { describe, expect, test } from "bun:test";
import { buildDigest } from "../src/planner/digest";
import { PlanSchema, type Plan } from "../src/registry/plan";
import { executeTick } from "../src/agent/executor";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { PlanContext } from "../src/planner/types";

// Tool-list <-> executor seam (issue #165, seam manifest #3: docs/wiki/seam-manifest.md).
//
// `travel_to` is not a real game action (it expands into a sequence of `jump`
// calls -- see src/agent/executor.ts's travelToTick), so unlike every other
// action it has no src/registry/actions.ts REGISTRY entry to derive from. It
// is hand-typed in THREE places with no shared schema forcing them to agree:
//   - src/planner/digest.ts's TRAVEL_TO_VOCAB: the only text that tells the
//     planner travel_to exists and what params it takes.
//   - src/registry/plan.ts's TravelToStepSchema: what PlanSchema admits.
//   - src/agent/executor.ts's travelToTick: what actually runs, reading
//     step.params.system_id directly.
//
// The gap this closes: TypeScript ties executor.ts's `step.params.system_id`
// to whatever PlanStepSchema currently types, so a param rename in the schema
// would fail the executor's typecheck and force a fix there -- but it would
// NOT touch the plain string in TRAVEL_TO_VOCAB, which is just prose with no
// type link to the schema at all. The planner would keep being told a param
// name the schema no longer accepts, and every travel_to plan would fail
// admission with no obvious cause. This test fails if any one side drifts
// from the other two.

const baseCtx: PlanContext = {
  persona: "a pragmatic pilot",
  goals: [],
  wake: { reason: "heartbeat" },
  statusSummary: "status",
  recentEvents: [],
};

describe("tool-list <-> executor seam (issue #165): travel_to's hand-added param key", () => {
  test("the digest's advertised vocab, PlanSchema's admitted shape, and the executor's actual dispatch all agree on `system_id`", async () => {
    // Side 1 (tool list): the only planner-facing text that says travel_to
    // exists must name the real param key.
    expect(buildDigest(baseCtx)).toContain("travel_to(system_id:string)");

    // Side 2 (schema): admits system_id, rejects a plan keyed on anything else
    // -- if TRAVEL_TO_VOCAB drifted (a stale/renamed key), a plan built off the
    // briefing's OWN advice would fail right here.
    expect(
      PlanSchema.safeParse({ goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-9" } }] }).success,
    ).toBe(true);
    expect(
      PlanSchema.safeParse({ goal: "g", steps: [{ action: "travel_to", params: { target_system: "sys-9" } }] })
        .success,
    ).toBe(false);

    // Side 3 (executor): a plan built with the schema's accepted shape must
    // reach find_route with THAT system id -- proving travelToTick reads
    // params.system_id, not some other key that would silently pass a looser
    // schema but never actually drive the ship anywhere.
    const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
    const api: GameApi = {
      async action(name, params) {
        calls.push({ name, params });
        return name === "find_route"
          ? { structuredContent: { found: false, message: "no route", route: [] } }
          : { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId: "sys-1",
        };
      },
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-9" } }] };
    await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(calls[0]).toEqual({ name: "find_route", params: { id: "sys-9" } });
  });
});
