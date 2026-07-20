import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { buildDigest, MISSION_STALE_HOURS } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { ActiveMissionsResult, GameApi, PoiDepositsResult, StatusSnapshot, SystemInfo } from "../src/client/client";
import type { PlanContext } from "../src/planner/types";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Mission-progress bridge (issue #291). The live failure this batch closes:
// after Seam A (#294) the pilot PLANNED the titanium contract every replan,
// but (Gap A) mined a belt that never yielded titanium -- nothing it was
// shown said the deposit doesn't contain it -- and (Gap B) the contract sat
// at zero progress for ~57h with abandon_mission registered and never once
// weighed. These tests guard the producer seams: the staleness derivation
// (agent clock, never digest-side Date.now), the tight get_poi gate, and the
// deterministic digest verdicts.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-07-16T21:00:00Z");
const acceptedHoursAgo = (h: number) => new Date(NOW - h * HOUR_MS).toISOString();

const titaniumObjective = {
  type: "mine", itemId: "titanium_ore", required: 20, current: 0, inCargo: 0, completed: false,
  targetBase: "gold_run_station", systemId: undefined,
};

function activeMissionsResult(overrides: {
  acceptedAt?: string; percentComplete?: number;
  objectives?: (typeof titaniumObjective)[];
}): ActiveMissionsResult {
  return {
    text: "1. Titanium Extraction Contract (id: m-titanium-1)",
    missions: [{
      missionId: "m-titanium-1",
      acceptedAt: overrides.acceptedAt,
      expiresInTicks: 9400,
      percentComplete: overrides.percentComplete,
      objectives: overrides.objectives ?? [titaniumObjective],
    }],
  };
}

function stubApi(opts: {
  activeMissions?: () => Promise<ActiveMissionsResult>;
  poiDeposits?: () => Promise<PoiDepositsResult | undefined>;
  currentPoiType?: string;
  docked?: boolean;
}) {
  const system: SystemInfo = {
    id: "gold_run", name: "Gold Run", connections: [],
    pois: [{ id: "gold_run_fields", name: "Gold Run Mineral Fields", type: "asteroid_belt" }],
    currentPoi: opts.currentPoiType
      ? { id: "gold_run_fields", name: "Gold Run Mineral Fields", type: opts.currentPoiType }
      : undefined,
  };
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 10, cargoCapacity: 50, docked: opts.docked ?? false, inTransit: false,
    dockedAt: opts.docked ? "base-1" : null,
  };
  let getPoiDepositsCalls = 0;
  const deposits = opts.poiDeposits;
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
    async getSystem() { return system; },
    ...(opts.activeMissions ? { getActiveMissions: opts.activeMissions } : {}),
    ...(deposits ? { async getPoiDeposits() { getPoiDepositsCalls++; return deposits(); } } : {}),
  };
  return { api, depositCalls: () => getPoiDepositsCalls };
}

async function replanCtx(api: GameApi, store = new Store(":memory:")): Promise<PlanContext> {
  const planner = new MockPlanner([okPlan]);
  const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => NOW });
  await agent.runOnce(); // no_plan wake -> replan
  expect(planner.contexts.length).toBe(1);
  return planner.contexts[0]!;
}

describe("staleness derivation (Gap B, #291)", () => {
  test("zero-progress mission accepted 57h ago derives zeroProgressHours from the agent clock", async () => {
    const { api } = stubApi({
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(57), percentComplete: 0 }),
    });
    const ctx = await replanCtx(api);
    expect(ctx.activeMissions?.[0]?.zeroProgressHours).toBeCloseTo(57, 5);
    const digest = buildDigest(ctx);
    expect(digest).toContain("STALE MISSION");
    expect(digest).toContain("abandon_mission{id=m-titanium-1}");
  });

  test("a fresh zero-progress mission carries its age but renders NO stale advisory", async () => {
    const { api } = stubApi({
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(2), percentComplete: 0 }),
    });
    const ctx = await replanCtx(api);
    expect(ctx.activeMissions?.[0]?.zeroProgressHours).toBeCloseTo(2, 5);
    expect(buildDigest(ctx)).not.toContain("STALE MISSION");
  });

  test("a mission WITH progress never derives zeroProgressHours, however old", async () => {
    const { api } = stubApi({
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(100), percentComplete: 25 }),
    });
    const ctx = await replanCtx(api);
    expect(ctx.activeMissions?.[0]?.zeroProgressHours).toBeUndefined();
    expect(buildDigest(ctx)).not.toContain("STALE MISSION");
  });

  test("percent_complete absent: zero progress is derived from the objectives instead", async () => {
    const { api } = stubApi({
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(30) }),
    });
    const ctx = await replanCtx(api);
    expect(ctx.activeMissions?.[0]?.zeroProgressHours).toBeCloseTo(30, 5);
  });

  test("no accepted_at means staleness UNKNOWN -- no derived hours, no advisory (absence is not a verdict)", async () => {
    const { api } = stubApi({
      activeMissions: async () => activeMissionsResult({ percentComplete: 0 }),
    });
    const ctx = await replanCtx(api);
    expect(ctx.activeMissions?.[0]?.zeroProgressHours).toBeUndefined();
    expect(buildDigest(ctx)).not.toContain("STALE MISSION");
  });
});

describe("deposit cross-check gate (Gap A, #291; gate widened by #188)", () => {
  const belt = (deposits: PoiDeposit0[]): PoiDepositsResult => ({ poiId: "gold_run_fields", deposits });
  type PoiDeposit0 = { resourceId: string; supportedPower?: number };

  test("fetches get_poi deposits when at a mineable POI with an unfinished item objective", async () => {
    const { api, depositCalls } = stubApi({
      currentPoiType: "asteroid_belt",
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(1), percentComplete: 0 }),
      poiDeposits: async () => belt(["palladium_ore", "vanadium_ore", "carbon_ore", "gold_ore"].map((id) => ({ resourceId: id }))),
    });
    const ctx = await replanCtx(api);
    expect(depositCalls()).toBe(1);
    expect(ctx.currentPoiDeposits?.map((d) => d.resourceId)).toEqual(["palladium_ore", "vanadium_ore", "carbon_ore", "gold_ore"]);
  });

  test("makes NO get_poi call at a non-mineable POI", async () => {
    const { api, depositCalls } = stubApi({
      currentPoiType: "planet",
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(1), percentComplete: 0 }),
      poiDeposits: async () => belt([{ resourceId: "palladium_ore" }]),
    });
    const ctx = await replanCtx(api);
    expect(depositCalls()).toBe(0);
    expect(ctx.currentPoiDeposits).toBeUndefined();
  });

  test("fetches at a mineable POI even with NO active mission -- the #188 feasibility verdict consumes it", async () => {
    // The #302 cut gated this fetch on a mission wanting an item; the #188
    // incident (a doomed mine with no mission attached) is exactly the case
    // that gate starved, so the gate is now the POI type alone.
    const { api, depositCalls } = stubApi({
      currentPoiType: "asteroid_belt",
      activeMissions: async () => ({ text: "" }),
      poiDeposits: async () => belt([{ resourceId: "palladium_ore", supportedPower: 24 }]),
    });
    const ctx = await replanCtx(api);
    expect(depositCalls()).toBe(1);
    expect(ctx.currentPoiDeposits).toEqual([{ resourceId: "palladium_ore", supportedPower: 24 }]);
  });

  test("a deposits fetch failure degrades to no verdict, emits poi_deposits_error, replan proceeds", async () => {
    const store = new Store(":memory:");
    const { api } = stubApi({
      currentPoiType: "asteroid_belt",
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(1), percentComplete: 0 }),
      poiDeposits: async () => { throw new Error("poi query down"); },
    });
    const ctx = await replanCtx(api, store);
    expect(ctx.currentPoiDeposits).toBeUndefined();
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok");
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "poi_deposits_error");
    expect(events.length).toBe(1);
  });

  test("a fetch that parses to ZERO resources at a mineable POI is a visible divergence, not an empty verdict", async () => {
    const store = new Store(":memory:");
    const { api } = stubApi({
      currentPoiType: "asteroid_belt",
      activeMissions: async () => activeMissionsResult({ acceptedAt: acceptedHoursAgo(1), percentComplete: 0 }),
      poiDeposits: async () => belt([]),
    });
    const ctx = await replanCtx(api, store);
    expect(ctx.currentPoiDeposits).toBeUndefined();
    const events = store.recentEvents("a1", 20).filter((e) => e.type === "poi_deposits_error");
    expect(events.length).toBe(1);
  });
});

describe("mission objective check rendering (#291)", () => {
  const baseCtx: PlanContext = {
    persona: "p", goals: [], wake: { reason: "heartbeat" },
    statusSummary: "s", recentEvents: [],
  };

  test("renders progress numbers, cargo count and target for an unfinished objective", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{
        missionId: "m-titanium-1", expiresInTicks: 9400, percentComplete: 0,
        objectives: [titaniumObjective],
      }],
    });
    expect(digest).toContain("Mission objective check");
    expect(digest).toContain("mission m-titanium-1");
    expect(digest).toContain("titanium_ore: progress 0/20, 0 in cargo");
    expect(digest).toContain("complete at gold_run_station");
    expect(digest).toContain("expires in 9400 ticks");
  });

  // These two feed the LEGACY currentPoiDepositIds field: since #188 the agent
  // writes currentPoiDeposits instead, and this pair is the persisted-state
  // tolerance proof -- a plan_context event harvested BEFORE #188 must replay
  // its membership verdict unchanged (never crash, never lose the verdict).
  test("PREDATING artifact: legacy currentPoiDepositIds still yields the does-not-include verdict", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{ missionId: "m-titanium-1", objectives: [titaniumObjective] }],
      currentPoiDepositIds: ["palladium_ore", "vanadium_ore"],
    });
    // Assert the stable core, not the full sentence: the item_id ≡ resource_id
    // equivalence is unverified live, so the verdict wording stays soft.
    expect(digest).toContain("does not include titanium_ore");
    expect(digest).toContain("[palladium_ore, vanadium_ore]");
  });

  test("objective item IN the deposit list (new currentPoiDeposits field) -> a mine-HERE verdict", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{ missionId: "m-titanium-1", objectives: [titaniumObjective] }],
      currentPoiDeposits: [{ resourceId: "palladium_ore" }, { resourceId: "titanium_ore" }],
    });
    expect(digest).toContain("DO list titanium_ore -- mining HERE can yield it");
    expect(digest).not.toContain("does not include");
  });

  test("when both fields are present the new field wins (the agent never writes both; a hand-built ctx must not double-render)", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{ missionId: "m-titanium-1", objectives: [titaniumObjective] }],
      currentPoiDeposits: [{ resourceId: "titanium_ore" }],
      currentPoiDepositIds: ["palladium_ore"],
    });
    expect(digest).toContain("DO list titanium_ore");
    expect(digest).not.toContain("does not include titanium_ore");
  });

  // Mission-objective type blindness (issue #330). The deposit check exists for
  // MINING-fulfilled objectives; a deliver_item objective carries an item_id but
  // is fulfilled by hauling/buying, not mining. Keying only on itemId rendered a
  // false "does not include ... weigh abandoning" abandon-pressure on a delivery
  // contract standing at a belt. The reference enumerates the non-mining
  // objective types (deliver_item, kill_*, visit_system: missions.md:47-49,
  // openapi-v2.json:90999), so a deliver_item objective must skip BOTH deposit
  // branches -- no mining verdict either way.
  test("deliver_item objective at a belt gets NO deposit verdict (issue #330)", () => {
    const deliverObjective = {
      type: "deliver_item", itemId: "iron_ore", required: 50, current: 0, inCargo: 0,
      completed: false, targetBase: "confederacy_central_command", systemId: undefined,
    };
    // Belt deposits do NOT list iron_ore -> the old code emitted false pressure.
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{ missionId: "m-deliver-1", objectives: [deliverObjective] }],
      currentPoiDeposits: [{ resourceId: "palladium_ore" }, { resourceId: "vanadium_ore" }],
    });
    // Progress still renders (the objective is not hidden, just not mining-framed).
    expect(digest).toContain("iron_ore: progress 0/50");
    // No mining deposit verdict -- neither the false abandon-pressure nor a
    // misleading "mine HERE" line applies to a delivery objective.
    expect(digest).not.toContain("does not include iron_ore");
    expect(digest).not.toContain("Deposit check:");
  });

  // The negative twin: a genuine mining objective ("mine" type) at a belt that
  // lacks its ore still gets the deposit verdict -- the fix must not suppress the
  // help it was built for (#291). titaniumObjective.type === "mine".
  test("mine objective still gets the does-not-include verdict after the #330 gate", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{ missionId: "m-titanium-1", objectives: [titaniumObjective] }],
      currentPoiDeposits: [{ resourceId: "palladium_ore" }, { resourceId: "vanadium_ore" }],
    });
    expect(digest).toContain("does not include titanium_ore");
  });

  test("no deposit data -> no deposit verdict in either direction (absence is not a verdict)", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{ missionId: "m-titanium-1", objectives: [titaniumObjective] }],
    });
    expect(digest).toContain("Mission objective check");
    // "Deposit check:" is the verdict form (membership and feasibility lines);
    // the unconditional mining runbook may NAME the section without rendering one.
    expect(digest).not.toContain("Deposit check:");
    expect(digest).not.toContain("Deposit check at your current POI");
  });

  test("stale advisory fires exactly at the threshold and names the registered escape", () => {
    const at = (h: number) => buildDigest({
      ...baseCtx,
      activeMissions: [{ missionId: "m-1", zeroProgressHours: h, objectives: [titaniumObjective] }],
    });
    expect(at(MISSION_STALE_HOURS - 0.1)).not.toContain("STALE MISSION");
    const stale = at(MISSION_STALE_HOURS);
    expect(stale).toContain("STALE MISSION");
    expect(stale).toContain("abandon_mission{id=m-1}");
    // the abandon cost caveat (missions.md:23) rides along
    expect(stale).toContain("PROVIDED");
  });

  // Completion-readiness verdict (#291 regression): the raw "14/20" numbers did
  // not stop 12 premature complete_mission calls; the digest now derives the
  // complete_mission GATE explicitly. Each test pins a distinct branch.
  test("objective short of required -> NOT-ready verdict names the shortfall and forbids complete_mission", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{
        missionId: "m-titanium-1",
        objectives: [{ ...titaniumObjective, current: 14, inCargo: 14 }],
      }],
    });
    expect(digest).toContain("Completion check: NOT ready");
    expect(digest).toContain("titanium_ore 14/20 (mine 6 more)");
    expect(digest).toContain("Do NOT plan complete_mission yet");
    expect(digest).not.toContain("READY");
  });

  test("every objective met -> READY verdict names the complete_mission call", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{
        missionId: "m-titanium-1",
        objectives: [{ ...titaniumObjective, current: 20, inCargo: 20 }],
      }],
    });
    expect(digest).toContain("Completion check: READY");
    expect(digest).toContain("complete_mission{id=m-titanium-1}");
    expect(digest).not.toContain("NOT ready");
  });

  test("objective count UNKNOWN (required/current unparsed) -> no completion verdict fabricated", () => {
    const digest = buildDigest({
      ...baseCtx,
      activeMissions: [{
        missionId: "m-titanium-1",
        objectives: [{ ...titaniumObjective, required: undefined, current: undefined }],
      }],
    });
    expect(digest).toContain("Mission objective check");
    expect(digest).not.toContain("Completion check");
  });

  test("no parsed missions -> no objective-check section at all", () => {
    expect(buildDigest(baseCtx)).not.toContain("Mission objective check");
    expect(buildDigest({ ...baseCtx, activeMissions: [] })).not.toContain("Mission objective check");
  });
});
