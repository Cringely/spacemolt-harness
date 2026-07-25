# Local Planner A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, on measured evidence, whether `google/gemma-4-12b-qat` on LM Studio can replace the Claude subscription as the pilot's planner, and close the one code gap that only bites once a local endpoint is in the path.

**Architecture:** Three gated stages. Stage 0 measures the incumbent planner on recorded decision points, producing the bar. Stage 1 runs the identical cases through the local model and compares against pre-committed margins. Stage 2 swaps the live pilot's planner behind the existing deterministic `experiment:` revert. Task 1 (the code change) is independent of the stages and lands first, because a local endpoint that sleeps must degrade to the fallback instead of stalling the pilot.

**Tech Stack:** Bun ≥ 1.2.21, TypeScript, Zod, `bun:sqlite`, existing `src/eval/*` harness, existing `src/planner/openai-compat.ts`.

**Source spec:** `docs/superpowers/specs/2026-07-25-local-planner-ab-design.md` (approved 2026-07-25). Issue: #240.

**Revision 3 (2026-07-25).** Revision 2 was reviewed a second time by applying its code and running it. That review found a silent stall in exactly the condition Stage 2 creates (a local model that ANSWERS but returns plans that fail validation), a guard no ablation could redden, a complexity receipt written backwards, and Task 2/3 command lines that do not match the real eval CLI. Everything below has been applied verbatim in a throwaway worktree at `381b0c6` and measured: `bun test` 1451 pass / 1 skip / 0 fail, `tsc --noEmit` clean, all nine ablations observed RED with typecheck clean on every ablated tree. Three design changes came out of it, recorded here and not in the spec:

1. `src/planner/openai-compat.ts` gains a request timeout. Its fetch carried no `AbortSignal`, so probing a sleeping endpoint blocked the whole tick. Fixing that producer let `ENDPOINT_RETRY_REPLANS` drop from 5 to 3.
2. The retry window is counted in **replans**, not milliseconds. See "Why replans and not a wall clock".
3. The spec's fourth test ("a reverted experiment outranks endpoint recovery") is deleted because it is unfalsifiable, NOT because the invariant it names is absent. See "The ordering test cannot fail, but the invariant is real".

## Global Constraints

- Tests are offline: fake server, mocked planner, zero live-game traffic, zero LLM tokens. `bun test && bun run typecheck` must pass before any commit claiming a task done.
- Main is protected. Every change lands via a PR from a branch; merge with `gh pr merge --delete-branch` after review. Never chain a state-changing `gh` command with a dependent follow-up in one shell call.
- Commits carry the user's identity only. No AI co-author trailer, no "Generated with" footer, in commits or PR bodies.
- The repo is PUBLIC. No LAN addresses, host names, or user-home paths in any committed file. Use role words and placeholders; concrete values go in `secrets/` or stay out of git. (Three prior leaks: `d0c09eb`, `3ed92e8`, `d2d5e05`. Issue #524 tracks the gate.)
- A test counts only after you delete the guard it protects and watch it go red — and `bun test` does NOT typecheck, so an ablation naming a field that does not exist silently no-ops and reports GREEN. Typecheck every ablated tree before believing any red or green. `toEqual` ignores `undefined` array entries; prefer `toStrictEqual` on arrays whose failure mode is a dropped element.
- `ENDPOINT_DOWN_THRESHOLD = 2` is the spec's pre-committed value. `ENDPOINT_RETRY_REPLANS = 3` replaces the spec's `ENDPOINT_RETRY_MS = 10 * 60_000`, for the reasons given in Task 1. Do not tune either to make a test pass.
- Stage 1 margins are pre-committed and must not be revised after seeing a local-model number: no signal-carrying scorer regresses more than 15 points; `scoreGoalDiversity` does not regress at all; no scorer passes on abstentions alone; zero unparseable responses.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/planner/openai-compat.ts` | The LM Studio seam | Modify: one exported constant, one option, an `AbortSignal` on the fetch, the body read moved inside the transient classification |
| `src/agent/agent.ts` | Agent loop, planner selection, failure classification | Modify: one private field, two constants, `activePlanner()` branch, per-replan decrement, `handlePlannerFailure` signature + any-class re-arm + transient arm, primary-success recovery |
| `test/planner-openai-compat.test.ts` | Planner wire behavior | Modify: one new test appended |
| `test/agent-failure-classes.test.ts` | Planner failure classification behaviors | Modify: eight new tests appended |
| `src/server/dashboard.html` | Event-feed colour mapping | Modify: two new event types classified |
| `docs/decisions.md` | Decision log | Append one entry in Task 1, one at the end of Stage 1 |
| `docs/superpowers/specs/2026-07-12-improv-mode.md` | Improv-mode briefing | Append one line in Task 1 |
| `docs/eval/2026-07-25-planner-baseline.md` | Stage 0 + Stage 1 result tables, committed as the reference point | Create |
| `agents.yaml` (gitignored, on the pilot host) | Live pilot config | Read at Stage 0 (for the incumbent's model id); modify at Stage 2 only |

Note what is NOT in this table. `PlannerHealth`, `snapshot()`, `test/agent-snapshot.test.ts` and `test/server.test.ts` were all on revision 2's list and are gone: see "Why the countdown stays off the snapshot".

---

## Task 1: Reversible endpoint fallback

**Files:**
- Modify: `src/planner/openai-compat.ts`. Anchors in the unmodified file: `OpenAiCompatOptions` at 14-23; the fetch call at 46-67; the body read at 80.
- Modify: `src/agent/agent.ts`. Anchors in the unmodified file: constants near 135; field block near 375; `activePlanner()` at 1604-1612; `const planner = this.activePlanner()` at 1659; success-path reset block at 1915-1920 and its `catch` at 1922; `handlePlannerFailure` at 2536, whose `TransientPlannerError` branch runs 2554-2569 with the insertion point between the `planner_transient_error` emit (2561-2563) and the stall check (2564).
- Modify: `test/agent-failure-classes.test.ts`, `test/planner-openai-compat.test.ts`, `src/server/dashboard.html`, `docs/decisions.md`, `docs/superpowers/specs/2026-07-12-improv-mode.md`.

**Interfaces:**
- Consumes: existing `TransientPlannerError` (`src/planner/errors`), existing private fields `consecutiveTransientFailures`, `plannerBackoffUntil`, `experimentReverted`, `claudeDisabled`, `usingFallback`, `fallbackPlanner`, `planner`.
- Produces: exported `OPENAI_COMPAT_TIMEOUT_MS` and an optional `timeoutMs` on `OpenAiCompatOptions`. Private field `endpointDownReplans: number` on `Agent`, exposed nowhere. `handlePlannerFailure` gains a second parameter `served?: Planner`. Two new event types emitted through the existing `this.emit(type, payload)` seam: `planner_endpoint_down` with `{ consecutiveFailures: number, retryReplans: number }`, and `planner_endpoint_recovered` with `{}`. No exported signature on `Agent` changes.

### Design notes the implementer must not re-derive

Read these before writing code. Each is a trap a straightforward implementation falls into, and each was confirmed by running the code rather than by reading it.

**Fix the producer: the request had no timeout.** `openai-compat.ts` issued its fetch with no `AbortSignal`, so a probe of an endpoint that is not listening waits out the OS TCP connect timeout (Linux `tcp_syn_retries = 6`, roughly 127 seconds to a silent host) and `runOnce()` executes no plan step for that whole tick. Worse than that measured case: an endpoint that ACCEPTS the connection and never answers — a wedged model server — has no OS timeout at all, and the request hangs forever. The spec's own probe of the production condition ("TCP 1234 from the container: TIMEOUT", spec line 29) is the first shape; the second is what the ablation of this fix actually produced, which hung the test runner rather than failing it. Sizing `ENDPOINT_RETRY_REPLANS` up to avoid the stall would have been guarding the consumer: the constant would have been paying for a missing timeout on a call two files away. With the timeout in place the probe is cheap, so the constant is free to be small.

**Why 60s, and how to check it.** Receipt, mirroring the shape of `USAGE_FETCH_TIMEOUT_MS` in `src/scheduler/usage-poll.ts` (the project's other reachability-sensitive fetch): far above the workload's normal latency, far below the thing it must not stall. The workload is one JSON plan completion; the thing not to stall is the tick. 60s is UNCONFIRMED against a real local generation — no plan has been timed on `gemma-4-12b-qat` yet — so Task 3 Step 6 records wall-clock seconds per plan and Step 7 checks it against this constant. If the measured slowest plan is within 2x of 60s, raise the constant and record the measurement as the new receipt. Do not raise it on a hunch.

**Why the body read moved inside the classification.** `await res.json()` sat outside the `try` that converts infrastructure failures to `TransientPlannerError`. The timeout signal aborts a body read as well as a connect, so leaving it outside would have created a new failure path: an abort mid-body escapes as a plain `Error`, lands in `handlePlannerFailure`'s catch-all, and never arms the endpoint-down state — reintroducing the stall the timeout exists to remove. Model QUALITY still fails through `tryParsePlan` on the response CONTENT, which this does not touch.

**Why a new field and not the existing counter.** The success path at `agent.ts:1918` resets `consecutiveTransientFailures = 0` after ANY successful plan, including one served by the fallback. If "endpoint is down" were derived from that counter, the first fallback success would clear it, the next replan would return to the dead primary, and the pilot would flap between planners every cycle. `endpointDownReplans` is therefore its own field, cleared only by a PRIMARY success. The reviewer built the smaller boolean design instead and measured it incorrect: under a dual outage it locked the primary out permanently. The counter stays.

**Why replans and not a wall clock.** The reviewed draft used `endpointDownUntil = now + 10 * 60_000`. That window is SHORTER than the configured replan cadence (`heartbeat_minutes: 15` in production), so it had already expired by the time the next replan arrived: measured over 20 heartbeat-spaced ticks, the fallback was called 0 times and `planner_endpoint_down` fired 16 times. Production survives only because its 10-second tick loop collapses the effective cadence, which is an accident, not a design. Counting in replans makes the behaviour independent of tick rate and of `heartbeat_minutes`, and it bounds the waste in the unit that costs money. **Rejected alternative:** raise `ENDPOINT_RETRY_MS` above the maximum inter-replan gap. Rejected because it re-couples a constant to a config value that can change without anyone re-deriving it — the same bug, one size larger.

**Why 3 and not 5.** A larger N buys nothing and costs money. Measured against a permanently dead primary, N=3 spends 15 paid fallback calls per 24 replans and wastes 2 paid plans between the primary coming back and the probe noticing; N=5 wasted 4. The only argument for a large N was that each probe cost a blocking stall, and the timeout above dissolves it. 3 is the smallest value that still leaves a fallback-served window: 2 fallback replans, then a probe.

**Why the fallback serves while the counter is `> 1`, not `> 0`.** The counter has to reach a state where the primary is attempted again AND the code still knows it was down, because that is the only moment a primary success can emit `planner_endpoint_recovered`. If the fallback served whenever the counter was above zero, the counter would hit 0 on its own and the following primary success would see a cleared field — the recovery event could never fire. So `endpointDownReplans === 1` is the probe replan: still officially down, primary attempted.

**What 0 means, and what it does not.** 0 means the state is not armed. It does NOT mean "the primary is healthy" — revision 2's comment said that and it is falsifiable. A `TokenInvalidError` or `SubscriptionLimitError` latch flips `claudeDisabled` / `usingFallback`, `activePlanner()` returns the fallback from its own earlier branch, and the decrement drains the countdown to 0 with no probe and no recovery event. Nothing is broken by that (those latches are themselves the verdict on the primary), but a comment claiming the field is a health oracle would send the next reader looking for a bug that is not there. Write what is true.

**Any primary failure on the probe replan re-arms — whatever its class.** This is the defect the second review found by running the code. Only the transient branch touches `consecutiveTransientFailures`, so a primary that ANSWERS but returns plans failing validation twice lands in the catch-all class, which used to leave the countdown parked at 1 forever: the primary is served every replan, fails every replan, the fallback is never reached again, and the pilot silently stops planning while still answering endpoint checks. That is precisely the marginal-local-model case Stage 2 creates. Measured with the re-arm removed: **0 plan events across the final 10 replans**. The guard is one condition at the TOP of `handlePlannerFailure`, above the class dispatch, so the early-returning branches are covered too. Re-arm rather than clear: a failed probe disproves "healthy", and clearing would assert the opposite. Reaching 1 at all required a `fallbackPlanner`, so no extra existence check is needed.

**Re-entry costs one failure, not two.** Revision 2 said two, because the fallback's successes reset `consecutiveTransientFailures` and the transient arming block needs 2. That block is no longer the re-arm path — the any-class guard above is, and it fires on the first probe failure. Consequence, measured: the steady-state cycle against a dead primary is 3 replans (two served by the fallback, one failed probe) rather than 4, so the pilot loses one planless replan per cycle instead of two and pays 2 subscription calls per 3 replans.

**`ENDPOINT_DOWN_THRESHOLD = 2` does not mean "two primary failures".** `consecutiveTransientFailures` is shared across both planners; the fallback's failures raise it too. The reviewer observed a single primary probe failure arming the down state because the fallback's own failures had already driven the counter to 6. Do not add a per-planner counter to "fix" this — state it honestly instead. The consequence is that the down state can arm eagerly during a dual outage, which is harmless: the fallback is already the served planner in that window and the probe replan re-tests the primary either way. `served === this.planner` is the guard that matters, and it is what keeps a fallback-ONLY blip from arming the state at all.

**Where the decrement goes, and why.** In `replan()`, immediately after the `if (!planner)` guard at 1659-1663, gated on `planner === this.fallbackPlanner`. That is the only site in the loop that commits a replan to a planner, so the countdown advances exactly once per replan the fallback actually served. Ticks that never reach a replan — backoff suppression, a running plan executing a step, no wake — must not consume the window, and this placement is what makes that true. It was verified by trace: across a 16-tick run the counter held steady through ticks that executed a plan step instead of replanning. Decrementing on the fallback's SUCCESS instead would strand the counter forever whenever the fallback is also failing.

**Why `handlePlannerFailure` needs to know which planner failed.** Without the `served` parameter, a transient failure of the FALLBACK arms the down-state, emits an event naming the primary endpoint, and locks out a primary that may be perfectly healthy. Passing the already-captured `planner` local from `replan()` and gating on `served === this.planner` fixes the mis-attribution at the producer. It also subsumes a second defect: the draft's `if (!wasDown)` emit guard was unreachable in the primary-failure path, whereas `if (this.endpointDownReplans === 0)` is an exact "not currently down" test and is ablatable — though only by the dual-outage test, which is the sole scenario that re-enters the arming block with the countdown already armed. Revision 2 shipped that guard with no test that could redden it.

**Why the countdown stays off the snapshot.** Revision 2 added `endpointDownReplans` to the exported `PlannerHealth` interface and to `snapshot()`, which forced edits to `test/agent-snapshot.test.ts` and `test/server.test.ts`. One of those tests is named "exposes only fields with a dashboard consumer" and its whole job is to fail when a field is added without one — and the dashboard change in this task is an event-feed colour map, not a reader of the countdown. `usingFallback` already tells the operator which planner is serving, which is the question the A/B asks. The field is private; nothing outside `agent.ts` reads it; those two test files are untouched.

**Do not touch the backoff gate at line 976.** It returns early before any planner call, so the fallback engages one backoff interval (60s after failure #2) later than the threshold alone suggests. That is acceptable against a replan cadence measured in minutes, and the first fallback success sets `plannerBackoffUntil = 0` at line 1919, so it self-clears. The spec flagged this interaction for verification; this is the verification, and the answer is that no change is needed.

**The ordering test cannot fail, but the invariant is real.** The spec calls its fourth test "the one that protects a real invariant", and the invariant IS real: a reverted experiment stays on the fallback even after the primary answers again. What is not real is the test. It asserted branch ORDER inside `activePlanner()`, and both branches return `this.fallbackPlanner`, so swapping them changes nothing observable — the reorder was applied and the suite stayed green. The invariant is structurally guaranteed (the new branch returns the fallback unconditionally, so it cannot reinstate the primary) and behaviourally covered by `test/experiment-revert.test.ts`. Deleting an unfalsifiable test does not delete the invariant it was pointed at. The branch is still placed after `experimentReverted` and `claudeDisabled`, for readability.

**Out of scope, do not fix.** `agent.ts:1915` emits `planner_recovered` whenever a plan succeeds after any transient failure, including a plan served by the FALLBACK during an ongoing primary outage — visible in the trace as `planner_recovered` firing on the first fallback success. It is pre-existing, it is filed separately, and touching it here would entangle two fixes in one diff.

- [ ] **Step 1: Write the failing tests**

Two files. Paste verbatim — every tick count and assertion below was run against the finished implementation, and the counts depend on `ENDPOINT_RETRY_REPLANS = 3`.

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

  test("two consecutive transient failures route the next replan to the fallback; one does not", async () => {
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

    // Both planners dead. The fallback's failures keep
    // consecutiveTransientFailures above the threshold, so every probe failure
    // re-enters the arming block with the countdown already armed -- the only
    // path that can re-announce. One down event, not one per probe.
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

  test("a reachable primary whose plans fail validation keeps reaching the fallback", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const answersButFails = invalidPlanCounter();
    const fallback = countingPlanner(okPlan);
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: fallback, config, now: () => now,
    });

    // Arm the down state on a dead endpoint, then swap the primary for one that
    // ANSWERS but returns unusable plans -- the marginal-local-model case Stage
    // 2 creates. That failure lands in the catch-all class, which never touches
    // consecutiveTransientFailures, so without the any-class re-arm the counter
    // parks at 1: the primary is served every replan, fails every replan, and
    // the fallback is never reached again.
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
});
```

Note what is deliberately absent. No test uses an `experiment` config, so none of them needs `stubApi({ stats: { missions_completed: 1 } })`. If a later change adds one that does: `stubApi` builds a `StatusSnapshot` with no `stats`, so `progressCountersTotal(undefined)` returns null, the experiment fail-safe re-seeds every tick and the latch never fires. Such a test must pass `api: stubApi({ stats: { missions_completed: 1 } })` and use `withinHours: 1`, never `0`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/agent-failure-classes.test.ts test/planner-openai-compat.test.ts
```

Expected: the new tests fail. The first agent test fails on `expect(fallback.calls).toBe(1)` receiving `0`, because nothing yet routes a down endpoint to the fallback. The planner test fails on the watchdog, because nothing yet aborts the hung request.

- [ ] **Step 3: Give the openai-compat request a timeout**

In `src/planner/openai-compat.ts`, add to `OpenAiCompatOptions` after `fetchImpl`:

```ts
  timeoutMs?: number; // default OPENAI_COMPAT_TIMEOUT_MS; small values are for tests
}

// 60s per request. Receipt, same shape as USAGE_FETCH_TIMEOUT_MS in
// scheduler/usage-poll.ts: far above the workload's normal latency (one JSON
// plan completion) and far below the thing it must not stall -- fetch with no
// signal waits out the OS TCP connect timeout (Linux tcp_syn_retries=6, ~127s
// to a silent host), which is exactly the sleeping-workstation case #240
// exists for. Without it a probe of a dead endpoint eats the whole tick and
// the agent executes no plan step.
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
// #240. Two consecutive transient failures against a LAN endpoint on a
// multi-minute replan cadence means the listener is gone, not busy; one
// failure is a blip the exponential backoff above already absorbs.
const ENDPOINT_DOWN_THRESHOLD = 2;
// How many REPLANS the fallback serves before the primary is probed again.
// Counted in replans, not milliseconds: a wall-clock window has to be longer
// than the largest inter-replan gap to survive one replan, and heartbeat_minutes
// is config the constant cannot see. 3 = two fallback-served replans plus a
// probe; the probe fails fast because openai-compat.ts carries a request
// timeout, so nothing here is sized to hide a blocking call.
const ENDPOINT_RETRY_REPLANS = 3;
```

- [ ] **Step 5: Add the field**

Next to `private plannerBackoffUntil = 0;` at line 375. Private, and it stays private:

```ts
  // #240. Countdown in REPLANS, not a timestamp and not a boolean. Cleared
  // ONLY by a primary success; re-armed by any primary failure on the probe
  // replan. 0 means the state is not armed -- NOT that the primary is known
  // healthy (a TokenInvalid/SubscriptionLimit latch drives it to 0 with no
  // probe), which is why activePlanner() also consults claudeDisabled and
  // usingFallback.
  private endpointDownReplans = 0;
```

- [ ] **Step 6: Re-arm on any primary failure, then arm on the transient branch**

`handlePlannerFailure` at 2536 gains a second parameter, and the any-class re-arm goes at the top of the body, ABOVE the class dispatch, so the early-returning branches are covered:

```ts
  private handlePlannerFailure(e: unknown, served?: Planner): void {
    // #240. ANY failure of the PRIMARY on the probe replan re-arms the
    // countdown, whatever the error class. Only the transient branch below
    // increments consecutiveTransientFailures, so a plan that fails validation
    // twice (the catch-all class) would otherwise park the counter at 1
    // forever: the primary is served every replan, fails every replan, the
    // fallback is never reached, and the pilot silently stops planning while
    // answering endpoint checks. Re-arm rather than clear -- a failed probe
    // disproves "healthy", and clearing would assert it. The down emit below is
    // gated on `=== 0`, so a re-arm never re-announces. Reaching 1 at all
    // required a fallbackPlanner, so no extra guard is needed here.
    if (served === this.planner && this.endpointDownReplans === 1) {
      this.endpointDownReplans = ENDPOINT_RETRY_REPLANS;
    }
```

Its one call site, in `replan()`'s `catch` at line 1922, passes the planner that actually served:

```ts
      this.handlePlannerFailure(e, planner);
```

Inside the `TransientPlannerError` branch, between the `planner_transient_error` emit (ending line 2563) and the stall check (line 2564):

```ts
      // #240. consecutiveTransientFailures is SHARED across both planners: the
      // fallback's failures raise it too, so this threshold does not mean "two
      // primary failures". During a dual outage a single primary failure can
      // arm the down state on a counter the fallback drove up. Harmless -- the
      // fallback is already the served planner in that window, and the probe
      // replan re-tests the primary either way. `served === this.planner` is
      // what keeps a fallback-ONLY blip from arming it at all.
      if (this.fallbackPlanner && served === this.planner
          && this.consecutiveTransientFailures >= ENDPOINT_DOWN_THRESHOLD) {
        if (this.endpointDownReplans === 0) {
          this.emit("planner_endpoint_down", {
            consecutiveFailures: this.consecutiveTransientFailures,
            retryReplans: ENDPOINT_RETRY_REPLANS,
          });
        }
        this.endpointDownReplans = ENDPOINT_RETRY_REPLANS;
      }
```

- [ ] **Step 7: Serve the fallback from `activePlanner()`**

In `activePlanner()` at line 1604, after the `claudeDisabled` branch and before the `usingFallback` branch:

```ts
    // #240. Endpoint unreachable: serve the fallback until the countdown
    // reaches its last replan, then probe the primary (the replan IS the
    // health check -- no probe endpoint, no watchdog).
    if (this.fallbackPlanner && this.endpointDownReplans > 1) return this.fallbackPlanner;
```

- [ ] **Step 8: Decrement once per fallback-served replan**

In `replan()`, immediately after the `if (!planner) { ... return; }` guard that ends at line 1663:

```ts
    // #240. One decrement per REPLAN the fallback actually serves. Placed here
    // because this is the only site that commits a replan to a planner: ticks
    // that never reach a replan must not consume the countdown.
    if (this.endpointDownReplans > 0 && planner === this.fallbackPlanner) this.endpointDownReplans--;
```

- [ ] **Step 9: Clear it on a primary success**

In the success path, immediately before the existing `this.consecutiveTransientFailures = 0;` at line 1918. `planner` is the local captured at line 1659, so identity tells you which planner served this plan:

```ts
      // #240. Only a PRIMARY success ends the endpoint-down state. `planner` is
      // the local captured above, so identity says which planner served this
      // plan; a fallback success must not clear it or the pilot would flap back
      // to a dead endpoint every cycle.
      if (this.endpointDownReplans > 0 && planner === this.planner) {
        this.endpointDownReplans = 0;
        this.emit("planner_endpoint_recovered", {});
      }
```

The `this.endpointDownReplans > 0 &&` half is not redundant. Without it, every primary success emits `planner_endpoint_recovered`, including the routine ones when nothing was ever down — ablation 7 turns one event into four.

- [ ] **Step 10: Classify the two new events in the dashboard feed**

`src/server/dashboard.html`'s `eventDotClass` (near line 1236) has no mapping for either new type, and neither matches its `/error|fail|stalled|backoff|alert|limit/` catch-all, so both would render as generic cyan in the feed Task 4 Step 6 tells the operator to watch. After the `plan`/`planner_recovered` line:

```js
    // #240 planner failover: down is a degradation (red), recovered is a return
    // to the cheap primary (green). Neither matches the generic regex below.
    if (t === "planner_endpoint_down") return "red";
    if (t === "planner_endpoint_recovered") return "green";
```

- [ ] **Step 11: Run the tests to verify they pass**

```bash
bun test test/agent-failure-classes.test.ts test/planner-openai-compat.test.ts && bun run typecheck
```

Expected: all pass, typecheck clean.

- [ ] **Step 12: Ablate each guard**

Not optional, and not satisfied by reading the code. For each: apply the ablation ALONE, run `bun run typecheck` FIRST, then `bun test test/agent-failure-classes.test.ts test/planner-openai-compat.test.ts`, confirm the expected tests go RED, restore before starting the next one. Typecheck first because `bun test` does not typecheck, so an ablation that names a field which no longer exists silently no-ops and reports GREEN — the ablation, not the guard, is what passed. This is the third occasion in one day where a count-blind or undefined-blind matcher hid a real defect (`toEqual` skipping `undefined` array entries, a `toContain` that could not distinguish one event from four, and revision 2's emit gate, which no test in the file could redden), which is why every row below names the assertion that moves, not just the test.

Results observed on the finished implementation:

| # | Ablation | Observed RED |
|---|---|---|
| 1 | Delete the `activePlanner()` branch (Step 7) | tests 1, 4, 5, 8 (4 fail) |
| 2 | Replace the `if (this.endpointDownReplans === 0)` emit gate with `if (true)` (Step 6) | test 3, the dual outage — and ONLY that test |
| 3 | Drop `&& planner === this.planner` from the recovery clear (Step 9) | tests 2, 4, 5, 8 (4 fail) |
| 4 | Drop `served === this.planner` from the arming condition (Step 6) | tests 3, 6 |
| 5 | Drop `this.fallbackPlanner &&` from the arming condition (Step 6) | test 7 |
| 6 | Delete the per-replan decrement (Step 8) | tests 3, 4, 6, 8 (4 fail) |
| 7 | Drop `this.endpointDownReplans > 0 &&` from the recovery clear (Step 9) | test 4, on the recovered-event count: expected 1, received 4 |
| 8 | Delete the any-class re-arm (Step 6) | test 8, on the late-window plan count: expected > 0, received 0 |
| 9 | Delete the `signal:` line (Step 3) | the planner timeout test, on the watchdog at 1s |

Ablation 7 is the one revision 2 had no test for, and ablation 2 is the one whose test had to be written specially: the dual outage is the only scenario that re-enters the arming block with the countdown already armed, so it is the only thing that can redden that gate. A guard no ablation can redden is not tested. If any ablation leaves the suite GREEN, either the test is decorative or the ablation silently no-opped — verify the edit landed and the tree typechecks, then rewrite the test so it bites and say so in the completion report.

- [ ] **Step 13: Run the full suite**

```bash
bun test && bun run typecheck
```

Expected: 1451 pass, 1 skip, 0 fail (`381b0c6` plus this change), typecheck clean. No existing test file is modified: `test/agent-snapshot.test.ts` and `test/server.test.ts` are untouched because the countdown never reaches `snapshot()`, and `test/agent-observability.test.ts` and `test/experiment-revert.test.ts` are unaffected.

- [ ] **Step 14: Append the decision-log entry**

`docs/decisions.md`, following the enforced shape: one-paragraph context, `**Options.**` as terse one-line bullets each naming the option, its tradeoff and the verdict, then a one-paragraph `**Decision.**`. Hard cap 400 words, enforced by `test/doc-size.test.ts`; 200-300 is typical. Written for an infrastructure engineer, not a developer.

The options genuinely on the table, all rejected for reasons that belong in the log: reusing `usingFallback` (a one-way latch, never reset — the first overnight sleep would move the pilot to the subscription permanently); a boolean instead of a counter (built and measured by a reviewer: under a dual outage it locked the primary out permanently); a health-probe endpoint (an extra call every cycle when the replan is itself the probe); a separate watchdog task (a new lifecycle to own); deriving the state from `consecutiveTransientFailures` alone (the success path resets it for a fallback success too, so the pilot would flap every cycle). Include the wall-clock-versus-replan-count choice and why the millisecond window failed (shorter than the configured replan cadence, so it expired before it could ever be read), and the timeout: the retry constant was originally sized to avoid a stall caused by a missing `AbortSignal` two files away, and fixing the fetch let the constant shrink from 5 to 3.

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
        docs/decisions.md docs/superpowers/specs/2026-07-12-improv-mode.md
git commit -m "feat(240): reversible fallback when the planner endpoint is unreachable

An unreachable planner endpoint made the agent back off and eventually stall
rather than plan with its configured fallback. Every existing fallback trigger
is subscription-shaped (bad token, exhausted quota, no-progress latch), so a
sleeping workstation left the pilot doing nothing until the box woke or the
12-hour experiment latch fired.

Options considered. Reusing usingFallback: rejected, it is a one-way latch
assigned in exactly one place and never reset, so the first overnight sleep
would move the pilot to the subscription permanently and destroy the saving
this change exists to capture. A boolean instead of a counter: built and
measured, rejected, because a dual outage locked the primary out permanently.
A health-probe endpoint: rejected, an extra call every cycle when the replan
attempt is itself the probe. A separate watchdog task: rejected, a new
lifecycle to own for a condition the existing consecutive-failure counter
already expresses. Deriving the state from that counter alone: rejected, the
success path resets it for a fallback success too, so the pilot would flap
between planners every cycle. A millisecond retry window: rejected after
measurement, because any constant shorter than heartbeat_minutes expires
before the next replan reads it, and any constant longer is coupled to a
config value nobody re-derives when it changes.

Adds a request timeout to openai-compat, one private field and two constants to
the agent. The fetch had no AbortSignal, so probing a sleeping endpoint blocked
the tick for the OS connect timeout; fixing that producer let the retry window
shrink from 5 replans to 3. endpointDownReplans counts replans, not
milliseconds, so the behaviour is independent of tick rate and heartbeat
config; the last replan of the countdown probes the primary, and the replan is
the health check. Cleared only by a primary success, re-armed by a primary
failure of any class, so a model that answers with unusable plans cannot park
the pilot on a planner that never produces one. handlePlannerFailure now takes
the planner that served, so a fallback blip is not blamed on the primary.

Closes part of #240."
git push -u origin feat/240-endpoint-fallback
```

Then open the PR (separate call, do not chain):

```bash
gh pr create --title "feat(240): reversible fallback when the planner endpoint is unreachable" --body "<summary + the eight behaviors + the nine ablation results>"
```

---

## Task 2: Stage 0, baseline the incumbent

**Files:**
- Create: `docs/eval/2026-07-25-planner-baseline.md`
- Read only: `src/eval/run.ts`, `src/eval/harvest.ts`, `src/server/usage.ts`, `test/fixtures/eval-cases.json`

**Interfaces:**
- Consumes: the CLI surface of `src/eval/run.ts` (read at Step 2 before any invocation).
- Produces: `docs/eval/2026-07-25-planner-baseline.md` containing a per-scorer table with columns `scorer | incumbent pass rate | n scored | n abstained`, plus the run-level COST line. Task 3 appends a second table to this same file.

**Read this before running anything.** `src/eval/run.ts:221-222` exits non-zero whenever `overall < 1` or the thrash check fails. A real planner will not score 100%, so a NON-ZERO EXIT IS THE EXPECTED OUTCOME at Stage 0 and is not a broken run. Never chain these invocations with `&&`; capture the printed report.

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

The invocations below were written against `src/eval/run.ts:166-223` at `381b0c6` and are correct as of that commit. Re-read the USAGE block anyway and reconcile: the flag is `--provider`, not `--planner`; there is no `--db` and no `--limit`; and harvesting is a SEPARATE invocation that writes a JSON file and exits.

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

`recentEventsByType` (`src/store/store.ts:102-109`) returns the newest rows re-sorted oldest-first, so `slice(-25)` is the 25 MOST RECENT decision points. If the harvest returns fewer than 25, that is the real N: record the actual number in the baseline document and use the same file for Stage 1 rather than topping it up from an older window.

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

There is nothing to wire: `src/eval/run.ts:3` already imports `estimateCostUsd` and `:109` already applies it per case. (Revision 2 named `src/cost/usage.ts`, which does not exist; the module is `src/server/usage.ts`.)

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

`OPENAI_COMPAT_TIMEOUT_MS` is 60s and its headroom was UNCONFIRMED when Task 1 shipped — no plan had been timed on this model. Compare the slowest plan from Step 6. Within 2x of 60s, raise the constant in a follow-up PR and record the measurement as its new receipt. Comfortably under, say so in the baseline document and the assumption is retired. A timeout that fires on a legitimately slow local generation would show up as transient planner failures and a fallback that never hands back.

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

From the event store, for the 24 hours before the swap: plans/hour, `plan_budget_exceeded` count, credits earned, missions completed, ore mined, systems visited, and blocked-action classes by count. Known reference point: roughly 10-12 plans/hr with 6 `plan_budget_exceeded` in the hour before the #517 merge.

- [ ] **Step 5: Apply the config**

```yaml
planner: { provider: openai-compat, model: google/gemma-4-12b-qat, base_url: "http://<workstation-lan-ip>:1234" }
fallback_planner: { provider: claude-subscription, model: <production-model-id> }
experiment: { revert_if_no: any, within_hours: 12 }
```

Use the same priced model id Task 2 Step 5 read, so the fallback's spend lands in the same price bucket the baseline used. Back up the existing `agents.yaml` first. Restart the container and confirm it comes up healthy.

- [ ] **Step 6: Observe, then compare**

Let the window run. Compare against Step 4 on the same measures. `experiment:` is the deterministic exit; if it reverts, that IS the result and it is not overridden by judgment.

Watch for `planner_endpoint_down` and `planner_endpoint_recovered` in the feed: they are the evidence that Task 1 works in production, which no offline test can provide. Both now carry an explicit feed colour (Task 1 Step 10) — red for down, green for recovered — so they are visible without reading payloads. A `planner_endpoint_down` with no matching `planner_endpoint_recovered` and a plan rate that keeps up is the fallback doing its job; a plan rate that drops to zero is not, and is worth an immediate revert.

- [ ] **Step 7: Write the window document and the lesson**

Create `docs/eval/2026-07-25-stage2-window.md` with both windows side by side. Append a lesson to `docs/wiki/engineering-lessons.md` if the merge taught something transferable (concrete incident, principle, discipline, why).

Separate KNOWN from UNPROVEN. "Removes the pilot's quota draw" stays a hypothesis until subscription spend attributable to the pilot is measured before and after, and it is only valid for hours the workstation was actually awake.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: "the one real code change" to Task 1; Stage 0 to Task 2; Stage 1 including both case sources and all four pass conditions to Task 3; Stage 2 including the config block and the rejected-second-pilot rationale to Task 4; the prerequisites to Task 4 Step 1; the testing section's behaviors to Task 1 Step 1 with the ablations at Step 12. The spec's "interaction to verify, not assume" is resolved in Task 1's design notes with a stated answer (do not touch the backoff gate).

**Three deliberate departures from the spec, all flagged for the operator.** The spec's `ENDPOINT_RETRY_MS = 10 * 60_000` is replaced by `ENDPOINT_RETRY_REPLANS = 3`, because the millisecond window was shorter than the configured replan cadence and expired before it could be read — measured, not argued. The spec does not mention a request timeout on `openai-compat.ts`; one is added, because without it the retry constant is sized to hide a blocking call in another file. And the spec's fourth test, which it describes as "the one that protects a real invariant", is deleted as UNFALSIFIABLE: both branches return the same object, so the ordering it asserts is not observable and the reorder left the suite green. The invariant itself is real, structurally guaranteed, and covered by `test/experiment-revert.test.ts` — deleting the test does not delete it. Neither the spec nor the code on `main` is edited by this plan.

**Placeholder scan.** No TBDs. Two placeholders are intentional: `<workstation-lan-ip>`, because the real value must not enter the public repo, and `<agent-id>` / `<production-model-id>`, which Task 2 Steps 3 and 5 instruct the implementer to read from the snapshot DB and the pilot's config rather than guess.

**Type consistency.** `endpointDownReplans` is spelled identically in Steps 5, 6, 7, 8, 9 and in the ablation table. It appears in no interface and no test file, because it is private. `ENDPOINT_DOWN_THRESHOLD` matches the spec's committed value; `ENDPOINT_RETRY_REPLANS` is the replacement named above. `planner_endpoint_down` and `planner_endpoint_recovered` match the spec's event names and are used consistently in the tests, the implementation steps, the dashboard mapping, and the ablation table. The `retryMs` payload key becomes `retryReplans`, matching the unit change; nothing reads the old key.

**Persisted-state schema tolerance does not apply.** The project's binding rule covers artifacts that outlive the schema that wrote them. `snapshot()` is computed live at `src/server/server.ts:298` and never persisted, and the new field is not in it anyway.

**Verification status of this plan.** Task 1 was applied verbatim in a throwaway worktree at `381b0c6`: full suite 1451 pass / 1 skip / 0 fail, `tsc --noEmit` clean, and all nine ablations in Step 12 observed RED with exactly the tests listed and a clean typecheck on every ablated tree. Measured on that tree: 15 paid fallback calls per 24 replans against a permanently dead primary, 2 paid plans wasted between the primary recovering and the probe noticing, and 0 plan events across the final 10 replans when the any-class re-arm is removed and the primary answers with plans that fail validation. Tasks 2, 3 and 4 are unverified by construction — they need the production DB, real quota, and the operator's workstation, none of which an offline check can stand in for. Their command lines were reconciled against `src/eval/run.ts:166-223`, `src/eval/harvest.ts:20`, `src/store/store.ts:102-109` and `src/server/usage.ts:69-87` at `381b0c6`, which is a stronger claim than revision 2's ("the expected shape, not verified syntax") but is still not a claim that they have been run.
