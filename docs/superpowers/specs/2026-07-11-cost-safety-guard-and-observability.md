# ARCHIVED: Cost-Safety Guard + Observability/Insights

**Status:** executed and landed (M-11/M-13 + decisions.md entries; see #279, #346).

This spec is archived. Refer to the milestone log (`docs/milestones.md`) and decision log (`docs/decisions.md`) for the decision rationale and implementation record.

**Archive location:** `docs/archive/specs-2026-07-11-cost-safety.md`

The live pilot (`miner` / Rockhopper Kess) thrashed for ~3 hours: 231 of 233 wakes were
`reason=low_fuel`, fuel pinned at 32/130, the plan frozen at step 0 (`dock`), emitting ~75 LLM
plan calls/hour that accomplished nothing. Sole root cause, confirmed against the code:

- `src/agent/wake.ts:42-43` returns `low_fuel` on the raw threshold every tick, unaware that the
  in-flight plan already contains a `refuel` step. In `runOnce` any wake replans and `return`s
  (`agent.ts:353-354`) before `executeOne()`; `replan()` resets the cursor to step 0
  (`agent.ts:481`). The executor never advances → fuel never changes → `low_fuel` fires again
  next tick. A livelock.
- The existing dampers miss it: the thrash damper only arms for `wake.reason` of `blocked` /
  `plan_done` (`agent.ts:314`); `subscription_cooldown_minutes` only arms on
  `SubscriptionLimitError` (`agent.ts:583`). A *successful* replan that fixes nothing evades both.

A separate latent defect surfaced during diagnosis (not a cause of this incident): `agents.yaml`
uses the key `reflexes:` (plural) but the schema reads `reflex:` (`config.ts:28`), and
`AgentEntrySchema` is not `.strict()`, so the reflex block is silently dropped. The reflex only
fires while docked (`reflex.ts:25`) and this ship was frozen undocked, so an armed reflex would
not have prevented the fuel pin — but the silent-config-drop is a real class bug worth closing.

Cost minimization is a first-class project goal; an unbounded planner-call loop is the single
most expensive failure mode the harness has. This spec closes it and makes the class visible.

## Goals

1. Fix the producer so a reflex-class wake cannot preempt a plan already carrying its remedy.
2. Fix the silent-config-drop so reflexes arm and future unknown keys fail loudly.
3. Bound per-agent planner-call volume with a signature-agnostic hard ceiling.
4. Detect a *frozen-state* no-progress freeze in minutes and surface it to the operator.
5. Give the dashboard the statistics/trends to measure whether a change helped: plan-rate,
   wake-reason mix, calls-per-model, estimated token cost, game-performance trends, and a
   change-marker overlay.

## Non-goals

- No new game actions, no live-API changes, no fleet/coordination work (that is the parked
  `fleet-coordination` spec; this must land first because more agents = more runaway surface).
- **No fleet-wide plan-rate cap here.** A fleet-wide sum defends a multi-agent runaway that does
  not exist yet (one live agent) and cannot be tested until the fleet exists; it moves to the
  fleet-coordination spec (simplicity rule 3 — no lock for a caller that doesn't exist).
- Real token counts from the Claude subscription CLI (it returns no usage). Estimated only.
- No rewrite of the verified SM-4/SM-9 thrash-damper logic; extend around it.

## Design

### Batch 1 — Guard (ships first; pilot resumes after)

**Layer 1 — Producer fix (`src/agent/wake.ts`, `src/agent/agent.ts`).**
Add two optional booleans to `WakeInput`: `planRemediesFuel`, `planRemediesHull`. Gate the
threshold returns: `if (pct < i.fuelPct && !i.planRemediesFuel) return low_fuel` (and hull).
In `runOnce`, before `evaluateWake(...)`, derive from the remaining steps
(`this.plan.steps.slice(this.cursor.step)`) whether a `refuel` / `repair` step is still ahead,
and pass the booleans in. Scanning from `cursor.step` onward is the correct window: once the
remedy step has been passed and the condition still holds, the remedy demonstrably failed →
the wake fires again → replanning is warranted (genuine new information). If the first step
blocks, `planState → blocked` and the existing block-reason damper handles it. Heartbeat still
fires as the dead-man backstop.
Invariant restored: *an in-flight plan runs to completion or explicit failure before a new plan
is triggered, except on genuinely new information.*

**Layer 2 — Reflex-key fix (`agents.yaml`, `src/config/config.ts`).**
Rename `reflexes:` → `reflex:` in `agents.yaml`; add `.strict()` to `AgentEntrySchema` (and
`ConfigSchema`) so an unknown key throws at load instead of vanishing. This is an independent
latent defect bundled here because it is cheap and independent (isolate-before-bundling is
satisfied: it is not entangled with Layer 1). It would not have prevented this incident; it
closes the silent-config-drop class and re-arms free auto-refuel-while-docked for the future.

**Layer 3 — Per-agent rolling ceiling (`src/agent/agent.ts`, `src/store/store.ts`, config).**
Before `replan()`, count `wake` events for this agent in a trailing window from the events
table; if `>= maxPlansPerWindow`, skip the planner call, keep executing any in-flight plan
deterministically (reflex-only), and emit one throttled `plan_budget_exceeded` event.
Self-clearing: as old `wake` events age out of the window, replanning resumes automatically at
the capped rate — no latch, no operator action.
Operator exemption: a wake whose reason is `instruction` bypasses the cap. The human is the
escape hatch and must be able to steer a thrashing agent even at budget; every other wake
reason (including `low_fuel`/`heartbeat`) is subject to the ceiling.
New store method: `countWakesSince(agentId, cutoffTs)` — one index-assisted
`SELECT COUNT(*) FROM events WHERE agent_id=? AND type='wake' AND ts>=?` (uses the existing
`idx_events_agent_ts` on `(agent_id, ts)`, `store.ts:32`).
Config (`AgentEntrySchema`): `max_plans_per_window` (int, default 12), `plan_budget_window_minutes`
(int, default 60). The key is `_per_window`, not `_per_hour`: the window is set independently by
`plan_budget_window_minutes`, so the unit must track that window rather than imply a fixed hour.
Honest bound: a `wake` is emitted once per `replan()` (`agent.ts:386`); one replan can fire up to
~4 CLI calls (normalization × JSON retry). The guarantee is "≤ ceiling replan batches, ≤ ~4× that
in CLI calls" — a hard, known, configurable cap. Sourcing from the events table (not
`plannerBackoffUntil`, which a successful replan resets to 0 at `agent.ts:493`) makes the cap
restart-safe and immune to the reset hole.
Why in Batch 1: invariant-promotion rule — three distinct thrash incidents now (F-3, SM-9,
low_fuel), so a signature-agnostic per-agent ceiling is earned, not speculative; and it is a
belt-and-suspenders cost cap in place *before* real tokens resume.

### Batch 2 — Observability + Insights

**Layer 4 — No-progress detector (`src/agent/agent.ts`).**
On each wake, compute a fingerprint of salient *game* state and compare to the previous replan's.
If identical for `NO_PROGRESS_REPLANS` consecutive replans (default ~6, ~60s at a 10s tick),
arm backoff to heartbeat cadence, set a sticky `stuck: boolean` on `PlannerHealth`, and emit
`operator_alert{class:"no_progress", fingerprint, replans}`. Clear `stuck` in `replan()`'s
success path the moment a new fingerprint differs.

Fingerprint inputs — enumerated (simplicity rule 5); all exist on `StatusSnapshot`
(`client.ts:5-32`) and are fetched fresh each tick, so nothing to go stale:
`status.fuel`, `status.credits`, `status.hull`, `status.systemId` + `status.docked` +
`status.inTransit` (+ `status.dockedAt`), `status.cargoUsed`, and plan position
(`plan?.goal` + `cursor.step`). If `status` is null, skip the check that tick and do not count.

Deliberately excluded: `cursor.iteration`. Receipt — including it would make a phantom-repeat
freeze (a repeat-step that advances `iteration` while game state stays frozen, the SM-9 shape)
produce a *changing* fingerprint every replan and evade detection. `cursor.step` alone separates
"advancing" from "frozen." Scope stated honestly: Layer 4 catches the *frozen-game-state*
freeze (this incident's shape). The cursor-advancing-but-useless case is left to the existing
`plan_done`/`blocked` dampers and the executor's effect verification — not re-solved here.

**Layer 5 — Stats/trends dashboard (`src/server/usage.ts`, `src/server/dashboard.html`, new
`status_snapshot` event, `Planner` interface).**
- Metrics from existing events (no new state): plan-rate/hour per agent, wake-reason histogram
  (red banner when one reason exceeds a share threshold — the "231/233 low_fuel" fingerprint),
  planner-error rate, calls-per-model (join event counts with per-agent `planner.model`).
- Estimated token cost: capture prompt/response sizes at their real seam — extend the `Planner`
  interface to return `{promptChars, responseChars}` (or an agent-side approximation from
  `ctx`/`raw`), recorded on the plan event; estimate tokens as `chars/4` × a per-model price
  table → est. cost/day per agent. The capture path touches each planner implementation
  (`claude-subscription.ts`, `ollama.ts`, mock) — named here, not hand-waved as a payload tweak.
- Game-performance trends: add a lightweight `status_snapshot` event on each wake (status is
  already fetched there) recording `credits`, `fuel`, `hull`, `cargoUsed`, `systemId`. Derive
  credits-over-time, credits/hour, profit/trip, cargo sold, fuel efficiency.
- Change-marker overlay: render vertical markers from git tags (single source for the first cut;
  a second source is additive later) against the credits/hour and plan-rate charts, so an
  experiment's before/after is visible. This is the measurement loop for the learning goal, and
  the trajectory-eval instrumentation named in `docs/wiki/sdlc-practices.md`.

## Test strategy (offline: fake server + mocked planner, zero live traffic, zero tokens)

- **L1 producer fix** — `status` low-fuel + undocked; mock planner returns `[dock, refuel, mine]`;
  the `refuel` call flips fuel back to full. Tick `runOnce` ~5×. Assert planner invoked exactly
  once (initial `no_plan`); executor advances past `dock`. Fails on current code (call count
  climbs per tick). This is the rule-2 ablation proving Layer 1 independently.
- **L2 reflex-key** — a config with `reflexes:` (or any unknown key) throws at load; a config
  with `reflex:` parses and the reflex arms.
- **L3 ceiling** — status pinned to force a wake every tick; mock planner returns a plan that
  never clears the condition and records its call times. Drive ~200 ticks. Assert no trailing
  `windowMs` slice ever exceeds `maxPlansPerWindow`, and that calls resume after a window elapses
  (throttle, not permanent latch).
- **L4 no-progress** — two arms: (a) fingerprint frozen → `operator_alert{no_progress}` +
  `stuck===true` + calls stop under backoff after threshold; (b) fingerprint changes each tick
  (e.g. `cargoUsed` increments) → no alert, `stuck===false`, replans proceed.
- **L5 metrics** — `usage.ts` summaries compute expected plan-rate / wake-reason / cost-estimate
  from a seeded events fixture; `status_snapshot` events produce the expected credits-over-time
  series. Behavior asserted, not implementation.

Each test earns its place by failing on a distinct real breakage (value-density rule). No padding.

## Rollout

1. Batch 1 on a batch branch → offline `bun test && bun run typecheck` green → independent
   review → PR → merge → redeploy image → **resume the paused pilot** and confirm plan-rate drops
   to the design 4–10/hr and fuel recovers.
2. Batch 2 on its own branch → same gate → merge → redeploy.
3. Only then unpark the fleet-coordination spec (where the fleet-wide cap belongs).

## Open questions / risks

- Per-model price table for the cost estimate is an assumption input, not a measured value;
  documented as estimated and tunable in config. No live-API unknowns in either batch.
