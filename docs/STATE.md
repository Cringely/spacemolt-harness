# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-02 (credit-bleeding loop closed #681 via PR #58; gates F1 still blocked by #526; pilot stable at haven). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-02 post-PR#58. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) done, F1 strand/trap fix gated on #526, F2 launch scout+corsair (#593), F3 loops end (#534/#569/#571, +#592 gap), F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `68525a7`); scout/corsair registered, unlaunched. F2 stays held until F1 merges: launching two more pilots into an uncharacterised trap multiplies the failure.

**PILOT RECOVERED.** `miner` was frozen 2026-07-31T20:00Z to 2026-08-01T16:51Z (28.5h) at `market_prime`, fuel 19/130, by a four-layer livelock. Deploy on 2026-08-01T16:49:29Z recreated the container on image 68525a7. Unfrozen by the deploy itself, not steers: first game action at 16:51:23Z was `travel_to{system_id:haven}` (fuel 19→18, jump cost 1). Operator steer at 16:51:30Z adjusted plan shape; second steer at 16:54:20Z supplied navigation. Docked 16:55:33Z, refueled 16:55:43Z. Current state: fuel 130/130, docked at haven/grand_exchange, 207,158 credits.

**THE LIVELOCK (LAYERS 1,3 FIXED; LAYER 2 OPEN; LAYER 4 PARTIAL).** (1) Executor starvation, #543 (fixed PR #47): reflex deferred when plan carries remedy. (2) Planner impossible purchases, #669 (open): buys what station doesn't stock. (3) Fuel urgency mistyped, #670 (fixed PR #54): measured as percent, not range. Configured post-deploy in agents.yaml: `keep_fuel_above_jumps: 8`. (4) Reflex terminal give-up, #672 (fixed PR #50): per-station block stop. Deferred: plan-already-routing-to-fuel as remedy.

**GATE F1 STATUS.** F1 (strand/trap fix) requires both #543 and #526 closed. PR #47 (layer 1) merged; PR #50 (layer 4 partial) merged. #526 (unenforced fuel floor: pilot mined itself to 2/130 and stranded, NOT a livelock) stays open, blocking F1.

**CREDIT-BLEEDING LOOP, #681 (PR #58).** Planner placed six `create_buy_order` ops in 90 min, ~21.8k credits locked in dead escrow (item_not_available → escalate → never fills → replan). Guard: refuse `create_buy_order` when (station, item) pair already open, tracked from pilot's placement, cleared by `cancel_order` or `buy_filled`. Live now.

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
