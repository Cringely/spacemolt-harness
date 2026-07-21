# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-21 (scheduler recovered + strategy working; pilot UP but net-negative and needs steer). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-21 (scheduler recovered; whole harness verified live). Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**HARNESS FULLY UP (verified live 2026-07-21).** All three legs confirmed by live evidence, not assumption:
- **Pilot.** Container UP on the NAS, CURRENT image `ghcr.io/cringely/spacemolt-harness:5e80304` (not old `eb0056b`; confirms GHCR pulls fine). Was NET-NEGATIVE (see PILOT STEERED below); now steered and correcting.
- **Scheduler (#114).** RECOVERED. A 32h Jul-20/21 outage traced to the tick's `git pull --ff-only` failing every cycle on an unpushed local steward commit (`d951648`); cron and box were healthy throughout. Fixed by repointing `~/checkout` origin from the archived private repo to public `spacemolt-harness` and hard-resetting to public main. Verified by a live standup tick ($0.137, ok). Dispatch gate stays OFF by design (human-gated `verifiedLiveAt`); jobs run flag-only. Decisions entry 2026-07-21.
- **Strategy job.** WORKING, not blocked (the old docker-exec "blocked" claim was stale). HTTP store over the TLS reverse-proxy (`SM_STORE_URL=https://spacemolt.fozzitik.com`) live-verified: HTTP 401 to a token-less probe (reachable, auth intact), config present, prior 33k-token review ran.

**P0 PUBLIC FLIP, FULLY CLOSED (2026-07-20/21).** `github.com/Cringely/spacemolt-harness` LIVE and primary, seeded one clean null-history commit. Private `spacemolt` ARCHIVED; flaky AI-findings check DISABLED; cosign secrets added; GHCR pull confirmed. Post-flip hardening PRs #1-#6 merged (LICENSE, SECURITY.md, ruleset, CodeQL, Dependabot, exec-bit restore).

**SPEND LEDGER.** Relocated to the primary clone (`spend-ledger.jsonl`, gitignored) and auto-synced by a local Windows Scheduled Task (daily 4am + logon; verified exit 0). All-time est ~$4,471 (project-scoped; `/usage` = account truth).

**MODEL POLICY.** Fable = prose seats, Opus everything else, cheap tiers for bulk.

**PILOT STEERED 2026-07-21 (net-negative loop broken).** Root cause: chasing an unreachable Titanium Contract (0/20 for 11h; belts had no titanium/no station), mining common ore into a full hold it never sold, hopping systems on fuel. Net −1,788cr/24h while the heartbeat read `progressing` off `ore_mined` (activity, not outcome). Steer sent via `/api/agents/miner/instruct` (verified: pilot now DOCKED at Grand Exchange, weighing abandon-vs-pursue). Structural fixes FILED on public: #7 outcome-weighted heartbeat, #8 outcome-based stall detection (act on `zeroProgressHours`), #9 resource-aware routing. Watch the next window to confirm credits recover.

**BACKLOG-MIGRATION GAP.** Old issue numbers in this doc (#183/#458/#459/#453/#213 etc.) live on the ARCHIVED private repo (read-only); the public repo's issue counter restarted at #1. The custom label taxonomy (type/epic/size/priority) also didn't transfer. Migrate open issues + labels to public, or the backlog restarts there. #183 usage-poll HTTP 403 (Stage-4 self-poll; non-fatal) is one such private-repo number. #458 P1 buy-guard (mine_resource counts MINED only; a prior titanium buy wasted ~120k cr; guard not yet landed). Slow SSH to the scheduler LXC (~30-40s connect; cause TBD, UseDNS already off). Codex review seat (#460): `bun scripts/codex-review.ts <PR>` advisory, run beside the Claude reviewer.

**THEN (dev backlog, Issues SSOT):** #459 host bootstrap + #458 buy guard (P1); #456 main-checkout gate; #466 merge-chain gate; #453 stall phase 2; #213 goal-ladders off-peak. Milestone Artifact current through M-49/50.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
