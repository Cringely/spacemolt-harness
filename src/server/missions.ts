import type { AgentEvent } from "../store/store";

// Per-player mission tracker (operator request 2026-07-18): the dashboard needs
// two numbers per pilot -- how many missions are ACTIVE right now, and how many
// the pilot has completed over its lifetime. Both are ALREADY captured
// server-side by existing events, so this is a read-and-shape over the store,
// not a new capture path:
//
//   totalCompleted <- the latest status_snapshot event's progress.missions_completed.
//     progressCounters (no-progress-detector.ts) rides the game's lifetime stat
//     onto every snapshot; it is monotonic and cumulative, so the most recent
//     snapshot carries the current lifetime total.
//
//   active <- the latest plan_context event's ctx.activeMissions. The agent
//     fetches get_active_missions every replan (Agent.gatherActiveMissions,
//     issue #170) and the parsed ActiveMissionStatus[] is persisted verbatim in
//     the plan_context event (clipPlanContext preserves array/number structure,
//     digest.ts). So the freshest replan's active set is the freshest server
//     view of in-progress missions -- no polling subsystem, no new game call.
//
// Pure function of the two events (each may be absent), so the aggregation is
// unit-testable against a fixture store with zero I/O -- same shape as
// summarizeUsage / failureTaxonomy.

// One objective as the dashboard renders it: a human label plus the progress
// numbers. The label is built here (not in the UI) from the persisted
// objective's display fields, best-first: item_name ("Platinum Ore") ->
// description -> item_id -> type. All four are optional in the parsed shape
// (planner/types.ts ActiveMissionObjective), so label can be undefined and
// the UI falls back to a generic word.
export interface MissionObjectiveView {
  label?: string;
  current?: number;
  required?: number;
  completed?: boolean;
}

export interface ActiveMissionView {
  // The game's mission id and human title (each present when the parse
  // captured it). `title` rides the parsed ActiveMissionStatus shape since the
  // operator request of 2026-07-19 (citation: openapi-v2.json
  // V2GameState.missions.active `title` string) -- events persisted BEFORE
  // that parse lack it, and this view degrades to the id-only rendering for
  // them. percent_complete is deliberately NOT surfaced: the vendored
  // openapi-v2 types it as a bare `number` with every example value 1, so its
  // scale (0-1 fraction vs 0-100 percent) is uncitable -- rendering it would
  // guess a scale the reference does not establish. Per-objective
  // current/required are unambiguous raw counts and carry the progress
  // instead. expiresInTicks is unambiguous (a raw tick count; a tick is 10s)
  // and is the useful urgency cue.
  missionId?: string;
  title?: string;
  expiresInTicks?: number;
  objectives: MissionObjectiveView[];
}

export interface MissionSummary {
  activeCount: number;
  active: ActiveMissionView[];
  totalCompleted: number;
}

/**
 * Shape the two latest events into the per-player mission counts. `undefined`
 * for either event (a pilot that has never snapshotted or never replanned)
 * degrades to zero/empty rather than throwing -- a fresh pilot legitimately has
 * no mission history, which is a real "0 active / 0 completed" answer, not an
 * error. Malformed persisted payloads are ignored the same way (persisted-state
 * schema tolerance): a snapshot missing a numeric counter reads as 0, a
 * plan_context whose activeMissions is not an array reads as empty.
 */
export function missionSummary(
  latestSnapshot: (AgentEvent & { id: number }) | undefined,
  latestPlanContext: (AgentEvent & { id: number }) | undefined,
): MissionSummary {
  const completed = (latestSnapshot?.payload as { progress?: { missions_completed?: number } } | null)
    ?.progress?.missions_completed;
  const totalCompleted = typeof completed === "number" && Number.isFinite(completed) ? completed : 0;

  const rawActive = (latestPlanContext?.payload as { ctx?: { activeMissions?: unknown } } | null)
    ?.ctx?.activeMissions;
  const active: ActiveMissionView[] = Array.isArray(rawActive)
    ? rawActive.map((m) => {
        const mm = m as { missionId?: unknown; title?: unknown; expiresInTicks?: unknown; objectives?: unknown };
        return {
          missionId: typeof mm.missionId === "string" ? mm.missionId : undefined,
          title: typeof mm.title === "string" ? mm.title : undefined,
          expiresInTicks: typeof mm.expiresInTicks === "number" ? mm.expiresInTicks : undefined,
          // Same tolerance per level: a payload from before objectives were
          // persisted (or a malformed one) reads as no objectives, and a
          // non-object entry reads as an empty objective -- never a crash.
          objectives: Array.isArray(mm.objectives)
            ? mm.objectives.map((o): MissionObjectiveView => {
                const oo = (o !== null && typeof o === "object" ? o : {}) as {
                  itemName?: unknown; description?: unknown; itemId?: unknown; type?: unknown;
                  current?: unknown; required?: unknown; completed?: unknown;
                };
                const label = [oo.itemName, oo.description, oo.itemId, oo.type]
                  .find((v): v is string => typeof v === "string");
                return {
                  label,
                  current: typeof oo.current === "number" ? oo.current : undefined,
                  required: typeof oo.required === "number" ? oo.required : undefined,
                  completed: typeof oo.completed === "boolean" ? oo.completed : undefined,
                };
              })
            : [],
        };
      })
    : [];

  return { activeCount: active.length, active, totalCompleted };
}
