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

  test("blocked events before the window feed lifetime signals but not the window table", () => {
    const events = [
      blocked(NOW - 30 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 29 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 28 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 27 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
      blocked(NOW - 26 * HOUR, "buy", "invalid_item: Unknown item 'fuel_cells'."),
    ];
    const t = failureTaxonomy("a1", events, NOW, 24);
    expect(t.classes).toEqual([]); // nothing blocked inside 24h
    expect(t.brokenCapabilities.map((b) => b.action)).toEqual(["buy"]); // lifetime signal still fires
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
    expect(t.brokenCapabilities).toEqual([
      { action: "buy", attempts: 6, failures: 6, failureRate: 1, topClass: "invalid_item" },
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
