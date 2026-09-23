import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { FLEET_REFUEL_FLOOR_CR } from "../src/planner/digest";
import type { FleetPilot } from "../src/agent/normalize-plan";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Issue #1114, the #703 gift path's read half. The live incident: corsair sat
// at 0 fuel / 5 credits for 9+ hours while the miner held 53,870cr two systems
// away, because nothing in the miner's briefing ever mentioned a fleet-mate's
// state -- a rescue could never occur to it. Agent.fleetDistress (agent.ts)
// closes that: it reads OTHER pilots' status_snapshot events off the SAME
// shared Store every agent in this harness writes to (src/main.ts), so these
// tests seed that store directly rather than driving a live game call.

const MINER = "Rockhopper Kess";
const CORSAIR = "Corvus Marrek";
const SCOUT = "Vela Farsight";
const ROSTER: FleetPilot[] = [
  { id: "miner", username: MINER },
  { id: "corsair", username: CORSAIR },
  { id: "scout", username: SCOUT },
];

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  fleetRoster: ROSTER,
};

const idlePlan: Plan = { goal: "sit tight", steps: [{ action: "dock", params: {} }] };

function stubApi(status: StatusSnapshot) {
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return api;
}

const minerStatus: StatusSnapshot = {
  credits: 53_870, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
};

/** Seed one status_snapshot event for `agentId`, the shape Agent.emit writes it. */
function seedSnapshot(store: Store, agentId: string, ts: number, fields: { credits?: unknown; fuel?: unknown }) {
  store.appendEvent({ agentId, ts, type: "status_snapshot", payload: { hull: 100, cargoUsed: 0, systemId: null, ...fields } });
}

/** Run the miner (agentId "miner", roster id "miner") once and return its ctx. */
async function replanAsMiner(store: Store) {
  const planner = new MockPlanner([idlePlan]);
  const agent = new Agent({
    id: "miner", persona: "p", api: stubApi(minerStatus), store, planner, config, now: () => 1_000_000,
  });
  await agent.runOnce();
  return planner.contexts[0]!;
}

describe("Agent.fleetDistress (issue #1114)", () => {
  test("no roster configured: renders no distress facts", async () => {
    const store = new Store(":memory:");
    const planner = new MockPlanner([idlePlan]);
    const noRosterConfig: AgentConfig = { ...config, fleetRoster: undefined };
    const agent = new Agent({
      id: "miner", persona: "p", api: stubApi(minerStatus), store, planner, config: noRosterConfig, now: () => 1,
    });
    await agent.runOnce();
    expect(planner.contexts[0]!.fleetDistress).toEqual([]);
  });

  test("a fleet-mate with no snapshot yet is skipped, not fabricated", async () => {
    const store = new Store(":memory:");
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toEqual([]);
  });

  // The exact live incident: zero fuel AND credits (5) sit under the floor --
  // the credits check alone still catches it.
  test("flags a fleet-mate at zero fuel whose credits sit under the floor", async () => {
    const store = new Store(":memory:");
    seedSnapshot(store, "corsair", 500, { credits: 5, fuel: 0 });
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toEqual([{ username: CORSAIR, fuel: 0, credits: 5 }]);
  });

  // Round-2 PR #142 review: a bare zero-fuel reading is not its own trigger.
  // The rendered remedy is a credits gift, and a fleet-mate already holding
  // credits at or above the floor is asked for nothing a gift would fix --
  // and #1115's gift-can't-spend latch means the ask would never stop.
  test("does not flag a fleet-mate at zero fuel once credits clear the floor", async () => {
    const store = new Store(":memory:");
    seedSnapshot(store, "corsair", 500, { credits: 1505, fuel: 0 });
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toEqual([]);
  });

  test("flags a fleet-mate below the refuel floor even with nonzero fuel", async () => {
    const store = new Store(":memory:");
    seedSnapshot(store, "corsair", 500, { credits: FLEET_REFUEL_FLOOR_CR - 1, fuel: 10 });
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toEqual([{ username: CORSAIR, fuel: 10, credits: FLEET_REFUEL_FLOOR_CR - 1 }]);
  });

  test("does not flag a fleet-mate at or above the refuel floor with nonzero fuel", async () => {
    const store = new Store(":memory:");
    seedSnapshot(store, "corsair", 500, { credits: FLEET_REFUEL_FLOOR_CR, fuel: 10 });
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toEqual([]);
  });

  // Security-adjacent correctness: your own state is already in Status above
  // (statusSummary) -- a self-entry here would be redundant at best and, if
  // the roster ever collided on id/username the way #788's tests worry about,
  // could misfire the guard's identity assumptions.
  //
  // The replanning pilot's OWN status_snapshot (Layer 5, agent.ts) is written
  // to the store during THIS SAME tick, before fleetDistress() reads it back
  // -- so a seeded "miner" row would just be overwritten by the live status
  // fed to this test regardless of self-exclusion, and the ablation that
  // deletes the self-check would pass unnoticed. Making the pilot's OWN live
  // status distress-shaped closes that gap: its freshly-written snapshot
  // trivially satisfies the distress predicate, so only the self-check (not
  // an absent snapshot) can be the reason it's missing from the result.
  test("never reports the replanning pilot's own state as fleet distress", async () => {
    const store = new Store(":memory:");
    const strandedMiner: StatusSnapshot = { ...minerStatus, credits: 5, fuel: 0 };
    const planner = new MockPlanner([idlePlan]);
    const agent = new Agent({
      id: "miner", persona: "p", api: stubApi(strandedMiner), store, planner, config, now: () => 1_000_000,
    });
    await agent.runOnce();
    expect(planner.contexts[0]!.fleetDistress).toEqual([]);
  });

  test("uses the LATEST snapshot, not a stale distress reading", async () => {
    const store = new Store(":memory:");
    seedSnapshot(store, "corsair", 100, { credits: 5, fuel: 0 }); // was stranded...
    seedSnapshot(store, "corsair", 200, { credits: 6000, fuel: 80 }); // ...then rescued
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toEqual([]);
  });

  test("fails closed on a malformed snapshot payload rather than fabricating a reading", async () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "corsair", ts: 500, type: "status_snapshot", payload: { credits: "broke", fuel: 0 } });
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toEqual([]);
  });

  test("flags every distressed fleet-mate, not just the first", async () => {
    const store = new Store(":memory:");
    seedSnapshot(store, "corsair", 500, { credits: 5, fuel: 0 });
    seedSnapshot(store, "scout", 500, { credits: 3, fuel: 0 });
    const ctx = await replanAsMiner(store);
    expect(ctx.fleetDistress).toHaveLength(2);
    expect(ctx.fleetDistress!.map((d) => d.username).sort()).toEqual([CORSAIR, SCOUT].sort());
  });
});
