# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-26 (PR #27/#30 merged; PR #28/#29 open; ceremony audit found council degraded and `core_harvest` never implemented; pilot on `codex-subscription/gpt-5.6-terra`, 42/42 plans over 4h). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-07-27 early. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**RETRACTION: the council was never degraded.** The previous version of this block stated the council "timed out at 45 minutes (`durationMs: 2700087`)". That figure came from a stand-up finding and is not a measurement. `grep 2700087` matches nothing in any retained cron log; all 23 job results on the candidate day were successes; `anchors.json` records `council: {lastResult: "ok", failStreak: 0}` with the 2026-07-26 cycle logging `subtype: success`, `duration_ms: 1092252` (~18 min) while filing #496/#567/#568. The stand-up holds no general `Bash` grant, so its freshness lookups were denied, and it reported the denial as absence with a plausible number attached. Producer fix: #582 (P1). The report-sink half is #508. `write-report.ts` is jailed to the scheduler state dir and the council's PAT cannot push, so `docs/council/` still ends at 2026-07-13 while six reports sit on the host. `core_harvest` does not exist at all (`jobs.ts:22` is a four-way union), tracked as #577, P0.

**MERGED: PR #29 (#557), 01:24Z, `873f89de`.** Ceremony findings surface at every session start; filed issues get a default priority label. Its red `verify` was not the assumed cause: `.claude/` IS in the image (`.dockerignore` carves out `hooks/`, `agents/`, `guardrails.md`), so a directory guard would never fire. Only `settings.json` was absent. Fixed by copying that file into the test stage, which removes the conditional and makes `verify` enforce hook registration.

**CLOSED UNMERGED: PR #28 (#541 Leg 1).** Review ablated the real installer across three sandbox trees: this manifest and the pre-PR manifest behave identically (9 `skipped-modified`, "9 files need attention" both ways). It does not prevent the overwrite it cites, and its entries would block the approved core spec's `-Accept` rollout. #541 stays open for Leg 2; core-side gaps (manifest v2; the installer never baselining a skipped file) need issues on agent-harness-core.

**BACKLOG TRIAGED.** 44 machine-filed findings: 11 closed against cited evidence, 27 labelled. Priority-ordered for the first time.

**IN FLIGHT.** PR #32 (#551 dock dead-end) under independent review, testing `N=3` against #580, a 13.4h recurrence longer than #551's 8.5h.

**PILOT, verified 2026-07-26T01:54Z.** Both planner seats on `codex-subscription/gpt-5.6-terra`: 42 of 42 plans over 4h. Credits 98,105→98,557; missions 84→95. Proves codex serves; does NOT prove it matches sonnet economically (no clean baseline, since the prior window's pilot was stranded). #240 Task 3 answers that.

**DIRECTION (#567).** G4 has not moved since 2026-07-14 while 7 of the last 12 decisions were scheduler/ceremony work. G4's criterion is a completed mission, and `complete_mission` fails 21×/72h on an unmet objective (#571), beside `scan` 28/28 (#581) and `scan_poi` 9/9 (#552). All one fix class: check the precondition before calling the action. It is the class that moves the gate.

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
