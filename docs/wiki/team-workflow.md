# Team Workflow

How work moves through the dev team: the shape of inter-agent traffic and completion reports, how tasks are batched, the failure modes we watch for, and how a change reaches the protected main branch. It split out of `team-structure.md` (#237) when that page outgrew the wiki size line: the org chart and roles stay there, and the scheduled ceremonies (stand-up loop, process retro, catch-up rule) live in `team-ceremonies.md`.

## Communication protocol

- **Downward** (PM → lead → implementer): work orders are self-contained. A worker must never need the conversation history; everything required is in the plan file, AGENTS.md, and the work order itself.
- **Code discovery pointer (operator directive 2026-07-18):** dispatch briefs for full-tool agents point them at the code-context MCP tools (`mcp__code-context__search`, path = repo root) for finding code, which searches by meaning as well as keyword. Plain Grep stays the tool for exact known strings. Agents without MCP access get a normal brief, and an agent that finds the tools absent falls back to Grep without comment.
- **Upward** (implementer → lead → PM): summaries, not transcripts. A lead reports outcomes, findings, and blockers; the PM should be able to read a batch report in under a minute.
- **Compression rule (token discipline):** inter-agent traffic is machine-to-machine, and each channel has a NAMED register (a defined style of writing) so a brief can cite it in one line instead of re-describing it. Why named registers matter (loop-engineering): a subagent's output is the next agent's input, so compressing reports also shrinks the orchestrator's context; the two "tabs" draw on the same pool. Registers govern PROSE, not structure. Where a channel has a form (the completion-report template below), the form wins and the register applies only inside the template's free-text fields; untemplated channels (PR bodies, findings lines, stand-up reports) take the register whole. The registers:
  - **Reports → caveman** (the [caveman](https://github.com/JuliusBrussee/caveman) skill's grammar: drop articles and filler, technical terms exact, code blocks and error texts verbatim). Two levels, per the skill. **caveman-full**, the default, allows fragments ("Task 2: shipped. Review caught X, fixed. 14 tests pass."). **caveman-lite** keeps full sentences, for channels where reasoning density is high (a verdict's WHY, a judgment call's basis). Charters cite which level applies. Caveman's own auto-clarity carve-out holds at both levels: security warnings, irreversible-action confirmations, and anything whose fragment-order could misread stay in full sentences.
  - **Review findings → ponytail-style**: one line per finding (location, defect, fix); no essays. The WHY of a verdict is never compressed away; review quality is the one thing token rationing never cuts (token-ration protocol).
  - **Code → ponytail-full** (the [ponytail](https://github.com/DietrichGebert/ponytail) ladder: YAGNI → stdlib → native platform → existing dep → one line → minimum code; deliberate ceilings marked with a `ponytail:` comment). Dispatched subagents do NOT inherit the interactive session's ponytail hook, so every implementer work order carries the contract line: "Ponytail rules apply — laziest correct solution; mark deliberate ceilings with a `ponytail:` comment." Ponytail's own carve-outs are part of the contract: never simplify away input validation at trust boundaries, error handling that prevents data loss, or security measures.
  - What is NEVER compressed: plan tasks and requirements (quoted verbatim; compressing them causes intent drift), reviewer PR verdicts (evidence-rich by design; they outlive the reviewer, and the ADVANCE bar requires receipts, so caveman-lite there strips filler, never a receipt or a reason), and human-facing artifacts (decisions.md, STATE.md, wiki pages, PM→user reports), which are educational deliverables in full prose (AGENTS.md educational-register rule).
- **Escalation:** implementer blocked → lead decides or escalates; lead facing a design/scope question → PM; PM facing a consequential choice → user (with a recommendation). Nobody silently decides above their pay grade.

### Completion-report template (binding, 2026-07-14)

The compression rule above was prose, and prose did not hold: completion reports ran 300-800 words while the dispatching seat needs five things. A rule nothing enforces is a suggestion, so the rule now has a form.

**Every completion report (implementer, reviewer, steward, researcher) is exactly these five fields:**

```
SHIPPED:   what now exists that did not before (1-3 lines)
EVIDENCE:  test counts, ablation results, file:line cites, command output
FINDINGS:  what the work revealed that the brief did not anticipate (or "none")
BLOCKERS:  what stopped or would stop the next step (or "none")
FILES:     absolute paths touched
```

**150-word cap, EXCLUDING the EVIDENCE lines.** Evidence is the one thing that must never be compressed. Test counts, ablation results, and file:line citations are what make a report checkable rather than a claim; the narrative around them is what the cap removes.

**Enforcement (both halves are required; the template alone is just more prose):**
1. The dispatching seat pastes the empty template as the final block of every dispatch brief. An agent that receives the form fills the form.
2. A report that arrives as prose is BOUNCED with one word ("reformat") and not read. Bouncing is cheap; reading 800 words to find five facts is not.

**Falsifier (this rule is a hypothesis, and it is on the clock).** Sample the next 10 completion reports. If the median exceeds 250 words, the template has failed, and the fix must become mechanical: a hook that rejects the shape, not a paragraph asking nicely. Recorded so the rule cannot quietly persist as decoration.

**Never compressed by this template:** dispatch briefs (requirements; compressing them causes intent drift, our own rule), reviewer PR verdicts (see above), and human-facing artifacts.
- **Artifacts are the memory:** decisions go in `docs/decisions.md`, state changes in `docs/STATE.md`, durable knowledge in `docs/wiki/`. If it isn't written to the repo, it didn't happen.

## Cadence for Plan 1

Tasks are batched by natural seams; one Engine Lead runs each batch:

| Batch | Tasks | Contents |
|---|---|---|
| A | 0, 2, 3 | Scaffold, registry + plan schema, conformance test |
| B | 4, 5, 6 | Fake server, HTTP transport, game client |
| C | 7, 8, 9, 10 | Store, executor, wake conditions, mock planner |
| D | 11, 12 | Agent loop, config + e2e + main entry |
| Gate | — | Council review of the completed plan against the spec |

Task 1 (container auth spike) runs separately once the user provides the token; it is a solo investigation, not team work.

## Known failure modes (watch for these)

- **Telephone-game drift:** each relay layer can distort intent. Mitigation: work orders quote the plan verbatim rather than paraphrasing.
- **Rubber-stamp reviews:** a reviewer that always approves is dead weight. The lead's batch report must include what reviewers *caught*; consistently empty findings on non-trivial diffs is a signal to change the reviewer prompt.
- **Lead scope-creep:** a lead "improving" the plan mid-batch. Plan deviations require PM approval, logged in the batch report.
- **PM tree-collision** (learned twice, in Batch A and the digest-salience worker, now promoted): while any worker owns the main working tree, the PM operates SERVER-SIDE ONLY: `gh pr merge <number>` (never bare), no local checkout/pull until the worker reports. Worktree-isolated workers are exempt.
- **Concurrent writers on one branch** (learned in Batch A, superseded by the PR workflow): PM doc commits interleaving with a lead's task commits risked sweeping each other's staged files into the wrong commit. The branch-per-batch PR workflow (below) is the structural fix; the staging rule (implementers stage only their task's listed files) stays as defense in depth, and the PM still avoids committing to a batch's branch while its lead is active.

## Git workflow (main is protected)

Every change reaches main through a pull request; no direct commits or pushes, enforced by the versioned pre-push hook in `.githooks/`. Each batch works on its own branch (`batch/<letter>-<short-desc>`), the lead commits task-by-task there, and after the batch report the PM verifies, opens the PR (`gh pr create`), merges (`gh pr merge`), and pulls. PM documentation work follows the same path on `docs/*` branches. Since the shared working directory can only have one branch checked out, batches and PM commits still take turns: the PR layer adds review history and protects main; it doesn't enable simultaneous checkouts (worktrees would, if ever needed).

### PR-stage review (merge-time rules)

Task-level review happens before the PR (implementer → independent reviewer → lead arbitration); the PR-stage question is only whether the *integrated whole* needs a second look:

- **Docs PRs**: merge on PM judgment; content is PM work or already independently reviewed. EXCEPT policy documents (working agreements, charters, team-structure and its split-off pages): those require an independent review before merge per working-agreements.md §4 (tightened 2026-07-13).
- **Code PRs, clean batch** (zero findings, zero deviations, zero escalations in the lead's report): merge on the report. Re-reviewing already-reviewed diffs is rubber-stamp theater.
- **Code PRs carrying an arbitrated deviation, an escalation, or an integration seam** (changes spanning components reviewed in different batches, or safety-path code): one PR-stage reviewer on the full integrated diff before merge, scoped exclusively to cross-task interactions, explicitly not re-litigating task reviews. This also neutralizes the lead-arbitrates-its-own-batch conflict in exactly the cases where it matters.

The trigger reads mechanically off the lead's report (deviations/escalations are mandatory fields). First live use: PR #6 (agent-loop safety path). The reviewer ran the suite five times probing timer flakiness, verified the fixture diff, returned zero findings, merged.

### The win comment (merge-time, binding)

Once a PR is approved to merge, the merging seat (PM or lead) drops one final comment on it before or at the merge: a plain-language note on what this PR won (the improvement, the capability, the number worth celebrating). Operator standing order (2026-07-16): the team generates text faster than a person can read it, and the win comments are the progress trail the operator actually follows. Register: caveman-lite (filler and preamble die, plain sentences a layperson can read stay); no hard length cap, the register carries the brevity (operator ruling 2026-07-16, replacing an earlier 3-6 sentence cap). Say what got better and why it matters; skip file paths and jargon. Applies to every merge, docs PRs included. It celebrates the work; it is not a substitute for the batch report or the review verdict.
