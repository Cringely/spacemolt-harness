// Durable scheduler (#114) Task C2: the mechanical finding filer — the ONE
// path a headless job files a backlog issue through, encoding verdict (a)'s
// conditions 1-4 (spec §Self-correction boundary):
//   (1) dedup queries open AND recently-closed (~30d) issues, never open-only
//       (the closing-keyword incident class);
//   (2) every filed issue carries the machine-provenance label + job/cycle id;
//   (3) a dedup match gets a comment-bump, not a new issue;
//   (4) a per-cycle volume cap — at cap, ONE summary issue, not N issues.
// Condition (a)(5) — filing decoupled from dispatch — is architectural: this
// module imports NO spawn/agent module and returns data only (the reviewer
// verifies the import graph; plan §C2).
//
// gh access is injected (GhRunner) so tests run offline; dedup uses gh's own
// --json output — external jq is absent on this host, never shell out to it.
//
// Input hardening (Batch C security review): the caller is a SPAWNED AGENT,
// so every input is untrusted (spec §Security: LLM output is untrusted
// input). Rejected before any gh call, with FilingInputError:
// - body is the finding text ITSELF, delivered on the CLI's STDIN (mirroring
//   scripts/write-report.ts) and capped at 64KB — no file path is accepted, so
//   there is no path-jail to escape and no host file an agent could exfiltrate
//   into an issue body (the old outbox `--body-file` jail was unreachable: no
//   fleet tool could CREATE a file there, so capability (a) was dead on arrival);
// - dedupKey is allowlisted to [A-Za-z0-9._-]{1,64} and searched as a quoted
//   phrase — otherwise the key is a search-operator injection into gh;
// - job/cycle identity comes from the scheduler-written active-cycle.json,
//   never from CLI flags — otherwise fresh minted cycle ids bypass the
//   (a)(4) flood cap.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GhResult {
  stdout: string;
  exitCode: number;
}
export type GhRunner = (args: string[]) => GhResult;

export interface FindingInput {
  jobId: string;
  cycleId: string;
  dedupKey: string;
  title: string;
  /** The finding text itself (the CLI reads it from STDIN), never a file path. */
  body: string;
}

export interface FindingOutcome {
  outcome: "created" | "bumped" | "capped";
  issue?: number;
}

export const MACHINE_LABEL = "machine-filed";

/** Validation failure on untrusted caller input — the CLI maps this to exit 2. */
export class FilingInputError extends Error {}

/** Hard cap on the finding body (enforced here and again at the CLI's STDIN read). */
export const MAX_BODY_BYTES = 64 * 1024;

const DEDUP_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Scheduler-owned filing identity: runJob (spawn.ts) writes this file at each
// spawn; the file-finding CLI reads it instead of trusting caller flags.
// ponytail: left in place after the run — it is also a useful last-run record,
// and a stale id just continues the finished cycle's counter (harmless).
export const ACTIVE_CYCLE_FILE = "active-cycle.json";

export interface ActiveCycle {
  jobId: string;
  cycleId: string;
}

export function writeActiveCycle(stateDir: string, ac: ActiveCycle): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, ACTIVE_CYCLE_FILE), JSON.stringify(ac));
}

export function readActiveCycle(stateDir: string): ActiveCycle | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, ACTIVE_CYCLE_FILE), "utf8")) as Partial<ActiveCycle>;
    if (typeof raw.jobId === "string" && typeof raw.cycleId === "string")
      return { jobId: raw.jobId, cycleId: raw.cycleId };
  } catch {
    // missing/corrupt → null (schema-tolerant, like every other state file)
  }
  return null;
}

// ponytail: 5 is a ceiling, not a quota — healthy cycles file 0-2 findings
// (strategy adapt-ladder and council norms), so 5 is headroom; the no-cap
// alternative is exactly what verdict (a)(4) forbids.
export const FINDINGS_PER_CYCLE_CAP = 5;

const CLOSED_DEDUP_WINDOW_MS = 30 * 86_400_000; // ~30d, verdict (a)(1)

interface CycleCounter {
  count: number;
  summaryIssue: number | null;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const counterPath = (dir: string, jobId: string, cycleId: string) =>
  join(dir, `filing-${safeName(jobId)}-${safeName(cycleId)}.json`);

// Same persisted-state tolerance as the other state files: a corrupt counter
// degrades to zero (worst case: a crash mid-cycle re-opens the cap's headroom)
// rather than bricking every future filing.
function loadCounter(dir: string, jobId: string, cycleId: string): CycleCounter {
  try {
    const raw = JSON.parse(readFileSync(counterPath(dir, jobId, cycleId), "utf8")) as Partial<CycleCounter>;
    return {
      count: typeof raw.count === "number" && raw.count >= 0 ? raw.count : 0,
      summaryIssue: typeof raw.summaryIssue === "number" ? raw.summaryIssue : null,
    };
  } catch {
    return { count: 0, summaryIssue: null };
  }
}

function saveCounter(dir: string, jobId: string, cycleId: string, c: CycleCounter): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(counterPath(dir, jobId, cycleId), JSON.stringify(c));
}

// Body always travels via --body-file, never argv (the ENAMETOOLONG class —
// a finding body is unbounded text). The scratch file lives in the state dir
// and is overwritten per call.
function writeScratchBody(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "finding-compose.tmp.md");
  writeFileSync(p, text);
  return p;
}

function run(gh: GhRunner, args: string[]): string {
  const { stdout, exitCode } = gh(args);
  if (exitCode !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed (exit ${exitCode}): ${stdout.slice(0, 300)}`);
  return stdout;
}

// `gh issue create` prints the new issue's URL; the trailing number is the id.
function parseIssueNumber(stdout: string): number | undefined {
  const m = stdout.trim().match(/\/issues\/(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

interface DedupHit {
  number: number;
  state: string;
  closedAt: string | null;
}

// Open match, or the newest close within the window. Open wins over closed so
// the bump lands where the conversation is still live.
function findDedupMatch(gh: GhRunner, dedupKey: string, now: number): DedupHit | undefined {
  const stdout = run(gh, [
    "issue",
    "list",
    "--state",
    "all",
    "--search",
    `"<!-- sm-dedup:${dedupKey} -->" in:body`, // quoted phrase — the key cannot smuggle search operators
    "--json",
    "number,state,closedAt",
  ]);
  let hits: DedupHit[];
  try {
    hits = JSON.parse(stdout) as DedupHit[];
  } catch {
    return undefined; // unparseable dedup answer → file fresh rather than drop the finding
  }
  const open = hits.find((h) => h.state.toUpperCase() === "OPEN");
  if (open) return open;
  return hits
    .filter((h) => h.closedAt !== null && now - Date.parse(h.closedAt) <= CLOSED_DEDUP_WINDOW_MS)
    .sort((a, b) => Date.parse(b.closedAt as string) - Date.parse(a.closedAt as string))[0];
}

export function fileFinding(gh: GhRunner, stateDir: string, input: FindingInput): FindingOutcome {
  const { jobId, cycleId, dedupKey, title, body: rawBody } = input;
  if (!DEDUP_KEY_RE.test(dedupKey)) {
    throw new FilingInputError(`dedup-key must match ${DEDUP_KEY_RE} (got: ${JSON.stringify(dedupKey)})`);
  }
  // Cap the incoming body before any gh call (the CLI also caps at its STDIN read).
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    throw new FilingInputError(`finding body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  const counter = loadCounter(stateDir, jobId, cycleId);
  const provenance = `filed-by: scheduler/${jobId} cycle ${cycleId}`;
  const marker = `<!-- sm-dedup:${dedupKey} -->`;
  const body = `${rawBody.trimEnd()}\n\n${marker}\n${provenance}\n`;

  // (a)(4): over the cap, everything folds into ONE per-cycle summary issue.
  if (counter.count >= FINDINGS_PER_CYCLE_CAP) {
    const overflowNote = `## ${title}\n\n${body}`;
    if (counter.summaryIssue === null) {
      const scratch = writeScratchBody(
        stateDir,
        `Per-cycle finding cap (${FINDINGS_PER_CYCLE_CAP}) reached; further findings from this cycle append here instead of opening new issues.\n\n${provenance}\n\n${overflowNote}`,
      );
      const stdout = run(gh, [
        "issue",
        "create",
        "--title",
        `scheduler/${jobId} cycle ${cycleId}: findings over cap`,
        "--label",
        MACHINE_LABEL,
        "--body-file",
        scratch,
      ]);
      counter.summaryIssue = parseIssueNumber(stdout) ?? null;
    } else {
      const scratch = writeScratchBody(stateDir, overflowNote);
      run(gh, ["issue", "comment", String(counter.summaryIssue), "--body-file", scratch]);
    }
    counter.count += 1;
    saveCounter(stateDir, jobId, cycleId, counter);
    return { outcome: "capped", issue: counter.summaryIssue ?? undefined };
  }

  // (a)(1)+(a)(3): dedup across open and recently-closed; a match is bumped.
  const match = findDedupMatch(gh, dedupKey, Date.now());
  if (match) {
    const scratch = writeScratchBody(stateDir, body);
    run(gh, ["issue", "comment", String(match.number), "--body-file", scratch]);
    counter.count += 1;
    saveCounter(stateDir, jobId, cycleId, counter);
    return { outcome: "bumped", issue: match.number };
  }

  // (a)(2): label + provenance on every created issue.
  const scratch = writeScratchBody(stateDir, body);
  const stdout = run(gh, ["issue", "create", "--title", title, "--label", MACHINE_LABEL, "--body-file", scratch]);
  counter.count += 1;
  saveCounter(stateDir, jobId, cycleId, counter);
  return { outcome: "created", issue: parseIssueNumber(stdout) };
}
