---
name: memory-system
description: "Use when writing, recalling, or maintaining persistent memory notes across projects, or when running a memory Lint (maintenance) pass."
---

# Memory System

## Purpose

This skill governs how memory notes are written, retrieved, and maintained across all projects. It extends the built-in `# Memory` harness block (injected into every session when a memory directory exists) and never contradicts it. Two hooks handle automation deterministically: `Scan-MemorySecrets.ps1` fires before any write to guard secrets and identifiers, and `Sync-MemoryToObsidian.ps1` fires after every Write/Edit to copy notes to the vault. Both are documented here but neither runs through this skill.

## Memory File Format

Every note in `~/.claude/projects/<project>/memory/` uses this frontmatter:

| Field | Required | Values / Notes |
|---|---|---|
| `name` | yes | kebab-slug matching the filename |
| `description` | yes | one line; the retrieval surface, so keep it sharp |
| `metadata.type` | yes | `user`, `feedback`, `project`, `reference`, or `decision` |
| `metadata.status` | decision notes only | `proposed`, `accepted`, `superseded`, `rejected`, or `expired` |
| `metadata.updated` | yes | `YYYY-MM-DD`; set on every write or edit |
| `metadata.confidence` | yes | `high`, `medium`, or `low` |
| `metadata.valid_until` | no | `YYYY-MM` or `YYYY-MM-DD`; add on time-bounded facts |
| `metadata.superseded_by` | no | slug of the newer note; set by Lint on supersession |

`updated` and `confidence` are required going forward. Existing harness fields (`node_type`, `originSessionId`) are untouched.

```yaml
---
name: github-app-token-scope
description: GitHub App token scopes required for compliance scanning, approved May 2026
metadata:
  type: project
  updated: 2026-05-14
  confidence: high
---
```

## The Index (MEMORY.md)

`MEMORY.md` is the always-on retrieval surface. Keep it grouped by domain with one-line pointers under each heading. No content beyond the one-liners belongs in this file.

Canonical group headings:

- Project Identity & Current State
- Policy
- Scripts & Automation
- Decisions
- Feedback & Conventions
- Platform & Reference
- Topic files

Pointer format: `- [Title](file.md) — hook`, where the hook is one clause saying what the note captures.

Example:
```
## Decisions
- [GitHub App Token Scope](github-app-token-scope.md) — scopes approved for compliance scanning app, May 2026 (accepted, high)
```

When you add a new note, add its pointer. When a note is superseded, repoint the index to the current note.

## Write Policy

One atomic fact per file. If a note bundles a decision with its rationale and a downstream constraint, split it. Notes over roughly 50 lines are candidates for splitting. Exception: a `type: decision` note is one atomic decision — its sections (evidence, alternatives, outcome) are facets of that one fact, and the 50-line guidance is relaxed for it.

Don't store what git, the codebase, or CLAUDE.md already records. Memory is for facts that need to survive across sessions without a full file read. Canonicalize dates (`YYYY-MM-DD`) and names (use the same slug every time for the same thing). Before writing a new note, check whether one already exists; update it rather than creating a duplicate. Delete notes that are provably wrong rather than leaving them in place.

Set `type`, `updated`, and `confidence` on every write. Add `valid_until` when the fact has a known expiry (a deadline, a quarterly review date, a temporary policy). Link to related notes with `[[slug]]`; a forward reference to a note that doesn't exist yet is fine.

## Decision Notes

A decision note records a consequential choice: what was chosen, why, what was rejected, when to revisit, and what happened. Only three categories qualify (the creation gate, also stated in `~/.claude/rules/change-management.md`): infrastructure/architecture, security tradeoffs, and process & agent behavior. A fix that hardened into a standing rule is an invariant (promote it to a rules file), not a decision — a decision has live alternatives and revisit conditions.

Frontmatter: `metadata.type: decision` plus `metadata.status`. On a decision note, `confidence` means confidence in the decision, not fact-reliability; the Lint contradiction scan compares decision notes only with other decision notes.

Body template:

```markdown
## Decision      — what was chosen
## Context       — what led to it
## Evidence      — [[wiki-links]], file paths, commits, URLs; facts separated from interpretation; never invented
## Reasoning     — why this over the alternatives
## Alternatives  — what was considered and declined, one line each
## Revisit when  — event/metric/date conditions that reopen this
## Outcome       — what actually happened (filled at revisit or supersession)
```

Lifecycle:

- Claude creates `proposed` notes when work surfaces a qualifying choice, after checking the Decisions group (including its `Rejected:` line) for an existing or rejected note on the same choice. Claude NEVER sets `status: accepted` — only the user's explicit confirmation does. Hard rule, no exceptions.
- New `proposed` notes get `valid_until` ~1 month out. Acceptance is batched: the Lint proposal digest presents all pending proposals for bulk accept/reject/defer. An expired proposal is presented once; deferred again, Lint sets `status: expired` (frontmatter edit, terminal — never re-collected) and removes its index one-liner.
- On acceptance, clear `valid_until` — unless "Revisit when" names a date, in which case set `valid_until` to that date.
- `rejected`: record the user's verdict and reasoning in the body. The file stays on disk; the index keeps only a compact `Rejected:` line entry.
- `superseded`: existing mechanics — material change creates a new note; the old one gets `superseded_by`, `status: superseded`, and leaves the index. Accepted decisions are never silently rewritten.

Outcome capture is event-driven, not a standing nag. The Outcome section gets written (with user confirmation — it is a body edit) at exactly two moments: when a revisit condition fires, and when the note is superseded (the new note's creation includes writing the old note's Outcome). An accepted note with an empty Outcome is normal until one of those events occurs. A decision promoted to a rules file via invariant promotion gets its Outcome recorded ("promoted to <rules-file>") and leaves the index.

Index format for the Decisions group: full one-liners only for `accepted` and `proposed`, carrying status and confidence —

```
- [Title](file.md) — hook (accepted, high)
```

`rejected` notes collapse to one compact line at the bottom of the group: `Rejected: [slug-a](a.md), [slug-b](b.md)`. `superseded` and `expired` notes leave the index entirely but stay on disk.

## Retrieval Discipline

The always-on context footprint is: the grouped `MEMORY.md` index plus the thin skill pointer. Nothing else loads automatically.

Load individual notes on demand when they're relevant to the current task. The `description` field in each note's frontmatter is the retrieval signal. Lint keeps these sharp. When a memory-related sub-agent returns findings, ask for a compressed summary (exact paths, decisions, identifiers) and drop filler. Don't load notes speculatively.

## Lint (Maintenance)

Run Lint at session close, when asked, or when the index feels out of date. Work through these steps in order:

1. Index integrity: every `memory/*.md` file has a pointer in `MEMORY.md`; every pointer resolves to a real file. Flag orphans and broken links. Exempt from the orphan check: notes with `superseded_by` set or `status: rejected | superseded | expired` — they intentionally have no full pointer (rejected notes appear only on the compact `Rejected:` line).
2. Link integrity: `[[slug]]` references either resolve or are intentional forward references. Flag dangling links.
3. Contradiction scan: where two notes conflict, apply supersession (see below). Flag pairs that need user confirmation. Decision notes are compared only with other decision notes — decision-confidence and fact-confidence are different axes.
4. Staleness: notes with an old `updated` date, an expired `valid_until`, or `confidence: low` get flagged for refresh or deletion. Decision notes are handled by steps 10-11, not here.
5. Atomicity: notes over ~50 lines or covering multiple facts get flagged for splitting.
6. Hygiene: scan for leaked secrets, tokens, or real org/employer identifiers. This backstops the `Scan-MemorySecrets` hook.
7. Consolidation: if the same class of failure appears in multiple notes, promote it to a permanent rule in `~/.claude/rules/` (invariant promotion), shorten the memory note to a pointer, and repoint the index.
8. Sync check: confirm vault copies are present and the PostToolUse hook is registered.
9. Handoff backstop: scan the latest handoff file for durable facts not yet in memory; flag them for promotion.
10. Proposal digest: collect all `proposed` decision notes (including those past `valid_until`) into one bulk accept/reject/defer digest for the user. A proposal with an empty Evidence section is flagged as weak here. A previously-deferred, expired proposal gets `status: expired` and its index line removed.
11. Triggered revisits: decision notes whose `valid_until` has passed or whose "Revisit when" condition is verifiably met — prompt the revisit-and-Outcome flow. Best-effort for non-date conditions: Lint cannot verify event/metric prose; those outcomes get captured at supersession or when the user raises the topic.

Guardrail: Lint may auto-edit frontmatter only (`updated`, `superseded_by`, `valid_until`, `status`). It never rewrites note body content. Deletions, merges, and content edits require user confirmation before they happen.

### Supersession

When a newer fact contradicts an older one, the newer note wins. Set `superseded_by: <new-slug>` on the old note's frontmatter. Repoint `MEMORY.md` to the current note. Keep the old file; git history retains it too.

## Obsidian + Hooks

Two hooks run automatically and do not need to be invoked manually:

`Sync-MemoryToObsidian.ps1` (PostToolUse) copies `~/.claude/projects/<project>/memory/*` to `Obsidian Vault/Claude Code/<project>/Memory/` after every Write or Edit. This gives portability and graph view via the vault. Never write files directly into the vault tree. The hook is the only write path.

`Scan-MemorySecrets.ps1` (PreToolUse) runs before any memory write and flags secrets, tokens, and real org/employer identifiers that shouldn't be committed.

If a hook appears broken, check that it's registered in `~/.claude/settings.json` and that the script path is correct.

**Known limitations:** the sync hook copies but does not mirror deletions, so hard-deleting a note leaves its vault copy orphaned. Merge by redirect (set `superseded_by` plus a one-line pointer to the surviving note) instead of deleting. The hook also re-touches a note right after a write, so an `Edit` may fail with "modified since read"; re-read the file before editing.

## Relationship to the Handoff Skill

The `handoff` skill captures episodic session state (task, status, decisions in flight, next step) in a short file that gets overwritten each session. Memory holds durable semantic facts that should outlive any single session. The two stores stay separate with one deliberate seam.

At `/handoff` write time, promote durable items from "Decisions Made" and "Constraints and Gotchas" into atomic memory notes. Facts that qualify as permanent invariants go further, into `~/.claude/rules/`. Only verified, stable facts are promoted. Promotion is deliberate, never automatic.

For facts already in memory, the handoff links `[[slug]]` rather than restating them. The handoff carries the session delta; memory holds the baseline.

Lint scans the latest handoff for durable facts not yet in memory and flags them, so nothing worth keeping gets stranded in a file about to be overwritten.
