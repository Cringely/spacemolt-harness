// OPT-IN. Not referenced by core/claude/templates/settings.hooks.json or any project's
// settings.json; an operator wires it deliberately, after reading what it does below. This is
// new BLOCKING behavior — a PreToolUse deny, not an advisory note — authored with no human
// available to review it running, so unlike agent-worktree-gate.ts and agent-write-scope.ts it
// does not ship live by default through the installer's merge:
//
//   {
//     "matcher": "Bash",
//     "hooks": [
//       {
//         "type": "command",
//         "command": "bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/review-gate.ts\""
//       }
//     ]
//   }
//
// Add that block under PreToolUse in the project's settings.json (settings.local.json to try it
// without committing). Project level, not user level: this hook reads the invoking session's own
// transcript_path, which only makes sense scoped to the project whose commits it is guarding.
//
// PreToolUse hook (matcher: Bash) — the review gate.
//
// The repo owner's standing rule is that review is always delegated, never self-review
// (~/.claude/rules/agent-usage.md). A session can load that rule into context and still commit
// unreviewed work at the decision point, because prose recalled under load is the weakest tier in
// guardrails.template.md's own hierarchy. This hook is the gate tier: it derives its answer from
// the session transcript, evidence a model in that session cannot fabricate after the fact,
// rather than from a self-reported flag any agent could set.
//
// MECHANISM. On a `git commit` invocation, list the staged files (`git diff --cached
// --name-only`), then, for each one, find the last time the evidence set (see EVIDENCE SOURCES
// below) shows a Write, Edit, or NotebookEdit tool call touching it, and check whether an
// Agent/Task dispatch to an allowlisted reviewer type appears anywhere later. A staged file with
// no qualifying dispatch after its last edit is unreviewed; the commit is denied naming which
// files.
//
// EVIDENCE SOURCES, and the BASH BLIND SPOT. `transcript_path` names only the PARENT session's
// own transcript; a dispatched subagent's tool calls are written to a SEPARATE file, never to the
// parent, under `<dirname>/<basename minus .jsonl>/subagents/*.jsonl` — verified against this
// project's own session directory. A first version of this hook read only the parent file and, as
// a direct result, could not see its own review: dispatching a reviewer to check review-gate.ts
// itself produced a transcript where the Edit and the Agent dispatch both existed, in the
// subagent's file and the parent's file respectively, and neither transcript alone showed both.
// `readAllTranscriptEntries()` fixes this by merging parent and subagent files, ordered by
// `timestamp` (see that function's own doc comment for why index can't order across files, and
// what backs treating timestamp as a sound total order). What no merge can fix: a file written
// through Bash — `cat > f <<EOF`, `sed -i`, `tee`, `git apply` — never appears as a Write/Edit/
// NotebookEdit tool_use at all, in ANY transcript. Across every transcript on this machine, Bash
// calls outnumber Edit and Write combined by roughly 2:1. A staged file whose only history is a
// Bash write is indistinguishable, to this hook, from one this session never touched — it lands in
// `noEvidence`, not `unreviewed`, and is announced rather than silently passed (see FAIL-OPEN
// CONTRACT). Interpreting shell output well enough to attribute a file write to a specific Bash
// invocation is out of scope; this is a disclosed limitation, not an oversight.
//
// ORDERING, not turn-bucketing. dispatch-audit.ts (deleted, #97 — shipped untested and unused,
// see git history for the file) took a different approach: it bucketed the transcript into turns
// delimited by real user prompts, and one of its two documented open defects was that
// `isRealUserPrompt()` never checked `entry.isMeta`, so an injected skill body or an agent-message
// delivery wrongly reset a turn boundary. This hook does not adopt that turn-bucketing at all:
// the actual invariant needed is a total order over transcript entries — dispatch at or after
// edit, by raw index within the merged evidence set — and a same-turn dispatch that happens to
// precede the edit it's meant to review must NOT count, which turn-level comparison alone would
// get wrong but index comparison gets right for free. The reason this can't be defeated by the
// isMeta defect is structural, not a check that routes around it: this hook only ever reads
// tool_use blocks out of `type: "assistant"` entries, and isMeta only ever marks synthetic
// `type: "user"` entries. That structural fact is the load-bearing claim; a corpus measurement
// backs it (263 isMeta entries found across every transcript on this machine, all `type: "user"`,
// none `type: "assistant"`) but is supporting evidence, not the proof — the count could be wrong
// or the corpus incomplete and the structural argument would still hold, which is why
// `toolUseBlocksIn()` still carries a one-line explicit isMeta check as belt and braces despite
// being structurally redundant today. A turn-boundary abstraction was the brief's stated approach
// and was rejected in favor of this simpler, already-correct ordering.
//
// ESCAPE HATCH, load-bearing. A command containing `REVIEW_OVERRIDE=<reason>` allows unconditionally,
// with the reason echoed into permissionDecisionReason so it is visible in the transcript. The
// TOKEN's position is found against the command with quotes and heredoc bodies blanked out
// (`scrubQuotesAndHeredocs()`), not the raw text — otherwise a commit whose OWN message documents
// this hook (`git commit -m "add REVIEW_OVERRIDE= escape hatch"`) would self-bypass via a phrase
// that was never meant as a live token. The REASON, once the token's position is confirmed live,
// is read from the RAW text at that same offset, not the scrubbed one (F-R2-1, a correction to an
// earlier version of this fix that scrubbed both): a person's most natural way to write a reason
// is quoted — `REVIEW_OVERRIDE='prod outage'` — and matching the reason against the scrubbed text
// blanked it to nothing, silently denying the exact remediation this hook's own deny message
// prints. `extractOverrideReason()` reads a quoted phrase whole (quotes stripped for display) or a
// single unquoted word, and is not quality-checked beyond "non-empty" — deliberately, matching
// OVERRIDE_TOKEN's own sibling precedent in agent-worktree-gate.ts (`ISOLATION-OVERRIDE:` requires
// only one non-whitespace character too). The safeguard this hatch relies on is visibility in the
// transcript, not the prose quality of the reason; a human or a later review reading the transcript
// can judge a thin reason for what it is, which a length check on the string cannot do any better.
// This is this repo's own documented position (guardrails.template.md: "a hook muted for false
// positives protects nothing... before adding a new gate, check whether a cheaper tier already
// covers the rule"): a gate with no in-band, visible bypass gets muted at the settings.json level
// instead, silently, the first time it's wrong — which protects nothing and leaves no trace. This
// one can always be overridden, but never silently.
//
// FAIL-OPEN CONTRACT, matching agent-worktree-gate.ts and agent-write-scope.ts for genuine
// exceptions: malformed stdin, an unreadable PARENT transcript file, a `git` call that errors (not
// a repo, git missing, detached state), or any other internal exception all log to stderr and exit
// 0 with no stdout, which Claude Code reads as "no opinion" — the commit proceeds silently. This
// gate refusing to run must never block work. An unreadable `subagents/` DIRECTORY (not a file in
// it) is deliberately NOT in this exception list even though it's a `readdirSync` call that can
// throw: `readAllTranscriptEntries()` catches it locally and degrades to parent-only evidence
// (F-R2-2) rather than letting it propagate here — a fix for exactly the failure this paragraph
// describes, reintroduced at a new call site by the FIX 1 subagent merge and closed before shipping.
//
// A separate, larger category is NOT an exception and is NOT silent: an absent/empty/null
// transcript_path, a transcript that parses to zero entries (empty file, or every line failing to
// parse), and a staged file with no edit evidence anywhere in the merged transcript all reach
// `decide()` as ordinary inputs and come back as an explicit `{action: "allow", reason: "..."}`
// via the same permissionDecisionReason channel the override uses, in the CLI wrapper's
// `else if (decision.reason)` branch below — a blind pass
// is exactly as visible as a deliberate one. An earlier version of this file's own header claimed
// these four paths "log to stderr" alongside the true exceptions; they don't, they were silent
// returns with no announcement at all, and that was the actual defect — not the sentence being
// wrong, the BEHAVIOR being wrong. Fixed by construction: decide() now treats "insufficient
// evidence" as a distinct outcome from both "clean" and "denied". One further refinement (F-R2-3):
// a dropped SUBAGENT transcript (unreadable, or readable but corrupt enough that every line failed
// to parse) also reaches the "no edit evidence" message, but was previously indistinguishable from
// a file this session genuinely never touched. `readAllTranscriptEntries()` now counts those drops
// and `decide()` appends the count to the message when it's nonzero, so the operator can tell
// "nothing happened here" from "something happened here and this hook couldn't read it".
//
// Stated plainly regardless: an operator who deletes or truncates the transcript file, or every
// subagent transcript under it, defeats this gate's ability to observe anything, and it will
// announce that it's flying blind rather than refuse to commit. That's accepted, not overlooked —
// the threat model here is a model skipping a step under load, not an adversary tampering with its
// own transcript, and a gate that tried to defend against the second would need a trust boundary
// this hook has no way to establish.
//
// GIT-COMMIT DETECTION is a heuristic over shell text, not a shell parser, and its errors are
// meant to fall on the permissive side: a missed commit is a gap in coverage, a false deny blocks
// the operator on a command that was never going to touch git. The one place this hook actively
// works to avoid a false positive is a `git commit` phrase sitting inert inside a quoted argument
// or a heredoc body (`echo "remember to git commit"`, `cat <<EOF\ngit commit\nEOF`) — see
// `scrubQuotesAndHeredocs()`. `git commit --dry-run` currently denies if unreviewed, a known
// false deny on a non-mutating command: an exemption was built (F-R2-8) and reverted (F-R3-1)
// after gatereview proved it opened a live bypass — see `parseGitCommitInvocation()`'s own doc
// comment for the mechanism and the deferred, correctly-scoped fix. A few other
// false-positive-but-non-mutating forms (`git commit -h`, `man git-commit`, `which git-commit`, an
// unquoted `echo git commit`) are known and left undocumented in code, deliberately: they're
// cosmetic, and adding a special case per contrived example is exactly the un-costed complexity
// this file otherwise avoids. This section does NOT strip `#` shell comments, so a commented-out
// `# git commit ...` line still reads as a commit; that's a known, accepted over-detection (the
// safe direction) rather than an oversight, and left unhandled because the brief for this hook
// named only quotes and heredocs, and stripping comments correctly needs to know where statements
// end (word boundaries around `;`, `&&`, newlines) in a way this heuristic does not attempt to
// track. `bash -c "git commit"` and any other nested-interpreter form defeat detection entirely, since
// nothing here interprets shell recursively; also out of scope, for the same reason.
//
// KNOWN, NOT CHASED — real gaps, left alone deliberately rather than solved partially:
//   - `cd other-repo && git commit` (or `git -C wrong-path commit`) gates whatever repo this
//     hook's own `gitCwd` resolves to, which may not be the repo the commit actually lands in if
//     the command changes directory by a means this heuristic doesn't track.
//   - `latestReviewIndex` in `findUnreviewedFiles()` is a single session-wide maximum, not scoped
//     per file: ONE qualifying dispatch, anywhere after every staged file's last edit, clears all
//     of them, whether or not that dispatch actually looked at each file. A model could satisfy
//     this gate for five unrelated edits with one narrowly-scoped review dispatch.
// Both are real and both are shell-text/session-model limitations no heuristic gate can close
// without becoming a shell interpreter or a semantic diff of the dispatch prompt against the
// staged diff. Under this hook's threat model — an omitted review step, not an adversary routing
// around the gate — neither is worth the complexity to chase; a determined bypass was never what
// this gate promised to stop.
//
// Decision logic lives in the exported pure `decide()`, which takes an already-fetched staged-path
// list and an already-merged transcript array — no I/O — so `bun test test/review-gate.test.ts`
// exercises the actual gate policy with plain fixture arrays, no git process and no transcript
// file. The I/O edges (`getStagedAbsPaths()` calling `git`, and `readAllTranscriptEntries()` doing
// the parent+subagent merge) are exercised separately against real temp git repos and real temp
// transcript directory trees, matching how test/agent-worktree-gate.test.ts covers its own I/O
// edge (`requiresIsolation()` reading real temp agent-definition files) rather than mocking `fs`.
// The `import.meta.main` stdin/stdout entrypoint itself IS spawn-tested (#78): a real temp git
// repo, a real temp transcript file, the hook run as a child process via `Bun.spawnSync`. See the
// "spawned process" describe blocks at the end of test/review-gate.test.ts.
//
// ALLOWLIST ENUMERATION IN THE DENY MESSAGE, a judgment call rather than an obvious default: the
// deny reason names every REVIEW_ALLOWLIST entry, including general-purpose, as the remediation —
// which is also, necessarily, a disclosure of exactly what satisfies the check. A model told "any
// general-purpose dispatch clears this" could dispatch one that does nothing resembling a review.
// Kept anyway: this file is plaintext and committed, readable by the model at any time, so
// withholding the list from the deny message buys nothing real against the stated threat model.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readTranscript, type TranscriptEntry } from "./transcript-utils";

/**
 * subagent_type values, lowercased, whose dispatch counts as a qualifying review. general-purpose
 * is included deliberately: fact-check and review dispatches commonly use it instead of a named
 * reviewer role, and excluding it would make this gate fire on real reviews about as often as on
 * real gaps. That weakens what the allowlist can prove, in exchange for not producing constant
 * false denials — the same "a false positive gets muted, and a muted hook protects nothing" trade
 * guardrails.template.md already makes for every hook in this repo.
 */
export const REVIEW_ALLOWLIST = new Set([
  "task-reviewer",
  "adversarial-reviewer",
  "code-reviewer",
  "feature-dev:code-reviewer",
  "caveman:cavecrew-reviewer",
  "appsec-sme",
  "governance-sme",
  "general-purpose",
]);

/** Tool names, lowercased, treated as edits for the "last touch" lookup. */
const WRITE_TOOL_NAMES = new Set(["write", "edit", "notebookedit"]);

/** Tool names, lowercased, treated as a subagent dispatch: the dispatch tool's `tool_use` block
 * is named "Agent"; "task" kept as a defensive alias in case a future Claude Code version renames
 * the tool, since nothing here proves it won't (matched the now-deleted dispatch-audit.ts's
 * identical set). */
const DISPATCH_TOOL_NAMES = new Set(["agent", "task"]);

/** Conscious in-band bypass. See the header's ESCAPE HATCH note. */
export const OVERRIDE_TOKEN = "REVIEW_OVERRIDE=";

export type GateDecision =
  | { action: "allow"; reason?: string }
  | { action: "deny"; reason: string };

const ALLOW: GateDecision = { action: "allow" };

/**
 * Blanks out single-quoted spans, double-quoted spans, and heredoc bodies in `command`, replacing
 * their characters with spaces so offsets and surrounding structure are unchanged. Not a full
 * shell parser — see the header's GIT-COMMIT DETECTION note for what it deliberately does not
 * attempt (comments, nested command substitution edge cases). Exported for direct testing.
 */
export function scrubQuotesAndHeredocs(command: string): string {
  const out = command.split("");
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      out[i] = " ";
      i++;
      while (i < command.length && command[i] !== "'") {
        out[i] = " ";
        i++;
      }
      if (i < command.length) {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === '"') {
      out[i] = " ";
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          // An escaped character (notably \") does not end the string — blank both
          // halves of the pair and keep scanning for the real closing quote.
          out[i] = " ";
          i++;
          out[i] = " ";
          i++;
          continue;
        }
        out[i] = " ";
        i++;
      }
      if (i < command.length) {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === "<" && command[i + 1] === "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(i));
      if (m) {
        for (let k = 0; k < m[0].length; k++) out[i + k] = " ";
        i += m[0].length;
        const delimiter = m[2];
        // Leave the rest of this line alone (a redirect target or pipe after `<<EOF` is
        // still real command text); the heredoc body starts at the next newline.
        while (i < command.length && command[i] !== "\n") i++;
        if (i < command.length) i++;
        while (i < command.length) {
          const lineEnd = command.indexOf("\n", i);
          const end = lineEnd === -1 ? command.length : lineEnd;
          const line = command.slice(i, end);
          for (let k = i; k < end; k++) out[k] = " ";
          const isDelimiterLine = line.trim() === delimiter;
          i = lineEnd === -1 ? command.length : lineEnd + 1;
          if (isDelimiterLine) break;
        }
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/**
 * `git` immediately followed by whitespace (excludes "gitk", "git-commit-wrapper", …), then zero
 * or more option-looking tokens — `-C <path>` or `-c <key=value>` as a pair, or any other
 * `-x`/`--long[=value]` flag — then `commit` as its own word. Handles the three forms the gate is
 * asked to recognize: `git commit`, `git -C <path> commit`, and either with flags, including
 * `git -c user.name=x commit` (the detached-value form of `-c` is common enough in practice to be
 * worth its own alternative, unlike other detached-value short flags this heuristic still misses).
 *
 * The `(?!-{1,2}[A-Za-z][\w-]*(?:=\S+)?(?=\s|$))` guard on the two pair alternatives is
 * load-bearing (backlog item 37). Three things about it matter and each has been got wrong on a
 * branch already: that it sits THERE and not on the generic alternative, that it tests the WHOLE
 * token rather than the two characters that make a token look like an option, and that the
 * generic alternative stays byte-identical to master's. Read the three notes below before
 * touching it — both simplifications have shipped once and both turned the gate off.
 *
 * Half one, the backtracking. Without any guard, a bare `-C` matched two alternatives that
 * consume different token counts — the pair form swallowing the next token, the generic form
 * taking the flag alone — so a run of n option-shaped tokens tiled Fibonacci(n+1) ways and the
 * engine walked every tiling once the trailing `\s+commit` failed. `git -C` repeated 40 times is
 * 125 characters and took 1878 ms through parseGitCommitInvocation on bun, unbounded on node.
 * With the guard, `-C`/`-c` cannot take as their argument a token the generic alternative would
 * consume whole, so at a `-C` followed by one there is exactly one viable alternative and the
 * ReDoS is gone. Two forks survive and neither can accumulate. A `-C` followed by a PLAIN word:
 * the generic branch consumes `-C` alone, the star then stops (a plain word is not option-shaped)
 * and the tail either matches that word or fails at once. A `-C` followed by a token that starts
 * option-shaped but is not consumable whole (`-a.b`): the generic branch consumes the `-a` prefix
 * and stops mid-token, where the star cannot iterate and the tail cannot match, so that branch
 * dies at once too. Both forks resolve in O(1). Measured flat to n=25600 (325 KB of command text)
 * across EIGHT of nine attack shapes, four of them built to drive the second fork: worst cell
 * 53.8 ms, linear across the last doubling. The ninth shape is the pre-existing quadratic
 * described in the next paragraph, which is neither flat nor bounded by that number — 53.8 ms is
 * the worst of eight, not of nine. Several shapes show a one-time step of 19x to 75x somewhere
 * between 9 and 102 KB; the pattern this replaces shows the same step at the same sizes and both
 * are linear on either side of it, so it is an engine threshold and not backtracking.
 *
 * "Linear" above is the per-start-position walk, and the whole-string scan is not linear — a
 * separate, pre-existing property this change neither causes nor fixes. The pattern is unanchored
 * and `[\w-]*` can swallow later `git` tokens, so each `\bgit(?=\s)` start position can run the
 * star to end of string. `"git -a-a-a-".repeat(n) + " x"` costs about 4x per doubling on this
 * pattern, on the one it replaces, and on master alike — 70 KB of command text is about 2
 * seconds. Polynomial, not exponential, and out of scope here; do not read the paragraph above as
 * saying the scan is bounded.
 *
 * Half two, why the guard is not on the generic alternative. scrubQuotesAndHeredocs() runs
 * first and blanks a quoted span to spaces, so `git -C "$PWD" commit` reaches this pattern as
 * `git -C         commit` and the argument is no longer a token at all. The gate depends on the
 * generic alternative matching that bare `-C` and the tail finding `commit` across the blanks.
 * Blocking the generic alternative from ever matching a bare `-C` (shipped once, reverted here)
 * makes the pair alternative swallow `commit` as the repo path, the match fail, and
 * `parseGitCommitInvocation` return isCommit false — which `decide()` and `main()` both read as
 * ALLOW. A quoted `-C` argument then walks past the gate, which is worse than the stall it was
 * fixing.
 *
 * Half three, why the lookahead reads the whole token. A token like `-a.b`, `-a/b` or `-a:b`
 * starts option-shaped and is NOT consumable whole by the generic alternative, because `[\w-]*`
 * stops at the punctuation and there is no `=` for `(?:=\S+)?` to take. A lookahead that only
 * asked whether the argument LOOKS like an option (`(?!-{1,2}[A-Za-z])`, shipped once) therefore
 * refused the pair reading on those tokens while the generic reading did not exist either: no
 * alternative crossed the token, the star could not advance, and the whole match was lost — the
 * same fail-open as half two, narrower. Testing the whole token is what makes the premise true:
 * the pair form is blocked only where the generic form can take the token instead.
 *
 * That premise is also the correctness argument, and it is structural rather than measured. Each
 * alternative here is a subset of master's corresponding one (the two pair forms narrowed by a
 * lookahead, the generic form byte-identical), so every match here is a match on master. And the
 * lookahead fires only where the blocked token is one the generic alternative consumes whole, so
 * wherever the pair reading is refused the generic reading exists and the star still crosses the
 * token: every match on master is a match here. The languages are equal. The one behavioural
 * divergence left is which `-C` token `repoPathFromOptionRun()` treats as the repo path (below):
 * where master captured an option-shaped token as if it were a directory, this pattern leaves it
 * uncaptured, because `main()` resolves that capture and hands it to git as a cwd that does not
 * exist, so getStagedAbsPaths throws and the hook fails OPEN. Uncaptured keeps gitCwd at the
 * session directory, where the gate can see the staged files. (The `-C` pair alternative's own
 * inner group is non-capturing now — see `repoPathFromOptionRun()` for why deriving repoPath from
 * it directly was unsafe regardless of this divergence.)
 *
 * An earlier revision of this comment cited a differential-corpus count here instead, and it is
 * gone on purpose. The generator behind it enumerated no option-shaped token carrying a character
 * outside `[\w-]` before an `=`, which is exactly the class the narrow lookahead lost, so its
 * zero measured the alphabet of the generator rather than the behaviour of the pattern. A
 * property the next reader can check against the two patterns outlives a number nobody can
 * re-derive.
 *
 * Rejected, with the reason. Blocking the generic alternative from a bare `-C`/`-c`
 * (`(?!-[Cc]\s)`) loses every quoted `-C` argument, which is half two. Narrowing the pair
 * lookahead to `(?!-{1,2}[A-Za-z])` loses the `-a.b` class, which is half three. Blocking the
 * generic alternative only when `-C` has a real non-`commit` argument
 * (`(?!-[Cc]\s+(?!commit(?=\s|$))\S)`) kills the ReDoS and keeps every repo path but still loses
 * `git -C "$PWD" -c user.name=CI commit`, the half-two class one step rarer. Requiring the pair
 * argument to be non-`-` (`(?!-)`) loses more of the same. An input-length cap or a timeout
 * around exec() was never considered: both guard the consumer and leave the pattern wrong
 * (~/.claude/rules/fix-quality.md).
 */
const GIT_COMMIT_RE =
  /\bgit(?=\s)((?:\s+-C\s+(?!-{1,2}[A-Za-z][\w-]*(?:=\S+)?(?=\s|$))(?:\S+)|\s+-c\s+(?!-{1,2}[A-Za-z][\w-]*(?:=\S+)?(?=\s|$))\S+|\s+-{1,2}[A-Za-z][\w-]*(?:=\S+)?)*)\s+commit(?=\s|$)/;

/**
 * Re-derives the `-C` argument from group 1's whole option run instead of trusting a capture
 * taken from inside the star above. That inner capture used to live in the `-C` pair alternative
 * (formerly its own group) and is provably unsafe: ECMAScript resets a capturing group nested
 * inside a quantified group on every repetition that matches through a DIFFERENT alternative, so
 * `git -C /r --no-pager commit` — a perfectly well-formed `-C` followed by one more flag — matched
 * `-C /r` on the star's first pass and `--no-pager` on its second, and the second pass reset the
 * first's capture to `undefined` even though nothing about the `-C` itself was wrong. Confirmed
 * live: `GIT_COMMIT_RE.exec("git -C /r --no-pager commit")` returned `undefined` for that inner
 * group while group 1 (the whole run, captured OUTSIDE the repetition and not subject to the
 * per-iteration reset) held `" -C /r --no-pager"` intact. `main()` then resolved `repoPath` as
 * undefined, fell back to the session `cwd`, and reviewed the wrong repository's staged files —
 * the fail-open case is confined to option-shaped `-C` arguments by design (see the comment above
 * GIT_COMMIT_RE and the `--odd-dir-name` test); a plain, well-formed path being discarded because
 * of an unrelated later flag was not.
 *
 * Fix scans the already-matched, already-bounded group-1 text with the identical option-shaped
 * guard used above, so the master-equivalence property for option-shaped `-C` arguments is
 * unchanged; it just no longer depends on which alternative happened to run last. Global `.exec()`
 * in a plain loop, not the starred alternation, so it carries none of GIT_COMMIT_RE's ReDoS
 * history — no nested quantifiers, no overlapping alternatives to tile.
 *
 * Rejected: rewriting GIT_COMMIT_RE itself so the capture survives repetition. ECMAScript has no
 * way to make a group nested inside a quantified alternation retain a prior iteration's value —
 * the reset is a language rule, not a bug in this expression — so the only in-regex fix is
 * flattening the star into explicit, bounded alternatives (one for "no options", one for "one
 * option", one for "two", …), which reintroduces the exact overlapping-alternative shape the
 * item-37 ReDoS fix spent its docstring proving safe. Rescanning group 1 is smaller and leaves
 * that proof untouched.
 *
 * Repeated `-C` CHAINS, it does not tie-break. git resolves each `-C` relative to the one before
 * it, so `git -C /a -C b commit` runs in `/a/b`. Taking the last one instead returned a bare `b`
 * for that command, which the caller then resolved against the session cwd — a real directory,
 * usually, and not the one git meant. Both ways of being wrong here are silent: a path that does
 * not exist throws into the outer catch and exits 0, and one that exists with nothing staged
 * reaches `decide()`'s bare ALLOW, which carries no `reason` and so never hits the announcement
 * branch. Nothing tells the operator the gate looked at the wrong repository.
 *
 * Worth being precise about the provenance, because it changes who owns it. Before the group-1
 * rescan above, `git -C /a -C b --no-pager commit` produced `undefined` and fell back to the
 * session cwd; now it produces a resolved path. The rescan did not introduce chained `-C`, but it
 * did turn one shape of this bug from "silently reviews the session cwd" into "silently reviews a
 * path git never named", so the fix belongs with it rather than in the backlog.
 *
 * `resolve()` gives the chaining for free: it returns its last absolute argument unchanged and
 * joins a relative one onto the accumulated path, which is exactly git's rule.
 */
function repoPathFromOptionRun(optionRun: string): string | undefined {
  const re = /-C\s+(?!-{1,2}[A-Za-z][\w-]*(?:=\S+)?(?=\s|$))(\S+)/g;
  let repoPath: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(optionRun))) {
    repoPath = repoPath === undefined ? m[1] : resolve(repoPath, m[1]);
  }
  return repoPath;
}

/**
 * True (with the `-C` path, if any) when `command` invokes `git commit`, after blanking quoted
 * and heredoc spans so a commit message or heredoc body merely containing that text can't be
 * mistaken for an invocation. `git commit --dry-run` is currently treated as a real commit and
 * denies if unreviewed — a known, deliberate false deny on a non-mutating command, not an
 * oversight. F-R2-8 tried exempting it and was reverted (F-R3-1): `GIT_COMMIT_RE.exec()` is
 * non-global and stops at the FIRST match, so `git commit --dry-run && git commit -m x` matched
 * only the dry-run invocation, saw `--dry-run` in its tail, and returned `isCommit: false` for
 * the WHOLE command — never examining the second, real commit. Confirmed live: with the
 * exemption present that chained command allows unreviewed; with it removed, denies correctly.
 * Fixing it properly needs iterating every match with a global regex, not just the first, e.g.:
 *   const re = new RegExp(GIT_COMMIT_RE.source, "g");
 *   let m; while ((m = re.exec(scrubbed))) {
 *     if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard: pattern can match empty flag groups
 *     ...compute tail up to next separator or `--` pathspec...; if (!/(^|\s)--dry-run\b/.test(tail)) return { isCommit: true, repoPath: repoPathFromOptionRun(m[1]) };
 *   }
 * That rewrites this function, the most consequential parsing code in the file, and needs its
 * own review round rather than riding back in as a one-line fix. Deferred; not fixed here.
 * Exported for direct testing.
 */
export function parseGitCommitInvocation(command: string): { isCommit: boolean; repoPath?: string } {
  const scrubbed = scrubQuotesAndHeredocs(command);
  const m = GIT_COMMIT_RE.exec(scrubbed);
  if (!m) return { isCommit: false };
  return { isCommit: true, repoPath: repoPathFromOptionRun(m[1]) };
}

/** `tool_use` blocks an assistant entry invoked, with name and input intact. Non-assistant
 * entries yield []; the `isMeta` check below is belt-and-braces, not the load-bearing guard — the
 * structural fact that isMeta only ever marks synthetic `type: "user"` entries (confirmed against
 * 263 isMeta entries across every transcript on this machine, all `type: "user"`, none
 * `type: "assistant"`) is what actually makes this immune, since only `type === "assistant"` is
 * read at all. The explicit check costs one line and stays permissive if that ever stops holding. */
function toolUseBlocksIn(entry: TranscriptEntry): { name: string; input: Record<string, unknown> }[] {
  if (entry.type !== "assistant") return [];
  if (entry.isMeta === true) return [];
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is Record<string, unknown> => (b as Record<string, unknown>)?.type === "tool_use")
    .map((b) => ({
      name: String(b.name ?? ""),
      input: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>,
    }));
}

/**
 * The override reason starting at `rawAfterToken` — the RAW, unscrubbed command text
 * immediately after OVERRIDE_TOKEN. A quoted phrase between matching quotes if the text starts
 * with one (`'prod outage'` → `prod outage`, quotes stripped for display), else the first
 * whitespace-delimited word. Reading from the RAW text, not the scrubbed text used only to find
 * where the token sits, is what lets a human-written quoted reason survive at all (F-R2-1):
 * scrubQuotesAndHeredocs() preserves character offsets (blanks to same-length spaces, never
 * removes or inserts — see its own doc comment and the length assertion in
 * test/review-gate.test.ts), so an index found in the scrubbed text names the exact same position
 * in the raw text. Returns undefined for no reason at all (bare token, or immediately followed by
 * whitespace). Known, accepted gap: `REVIEW_OVERRIDE=prod\ outage` (backslash-escaped space, no
 * quotes) still bypasses but records the reason truncated at the backslash (`prod\`) — cosmetic,
 * since the actual allow/deny outcome is unaffected and the raw command is still what lands in
 * the transcript regardless of how this function renders it back.
 */
function extractOverrideReason(rawAfterToken: string): string | undefined {
  const quote = rawAfterToken[0];
  if (quote === "'" || quote === '"') {
    const closeIdx = rawAfterToken.indexOf(quote, 1);
    if (closeIdx !== -1) return rawAfterToken.slice(1, closeIdx);
    // Unterminated quote: fall through and read it as an unquoted token instead of failing closed.
  }
  return /^\S+/.exec(rawAfterToken)?.[0];
}

/** The path a Write/Edit/NotebookEdit call touched. NotebookEdit's field is `notebook_path`,
 * confirmed against the live tool schema this session runs under; Write and Edit both use
 * `file_path`. */
function editedPath(toolName: string, input: Record<string, unknown>): string | undefined {
  const key = toolName.toLowerCase() === "notebookedit" ? "notebook_path" : "file_path";
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export type ReviewFindings = {
  /** Edited in this transcript, no qualifying review dispatch at or after that edit. Deny on these. */
  unreviewed: string[];
  /** Staged, but this transcript shows no Write/Edit/NotebookEdit touching it at all — no evidence
   * either way, not a violation. Announce these rather than passing silently (FIX 4(d)). */
  noEvidence: string[];
};

/**
 * Given the staged absolute file paths and the full parsed transcript (parent plus merged subagent
 * entries — see `readAllTranscriptEntries()`), sorts staged files into `unreviewed` and
 * `noEvidence`. Exported for direct testing with fabricated entries; no I/O.
 *
 * The `<=` below (not `<`) is deliberate: an edit and a qualifying dispatch as two `tool_use`
 * blocks in the SAME assistant entry share an index, and this harness runs parallel tool_use
 * blocks routinely, so same-index gives no evidence the dispatch actually saw the edited content
 * — treated as unreviewed. See test/review-gate.test.ts for the same-entry case and its ablation.
 */
export function findUnreviewedFiles(stagedAbsPaths: string[], entries: TranscriptEntry[]): ReviewFindings {
  const lastEditIndex = new Map<string, number>();
  const reviewDispatchIndices: number[] = [];

  entries.forEach((entry, index) => {
    for (const { name, input } of toolUseBlocksIn(entry)) {
      const lower = name.toLowerCase();
      if (WRITE_TOOL_NAMES.has(lower)) {
        const path = editedPath(name, input);
        if (path) lastEditIndex.set(resolve(path), index);
      } else if (DISPATCH_TOOL_NAMES.has(lower)) {
        const subagentType =
          typeof input.subagent_type === "string" && input.subagent_type.trim() !== ""
            ? input.subagent_type.trim().toLowerCase()
            : "general-purpose"; // same default the dispatch tool itself applies when omitted
        if (REVIEW_ALLOWLIST.has(subagentType)) reviewDispatchIndices.push(index);
      }
    }
  });

  const latestReviewIndex = reviewDispatchIndices.length > 0 ? Math.max(...reviewDispatchIndices) : -1;

  const unreviewed: string[] = [];
  const noEvidence: string[] = [];
  for (const staged of stagedAbsPaths) {
    const editIndex = lastEditIndex.get(resolve(staged));
    if (editIndex === undefined) {
      noEvidence.push(staged);
    } else if (latestReviewIndex <= editIndex) {
      unreviewed.push(staged);
    }
  }
  return { unreviewed, noEvidence };
}

/** Formats up to five paths plus a "(+N more)" tail. Shared by the deny and the two announced-
 * allow reasons below so the three messages read consistently. */
function listPaths(paths: string[]): string {
  const shown = paths.slice(0, 5);
  const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : "";
  return `${shown.join(", ")}${more}`;
}

/**
 * The gate's whole policy, pure: given the raw command text, the staged absolute paths, and the
 * parsed transcript, decide allow/deny. No I/O — see the header note on how this is tested.
 * `unreadableSubagentCount` (default 0, from `readAllTranscriptEntries()`) only affects the
 * `noEvidence` message's wording (F-R2-3) — it's an attribution hint, not part of the decision.
 */
export function decide(
  command: string,
  stagedAbsPaths: string[],
  entries: TranscriptEntry[],
  unreadableSubagentCount = 0,
): GateDecision {
  const { isCommit } = parseGitCommitInvocation(command);
  if (!isCommit) return ALLOW;

  // The TOKEN's position is found in the SCRUBBED text (FIX 3): it must be a real, deliberate
  // override, not a phrase sitting inert inside the commit message's own quoted argument — a repo
  // that documents this hook will have commits whose message literally contains the string
  // "REVIEW_OVERRIDE=", and that must not self-bypass. But the REASON is read from the RAW text at
  // that same offset (F-R2-1), not matched against the scrubbed text: matching `(\S+)` against the
  // scrubbed text was the original shape of this fix, and it broke the most natural way a person
  // writes a reason — `REVIEW_OVERRIDE='prod outage'` blanks to spaces past the token and the
  // hatch silently fails to engage, denying the exact remediation the deny message just printed.
  // See extractOverrideReason()'s own doc comment for why reading the raw text at the scrubbed
  // text's offset is safe.
  const scrubbed = scrubQuotesAndHeredocs(command);
  const tokenAt = scrubbed.indexOf(OVERRIDE_TOKEN);
  if (tokenAt !== -1) {
    const reason = extractOverrideReason(command.slice(tokenAt + OVERRIDE_TOKEN.length));
    if (reason) {
      return {
        action: "allow",
        reason: `Review gate bypassed via ${OVERRIDE_TOKEN}${reason} in the command.`,
      };
    }
  }

  if (stagedAbsPaths.length === 0) return ALLOW;

  if (entries.length === 0) {
    // No transcript evidence at all: an absent/empty transcript_path, a transcript file that
    // parsed to zero entries, or every line in it failing to parse all collapse to this same
    // input from decide()'s point of view. Announce it (FIX 4) instead of a silent pass, so a
    // blind allow is exactly as visible in the transcript as an explicit override.
    return {
      action: "allow",
      reason:
        `Review gate: no transcript evidence available (missing transcript_path, an empty or ` +
        `unparseable transcript) — allowing without being able to check staged file(s): ` +
        `${listPaths(stagedAbsPaths)}.`,
    };
  }

  const { unreviewed, noEvidence } = findUnreviewedFiles(stagedAbsPaths, entries);

  if (unreviewed.length > 0) {
    return {
      action: "deny",
      reason:
        `Review gate: staged file(s) with no qualifying review dispatch after their last edit this ` +
        `transcript: ${listPaths(unreviewed)}. Dispatch a reviewer (${[...REVIEW_ALLOWLIST].join(", ")}) ` +
        `before committing, or add ${OVERRIDE_TOKEN}<reason> to the commit command to override.`,
    };
  }

  if (noEvidence.length > 0) {
    // Staged, but never seen edited by this transcript's evidence (edited in an earlier session,
    // by hand outside the tool loop, or via Bash — see the header's BASH BLIND SPOT note).
    // Announced rather than silently allowed, for the same reason as the empty-transcript case.
    // F-R2-3: "no edit evidence" can itself be a symptom of a dropped subagent transcript rather
    // than a true no-op — name that possibility instead of implying the absence is conclusive.
    const skipNote =
      unreadableSubagentCount > 0
        ? ` (${unreadableSubagentCount} subagent transcript(s) unreadable or empty; evidence may be incomplete)`
        : "";
    return {
      action: "allow",
      reason:
        `Review gate: staged file(s) with no edit evidence in this transcript, so nothing to check ` +
        `review against — allowing blind: ${listPaths(noEvidence)}.${skipNote}`,
    };
  }

  return ALLOW;
}

/** Staged files as absolute paths, resolved against the repo's actual top level (which `git diff`
 * reports paths relative to — not necessarily `gitCwd`, if that's a subdirectory). `-z` NUL-
 * separates so a filename containing a literal newline still splits correctly, and (verified live,
 * git 2.53.0) also suppresses git's C-style quoting of non-ASCII paths on its own —
 * `core.quotePath` only affects the human-readable, non-`-z` form (`café.ts` → `"caf\303\251.ts"`);
 * under `-z` the byte-identical unquoted UTF-8 name comes back whether the config is true, false,
 * or unset. An earlier revision passed `-c core.quotePath=false` here on the belief that it was
 * load-bearing for that; it was dead the whole time and is gone. Real `git` I/O; a throw here (not
 * a repo, git missing, …) is left to the caller's fail-open contract. */
export function getStagedAbsPaths(gitCwd: string): string[] {
  const raw = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "-z"],
    { cwd: gitCwd, encoding: "utf8" },
  );
  const staged = raw.split("\0").filter((s) => s !== "");
  if (staged.length === 0) return [];
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: gitCwd, encoding: "utf8" }).trim();
  return staged.map((rel) => join(repoRoot, rel));
}

/** Sorts after any real ISO-8601 timestamp string by plain lexicographic comparison — ￿ is
 * above every ASCII digit, so a single char beats any real timestamp's length. See the F-R2-4a
 * note on `readAllTranscriptEntries()` for why "sorts last" is the conservative direction here. */
const MISSING_TIMESTAMP_SENTINEL = "￿";

export type TranscriptEvidence = {
  /** Parent entries plus every subagent transcript's entries, merged and timestamp-ordered. */
  entries: TranscriptEntry[];
  /** Subagent transcript files this function could not use as evidence: either the file itself
   * was unreadable (EISDIR, permissions, mid-write), or it read fine but parsed to zero entries —
   * `readTranscript()` tolerates a malformed line by skipping it, so an ALL-garbage file never
   * throws and would otherwise vanish with no signal at all (F-R2-3). A file that legitimately
   * parses to zero entries (an empty transcript) is indistinguishable from a corrupt one from out
   * here, so both count; see `decide()`'s use of this count for why over-counting here is the
   * accepted direction, not a false-alarm risk in practice — a real subagent transcript, even one
   * that made zero tool calls, still has system/user/assistant bookkeeping entries, so `.length
   * === 0` is a rare, specific signal, not something a normal quiet subagent triggers. */
  unreadableSubagentCount: number;
};

/**
 * The full evidence set for `transcriptPath`: its own entries, plus every subagent transcript
 * dispatched from it, merged and ordered by `timestamp` (FIX 1). Subagent tool calls are NOT
 * written to the parent transcript — they land in
 * `<dirname>/<basename minus .jsonl>/subagents/*.jsonl`, one file per dispatch (verified against
 * this project's own session directory while building this fix; a `transcriptPath` that doesn't
 * end in `.jsonl` degrades safely to parent-only, since `basename(path, ".jsonl")` then leaves the
 * extension on and the resulting `subagentsDir` simply doesn't exist — verified, not assumed).
 * Array index cannot order across files pulled from different sources, but `timestamp` (an
 * ISO-8601 string on every `assistant`/`user` entry, confirmed on the entries this hook actually
 * reads) sorts correctly as plain string comparison and was checked, entry-type-restricted,
 * against real entries across every transcript on this machine with zero inversions relative to
 * true write order. An entry with no string `timestamp` at all sorts using the sentinel
 * `MISSING_TIMESTAMP_SENTINEL` — LAST, not first (F-R2-4a): the input doesn't occur today on the
 * entries this hook reads (measured: 2,353 gate-relevant entries, zero missing timestamps), so
 * this is a stance for a case that hasn't arisen, not a fix for one that has. Sorting last is
 * conservative for an untimestamped EDIT (it can't be "reviewed" by a dispatch that now sorts
 * before it) but permissive for an untimestamped DISPATCH (it now sorts after and clears every
 * earlier edit, the opposite of what a missing timestamp on THAT entry should do) — no single sort
 * position is conservative for both entry kinds at once (F-R3-5). Sorting last was chosen because
 * an edit with no evidence of review is the failure mode this hook exists to catch; a dispatch
 * that can't be timestamped is the rarer, less consequential case to get wrong.
 *
 * A session with no subagent dispatches has no `subagents/` directory at all — that is the normal
 * case, not a gap, and this function stays silent and returns just the parent entries. Listing the
 * directory is itself inside the per-source try (F-R2-2): an unreadable `subagents/` directory
 * (not just an unreadable file inside it) must not throw out of this function and hit the CLI's
 * outer catch, which would be a fully silent fail-open — exactly the shape FIX 4 exists to close,
 * reintroduced by this fix if left uncaught.
 */
export function readAllTranscriptEntries(transcriptPath: string): TranscriptEvidence {
  const parent = readTranscript(transcriptPath);
  const subagentsDir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");

  const subEntries: TranscriptEntry[] = [];
  let unreadableSubagentCount = 0;
  if (existsSync(subagentsDir)) {
    let files: string[] = [];
    try {
      files = readdirSync(subagentsDir);
    } catch {
      // Directory existed at the check above but isn't listable now (removed, permissions,
      // TOCTOU): no subagent evidence available, not a hook-level failure. Counted (F-R3-2) so
      // the noEvidence message says "unreadable" instead of implying nothing happened here.
      unreadableSubagentCount++;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith(".jsonl")) continue; // skips each dispatch's *.meta.json sidecar
      try {
        const parsed = readTranscript(join(subagentsDir, file));
        if (parsed.length === 0) unreadableSubagentCount++; // corrupt-but-didn't-throw, or genuinely empty — can't tell apart from here, count it either way
        subEntries.push(...parsed);
      } catch {
        unreadableSubagentCount++;
      }
    }
  }

  const merged = [...parent, ...subEntries];
  merged.sort((a, b) => {
    const ta = typeof a.timestamp === "string" ? a.timestamp : MISSING_TIMESTAMP_SENTINEL;
    const tb = typeof b.timestamp === "string" ? b.timestamp : MISSING_TIMESTAMP_SENTINEL;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return { entries: merged, unreadableSubagentCount };
}

if (import.meta.main) {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;

    // Defense in depth: only judge Bash calls, whatever the matcher (mirrors agent-worktree-gate.ts).
    if (typeof payload.tool_name === "string" && payload.tool_name !== "Bash") {
      process.exit(0);
    }

    const input = payload.tool_input;
    const command =
      typeof input === "object" && input !== null ? (input as Record<string, unknown>).command : undefined;
    if (typeof command !== "string" || command.trim() === "") process.exit(0);

    const { isCommit, repoPath } = parseGitCommitInvocation(command);
    if (!isCommit) process.exit(0); // short-circuit before any git/transcript I/O

    const cwd = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd();
    const gitCwd = repoPath ? resolve(cwd, repoPath) : cwd;

    const stagedAbsPaths = getStagedAbsPaths(gitCwd);

    let entries: TranscriptEntry[] = [];
    let unreadableSubagentCount = 0;
    if (stagedAbsPaths.length > 0) {
      const transcriptPath = payload.transcript_path;
      if (typeof transcriptPath === "string" && transcriptPath !== "") {
        ({ entries, unreadableSubagentCount } = readAllTranscriptEntries(transcriptPath));
      }
      // No transcript_path: fall through with entries = [] — decide() reads that as "no
      // transcript evidence available" and returns an announced allow (see FIX 4 in the header),
      // not a silent one.
    }

    const decision = decide(command, stagedAbsPaths, entries, unreadableSubagentCount);
    if (decision.action === "deny") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: decision.reason,
          },
        }),
      );
    } else if (decision.reason) {
      // The override path and the two announced-blind-allow paths (empty evidence, no-evidence
      // staged files) all land here: emit an explicit allow so the reason lands in
      // permissionDecisionReason and is visible rather than a silent no-opinion pass-through.
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: decision.reason,
          },
        }),
      );
    }
  } catch (err) {
    // Fail open: log and allow. A broken gate must never block a commit. Covers malformed stdin,
    // an unreadable transcript, a git command that errors, and any other internal exception.
    console.error(`review-gate: hook error, allowing: ${String(err)}`);
  }
  process.exit(0);
}
