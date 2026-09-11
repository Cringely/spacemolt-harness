import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store, type AgentEvent } from "../src/store/store";
import type { Plan } from "../src/registry/plan";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

// Steer-channel receipt (issue #696). The live symptom: the operator sent a
// manual steer, POST /instruct returned 204, and nothing about it ever appeared
// in the telemetry feed. #495 had closed on the claim the channel works end to
// end, so the silence read as a delivery failure.
//
// It was not. `Agent.instruct()` was the entire acceptance path and it only
// pushed onto the inbox -- no emit. The one instruction event in the channel,
// `instruction_done`, fires later and ONLY when the planner volunteers
// `instruction_done: true` on a plan of its own, which plenty of errands never
// trigger. server.ts's own comment says the 204 means "ACCEPTED AND QUEUED, not
// acted on".
//
// Invariant pinned here: every state transition an operator instruction makes
// leaves an event -- accepted into the inbox, consumed into a replan -- so
// operator silence is evidence of something instead of evidence of nothing.
// Three states, three events: instruction_received / instruction_consumed /
// instruction_done.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

function stubApi(): GameApi {
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
}

const plan = (n: number, extra: Partial<Plan> = {}): Plan =>
  ({ goal: `leg ${n}`, steps: [{ action: "dock", params: {} }], ...extra });

function makeAgent(plans: Plan[], store = new Store(":memory:")) {
  const agent = new Agent({
    id: "a1", persona: "test miner", api: stubApi(), store, planner: new MockPlanner(plans),
    config, now: () => 1_000_000,
  });
  return { agent, store };
}

const typed = (store: Store, type: string) => store.recentEventsByType("a1", type, 10);

const STEER = "abandon the titanium run and dock at First Step Memorial Station";

describe("operator steer channel: instruction receipt (#696)", () => {
  // Breakage caught: deleting the emit from instruct(), or moving it behind a
  // tick so acceptance is only visible once the agent happens to wake. The
  // whole point is that the receipt exists BEFORE any tick runs -- that is what
  // makes a 204 checkable against the feed while the operator is still watching.
  test("accepting an instruction emits instruction_received before any tick runs", () => {
    const { agent, store } = makeAgent([plan(1)]);

    agent.instruct(STEER);

    const received = typed(store, "instruction_received");
    expect(received).toHaveLength(1);
    expect(received[0]!.payload).toEqual({ text: STEER, queued: 1 });
    // ...and nothing downstream has fired yet: accepted is a state of its own,
    // not a synonym for acted-on. The positive assertion above is this pair's
    // control -- if the store or the query were broken, it would read 0 too.
    expect(typed(store, "instruction_consumed")).toHaveLength(0);
    expect(typed(store, "instruction_done")).toHaveLength(0);
  });

  // Breakage caught: emitting the receipt BEFORE the push (every event then
  // reads queued: 0), or hardcoding the depth. AgentView never exposes inbox
  // contents, so this number is the only signal that a steer is sitting behind
  // earlier ones rather than being next up.
  test("the receipt carries inbox depth including itself, so a backed-up queue is visible", () => {
    const { agent, store } = makeAgent([plan(1)]);

    agent.instruct("first");
    agent.instruct("second");
    agent.instruct("third");

    expect(typed(store, "instruction_received").map((e) => (e.payload as { queued: number }).queued))
      .toEqual([1, 2, 3]);
  });

  // Breakage caught: deleting the consumption emit, or collapsing it into
  // instruction_done. The planner here returns an ordinary plan with NO
  // instruction_done flag -- the common case, and the one that left the feed
  // blank. Consumed-but-not-reported-done must be a distinguishable state.
  test("consuming an instruction at replan emits instruction_consumed, distinct from instruction_done", async () => {
    const { agent, store } = makeAgent([plan(1), plan(2)]);

    agent.instruct(STEER);
    await agent.runOnce();

    const consumed = typed(store, "instruction_consumed");
    expect(consumed).toHaveLength(1);
    expect(consumed[0]!.payload).toEqual({ instruction: STEER, queued: 0 });
    // The instruction really did land in the planner's goals on this tick, so
    // the event is reporting a consumption that happened rather than one it
    // merely announced.
    expect(agent.snapshot().goals).toContain(STEER);
    // Negative half, with the positive control sitting right above it: the
    // planner never claimed done, so the third state must not have fired.
    expect(typed(store, "instruction_done")).toHaveLength(0);
  });

  // Breakage caught: dropping the try/catch around the receipt emit. The steer
  // channel is the operator's only control lever over a live pilot, and
  // instruct() had no failure mode at all before #696 added a store write to
  // it. An unwritable event store must cost the receipt, never the instruction
  // -- a throw here 500s a POST whose push already succeeded, and an operator
  // who resends on that 500 lands the steer twice.
  test("a failing event store loses the receipt, never the instruction", async () => {
    const store = new Store(":memory:");
    const passthrough = store.appendEvent.bind(store);
    store.appendEvent = (e: AgentEvent): number => {
      if (e.type === "instruction_received") throw new Error("disk full");
      return passthrough(e);
    };
    const { agent } = makeAgent([plan(1), plan(2)], store);

    expect(() => agent.instruct(STEER)).not.toThrow();
    expect(typed(store, "instruction_received")).toHaveLength(0);

    await agent.runOnce();
    expect(agent.snapshot().goals).toContain(STEER);
    expect(typed(store, "instruction_consumed")).toHaveLength(1);
  });

  // The CONSUMPTION half, which the test above does not reach: it stubs only
  // `instruction_received`, so deleting the try/catch at the consumption site
  // leaves it green. Review measured exactly that.
  //
  // This site is the worse of the two. `this.inbox.shift()` has already run and
  // is irreversible, so an unguarded throw aborts runOnce BEFORE replan() ever
  // receives the steer -- the instruction destroyed rather than merely
  // unreceipted, with start()'s catch emitting a loop_error that fails to write
  // for the same reason. The operator is left holding an `instruction_received`
  // with no `instruction_consumed`, reads it as still queued, and is never
  // prompted to resend: the exact ambiguity #696 exists to remove, except the
  // steer is now actually gone.
  //
  // Reachable as the tick's FIRST write: every earlier emit that tick is
  // conditional (new notifications only, changed status only, status_snapshot
  // 60s-throttled).
  test("a store that fails at consumption loses the receipt, never the steer", async () => {
    const store = new Store(":memory:");
    const passthrough = store.appendEvent.bind(store);
    store.appendEvent = (e: AgentEvent): number => {
      if (e.type === "instruction_consumed") throw new Error("SQLITE_FULL");
      return passthrough(e);
    };
    const { agent } = makeAgent([plan(1), plan(2)], store);

    agent.instruct(STEER);
    expect(typed(store, "instruction_received")).toHaveLength(1);

    // The tick must complete and the planner must still get the steer.
    await agent.runOnce();
    expect(agent.snapshot().goals).toContain(STEER);
    // The receipt is what was lost, and only the receipt.
    expect(typed(store, "instruction_consumed")).toHaveLength(0);
  });
});
