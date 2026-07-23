// PreToolUse hook (matcher: Bash) — the #466 chained-state-change gate.
//
// A gh state-changing command landed because a chained sibling's exit code
// masked a failure that should have stopped it. Three occurrences, three seams:
//   - #236: `gh pr checks && gh pr merge` — the failed check's nonzero exit
//     didn't stop the merge (&& saw a green step somewhere / checks passed the
//     wrong thing), so the merge landed on a red verify.
//   - 2026-07-20 #465: `gh pr checks 465 --watch | tail -3 && gh pr merge 465` —
//     the pipe through `tail` replaced gh's nonzero exit with tail's 0, `&&`
//     passed, and the merge landed on red checks.
//   - 2026-07-16 #283 (the class, different seam): a `gh pr merge` failed on
//     conflicts and a chained follow-up ran anyway, closing the PR unmerged.
// The prose rule ("never chain a gh state-changing command with a dependent
// follow-up; check each state-changing step's result BEFORE the next") is in
// .claude/guardrails.md AND re-injected at every session start — and was still
// slid past three times at three different seams. Per the forcing-function
// hierarchy, a rule that prose can't hold graduates from JIT reminder to GATE
// (the #192 pattern: a deterministic string check on the very call it judges —
// no state, no counting, no false-positive surface beyond a deliberate one-liner
// the message tells you to split).
//
// The gate as shipped, matching the issue's fix shape exactly: DENY a Bash
// command in which a state-changing gh verb (`gh pr merge`, `gh pr close`, or
// `gh repo delete`) appears AFTER a chaining operator (`&&`, `||`, `;`, `|`, or
// a newline) in the same command string. A state-changer that is the sole or the
// FIRST command in the string is allowed — its own exit is visible to the caller,
// so nothing upstream could have masked it. The only thing denied is a deliberate
// one-liner that puts the state-change downstream of another command, where an
// upstream failure (or an exit-code masked by a pipe) can let it land silently.
// The fix is always the same and the message says so: run the state-changing gh
// command as its own Bash call.
//
// Deviation receipt (guardrails.md hooks are otherwise POSIX sh): this hook must
// tokenize a command string on shell operators without being fooled by `||` vs
// `|` or by an override token, and its decision logic is unit-tested offline as a
// pure function. bun is already the project's hard dependency (engines.bun in
// package.json), same call as the #192 gate. A raw sh grep for `gh pr merge`
// could not tell "sole command" from "downstream of a pipe" — the position
// relative to the operator is the whole point.
//
// Scope receipt: only gh state-changers are gated, because the issue narrows to
// them deliberately. The 2026-07-16 #283 seam (a gh merge failing first, then a
// chained *git* branch deletion running) is a git-side destructive follow-up this
// gh-verb gate does not target; catching arbitrary destructive follow-ups after
// any command would need a denylist that produces false positives, gets muted,
// and protects nothing. This gate catches the two gh-merge-on-red seams verbatim
// and the general class of a gh state-changer landing downstream of a masked exit.
//
// Fail-open contract: a broken hook must never brick every Bash call — this hook
// runs on ALL of them. Every error path (malformed stdin, missing fields, our own
// bugs) logs to stderr and exits 0 with no stdout, which Claude Code treats as
// "no opinion." Only a well-formed deny emits JSON. No network, no mutation,
// stdin→stdout only. Decision logic lives in the exported pure `decide()` so
// `bun test test/gh-chain-merge-gate.test.ts` can exercise it offline; the
// stdin/stdout contract is covered by spawn tests in the same file.

/**
 * State-changing gh verbs, as whitespace-tolerant patterns. Matched with a word
 * boundary so `gh pr merge` matches but a hypothetical `gh pr mergequeue` would
 * not. Scoped to the verbs the issue names: pr merge, pr close, repo delete.
 */
const STATE_CHANGE_VERB = /\bgh\s+(?:pr\s+(?:merge|close)|repo\s+delete)\b/;

/**
 * Shell chaining operators that separate one command from the next. Order in the
 * alternation matters: `&&` and `\|\|` are tried before the single-char class so
 * a `||` is consumed as one token (not two `|`) and `&&` is never split. A single
 * `|`, a `;`, and a newline each separate commands too.
 */
const CHAIN_SPLIT = /&&|\|\||[;\n|]/;

/**
 * Conscious-override token: a caller who deliberately wants the chained one-liner
 * writes `GH-CHAIN-OVERRIDE: <reason>` in a `# ...` comment on the command. The
 * regex requires a preceding `#` on the same line (anchoring the token to a real
 * shell comment, matching the guardrails.md doc intent — a token buried in a
 * `--body "..."` string is NOT an override) and non-empty reason text after the
 * colon (a bare token is not a reasoned override, per the #192 gate's finding).
 * Receipt for existing: without an in-band override the only bypass is muting the
 * hook in settings.json, and a muted hook protects nothing. The token forces the
 * override to be written, reasoned, and visible in the transcript. Round-3: the
 * override check runs on the QUOTED-MASKED command (see `decide()`), so a token
 * sitting inside a `--body "…"` string — a real string the reviewer will read, not
 * a real shell comment — can never grant a bypass; only a `#` that survives masking
 * (i.e. is a real, unquoted comment) counts.
 */
export const OVERRIDE_TOKEN = "GH-CHAIN-OVERRIDE:";
const OVERRIDE_RE = /#[^\n]*GH-CHAIN-OVERRIDE:[ \t]*\S/;

export type GateDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

const ALLOW: GateDecision = { action: "allow" };

/**
 * Blank out the contents of quoted spans so the operator split only sees operators
 * that actually separate shell statements — not a `&&`/`;`/`|` or a gh verb sitting
 * inside a string or heredoc body. Reviewer HIGH #487: this repo routinely writes
 * `gh pr create`/`gh pr comment` bodies that DISCUSS these commands (this very PR's
 * body did), and the raw split flagged that inert text as a chained state change.
 *
 * A single left-to-right scan tracks quote state, which is correct where two
 * independent regexes are not: a `"` inside `'...'` is literal and vice-versa, so a
 * naive "strip all '...' then all \"...\"" mis-pairs quotes. Bash rules: single
 * quotes are fully literal (no escapes); inside double quotes only `\` escapes the
 * next char. A `#`-comment is left intact so the override token survives. The common
 * `--body "$(cat <<'EOF' … EOF)"` heredoc is handled for free — the whole `$(…)` sits
 * inside the outer double quotes, so its body (newlines and all) is blanked. A bare
 * unquoted heredoc is the accepted residual edge (reviewer: "separate tool calls
 * always"); its body lines are not quoted, so it is not masked.
 *
 * Round-3 fix (independent re-review of round-2): the scan also tracks an
 * `inComment` state, entered on an UNQUOTED `#` and cleared on a newline. While in a
 * comment, quote characters are passed through literally instead of toggling `quote`
 * — without this, prose like `don't`/`it's` inside a real comment opens a fake
 * single-quote span that swallows everything after it, including a genuine chained
 * `&& gh pr merge` on the next line (round-2 false-negative: an apostrophe in a
 * comment masked a real chain). Comment text itself is NOT dropped — it is passed
 * through unchanged, deliberately conservative: any operator or gh verb spelled out
 * after an unquoted `#` still trips the chain check downstream, because we cannot
 * tell "inert trailing comment" from "the human meant this to run" from text alone,
 * and a false deny (own-call, its own message says how to split it) costs far less
 * than a false allow (a merge lands on red).
 */
function maskQuoted(command: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  let inComment = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (inComment) {
      out += c; // comment text passes through unchanged — see round-3 note above
      if (c === "\n") inComment = false;
      continue;
    }
    if (quote === null) {
      if (c === "#") {
        inComment = true;
        out += c;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "\\") {
        i++; // escaped char outside quotes is literal, never an operator — drop both
      } else {
        out += c;
      }
      continue;
    }
    // inside a quote: drop the char; only the matching close (or an escape in "…") is special
    if (quote === '"' && c === "\\") {
      i++; // skip the escaped char so a `\"` does not close the string early
    } else if (c === quote) {
      quote = null;
    }
  }
  return out;
}

/**
 * True iff a state-changing gh verb appears in a segment that is NOT the first —
 * i.e. it sits downstream of a `&&`, `||`, `;`, `|`, or newline. A state-changer
 * that is the sole or first command is allowed (nothing upstream could mask it).
 * Quoted content is masked out first so operators/verbs inside strings do not count.
 */
export function isChainedStateChange(command: string): boolean {
  const segments = maskQuoted(command).split(CHAIN_SPLIT);
  // segments[0] is the first command; a state-changer there is fine. Only a verb
  // in a LATER segment means it runs downstream of an operator.
  return segments.slice(1).some((seg) => STATE_CHANGE_VERB.test(seg));
}

/** Pure decision over the PreToolUse stdin payload. Unrecognizable input allows. */
export function decide(payload: unknown): GateDecision {
  if (typeof payload !== "object" || payload === null) return ALLOW;
  const p = payload as Record<string, unknown>;

  // Defense in depth: only judge Bash, whatever the matcher.
  if (typeof p.tool_name === "string" && p.tool_name !== "Bash") return ALLOW;

  const input = p.tool_input;
  if (typeof input !== "object" || input === null) return ALLOW;
  const command = (input as Record<string, unknown>).command;
  if (typeof command !== "string" || command === "") return ALLOW;

  // Conscious override wins before any verb check — tested on the quoted-masked
  // form so a token sitting inside a string (not a real `#` comment) never counts.
  if (OVERRIDE_RE.test(maskQuoted(command))) return ALLOW;

  if (!isChainedStateChange(command)) return ALLOW;

  return {
    action: "deny",
    reason:
      `Chained-state-change gate (#466): a state-changing gh command ` +
      `(gh pr merge / gh pr close / gh repo delete) appears downstream of a ` +
      `chaining operator (&&, ||, ;, or |) in this one Bash call. An upstream ` +
      `step's exit code can mask a failure and let the state change land anyway ` +
      `— exactly how PR #236 merged over a red verify and PR #465 merged on red ` +
      `checks (a pipe through tail replaced gh's nonzero exit with 0). Run the ` +
      `state-changing gh command as its own Bash call, after you have checked the ` +
      `result of the previous step. To consciously run the chained one-liner ` +
      `anyway, put "${OVERRIDE_TOKEN} <reason>" in a comment on the command — the ` +
      `reason is required.`,
  };
}

if (import.meta.main) {
  try {
    const decision = decide(JSON.parse(await Bun.stdin.text()));
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
    }
  } catch (err) {
    // Fail open: log and allow. A broken gate must never brick every Bash call.
    console.error(`gh-chain-merge-gate: hook error, allowing command: ${String(err)}`);
  }
  process.exit(0);
}
