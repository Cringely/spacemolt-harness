/**
 * Refreshes src/catalog/catalog.data.json, the vendored item/recipe snapshot
 * that plan admission and the economics lookups read (src/catalog/catalog.ts).
 *
 *   bun run scripts/refresh-catalog.ts
 *
 * NETWORK: one read-only GET of the game's public, auth-free catalog
 * (https://game.spacemolt.com/api/catalog.json, ETag'd; docs/game-reference/
 * upstream/api.md). No session, no game action. It overwrites the snapshot, so
 * review the diff before committing it, same gate as scripts/refresh-openapi.ts.
 *
 * Run it when a `catalog_drift` event shows up in the event feed (the agent
 * admitted an item id the pilot's cargo or the docked market reported but this
 * snapshot lacks, Cringely/spacemolt#1152), or when test/catalog-refresh.test.ts
 * says the snapshot is more than 90 days old. The game ships items faster than
 * we re-vendor: the snapshot fell 214 versions behind in four months.
 *
 * The trimmed shape is what catalog.ts reads and nothing more: items keep
 * id/name/category/base_value/rarity/tradeable/extracted_by, recipes keep
 * id/name/inputs/outputs, both alphabetical by id so a refresh diff shows only
 * what the game changed. The upstream field names are carried over from the
 * snapshot that PR 165 reproduced by hand from the live file, not re-captured
 * here: if a first live run throws below, upstream renamed something, so fix
 * the picks rather than loosening the guards.
 */
import { loadCatalog } from "../src/catalog/catalog";

export const CATALOG_URL = "https://game.spacemolt.com/api/catalog.json";
export const CATALOG_PATH = "src/catalog/catalog.data.json";

// The full upstream file also carries ships, skills, facilities and
// achievements. A response far past this is not the catalog we expect.
const MAX_BYTES = 50 * 1024 * 1024;

const ITEM_FIELDS = ["id", "name", "category", "base_value", "rarity", "tradeable", "extracted_by"] as const;
const RECIPE_FIELDS = ["id", "name", "inputs", "outputs"] as const;

type Rec = Record<string, unknown>;

function trimAll(list: unknown, fields: readonly string[]): Rec[] {
  if (!Array.isArray(list)) return [];
  const out: Rec[] = [];
  for (const el of list) {
    // An entry with no string id cannot be keyed (catalog.ts skips it too).
    if (typeof (el as Rec | null)?.id !== "string") continue;
    const src = el as Rec;
    const picked: Rec = {};
    for (const f of fields) if (src[f] !== undefined) picked[f] = src[f];
    out.push(picked);
  }
  return out.sort((a, b) => (a.id as string).localeCompare(b.id as string, "en"));
}

/**
 * Pure: raw upstream catalog -> the trimmed snapshot object. FAILS CLOSED: a
 * payload whose items or recipes are missing or empty, or with no string
 * version, throws instead of producing a snapshot that would wipe the vendored
 * one (a present-but-empty response is what a CDN hiccup actually returns).
 */
export function trimCatalog(raw: unknown, fetched: string): Rec {
  const root = (raw ?? {}) as Rec;
  if (typeof root.version !== "string") throw new Error("catalog payload has no string `version`");
  const items = trimAll(root.items, ITEM_FIELDS);
  const recipes = trimAll(root.recipes, RECIPE_FIELDS);
  if (!items.length) throw new Error("catalog payload has no usable `items`");
  if (!recipes.length) throw new Error("catalog payload has no usable `recipes`");
  return {
    version: root.version,
    fetched,
    source: CATALOG_URL,
    note:
      "Trimmed snapshot. items keep id/name/category/base_value/rarity/tradeable/extracted_by; " +
      "recipes keep id/name/inputs/outputs. The full catalog also carries ships/skills/facilities/" +
      "achievements and per-item equipment stats, dropped here.",
    items,
    recipes,
  };
}

if (import.meta.main) {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`GET ${CATALOG_URL} -> HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`catalog response is ${text.length} bytes, over the ${MAX_BYTES} cap`);
  const snapshot = trimCatalog(JSON.parse(text), new Date().toISOString().slice(0, 10));
  // Round-trip through the real loader before writing: what we are about to
  // vendor must index to the counts we trimmed.
  const loaded = loadCatalog(snapshot);
  if (loaded.itemCount !== (snapshot.items as Rec[]).length) throw new Error("trimmed items do not all index");
  await Bun.write(CATALOG_PATH, JSON.stringify(snapshot, null, 2)); // no trailing newline, matching the vendored file byte for byte
  console.log(`wrote ${CATALOG_PATH}: v${snapshot.version}, ${loaded.itemCount} items, ${loaded.recipeCount} recipes`);
}
