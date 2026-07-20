import { REGISTRY } from "../registry/actions";
import { describeParamsShape, type FieldShape } from "../registry/params-shape";
import type { PlanContext, Planner, PlanResult } from "./types";
import { buildDigest } from "./digest";
import { TransientPlannerError } from "./errors";
import { planWithSingleRetry } from "./parse";

export interface OllamaOptions {
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch; // injectable for tests
}

interface ChatResponse {
  message?: { content?: string };
}

export class OllamaPlanner implements Planner {
  private fetchImpl: typeof fetch;

  constructor(private opts: OllamaOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async plan(ctx: PlanContext): Promise<PlanResult> {
    // Shared invoke->parse->retry-once seam (parse.ts). A local model is priced
    // free in usage.ts, but the char counts are still recorded so a mixed
    // fleet reports consistently.
    return planWithSingleRetry("ollama", this.opts.model, buildDigest(ctx), (p) => this.invoke(p));
  }

  private async invoke(prompt: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.opts.model,
          stream: false,
          format: PLAN_JSON_SCHEMA,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (e) {
      // Ollama is self-hosted with no subscription tiers or OAuth -- every
      // infra failure here is "transient". Modeling subscription_limit or
      // token_invalid for a local model would be a class of error with no
      // real trigger; that's complexity without a use.
      throw new TransientPlannerError(`ollama: request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new TransientPlannerError(`ollama: HTTP ${res.status}`);
    const body = (await res.json()) as ChatResponse;
    return body.message?.content ?? "";
  }
}

// JSON Schema for Ollama's structured-output constraint, derived from the
// same REGISTRY the Zod PlanSchema derives from (SSOT) -- a generation hint
// for the model, not the authoritative validator; tryParsePlan's PlanSchema
// check still gates every response regardless of whether Ollama honors this.
// ASSUMED: Ollama's supported JSON-Schema subset (which keywords it enforces
// vs. ignores) hasn't been verified against a live server for this plan
// (no live Ollama instance available while authoring). If a keyword here
// turns out unsupported, the retry-on-validation-failure path is the safety
// net -- verify against a real local model during Plan 4's first live run.
// Exported for openai-compat.ts (#240): the SAME registry-derived generation
// hint rides in that provider's response_format -- one schema, two carriers.
export const PLAN_JSON_SCHEMA = buildPlanJsonSchema();

function buildPlanJsonSchema(): object {
  const mutationSchemas = REGISTRY.filter((a) => a.kind === "mutation")
    .map((a) => stepSchema(a.name, describeParamsShape(a.params)));

  // travel_to is executor vocabulary, not a REGISTRY action -- see
  // src/registry/plan.ts's TravelToStepSchema for the matching Zod branch.
  mutationSchemas.push({
    type: "object",
    properties: {
      action: { const: "travel_to" },
      params: { type: "object", properties: { system_id: { type: "string" } }, required: ["system_id"] },
    },
    required: ["action", "params"],
  });

  return {
    type: "object",
    properties: {
      goal: { type: "string" },
      steps: { type: "array", items: { anyOf: mutationSchemas }, minItems: 1, maxItems: 30 },
    },
    required: ["goal", "steps"],
  };
}

function stepSchema(actionName: string, fields: FieldShape[]): object {
  return {
    type: "object",
    properties: {
      action: { const: actionName },
      params: {
        type: "object",
        properties: Object.fromEntries(fields.map((f) => [f.name, jsonType(f.type)])),
        required: fields.filter((f) => !f.optional).map((f) => f.name),
      },
      until: { enum: ["cargo_full", "cargo_empty"] },
      repeat: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["action", "params"],
  };
}

function jsonType(t: FieldShape["type"]): object {
  if (t === "string") return { type: "string" };
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "object[]") return { type: "array", items: { type: "object" } };
  return { type: "array", items: { type: "string" } }; // string[]
}
