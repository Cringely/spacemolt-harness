# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-01 (eight PRs merged since steward #49; four-layer livelock diagnosed, layer 1 fixed and live-confirmed in #47, layer 4 fixed and shipped in #50; F1 complete). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-01. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) done -> F1 strand/trap fix (#672) ✅ DONE -> F2 launch scout+corsair (#593) [HELD until F1 ships, now ready] -> F3 loops end (#534/#569/#571, +#592 gap) -> F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `68525a7`); scout/corsair registered, unlaunched. F2 is deliberately HELD until F1 merges to avoid launching into an uncharacterised trap; F1 is now merged and ready for F2 dispatch.

**PILOT RECOVERY.** `miner` was frozen at `market_prime` (fuel 19/130, reflex-failed retry loop) since ~20:00Z 2026-07-31. Root cause: a terminal reflex failure (e.g., `station_fuel_empty`) consumed every tick, starving the executor of time to run any plan step that might remedy it — executor starvation #543, fixed in PR #47. Second layer: once a reflex fails terminally at a station, it retries forever with no give-up. PR #50 adds a durable per-station give-up (backed by the event store, survives restart) to withhold retries after a terminal failure at that station. Both layers independently verified in ablation tests. The fix is now live (PR #50 merged 2026-08-01T16:46:51Z).

**FOUR DEFECTS STACKED** (layers 1-4 of the livelock). (1) Executor starvation: a failed reflex consumed the tick its own rescue plan needed. #543, fixed in PR #47, LIVE CONFIRMED 2026-08-01T03:11:43.382Z when a `buy` step executed, the first plan step in 7+ hours. (2) Terminal reflex retry loop: the reflex retries forever at a failed station. #672 (layer 4), fixed in PR #50 with the per-station give-up; deferred follow-up #672 (travel-toward-fuel remedy) stays open. (3) #669: planner proposes purchases the local market has zero supply of, 19+ times running. (4) #670: fuel urgency is percent-of-tank (`keep_fuel_above`, typed as a percentage at `config.ts:165`), not range, so 19/130 reads as 14.6% critical while being 19 jumps of range.

**ALSO SHIPPED.** #38 deregistered `scan_poi` (#552, 9/9 lifetime failures, needs a 600k-credit faction Sensor Dome) · #45 action version bumps · #46 fixed the merge-gate deadlock (#601; required contexts are gitleaks/CodeQL/test/verify/doc-size, ruleset `19302008` re-verified by direct read) · #48/#49 steward · #50 per-station reflex give-up (#672). Reasons in `docs/decisions.md`. 

**NEXT.** F2 dispatch (scout + corsair launch), then #526/#534/#535/#537/#538/#529 and the rest in `docs/backlog.md`.

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
