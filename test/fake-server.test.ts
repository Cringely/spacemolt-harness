import { afterEach, describe, expect, test } from "bun:test";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

describe("fake server", () => {
  test("creates sessions and requires them for game calls", async () => {
    server = startFakeServer();
    const sess = await fetch(`${server.url}/api/v2/session`, { method: "POST" });
    const sessBody = (await sess.json()) as { session: { id: string } };
    expect(sessBody.session.id.length).toBeGreaterThan(0);

    const noSession = await fetch(`${server.url}/api/v2/spacemolt/mine`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    });
    const noSessionBody = (await noSession.json()) as { error: { code: string } };
    expect(noSessionBody.error.code).toBe("session_required");

    const ok = await fetch(`${server.url}/api/v2/spacemolt/mine`, {
      method: "POST", body: "{}",
      headers: { "content-type": "application/json", "X-Session-Id": sessBody.session.id },
    });
    expect(((await ok.json()) as { result: string }).result).toBe("ok");
    expect(server.calls.at(-1)).toMatchObject({ tool: "spacemolt", action: "mine" });
  });

  test("setHandler overrides and failNextWith injects one error", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: { ship: { fuel: 10, max_fuel: 100 } },
    }));
    server.failNextWith({ code: "rate_limited", message: "slow down", retry_after: 1 });

    const sess = await fetch(`${server.url}/api/v2/session`, { method: "POST" });
    const { session } = (await sess.json()) as { session: { id: string } };
    const hdrs = { "content-type": "application/json", "X-Session-Id": session.id };

    const failed = await fetch(`${server.url}/api/v2/spacemolt/get_status`, {
      method: "POST", body: "{}", headers: hdrs,
    });
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    const ok = await fetch(`${server.url}/api/v2/spacemolt/get_status`, {
      method: "POST", body: "{}", headers: hdrs,
    });
    const body = (await ok.json()) as { structuredContent: { ship: { fuel: number } } };
    expect(body.structuredContent.ship.fuel).toBe(10);
  });
});
