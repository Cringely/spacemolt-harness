# Council Review — 2026-07-13

The first daily council review (operator-requested cadence). Two independent
perspectives audited the project — an **outsider** (fresh eyes on the code, no
rationale, judging for over-engineering and bloat) and an **insider** (full goals
context, judging direction and whether complexity earns its learning keep) — then
the PM synthesized. The review reports and proposes; it never removes code.

## Headline: both perspectives converged on the same finding, independently

That convergence is the signal. Neither reviewer saw the other's brief.

**Improv mode was built a full milestone ahead of the loop that will use it, and
ahead of a *verified* base-pilot economic win.** The outsider found it as dead
code (`activeApi()` — the method that routes an agent through the MCP client — is
never called in `runOnce`; an agent configured `mode: "improv"` silently runs
plan-then-execute; ~2,380 lines of transport/parser/adapter/probe/tests serve a
control loop, "Batch C", that isn't written). The insider found it as a
direction risk (building the second architecture in depth before the first is
proven is a project-level "prove the premise" tension; the mine→sell loop has had
no confirmed economic win since the phantom-sells retraction, lesson L-6).

Same object, two lenses, same conclusion: **we got ahead of ourselves on improv.**

## What is healthy (keep doing this)

- The **guard stack** (fuel-reserve floor, stuck-watcher, thrash damper,
  plan-rate ceiling, no-progress detector, tick-pacing settle, transient-block
  wait) and the **observability** layer (heartbeat + ledger + notification feed).
  Both councils singled these out as the gold standard: each guard maps to a real
  field incident *and* a distinct transferable lesson (L-3/4/5/7/8/17/18). This
  complexity *is* the curriculum — it earns its keep.
- The **receipts discipline** is lived, not just declared (the `DELIBERATELY
  EXCLUDES … Receipt:` comments, the decision to NOT implement `getSkills` in the
  MCP adapter because it would be dead code). The simplicity rules are working.
- The functional core (registry SSOT → plan schema → executor → digest → store →
  dashboard) is genuinely lean.

## Findings and proposed actions

The two categories of weight, per both councils, are (1) improv built ahead of
need and (2) the `Agent` class plus incident-narrative comments accreting.

1. **Sequencing (the important one): prove the base pilot earns before elaborating
   improv.** Hold improv Batches C/D/E. Pivot the immediate focus to giving the
   plan-then-execute pilot a *verified* economic win — the earning fixes (#93
   market-awareness, #94 catalog-gated jettison, #112 profitability) plus a
   confirmed mine→sell→profit cycle. Improv's entire value is the *comparison*
   against a working baseline; without a proven baseline there is nothing to
   compare, and building the second architecture first inverts "prove the
   premise." The already-merged improv machinery (Batches 0/A/B) is reviewed and
   sits behind an off-by-default flag — it stays (reverting reviewed work is
   waste), but it is explicitly **shelved**, not active, until the base earns.
   → issue: hold-improv-until-base-earns.

2. **Footgun: `mode: "improv"` silently no-ops.** `main.ts` accepts it and the
   agent runs plan-then-execute anyway. Cheap fix: make config REJECT
   `mode: "improv"` with a clear "not yet active — Batch C pending" error rather
   than silently mislead. → issue.

3. **`agent.ts` is a 1,526-line god-class** with four overlapping stall/no-progress
   mechanisms sharing mutable counters with careful cross-reset logic. Not a rule
   violation (cohesive, commented) but the one file a fresh reviewer can't hold.
   Extract a `StallMonitor` (fold Layer-4 detector + steward + heartbeat) that
   returns one verdict; `runOnce` becomes fetch → reflex → wake → monitor →
   act. → issue.

4. **Incident archaeology inlined as comments** (`agent.ts`/`executor.ts`/
   `digest.ts` are 55–70% comments; full transcripts of SM-3/SM-9/SM-12 live in
   code). The narrative home is `decisions.md`; keep the one-line invariant in
   code, move the story to the log, cite it. Removes hundreds of lines from the
   hottest files without touching behavior. (Note the genuine tension: the insider
   *praised* the receipts; the resolution is invariant-in-code + narrative-in-log,
   not deleting the why.) → issue.

5. **Spent diagnostic `mcp-probe.ts`** (548 lines + 205-line test): the project's
   own hygiene rule deletes one-time scripts after use, and the fixture is
   committed. Caveat the outsider missed: the MCP client REUSES its JSON-RPC
   builders (SSOT), so this is *extract the shared helpers into the client, then
   delete the rest*, not a raw delete. → issue.

6. **Dead `get_poi` path** (unused client method + ASSUMED-shape type) and the
   **live-falsified-but-retained `auto_list`** param (kept "for a case we have not
   falsified" — speculative retention). Prune both unless a real use appears. → issue.

## Central risk to watch

Investment in *playing the game well* starting to outpace *transferable-lesson
yield*. The guard stack earned its complexity because each guard equals one
portable lesson; the newer economic mechanics and the volume of MCP plumbing have
a worse lesson-per-line ratio. The concrete tell: a decision-log entry that can
only justify itself in game terms ("so the pilot can craft superconductors") with
no L-N lesson behind it. Apply the "what does this teach that transfers?" gate
hardest to the economic layer, and hold improv to its comparison-measurement
purpose rather than elaborating a parallel piloting stack as an end in itself.

## Verdict

Healthy, unusually disciplined project. One real course-correction (sequencing:
base-pilot win before more improv) and a set of non-urgent prunes. The PM owns the
sequencing miss — improv was built aggressively, operator-prioritized but
un-pushed-back-on, before the base was proven.
