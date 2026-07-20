import { afterEach, describe, expect, test } from "bun:test";
import { OpenAiCompatPlanner } from "../src/planner/openai-compat";
import { TransientPlannerError } from "../src/planner/errors";
import type { PlanContext } from "../src/planner/types";
import { startFakeOpenAiCompat, type FakeOpenAiCompat } from "./fake-openai-compat";

// Offline: an in-process fake speaking the OpenAI chat-completions shape
// (test/fake-openai-compat.ts), zero live LLM or game traffic. Each test names
// the breakage it catches.

let server: FakeOpenAiCompat;
afterEach(() => server?.stop());

const ctx: PlanContext = {
  persona: "explorer",
  goals: [],
  wake: { reason: "no_plan" },
  statusSummary: "credits 0, fuel 100/100, hull 100/100, cargo 0/50, undocked",
  recentEvents: [],
};

const validContent = JSON.stringify({ goal: "explore", steps: [{ action: "undock", params: {} }] });

describe("OpenAiCompatPlanner", () => {
  // Breakage caught: the request drifting off the OpenAI chat-completions wire
  // shape (wrong path, missing schema hint, streaming on) -- LM Studio would
  // reject or free-run the generation.
  test("posts the chat-completions shape with the registry-derived json_schema hint", async () => {
    server = startFakeOpenAiCompat();
    server.respondWith(() => ({ choices: [{ message: { content: validContent } }] }));
    const planner = new OpenAiCompatPlanner({ model: "qwen3-30b", baseUrl: server.url });
    const { plan, model } = await planner.plan(ctx);
    expect(plan.goal).toBe("explore");
    expect(model).toBe("qwen3-30b"); // Layer 5 cost seam reports the model

    const req = server.requests[0]!.body;
    expect(req["model"]).toBe("qwen3-30b");
    expect(req["stream"]).toBe(false);
    const rf = req["response_format"] as { type: string; json_schema: { schema: unknown } };
    expect(rf.type).toBe("json_schema");
    expect(typeof rf.json_schema.schema).toBe("object"); // the shared PLAN_JSON_SCHEMA rides along
    expect(Array.isArray(req["messages"])).toBe(true);
  });

  // Breakage caught: losing the shared retry seam -- a local model's malformed
  // first answer must cost one corrective round-trip, not the whole replan.
  test("malformed JSON retries once with the validation error appended, then succeeds", async () => {
    server = startFakeOpenAiCompat();
    let calls = 0;
    server.respondWith((body) => {
      calls++;
      if (calls === 1) return { choices: [{ message: { content: "not json {" } }] };
      const lastMsg = (body["messages"] as Array<{ content: string }>).at(-1)!;
      expect(lastMsg.content).toContain("failed validation");
      return { choices: [{ message: { content: validContent } }] };
    });
    const planner = new OpenAiCompatPlanner({ model: "m", baseUrl: server.url });
    const { plan } = await planner.plan(ctx);
    expect(calls).toBe(2); // exactly one retry
    expect(plan.goal).toBe("explore");
  });

  // Breakage caught: an infinite retry loop, or a swallowed failure returning
  // a phantom plan, when the model is persistently wrong.
  test("throws after a second consecutive invalid response", async () => {
    server = startFakeOpenAiCompat();
    server.respondWith(() => ({ choices: [{ message: { content: JSON.stringify({ goal: "x", steps: [] }) } }] }));
    const planner = new OpenAiCompatPlanner({ model: "m", baseUrl: server.url });
    await expect(planner.plan(ctx)).rejects.toThrow(/plan validation failed after retry/);
  });

  // Breakage caught: misclassifying an unreachable/erroring LAN server. Both
  // must be TransientPlannerError so Agent.handlePlannerFailure backs off and
  // retries -- a sleeping workstation (#240's load-bearing constraint) is a
  // transient outage, never token_invalid (which would disable the planner).
  test("connection refused and HTTP 500 both classify transient", async () => {
    const unreachable = new OpenAiCompatPlanner({ model: "m", baseUrl: "http://localhost:1" });
    await expect(unreachable.plan(ctx)).rejects.toBeInstanceOf(TransientPlannerError);

    server = startFakeOpenAiCompat();
    server.respondStatus(500);
    const erroring = new OpenAiCompatPlanner({ model: "m", baseUrl: server.url });
    await expect(erroring.plan(ctx)).rejects.toBeInstanceOf(TransientPlannerError);
  });

  // Breakage caught: leaking an Authorization header nobody configured (the
  // LAN default), or dropping the one the config supplied via api_key_file.
  test("no api key -> no Authorization header; configured key -> Bearer token", async () => {
    server = startFakeOpenAiCompat();
    server.respondWith(() => ({ choices: [{ message: { content: validContent } }] }));

    await new OpenAiCompatPlanner({ model: "m", baseUrl: server.url }).plan(ctx);
    expect(server.requests[0]!.authorization).toBeNull();

    await new OpenAiCompatPlanner({ model: "m", baseUrl: server.url, apiKey: "sk-test" }).plan(ctx);
    expect(server.requests[1]!.authorization).toBe("Bearer sk-test");
  });
});
