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
