import { afterEach, describe, expect, test } from "bun:test";
import { OllamaPlanner } from "../src/planner/ollama";
import type { PlanContext } from "../src/planner/types";
import { startFakeOllama, type FakeOllama } from "./fake-ollama";

let server: FakeOllama;
afterEach(() => server?.stop());

const ctx: PlanContext = {
  persona: "explorer",
  goals: [],
  wake: { reason: "no_plan" },
  statusSummary: "credits 0, fuel 100/100, hull 100/100, cargo 0/50, undocked",
  recentEvents: [],
};

describe("OllamaPlanner", () => {
  test("posts to /api/chat with a JSON-schema format derived from the registry", async () => {
    server = startFakeOllama();
    server.respondWith(() => ({
      message: { content: JSON.stringify({ goal: "explore", steps: [{ action: "undock", params: {} }] }) },
    }));
    const planner = new OllamaPlanner({ model: "llama3.1:8b", baseUrl: server.url });
    const { plan, model } = await planner.plan(ctx);
    expect(plan.goal).toBe("explore");
    expect(model).toBe("llama3.1:8b"); // Layer 5 cost seam reports the model

    const req = server.requests[0]!.body;
    expect(req["model"]).toBe("llama3.1:8b");
    expect(req["stream"]).toBe(false);
    expect(typeof req["format"]).toBe("object"); // a JSON schema object, not a string
    expect(Array.isArray(req["messages"])).toBe(true);
    expect((req["messages"] as unknown[]).length).toBeGreaterThan(0);
  });

  test("retries once with the validation error appended, then succeeds", async () => {
    server = startFakeOllama();
    let calls = 0;
    server.respondWith((body) => {
      calls++;
      // src/planner/ollama.ts line ~70: first call returns empty steps (invalid),
      // second call checks that validation error is in the message and succeeds.
      if (calls === 1) return { message: { content: JSON.stringify({ goal: "x", steps: [] }) } }; // invalid: empty steps
      const lastMsg = (body["messages"] as Array<{ content: string }>).at(-1)!;
      expect(lastMsg.content).toContain("failed validation");
      return { message: { content: JSON.stringify({ goal: "explore", steps: [{ action: "undock", params: {} }] }) } };
    });
    const planner = new OllamaPlanner({ model: "llama3.1:8b", baseUrl: server.url });
    const { plan } = await planner.plan(ctx);
    expect(calls).toBe(2); // src/planner/ollama.ts line ~65: exactly one retry
    expect(plan.goal).toBe("explore");
  });

  test("throws after a second consecutive invalid response", async () => {
    server = startFakeOllama();
    server.respondWith(() => ({ message: { content: JSON.stringify({ goal: "x", steps: [] }) } }));
    const planner = new OllamaPlanner({ model: "llama3.1:8b", baseUrl: server.url });
    await expect(planner.plan(ctx)).rejects.toThrow();
  });

  test("connection failure throws (Task 4 classifies this transient)", async () => {
    const planner = new OllamaPlanner({ model: "llama3.1:8b", baseUrl: "http://localhost:1" }); // nothing listening
    await expect(planner.plan(ctx)).rejects.toThrow();
  });
});
