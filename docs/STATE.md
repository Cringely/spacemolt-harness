# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-01 (four-layer livelock: layers 1,3 fixed; pilot recovered from 28.5h freeze; PR #47/#50/#54 merged, #526 still blocks F1 gate). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-01 post-recovery. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) done, F1 strand/trap fix gated on #526, F2 launch scout+corsair (#593), F3 loops end (#534/#569/#571, +#592 gap), F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `68525a7`); scout/corsair registered, unlaunched. F2 stays held until F1 merges: launching two more pilots into an uncharacterised trap multiplies the failure.

**PILOT RECOVERED.** `miner` was frozen 2026-07-31T20:00Z to 2026-08-01T16:51Z (28.5h) at `market_prime`, fuel 19/130, by a four-layer livelock. Deploy on 2026-08-01T16:49:29Z recreated the container on image 68525a7. Unfrozen by the deploy itself, not steers: first game action at 16:51:23Z was `travel_to{system_id:haven}` (fuel 19→18, jump cost 1). Operator steer at 16:51:30Z adjusted plan shape; second steer at 16:54:20Z supplied navigation. Docked 16:55:33Z, refueled 16:55:43Z. Current state: fuel 130/130, docked at haven/grand_exchange, 207,158 credits.

**THE LIVELOCK (LAYERS 1,3 FIXED; LAYER 2 OPEN; LAYER 4 PARTIAL).** (1) **Executor starvation, layer 1, #543 (fixed in PR #47).** A failed reflex action consumed a tick without running the queued rescue plan. Fix: suppress the reflex when a pending plan already carries an unexecuted remedial step, live-confirmed 2026-08-01T03:11:43Z on the first plan step (`buy fuel_cell`). (2) **Planner proposes impossible purchases (#669, open):** buying `fuel_cell` at stations with zero supply (19+ occurrences). (3) **Fuel urgency mistyped (#670, fixed in PR #54).** Measured as percent-of-tank not range; fix measures actual fuel-per-jump from `find_route` responses, so 19/130 at 1 fuel/jump now reads correctly as 19 jumps available. **The fix does nothing until configured.** `keep_fuel_above_jumps` (`config.ts:172`) has no `.default()`, so merging PR #54 changed no running agent's behavior by itself. An operator must set the key per-agent. It IS set in production: hand-added as `keep_fuel_above_jumps: 8` to TrueNAS's `agents.yaml` post-deploy (backup `agents.yaml.bak.20260801-140456`, revert condition inline). That 8 is an unvalidated guess from observed 5-jump legs, not measured, under active observation. Deploy order matters: the reflex config block is `.strict()` (`config.ts:174`), so the key must be added after the image deploys, never before, or the pilot crashes at config load. (4) **Reflex blocked by terminal conditions (#672, PR #50 merged, partial fix).** A docked station with empty tank (`station_fuel_empty`) is terminal per `fuel.md:138`; retrying never fixes it. PR #50 adds per-station terminal give-up (reflex stops once a terminal block is observed), ending the tick-stealing loop. Deferred: recognizing a plan already traveling to a fuel source as remedy enough on its own.

**GATE F1 STATUS.** F1 (strand/trap fix) requires both #543 and #526 closed. PR #47 (layer 1) merged; PR #50 (layer 4 partial) merged. #526 (unenforced fuel floor: pilot mined itself to 2/130 and stranded, NOT a livelock) stays open, blocking F1.

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
