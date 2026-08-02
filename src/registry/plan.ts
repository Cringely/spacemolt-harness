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
}).strict().superRefine((plan, ctx) => {
  // A credit gift runs EXACTLY ONCE (issue #703, PR #82 review). `repeat` and
  // `until` are siblings of `params`, so the registry's own params refinement
  // cannot see them: the deposit entry bounds one CALL at GIFT_CREDIT_CEILING,
  // and executor.ts re-enters the same step per iteration (`stepDone =
  // iteration >= step.repeat`), so `repeat: 50` expresses 50 gifts through a
  // bound written for one. `until` is worse than a multiplier -- both
  // completion conditions read CARGO (cargo_full/cargo_empty) and a credit
  // transfer never changes cargo, so the condition can never trip and the step
  // re-gifts every tick until the game refuses for insufficient funds. Neither
  // field has any legitimate reading on a gift: one gift moves one amount, once.
  //
  // Refused at ADMISSION rather than in the executor because this is the one
  // place where the step's params and its repeat/until are visible together,
  // and a plan refused here costs zero ticks and zero credits. The refinement
  // sits on the whole plan rather than on the deposit branch of the step union
  // so that PlanStepSchema stays a ZodUnion: test/instruct-gate.test.ts reads
  // `PlanStepSchema.options[].shape.action.value` to re-derive the plannable
  // vocabulary, and a ZodEffects member has no `.shape` (the #527 seam).
  //
  // The ITEM form keeps repeat/until untouched -- repeating a deposit of ore is
  // real (the craft/recycle chain, #221), and a rule keyed on the action alone
  // would take that down with it.
  const steps = plan.steps as Array<{
    action?: unknown; params?: unknown; repeat?: unknown; until?: unknown;
  }>;
  steps.forEach((step, i) => {
    if (step.action !== "deposit") return;
    if (step.repeat === undefined && step.until === undefined) return;
    const target = (step.params as { target?: unknown } | undefined)?.target;
    if (typeof target !== "string") return; // item form: repeat/until are fine
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps", i],
      // Written as a correction the planner can act on, same contract as the
      // registry refinement's messages and the executor's guard reasons.
      message:
        "a credit gift is a one-shot action: drop repeat/until from this deposit step and plan " +
        "one step per gift. repeat re-sends the same gift once per tick, and until:cargo_full / " +
        "cargo_empty never trip for a credit transfer, so the step would gift forever.",
    });
  });
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
