import { PlanSchema, type Plan } from "../registry/plan";
import type { PlanResult } from "./types";

export type ParsedPlan = { ok: true; plan: Plan } | { ok: false; error: string };

// Ground truth (2026-07-10 maiden flight, haiku via claude-subscription): the
// model wrapped its plan response in a markdown code fence -- ```json ... ```
// -- despite digest.ts's explicit "No markdown, no prose, no code fences"
// instruction. JSON.parse failed on both the original attempt and the retry
// with "not valid JSON: Unrecognized token '`'", losing the whole replan. The
// prompt instruction alone didn't stop it, so this is defensive tolerance at
// the parse seam shared by both planners, not a prompt-only fix.
const FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const m = FENCE_RE.exec(trimmed);
  return m ? m[1]! : trimmed;
}

/**
 * Shared parse+validate path for every Planner implementation's raw model
 * output (claude-subscription.ts and ollama.ts both call this instead of
 * duplicating the logic). Strips a wrapping code fence, if any, before
 * JSON.parse -- garbage that isn't valid JSON even after stripping still
 * fails cleanly with the same "not valid JSON" error shape as before.
 */
export function tryParsePlan(resultText: string): ParsedPlan {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFences(resultText));
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, plan: parsed.data };
}

/**
 * The shared invoke -> parse -> retry-once loop every LLM planner runs (SSOT;
 * previously copied verbatim in claude-subscription.ts and ollama.ts, extracted
 * here when openai-compat.ts would have made a third copy — #240).
 *
 * Cost capture (Layer 5): the returned PlanResult accumulates the chars
 * actually sent/received INCLUDING the validation-retry round — that retry is
 * real spend (subscription) or real latency (local) and would be invisible if
 * only the first prompt were counted. `invoke` throws its provider's own
 * classified errors (TransientPlannerError etc.), which pass through untouched;
 * only a plan that fails validation twice becomes the plain Error here (the
 * existing catch-all class in Agent.handlePlannerFailure).
 */
export async function planWithSingleRetry(
  provider: string,
  model: string,
  prompt: string,
  invoke: (prompt: string) => Promise<string>,
): Promise<PlanResult> {
  const first = await invoke(prompt);
  let promptChars = prompt.length;
  let responseChars = first.length;
  const parsed = tryParsePlan(first);
  if (parsed.ok) return { plan: parsed.plan, promptChars, responseChars, model };

  const retryPrompt = `${prompt}\n\nYour previous response failed validation: ${parsed.error}\nRespond again with ONLY corrected JSON.`;
  const second = await invoke(retryPrompt);
  promptChars += retryPrompt.length;
  responseChars += second.length;
  const parsed2 = tryParsePlan(second);
  if (parsed2.ok) return { plan: parsed2.plan, promptChars, responseChars, model };
  throw new Error(`${provider}: plan validation failed after retry: ${parsed2.error}`);
}
