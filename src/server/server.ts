import { existsSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";
import type { Store } from "../store/store";
import type { Agent } from "../agent/agent";
import { z } from "zod";
import {
  summarizeUsage, creditsSeries, planRateSeries, deployMarkers, wakeReasonAlert,
  USAGE_WINDOW_HOURS, USAGE_WINDOW_OPTIONS,
} from "./usage";
import { failureTaxonomy } from "./failures";
import { missionSummary } from "./missions";
import { evaluateReviewGate, markReviewRan } from "../review/review-gate";
import { readDump, REVIEW_WINDOW_HOURS } from "../../scripts/strategy-review-dump";

export interface DashboardServerOptions {
  host: string;
  port: number;
  store: Store;
  agents: Agent[];
  // #173 second auth barrier: when set, EVERY route (HTML, API, WS upgrade)
  // requires the DASHBOARD_TOKEN_HEADER to equal this value. Absent = check
  // disabled (dev / tests / not-yet-provisioned deploys).
  authToken?: string;
  // #114 A1 pivot: the scheduler's strategy-review job used to reach the store
  // over SSH + a forced-command key on the store host (a root-equivalent
  // key on that host, rejected by the operator 2026-07-19). These two
  // options together turn on the /api/store/* routes below -- three fixed ops
  // (dump/gate/mark) gated by their OWN bearer token, independent of
  // authToken above (different consumer: a scheduler cron, not a browser
  // through the reverse proxy). Either absent -> the routes 404 (deploy-safe
  // disabled mode, same posture as authToken).
  storeToken?: string;
  storeDbPath?: string;
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

// #173 defense-in-depth: today the only barrier in front of this server is
// the reverse proxy's network isolation + SSO forwardAuth, both living
// OUTSIDE this repo. A proxy misconfig or a leaked container port would hand
// any caller unauthenticated access to every route -- including POST
// /instruct, an open write path into the planner prompt. The second barrier
// is a shared secret: the reverse proxy injects this header at the proxy
// (a custom-request-header middleware), so the browser flow through SSO is
// unchanged while direct container-network calls get 401.
export const DASHBOARD_TOKEN_HEADER = "X-Dashboard-Token";
const DASHBOARD_TOKEN_FILE_ENV = "HARNESS_DASHBOARD_TOKEN_FILE";

// #114 A1: the store API's own bearer, a SEPARATE secret from the dashboard
// token above -- different consumer (the scheduler host's cron job), so a
// leak of one credential never grants the other's access.
export const STORE_TOKEN_HEADER = "X-Store-Token";
const STORE_TOKEN_FILE_ENV = "HARNESS_STORE_TOKEN_FILE";

/**
 * Shared fail-closed-but-deploy-safe loader behind loadDashboardToken (#173)
 * and loadStoreToken (#114 A1) -- same shape, different secret file + label:
 *   - knob set but file missing/empty -> throw. A configured barrier that
 *     silently doesn't exist is worse than a refused start.
 *   - knob entirely absent -> barrier disabled, ONE loud warning. This keeps
 *     the health-gated auto-deploy from bricking production before the host
 *     secret is provisioned; the PM provisions the secret + compose knob in
 *     the same deploy that enables it.
 */
function loadBearerTokenFromFile(fileEnvVar: string, env: Record<string, string | undefined>, label: string): string | undefined {
  const path = env[fileEnvVar];
  if (!path) {
    console.warn(
      `WARNING: ${fileEnvVar} is not set -- ${label} barrier DISABLED; ` +
      "every route trusts any caller that reaches the port",
    );
    return undefined;
  }
  if (!existsSync(path)) {
    throw new Error(
      `${fileEnvVar}=${path}: file does not exist -- ` +
      `refusing to start with the ${label} barrier configured but broken`,
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length === 0) {
    throw new Error(
      `${fileEnvVar}=${path}: file is empty -- ` +
      `refusing to start with the ${label} barrier configured but broken`,
    );
  }
  return token;
}

export function loadDashboardToken(env: Record<string, string | undefined>): string | undefined {
  return loadBearerTokenFromFile(DASHBOARD_TOKEN_FILE_ENV, env, "dashboard second auth (#173)");
}

/** #114 A1: loads the store API's bearer -- same fail-closed/deploy-safe shape as loadDashboardToken. */
export function loadStoreToken(env: Record<string, string | undefined>): string | undefined {
  return loadBearerTokenFromFile(STORE_TOKEN_FILE_ENV, env, "store API (#114 A1)");
}

// sha256 both sides before timingSafeEqual: timingSafeEqual requires
// equal-length inputs (it throws otherwise), and an early length check would
// itself be a (minor) oracle. Hashing normalizes both sides to 32 bytes so
// the compare is constant-time regardless of what the caller sent.
function tokenMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false;
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(presented).digest(),
  );
}

const DASHBOARD_HTML = new URL("./dashboard.html", import.meta.url);

function findAgent(agents: Agent[], id: string): Agent | undefined {
  return agents.find((a) => a.id === id);
}

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? DEFAULT_EVENTS_LIMIT);
  if (!Number.isFinite(n)) return DEFAULT_EVENTS_LIMIT;
  return Math.min(Math.max(1, Math.trunc(n)), MAX_EVENTS_LIMIT);
}

// #114 A1: same character class scripts/strategy-store.ts enforces client-side
// before it ever sends the request. Duplicated deliberately, not imported --
// the client validates to fail fast, this validates because the client is
// untrusted from the server's point of view (the trust boundary is the HTTP
// request, exactly the role the old sm-store-dispatch.sh allowlist played).
const STORE_AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * #114 A1: the three fixed store ops, now HTTP routes instead of an SSH
 * forced command. Handles its OWN auth (storeToken/STORE_TOKEN_HEADER) --
 * called before the #173 dashboard gate below, so a caller with only the
 * store bearer never needs a dashboard token and vice versa. Absent
 * storeToken or storeDbPath (not configured) -> 404, the same "feature does
 * not exist yet" posture as an unconfigured dashboard barrier.
 *
 * dump/gate open a READONLY handle (the Store class's own constructor
 * writes -- PRAGMA + CREATE TABLE -- so it cannot open the file read-only);
 * mark opens writable, the ONE authorized store write. Each request opens
 * and closes its own short-lived handle rather than reusing the live
 * Store's connection -- this mirrors exactly what the old CLI scripts did
 * per-invocation, so there is no new connection-lifetime invariant to prove;
 * WAL mode (Store's constructor) already permits concurrent readers.
 */
async function handleStoreRoute(
  req: Request,
  url: URL,
  opts: { storeToken?: string; storeDbPath?: string },
): Promise<Response> {
  const { storeToken, storeDbPath } = opts;
  if (storeToken === undefined || storeDbPath === undefined) {
    return new Response("not found", { status: 404 });
  }
  if (!tokenMatches(storeToken, req.headers.get(STORE_TOKEN_HEADER))) {
    return new Response("unauthorized", { status: 401 });
  }

  const dumpMatch = url.pathname.match(/^\/api\/store\/([^/]+)\/dump$/);
  if (dumpMatch && req.method === "GET") {
    const [, agentId] = dumpMatch as unknown as [string, string];
    if (!STORE_AGENT_ID_RE.test(agentId)) return Response.json({ error: "invalid_agent_id" }, { status: 400 });
    try {
      const db = new Database(storeDbPath, { readonly: true });
      try {
        const reqWindow = Number(url.searchParams.get("windowHours"));
        const windowHours = Number.isFinite(reqWindow) && reqWindow > 0 ? reqWindow : REVIEW_WINDOW_HOURS;
        return Response.json(readDump(db, agentId, Date.now(), windowHours));
      } finally {
        db.close();
      }
    } catch (e) {
      return Response.json(
        { error: "store_unreadable", message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  }

  const gateMatch = url.pathname.match(/^\/api\/store\/([^/]+)\/gate$/);
  if (gateMatch && req.method === "GET") {
    const [, agentId] = gateMatch as unknown as [string, string];
    if (!STORE_AGENT_ID_RE.test(agentId)) return Response.json({ error: "invalid_agent_id" }, { status: 400 });
    try {
      const db = new Database(storeDbPath, { readonly: true });
      try {
        return Response.json(evaluateReviewGate(db, agentId));
      } finally {
        db.close();
      }
    } catch (e) {
      return Response.json(
        { error: "store_unreadable", message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  }

  const markMatch = url.pathname.match(/^\/api\/store\/([^/]+)\/mark$/);
  if (markMatch && req.method === "POST") {
    const [, agentId] = markMatch as unknown as [string, string];
    if (!STORE_AGENT_ID_RE.test(agentId)) return Response.json({ error: "invalid_agent_id" }, { status: 400 });
    try {
      const db = new Database(storeDbPath);
      // Writable handle, opened fresh per request (see the class comment
      // above) -- unlike dump/gate's readonly handles, this one can collide
      // with the live agent's own event-append under WAL and throw
      // SQLITE_BUSY. A short busy_timeout makes SQLite retry internally
      // instead of failing the request outright. bun:sqlite is SYNCHRONOUS, so
      // the retry BLOCKS the single Bun event loop (dashboard reads, WS
      // broadcast) for the whole wait on real contention -- 1000ms bounds that
      // worst-case stall (#427). mark fires at most once per 6h review with a
      // sub-ms expected hold, so a 1s ceiling never bites in practice yet caps
      // the tail if it ever does. Still strictly better than the prior 5000ms.
      db.exec("PRAGMA busy_timeout = 1000;");
      try {
        const ts = Date.now();
        markReviewRan(db, agentId, ts);
        return Response.json({ marked: agentId, ts });
      } finally {
        db.close();
      }
    } catch (e) {
      return Response.json(
        { error: "store_unreadable", message: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  }

  return new Response("not found", { status: 404 });
}

/**
 * Bun.serve wrapper: REST read endpoints over Agent.snapshot()/Store queries,
 * plus a WS broadcast of every event the store appends. Kept as one file
 * (route table + handlers) rather than a router abstraction -- 5 routes
 * total across this plan (Tasks 1-3) is well under the threshold where a
 * routing library or even a hand-rolled router earns its complexity.
 */
export function startDashboardServer(opts: DashboardServerOptions): DashboardServer {
  const { host, port, store, agents, authToken, storeToken, storeDbPath } = opts;

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // #114 A1: store routes carry their OWN bearer auth and are handled
      // fully here -- deliberately BEFORE the #173 dashboard gate, so a
      // scheduler caller holding only the store token never needs (and never
      // sees) the dashboard token, and vice versa.
      if (url.pathname.startsWith("/api/store/")) {
        return handleStoreRoute(req, url, { storeToken, storeDbPath });
      }

      // #173: the token gate runs before ANY dashboard routing (HTML, API,
      // WS upgrade) so a route added below is covered by default rather than
      // opted in.
      if (authToken !== undefined && !tokenMatches(authToken, req.headers.get(DASHBOARD_TOKEN_HEADER))) {
        return new Response("unauthorized", { status: 401 });
      }

      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        return new Response(Bun.file(DASHBOARD_HTML), { headers: { "content-type": "text/html; charset=utf-8" } });
      }

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

      const usageMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/usage$/);
      if (usageMatch && req.method === "GET") {
        const [, id] = usageMatch as unknown as [string, string];
        if (!findAgent(agents, id)) return Response.json({ error: "agent_not_found" }, { status: 404 });
        // Operator-selectable window: ?hours= validated against the allowlist,
        // else the 24h default. A bad/absent value silently falls back rather
        // than erroring -- a dashboard poll should never 400 over a stale param.
        const reqHours = Number(url.searchParams.get("hours"));
        const windowHours = (USAGE_WINDOW_OPTIONS as readonly number[]).includes(reqHours)
          ? reqHours : USAGE_WINDOW_HOURS;
        const now = Date.now();
        const cutoff = now - windowHours * 60 * 60 * 1000;
        // Bucket width scales with the window to keep the plan-rate sparkline
        // at a readable ~48 buckets (1h -> 1min, 24h -> 30min, 10d -> 5h).
        const bucketMinutes = Math.max(1, Math.round((windowHours * 60) / 48));
        // One events read serves both the scalar summary and the credits
        // trend series (Layer 5) -- the dashboard (Batch 2b) gets everything
        // it needs from this single endpoint without a second query.
        const events = store.eventsSince(id, cutoff);
        const summary = summarizeUsage(id, events, now, windowHours);
        // Every trend the dashboard (Batch 2b) draws comes off this ONE events
        // read: the scalar summary, the credits + plan-rate series, the deploy
        // markers overlaid on both, and the >80% wake-reason banner verdict --
        // all derived server-side so the client renders rather than recomputes.
        return Response.json({
          ...summary,
          creditsSeries: creditsSeries(events),
          planRateSeries: planRateSeries(events, now, windowHours, bucketMinutes),
          deployMarkers: deployMarkers(events),
          wakeReasonAlert: wakeReasonAlert(summary.wakeReasonHistogram),
        });
      }

      // #158 failure taxonomy -- sibling of /usage (same window allowlist,
      // same auth: the #173 token gate above runs before any routing). The
      // events read differs on purpose: eventsByTypeSince(id, "action", 0) is
      // LIFETIME, not the window cutoff, because two of the three signals are
      // unanswerable from a window alone -- new-class detection needs the
      // first-ever occurrence, and broken-capability rates need the full
      // history (the 86/86 buy case accrued over days). One type-filtered
      // indexed read serves all three; the window applies inside the pure
      // aggregation, not the query.
      const failuresMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/failures$/);
      if (failuresMatch && req.method === "GET") {
        const [, id] = failuresMatch as unknown as [string, string];
        if (!findAgent(agents, id)) return Response.json({ error: "agent_not_found" }, { status: 404 });
        const reqHours = Number(url.searchParams.get("hours"));
        const windowHours = (USAGE_WINDOW_OPTIONS as readonly number[]).includes(reqHours)
          ? reqHours : USAGE_WINDOW_HOURS;
        const events = store.eventsByTypeSince(id, "action", 0);
        return Response.json(failureTaxonomy(id, events, Date.now(), windowHours));
      }

      // Per-player mission tracker (operator request 2026-07-18) -- sibling of
      // /usage and /failures (same #173 token gate above, same 404-on-unknown
      // guard). No window param: the two numbers are point-in-time, not a
      // trailing window -- the CURRENT active set and the LIFETIME completed
      // total. Both come off the single latest event of their kind
      // (recentEventsByType(..., 1)), an indexed one-row read, so this endpoint
      // makes no game call and costs one SQLite lookup each. See missions.ts.
      const missionsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/missions$/);
      if (missionsMatch && req.method === "GET") {
        const [, id] = missionsMatch as unknown as [string, string];
        if (!findAgent(agents, id)) return Response.json({ error: "agent_not_found" }, { status: 404 });
        const latestSnapshot = store.recentEventsByType(id, "status_snapshot", 1)[0];
        const latestPlanContext = store.recentEventsByType(id, "plan_context", 1)[0];
        return Response.json(missionSummary(latestSnapshot, latestPlanContext));
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
    // Non-null assertion: bun-types marks Server.port as `number | undefined`
    // only because it's undefined for unix-socket listeners; this server
    // always binds a TCP hostname (opts.host), so port is populated the
    // instant Bun.serve() returns.
    port: server.port!,
    stop() {
      store.onEvent = previousOnEvent;
      server.stop(true);
    },
  };
}
