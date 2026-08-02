# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-02 (six PRs merged; backlog 187→159; P0 3→2; F1 still gated on #526). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-02 post-merge-cluster. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) done; F1 strand/trap fix gated on #526; F2 launch scout+corsair (#593); F3 loops end (#534/#569/#571, +#592); F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`); scout/corsair registered, unlaunched. F2 stays held until F1: launching two more pilots into an uncharacterised trap multiplies the failure rather than averaging it, and makes each strand harder to attribute.

**PRODUCTION.** `miner` healthy on image `c01a2ea`, 0 restarts, 209,032 credits, docked haven/grand_exchange. CI auto-deploys on merge (container up ~105s after PR #58 merged). `main` is ahead of the deployed image; that is normal between merges.

**GATE F1 STATUS.** Needs #543 and #526 both closed. #543 done (PR #47). **#526 is the single remaining blocker** (unenforced fuel floor: the pilot mined itself to 2/130 and stranded). In flight now: guard drafted, one real regression open (`test/agent-failure-classes.test.ts:76`, because blocking a `mine` step changes plan-execution flow), tests and improv pairing still owed.

**DEPLOY ORDER: IMAGE FIRST, CONFIG SECOND. DO NOT INVERT.** The reflex config block is `.strict()` (`config.ts:174`) and `keep_fuel_above_jumps` (`config.ts:172`) has no `.default()`. Add the key to `agents.yaml` only AFTER the image deploys, never before, or the pilot crashes at config load. Production carries `keep_fuel_above_jumps: 8` (backup `agents.yaml.bak.20260801-140456`); that 8 is an unvalidated guess from observed 5-jump legs, not a measurement, and stays under observation.

**LIVELOCK (1,3 FIXED; 2 OPEN; 4 PARTIAL).** (1) Executor starvation #543, PR #47. (2) Planner buys what a station doesn't stock, #669, open. (3) Fuel urgency measured as percent not range, #670, PR #54, inert until configured per-agent. (4) Reflex terminal give-up #672, PR #50; deferred: plan-already-routing-to-fuel as remedy.

**MERGED 2026-08-02.** #56, #57 (core sync, 6 files), #58 (#681 credit loop: six `create_buy_order` posts in 90min locked ~21.8k in dead escrow; guard refuses a second order for an already-open station+item), #59 (agent-def `effort` key was `reasoning_effort`, silently ignored for months; regression test added), #60/#63 (steward), #61 (#595 refuel target; the first attempt was inert for a miner because a mining laser occupies a utility slot).

**BACKLOG.** 187→159. 30 ceremony duplicates closed into 4 survivors; root cause is a dedup key regenerated per run (#635), fix in flight as PR #62. P0 now 2: **#558** (a failed ceremony surfaces nowhere; trimmed to that one part, in flight) and **#541** (core promotions, Leg 2 in flight). #557 closed on evidence (PR #29). New: #687 (filer stamps flat P2 on every finding, so root-cause work sits at routine priority).

**IN FLIGHT.** PR #62 (ceremony dedup, in rework), PR #64 (#571 shortfall message, awaiting review). Fixes running for #526, #558, #654, #541.

**THEN.** #526, #534, #535, #537, #538, #529 and the rest in `docs/backlog.md`.

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
