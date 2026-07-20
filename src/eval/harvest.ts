import { Store } from "../store/store";
import { parseCase } from "./cases";
import type { EvalCase } from "./types";

// Harvest eval cases from a real events DB (issue #263). The producer is the
// agent's `plan_context` event (src/agent/agent.ts): the exact PlanContext the
// planner was shown, plus the raw plan it returned. So a case is a RECORDING of
// a real decision point, not a hand-written scenario -- which is the whole point
// of the eval (score a candidate model on states our pilot actually hit).
//
// Ground truth that the recorded state cannot carry: knownSystemIds. The system
// list a live agent knows is its current system plus its connections; a
// travel_to beyond that is legitimate, so the harvester leaves knownSystemIds
// UNSET and the system-ref scorer abstains on travel_to for harvested cases (see
// scorers.ts). A curated fixture that DOES know the world (the SM-9 replay) sets
// it by hand. Better an abstention than a fabricated failure.

export const PLAN_CONTEXT_EVENT = "plan_context";

export function harvestCases(dbPath: string, agentId: string, limit = 50): EvalCase[] {
  const store = new Store(dbPath);
  try {
    const events = store.recentEventsByType(agentId, PLAN_CONTEXT_EVENT, limit);
    return events
      .map((e) => {
        const p = e.payload as { ctx?: unknown; plan?: unknown };
        return parseCase({
          id: `${agentId}-${e.id}`,
          note: `harvested from ${agentId} at ${new Date(e.ts).toISOString()}`,
          ctx: p?.ctx,
          recordedPlan: p?.plan,
        });
      })
      .filter((c): c is EvalCase => c !== null);
  } finally {
    store.close();
  }
}
