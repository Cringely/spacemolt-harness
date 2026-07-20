import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig, SERVER_RETRY_MAX_ATTEMPTS } from "../src/agent/agent";
import { executeTick } from "../src/agent/executor";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

// #431 fix (live 2026-07-19, second occurrence after the 2026-07-13 cluster):
// the game answered travel with HTTP 503; each 503 surfaced as a blocked wake
// -> full planner call -> new plan whose step 1 was byte-identical to the
// failed step -> 503 again (~4 min/cycle, one planner call per cycle).
// Violated invariant: a transient SERVER failure (5xx) of a plan step is
// retried deterministically with backoff; the planner wakes only when retries
// exhaust -- replanning adds zero information for a 503. These tests fail if
// a 5xx ever reaches the planner before the attempt cap (the bug), or if the
// retry class widens into terminal game errors (would silently retry doomed
// steps the planner must hear about).

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const status: StatusSnapshot = {
  credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

const http503 = () => new SpacemoltError("server_error", "travel: HTTP 503");

function makeAgent(api: GameApi, plan: Plan) {
  let now = 0;
  const store = new Store(":memory:");
  const planner = new MockPlanner([plan]);
  const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });
  const tick = async () => { now += 1_000; await agent.runOnce(); };
  return { agent, planner, store, tick };
}

describe("executeTick server-failure classification (#431)", () => {
  // The transport's transient class (http.ts isTransientServerFailure) maps to
  // `server_retry`, never `blocked`. circuit_open is asserted alongside the
  // 5xx code because its inclusion is load-bearing: during a real outage the
  // breaker opens mid-episode, and misreading it as terminal would wake the
  // planner on attempt 2 of 3.
  for (const [code, message] of [
    ["server_error", "travel: HTTP 503"],
    ["circuit_open", "circuit open for spacemolt, retry after 30s"],
  ] as const) {
    test(`a ${code} failure classifies as server_retry, not blocked`, async () => {
      const api: GameApi = {
        async action(): Promise<V2Result> { throw new SpacemoltError(code, message); },
        async status() { return status; },
        async notifications() { return []; },
      };
      const plan: Plan = { goal: "g", steps: [{ action: "travel", params: { id: "gold_run_extraction_hub" } }] };
      const r = await executeTick(api, plan, { step: 0, iteration: 0 });
      expect(r).toEqual({ kind: "server_retry", code, resultText: message });
    });
  }
});

describe("Agent deterministic 5xx retry (#431)", () => {
  test("a 5xx step is retried after a tick backoff without a planner wake, and succeeds on a later attempt", async () => {
    let travelAttempts = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "travel") {
          travelAttempts++;
          if (travelAttempts === 1) throw http503(); // transient: server recovers before attempt 2
        }
        return { result: "ok" };
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "reach the hub", steps: [{ action: "travel", params: { id: "gold_run_extraction_hub" } }] };
    const { agent, planner, store, tick } = makeAgent(api, plan);

    await tick(); // no_plan -> replan (planner call 1). cursor step 0.
    expect(planner.contexts.length).toBe(1);

    await tick(); // attempt 1: 503 -> step_retry_5xx, backoff armed, step HELD
    expect(planner.contexts.length).toBe(1);            // NOT replanned
    expect(agent.snapshot().planState).toBe("running"); // never latched to "blocked"

    await tick(); // backoff tick 1: hold, no submission
    await tick(); // backoff tick 2: hold, no submission
    expect(travelAttempts).toBe(1);                     // nothing resubmitted mid-backoff

    await tick(); // attempt 2: succeeds -> plan completes
    expect(travelAttempts).toBe(2);                     // SAME step resubmitted, not skipped
    expect(agent.snapshot().planState).toBe("done");
    expect(planner.contexts.length).toBe(1);            // zero planner calls across the whole episode

    const events = store.recentEvents("a1", 100);
    const retries = events.filter((e) => e.type === "step_retry_5xx");
    expect(retries.length).toBe(1);                     // one distinct telemetry event per retry
    expect(retries[0]!.payload).toMatchObject({ action: "travel", code: "server_error", attempt: 1 });
    expect(events.filter((e) => e.type === "wake").length).toBe(1); // only the initial no_plan wake
  });

  test("retries exhaust -> planner woken once with the existing blocked reason", async () => {
    let travelAttempts = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "travel") { travelAttempts++; throw http503(); } // outage: never recovers
        return { result: "ok" };
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "reach the hub", steps: [{ action: "travel", params: { id: "gold_run_extraction_hub" } }] };
    const { agent, planner, store, tick } = makeAgent(api, plan);

    await tick(); // no_plan -> replan (1)
    // attempts 1 and 2 each cost 1 submission tick + 2 backoff ticks; attempt 3
    // exhausts the cap on its submission tick.
    for (let n = 0; n < 7; n++) await tick();
    expect(travelAttempts).toBe(SERVER_RETRY_MAX_ATTEMPTS); // capped: exactly 3 submissions
    expect(agent.snapshot().planState).toBe("blocked");
    expect(planner.contexts.length).toBe(1);                // wake fires next tick, not yet

    await tick(); // blocked wake -> replan (2)
    expect(planner.contexts.length).toBe(2);
    const wakes = store.recentEvents("a1", 200).filter((e) => e.type === "wake");
    const last = wakes.at(-1)!.payload as { reason: string; detail?: string };
    expect(last.reason).toBe("blocked");                    // the EXISTING wake reason, no new kind
    expect(last.detail).toContain("HTTP 503");              // the planner sees what actually failed
    const retries = store.recentEvents("a1", 200).filter((e) => e.type === "step_retry_5xx");
    expect(retries.length).toBe(SERVER_RETRY_MAX_ATTEMPTS - 1); // retries only, the final failure wakes
  });

  test("a 5xx on a NON-movement mutation (sell) is NOT retried: immediate blocked wake, zero retry events", async () => {
    // #137 fence (PR #442 review): an ambiguous 5xx can land AFTER a
    // server-side commit, so a blind resubmit of a non-movement mutation is
    // the at-least-once double-spend class. This test locks the exclusion in:
    // widening the retry gate beyond MOVEMENT_ACTIONS fails here.
    let sellAttempts = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "sell") { sellAttempts++; throw new SpacemoltError("server_error", "sell: HTTP 503"); }
        return { result: "ok" };
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "sell the ore", steps: [{ action: "sell", params: { id: "carbon_ore", quantity: 1 } }] };
    const { agent, planner, store, tick } = makeAgent(api, plan);

    await tick(); // no_plan -> replan (1)
    await tick(); // sell 503s -> NO retry, immediate block
    expect(sellAttempts).toBe(1);                       // the mutation was never resubmitted
    expect(agent.snapshot().planState).toBe("blocked");
    expect(store.recentEvents("a1", 100).filter((e) => e.type === "step_retry_5xx").length).toBe(0);

    await tick(); // blocked wake -> replan (2), today's behavior
    expect(planner.contexts.length).toBe(2);
    expect(sellAttempts).toBe(1);
  });

  test("circuit_open drives the full movement retry/backoff/exhaustion episode, same as a 503", async () => {
    // The breaker opens mid-outage (http.ts fail-fast); if the episode
    // machinery treated circuit_open differently from server_error, attempt 2
    // or 3 of a real outage would wake the planner early. Mirror of the 503
    // exhaustion episode above, driven end-to-end by circuit_open.
    let travelAttempts = 0;
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "travel") {
          travelAttempts++;
          throw new SpacemoltError("circuit_open", "circuit open for spacemolt, retry after 30s");
        }
        return { result: "ok" };
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "reach the hub", steps: [{ action: "travel", params: { id: "gold_run_extraction_hub" } }] };
    const { agent, planner, store, tick } = makeAgent(api, plan);

    await tick(); // no_plan -> replan (1)
    for (let n = 0; n < 7; n++) await tick(); // attempt/backoff/attempt/backoff/attempt
    expect(travelAttempts).toBe(SERVER_RETRY_MAX_ATTEMPTS);
    expect(agent.snapshot().planState).toBe("blocked");
    expect(store.recentEvents("a1", 200).filter((e) => e.type === "step_retry_5xx").length)
      .toBe(SERVER_RETRY_MAX_ATTEMPTS - 1);

    await tick(); // blocked wake -> replan (2)
    expect(planner.contexts.length).toBe(2);
    const last = store.recentEvents("a1", 200).filter((e) => e.type === "wake").at(-1)!
      .payload as { reason: string; detail?: string };
    expect(last.reason).toBe("blocked");
    expect(last.detail).toContain("circuit open");
  });

  test("a non-5xx terminal block keeps today's behavior: no retry loop, immediate blocked wake", async () => {
    let mineAttempts = 0;
    const api: GameApi = {
      async action(): Promise<V2Result> {
        mineAttempts++;
        throw new SpacemoltError("command_error", "deposits too sparse to mine");
      },
      async status() { return status; },
      async notifications() { return []; },
    };
    const plan: Plan = { goal: "mine", steps: [{ action: "mine", params: {} }] };
    const { agent, planner, store, tick } = makeAgent(api, plan);

    await tick(); // no_plan -> replan (1)
    await tick(); // mine TERMINALLY blocks -- no retry, no backoff
    expect(mineAttempts).toBe(1);
    expect(agent.snapshot().planState).toBe("blocked");
    expect(store.recentEvents("a1", 100).filter((e) => e.type === "step_retry_5xx").length).toBe(0);

    await tick(); // blocked wake -> replan (2), exactly as before #431
    expect(planner.contexts.length).toBe(2);
    expect(mineAttempts).toBe(1); // the doomed step was never silently resubmitted
  });
});
