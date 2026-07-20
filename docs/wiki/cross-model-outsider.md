# Cross-Model Outsider: a second opinion from a different vendor

Independent review is a binding rule here: a fresh agent reviews what another agent built. This page covers the stronger version of "fresh," a reviewer that is not just a new context but a different model family entirely, and how far we have decided to take it.

## The blind-spot problem

Two Claude agents were trained by the same company, on overlapping data, with similar methods. A fresh Claude context catches what the author's context missed, and that is worth a lot. What it cannot catch is what the whole family misses together: the shared habits, the shared gaps. Think of a second medical opinion. A doctor from the same practice, trained at the same school, is better than no second opinion, but a doctor from a different tradition is the one who questions the assumption both of the first two inherited. For us, the different tradition is OpenAI's GPT models, reached through their Codex command-line tool on the operator's ChatGPT subscription.

## What is already wired

None of this is hypothetical; the plumbing exists and has been proven:

- codex-cli 0.144.3 is installed on the workstation, with the exact invocation contract verified live on 2026-07-17 (the header comment in `src/planner/codex-subscription.ts` documents it).
- The `codex-subscription` planner provider is wired into the harness (`src/config/planner-factory.ts`) and into the offline eval runner (`src/eval/run.ts`).
- It scored 100% on the 28-case pilot eval (M-39 in `docs/milestones.md`), the qualification gate every planner model must pass before flying live.

## The three authorized uses (operator, 2026-07-19)

The operator weighed four possible uses and adopted three.

1. **Independent outsider on high-stakes judgment.** The top use. When a review, a council seat (one voice in a milestone review, `docs/wiki/team-ceremonies.md`), or a spec gate (the approval step before building, `docs/wiki/team-structure.md`) decides something expensive to get wrong, one seat goes to Codex so at least one opinion comes from outside the family.
2. **The live pilot A/B.** codex-subscription is a qualified provider, so flying the pilot on GPT for a comparison window is a config flip, nothing more. One flight already happened; it ended inconclusive because an unrelated briefing defect confounded the result (decisions.md, 2026-07-19, the no-credits latch).
3. **A second opinion on the PM's own consequential diagnoses.** The PM is an agent too, with the same family blind spots. Before a costly conclusion turns into action, an outsider can be asked to check the reasoning.

## The review seat, made concrete (`scripts/codex-review.ts`)

Use 1 above is now a script anyone can run. `bun scripts/codex-review.ts <pr-number>` gathers the PR's diff and description, hands them to Codex under the same review contract our Claude reviewers follow (report every finding with a severity and a confidence, cite file:line, end on ADVANCE or REVISE), and prints Codex's verdict to the terminal.

When to reach for it: a standard-stakes PR where a second opinion from outside the Claude family is worth the half-minute. The seat is ADVISORY and stays that way. Codex produces findings; a Claude reviewer reads them and still owns the ADVANCE/REVISE call and the merge. Nothing here moves the decision off the Claude review path.

How it stays safe reuses the planner's proven contract, stated plainly (the planner's own comment in `src/planner/codex-subscription.ts` sets the pattern: say what the sandbox blocks and what it does not). Codex runs in its tightest sandbox, `--sandbox read-only`, which stops network access but still lets the model run shell commands against anything the container user can read. `--ignore-user-config` keeps the operator's plugins and MCP servers from loading, and `--cd` points codex at an empty scratch directory so it does not auto-discover this repo as a workspace. Neither flag stops a directed read: a codex plan can still run a shell command against an absolute path outside that scratch directory, including this repo or its secrets, the same weaker read boundary the planner accepts. What actually bounds it: no network means nothing a command reads can leave over the wire; the subprocess gets a curated environment allowlist, so no repo secret reaches it through env vars (on-disk files are a separate question, not covered by that allowlist); the one output channel is the verdict text printed to stdout, which a human (operator or Claude reviewer) reads before anything acts on it; the review seat is advisory only, never the merge decision; and the diff text it reads comes from this private repo, where an author already has push access. Auth is the operator's own `codex login`, checked for existence but never read or logged. If nobody has logged in, the script says so and prints the one command to fix it (`codex login --device-auth`).

## The use we declined: bulk mechanical work

The fourth candidate, routing routine coding or doc chores to Codex to spread load, was turned down. It splits one team's output across two separate quotas for no quality gain, the command-line tool adds friction a native agent does not have, and mechanical work gains nothing from vendor diversity. It becomes worth revisiting only if the Claude pool tightens.

## The one real limit

Workflow scripts (see `docs/wiki/multi-agent-workflows.md`) spawn Claude agents natively. Codex is not a first-class workflow agent: it joins a workflow only when a Claude agent shells out to `codex exec` on the command line. That works, and it is how the outsider seat gets filled, but it is a workaround rather than a peer. The practical rule follows from it: use Codex where its diversity is the point, the outsider seat on judgment calls, and not for bulk.
