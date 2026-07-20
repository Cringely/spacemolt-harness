import { describe, expect, test } from "bun:test";
import { parseMarketText, parseStatusText, parseSystemText, slugifyItemName } from "../src/client/mcp-text-parser";
import fixture from "./fixtures/mcp-probe-2026-07-12.json";

// The PARSER ORACLE: the real captured MCP dashboards from our own account
// (Batch 0). These tests fail if the parser ever drifts from real game output.
const reads = (fixture as { read_only_calls: Record<string, { raw: { result: { content: { text: string }[] } } }> }).read_only_calls;
const statusText = reads["spacemolt/get_status"]!.raw.result.content[0]!.text;
const systemText = reads["spacemolt/get_system"]!.raw.result.content[0]!.text;

describe("parseStatusText against the captured fixture", () => {
  const s = parseStatusText(statusText);

  test("scalar capacities and vitals match the real dashboard", () => {
    expect(s.fuel).toBe(87);
    expect(s.maxFuel).toBe(130);
    expect(s.cargoUsed).toBe(30);
    expect(s.cargoCapacity).toBe(100);
    expect(s.hull).toBe(95);
    expect(s.maxHull).toBe(95);
  });

  test("credits are parsed with the thousands separator stripped (trap b)", () => {
    expect(s.credits).toBe(2750); // "2,750cr" -> 2750
  });

  test("docked state and current POI come from the 'Docked at' line", () => {
    expect(s.docked).toBe(true);
    expect(s.dockedAt).toBe("market_prime_exchange");
    expect(s.inTransit).toBe(false);
  });

  test("cargo maps every row, deriving the machine item_id from the display name", () => {
    const byId = Object.fromEntries(s.cargo!.map((c) => [c.itemId, c]));
    expect(s.cargo!.length).toBe(3);
    expect(byId["palladium_ore"]).toEqual({ itemId: "palladium_ore", name: "Palladium Ore", quantity: 22 });
    expect(byId["vanadium_ore"]).toEqual({ itemId: "vanadium_ore", name: "Vanadium Ore", quantity: 3 });
    expect(byId["gold_ore"]).toEqual({ itemId: "gold_ore", name: "Gold Ore", quantity: 5 });
  });

  test("lost fields are left empty, not invented (trap c): no system_id, no lifetime stats", () => {
    // The MCP text carries the system NAME only, and no lifetime stats block —
    // the parser reports absence rather than guessing.
    expect(s.systemId).toBeNull();
    expect(s.stats).toBeUndefined();
  });
});

describe("parseSystemText against the captured fixture", () => {
  const sys = parseSystemText(systemText);

  test("system id and name are split from the header", () => {
    expect(sys.id).toBe("market_prime");
    expect(sys.name).toBe("Market Prime");
  });

  test("connections are the neighbour system ids", () => {
    expect(sys.connections).toEqual(["cargo_lanes", "gold_run", "haven"]);
  });

  test("POIs are keyed by field, with hasBase derived from the base column", () => {
    const byId = Object.fromEntries(sys.pois.map((p) => [p.id, p]));
    expect(sys.pois.length).toBe(5);
    // the station has a non-empty base column -> dockable
    expect(byId["market_prime_exchange"]).toMatchObject({ type: "station", hasBase: true });
    // a sun with an empty base column -> not dockable; class survives
    expect(byId["the_beacon"]).toMatchObject({ type: "sun", class: "F8V", hasBase: false });
  });

  test("currentPoi is undefined on the MCP path (no current-POI marker in get_system text)", () => {
    expect(sys.currentPoi).toBeUndefined();
  });
});

describe("parser trap coverage", () => {
  test("trap a — row order is not stable: a reordered dashboard parses to the same sets", () => {
    // Reorder the cargo rows and the POI rows, then assert the parsed result is
    // identical (rows are keyed by their own fields, never by position).
    const reorderCargo = swapTableRows(statusText, /^Cargo \(/, [2, 0, 1]);
    expect(sortById(parseStatusText(reorderCargo).cargo!)).toEqual(sortById(parseStatusText(statusText).cargo!));

    const reorderPois = swapTableRows(systemText, /^POIs \(/, [4, 3, 2, 1, 0]);
    expect(parseSystemText(reorderPois).pois.map((p) => p.id).sort()).toEqual(
      parseSystemText(systemText).pois.map((p) => p.id).sort(),
    );
  });

  test("trap b — arbitrary thousands separators parse to the correct int", () => {
    const big = statusText.replace(/[\d,]+cr/, "1,234,567cr");
    expect(parseStatusText(big).credits).toBe(1234567);
  });

  test("slugify recovers the machine id for names with dashes and digits", () => {
    expect(slugifyItemName("Palladium Ore")).toBe("palladium_ore");
    expect(slugifyItemName("EMP-Tipped Rounds Box")).toBe("emp_tipped_rounds_box");
    expect(slugifyItemName("Helium-3")).toBe("helium_3");
  });

  test("slug(item_name) === item_id for EVERY captured market row (the derivation's real oracle)", () => {
    // The view_market fixture carries hundreds of rows with BOTH item_id and
    // item_name — an exhaustive check on the slug derivation cargo itemId leans
    // on. This fails the day a real item's display name diverges from its id.
    const marketText = reads["spacemolt_market/view_market"]!.raw.result.content[0]!.text;
    const rows = marketText.split("\n").filter((l) => l.includes("\t"));
    const mismatches: string[] = [];
    let checked = 0;
    for (const line of rows) {
      const cells = line.split("\t");
      const itemId = cells[1] ?? "";
      const itemName = cells[2] ?? "";
      if (itemId === "item_id" || !/^[a-z0-9_]+$/.test(itemId) || !itemName) continue; // skip the header row
      checked++;
      if (slugifyItemName(itemName) !== itemId) mismatches.push(`${itemName} -> ${slugifyItemName(itemName)} != ${itemId}`);
    }
    expect(checked).toBeGreaterThan(400); // the fixture has 482 rows; guard against parsing nothing
    expect(mismatches).toEqual([]);
  });

  test("graceful degradation: a status text missing sections never throws, yields safe defaults", () => {
    const s = parseStatusText("Miner [nebula] | 500cr | Somewhere");
    expect(s.credits).toBe(500);
    expect(s.fuel).toBe(0);
    expect(s.cargo).toEqual([]);
    expect(s.docked).toBe(false);
    expect(() => parseStatusText("")).not.toThrow();
    expect(() => parseSystemText(undefined)).not.toThrow();
  });
});

// Buyable-here surfacing (issue #93): parseMarketText against the ONLY
// captured view_market response (the Batch 0 probe, this same fixture). The
// oracle values below are read straight off the real 482-row listing at
// Market Prime Exchange -- the station where the live no-buyers episode
// happened -- so each assertion pins a distinct real shape the digest's sell
// precondition depends on: a full bid row, a comma-separated price, a
// blank-bid row, and the decisive absence (palladium_ore, the item the pilot
// failed to sell 38 times, is not in the listing at all).
describe("parseMarketText against the captured fixture", () => {
  const marketText = reads["spacemolt_market/view_market"]!.raw.result.content[0]!.text;
  const rows = parseMarketText(marketText);
  const byId = new Map(rows.map((r) => [r.itemId, r]));

  test("parses every row of the real listing (header says 482 items)", () => {
    expect(rows.length).toBe(482);
  });

  test("a standing bid row carries the bid price and demand (iron_ore: 11cr, qty 200)", () => {
    expect(byId.get("iron_ore")).toEqual({ itemId: "iron_ore", bestBuy: 11, buyQty: 200 });
  });

  test("comma-separated prices and quantities parse to full integers (trap b)", () => {
    // engine_core row: best_buy "2,236cr"; fuel_tank row: buy_qty "9,203"
    expect(byId.get("engine_core")!.bestBuy).toBe(2236);
    expect(byId.get("fuel_tank")!.buyQty).toBe(9203);
  });

  test("a blank best_buy cell stays undefined, not 0 (vanadium_ore has no bid here)", () => {
    expect(byId.get("vanadium_ore")).toEqual({ itemId: "vanadium_ore", bestBuy: undefined, buyQty: 0 });
  });

  test("palladium_ore is ABSENT from the listing -- the live no-buyers ground truth", () => {
    // 38 live "Sold 0 Palladium Ore ... (no buyers)" blocks happened at this
    // exact station; the market data predicts every one of them.
    expect(byId.has("palladium_ore")).toBe(false);
  });

  test("non-market text and empty input degrade to zero rows, never a throw", () => {
    expect(parseMarketText(statusText)).toEqual([]);
    expect(parseMarketText("")).toEqual([]);
    expect(parseMarketText(undefined)).toEqual([]);
  });
});

// --- test helpers ----------------------------------------------------------

function sortById(cargo: { itemId: string }[]) {
  return [...cargo].sort((a, b) => a.itemId.localeCompare(b.itemId));
}

/** Reorder the data rows of a tab table (identified by its intro line) per the
 * given index order, leaving the header row and everything else in place. */
function swapTableRows(text: string, sectionLabel: RegExp, order: number[]): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => sectionLabel.test(l));
  const headerIdx = start + 1;
  const firstData = headerIdx + 1;
  const dataRows: string[] = [];
  let i = firstData;
  for (; i < lines.length; i++) {
    if (!lines[i]!.includes("\t")) break;
    dataRows.push(lines[i]!);
  }
  const reordered = order.map((idx) => dataRows[idx]!);
  return [...lines.slice(0, firstData), ...reordered, ...lines.slice(i)].join("\n");
}
