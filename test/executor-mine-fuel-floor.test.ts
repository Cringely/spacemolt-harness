import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import type { GameApi, StatusSnapshot, FittedModule } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Mine fuel-floor guard (issue #526, live 2026-07-25). The incident: the
// persona's own "keep fuel above 25%" line was a request to the model, never
// an enforced constraint, and the pilot mined to 2/130 (1.5%) and stranded --
// six hours re-broadcasting distress_signal into an empty system. This guard
// (executor.ts, right before the mining-equipment guard) refuses a `mine`
// step outright once fuel reads urgent by the SAME check evaluateReflex uses
// for the docked auto-refuel (reflex.ts's shared `fuelUrgent`, issue #670).
//
// The trap this file exists to avoid (task-reviewer finding on a sibling PR
// today): a guard whose trigger condition is structurally impossible for the
// real ship passes a full green suite and is still dead code. The fixture
// below is the PRODUCTION MINER's actual state -- undocked, a fitted mining
// laser occupying the utility slot, a partial cargo hold -- not an empty or
// stripped-down ship. Every "blocked" assertion below fires against that
// real state, not a synthetic one the guard could never see live.

const miningLaser: FittedModule = { typeId: "mining_laser_iv", type: "mining", miningPower: 100, slot: "utility" };

// The production miner: undocked, laser fitted, cargo partway full -- the
// exact shape a live mining loop holds between deposits.
function minerStatus(overrides: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    credits: 500, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 30, cargoCapacity: 50, docked: false, inTransit: false,
    modules: [miningLaser], ...overrides,
  };
}

function stubApi(status: StatusSnapshot) {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

const minePlan: Plan = { goal: "mine", steps: [{ action: "mine", params: {}, repeat: 5 }] };

describe("mine fuel-floor guard (#526)", () => {
  test("blocks the PRODUCTION MINER (laser fitted, cargo partial) when jump-aware urgency fires", async () => {
    // 19/130 fuel, 15 fuel/jump measured -> 1 jump of range: urgent by the
    // jump-aware check regardless of the laser being fitted and ready.
    // Killing mutation: deleting the guard's `if` block (or inverting
    // fuelUrgent's result) lets the call through -- calls would read
    // ["mine"] instead of staying empty.
    const { api, calls } = stubApi(minerStatus({ fuel: 19, maxFuel: 130 }));
    const r = await executeTick(
      api, minePlan, { step: 0, iteration: 0 }, undefined, undefined, undefined,
      { keepFuelAboveJumps: 2, keepFuelAbovePct: 25 }, 15,
    );
    expect(r).toEqual({
      kind: "blocked",
      reason: "fuel 19/130 is at or below the configured reserve floor -- mining further risks stranding. " +
        "Refuel now if docked, or travel_to/jump toward a known station with fuel before continuing to mine.",
      resultText: "fuel 19/130 is at or below the configured reserve floor -- mining further risks stranding. " +
        "Refuel now if docked, or travel_to/jump toward a known station with fuel before continuing to mine.",
      guard: true,
      // issue #690: tags this block as strand-relevant fuel evidence -- see
      // executor.ts's StepResult doc comment.
      fuelReserveBlock: true,
    });
    expect(calls.length).toBe(0); // no mine request was made
  });

  test("same fuel level, healthy fuel-per-jump measurement: the SAME production miner mines normally", async () => {
    // #670 parity at the new call site: 19/130 = 14.6%, well under a 25%
    // percent floor, but 1 fuel/jump means 19 jumps of real range -- NOT
    // urgent. Killing mutation: an implementation that used percent-of-tank
    // instead of (or in addition to) the jump measurement would block this,
    // leaving calls empty instead of ["mine"].
    const { api, calls } = stubApi(minerStatus({ fuel: 19, maxFuel: 130 }));
    const r = await executeTick(
      api, minePlan, { step: 0, iteration: 0 }, undefined, undefined, undefined,
      { keepFuelAboveJumps: 2, keepFuelAbovePct: 25 }, 1,
    );
    expect(r).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });
    expect(calls).toEqual(["mine"]);
  });

  test("healthy fuel with no urgency configured: mines normally (negative control)", async () => {
    // Guards against an overly broad guard that fires regardless of state --
    // the sibling-PR failure mode inverted: a guard that ALWAYS blocks passes
    // just as much of a naive suite as one that never fires. Killing
    // mutation: an unconditional block (or one that ignores the configured
    // thresholds) empties `calls` here.
    const { api, calls } = stubApi(minerStatus({ fuel: 80, maxFuel: 100 }));
    const r = await executeTick(
      api, minePlan, { step: 0, iteration: 0 }, undefined, undefined, undefined,
      { keepFuelAbovePct: 25 }, undefined,
    );
    expect(r).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });
    expect(calls).toEqual(["mine"]);
  });

  test("no reserve config and no measurement passed at all: guard stays inert (fail-open, backward compatible)", async () => {
    // Every existing direct caller of executeTick (executor.test.ts,
    // executor-mine-deposit.test.ts) omits these two trailing params
    // entirely. Killing mutation: a hardcoded floor applied independent of
    // the caller-supplied config (e.g. `fuel/maxFuel < 0.25` inline) would
    // block this critically-low ship even with nothing configured.
    const { api, calls } = stubApi(minerStatus({ fuel: 2, maxFuel: 100 }));
    const r = await executeTick(api, minePlan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });
    expect(calls).toEqual(["mine"]);
  });

  test("status fetch fails (preStatus null): fails open, never fabricates a block", async () => {
    // Same best-effort contract as every other guard in this file. Killing
    // mutation: replacing the `preStatus &&` null-check with `??`-style
    // fail-closed defaults (treating an unknown status as automatically
    // urgent) would block this even though nothing about fuel is known.
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
      async status() { throw new Error("status fetch failed"); },
      async notifications() { return []; },
    };
    const r = await executeTick(
      api, minePlan, { step: 0, iteration: 0 }, undefined, undefined, undefined,
      { keepFuelAbovePct: 25 }, undefined,
    );
    expect(r).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 }, resultText: "ok" });
    expect(calls).toEqual(["mine"]);
  });

  test("a non-mine step at the SAME critical fuel level is NOT blocked (must not recreate #672)", async () => {
    // #672 is the sibling failure this guard must not reproduce one layer up:
    // a plan already routing toward fuel must keep running. Scope is `mine`
    // only -- proven here with `dock` rather than `travel_to`/`jump`, whose
    // own macro-expansion (find_route-driven, executor.ts ~1150) needs API
    // surface this fixture doesn't stub and would fail for reasons unrelated
    // to this guard. Killing mutation: widening the guard's
    // `step.action === "mine"` check (e.g. to any MOVEMENT_ACTIONS member, or
    // dropping the action check entirely) would block this too, leaving
    // calls empty instead of ["dock"].
    const dockPlan: Plan = { goal: "go refuel", steps: [{ action: "dock", params: {} }] };
    const { api, calls } = stubApi(minerStatus({ fuel: 2, maxFuel: 100, docked: false }));
    const r = await executeTick(
      api, dockPlan, { step: 0, iteration: 0 }, undefined, undefined, undefined,
      { keepFuelAbovePct: 25 }, undefined,
    );
    expect(r).toEqual({ kind: "plan_done", resultText: "ok" }); // dock ran and finished the (only) step
    expect(calls).toEqual(["dock"]);
  });
});
