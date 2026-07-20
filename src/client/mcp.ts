// SpacemoltMcp — the MCP Streamable-HTTP transport (improv-mode plan Batch A),
// sibling of SpacemoltHttp. Same responsibilities (session, tool call, session
// recovery, rate-limit retry) over the game's MCP interface instead of REST.
//
// Why a separate transport rather than a branch inside SpacemoltHttp: the wire
// format is different enough that a shared body would be all conditionals.
// Over MCP a call is JSON-RPC `tools/call`; the response may be SSE; the game
// session is threaded as a per-call `session_id` ARGUMENT (gantry model, chosen
// in Batch 0 — see docs/decisions.md 2026-07-12 probe entry) rather than the
// `X-Session-Id` header SpacemoltHttp uses; and the canonical game session id is
// parsed out of the login greeting text, not a bootstrap response body. What DOES
// map from http.ts is reused, not re-derived: the retry-loop shape, the
// MAX_RATE_RETRIES cap, and the SpacemoltError type. The pure JSON-RPC builders
// and parsers live in ./mcp-rpc.ts (extracted from the Batch 0 probe in #122);
// this transport composes them so there is one definition of the wire shapes (SSOT).
//
// Division of labor with the text parser (mcp-text-parser.ts): this transport
// owns string EXTRACTION and envelope unwrap — it hands back the raw
// result.content[0].text. Mapping that dashboard text into a typed StatusSnapshot
// is the parser's job. MCP reads are text dashboards with no structuredContent
// (Batch 0, §5a), so no Zod schema applies on this path.

import { SpacemoltError, type EnvelopeNotification } from "./http";
import { classifyMcpError } from "./mcp-errors";
import {
  MCP_ENDPOINT_PATH,
  GAME_SESSION_PATH,
  buildInitializeRequest,
  INITIALIZED_NOTIFICATION,
  buildToolCallRequest,
  parseJsonRpcPayload,
  extractResultText,
  unwrapEnvelope,
  parseLoginSessionId,
} from "./mcp-rpc";

/** What a tool call resolves to. `text` is the extracted content string (the
 * dashboard the parser consumes), envelope-unwrapped when the content was an
 * enveloped JSON string. `isError` mirrors the JSON-RPC result.isError flag
 * (a tool-level game error like "no_resources: Nothing to mine here" — returned,
 * not thrown, so the caller can react). `raw` is the full JSON-RPC response. */
export interface McpToolResult {
  text: string | null;
  notifications: EnvelopeNotification[];
  isError: boolean;
  raw: unknown;
}

// Mirrors SpacemoltHttp.MAX_RATE_RETRIES: 3 retries ~= 30s of game ticks; beyond
// that the caller's state is stale enough that surfacing the error beats blocking.
const MAX_RATE_RETRIES = 3;

// Session-recovery circuit breaker (gantry's sliding window). More than this many
// re-logins inside the window means the server is down, not that our session
// merely lapsed — stop hammering and surface the failure.
const DEFAULT_RENEWAL_WINDOW_MS = 60_000;
const DEFAULT_MAX_RENEWALS = 3;

export interface SpacemoltMcpOptions {
  /** MCP tool preset: "standard" (9 tools) or "full" (16). */
  preset?: string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Injectable clock for the renewal circuit-breaker window (tests). */
  now?: () => number;
  maxRenewalsPerWindow?: number;
  renewalWindowMs?: number;
}

export class SpacemoltMcp {
  /** Transport session id from the `Mcp-Session-Id` initialize header — a
   * transport-level id, NOT the game session (that comes from the greeting). */
  transportSessionId: string | null = null;
  /** Canonical game session id, parsed from the login greeting. Threaded as a
   * per-call argument on every tool call except spacemolt_catalog. */
  gameSessionId: string | null = null;

  private nextId = 1;
  private credentials: { username: string; password: string } | null = null;
  private readonly preset: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxRenewals: number;
  private readonly renewalWindowMs: number;

  // Single-flight: concurrent callers that all hit a session-expiry share ONE
  // renewal rather than each firing their own login.
  private renewalInFlight: Promise<void> | null = null;
  // Circuit-breaker window: timestamps of recent renewals.
  private renewalTimes: number[] = [];

  constructor(private baseUrl: string, opts: SpacemoltMcpOptions = {}) {
    this.preset = opts.preset ?? "standard";
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxRenewals = opts.maxRenewalsPerWindow ?? DEFAULT_MAX_RENEWALS;
    this.renewalWindowMs = opts.renewalWindowMs ?? DEFAULT_RENEWAL_WINDOW_MS;
  }

  private mcpUrl(): string {
    return `${this.baseUrl}${MCP_ENDPOINT_PATH}?preset=${encodeURIComponent(this.preset)}`;
  }

  /** One JSON-RPC round trip over MCP Streamable HTTP. Returns the parsed
   * payload plus the transport signals the retry loop needs (status, Retry-After).
   * SSE-aware: an event-stream body is parsed as its last `data:` line. */
  private async rpc(
    payload: object,
    expectResponse: boolean,
  ): Promise<{ response: unknown; status: number; retryAfterSeconds: number | null }> {
    const res = await this.fetchImpl(this.mcpUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.transportSessionId ? { "mcp-session-id": this.transportSessionId } : {}),
      },
      body: JSON.stringify(payload),
      // travel/jump block until arrival; generous timeout matches SpacemoltHttp.
      signal: AbortSignal.timeout(600_000),
    });
    const headerSid = res.headers.get("mcp-session-id");
    if (headerSid) this.transportSessionId = headerSid;
    const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
    // Transport-level rate limit: a 429 body is commonly empty or HTML (an edge/
    // proxy limiter, not the game's JSON-RPC layer). Short-circuit BEFORE parsing
    // so the retry loop honors Retry-After instead of a JSON.parse throwing out of
    // here and losing the delay. (Since a fleet shares one outbound IP, the 429
    // may come from infrastructure that never speaks JSON-RPC.)
    if (res.status === 429) {
      await res.text().catch(() => "");
      return { response: null, status: 429, retryAfterSeconds };
    }
    if (!expectResponse) {
      await res.text().catch(() => "");
      return { response: null, status: res.status, retryAfterSeconds };
    }
    const contentType = res.headers.get("content-type");
    const raw = await res.text();
    return { response: parseJsonRpcPayload(contentType, raw), status: res.status, retryAfterSeconds };
  }

  /** Handshake steps 1-3: REST game-session bootstrap, MCP initialize (yields the
   * Mcp-Session-Id transport header), then the initialized notification. */
  async handshake(): Promise<void> {
    const boot = await this.fetchImpl(`${this.baseUrl}${GAME_SESSION_PATH}`, {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
    if (!boot.ok) {
      throw new SpacemoltError("session_create_failed", `game-session bootstrap returned ${boot.status}`);
    }
    await boot.text().catch(() => "");
    await this.rpc(buildInitializeRequest(this.nextId++), true);
    await this.rpc(INITIALIZED_NOTIFICATION, false);
  }

  /** Authenticate. Sends NO session_id (the server rejects it on login with
   * "Unknown parameter(s): session_id"); parses `Session ID: <hex>` out of the
   * greeting and adopts it as the canonical game session id (falling back to the
   * transport id if the greeting line is absent). Stores credentials so the
   * recovery path can re-login. */
  async login(username: string, password: string): Promise<void> {
    this.credentials = { username, password };
    await this.doLogin(username, password);
  }

  private async doLogin(username: string, password: string): Promise<void> {
    const { response } = await this.rpc(
      buildToolCallRequest(this.nextId++, "spacemolt_auth", "login", { username, password }, null),
      true,
    );
    const rpcErr = (response as { error?: { code?: unknown; message?: string } } | null)?.error;
    if (rpcErr) {
      throw new SpacemoltError(String(rpcErr.code ?? "login_failed"), rpcErr.message ?? "login failed", rpcErr);
    }
    const greeting = extractResultText((response as { result?: unknown } | null)?.result);
    const fromGreeting = greeting ? parseLoginSessionId(greeting) : null;
    this.gameSessionId = fromGreeting ?? this.transportSessionId;
    if (!this.gameSessionId) {
      throw new SpacemoltError("login_no_session", "login returned no game session id (no greeting hex, no transport id)");
    }
  }

  /**
   * Recover a lost session: re-run the handshake and re-login, then let the
   * caller retry once. Single-flight so concurrent expiries share one renewal;
   * circuit-broken so a down server (many renewals in the window) fails fast
   * instead of being hammered.
   */
  private async reauth(): Promise<void> {
    if (this.renewalInFlight) {
      await this.renewalInFlight;
      return;
    }
    const now = this.now();
    this.renewalTimes = this.renewalTimes.filter((t) => now - t < this.renewalWindowMs);
    if (this.renewalTimes.length >= this.maxRenewals) {
      throw new SpacemoltError(
        "session_recovery_exhausted",
        `${this.renewalTimes.length} session renewals within ${this.renewalWindowMs}ms — server may be down`,
      );
    }
    this.renewalTimes.push(now);
    const creds = this.credentials;
    this.renewalInFlight = (async () => {
      await this.handshake();
      if (creds) await this.doLogin(creds.username, creds.password);
    })();
    try {
      await this.renewalInFlight;
    } finally {
      this.renewalInFlight = null;
    }
  }

  /**
   * Call a game tool. Threads the game session as a per-call `session_id`
   * argument (except spacemolt_catalog), retries once through a clean re-login on
   * a session-expiry, and honors a rate-limit / action-pending delay up to
   * MAX_RATE_RETRIES. Tool-level game errors (isError) that are NOT session/rate
   * signals — e.g. "no_resources", a combat interrupt — are RETURNED with
   * isError:true, not thrown, so the caller decides.
   */
  async call(tool: string, action: string, params: Record<string, unknown> = {}): Promise<McpToolResult> {
    let rateRetries = 0;
    let sessionRetried = false;

    for (;;) {
      const { response, status, retryAfterSeconds } = await this.rpc(
        buildToolCallRequest(this.nextId++, tool, action, params, this.gameSessionId),
        true,
      );

      // Transport-level rate limit: HTTP 429 with a Retry-After header. Retry up
      // to the cap, then surface a SpacemoltError (never a silent empty result).
      if (status === 429) {
        if (rateRetries < MAX_RATE_RETRIES) {
          rateRetries++;
          await this.sleep((retryAfterSeconds ?? 10) * 1000);
          continue;
        }
        throw new SpacemoltError("rate_limited", "HTTP 429 rate-limit retries exhausted");
      }

      // JSON-RPC protocol error (session expiry, structured rate limit, ...).
      const rpcErr = (response as { error?: { code?: unknown; message?: string; data?: unknown } } | null)?.error;
      if (rpcErr) {
        const hints = (rpcErr.data ?? {}) as { retry_after?: number; wait_seconds?: number };
        const cls = classifyMcpError(rpcErr.code as number | string | null, rpcErr.message ?? "", hints);
        if (cls.kind === "session" && !sessionRetried) {
          sessionRetried = true;
          await this.reauth();
          continue;
        }
        if ((cls.kind === "rate_limited" || cls.kind === "action_pending") && rateRetries < MAX_RATE_RETRIES) {
          rateRetries++;
          await this.sleep(cls.retryAfterSeconds * 1000);
          continue;
        }
        throw new SpacemoltError(String(rpcErr.code ?? "mcp_error"), rpcErr.message ?? "MCP error", rpcErr);
      }

      const result = (response as { result?: unknown } | null)?.result;
      const isError = !!(result && typeof result === "object" && (result as { isError?: unknown }).isError === true);
      const text = extractResultText(result);

      // A tool-level error whose TEXT signals a session/rate/pending condition is
      // recoverable the same way. Only isError results are inspected this way —
      // never happy-path text — so a chat message that merely contains "try again
      // in..." can't hijack the retry loop (the model reads raw text; we don't act
      // on its content, only on flagged errors).
      if (isError && text) {
        const cls = classifyMcpError(null, text);
        if (cls.kind === "session" && !sessionRetried) {
          sessionRetried = true;
          await this.reauth();
          continue;
        }
        if ((cls.kind === "rate_limited" || cls.kind === "action_pending") && rateRetries < MAX_RATE_RETRIES) {
          rateRetries++;
          await this.sleep(cls.retryAfterSeconds * 1000);
          continue;
        }
      }

      // Envelope unwrap: only when the content text is a JSON object whose keys
      // are ALL envelope keys (gantry's defensive rule). MCP reads are text
      // dashboards (not JSON), so this is a no-op for them; it matters only for
      // the rare tool that returns an enveloped JSON string, from which we also
      // lift any notifications.
      let finalText = text;
      let notifications: EnvelopeNotification[] = [];
      if (text !== null) {
        try {
          const parsed = JSON.parse(text) as unknown;
          const unwrapped = unwrapEnvelope(parsed);
          if (unwrapped !== parsed) {
            const env = parsed as { notifications?: unknown };
            notifications = Array.isArray(env.notifications) ? (env.notifications as EnvelopeNotification[]) : [];
            finalText = typeof unwrapped === "string" ? unwrapped : JSON.stringify(unwrapped);
          }
        } catch {
          // Not JSON — a text dashboard. Leave finalText as the raw string.
        }
      }

      return { text: finalText, notifications, isError, raw: response };
    }
  }
}

/** Parse a Retry-After header value. Honors the numeric-seconds form; ignores
 * the HTTP-date form (returns null so the caller falls back to a default). */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const n = Number(headerValue.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}
