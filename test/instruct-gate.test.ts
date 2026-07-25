import { describe, expect, test } from "bun:test";
import { REGISTRY } from "../src/registry/actions";
import {
  GATED_QUERY_ACTIONS,
  findDirectedQueryAction,
  queryActionRejectionDetail,
} from "../src/server/instruct-gate";

// #527. The gate exists because five operator steers ordered a query action,
// which the mutations-only planner cannot plan, so the instruction never
// retired. These tests weight the ACCEPT direction heavily on purpose: a steer
// wrongly rejected at 3am, while the pilot is stranded, is a worse outcome than
// the bug the gate prevents.

describe("gated set is derived from the registry, not typed out", () => {
  // Catches: someone replacing the derivation with a literal list. A literal
  // list passes "find_route is gated" forever while silently rotting the day an
  // action's `kind` changes -- which is the exact failure mode constraint 1
  // forbids. Both directions, so neither a missing name nor an invented one
  // survives.
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
    // Pure mutation steers, the common case.
    "jump to gold_run, dock, refuel, then mine until the hold is full",
    "sell the palladium_ore and buy a fuel_cell",
  ])("%s", (text) => {
    expect(findDirectedQueryAction(text)).toBe(null);
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
  // named. BLIND SPOT, stated rather than papered over: no assertion on output
  // text can prove the examples are DERIVED rather than a hardcoded copy of
  // today's registry -- that claim rests on the code, not on this test. What
  // this does catch is a query name leaking into the advice.
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
