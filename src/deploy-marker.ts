import type { Store } from "./store/store";

// Change-marker source (Batch 2b). Git tags are NOT available inside the
// container (the image is built once and the .git dir isn't shipped), so the
// build identity has to come from a runtime-available source. The harness
// emits one `deploy_marker` event per agent at startup carrying its build id;
// the dashboard overlays those event timestamps as vertical lines on the
// credits and plan-rate charts, making a build's before/after visible.
//
// Per-agent, not a single global event: the store keys every event by agentId
// and the usage/credits queries are per-agent (src/server/usage.ts,
// src/server/server.ts's /usage route). Emitting one marker per agent lands it
// in each agent's own event window with zero new "global events" concept --
// same events table, same query shape as everything else.
export const DEPLOY_MARKER_TYPE = "deploy_marker";

export interface DeployMarkerPayload {
  buildId: string;
  startedAt: number; // epoch ms the harness process started
}

// Build-id precedence: an explicit image tag / build id from the environment
// (the deploy pipeline sets HARNESS_IMAGE_TAG), else a dev fallback stamped
// with the process start time so every restart still produces a DISTINCT,
// orderable marker even with no tag configured. The ISO timestamp is human
// readable in the chart tooltip.
export function resolveBuildId(env: Record<string, string | undefined>, startTime: number): string {
  // First NON-BLANK wins across both vars: `??` alone would let an explicitly
  // empty HARNESS_IMAGE_TAG (e.g. compose `${TAG:-}` with TAG unset) shadow a
  // valid HARNESS_BUILD_ID and drop to the dev fallback.
  for (const tag of [env["HARNESS_IMAGE_TAG"], env["HARNESS_BUILD_ID"]]) {
    if (tag && tag.trim() !== "") return tag.trim();
  }
  return `dev-${new Date(startTime).toISOString()}`;
}

// Emit the startup marker for every agent. Pure wiring over Store.appendEvent
// (which fans out to the WS broadcast + console hook already), so a running
// dashboard sees the marker live the instant the harness boots.
export function emitDeployMarkers(store: Store, agentIds: string[], buildId: string, startedAt: number): void {
  for (const agentId of agentIds) {
    store.appendEvent({
      agentId,
      ts: startedAt,
      type: DEPLOY_MARKER_TYPE,
      payload: { buildId, startedAt } satisfies DeployMarkerPayload,
    });
  }
}
