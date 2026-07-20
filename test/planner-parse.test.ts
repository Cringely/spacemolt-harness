import { describe, expect, test } from "bun:test";
import { tryParsePlan } from "../src/planner/parse";

const validPlanJson = JSON.stringify({ goal: "mine", steps: [{ action: "mine", params: {} }] });

describe("tryParsePlan", () => {
  // F-2 ground truth: haiku wrapped its plan JSON in a markdown code fence
  // ("```json ... ```"), and JSON.parse failed with "not valid JSON:
  // Unrecognized token '`'" on both the original attempt and the retry.
  test("strips a ```json fence before parsing", () => {
    const fenced = "```json\n" + validPlanJson + "\n```";
    const result = tryParsePlan(fenced);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.goal).toBe("mine");
  });

  test("strips a bare ``` fence (no language tag) before parsing", () => {
    const fenced = "```\n" + validPlanJson + "\n```";
    const result = tryParsePlan(fenced);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.goal).toBe("mine");
  });

  test("unfenced valid JSON still parses (no regression)", () => {
    const result = tryParsePlan(validPlanJson);
    expect(result.ok).toBe(true);
  });

  test("fenced garbage still fails cleanly with the same error shape", () => {
    const result = tryParsePlan("```json\nnot json at all\n```");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("valid JSON that fails schema validation still reports a validation error", () => {
    const result = tryParsePlan(JSON.stringify({ goal: "x", steps: [] })); // empty steps: invalid
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("not valid JSON"); // it parsed fine, schema rejected it
  });
});
