// Unit tests for the shared MCP JSON-RPC wire helpers (src/client/mcp-rpc.ts),
// preserved from the deleted Batch 0 probe test when the helpers moved (#122).
// The SpacemoltMcp transport composes these; mcp-game-api / mcp-transport tests
// exercise them end-to-end, but these pin the edge cases (SSE last-data line,
// the envelope defensive rule, session threading) directly.
import { describe, expect, test } from "bun:test";
import {
  parseJsonRpcPayload,
  extractResultText,
  unwrapEnvelope,
  parseLoginSessionId,
  buildToolCallRequest,
} from "../src/client/mcp-rpc";

describe("parseJsonRpcPayload", () => {
  test("reads the last data: line of an SSE stream", () => {
    const sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
    expect(parseJsonRpcPayload("text/event-stream", sse)).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  test("parses plain JSON when content-type is application/json", () => {
    expect(parseJsonRpcPayload("application/json", '{"a":1}')).toEqual({ a: 1 });
  });

  test("throws when an SSE stream carries no data line (catches a silent empty parse)", () => {
    expect(() => parseJsonRpcPayload("text/event-stream", "event: ping\n\n")).toThrow();
  });
});

describe("extractResultText", () => {
  test("pulls text out of content[]", () => {
    expect(extractResultText({ content: [{ type: "text", text: "hi" }] })).toBe("hi");
  });
  test("returns null when there is no text entry", () => {
    expect(extractResultText({ content: [{ type: "image", data: "x" }] })).toBeNull();
    expect(extractResultText({})).toBeNull();
  });
});

describe("unwrapEnvelope", () => {
  test("unwraps when every key is an envelope key", () => {
    expect(unwrapEnvelope({ result: { credits: 5 }, notifications: [] })).toEqual({ credits: 5 });
  });
  test("does NOT unwrap a real payload that merely has a result field", () => {
    // credits is not an envelope key, so this is a bare payload -> untouched.
    const payload = { result: "ok", credits: 5 };
    expect(unwrapEnvelope(payload)).toBe(payload);
  });
  test("is a no-op on a bare object with no result key", () => {
    const p = { credits: 5 };
    expect(unwrapEnvelope(p)).toBe(p);
  });
});

describe("parseLoginSessionId", () => {
  test("extracts the hex after 'Session ID:'", () => {
    expect(parseLoginSessionId("Welcome\nSession ID: deadbeef0123\nDocked")).toBe("deadbeef0123");
  });
  test("returns null when the greeting has no session line", () => {
    expect(parseLoginSessionId("Welcome, Captain.")).toBeNull();
  });
});

describe("buildToolCallRequest", () => {
  test("login (null session) sends no session_id, so the server won't reject with 'Unknown parameter'", () => {
    const req = buildToolCallRequest(1, "spacemolt_auth", "login", { username: "u", password: "p" }, null) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(req.params.name).toBe("spacemolt_auth");
    expect(req.params.arguments).toEqual({ action: "login", username: "u", password: "p" });
    expect("session_id" in req.params.arguments).toBe(false);
  });
  test("a normal call threads the game session as a per-call argument (gantry model)", () => {
    const req = buildToolCallRequest(2, "spacemolt", "sell", { id: "iron", quantity: 3 }, "SID") as {
      params: { arguments: Record<string, unknown> };
    };
    expect(req.params.arguments).toEqual({ action: "sell", id: "iron", quantity: 3, session_id: "SID" });
  });
  test("spacemolt_catalog is exempt from session threading (v2 schema)", () => {
    const req = buildToolCallRequest(3, "spacemolt_catalog", "list", {}, "SID") as {
      params: { arguments: Record<string, unknown> };
    };
    expect("session_id" in req.params.arguments).toBe(false);
    expect(req.params.arguments).toEqual({ action: "list" });
  });
});
