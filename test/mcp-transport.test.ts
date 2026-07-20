import { afterEach, describe, expect, test } from "bun:test";
import { SpacemoltMcp } from "../src/client/mcp";
import { SpacemoltError } from "../src/client/http";
import { startFakeMcpServer, type FakeMcpServer } from "./fake-mcp-server";

let server: FakeMcpServer;
afterEach(() => server?.stop());

/** A sleep spy: records requested delays and resolves instantly (no real wait). */
function sleepSpy() {
  const calls: number[] = [];
  return { calls, sleep: async (ms: number) => void calls.push(ms) };
}

const authLogins = (s: FakeMcpServer) => s.calls.filter((c) => c.toolName === "spacemolt_auth").length;

async function connected(opts: Parameters<typeof startFakeMcpServer>[0] = {}, mcpOpts = {}) {
  server = startFakeMcpServer(opts);
  const mcp = new SpacemoltMcp(server.url, mcpOpts);
  await mcp.handshake();
  await mcp.login("Cmdr", "pw");
  return mcp;
}

describe("SpacemoltMcp handshake + session threading", () => {
  test("login parses the greeting hex, sends no session_id, and later calls thread it as an argument", async () => {
    const mcp = await connected({ greetingSessionId: "feedface1234", transportSessionId: "mcp-abc" });
    expect(mcp.gameSessionId).toBe("feedface1234");
    expect(mcp.transportSessionId).toBe("mcp-abc");

    await mcp.call("spacemolt", "get_status");

    const loginCall = server.calls.find((c) => c.toolName === "spacemolt_auth");
    expect(loginCall?.arguments && "session_id" in loginCall.arguments).toBe(false);

    const statusCall = server.calls.find((c) => c.arguments?.["action"] === "get_status");
    expect(statusCall?.arguments?.["session_id"]).toBe("feedface1234");
    expect(statusCall?.mcpSessionIdHeader).toBe("mcp-abc"); // transport id echoed in the header
  });

  test("spacemolt_catalog is exempt from session_id injection (v2 schema)", async () => {
    const mcp = await connected();
    await mcp.call("spacemolt_catalog", "list");
    const catalogCall = server.calls.find((c) => c.toolName === "spacemolt_catalog");
    expect(catalogCall?.arguments && "session_id" in catalogCall.arguments).toBe(false);
  });

  test("SSE transport encoding is parsed (last data: line)", async () => {
    const mcp = await connected({ mode: "sse", greetingSessionId: "cafe9999" });
    expect(mcp.gameSessionId).toBe("cafe9999");
    server.setToolText("spacemolt", "get_skills", "Skills (0):");
    const r = await mcp.call("spacemolt", "get_skills");
    expect(r.text).toBe("Skills (0):");
  });
});

describe("SpacemoltMcp response handling", () => {
  test("returns a text dashboard verbatim (no envelope, no notifications)", async () => {
    const mcp = await connected();
    server.setToolText("spacemolt", "get_status", "Fuel: 1/2 | Cargo: 3/4");
    const r = await mcp.call("spacemolt", "get_status");
    expect(r.text).toBe("Fuel: 1/2 | Cargo: 3/4");
    expect(r.notifications).toEqual([]);
    expect(r.isError).toBe(false);
  });

  test("unwraps an enveloped JSON result and lifts its notifications", async () => {
    const mcp = await connected();
    server.setToolText("spacemolt", "get_status", JSON.stringify({ result: "inner", notifications: [{ id: "n1", type: "system" }] }));
    const r = await mcp.call("spacemolt", "get_status");
    expect(r.text).toBe("inner");
    expect(r.notifications.length).toBe(1);
    expect(r.notifications[0]).toMatchObject({ id: "n1", type: "system" });
  });

  test("does NOT unwrap a bare JSON payload that merely has a result field", async () => {
    const mcp = await connected();
    const bare = JSON.stringify({ result: "ok", credits: 5 }); // credits is not an envelope key
    server.setToolText("spacemolt", "get_status", bare);
    const r = await mcp.call("spacemolt", "get_status");
    expect(r.text).toBe(bare);
  });

  test("a benign game error (no_resources) is RETURNED with isError, never thrown or retried", async () => {
    const mcp = await connected();
    server.setToolErrorText("spacemolt", "mine", "Error: no_resources: Nothing to mine here");
    const r = await mcp.call("spacemolt", "mine");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no_resources");
    // exactly one mine call — not retried as if it were recoverable
    expect(server.calls.filter((c) => c.arguments?.["action"] === "mine").length).toBe(1);
  });
});

describe("SpacemoltMcp session recovery (load-bearing: ASSUMED)", () => {
  test("a -32001 triggers exactly one re-login then one retry with the new session id", async () => {
    const mcp = await connected({ greetingSessionId: "abcdef123456" });
    server.failNextToolsWith({ code: -32001, message: "Session expired (server may have restarted)" }, 1);
    server.setToolText("spacemolt", "get_status", "RECOVERED");

    const r = await mcp.call("spacemolt", "get_status");
    expect(r.text).toBe("RECOVERED");
    // initial login + exactly one recovery login
    expect(authLogins(server)).toBe(2);
    // two get_status attempts: the failed one and the retry
    const statusCalls = server.calls.filter((c) => c.arguments?.["action"] === "get_status");
    expect(statusCalls.length).toBe(2);
    expect(statusCalls.at(-1)?.arguments?.["session_id"]).toBe("abcdef123456"); // retry threads the re-established id
  });

  test("concurrent expiries share ONE renewal (single-flight)", async () => {
    const mcp = await connected();
    server.failNextToolsWith({ code: -32001, message: "Session expired" }, 2);
    server.setToolText("spacemolt", "get_status", "OK");
    server.setToolText("spacemolt", "get_system", "OK");

    const [a, b] = await Promise.all([mcp.call("spacemolt", "get_status"), mcp.call("spacemolt", "get_system")]);
    expect(a.text).toBe("OK");
    expect(b.text).toBe("OK");
    // two concurrent expiries, but only ONE shared recovery login (2 total, not 3)
    expect(authLogins(server)).toBe(2);
  });

  test("N renewals inside the window trip the circuit breaker and stop retrying", async () => {
    const mcp = await connected({}, { maxRenewalsPerWindow: 2, renewalWindowMs: 60_000 });
    // every get_status stays expired, so each call() forces one renewal
    server.failNextToolsWith({ code: -32001, message: "Session expired" }, 999);

    await expect(mcp.call("spacemolt", "get_status")).rejects.toThrow(); // renewal #1, then throws -32001
    await expect(mcp.call("spacemolt", "get_status")).rejects.toThrow(); // renewal #2
    // renewal #3 is refused by the breaker before hitting the server again
    try {
      await mcp.call("spacemolt", "get_status");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpacemoltError);
      expect((e as SpacemoltError).code).toBe("session_recovery_exhausted");
    }
  });
});

describe("SpacemoltMcp rate-limit retry (load-bearing: ASSUMED)", () => {
  test("a rate-limited tool result waits the server-specified delay, then retries", async () => {
    const spy = sleepSpy();
    server = startFakeMcpServer();
    const mcp = new SpacemoltMcp(server.url, { sleep: spy.sleep });
    await mcp.handshake();
    await mcp.login("Cmdr", "pw");

    server.rateLimitNextTools(5, 1); // first non-auth call rate-limited "Try again in 5 seconds"
    server.setToolText("spacemolt", "get_status", "OK");

    const r = await mcp.call("spacemolt", "get_status");
    expect(r.text).toBe("OK");
    expect(spy.calls).toContain(5000); // honored the 5s delay
  });

  test("a transport HTTP 429 with an empty body honors Retry-After instead of throwing a JSON parse", async () => {
    const spy = sleepSpy();
    server = startFakeMcpServer();
    const mcp = new SpacemoltMcp(server.url, { sleep: spy.sleep });
    await mcp.handshake();
    await mcp.login("Cmdr", "pw");

    server.http429NextTools(3, 1); // first non-auth call -> HTTP 429, empty (non-JSON) body, Retry-After: 3
    server.setToolText("spacemolt", "get_status", "OK");

    const r = await mcp.call("spacemolt", "get_status");
    expect(r.text).toBe("OK");
    expect(spy.calls).toContain(3000); // used the header delay, did not throw on the empty body
  });
});
