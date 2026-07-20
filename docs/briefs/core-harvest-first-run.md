# Core-harvest first run: reconciliation work order

Written by the agent-harness-core session (same operator), 2026-07-19. The `core_harvest`
ceremony (docs/wiki/team-ceremonies.md) has `last_run: null` in the ledger, so it fires at the
next consult. This brief scopes that first run: it is bigger than a steady-state harvest because
the two repos have never been reconciled. Operator directive: spacemolt's improvements merge
upward into core FIRST; the steady-state loop comes after.

## Ground rules (no-havoc)

- Nothing in this run touches src/, the pilot, or any runtime state. `.claude/` and docs only.
- The installer's default mode never overwrites a modified file; `-Audit` writes nothing.
- Run this between waves, not mid-flight. It fits one session comfortably.

## Steps

1. **Mechanical drift list.** Run:
   `pwsh E:\projects\agent-harness-core\install\Install-Harness.ps1 -Target E:\projects\spacemolt -Audit`
   Expect mostly `untracked` statuses (this layer predates the manifest).

2. **Answer the three reconciliation questions.** You hold the context core lacks:
   - `hooks/wave-close-handoff.sh` (~56 lines vs core) and `hooks/session-start-guardrails.sh`
     (~11 lines): do your versions carry post-extraction fixes worth promoting, or is the delta
     just core's later genericization? List any bugs fixed there since 2026-07-16.
   - Project-only files: `agents/strategy-reviewer.md`, `agents/security-auditor.md`,
     `agents/docker-expert.md`, `hooks/lint-doc-prose.ts`. Which are transferable to any project
     vs spacemolt-specific? Core session's guess: security-auditor and lint-doc-prose promotable,
     strategy-reviewer and docker-expert project-specific. Correct it.
   - Agent-def shape: your thin frontmatter + `docs/charters/*.md` pointer vs core's
     self-contained defs. Which pattern held up better in daily use? Core standardizes on the
     winner.

3. **File the answers as artifacts, not prose** (per the ceremony's step 3):
   - One GitHub issue per promotion candidate on `Cringely/agent-harness-core`
     (`gh issue create --repo Cringely/agent-harness-core`), each carrying the file, why it
     transfers, and what needs genericizing (`{{PROJECT}}` placeholders, project paths out).
   - One decision-log entry in docs/decisions.md recording the reconciliation verdicts,
     including the agent-def-shape call.
   - If your hook deltas are pure genericization (nothing to promote), say so in the decision
     entry; that clears the way for core's versions to come down on a later run.

4. **Do NOT run the installer in write mode this run.** Baseline planting (manifest creation)
   happens after core has absorbed your promotions, so the manifest records the merged state,
   not the pre-merge fork. The core-side session watches the issues and handles the core
   commits.

5. **Stamp `core_harvest.last_run`** in `.claude/ceremony-ledger.json`.

## Why issues, not messages

Session-to-session messaging between interactive sessions isn't currently routable, so
GitHub issues on the core repo are the durable cross-repo channel: your harvest files them,
the core session (any future one) reads them. Same channel in steady state.
