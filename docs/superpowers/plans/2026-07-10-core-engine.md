# SpaceMolt Harness Plan 1: Core Engine Implementation Plan

> **For agentic workers:** Execution follows the agent team structure in `docs/wiki/team-structure.md` (PM → tech lead per batch → Haiku implementers + Sonnet reviewers per task; batches A: 0,2,3 / B: 4,5,6 / C: 7-10 / D: 11,12; council gate at plan completion). That structure supersedes the generic subagent-driven-development flow. Steps use checkbox (`- [ ]`) syntax for tracking. Process conventions (STATE.md updates, decision log, compression rules) are in AGENTS.md — binding, not repeated here.

**Goal:** Build the token-free core of the SpaceMolt multi-agent harness — typed API client, action registry, plan executor, SQLite store, agent loop with mocked planner — fully tested against a fake game server, plus the phase-0 spike proving Claude subscription auth works in a container.

**Architecture:** One Bun process runs N agent loops. Each loop evaluates wake conditions; if none fire, a deterministic executor advances the current plan one step (zero tokens). Plans are linear step lists validated by Zod schemas derived from a single action registry. Events and plan cursors persist to SQLite. The planner is an interface; this plan ships only the mock — real planners (Claude subscription, Ollama) are Plan 2.

**Tech Stack:** Bun ≥ 1.2.21 (built-in SQLite, test runner, `Bun.YAML`), TypeScript, Zod. No other runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-spacemolt-harness-design.md`

## Global Constraints

- Bun ≥ 1.2.21 required (`Bun.YAML.parse`, `bun:sqlite`).
- Zod is the only npm runtime dependency. Adding another requires explicit justification.
- Secrets live in `secrets/` (gitignored). Never hardcode credentials, tokens, or registration codes in any file, test, or commit.
- Every game action is defined exactly once, in `src/registry/actions.ts`. An action defined in two places is a review-blocking defect.
- Mutations hit the game at most once per ~10s tick; queries are unlimited. The client layer owns rate-limit handling — it must never surface to the planner.
- Commit author is the user's identity only. No co-author trailers.
- Game API base URL: `https://game.spacemolt.com` (path pattern `/api/v2/{tool}/{action}`, session via `POST /api/v2/session`, header `X-Session-Id`).
- All tests run offline: fake server or stubs only. Zero live-game traffic, zero LLM tokens in tests.

## API Contract Reference (verified against live OpenAPI spec 2026-07-10)

- `POST /api/v2/session` → `{ session: { id } }` (in `structuredContent` or top-level `session` field of envelope).
- All calls: `POST /api/v2/{tool}/{action}` with JSON body, header `X-Session-Id`.
- Response envelope: `{ result?: string, structuredContent?: object, notifications?: Notification[], error?: { code, message, retry_after?, details? } }`.
- Error codes: `session_required`, `session_invalid`, `not_authenticated`, `rate_limited` (has `retry_after` seconds), `command_error`, `invalid_params`, `unknown_command`.
- Auth tool is `spacemolt_auth`: `register {username, empire, registration_code}` → `structuredContent.password`; `login {username, password}`.
- Game tool is `spacemolt`: `travel {id}`, `jump {id}`, `dock {}`, `undock {}`, `mine {}`, `sell {id, quantity}`, `buy {id, quantity}`, `refuel {}`, `repair {}`, `attack {id}`, `scan {id}`, `get_status {}`, `get_system {}`, `get_poi {}`, `find_route {id}`, `get_notifications {limit?, types?, clear?}`.
- `get_status` → `structuredContent` (V2GameState) with `ship: { fuel, max_fuel, hull, max_hull, cargo_used, cargo_capacity, ... }`, `player: { credits, username, ... }`, `location: { system_id?, poi_id?, docked_at, in_transit, ... }`.
- Notification envelope: `{ id, type, msg_type, timestamp, data }` where `type` ∈ system|combat|trade|chat|friend|tip.
- Empires: `solarian`, `voidborn`, `crimson`, `nebula`, `outerrim`.

---

### Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitattributes`

**Interfaces:**
- Consumes: nothing
- Produces: a repo where `bun test` runs (0 tests) and `zod` is importable

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "spacemolt-harness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.2.21" },
  "scripts": {
    "start": "bun run src/main.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/bun": "^1.2.21",
    "typescript": "^5.7.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["bun"],
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

`.gitattributes`:
```
* text=auto eol=lf
```

- [ ] **Step 2: Install and verify**

The repo already exists with a remote (`origin` → github.com/<owner>/spacemolt) and a `.gitignore` covering `secrets/`, `*.sqlite`, and `node_modules/` — do not re-init or overwrite it. Verify: `git remote -v` shows origin, and `.gitignore` contains `secrets/`.

Run: `bun install && bun test`
Expected: install succeeds; `bun test` reports "0 tests" (no failure).

Run: `bun --version`
Expected: ≥ 1.2.21. If lower, `bun upgrade` first — `Bun.YAML` and this plan depend on it.

Typecheck discipline: `bun test` strips types without checking them, so every task's final "run test" step also runs `bun run typecheck` — that's the command that proves the test code compiles against the implementation. (`typecheck` will error until `src/` has files; from Task 2 onward it must pass.)

- [ ] **Step 3: Commit**

```bash
git add package.json tsconfig.json .gitattributes bun.lock
git commit -m "Scaffold Bun/TypeScript project with zod"
```

---

### Task 1: Phase-0 spike — Claude subscription auth in a container

This is a decision gate, not TDD. The spec calls it the least verifiable claim in the design. Prove it before building planners on it.

**Files:**
- Create: `spike/Dockerfile`
- Create: `docs/superpowers/specs/spike-claude-container-auth.md` (findings)

**Interfaces:**
- Consumes: host Claude Code login (your subscription)
- Produces: a documented GO/NO-GO for the `claude-subscription` planner in a container, and the working invocation pattern Plan 2 will copy

- [ ] **Step 1: Generate a long-lived token on the host**

Run on host: `claude setup-token`
This prints an OAuth token backed by your subscription. Store it: create `secrets/` dir if missing, write token to `secrets/claude_oauth_token` (gitignored). Do not echo it into shell history — paste into the file with an editor or `Set-Content` from clipboard.

- [ ] **Step 2: Write the spike Dockerfile**

`spike/Dockerfile`:
```dockerfile
# Spike only: prove subscription-auth headless Claude works in a container.
# node base because the claude CLI is an npm package; final harness image
# composition (bun + claude) is a follow-up finding of this spike.
FROM node:22-bookworm-slim
ARG CLAUDE_VERSION
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}
ENTRYPOINT ["claude"]
```

- [ ] **Step 3: Build, pinning to your host's Claude version**

Run on host: `claude --version` (note the version, e.g. `2.1.3`)
Run: `docker build --build-arg CLAUDE_VERSION=<that version> -t claude-spike spike/`
Expected: image builds. If the pinned version doesn't exist on npm, use the closest published version.

- [ ] **Step 4: Test A — token via environment**

```bash
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN="$(cat secrets/claude_oauth_token)" \
  claude-spike -p "Reply with exactly the word: pong" --output-format json
```
Expected: JSON to stdout containing a `result` field with "pong" and a `usage` object. Run it twice to confirm repeatability.

- [ ] **Step 5: Test B — persistent volume home (fallback path)**

Only if Test A fails:
```bash
docker volume create claude-home
docker run --rm -it -v claude-home:/root/.claude --entrypoint bash claude-spike
# inside: claude login   (browser-based; may require --no-localhost flow)
# then:  claude -p "Reply with exactly the word: pong" --output-format json
```
Expected: same JSON shape. The volume persists refreshed tokens across runs.

- [ ] **Step 6: Record findings and the decision**

Write `docs/superpowers/specs/spike-claude-container-auth.md` with: which path worked (A/B/neither), exact working `docker run` + `claude -p` invocation, observed startup latency, tokens reported in `usage` for the trivial prompt (this is the per-call overhead the cost model cares about), and the GO/NO-GO decision. If NO-GO: Plan 2's `claude-subscription` planner runs on the host outside the container (harness reaches it via host networking) or falls back to Ollama-only — record which.

- [ ] **Step 7: Commit**

```bash
git add spike/Dockerfile docs/superpowers/specs/spike-claude-container-auth.md
git commit -m "Spike: Claude subscription auth in container - record GO/NO-GO"
```

---

### Task 2: Action registry and plan schema

**Files:**
- Create: `src/registry/actions.ts`
- Create: `src/registry/plan.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `zod`
- Produces:
  - `interface ActionDef { tool: string; name: string; kind: "mutation" | "query"; params: z.ZodTypeAny; eventLabel: string }`
  - `const REGISTRY: ActionDef[]`
  - `function getAction(name: string): ActionDef` (throws on unknown)
  - `const PlanSchema: z.ZodType<Plan>`; `type Plan = { goal: string; steps: PlanStep[] }`
  - `type PlanStep = { action: string; params: Record<string, unknown>; until?: "cargo_full" | "cargo_empty"; repeat?: number }`

- [ ] **Step 1: Write the failing test**

`test/registry.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { REGISTRY, getAction } from "../src/registry/actions";
import { PlanSchema } from "../src/registry/plan";

describe("registry", () => {
  test("every action fully defined, no duplicate names", () => {
    const names = REGISTRY.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    for (const a of REGISTRY) {
      expect(a.tool.length).toBeGreaterThan(0);
      expect(a.eventLabel.length).toBeGreaterThan(0);
      expect(["mutation", "query"]).toContain(a.kind);
    }
  });

  test("getAction returns def and throws on unknown", () => {
    expect(getAction("mine").tool).toBe("spacemolt");
    expect(() => getAction("warp_drive")).toThrow();
  });

  test("core v1 actions present", () => {
    for (const n of ["travel", "jump", "dock", "undock", "mine", "sell", "buy",
      "refuel", "repair", "attack", "scan", "get_status", "get_system",
      "get_poi", "find_route", "get_notifications"]) {
      expect(() => getAction(n)).not.toThrow();
    }
  });
});

describe("plan schema", () => {
  test("accepts a valid mining plan", () => {
    const plan = PlanSchema.parse({
      goal: "fill cargo with ore and sell it",
      steps: [
        { action: "travel", params: { id: "poi-belt-1" } },
        { action: "mine", params: {}, until: "cargo_full" },
        { action: "dock", params: {} },
        { action: "sell", params: { id: "iron_ore", quantity: 50 } },
      ],
    });
    expect(plan.steps.length).toBe(4);
  });

  test("rejects queries as plan steps", () => {
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "get_status", params: {} }] })
    ).toThrow();
  });

  test("rejects unknown action and bad params", () => {
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "teleport", params: {} }] })
    ).toThrow();
    expect(() =>
      PlanSchema.parse({ goal: "x", steps: [{ action: "sell", params: { id: "iron_ore" } }] })
    ).toThrow(); // sell requires quantity
  });

  test("rejects empty and oversized plans", () => {
    expect(() => PlanSchema.parse({ goal: "x", steps: [] })).toThrow();
    const steps = Array.from({ length: 31 }, () => ({ action: "mine", params: {} }));
    expect(() => PlanSchema.parse({ goal: "x", steps })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/registry.test.ts`
Expected: FAIL — cannot resolve `../src/registry/actions`.

- [ ] **Step 3: Implement the registry**

`src/registry/actions.ts`:
```ts
import { z } from "zod";

export interface ActionDef {
  tool: string; // API tool group: "spacemolt" | "spacemolt_auth"
  name: string; // action name == API path segment
  kind: "mutation" | "query";
  params: z.ZodTypeAny;
  eventLabel: string; // human label for dashboard event feed
}

const none = z.object({}).strict();

// The single source of truth for every game action agents may use.
// Hand-curated subset of the full API; conformance-tested against the
// OpenAPI spec (see test/registry-conformance.test.ts, Task 3).
export const REGISTRY: ActionDef[] = [
  // --- mutations (one per ~10s tick) ---
  { tool: "spacemolt", name: "travel", kind: "mutation", eventLabel: "Travel to POI",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "jump", kind: "mutation", eventLabel: "Jump to system",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "dock", kind: "mutation", eventLabel: "Dock", params: none },
  { tool: "spacemolt", name: "undock", kind: "mutation", eventLabel: "Undock", params: none },
  { tool: "spacemolt", name: "mine", kind: "mutation", eventLabel: "Mine", params: none },
  { tool: "spacemolt", name: "sell", kind: "mutation", eventLabel: "Sell items",
    params: z.object({ id: z.string(), quantity: z.number().int().min(1) }).strict() },
  { tool: "spacemolt", name: "buy", kind: "mutation", eventLabel: "Buy items",
    params: z.object({ id: z.string(), quantity: z.number().int().min(1) }).strict() },
  { tool: "spacemolt", name: "refuel", kind: "mutation", eventLabel: "Refuel", params: none },
  { tool: "spacemolt", name: "repair", kind: "mutation", eventLabel: "Repair hull", params: none },
  { tool: "spacemolt", name: "attack", kind: "mutation", eventLabel: "Attack target",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "scan", kind: "mutation", eventLabel: "Scan target",
    params: z.object({ id: z.string() }).strict() },
  // --- queries (unlimited, instant) ---
  { tool: "spacemolt", name: "get_status", kind: "query", eventLabel: "Status check", params: none },
  { tool: "spacemolt", name: "get_system", kind: "query", eventLabel: "System scan", params: none },
  { tool: "spacemolt", name: "get_poi", kind: "query", eventLabel: "POI details", params: none },
  { tool: "spacemolt", name: "find_route", kind: "query", eventLabel: "Route planning",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "get_notifications", kind: "query", eventLabel: "Check notifications",
    params: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      types: z.array(z.string()).optional(),
      clear: z.boolean().optional(),
    }).strict() },
];

const byName = new Map(REGISTRY.map((a) => [a.name, a]));

export function getAction(name: string): ActionDef {
  const def = byName.get(name);
  if (!def) throw new Error(`unknown action: ${name}`);
  return def;
}
```

`src/registry/plan.ts`:
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

export const PlanStepSchema = z.union(
  stepSchemas as [typeof stepSchemas[0], typeof stepSchemas[1], ...typeof stepSchemas]
);

export const PlanSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1).max(30),
}).strict();

export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
```

Note: the spec's condition enum mentioned `arrived` and `count_reached` as examples; `travel` blocks until arrival and `repeat` covers counts, so only `cargo_full`/`cargo_empty` exist as conditions. This is the documented deviation.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/registry.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/registry test/registry.test.ts
git commit -m "Add action registry and plan schema (SSOT for game actions)"
```

---

### Task 3: Registry↔OpenAPI conformance test

Prevents silent drift between our hand-curated Zod schemas and the game's published spec (the spec is the SSOT for the game's data model).

**Files:**
- Create: `test/registry-conformance.test.ts`
- Create: `test/fixtures/openapi-slim.json` (checked-in slim copy)
- Create: `scripts/refresh-openapi.ts`

**Interfaces:**
- Consumes: `REGISTRY` from Task 2
- Produces: CI-time guarantee that every registry action exists in the OpenAPI spec with matching required params

- [ ] **Step 1: Write the refresh script**

`scripts/refresh-openapi.ts`:
```ts
// Downloads the live OpenAPI spec and stores a slim fixture: just
// path -> required request params. Run manually when the game updates:
//   bun run scripts/refresh-openapi.ts
const SPEC_URL = "https://www.spacemolt.com/api/v2/openapi.json";

const spec = (await (await fetch(SPEC_URL)).json()) as {
  paths: Record<string, Record<string, {
    requestBody?: { content?: { "application/json"?: { schema?: {
      required?: string[]; properties?: Record<string, unknown>;
    } } } };
  }>>;
};

const slim: Record<string, { required: string[]; properties: string[] }> = {};
for (const [path, methods] of Object.entries(spec.paths)) {
  const post = methods["post"];
  const schema = post?.requestBody?.content?.["application/json"]?.schema;
  if (!schema) continue;
  slim[path] = {
    required: schema.required ?? [],
    properties: Object.keys(schema.properties ?? {}),
  };
}
await Bun.write("test/fixtures/openapi-slim.json", JSON.stringify(slim, null, 2));
console.log(`wrote ${Object.keys(slim).length} paths`);
```

- [ ] **Step 2: Generate the fixture**

Run: `bun run scripts/refresh-openapi.ts`
Expected: `wrote 200+ paths`; `test/fixtures/openapi-slim.json` exists and contains `/api/v2/spacemolt/travel` with `"required": ["id"]`.

- [ ] **Step 3: Write the failing conformance test**

`test/registry-conformance.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { REGISTRY } from "../src/registry/actions";
import slim from "./fixtures/openapi-slim.json";

const fixture = slim as Record<string, { required: string[]; properties: string[] }>;

describe("registry conforms to OpenAPI spec", () => {
  for (const a of REGISTRY) {
    test(`${a.tool}/${a.name}`, () => {
      const entry = fixture[`/api/v2/${a.tool}/${a.name}`];
      expect(entry).toBeDefined(); // action exists in the game API
      const shape = (a.params as z.ZodObject<z.ZodRawShape>).shape;
      // every param we send is a real param
      for (const key of Object.keys(shape)) {
        expect(entry!.properties).toContain(key);
      }
      // every param the API requires, we require (not optional in our schema)
      for (const req of entry!.required) {
        const field = shape[req];
        expect(field).toBeDefined();
        expect(field!.isOptional()).toBe(false);
      }
    });
  }
});
```

- [ ] **Step 4: Run test**

Run: `bun test test/registry-conformance.test.ts`
Expected: PASS. If any action fails, fix the registry entry (the spec is right, we're wrong) — that's the test doing its job.

Note: this task intentionally has no red phase — it's a drift guard expected to pass on day one, and Step 2 needs the network once to generate the checked-in fixture. Tests themselves stay offline.

- [ ] **Step 5: Commit**

```bash
git add scripts/refresh-openapi.ts test/fixtures/openapi-slim.json test/registry-conformance.test.ts
git commit -m "Add registry-vs-OpenAPI conformance test with checked-in slim fixture"
```

---

### Task 4: Fake SpaceMolt server (test infrastructure)

**Files:**
- Create: `test/fake-server.ts`
- Test: `test/fake-server.test.ts`

**Interfaces:**
- Consumes: nothing from src (pure Bun.serve)
- Produces:
  - `function startFakeServer(): FakeServer`
  - `interface FakeServer { url: string; calls: Array<{ tool: string; action: string; body: Record<string, unknown>; sessionId: string | null }>; setHandler(tool: string, action: string, fn: (body: Record<string, unknown>) => object): void; failNextWith(error: { code: string; message: string; retry_after?: number }): void; stop(): void }`
  - Default behavior: `POST /api/v2/session` → fresh session id; unknown actions → `{ result: "ok" }`; requests without `X-Session-Id` on game tools → `session_required` error.

- [ ] **Step 1: Write the failing test**

`test/fake-server.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

describe("fake server", () => {
  test("creates sessions and requires them for game calls", async () => {
    server = startFakeServer();
    const sess = await fetch(`${server.url}/api/v2/session`, { method: "POST" });
    const sessBody = (await sess.json()) as { session: { id: string } };
    expect(sessBody.session.id.length).toBeGreaterThan(0);

    const noSession = await fetch(`${server.url}/api/v2/spacemolt/mine`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    });
    const noSessionBody = (await noSession.json()) as { error: { code: string } };
    expect(noSessionBody.error.code).toBe("session_required");

    const ok = await fetch(`${server.url}/api/v2/spacemolt/mine`, {
      method: "POST", body: "{}",
      headers: { "content-type": "application/json", "X-Session-Id": sessBody.session.id },
    });
    expect(((await ok.json()) as { result: string }).result).toBe("ok");
    expect(server.calls.at(-1)).toMatchObject({ tool: "spacemolt", action: "mine" });
  });

  test("setHandler overrides and failNextWith injects one error", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: { ship: { fuel: 10, max_fuel: 100 } },
    }));
    server.failNextWith({ code: "rate_limited", message: "slow down", retry_after: 1 });

    const sess = await fetch(`${server.url}/api/v2/session`, { method: "POST" });
    const { session } = (await sess.json()) as { session: { id: string } };
    const hdrs = { "content-type": "application/json", "X-Session-Id": session.id };

    const failed = await fetch(`${server.url}/api/v2/spacemolt/get_status`, {
      method: "POST", body: "{}", headers: hdrs,
    });
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    const ok = await fetch(`${server.url}/api/v2/spacemolt/get_status`, {
      method: "POST", body: "{}", headers: hdrs,
    });
    const body = (await ok.json()) as { structuredContent: { ship: { fuel: number } } };
    expect(body.structuredContent.ship.fuel).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fake-server.test.ts`
Expected: FAIL — cannot resolve `./fake-server`.

- [ ] **Step 3: Implement**

`test/fake-server.ts`:
```ts
export interface FakeServer {
  url: string;
  calls: Array<{ tool: string; action: string; body: Record<string, unknown>; sessionId: string | null }>;
  setHandler(tool: string, action: string, fn: (body: Record<string, unknown>) => object): void;
  failNextWith(error: { code: string; message: string; retry_after?: number }): void;
  stop(): void;
}

export function startFakeServer(): FakeServer {
  const calls: FakeServer["calls"] = [];
  const handlers = new Map<string, (body: Record<string, unknown>) => object>();
  const sessions = new Set<string>();
  let pendingError: { code: string; message: string; retry_after?: number } | null = null;
  let sessionCounter = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (o: object) => Response.json(o);

      if (url.pathname === "/api/v2/session" && req.method === "POST") {
        const id = `sess-${++sessionCounter}`;
        sessions.add(id);
        return json({ session: { id } });
      }

      const m = url.pathname.match(/^\/api\/v2\/([^/]+)\/([^/]+)$/);
      if (!m || req.method !== "POST") return json({ error: { code: "unknown_command", message: "no route" } });
      const [, tool, action] = m as unknown as [string, string, string];

      const sessionId = req.headers.get("X-Session-Id");
      const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      calls.push({ tool, action, body, sessionId });

      if (pendingError) {
        const e = pendingError;
        pendingError = null;
        return json({ error: e });
      }
      // auth tool works sessionless in the real API only for register; keep
      // the fake strict: everything needs a session except register.
      if (!sessionId || !sessions.has(sessionId)) {
        if (!(tool === "spacemolt_auth" && action === "register")) {
          return json({ error: { code: "session_required", message: "no session" } });
        }
      }
      const handler = handlers.get(`${tool}/${action}`);
      return json(handler ? handler(body) : { result: "ok" });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    calls,
    setHandler: (tool, action, fn) => void handlers.set(`${tool}/${action}`, fn),
    failNextWith: (error) => void (pendingError = error),
    stop: () => void server.stop(true),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/fake-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/fake-server.ts test/fake-server.test.ts
git commit -m "Add fake SpaceMolt server for offline testing"
```

---

### Task 5: HTTP transport with session and retry handling

**Files:**
- Create: `src/client/http.ts`
- Test: `test/http.test.ts`

**Interfaces:**
- Consumes: fake server from Task 4 (tests only)
- Produces:
  - `class SpacemoltError extends Error { code: string; details?: unknown }`
  - `interface V2Result { result?: string; structuredContent?: unknown; notifications?: EnvelopeNotification[] }`
  - `interface EnvelopeNotification { id: string; type: string; msg_type: string; timestamp: string; data?: unknown }`
  - `class SpacemoltHttp { constructor(baseUrl: string, opts?: { sleep?: (ms: number) => Promise<void> }); onReauth?: () => Promise<void>; createSession(): Promise<void>; call(tool: string, action: string, params?: Record<string, unknown>): Promise<V2Result> }`
  - Behavior: `rate_limited` or `action_pending` → sleep `retry_after` (or legacy `wait_seconds`) seconds, retry (max 3); `session_required`/`session_invalid`/`not_authenticated` → new session + `onReauth()` + retry once; other errors → throw `SpacemoltError`. Note: the v2 OpenAPI error-code list doesn't include `action_pending` (it appears consolidated into `rate_limited`); handling it anyway is one condition and protects against the v1-documented behavior surfacing — an `action_pending` that reached the planner would burn exactly the tokens this design saves.

- [ ] **Step 1: Write the failing test**

`test/http.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { SpacemoltHttp, SpacemoltError } from "../src/client/http";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

const noSleep = { sleep: async () => {} };

describe("SpacemoltHttp", () => {
  test("creates session and sends X-Session-Id", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    const res = await http.call("spacemolt", "get_status");
    expect(res.result).toBe("ok");
    expect(server.calls.at(-1)!.sessionId).toBe("sess-1");
  });

  test("retries after rate_limited", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.failNextWith({ code: "rate_limited", message: "wait", retry_after: 1 });
    const res = await http.call("spacemolt", "mine");
    expect(res.result).toBe("ok");
    // two mine calls hit the server: the failed one and the retry
    expect(server.calls.filter((c) => c.action === "mine").length).toBe(2);
  });

  test("recovers session and re-authenticates on session_invalid", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    let reauths = 0;
    http.onReauth = async () => void reauths++;
    server.failNextWith({ code: "session_invalid", message: "expired" });
    const res = await http.call("spacemolt", "get_poi");
    expect(res.result).toBe("ok");
    expect(reauths).toBe(1);
    expect(server.calls.at(-1)!.sessionId).toBe("sess-2"); // fresh session used
  });

  test("throws SpacemoltError with code on command errors", async () => {
    server = startFakeServer();
    const http = new SpacemoltHttp(server.url, noSleep);
    await http.createSession();
    server.failNextWith({ code: "command_error", message: "cargo full" });
    try {
      await http.call("spacemolt", "mine");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SpacemoltError);
      expect((e as SpacemoltError).code).toBe("command_error");
      expect((e as SpacemoltError).message).toBe("cargo full");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/http.test.ts`
Expected: FAIL — cannot resolve `../src/client/http`.

- [ ] **Step 3: Implement**

`src/client/http.ts`:
```ts
export class SpacemoltError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
    this.name = "SpacemoltError";
  }
}

export interface EnvelopeNotification {
  id: string;
  type: string; // system | combat | trade | chat | friend | tip
  msg_type: string;
  timestamp: string;
  data?: unknown;
}

export interface V2Result {
  result?: string;
  structuredContent?: unknown;
  notifications?: EnvelopeNotification[];
}

interface V2Envelope extends V2Result {
  error?: { code: string; message: string; retry_after?: number; wait_seconds?: number; details?: unknown };
}

const MAX_RATE_RETRIES = 3;

export class SpacemoltHttp {
  private sessionId: string | null = null;
  private sleep: (ms: number) => Promise<void>;
  /** Set by the client after login: re-runs login on a fresh session. */
  onReauth?: () => Promise<void>;

  constructor(private baseUrl: string, opts?: { sleep?: (ms: number) => Promise<void> }) {
    this.sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async createSession(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v2/session`, { method: "POST" });
    const body = (await res.json()) as { session?: { id: string } };
    if (!body.session?.id) throw new SpacemoltError("session_create_failed", "no session id in response");
    this.sessionId = body.session.id;
  }

  async call(tool: string, action: string, params: Record<string, unknown> = {}): Promise<V2Result> {
    let rateRetries = 0;
    let sessionRetried = false;

    for (;;) {
      const res = await fetch(`${this.baseUrl}/api/v2/${tool}/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.sessionId ? { "X-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(params),
        // travel/jump block until arrival; generous timeout per API docs
        signal: AbortSignal.timeout(600_000),
      });
      const body = (await res.json()) as V2Envelope;

      if (!body.error) return body;
      const { code, message, retry_after, wait_seconds, details } = body.error;

      if ((code === "rate_limited" || code === "action_pending") && rateRetries < MAX_RATE_RETRIES) {
        rateRetries++;
        await this.sleep((retry_after ?? wait_seconds ?? 10) * 1000);
        continue;
      }
      if ((code === "session_required" || code === "session_invalid" || code === "not_authenticated") && !sessionRetried) {
        sessionRetried = true;
        await this.createSession();
        await this.onReauth?.();
        continue;
      }
      throw new SpacemoltError(code, message, details);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/http.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/http.ts test/http.test.ts
git commit -m "Add HTTP transport with session recovery and rate-limit retry"
```

---

### Task 6: Game client (register, login, actions, status snapshot)

**Files:**
- Create: `src/client/client.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `SpacemoltHttp`, `V2Result`, `EnvelopeNotification` (Task 5); `getAction` (Task 2)
- Produces:
  - `interface StatusSnapshot { credits: number; fuel: number; maxFuel: number; hull: number; maxHull: number; cargoUsed: number; cargoCapacity: number; docked: boolean; inTransit: boolean }`
  - `interface GameApi { action(name: string, params?: Record<string, unknown>): Promise<V2Result>; status(): Promise<StatusSnapshot>; notifications(): Promise<EnvelopeNotification[]> }`
  - `class SpacemoltClient implements GameApi { constructor(http: SpacemoltHttp); register(username: string, empire: string, registrationCode: string): Promise<{ password: string }>; login(username: string, password: string): Promise<void> }`
  - `action()` validates params against the registry schema before sending (throws `SpacemoltError` code `invalid_params` locally on mismatch).

- [ ] **Step 1: Write the failing test**

`test/client.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { SpacemoltHttp, SpacemoltError } from "../src/client/http";
import { SpacemoltClient } from "../src/client/client";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

function makeClient() {
  const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
  return new SpacemoltClient(http);
}

describe("SpacemoltClient", () => {
  test("register returns password from structuredContent", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "a1b2c3", message: "welcome" },
    }));
    const client = makeClient();
    const { password } = await client.register("TestPilot", "solarian", "REGCODE");
    expect(password).toBe("a1b2c3");
    expect(server.calls.at(-1)!.body).toMatchObject({
      username: "TestPilot", empire: "solarian", registration_code: "REGCODE",
    });
  });

  test("login wires onReauth so session recovery re-authenticates", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "a1b2c3");
    expect(server.calls.at(-1)).toMatchObject({ tool: "spacemolt_auth", action: "login" });

    server.failNextWith({ code: "session_invalid", message: "expired" });
    await client.action("dock");
    // after failure: new session created, login replayed, dock retried
    const actions = server.calls.map((c) => c.action);
    expect(actions.filter((a) => a === "login").length).toBe(2);
    expect(actions.at(-1)).toBe("dock");
  });

  test("action validates params locally before sending", async () => {
    server = startFakeServer();
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const before = server.calls.length;
    await expect(client.action("sell", { id: "iron_ore" })).rejects.toThrow(SpacemoltError);
    expect(server.calls.length).toBe(before); // nothing sent
  });

  test("status() extracts snapshot from get_status", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 40, max_fuel: 100, hull: 80, max_hull: 100, cargo_used: 5, cargo_capacity: 50 },
        player: { credits: 1234 },
        location: { docked_at: "base-1", in_transit: false },
      },
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const s = await client.status();
    expect(s).toEqual({
      credits: 1234, fuel: 40, maxFuel: 100, hull: 80, maxHull: 100,
      cargoUsed: 5, cargoCapacity: 50, docked: true, inTransit: false,
    });
  });

  test("notifications() polls get_notifications", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt", "get_notifications", () => ({
      notifications: [
        { id: "n1", type: "combat", msg_type: "combat_update", timestamp: "2026-07-10T00:00:00Z", data: {} },
      ],
    }));
    const client = makeClient();
    await client.login("TestPilot", "pw");
    const notes = await client.notifications();
    expect(notes.length).toBe(1);
    expect(notes[0]!.type).toBe("combat");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/client.test.ts`
Expected: FAIL — cannot resolve `../src/client/client`.

- [ ] **Step 3: Implement**

`src/client/client.ts`:
```ts
import { z } from "zod";
import { getAction } from "../registry/actions";
import { SpacemoltError, SpacemoltHttp, type EnvelopeNotification, type V2Result } from "./http";

export interface StatusSnapshot {
  credits: number;
  fuel: number;
  maxFuel: number;
  hull: number;
  maxHull: number;
  cargoUsed: number;
  cargoCapacity: number;
  docked: boolean;
  inTransit: boolean;
}

export interface GameApi {
  action(name: string, params?: Record<string, unknown>): Promise<V2Result>;
  status(): Promise<StatusSnapshot>;
  notifications(): Promise<EnvelopeNotification[]>;
}

// Defensive parse of the V2GameState subset we consume; missing fields fall
// back via ?? at the call site. Documented deviation from the spec's
// "generate API types from OpenAPI": response types are hand-written because
// V2GameState is a 16KB kitchen-sink schema where every field is optional —
// generated types would be all-optional anyway, and the conformance test
// (Task 3) guards the request side where drift actually breaks calls.
const StatusSchema = z.object({
  ship: z.object({
    fuel: z.number(), max_fuel: z.number(),
    hull: z.number(), max_hull: z.number(),
    cargo_used: z.number(), cargo_capacity: z.number(),
  }).partial().default({}),
  player: z.object({ credits: z.number() }).partial().default({}),
  location: z.object({
    docked_at: z.string().nullable(),
    in_transit: z.boolean(),
  }).partial().default({}),
});

export class SpacemoltClient implements GameApi {
  private credentials: { username: string; password: string } | null = null;

  constructor(private http: SpacemoltHttp) {}

  async register(username: string, empire: string, registrationCode: string): Promise<{ password: string }> {
    await this.http.createSession();
    const res = await this.http.call("spacemolt_auth", "register", {
      username, empire, registration_code: registrationCode,
    });
    const sc = res.structuredContent as { password?: string } | undefined;
    if (!sc?.password) throw new SpacemoltError("register_failed", "no password in register response");
    return { password: sc.password };
  }

  async login(username: string, password: string): Promise<void> {
    this.credentials = { username, password };
    await this.http.createSession();
    // reauth hook: on session loss the transport replays this login
    this.http.onReauth = async () => {
      await this.http.call("spacemolt_auth", "login", { ...this.credentials });
    };
    await this.http.call("spacemolt_auth", "login", { username, password });
  }

  async action(name: string, params: Record<string, unknown> = {}): Promise<V2Result> {
    const def = getAction(name);
    const parsed = def.params.safeParse(params);
    if (!parsed.success) {
      throw new SpacemoltError("invalid_params", `${name}: ${parsed.error.message}`);
    }
    return this.http.call(def.tool, def.name, parsed.data as Record<string, unknown>);
  }

  async status(): Promise<StatusSnapshot> {
    const res = await this.action("get_status");
    const s = StatusSchema.parse(res.structuredContent ?? {});
    return {
      credits: s.player.credits ?? 0,
      fuel: s.ship.fuel ?? 0, maxFuel: s.ship.max_fuel ?? 0,
      hull: s.ship.hull ?? 0, maxHull: s.ship.max_hull ?? 0,
      cargoUsed: s.ship.cargo_used ?? 0, cargoCapacity: s.ship.cargo_capacity ?? 0,
      docked: s.location.docked_at != null,
      inTransit: s.location.in_transit ?? false,
    };
  }

  async notifications(): Promise<EnvelopeNotification[]> {
    const res = await this.action("get_notifications", { limit: 50 });
    return res.notifications ?? [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/client.ts test/client.test.ts
git commit -m "Add game client with registration, login replay, and status snapshot"
```

---

### Task 7: SQLite store

**Files:**
- Create: `src/store/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `Plan` type (Task 2); `bun:sqlite`
- Produces:
  - `interface AgentEvent { agentId: string; ts: number; type: string; payload: unknown }`
  - `interface PlanCursor { step: number; iteration: number }`
  - `class Store { constructor(path: string); onEvent?: (e: AgentEvent & { id: number }) => void; appendEvent(e: AgentEvent): number; recentEvents(agentId: string, limit: number): Array<AgentEvent & { id: number }>; savePlan(agentId: string, plan: Plan, goals: string[]): void; saveCursor(agentId: string, cursor: PlanCursor): void; loadPlan(agentId: string): { plan: Plan; cursor: PlanCursor; goals: string[] } | null; clearPlan(agentId: string): void; pruneEvents(olderThanDays: number): number; close(): void }`
  - One writer; `onEvent` is the broadcast hook the dashboard server subscribes to in Plan 3.

- [ ] **Step 1: Write the failing test**

`test/store.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Store } from "../src/store/store";
import type { Plan } from "../src/registry/plan";

const plan: Plan = {
  goal: "test",
  steps: [{ action: "mine", params: {}, until: "cargo_full" }],
};

describe("Store", () => {
  test("appends and reads events, fires onEvent", () => {
    const store = new Store(":memory:");
    const seen: number[] = [];
    store.onEvent = (e) => seen.push(e.id);
    const id = store.appendEvent({ agentId: "a1", ts: 1000, type: "action", payload: { x: 1 } });
    expect(id).toBeGreaterThan(0);
    expect(seen).toEqual([id]);
    const events = store.recentEvents("a1", 10);
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ x: 1 });
    expect(store.recentEvents("other", 10).length).toBe(0);
  });

  test("plan round-trips with cursor and goals", () => {
    const store = new Store(":memory:");
    expect(store.loadPlan("a1")).toBeNull();
    store.savePlan("a1", plan, ["get rich"]);
    store.saveCursor("a1", { step: 0, iteration: 3 });
    const loaded = store.loadPlan("a1")!;
    expect(loaded.plan).toEqual(plan);
    expect(loaded.cursor).toEqual({ step: 0, iteration: 3 });
    expect(loaded.goals).toEqual(["get rich"]);
    store.clearPlan("a1");
    expect(store.loadPlan("a1")).toBeNull();
  });

  test("savePlan resets cursor to step 0", () => {
    const store = new Store(":memory:");
    store.savePlan("a1", plan, []);
    store.saveCursor("a1", { step: 0, iteration: 5 });
    store.savePlan("a1", plan, []); // replan
    expect(store.loadPlan("a1")!.cursor).toEqual({ step: 0, iteration: 0 });
  });

  test("prunes old events", () => {
    const store = new Store(":memory:");
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1000;
    store.appendEvent({ agentId: "a1", ts: old, type: "action", payload: null });
    store.appendEvent({ agentId: "a1", ts: now, type: "action", payload: null });
    const pruned = store.pruneEvents(30);
    expect(pruned).toBe(1);
    expect(store.recentEvents("a1", 10).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/store.test.ts`
Expected: FAIL — cannot resolve `../src/store/store`.

- [ ] **Step 3: Implement**

`src/store/store.ts`:
```ts
import { Database } from "bun:sqlite";
import { PlanSchema, type Plan } from "../registry/plan";

export interface AgentEvent {
  agentId: string;
  ts: number; // epoch ms
  type: string;
  payload: unknown;
}

export interface PlanCursor {
  step: number;
  iteration: number;
}

export class Store {
  private db: Database;
  /** Broadcast hook: dashboard server subscribes here (Plan 3). */
  onEvent?: (e: AgentEvent & { id: number }) => void;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent_id, ts);
      CREATE TABLE IF NOT EXISTS plans (
        agent_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        step INTEGER NOT NULL DEFAULT 0,
        iteration INTEGER NOT NULL DEFAULT 0,
        goals TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  appendEvent(e: AgentEvent): number {
    const row = this.db
      .query("INSERT INTO events (agent_id, ts, type, payload) VALUES (?, ?, ?, ?) RETURNING id")
      .get(e.agentId, e.ts, e.type, JSON.stringify(e.payload ?? null)) as { id: number };
    this.onEvent?.({ ...e, id: row.id });
    return row.id;
  }

  recentEvents(agentId: string, limit: number): Array<AgentEvent & { id: number }> {
    const rows = this.db
      .query("SELECT id, agent_id, ts, type, payload FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
      .all(agentId, limit) as Array<{ id: number; agent_id: string; ts: number; type: string; payload: string }>;
    return rows.reverse().map((r) => ({
      id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload),
    }));
  }

  savePlan(agentId: string, plan: Plan, goals: string[]): void {
    this.db
      .query(`INSERT INTO plans (agent_id, plan, step, iteration, goals) VALUES (?, ?, 0, 0, ?)
              ON CONFLICT(agent_id) DO UPDATE SET plan = excluded.plan, step = 0, iteration = 0, goals = excluded.goals`)
      .run(agentId, JSON.stringify(plan), JSON.stringify(goals));
  }

  saveCursor(agentId: string, cursor: PlanCursor): void {
    this.db
      .query("UPDATE plans SET step = ?, iteration = ? WHERE agent_id = ?")
      .run(cursor.step, cursor.iteration, agentId);
  }

  loadPlan(agentId: string): { plan: Plan; cursor: PlanCursor; goals: string[] } | null {
    const row = this.db
      .query("SELECT plan, step, iteration, goals FROM plans WHERE agent_id = ?")
      .get(agentId) as { plan: string; step: number; iteration: number; goals: string } | null;
    if (!row) return null;
    return {
      plan: PlanSchema.parse(JSON.parse(row.plan)),
      cursor: { step: row.step, iteration: row.iteration },
      goals: JSON.parse(row.goals),
    };
  }

  clearPlan(agentId: string): void {
    this.db.query("DELETE FROM plans WHERE agent_id = ?").run(agentId);
  }

  pruneEvents(olderThanDays: number): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const res = this.db.query("DELETE FROM events WHERE ts < ?").run(cutoff);
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts test/store.test.ts
git commit -m "Add SQLite store: events with broadcast hook, plans with step cursor"
```

---

### Task 8: Plan executor

**Files:**
- Create: `src/agent/executor.ts`
- Test: `test/executor.test.ts`

**Interfaces:**
- Consumes: `GameApi`, `StatusSnapshot` (Task 6); `Plan`, `PlanStep` (Task 2); `PlanCursor` (Task 7); `SpacemoltError` (Task 5)
- Produces:
  - `type StepResult = { kind: "continue"; cursor: PlanCursor } | { kind: "plan_done" } | { kind: "blocked"; reason: string }`
  - `async function executeTick(api: GameApi, plan: Plan, cursor: PlanCursor): Promise<StepResult>`
  - Semantics: runs exactly one game mutation. Step completes when: no `until`/`repeat` (single-shot), or `until` condition true after the action, or `iteration + 1 >= repeat`. Completed final step → `plan_done`. `SpacemoltError` from the action → `blocked` with the error message (transport has already absorbed retryable errors).

- [ ] **Step 1: Write the failing test**

`test/executor.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { executeTick } from "../src/agent/executor";
import { SpacemoltError, type V2Result } from "../src/client/http";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { Plan } from "../src/registry/plan";

function stubApi(overrides?: Partial<{ status: StatusSnapshot; failWith: SpacemoltError }>) {
  const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const status: StatusSnapshot = overrides?.status ?? {
    credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  const api: GameApi = {
    async action(name, params): Promise<V2Result> {
      calls.push({ name, params });
      if (overrides?.failWith) throw overrides.failWith;
      return { result: "ok" };
    },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls };
}

describe("executeTick", () => {
  test("single-shot step advances cursor", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [
      { action: "dock", params: {} },
      { action: "undock", params: {} },
    ]};
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 } });
    expect(calls).toEqual([{ name: "dock", params: {} }]);
  });

  test("until step repeats while condition unmet, completes when met", async () => {
    const plan: Plan = { goal: "g", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    const notFull = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 10, cargoCapacity: 50, docked: false, inTransit: false,
    }});
    const r1 = await executeTick(notFull.api, plan, { step: 0, iteration: 0 });
    expect(r1).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 } });

    const full = stubApi({ status: {
      credits: 0, fuel: 50, maxFuel: 100, hull: 100, maxHull: 100,
      cargoUsed: 50, cargoCapacity: 50, docked: false, inTransit: false,
    }});
    const r2 = await executeTick(full.api, plan, { step: 0, iteration: 3 });
    expect(r2).toEqual({ kind: "plan_done" }); // only step, now complete
  });

  test("repeat step counts iterations", async () => {
    const { api } = stubApi();
    const plan: Plan = { goal: "g", steps: [
      { action: "mine", params: {}, repeat: 3 },
      { action: "dock", params: {} },
    ]};
    const r1 = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r1).toEqual({ kind: "continue", cursor: { step: 0, iteration: 1 } });
    const r3 = await executeTick(api, plan, { step: 0, iteration: 2 });
    expect(r3).toEqual({ kind: "continue", cursor: { step: 1, iteration: 0 } });
  });

  test("last step completion returns plan_done", async () => {
    const { api } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "dock", params: {} }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done" });
  });

  test("game error blocks the plan with reason", async () => {
    const { api } = stubApi({ failWith: new SpacemoltError("command_error", "not enough fuel") });
    const plan: Plan = { goal: "g", steps: [{ action: "jump", params: { id: "sys-2" } }] };
    const r = await executeTick(api, plan, { step: 0, iteration: 0 });
    expect(r).toEqual({ kind: "blocked", reason: "not enough fuel" });
  });

  test("cursor past plan end returns plan_done without acting", async () => {
    const { api, calls } = stubApi();
    const plan: Plan = { goal: "g", steps: [{ action: "dock", params: {} }] };
    const r = await executeTick(api, plan, { step: 5, iteration: 0 });
    expect(r).toEqual({ kind: "plan_done" });
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/executor.test.ts`
Expected: FAIL — cannot resolve `../src/agent/executor`.

- [ ] **Step 3: Implement**

`src/agent/executor.ts`:
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

/** Runs exactly one game mutation and reports where the plan stands. */
export async function executeTick(api: GameApi, plan: Plan, cursor: PlanCursor): Promise<StepResult> {
  const step = plan.steps[cursor.step];
  if (!step) return { kind: "plan_done" };

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
  const next = cursor.step + 1;
  if (next >= plan.steps.length) return { kind: "plan_done" };
  return { kind: "continue", cursor: { step: next, iteration: 0 } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/executor.ts test/executor.test.ts
git commit -m "Add deterministic plan executor: one mutation per tick, zero tokens"
```

---

### Task 9: Wake-condition evaluation

**Files:**
- Create: `src/agent/wake.ts`
- Test: `test/wake.test.ts`

**Interfaces:**
- Consumes: `StatusSnapshot` (Task 6), `EnvelopeNotification` (Task 5)
- Produces:
  - `type WakeReason = { reason: "no_plan" | "plan_done" | "blocked" | "instruction" | "notification" | "low_fuel" | "low_hull" | "heartbeat"; detail?: string }`
  - `interface WakeInput { planState: "none" | "running" | "done" | "blocked"; blockedReason?: string; instruction?: string; notifications: EnvelopeNotification[]; status: StatusSnapshot | null; lastPlanAt: number; now: number; heartbeatMs: number; fuelPct: number; hullPct: number; wakeNotificationTypes: string[] }`
  - `function evaluateWake(input: WakeInput): WakeReason | null`
  - Priority order (first match wins): instruction → blocked → no_plan/plan_done → notification → low_fuel → low_hull → heartbeat.

- [ ] **Step 1: Write the failing test**

`test/wake.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { evaluateWake, type WakeInput } from "../src/agent/wake";

const base: WakeInput = {
  planState: "running",
  notifications: [],
  status: {
    credits: 0, fuel: 80, maxFuel: 100, hull: 90, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  },
  lastPlanAt: 1_000_000,
  now: 1_000_000 + 60_000, // 1 min since last plan
  heartbeatMs: 15 * 60_000,
  fuelPct: 20,
  hullPct: 30,
  wakeNotificationTypes: ["combat", "chat"],
};

describe("evaluateWake", () => {
  test("healthy running plan does not wake", () => {
    expect(evaluateWake(base)).toBeNull();
  });

  test("instruction beats everything", () => {
    const r = evaluateWake({ ...base, planState: "blocked", instruction: "go home" });
    expect(r).toEqual({ reason: "instruction", detail: "go home" });
  });

  test("blocked plan wakes with reason", () => {
    const r = evaluateWake({ ...base, planState: "blocked", blockedReason: "no fuel" });
    expect(r).toEqual({ reason: "blocked", detail: "no fuel" });
  });

  test("no plan and plan done wake", () => {
    expect(evaluateWake({ ...base, planState: "none" })).toEqual({ reason: "no_plan" });
    expect(evaluateWake({ ...base, planState: "done" })).toEqual({ reason: "plan_done" });
  });

  test("only configured notification types wake", () => {
    const combat = { id: "n1", type: "combat", msg_type: "combat_update", timestamp: "t" };
    const tip = { id: "n2", type: "tip", msg_type: "tip", timestamp: "t" };
    expect(evaluateWake({ ...base, notifications: [tip] })).toBeNull();
    const r = evaluateWake({ ...base, notifications: [tip, combat] });
    expect(r).toEqual({ reason: "notification", detail: "combat_update" });
  });

  test("critical msg_types wake regardless of type filter", () => {
    // player_died arrives as type "system", which is not in the default
    // type filter — it must wake anyway
    const died = { id: "n3", type: "system", msg_type: "player_died", timestamp: "t" };
    const r = evaluateWake({ ...base, notifications: [died] });
    expect(r).toEqual({ reason: "notification", detail: "player_died" });
  });

  test("low fuel and low hull thresholds", () => {
    const low = { ...base.status!, fuel: 19 };
    expect(evaluateWake({ ...base, status: low })).toEqual({ reason: "low_fuel", detail: "19/100" });
    const hurt = { ...base.status!, hull: 25 };
    expect(evaluateWake({ ...base, status: hurt })).toEqual({ reason: "low_hull", detail: "25/100" });
  });

  test("heartbeat fires after interval", () => {
    const r = evaluateWake({ ...base, now: base.lastPlanAt + base.heartbeatMs + 1 });
    expect(r).toEqual({ reason: "heartbeat" });
  });

  test("null status skips threshold checks", () => {
    expect(evaluateWake({ ...base, status: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/wake.test.ts`
Expected: FAIL — cannot resolve `../src/agent/wake`.

- [ ] **Step 3: Implement**

`src/agent/wake.ts`:
```ts
import type { EnvelopeNotification } from "../client/http";
import type { StatusSnapshot } from "../client/client";

export type WakeReason = {
  reason: "no_plan" | "plan_done" | "blocked" | "instruction" | "notification"
    | "low_fuel" | "low_hull" | "heartbeat";
  detail?: string;
};

export interface WakeInput {
  planState: "none" | "running" | "done" | "blocked";
  blockedReason?: string;
  instruction?: string;
  notifications: EnvelopeNotification[];
  status: StatusSnapshot | null;
  lastPlanAt: number;
  now: number;
  heartbeatMs: number;
  fuelPct: number; // wake when fuel below this % of max
  hullPct: number;
  wakeNotificationTypes: string[]; // e.g. ["combat", "chat"]
}

// Always wake on these regardless of the configured type filter — they can
// arrive under type "system", which the default filter excludes.
const CRITICAL_MSG_TYPES = ["player_died"];

/** First matching wake reason wins; null means the executor keeps driving. */
export function evaluateWake(i: WakeInput): WakeReason | null {
  if (i.instruction) return { reason: "instruction", detail: i.instruction };
  if (i.planState === "blocked") return { reason: "blocked", detail: i.blockedReason };
  if (i.planState === "none") return { reason: "no_plan" };
  if (i.planState === "done") return { reason: "plan_done" };

  const notable = i.notifications.find(
    (n) => i.wakeNotificationTypes.includes(n.type) || CRITICAL_MSG_TYPES.includes(n.msg_type)
  );
  if (notable) return { reason: "notification", detail: notable.msg_type };

  if (i.status) {
    const { fuel, maxFuel, hull, maxHull } = i.status;
    if (maxFuel > 0 && (fuel / maxFuel) * 100 < i.fuelPct)
      return { reason: "low_fuel", detail: `${fuel}/${maxFuel}` };
    if (maxHull > 0 && (hull / maxHull) * 100 < i.hullPct)
      return { reason: "low_hull", detail: `${hull}/${maxHull}` };
  }

  if (i.now - i.lastPlanAt > i.heartbeatMs) return { reason: "heartbeat" };
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/wake.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/wake.ts test/wake.test.ts
git commit -m "Add wake-condition evaluation with priority ordering"
```

---

### Task 10: Planner interface and mock

**Files:**
- Create: `src/planner/types.ts`
- Create: `src/planner/mock.ts`
- Test: `test/mock-planner.test.ts`

**Interfaces:**
- Consumes: `Plan` (Task 2), `WakeReason` (Task 9)
- Produces:
  - `interface PlanContext { persona: string; goals: string[]; wake: WakeReason; statusSummary: string; recentEvents: string[]; instruction?: string }`
  - `interface Planner { plan(ctx: PlanContext): Promise<Plan> }`
  - `class MockPlanner implements Planner { constructor(plans: Plan[]); contexts: PlanContext[] }` — returns queued plans in order (repeats last), records every context it was called with.

- [ ] **Step 1: Write the failing test**

`test/mock-planner.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { MockPlanner } from "../src/planner/mock";
import type { Plan } from "../src/registry/plan";

const p1: Plan = { goal: "one", steps: [{ action: "dock", params: {} }] };
const p2: Plan = { goal: "two", steps: [{ action: "undock", params: {} }] };

describe("MockPlanner", () => {
  test("returns queued plans in order, repeats last, records contexts", async () => {
    const planner = new MockPlanner([p1, p2]);
    const ctx = {
      persona: "test", goals: [], wake: { reason: "no_plan" as const },
      statusSummary: "", recentEvents: [],
    };
    expect((await planner.plan(ctx)).goal).toBe("one");
    expect((await planner.plan(ctx)).goal).toBe("two");
    expect((await planner.plan(ctx)).goal).toBe("two"); // repeats last
    expect(planner.contexts.length).toBe(3);
    expect(planner.contexts[0]!.wake.reason).toBe("no_plan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/mock-planner.test.ts`
Expected: FAIL — cannot resolve `../src/planner/mock`.

- [ ] **Step 3: Implement**

`src/planner/types.ts`:
```ts
import type { Plan } from "../registry/plan";
import type { WakeReason } from "../agent/wake";

export interface PlanContext {
  persona: string;
  goals: string[];
  wake: WakeReason;
  statusSummary: string; // compact one-line status, not a state dump
  recentEvents: string[]; // last few event labels for context
  instruction?: string;
}

export interface Planner {
  plan(ctx: PlanContext): Promise<Plan>;
}
```

`src/planner/mock.ts`:
```ts
import type { Plan } from "../registry/plan";
import type { PlanContext, Planner } from "./types";

export class MockPlanner implements Planner {
  contexts: PlanContext[] = [];
  private i = 0;

  constructor(private plans: Plan[]) {
    if (plans.length === 0) throw new Error("MockPlanner needs at least one plan");
  }

  async plan(ctx: PlanContext): Promise<Plan> {
    this.contexts.push(ctx);
    const plan = this.plans[Math.min(this.i, this.plans.length - 1)]!;
    this.i++;
    return plan;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/mock-planner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planner test/mock-planner.test.ts
git commit -m "Add Planner interface and mock implementation"
```

---

### Task 11: Agent loop

**Files:**
- Create: `src/agent/agent.ts`
- Test: `test/agent.test.ts`

**Interfaces:**
- Consumes: `GameApi` (Task 6), `Store`, `PlanCursor` (Task 7), `executeTick` (Task 8), `evaluateWake` (Task 9), `Planner`, `PlanContext` (Task 10)
- Produces:
  - `interface AgentConfig { fuelPct: number; hullPct: number; heartbeatMinutes: number; wakeNotificationTypes: string[] }`
  - `class Agent { constructor(opts: { id: string; persona: string; api: GameApi; store: Store; planner: Planner; config: AgentConfig; now?: () => number }); instruct(text: string): void; runOnce(): Promise<void>; start(intervalMs?: number): void; stop(): void }`
  - `runOnce()` = one loop iteration: poll notifications + status → evaluate wake → replan (persisting plan+goals, emitting `plan` event) or execute one tick (persisting cursor, emitting `action` event). Emits `wake` events with reason. `now` injectable for tests.

- [ ] **Step 1: Write the failing test**

`test/agent.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { Plan } from "../src/registry/plan";

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat", "chat"],
};

function stubApi() {
  const calls: string[] = [];
  const status: StatusSnapshot = {
    credits: 100, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
    cargoUsed: 0, cargoCapacity: 50, docked: false, inTransit: false,
  };
  const api: GameApi = {
    async action(name): Promise<V2Result> { calls.push(name); return { result: "ok" }; },
    async status() { return status; },
    async notifications() { return []; },
  };
  return { api, calls, status };
}

const miningPlan: Plan = { goal: "mine a bit", steps: [
  { action: "mine", params: {}, repeat: 2 },
  { action: "dock", params: {} },
]};

function makeAgent(plans: Plan[]) {
  const { api, calls } = stubApi();
  const store = new Store(":memory:");
  const planner = new MockPlanner(plans);
  const agent = new Agent({
    id: "a1", persona: "test miner", api, store, planner, config, now: () => 1_000_000,
  });
  return { agent, store, planner, calls };
}

describe("Agent.runOnce", () => {
  test("no plan -> plans, then executes tick by tick to completion", async () => {
    const { agent, store, planner, calls } = makeAgent([miningPlan]);

    await agent.runOnce(); // wake: no_plan -> replan (no action yet)
    expect(planner.contexts.length).toBe(1);
    expect(planner.contexts[0]!.wake.reason).toBe("no_plan");
    expect(store.loadPlan("a1")!.plan.goal).toBe("mine a bit");
    expect(calls.filter((c) => c !== "get_status" && c !== "get_notifications")).toEqual([]);

    await agent.runOnce(); // mine (iteration 1 of 2)
    await agent.runOnce(); // mine (iteration 2 of 2)
    await agent.runOnce(); // dock -> plan done
    const mutations = calls.filter((c) => c !== "get_status" && c !== "get_notifications");
    expect(mutations).toEqual(["mine", "mine", "dock"]);
    expect(store.loadPlan("a1")).toBeNull(); // done plan cleared

    await agent.runOnce(); // wake: plan_done -> replans (MockPlanner repeats last)
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts[1]!.wake.reason).toBe("plan_done");
  });

  test("cursor persists across restart (new Agent, same store)", async () => {
    const { api } = stubApi();
    const store = new Store(":memory:");
    const planner = new MockPlanner([miningPlan]);
    const a1 = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 1 });
    await a1.runOnce(); // plan
    await a1.runOnce(); // mine 1/2
    expect(store.loadPlan("a1")!.cursor).toEqual({ step: 0, iteration: 1 });

    // "restart": fresh Agent instance on the same store resumes mid-plan
    const a2 = new Agent({ id: "a1", persona: "p", api, store, planner, config, now: () => 2 });
    await a2.runOnce();
    expect(store.loadPlan("a1")!.cursor).toEqual({ step: 1, iteration: 0 }); // mine done, dock next
  });

  test("instruction aborts plan and replans with instruction in context", async () => {
    const { agent, planner } = makeAgent([miningPlan, {
      goal: "obey", steps: [{ action: "undock", params: {} }],
    }]);
    await agent.runOnce(); // initial plan
    agent.instruct("stop mining, go explore");
    await agent.runOnce(); // instruction wake -> replan
    expect(planner.contexts.length).toBe(2);
    expect(planner.contexts[1]!.wake.reason).toBe("instruction");
    expect(planner.contexts[1]!.instruction).toBe("stop mining, go explore");
  });

  test("emits wake, plan, and action events", async () => {
    const { agent, store } = makeAgent([miningPlan]);
    await agent.runOnce();
    await agent.runOnce();
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("wake");
    expect(types).toContain("plan");
    expect(types).toContain("action");
  });

  test("planner failure emits planner_error without throwing", async () => {
    const { api } = stubApi();
    const store = new Store(":memory:");
    const failing = { plan: async () => { throw new Error("provider down"); } };
    const agent = new Agent({ id: "a1", persona: "p", api, store, planner: failing, config, now: () => 1 });
    await agent.runOnce(); // must not throw
    const types = store.recentEvents("a1", 10).map((e) => e.type);
    expect(types).toContain("planner_error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/agent.test.ts`
Expected: FAIL — cannot resolve `../src/agent/agent`.

- [ ] **Step 3: Implement**

`src/agent/agent.ts`:
```ts
import type { GameApi } from "../client/client";
import type { Store, PlanCursor } from "../store/store";
import type { Plan } from "../registry/plan";
import type { Planner } from "../planner/types";
import { executeTick } from "./executor";
import { evaluateWake, type WakeReason } from "./wake";

export interface AgentConfig {
  fuelPct: number;
  hullPct: number;
  heartbeatMinutes: number;
  wakeNotificationTypes: string[];
}

export class Agent {
  readonly id: string;
  private persona: string;
  private api: GameApi;
  private store: Store;
  private planner: Planner;
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

  constructor(opts: {
    id: string; persona: string; api: GameApi; store: Store;
    planner: Planner; config: AgentConfig; now?: () => number;
  }) {
    this.id = opts.id;
    this.persona = opts.persona;
    this.api = opts.api;
    this.store = opts.store;
    this.planner = opts.planner;
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
      this.api.status().catch(() => null),
    ]);

    const instruction = this.inbox.shift();
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
      await this.replan(wake, status, instruction);
      return;
    }
    if (this.plan && this.planState === "running") {
      await this.executeOne();
    }
  }

  private async replan(wake: WakeReason, status: unknown, instruction?: string): Promise<void> {
    this.emit("wake", wake);
    if (instruction) this.goals.push(instruction); // persistent effect via goals
    try {
      const plan = await this.planner.plan({
        persona: this.persona,
        goals: this.goals,
        wake,
        statusSummary: status ? JSON.stringify(status) : "status unavailable",
        recentEvents: this.store.recentEvents(this.id, 5).map((e) => e.type),
        instruction,
      });
      this.plan = plan;
      this.cursor = { step: 0, iteration: 0 };
      this.planState = "running";
      this.blockedReason = undefined;
      this.lastPlanAt = this.now();
      this.store.savePlan(this.id, plan, this.goals);
      this.emit("plan", { goal: plan.goal, steps: plan.steps.length, wake: wake.reason });
    } catch (e) {
      // stalled, not crashed: heartbeat keeps retrying. Failure classes
      // (transient vs subscription-limit) are Plan 2's real-planner concern.
      this.emit("planner_error", { message: e instanceof Error ? e.message : String(e) });
    }
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/agent.test.ts`
Expected: PASS. Also run `bun test` (full suite) — all previous tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent.ts test/agent.test.ts
git commit -m "Add agent loop: wake evaluation, replan, tick execution, crash resume"
```

---

### Task 12: Config, registration bootstrap, and main entry

**Files:**
- Create: `src/config/config.ts`
- Create: `src/main.ts`
- Create: `agents.example.yaml`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `SpacemoltHttp`, `SpacemoltClient` (Tasks 5-6), `Store` (Task 7), `Agent`, `AgentConfig` (Task 11), `MockPlanner` (Task 10)
- Produces:
  - `interface AgentEntry { id: string; username: string; empire: "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim"; persona: string; planner: { provider: "mock" | "claude-subscription" | "ollama"; model?: string }; fuelPct: number; hullPct: number; heartbeatMinutes: number; wakeNotificationTypes: string[] }`
  - `interface HarnessConfig { serverUrl: string; dbPath: string; agents: AgentEntry[] }`
  - `function loadConfig(path: string): HarnessConfig` (Zod-validated, defaults applied)
  - `async function ensureCredentials(client: SpacemoltClient, entry: AgentEntry, secretsDir: string): Promise<string>` — returns password; registers and writes `secrets/<id>_password` only if the file doesn't exist (idempotent).

- [ ] **Step 1: Write the failing test**

`test/config.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ensureCredentials } from "../src/config/config";
import { SpacemoltHttp } from "../src/client/http";
import { SpacemoltClient } from "../src/client/client";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

const yaml = `
server_url: http://localhost:9999
db_path: ./harness.sqlite
agents:
  - id: miner
    username: Test Miner
    empire: nebula
    persona: "A patient ore miner."
    planner: { provider: mock }
  - id: scout
    username: Test Scout
    empire: outerrim
    persona: "A curious explorer."
    planner: { provider: mock }
    fuel_pct: 35
    heartbeat_minutes: 5
`;

describe("loadConfig", () => {
  test("parses yaml with defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml);
    const cfg = loadConfig(path);
    expect(cfg.serverUrl).toBe("http://localhost:9999");
    expect(cfg.agents.length).toBe(2);
    const miner = cfg.agents[0]!;
    expect(miner.fuelPct).toBe(20); // default
    expect(miner.heartbeatMinutes).toBe(15); // default
    expect(miner.wakeNotificationTypes).toEqual(["combat", "chat"]); // default
    expect(cfg.agents[1]!.fuelPct).toBe(35); // override
    expect(cfg.agents[1]!.heartbeatMinutes).toBe(5);
  });

  test("rejects bad empire", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml.replace("nebula", "klingon"));
    expect(() => loadConfig(path)).toThrow();
  });
});

describe("ensureCredentials", () => {
  test("registers once, then reuses password file", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "secret-pw" },
    }));
    const secretsDir = mkdtempSync(join(tmpdir(), "smsec-"));
    writeFileSync(join(secretsDir, "registration_code"), "REG123\n");

    const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const entry = {
      id: "miner", username: "Test Miner", empire: "nebula" as const,
      persona: "p", planner: { provider: "mock" as const },
      fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
    };

    const pw1 = await ensureCredentials(client, entry, secretsDir);
    expect(pw1).toBe("secret-pw");
    expect(existsSync(join(secretsDir, "miner_password"))).toBe(true);
    expect(readFileSync(join(secretsDir, "miner_password"), "utf8").trim()).toBe("secret-pw");
    expect(server.calls.filter((c) => c.action === "register").length).toBe(1);

    const pw2 = await ensureCredentials(client, entry, secretsDir);
    expect(pw2).toBe("secret-pw");
    expect(server.calls.filter((c) => c.action === "register").length).toBe(1); // no second register
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config/config`.

- [ ] **Step 3: Implement config**

`src/config/config.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SpacemoltClient } from "../client/client";

const AgentEntrySchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(24),
  empire: z.enum(["solarian", "voidborn", "crimson", "nebula", "outerrim"]),
  persona: z.string().min(1),
  planner: z.object({
    provider: z.enum(["mock", "claude-subscription", "ollama"]),
    model: z.string().optional(),
  }),
  fuel_pct: z.number().min(0).max(100).default(20),
  hull_pct: z.number().min(0).max(100).default(30),
  heartbeat_minutes: z.number().min(1).default(15),
  wake_notification_types: z.array(z.string()).default(["combat", "chat"]),
});

const ConfigSchema = z.object({
  server_url: z.string().url(),
  db_path: z.string().default("./harness.sqlite"),
  agents: z.array(AgentEntrySchema).min(1),
});

export interface AgentEntry {
  id: string;
  username: string;
  empire: "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim";
  persona: string;
  planner: { provider: "mock" | "claude-subscription" | "ollama"; model?: string };
  fuelPct: number;
  hullPct: number;
  heartbeatMinutes: number;
  wakeNotificationTypes: string[];
}

export interface HarnessConfig {
  serverUrl: string;
  dbPath: string;
  agents: AgentEntry[];
}

export function loadConfig(path: string): HarnessConfig {
  const raw = ConfigSchema.parse(Bun.YAML.parse(readFileSync(path, "utf8")));
  return {
    serverUrl: raw.server_url,
    dbPath: raw.db_path,
    agents: raw.agents.map((a) => ({
      id: a.id, username: a.username, empire: a.empire, persona: a.persona,
      planner: a.planner,
      fuelPct: a.fuel_pct, hullPct: a.hull_pct,
      heartbeatMinutes: a.heartbeat_minutes,
      wakeNotificationTypes: a.wake_notification_types,
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

- [ ] **Step 5: Write the end-to-end integration test (spec's "agent loops run end-to-end" requirement)**

Create `test/integration.test.ts` — the full stack with no stubs: `Agent → SpacemoltClient → SpacemoltHttp → fake server`, through registration, login, a complete plan lifecycle, and a session drop mid-plan:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { SpacemoltClient } from "../src/client/client";
import { SpacemoltHttp } from "../src/client/http";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import type { Plan } from "../src/registry/plan";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

describe("end-to-end: agent through real client against fake server", () => {
  test("register, login, full plan lifecycle, session recovery", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "e2e-pw" },
    }));
    // cargo fills after the second mine call
    let mines = 0;
    server.setHandler("spacemolt", "mine", () => ({ result: String(++mines) }));
    server.setHandler("spacemolt", "get_status", () => ({
      structuredContent: {
        ship: { fuel: 90, max_fuel: 100, hull: 100, max_hull: 100,
                cargo_used: mines >= 2 ? 50 : mines * 10, cargo_capacity: 50 },
        player: { credits: 0 },
        location: { docked_at: null, in_transit: false },
      },
    }));

    const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const { password } = await client.register("E2E Pilot", "nebula", "REG");
    await client.login("E2E Pilot", password);

    const plan: Plan = { goal: "mine until full then dock", steps: [
      { action: "mine", params: {}, until: "cargo_full" },
      { action: "dock", params: {} },
    ]};
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "e2e", persona: "e2e test pilot", api: client, store,
      planner: new MockPlanner([plan]),
      config: { fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"] },
      now: () => 1_000_000,
    });

    await agent.runOnce(); // no_plan -> plan
    await agent.runOnce(); // mine 1 (cargo 10/50, continue)
    // drop the session mid-plan: transport must recover + re-login transparently
    server.failNextWith({ code: "session_invalid", message: "expired" });
    await agent.runOnce(); // mine 2 (cargo 50/50, step done)
    await agent.runOnce(); // dock -> plan_done

    const gameMutations = server.calls
      .map((c) => c.action)
      .filter((a) => ["mine", "dock"].includes(a));
    expect(gameMutations).toEqual(["mine", "mine", "mine", "dock"]); // 3rd mine = retry after recovery
    expect(server.calls.filter((c) => c.action === "login").length).toBe(2); // initial + replay
    expect(store.loadPlan("e2e")).toBeNull(); // plan completed and cleared
    const types = store.recentEvents("e2e", 50).map((e) => e.type);
    expect(types).toContain("plan");
    expect(types).toContain("action");
  });
});
```

Run: `bun test test/integration.test.ts`
Expected: PASS. (Note: the session drop consumes one `mine` call that errors, then the retry succeeds — hence 3 mine calls at the server for 2 successful mutations. `mines` increments only on handled calls; `failNextWith` short-circuits before the handler, so cargo math stays correct.)

- [ ] **Step 6: Write main entry and example config**

`src/main.ts`:
```ts
import { loadConfig } from "./config/config";
import { ensureCredentials } from "./config/config";
import { SpacemoltHttp } from "./client/http";
import { SpacemoltClient } from "./client/client";
import { Store } from "./store/store";
import { Agent } from "./agent/agent";
import { MockPlanner } from "./planner/mock";
import type { Planner } from "./planner/types";

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

function makePlanner(provider: string): Planner {
  // Plan 2 adds claude-subscription and ollama here.
  if (provider !== "mock") {
    throw new Error(`planner provider "${provider}" not implemented yet (Plan 2) — use "mock"`);
  }
  return new MockPlanner([
    { goal: "idle survey", steps: [{ action: "undock", params: {} }] },
  ]);
}

const agents: Agent[] = [];
for (const entry of config.agents) {
  const http = new SpacemoltHttp(config.serverUrl);
  const client = new SpacemoltClient(http);
  const password = await ensureCredentials(client, entry, SECRETS_DIR);
  await client.login(entry.username, password);
  const agent = new Agent({
    id: entry.id,
    persona: entry.persona,
    api: client,
    store,
    planner: makePlanner(entry.planner.provider),
    config: {
      fuelPct: entry.fuelPct, hullPct: entry.hullPct,
      heartbeatMinutes: entry.heartbeatMinutes,
      wakeNotificationTypes: entry.wakeNotificationTypes,
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

`agents.example.yaml`:
```yaml
# Copy to agents.yaml and adjust. Passwords are auto-created in secrets/
# on first run; put your registration code (from spacemolt.com/dashboard)
# in secrets/registration_code first.
server_url: https://game.spacemolt.com
db_path: ./harness.sqlite
agents:
  - id: miner
    username: REPLACE_ME_1
    empire: nebula            # cargo bonus suits a miner/trader
    persona: >
      A pragmatic ore miner and trader. Priorities: fill cargo, sell at the
      best nearby price, keep fuel above 25%, avoid combat entirely.
    planner: { provider: mock }   # Plan 2: claude-subscription | ollama
  - id: scout
    username: REPLACE_ME_2
    empire: outerrim          # speed bonus suits an explorer
    persona: >
      A methodical explorer. Priorities: visit unvisited adjacent systems,
      survey POIs, log discoveries, retreat from any hostile contact.
    planner: { provider: mock }
    heartbeat_minutes: 10
  - id: corsair
    username: REPLACE_ME_3
    empire: crimson           # weapons bonus suits a combat pilot
    persona: >
      An opportunistic privateer. Priorities: scan targets before engaging,
      only attack when advantaged, disengage below 50% hull.
    planner: { provider: mock }
    hull_pct: 50
    wake_notification_types: [combat, chat, trade]
```

Run: `bun test && bun run typecheck` (full suite + compile check)
Expected: all tests PASS, typecheck clean. `bun run src/main.ts` without `agents.yaml` exits with a clear config error (acceptable — live run needs Plan 2 planners anyway).

Note for Plan 2: the config schema grows `fallback_planner` and `stall_threshold` per agent when real planners land (spec's `config` section) — omitted here because nothing consumes them yet.

- [ ] **Step 7: Commit**

```bash
git add src/config/config.ts src/main.ts agents.example.yaml test/config.test.ts test/integration.test.ts
git commit -m "Add config loading, registration bootstrap, e2e test, and main entry"
```

---

## Done Criteria (Plan 1 complete when)

1. `bun test` passes: registry, conformance, fake server, transport, client, store, executor, wake, mock planner, agent loop, config — all offline, zero tokens.
2. Spike findings documented with a GO/NO-GO and the exact working invocation for Plan 2.
3. All work committed and pushed to `origin/main`.

## What Plan 2 builds on this

Real planners (`claude-subscription` via the spike's proven invocation, `ollama` with structured outputs), planner failure classification (transient vs subscription-limit with fallback), prompt construction from `PlanContext` (compact, delta-based per the spec's cost rules), and swapping `makePlanner` in `main.ts`. Plan 3: dashboard (REST + WS on `store.onEvent`, instruction box → `agent.instruct`). Plan 4: Dockerfile + compose + first live run.
