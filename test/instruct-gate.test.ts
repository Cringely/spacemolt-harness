import { afterAll, describe, expect, mock, test } from "bun:test";
import * as realActions from "../src/registry/actions";
import { REGISTRY } from "../src/registry/actions";

// Snapshotted HERE, at import time, not read inside the afterAll below: a
// module namespace is live-bound, so once mock.module has run, `realActions`
// itself reports the fake. Spreading now captures the genuine exports.
const REAL_ACTIONS = { ...realActions };
import {
  DIRECTIVE_VERBS,
  GATED_QUERY_ACTIONS,
  LEAD_IN_JOINERS,
  findDirectedQueryAction,
  queryActionRejectionDetail,
} from "../src/server/instruct-gate";
import { PlanStepSchema } from "../src/registry/plan";

// #527. The gate exists because five operator steers ordered a query action,
// which the mutations-only planner cannot plan, so the instruction never
// retired. These tests weight the ACCEPT direction heavily on purpose: a steer
// wrongly rejected at 3am, while the pilot is stranded, is a worse outcome than
// the bug the gate prevents.

describe("gated set is derived from the registry, not typed out", () => {
  // Catches: the exported set drifting from the predicate -- a hand-edited
  // exclusion, an inverted filter, a name added by hand. Both directions, so
  // neither a missing name nor an invented one survives.
  //
  // What it does NOT catch, stated because an earlier version of this comment
  // claimed otherwise: a literal list is only red once it has ROTTED. A
  // faithful hardcode of today's names passes this test on the day it is
  // written, which is exactly the day someone would write it. The derivation
  // probe at the bottom of this file is the test that closes that.
  test("gated set == every registry query action whose name is snake_case", () => {
    const expected = REGISTRY
      .filter((a) => a.kind === "query" && a.name.includes("_"))
      .map((a) => a.name)
      .sort();
    expect([...GATED_QUERY_ACTIONS].sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(10); // the registry really does carry these
  });

  test("no mutation is ever gated", () => {
    const mutations = new Set(REGISTRY.filter((a) => a.kind === "mutation").map((a) => a.name));
    expect(GATED_QUERY_ACTIONS.filter((n) => mutations.has(n))).toEqual([]);
  });

  // Catches: the two structural exclusions being dropped. The catalog action's
  // registry name is the EMPTY STRING -- an empty needle would match anything --
  // and `view` is an ordinary English word an operator uses about the dashboard.
  test("excludes the empty catalog name and the bare-English `view`", () => {
    expect(GATED_QUERY_ACTIONS).not.toContain("");
    expect(GATED_QUERY_ACTIONS).not.toContain("view");
    expect(GATED_QUERY_ACTIONS).toContain("view_market"); // ...but its snake_case sibling IS gated
  });
});

describe("steers that MUST be rejected", () => {
  // The real one. Sent from the PM's own seat 2026-07-24; the pilot could not
  // plan it, it never retired, and it re-raised for hours.
  test("the incident steer", () => {
    expect(
      findDirectedQueryAction(
        "Use find_route with id gold_run (a base is confirmed there) and jump to the first hop it returns, then dock and refuel.",
      ),
    ).toBe("find_route");
  });

  test.each([
    ["run get_status and report the fuel", "get_status"],
    ["call view_market at the station before selling", "view_market"],
    ["run the find_route action for gold_run", "find_route"], // verb + 2 words of slack
    ["check analyze_market, then sell whatever pays", "analyze_market"],
    ["USE FIND_ROUTE, id gold_run", "find_route"], // casing
    ['use "find_route" on gold_run', "find_route"], // quoted -- quoting is not an exemption
    ["dock and refuel. then run get_nearby", "get_nearby"], // second sentence
    // A negation in a DIFFERENT clause must not launder a real directive, and a
    // negation AFTER the mention must not either.
    ["do not waste fuel. use find_route on gold_run", "find_route"],
    ["use find_route on gold_run, don't burn the last cell", "find_route"],
  ])("%s", (text, expected) => {
    expect(findDirectedQueryAction(text)).toBe(expected);
  });
});

describe("steers that MUST be accepted", () => {
  // The corrective steer that actually worked, after the incident. If the gate
  // had rejected this one, the pilot would still be stranded.
  test("the real corrective steer", () => {
    expect(
      findDirectedQueryAction(
        "All my earlier instructions are DONE - disregard every one of them. You are stranded at Duskmere: 2 fuel, no base in reach. Do NOT jump and do NOT spend fuel until a buyer is confirmed.",
      ),
    ).toBe(null);
  });

  test.each([
    // Negation: the operator steering AWAY from the query.
    "do not run find_route",
    "don't use find_route, we already know the way",
    "never call get_status again, it is wasting a tick",
    "avoid running find_route this hour",
    // Describing a lookup the operator already did. Past tense is the whole
    // signal, so only base-form verbs count as directives.
    "I checked find_route and there is no path",
    "I ran get_status myself: 2 fuel left",
    // Past tense with NO subject in front of it. This is the case that isolates
    // the base-form-only verb rule: the first-person guard cannot cover it, so
    // admitting an inflected verb to DIRECTIVE_VERBS reddens here and nowhere
    // else.
    "already checked find_route, there is no path out",
    "we ran view_market at the last stop, nothing sells",
    "find_route returned nothing, so sit tight",
    "I use find_route on my side before steering you",
    // Ordinary English that happens to sit near an action name.
    "use the market view I'm looking at and sell the ore",
    "the view from Duskmere is clear, dock and repair",
    // Action name inside a longer identifier or word: whole-token matching only.
    "run prefix_find_route_helper if it exists",
    "run find_routes_v2",
    "run xget_status",
    // A quoted MENTION with no directive verb.
    'the error said "find_route timed out", so hold position',
    // Distance: the verb governs another clause three words back or more.
    "run the docking sequence first, then whatever find_route said",
    // Distance, from the other side: a clause-initial verb with the name FOUR
    // words downstream, no punctuation and no joiner in between. This is the
    // only vector that pins the far edge of DIRECTIVE_WINDOW -- widen it and
    // this reddens, and nothing else in the table does.
    "check whether the last get_status reading was stale",
    // Pure mutation steers, the common case.
    "jump to gold_run, dock, refuel, then mine until the hold is full",
    "sell the palladium_ore and buy a fuel_cell",

    // --- The regression suite for the clause-initial rule. Every steer below
    // was rejected by the previous revision, which scanned backwards from the
    // action name for a verb anywhere in the sentence. Fourteen realistic
    // steers, four failure shapes.

    // SUPERSEDE. The worst of the four, because this is the operator's own
    // remedy for the bug the gate exists to prevent: a gate that blocks the
    // fix is worse than no gate. It failed because negation was searched only
    // BEFORE the mention, so a cancellation that arrives after it -- which is
    // how people actually retract things -- could not rescue the sentence.
    "Your last instruction told you to run find_route; that was my mistake, drop it and just jump to gold_run.",
    "The old steer asked you to use find_route and it can't be planned. Ignore it, dock and refuel.",
    "Something is stuck telling you to run get_status. Cancel it and mine instead.",

    // FIRST-PERSON NARRATION. The operator describing their own workflow. The
    // old first-person guard looked at exactly one token in front of the verb,
    // so a single adverb defeated it; the accept case that shipped passed only
    // because nothing sat between the pronoun and the verb. Clause-initial
    // matching needs no pronoun list at all, and these prove it: none of them
    // opens its clause with a verb.
    "I already use find_route on my side before steering you.",
    "I just use get_status to keep an eye on you.",
    "We normally run find_route ourselves, you don't need to.",
    "I did use find_route and there is no path.",
    "I can use find_route myself, you just jump.",

    // REPORT CLAUSE AFTER A COMMA. An unrelated imperative, then a fact. The
    // old sentence split was [.!?;\n] -- no comma, no colon -- so the report
    // fell inside the imperative's sentence and inherited its verb.
    "Check your fuel, get_status said 2 units left.",
    "Do it now, get_cargo showed the hold is empty.",

    // PAST-TENSE QUESTION. "did" is not a base-form verb, so the clause does
    // not open with a directive.
    "Did you run get_status before you jumped?",

    // --- Round 3 regression suite: A JOINER COMBINED WITH A NEGATION, AND A
    // JOINER COMBINED WITH A SUBJECT. The revision this replaced made the
    // seven joiners CLAUSE BOUNDARIES, which stranded whatever preceded them
    // and rejected every steer below. The blind spot was structural: the
    // accept table had no vector pairing a joiner with either shape, so the
    // five first-person vectors above passed only because none of them
    // contains a joiner. Compare "We normally run find_route ourselves" (which
    // shipped, green) against "I handle the routing and run find_route" (same
    // class, one `and` apart, rejected).

    // NEGATION STRANDED BEHIND A JOINER. The module's documented contract says
    // a negation between the verb and the mention must be accepted; a boundary
    // at the joiner put the negation in the PREVIOUS clause, so the matcher
    // never saw it. Each of these steers the pilot AWAY from the query.
    "Do not dock and run get_status.",
    "Do not undock and run find_route.",
    "Don't jump and run get_nearby.",
    "Never dock and call view_market.",
    "Avoid the station and check get_status there.",
    "Do not refuel and run get_status until I say so.",
    "Never undock and run find_route on your own.",
    "Do not mine and then run get_cargo.",

    // SUBJECT STRANDED BEHIND A JOINER. First-person narration where the
    // pronoun sits before the joiner and the verb after it. All five are the
    // operator saying they handle the lookup themselves.
    "I handle the routing and run find_route before every steer.",
    "I use the map myself and also run get_status on my side.",
    "We watch the market and check view_market every hour on our end.",
    "I keep my own charts and then run find_route when I need to.",
    "We track the hold ourselves and also check get_cargo each tick.",

    // KNOWN LIMITS, listed here because they belong to this suite even though
    // the gate still gets them wrong. All three still reject; see the KNOWN
    // LIMITS block in instruct-gate.ts for why closing them costs more
    // mechanism than the failure is worth. They are NOT asserted either way,
    // so fixing them later needs no edit here.
    //   "Fix this: call find_route failed with no_route. Just jump to duskmere."
    //   "Check the get_map panel on my dashboard, then jump."
    //   "Then use find_route was the old steer, ignore it."
  ])("%s", (text) => {
    expect(findDirectedQueryAction(text)).toBe(null);
  });
});

describe("the two word lists the rule stands on", () => {
  // Both lists are written out here rather than iterated from the source, and
  // that is deliberate. `test.each([...DIRECTIVE_VERBS])` looks stronger and is
  // strictly weaker: deleting `invoke` from the set deletes its own test case,
  // so the suite stays green through exactly the change it is supposed to
  // catch. Pinning the contents means a deletion fails the equality assertion
  // and an addition fails it too, which forces whoever adds a word to add a
  // vector for it.
  const VERBS = [
    "use", "run", "call", "execute", "perform", "issue", "invoke",
    "do", "try", "check", "query", "fetch", "request", "send", "start",
  ];
  const JOINERS = ["please", "then", "now", "also", "and", "first", "next"];

  test("the two lists are exactly these words", () => {
    expect([...DIRECTIVE_VERBS]).toEqual(VERBS);
    expect([...LEAD_IN_JOINERS]).toEqual(JOINERS);
  });

  test.each(VERBS)("%s find_route is a directive", (verb) => {
    expect(findDirectedQueryAction(`${verb} find_route on gold_run`)).toBe("find_route");
  });

  // A joiner in FRONT of an imperative is skipped, so the order behind it is
  // still an order. The full stop is what starts the new clause here -- which
  // is exactly the difference from the boundary rule this replaced, where the
  // joiner itself started one and stranded everything before it.
  test.each(JOINERS)("dock and refuel. %s run get_status is a directive", (joiner) => {
    expect(findDirectedQueryAction(`dock and refuel. ${joiner} run get_status`)).toBe("get_status");
  });

  // The other half of the same mechanism, and the one that fails if `start`
  // stops advancing past joiners: two stacked joiners before the verb.
  test("stacked lead-in joiners are all skipped", () => {
    expect(findDirectedQueryAction("dock and refuel. and then please run get_status")).toBe("get_status");
  });

  // THE TRADE, pinned so it cannot be reverted by accident. A second
  // imperative hanging off a joiner MID-clause is deliberately NOT seen: the
  // boundary rule that caught these two stranded every negation and every
  // subject sitting in front of a joiner (16 false positives on a 63-steer
  // corpus, against 4 for this rule). See KNOWN LIMITS in instruct-gate.ts.
  // If someone reinstates the boundary rule, these go red and point at the
  // reason rather than at a bare expectation flip.
  test.each([
    "dock and run get_status",
    "jump to gold_run then call view_market",
  ])("mid-clause compound imperative is knowingly accepted: %s", (text) => {
    expect(findDirectedQueryAction(text)).toBe(null);
  });
});

// The #527 seam (docs/wiki/seam-manifest.md). The gate's whole premise is that
// a gated action CANNOT become a plan step. That premise lives in plan.ts, not
// here, and nothing in the type system ties the two together -- so this test
// re-derives the plannable vocabulary from plan.ts's OWN schema (its union
// members, not the predicate that built them) and asserts the gate never
// blocks anything on it.
//
// Catches: plan.ts growing an exception -- a query action hand-added to the
// union the way travel_to already is -- which would leave the gate rejecting a
// steer the planner could now actually plan. The sibling "no mutation is ever
// gated" test above cannot catch that: it re-derives from REGISTRY and never
// reads plan.ts at all.
describe("the gate never blocks something plan.ts can plan", () => {
  test("no plannable step action is in the gated set", () => {
    const plannable = PlanStepSchema.options.map(
      (o) => (o as unknown as { shape: { action: { value: string } } }).shape.action.value,
    );
    expect(plannable.length).toBeGreaterThan(10); // the union really was read
    expect(plannable.filter((name) => GATED_QUERY_ACTIONS.includes(name))).toEqual([]);
  });
});

describe("the 400 body is the deliverable", () => {
  // Catches: a message that names no action, or drops one of the three things
  // an operator needs to self-serve (what offended, why it cannot work, what to
  // write instead). Asserted by substring because the prose is meant to be
  // edited; each substring is a distinct claim, so no single edit satisfies all
  // four by accident.
  test("names the action, the mutations-only reason, and both working shapes", () => {
    const detail = queryActionRejectionDetail("find_route");
    expect(detail).toContain("find_route");
    expect(detail).toContain("QUERY");
    expect(detail).toContain("MUTATION");
    expect(detail).toContain("OUTCOME");
  });

  // Catches: the message advertising a name the planner cannot accept. Every
  // action name it offers as an example must be a real registry mutation, and
  // the only query name allowed anywhere in the body is the offender being
  // named.
  test("advertises only real mutations, never a query action", () => {
    const detail = queryActionRejectionDetail("find_route");
    const words = new Set(detail.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
    const mutations = REGISTRY.filter((a) => a.kind === "mutation").map((a) => a.name);
    // The offender is named on purpose; no OTHER query action may appear.
    expect(GATED_QUERY_ACTIONS.filter((q) => q !== "find_route" && words.has(q))).toEqual([]);
    // ...and the advice really does name plannable actions.
    expect(mutations.filter((m) => words.has(m)).length).toBeGreaterThan(0);
  });
});

// Catches what no assertion against the REAL registry can: a faithful hardcode.
// Both the gated set and the advice prose are built from REGISTRY at module
// load, so swapping the registry for a fake one and re-importing the module
// proves the derivation rather than the current answer. Under a literal list --
// of gated names, or of MUTATION_EXAMPLES -- the module keeps emitting today's
// real names and both assertions go red while every other test in this file
// stays green. The fake exercises both structural exclusions too: `` (the
// catalog action's real name) and `view` are queries that must not be gated.
//
// Runs last and in its own describe because mock.module patches the module
// registry PROCESS-wide, not file-wide: without the afterAll below, the fake
// registry reaches every test file bun runs after this one (verified -- it
// reddened six tests in registry.test.ts and registry-conformance.test.ts).
// Restoring by handing back the real namespace object keeps every other export
// of the module intact with no list to maintain.
describe("the derivation is real, not a snapshot of today's registry", () => {
  afterAll(() => {
    mock.module("../src/registry/actions", () => REAL_ACTIONS);
  });

  test("a fake registry produces a fake gated set and fake advice", async () => {
    mock.module("../src/registry/actions", () => ({
      REGISTRY: [
        { name: "wibble", kind: "mutation" },
        { name: "wobble", kind: "mutation" },
        { name: "flim_flam", kind: "query" },
        { name: "", kind: "query" },
        { name: "view", kind: "query" },
      ],
    }));
    const probe = "../src/server/instruct-gate?derivation-probe";
    const mod = (await import(probe)) as typeof import("../src/server/instruct-gate");

    expect([...mod.GATED_QUERY_ACTIONS]).toEqual(["flim_flam"]);
    expect(mod.queryActionRejectionDetail("flim_flam")).toContain("wibble, wobble");
    // ...and the matcher gates the fake action, so the rule reads the same set.
    expect(mod.findDirectedQueryAction("run flim_flam now")).toBe("flim_flam");
  });
});
