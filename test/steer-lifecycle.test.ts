import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Steer lifecycle (Cringely/spacemolt#535, #542, #821). The goals list is the
// operator's steer channel; these tests pin how a steer ENTERS it (supersedes
// the one before), LEAVES it (a one-shot destructive order, once spent), and
// how the standing config goals ride it (restored without churn).

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};
const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

function stubApi() {
  const actions: string[] = [];
  const status: StatusSnapshot = {
    credits: 1000, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, dockedAt: null, cargo: [],
  };
  const api: GameApi = {
    async action(name: string): Promise<V2Result> { actions.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, actions };
}

describe("superseding steers (#535)", () => {
  // Breakage caught: the live #535 capture -- three "jump and spend fuel"
  // steers and the "do NOT jump" correction sat in goals[] together, because
  // retirement depended on the planner reporting each one done. A newer
  // unpinned steer must replace the older unpinned ones outright.
  test("a newer steer retires the older contradictory steers", async () => {
    const agent = new Agent({
      id: "m1", persona: "p", api: stubApi().api, store: new Store(":memory:"),
      planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    agent.instruct("jump to minkar and spend the fuel");
    await agent.runOnce();
    agent.instruct("CORRECTION: do NOT jump, hold position");
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual(["CORRECTION: do NOT jump, hold position"]);
  });

  // Breakage caught: over-reach. Supersede is for operator errands only. A
  // config goal (agents.yaml) and a pinned "standing until revoked" rule
  // (#817) are not contradicted by a newer errand and must survive it.
  test("config goals and pinned rules survive a newer steer", async () => {
    const agent = new Agent({
      id: "m1", persona: "p", goals: ["MILESTONE"], api: stubApi().api, store: new Store(":memory:"),
      planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    agent.instruct("RULE: keep 10 fuel in reserve", { standing: true });
    await agent.runOnce();
    agent.instruct("errand one");
    await agent.runOnce();
    agent.instruct("errand two");
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual(["MILESTONE", "RULE: keep 10 fuel in reserve", "errand two"]);
  });

  // Breakage caught: the pin is a property of the NEWEST steer too. A pinned
  // steer is additive (it never retires an errand), so one standing rule sent
  // after an errand must not erase it.
  test("a pinned steer does not supersede anything", async () => {
    const agent = new Agent({
      id: "m1", persona: "p", api: stubApi().api, store: new Store(":memory:"),
      planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    agent.instruct("errand one");
    await agent.runOnce();
    agent.instruct("RULE: keep 10 fuel in reserve", { standing: true });
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual(["errand one", "RULE: keep 10 fuel in reserve"]);
  });
});

describe("standing goal merge is stable (#821)", () => {
  const STANDING = ["MILESTONE one", "MILESTONE two", "FUEL rule"];

  // Breakage caught: the live #821 trace. The goals list sits at the cap with
  // two operator steers and one standing goal evicted by the push side. The
  // merge restored it by dropping the OLDEST goal, which was another standing
  // goal, so on the next replan the two swapped places, every replan, and the
  // planner never saw all three. Every standing goal must be present at
  // construction and on every replan, and the list must not change between
  // replans that received no new steer.
  test("three standing goals plus an overflowing steer list do not rotate across replans", async () => {
    const store = new Store(":memory:");
    // The state the cap leaves behind: s0 evicted, s1 and s2 now the oldest.
    store.savePlan("m1", okPlan, [STANDING[1]!, STANDING[2]!, "errand 3", "errand 4", "errand 5"]);
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({
      id: "m1", persona: "p", goals: STANDING, api: stubApi().api, store, planner, config, now: () => 1,
    });
    const seen = [agent.snapshot().goals];
    for (let i = 0; i < 10; i++) {
      await agent.runOnce();
      seen.push(agent.snapshot().goals);
    }
    expect(planner.contexts.length).toBeGreaterThanOrEqual(2);
    for (const goals of seen) for (const s of STANDING) expect(goals).toContain(s);
    for (const ctx of planner.contexts) for (const s of STANDING) expect(ctx.goals).toContain(s);
    // Stable: identical content and order on every replan with no new steer.
    for (const goals of seen) expect(goals).toEqual(seen[0]!);
    // The oldest ERRAND made the room, not a standing goal.
    expect(seen[0]).toEqual([STANDING[0]!, STANDING[1]!, STANDING[2]!, "errand 4", "errand 5"]);
  });
});

describe("a steer the full goal list cannot hold leaves a receipt (#170 review)", () => {
  // Breakage caught: with standing config goals and pinned steers protected
  // from eviction (#821), three config goals plus two pinned steers fill the
  // cap (5), so the only evictable entry is the errand just sent. It was
  // dropped at the push site with no event: the operator's steer vanished
  // and nothing recorded why. The list itself is right (nothing protected is
  // evicted), so the contract is the receipt: an instruction_dropped event
  // naming the lost steer.
  test("an errand that cannot fit beside 3 config goals and 2 pinned steers is dropped with an event", async () => {
    const STANDING = ["MILESTONE one", "MILESTONE two", "FUEL rule"];
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "m1", persona: "p", goals: STANDING, api: stubApi().api, store,
      planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    agent.instruct("RULE: one", { standing: true });
    await agent.runOnce();
    agent.instruct("RULE: two", { standing: true });
    await agent.runOnce();
    expect(store.recentEventsByType("m1", "instruction_dropped", 10)).toEqual([]);
    agent.instruct("errand that cannot fit");
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual([...STANDING, "RULE: one", "RULE: two"]);
    const dropped = store.recentEventsByType("m1", "instruction_dropped", 10);
    expect(dropped.length).toBe(1);
    expect((dropped[0]!.payload as { instruction: string }).instruction).toBe("errand that cannot fit");
  });
});

describe("one-shot destructive steers (#542)", () => {
  // A planner that reads goals the way the live model does: it plans a
  // self_destruct whenever a goal in the briefing names one, and never reports
  // instruction_done (Sonnet set it on none of four consecutive plans).
  function obedientPlanner(steps: Plan["steps"]) {
    return {
      async plan(ctx: { goals?: string[] }) {
        const ordered = (ctx.goals ?? []).some((g) => /self.destruct/i.test(g));
        const plan: Plan = ordered ? { goal: "obey the order", steps } : okPlan;
        return { plan, promptChars: 0, responseChars: 0, model: "mock" };
      },
    };
  }
  const authorized: AgentConfig = { ...config, selfDestructAuthorized: true };
  const ORDER = "Execute standing operator order: self-destruct the ship as authorised";

  // Breakage caught: the live #542 loop -- the order stayed in goals after the
  // first self_destruct, the next replan read it again, and the pilot destroyed
  // each fresh respawn ship (200cr fee plus the hold, forever). Count is
  // asserted exactly: toContain would pass on the looping build.
  test("the order runs once across repeated replans, not once per respawn", async () => {
    const { api, actions } = stubApi();
    const agent = new Agent({
      id: "m1", persona: "p", api, store: new Store(":memory:"),
      planner: obedientPlanner([{ action: "self_destruct", params: {} }]), config: authorized, now: () => 1,
    });
    agent.instruct(ORDER);
    for (let i = 0; i < 12; i++) await agent.runOnce();
    expect(actions.filter((a) => a === "self_destruct")).toHaveLength(1);
    expect(agent.snapshot().goals).toEqual([]);
  });

  // Breakage caught: retirement that only lives in memory. When self_destruct
  // is a mid-plan step the plan row survives, and a restart before the next
  // replan would reload the spent order and fire it again.
  test("the spent order is gone from the persisted row, so a restart cannot replay it", async () => {
    const { api } = stubApi();
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "m1", persona: "p", api, store,
      planner: obedientPlanner([{ action: "self_destruct", params: {} }, { action: "undock", params: {} }]),
      config: authorized, now: () => 1,
    });
    agent.instruct(ORDER);
    await agent.runOnce(); // instruction wake -> replan
    await agent.runOnce(); // self_destruct step (continue: the undock step remains)
    expect(store.loadPlan("m1")!.goals).toEqual([]);
  });

  // Breakage caught: over-reach. A pinned rule is the operator's explicit
  // "standing until revoked" and a config goal is not an errand; neither is
  // spent by a self_destruct some other path ordered.
  test("a pinned or config goal that names the action is not retired", async () => {
    const { api } = stubApi();
    const agent = new Agent({
      id: "m1", persona: "p", api, store: new Store(":memory:"),
      goals: ["Rule: self_destruct only when stranded"],
      planner: obedientPlanner([{ action: "self_destruct", params: {} }]), config: authorized, now: () => 1,
    });
    agent.instruct("RULE: never self_destruct a ship carrying cargo", { standing: true });
    for (let i = 0; i < 4; i++) await agent.runOnce();
    expect(agent.snapshot().goals).toEqual([
      "Rule: self_destruct only when stranded", "RULE: never self_destruct a ship carrying cargo",
    ]);
  });

  // Breakage caught: a failed attempt must not spend the order. Unauthorized,
  // the executor refuses the step; the operator's order is still pending.
  test("a refused self_destruct leaves the order standing", async () => {
    const { api, actions } = stubApi();
    const agent = new Agent({
      id: "m1", persona: "p", api, store: new Store(":memory:"),
      planner: obedientPlanner([{ action: "self_destruct", params: {} }]), config, now: () => 1,
    });
    agent.instruct(ORDER);
    await agent.runOnce();
    await agent.runOnce();
    expect(actions).not.toContain("self_destruct");
    expect(agent.snapshot().goals).toEqual([ORDER]);
  });
});
