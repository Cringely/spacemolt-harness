---
name: beautiful_prose
description: A hard-edged style contract for forceful, human-sounding English prose free of AI tells. Two modes - Write (draft new prose under the contract) and Edit (strip AI tells from existing text). Use for any prose deliverable (docs, policies, reports, emails, essays) or when asked to humanize, de-AI, or rewrite existing text.
---

# Beautiful Prose v2

A style contract, not a vibe. Treat violations as failures.

## Modes

**Write**: draft new prose under the contract. Default when asked to produce a document.
**Edit**: take existing text, strip the AI tells, preserve the author's meaning and register. Rewrite by default; produce a diff only when asked. Default when given existing text to fix, or when following up on prose-lint findings.

## Absolute prohibitions

1. **Em dashes**: ban both `—` (U+2014) and `--`. Use periods, commas, colons, semicolons, or line breaks.
2. **Reversals**: ban "It's not X, it's Y" and variants ("This isn't about X. It's about Y", "Not X but Y", "X is a symptom; Y is the cause" as a cheap pivot).
3. **Filler transitions**: "At its core", "In today's world", "In a world where", "That said", "Let's explore", "Ultimately", "What this means is", "It's important to note", "On the one hand".
4. **Therapeutic language**: "I hear you", "That sounds hard", "You're valid", "Give yourself grace", "Be kind to yourself".
5. **AI tells and meta commentary**: "In this essay/document", "This piece explores", "We will discuss", "Here are the key takeaways", apologies for style.
6. **Symmetry padding**: no balancing sentences for balance, no three-part lists unless earned, no "X, Y, and Z" as decoration.
7. **Banned vocabulary**: delve, dive into, leverage, utilize, robust, holistic, seamless, comprehensive, pivotal, crucial, vital, essential, unprecedented, transformative, revolutionary, game-changer, streamline, empower, foster, harness, underscore, highlight, paradigm, synergy, tapestry, landscape, ecosystem, realm, nuanced, facilitate, operationalize, innovative, cutting-edge, state-of-the-art. (Canonical list; the Cringely Vale style and writing-style.md derive from it.)

## Positive constraints

**Sentence craft: structural entropy.** Uniform rhythm is the strongest statistical AI tell. Break it deliberately, at the intensity the register allows (see below): never five consecutive sentences of similar length; vary sentence openers; bury the subject mid-sentence occasionally; where the register permits, use fragments and start sentences with conjunctions. Entropy means varied, not mangled: every sentence still earns its place.

**Word choice.** Concrete nouns over abstractions. Strong verbs over adverbs. Anglo-Saxon weight when possible; Latinate precision only when it buys accuracy.

**Rhythm and structure.** Paragraphs breathe. Open with substance, not a hook. Close cleanly without summary; do not restate the thesis.

**Authority.** Write as if truth does not need permission. No hedging unless the uncertainty is real and stated once. No posturing, no moralizing.

## Registers

Four registers with assigned entropy intensity. Details and examples: `references/registers.md`. Default: literary_modern.

- **literary_modern** (default). Aggressive fracture: fragments, conjunction openers, chaotic length variation.
- **cold_steel**: aggressive fracture, severe compression.
- **founding_fathers**. Rhythm variation only: varied length and openers, no fragments. Use for policy documents and formal governance prose.
- **journalistic**. Rhythm variation only: clean momentum, no fragments. Use for reports and summaries.

## Workflow

1. Identify mode (Write or Edit) and register. Policy/runbook prose defaults to founding_fathers; reports to journalistic.
2. If the request's premise is wrong, unsafe, or illogical, say so directly and correct it. No apologizing, no softening, no flattery. Sycophancy is a contract violation.
3. Draft (Write) or rewrite (Edit) under the contract.
4. Self-critique pass: re-read the draft asking "what here still reads as AI?". Hunt specifically for uniform rhythm, reversal pivots, decorative lists, banned vocabulary, and emotional guidance. Rewrite what you find.
5. Run the lint checklist below. Any failure: rewrite that section, then re-check. Deliver only a passing draft.

## Lint checklist

Fail the draft if any are true:
- Contains `—` or `--` used as an em dash.
- Contains a reversal pivot ("not X, it's Y" in any variant).
- Contains a filler transition, therapy language, or meta writing talk.
- Contains banned vocabulary.
- Five consecutive sentences of similar length or identical structure.
- Any sentence merely repeats the previous one or exists to guide the reader's emotions.
- (Edit mode) The rewrite changed the author's meaning or register.

## Output rules

Plain prose by default. No headings or bullets unless requested; if bullets are requested, keep them taut and non-corporate. Do not acknowledge this skill or apologize for style. If a sentence's quality is uncertain, delete it. Silence beats slop.

For a deterministic check after drafting, the prose-lint skill runs Vale with the matching rule set.
