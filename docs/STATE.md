# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-02 (30 PRs merged since 2026-08-01; backlog 164 open; **P0 at zero**; **gate F1 CLOSED, gate F2 CLOSED** — fleet launched 18:26Z, scout+corsair flying alongside miner, M-54). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-02 post-launch (deploy verified 18:26Z). Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**#669 FIXED AND LIVE.** The overnight "empty panel" report was normal end-of-window behavior, not an incident. **PR #73 merged as `5b067fd`, closing #669** (pilot re-buys at stations proven empty, burning plan budget), auto-deployed, container `spacemolt-harness` up and healthy on that image. Same audit left open #696 (steer channel silent on instruction receipt), #697 (unused Escort purchase, abandoned mission), #698 (thrash-gate floor reset, unproven).

**FLEET FLIGHT (#591). F2 CLOSED — 1 PILOT BECOMES 3.** Scout (`nebula`) and corsair (`crimson`) launched 2026-08-02 18:26Z alongside miner, closing #593 (image `dcb5c92`, container healthy, `RestartCount 0`, no auth/planner errors); both executed real actions within 6 minutes. The real blocker was two host secrets never provisioned, not the persona-briefing gap #593 had carried for weeks — #159 (persona briefings) stays open, parked. Honest limits: personas cover 2 of #159's 4 elements (no playstyle briefing content, no per-persona progress readout); corsair starts at 0cr, can't buy fuel if it runs low; cost triples by design (3x ChatGPT-quota draw, Anthropic unaffected). F3: #571 landed, #534/#569/#592 remain. F4 exit (3 pilots/24h/zero strands) not yet reached.

**STRAND GUARDS LIVE, EVIDENCE TAGGED.** PR #68 blocks `mine` at the reserve floor; PR #72 (`9719daa`) tagged that block `fuelReserveBlock`, so `isStranded()` credits it alongside the movement+regex path. Each new guard must self-tag at its call site. Unconfirmed: whether `isStranded()` sees no in-flight plan, undocked (reflex gated on `docked`, reflex.ts:103), or fuel-capped.

**LIVELOCK (1, 2, 3 FIXED; 4 PARTIAL).** (1) Executor starvation #543, PR #47. (2) Planner buys what station doesn't stock, #669, **PR #73 merged `5b067fd`**. (3) Fuel urgency measured as percent not range, #670, PR #54, inert until configured per-agent. (4) Reflex terminal give-up #672, PR #50; deferred.

**LIVE PILOT SNAPSHOT (captured 17:41-17:47Z today).** 203,572 credits, fuel 85/140, hull 120/120, cargo 0/40, undocked at `cargo_lanes_gas_cloud`. 606 missions completed (603 in this morning's audit), 546,266cr lifetime earned. Planner model: `gpt-5.6-terra`. `plan_budget_exceeded` fired at 17:47:41Z (maxPlans 12/60min), the ceiling working as designed. Zero `item_not_available` in 12 minutes post-deploy: weak evidence only (short window, pilot not at the livelock station). **#669 is not yet proven fixed in production.**

**ACTIVE MISSIONS OVER CAP.** 7 active missions against a cap of 5. Six are `distress_response` at 0% progress with `visit_system` objectives (4 Nekkar, 1 Factory Belt, 1 Zibal), each expiring in ~1,000 ticks. The seventh, "Exotic Crystal Synthesis" (8,000cr reward), has sat at 0% for 21.9 hours. Cause is settled: the game auto-assigns these, no accept path (`agent.ts:905-916` logs, doesn't branch), filed as **#700**: the stale-mission advisory's 24h threshold can't fire before these expire.

**PRODUCTION CONFIG FACTS.** `max_plans_per_window: 12` in `agents.yaml` (schema default 36). `keep_fuel_above_jumps: 8` (estimate, not measured). Scheduler on LXC healthy (user `smsched`, cron every 10m).

**MERGED, 30 PRs since 2026-08-01–08-02.** Detail in `docs/milestones.md` (M-53, M-54).

**BACKLOG. 164 open issues, P0 at zero.** Regenerated from GitHub Issues SSOT.

**THEN, in order.** #687 (priority producer) → #534/#569/#592 (F3) → the rest in `docs/backlog.md`.

## Standing operational facts

Not part of the live-status refresh above; persists across waves until it changes. Not word-capped (`test/doc-size.test.ts` only gates the `## NOW` block).

- **Scheduler.** #114 has stayed recovered since 2026-07-21; the dispatch gate is still OFF by design (human-gated). Strategy job works over the TLS store proxy.
- **Merge cluster 2026-07-22/23** (superseded as live status, kept as the record): #12 `SM_STORE_URL` through the strategy job; #13 tick bootstrap moved host-side; #14 finding-filer scoped to the private issues repo; #15 chained-gh-merge gate round 3; #16 per-job gh grants, bypass wildcard dropped. Milestone Artifact current through M-53.
- **Model policy.** Fable = prose seats, Opus everything else, cheap tiers for bulk.
- **Spend ledger.** `spend-ledger.jsonl` in the primary clone, gitignored, auto-synced by a local Windows Scheduled Task (daily 4am + logon).
- **Scheduler SSH is slow.** ~30-40s to connect to the scheduler LXC; cause still unknown, `UseDNS` already off.
- **Codex review seat (#460).** `bun scripts/codex-review.ts <PR>`, advisory, run beside the Claude reviewer.
- **#458 buy-guard detail.** `mine_resource` counts MINED only; a prior titanium buy wasted roughly 120k credits, and the guard is not yet merged.
- **READ THIS BEFORE TOUCHING agents.yaml. DEPLOY ORDER: IMAGE FIRST, CONFIG SECOND. DO NOT INVERT.** The reflex config block is `.strict()` (`config.ts:174`) and `keep_fuel_above_jumps` (`config.ts:172`) has no `.default()`. Add the key to `agents.yaml` only AFTER the image deploys, never before, or the pilot crashes at config load. Production carries `keep_fuel_above_jumps: 8` (backup `agents.yaml.bak.20260801-140456`); that 8 is an unvalidated guess from observed 5-jump legs, not a measurement, and stays under observation.
- **Reverse hazard, confirmed live 2026-08-02 (M-54).** An agent entry added to `agents.yaml` without its `<id>_password` provisioned and mounted crash-loops the whole container (`compose.yaml:100-110`), taking down every already-healthy pilot with it — secrets go in first, the agent block second, every time.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
