# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-09-19, doc-steward pass reconciling PRs #107/#108 and confirming prod deploy state live. Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-09-19 (second pass, deploy confirmation). Boot from this block + `docs/backlog.md` + `docs/game-reference/commands.md`._

**#107 AND #108 MERGED, BOTH CONFLICTS RESOLVED.** #107 (`c81f8dc`) closes #553: `complete_mission` now refuses an id the fresh active-mission listing provably lacks. It needed a second review round — the council's first REVISE caught a regression where the id-less-row guard skipped the #291 shortfall invariant for a different, cleanly-parsed row; fixed before merge. #108 (`ece3650`) closes #1030: an order now gets refused when the pilot's KNOWN credit balance can't cover it, with the earlier receipt misattribution corrected. Both issues closed.

**DEPLOY STATE NOW CONFIRMED, CORRECTING THE PRIOR NOTE.** PM live capture 2026-09-19 via `docker inspect` on the prod host: the container ran `ghcr.io/cringely/spacemolt-harness:4eb1c64` from 18:20:28Z (auto-deploy cron, healthy, `RestartCount 0`, zero uncaught/fatal/panic/ZodError/crash log lines since start, all three pilots emitting `status_snapshot`), then `:ece3650` from 19:49:27Z (healthy, `RestartCount 0`, zero crash-class log lines, all three pilots emitting `status_snapshot` by 19:50:48Z). The "prod on `a892877`" note in the 2026-09-19 history section below was never re-checked after 09-11; the auto-deploy cron shipped both images above within minutes of their merges. `ece3650` is #108's merge commit and main's HEAD, so every merged change through #108 is deployed. Offline tests remain the only proof of behavior; the live signals below are what to watch next.

**OPEN PRs: NONE FROM THIS WAVE.**

**BACKLOG:** see `docs/backlog.md`, regenerated this pass.

**Next:** #1106 (standing-flag adoption, digest/improv drift) and #1053 (the `failures.ts` message-discarding producer) are queued; #1107 is the P3 findings umbrella. Watch the live signals: frozen-pilot planner calls (#534), guard-refused dry-station buys and `plan_budget_exceeded` (#669), overpriced-buy refusals (#458), low-fuel reflex fire-and-fail (#672), `mission_not_found` refusals (#553), 0cr listing-fee refusals (#1030) — each is a guard now live, none yet confirmed quiet in production.

## Recent history, 2026-09-19

Moved out of `## NOW` on 2026-09-19 (second pass) to fit the 500-word cap; superseded only where the block above says so. Extracted verbatim from the prior `## NOW` block.

**TODAY, FIVE PRs MERGED, FLEET-FLIGHT GATE F3 CLOSED.** #114 (`746c4aa`) escalates a frozen Layer-4 no-progress arm to a held stop instead of a longer periodic retry, closing #534. #112 (`09972b7`) surfaces `item_not_available` memory to the planner before it repeats a doomed buy, closing #669. #115 (`45f8da1`) adds a value-aware buy price-sanity guard and teaches mine objectives not to buy, closing #458. #116 (`532acfc`) recognizes a proven-fuel destination as a fuel remedy, closing #672. #113 (`4eb1c64`) pins a standing operator instruction against `instruction_done`, closing #817; needed two fix rounds. #114, #115, and #116 each needed one; #112 advanced on the council's first pass with zero. Re-triage separately closed #681 and #569 as already fixed by earlier merged work (an independent skeptic pass could not refute either); see each issue's own 2026-09-19 close comment. That finishes epic #591's F3 gate ("loops terminate": #534/#569/#571/#592 per the epic's 2026-07-28 comment), with all four issues now closed. F4 (3 pilots, 24h, zero strands, steer confirmed per pilot) is next. Filed: #1106 (P2, #817 follow-ups: no caller sends `standing` yet, the digest still contradicts the guard, improv-spec drift) and #1107 (P3 umbrella, council findings below the must-fix floor).

**#107 AND #108 NOW CONFLICT WITH MAIN.** Both sat REVISE with a specified fix at the 09-11 close. #107/#553 needs two: B1, a guard clause plus a test for a missions array whose entries carry no `mission_id`; B2, reword the refusal text claiming distress missions "expire in minutes" (`missions.md:70` puts it at three hours). #108/#1030 needs only an attribution correction. GitHub now reports both `CONFLICTING`; rebase before landing, the specified fixes are unchanged.

**DEPLOY STATE PARTIALLY KNOWN.** Last confirmed: prod on `a892877` (09-11 18:33Z), which is PR #102's own merge commit, so batch two's #99 and #102 are confirmed in that image. #103, #105, and #109 merged later the same day (20:14Z-21:00Z), after that deploy, and are not known deployed; nor is any of today's five PRs. Nobody checked or redeployed today; every behavior claim above beyond #99/#102 is offline-tested only.

**PROCESS NOTE.** A fix-round agent pasted a verification command containing identifying tokens into a public comment on #116; caught by a post-wave scan of PR bodies/comments, reposted scrubbed, original deleted. See L-56 in `docs/wiki/engineering-lessons.md`.

**BACKLOG:** see `docs/backlog.md`, regenerated this pass.

**Next:** operator sign-off, then redeploy prod past `a892877`; rebase and land #107 and #108; then #1106 and #1053 (the `failures.ts` message-discarding producer, `CODE_PREFIX_RE` at :62 and the class taken at :76, still the top structural item; #1053's own body cites :65, a doc comment, and needs a correction).

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

- **Scheduler.** #114 has stayed recovered since 2026-07-21; the dispatch gate is still OFF by design (human-gated). Strategy job works over the TLS store proxy. Healthy on the LXC (user `smsched`, cron every 10m).
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
