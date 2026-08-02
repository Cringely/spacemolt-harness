// The read-side counterpart to write-report.ts (#654). Jailed, deterministic
// lookup over $SCHEDULER_STATE_DIR/reports/ for a job that needs to consult a
// PAST report but holds no general Bash grant to go looking for it itself.
//
// Root cause this closes (#654, #582): stand-up's charter names
// "$SCHEDULER_STATE_DIR/reports/*-council-review.md" as its council-ordering
// source, but stand-up's allowedTools (jobs.ts) grant no Bash that can
// resolve the $SCHEDULER_STATE_DIR env var into a literal path — no
// `printenv`, no `ls`, no `find`, and Read/Glob need a literal path the agent
// has no way to construct. Every such attempt is DENIED by the closed
// allowedTools list, and nine-plus stand-up cycles then reported that denial
// as "council stalled" and escalated it to a P0 BLOCKER: a refused lookup
// became a positive claim about system state. This script closes the
// evidence gap the producer way — it resolves SCHEDULER_STATE_DIR itself
// (a Node env read inside the child process, the same trick write-report.ts
// already relies on; no shell expansion needed) and always returns ONE of
// two unambiguous outcomes, so there is nothing left to misread as a denial:
//   - a match: `FOUND <filename> mtime=<ISO8601>` then the file body
//   - no match: the literal sentinel `NO_MATCHING_REPORT_FOUND`
// Never silence, never a bare empty string — both looked identical to "I was
// denied" once the false-P0 pattern started.
//
//   bun scripts/read-latest-report.ts --glob <pattern>
//
// The caller is a spawned agent, so --glob is UNTRUSTED input (spec
// §Security). Restricted to a safe filename-glob character set (letters,
// digits, `_ . - *`) — no `/`, no `..`, no absolute path — so a crafted
// --glob can never walk out of reports/ into a sibling state-dir directory
// (secrets/, logs/). No further symlink jail is needed for THIS traversal
// path (unlike write-report.ts's --file, which takes a caller-supplied path
// segment): the matched filename here comes only from a real reports/
// directory listing, never from concatenating untrusted input into a path.
// A symlink PLANTED inside reports/ is still excluded below (defense in
// depth) — write-report.ts already refuses to create one there, so this is
// four lines, not a new primitive.
//
// A THIRD outcome, not just FOUND/NO_MATCH: readdirSync on a reports/ we
// can't list, or a target file we can't open, must never collapse into
// NO_MATCHING_REPORT_FOUND — that is #654's exact defect (denied read read
// as "nothing there") rebuilt inside its own fix. Any I/O failure prints
// `REPORT_READ_FAILED <errno-code> <what>` and exits 1, distinct from the
// exit-2 usage/rejected-input path and the exit-0 FOUND/NO_MATCH path
// (same three-way exit-code convention as file-finding.ts: 0 success,
// 1 runtime failure, 2 usage). `<what>` is a bare filename or "reports/",
// never the resolved absolute path — the error code plus the name is
// enough to act on without printing anything host-specific.
//
// CodeQL js/file-system-race (#66 review): the original code picked the
// newest filename via the readdir-time lstat filter, then re-touched the
// filesystem by path at read time (statSync/readFileSync(target)) — two
// separate lookups of the same name, a window in which a symlink swapped
// in between them would defeat the exclusion below. Fixed by opening the
// target exactly ONCE with O_NOFOLLOW and doing every subsequent
// operation (stat, read) on that same descriptor: the symlink check and
// the use are now the same syscall, so there is no gap for a swap to land
// in. The lstat filter over directory entries stays (it decides which
// name is "newest" among candidates, not whether the read is safe), but
// the read itself no longer trusts it.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const NO_MATCH = "NO_MATCHING_REPORT_FOUND";

function usage(msg: string): never {
  console.error(msg);
  console.error("usage: bun scripts/read-latest-report.ts --glob <filename pattern, e.g. '*-council-review.md'>");
  process.exit(2);
}

/**
 * A genuine I/O failure (permission denied, vanished file, etc.) reading
 * something that IS there — as opposed to NO_MATCH, which means nothing
 * matched. Kept distinct on purpose: see the file-header comment on why
 * folding this into NO_MATCH would rebuild #654's exact defect. `what` is
 * a bare filename, never a resolved path (may carry stateDir internals).
 */
function failRead(e: unknown, what: string): never {
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "UNKNOWN";
  console.log(`REPORT_READ_FAILED ${code} ${what}`);
  process.exit(1);
}

/** Turn a restricted filename glob (only `*` as a wildcard) into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Pick the newest name matching `glob` out of `names` (already filtered to
 * real, non-symlink reports/ entries) — filenames are `<YYYY-MM-DD>-*`, so
 * lexical order is chronological order, the same convention write-report.ts's
 * callers already rely on. Exported so the sort direction is a unit-testable
 * decision, not buried in the CLI's control flow.
 */
export function pickNewest(names: string[], glob: string): string | null {
  const pattern = globToRegExp(glob);
  const matches = names.filter((n) => pattern.test(n)).sort();
  return matches.length === 0 ? null : matches[matches.length - 1]!;
}

// Guarded like repo-hygiene.ts's `if (import.meta.main)`: read-latest-report.test.ts
// imports globToRegExp/pickNewest directly for pure-function unit tests, and an
// unguarded top-level run would fire this CLI body (and its process.exit calls)
// at IMPORT time, killing the whole test file — not the write-report.ts
// pattern (never imported, only spawned), needed here specifically because
// these two functions are worth unit-testing without a subprocess per case.
function main(): void {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) usage(`bad argument: ${flag}`);
    opts[flag.slice(2)] = value;
  }
  const glob = opts.glob;
  if (!glob) usage("expected: --glob <pattern>");
  if (!/^[A-Za-z0-9_.*-]+$/.test(glob)) {
    usage(`--glob must be a plain filename pattern (letters, digits, _ . - *): got ${glob}`);
  }

  const stateDir = process.env.SCHEDULER_STATE_DIR;
  if (!stateDir) usage("SCHEDULER_STATE_DIR is not set — read-latest-report runs only inside a scheduled job");

  const reportsDir = resolve(stateDir, "reports");

  let entries: string[] = [];
  if (existsSync(reportsDir)) {
    let names: string[];
    try {
      names = readdirSync(reportsDir);
    } catch (e) {
      failRead(e, "reports/"); // e.g. denied list permission — NOT "no reports exist"
    }
    entries = names.filter((n) => {
      try {
        return !lstatSync(join(reportsDir, n)).isSymbolicLink();
      } catch {
        return false; // vanished between readdir and lstat — treat as absent, not a match
      }
    });
  }

  const newest = pickNewest(entries, glob);
  if (newest === null) {
    console.log(NO_MATCH);
    return;
  }

  const target = join(reportsDir, newest);

  // Single open, O_NOFOLLOW: rejects a symlink target atomically (no separate
  // check-then-use gap for a swap to land in — see file-header comment).
  // Every read below operates on this one descriptor, not on `target` again.
  // O_NOFOLLOW is POSIX-only — Node/Bun leaves fs.constants.O_NOFOLLOW
  // undefined on Windows, so `?? 0` makes that a documented no-op there
  // rather than an accidental one. The scheduler this script actually runs
  // on is Linux, where the flag is real; the dev/test host here is Windows,
  // where this line of defense is inert and the upstream lstat filter over
  // directory entries (below) is what the symlink-exclusion test exercises.
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    failRead(e, newest);
  }
  try {
    const mtime = fstatSync(fd).mtime.toISOString();
    const body = readFileSync(fd, "utf8");
    console.log(`FOUND ${newest} mtime=${mtime}`);
    console.log(body);
  } catch (e) {
    failRead(e, newest);
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) main();
