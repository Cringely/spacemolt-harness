// OPT-IN. Not referenced by settings.hooks.json or any project's
// settings.json; an operator wires it deliberately. Wire it at USER level
// (~/.claude/settings.json), not per project: memory writes come from whatever
// project is open, so a per-project registration counts only that project's
// share and leaves the rest unrecorded. Counters go to one file under the home
// directory either way (see STATE_PATH), so the only thing project-level
// registration changes is how much gets missed.
//
//   {
//     "matcher": "Write|Edit",
//     "hooks": [
//       {
//         "type": "command",
//         "command": "bun \"C:\\\\Users\\\\<you>\\\\.claude\\\\hooks\\\\memory-transition-log.ts\"",
//         "timeout": 5
//       }
//     ]
//   }
//
// No "shell" key: the command invokes bun directly and needs no call operator,
// unlike the PowerShell hooks alongside it that open with "&".
//
// PostToolUse hook (matcher: Write|Edit) — memory-note transition counter.
//
// Two A/B runs caught dispatched agents closing a decision note's "Revisit
// when" trigger on their own authority, and in one case editing a note whose
// status was `proposed` to prescribe a value — both authority the memory-system
// skill reserves for the user ("Claude NEVER sets status: accepted"). A
// one-sentence prompt fix cut that from 2 of 4 runs to 0 of 4, but n=4 is thin
// evidence for whether a blocking gate is worth building. This hook turns the
// one-off measurement into ongoing counts: every Write/Edit under a memory/
// directory that looks like one of the three transitions below gets one JSON
// line appended. It counts. It does not enforce, warn, or touch stdout.
//
// Transitions detected, each requiring an OLD and NEW view of the changed
// text:
//   1. metadata.status changed value (e.g. proposed -> accepted)
//   2. a "## Revisit when" heading present in the old text is gone from the new
//   3. status: rejected appears in the new text where it did not before
//
// Old/new text comes only from the payload, never from disk: Edit's
// `old_string`/`new_string` give an exact before/after of the changed span, so
// all three transitions are checkable. Write only carries the new `content` —
// the tool already overwrote the file by the time this hook runs, so there is
// no prior text to diff. That is not a gap to patch, it is the correct
// behaviour: a brand-new note isn't "transitioning" into a status, it's being
// created with one. So Write inputs never yield a detection here; the hook
// still fires on Write (per the header snippet) because a future note could
// reasonably want the tool captured either way.
//
// Fail-open contract, matching agent-write-scope.ts and agent-worktree-gate.ts:
// the whole body is one try/catch. Malformed stdin, an unreadable state
// directory, permission errors, or a bug in the frontmatter regexes all land
// in the catch, get one stderr line for anyone reading the transcript (never
// stdout, never the counters file), and exit 0. A detection hook that blocks
// or corrupts a write is worse than no hook — see the "Never write to stdout"
// rule below, which holds even when a transition IS detected: this hook has no
// opinion Claude Code should act on, only a count to keep.
//
// Decision logic lives in the exported pure functions below so a future
// `bun test` can exercise them with no spawn and no filesystem.

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

/** Directory name that puts a path in scope. Matches on any path segment. */
const MEMORY_SEGMENT = "memory";

/**
 * Counters go to one file under the home directory, never under the project
 * root. Memory writes originate from whatever project happens to be open, so a
 * project-relative counter shards the count across every project the operator
 * touches, and an empty file then reads as "nothing happened" when the real
 * answer is "it was recorded somewhere else". One file, absolute note paths in
 * each line, no glob needed to read it.
 */
const STATE_PATH = join(homedir(), ".claude", "state", "memory-transitions.jsonl");

export type Transition =
  | { kind: "status-changed"; old: string; new: string }
  | { kind: "revisit-removed" }
  | { kind: "status-rejected-appeared"; old: string | null };

/**
 * Is `filePath` inside a `memory/` directory? Resolved against `cwd` when
 * relative, same convention as agent-write-scope.ts's inScratch.
 */
export function inMemoryDir(filePath: string, cwd: string): boolean {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  return abs
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === MEMORY_SEGMENT);
}

/** `metadata.status` value from a YAML frontmatter fragment, or null if absent. */
export function extractStatus(text: string): string | null {
  return text.match(/^[ \t]+status:[ \t]*(\S+)/m)?.[1] ?? null;
}

/** Does the text contain the "## Revisit when" decision-note section heading? */
export function hasRevisitSection(text: string): boolean {
  return /^##[ \t]+Revisit when\b/m.test(text);
}

/**
 * Pure diff over old/new text spans. `oldText` undefined (the Write case, no
 * prior text available) yields no transitions — nothing to compare against.
 */
export function detectTransitions(oldText: string | undefined, newText: string): Transition[] {
  if (oldText === undefined) return [];

  const found: Transition[] = [];
  const oldStatus = extractStatus(oldText);
  const newStatus = extractStatus(newText);

  if (oldStatus && newStatus && oldStatus !== newStatus) {
    found.push({ kind: "status-changed", old: oldStatus, new: newStatus });
  }
  if (hasRevisitSection(oldText) && !hasRevisitSection(newText)) {
    found.push({ kind: "revisit-removed" });
  }
  if (newStatus === "rejected" && oldStatus !== "rejected") {
    found.push({ kind: "status-rejected-appeared", old: oldStatus });
  }
  return found;
}

if (import.meta.main) {
  try {
    const payload = JSON.parse(await Bun.stdin.text()) as {
      tool_name?: string;
      tool_input?: { file_path?: string; old_string?: string; new_string?: string; content?: string };
      cwd?: string;
      session_id?: string;
    };

    const toolName = payload.tool_name;
    if (toolName !== "Write" && toolName !== "Edit") process.exit(0); // defense in depth, matcher already scopes this

    const filePath = payload.tool_input?.file_path;
    const cwd = payload.cwd ?? process.cwd();
    if (!filePath || !inMemoryDir(filePath, cwd)) process.exit(0); // cheap bail before any text work

    const oldText = toolName === "Edit" ? payload.tool_input?.old_string : undefined;
    const newText = (toolName === "Edit" ? payload.tool_input?.new_string : payload.tool_input?.content) ?? "";

    const transitions = detectTransitions(oldText, newText);
    if (transitions.length === 0) process.exit(0);

    const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
    const notePath = abs.replace(/\\/g, "/");
    const ts = new Date().toISOString();

    if (!existsSync(dirname(STATE_PATH))) mkdirSync(dirname(STATE_PATH), { recursive: true });

    const lines = transitions
      .map((t) =>
        JSON.stringify({
          ts,
          transition: t.kind,
          ...("old" in t ? { old: t.old } : {}),
          ...("new" in t ? { new: t.new } : {}),
          notePath,
          tool: toolName,
          ...(payload.session_id ? { sessionId: payload.session_id } : {}),
        }),
      )
      .join("\n");
    appendFileSync(STATE_PATH, lines + "\n", "utf8");
  } catch (err) {
    // Fail open: log nothing to the counters file, print nothing to stdout,
    // one stderr line for the transcript, exit 0. A broken counter must never
    // brick a write.
    console.error(`memory-transition-log: hook error, skipping: ${String(err)}`);
  }
  process.exit(0);
}
