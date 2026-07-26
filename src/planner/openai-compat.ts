import type { PlanContext, Planner, PlanResult } from "./types";
import { buildDigest } from "./digest";
import { TransientPlannerError } from "./errors";
import { planWithSingleRetry } from "./parse";
import { PLAN_JSON_SCHEMA } from "./ollama";

// OpenAI-compatible chat-completions planner (#240): the LM Studio seam.
// A SIBLING of OllamaPlanner, not a generalization of it -- one endpoint shape
// (POST {baseUrl}/v1/chat/completions), one response shape, and the shared
// invoke->parse->retry-once seam from parse.ts. LM Studio serves this API on
// the LAN; anything else speaking the same protocol (vLLM, llama.cpp server)
// works unchanged, which is why the provider is named for the PROTOCOL, not
// the product.
export interface OpenAiCompatOptions {
  model: string;
  baseUrl: string; // e.g. http://workstation.lan:1234 -- /v1/chat/completions is appended here
  // Optional bearer token. A LAN LM Studio needs none (the default); when the
  // config points at a keyed server, the key arrives here already READ FROM A
  // FILE by planner-factory.ts (api_key_file) -- never inline in agents.yaml,
  // per security-baseline.md. Never logged.
  apiKey?: string;
  fetchImpl?: typeof fetch; // injectable for tests
  timeoutMs?: number; // default OPENAI_COMPAT_TIMEOUT_MS; small values are for tests
}

// 60s per request. Receipt: the tick carried an UNBOUNDED planner wait, and a
// fetch with no signal against a silent host waits out the OS TCP connect
// timeout (~127s on Linux defaults) while an accepted-but-silent socket never
// settles at all. 60s turns unbounded into bounded, which is the whole claim.
// It is NOT "far below the tick": the agent loop ticks every 10s
// (agent.ts start(intervalMs = 10_000)), so a request running its full budget
// costs skipped ticks -- start()'s `if (running) return` drops them rather
// than queueing. Worst case per plan() is 2x this, because parse.ts retries
// once on a validation failure and each invoke() builds its own signal.
// UNCONFIRMED against a real gemma-4-12b-qat generation; #240 Task 3 Step 7
// re-derives it from measured seconds-per-plan.
export const OPENAI_COMPAT_TIMEOUT_MS = 60_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export class OpenAiCompatPlanner implements Planner {
  private fetchImpl: typeof fetch;

  constructor(private opts: OpenAiCompatOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async plan(ctx: PlanContext): Promise<PlanResult> {
    // Shared invoke->parse->retry-once seam (parse.ts). A local model is priced
    // free in usage.ts; char counts are still recorded so a mixed fleet
    // reports consistently.
    return planWithSingleRetry("openai-compat", this.opts.model, buildDigest(ctx), (p) => this.invoke(p));
  }

  private async invoke(prompt: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          stream: false,
          // OpenAI structured-output shape, same registry-derived schema Ollama
          // gets via `format` (SSOT: PLAN_JSON_SCHEMA, ollama.ts). A generation
          // hint, not the validator -- tryParsePlan's PlanSchema check still
          // gates every response. VERIFIED: LM Studio's strict json_schema
          // mode was confirmed live 2026-07-14 (#240: valid JSON, zero
          // reasoning tokens, Qwen3-30B-A3B-Instruct-2507), retiring PR #260's
          // ASSUMED flag. SM-9's failures were briefing adherence, never
          // schema conformance. The retry-on-validation-failure path stays as
          // the net for any OTHER server speaking this protocol.
          response_format: { type: "json_schema", json_schema: { name: "plan", schema: PLAN_JSON_SCHEMA } },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? OPENAI_COMPAT_TIMEOUT_MS),
      });
    } catch (e) {
      // Same classification stance as Ollama: a self-hosted LAN server has no
      // subscription tiers or OAuth, so every infra failure here is
      // "transient" (retry with backoff). Modeling subscription_limit or
      // token_invalid for a local model would be a class of error with no real
      // trigger -- complexity without a use. If the workstation sleeps (the
      // #240 load-bearing constraint), this is exactly the error the operator
      // sees: transient, backing off, until the box wakes or the experiment's
      // deterministic exit reverts the agent to its fallback planner.
      throw new TransientPlannerError(`openai-compat: request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new TransientPlannerError(`openai-compat: HTTP ${res.status}`);
    let body: ChatCompletionResponse;
    try {
      // The timeout signal above also aborts a body read, and a truncated body
      // is the same class of infrastructure failure as a failed connect. Left
      // outside the classification this would escape as a plain Error and land
      // in handlePlannerFailure's catch-all, which never arms the endpoint-down
      // state -- the very stall this timeout exists to prevent. Model QUALITY
      // still fails through tryParsePlan on the CONTENT, which is untouched.
      body = (await res.json()) as ChatCompletionResponse;
    } catch (e) {
      throw new TransientPlannerError(`openai-compat: response body failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return body.choices?.[0]?.message?.content ?? "";
  }
}
