// Ship tool (issue #219) -- the shared bottom-rung unblock.
//
// The live miss this whole batch closes: the miner held 17,306cr and had made
// ZERO lifetime module or hull purchases (every buy in its history is a
// fuel_cell), because no action in src/registry/actions.ts could browse a
// shipyard or fit a module. Registration alone doesn't fix that -- an action the
// planner is never SHOWN is an action it never plans (the #147/#176 lesson), and
// an install_mod the ship's grid can't take is a wasted tick.
//
// So these tests cover the three seams that have to hold together, and nothing
// else (the registry's request shapes are already covered by the conformance
// test against the vendored OpenAPI; re-asserting them here would prove nothing):
//   1. the executor's fit guard blocks an impossible install BEFORE the tick
//   2. the digest actually SHOWS the pilot its grid and the hulls for sale
//   3. the harness fetches the shipyard listing only where one exists (docked)
import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { buildDigest } from "../src/planner/digest";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, ModuleSpec, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { PlanContext } from "../src/planner/types";

// The live miner's real hull, from test/fixtures/spacemolt-probe-2026-07-12.json
// (get_status.structuredContent.ship + .modules): a Prospect with cpu 2/13 and
// power 5/26 in use, one Mining Laser I fitted in a utility slot, 2 utility
// slots total. Every fit number below is that ship's, not an invented one.
function dockedMiner(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    credits: 17306, fuel: 100, maxFuel: 130, hull: 95, maxHull: 95,
    cargoUsed: 24, cargoCapacity: 100, docked: true, inTransit: false,
    fit: {
      cpuUsed: 2, cpuCapacity: 13, powerUsed: 5, powerCapacity: 26,
      slots: { weapon: 1, defense: 1, utility: 2 },
    },
    modules: [{ typeId: "mining_laser_i", type: "mining", miningPower: 5, slot: "utility", name: "Mining Laser I" }],
    ...overrides,
  };
}

function api(status: StatusSnapshot, spec?: ModuleSpec, extra?: Partial<GameApi>, engLevel = 0) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const game: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
    async getModuleSpec() { return spec; },
    // The live get_skills returns ONLY TRAINED skills -- the probe fixture's own
    // header reads "Skills (5 trained, 0-100 scale)" and carries exactly 5 keys.
    // So an untrained Engineering is an ABSENT key, not a zero, and the mock
    // reproduces that shape rather than a more convenient one.
    async getSkills(): Promise<Record<string, { level: number; xp: number }>> {
      return engLevel > 0 ? { engineering: { level: engLevel, xp: 0 } } : {};
    },
    ...extra,
  };
  return { game, calls };
}

const installPlan: Plan = { goal: "fit the bigger laser", steps: [{ action: "install_mod", params: { id: "mining_laser_iii" } }] };

describe("install_mod fit guard (issue #219)", () => {
  // The purchase this epic exists to enable is a several-thousand-credit one.
  // A fit that can't work must cost zero ticks and produce a reason the planner
  // can act on -- naming uninstall_mod, the game's own (and only) remedy.
  test("blocks a module that exceeds the hull's power grid, and names the remedy", async () => {
    // 22 power against 21 free (26 - 5): over by one, and CPU fits fine -- so a
    // guard that only checked CPU would wave this through.
    const { game, calls } = api(dockedMiner(), { cpuUsage: 4, powerUsage: 22, slot: "utility" });
    const r = await executeTick(game, installPlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.reason).toContain("uninstall_mod");
    expect(r.reason).toContain("power 22");
    expect(r.reason).toContain("power 21 free");
    expect(calls.map((c) => c.name)).not.toContain("install_mod"); // the tick was never spent
  });

  test("blocks a module whose slot type is full, even when CPU and power both fit", async () => {
    // A hull with its single utility slot already taken: the grid has room, the
    // ship does not. Slot occupancy is counted from the game's own `slot` field
    // on the fitted module (VERIFIED live: a Mining Laser I reports "utility",
    // NOT the "weapon" that ships.md's prose slot table would have implied).
    const oneSlotHull = dockedMiner({
      fit: { cpuUsed: 2, cpuCapacity: 13, powerUsed: 5, powerCapacity: 26, slots: { weapon: 1, defense: 1, utility: 1 } },
    });
    const { game, calls } = api(oneSlotHull, { cpuUsage: 1, powerUsage: 1, slot: "utility" });
    const r = await executeTick(game, installPlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.reason).toContain("uninstall_mod");
    expect(r.reason).toContain("utility");
    expect(calls.map((c) => c.name)).not.toContain("install_mod");
  });

  test("blocks an install while undocked (the game requires a dock to fit anything)", async () => {
    const { game, calls } = api(dockedMiner({ docked: false }), { cpuUsage: 1, powerUsage: 1 });
    const r = await executeTick(game, installPlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.reason).toContain("DOCKED");
    expect(calls.map((c) => c.name)).not.toContain("install_mod");
  });

  test("passes a module that fits -- the guard must not become the new blocker", async () => {
    const { game, calls } = api(dockedMiner(), { cpuUsage: 6, powerUsage: 14, slot: "utility" });
    const r = await executeTick(game, installPlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("plan_done");
    expect(calls.map((c) => c.name)).toContain("install_mod");
  });

  // Fail-open is the load-bearing half of every guard in this executor: a
  // fabricated block from missing data would deadlock the exact purchase this
  // epic unblocks. Both unknowns (no grid in the status snapshot; no catalog
  // entry for the id) must let the call through and let the game answer.
  test("fails OPEN on an unknown grid or an unreadable module, never fabricating a block", async () => {
    const noGrid = api(dockedMiner({ fit: undefined }), { cpuUsage: 99, powerUsage: 99 });
    expect((await executeTick(noGrid.game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(noGrid.calls.map((c) => c.name)).toContain("install_mod");

    const noSpec = api(dockedMiner(), undefined);
    expect((await executeTick(noSpec.game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(noSpec.calls.map((c) => c.name)).toContain("install_mod");

    // A catalog query that THROWS is the same unknown, not a crash.
    const thrown = api(dockedMiner(), undefined, {
      async getModuleSpec(): Promise<ModuleSpec | undefined> { throw new Error("catalog down"); },
    });
    expect((await executeTick(thrown.game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(thrown.calls.map((c) => c.name)).toContain("install_mod");
  });

  // PR #235 review finding 1 -- the false-fire the guard must not have.
  // Engineering cuts a module's CPU/power 1%/level (upstream/docs/ships.md:26),
  // and NOTHING captured says whether the catalog quotes the raw or the
  // discounted figure. If it quotes raw, a naive comparison REFUSES an install
  // the game would have accepted -- the guard becoming the blocker it exists to
  // prevent, on the one pilot with 17,306cr to spend. So the guard compares
  // against the cost FLOOR, and these three cases pin that behavior.
  test("does NOT block a fit that the pilot's Engineering discount could rescue", async () => {
    // 30 power against 21 free: over the line on the catalog's face value, and
    // the eng-0 case below proves that same module IS blocked untrained. At
    // Engineering 50 the floor is 15, which fits -- so if the catalog is raw,
    // this install is legal, and only the game can say for sure. Let it through.
    const { game, calls } = api(dockedMiner(), { cpuUsage: 4, powerUsage: 30, slot: "utility" }, undefined, 50);
    expect((await executeTick(game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(calls.map((c) => c.name)).toContain("install_mod");

    const untrained = api(dockedMiner(), { cpuUsage: 4, powerUsage: 30, slot: "utility" }, undefined, 0);
    expect((await executeTick(untrained.game, installPlan, { step: 0, iteration: 0 })).kind).toBe("blocked");
  });

  test("still blocks a fit no Engineering level could rescue, and shows its arithmetic", async () => {
    // 60 power at Engineering 50 floors to 30, still over the 21 free. Hopeless
    // under EITHER reading of the catalog -- so the block is safe, and the guard
    // keeps the value it was built for.
    const { game, calls } = api(dockedMiner(), { cpuUsage: 4, powerUsage: 60, slot: "utility" }, undefined, 50);
    const r = await executeTick(game, installPlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.reason).toContain("power 30");           // the floor, not the catalog's 60
    expect(r.reason).toContain("Engineering 50");     // and it says where the 30 came from
    expect(calls.map((c) => c.name)).not.toContain("install_mod");
  });

  test("fails OPEN on the grid check when the Engineering level is unknown", async () => {
    // No discount known means no floor can be computed, so no honest block
    // exists -- same fail-open contract as an unknown grid. Covers both the API
    // that cannot answer (McpGameApi does not implement getSkills) and the query
    // that throws.
    const absent = api(dockedMiner(), { cpuUsage: 99, powerUsage: 99 }, { getSkills: undefined });
    expect((await executeTick(absent.game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(absent.calls.map((c) => c.name)).toContain("install_mod");

    const thrown = api(dockedMiner(), { cpuUsage: 99, powerUsage: 99 }, {
      async getSkills(): Promise<Record<string, { level: number; xp: number }>> { throw new Error("skills down"); },
    });
    expect((await executeTick(thrown.game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(thrown.calls.map((c) => c.name)).toContain("install_mod");
  });

  test("still blocks an UNDOCKED install when the Engineering level is unknown", async () => {
    // The docked check must not become collateral damage of the fail-open above:
    // it runs before the discount is ever needed, and the game rejects an
    // undocked install unconditionally.
    const { game, calls } = api(dockedMiner({ docked: false }), { cpuUsage: 1, powerUsage: 1 }, { getSkills: undefined });
    expect((await executeTick(game, installPlan, { step: 0, iteration: 0 })).kind).toBe("blocked");
    expect(calls.map((c) => c.name)).not.toContain("install_mod");
  });
});

// Cargo-presence guard (issue #402). install_mod fits a module you are HOLDING
// (upstream/openapi-v1.json:44141, "Module must be in your cargo"). The live miss:
// the pilot planned install_mod for Mining Laser III twice while it was not in
// cargo and spent a doomed tick each time on module_not_found. The fit guard above
// weighs CPU/power/slots -- a module you do not own has none to weigh, so presence
// is a distinct precondition with a distinct check. Each test pins a distinct mode.
describe("install_mod cargo-presence guard (issue #402)", () => {
  // A module that FITS the grid but is not in the hold must still be blocked -- so
  // every spec below fits dockedMiner's 21 free power / 11 free CPU / 1 free utility
  // slot, proving the CARGO check fires, not the grid check.
  const fits: ModuleSpec = { cpuUsage: 6, powerUsage: 14, slot: "utility" };

  test("blocks an install when the module is absent from a non-empty hold, and says buy it first", async () => {
    // The #402 scenario: the hold has ore but not the module the plan installs.
    const holdsOre = dockedMiner({ cargo: [{ itemId: "iron_ore", name: "Iron Ore", quantity: 12 }] });
    const { game, calls } = api(holdsOre, fits);
    const r = await executeTick(game, installPlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") throw new Error("unreachable");
    expect(r.reason).toContain("not in your cargo"); // the cargo reason, not the grid's "does not fit"
    expect(r.reason).toContain("buy{id=mining_laser_iii");
    expect(calls.map((c) => c.name)).not.toContain("install_mod"); // the tick was never spent
  });

  test("passes an install when the module IS in the hold and the grid fits -- the guard is not a new blocker", async () => {
    const holdsModule = dockedMiner({ cargo: [{ itemId: "mining_laser_iii", name: "Mining Laser III", quantity: 1 }] });
    const { game, calls } = api(holdsModule, fits);
    expect((await executeTick(game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(calls.map((c) => c.name)).toContain("install_mod");
  });

  test("fails OPEN on an EMPTY hold -- [] is ambiguous (a collapsed shape-surprise or a real empty), never a block", async () => {
    // The load-bearing safety case (reviewer #402, finding 2): StatusSnapshot.cargo
    // parses with `.catch([])`, so a shape-surprise collapses to the SAME [] as a
    // genuinely empty hold. Reading [] as "empty -> block" would deadlock a legal
    // install when the module IS held but the parse degraded. So [] fail-opens and
    // lets the game rule -- matching the sibling `modules` field's UNKNOWN default.
    const emptyHold = dockedMiner({ cargo: [] });
    const { game, calls } = api(emptyHold, fits);
    expect((await executeTick(game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(calls.map((c) => c.name)).toContain("install_mod");
  });

  test("fails OPEN when cargo is UNKNOWN (undefined), without crashing on the absent array", async () => {
    // A distinct branch from [] above: the `cargo &&` guard must short-circuit
    // before `.length`, so a hand-built context with no cargo field never throws.
    const { game, calls } = api(dockedMiner(), fits);
    expect((await executeTick(game, installPlan, { step: 0, iteration: 0 })).kind).toBe("plan_done");
    expect(calls.map((c) => c.name)).toContain("install_mod");
  });
});

// Capability-audit fix (Workflow A, 2026-07-19): switch_ship has no dry_run
// (unlike install_mod) and no client-side fit check to make -- the game's own
// error covers "not stored here" -- so the only thing to prove is that the
// step actually REACHES the game with the right params, unblocked by any
// guard written for a sibling action (e.g. the docked-only guards above).
const switchShipPlan: Plan = { goal: "activate the bigger hull", steps: [{ action: "switch_ship", params: { id: "ship_b2" } }] };

describe("switch_ship dispatch (Workflow A, 2026-07-19)", () => {
  test("a switch_ship step dispatches to the game with the owned ship_id", async () => {
    const { game, calls } = api(dockedMiner());
    const r = await executeTick(game, switchShipPlan, { step: 0, iteration: 0 });
    expect(r.kind).toBe("plan_done");
    expect(calls).toContainEqual({ name: "switch_ship", params: { id: "ship_b2" } });
  });
});

describe("digest ship sections (issue #219)", () => {
  const ctx: PlanContext = {
    persona: "Rockhopper Kess, a pragmatic ore miner.",
    goals: ["reach 25,000cr and a T2 hull"],
    wake: { reason: "plan_done" },
    statusSummary: "credits 17306, fuel 100/130, hull 95/95, cargo 24/100, docked",
    recentEvents: [],
    shipFit: {
      cpuUsed: 2, cpuCapacity: 13, powerUsed: 5, powerCapacity: 26,
      slots: { weapon: 1, defense: 1, utility: 2 },
    },
    fittedModules: [{ typeId: "mining_laser_i", type: "mining", slot: "utility", name: "Mining Laser I" }],
    shipyardText: "Archimedes (listing_id: lst_9f2, 2,200cr, cargo 185)\nExcavation (listing_id: lst_c40, 8,000cr, cargo 250)",
    // Capability-audit fix (Workflow A, 2026-07-19): the fleet the pilot
    // already OWNS, distinct from the for-sale listing above (a listing_id
    // vs. a ship_id -- switch_ship needs the latter).
    ownedShipsText: "Prospect (ship_id: ship_a1, active) at First Step\nExcavator (ship_id: ship_b2) at First Step",
  };

  // The decision "can I afford AND fit the next rung?" is undecidable from a
  // credit balance alone -- it is a question about CPU, power and slots, and
  // before this the planner had never been shown any of the three. Free headroom
  // is rendered explicitly, not left as arithmetic.
  test("shows the grid, the free headroom, and what is fitted", () => {
    const text = buildDigest(ctx);
    expect(text).toContain("CPU 2/13 used (11 FREE)");
    expect(text).toContain("power 5/26 used (21 FREE)");
    expect(text).toContain("utility 1/2");
    expect(text).toContain("mining_laser_i");
  });

  // The reachability half of #216: the pilot must SEE what is purchasable, with
  // the listing_id buy_listed_ship needs. The ids live in the raw listing body,
  // so this also proves the shipyard text is rendered at the LISTING bound (1500
  // chars), not the 200-char chat bound that would clip them.
  test("shows the purchasable hulls with their listing_ids and how to buy one", () => {
    const text = buildDigest(ctx);
    expect(text).toContain("lst_9f2");
    expect(text).toContain("buy_listed_ship");
    // The full upgrade sequence, including how a MODULE is acquired (bought into
    // cargo first -- the step a planner shown only `install_mod` would skip).
    expect(text).toContain("install_mod");
    expect(text).toContain("uninstall_mod");
    expect(text).toMatch(/lands in your CARGO/i);
  });

  test("renders no fit or shipyard section when the harness has neither (never a fabricated zero grid)", () => {
    const text = buildDigest({
      ...ctx, shipFit: undefined, fittedModules: undefined, shipyardText: undefined, ownedShipsText: undefined,
    });
    expect(text).not.toContain("Ship fit");
    expect(text).not.toContain("Ships for sale");
    expect(text).not.toContain("Ships you OWN");
    expect(text).toContain("UPGRADING YOUR SHIP"); // the runbook stays: a pilot in space still needs to know upgrading exists
  });

  // Capability-audit fix (Workflow A, 2026-07-19): the activation half of
  // #216's sibling gap -- a bought hull sat inert because nothing named
  // switch_ship or surfaced the owned-ship_id it needs. Proves both: the
  // section renders the ship_id AND the briefing names switch_ship as the
  // action to plan with it (twice over -- once in ACTION_VOCAB, since it is a
  // registered mutation, and once in the runbook instruction).
  test("shows owned ships with their ship_ids and names switch_ship as the activation action", () => {
    const text = buildDigest(ctx);
    expect(text).toContain("ship_b2");
    expect(text).toContain("switch_ship");
    expect(text).toMatch(/switch_ship\(id:string\)/); // ACTION_VOCAB proves it is plannable
    expect(text).toMatch(/INACTIVE/i); // the bought-hull-sits-inert instruction
  });
});

describe("shipyard gathering (issue #219)", () => {
  const config: AgentConfig = {
    fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
    stallThreshold: 5, subscriptionCooldownMinutes: 60,
  };
  const okPlan: Plan = { goal: "ok", steps: [{ action: "dock", params: {} }] };

  function agentWith(status: StatusSnapshot) {
    const store = new Store(":memory:");
    const planner = new MockPlanner([okPlan]);
    let shipyardCalls = 0;
    let ownedShipsCalls = 0;
    const game: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
      async getShipyard() { shipyardCalls++; return "Archimedes (listing_id: lst_9f2, 2,200cr)"; },
      // Capability-audit fix (Workflow A, 2026-07-19): the owned-fleet twin.
      async getOwnedShips() { ownedShipsCalls++; return "Prospect (ship_id: ship_a1, active)"; },
    };
    const agent = new Agent({ id: "miner", persona: "p", api: game, planner, store, config, now: () => 1 });
    return { agent, planner, shipyardCalls: () => shipyardCalls, ownedShipsCalls: () => ownedShipsCalls };
  }

  // A shipyard belongs to a station. Fetching one in deep space is a wasted call
  // on every replan, forever -- the same gate the available-mission listing uses.
  test("fetches the shipyard listing when docked, and not when in space", async () => {
    const docked = agentWith(dockedMiner());
    await docked.agent.runOnce(); // no_plan wake -> replan
    expect(docked.shipyardCalls()).toBe(1);
    expect(docked.planner.contexts[0]!.shipyardText).toContain("lst_9f2");

    const inSpace = agentWith(dockedMiner({ docked: false }));
    await inSpace.agent.runOnce();
    expect(inSpace.shipyardCalls()).toBe(0);
    expect(inSpace.planner.contexts[0]!.shipyardText).toBeUndefined();
  });

  // Capability-audit fix (Workflow A, 2026-07-19): switch_ship needs "shipyard
  // service" at the current station, same as buy_listed_ship -- so the owned
  // listing is gated on docked identically to the shipyard listing above, even
  // though list_ships itself does not require docking. The #216 class this
  // whole epic exists to close is a registry entry the planner is never SHOWN;
  // this proves the digest actually receives the ship_id, not just that the
  // registry entry exists.
  test("fetches the owned-ships listing when docked, and not when in space", async () => {
    const docked = agentWith(dockedMiner());
    await docked.agent.runOnce();
    expect(docked.ownedShipsCalls()).toBe(1);
    expect(docked.planner.contexts[0]!.ownedShipsText).toContain("ship_a1");

    const inSpace = agentWith(dockedMiner({ docked: false }));
    await inSpace.agent.runOnce();
    expect(inSpace.ownedShipsCalls()).toBe(0);
    expect(inSpace.planner.contexts[0]!.ownedShipsText).toBeUndefined();
  });

  // The fit rides on the status snapshot the agent already fetched this tick --
  // if this ever needs a second query, the "get_ship costs no extra call" claim
  // in actions.ts is false and that registry comment is a lie.
  test("passes the fit through from the tick's own status snapshot, docked or not", async () => {
    const { agent, planner } = agentWith(dockedMiner({ docked: false }));
    await agent.runOnce();
    expect(planner.contexts[0]!.shipFit?.cpuCapacity).toBe(13);
    expect(planner.contexts[0]!.fittedModules?.[0]?.typeId).toBe("mining_laser_i");
  });
});
