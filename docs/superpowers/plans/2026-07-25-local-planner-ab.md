# Local Planner A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, on measured evidence, whether `google/gemma-4-12b-qat` on LM Studio can replace the Claude subscription as the pilot's planner, and close the one code gap that only bites once a local endpoint is in the path.

**Architecture:** Three gated stages. Stage 0 measures the incumbent planner on recorded decision points, producing the bar. Stage 1 runs the identical cases through the local model and compares against pre-committed margins. Stage 2 swaps the live pilot's planner behind the existing deterministic `experiment:` revert. Task 1 (the code change) is independent of the stages and lands first, because a local endpoint that sleeps must degrade to the fallback instead of stalling the pilot.

**Tech Stack:** Bun ≥ 1.2.21, TypeScript, Zod, `bun:sqlite`, existing `src/eval/*` harness, existing `src/planner/openai-compat.ts`.

**Source spec:** `docs/superpowers/specs/2026-07-25-local-planner-ab-design.md` (approved 2026-07-25). Issue: #240.

**Revision 2 (2026-07-25).** The first revision of Task 1 was reviewed by applying its code and tests in a throwaway worktree and running every ablation. It did not typecheck, four of its five tests failed against its own implementation, and one was unsatisfiable at any constant. Task 1 below is rewritten; Tasks 2-4 were reviewed as sound and change only by gaining a cost-per-plan column. Everything in Task 1 has now been applied verbatim in a throwaway worktree: `bun test` 1448 pass / 0 fail, `bun run typecheck` clean, all six ablations observed RED. Two substantive design changes came out of that review and are recorded here rather than in the spec:

1. The retry window is counted in **replans**, not milliseconds. See "Why replans and not a wall clock" below.
2. The spec's fourth test ("a reverted experiment outranks endpoint recovery") is deleted. It claimed an invariant that does not exist; see "There is no ordering test to write". The spec still calls that test "the one that protects a real invariant" — **that spec claim is wrong and is flagged for the operator.** The spec is not edited by this plan.

## Global Constraints

- Tests are offline: fake server, mocked planner, zero live-game traffic, zero LLM tokens. `bun test && bun run typecheck` must pass before any commit claiming a task done.
- Main is protected. Every change lands via a PR from a branch; merge with `gh pr merge --delete-branch` after review. Never chain a state-changing `gh` command with a dependent follow-up in one shell call.
- Commits carry the user's identity only. No AI co-author trailer, no "Generated with" footer, in commits or PR bodies.
- The repo is PUBLIC. No LAN addresses, host names, or user-home paths in any committed file. Use role words and placeholders; concrete values go in `secrets/` or stay out of git. (Three prior leaks: `d0c09eb`, `3ed92e8`, `d2d5e05`. Issue #524 tracks the gate.)
- A test counts only after you delete the guard it protects and watch it go red. `toEqual` ignores `undefined` array entries; prefer `toStrictEqual` on arrays whose failure mode is a dropped element.
- `ENDPOINT_DOWN_THRESHOLD = 2` is the spec's pre-committed value. `ENDPOINT_RETRY_REPLANS = 5` replaces the spec's `ENDPOINT_RETRY_MS = 10 * 60_000`, for the reason given in Task 1. Do not tune either to make a test pass.
- Stage 1 margins are pre-committed and must not be revised after seeing a local-model number: no signal-carrying scorer regresses more than 15 points; `scoreGoalDiversity` does not regress at all; no scorer passes on abstentions alone; zero unparseable responses.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/agent/agent.ts` | Agent loop, planner selection, failure classification | Modify: `PlannerHealth` interface, one field, two constants, `activePlanner()` branch, per-replan decrement, `handlePlannerFailure` signature + transient arm, primary-success recovery, `snapshot()` |
| `test/agent-failure-classes.test.ts` | Planner failure classification behaviors | Modify: six new tests appended |
| `test/agent-snapshot.test.ts` | Snapshot shape | Modify: two expectations gain the new field (one is a strict key allowlist) |
| `test/server.test.ts` | `/api/agents` payload | Modify: one expectation gains the new field |
| `src/server/dashboard.html` | Event-feed colour mapping | Modify: two new event types classified |
| `docs/decisions.md` | Decision log | Append one entry in Task 1, one at the end of Stage 1 |
| `docs/superpowers/specs/2026-07-12-improv-mode.md` | Improv-mode briefing | Append one line in Task 1 |
| `docs/eval/2026-07-25-planner-baseline.md` | Stage 0 + Stage 1 result tables, committed as the reference point | Create |
| `agents.yaml` (gitignored, on the pilot host) | Live pilot config | Modify at Stage 2 only |

---

## Task 1: Reversible endpoint fallback

**Files:**
- Modify: `src/agent/agent.ts`. Anchors in the unmodified file: `PlannerHealth` at 29-41 (consumed by `snapshot()` at 748-754); constants near 135; field block near 375; `activePlanner()` at 1604-1612; `const planner = this.activePlanner()` at 1659; success-path reset block at 1915-1920 and its `catch` at 1922; `handlePlannerFailure` at 2536, whose `TransientPlannerError` branch runs 2554-2569 with the insertion point between the `planner_transient_error` emit (2561-2563) and the stall check (2564).
- Modify: `test/agent-failure-classes.test.ts`, `test/agent-snapshot.test.ts`, `test/server.test.ts`, `src/server/dashboard.html`, `docs/decisions.md`, `docs/superpowers/specs/2026-07-12-improv-mode.md`.

**Interfaces:**
- Consumes: existing `TransientPlannerError` (`src/planner/errors`), existing private fields `consecutiveTransientFailures`, `plannerBackoffUntil`, `experimentReverted`, `claudeDisabled`, `usingFallback`, `fallbackPlanner`, `planner`.
- Produces: private field `endpointDownReplans: number` (0 = primary healthy), mirrored as a required `endpointDownReplans: number` member of the exported `PlannerHealth` interface. `handlePlannerFailure` gains a second parameter `served?: Planner`. Two new event types emitted through the existing `this.emit(type, payload)` seam: `planner_endpoint_down` with `{ consecutiveFailures: number, retryReplans: number }`, and `planner_endpoint_recovered` with `{}`. No other exported signature changes.

### Design notes the implementer must not re-derive

Read these before writing code. Each is a trap a straightforward implementation falls into, and each was confirmed by running the code rather than by reading it.

**Why a new field and not the existing counter.** The success path at `agent.ts:1918` resets `consecutiveTransientFailures = 0` after ANY successful plan, including one served by the fallback. If "endpoint is down" were derived from that counter, the first fallback success would clear it, the next replan would return to the dead primary, and the pilot would flap between planners every cycle. `endpointDownReplans` is therefore its own field, cleared only by a PRIMARY success.

**Why replans and not a wall clock.** The reviewed draft used `endpointDownUntil = now + 10 * 60_000`. That window is SHORTER than the configured replan cadence (`heartbeat_minutes: 15` in production), so it had already expired by the time the next replan arrived: measured over 20 heartbeat-spaced ticks, the fallback was called 0 times and `planner_endpoint_down` fired 16 times. Production survives only because its 10-second tick loop collapses the effective cadence, which is an accident, not a design. Counting in replans makes the behaviour independent of tick rate and of `heartbeat_minutes`, which is exactly what the wall-clock version got wrong, and it bounds the waste in the unit that costs money: the fallback (the paid subscription) serves at most `ENDPOINT_RETRY_REPLANS - 1` replans between probes of the free local endpoint. **Rejected alternative:** raise `ENDPOINT_RETRY_MS` above the maximum inter-replan gap. Rejected because it re-couples a constant to a config value that can change without anyone re-deriving it — the same bug, one size larger.

**Why the fallback serves while the counter is `> 1`, not `> 0`.** The counter has to reach a state where the primary is attempted again AND the code still knows it was down, because that is the only moment a primary success can emit `planner_endpoint_recovered`. If the fallback served whenever the counter was above zero, the counter would hit 0 on its own and the following primary success would see a field already reading "healthy" — the recovery event could never fire. So `endpointDownReplans === 1` is the probe replan: still officially down, primary attempted. A success there zeroes the field and emits recovery; a failure there leaves it at 1 and the next replan probes again. 0 still means, and only means, "the primary is healthy".

**Where the decrement goes, and why.** In `replan()`, immediately after the `if (!planner)` guard at 1659-1663, gated on `planner === this.fallbackPlanner`. That is the only site in the loop that commits a replan to a planner, so the countdown advances exactly once per replan the fallback actually served. Ticks that never reach a replan — backoff suppression, a running plan executing a step, no wake — must not consume the window, and this placement is what makes that true. It was verified by trace: across a 16-tick run the counter held at 2 through a tick that executed a plan step instead of replanning, then decremented on the next tick that did replan. Decrementing on the fallback's SUCCESS instead would strand the counter forever whenever the fallback is also failing.

**Why `handlePlannerFailure` needs to know which planner failed.** Without the `served` parameter, a transient failure of the FALLBACK arms the down-state, emits an event naming the primary endpoint, and locks out a primary that may be perfectly healthy. Passing the already-captured `planner` local from `replan()` and gating arming on `served === this.planner` fixes the mis-attribution at the producer. It also subsumes a second defect: the draft's `if (!wasDown)` emit guard was unreachable in the primary-failure path (making the emit unconditional left the suite green), whereas `if (this.endpointDownReplans === 0)` is an exact "not currently down" test and is ablatable.

**Why re-entry costs two failures.** While the fallback serves, its successes reset `consecutiveTransientFailures` to 0. So when the probe replan finds the primary still dead, the counter climbs 0 → 1 → 2 across two probe replans before re-arming. The same threshold governs entry and re-entry; do not add a shortcut. The practical cost: with `ENDPOINT_RETRY_REPLANS = 5` the steady-state cycle against a permanently dead endpoint is four fallback-served replans plus two failed probe replans. Re-arming does not re-announce, because the emit is gated on `=== 0`.

**Do not touch the backoff gate at line 976.** It returns early before any planner call, so the fallback engages one backoff interval (60s after failure #2) later than the threshold alone suggests. That is acceptable against a replan cadence measured in minutes, and the first fallback success sets `plannerBackoffUntil = 0` at line 1919, so it self-clears. The spec flagged this interaction for verification; this is the verification, and the answer is that no change is needed.

**There is no ordering test to write.** The draft asserted that the new branch must sit below `experimentReverted` and shipped a test for it. Both branches return `this.fallbackPlanner`, so swapping them changes nothing observable — the reorder was applied and the suite stayed green. The new branch structurally cannot reinstate the primary, because it returns the fallback unconditionally, so no ordering test is possible or needed. `test/experiment-revert.test.ts` already covers the reverted-experiment path. The branch is still placed after `experimentReverted` and `claudeDisabled` for readability, not for behaviour.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-failure-classes.test.ts`. The file already imports everything needed and defines `config`, `stubApi`, `okPlan`, `alwaysThrows` at the top; reuse them. Paste verbatim — every tick count and assertion below was run against the finished implementation.

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

    // Long enough to drain the countdown, fail two probe replans against the
    // still-dead primary, and re-arm -- a re-arm must not re-announce.
    for (let i = 0; i < 12; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const downs = store.recentEvents("a1", 200).filter((e) => e.type === "planner_endpoint_down");
    expect(downs.length).toBe(1);
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

    // 8 heartbeat-spaced ticks: two primary failures arm the countdown, the
    // fallback serves it down, and the probe replan reaches the primary.
    for (let i = 0; i < 8; i++) { await agent.runOnce(); now += HEARTBEAT; }

    const types = store.recentEvents("a1", 200).map((e) => e.type);
    expect(types).toContain("planner_endpoint_recovered");
    expect(primary.calls).toBe(3); // two failures plus the one successful probe

    const fallbackAtRecovery = fallback.calls;
    for (let i = 0; i < 4; i++) { await agent.runOnce(); now += HEARTBEAT; }
    expect(fallback.calls).toBe(fallbackAtRecovery); // never served again
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

    // Still inside the countdown. The primary is healthy again, so anything
    // that let a fallback success clear the state would pick it up here.
    for (let i = 0; i < 2; i++) { await agent.runOnce(); now += HEARTBEAT; }

    expect(primary.calls).toBe(primaryAtHandover);
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
});
```

Note what is deliberately absent. No test uses an `experiment` config, so none of them needs `stubApi({ stats: { missions_completed: 1 } })`. If a later change adds one that does: `stubApi` builds a `StatusSnapshot` with no `stats`, so `progressCountersTotal(undefined)` returns null, the experiment fail-safe re-seeds every tick and the latch never fires. Such a test must pass `api: stubApi({ stats: { missions_completed: 1 } })` and use `withinHours: 1`, never `0`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/agent-failure-classes.test.ts
```

Expected: the six new tests fail. The first fails on `expect(fallback.calls).toBe(1)` receiving `0`, because nothing yet routes a down endpoint to the fallback.

- [ ] **Step 3: Add the constants**

In `src/agent/agent.ts`, directly after `TRANSIENT_BACKOFF_MAX_MS` at line 135:

```ts
// #240. Two consecutive transient failures against a LAN endpoint on a
// multi-minute replan cadence means the listener is gone, not busy; one
// failure is a blip the exponential backoff above already absorbs.
const ENDPOINT_DOWN_THRESHOLD = 2;
// How many REPLANS the fallback serves before the primary is probed again.
// Counted in replans, not milliseconds: a wall-clock window has to be longer
// than the largest inter-replan gap to survive one replan, and heartbeat_minutes
// is config the constant cannot see.
const ENDPOINT_RETRY_REPLANS = 5;
```

Sanity check while you are here: `5` collides with no other constant in the file, unlike the draft's `10 * 60_000`, which was numerically identical to `TRANSIENT_BACKOFF_MAX_MS` two lines above — a test reading the wrong one would have passed.

- [ ] **Step 4: Add the field and extend `PlannerHealth`**

Next to `private plannerBackoffUntil = 0;` at line 375:

```ts
  // #240. Countdown in REPLANS, not a timestamp and not a boolean. 0 = the
  // primary is healthy. Cleared ONLY by a primary success.
  private endpointDownReplans = 0;
```

Then extend the exported interface at line 29, after `consecutiveTransientFailures`. Skipping this is a `TS2353` at the `snapshot()` literal in Step 9:

```ts
  // #240. Replans remaining in the endpoint-down state; 0 = primary healthy.
  endpointDownReplans: number;
```

- [ ] **Step 5: Arm it on the transient branch**

`handlePlannerFailure` at 2536 gains a second parameter:

```ts
  private handlePlannerFailure(e: unknown, served?: Planner): void {
```

Its one call site, in `replan()`'s `catch` at line 1922, passes the planner that actually served:

```ts
      this.handlePlannerFailure(e, planner);
```

Inside the `TransientPlannerError` branch, between the `planner_transient_error` emit (ending line 2563) and the stall check (line 2564):

```ts
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

- [ ] **Step 6: Serve the fallback from `activePlanner()`**

In `activePlanner()` at line 1604, after the `claudeDisabled` branch and before the `usingFallback` branch:

```ts
    // #240. Endpoint unreachable: serve the fallback until the countdown
    // reaches its last replan, then probe the primary (the replan IS the
    // health check -- no probe endpoint, no watchdog).
    if (this.fallbackPlanner && this.endpointDownReplans > 1) return this.fallbackPlanner;
```

- [ ] **Step 7: Decrement once per fallback-served replan**

In `replan()`, immediately after the `if (!planner) { ... return; }` guard that ends at line 1663:

```ts
    // #240. One decrement per REPLAN the fallback actually serves. Placed here
    // because this is the only site that commits a replan to a planner: ticks
    // that never reach a replan must not consume the countdown.
    if (this.endpointDownReplans > 0 && planner === this.fallbackPlanner) this.endpointDownReplans--;
```

- [ ] **Step 8: Clear it on a primary success**

In the success path, immediately before the existing `this.consecutiveTransientFailures = 0;` at line 1918. `planner` is the local captured at line 1659, so identity tells you which planner served this plan:

```ts
      if (this.endpointDownReplans > 0 && planner === this.planner) {
        this.endpointDownReplans = 0;
        this.emit("planner_endpoint_recovered", {});
      }
```

- [ ] **Step 9: Surface it in the snapshot, and fix the three existing tests it breaks**

In the `snapshot()` `plannerHealth` literal near line 751, after `consecutiveTransientFailures`:

```ts
        endpointDownReplans: this.endpointDownReplans,
```

That changes a payload three existing tests assert on exactly. Update all three:

`test/agent-snapshot.test.ts:43` (the `toEqual` on the whole object):

```ts
      backoffUntil: 0, consecutiveTransientFailures: 0, endpointDownReplans: 0, stuck: false,
```

`test/agent-snapshot.test.ts:107` (the strict key allowlist — its whole job is to fail when a field is added without a dashboard consumer, so adding the key is the correct response only because Step 10 adds that consumer):

```ts
      ["backoffUntil", "claudeDisabled", "consecutiveTransientFailures", "endpointDownReplans",
       "stalled", "stuck", "usingFallback"].sort(),
```

`test/server.test.ts:59` (the `/api/agents` body):

```ts
      backoffUntil: 0, consecutiveTransientFailures: 0, endpointDownReplans: 0, stuck: false,
```

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
bun test test/agent-failure-classes.test.ts && bun run typecheck
```

Expected: all pass, typecheck clean.

- [ ] **Step 12: Ablate each guard**

Not optional, and not satisfied by reading the code. For each, apply the ablation, run `bun test test/agent-failure-classes.test.ts`, confirm the expected tests go RED, restore. Expected results, observed on the finished implementation:

| # | Ablation | Expected RED |
|---|---|---|
| 1 | Delete the `activePlanner()` branch (Step 6) | tests 1, 3, 4 |
| 2 | Remove the `if (this.endpointDownReplans === 0)` gate, emitting unconditionally (Step 5) | test 2 |
| 3 | Drop `&& planner === this.planner` from the recovery condition (Step 8) | tests 2, 3, 4 |
| 4 | Drop `served === this.planner` from the arming condition (Step 5) | test 5 |
| 5 | Drop `this.fallbackPlanner &&` from the arming condition (Step 5) | test 6 |
| 6 | Delete the per-replan decrement (Step 7) | tests 3, 5 |

If any ablation leaves the suite GREEN, the test is decorative: rewrite it so it bites and say so in the completion report. A green ablation can also mean the ablation silently no-opped — `bun test` does not typecheck, so a reference to a field that does not exist can fall through to the correct path. Verify the edit landed.

- [ ] **Step 13: Run the full suite**

```bash
bun test && bun run typecheck
```

Expected: green (1448 pass, 1 skip, 0 fail as of `381b0c6` plus this change). `test/agent-snapshot.test.ts` and `test/server.test.ts` are the two that notice the new field; Step 9 already handles them. `test/agent-observability.test.ts` and `test/experiment-revert.test.ts` are NOT affected — the earlier draft named them and was wrong.

- [ ] **Step 14: Append the decision-log entry**

`docs/decisions.md`, following the enforced shape: one-paragraph context, `**Options.**` as terse one-line bullets each naming the option, its tradeoff and the verdict, then a one-paragraph `**Decision.**`. Hard cap 400 words, enforced by `test/doc-size.test.ts`; 200-300 is typical. Written for an infrastructure engineer, not a developer.

The options that were genuinely on the table, all four rejected for reasons that belong in the log: reusing `usingFallback` (a one-way latch, never reset — the first overnight sleep would move the pilot to the subscription permanently); a health-probe endpoint (an extra call every cycle when the replan is itself the probe); a separate watchdog task (a new lifecycle to own); deriving the state from `consecutiveTransientFailures` alone (the success path resets it for a fallback success too, so the pilot would flap every cycle). Include the wall-clock-versus-replan-count choice and why the millisecond window failed: it was shorter than the configured replan cadence, so it expired before it could ever be read.

Then run the gate:

```bash
bun test test/doc-size.test.ts test/lint-doc-prose.test.ts
```

- [ ] **Step 15: Pair the guard with an improv-mode instruction**

Every deterministic guard gets a paired entry in `docs/superpowers/specs/2026-07-12-improv-mode.md`. This one is infrastructure, not a piloting lesson, so one line under the non-negotiable-backstops section is the right size: planner failover is deterministic and stays deterministic — the improv agent neither observes nor chooses its planner, and must not be briefed to reason about endpoint health.

- [ ] **Step 16: Commit and open the PR**

```bash
git checkout -b feat/240-endpoint-fallback
git add src/agent/agent.ts src/server/dashboard.html test/agent-failure-classes.test.ts \
        test/agent-snapshot.test.ts test/server.test.ts docs/decisions.md \
        docs/superpowers/specs/2026-07-12-improv-mode.md
git commit -m "feat(240): reversible fallback when the planner endpoint is unreachable

An unreachable planner endpoint made the agent back off and eventually stall
rather than plan with its configured fallback. Every existing fallback trigger
is subscription-shaped (bad token, exhausted quota, no-progress latch), so a
sleeping workstation left the pilot doing nothing until the box woke or the
12-hour experiment latch fired.

Options considered. Reusing usingFallback: rejected, it is a one-way latch
assigned in exactly one place and never reset, so the first overnight sleep
would move the pilot to the subscription permanently and destroy the saving
this change exists to capture. A health-probe endpoint: rejected, an extra call
every cycle when the replan attempt is itself the probe. A separate watchdog
task: rejected, a new lifecycle to own for a condition the existing consecutive-
failure counter already expresses. Deriving the state from that counter alone:
rejected, the success path resets it for a fallback success too, so the pilot
would flap between planners every cycle. A millisecond retry window: rejected
after measurement, because any constant shorter than heartbeat_minutes expires
before the next replan reads it, and any constant longer is coupled to a config
value nobody re-derives when it changes.

Adds one field and two constants. endpointDownReplans counts replans, not
milliseconds, so the behaviour is independent of tick rate and heartbeat config;
the last replan of the countdown probes the primary, and the replan is the
health check. Cleared only by a primary success. handlePlannerFailure now takes
the planner that served, so a fallback blip is not blamed on the primary.

Closes part of #240."
git push -u origin feat/240-endpoint-fallback
```

Then open the PR (separate call, do not chain):

```bash
gh pr create --title "feat(240): reversible fallback when the planner endpoint is unreachable" --body "<summary + the six behaviors + the six ablation results>"
```

---

## Task 2: Stage 0, baseline the incumbent

**Files:**
- Create: `docs/eval/2026-07-25-planner-baseline.md`
- Read only: `src/eval/run.ts`, `src/eval/harvest.ts`, `test/fixtures/eval-cases.json`

**Interfaces:**
- Consumes: `harvestCases(dbPath, agentId, limit)` from `src/eval/harvest.ts`; the CLI surface of `src/eval/run.ts`.
- Produces: `docs/eval/2026-07-25-planner-baseline.md` containing a per-scorer table with columns `scorer | incumbent pass rate | n scored | n abstained`, plus a run-level cost line. Task 3 appends a second table to this same file.

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
bun run src/eval/run.ts --help 2>&1 | head -40
```

If there is no help output, read `src/eval/run.ts` and `src/eval/types.ts` and write the invocation from the actual argument parsing. Do not guess flags.

- [ ] **Step 3: Run the incumbent against harvested cases**

Use N = 25 (not the harvester's default of 50). Receipt: this spends real subscription quota, 25 cases is enough to separate a 15-point regression from noise on a per-scorer basis, and the curated fixture in Step 4 covers the dimension harvesting cannot.

```bash
bun run src/eval/run.ts --db ./tmp/harness-snapshot.sqlite --agent miner --limit 25 --planner claude-subscription
```

Record the exact command you ran; the flags above are the expected shape, not verified syntax.

- [ ] **Step 4: Run the incumbent against the curated fixture**

```bash
bun run src/eval/run.ts --cases test/fixtures/eval-cases.json --planner claude-subscription
```

This is the run in which `knownSystemRef` actually scores instead of abstaining, because the fixture sets `groundTruth.knownSystemIds` by hand.

- [ ] **Step 5: Write the baseline document**

Create `docs/eval/2026-07-25-planner-baseline.md`. Include both tables (harvested and curated), the exact commands, the case counts, the date, and an explicit list of any scorer that returned `null`. A `null` is an unmeasured dimension, not a pass; say so in the document.

Record cost per plan alongside the quality numbers: `estimateCostUsd` (named in the spec) over the run, divided by cases scored, plus total prompt and response characters. The whole exercise is a cost decision, so the cost column has to exist at Stage 0 — otherwise Stage 1 gates on quality alone and the number that motivated the work only appears in Task 4, after the gate. If `estimateCostUsd` is not reachable from the eval CLI, take the per-model figures from `src/cost/usage.ts` and say in the document which route you used.

State plainly that these numbers are the bar and that the Stage 1 margins were fixed before they were known.

- [ ] **Step 6: Commit**

```bash
git checkout -b docs/240-planner-baseline
git add docs/eval/2026-07-25-planner-baseline.md
git commit -m "docs(240): Stage 0 baseline, incumbent planner per-scorer pass rates

The A/B needs a bar and we did not have one -- no measurement of what the
Claude planner actually scores on the eval's scorers existed, so any threshold
set in advance would have been invented. This is that measurement, over 25
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
- Consumes: the baseline tables from Task 2.
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
curl -s http://127.0.0.1:1234/v1/models | head -20
```

Expect `google/gemma-4-12b-qat` in the list. If the model id served differs from the model key, use the served id in config; do not assume they match.

- [ ] **Step 3: Run the candidate over the identical harvested cases**

Same DB snapshot, same limit, same agent id as Task 2 Step 3. Identical inputs to both models is the only controlled comparison available; changing the case set invalidates the whole exercise.

```bash
bun run src/eval/run.ts --db ./tmp/harness-snapshot.sqlite --agent miner --limit 25 \
  --planner openai-compat --model google/gemma-4-12b-qat --base-url http://127.0.0.1:1234
```

- [ ] **Step 4: Run the candidate over the curated fixture**

```bash
bun run src/eval/run.ts --cases test/fixtures/eval-cases.json \
  --planner openai-compat --model google/gemma-4-12b-qat --base-url http://127.0.0.1:1234
```

- [ ] **Step 5: Apply the pre-committed pass conditions**

Check all four, and report each one's result explicitly rather than reporting an overall verdict:

1. No signal-carrying scorer regresses by more than 15 points against the Task 2 baseline. The seven are `knownSystemRef`, `knownPoiRef`, `knownItemId`, `dockRequiresStation`, `mineNeedsMatchingModule`, `noMineIntoFullHold`, `cargoCoherence`. `knownAction` and `requiredParams` are EXCLUDED: the grammar enforces them for any model, so they carry no signal and must not be counted toward a pass.
2. `scoreGoalDiversity` does not regress at all.
3. No scorer passes on abstentions alone. Any `null` blocks the gate until it is measured on the curated fixture.
4. Zero unparseable responses. A response the grammar could not force into schema is an infrastructure failure, not a quality signal; investigate before trusting any number in the table.

- [ ] **Step 6: Append the candidate table and verdict**

Append to `docs/eval/2026-07-25-planner-baseline.md`: the candidate's tables side by side with the incumbent's, the per-condition results from Step 5, and a one-line PASS or FAIL.

Carry the cost-per-plan column through from Task 2 Step 5, so the two models sit side by side on cost as well as quality. The local model's cost is electricity rather than quota, so record it as `$0.00 quota` plus wall-clock seconds per plan — a local model that is free but four times slower changes the plan rate the pilot can sustain, and that belongs in the comparison, not in a footnote after the gate.

FAIL is an acceptable outcome and ends the exercise here. If it fails, say which condition failed and by how much, and note that the VRAM headroom means retrying with a larger model is a download rather than a code change.

- [ ] **Step 7: Append the decision-log entry**

Append to `docs/decisions.md`, following the enforced shape: one-paragraph context, `**Options.**` as terse one-line bullets each naming the option, its tradeoff and the verdict, then a one-paragraph `**Decision.**`. Hard cap 400 words, enforced by `test/doc-size.test.ts`; 200-300 is typical.

Written for an infrastructure engineer, not a developer. Educational register: define terms in plain words on first use, give the why alongside the what.

- [ ] **Step 8: Run prose-lint and the doc-size gate**

```bash
bun test test/doc-size.test.ts test/lint-doc-prose.test.ts
```

Fix what it flags. Name any genuine false positive in the PR body rather than silently ignoring it.

- [ ] **Step 9: Commit and open the PR**

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
fallback_planner: { provider: claude-subscription, model: sonnet }
experiment: { revert_if_no: any, within_hours: 12 }
```

Back up the existing `agents.yaml` first. Restart the container and confirm it comes up healthy.

- [ ] **Step 6: Observe, then compare**

Let the window run. Compare against Step 4 on the same measures. `experiment:` is the deterministic exit; if it reverts, that IS the result and it is not overridden by judgment.

Watch for `planner_endpoint_down` and `planner_endpoint_recovered` in the feed: they are the evidence that Task 1 works in production, which no offline test can provide. Both now carry an explicit feed colour (Task 1 Step 10) — red for down, green for recovered — so they are visible without reading payloads.

- [ ] **Step 7: Write the window document and the lesson**

Create `docs/eval/2026-07-25-stage2-window.md` with both windows side by side. Append a lesson to `docs/wiki/engineering-lessons.md` if the merge taught something transferable (concrete incident, principle, discipline, why).

Separate KNOWN from UNPROVEN. "Removes the pilot's quota draw" stays a hypothesis until subscription spend attributable to the pilot is measured before and after, and it is only valid for hours the workstation was actually awake.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: "the one real code change" to Task 1; Stage 0 to Task 2; Stage 1 including both case sources and all four pass conditions to Task 3; Stage 2 including the config block and the rejected-second-pilot rationale to Task 4; the prerequisites to Task 4 Step 1; the testing section's behaviors to Task 1 Step 1 with the ablations at Step 12. The spec's "interaction to verify, not assume" is resolved in Task 1's design notes with a stated answer (do not touch the backoff gate).

**Two deliberate departures from the spec, both flagged for the operator.** The spec's `ENDPOINT_RETRY_MS = 10 * 60_000` is replaced by `ENDPOINT_RETRY_REPLANS = 5`, because the millisecond window was shorter than the configured replan cadence and expired before it could be read — measured, not argued. And the spec's fourth test, which it describes as "the one that protects a real invariant", is deleted: both branches return the same object, so the ordering it asserts is not observable and the reorder left the suite green. Neither the spec nor the code on `main` is edited by this plan.

**Placeholder scan.** No TBDs. The one deliberate unknown is the eval CLI's exact flag syntax, which Task 2 Step 2 instructs the implementer to read from the source rather than guess, and which is flagged again at Step 3. The `<workstation-lan-ip>` placeholder in Task 4 is intentional: the real value must not enter the public repo.

**Type consistency.** `endpointDownReplans` is spelled identically in Steps 4, 5, 6, 7, 8, 9 and in the three existing-test fixes. `ENDPOINT_DOWN_THRESHOLD` matches the spec's committed value; `ENDPOINT_RETRY_REPLANS` is the replacement named above. `planner_endpoint_down` and `planner_endpoint_recovered` match the spec's event names and are used consistently in the tests, the implementation steps, the dashboard mapping, and the ablation table. The `retryMs` payload key becomes `retryReplans`, matching the unit change.

**Verification status of this plan.** Task 1 was applied verbatim in a throwaway worktree at `381b0c6`: full suite 1448 pass / 1 skip / 0 fail, `tsc --noEmit` clean, and all six ablations in Step 12 observed RED with exactly the tests listed. Tasks 2, 3 and 4 are unverified by construction — they need the production DB, real quota, and the operator's workstation, none of which an offline check can stand in for.
