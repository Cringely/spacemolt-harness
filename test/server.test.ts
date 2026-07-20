import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import {
  startDashboardServer, loadDashboardToken, loadStoreToken, DASHBOARD_TOKEN_HEADER, STORE_TOKEN_HEADER,
  type DashboardServer,
} from "../src/server/server";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

function stubApi(): GameApi {
  const status: StatusSnapshot = {
    credits: 0, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  return {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
}

function makeAgent(id = "miner") {
  const store = new Store(":memory:");
  const agent = new Agent({
    id, persona: "p", api: stubApi(), store,
    planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
    config, now: () => 0,
  });
  return { agent, store };
}

let server: DashboardServer;
afterEach(() => server?.stop());

describe("GET /api/agents", () => {
  test("returns one snapshot per running agent", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; planState: string; goals: string[]; plannerHealth: unknown }>;
    expect(body.length).toBe(1);
    expect(body[0]!.id).toBe("miner");
    expect(body[0]!.planState).toBe("none");
    expect(body[0]!.goals).toEqual([]);
    expect(body[0]!.plannerHealth).toEqual({
      stalled: false, usingFallback: false, claudeDisabled: false,
      backoffUntil: 0, consecutiveTransientFailures: 0, stuck: false,
    });
  });

  test("serializes AgentStatusView through the snapshot: null before a fetch, ship vitals after", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });

    type StatusBody = Array<{
      status: { fuel: number; maxFuel: number; credits: number; cargo: unknown[] } | null;
    }>;
    // Before any runOnce() the agent has never fetched status.
    const before = (await (await fetch(`http://127.0.0.1:${server.port}/api/agents`)).json()) as StatusBody;
    expect(before[0]!.status).toBeNull();

    await agent.runOnce(); // fetches status (stub: fuel 80/100), retains it
    const after = (await (await fetch(`http://127.0.0.1:${server.port}/api/agents`)).json()) as StatusBody;
    expect(after[0]!.status).not.toBeNull();
    expect(after[0]!.status!.fuel).toBe(80);
    expect(after[0]!.status!.maxFuel).toBe(100);
    expect(after[0]!.status!.credits).toBe(0);
    expect(after[0]!.status!.cargo).toEqual([]);
  });

  test("lists multiple agents", async () => {
    const { agent: a1, store } = makeAgent("miner");
    const a2 = new Agent({
      id: "scout", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [a1, a2] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents`);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((a) => a.id).sort()).toEqual(["miner", "scout"]);
  });
});

describe("GET /api/agents/:id/events", () => {
  test("returns recent events scoped to the agent, respecting limit", async () => {
    const { agent, store } = makeAgent();
    store.appendEvent({ agentId: "miner", ts: 1, type: "wake", payload: { reason: "heartbeat" } });
    store.appendEvent({ agentId: "miner", ts: 2, type: "plan", payload: { goal: "g" } });
    store.appendEvent({ agentId: "scout", ts: 3, type: "wake", payload: { reason: "heartbeat" } });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/events?limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ type: string }>;
    expect(body.length).toBe(1);
    expect(body[0]!.type).toBe("plan"); // most recent event for "miner" -- "scout"'s is excluded by agent_id scoping
  });

  test("defaults the limit when none is given", async () => {
    const { agent, store } = makeAgent();
    for (let i = 0; i < 5; i++) {
      store.appendEvent({ agentId: "miner", ts: i, type: "action", payload: { i } });
    }
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/events`);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(5); // well under the 50-row default cap
  });

  test("unknown agent id returns 404", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/ghost/events`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/agents/:id/usage window selection", () => {
  test("?hours selects the window, invalid falls back to 24, and the cutoff filters the series", async () => {
    const { agent, store } = makeAgent();
    const now = Date.now();
    store.appendEvent({ agentId: "miner", ts: now - 2 * 60 * 60 * 1000, type: "status_snapshot", payload: { credits: 100 } });
    store.appendEvent({ agentId: "miner", ts: now - 30 * 60 * 1000, type: "status_snapshot", payload: { credits: 200 } });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const base = `http://127.0.0.1:${server.port}/api/agents/miner/usage`;

    // 1h window: the 2h-old snapshot is outside the cutoff, so only the recent one is charted.
    const oneHr = (await (await fetch(`${base}?hours=1`)).json()) as { windowHours: number; creditsSeries: Array<{ credits: number }> };
    expect(oneHr.windowHours).toBe(1);
    expect(oneHr.creditsSeries.map((p) => p.credits)).toEqual([200]);

    // No param -> the 1-day default; both snapshots are inside 24h.
    const day = (await (await fetch(base)).json()) as { windowHours: number; creditsSeries: unknown[] };
    expect(day.windowHours).toBe(24);
    expect(day.creditsSeries.length).toBe(2);

    // Out-of-allowlist value falls back to the default rather than scanning arbitrarily far.
    const bad = (await (await fetch(`${base}?hours=999`)).json()) as { windowHours: number };
    expect(bad.windowHours).toBe(24);
  });
});

describe("WS /ws", () => {
  test("broadcasts store events live to connected clients", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });

    const received = new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.onopen = () => {
        store.appendEvent({ agentId: "miner", ts: 123, type: "wake", payload: { reason: "heartbeat" } });
      };
      ws.onmessage = (ev) => resolve(ev.data as string);
    });

    const raw = await received;
    const parsed = JSON.parse(raw) as { agentId: string; type: string; payload: { reason: string } };
    expect(parsed.agentId).toBe("miner");
    expect(parsed.type).toBe("wake");
    expect(parsed.payload.reason).toBe("heartbeat");
  });

  test("does not clobber a pre-existing store.onEvent hook (main.ts sets one for console logging)", async () => {
    const store = new Store(":memory:");
    const seen: string[] = [];
    store.onEvent = (e) => seen.push(e.type);
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    store.appendEvent({ agentId: "miner", ts: 1, type: "wake", payload: {} });
    expect(seen).toEqual(["wake"]); // the pre-existing hook still fires alongside the WS broadcast
  });
});

describe("POST /api/agents/:id/instruct", () => {
  test("valid instruction queues on the agent and wakes it on the next tick", async () => {
    const store = new Store(":memory:");
    const planner = new MockPlanner([
      { goal: "mine", steps: [{ action: "mine", params: {}, repeat: 5 }] },
      { goal: "obey", steps: [{ action: "undock", params: {} }] },
    ]);
    const agent = new Agent({ id: "miner", persona: "p", api: stubApi(), store, planner, config, now: () => 0 });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    await agent.runOnce(); // establishes the mine plan so there's something to abort

    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "stop mining, go dock" }),
    });
    expect(res.status).toBe(204);

    await agent.runOnce(); // instruction wake (evaluateWake checks i.instruction first -- src/agent/wake.ts:30)
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts[1]!.wake.reason).toBe("instruction");
    expect(planner.contexts[1]!.instruction).toBe("stop mining, go dock");
  });

  test("rejects text over the 500-char security-baseline bound", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(501) }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts text at exactly the 500-char bound (off-by-one check on the zod .max())", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(500) }),
    });
    expect(res.status).toBe(204);
  });

  test("rejects empty text", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects malformed JSON", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/instruct`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("unknown agent id returns 404", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/ghost/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/agents/:id/usage", () => {
  test("derives replanAttempts and wake histogram from stored events", async () => {
    const { agent, store } = makeAgent();
    store.appendEvent({ agentId: "miner", ts: Date.now(), type: "wake", payload: { reason: "heartbeat" } });
    store.appendEvent({ agentId: "miner", ts: Date.now(), type: "wake", payload: { reason: "low_fuel" } });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/usage`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replanAttempts: number; wakeReasonHistogram: Record<string, number> };
    expect(body.replanAttempts).toBe(2);
    expect(body.wakeReasonHistogram).toEqual({ heartbeat: 1, low_fuel: 1 });
  });

  test("excludes events older than the 24h window", async () => {
    const { agent, store } = makeAgent();
    store.appendEvent({
      agentId: "miner", ts: Date.now() - 25 * 60 * 60 * 1000, type: "wake", payload: { reason: "heartbeat" },
    });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/usage`);
    const body = (await res.json()) as { replanAttempts: number };
    expect(body.replanAttempts).toBe(0);
  });

  test("unknown agent returns 404", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/ghost/usage`);
    expect(res.status).toBe(404);
  });

  // Batch 2b: the dashboard's trend panels read these off the SAME /usage
  // response as the scalar summary -- a missing field here is a broken panel.
  test("includes the Batch 2b trend fields: planRateSeries, deployMarkers, wakeReasonAlert, creditsSeries", async () => {
    const { agent, store } = makeAgent();
    const now = Date.now();
    store.appendEvent({ agentId: "miner", ts: now, type: "deploy_marker", payload: { buildId: "v-test", startedAt: now } });
    store.appendEvent({ agentId: "miner", ts: now, type: "plan", payload: { goal: "g", model: "sonnet" } });
    store.appendEvent({ agentId: "miner", ts: now, type: "status_snapshot", payload: { credits: 500 } });
    // 5 low_fuel wakes -> clears the min-wakes floor and dominates the mix.
    for (let i = 0; i < 5; i++) {
      store.appendEvent({ agentId: "miner", ts: now, type: "wake", payload: { reason: "low_fuel" } });
    }
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });

    const body = (await (await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/usage`)).json()) as {
      planRateSeries: Array<{ ts: number; count: number }>;
      deployMarkers: Array<{ ts: number; buildId: string }>;
      wakeReasonAlert: { reason: string; share: number } | null;
      creditsSeries: Array<{ ts: number; credits: number }>;
    };
    expect(Array.isArray(body.planRateSeries)).toBe(true);
    expect(body.planRateSeries.reduce((s, b) => s + b.count, 0)).toBe(1); // the one plan event
    expect(body.deployMarkers).toEqual([{ ts: now, buildId: "v-test" }]);
    expect(body.creditsSeries).toEqual([{ ts: now, credits: 500 }]);
    expect(body.wakeReasonAlert).not.toBeNull();
    expect(body.wakeReasonAlert!.reason).toBe("low_fuel");
  });
});

// #158 failure taxonomy endpoint: the pure aggregation is unit-tested in
// test/failures.test.ts; these prove the ROUTE wiring -- above all that the
// events read is LIFETIME (a pre-window 5/5-blocked history must still flag a
// broken capability while contributing nothing to the window table).
describe("GET /api/agents/:id/failures", () => {
  test("window table vs lifetime broken-capability split comes through the wire", async () => {
    const { agent, store } = makeAgent();
    const now = Date.now();
    // 5 blocked buys, all OUTSIDE the 24h window (the 86/86 shape, compressed).
    for (let i = 0; i < 5; i++) {
      store.appendEvent({
        agentId: "miner", ts: now - (30 + i) * 60 * 60 * 1000, type: "action",
        payload: { action: "buy", params: {}, outcome: "blocked", result: "invalid_item: Unknown item 'fuel_cells'." },
      });
    }
    // One blocked sell INSIDE the window.
    store.appendEvent({
      agentId: "miner", ts: now - 60 * 1000, type: "action",
      payload: { action: "sell", params: {}, outcome: "blocked", result: "Sold 0 Gold Ore for 0cr, 33 unsold (no buyers)" },
    });
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });

    const body = (await (await fetch(`http://127.0.0.1:${server.port}/api/agents/miner/failures`)).json()) as {
      windowHours: number;
      classes: Array<{ class: string; count: number }>;
      newClasses: string[];
      brokenCapabilities: Array<{ action: string; failures: number; attempts: number; failureRate: number; topClass: string }>;
    };
    expect(body.windowHours).toBe(24);
    expect(body.classes).toHaveLength(1); // the old buy blocks are outside the window
    expect(body.classes[0]!.class).toBe("sell:no_buyers");
    expect(body.newClasses).toEqual(["sell:no_buyers"]); // first-ever occurrence is in-window
    expect(body.brokenCapabilities).toEqual([
      { action: "buy", attempts: 5, failures: 5, failureRate: 1, topClass: "invalid_item" },
    ]);
  });

  test("?hours validates against the same allowlist as /usage and falls back to 24", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const base = `http://127.0.0.1:${server.port}/api/agents/miner/failures`;
    expect(((await (await fetch(`${base}?hours=1`)).json()) as { windowHours: number }).windowHours).toBe(1);
    expect(((await (await fetch(`${base}?hours=999`)).json()) as { windowHours: number }).windowHours).toBe(24);
  });

  test("unknown agent returns 404", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    expect((await fetch(`http://127.0.0.1:${server.port}/api/agents/ghost/failures`)).status).toBe(404);
  });
});

// #173 second auth barrier: with authToken set, every route class must 401
// without the header and work with it; with authToken absent the server stays
// open (deploy-safe disabled mode main.ts warns about).
describe("dashboard auth barrier (#173)", () => {
  const TOKEN = "test-dashboard-token";
  const withToken = { [DASHBOARD_TOKEN_HEADER]: TOKEN };

  test("401 on every route class without the header: HTML, API read, instruct write, WS upgrade", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent], authToken: TOKEN });
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/api/agents`)).status).toBe(401);
    expect((await fetch(`${base}/api/agents/miner/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "do something" }),
    })).status).toBe(401);
    // WS upgrade path: the gate runs before srv.upgrade(), so a header-less
    // client is rejected at the HTTP layer and the socket never opens.
    const wsRejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      ws.onopen = () => resolve(false);
      ws.onerror = () => resolve(true);
      ws.onclose = () => resolve(true);
    });
    expect(wsRejected).toBe(true);
  });

  test("correct header passes: API 200, instruct 204, WS upgrade reaches the handler", async () => {
    const { agent, store } = makeAgent();
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent], authToken: TOKEN });
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/api/agents`, { headers: withToken })).status).toBe(200);
    expect((await fetch(`${base}/api/agents/miner/instruct`, {
      method: "POST", headers: { "content-type": "application/json", ...withToken },
      body: JSON.stringify({ text: "go dock" }),
    })).status).toBe(204);
    // A tokened plain GET to /ws clears the gate and reaches the upgrade
    // attempt, which fails as a non-WS request -> 400 ("upgrade failed"),
    // NOT 401. Distinguishes "gate passed" from "gate rejected" without
    // depending on client-side WS header support.
    expect((await fetch(`${base}/ws`, { headers: withToken })).status).toBe(400);
  });

  test("wrong token gets 401 -- including a length-mismatched one (compare must not throw)", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [], authToken: TOKEN });
    const base = `http://127.0.0.1:${server.port}`;
    // Same length as TOKEN: exercises a pure value mismatch.
    const sameLength = "x".repeat(TOKEN.length);
    expect((await fetch(`${base}/api/agents`, { headers: { [DASHBOARD_TOKEN_HEADER]: sameLength } })).status).toBe(401);
    // Different length: a naive raw timingSafeEqual THROWS on unequal-length
    // buffers, turning every probe into a 500 -- this pins the hash-first shape.
    expect((await fetch(`${base}/api/agents`, { headers: { [DASHBOARD_TOKEN_HEADER]: "short" } })).status).toBe(401);
  });

  test("no authToken -> routes stay open (deploy-safe disabled mode)", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    expect((await fetch(`http://127.0.0.1:${server.port}/api/agents`)).status).toBe(200);
  });
});

describe("loadDashboardToken (#173 startup behavior)", () => {
  test("knob absent -> disabled (undefined) with exactly one loud warning", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      expect(loadDashboardToken({})).toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("DISABLED");
  });

  test("configured-but-missing file refuses startup", () => {
    expect(() => loadDashboardToken({
      HARNESS_DASHBOARD_TOKEN_FILE: join(tmpdir(), "spacemolt-no-such-secret"),
    })).toThrow(/does not exist/);
  });

  test("empty file refuses startup; a real file yields the trimmed token", () => {
    const dir = mkdtempSync(join(tmpdir(), "spacemolt-token-"));
    try {
      const file = join(dir, "dashboard_token");
      writeFileSync(file, "   \n");
      expect(() => loadDashboardToken({ HARNESS_DASHBOARD_TOKEN_FILE: file })).toThrow(/empty/);
      writeFileSync(file, "sekrit\n"); // trailing newline is how `openssl rand > file` writes it
      expect(loadDashboardToken({ HARNESS_DASHBOARD_TOKEN_FILE: file })).toBe("sekrit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET / (dashboard SPA)", () => {
  test("serves the dashboard as self-contained HTML -- no external script/link tags", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("SpaceMolt");
    expect(body).toContain('id="agents"');
    // Dependency-minimalism receipt (Task 4): a CDN <script src> or external
    // <link href> here would be a silent new dependency this test exists to
    // catch before it ships.
    expect(body).not.toMatch(/<script[^>]+src=/i);
    expect(body).not.toMatch(/<link[^>]+href=["']https?:/i);
  });

  test("renders real ship vitals, not the old 'not exposed' note", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    const body = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    // The SHIP card + fuel/hull/cargo bars are wired to AgentSnapshot.status.
    expect(body).toContain('id="ship"');
    expect(body).toContain('bar("Fuel"');
    expect(body).toContain('bar("Hull"');
    expect(body).toContain('bar("Cargo"');
    expect(body).toContain("cargoManifest");
    // The honest placeholder the prior worker left must be gone now that the
    // data actually reaches the wire -- catches a stale-note regression.
    expect(body).not.toContain("are not exposed by /api/agents");
    // Every status value still routes through esc() before innerHTML.
    expect(body).toContain("esc(s.credits");
  });

  test("renders the ship-details block: identity, CPU/Power grid, module slots", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    const body = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    // Identity line + fitting-grid bars + slot rows are wired into the SHIP
    // card (operator request 2026-07-17: "ship class, weapons, etc").
    expect(body).toContain("shipIdentity(s)");
    expect(body).toContain('bar("CPU"');
    expect(body).toContain('bar("Power"');
    expect(body).toContain("slotRows(");
    // Module and identity strings come from the game -- they must route
    // through esc() before innerHTML like every other status value.
    expect(body).toContain("esc(m.name || m.typeId)");
    expect(body).toContain("esc(s.shipName)");
    expect(body).toContain("esc(s.shipClass)");
  });
});

// #114 A1 pivot: the strategy scheduler job used to reach the store over SSH
// under a forced-command key on the always-on host (rejected by the
// operator 2026-07-19 -- a root-equivalent credential on the host). These
// three routes replace that with authenticated HTTP, gated by their OWN
// bearer (storeToken/STORE_TOKEN_HEADER) -- independent of the dashboard's
// #173 authToken, since the consumer (the scheduler-host cron) has no dashboard token.
// A real sqlite FILE is required (not :memory:): the routes open their own
// short-lived Database handle per request against storeDbPath, exactly like
// the old CLI scripts did per-invocation, so a :memory: handle in the test
// (invisible to a second connection) would not exercise the real code path.
describe("store API routes (#114 A1)", () => {
  const TOKEN = "test-store-token";
  const withToken = { [STORE_TOKEN_HEADER]: TOKEN };

  function makeFileStore(): { store: Store; dbPath: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "spacemolt-store-route-"));
    const dbPath = join(dir, "harness.sqlite");
    const store = new Store(dbPath); // creates schema + WAL files on disk
    return { store, dbPath, dir };
  }

  function cleanup(store: Store, dir: string): void {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  test("401 on missing token for all three ops", async () => {
    const { store, dbPath, dir } = makeFileStore();
    try {
      server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [], storeToken: TOKEN, storeDbPath: dbPath });
      const base = `http://127.0.0.1:${server.port}/api/store/miner`;
      expect((await fetch(`${base}/dump`)).status).toBe(401);
      expect((await fetch(`${base}/gate`)).status).toBe(401);
      expect((await fetch(`${base}/mark`, { method: "POST" })).status).toBe(401);
    } finally {
      cleanup(store, dir);
    }
  });

  test("401 on a wrong token", async () => {
    const { store, dbPath, dir } = makeFileStore();
    try {
      server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [], storeToken: TOKEN, storeDbPath: dbPath });
      const res = await fetch(`http://127.0.0.1:${server.port}/api/store/miner/dump`, {
        headers: { [STORE_TOKEN_HEADER]: "wrong-token" },
      });
      expect(res.status).toBe(401);
    } finally {
      cleanup(store, dir);
    }
  });

  test("routes are independent of the dashboard's #173 token: dashboard token alone does not authorize store routes, and vice versa", async () => {
    const { store, dbPath, dir } = makeFileStore();
    try {
      server = startDashboardServer({
        host: "127.0.0.1", port: 0, store, agents: [],
        authToken: "dashboard-token", storeToken: TOKEN, storeDbPath: dbPath,
      });
      const base = `http://127.0.0.1:${server.port}`;
      // Dashboard token on a store route -> still 401 (wrong credential).
      expect((await fetch(`${base}/api/store/miner/dump`, { headers: { [DASHBOARD_TOKEN_HEADER]: "dashboard-token" } })).status).toBe(401);
      // Store token on a dashboard route -> still 401.
      expect((await fetch(`${base}/api/agents`, { headers: withToken })).status).toBe(401);
      // Each token authorizes only its own route class.
      expect((await fetch(`${base}/api/store/miner/dump`, { headers: withToken })).status).toBe(200);
      expect((await fetch(`${base}/api/agents`, { headers: { [DASHBOARD_TOKEN_HEADER]: "dashboard-token" } })).status).toBe(200);
    } finally {
      cleanup(store, dir);
    }
  });

  test("storeToken/storeDbPath unconfigured -> store routes 404 (deploy-safe disabled default)", async () => {
    const store = new Store(":memory:");
    server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [] });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/store/miner/dump`, { headers: withToken });
    expect(res.status).toBe(404);
  });

  test("agentId allowlist rejects an injection-shaped id even with a valid token", async () => {
    const { store, dbPath, dir } = makeFileStore();
    try {
      server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [], storeToken: TOKEN, storeDbPath: dbPath });
      // ';' and other shell/path metacharacters are outside the allowlist --
      // encodeURIComponent keeps them as one path SEGMENT (never a traversal
      // or extra route), and the server's own regex must still reject them.
      const res = await fetch(`http://127.0.0.1:${server.port}/api/store/${encodeURIComponent("miner;rm -rf /")}/dump`, {
        headers: withToken,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_agent_id");
    } finally {
      cleanup(store, dir);
    }
  });

  test("dump returns the review dataset and never mutates the store (gate's newPlans is unaffected by a dump call)", async () => {
    const { store, dbPath, dir } = makeFileStore();
    try {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        store.appendEvent({ agentId: "miner", ts: now - i * 1000, type: "plan_context", payload: {} });
      }
      server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [], storeToken: TOKEN, storeDbPath: dbPath });
      const base = `http://127.0.0.1:${server.port}/api/store/miner`;

      const dumpRes = await fetch(`${base}/dump`, { headers: withToken });
      expect(dumpRes.status).toBe(200);
      const dump = (await dumpRes.json()) as { agentId: string; windowHours: number; heartbeats: unknown[] };
      expect(dump.agentId).toBe("miner");
      expect(dump.windowHours).toBe(72); // REVIEW_WINDOW_HOURS default

      // Two dump calls in a row must not change the gate's plan count -- dump
      // opens a READONLY handle, so it structurally cannot write a marker.
      const gateBefore = (await (await fetch(`${base}/gate`, { headers: withToken })).json()) as { newPlans: number };
      await fetch(`${base}/dump`, { headers: withToken });
      const gateAfter = (await (await fetch(`${base}/gate`, { headers: withToken })).json()) as { newPlans: number };
      expect(gateAfter.newPlans).toBe(gateBefore.newPlans);
      expect(gateBefore.newPlans).toBe(3);
    } finally {
      cleanup(store, dir);
    }
  });

  test("mark writes exactly one cursor row and advances the gate's baseline", async () => {
    const { store, dbPath, dir } = makeFileStore();
    try {
      const now = Date.now();
      store.appendEvent({ agentId: "miner", ts: now, type: "plan_context", payload: {} });
      server = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [], storeToken: TOKEN, storeDbPath: dbPath });
      const base = `http://127.0.0.1:${server.port}/api/store/miner`;

      // mark is a writer -> must be POST; GET must not be routed to it.
      expect((await fetch(`${base}/mark`, { headers: withToken })).status).toBe(404);

      const markRes = await fetch(`${base}/mark`, { method: "POST", headers: withToken });
      expect(markRes.status).toBe(200);
      const marked = (await markRes.json()) as { marked: string; ts: number };
      expect(marked.marked).toBe("miner");

      const markerEvents = store.recentEventsByType("miner", "strategy_review", 10);
      expect(markerEvents.length).toBe(1); // exactly one cursor row written

      // A second mark call must add exactly one MORE row, not zero and not many.
      await fetch(`${base}/mark`, { method: "POST", headers: withToken });
      expect(store.recentEventsByType("miner", "strategy_review", 10).length).toBe(2);
    } finally {
      cleanup(store, dir);
    }
  });
});

describe("loadStoreToken (#114 A1 startup behavior, mirrors loadDashboardToken)", () => {
  test("knob absent -> disabled (undefined) with exactly one loud warning", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      expect(loadStoreToken({})).toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("DISABLED");
  });

  test("configured-but-missing file refuses startup; empty file refuses startup; a real file yields the trimmed token", () => {
    expect(() => loadStoreToken({
      HARNESS_STORE_TOKEN_FILE: join(tmpdir(), "spacemolt-no-such-store-secret"),
    })).toThrow(/does not exist/);

    const dir = mkdtempSync(join(tmpdir(), "spacemolt-store-token-"));
    try {
      const file = join(dir, "store_token");
      writeFileSync(file, "   \n");
      expect(() => loadStoreToken({ HARNESS_STORE_TOKEN_FILE: file })).toThrow(/empty/);
      writeFileSync(file, "sekrit\n");
      expect(loadStoreToken({ HARNESS_STORE_TOKEN_FILE: file })).toBe("sekrit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
