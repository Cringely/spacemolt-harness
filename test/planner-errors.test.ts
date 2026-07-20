import { describe, expect, test } from "bun:test";
import { classifyClaudeFailure } from "../src/planner/errors";

describe("classifyClaudeFailure - structured JSON envelope (primary path)", () => {
  // VERIFIED fixture: captured 2026-07-10 from a deliberately invalid token
  // run against a clean container (zero usage spent). This is the CLI's real
  // failure shape, not a guess -- see docs/wiki/first-flight-checklist.md #1.
  test("verified 401 fixture (api_error_status) classifies as token_invalid", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      duration_ms: 2111,
      duration_api_ms: 0,
      num_turns: 1,
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
      stop_reason: "stop_sequence",
      session_id: "de1fe80c-08d8-40bf-9bc7-36708f468ca5",
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      terminal_reason: "api_error",
    });
    expect(classifyClaudeFailure(stdout)).toBe("token_invalid");
  });

  // EXPECTED, not verified: no real 429 has occurred yet -- inducing one
  // would burn actual rate-limit budget. Shape mirrors the verified 401
  // fixture with api_error_status swapped. Watch the first natural
  // planner_subscription_limit event per docs/wiki/first-flight-checklist.md
  // #1; if a real 429 instead lands as planner_error/planner_transient, this
  // branch missed and needs adjusting against the real payload.
  test("429 api_error_status classifies as subscription_limit (EXPECTED, unverified)", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "Claude AI usage limit reached. Try again later.",
      terminal_reason: "api_error",
      total_cost_usd: 0,
    });
    expect(classifyClaudeFailure(stdout)).toBe("subscription_limit");
  });
});

// FALLBACK PATH coverage: these all pass plain, non-JSON stdout, which is the
// only branch that still reaches the ASSUMED text-pattern matching in
// classifyByText (src/planner/errors.ts) -- the process-level-failure case
// where the CLI never emitted a JSON envelope at all.
describe("classifyClaudeFailure - text-pattern fallback (non-JSON stdout)", () => {
  test("recognizes token/auth failures", () => {
    expect(classifyClaudeFailure("Error: Invalid OAuth token")).toBe("token_invalid");
    expect(classifyClaudeFailure("401 Unauthorized")).toBe("token_invalid");
  });

  test("recognizes subscription/usage-limit failures", () => {
    expect(classifyClaudeFailure("You've reached your usage limit. Resets at 5pm.")).toBe("subscription_limit");
    expect(classifyClaudeFailure("rate limit exceeded")).toBe("subscription_limit");
  });

  test("defaults everything else to transient", () => {
    expect(classifyClaudeFailure("connection reset by peer")).toBe("transient");
    expect(classifyClaudeFailure("")).toBe("transient");
  });
});
