# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-01 (four-layer livelock fixed; pilot recovered from 28.5h freeze; PR #47/#50 merged, #526 still blocks F1 gate). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-01 post-recovery. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) done, F1 strand/trap fix gated on #526, F2 launch scout+corsair (#593), F3 loops end (#534/#569/#571, +#592 gap), F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `68525a7`); scout/corsair registered, unlaunched. F2 is deliberately held until F1 merges, because launching two more pilots into an uncharacterised trap multiplies the failure.

**PILOT RECOVERED.** `miner` was frozen 2026-07-31T20:00Z to 2026-08-01T16:51Z (28.5h) at `market_prime`, fuel 19/130, by a four-layer livelock. Deploy on 2026-08-01T16:49:29Z recreated the container on image 68525a7. Unfrozen by the deploy itself, not steers: first game action at 16:51:23Z was `travel_to{system_id:haven}` (fuel 19→18, jump cost 1). Operator steer at 16:51:30Z adjusted plan shape; second steer at 16:54:20Z supplied navigation. Docked 16:55:33Z, refueled 16:55:43Z. Current state: fuel 130/130, docked at haven/grand_exchange, 207,158 credits.

**THE LIVELOCK (LAYER 1 FIXED, LAYERS 2-4 PARTIAL-OR-OPEN).** (1) **Executor starvation, layer 1, #543 (fixed in PR #47).** A failed reflex action consumed a tick without executing the rescue plan queued beneath it. Fix: suppressed the reflex when a pending plan already carries an unexecuted remedial step. Live-confirmed 2026-08-01T03:11:43Z when the first plan step (`buy fuel_cell`) executed. (2) **Planner proposes impossible purchases (#669, open).** Proposes buying `fuel_cell` at stations with zero supply (19+ occurrences). (3) **Fuel urgency mistyped (#670, open).** Measured as percent-of-tank not range, so 19/130 reads 14.6% critical while actually 19 jumps available. (4) **Reflex blocked by terminal conditions (#672, PR #50 merged, partial fix).** A docked station with empty tank (`station_fuel_empty`) was terminal per `fuel.md:138` and will not fix by retry. PR #50 adds per-station terminal-failure give-up (reflex withholds further attempts once a terminal block is observed), which ended the tick-stealing loop. Deferred: destination-aware travel-as-remedy (the fuller fix that recognizes a plan traveling to a fuel source as already remedying the condition).

**GATE F1 STATUS.** F1 (strand/trap fix) requires both #543 and #526 closed. PR #47 (layer 1) merged; PR #50 (layer 4 partial) merged. #526 (unenforced fuel floor: pilot mined itself to 2/130 and stranded, NOT a livelock) stays open. F1 blocked until #526 merges.

**ALSO MERGED THIS CLUSTER.** PR #46 fixed merge-gate deadlock (#601); PR #38 deregistered `scan_poi` (#552); PR #45 bumped GitHub Actions. Reasons in `docs/decisions.md`. Also filed: #676 (stuck-detector alerts), #678 (station naming drift), #679 (reflex spent-tick timing). Closed: #601 (by hand).

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
