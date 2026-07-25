# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-25 evening (pilot stranded, self-destruct decision pending; PR #22 and the #240 plan both in REVISE-fix cycles; five issues filed). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-25 PM. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**PILOT STRANDED, irreversible call pending.** At `duskmere` (a sun, no base): fuel 2/130, cargo 100/100, credits 97,585, unchanged since ~14:24 UTC. It mined itself to 1.5% fuel and earned nothing in twelve hours. Rescue will not arrive by itself: `distress_signal` auto-assigns missions only to players within 5 jumps, those missions expire after 3h, and they do not self-renew. The one documented self-service exit is `self_destruct`, which preserves ALL credits and skills and costs the hull, ~100 units of low-value ore, and any fitted modules. Planned for ~20:00 UTC absent a rescue, because a stranded pilot also cannot produce a valid live baseline for #240 Task 2.

**PR #22 (#525 station backfill) REVISE, fix in flight.** The review reproduced the defect by driving the real `Agent` rather than reading it: `status_snapshot` is emitted only inside `if (wake)`, so an ordinary `[travel_to X, dock]` plan attributes the dock to the PREVIOUS system. That manufactures the exact false-station belief #517 exists to prevent, behind a comment asserting it cannot happen. Production data is clean 713/713, but only because cross-system moves usually end a plan, which is planner behavior rather than a guarantee. The guard measured free (kept 713, dropped 0, systems lost 0). Also fixing a boot crash on a malformed payload (binding schema-tolerance rule) and a scan that runs at every boot when its result is unused.

**#240 LOCAL PLANNER A/B, plan round 3.** Spec approved. Two independent reviews, both REVISE, both established by running the plan's own code. Round two found a silent stall in exactly the condition Stage 2 creates: the retry counter transitions only on transient errors, so a reachable endpoint returning bad plans pins it forever, giving 4 plans then zero with no alert. It also measured the plan's own cost receipt backwards (a larger retry window RAISES paid fallback calls) and traced that to a producer bug, since the planner fetch carries no timeout and probing a sleeping endpoint blocks the whole tick. Adding the timeout, shrinking the window. Tasks 2-3 were not executable as written: wrong CLI flags, and a committed case count the harvester cannot deliver.

**FILED.** #534 dampers rate-limit but never stop, so the stranded pilot burns ~230 planner calls/day at the cap for zero progress (the Codex experiment reverted 2026-07-21, so this is subscription quota). #535 superseded steers retire unreliably, leaving contradictory instructions live at once. #537 sighting eviction cannot rank a proven entry against a derived one. #538 `planner_recovered` fires during an outage. #529 root-caused and structural: worktree isolation forks the session's working directory, which is the issues clone, so every isolated agent gets a worktree of the wrong repo 100% of the time.

**THEN (Issues SSOT).** #526 fuel floor and #534 are the pilot pair. Then #527/#528, #458 buy guard, #491 scan_poi, #519, #456.

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
