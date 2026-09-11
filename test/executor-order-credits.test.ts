import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { clipUntrusted } from "../src/planner/digest";
import { failureTaxonomy } from "../src/server/failures";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { AgentEvent } from "../src/store/store";

// Zero-balance order guard (issue #1030).
//
// The live incident, read from the prod event store 2026-09-11: the scout sat
// at exactly 0 credits from 2026-09-06T22:46Z to 2026-09-08T05:20Z and spent
// 105 ticks on `create_sell_order`, every one refused with
//   "insufficient_credits: Insufficient credits for listing fee (minimum 1
//    credit). 1x Platinum Ore not listed."
// plus 124 more on `create_buy_order` ("Need 4444 credits to escrow (4400 bid
// + 44 sales tax). You have 449."). 229 doomed calls, one cause.
//
// What each test below catches is named on it. What is deliberately NOT here:
// a test that the reason strings are spelled a particular way (prose is tuned
// freely; only the 200-char budget and the remedy's position are contracts),
// and a second copy of the price-default behaviour that executor.test.ts
// already covers.

const BASE: StatusSnapshot = {
  credits: 0, creditsKnown: true, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

function stubApi(status: StatusSnapshot | null = BASE) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      return { result: "ok" };
    },
    async status() {
      if (status === null) throw new Error("status unavailable");
      return status;
    },
    async notifications() { return []; },
  };
  return { api, calls };
}

const plan = (action: string, params: Record<string, unknown>): Plan =>
  ({ goal: "g", steps: [{ action, params }] });

// palladium_ore carries a catalog base_value of 200 (the price default the
// #94/#316 rule fills in when price_each is omitted -- see executor.test.ts).
const PALLADIUM_VALUE = 200;

describe("zero-balance order guard: the refusals", () => {
  // THE INCIDENT. Catches the guard not firing at all, which is the shipped
  // behaviour this issue reports (105/105 doomed calls reached the game).
  // The call-count assertion is the load-bearing half: `blocked` alone would
  // also be satisfied by a guard that refuses only AFTER spending the tick.
  test("create_sell_order at a known 0 balance is refused before the call goes out", async () => {
    const { api, calls } = stubApi();
    const r = await executeTick(api, plan("create_sell_order", { item_id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect(calls.length).toBe(0);
  });

  // Catches the refusal going out untagged, which would land it in
  // failureTaxonomy.brokenCapabilities instead of .prevented -- and the 6h
  // strategy reviewer would then refile this very issue forever (#571/#581).
  // Pinned END TO END through the real aggregator rather than by asserting the
  // boolean on the StepResult: the flag only matters for where the row lands.
  test("the refusal is tagged as ours, so the taxonomy counts it prevented and not a broken capability", async () => {
    const { api } = stubApi();
    const r = await executeTick(api, plan("create_sell_order", { item_id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    const blocked = r as { kind: "blocked"; reason: string; guard?: true };

    const now = Date.now();
    // Same payload agent.ts writes (agent.ts:3333 spreads `guard: true` only
    // when the executor set it), repeated past BROKEN_CAPABILITY_MIN_ATTEMPTS
    // so an untagged row WOULD be reported as a broken capability.
    const events: Array<AgentEvent & { id: number }> = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1, agentId: "scout", ts: now - (6 - i) * 60_000, type: "action",
      payload: {
        action: "create_sell_order", outcome: "blocked", result: blocked.reason,
        ...(blocked.guard ? { guard: true } : {}),
      },
    }));
    const tax = failureTaxonomy("scout", events, now, 72);
    expect(tax.prevented.map((c) => c.count)).toEqual([6]);
    expect(tax.brokenCapabilities).toEqual([]);
    expect(tax.classes).toEqual([]);
  });

  // Catches the buy side being left out -- the shape the #757/#736 review threw
  // out, and the side with 124 live blocks of its own. The bid here is the
  // CATALOG-DEFAULTED price (28 x 200 = 5600 against 100 credits), so this also
  // catches the guard being placed ahead of the price default, where price_each
  // is still undefined and the bid reads as unknown.
  test("create_buy_order whose catalog-priced bid exceeds a known balance is refused before the call", async () => {
    const { api, calls } = stubApi({ ...BASE, credits: 100 });
    const r = await executeTick(api, plan("create_buy_order", { item_id: "palladium_ore", quantity: 28 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("blocked");
    expect((r as { reason: string }).reason).toContain(String(28 * PALLADIUM_VALUE));
    expect(calls.length).toBe(0);
  });
});

describe("zero-balance order guard: what it must NOT refuse", () => {
  // BOUNDARY. Catches `credits <= LISTING_FEE_MIN_CR`, which would refuse the
  // one balance that can actually pay the game's stated minimum fee.
  test("a balance of exactly the fee minimum lets the listing through", async () => {
    const { api, calls } = stubApi({ ...BASE, credits: 1 });
    const r = await executeTick(api, plan("create_sell_order", { item_id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("plan_done");
    expect(calls.length).toBe(1);
  });

  // BOUNDARY, buy side. Catches `credits < bid` written as `<=`: a balance that
  // exactly covers the bid is not provably short (sales tax may still sink it,
  // which is the game's call to make, not ours -- adding tax here would tighten
  // a bound that must stay loose).
  test("a balance exactly equal to the bid lets the buy order through", async () => {
    const { api, calls } = stubApi({ ...BASE, credits: 5600 });
    const r = await executeTick(api, plan("create_buy_order", { item_id: "palladium_ore", quantity: 28 }), { step: 0, iteration: 0 });
    expect(r.kind).toBe("plan_done");
    expect(calls.length).toBe(1);
  });

  // THE FALSE-REFUSAL GUARD, and the reason client.ts now carries creditsKnown
  // at all. `credits` defaults a missing player block to 0, so a guard reading
  // the number alone would refuse every order on a pilot with a real balance
  // whenever one get_status came back malformed.
  //
  // Both halves in ONE test on purpose: the second is the POSITIVE CONTROL. An
  // "it went through" assertion is satisfied by a guard that was deleted
  // outright, so the identical snapshot with the balance KNOWN must refuse, or
  // this test proves nothing.
  test("an unreadable balance lets the order through, while the same snapshot with it known refuses", async () => {
    const unknown = stubApi({ ...BASE, credits: 0, creditsKnown: undefined });
    const rUnknown = await executeTick(unknown.api, plan("create_sell_order", { item_id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    expect(rUnknown.kind).toBe("plan_done");
    expect(unknown.calls.length).toBe(1);

    const known = stubApi({ ...BASE, credits: 0, creditsKnown: true });
    const rKnown = await executeTick(known.api, plan("create_sell_order", { item_id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    expect(rKnown.kind).toBe("blocked");
    expect(known.calls.length).toBe(0);
  });

  // Catches a null snapshot being read as a zero balance. Same positive-control
  // pairing as above, for the same reason.
  test("a failed status read lets the order through, while a readable 0 refuses", async () => {
    const noStatus = stubApi(null);
    const rNull = await executeTick(noStatus.api, plan("create_sell_order", { item_id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    expect(rNull.kind).toBe("plan_done");
    expect(noStatus.calls.length).toBe(1);

    const readable = stubApi();
    const rZero = await executeTick(readable.api, plan("create_sell_order", { item_id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    expect(rZero.kind).toBe("blocked");
    expect(readable.calls.length).toBe(0);
  });

  // Catches an unbounded bid being treated as a bid of NaN (which compares
  // false against everything and would let the call through by accident rather
  // than by decision) or, worse, as 0. A plan step's params are not schema-
  // checked at this seam, so a string quantity really can arrive here.
  // Positive control: the same call with a numeric quantity refuses.
  test("a non-numeric quantity leaves the bid unknown and lets the order through; a numeric one refuses", async () => {
    const loose = stubApi({ ...BASE, credits: 1 });
    const rLoose = await executeTick(loose.api, plan("create_buy_order", { item_id: "palladium_ore", quantity: "28" }), { step: 0, iteration: 0 });
    expect(rLoose.kind).toBe("plan_done");
    expect(loose.calls.length).toBe(1);

    const tight = stubApi({ ...BASE, credits: 1 });
    const rTight = await executeTick(tight.api, plan("create_buy_order", { item_id: "palladium_ore", quantity: 28 }), { step: 0, iteration: 0 });
    expect(rTight.kind).toBe("blocked");
    expect(tight.calls.length).toBe(0);
  });

  // Catches the guard widening past the two order actions. `sell` is the very
  // remedy the sell-side refusal names, and it costs no credits at all
  // (markets.md:18) -- refusing it at 0 credits would strand the pilot with the
  // one action that could still earn it something.
  test("sell at a known 0 balance still reaches the game", async () => {
    const { api, calls } = stubApi();
    await executeTick(api, plan("sell", { id: "palladium_ore", quantity: 1 }), { step: 0, iteration: 0 });
    // The call itself is the assertion. A sell against this stub still blocks
    // afterwards -- the #SM-9 phantom-sell effect check sees cargo unchanged --
    // and that is a different guard entirely; what this pins is that the credit
    // guard never stopped the submission.
    expect(calls).toEqual([{ name: "sell", params: { id: "palladium_ore", quantity: 1 } }]);
  });
});

describe("zero-balance order guard: the refusals survive the digest clip", () => {
  // Issue #788 and the #757/#736 round-2 finding, both live: a reason of
  // 250-295 chars loses its remedy half, because digest.ts clips a blocked
  // wake's detail before the planner ever reads it. Measured THROUGH the
  // digest's own clip function, never against a local copy of the number.
  const cases: Array<{ name: string; action: string; params: Record<string, unknown>; status: StatusSnapshot; remedy: string }> = [
    {
      name: "create_sell_order",
      action: "create_sell_order", params: { item_id: "palladium_ore", quantity: 1 },
      status: BASE, remedy: "Use sell{id,quantity}",
    },
    {
      name: "create_buy_order",
      action: "create_buy_order", params: { item_id: "palladium_ore", quantity: 28 },
      status: { ...BASE, credits: 100 }, remedy: "Lower quantity or price_each",
    },
  ];

  for (const c of cases) {
    test(`${c.name}'s refusal keeps its remedy inside the digest clip`, async () => {
      const { api } = stubApi(c.status);
      const r = await executeTick(api, plan(c.action, c.params), { step: 0, iteration: 0 });
      expect(r.kind).toBe("blocked");
      const reason = (r as { reason: string }).reason;
      // The clip appends an ellipsis when it truncates, so an unclipped reason
      // is one the clip returns unchanged. Nothing in the string is restated
      // here; the producer is the only source for both halves.
      expect(clipUntrusted(reason)).toBe(reason);
      expect(reason).toContain(c.remedy);
      // Remedy FIRST, not merely present: a reason that opens with the
      // diagnosis and ends with the fix is what got cut twice before.
      expect(reason.indexOf(c.remedy)).toBe(0);
    });
  }
});
