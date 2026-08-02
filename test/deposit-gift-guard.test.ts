import { describe, expect, test } from "bun:test";
import { executeTick, GIFT_CREDIT_CEILING } from "../src/agent/executor";
import { getAction } from "../src/registry/actions";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

// Issue #703. The incident: at 18:37Z on 2026-08-02 the corsair was detained by
// the Crimson Pact over a 27cr bounty it held 0 credits to pay, while the miner
// held 199,696. police.md:56 says the detention lifts the moment its credits
// reach the bounty, and storage.md:37 says a credit gift is a `deposit` with
// target=<player name> -- so the harness needed to be able to express one, and
// needed to be unable to express a transfer to anyone else.
const MINER = "Rockhopper Kess";
const CORSAIR = "Corvus Marrek";
const FLEET = [MINER, CORSAIR];

const depositParams = getAction("deposit").params;

function stubApi() {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const status: StatusSnapshot = {
    credits: 199_696, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
  };
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

// executeTick's gift-guard arguments are positional and trail the list, so the
// undefineds here are learnedSparse / buyOrderAlreadyOpen / fuelReserveConfig /
// fuelPerJump / itemUnavailableAtStation -- none of which a deposit reads.
function runDeposit(params: Plan["steps"][number]["params"], fleet?: readonly string[]) {
  const { api, calls } = stubApi();
  const plan = { goal: "rescue the corsair", steps: [{ action: "deposit", params }] } as Plan;
  return executeTick(api, plan, { step: 0, iteration: 0 }, undefined, undefined, undefined,
    undefined, undefined, undefined, fleet).then((r) => ({ r, calls }));
}

describe("deposit registry form (issue #703)", () => {
  // Breakage caught: the pre-#703 schema (item_id + quantity, .strict()) could
  // not express a credit gift at all -- the corsair stays detained because the
  // plan never validates. Asserting on `success` alone would pass against a
  // schema that dropped .strict() entirely, so the parsed OUTPUT is checked
  // too: every gift field must survive the parse, not just be tolerated.
  test("gift form validates and carries target, credits, message through", () => {
    const parsed = depositParams.safeParse({ target: CORSAIR, credits: 27, message: "bounty" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ target: CORSAIR, credits: 27, message: "bounty" });
  });

  // Breakage caught: widening the entry for gifts silently breaking the item
  // form every craft/recycle depends on ("Materials are escrowed from your
  // station storage at enqueue (NOT cargo)", #221). toEqual on the parsed data
  // rather than `success`: a refinement that stripped item_id would still
  // report success, and toEqual's blind spot for undefined-valued keys does not
  // apply here because both expected keys hold real values.
  test("item form still validates unchanged", () => {
    const parsed = depositParams.safeParse({ item_id: "iron_ore", quantity: 5 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ item_id: "iron_ore", quantity: 5 });
  });

  // Breakage caught: a call carrying both forms reaching the game, whose
  // behavior on that shape we have never captured (the spec scopes `credits` to
  // target=<player>). The message is asserted, not just the failure: five
  // independently-optional fields would also fail this input for the wrong
  // reason -- .strict() unrecognized-key noise instead of the exclusivity rule
  // the planner has to learn from.
  test("a call carrying BOTH forms is rejected as mutually exclusive", () => {
    const parsed = depositParams.safeParse({
      item_id: "iron_ore", quantity: 5, target: MINER, credits: 100,
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]!.message)
      .toContain("EITHER the item form");
  });

  // Breakage caught: a half-filled form spending a tick on a guaranteed error.
  // Each case exercises a different branch of the refinement, so a regression
  // that deletes one is not masked by the others passing.
  test("incomplete forms are rejected", () => {
    expect(depositParams.safeParse({}).success).toBe(false);                          // neither form
    expect(depositParams.safeParse({ item_id: "iron_ore" }).success).toBe(false);      // item, no quantity
    expect(depositParams.safeParse({ target: MINER }).success).toBe(false);            // gift, no credits
    expect(depositParams.safeParse({ credits: 27 }).success).toBe(false);              // gift, no target
  });
});

describe("executor fleet credit-gift guard (issue #703)", () => {
  // Breakage caught: the whole reason the guard exists. A planner that reads
  // arbitrary text -- the emergency channel, or a game error carrying a
  // filled-in template as #681's create_buy_order error did -- names an
  // outsider and the credits leave for good. `calls` is asserted EMPTY as well
  // as the verdict: a guard that returned a blocked result AFTER sending the
  // action would satisfy the verdict assertion alone.
  test("refuses a gift to a target outside the fleet roster", async () => {
    const { r, calls } = await runDeposit({ target: "Helpful Stranger", credits: 27 }, FLEET);
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.guard).toBe(true);
    expect(r.kind === "blocked" && r.reason).toContain("not a pilot in this harness's fleet");
    expect(calls).toEqual([]);
  });

  // Breakage caught: an unbounded transfer to a real fleet-mate. The roster
  // check answers WHO and cannot answer HOW MUCH, so without a ceiling one
  // reasonable-looking step moves the entire 199,696cr wallet in a single tick.
  test("refuses a gift over the per-call credit ceiling", async () => {
    const { r, calls } = await runDeposit(
      { target: MINER, credits: GIFT_CREDIT_CEILING + 1 }, FLEET,
    );
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.guard).toBe(true);
    expect(r.kind === "blocked" && r.reason).toContain("per-gift ceiling");
    expect(calls).toEqual([]);
  });

  // Breakage caught: a guard that refuses everything. Both refusal tests above
  // pass against a blanket `deposit -> blocked`, and so does a guard that keys
  // on step.action alone and takes item deposits down with it -- which would
  // break the craft/recycle chain fleet-wide. The gift here sits EXACTLY at the
  // ceiling, so a `>=` comparison typo is caught here rather than shipping as a
  // silently one-credit-tighter bound.
  test("lets an at-ceiling gift to a fleet-mate and an item deposit through", async () => {
    const atCeiling = await runDeposit({ target: CORSAIR, credits: GIFT_CREDIT_CEILING }, FLEET);
    expect(atCeiling.r.kind).toBe("plan_done");
    expect(atCeiling.calls).toEqual([
      { name: "deposit", params: { target: CORSAIR, credits: GIFT_CREDIT_CEILING } },
    ]);

    const item = await runDeposit({ item_id: "iron_ore", quantity: 5 }, FLEET);
    expect(item.r.kind).toBe("plan_done");
    expect(item.calls).toEqual([{ name: "deposit", params: { item_id: "iron_ore", quantity: 5 } }]);
  });

  // Breakage caught: the fail-OPEN reflex every other guard in executor.ts
  // follows ("absence is never a verdict") applied here, where it inverts --
  // an unwired roster would mean every gift target is unverifiable and every
  // gift is sent. The verified-fleet name is used deliberately: with no roster
  // even a genuine fleet-mate is refused, which is the point.
  test("fails CLOSED when no roster is wired", async () => {
    const absent = await runDeposit({ target: MINER, credits: 27 }, undefined);
    expect(absent.r.kind).toBe("blocked");
    expect(absent.calls).toEqual([]);

    const empty = await runDeposit({ target: MINER, credits: 27 }, []);
    expect(empty.r.kind).toBe("blocked");
    expect(empty.r.kind === "blocked" && empty.r.reason).toContain("No fleet roster is configured");
    expect(empty.calls).toEqual([]);
  });
});
