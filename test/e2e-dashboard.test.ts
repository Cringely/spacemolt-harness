import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { SpacemoltClient } from "../src/client/client";
import { SpacemoltHttp } from "../src/client/http";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { startDashboardServer, type DashboardServer } from "../src/server/server";
import type { Plan } from "../src/registry/plan";
import { startFakeServer, type FakeServer } from "./fake-server";

let fake: FakeServer;
let dashboard: DashboardServer;
afterEach(() => { fake?.stop(); dashboard?.stop(); });

describe("e2e: dashboard server wired to a real agent against a fake game server", () => {
  test("REST snapshot, instruct roundtrip, usage histogram, and the WS feed all agree with the same agent", async () => {
    fake = startFakeServer();
    fake.setHandler("spacemolt_auth", "register", () => ({ structuredContent: { password: "e2e-pw" } }));
    fake.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 90, max_fuel: 100, hull: 100, max_hull: 100, cargo_used: 0, cargo_capacity: 50 },
        player: { credits: 0 },
        location: { docked_at: null, in_transit: false },
      },
    }));

    const http = new SpacemoltHttp(fake.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const { password } = await client.register("E2E Pilot", "nebula", "REG");
    await client.login("E2E Pilot", password);

    // repeat: 5 keeps this plan "running" indefinitely -- it exists only to
    // be aborted by the operator instruction below, never to complete on its
    // own, so no tick-count assumption about mining/cargo math is needed.
    const minePlan: Plan = { goal: "mine", steps: [{ action: "mine", params: {}, repeat: 5 }] };
    const obeyPlan: Plan = { goal: "obey operator", steps: [{ action: "dock", params: {} }] };
    const planner = new MockPlanner([minePlan, obeyPlan]);
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "e2e", persona: "e2e test pilot", api: client, store, planner,
      config: {
        fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
        stallThreshold: 5, subscriptionCooldownMinutes: 60,
      },
      // Fixed clock, seeded from real wall-clock time (not an arbitrary low
      // constant like 1_000_000): heartbeat (delta from lastPlanAt) never
      // fires since the clock never advances, keeping the wake histogram
      // exactly {no_plan, instruction} -- same determinism as elsewhere in
      // this suite. It must be real-time-based here specifically because
      // GET /api/agents/:id/usage windows on real Date.now() (src/server/
      // server.ts's usage route), not an injectable clock -- production
      // agents default `now` to Date.now (src/agent/agent.ts:115) so this
      // never diverges outside tests; an arbitrary low fake `now` would put
      // every event's ts decades before the endpoint's 24h cutoff and silently
      // zero out replanAttempts (caught here: a Task 6 e2e run with the
      // original 1_000_000 seed returned replanAttempts: 0, expected 2).
      now: () => Date.now(),
    });

    dashboard = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const base = `http://127.0.0.1:${dashboard.port}`;

    // Connect the WS before anything happens so it observes every broadcast.
    const wsEvents: Array<{ type: string }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${dashboard.port}/ws`);
    await new Promise((resolve) => { ws.onopen = resolve; });
    ws.onmessage = (ev) => wsEvents.push(JSON.parse(ev.data as string));

    await agent.runOnce(); // wake: no_plan -> replan -> minePlan established (src/agent/wake.ts:32)

    // REST snapshot agrees with the agent's own introspection surface at this instant.
    const snaps = (await (await fetch(`${base}/api/agents`)).json()) as unknown[];
    expect(snaps).toEqual([agent.snapshot()]);

    // Instruct roundtrip: queues on the SAME Agent instance the server holds a reference to.
    const instructRes = await fetch(`${base}/api/agents/e2e/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "go dock and wait" }),
    });
    expect(instructRes.status).toBe(204);

    // evaluateWake checks a queued instruction FIRST, ahead of planState
    // (src/agent/wake.ts:30) -- this replan is driven by the instruction,
    // not by the (still-running) mine plan reaching completion.
    await agent.runOnce(); // instruction wake -> replan -> obeyPlan established, goals=["go dock and wait"]
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts[1]!.instruction).toBe("go dock and wait");

    await agent.runOnce(); // executes the single-step obeyPlan's "dock" -> plan_done (internal state only, no new wake event this tick)

    // Usage histogram reflects exactly the two replans above: no_plan, instruction.
    const usage = (await (await fetch(`${base}/api/agents/e2e/usage`)).json()) as {
      replanAttempts: number; wakeReasonHistogram: Record<string, number>;
    };
    expect(usage.replanAttempts).toBe(2);
    expect(usage.wakeReasonHistogram).toEqual({ no_plan: 1, instruction: 1 });

    // Let the WS event loop flush queued publishes before asserting on them.
    await new Promise((r) => setTimeout(r, 50));
    const types = wsEvents.map((e) => e.type);
    expect(types).toContain("wake");
    expect(types).toContain("plan");
    expect(types).toContain("action"); // emitted by the dock tick's executeOne() (src/agent/agent.ts:427)
  });
});
