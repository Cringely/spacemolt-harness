// Transcript JSONL parsing, shared by any hook that reads a Claude Code session transcript.
// Extracted from core/claude/hooks/dispatch-audit.ts (deleted, #97) when that file's other half
// — auditLastTurn(), the turn-bucketing detection it drove, and the never-wired Stop-hook
// entrypoint — was removed for shipping untested and unused. review-gate.ts is this module's one
// real consumer today (`readTranscript`, `TranscriptEntry` at its import line), reading each
// staged file's edit history against dispatch evidence; test/review-gate.test.ts imports the type
// the same way, and the readTranscript-parsing tests that used to live in
// test/dispatch-audit.test.ts moved here with the function.
//
// PROVENANCE, carried forward rather than dropped. dispatch-audit.ts's header credited
// `bradygaster/squad`'s `.squad/hooks/dispatch-audit.sh` (MIT, repo-wide) as the design this repo
// ported "in spirit, not in text." That credit belongs to the turn-bucketing logic squad's
// version and dispatch-audit.ts's now-deleted auditLastTurn() both implement — not to this
// function: squad's own mechanism was a self-written per-turn ledger, and dispatch-audit.ts
// explicitly declined to port that ledger, reading the real transcript instead, which is what
// readTranscript() below does. So the credited code is gone, not moved here. This note exists
// anyway because NOTICE carries no attribution for bradygaster/squad, and this is the one file
// descended from dispatch-audit.ts that survives its deletion — dropping the pointer here would
// leave that MIT credit recorded nowhere in the repo.

import { readFileSync } from "node:fs";

export type TranscriptEntry = Record<string, unknown>;

/** Parses a Claude Code transcript JSONL file, tolerating blank lines and a partial last line
 * (the file can be mid-write when a caller reads it). */
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
