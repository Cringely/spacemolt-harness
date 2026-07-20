export class SpacemoltError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = "SpacemoltError";
  }
}

export interface EnvelopeNotification {
  id: string;
  type: string; // system | combat | trade | chat | friend | tip
  msg_type: string;
  timestamp: string;
  data?: unknown;
}

export interface V2Result {
  result?: string;
  structuredContent?: unknown;
  notifications?: EnvelopeNotification[];
}

interface V2Envelope extends V2Result {
  error?: { code: string; message: string; retry_after?: number; wait_seconds?: number; details?: unknown };
}

// --- Error taxonomy (ported from gantry http-game-client-v2.ts, adapted for
// HTTP API v2; gantry's set carries MCP/JSON-RPC-specific codes like "-32001"
// that don't apply over our transport). Two axes: session-expired (transparent
// re-login) and server-error (transient → bounded retry). Everything else is a
// terminal game error surfaced to the caller.

/** Session/auth expiry → the transport transparently re-logs in and retries once. */
const SESSION_EXPIRED_CODES = new Set([
  "session_required", "session_invalid", "not_authenticated", // codes our game confirmed
  "session_expired", "unauthorized", "token_expired", "invalid_session", "not_logged_in",
]);

/** Transient server-side instability → retry with backoff, feed the breaker. */
const SERVER_ERROR_CODES = new Set([
  "server_error", "internal_error", "timeout",
  "connection_reset", "connection_lost", "connection_refused",
  "502", "503", "504",
]);

/** True when a SpacemoltError's code names the transient-server class this
 * transport already retried in-call (a 5xx status or transient body code ->
 * "server_error"/the body's own code, a rejected fetch -> "network_error", a
 * non-JSON body -> "bad_response") or the breaker's fail-fast ("circuit_open").
 * Exported for the executor's step-level retry (#431): what call() treats as
 * transient and what the executor retries must be the SAME class, defined once
 * here at the producer. circuit_open is included deliberately -- during a real
 * outage the breaker opens mid-episode, and a step retry that misread it as a
 * terminal game error would wake the planner on attempt 2 of 3, defeating the
 * very retry #431 adds. */
export function isTransientServerFailure(code: string): boolean {
  return SERVER_ERROR_CODES.has(code) || code === "network_error" || code === "bad_response" || code === "circuit_open";
}

function isSessionExpired(code: string, message: string): boolean {
  if (SESSION_EXPIRED_CODES.has(code)) return true;
  const m = message?.toLowerCase() ?? "";
  return m.includes("session expired") || m.includes("not logged in");
}

/** HTTP statuses that mean "server is unhealthy", independent of any JSON body.
 * All 5xx: a bodyless/HTML 500 or 502/503/504 from a proxy is transient and must
 * short-circuit before res.json() (which would throw SyntaxError on a non-JSON body). */
function isTransientStatus(status: number): boolean {
  return status >= 500;
}

// 3 retries ~= 30s of game ticks (10s each); beyond that the caller's plan
// state is stale enough that surfacing the error beats blocking longer.
const MAX_RATE_RETRIES = 3;
// Server/network errors: shorter budget than rate-limits — a down server won't
// recover in a few seconds, so fail toward the circuit breaker instead of
// blocking the tick loop. Sequence with backoff below ~= 1s, 2s, 4s.
const MAX_SERVER_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 8000;
const BACKOFF_JITTER = 0.2;

// Per-tool circuit breaker: after CIRCUIT_THRESHOLD consecutive server failures
// for one tool, open the breaker and fail fast for CIRCUIT_COOLDOWN_MS instead
// of burning retries against a down endpoint. A success resets it.
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

// ponytail: minimal per-tool breaker — a consecutive-failure count plus a
// cooldown timestamp. No half-open probe / listeners / registry / aggregate
// status (gantry's 271-line CircuitBreaker serves a health dashboard we don't
// have). Upgrade path: add getStatus() + a half-open probe when the dashboard
// needs live breaker state.
interface Breaker { failures: number; openUntil: number; }

/** Exponential backoff with ±jitter (gantry retry-policy.ts). attempt is 1-based. */
function backoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
  return Math.max(0, Math.round(base + base * BACKOFF_JITTER * (Math.random() * 2 - 1)));
}

export class SpacemoltHttp {
  private sessionId: string | null = null;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private breakers = new Map<string, Breaker>();
  /** Set by the client after login: re-runs login on a fresh session. */
  onReauth?: () => Promise<void>;

  constructor(private baseUrl: string, opts?: { sleep?: (ms: number) => Promise<void>; now?: () => number }) {
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts?.now ?? (() => Date.now());
  }

  async createSession(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v2/session`, { method: "POST" });
    const body = (await res.json()) as { session?: { id: string } };
    if (!body.session?.id) throw new SpacemoltError("session_create_failed", "no session id in response");
    this.sessionId = body.session.id;
  }

  private breakerFor(tool: string): Breaker {
    let b = this.breakers.get(tool);
    if (!b) { b = { failures: 0, openUntil: 0 }; this.breakers.set(tool, b); }
    return b;
  }

  async call(tool: string, action: string, params: Record<string, unknown> = {}): Promise<V2Result> {
    // Almost every game route is `/api/v2/<tool>/<action>`. `spacemolt_catalog`
    // (issue #219) is the exception: the OpenAPI spec publishes it as a BARE
    // tool path with no action segment, so its registry action name is "" (see
    // CATALOG_ACTION, src/registry/actions.ts) and the URL must not carry a
    // trailing slash. One ternary rather than a per-action path override on
    // ActionDef: the spec has exactly one such route, and a new ActionDef field
    // would have to be taught to the conformance test and the commands.md
    // generator as well (complexity receipt, simplicity rule 3).
    const route = action ? `${tool}/${action}` : tool;
    const breaker = this.breakerFor(tool);
    if (breaker.openUntil > this.now()) {
      const secs = Math.ceil((breaker.openUntil - this.now()) / 1000);
      throw new SpacemoltError("circuit_open", `circuit open for ${tool}, retry after ${secs}s`);
    }

    let rateRetries = 0;
    let serverRetries = 0;
    let sessionRetried = false;

    // Shared transient handling: record the failure, then either back off and
    // retry (return) or, if the budget is spent, throw with the given code.
    // ponytail: retrying a mutation on a mid-flight timeout is at-least-once —
    // both sends happen inside this call() before control returns, so the plan
    // loop does NOT close the window (an earlier note wrongly claimed it did).
    // Retrying a server_error-BODIED response is safe (rejected before commit);
    // the ambiguous case is a network/abort/proxy-5xx AFTER a server-side commit,
    // which could double-apply a sell/mine. Accepted (narrow, bounded to 3, an
    // authorized sandbox), NOT closed -- tightening to query-only retry is a
    // follow-up. Upgrade path: per-action idempotency keys if the game adds them.
    const onTransient = async (code: string, detail: string): Promise<void> => {
      breaker.failures++;
      if (breaker.failures >= CIRCUIT_THRESHOLD) {
        breaker.openUntil = this.now() + CIRCUIT_COOLDOWN_MS;
        breaker.failures = 0;
      }
      if (serverRetries >= MAX_SERVER_RETRIES) throw new SpacemoltError(code, detail);
      serverRetries++;
      await this.sleep(backoffMs(serverRetries));
    };

    for (;;) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/api/v2/${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.sessionId ? { "X-Session-Id": this.sessionId } : {}),
          },
          body: JSON.stringify(params),
          // travel/jump block until arrival; generous timeout per API docs
          signal: AbortSignal.timeout(600_000),
        });
      } catch (err) {
        // fetch rejected: network failure, DNS, or the abort timeout fired.
        await onTransient("network_error", `${route}: ${String(err)}`);
        continue;
      }

      if (isTransientStatus(res.status)) {
        await onTransient("server_error", `${route}: HTTP ${res.status}`);
        continue;
      }

      // <500 status but still possibly non-JSON (a proxy 429/413 HTML page, or a
      // truncated 200). A parse failure is transient: retry rather than let a raw
      // SyntaxError escape unclassified.
      let body: V2Envelope;
      try {
        body = (await res.json()) as V2Envelope;
      } catch (err) {
        await onTransient("bad_response", `${route}: HTTP ${res.status} non-JSON body: ${String(err)}`);
        continue;
      }

      if (!body.error) {
        breaker.failures = 0;
        breaker.openUntil = 0;
        return body;
      }
      const { code, message, retry_after, wait_seconds, details } = body.error;

      if ((code === "rate_limited" || code === "action_pending") && rateRetries < MAX_RATE_RETRIES) {
        rateRetries++;
        await this.sleep((retry_after ?? wait_seconds ?? 10) * 1000);
        continue;
      }
      if (isSessionExpired(code, message) && !sessionRetried) {
        sessionRetried = true;
        await this.createSession();
        await this.onReauth?.();
        continue;
      }
      if (SERVER_ERROR_CODES.has(code)) {
        await onTransient(code, message);
        continue;
      }
      // Terminal game error (e.g. insufficient_fuel): the server answered, so
      // it's healthy — reset the breaker before surfacing.
      breaker.failures = 0;
      breaker.openUntil = 0;
      throw new SpacemoltError(code, message, details);
    }
  }
}
