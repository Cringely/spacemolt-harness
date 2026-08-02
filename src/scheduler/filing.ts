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
// Visibility fix (2026-07-26 operator escalation): every filed issue also
// carries a deterministic priority label (resolvePriorityLabel below) — the
// PM's own read of the backlog is priority-ordered, and a `machine-filed`-only
// issue was invisible to it (#551-554 filed with that label alone). See
// DEFAULT_TRIAGE_LABEL for why the default is applied HERE, not left to the
// spawned job to remember.
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

// Producer fix: every ceremony-filed issue carried ONLY `machine-filed`, no
// priority label — invisible to a PM who reads the backlog by priority
// (verified: #551-554 filed 2026-07-26, `machine-filed` was the sole label).
// Applied unconditionally, HERE, not a label the spawned job is asked to
// pass, because this project has already been burned trusting an LLM to
// volunteer a field on its own (#542: `plan.instruction_done` never came
// from the planner). An earlier draft let the caller escalate via a
// `--priority` override; review (R7, PR #29) cut it: every filed issue gets
// this label with or without an override, so the flag served no invariant —
// the only path that ever set a non-default priority was a briefing telling
// an LLM to volunteer it, the exact failure class this fix exists to remove.
// Verified to exist in Cringely/spacemolt via `gh label list` before use
// (2026-07-26) — an unknown label 422s `gh issue create` and turns a working
// ceremony silent, which is worse than the invisibility bug this fixes.
export const DEFAULT_TRIAGE_LABEL = "priority:P2";

// The issues SSOT is the PRIVATE repo (AGENTS.md backlog-model), not whatever
// remote the checkout's `origin` happens to point at. Before the 2026-07-21
// public flip, "unscoped" and "private" were the same repo, so this bug was
// latent; after the flip, an unscoped `gh issue` call resolves against the
// now-public repo instead — dedup silently stops matching and every create
// fails (no machine-filed label there). Every gh issue call in this file goes
// through run() below, so pinning it here is the one seam that can't drift.
export const FILING_REPO = "Cringely/spacemolt";

/** Validation failure on untrusted caller input — the CLI maps this to exit 2. */
export class FilingInputError extends Error {}

/** Hard cap on the finding body (enforced here and again at the CLI's STDIN read). */
export const MAX_BODY_BYTES = 64 * 1024;

// Producer fix (#635): a headless spawn has no memory of past runs, so three
// separate cycles minted three spellings of one finding — `core_harvest_unimplemented`,
// `core-harvest-unimplemented-p0`, `p0-core-harvest-unimplemented` — and the exact-phrase
// dedup search (below) matched none of them against each other. Tightened from
// `[A-Za-z0-9._-]` to lowercase-only kebab-case (no underscore, no dot, no leading/
// trailing/doubled hyphen): this mechanically collapses the case/separator half of
// that drift. The other half — a severity affix (p0/blocker) riding inside the key —
// is closed below by fileFinding() itself (see findNearMatch), not left to a work-order
// convention an agent can forget: review (PR #62) flagged the first cut of this fix for
// putting the whole invariant in prose an agent might not follow, so the create path
// now enforces it directly.
const DEDUP_KEY_RE = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;

// Reads a PRIOR key back out of an issue body — permissive on purpose (production
// issues may still carry the pre-tightening underscore/dot keys from before this
// fix), unlike DEDUP_KEY_RE which only governs what a NEW key may be.
const SM_DEDUP_MARKER_RE = /<!--\s*sm-dedup:([A-Za-z0-9._-]+)\s*-->/;

// Closed, small vocabulary matching this project's own priority scheme
// (DEFAULT_TRIAGE_LABEL: priority:P0-P3) plus the literal word #621's issue title
// carried ("P0 BLOCKER"). Stripping these as whole hyphen-segments lets
// `core-harvest-unimplemented-p0` and `p0-core-harvest-unimplemented` normalize to
// the same `core-harvest-unimplemented`, closing the EXACT drift #635 recorded.
// It is deliberately NOT a general similarity matcher: two runs that pick genuinely
// different words for the same condition (`core-harvest-unimplemented` vs
// `core-harvest-job-unimplemented`) still mint two issues — that residual gap needs
// judgment no regex can supply, and is named as such rather than silently claimed
// fixed (a rung-2 gate here would need fuzzy matching, which trades a mechanical,
// ablatable check for a probabilistic one; rejected for that reason).
const SEVERITY_WORDS = new Set(["p0", "p1", "p2", "p3", "blocker", "critical"]);

function normalizeDedupKey(key: string): string {
  return key
    .split("-")
    .filter((seg) => !SEVERITY_WORDS.has(seg))
    .join("-");
}

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

// Every `gh issue *` call the filer makes passes through here — scoping the
// repo in this ONE place, rather than at each call site, is what makes it
// impossible for a future call site to forget --repo (the exact way this bug
// happened: the list/create calls silently inherited the checkout's remote).
function run(gh: GhRunner, args: string[]): string {
  const scoped = [...args, "--repo", FILING_REPO];
  const { stdout, exitCode } = gh(scoped);
  if (exitCode !== 0) throw new Error(`gh ${scoped[0]} ${scoped[1]} failed (exit ${exitCode}): ${stdout.slice(0, 300)}`);
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

interface NearMatchHit {
  number: number;
  body: string;
}

// gh issue list defaults to 30 results; raised to cover the realistic
// machine-filed volume (92 open at review time) without unbounded pagination.
// ponytail: a hardcoded ceiling, not a config knob — a repo whose machine-filed
// backlog outgrows this needs a design revisit, not a bigger constant.
const NEAR_MATCH_FETCH_LIMIT = 200;

// The auto-bump half of #635 (PR #62 review, finding 1): fileFinding() must
// catch the severity-affix drift itself, not depend on an agent searching
// before it mints a key. No query string at all — fetch by MACHINE_LABEL
// alone and filter the JSON client-side (PR #62 review, finding 2): this
// removes the query-DSL charset/injection surface the first cut of this fix
// introduced, at the cost of one client-side pass over an already-bounded
// fetch. OPEN only (unlike findDedupMatch's open+recently-closed): a
// near-match to something closed >30d ago should file fresh, same
// philosophy the exact-match window already encodes.
function findNearMatch(gh: GhRunner, dedupKey: string): number | undefined {
  const stdout = run(gh, [
    "issue",
    "list",
    "--state",
    "open",
    "--label",
    MACHINE_LABEL,
    "--limit",
    String(NEAR_MATCH_FETCH_LIMIT),
    "--json",
    "number,body",
  ]);
  let hits: NearMatchHit[];
  try {
    hits = JSON.parse(stdout) as NearMatchHit[];
  } catch {
    return undefined; // unparseable answer → no near-match, caller mints fresh rather than crash
  }
  const wanted = normalizeDedupKey(dedupKey);
  for (const hit of hits) {
    // Same schema-tolerance posture as loadCounter/readActiveCycle: a hit
    // missing/mistyping `body` (a partial gh answer, not a real production
    // shape) degrades to "no key here" rather than throwing mid-scan.
    if (typeof hit.body !== "string") continue;
    const candidateKey = hit.body.match(SM_DEDUP_MARKER_RE)?.[1];
    if (candidateKey !== undefined && normalizeDedupKey(candidateKey) === wanted) return hit.number;
  }
  return undefined;
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
        "--label",
        DEFAULT_TRIAGE_LABEL,
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
  // #635 fix: an exact-key miss still gets one more check — a severity-word
  // variant of a key already carried by an OPEN machine-filed issue. This is
  // what makes the fix mechanical rather than a convention the agent might
  // skip: `core-harvest-unimplemented-p0` bumps the issue already filed under
  // `p0-core-harvest-unimplemented` with no agent search step in between.
  const nearMatchIssue = match ? undefined : findNearMatch(gh, dedupKey);
  const bumpTarget = match?.number ?? nearMatchIssue;
  if (bumpTarget !== undefined) {
    const scratch = writeScratchBody(stateDir, body);
    run(gh, ["issue", "comment", String(bumpTarget), "--body-file", scratch]);
    counter.count += 1;
    saveCounter(stateDir, jobId, cycleId, counter);
    return { outcome: "bumped", issue: bumpTarget };
  }

  // (a)(2): label + provenance on every created issue. Priority label too
  // (producer fix): a PM who reads the backlog by priority must see this
  // issue without depending on the filing job having passed one.
  const scratch = writeScratchBody(stateDir, body);
  const stdout = run(gh, [
    "issue",
    "create",
    "--title",
    title,
    "--label",
    MACHINE_LABEL,
    "--label",
    DEFAULT_TRIAGE_LABEL,
    "--body-file",
    scratch,
  ]);
  counter.count += 1;
  saveCounter(stateDir, jobId, cycleId, counter);
  return { outcome: "created", issue: parseIssueNumber(stdout) };
}
