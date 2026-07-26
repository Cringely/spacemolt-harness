# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-25 evening (PR #22 and PR #24 merged; pilot recovered via authorised `self_destruct`; planner moved off the Claude subscription; #240 on plan revision 5, still a planning document). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-25 evening. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**MERGED: PR #22 (#525 station backfill), 21:44Z.** Position was sampled only on wake ticks while plan steps also ran on non-wake ticks, so a `travel_to X` then `dock` plan credited the new station to the system just departed. The walk now reads moves as well as docks and refuses to attribute a dock after a move until a fresh position arrives. Costs nothing on real history: all 713 attributable docks survive, same 16 systems. Three review rounds; the last was three numeric corrections in comments that had not reproduced.

**MERGED: PR #24 (#527 instruct gate), 23:22Z.** A steer ordering the pilot to run a QUERY action can't become a plan step (steps are mutations only), so it never retired and re-raised into every later plan. Now rejected at the HTTP boundary with a 400 naming the offending action and the mutations it could use instead, derived from the registry. Round 1 rejected 14 of 22 realistic steers. Round 2 cut that to 2 but broke negation handling, a joiner-boundary rule stranded "do not" and "I handle X" clauses. Round 3 fixed it with a lead-in rule instead. Suite 1553 pass / 1 skip / 0 fail.

**PILOT RECOVERED.** The production pilot, stranded at 2/130 fuel, was recovered by an operator-authorised `self_destruct`: 200cr fee, full cargo hold lost (no lootable wreck), ~2h trading restriction. Credits and skills survived (98,105cr). It respawned at Grand Exchange and is mining again.

**PLANNER MOVED OFF CLAUDE.** Both primary and fallback are now `codex-subscription/gpt-5.6-terra`; Anthropic is unreachable from planner selection by construction. Verified serving: three consecutive plans stamped `gpt-5.6-terra`, no `planner_error`.

**#240 LOCAL PLANNER A/B, plan revision 5, still a planning document.** Four review rounds so far, all REVISE. Revision 4's gate review rebuilt the code from the plan and reproduced almost every receipt. The mechanism and both contested design decisions survived, but the review also falsified revision 4's own claim that a counting guard "cannot be tested" (the reviewer built the falsifying case, one transient failure then one `SubscriptionLimitError`, and watched the misplaced version go red). Revision 5 fixes that plus a wrong waste-distribution number.

**FILED THIS SESSION.** #542: a one-shot destructive instruction never retires, so the pilot self-destructed again immediately after respawning. #543: a wake condition that reads permanently true starves the plan executor, four correct plans produced zero actions. #548: instruct-gate follow-ups. #541 raised to P1, gained a compaction-durable agent-tracking leg.

**THEN (Issues SSOT).** #534 dampers rate-limit but never stop. #535 superseded steers retire unreliably. #537 sighting eviction cannot rank a proven entry against a derived one. #538 `planner_recovered` fires during an outage. #529 worktree isolation forks the issues clone, not the code clone, for every isolated agent.

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
