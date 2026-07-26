# Local Planner A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, on measured evidence, whether `google/gemma-4-12b-qat` on LM Studio can replace the Claude subscription as the pilot's planner, and close the one code gap that only bites once a local endpoint is in the path.

**Architecture:** Three gated stages. Stage 0 measures the incumbent planner on recorded decision points, producing the bar. Stage 1 runs the identical cases through the local model and compares against pre-committed margins. Stage 2 swaps the live pilot's planner behind the existing deterministic `experiment:` revert. Task 1 (the code change) is independent of the stages and lands first, because a local endpoint that sleeps must degrade to the fallback instead of stalling the pilot.

**Tech Stack:** Bun ≥ 1.2.21, TypeScript, Zod, `bun:sqlite`, existing `src/eval/*` harness, existing `src/planner/openai-compat.ts`.

**Source spec:** `docs/superpowers/specs/2026-07-25-local-planner-ab-design.md` (approved 2026-07-25). Issue: #240.

**Revision 5 (2026-07-25).** Revision 4 went to a gate review that rebuilt the implementation and reproduced almost every receipt exactly. The mechanism and both contested design decisions survived. The gate blocked on one falsified number and some stale line anchors — editorial work, not structural. Everything below has been re-measured on `ac7705b` (main, after PR #22 merged) for this revision. What changed:

1. **The post-recovery waste receipt was wrong in four places, and is now a distribution rather than a single number.** Revision 4 said waste is "exactly N-1 in every row". Measured across every phase of the countdown at N=2,3,4,5, it is UNIFORM over 0..N-1 with mean (N-1)/2 — N-1 is the WORST case, not the typical one. Corrected in the N table, in both prose statements, in the Step 4 code comment, and in the Step 14 decision-log instruction. **The verdict of 3 is unaffected**, because what decides it is the probe count (9 per 24 replans against N=2's 13), which reproduces exactly. See "Why 3, and why it is a dial".
2. **The counting block's placement is no longer untestable, and a test now covers it.** Revision 4 wrote "There is no test and there will not be one", reasoning that a latching class can never fail twice. That reasoning is false: the threshold needs two primary failures of any COUNTED class, not two of the same class, so one transient failure followed by one `SubscriptionLimitError` reaches it. The eleventh agent test below pins it, and ablation 11 reddens it by hoisting the block above the latches.
3. **The extra field's size receipt is re-measured and re-framed.** The absolute 28-versus-31 figures do not reproduce; code-only counts are 24 and 27. The 3-line delta was always exact. The receipt no longer rests on comparing a fix against not-fixing, which is a category error, but on the four arguments that actually carry it.
4. **Twelve `agent.ts` anchors and one in `store.ts` moved**, because PR #22 inserted a station-backfill block into the `Agent` constructor. The anchors are navigational only; every edit keys on a unique string.
5. **The planner test's code block did not compile.** Its template literal carried escaped backticks and an escaped `${`, so an implementer following "paste verbatim" got a syntax error. Four reviews missed it because each reviewer rebuilt the test rather than pasting it. Fixed, and every code block in this revision was verified by extracting it from this file and running it, not by retyping it.

Carried from revision 4 and re-verified here from scratch, not copied: the per-planner failure counter and everything under "Why a per-primary failure counter"; the replan-counted retry window; the request timeout on `openai-compat.ts`; and the deletion of the spec's fourth test as unfalsifiable. Revision 4's own summary of what it changed against revision 3:

1. **The endpoint-down state is armed by a per-planner failure counter now, not by the shared transient counter.** Revision 3 armed only inside the `TransientPlannerError` branch, so a primary that answers HTTP 200 on every replan and returns plans that fail validation armed nothing at all. Measured over 30 heartbeat-spaced replans against revision 3's code: `primary.calls=25 fallback.calls=0`, zero `plan` events, 25 `planner_error` events, `plannerHealth.usingFallback=false` throughout. Revision 3's any-class re-arm could not rescue that shape, because the countdown never reached the 1 it keyed on. This is the likeliest Stage 2 failure (LM Studio up, `gemma-4-12b-qat` marginal), so it is fixed rather than documented. See "Why a per-primary failure counter".
2. **`ENDPOINT_RETRY_REPLANS` stays 3, on a different receipt.** Revision 3's "a larger N buys nothing and costs money" is false. Every paid fallback call IS a plan, one for one, so N trades spend against plan-rate along a straight line with no knee in it. See "Why 3, and why it is a dial".
3. **Three assertions in `test/experiment-revert.test.ts` are re-pointed.** That file's fixture planners throw a plain `Error`, which is precisely the shape change 1 now routes to the fallback, so `expect(fallback.calls).toBe(0)` stopped being a probe for "the experiment has not tripped". Each becomes TWO exact counts. The file is no longer untouched and the File Structure table says so.
4. **Falsified receipts replaced by measurements, never by deletion.** The changes they justified all stay. `usingFallback` does not report the endpoint-down window. `USAGE_FETCH_TIMEOUT_MS` sits 40x below its stall unit, so 60s against a 10-second agent tick does not mirror its shape. Worst case per `plan()` is 2x the timeout. The ablation table's first row and the suite total were both wrong.

Carried from revision 3 and re-verified here: `src/planner/openai-compat.ts` gains a request timeout (its fetch carried no `AbortSignal`, so probing a sleeping endpoint blocked the whole tick); the retry window is counted in **replans**, not milliseconds; and the spec's fourth test is deleted as unfalsifiable, NOT because the invariant it names is absent.

## Global Constraints

- Tests are offline: fake server, mocked planner, zero live-game traffic, zero LLM tokens. `bun test && bun run typecheck` must pass before any commit claiming a task done.
- Main is protected. Every change lands via a PR from a branch; merge with `gh pr merge --delete-branch` after review. Never chain a state-changing `gh` command with a dependent follow-up in one shell call.
- Commits carry the user's identity only. No AI co-author trailer, no "Generated with" footer, in commits or PR bodies.
- The repo is PUBLIC. No LAN addresses, host names, or user-home paths in any committed file. Use role words and placeholders; concrete values go in `secrets/` or stay out of git. The nearest prior leak-and-scrub in THIS repo is `d2d5e05`, which removed LAN addresses and a user path from the #240 spec — read its diff for the shapes to avoid. (Revision 4 also cited `d0c09eb` and `3ed92e8`; both are commits in the PRIVATE backlog repo and do not exist here, so neither is checkable from this clone. Removed rather than carried.) Issue #524 tracks the gate.
- A test counts only after you delete the guard it protects and watch it go red — and `bun test` does NOT typecheck, so an ablation naming a field that does not exist silently no-ops and reports GREEN. Typecheck every ablated tree before believing any red or green. `toEqual` ignores `undefined` array entries; prefer `toStrictEqual` on arrays whose failure mode is a dropped element.
- `ENDPOINT_DOWN_THRESHOLD = 2` is the spec's pre-committed value. `ENDPOINT_RETRY_REPLANS = 3` replaces the spec's `ENDPOINT_RETRY_MS = 10 * 60_000`, for the reasons given in Task 1, and every tick count in Task 1's tests depends on it being 3. Do not tune either to make a test pass. Changing 3 later is a legitimate policy move (see "Why 3, and why it is a dial") and it re-derives the test counts; changing it mid-implementation to turn a red green is not.
- Stage 1 margins are pre-committed and must not be revised after seeing a local-model number: no signal-carrying scorer regresses more than 15 points; `scoreGoalDiversity` does not regress at all; no scorer passes on abstentions alone; zero unparseable responses.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/planner/openai-compat.ts` | The LM Studio seam | Modify: one exported constant, one option, an `AbortSignal` on the fetch, the body read moved inside the transient classification |
| `src/agent/agent.ts` | Agent loop, planner selection, failure classification | Modify: two private fields, two constants, `activePlanner()` branch, per-replan decrement, `handlePlannerFailure` signature + per-primary failure count and arming, primary-success recovery and counter reset |
| `test/planner-openai-compat.test.ts` | Planner wire behavior | Modify: one new test appended |
| `test/agent-failure-classes.test.ts` | Planner failure classification behaviors | Modify: eleven new tests appended |
| `test/experiment-revert.test.ts` | Deterministic A/B exit | Modify: three assertions re-pointed, each `expect(fallback.calls).toBe(0)` becoming two exact counts. Its fixture planners throw a plain `Error`, which this task now routes to the fallback, so "the fallback was never called" stopped meaning "the experiment has not tripped". See "Why an existing test file has to change" |
| `src/server/dashboard.html` | Event-feed colour mapping | Modify: two new event types classified |
| `docs/decisions.md` | Decision log | Append one entry in Task 1, one at the end of Stage 1 |
| `docs/superpowers/specs/2026-07-12-improv-mode.md` | Improv-mode briefing | Append one line in Task 1 |
| `docs/eval/2026-07-25-planner-baseline.md` | Stage 0 + Stage 1 result tables, committed as the reference point | Create |
| `agents.yaml` (gitignored, on the pilot host) | Live pilot config | Read at Stage 0 (for the incumbent's model id); modify at Stage 2 only |

Note what is NOT in this table. `PlannerHealth`, `snapshot()`, `test/agent-snapshot.test.ts` and `test/server.test.ts` were all on revision 2's list and are gone, for the reason under "Why the countdown stays off the snapshot".

---

## Task 1: Reversible endpoint fallback

**Files:**
- Modify: `src/planner/openai-compat.ts`. Anchors in the unmodified file: `OpenAiCompatOptions` at 14-23; the fetch call at 46-67; the body read at 80.
- Modify: `src/agent/agent.ts`. Anchors verified in the unmodified file at `ac7705b`: `TRANSIENT_BACKOFF_MAX_MS` at 135; `private plannerBackoffUntil = 0;` at 375; `activePlanner()` at 1635; `const planner = this.activePlanner()` at 1690 with its `if (!planner)` guard ending 1694; the success-path reset block at 1946-1951 (`planner_recovered` emits at 1947, `consecutiveTransientFailures = 0` at 1949, `plannerBackoffUntil = 0` at 1950) and its `catch` calling `handlePlannerFailure(e)` at 1953; `handlePlannerFailure` at 2567, whose `TransientPlannerError` branch opens at 2585; the backoff gate at 1007.

**Line numbers here are navigational, not load-bearing.** PR #22 moved twelve of them by inserting a station-backfill block into the `Agent` constructor, and the next merge will move them again. Every edit below keys on a UNIQUE STRING, not a line number, so all four edit sites survive a shift. Verified on `ac7705b`: each of the seven strings the edits search for occurs exactly once in the file — `const TRANSIENT_BACKOFF_MAX_MS = 10 * 60_000;`, `private plannerBackoffUntil = 0;`, `if (this.usingFallback) return this.fallbackPlanner ?? this.planner;`, the `if (!planner) { ... }` guard block, `this.consecutiveTransientFailures = 0;` in the success path, `private handlePlannerFailure(e: unknown): void {`, and `if (e instanceof TransientPlannerError) {`. If a count is ever above one, stop and re-anchor rather than guessing which occurrence is meant.
- Modify: `test/agent-failure-classes.test.ts`, `test/planner-openai-compat.test.ts`, `test/experiment-revert.test.ts`, `src/server/dashboard.html`, `docs/decisions.md`, `docs/superpowers/specs/2026-07-12-improv-mode.md`.

**Interfaces:**
- Consumes: existing `TransientPlannerError` (`src/planner/errors`), existing private fields `consecutiveTransientFailures`, `plannerBackoffUntil`, `experimentReverted`, `claudeDisabled`, `usingFallback`, `fallbackPlanner`, `planner`.
- Produces: exported `OPENAI_COMPAT_TIMEOUT_MS` and an optional `timeoutMs` on `OpenAiCompatOptions`. Two private fields on `Agent`, `endpointDownReplans: number` and `consecutivePrimaryFailures: number`, exposed nowhere. `handlePlannerFailure` gains a second parameter `served?: Planner`. Two new event types emitted through the existing `this.emit(type, payload)` seam: `planner_endpoint_down` with `{ consecutiveFailures: number, retryReplans: number }`, and `planner_endpoint_recovered` with `{}`. No exported signature on `Agent` changes.

### Design notes the implementer must not re-derive

Read these before writing code. Each is a trap a straightforward implementation falls into, and each was confirmed by running the code rather than by reading it.

**Fix the producer: the request had no timeout.** `openai-compat.ts` issued its fetch with no `AbortSignal`, so a probe of an endpoint that is not listening waits out the OS TCP connect timeout and `runOnce()` executes no plan step for that whole tick. On Linux that is `tcp_syn_retries = 6`, which sums to about 127 seconds against a silent host — arithmetic from the documented kernel default, not something measured here, and worth re-checking on the deploy host rather than trusted. Worse than that case, and this one WAS measured: an endpoint that ACCEPTS the connection and never answers, a wedged model server, has no OS timeout at all and the request hangs forever. The spec's own probe of the production condition ("TCP 1234 from the container: TIMEOUT", spec line 29) is the first shape; the second is what the ablation of this fix produced, hanging the test runner rather than failing it, and the test below carries a watchdog for exactly that. Sizing `ENDPOINT_RETRY_REPLANS` up to avoid the stall would have been guarding the consumer: the constant would have been paying for a missing timeout on a call two files away.

**Why 60s, and what its receipt is NOT.** Revision 3 justified 60s by mirroring `USAGE_FETCH_TIMEOUT_MS` in `src/scheduler/usage-poll.ts` — "far above normal latency, far below the thing it must not stall". That mirror does not survive the arithmetic. `USAGE_FETCH_TIMEOUT_MS` is 15s (`usage-poll.ts:38`) against a 10-minute cron tick, 40x below its stall unit. The agent loop is `start(intervalMs = 10_000)` (`agent.ts:2752`), so 60s sits 6x ABOVE the unit it is supposed to protect, not below it. The honest receipt is smaller and still worth having: the tick previously carried an UNBOUNDED planner wait, and `start()`'s `if (running) return` guard means a long tick is skipped rather than queued. So 60s converts an unbounded wait into a bounded one. That is a strict improvement on every input, and it is the whole claim. It is not a claim that a 60s planner call is harmless to the tick — it is not, and the operator will see skipped ticks while it runs.

Sizing is still UNCONFIRMED against a real local generation: no plan has been timed on `gemma-4-12b-qat`. Task 3 Step 6 records wall-clock seconds per plan and Step 7 checks it against this constant, with the doubling below folded in.

**The worst case is 120s per `plan()`, not 60s.** `AbortSignal.timeout()` is constructed inside `invoke()`, and `planWithSingleRetry` (`src/planner/parse.ts:53-72`) calls `invoke` a second time when the first response fails validation, so the retry gets a FRESH budget. Measured against a server whose first response burns 500ms then returns an unusable plan and whose second hangs, at `timeoutMs: 600`: the retry path took 1124ms and 1123ms over two runs, 2 invokes each, against 605ms and 609ms for 1 invoke on the single-attempt path. These are wall-clock figures and move a few ms between runs; the fact that matters is the invoke COUNT, which is exactly 2 against 1. Not a defect to fix here — a shared per-attempt budget would need a signal threaded through `parse.ts`, which is a second change entangled with this one — but every sizing judgement downstream has to use 2x the constant. Task 3 Step 7 does.

**Why the body read moved inside the classification.** `await res.json()` sat outside the `try` that converts infrastructure failures to `TransientPlannerError`. The timeout signal aborts a body read as well as a connect, so leaving it outside would have created a new failure path: an abort mid-body escapes as a plain `Error`, lands in `handlePlannerFailure`'s catch-all, and never arms the endpoint-down state — reintroducing the stall the timeout exists to remove. Model QUALITY still fails through `tryParsePlan` on the response CONTENT, which this does not touch.

**Why a new field and not the existing counter.** The success path at `agent.ts:1949` resets `consecutiveTransientFailures = 0` after ANY successful plan, including one served by the fallback. If "endpoint is down" were derived from that counter, the first fallback success would clear it, the next replan would return to the dead primary, and the pilot would flap between planners every cycle. `endpointDownReplans` is therefore its own field, cleared only by a PRIMARY success. The reviewer built the smaller boolean design instead and measured it incorrect: under a dual outage it locked the primary out permanently. The counter stays.

**Why replans and not a wall clock.** The reviewed draft used `endpointDownUntil = now + 10 * 60_000`. That window is SHORTER than the configured replan cadence (`heartbeat_minutes: 15` in production), so it had already expired by the time the next replan arrived. Re-measured for this revision by rebuilding the millisecond design on a clean tree and running 20 heartbeat-spaced ticks against a dead primary: the fallback was called 0 times, `planner_endpoint_down` fired 16 times, and 0 plans were produced. Production survives only because its 10-second tick loop collapses the effective cadence, which is an accident, not a design. Counting in replans makes the behaviour independent of tick rate and of `heartbeat_minutes`, and it bounds the waste in the unit that costs money. **Rejected alternative:** raise `ENDPOINT_RETRY_MS` above the maximum inter-replan gap. Rejected because it re-couples a constant to a config value that can change without anyone re-deriving it — the same bug, one size larger.

**Why 3, and why it is a dial rather than an optimum.** Revision 3 said "a larger N buys nothing and costs money" and called 3 "the smallest value that still leaves a fallback-served window". Both are false. Measured over exactly 24 replans against a permanently dead primary, ticking until 24 planner invocations had committed so the numbers do not depend on tick rate:

| N | paid fallback calls | plans | primary probes | plan rate | paid per replan | post-recovery waste (range, mean) |
|---|---|---|---|---|---|---|
| 2 | 11 | 11 | 13 | 45.8% | 0.458 | 0-1, mean 0.5 |
| 3 | 15 | 15 | 9 | 62.5% | 0.625 | 0-2, mean 1.0 |
| 4 | 17 | 17 | 7 | 70.8% | 0.708 | 0-3, mean 1.5 |
| 5 | 18 | 18 | 6 | 75.0% | 0.750 | 0-4, mean 2.0 |

**Read the waste column as a distribution, not a number.** Revision 4's table said "exactly N-1 in every row" and that is wrong: N-1 is the worst case only. Waste depends on WHERE in the countdown the primary comes back. If it recovers while the countdown holds `k`, the fallback serves `k-1` more replans before the probe replan reaches the primary, so waste is exactly `k-1`. Measured by sweeping the recovery point across every phase of a full cycle at each N, several times per phase:

| N | countdown at recovery -> waste | distinct values | mean |
|---|---|---|---|
| 2 | 2->1, 1->0 | 0, 1 | 0.5 |
| 3 | 3->2, 2->1, 1->0 | 0, 1, 2 | 1.0 |
| 4 | 4->3, 3->2, 2->1, 1->0 | 0, 1, 2, 3 | 1.5 |
| 5 | 5->4, 4->3, 3->2, 2->1, 1->0 | 0, 1, 2, 3, 4 | 2.0 |

Waste is uniform over `0..N-1` with mean `(N-1)/2`. Nothing in the code biases which phase a recovery falls on, so the mean is the honest figure for a cost comparison and `N-1` is the ceiling.

Every paid fallback call IS a plan, one for one, in all four rows. So plan rate and cost are the same number, the trade is a straight line, and no N is optimal — the constant is a policy dial, and this plan is choosing where on the line to sit. N=2 also emits exactly one `planner_endpoint_recovered`, so it leaves a fallback-served window too.

Only two columns are non-linear, and they pull opposite ways. Probe count falls as N rises: 13 per 24 replans at N=2 against 9 at N=3, so N=2 spends 44% more attempts on an endpoint known to be unreachable, and each attempt can block the tick for up to 2 × `OPENAI_COMPAT_TIMEOUT_MS` = 120s (see the doubling above), 12x the 10-second tick interval. Post-recovery waste runs the other way, averaging (N-1)/2 and never exceeding N-1, and argues for a small N.

Verdict: 3, decided on the probe count. Plan rate and spend are the same number divided differently, so they decide nothing. That leaves 9 blocking probes against 13 on one side, and half a wasted paid call per outage on the other (mean 1.0 against 0.5, worst case 2 against 1). Nine probes against thirteen is the larger effect, and it is the one that stalls ticks. Revision 4 reached the same verdict but quoted the waste as "2 instead of 1", the worst case presented as typical, which overstates that side by 2x; correcting it widens the margin rather than narrowing it. If Stage 2 shows quota mattering more than plan rate, move it to 2 and record the new number — a config-shaped decision, not a redesign.

**Why the fallback serves while the counter is `> 1`, not `> 0`.** The counter has to reach a state where the primary is attempted again AND the code still knows it was down, because that is the only moment a primary success can emit `planner_endpoint_recovered`. If the fallback served whenever the counter was above zero, the counter would hit 0 on its own and the following primary success would see a cleared field — the recovery event could never fire. So `endpointDownReplans === 1` is the probe replan: still officially down, primary attempted.

**What 0 means, and what it does not.** 0 means the state is not armed. It does NOT mean "the primary is healthy" — revision 2's comment said that and it is falsifiable. A `TokenInvalidError` or `SubscriptionLimitError` latch flips `claudeDisabled` / `usingFallback`, `activePlanner()` returns the fallback from its own earlier branch, and the decrement drains the countdown to 0 with no probe and no recovery event. Nothing is broken by that (those latches are themselves the verdict on the primary), but a comment claiming the field is a health oracle would send the next reader looking for a bug that is not there. Write what is true.

**Why the post-recovery reset of `consecutivePrimaryFailures` is not free.** Without it the counter keeps its pre-recovery value, so the FIRST primary failure after a recovery re-arms the down state instead of the second, and the pilot pays for fallback replans on a single blip. The tenth test below pins that: a primary failing calls 1-2, succeeding on 3, failing once on 4 must produce exactly one `planner_endpoint_down` and no further fallback calls. Ablation 9 deletes the reset and reddens it.

**Why a per-primary failure counter.** This is the change revision 4 exists for, and the receipt is the shape revision 3 could not handle.

Revision 3 armed the down state only inside the `TransientPlannerError` branch, off `consecutiveTransientFailures`, and patched the gap with a re-arm keyed on the countdown already sitting at 1. That patch covers a primary whose failure CLASS changes mid-outage. It does nothing for a primary whose class was never transient in the first place. Measured against revision 3's code, 30 heartbeat-spaced replans, primary throwing only `Error("openai-compat: plan validation failed after retry")`:

```
primary.calls=25  fallback.calls=0
planner_endpoint_down=0  plan=0  planner_error=25
plannerHealth = {"stalled":false,"usingFallback":false,"claudeDisabled":false,"backoffUntil":27000029,"consecutiveTransientFailures":0,"stuck":true}
```

Zero plans. The fallback is configured, healthy, and never reached, because the countdown never left 0 and so never hit the 1 the re-arm keyed on. The pilot answers every endpoint check and plans nothing, bounded only by the 12-hour `experiment` latch — the same 12 hours Task 1 exists to stop depending on. A local model that is up but marginal is the single likeliest Stage 2 outcome, so this is the shape the change most needs to survive.

So the arming input moves to the producer. `consecutivePrimaryFailures` is a counter incremented at the one place every planner failure arrives, gated on `served === this.planner`, covering every class the primary can recover from, and reset by a primary success. `endpointDownReplans` is then armed off THAT counter, and revision 3's `endpointDownReplans === 1` special case is deleted. A failed probe re-enters the same arming block with the counter still above threshold, so re-arming falls out of the ordinary path instead of needing its own condition.

**Receipt for the extra field.** The question is whether `consecutivePrimaryFailures` is needed at all, or whether the existing `consecutiveTransientFailures` should have carried the arming. Four things answer it, and none of them is "a fix beats not fixing" — revision 4 argued it that way, comparing the new field against leaving the bug in place, which is a category error. Option (a) is not a smaller design; it is no design, and it leaves `stuck:true` with zero plans in the likeliest Stage 2 shape.

1. **The threshold was pre-committed.** `ENDPOINT_DOWN_THRESHOLD = 2` comes from the spec (design spec line 132) and is repeated in Global Constraints. The one genuinely smaller alternative — drop the threshold to 1 and arm on a single failure, deleting the need for any counter — is foreclosed by that pre-commitment, and re-opening it means re-opening the spec, not tuning a constant mid-implementation.
2. **No existing field counts primary failures.** Every candidate was checked. `consecutiveTransientFailures` is the only counter in the class, and it is shared across both planners.
3. **`consecutiveTransientFailures` is disqualified for two independently measured reasons**, either of which alone is fatal: it is reset by ANY success including the fallback's (so the pilot flaps back to a dead endpoint every cycle), and only the transient branch maintains it (so a primary answering 200 with unusable plans never moves it — measured at 25 replans, 0 plans, fallback configured and never reached).
4. **The cost is three lines.** Measured mechanically on `ac7705b`, comments excluded, by generating both shapes from this plan's own code blocks and diffing: revision 3's shape is **24 insertions / 2 deletions** in `agent.ts`, this one is **27 / 2**. Revision 4 quoted 28 and 31, which do not reproduce under any counting method; the 3-line delta it rested on was and remains exact.

Those three lines also DELETE two things revision 3 had to carry: the `endpointDownReplans === 1` special case, and the note admitting `ENDPOINT_DOWN_THRESHOLD` did not mean what its name says.

**Where the counting block goes, and what that placement does not buy.** After the `TokenInvalidError` and `SubscriptionLimitError` branches, both of which return early. Those two are latches: the first sets `claudeDisabled`, the second sets `usingFallback`, and `activePlanner()` serves the fallback from an earlier branch forever after. Counting them as endpoint failures would report a subscription-exhausted primary as an unreachable endpoint. Placement is the whole fix and it costs nothing.

Revision 4 declared this untestable: "no ablation can redden it... there is no test and there will not be one", reasoning that both latches make the primary unreachable after their FIRST occurrence, so a second failure of either class can never be counted. **That reasoning is false, and the eleventh test below closes the hole.** The threshold counts two primary failures of any COUNTED class — it does not require two of the same class. One transient failure takes the count to 1; one `SubscriptionLimitError` immediately after would take it to 2 if the block sat above the latches. Measured by building both placements:

- Block AFTER the latches, as specified here: **GREEN.** The latch returns before the counting block, the count stays at 1, no `planner_endpoint_down` is emitted, and `planner_subscription_limit` reports the real cause.
- Block HOISTED above the latches: **RED**, emitting `planner_endpoint_down` immediately before `planner_subscription_limit` in the event trace — a subscription-exhausted primary mislabelled as an unreachable endpoint, which is exactly the operator-facing confusion the placement exists to prevent.

The rest of the suite cannot see the difference: under the hoisted variant the plan's other ten agent tests, the planner test, and the three re-pointed `experiment-revert` tests all stay green (33 pass / 1 fail, the one failure being the new test). So the hole revision 4 described was real; it was the "cannot be closed" part that was wrong, and it closes in about twenty lines.

Reachability, stated precisely. `openai-compat.ts` classifies every failure as transient, so a Stage 2 local-primary configuration cannot produce a `SubscriptionLimitError` from the primary at all. This sequence IS reachable in the CURRENT production shape, where the primary is the Claude subscription and a fallback is configured. The test guards the code as it ships today, not only as Stage 2 will run it.

**`ENDPOINT_DOWN_THRESHOLD = 2` now means exactly two primary failures.** Under revision 3 it did not: `consecutiveTransientFailures` is shared across both planners, so a fallback outage could drive it up and let a single primary failure arm the state. `consecutivePrimaryFailures` is per-planner by construction, which removes that surprise rather than documenting it. Consequence for the dual-outage case: arming now needs two real primary failures, and the fallback's own failures neither arm the state nor re-announce it.

**Re-entry costs one failure.** The steady-state cycle against a dead primary is 3 replans: two served by the fallback, one failed probe that re-arms. Measured on a 16-tick trace, the countdown walking `3 -> 2 -> 1 -> 3` and repeating, with 15 paid calls per 24 replans. The pilot loses one planless replan per cycle.

**Where the decrement goes, and why.** In `replan()`, immediately after the `if (!planner)` guard at 1690-1694, gated on `planner === this.fallbackPlanner`. That is the only site in the loop that commits a replan to a planner, so the countdown advances exactly once per replan the fallback actually served. Ticks that never reach a replan — backoff suppression, a running plan executing a step, no wake — must not consume the window, and this placement is what makes that true. Verified by trace on the finished implementation: a 16-tick run against a dead primary and a three-step fallback plan produced 14 replans and 2 ticks that executed a step instead, and the countdown held across both of them (`3 -> 3` at tick 5, `1 -> 1` at tick 11) while walking `3 -> 2 -> 1 -> 3` on the replan ticks. Decrementing on the fallback's SUCCESS instead would strand the counter forever whenever the fallback is also failing.

**Why `handlePlannerFailure` needs to know which planner failed.** Without the `served` parameter, a failure of the FALLBACK increments the primary's counter, arms the down state, emits an event naming the primary endpoint, and locks out a primary that may be perfectly healthy. Passing the already-captured `planner` local from `replan()` and gating on `served === this.planner` fixes the mis-attribution at the producer; ablation 4 reddens four tests across two files. The `if (this.endpointDownReplans === 0)` emit gate is an exact "not currently down" test, and under the per-primary counter it is reachable on the ordinary dead-primary path as well as the dual outage, because a failed probe re-enters the arming block with the countdown at 1. Revision 2 shipped that gate with no test that could redden it; ablation 2 now reddens three.

**Why the countdown stays off the snapshot, and what the operator therefore cannot see.** Revision 2 added `endpointDownReplans` to the exported `PlannerHealth` interface and to `snapshot()`, which forced edits to `test/agent-snapshot.test.ts` and `test/server.test.ts`. One of those tests is named "exposes only fields with a dashboard consumer" and its whole job is to fail when a field is added without one (`test/agent-snapshot.test.ts:107-109` asserts the exact key set). The dashboard change in this task is an event-feed colour map, not a reader of the countdown, so the field stays private and those two test files stay untouched.

Revision 3 justified that with "`usingFallback` already tells the operator which planner is serving". It does not. `usingFallback` is assigned in exactly one place, the `SubscriptionLimitError` branch of `handlePlannerFailure`, and nothing in this task assigns it. Measured over 20 heartbeat-spaced ticks against a dead primary, with 10 replans served by the fallback: `plannerHealth.usingFallback` read `false` for the entire window, and `dashboard.html:684` and `:708` both showed the planner pill as ok throughout. Keeping the field private still has its own reason: no dashboard consumer, and a test that exists to enforce that. But the operator must know what the gap costs. During an endpoint-down window the health pills say nothing, and the only visible signal is the `planner_endpoint_down` event in the feed. Task 1 Step 10 gives that event a colour and Task 4 Step 6 tells the operator to watch the feed rather than the pills.

**Do not touch the backoff gate at line 1007.** It returns early before any planner call, so the fallback engages one backoff interval later than the threshold alone suggests: `TRANSIENT_BACKOFF_BASE_MS` is 30s and the delay is `30s × 2^(n-1)`, so 60s after failure #2. That is acceptable against a replan cadence measured in minutes, and the first fallback success sets `plannerBackoffUntil = 0` at line 1950, so it self-clears. The spec flagged this interaction for verification; this is the verification, and the answer is that no change is needed.

**The ordering test cannot fail, but the invariant is real.** The spec calls its fourth test "the one that protects a real invariant", and the invariant IS real: a reverted experiment stays on the fallback even after the primary answers again. What is not real is the test. It asserted branch ORDER inside `activePlanner()`, and both branches return `this.fallbackPlanner`, so swapping them changes nothing observable. Re-verified for revision 5 on the finished implementation at `ac7705b`: moving the new endpoint-down branch ABOVE the `experimentReverted` branch left the full suite green at 1476 total, 1475 pass / 1 skip / 0 fail. The invariant is structurally guaranteed (the new branch returns the fallback unconditionally, so it cannot reinstate the primary) and behaviourally covered by `test/experiment-revert.test.ts`. Deleting an unfalsifiable test does not delete the invariant it was pointed at. The branch is still placed after `experimentReverted` and `claudeDisabled`, for readability.

**Out of scope, do not fix.** `agent.ts:1946-1948` emits `planner_recovered` whenever a plan succeeds after any transient failure, including a plan served by the FALLBACK during an ongoing primary outage — visible in the trace as `planner_recovered` firing on the first fallback success. It is pre-existing, it is filed separately, and touching it here would entangle two fixes in one diff.

**Why an existing test file has to change.** `test/experiment-revert.test.ts` builds both its primary and its fallback from a `countingPlanner()` that throws a plain `Error("test planner declines")` on every call, and its header comment says why: a planner that never produces a plan makes every tick a `no_plan` wake and one `activePlanner()` call, so `fallback.calls` reads out WHICH planner is live. That is the pure catch-all shape. Once this task routes that shape to the fallback, three assertions of the form `expect(fallback.calls).toBe(0)` stop measuring "the experiment has not tripped" and start measuring "the endpoint-down state has not armed", which is a different and now-false claim.

Each is replaced by two exact counts rather than deleted, so the assertion count goes up. The tests' real invariant, `expect(reverts(store).length).toBe(0)`, is already asserted on the line above each one and is untouched. Measured values, on the finished implementation at `ac7705b`: `progress inside the window re-seeds the clock` primary 2 / fallback 1; `fail-safe: no stats block` primary 3 / fallback 2; `"any": one allowlisted counter advancing` primary 3 / fallback 2. These are not cosmetic — ablation 8 reddens all three, which is how the pure catch-all fix is caught in a second, independent file.

**Exactly three assertions move, not five.** `test/experiment-revert.test.ts` carries `expect(reverts(store).length).toBe(0)` at five places (on `ac7705b`: lines 74, 146, 192, 268, 312), but only three of them have a paired `expect(fallback.calls).toBe(0)` — at 147, 193 and 313. The other two, at 74 and 268, assert the revert count alone and gain nothing from a planner-call pin, so they are left alone. Do not "improve" them into the same shape; a test that pins a number nothing can break is padding.

- [ ] **Step 1: Write the failing tests**

Three files. Paste verbatim — every tick count and assertion below was run against the finished implementation, and the counts depend on `ENDPOINT_RETRY_REPLANS = 3`.

Append to `test/planner-openai-compat.test.ts`, inside the existing `describe("OpenAiCompatPlanner")`:

```ts
  // Breakage caught: dropping the abort signal. A fetch with no signal against
  // a sleeping workstation waits out the OS TCP connect timeout, so runOnce()
  // executes no plan step for that whole tick -- the stall #240 exists to
  // prevent.
  test("a hung endpoint aborts at timeoutMs and classifies as transient", async () => {
    // A real socket to a real server that accepts the connection and never
    // answers -- the sleeping-workstation shape, offline. Not an injected
    // fetch: only a real request proves AbortSignal.timeout actually fires on
    // this path (Bun's timeout signal does not fire when the sole pending work
    // is a promise waiting on it, so an injected-fetch version of this test
    // would hang whether or not the code is correct).
    const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const planner = new OpenAiCompatPlanner({
        model: "m", baseUrl: `http://localhost:${hung.port}`, timeoutMs: 50,
      });
      const pending = planner.plan(ctx);
      pending.catch(() => {}); // no unhandled rejection if the watchdog wins
      // An accepted-but-silent connection has NO OS timeout, so without the
      // signal nothing ever settles this request and the runner hangs instead
      // of reporting. The watchdog turns that into a clean red.
      const bark = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("no abort within 1s: the request carried no timeout signal")), 1_000);
      });
      await expect(Promise.race([pending, bark])).rejects.toBeInstanceOf(TransientPlannerError);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      hung.stop(true);
    }
  });
```

Append to `test/agent-failure-classes.test.ts`. The file already imports everything needed and defines `config`, `stubApi`, `okPlan`, `alwaysThrows` at the top; reuse them.

```ts
describe("Reversible endpoint fallback (#240)", () => {
  const MIN = 60_000;
  const HEARTBEAT = 15 * MIN + 1; // one guaranteed wake, matching config.heartbeatMinutes

  // Fails the first `failures` calls, then succeeds -- lets a test bring the
  // primary back up without swapping the object out mid-run.
  function flakyPlanner(failures: number, plan: Plan): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan() {
        p.calls++;
        if (p.calls <= failures) throw new TransientPlannerError("connect ECONNREFUSED");
        return { plan, promptChars: 0, responseChars: 0 };
      },
    };
    return p;
  }

  function countingPlanner(plan: Plan): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan() { p.calls++; return { plan, promptChars: 0, responseChars: 0 }; },
    };
    return p;
  }

  function throwingCounter(): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan(): Promise<never> { p.calls++; throw new TransientPlannerError("fallback blip"); },
    };
    return p;
  }

  // Answers every time, but its plans never validate -- the catch-all failure
  // class, and the marginal-local-model shape Stage 2 can produce.
  function invalidPlanCounter(): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan(): Promise<never> {
        p.calls++;
        throw new Error("openai-compat: plan validation failed after retry");
      },
    };
    return p;
  }

  test("two consecutive primary failures route the next replan to the fallback; one does not", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: fallback, config, now: () => now,
    });

    await agent.runOnce();               // primary failure #1
    expect(fallback.calls).toBe(0);      // one failure is a blip, not a down endpoint
    now += HEARTBEAT;
    await agent.runOnce();               // primary failure #2 -> arms the countdown
    expect(fallback.calls).toBe(0);      // arming happens after the call, not during it
    now += HEARTBEAT;
    await agent.runOnce();               // this replan is served by the fallback

    expect(fallback.calls).toBe(1);
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("planner_endpoint_down");
  });

  test("planner_endpoint_down is emitted once per transition, not once per failure or re-arm", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: countingPlanner(okPlan), config, now: () => now,
    });

    // Long enough to drain the countdown, fail a probe replan against the
    // still-dead primary, and re-arm -- five times over. A re-arm must not
    // re-announce.
    for (let i = 0; i < 16; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const downs = store.recentEvents("a1", 200).filter((e) => e.type === "planner_endpoint_down");
    expect(downs.length).toBe(1);
  });

  test("a dual outage announces the endpoint down once, and keeps probing", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const fallback = throwingCounter();
    const primary = throwingCounter();
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    // Both planners dead. consecutivePrimaryFailures counts only the primary,
    // so the fallback's failures neither arm nor re-announce; the probe replan
    // is the only thing that re-enters the arming block, and it must not
    // re-announce either.
    for (let i = 0; i < 16; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const downs = store.recentEvents("a1", 300).filter((e) => e.type === "planner_endpoint_down");
    expect(downs.length).toBe(1);
    expect(primary.calls).toBeGreaterThan(2); // still probing, not wedged on the fallback
    expect(fallback.calls).toBeGreaterThan(0); // still trying the fallback too
  });

  test("the probe replan reaches a recovered primary and emits planner_endpoint_recovered", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan); // dies twice, then healthy
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    // 5 heartbeat-spaced ticks at ENDPOINT_RETRY_REPLANS = 3: two primary
    // failures arm the countdown (ticks 0-1), the fallback serves two replans
    // (ticks 2-3), and tick 4 is the probe that reaches the recovered primary.
    for (let i = 0; i < 5; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const types = store.recentEvents("a1", 200).map((e) => e.type);
    expect(types).toContain("planner_endpoint_recovered");
    expect(primary.calls).toBe(3); // two failures plus the one successful probe

    const fallbackAtRecovery = fallback.calls;
    for (let i = 0; i < 4; i++) { await agent.runOnce(); now += HEARTBEAT; }
    expect(fallback.calls).toBe(fallbackAtRecovery); // never served again
    expect(store.recentEvents("a1", 200).filter((e) => e.type === "planner_endpoint_recovered").length).toBe(1);
  });

  test("a fallback success does not end the down state", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan); // healthy from call 3 on
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }
    expect(fallback.calls).toBe(1);      // the fallback has served once and succeeded
    const primaryAtHandover = primary.calls;

    // One more replan, still inside the countdown (D reaches 1 only on the
    // NEXT one). The primary is healthy again from call 3, so anything that let
    // a fallback success clear the state would hand this replan back to it.
    await agent.runOnce();
    now += HEARTBEAT;

    expect(primary.calls).toBe(primaryAtHandover);
    expect(fallback.calls).toBe(2);
    const types = store.recentEvents("a1", 200).map((e) => e.type);
    expect(types).not.toContain("planner_endpoint_recovered");
  });

  test("a fallback failure does not arm the down state against the primary", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan);
    const fallback = throwingCounter(); // the fallback has a blip of its own
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    for (let i = 0; i < 10; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const types = store.recentEvents("a1", 200).map((e) => e.type);
    // Fallback failures must not keep re-arming the countdown: the primary
    // still gets its probe replan and still recovers. Blaming the primary for
    // the fallback's blip would re-arm on every fallback call and lock it out.
    expect(primary.calls).toBeGreaterThan(2);
    expect(types).toContain("planner_endpoint_recovered");
  });

  test("with no fallback configured, transient failures behave exactly as before", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      config, now: () => now, // no fallbackPlanner
    });

    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(3);
    expect(types).toContain("stalled");
    expect(types).not.toContain("planner_endpoint_down");
  });

  test("a primary that only ever answers with unusable plans still reaches the fallback", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const answersButFails = invalidPlanCounter();
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: answersButFails, fallbackPlanner: fallback, config, now: () => now,
    });

    // The pure catch-all shape, armed by nothing else: HTTP 200 on every
    // replan, plans that never validate. consecutiveTransientFailures is never
    // touched, so a counter derived from it never arms and the pilot produces
    // ZERO plans while still answering endpoint checks. That is the likeliest
    // Stage 2 failure (LM Studio up, the model marginal), so it is asserted
    // here rather than admitted in prose.
    for (let i = 0; i < 20; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const evs = store.recentEvents("a1", 400);
    expect(evs.filter((e) => e.type === "planner_endpoint_down").length).toBe(1);
    expect(fallback.calls).toBeGreaterThan(0);                     // the fallback is reached
    expect(evs.filter((e) => e.type === "plan").length).toBeGreaterThan(0); // and plans land
    expect(answersButFails.calls).toBeGreaterThan(2);              // the primary is still probed
  });

  test("a primary that goes from unreachable to unusable keeps reaching the fallback", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const answersButFails = invalidPlanCounter();
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: fallback, config, now: () => now,
    });

    // Arm on a dead endpoint, then swap the primary for one that ANSWERS but
    // returns unusable plans: the failure class changes mid-outage. A counter
    // that only the transient branch maintains parks at 1 here.
    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }
    (agent as unknown as { planner: Planner }).planner = answersButFails;

    // Let the state settle well past the countdown, THEN measure. The harm is
    // not "the fallback is never served again" (it still drains the countdown
    // once); it is that the pilot stops producing plans at all from there on.
    for (let i = 0; i < 10; i++) { await agent.runOnce(); now += HEARTBEAT; }
    const settled = Math.max(0, ...store.recentEvents("a1", 400).map((e) => e.id));
    const fallbackAtSettle = fallback.calls;

    for (let i = 0; i < 10; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const late = store.recentEvents("a1", 400).filter((e) => e.id > settled);
    expect(answersButFails.calls).toBeGreaterThan(1); // the primary is still probed
    expect(late.filter((e) => e.type === "plan").length).toBeGreaterThan(0); // still planning
    expect(fallback.calls).toBeGreaterThan(fallbackAtSettle); // via the fallback
  });

  test("one primary failure after a recovery does not re-arm the down state", async () => {
    let now = 0;
    const store = new Store(":memory:");
    // Fails calls 1-2 (arms), succeeds on call 3 (the probe -> recovery), fails
    // call 4 (a single post-recovery blip), succeeds after.
    let calls = 0;
    const primary: Planner & { calls: number } = {
      calls: 0,
      async plan() {
        calls++;
        primary.calls = calls;
        if (calls <= 2 || calls === 4) throw new TransientPlannerError("blip");
        return { plan: okPlan, promptChars: 0, responseChars: 0 };
      },
    };
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    for (let i = 0; i < 5; i++) { await agent.runOnce(); now += HEARTBEAT; }
    expect(store.recentEvents("a1", 400).filter((e) => e.type === "planner_endpoint_recovered").length).toBe(1);
    const fallbackAtRecovery = fallback.calls;

    // Call 4 is the single blip. Without the post-recovery counter reset the
    // stale count is still at the threshold, so this one failure re-arms and
    // hands the next replans back to the paid fallback.
    for (let i = 0; i < 3; i++) { await agent.runOnce(); now += HEARTBEAT; }

    expect(store.recentEvents("a1", 400).filter((e) => e.type === "planner_endpoint_down").length).toBe(1);
    expect(fallback.calls).toBe(fallbackAtRecovery);
  });

  // Breakage caught: hoisting the counting block above the TokenInvalid and
  // SubscriptionLimit branches. That placement is the whole of "a latch is a
  // verdict on the subscription, not evidence an endpoint is unreachable", and
  // nothing else in the suite can see it -- every other test drives the
  // threshold with two failures of ONE counted class, which the hoist does not
  // change. The threshold needs two counted failures, NOT two of the same
  // class, so a transient failure followed by a latching one is the sequence
  // that separates the two placements. Reachable in the shape running in
  // production today (Claude-subscription primary, fallback configured); NOT
  // reachable in Stage 2's local-primary shape, because openai-compat.ts
  // classifies everything as transient.
  test("a mixed-class primary outage never counts the latching failure", async () => {
    let now = 0;
    const store = new Store(":memory:");
    let calls = 0;
    const primary: Planner & { calls: number } = {
      calls: 0,
      async plan(): Promise<never> {
        calls++;
        primary.calls = calls;
        // Failure 1 is counted (count -> 1). Failure 2 is a latch: it must
        // return BEFORE the counting block, leaving the count at 1. Hoisted,
        // it reaches 2 and announces the endpoint down.
        if (calls === 1) throw new TransientPlannerError("connect ECONNREFUSED");
        throw new SubscriptionLimitError("weekly quota exhausted");
      },
    };
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    await agent.runOnce();               // transient failure -> count 1
    now += HEARTBEAT;
    await agent.runOnce();               // subscription limit -> latches, must NOT count
    now += HEARTBEAT;

    const types = store.recentEvents("a1", 200).map((e) => e.type);
    expect(types).toContain("planner_subscription_limit"); // the real cause is reported
    expect(types).not.toContain("planner_endpoint_down");  // and not mislabelled
    expect(primary.calls).toBe(2);
  });
});
```

`SubscriptionLimitError` is already imported at the top of this file; no import changes are needed.

Then re-point three assertions in `test/experiment-revert.test.ts`, for the reason under "Why an existing test file has to change". Each `expect(fallback.calls).toBe(0)` becomes two exact counts; the `expect(reverts(store).length).toBe(0)` above each one is untouched. In `progress inside the window re-seeds the clock; a later full dry window still trips`:

```ts
    expect(reverts(store).length).toBe(0);
    // #240: the endpoint-down countdown also routes replans to the fallback
    // now, so "the fallback was never called" no longer distinguishes an
    // untripped experiment from a primary that keeps declining. Both exact
    // counts are pinned instead: two primary failures arm the countdown, and
    // the third replan is the first the fallback serves.
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(1);
```

In `fail-safe: no stats block -> never trips, however long the gap`:

```ts
    expect(reverts(store).length).toBe(0);
    // #240: see the note above -- the fallback serving is no longer proof the
    // experiment tripped. A tripped latch pins activePlanner() to the fallback
    // forever, so the primary would stop being probed; it is still probed here.
    expect(primary.calls).toBe(3);
    expect(fallback.calls).toBe(2);
```

And in `"any": one allowlisted counter advancing holds the latch open (no revert)`, the same pair with `// #240: see the note above.` — primary 3, fallback 2.

Note what is deliberately absent from the new agent tests. None uses an `experiment` config, so none needs `stubApi({ stats: { missions_completed: 1 } })`. If a later change adds one that does: `stubApi` builds a `StatusSnapshot` with no `stats`, so `progressCountersTotal(undefined)` returns null (`src/agent/no-progress-detector.ts:78-79`), the experiment fail-safe re-seeds every tick and the latch never fires. Such a test must pass `api: stubApi({ stats: { missions_completed: 1 } })` and use `withinHours: 1`, never `0`.


- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/agent-failure-classes.test.ts test/planner-openai-compat.test.ts test/experiment-revert.test.ts
```

Expected: the new tests fail. The first agent test fails on `expect(fallback.calls).toBe(1)` receiving `0`, because nothing yet routes a down endpoint to the fallback. The planner test fails on the watchdog, because nothing yet aborts the hung request. The three re-pointed `experiment-revert` assertions fail on `expect(fallback.calls)` receiving `0` where 1 or 2 is now expected — that is the direction of travel, and they go green with the rest.

- [ ] **Step 3: Give the openai-compat request a timeout**

In `src/planner/openai-compat.ts`, add to `OpenAiCompatOptions` after `fetchImpl`:

```ts
  timeoutMs?: number; // default OPENAI_COMPAT_TIMEOUT_MS; small values are for tests
}

// 60s per request. Receipt: the tick carried an UNBOUNDED planner wait, and a
// fetch with no signal against a silent host waits out the OS TCP connect
// timeout (~127s on Linux defaults) while an accepted-but-silent socket never
// settles at all. 60s turns unbounded into bounded, which is the whole claim.
// It is NOT "far below the tick": the agent loop ticks every 10s
// (agent.ts start(intervalMs = 10_000)), so a request running its full budget
// costs skipped ticks -- start()'s `if (running) return` drops them rather
// than queueing. Worst case per plan() is 2x this, because parse.ts retries
// once on a validation failure and each invoke() builds its own signal.
// UNCONFIRMED against a real gemma-4-12b-qat generation; #240 Task 3 Step 7
// re-derives it from measured seconds-per-plan.
export const OPENAI_COMPAT_TIMEOUT_MS = 60_000;
```

Add the signal to the fetch init, as the last member after `body`:

```ts
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? OPENAI_COMPAT_TIMEOUT_MS),
```

And bring the body read inside the transient classification, replacing the bare `const body = (await res.json()) as ChatCompletionResponse;`:

```ts
    let body: ChatCompletionResponse;
    try {
      // The timeout signal above also aborts a body read, and a truncated body
      // is the same class of infrastructure failure as a failed connect. Left
      // outside the classification this would escape as a plain Error and land
      // in handlePlannerFailure's catch-all, which never arms the endpoint-down
      // state -- the very stall this timeout exists to prevent. Model QUALITY
      // still fails through tryParsePlan on the CONTENT, which is untouched.
      body = (await res.json()) as ChatCompletionResponse;
    } catch (e) {
      throw new TransientPlannerError(`openai-compat: response body failed: ${e instanceof Error ? e.message : String(e)}`);
    }
```

Nothing in `planner-factory.ts` or `config.ts` changes: `timeoutMs` is not a config key, only a test seam and a named default.

- [ ] **Step 4: Add the constants**

In `src/agent/agent.ts`, directly after `TRANSIENT_BACKOFF_MAX_MS` at line 135:

```ts
// #240. Two consecutive PRIMARY failures against a LAN endpoint on a
// multi-minute replan cadence means the listener is gone or the model is
// unusable, not that either is busy; one failure is a blip the exponential
// backoff above already absorbs. Counted per-planner (consecutivePrimaryFailures
// below), so this really does mean two primary failures.
const ENDPOINT_DOWN_THRESHOLD = 2;
// How many REPLANS the fallback serves before the primary is probed again.
// Counted in replans, not milliseconds: a wall-clock window has to be longer
// than the largest inter-replan gap to survive one replan, and heartbeat_minutes
// is config the constant cannot see. 3 = two fallback-served replans plus a
// probe. This is a POLICY DIAL, not an optimum: measured over 24 replans
// against a dead primary, every paid fallback call is exactly one plan, so
// plan-rate and spend move together (N=2: 45.8%/0.458, N=3: 62.5%/0.625,
// N=5: 75%/0.750). 3 is chosen for the PROBE COUNT -- 9 blocking probes per
// 24 replans against N=2's 13. The cost is post-recovery waste, which is a
// DISTRIBUTION, not a fixed number: whatever phase of the countdown the
// recovery falls on, waste is uniform over 0..N-1, mean (N-1)/2. So N=3
// averages 1.0 wasted paid replan against N=2's 0.5, worst case 2 against 1.
// Move it if Stage 2 says quota matters more.
const ENDPOINT_RETRY_REPLANS = 3;
```

- [ ] **Step 5: Add the two fields**

Next to `private plannerBackoffUntil = 0;` at line 375. Private, and they stay private:

```ts
  // #240. Countdown in REPLANS, not a timestamp and not a boolean. Cleared
  // ONLY by a primary success. 0 means the state is not armed -- NOT that the
  // primary is known healthy (a TokenInvalid/SubscriptionLimit latch drives it
  // to 0 with no probe), which is why activePlanner() also consults
  // claudeDisabled and usingFallback.
  private endpointDownReplans = 0;
  // #240. Consecutive failures of the PRIMARY, every class it can recover
  // from. Separate from consecutiveTransientFailures, which is shared across
  // both planners AND reset by any success including a fallback's -- deriving
  // "the endpoint is down" from that one would flap the pilot back to a dead
  // endpoint every cycle, and would miss a primary that answers 200 with plans
  // that never validate (measured: 25 replans, 0 plans, fallback never
  // reached).
  private consecutivePrimaryFailures = 0;
```

- [ ] **Step 6: Count primary failures and arm the countdown off that count**

`handlePlannerFailure` at 2567 gains a second parameter. The counting block goes AFTER the `TokenInvalidError` and `SubscriptionLimitError` branches, both of which return early, and BEFORE the `TransientPlannerError` branch — so it sees the transient class and the catch-all class, and nothing else. The `TransientPlannerError` branch itself is left exactly as it was:

```ts
  private handlePlannerFailure(e: unknown, served?: Planner): void {
```

Then, immediately above `if (e instanceof TransientPlannerError) {`:

```ts
    // #240. Everything reaching here is a failure the PRIMARY can recover
    // from: a transient infrastructure error, or the catch-all class a plan
    // that fails validation twice lands in. Counting both is the point --
    // arming off consecutiveTransientFailures alone left a primary that
    // answers 200 with unusable plans serving every replan and producing
    // nothing, with the fallback configured and never reached. The two latching
    // classes above return before this block on purpose: TokenInvalid and
    // SubscriptionLimit are verdicts on the subscription, not evidence an
    // endpoint is unreachable, and each pins activePlanner() to the fallback
    // anyway. `served === this.planner` keeps a fallback-ONLY blip from arming
    // anything. The emit is gated on `=== 0`, so re-arming on a failed probe
    // never re-announces.
    if (served === this.planner) {
      this.consecutivePrimaryFailures++;
      if (this.fallbackPlanner && this.consecutivePrimaryFailures >= ENDPOINT_DOWN_THRESHOLD) {
        if (this.endpointDownReplans === 0) {
          this.emit("planner_endpoint_down", {
            consecutiveFailures: this.consecutivePrimaryFailures,
            retryReplans: ENDPOINT_RETRY_REPLANS,
          });
        }
        this.endpointDownReplans = ENDPOINT_RETRY_REPLANS;
      }
    }
```

Its one call site, in `replan()`'s `catch` at line 1953, passes the planner that actually served:

```ts
      this.handlePlannerFailure(e, planner);
```

- [ ] **Step 7: Serve the fallback from `activePlanner()`**

In `activePlanner()` at line 1635, after the `claudeDisabled` branch and before the `usingFallback` branch:

```ts
    // #240. Endpoint unreachable: serve the fallback until the countdown
    // reaches its last replan, then probe the primary (the replan IS the
    // health check -- no probe endpoint, no watchdog).
    if (this.fallbackPlanner && this.endpointDownReplans > 1) return this.fallbackPlanner;
```

- [ ] **Step 8: Decrement once per fallback-served replan**

In `replan()`, immediately after the `if (!planner) { ... return; }` guard that ends at line 1694:

```ts
    // #240. One decrement per REPLAN the fallback actually serves. Placed here
    // because this is the only site that commits a replan to a planner: ticks
    // that never reach a replan must not consume the countdown.
    if (this.endpointDownReplans > 0 && planner === this.fallbackPlanner) this.endpointDownReplans--;
```

- [ ] **Step 9: Clear it on a primary success**

In the success path, immediately before the existing `this.consecutiveTransientFailures = 0;` at line 1949. `planner` is the local captured at line 1690, so identity tells you which planner served this plan:

```ts
      // #240. Only a PRIMARY success ends the endpoint-down state. `planner` is
      // the local captured above, so identity says which planner served this
      // plan; a fallback success must not clear either field or the pilot would
      // flap back to a dead endpoint every cycle. The failure count is reset
      // here too: leaving it stale would let ONE blip after a recovery re-arm
      // the countdown instead of two.
      if (planner === this.planner) {
        this.consecutivePrimaryFailures = 0;
        if (this.endpointDownReplans > 0) {
          this.endpointDownReplans = 0;
          this.emit("planner_endpoint_recovered", {});
        }
      }
```

The inner `this.endpointDownReplans > 0` guard is not redundant. Without it, every primary success emits `planner_endpoint_recovered`, including the routine ones when nothing was ever down; ablation 7 reddens the recovered-event count assertion.

- [ ] **Step 10: Classify the two new events in the dashboard feed**

`src/server/dashboard.html`'s `eventDotClass` (at line 1228 on `ac7705b`; PR #22 did not touch this file) has no mapping for either new type, and neither matches its `/error|fail|stalled|backoff|alert|limit/` catch-all, so both would render as generic cyan in the feed Task 4 Step 6 tells the operator to watch. After the `plan`/`planner_recovered` line:

```js
    // #240 planner failover: down is a degradation (red), recovered is a return
    // to the cheap primary (green). Neither matches the generic regex below.
    if (t === "planner_endpoint_down") return "red";
    if (t === "planner_endpoint_recovered") return "green";
```

- [ ] **Step 11: Run the tests to verify they pass**

```bash
bun test test/agent-failure-classes.test.ts test/planner-openai-compat.test.ts test/experiment-revert.test.ts && bun run typecheck
```

Expected: all pass, typecheck clean. Observed on the finished implementation at `ac7705b`: 34 tests across the three files, 0 fail, 109 `expect()` calls.

- [ ] **Step 12: Ablate each guard**

Not optional, and not satisfied by reading the code. For each row: delete or weaken that row's guard and nothing else, run `bun run typecheck` FIRST, then `bun test test/agent-failure-classes.test.ts test/planner-openai-compat.test.ts test/experiment-revert.test.ts`, confirm the expected tests go RED, and restore before starting the next row. Typecheck first because `bun test` does not typecheck, so an edit that names a field which no longer exists silently no-ops and reports GREEN — the edit, not the guard, is what passed. This is the third occasion in one day where a count-blind or undefined-blind matcher hid a real defect (`toEqual` skipping `undefined` array entries, a `toContain` that could not distinguish one event from four, and revision 2's emit gate, which no test in the file could redden), so the table names tests rather than counts.

Results observed on the finished implementation. Every row was run: ablation applied alone, typecheck clean on every ablated tree, restored between rows, and the restored tree re-measured green at the end.

| # | Ablation | Observed RED |
|---|---|---|
| 1 | Delete the `activePlanner()` branch (Step 7) | 9: agent tests 1, 3, 4, 5, 8, 9 and all three re-pointed `experiment-revert` tests |
| 2 | Replace the `if (this.endpointDownReplans === 0)` emit gate with `if (true)` (Step 6) | 3: agent tests 2, 3, 8 |
| 3 | Replace `if (planner === this.planner)` in the recovery clear with `if (true)` (Step 9) | 4: agent tests 2, 4, 5, 8 |
| 4 | Replace `if (served === this.planner)` in the counting block with `if (true)` (Step 6) | 4: agent tests 3, 6 and two `experiment-revert` tests |
| 5 | Drop `this.fallbackPlanner &&` from the arming condition (Step 6) | 1: agent test 7 |
| 6 | Delete the per-replan decrement (Step 8) | 8: agent tests 3, 4, 6, 8, 9, 10 and two `experiment-revert` tests |
| 7 | Replace the inner `if (this.endpointDownReplans > 0)` in the recovery clear with `if (true)` (Step 9) | 1: agent test 4, on the recovered-event count |
| 8 | Add `&& e instanceof TransientPlannerError` to the counting block, reproducing revision 3 (Step 6) | 5: agent tests 8, 9 and all three `experiment-revert` tests |
| 9 | Delete `this.consecutivePrimaryFailures = 0;` from the recovery clear (Step 9) | 1: agent test 10 |
| 10 | Delete the `signal:` line (Step 3) | 1: the planner timeout test, on the watchdog at 1s |
| 11 | HOIST the counting block above the `TokenInvalidError`/`SubscriptionLimitError` branches (Step 6) | 1: agent test 11, on `planner_endpoint_down` appearing before `planner_subscription_limit` |

Agent tests are numbered in the order they appear in Step 1: 1 two-consecutive-failures, 2 down-emitted-once, 3 dual-outage, 4 probe-recovers, 5 fallback-success-does-not-clear, 6 fallback-failure-does-not-arm, 7 no-fallback-configured, 8 pure-catch-all, 9 unreachable-to-unusable, 10 one-failure-after-recovery, 11 mixed-class-latch.

Row 8 is the one that matters most: it reproduces revision 3's design exactly, and five tests across two files catch it. Rows 5, 7, 9, 10 and 11 each rest on a single test, which is the point — each was written for one guard and nothing else covers it. Row 11 is new in revision 5 and replaces revision 4's claim that the counting block's placement could not be tested; measured, agent test 11 is the ONLY test that moves under that ablation, and adding it changed no other row's RED set. If any ablation leaves the suite GREEN, either the test is decorative or the ablation silently no-opped; verify the edit landed and the tree typechecks, then rewrite the test so it bites and say so in the completion report.

- [ ] **Step 13: Run the full suite**

```bash
bun test && bun run typecheck
```

Expected: 1476 tests total, 0 fail, typecheck clean. Report the TOTAL, not the pass/skip split: several suites are `skipIf`-gated on files and tooling that are present on a dev workstation and absent in the container (`test/doc-size.test.ts` skips its whole describe when `docs/` is missing), so the split moves between environments while the total does not. Only a non-zero `fail` is a problem.

Measured on `ac7705b`, both halves on the same tree so the delta is real:

| tree | total | pass / skip / fail |
|---|---|---|
| unmodified `ac7705b` | 1464 | 1463 / 1 / 0 |
| with Task 1 applied | 1476 | 1475 / 1 / 0 |

**The load-bearing number is the DELTA, +12, not the total.** Task 1 adds eleven tests in `test/agent-failure-classes.test.ts` and one in `test/planner-openai-compat.test.ts`; the three re-pointed assertions in `test/experiment-revert.test.ts` change that file's `expect()` count, not its test count. `tsc --noEmit` clean on both trees. Check the delta against a freshly measured baseline on whatever `main` is when you implement this, rather than expecting 1476 — the absolute total moves every time anything merges, and it already has twice during this plan's review (revision 4 measured 1443/1454 on `5abff04`; PRs #20 and #22 moved the baseline to 1464, and PR #24 moved it again after this revision was measured). PR #24 changed none of Task 1's seven files, so every anchor and every ablation result above still holds at `fa795de`; only the totals move.

Three existing test files stay untouched — `test/agent-snapshot.test.ts` and `test/server.test.ts`, because the countdown never reaches `snapshot()`, and `test/agent-observability.test.ts`. `test/experiment-revert.test.ts` IS modified, for the reason under "Why an existing test file has to change".

- [ ] **Step 14: Append the decision-log entry**

`docs/decisions.md`, following the enforced shape: one-paragraph context, `**Options.**` as terse one-line bullets each naming the option, its tradeoff and the verdict, then a one-paragraph `**Decision.**`. Hard cap 400 words, enforced by `test/doc-size.test.ts`; 200-300 is typical. Written for an infrastructure engineer, not a developer.

The options genuinely on the table, all rejected for reasons that belong in the log: reusing `usingFallback` (a one-way latch, never reset — the first overnight sleep would move the pilot to the subscription permanently); a boolean instead of a counter (built and measured by a reviewer: under a dual outage it locked the primary out permanently); a health-probe endpoint (an extra call every cycle when the replan is itself the probe); a separate watchdog task (a new lifecycle to own); deriving the state from `consecutiveTransientFailures` alone (reset by a fallback success, so the pilot would flap every cycle, AND blind to a primary that answers with unusable plans — measured at 25 replans, 0 plans, fallback never reached); and documenting that last gap instead of fixing it (not a real option — it leaves the pilot stuck with zero plans in the likeliest Stage 2 shape; the counter costs 3 lines, 24 insertions against 27, code-only).

State the retry-window number this way: `ENDPOINT_RETRY_REPLANS = 3` is chosen on the PROBE COUNT (9 blocking probes per 24 replans against N=2's 13), not on waste. Post-recovery waste is a range, not a number — uniform over 0 to N-1 depending on where in the countdown the endpoint comes back, averaging (N-1)/2. So the cost of 3 over 2 is half a paid call per outage on average, worst case one. Do not write "N-1 wasted replans" as though it were the typical case; that overstates it by 2x and was the error revision 5 corrected.

Include the wall-clock-versus-replan-count choice and why the millisecond window failed (shorter than the configured replan cadence, so it expired before it could ever be read: 20 heartbeat-spaced ticks, 0 fallback calls, 16 duplicate down events). Include the timeout, and state its limits. It converts an unbounded planner wait into a bounded one. It does not make a probe cheap relative to the 10-second tick, and the worst case is 2x the constant because the parse layer retries once.

For the reader who is not a developer, the shape worth landing is this. The pilot has a preferred planner and a paid backup. When the backup takes over depends on how many times in a row the preferred one has to fail, which is two, and on how many planning cycles the backup covers before the preferred one is retried, which is three. That second number is a dial with no correct setting. Every cycle the backup covers is a cycle that produces a plan and costs money, one for one, so the number really answers a different question: how often are we willing to retry an endpoint that is probably still asleep?

Then run the gate:

```bash
bun test test/doc-size.test.ts test/lint-doc-prose.test.ts
```

- [ ] **Step 15: Pair the guard with an improv-mode instruction**

Every deterministic guard gets a paired entry in `docs/superpowers/specs/2026-07-12-improv-mode.md`. This one is infrastructure, not a piloting lesson, so one line under the non-negotiable-backstops section is the right size: planner failover is deterministic and stays deterministic — the improv agent neither observes nor chooses its planner, and must not be briefed to reason about endpoint health.

- [ ] **Step 16: Commit and open the PR**

```bash
git checkout -b feat/240-endpoint-fallback
git add src/agent/agent.ts src/planner/openai-compat.ts src/server/dashboard.html \
        test/agent-failure-classes.test.ts test/planner-openai-compat.test.ts \
        test/experiment-revert.test.ts \
        docs/decisions.md docs/superpowers/specs/2026-07-12-improv-mode.md
git commit -m "feat(240): reversible fallback when the primary planner stops producing plans

A primary planner that stops producing plans made the agent back off and
eventually stall rather than plan with its configured fallback. Every existing
fallback trigger is subscription-shaped (bad token, exhausted quota,
no-progress latch), so a sleeping workstation, or a local model that answers
but returns plans failing validation, left the pilot doing nothing until the
box woke or the 12-hour experiment latch fired.

Options considered. Reusing usingFallback: rejected, it is a one-way latch
assigned in exactly one place and never reset, so the first overnight sleep
would move the pilot to the subscription permanently and destroy the saving
this change exists to capture. A boolean instead of a counter: built and
measured, rejected, because a dual outage locked the primary out permanently.
A health-probe endpoint: rejected, an extra call every cycle when the replan
attempt is itself the probe. A separate watchdog task: rejected, a new
lifecycle to own for a condition a failure counter already expresses. Arming
off the existing consecutiveTransientFailures: rejected twice over, because a
fallback success resets it (the pilot would flap between planners every cycle)
and because only the transient branch touches it, so a primary answering 200
with unusable plans armed nothing at all -- measured at 25 replans, 0 plans,
with the fallback configured and never reached. Documenting that last gap
rather than fixing it: rejected, it leaves the pilot producing zero plans in
the likeliest Stage 2 shape, and the counter that closes it is three lines
(24 insertions against 27, comments excluded). A
millisecond retry window: rejected after measurement, because any constant
shorter than heartbeat_minutes expires before the next replan reads it, and
any constant longer is coupled to a config value nobody re-derives.

Adds a request timeout to openai-compat and two private fields plus two
constants to the agent. The fetch had no AbortSignal, so probing a sleeping
endpoint blocked the tick for the OS connect timeout; that is now bounded,
though at 60s it is still long against a 10-second tick and the parse layer's
single retry doubles the worst case. consecutivePrimaryFailures counts every
recoverable failure class of the primary and nothing else, so the threshold
means what its name says. endpointDownReplans counts replans, not
milliseconds, so the behaviour is independent of tick rate and heartbeat
config; the last replan of the countdown probes the primary, and the replan is
the health check. Cleared only by a primary success, which also resets the
failure count so one blip after a recovery cannot re-arm it.
handlePlannerFailure now takes the planner that served, so a fallback blip is
not blamed on the primary.

Three assertions in experiment-revert.test.ts move. Its fixture planners throw
a plain Error, which this change now routes to the fallback, so
'fallback.calls === 0' stopped meaning 'the experiment has not tripped'. Each
becomes two exact counts; the revert-count assertion above each one is
untouched.

Closes part of #240."
git push -u origin feat/240-endpoint-fallback
```

Then open the PR (separate call, do not chain):

```bash
gh pr create --title "feat(240): reversible fallback when the planner endpoint is unreachable" --body "<summary + the behaviors + all eleven ablation results>"
```

---

## Task 2: Stage 0, baseline the incumbent

**Files:**
- Create: `docs/eval/2026-07-25-planner-baseline.md`
- Read only: `src/eval/run.ts`, `src/eval/harvest.ts`, `src/server/usage.ts`, `test/fixtures/eval-cases.json`

**Interfaces:**
- Consumes: the CLI surface of `src/eval/run.ts` (read at Step 2 before any invocation).
- Produces: `docs/eval/2026-07-25-planner-baseline.md` containing a per-scorer table with columns `scorer | incumbent pass rate | n scored | n abstained`, plus the run-level COST line. Task 3 appends a second table to this same file.

**Read this before running anything.** `src/eval/run.ts:221` is `if (report.overall !== null && report.overall < 1) process.exit(1);` and `:222` exits non-zero when the thrash check fails. A real planner will not score 100%, so a NON-ZERO EXIT IS THE EXPECTED OUTCOME at Stage 0 and is not a broken run. Note the `!== null` half: a run where every scorer abstains has `overall === null` and exits ZERO. So exit code 0 does NOT mean the run scored well — it means either a perfect score or nothing measurable at all, and only the printed report distinguishes them. Never chain these invocations with `&&`; capture the printed report and read it.

- [ ] **Step 1: Snapshot the production event DB**

The pilot writes this file continuously, so copy it rather than reading it in place. Run from the workstation:

```bash
ssh truenas 'docker cp spacemolt-harness:/app/data/harness.sqlite /tmp/harness-snapshot.sqlite && ls -la /tmp/harness-snapshot.sqlite'
scp truenas:/tmp/harness-snapshot.sqlite ./tmp/harness-snapshot.sqlite
ssh truenas 'rm -f /tmp/harness-snapshot.sqlite'
```

Expect roughly 34 MB. `./tmp/` must be gitignored; verify with `git check-ignore -v tmp/harness-snapshot.sqlite` before going further. If it is not ignored, add it and commit that first.

- [ ] **Step 2: Read the eval CLI surface before invoking it**

```bash
bun run src/eval/run.ts --help
```

The invocations below were re-read against `src/eval/run.ts:166-223` at `ac7705b` for revision 5 and are correct as of that commit (PR #22 did not touch `src/eval/`). Re-read the USAGE block anyway and reconcile: the flag is `--provider`, not `--planner`; the accepted set is `mock | claude-subscription | codex-subscription | ollama | openai-compat`; there is no `--db` and no `--limit`; and harvesting is a SEPARATE invocation (`run.ts:189-200`) that writes a JSON file and returns before any planner is built.

- [ ] **Step 3: Find the pilot's agent id**

`--harvest` needs one, and guessing it yields an empty harvest that looks like a working run.

```bash
bun -e 'import {Database} from "bun:sqlite"; const db = new Database("tmp/harness-snapshot.sqlite", {readonly:true}); console.log(db.query("SELECT agent_id, COUNT(*) AS n FROM events WHERE type = ?1 GROUP BY agent_id").all("plan_context"));'
```

Use the id with the most `plan_context` rows. Record it; Task 3 must harvest nothing.

- [ ] **Step 4: Harvest, then trim to 25 cases**

`harvestCases` is called by the CLI with no limit, so it takes `src/eval/harvest.ts:20`'s default of 50 and there is no flag that changes it. N = 25 is therefore a two-step operation, not an argument:

```bash
bun run src/eval/run.ts --harvest ./tmp/harness-snapshot.sqlite --agent <agent-id> --out ./tmp/cases-harvested.json
```

```bash
bun -e 'const all = JSON.parse(await Bun.file("tmp/cases-harvested.json").text()); const keep = all.slice(-25); await Bun.write("tmp/cases-25.json", JSON.stringify(keep, null, 2)); console.log(`${all.length} harvested -> ${keep.length} kept`);'
```

`recentEventsByType` (`src/store/store.ts:118-125`) returns the newest rows re-sorted oldest-first, so `slice(-25)` is the 25 MOST RECENT decision points. If the harvest returns fewer than 25, that is the real N: record the actual number in the baseline document and use the same file for Stage 1 rather than topping it up from an older window.

Receipt for 25 rather than the full 50: this spends real subscription quota, 25 cases separates a 15-point per-scorer regression from noise, and the curated fixture in Step 6 covers the dimension harvesting cannot.

- [ ] **Step 5: Read the incumbent's model id from the pilot, and check it is priced**

The cost column is worthless if the incumbent silently prices at $0.00, and it will: `priceFor` (`src/server/usage.ts:77-79`) falls back to `FREE_MODEL_PRICE` for ANY model id outside `{opus, sonnet, haiku}`, so a full model id like `claude-sonnet-4-5` estimates as free with no warning.

Read `planner.model` from the pilot host's `agents.yaml` (gitignored; do not commit its contents, and do not paste host paths into the baseline document). Then confirm that exact string is a key in `MODEL_PRICES`:

```bash
bun -e 'const {MODEL_PRICES} = await import("./src/server/usage"); console.log(Object.keys(MODEL_PRICES));'
```

Pass that same string as `--model` in Step 6, so the baseline prices the model the pilot actually runs. If it is NOT a priced key, stop and report: either the pilot's config or the price table is wrong, and both are cheap to fix, whereas a $0.00 baseline silently invalidates the whole cost comparison.

- [ ] **Step 6: Run the incumbent against the harvested cases and the curated fixture**

```bash
bun run src/eval/run.ts --cases ./tmp/cases-25.json --provider claude-subscription --model <production-model-id>
```

```bash
bun run src/eval/run.ts --cases test/fixtures/eval-cases.json --provider claude-subscription --model <production-model-id>
```

The second is the run in which `knownSystemRef` actually scores instead of abstaining, because the fixture sets `groundTruth.knownSystemIds` by hand.

- [ ] **Step 7: Assert the priced total is non-zero**

Read the `COST` line `formatReport` prints (`src/eval/run.ts:157-160`). It carries the USD estimate, prompt and response chars, and USD per passed check. If it reads `$0.0000` on a run of 25 real subscription calls, Step 5's check was skipped or the model id did not match a price key — stop and fix that before writing the document. A zero here is not a cheap incumbent; it is a broken measurement.

There is nothing to wire: `src/eval/run.ts:3` already imports `estimateCostUsd` from `../server/usage`, and `:108-110` already reduces it across the per-case results. (Revision 2 named `src/cost/usage.ts`, which does not exist; the module is `src/server/usage.ts`.)

- [ ] **Step 8: Write the baseline document**

Create `docs/eval/2026-07-25-planner-baseline.md`. Include both tables (harvested and curated), the exact commands, the real case count, the date, the model id, and an explicit list of any scorer that returned `null`. A `null` is an unmeasured dimension, not a pass; say so in the document.

Record cost per plan alongside the quality numbers, straight from the COST line, plus total prompt and response characters. The whole exercise is a cost decision, so the cost column has to exist at Stage 0 — otherwise Stage 1 gates on quality alone and the number that motivated the work only appears in Task 4, after the gate.

State plainly that these numbers are the bar and that the Stage 1 margins were fixed before they were known.

- [ ] **Step 9: Commit**

```bash
git checkout -b docs/240-planner-baseline
git add docs/eval/2026-07-25-planner-baseline.md
git commit -m "docs(240): Stage 0 baseline, incumbent planner per-scorer pass rates

The A/B needs a bar and we did not have one -- no measurement of what the
Claude planner actually scores on the eval's scorers existed, so any threshold
set in advance would have been invented. This is that measurement, over the
harvested real decision points plus the curated fixture, with cost per plan
recorded alongside quality so Stage 1 can gate on both.

Margins for Stage 1 were pre-committed in the design spec before these numbers
existed; only the baseline they are measured against comes from here."
git push -u origin docs/240-planner-baseline
```

---

## Task 3: Stage 1, the offline gate

**Files:**
- Modify: `docs/eval/2026-07-25-planner-baseline.md` (append the candidate table and the verdict)
- Modify: `docs/decisions.md` (append one entry, 400-word cap, `**Options.**` bullets then `**Decision.**`)

**Interfaces:**
- Consumes: the baseline tables from Task 2, and `./tmp/cases-25.json` — the SAME file, not a fresh harvest.
- Produces: a PASS or FAIL verdict recorded in both files. Task 4 runs only on PASS.

- [ ] **Step 1: Start the LM Studio server**

On the workstation. Bind to localhost only; Stage 1 runs on the same machine, so no firewall change and no exposed unauthenticated endpoint:

```powershell
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" server start
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" load google/gemma-4-12b-qat
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" ps
```

- [ ] **Step 2: Confirm the endpoint answers and honours the grammar**

```bash
curl -s http://127.0.0.1:1234/v1/models
```

Expect `google/gemma-4-12b-qat` in the list. If the model id served differs from the model key, use the served id in config; do not assume they match.

- [ ] **Step 3: Run the candidate over the identical harvested cases**

The same `./tmp/cases-25.json` Task 2 scored. Identical inputs to both models is the only controlled comparison available; re-harvesting would change the case set and invalidate the whole exercise.

```bash
bun run src/eval/run.ts --cases ./tmp/cases-25.json --provider openai-compat --model google/gemma-4-12b-qat --base-url http://127.0.0.1:1234
```

- [ ] **Step 4: Run the candidate over the curated fixture**

```bash
bun run src/eval/run.ts --cases test/fixtures/eval-cases.json --provider openai-compat --model google/gemma-4-12b-qat --base-url http://127.0.0.1:1234
```

Note that the candidate's COST line will read `$0.0000` and that this one IS correct: a self-hosted model has no per-token price, which is the entire point of the exercise. Contrast Task 2 Step 7, where a zero means a broken measurement.

- [ ] **Step 5: Apply the pre-committed pass conditions**

Check all four, and report each one's result explicitly rather than reporting an overall verdict:

1. No signal-carrying scorer regresses by more than 15 points against the Task 2 baseline. The seven are `knownSystemRef`, `knownPoiRef`, `knownItemId`, `dockRequiresStation`, `mineNeedsMatchingModule`, `noMineIntoFullHold`, `cargoCoherence`. `knownAction` and `requiredParams` are EXCLUDED: the grammar enforces them for any model, so they carry no signal and must not be counted toward a pass.
2. `scoreGoalDiversity` does not regress at all.
3. No scorer passes on abstentions alone. Any `null` blocks the gate until it is measured on the curated fixture.
4. Zero unparseable responses. A response the grammar could not force into schema is an infrastructure failure, not a quality signal; investigate before trusting any number in the table.

- [ ] **Step 6: Time the candidate's plans**

Wall-clock seconds per plan, over the Step 3 run. Two consumers: the comparison (a free model that is four times slower changes the plan rate the pilot can sustain, and that belongs in the table, not in a footnote after the gate), and `OPENAI_COMPAT_TIMEOUT_MS`.

- [ ] **Step 7: Check the timeout constant against that measurement**

`OPENAI_COMPAT_TIMEOUT_MS` is 60s and its headroom was UNCONFIRMED when Task 1 shipped — no plan had been timed on this model. Compare the slowest plan from Step 6 against the constant, and mind two things the raw number hides.

The budget is PER ATTEMPT, not per `plan()`. `planWithSingleRetry` (`src/planner/parse.ts:53-72`) calls `invoke` a second time when the first response fails validation, and `AbortSignal.timeout()` is built inside `invoke`, so the retry starts a fresh 60s. Measured at `timeoutMs: 600` against a server that burns 500ms then returns an unusable plan and hangs on the retry: 1116ms elapsed over 2 invokes, against 608ms over 1 on the single-attempt path. So a Stage 1 run's slowest observed plan may already be a two-attempt plan, and the worst case the pilot can hit is 120s.

Judge it this way. If the slowest SINGLE attempt is within 2x of 60s, raise the constant in a follow-up PR and record the measurement as its new receipt. If the slowest attempt is comfortably under but the retry rate is non-zero, say so explicitly in the baseline document — the constant is fine and the pilot's worst-case tick cost is still 120s, which the operator should know before Stage 2. Comfortably under with a zero retry rate retires the assumption. A timeout that fires on a legitimately slow local generation shows up as transient planner failures and a fallback that never hands back.

- [ ] **Step 8: Append the candidate table and verdict**

Append to `docs/eval/2026-07-25-planner-baseline.md`: the candidate's tables side by side with the incumbent's, the per-condition results from Step 5, the seconds-per-plan from Step 6, and a one-line PASS or FAIL.

Carry the cost-per-plan column through from Task 2, so the two models sit side by side on cost as well as quality. Record the local model as `$0.00 quota` plus wall-clock seconds per plan.

FAIL is an acceptable outcome and ends the exercise here. If it fails, say which condition failed and by how much, and note that the VRAM headroom means retrying with a larger model is a download rather than a code change.

- [ ] **Step 9: Append the decision-log entry**

Append to `docs/decisions.md`, following the enforced shape: one-paragraph context, `**Options.**` as terse one-line bullets each naming the option, its tradeoff and the verdict, then a one-paragraph `**Decision.**`. Hard cap 400 words, enforced by `test/doc-size.test.ts`; 200-300 is typical.

Written for an infrastructure engineer, not a developer. Educational register: define terms in plain words on first use, give the why alongside the what.

- [ ] **Step 10: Run prose-lint and the doc-size gate**

```bash
bun test test/doc-size.test.ts test/lint-doc-prose.test.ts
```

Fix what it flags. Name any genuine false positive in the PR body rather than silently ignoring it.

- [ ] **Step 11: Commit and open the PR**

Branch `docs/240-stage1-verdict`. Commit message states the verdict and the numbers behind it, in the compressed register for subject and bullets and normal prose for the rationale.

---

## Task 4: Stage 2, live swap (GATED)

**Do not start this task unless Task 3 recorded a PASS.** A FAIL ends the exercise at Stage 1.

**Files:**
- Modify: `agents.yaml` on the pilot host (gitignored; never commit it)
- Create: `docs/eval/2026-07-25-stage2-window.md` after the observation window closes

**Interfaces:**
- Consumes: Task 1's endpoint fallback (must be merged and deployed first — without it, a workstation sleep stalls the pilot).
- Produces: the Stage 2 comparison document.

- [ ] **Step 1: Confirm the operator prerequisites are done**

These need the operator at the workstation and are NOT autonomous work:

1. LM Studio server bound to `0.0.0.0:1234` rather than localhost.
2. `google/gemma-4-12b-qat` loaded.
3. Windows Firewall inbound TCP 1234 allowed for the LOCAL SUBNET ONLY, never `Any`. This is an unauthenticated LLM endpoint. `openai-compat.ts` supports `api_key_file` if a key is wanted; a key never appears inline in `agents.yaml`.

If any is missing, stop and report. Do not add a firewall rule autonomously.

- [ ] **Step 2: Prove the path from inside the container**

Use the same TCP probe that already proved 3389 reachable, from inside the pilot container, against port 1234. A successful probe from the host is not sufficient evidence; the container is the thing that has to reach it.

- [ ] **Step 3: Confirm the deployed image contains Task 1**

Check the running container's image against the merge commit for `feat/240-endpoint-fallback`. Deploying the planner swap onto an image without the fallback is the failure mode this whole task exists to avoid.

- [ ] **Step 4: Record the pre-swap baseline window**

From the event store, for the 24 hours before the swap: plans/hour, `plan_budget_exceeded` count, credits earned, missions completed, ore mined, systems visited, and blocked-action classes by count. A prior note put this at roughly 10-12 plans/hr with 6 `plan_budget_exceeded` in the hour before the #517 merge — treat that as a rough expectation, not a baseline. It is carried from an earlier session, no offline check can confirm it, and the pilot has merged work since. Derive the real numbers from the DB in this step and use those; if they are far off the note, say so in the window document rather than assuming the query is wrong.

- [ ] **Step 5: Apply the config**

```yaml
planner: { provider: openai-compat, model: google/gemma-4-12b-qat, base_url: "http://<workstation-lan-ip>:1234" }
fallback_planner: { provider: claude-subscription, model: <production-model-id> }
experiment: { revert_if_no: any, within_hours: 12 }
```

Use the same priced model id Task 2 Step 5 read, so the fallback's spend lands in the same price bucket the baseline used. Back up the existing `agents.yaml` first. Restart the container and confirm it comes up healthy.

- [ ] **Step 6: Observe, then compare**

Let the window run. Compare against Step 4 on the same measures. `experiment:` is the deterministic exit; if it reverts, that IS the result and it is not overridden by judgment.

Watch the EVENT FEED, not the health pills. `planner_endpoint_down` and `planner_endpoint_recovered` are the evidence that Task 1 works in production, which no offline test can provide, and both carry an explicit feed colour (Task 1 Step 10) — red for down, green for recovered. The pills will not help: `usingFallback` is assigned only by the subscription-limit path, so it reads `false` for the whole endpoint-down window and `dashboard.html:684` and `:708` keep showing the planner as ok. Measured offline over 20 ticks with 10 replans served by the fallback. Treat it as a known gap and leave it alone during the window.

A `planner_endpoint_down` with no matching `planner_endpoint_recovered` and a plan rate that keeps up is the fallback doing its job. A plan rate that drops to zero is not, and is worth an immediate revert. A `planner_endpoint_down` whose `consecutiveFailures` payload keeps climbing across repeated events would mean the emit gate is broken — one event per transition is the contract.

- [ ] **Step 7: Write the window document and the lesson**

Create `docs/eval/2026-07-25-stage2-window.md` with both windows side by side. Append a lesson to `docs/wiki/engineering-lessons.md` if the merge taught something transferable (concrete incident, principle, discipline, why).

Separate KNOWN from UNPROVEN. "Removes the pilot's quota draw" stays a hypothesis until subscription spend attributable to the pilot is measured before and after, and it is only valid for hours the workstation was actually awake.

---

## Self-Review

**Base commit.** This revision was written and measured against `ac7705b`, which is `main` at the time of writing. The plan branch was merged with `ac7705b` before any of it was re-measured, so the anchors, the suite totals and the ablation results all describe the same tree. PR #22 touches none of Task 1's four edit sites.

**Spec coverage.** Every spec section maps to a task: "the one real code change" to Task 1; Stage 0 to Task 2; Stage 1 including both case sources and all four pass conditions to Task 3; Stage 2 including the config block and the rejected-second-pilot rationale to Task 4; the prerequisites to Task 4 Step 1; the testing section's behaviors to Task 1 Step 1 with the ablations at Step 12. The spec's "interaction to verify, not assume" is resolved in Task 1's design notes with a stated answer (do not touch the backoff gate).

**Deliberate departures from the spec, all flagged for the operator.** The spec's `ENDPOINT_RETRY_MS = 10 * 60_000` is replaced by `ENDPOINT_RETRY_REPLANS = 3`, because the millisecond window was shorter than the configured replan cadence and expired before it could be read — measured, not argued. The spec does not mention a request timeout on `openai-compat.ts`; one is added, because without it the retry constant is sized to hide a blocking call in another file. The spec's fourth test, which it describes as "the one that protects a real invariant", is deleted as UNFALSIFIABLE: both branches return the same object, so the ordering it asserts is not observable and the reorder left the suite green. The invariant itself is real, structurally guaranteed, and covered by `test/experiment-revert.test.ts` — deleting the test does not delete it. And the spec assumes the endpoint-down state keys off transient failures; it keys off a per-primary failure count instead, so a reachable-but-unusable primary is handled by the same mechanism. Neither the spec nor the code on `main` is edited by this plan.

**One existing test file is modified, which earlier revisions promised not to touch.** `test/experiment-revert.test.ts`, three assertions, each growing from one exact count to two. That promise was worth keeping, and this breaks it knowingly: the file's fixture planners ARE the pure catch-all shape, so routing that shape to the fallback necessarily moves its counters. A reviewer should check that the three replacements pin exact values rather than loosening to `toBeGreaterThan`, and that `expect(reverts(store).length).toBe(0)` still sits above each one.

**Placeholder scan.** No TBDs. Two placeholders are intentional: `<workstation-lan-ip>`, because the real value must not enter the public repo, and `<agent-id>` / `<production-model-id>`, which Task 2 Steps 3 and 5 instruct the implementer to read from the snapshot DB and the pilot's config rather than guess.

**Type consistency.** `endpointDownReplans` and `consecutivePrimaryFailures` are spelled identically in Steps 5, 6, 8, 9 and in the ablation table. Neither appears in an interface or a test file, because both are private. `ENDPOINT_DOWN_THRESHOLD` matches the spec's committed value and now genuinely counts primary failures; `ENDPOINT_RETRY_REPLANS` is the replacement named above. `planner_endpoint_down` and `planner_endpoint_recovered` match the spec's event names and are used consistently in the tests, the implementation steps, the dashboard mapping, and the ablation table. The `retryMs` payload key becomes `retryReplans`, matching the unit change; nothing reads the old key.

**Persisted-state schema tolerance does not apply.** The project's binding rule covers artifacts that outlive the schema that wrote them. `snapshot()` is computed live at `src/server/server.ts:298` and never persisted, and neither new field is in it.

**Verification status of this plan.** Task 1 was applied verbatim in a throwaway worktree cut from `ac7705b` and re-measured from scratch for THIS revision. Every number below was observed in revision 5, not copied from revision 4 or from the gate's report.

KNOWN, with the evidence:

- Full suite on `ac7705b`: unmodified 1464 total (1463 pass / 1 skip / 0 fail); with Task 1 applied 1476 total (1475 pass / 1 skip / 0 fail). `tsc --noEmit` clean on both. Task 1 adds 12 tests.
- The three touched files alone: 34 tests, 0 fail, 109 `expect()` calls.
- All ELEVEN ablations in Step 12 observed RED with exactly the tests listed, typecheck clean on every ablated tree, restored between rows, and the restored tree re-measured green at 34 pass / 0 fail. Adding agent test 11 changed no other row's RED set.
- Ablation 11 specifically: hoisting the counting block above the latching branches reddens agent test 11 and nothing else (33 pass / 1 fail), with the event trace showing `planner_endpoint_down` immediately before `planner_subscription_limit`.
- The N table, over exactly 24 replans against a dead primary: N=2 11 paid / 13 probes, N=3 15 / 9, N=4 17 / 7, N=5 18 / 6, and paid calls equal to plans in every row.
- Post-recovery waste, swept across every phase of the countdown at each N: uniform over `0..N-1`, waste = (countdown at recovery) − 1, means 0.5 / 1.0 / 1.5 / 2.0 at N = 2 / 3 / 4 / 5. Revision 4's "exactly N-1 in every row" was the worst case only.
- Code-only diff size in `agent.ts`, generated from this plan's own code blocks and diffed with `git diff --numstat`: revision 3's shape 24 insertions / 2 deletions, revision 5's 27 / 2. Revision 4's 28 and 31 do not reproduce; the 3-line delta does.
- Revision 3's failure shape, rebuilt and run: 30 heartbeat-spaced replans against a primary answering only with unusable plans gave 25 primary calls, 0 fallback calls, 0 plans, 25 `planner_error`, and `plannerHealth.stuck = true`.
- The retry doubling: 1124ms and 1123ms over 2 invokes against a 600ms budget, versus 605ms and 609ms over 1.
- `usingFallback` false across a 20-tick window with 10 fallback-served replans and 7 primary probes.
- The decrement's placement: 16 ticks against a dead primary with a three-step fallback plan gave 14 replans and 2 step-executing ticks, the countdown holding at `3 -> 3` on tick 5 and `1 -> 1` on tick 11 while walking `3 -> 2 -> 1 -> 3` on the replan ticks.
- N=2 leaves a fallback-served window: 2 fallback-served replans during the outage and exactly one `planner_endpoint_recovered`.
- Branch order in `activePlanner()` is unobservable: the endpoint-down branch was moved above `experimentReverted` and the full suite stayed green at 1476 total, 0 fail.
- Source anchors re-read at `ac7705b`: `agent.ts` 135, 375, 1007, 1635, 1690, 1947, 1950, 1953, 2567, 2585, 2752; `openai-compat.ts` 14-23, 46-67, 80; `parse.ts` 53-72; `usage-poll.ts:38` (15s against the 10-minute cron noted at `:32`); `run.ts` 3, 108-110, 155-160, 189-200, 221-222; `harvest.ts:20`; `store.ts:118-125`; `usage.ts` 69-87; `dashboard.html` 684, 708, 1228; `agent-snapshot.test.ts:107-109`; the nine `SCORERS` entries; `no-progress-detector.ts:78-79`; spec line 29 and line 132.
- Each of the seven strings the four edit sites key on occurs exactly once in `agent.ts` at `ac7705b`.

UNPROVEN, and what would settle each:

- `OPENAI_COMPAT_TIMEOUT_MS = 60_000` has no measurement behind its VALUE. Settled by Task 3 Step 6's seconds-per-plan on the real model.
- The ~127s Linux connect timeout is arithmetic from a documented kernel default, not a measurement on the deploy host.
- The millisecond design's failure numbers (20 ticks, 0 fallback calls, 16 down events, 0 plans) are carried from revision 4 and were NOT rebuilt in revision 5. The decision they support does not rest on them alone: a wall-clock window shorter than `heartbeat_minutes` expiring before the next replan reads it is arithmetic, not a measurement. Rebuild it if the wall-clock design is ever re-proposed.
- Tasks 2, 3 and 4 are unverified by construction: they need the production DB, real quota, and the operator's workstation. Their command lines were reconciled against the sources listed above, which is not a claim that they have been run.
- Nothing here is evidence that a local planner is cheaper or good enough. That is what Stages 0 through 2 exist to find out, and a FAIL at Stage 1 ends the exercise.
