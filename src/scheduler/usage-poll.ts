// Durable scheduler (#114) Stage 4 (#183): the usage-endpoint capture slice.
// The ONLY goal of this slice is to capture the 200-response SHAPE of
// `GET https://api.anthropic.com/api/oauth/usage` — blocked to date because the
// endpoint throttles on an ~1h per-token budget that the pilot's continuous
// `claude -p` spawns re-exhaust (#183 probe, 2026-07-13). The scheduler polls
// at low frequency from the tick path, honors the 429 `retry-after` exactly
// (it IS the window-reset time — a usable scheduling signal), and on the first
// 200 writes the body REDACTED to a flat file the PM reads and files to #183.
//
// Explicit NON-goals (spec §Sequencing stage 4, rejected with receipts):
// no self-throttling, no predictive regression, no new network surface beyond
// this one outbound GET. Building any of those waits on this capture defining
// the shape.
//
// Security posture (spec §Security, security-baseline.md, binding):
// - The OAuth token is read from the secret FILE at call time (like buildEnv);
//   it travels only into the fetcher, never a log line, never the capture file.
//   Every log line uses `token=loaded` style, never the value.
// - The redactor masks anything credential-shaped by key OR value before the
//   body is ever logged or persisted — the shape is unknown, so it fails safe.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_POLL_STATE_FILE = "usage-poll.json";
export const USAGE_CAPTURE_FILE = "usage-capture.json";

// 60 min. Receipt: the endpoint throttles on a ~1h per-token budget (#183
// probe: `retry-after` counted down from 3559-3600 twice on 2026-07-13), so a
// poll faster than the window is guaranteed to 429 — one poll per hour is the
// useful ceiling, and the cron ticks every 10 min so this fires ~once an hour.
export const POLL_INTERVAL_MS = 60 * 60_000;

// 15s. Receipt: a hung GET must never stall a tick (the four job timeouts
// already bound the tick; a network read must not add an unbounded wait). 15s
// is far above normal api.anthropic.com latency and far below the 10-min tick.
export const USAGE_FETCH_TIMEOUT_MS = 15_000;

export interface UsageResponse {
  status: number;
  /** Raw response body text — redacted before it is ever logged or persisted. */
  body: string;
  /** Parsed integer `retry-after` seconds (429 window-reset signal), else null. */
  retryAfterSec: number | null;
}

/** The seam: tick never fetches itself. Tests inject a fake endpoint. */
export type UsageFetcher = (token: string) => Promise<UsageResponse>;

export interface UsagePollDeps {
  now: number;
  stateDir: string;
  secretsDir: string;
  fetcher: UsageFetcher;
  /** Injected so tests assert on log output (token-leak check); defaults to console.log. */
  log?: (line: string) => void;
}

export interface UsagePollResult {
  /** True iff the network was actually hit this tick (false on cadence/no-token skip). */
  polled: boolean;
  status: number | null;
  /** True iff THIS call wrote the capture file (the once-only first-200 event). */
  captured: boolean;
  reason: "cadence" | "no-fetcher" | "no-token" | "network-error" | null;
  nextAllowedPollAt: number;
}

/** Returned by tick when no fetcher is wired (tests that don't exercise the poll). */
export const USAGE_POLL_SKIPPED: UsagePollResult = {
  polled: false,
  status: null,
  captured: false,
  reason: "no-fetcher",
  nextAllowedPollAt: 0,
};

export interface UsagePollState {
  /** Wall-clock ms before which no poll is attempted (cadence + honored retry-after). */
  nextAllowedPollAt: number;
  /** When the first-200 shape was captured; non-null means never re-write the file. */
  capturedAt: number | null;
}

// Schema-tolerant per the binding persisted-state rule: a state file that
// predates this slice does not exist (→ defaults), and a corrupt/older field
// degrades alone. Default nextAllowedPollAt=0 ⇒ the first tick polls at once.
const UsagePollStateSchema = z.object({
  nextAllowedPollAt: z.number().catch(0),
  capturedAt: z.number().nullable().catch(null),
});

export function defaultUsagePollState(): UsagePollState {
  return { nextAllowedPollAt: 0, capturedAt: null };
}

export function loadUsagePollState(dir: string): UsagePollState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, USAGE_POLL_STATE_FILE), "utf8"));
  } catch {
    return defaultUsagePollState(); // missing, truncated, or corrupt → all defaults
  }
  const parsed = UsagePollStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultUsagePollState();
}

export function saveUsagePollState(dir: string, state: UsagePollState): void {
  const tmp = join(dir, `${USAGE_POLL_STATE_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, join(dir, USAGE_POLL_STATE_FILE));
}

// A key whose VALUE is credential/PII-shaped and must be masked. The usage
// numbers we actually want (utilization, resets_at, limit types) never match
// these, so redaction preserves the useful shape while failing safe on the
// unknown parts.
const SENSITIVE_KEY =
  /token|secret|password|passwd|api[_-]?key|apikey|authorization|bearer|credential|cookie|email|(^|_)id$/i;

// A string VALUE that looks like a token even under a non-sensitive key —
// sk-ant-... OAuth tokens, or any long opaque alnum blob. Dates ("2026-07-18T..",
// colons, ~20 chars) and model names do not match.
const SECRET_VALUE = /sk-ant-|sk-[A-Za-z0-9]{8,}|^[A-Za-z0-9_-]{40,}$/;

/** Recursively mask credential-shaped keys/values; keep numbers, booleans, dates, structure. */
function redactValue(key: string | null, val: unknown): unknown {
  if (key !== null && SENSITIVE_KEY.test(key)) return "<redacted>";
  if (typeof val === "string") return SECRET_VALUE.test(val) ? "<redacted>" : val;
  if (Array.isArray(val)) return val.map((v) => redactValue(null, v));
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) out[k] = redactValue(k, v);
    return out;
  }
  return val; // number, boolean, null
}

/** Redacted parsed body (structure preserved). An unparseable body redacts wholesale. */
export function redactUsageObject(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { note: "unparseable usage body redacted", length: raw.length };
  }
  return redactValue(null, parsed);
}

/** Single-line-friendly redacted body for the log line. */
export function redactUsageBody(raw: string): string {
  return JSON.stringify(redactUsageObject(raw), null, 2);
}

function writeCaptureFile(dir: string, now: number, body: string): void {
  const capture = {
    capturedAt: new Date(now).toISOString(),
    source: `GET ${USAGE_URL} (#183 Stage 4 opportunistic first-200 capture)`,
    httpStatus: 200,
    note: "Redacted: credential-shaped keys/values masked, structure + usage numbers preserved. File this body to issue #183, then this file can be deleted.",
    bodyRedacted: redactUsageObject(body),
  };
  const tmp = join(dir, `${USAGE_CAPTURE_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(capture, null, 2));
  renameSync(tmp, join(dir, USAGE_CAPTURE_FILE));
}

function readToken(secretsDir: string): string | null {
  try {
    const t = readFileSync(join(secretsDir, "claude_oauth_token"), "utf8").trim();
    return t === "" ? null : t;
  } catch {
    return null;
  }
}

// One poll attempt from the tick path. NEVER throws — every failure degrades to
// a deferred next-poll time and a log line, because a usage read must never
// break a governance tick.
export async function pollUsage(deps: UsagePollDeps): Promise<UsagePollResult> {
  const { now, stateDir, secretsDir, fetcher } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const state = loadUsagePollState(stateDir);

  if (now < state.nextAllowedPollAt) {
    return { polled: false, status: null, captured: false, reason: "cadence", nextAllowedPollAt: state.nextAllowedPollAt };
  }

  const token = readToken(secretsDir);
  if (token === null) {
    // Token file rotated/unmounted: defer one interval, never a throw.
    state.nextAllowedPollAt = now + POLL_INTERVAL_MS;
    saveUsagePollState(stateDir, state);
    log("usage-poll: skipped (token=unset — claude_oauth_token missing or empty)");
    return { polled: false, status: null, captured: false, reason: "no-token", nextAllowedPollAt: state.nextAllowedPollAt };
  }

  log("usage-poll: polling api.anthropic.com/api/oauth/usage (token=loaded)");
  let res: UsageResponse;
  try {
    res = await fetcher(token);
  } catch {
    state.nextAllowedPollAt = now + POLL_INTERVAL_MS;
    saveUsagePollState(stateDir, state);
    log("usage-poll: network error — deferring one interval");
    return { polled: true, status: null, captured: false, reason: "network-error", nextAllowedPollAt: state.nextAllowedPollAt };
  }

  let captured = false;
  if (res.status === 200) {
    if (state.capturedAt === null) {
      writeCaptureFile(stateDir, now, res.body);
      state.capturedAt = now;
      captured = true;
      log(`usage-poll: 200 — first shape captured (redacted) → ${USAGE_CAPTURE_FILE}; PM files it to #183`);
      log(`usage-poll: redacted body: ${redactUsageBody(res.body).replace(/\n/g, " ")}`);
    } else {
      log("usage-poll: 200 (shape already captured; not re-writing)");
    }
    state.nextAllowedPollAt = now + POLL_INTERVAL_MS;
  } else if (res.status === 429) {
    // retry-after IS the window-reset time (spec) — honor it exactly.
    const waitMs = res.retryAfterSec !== null && res.retryAfterSec > 0 ? res.retryAfterSec * 1000 : POLL_INTERVAL_MS;
    state.nextAllowedPollAt = now + waitMs;
    log(`usage-poll: 429 throttled — honoring retry-after ${res.retryAfterSec ?? "(absent)"}s`);
  } else {
    // 401/403 (token rotated/revoked) or 5xx: surface the status, defer one interval.
    state.nextAllowedPollAt = now + POLL_INTERVAL_MS;
    log(`usage-poll: HTTP ${res.status} — deferring one interval`);
  }

  saveUsagePollState(stateDir, state);
  return { polled: true, status: res.status, captured, reason: null, nextAllowedPollAt: state.nextAllowedPollAt };
}

// Real fetcher: the one authorized outbound GET (spec §Security). Token by
// header only; a 15s abort so a hung read cannot stall the tick.
export function makeUsageFetcher(): UsageFetcher {
  return async (token) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });
      const body = await res.text();
      const ra = res.headers.get("retry-after");
      const retryAfterSec = ra !== null && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) : null;
      return { status: res.status, body, retryAfterSec };
    } finally {
      clearTimeout(timer);
    }
  };
}
