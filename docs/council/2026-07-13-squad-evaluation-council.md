# Council: squad vs our team approach — five-perspective synthesis

**Why this council exists.** The single-agent squad evaluation (decisions.md, 2026-07-13) reached
conclusions the operator found suspiciously comfortable, and asked for a full council instead.
Five perspectives answered independently from primary sources (each cloned squad itself): the
organization theorist (the identity bet), the reliability engineer (unattended operation), the
quality skeptic (defects-per-token), the cost auditor (value-per-token vs per-hour), and a
devil's advocate armed with the original report and told to break it. The operator also
contributed a live correction mid-council (personas ≠ what we dismissed). This is the chairman's
reconciliation. The verdict format is deliberately asymmetric: what the original report got
WRONG leads, because that is what the council was for.

## What the original report got wrong (devil's advocate findings, confirmed)

1. **"We're ahead on enforcement" — the trophy goes to escrow.** The report compared squad's
   prompt *prose* against our hook *architecture*. The primary evidence runs the other way:
   squad backs behavioral rules with deterministic regression tests (a dispatch-gate suite that
   was red 8/8 before the fix, green after, plus template-parity CI across 5 synced mirrors),
   while our heaviest judgment rules (pushback, never-self-review, concurrency/isolation) are
   WARN-only session-start reminders — and they re-broke twice in three days, including the PM's
   own concurrent-writer violation during this very evaluation. Squad tests its prompts; we
   remind ourselves about ours.
2. **The Fact Checker dismissal was wrong.** Its devil's-advocate mode is a *dispatchable,
   structured artifact* (steelman + load-bearing assumptions + pre-mortem + one concrete
   alternative, never a veto) with defined triggers. Our substitute is a personality trait of
   one context plus a milestone-gated council. The existence and yield of THIS council is the
   proof the dismissal was self-defeating.
3. **"Cost discipline" was over-praised.** The concurrency cap's receipt is one reliability
   incident, not a cost measurement, and standing memory simultaneously authorizes spending more
   via more agents. Our live posture is closer to squad's eagerness than the report admitted.
4. **"Certified correct-AND-smallest" is real but structurally unverifiable as practiced** — no
   recorded instance of a reviewer producing a smaller patch or demonstrating the attempt;
   verdicts live in dead subagent transcripts unless posted to the PR.
5. **Unexamined:** squad's own SDLC (20 GitHub Actions workflows, changesets, a real test
   suite) contradicts the flat "no CI-green DoD" claim; and their issue #1035 — a context-slim
   moved safety rules out of the always-on prompt and the coordinator promptly broke its prime
   directive — is a direct warning for our session-start hook, which injects only a slice of
   guardrails.md.

## What survived the attack

- The **skeleton convergence** (dispatcher-never-does-domain-work, git-versioned state,
  author-never-reviews, tiering) — every perspective independently re-confirmed it.
- The **two merged adoptions** (revision lockout, steward size gates) — the DA searched for
  adoption risk and found the safeguards already present; one correction applied: the lockout is
  now tagged *load-bearing: assumed* (no evidence squad's cascade converges; ours escalates at
  two rejections, which bounds it).
- The **rejections of** eager anticipatory dispatch (P4: their breaker/quota machinery is the
  evidence the doctrine hits the wall; attention, not tokens, is our binding constraint), silent
  fallback chains, Rai (checkbox theater on a 5-second budget), per-agent history files (P1:
  would erode reviewer independence — statelessness there is load-bearing), always-on
  fact-checking, and auto-retros.
- **Review quality per token: ours, on the evidence** — P3 verified real REVISE finds and
  reviewer-run ablations in this week's PRs, against squad's highest-volume machinery being
  verdict-emission.

## The operator's correction, folded in

"Casting personas" as squad ships them (their own rules: names change nothing, no role-play) is
a memory key plus charm — still rejected. But the operator's meaning — durable specialized
roles: devs, security personnel, project leads, SOC/alert monitors — is role specialization we
already practice in UNDURABLE form: roles re-authored per dispatch as prompts, and our
SOC-monitor equivalents living in session-scoped cron prompts that die on exit. P1's
recommendation and the operator's instinct meet in the same place: **identity-as-configuration
(versioned charter files), not identity-as-memory (history files).** Ceremonies: one timing
insight adopted (pre-dispatch design/seam check beats post-hoc gates for cross-component
contradictions); the always-on auto-triggered form stays rejected. Marketplaces: skipped, but
the capability underneath (portable role definitions) is exactly what charters-in-git provide
without a registry.

## Adoption program (ranked, converged across perspectives)

| # | Change | Source | Catches / eliminates | Cost |
|---|---|---|---|---|
| 1 | **Prompt/code-parity regression tests + enforcement upgrade**: test that briefing invariants and guardrail-paired rules actually hold (the improv-briefing-never-drifts rule is currently enforced by nothing); move mechanically-checkable rules from WARN prose to tests/gates | P5 | The re-broken-rule class; the #1035 context-slim failure mode | M |
| 2 | **Durable scheduler, squad-skeleton shape**: dumb OS-level poller spawning fresh headless agents (stand-up first, then council/trend review) + dead-man timestamp file checked independently + persisted dispatch ledger with orphan sweep | P2 | The 72h-walkaway sequence: orchestration layer dying silently on session exit; the 45h-hang class | M |
| 3 | **Role charters** for recurring non-implementer roles (doc-steward, reviewers, capture, stand-up/SOC-monitor), versioned + reviewed, inlined verbatim at dispatch | P1 + operator | Per-dispatch re-authoring tax; role-brief paraphrase drift; roles dying with sessions | S–M |
| 4 | **Seam manifest**: list the instruction seams (briefing↔schema, guard-strings↔digest, tool-list↔executor); PRs touching one side must check the other; one spanning test per seam | P3 | The L-22 class — which NEITHER system catches as designed | S |
| 5 | **DA-brief template** (steelman, load-bearing assumptions, pre-mortem, one alternative) as the required format when the pushback agreement fires on consequential decisions; decision-triggered, never always-on | P3+P5 | Unstressed consequential decisions; mood-dependent pushback quality | S |
| 6 | **Make "certified smallest" cost something**: reviewer must name the attempted reduction or state where none was found; full verdicts posted to the PR (auditable, outlives the subagent) | P3+P5 | Rubber-stamp certification | S |
| 7 | **Parallelism/cost package**: reviews + steward off the critical path; worktree isolation mandatory for ALL repo-writing agents (now enforced habit after the collision); reasoning-effort per work order; steward/stand-up pinned to the cheap tier | P4 | Serialization waste (largest: steward gating next dispatch); over-modeled dispatches | S–M |

Items 5 and 6 are applied in this PR (working-agreements / team-structure edits). Items 1–4 and
7 are filed as issues — they change code, schedulers, or standing infrastructure and go through
the normal loop.

## Chairman's note on method

The single-agent report was not wasted: three of its four adoptions survived adversarial review,
and its skeleton-convergence framing held. What it could not do — and what this council did — is
attack its own conclusions. The devil's-advocate seat produced the highest-value finding of the
entire evaluation (the enforcement inversion), which is itself the strongest argument for
adoption #5: structured adversarial review as a dispatchable artifact, not a personality trait.
