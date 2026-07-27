// SessionStart hook — surfaces OPEN ceremony-filed findings at the top of
// every fresh context, sibling to session-start-guardrails.sh (hook 1).
//
// Why this exists (2026-07-26 operator escalation, verbatim): "We depend on
// the ceremonies you need to check in for their results" / "You need to
// correct not checking in on ceremony output, you cannot overlook the
// output." Root cause verified before this fix: every ceremony-filed issue
// carries exactly ONE label, `machine-filed` (confirmed on #551-554) — no
// priority label, so it sits OUTSIDE the priority-ordered read the PM
// actually performs. src/scheduler/filing.ts now applies a default priority
// label to every NEW filing (the producer fix), but that only helps issues
// filed from here on. This hook is the complementary JIT re-injection
// (guardrails.md forcing-function hierarchy, tier 3): it queries by
// `machine-filed` + open state directly, so a PM reading only priority
// labels still can't miss it, and it also covers every issue filed BEFORE
// the producer fix landed.
//
// Degrade-gracefully contract (this is a SessionStart hook — it fires on
// every session, so a broken or slow `gh` must never be worse than no hook):
//   - `gh` missing, unauthenticated, offline, or erroring ⇒ print NOTHING, exit 0.
//   - `gh` hanging ⇒ hard timeout (CEREMONY_FINDINGS_TIMEOUT_MS, default 4s),
//     enforced by fetchOpenCeremonyFindings itself via Promise.race, not just
//     by the child process's own kill timer — so even a runner that never
//     settles cannot block session start past the timeout.
//   - malformed/unexpected JSON ⇒ treated as failure, same silent exit 0.
//
// Cap (CEREMONY_FINDINGS_CAP, default 12): open ceremony findings can run into
// the dozens (steward/strategy/standup/council all file into the same
// machine-filed pool). Printing all of them would flood every session's
// opening context — the exact "tedious/ignored" failure mode this file's
// sibling hooks were built to avoid. 12 keeps the banner to roughly a
// terminal screenful while still exceeding the largest single-incident burst
// on record (the 2026-07-26 escalation cites 10+ findings in 72h); beyond
// the cap, the banner says how many more exist and how to list them.
//
// All I/O (the gh call) is behind an injectable CeremonyGhRunner so the
// formatting/timeout/degradation logic is unit-tested offline — no live gh
// call in `bun test` (test/session-start-ceremony-findings.test.ts).
//
// FILING_REPO/MACHINE_LABEL are INLINED, not imported from
// ../../src/scheduler/filing (R1, PR #29 review): this file must run
// standalone as a SessionStart hook in ANY spacemolt clone, including the
// private backlog repo, which has no src/scheduler directory at all — a
// cross-package import only resolves in the harness checkout, so the
// registration silently no-ops everywhere else (that WAS the bug: the PM's
// actual project directory is the private clone, and the hook never fired
// there). Cost of inlining: two literals that can drift from the canonical
// ones in filing.ts. Guarded by a pinning test
// (test/session-start-ceremony-findings.test.ts, "stays in sync with
// src/scheduler/filing.ts") that fails the moment either copy changes
// without the other.
export const FILING_REPO = "Cringely/spacemolt";
export const MACHINE_LABEL = "machine-filed";

export interface CeremonyIssue {
  number: number;
  title: string;
  createdAt: string;
}

interface GhSpawnResult {
  exitCode: number;
  stdout: string;
}

export type CeremonyGhRunner = (args: string[], timeoutMs: number) => Promise<GhSpawnResult>;

export const CEREMONY_FINDINGS_CAP_DEFAULT = 12;
export const CEREMONY_FINDINGS_TIMEOUT_MS_DEFAULT = 4000;

const GH_ARGS = [
  "issue",
  "list",
  "--repo",
  FILING_REPO,
  "--label",
  MACHINE_LABEL,
  "--state",
  "open",
  "--json",
  "number,title,createdAt",
  "--limit",
  "100",
];

/**
 * The real runner: spawns `gh` (or CEREMONY_FINDINGS_GH_BIN if set — an
 * ablation/testing seam only, never used in normal operation) and kills it
 * if it outruns timeoutMs. A missing binary rejects (ENOENT); a killed
 * process resolves with a nonzero/undefined exit — both read as failure by
 * the caller.
 */
export const runGh: CeremonyGhRunner = async (args, timeoutMs) => {
  const bin = process.env.CEREMONY_FINDINGS_GH_BIN || "gh";
  const proc = Bun.spawn({ cmd: [bin, ...args], stdout: "pipe", stderr: "pipe" });
  const killTimer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited — nothing to do
    }
  }, timeoutMs);
  try {
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { exitCode, stdout };
  } finally {
    clearTimeout(killTimer);
  }
};

/**
 * Fetch open `machine-filed` issues, or null on ANY failure (bad exit,
 * timeout, malformed JSON, thrown error — e.g. `gh` not on PATH). The
 * Promise.race is a hard backstop independent of the runner's own timeout
 * handling: even a runner whose promise never settles cannot block this
 * past timeoutMs, which is what lets the offline test simulate a hang
 * without a real subprocess.
 */
export async function fetchOpenCeremonyFindings(
  runner: CeremonyGhRunner,
  timeoutMs: number,
): Promise<CeremonyIssue[] | null> {
  try {
    const timedOut = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const result = await Promise.race([runner(GH_ARGS, timeoutMs), timedOut]);
    if (result === null || result.exitCode !== 0) return null;
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (x): x is CeremonyIssue =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as CeremonyIssue).number === "number" &&
        typeof (x as CeremonyIssue).title === "string" &&
        typeof (x as CeremonyIssue).createdAt === "string",
    );
  } catch {
    return null; // gh missing (ENOENT), a thrown spawn error, malformed JSON, etc.
  }
}

/** "3h" / "2d" — coarse enough for a scan-at-a-glance banner, not a duration report. */
export function formatAge(createdAtIso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(createdAtIso);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "<1h";
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Pure formatter: empty input ⇒ empty string (main prints nothing — no
 * banner for zero findings). Newest first. Beyond `cap`, appends a
 * truncation line naming the real count and how to list the rest.
 */
export function formatCeremonyBanner(
  issues: CeremonyIssue[],
  cap: number = CEREMONY_FINDINGS_CAP_DEFAULT,
  nowMs: number = Date.now(),
): string {
  if (issues.length === 0) return "";
  const sorted = [...issues].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const shown = sorted.slice(0, cap);
  const lines = [
    "",
    "############################################################",
    `# CEREMONY FINDINGS — ${issues.length} open, machine-filed (newest first)      #`,
    "# Check these in before starting new work.                #",
    "############################################################",
    ...shown.map((i) => `  #${i.number}  (${formatAge(i.createdAt, nowMs)} old)  ${i.title}`),
  ];
  if (sorted.length > cap) {
    lines.push(
      `  ... +${sorted.length - cap} more — gh issue list --repo ${FILING_REPO} --label ${MACHINE_LABEL} --state open`,
    );
  }
  lines.push("############################################################");
  return lines.join("\n");
}

if (import.meta.main) {
  const timeoutMs = Number(process.env.CEREMONY_FINDINGS_TIMEOUT_MS) || CEREMONY_FINDINGS_TIMEOUT_MS_DEFAULT;
  const cap = Number(process.env.CEREMONY_FINDINGS_CAP) || CEREMONY_FINDINGS_CAP_DEFAULT;
  try {
    const issues = await fetchOpenCeremonyFindings(runGh, timeoutMs);
    if (issues && issues.length > 0) {
      console.log(formatCeremonyBanner(issues, cap));
    }
  } catch {
    // never break session start
  }
  process.exit(0);
}
