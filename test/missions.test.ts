// Per-player mission tracker: the pure aggregation (missionSummary) and the
// /api/agents/:id/missions route wiring. Zero live traffic -- fixture events
// and an in-memory Store. The two numbers come off existing events
// (status_snapshot.progress.missions_completed for the lifetime total,
// plan_context.ctx.activeMissions for the current active set), so these tests
// pin the shapes this feature reads from and the latest-event selection.
import { afterEach, describe, expect, test } from "bun:test";
import { missionSummary } from "../src/server/missions";
import { Store } from "../src/store/store";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { startDashboardServer, type DashboardServer } from "../src/server/server";
import type { AgentEvent } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

let nextId = 1;
function snapshot(payload: unknown): AgentEvent & { id: number } {
  return { id: nextId++, agentId: "a1", ts: 1000, type: "status_snapshot", payload };
}
function planContext(payload: unknown): AgentEvent & { id: number } {
  return { id: nextId++, agentId: "a1", ts: 1000, type: "plan_context", payload };
}

describe("missionSummary: aggregation over the two feeding events", () => {
  test("reads the lifetime completed total from the snapshot and the active set from plan_context", () => {
    const snap = snapshot({
      credits: 500, fuel: 80, hull: 100, cargoUsed: 0, systemId: "sol",
      progress: { credits_earned: 500, missions_completed: 7 },
    });
    const ctx = planContext({
      ctx: {
        activeMissions: [
          { missionId: "m-alpha", expiresInTicks: 120, objectives: [] },
          { missionId: "m-beta", objectives: [] },
        ],
      },
      plan: {},
    });
    const out = missionSummary(snap, ctx);
    expect(out.totalCompleted).toBe(7);
    expect(out.activeCount).toBe(2);
    expect(out.active).toEqual([
      { missionId: "m-alpha", expiresInTicks: 120, objectives: [] },
      { missionId: "m-beta", expiresInTicks: undefined, objectives: [] },
    ]);
  });

  test("new-shape mission: title and per-objective label/progress/completed reach the view", () => {
    // Current persisted shape (title + display prose on objectives; citation:
    // openapi-v2.json V2GameState.missions.active `title`, objectives[]
    // `item_name`/`description`, parsed since 2026-07-19). Label fallback
    // order is exercised across the three objectives: item_name beats
    // description beats item_id beats type.
    const ctx = planContext({
      ctx: {
        activeMissions: [{
          missionId: "m-plat",
          title: "Platinum Rush",
          expiresInTicks: 900,
          objectives: [
            { type: "mine", itemId: "platinum_ore", itemName: "Platinum Ore", current: 7, required: 15, completed: false },
            { type: "deliver_item", description: "Deliver the ore to Gold Run Station", current: 1, required: 1, completed: true },
            { type: "scan" },
          ],
        }],
      },
      plan: {},
    });
    const out = missionSummary(undefined, ctx);
    expect(out.active).toEqual([{
      missionId: "m-plat", title: "Platinum Rush", expiresInTicks: 900,
      objectives: [
        { label: "Platinum Ore", current: 7, required: 15, completed: false },
        { label: "Deliver the ore to Gold Run Station", current: 1, required: 1, completed: true },
        { label: "scan", current: undefined, required: undefined, completed: undefined },
      ],
    }]);
  });

  test("persisted-state schema tolerance: a plan_context stored BEFORE the title parse degrades to id-only, never crashes", () => {
    // Verbatim pre-2026-07-19 ActiveMissionStatus: no title, objectives carry
    // ids/numbers but no display prose (item_name/description didn't exist).
    const ctx = planContext({
      ctx: {
        activeMissions: [
          { missionId: "m-old", expiresInTicks: 42, objectives: [{ type: "mine", itemId: "titanium_ore", current: 0, required: 20 }] },
          { missionId: "m-older" }, // even older write: no objectives key at all
        ],
      },
      plan: {},
    });
    const out = missionSummary(undefined, ctx);
    expect(out.active).toEqual([
      {
        missionId: "m-old", title: undefined, expiresInTicks: 42,
        objectives: [{ label: "titanium_ore", current: 0, required: 20, completed: undefined }],
      },
      { missionId: "m-older", objectives: [] },
    ]);
  });

  test("malformed objectives tolerated: non-array objectives and non-object/mistyped entries read as empty, not a crash", () => {
    const ctx = planContext({
      ctx: {
        activeMissions: [
          { missionId: "m1", objectives: "not-an-array" },
          { missionId: "m2", objectives: [null, 42, { itemName: 7, current: "x", completed: "yes" }] },
        ],
      },
      plan: {},
    });
    const out = missionSummary(undefined, ctx);
    expect(out.active[0]).toEqual({ missionId: "m1", objectives: [] });
    // Every mistyped field reads as undefined -- an empty objective view.
    expect(out.active[1]!.objectives).toEqual([{}, {}, {}]);
  });

  test("zero-mission player: no missions_completed counter and an empty active list read as 0/empty, not an error", () => {
    // A pilot that has done other things (credits, ore) but never a mission:
    // the game omits absent counters, so missions_completed simply isn't there.
    const snap = snapshot({ credits: 500, progress: { credits_earned: 500, ore_mined: 12 } });
    const ctx = planContext({ ctx: { activeMissions: [] }, plan: {} });
    const out = missionSummary(snap, ctx);
    expect(out).toEqual({ activeCount: 0, active: [], totalCompleted: 0 });
  });

  test("a fresh pilot with neither event reads as 0 active / 0 completed rather than throwing", () => {
    expect(missionSummary(undefined, undefined)).toEqual({
      activeCount: 0, active: [], totalCompleted: 0,
    });
  });

  test("malformed persisted payloads degrade safely (schema tolerance)", () => {
    // Snapshot with no progress block at all -> completed 0. plan_context whose
    // activeMissions is not an array (a stored shape from before this field, or
    // a bad write) -> empty, never a crash.
    const noProgress = snapshot({ credits: 10 });
    const badActive = planContext({ ctx: { activeMissions: "not-an-array" }, plan: {} });
    const out = missionSummary(noProgress, badActive);
    expect(out).toEqual({ activeCount: 0, active: [], totalCompleted: 0 });
  });

  test("active count comes from the array length, so a mission whose id the parse missed is still counted", () => {
    const ctx = planContext({ ctx: { activeMissions: [{ objectives: [] }] }, plan: {} });
    const out = missionSummary(undefined, ctx);
    expect(out.activeCount).toBe(1);
    expect(out.active[0]!.missionId).toBeUndefined();
  });
});

// ---- route wiring ----------------------------------------------------------

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};
function stubApi(): GameApi {
  const status: StatusSnapshot = {
    credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
}

let server: DashboardServer;
afterEach(() => server?.stop());

describe("GET /api/agents/:id/missions", () => {
  test("returns the latest snapshot's completed total and the latest plan_context's active set", async () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "miner", persona: "p", api: stubApi(),
      store, planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    // Two snapshots: the endpoint must read the NEWER one (missions_completed 5,
    // not the earlier 2) -- proves recentEventsByType(..., 1) picks the latest.
    store.appendEvent({ agentId: "miner", ts: 1, type: "status_snapshot", payload: { progress: { missions_completed: 2 } } });
    store.appendEvent({ agentId: "miner", ts: 2, type: "status_snapshot", payload: { progress: { missions_completed: 5 } } });
    store.appendEvent({ agentId: "miner", ts: 3, type: "plan_context", payload: { ctx: { activeMissions: [{ missionId: "m1", objectives: [] }] }, plan: {} } });

    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/missions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeCount: number; totalCompleted: number; active: unknown[] };
    expect(body.totalCompleted).toBe(5);
    expect(body.activeCount).toBe(1);
    expect(body.active).toEqual([{ missionId: "m1", objectives: [] }]);
  });

  test("registered agent with zero events returns 200 with an all-zero summary", async () => {
    // A live-registered pilot that has never snapshotted or replanned: the
    // route must answer the real "0 active / 0 completed" through the actual
    // HTTP + SQLite boundary, not 404 or error, when recentEventsByType finds
    // no rows.
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "miner", persona: "p", api: stubApi(),
      store, planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/missions`);
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ activeCount: 0, active: [], totalCompleted: 0 });
  });

  test("404s for an unknown agent", async () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "miner", persona: "p", api: stubApi(),
      store, planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/ghost/missions`);
    expect(res.status).toBe(404);
    expect((await res.json())).toEqual({ error: "agent_not_found" });
  });
});
