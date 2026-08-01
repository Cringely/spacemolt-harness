import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

const baseConfig: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  reflex: { keepFuelAbovePct: 25 },
};

function makeApi(status: StatusSnapshot, opts?: { failRefuel?: boolean }) {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> {
      calls.push(name);
      if (name === "refuel" && opts?.failRefuel) throw new SpacemoltError("command_error", "can't afford fuel");
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

const lowFuelDocked: StatusSnapshot = {
  credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

describe("Agent reflex integration", () => {
  test("docked + low fuel: reflex refuels, suppresses the wake, planner not called", async () => {
    const { api, calls } = makeApi(lowFuelDocked);
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]);
    expect(planner.contexts.length).toBe(0);
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toEqual(["reflex"]);
  });

  test("undocked + low fuel: reflex does not fire, low_fuel wake replans as in Plan 1", async () => {
    const { api, calls } = makeApi({ ...lowFuelDocked, docked: false });
    const store = new Store(":memory:");
    // Seed a running plan before constructing the Agent. Derivation:
    // evaluateWake's branches are checked in a fixed unconditional order
    // (src/agent/wake.ts, evaluateWake body: instruction -> blocked ->
    // planState "none" -> "done" -> notifications -> low_fuel/low_hull ->
    // heartbeat), so a fresh agent with no plan wakes with reason "no_plan"
    // and never reaches the fuel-threshold check. A plan loaded from the
    // store sets planState "running" in the Agent constructor, letting
    // low_fuel be the first branch that fires. Same seeding pattern as
    // Task 4's backoff test.
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual([]); // no refuel attempted, no plan step executed (the wake preempts execution)
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.wake.reason).toBe("low_fuel");
  });

  test("failed reflex ('can't afford') marks itself failed and still lets the wake fire", async () => {
    const { api, calls } = makeApi(lowFuelDocked, { failRefuel: true });
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]); // attempted once, no second mutation this tick
    expect(planner.contexts.length).toBe(1); // wake still fired despite the failed reflex
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toContain("reflex_failed");
  });

  // Closes a coverage gap flagged by independent review (Batch G, Task 8):
  // the two `!reflexSpentTick && this.plan && this.planState === "running"`
  // guards in runOnce() (src/agent/agent.ts) were previously unexercised by
  // any test with an actual running plan present, because the prior "failed
  // reflex" test never seeded one -- `this.plan` was already null there, so
  // that guard was never the thing preventing executeOne. This test uses a
  // fuel level between the reflex threshold (25%) and the wake threshold
  // (fuelPct: 20%) so the reflex fires-and-fails while evaluateWake's
  // low_fuel branch (wake.ts:42-43) does NOT trip -- wake is null, so
  // control reaches the final `if (!reflexSpentTick && ...)` at
  // agent.ts:149. Removing that guard would let the seeded "mine" step
  // execute, which this test would catch via `calls`.
  test("failed reflex with a running plan and no wake: executeOne is skipped, not just plan-absent", async () => {
    const { api, calls } = makeApi({ ...lowFuelDocked, fuel: 22 }, { failRefuel: true });
    const store = new Store(":memory:");
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]); // reflex attempted; "mine" (the plan step) must NOT run
    expect(planner.contexts.length).toBe(0); // no wake reason fired (22% is below reflex's 25% but above wake's 20%)
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toContain("reflex_failed");
  });

  // Issue #543 livelock reproduction. Ground truth (production, 2026-08-01):
  // a plan already carrying "buy fuel_cell" -> "refuel" sat frozen at cursor 0
  // for 4.5+ hours while `reflex_failed{action:"refuel",reason:"station_fuel_empty"}`
  // repeated every tick. wake.ts's planRemediesFuel (Layer 1) already stops the
  // WAKE from replacing this plan, but evaluateReflex fires BEFORE wake is even
  // evaluated and has no such awareness -- it retries the bare station refuel
  // every tick regardless of an in-flight plan, and a failed fire still sets
  // reflexSpentTick, which skips executeOne (agent.ts's `!reflexSpentTick && ...`
  // guards). The plan's own "buy" step -- the only thing that can ever make the
  // reflex succeed -- never gets a turn. toEqual (not toContain) is required
  // here: toContain("buy") would still pass if the reflex fired FIRST and buy
  // ran second, masking the fact that the reflex should not fire at all this
  // tick.
  test("plan already remedies fuel (buy then refuel): reflex defers, the plan's buy step runs", async () => {
    const { api, calls } = makeApi(lowFuelDocked, { failRefuel: true });
    const store = new Store(":memory:");
    store.savePlan("a1", {
      goal: "refuel", steps: [
        { action: "buy", params: { id: "fuel_cell", quantity: 10 } },
        { action: "refuel", params: {} },
      ],
    }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["buy"]); // reflex must NOT fire; the plan's own remedy step gets the tick
    expect(store.recentEvents("a1", 10).map((e) => e.type)).not.toContain("reflex_failed");
  });

  // Review finding (PR #47, round 1): a `refuel` step with `params.target` set
  // is a ship-to-ship TRANSFER OUT (docs/game-reference/upstream/guides/fuel.md:176-186),
  // not a self-remedy -- it drains the pilot's own tank further. Matching on
  // action NAME alone (the pre-fix planRemediesFuel/Hull check) would count
  // this step as "the plan already handles low fuel" and suppress the safety
  // reflex while the transfer keeps draining it. Asserts on the STORE EVENT
  // TYPE, not `calls` (both the reflex and the plan step call the game action
  // named "refuel", so a bare string comparison can't tell them apart): a
  // successful reflex fire always emits type "reflex"; the plan step, if
  // wrongly allowed to run instead, would emit "action" with
  // params.target === "buddy" and no "reflex" event at all.
  test("plan's only 'refuel' step targets another ship: reflex still fires (not a self-remedy)", async () => {
    const { api } = makeApi(lowFuelDocked);
    const store = new Store(":memory:");
    store.savePlan("a1", {
      goal: "help buddy", steps: [{ action: "refuel", params: { target: "buddy" } }],
    }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    const types = store.recentEvents("a1", 10).map((e) => e.type);
    expect(types).toContain("reflex"); // the safety refuel must still fire
    expect(types).not.toContain("action"); // the ship-to-ship step must NOT run this tick
  });

  // Review finding (PR #47, round 1): the single-tick reproduction above only
  // proves "buy" gets the tick -- it never runs the plan far enough to confirm
  // "refuel" (the actual remedy) succeeds once the cursor reaches it. This is
  // the test that settles the open question this PR flagged as separate scope:
  // whether a bare docked `refuel` needs an explicit item_id once cargo cells
  // exist. Per the vendored docked draw order (docs/game-reference/upstream/
  // guides/fuel.md:104-108: faction reserve, then station tank, then cargo
  // cells "if the station is empty or you can't afford station fuel"), this
  // fixture models an EMPTY station tank (the #543 condition) and a bare
  // refuel with no item_id, and it succeeds once a cell exists -- matching the
  // documented fallback rather than working around a gap in the fixture.
  test("plan's own buy-then-refuel resolves low fuel over two ticks (documented cargo-cell fallback, no item_id)", async () => {
    const store = new Store(":memory:");
    store.savePlan("a1", {
      goal: "refuel", steps: [
        { action: "buy", params: { id: "fuel_cell", quantity: 10 } },
        { action: "refuel", params: {} },
      ],
    }, []);

    let fuel = 5;
    const maxFuel = 100;
    let hasCell = false;
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        calls.push(name);
        if (name === "buy") { hasCell = true; return { result: "ok" }; }
        if (name === "refuel") {
          if (!hasCell) throw new SpacemoltError("command_error", "station_fuel_empty");
          fuel = Math.min(maxFuel, fuel + 20); // fuel_cell restores 20 (fuel.md's table)
          hasCell = false;
          return { result: "ok" };
        }
        return { result: "ok" };
      },
      async status() {
        return {
          credits: 0, fuel, maxFuel, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
        };
      },
      async notifications() { return []; },
    };
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    let now = 1;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => now });

    await agent.runOnce(); // tick 1: reflex withheld, plan's "buy" runs
    now = 2;
    await agent.runOnce(); // tick 2: reflex withheld (refuel still ahead of cursor), plan's "refuel" runs

    expect(calls).toEqual(["buy", "refuel"]); // reflex never fired across either tick
    expect(fuel).toBe(25); // the plan's own remedy actually resolved the vital
    expect(store.recentEvents("a1", 20).map((e) => e.type)).not.toContain("reflex_failed");
  });

  test("no reflex configured: identical to Plan-1 behavior, no reflex events", async () => {
    const { api } = makeApi(lowFuelDocked);
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const configNoReflex: AgentConfig = { ...baseConfig, reflex: undefined };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: configNoReflex, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(1);
    expect(store.recentEvents("a1", 10).map((e) => e.type)).not.toContain("reflex");
  });

  // Issue #672 (the #543 livelock in a new costume). Ground truth (production,
  // 2026-08-01): `miner` sat docked at Market Prime, fuel 19/130, with a plan
  // whose remaining steps were pure travel-and-dock (no refuel step -- the
  // destination hadn't been reached yet). planRemediesFuel didn't recognize
  // that shape, so the reflex fired every tick, failed every tick on the
  // station's genuinely empty tank (`station_fuel_empty`), and each failure
  // spent the tick -- 30 reflex_failed in 5 minutes, the travel step never ran.
  //
  // Part 1: the per-station give-up. No plan is seeded here on purpose (a
  // running "mine" plan is used instead of none, so the give-up is proven in
  // isolation from planRemediesFuel -- a mine step is not a fuel remedy by
  // either the old or the widened predicate). Tick 1 reproduces the terminal
  // failure at the station; tick 2 proves the SAME doomed call is withheld,
  // not retried, at that exact station.
  test("terminal reflex failure at a station: does not retry there next tick (#672)", async () => {
    const dockedStation: StatusSnapshot = { ...lowFuelDocked, dockedAt: "market_prime_station" };
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> {
        calls.push(name);
        if (name === "refuel") throw new SpacemoltError("command_error", "station_fuel_empty");
        return { result: "ok" };
      },
      async status() { return dockedStation; },
      async notifications() { return []; },
    };
    const store = new Store(":memory:");
    store.savePlan("a1", { goal: "mine ore", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const planner = new MockPlanner([
      { goal: "p1", steps: [{ action: "undock", params: {} }] },
      { goal: "p2", steps: [{ action: "undock", params: {} }] },
    ]);
    let now = 1;
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => now });

    await agent.runOnce(); // tick 1: reflex fires, fails terminal at this station
    expect(calls).toEqual(["refuel"]);
    expect(store.recentEvents("a1", 20).filter((e) => e.type === "reflex_failed").length).toBe(1);

    now = 2;
    calls.length = 0;
    await agent.runOnce(); // tick 2: same station, still below threshold
    expect(calls).toEqual([]); // give-up withheld the reflex: no second doomed refuel attempt
    expect(store.recentEvents("a1", 20).filter((e) => e.type === "reflex_failed").length).toBe(1); // no new terminal failure recorded
  });

  // Part 2: the widened remedy predicate. Reproduces the production plan
  // shape directly (travel + dock, no refuel step) and proves the reflex is
  // withheld so the plan's own relocation step gets the tick -- "jump" stands
  // in for the production's travel_to (both are MOVEMENT_ACTIONS; jump avoids
  // mocking find_route). failRefuel:true means an unwithheld reflex would
  // show up unmistakably in `calls`.
  test("plan travels toward fuel (jump + dock, no refuel step yet): reflex defers to the plan (#672)", async () => {
    const { api, calls } = makeApi(lowFuelDocked, { failRefuel: true });
    const store = new Store(":memory:");
    store.savePlan("a1", {
      goal: "Leave Market Prime and reach Haven's Grand Exchange Station to refuel if fuel is available.",
      steps: [
        { action: "jump", params: { id: "haven" } },
        { action: "dock", params: {} },
      ],
    }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["jump"]); // reflex must NOT fire; the plan's own relocation step gets the tick
    expect(store.recentEvents("a1", 10).map((e) => e.type)).not.toContain("reflex_failed");
  });

  // Negative case for the widened predicate (issue #526 recreation check): a
  // plan that travels but ALSO mines is not pure relocation, so it must NOT
  // suppress the safety reflex -- exactly the shape #526 warns about (a plan
  // that keeps draining a resource while docked/low fuel goes unprotected).
  test("plan travels but also mines (mixed plan): reflex still fires, not a remedy (#672, #526 guard)", async () => {
    const { api, calls } = makeApi(lowFuelDocked, { failRefuel: true });
    const store = new Store(":memory:");
    store.savePlan("a1", {
      goal: "reroute to a richer belt",
      steps: [
        { action: "jump", params: { id: "belt-system" } },
        { action: "mine", params: {} },
      ],
    }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]); // reflex still fires: a mine step ahead disqualifies the plan
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toContain("reflex_failed");
  });
});
