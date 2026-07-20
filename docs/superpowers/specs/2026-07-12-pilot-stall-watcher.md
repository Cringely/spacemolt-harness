# Spec: Pilot stuck watcher — strand guard + multi-dimensional no-progress + steward (v4)

Date: 2026-07-12
Status: v4 — probe fixtures captured (PR #61) and the live stranding incorporated; ready to build.

## Motivation

"Who is watching the player?" The pilot parks/wanders and nothing autonomous catches or fixes it;
and on 2026-07-12 it hard-stranded (fuel 0, no reachable fuel, dead 3h until a manual rescue).
Layer 4's fingerprint includes location, so a *moving* pilot never trips; `operator_alert` is a
banner nobody sees when the operator is away.

Operator reframe: the concern is NOT "not earning credits." A pilot training skills, running
missions, or exploring earns zero credits and is progressing. The failure states are **stranded**
(dead-ended, chiefly no fuel) or **no progress in ANY dimension**.

## Verified facts (from the probe fixtures, PR #61, and the live strand)

- `get_status.player.stats` already carries MONOTONIC lifetime counters — `credits_earned`,
  `ore_mined`, `missions_completed`, `trades_completed`, `jumps_completed`, `distance_traveled`,
  `systems_explored`, … — in the status we fetch every tick. This is the no-progress substrate:
  one call, no extra queries.
- `get_skills`: `skills` keyed by name, each `{level, xp, next_level_xp, max_level}` — NO volatile
  field. Stable fingerprint = per-skill `xp` (monotonic). `get_achievements`: `summary.earned`
  monotonic. `completed_missions.total_count` monotonic (`get_active_missions` count is NOT).
- Relationships/reputation: no measurable standing endpoint. Proxied by missions/achievements.
- Strand math is uncomputable: `find_route` returns a hop count, not fuel; `fuel_price`/`fuel_reserve`
  are only on the *current* POI. Strand must be inferred from behavior. POIs expose `has_base` +
  `fuel_reserve` (no `fuel_price`/`base_id`). Recovery: `distress_signal` (types fuel/repair/combat,
  broadcast-only, 3h), `self_destruct` (free ×2/24h then escalating fees, respawns fueled at home,
  loses cargo), `tow` (= wreck-salvage, needs a tow rig + a wreck — NOT a rescue). These are NOT in
  the registry today, so an agent can't self-rescue.

## Goals

1. **Strand guard** — a hard fuel-reserve floor (prevent) + a behavioral strand detector (catch).
2. **Multi-dimensional no-progress detector** — flag stuck only when NO real dimension advanced;
   raw movement is NOT progress.
3. **Deterministic, bounded steward** — one re-steer, then escalate (incl. self-rescue on strand).
4. **Register the recovery actions** so an agent can self-rescue.

## Design

### 1. Strand guard (`src/agent/` — deterministic)

- **Fuel-reserve floor (prevent, heuristic).** A reflex-class guard: when the ship is undocked and
  fuel drops below `FUEL_RESERVE_PCT` (default ~25%), raise a high-priority "refuel" concern so the
  planner prioritizes reaching fuel *while it still can*, BEFORE 0. This is a heuristic backstop —
  true "enough to reach known fuel" needs the fuel-location map from per-pilot memory (the next
  spec), so note the dependency; the floor buys margin in the meantime. Reuses the existing
  low_fuel wake path (already suppressed while a refuel step is in flight).
- **Behavioral strand detector (catch).** Over a window: undocked, fuel low, AND `travel`/`jump`
  repeatedly blocked with an insufficient-fuel reason (the block-reason already surfaced via the
  executor `resultText`). Parse the current POI's `has_base`/`fuel_reserve` only to distinguish
  "at a base, the docked reflex will refuel" from "nowhere to refuel here." Drop reachability math
  (uncomputable). On a confirmed strand → `operator_alert{class:"stranded"}` + the steward's
  strand path (below).

### 2. Multi-dimensional no-progress detector (`src/server/usage.ts` + `src/agent/agent.ts`)

Over a rolling window (`STUCK_WINDOW_MIN` default 30; ≥2 samples; ≥1 wake = active), flag
`stuck_no_progress` only when NONE of the PROGRESS counters advanced:
- From `get_status.player.stats`: `credits_earned`, `ore_mined`, `missions_completed`,
  `trades_completed` (add other clearly-advancement counters present in the fixture).
- Plus a `get_skills` per-skill `xp` fingerprint and `achievements.summary.earned`.
- **EXCLUDE the movement counters** `jumps_completed`, `distance_traveled`, `systems_explored` —
  those increment on mere movement, and counting them re-opens the wandering blind spot (a
  forever-hopping pilot would read as "progressing"). Any single PROGRESS counter rising = not
  stuck; a skill/mission/trade/mine/earn advance clears it.
- Record the needed counters onto `status_snapshot` (extend it) so the detector and the dashboard
  read one series; sample skills on the throttle cadence (token-free query).
- **Fail-safe:** if a query needed for a dimension fails, that dimension is UNKNOWN → SUPPRESS the
  stuck flag (fail toward not-flagging), never treat as flat.
- Reconciliation with Layer 4: Layer 4 stays the short-window state-frozen backoff; this is the
  long-window real-progress judge and owns `stuck_no_progress`. Steward gates on this; if Layer 4
  already armed (state-frozen), it owns the episode and the steward stands down.

### 3. Steward (`src/agent/agent.ts`) — bounded by construction

Triggers on `stranded` OR `stuck_no_progress`:
- **Rung 1 — one transient re-steer per window (LATCHED).** Inject into `PlanContext.instruction`
  ONLY (never persisted `goals`). Latch with `lastStewardSteerAt` gated `now - last >= windowMs`,
  reset when the condition clears; emit a distinct `steward_resteer` event. Failure mode named in
  code: instruction-class wakes bypass BOTH the ceiling and the thrash damper, so the timestamp
  latch is the only bound and is load-bearing.
- **Strand escalation.** On a confirmed strand, the re-steer tells the pilot to `distress_signal`
  (call for help) and, if still stranded after the window, the steward may fire `self_destruct` as
  the last-resort reset (blanket in-game authorization; free ×2/24h). Emit
  `operator_alert{class:"stranded"}` loudly regardless.
- **Rung 2 (no-progress).** Still stuck after another window → `operator_alert{class:"stuck_no_progress"}`.

### 4. Register recovery actions (`src/registry/actions.ts`)

Add `distress_signal` (param `distress_type` enum fuel/repair/combat), `self_destruct`, and `tow`
(mutations, tool `spacemolt`/`spacemolt_salvage`) so the executor/steward can call them via the
normal `client.action` path. Verified schemas from the probe.

## Test strategy (offline: fake server + mock planner, zero live traffic)

- No-progress fires when ALL progress counters flat + active + window elapsed.
- Does NOT fire when ANY progress counter advanced: credits_earned; ore_mined; missions_completed;
  trades_completed; a skill xp change; achievements.earned. (One ablation each.)
- **Wander-forever pilot** (jumps_completed/distance_traveled/systems_explored rise every tick,
  all PROGRESS counters flat) → DOES fire. (The blind-spot regression test — movement isn't progress.)
- Fail-safe: a needed query fails → does NOT fire (suppress).
- Strand: undocked + fuel low + repeated fuel-blocked moves → `stranded` fires; docked low-fuel or
  a move that then succeeds → does NOT (transient). Fuel-reserve floor raises the refuel concern
  below `FUEL_RESERVE_PCT` while undocked.
- Burn bound: persistent stuck across MANY ticks → exactly ONE `steward_resteer` per window.
- Steward injects `instruction` not `goals`; Layer-4-armed → stands down; strand escalation fires
  distress then (after a window) self_destruct in the mock.
- Registry: the three recovery actions parse and route (distress_signal rejects a bad distress_type).
- Each test a distinct real breakage.

## Rollout

Offline batch → `bun test && typecheck` green → independent code review (the burn-latch, the
movement-counter exclusion, the fail-safe suppression, and the strand behavioral logic are
load-bearing) → PR → merge → auto-deploys within ~1 min → confirm on the live pilot. Then per-pilot
memory (the real wandering fix + the fuel-location map that completes strand prevention).

## Open / notes

- Full strand *prevention* needs the fuel-location map from per-pilot memory; the fuel-reserve
  floor is the interim heuristic.
- Record the game-mechanics facts (self_destruct/tow/distress/insurance/refuel) into docs/wiki when
  building (or leave to the wiki-mining chip).
- Thresholds (`STUCK_WINDOW_MIN`, `FUEL_RESERVE_PCT`, per-counter deltas) are tunable; conservative
  defaults, annotate as experiments.
