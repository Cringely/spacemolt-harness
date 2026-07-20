import type { AgentEvent } from "../store/store";
import { DEPLOY_MARKER_TYPE } from "../deploy-marker";

export interface UsageSummary {
  agentId: string;
  windowHours: number;
  // Counts "wake" events, NOT planner.plan() invocations -- see the doc
  // comment below for why an exact CLI-call count is deliberately not built.
  replanAttempts: number;
  wakeReasonHistogram: Record<string, number>;
  // Successful replans in the TRAILING HOUR (plan events with ts >= now-60min).
  // A trailing count, not the flat 24h average, so a recent burst is visible
  // against the 4-10/hr design target -- a 60-in-the-last-hour thrash reads as
  // 60/hr here, where plans/24 would have averaged it away to 2.5/hr.
  planRatePerHour: number;
  // planner_error events and the share of plan attempts that failed. A rising
  // error rate means the planner is producing junk (bad JSON, invalid ids) --
  // distinct from a high plan-rate, which means it's producing too MUCH.
  plannerErrors: number;
  plannerErrorRate: number; // errors / (plans + errors); 0 when no attempts
  // Successful plans grouped by the model that produced them (plan event's
  // `model`, "unknown" when absent). Feeds the calls-per-model chart and, with
  // the cost estimate, per-model spend.
  callsPerModel: Record<string, number>;
  // Estimated spend from captured prompt/response chars (chars/4 -> tokens x a
  // per-model price table). Over the window, and scaled to a 24h rate. This is
  // an ESTIMATE: the Claude subscription is flat-rate and returns no token
  // usage, so this is "what these calls would cost at API list prices" -- a
  // comparability number for spotting expensive agents, not an invoice.
  estimatedCostUsd: number;
  estimatedCostUsdPerDay: number;
  // Estimated tokens (sum of captured chars / 4). Null when no plan event in
  // the window carried char counts, so the dashboard shows "not available"
  // rather than a misleading zero.
  tokensIn: number | null;
  tokensOut: number | null;
}

// "Today" (per docs/STATE.md's wake-histogram requirement) is a rolling 24h
// window, not calendar-midnight -- nothing else in this project has a
// timezone concept (SQLite stores epoch ms throughout), and a rolling window
// needs no config. Returned on every response so a caller never has to guess
// what the window covers.
export const USAGE_WINDOW_HOURS = 24;

// Operator-selectable trend windows (hours). The dashboard offers these as a
// segmented control; the /usage endpoint validates `?hours=` against this
// allowlist and falls back to USAGE_WINDOW_HOURS (24 = the 1-day default).
// Allowlist, not free-form, so a caller can't ask for a 10-year scan.
export const USAGE_WINDOW_OPTIONS = [1, 7, 24, 48, 240] as const;

// chars -> tokens divisor. A rough industry rule of thumb (~4 chars/token for
// English) and deliberately simple: the whole cost figure is a documented
// estimate, so a per-model tokenizer would be false precision on top of the
// subscription's missing token counts.
export const CHARS_PER_TOKEN = 4;

export interface ModelPrice {
  inputPerMTokUsd: number; // USD per 1M input (prompt) tokens
  outputPerMTokUsd: number; // USD per 1M output (response) tokens
}

// Per-model price table, in ONE place and tunable. USD per 1M tokens at
// Anthropic public list prices (2026-07); adjust here as prices move or new
// models are added. Keys match the `model` string a planner reports on the
// plan event (see claude-subscription.ts / ollama.ts). A model with no entry
// falls back to FREE_MODEL_PRICE -- the honest default for a self-hosted
// (ollama) or test ("mock") model with no per-token cost, rather than guessing.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  opus: { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
  sonnet: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  haiku: { inputPerMTokUsd: 0.8, outputPerMTokUsd: 4 },
};

export const FREE_MODEL_PRICE: ModelPrice = { inputPerMTokUsd: 0, outputPerMTokUsd: 0 };

export function priceFor(model: string | undefined): ModelPrice {
  return (model !== undefined && MODEL_PRICES[model]) || FREE_MODEL_PRICE;
}

/** Estimated USD for one plan call's captured prompt/response char counts. */
export function estimateCostUsd(promptChars: number, responseChars: number, model: string | undefined): number {
  const price = priceFor(model);
  const inTokens = promptChars / CHARS_PER_TOKEN;
  const outTokens = responseChars / CHARS_PER_TOKEN;
  return (inTokens / 1e6) * price.inputPerMTokUsd + (outTokens / 1e6) * price.outputPerMTokUsd;
}

export interface CreditsPoint {
  ts: number;
  credits: number;
}

/**
 * Credits-over-time from `status_snapshot` events (Layer 5), ascending by ts.
 * One raw point per snapshot -- no smoothing or per-hour derivation here; the
 * server hands the dashboard the samples and the chart layer decides how to
 * render the trend (KISS: one shape, one consumer). A snapshot missing a
 * numeric `credits` is dropped rather than charted as a gap.
 */
export function creditsSeries(events: Array<AgentEvent & { id: number }>): CreditsPoint[] {
  const out: CreditsPoint[] = [];
  for (const e of events) {
    if (e.type !== "status_snapshot") continue;
    const c = (e.payload as { credits?: number } | null)?.credits;
    if (typeof c === "number") out.push({ ts: e.ts, credits: c });
  }
  return out;
}

export interface RateBucket {
  ts: number; // bucket start, epoch ms
  count: number;
}

/**
 * Plan events bucketed into fixed-width time buckets over the usage window --
 * the plan-rate sparkline's data. The headline number stays the precise
 * trailing-60-minute `planRatePerHour` from summarizeUsage; this is the SHAPE
 * over time behind it (is the rate climbing into thrash, or steady?).
 *
 * Buckets are aligned to the window start, oldest-first, and ZERO-count
 * buckets are emitted rather than skipped so the sparkline's x-axis is real
 * elapsed time, not event-dense time -- a quiet hour reads as a flat gap, not
 * a compressed one. A plan event exactly at `now` lands in the last bucket
 * (clamped) rather than spilling past the array.
 */
export function planRateSeries(
  events: Array<AgentEvent & { id: number }>,
  now: number = Date.now(),
  windowHours: number = USAGE_WINDOW_HOURS,
  bucketMinutes = 60,
): RateBucket[] {
  const bucketMs = bucketMinutes * 60 * 1000;
  const windowMs = windowHours * 60 * 60 * 1000;
  const start = now - windowMs;
  const n = Math.max(1, Math.ceil(windowMs / bucketMs));
  const buckets: RateBucket[] = [];
  for (let i = 0; i < n; i++) buckets.push({ ts: start + i * bucketMs, count: 0 });
  for (const e of events) {
    if (e.type !== "plan") continue;
    if (e.ts < start || e.ts > now) continue;
    const idx = Math.min(n - 1, Math.floor((e.ts - start) / bucketMs));
    buckets[idx]!.count++;
  }
  return buckets;
}

export interface DeployMarker {
  ts: number;
  buildId: string;
}

/**
 * Deploy markers in the window, ascending -- the change-marker overlay's data
 * (see src/deploy-marker.ts for why the harness emits these instead of reading
 * git tags). One point per startup the agent has seen inside the window.
 */
export function deployMarkers(events: Array<AgentEvent & { id: number }>): DeployMarker[] {
  const out: DeployMarker[] = [];
  for (const e of events) {
    if (e.type !== DEPLOY_MARKER_TYPE) continue;
    const b = (e.payload as { buildId?: string } | null)?.buildId;
    out.push({ ts: e.ts, buildId: typeof b === "string" ? b : "unknown" });
  }
  return out;
}

export interface WakeReasonAlert {
  reason: string;
  count: number;
  total: number;
  share: number; // count / total, 0..1
}

// The "231/233 low_fuel" broken-signal threshold: when a single wake reason's
// share of all wakes exceeds this, the agent is almost certainly repeating one
// trigger (a livelock/thrash) rather than doing varied work.
export const WAKE_REASON_ALERT_SHARE = 0.8;
// A floor so one lone wake (1/1 = 100%) never trips a false alarm before there
// is enough history to carry a real signal.
export const WAKE_REASON_ALERT_MIN_WAKES = 5;
// `heartbeat` is the deliberate idle floor cadence -- an idle agent that only
// ever heartbeats is benign, not broken, so heartbeat DOMINANCE must never
// raise the banner. Every OTHER reason dominating (low_fuel, blocked, no_plan,
// notification) is a real "stuck on one thing" signal. In genuine thrash the
// thrash rate dwarfs the 15-min heartbeat, so heartbeat's share is tiny and
// the offending reason's share is huge -- the case this catches.
const BENIGN_DOMINANT_REASONS = new Set(["heartbeat"]);

/**
 * Detect a single wake reason dominating the mix past `threshold` -- the red
 * banner signal on the dashboard's wake-reason panel. Returns null when no
 * reason dominates, when the dominant reason is the benign heartbeat idle
 * floor, or when there aren't yet `minWakes` wakes to judge. Pure and keyed
 * only on the histogram already in the usage summary, so the dashboard renders
 * the verdict without recomputing it.
 */
export function wakeReasonAlert(
  histogram: Record<string, number>,
  threshold: number = WAKE_REASON_ALERT_SHARE,
  minWakes: number = WAKE_REASON_ALERT_MIN_WAKES,
): WakeReasonAlert | null {
  let total = 0;
  let topReason = "";
  let topCount = 0;
  for (const [reason, count] of Object.entries(histogram)) {
    total += count;
    if (count > topCount) {
      topCount = count;
      topReason = reason;
    }
  }
  if (total < minWakes) return null;
  if (BENIGN_DOMINANT_REASONS.has(topReason)) return null;
  const share = topCount / total;
  if (share <= threshold) return null;
  return { reason: topReason, count: topCount, total, share };
}

/**
 * Zero new persisted state (receipt: events are the store's single source of
 * truth per the spec's `store` component) -- every field here derives from
 * the existing events table via Store.eventsSince.
 *
 * replanAttempts counts "wake" events, not raw planner.plan() calls: every
 * Agent.replan() emits exactly one "wake" event as its first action, but a
 * single replan() can issue up to ~4 CLI calls invisible to the event log
 * (claude-subscription.ts's JSON-validation retry x agent.ts's id-normalization
 * retry). Counting the exact CLI-call total would need a new event inside each
 * retry branch; instead the plan event now carries prompt/response CHAR counts
 * (Layer 5 cost seam), summed across those retries in agent.ts, which is what
 * the cost estimate here reads. replanAttempts stays honestly named -- it's the
 * wake count, not a call count.
 *
 * tokensIn/tokensOut are ESTIMATES from those char counts (chars/4), not real
 * token usage: the Claude subscription CLI returns none. Null until a plan
 * event carries char counts, so the dashboard renders "not available" rather
 * than a misleading zero.
 *
 * Cost/chars are captured on the plan-SUCCESS path only (agent.ts emits the
 * plan event after a plan validates). A replan that throws after its retries
 * reports no plan event, so its (real) spend is not in estimatedCostUsd -- that
 * failure is instead visible and bounded via the plannerErrors count, which
 * caps how much uncounted spend a thrash could hide.
 *
 * `now` is the reference instant for the trailing-hour plan rate; defaults to
 * wall-clock and is injected by tests for determinism.
 */
export function summarizeUsage(
  agentId: string, events: Array<AgentEvent & { id: number }>, now: number = Date.now(),
  windowHours: number = USAGE_WINDOW_HOURS,
): UsageSummary {
  const wakeReasonHistogram: Record<string, number> = {};
  const callsPerModel: Record<string, number> = {};
  const trailingHourCutoff = now - 60 * 60 * 1000;
  let replanAttempts = 0;
  let plans = 0;
  let plansTrailingHour = 0;
  let plannerErrors = 0;
  let promptChars = 0;
  let responseChars = 0;
  let estimatedCostUsd = 0;
  let sawChars = false;

  for (const e of events) {
    if (e.type === "wake") {
      replanAttempts++;
      const reason = (e.payload as { reason?: string } | null)?.reason ?? "unknown";
      wakeReasonHistogram[reason] = (wakeReasonHistogram[reason] ?? 0) + 1;
    } else if (e.type === "plan") {
      plans++;
      if (e.ts >= trailingHourCutoff) plansTrailingHour++;
      const p = e.payload as { model?: string; promptChars?: number; responseChars?: number } | null;
      const model = p?.model ?? "unknown";
      callsPerModel[model] = (callsPerModel[model] ?? 0) + 1;
      if (typeof p?.promptChars === "number" || typeof p?.responseChars === "number") {
        sawChars = true;
        const pc = p?.promptChars ?? 0;
        const rc = p?.responseChars ?? 0;
        promptChars += pc;
        responseChars += rc;
        estimatedCostUsd += estimateCostUsd(pc, rc, p?.model);
      }
    } else if (e.type === "planner_error") {
      plannerErrors++;
    }
  }

  const attempts = plans + plannerErrors;
  return {
    agentId,
    windowHours,
    replanAttempts,
    wakeReasonHistogram,
    // Trailing-hour count IS the per-hour rate (a count over a 1h window).
    planRatePerHour: plansTrailingHour,
    plannerErrors,
    plannerErrorRate: attempts > 0 ? plannerErrors / attempts : 0,
    callsPerModel,
    estimatedCostUsd,
    estimatedCostUsdPerDay: estimatedCostUsd * (24 / windowHours),
    tokensIn: sawChars ? promptChars / CHARS_PER_TOKEN : null,
    tokensOut: sawChars ? responseChars / CHARS_PER_TOKEN : null,
  };
}
