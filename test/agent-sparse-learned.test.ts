import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { buildDigest } from "../src/planner/digest";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot, SystemInfo, FittedModule, PoiDepositsResult } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Learned sparse-deposit rules (issue #188, part 3). The incident: "Deposits
// here are too sparse for your mining array ... Relocate to a denser field or
// refit smaller extraction modules" -- a rule the game teaches ONLY via
// failure prose when supported_power is not queryable. Standard under test:
// the FIRST tick on a novel rule is unavoidable tuition; the SAME
// (action, POI, mining-fit) class never costs a second tick. Lifecycle under
// test: learn at the blocked replan -> digest marker + executor refusal ->
// persisted event -> restart survival -> TTL expiry (deposits regenerate,
// mining.md:3) -> fit-change invalidation (the key IS the fit).

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const SPARSE_BLOCK =
  "Deposits here are too sparse for your mining array — the beam disperses what little remains. Relocate to a denser field or refit smaller extraction modules.";

const minePlan: Plan = { goal: "mine here", steps: [{ action: "mine", params: {} }] };

const laser: FittedModule = { typeId: "mining_laser_iv", type: "mining", miningPower: 100, slot: "utility" };
const smallLaser: FittedModule = { typeId: "mining_laser_i", type: "mining", miningPower: 5, slot: "utility" };

const HOUR_MS = 3_600_000;

function beltSystem(): SystemInfo {
  return {
    id: "gold_run", name: "Gold Run", connections: [],
    pois: [
      { id: "gr_fields", name: "Gold Run Mineral Fields", type: "asteroid_belt" },
      { id: "gr_station", name: "Gold Run Station", type: "station", hasBase: true },
    ],
    currentPoi: { id: "gr_fields", name: "Gold Run Mineral Fields", type: "asteroid_belt" },
  };
}

// Deposits WITHOUT supported_power: the deterministic rung cannot decide, so
// the learned rule is the only thing standing between the pilot and a repeat.
const undecidableDeposits: PoiDepositsResult = {
  poiId: "gr_fields",
  deposits: [{ resourceId: "gold_ore" }],
};

function stubApi(opts: { modules?: FittedModule[]; mineFails?: boolean }) {
  const mineCalls: string[] = [];
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    modules: opts.modules ?? [laser],
  };
  const api: GameApi = {
    async action(name): Promise<V2Result> {
      if (name === "mine") {
        mineCalls.push(name);
        if (opts.mineFails) throw new SpacemoltError("command_error", SPARSE_BLOCK);
      }
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
    async getSystem() { return beltSystem(); },
    async getPoiDeposits() { return undecidableDeposits; },
  };
  return { api, mineCount: () => mineCalls.length };
}

describe("learned sparse-deposit rules (#188)", () => {
  test("incident replay: one too-sparse block teaches the rule; the repeat mine is refused locally, marker + relocate line briefed", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const { api, mineCount } = stubApi({ mineFails: true });
    const store = new Store(":memory:");
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });

    await tick(agent); // no_plan -> replan A plans mine
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "gr_fields")!.sparse).toBeUndefined();

    await tick(agent); // mine goes out ONCE, game refuses too-sparse (the tuition tick)
    expect(mineCount()).toBe(1);

    await tick(agent); // blocked wake -> the lesson must be in THIS replan
    const ctxB = planner.contexts[1]!;
    expect(ctxB.wake.reason).toBe("blocked");
    expect(ctxB.surroundings!.pois.find((p) => p.id === "gr_fields")!.sparse).toBe(true);
    const digestB = buildDigest(ctxB);
    // rung 1, the cheap briefing line: relocate, never retry here
    expect(digestB).toContain("deposits-too-sparse block");
    expect(digestB).toContain("Relocate to a denser field");
    // the learned marker + its paired steer
    expect(digestB).toContain(`gr_fields ("Gold Run Mineral Fields", asteroid_belt) [ore] [mine learned-blocked here: deposits too sparse for your current fit]`);
    expect(digestB).toContain("refused a mine with your CURRENT fit as too sparse");

    await tick(agent); // replan B's mine: refused by the LEARNED rule, no game call
    expect(mineCount()).toBe(1); // still one -- the same class never costs a second tick
    // one persisted lesson per fact
    const learned = store.recentEvents("a1", 100).filter((e) => e.type === "mine_sparse_learned");
    expect(learned.length).toBe(1);
    expect(learned[0]!.payload).toEqual({
      poiId: "gr_fields",
      equipmentKey: "mining_laser_iv",
      detail: SPARSE_BLOCK,
    });
  });

  test("the lesson survives a restart: a fresh Agent over the same store refuses the repeat before any new block", async () => {
    const store = new Store(":memory:");
    store.appendEvent({
      agentId: "a1", ts: 1_000, type: "mine_sparse_learned",
      payload: { poiId: "gr_fields", equipmentKey: "mining_laser_iv", detail: "too sparse" },
    });
    const { api, mineCount } = stubApi({});
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 2_000 });

    await agent.runOnce(); // replan: marker present from the persisted lesson
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "gr_fields")!.sparse).toBe(true);
    await agent.runOnce(); // executor refuses the mine locally
    expect(mineCount()).toBe(0);
  });

  test("TTL: a rule older than 6h expires -- deposits regenerate, so the probe mine goes through", async () => {
    const store = new Store(":memory:");
    store.appendEvent({
      agentId: "a1", ts: 0, type: "mine_sparse_learned",
      payload: { poiId: "gr_fields", equipmentKey: "mining_laser_iv", detail: "too sparse" },
    });
    const { api, mineCount } = stubApi({});
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 7 * HOUR_MS });

    await agent.runOnce();
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "gr_fields")!.sparse).toBeUndefined();
    await agent.runOnce();
    expect(mineCount()).toBe(1); // the mine was allowed: one probe tick per TTL window, by design
  });

  test("fit change invalidates: a rule learned under another mining fit neither marks nor refuses", async () => {
    const store = new Store(":memory:");
    store.appendEvent({
      agentId: "a1", ts: 1_000, type: "mine_sparse_learned",
      payload: { poiId: "gr_fields", equipmentKey: "mining_laser_iv", detail: "too sparse" },
    });
    const { api, mineCount } = stubApi({ modules: [smallLaser] }); // refit happened
    const planner = new MockPlanner([minePlan]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 2_000 });

    await agent.runOnce();
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "gr_fields")!.sparse).toBeUndefined();
    await agent.runOnce();
    expect(mineCount()).toBe(1); // allowed: refitting smaller modules is the game's own escape
  });

  test("persisted-state tolerance: malformed mine_sparse_learned events load without crashing and are skipped", async () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "mine_sparse_learned", payload: null });
    store.appendEvent({ agentId: "a1", ts: 2, type: "mine_sparse_learned", payload: { poiId: "gr_fields" } }); // no equipmentKey
    store.appendEvent({ agentId: "a1", ts: 3, type: "mine_sparse_learned", payload: "too sparse" }); // not an object
    store.appendEvent({
      agentId: "a1", ts: 4, type: "mine_sparse_learned",
      payload: { poiId: "gr_fields", equipmentKey: "mining_laser_iv" }, // detail absent: tolerated, defaults empty
    });
    const { api } = stubApi({});
    const planner = new MockPlanner([minePlan]);
    // must not throw through the constructor (the chat-enum incident class)
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 2_000 });
    await agent.runOnce();
    // the one valid row survives; the malformed rows are skipped silently
    expect(planner.contexts[0]!.surroundings!.pois.find((p) => p.id === "gr_fields")!.sparse).toBe(true);
  });

  test("a non-sparse block (wrong class) never teaches a sparse rule", async () => {
    let now = 0;
    const tick = async (agent: Agent) => { now += 1_000; await agent.runOnce(); };
    const store = new Store(":memory:");
    const planner = new MockPlanner([minePlan]);
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        if (name === "mine") throw new SpacemoltError("command_error", "cargo hold is full");
        return { result: "ok" };
      },
      async status() {
        return {
          credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 50, cargoCapacity: 50, docked: false, inTransit: false, modules: [laser],
        };
      },
      async notifications() { return []; },
      async getSystem() { return beltSystem(); },
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => now });
    await tick(agent); // replan A
    await tick(agent); // mine blocks with a NON-sparse reason
    await tick(agent); // blocked replan
    expect(store.recentEvents("a1", 100).filter((e) => e.type === "mine_sparse_learned").length).toBe(0);
    expect(planner.contexts[1]!.surroundings!.pois.find((p) => p.id === "gr_fields")!.sparse).toBeUndefined();
  });
});
