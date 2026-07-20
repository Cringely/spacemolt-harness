// Text-dashboard parser for the MCP path (improv-mode plan Batch A, §5a).
//
// The problem this solves: over our HTTP API a `get_status` call returns a rich
// structured object our Zod schemas parse straight into a StatusSnapshot. Over
// MCP the SAME call returns a human-readable TEXT dashboard in
// result.content[0].text with NO structuredContent (Batch 0 finding). So the
// backstops — which consume StatusSnapshot / SystemInfo — need that dashboard
// mapped back into those types. This module is that mapping, and nothing else.
//
// Parser strategy (decision recorded in docs/decisions.md): a HYBRID.
//   - Scalar labeled values (fuel, cargo, hull, credits, docked-at) are pulled
//     with per-field regexes over the whole text. Section order is not
//     guaranteed, and a regex-per-field ignores order entirely — a section
//     moving or a new section appearing can't misalign a field.
//   - The tabular sections (cargo items; POIs; connections) are read with a
//     small tab-table tokenizer that keys every cell by its COLUMN HEADER, never
//     by position. This handles the two proven traps at once: row order is not
//     stable between calls (§5a trap a) — we build a list keyed by each row's own
//     fields, so order is irrelevant — and a column could reorder — we map cells
//     by header name.
//
// Everything is defensive: a missing or renamed field degrades to a sane default
// (0 / null / false / []) and NEVER throws up into a caller, matching the
// persisted-state-tolerance ethos. Lost fields are left empty, not invented
// (§5a trap c): the MCP text drops the machine system_id (only the display name
// survives) and the entire lifetime `stats` block, so this parser reports
// systemId:null and stats:undefined rather than guessing them.

import type { StatusSnapshot, SystemInfo, CargoItem, PoiInfo, MarketRow } from "./client";

// --- shared primitives -----------------------------------------------------

/** Strip thousands separators from a number token before parsing ("2,750" ->
 * 2750). §5a trap b: credits and other counts carry commas. */
function toInt(token: string | undefined): number {
  if (!token) return 0;
  const n = parseInt(token.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Match a `Label: cur/max` pair anywhere in the text; returns [cur, max]. */
function pair(text: string, label: string): [number, number] {
  const m = text.match(new RegExp(`${label}:\\s*([\\d,]+)\\s*/\\s*([\\d,]+)`, "i"));
  return m ? [toInt(m[1]), toInt(m[2])] : [0, 0];
}

/**
 * Tokenize a labeled tab-table into row objects keyed by column header.
 *
 * The dashboard renders a table as: a `<Label> (<count>):` intro line, then a
 * TAB-separated HEADER row, then TAB-separated data rows, until a blank line or
 * a line that doesn't look like a data row. `split("\t")` keeps empty cells
 * (consecutive tabs => a blank column), which we rely on. Returns [] when the
 * section is absent — the caller degrades gracefully.
 */
function tabTable(text: string, sectionLabel: RegExp): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => sectionLabel.test(l));
  if (startIdx < 0) return [];
  const headerLine = lines[startIdx + 1];
  if (!headerLine || !headerLine.includes("\t")) return [];
  const columns = headerLine.split("\t").map((c) => c.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = startIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    // A data row is tab-delimited; anything else (blank line, the next section's
    // `Label (n):` intro, an overflow parenthetical) ends this table.
    if (!line.includes("\t")) break;
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    columns.forEach((col, ci) => {
      row[col] = (cells[ci] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

/** Deterministic display-name -> machine-id slug. The MCP text drops the
 * machine item_id (HTTP structuredContent had it); this transform recovers it.
 * VERIFIED against the fixture: slug(item_name) === item_id for every cargo item
 * and every market row captured ("Palladium Ore" -> "palladium_ore",
 * "EMP-Tipped Rounds Box" -> "emp_tipped_rounds_box", "Helium-3" -> "helium_3").
 * This is a verified deterministic derivation, not a guess; if a future item's
 * slug ever diverged from its id, an id-dependent path (sell) would need the id
 * from another source. */
export function slugifyItemName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// --- view_market -> MarketRow[] (buyable-here surfacing, issue #93) ---------

/** Parse a `<n>cr` price cell ("2cr", "7,732cr") to an integer, or undefined
 * for an empty cell — the market summary leaves best_buy/best_sell BLANK when
 * no standing order exists on that side, and blank must stay distinguishable
 * from 0 (a 0cr bid would still be a buyer; a blank is no buyer at all). */
function toCr(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const n = parseInt(token.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map a `view_market` text dashboard into the sell-relevant rows.
 *
 * VERIFIED shape over MCP only (the ONLY captured view_market response:
 * test/fixtures/mcp-probe-2026-07-12.json, spacemolt_market/view_market): a
 * `Market summary at <station> (<n> items):` intro line, then a tab-table with
 * header category/item_id/item_name/best_sell/best_buy/spread/sell_qty/buy_qty,
 * then non-tab footer lines (Categories/Use item_id/current_tick) that end the
 * table. Order-book semantics, confirmed against the live no-buyers episode:
 * best_buy is the standing BID — the cr/unit the market pays when YOU sell —
 * and buy_qty its demand; a held item is sellable here iff its row shows a bid
 * (best_buy present AND buy_qty > 0). palladium_ore is entirely ABSENT from
 * the captured 482-row listing at Market Prime Exchange, the exact station
 * where the pilot's palladium sells returned "0 sold (no buyers)" 38 times —
 * absence and a blank bid both mean NO buyer.
 *
 * Only the consumed fields are parsed (itemId, bestBuy, buyQty — see
 * client.ts's MarketRow); best_sell/spread/sell_qty/category/item_name are
 * real columns with no consumer yet, so they stay unparsed (no dead data, per
 * CurrentPoiInfo's precedent). Defensive like the parsers above: a missing
 * section, a shape drift, or a row without an item_id degrades to fewer/no
 * rows, never a throw — the agent surfaces an empty parse as a visible
 * market_error rather than claiming anything from missing data.
 *
 * Header guard (PR #197 review, finding 1): the table is accepted ONLY if its
 * header carries all three consumed column names (item_id, best_buy,
 * buy_qty). Without the guard, a response with the right intro and table
 * structure but a RENAMED bid column (the plausible HTTP divergence — this
 * action's HTTP rendering is uncaptured, and transports already diverge per
 * shape for get_status) parses NON-EMPTY with every bestBuy undefined and
 * buyQty 0; gatherMarket's zero-row check misses it, and the digest renders a
 * false "NO BUYER" for every held item — silently (the #175 false-fire
 * class). On a header miss we return [] so the existing zero-row branch emits
 * market_error instead. Scoped to the market parse: the status/system callers
 * of tabTable read cells defensively per-field and never invert absence into
 * a positive claim, so this hazard is theirs to guard only if they ever do.
 */
export function parseMarketText(text: string | null | undefined): MarketRow[] {
  const table = tabTable(text ?? "", /^Market summary at /i);
  // tabTable stamps every header column onto every row, so the first row's
  // keys ARE the header line; an empty table falls through to [] regardless.
  const first = table[0];
  if (!first || !("item_id" in first) || !("best_buy" in first) || !("buy_qty" in first)) return [];
  const rows: MarketRow[] = [];
  for (const row of table) {
    const itemId = row["item_id"];
    if (!itemId) continue;
    rows.push({ itemId, bestBuy: toCr(row["best_buy"]), buyQty: toInt(row["buy_qty"]) });
  }
  return rows;
}

// --- get_status -> StatusSnapshot ------------------------------------------

/**
 * Map a `get_status` text dashboard (§5a) into a StatusSnapshot — the exact
 * subset the deterministic backstops consume. Only the fields StatusSnapshot
 * defines are parsed; the players / NPCs / modules / skills / missions /
 * standings tables the dashboard also carries have no StatusSnapshot field and
 * are ignored here (skills come from get_skills separately).
 *
 * Two fields the MCP text cannot supply, left empty rather than invented:
 *   - systemId: the header carries the system NAME only ("Market Prime"), not the
 *     machine id ("market_prime") the HTTP path gave. -> null. get_system supplies
 *     the id if a caller needs it.
 *   - stats: the lifetime counters block (ore_mined, credits_earned, ...) is not
 *     rendered in the text at all. -> undefined (the no-progress detector treats
 *     that dimension as UNKNOWN and suppresses).
 */
export function parseStatusText(text: string | null | undefined): StatusSnapshot {
  const t = text ?? "";

  // Header line: `<username> [<empire>] | <credits>cr | <system_name>`. Credits
  // carry thousands separators; take the first `<n>cr` token.
  const creditsMatch = t.match(/([\d,]+)cr\b/);
  const credits = creditsMatch ? toInt(creditsMatch[1]) : 0;

  const [fuel, maxFuel] = pair(t, "Fuel");
  const [cargoUsed, cargoCapacity] = pair(t, "Cargo");
  const [hull, maxHull] = pair(t, "Hull");

  // `Docked at: <poi_id>` when docked; absent otherwise. When undocked/in-transit
  // this line differs (not captured in the fixture — the ship was docked), so
  // absence => undocked.
  const dockedMatch = t.match(/Docked at:\s*(\S+)/i);
  const dockedAt = dockedMatch ? dockedMatch[1] ?? null : null;
  const docked = dockedAt !== null;

  // in_transit marker (ASSUMED wording — the docked fixture couldn't show it).
  // Defaults false; a docked ship is never in transit.
  const inTransit = !docked && /\bin[_ ]?transit\b|traveling to\b/i.test(t);

  const cargo: CargoItem[] = tabTable(t, /^Cargo \(/i)
    .map((row) => {
      const name = row["item"] ?? "";
      const quantity = toInt(row["qty"]);
      if (!name) return null;
      return { itemId: slugifyItemName(name), name, quantity };
    })
    .filter((c): c is CargoItem => c !== null);

  return {
    credits,
    fuel,
    maxFuel,
    hull,
    maxHull,
    cargoUsed,
    cargoCapacity,
    docked,
    inTransit,
    systemId: null, // lost on the MCP text path (name-only header); see doc above.
    dockedAt,
    stats: undefined, // lifetime stats block not rendered in the text; UNKNOWN.
    cargo,
  };
}

// --- get_system -> SystemInfo ----------------------------------------------

/**
 * Map a `get_system` text dashboard (§5a) into SystemInfo.
 *
 * Header: `System: <name> (<system_id>) | Empire: <e> | Security: <text>`.
 * `POIs (n):` table columns: id, name, type, class, base, online — `base`
 * non-empty => dockable (hasBase). `Connections (n):` table columns: system_id,
 * name, distance ("326 GU") — we keep only system_id (SystemInfo.connections is
 * ids, mirroring the HTTP client which also drops distance).
 *
 * currentPoi is undefined on this path: the MCP get_system text carries no
 * current-POI marker (the HTTP path had a top-level `poi` object). A caller that
 * needs the current POI reads it from get_status's `Docked at:` (dockedAt) when
 * docked.
 */
export function parseSystemText(text: string | null | undefined): SystemInfo {
  const t = text ?? "";

  const header = t.match(/System:\s*(.+?)\s*\(([^)]+)\)/);
  const name = header ? (header[1] ?? "").trim() || null : null;
  const id = header ? (header[2] ?? "").trim() || null : null;

  const pois: PoiInfo[] = tabTable(t, /^POIs \(/i)
    .map((row): PoiInfo | null => {
      const poiId = row["id"] ?? "";
      if (!poiId) return null;
      const poi: PoiInfo = {
        id: poiId,
        name: row["name"] ?? "",
        type: row["type"] ?? "",
        hasBase: (row["base"] ?? "").length > 0,
      };
      if (row["class"]) poi.class = row["class"]; // omit when empty rather than set undefined
      return poi;
    })
    .filter((p): p is PoiInfo => p !== null);

  const connections = tabTable(t, /^Connections \(/i)
    .map((row) => row["system_id"] ?? "")
    .filter((s) => s.length > 0);

  return { id, name, connections, pois, currentPoi: undefined };
}
