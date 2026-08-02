# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-02 04:30Z (13 PRs merged; backlog 187→156; **P0 3→0**; **gate F1 CLOSED**). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-02 at session close. Nothing in flight: every dispatched agent finished and every open PR merged. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591). F1 IS CLOSED. F2 IS THE NEXT MOVE.** F0 steer restore (#495) done. F1 needed #543 and #526; both now closed (PR #47, PR #68). F2 (#593, launch scout+corsair) was held only by F1, so nothing blocks it. F3: #571 landed tonight, #534/#569/#592 remain. F4 exit: 3 pilots / 24h / zero strands. Live: 1 of 3 flying (`miner`); scout and corsair registered, unlaunched.

**PRODUCTION.** `miner` healthy, 0 restarts. Verified live over SSH at 04:00Z on image `6146de9` (PR #64), container up 2 min after that merge. Four merges landed after that capture, so the image trails `main` until the next deploy. Normal between merges.

**READ THIS BEFORE TOUCHING agents.yaml. DEPLOY ORDER: IMAGE FIRST, CONFIG SECOND. DO NOT INVERT.** The reflex config block is `.strict()` (`config.ts:174`) and `keep_fuel_above_jumps` (`config.ts:172`) has no `.default()`. Add the key to `agents.yaml` only AFTER the image deploys, never before, or the pilot crashes at config load. Production carries `keep_fuel_above_jumps: 8` (backup `agents.yaml.bak.20260801-140456`); that 8 is an unvalidated guess from observed 5-jump legs, not a measurement, and stays under observation.

**THE STRAND IS GUARDED BUT STILL NOT DETECTABLE (#690, P1).** PR #68 stops the pilot mining below the fuel floor but does NOT fix the detector: `isStranded()` (`stall-monitor.ts:196`) credits only blocked MOVEMENT actions (`MOVEMENT_ACTIONS`, `agent.ts:211`), so a `mine` refused by the new guard produces zero strand evidence. That is why `operator_alert class=stranded` read 0 through the four-hour strand in #526. **F4's exit criterion is "zero strands", which is uncheckable until #690 lands.** Fix it before claiming F4.

**LIVELOCK (1,3 FIXED; 2 OPEN; 4 PARTIAL).** (1) Executor starvation #543, PR #47. (2) Planner buys what a station doesn't stock, #669, open. (3) Fuel urgency measured as percent not range, #670, PR #54, inert until configured per-agent. (4) Reflex terminal give-up #672, PR #50; deferred: plan-already-routing-to-fuel as remedy.

**MERGED 2026-08-01/02 (13).** #56, #57 core sync · #58 (#681 escrow loop, ~21.8k credits locked by six `create_buy_order` posts) · #59 (agent-def key was `reasoning_effort`, silently ignored for months) · #60/#63/#65 steward · #61 (#595 refuel target) · #62 (#635 ceremony dedup, three review rounds) · #64 (#571 shortfall message) · #66 (#654 denied-vs-absent reader) · #68 (#526 fuel floor, closed F1) · #69 (#558 ceremony failure alarm, closed the last P0).

**BACKLOG. 187→156, P0 at zero.** 31 ceremony duplicates closed into 4 survivors; both root causes now fixed (#635 dedup key, #654 denied-as-absent). Distribution: P1 10, P2 97, P3 23, **26 with no priority label at all**. A P2 bucket holding 62% is a default, not a signal. Producer is `filing.ts`'s flat `DEFAULT_TRIAGE_LABEL`, filed as **#687**. The taxonomy also has no `type:*` axis, so every filer improvises.

**THEN, in order.** #690 (strand detector, gates F4) → #593 (F2 launch) → #687 (priority producer) → #534/#569/#592 (F3) → the rest in `docs/backlog.md`.

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
