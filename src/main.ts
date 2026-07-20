import { loadConfig, ensureCredentials } from "./config/config";
import { makePlanner } from "./config/planner-factory";
import { buildAgentClients } from "./config/client-factory";
import { Store } from "./store/store";
import { Agent } from "./agent/agent";
import { startDashboardServer, loadDashboardToken, loadStoreToken } from "./server/server";
import { resolveBuildId, emitDeployMarkers } from "./deploy-marker";

const CONFIG_PATH = process.env["HARNESS_CONFIG"] ?? "agents.yaml";
const SECRETS_DIR = process.env["HARNESS_SECRETS"] ?? "secrets";
const PRUNE_DAYS = 30;
const HARNESS_STARTED_AT = Date.now();
const BUILD_ID = resolveBuildId(process.env, HARNESS_STARTED_AT);

const config = loadConfig(CONFIG_PATH);
// #173: resolve the dashboard auth token before anything expensive boots -- a
// configured-but-missing secret must refuse startup here, not fail after the
// agents have already registered and logged in.
const dashboardToken = loadDashboardToken(process.env);
// #114 A1 pivot: the scheduler's strategy-review store access moved from an
// SSH forced-command key to authenticated HTTP routes on this same server
// (src/server/server.ts /api/store/*). Same fail-closed-at-startup posture.
const storeToken = loadStoreToken(process.env);
const store = new Store(config.dbPath);
const pruned = store.pruneEvents(PRUNE_DAYS);
if (pruned > 0) console.log(`pruned ${pruned} events older than ${PRUNE_DAYS} days`);

store.onEvent = (e) => {
  console.log(`[${new Date(e.ts).toISOString()}] ${e.agentId} ${e.type}`, JSON.stringify(e.payload));
};

const agents: Agent[] = [];
for (const entry of config.agents) {
  // Build the client set (Batch B). The HTTP client is always present and logged
  // in here; the improv (MCP) client is built dormant when the agent has an improv
  // block — its session is established at improv-window activation (Batch C/E),
  // supervised, not eagerly at boot (concurrent-capable, no teardown).
  const { http: client, improv } = buildAgentClients(entry, config.serverUrl);
  const password = await ensureCredentials(client, entry, SECRETS_DIR);
  await client.login(entry.username, password);
  const plannerOpts = { secretsDir: SECRETS_DIR, ollamaUrl: config.ollamaUrl };
  const agent = new Agent({
    id: entry.id,
    persona: entry.persona,
    goals: entry.goals,
    api: client,
    improvApi: improv,
    mode: entry.mode,
    store,
    planner: makePlanner(entry.planner, plannerOpts),
    fallbackPlanner: entry.fallbackPlanner ? makePlanner(entry.fallbackPlanner, plannerOpts) : undefined,
    config: {
      fuelPct: entry.fuelPct, hullPct: entry.hullPct,
      heartbeatMinutes: entry.heartbeatMinutes,
      wakeNotificationTypes: entry.wakeNotificationTypes,
      stallThreshold: entry.stallThreshold,
      subscriptionCooldownMinutes: entry.subscriptionCooldownMinutes,
      maxPlansPerWindow: entry.maxPlansPerWindow,
      planBudgetWindowMinutes: entry.planBudgetWindowMinutes,
      fuelReservePct: entry.fuelReservePct,
      stuckWindowMinutes: entry.stuckWindowMinutes,
      strandAutoSelfDestruct: entry.strandAutoSelfDestruct,
      progressHeartbeatMinutes: entry.progressHeartbeatMinutes,
      repeatBlockThreshold: entry.repeatBlockThreshold,
      repeatBlockWindowMinutes: entry.repeatBlockWindowMinutes,
      reflex: entry.reflex,
      experiment: entry.experiment,
    },
  });
  agent.start();
  agents.push(agent);
  console.log(`agent ${entry.id} (${entry.username}) started`);
}

// Change-marker: stamp this build's start so the dashboard can show a plan's
// before/after across a redeploy (see src/deploy-marker.ts). Emitted after the
// agents exist but before the dashboard binds, so the marker is already in the
// store when the first client connects.
emitDeployMarkers(store, agents.map((a) => a.id), BUILD_ID, HARNESS_STARTED_AT);
console.log(`deploy marker ${BUILD_ID} recorded for ${agents.length} agent(s)`);

const dashboard = startDashboardServer({
  host: config.dashboardHost, port: config.dashboardPort, store, agents,
  authToken: dashboardToken,
  storeToken, storeDbPath: config.dbPath,
});
console.log(`dashboard listening on http://${config.dashboardHost}:${dashboard.port}`);

process.on("SIGINT", () => {
  console.log("stopping agents...");
  for (const a of agents) a.stop();
  dashboard.stop();
  store.close();
  process.exit(0);
});
