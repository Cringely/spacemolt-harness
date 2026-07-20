---
name: council
description: Run an LLM Council — 5 sub-agents with distinct thinking styles independently answer a question, then peer-review each other's responses anonymously, then a chairman synthesizes the best answer. Based on the Karpathy/Lehmann pattern. Use when the user invokes /council or wants multiple perspectives on a hard problem.
---

# LLM Council

Multi-perspective deliberation using sub-agents. Four phases: context gathering, independent generation, anonymized peer review, chairman synthesis.

## When to Use

- Hard questions with no obvious right answer
- Decisions with significant trade-offs
- Problems that benefit from adversarial scrutiny
- When the user explicitly invokes `/council`

## Execution Protocol

The user's query follows the `/council` invocation. Run all four phases below. Do not skip phases or combine them.

### Phase 0: Context Gathering

Before spawning advisors, build a shared context package so all advisors reason from the same ground truth instead of guessing. This phase runs in the main context (no sub-agents). Assemble the context package from two sources:

**1. Memory and project context**

Read the following if they exist, and extract anything relevant to the user's query:

- `~/.claude/projects/<project>/memory/MEMORY.md` — the memory index. Scan for entries related to the query topic. If any look relevant, read the linked memory files.
- Any `CLAUDE.md` in the current working directory or its parents — project conventions, architecture notes, constraints.
- If the conversation already contains relevant context (earlier messages, tool results), summarize the key facts.

Skip memory/CLAUDE.md reading if neither exists or if the question is clearly not about the current project.

**2. Web enrichment**

If the question involves external topics — technologies, industry practices, recent developments, comparisons of tools/approaches, or anything where training data might be stale or incomplete — run 1-3 web searches to gather current information. Use the WebSearch tool directly (not a sub-agent).

Guidelines for web search:
- Search for the core topic, not the full question verbatim
- Prefer authoritative sources (official docs, well-known engineering blogs, academic references)
- Extract key facts, data points, and current state — not full articles
- If the question is purely about the user's own project/codebase with no external component, skip web search entirely

**3. Frame the question**

Before sending the query to advisors, rewrite it into a neutral form. The user's original phrasing may contain leading assumptions, embedded preferences, or framing that biases advisors toward a particular answer. The framed question should:

- Preserve the core intent of what the user is asking
- Remove leading language ("Wouldn't it be better to...", "I think we should...", "Obviously...")
- Remove false dichotomies — if the user presents two options, open it to other possibilities
- State the decision or question clearly without implying a preferred answer
- Include relevant constraints the user mentioned (deadlines, budget, technical limits)

Example:
- Raw: "Should we just switch to Postgres since MySQL is clearly holding us back?"
- Framed: "Evaluate whether migrating from MySQL to PostgreSQL is warranted given current pain points, and whether other options exist."

The framed question replaces the raw query in all advisor prompts. Include the original raw query as well so advisors can see what the user actually asked — but instruct them to answer the framed version.

**4. Assemble the context block**

Combine the gathered context into a single `## Shared Context` block formatted like this:

```
## Shared Context

The following context was gathered before deliberation. All advisors receive the same information.

### From project memory/docs
[Relevant facts from memory files and CLAUDE.md, or "No project context applicable."]

### From web research
[Key findings from web searches with source attribution, or "No web research needed — question is self-contained."]
```

This block is included verbatim in every Phase 1 advisor prompt. Keep it under 1000 words — enough to ground the advisors, not so much that it drowns their own thinking.

### Phase 1: Independent Generation

Spawn exactly 5 sub-agents **in parallel** using the Agent tool. Each gets a different persona and the same user query. They must not see each other's responses.

Each agent's prompt must follow this structure:

```
You are a council advisor with a specific thinking style. Read your persona and the shared context, then answer the user's question.

## Your Persona
[Insert full persona text from references/personas.md]

## The Question
[Insert the framed question from Phase 0 step 3]

> Original phrasing: [Insert the user's raw query]

[Insert the ## Shared Context block from Phase 0 here — verbatim, identical for all 5 advisors]

## Instructions
- Answer the framed question from your persona's perspective — the original phrasing is provided for context only
- Use the shared context as grounding — reference specific facts from it when relevant
- You may go beyond the shared context, but do not contradict it without stating why
- Be direct and specific — no filler, no hedging for politeness
- Length: 200-500 words unless the question demands more
- End with a single-sentence "bottom line" summary of your position
- Do NOT acknowledge your persona or mention the council process
```

Name each agent: `council-analyst`, `council-contrarian`, `council-pragmatist`, `council-outsider`, `council-integrator`.

**Persona-to-agent mapping:** Analyst, Contrarian, Pragmatist, Outsider, Integrator.

### Phase 2: Anonymized Peer Review

After all 5 responses are collected, spawn **3** sub-agents in parallel for peer review. Use the Analyst, Contrarian, and Integrator personas as reviewers (they provide the most rigorous evaluation). Each reviewer gets ALL 5 responses with persona names stripped and replaced with neutral labels (Response A through E). **Randomize the mapping** of personas to labels so reviewers cannot guess identities from position.

Each reviewer's prompt:

```
You are a peer reviewer on a council. You have been given 5 anonymous responses to a question. Your job is to evaluate them critically.

## Your Reviewer Persona
[Insert persona text]

## The Original Question
[Insert user's query]

## Anonymous Responses
[Insert all 5 responses labeled A through E, with no persona attribution]

## Instructions
- Evaluate each response for: accuracy, reasoning quality, completeness, and practical value
- Identify the strongest and weakest response, with specific justification
- Note any critical errors, blind spots, or unsupported claims in any response
- Rank all 5 responses from strongest to weakest
- Be specific — quote or reference particular claims when critiquing
- 300-500 words max
```

Name each agent: `council-review-1`, `council-review-2`, `council-review-3`.

### Phase 3: Chairman Synthesis

Spawn a single sub-agent as the Chairman. It receives:
- The original question
- All 5 original responses (now with persona labels restored)
- All 3 peer reviews

The Chairman's prompt:

```
You are the Chairman of a council. Your job is to produce the single best answer to the user's question by synthesizing the strongest insights from 5 advisors and 3 peer reviews.

## The Original Question
[Insert user's query]

[Insert the ## Shared Context block from Phase 0 here]

## Advisor Responses
[Insert all 5 responses with their persona labels: Analyst, Contrarian, Pragmatist, Outsider, Integrator]

## Peer Reviews
[Insert all 3 reviews]

## Instructions
- Produce a single, authoritative answer to the question
- The shared context is ground truth — advisors who contradicted it without justification should be weighted lower
- Draw from whichever advisors were strongest — you are not obligated to include every perspective
- Where advisors disagree, resolve the disagreement with your own judgment, informed by the peer reviews
- If a critical objection was raised that none of the advisors addressed well, flag it
- Be direct and specific — this is the final answer the user will read
- Match the length and format to what the question demands (concise for simple questions, detailed for complex ones)
- End with a "Council Notes" section (2-3 bullets) listing: key disagreements among advisors, the strongest dissent, and confidence level (high/medium/low)
```

Name this agent: `council-chairman`.

### Output

Return the Chairman's synthesis directly to the user. Do not include the intermediate responses or reviews unless the user asks for them.

If the user asks to see the deliberation, show:
1. Each advisor's response with their persona label
2. The anonymized peer reviews
3. The chairman's synthesis

### Transcript Saving

If the user invokes `/council save` or `/council deliberation`, or asks to save the transcript, write the full deliberation to a file after the chairman completes. Use the Write tool to create the file at:

```
~/.claude/council-transcripts/<project>/council-YYYY-MM-DD-HHMMSS.md
```

Where `<project>` is derived from the current working directory using the same encoding as Claude Code's project scoping (drive letter + path with hyphens replacing separators). For example:
- Working directory `C:\Users\jcgam` → project folder `C--Users-jcgam`
- Working directory `E:\projects\myapp` → project folder `E--projects-myapp`

If the working directory is the user's home directory (`~`), use `C--Users-jcgam` as the project folder. This mirrors the structure used by the memory system and the Obsidian sync hook.

The transcript file should contain:

```markdown
# Council Deliberation — [Date]

## Original Question
[User's raw query]

## Framed Question
[Neutralized question from Phase 0]

## Shared Context
[The context block from Phase 0]

## Advisor Responses

### Analyst
[Response]

### Contrarian
[Response]

### Pragmatist
[Response]

### Outsider
[Response]

### Integrator
[Response]

## Peer Reviews (Anonymized)

### Reviewer 1 (Analyst)
[Review with A-E labels]

### Reviewer 2 (Contrarian)
[Review with A-E labels]

### Reviewer 3 (Integrator)
[Review with A-E labels]

### Label Key
A = [persona], B = [persona], C = [persona], D = [persona], E = [persona]

## Chairman Synthesis
[Final answer including Council Notes]
```

Tell the user the file path after saving.

## Configuration

Defaults that can be overridden if the user specifies:

- **Council size**: 5 advisors (minimum 3 for meaningful diversity)
- **Reviewers**: 3 (Analyst, Contrarian, Integrator)
- **Chairman model**: same as session default
- **Advisor length**: 200-500 words
- **Review length**: 300-500 words

If the user says `/council brief`, cap advisor responses at 150 words and reviews at 200 words.
If the user says `/council deep`, allow advisor responses up to 1000 words and reviews up to 500 words.
If the user says `/council save` or `/council deliberation`, save the full transcript after completion (see Transcript Saving above). These modifiers can be combined: `/council deep save`.

## Personas

Stored in `references/personas.md`. Read that file at execution time — do not rely on cached content.

## Cost Awareness

This skill spawns 9 sub-agents total (5 + 3 + 1) plus 0-3 web searches in Phase 0. It is expensive relative to a single response. The quality gain is real for hard problems but wasteful for simple questions. If the user's question has an obvious, well-known answer, say so and ask if they still want the full council treatment.
