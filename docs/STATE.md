# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-26 (PR #27/#30 merged; PR #28/#29 open; ceremony audit found council degraded and `core_harvest` never implemented; pilot on `codex-subscription/gpt-5.6-terra`, 42/42 plans over 4h). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-26. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**MERGED: PR #27 (#240 Task 1), 99a6145.** Reversible planner fallback: two consecutive endpoint-down failures arm the backup planner; every third replan probes the primary, so recovery is automatic instead of a 12h manual latch. The planner fetch now carries a timeout. Two review rounds; round 1 deleted an unproven `try/catch` in `openai-compat.ts`. 11 ablations plus 7 reviewer-built mutations, all red.

**MERGED: PR #30 (#550), 5ee7f4e.** `gen-backlog.py` called `gh issue list` with no `--repo`, resolving against the code repo instead of the backlog repo and gutting a prior steward regen from 48 issues to 3. Now pinned to the real repo, plus a floor check refusing an implausibly small write, plus seam-manifest entry #13. Verified by reverting the pin and re-running against live `gh`: reproduced the original bug exactly; the floor check caught it alone; `docs/backlog.md` confirmed byte-identical by SHA-256.

**OPEN, needs a reviewer: PR #28.** #541 Leg 1 pulls agent-harness-core forward; the manifest now tracks 11 core files (was 2).

**OPEN, under revision: PR #29.** Ceremony-findings visibility. Review found the hook registered only in the harness clone; the PM session runs from the private clone, so it never fired there. The PR remains open, unmerged.

**CEREMONY AUDIT (2026-07-26): ground truth on all five ceremonies.** standup and strategy are healthy (13 fires exactly 7200000ms apart over 26h; 00:30-00:43Z run filed 3 findings). council is DEGRADED: last attempt timed out at 45 minutes (`durationMs: 2700087`), last success 2026-07-24T06:33:32Z — filed as #558 (P0); the larger half of that issue is that a failed ceremony surfaces nowhere at all. steward was blocked on #554 (a PAT scoped before the origin repoint); now re-scoped, pushing works. `core_harvest` was NEVER IMPLEMENTED: absent from the scheduler's job-id union, its ledger file has never existed, though `docs/wiki/team-ceremonies.md` describes a 48h cycle for it — #541 raised to P0.

**CEREMONY FINDINGS NOW DRIVING THE QUEUE** (23 of 28 open `machine-filed` issues carried no priority label, invisible to priority-ordered triage). #551 (P1): `dock`'s "no station" failure, 68 occurrences/72h, drove the 8h stall ending in the fuel strand; fix in progress. #552 (P1): `scan_poi` 9/9 lifetime failures, always `not_in_faction`. #553 (P2): `mission_not_found`, 28 occurrences, still firing at window end. #561 (P2): PowerShell silently skips ~24 tests while printing `0 fail` (the probe measures the launching shell, not the machine). #562 (P3): the floor check ratchets down over passing runs, weakest with no baseline.

**PILOT, verified 2026-07-26T01:54Z.** Both planner seats on `codex-subscription/gpt-5.6-terra`: 42 of 42 plans over 4h, 1 `planner_error`. Credits 98,105→98,557; missions 84→95; trades 465→466. This proves codex serves and the pilot progresses; it does NOT prove codex matches sonnet economically — the prior window's pilot was stranded, so there is no clean baseline. #240 Task 3 (the offline eval) is what would answer that.

**THEN.** #534, #535, #537, #538, #529 and the rest of the open backlog are tracked in `docs/backlog.md`.

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
