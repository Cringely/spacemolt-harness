// MCP transport error/recovery taxonomy (improv-mode plan §3 "Error and session
// taxonomy", Batch A).
//
// load-bearing: ASSUMED. The Batch 0 probe was read-only and could NOT provoke a
// session-expiry or a rate-limit (the only error it drew was a benign
// "no_resources" on mine). So these classifiers are built from the two community
// references (geleynse/gantry + sacenox/Zoea-Nova — independent and agreeing on
// this taxonomy), NOT ablated against our own account's captured fixtures. This
// is deliberately low-risk: a wrong guess here degrades a RECOVERY path, not the
// happy path (which is fixture-verified in mcp-text-parser + mcp transport). Drop
// the "assumed" tag and re-derive from a real capture the first time a live
// improv window actually hits an expiry or a limit.
//
// Pure functions only — no I/O. The transport (mcp.ts) composes them in its
// retry loop; keeping them here makes the taxonomy independently testable and
// lets the same predicate serve both the JSON-RPC error path and the tool-level
// isError-text path (a session/rate signal can arrive either way).

/** Cap on any server-specified delay we will honor, so a hostile or buggy
 * retry_after can't park the agent for minutes. */
export const RETRY_AFTER_CAP_S = 60;

const clampSeconds = (s: number): number => {
  if (!Number.isFinite(s) || s < 0) return 0;
  return Math.min(s, RETRY_AFTER_CAP_S);
};

// Session-loss wording (gantry/Zoea). Covers the tool-level string codes
// (session_expired / unauthorized / invalid_session / not_logged_in) and the
// human phrasings the game may render into content text.
const SESSION_RE =
  /session[_ ]?(expired|invalid|required|recover)|unauthorized|not[_ ]?logged[_ ]?in|invalid[_ ]?session/i;

// Rate-limit wording. "try again in N seconds" is the text form; rate_limited /
// cooldown are the structured codes.
const RATE_RE = /rate[_ ]?limit|cooldown|too many requests|try again in/i;

// One-mutation-per-tick lock (action_pending / "already in progress").
const PENDING_RE = /action[_ ]?pending|already in progress|action already in progress/i;

/** Pull N out of a "Try again in N seconds" message; null when absent. */
export function parseTryAgainSeconds(message: string): number | null {
  const m = message.match(/try again in\s+(\d+)\s*second/i);
  return m ? Number(m[1]) : null;
}

export interface RetryHints {
  retry_after?: number;
  wait_seconds?: number;
}

export type McpErrorClass =
  | { kind: "session" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "action_pending"; retryAfterSeconds: number }
  | { kind: "other"; code: string; message: string };

/**
 * Classify a game error into how the transport should react. Accepts a numeric
 * or string `code` (JSON-RPC codes like -32001, or tool string codes like
 * "rate_limited"), the human `message`/text, and any structured retry hints.
 *
 * Order matters: rate-limit and action-pending are checked before the session
 * catch-all so a "cooldown" isn't mistaken for a session loss. -32001 (session
 * expired) and -32600 (invalid request; Zoea recovers on it) map to session —
 * both are bounded downstream by a single reauth-then-retry, so a genuinely
 * malformed request just fails again after one recovery attempt rather than
 * looping.
 */
export function classifyMcpError(
  code: number | string | null | undefined,
  message: string,
  hints: RetryHints = {},
): McpErrorClass {
  const msg = message ?? "";
  const numCode = typeof code === "number" ? code : null;
  const strCode = typeof code === "string" ? code.toLowerCase() : "";

  const isRate = numCode === 429 || strCode === "rate_limited" || strCode === "cooldown" || RATE_RE.test(msg);
  if (isRate) {
    const raw = hints.retry_after ?? hints.wait_seconds ?? parseTryAgainSeconds(msg) ?? 10;
    return { kind: "rate_limited", retryAfterSeconds: clampSeconds(raw) };
  }

  const isPending = strCode === "action_pending" || PENDING_RE.test(msg);
  if (isPending) {
    const raw = hints.wait_seconds ?? hints.retry_after ?? 10;
    return { kind: "action_pending", retryAfterSeconds: clampSeconds(raw) };
  }

  const isSession =
    numCode === -32001 ||
    numCode === -32600 ||
    strCode === "session_expired" ||
    strCode === "unauthorized" ||
    strCode === "invalid_session" ||
    strCode === "not_logged_in" ||
    strCode === "session_required" ||
    SESSION_RE.test(msg);
  if (isSession) return { kind: "session" };

  return { kind: "other", code: String(code ?? "unknown"), message: msg };
}
