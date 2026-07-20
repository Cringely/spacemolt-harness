import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { goalPurchaseCandidates } from "../src/agent/goal-items";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Standing goals channel (issue #216). The live incident: the operator's
// confirmed milestone (buy a Mining Laser III, #107) was written into the
// PERSONA prose, which the deterministic goal machinery never reads --
// `this.goals` was fed only by saved.goals and pushed instructions, so
// goalPurchaseCandidates(this.goals) returned [] and the whole #220
// purchase-estimate pipeline sat inert for 35h+ at 56x the credits.
// Invariant: a stated standing objective lives in the structured goal channel
// (`this.goals`), established at Agent construction from config.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};
const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };
const MILESTONE = "Milestone: buy and fit a Mining Laser III";

function stubApi(opts: { estimate?: (itemId: string) => Promise<string> } = {}) {
  const calls: string[] = [];
  const status: StatusSnapshot = {
    // docked: true -- issue #315 gated estimate_purchase on docked state
    // (live-falsified 2026-07-17); this test's assertion is about the goal
    // CHANNEL reaching the fetch, not about dock state, so it docks to keep
    // exercising the estimate call.
    credits: 169_299, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, dockedAt: null, cargo: [],
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    ...(opts.estimate
      ? { async estimatePurchase(itemId: string) { calls.push(itemId); return opts.estimate!(itemId); } }
      : {}),
  };
  return { api, calls };
}

describe("standing config goals (#216)", () => {
  // Breakage caught: the exact #216 failure -- a config milestone never
  // reaching this.goals, so the planner briefing carries no goal and the
  // purchase-estimate injection never fires.
  test("a config goal enters the structured channel and drives purchase discovery on replan", async () => {
    const { api, calls } = stubApi({
      estimate: async () => "Mining Laser III -- 1 available, 8,000cr (Foundry Station 8,000cr each)",
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({
      id: "m1", persona: "a pragmatic ore miner", goals: [MILESTONE],
      api, store, planner, config, now: () => 1,
    });
    expect(agent.snapshot().goals).toEqual([MILESTONE]);
    // The milestone text literally names a catalog item (catalog.data.json:
    // mining_laser_iii "Mining Laser III") -- the matcher must resolve it.
    expect(goalPurchaseCandidates([MILESTONE]).candidates.map((i) => i.id)).toContain("mining_laser_iii");

    await agent.runOnce(); // no_plan wake -> replan with the standing goal
    const ctx = planner.contexts.at(-1)!;
    expect(ctx.goals).toContain(MILESTONE);
    expect(calls).toContain("mining_laser_iii");
    expect(ctx.purchaseEstimates?.some((e) => e.itemId === "mining_laser_iii")).toBe(true);
  });

  // Breakage caught: the restart-duplication bug the load-merge must dedupe --
  // savePlan persists this.goals (config goal included), so a naive re-append
  // on every boot would grow one copy per restart until the cap evicted real
  // operator steers.
  test("a restart does not duplicate the standing goal", async () => {
    const store = new Store(":memory:");
    const a1 = new Agent({
      id: "m1", persona: "p", goals: [MILESTONE],
      api: stubApi().api, store, planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    await a1.runOnce(); // replan -> savePlan persists goals (config goal included)

    const a2 = new Agent({
      id: "m1", persona: "p", goals: [MILESTONE],
      api: stubApi().api, store, planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    expect(a2.snapshot().goals.filter((g) => g === MILESTONE)).toHaveLength(1);
  });

  // Breakage caught (persisted-state schema tolerance): a stored plan row
  // written BEFORE goals: existed in config must keep loading, and the merge
  // must put the standing goal in the OLDEST slot -- the digest briefs
  // newest-first with newer-supersedes-older, so a later operator steer
  // outranks the standing baseline.
  test("a stored artifact predating the field loads; the standing goal takes the oldest slot", () => {
    const store = new Store(":memory:");
    store.savePlan("m1", okPlan, ["sell the palladium"]); // pre-#216 artifact
    const agent = new Agent({
      id: "m1", persona: "p", goals: [MILESTONE],
      api: stubApi().api, store, planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    expect(agent.snapshot().goals).toEqual([MILESTONE, "sell the palladium"]);
  });

  // Breakage caught: the merge overflowing MAX_GOALS (5) -- the standing goal
  // must survive (it re-enters every restart anyway; evicting it is churn) and
  // the OLDEST persisted steer goes, same eviction direction as the push side.
  test("merge over the cap keeps the standing goal and evicts the oldest persisted steer", () => {
    const store = new Store(":memory:");
    store.savePlan("m1", okPlan, ["s1", "s2", "s3", "s4", "s5"]);
    const agent = new Agent({
      id: "m1", persona: "p", goals: [MILESTONE],
      api: stubApi().api, store, planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    expect(agent.snapshot().goals).toEqual([MILESTONE, "s2", "s3", "s4", "s5"]);
  });

  // Breakage caught (PR #294 REVISE, HIGH): the runtime half of the #216
  // invariant. The push-side eviction (#186 cap, replan()) is
  // standing-goal-blind: five operator steers since the last restart push the
  // config milestone off the front slot and nothing restores it until the
  // next restart. The standing goal must survive every replan AND stay
  // visible to goalPurchaseCandidates on the very replan that overflows the
  // cap; transient steers keep their #186 aging (oldest steer evicted).
  test("five operator steers do not evict the standing goal; the oldest transient steer ages out instead", async () => {
    const { api, calls } = stubApi({
      estimate: async () => "Mining Laser III -- 1 available, 8,000cr (Foundry Station 8,000cr each)",
    });
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "m1", persona: "p", goals: [MILESTONE],
      api, store, planner: new MockPlanner([okPlan]), config, now: () => 1,
    });
    for (let i = 1; i <= 5; i++) {
      agent.instruct(`steer ${i}`);
      await agent.runOnce();
    }
    const goals = agent.snapshot().goals;
    expect(goals).toContain(MILESTONE);
    expect(goals).toEqual([MILESTONE, "steer 2", "steer 3", "steer 4", "steer 5"]);
    // Purchase discovery fired on all 5 replans -- including the overflow one
    // (only the milestone names a catalog item, so calls counts its fetches).
    expect(calls.filter((c) => c === "mining_laser_iii")).toHaveLength(5);
  });

  // Breakage caught: the absent-field regression -- an agent with no goals:
  // config must behave exactly as before #216 (empty until an instruction).
  test("no goals config -> unchanged behavior (empty until an operator instruction)", async () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "m1", persona: "p",
      api: stubApi().api, store, planner: new MockPlanner([okPlan, okPlan]), config, now: () => 1,
    });
    expect(agent.snapshot().goals).toEqual([]);
    await agent.runOnce();
    agent.instruct("go mine");
    await agent.runOnce();
    expect(agent.snapshot().goals).toEqual(["go mine"]);
  });
});
