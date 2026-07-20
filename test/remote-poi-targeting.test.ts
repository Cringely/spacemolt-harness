import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot, SystemInfo } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { PlanContext } from "../src/planner/types";

// Remote-POI targeting (issue #176). One root cause -- an action sent against a
// target the ship cannot act on FROM WHERE IT IS -- two live symptoms:
//   travel: ~30 cross-system blocks/72h ("Gold Run Mineral Fields is in the
//           Gold Run system (gold_run), but you are in market_prime").
//   scan:   16/16 lifetime attempts blocked, every recent one "invalid_target:
//           Target 'commerce_fields' not found at your current location".
// The states these tests feed are the ones the live system actually produced
// (L-24): a round-trip plan whose trailing travel names a POI of the system it
// was PLANNED in, and a scan aimed at a POI id.

// Two real systems, shaped like the captured get_system response
// (test/fixtures/spacemolt-probe-2026-07-12.json).
const GOLD_RUN: SystemInfo = {
  id: "gold_run", name: "Gold Run",
  connections: ["market_prime"],
  pois: [
    { id: "gold_run_mineral_fields", name: "Gold Run Mineral Fields", type: "asteroid_field", hasBase: false },
    { id: "gold_run_star", name: "Gold Run Star", type: "sun", hasBase: false },
  ],
  currentPoi: { id: "gold_run_mineral_fields", name: "Gold Run Mineral Fields", type: "asteroid_field" },
};
const MARKET_PRIME: SystemInfo = {
  id: "market_prime", name: "Market Prime",
  connections: ["gold_run"],
  pois: [{ id: "market_prime_exchange", name: "Market Prime Exchange", type: "station", hasBase: true }],
  currentPoi: { id: "market_prime_exchange", name: "Market Prime Exchange", type: "station" },
};

function stubApi(system: SystemInfo | (() => SystemInfo) | { throws: true }, nearby?: () => Promise<string>) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
    async getSystem() {
      if (typeof system === "function") return system();
      if ("throws" in system) throw new Error("map query down");
      return system;
    },
    // Omitted when the test passes no nearby source: the #368 check then has
    // no capability to consult and must fail open.
    ...(nearby ? { async getNearby() { return nearby(); } } : {}),
  };
  return { api, calls };
}

describe("executor target-locality guard (#176)", () => {
  test("travel to a POI of ANOTHER system is blocked before the call, naming travel_to as the way there", async () => {
    // The live shape: the plan was written in gold_run, so this id was a real
    // local POI when it was admitted; the ship is now in market_prime.
    const { api, calls } = stubApi(MARKET_PRIME);
    const plan: Plan = { goal: "g", steps: [{ action: "travel", params: { id: "gold_run_mineral_fields" } }] };

    const r = await executeTick(api, plan, { step: 0, iteration: 0 });

    expect(r.kind).toBe("blocked");
    const reason = (r as { reason: string }).reason;
    // Alternatives-first: the steer must survive the digest's 200-char clip of
    // an untrusted blocked detail.
    expect(reason.slice(0, 200)).toContain("travel_to{system_id");
    expect(reason).toContain("gold_run_mineral_fields");
    expect(reason).toContain("market_prime");
    // The point of a PRE-step guard: the doomed submission is never spent.
    expect(calls.map((c) => c.name)).not.toContain("travel");
  });

  test("travel to a POI of the CURRENT system still goes to the game (no fabricated block)", async () => {
    const { api, calls } = stubApi(GOLD_RUN);
    const plan: Plan = { goal: "g", steps: [{ action: "travel", params: { id: "gold_run_star" } }] };

    const r = await executeTick(api, plan, { step: 0, iteration: 0 });

    expect(r.kind).toBe("plan_done"); // ran, single-step plan complete -- not blocked
    expect(calls).toContainEqual({ name: "travel", params: { id: "gold_run_star" } });
  });

  test("scan of a POI id is blocked before the call, pointing at the Nearby list", async () => {
    // The live class: scanning the belt the ship is sitting in. A POI is a
    // place, so it is never "at" your location -- the game says exactly that.
    const { api, calls } = stubApi(GOLD_RUN);
    const plan: Plan = { goal: "g", steps: [{ action: "scan", params: { id: "gold_run_mineral_fields" } }] };

    const r = await executeTick(api, plan, { step: 0, iteration: 0 });

    expect(r.kind).toBe("blocked");
    const reason = (r as { reason: string }).reason;
    expect(reason.slice(0, 200)).toContain("Nearby list");
    expect(reason).toContain("gold_run_mineral_fields");
    expect(calls.map((c) => c.name)).not.toContain("scan");
  });

  test("scan of an id that is NOT a POI (an entity from the Nearby list) goes to the game", async () => {
    // No getNearby on this stub, so this also pins the #368 check's
    // no-capability fail-open path: absent the listing, the game decides.
    const { api, calls } = stubApi(GOLD_RUN);
    const plan: Plan = { goal: "g", steps: [{ action: "scan", params: { id: "ship_kessler_7" } }] };

    const r = await executeTick(api, plan, { step: 0, iteration: 0 });

    expect(r.kind).toBe("plan_done"); // ran, single-step plan complete -- not blocked
    expect(calls).toContainEqual({ name: "scan", params: { id: "ship_kessler_7" } });
  });

  test("fails OPEN: a get_system failure never fabricates a block", async () => {
    const { api, calls } = stubApi({ throws: true });
    const plan: Plan = { goal: "g", steps: [{ action: "travel", params: { id: "gold_run_mineral_fields" } }] };

    const r = await executeTick(api, plan, { step: 0, iteration: 0 });

    expect(r.kind).toBe("plan_done"); // ran, single-step plan complete -- not blocked
    expect(calls).toContainEqual({ name: "travel", params: { id: "gold_run_mineral_fields" } });
  });
});

describe("executor scan nearby-membership guard (#368)", () => {
  // The #368 class: 27/27 lifetime scans reached the game and failed
  // `invalid_target` because the target was a POI name from ANOTHER location
  // (factory_belt_haze, colony_debris_field, ...). Those ids are not POIs of
  // the current system, so the #176 check above passes them; the fresh
  // get_nearby text is the only source that can rule them out.
  const NEARBY =
    "Nearby (2):\nid\tname\ttype\nship_kessler_7\tKessler VII\tship\nwreck_04\tDerelict Hauler\twreck";

  test("scan of a POI id carried from another system is blocked before the tick", async () => {
    const { api, calls } = stubApi(GOLD_RUN, async () => NEARBY);
    const plan: Plan = { goal: "g", steps: [{ action: "scan", params: { id: "factory_belt_haze" } }] };

    const r = await executeTick(api, plan, { step: 0, iteration: 0 });

    expect(r.kind).toBe("blocked");
    const reason = (r as { reason: string }).reason;
    // Alternatives-first: the steer must survive the digest's 200-char clip.
    expect(reason.slice(0, 200)).toContain("Nearby list");
    expect(reason).toContain("factory_belt_haze");
    // Seam-2 discipline: a guard reason never names a query action as a
    // plannable step -- it points at the briefing's Nearby list instead.
    expect(reason).not.toContain("get_nearby");
    expect(calls.map((c) => c.name)).not.toContain("scan");
  });

  test("scan of an entity on the fresh Nearby listing goes to the game", async () => {
    const { api, calls } = stubApi(GOLD_RUN, async () => NEARBY);
    const plan: Plan = { goal: "g", steps: [{ action: "scan", params: { id: "ship_kessler_7" } }] };

    const r = await executeTick(api, plan, { step: 0, iteration: 0 });

    expect(r.kind).toBe("plan_done");
    expect(calls).toContainEqual({ name: "scan", params: { id: "ship_kessler_7" } });
  });

  test("fails OPEN: a get_nearby failure or an EMPTY listing never fabricates a block", async () => {
    // Empty is ambiguous ("nothing visible" vs a shape divergence), so it is
    // not a verdict (#94); the game answers instead.
    const sources = [async () => { throw new Error("nearby query down"); }, async () => ""];
    for (const nearby of sources) {
      const { api, calls } = stubApi(GOLD_RUN, nearby);
      const plan: Plan = { goal: "g", steps: [{ action: "scan", params: { id: "factory_belt_haze" } }] };

      const r = await executeTick(api, plan, { step: 0, iteration: 0 });

      expect(r.kind).toBe("plan_done");
      expect(calls).toContainEqual({ name: "scan", params: { id: "factory_belt_haze" } });
    }
  });
});

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

describe("Agent: the round-trip plan that produced the live travel blocks (#176)", () => {
  // Reproduces the root cause end to end: plan-time validity is not
  // execution-time validity. The plan is written IN gold_run, where
  // gold_run_mineral_fields is a real local POI (so plan-admission
  // normalization admits it); the travel_to step then MOVES the ship, and the
  // trailing travel runs from market_prime.
  function movingApi() {
    let systemId = "gold_run";
    const status = (): StatusSnapshot => ({
      credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId,
    });
    const api: GameApi = {
      async action(name, params): Promise<V2Result> {
        if (name === "find_route") {
          return {
            result: "route",
            structuredContent: {
              found: true,
              route: [{ system_id: systemId }, { system_id: (params as { id: string }).id }],
            },
          };
        }
        if (name === "jump") { systemId = (params as { id: string }).id; return { result: "jumped" }; }
        return { result: "ok" };
      },
      async status() { return status(); },
      async notifications() { return []; },
      async getSystem() { return systemId === "gold_run" ? GOLD_RUN : MARKET_PRIME; },
    };
    return api;
  }

  test("the stale trailing travel is blocked, and the block's steer reaches the next planner prompt", async () => {
    const roundTrip: Plan = { goal: "sell then return", steps: [
      { action: "travel_to", params: { system_id: "market_prime" } },
      { action: "travel", params: { id: "gold_run_mineral_fields" } },
    ]};
    const planner = new MockPlanner([roundTrip, { goal: "next", steps: [{ action: "mine", params: {} }] }]);
    const agent = new Agent({
      id: "a1", persona: "p", api: movingApi(), store: new Store(":memory:"),
      planner, config, now: () => 1,
    });

    await agent.runOnce(); // no_plan -> replan; the round trip is ADMITTED (valid in gold_run)
    expect(planner.contexts.length).toBe(1);
    await agent.runOnce(); // travel_to: jump to market_prime, arrives
    await agent.runOnce(); // travel_to sees systemId === target -> advance to the travel step
    await agent.runOnce(); // travel: guard fires -> blocked
    await agent.runOnce(); // blocked wake -> replan

    const replan = planner.contexts[1]!;
    expect(replan.wake.reason).toBe("blocked");
    // The steer has to reach the model, not just the event feed: the digest
    // clips an untrusted blocked detail at 200 chars, so the alternative must
    // still be in the prompt the planner actually reads.
    expect(buildDigest(replan)).toContain("travel_to{system_id");
  });
});

describe("Agent nearby listing -> digest (#176)", () => {
  const nearbyText = "Nearby (2):\nid\tname\ttype\nship_kessler_7\tKessler VII\tship\nwreck_04\tDerelict Hauler\twreck";

  function nearbyApi(nearby?: () => Promise<string>) {
    let calls = 0;
    const status: StatusSnapshot = {
      credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
      ...(nearby ? { async getNearby() { calls++; return nearby(); } } : {}),
    };
    return { api, counts: () => calls };
  }

  test("the raw get_nearby listing reaches the planner and is labelled the only valid scan target source", async () => {
    const { api, counts } = nearbyApi(async () => nearbyText);
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({
      id: "a1", persona: "p", api, store: new Store(":memory:"), planner, config, now: () => 1,
    });

    await agent.runOnce();

    expect(counts()).toBe(1); // fetched once per replan, ungated (scanning happens in space)
    const digest = buildDigest(planner.contexts[0]!);
    expect(digest).toContain("ship_kessler_7");
    expect(digest).toContain("the ONLY valid scan targets");
  });

  test("a get_nearby failure degrades to no Nearby section + a visible nearby_error, and the replan proceeds", async () => {
    const { api } = nearbyApi(async () => { throw new Error("nearby query down"); });
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce();

    expect(planner.contexts[0]!.nearbyText).toBeUndefined();
    expect(store.recentEvents("a1", 20).map((e) => e.type)).toContain("nearby_error");
    expect(buildDigest(planner.contexts[0]!)).not.toContain("Nearby --");
  });
});

describe("digest: here vs elsewhere (#176)", () => {
  const ctx: PlanContext = {
    persona: "miner", goals: [], wake: { reason: "heartbeat" },
    statusSummary: "credits 100, fuel 80/100, hull 100/100, cargo 0/50, undocked",
    recentEvents: [],
    surroundings: {
      systemId: "gold_run", systemName: "Gold Run", connections: ["market_prime"],
      pois: GOLD_RUN.pois, dockedAt: null, currentPoi: GOLD_RUN.currentPoi,
    },
  };

  test("briefs that a POI id dies the moment the plan leaves the system (the round-trip trap)", () => {
    const text = buildDigest(ctx);
    expect(text).toContain("resolved when that step RUNS");
    expect(text).toMatch(/never place a travel\{id\}.*AFTER a step that leaves this system/);
  });

  test("with no Nearby section, the scan rule tells the planner not to plan scan at all", () => {
    const text = buildDigest(ctx);
    expect(text).not.toContain("Nearby --");
    expect(text).toContain("do not plan scan at all");
    expect(text).toContain("NEVER scan a POI id");
  });
});
