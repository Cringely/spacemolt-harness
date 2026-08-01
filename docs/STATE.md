# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-01 (six PRs merged; four-layer livelock diagnosed, layer 1 fixed and live-confirmed, PR #50 in flight for layer 4; pilot still frozen at `market_prime`). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-01. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) done -> F1 strand/trap fix IN PROGRESS -> F2 launch scout+corsair (#593) -> F3 loops end (#534/#569/#571, +#592 gap) -> F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `49c94ec`); scout/corsair registered, unlaunched. F2 is deliberately HELD until F1 merges, because launching two more pilots into an uncharacterised trap multiplies the failure.

**PILOT IS FROZEN. TOP OF THE QUEUE.** `miner` has sat at `market_prime` since ~20:00Z 2026-07-31: fuel 19/130, 205,549 credits, `reflex_failed: station_fuel_empty` every 10s. It is NOT stranded. A jump costs 1 fuel (`find_route` to all three neighbours returns `fuel_per_jump: 1`), so it holds ~19 jumps of range. An operator steer at 03:48Z broke its buy-fuel-cell fixation and it replanned toward `haven`; it still cannot execute, because the reflex eats every tick.

**FOUR DEFECTS STACKED**, each invisible until the one above it was fixed. (1) Executor starvation: a failed reflex consumed the tick its own rescue plan needed. #543, fixed in PR #47, LIVE CONFIRMED 2026-08-01T03:11:43.382Z when a `buy` step executed, the first plan step in 7+ hours. (2) #669: planner proposes purchases the local market has zero supply of, 19+ times running. (3) #670: fuel urgency is percent-of-tank (`keep_fuel_above`, typed as a percentage at `config.ts:165`), not range, so 19/130 reads as 14.6% critical while being 19 jumps. (4) #672 below.

**IN FLIGHT: PR #50 (#672), BLOCKED by review, revising.** The PR bundled a durable per-station give-up after a terminal reflex failure with a `planTravelsToFuel` predicate letting a relocation plan count as a fuel remedy. Review BLOCKED the predicate: it matches action TYPE only, never destination, and gates both `evaluateReflex` and `evaluateWake`'s low_fuel branch, so both safety nets go dark for any relocation plan. Production plans normally look like `[travel_to X, dock]`, which makes that the ordinary shape and recreates #526. The revision keeps the give-up and drops the predicate; the give-up by itself ends the livelock. #672 stays OPEN for the deferred travel-remedy half.

**ALSO MERGED.** #38 deregistered `scan_poi` (#552, 9/9 lifetime failures, needs a 600k-credit faction Sensor Dome) · #45 action version bumps · #46 fixed the merge-gate deadlock (#601; required contexts are gitleaks/CodeQL/test/verify/doc-size, ruleset `19302008` re-verified by direct read) · #48/#49 steward. Reasons in `docs/decisions.md`. Also filed: #667, #668, #673, #674. Closed: #657, #660, #661, #662, #663, #664, #666.

**THEN.** #526, #534, #535, #537, #538, #529 and the rest in `docs/backlog.md` (178 open).

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
