# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-02 04:30Z (13 PRs merged; backlog 187→156; **P0 3→0**; **gate F1 CLOSED**). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-02 at session close. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**INVESTIGATION: NO OUTAGE. PILOT HEALTHY.** Overnight operator report flagged empty dashboard progress panel as possible production incident. 24-hour audit: pilot produced 244 plans against 257 wakes, completed 603 missions, docked at `cargo_lanes_freight_depot` with full fuel (130/130), 95/95 hull, 203,572 credits, zero restarts. Empty panel is the normal gap between finished plan and next one at configured `max_plans_per_window: 12`. Real low-fuel episode occurred (5/130 fuel) and resolved without intervention; steer channel verified working end-to-end. **Real defect found and now in flight:** PR #73 under review for issue #669 (pilot re-buys at stations that can't fill, burning plan budget repeatedly). Issues filed: #696 (steer channel emits no event on instruction receipt), #697 (pilot purchased unused Escort, abandoned distress mission; observed, no cause claimed), #698 (consecutive-thrash gate resets repeat-break counting floor, UNPROVEN).

**FLEET FLIGHT (#591). F1 IS CLOSED. F2 IS THE NEXT MOVE.** F0 steer restore (#495) done. F1 needed #543 and #526; both now closed (PR #47, #68). PR #72 merged 2026-08-02 (9719daa, issue #690 strand evidence). F2 (#593, launch scout+corsair) was held only by F1, nothing blocks it. F3: #571 landed, #534/#569/#592 remain. F4 exit: 3 pilots / 24h / zero strands. Live: 1 of 3 flying (`miner`); scout and corsair registered, unlaunched.

**STRAND GUARDS LIVE, EVIDENCE NOW TAGGED.** PR #68 added the refusal: executor blocks `mine` at the reserve floor. PR #72 (9719daa) tagged that block `fuelReserveBlock`; `isStranded()` now credits it alongside the movement+regex path, closing the prior zero-evidence gap. Not automatic: each new guard must tag itself at its call site; #72 removed a worse shape, a distant action-name allowlist. **Open, unconfirmed:** whether `isStranded()` sees no in-flight plan, undocked (reflex gated on `docked`, reflex.ts:103, can't fire), fuel-capped. Plan-budget ceiling does NOT suppress the alert (runSteward runs first). Logs truncated at 04:17:29Z restart.

**LIVELOCK (1,3 FIXED; 2 IN-FLIGHT; 4 PARTIAL).** (1) Executor starvation #543, PR #47 merged. (2) Planner buys what station doesn't stock, #669, PR #73 under review. (3) Fuel urgency measured as percent not range, #670, PR #54, inert until configured per-agent. (4) Reflex terminal give-up #672, PR #50; deferred.

**PRODUCTION CONFIG FACTS.** `max_plans_per_window: 12` in live `agents.yaml` (schema default is 36 only). `keep_fuel_above_jumps: 8` (guess from 5-jump legs, not measured). Scheduler on LXC verified healthy (user `smsched`, cron-driven every 10m, not root's crontab).

**MERGED 2026-08-01/02 (13 + 1 in review).** 2026-08-01: PR #56/#57 core sync, #58 escrow loop, #59 agent-def key, #60/#63/#65 steward, #61 refuel target, #62 ceremony dedup, #64 shortfall message, #66 denied-vs-absent, #68 fuel floor. 2026-08-02: PR #72 strand evidence. In review: PR #73 issue #669 (re-buy at insufficient stations).

**BACKLOG. 187→163, P0 at zero.** Regenerated from GitHub Issues SSOT. Prior distribution (P1/P2/P3/unlabeled) needs recalculation from the new 163 total; old numbers from 187-issue count are stale.

**THEN, in order.** #669 (planner re-buy, PR #73 in review) → #593 (F2 launch) → #687 (priority producer) → #534/#569/#592 (F3) → the rest in `docs/backlog.md`.

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
