// Client factory (improv-mode plan Batch B) — builds the game clients an agent
// runs on, sibling of planner-factory.ts.
//
// The concurrent-capable session model (Batch 0 finding #3): an agent may hold an
// HTTP GameApi (the plan-then-execute pilot) AND an MCP GameApi (the improv pilot)
// AT THE SAME TIME. Batch 0 proved the HTTP session survives an MCP login on the
// same account, so there is NO serial teardown/handover — this factory just builds
// both and returns them side by side. Nothing here (or anywhere) tears the HTTP
// session down to stand the MCP one up; the concurrent-capable property is
// structural (no teardown call exists), not a runtime dance.
//
// Deliberately does NOT establish the MCP session. Per the plan's at-login caveat,
// dual-session coexistence is verified only immediately post-login and the first
// improv window must be supervised, so the MCP transport is built dormant and the
// improv activation (Batch C/E) performs the handshake+login when a window opens —
// keeping a live, unattended second session from every improv agent at boot.

import { SpacemoltHttp } from "../client/http";
import { SpacemoltClient } from "../client/client";
import { SpacemoltMcp } from "../client/mcp";
import { McpGameApi } from "../client/mcp-game-api";
import type { AgentEntry } from "./config";

export interface AgentClients {
  /** The plan-then-execute driver over HTTP `/api/v2`. Always built. */
  http: SpacemoltClient;
  /** The improv driver over MCP. Present only when the agent has an `improv`
   * block. Built dormant (not yet handshaken/logged in — see the header note). */
  improv?: McpGameApi;
}

/**
 * Build the client set for one agent. The HTTP client is always constructed (the
 * caller logs it in). The MCP transport + adapter are constructed only when the
 * agent is configured for improv, using its configured tool preset.
 */
export function buildAgentClients(entry: AgentEntry, serverUrl: string): AgentClients {
  const http = new SpacemoltClient(new SpacemoltHttp(serverUrl));
  if (!entry.improv) return { http };
  const mcp = new SpacemoltMcp(serverUrl, { preset: entry.improv.preset });
  return { http, improv: new McpGameApi(mcp) };
}
