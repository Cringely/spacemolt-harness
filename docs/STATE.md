# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-25 PM (pilot STRANDED; #517 measured and found inert; #240 plan pushed and under review; five issues filed). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-25 PM. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**PILOT STRANDED, needs a call.** At `duskmere` (a sun, no base): fuel 2/130, cargo 100/100, credits 97,585. It mined itself down to 1.5% fuel and cannot reach a station. Rescue is not coming: `distress_signal` is auto-assigned only to players in the SAME system and Duskmere has zero. The no-progress damper armed 16:27 UTC, so it is idle (status snapshots only, no plans) for 30 minutes at a time. Two operator steers sent 16:45, both 204, both QUEUED BEHIND that damper and not yet acted on (#528). If it is still at Duskmere with 2 fuel, self-rescue has failed and the next lever is a human one.

**#517 SHIPPED INERT.** The honest correction to the previous NOW block. PR #18 deployed at 02:45 UTC (image `4c48a65`, `restarts=0`). Measured either side: plans/hour 11.3 before vs 10.9 after, `plan_budget_exceeded` 5.8/hr vs 5.3/hr. No improvement, because `knownStations` reaches the planner EMPTY. All 482 historical dock actions carry `params: {}`, and the pilot has not docked since the deploy. The feature cannot populate until it docks, and it cannot dock without the feature. The history is recoverable (station name is in the result string, system from the concurrent snapshot: 16 systems, working query in #525). The earlier "UNPROVEN whether this lowers planner burn" is now MEASURED, and the answer is no, for a reason that is fixable.

**#240 LOCAL PLANNER A/B, spec approved, plan under review.** Spec `docs/superpowers/specs/2026-07-25-local-planner-ab-design.md`, plan `docs/superpowers/plans/2026-07-25-local-planner-ab.md` on branch `plan/240-local-planner-ab`. Three gated stages (baseline the incumbent, offline eval, live swap) plus one code change: a reversible fallback when the planner endpoint is unreachable, since today an unreachable endpoint stalls the pilot rather than falling back. Only `google/gemma-4-12b-qat` is downloaded. Stages 0 and 1 run on the workstation against localhost and need no firewall change; Stage 2 does, and that is operator work.

**FILED 2026-07-25 PM, all P1 except #524.** #524 (P2) pre-commit gate for homelab identifiers reaching this public repo, third leak. #525 station-geography backfill. #526 fuel floor as a deterministic guard rather than persona prose. #527 reject steers naming a query action at the `/instruct` boundary, fifth occurrence of that class. #528 an operator steer cannot preempt the no-progress damper.

**IN FLIGHT.** Two background agents: a plan review of #240, and the #518 reviewer rate-window fix (worktree-isolated, will open a PR and stop).

**THEN (Issues SSOT).** #525 and #526 are the pilot's survival pair and outrank the rest. Then #518 → #527/#528 (both cheap, both restore an escape hatch) → #458 buy guard → #491 scan_poi → #519 → #456.

## Standing operational facts

Not part of the live-status refresh above; persists across waves until it changes. Not word-capped (`test/doc-size.test.ts` only gates the `## NOW` block).

- **Scheduler.** #114 has stayed recovered since 2026-07-21; the dispatch gate is still OFF by design (human-gated). Strategy job works over the TLS store proxy.
- **Merge cluster 2026-07-22/23** (superseded as live status, kept as the record): #12 `SM_STORE_URL` through the strategy job; #13 tick bootstrap moved host-side; #14 finding-filer scoped to the private issues repo; #15 chained-gh-merge gate round 3; #16 per-job gh grants, bypass wildcard dropped. Milestone Artifact current through M-49/50.
- **Model policy.** Fable = prose seats, Opus everything else, cheap tiers for bulk.
- **Spend ledger.** `spend-ledger.jsonl` in the primary clone, gitignored, auto-synced by a local Windows Scheduled Task (daily 4am + logon).
- **Scheduler SSH is slow.** ~30-40s to connect to the scheduler LXC; cause still unknown, `UseDNS` already off.
- **Codex review seat (#460).** `bun scripts/codex-review.ts <PR>`, advisory, run beside the Claude reviewer.
- **#458 buy-guard detail.** `mine_resource` counts MINED only; a prior titanium buy wasted roughly 120k credits, and the guard is not yet merged.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
