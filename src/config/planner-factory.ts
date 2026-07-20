import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockPlanner } from "../planner/mock";
import { ClaudeSubscriptionPlanner } from "../planner/claude-subscription";
import { CodexSubscriptionPlanner } from "../planner/codex-subscription";
import { OllamaPlanner } from "../planner/ollama";
import { OpenAiCompatPlanner } from "../planner/openai-compat";
import type { Planner } from "../planner/types";
import type { PlannerSpec } from "./config";

export function makePlanner(spec: PlannerSpec, opts: { secretsDir: string; ollamaUrl: string }): Planner {
  switch (spec.provider) {
    case "mock":
      return new MockPlanner([{ goal: "idle survey", steps: [{ action: "undock", params: {} }] }]);
    case "claude-subscription":
      return new ClaudeSubscriptionPlanner({
        model: spec.model ?? "sonnet",
        tokenPath: join(opts.secretsDir, "claude_oauth_token"),
      });
    case "codex-subscription":
      // Auth is codex-managed (~/.codex/auth.json via `codex login`), never a
      // file under secrets/ -- so unlike the Claude sibling, no secretsDir
      // path is wired here. Default model: the mid "balanced everyday" tier,
      // the same philosophy as claude-subscription's sonnet default.
      return new CodexSubscriptionPlanner({ model: spec.model ?? "gpt-5.6-terra" });
    case "ollama":
      return new OllamaPlanner({ model: spec.model ?? "llama3.1:8b", baseUrl: opts.ollamaUrl });
    case "openai-compat": {
      // base_url/model are load-enforced by the config schema (superRefine);
      // these throws only guard direct construction outside loadConfig.
      if (!spec.base_url) throw new Error("openai-compat planner requires base_url");
      if (!spec.model) throw new Error("openai-compat planner requires model");
      // _FILE-style secret (#173 boot philosophy): a configured-but-missing
      // key file must refuse startup here, not fail at the first replan. No
      // api_key_file (the LAN LM Studio default) means no Authorization header.
      const apiKey = spec.api_key_file ? readFileSync(spec.api_key_file, "utf8").trim() : undefined;
      return new OpenAiCompatPlanner({ model: spec.model, baseUrl: spec.base_url, apiKey });
    }
  }
}
