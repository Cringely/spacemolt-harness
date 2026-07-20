export class TransientPlannerError extends Error {
  constructor(message: string) { super(message); this.name = "TransientPlannerError"; }
}
export class SubscriptionLimitError extends Error {
  constructor(message: string) { super(message); this.name = "SubscriptionLimitError"; }
}
export class TokenInvalidError extends Error {
  constructor(message: string) { super(message); this.name = "TokenInvalidError"; }
}

export type PlannerFailureClass = "transient" | "subscription_limit" | "token_invalid";

interface ClaudeFailureEnvelope {
  is_error?: boolean;
  api_error_status?: number;
  terminal_reason?: string;
}

/**
 * Ground truth (captured 2026-07-10: deliberately invalid token, clean
 * container, zero usage spent): the CLI's failure output is a structured JSON
 * envelope carrying a numeric `api_error_status`, not free-form prose --
 * {"is_error":true,"api_error_status":401,...,"terminal_reason":"api_error"}.
 * The violated invariant this fixes: failure class should be read from the
 * field the CLI actually emits for it, not inferred from prose that happens
 * to mention a number. Key on api_error_status first; is_error +
 * terminal_reason:"api_error" is the corroborating signal for a genuine API
 * failure whose status code we don't otherwise recognize.
 */
export function classifyClaudeFailure(stdout: string): PlannerFailureClass {
  const envelope = tryParseEnvelope(stdout);
  if (envelope) {
    const status = envelope.api_error_status;
    if (status === 401 || status === 403) return "token_invalid";
    if (status === 429) return "subscription_limit";
    if (status !== undefined && status >= 500) return "transient";
    if (envelope.is_error && envelope.terminal_reason === "api_error") return "transient";
  }
  return classifyByText(stdout);
}

function tryParseEnvelope(stdout: string): ClaudeFailureEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === "object") return parsed as ClaudeFailureEnvelope;
  } catch {
    // Not JSON: a process-level failure (crashed/killed before the CLI could
    // emit a result envelope at all), the one case the fallback below covers.
  }
  return null;
}

/**
 * FALLBACK PATH ONLY -- reached when stdout isn't a JSON envelope OR parses without a recognized failure field
 * (process-level failure, no structured output to key on). ASSUMED, not
 * verified against a live rate-limit or token-expiry event -- doing so would
 * either spend real subscription usage or require an actual outage window,
 * neither safe to induce for this plan. These patterns are Claude Code's
 * documented/observed error vocabulary as of CLI 2.1.207. Input is stdout
 * text only (not stderr, not the exit code): the Runner interface is fixed to
 * {stdout, exitCode} per Task 1's exact signature, and the claude CLI uses
 * exit code 1 for every failure mode -- it carries no class signal, so it is
 * deliberately not a parameter here. Any error text the CLI sends to stderr
 * instead of stdout is invisible today; if that turns out to matter,
 * RunResult gains a stderr field then, a small and well-contained follow-up.
 */
function classifyByText(stdout: string): PlannerFailureClass {
  const text = stdout.toLowerCase();
  if (/invalid.*(oauth|token|api key)|unauthorized|authentication_error|401/.test(text)) return "token_invalid";
  if (/usage limit|rate.?limit|quota exceeded|resets? at/.test(text)) return "subscription_limit";
  return "transient";
}

/**
 * Codex CLI failure classification (#311). Ground truth (captured 2026-07-17:
 * `codex exec --json` with an invalid model, codex-cli 0.144.3, exit 1): the
 * failure arrives as JSONL events on stdout -- {"type":"turn.failed","error":
 * {"message":"..."}} -- whose message STRING embeds the backend's own JSON
 * error carrying a numeric `status` ({"type":"error","status":400,...}). Same
 * stance as classifyClaudeFailure: key on the number the CLI actually emits
 * first, fall back to text patterns only when no status is present. The 401/
 * 429 mappings are ASSUMED (mirroring the Claude taxonomy; inducing a live
 * token expiry or rate limit was not safe to do), the 400-family capture and
 * the event shape are VERIFIED.
 */
export function classifyCodexFailure(stdout: string): PlannerFailureClass {
  // The embedded error JSON travels inside an event's message STRING, so its
  // quotes arrive backslash-escaped (\"status\":400) -- the regex tolerates
  // both the escaped and bare forms.
  const status = /"status\\?"\s*:\s*(\d{3})/.exec(stdout);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || code === 403) return "token_invalid";
    if (code === 429) return "subscription_limit";
    if (code >= 500) return "transient";
    return classifyCodexText(stdout); // 4xx like the verified invalid-model 400: usually transient config, but let prose override
  }
  return classifyCodexText(stdout);
}

function classifyCodexText(stdout: string): PlannerFailureClass {
  const text = stdout.toLowerCase();
  if (/not logged in|codex login|token expired|invalid.*(token|api key)|unauthorized|authentication/.test(text)) return "token_invalid";
  if (/usage limit|rate.?limit|quota exceeded|resets? at/.test(text)) return "subscription_limit";
  return "transient";
}
