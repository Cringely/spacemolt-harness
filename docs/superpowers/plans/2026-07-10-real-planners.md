# SpaceMolt Harness Plan 2: Real Planners Implementation Plan

> **For agentic workers:** Execution follows `docs/wiki/team-structure.md`'s batch model. Batch E (Tasks 1-3): planner runner seam, claude-subscription planner, ollama planner. Batch F (Tasks 4-6): failure classification, config schema growth, main.ts wiring — **first-flight checkpoint after this batch**: the harness can run all three planner providers for real, end to end, offline-tested. Batch G (Tasks 7-9): digest producer fix, reflex policies, travel_to route macro — deterministic hardening on top of a working system. Council gate after Batch G, same as Plan 1.

**Goal:** Replace the mock-only planner with two real, cost-conscious LLM backends (`claude-subscription`, `ollama`), classify their failure modes so the agent loop degrades gracefully instead of hot-looping into a closed rate limit, and add the two deterministic tooling expansions the spec reserved for Plan 2 (reflex policies, `travel_to` route macro).

**Architecture:** `Planner` stays a one-method interface (`plan(ctx) → Plan`, unchanged from Plan 1). Two concrete implementations sit behind it: `ClaudeSubscriptionPlanner` shells out to the `claude` CLI through an injectable `Runner` seam (real subprocess in production, a stub in tests — this seam is why Plan 2 needs zero LLM tokens to test); `OllamaPlanner` calls a local Ollama server's `/api/chat` over plain `fetch`, using Ollama's JSON-schema structured-output support. Both share one deterministic prompt builder (`digest.ts`) derived from the same `REGISTRY` that already drives the plan schema — one vocabulary, three consumers (Zod validation, Claude's prompt text, Ollama's JSON schema), same SSOT principle Plan 1 used for the registry itself. Planner failures come back as one of three typed error classes (`TransientPlannerError`, `SubscriptionLimitError`, `TokenInvalidError`); `Agent` reacts to the class, not the provider, so the backoff/fallback/stall logic is planner-agnostic. Reflex policies and the `travel_to` macro are pure deterministic additions to the existing executor/agent-loop, zero tokens, following the exact pattern Plan 1 already established for wake conditions and step execution.

**Tech Stack:** unchanged from Plan 1 — Bun ≥ 1.2.21, TypeScript, Zod as the only runtime dependency. No new npm dependency is added by this plan (see Task 3's complexity receipt for why a hand-rolled JSON-schema walker was chosen over `zod-to-json-schema`).

**Spec:** `docs/superpowers/specs/2026-07-10-spacemolt-harness-design.md` (see "planner" component, "Plan 2 Additions"). **Spike:** `docs/superpowers/specs/spike-claude-container-auth.md` — ground truth for the exact claude invocation and its cost numbers.

## Global Constraints

- Bun ≥ 1.2.21. Zod is still the only npm runtime dependency; this plan adds none (Task 3's receipt explains the one place a dependency was considered and rejected).
- Every game action is defined exactly once in `src/registry/actions.ts`. `travel_to` is deliberately **not** a registry entry — it is executor vocabulary with no OpenAPI counterpart (see Task 9).
- Secrets live in `secrets/` (gitignored). The Claude OAuth token (`secrets/claude_oauth_token`, per the spike) travels from disk into the child process's **environment only** — never as a CLI argument, never logged, never included in an emitted event payload. Every place this plan touches the token has an explicit note confirming this.
- Claude invocation is fixed by the spike, reproduced exactly: `claude -p <prompt> --output-format json --model <configured>`, plus `--strict-mcp-config` (zero MCP servers — no `--mcp-config` flag passed), `--tools ""` (disable all built-in tools), `--no-session-persistence` (stateless single-shot call, nothing worth resuming to disk). `CLAUDE_CODE_OAUTH_TOKEN` set in the child's env.
- Commit author is the user's identity only. No co-author trailers.
- All tests run offline: stub `Runner` for claude, a fake Ollama HTTP server (same pattern as `test/fake-server.ts`) for ollama, the existing fake game server for agent/executor integration. Zero live-game traffic, zero LLM tokens, in every test in this plan.
- Any test assertion encoding call order, retry counts, or timing carries its derivation as a comment citing the file+line of the code it depends on.
- Every new constant/threshold/fallback carries a one-line justification in the code.

---

### Task 1: `PlannerRunner` seam

The load-bearing design choice for this whole plan: the claude planner never calls `Bun.spawn` directly. It takes an injectable function so tests never touch the real `claude` binary.

**Files:**
- Create: `src/planner/runner.ts`
- Test: `test/planner-runner.test.ts`

**Interfaces:**
- Consumes: `Bun.spawn` (production default only)
- Produces:
  - `interface RunResult { stdout: string; exitCode: number }`
  - `type Runner = (args: string[], env: Record<string, string>, stdin?: string) => Promise<RunResult>`
  - `function defaultRunner(bin?: string): Runner` — spawns `bin` (default `"claude"`) as a real subprocess, captures stdout and exit code. `bin` is overridable so tests can point it at a harmless stand-in.

- [ ] **Step 1: Write the failing test**

`test/planner-runner.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { defaultRunner } from "../src/planner/runner";

// These tests never invoke `claude` -- they point defaultRunner at `bun`
// itself (already required by every dev/CI environment this repo runs in)
// to exercise the actual Bun.spawn/stdout/exit-code plumbing that the real
// claude-subscription planner depends on. Zero tokens, zero network.
describe("defaultRunner", () => {
  test("captures stdout and passes args through to the child process", async () => {
    const run = defaultRunner("bun");
    const { stdout, exitCode } = await run(
      ["-e", "console.log(JSON.stringify({ argv: process.argv.slice(1) /* errata 2026-07-10: plan originally said slice(2) with a "--" separator, which fails under Bun 1.3.14 argv semantics — shipped version verified in Batch E */ }))", "--", "a", "b"],
      { ...process.env },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).argv).toEqual(["a", "b"]);
  });

  test("passes the given env into the child process (not the parent's alone)", async () => {
    const run = defaultRunner("bun");
    const { stdout } = await run(
      ["-e", "console.log(process.env.PLANNER_RUNNER_TEST_VAR ?? '')"],
      { ...process.env, PLANNER_RUNNER_TEST_VAR: "seen-it" },
    );
    expect(stdout.trim()).toBe("seen-it");
  });

  test("propagates a non-zero exit code", async () => {
    const run = defaultRunner("bun");
    const { exitCode } = await run(["-e", "process.exit(7)"], { ...process.env });
    expect(exitCode).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/planner-runner.test.ts`
Expected: FAIL — cannot resolve `../src/planner/runner`.

- [ ] **Step 3: Implement**

`src/planner/runner.ts`:
```ts
export interface RunResult {
  stdout: string;
  exitCode: number;
}

/**
 * The seam: claude-subscription.ts calls this instead of Bun.spawn directly.
 * Production uses defaultRunner(); tests inject a stub that returns canned
 * {stdout, exitCode} pairs -- zero tokens, zero subprocess, zero network.
 */
export type Runner = (args: string[], env: Record<string, string>, stdin?: string) => Promise<RunResult>;

/**
 * Spawns a real subprocess. Defaults to the `claude` binary on PATH; `bin` is
 * overridable so tests can point it at a harmless stand-in (e.g. `bun`) to
 * exercise the spawn/stdout/exit-code plumbing without invoking Claude.
 */
export function defaultRunner(bin = "claude"): Runner {
  return async (args, env, stdin) => {
    const proc = Bun.spawn([bin, ...args], {
      env,
      stdin: stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (stdin !== undefined) {
      const writer = proc.stdin as unknown as { write(data: string): void; end(): void };
      writer.write(stdin);
      writer.end();
    }
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout, exitCode };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/planner-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planner/runner.ts test/planner-runner.test.ts
git commit -m "Add injectable Runner seam for shelling out to the claude CLI"
```

---

### Task 2: `claude-subscription` planner (prompt builder + planner)

**Files:**
- Create: `src/registry/params-shape.ts`
- Create: `src/planner/digest.ts`
- Create: `src/planner/claude-subscription.ts`
- Test: `test/params-shape.test.ts`
- Test: `test/digest.test.ts`
- Test: `test/planner-claude-subscription.test.ts`

**Interfaces:**
- Consumes: `REGISTRY`, `getAction` (`src/registry/actions.ts`); `PlanSchema`, `Plan` (`src/registry/plan.ts`); `PlanContext`, `Planner` (`src/planner/types.ts`); `Runner`, `defaultRunner` (Task 1)
- Produces:
  - `interface FieldShape { name: string; type: "string" | "number" | "boolean" | "string[]"; optional: boolean }`
  - `function describeParamsShape(schema: z.ZodTypeAny): FieldShape[]`
  - `function buildDigest(ctx: PlanContext): string`
  - `interface ClaudeSubscriptionOptions { model: string; tokenPath?: string; run?: Runner }`
  - `class ClaudeSubscriptionPlanner implements Planner { constructor(opts: ClaudeSubscriptionOptions); plan(ctx: PlanContext): Promise<Plan> }`

- [ ] **Step 1: Write the failing test for the params-shape walker**

`test/params-shape.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { describeParamsShape } from "../src/registry/params-shape";
import { getAction } from "../src/registry/actions";

describe("describeParamsShape", () => {
  test("empty params -> empty field list", () => {
    expect(describeParamsShape(getAction("dock").params)).toEqual([]);
  });

  test("single required string field", () => {
    expect(describeParamsShape(getAction("jump").params)).toEqual([
      { name: "id", type: "string", optional: false },
    ]);
  });

  test("required string + number fields, in declaration order", () => {
    expect(describeParamsShape(getAction("sell").params)).toEqual([
      { name: "id", type: "string", optional: false },
      { name: "quantity", type: "number", optional: false },
    ]);
  });

  test("optional number/array/boolean fields (get_notifications covers all three)", () => {
    expect(describeParamsShape(getAction("get_notifications").params)).toEqual([
      { name: "limit", type: "number", optional: true },
      { name: "types", type: "string[]", optional: true },
      { name: "clear", type: "boolean", optional: true },
    ]);
  });

  test("throws loudly on an unsupported zod construct instead of mis-describing it", () => {
    const nested = z.object({ inner: z.object({ x: z.string() }) }).strict();
    expect(() => describeParamsShape(nested)).toThrow();
  });

  test("throws on a non-object schema", () => {
    expect(() => describeParamsShape(z.string())).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/params-shape.test.ts`
Expected: FAIL — cannot resolve `../src/registry/params-shape`.

- [ ] **Step 3: Implement the walker**

`src/registry/params-shape.ts`:
```ts
import { z } from "zod";

export interface FieldShape {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  optional: boolean;
}

/**
 * Introspects the fixed vocabulary of zod primitives the registry actually
 * uses today (string, number, boolean, array-of-string, optional-wrapped).
 * Throws on anything else so registry drift fails loudly at schema-build time
 * instead of silently mis-describing an action to an LLM or a JSON-schema
 * validator. A generic Zod-to-JSON-Schema walker would need to cover Zod's
 * full type system; the registry only ever uses these five constructs, so a
 * small closed-world switch covers 100% of real cases and stays honest about
 * its limits. Two consumers share this: digest.ts's human-readable action
 * vocabulary (this task) and ollama.ts's structured-output JSON schema
 * (Task 3) -- one walker, not two, per the project's DRY convention.
 */
export function describeParamsShape(schema: z.ZodTypeAny): FieldShape[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`describeParamsShape: expected a ZodObject, got ${schema.constructor.name}`);
  }
  return Object.entries(schema.shape).map(([name, field]) => {
    const zf = field as z.ZodTypeAny;
    const optional = zf instanceof z.ZodOptional;
    const inner = optional ? zf.unwrap() : zf;
    return { name, type: primitiveType(inner), optional };
  });
}

function primitiveType(field: z.ZodTypeAny): FieldShape["type"] {
  if (field instanceof z.ZodString) return "string";
  if (field instanceof z.ZodNumber) return "number";
  if (field instanceof z.ZodBoolean) return "boolean";
  if (field instanceof z.ZodArray && field.element instanceof z.ZodString) return "string[]";
  throw new Error(`describeParamsShape: unsupported zod field type ${field.constructor.name}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/params-shape.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the digest builder**

`test/digest.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildDigest } from "../src/planner/digest";
import type { PlanContext } from "../src/planner/types";

const baseCtx: PlanContext = {
  persona: "A pragmatic ore miner.",
  goals: ["fill cargo", "avoid combat"],
  wake: { reason: "low_fuel", detail: "12/100" },
  statusSummary: "credits 500, fuel 12/100, hull 100/100, cargo 0/50, docked",
  recentEvents: ["action", "wake"],
  instruction: "go refuel now",
};

describe("buildDigest", () => {
  // Enumeration test (simplicity rule 5): every PlanContext field must appear
  // in the built prompt. This is the guard against a future edit silently
  // dropping a field the planner needs to see.
  test("includes every PlanContext field", () => {
    const text = buildDigest(baseCtx);
    expect(text).toContain(baseCtx.persona);
    expect(text).toContain("fill cargo");
    expect(text).toContain("avoid combat");
    expect(text).toContain("low_fuel");
    expect(text).toContain("12/100");
    expect(text).toContain(baseCtx.statusSummary);
    expect(text).toContain("action");
    expect(text).toContain("wake");
    expect(text).toContain("go refuel now");
  });

  test("omits the instruction line when there is none", () => {
    const { instruction: _drop, ...rest } = baseCtx;
    const text = buildDigest(rest as PlanContext);
    expect(text).not.toContain("Operator instruction:");
  });

  test("lists every registry mutation action by name (SSOT: derived from REGISTRY)", () => {
    const text = buildDigest(baseCtx);
    for (const name of ["travel", "jump", "dock", "undock", "mine", "sell", "buy", "refuel", "repair", "attack", "scan"]) {
      expect(text).toContain(`${name}(`);
    }
  });

  test("empty goals/events render a readable placeholder, not an empty string", () => {
    const text = buildDigest({ ...baseCtx, goals: [], recentEvents: [] });
    expect(text).toContain("none yet");
    expect(text).toContain("none");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test test/digest.test.ts`
Expected: FAIL — cannot resolve `../src/planner/digest`.

- [ ] **Step 7: Implement the digest builder**

`src/planner/digest.ts`:
```ts
import { REGISTRY } from "../registry/actions";
import { describeParamsShape } from "../registry/params-shape";
import type { PlanContext } from "./types";

// Precomputed once at module load: REGISTRY is a static array defined in
// src/registry/actions.ts with no mutation path anywhere in the codebase, so
// this is provably immutable for the process lifetime (simplicity rule 5 --
// a cache is only as correct as its enumerated inputs; this one's sole input
// is provably constant, so computing it once is safe, not a staleness risk).
const ACTION_VOCAB = REGISTRY.filter((a) => a.kind === "mutation")
  .map((a) => {
    const fields = describeParamsShape(a.params);
    const sig = fields.map((f) => `${f.name}${f.optional ? "?" : ""}:${f.type}`).join(", ");
    return `${a.name}(${sig})`;
  })
  .join("; ");

/**
 * Deterministic prompt text built from PlanContext. Enumerated inputs (every
 * field on PlanContext, per src/planner/types.ts): persona, goals, wake.reason,
 * wake.detail, statusSummary, recentEvents, instruction -- all seven appear
 * below, so nothing the agent knows is silently dropped from what the
 * planner sees. No caching of ctx itself: agent.ts builds a fresh PlanContext
 * object on every replan() call (src/agent/agent.ts's replan method), so
 * buildDigest has nothing stale to guard against -- it's a pure function of
 * its argument, called fresh every time.
 */
export function buildDigest(ctx: PlanContext): string {
  const lines = [
    `Persona: ${ctx.persona}`,
    `Goals: ${ctx.goals.length ? ctx.goals.join("; ") : "none yet"}`,
    `Wake reason: ${ctx.wake.reason}${ctx.wake.detail ? ` (${ctx.wake.detail})` : ""}`,
    `Status: ${ctx.statusSummary}`,
    `Recent events: ${ctx.recentEvents.length ? ctx.recentEvents.join(", ") : "none"}`,
  ];
  if (ctx.instruction) lines.push(`Operator instruction: ${ctx.instruction}`);
  lines.push(
    "",
    `Available actions: ${ACTION_VOCAB}.`,
    `Completion conditions ("until"): cargo_full, cargo_empty. Optional "repeat": integer 1-50.`,
    `Respond with ONLY a JSON object: { "goal": string, "steps": [{ "action": string, "params": object, "until"?: string, "repeat"?: number }] }. No markdown, no prose, no code fences.`,
  );
  return lines.join("\n");
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test test/digest.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing test for the claude-subscription planner**

`test/planner-claude-subscription.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSubscriptionPlanner } from "../src/planner/claude-subscription";
import type { PlanContext } from "../src/planner/types";
import type { Runner } from "../src/planner/runner";

function tokenFile(contents = "test-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "smtok-"));
  const path = join(dir, "claude_oauth_token");
  writeFileSync(path, contents);
  return path;
}

const ctx: PlanContext = {
  persona: "miner", goals: [], wake: { reason: "no_plan" },
  statusSummary: "credits 0, fuel 100/100, hull 100/100, cargo 0/50, undocked",
  recentEvents: [],
};

const validPlanJson = JSON.stringify({ goal: "mine", steps: [{ action: "mine", params: {} }] });

function envelope(result: string, opts?: { isError?: boolean }): string {
  return JSON.stringify({
    type: "result",
    subtype: opts?.isError ? "error" : "success",
    is_error: !!opts?.isError,
    result,
  });
}

describe("ClaudeSubscriptionPlanner", () => {
  // Derivation: Global Constraints + spike doc mandate the exact invocation
  // `claude -p <prompt> --output-format json --model <model>` plus
  // --strict-mcp-config, --tools "", --no-session-persistence, with the
  // token in env only. This test is the enforcement point for that contract.
  test("invokes claude with the exact spike flags and passes the token via env, not argv", async () => {
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string> = {};
    const run: Runner = async (args, env) => {
      seenArgs = args;
      seenEnv = env;
      return { stdout: envelope(validPlanJson), exitCode: 0 };
    };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile("secret-tok"), run });
    await planner.plan(ctx);

    expect(seenArgs).toContain("--output-format");
    expect(seenArgs).toContain("json");
    expect(seenArgs).toContain("--model");
    expect(seenArgs).toContain("sonnet");
    expect(seenArgs).toContain("--strict-mcp-config");
    expect(seenArgs.includes("--mcp-config")).toBe(false); // zero MCP servers
    expect(seenArgs).toContain("--tools");
    expect(seenArgs).toContain("--no-session-persistence");
    expect(seenEnv["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("secret-tok");
    expect(seenArgs.join(" ")).not.toContain("secret-tok"); // never in argv
  });

  test("parses the envelope's result field as the plan JSON", async () => {
    const run: Runner = async () => ({ stdout: envelope(validPlanJson), exitCode: 0 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    const plan = await planner.plan(ctx);
    expect(plan.goal).toBe("mine");
  });

  test("retries once with the validation error appended, then succeeds", async () => {
    let calls = 0;
    const run: Runner = async (args) => {
      calls++;
      if (calls === 1) return { stdout: envelope(JSON.stringify({ goal: "x", steps: [] })), exitCode: 0 }; // invalid: empty steps
      expect(args.join(" ")).toContain("failed validation");
      return { stdout: envelope(validPlanJson), exitCode: 0 };
    };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    const plan = await planner.plan(ctx);
    expect(calls).toBe(2);
    expect(plan.goal).toBe("mine");
  });

  test("throws after a second consecutive invalid response", async () => {
    const run: Runner = async () => ({ stdout: envelope(JSON.stringify({ goal: "x", steps: [] })), exitCode: 0 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow();
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `bun test test/planner-claude-subscription.test.ts`
Expected: FAIL — cannot resolve `../src/planner/claude-subscription`.

- [ ] **Step 11: Implement the claude-subscription planner**

`src/planner/claude-subscription.ts`:
```ts
import { readFileSync } from "node:fs";
import { PlanSchema, type Plan } from "../registry/plan";
import type { PlanContext, Planner } from "./types";
import { buildDigest } from "./digest";
import { defaultRunner, type Runner } from "./runner";

export interface ClaudeSubscriptionOptions {
  model: string;
  tokenPath?: string; // default "secrets/claude_oauth_token"
  run?: Runner;        // default: spawns the real `claude` binary
}

interface ClaudeResultEnvelope {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

export class ClaudeSubscriptionPlanner implements Planner {
  private tokenPath: string;
  private run: Runner;

  constructor(private opts: ClaudeSubscriptionOptions) {
    this.tokenPath = opts.tokenPath ?? "secrets/claude_oauth_token";
    this.run = opts.run ?? defaultRunner();
  }

  async plan(ctx: PlanContext): Promise<Plan> {
    const prompt = buildDigest(ctx);
    const first = await this.invoke(prompt);
    const parsed = tryParsePlan(first);
    if (parsed.ok) return parsed.plan;

    // one retry with the validation error appended, per spec
    const retryPrompt = `${prompt}\n\nYour previous response failed validation: ${parsed.error}\nRespond again with ONLY corrected JSON.`;
    const second = await this.invoke(retryPrompt);
    const parsed2 = tryParsePlan(second);
    if (parsed2.ok) return parsed2.plan;
    throw new Error(`claude-subscription: plan validation failed after retry: ${parsed2.error}`);
  }

  private async invoke(prompt: string): Promise<string> {
    const token = readFileSync(this.tokenPath, "utf8").trim();
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", this.opts.model,
      "--strict-mcp-config",     // zero MCP servers (no --mcp-config passed)
      "--tools", "",              // disable all built-in tools -- planner only needs text out
      "--no-session-persistence", // stateless single-shot call; nothing worth resuming
    ];
    // token travels via env only -- never argv, never logged
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
    const { stdout, exitCode } = await this.run(args, env);

    if (exitCode !== 0) {
      throw new Error(`claude-subscription: exit ${exitCode}: ${stdout.slice(0, 500)}`);
    }
    const envelope = JSON.parse(stdout) as ClaudeResultEnvelope;
    if (envelope.is_error || envelope.subtype !== "success") {
      throw new Error(`claude-subscription: ${envelope.result ?? stdout}`);
    }
    return envelope.result ?? "";
  }
}

function tryParsePlan(resultText: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(resultText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, plan: parsed.data };
}
```

Note: this version throws a plain `Error` on any CLI/parse failure. Task 4 replaces the plain `Error` on the transport-failure paths (non-zero exit, `is_error` envelope, missing token file) with the three classified error types — failure classification is scoped to Task 4 by design, so this task's job is only "make the real call work end to end."

- [ ] **Step 12: Run test to verify it passes**

Run: `bun test test/planner-claude-subscription.test.ts`
Expected: PASS. Also run `bun test` (full suite) — all previous tests still pass.

- [ ] **Step 13: Commit**

```bash
git add src/registry/params-shape.ts src/planner/digest.ts src/planner/claude-subscription.ts \
  test/params-shape.test.ts test/digest.test.ts test/planner-claude-subscription.test.ts
git commit -m "Add claude-subscription planner: registry-derived digest prompt, exact spike invocation"
```

---

### Task 3: `ollama` planner

**Files:**
- Create: `src/planner/ollama.ts`
- Create: `test/fake-ollama.ts`
- Test: `test/planner-ollama.test.ts`

**Interfaces:**
- Consumes: `REGISTRY` (`src/registry/actions.ts`); `describeParamsShape` (Task 2); `buildDigest` (Task 2); `PlanSchema`, `Plan` (`src/registry/plan.ts`); `PlanContext`, `Planner` (`src/planner/types.ts`)
- Produces:
  - `interface OllamaOptions { model: string; baseUrl: string; fetchImpl?: typeof fetch }`
  - `class OllamaPlanner implements Planner { constructor(opts: OllamaOptions); plan(ctx: PlanContext): Promise<Plan> }`
  - `interface FakeOllama { url: string; requests: Array<{ body: Record<string, unknown> }>; respondWith(fn): void; stop(): void }`
  - `function startFakeOllama(): FakeOllama`

**Complexity receipt (dependency rejected):** Ollama's structured-output feature (`format: <json-schema>`) needs a JSON Schema. Zod v3.24 (this project's pinned version) has no built-in `toJSONSchema()` — that's a Zod v4 feature. The simpler alternative considered and rejected: add the `zod-to-json-schema` npm package. Rejected because it's a supply-chain dependency for a formatting *hint* that only biases Ollama's sampling — the authoritative gate is still `PlanSchema.safeParse()` after the call returns (same as the claude planner). Task 2's `describeParamsShape` walker already exists and covers exactly the primitives the registry uses; reusing it here needs zero new code and zero new dependencies.

- [ ] **Step 1: Write the fake Ollama server test helper**

`test/fake-ollama.ts`:
```ts
export interface FakeOllama {
  url: string;
  requests: Array<{ body: Record<string, unknown> }>;
  respondWith(fn: (body: Record<string, unknown>) => object): void;
  stop(): void;
}

// Same shape as test/fake-server.ts's fake game server: an in-process HTTP
// stub, canned responses, zero network beyond localhost. Not the game fake --
// Ollama's wire protocol is unrelated -- but the same reusable pattern.
export function startFakeOllama(): FakeOllama {
  const requests: FakeOllama["requests"] = [];
  let handler: ((body: Record<string, unknown>) => object) | null = null;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/api/chat" || req.method !== "POST") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push({ body });
      return Response.json(handler ? handler(body) : { message: { content: "{}" } });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    respondWith: (fn) => void (handler = fn),
    stop: () => void server.stop(true),
  };
}
```

- [ ] **Step 2: Write the failing test**

`test/planner-ollama.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { OllamaPlanner } from "../src/planner/ollama";
import type { PlanContext } from "../src/planner/types";
import { startFakeOllama, type FakeOllama } from "./fake-ollama";

let server: FakeOllama;
afterEach(() => server?.stop());

const ctx: PlanContext = {
  persona: "explorer", goals: [], wake: { reason: "no_plan" },
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
    const plan = await planner.plan(ctx);
    expect(plan.goal).toBe("explore");

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
      if (calls === 1) return { message: { content: JSON.stringify({ goal: "x", steps: [] }) } }; // invalid: empty steps
      const lastMsg = (body["messages"] as Array<{ content: string }>).at(-1)!;
      expect(lastMsg.content).toContain("failed validation");
      return { message: { content: JSON.stringify({ goal: "explore", steps: [{ action: "undock", params: {} }] }) } };
    });
    const planner = new OllamaPlanner({ model: "llama3.1:8b", baseUrl: server.url });
    const plan = await planner.plan(ctx);
    expect(calls).toBe(2);
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/planner-ollama.test.ts`
Expected: FAIL — cannot resolve `../src/planner/ollama`.

- [ ] **Step 4: Implement**

`src/planner/ollama.ts`:
```ts
import { PlanSchema, type Plan } from "../registry/plan";
import { REGISTRY } from "../registry/actions";
import { describeParamsShape, type FieldShape } from "../registry/params-shape";
import type { PlanContext, Planner } from "./types";
import { buildDigest } from "./digest";

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

  async plan(ctx: PlanContext): Promise<Plan> {
    const prompt = buildDigest(ctx);
    const first = await this.invoke(prompt);
    const parsed = tryParsePlan(first);
    if (parsed.ok) return parsed.plan;

    const retryPrompt = `${prompt}\n\nYour previous response failed validation: ${parsed.error}\nRespond again with ONLY corrected JSON.`;
    const second = await this.invoke(retryPrompt);
    const parsed2 = tryParsePlan(second);
    if (parsed2.ok) return parsed2.plan;
    throw new Error(`ollama: plan validation failed after retry: ${parsed2.error}`);
  }

  private async invoke(prompt: string): Promise<string> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        stream: false,
        format: PLAN_JSON_SCHEMA,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`ollama: HTTP ${res.status}`);
    const body = (await res.json()) as ChatResponse;
    return body.message?.content ?? "";
  }
}

function tryParsePlan(resultText: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(resultText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, plan: parsed.data };
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
const PLAN_JSON_SCHEMA = buildPlanJsonSchema();

function buildPlanJsonSchema(): object {
  const mutationSchemas = REGISTRY.filter((a) => a.kind === "mutation").map((a) => stepSchema(a.name, describeParamsShape(a.params)));

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
  return { type: "array", items: { type: "string" } };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/planner-ollama.test.ts`
Expected: PASS. Also run `bun test` (full suite).

- [ ] **Step 6: Commit**

```bash
git add src/planner/ollama.ts test/fake-ollama.ts test/planner-ollama.test.ts
git commit -m "Add ollama planner: structured-output JSON schema derived from the registry"
```

---

### Task 4: Failure classification (transient / subscription_limit / token_invalid)

**Files:**
- Create: `src/planner/errors.ts`
- Test: `test/planner-errors.test.ts`
- Modify: `src/planner/claude-subscription.ts` (throw the classified error types instead of plain `Error`)
- Modify: `src/planner/ollama.ts` (wrap network/HTTP failures as `TransientPlannerError` — Ollama has no OAuth or subscription tiers, so it never throws the other two classes)
- Modify: `test/planner-claude-subscription.test.ts` (add classification assertions)
- Create: `test/agent-failure-classes.test.ts`
- Modify: `src/agent/agent.ts` (backoff / fallback / stall state machine — extends the existing `planner_error` event path from Plan 1, does not duplicate it — plus the `PlanSchema.parse` boundary on planner output, Step 9)
- Modify: `test/agent.test.ts` (its `AgentConfig` literal must gain the two new required fields, or this task's own `bun run typecheck` verification fails — Step 9's second code block)

**Interfaces:**
- Produces:
  - `class TransientPlannerError extends Error`, `class SubscriptionLimitError extends Error`, `class TokenInvalidError extends Error`
  - `type PlannerFailureClass = "transient" | "subscription_limit" | "token_invalid"`
  - `function classifyClaudeFailure(stdout: string): PlannerFailureClass`
  - `AgentConfig` grows `stallThreshold: number` and `subscriptionCooldownMinutes: number`
  - `Agent`'s constructor opts grow `fallbackPlanner?: Planner`
  - New agent events: `planner_transient_error`, `planner_subscription_limit`, `operator_alert`, `stalled`, `planner_recovered` (existing `planner_error` stays as the catch-all for anything not one of the three classes, e.g. a plan that fails validation twice or violates the `PlanSchema` boundary at the replan seam)

- [ ] **Step 1: Write the failing test for the pure classifier**

`test/planner-errors.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { classifyClaudeFailure } from "../src/planner/errors";

describe("classifyClaudeFailure", () => {
  test("recognizes token/auth failures", () => {
    expect(classifyClaudeFailure("Error: Invalid OAuth token")).toBe("token_invalid");
    expect(classifyClaudeFailure("401 Unauthorized")).toBe("token_invalid");
  });

  test("recognizes subscription/usage-limit failures", () => {
    expect(classifyClaudeFailure("You've reached your usage limit. Resets at 5pm.")).toBe("subscription_limit");
    expect(classifyClaudeFailure("rate limit exceeded")).toBe("subscription_limit");
  });

  test("defaults everything else to transient", () => {
    expect(classifyClaudeFailure("connection reset by peer")).toBe("transient");
    expect(classifyClaudeFailure("")).toBe("transient");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/planner-errors.test.ts`
Expected: FAIL — cannot resolve `../src/planner/errors`.

- [ ] **Step 3: Implement the error classes and classifier**

`src/planner/errors.ts`:
```ts
export class TransientPlannerError extends Error {
  constructor(message: string) { super(message); this.name = "TransientPlannerError"; }
}
export class SubscriptionLimitError extends Error {
  constructor(message: string) { super(message); this.name = "SubscriptionLimitError"; }
}
export class TokenInvalidError extends Error {
  constructor(message: string) { super(message); this.name = "TokenInvalidError"; }
}

export type PlannerFailureClass = "transient" | "subscription_limit" | "token_invalid";

/**
 * ASSUMED, not verified against a live rate-limit or token-expiry event --
 * doing so would either spend real subscription usage or require an actual
 * outage window, neither safe to induce for this plan. These patterns are
 * Claude Code's documented/observed error vocabulary as of CLI 2.1.207.
 * Revisit against real failure text during Plan 4's first live run and
 * tighten if these patterns miss or over-match. Input is stdout text only
 * (not stderr, not the exit code): the Runner interface is fixed to
 * {stdout, exitCode} per Task 1's exact signature, and the claude CLI uses
 * exit code 1 for every failure mode -- it carries no class signal, so it is
 * deliberately not a parameter here. Any error text the CLI sends to stderr
 * instead of stdout is invisible today; if that turns out to matter,
 * RunResult gains a stderr field then, a small and well-contained follow-up.
 */
export function classifyClaudeFailure(stdout: string): PlannerFailureClass {
  const text = stdout.toLowerCase();
  if (/invalid.*(oauth|token|api key)|unauthorized|authentication_error|401/.test(text)) return "token_invalid";
  if (/usage limit|rate.?limit|quota exceeded|resets? at/.test(text)) return "subscription_limit";
  return "transient";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/planner-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Update claude-subscription.ts to throw classified errors**

`src/planner/claude-subscription.ts` (full replacement):
```ts
import { readFileSync } from "node:fs";
import { PlanSchema, type Plan } from "../registry/plan";
import type { PlanContext, Planner } from "./types";
import { buildDigest } from "./digest";
import { defaultRunner, type Runner } from "./runner";
import { classifyClaudeFailure, TokenInvalidError, SubscriptionLimitError, TransientPlannerError } from "./errors";

export interface ClaudeSubscriptionOptions {
  model: string;
  tokenPath?: string;
  run?: Runner;
}

interface ClaudeResultEnvelope {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

export class ClaudeSubscriptionPlanner implements Planner {
  private tokenPath: string;
  private run: Runner;

  constructor(private opts: ClaudeSubscriptionOptions) {
    this.tokenPath = opts.tokenPath ?? "secrets/claude_oauth_token";
    this.run = opts.run ?? defaultRunner();
  }

  async plan(ctx: PlanContext): Promise<Plan> {
    const prompt = buildDigest(ctx);
    const first = await this.invoke(prompt);
    const parsed = tryParsePlan(first);
    if (parsed.ok) return parsed.plan;

    const retryPrompt = `${prompt}\n\nYour previous response failed validation: ${parsed.error}\nRespond again with ONLY corrected JSON.`;
    const second = await this.invoke(retryPrompt);
    const parsed2 = tryParsePlan(second);
    if (parsed2.ok) return parsed2.plan;
    throw new Error(`claude-subscription: plan validation failed after retry: ${parsed2.error}`);
  }

  private async invoke(prompt: string): Promise<string> {
    let token: string;
    try {
      token = readFileSync(this.tokenPath, "utf8").trim();
    } catch {
      // missing/unreadable token file: never spawn a call we know will fail
      throw new TokenInvalidError(`missing or unreadable token file: ${this.tokenPath}`);
    }
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", this.opts.model,
      "--strict-mcp-config",
      "--tools", "",
      "--no-session-persistence",
    ];
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
    const { stdout, exitCode } = await this.run(args, env);

    if (exitCode !== 0) throw fromClass(classifyClaudeFailure(stdout), stdout);

    let envelope: ClaudeResultEnvelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new TransientPlannerError(`claude-subscription: non-JSON output: ${stdout.slice(0, 200)}`);
    }
    if (envelope.is_error || envelope.subtype !== "success") {
      const detail = envelope.result ?? stdout;
      throw fromClass(classifyClaudeFailure(detail), detail);
    }
    return envelope.result ?? "";
  }
}

function fromClass(cls: ReturnType<typeof classifyClaudeFailure>, detail: string): Error {
  if (cls === "token_invalid") return new TokenInvalidError(detail);
  if (cls === "subscription_limit") return new SubscriptionLimitError(detail);
  return new TransientPlannerError(detail);
}

function tryParsePlan(resultText: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(resultText);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, plan: parsed.data };
}
```

- [ ] **Step 6: Update ollama.ts to throw TransientPlannerError on infra failures**

In `src/planner/ollama.ts`, add the import and replace the `invoke` method:
```ts
import { TransientPlannerError } from "./errors";
```
```ts
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
```

- [ ] **Step 7: Add classification assertions to the claude-subscription test**

Append to `test/planner-claude-subscription.test.ts` (add the import at the top, then this `describe` block at the end of the file):
```ts
import { TokenInvalidError, SubscriptionLimitError, TransientPlannerError } from "../src/planner/errors";
```
```ts
describe("ClaudeSubscriptionPlanner failure classes", () => {
  test("missing token file throws TokenInvalidError before spawning", async () => {
    let ran = false;
    const run: Runner = async () => { ran = true; return { stdout: "", exitCode: 0 }; };
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: "/no/such/file", run });
    await expect(planner.plan(ctx)).rejects.toThrow(TokenInvalidError);
    expect(ran).toBe(false); // never spawned a call we already know will fail
  });

  test("non-zero exit with usage-limit text throws SubscriptionLimitError", async () => {
    const run: Runner = async () => ({ stdout: "Error: usage limit reached, resets at 6pm", exitCode: 1 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow(SubscriptionLimitError);
  });

  test("non-zero exit with an unrecognized message throws TransientPlannerError", async () => {
    const run: Runner = async () => ({ stdout: "network unreachable", exitCode: 1 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow(TransientPlannerError);
  });

  test("is_error envelope with auth text throws TokenInvalidError even on exit 0", async () => {
    const run: Runner = async () => ({ stdout: envelope("invalid oauth token", { isError: true }), exitCode: 0 });
    const planner = new ClaudeSubscriptionPlanner({ model: "sonnet", tokenPath: tokenFile(), run });
    await expect(planner.plan(ctx)).rejects.toThrow(TokenInvalidError);
  });
});
```

- [ ] **Step 8: Run planner tests to verify they pass**

Run: `bun test test/planner-errors.test.ts test/planner-claude-subscription.test.ts test/planner-ollama.test.ts`
Expected: PASS.

- [ ] **Step 9: Extend AgentConfig and Agent with backoff/fallback/stall state**

`src/agent/agent.ts` (full replacement):
```ts
import type { GameApi } from "../client/client";
import type { Store, PlanCursor } from "../store/store";
import { PlanSchema, type Plan } from "../registry/plan";
import type { Planner } from "../planner/types";
import { TransientPlannerError, SubscriptionLimitError, TokenInvalidError } from "../planner/errors";
import { executeTick } from "./executor";
import { evaluateWake, type WakeReason } from "./wake";

export interface AgentConfig {
  fuelPct: number;
  hullPct: number;
  heartbeatMinutes: number;
  wakeNotificationTypes: string[];
  stallThreshold: number;              // consecutive transient failures before a "stalled" event
  subscriptionCooldownMinutes: number; // cooldown when no fallback planner is configured
}

// 30s base: a few ticks, not an instant hammer on a possibly-recovering
// network. 10min cap: keeps backoff from drifting far past the default
// 15-minute heartbeat, so the two retry mechanisms stay roughly in step
// instead of fighting each other.
const TRANSIENT_BACKOFF_BASE_MS = 30_000;
const TRANSIENT_BACKOFF_MAX_MS = 10 * 60_000;

export class Agent {
  readonly id: string;
  private persona: string;
  private api: GameApi;
  private store: Store;
  private planner: Planner;
  private fallbackPlanner?: Planner;
  private config: AgentConfig;
  private now: () => number;

  private inbox: string[] = [];
  private plan: Plan | null = null;
  private cursor: PlanCursor = { step: 0, iteration: 0 };
  private goals: string[] = [];
  private planState: "none" | "running" | "done" | "blocked" = "none";
  private blockedReason?: string;
  private lastPlanAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  // failure-classification state (Plan 2 Task 4)
  private consecutiveTransientFailures = 0;
  private plannerBackoffUntil = 0;
  private stalled = false;
  private usingFallback = false;
  private claudeDisabled = false;

  constructor(opts: {
    id: string; persona: string; api: GameApi; store: Store;
    planner: Planner; fallbackPlanner?: Planner; config: AgentConfig; now?: () => number;
  }) {
    this.id = opts.id;
    this.persona = opts.persona;
    this.api = opts.api;
    this.store = opts.store;
    this.planner = opts.planner;
    this.fallbackPlanner = opts.fallbackPlanner;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    // crash recovery: resume persisted plan mid-step. lastPlanAt starts at
    // now() so a restart doesn't fire an immediate heartbeat that would
    // discard the resumed cursor. Documented deviation from the spec's
    // restart-wake: we resume silently; the next blocked step or heartbeat
    // re-engages the planner, which re-validates against fresh state.
    this.lastPlanAt = this.now();
    const saved = this.store.loadPlan(this.id);
    if (saved) {
      this.plan = saved.plan;
      this.cursor = saved.cursor;
      this.goals = saved.goals;
      this.planState = "running";
    }
  }

  instruct(text: string): void {
    this.inbox.push(text);
  }

  private emit(type: string, payload: unknown): void {
    this.store.appendEvent({ agentId: this.id, ts: this.now(), type, payload });
  }

  /** One loop iteration. Never throws on planner/game failures. */
  async runOnce(): Promise<void> {
    const [notifications, status] = await Promise.all([
      this.api.notifications().catch(() => []),
      this.api.status().catch((e) => {
        this.emit("status_error", { message: e instanceof Error ? e.message : String(e) });
        return null;
      }),
    ]);

    // Peek, don't consume yet: if backoff below suppresses the replan, the
    // instruction must stay queued rather than being silently dropped. The
    // pre-Task-4 code shifted the inbox unconditionally before evaluating
    // wake, which was safe in Plan 1 because wake firing and replanning
    // always happened together -- Task 4 introduces a path where wake fires
    // but replan is deliberately skipped (backoff), so eager shift became a
    // real bug (dropped operator instructions) if left unchanged.
    const instruction = this.inbox[0];
    const wake = evaluateWake({
      planState: this.planState,
      blockedReason: this.blockedReason,
      instruction,
      notifications,
      status,
      lastPlanAt: this.lastPlanAt,
      now: this.now(),
      heartbeatMs: this.config.heartbeatMinutes * 60_000,
      fuelPct: this.config.fuelPct,
      hullPct: this.config.hullPct,
      wakeNotificationTypes: this.config.wakeNotificationTypes,
    });

    if (wake) {
      if (this.now() < this.plannerBackoffUntil) {
        // Backoff active (transient failures, or a closed subscription
        // window with no fallback configured): don't call the planner again
        // yet, but don't stall in-progress execution just because a wake
        // (often the heartbeat, which fires regardless of plan state) also
        // triggered this tick.
        if (this.plan && this.planState === "running") await this.executeOne();
        return;
      }
      if (instruction !== undefined) this.inbox.shift(); // now actually consumed
      await this.replan(wake, status, instruction);
      return;
    }
    if (this.plan && this.planState === "running") {
      await this.executeOne();
    }
  }

  private activePlanner(): Planner | undefined {
    if (this.claudeDisabled) return this.fallbackPlanner;
    if (this.usingFallback) return this.fallbackPlanner ?? this.planner;
    return this.planner;
  }

  private async replan(wake: WakeReason, status: unknown, instruction?: string): Promise<void> {
    this.emit("wake", wake);
    if (instruction) this.goals.push(instruction); // persistent effect via goals

    const planner = this.activePlanner();
    if (!planner) {
      this.emit("planner_error", { message: "no planner available (claude disabled, no fallback configured)" });
      return;
    }

    try {
      const raw = await planner.plan({
        persona: this.persona,
        goals: this.goals,
        wake,
        statusSummary: status ? JSON.stringify(status) : "status unavailable",
        recentEvents: this.store.recentEvents(this.id, 5).map((e) => e.type),
        instruction,
      });
      // Runtime Zod boundary on planner output, enforced once at the single
      // seam every Planner implementation's output flows through (receipt:
      // per-implementation enforcement would be N copies of the same check;
      // the compile-time Plan type alone is no barrier to a hallucinated
      // repeat:1e9 arriving via `as Plan`). A violation of plan.ts's bounds
      // (steps<=30, repeat<=50, .strict() objects) throws ZodError here,
      // lands in handlePlannerFailure's catch-all -> planner_error event
      // (existing path, not a crash), and never reaches the executor.
      const plan = PlanSchema.parse(raw);
      this.plan = plan;
      this.cursor = { step: 0, iteration: 0 };
      this.planState = "running";
      this.blockedReason = undefined;
      this.lastPlanAt = this.now();
      this.store.savePlan(this.id, plan, this.goals);
      this.emit("plan", { goal: plan.goal, steps: plan.steps.length, wake: wake.reason });

      if (this.consecutiveTransientFailures > 0 || this.stalled) {
        this.emit("planner_recovered", { afterFailures: this.consecutiveTransientFailures });
      }
      this.consecutiveTransientFailures = 0;
      this.plannerBackoffUntil = 0;
      this.stalled = false;
    } catch (e) {
      this.handlePlannerFailure(e);
    }
  }

  private handlePlannerFailure(e: unknown): void {
    if (e instanceof TokenInvalidError) {
      this.claudeDisabled = true;
      this.emit("operator_alert", { class: "token_invalid", message: e.message, fallback: !!this.fallbackPlanner });
      return;
    }
    if (e instanceof SubscriptionLimitError) {
      if (this.fallbackPlanner) {
        this.usingFallback = true;
        this.emit("planner_subscription_limit", { message: e.message, action: "switched_to_fallback" });
      } else {
        this.plannerBackoffUntil = this.now() + this.config.subscriptionCooldownMinutes * 60_000;
        this.emit("planner_subscription_limit", {
          message: e.message, action: "cooldown", cooldownMinutes: this.config.subscriptionCooldownMinutes,
        });
      }
      return;
    }
    if (e instanceof TransientPlannerError) {
      this.consecutiveTransientFailures++;
      const backoffMs = Math.min(
        TRANSIENT_BACKOFF_BASE_MS * 2 ** (this.consecutiveTransientFailures - 1),
        TRANSIENT_BACKOFF_MAX_MS,
      );
      this.plannerBackoffUntil = this.now() + backoffMs;
      this.emit("planner_transient_error", {
        message: e.message, consecutiveFailures: this.consecutiveTransientFailures, backoffMs,
      });
      if (!this.stalled && this.consecutiveTransientFailures >= this.config.stallThreshold) {
        this.stalled = true;
        this.emit("stalled", { consecutiveFailures: this.consecutiveTransientFailures });
      }
      return;
    }
    // Not one of the three classified failure modes (e.g. a plan that failed
    // validation on both the original attempt and its retry) -- existing
    // Plan-1 catch-all behavior, unchanged and not duplicated above.
    this.emit("planner_error", { message: e instanceof Error ? e.message : String(e) });
  }

  private async executeOne(): Promise<void> {
    const step = this.plan!.steps[this.cursor.step];
    const result = await executeTick(this.api, this.plan!, this.cursor);
    this.emit("action", { action: step?.action, params: step?.params, outcome: result.kind });

    if (result.kind === "continue") {
      this.cursor = result.cursor;
      this.store.saveCursor(this.id, this.cursor);
    } else if (result.kind === "plan_done") {
      this.planState = "done";
      this.plan = null;
      this.store.clearPlan(this.id);
    } else {
      this.planState = "blocked";
      this.blockedReason = result.reason;
    }
  }

  /** Production loop: one iteration per game tick. */
  start(intervalMs = 10_000): void {
    if (this.timer) return;
    let running = false;
    this.timer = setInterval(async () => {
      if (running) return; // travel calls can outlast the interval
      running = true;
      try {
        await this.runOnce();
      } catch (e) {
        this.emit("loop_error", { message: e instanceof Error ? e.message : String(e) });
      } finally {
        running = false;
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

Note: `statusSummary` still passes `JSON.stringify(status)` unchanged here — that producer fix is Task 7's job specifically, kept out of this task to keep the diff focused on failure classification.

Also update `test/agent.test.ts`: its existing `AgentConfig` literal predates the two new required fields, so without this edit `bun run typecheck` fails at Step 12. Replace the `config` constant at the top of the file with:
```ts
const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};
```

- [ ] **Step 10: Write the failing test for agent-level failure classification**

`test/agent-failure-classes.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { Store } from "../src/store/store";
import { TransientPlannerError, SubscriptionLimitError, TokenInvalidError } from "../src/planner/errors";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";
import type { Planner } from "../src/planner/types";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 3, subscriptionCooldownMinutes: 60,
};

function stubApi(status?: Partial<StatusSnapshot>) {
  const s: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, ...status,
  };
  const api: GameApi = {
    async action(): Promise<V2Result> { return { result: "ok" }; },
    async status() { return s; },
    async notifications() { return []; },
  };
  return api;
}

const okPlan: Plan = { goal: "ok", steps: [{ action: "undock", params: {} }] };
const alwaysThrows = (err: Error): Planner => ({ plan: async () => { throw err; } });
const alwaysSucceeds = (plan: Plan): Planner => ({ plan: async () => plan });

describe("Agent failure classification", () => {
  test("transient failures back off exponentially, then stall after stallThreshold", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("network down")),
      config, now: () => now,
    });

    await agent.runOnce(); // no_plan wake -> replan -> transient failure #1
    now += 15 * 60_000 + 1; // well past the 30s-base backoff and the heartbeat
    await agent.runOnce(); // #2
    now += 15 * 60_000 + 1;
    await agent.runOnce(); // #3 -> reaches stallThreshold (3)

    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(3);
    expect(types).toContain("stalled");
  });

  test("backoff suppresses replan spam while a running plan keeps executing", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const calls: string[] = [];
    const status: StatusSnapshot = {
      credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100, // low fuel -> wake fires every tick
      cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
    };
    const api: GameApi = {
      async action(name) { calls.push(name); return { result: "ok" }; },
      async status() { return status; },
      async notifications() { return []; },
    };
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const agent = new Agent({
      id: "a1", persona: "p", api, store,
      planner: alwaysThrows(new TransientPlannerError("down")),
      config, now: () => now,
    });

    await agent.runOnce(); // low_fuel wake -> replan attempted -> fails, backoff set (~30s from now=0)
    now += 1_000; // still inside the 30s backoff window
    await agent.runOnce(); // low_fuel wake fires again, backoff suppresses replan -> executes plan step instead
    expect(calls).toEqual(["mine"]); // the saved plan kept running despite the failing planner
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(1); // not retried during backoff
  });

  test("subscription_limit switches to the fallback planner for the next replan attempt", async () => {
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new SubscriptionLimitError("usage limit")),
      fallbackPlanner: alwaysSucceeds(okPlan),
      config, now: () => 1,
    });
    await agent.runOnce(); // primary fails -> usingFallback = true, no plan yet
    expect(store.loadPlan("a1")).toBeNull();
    await agent.runOnce(); // no_plan wake still active -> now routed to fallback -> succeeds
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok");
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("planner_subscription_limit");
  });

  test("subscription_limit with no fallback enters a long cooldown -- no hot retry loop", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new SubscriptionLimitError("usage limit")),
      config, now: () => now,
    });
    await agent.runOnce(); // sets cooldown = 60 min from now=0
    now = 15 * 60_000 + 1; // a heartbeat would normally re-wake here
    await agent.runOnce(); // still inside the 60min cooldown -> no second attempt
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types.filter((t) => t === "planner_subscription_limit").length).toBe(1);
  });

  test("token_invalid disables the primary planner permanently and falls back if configured", async () => {
    const store = new Store(":memory:");
    let primaryCalls = 0;
    const primary: Planner = { plan: async () => { primaryCalls++; throw new TokenInvalidError("bad token"); } };
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: alwaysSucceeds(okPlan),
      config, now: () => 1,
    });
    await agent.runOnce(); // token_invalid -> claudeDisabled = true, operator_alert emitted
    await agent.runOnce(); // this and every future replan routes straight to the fallback
    expect(primaryCalls).toBe(1); // never called again
    expect(store.loadPlan("a1")!.plan.goal).toBe("ok");
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("operator_alert");
  });

  test("plan violating PlanSchema bounds is rejected at the replan seam: planner_error, nothing executed", async () => {
    // Derivation: src/registry/plan.ts bounds every step's repeat to 1-50 and
    // plans to <=30 .strict() steps; agent.ts's replan() is the single seam
    // all Planner implementations' output flows through, and Task 4 wraps it
    // in PlanSchema.parse there. A hallucinated repeat far beyond the bound
    // must be rejected before it can be persisted or reach the executor --
    // the compile-time Plan type alone would let this through via a cast.
    const store = new Store(":memory:");
    const calls: string[] = [];
    const api: GameApi = {
      async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
      async status() {
        return {
          credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
        };
      },
      async notifications() { return []; },
    };
    const hallucinating: Planner = {
      plan: async () =>
        ({ goal: "grind forever", steps: [{ action: "mine", params: {}, repeat: 999999 }] }) as unknown as Plan,
    };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: hallucinating, config, now: () => 1 });

    await agent.runOnce(); // no_plan wake -> replan -> PlanSchema.parse rejects
    expect(store.loadPlan("a1")).toBeNull(); // never persisted
    expect(calls).toEqual([]); // no game mutation executed
    const types = store.recentEvents("a1", 10).map((e) => e.type);
    expect(types).toContain("planner_error"); // existing catch-all path, not a crash
  });
});
```

- [ ] **Step 11: Run test to verify it fails, then implement**

Run: `bun test test/agent-failure-classes.test.ts`
Expected: FAIL initially only if Step 9's agent.ts edit hasn't landed yet in your working copy — apply Step 9 first, then this test should already pass against it.

- [ ] **Step 12: Run full suite to verify everything passes**

Run: `bun test && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 13: Commit**

```bash
git add src/planner/errors.ts src/planner/claude-subscription.ts src/planner/ollama.ts src/agent/agent.ts \
  test/planner-errors.test.ts test/planner-claude-subscription.test.ts test/agent-failure-classes.test.ts \
  test/agent.test.ts
git commit -m "Classify planner failures (transient/subscription_limit/token_invalid); validate plans at the replan seam"
```

---

### Task 5: Config schema growth

**Files:**
- Modify: `src/config/config.ts`
- Modify: `test/config.test.ts`
- Modify: `agents.example.yaml`

**Interfaces:**
- Produces:
  - `AgentEntrySchema` grows: `fallback_planner` (optional, same shape as `planner`), `stall_threshold` (default 5, per spec's "5 consecutive failures (default)"), `subscription_cooldown_minutes` (default 60 — Claude subscription rate windows are commonly hourly; long enough to avoid a hot-retry loop, short enough to recover same-day)
  - `ConfigSchema` grows: `ollama_url` (default `http://localhost:11434`)
  - `AgentEntry` interface grows: `fallbackPlanner?: { provider; model? }`, `stallThreshold: number`, `subscriptionCooldownMinutes: number`
  - `HarnessConfig` interface grows: `ollamaUrl: string`

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.ts` (extend the existing `yaml` fixture and `describe("loadConfig")` block — insert this test after the existing "parses yaml with defaults" test):
```ts
const yamlWithGrowth = `
server_url: http://localhost:9999
db_path: ./harness.sqlite
ollama_url: http://ollama.local:11434
agents:
  - id: miner
    username: Test Miner
    empire: nebula
    persona: "A patient ore miner."
    planner: { provider: claude-subscription, model: sonnet }
    fallback_planner: { provider: ollama, model: llama3.1:8b }
    stall_threshold: 3
    subscription_cooldown_minutes: 30
`;

test("parses fallback_planner, stall_threshold, subscription_cooldown_minutes, ollama_url", () => {
  const dir = mkdtempSync(join(tmpdir(), "smconf-"));
  const path = join(dir, "agents.yaml");
  writeFileSync(path, yamlWithGrowth);
  const cfg = loadConfig(path);
  expect(cfg.ollamaUrl).toBe("http://ollama.local:11434");
  const miner = cfg.agents[0]!;
  expect(miner.fallbackPlanner).toEqual({ provider: "ollama", model: "llama3.1:8b" });
  expect(miner.stallThreshold).toBe(3);
  expect(miner.subscriptionCooldownMinutes).toBe(30);
});

test("defaults ollama_url, stall_threshold, subscription_cooldown_minutes, no fallback_planner", () => {
  const dir = mkdtempSync(join(tmpdir(), "smconf-"));
  const path = join(dir, "agents.yaml");
  writeFileSync(path, yaml); // the original fixture already defined above, unchanged
  const cfg = loadConfig(path);
  expect(cfg.ollamaUrl).toBe("http://localhost:11434");
  expect(cfg.agents[0]!.fallbackPlanner).toBeUndefined();
  expect(cfg.agents[0]!.stallThreshold).toBe(5);
  expect(cfg.agents[0]!.subscriptionCooldownMinutes).toBe(60);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — `cfg.ollamaUrl` etc. are `undefined`, not matching expectations.

- [ ] **Step 3: Implement**

`src/config/config.ts` (full replacement):
```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SpacemoltClient } from "../client/client";

const PlannerSpecSchema = z.object({
  provider: z.enum(["mock", "claude-subscription", "ollama"]),
  model: z.string().optional(),
});

const AgentEntrySchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(24),
  empire: z.enum(["solarian", "voidborn", "crimson", "nebula", "outerrim"]),
  persona: z.string().min(1),
  planner: PlannerSpecSchema,
  fallback_planner: PlannerSpecSchema.optional(),
  fuel_pct: z.number().min(0).max(100).default(20),
  hull_pct: z.number().min(0).max(100).default(30),
  heartbeat_minutes: z.number().min(1).default(15),
  wake_notification_types: z.array(z.string()).default(["combat", "chat"]),
  // default 5: spec's "5 consecutive failures (default, configurable)"
  stall_threshold: z.number().int().min(1).default(5),
  // default 60: Claude subscription rate windows are commonly hourly; long
  // enough to avoid a hot-retry loop into a closed window, short enough to
  // recover the same day without an operator restart.
  subscription_cooldown_minutes: z.number().min(1).default(60),
});

const ConfigSchema = z.object({
  server_url: z.string().url(),
  db_path: z.string().default("./harness.sqlite"),
  ollama_url: z.string().url().default("http://localhost:11434"),
  agents: z.array(AgentEntrySchema).min(1),
});

export interface PlannerSpec {
  provider: "mock" | "claude-subscription" | "ollama";
  model?: string;
}

export interface AgentEntry {
  id: string;
  username: string;
  empire: "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim";
  persona: string;
  planner: PlannerSpec;
  fallbackPlanner?: PlannerSpec;
  fuelPct: number;
  hullPct: number;
  heartbeatMinutes: number;
  wakeNotificationTypes: string[];
  stallThreshold: number;
  subscriptionCooldownMinutes: number;
}

export interface HarnessConfig {
  serverUrl: string;
  dbPath: string;
  ollamaUrl: string;
  agents: AgentEntry[];
}

export function loadConfig(path: string): HarnessConfig {
  const raw = ConfigSchema.parse(Bun.YAML.parse(readFileSync(path, "utf8")));
  return {
    serverUrl: raw.server_url,
    dbPath: raw.db_path,
    ollamaUrl: raw.ollama_url,
    agents: raw.agents.map((a) => ({
      id: a.id, username: a.username, empire: a.empire, persona: a.persona,
      planner: a.planner,
      fallbackPlanner: a.fallback_planner,
      fuelPct: a.fuel_pct, hullPct: a.hull_pct,
      heartbeatMinutes: a.heartbeat_minutes,
      wakeNotificationTypes: a.wake_notification_types,
      stallThreshold: a.stall_threshold,
      subscriptionCooldownMinutes: a.subscription_cooldown_minutes,
    })),
  };
}

/**
 * Idempotent first-run registration: password file exists -> reuse it;
 * otherwise register (consumes the shared registration code) and persist
 * the returned password before anything else can fail.
 */
export async function ensureCredentials(
  client: SpacemoltClient, entry: AgentEntry, secretsDir: string,
): Promise<string> {
  const pwFile = join(secretsDir, `${entry.id}_password`);
  if (existsSync(pwFile)) return readFileSync(pwFile, "utf8").trim();

  const codeFile = join(secretsDir, "registration_code");
  if (!existsSync(codeFile)) {
    throw new Error(`missing ${codeFile} — get a registration code from https://spacemolt.com/dashboard`);
  }
  const code = readFileSync(codeFile, "utf8").trim();
  const { password } = await client.register(entry.username, entry.empire, code);
  writeFileSync(pwFile, password + "\n", { mode: 0o644 });
  return password;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Update agents.example.yaml with real recommended providers**

`agents.example.yaml` (full replacement):
```yaml
# Copy to agents.yaml and adjust. Passwords are auto-created in secrets/
# on first run; put your registration code (from spacemolt.com/dashboard)
# in secrets/registration_code first. Claude subscription auth needs
# secrets/claude_oauth_token (see docs/superpowers/specs/spike-claude-container-auth.md).
server_url: https://game.spacemolt.com
db_path: ./harness.sqlite
ollama_url: http://localhost:11434
agents:
  - id: miner
    username: REPLACE_ME_1
    empire: nebula            # cargo bonus suits a miner/trader
    persona: >
      A pragmatic ore miner and trader. Priorities: fill cargo, sell at the
      best nearby price, keep fuel above 25%, avoid combat entirely.
    # Repetitive mine/sell/travel loop needs little judgment; a local model
    # keeps this agent's cost at zero even past any subscription limit.
    planner: { provider: ollama, model: llama3.1:8b }
  - id: scout
    username: REPLACE_ME_2
    empire: outerrim          # speed bonus suits an explorer
    persona: >
      A methodical explorer. Priorities: visit unvisited adjacent systems,
      survey POIs, log discoveries, retreat from any hostile contact.
    # Better instruction-following than a small local model for varied POI
    # descriptions and log entries; the cheapest Claude tier is enough.
    planner: { provider: claude-subscription, model: haiku }
    fallback_planner: { provider: ollama, model: llama3.1:8b }
    heartbeat_minutes: 10
  - id: corsair
    username: REPLACE_ME_3
    empire: crimson           # weapons bonus suits a combat pilot
    persona: >
      An opportunistic privateer. Priorities: scan targets before engaging,
      only attack when advantaged, disengage below 50% hull.
    # Combat engage/disengage judgment benefits from the strongest reasoning
    # available -- this is the one agent where a bad call costs the ship,
    # not just time.
    planner: { provider: claude-subscription, model: sonnet }
    fallback_planner: { provider: ollama, model: llama3.1:8b }
    hull_pct: 50
    wake_notification_types: [combat, chat, trade]
    stall_threshold: 3   # combat agent should escalate to stalled faster than the default 5
```

- [ ] **Step 6: Run full suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/config.ts test/config.test.ts agents.example.yaml
git commit -m "Grow config schema: fallback planner, stall threshold, subscription cooldown, ollama URL"
```

---

### Task 6: main.ts wiring

**Files:**
- Create: `src/config/planner-factory.ts`
- Test: `test/planner-factory.test.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `PlannerSpec`, `HarnessConfig` (Task 5); `MockPlanner` (Plan 1); `ClaudeSubscriptionPlanner` (Task 2/4); `OllamaPlanner` (Task 3/4)
- Produces:
  - `function makePlanner(spec: PlannerSpec, opts: { secretsDir: string; ollamaUrl: string }): Planner`

`makePlanner` is extracted out of `main.ts` into its own module specifically so it's unit-testable: `main.ts` runs top-level `await` side effects (login, registration) on import, which makes it impractical to import directly in a test.

- [ ] **Step 1: Write the failing test**

`test/planner-factory.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { makePlanner } from "../src/config/planner-factory";
import { MockPlanner } from "../src/planner/mock";
import { ClaudeSubscriptionPlanner } from "../src/planner/claude-subscription";
import { OllamaPlanner } from "../src/planner/ollama";

const opts = { secretsDir: "secrets", ollamaUrl: "http://localhost:11434" };

describe("makePlanner", () => {
  test("mock -> MockPlanner", () => {
    expect(makePlanner({ provider: "mock" }, opts)).toBeInstanceOf(MockPlanner);
  });

  test("claude-subscription -> ClaudeSubscriptionPlanner", () => {
    expect(makePlanner({ provider: "claude-subscription", model: "haiku" }, opts)).toBeInstanceOf(ClaudeSubscriptionPlanner);
  });

  test("ollama -> OllamaPlanner", () => {
    expect(makePlanner({ provider: "ollama", model: "llama3.1:8b" }, opts)).toBeInstanceOf(OllamaPlanner);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/planner-factory.test.ts`
Expected: FAIL — cannot resolve `../src/config/planner-factory`.

- [ ] **Step 3: Implement**

`src/config/planner-factory.ts`:
```ts
import { join } from "node:path";
import { MockPlanner } from "../planner/mock";
import { ClaudeSubscriptionPlanner } from "../planner/claude-subscription";
import { OllamaPlanner } from "../planner/ollama";
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
    case "ollama":
      return new OllamaPlanner({ model: spec.model ?? "llama3.1:8b", baseUrl: opts.ollamaUrl });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/planner-factory.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire main.ts to construct real planners (remove the Plan-1 mock-only throw)**

`src/main.ts` (full replacement):
```ts
import { loadConfig, ensureCredentials } from "./config/config";
import { makePlanner } from "./config/planner-factory";
import { SpacemoltHttp } from "./client/http";
import { SpacemoltClient } from "./client/client";
import { Store } from "./store/store";
import { Agent } from "./agent/agent";

const CONFIG_PATH = process.env["HARNESS_CONFIG"] ?? "agents.yaml";
const SECRETS_DIR = process.env["HARNESS_SECRETS"] ?? "secrets";
const PRUNE_DAYS = 30;

const config = loadConfig(CONFIG_PATH);
const store = new Store(config.dbPath);
const pruned = store.pruneEvents(PRUNE_DAYS);
if (pruned > 0) console.log(`pruned ${pruned} events older than ${PRUNE_DAYS} days`);

store.onEvent = (e) => {
  console.log(`[${new Date(e.ts).toISOString()}] ${e.agentId} ${e.type}`, JSON.stringify(e.payload));
};

const agents: Agent[] = [];
for (const entry of config.agents) {
  const http = new SpacemoltHttp(config.serverUrl);
  const client = new SpacemoltClient(http);
  const password = await ensureCredentials(client, entry, SECRETS_DIR);
  await client.login(entry.username, password);
  const plannerOpts = { secretsDir: SECRETS_DIR, ollamaUrl: config.ollamaUrl };
  const agent = new Agent({
    id: entry.id,
    persona: entry.persona,
    api: client,
    store,
    planner: makePlanner(entry.planner, plannerOpts),
    fallbackPlanner: entry.fallbackPlanner ? makePlanner(entry.fallbackPlanner, plannerOpts) : undefined,
    config: {
      fuelPct: entry.fuelPct, hullPct: entry.hullPct,
      heartbeatMinutes: entry.heartbeatMinutes,
      wakeNotificationTypes: entry.wakeNotificationTypes,
      stallThreshold: entry.stallThreshold,
      subscriptionCooldownMinutes: entry.subscriptionCooldownMinutes,
    },
  });
  agent.start();
  agents.push(agent);
  console.log(`agent ${entry.id} (${entry.username}) started`);
}

process.on("SIGINT", () => {
  console.log("stopping agents...");
  for (const a of agents) a.stop();
  store.close();
  process.exit(0);
});
```

No `--dry-run`/mock-forcing flag is added: nothing in this plan needs it, and speculative flags are exactly what the simplicity rules ban without a concrete consumer. Anyone who wants an all-mock local run sets every agent's `planner.provider: mock` in `agents.yaml` — already supported, zero new code.

- [ ] **Step 6: Run full suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/config/planner-factory.ts test/planner-factory.test.ts src/main.ts
git commit -m "Wire real planners into main.ts via a testable planner factory"
```

**First-flight checkpoint:** at this point the harness can run any agent against `claude-subscription` or `ollama` for real, with classified failure handling, entirely from `agents.yaml`. Batch F ends here — this is the point named in the header for extra scrutiny before Batch G's deterministic hardening.

---

### Task 7: Fix the status digest producer + enumerate every digest input

Plan 1 shipped a latent defect: `PlanContext.statusSummary` is documented in `src/planner/types.ts` as "compact one-line status, not a state dump," but `agent.ts`'s `replan()` has always passed `JSON.stringify(status)` — literally the state dump the field's own doc comment says not to send. This task is the fix (producer-side, per simplicity rule 1: the bad value is *produced* in `agent.ts`, so that's where it gets fixed) plus the formal input-enumeration test the spec's "digest templates" bullet and simplicity rule 5 require.

**Files:**
- Modify: `src/planner/digest.ts` (add `summarizeStatus`)
- Modify: `src/agent/agent.ts` (call `summarizeStatus` instead of `JSON.stringify`)
- Modify: `test/digest.test.ts` (add `summarizeStatus` tests)
- Modify: `test/agent.test.ts` (one regression assertion: the context passed to the planner is no longer a raw JSON dump)

**Interfaces:**
- Produces: `function summarizeStatus(status: StatusSnapshot | null): string`

- [ ] **Step 1: Write the failing test**

Add to `test/digest.test.ts` (new `describe` block, new import):
```ts
import type { StatusSnapshot } from "../src/client/client";
import { summarizeStatus } from "../src/planner/digest";
```
```ts
describe("summarizeStatus", () => {
  const status: StatusSnapshot = {
    credits: 1234, fuel: 40, maxFuel: 100, hull: 80, maxHull: 100,
    cargoUsed: 5, cargoCapacity: 50, docked: true, inTransit: false,
  };

  test("renders every StatusSnapshot field in a compact one-liner", () => {
    const text = summarizeStatus(status);
    expect(text).toContain("1234");
    expect(text).toContain("40/100");
    expect(text).toContain("80/100");
    expect(text).toContain("5/50");
    expect(text).toContain("docked");
    expect(text).not.toContain("{"); // not a JSON dump
  });

  test("distinguishes docked / undocked / in transit", () => {
    expect(summarizeStatus({ ...status, docked: false, inTransit: false })).toContain("undocked");
    expect(summarizeStatus({ ...status, docked: false, inTransit: true })).toContain("in transit");
  });

  test("null status renders the existing 'status unavailable' placeholder", () => {
    expect(summarizeStatus(null)).toBe("status unavailable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/digest.test.ts`
Expected: FAIL — `summarizeStatus` is not exported.

- [ ] **Step 3: Implement**

Add to `src/planner/digest.ts` (new import, new export, appended after `buildDigest`):
```ts
import type { StatusSnapshot } from "../client/client";
```
```ts
/**
 * Compact one-line status summary -- the fix for the PlanContext field's own
 * doc comment ("compact one-line status, not a state dump", src/planner/
 * types.ts:8), which agent.ts violated since Plan 1 by passing
 * `JSON.stringify(status)` directly. Enumerated inputs: credits, fuel,
 * maxFuel, hull, maxHull, cargoUsed, cargoCapacity, docked, inTransit --
 * every StatusSnapshot field. No caching: computed fresh from whatever
 * status agent.ts passes in, which is itself fetched fresh via api.status()
 * every runOnce() call (agent.ts's Promise.all at the top of runOnce).
 */
export function summarizeStatus(status: StatusSnapshot | null): string {
  if (!status) return "status unavailable";
  const loc = status.inTransit ? "in transit" : status.docked ? "docked" : "undocked";
  return `credits ${status.credits}, fuel ${status.fuel}/${status.maxFuel}, ` +
    `hull ${status.hull}/${status.maxHull}, cargo ${status.cargoUsed}/${status.cargoCapacity}, ${loc}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/digest.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the producer in agent.ts**

In `src/agent/agent.ts`:

Add the import:
```ts
import { summarizeStatus } from "../planner/digest";
import type { StatusSnapshot } from "../client/client";
```

Replace this line inside `replan()`:
```ts
        statusSummary: status ? JSON.stringify(status) : "status unavailable",
```
with:
```ts
        statusSummary: summarizeStatus(status as StatusSnapshot | null),
```

- [ ] **Step 6: Add the regression assertion to test/agent.test.ts**

Add this test inside the existing `describe("Agent.runOnce")` block, after "emits wake, plan, and action events":
```ts
  test("statusSummary passed to the planner is a compact summary, not a JSON dump", async () => {
    const { agent, planner } = makeAgent([miningPlan]);
    await agent.runOnce();
    expect(planner.contexts[0]!.statusSummary).not.toContain("{");
    expect(planner.contexts[0]!.statusSummary).toContain("fuel");
  });
```

- [ ] **Step 7: Run full suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/planner/digest.ts src/agent/agent.ts test/digest.test.ts test/agent.test.ts
git commit -m "Fix statusSummary producer: compact summary instead of a raw JSON dump"
```

---

### Task 8: Reflex policies

Declarative, zero-token rules evaluated every loop iteration before wake conditions. A firing reflex executes its action and suppresses the corresponding wake for that tick; a failed reflex lets the wake fire normally.

**Files:**
- Create: `src/agent/reflex.ts`
- Test: `test/reflex.test.ts`
- Test: `test/agent-reflex.test.ts`
- Modify: `src/agent/agent.ts` (call `evaluateReflex` in `runOnce()`)
- Modify: `src/config/config.ts` (add `reflex` to `AgentEntrySchema`/`AgentEntry`)
- Modify: `src/main.ts` (pass `entry.reflex` into `AgentConfig`)
- Modify: `agents.example.yaml` (example reflex thresholds)

**Interfaces:**
- Produces:
  - `interface ReflexConfig { keepFuelAbovePct?: number; repairBelowHullPct?: number }`
  - `interface ReflexFire { action: "refuel" | "repair"; reason: "low_fuel" | "low_hull" }`
  - `function evaluateReflex(status: StatusSnapshot | null, config: ReflexConfig): ReflexFire | null`
  - `AgentConfig` grows `reflex?: ReflexConfig`
  - New agent events: `reflex`, `reflex_failed`

- [ ] **Step 1: Write the failing test for the pure reflex function**

`test/reflex.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { evaluateReflex } from "../src/agent/reflex";
import type { StatusSnapshot } from "../src/client/client";

function status(overrides: Partial<StatusSnapshot>): StatusSnapshot {
  return {
    credits: 0, fuel: 100, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false, ...overrides,
  };
}

describe("evaluateReflex", () => {
  test("fires refuel when docked and fuel below threshold", () => {
    expect(evaluateReflex(status({ fuel: 10 }), { keepFuelAbovePct: 25 }))
      .toEqual({ action: "refuel", reason: "low_fuel" });
  });

  test("fires repair when docked and hull below threshold", () => {
    expect(evaluateReflex(status({ hull: 20 }), { repairBelowHullPct: 30 }))
      .toEqual({ action: "repair", reason: "low_hull" });
  });

  test("fuel takes priority over hull when both breach", () => {
    const r = evaluateReflex(status({ fuel: 5, hull: 5 }), { keepFuelAbovePct: 25, repairBelowHullPct: 30 });
    expect(r?.action).toBe("refuel");
  });

  test("does not fire while undocked, even below threshold", () => {
    expect(evaluateReflex(status({ fuel: 5, docked: false }), { keepFuelAbovePct: 25 })).toBeNull();
  });

  test("does not fire when no threshold is configured", () => {
    expect(evaluateReflex(status({ fuel: 5 }), {})).toBeNull();
  });

  test("does not fire on a null status", () => {
    expect(evaluateReflex(null, { keepFuelAbovePct: 25 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/reflex.test.ts`
Expected: FAIL — cannot resolve `../src/agent/reflex`.

- [ ] **Step 3: Implement**

`src/agent/reflex.ts`:
```ts
import type { StatusSnapshot } from "../client/client";

export interface ReflexConfig {
  keepFuelAbovePct?: number;
  repairBelowHullPct?: number;
}

export interface ReflexFire {
  action: "refuel" | "repair";
  reason: "low_fuel" | "low_hull";
}

/**
 * Zero-token, executor-level rule evaluated every loop iteration before wake
 * conditions. Fires only while docked, because refuel/repair are docked-only
 * game actions -- a threshold breach while undocked is left for the
 * low_fuel/low_hull wake conditions to hand to the planner. Fuel is checked
 * before hull (first match wins), matching evaluateWake's "first reason
 * wins" convention. Enumerated inputs: status.fuel, status.maxFuel,
 * status.hull, status.maxHull, status.docked, config.keepFuelAbovePct,
 * config.repairBelowHullPct -- seven total, all read fresh from the status
 * agent.ts fetches every runOnce() call; nothing here is cached.
 */
export function evaluateReflex(status: StatusSnapshot | null, config: ReflexConfig): ReflexFire | null {
  if (!status || !status.docked) return null;
  const { fuel, maxFuel, hull, maxHull } = status;
  if (config.keepFuelAbovePct != null && maxFuel > 0 && (fuel / maxFuel) * 100 < config.keepFuelAbovePct) {
    return { action: "refuel", reason: "low_fuel" };
  }
  if (config.repairBelowHullPct != null && maxHull > 0 && (hull / maxHull) * 100 < config.repairBelowHullPct) {
    return { action: "repair", reason: "low_hull" };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/reflex.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the reflex check into Agent.runOnce()**

In `src/agent/agent.ts`:

Add the import:
```ts
import { evaluateReflex, type ReflexConfig } from "./reflex";
```

Grow `AgentConfig`:
```ts
export interface AgentConfig {
  fuelPct: number;
  hullPct: number;
  heartbeatMinutes: number;
  wakeNotificationTypes: string[];
  stallThreshold: number;
  subscriptionCooldownMinutes: number;
  reflex?: ReflexConfig;
}
```

Replace `runOnce()` with:
```ts
  async runOnce(): Promise<void> {
    const [notifications, status] = await Promise.all([
      this.api.notifications().catch(() => []),
      this.api.status().catch((e) => {
        this.emit("status_error", { message: e instanceof Error ? e.message : String(e) });
        return null;
      }),
    ]);

    const reflex = evaluateReflex(status, this.config.reflex ?? {});
    let reflexSpentTick = false;
    if (reflex) {
      reflexSpentTick = true;
      const fired = await this.fireReflex(reflex);
      if (fired) return; // succeeded: this tick's mutation budget spent, wake suppressed entirely
      // failed ("can't afford"): fall through so the low_fuel/low_hull wake
      // can still fire and hand the problem to the planner. This tick's
      // mutation budget was already spent on the failed attempt, so
      // executeOne is skipped below regardless of what wake decides.
    }

    const instruction = this.inbox[0];
    const wake = evaluateWake({
      planState: this.planState,
      blockedReason: this.blockedReason,
      instruction,
      notifications,
      status,
      lastPlanAt: this.lastPlanAt,
      now: this.now(),
      heartbeatMs: this.config.heartbeatMinutes * 60_000,
      fuelPct: this.config.fuelPct,
      hullPct: this.config.hullPct,
      wakeNotificationTypes: this.config.wakeNotificationTypes,
    });

    if (wake) {
      if (this.now() < this.plannerBackoffUntil) {
        if (!reflexSpentTick && this.plan && this.planState === "running") await this.executeOne();
        return;
      }
      if (instruction !== undefined) this.inbox.shift();
      await this.replan(wake, status, instruction);
      return;
    }
    if (!reflexSpentTick && this.plan && this.planState === "running") {
      await this.executeOne();
    }
  }

  private async fireReflex(reflex: ReturnType<typeof evaluateReflex>): Promise<boolean> {
    if (!reflex) return false;
    try {
      await this.api.action(reflex.action);
      this.emit("reflex", { action: reflex.action, reason: reflex.reason });
      return true;
    } catch (e) {
      this.emit("reflex_failed", {
        action: reflex.action, reason: reflex.reason,
        message: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }
```

- [ ] **Step 6: Write the failing agent-level integration test**

`test/agent-reflex.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { SpacemoltError } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";

const baseConfig: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
  reflex: { keepFuelAbovePct: 25 },
};

function makeApi(status: StatusSnapshot, opts?: { failRefuel?: boolean }) {
  const calls: string[] = [];
  const api: GameApi = {
    async action(name): Promise<V2Result> {
      calls.push(name);
      if (name === "refuel" && opts?.failRefuel) throw new SpacemoltError("command_error", "can't afford fuel");
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

const lowFuelDocked: StatusSnapshot = {
  credits: 0, fuel: 5, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

describe("Agent reflex integration", () => {
  test("docked + low fuel: reflex refuels, suppresses the wake, planner not called", async () => {
    const { api, calls } = makeApi(lowFuelDocked);
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]);
    expect(planner.contexts.length).toBe(0);
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toEqual(["reflex"]);
  });

  test("undocked + low fuel: reflex does not fire, low_fuel wake replans as in Plan 1", async () => {
    const { api, calls } = makeApi({ ...lowFuelDocked, docked: false });
    const store = new Store(":memory:");
    // Seed a running plan before constructing the Agent. Derivation:
    // evaluateWake's branches are checked in a fixed unconditional order
    // (src/agent/wake.ts, evaluateWake body: instruction -> blocked ->
    // planState "none" -> "done" -> notifications -> low_fuel/low_hull ->
    // heartbeat), so a fresh agent with no plan wakes with reason "no_plan"
    // and never reaches the fuel-threshold check. A plan loaded from the
    // store sets planState "running" in the Agent constructor, letting
    // low_fuel be the first branch that fires. Same seeding pattern as
    // Task 4's backoff test.
    store.savePlan("a1", { goal: "g", steps: [{ action: "mine", params: {}, repeat: 5 }] }, []);
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual([]); // no refuel attempted, no plan step executed (the wake preempts execution)
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.wake.reason).toBe("low_fuel");
  });

  test("failed reflex ('can't afford') marks itself failed and still lets the wake fire", async () => {
    const { api, calls } = makeApi(lowFuelDocked, { failRefuel: true });
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: baseConfig, now: () => 1 });

    await agent.runOnce();
    expect(calls).toEqual(["refuel"]); // attempted once, no second mutation this tick
    expect(planner.contexts.length).toBe(1); // wake still fired despite the failed reflex
    expect(store.recentEvents("a1", 10).map((e) => e.type)).toContain("reflex_failed");
  });

  test("no reflex configured: identical to Plan-1 behavior, no reflex events", async () => {
    const { api } = makeApi(lowFuelDocked);
    const store = new Store(":memory:");
    const planner = new MockPlanner([{ goal: "x", steps: [{ action: "undock", params: {} }] }]);
    const configNoReflex: AgentConfig = { ...baseConfig, reflex: undefined };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner, config: configNoReflex, now: () => 1 });

    await agent.runOnce();
    expect(planner.contexts.length).toBe(1);
    expect(store.recentEvents("a1", 10).map((e) => e.type)).not.toContain("reflex");
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test test/reflex.test.ts test/agent-reflex.test.ts`
Expected: PASS.

- [ ] **Step 8: Wire `reflex` through config.ts and main.ts, add example**

In `src/config/config.ts`, add to `AgentEntrySchema`:
```ts
  reflex: z.object({
    keep_fuel_above: z.number().min(0).max(100).optional(),
    repair_below_hull: z.number().min(0).max(100).optional(),
  }).optional(),
```
Add to the `AgentEntry` interface:
```ts
  reflex?: { keepFuelAbovePct?: number; repairBelowHullPct?: number };
```
Add to `loadConfig`'s mapping (inside the `.map((a) => ({ ... }))` object):
```ts
      reflex: a.reflex
        ? { keepFuelAbovePct: a.reflex.keep_fuel_above, repairBelowHullPct: a.reflex.repair_below_hull }
        : undefined,
```

In `src/main.ts`, add `reflex: entry.reflex,` to the `config:` object passed into `new Agent({...})`.

In `agents.example.yaml`, add reflex blocks:
```yaml
  - id: miner
    ...
    planner: { provider: ollama, model: llama3.1:8b }
    reflex: { keep_fuel_above: 30 }   # zero-token auto-refuel while docked; the miner should rarely need the planner just for fuel
```
```yaml
  - id: corsair
    ...
    stall_threshold: 3
    reflex: { repair_below_hull: 60 } # auto-repair while docked before combat, zero tokens
```

- [ ] **Step 9: Run full suite**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/agent/reflex.ts src/agent/agent.ts src/config/config.ts src/main.ts agents.example.yaml \
  test/reflex.test.ts test/agent-reflex.test.ts
git commit -m "Add reflex policies: zero-token auto-refuel/repair while docked"
```

---

### Task 9: `travel_to` route macro

`travel_to(system_id)` expands into repeated `jump` calls, one hop per tick, re-deriving the route from the ship's *current* position every tick via the free `find_route` query. No route is ever persisted beyond the plan's existing `{step, iteration}` cursor: a crash mid-route resumes correctly for free (the next tick just re-derives the route from wherever the ship actually is), and a route that changes mid-flight self-heals on the very next tick instead of driving into a stale path.

**Load-bearing unknown, flagged per simplicity rule 6:** `find_route`'s response shape isn't documented in `docs/wiki/spacemolt-api.md` or the OpenAPI conformance fixture (`test/fixtures/openapi-slim.json` only carries request params, not response schemas), and the harness has no live game access yet (registration-code blocker, see `docs/STATE.md`). This task assumes `structuredContent.route: string[]` (ordered hops from the current position, `route[0]` = next jump target) as the single working assumption, isolated to one function (`nextHop` in `executor.ts`) so a wrong guess is a one-function fix, not a redesign. **Verify against a real `find_route` call during Plan 4's first live run before removing this note.**

**Files:**
- Modify: `src/registry/plan.ts` (add the `travel_to` step schema)
- Modify: `src/agent/executor.ts` (expand `travel_to` in `executeTick`)
- Modify: `src/client/client.ts` (add `systemId` to `StatusSnapshot`)
- Modify: `src/planner/digest.ts` (mention `travel_to` in the action vocabulary)
- Modify: `src/planner/ollama.ts` (add the `travel_to` branch to the JSON schema)
- Modify: `test/registry.test.ts` (accept `travel_to` as a valid step)
- Modify: `test/executor.test.ts` (new `describe` block for the macro)
- Modify: `test/client.test.ts` (extend the `status()` test with `system_id`)

**Interfaces:**
- Produces: `PlanStepSchema` grows a `travel_to` variant: `{ action: "travel_to"; params: { system_id: string } }`
- `StatusSnapshot` grows `systemId?: string | null` (optional, so existing test literals that don't reference it keep compiling unchanged)

- [ ] **Step 1: Write the failing test for the plan schema**

Add to `test/registry.test.ts`, inside `describe("plan schema")`:
```ts
test("accepts travel_to even though it isn't a registry action", () => {
  const plan = PlanSchema.parse({
    goal: "go explore",
    steps: [{ action: "travel_to", params: { system_id: "sys-9" } }],
  });
  expect(plan.steps[0]).toEqual({ action: "travel_to", params: { system_id: "sys-9" } });
});

test("rejects travel_to with the wrong param shape", () => {
  expect(() =>
    PlanSchema.parse({ goal: "x", steps: [{ action: "travel_to", params: { id: "sys-9" } }] })
  ).toThrow(); // wrong key: must be system_id
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/registry.test.ts`
Expected: FAIL — `travel_to` rejected by the current `PlanStepSchema`.

- [ ] **Step 3: Implement the schema addition**

`src/registry/plan.ts` (full replacement):
```ts
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
  [...stepSchemas, TravelToStepSchema] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
);

export const PlanSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1).max(30),
}).strict();

export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend StatusSnapshot with systemId**

In `src/client/client.ts`, add to `StatusSnapshot`:
```ts
  systemId?: string | null; // added for travel_to (Plan 2 Task 9); optional so
                            // existing StatusSnapshot literals elsewhere in
                            // the test suite don't need updating just to add
                            // a field they don't use.
```
Add to the `StatusSchema`'s `location` object:
```ts
    system_id: z.string().nullable().optional(),
```
Add to the `status()` mapping's returned object:
```ts
      systemId: s.location.system_id ?? null,
```

Update the existing `"status() extracts snapshot from get_status"` test in `test/client.test.ts` to cover the new field (full replacement of that one test):
```ts
  test("status() extracts snapshot from get_status", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 5, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false, system_id: "sys-alpha" },
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s).toEqual({
      credits: 1234, fuel: 40, maxFuel: 100, hull: 80, maxHull: 100,
      cargoUsed: 5, cargoCapacity: 50, docked: true, inTransit: false, systemId: "sys-alpha",
    });
  });
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/client.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing executor test for the macro**

Add to `test/executor.test.ts` (new imports, new `describe` block at the end of the file):
```ts
import type { StatusSnapshot } from "../src/client/client";
```
```ts
describe("executeTick: travel_to macro", () => {
  function stubRouteApi(opts: {
    systemId: string; route?: string[];
    failFind?: SpacemoltError; failJump?: SpacemoltError;
  }) {
    const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
    let systemId = opts.systemId;
    const api: GameApi = {
      async action(name, params) {
        calls.push({ name, params });
        if (name === "find_route") {
          if (opts.failFind) throw opts.failFind;
          return { structuredContent: { route: opts.route ?? [] } };
        }
        if (name === "jump") {
          if (opts.failJump) throw opts.failJump;
          systemId = params!["id"] as string; // fake: arrives at the hop immediately
          return { result: "ok" };
        }
        return { result: "ok" };
      },
      async status(): Promise<StatusSnapshot> {
        return {
          credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
          cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false, systemId,
        };
      },
      async notifications() { return []; },
    };
    return { api, calls };
  }

  test("already at target completes the step immediately", async () => {
    const { api, calls } = stubRouteApi({ systemId: "sys-3" });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-3" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done" });
    expect(calls).toEqual([]); // no find_route/jump needed
  });

  test("jumps one hop per tick toward the target", async () => {
    const { api, calls } = stubRouteApi({ systemId: "sys-1", route: ["sys-2"] });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-3" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 } });
    expect(calls.map((c) => c.name)).toEqual(["find_route", "jump"]);
    expect(calls[1]!.params).toEqual({ id: "sys-2" });
  });

  test("arrival on a later tick advances the plan", async () => {
    const { api } = stubRouteApi({ systemId: "sys-3" }); // already there this tick
    const plan: Plan = { goal: "g", steps: [
      { action: "travel_to", params: { system_id: "sys-3" } },
      { action: "dock", params: {} },
    ]};
    const r = await executeTick(api, plan, { step: 0, iteration: 2 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 } });
  });

  test("no route found blocks the plan", async () => {
    const { api } = stubRouteApi({ systemId: "sys-1", route: [] });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-9" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "no route to sys-9" });
  });

  test("jump failure blocks the plan with the game's reason", async () => {
    const { api } = stubRouteApi({
      systemId: "sys-1", route: ["sys-2"],
      failJump: new SpacemoltError("command_error", "not enough fuel"),
    });
    const plan: Plan = { goal: "g", steps: [{ action: "travel_to", params: { system_id: "sys-3" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "not enough fuel" });
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `bun test test/executor.test.ts`
Expected: FAIL — `executeTick` doesn't special-case `travel_to` yet.

- [ ] **Step 9: Implement the macro in executor.ts**

`src/agent/executor.ts` (full replacement):
```ts
import { SpacemoltError } from "../client/http";
import type { GameApi } from "../client/client";
import type { Plan, PlanStep } from "../registry/plan";
import type { PlanCursor } from "../store/store";

export type StepResult =
  | { kind: "continue"; cursor: PlanCursor }
  | { kind: "plan_done" }
  | { kind: "blocked"; reason: string };

async function conditionMet(api: GameApi, until: NonNullable<PlanStep["until"]>): Promise<boolean> {
  const s = await api.status(); // query: free, unlimited
  if (until === "cargo_full") return s.cargoCapacity > 0 && s.cargoUsed >= s.cargoCapacity;
  return s.cargoUsed === 0; // cargo_empty
}

// ASSUMED shape of find_route's response: { route: string[] }, ordered hops
// from the current position, route[0] = next jump target. Not documented in
// docs/wiki/spacemolt-api.md or the OpenAPI conformance fixture (request
// params only), and the harness has no live game access yet. This is the
// single point of contact with that assumption -- if the real shape differs,
// fix it here. Verify against a live find_route call during Plan 4's first
// live run before removing this note.
function nextHop(structuredContent: unknown): string | null {
  const route = (structuredContent as { route?: unknown } | undefined)?.route;
  if (!Array.isArray(route) || typeof route[0] !== "string") return null;
  return route[0];
}

function advance(plan: Plan, cursor: PlanCursor): StepResult {
  const next = cursor.step + 1;
  if (next >= plan.steps.length) return { kind: "plan_done" };
  return { kind: "continue", cursor: { step: next, iteration: 0 } };
}

/**
 * travel_to expands into repeated "jump" calls, one hop per tick, re-querying
 * find_route from the CURRENT position every time -- no route is persisted
 * beyond the plan's ordinary {step, iteration} cursor. A crash mid-route
 * resumes correctly for free (the next executeTick call just re-derives the
 * route from wherever the ship actually is), and a route that changes
 * mid-flight self-heals on the next tick instead of driving into a stale path.
 */
async function travelToTick(api: GameApi, plan: Plan, cursor: PlanCursor, targetSystemId: string): Promise<StepResult> {
  const status = await api.status(); // query: free, unlimited
  if (status.systemId === targetSystemId) return advance(plan, cursor);

  let route: unknown;
  try {
    const res = await api.action("find_route", { id: targetSystemId });
    route = res.structuredContent;
  } catch (e) {
    if (e instanceof SpacemoltError) return { kind: "blocked", reason: e.message };
    throw e;
  }
  const hop = nextHop(route);
  if (!hop) return { kind: "blocked", reason: `no route to ${targetSystemId}` };

  try {
    await api.action("jump", { id: hop });
  } catch (e) {
    if (e instanceof SpacemoltError) return { kind: "blocked", reason: e.message };
    throw e;
  }
  return { kind: "continue", cursor: { step: cursor.step, iteration: cursor.iteration + 1 } };
}

/** Runs exactly one game mutation and reports where the plan stands. */
export async function executeTick(api: GameApi, plan: Plan, cursor: PlanCursor): Promise<StepResult> {
  const step = plan.steps[cursor.step];
  if (!step) return { kind: "plan_done" };

  if (step.action === "travel_to") {
    return travelToTick(api, plan, cursor, step.params.system_id);
  }

  try {
    await api.action(step.action, step.params as Record<string, unknown>);
  } catch (e) {
    if (e instanceof SpacemoltError) return { kind: "blocked", reason: e.message };
    throw e; // non-game errors (bugs) propagate
  }

  const iteration = cursor.iteration + 1;
  let stepDone: boolean;
  if (step.until) stepDone = await conditionMet(api, step.until);
  else if (step.repeat) stepDone = iteration >= step.repeat;
  else stepDone = true;

  if (!stepDone) return { kind: "continue", cursor: { step: cursor.step, iteration } };
  return advance(plan, cursor);
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `bun test test/executor.test.ts`
Expected: PASS.

- [ ] **Step 11: Register travel_to in the digest vocabulary and the Ollama JSON schema**

In `src/planner/digest.ts`, add below `ACTION_VOCAB`:
```ts
// travel_to is executor vocabulary, not a REGISTRY action (see plan.ts) --
// added by hand alongside the registry-derived vocabulary above.
const TRAVEL_TO_VOCAB = "travel_to(system_id:string) -- expands into jump hops via find_route, not a game action itself";
```
Change the vocabulary line inside `buildDigest`:
```ts
    `Available actions: ${ACTION_VOCAB}; ${TRAVEL_TO_VOCAB}.`,
```

In `src/planner/ollama.ts`, add a hand-written branch alongside the registry-derived ones inside `buildPlanJsonSchema`:
```ts
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
```

- [ ] **Step 12: Run full suite**

Run: `bun test && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 13: Commit**

```bash
git add src/registry/plan.ts src/agent/executor.ts src/client/client.ts src/planner/digest.ts src/planner/ollama.ts \
  test/registry.test.ts test/executor.test.ts test/client.test.ts
git commit -m "Add travel_to route macro: re-queried find_route hops, no persisted route state"
```

---

## Deferred (explicitly out of scope)

- **Market math in code** (spec's "Plan 2 Additions" bullet): no consumer exists until the trader persona is tuned against real market data — building profit/price comparison tables now would be speculative abstraction (YAGNI). Revisit when a persona actually needs it.
- **Automatic switch-back from fallback planner to primary** once a subscription window resets: Task 4's `usingFallback`/`claudeDisabled` flags are sticky for the process lifetime; recovering the primary planner needs an operator restart in v1. Automatic reset-time tracking was cut because there's no verified signal for exactly when a usage window resets (see Task 4's classifier note) — tracking an unobservable event is complexity without a receipt.
- **Generic Zod-to-JSON-Schema conversion** (e.g. adopting Zod v4 or the `zod-to-json-schema` package): rejected in Task 3 in favor of the narrow, registry-scoped `describeParamsShape` walker already built in Task 2.

## Load-bearing unknowns carried into Plan 4 (verify before removing these notes)

1. **`find_route`'s response shape** (Task 9): assumed `{ route: string[] }`. Verify against a live call once the registration-code blocker clears.
2. **Claude CLI failure-text patterns** (Task 4's `classifyClaudeFailure`): assumed from documented CLI behavior, not ablated against a real rate-limit or token-expiry event (neither safe to induce without spending real usage or waiting for an outage). Revisit during Plan 4's first live run.
3. **Ollama's supported JSON-Schema keyword subset** (Task 3): assumed a standard subset (`const`, `enum`, `type`, `properties`, `required`, `items`, `minItems`/`maxItems`) works with `format:`; the retry-on-validation-failure path is the safety net if some keyword is silently ignored by a given Ollama version.
4. **The 60-minute `subscription_cooldown_minutes` default** (Task 5): rests on the unverified assumption that Claude subscription usage windows are roughly hourly — same class as the classifier patterns in item 2 (no safe way to induce a real limit event to observe the actual reset cadence). Tune against observed reset behavior during Plan 4's first live run.
