# How we work: verification-first AI engineering

This page describes the practices the team works by, and why. It is grounded in Google/Kaggle's
"The New SDLC With Vibe Coding" (Osmani, Saboo, Kartakis, 2026) and in practice from Anthropic's
engineering writing and Karpathy. In short, we are not vibe coding. We are doing agentic
engineering, and this page says what that means in concrete terms for this repo.

## The core idea: Agent = Model + Harness

An AI agent is a model (the LLM that reasons) plus a harness: the tools it can call, the rule
files, the memory, the guardrails, the observability, and the deterministic code that runs
plans. The paper's point is that an agent's behavior "is dominated by what the harness does, not
just by which model is underneath". The model is one input into a running system; the harness is
where almost all the real engineering lives. (Practitioner shorthand summarizes this as a
"roughly 10% model, 90% harness" split. That ratio is a popular gloss, not a figure from the
paper. The paper's own evidence is starker: one team went from outside a benchmark's Top 30 to
Top 5 by changing only the harness, model fixed.)

This whole project is a harness. Plan-then-execute puts that idea into code: the model plans
rarely, and deterministic code executes each plan tick-by-tick at zero token cost. When an
agent misbehaves, the useful instinct is "what in the harness is misconfigured?" rather than
"the model is dumb." We proved this on ourselves: the low-fuel runaway that burned ~75 LLM
calls/hour came from a one-word config-key typo (`reflexes:` vs `reflex:`) that silently
disabled a safety reflex. A configuration failure, not a model failure. That is the common case.

## The factory model: your real output is the system that produces code

The paper's central metaphor says the developer's primary output has shifted from the code
itself to "the system that produces code": the specs and context, the agents, the tests and
quality gates, the feedback loops, and the guardrails. Code is what that factory emits, not the
thing you hand-craft. This project is exactly that. The SpaceMolt game is the sandbox; the real
deliverable is the harness-plus-team that plays it: the registry, the executor, the eval suite,
the review agents, the dashboard. When you feel the pull to hand-tune one plan, remember the
output is the factory, not the part.

## Where we sit: agentic engineering, not vibe coding

The paper frames a spectrum by how much you verify.

- Vibe coding: casual prompts, little verification, disposable code. Fine for a throwaway prototype.
- Agentic engineering: specs, automated tests/evals, CI/CD gates, independent review. For work
  that has to keep running.

We are at the agentic-engineering end, and the reason is cost, a first-class goal here.
The paper frames the economics as a CapEx/OpEx tradeoff. Vibe coding is cheap upfront (CapEx)
and expensive to keep running (OpEx): token burn, rework, security remediation, and "context
rot" from overloaded prompts. Agentic engineering is the reverse: higher upfront cost in
schemas, tests, and structured context, then a much lower cost per feature. The paper argues the
burden is qualitative and compounding, not a single headline multiple. The runaway incident was
the vibe-coding failure mode showing up in our own system; the guard work is us buying down the
marginal cost.

## The new craft is verification, and the bottleneck is specification

Generation is largely solved; models write plausible code fast. What is scarce now is judgment:
saying precisely what "correct" means and checking that the output meets it. The paper puts the
bottleneck on "specification, evaluation, architectural judgment, and review" together, not the
spec alone. So:

- Specs are the source of truth, and specifying-plus-verifying is the real bottleneck. A vague
  spec produces confident wrong code. We invest in the spec first (`docs/superpowers/specs/`),
  then plan, then build, then verify.
- Review is never self-review. A fresh context catches what the authoring context is blind to.
  Every spec, plan, and diff goes to an independent agent.
- Architecture stays human-centric. The PM (you, in the main context) decides trade-offs and
  structure; agents build. The paper is blunt that this part does not delegate well yet.

## Directing the team: Conductor and Orchestrator

- Conductor: real-time, side-by-side, reviewing keystroke by keystroke. Good for exploration and
  unfamiliar code.
- Orchestrator: you hand a well-specified goal to the team, they run it, you review the result.
  Good for work that can be specified up front.

The default here is Orchestrator. You give high-level directives; the PM decomposes them,
dispatches implementer and reviewer agents, and drives problems and tuning to completion. The PM
surfaces (bubbles up) only thoughts that change the approach or path, never routine execution.

## Verification means evals, output and trajectory (the practice we are adopting)

The paper's sharpest instruction: "set the bar at the eval, not the demo." A demo shows the
agent worked once. An eval suite with a real rubric shows it works reliably. Two kinds, both
needed:

- Output evaluation: did the effect actually happen? (Cargo decreased after a sell; credits
  rose.) We already do this; the executor verifies effects instead of trusting the model's claim.
- Trajectory evaluation: was the path sound (the reasoning, the tool choices, the call rate)?
  Here is the gap we are closing. The observability work (plan-rate per hour, wake-reason mix,
  no-progress detection, cost-per-day) is trajectory-eval instrumentation.

Tests and evals are different mechanisms, and the paper draws the line sharply. Tests verify the
deterministic parts and are checked by code. Evals verify the non-deterministic parts (did the
LLM plan sensibly?) and are checked by labelled datasets, scoring rubrics, or an LLM judge. Our
offline `bun test` suite is tests. The eval suite below is the other half we are adding.

The upgrade now in flight turns the informal SM-1..SM-13 flight-campaign anecdotes into a
standing eval suite: benchmark scenarios, clustered failures, a refined prompt and tools, and a
regression guard so a fixed failure class cannot silently return. Offline, deterministic, zero
live tokens, same as our tests.

## Intelligent model routing: match the model to the job

Not every step needs the biggest model. The paper prescribes routing by task complexity: large
models for the hard, highest-payoff phases (requirements, architecture, the first cut of the
code), smaller or cheaper models for deterministic, low-complexity work (test generation,
routine review, CI/CD monitoring). This is directly why our stack mixes a Claude subscription with local
Ollama and tiers agents by model: Opus/Fable at the top, Sonnet for leads and review, Haiku for
mechanical work. Cost is first-class here, so the default question for any new agent is "what is
the cheapest model that clears this task's bar?", never "use the best model everywhere."

## Context engineering: static, dynamic, progressive

Context (what the model sees) costs money every turn, so we manage it deliberately.

- Static, loaded every turn: `AGENTS.md`, rule files, core guardrails. Reliable, expensive.
- Dynamic, loaded on demand: skills triggered by task match, wiki pages read only when relevant,
  tool results. Cheaper per interaction.
- Progressive disclosure: metadata first, full detail on match. The memory index (`MEMORY.md`)
  and the context-map table in `AGENTS.md` exist so a task loads only what it needs.

## The 80/20 caveat

Agents get the first 80% of a feature fast. The last 20%, the edge cases and the joints where
systems meet, still needs context the model usually lacks. That last 20% is where the PM's
judgment, the independent review, and the eval suite earn their place. Budget for it; the fast
80% does not mean done.
