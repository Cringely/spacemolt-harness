# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-28 (PR #32/#33/#36/#37/#40 merged; per-job worktree isolation complete, scheduler corruption-proof; backlog now 108 open issues). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-28. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) -> F1 strand/trap fix (#526+#543) -> F2 launch scout+corsair (#593) -> F3 loops terminate (#534/#569/#571, +#592 gap) -> F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `52ad964`); scout/corsair registered, unlaunched.

**RETRACTION: the council was never degraded (#582).** A stand-up claimed a 45-minute timeout (`durationMs: 2700087`), in no retained log; `anchors.json` shows `council: {lastResult: "ok", failStreak: 0}`. No `Bash` grant: denied lookups got reported as absence, with a fabricated number attached. Report-sink half: #508 (`write-report.ts` jailed to state dir; council PAT can't push). `core_harvest` doesn't exist (`jobs.ts:22`), #577, P0.

**MERGED: PR #29 (#557), `873f89de`.** Ceremony findings surface at every session start; filed issues get a default priority label. `.claude/` IS in the image, so a directory-presence guard never fires.

**CLOSED UNMERGED: PR #28 (#541 Leg 1).** Its manifest matches the pre-PR one under the real installer: prevented nothing, would block the core spec's `-Accept` rollout. Record on #541; producer gaps `agent-harness-core#6`/`#7`.

**BACKLOG TRIAGED.** 44 machine-filed findings: 11 closed against cited evidence, 27 labelled. Priority-ordered for the first time.

**MERGED: PR #32 (#551 dock dead-end), 02:31Z, `81ee4d36`.** Round 1's streak reset on any non-matching outcome, zeroing on every `[travel_to X, dock]` plan (our digest's own shape). 5000 ticks: 13.9h, 107 refusals, 0 reroutes, still reproducing #580. Round 2 derives the streak from the durable event log, firing after exactly 3 refusals. #551/#580 closed; #583 carries the deferred floor-durability and keying gaps. NOT PROVEN LIVE: image published, pilot redeploy unconfirmed.

**GUARD BLOCKS WERE COUNTED AS GAME FAILURES.** Verified in code: #571's 21 `complete_mission` "failures" quote our own `executor.ts:826`/`:830-832`; #581's `scan` 28/28 was the #368 guard at `executor.ts:766-780`; neither reached the wire. `failureTaxonomy` counts every `outcome: "blocked"` as a game failure; guard prose lacks a leading `code:` token, reading as a real error. PR #36 buckets them at the emitter as `prevented`. #581 closed against #368; #571 retitled.

**PILOT.** Both planner seats on `codex-subscription/gpt-5.6-terra`: 42/42 plans, 4h (2026-07-26). Economic parity with sonnet unproven, #240 Task 3.

**DIRECTION (#567).** G4 unmoved since 07-14; 7 of last 12 decisions were scheduler/ceremony. Scoping killed the "one precondition class" theory: two of five candidates were guard artifacts. Remaining: #553 (the one real precondition, fetched then failed open at `executor.ts:820`), #571's shortfall line, and deleting `scan_poi` (#552 needs faction + 600k Sensor Dome; filed five times). Metric: wasted planner calls on doomed steps, not credits, 49/72h toward 0.

**MERGED: PR #40 (#585), 00:33Z, `53c6d85`.** Third occurrence (#413, #459): a steward job's direct commit to `main` caused a 13h outage (07-27, 03:50-16:57Z). Prior fixes patched a consumer; this removes the producer. Every job now runs in its own ephemeral `git worktree` pinned to a commit, so no job's git failure can strand it. G6 advances: isolation complete, not yet confirmed live on a later cycle.

**THEN.** #534, #535, #537, #538, #529 and 103 more are tracked in `docs/backlog.md` (108 open issues).

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
