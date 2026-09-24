# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.


**Last updated:** 2026-09-24, doc-steward pass reconciling wave-5 cluster PRs #137-#147 (tracker #1115/#1114/#1116/#1135/#1136/#1133 closed). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-09-24 (fifth pass, cluster #137-#147). Boot from this block + `docs/backlog.md` + `docs/game-reference/commands.md`._

**SEVEN PRs MERGED, SIX TRACKER ISSUES CLOSED.** #137 (`b53dffc`): four core-managed hooks synced, pilot code untouched. #140 (`1f666a3`) closes #1115: an affordability refuel give-up clears once credits rise above the balance recorded at the failure. A dry-station give-up still latches (#672 intact). Legacy rows classify from their stored message. #142 (`af3e309`) closes #1114: each briefing carries a bounded distress fact for any fleet-mate under a 20-credit refuel floor, naming a credits gift in prose, never a filled-in command (zero-fuel trigger dropped: a gift cannot fix credits-but-no-fuel). #139 (`045d765`) closes #1116: the buy-guard refusal names `create_buy_order` in prose, template removed. A docked pilot refused an overpriced `fuel_cell` is steered to `refuel` when the station reports reserve fuel. #143 (`b985d59`) closes #1135: the weekly backlog dedupe ceremony, built to the merged spec, shipped GATED OFF (`gates.json` `dedupePosting`, default off, fails closed). Review removed a file-finding grant that let a gated-off run write to the tracker. #141 (`fefe4d9`) closes #1136: the scheduled doc-steward ceremony stands down while a dispatched steward PR covers the same merges, 24-hour bound, fork PRs ignored. #147 (`3cfa929`) closes #1133: after every minted-key tier misses, `fileFinding` bumps an open issue whose title matches (the ceremony's `isNearDuplicateTitle`), with a filer-only veto on titles naming a different pilot, game action or scheduler job. An unreadable backlog falls back to create. Replay, 2026-09-22 snapshot: 28 of 306 duplicates bumped, zero cross-pilot, cross-action or cross-job. Ceremonies filed #1137, #1138 (titled P0, labelled P2: strategy-review ceremony crashes on a zod v4 mismatch, 7+ duplicate filings) and #1139. #1134 (flaky Windows scheduler tests, P2) open. See L-59.

**DEDUPE DRY RUN (PM local, 2026-09-23, gate off, zero tracker writes, semantic pass not run).** 514 open issues, 27 clusters with 36 members, 20 proposals (the per-run budget, all high-tier), 16 deferred. PM spot check of 12: 11 the same defect, one pairing a council failure alarm onto a strategy failure alarm (two different jobs). Live posting needs the uncreated labels `dedupe:candidate` and `dedupe:confirmed`, and an operator decision.

**LIVE PROOF: NONE YET.** Signals: a latched pilot refuelling itself once credits arrive (#1115), a solvent pilot gifting a rescue unprompted (#1114), zero guard-sourced buy orders (#1116), fewer new duplicate clusters per week (#1133), a week with at most one steward PR per merge cluster (#1136).

**DEPLOY STATE, PM capture 2026-09-24T05:55Z (not verifiable from the repo).** Prod pilot container healthy on image `fefe4d9`, started 2026-09-24T00:06Z, carrying #137 through #141. #147 (`3cfa929`) merged after the capture, not yet auto-deployed. Scheduler code runs on the scheduler host, which pulls main on its own cadence. Nothing in the capture shows pilot behaviour.

**SUPERSEDED by this pass:** five scheduler-ceremony steward PRs (#136, #138, #144, #145, #146) sat open at once, the #1136 defect reproducing live while its fix was in review.

**BACKLOG:** `docs/backlog.md`, regenerated this pass.

**Next:** #1138, the live signals above, the dedupe-posting call (labels first). F4 (3 pilots/24h/zero strands, steer confirmed) stays open.

## Recent history, 2026-09-24

Moved out of `## NOW` on 2026-09-24 (fifth pass) to fit the 500-word cap. Superseded only where the block above says so. Extracted verbatim from `origin/main`'s pre-09-24 `docs/STATE.md`.

**FIVE PRs MERGED, SIX TRACKER ISSUES CLOSED.** #127 (`6fd39e0`) closes #982 and #1003: every item-bearing plan step (buy/sell/jettison/withdraw/deposit/create_sell_order/create_buy_order) now validates its item id against the catalog SSOT at plan admission, replacing a buy-only post-hoc correction that never covered the other six actions. #128 (`326e428`) closes #700: the stale-mission advisory threshold now derives from each mission's own expiry instead of a flat 24h, so a ~3h distress mission can trip near its own halfway point. #129 (`a9dbcd3`) closes #1076 (dupes #932, #997): a narrow guard blocks `craft` only when station storage is provably empty, paired with a deposit-first briefing line. #131 (`7ab54a3`) closes #931 and #1051: the digest points the planner at the parsed `mission_id` instead of raw listing prose (#913/#614 closed as superseded by PR #107's guard, with #131 adding the id-choice half), and mission rewards (credits, skill_xp) are now parsed and rendered for ranking. #132 (`c4afd5d`) is docs-only: the backlog dedupe ceremony spec.

**DEDUPE MEASUREMENT (from #132's own evidence, not yet a shipped ceremony).** 389 of 521 open issues cluster into 83 underlying conditions. 43 of those clusters (249 issues) are high-confidence, one fix closes every member. Filed as #1133 (fix the filer itself, P1) and #1135 (build the ceremony to the merged spec, P1). This is the backlog's real shape, not the open-issue count.

**THE CORSAIR RESCUE, 2026-09-20, PM live capture (not verifiable from the repo).** corsair sat docked at iron_reach, 0 fuel, 5 credits, repeating an unaffordable refuel. 07:30:49Z: the #534 escalation (PR #114) armed live for the first time in production, three arms on one fingerprint, six replans, planner calls zero for 9+ hours. #534 is now proven live, not just offline-tested. 16:50:13Z: a PM steer gifted 1,500 credits. Corsair still didn't move, the latch now filed as #1115 (a refuel give-up keyed on affordability never clears once credits arrive). 17:22Z: a second steer got it moving, but the #458 buy guard (PR #115) refused a fuel cell at 400cr/unit against a 43cr catalog value, twice, live-proving #458 in production. Corsair then refuelled at the station for 540cr and got underway. Filed #1114 (no pilot can request/offer a fleet rescue without a human) and #1116 (the buy guard's refusal hands the planner a filled-in `create_buy_order` template, the #681 pattern).

**DEPLOY STATE, PM live capture (not verifiable from the repo).** Prod ran `7ab54a3` (PR #131's merge commit) from 2026-09-23T04:20:27Z, healthy at 04:45Z, `RestartCount 0`. `c4afd5d` (#132) is docs-only and builds no image, so `7ab54a3` is still the deployed code. Earlier: `ece3650` from 09-19T19:49Z and `d7ab050` from 09-19T23:28Z, both healthy. The corsair rescue above ran on `d7ab050`, before this wave's PRs existed.

**BACKLOG:** see `docs/backlog.md`, regenerated this pass.

**Next:** the fleet-rescue path blocks F4 (3 pilots/24h/zero strands) more directly than anything else queued: #1114 and #1115 (both P1), with #1116 (P2) alongside them. #1133/#1135 (dedupe) are process debt. #1134 (two flaky scheduler tests, P2) is not blocking.

## Recent history, 2026-09-22

Moved out of `## NOW` on 2026-09-22 (fourth pass) to fit the 500-word cap; superseded only where the block above says so. Extracted verbatim from `origin/main`'s pre-09-22 `docs/STATE.md`.

**SIX PRs MERGED, FOUR TRACKER ISSUES CLOSED.** #119 (`018807d`) and #122 (`086a90d`, a same-day comment fast-follow) close #1047: an operator goal naming an exact item no longer loses its purchase slot to an earlier goal's multi-tier family match. #120 (`83a0fd6`) closes #1045: the undocked fuel-reserve floor now survives a measured jumps verdict instead of being silently dropped as a fallback argument; a retired cargo-mass fuel claim also came out of the improv briefing. #121 (`d89fecf`) and #123 (`d7ab050`, a same-day must-fix the first PR's squash-merge missed) close #1106: the #817 standing-instruction pin is now reachable from the dashboard, the digest stopped contradicting the retirement guard, and the Standing checkbox no longer survives an agent switch. #124 (`8a5140f`) closes #1053.

**#1053'S PREMISE WAS PARTLY REFUTED, DO NOT READ THIS AS "MESSAGE NOW REACHES THE FILER."** `failures.ts` never discarded the message half of a coded error; `FailureClassRow.sample` has carried the full raw result text since the repo's first public commit, and it already reached the strategy reviewer's dump. The live gap was narrower: `docs/charters/strategy-reviewer.md`'s Issue-bump evidence line named only window, counts, and class, so the filing agent quoted a bare class and inferred the rest (#706 is the receipt). PR #124 names `sample` in the charter, requires it quoted as data, and bounds it through the digest's existing 200-char untrusted-text clip.

**PROCESS NOTE, dispatcher observation.** Five of the six PRs above were merged by the fix-round agents, not the PM: the briefs said "open a PR" and never named who merges, so the PM's merge-time checks ran after the fact. `gh` names one account as merger on all six, so the repo cannot separate agent from seat. What it does show: every merge commit is covered by a council or independent-verify ADVANCE (#122's sits on #119, #123's on #121), CI green on each, five merges inside 32 minutes. Nothing unsafe shipped. See L-57.

**DEPLOY STATE, PM live capture 2026-09-19 (not verifiable from the repo).** Prod ran `ece3650` from 19:49:27Z (confirmed prior pass), then `d7ab050` from 23:28:26Z (auto-deploy cron); at 23:35Z healthy, `RestartCount 0`, zero crash-class log lines, all three pilots emitting `status_snapshot`. `8a5140f` (#124) had not yet been observed on the host at capture time.

**LIVE SIGNAL for #1047, PM capture, a baseline not a proof.** On `ece3650`, 19:49:27Z-22:43Z: miner logged 18 `purchase_candidate_overflow`, scout and corsair zero, against 34 plans / 89 miner actions; fleet-wide zero `item_not_available`, zero `mission_not_found`, zero `insufficient_credits`.

**BACKLOG:** see `docs/backlog.md`, regenerated this pass.

**Next:** confirm `8a5140f` deploys and stays clean; watch whether the #1053 charter fix changes filed-issue quality (a quoted error sentence, not a bare class). Fleet-flight F4 (3 pilots/24h/zero strands, steer confirmed) still open.

## Recent history, 2026-09-19

Moved out of `## NOW` on 2026-09-19 (second pass) to fit the 500-word cap; superseded only where the block above says so. Extracted from the prior `## NOW` block, verbatim except in the deploy-state paragraph, where the pointer to the `a892877` note flips from "below" to "above" now that the note sits higher up the file.

**TODAY, FIVE PRs MERGED, FLEET-FLIGHT GATE F3 CLOSED.** #114 (`746c4aa`) escalates a frozen Layer-4 no-progress arm to a held stop instead of a longer periodic retry, closing #534. #112 (`09972b7`) surfaces `item_not_available` memory to the planner before it repeats a doomed buy, closing #669. #115 (`45f8da1`) adds a value-aware buy price-sanity guard and teaches mine objectives not to buy, closing #458. #116 (`532acfc`) recognizes a proven-fuel destination as a fuel remedy, closing #672. #113 (`4eb1c64`) pins a standing operator instruction against `instruction_done`, closing #817; needed two fix rounds. #114, #115, and #116 each needed one; #112 advanced on the council's first pass with zero. Re-triage separately closed #681 and #569 as already fixed by earlier merged work (an independent skeptic pass could not refute either); see each issue's own 2026-09-19 close comment. That finishes epic #591's F3 gate ("loops terminate": #534/#569/#571/#592 per the epic's 2026-07-28 comment), with all four issues now closed. F4 (3 pilots, 24h, zero strands, steer confirmed per pilot) is next. Filed: #1106 (P2, #817 follow-ups: no caller sends `standing` yet, the digest still contradicts the guard, improv-spec drift) and #1107 (P3 umbrella, council findings below the must-fix floor).

**#107 AND #108 NOW CONFLICT WITH MAIN.** Both sat REVISE with a specified fix at the 09-11 close. #107/#553 needs two: B1, a guard clause plus a test for a missions array whose entries carry no `mission_id`; B2, reword the refusal text claiming distress missions "expire in minutes" (`missions.md:70` puts it at three hours). #108/#1030 needs only an attribution correction. GitHub now reports both `CONFLICTING`; rebase before landing, the specified fixes are unchanged.

**DEPLOY STATE PARTIALLY KNOWN.** Last confirmed: prod on `a892877` (09-11 18:33Z), which is PR #102's own merge commit, so batch two's #99 and #102 are confirmed in that image. #103, #105, and #109 merged later the same day (20:14Z-21:00Z), after that deploy, and are not known deployed; nor is any of today's five PRs. Nobody checked or redeployed today; every behavior claim above beyond #99/#102 is offline-tested only.

**PROCESS NOTE.** A fix-round agent pasted a verification command containing identifying tokens into a public comment on #116; caught by a post-wave scan of PR bodies/comments, reposted scrubbed, original deleted. See L-56 in `docs/wiki/engineering-lessons.md`.

**BACKLOG:** see `docs/backlog.md`, regenerated this pass.

**Next:** operator sign-off, then redeploy prod past `a892877`; rebase and land #107 and #108; then #1106 and #1053 (the `failures.ts` message-discarding producer, `CODE_PREFIX_RE` at :62 and the class taken at :76, still the top structural item; #1053's own body cites :65, a doc comment, and needs a correction).

Second pass, same date, moved out of `## NOW` on 2026-09-19 (third pass) to fit the 500-word cap; extracted verbatim from the prior `## NOW` block.

**#107 AND #108 MERGED, BOTH CONFLICTS RESOLVED.** #107 (`c81f8dc`) closes #553: `complete_mission` now refuses an id the fresh active-mission listing provably lacks. It needed a second review round — the council's first REVISE caught a regression where the id-less-row guard skipped the #291 shortfall invariant for a different, cleanly-parsed row; fixed before merge. #108 (`ece3650`) closes #1030: an order now gets refused when the pilot's KNOWN credit balance can't cover it, with the earlier receipt misattribution corrected. Both issues closed.

**DEPLOY STATE NOW CONFIRMED, CORRECTING THE PRIOR NOTE.** PM live capture 2026-09-19 via `docker inspect` on the prod host: the container ran `ghcr.io/cringely/spacemolt-harness:4eb1c64` from 18:20:28Z (auto-deploy cron, healthy, `RestartCount 0`, zero uncaught/fatal/panic/ZodError/crash log lines since start, all three pilots emitting `status_snapshot`), then `:ece3650` from 19:49:27Z (healthy, `RestartCount 0`, zero crash-class log lines, all three pilots emitting `status_snapshot` by 19:50:48Z). The "prod on `a892877`" note above was never re-checked after 09-11; the auto-deploy cron shipped both images above within minutes of their merges. `ece3650` is #108's merge commit and main's HEAD, so every merged change through #108 is deployed. Offline tests remain the only proof of behavior; the live signals below are what to watch next.

**OPEN PRs: NONE FROM THIS WAVE.**

**BACKLOG:** see `docs/backlog.md`, regenerated this pass.

**Next:** #1106 (standing-flag adoption, digest/improv drift) and #1053 (the `failures.ts` message-discarding producer) are queued; #1107 is the P3 findings umbrella. Watch the live signals: frozen-pilot planner calls (#534), guard-refused dry-station buys and `plan_budget_exceeded` (#669), overpriced-buy refusals (#458), low-fuel reflex fire-and-fail (#672), `mission_not_found` refusals (#553), 0cr listing-fee refusals (#1030) — each is a guard now live, none yet confirmed quiet in production.

## Recent history, 2026-09-11

Moved out of `## NOW` on 2026-09-19 to fit the 500-word cap; last verified 2026-09-11, superseded only where the block above says so. The 09-19 refresh had dropped this section's own predecessor rather than moving it; restored below from `origin/main`'s pre-09-19 `docs/STATE.md`, verbatim.

**FIVE P1 PILOT DEFECTS FIXED AND DEPLOYED.** PR #98 (`fb67644`) closed #815, #705, #813, #812, #670. An operator instruction now bypasses planner backoff; `self_destruct` needs an explicit config opt-in; steps after a `travel_to` stop being validated against the system the pilot has left; goal purchase matching resolves exact-vs-family per item; the wake check shares the reflex's fuel helper instead of a second percent-of-tank rule. Each guard ablated red before merge. Deployed, not merely merged: the prod container runs image `fb67644` as of 16:43Z, `RestartCount 0`.

**THE CONSUMER GATE WORKS IN BOTH DIRECTIONS.** PR #94 gates filing on whether any `machine-filed` issue closed in the trailing 7 days. The host filing log now carries live proof of both states: `"outcome":"suppressed","consumer":"absent"` with one standing notice (#1031) while nobody was reading, then `"consumer":"present"` and filing resumed (#1042-#1044) once 50 issues closed. The queue reopens itself once someone starts reading it.

**A HEADLINE FIGURE HERE WAS WRONG.** This block reported the scout's `sirius_observatory_station` hallucination as 1,250 occurrences. Measured: 30 since 08-04 (#1033). The 1,250 came from a substring match that also counted the known-ids list. It reached a merged STATE.md, which is the part worth remembering.

**BACKLOG: 457 open, 345 `machine-filed`** (was 374). 50 closed since 09-06. Seven stale steward PRs closed unmerged (#88, #89, #91, #96 here; #462, #463, #467 in the issues repo), all conflicting and all carrying figures now false. Remote branches are down to `main` plus the open PR.

**OPEN FROM TODAY.** #1045 (`keep_fuel_above_jumps` bypasses the undocked reserve raise), #1046, #1047 (goal-item truncation), #1048 (standup reads GitHub's `mergeable:UNKNOWN` as merge-ready, a fail-open), #1043 (D1 dispatch gate off 54 days, pipeline idle).

**BATCH TWO: FIVE PRs MERGED; ONLY #99 AND #102 CONFIRMED DEPLOYED (09-11 18:33Z, `a892877`).** PR #99 wired two harness gates git had never executed (`core.hooksPath` pointed at `.githooks`, the core harness installs into `.claude/hooks/`; upstream cause `agent-harness-core#136`). PR #102 (`a892877`, merged 18:29Z) built one module-fitment table, closing #757 and #736; its own merge commit is the last confirmed prod deploy. PR #103 (`842e0ef`, merged 20:14Z) stopped the mission-priority digest line asserting commitment and value it could not establish, closing #592. PR #105 (`af7a8e1`, merged 20:14Z) refuses a withdraw the personal locker cannot satisfy, closing #706. PR #109 (`c5aaf12`, merged 21:00Z) gave the operator steer channel a received/consumed receipt, closing #696. #103, #105, and #109 merged after `a892877` and are not known to be running in prod.

**PREMISE WORK WAS THE SESSION'S REAL YIELD.** Four issues had their stated cause overturned by the agent fixing them: #592's "cap of 5" does not exist, #706's "mining_laser_iii" is 1 of 30 withdraws, #553 is 209 refusals not 28 with the re-fetch already happening and discarded, and #1030's asked-for remedy was already failing. The common producer is `failures.ts`'s `CODE_PREFIX_RE` (:62), which keeps an error's leading code as the class (:76) and discards the message naming the cause. Filed as #1053 (whose own body cites :65, a doc comment, not the code).

**A RECURRING DEFECT CLASS, six instances by 09-11.** A guard that cannot distinguish absent from empty from zero. #105 merged a per-row `.catch(null)` that would have refused every withdraw forever; #108 found both `StatusSnapshot` parsers collapsing a missing balance into 0; #107 carried the open one. All caught in review, none by a gate.

## Recent history, 2026-08-11

Moved out of `## NOW` on 2026-09-06 to fit the 500-word handoff cap. Last verified state as of 2026-08-11; superseded only where the block above says so.

**MERGE FREEZE BROKEN (2026-08-11, afternoon).** PR #83 (state refresh fix, 531→337 words) merged as `423e629` after 8 days red, followed by #86 (backlog reconciliation after PRs #79/#80/#82), #84 (docker/login-action bump), #85 (tier-3 dedup + read-only groom report, closing #635). The freeze was mechanical: one failing assertion while every other gate (verify, gitleaks, CodeQL) stayed green. Ceremonies that filed the same red error nine times (#807, #804, #802, #796, #782, #779, #778, #772, #768) made the pattern visible: a filing producer that makes no dedup check, plus a backlog grooming ceremony that runs nowhere.

**FLEET INSOLVENT, NOT UNBLOCKED (2026-08-11, hours after the merge above).** The "FLEET UNBLOCKED" claim measured one moment right after the merge; a later live check reversed it. All three: miner running, 6cr, fuel 70; scout done, 1cr, fuel 106; corsair done, 4cr, fuel 75; cargo empty across the fleet, every plan dying on `no_fuel_source`. Not idle: 19-24 actions and 12-14 plans per pilot in the last 60 minutes, `plan_budget_exceeded` firing 4-8 times each. Three solvency steers all returned 204 and reached `goals` within the hour; none changed behavior. Corsair kept `travel`-ing 15 more times after being told to stop, scout called `survey_system` 5 more times after being told to stop, refused `no_scanner` every time. Prose-steering obedience runs around 1 in 5. Miner's credits: 199,696 (2026-08-02, #703) to 34,625 (~08-09, #788) to 6 now; roughly 21,800 sits locked in unfillable buy orders (#681), `cancel_order` blocked 3 times in the last hour. The fleet's documented rescue path, #703's credit gift, was blocked by #788 (id vs. username); PR #92 (`e4f0180`) repaired it for plan-then-execute, improv driver unfixed (#825). No live gift captured.

**OUTSTANDING FINDINGS FILED 2026-08-11, anchor: #812-#821.** (1) #812: goal-items exact-match starves family-match, scout never sees a scanner price. (2) #813: normalize-plan validates a travel POI against pre-`travel_to` surroundings, discarding valid cross-system plans. (3) #814: `plannerHealth` is never written to the event store, so no ceremony report surfaces planner degradation. (4) #815: `/instruct` returns 204 during planner backoff, steer never acted on. (5) #816: gap analysis against agent-harness-core. (6) #820: neither stall detector can see a pilot losing ground, the latch compares fuel/credits by equality and the progress scalar is gains-only. (7) #821: `mergeStandingGoals` evicts one standing goal to restore another, alternating milestones every replan. Issues #807 and #818 closed; #535 received diagnosis unifying #542, #817, #696 as one missing concept (instruct-lifecycle boundaries). **Next:** the four pilot-blocking findings (#812, #813, #814, #815), then dedupe ceremony + pre-file check in `file-finding.ts`. Then #534/#569/#592 (fleet-flight F3).

**BACKLOG: 280 open, P0 zero, P1 17, machine-filed 172.** Duplication is the problem, not volume. Nine issues for the one red CI, four (#808, #790, #767, #773) independently inferred the same wrong root cause. Root cause: `scripts/file-finding.ts` files without dedup check. Fix: producer check + a steward ceremony to groom the pile.

## Recent history, 2026-08-02 fleet-launch wave

Moved out of `## NOW` on 2026-08-11 to fit the 500-word handoff cap. Still the last verified state of each item; superseded only where the block above says so.

**#669 FIX DEPLOYED, NOT YET PROVEN IN PRODUCTION.** PR #73 merged as `5b067fd` (pilot re-buys at stations proven empty, burning plan budget), auto-deployed to container `spacemolt-harness` on image `5b067fd`, health green. The overnight "empty panel" report was normal end-of-window behavior, not an incident, but weak production evidence: a 12-minute window post-deploy with pilot not at a livelock station. Same audit left open #696 (steer channel silent on instruction receipt), #697 (unused Escort purchase, abandoned mission), #698 (thrash-gate floor reset, unproven).

**FLEET FLIGHT (#591). F2 CLOSED — 1 PILOT BECOMES 3.** Scout (`nebula`) and corsair (`crimson`) launched 2026-08-02 18:26Z alongside miner, closing #593 (image `dcb5c92`, container healthy, `RestartCount 0`, no auth/planner errors); both executed real actions within 6 minutes. The real blocker was two host secrets never provisioned, not the persona-briefing gap #593 had carried for weeks — #159 (persona briefings) stays open, parked. Honest limits: personas cover 2 of #159's 4 elements (no playstyle briefing content, no per-persona progress readout); corsair starts at 0cr, can't buy fuel if it runs low; cost triples by design (3x ChatGPT-quota draw, Anthropic unaffected). F3: #571 landed, #534/#569/#592 remain. F4 exit (3 pilots/24h/zero strands) not yet reached.

**STRAND GUARDS LIVE, EVIDENCE TAGGED.** PR #68 blocks `mine` at the reserve floor; PR #72 (`9719daa`) tagged that block `fuelReserveBlock`, so `isStranded()` credits it alongside the movement+regex path. Each new guard must self-tag at its call site. Unconfirmed: whether `isStranded()` sees no in-flight plan, undocked (reflex gated on `docked`, reflex.ts:103), or fuel-capped.

**LIVELOCK (1, 2, 3 FIXED; 4 PARTIAL).** (1) Executor starvation #543, PR #47. (2) Planner buys what station doesn't stock, #669, **PR #73 merged `5b067fd`**. (3) Fuel urgency measured as percent not range, #670, PR #54, inert until configured per-agent. (4) Reflex terminal give-up #672, PR #50; deferred.

**LIVE PILOT SNAPSHOT (captured 2026-08-02 17:41-17:47Z).** 203,572 credits, fuel 85/140, hull 120/120, cargo 0/40, undocked at `cargo_lanes_gas_cloud`. 606 missions completed (603 in that morning's audit), 546,266cr lifetime earned. Planner model: `gpt-5.6-terra`. `plan_budget_exceeded` fired at 17:47:41Z (maxPlans 12/60min), the ceiling working as designed. Zero `item_not_available` in 12 minutes post-deploy: weak evidence only (short window, pilot not at the livelock station). **#669 is not yet proven fixed in production.**

**ACTIVE MISSIONS OVER CAP (as of 2026-08-02).** 7 active missions against a cap of 5. Six are `distress_response` at 0% progress with `visit_system` objectives (4 Nekkar, 1 Factory Belt, 1 Zibal), each expiring in ~1,000 ticks. The seventh, "Exotic Crystal Synthesis" (8,000cr reward), had sat at 0% for 21.9 hours. Cause is settled: the game auto-assigns these, no accept path (`agent.ts:905-916` logs, doesn't branch), filed as **#700**: the stale-mission advisory's 24h threshold can't fire before these expire.

**MERGED, 30 PRs 2026-08-01–08-02.** Behavior-changing ones: M-53, M-54 in `docs/milestones.md`. Backlog stood at 169 open, regenerated from the GitHub Issues SSOT (165 on 2026-08-02 am, up 4 by filing new findings: #701, #702, #703, #704, #705).

## Standing operational facts

Not part of the live-status refresh above; persists across waves until it changes. Not word-capped (`test/doc-size.test.ts` only gates the `## NOW` block).

- **Scheduler.** #114 has stayed recovered since 2026-07-21; the dispatch gate is still OFF by design (human-gated). Strategy job works over the TLS store proxy. Healthy on the scheduler host (runs under a dedicated service account, cron every 10m).
- **Production config (moved out of `## NOW` 2026-08-11, unchanged since 2026-08-02).** `max_plans_per_window: 12` in `agents.yaml`, against a schema default of 36. `keep_fuel_above_jumps: 8`, an estimate rather than a measurement (see the deploy-order warning below).
- **Merge cluster 2026-07-22/23** (superseded as live status, kept as the record): #12 `SM_STORE_URL` through the strategy job; #13 tick bootstrap moved host-side; #14 finding-filer scoped to the private issues repo; #15 chained-gh-merge gate round 3; #16 per-job gh grants, bypass wildcard dropped. Milestone Artifact current through M-53.
- **Model policy.** Fable = prose seats, Opus everything else, cheap tiers for bulk.
- **Spend ledger.** `spend-ledger.jsonl` in the primary clone, gitignored, auto-synced by a local Windows Scheduled Task (daily 4am + logon).
- **Scheduler SSH is slow.** ~30-40s to connect to the scheduler LXC; cause still unknown, `UseDNS` already off.
- **Codex review seat (#460).** `bun scripts/codex-review.ts <PR>`, advisory, run beside the Claude reviewer.
- **#458 buy-guard detail.** `mine_resource` counts MINED only; a prior titanium buy wasted roughly 120k credits, and the guard is not yet merged.
- **READ THIS BEFORE TOUCHING agents.yaml. DEPLOY ORDER: IMAGE FIRST, CONFIG SECOND. DO NOT INVERT.** The reflex config block is `.strict()` (`config.ts:174`) and `keep_fuel_above_jumps` (`config.ts:172`) has no `.default()`. Add the key to `agents.yaml` only AFTER the image deploys, never before, or the pilot crashes at config load. Production carries `keep_fuel_above_jumps: 8` (backup `agents.yaml.bak.20260801-140456`); that 8 is an unvalidated guess from observed 5-jump legs, not a measurement, and stays under observation.
- **Reverse hazard, confirmed live 2026-08-02 (M-54).** An agent entry added to `agents.yaml` without its `<id>_password` provisioned and mounted crash-loops the whole container (`compose.yaml:100-110`, on the production host, not in-repo), taking down every already-healthy pilot with it — secrets go in first, the agent block second, every time.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
