# SpaceMolt Multi-Agent Harness — Design Spec

Date: 2026-07-10
Status: Draft for review (revised after independent agent review)

## Purpose

Build a harness that runs a team of AI agents playing [SpaceMolt](https://www.spacemolt.com) (an MMO built for AI agents), with a web dashboard for monitoring and adjusting them. The underlying goal is learning: how to lead a team of AI agents, engineer loops, and build harnesses. The game is the sandbox; the harness is the product.

## Goals

1. Run 3 agents with distinct playstyles (miner/trader, explorer, combat/pirate) concurrently, each with its own SpaceMolt character and LLM backend.
2. Web dashboard showing per-agent status, decisions, actions, event history, and resource/usage metrics — plus a per-agent instruction box to redirect an agent without restarting.
3. Absolute cost and token consumption reduction as a first-class design goal, not an optimization pass.
4. Zero marginal LLM spend by default: Claude via subscription auth (headless Claude Code / Agent SDK), Ollama locally. API-key providers are opt-in exceptions, off by default.
5. Software engineering discipline: SSOT, DRY, KISS. One definition per concept, no speculative abstraction.

## Non-Goals (v1)

- Pause/resume, persona editing, or kill switches from the dashboard (instruction injection only).
- Faction management, multi-agent in-game coordination strategies (agents play independently in v1; coordination is a v2 topic).
- Vercel AI SDK / API-key provider implementations (interface allows them later; not built now).
- Authentication on the dashboard. This is a LAN-only service behind existing network controls. Named tradeoff: `POST /instruct` is a write path that steers LLM agents, and any LAN device can reach it — accepted for v1, revisit if the service is ever exposed beyond the LAN.
- Market-shift detection as a wake condition (requires market polling + delta thresholds; deferred to v2).
- Per-wake-reason model tiering (both v1 backends are free; one model choice per agent is enough to exercise the comparison goal).

## Key Decisions

| Decision | Choice | Why |
|---|---|---|
| Agent count | 3, distinct playstyles | Small enough to debug, large enough to exercise multi-agent plumbing |
| Stack | TypeScript on Bun | Matches SpaceMolt reference client; borrow its API wrapper; built-in SQLite, test runner, single-binary builds |
| Reuse | Fresh harness; borrow API client only | Learning value is in the loop/orchestration; session/rate-limit handling is a solved problem |
| Topology | One process: all agents + embedded dashboard server | Simplest to run and debug; ships as one container |
| Game protocol | HTTP API v2 + notification polling | Plain request/response, easy to log/replay; 10s ticks make push latency irrelevant |
| LLM backends | Claude subscription (headless) + Ollama | $0 marginal cost; per-agent model choice for comparison |
| Persistence | SQLite (Bun built-in) | Queryable history, zero extra infra, doubles as crash-recovery memory |
| Dashboard | React/Vite, served by the harness | Room to grow controls in v2 |
| Deployment | Container-first (Dockerfile + compose) | Versioned, reproducible |

## Architecture

One Bun process ("mission control"):

```
config (agents.yaml + secrets/)
  └─ spawns 3 agent loops
       agent loop:
         gather: game state + notifications + operator inbox
         → executor continues current plan (0 tokens)
           OR wake condition met → Planner (LLM) emits new plan
         → action via spacemolt-client → SpaceMolt HTTP v2
         → emit event ──► SQLite ──► WebSocket broadcast ──► dashboard
  └─ embedded server (Bun.serve)
       serves dashboard build
       GET  /api/agents, /api/agents/:id/events
       POST /api/agents/:id/instruct  → agent inbox → wake
       WS   /ws  (live event stream)
```

### Plan-then-Execute (the cost model)

The LLM is a planner, not a pilot. It is called rarely and emits a multi-step plan. A deterministic executor — plain TypeScript, zero tokens — carries out steps tick by tick.

**Plan schema (the entire control-flow vocabulary).** A plan is a linear list of steps. Each step is:

- a registry action + params
- an optional completion condition from a fixed enum (e.g. `cargo_full`, `cargo_empty`, `arrived`, `count_reached`) — for actions that repeat per tick, like mining
- an optional repeat count for the step

That's it. No branching, no nested loops, no expressions — a plan that needs a decision mid-way ends there and the planner is woken with the outcome. The executor is a plain switch over registry step types plus this one condition check; it is deliberately not a workflow engine.

**Wake conditions.** The LLM wakes only on:

- plan completed
- plan step failed/blocked (executor attaches failure context)
- notable notification from the game (attacked, `player_died`, direct chat)
- polled-state thresholds crossed: fuel or hull below a per-agent configured percentage (checked from `get_status` each loop iteration)
- operator instruction injected from the dashboard
- max-interval heartbeat (default 15 min, per-agent configurable) so no agent drifts unattended
- process restart (agents re-validate their reloaded plan against fresh game state by replanning cheaply or resuming, planner's choice)

Effect: ~360 potential LLM calls/hour/agent (every 10s tick) becomes roughly 4–10.

Tradeoff, named: a plan-executing agent won't notice subtle mid-plan opportunities unless a wake condition fires. Acceptable for miner/explorer; the combat agent gets more aggressive wake conditions (any combat or scan-detected notification).

**Operator instruction lifecycle (defined).** An instruction aborts the current plan, is recorded as a goal entry, and wakes the planner, which produces a new plan honoring it. One-shot context, persistent effect via the goal list. No merge-into-running-plan semantics.

### Supporting cost measures

- Static game data (ship/item/recipe catalog) fetched once from `catalog.json`, looked up locally, never pasted into prompts.
- Prompts carry deltas and summaries, not full state dumps.
- Planner invocations run with minimal overhead: headless Claude Code launched with no MCP servers and no tools beyond structured output (`--strict-mcp-config`, restricted allowed-tools), since Claude Code's default system prompt and tool definitions count against subscription usage. If per-call overhead still dominates, switch the implementation to the Claude Agent SDK in-process — same interface, no process spawn.
- Token/usage metering is a first-class dashboard feature: per-agent tokens in/out, calls/hour, and usage-per-credit-earned. Subscription calls metered as usage (they count against plan limits), not dollars.

## Components

Each is one directory under `src/`, one clear purpose, testable alone.

### `spacemolt-client`
Typed wrapper over SpaceMolt HTTP API v2, adapted from the official reference client (github.com/SpaceMolt/client). Handles register/login, session persistence and auto-renewal, `action_pending`/rate-limit sleep-and-retry (never surfaces to the LLM), long-timeout travel calls. API types generated from the published OpenAPI spec (`/api/v2/openapi.json`) at dev time — the spec is the SSOT for the game's data model; no hand-maintained copy.

### `registry`
The single action registry: every game action the agents may use, defined exactly once — name, Zod params schema, client method, executor behavior, event label. Three consumers derive from it: LLM plan schemas, executor step vocabulary, dashboard event rendering. The registry is an intentional hand-curated subset of the full API (agents don't need all 100+ commands); a conformance test validates every registry entry's params schema against the generated OpenAPI types so the two sources cannot drift silently. An action defined in two places is a review-blocking defect.

### `planner`
`Planner` interface, one method: `plan(context) → validated Plan`. Two v1 implementations:

- **`claude-subscription`** — invokes headless Claude Code (`claude -p`, JSON output) authenticated via subscription login. No API key. Output parsed and validated against the registry-derived Zod plan schema; one retry with the validation error on failure.
- **`ollama`** — local model via Ollama's API, using Ollama's structured-output support (JSON-schema-constrained generation) so schema violations are rare rather than retried.

Planner failures are classified:

- **transient** (network, 5xx): exponential backoff; after 5 consecutive failures (default, configurable in `agents.yaml`) the agent enters `stalled` (red on dashboard), retains state, does not crash the process; heartbeat keeps retrying.
- **subscription limit reached**: distinct failure class. The agent either falls back to its configured fallback planner (Ollama) or enters a long cool-down until the usage window resets — per-agent config, no hot retry loop into a closed window.

API-key providers (Vercel AI SDK) are a later third implementation behind the same interface, only if wanted.

### `agent`
Per-agent loop: persona/system prompt (playstyle), goal/TODO state (captain's-log pattern, persisted), wake-condition evaluation, operator inbox, executor.

### `store`
SQLite via Bun's built-in driver. Tables: `events` (agent_id, ts, type, payload JSON) and `plans` (current plan, step cursor, goals per agent). Events are the single source of truth for observability: one writer, same row broadcast over WS. The plan's step cursor is persisted transactionally on every step transition, so a restart resumes at the current step — never replays completed steps (no re-buys/double-sells). Restart is itself a wake condition (see above), so a stale plan gets re-validated rather than blindly resumed. Events older than 30 days are pruned on startup. The store doubles as crash-recovery memory; there is no separate save system.

### `server`
`Bun.serve`: static dashboard build, REST endpoints above, WS broadcast, instruct endpoint (validates body, appends to agent inbox, triggers wake).

### `dashboard`
React/Vite app. Per-agent panel: status (ship, location, credits, hull/fuel), current plan and step, live event/reasoning feed, usage metrics, instruction input. Reads REST for history on load, WS for live updates. Read-only except the instruction box.

### `config`
`agents.yaml`: per-agent persona, empire, planner (provider/model) + fallback planner, fuel/hull wake thresholds, heartbeat interval, stall threshold. Secrets (SpaceMolt passwords, optional API keys) in `secrets/` files, mode 0644 for container bind-mounts, never in config or code.

**First-run registration.** SpaceMolt registration requires a registration code (obtained by the operator from spacemolt.com, supplied in `secrets/registration_code`). On boot, for each configured agent with no password file in `secrets/`, the harness registers the character and writes the returned password to `secrets/<agent>_password` before logging in. Idempotent: password file exists → skip registration, just log in.

## Error Handling

- **Session expiry/invalid:** client re-authenticates and retries once; logged as an event.
- **Rate limit / `action_pending`:** client sleeps `wait_seconds`, retries. Invisible to planner (tokens saved).
- **Plan step blocked** (can't afford, POI missing, cargo full early): executor marks plan blocked, wakes planner with failure context — a designed wake condition, not an exception.
- **Planner failure:** classified transient vs subscription-limit, handled as specified in the `planner` section.
- **Process crash:** restart reloads plans/goals/step cursor from SQLite; restart-wake re-validates before resuming.

## Testing

- **Unit tests** (Bun test runner): registry integrity (every action fully defined, no duplicates, conformance against OpenAPI types), executor step logic including completion conditions and cursor persistence, wake-condition evaluation — the deterministic 90%.
- **Fake SpaceMolt server:** in-process HTTP stub with canned v2 responses; agent loops run end-to-end in tests with zero live-game traffic and zero token spend.
- **Planner mocked** in tests (canned plans). Real-model behavior is validated by watching the dashboard — which is the point of the project.

## Deployment

Dockerfile (`oven/bun` base, pinned version; `claude` CLI installed in the image from the official installer at a pinned version) + `docker-compose.yml`: one service, SQLite on a volume, `secrets/` bind-mounted, dashboard port bound to a specific LAN interface per security rules. Ollama reached over the LAN/compose network.

**Claude subscription auth in the container.** The container gets its own writable Claude home directory on a dedicated volume — not a read-only mount of the host's, because Claude Code refreshes OAuth tokens and writes state on every run (a read-only mount fails at first token expiry). Bootstrapping: either run `claude login` once inside the container (volume persists it), or generate a long-lived token on the host with `claude setup-token` and pass it via environment. **Spike first:** subscription-auth-in-container is the least verifiable part of this design; validate it with a one-file spike before building the rest on top of it (implementation plan, phase 0).

## Operating Routine (the human loop)

The project's stated purpose: watch, assess, adjust.

1. Watch the dashboard: are agents progressing (credits, systems explored, kills/survival)? Are they stalled or thrashing (replanning too often)?
2. Assess via metrics: usage-per-credit-earned per agent; wake reasons histogram (too many heartbeat wakes = plans too short; too many blocked wakes = planner overestimating).
3. Adjust: edit persona/wake tuning in `agents.yaml`, restart (v1), or steer live via instruction box. Findings feed v2 (live controls, in-game coordination).

## Implementation Phasing (for the plan)

0. **Spike:** headless Claude subscription auth inside a container — prove it before anything else.
1. Client + registry + executor + store, tested against the fake server with a mocked planner (zero tokens).
2. Real planners (claude-subscription, ollama) with failure classification.
3. Dashboard (REST + WS + instruction box).
4. Containerization + compose + first live run.

## Plan 2 Additions (decided 2026-07-10, after Plan 1 was frozen)

Deterministic tooling expansion — inference reserved for judgment under ambiguity (see decision log entry for the full taxonomy):

- **Reflex policies:** declarative per-agent rules (`keep_fuel_above`, `flee_below_hull`) enforced by the executor with zero tokens; escalate to a planner wake only when the reflex cannot execute. Reflex actions emit events like all others.
- **Route macro:** `travel_to(system)` plan step expanded by the executor into jump hops via the free `find_route` query.
- **Digest templates:** planner context assembled deterministically — deltas since last wake and pre-computed tables, never raw state dumps.
- **Market math in code:** profit/price comparisons handed to the planner as finished tables.

Explicitly rejected: auto-repair of invalid plans (validation returns precise errors instead); scripted social interactions.

## Plan 4 Constraints (accumulated 2026-07-10, binding at authoring time)

- **Container hardening** (security audit): base image pinned by digest, non-root USER, claude CLI via version-pinned npm only, `no-new-privileges` + `cap_drop: ALL` + `read_only: true`, `bun install --frozen-lockfile`, `bun audit` gate.
- **Token handling**: `CLAUDE_CODE_OAUTH_TOKEN` by environment inheritance or `--env-file` only — never on a command line or in an image layer.
- **Dashboard exposure** (user decision): via a reverse proxy on the domain, behind SSO forwardAuth; container on the proxy network with NO published host port once deployed. No native app auth — accepted single-layer tradeoff per the documented proportionality principle. The v1 LAN-bind mode is development-only.
- **Operations doc**: `docs/wiki/operations.md` + README quickstart (start/stop, dashboard URL + SSO flow, instruction box, logs, usage metering) — required deliverable, finalized with real port/domain values.
- **First-flight verifications carried from Plan 2**: `find_route` response shape, token-invalid CLI error shape, subscription window reset timing.

## v2 Candidates (explicitly deferred)

Pause/resume and persona hot-reload; inter-agent coordination (shared faction, trade between own agents); market-shift wake conditions; per-wake-reason model tiering; WebSocket game protocol if polling proves limiting; API-key providers; **improv mode** (bounded model-in-the-loop play via MCP: daily window / leftover-budget / dashboard toggle triggers — see decision log); market math for the trader persona.
