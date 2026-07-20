---
name: handoff
description: Write a structured session handoff file capturing task state, decisions, constraints, and next steps. Use at the end of any non-trivial session or when context is getting heavy. Invoke with /handoff to write, or /handoff resume to pick up the latest handoff file.
---

# Session Handoff

Captures session state to a file so the next session starts with full context in ~300 words instead of a degraded compacted history.

## When to Use

- Before ending any session with in-progress work
- When the statusline shows context usage climbing past 50%
- When switching between unrelated tasks (handoff the current one first)
- When `/handoff resume` is invoked at session start

## Writing a Handoff (`/handoff`)

**Determine the project slug first.** Derive it from the basename of the current working directory (e.g., `myapp` from `C:\Users\me\Documents\projects\website\myapp`, or `home` if the CWD is the user's home directory). Use lowercase, replacing spaces with hyphens.

Gather the following from the current session and write to `C:\Users\jcgam\Documents\Obsidian Vault\Claude Code\Handoffs\<slug>\handoff-latest.md`, overwriting any previous file for that project. Also write a dated copy to `C:\Users\jcgam\Documents\Obsidian Vault\Claude Code\Handoffs\<slug>\handoff-YYYY-MM-DD-HHMMSS.md` for history. Create the `<slug>` subfolder if it doesn't exist (Write tool creates parent directories automatically).

Use the Write tool. The file must follow this exact structure:

```markdown
# Session Handoff — [date] [time]

## Task
[One sentence: what was being worked on and why]

## Status
- Done: [completed items]
- In progress: [partially done items with current state]
- Not started: [remaining items]

## Decisions Made
[Each decision on its own line, with the reason. Include rejected alternatives.]
- Chose X over Y because Z
- Rejected A because B

## Constraints and Gotchas
[Things discovered this session that the next session must know. These are the facts that compaction kills first.]
- [Constraint 1]
- [Constraint 2]

## Files Modified
[Every file touched, with a one-line summary of what changed]
- path/to/file — what changed

## Next Step
[The specific first action the resuming session should take. Not vague — concrete.]
```

### Rules for writing

- **Decisions section is mandatory.** If no decisions were made, write "No significant decisions." Do not skip the section.
- **Include rejected alternatives.** "We chose X" is incomplete. "We chose X over Y because Z" survives as useful context. This is the information compaction destroys first.
- **Constraints section captures gotchas.** Things like "this image lacks curl" or "this API requires explicit field names on PATCH" — operational surprises that would cost tool calls to rediscover.
- **Next Step must be actionable.** "Continue working on the feature" is not actionable. "Run the test suite for the auth module and fix any failures" is.
- **Keep it under 400 words.** This file gets read into a fresh context window. Brevity is the point.
- **Reference, don't restate.** For facts already in long-term memory, link them as `[[slug]]` rather than repeating the content. The handoff carries the session delta; memory holds the baseline.

### Promote durable facts to memory

After writing the handoff, review the "Decisions Made" and "Constraints and Gotchas" sections. Anything verified and durable (a decision that will still be true in three months, a gotcha that will recur) belongs in an atomic memory note via the `memory-system` skill. Genuine permanent invariants go further, to `~/.claude/rules/`. Interim state, in-flight investigations, and anything you're not certain about stays in the handoff. Promotion is deliberate and filtered, never automatic.

## Resuming from a Handoff (`/handoff resume`)

Determine the project slug the same way as writing (basename of CWD). Read `C:\Users\jcgam\Documents\Obsidian Vault\Claude Code\Handoffs\<slug>\handoff-latest.md` and present a brief summary to the user:

1. Read the file
2. State the task, current status, and proposed next step
3. Ask the user to confirm or redirect before proceeding

Do not begin work until the user confirms. The handoff file reflects the previous session's understanding, which may be outdated.

## No Arguments

If invoked as `/handoff` with no arguments, write the handoff file.
If invoked as `/handoff resume`, read and present the latest handoff.
