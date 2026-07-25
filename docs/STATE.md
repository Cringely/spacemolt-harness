# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-25 (merge cluster #12-#16 reconciled; pilot recovered from a stall and reached `gold_run`; backlog reconciliation closed 10 duplicate/stale issues, refiled #517/#518). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-25 (merge cluster + backlog reconciliation). Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**HARNESS UP.** Pilot container healthy on the NAS (45h uptime, verified 2026-07-25 01:09 UTC). Scheduler (#114) stayed recovered since 2026-07-21; dispatch gate still OFF by design (human-gated). Strategy job still working over the TLS store proxy.

**MERGE CLUSTER (2026-07-22/23), public spacemolt-harness main, zero PRs open, branches deleted:** #12 wired `SM_STORE_URL` through the strategy job (closed private #476); #13 moved tick bootstrap host-side, outside the checkout it repairs (closed private #459); #14 scoped the finding-filer's gh calls to the private issues repo; #15 chained-gh-merge gate round-3, comment-aware masking (closed private #466); #16 enumerated every job's gh grant, dropped the bypass wildcard (closed private #490).

**PILOT RECOVERED (supersedes the 2026-07-21 "net-negative" framing this block used to carry).** Had stalled: cargo full at 100/100, fuel down to 9/130, 8 jumps in 48min hunting a station (Xihe revisited twice), 70 plans in 6h against a 12/hour cap (43 `plan_budget_exceeded` events). Reached system `gold_run`, travelled in-system to the station POI (a jump lands the vessel at the system's sun, so a bare dock fails first), docked, refuelled, sold copper and iron, listed the gold. Now: fuel 130/130, cargo 0/100, credits 97,585, undocked, on a distress mission. Lifetime: 386,977cr earned, 30,816 ore mined, 64 missions, 463 trades, 13,488 exchange items sold.

**BACKLOG RECONCILED 2026-07-25, 63 open (private `spacemolt`, SSOT).** Closed fixed-but-never-closed: #476, #459, #466 (#490 already closed). Closed duplicate: #498/#502/#506/#511/#515 (dupes of #491), #497/#501 (consolidated into #492). Closed resolved: #500, #509 (their PRs merged), #499 (wave dispatched). Cause of the duplicate flood: the finding-filer's dedup search ran unscoped until #14 landed, hit the public repo instead of the private one, and never matched the existing issue (see #518). #491 CORRECTED and rescoped: its "three broken capabilities" claim didn't hold. `scan` had zero attempts in 72h (the cited 27/33 was a lifetime total, last attempt 2026-07-14); `survey_system` is working (its last two attempts both succeeded after a survey scanner was fitted). Only `scan_poi` fails (7/7 `not_in_faction`, an unmet precondition); rescoped to that gate, size:S priority:P2.

**FILED 2026-07-25:** #517 (P1/M) station/service geography. `digest.ts:781` builds the Connections line from the current system's neighbors only, so `travel_to` reaches the planner with no candidate destinations. IN FLIGHT on `fix/517-station-geography`. #518 (P1/S) the strategy reviewer reports lifetime failure totals as 72h-window rates, the root cause behind the #491 correction above.

**THEN (dev backlog, Issues SSOT):** #517 station geography (in flight) → #518 reviewer rate-window fix → #458 buy guard → #491 scan_poi precondition → #456 main-checkout gate. Milestone Artifact current through M-49/50.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
