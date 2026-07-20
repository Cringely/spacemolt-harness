import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot, CargoItem } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Capability audit (Workflow A, 2026-07-19): get_cargo is a dedicated fetch,
// preferred over the get_status-derived StatusSnapshot.cargo field client.ts's
// CargoItemSchema comment already flags as unverified live -- the audit's own
// live finding (install_mod -> module_not_found) is a real symptom of exactly
// that gap. These tests pin the fix's actual payoff: the dedicated result
// reaches PlanContext.cargo and the digest renders it, and the OLD path still
// works as a fallback when getCargo is absent (no fake/mock regresses).

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};
const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

function stubApi(opts: {
  statusCargo?: CargoItem[];
  getCargo?: () => Promise<{ used: number; capacity: number; items: CargoItem[] } | undefined>;
}) {
  let getCargoCalls = 0;
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: (opts.statusCargo ?? []).reduce((n, c) => n + c.quantity, 0), cargoCapacity: 50,
    docked: true, inTransit: false, dockedAt: "base-1",
    cargo: opts.statusCargo ?? [],
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    ...(opts.getCargo ? { async getCargo() { getCargoCalls++; return opts.getCargo!(); } } : {}),
  };
  return { api, counts: () => ({ getCargoCalls }) };
}

describe("Agent cargo visibility (capability audit)", () => {
  test("a live get_cargo result reaches PlanContext.cargo and the digest, taking priority over get_status", async () => {
    // get_status disagrees with get_cargo (a stale/empty status.cargo) -- the
    // dedicated fetch must win, proving it is not just re-reading the same field.
    const { api, counts } = stubApi({
      statusCargo: [],
      getCargo: async () => ({
        used: 3, capacity: 50,
        items: [{ itemId: "mining_laser_iii", name: "Mining Laser III", quantity: 1 }],
      }),
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan
    expect(counts()).toEqual({ getCargoCalls: 1 });
    expect(planner.contexts[0]!.cargo).toEqual({
      used: 3, capacity: 50,
      items: [{ itemId: "mining_laser_iii", name: "Mining Laser III", quantity: 1 }],
    });
    const digest = buildDigest(planner.contexts[0]!);
    expect(digest).toContain("Cargo (3/50): 1x Mining Laser III (id: mining_laser_iii).");
  });

  test("no getCargo on the api (fake/mock without it) falls back to the get_status-derived manifest -- no regression", async () => {
    const { api } = stubApi({
      statusCargo: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }],
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts[0]!.cargo).toEqual({
      used: 19, capacity: 50,
      items: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }],
    });
  });

  test("a thrown getCargo emits cargo_error and falls back to the get_status-derived manifest, never blocking the replan", async () => {
    const { api, counts } = stubApi({
      statusCargo: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }],
      getCargo: async () => { throw new Error("get_cargo down"); },
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(counts()).toEqual({ getCargoCalls: 1 });
    expect(planner.contexts[0]!.cargo).toEqual({
      used: 19, capacity: 50,
      items: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }],
    });
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "cargo_error");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ message: "get_cargo down" });
  });

  test("getCargo resolving to undefined (unparseable response) falls back to the get_status-derived manifest", async () => {
    const { api } = stubApi({
      statusCargo: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }],
      getCargo: async () => undefined,
    });
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts[0]!.cargo).toEqual({
      used: 19, capacity: 50,
      items: [{ itemId: "gold_ore", name: "Gold Ore", quantity: 19 }],
    });
  });
});
