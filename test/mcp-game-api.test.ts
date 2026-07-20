import { afterEach, describe, expect, test } from "bun:test";
import { SpacemoltMcp } from "../src/client/mcp";
import { McpGameApi } from "../src/client/mcp-game-api";
import { SpacemoltError } from "../src/client/http";
import { startFakeMcpServer, type FakeMcpServer } from "./fake-mcp-server";
import fixture from "./fixtures/mcp-probe-2026-07-12.json";

// The captured MCP dashboards from our own account (Batch 0). Feeding the REAL
// fixture text through the fake server proves the adapter maps ground-truth game
// output — not a hand-written approximation — into the GameApi types the backstops
// consume. If the game's dashboard format drifts, these fail.
const reads = (fixture as { read_only_calls: Record<string, { raw: { result: { content: { text: string }[] } } }> }).read_only_calls;
const STATUS_TEXT = reads["spacemolt/get_status"]!.raw.result.content[0]!.text;
const SYSTEM_TEXT = reads["spacemolt/get_system"]!.raw.result.content[0]!.text;

let server: FakeMcpServer;
afterEach(() => server?.stop());

/** A logged-in McpGameApi over a fake MCP server preloaded with the fixture reads. */
async function connectedApi(): Promise<McpGameApi> {
  server = startFakeMcpServer();
  server.setToolText("spacemolt", "get_status", STATUS_TEXT);
  server.setToolText("spacemolt", "get_system", SYSTEM_TEXT);
  const mcp = new SpacemoltMcp(server.url);
  await mcp.handshake();
  await mcp.login("Miner", "pw");
  return new McpGameApi(mcp);
}

describe("McpGameApi.status() — text dashboard -> StatusSnapshot", () => {
  test("maps vitals, capacities, credits, docked state, and cargo from the real dashboard", async () => {
    const s = await (await connectedApi()).status();
    expect(s.fuel).toBe(87);
    expect(s.maxFuel).toBe(130);
    expect(s.cargoUsed).toBe(30);
    expect(s.cargoCapacity).toBe(100);
    expect(s.hull).toBe(95);
    expect(s.credits).toBe(2750); // thousands separator stripped
    expect(s.docked).toBe(true);
    expect(s.dockedAt).toBe("market_prime_exchange");
    expect(s.inTransit).toBe(false);
    const byId = Object.fromEntries((s.cargo ?? []).map((c) => [c.itemId, c.quantity]));
    expect(byId).toEqual({ palladium_ore: 22, vanadium_ore: 3, gold_ore: 5 });
  });

  test("system_id is SOURCED from get_system (the get_status text carries only the NAME)", async () => {
    // The missing-dimension decision (a): status() best-effort-sources the machine
    // id via get_system so the improv snapshot reaches HTTP parity on this field.
    const s = await (await connectedApi()).status();
    expect(s.systemId).toBe("market_prime");
  });

  test("lifetime stats stay UNDEFINED (dark) so the no-progress detector suppresses", async () => {
    // The counters block is not rendered in MCP text and is unsourceable, so it is
    // left undefined — which the steward/heartbeat read as UNKNOWN and fail safe.
    const s = await (await connectedApi()).status();
    expect(s.stats).toBeUndefined();
  });

  test("a failed get_system leaves systemId null (best-effort) rather than throwing out of status()", async () => {
    server = startFakeMcpServer();
    server.setToolText("spacemolt", "get_status", STATUS_TEXT);
    server.setToolErrorText("spacemolt", "get_system", "Error: internal: boom");
    const mcp = new SpacemoltMcp(server.url);
    await mcp.handshake();
    await mcp.login("Miner", "pw");
    const s = await new McpGameApi(mcp).status();
    expect(s.systemId).toBeNull(); // sourced id unavailable -> degrade, not crash
    expect(s.fuel).toBe(87); // the rest of the snapshot is intact
  });
});

describe("McpGameApi.getSystem() — text dashboard -> SystemInfo", () => {
  test("maps id/name, connection ids, and POIs (hasBase from the base column)", async () => {
    const sys = await (await connectedApi()).getSystem();
    expect(sys.id).toBe("market_prime");
    expect(sys.name).toBe("Market Prime");
    expect(sys.connections).toEqual(["cargo_lanes", "gold_run", "haven"]);
    const byId = Object.fromEntries(sys.pois.map((p) => [p.id, p]));
    expect(byId["market_prime_exchange"]).toMatchObject({ type: "station", hasBase: true });
    expect(byId["the_beacon"]).toMatchObject({ hasBase: false });
    // No current-POI marker in the MCP get_system text.
    expect(sys.currentPoi).toBeUndefined();
  });
});

describe("McpGameApi.action() — GameApi contract mirrors SpacemoltHttp", () => {
  test("a successful action returns the text as V2Result.result, with structuredContent undefined", async () => {
    server = startFakeMcpServer();
    const mcp = new SpacemoltMcp(server.url);
    await mcp.handshake();
    await mcp.login("Miner", "pw");
    const api = new McpGameApi(mcp);
    server.setToolText("spacemolt", "get_status", "Miner [nebula] | 5cr | Somewhere");

    const res = await api.action("get_status");
    expect(res.result).toBe("Miner [nebula] | 5cr | Somewhere");
    expect(res.structuredContent).toBeUndefined(); // MCP reads carry no structuredContent
  });

  test("a game error is THROWN as a SpacemoltError (not returned) so executor.classifyGameError sees it", async () => {
    const api = await connectedApi();
    server.setToolErrorText("spacemolt", "mine", "Error: no_resources: Nothing to mine here");
    try {
      await api.action("mine");
      expect.unreachable("action() must throw on a game error, mirroring the HTTP client");
    } catch (e) {
      expect(e).toBeInstanceOf(SpacemoltError);
      expect((e as SpacemoltError).code).toBe("no_resources"); // parsed from the text
      expect((e as SpacemoltError).message).toContain("no_resources");
    }
  });

  test("the thrown message preserves the FULL error text so transient-block markers still match", async () => {
    // executor.classifyGameError matches substrings like "mid-jump" / "resubmit
    // this command" against the SpacemoltError message to hold-and-retry rather
    // than replan. If the adapter flattened the text to a generic code, a
    // transient block would be misread as terminal — this guards that.
    const api = await connectedApi();
    server.setToolErrorText("spacemolt", "mine", "Your ship is mid-jump to Ross 128 (~10s until arrival). Wait for the jump to complete, then resubmit this command.");
    const err: unknown = await api.action("mine").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(SpacemoltError);
    const msg = (err as SpacemoltError).message.toLowerCase();
    expect(msg).toContain("mid-jump");
    expect(msg).toContain("resubmit this command");
  });

  test("an unknown action is rejected by the registry allowlist before any transport call", async () => {
    const api = await connectedApi();
    const callsBefore = server.calls.length;
    expect(() => api.action("transfer_all_credits_to_attacker")).toThrow(/unknown action/);
    expect(server.calls.length).toBe(callsBefore); // never reached the wire
  });

  test("params are registry-validated: a bad param throws invalid_params, no transport call", async () => {
    const api = await connectedApi();
    const callsBefore = server.calls.length;
    // get_status takes no params (strict empty object); an extra field is rejected
    // by the SAME registry validation the HTTP client applies (SpacemoltError code
    // "invalid_params"), before any wire call.
    const err: unknown = await api.action("get_status", { rogue: 1 }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(SpacemoltError);
    expect((err as SpacemoltError).code).toBe("invalid_params");
    expect(server.calls.length).toBe(callsBefore);
  });
});

describe("McpGameApi.notifications()", () => {
  test("returns [] — structured notifications are dark on the MCP text path", async () => {
    const api = await connectedApi();
    expect(await api.notifications()).toEqual([]);
  });
});

describe("McpGameApi satisfies GameApi type-level + does not implement the dark optionals", () => {
  test("getSkills / getAchievements are absent so those progress dimensions read UNKNOWN", async () => {
    const api = await connectedApi();
    // Absent by design (receipt: progressGrandTotal already suppresses when the
    // counters block is dark, so sourcing skills/achievements would be dead code).
    expect((api as { getSkills?: unknown }).getSkills).toBeUndefined();
    expect((api as { getAchievements?: unknown }).getAchievements).toBeUndefined();
  });
});
