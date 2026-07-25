# Local Planner A/B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, on measured evidence, whether `google/gemma-4-12b-qat` on LM Studio can replace the Claude subscription as the pilot's planner, and close the one code gap that only bites once a local endpoint is in the path.

**Architecture:** Three gated stages. Stage 0 measures the incumbent planner on recorded decision points, producing the bar. Stage 1 runs the identical cases through the local model and compares against pre-committed margins. Stage 2 swaps the live pilot's planner behind the existing deterministic `experiment:` revert. Task 1 (the code change) is independent of the stages and lands first, because a local endpoint that sleeps must degrade to the fallback instead of stalling the pilot.

**Tech Stack:** Bun ≥ 1.2.21, TypeScript, Zod, `bun:sqlite`, existing `src/eval/*` harness, existing `src/planner/openai-compat.ts`.

**Source spec:** `docs/superpowers/specs/2026-07-25-local-planner-ab-design.md` (approved 2026-07-25). Issue: #240.

## Global Constraints

- Tests are offline: fake server, mocked planner, zero live-game traffic, zero LLM tokens. `bun test && bun run typecheck` must pass before any commit claiming a task done.
- Main is protected. Every change lands via a PR from a branch; merge with `gh pr merge --delete-branch` after review. Never chain a state-changing `gh` command with a dependent follow-up in one shell call.
- Commits carry the user's identity only. No AI co-author trailer, no "Generated with" footer, in commits or PR bodies.
- The repo is PUBLIC. No LAN addresses, host names, or `C:\Users\<name>` paths in any committed file. Use role words and placeholders; concrete values go in `secrets/` or stay out of git. (Three prior leaks: `d0c09eb`, `3ed92e8`, `d2d5e05`. Issue #524 tracks the gate.)
- A test counts only after you delete the guard it protects and watch it go red. `toEqual` ignores `undefined` array entries; prefer `toStrictEqual` on arrays whose failure mode is a dropped element.
- `ENDPOINT_DOWN_THRESHOLD = 2` and `ENDPOINT_RETRY_MS = 10 * 60_000` are the pre-committed values from the spec. Do not tune them to make a test pass.
- Stage 1 margins are pre-committed and must not be revised after seeing a local-model number: no signal-carrying scorer regresses more than 15 points; `scoreGoalDiversity` does not regress at all; no scorer passes on abstentions alone; zero unparseable responses.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/agent/agent.ts` | Agent loop, planner selection, failure classification | Modify: one field, one constant pair, `activePlanner()` branch, `handlePlannerFailure` transient arm, primary-success recovery |
| `test/agent-failure-classes.test.ts` | Planner failure classification behaviors | Modify: five new tests |
| `docs/eval/2026-07-25-planner-baseline.md` | Stage 0 + Stage 1 result tables, committed as the reference point | Create |
| `agents.yaml` (gitignored, on the pilot host) | Live pilot config | Modify at Stage 2 only |
| `docs/decisions.md` | Decision log | Append one entry at the end of Stage 1 |

---

## Task 1: Reversible endpoint fallback

**Files:**
- Modify: `src/agent/agent.ts` (constants near line 134; field block near line 374; `activePlanner()` at 1604; success path at 1915; `handlePlannerFailure` transient branch at 2554)
- Test: `test/agent-failure-classes.test.ts`

**Interfaces:**
- Consumes: existing `TransientPlannerError` (`src/planner/errors`), existing private fields `consecutiveTransientFailures`, `plannerBackoffUntil`, `experimentReverted`, `claudeDisabled`, `usingFallback`, `fallbackPlanner`, `planner`.
- Produces: private field `endpointDownUntil: number` (0 = primary healthy). Two new event types emitted through the existing `this.emit(type, payload)` seam: `planner_endpoint_down` with `{ consecutiveFailures: number, retryMs: number }`, and `planner_endpoint_recovered` with `{}`. No exported signature changes; nothing outside `Agent` reads the new field except the observability block at line 748.

### Design notes the implementer must not re-derive

Read these before writing code. Each is a trap that a straightforward implementation falls into.

**Why a new field and not the existing counter.** The success path at `agent.ts:1918` resets `consecutiveTransientFailures = 0` after ANY successful plan, including one served by the fallback. If "endpoint is down" were derived from the counter, the first fallback success would clear it, the next replan would return to the dead primary, and the pilot would flap between planners every cycle. `endpointDownUntil` is therefore its own field, cleared only by a PRIMARY success.

**Why a timestamp and not a boolean.** For "a later replan reaches the primary successfully" to ever happen, the primary has to be attempted again. A boolean would latch the pilot onto the fallback forever, which is the exact one-way-latch defect this design exists to avoid (`usingFallback` at line 2544 is that defect). The timestamp lets the window expire, at which point `activePlanner()` serves the primary again with no probe, no watchdog, and no extra call: the replan attempt IS the probe.

**Why re-entry costs two failures, and why that is correct.** While the fallback serves, its successes reset `consecutiveTransientFailures` to 0. So when the retry window expires and the primary is still dead, the counter climbs 0 → 1 → 2 before re-arming. The same threshold governs entry and re-entry. Do not add a shortcut for this.

**Do not touch the backoff gate at line 976.** It returns early before any planner call, so the fallback engages one backoff interval (60s after failure #2) later than the threshold alone suggests. That is acceptable against a replan cadence measured in minutes, and the first fallback success sets `plannerBackoffUntil = 0` at line 1919, so it self-clears. The spec flagged this interaction for verification; this is the verification, and the answer is that no change is needed.

**Ordering is load-bearing.** `experimentReverted` must keep winning. A model that played badly enough to trip the progress latch must not be reinstated because its endpoint came back. The new branch goes AFTER the `experimentReverted` and `claudeDisabled` checks.

- [ ] **Step 1: Write the failing tests**

Append to `test/agent-failure-classes.test.ts`. The file already imports everything needed and defines `config`, `stubApi`, `okPlan`, `alwaysThrows`, `alwaysSucceeds` at the top; reuse them.

```ts
describe("Reversible endpoint fallback (#240)", () => {
  // A planner that fails the first `failures` calls, then succeeds. Lets a test
  // bring the primary back up without swapping the object out mid-run.
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

  function fallbackCalls(): Planner & { calls: number } {
    const p = {
      calls: 0,
      async plan() { p.calls++; return { plan: okPlan, promptChars: 0, responseChars: 0 }; },
    };
    return p;
  }

  test("two consecutive transient failures select the fallback; one does not", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const fallback = fallbackCalls();
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: fallback, config, now: () => now,
    });

    await agent.runOnce();               // failure #1
    expect(fallback.calls).toBe(0);      // one failure is a blip, not a down endpoint

    now += 15 * 60_000 + 1;              // past backoff and heartbeat
    await agent.runOnce();               // failure #2 -> arms endpointDownUntil
    now += 15 * 60_000 + 1;
    await agent.runOnce();               // this replan is served by the fallback

    expect(fallback.calls).toBe(1);
    const types = store.recentEvents("a1", 50).map((e) => e.type);
    expect(types).toContain("planner_endpoint_down");
  });

  test("planner_endpoint_down is emitted once per transition, not once per failure", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      fallbackPlanner: fallbackCalls(), config, now: () => now,
    });

    for (let i = 0; i < 5; i++) { await agent.runOnce(); now += 15 * 60_000 + 1; }

    const downs = store.recentEvents("a1", 100).filter((e) => e.type === "planner_endpoint_down");
    expect(downs.length).toBe(1);
  });

  test("a primary success after the retry window resumes it and emits planner_endpoint_recovered", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan); // dies twice, then recovers
    const fallback = fallbackCalls();
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback, config, now: () => now,
    });

    await agent.runOnce();                 // primary failure #1
    now += 15 * 60_000 + 1;
    await agent.runOnce();                 // primary failure #2 -> down
    now += 15 * 60_000 + 1;
    await agent.runOnce();                 // fallback serves
    expect(fallback.calls).toBe(1);

    now += 10 * 60_000 + 1;                // retry window expires
    await agent.runOnce();                 // primary attempted again, now healthy

    expect(primary.calls).toBe(3);
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types).toContain("planner_endpoint_recovered");

    now += 15 * 60_000 + 1;
    await agent.runOnce();                 // back on the primary for good
    expect(fallback.calls).toBe(1);        // fallback was not used again
  });

  test("a reverted experiment outranks endpoint recovery", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const primary = flakyPlanner(2, okPlan);
    const fallback = fallbackCalls();
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: primary, fallbackPlanner: fallback,
      // revert_if_no: any within 0 hours -> the latch trips on the first check
      config: { ...config, experiment: { revertIfNo: "any", withinHours: 0 } },
      now: () => now,
    });

    await agent.runOnce();
    now += 15 * 60_000 + 1;
    await agent.runOnce();
    now += 15 * 60_000 + 1;
    await agent.runOnce();

    const before = fallback.calls;
    now += 10 * 60_000 + 1;   // endpoint retry window expires; primary is healthy again
    await agent.runOnce();
    now += 15 * 60_000 + 1;
    await agent.runOnce();

    // experimentReverted latched -> every subsequent plan is the fallback's
    expect(fallback.calls).toBeGreaterThan(before);
    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types).toContain("experiment_reverted");
  });

  test("with no fallback configured, transient failures behave exactly as before", async () => {
    let now = 0;
    const store = new Store(":memory:");
    const agent = new Agent({
      id: "a1", persona: "p", api: stubApi(), store,
      planner: alwaysThrows(new TransientPlannerError("connect ECONNREFUSED")),
      config, now: () => now, // no fallbackPlanner
    });

    await agent.runOnce();
    now += 15 * 60_000 + 1;
    await agent.runOnce();
    now += 15 * 60_000 + 1;
    await agent.runOnce();

    const types = store.recentEvents("a1", 100).map((e) => e.type);
    expect(types.filter((t) => t === "planner_transient_error").length).toBe(3);
    expect(types).toContain("stalled");
    expect(types).not.toContain("planner_endpoint_down");
  });
});
```

Before running: check the `experiment` config shape against `src/config/*` and `test/experiment-revert.test.ts`, and use whatever field names that file actually uses. If `withinHours: 0` does not trip the latch, set up the revert exactly the way `experiment-revert.test.ts` already does rather than inventing a shape.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
bun test test/agent-failure-classes.test.ts
```

Expected: the five new tests fail. The first should fail on `expect(fallback.calls).toBe(1)` receiving `0`, because nothing yet routes a down endpoint to the fallback.

- [ ] **Step 3: Add the constants**

In `src/agent/agent.ts`, next to `TRANSIENT_BACKOFF_MAX_MS` at line 135:

```ts
// #240. Two consecutive transient failures against a LAN endpoint on a
// multi-minute replan cadence means the listener is gone, not busy; one
// failure is a blip the exponential backoff above already absorbs.
const ENDPOINT_DOWN_THRESHOLD = 2;
// How long the fallback serves before the primary is tried again. The retry IS
// the health check -- no probe endpoint, no watchdog task. Bounds "the endpoint
// came back but we are still paying for the subscription" to one window.
const ENDPOINT_RETRY_MS = 10 * 60_000;
```

- [ ] **Step 4: Add the field**

Next to `private plannerBackoffUntil = 0;` at line 375:

```ts
// #240. Timestamp, not a boolean: a boolean would latch the pilot onto the
// fallback forever (the defect usingFallback already has). 0 means the primary
// is healthy. Cleared ONLY by a primary success, never by a fallback success --
// the success path resets consecutiveTransientFailures for either planner, so
// deriving this from that counter would flap every cycle.
private endpointDownUntil = 0;
```

- [ ] **Step 5: Arm it on the transient branch**

In `handlePlannerFailure`, inside `if (e instanceof TransientPlannerError) {`, after the existing `this.emit("planner_transient_error", ...)` call and before the `stalled` check:

```ts
      if (this.fallbackPlanner && this.consecutiveTransientFailures >= ENDPOINT_DOWN_THRESHOLD) {
        const wasDown = this.now() < this.endpointDownUntil;
        this.endpointDownUntil = this.now() + ENDPOINT_RETRY_MS;
        if (!wasDown) {
          this.emit("planner_endpoint_down", {
            consecutiveFailures: this.consecutiveTransientFailures, retryMs: ENDPOINT_RETRY_MS,
          });
        }
      }
```

- [ ] **Step 6: Serve the fallback from `activePlanner()`**

In `activePlanner()` at line 1604, AFTER the `experimentReverted` and `claudeDisabled` branches and BEFORE the `usingFallback` branch:

```ts
    // #240. Endpoint unreachable: serve the fallback, but only until the retry
    // window expires -- then the primary is attempted again and a success
    // clears the state. Deliberately below experimentReverted: a model that
    // played badly enough to trip the progress latch must not be reinstated
    // just because its endpoint came back.
    if (this.fallbackPlanner && this.now() < this.endpointDownUntil) return this.fallbackPlanner;
```

- [ ] **Step 7: Clear it on a primary success**

In the success path, next to the existing reset block at lines 1915-1920. `planner` is the local `const planner = this.activePlanner();` captured at line 1659, so identity comparison tells you which one served this plan:

```ts
      if (this.endpointDownUntil > 0 && planner === this.planner) {
        this.endpointDownUntil = 0;
        this.emit("planner_endpoint_recovered", {});
      }
```

- [ ] **Step 8: Surface it in the observability block**

In the status block near line 748, alongside `usingFallback` and `backoffUntil`:

```ts
        endpointDownUntil: this.endpointDownUntil,
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
bun test test/agent-failure-classes.test.ts && bun run typecheck
```

Expected: all tests pass, typecheck clean.

- [ ] **Step 10: Ablate each of the five tests**

This step is not optional and is not satisfied by reading the code. For each guard, delete it, run the suite, confirm RED, restore it:

1. Delete the `activePlanner()` branch from Step 6. Expected red: tests 1 and 3.
2. Change `if (!wasDown)` to an unconditional emit. Expected red: test 2.
3. Delete the `planner === this.planner` condition in Step 7 (leaving the body). Expected red: test 3, because a fallback success would clear the state and the primary would be served before it recovered.
4. Move the Step 6 branch ABOVE the `experimentReverted` check. Expected red: test 4.
5. Delete the `this.fallbackPlanner &&` guard in Step 5. Expected red: test 5.

If any ablation leaves the suite GREEN, the test is decorative. Rewrite it so it bites, and say so in the completion report. A green ablation can also mean the ablation itself silently no-opped (`bun test` does not typecheck, so a reference to a field that does not exist falls through to the correct path) — verify the edit actually landed.

- [ ] **Step 11: Run the full suite**

```bash
bun test && bun run typecheck
```

Expected: green. Pay attention to `test/agent-observability.test.ts` and `test/experiment-revert.test.ts`, the two most likely to notice a new field or a changed planner-selection order.

- [ ] **Step 12: Commit and open the PR**

```bash
git checkout -b feat/240-endpoint-fallback
git add src/agent/agent.ts test/agent-failure-classes.test.ts
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
would flap between planners every cycle.

Adds one field and two constants. endpointDownUntil is a timestamp rather than
a boolean so the primary is retried when the window expires; the retry is the
health check. Cleared only by a primary success. Ordered below
experimentReverted so a model that tripped the progress latch is not reinstated
because its endpoint came back.

Closes part of #240."
git push -u origin feat/240-endpoint-fallback
```

Then open the PR (separate call, do not chain):

```bash
gh pr create --title "feat(240): reversible fallback when the planner endpoint is unreachable" --body "<summary + the five behaviors + ablation results>"
```

---

## Task 2: Stage 0, baseline the incumbent

**Files:**
- Create: `docs/eval/2026-07-25-planner-baseline.md`
- Read only: `src/eval/run.ts`, `src/eval/harvest.ts`, `test/fixtures/eval-cases.json`

**Interfaces:**
- Consumes: `harvestCases(dbPath, agentId, limit)` from `src/eval/harvest.ts`; the CLI surface of `src/eval/run.ts`.
- Produces: `docs/eval/2026-07-25-planner-baseline.md` containing a per-scorer table with columns `scorer | incumbent pass rate | n scored | n abstained`. Task 3 appends a second table to this same file.

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

State plainly that these numbers are the bar and that the Stage 1 margins were fixed before they were known.

- [ ] **Step 6: Commit**

```bash
git checkout -b docs/240-planner-baseline
git add docs/eval/2026-07-25-planner-baseline.md
git commit -m "docs(240): Stage 0 baseline, incumbent planner per-scorer pass rates

The A/B needs a bar and we did not have one -- no measurement of what the
Claude planner actually scores on the eval's scorers existed, so any threshold
set in advance would have been invented. This is that measurement, over 25
harvested real decision points plus the curated fixture.

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

Watch for `planner_endpoint_down` and `planner_endpoint_recovered` in the feed: they are the evidence that Task 1 works in production, which no offline test can provide.

- [ ] **Step 7: Write the window document and the lesson**

Create `docs/eval/2026-07-25-stage2-window.md` with both windows side by side. Append a lesson to `docs/wiki/engineering-lessons.md` if the merge taught something transferable (concrete incident, principle, discipline, why).

Separate KNOWN from UNPROVEN. "Removes the pilot's quota draw" stays a hypothesis until subscription spend attributable to the pilot is measured before and after, and it is only valid for hours the workstation was actually awake.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: "the one real code change" to Task 1; Stage 0 to Task 2; Stage 1 including both case sources and all four pass conditions to Task 3; Stage 2 including the config block and the rejected-second-pilot rationale to Task 4; the prerequisites to Task 4 Step 1; the testing section's five behaviors to Task 1 Step 1 with the ablations at Step 10. The spec's "interaction to verify, not assume" is resolved in Task 1's design notes with a stated answer (do not touch the backoff gate) rather than left as a question.

**Placeholder scan.** No TBDs. The one deliberate unknown is the eval CLI's exact flag syntax, which Task 2 Step 2 instructs the implementer to read from the source rather than guess, and which is flagged again at Step 3. The `<workstation-lan-ip>` placeholder in Task 4 is intentional: the real value must not enter the public repo.

**Type consistency.** `endpointDownUntil` is spelled identically in Steps 4, 5, 6, 7, and 8. `ENDPOINT_DOWN_THRESHOLD` and `ENDPOINT_RETRY_MS` match the spec's committed values. `planner_endpoint_down` and `planner_endpoint_recovered` match the spec's event names and are used consistently in the tests, the implementation steps, and the ablation list.

**Known risk in the test code.** Task 1 Step 1's fourth test assumes an `experiment` config shape. The step tells the implementer to check it against `test/experiment-revert.test.ts` and use the real shape. That test protects the one invariant rather than a mechanism, so if only one of the five survives review it should be that one.
