# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-09-19, doc-steward pass after the P1 wave (PRs #112-#116). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-09-19. Boot from this block + `docs/backlog.md` + `docs/game-reference/commands.md`. This block last moved 2026-09-11 (PR #100); the batch-two cluster and today's wave both landed since without a refresh (batch two's own facts are preserved below under "Recent history, 2026-09-11", nothing dropped)._

**TODAY, FIVE PRs MERGED, FLEET-FLIGHT GATE F3 CLOSED.** #114 (`746c4aa`) escalates a frozen Layer-4 no-progress arm to a held stop instead of a longer periodic retry, closing #534. #112 (`09972b7`) surfaces `item_not_available` memory to the planner before it repeats a doomed buy, closing #669. #115 (`45f8da1`) adds a value-aware buy price-sanity guard and teaches mine objectives not to buy, closing #458. #116 (`532acfc`) recognizes a proven-fuel destination as a fuel remedy, closing #672. #113 (`4eb1c64`) pins a standing operator instruction against `instruction_done`, closing #817; needed two fix rounds, the other four needed one. Re-triage separately closed #681 and #569 as already fixed by earlier merged work (an independent skeptic pass could not refute either). That finishes epic #591's F3 gate ("loops terminate": #534/#569/#571/#592 per the epic's 2026-07-28 comment), with all four issues now closed. F4 (3 pilots, 24h, zero strands, steer confirmed per pilot) is next. Filed: #1106 (P2, #817 follow-ups: no caller sends `standing` yet, the digest still contradicts the guard, improv-spec drift) and #1107 (P3 umbrella, council findings below the must-fix floor).

**#107 AND #108 NOW CONFLICT WITH MAIN.** Both sat REVISE with a specified fix at the 09-11 close (#107/#553 needs one guard clause plus a test; #108/#1030 needs only an attribution correction). GitHub now reports both `CONFLICTING`; rebase before landing, the specified fixes are unchanged.

**DEPLOY STATE UNKNOWN.** Last confirmed: prod on `a892877` (09-11 18:33Z). Nobody checked or redeployed today. Neither batch two (#99/#102/#103/#105/#109) nor any of today's five PRs are known deployed; every behavior claim above is offline-tested only.

**PROCESS NOTE.** A fix-round agent pasted a verification command containing identifying tokens into a public comment on #116; caught by a post-wave scan of PR bodies/comments, reposted scrubbed, original deleted. See L-56 in `docs/wiki/engineering-lessons.md`.

**BACKLOG:** see `docs/backlog.md`, regenerated this pass.

**Next:** operator sign-off, then redeploy prod past `a892877`; rebase and land #107 and #108; then #1106 and #1053 (the `failures.ts:65` message-discarding producer, still the top structural item).

## Recent history, 2026-09-11

Moved out of `## NOW` on 2026-09-19 to fit the 500-word cap; last verified 2026-09-11, superseded only where the block above says so.

**BATCH TWO: FIVE PRs MERGED, DEPLOYED AS OF 09-11 18:33Z (`a892877`).** PR #99 wired two harness gates git had never executed (`core.hooksPath` pointed at `.githooks`, the core harness installs into `.claude/hooks/`; upstream cause `agent-harness-core#136`). PR #102 (`a892877`) built one module-fitment table, closing #757 and #736. PR #103 (`842e0ef`) stopped the mission-priority digest line asserting commitment and value it could not establish, closing #592. PR #105 (`af7a8e1`) refuses a withdraw the personal locker cannot satisfy, closing #706. PR #109 (`c5aaf12`) gave the operator steer channel a received/consumed receipt, closing #696.

**PREMISE WORK WAS THE SESSION'S REAL YIELD.** Four issues had their stated cause overturned by the agent fixing them: #592's "cap of 5" does not exist, #706's "mining_laser_iii" is 1 of 30 withdraws, #553 is 209 refusals not 28 with the re-fetch already happening and discarded, and #1030's asked-for remedy was already failing. The common producer is `failures.ts:65`, which keeps an error's leading code as the class and discards the message naming the cause. Filed as #1053.

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
