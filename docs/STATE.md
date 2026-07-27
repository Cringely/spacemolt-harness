# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-26 (PR #27/#30 merged; PR #28/#29 open; ceremony audit found council degraded and `core_harvest` never implemented; pilot on `codex-subscription/gpt-5.6-terra`, 42/42 plans over 4h). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-27 early. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**RETRACTION: the council was never degraded (#582).** A stand-up finding reported it "timed out at 45 minutes (`durationMs: 2700087`)". That figure appears in no retained log; `anchors.json` records `council: {lastResult: "ok", failStreak: 0}`. The stand-up holds no general `Bash` grant, so its freshness lookups were denied and it reported the denial as absence with a plausible number attached. Report-sink half: #508, since `write-report.ts` is jailed to the state dir and the council's PAT cannot push. `core_harvest` does not exist at all (`jobs.ts:22`), #577, P0.

**MERGED: PR #29 (#557), `873f89de`.** Ceremony findings surface at every session start; filed issues get a default priority label. Container note: `.claude/` IS in the image, so a directory-presence guard never fires there.

**CLOSED UNMERGED: PR #28 (#541 Leg 1).** Its manifest and the pre-PR one behave identically under the real installer, so it prevented nothing, and its entries would block the core spec's `-Accept` rollout. Record on #541; producer gaps `agent-harness-core#6`/`#7`.

**BACKLOG TRIAGED.** 44 machine-filed findings: 11 closed against cited evidence, 27 labelled. Priority-ordered for the first time.

**MERGED: PR #32 (#551 dock dead-end), 02:31Z, `81ee4d36`.** BLOCK then REVISE first. Round 1's guard was measurably inert: its streak reset on any non-matching outcome, so a `[travel_to X, dock]` plan (the shape our own digest asks for) zeroed it every cycle. 5000 ticks: 13.9 simulated hours, 107 refusals, 0 reroutes, reproducing #580's episode against the fix meant to stop it. Round 2 derives the streak from the durable event log, verified firing after exactly 3 refusals. #551/#580 closed; #583 carries the deferred floor-durability and keying gaps. NOT PROVEN LIVE: image published, pilot redeploy unconfirmed.

**GUARD BLOCKS WERE COUNTED AS GAME FAILURES.** Verified in code: #571's 21 `complete_mission` "game failures" quote text our own `executor.ts:826`/`:830-832` emits, and #581's `scan` 28/28 was the #368 guard at `executor.ts:766-780`. Neither reached the wire. `failureTaxonomy` counts every `outcome: "blocked"` as a game failure, and guard prose carries no leading `code:` token, so it normalizes into something indistinguishable from a real error class. A working guard pins its own action at 100% failure and gets filed P1. PR #36 flags them at the emitter into a `prevented` bucket. #581 closed against #368; #571 retitled.

**PILOT.** Both planner seats on `codex-subscription/gpt-5.6-terra`, 42/42 plans over 4h (2026-07-26). Economic parity with sonnet unproven, #240 Task 3.

**DIRECTION (#567).** G4 unmoved since 2026-07-14 while 7 of the last 12 decisions were scheduler/ceremony work. Scoping killed the "one precondition class" theory: two of the five candidates were guard artifacts. What remains is #553 (the one real pre-call-knowable precondition, already fetched then failed open at `executor.ts:820`), #571's shortfall line, and deleting `scan_poi` from the registry (#552 needs faction plus a 600k Sensor Dome; filed five times). Metric is wasted planner calls on doomed mission steps, 49/72h toward 0, rather than any credit figure.

**THEN.** #534, #535, #537, #538, #529 and the rest are tracked in `docs/backlog.md`.

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
