# Seam Manifest: instruction seams the code can silently break

An **instruction seam** is a spot where two separate pieces of code jointly define what the pilot's planner is allowed to do: one side tells the planner what to try, the other side decides what actually runs. Each side can have its own tests, all green, while the two sides quietly disagree with each other. Neither test suite catches that. A unit test proves a component is internally consistent, not that it agrees with its partner.

L-22 (`docs/wiki/engineering-lessons.md`) is the incident that named this failure class. The pilot's briefing told the planner to plan `get_missions`, a query action. The plan validator (`PlanSchema`) accepts only mutations and rejected every such plan. The briefing's own tests passed (the mission text rendered correctly) and the schema's own tests passed (queries were correctly rejected), so eleven rejected plans and zero missions run went by before anyone wrote a test asking whether the two sides *agreed*. This page lists the seams we know about, so a PR touching one side can be checked against the other. See the reviewer rule in `docs/charters/task-reviewer.md`.

## 1. Briefing (digest) ↔ PlanSchema

**Side A**: `src/planner/digest.ts:417`: the mission briefing tells the planner to `plan accept_mission` off a listing already quoted into the prompt, never to fetch the listing itself.
**Side B**: `src/registry/actions.ts:216-217`: `get_missions` and `get_active_missions` are registered `kind: "query"`. `src/registry/plan.ts:9-16` builds `PlanStepSchema` only from `kind: "mutation"` entries, so a query action is structurally unplannable.

**How they drift.** Anyone editing the briefing prose could reintroduce an instruction to "check get_missions first" without touching the schema; the two files share no reference, only a convention. The reverse drift (loosening `PlanSchema` to admit queries) would silently make the planner spend a tick on a read instead of a write, unnoticed unless someone is watching tick economics.

**Spanning tests.** `test/digest.test.ts:371` ("never names the mission queries as actions to plan") pins side A. `test/registry.test.ts:108` ("rejects queries as plan steps") pins side B, naming `get_missions` explicitly. Together they cover the invariant from both ends; no new test needed.

## 2. Executor guard-strings ↔ digest (the #156 side door)

**Side A**: `src/agent/executor.ts:611-618`: the `accept_mission` precondition guard returns a blocked-reason string when the plan carries neither `id` nor `template_id`.
**Side B**: `src/agent/wake.ts:64` copies that reason verbatim into `wake.detail` on the next wake. `src/planner/digest.ts:192` quotes `wake.detail` straight into the prompt as the "Wake reason" line.

**How they drift.** The #147 fix closed the direct leak (the briefing no longer told the planner to call `get_missions`), but the guard's own reason text was a second, easy-to-miss path for the same unplannable instruction to reach the planner. A block reason is just a string, and nothing stops it from naming an action the schema will reject. Any future guard reason that happens to mention a query action reopens this exact hole, because guard strings are free text with no schema of their own.

**Spanning test.** `test/executor.test.ts:176-185` pins the exact guard-reason string and confirms it points at "the mission listing in your briefing" instead of naming `get_missions`. Reused as-is; no duplicate written.

## 3. Tool-list ↔ executor (`travel_to`, hand-added in three places)

**Side A**: `src/planner/digest.ts:134`: `TRAVEL_TO_VOCAB`, a hand-written string telling the planner `travel_to(system_id:string)` exists.
**Side B**: `src/registry/plan.ts:24-27`: `TravelToStepSchema`, admitting `{ system_id: string }`.
**Side C**: `src/agent/executor.ts:680-681`: dispatches a `travel_to` step to `travelToTick`, which reads `step.params.system_id` (line 421) and forwards it to `find_route`.

`travel_to` is not a real game action; it expands into a sequence of `jump` calls, so it has no `REGISTRY` entry (`src/registry/actions.ts`) to derive from. All three sides are hand-typed. Every other action gets `ACTION_VOCAB` and `PlanStepSchema` generated mechanically from one `REGISTRY` array, which is exactly why those two can't drift apart.

**How they drift.** Renaming the param (say, `system_id` to `target_system`) in the schema would still type-check the executor, because TypeScript ties `step.params.system_id` to whatever `PlanStepSchema` currently says. It would not touch the plain string in `TRAVEL_TO_VOCAB`. The planner would keep being told a param name the schema no longer accepts, and every `travel_to` plan would fail admission with no obvious cause.

**Spanning test (new).** `test/seam-tool-list-executor.test.ts` asserts, in one test, that the digest's vocab line names `system_id`, that `PlanSchema` accepts `system_id` and rejects a request keyed on `target_system` instead, and that `executeTick` reads `params.system_id` and forwards it to `find_route`. A drift on any one side fails the test.

## 4. Deterministic guards ↔ improv-briefing

**Side A**: roughly two dozen deterministic guards scattered across `src/agent/executor.ts`, `src/agent/agent.ts`, `src/planner/digest.ts`, and `src/agent/wake.ts` (undock no-op, accept_mission empty-param, mining-laser precondition, target-locality, and more).
**Side B**: section 4 of `docs/superpowers/specs/2026-07-12-improv-mode.md`, the standing briefing an improv-mode run reads in place of the code, when the pilot is self-driving with no deterministic backstop underneath it.

AGENTS.md binds every new deterministic guard to a paired improv-mode instruction, so the crystallized lesson survives when the deterministic backstop is gone. Improv mode has no `executor.ts` to fall back on. The prose is the guard.

**How they drift.** A guard added to the code with no matching spec update leaves improv mode blind to a lesson the deterministic path already learned the hard way. It is pure prose, so nothing forces the pairing except discipline.

**Spanning test.** `test/improv-parity.test.ts` (issue #163) already covers this seam in full: a `SEAMS` manifest keyed two ways (a code marker proving the guard still exists, and topic anchors the spec's §4 briefing must satisfy) for every guard, one pair per entry. That file predates this page and is more complete than a duplicate here would be. Read it for the current guard list rather than this page.

## 5. Mission completion-readiness: digest verdict ↔ executor guard (#291 regression)

**Side A**: `src/planner/digest.ts`, `renderMissionObjectiveCheck` (the "Completion check: NOT ready / READY" verdict): tells the planner whether to *try* `complete_mission` for an active mission, derived from each objective's `current` against its `required`.
**Side B**: `src/agent/executor.ts`, `completeMissionBlock`: decides what actually *runs*. It refuses a `complete_mission` step when a parsed objective is still short (`current < required`, not `completed`), before the doomed call spends a tick.

Both sides read the SAME satisfaction predicate (an objective is met when `current >= required` or its `completed` flag is set) off the SAME parsed shape (`get_active_missions` maps to `ActiveMissionInfo.objectives`, `src/client/client.ts`). Nothing but this note forces them to agree. This is the seam #291 reopened on: the digest already rendered the raw progress numbers, but with no readiness directive and no enforcing guard, the pilot fired `complete_mission` 12 times against one contract still under 20/20, each rejected `mission_incomplete`.

**How they drift.** Change the predicate on one side only (say, start counting `in_storage` toward "met" in the digest but not in the guard, or tighten the guard to also require presence at `target_base` without saying so in the digest) and the two silently disagree: the digest says READY while the guard blocks, or the reverse. Each side's own tests stay green because neither asserts the other's predicate. Both sides fail OPEN on unknown numbers (absence is never a verdict, #94), so a divergence degrades to a missed nudge or a passed-through call the game re-judges, never a crash. A steady disagreement, though, re-opens the thrash.

**Spanning tests.** `test/agent-mission-progress.test.ts` ("NOT-ready verdict names the shortfall", "READY verdict names the complete_mission call", "count UNKNOWN → no verdict fabricated") pins side A. `test/executor.test.ts` ("objective short of required blocks before the wire", "every objective met passes through", "fails OPEN when the mission is absent") pins side B. `test/improv-parity.test.ts` pins the guard↔§4-briefing half. A predicate change on one side that is not mirrored on the other fails at least one of these.

## 6. Standing-instruction satisfaction: digest prose ↔ PlanSchema field ↔ honor site (#355)

**Side A**: `src/planner/digest.ts:248` (and the response-shape line at `digest.ts:568`): the STANDING OPERATOR INSTRUCTION block tells the planner to report a carried-out instruction by setting `"instruction_done": true` in its plan JSON. The key name lives in prose.
**Side B**: `src/registry/plan.ts:48`: `PlanSchema` admits `instruction_done` as an optional boolean. `PlanSchema` is `.strict()`, so a key the prose names but the schema lacks makes every satisfaction report REJECT the whole plan.
**Side C**: `src/agent/agent.ts:1775`: the honor site reads `plan.instruction_done` and retires the standing instruction from goals, but only on a wake where the block was actually shown.

**How they drift.** Rename the key on any one side and the others still typecheck or keep their own tests green: prose naming a key the schema rejects turns every "done" report into a rejected plan (the planner is punished for obeying the briefing); a schema key the prose never names is dead weight the planner cannot discover; an honor site reading a different key silently never clears, so the block nags forever. All three failure shapes are quiet, which is what makes this a seam.

**Spanning tests.** `test/instruction-salience.test.ts` ("the digest's advertised key is the key PlanSchema accepts") pins prose↔schema on the literal key string. Its "instruction_done drops the prominence and retires the goal" test drives a MockPlanner plan carrying the flag through `PlanSchema.parse` and the honor site in one pass, so a drift on any side fails at least one of the two.

## 7. Scheduler job table ↔ charter files (path + `## Tier` line)

**Side A**: `src/scheduler/jobs.ts:35-36`, `:53-54`, `:81-82`, `:102-103`: each scheduled job row names the charter (or brief) file it arms (`charterPath`) and the model it spawns with (`model`). These are plain strings and enum values in code.
**Side B**: the charter files themselves (`docs/charters/soc-monitor.md:55`, `docs/charters/strategy-reviewer.md:87`, `docs/briefs/council-review.md:41`, `docs/charters/doc-steward.md:138`): each carries a `## Tier` section whose first line names the model the operator wants that role to run on. The charter is the operator's model-pin lever; the job table is what actually spends.

**How they drift.** Rename or move a charter file and the job table still compiles: the spawn reads an absent file, and (before the runner's guard) would arm an empty identity at full cadence. Change a charter's `## Tier` line (say sonnet to haiku to cut spend) without touching `jobs.ts` and the scheduler keeps paying the old model on every fire, or the reverse: a code-side model change the charter never agreed to. Nothing but this pairing forces the two files to agree; the paths and the model names live in prose on one side and literals on the other.

**Spanning test.** `test/scheduler-briefs.test.ts` pins both halves: "every JOBS charter/brief path exists and is non-empty" catches the rename, and "each charter/brief `## Tier` line names the same model family as JOBS[i].model" catches a tier change mirrored on only one side (the line must name exactly one family, so a charter naming both models cannot slip past the inclusion check).

## 8. Cron trigger phase ↔ grid schedule offsets (#114 E1)

**Side A**: the operator's private GitOps repo runbook (relocated out of this repo): the production host's cron entry's literal schedule string, `7,17,27,37,47,57 * * * *`.
**Side B**: `src/scheduler/jobs.ts:34` (stand-up, `offsetMs: 7 * MIN`), `:52` (strategy, `offsetMs: 27 * MIN`), `:80` (council, `offsetMs: 6 * HOUR + 19 * MIN`): the grid offsets `due.ts` matches against, computed as plain UTC-epoch arithmetic (`jobs.ts:25-30`'s own comment: the math is deliberately timezone-free).

**How they drift.** The cron string and the offset constants are two independent places naming the same `:07` minute-of-hour phase, with nothing but this manifest forcing them to agree. Move the cron minutes without touching `jobs.ts`, or add a new job whose offset falls on a minute the cron string never fires, and the documented cadence quietly stops matching what actually runs: catch-up still fires the job within one grid cycle either way, so nothing crashes, but the runbook's stated schedule becomes fiction. A second, sharper drift sits on the council job alone: its `offsetMs` is a UTC instant (06:19 UTC), not the operator's local wall clock. Someone reading "06:19" and expecting their own morning, then later "fixing" the constant to a value that only makes sense in local time, would silently shift the daily council to the wrong UTC hour, with no test on either side able to see the mismatch, since `due.ts`'s tests fix a UTC clock by construction and know nothing about an operator's timezone expectation.

**Spanning check.** `test/scheduler-due.test.ts`'s "grid offsets hold the mandated phase (:07, :27, 06:19)" pins the code side: each job fires exactly at its mandated phase, never 10 minutes early, and its own comment names this seam by pointer ("runbook E1 cites these constants"). There is no automated check on the cron-string side (a host scheduler UI field is not something `bun test` can read), so that half stays procedural: the operator's private GitOps repo runbook (step 6) cites the same `jobs.ts:34`/`:52`/`:80` line numbers this entry does, and a PR changing either the cron schedule or a grid `offsetMs` constant should update both the test's expected phases and that runbook's cited lines in the same change.

## 9. Filing/report invocation: work-order prose ↔ brief ↔ CLI flags (#114 headless filing)

**Side A**: `src/scheduler/spawn.ts:72` (`FILING_HOWTO`, the finding-filing command form) and `:89`/`:93` (the strategy and council report-writing command form). This free-text prose is dispatched verbatim into every job's work order and tells the agent the exact command to run. `docs/briefs/council-review.md:28-40` (the council brief's Output section) carries the same two instructions and is loaded verbatim as well.
**Side B**: `scripts/file-finding.ts:49` and `scripts/write-report.ts:56` read the body from a `--body-b64` argv flag and decode it through `src/scheduler/body-arg.ts`.

Both sides must agree on one thing no schema forces: the body reaches the script as a single-line `--body-b64 <base64>` token. A headless job runs under a closed `allowedTools` list, and Claude Code's permission layer splits a Bash command on newlines and matches each fragment on its own. A heredoc body, a `printf ... |` pipe, or any STDIN form produces fragments that match no rule, so the whole `claude -p` run is denied. That is the #114 defect: the prose named a form (first `--body-file` under a write-jailed outbox, then a STDIN heredoc) that could not run headless, while every offline test passed.

**How they drift.** Rename the flag in a script (say `--body-b64` to `--body64`) and the prose keeps naming a flag the script rejects. Edit the prose back toward a heredoc, a pipe, or a STDIN body and the command the agent runs is denied by the permission layer before the script is reached. Either way each side's own tests stay green: the script parses its own flags, the prose renders into the prompt, and nothing but this pairing makes them agree on the one-line-base64 contract.

**Spanning tests.** `test/scheduler-spawn.test.ts:88` ("every work order instructs single-line --body-b64 filing, never heredoc/STDIN/--body-file") pins side A's spawn prose. `test/scheduler-briefs.test.ts:59` ("no charter/brief instructs the dead --body-file filing form") pins the brief. `test/scheduler-filing.test.ts` (the file-finding CLI block: `--body-b64` required, malformed base64 rejected) and `test/write-report.test.ts` (the `--body-b64` round-trip writes byte-identical) pin side B. A rename or a reverted method on either side fails at least one.

## 10. Triage ordering: council brief §Triage ↔ soc-monitor step 3

**Side A**: `docs/briefs/council-review.md` §Triage (v1.3): each council run ranks the issues filed since its last report and emits an ordered `## Triage` section in its dated report under `$SCHEDULER_STATE_DIR/reports/`.
**Side B**: `docs/charters/soc-monitor.md` step 3: stand-up's "council ordering" is defined as that exact section of the newest `*-council-review.md` report, with a 48h staleness fallback to backlog-epic order.

**How they drift.** Both sides are prose in different files read by different jobs. Rename the section on the producer side (or move reports out of the state dir) and the consumer's lookup finds nothing; stand-up silently falls back to bare backlog order forever, and the triage ceremony steers nobody. Loosen the consumer's staleness window and a week-old ranking outranks fresh epics.

**Spanning test.** `test/seam-triage-ordering.test.ts` pins the section name on both sides, the reports path on the consumer, and the 48h fallback. A rename or a dropped fallback on either side fails it.

## 11. Strategy store-access description: work-order prose ↔ guardrails prose ↔ real transport (#114 A1, PR #425)

**Side A**: `src/scheduler/spawn.ts:157` (the strategy job's `workOrder()` prompt) and `.claude/guardrails.md:124-126` both describe, in free-text prose, HOW the strategy-review job reaches the harness store.
**Side B**: the real transport, `scripts/strategy-store.ts` (the thin caller) and `src/server/server.ts`'s `/api/store/*` routes (bearer-token HTTP, `X-Store-Token` header). `jobs.ts`'s `allowedTools` grant for the job is the enforced boundary; the prose is only ever a description of it, read by the job itself.

**How they drift.** The store transport has already pivoted twice (docker-exec → SSH forced-command → HTTP bearer), and each pivot changed the code without updating one or both prose copies. A stale copy is not a security hole (the job has no grant to act on the wrong mechanism), but it makes the job misreport its own access method in every report it files, and misleads a human reading the guardrails file about what actually runs.

**Spanning test.** `test/scheduler-spawn.test.ts` ("strategy work order describes the real HTTP transport, never the dead SSH/forced-command one") pins side A's spawn prose against the real mechanism. No automated check exists on `guardrails.md`'s prose (it is operator-facing documentation, not agent input), so a PR touching the store transport should grep both files by hand.

## Keeping the manifest current

Adding a new hand-paired instruction seam (two files that must agree with no shared schema forcing it)? Add a section here with real file:line anchors, and either point at an existing spanning test or write one. A seam entry with no spanning test and no noted reason is not finished.
