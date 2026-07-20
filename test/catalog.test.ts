import { describe, expect, test } from "bun:test";
import {
  catalog,
  itemMeta,
  itemValue,
  isRecipeInput,
  loadCatalog,
  recipesUsing,
} from "../src/catalog/catalog";

// The pilot dumped palladium_ore as junk with no economic reference. These
// assertions are the regression: the vendored snapshot must resolve it as a
// valued, recipe-relevant ore. If the snapshot is refreshed and these change,
// that is a real economic shift worth noticing, not incidental.
describe("vendored snapshot resolves known item economics", () => {
  test("palladium_ore value + metadata", () => {
    expect(itemValue("palladium_ore")).toBe(200);
    const meta = itemMeta("palladium_ore");
    expect(meta).toBeDefined();
    expect(meta?.category).toBe("ore");
    expect(meta?.rarity).toBe("rare");
    expect(meta?.tradeable).toBe(true);
    expect(meta?.extracted_by).toBe("mining");
  });

  test("palladium_ore is a recipe input across its known recipes", () => {
    expect(isRecipeInput("palladium_ore")).toBe(true);
    const ids = recipesUsing("palladium_ore").map((r) => r.id);
    // 5 recipes consume it (2026-07-12 snapshot); assert the superconductor +
    // focused_crystal ones the issue calls out, without pinning the exact count
    // so a catalog that adds a 6th recipe doesn't fail spuriously.
    expect(ids).toContain("create_superconductor");
    expect(ids).toContain("create_silver_superconductor");
    expect(ids).toContain("focus_energy_crystal");
    expect(recipesUsing("palladium_ore").length).toBeGreaterThanOrEqual(3);
  });

  test("recipe outputs are indexed and point back at real items", () => {
    const superconductor = recipesUsing("palladium_ore").find(
      (r) => r.id === "create_superconductor",
    );
    expect(superconductor?.outputs.map((o) => o.item_id)).toContain("superconductor");
    // the produced item is itself in the catalog (crafting value chain intact)
    expect(itemValue("superconductor")).toBeGreaterThan(0);
  });

  // Broken-fuel-chain fix (issue #152): items() is the query surface the
  // low-fuel briefing (digest.ts) and the buy-id correction (executor.ts)
  // consume -- the catalog's consume-or-delete condition from the #93 council
  // review is satisfied by these consumers. The REAL vendored snapshot must
  // resolve the purchasable fuel consumables, and must NOT contain the plural
  // the pilot guessed in all 86 failed buys.
  test("fuel-cell query surfaces the purchasable consumables; the guessed plural is not an item", () => {
    const ids = catalog.items()
      .filter((i) => i.category === "consumable" && i.id.includes("fuel_cell"))
      .map((i) => i.id);
    expect(ids).toContain("fuel_cell");
    expect(ids).toContain("premium_fuel_cell");
    expect(ids).toContain("military_fuel_cell");
    expect(itemValue("fuel_cell")).toBe(43);
    expect(itemMeta("fuel_cells")).toBeUndefined(); // the 86-failure guess
  });

  test("snapshot loaded a substantial index and records its provenance", () => {
    expect(catalog.itemCount).toBeGreaterThan(500);
    expect(catalog.recipeCount).toBeGreaterThan(500);
    expect(catalog.meta.fetched).toBe("2026-07-12");
  });
});

describe("unknown ids degrade to empty, never throw", () => {
  test("missing item -> undefined / false / []", () => {
    expect(itemValue("no_such_item_xyz")).toBeUndefined();
    expect(itemMeta("no_such_item_xyz")).toBeUndefined();
    expect(isRecipeInput("no_such_item_xyz")).toBe(false);
    expect(recipesUsing("no_such_item_xyz")).toEqual([]);
  });

  test("item with no base_value resolves meta but undefined value", () => {
    // a future/partial catalog entry may omit base_value (the loader is
    // schema-tolerant); itemValue must return undefined rather than 0 or throw.
    const c = loadCatalog({
      items: [{ id: "beam_laser", name: "Beam Laser", category: "weapon" }],
    });
    expect(c.itemMeta("beam_laser")?.name).toBe("Beam Laser");
    expect(c.itemValue("beam_laser")).toBeUndefined();
  });
});

describe("schema tolerance: partial and garbage catalogs never throw", () => {
  test("garbage entries are skipped, valid siblings survive", () => {
    const c = loadCatalog({
      items: [
        { id: "good_ore", name: "Good Ore", base_value: 50 },
        { name: "no id here" }, // no string id -> dropped
        null, // -> dropped
        42, // -> dropped
        { id: 7, name: "numeric id" }, // id not a string -> dropped
      ],
    });
    expect(c.itemCount).toBe(1);
    expect(c.itemValue("good_ore")).toBe(50);
  });

  test("a single mistyped field degrades that field, keeps the item", () => {
    const c = loadCatalog({
      items: [
        {
          id: "weird_ore",
          name: "Weird Ore",
          base_value: "two hundred", // wrong type -> field dropped, item kept
          rarity: 5, // wrong type -> field dropped
          category: "ore", // still good
          bogus_new_field: true, // unknown -> ignored
        },
      ],
    });
    const meta = c.itemMeta("weird_ore");
    expect(meta).toBeDefined();
    expect(meta?.category).toBe("ore");
    expect(meta?.base_value).toBeUndefined();
    expect(meta?.rarity).toBeUndefined();
    expect(c.itemValue("weird_ore")).toBeUndefined();
  });

  test("recipe with garbage input rows keeps the well-formed ones", () => {
    const c = loadCatalog({
      recipes: [
        {
          id: "mix",
          inputs: [
            { item_id: "a", quantity: 2 },
            { quantity: 3 }, // no item_id -> dropped
            "not an object", // -> dropped
            { item_id: "b" }, // quantity optional -> kept
          ],
          outputs: [{ item_id: "c", quantity: 1 }],
        },
        { name: "recipe with no id" }, // whole recipe dropped
      ],
    });
    expect(c.isRecipeInput("a")).toBe(true);
    expect(c.isRecipeInput("b")).toBe(true);
    expect(c.recipesUsing("a")[0]?.inputs.length).toBe(2);
    expect(c.recipe("mix")?.outputs[0]?.item_id).toBe("c");
  });

  test("missing / non-array / empty top-level yields an empty index", () => {
    for (const raw of [{}, { items: "nope", recipes: 3 }, null, undefined, "garbage"]) {
      const c = loadCatalog(raw);
      expect(c.itemCount).toBe(0);
      expect(c.recipeCount).toBe(0);
      expect(c.isRecipeInput("anything")).toBe(false);
      expect(c.recipesUsing("anything")).toEqual([]);
    }
  });
});
