# Guardrails — the rules this project keeps dropping, and the forcing functions that catch them

**Read this first, every session.** These are the judgment rules that got written down and then
missed anyway. They are surfaced here — and re-injected at session start by a hook — because of one
meta-lesson this project paid for:

> An LLM is not made reliable by better instructions. Reliability comes from **forcing functions**
> that fire at the moment a rule is relevant. Every rule dropped in a session was already written
> down somewhere; louder prose would not have helped. A missed rule is a **harness gap**, not a
> willpower failure — the project's own Agent = Model + Harness lesson (see
> `docs/wiki/engineering-lessons.md` L-1) applied to the developer-agent itself.

## The forcing-function hierarchy (prefer the earliest that fits)

1. **AUTOMATE it away** — the system just does it, nothing to remember. Best for mechanical rules.
   (Example: the doc-steward regenerates STATE/milestones after every merge cluster.)
2. **GATE the trigger** — a hook or check at the exact action reminds (or, rarely, blocks). Best for
   must-do-at-a-known-moment rules. (Example: a post-merge reminder to refresh the docs.)
3. **JUST-IN-TIME re-inject** — surface the rule into context the moment its trigger fires, not
   buried at session start where it scrolls away. Best for judgment rules that no script can perform
   for you. (Example: this file's top block, re-shown at session start.)

Everything project-specific lives in the **repo**, not at the account level, so it is versioned,
portable, and reviewable.

**Never chain a `gh` state-changing command with a dependent follow-up in one Bash call.** Three
times paid: #236 merged over a red verify (`gh pr checks && gh pr merge` — the check's failure
didn't stop the merge); 2026-07-16 a `gh pr merge` failed on conflicts while the chained branch
deletion ran anyway, closing PR #283 unmerged; and 2026-07-20 `gh pr checks 465 --watch | tail -3
&& gh pr merge 465` merged on red because the pipe through `tail` replaced gh's nonzero exit with
`0`. Check the result of each state-changing step BEFORE issuing the next: separate tool calls,
always. Prose failed three times at three seams, so this is now a GATE — a `PreToolUse` Bash hook
(`.claude/hooks/gh-chain-merge-gate.ts`, hook 5 below) DENIES a `gh pr merge`/`gh pr close`/`gh
repo delete` that sits downstream of a `&&`, `||`, `;`, or `|`. Conscious override: put
`GH-CHAIN-OVERRIDE: <reason>` in a comment on the command.

**Every `gh pr merge` carries `--delete-branch`.** 72 merged-PR corpse branches had accumulated
by 2026-07-18 and had to be bulk-deleted; the flag makes the cleanup free at the moment it is
cheapest. A local-delete failure on a branch a worktree still holds is harmless noise — the
remote delete still lands.

<!-- guardrails:session-start-end — the SessionStart hook prints everything ABOVE this line. Keep the key JIT rules above it. -->

## The catalog — each recurring miss mapped to its forcing function

The full "how we work" explanations live in `docs/wiki/working-agreements.md`. This table is the
enforcement view: rule → the forcing function that fits it → status.

| Recurring missed rule | Forcing function | Type | Status |
|---|---|---|---|
| **STATE.md `## NOW` freshness** — the handoff lags behind merges | Doc-steward regenerates the `## NOW` block after every merge cluster; freshness is definition-of-done | automate | done |
| **Milestone-artifact currency** — the claude.ai milestone tracker goes stale | Doc-steward reconciles `docs/milestones.md` (the Artifact's SSOT); PM republishes the Artifact from it | automate | done |
| **Doc-freshness after a merge** — living docs drift from reality | Doc-steward pass is part of definition-of-done (AGENTS.md gate) **and** the wave-close handoff hook (`wave-close-handoff.sh`, #276) fires at `gh pr merge` with a STATE-staleness warning | automate + gate | done (#276) |
| **Genuine pushback (thought partner, not yes-man)** — consequential ideas shipped without a pre-mortem | Session-start JIT reminder (no script can judge for you) | JIT | this-PR |
| **Independent review, never self-review** — the author grades their own work | Session-start JIT reminder; role is defined in team-structure.md | JIT | this-PR |
| **Agent concurrency cap + verify liveness** — too many parallel agents; silence assumed to mean progress | Session-start JIT reminder | JIT | this-PR |
| **Preconditions checked deterministically, not remembered** — a rule about the world lives only in prose | Deterministic guards / normalizers in code (the L-7/L-15/L-16 pattern) | pattern | ongoing |
| **Decision-log discipline** — a significant choice merges with no decisions.md entry | Convention in AGENTS.md; caught at PR review | convention | ongoing |
| **Living docs stay concise** — the educational register drifts into essays; decisions.md hit 136 KB one 700-word entry at a time, the STATE `## NOW` handoff hit 1,776 words | `test/doc-size.test.ts` fails `bun test` and NAMES the offender, gating the UNIT OF WORK: 400 words per NEW decisions entry (+ required options/decision shape), 500 words for `## NOW`. Whole-file/whole-page byte caps are deliberately NOT gated (operator ruling 2026-07-14 — they punish whoever tips the file over); whole-file size is a doc-steward archival trigger. The cap is a brevity gate, never a content gate: an entry that would have to drop a rejected option or a receipt gets grandfathered instead. In CI the gate fires via the dedicated `docs-gate` workflow on `docs/**` changes — container.yml path-filters docs out of its `bun test` job, so docs-only PRs skipped exactly the files this gate gates (PR #305 merged a 402-word entry green; #308) | automate | done (CI trigger #308) |
| **Inter-agent traffic stays telegraphic** — the compression rule is prose, and prose did not hold: completion reports run 300-800 words when the dispatching seat needs five facts | Five-field completion template (SHIPPED / EVIDENCE / FINDINGS / BLOCKERS / FILES, 150 words excluding evidence). The dispatching seat pastes the empty template into every brief, and BOUNCES a prose report with one word: "reformat". Falsifier on the clock: sample the next 10 reports — median > 250 words means the textual fix failed and it must become a hook | gate | done (this PR) |
| **AI-tell prose in human-facing docs** — the operator reads the living docs and the tells are the complaint | `prose-lint` skill (Vale, ai-tells + Cringely styles) run at the doc-steward pass (charter step 8) **and** a `PostToolUse` hook (`lint-doc-prose.ts`) that fires Vale on every Write/Edit to a living-doc path, advisory — closes the gap between steward passes where PM/implementer edits shipped unlinted (#247) | convention + automate | done (#247) |
| **Worktree isolation for repo-writing dispatches** — a repo-writing agent dispatched into the shared checkout collides with the dispatcher's branch (#192, 2nd occurrence) | `PreToolUse` hook on the Agent tool denies the dispatch with a fix-it message unless `isolation` is set or a written override is in the prompt | gate | done (#192) |
| **Isolated agents still mutate the MAIN checkout** — a worktree-isolated agent cds into the shared checkout and runs state-changing git there (lead-413 2026-07-18; a reviewer left `pr-452-new` checked out on main 2026-07-19 — both despite explicit brief prose forbidding it) | Runtime gate designed in #456: deny state-changing git targeting the repo root from subagent Bash calls; the subagent-detection mechanism is the load-bearing unknown to prove first | gate | filed (#456) |
| **Dead worktrees + merged branches pile up** — `gh pr merge` leaves the remote branch, the harness leaves the agent worktree after its agent commits, nothing prunes on a cadence (the repo hit 41 worktrees / ~50 branches before a manual cleanup) | Always `gh pr merge --delete-branch` — deletes the REMOTE branch at merge; `scripts/repo-hygiene.ts` reaps dead LOCAL agent worktrees + merged/orphan-scaffold branches every stand-up (SOC-monitor charter step 5) and reports unmerged/open-PR branches for a human. Pure planner + thin executor; never removes a locked (live-agent) worktree or an open-PR branch | automate | this-PR |
| **`gh` state-changer chained after another command** — a `gh pr merge`/`close` runs when an upstream step's exit code masked a failure (#236 merged over red; 2026-07-16 chained delete closed PR #283 unmerged; 2026-07-20 #465 merged on red because a pipe through `tail` replaced gh's nonzero exit with 0). Prose failed three times at three seams | `PreToolUse` Bash hook `gh-chain-merge-gate.ts` (hook 5) DENIES a `gh pr merge`/`gh pr close`/`gh repo delete` sitting downstream of `&&`/`||`/`;`/`|`; message says split it into its own Bash call. Override: `GH-CHAIN-OVERRIDE: <reason>` in a command comment | gate | done (#466) |

**Status legend:** `done` = the forcing function exists and runs. `this-PR` = added by the guardrails
harness (#125). `ongoing` = a standing practice enforced by convention/review, not a one-time build.

## The committed hooks (see `.claude/settings.json`)

These are repo-level, side-effect-free except printing, and fast. The operator reviews every hook
script personally, since they run on the operator's machine. Hooks 1, 2, and 4 are WARN-only (never
block a tool); hooks 3 and 5 are the deliberate exceptions — they DENY, because each codifies a
rule that warn-prose already failed to hold (#192 for hook 3; three seams for hook 5).

### 1. `SessionStart` → `.claude/hooks/session-start-guardrails.sh`

- **Fires on:** every session start (startup, resume, clear).
- **Does:** prints this file from the top down to the `guardrails:session-start-end` marker, so the
  key judgment rules and the forcing-function hierarchy land in context at the start of every
  session. Pure read-and-print; if the file is missing it prints nothing and exits 0.
- **Why a hook and not just prose in AGENTS.md:** AGENTS.md is loaded once and scrolls away; the
  hook re-injects the rules on every fresh context, including resumes. That is the JIT tier of the
  hierarchy above.

### 2. `PostToolUse` (matcher `Bash`) → `.claude/hooks/wave-close-handoff.sh`

- **Fires on:** any `Bash` tool call whose command text contains `gh pr merge` (the script inspects
  the tool input on stdin; every other Bash call is a silent no-op). Replaced the earlier
  `post-merge-doc-reminder.sh` (#276): a reminder alone proved weaker than writing the handoff.
- **Does:** regenerates `.claude/wave-state.md` — a generated view (same class as `docs/backlog.md`,
  never hand-edited) carrying the session-local facts STATE.md deliberately does not: what just
  merged, which PRs sit where in the review loop, which ceremonies are overdue. Also warns if the
  STATE `## NOW` block looks stale relative to the merge that just landed. WARN-only, exit 0 always.
- **Why:** clearing context between waves is the single largest cost lever (usage telemetry: 65% of
  a day's burn from >150k-context turns), and the hook makes the clear free by making the handoff
  deterministic.
- **Known limitation (deliberate):** it only matches merges run through the `gh` CLI via Bash. A
  merge done through the GitHub MCP tool won't trip it. That is an accepted gap — matching the CLI
  path covers the normal PM workflow, and a hook that tried to catch every possible merge path would
  need brittle detection that produces false positives, which get ignored and defeat the purpose.

### 3. `PreToolUse` (matcher `Agent|Task`) → `.claude/hooks/agent-worktree-gate.ts`

- **Fires on:** every subagent dispatch (the tool is named `Agent` in current builds, `Task` in
  older ones — the matcher covers both; an alternative that never matches just never fires).
- **Does:** if the dispatch's `subagent_type` is not provably read-only AND the dispatch has no
  `isolation` (`worktree` or `remote`), it denies the tool call with a message telling the
  dispatcher to re-dispatch with `isolation: "worktree"`, switch to a read-only agent type, or
  consciously override by writing `ISOLATION-OVERRIDE: <reason>` in the agent prompt (the reason
  is required — a bare token does not pass).
- **How "repo-writing" is decided — derived, not hand-listed:** the ground truth is the
  `tools:` frontmatter of `.claude/agents/<type>.md`. A role is exempt only when every tool it
  is granted is on the hook's provably-read-only allowlist (Read, Grep, Glob, WebFetch,
  WebSearch, ToolSearch); an absent or empty `tools:` field means all tools and requires
  isolation, and so does any tool not on the allowlist. A definition file that exists but can't
  be read makes that type require isolation (fail toward safety — this is not the hook-level
  fail-open, which is reserved for malformed stdin and internal errors). Types with no
  definition file: only the built-ins are hardcoded — Explore and Plan are read-only per their
  published grant; `general-purpose`, `fork`, and an omitted type (the tool's default is
  general-purpose) are all-tools; every other unknown type requires isolation, because an
  unknown role is not evidence it is read-only. Consequence worth knowing: charter roles with
  no `tools:` restriction (task-reviewer, doc-steward, soc-monitor, adversarial-reviewer, …)
  require isolation even when their charter says they only read — the gate trusts the grant,
  not the prose. Worktree isolation is auto-cleaned when nothing changes, so a read-only run
  in a worktree USUALLY costs nothing — with one named exception class (PR #201 re-review):
  a role whose input is gitignored/untracked local state (e.g. a local `harness.sqlite`) loses
  that input in a fresh worktree, because worktrees contain only tracked files. Such a dispatch
  must either carry `ISOLATION-OVERRIDE: <reason>` or have the state copied in — and the role
  must treat a MISSING store as a loud error, never as "nothing to report." The strategy-reviewer
  avoids this in production by reading the store over authenticated HTTP (bearer token, three
  fixed ops via `scripts/strategy-store.ts` — no SSH, no docker-exec, #114 A1), so isolation is
  safe for it. (This replaced the original hand-maintained `REPO_WRITING_TYPES`
  constant after PR #201 review found it had already drifted: `docker-expert` — Write/Edit/Bash
  in its frontmatter — bypassed the gate. A hand-copied list is the same
  rule-a-human-must-remember failure #192 was about.)
- **Why deny, not warn:** #192 was the second occurrence of the exact failure the rule's prose
  already forbade — a doc-steward dispatched into the shared checkout committed onto the branch
  the PM was editing. A warning is the prose again, one line lower. The in-prompt override token
  keeps a conscious bypass possible without muting the hook in settings.json (a muted hook
  protects nothing).
- **Why bun, not sh like the other hooks:** the decision reads structured fields out of a payload
  whose `prompt` is arbitrary text; the sh-convention raw grep was rejected because a prompt
  merely *mentioning* `isolation: "worktree"` would wrongly pass. Bun is already the project's
  hard dependency and parses the JSON properly.
- **Fail-open:** any hook error (malformed stdin, our own bugs, even `bun` missing from PATH)
  allows the dispatch — exit 0 with no stdout, or a non-2 exit, both of which Claude Code treats
  as non-blocking. A broken gate must never brick dispatching. Only a well-formed deny emits the
  `hookSpecificOutput.permissionDecision: "deny"` JSON (exit 0, per the hooks docs). An
  unreadable agent-definition file is deliberately NOT fail-open (see above): it fails toward
  requiring isolation for that one type.
- **Tests:** `bun test test/agent-worktree-gate.test.ts` — offline unit tests on the exported
  `decide()` (derived classification against the real repo frontmatter plus a synthetic temp
  agents dir) and spawn tests pinning the stdin→stdout contract (blocked, allowed,
  malformed-input fail-open). Runs as part of the normal `bun test` suite.

### 4. `PostToolUse` (matcher `Write|Edit`) → `.claude/hooks/lint-doc-prose.ts`

- **Fires on:** every `Write` or `Edit` whose target is a living-doc prose file — root `README.md` or
  anything under `docs/`, ending `.md`/`.markdown`. Generated files (`docs/backlog.md`,
  `docs/assets/*`) and the vendored `docs/game-reference/*` are skipped; the project's own
  `.claude/`, `node_modules`, etc. are not under `docs/`, so the allowlist already excludes them.
- **Does:** runs Vale (the ai-tells + Cringely styles kit) on the changed file and injects any
  findings back as `PostToolUse` `additionalContext` for the writing agent to address or wave off in
  the PR body. Advisory, never blocking — a deny would stop a STATE-freshness update on a style nit.
  This closes the #247 gap: the lint fired only at the /prose-lint skill and doc-steward step 8, so
  PM/implementer edits BETWEEN steward passes shipped unlinted, and the living docs are the
  operator's remote view where AI-tell prose is the named complaint.
- **Why versioned in the repo:** the trigger existed only as a machine-GLOBAL PostToolUse hook on the
  operator's settings.json — a fresh clone, a teammate, or CI got nothing. Versioning the hook here
  fires it for any Claude Code session in the checkout. The Vale STYLES stay the prose-lint skill's
  kit (its SSOT is the beautiful_prose skill + the Cringely style builder + `vale sync`); vendoring
  288K of styles into the repo would duplicate that SSOT and need a network `vale sync`, so the hook
  resolves the kit instead (`PROSE_LINT_VALE_CONFIG` env override, then a repo-vendored kit if a
  future PR adds one, then the machine-global kit).
- **Degrade gracefully — zero new runtime deps for the harness:** Vale is an external tool a clone or
  CI runner may not have, and the kit may be absent too. A missing config or missing `vale` binary is
  an advisory skip with a one-line stderr notice, exit 0 — never a blocked write. An unsynced Vale
  package errors to stderr, which the hook ignores (it reads only stdout findings), so it degrades to
  silence rather than injecting Vale's error text as if it were prose findings.
- **Why bun, not sh:** same reason as hook 3 — it parses structured JSON (`tool_input.file_path`)
  off stdin, and the decision logic (`shouldLint`/`planLint`) is a pure exported function so the
  scoping and graceful-skip paths are unit-tested offline with no Vale, no spawn, no network. Bun is
  already the project's hard dependency.
- **Fail-open:** any hook error (malformed stdin, our own bug, a broken spawn) is a silent no-op at
  exit 0. A prose linter must never break a document write.
- **Tests:** `bun test test/lint-doc-prose.test.ts` — the acceptance list (wiki/decisions/STATE lint;
  generated + vendored paths do not) maps directly onto `shouldLint`, plus `planLint` degradation and
  `resolveValeConfig` resolution order. Runs as part of the normal `bun test` suite.

### 5. `PreToolUse` (matcher `Bash`) → `.claude/hooks/gh-chain-merge-gate.ts`

- **Fires on:** every `Bash` tool call (it reads the command off stdin; a call with no gh
  state-changer is a silent no-op).
- **Does:** DENIES the call when a state-changing gh verb (`gh pr merge`, `gh pr close`, or
  `gh repo delete`) appears downstream of a chaining operator (`&&`, `||`, `;`, `|`, or a
  newline) in the same command string. A state-changer that is the sole or the FIRST command is
  allowed — its own exit is visible, so nothing upstream could have masked it. The deny message
  says: run the state-changing gh command as its own Bash call.
- **Why deny, not warn (3rd occurrence):** the rule was in this file AND re-injected at session
  start, and it was still slid past three times at three different seams — #236 (`gh pr checks &&
  gh pr merge`, merged over red), 2026-07-16 (chained delete closed PR #283 unmerged), and
  2026-07-20 #465 (`gh pr checks 465 --watch | tail -3 && gh pr merge 465` — the pipe through
  `tail` replaced gh's nonzero exit with `0`, so `&&` passed and the merge landed on red). Prose
  that fails three times is a harness gap; per the forcing-function hierarchy it graduates to a
  GATE. This is the #192 pattern: a deterministic string check on the very call it judges, no
  state, no counting.
- **Override:** to run the chained one-liner consciously, put `GH-CHAIN-OVERRIDE: <reason>` in a
  comment on the command — the reason is required (a bare token does not pass), and it keeps a
  bypass possible without muting the hook (a muted hook protects nothing).
- **Scope (deliberate):** only gh state-changers are gated. The #283 seam's destructive step was a
  chained *git* branch deletion, which this gh-verb gate does not target; a denylist for every
  destructive follow-up after any command would produce false positives, get muted, and protect
  nothing. This catches the two gh-merge-on-red seams verbatim and the general class of a gh
  state-changer landing downstream of a masked exit.
- **Why bun, not sh:** it must tokenize a command on shell operators without being fooled by `||`
  vs `|` or by the override token, and the decision logic is a pure exported function unit-tested
  offline. Bun is already the project's hard dependency.
- **Fail-open:** any hook error (malformed stdin, our own bug) logs to stderr and exits 0 with no
  stdout. This hook runs on EVERY Bash call, so a broken gate must never brick the tool.
- **Tests:** `bun test test/gh-chain-merge-gate.test.ts` — the two verbatim historical strings are
  load-bearing regression fixtures, plus operator coverage, the standalone/first-command allow
  cases, the word-boundary guard, and the override paths. Spawn tests pin the stdin→stdout deny
  contract and fail-open. Runs as part of the normal `bun test` suite.

## Why only these five hooks

The candidates that were considered and **dropped**, so the reasoning is on record:

- **A `Stop` hook that flags a stale STATE `## NOW` block.** Dropped: reliably deciding "is STATE
  stale?" needs brittle heuristics (diffing merged PRs against the NOW block). A false "you forgot to
  update STATE" on a session that touched no code trains the operator to ignore the hook. The
  doc-steward role already automates this at the right moment; a nagging Stop hook is worse than the
  automation that already exists.
- **A hook that blocks commits to `main`.** Already covered by the versioned `.githooks/pre-push`
  hook — no need to duplicate it in the Claude layer.
- **A `PreToolUse` gate that blocks over-concurrency.** Dropped: counting live agents reliably from a
  hook is brittle, and blocking is exactly the high-friction behavior the operator asked to avoid.
  The concurrency cap stays a JIT reminder (judgment rule), not a block. (The #192 worktree gate is
  different in kind: it checks a field on the very tool call it judges — deterministic, no state,
  no false positives from counting.)

A false-positive hook gets muted, and a muted hook protects nothing. A handful of reliable hooks beat
a pile of noisy ones — and hook 4 stays advisory precisely so it never earns a mute.
