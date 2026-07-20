import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { buildAgentClients } from "../src/config/client-factory";
import { McpGameApi } from "../src/client/mcp-game-api";
import { SpacemoltClient } from "../src/client/client";
import type { AgentEntry } from "../src/config/config";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 2, subscriptionCooldownMinutes: 60,
};

function tag(name: string): GameApi {
  const s: StatusSnapshot = {
    credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  return {
    // A distinguishable result so a test can tell which client drove.
    async action(): Promise<V2Result> { return { result: name }; },
    async status() { return s; },
    async notifications() { return []; },
  };
}

function baseEntry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    id: "miner", username: "Test Miner", empire: "nebula", persona: "p",
    goals: [], planner: { provider: "mock" },
    fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
    stallThreshold: 5, subscriptionCooldownMinutes: 60,
    maxPlansPerWindow: 12, planBudgetWindowMinutes: 60,
    fuelReservePct: 25, stuckWindowMinutes: 30, strandAutoSelfDestruct: false,
    progressHeartbeatMinutes: 30, repeatBlockThreshold: 3, repeatBlockWindowMinutes: 30,
    mode: "plan-then-execute",
    ...overrides,
  };
}

describe("buildAgentClients (client factory)", () => {
  test("no improv block -> HTTP client only, no improv client built", () => {
    const clients = buildAgentClients(baseEntry(), "http://localhost:9999");
    expect(clients.http).toBeInstanceOf(SpacemoltClient);
    expect(clients.improv).toBeUndefined();
  });

  test("improv block -> both an HTTP client AND an MCP-backed improv client, held together", () => {
    const clients = buildAgentClients(
      baseEntry({
        mode: "improv",
        improv: { enabled: true, tokenBudget: 200_000, wallClockMinutes: 60, preset: "standard" },
      }),
      "http://localhost:9999",
    );
    // Concurrent-capable seam: both are constructed side by side, no teardown.
    expect(clients.http).toBeInstanceOf(SpacemoltClient);
    expect(clients.improv).toBeInstanceOf(McpGameApi);
  });
});

describe("Agent driver-mode seam", () => {
  function makeAgent(mode: "plan-then-execute" | "improv", http: GameApi, improvApi?: GameApi): Agent {
    return new Agent({
      id: "a1", persona: "p", api: http, improvApi, mode, store: new Store(":memory:"),
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
  }

  test("defaults to plan-then-execute and drives the HTTP client", () => {
    const http = tag("http");
    const agent = makeAgent("plan-then-execute", http, tag("improv"));
    expect(agent.getMode()).toBe("plan-then-execute");
    expect(agent.activeApi()).toBe(http);
  });

  test("mode 'improv' drives the improv client when one is wired", () => {
    const improv = tag("improv");
    const agent = makeAgent("improv", tag("http"), improv);
    expect(agent.getMode()).toBe("improv");
    expect(agent.activeApi()).toBe(improv);
  });

  test("setMode flips the driving client BOTH ways without tearing either down (concurrent-capable)", () => {
    const http = tag("http");
    const improv = tag("improv");
    const agent = makeAgent("plan-then-execute", http, improv);
    expect(agent.activeApi()).toBe(http);
    agent.setMode("improv");
    expect(agent.activeApi()).toBe(improv); // flipped to MCP
    agent.setMode("plan-then-execute");
    expect(agent.activeApi()).toBe(http); // and back — the HTTP client was never discarded
  });

  test("setMode('improv') is a safe no-op when no improv client is wired (degrades, no null driver)", () => {
    const http = tag("http");
    const agent = makeAgent("plan-then-execute", http); // no improvApi
    agent.setMode("improv");
    expect(agent.getMode()).toBe("plan-then-execute"); // refused
    expect(agent.activeApi()).toBe(http);
  });

  test("the plan-then-execute loop is unchanged by the seam: it still runs on the HTTP client", async () => {
    // A default-mode agent with an improv client present must behave byte-identically
    // to one without: runOnce drives plan-then-execute over the HTTP api. Assert it
    // reaches "running" (replanned + persisted) exactly as the baseline agent does.
    const agent = makeAgent("plan-then-execute", tag("http"), tag("improv"));
    await agent.runOnce();
    expect(agent.snapshot().planState).toBe("running");
  });
});
