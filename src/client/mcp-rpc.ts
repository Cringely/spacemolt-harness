// Shared MCP JSON-RPC wire helpers — the pure request builders and response
// parsers for the game's MCP Streamable-HTTP interface. One definition of the
// wire shapes (SSOT), composed by the SpacemoltMcp transport (mcp.ts).
//
// These were written for the Batch 0 live probe (src/tools/mcp-probe.ts) and
// lived there until #122: the probe was a one-shot diagnostic whose fixture is
// committed, but the transport REUSED its builders, so the probe was
// load-bearing for production. The helpers moved here and the spent probe was
// deleted. No I/O in this file — callers compose these over real fetch.

/** MCP Streamable-HTTP endpoint path; `?preset=` selects the tool set. */
export const MCP_ENDPOINT_PATH = "/mcp/v2";
/** Game session bootstrap for the MCP flow (gantry: a plain REST call). */
export const GAME_SESSION_PATH = "/api/v1/session";

/** The game's standard result envelope keys (improv-mode plan §3 "Response shape"). */
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["result", "notifications", "session", "error"]);
/** Tools the v2 schema does NOT thread a game session on (plan §3). */
const NO_SESSION_ID_TOOLS: ReadonlySet<string> = new Set(["spacemolt_catalog"]);

/**
 * MCP Streamable HTTP may answer a POST with either `application/json` or a
 * `text/event-stream`. For SSE, the JSON-RPC payload is the last `data:` line
 * (plan §3 "Transport can be SSE"). Returns the parsed JSON-RPC object.
 */
export function parseJsonRpcPayload(contentType: string | null, rawBody: string): unknown {
  const isSse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isSse) return JSON.parse(rawBody);
  const dataLines = rawBody
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice("data:".length).trim())
    .filter((l) => l.length > 0);
  const last = dataLines.at(-1);
  if (last === undefined) throw new Error("SSE response contained no data: line");
  return JSON.parse(last);
}

/** Pull the text payload out of a JSON-RPC tool result (`result.content[i].text`). */
export function extractResultText(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
      return (entry as { text: string }).text;
    }
  }
  return null;
}

/**
 * Unwrap the game's standard envelope, but ONLY when every key is an envelope
 * key (gantry's defensive rule) — otherwise a real payload that happens to
 * carry a `result` field would be mangled. A no-op on a bare payload.
 */
export function unwrapEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return value;
  const allEnvelope = keys.every((k) => ENVELOPE_KEYS.has(k));
  if (allEnvelope && "result" in obj) return obj["result"];
  return value;
}

const SESSION_LINE = /Session ID:\s*([0-9a-fA-F]{8,})/;

/** Parse the `Session ID: <hex>` line out of the login greeting (plan §3). */
export function parseLoginSessionId(greeting: string): string | null {
  const m = greeting.match(SESSION_LINE);
  return m ? (m[1] ?? null) : null;
}

/**
 * Thread the game session as a per-call ARGUMENT (gantry model — unknown #1,
 * settled live in Batch 0). Skips login's null session and the one tool the v2
 * schema exempts. Returns a fresh object; never mutates the input.
 */
function injectSessionId(
  tool: string,
  args: Record<string, unknown>,
  sessionId: string | null,
): Record<string, unknown> {
  if (sessionId === null || NO_SESSION_ID_TOOLS.has(tool)) return { ...args };
  return { ...args, session_id: sessionId };
}

export function buildInitializeRequest(id: number): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "spacemolt-harness-mcp", version: "0.1.0" },
    },
  };
}

export const INITIALIZED_NOTIFICATION: object = { jsonrpc: "2.0", method: "notifications/initialized" };

export function buildToolCallRequest(
  id: number,
  tool: string,
  action: string,
  params: Record<string, unknown>,
  sessionId: string | null,
): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: tool,
      arguments: injectSessionId(tool, { action, ...params }, sessionId),
    },
  };
}
