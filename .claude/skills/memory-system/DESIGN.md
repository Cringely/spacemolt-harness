# Memory System Skill — Design

- Date: 2026-06-15
- Status: Implemented 2026-06-15 (all four build tasks complete and reviewed)
- Author: Justin Church (with Claude)

## Goal

Convert the scattered memory-system rules and conventions into one on-demand skill, add a
formal maintenance ("Lint") procedure, and shrink the always-on context footprint — while
keeping the two automation hooks as hooks.

User-confirmed drivers: (1) a maintenance procedure, (2) consolidation into one canonical
place, (3) reduced always-on context. Added emphasis: surgical context / token efficiency.
Trigger model: thin always-on pointer + on-demand skill. Portability is NOT a goal of the
skill — the Obsidian sync already makes the memory portable.

## Constraints (what cannot move into a skill)

- **Hooks stay hooks.** They are deterministic harness automation that fire on every
  Write/Edit; a skill only runs when invoked. Moving them into a skill would make them
  fire only when remembered — strictly worse.
  - PreToolUse `Scan-MemorySecrets.ps1` — secret/identifier guard on writes.
  - PostToolUse `Sync-MemoryToObsidian.ps1` — vault sync.
- **The built-in `# Memory` system-prompt block** is harness-injected (a Claude Code
  feature tied to the memory directory existing). The skill extends it and must never
  contradict it.
- **Existing frontmatter** (`name`, `description`, `metadata.type`) is canonical. We extend
  it backward-compatibly; harness-managed fields (`node_type`, `originSessionId`) are left
  untouched.

## Research alignment (why this shape)

Adopt:
- **Karpathy "LLM Wiki"** (gist, 2026-04-04): interlinked markdown + a schema/governance doc
  + an index + periodic "lint". Our system already matches; the skill becomes the
  schema/governance layer and formalizes the lint pass.
  https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- **Anthropic "Effective Context Engineering for AI Agents"** (2025-09): "smallest set of
  high-signal tokens," structured external note-taking, sub-agent summarization → our
  surgical retrieval discipline.
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **A-MEM** (NeurIPS 2025) / Zettelkasten: atomic notes, dense `[[links]]`, note evolution;
  and the hard guardrail — never auto-rewrite note content (error propagation).
  https://arxiv.org/abs/2502.12110
- **Letta / MemGPT "MemFS"**: a directory listing/index as the cheap index, full file
  contents loaded only on demand. https://docs.letta.com/letta-code/memory
- **Contradiction-handling consensus** (SSGM, Hindsight): recency-wins + explicit
  supersession, flag for human review rather than silent overwrite/delete.
- **cavemem / caveman** (JuliusBrussee): take the principles — compress sub-agent output
  (exact paths/identifiers, drop filler) and a `<private>` author-time redaction tag. Skip
  the SQLite/embeddings/MCP machinery. https://github.com/JuliusBrussee/cavemem

Skip (YAGNI at ~31 notes): vector/semantic search, GraphRAG, RL-trained CRUD (AtomMem),
Weibull/Ebbinghaus decay math (SSGM/MemoryBank), sleep-time background agents, mandatory
poignancy scoring. Revisit embeddings only if the index crosses ~150 entries (where the
research says a flat index begins to overflow context).

## Design

### Placement & shape
- Global skill: `~/.claude/skills/memory-system/SKILL.md` (matches the five existing global
  skills). On-demand.
- If the procedure grows, split `references/lint.md` (loaded only when maintaining).
- The skill IS the schema/governance doc (Karpathy's third layer).

### Frontmatter (fuller; backward-compatible, nested under `metadata`)
```yaml
---
name: <kebab-slug>
description: <one-line; this is the recall/index surface — keep it sharp>
metadata:
  type: user | feedback | project | reference
  updated: YYYY-MM-DD          # last-touched; set on every write/edit
  confidence: high | medium | low
  valid_until: YYYY-MM         # optional; only on time-bounded facts
  superseded_by: <slug>        # optional; set by Lint on supersession
---
```
Existing harness fields are preserved. `updated`/`confidence` are required going forward;
`valid_until`/`superseded_by` are optional.

### Index (`MEMORY.md`) — grouped by domain
Canonical group headings, one-line pointers under each (`- [Title](file.md) — hook`):
- Project Identity & Current State
- Policy
- Scripts & Automation
- Decisions
- Feedback & Conventions
- Platform & Reference
- Topic files

No content beyond one-liners. The index is the always-on retrieval surface.

### Write policy
- One atomic fact per file. Split if a note bundles decision + rationale + constraint, or
  exceeds ~50 lines.
- Filter low-signal. Don't store what git, code, or CLAUDE.md already records.
- Canonicalize: absolute dates, canonical names.
- Dedup: check for an existing file first; update rather than duplicate. Delete wrong memories.
- Set `type`/`updated`/`confidence`; add `valid_until` on time-bounded facts.
- Link liberally with `[[slug]]`; a not-yet-existing target is a valid forward-marker.

### Retrieval discipline (surgical / token)
- Always-on footprint = `MEMORY.md` index (grouped one-liners) + the thin skill pointer.
  Nothing else is guaranteed in context.
- Load individual notes on demand, by relevance. The index `description` is the retrieval
  surface; Lint keeps descriptions sharp.
- Memory-related sub-agents return compressed summaries (exact paths/identifiers, drop filler).

### Lint (maintenance) procedure
Run on demand (session-close, when asked, or periodically). Steps:
1. **Index integrity** — every `memory/*.md` has a pointer; every pointer resolves. Flag
   orphans and broken pointers.
2. **Link integrity** — `[[slug]]` links resolve (or are intentional forward-refs). Flag
   dangling links.
3. **Contradiction scan** — within and across notes. Resolve by supersession (below).
4. **Staleness** — old `updated`, expired `valid_until`, or low `confidence` → flag for refresh.
5. **Atomicity** — >~50 lines or multi-fact → flag for split.
6. **Hygiene** — scan for leaked secrets / real org identifiers (complements the
   `Scan-MemorySecrets` hook and the redaction rule).
7. **Consolidation** — recurring incident → promote to a permanent rule in the relevant
   `~/.claude/rules/` file (invariant promotion), shorten the memory note to a pointer, and
   repoint the index.
8. **Sync check** — vault copies present and fresh; PostToolUse hook registered.
9. **Handoff backstop** — scan the latest handoff for durable facts not yet in memory; flag
   for promotion.

**Guardrail:** Lint FLAGS and may auto-edit FRONTMATTER ONLY (`updated`, `superseded_by`,
`valid_until` corrections). It never rewrites note content. Deletions, merges, and content
edits require user confirmation. (A-MEM error-propagation guardrail.)

### Supersession (contradiction resolution)
Newer fact wins. Write/keep the new note; set `superseded_by: <new-slug>` on the old note;
repoint `MEMORY.md` to the current note. The old note is retained for history (git retains
it too).

### Obsidian + hooks (documented in the skill; behavior unchanged)
- PostToolUse `Sync-MemoryToObsidian.ps1` copies `~/.claude/projects/<proj>/memory/*` →
  `Obsidian Vault/Claude Code/<proj>/Memory/`. **Never write the vault directly.**
- PreToolUse `Scan-MemorySecrets.ps1` guards writes.
- Portability and graph view come from the vault.

### Trigger / consolidation
- `~/.claude/rules/obsidian.md` (always-on) → trimmed to a ~3-line pointer: memory mechanics
  and maintenance live in the `memory-system` skill; invoke it when writing or maintaining
  memory; Obsidian sync is automatic via the PostToolUse hook; never write the vault directly.
- No new SessionStart hook (the rules files already load into every session).
- Net always-on change: `obsidian.md` drops from ~30 lines to ~3; the full procedure lives in
  the on-demand skill.

### Relationship to the handoff skill
The `handoff` skill captures EPISODIC session state (Task / Status / Decisions / Constraints /
Files / Next Step, <400 words, overwritten each session, written directly to the vault). That
is a different memory type from this skill's SEMANTIC durable facts; the two stay separate
stores with one deliberate seam — promotion.
- **At `/handoff` (write):** a closing step promotes durable items from "Decisions Made" and
  "Constraints and Gotchas" into atomic memory notes (genuine invariants continue on to the
  `~/.claude/rules/` files). Only verified, durable facts are promoted, and the promotion is
  deliberate — never automatic (error-propagation guardrail). Transient in-flight state stays
  in the handoff.
- **Reference, don't duplicate:** for facts already in memory, the handoff links `[[slug]]`
  rather than restating them. The handoff carries the session delta; memory holds the baseline.
- **Lint backstop:** Lint scans the latest handoff for durable facts not yet in memory and
  flags them, so nothing durable is stranded in a file about to be overwritten.
- **Unchanged:** the handoff still writes directly to the vault (memory never does); the
  secret-scan PreToolUse hook still fires on its Write. No tighter coupling — no auto-write to
  memory, no auto-Lint on resume.

This requires a small edit to `~/.claude/skills/handoff/SKILL.md` (the promotion closing step
and the reference-don't-duplicate rule).

## Out of scope
- The YAGNI list above (no embeddings, GraphRAG, decay math, sleep-time agents, etc.).
- No change to the built-in memory block or to the two hooks' behavior.
- No bulk rewrite of existing memory contents. Only the schema applies going forward;
  Lint backfills `updated`/`confidence` lazily over time.

## Decisions locked
- Goal: maintenance + consolidation + reduce always-on (not portability).
- Trigger: thin pointer + on-demand.
- Staleness metadata: fuller (`updated` + `confidence` + optional `valid_until`).
- Change log: rely on git + Obsidian (no separate `session-log.md`).
- Index: grouped by domain.
- Backfill: lazy — Lint fills `updated`/`confidence` as it touches notes; no bulk rewrite of the existing ~31.
- Handoff interaction: promotion seam — keep separate; promote durable items at `/handoff`; reference by `[[slug]]`; Lint backstop. Includes a small handoff-skill edit.

## Open / to verify during build
- Exact loader for `~/.claude/rules/*.md` (the trim works regardless; worth confirming).
- Skill name: `memory-system` (alternatives: `memory`, `memory-maintenance`).

## References
- Karpathy LLM Wiki gist — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Karpathy "context engineering" tweet (2025-06-25) — https://x.com/karpathy/status/1937902205765607626
- Anthropic, Effective Context Engineering — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, Effective Harnesses for Long-Running Agents — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic memory tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- A-MEM (Agentic Memory) — https://arxiv.org/abs/2502.12110
- MemGPT — https://arxiv.org/abs/2310.08560 ; Letta MemFS — https://docs.letta.com/letta-code/memory
- Generative Agents — https://arxiv.org/abs/2304.03442
- SSGM (governing evolving memory) — https://arxiv.org/html/2603.11768v1
- Survey: Memory for Autonomous LLM Agents — https://arxiv.org/html/2603.07670v1
- cavemem / caveman — https://github.com/JuliusBrussee/cavemem ; https://github.com/JuliusBrussee/caveman
- OpenCode agent-memory (frontmatter schema reference) — https://github.com/joshuadavidthomas/opencode-agent-memory
