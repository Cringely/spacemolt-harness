import { afterEach, describe, expect, test } from "bun:test";
import { SpacemoltHttp, SpacemoltError } from "../src/client/http";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

const noSleep = { sleep: async () => {} };

describe("SpacemoltHttp", () => {
  test("creates session and sends X-Session-Id", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    const res = await http.call("spacemolt", "get_status");
    expect(res.result).toBe("ok");
    expect(server.calls.at(-1)!.sessionId).toBe("sess-1");
  });

  test("retries after rate_limited", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.failNextWith({ code: "rate_limited", message: "wait", retry_after: 1 });
    const res = await http.call("spacemolt", "mine");
    expect(res.result).toBe("ok");
    // two mine calls hit the server: the failed one and the retry
    expect(server.calls.filter((c) => c.action === "mine").length).toBe(2);
  });

  test("recovers session and re-authenticates on session_invalid", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    let reauths = 0;
    http.onReauth = async () => void reauths++;
    server.failNextWith({ code: "session_invalid", message: "expired" });
    const res = await http.call("spacemolt", "get_poi");
    expect(res.result).toBe("ok");
    expect(reauths).toBe(1);
    expect(server.calls.at(-1)!.sessionId).toBe("sess-2"); // fresh session used
  });

  test("throws SpacemoltError after exhausting rate-limit retries", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    // persistent handler (not failNextWith, which only fires once): every
    // call to this action comes back rate_limited, forcing the retry loop
    // to exhaust MAX_RATE_RETRIES and fall through to the terminal throw.
    server.setHandler("spacemolt", "mine", () => ({ error: { code: "rate_limited", message: "still busy" } }));
    try {
      await http.call("spacemolt", "mine");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpacemoltError);
      expect((e as SpacemoltError).code).toBe("rate_limited");
    }
    expect(server.calls.filter((c) => c.action === "mine").length).toBe(4); // initial + 3 retries
  });

  test("throws SpacemoltError with code on command errors", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.failNextWith({ code: "command_error", message: "cargo full" });
    try {
      await http.call("spacemolt", "mine");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpacemoltError);
      expect((e as SpacemoltError).code).toBe("command_error");
      expect((e as SpacemoltError).message).toBe("cargo full");
    }
  });

  test("re-authenticates on broadened session_expired taxonomy", async () => {
    // session_expired is a gantry-ported code the old client didn't recognize;
    // proves the taxonomy port, not just the pre-existing session_invalid path.
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    let reauths = 0;
    http.onReauth = async () => void reauths++;
    server.failNextWith({ code: "session_expired", message: "gone" });
    const res = await http.call("spacemolt", "scan");
    expect(res.result).toBe("ok");
    expect(reauths).toBe(1);
    expect(server.calls.at(-1)!.sessionId).toBe("sess-2");
  });

  test("re-authenticates on session-expired message when code is unknown", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    let reauths = 0;
    http.onReauth = async () => void reauths++;
    server.failNextWith({ code: "weird_code", message: "Session expired (server restarted)" });
    const res = await http.call("spacemolt", "scan");
    expect(res.result).toBe("ok");
    expect(reauths).toBe(1);
  });

  test("retries transient server_error with backoff then succeeds", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    let n = 0;
    server.setHandler("spacemolt", "scan", () =>
      ++n <= 2 ? { error: { code: "server_error", message: "down" } } : { result: "ok" });
    const res = await http.call("spacemolt", "scan");
    expect(res.result).toBe("ok");
    expect(n).toBe(3); // two failures + one success
  });

  test("retries a bodyless 503 gateway error (no JSON body)", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.failNextWithStatus(503);
    const res = await http.call("spacemolt", "scan");
    expect(res.result).toBe("ok");
    expect(server.calls.filter((c) => c.action === "scan").length).toBe(2);
  });

  test("retries a bodyless 500 (any 5xx is transient, not just gateway codes)", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.failNextWithStatus(500);
    const res = await http.call("spacemolt", "scan");
    expect(res.result).toBe("ok");
  });

  test("retries a non-JSON body on a 2xx (truncated response) instead of throwing SyntaxError", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.failNextWithStatus(200); // fake returns a plain-text body, not JSON
    const res = await http.call("spacemolt", "scan");
    expect(res.result).toBe("ok");
  });

  test("surfaces server_error after exhausting server retries", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.setHandler("spacemolt", "scan", () => ({ error: { code: "server_error", message: "down" } }));
    try {
      await http.call("spacemolt", "scan");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpacemoltError);
      expect((e as SpacemoltError).code).toBe("server_error");
    }
    expect(server.calls.filter((c) => c.action === "scan").length).toBe(4); // initial + 3 retries
  });

  test("circuit breaker opens after repeated server failures and fails fast", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.setHandler("spacemolt", "scan", () => ({ error: { code: "server_error", message: "down" } }));
    // Drive enough failures to trip CIRCUIT_THRESHOLD (each call = 4 attempts).
    await http.call("spacemolt", "scan").catch(() => {});
    await http.call("spacemolt", "scan").catch(() => {});
    const before = server.calls.filter((c) => c.action === "scan").length;
    try {
      await http.call("spacemolt", "scan");
      expect.unreachable();
    } catch (e) {
      expect((e as SpacemoltError).code).toBe("circuit_open");
    }
    // Open breaker short-circuits: the server saw no additional scan calls.
    expect(server.calls.filter((c) => c.action === "scan").length).toBe(before);
  });

  test("circuit breaker closes again after the cooldown elapses", async () => {
    server = startFakeServer();
    let clock = 1_000_000;
    const http = new SpacemoltHttp(server.url, { sleep: async () => {}, now: () => clock });
    await http.createSession();
    let down = true;
    server.setHandler("spacemolt", "scan", () =>
      down ? { error: { code: "server_error", message: "down" } } : { result: "ok" });
    // Trip the breaker open.
    await http.call("spacemolt", "scan").catch(() => {});
    await http.call("spacemolt", "scan").catch(() => {});
    const open = await http.call("spacemolt", "scan").catch((e) => e as SpacemoltError);
    expect((open as SpacemoltError).code).toBe("circuit_open");
    // Advance past the 30s cooldown; server is healthy again.
    clock += 31_000;
    down = false;
    const res = await http.call("spacemolt", "scan");
    expect(res.result).toBe("ok");
  });

  test("circuit breaker is per-tool: one down tool doesn't block another", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.setHandler("broken", "scan", () => ({ error: { code: "server_error", message: "down" } }));
    await http.call("broken", "scan").catch(() => {});
    await http.call("broken", "scan").catch(() => {});
    // A different tool is unaffected by broken's open breaker.
    const res = await http.call("spacemolt", "get_status");
    expect(res.result).toBe("ok");
  });
});
