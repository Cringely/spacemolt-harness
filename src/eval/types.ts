import type { PlanContext } from "../planner/types";

// The offline planner eval (issue #263, born from SM-9). A case is ONE recorded
// game state -- exactly the PlanContext the live agent would have handed the
// planner (digest.ts renders it) -- plus whatever ground truth about that state
// the state itself doesn't carry.
//
// Why PlanContext and not a rendered digest string: the digest is a RENDERING of
// PlanContext, so the context is the smaller, checkable thing, and it is also the
// ground truth. Which POIs exist, which carry [station], what is fitted, how full
// the hold is -- all of it is right there in the same object the planner was
// shown. A scorer therefore needs no second source of truth to compare against,
// and any planner (subscription / ollama / openai-compat) can be fed the same
// case through the existing Planner seam with zero adapters.
export interface EvalCase {
  id: string;
  /** What this recorded state is, and (for a replay case) which incident it came from. */
  note?: string;
  ctx: PlanContext;
  groundTruth?: GroundTruth;
  /**
   * The plan a planner ACTUALLY produced on this state, when we have it (the
   * SM-9 replay cases carry the local model's real output). Lets the scorers be
   * exercised with zero LLM calls -- the ablation test for the scorers themselves.
   */
  recordedPlan?: CandidatePlan;
}

export interface GroundTruth {
  /**
   * The COMPLETE set of system ids that exist in this case's world. Present only
   * when we actually know it; a scorer that needs it and doesn't have it ABSTAINS
   * (the M-34 rule: absence of data must never render a negative verdict). This
   * is the only fact a case needs that PlanContext doesn't carry: travel_to
   * reaches systems beyond `connections`, so connections alone cannot tell an
   * invented system id (SM-9's `trappist_prime`) from a real distant one.
   */
  knownSystemIds?: string[];
}

// A CANDIDATE plan is a plan as a planner emitted it -- NOT a validated
// registry/plan.ts Plan. That distinction is the point: half of what we score is
// whether the plan would even survive validation (invented action names, missing
// required params). Typing the scorer input as `Plan` would assume away the
// failures we exist to catch.
export interface CandidateStep {
  action: string;
  params: Record<string, unknown>;
  until?: string;
  repeat?: number;
}

export interface CandidatePlan {
  goal: string;
  steps: CandidateStep[];
}

export type Verdict = "pass" | "fail" | "abstain";

export interface ScoreResult {
  scorer: string;
  verdict: Verdict;
  /** Why. For a fail, names the offending step; for an abstain, the missing input. */
  reason: string;
}

export type Scorer = (plan: CandidatePlan, c: EvalCase) => ScoreResult;
