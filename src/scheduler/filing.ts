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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// Stripping it is necessary and, as of 2026-08-11, measured to be nowhere near
// sufficient: against the live backlog this normalization collapses none of the
// 170 open keys. The residual gap it names below — two runs picking genuinely
// different words for the same condition — turned out to BE the whole problem,
// so it is now closed deterministically by isNearDuplicate (tier 3) rather than
// left to judgment. That is still a mechanical, ablatable check: fixed word
// lists and a fixed threshold, no model in the loop.
const SEVERITY_WORDS = new Set(["p0", "p1", "p2", "p3", "blocker", "critical"]);

// Normalization also folds legacy separators and case (PR #62, third REVISE):
// SM_DEDUP_MARKER_RE above reads underscore/dot keys back out of production
// issue bodies on purpose (production issues may predate the kebab-case
// tightening), and a legacy key may also carry mixed case since only
// DEDUP_KEY_RE — governing NEW keys — is lowercase-only. Without folding both,
// a legacy key can never normalize to the same string as a fresh kebab-case
// key for the same condition (live case: Cringely/spacemolt#622, body carries
// `pipeline_idle_wave_ready`). `+` collapses runs so `foo__bar` and `foo-bar`
// land on the same normal form.
function normalizeDedupKey(key: string): string {
  return key
    .toLowerCase()
    .split(/[-_.]+/)
    .filter((seg) => !SEVERITY_WORDS.has(seg))
    .join("-");
}

/**
 * Reads a prior key back out of an issue body. Exported because
 * scripts/groom-report.ts must read the marker exactly the way the filer
 * writes it — one seam, not two regexes that drift apart.
 */
export function readDedupKey(body: string): string | undefined {
  return body.match(SM_DEDUP_MARKER_RE)?.[1];
}

// --- tier 3: deterministic near-match over the SAME fetched payload ---------
//
// Measured gap (2026-08-11, live dump of every open marker-bearing
// machine-filed issue in Cringely/spacemolt): the #635 normalization above
// collapses ZERO of the 170 keys. It folds separators and strips severity
// words, and neither is the drift that actually happened. A headless spawn has
// no memory of last cycle, so it re-words the same standing condition every
// run — `pr-83-red-ci-8d`, `pr-83-red-ci-hung-8-days`, `pr-83-red-ci-stalled`,
// `pr83-red-ci-8days-unresolved`, and 15 more, all one red CI. A producer fix
// that ships and then collapses nothing is worse than an absent one, because
// the backlog reads as covered.
//
// What varies between those keys is exactly two things: how long the condition
// has been broken, and how annoyed this cycle is about it. Both are strippable
// as whole segments. What must NOT be stripped is the entity the finding is
// about — #618 (`pr-40-red-ci-merge`) is a different, real finding, and an
// earlier cut of this rule that treated `40` as just another number merged it
// into the PR #83 pile. Hence the anchor set, checked before any similarity.

// Age-of-condition and annoyance words. Segment-exact, never substring: a key
// segment `staleness` is not the word `stale`.
const STALENESS_WORDS = new Set([
  "still",
  "again",
  "unresolved",
  "unfixed",
  "unaddressed",
  "stalled",
  "stuck",
  "hung",
  "overdue",
  "stale",
  "urgent",
  "days",
  "day",
  "hours",
  "hrs",
  "week",
  "weeks",
  "now",
  "ongoing",
  "persists",
  "continues",
]);

// A bare duration segment: `7`, `8d`, `9h`, `4days`, `2weeks`. The number is the
// age of the condition, which changes by construction on every cycle.
const BARE_DURATION_RE = /^\d{1,2}(d|h|day|days|hour|hours|w|week|weeks)?$/;

// `pr-83`, `pr83`, `issue-114`, `gh-40`. Anchored on \b so a bare number
// elsewhere in the key is NOT an anchor — only an entity word plus its digits.
const ENTITY_ANCHOR_RE = /\b(pr|issue|gh)[-_.]?(\d{1,4})\b/g;

/**
 * Segment-overlap floor for a tier-3 bump. 0.6 was measured against the live
 * dump, not picked: it collapses the 13 real clusters while leaving #618
 * (PR #40) and every cross-entity pair alone. Lowering it merges unrelated
 * `red-ci` findings; raising it splits the PR-83 pile back apart.
 */
export const NEAR_MATCH_JACCARD = 0.6;

/** The entity words a key names, normalized so `pr-83` and `pr83` are one anchor. */
export function entityAnchors(key: string): Set<string> {
  const out = new Set<string>();
  for (const m of key.toLowerCase().matchAll(ENTITY_ANCHOR_RE)) out.add(`${m[1]}${m[2]}`);
  return out;
}

/** The key's meaning-bearing segments: anchors, severity, staleness and durations removed. */
export function keySegments(key: string): Set<string> {
  const out = new Set<string>();
  for (const seg of key.toLowerCase().replace(ENTITY_ANCHOR_RE, " ").split(/[-_. ]+/)) {
    if (!seg) continue;
    if (SEVERITY_WORDS.has(seg) || STALENESS_WORDS.has(seg) || BARE_DURATION_RE.test(seg)) continue;
    out.add(seg);
  }
  return out;
}

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Two dedup keys name the same finding when their entity anchors are EQUAL
 * (which covers "both name nothing") and their remaining segments overlap at
 * NEAR_MATCH_JACCARD or better.
 *
 * The anchor test runs first and is absolute, not a weighting: a key about
 * PR #40 and a key about PR #83 are different findings no matter how similar
 * the rest of the words are. Two keys that reduce to no segments at all never
 * match — an empty-vs-empty Jaccard is 0 here on purpose, so a pathological
 * key made entirely of noise words cannot swallow the backlog.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  if (!setsEqual(entityAnchors(a), entityAnchors(b))) return false;
  const sa = keySegments(a);
  const sb = keySegments(b);
  let intersection = 0;
  for (const x of sa) if (sb.has(x)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union > 0 && intersection / union >= NEAR_MATCH_JACCARD;
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
// machine-filed volume without unbounded pagination. 400 because the live
// backlog carried 170 open marker-bearing machine-filed issues on 2026-08-11,
// and a limit that silently truncates makes the scan miss the very duplicate
// it exists to catch. ponytail: a hardcoded ceiling, not a config knob — a
// repo that outgrows this needs a design revisit, not a bigger constant, and
// the `truncated` signal below is how anyone finds out it happened.
const NEAR_MATCH_FETCH_LIMIT = 400;

/**
 * How the near-match scan went. The distinction is the whole point: a clean
 * miss and a scan that could not read its own input both produce "no bump",
 * and if they produce the same bytes downstream nobody ever learns the scan
 * broke. That is the #654 denial-as-absence class, and it is recorded here
 * rather than inferred.
 */
type NearMatchFetch = "ok" | "truncated" | "unparseable";

interface NearMatchResult {
  issue?: number;
  fetch: NearMatchFetch;
}

// The auto-bump half of #635 (PR #62 review, finding 1): fileFinding() must
// catch the severity-affix drift itself, not depend on an agent searching
// before it mints a key. No query string at all — fetch by MACHINE_LABEL
// alone and filter the JSON client-side (PR #62 review, finding 2): this
// removes the query-DSL charset/injection surface the first cut of this fix
// introduced, at the cost of one client-side pass over an already-bounded
// fetch. OPEN only (unlike findDedupMatch's open+recently-closed): a
// near-match to something closed >30d ago should file fresh, same
// philosophy the exact-match window already encodes.
function findNearMatch(gh: GhRunner, dedupKey: string): NearMatchResult {
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
    return { fetch: "unparseable" }; // no near-match, caller mints fresh rather than crash
  }
  // `null`/`5`/`{}` all survive JSON.parse and would throw on iteration — same
  // schema-tolerance posture as loadCounter, and it must degrade LOUDLY.
  if (!Array.isArray(hits)) return { fetch: "unparseable" };
  // A full page means the backlog may extend past what we just scanned, so a
  // miss from here is "not found in the first 400", not "not present".
  const fetch: NearMatchFetch = hits.length >= NEAR_MATCH_FETCH_LIMIT ? "truncated" : "ok";
  const wanted = normalizeDedupKey(dedupKey);
  for (const hit of hits) {
    // A hit missing/mistyping `body` (a partial gh answer, not a real
    // production shape) degrades to "no key here" rather than throwing mid-scan.
    if (typeof hit.body !== "string") continue;
    const candidateKey = readDedupKey(hit.body);
    if (candidateKey === undefined) continue;
    // Tier 2 (exact normalized equality, #635) then tier 3 (anchored segment
    // overlap). Tier 2 is kept rather than folded in: it still catches a pair
    // whose segments reduce to nothing at all, where tier 3 declines by design.
    if (normalizeDedupKey(candidateKey) === wanted || isNearDuplicate(candidateKey, dedupKey))
      return { issue: hit.number, fetch };
  }
  return { fetch };
}

/**
 * Per-filing side channel, appended beside the cycle counters this module
 * already owns. It carries the key, what happened to it, the issue number, and
 * how the near-match scan went.
 *
 * Deliberately NOT a field on FindingOutcome: the CLI's stdout is read by the
 * SPAWNED AGENT, not by the scheduler, so anything put there reaches the run
 * log only if the agent volunteers it — the exact failure class that got
 * `--priority` cut (see DEFAULT_TRIAGE_LABEL above). A file the filer writes
 * itself needs no agent cooperation.
 */
// NOT named `filing-*`: the per-cycle counters are `filing-<job>-<cycle>.json`,
// and a log file sharing that prefix silently joins every readdir that counts
// counters (it broke the cap test's "exactly one counter file" assertion on the
// first cut of this change).
export const FILING_LOG_FILE = "finding-log.jsonl";

export interface FilingLogEntry {
  ts: string;
  jobId: string;
  cycleId: string;
  key: string;
  outcome: FindingOutcome["outcome"];
  issue: number | null;
  /** "skipped" = an exact-key match or the cap path pre-empted the scan. */
  nearMatch: "skipped" | NearMatchFetch;
}

function appendFilingLog(stateDir: string, entry: FilingLogEntry): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, FILING_LOG_FILE), `${JSON.stringify(entry)}\n`);
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

  const record = (
    outcome: FindingOutcome["outcome"],
    issue: number | undefined,
    nearMatch: FilingLogEntry["nearMatch"],
  ): FindingOutcome => {
    appendFilingLog(stateDir, {
      ts: new Date().toISOString(),
      jobId,
      cycleId,
      key: dedupKey,
      outcome,
      issue: issue ?? null,
      nearMatch,
    });
    return { outcome, issue };
  };

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
    return record("capped", counter.summaryIssue ?? undefined, "skipped");
  }

  // (a)(1)+(a)(3): dedup across open and recently-closed; a match is bumped.
  const match = findDedupMatch(gh, dedupKey, Date.now());
  // #635 fix: an exact-key miss still gets one more check — a severity-word
  // variant of a key already carried by an OPEN machine-filed issue. This is
  // what makes the fix mechanical rather than a convention the agent might
  // skip: `core-harvest-unimplemented-p0` bumps the issue already filed under
  // `p0-core-harvest-unimplemented` with no agent search step in between.
  const near: NearMatchResult | undefined = match ? undefined : findNearMatch(gh, dedupKey);
  const nearMatch: FilingLogEntry["nearMatch"] = near?.fetch ?? "skipped";
  const bumpTarget = match?.number ?? near?.issue;
  if (bumpTarget !== undefined) {
    const scratch = writeScratchBody(stateDir, body);
    run(gh, ["issue", "comment", String(bumpTarget), "--body-file", scratch]);
    counter.count += 1;
    saveCounter(stateDir, jobId, cycleId, counter);
    return record("bumped", bumpTarget, nearMatch);
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
  return record("created", parseIssueNumber(stdout), nearMatch);
}
