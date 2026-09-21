import { z } from "zod";
import rawCatalog from "./catalog.data.json";

// Item-economics SSOT. The game publishes an authoritative catalog at
// https://game.spacemolt.com/api/catalog.json; we vendor a trimmed snapshot
// (src/catalog/catalog.data.json) and read item value / recipe membership from it so
// jettison/sell/haul decisions are data-driven, not reactions to one market's
// silence. (The pilot dumped palladium_ore -- base_value 200, rare, input to 5
// recipes -- as junk because we had no reference.)
//
// SCHEMA TOLERANCE is the whole point of this loader. The catalog WILL evolve:
// fields get renamed, added, or dropped, and a stored snapshot outlives the
// schema that wrote it. So every field except the item/recipe `id` is optional
// and individually .catch()'d to undefined -- a mistyped or renamed field
// degrades that one field, it does not drop the entry. A whole entry is
// skipped only if it has no string `id` (nothing to key on). A catalog whose
// top-level `items`/`recipes` are missing or non-arrays yields an empty index.
// The loader never throws on a partial or garbage catalog.

export interface ItemMeta {
  id: string;
  name?: string;
  category?: string;
  base_value?: number;
  rarity?: string;
  tradeable?: boolean;
  extracted_by?: string;
}

export interface RecipeIO {
  item_id: string;
  quantity?: number;
}

export interface Recipe {
  id: string;
  name?: string;
  inputs: RecipeIO[];
  outputs: RecipeIO[];
}

// Leaf schemas. Non-id fields are optional+catch so a bad value nulls the
// field rather than rejecting the record. Unknown fields are stripped (zod's
// default), which is exactly "ignore fields we don't use".
const ItemSchema = z.object({
  id: z.string(),
  name: z.string().optional().catch(undefined),
  category: z.string().optional().catch(undefined),
  base_value: z.number().optional().catch(undefined),
  rarity: z.string().optional().catch(undefined),
  tradeable: z.boolean().optional().catch(undefined),
  extracted_by: z.string().optional().catch(undefined),
});

const RecipeCoreSchema = z.object({
  id: z.string(),
  name: z.string().optional().catch(undefined),
});

const IOSchema = z.object({
  item_id: z.string(),
  quantity: z.number().optional().catch(undefined),
});

function parseIOList(raw: unknown): RecipeIO[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeIO[] = [];
  for (const el of raw) {
    const p = IOSchema.safeParse(el);
    if (p.success) out.push(p.data);
  }
  return out;
}

function parseRecipe(raw: unknown): Recipe | undefined {
  const core = RecipeCoreSchema.safeParse(raw);
  if (!core.success) return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    id: core.data.id,
    name: core.data.name,
    inputs: parseIOList(obj.inputs),
    outputs: parseIOList(obj.outputs),
  };
}

export interface CatalogMeta {
  version?: string;
  fetched?: string;
}

/**
 * In-memory item-economics index built from a (possibly partial) raw catalog.
 * Construct via {@link loadCatalog}; the default singleton `catalog` is built
 * from the vendored snapshot.
 */
export class Catalog {
  readonly meta: CatalogMeta;
  private readonly itemsById = new Map<string, ItemMeta>();
  private readonly recipesById = new Map<string, Recipe>();
  private readonly recipesByInput = new Map<string, Recipe[]>();

  constructor(raw: unknown) {
    const root = (raw ?? {}) as Record<string, unknown>;
    this.meta = {
      version: typeof root.version === "string" ? root.version : undefined,
      fetched: typeof root.fetched === "string" ? root.fetched : undefined,
    };

    const rawItems = Array.isArray(root.items) ? root.items : [];
    for (const el of rawItems) {
      const p = ItemSchema.safeParse(el);
      if (!p.success) continue; // no string id -> unusable, skip
      this.itemsById.set(p.data.id, p.data);
    }

    const rawRecipes = Array.isArray(root.recipes) ? root.recipes : [];
    for (const el of rawRecipes) {
      const r = parseRecipe(el);
      if (!r) continue;
      this.recipesById.set(r.id, r);
      for (const input of r.inputs) {
        const list = this.recipesByInput.get(input.item_id);
        if (list) list.push(r);
        else this.recipesByInput.set(input.item_id, [r]);
      }
    }
  }

  /** Reference base_value for an item, or undefined if unknown/unvalued. */
  itemValue(id: string): number | undefined {
    return this.itemsById.get(id)?.base_value;
  }

  /** Full known metadata for an item, or undefined if not in the catalog. */
  itemMeta(id: string): ItemMeta | undefined {
    return this.itemsById.get(id);
  }

  /** True if the item is an input to any known recipe (crafting-relevant). */
  isRecipeInput(id: string): boolean {
    return this.recipesByInput.has(id);
  }

  /** Every recipe that consumes this item as an input (empty if none). */
  recipesUsing(id: string): Recipe[] {
    return this.recipesByInput.get(id) ?? [];
  }

  /** Recipe by id, or undefined. */
  recipe(id: string): Recipe | undefined {
    return this.recipesById.get(id);
  }

  /**
   * Every usable item in the index (snapshot order). The catalog-wide query
   * surface for consumers that need to SEARCH the catalog rather than look up
   * one known id: the low-fuel briefing reads the purchasable fuel-cell ids
   * from here (issue #152 -- ids come from the SSOT, never from game prose),
   * and the executor's buy-id correction nearest-matches a rejected id
   * against these. Returns a fresh array; the internal index stays private.
   */
  items(): ItemMeta[] {
    return [...this.itemsById.values()];
  }

  /** Count of usable items indexed (diagnostics/logging). */
  get itemCount(): number {
    return this.itemsById.size;
  }

  /** Count of usable recipes indexed (diagnostics/logging). */
  get recipeCount(): number {
    return this.recipesById.size;
  }
}

/** Build a Catalog index from an arbitrary raw object (never throws). */
export function loadCatalog(raw: unknown): Catalog {
  return new Catalog(raw);
}

/** Default item-economics SSOT, built from the vendored snapshot. */
export const catalog = loadCatalog(rawCatalog);

// Convenience free functions bound to the default snapshot -- the API the
// backlog (jettison-gating #94, view_market #93, crafting) consumes.
export const itemValue = (id: string): number | undefined => catalog.itemValue(id);
export const itemMeta = (id: string): ItemMeta | undefined => catalog.itemMeta(id);
export const isRecipeInput = (id: string): boolean => catalog.isRecipeInput(id);
export const recipesUsing = (id: string): Recipe[] => catalog.recipesUsing(id);

// Which params carry an ITEM id, shared by the offline eval (eval/scorers.ts's
// knownItemId) and the runtime plan-admission guard (agent/normalize-plan.ts's
// normalizePlanItems, issue #982/#1003/#1054) -- one SSOT instead of the two
// hand-maintained copies the #1054 triage found (the eval had it, runtime did
// not check withdraw/deposit at all). install_mod/uninstall_mod are
// deliberately EXCLUDED: their `id` accepts a module type id OR a fitted-module
// INSTANCE id from get_ship (registry/actions.ts, upstream openapi-v1
// uninstall_mod description), and an instance id is not a catalog key --
// checking them would manufacture false failures. deposit's item_id is
// OPTIONAL on our side (registry/actions.ts's gift-form refinement), so a
// deposit gift step (target+credits, no item_id) is simply not checked -- the
// consumer below only checks a param that is actually present as a string.
export const ITEM_PARAM_BY_ACTION: Record<string, string> = {
  buy: "id",
  sell: "id",
  jettison: "id",
  create_sell_order: "item_id",
  create_buy_order: "item_id",
  withdraw: "item_id",
  deposit: "item_id",
};

// Nearest-match correction for a fabricated item id (issue #152's buy-id
// correction, promoted from executor.ts to this shared module by #982/#1003
// so normalize-plan.ts's plan-admission guard can reuse the same algorithm
// instead of a second copy). Exact singular/plural strip first: the live
// incident class, and deterministic when several ids sit within distance 1.
// Returns undefined when nothing is within one edit -- an outright
// fabrication like 'wreck' or 'exotic_matter_sample' has no real near match,
// and guessing one would hand the planner a wrong id with false confidence.
export function nearestCatalogItemId(attempted: string): string | undefined {
  const stripped = attempted.replace(/s$/, "");
  if (stripped !== attempted && catalog.itemMeta(stripped)) return stripped;
  for (const item of catalog.items()) {
    if (withinEditDistanceOne(attempted, item.id)) return item.id;
  }
  return undefined;
}

// True when a and b differ by at most one insert/delete/substitute.
function withinEditDistanceOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (s.length === l.length) i++; // substitution consumes both
    j++; // insert/delete consumes only the longer
  }
  return edits + (l.length - j) <= 1;
}
