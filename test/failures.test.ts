// #158 failure taxonomy: normalizer + aggregation. Every error string in the
// normalizer tests is a REAL capture (live incident or fixture) or comes from
// the vendored game reference -- provenance on each case. Zero live traffic.
import { describe, expect, test } from "bun:test";
import {
  failureClass, failureTaxonomy, UNCLASSIFIED, BROKEN_CAPABILITY_MIN_ATTEMPTS,
} from "../src/server/failures";
import { NO_BUYERS_CLASS } from "../src/agent/wake";
import type { AgentEvent } from "../src/store/store";

// ---- normalizer ------------------------------------------------------------

describe("failureClass: live-captured error texts map to stable classes", () => {
  const cases: Array<[text: string, cls: string, provenance: string]> = [
    ["Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)", NO_BUYERS_CLASS, "live 2026-07-13 (#146)"],
    ["invalid_item: Unknown item 'fuel_cells'. Use exact item ID (e.g. 'iron_ore') or full name (e.g. 'Iron Ore').",
      "invalid_item", "live capture, market-capture-2026-07-13.json (#152)"],
    ["not_docked: You must be docked at a station to perform this action.",
      "not_docked", "live capture (#152); code in game-reference api.md error table"],
    ["deposits too sparse to mine here", "too_sparse", "live (#155 era, agent-repeat-block fixture text)"],
    ["nothing to mine here", "nothing_to_mine", "live 2026-07-11 (SM-era, agent.test.ts)"],
    ["Error: no_resources: Nothing to mine here", "nothing_to_mine", "MCP text transport shape, mcp-game-api.test.ts"],
    ["no mining equipment fitted; a mine action needs a mining laser module",
      "missing_module", "harness precheck text, src/agent/executor.ts"],
    ["Another action is already in progress for this player", "action_in_progress", "live 2026-07-11 (SM-10)"],
    ["Your ship is mid-travel to Kepler-442 (~10s until arrival)", "in_transit", "live 2026-07-11 (SM-10)"],
    ["not enough fuel", "not enough fuel", "live shape (executor.test.ts) -- uncoded prose falls back to itself"],
    ["cargo full", "cargo full", "live shape (http.test.ts)"],
  ];
  for (const [text, cls, provenance] of cases) {
    test(`${cls} <- ${provenance}`, () => {
      expect(failureClass(text)).toBe(cls);
    });
  }
});

describe("failureClass: item names, quantities, and destinations never fragment a class", () => {
  test("no-buyers across different items and quantities is ONE class (the #146 damper-defeat shape)", () => {
    // Both live 2026-07-13; the per-item wording defeated the exact-string damper.
    expect(failureClass("Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)"))
      .toBe(failureClass("Sold 0 Vanadium Ore for 0cr, 20 unsold (no buyers)"));
  });

  test("invalid_item across different attempted ids is ONE class -- raw and #152-corrected shapes alike", () => {
    const raw = "invalid_item: Unknown item 'fuel_cells'. Use exact item ID (e.g. 'iron_ore') or full name (e.g. 'Iron Ore').";
    const other = "invalid_item: Unknown item 'unobtainium_crystal_xl'. Use exact item ID (e.g. 'iron_ore') or full name (e.g. 'Iron Ore').";
    // The executor's buy correction re-prefixes its rewritten reason (executor.ts):
    const corrected = "invalid_item: 'fuel_cells' is not a catalog item id -- did you mean 'fuel_cell'? " +
      "Plan the buy again with id fuel_cell exactly. Game said: " + raw;
    expect(failureClass(raw)).toBe("invalid_item");
    expect(failureClass(other)).toBe("invalid_item");
    expect(failureClass(corrected)).toBe("invalid_item");
  });

  test("mid-travel to different destinations is ONE class (unquoted POI name would survive the prose fallback)", () => {
    expect(failureClass("Your ship is mid-travel to Kepler-442 (~10s until arrival)"))
      .toBe(failureClass("Your ship is mid-travel to Ross 128 (~7s until arrival)"));
  });
});

describe("failureClass: generalization and fallback tiers", () => {
  test("an unseen snake_case-coded error self-names its class -- zero new rules needed", () => {
    // Code from the vendored reference (docs/game-reference/upstream/docs/empires.md);
    // message body invented -- the CODE is the class, the body is discarded.
    expect(failureClass("insufficient_credits: You need more credits for this")).toBe("insufficient_credits");
  });

  test("uncoded prose strips quoted names and digits, so per-attempt variance yields one stable class", () => {
    // Shape test for the tier-3 normalizer (synthetic variants of one prose error).
    const a = failureClass("cannot deliver 12 units of 'iron_ore' to this station");
    const b = failureClass("cannot deliver 3 units of 'gold_ore' to this station");
    expect(a).toBe(b);
    expect(a).not.toContain("iron");
    expect(a).not.toMatch(/\d/);
  });

  test("empty/undefined/whitespace result text is unclassified, never a crash", () => {
    expect(failureClass(undefined)).toBe(UNCLASSIFIED);
    expect(failureClass("")).toBe(UNCLASSIFIED);
    expect(failureClass("   ")).toBe(UNCLASSIFIED);
  });
});

// ---- aggregation -------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let nextId = 1;
function actionEvent(
  ts: number, payload: unknown,
): AgentEvent & { id: number } {
  return { id: nextId++, agentId: "a1", ts, type: "action", payload };
}
const blocked = (ts: number, action: string, result: string) =>
  actionEvent(ts, { action, params: {}, outcome: "blocked", result });
const success = (ts: number, action: string) =>
  actionEvent(ts, { action, params: {}, outcome: "continue", result: "ok" });
const waiting = (ts: number, action: string) =>
  actionEvent(ts, { action, params: {}, outcome: "wait", result: "pending action resolving; pacing to tick" });
// #571/#581: the shape agent.ts writes for a PRE-CALL guard refusal (executor.ts
// guardBlock). Same event type and same `outcome` as `blocked` above -- the
// single `guard` field is the only thing separating them, which is the point.
const prevented = (ts: number, action: string, result: string) =>
  actionEvent(ts, { action, params: {}, outcome: "blocked", result, guard: true });

describe("failureTaxonomy: window class frequency table", () => {
  test("counts only blocked outcomes in-window, sorted desc, with actions/lastSeen/latest sample", () => {
    const events = [
      blocked(NOW - 3 * HOUR, "sell", "Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)"),
      blocked(NOW - 2 * HOUR, "sell", "Sold 0 Vanadium Ore for 0cr, 20 unsold (no buyers)"),
      success(NOW - 2 * HOUR, "mine"),
      waiting(NOW - 1 * HOUR, "mine"),
      blocked(NOW - 1 * HOUR, "mine", "deposits too sparse to mine here"),
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.classes.map((r) => [r.class, r.count])).toEqual([
      [NO_BUYERS_CLASS, 2],
      ["too_sparse", 1],
    ]);
    const nb = t.classes[0]!;
    expect(nb.actions).toEqual(["sell"]);
    expect(nb.lastSeenTs).toBe(NOW - 2 * HOUR);
    expect(nb.sample).toBe("Sold 0 Vanadium Ore for 0cr, 20 unsold (no buyers)"); // latest raw text, not the class
  });

  test("blocked events before the window stay out of the window table (and out of the findings, #518)", () => {
    const events = [
      blocked(NOW - 30 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 29 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 28 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 27 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 26 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.classes).toStrictEqual([]); // nothing blocked inside 24h
    // #518: a history that stopped before the window is history, not a current
    // capability defect. The window covers the finding as well as the table.
    expect(t.brokenCapabilities).toStrictEqual([]);
  });
});

describe("failureTaxonomy: new-class detection is lifetime-aware", () => {
  test("a class first seen inside the window is new; one with pre-window history is not", () => {
    const events = [
      blocked(NOW - 40 * HOUR, "sell", "Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)"), // history
      blocked(NOW - 2 * HOUR, "sell", "Sold 0 Carbon Ore for 0cr (no buyers)"), // recurrence, not new
      blocked(NOW - 1 * HOUR, "jump", "wrong_system: POI is in a different system"), // first ever
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.newClasses).toEqual(["wrong_system"]);
  });
});

describe("failureTaxonomy: broken capabilities (the 86/86 buy signal)", () => {
  test("an action at 100% lifetime failure with enough attempts is flagged with its dominant class", () => {
    const events: Array<AgentEvent & { id: number }> = [];
    for (let i = 0; i < 6; i++) {
      events.push(blocked(NOW - (i + 1) * HOUR, "buy",
        "invalid_item: Unknown item 'fuel_cells'. Use exact item ID (e.g. 'iron_ore') or full name (e.g. 'Iron Ore')."));
    }
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.brokenCapabilities).toStrictEqual([
      {
        action: "buy", attempts: 6, failures: 6, failureRate: 1,
        windowAttempts: 6, windowFailures: 6, topClass: "invalid_item",
      },
    ]);
  });

  test("successes clear the flag: a mostly-failing action is not 'broken'", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => blocked(NOW - (i + 1) * HOUR, "mine", "deposits too sparse to mine here")),
      success(NOW - 6 * HOUR, "mine"),
      success(NOW - 7 * HOUR, "mine"),
    ];
    // 5/7 = 0.71 < BROKEN_CAPABILITY_FAILURE_RATE
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.brokenCapabilities).toEqual([]);
  });

  test("below the attempt floor nothing is flagged -- one bad afternoon is not a broken capability", () => {
    const events = Array.from({ length: BROKEN_CAPABILITY_MIN_ATTEMPTS - 1 },
      (_, i) => blocked(NOW - (i + 1) * HOUR, "dock", "not_docked: You must be docked at a station to perform this action."));
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.brokenCapabilities).toEqual([]);
  });

  test("wait outcomes are pacing, not attempts -- they neither dilute nor inflate the rate", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => blocked(NOW - (i + 1) * HOUR, "buy", "not_docked: must dock first")),
      ...Array.from({ length: 10 }, (_, i) => waiting(NOW - (i + 1) * HOUR, "buy")),
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);
    // If waits counted as successes, 5/15 = 0.33 and the flag would vanish.
    expect(t.brokenCapabilities.map((b) => [b.action, b.attempts, b.failureRate])).toEqual([["buy", 5, 1]]);
  });
});

// #518: the reviewer files "broken capability, ~100% failure over 72h" findings
// off this list, so a finding whose numerator and denominator come from
// different spans is a false claim published into the backlog (issue #491 filed
// `scan 27/27` with ZERO scan attempts in the claimed window, and
// `survey_system 11/11` while its two most recent attempts had SUCCEEDED).
// Each fixture below is built so the lifetime answer and the window answer
// genuinely DIFFER -- a fixture where they agree cannot fail.
describe("failureTaxonomy: a broken-capability finding is bounded by its window (#518)", () => {
  test("an action last attempted before the window is not a current broken capability", () => {
    // The #491 `scan` shape: heavy failure history, last attempt 11 days back.
    const events = Array.from({ length: 27 }, (_, i) =>
      blocked(NOW - (200 + i) * HOUR, "scan", "invalid_target: No such target here."));
    const t = failureTaxonomy("a1", events, NOW, 72);
    // Lifetime says 27/27 = 100% broken. The window says: not attempted.
    expect(t.brokenCapabilities).toStrictEqual([]);
  });

  test("recent successes veto a lifetime failure rate -- the window's evidence wins", () => {
    // The #491 `survey_system` shape: a dead `no_scanner` history, then the
    // scanner gets fitted and the action starts working. Lifetime is still
    // 40/41 = 0.976 (above the rate floor); the window is 1/2 = 0.5.
    const events = [
      ...Array.from({ length: 40 }, (_, i) =>
        blocked(NOW - (100 + i) * HOUR, "survey_system", "no_scanner: You need a survey scanner.")),
      blocked(NOW - 30 * HOUR, "survey_system", "no_scanner: You need a survey scanner."),
      success(NOW - 2 * HOUR, "survey_system"),
    ];
    const t = failureTaxonomy("a1", events, NOW, 72);
    expect(t.brokenCapabilities).toStrictEqual([]);
  });

  test("topClass names the failure the WINDOW saw, not the one lifetime history is dominated by", () => {
    // A capability whose failure MODE changed: 40 pre-window `no_scanner`
    // blocks (the scanner then gets fitted), and a fresh in-window `not_docked`
    // breakage. Lifetime says no_scanner 40:3; the window says not_docked 3:0.
    // The reviewer files `action N/N CLASS` verbatim, so a lifetime topClass on
    // a window-gated entry files a no_scanner issue for a not_docked defect.
    const events = [
      ...Array.from({ length: 40 }, (_, i) =>
        blocked(NOW - (100 + i) * HOUR, "survey_system", "no_scanner: You need a survey scanner.")),
      ...Array.from({ length: 3 }, (_, i) =>
        blocked(NOW - (i + 1) * HOUR, "survey_system", "not_docked: You must be docked at a station to perform this action.")),
    ];
    const t = failureTaxonomy("a1", events, NOW, 72);
    expect(t.brokenCapabilities).toStrictEqual([
      {
        action: "survey_system", attempts: 43, failures: 43, failureRate: 1,
        windowAttempts: 3, windowFailures: 3, topClass: "not_docked",
      },
    ]);
    // The window class table beside it agrees -- the finding and the table can
    // never name different failures for the same window again.
    expect(t.classes.map((r) => [r.class, r.count])).toStrictEqual([["not_docked", 3]]);
  });

  test("a capability still failing inside the window is reported, with window counts beside the lifetime ones", () => {
    // The #158 signal this fix must NOT cost: an 86/86-style history that is
    // STILL failing today. Only one attempt lands inside the window, so a
    // purely-windowed rewrite (which would apply the 5-attempt floor to the
    // window) drops it -- that is what this test forbids.
    // The pre-window blocks carry a DIFFERENT class from the in-window one on
    // purpose: with both the same, the topClass assertion below would hold
    // whichever span produced it and could not fail. n=1 is also the tightest
    // case for the in-window topClass -- one event has to carry it.
    const events = [
      ...Array.from({ length: 80 }, (_, i) =>
        blocked(NOW - (100 + i) * HOUR, "buy", "no_credits: You cannot afford that.")),
      blocked(NOW - 2 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
    ];
    const t = failureTaxonomy("a1", events, NOW, 72);
    expect(t.brokenCapabilities).toStrictEqual([
      {
        action: "buy", attempts: 81, failures: 81, failureRate: 1,
        windowAttempts: 1, windowFailures: 1, topClass: "invalid_item",
      },
    ]);
  });
});

// The VERBATIM text src/agent/executor.ts:774-778 emits for the #368
// nearby-membership guard -- the string private #581 filed as 28/28 lifetime
// `scan` failures "from the game". The game never received those calls. Held as
// one constant so both tests below run the SAME wording through the taxonomy
// and the only difference between them is the `guard` field.
const SCAN_GUARD_TEXT =
  `scan blocked: pick a target id straight OFF the Nearby list in your briefing -- scan reaches only entities ` +
  `AT your current location, and 'factory_belt_haze' is not on that list here in market_prime. A POI of another ` +
  `system is a PLACE: travel_to that system first, then scan what its Nearby list shows. ` +
  `If your briefing shows no Nearby list, there is nothing to scan here.`;

describe("failureTaxonomy: a guard refusing us is not the game refusing us (#571/#581)", () => {
  test("a mixed stream splits by the guard flag; every blocked event lands in exactly one bucket", () => {
    const events = [
      // Five guard refusals: enough to clear BROKEN_CAPABILITY_MIN_ATTEMPTS at
      // a 100% rate, which is exactly how #581 became a P1 finding.
      prevented(NOW - 6 * HOUR, "scan", SCAN_GUARD_TEXT),
      prevented(NOW - 5 * HOUR, "scan", SCAN_GUARD_TEXT),
      prevented(NOW - 4 * HOUR, "scan", SCAN_GUARD_TEXT),
      prevented(NOW - 3 * HOUR, "scan", SCAN_GUARD_TEXT),
      prevented(NOW - 2 * HOUR, "scan", SCAN_GUARD_TEXT),
      // One real game refusal alongside it (live 2026-07-13, #146).
      blocked(NOW - 1 * HOUR, "sell", "Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)"),
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);

    // The game table carries the game's refusal and NOTHING else. toStrictEqual
    // on the whole mapped array, not toContain: toContain is count-blind and
    // would pass while the five guard rows sat in this table beside it.
    expect(t.classes.map((r) => [r.class, r.count, r.actions])).toStrictEqual([
      [NO_BUYERS_CLASS, 1, ["sell"]],
    ]);
    // ...and the guard rows are all in the other table, sampled with the raw
    // guard text so a reader can see whose sentence it is.
    expect(t.prevented.map((r) => [r.count, r.actions, r.sample])).toStrictEqual([
      [5, ["scan"], SCAN_GUARD_TEXT],
    ]);
    // Conservation: 6 blocked events in, 6 counted across the two tables. This
    // is what makes "exactly one bucket" a real claim -- the two assertions
    // above are each satisfiable by a double-count.
    const counted = [...t.classes, ...t.prevented].reduce((n, r) => n + r.count, 0);
    expect(counted).toBe(6);

    // The finding the split exists to stop. 5/5 at 100% lifetime AND in-window
    // clears every broken-capability gate; only the guard flag keeps `scan` out.
    expect(t.brokenCapabilities).toStrictEqual([]);
    // A guard's own wording is our sentence, never "the game teaching us a rule".
    expect(t.newClasses).toStrictEqual([NO_BUYERS_CLASS]);
  });

  test("the SAME text without the flag is still a game failure (stores predate the field)", () => {
    // Byte-identical prose to the test above, written by the pre-#571/#581 emitter.
    // Absence of `guard` has to keep meaning game-or-legacy: a store full of
    // history would otherwise silently reclassify the day this shipped. This is
    // also what pins the fix to the FLAG rather than to the wording -- the
    // rejected alternative (regexing our guard prose inside failures.ts) would
    // pass the test above and fail this one.
    const events = [
      blocked(NOW - 6 * HOUR, "scan", SCAN_GUARD_TEXT),
      blocked(NOW - 5 * HOUR, "scan", SCAN_GUARD_TEXT),
      blocked(NOW - 4 * HOUR, "scan", SCAN_GUARD_TEXT),
      blocked(NOW - 3 * HOUR, "scan", SCAN_GUARD_TEXT),
      blocked(NOW - 2 * HOUR, "scan", SCAN_GUARD_TEXT),
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.prevented).toStrictEqual([]);
    expect(t.classes.map((r) => [r.count, r.actions])).toStrictEqual([[5, ["scan"]]]);
    expect(t.brokenCapabilities.map((b) => [b.action, b.attempts, b.failures, b.windowAttempts]))
      .toStrictEqual([["scan", 5, 5, 5]]);
  });
});

describe("failureTaxonomy: persisted-state tolerance (events outlive their schema)", () => {
  test("null/foreign/missing-field payloads are skipped or degraded, never a crash", () => {
    const events = [
      actionEvent(NOW - 5 * HOUR, null), // pre-schema event
      actionEvent(NOW - 4 * HOUR, "a bare string"), // foreign shape
      actionEvent(NOW - 3 * HOUR, { outcome: "blocked" }), // no action, no result
      blocked(NOW - 1 * HOUR, "mine", "deposits too sparse to mine here"),
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);
    // The action-less blocked event still counts in the class table (as
    // unclassified) -- a failure is a failure even when the writer's schema
    // predates the fields -- but never in per-action capability stats.
    expect(t.classes.map((r) => [r.class, r.count])).toEqual([
      ["too_sparse", 1], [UNCLASSIFIED, 1],
    ]);
    expect(t.brokenCapabilities).toEqual([]);
  });
});
