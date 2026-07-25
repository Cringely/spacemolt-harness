# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-25 (merge cluster #12-#16 reconciled; #517 station geography SHIPPED in #18; pilot recovered from a stall; backlog reconciliation closed 16 issues). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-25 (merge cluster + backlog reconciliation). Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**HARNESS UP.** Pilot container healthy on the NAS (45h uptime, verified 2026-07-25 01:09 UTC). Scheduler (#114) stayed recovered since 2026-07-21; dispatch gate still OFF by design (human-gated). Strategy job still working over the TLS store proxy.

**MERGE CLUSTER (2026-07-22/23), public spacemolt-harness main, zero PRs open, branches deleted:** #12 wired `SM_STORE_URL` through the strategy job (closed private #476); #13 moved tick bootstrap host-side, outside the checkout it repairs (closed private #459); #14 scoped the finding-filer's gh calls to the private issues repo; #15 chained-gh-merge gate round-3, comment-aware masking (closed private #466); #16 enumerated every job's gh grant, dropped the bypass wildcard (closed private #490).

**PILOT RECOVERED (supersedes the 2026-07-21 "net-negative" framing).** Had stalled: cargo 100/100, fuel 9/130, 8 jumps in 48min hunting a station (Xihe revisited twice), 70 plans in 6h against a 12/hour cap, 43 `plan_budget_exceeded`. That stall is what #517 fixes. Recovered itself to `gold_run`, refuelled, sold up. Last heartbeat `progressing: true`, +2 missions in the window. Lifetime: 386,977cr earned, 30,816 ore mined, 64 missions, 463 trades, 13,488 exchange items sold.

**BACKLOG RECONCILED 2026-07-25, 59 open (private `spacemolt`, SSOT).** 16 closed: fixed-but-never-closed on merge, machine-filed duplicates, and stale pipeline reports. The duplicate flood happened because the finding-filer's dedup search ran unscoped until #14 landed, so it searched the public repo and never matched an existing private issue. #491 CORRECTED: its "three broken capabilities" claim didn't hold — `scan` had ZERO attempts in 72h (the cited 27/33 was a lifetime total), `survey_system` is working (last two attempts succeeded after a scanner was fitted). Only `scan_poi` fails, 7/7 `not_in_faction`, an unmet precondition; rescoped to that gate. Root cause is #518.

**#517 STATION GEOGRAPHY SHIPPED (PR #18, merged 2026-07-25).** A dock success now records the system AND the station POI (`get_status.location.poi_id`, previously unmapped); the reload groups per system so a rarely-visited destination cannot be evicted by a chattier one; the digest names the three-step route. Service tags cover market and crafting only, since refuel and repair fall back to cargo consumables and report success identically. Detail in decisions.md. **UNPROVEN:** whether this lowers planner burn. Pre-fix baseline ~10-12 plans/hr, 6 `plan_budget_exceeded` in the hour before merge; measure after the next deploy. The pilot container still runs the PRE-MERGE image.

**ALSO FILED 2026-07-25:** #518 (P1/S) strategy reviewer reports lifetime failure totals as 72h-window rates. #519 (P2/S) improv-mode spec claims refuel/repair work only while docked; the reference disagrees.

**THEN (dev backlog, Issues SSOT):** #518 reviewer rate-window fix → #458 buy guard (cargo-value evidence attached 2026-07-25; widening it to cover value-per-cargo-slot is an open operator call) → #491 scan_poi precondition → #519 improv-mode refuel/repair drift → #456 main-checkout gate. Milestone Artifact current through M-49/50.

## Standing operational facts

Not part of the live-status refresh above; persists across waves until it changes. Not word-capped (`test/doc-size.test.ts` only gates the `## NOW` block).

- **Model policy.** Fable = prose seats, Opus everything else, cheap tiers for bulk.
- **Spend ledger.** `spend-ledger.jsonl` in the primary clone, gitignored, auto-synced by a local Windows Scheduled Task (daily 4am + logon).
- **Scheduler SSH is slow.** ~30-40s to connect to the scheduler LXC; cause still unknown, `UseDNS` already off.
- **Codex review seat (#460).** `bun scripts/codex-review.ts <PR>`, advisory, run beside the Claude reviewer.
- **#458 buy-guard detail.** `mine_resource` counts MINED only; a prior titanium buy wasted roughly 120k credits, and the guard is not yet merged.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
