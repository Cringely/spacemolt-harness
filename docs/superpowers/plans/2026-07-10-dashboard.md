# SpaceMolt Harness Plan 3: Dashboard Implementation Plan

> **For agentic workers:** Execution follows `docs/wiki/team-structure.md`'s batch model. Batch H (Tasks 1-3): event/state REST + WS server, instruction endpoint, usage-metering endpoint — this is the observability surface the flight campaign (docs/STATE.md, SM-1..SM-5) named as required before another unattended flight. Batch I (Tasks 4-6): dashboard SPA, ops documentation, `main.ts` wiring + full offline e2e test. No council gate is scheduled for this plan in the spec's phasing; PM decides after Batch I's report whether one is warranted before Plan 4.

**Goal:** Give the three running agents a face. A `Bun.serve` server exposes each agent's live status, plan/goal/step, planner health (including the sticky `claudeDisabled`/`usingFallback`/backoff flags Plan 2 built and the campaign proved matter), its event feed over WebSocket, and a usage/wake-histogram instrument — plus a bounded instruction box to steer an agent without a restart. A single-file vanilla-TS dashboard (see Task 4's framework decision) renders all of it. Zero new persisted state: every endpoint derives from the `events` table Plan 1/2 already write.

**Architecture:** One new `src/server/` component, following the existing one-directory-per-concern layout (`registry/`, `client/`, `planner/`, `agent/`, `store/`, `config/`). `startDashboardServer(opts)` wraps `Bun.serve`: REST handlers read `Agent.snapshot()` (a new minimal read-only getter, Task 1) and `Store` queries (`recentEvents`, a new `eventsSince`, Task 3); the WS `/ws` endpoint rides Bun's built-in pub/sub, bridged to the store's existing `onEvent` broadcast hook (`src/store/store.ts:19`) so there is exactly one event-fanout mechanism in the codebase, not two. `POST /instruct` calls the existing `Agent.instruct()` (`src/agent/agent.ts:112`, unchanged) after a zod-validated, length-bounded body. The dashboard itself is one static HTML file (`src/server/dashboard.html`) served from the same process — see Task 4 for why this plan deviates from the spec's stated "React/Vite" and ships vanilla TS instead.

**Tech Stack:** unchanged — Bun ≥ 1.2.21, TypeScript, Zod as the only runtime dependency. This plan adds **zero** new npm dependencies (Task 4's framework decision is precisely about not adding any).

**Spec:** `docs/superpowers/specs/2026-07-10-spacemolt-harness-design.md` (see "dashboard", "server" components, "Plan 4 Constraints" for what is explicitly deferred to the next plan). **Security:** `docs/wiki/security-baseline.md` — the instruction box's length bound and the LAN-bind posture both come from named rules there. **Campaign ground truth:** `docs/STATE.md`'s "Next" section — the wake-reason histogram is "the persona-tuning instrument the campaign proved necessary," not a nice-to-have.

## Global Constraints

- Bun ≥ 1.2.21. Zod is still the only npm runtime dependency; this plan adds none.
- No live game or LLM calls anywhere in this plan's tests. Every test in Batches H and I runs against the existing in-process fake game server (`test/fake-server.ts`), a `MockPlanner`, and this plan's own `startDashboardServer` — all loopback, all offline, matching the exact pattern `test/integration.test.ts` already established.
- **Dashboard bind address is config-driven, defaulting to `127.0.0.1:8642`.** LAN-bind (setting `dashboard_host` to a LAN interface IP) is a deploy-time config change, not a code change — and it is explicitly a **development-only mode**: Plan 4's spec constraint (`docs/superpowers/specs/2026-07-10-spacemolt-harness-design.md`'s "Plan 4 Constraints") moves the dashboard behind a reverse proxy + SSO forwardAuth with no published host port. This plan does not build that; it builds the thing Plan 4 will put behind the proxy.
- **Instruction endpoint length bound.** `docs/wiki/security-baseline.md`: "The dashboard instruction box (Plan 3) gets a length bound — it's a prompt-injection channel into our own planner, contained but worth the guard." Enforced server-side by zod (`.max(500)`), because the server is the trust boundary — the SPA's `maxlength` attribute (Task 4) is UX only and trivially bypassed by anything that isn't the dashboard's own `<textarea>`.
- **`Agent.snapshot()` (Task 1) touches `src/agent/agent.ts`, the project's safety-path file** (per `docs/wiki/team-structure.md`'s PR-stage rule, the same file that got a dedicated PR-stage review in Plan 2's PR #6). Task 1 is flagged for PR-stage review regardless of how clean Batch H's per-task reviews come back — this is not optional even in an otherwise zero-finding batch.
- **Zero new persisted state.** The usage endpoint (Task 3) adds one new *read* query to `Store` (`eventsSince`) — no new table, no new column, no second writer. "Events are the single source of truth for observability" (spec, `store` component) stays true after this plan.
- Any test assertion encoding call order, tick counts, or timing carries its derivation as a comment citing the file+line of the code it depends on (same discipline as Plan 2).
- Every new constant/threshold carries a one-line justification in the code.
- Commit author is the user's identity only. No co-author trailers.

---

### Task 1: `Agent.snapshot()` + dashboard server skeleton (`GET /api/agents`, `GET /api/agents/:id/events`)

**PR-stage review required** (see Global Constraints): this task's diff touches `src/agent/agent.ts`.

**Files:**
- Modify: `src/agent/agent.ts` (add `AgentSnapshot`/`PlannerHealth` types + `snapshot()` method)
- Modify: `src/config/config.ts` (add `dashboard_host`/`dashboard_port` to the schema)
- Create: `src/server/server.ts`
- Test: `test/agent-snapshot.test.ts`
- Test: `test/server.test.ts`
- Test: append to `test/config.test.ts`

**Interfaces:**
- Consumes: `Store.recentEvents` (unchanged), `Agent.snapshot()` (new, this task)
- Produces:
  - `interface PlannerHealth { stalled: boolean; usingFallback: boolean; claudeDisabled: boolean; backoffUntil: number; consecutiveTransientFailures: number }`
  - `interface AgentSnapshot { id: string; planState: "none"|"running"|"done"|"blocked"; blockedReason?: string; goal?: string; stepIndex?: number; totalSteps?: number; goals: string[]; plannerHealth: PlannerHealth }`
  - `Agent.snapshot(): AgentSnapshot`
  - `function startDashboardServer(opts: { host: string; port: number; store: Store; agents: Agent[] }): { port: number; stop(): void }`

#### Step 1: Write the failing test for `Agent.snapshot()`

`test/agent-snapshot.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { TransientPlannerError } from "../src/planner/errors";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner } from "../src/planner/types";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 2, subscriptionCooldownMinutes: 60,
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

const alwaysThrows = (err: Error): Planner => ({ plan: async () => { throw err; } });

describe("Agent.snapshot", () => {
  test("reports none/no-plan state and zeroed planner health before any wake", () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    const snap = agent.snapshot();
    expect(snap.id).toBe("a1");
    expect(snap.planState).toBe("none");
    expect(snap.goal).toBeUndefined();
    expect(snap.plannerHealth).toEqual({
      stalled: false, usingFallback: false, claudeDisabled: false,
      backoffUntil: 0, consecutiveTransientFailures: 0,
    });
  });

  test("reports goal/step/total mid-plan", async () => {
    const store = new Store(":memory:");
    // repeat: 2 keeps the plan "running" (not plan_done) after exactly one
    // executeOne() tick, so the assertion below observes a stable mid-plan
    // cursor {step: 0, iteration: 1} instead of a state that flips to "done"
    // on the same tick (see src/agent/executor.ts's advance()).
    const plan: Plan = { goal: "mine a bit", steps: [
      { action: "mine", params: {}, repeat: 2 },
      { action: "dock", params: {} },
    ]};
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([plan]), config, now: () => 0,
    });
    await agent.runOnce(); // wake: no_plan -> replan (cursor {0,0}, no tick executed)
    await agent.runOnce(); // executeOne: mine iteration 1 of 2 (cursor {0,1}, step index unchanged)
    const snap = agent.snapshot();
    expect(snap.planState).toBe("running");
    expect(snap.goal).toBe("mine a bit");
    expect(snap.stepIndex).toBe(0);
    expect(snap.totalSteps).toBe(2);
  });

  test("surfaces the sticky planner-health flags (backoff, then stalled)", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("down")),
      config, now: () => now,
    });
    await agent.runOnce(); // no_plan wake -> replan -> transient failure #1
    let snap = agent.snapshot();
    expect(snap.plannerHealth.consecutiveTransientFailures).toBe(1);
    expect(snap.plannerHealth.backoffUntil).toBeGreaterThan(0);
    expect(snap.plannerHealth.stalled).toBe(false);

    // Clear the transient backoff (src/agent/agent.ts's
    // TRANSIENT_BACKOFF_BASE_MS, 30s base) so the next tick replans.
    // Note: the heartbeat check is NOT in play here -- planState stays
    // "none" after a failed replan, so evaluateWake returns no_plan
    // (wake.ts:32) before the heartbeatMs branch is ever reached.
    now += 15 * 60_000 + 1;
    await agent.runOnce(); // failure #2 -> reaches stallThreshold (2, configured above)
    snap = agent.snapshot();
    expect(snap.plannerHealth.stalled).toBe(true);
  });

  test("exposes only fields with a dashboard consumer -- no inbox, no internal thrash counters", () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: new MockPlanner([{ goal: "g", steps: [{ action: "undock", params: {} }] }]),
      config, now: () => 0,
    });
    const snap = agent.snapshot();
    expect(Object.keys(snap).sort()).toEqual(
      ["blockedReason", "goal", "goals", "id", "planState", "plannerHealth", "stepIndex", "totalSteps"].sort(),
    );
    expect(Object.keys(snap.plannerHealth).sort()).toEqual(
      ["backoffUntil", "claudeDisabled", "consecutiveTransientFailures", "stalled", "usingFallback"].sort(),
    );
  });
});
```

#### Step 2: Run test to verify it fails

Run: `bun test test/agent-snapshot.test.ts`
Expected: FAIL — `Agent.snapshot` is not a function.

#### Step 3: Implement `Agent.snapshot()`

In `src/agent/agent.ts`, add after the existing imports (before `export interface AgentConfig`):
```ts
export interface PlannerHealth {
  stalled: boolean;
  usingFallback: boolean;
  claudeDisabled: boolean;
  backoffUntil: number; // epoch ms; 0 means "not in backoff"
  consecutiveTransientFailures: number;
}

export interface AgentSnapshot {
  id: string;
  planState: "none" | "running" | "done" | "blocked";
  blockedReason?: string;
  goal?: string;
  stepIndex?: number;
  totalSteps?: number;
  goals: string[];
  plannerHealth: PlannerHealth;
}
```

Then, inside the `Agent` class, add this method directly after `instruct()`:
```ts
  /**
   * Read-only introspection surface for the dashboard server (Plan 3 Task 1).
   * Deliberately narrow: exposes only status/plan/goal/step and the planner
   * health the flight campaign named as required observability (docs/STATE.md
   * 2026-07-10: "sticky-flag observability + recovery") -- the
   * claudeDisabled/usingFallback/backoffUntil fields that let an operator see
   * WHY an agent stopped calling its primary planner, without restarting it
   * to find out. Never exposes api/store/planner instances, inbox contents,
   * or the F-3 thrash-damper's internal counters (consecutiveBlockedPlans,
   * lastBlockedDetail) -- those have no dashboard consumer today; add one
   * here only alongside a render consumer in Task 4, not on spec.
   */
  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      planState: this.planState,
      blockedReason: this.blockedReason,
      goal: this.plan?.goal,
      stepIndex: this.plan ? this.cursor.step : undefined,
      totalSteps: this.plan?.steps.length,
      goals: [...this.goals],
      plannerHealth: {
        stalled: this.stalled,
        usingFallback: this.usingFallback,
        claudeDisabled: this.claudeDisabled,
        backoffUntil: this.plannerBackoffUntil,
        consecutiveTransientFailures: this.consecutiveTransientFailures,
      },
    };
  }
```

#### Step 4: Run test to verify it passes

Run: `bun test test/agent-snapshot.test.ts`
Expected: PASS (4 tests).

#### Step 5: Config growth — `dashboard_host` / `dashboard_port`

Append to `test/config.test.ts`, inside the existing `describe("loadConfig", ...)` block (after the last test):
```ts
  test("defaults dashboard_host and dashboard_port", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml);
    const cfg = loadConfig(path);
    expect(cfg.dashboardHost).toBe("127.0.0.1"); // security-baseline: LAN bind is a deploy-time override, not a default
    expect(cfg.dashboardPort).toBe(8642);
  });

  test("overrides dashboard_host and dashboard_port", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml + "\ndashboard_host: 0.0.0.0\ndashboard_port: 9000\n");
    const cfg = loadConfig(path);
    expect(cfg.dashboardHost).toBe("0.0.0.0");
    expect(cfg.dashboardPort).toBe(9000);
  });
```

Run: `bun test test/config.test.ts` — expect FAIL (`dashboardHost`/`dashboardPort` don't exist yet).

In `src/config/config.ts`, add to `ConfigSchema` (after `ollama_url`):
```ts
  // Dev-mode default per security-baseline.md: 127.0.0.1 only. LAN exposure
  // is an explicit operator override in agents.yaml, never a code default --
  // Plan 4 replaces this bind entirely with a reverse proxy + SSO forwardAuth
  // and no published host port.
  dashboard_host: z.string().min(1).default("127.0.0.1"),
  dashboard_port: z.number().int().min(1).max(65535).default(8642),
```
Add to `HarnessConfig` interface:
```ts
  dashboardHost: string;
  dashboardPort: number;
```
Add to `loadConfig`'s return object (alongside `ollamaUrl`):
```ts
    dashboardHost: raw.dashboard_host,
    dashboardPort: raw.dashboard_port,
```

Run: `bun test test/config.test.ts` — expect PASS.

#### Step 6: Write the failing test for the server skeleton

`test/server.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { startDashboardServer, type DashboardServer } from "../src/server/server";
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
      backoffUntil: 0, consecutiveTransientFailures: 0,
    });
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
```

#### Step 7: Run test to verify it fails

Run: `bun test test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server/server`.

#### Step 8: Implement the server skeleton

`src/server/server.ts`:
```ts
import type { Store } from "../store/store";
import type { Agent } from "../agent/agent";

export interface DashboardServerOptions {
  host: string;
  port: number;
  store: Store;
  agents: Agent[];
}

export interface DashboardServer {
  port: number;
  stop(): void;
}

const EVENTS_TOPIC = "events";
// A hostile or buggy client requesting ?limit=1000000 would force a full
// table scan through Store.recentEvents' SQLite query; bounding it here is
// cheap and the dashboard (Task 4) never asks for more than a few hundred.
const DEFAULT_EVENTS_LIMIT = 50;
const MAX_EVENTS_LIMIT = 500;

function findAgent(agents: Agent[], id: string): Agent | undefined {
  return agents.find((a) => a.id === id);
}

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? DEFAULT_EVENTS_LIMIT);
  if (!Number.isFinite(n)) return DEFAULT_EVENTS_LIMIT;
  return Math.min(Math.max(1, Math.trunc(n)), MAX_EVENTS_LIMIT);
}

/**
 * Bun.serve wrapper: REST read endpoints over Agent.snapshot()/Store queries,
 * plus a WS broadcast of every event the store appends. Kept as one file
 * (route table + handlers) rather than a router abstraction -- 5 routes
 * total across this plan (Tasks 1-3) is well under the threshold where a
 * routing library or even a hand-rolled router earns its complexity.
 */
export function startDashboardServer(opts: DashboardServerOptions): DashboardServer {
  const { host, port, store, agents } = opts;

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return; // handoff to the websocket handler below -- Bun's fetch return type allows undefined here
        return new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        return Response.json(agents.map((a) => a.snapshot()));
      }

      const eventsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/events$/);
      if (eventsMatch && req.method === "GET") {
        const [, id] = eventsMatch as unknown as [string, string];
        if (!findAgent(agents, id)) return Response.json({ error: "agent_not_found" }, { status: 404 });
        const limit = clampLimit(url.searchParams.get("limit"));
        return Response.json(store.recentEvents(id, limit));
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe(EVENTS_TOPIC);
      },
      message() {
        // Read-only stream: the dashboard never sends anything meaningful
        // over the socket. Instructions go through POST /instruct (Task 2),
        // deliberately not WS, so the write path stays HTTP-request-shaped
        // (status codes, retries, no socket-lifecycle bookkeeping).
      },
    },
  });

  // Bridges the store's existing single-writer broadcast hook
  // (src/store/store.ts's onEvent, already used by main.ts for console
  // logging) into Bun's WS pub/sub -- one fanout mechanism, not two. Chains
  // rather than overwrites so main.ts's console-log hook (if set before this
  // call) keeps firing.
  const previousOnEvent = store.onEvent;
  store.onEvent = (e) => {
    previousOnEvent?.(e);
    server.publish(EVENTS_TOPIC, JSON.stringify(e));
  };

  return {
    port: server.port,
    stop() {
      store.onEvent = previousOnEvent;
      server.stop(true);
    },
  };
}
```

#### Step 9: Run test to verify it passes

Run: `bun test test/server.test.ts test/agent-snapshot.test.ts test/config.test.ts`
Expected: PASS.

#### Step 10: Typecheck

Run: `bun run typecheck`
Expected: clean.

#### Step 11: Commit

```bash
git add src/agent/agent.ts src/config/config.ts src/server/server.ts test/agent-snapshot.test.ts test/server.test.ts test/config.test.ts
git commit -m "Add Agent.snapshot() introspection surface and dashboard REST+WS server skeleton"
```

---

### Task 2: `POST /api/agents/:id/instruct`

**Files:**
- Modify: `src/server/server.ts`
- Test: append to `test/server.test.ts`

**Interfaces:**
- Consumes: `Agent.instruct(text: string)` (unchanged, `src/agent/agent.ts:112`)
- Produces: `POST /api/agents/:id/instruct` — `{ text: string }` body, 204 on success, 400 on invalid body, 404 on unknown agent.

#### Step 1: Write the failing test

Append to `test/server.test.ts`:
```ts
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
```

#### Step 2: Run test to verify it fails

Run: `bun test test/server.test.ts`
Expected: FAIL — no route matches `/instruct`, all six new tests get a 404/"not found" instead of the expected status.

#### Step 3: Implement

In `src/server/server.ts`, add the import and schema near the top:
```ts
import { z } from "zod";
```
```ts
// docs/wiki/security-baseline.md: "The dashboard instruction box gets a
// length bound -- it's a prompt-injection channel into our own planner,
// contained but worth the guard." 500 chars covers a real operator directive
// (a sentence or two) while bounding how much attacker-adjacent text can ride
// into Agent.replan()'s goals.push(instruction) -> digest.ts prompt splice
// per call. Enforced here, server-side -- the SPA's maxlength (Task 4) is UX
// only, not the trust boundary.
const INSTRUCTION_MAX_LENGTH = 500;
const InstructBodySchema = z.object({
  text: z.string().min(1).max(INSTRUCTION_MAX_LENGTH),
}).strict();
```

Add the route inside `fetch()`, after the `/events` block and before the final `return new Response("not found", ...)`:
```ts
      const instructMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/instruct$/);
      if (instructMatch && req.method === "POST") {
        const [, id] = instructMatch as unknown as [string, string];
        const agent = findAgent(agents, id);
        if (!agent) return Response.json({ error: "agent_not_found" }, { status: 404 });

        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }
        const parsed = InstructBodySchema.safeParse(raw);
        if (!parsed.success) {
          return Response.json({ error: "invalid_body", detail: parsed.error.message }, { status: 400 });
        }
        agent.instruct(parsed.data.text);
        return new Response(null, { status: 204 });
      }
```

#### Step 4: Run test to verify it passes

Run: `bun test test/server.test.ts`
Expected: PASS.

#### Step 5: Typecheck

Run: `bun run typecheck`
Expected: clean.

#### Step 6: Commit

```bash
git add src/server/server.ts test/server.test.ts
git commit -m "Add POST /instruct with a zod length bound per the security baseline"
```

---

### Task 3: Usage-metering endpoint (`GET /api/agents/:id/usage`)

**Files:**
- Modify: `src/store/store.ts` (add `eventsSince` — the one new read query, zero new persisted state)
- Create: `src/server/usage.ts`
- Modify: `src/server/server.ts` (wire the route)
- Test: append to `test/store.test.ts`
- Test: `test/usage.test.ts`
- Test: append to `test/server.test.ts`

**Interfaces:**
- Consumes: `Store.eventsSince(agentId, cutoffTs)` (new)
- Produces:
  - `interface UsageSummary { agentId: string; windowHours: number; replanAttempts: number; wakeReasonHistogram: Record<string, number>; tokensIn: number | null; tokensOut: number | null }`
  - `function summarizeUsage(agentId: string, events: Array<AgentEvent & { id: number }>): UsageSummary`
  - `GET /api/agents/:id/usage`

#### Step 1: Write the failing test for `Store.eventsSince`

Append to `test/store.test.ts`:
```ts
describe("Store.eventsSince", () => {
  test("returns only events at or after the cutoff, ascending by id, scoped to the agent", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 50, type: "wake", payload: {} });  // before cutoff -- excluded
    store.appendEvent({ agentId: "a1", ts: 100, type: "wake", payload: {} });
    store.appendEvent({ agentId: "a1", ts: 200, type: "wake", payload: {} });
    store.appendEvent({ agentId: "a2", ts: 250, type: "wake", payload: {} }); // different agent -- excluded

    const events = store.eventsSince("a1", 100);
    expect(events.map((e) => e.ts)).toEqual([100, 200]);
    expect(events.every((e) => e.agentId === "a1")).toBe(true);
  });

  test("returns an empty array when nothing is in range", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "wake", payload: {} });
    expect(store.eventsSince("a1", 1000)).toEqual([]);
  });
});
```

#### Step 2: Run test to verify it fails

Run: `bun test test/store.test.ts`
Expected: FAIL — `store.eventsSince` is not a function.

#### Step 3: Implement `Store.eventsSince`

In `src/store/store.ts`, add after `recentEvents`:
```ts
  /**
   * All events for one agent at or after `cutoffTs`, ascending. Distinct from
   * recentEvents (id-DESC, hard LIMIT, built for "show me the last N in the
   * feed UI"): usage aggregation (Plan 3 Task 3) needs every event inside a
   * time window, which can exceed any reasonable "recent" cap on a busy
   * agent. Zero new persisted state -- same events table, a second read
   * shape over it, exactly like recentEvents already is.
   */
  eventsSince(agentId: string, cutoffTs: number): Array<AgentEvent & { id: number }> {
    const rows = this.db
      .query("SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? AND ts >= ? ORDER BY id ASC")
      .all(agentId, cutoffTs) as Array<{ id: number; agent_id: string; ts: number; type: string; payload: string }>;
    return rows.map((r) => ({
      id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload),
    }));
  }
```

#### Step 4: Run test to verify it passes

Run: `bun test test/store.test.ts`
Expected: PASS.

#### Step 5: Write the failing test for `summarizeUsage`

`test/usage.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { summarizeUsage, USAGE_WINDOW_HOURS } from "../src/server/usage";
import type { AgentEvent } from "../src/store/store";

function ev(id: number, type: string, payload: unknown): AgentEvent & { id: number } {
  return { id, agentId: "a1", ts: id, type, payload };
}

describe("summarizeUsage", () => {
  test("counts wake events into replanAttempts and a wake-reason histogram", () => {
    const events = [
      ev(1, "wake", { reason: "heartbeat" }),
      ev(2, "wake", { reason: "low_fuel" }),
      ev(3, "wake", { reason: "heartbeat" }),
      ev(4, "action", { action: "mine" }), // not a wake -- must not appear in the histogram
    ];
    const summary = summarizeUsage("a1", events);
    expect(summary.agentId).toBe("a1");
    expect(summary.windowHours).toBe(USAGE_WINDOW_HOURS);
    expect(summary.replanAttempts).toBe(3);
    expect(summary.wakeReasonHistogram).toEqual({ heartbeat: 2, low_fuel: 1 });
  });

  test("falls back to 'unknown' for a wake payload missing reason (defensive -- not expected from evaluateWake)", () => {
    const summary = summarizeUsage("a1", [ev(1, "wake", {})]);
    expect(summary.wakeReasonHistogram).toEqual({ unknown: 1 });
  });

  test("tokens are null when no plan event carries a usage field (true today: no planner emits one)", () => {
    const summary = summarizeUsage("a1", [ev(1, "wake", { reason: "heartbeat" }), ev(2, "plan", { goal: "g" })]);
    expect(summary.tokensIn).toBeNull();
    expect(summary.tokensOut).toBeNull();
  });

  test("sums a usage field on plan events when present (forward-compatible -- no producer exists yet, see plan Deferred section)", () => {
    const summary = summarizeUsage("a1", [
      ev(1, "plan", { goal: "g", usage: { tokensIn: 100, tokensOut: 20 } }),
      ev(2, "plan", { goal: "g", usage: { tokensIn: 50, tokensOut: 10 } }),
    ]);
    expect(summary.tokensIn).toBe(150);
    expect(summary.tokensOut).toBe(30);
  });

  test("empty event list yields zeroed counts and null tokens", () => {
    const summary = summarizeUsage("a1", []);
    expect(summary.replanAttempts).toBe(0);
    expect(summary.wakeReasonHistogram).toEqual({});
    expect(summary.tokensIn).toBeNull();
    expect(summary.tokensOut).toBeNull();
  });
});
```

#### Step 6: Run test to verify it fails

Run: `bun test test/usage.test.ts`
Expected: FAIL — cannot resolve `../src/server/usage`.

#### Step 7: Implement `summarizeUsage`

`src/server/usage.ts`:
```ts
import type { AgentEvent } from "../store/store";

export interface UsageSummary {
  agentId: string;
  windowHours: number;
  // Counts "wake" events, NOT planner.plan() invocations -- see the doc
  // comment below for why an exact CLI-call count is deliberately not built.
  replanAttempts: number;
  wakeReasonHistogram: Record<string, number>;
  tokensIn: number | null;
  tokensOut: number | null;
}

// "Today" (per docs/STATE.md's wake-histogram requirement) is a rolling 24h
// window, not calendar-midnight -- nothing else in this project has a
// timezone concept (SQLite stores epoch ms throughout), and a rolling window
// needs no config. Returned on every response so a caller never has to guess
// what the window covers.
export const USAGE_WINDOW_HOURS = 24;

/**
 * Zero new persisted state (receipt: events are the store's single source of
 * truth per the spec's `store` component) -- every field here derives from
 * the existing events table via Store.eventsSince (Task 3, Step 3).
 *
 * replanAttempts counts "wake" events, not raw planner.plan() calls: every
 * Agent.replan() emits exactly one "wake" event as its first action
 * (src/agent/agent.ts:241), but a single replan() can issue up to 3
 * additional planner.plan() calls invisible to the event log today --
 * claude-subscription.ts's internal JSON-validation retry, plus agent.ts's
 * plan-id-normalization retry (src/agent/agent.ts's normalizePlanLocations
 * call site documents the compounding: "worst case 4 CLI invocations per
 * replan"). Counting the exact CLI-call total would need a new event emitted
 * from inside each retry branch in already-shipped, already-reviewed Plan 2
 * planner code -- out of scope for this plan (see the Deferred section) and
 * not free of risk to bolt on blind. Replans are rare by design (4-10/hr
 * target) and the F-3 thrash damper already bounds the sustained rate, so
 * this field is honestly named "replanAttempts" rather than "callsToday" --
 * it never claims a precision it doesn't have.
 *
 * tokensIn/tokensOut opportunistically read an optional `usage` field on
 * "plan" event payloads. No planner emits one today (ASSUMED, unverified --
 * unlike claude-subscription.ts's already-VERIFIED envelope fields
 * type/subtype/is_error/result): wiring real token capture now would mean
 * guessing a schema for data with no verification path, which is exactly
 * what this project's ASSUMED/VERIFIED discipline exists to prevent. This
 * function is written so the SERVER side needs zero changes the moment a
 * planner starts populating `usage` -- returns null (not 0) until then, so
 * the dashboard can render "not available" instead of a misleading zero.
 */
export function summarizeUsage(agentId: string, events: Array<AgentEvent & { id: number }>): UsageSummary {
  const wakeReasonHistogram: Record<string, number> = {};
  let replanAttempts = 0;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;

  for (const e of events) {
    if (e.type === "wake") {
      replanAttempts++;
      const reason = (e.payload as { reason?: string } | null)?.reason ?? "unknown";
      wakeReasonHistogram[reason] = (wakeReasonHistogram[reason] ?? 0) + 1;
    }
    if (e.type === "plan") {
      const usage = (e.payload as { usage?: { tokensIn?: number; tokensOut?: number } } | null)?.usage;
      if (usage) {
        tokensIn = (tokensIn ?? 0) + (usage.tokensIn ?? 0);
        tokensOut = (tokensOut ?? 0) + (usage.tokensOut ?? 0);
      }
    }
  }

  return { agentId, windowHours: USAGE_WINDOW_HOURS, replanAttempts, wakeReasonHistogram, tokensIn, tokensOut };
}
```

#### Step 8: Run test to verify it passes

Run: `bun test test/usage.test.ts`
Expected: PASS.

#### Step 9: Write the failing test for the wired endpoint

Append to `test/server.test.ts`:
```ts
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
});
```

#### Step 10: Run test to verify it fails

Run: `bun test test/server.test.ts`
Expected: FAIL — no route matches `/usage`.

#### Step 11: Wire the route

In `src/server/server.ts`, add the import:
```ts
import { summarizeUsage, USAGE_WINDOW_HOURS } from "./usage";
```
Add the route inside `fetch()`, after the `/instruct` block:
```ts
      const usageMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/usage$/);
      if (usageMatch && req.method === "GET") {
        const [, id] = usageMatch as unknown as [string, string];
        if (!findAgent(agents, id)) return Response.json({ error: "agent_not_found" }, { status: 404 });
        const cutoff = Date.now() - USAGE_WINDOW_HOURS * 60 * 60 * 1000;
        return Response.json(summarizeUsage(id, store.eventsSince(id, cutoff)));
      }
```

#### Step 12: Run test to verify it passes

Run: `bun test test/server.test.ts`
Expected: PASS.

#### Step 13: Full suite + typecheck

Run: `bun test && bun run typecheck`
Expected: all green, clean.

#### Step 14: Commit

```bash
git add src/store/store.ts src/server/usage.ts src/server/server.ts test/store.test.ts test/usage.test.ts test/server.test.ts
git commit -m "Add usage-metering endpoint: wake histogram and replan counts derived from events, zero new state"
```

---

### Task 4: Dashboard SPA

**Framework decision (deviation from spec, receipt below):** vanilla TypeScript in one static HTML file served by the existing `Bun.serve` instance — **not** React/Vite as the spec originally stated.

**Receipt:** The spec's "React/Vite" line predates the flight campaign, written before the actual UI surface was known. That surface, now that Tasks 1-3 exist, is: 4 read-mostly panels per agent (status, wake histogram, planner health, usage) plus one event feed and one text input — no routing, no client-side state management, no component reuse benefit at n=3 agents. This repo's binding dependency posture (`docs/wiki/security-baseline.md`: "The strongest control is the one we started with: a three-package graph... every dependency not installed is an attack that can't happen") treats every new dependency as a decision needing a receipt. React + Vite would add a bundler, a `node_modules` subtree, and a build step to render four `<div>`s that update on a WebSocket message — complexity with no consumer benefit. A single static HTML file using `fetch`/`WebSocket`/DOM APIs already in every browser is strictly smaller and equally correct for this scope. **Noted for the record as a deliberate spec deviation; PM/user can override before Batch I merges if the growth case (v2 controls) is judged to start sooner than expected.**

**Files:**
- Create: `src/server/dashboard.html`
- Modify: `src/server/server.ts` (serve it at `GET /`)
- Test: append to `test/server.test.ts`

#### Step 1: Write the failing test

Append to `test/server.test.ts`:
```ts
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
});
```

#### Step 2: Run test to verify it fails

Run: `bun test test/server.test.ts`
Expected: FAIL — `GET /` returns 404 (no matching route yet).

#### Step 3: Write the dashboard file

`src/server/dashboard.html`:
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>SpaceMolt Harness Dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 1.5rem; }
  h1 { font-size: 1.1rem; color: #58a6ff; margin: 0 0 1rem; }
  #agents { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 1rem; }
  .panel { border: 1px solid #30363d; border-radius: 8px; padding: 1rem; background: #161b22; }
  .panel h2 { margin: 0 0 0.5rem; font-size: 1rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .badge { padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.75rem; background: #21262d; }
  .badge.on { background: #7d2d2d; color: #ffb3b3; }
  .badge.ok { background: #1f4d2b; color: #9be3ab; }
  .feed { max-height: 220px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 0.75rem;
          background: #0d1117; border: 1px solid #21262d; border-radius: 4px; padding: 0.5rem; }
  .feed div { padding: 0.1rem 0; border-bottom: 1px dotted #21262d; }
  .instruct { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .instruct textarea { flex: 1; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; }
  .instruct button { background: #238636; color: white; border: none; border-radius: 4px; padding: 0 0.75rem; cursor: pointer; }
  .err { color: #ff7b72; font-size: 0.75rem; min-height: 1em; }
  #ws-status { font-size: 0.75rem; color: #8b949e; }
</style>
</head>
<body>
<h1>SpaceMolt Harness Dashboard <span id="ws-status">ws: connecting...</span></h1>
<div id="agents"></div>
<script>
(function () {
  "use strict";

  // Snapshot poll interval: the WS stream only carries individual events, not
  // full agent snapshots (plan/goal/step, planner health) -- a slow poll
  // fills that gap. 5s is fast enough for a human watching the dashboard and
  // well below the 10s game tick, so it never visibly lags the loop.
  const SNAPSHOT_POLL_MS = 5000;
  // Fixed-interval WS reconnect, not exponential backoff: this socket only
  // ever talks to the harness's own embedded server on the same host/LAN --
  // if it's down, the harness process itself is down. There's no remote
  // flaky-network case here to justify backoff complexity.
  const WS_RECONNECT_MS = 3000;
  const EVENTS_SEED_LIMIT = 50;

  const agentsEl = document.getElementById("agents");
  const wsStatusEl = document.getElementById("ws-status");
  const panels = new Map(); // agentId -> { feedEl, statusEl, healthEl, usageEl }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = "";
      try { detail = JSON.stringify(await res.json()); } catch { /* no body */ }
      throw new Error(res.status + " " + detail);
    }
    return res.status === 204 ? null : res.json();
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function badge(text, cls) {
    return '<span class="badge ' + (cls || "") + '">' + esc(text) + "</span>";
  }

  function renderHistogram(hist) {
    const entries = Object.entries(hist || {}).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return badge("no wakes yet");
    return entries.map(([reason, count]) => badge(reason + ": " + count)).join(" ");
  }

  function renderHealth(h) {
    if (!h) return "";
    return [
      badge("stalled", h.stalled ? "on" : "ok"),
      badge("fallback", h.usingFallback ? "on" : "ok"),
      badge("claude-disabled", h.claudeDisabled ? "on" : "ok"),
      h.backoffUntil > Date.now()
        ? badge("backoff until " + new Date(h.backoffUntil).toLocaleTimeString(), "on")
        : badge("no backoff", "ok"),
    ].join(" ");
  }

  function eventLine(e) {
    const t = new Date(e.ts).toLocaleTimeString();
    return "<div>[" + esc(t) + "] " + esc(e.type) + " " + esc(JSON.stringify(e.payload)) + "</div>";
  }

  function buildPanel(agentId) {
    const el = document.createElement("div");
    el.className = "panel";
    el.innerHTML =
      "<h2>" + esc(agentId) + "</h2>" +
      '<div class="row" data-role="status"></div>' +
      '<div class="row" data-role="health"></div>' +
      '<div class="row" data-role="usage"></div>' +
      '<div class="feed" data-role="feed"></div>' +
      '<div class="instruct">' +
        '<textarea data-role="instruct-text" maxlength="500" rows="2" placeholder="Instruction (max 500 chars)"></textarea>' +
        '<button data-role="instruct-send" type="button">Send</button>' +
      "</div>" +
      '<div class="err" data-role="instruct-err"></div>';
    agentsEl.appendChild(el);

    const panel = {
      feedEl: el.querySelector('[data-role="feed"]'),
      statusEl: el.querySelector('[data-role="status"]'),
      healthEl: el.querySelector('[data-role="health"]'),
      usageEl: el.querySelector('[data-role="usage"]'),
    };
    const textEl = el.querySelector('[data-role="instruct-text"]');
    const errEl = el.querySelector('[data-role="instruct-err"]');
    const sendBtn = el.querySelector('[data-role="instruct-send"]');

    sendBtn.addEventListener("click", async () => {
      errEl.textContent = "";
      const text = textEl.value.trim();
      if (!text) return;
      try {
        await fetchJson("/api/agents/" + encodeURIComponent(agentId) + "/instruct", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        textEl.value = "";
      } catch (e) {
        errEl.textContent = "failed to send: " + e.message;
      }
    });

    return panel;
  }

  function updateSnapshot(panel, agent) {
    panel.statusEl.innerHTML =
      badge("state: " + agent.planState) +
      (agent.goal ? badge("goal: " + agent.goal) : "") +
      (agent.totalSteps ? badge("step " + ((agent.stepIndex ?? 0) + 1) + "/" + agent.totalSteps) : "") +
      (agent.blockedReason ? badge("blocked: " + agent.blockedReason, "on") : "");
    panel.healthEl.innerHTML = renderHealth(agent.plannerHealth);
  }

  async function seedEvents(agentId, panel) {
    try {
      const events = await fetchJson("/api/agents/" + encodeURIComponent(agentId) + "/events?limit=" + EVENTS_SEED_LIMIT);
      panel.feedEl.innerHTML = events.map(eventLine).join("");
      panel.feedEl.scrollTop = panel.feedEl.scrollHeight;
    } catch {
      // Best-effort history seed; the live WS feed still works without it.
    }
  }

  async function seedUsage(agentId, panel) {
    try {
      const usage = await fetchJson("/api/agents/" + encodeURIComponent(agentId) + "/usage");
      panel.usageEl.innerHTML =
        badge("replans/" + usage.windowHours + "h: " + usage.replanAttempts) +
        " " + renderHistogram(usage.wakeReasonHistogram) +
        (usage.tokensIn != null ? " " + badge("tokens in/out: " + usage.tokensIn + "/" + usage.tokensOut) : "");
    } catch {
      // Best-effort; usage panel stays at its last known value until the next poll.
    }
  }

  async function refreshSnapshots() {
    let agents;
    try {
      agents = await fetchJson("/api/agents");
    } catch {
      return; // transient fetch failure -- the next poll tries again
    }
    for (const agent of agents) {
      let panel = panels.get(agent.id);
      if (!panel) {
        panel = buildPanel(agent.id);
        panels.set(agent.id, panel);
        seedEvents(agent.id, panel);
        seedUsage(agent.id, panel);
      }
      updateSnapshot(panel, agent);
    }
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(proto + "//" + location.host + "/ws");
    ws.onopen = () => { wsStatusEl.textContent = "ws: connected"; };
    ws.onclose = () => {
      wsStatusEl.textContent = "ws: disconnected, retrying...";
      setTimeout(connectWs, WS_RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let e;
      try { e = JSON.parse(ev.data); } catch { return; }
      const panel = panels.get(e.agentId);
      if (!panel) return; // event for an agent whose snapshot hasn't loaded yet -- next poll picks it up
      panel.feedEl.insertAdjacentHTML("beforeend", eventLine(e));
      panel.feedEl.scrollTop = panel.feedEl.scrollHeight;
      if (e.type === "wake") seedUsage(e.agentId, panel); // histogram/replan count just changed
    };
  }

  refreshSnapshots();
  setInterval(refreshSnapshots, SNAPSHOT_POLL_MS);
  connectWs();
})();
</script>
</body>
</html>
```

#### Step 4: Serve it from the server

In `src/server/server.ts`, add near the top (module scope, outside `startDashboardServer`):
```ts
const DASHBOARD_HTML = new URL("./dashboard.html", import.meta.url);
```
Add the route inside `fetch()`, as the **first** check (before the `/ws` upgrade check, since `/` never collides with it):
```ts
      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        return new Response(Bun.file(DASHBOARD_HTML), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
```

#### Step 5: Run test to verify it passes

Run: `bun test test/server.test.ts`
Expected: PASS.

#### Step 6: Manual verification (this task's real test)

Static analysis (Step 1's test) proves the file is self-contained; it cannot prove the rendered UI looks or behaves correctly — that needs a browser. Adding a DOM-testing dependency (jsdom or similar) purely to unit-test ~150 lines of vanilla DOM manipulation would violate this same task's own dependency-minimalism receipt. Instead: run `bun run src/main.ts` against a local `agents.yaml`, open the dashboard URL, and confirm each panel renders, the instruction box posts successfully, and the WS reconnect banner recovers after killing/restarting the process. This manual check is written up as the first item in Task 5's ops doc ("reading the panels") so it's repeatable, not tribal knowledge.

#### Step 7: Typecheck

Run: `bun run typecheck`
Expected: clean (the `.html` file has no TypeScript in it to check; `tsconfig.json`'s `include` only covers `src`/`test` and Bun's bundler-mode resolution doesn't pull in HTML as a module here since nothing imports it).

#### Step 8: Commit

```bash
git add src/server/dashboard.html src/server/server.ts test/server.test.ts
git commit -m "Add single-file vanilla-TS dashboard SPA served from the embedded server"
```

---

### Task 5: Operations documentation

**Files:**
- Create: `docs/wiki/operations.md`
- Modify: `README.md` (add a Quickstart section, update the Progress checklist)

No code changes, no tests — per `docs/wiki/team-structure.md`'s PR-stage rule, docs PRs merge on PM judgment. Both documents use the educational register per `AGENTS.md` (teach as you inform; define terms; explain why, not just what).

#### Step 1: Write `docs/wiki/operations.md`

Content requirements (write in full prose, educational register, following the existing wiki pages' style):

- **Starting the harness.** `bun run start` (equivalently `bun run src/main.ts`); reads `agents.yaml` (path overridable via `HARNESS_CONFIG` env var) and `secrets/` (overridable via `HARNESS_SECRETS`). Explain first-run registration (idempotent, needs `secrets/registration_code`).
- **Stopping the harness.** `Ctrl-C` (SIGINT): stops every agent's timer, stops the dashboard server, closes the SQLite handle cleanly. No data loss — the plan cursor persists on every step transition, not just on clean shutdown.
- **Dashboard URL.** `http://<dashboard_host>:<dashboard_port>` — defaults `http://127.0.0.1:8642`, configurable in `agents.yaml`. Explain the LAN-bind dev mode (setting `dashboard_host` to a LAN interface IP) and flag it as a **development-only** posture: no auth in front of it in Plan 3, and Plan 4 replaces this entirely with a reverse-proxy + SSO forwardAuth path with no published host port. Link to `docs/wiki/security-baseline.md`.
- **Reading the panels.** Walk through what each part of a panel means: plan state (`none`/`running`/`done`/`blocked`) and what each means operationally; goal/step-of-total; the planner-health badges (`stalled`, `fallback`, `claude-disabled`, backoff) and what an operator should do when each lights up (e.g. `claude-disabled` on means the token is bad — check `secrets/claude_oauth_token`; `stalled` on means transient failures maxed out — check network/Ollama reachability; `fallback` on means the subscription window closed and the agent switched to its configured fallback planner); the wake-reason histogram and how to read it (per the spec's "Operating Routine": too many `heartbeat` wakes means plans are too short, too many `blocked` wakes means the planner is overestimating); the usage numbers and their caveat (this endpoint reports `replanAttempts`, an undercount of raw LLM calls when retries fire — explain why, briefly, referencing the plan); the live event feed.
- **The instruction box.** What it does (aborts the current plan, wakes the agent, the instruction becomes a persistent goal-list entry — one-shot input, persistent effect, per the spec's "Operator instruction lifecycle"). The 500-character bound and why (prompt-injection containment, not an arbitrary UX limit). It reaches the SAME planner prompt the agent already uses — it is not a chat window.
- **Logs.** `main.ts` currently logs every event to stdout as it's appended (one line per event, JSON payload) — this is currently the only log sink; redirect to a file with normal shell redirection (`bun run start > harness.log 2>&1`) if persistence across terminal sessions matters. Point out this is a real limitation worth flagging honestly (no log rotation, no structured log aggregation) rather than glossing over it.
- **Common ops.** Restarting a single agent isn't possible in v1 (whole-process restart only — the spec's stated non-goal, "pause/resume... from the dashboard"); explain what DOES survive a restart (plan cursor, goals) and what doesn't (in-flight backoff/stall state resets, which is fine — it's meant to reset on a supervised restart). When to intervene via the instruction box vs. just watching. What "stalled" (red) means and the decision it calls for (check the underlying planner's health before re-instructing — an instruction won't fix a broken token or an unreachable Ollama server).

#### Step 2: Write the README Quickstart section

Add a `## Quickstart` section to `README.md`, positioned after "How the repo is organized" and before "Progress". Cover: prerequisites (Bun ≥ 1.2.21, a `secrets/registration_code` from the SpaceMolt dashboard, an `agents.yaml` — point to `docs/wiki/spacemolt-api.md` and the config schema in `src/config/config.ts` for the shape), `bun install`, `bun run start`, the dashboard URL, and a one-line pointer to `docs/wiki/operations.md` for anything beyond "it's running."

Update the Progress checklist: change `- [ ] Plan 3: web dashboard...` to `- [x] Plan 3 authored: ...` (only mark it done once Task 6 actually merges — if this plan document is being committed before implementation, leave the checkbox as `[ ]` with a note "plan authored, batches H/I pending").

#### Step 3: Commit

```bash
git add docs/wiki/operations.md README.md
git commit -m "Add operations doc and README quickstart for the dashboard"
```

---

### Task 6: `main.ts` wiring + full offline e2e test

**Files:**
- Modify: `src/main.ts`
- Test: `test/e2e-dashboard.test.ts`

**Interfaces:**
- Consumes: `startDashboardServer` (Task 1), `config.dashboardHost`/`config.dashboardPort` (Task 1)

#### Step 1: Write the failing e2e test

`test/e2e-dashboard.test.ts` (mirrors `test/integration.test.ts`'s existing "real client against fake game server" pattern, adding the dashboard server layer on top and driving it over real HTTP + WS — the same offline-by-construction shape, one layer higher):
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { SpacemoltClient } from "../src/client/client";
import { SpacemoltHttp } from "../src/client/http";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { startDashboardServer, type DashboardServer } from "../src/server/server";
import type { Plan } from "../src/registry/plan";
import { startFakeServer, type FakeServer } from "./fake-server";

let fake: FakeServer;
let dashboard: DashboardServer;
afterEach(() => { fake?.stop(); dashboard?.stop(); });

describe("e2e: dashboard server wired to a real agent against a fake game server", () => {
  test("REST snapshot, instruct roundtrip, usage histogram, and the WS feed all agree with the same agent", async () => {
    fake = startFakeServer();
    fake.setHandler("spacemolt_auth", "register", () => ({ structuredContent: { password: "e2e-pw" } }));
    fake.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 90, max_fuel: 100, hull: 100, max_hull: 100, cargo_used: 0, cargo_capacity: 50 },
        player: { credits: 0 },
        location: { docked_at: null, in_transit: false },
      },
    }));

    const http = new SpacemoltHttp(fake.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const { password } = await client.register("E2E Pilot", "nebula", "REG");
    await client.login("E2E Pilot", password);

    // repeat: 5 keeps this plan "running" indefinitely -- it exists only to
    // be aborted by the operator instruction below, never to complete on its
    // own, so no tick-count assumption about mining/cargo math is needed.
    const minePlan: Plan = { goal: "mine", steps: [{ action: "mine", params: {}, repeat: 5 }] };
    const obeyPlan: Plan = { goal: "obey operator", steps: [{ action: "dock", params: {} }] };
    const planner = new MockPlanner([minePlan, obeyPlan]);
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "e2e", persona: "e2e test pilot", api: client, store, planner,
      config: {
        fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
        stallThreshold: 5, subscriptionCooldownMinutes: 60,
      },
      now: () => 1_000_000, // fixed clock: heartbeat (delta from lastPlanAt) never fires, keeping the wake histogram exactly {no_plan, instruction}
    });

    dashboard = startDashboardServer({ host: "127.0.0.1", port: 0, store, agents: [agent] });
    const base = `http://127.0.0.1:${dashboard.port}`;

    // Connect the WS before anything happens so it observes every broadcast.
    const wsEvents: Array<{ type: string }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${dashboard.port}/ws`);
    await new Promise((resolve) => { ws.onopen = resolve; });
    ws.onmessage = (ev) => wsEvents.push(JSON.parse(ev.data as string));

    await agent.runOnce(); // wake: no_plan -> replan -> minePlan established (src/agent/wake.ts:32)

    // REST snapshot agrees with the agent's own introspection surface at this instant.
    const snaps = (await (await fetch(`${base}/api/agents`)).json()) as unknown[];
    expect(snaps).toEqual([agent.snapshot()]);

    // Instruct roundtrip: queues on the SAME Agent instance the server holds a reference to.
    const instructRes = await fetch(`${base}/api/agents/e2e/instruct`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "go dock and wait" }),
    });
    expect(instructRes.status).toBe(204);

    // evaluateWake checks a queued instruction FIRST, ahead of planState
    // (src/agent/wake.ts:30) -- this replan is driven by the instruction,
    // not by the (still-running) mine plan reaching completion.
    await agent.runOnce(); // instruction wake -> replan -> obeyPlan established, goals=["go dock and wait"]
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts[1]!.instruction).toBe("go dock and wait");

    await agent.runOnce(); // executes the single-step obeyPlan's "dock" -> plan_done (internal state only, no new wake event this tick)

    // Usage histogram reflects exactly the two replans above: no_plan, instruction.
    const usage = (await (await fetch(`${base}/api/agents/e2e/usage`)).json()) as {
      replanAttempts: number; wakeReasonHistogram: Record<string, number>;
    };
    expect(usage.replanAttempts).toBe(2);
    expect(usage.wakeReasonHistogram).toEqual({ no_plan: 1, instruction: 1 });

    // Let the WS event loop flush queued publishes before asserting on them.
    await new Promise((r) => setTimeout(r, 50));
    const types = wsEvents.map((e) => e.type);
    expect(types).toContain("wake");
    expect(types).toContain("plan");
    expect(types).toContain("action"); // emitted by the dock tick's executeOne() (src/agent/agent.ts:427)
  });
});
```

#### Step 2: Run test to verify it fails

Run: `bun test test/e2e-dashboard.test.ts`
Expected: FAIL — passes today actually only if Tasks 1-4 are already merged; run this on top of a clean checkout of just this task's starting point (i.e. before `main.ts` is touched) to confirm it's a valid new test, not a false negative from a stale import. If Tasks 1-4 are already committed (as they are by this point in the batch), this test should already PASS before Step 3 — its purpose here is to validate the full chain end-to-end, not to drive new server/agent code. Confirm this now: `bun test test/e2e-dashboard.test.ts` should PASS already. If it doesn't, that's a real integration defect between Tasks 1-4 to fix before touching `main.ts`.

#### Step 3: Wire `main.ts`

In `src/main.ts`, add the import:
```ts
import { startDashboardServer } from "./server/server";
```
After the `for (const entry of config.agents) { ... }` loop and before the `process.on("SIGINT", ...)` block, add:
```ts
const dashboard = startDashboardServer({
  host: config.dashboardHost, port: config.dashboardPort, store, agents,
});
console.log(`dashboard listening on http://${config.dashboardHost}:${dashboard.port}`);
```
Update the SIGINT handler to also stop the dashboard:
```ts
process.on("SIGINT", () => {
  console.log("stopping agents...");
  for (const a of agents) a.stop();
  dashboard.stop();
  store.close();
  process.exit(0);
});
```

#### Step 4: Run the full suite

Run: `bun test && bun run typecheck`
Expected: all green (this plan's new tests plus every existing test from Plans 1-2), typecheck clean. `main.ts` itself has no test (it never did — it's a top-level script with real side effects at import time: reads `agents.yaml` off disk, touches `process.env`). `test/e2e-dashboard.test.ts` is the substitute: it hand-assembles the exact same wiring `main.ts` performs (`Store` → `Agent` → `startDashboardServer`) and exercises it for real over HTTP/WS, which is the actually-testable version of "does the wiring work."

#### Step 5: Commit

```bash
git add src/main.ts test/e2e-dashboard.test.ts
git commit -m "Wire the dashboard server into main.ts; add full offline e2e coverage"
```

---

## Deferred (explicitly out of scope)

- **Real token/cost capture from the Claude CLI envelope.** `summarizeUsage` (Task 3) is written to consume an optional `usage` field on "plan" events, but no planner populates one yet — the CLI's actual JSON output for token/cost fields is unverified (unlike the already-VERIFIED envelope fields `claude-subscription.ts` already parses: `type`/`subtype`/`is_error`/`result`). Wiring capture now means guessing a schema for data with no consumer verification path. Revisit once a live flight captures the real envelope shape (same discipline Plan 2 used for `find_route` and the token-invalid classification).
- **Exact replan/CLI-call counting.** `replanAttempts` counts "wake" events (one per `Agent.replan()` call), which undercounts the true CLI-invocation total whenever a planner's internal retry or the id-normalization retry fires (documented compounding: up to 4 CLI calls per replan). An exact count would need a new event emitted from inside Plan 2's already-shipped, already-reviewed retry branches — judged out of scope for a dashboard plan to reopen planner internals; the field is named honestly (`replanAttempts`, not `callsToday`) so it never overclaims.
- **Per-agent restart/pause/resume from the dashboard.** Explicit spec non-goal ("v1"): "Pause/resume, persona editing, or kill switches from the dashboard (instruction injection only)." Unchanged by this plan.
- **Authentication on the dashboard.** Explicit spec non-goal for v1 (LAN-only, existing network controls); Plan 4 adds a reverse proxy + SSO forwardAuth.
- **A build step / component framework for the SPA** (Task 4's core decision) — rejected in favor of one static HTML file; revisit if/when v2 dashboard controls (pause/resume, persona editing) grow the UI surface enough that plain DOM manipulation stops being the smaller option.
- **DOM/browser-level automated testing of the SPA.** No `jsdom`-class dependency added (would contradict Task 4's own dependency-minimalism receipt); verification is the manual check documented in Task 4 Step 6 and the ops doc.

## Load-bearing unknowns carried forward (none new to this plan)

This plan introduces no new ASSUMED, unverified external shapes — Tasks 1-6 are entirely internal (agent introspection, SQLite queries, an embedded HTTP/WS server, static file serving). The unknowns already on record from Plan 2 (`find_route`'s shape — VERIFIED since; Claude CLI failure-text patterns; Ollama's JSON-Schema subset; the 60-minute subscription cooldown default) are unchanged and still tracked in `docs/superpowers/plans/2026-07-10-real-planners.md`'s equivalent section and `docs/STATE.md`.
