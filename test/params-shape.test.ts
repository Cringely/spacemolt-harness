import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { describeParamsShape } from "../src/registry/params-shape";
import { getAction } from "../src/registry/actions";

describe("describeParamsShape", () => {
  test("empty params -> empty field list", () => {
    expect(describeParamsShape(getAction("dock").params)).toEqual([]);
  });

  test("single required string field", () => {
    expect(describeParamsShape(getAction("jump").params)).toEqual([
      { name: "id", type: "string", optional: false },
    ]);
  });

  test("required string + number fields, in declaration order", () => {
    expect(describeParamsShape(getAction("sell").params)).toEqual([
      { name: "id", type: "string", optional: false },
      { name: "quantity", type: "number", optional: false },
    ]);
  });

  test("optional number/array/boolean fields (get_notifications covers all three)", () => {
    expect(describeParamsShape(getAction("get_notifications").params)).toEqual([
      { name: "limit", type: "number", optional: true },
      { name: "types", type: "string[]", optional: true },
      { name: "clear", type: "boolean", optional: true },
    ]);
  });

  test("throws loudly on an unsupported zod construct instead of mis-describing it", () => {
    const nested = z.object({ inner: z.object({ x: z.string() }) }).strict();
    expect(() => describeParamsShape(nested)).toThrow();
  });

  test("throws on a non-object schema", () => {
    expect(() => describeParamsShape(z.string())).toThrow();
  });
});
