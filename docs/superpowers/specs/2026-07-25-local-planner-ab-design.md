# Local planner A/B: gemma-4-12b via LM Studio (issue #240)

**Status:** approved 2026-07-25. Supersedes nothing; implements #240's "A/B before committing" step.

## Problem

The pilot's planner and the dev fleet share one Claude subscription quota. The pilot plans continuously (measured 2026-07-25: ~10-12 plans/hr, 6 `plan_budget_exceeded` in one hour), so its draw is a standing first-order cost. A local model removes it.

#240 already landed most of the machinery. What remains is deciding whether a local model is good enough, and closing one gap that only matters once a local endpoint is in the path.

## What already exists (verified, not assumed)

| Piece | Location | State |
|---|---|---|
| OpenAI-compatible planner | `src/planner/openai-compat.ts` | Shipped for #240. `POST {baseUrl}/v1/chat/completions`. |
| Grammar-constrained output | same, line 64 | Sends `response_format: { type: "json_schema", json_schema: { name: "plan", schema: PLAN_JSON_SCHEMA } }`. In-code note records LM Studio strict `json_schema` as verified. |
| Offline planner eval | `src/eval/{run,cases,harvest,scorers,types}.ts` | Scores any planner against recorded `plan_context` states. Zero live game traffic. Planner arrives through `config/planner-factory.ts`, so a new candidate is one config line. Cost-normalized via `estimateCostUsd`. |
| Config surface | `agents.example.yaml` | `planner: { provider: openai-compat, model, base_url }`, `fallback_planner`, and `experiment: { revert_if_no, within_hours }` all documented. |
| Deterministic experiment exit | `src/agent/agent.ts:1406` `maybeRevertExperiment` | Latches onto `fallback_planner` and emits `experiment_reverted` if the named progress counter does not advance within `within_hours`. One-way by design. |

## Environment (measured 2026-07-25)

- LM Studio installed. CLI at `C:\Users\jcgam\.lmstudio\bin\lms.exe`.
- **One LLM downloaded:** `google/gemma-4-12b-qat` — GGUF, Q4_0 (quantization-aware trained), 12B params, `gemma4` arch, 7.15 GB, `maxContextLength` 262144, `vision: true`, `trainedForToolUse: false`. Served id is the model key: `google/gemma-4-12b-qat`.
- Also present: `text-embedding-nomic-embed-text-v1.5`. Not relevant to planning.
- LM Studio server NOT currently running (nothing answers `127.0.0.1:1234`).
- Workstation LAN address `10.0.1.74` (Ethernet 3). Hardware per #240: RX 7900 XTX 24 GB, 96 GB RAM, Ryzen 7 7800X3D. 7.15 GB leaves roughly 16 GB VRAM headroom.
- **Network path PROVEN.** TrueNAS (`10.0.0.150`) routes to the workstation on the same bridge (`10.0.1.74 dev br0 src 10.0.0.150`). TCP 3389 connects both from the TrueNAS host and from inside the `spacemolt-harness` container. ICMP fails, which is Windows blocking ping and not a routing fault.
- TCP 1234 from the container: TIMEOUT. Consistent with no listener plus a Windows Firewall default drop. A firewall rule is required; the route is not in question.

`trainedForToolUse: false` is not disqualifying here. We need schema-conforming JSON, not tool calls, and LM Studio grammar-constrains generation against `PLAN_JSON_SCHEMA`.

## The gate's real discriminating power

`PLAN_JSON_SCHEMA` builds one variant per action with `action: { const: <name> }` and per-action `required` params (`src/planner/ollama.ts`, `stepSchema`). The grammar therefore enforces two scorers for **any** model:

- `knownAction` — free pass, no signal.
- `requiredParams` — free pass, no signal.

Seven scorers carry real signal, because the schema cannot know runtime state:

- `knownSystemRef`, `knownPoiRef`, `knownItemId` — ids must exist in the state the model was shown. Hallucination shows up here.
- `dockRequiresStation`, `mineNeedsMatchingModule`, `noMineIntoFullHold`, `cargoCoherence` — situational judgment.
- `scoreGoalDiversity` — the replan-instead-of-adapt thrash class (3 identical consecutive goals), invisible to every per-plan check.

A pass bar phrased as "100% on validity" would be theatre. The bar lives on the seven.

One of the seven is partly blind on harvested data. `harvestCases` deliberately leaves `groundTruth.knownSystemIds` unset, because a live agent legitimately knows only its current system plus connections and a `travel_to` beyond that is valid rather than wrong. So `knownSystemRef` ABSTAINS on `travel_to` steps in harvested cases (`src/eval/scorers.ts:84`), which is the right call (an abstention beats a fabricated failure) but means harvested cases alone cannot score that dimension.

Both case sources are therefore used:

| Source | Coverage | Limitation |
|---|---|---|
| `test/fixtures/eval-cases.json` | Curated, sets `groundTruth` by hand, so `knownSystemRef` scores instead of abstaining. | Fixed set; does not reflect the pilot's most recent states. |
| `harvestCases(dbPath, "miner", N)` | Real recorded decision points, including the states behind the 2026-07-25 stall. | `knownSystemRef` abstains on `travel_to`. |

`run.ts` reports abstain counts per scorer and yields `null` rather than a perfect score when every case abstained, so an unmeasured dimension is visible and never reads as a pass.

### Getting the cases

The production event DB lives inside the pilot container on TrueNAS at `/app/data/harness.sqlite`, 34 MB as of 2026-07-25. Copy it to the workstation (where LM Studio runs) and harvest locally; the eval makes zero game calls, so a snapshot is as good as the live file and avoids reading a DB the pilot is writing.

## Design

### Stage 0 — baseline the incumbent

Run `src/eval/run.ts` against the current production planner over harvested real states. We do not know what Claude scores on these scorers; any threshold set before measuring would be invented. Stage 0's output IS the bar.

Deliverable: a per-scorer pass-rate table for the incumbent, committed as the reference point.

### Stage 1 — offline gate

Same harvested cases, same digest, planner swapped to `openai-compat` / `google/gemma-4-12b-qat`. Identical inputs to both models: this is the only genuinely controlled comparison available.

Pass condition. The MARGINS below are pre-committed here, before any local-model number exists; only the BASELINE they are measured against comes from Stage 0. Committing the margins in advance is the point — a bar chosen after seeing the candidate's score is not a bar.

- None of the seven signal-carrying scorers regresses by more than 15 points against the incumbent baseline. `knownAction` and `requiredParams` are excluded because the grammar enforces them for any model.
- `scoreGoalDiversity` does not regress at all. Thrash is the failure mode that burns the plan budget, which is the cost this exercise exists to reduce; trading it for cheaper tokens is a net loss.
- No scorer may pass on abstentions alone. `run.ts` yields `null` for an all-abstain scorer; a `null` is an unmeasured dimension and blocks the gate until it is measured on the curated fixture.
- Zero unparseable responses. A response the grammar could not force into schema is an infrastructure failure rather than a quality signal, and must be investigated before any number is trusted.

Fail is an acceptable outcome and ends the exercise at Stage 1. VRAM headroom means retrying with a larger model is a download, so the model id stays in config and is never baked into code.

### Stage 2 — live swap

Only on a Stage 1 pass. The existing `miner` agent switches planner; no second account is created.

A fresh second pilot was considered and rejected: a new account starts with a starter ship, no skills and no credits, against a pilot with 386,977 lifetime credits earned, level-6 trading and a fitted ship. The dominant variable would be account age, not model quality, and the two effects cannot be separated after the fact.

```yaml
planner: { provider: openai-compat, model: google/gemma-4-12b-qat, base_url: "http://10.0.1.74:1234" }
fallback_planner: { provider: claude-subscription, model: sonnet }
experiment: { revert_if_no: any, within_hours: 12 }
```

Comparison is against the pilot's own prior window, on the multi-dimensional progress measures (credits, missions, ore, exploration) plus plans/hour and blocked-action classes from the event store. Baseline recorded pre-merge: ~10-12 plans/hr with 6 `plan_budget_exceeded` in the hour.

`experiment:` is the deterministic exit. It is not the operator's judgment and not mine.

### The one real code change: reversible endpoint fallback

**Violated invariant.** When the configured planner endpoint is unreachable, the agent should plan using its fallback rather than stop planning. Established at: the planner-failure handler, `src/agent/agent.ts` `handlePlannerFailure`.

**Current behavior.** An unreachable endpoint makes `fetch` throw; `openai-compat.ts` wraps it as `TransientPlannerError`; the handler applies exponential backoff, emits `planner_transient_error`, and eventually sets `stalled`. It never selects `fallbackPlanner`. Every existing fallback trigger is subscription-shaped:

| trigger | field set | covers |
|---|---|---|
| `TokenInvalidError` | `claudeDisabled` | bad OAuth token |
| `SubscriptionLimitError` | `usingFallback` | quota exhausted |
| no-progress latch | `experimentReverted` | model plays badly (hours) |

So a sleeping workstation yields a pilot that backs off and does nothing until the box wakes or the 12-hour latch fires.

`usingFallback` is additionally assigned in exactly one place and never reset — a one-way latch. Reusing it would mean the first overnight sleep moves the pilot to the subscription permanently, destroying the saving this issue exists to capture.

**Fix (producer-side, at the handler).** A new reversible state, distinct from the three latches:

```
consecutive transient failures >= ENDPOINT_DOWN_THRESHOLD
  -> serve fallback_planner
  -> emit planner_endpoint_down (once per transition, not per failure)

a later replan reaches the primary successfully
  -> resume primary
  -> emit planner_endpoint_recovered
```

Ordering is load-bearing: `experimentReverted` must continue to win. A model that played badly enough to trip the progress latch must not be reinstated because its endpoint came back. `activePlanner()` already checks `experimentReverted` first and that precedence is preserved.

**Complexity receipt.** `consecutiveTransientFailures` already exists and already resets on success, so the transition signal is present and no new counter is introduced. Rejected alternatives: a health-probe endpoint (an extra call per cycle when the replan attempt is itself the probe); a separate watchdog task (new lifecycle to own, for a condition the existing counter already expresses); tunable retry knobs (no live evidence that one threshold is insufficient).

`ENDPOINT_DOWN_THRESHOLD` = 2. Receipt: one failure is a blip and the existing backoff already absorbs it; two consecutive failures against a LAN endpoint on a multi-minute replan cadence means the listener is gone rather than busy.

**Interaction to verify, not assume.** The same handler sets `plannerBackoffUntil` on every transient failure, and the backoff grows exponentially. If backoff suppresses the next replan attempt, then reaching a threshold of 2 takes at least one backoff interval, and the fallback engages later than the threshold number suggests. Read the wake path before choosing where the check sits: the fallback must engage on the first replan AFTER the threshold is met, and it must not be starved by a backoff that was set for the primary. If the two mechanisms cannot cleanly coexist, the correct fix is to skip the backoff while the fallback is serving (the fallback endpoint is not the thing that failed) rather than to shorten the backoff.

## Testing

Offline, per project convention: fake server, mocked planner, zero live game traffic, zero LLM calls. `bun test && bun run typecheck` must pass.

Behaviors that earn a test, each ablated to confirm it fails when its guard is removed:

1. Two consecutive transient failures select `fallback_planner`; one does not.
2. `planner_endpoint_down` is emitted once on transition, not once per failure.
3. A subsequent success on the primary resumes it and emits `planner_endpoint_recovered`.
4. `experimentReverted` outranks endpoint recovery: a reverted experiment stays on the fallback even after the primary answers again.
5. Absent a `fallback_planner`, behavior is unchanged (backoff and stall) rather than a crash or a silent no-planner state.

Test 4 is the one that protects a real invariant rather than a mechanism; if only one test survives review, it is that one.

## Risks and non-goals

- **Plan quality is not game outcome.** Every scorer can pass while the model plays badly. Stage 2 exists for that, with a deterministic revert rather than a judgment call.
- **Stage 1 cannot measure latency under load.** A local 12B on a desktop GPU shares the card with whatever else the workstation is doing. If Stage 2 shows replans arriving late, that is a Stage 2 finding.
- **Cost claims stay unproven until measured.** "Removes the pilot's quota draw" is the hypothesis. The measurement is subscription spend attributable to the pilot before and after, and it is only valid for hours the workstation was actually awake.
- **Not in scope:** moving dev agents to a local model (#240 explicitly excludes it; the REVISE rate on recent PRs is the evidence that strong reviewers earn their cost), improv mode, and any second game account.

## Prerequisites (operator, on the workstation)

1. `lms server start` with the server bound to `0.0.0.0:1234` rather than localhost.
2. Load `google/gemma-4-12b-qat`.
3. Allow inbound TCP 1234 in Windows Firewall for the local subnet only, not `Any`. The listener is an unauthenticated LLM endpoint; `api_key_file` support exists in `openai-compat.ts` if a key is wanted later, and a key never appears inline in `agents.yaml` per `security-baseline.md`.
4. Confirm from inside the pilot container that `10.0.1.74:1234` answers, using the same TCP probe that already proved 3389 reachable.
