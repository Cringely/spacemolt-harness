import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { harvestCases, PLAN_CONTEXT_EVENT } from "../src/eval/harvest";
import { loadCases } from "../src/eval/cases";
import { runEval, scoreRecorded, formatReport } from "../src/eval/run";
import { LISTING_TEXT_SNIPPET_LEN, UNTRUSTED_TEXT_SNIPPET_LEN } from "../src/planner/digest";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// The harvest path (issue #263): eval cases come from OUR OWN event store, not
// from hand-written scenarios. The producer is the agent's plan_context event --
// the exact PlanContext the planner was shown plus the raw plan it returned.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const status: StatusSnapshot = {
  credits: 500, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

function stubApi(): GameApi {
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
}

const plan: Plan = { goal: "survey the belt", steps: [{ action: "undock", params: {} }] };

describe("plan_context recording -> harvest", () => {
  test("an agent's replan records the digest inputs AND the raw plan; the harvester turns them into eval cases", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sm-eval-")), "events.sqlite");
    const store = new Store(dbPath);
    const agent = new Agent({
      id: "a1", persona: "Solarian miner", api: stubApi(), store,
      planner: new MockPlanner([plan]), config, now: () => 1_000,
    });
    await agent.runOnce(); // no_plan wake -> replan
    store.close();

    const cases = harvestCases(dbPath, "a1");
    expect(cases.length).toBe(1);
    const c = cases[0]!;
    expect(c.ctx.persona).toBe("Solarian miner");
    expect(c.ctx.wake.reason).toBe("no_plan");
    // The planner's OWN output is recorded, so a harvested case can be replayed
    // through the scorers with no model call at all.
    expect(c.recordedPlan?.goal).toBe("survey the belt");
    expect(c.recordedPlan?.steps[0]?.action).toBe("undock");
    // Ground truth the recording cannot carry is left UNSET, so the system-ref
    // scorer abstains on travel_to rather than inventing a failure (M-34).
    expect(c.groundTruth?.knownSystemIds).toBeUndefined();
  });

  // PR #267 review: the event's size receipt claimed the digest's snippet caps
  // already bounded these fields. They do not -- those caps fire when the digest
  // RENDERS ctx into the prompt, never on ctx itself, which is what this event
  // persists. A live-pilot hot-path event writing unbounded game text to the
  // events table is unbounded table growth, so the producer bounds it now, at
  // the digest's OWN caps (no new numbers) -- which also means the recording is
  // exactly the text the planner was shown.
  test("a fat context is persisted BOUNDED: the raw game-text fields are clipped at the digest's own caps", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sm-eval-")), "events.sqlite");
    const store = new Store(dbPath);
    const fat = "x".repeat(20_000);
    const docked: StatusSnapshot = { ...status, docked: true };
    const api: GameApi = {
      ...stubApi(),
      async status() { return docked; },
      async notifications() {
        return [{ id: "n1", type: "chat", msg_type: "chat_message", timestamp: "t", data: { sender: fat, text: fat } }];
      },
      async getMissions() { return fat; },
      async getActiveMissions() { return { text: fat }; },
      async getNearby() { return fat; },
      async getShipyard() { return fat; },
    };
    const agent = new Agent({
      id: "a1", persona: "Solarian miner", api, store,
      planner: new MockPlanner([plan]), config, now: () => 1_000,
    });
    await agent.runOnce();
    store.close();

    const c = harvestCases(dbPath, "a1")[0]!;
    // +1 for the ellipsis clipUntrusted appends. The point of the assertion is
    // that 20_000 chars in is ~1_500 out, four times over, per plan.
    for (const field of ["missionsText", "activeMissionsText", "nearbyText", "shipyardText"] as const) {
      expect(c.ctx[field]!.length).toBe(LISTING_TEXT_SNIPPET_LEN + 1);
    }
    const msg = c.ctx.chatMessages![0]!;
    expect(msg.text.length).toBe(UNTRUSTED_TEXT_SNIPPET_LEN + 1);
    expect(msg.sender.length).toBe(UNTRUSTED_TEXT_SNIPPET_LEN + 1);
  });

  test("a stored context that no longer validates is DISCARDED, not crashed on (persisted state outlives its schema)", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sm-eval-")), "events.sqlite");
    const store = new Store(dbPath);
    store.appendEvent({
      agentId: "a1", ts: 1, type: PLAN_CONTEXT_EVENT,
      // A pre-schema recording: `wake` carried a reason we no longer know.
      payload: { ctx: { persona: "p", goals: [], wake: { reason: "cosmic_ray" }, statusSummary: "s", recentEvents: [] }, plan },
    });
    store.appendEvent({
      agentId: "a1", ts: 2, type: PLAN_CONTEXT_EVENT,
      payload: { ctx: { persona: "p", goals: [], wake: { reason: "heartbeat" }, statusSummary: "s", recentEvents: [] }, plan },
    });
    store.close();

    const cases = harvestCases(dbPath, "a1");
    expect(cases.length).toBe(1);
    expect(cases[0]!.ctx.wake.reason).toBe("heartbeat");
  });
});

describe("eval runner", () => {
  const cases = loadCases(join(import.meta.dir, "fixtures", "eval-cases.json"));

  // A clean, adaptive planner: valid registry actions, no invented ids, no dock,
  // no mine -- and a DIFFERENT goal each time, so it never thrashes. One plan per
  // case: MockPlanner repeats its LAST plan once exhausted, and a repeated goal
  // on the harvested blocked wakes would read as thrash.
  const cleanPlanner = () => new MockPlanner(cases.map((_, i) => ({
    goal: `take stock and adjust course, attempt ${i + 1}`,
    steps: [{ action: "captains_log_add", params: { content: "hold is full; rethinking" } }],
  })));

  test("scores ANY planner through the existing Planner seam -- here a mocked one, zero tokens", async () => {
    const report = await runEval(cases, cleanPlanner());
    expect(report.cases.length).toBe(cases.length);
    expect(report.perScorer.find((t) => t.scorer === "known_action")?.fail).toBe(0);
    expect(report.overall).toBe(1);
    expect(report.thrash.verdict).toBe("pass");
  });

  test("a planner that answers three consecutive blocked wakes with the SAME goal fails, even when every plan is individually clean", async () => {
    // The SM-9 blind spot in one assertion: per-plan checks all pass, and the
    // planner is still stuck. Only the sequence-level signal sees it.
    const stuck = new MockPlanner([{
      goal: "mine titanium at bunda belt",
      steps: [{ action: "captains_log_add", params: { content: "back to the belt" } }],
    }]);
    const report = await runEval(cases.filter((c) => c.id.startsWith("sm9-")), stuck);
    expect(report.perScorer.every((t) => t.fail === 0)).toBe(true);
    expect(report.thrash.verdict).toBe("fail");
  });

  test("the overall score EXCLUDES abstentions -- an unmeasurable check never counts as a failure", async () => {
    const report = await runEval(cases, cleanPlanner());
    const decidedFromTallies = report.perScorer.reduce((n, t) => n + t.pass + t.fail, 0);
    // +/- the sequence-level thrash verdict, which is decided separately.
    expect(report.decided).toBeGreaterThanOrEqual(decidedFromTallies);
    expect(report.perScorer.some((t) => t.abstain > 0)).toBe(true);
    expect(report.overall).toBe(1);
  });

  test("the recorded SM-9 plans score BELOW the sonnet controls on the same states", () => {
    const sm9 = scoreRecorded(cases.filter((c) => c.id.startsWith("sm9-")));
    const good = scoreRecorded(cases.filter((c) => c.id.startsWith("good-")));
    expect(sm9.overall!).toBeLessThan(good.overall!);
    expect(good.overall).toBe(1);
    // The report a human reads names the failing case and why.
    const text = formatReport(sm9, "SM-9 recorded");
    expect(text).toContain("sm9-1-full-hold-no-station");
    expect(text).toContain("OVERALL");
  });
});
