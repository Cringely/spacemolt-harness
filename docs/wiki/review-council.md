# Review Council: a stakes-tiered reviewer, not one reviewer for everything

The task reviewer (`docs/charters/task-reviewer.md`) has always been a single Sonnet agent checking one diff. That works when a PR fits in one head. Wave-2 evidence (the 2026-07-19 capability-audit, which crawled all 268 game actions) showed it stops working when a PR carries several distinct ways to be wrong at once: every real catch that day came from a different angle of attack. A mission/board mix-up got caught by checking the change against the vendored spec. A read-vs-write mismatch got caught by someone who knew the plan/execute schema. A cargo-shape bug got caught by tracing where a value actually came from. A stale prompt got caught by someone actively trying to break the change. A doc-refresh trap got caught by someone watching for scope creep. One reviewer holding all five lenses at once goes shallow on each. Splitting them across five reviewers, each shallow on four topics and deep on one, is expected to catch more of that class of defect, and four Sonnet reviewers running in parallel are expected to cost less than the one Opus reviewer they replace. Both claims are argued from that single wave's evidence, not measured yet: the retro-validation run against an already-merged 2026-07-19 PR (`docs/decisions.md`, 2026-07-19 entry) is the confirmation step before either is treated as proven rather than plausible.

This page adds a **stakes-tiered** review model. Most PRs keep the one-reviewer process untouched. A defined slice of high-stakes PRs gets a **persona council** instead: a new middle tier. Two other councils already exist in this project, and this one is deliberately neither of them:

- **The milestone Council** (`docs/wiki/team-structure.md`, the `/council` skill): five thinking-style perspectives plus a chairman, reserved for end-of-plan gates, contested design calls, and postmortems. It runs per milestone.
- **Perspective-diverse verify** (`docs/wiki/multi-agent-workflows.md`): the general workflow pattern this page is one application of, several verifiers each with a distinct lens so no one blind spot survives all of them. That page covers when a workflow earns its cost across the whole project; this page is the concrete recipe for the PR-review case.

The persona council below runs per high-stakes PR, dispatched by the tech lead, and never touches routine PRs.

## The stakes ladder

| Tier | What qualifies | Reviewer |
|---|---|---|
| Trivial | Typo, one-line wire-up | One cavecrew reviewer, or skipped per the value-density rule (AGENTS.md) |
| Standard | Single-file logic change | One Sonnet reviewer, unchanged, `docs/charters/task-reviewer.md` |
| High-stakes | See trigger below | Persona council (four Sonnet personas plus one synthesis seat, this page) |

Any tier may add an ADVISORY cross-model second opinion from Codex (`bun scripts/codex-review.ts <pr>`, see `docs/wiki/cross-model-outsider.md`): its findings feed the Claude reviewer, who keeps the ADVANCE/REVISE authority. It is most useful on standard-stakes PRs, where a different model family can catch a habit the Claude family shares.

## Tier trigger

A PR is high-stakes when either of these holds:

- **Security-relevant, quoting the canonical definition word-for-word.** From `docs/charters/task-reviewer.md` §Security-relevant PR classes and `docs/wiki/security-controls.md` (item 4): "changes touching workflows, Dockerfile, secrets handling, the HTTP surface, or the LLM boundary." Copied exactly, not restated in different words, so the pages can never quietly disagree about what counts. That covers `.github/workflows/*.yml` changes too, the Scorecard Dangerous-Workflow and action-SHA-pinning class the security register already gates, so a workflow edit can't fall through this trigger. (The LLM boundary means prompt-shaping, PlanSchema, and executor guards.)
- **Cross-cutting, an addition this page makes beyond the security definition, not part of it.** Spans multiple files in a way no single lens covers: a change touching registry, executor, and digest together, a scheduler-gate change, or a persisted-state schema change. This condition is new here; the source above does not name it.

The tech lead makes the tier call when dispatching review. An ambiguous case (does this PR really cross enough files to count?) escalates to the PM rather than getting decided under load, the same escalation discipline every other judgment call in this project follows.

## The persona council

Four Sonnet reviewers, each assigned one lens, run independently and in parallel against the same diff; no persona sees another's output before filing. A fifth seat, synthesis, reads all four afterward. Distinctness is the whole point: four reviewers with the same lens is four times the redundancy, not four times the coverage.

The four lenses, each grounded in a finding class actually caught in the wave-2 audit:

1. **Correctness/logic.** Does the diff do what it claims; would its own tests fail if the real behavior broke.
2. **Adversarial/security.** Auth, injection, dangling references, boundary violations. This lens caught the A1 stale-prompt defect.
3. **Simplicity/reuse** (ponytail lens). Smallest change that works; reinvented stdlib; speculative abstraction.
4. **Reference-fidelity.** Matches the vendored game reference; no cross-namespace conflation; evidence precedence honored (live capture beats the vendored reference, which beats any assumption, per AGENTS.md). This lens caught the mission-board conflation.

### Persona brief templates

Dispatch briefs, caveman-compressed, one per lens. The tech lead pastes the matching block into each persona's dispatch, plus the PR number/diff and, for lens 2 and 4, the same security-controls rows or game-reference pages the standard reviewer charter already points at.

**Correctness/logic**
```
ROLE: correctness reviewer, persona council, PR #<N>. Lens: logic only, not style/security/simplicity.
Hunt: does the diff do what it claims. For every test the change relies on, ABLATE (revert the fix,
confirm the test fails) -- a test that passes either way proves nothing. Report every finding incl.
low-confidence ones, tag severity + confidence. Assessment-only: report and stop, do not fix.
```

**Adversarial/security**
```
ROLE: adversarial/security reviewer, persona council, PR #<N>. Lens: auth, injection, dangling
references, boundary violations only. Diff is security-relevant: brief includes the matching
security-controls.md rows -- review against those rows and name which ones you checked.
Report every finding incl. low-confidence ones, tag severity + confidence. Assessment-only.
```

**Simplicity/reuse (ponytail)**
```
ROLE: simplicity reviewer, persona council, PR #<N>. Lens: smallest change that works only. Hunt
reinvented stdlib, unneeded deps, speculative abstraction, dead flexibility. Demand a receipt for
every new primitive (lock, threshold, dedup, fallback) per simplicity-rules.md. Report every finding
incl. low-confidence ones, tag severity + confidence. Assessment-only.
```

**Reference-fidelity**
```
ROLE: reference-fidelity reviewer, persona council, PR #<N>. Lens: matches docs/game-reference/ and
docs/wiki/spacemolt-api.md only. Hunt cross-namespace conflation, guessed shapes, evidence-precedence
violations (live capture beats vendored ref beats assumption). Cite the reference page for every
shape you check. Report every finding incl. low-confidence ones, tag severity + confidence.
Assessment-only.
```

Every template carries the same boundary the review-coverage snippet (`~/.claude/snippets/agent-briefs.md`) prescribes: report every finding regardless of confidence, tag severity and confidence, and stop at assessment. No persona applies a fix.

## Effort policy (explicit, binding)

Personas run **Sonnet, high reasoning effort**, not xhigh. Per Anthropic's published model guidance, Sonnet-high already beats prior models' xhigh on most work (an industry claim, not a result measured on this project's review runs), so blanket xhigh on four seats would burn the council's whole cost advantage for no confirmed gain here. **xhigh is reserved for the synthesis seat**, or for the single hardest lens on a PR the tech lead judges especially dangerous, noted in the dispatch. Do not raise all four personas to xhigh by default.

## Synthesis contract

One **Sonnet, xhigh** seat, dispatched after all four personas report. Its job:

- **Dedup** overlapping findings from different personas describing the same defect.
- **Drop** false-positive nits.
- **Rank** surviving findings by severity.
- **Promote on any confirmation, not majority vote.** A single persona's well-evidenced finding is enough to survive; four-out-of-four agreement is not required. A real security defect one lens catches and the other three miss is exactly the case this council exists to preserve, so a majority-vote rule would defeat the design.
- **Apply the joint verdict** the simplicity rules already require project-wide (`docs/wiki/simplicity-rules.md`): ADVANCE only if the diff restores the named invariant and is the smallest change that does so; correct-but-larger is REVISE, never ADVANCE-with-a-note. This is the council's natural home for that certification. Four independent lenses have already stress-tested "smallest," so the synthesis seat's reduction receipt (per `docs/charters/task-reviewer.md`) draws on their findings instead of one reviewer's unaided judgment.

Output: one verdict, ADVANCE or REVISE, plus the ranked surviving findings, posted to the PR per the standard reviewer rule (a verdict left in a dead subagent transcript is unauditable).

## Cost frame

Four Sonnet-high personas plus one Sonnet-xhigh synthesis is estimated to land under the cost of a single Opus adversarial reviewer, from the rough per-token price ratio between the two tiers; nobody has billed both approaches on the same PR to confirm it. The trade this design is reaching for is not more reviewers for more cost, but more perspective for less cost, because in this project's evidence review value comes from where you are looking, not from how hard one model looks. The estimate stands until a receipted comparison exists.

## What this is not

Not a replacement for the milestone Council, which stays reserved for plan-gate and contested-design work. Not a standing agent roster: the personas and the synthesis seat are dispatch-time brief templates the tech lead pastes in, not new charters or agent definitions, and nothing here adds a persistent role to `docs/charters/`. Not a default for every PR. Trivial and standard PRs keep their existing, cheaper review path, and running the council on a PR that plainly does not meet the trigger is the same value-density violation as a manufactured review finding (AGENTS.md).

## CHANGELOG

- v1.0 (2026-07-19) -- initial spec, wave-2, operator-directed. Codifies the stakes-tiered model
  from the 2026-07-19 capability-audit findings (five distinct lenses, five distinct catches).
