import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { buildDigest } from "../src/planner/digest";
import { PlanSchema, type Plan } from "../src/registry/plan";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

// Instruction salience + satisfaction (issue #355). The live repro
// (operator dashboard, 2026-07-17): "travel to First Step Memorial Station to
// check the shipyard/market..." drove exactly ONE plan, then the next replan
// reverted to the titanium mission. Storage was fine (the instruction sat in
// goals the whole time); SALIENCE was the bug -- the dedicated 'Operator
// instruction:' line rendered only on the arrival wake, and on every later
// wake the instruction competed as one quiet Goals-list entry against the
// loud structured mission block, and lost. Invariant: the newest operator
// instruction is re-raised as a dedicated top-of-prompt block on EVERY
// replan until the planner reports it done (plan JSON `instruction_done`),
// at which point the prominence -- and the goal -- drop.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const INSTRUCTION =
  "travel to First Step Memorial Station and check the shipyard for a defense module";
const BLOCK = "STANDING OPERATOR INSTRUCTION";

function stubApi() {
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return api;
}

// Distinct goal strings so the string-keyed thrash damper never mistakes the
// test's replan cadence for a livelock.
const plan = (n: number, extra: Partial<Plan> = {}): Plan =>
  ({ goal: `leg ${n}`, steps: [{ action: "dock", params: {} }], ...extra });

function makeAgent(plans: Plan[], goals?: string[]) {
  const store = new Store(":memory:");
  const planner = new MockPlanner(plans);
  const agent = new Agent({
    id: "a1", persona: "test miner", api: stubApi(), store, planner, config,
    now: () => 1_000_000, ...(goals ? { goals } : {}),
  });
  return { agent, store, planner };
}

// Each plan is a single dock step: runOnce #1 replans, #2 executes the step
// (plan done), #3 wakes plan_done and replans again -- the wake-2 boundary
// where the live instruction lost its salience.
async function completePlan(agent: Agent) {
  await agent.runOnce(); // execute the single step -> plan done
}

describe("instruction salience across replans (#355)", () => {
  // Breakage caught: the exact live failure -- the instruction prominent on
  // the arrival wake only, then demoted to a Goals-list line on wake 2+.
  test("the instruction stays prominent on wake 2+, not just the arrival wake", async () => {
    const { agent, planner } = makeAgent([plan(1), plan(2)]);
    agent.instruct(INSTRUCTION);

    await agent.runOnce(); // arrival wake -> replan 1
    const ctx1 = planner.contexts[0]!;
    expect(ctx1.wake.reason).toBe("instruction");
    expect(ctx1.instruction).toBe(INSTRUCTION);
    // Arrival dedup: the transient line already shouts; no duplicate block.
    expect(ctx1.standingInstruction).toBeUndefined();
    expect(buildDigest(ctx1)).toContain(`Operator instruction: ${INSTRUCTION}`);
    expect(buildDigest(ctx1)).not.toContain(BLOCK);

    await completePlan(agent);
    await agent.runOnce(); // plan_done -> replan 2, the wake that went quiet live
    const ctx2 = planner.contexts[1]!;
    expect(ctx2.wake.reason).toBe("plan_done");
    expect(ctx2.standingInstruction).toBe(INSTRUCTION);
    const digest2 = buildDigest(ctx2);
    expect(digest2).toContain(BLOCK);
    expect(digest2).toContain(INSTRUCTION);
    // Prominence, not just presence: the block renders in the top-of-prompt
    // zone, above the Status line (and therefore above every mission section).
    expect(digest2.indexOf(BLOCK)).toBeLessThan(digest2.indexOf("Status:"));
    // The response-shape line names the satisfaction key on this wake.
    expect(digest2).toContain('"instruction_done"');
  });

  // Breakage caught: prominence that never drops -- a satisfied instruction
  // must stop being re-raised AND leave the goals list.
  test("instruction_done drops the prominence and retires the goal", async () => {
    const { agent, store, planner } = makeAgent([
      plan(1), plan(2, { instruction_done: true }), plan(3),
    ]);
    agent.instruct(INSTRUCTION);
    await agent.runOnce(); // arrival -> replan 1
    await completePlan(agent);
    await agent.runOnce(); // replan 2: block shown, planner reports done
    expect(planner.contexts[1]!.standingInstruction).toBe(INSTRUCTION);
    expect(agent.snapshot().goals).not.toContain(INSTRUCTION);
    expect(store.recentEventsByType("a1", "instruction_done", 5)).toHaveLength(1);
    // Persisted too: a restart must not resurrect the satisfied instruction.
    expect(store.loadPlan("a1")!.goals).not.toContain(INSTRUCTION);

    await completePlan(agent);
    await agent.runOnce(); // replan 3: nothing standing, no block
    const ctx3 = planner.contexts[2]!;
    expect(ctx3.standingInstruction).toBeUndefined();
    expect(buildDigest(ctx3)).not.toContain(BLOCK);
  });

  // Breakage caught: a hallucinated instruction_done on the ARRIVAL wake's own
  // plan clearing the order the operator typed seconds ago. The flag is
  // honored only on a wake where the standing block was actually shown.
  test("instruction_done on the arrival wake cannot clear the just-arrived instruction", async () => {
    const { agent, planner } = makeAgent([plan(1, { instruction_done: true }), plan(2)]);
    agent.instruct(INSTRUCTION);
    await agent.runOnce(); // arrival replan carries the unearned flag
    expect(agent.snapshot().goals).toContain(INSTRUCTION);

    await completePlan(agent);
    await agent.runOnce(); // wake 2 still re-raises it
    expect(planner.contexts[1]!.standingInstruction).toBe(INSTRUCTION);
  });

  // Breakage caught: the block nagging about standing CONFIG goals (#216) --
  // those are durable objectives with no satisfaction escape, so re-raising
  // one as "not yet done" would nag forever and teach the planner to emit an
  // instruction_done that then silently no-ops.
  test("standing config goals get no standing-instruction block", async () => {
    const { agent, planner } = makeAgent([plan(1)], ["Milestone: buy and fit a Mining Laser III"]);
    await agent.runOnce(); // no_plan wake -> replan with only the config goal
    const ctx = planner.contexts[0]!;
    expect(ctx.standingInstruction).toBeUndefined();
    expect(buildDigest(ctx)).not.toContain(BLOCK);
  });

  // Breakage caught (PR #360 review finding 1): the honor gate itself. The
  // arrival-wake test above proves the goal LIST survives an unearned flag,
  // but with the `&& standingInstruction` clause ablated it still passes by
  // accident -- filtering goals against undefined removes nothing. What the
  // clause actually gates is the EVENT: without it, a hallucinated flag on a
  // wake where no block was shown emits a spurious instruction_done event
  // carrying instruction: undefined. The event stream is the receipt.
  test("a flag on a wake where no standing block was shown emits no instruction_done event", async () => {
    const { agent, store } = makeAgent([plan(1, { instruction_done: true }), plan(2)]);
    agent.instruct(INSTRUCTION);
    await agent.runOnce(); // arrival wake: block suppressed, flag unearned
    expect(store.recentEventsByType("a1", "instruction_done", 5)).toHaveLength(0);
  });

  // Breakage caught (persisted-state schema tolerance): the field is additive,
  // so a plan persisted BEFORE it existed must keep loading, and a plan
  // carrying it must round-trip through the store.
  test("plans predating instruction_done still validate; plans carrying it round-trip", () => {
    // A pre-#355 artifact: exactly the shape older builds persisted.
    const predating = JSON.parse('{"goal":"g","steps":[{"action":"dock","params":{}}]}');
    expect(PlanSchema.parse(predating).instruction_done).toBeUndefined();

    const store = new Store(":memory:");
    store.savePlan("a1", plan(1, { instruction_done: true }), []);
    expect(store.loadPlan("a1")!.plan.instruction_done).toBe(true);
  });

  // Seam pin (#355, docs/wiki/seam-manifest.md): the digest names the literal
  // JSON key in prose and PlanSchema admits that exact key -- two files with
  // no shared schema forcing agreement. A rename on either side fails here.
  test("the digest's advertised key is the key PlanSchema accepts", () => {
    const digest = buildDigest({
      persona: "p", goals: [INSTRUCTION], wake: { reason: "plan_done" },
      statusSummary: "s", recentEvents: [], standingInstruction: INSTRUCTION,
    });
    expect(digest).toContain('"instruction_done": true');
    expect(PlanSchema.parse({ ...plan(1), instruction_done: true }).instruction_done).toBe(true);
  });
});
