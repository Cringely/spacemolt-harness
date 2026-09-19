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

// Pinned ("standing until revoked") instructions (issue #817). The live
// incident: a fuel rule sent as "standing until revoked" was retired ~70
// minutes after the pilot complied with it once -- instruction_done treated
// a persistent rule exactly like a one-shot errand. Invariant: an instruction
// the operator explicitly marks standing at intake must leave goals ONLY
// through an explicit revoke, never solely because the planner reports
// instruction_done. Default is unpinned (false) -- every existing caller that
// sends only `text` keeps today's one-shot-retirable behavior untouched.
const STANDING_INSTRUCTION =
  "Fuel rule, standing until revoked: refuel at stations, never buy fuel_cell on the market";

describe("pinned instructions leave goals only by explicit revoke (#817)", () => {
  // Breakage caught: the live incident itself, reproduced offline -- a
  // PINNED instruction must survive not just one earned instruction_done but
  // every subsequent one too, and keep being re-raised each cycle exactly
  // like the "not yet done" case already does for an ordinary instruction.
  test("instruction_done never retires a pinned instruction, however many times it's reported done", async () => {
    const { agent, store, planner } = makeAgent([
      plan(1), plan(2, { instruction_done: true }), plan(3, { instruction_done: true }),
    ]);
    agent.instruct(STANDING_INSTRUCTION, { standing: true });
    await agent.runOnce(); // arrival -> replan 1
    await completePlan(agent);
    await agent.runOnce(); // replan 2: block shown, planner reports done (earned, but pinned)
    expect(planner.contexts[1]!.standingInstruction).toBe(STANDING_INSTRUCTION);
    expect(agent.snapshot().goals).toContain(STANDING_INSTRUCTION);
    // No instruction_done event: the guard's whole body, including the
    // emit, is skipped for a pinned instruction -- same fail-open shape as
    // the existing "unearned flag" case above, just triggered by pin status
    // instead of by wake timing.
    expect(store.recentEventsByType("a1", "instruction_done", 5)).toHaveLength(0);
    expect(store.loadPlan("a1")!.goals).toContain(STANDING_INSTRUCTION);

    await completePlan(agent);
    await agent.runOnce(); // replan 3: reported done AGAIN -- still refused
    const ctx3 = planner.contexts[2]!;
    expect(ctx3.standingInstruction).toBe(STANDING_INSTRUCTION);
    expect(buildDigest(ctx3)).toContain(BLOCK);
    expect(agent.snapshot().goals).toContain(STANDING_INSTRUCTION);
  });

  test("revokeInstruction removes a pinned instruction immediately and reports whether one was found", async () => {
    const { agent, planner } = makeAgent([plan(1), plan(2)]);
    agent.instruct(STANDING_INSTRUCTION, { standing: true });
    await agent.runOnce(); // arrival -> lands in goals
    expect(agent.snapshot().goals).toContain(STANDING_INSTRUCTION);

    expect(agent.revokeInstruction(STANDING_INSTRUCTION)).toBe(true);
    // Synchronous: visible in snapshot() immediately, no replan round-trip.
    expect(agent.snapshot().goals).not.toContain(STANDING_INSTRUCTION);
    // Idempotent: revoking an already-absent text finds nothing to remove.
    expect(agent.revokeInstruction(STANDING_INSTRUCTION)).toBe(false);

    await completePlan(agent);
    await agent.runOnce(); // nothing standing left -- the revoke did the work, not a planner report
    expect(planner.contexts[1]!.standingInstruction).toBeUndefined();
  });

  test("revokeInstruction is a no-op on a standing CONFIG goal (agents.yaml, #216)", () => {
    const MILESTONE = "Milestone: buy and fit a Mining Laser III";
    const { agent } = makeAgent([plan(1)], [MILESTONE]);
    // Config goals are not operator steers, and mergeStandingGoals would
    // restore one next replan even if this DID remove it -- the point here
    // is that revoke refuses outright rather than producing a one-replan
    // flicker.
    expect(agent.revokeInstruction(MILESTONE)).toBe(false);
    expect(agent.snapshot().goals).toContain(MILESTONE);
  });

  // Breakage caught (PR #113 council REVISE, finding 2): the MAX_GOALS (5)
  // push-side cap evicted the OLDEST goal on overflow with no regard for pin
  // status -- a pinned instruction sitting in the oldest slot was gone the
  // moment enough newer steers needed the room, with no revoke and no
  // receipt, after which it could never be shown, retired, or revoked again.
  // Same shape PR #294 already ruled REVISE/HIGH for standing CONFIG goals
  // (see goal-channel.test.ts); this is the pinned-instruction case.
  test("MAX_GOALS unretired steers do not evict a pinned instruction", async () => {
    const store = new Store(":memory:");
    // Pre-seed the state a live session would reach after the pin landed and
    // 4 unretired steers followed it: STANDING_INSTRUCTION in the oldest
    // slot, already at the MAX_GOALS (5) cap. Seeded directly (rather than
    // driven through 5 live replans) so this test isolates the eviction
    // logic from the harness's own no-progress/thrash guards, which are
    // orthogonal to #817 and would otherwise throttle a same-fingerprint
    // replan run this long.
    store.savePlan("a1", plan(1), [STANDING_INSTRUCTION, "steer 1", "steer 2", "steer 3", "steer 4"]);
    store.appendEvent({
      agentId: "a1", ts: 1, type: "instruction_pin_changed",
      payload: { text: STANDING_INSTRUCTION, pinned: true },
    });
    const agent = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store,
      planner: new MockPlanner([plan(2)]), config, now: () => 1_000_000,
    });
    expect(agent.snapshot().goals).toEqual([STANDING_INSTRUCTION, "steer 1", "steer 2", "steer 3", "steer 4"]);

    // One more unretired steer overflows MAX_GOALS (5 -> 6) -- enough on its
    // own, under the old age-only eviction, to push the pinned instruction
    // (the oldest slot) straight out with no revoke and no receipt.
    agent.instruct("steer 5");
    await agent.runOnce();

    // The pinned instruction survives, still in the oldest slot; the cap
    // still holds (5 entries), and eviction fell on the oldest UNPINNED
    // steer ("steer 1") instead.
    expect(agent.snapshot().goals).toEqual(
      [STANDING_INSTRUCTION, "steer 2", "steer 3", "steer 4", "steer 5"],
    );
  });

  // Breakage caught: without restart-safe persistence, a pin is only as
  // durable as the process -- the exact failure this issue is about, just
  // moved from instruction_done time to restart time.
  test("a pin survives a restart: a fresh Agent on the same store still refuses to retire it", async () => {
    const store = new Store(":memory:");
    const agent1 = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store,
      planner: new MockPlanner([plan(1)]), config, now: () => 1_000_000,
    });
    agent1.instruct(STANDING_INSTRUCTION, { standing: true });
    await agent1.runOnce(); // lands in goals, pin event durably written
    expect(store.loadPlan("a1")!.goals).toContain(STANDING_INSTRUCTION);

    // Simulate a restart: a brand new Agent instance resuming the SAME
    // store, the same pattern goal-channel.test.ts uses for the standing
    // CONFIG goal's restart-safety test.
    const planner2 = new MockPlanner([plan(2, { instruction_done: true })]);
    const agent2 = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store, planner: planner2, config, now: () => 2_000_000,
    });
    await completePlan(agent2); // finishes the resumed step
    await agent2.runOnce(); // plan_done -> replan reports instruction_done
    expect(agent2.snapshot().goals).toContain(STANDING_INSTRUCTION);
  });

  // Breakage caught (PR #113 council REVISE, finding 1): the restart replay
  // used to read the last MAX_PINNED_INSTRUCTIONS (20) instruction_pin_changed
  // ROWS GLOBALLY, not per text. Pin, revoke, and re-pin each write a row for
  // whichever text they target, so 20+ pin-change rows for OTHER texts push
  // A's own pin row out of that window even though nothing ever un-pinned A --
  // on restart A loads unpinned, and the very next instruction_done retires
  // it. The fix replays through latestEventPerPayloadKey (one row per DISTINCT
  // text, so `limit` bounds PINNED TEXTS, not events), which this reproduces
  // directly: write more than 20 pin-change rows for texts other than A after
  // A's own pin, then assert A still survives instruction_done past a restart.
  test("a pin survives 20+ pin-change rows for OTHER texts after it (restart replay is per-text, not a global row window)", async () => {
    const store = new Store(":memory:");
    const agent1 = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store,
      planner: new MockPlanner([plan(1)]), config, now: () => 1_000_000,
    });
    agent1.instruct(STANDING_INSTRUCTION, { standing: true });
    await agent1.runOnce(); // lands in goals, A's pin event durably written first
    expect(store.loadPlan("a1")!.goals).toContain(STANDING_INSTRUCTION);

    // 25 pin-change rows, all AFTER A's own row and none of them ever
    // mentioning A -- more than MAX_PINNED_INSTRUCTIONS (20). Churned across
    // just 3 OTHER texts (pin/revoke/re-pin), matching the live shape the
    // finding names: a handful of distinct steers, repeatedly pinned and
    // unpinned. Kept to few DISTINCT texts on purpose -- this reproduces the
    // ROW-window bug (a global "last 20 EVENTS" read can't tell one text's
    // churn from another's), which is the narrower of two restart-replay
    // defects, so this test bounds distinct texts to isolate it. (Round 2
    // correction: an earlier version of this comment claimed flooding 20+
    // DISTINCT other texts would "legitimately" age A out under
    // MAX_PINNED_INSTRUCTIONS -- wrong, because the live cap on
    // pinnedInstructions counts only CURRENTLY PINNED texts, and a
    // pin-then-revoke pair leaves nothing pinned. 20+ distinct texts that
    // were each pinned then revoked, never touching A, is exactly the OTHER
    // defect the filtered-replay test below covers, and A survives it too.)
    for (let i = 0; i < 25; i++) {
      store.appendEvent({
        agentId: "a1", ts: 1_000_001 + i, type: "instruction_pin_changed",
        payload: { text: `other steer ${i % 3}`, pinned: i % 2 === 0 },
      });
    }

    // Simulate a restart: a brand new Agent instance resuming the SAME store,
    // same pattern as the plain restart test above.
    const planner2 = new MockPlanner([plan(2, { instruction_done: true })]);
    const agent2 = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store, planner: planner2, config, now: () => 2_000_000,
    });
    await completePlan(agent2); // finishes the resumed step
    await agent2.runOnce(); // plan_done -> replan reports instruction_done
    expect(agent2.snapshot().goals).toContain(STANDING_INSTRUCTION);
  });

  // Breakage caught (PR #113 fix-round-2 verify, finding 1, same probe the
  // verifier ran): the round-1 fix bounded the restart replay's LIMIT to
  // DISTINCT TEXTS, but a text whose LATEST row is pinned:false still spent
  // one of those slots -- so pin A, then pin-then-revoke 20+ OTHER texts
  // (each individually pinned and immediately revoked, so nothing but A is
  // pinned by restart time), and A's row still got pushed out by the LIMIT
  // even though the live pinnedInstructions Set never held more than A and
  // one other at once. The fix (Store.latestEventPerPayloadKey's `filter`
  // param) drops a text's row from the grouped result before LIMIT applies
  // unless its latest row is pinned:true, so an unpinned text costs nothing
  // regardless of how many of them there are.
  test("a pin survives pin-then-revoke churn across 20+ OTHER texts (replay filters on current pin state, not just distinct text count)", async () => {
    const store = new Store(":memory:");
    const agent1 = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store,
      planner: new MockPlanner([plan(1)]), config, now: () => 1_000_000,
    });
    agent1.instruct(STANDING_INSTRUCTION, { standing: true });
    await agent1.runOnce(); // lands in goals, A's pin event durably written first
    expect(store.loadPlan("a1")!.goals).toContain(STANDING_INSTRUCTION);

    // 21 OTHER texts -- one more than MAX_PINNED_INSTRUCTIONS (20) -- each
    // pinned then immediately revoked, so its LATEST row is pinned:false and
    // none is pinned at restart time. Under the round-1-only fix, the
    // grouped query still bounds DISTINCT TEXTS to 20 before checking pin
    // state at all, so A -- the oldest of these 22 distinct texts -- is the
    // one the plain "top 20 by id" cut leaves out.
    for (let i = 0; i < 21; i++) {
      const text = `revoked steer ${i}`;
      store.appendEvent({
        agentId: "a1", ts: 1_000_001 + i * 2, type: "instruction_pin_changed",
        payload: { text, pinned: true },
      });
      store.appendEvent({
        agentId: "a1", ts: 1_000_002 + i * 2, type: "instruction_pin_changed",
        payload: { text, pinned: false },
      });
    }

    // Simulate a restart: a brand new Agent instance resuming the SAME
    // store, same pattern as the restart tests above.
    const planner2 = new MockPlanner([plan(2, { instruction_done: true })]);
    const agent2 = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store, planner: planner2, config, now: () => 2_000_000,
    });
    await completePlan(agent2); // finishes the resumed step
    await agent2.runOnce(); // plan_done -> replan reports instruction_done
    expect(agent2.snapshot().goals).toContain(STANDING_INSTRUCTION);
  });

  // Breakage caught (PR #113 fix-round-2 verify, finding 2): the constructor
  // called mergeStandingGoals() BEFORE replaying instruction_pin_changed
  // events, so pinnedInstructions was still empty for that very call --
  // evictOldestUnpinned (which mergeStandingGoals uses to make room for a
  // config goal) saw every persisted goal as unpinned, including A. Probe
  // matches the verifier's exactly: goals at the MAX_GOALS (5) cap with A
  // pinned in the OLDEST slot, restart with a config goal present (an
  // operator adding one to agents.yaml, or just any boot where `goals` is
  // configured) so mergeStandingGoals has to evict something to make room.
  // Under the bug, A -- not any of the ordinary steers -- was the one
  // evicted, silently: no revoke, no instruction_pin_changed receipt.
  test("a config goal at restart does not evict a pinned instruction via mergeStandingGoals (pin replay must run before the merge)", () => {
    const store = new Store(":memory:");
    // Pre-seed the state a live session reaches after A's pin landed and 4
    // unretired steers followed it -- A in the oldest slot, already at the
    // MAX_GOALS (5) cap. Seeded directly, same isolation rationale as the
    // "MAX_GOALS unretired steers" test above: this targets the CONSTRUCTOR's
    // merge, not the live replan path.
    store.savePlan("a1", plan(1), [STANDING_INSTRUCTION, "steer 1", "steer 2", "steer 3", "steer 4"]);
    store.appendEvent({
      agentId: "a1", ts: 1, type: "instruction_pin_changed",
      payload: { text: STANDING_INSTRUCTION, pinned: true },
    });

    // Restart with a config standing goal present -- mergeStandingGoals must
    // make room for it, which is the only thing that forces an eviction here.
    const agent = new Agent({
      id: "a1", persona: "test miner", api: stubApi(), store,
      planner: new MockPlanner([plan(2)]), config, now: () => 1_000_000,
      goals: ["MILESTONE"],
    });

    // A survives, still pinned; the config goal took the front slot and the
    // OLDEST UNPINNED steer ("steer 1") is the one that made room for it.
    expect(agent.snapshot().goals).toEqual(
      ["MILESTONE", STANDING_INSTRUCTION, "steer 2", "steer 3", "steer 4"],
    );
    // No silent eviction receipt for A: the only instruction_pin_changed row
    // for its text is still the original pin.
    const pinEvents = store.recentEventsByType("a1", "instruction_pin_changed", 10)
      .filter((e) => (e.payload as { text?: unknown }).text === STANDING_INSTRUCTION);
    expect(pinEvents).toHaveLength(1);
    expect((pinEvents[0]!.payload as { pinned: boolean }).pinned).toBe(true);
  });

  // Persisted-state schema tolerance (AGENTS.md binding convention): a store
  // written before #817 has goals but zero instruction_pin_changed events.
  // The loader must not crash, and -- since nothing ever marked the goal
  // pinned -- it must behave exactly as it always has: ordinary-retirable.
  test("a store predating #817 (goals present, no pin events) loads and stays ordinary-retirable", async () => {
    const store = new Store(":memory:");
    // Hand-written to match exactly what a pre-#817 build persisted: a goal
    // in the plans row, no pin events at all.
    store.savePlan("a1", plan(1), [INSTRUCTION]);
    expect(store.recentEventsByType("a1", "instruction_pin_changed", 20)).toHaveLength(0);

    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([plan(2, { instruction_done: true })]), config, now: () => 1_000_000,
    });
    await completePlan(agent); // resumes plan(1)'s step -> plan_done
    await agent.runOnce(); // replan reports instruction_done against the pre-existing goal
    expect(agent.snapshot().goals).not.toContain(INSTRUCTION);
  });
});
