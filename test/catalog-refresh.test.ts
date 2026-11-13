import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { trimCatalog, CATALOG_PATH } from "../scripts/refresh-catalog";
import { catalog, loadCatalog } from "../src/catalog/catalog";

// Cringely/spacemolt#1152: nothing regenerated src/catalog/catalog.data.json,
// so the snapshot fell 214 versions behind and a pilot held an item it did not
// know. scripts/refresh-catalog.ts is that path; these pin its output shape
// against the vendored file and its refusal to vendor a hollow payload.
const vendoredText = readFileSync(CATALOG_PATH, "utf8");
const vendored = JSON.parse(vendoredText) as { fetched: string };

describe("scripts/refresh-catalog.ts trimCatalog", () => {
  // The upstream file also carries ships/skills/etc. and extra per-item fields;
  // trimming the vendored snapshot again must reproduce it byte for byte, so a
  // real refresh diff shows only what the game changed.
  test("re-trimming the vendored snapshot reproduces it exactly", () => {
    const out = trimCatalog(JSON.parse(vendoredText), vendored.fetched);
    expect(JSON.stringify(out, null, 2)).toBe(vendoredText);
  });

  test("drops unused fields and sibling sections, sorts by id, skips entries with no id", () => {
    const out = trimCatalog({
      version: "9.9.9",
      ships: [{ id: "x" }],
      items: [
        { id: "b_ore", name: "B", base_value: 5, equipment_stats: { power: 1 } },
        { name: "no id" },
        { id: "a_ore", name: "A" },
      ],
      recipes: [{ id: "r", name: "R", inputs: [], outputs: [], hidden: true }],
    }, "2030-01-01") as { items: Array<Record<string, unknown>>; recipes: unknown[]; version: string; fetched: string };
    expect(out.items).toEqual([{ id: "a_ore", name: "A" }, { id: "b_ore", name: "B", base_value: 5 }]);
    expect(out.recipes).toEqual([{ id: "r", name: "R", inputs: [], outputs: [] }]);
    expect(out.version).toBe("9.9.9");
    expect(out.fetched).toBe("2030-01-01");
    expect(loadCatalog(out).itemCount).toBe(2);
  });

  // Present-but-empty is what a CDN hiccup or a changed schema returns; writing
  // it would blank the vendored catalog and reject every item id at admission.
  test("fails closed on a missing/empty payload instead of producing a hollow snapshot", () => {
    const recipes = [{ id: "r", inputs: [], outputs: [] }];
    expect(() => trimCatalog({ version: "1", items: [], recipes }, "d")).toThrow(/items/);
    expect(() => trimCatalog({ version: "1", items: [{ id: "a" }], recipes: [] }, "d")).toThrow(/recipes/);
    expect(() => trimCatalog({ items: [{ id: "a" }], recipes }, "d")).toThrow(/version/);
    expect(() => trimCatalog(null, "d")).toThrow();
  });
});

describe("vendored catalog freshness", () => {
  // Same 90-day precedent as test/registry-conformance.test.ts's fixture check.
  // A failure means: run `bun run scripts/refresh-catalog.ts` and review the diff.
  test("snapshot was fetched within the last 90 days", () => {
    const fetched = catalog.meta.fetched;
    expect(fetched).toBeDefined();
    const ageDays = (Date.now() - new Date(fetched!).getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeLessThan(90);
  });
});
