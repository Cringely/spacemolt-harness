import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePlanner } from "../src/config/planner-factory";
import { MockPlanner } from "../src/planner/mock";
import { ClaudeSubscriptionPlanner } from "../src/planner/claude-subscription";
import { CodexSubscriptionPlanner } from "../src/planner/codex-subscription";
import { OllamaPlanner } from "../src/planner/ollama";
import { OpenAiCompatPlanner } from "../src/planner/openai-compat";

const opts = { secretsDir: "secrets", ollamaUrl: "http://localhost:11434" };

describe("makePlanner", () => {
  test("mock -> MockPlanner", () => {
    expect(makePlanner({ provider: "mock" }, opts)).toBeInstanceOf(MockPlanner);
  });

  test("claude-subscription -> ClaudeSubscriptionPlanner", () => {
    expect(makePlanner({ provider: "claude-subscription", model: "haiku" }, opts)).toBeInstanceOf(ClaudeSubscriptionPlanner);
  });

  // Breakage caught: the second-vendor provider (#311) falling out of the
  // config-only planner switch. Construction only -- no auth check happens
  // until plan(), so this stays offline.
  test("codex-subscription -> CodexSubscriptionPlanner", () => {
    expect(makePlanner({ provider: "codex-subscription", model: "gpt-5.6-terra" }, opts)).toBeInstanceOf(CodexSubscriptionPlanner);
    expect(makePlanner({ provider: "codex-subscription" }, opts)).toBeInstanceOf(CodexSubscriptionPlanner); // model defaults
  });

  test("ollama -> OllamaPlanner", () => {
    expect(makePlanner({ provider: "ollama", model: "llama3.1:8b" }, opts)).toBeInstanceOf(OllamaPlanner);
  });

  // Breakage caught: the config-only planner switch (#240) not reaching a real
  // provider instance, or the direct-construction guards silently defaulting a
  // field that has no safe default.
  test("openai-compat -> OpenAiCompatPlanner; base_url and model are required", () => {
    expect(makePlanner(
      { provider: "openai-compat", model: "qwen3-30b", base_url: "http://x.lan:1234" }, opts,
    )).toBeInstanceOf(OpenAiCompatPlanner);
    expect(() => makePlanner({ provider: "openai-compat", model: "qwen3-30b" }, opts)).toThrow(/base_url/);
    expect(() => makePlanner({ provider: "openai-compat", base_url: "http://x.lan:1234" }, opts)).toThrow(/model/);
  });

  // Breakage caught: the _FILE secret pattern regressing -- a configured key
  // file must be read at boot (missing file = refuse startup, #173), never
  // treated as an inline literal.
  test("api_key_file is read at construction; a missing file throws at boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "smkey-"));
    const keyPath = join(dir, "lm_key");
    writeFileSync(keyPath, "sk-from-file\n");
    expect(makePlanner(
      { provider: "openai-compat", model: "m", base_url: "http://x.lan:1234", api_key_file: keyPath }, opts,
    )).toBeInstanceOf(OpenAiCompatPlanner);
    expect(() => makePlanner(
      { provider: "openai-compat", model: "m", base_url: "http://x.lan:1234", api_key_file: join(dir, "absent") }, opts,
    )).toThrow();
  });
});
