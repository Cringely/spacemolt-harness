import { afterEach, describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
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

// Two rosters that are legal but hostile, because nothing in config.ts forbids
// either. agents.yaml ids are operator-chosen and in-game usernames are
// player-chosen, drawn from two namespaces that never check each other -- so one
// pilot's id CAN be another pilot's username, and the agents array carries no
// uniqueness refine so two pilots CAN share an id. Both shapes are the ones
// where a plausible simplification of normalizeGiftTargets stops being merely
// wrong and starts moving credits to the wrong pilot.
const COLLIDING_ROSTER: FleetPilot[] = [
  { id: CORSAIR, username: MINER }, // this pilot's ID is the corsair's USERNAME
  { id: "corsair", username: CORSAIR },
];
const DUPLICATE_ID_ROSTER: FleetPilot[] = [
  { id: "corsair", username: CORSAIR },
  { id: "corsair", username: SCOUT },
];

// A target long enough to shove the roster out of the digest's 200-char window
// if the executor's 24-char echo clip were removed. A chat-sourced blob rather
// than "x".repeat(300): the planner reads untrusted text (#681's
// create_buy_order template arrived exactly that way), and a whole sentence
// pasted into `target` is the shape that actually turns up in the event store.
const LONG_TARGET =
  "the pilot everyone in the station bar keeps calling the corsair, though I " +
  "never did catch which of the three ships parked on pad four is actually " +
  "theirs, so please just send the credits to whoever that turns out to be";

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

/**
 * The four assertions that pin "the WHOLE roster reaches the planner". Shared by
 * the two target lengths that have to satisfy it -- a maximum-length username
 * and an adversarially long blob -- so neither case can drift into asserting
 * something weaker than the other. Returns the clipped text for case-specific
 * assertions on top.
 */
async function expectRosterSurvivesClip(target: string) {
  const { r } = await runDeposit({ target, credits: 27 }, ROSTER_USERNAMES);
  expect(r.kind).toBe("blocked");
  const shown = clipUntrusted(r.kind === "blocked" ? r.reason : "");
  expect(shown.length).toBeLessThanOrEqual(UNTRUSTED_TEXT_SNIPPET_LEN + 1); // +1: the clip's ellipsis
  for (const pilot of ROSTER_USERNAMES) expect(shown).toContain(pilot);
  expect(shown).toContain(`${CORSAIR}.`); // the LAST name, the one that used to be cut
  return shown;
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
    //
    // This case does NOT reach the executor's 24-char clip and is not meant to:
    // the guard's ternary is `length > 24`, so at exactly 24 it takes the ELSE
    // branch and echoes the target whole. That is the correct side to pin here
    // -- a real username must survive intact, never arrive at the planner with
    // an ellipsis on it. The clip branch is a separate case, below.
    const maxLenTarget = "Quintessa Rockhopper-III";
    expect(maxLenTarget.length).toBe(24);

    const shown = await expectRosterSurvivesClip(maxLenTarget);
    expect(shown).toContain(maxLenTarget); // echoed whole, no ellipsis
  });

  // Breakage caught: deleting the executor's 24-char clip on the echoed target
  // (`const shown = gift.target;`), which until this test was free -- the whole
  // suite stayed at 1805 pass / 0 fail without it. `target` is planner-authored
  // and unbounded by the registry, so it is the one input that can shove the
  // roster back out of the digest's 200-char window and restore the exact defect
  // this PR repairs. The case above cannot catch it: 24 is the boundary where
  // the ternary takes the else branch, so it pins the unclipped side. Even a
  // 25-char target would not catch it, because a 25-char echo still leaves the
  // roster ending near 150. It takes an adversarial length to separate them.
  //
  // A chat-sourced blob rather than "x".repeat(300): the planner reads untrusted
  // text (#681's create_buy_order template arrived that way), and a whole
  // sentence pasted into `target` is the shape that actually shows up.
  test("an adversarially long target cannot push the roster out of the clip", async () => {
    expect(LONG_TARGET.length).toBeGreaterThan(200);

    const shown = await expectRosterSurvivesClip(LONG_TARGET);
    expect(shown).not.toContain(LONG_TARGET); // the echo was clipped, not passed through
  });

  // Breakage caught: any clause appended to the guard's message. This is the
  // tightest budget in the suite -- THREE characters -- so it reddens on a
  // message edit long before the real fleet is anywhere near the limit, which is
  // what makes it a tripwire rather than a restatement of the code.
  //
  // Every figure below was measured by running the real guard and taking
  // `reason.indexOf(lastPilot) + lastPilot.length` against the digest's 200-char
  // window, not computed from a model of the message. An arithmetic model of
  // this message has now been wrong twice, in both directions.
  //
  //   three production usernames, clipped echo -> roster ends 149, 51 to spare
  //   three MAXIMUM-length usernames           -> roster ends 180, 20 to spare
  //   four maximum-length, short target        -> roster ends 197,  3 to spare
  //   four maximum-length, long target         -> roster ends 206,  6 OVER
  //
  // The deployed fleet is the first row, which is where decisions.md's "~50
  // characters spare" comes from. The worst case that still fits is the third.
  //
  // The fourth row is the ceiling, recorded here and deliberately NOT asserted.
  // At four maximum-length pilots the guarantee does not simply end, it becomes
  // conditional on the target -- and `target` is planner-authored, so the roster
  // would arrive whenever the planner is behaving and vanish in exactly the
  // situations the correction channel exists for. That is worth knowing and it
  // is not worth a test: an assertion on the overflow fires when someone SHORTENS
  // the message (drop 8 characters of fixed text and 206 falls inside the
  // window), so it would be a red for a strict improvement.
  //
  // What this test does NOT provide: nothing mechanical connects it to the real
  // fleet. `agents.yaml` is gitignored (.gitignore:23) and absent from the
  // worktree, and the roster below is hardcoded, so adding a fourth pilot leaves
  // this test green. When a fourth pilot joins, the message has to stop echoing
  // the roster whole -- elide to the nearest few, or clip the roster the way the
  // target is clipped -- and the only thing that will prompt that is a person
  // reading this. Also recorded in the seam manifest under seam 2.
  test("the guard message keeps three characters of slack at four pilots", async () => {
    const fourMaxLen = [
      "Quintessa Rockhopper-III", "Bartholomew Sternwind-Jr",
      "Persephone Vandergraff-X", "Maximilian Thornebury-IV",
    ];
    for (const u of fourMaxLen) expect(u.length).toBe(24);

    const { r } = await runDeposit({ target: "Helpful Stranger", credits: 27 }, fourMaxLen);
    expect(r.kind).toBe("blocked");
    const shown = clipUntrusted(r.kind === "blocked" ? r.reason : "");
    expect(shown).toContain(fourMaxLen[3]!); // the last pilot, at 197 of 200
  });

  // Breakage caught: collapsing the normalizer's two ORDERED lookups into the
  // one-pass form `fleet.find((p) => p.id === raw || p.username === raw)`, which
  // is correct on every roster that has no collision and pays the WRONG pilot on
  // one that does. Both names here are real fleet usernames, so the guard cannot
  // discriminate -- it accepts either -- and `r.kind` would read plan_done under
  // the bug. `rewrites` and the target ON THE WIRE are what separate them: a
  // correct target must leave untouched, never round-trip through an id lookup.
  test("a target that is already a username is never resolved to someone else", async () => {
    const { plan, rewrites } = normalizeGiftTargets(
      giftPlan({ target: CORSAIR, credits: 27 }), COLLIDING_ROSTER,
    );
    expect(rewrites).toEqual([]);

    const fleet = COLLIDING_ROSTER.map((p) => p.username);
    const { r, calls } = await runDeposit(plan.steps[0]!.params, fleet);
    expect(r.kind).toBe("plan_done");
    expect(calls).toEqual([{ name: "deposit", params: { target: CORSAIR, credits: 27 } }]);
  });

  // Breakage caught: swapping the exactly-one-match filter for `.find()`, which
  // turns an ambiguous id into a coin flip on a transfer nothing reverses. The
  // resolved params are asserted as well as `rewrites`, and the guard verdict as
  // well as the normalizer: under `.find()` the target resolves to whichever
  // entry was declared first, and a resolved username SATISFIES the guard, so
  // the credits leave. Ambiguity has to mean "leave it alone", which lands the
  // step on the fail-closed guard -- the safe direction, at the cost of one
  // replan.
  test("a duplicate id resolves nothing and falls through to the guard", async () => {
    const { plan, rewrites } = normalizeGiftTargets(
      giftPlan({ target: "corsair", credits: 27 }), DUPLICATE_ID_ROSTER,
    );
    expect(rewrites).toEqual([]);
    expect(plan.steps[0]!.params).toEqual({ target: "corsair", credits: 27 });

    const fleet = DUPLICATE_ID_ROSTER.map((p) => p.username);
    const { r, calls } = await runDeposit(plan.steps[0]!.params, fleet);
    expect(r.kind).toBe("blocked");
    expect(calls).toEqual([]);
  });

  // Breakage caught: widening the guard's accept set to usernames-OR-ids, the
  // one-liner the decision log rejects. This is the normalizer-bypassed path and
  // it is reachable in production, not hypothetical: resolution happens at plan
  // ADMISSION, so a plan persisted before this fix holds the raw id and a
  // restart replays it straight into executeTick with the roster wired. The
  // existing off-roster test cannot cover this -- its target ("Helpful
  // Stranger") is on neither half of the pair, so it stays blocked under exactly
  // the widening that would let an id through. The id used here IS on the
  // roster's id half, which is what makes the two cases different.
  test("a raw agent id reaching the guard unresolved is still refused", async () => {
    const { r, calls } = await runDeposit({ target: "corsair", credits: 27 }, ROSTER_USERNAMES);
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("'corsair'");
    expect(calls).toEqual([]);
  });
});

// Issue #788, the SEAM the three tests above cannot see. They hand executeTick a
// username array directly, so they exercise the normalizer and the guard while
// stubbing out the one hop that connects them: AgentConfig.fleetRoster is a
// {id, username} pair, and Agent's constructor derives the guard's flat accept
// set from it. Nothing in the suite constructed an Agent with a fleetRoster --
// `git grep fleetUsernames origin/main -- test/` returns nothing -- so that
// derivation was untested.
//
// Measured, not asserted: invert that map to `.map((p) => p.id)` and the ONLY
// failures in the whole suite are the two tests in this block. The receipt is
// written that way on purpose. An earlier draft said "1800 pass / 1 fail", and
// it stopped being true inside the very commit that introduced it, because the
// second test below was added in the same change. A receipt phrased as a ratio
// of moving totals rots every time anyone adds a test; one phrased as "these
// tests and nothing outside them" survives. The absolute count when this was
// last run was 1805 pass / 1 skip / 2 fail, useful as a sanity check and not as
// the claim.
//
// Exercised end-to-end for the same reason the #681 round-2 guard is: the defect
// would live in the seam, not in either half.
describe("the roster reaches the guard as usernames, end to end (issue #788)", () => {
  const config: AgentConfig = {
    fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
    stallThreshold: 5, subscriptionCooldownMinutes: 60, fleetRoster: ROSTER,
  };

  // Breakage caught: Agent's constructor mapping fleetRoster to the WRONG half
  // of the pair. Asserting the full `calls` array rather than the plan's params
  // is what discriminates: the normalizer resolves `corsair` to "Corvus Marrek"
  // regardless, so the persisted plan looks correct under either mapping. Only
  // whether the deposit REACHED the game separates them -- with the ids as the
  // accept set, the resolved username is refused by the guard and `calls` is
  // empty. An assertion on r.kind alone would be blind for the same reason the
  // guard is: both halves are internally consistent, just about different sets.
  test("a gift addressed by agent id is delivered to that pilot's username", async () => {
    const { api, calls } = stubApi();
    const store = new Store(":memory:");
    const planner = new MockPlanner([giftPlan({ target: "corsair", credits: 27 })]);
    const agent = new Agent({ id: "miner", persona: "p", api, store, planner, config, now: () => 1 });

    await agent.runOnce(); // no_plan -> replan, which normalizes the gift target
    await agent.runOnce(); // the deposit step executes

    expect(calls).toEqual([{ name: "deposit", params: { target: CORSAIR, credits: 27 } }]);
  });

  // Breakage caught: the derivation widened to `flatMap((p) => [p.username,
  // p.id])` -- the accept-set one-liner the decision log rejects, written at the
  // one site where BOTH halves are in scope. Nothing else in the suite can see
  // it. The delivery test above passes under it (the normalizer resolves the id
  // anyway, so the wire value is right for the wrong reason), and the guard-only
  // test in the block above never runs agent.ts at all. It takes an id the
  // normalizer REFUSES to resolve -- the duplicate -- to put a raw id in front
  // of the widened set, and then the harness sends "corsair" to a game that
  // resolves targets against real player names (openapi-v2.json:116273), which
  // is a stranger's wallet, not a fleet-mate's.
  test("a widened accept set cannot deliver an unresolvable id to the game", async () => {
    const { api, calls } = stubApi();
    const store = new Store(":memory:");
    const planner = new MockPlanner([giftPlan({ target: "corsair", credits: 27 })]);
    const agent = new Agent({
      id: "miner", persona: "p", api, store, planner,
      config: { ...config, fleetRoster: DUPLICATE_ID_ROSTER }, now: () => 1,
    });

    await agent.runOnce();
    await agent.runOnce();

    expect(calls).toEqual([]);
  });
});
