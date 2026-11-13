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

  // PR #156 (zod 3 -> 4): a failed `.int()` aborts its union member in zod 4, so
  // a plain z.union reported every member's errors -- 23-33 KB (~7k tokens) in
  // the planner's retry prompt, burying the one bad field. zod 3 gave ~250
  // chars. The step union is discriminated on `action` so a KNOWN action with
  // bad params reports only that action's failing path. The caps below sit far
  // under the regression (23 KB) and above the targeted output (~600 chars).
  describe("step param errors stay small and name the failing path", () => {
    const stepPlan = (step: Record<string, unknown>) =>
      JSON.stringify({ goal: "g", steps: [step] });
    type Issue = { path: (string | number)[] };
    const issuePaths = (error: string) =>
      (JSON.parse(error) as Issue[]).map((i) => i.path.join("."));

    test("fractional quantity: small error naming steps.0.params.quantity", () => {
      const r = tryParsePlan(stepPlan({ action: "sell", params: { id: "ore", quantity: 2.5 } }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.length).toBeLessThan(1500);
      expect(issuePaths(r.error)).toEqual(["steps.0.params.quantity"]);
    });

    test("infinite quantity (1e400): small error naming steps.0.params.quantity", () => {
      const r = tryParsePlan(
        `{"goal":"g","steps":[{"action":"sell","params":{"id":"ore","quantity":1e400}}]}`,
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.length).toBeLessThan(1500);
      expect(issuePaths(r.error)).toEqual(["steps.0.params.quantity"]);
    });

    test("fractional repeat: small error naming steps.0.repeat", () => {
      const r = tryParsePlan(stepPlan({ action: "mine", params: {}, repeat: 1.5 }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.length).toBeLessThan(1500);
      expect(issuePaths(r.error)).toEqual(["steps.0.repeat"]);
    });

    test("unknown action: names steps.0.action and still lists the valid actions", () => {
      const r = tryParsePlan(stepPlan({ action: "warp_drive", params: {} }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.length).toBeLessThan(4000);
      expect(issuePaths(r.error)).toEqual(["steps.0.action"]);
      // The planner needs the vocabulary to correct itself: a registry
      // mutation and the executor-only travel_to must both be offered.
      expect(r.error).toContain("'mine'");
      expect(r.error).toContain("'travel_to'");
    });
  });

  test("valid JSON that fails schema validation still reports a validation error", () => {
    const result = tryParsePlan(JSON.stringify({ goal: "x", steps: [] })); // empty steps: invalid
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("not valid JSON"); // it parsed fine, schema rejected it
  });
});
