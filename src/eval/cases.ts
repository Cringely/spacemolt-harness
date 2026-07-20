import { readFileSync } from "node:fs";
import { z } from "zod";
import type { PlanContext } from "../planner/types";
import type { EvalCase } from "./types";

// Loading/validating eval cases (issue #263). Cases are JSON -- committed
// fixtures (test/fixtures/eval-cases.json) or the output of the harvester
// (harvest.ts) run against a real events DB -- so they are persisted state and
// get the persisted-state schema-tolerance treatment (AGENTS.md): a case that no
// longer validates against the CURRENT PlanContext shape is DISCARDED with a
// warning, never crashed on. A harvest from an older harness build must not take
// the eval down.
//
// The schema mirrors PlanContext deliberately rather than casting a
// passthrough'd blob: the parse output is ASSIGNED to PlanContext below, so if
// PlanContext ever grows a required field or tightens an enum, this file fails
// TYPECHECK instead of failing silently at scoring time.

const WakeSchema = z.object({
  reason: z.enum(["no_plan", "plan_done", "blocked", "instruction", "notification", "low_fuel", "low_hull", "heartbeat"]),
  detail: z.string().optional(),
});

const SurroundingsSchema = z.object({
  systemId: z.string().nullable(),
  systemName: z.string().nullable(),
  connections: z.array(z.string()),
  pois: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    class: z.string().optional(),
    resources: z.array(z.string()).optional(),
    hasBase: z.boolean().optional(),
    incompatible: z.string().optional(),
    // Learned sparse-deposit marker (issue #188): mirrors Surroundings.pois.
    sparse: z.boolean().optional(),
  })),
  dockedAt: z.string().nullable(),
  currentPoi: z.object({ id: z.string(), name: z.string(), type: z.string() }).optional(),
});

const CargoSchema = z.object({
  used: z.number(),
  capacity: z.number(),
  items: z.array(z.object({ itemId: z.string(), name: z.string(), quantity: z.number() })),
});

const FittedModuleSchema = z.object({
  typeId: z.string(),
  type: z.string(),
  miningPower: z.number().optional(),
  slot: z.string().optional(),
  name: z.string().optional(),
});

const PlanContextSchema = z.object({
  persona: z.string(),
  goals: z.array(z.string()),
  wake: WakeSchema,
  statusSummary: z.string(),
  recentEvents: z.array(z.string()),
  instruction: z.string().optional(),
  // Instruction salience (issue #355): the standing operator instruction the
  // digest re-raises every replan until the planner reports it done.
  standingInstruction: z.string().optional(),
  surroundings: SurroundingsSchema.optional(),
  cargo: CargoSchema.optional(),
  previousGoal: z.object({
    goal: z.string(),
    outcome: z.enum(["completed", "blocked", "superseded"]),
  }).optional(),
  chatMessages: z.array(z.object({ sender: z.string(), text: z.string() })).optional(),
  missionsText: z.string().optional(),
  activeMissionsText: z.string().optional(),
  // Mission-progress bridge (issue #291): parsed active-mission facts + the
  // current POI's deposit ids -- mirrors ActiveMissionStatus (planner/types.ts).
  activeMissions: z.array(z.object({
    missionId: z.string().optional(),
    expiresInTicks: z.number().optional(),
    percentComplete: z.number().optional(),
    zeroProgressHours: z.number().optional(),
    objectives: z.array(z.object({
      type: z.string().optional(),
      itemId: z.string().optional(),
      required: z.number().optional(),
      current: z.number().optional(),
      inCargo: z.number().optional(),
      completed: z.boolean().optional(),
      targetBase: z.string().optional(),
      systemId: z.string().optional(),
    })),
  })).optional(),
  currentPoiDepositIds: z.array(z.string()).optional(),
  // Mining preconditions (issue #188): deposit ids + supported_power -- the
  // replacement for currentPoiDepositIds (kept above as the replay-only
  // legacy field so harvested cases predating #188 still parse and replay).
  currentPoiDeposits: z.array(z.object({
    resourceId: z.string(),
    supportedPower: z.number().optional(),
  })).optional(),
  nearbyText: z.string().optional(),
  lowFuel: z.boolean().optional(),
  marketRows: z.array(z.object({
    itemId: z.string(),
    bestBuy: z.number().optional(),
    buyQty: z.number(),
  })).optional(),
  shipFit: z.object({
    cpuUsed: z.number(),
    cpuCapacity: z.number(),
    powerUsed: z.number(),
    powerCapacity: z.number(),
    slots: z.object({ weapon: z.number(), defense: z.number(), utility: z.number() }),
  }).optional(),
  fittedModules: z.array(FittedModuleSchema).optional(),
  shipyardText: z.string().optional(),
  // Capability-audit fix (Workflow A, 2026-07-19): mirrors PlanContext's
  // ownedShipsText -- raw text, so a plain optional string is the whole
  // mirror, same as shipyardText above.
  ownedShipsText: z.string().optional(),
  purchaseEstimates: z.array(z.object({
    itemId: z.string(),
    name: z.string().optional(),
    text: z.string(),
  })).optional(),
  // Market-intelligence injection (issue #269): the harness-run analyze_market
  // insight text -- raw, so a plain optional string mirrors the PlanContext field.
  marketInsightsText: z.string().optional(),
  // Capability-audit follow-up (2026-07-19): mirrors LocationInfo
  // (client.ts) / PlanContext.locationInfo.
  locationInfo: z.object({
    poiType: z.string().optional(),
    nearbyPlayerCount: z.number().optional(),
    nearbyPirateCount: z.number().optional(),
    nearbyEmpireNpcCount: z.number().optional(),
    inTransit: z.boolean().optional(),
    transitDestPoiName: z.string().optional(),
    transitArrivalTick: z.number().optional(),
  }).optional(),
});

// Key parity, at COMPILE time (issue #272). The comment above promised a drift
// guard, and the assignment below (`const ctx: PlanContext = res.data.ctx`)
// delivers only half of it: a new REQUIRED field breaks that assignment, but a
// new OPTIONAL one does not -- z.object silently STRIPS the unknown key, so
// purchaseEstimates (#270) was dropped from every harvested case and typechecked
// clean. This assertion compares the two key sets in BOTH directions, so a field
// present on one side and absent from the other fails `bun run typecheck`
// instead of failing silently at scoring time -- which is what a schema that
// mirrors a type by hand needs, and what "the parse output is assigned to
// PlanContext" cannot give on its own.
//
// IF TYPECHECK FAILS ON THE LINE BELOW with `TS2322: Type 'true' is not assignable
// to type 'never'`, that is this check firing, and it means exactly one thing: a
// field exists on PlanContext but not on PlanContextSchema, or vice versa. Add it
// to whichever side is missing it. TypeScript cannot name the offending key here
// (it collapses the mismatch to `never`), and a named helper type does not change
// the message -- tried, it still prints `never` -- so this comment is the
// diagnosis (PR #273 review).
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _planContextKeyParity: Exact<keyof z.infer<typeof PlanContextSchema>, keyof PlanContext> = true;
void _planContextKeyParity;

// A CANDIDATE plan, not a registry Plan: a recorded plan is scored precisely
// BECAUSE it may be invalid (see types.ts). PlanSchema here would reject the
// SM-9 replay cases this eval exists to catch.
export const CandidatePlanSchema = z.object({
  goal: z.string(),
  steps: z.array(z.object({
    action: z.string(),
    params: z.record(z.unknown()).default({}),
    until: z.string().optional(),
    repeat: z.number().optional(),
  })),
});

export const EvalCaseSchema = z.object({
  id: z.string(),
  note: z.string().optional(),
  ctx: PlanContextSchema,
  groundTruth: z.object({ knownSystemIds: z.array(z.string()).optional() }).optional(),
  recordedPlan: CandidatePlanSchema.optional(),
});

/** Parse one case. Returns null (with a warning) for a case that no longer validates. */
export function parseCase(raw: unknown): EvalCase | null {
  const res = EvalCaseSchema.safeParse(raw);
  if (!res.success) {
    const id = (raw as { id?: unknown })?.id;
    console.warn(`[eval] discarding invalid case ${typeof id === "string" ? id : "<no id>"}: ${res.error.issues[0]?.message}`);
    return null;
  }
  // Assignment, not a cast: TypeScript verifies the parsed shape against the
  // real PlanContext, so a drift in either direction is a typecheck failure.
  const ctx: PlanContext = res.data.ctx;
  return { ...res.data, ctx };
}

export function loadCases(path: string): EvalCase[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of eval cases`);
  return raw.map(parseCase).filter((c): c is EvalCase => c !== null);
}
