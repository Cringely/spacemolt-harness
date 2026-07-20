# Multi-Agent Workflows: scripting a team instead of briefing one agent

Most work here goes to one implementer and one independent reviewer per pull request. This page covers the step beyond that: a workflow, meaning a small deterministic script that runs a whole team of subagents at once. It explains what that buys, what it costs, and the test that decides whether a task deserves one.

## What a workflow is

A workflow is a script that plays foreman. The script holds all the structure of the work: which agents to spawn, in what shape (a loop, a fan-out, a vote), when to wait for stragglers, and how to combine what comes back. The agents supply the judgment; each one reads code, forms an opinion, and reports. No agent decides the shape of the work. The script decides it, the same way every run.

If that split sounds familiar, it should. It is the same plan-then-execute idea the pilot itself runs on (see `docs/wiki/harness-concepts.md`): deterministic code drives, and the model is consulted only where judgment is needed. A workflow applies that idea to the dev team instead of the spaceship. We already run a small version daily: one implementer plus one independent reviewer is a two-agent workflow with a fixed shape, build then fresh-eyes check. The question this page answers is when to scale that shape up.

## The fit test: wide, not deep

This is the idea that decides everything else on this page. A workflow earns its cost on wide tasks: many independent pieces that no single context window can hold at once, worth cross-checking from several angles. Auditing all 268 game actions is wide. Sweeping a security boundary for every way in is wide. Fan-out (many readers at once) and cross-verification (independent opinions on the same finding) are the two things a workflow actually buys.

A deep task is the opposite: one trail followed to its end, like tracing a single execution path through the planner. Two sequential agents handle that fine. If the task needs neither fan-out nor cross-checking, a workflow is waste: you pay for a team and get the output of a queue.

## The core patterns

Six shapes cover nearly everything.

- **Pipeline** (the default): each item flows through every stage on its own, with no waiting for the group; use when items are independent and nothing needs a combined view.
- **Parallel fan-out with a barrier**: split the work, run every piece at once, and wait for all of them before combining; use when the final answer needs every piece present.
- **Adversarial verify**: several skeptics independently attack each finding and a majority vote decides whether it survives; use when false positives are expensive.
- **Perspective-diverse verify**: each verifier gets a distinct lens (security, simplicity, performance) so they cannot all miss the same thing; use when the failure you fear is a shared blind spot.
- **Loop-until-dry**: keep dispatching fresh finder rounds until K rounds in a row come back empty; use for exhaustive hunts where "we found nothing new twice" is the stop signal.
- **Completeness critic**: one final agent whose only job is asking "what did everyone miss?"; use as the last pass on any of the above.

## ultracode: the aggressive setting, and our answer

"ultracode" is an operator-only session opt-in that says: use workflows aggressively and treat token cost as no constraint. The model cannot opt itself in, by design, for the same reason the pilot's guardrails do not let it raise its own spending limit.

Our ruling (operator, 2026-07-19): ultracode is not a standing default for this project. Two reasons. The per-PR review loop already delivers the main property it buys, fresh adversarial eyes on every change. And "cost is no constraint" fights the moderate-burn pacing this project deliberately runs at. So: one-off workflows where a task earns one, and ultracode reserved for spending a real end-of-week surplus.

## What it costs, said plainly

A workflow can spawn dozens of agents (around 16 running at once, with a hard cap of 1,000, per current tooling), so launching one is an explicit operator opt-in, never a default. And know the shape of the budget before spending it: unused weekly quota is not forfeited early, and there is no prize for draining it; it simply resets on schedule. So a workflow runs because the task needs fan-out and cross-verification, never to drain budget. The one exception is deliberate: ultracode above, where the operator chooses to spend a real end-of-week surplus.

## Where this fits SpaceMolt

Wide tasks that would earn a workflow here: a security audit of the scheduler boundary (many entry points, each worth hostile eyes), the 268-action capability audit (many independent items, one shallow judgment each), or an exhaustive bug hunt before a milestone gate. Tasks that would not: a single-feature PR, a lone execution trace, anything the everyday implementer-plus-reviewer pair already covers.

For the cross-model version of fresh eyes (a reviewer from a different vendor entirely), see `docs/wiki/cross-model-outsider.md`.
