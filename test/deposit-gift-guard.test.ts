import { afterEach, describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { normalizeGiftTargets, type FleetPilot } from "../src/agent/normalize-plan";
import { clipUntrusted, UNTRUSTED_TEXT_SNIPPET_LEN } from "../src/planner/digest";
import { getAction, GIFT_CREDIT_CEILING } from "../src/registry/actions";
import { SpacemoltMcp } from "../src/client/mcp";
import { McpGameApi } from "../src/client/mcp-game-api";
import { SpacemoltError } from "../src/client/http";
import { startFakeMcpServer, type FakeMcpServer } from "./fake-mcp-server";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import { PlanSchema, type Plan } from "../src/registry/plan";

// Issue #703. The incident: at 18:37Z on 2026-08-02 the corsair was detained by
// the Crimson Pact over a 27cr bounty it held 0 credits to pay, while the miner
// held 199,696. police.md:56 says the detention lifts the moment its credits
// reach the bounty, and storage.md:37 says a credit gift is a `deposit` with
// target=<player name> -- so the harness needed to be able to express one, and
// needed to be unable to express a transfer to anyone else.
const MINER = "Rockhopper Kess";
const CORSAIR = "Corvus Marrek";
const FLEET = [MINER, CORSAIR];

// Issue #788, the production roster shape: agents.yaml carries an `id` (what
// the operator and the planner call a pilot) beside the `username` (what the
// game and the guard's accept set speak). The live refusal --
// "'corsair' is not a pilot in this harness's fleet ... Fleet pilots:
// Rockhopper Kess, Vela Farsight, Corvus Marrek." -- came from the planner
// writing the id. Three pilots, not two, because the truncation test below
// measures against the fleet that actually flew.
const SCOUT = "Vela Farsight";
const ROSTER: FleetPilot[] = [
  { id: "miner", username: MINER },
  { id: "scout", username: SCOUT },
  { id: "corsair", username: CORSAIR },
];
const ROSTER_USERNAMES = ROSTER.map((p) => p.username);

/** A one-step gift plan, the shape Agent.replan hands the normalizer. */
const giftPlan = (params: Record<string, unknown>) =>
  ({ goal: "rescue the corsair", steps: [{ action: "deposit", params }] }) as Plan;

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

  // Breakage caught: an unbounded transfer to a real fleet-mate. The roster
  // check answers WHO and cannot answer HOW MUCH, so without a ceiling one
  // reasonable-looking step moves the entire 199,696cr wallet in a single tick.
  // The bound sits on the SCHEMA (PR #82 review) rather than in executeTick
  // because both drivers parse the schema and only one runs executeTick.
  // BOTH directions are asserted: over-ceiling fails AND at-ceiling passes, so
  // a `.max(GIFT_CREDIT_CEILING - 1)` or an off-by-one `.lt` cannot pass by
  // failing everything. Asserting `success:false` alone would.
  test("the schema refuses a gift over the per-call credit ceiling", () => {
    const over = depositParams.safeParse({ target: MINER, credits: GIFT_CREDIT_CEILING + 1 });
    expect(over.success).toBe(false);
    const atCeiling = depositParams.safeParse({ target: MINER, credits: GIFT_CREDIT_CEILING });
    expect(atCeiling.success).toBe(true);
  });
});

// The point of siting the ceiling in the schema (PR #82 review). mcp-game-api.ts
// states that the registry allowlist plus params validation IS the improv
// injection defense -- and #703 put arbitrary-recipient credit transfers inside
// that curated set. This driver never calls executeTick, so a ceiling checked
// there would leave the claim false for the one capability that moves credits.
describe("the improv/MCP driver is bound by the same ceiling (issue #703)", () => {
  let server: FakeMcpServer;
  afterEach(() => server?.stop());

  // Breakage caught: the ceiling drifting back into executeTick (or into any
  // other plan-then-execute-only site), which would re-open the MCP path
  // silently -- every offline test of the guard would still pass. The wire-call
  // count is asserted as well as the throw: a rejection AFTER the transport call
  // has already gifted the credits satisfies the throw assertion alone.
  test("an over-ceiling gift throws invalid_params before any transport call", async () => {
    server = startFakeMcpServer();
    const mcp = new SpacemoltMcp(server.url);
    await mcp.handshake();
    await mcp.login("Miner", "pw");
    const api = new McpGameApi(mcp);
    const callsBefore = server.calls.length;

    const err: unknown = await api
      .action("deposit", { target: MINER, credits: GIFT_CREDIT_CEILING + 1 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(SpacemoltError);
    expect((err as SpacemoltError).code).toBe("invalid_params");
    expect(server.calls.length).toBe(callsBefore);
  });
});

// Plan admission (PR #82 review). `repeat` and `until` are siblings of `params`
// on a plan step, so no params refinement can see them: the executor re-enters
// the same step per iteration, which turns a per-call ceiling into a per-call
// ceiling times 50, and `until` never terminates for a gift because both
// completion conditions read cargo.
describe("plan admission refuses a looping gift (issue #703)", () => {
  const gift = { target: CORSAIR, credits: 27 };
  const plan = (step: Record<string, unknown>) =>
    PlanSchema.safeParse({ goal: "rescue the corsair", steps: [step] });

  // Breakage caught: one plan step expressing up to 50 gifts through a bound
  // written for one. The MESSAGE is asserted, not just the failure: a plan can
  // fail admission for a dozen unrelated reasons (a bad param, an unknown
  // action), so `success:false` alone would pass against a schema that rejected
  // this step for the wrong reason and left the loop reachable by a valid one.
  test("a gift step carrying repeat is rejected", () => {
    const r = plan({ action: "deposit", params: gift, repeat: 50 });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toContain("one-shot action");
  });

  // Breakage caught: the worse half. repeat is bounded at 50; `until` is not
  // bounded at all for a gift, because cargo_full/cargo_empty can never trip on
  // a credit transfer, so the step re-gifts every tick until the game refuses.
  test("a gift step carrying until is rejected", () => {
    const r = plan({ action: "deposit", params: gift, until: "cargo_full" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]!.message).toContain("one-shot action");
  });

  // Breakage caught: a rule keyed on the ACTION instead of the gift FORM, which
  // would refuse repeated item deposits and break the craft/recycle chain
  // (#221, "Materials are escrowed from your station storage at enqueue"). Also
  // catches a rule that refuses every gift: the lone gift step must still be
  // admitted, or the rescue this whole capability exists for cannot be planned.
  test("a lone gift step, and a repeated ITEM deposit, are both admitted", () => {
    expect(plan({ action: "deposit", params: gift }).success).toBe(true);
    expect(plan({
      action: "deposit", params: { item_id: "iron_ore", quantity: 5 }, repeat: 3,
    }).success).toBe(true);
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

  // Breakage caught: a guard that refuses everything. The refusal test above
  // passes against a blanket `deposit -> blocked`, and so does a guard that keys
  // on step.action alone and takes item deposits down with it -- which would
  // break the craft/recycle chain fleet-wide. The gift here sits EXACTLY at the
  // registry ceiling, so this also pins that the executor half stays silent
  // about amounts: a ceiling re-added here would redden this test.
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

// Issue #788. Live from the prod event store: "deposit gift refused: 'corsair'
// is not a pilot in this harness's fleet ... Fleet pilots: Rockhopper Kess,
// Vela Farsight, Corvus Marrek." The planner addressed a fleet-mate by its
// agents.yaml id; the guard's accept set is in-game usernames. Every attempt
// was refused at the cost of one replan, which blocked the #703 rescue path
// while two pilots sat at 1cr and 4cr.
//
// The two halves are exercised TOGETHER here on purpose -- the normalizer's
// output and the guard's accept set have to agree, and each tested alone would
// pass while they disagreed.
describe("gift target resolution at plan admission (issue #788)", () => {
  // Breakage caught: the #788 failure itself. The resolved USERNAME is asserted
  // on `calls[0]` -- the value actually sent to the game -- not just on the
  // verdict: `r.kind === "plan_done"` alone cannot fail when the normalizer
  // resolves to the WRONG fleet-mate (every roster username passes the guard),
  // and it cannot tell a working normalizer from a weakened guard either. The
  // REAL exported normalizer runs here; an inline lookup would let a broken
  // normalizer pass a test that duplicates its own bug.
  test("an id-shaped target resolves, and the RESOLVED username is what reaches the game", async () => {
    const { plan, rewrites } = normalizeGiftTargets(giftPlan({ target: "corsair", credits: 5 }), ROSTER);
    expect(rewrites).toEqual([
      { step: 0, action: "deposit", param: "target", from: "corsair", to: CORSAIR },
    ]);

    const { r, calls } = await runDeposit(plan.steps[0]!.params, ROSTER_USERNAMES);
    expect(r.kind).toBe("plan_done");
    expect(calls).toEqual([{ name: "deposit", params: { target: CORSAIR, credits: 5 } }]);
  });

  // Breakage caught: the only regression class in this change that MOVES CREDITS
  // THAT WOULD NOT OTHERWISE MOVE -- a normalizer that falls back to the first
  // roster entry (or fuzzy-matches) when nothing matches. "Helpful Stranger" is
  // the chat-sourced case the guard was written for. Asserting only that the
  // reason says "not a pilot" would pass a normalizer that rewrote the target to
  // a fleet-mate and then blocked for some unrelated reason, so the ORIGINAL
  // string is pinned in the reason AND `calls` is asserted empty.
  test("an off-roster target passes through untouched and is still refused", async () => {
    const { plan, rewrites } = normalizeGiftTargets(
      giftPlan({ target: "Helpful Stranger", credits: 27 }), ROSTER,
    );
    expect(rewrites).toEqual([]);

    const { r, calls } = await runDeposit(plan.steps[0]!.params, ROSTER_USERNAMES);
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("'Helpful Stranger'");
    expect(calls).toEqual([]);
  });

  // Breakage caught: the refusal message's roster never reaching the planner.
  // The guard's own comment called the refusal a correction channel, but the
  // message ran 229 chars against the digest's 200-char clip on a blocked wake's
  // detail, so the planner only ever saw "...Fleet pilots: Rockhopper Kess, " --
  // the two pilots it needed to name were cut off. Four existing guard tests
  // could not catch this: EVERY substring matcher applied to the RAW reason is
  // length-blind, which is exactly how the defect survived them. So the reason
  // goes through the real clipUntrusted before matching, and the constant is
  // IMPORTED from digest.ts rather than hardcoded -- src keeps no
  // executor->digest import edge (that would cycle), so the coupling lives here.
  test("the refusal message's roster survives the digest's prompt clip", async () => {
    // The registry's `target` is unbounded while config.ts bounds a username at
    // .max(24), so the longest string that could still plausibly be a username
    // is the worst case for the roster's position in the message.
    const maxLenTarget = "Quintessa Rockhopper-III";
    expect(maxLenTarget.length).toBe(24);

    const { r } = await runDeposit({ target: maxLenTarget, credits: 27 }, ROSTER_USERNAMES);
    expect(r.kind).toBe("blocked");
    const shown = clipUntrusted(r.kind === "blocked" ? r.reason : "");
    expect(shown.length).toBeLessThanOrEqual(UNTRUSTED_TEXT_SNIPPET_LEN + 1); // +1: the clip's ellipsis
    for (const pilot of ROSTER_USERNAMES) expect(shown).toContain(pilot);
    expect(shown).toContain(`${CORSAIR}.`); // the LAST name, the one that used to be cut
  });
});
