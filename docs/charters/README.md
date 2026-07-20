# Role charters

Versioned identity briefs for the recurring non-implementer roles. Adopted from the 2026-07-13
squad-evaluation council (item 3, operator-endorsed; see `docs/council/2026-07-13-squad-evaluation-council.md`
and issue #164).

## What a charter is

A charter is the durable part of a role's dispatch prompt: role, boundaries, conventions enforced,
model tier, hard NEVERs. Before charters, every dispatch re-authored the role brief from scratch —
an identity tax paid in expensive output tokens, with paraphrase drift on every retelling, and the
role dying with the session that authored it. A charter is written once, reviewed like policy, and
reused verbatim.

## Identity-as-configuration, not identity-as-memory

The council's P1 framing. Two ways to give an agent a durable identity:

- **Configuration (adopted):** a versioned charter file in git, inlined verbatim at dispatch.
  Changes are PRs — reviewed, diffable, revertable. The agent is stateless between dispatches.
- **Memory (rejected):** per-agent `history.md` files accumulating experience across dispatches.
  Rejected because statelessness is load-bearing for reviewers — a reviewer that remembers prior
  interactions with an author is a reviewer growing the same blind spots self-review has — and
  accumulated files strand knowledge behind routing (facts live in whichever agent's file caught
  them, instead of the repo artifacts everyone reads). Durable knowledge goes to `docs/wiki/`,
  decisions to `docs/decisions.md`, per the artifacts-are-the-memory rule.

## How dispatch uses a charter

1. Dispatcher (PM or lead) copies the charter file's full text into the agent prompt, VERBATIM —
   never paraphrased, never summarized (paraphrase drift is the failure charters exist to kill).
2. The work order adds only the task-specific part: the target (PR number, merge cluster, capture
   scope), any per-task authorizations, and the reporting channel.
3. Model/effort tier comes from the charter unless the work order explicitly overrides it (the
   override is noted in the report, per the model-tiering escalation rule).

Charters are telegraphic by design — every line is paid on every dispatch. They carry the
operational core only and point at policy files (`docs/wiki/*.md`) for rationale; a charter that
restates a wiki page is a bug. Changes land via docs PR with a CHANGELOG line, like any policy.
