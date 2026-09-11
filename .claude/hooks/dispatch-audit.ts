// OPT-IN. Not referenced by `core/claude/templates/settings.hooks.json` or any project's
// settings.json; an operator wires it deliberately. The installer's settings merge only touches
// event keys present in that template, and `Stop` isn't one of them, so this file lands on disk
// in every installed project, gets hashed into `.harness-manifest.json`, and never runs unless
// wired in by hand:
//
//   "Stop": [{"hooks":[{"type":"command","command":"bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch-audit.ts\""}]}]
//
// Two known defects to weigh before wiring it in, since wiring makes both live:
//
// (a) `isRealUserPrompt()` below never reads `entry.isMeta`. Claude Code sets `isMeta: true` on
// injected skill bodies, `<local-command-caveat>` blocks, and agent-message deliveries, and this
// hook currently reads each of those as a real turn boundary. Measured against real history: 93
// mid-turn `isMeta` entries across 442 transcripts, 11 Stop points flip verdict (7 false
// negatives, 4 false positives). One-line fix when wiring: add
// `if (entry.isMeta === true) return false;` right after the `entry.type !== "user"` guard, plus
// a fixture covering it.
//
// (b) The write-detector flags any Write/Edit/NotebookEdit call with no dispatch in the turn, but
// `~/.claude/rules/agent-usage.md` carves out a single-line trivial edit (typo, version bump,
// comment) as legitimately inline, so it fires on those too. Left unresolved: `guardrails.template.md`
// already warns that a hook muted for false positives protects nothing.
//
// Stop hook (no matcher) — advisory dispatch-audit.
//
// Mechanizes the operator's `~/.claude/rules/agent-usage.md` prose rule ("if you are about to
// produce a domain artifact and have not dispatched this turn, stop and dispatch instead") as
// something that actually fires, instead of a rule that has to be remembered under load. That
// file's own hierarchy ranks prose as the weakest tier for exactly this reason.
//
// Ported in spirit, not in text, from `bradygaster/squad`, `.squad/hooks/dispatch-audit.sh`
// (MIT, repo-wide). Squad's version reads a self-written per-turn JSONL ledger the coordinator
// is expected to append to every turn, and treats a missing/empty ledger as "indeterminate," not
// a free pass. This version does not carry that ledger over: Claude Code's `Stop` hook already
// hands a `transcript_path` pointing at the real conversation history, so a second, hand-written,
// self-attested record would just be one more thing that can drift from what actually happened.
// This hook reads the real transcript instead.
//
// DETECTION MECHANISM, verified against a live transcript in this repo's own project directory
// (not assumed from docs): Claude Code's session JSONL has one entry per line. A real user-typed
// prompt is `{type:"user", message:{role:"user", content: <string, or an array with no
// tool_result block>}}`; a tool result echoed back as role "user" is `{type:"user", ...,
// toolUseResult: {...}, message:{content:[{type:"tool_result", ...}]}}`. An assistant turn is
// `{type:"assistant", message:{content:[{type:"tool_use", name:"Write"|"Agent"|..., ...}, ...]}}`.
// Confirmed live: the subagent-dispatch tool's `tool_use` block name is "Agent", not "Task",
// matching what `agent-worktree-gate.ts` already checks for on the PreToolUse side.
//
// "The current turn" = every transcript entry after the last real user-typed prompt. Splitting
// the whole transcript on those same boundaries, for free, in the same parse, would give squad's
// multi-turn "dispatch drift" signal (repeated turns with no dispatch) too; this first version
// ships only the single-turn "wrote without dispatching" signal and leaves that extension for
// later, on purpose — see the NOTED item in the dispatch report for this task.
//
// STDIN CONTRACT for Stop, confirmed via a live fetch of the current hooks reference (not the
// bundled skill copy, which predates a schema change): session_id, prompt_id, transcript_path,
// cwd, permission_mode, hook_event_name, last_assistant_message, stop_reason, and
// stop_hook_active. `stop_hook_active` is true when Claude Code is already continuing as a
// result of a previous Stop hook's output; this hook stays silent whenever it's true, so a nudge
// this hook itself triggers can never make it nudge again on the same turn.
//
// ADVISORY ONLY, never blocking: this hook only ever emits `hookSpecificOutput.additionalContext`
// (a Stop hook is documented to support that field, unlike most other events, precisely for
// non-error feedback that continues the conversation) and never `"decision":"block"`. A false
// positive on a gate like this gets muted within a day, and a muted hook protects nothing — the
// same reasoning `guardrails.template.md` already states for why this repo keeps its hook count
// small. The note it emits is phrased as a question to self-check against the exemption in
// agent-usage.md (a single-line trivial edit stays inline), not an assertion that a violation
// occurred, because this hook cannot tell "wrote code directly" from "wrote one line of a typo
// fix" — that judgment call stays with the model reading the reminder.
//
// Fail-open contract, matching this repo's other hooks: malformed stdin, an unreadable or
// unparseable transcript, or our own bugs all log to stderr and exit 0 with no stdout. Only a
// well-formed note ever prints. No network, no mutation, stdin/file-read to stdout only.
//
// Detection logic lives in the exported pure `auditLastTurn()`, which takes already-parsed
// transcript entries and returns nothing else — no file I/O, no stdin — so `bun test
// test/dispatch-audit.test.ts` can exercise it against fixture arrays with no process spawn and
// no real transcript file. The thin `readTranscript()` I/O wrapper is covered separately against
// real temp files in the same test file. The `import.meta.main` stdin/stdout entrypoint below is
// NOT spawn-tested; neither of this repo's other two TS PreToolUse hooks spawn-test their own
// entrypoint either, so this stays consistent with existing coverage rather than being a gap
// specific to this hook.

import { readFileSync } from "node:fs";

export type TranscriptEntry = Record<string, unknown>;

export type AuditDecision = { action: "silent" } | { action: "note"; reason: string };

/** Tool names, lowercased, that count as a subagent dispatch. Matches the "Agent" tool name
 * `agent-worktree-gate.ts` already keys its PreToolUse gate on; "task" kept as a defensive
 * alias in case a future Claude Code version renames the tool, since nothing here proves it won't. */
const DISPATCH_TOOLS = new Set(["agent", "task"]);

/** Tool names, lowercased, that write the repo checkout directly. */
const WRITE_TOOLS = new Set(["write", "edit", "notebookedit"]);

/**
 * True when `entry` is a real user-typed prompt, not a tool result Claude Code echoes back with
 * the same `type:"user"` shape. The distinguishing signal, confirmed against a live transcript:
 * a tool result's `message.content` is an array where at least one block has `type:"tool_result"`;
 * a real prompt's content is either a plain string or an array with no such block.
 */
function isRealUserPrompt(entry: TranscriptEntry): boolean {
  if (entry.type !== "user") return false;
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return true; // unrecognized shape: fail toward "this is a boundary"
  return !content.some((block) => (block as Record<string, unknown>)?.type === "tool_result");
}

/** `tool_use` names an assistant entry invoked, original casing preserved for display. Non-
 * assistant entries yield []. */
function toolNamesIn(entry: TranscriptEntry): string[] {
  if (entry.type !== "assistant") return [];
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => (block as Record<string, unknown>)?.type === "tool_use")
    .map((block) => String((block as Record<string, unknown>).name ?? ""));
}

/**
 * Pure core. Given the FULL parsed transcript (oldest entry first, the order Claude Code writes
 * it in), decide whether the most recent turn, everything after the last real user prompt,
 * called a write tool with no Agent/Task dispatch anywhere in that same turn.
 *
 * An empty or all-tool-result transcript (no real user prompt found at all) audits the whole
 * array as one turn rather than erroring: a short first turn is still a turn worth checking.
 */
export function auditLastTurn(entries: TranscriptEntry[]): AuditDecision {
  let turnStart = 0;
  for (let i = 0; i < entries.length; i++) {
    if (isRealUserPrompt(entries[i])) turnStart = i + 1;
  }
  const turn = entries.slice(turnStart);
  const names = turn.flatMap(toolNamesIn);
  const dispatched = names.some((name) => DISPATCH_TOOLS.has(name.toLowerCase()));
  const wroteTools = [...new Set(names.filter((name) => WRITE_TOOLS.has(name.toLowerCase())))];

  if (wroteTools.length > 0 && !dispatched) {
    return {
      action: "note",
      reason:
        `[dispatch-audit] This turn called ${wroteTools.join(", ")} directly with no Agent/Task ` +
        `dispatch in the same turn. Per agent-usage.md, a write (implementation, refactor, config ` +
        `edit) is delegated by default; the one exception is a single-line trivial edit (typo, ` +
        `version bump, comment) with no logic in it. If this write was more than that, the next ` +
        `similar change should go through Agent dispatch instead of an inline tool call.`,
    };
  }
  return { action: "silent" };
}

/** Parses a Claude Code transcript JSONL file, tolerating blank lines and a partial last line
 * (the file can be mid-write when this hook reads it). */
export function readTranscript(path: string): TranscriptEntry[] {
  const raw = readFileSync(path, "utf8");
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Tolerate one malformed/partial line rather than discarding the whole transcript over it.
    }
  }
  return entries;
}

if (import.meta.main) {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;

    // Never re-fire on our own continuation: see the stdin-contract note above.
    if (payload.stop_hook_active === true) {
      process.exit(0);
    }

    const transcriptPath = payload.transcript_path;
    if (typeof transcriptPath !== "string" || transcriptPath === "") {
      process.exit(0); // no transcript named: say nothing rather than guess at one
    }

    const entries = readTranscript(transcriptPath);
    const decision = auditLastTurn(entries);
    if (decision.action === "note") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: decision.reason,
          },
        }),
      );
    }
  } catch (err) {
    // Fail open: log and stay silent. A broken advisory hook must never block a stop.
    console.error(`dispatch-audit: hook error, staying silent: ${String(err)}`);
  }
  process.exit(0);
}
