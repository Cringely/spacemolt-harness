import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot, CargoItem } from "../src/client/client";
import type { EnvelopeNotification } from "../src/client/http";
import type { Planner } from "../src/planner/types";

// SM-11 observability: the loop surfaces the game's OWN result feed
// (`notification` events, de-duped) and a per-tick DELTA (`ledger` events) so
// the operator can see outcomes -- ore mined + which resource, sale revenue,
// spend -- not just the action verb. These ablations pin the two properties
// that make the ledger the reliable per-tick answer (mine's yield resolves a
// tick later, in status) and the dedupe that keeps repeated polls from
// restamping the feed.
//
// Offline: fake api + a planner that never matters (notifications/ledger emit
// before the wake/planner gates), zero live traffic.

// Steward/heartbeat/thrash windows pushed unreachably large so nothing but the
// code under test emits into the streams we assert on.
const cfg: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  maxPlansPerWindow: 1_000_000, planBudgetWindowMinutes: 60,
  fuelReservePct: 25, stuckWindowMinutes: 10_000_000, strandAutoSelfDestruct: false,
  progressHeartbeatMinutes: 10_000_000,
};

const throwingPlanner = (): Planner => ({ async plan() { throw new Error("no live planner offline"); } });

// A docked, full-fuel, full-hull pilot (no reflex/wake side effects) whose
// credits + cargo are driven by the controller so each tick scripts exactly
// what changed. notifications() returns whatever the controller currently holds.
function makeApi(ctrl: {
  credits: number;
  cargo: CargoItem[];
  cargoUsed: number;
  notifications: EnvelopeNotification[];
}): GameApi {
  return {
    async action() { return { result: "ok" }; },
    async status(): Promise<StatusSnapshot> {
      return {
        credits: ctrl.credits, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
        cargoUsed: ctrl.cargoUsed, cargoCapacity: 100, docked: true, inTransit: false,
        systemId: "sys_a", cargo: ctrl.cargo,
      };
    },
    async notifications() { return ctrl.notifications; },
  };
}

function note(id: string, type: string, msg_type: string, data?: unknown): EnvelopeNotification {
  return { id, type, msg_type, timestamp: "2026-07-12T00:00:00Z", data };
}

const events = (store: Store, type: string) =>
  store.recentEvents("a1", 100_000).filter((e) => e.type === type);

type LedgerPayload = {
  credits?: { delta: number; from: number; to: number };
  cargo?: Array<{ itemId: string; name: string; delta: number; from: number; to: number }>;
  cargoUsed?: { from: number; to: number };
};

describe("SM-11 notifications feed", () => {
  test("each notification is emitted exactly once, deduped across repeated polls", async () => {
    const ctrl = { credits: 500, cargo: [] as CargoItem[], cargoUsed: 0, notifications: [] as EnvelopeNotification[] };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: makeApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    // Poll 1: two notifications appear.
    ctrl.notifications = [note("n1", "combat", "npc_destroyed"), note("n2", "trade", "sale")];
    now += 1000; await agent.runOnce();
    // Poll 2: the game STILL returns the same batch (not yet aged out).
    now += 1000; await agent.runOnce();
    // Poll 3: n1 aged out, n3 is new; n2 still present.
    ctrl.notifications = [note("n2", "trade", "sale"), note("n3", "system", "docked")];
    now += 1000; await agent.runOnce();

    const emitted = events(store, "notification").map((e) => (e.payload as { id: string }).id);
    // n1/n2/n3 each once despite n1 and n2 being returned on multiple polls.
    expect(emitted).toEqual(["n1", "n2", "n3"]);
  });

  test("notification payload carries the game's result fields (type + data)", async () => {
    const ctrl = { credits: 500, cargo: [] as CargoItem[], cargoUsed: 0, notifications: [] as EnvelopeNotification[] };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: makeApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    ctrl.notifications = [note("m1", "trade", "sale", { item: "Carbon Ore", qty: 2, credits: 4 })];
    now += 1000; await agent.runOnce();

    const p = events(store, "notification")[0]!.payload as { notifType: string; msgType: string; data: unknown };
    expect(p.notifType).toBe("trade");
    expect(p.msgType).toBe("sale");
    expect(p.data).toEqual({ item: "Carbon Ore", qty: 2, credits: 4 });
  });
});

describe("SM-11 per-tick ledger", () => {
  test("a cargo item quantity rising -> ledger names the resource with the right +delta", async () => {
    const ctrl = { credits: 500, cargo: [] as CargoItem[], cargoUsed: 0, notifications: [] as EnvelopeNotification[] };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: makeApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await agent.runOnce();                 // seed baseline: empty hold
    expect(events(store, "ledger").length).toBe(0);

    // mine resolves: +3 Carbon Ore lands in the hold a tick later.
    ctrl.cargo = [{ itemId: "carbon_ore", name: "Carbon Ore", quantity: 3 }];
    ctrl.cargoUsed = 3;
    now += 1000; await agent.runOnce();

    const led = events(store, "ledger");
    expect(led.length).toBe(1);
    const p = led[0]!.payload as LedgerPayload;
    expect(p.credits).toBeUndefined();     // no credit move on a mine
    expect(p.cargo).toEqual([{ itemId: "carbon_ore", name: "Carbon Ore", delta: 3, from: 0, to: 3 }]);
    expect(p.cargoUsed).toEqual({ from: 0, to: 3 });
  });

  test("credits rising (sale) -> ledger income with a positive delta", async () => {
    const ctrl = { credits: 500, cargo: [] as CargoItem[], cargoUsed: 0, notifications: [] as EnvelopeNotification[] };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: makeApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await agent.runOnce();                 // seed
    ctrl.credits = 504;                    // sold something for 4cr
    now += 1000; await agent.runOnce();

    const p = events(store, "ledger")[0]!.payload as LedgerPayload;
    expect(p.credits).toEqual({ delta: 4, from: 500, to: 504 });
  });

  test("credits falling (spend) -> ledger records the negative sign", async () => {
    const ctrl = { credits: 504, cargo: [] as CargoItem[], cargoUsed: 0, notifications: [] as EnvelopeNotification[] };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: makeApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await agent.runOnce();                 // seed
    ctrl.credits = 318;                    // refuel/buy spend of 186cr
    now += 1000; await agent.runOnce();

    const p = events(store, "ledger")[0]!.payload as LedgerPayload;
    expect(p.credits).toEqual({ delta: -186, from: 504, to: 318 });
  });

  test("a no-change tick emits NO ledger event (delta feed stays quiet)", async () => {
    const ctrl = { credits: 500, cargo: [{ itemId: "carbon_ore", name: "Carbon Ore", quantity: 3 }], cargoUsed: 3, notifications: [] as EnvelopeNotification[] };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: makeApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await agent.runOnce();                 // seed
    now += 1000; await agent.runOnce();    // nothing changed
    now += 1000; await agent.runOnce();    // still nothing
    expect(events(store, "ledger").length).toBe(0);
  });

  test("a full sale (credits up, hold emptied) -> one ledger with both the cargo loss and the income", async () => {
    // Exercises the 'item vanished from the hold' branch alongside a credit
    // gain -- the shape a sell produces, and the answer to 'sold what, for how
    // much' in a single event.
    const ctrl = { credits: 500, cargo: [{ itemId: "carbon_ore", name: "Carbon Ore", quantity: 2 }], cargoUsed: 2, notifications: [] as EnvelopeNotification[] };
    const store = new Store(":memory:");
    let now = 0;
    const agent = new Agent({ id: "a1", persona: "p", api: makeApi(ctrl), store, planner: throwingPlanner(), config: cfg, now: () => now });

    await agent.runOnce();                 // seed: 2 Carbon Ore, 500cr
    ctrl.cargo = []; ctrl.cargoUsed = 0; ctrl.credits = 504;
    now += 1000; await agent.runOnce();

    const p = events(store, "ledger")[0]!.payload as LedgerPayload;
    expect(p.credits).toEqual({ delta: 4, from: 500, to: 504 });
    expect(p.cargo).toEqual([{ itemId: "carbon_ore", name: "Carbon Ore", delta: -2, from: 2, to: 0 }]);
  });
});
