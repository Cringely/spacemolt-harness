import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { SpacemoltClient } from "../src/client/client";
import { SpacemoltHttp } from "../src/client/http";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { Plan } from "../src/registry/plan";
import { startFakeServer, type FakeServer } from "./fake-server";
import probe from "./fixtures/spacemolt-probe-2026-07-12.json";

let server: FakeServer;
afterEach(() => server?.stop());

describe("end-to-end: agent through real client against fake server", () => {
  test("register, login, full plan lifecycle, session recovery", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "e2e-pw" },
    }));
    // cargo fills after the second mine call
    let mines = 0;
    server.setHandler("spacemolt", "mine", () => ({ result: String(++mines) }));
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 90, max_fuel: 100, hull: 100, max_hull: 100,
                cargo_used: mines >= 2 ? 50 : mines * 10, cargo_capacity: 50 },
        player: { credits: 0 },
        location: { docked_at: null, in_transit: false },
      },
    }));

    const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const { password } = await client.register("E2E Pilot", "nebula", "REG");
    await client.login("E2E Pilot", password);

    const plan: Plan = { goal: "mine until full then dock", steps: [
      { action: "mine", params: {}, until: "cargo_full" },
      { action: "dock", params: {} },
    ]};
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "e2e", persona: "e2e test pilot", api: client, store,
      planner: new MockPlanner([plan]),
      config: {
        fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
        stallThreshold: 5, subscriptionCooldownMinutes: 60,
      },
      now: () => 1_000_000,
    });

    await agent.runOnce(); // no_plan -> plan
    await agent.runOnce(); // mine 1 (cargo 10/50, continue)
    // drop the session mid-plan: transport must recover + re-login transparently
    server.failNextWith({ code: "session_invalid", message: "expired" });
    await agent.runOnce(); // mine 2 (cargo 50/50, step done)
    await agent.runOnce(); // dock -> plan_done

    const gameMutations = server.calls
      .map((c) => c.action)
      .filter((a) => ["mine", "dock"].includes(a));
    expect(gameMutations).toEqual(["mine", "mine", "dock"]); // session_invalid is consumed by the concurrent notifications()/status() prefetch that runOnce() always issues before the mutation, not by the mutation itself — http.call() retries it internally and login count below still proves recovery happened
    expect(server.calls.filter((c) => c.action === "login").length).toBe(2); // initial + replay
    expect(store.loadPlan("e2e")).toBeNull(); // plan completed and cleared
    const types = store.recentEvents("e2e", 50).map((e) => e.type);
    expect(types).toContain("plan");
    expect(types).toContain("action");
  });

  // PR #175 revision (issue #170 false-fire): the game's zero-active-missions
  // reply is the NON-EMPTY text "No active missions." (live HTTP capture:
  // fixtures/spacemolt-probe-2026-07-12.json, get_active_missions), so the
  // original non-empty-text gate handed every unmissioned pilot a standing
  // false "completing an accepted mission comes FIRST" priority line. Feed
  // the CAPTURED envelope through the real client -> gatherActiveMissions ->
  // PlanContext -> digest and assert the false fire is gone. The prior
  // empty-case test fed `undefined`, a state the live client never produces.
  test("zero-active-missions live envelope yields no active section and no priority line", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_active_missions", () => probe.get_active_missions);
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 90, max_fuel: 100, hull: 100, max_hull: 100, cargo_used: 0, cargo_capacity: 50 },
        player: { credits: 0 },
        location: { docked_at: null, in_transit: false },
      },
    }));
    const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    await client.login("E2E Pilot", "pw");
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({
      id: "e2e-nomission", persona: "p", api: client, store: new Store(":memory:"), planner,
      config: {
        fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
        stallThreshold: 5, subscriptionCooldownMinutes: 60,
      },
      now: () => 1_000_000,
    });

    await agent.runOnce(); // no plan -> replan; the active fetch has no docked gate
    // the wiring really exercised the fetch (not a vacuous pass)
    expect(server.calls.some((c) => c.action === "get_active_missions")).toBe(true);
    expect(planner.contexts[0]!.activeMissionsText).toBeUndefined();
    const digest = buildDigest(planner.contexts[0]!);
    // same anchors as digest.test.ts's #170 suite: section marker + priority topic
    expect(digest).not.toMatch(/^your active missions/im);
    expect(digest).not.toMatch(/accepted mission[^\n]{0,60}FIRST/i);
  });
});
