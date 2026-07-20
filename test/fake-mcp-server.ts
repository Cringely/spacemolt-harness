// Fake MCP Streamable-HTTP server for offline probe tests. Speaks the same
// JSON-RPC-over-POST shape the real game MCP endpoint does (per improv-mode
// plan §3): initialize returns an Mcp-Session-Id header; tools/call name=
// spacemolt_auth action=login returns a greeting carrying `Session ID: <hex>`;
// other tool calls return content[0].text. It records every call so tests can
// assert session-id threading (argument vs header) and request shape.
//
// Two response encodings are supported so the SSE-aware parse gets exercised:
// set mode:"sse" to have tool results come back as text/event-stream.

export interface FakeMcpCall {
  method: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  mcpSessionIdHeader: string | null;
}

export interface FakeMcpServer {
  url: string;
  calls: FakeMcpCall[];
  /** Override the text a given tool/action returns (raw string == content[0].text). */
  setToolText(tool: string, action: string, text: string): void;
  /** Return a tool-level error result (result.isError=true + text) for a given
   * tool/action — the shape a benign game error like "no_resources" takes. */
  setToolErrorText(tool: string, action: string, text: string): void;
  /** Make the next tools/call return a JSON-RPC error object. */
  failNextToolWith(error: { code: number; message: string }): void;
  /** Fail the next `count` NON-auth tool calls with a JSON-RPC error. Auth logins
   * are exempt so a session-recovery re-login can still succeed. Used to exercise
   * the transport's -32001 recovery, single-flight, and circuit breaker. */
  failNextToolsWith(error: { code: number; message: string }, count: number): void;
  /** Return a tool-level rate-limit result (isError text "Try again in N
   * seconds") for the next `count` NON-auth calls, then succeed. */
  rateLimitNextTools(retryAfterSeconds: number, count: number): void;
  /** Return a transport-level HTTP 429 with an EMPTY (non-JSON) body and a
   * Retry-After header for the next `count` NON-auth calls — the shape an edge/
   * proxy limiter takes, which must not throw a JSON parse. */
  http429NextTools(retryAfterSeconds: number, count: number): void;
  stop(): void;
}

export interface FakeMcpOptions {
  /** "json" (default) or "sse" — the transport encoding for tool results. */
  mode?: "json" | "sse";
  /** The hex session id embedded in the login greeting. */
  greetingSessionId?: string;
  /** The Mcp-Session-Id header value returned by initialize. */
  transportSessionId?: string;
}

const GREETING = (sid: string) =>
  `Welcome back, Captain.\nSession ID: ${sid}\nYou are docked at Grand Exchange Station.`;

export function startFakeMcpServer(opts: FakeMcpOptions = {}): FakeMcpServer {
  const mode = opts.mode ?? "json";
  const greetingSid = opts.greetingSessionId ?? "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
  const transportSid = opts.transportSessionId ?? "mcp-sess-11112222-3333-4444-5555-666677778888";
  const calls: FakeMcpCall[] = [];
  const toolText = new Map<string, string>();
  const toolErrorText = new Map<string, string>();
  let pendingToolError: { code: number; message: string } | null = null;
  // Persistent (count-based) injections that skip auth logins so recovery works.
  let failToolCount = 0;
  let failToolError: { code: number; message: string } | null = null;
  let rateLimitCount = 0;
  let rateLimitSeconds = 0;
  let http429Count = 0;
  let http429Seconds = 0;
  let idCounter = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Game-session bootstrap (handshake step 1) — a plain REST call, no MCP.
      if (url.pathname === "/api/v1/session" && req.method === "POST") {
        return Response.json({ session: { id: "game-sess-fake", expires_at: "2099-01-01T00:00:00Z" } });
      }
      if (!url.pathname.startsWith("/mcp/v2") || req.method !== "POST") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const mcpSessionIdHeader = req.headers.get("mcp-session-id");
      const body = (await req.json().catch(() => ({}))) as {
        method?: string;
        id?: number;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      const method = body.method ?? "";

      if (method === "initialize") {
        calls.push({ method, mcpSessionIdHeader });
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id ?? ++idCounter,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-spacemolt-mcp", version: "0.0.0" },
            },
          },
          { headers: { "mcp-session-id": transportSid } },
        );
      }

      if (method === "notifications/initialized") {
        calls.push({ method, mcpSessionIdHeader });
        return new Response(null, { status: 202 });
      }

      if (method === "tools/call") {
        const toolName = body.params?.name;
        const args = body.params?.arguments ?? {};
        calls.push({ method, toolName, arguments: args, mcpSessionIdHeader });

        const action = String(args["action"] ?? "");
        const isAuthLogin = toolName === "spacemolt_auth" && action === "login";

        // Transport-level HTTP 429, empty body (proves the parse doesn't throw).
        if (http429Count > 0 && !isAuthLogin) {
          http429Count--;
          return new Response("", { status: 429, headers: { "retry-after": String(http429Seconds) } });
        }
        if (pendingToolError) {
          const err = pendingToolError;
          pendingToolError = null;
          return encode(mode, { jsonrpc: "2.0", id: body.id ?? ++idCounter, error: err });
        }
        // Count-based JSON-RPC error injection — skips auth so recovery re-logins
        // succeed and the transport can complete a renewal.
        if (failToolCount > 0 && failToolError && !isAuthLogin) {
          failToolCount--;
          return encode(mode, { jsonrpc: "2.0", id: body.id ?? ++idCounter, error: failToolError });
        }
        // Tool-level rate-limit result (isError text) — also auth-exempt.
        if (rateLimitCount > 0 && !isAuthLogin) {
          rateLimitCount--;
          return encode(mode, {
            jsonrpc: "2.0",
            id: body.id ?? ++idCounter,
            result: { content: [{ type: "text", text: `Rate limited. Try again in ${rateLimitSeconds} seconds` }], isError: true },
          });
        }

        const errText = toolErrorText.get(`${toolName}/${action}`);
        if (errText !== undefined) {
          return encode(mode, {
            jsonrpc: "2.0",
            id: body.id ?? ++idCounter,
            result: { content: [{ type: "text", text: errText }], isError: true },
          });
        }

        let text: string;
        if (isAuthLogin) {
          text = GREETING(greetingSid);
        } else {
          text = toolText.get(`${toolName}/${action}`) ?? JSON.stringify({ ok: true, action });
        }
        return encode(mode, {
          jsonrpc: "2.0",
          id: body.id ?? ++idCounter,
          result: { content: [{ type: "text", text }] },
        });
      }

      return Response.json({ jsonrpc: "2.0", id: body.id ?? ++idCounter, error: { code: -32601, message: "method not found" } });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    calls,
    setToolText: (tool, action, text) => void toolText.set(`${tool}/${action}`, text),
    setToolErrorText: (tool, action, text) => void toolErrorText.set(`${tool}/${action}`, text),
    failNextToolWith: (error) => void (pendingToolError = error),
    failNextToolsWith: (error, count) => {
      failToolError = error;
      failToolCount = count;
    },
    rateLimitNextTools: (retryAfterSeconds, count) => {
      rateLimitSeconds = retryAfterSeconds;
      rateLimitCount = count;
    },
    http429NextTools: (retryAfterSeconds, count) => {
      http429Seconds = retryAfterSeconds;
      http429Count = count;
    },
    stop: () => void server.stop(true),
  };
}

function encode(mode: "json" | "sse", payload: object): Response {
  if (mode === "sse") {
    // A minimal SSE frame: an `event:` line and the payload on a `data:` line.
    const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    return new Response(frame, { headers: { "content-type": "text/event-stream" } });
  }
  return Response.json(payload);
}
