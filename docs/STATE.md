# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-02 17:50Z (19 PRs merged 2026-08-01/02; backlog 164 open; **P0 at zero**; **gate F1 CLOSED**, F2 blocked on #159 persona briefings). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-02 at 17:50Z. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**#669 FIXED AND LIVE.** The overnight "empty dashboard panel" report was normal end-of-window behavior, not an incident. **PR #73 merged as `5b067fd`, closing #669** (pilot re-buys at stations proven empty, burning plan budget), auto-deployed, container `spacemolt-harness` up and healthy on that image. Same audit left open #696 (steer channel silent on instruction receipt), #697 (unused Escort purchase, abandoned mission), #698 (thrash-gate floor reset, unproven).

**FLEET FLIGHT (#591). F1 CLOSED. F2 NEXT, NOT A SWITCH-FLIP.** F0 steer restore (#495) and F1 (#543, #526 strand safety) both done. F2 (#593, launch scout+corsair) needs persona briefing text from #159 first. F3: #571 landed, #534/#569/#592 remain. F4 exit: 3 pilots / 24h / zero strands. Live: 1 of 3 flying (`miner`); scout and corsair registered, unlaunched.

**STRAND GUARDS LIVE, EVIDENCE TAGGED.** PR #68 blocks `mine` at the reserve floor; PR #72 (`9719daa`) tagged that block `fuelReserveBlock`, so `isStranded()` credits it alongside the movement+regex path. Each new guard must self-tag at its call site. Unconfirmed: whether `isStranded()` sees no in-flight plan, is undocked (reflex gated on `docked`, reflex.ts:103), or is fuel-capped.

**LIVELOCK (1, 2, 3 FIXED; 4 PARTIAL).** (1) Executor starvation #543, PR #47. (2) Planner buys what station doesn't stock, #669, **PR #73 merged `5b067fd`**. (3) Fuel urgency measured as percent not range, #670, PR #54, inert until configured per-agent. (4) Reflex terminal give-up #672, PR #50; deferred.

**LIVE PILOT SNAPSHOT (captured 17:41-17:47Z today).** 203,572 credits, fuel 85/140, hull 120/120, cargo 0/40, undocked at `cargo_lanes_gas_cloud`. 606 missions completed (603 in this morning's audit), 546,266cr lifetime earned. Planner model: `gpt-5.6-terra`. `plan_budget_exceeded` fired at 17:47:41Z (maxPlans 12/60min), the ceiling working as designed. Zero `item_not_available` in 12 minutes of post-deploy logs: weak positive evidence only (short window, pilot not at the station where the livelock occurred). **#669 is not yet proven fixed in production.**

**NEW: ACTIVE MISSIONS OVER CAP, OBSERVED NOT DIAGNOSED.** 7 active missions against a cap of 5. Six are `distress_response` at 0% progress with `visit_system` objectives (4 Nekkar, 1 Factory Belt, 1 Zibal), each expiring in ~1,000 ticks. The seventh, "Exotic Crystal Synthesis" (8,000cr reward), has sat at 0% for 21.9 hours. Cause (pilot-accepted vs. game-assigned) is a separate open investigation, not claimed here.

**PRODUCTION CONFIG FACTS.** `max_plans_per_window: 12` in live `agents.yaml` (schema default 36). `keep_fuel_above_jumps: 8` (estimate, not measured). Scheduler on LXC healthy (user `smsched`, cron every 10m).

**MERGED 2026-08-01/02 (19 PRs).** 2026-08-01: 9 PRs (#56-#68, core sync + steward passes + refuel/ceremony/fuel-floor fixes). 2026-08-02: #72 strand evidence, #73 #669 re-buy fix, #74/#75/#76 steward hardening, #77 backlog-generator UTF-8 fix. **#67 and #71 closed as superseded, not merged**, both hand-edited the generated `docs/backlog.md`; the real fix is #77.

**BACKLOG. 164 open issues, P0 at zero.** Regenerated from GitHub Issues SSOT.

**THEN, in order.** #593 (F2 launch — blocked on #159 persona briefings, not a switch-flip) → #687 (priority producer) → #534/#569/#592 (F3) → the rest in `docs/backlog.md`.

## Standing operational facts

Not part of the live-status refresh above; persists across waves until it changes. Not word-capped (`test/doc-size.test.ts` only gates the `## NOW` block).

- **Scheduler.** #114 has stayed recovered since 2026-07-21; the dispatch gate is still OFF by design (human-gated). Strategy job works over the TLS store proxy.
- **Merge cluster 2026-07-22/23** (superseded as live status, kept as the record): #12 `SM_STORE_URL` through the strategy job; #13 tick bootstrap moved host-side; #14 finding-filer scoped to the private issues repo; #15 chained-gh-merge gate round 3; #16 per-job gh grants, bypass wildcard dropped. Milestone Artifact current through M-53.
- **Model policy.** Fable = prose seats, Opus everything else, cheap tiers for bulk.
- **Spend ledger.** `spend-ledger.jsonl` in the primary clone, gitignored, auto-synced by a local Windows Scheduled Task (daily 4am + logon).
- **Scheduler SSH is slow.** ~30-40s to connect to the scheduler LXC; cause still unknown, `UseDNS` already off.
- **Codex review seat (#460).** `bun scripts/codex-review.ts <PR>`, advisory, run beside the Claude reviewer.
- **#458 buy-guard detail.** `mine_resource` counts MINED only; a prior titanium buy wasted roughly 120k credits, and the guard is not yet merged.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
