import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { REGISTRY } from "../src/registry/actions";
import slim from "./fixtures/openapi-slim.json";

const fixture = slim as unknown as Record<string, { required: string[]; properties: string[] }>;

test("fixture was regenerated within the last 90 days", () => {
  const generatedAt = (slim as Record<string, unknown>).__generated__ as string | undefined;
  if (!generatedAt) return; // pre-marker fixture; nothing to check yet
  const ageDays = (Date.now() - new Date(generatedAt).getTime()) / (24 * 60 * 60 * 1000);
  expect(ageDays).toBeLessThan(90); // stale fixture means the game API may have drifted unnoticed
});

describe("registry conforms to OpenAPI spec", () => {
  for (const a of REGISTRY) {
    test(`${a.tool}/${a.name}`, () => {
      // spacemolt_catalog (issue #219) is the one route with NO action segment:
      // its spec path is the bare `/api/v2/spacemolt_catalog`, so its registry
      // name is "" (CATALOG_ACTION) and the key must not carry a trailing slash.
      // Same shape the commands.md generator and SpacemoltHttp.call both build.
      const entry = fixture[`/api/v2/${a.tool}${a.name ? `/${a.name}` : ""}`];
      expect(entry).toBeDefined(); // action exists in the game API
      const shape = (a.params as z.ZodObject<z.ZodRawShape>).shape;
      // every param we send is a real param
      for (const key of Object.keys(shape)) {
        expect(entry!.properties).toContain(key);
      }
      // every param the API requires, we require (not optional in our schema)
      for (const req of entry!.required) {
        const field = shape[req];
        expect(field).toBeDefined();
        expect(field!.isOptional()).toBe(false);
      }
    });
  }
});
