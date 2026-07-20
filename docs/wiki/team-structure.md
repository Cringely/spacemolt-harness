# Agent Dev Team Structure

How this project's AI development team is organized. The model is a small dev shop with one twist: the org chart is also the token-spend chart, so every layer has to earn its place.

> **This page split when it outgrew the wiki size line (#237).** Roles and authority live here. The communication protocol, completion-report template, batch cadence, known failure modes, and git/PR workflow moved to [`team-workflow.md`](team-workflow.md); the stand-up loop, ceremonies mapping, and catch-up rule moved to [`team-ceremonies.md`](team-ceremonies.md). Older documents that cite "team-structure.md" for those sections resolve here, one hop away.

## Org chart

```
User (stakeholder/director)
  └─ Orchestrator ("PM" in older docs) — the main conversation context
       ├─ Tech Lead (one per workstream, e.g. "Engine Lead" for Plan 1)
       │    ├─ Implementer agents (ephemeral, one per task)
       │    └─ Task Reviewer agents (ephemeral, independent per task)
       └─ Council (5 perspectives + chairman) — milestone gates only
```

## Roles

The recurring non-implementer roles (task reviewer, doc steward, capture agent, SOC monitor, strategy reviewer) each have a versioned charter in `docs/charters/`: a written job description, inlined verbatim at dispatch and changed via PR like policy (identity-as-configuration, #164).

**Orchestrator (the main conversation context; older docs say "PM", and both names mean this seat).** It owns scope, priorities, reporting, timelines, and the user relationship. It turns the user's intent into work orders, dispatches leads, implementers, and reviewers, reads their reports, maintains the decision log and STATE.md, and escalates consequential choices to the user. It was renamed from "PM" (operator discussion, 2026-07-13) because it does one thing a real-world PM never does: it holds **accept authority**, merging a PR once an independent reviewer returns an ADVANCE verdict and CI (the automated test run) is green. That stays here deliberately (L-23, function over form). The human PM/lead split exists because one person cannot hold technical depth and coordination at once. Here the technical judgment is already delegated to the reviewer: the merge is an *accept decision consuming a review*, not a review, and authority belongs in the one durable, accountable seat (the same council-adopted rule forbids unattended agents from merging). The seat still never writes implementation code or performs technical review itself. Its context window is the most expensive resource in the system; it holds judgment, not diffs.

**Tech-lead activation trigger (codified 2026-07-13, operator-directed).** The Tech Lead layer is dormant while waves are small: under the half-pace posture the orchestrator dispatches implementers directly and shepherds the two-PR wave itself. The layer activates, meaning batch-shepherding plus merge *mechanics* (branch hygiene, CI-watching, merge execution on the orchestrator's accept) move into a Tech Lead charter, when either fires: (a) a wave exceeds **2 concurrent implementation lanes**, or (b) the **#114 durable scheduler goes live** (its charter-armed spawns need a coordinating seat by construction). Accept authority itself never moves. This is written down so the layer's activation is a checked precondition (working-agreements #5), not a judgment call re-made under load.

**Tech Lead (one per workstream).** A long-running agent given a batch of plan tasks. It dispatches an implementer per task, sends each result to an independent task reviewer, arbitrates the findings (fix, or reject with a reason), integrates, makes sure `bun test && bun run typecheck` pass, commits, and reports a batch summary up to the PM: what shipped, what the reviewers caught, what surprised them, what's blocked. Design questions get escalated, never decided silently. One revision rule, adopted from the squad evaluation (2026-07-13): a task rejected for a defect goes to a **fresh implementer context**, never back to its author. The reasoning that produced the defect is the reasoning that would revise it, the same structural blindness that bans self-review. Two rejections of the same task mean the plan task itself is suspect: escalate, don't re-roll. (Load-bearing: ASSUMED. No evidence yet that re-dispatch converges better than author-revision; the two-rejection escalation is the bound. Drop the tag when the first real rejected-task cycle confirms it.)

**Implementer (ephemeral: spun up for one task, then thrown away).** Receives exactly one plan task verbatim; the plan contains complete code, tests, and commands, so no archaeology required. It completes the task and reports in the five-field completion template (SHIPPED / EVIDENCE / FINDINGS / BLOCKERS / FILES; see the Communication protocol in [`team-workflow.md`](team-workflow.md); 150 words excluding evidence, prose is bounced). Discarded after.

**Task Reviewer (ephemeral, independent).** A fresh context that never saw the implementation happen checks the diff (the exact lines of code that changed) against the task's requirements and the global constraints. Self-review is banned project-wide; this role is why. A verdict of ADVANCE must make the "correct-AND-smallest" certification cost something (2026-07-13 squad-council item 6): name the smaller alternative attempted and why it fails, or state where reduction was attempted and none found. The full verdict is posted to the PR as a comment, so it outlives the reviewer's context and stays auditable. Review runs a **stakes-tiered model** (`docs/wiki/review-council.md`, wave 2): a trivial PR gets one cheap reviewer or none, a standard PR keeps this single-Sonnet-reviewer role unchanged, and a high-stakes PR (security/LLM-boundary/HTTP-surface/Dockerfile, or cross-cutting multi-file logic) escalates to a persona council of four Sonnet reviewers plus a synthesis seat instead.

**Council (milestone gates).** Five agents with distinct thinking styles answer independently, peer-review each other anonymously, and a chairman synthesizes. Reserved for end-of-plan gates (is this plan actually done and sound?), contested design choices where the PM sees more than one defensible answer, and postmortems. Never used for routine task review; it's a 6-agent spend.

**Doc Steward (ephemeral, dispatched after each merge cluster).** After a wave of PRs merges, the PM spins up one agent whose single job is keeping the operator's remote view truthful. It runs the documentation-freshness gate (AGENTS.md): reconcile the STATE.md `## NOW` block, `docs/milestones.md`, the README progress section, and `docs/wiki/engineering-lessons.md` (when a merge taught a transferable lesson) against what merged, then open one docs-only PR. The PM republishes the claude.ai milestone-tracker Artifact from the refreshed `docs/milestones.md`; that file is the Artifact's single source of truth (SSOT). The role exists because doc-staleness kept recurring (STATE.md lagged behind batch merges; the milestone tracker went stale despite ~20 merged PRs), and a PM juggling the next batch reliably lets the living docs drift. Giving freshness its own role makes it part of definition-of-done rather than a good intention. Like every authoring role, its output is reviewed by a fresh context, never self-graded; being docs-only, that is usually PM judgment per the PR-stage rules in [`team-workflow.md`](team-workflow.md). The steward also enforces **mechanical size gates** on the living docs (squad evaluation, 2026-07-13: a compaction *threshold*, not just a compaction protocol). When `docs/decisions.md` exceeds ~150 KB or `docs/STATE.md` exceeds ~40 KB, it archives the oldest entries to a dated `docs/archive/` file and leaves a one-line pointer. `engineering-lessons.md` is exempt: it IS the curriculum, pruned only when a lesson is superseded per the invariant-promotion rule. A byte threshold fires mechanically; "someone notices the file got long" does not.

Those whole-file thresholds turned out to be the wrong unit. They never fired while `decisions.md` grew to 136 KB, because it grew one 700-word essay at a time and every individual entry looked reasonable. So the executable gates (`test/doc-size.test.ts`, 2026-07-14) cap the **unit of work** instead, the thing a writer actually controls: 400 words per NEW decision entry with a required options/decision shape, and 500 words on the STATE `## NOW` block. Both fail `bun test` by name. An over-long entry is a red build rather than a reviewer's judgment call, and the steward's job at the gate is to fix the offender the test names, not re-litigate the cap.

Whole-file and whole-page size stayed OUT of the test, by operator ruling (2026-07-14): "not sure a hard mechanical gate applied to the entire documentation file is the best approach — maybe a cap per update is more appropriate?" A byte cap on an accumulated file red-builds whoever happens to write the legitimate entry that tips it over, punishing the wrong author, and forces a wiki split on a schedule the content never asked for. Whole-file growth is a steward ARCHIVAL trigger instead (charter step 7b: decisions.md > 150 KB → archive the oldest entries to `docs/archive/`), and page splits are housekeeping. One hard limit on the cap itself: it is a brevity gate, never a content gate. It may take an entry's narrative and repetition; it may never take a rejected option, a receipt, or a design detail. When those collide, the content wins and the entry is grandfathered. That collision is real; it is why PR #236 was sent back.

## Model tiering

Roles map to model classes the way instance types map to workloads: judgment concentrates at the top, volume runs on the cheap tier.

| Role | Model class | Rationale |
|---|---|---|
| PM (main context) | Fable/Opus class | Fewest tokens, highest-stakes judgment: scope, arbitration, user communication |
| Tech Lead | Sonnet | Coordination, review arbitration, integration — needs competence, not brilliance |
| Implementer | Haiku (default) | Plan tasks contain verbatim code and commands; the work is mechanical. Escalate a task to Sonnet only when it requires real judgment (flagged in the work order) |
| Task Reviewer (standard PR) | Sonnet | Reviews are where cheap models rubber-stamp; catching defects is the whole value |
| Review Council (high-stakes PR) | Sonnet-high x4 personas + Sonnet-xhigh synthesis | Perspective diversity over one model working harder; see `docs/wiki/review-council.md` |
| Council (milestone gate) | Per council skill config | Chairman synthesis benefits from a strong model |

Escalation is per-task and explicit: if a Haiku implementer fails a task twice, the lead re-dispatches it on Sonnet and notes it in the batch report. That data tells us where the cheap tier's ceiling actually is.

## Security function (standing, user-directed 2026-07-10)

Security here is authority encoded in the repo plus trigger points, not an always-on agent:

- **Policy**: the security function owns `docs/wiki/security-baseline.md`. Policy changes land as reviewed docs PRs and bind everyone: implementers, leads, PM, and the security function itself.
- **Audits**: at every plan gate, before any deployment, after any incident. Run by the vendored read-only `security-auditor` persona, always independent of the team audited.
- **Incident authority**: ANY agent can declare a chain-integrity event (an unexplained dependency, secret, or infra change). Declaration halts the affected pipeline immediately, and the halt is not subject to PM override before triage. Security (or the declaring lead) triages with evidence preserved; the PM arbitrates remediation; the event gets a decision-log entry.
- **Framework alignment (2026-07-13)**: the function audits against the adopted frameworks: SSDF as the practice checklist, SLSA Build for supply-chain integrity, Scorecard for continuous repo hygiene (`docs/wiki/security-controls.md` is the register). Every milestone-gate audit produces a DATED DELTA against the register (what moved tier, what regressed), appended to it; an audit that doesn't update the register didn't happen. PRs touching workflows, the Dockerfile, secrets handling, the HTTP surface, or the LLM boundary are security-relevant by definition: flagged in the PR body, reviewed with the relevant register rows in the brief.
- **Accountability**: security findings are tracked to closure, either fixed or risk-accepted in writing. Security sign-off is required at gates and deploys.
- Proven in practice before it was formalized: the b@2.0.1 dependency event (2026-07-10). The implementer reported, the lead halted and preserved evidence, the PM verified and remediated, and policy was updated the same day.

## Cost guardrails

- Council only at gates and contested decisions (its cost ≈ 6 task reviews).
- Leads batch tasks: one lead context amortizes across 3–4 tasks instead of paying PM-dispatch overhead per task.
- Workers get verbatim plan tasks: zero discovery cost by design.
- The PM never re-reads implementation output; leads summarize.
