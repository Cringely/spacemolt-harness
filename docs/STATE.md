# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-28 (PR #32/#33/#36/#37/#40 merged; per-job worktree isolation complete, scheduler corruption-proof). Then PR #42/#43: steer lever restored, CI git install fixed. Backlog 108 open issues. Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-28 after PR #42/#43. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495, PR #42, `e9114af`) SHIPPED -> F1 strand/trap fix (#526+#543) -> F2 launch scout+corsair (#593) -> F3 loops terminate (#534/#569/#571, +#592 gap) -> F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `e9114af`); scout/corsair registered, unlaunched.

**CI FIXED: git binary in test environments (PR #43, `6c74dd8`).** Main was red since PR #40 (scheduler worktree tests need git binary). Dockerfile test stage + container.yml test job now install git; test stage also copies .githooks so fence tests run. Unblocks #413/#459 scheduler-outage regression tests that were silently skipped.

**KNOWN ISSUES:** Council degraded claim falsified (#582: 45min timeout in no log; `core_harvest` never implemented #577, P0). Per-job worktree isolation complete (PR #40 #42); scheduler stage 1 live. Pilot on Codex `gpt-5.6-terra` both seats: 42/42 plans, 4h sample. G4 unmoved since 07-14; six issues remain.

**BACKLOG:** 115 open issues in `docs/backlog.md`. Largest recent failure class: `dock`'s "no station" error (#551, 68 occurrences).

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
