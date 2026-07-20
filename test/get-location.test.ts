import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, LocationInfo, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

// Capability-audit follow-up (2026-07-19): get_location was an unregistered
// action (docs/game-reference/commands.md:69). Registered as an ADDITIVE
// capability, not a station-dockability fix -- that precondition already
// reaches the digest via get_system's has_base (digest.ts:657, unrelated to
// this change). What get_location adds: nearby-entity counts and transit ETA
// as parsed numbers, which neither get_status (docked_at/in_transit/system_id
// only) nor get_nearby (registered but response uncaptured, raw text only)
// carry. This file follows the same end-to-end pattern as
// remote-poi-targeting.test.ts's "Agent nearby listing -> digest" block:
// harness-fetch reaches PlanContext, reaches the digest text, and a fetch
// failure degrades to no section + a visible event, never a broken replan.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

function locationApi(location?: () => Promise<LocationInfo | undefined>) {
  let calls = 0;
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    ...(location ? { async getLocation() { calls++; return location(); } } : {}),
  };
  return { api, counts: () => calls };
}

describe("Agent get_location -> digest (capability-audit follow-up)", () => {
  test("nearby-entity counts reach the planner's PlanContext and the built digest", async () => {
    const { api, counts } = locationApi(async () => ({ nearbyPlayerCount: 3, nearbyPirateCount: 1 }));
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({
      id: "a1", persona: "p", api, store: new Store(":memory:"), planner, config, now: () => 1,
    });

    await agent.runOnce();

    expect(counts()).toBe(1); // fetched once per replan, ungated (position, not station-dependent)
    expect(planner.contexts[0]!.locationInfo).toEqual({ nearbyPlayerCount: 3, nearbyPirateCount: 1 });
    const digest = buildDigest(planner.contexts[0]!);
    expect(digest).toContain("3 player(s)");
    expect(digest).toContain("1 pirate(s)");
    // The resulting plan still validates and runs -- wiring get_location does
    // not perturb the planning pipeline for an unrelated step.
    expect(planner.contexts.length).toBe(1);
  });

  test("a get_location failure degrades to no location section + a visible location_error, replan proceeds", async () => {
    const { api } = locationApi(async () => { throw new Error("location query down"); });
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();

    expect(planner.contexts[0]!.locationInfo).toBeUndefined();
    expect(store.recentEvents("a1", 20).map((e) => e.type)).toContain("location_error");
    expect(buildDigest(planner.contexts[0]!)).not.toContain("Location check (get_location)");
  });

  test("no getLocation capability (fake/mock without it) degrades to no section, no error, no crash", async () => {
    const { api } = locationApi(); // omitted entirely, mirrors gatherNearby's no-capability path
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({
      id: "a1", persona: "p", api, store: new Store(":memory:"), planner, config, now: () => 1,
    });

    await agent.runOnce();

    expect(planner.contexts[0]!.locationInfo).toBeUndefined();
  });
});
