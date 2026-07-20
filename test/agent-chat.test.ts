import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

function stubApi(notifications: GameApi["notifications"]): GameApi {
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() {
      return {
        credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
        cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
      };
    },
    notifications,
  };
}

describe("Agent chat wiring (social capabilities)", () => {
  test("a chat_message notification both wakes the agent (type: chat, config default) and reaches ctx.chatMessages", async () => {
    const api = stubApi(async () => [
      { id: "n1", type: "chat", msg_type: "chat_message", timestamp: "t", data: { sender: "traderJoe", content: "o7" } },
    ]);
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.chatMessages).toEqual([{ sender: "traderJoe", text: "o7" }]);
  });

  test("non-chat notifications leave ctx.chatMessages empty", async () => {
    const api = stubApi(async () => [
      { id: "n1", type: "trade", msg_type: "sale", timestamp: "t", data: { content: "ore sold" } },
    ]);
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // heartbeat/no_plan wake, not the notification
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.chatMessages).toEqual([]);
  });
});
