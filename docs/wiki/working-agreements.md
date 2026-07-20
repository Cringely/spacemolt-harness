# Working agreements: how this team operates

This page is the repo home for the project's **process and behavior** agreements, the *how we work* rules the developer-agent team keeps learning. It is the sibling of `docs/wiki/engineering-lessons.md`: that page holds the **technical** lessons (how the harness and the pilots should behave), this one holds the **operational** ones (how the people-and-agents building it should behave). A rule about the product goes there; a rule about the team goes here.

These agreements used to live in an operator's personal, account-level memory. They were moved into the repo on purpose: knowledge that governs how the project runs should be versioned with the project, portable to any tool or teammate, and reviewable like any other change. Account memory is for cross-project personal habits, not for this project's rules.

## The problem these solve

Every agreement below was written down before it was ever missed, and then missed anyway. The lesson the project drew from that shapes everything here, so it is worth stating once:

> Writing a rule down does not make it get followed. Reliability comes from a **forcing function** (a mechanism that fires at the moment the rule matters): the system does it for you (automate), a check catches you at the trigger (gate), or the rule is re-surfaced into view right when it applies (just in time). A rule that lives only as prose in a file you read once is a rule you will drop.

`.claude/guardrails.md` is the enforcement view: it maps each agreement below to the specific forcing function that catches it (and which are automated, gated by a hook, or re-injected at session start). Read this page to understand *why* each agreement exists; read that file to see *how* it is enforced.

---

## 1. Documentation freshness is part of "done," not a chore for later

A handoff is only as good as its last update. The operator's whole view of a remote, autonomous team is the living docs: `docs/STATE.md`'s `## NOW` block, `docs/milestones.md`, the README progress section. When those lag behind what merged, the operator is steering with a stale map, and the failure is silent. Nothing errors; the docs just quietly lie.

This recurred badly enough (STATE lagging batch merges, the milestone tracker going stale across ~20 merged PRs) to become a standing role. After every merge cluster a **doc-steward** agent reconciles the living docs against reality *before* the next batch dispatches. Freshness is now a definition-of-done condition for a merge cluster, the same way passing tests is a definition-of-done for a commit. If a person reading only the docs would be misled about where the project stands, the cluster is not done. See the Doc Steward role in `docs/wiki/team-structure.md`.

## 2. Be a thought partner, not a yes-man

The most useful thing a collaborator does is tell you when you are about to make a mistake. An agent that agrees with every proposal is worse than useless: it launders a bad idea as a reviewed one. The agreement is to **push back for real**. When the operator (or a lead) proposes something consequential, the job is to stress-test it, not to validate it.

Two concrete practices make this real rather than a slogan:

- **Pre-mortem consequential ideas.** Before committing to a choice that is expensive or hard to reverse, imagine it has already failed and ask what went wrong. Name the failure modes out loud, then decide. A cheap, reversible choice does not need this; a one-way door does.
- **Monte Carlo only where a real distribution exists.** It is tempting to dress an opinion up as quantified rigor: running a simulation, quoting a probability, putting a number on a hunch. Only do that when you have a real distribution of inputs to draw from. Simulating over made-up ranges produces false precision, a confident-looking number with nothing underneath it, which is more dangerous than an honest "I don't know, here's my reasoning." When the distribution is real, quantify; when it isn't, argue the logic plainly and say so.

When the pushback fires on a consequential decision, the output is a **structured DA brief**, not freeform disagreement. Four fields, adopted from the 2026-07-13 squad council (the format is squad's; the council's own devil's-advocate seat producing the evaluation's highest-value finding is the receipt): (1) the **steelman** of the proposal, (2) its **load-bearing assumptions**, (3) a **pre-mortem** (it failed; what went wrong), (4) **one concrete alternative**. Never a veto. Decision-triggered, never always-on: an always-on skeptic degrades into rating everything "unverified", a verdict nobody reads.

Genuine pushback is a judgment rule that no script can perform for you, so its forcing function is a just-in-time reminder surfaced at session start, not automation.

## 3. Cap agent concurrency, and verify liveness: silence is not progress

Running many agents in parallel multiplies both cost and coordination risk, and it is easy to spin up more than the work needs. Keep concurrency to what the task genuinely requires; each parallel agent should independently justify its own existence, not ride along for convenience.

The subtler half of this agreement is about **liveness**. A dispatched agent that has sent no completion notice is not necessarily working; it may be stuck, looping, or dead. Treat silence skeptically and verify that progress is happening rather than assuming a quiet agent is a busy one. This is the team-level version of the same instinct the pilots' progress heartbeat encodes (`engineering-lessons.md` L-17): a component's silence is ambiguous, so build a positive signal you can check instead of inferring health from the absence of alarms.

## 4. Review is always delegated: never grade your own work

An authoring context re-reads its own assumptions as facts. It is structurally blind to the gaps it built in, because the same reasoning that produced the gap is the reasoning reviewing it. So every specification, plan, and code change is reviewed by a **fresh context that did not author it**: an independent reviewer, a security auditor, a council at a gate, whichever fits the artifact.

This is not ceremony. Independent reviews on this project have caught real safety holes the author could not see: a reviewer predicted the exact transient-phrasing gap that later leaked in the field, and a milestone gate found a compound safety hole that lived across two separately-reviewed files (see `engineering-lessons.md` L-14). The only thing that skips review is a change with no logic to review, a typo or a version bump, and that gets *no* review, not a self-review. When a process step says "review your own work," that is the signal to dispatch a fresh agent instead.

**This applies to policy documents, not just code (tightened 2026-07-13).** A change to a working agreement, a charter, team-structure, or any other rule the team operates under is reviewed by a fresh context before merge, the same as a code change; the orchestrator authoring a rule is exactly as blind to its gaps as an implementer authoring a diff. The tightening exists because the seat had been self-merging its own policy edits under the STATE-freshness exemption, which was written for the handoff, not for rules. Exempt (no logic to review): `docs/STATE.md` NOW-block refreshes, the generated `docs/backlog.md`, and typo-class fixes. Operator-directed wording lands verbatim either way; the review checks coherence with existing rules and unintended consequences, not the operator's intent.

## 5. Preconditions are checked deterministically, not remembered

A rule about the world that lives only in a briefing is a rule the model will eventually forget under load. When a precondition can be checked in code, check it in code. The pilots' whole guard kit is built on this: wait for the `in_transit` flag to clear rather than trusting the model to remember that jumps take a tick (L-7); verify the sale actually moved cargo rather than trusting a success envelope (L-6); use the authoritative item id, not a name the model might mistype (L-16).

At the team level, prefer a deterministic guard, a normalizer, or a schema over "the agent will remember to." A checked precondition is a lesson made permanent; a remembered one is a lesson waiting to be re-learned expensively. So every new deterministic guard is also paired with an improv-mode briefing line (AGENTS.md): the deterministic code is the crystallized lesson, and the briefing carries it over when a model drives instead (L-9).

## 6. Decision-log discipline: write down what you chose *and what you rejected*

Every significant choice gets an entry in `docs/decisions.md`, written for an infrastructure engineer, not a developer. The entry must show the decision as it was actually made: the problem, the **options that were on the table** with the tradeoffs of each, and why the winner beat the alternatives. If only one option was genuinely considered, say so plainly; do not invent a fake debate.

The point is that a future reader (often a future session of this same team) can see not just what was chosen but what was rejected and why, so any later reversal is an informed one rather than a blind re-litigation. An undocumented decision forces the next person to reverse-engineer the reasoning from the code, and they will usually guess wrong. "If it isn't written to the repo, it didn't happen."

## Done means green CI and a clean deploy, not offline tests

A change is not done when `bun test` passes locally. It is done when the CI **build is green** and the **deploy is healthy**. The gap between those cost us a real outage: CI ran red on main for hours (a vendored data file sat outside the Docker copy path) while merges kept landing on offline tests alone, and because the auto-deploy is gated on a green build, the live pilot silently ran a stale image for hours, missing fixes we believed we had shipped.

The loop, on every PR:

1. Open or update the PR. The `container` workflow runs the build (the Dockerfile's own test gate), so the build is verified **before** merge, not after.
2. If CI is red: read the failure, fix it, push, and **comment on the PR** annotating what failed and what the fix was. Repeat until green. Never merge a red build.
3. Merge only on green. Then verify the **deploy**: the host auto-deploy pulls within ~1 min. Confirm the deploy marker advanced and the container is healthy. An unhealthy deploy is a red state too; roll back or fix, don't leave it.
4. Agents own this loop for their own PRs (or the PM runs the CI-green-then-deploy-clean gate before merging on their behalf). An agent that stops at "offline tests pass" has not finished.

This is a forcing function, not a reminder: the pre-merge CI gate (the `pull_request` trigger) makes a red build **block** the merge structurally. Reliability lives in the pipeline, not in remembering to check. Running CI on PRs has real security ramifications, mitigated in the workflow: use `pull_request` (never `pull_request_target`), keep the PR-verify job least-privilege (`contents: read`, no write token, no publish), GitHub-hosted runners only, SHA-pinned actions. The full rationale is in the security header of `.github/workflows/container.yml`.

---

## How this page relates to the others

- `docs/wiki/engineering-lessons.md`: the **technical** curriculum (how the harness and pilots behave). This page is its operational sibling.
- `docs/wiki/team-structure.md`: the roles and communication protocol that these agreements run on (PM, tech lead, implementer, reviewer, doc steward, council).
- `docs/wiki/simplicity-rules.md`: the fix-quality rules (fix the producer, complexity needs a receipt) that agreement 5 leans on.
- `.claude/guardrails.md`: the **enforcement** view: each agreement above mapped to the forcing function (automate / gate / just-in-time) that actually catches it, plus the committed hooks.
