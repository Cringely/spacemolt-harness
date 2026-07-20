# Tooling Catalog

Every skill, plugin, and agent definition this project depends on, and where each comes from. To keep the project portable, anything not publicly available is vendored (copied into this repo) under `.claude/`, so a clone brings the tooling along. Claude Code picks up project-level `.claude/skills/` and `.claude/agents/` automatically.

## Vendored in this repo (custom, not published anywhere)

| Tool | Path | What it does |
|---|---|---|
| council (skill) | `.claude/skills/council/` | Milestone-gate reviews: 5 agents with distinct thinking styles answer independently, anonymously peer-review each other, and a chairman synthesizes. Used at end-of-plan gates. |
| memory-system (skill) | `.claude/skills/memory-system/` | Conventions for writing and recalling persistent memory notes (frontmatter schema, linking, maintenance passes). |
| handoff (skill) | `.claude/skills/handoff/` | Writes a structured session-handoff file (task state, decisions, next steps) at session close. |
| prose-lint (skill) | `.claude/skills/prose-lint/` | Deterministic prose linter (Vale) that flags AI-tell phrases in documentation before delivery. Also fired automatically by the versioned `PostToolUse` hook `.claude/hooks/lint-doc-prose.ts` on every Write/Edit to a living-doc path (#247; advisory, degrades to a skip when Vale is absent). The Vale STYLES kit stays machine-global (its SSOT is beautiful_prose + `vale sync`); only the trigger is versioned here. |
| beautiful_prose (skill) | `.claude/skills/beautiful_prose/` | Style contract for human-sounding prose without AI cadence; applied to documentation deliverables. |
| docker-expert (agent) | `.claude/agents/docker-expert.md` | Specialist agent for container work; used in Plan 4 (containerization, M-08). |
| security-auditor (agent) | `.claude/agents/security-auditor.md` | Specialist agent for security review; used at the Plan 4 gate (exposed ports, secrets handling, M-31). |

Vendored copies are snapshots. When the user-level original improves, re-copy it here (and vice versa); the repo copy is the one that travels.

## Public (install from marketplace, not vendored)

| Tool | Source | Used for |
|---|---|---|
| superpowers (plugin) | `anthropics/claude-plugins-official` | Process skills (brainstorming, writing-plans, subagent-driven development): the spec/plan workflow. |
| ponytail (plugin) | `github.com/DietrichGebert/ponytail` | Anti-over-engineering mode and reviews (simplest-solution discipline; see simplicity-rules.md). |
| code-review (skill) | Claude Code built-in | Diff reviews for correctness at configurable effort. |

## Environment-specific (not portable, documented so nothing surprises)

- **Sync-MemoryToObsidian.ps1 hook** (user machine): copies Claude memory files into an Obsidian vault after edits. Machine-personal; the project doesn't depend on it.
- **Built-in agent types** (general-purpose, Explore, Plan): ship with Claude Code itself, nothing to vendor.
- **MCP servers** (GitHub, desktop-commander, SpaceMolt game server): connect per-machine via Claude Code settings; the game's MCP endpoint is public (`https://game.spacemolt.com/mcp`) though the harness itself uses HTTP v2.
