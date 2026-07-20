import { z } from "zod";
import { REGISTRY } from "./actions";

// The entire control-flow vocabulary (per spec): linear steps, each an
// action + optional completion condition + optional repeat count.
// Anything needing a mid-plan decision ends the plan; the planner is woken.
export const CompletionCondition = z.enum(["cargo_full", "cargo_empty"]);

const stepSchemas = REGISTRY.filter((a) => a.kind === "mutation").map((a) =>
  z.object({
    action: z.literal(a.name),
    params: a.params,
    until: CompletionCondition.optional(),
    repeat: z.number().int().min(1).max(50).optional(),
  }).strict()
);

// travel_to is executor vocabulary, not a REGISTRY action: it expands into a
// sequence of "jump" calls via the free find_route query (see executor.ts).
// Kept as a hand-added branch rather than a REGISTRY entry because
// REGISTRY's contract is "one real game action per entry" (the registry
// conformance test validates every entry against the OpenAPI spec); travel_to
// has no OpenAPI counterpart to conform against.
const TravelToStepSchema = z.object({
  action: z.literal("travel_to"),
  params: z.object({ system_id: z.string() }).strict(),
}).strict();

export const PlanStepSchema = z.union(
  [...stepSchemas, TravelToStepSchema] as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
);

export const PlanSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1).max(30),
  // Instruction satisfaction (issue #355): the planner's report that the
  // newest STANDING operator instruction has ALREADY been carried out --
  // the only satisfaction signal computable for a natural-language
  // instruction (the harness cannot parse "check the shipyard at First
  // Step" into a verifiable predicate the way #291 parses mission counts).
  // Optional and additive, so every plan persisted before this field --
  // and every planner that never emits it -- still validates (persisted-
  // state schema tolerance); a planner that never reports done degrades to
  // an over-shown briefing block, never a crash. Consumed in Agent.replan,
  // honored ONLY on a wake where the standing-instruction block was
  // actually shown (digest.ts names this exact key in that block -- the
  // #355 seam, see docs/wiki/seam-manifest.md).
  instruction_done: z.boolean().optional(),
}).strict();

export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
