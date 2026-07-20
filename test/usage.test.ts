import { describe, expect, test } from "bun:test";
import {
  summarizeUsage, creditsSeries, planRateSeries, deployMarkers, wakeReasonAlert,
  USAGE_WINDOW_HOURS, WAKE_REASON_ALERT_SHARE,
} from "../src/server/usage";
import type { AgentEvent } from "../src/store/store";

function ev(id: number, type: string, payload: unknown): AgentEvent & { id: number } {
  return { id, agentId: "a1", ts: id, type, payload };
}

// Explicit-timestamp event (the id-as-ts helper above only works for tiny ids;
// the windowed series functions need real epoch offsets).
function evAt(ts: number, type: string, payload: unknown): AgentEvent & { id: number } {
  return { id: ts, agentId: "a1", ts, type, payload };
}

describe("summarizeUsage", () => {
  test("counts wake events into replanAttempts and a wake-reason histogram", () => {
    const events = [
      ev(1, "wake", { reason: "heartbeat" }),
      ev(2, "wake", { reason: "low_fuel" }),
      ev(3, "wake", { reason: "heartbeat" }),
      ev(4, "action", { action: "mine" }), // not a wake -- must not appear in the histogram
    ];
    const summary = summarizeUsage("a1", events);
    expect(summary.agentId).toBe("a1");
    expect(summary.windowHours).toBe(USAGE_WINDOW_HOURS);
    expect(summary.replanAttempts).toBe(3);
    expect(summary.wakeReasonHistogram).toEqual({ heartbeat: 2, low_fuel: 1 });
  });

  test("falls back to 'unknown' for a wake payload missing reason (defensive -- not expected from evaluateWake)", () => {
    const summary = summarizeUsage("a1", [ev(1, "wake", {})]);
    expect(summary.wakeReasonHistogram).toEqual({ unknown: 1 });
  });

  test("tokens are null when no plan event carries char counts (dashboard shows 'not available', not a misleading zero)", () => {
    const summary = summarizeUsage("a1", [ev(1, "wake", { reason: "heartbeat" }), ev(2, "plan", { goal: "g" })]);
    expect(summary.tokensIn).toBeNull();
    expect(summary.tokensOut).toBeNull();
  });

  test("estimates tokens from captured prompt/response chars on plan events (chars/4)", () => {
    const summary = summarizeUsage("a1", [
      ev(1, "plan", { goal: "g", model: "sonnet", promptChars: 400, responseChars: 80 }),
      ev(2, "plan", { goal: "g", model: "sonnet", promptChars: 200, responseChars: 40 }),
    ]);
    expect(summary.tokensIn).toBe(150); // (400+200)/4
    expect(summary.tokensOut).toBe(30); // (80+40)/4
  });

  test("empty event list yields zeroed counts and null tokens", () => {
    const summary = summarizeUsage("a1", []);
    expect(summary.replanAttempts).toBe(0);
    expect(summary.wakeReasonHistogram).toEqual({});
    expect(summary.tokensIn).toBeNull();
    expect(summary.tokensOut).toBeNull();
    expect(summary.planRatePerHour).toBe(0);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.callsPerModel).toEqual({});
  });

  // Layer 5 metrics from a seeded events fixture. Each assertion below fails on
  // a distinct breakage: calls-per-model bucketing, the cost estimate
  // (chars->tokens->price table), and the planner-error rate. `now` is fixed so
  // the trailing-hour plan rate is deterministic.
  const HOUR = 60 * 60 * 1000;
  test("computes calls-per-model, cost estimate, and planner-error rate from a mixed fixture", () => {
    const now = 10 * HOUR;
    const summary = summarizeUsage("a1", [
      ev(1, "wake", { reason: "no_plan" }),
      ev(2, "plan", { goal: "g", model: "sonnet", promptChars: 4000, responseChars: 800 }),
      ev(3, "wake", { reason: "heartbeat" }),
      ev(4, "plan", { goal: "g", model: "opus", promptChars: 4000, responseChars: 800 }),
      ev(5, "planner_error", { message: "bad json" }),
      ev(6, "plan", { goal: "g", model: "llama3.1:8b", promptChars: 4000, responseChars: 800 }), // local -> free
    ], now);
    expect(summary.callsPerModel).toEqual({ sonnet: 1, opus: 1, "llama3.1:8b": 1 });
    // Cost: sonnet 1000in/200out tok @ 3/15 per Mtok = 0.003 + 0.003 = 0.006;
    // opus @ 15/75 = 0.015 + 0.015 = 0.030; local model priced free.
    expect(summary.estimatedCostUsd).toBeCloseTo(0.006 + 0.03, 6);
    expect(summary.estimatedCostUsdPerDay).toBeCloseTo(summary.estimatedCostUsd, 6); // window is 24h
    // 1 error out of 4 attempts (3 plans + 1 error).
    expect(summary.plannerErrors).toBe(1);
    expect(summary.plannerErrorRate).toBeCloseTo(1 / 4, 10);
  });

  // planRatePerHour is a TRAILING-hour count so a recent burst is visible
  // against the 4-10/hr target, where a flat plans/24 average would hide it.
  test("planRatePerHour counts only plan events in the trailing hour", () => {
    const now = 10 * HOUR;
    const summary = summarizeUsage("a1", [
      ev(now - 3 * HOUR, "plan", { goal: "g", model: "sonnet" }), // old -> excluded
      ev(now - 40 * 60 * 1000, "plan", { goal: "g", model: "sonnet" }), // 40 min ago -> counted
      ev(now - 10 * 60 * 1000, "plan", { goal: "g", model: "sonnet" }), // 10 min ago -> counted
      ev(now - 1000, "plan", { goal: "g", model: "sonnet" }), // just now -> counted
    ], now);
    expect(summary.planRatePerHour).toBe(3); // 3 of 4 plans fall in the trailing hour
  });

  test("credits-over-time series is drawn from status_snapshot events, ascending, skipping non-numeric", () => {
    const series = creditsSeries([
      ev(10, "status_snapshot", { credits: 100, fuel: 50 }),
      ev(20, "action", { action: "mine" }), // not a snapshot -> ignored
      ev(30, "status_snapshot", { credits: 340 }),
      ev(40, "status_snapshot", { fuel: 10 }), // no credits -> dropped, not charted as 0
    ]);
    expect(series).toEqual([
      { ts: 10, credits: 100 },
      { ts: 30, credits: 340 },
    ]);
  });

  test("an unknown/local model contributes zero cost but still counts as a call (free fallback price)", () => {
    const summary = summarizeUsage("a1", [
      ev(1, "plan", { goal: "g", model: "mock", promptChars: 8000, responseChars: 2000 }),
    ]);
    expect(summary.callsPerModel).toEqual({ mock: 1 });
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.tokensIn).toBe(2000); // chars still counted even when priced free
  });
});

const HOUR_MS = 60 * 60 * 1000;

describe("planRateSeries (plan-rate sparkline data)", () => {
  test("buckets plan events into hourly buckets aligned to the window start, emitting zero buckets", () => {
    const now = 24 * HOUR_MS;
    const series = planRateSeries([
      evAt(now - 23.5 * HOUR_MS, "plan", { goal: "g" }), // oldest bucket (index 0)
      evAt(now - 0.5 * HOUR_MS, "plan", { goal: "g" }),  // newest bucket
      evAt(now - 0.2 * HOUR_MS, "plan", { goal: "g" }),  // newest bucket too
      evAt(now - 0.5 * HOUR_MS, "wake", { reason: "heartbeat" }), // non-plan -> ignored
    ], now);
    expect(series.length).toBe(24);              // 24h / 1h buckets
    expect(series[0]!.count).toBe(1);            // the 23.5h-ago plan
    expect(series[23]!.count).toBe(2);           // the two recent plans, same last bucket
    expect(series.reduce((s, b) => s + b.count, 0)).toBe(3); // wake not counted
    expect(series[0]!.ts).toBe(now - 24 * HOUR_MS); // aligned to window start
  });

  test("drops plan events outside the window and a plan exactly at now lands in the last bucket", () => {
    const now = 24 * HOUR_MS;
    const series = planRateSeries([
      evAt(now - 30 * HOUR_MS, "plan", { goal: "old" }), // before window -> dropped
      evAt(now, "plan", { goal: "edge" }),               // exactly now -> clamps into last bucket
    ], now);
    expect(series.reduce((s, b) => s + b.count, 0)).toBe(1);
    expect(series[23]!.count).toBe(1);
  });
});

describe("deployMarkers (change-marker overlay data)", () => {
  test("extracts deploy_marker events as {ts, buildId}, ignoring other event types", () => {
    const markers = deployMarkers([
      evAt(100, "deploy_marker", { buildId: "v1", startedAt: 100 }),
      evAt(200, "plan", { goal: "g" }),
      evAt(300, "deploy_marker", { buildId: "v2", startedAt: 300 }),
    ]);
    expect(markers).toEqual([
      { ts: 100, buildId: "v1" },
      { ts: 300, buildId: "v2" },
    ]);
  });

  test("defaults a missing buildId to 'unknown' rather than dropping the marker", () => {
    const markers = deployMarkers([evAt(100, "deploy_marker", {})]);
    expect(markers).toEqual([{ ts: 100, buildId: "unknown" }]);
  });
});

describe("wakeReasonAlert (>80% broken-signal banner)", () => {
  test("flags a single reason dominating past the threshold (the 231/233 low_fuel shape)", () => {
    const histogram: Record<string, number> = { low_fuel: 231, heartbeat: 2 };
    const alert = wakeReasonAlert(histogram);
    expect(alert).not.toBeNull();
    expect(alert!.reason).toBe("low_fuel");
    expect(alert!.count).toBe(231);
    expect(alert!.total).toBe(233);
    expect(alert!.share).toBeGreaterThan(WAKE_REASON_ALERT_SHARE);
  });

  test("does NOT flag a benign idle agent that only ever heartbeats (heartbeat dominance is expected)", () => {
    // An idle agent at 100% heartbeat must not raise the red banner -- heartbeat
    // is the deliberate floor cadence, not a stuck signal. This is the false
    // alarm the benign-reason exclusion exists to prevent.
    expect(wakeReasonAlert({ heartbeat: 96 })).toBeNull();
  });

  test("does not flag a healthy mixed workload below the threshold", () => {
    expect(wakeReasonAlert({ no_plan: 3, plan_done: 4, low_fuel: 2, instruction: 1 })).toBeNull();
  });

  test("does not flag before there is enough history (min-wakes floor kills the 1/1 = 100% false alarm)", () => {
    expect(wakeReasonAlert({ low_fuel: 1 })).toBeNull();
  });
});
