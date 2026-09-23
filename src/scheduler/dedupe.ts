// Backlog dedupe ceremony (#1135). The contract is the spec:
// docs/superpowers/specs/2026-09-22-backlog-dedupe-ceremony.md. Section names
// below ("Matching", "Idempotence", ...) are that spec's.
//
// Invariant: an open issue receives at most one proposal per (member,
// canonical) pairing, ever, and NOTHING is written to the tracker unless the
// operator has switched on the dedupePosting gate in gates.json (gates.ts).
// With the gate off (the default, and the state this ships in) a run makes
// read-only gh calls and writes one local report under
// $SCHEDULER_STATE_DIR/reports/, nothing else.
//
// Authority when the gate is on: add the `dedupe:candidate` label and post one
// cross-reference comment per proposed member, and keep one standing report
// issue updated in place. Never closes an issue, never edits a member's title
// or body, never dispatches.
//
// No cluster membership is stored anywhere. Clusters are re-derived from a
// fresh fetch every run (the deterministic pass calls no model), and "already
// proposed" is read back from the sm-dupe-cluster markers the proposal
// comments carry. The only persisted value is the high-water mark, which lives
// in the standing report.
//
// Issue titles and bodies are untrusted input (docs/wiki/security-baseline.md).
// Nothing posted here echoes free text from them: comments carry issue
// numbers and title segments, which are [a-z0-9]+ tokens by construction.
// The semantic pass's model output arrives as bare (member, target) number
// pairs and crosses the same validation as everything else before it can
// shape a proposal (clusterIssues).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILING_REPO, NEAR_MATCH_JACCARD, isNearDuplicate, keySegments, type GhRunner } from "./filing";
import { canPostDedupe, loadGates } from "./gates";

// --- Matching: title-side adapters over filing.ts's scoring ---------------

// Spec "Matching": pr/prs/issue/issues/gh/ghs, up to three separator
// characters from whitespace, `#`, `:` or `-`, then one to four digits. The
// entity word is folded to its singular before the anchor is built, so
// `PRs #107` and `PR #107` are one anchor. `(?!\d)` keeps a five-digit number
// from anchoring on its first four digits. A number in a list with no entity
// word of its own (`#108` in `PRs #107/#108`) is not an anchor. The spec
// records that as latent fragility, measured to split nothing.
const TITLE_ANCHOR_RE = /\b(pr|issue|gh)s?[\s#:-]{0,3}(\d{1,4})(?!\d)/gi;

/** The numbered entities a prose title names, as `pr83`, `issue867`, `gh40`. */
export function titleEntityAnchors(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(TITLE_ANCHOR_RE)) out.add(`${m[1]!.toLowerCase()}${m[2]}`);
  return out;
}

/**
 * Spec "Matching": disjointness, not equality. Blocks only when BOTH sets are
 * non-empty and share no anchor. Over prose an empty set usually means the
 * extraction missed, so it never blocks.
 */
export function titleAnchorsConflict(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) if (b.has(x)) return false;
  return true;
}

// The title-to-key adapter. Anchors are cut out first, the same way
// keySegments cuts ENTITY_ANCHOR_RE matches out of a minted key, so the anchor
// gate and the similarity score never read the same tokens. Every remaining
// run of non-alphanumerics becomes a DOUBLE hyphen: keySegments splits on it
// like any separator run, while filing.ts's ENTITY_ANCHOR_RE (at most one
// separator between entity word and digits) can never re-form a slug anchor
// across it. With a single hyphen, "PR (830)" would become the key `pr-830`,
// isNearDuplicate's equality gate would see {pr830}, and the title would be
// hard-blocked from every title that does not name PR 830.
function titleKey(title: string): string {
  return title.toLowerCase().replace(TITLE_ANCHOR_RE, " ").replace(/[^a-z0-9]+/g, "--");
}

/**
 * A title's meaning-bearing segments: keySegments (filing.ts, unchanged) run
 * over the adapted key, so severity words, staleness words and bare durations
 * drop exactly as they do from a minted key.
 */
export function titleToSegments(title: string): Set<string> {
  return keySegments(titleKey(title));
}

interface PreparedTitle {
  anchors: Set<string>;
  key: string;
}

const prepareTitle = (title: string): PreparedTitle => ({ anchors: titleEntityAnchors(title), key: titleKey(title) });

// The one composition of gate and score. isNearDuplicate supplies the scoring
// (NEAR_MATCH_JACCARD over keySegments). Its own anchor-equality gate passes
// trivially here, since titleKey never yields a slug anchor.
const preparedTitlesMatch = (a: PreparedTitle, b: PreparedTitle): boolean =>
  !titleAnchorsConflict(a.anchors, b.anchors) && isNearDuplicate(a.key, b.key);

/**
 * Do two issue titles describe the same finding? Pure, no I/O. This is the
 * ceremony's title-matching check, exported for the filer (#1133) to call at
 * mint time.
 */
export function isNearDuplicateTitle(a: string, b: string): boolean {
  return preparedTitlesMatch(prepareTitle(a), prepareTitle(b));
}

// Display only, for the evidence line a proposal cites. The match decision is
// isNearDuplicate's. This reports the shared segments and their overlap so a
// reader can check the claim without re-deriving it.
function overlapEvidence(a: string, b: string): { shared: string[]; score: number } {
  const sa = titleToSegments(a);
  const sb = titleToSegments(b);
  const shared = [...sa].filter((x) => sb.has(x)).sort();
  const union = sa.size + sb.size - shared.length;
  return { shared, score: union > 0 ? shared.length / union : 0 };
}

// --- Canonical selection ----------------------------------------------------

export interface DedupeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

// Spec "Matching", canonical selection: a member that names a cause (cites a
// file or a function, or says "because"/"root cause") beats one that only
// reports a count of failures.
const CAUSE_RE = /\bbecause\b|\broot cause\b|\b[\w-]+\.(?:ts|tsx|js|mjs|md|json|ya?ml|sh|py)\b|\b[A-Za-z_]\w*\(\)/i;

export function namesCause(issue: Pick<DedupeIssue, "title" | "body">): boolean {
  return CAUSE_RE.test(`${issue.title}\n${issue.body}`);
}

// `#123` references, not `&#123;` entities or `abc#12` fragments.
const ISSUE_REF_RE = /(?<![\w&])#(\d{1,5})(?!\d)/g;

/**
 * How many OTHER open issues reference each issue number. A `PR #107` is a
 * pull request in the code repo, not tracker issue 107, so PR-anchored
 * numbers are blanked before counting.
 */
export function crossRefCounts(issues: readonly DedupeIssue[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const issue of issues) {
    const seen = new Set<number>();
    const text = `${issue.title}\n${issue.body}`.replace(TITLE_ANCHOR_RE, (m, word: string) => (word.toLowerCase() === "pr" ? " " : m));
    for (const m of text.matchAll(ISSUE_REF_RE)) {
      const n = Number(m[1]);
      if (n !== issue.number) seen.add(n);
    }
    for (const n of seen) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}

/** Cause over symptom, then most cross-references, then lowest number. */
export function chooseCanonical(members: readonly DedupeIssue[], xrefs: ReadonlyMap<number, number>): number {
  const ranked = [...members].sort(
    (a, b) =>
      Number(namesCause(b)) - Number(namesCause(a)) ||
      (xrefs.get(b.number) ?? 0) - (xrefs.get(a.number) ?? 0) ||
      a.number - b.number,
  );
  return ranked[0]!.number;
}

// --- Clustering -------------------------------------------------------------

export type Tier = "high" | "medium";
export type LinkKind = "title" | "semantic";

/** One (member, target) pairing proposed by the semantic pass: numbers only. */
export interface SemanticPair {
  member: number;
  target: number;
}

export interface ClusterMember {
  number: number;
  /** high: every link on the path to the canonical is a title match. medium: at least one is semantic. */
  tier: Tier;
  /** The issue this member was linked through (the canonical itself, or a fellow member). */
  via: number;
  kind: LinkKind;
  /** Title segments shared with `via` (title links only). */
  shared: string[];
  /** Segment overlap with `via` (title links only), display evidence. */
  score: number | null;
  /** Entity anchors both titles name. */
  anchors: string[];
}

export interface DedupeCluster {
  canonical: number;
  /** Non-canonical members, ascending. */
  members: ClusterMember[];
}

export interface ClusterResult {
  clusters: DedupeCluster[];
  /** Issues the deterministic pass left as singletons: the semantic pass's input. */
  unresolved: number[];
  semanticAccepted: number;
  semanticRejected: Array<SemanticPair & { reason: string }>;
}

/** Ceiling on model-proposed pairs a run will consider. */
export const MAX_SEMANTIC_PAIRS = 60;

/**
 * Re-derives every cluster from scratch (spec "Idempotence": nothing is
 * stored). Pass two links titles pairwise. Pass three applies the semantic
 * pairs, restricted to issues pass two left unresolved.
 *
 * Linkage is single-link with a cluster-level anchor guard. Plain union-find
 * would chain `PR #83 ...` to `PR #107 ...` through an anchorless title that
 * matches both, the exact merge the anchor gate exists to prevent, so a union
 * is refused when the two clusters' combined anchor sets conflict.
 */
export function clusterIssues(issues: readonly DedupeIssue[], semanticPairs: readonly SemanticPair[] = []): ClusterResult {
  const sorted = [...issues].sort((a, b) => a.number - b.number);
  const indexOf = new Map(sorted.map((issue, i) => [issue.number, i]));
  const prepared = sorted.map((issue) => prepareTitle(issue.title));
  const parent = sorted.map((_, i) => i);
  const clusterAnchors = new Map<number, Set<string>>(prepared.map((p, i) => [i, new Set(p.anchors)]));
  const edges: Array<{ a: number; b: number; kind: LinkKind }> = [];

  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    return r;
  };
  const union = (a: number, b: number, kind: LinkKind): "joined" | "same" | "conflict" => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return "same";
    const aa = clusterAnchors.get(ra)!;
    const ab = clusterAnchors.get(rb)!;
    if (titleAnchorsConflict(aa, ab)) return "conflict";
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
    parent[drop] = keep;
    clusterAnchors.set(keep, new Set([...aa, ...ab]));
    clusterAnchors.delete(drop);
    edges.push({ a, b, kind });
    return "joined";
  };

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (preparedTitlesMatch(prepared[i]!, prepared[j]!)) union(i, j, "title");
    }
  }

  const sizeOf = new Map<number, number>();
  for (let i = 0; i < sorted.length; i++) sizeOf.set(find(i), (sizeOf.get(find(i)) ?? 0) + 1);
  const unresolved = sorted.filter((_, i) => sizeOf.get(find(i)) === 1).map((issue) => issue.number);
  const unresolvedSet = new Set(unresolved);

  let semanticAccepted = 0;
  const semanticRejected: ClusterResult["semanticRejected"] = [];
  semanticPairs.forEach((pair, k) => {
    const reject = (reason: string) => semanticRejected.push({ ...pair, reason });
    if (k >= MAX_SEMANTIC_PAIRS) return reject(`over the ${MAX_SEMANTIC_PAIRS}-pair cap`);
    const mi = indexOf.get(pair.member);
    const ti = indexOf.get(pair.target);
    if (mi === undefined || ti === undefined) return reject("not an open issue in this run's fetch");
    if (mi === ti) return reject("member and target are the same issue");
    if (!unresolvedSet.has(pair.member)) return reject("member was not left unresolved by the deterministic pass");
    if (titleAnchorsConflict(prepared[mi]!.anchors, prepared[ti]!.anchors)) return reject("the two titles name different entities");
    const outcome = union(mi, ti, "semantic");
    if (outcome === "conflict") return reject("the clusters name different entities");
    if (outcome === "same") return reject("already in the same cluster");
    semanticAccepted++;
  });

  const groups = new Map<number, number[]>();
  for (let i = 0; i < sorted.length; i++) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  const adjacency = new Map<number, Array<{ to: number; kind: LinkKind }>>();
  for (const e of edges) {
    adjacency.set(e.a, [...(adjacency.get(e.a) ?? []), { to: e.b, kind: e.kind }]);
    adjacency.set(e.b, [...(adjacency.get(e.b) ?? []), { to: e.a, kind: e.kind }]);
  }
  const xrefs = crossRefCounts(sorted);

  const clusters: DedupeCluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const canonical = chooseCanonical(
      idxs.map((i) => sorted[i]!),
      xrefs,
    );
    // Root the cluster's link tree at the canonical: each member's evidence is
    // the link to its parent, so the cited chain always leads to the canonical.
    const start = indexOf.get(canonical)!;
    const tierOf = new Map<number, Tier>([[start, "high"]]);
    const members: ClusterMember[] = [];
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const { to, kind } of adjacency.get(cur) ?? []) {
        if (tierOf.has(to)) continue;
        const tier: Tier = kind === "semantic" || tierOf.get(cur) === "medium" ? "medium" : "high";
        tierOf.set(to, tier);
        queue.push(to);
        const self = sorted[to]!;
        const via = sorted[cur]!;
        const ev = kind === "title" ? overlapEvidence(self.title, via.title) : null;
        members.push({
          number: self.number,
          tier,
          via: via.number,
          kind,
          shared: ev?.shared ?? [],
          score: ev?.score ?? null,
          anchors: [...prepared[to]!.anchors].filter((x) => prepared[cur]!.anchors.has(x)).sort(),
        });
      }
    }
    members.sort((a, b) => a.number - b.number);
    clusters.push({ canonical, members });
  }
  // Largest first (spec "Cadence and cost": the budget goes where it reduces
  // report noise most), ties on the lower canonical number.
  clusters.sort((a, b) => b.members.length - a.members.length || a.canonical - b.canonical);
  return { clusters, unresolved, semanticAccepted, semanticRejected };
}

// --- Idempotence: markers ---------------------------------------------------

export const CANDIDATE_LABEL = "dedupe:candidate";
export const CONFIRMED_LABEL = "dedupe:confirmed";

const CLUSTER_MARKER_RE = /<!--\s*sm-dupe-cluster:(\d+)\s*-->/;
const TIER_MARKER_RE = /<!--\s*sm-dupe-tier:(high|medium)\s*-->/;
const REPORT_MARKER = "<!-- sm-dedupe-report -->";
const HWM_RE = /<!--\s*sm-dedupe-hwm:(\d+)\s*-->/;
const FINGERPRINT_RE = /<!--\s*sm-dedupe-clusters:([0-9a-f]+)\s*-->/;

export interface ProposalMarker {
  canonical: number;
  tier: Tier | null;
}

/** The proposal markers in a member's comments, oldest first. */
export function readProposalMarkers(commentBodies: readonly string[]): ProposalMarker[] {
  const out: ProposalMarker[] = [];
  for (const body of commentBodies) {
    const m = body.match(CLUSTER_MARKER_RE);
    if (!m) continue;
    const tier = body.match(TIER_MARKER_RE)?.[1] as Tier | undefined;
    out.push({ canonical: Number(m[1]), tier: tier ?? null });
  }
  return out;
}

export type SkipReason = "already-proposed" | "canonical-closed";

/**
 * Spec "Idempotence". A marker naming this canonical means the pairing was
 * proposed before, so nothing is posted, however long ago and whatever a
 * person did with the label since. A newest marker naming a canonical that is
 * no longer open is the closed-canonical carve-out: the old marker already
 * reads "resolved via #N", so no repost. Anything else (no marker, or a
 * newest marker naming a different OPEN canonical) is a new pairing.
 */
export function proposalSkip(
  markers: readonly ProposalMarker[],
  canonical: number,
  openNumbers: ReadonlySet<number>,
): SkipReason | null {
  if (markers.some((m) => m.canonical === canonical)) return "already-proposed";
  const newest = markers.at(-1);
  if (newest && !openNumbers.has(newest.canonical)) return "canonical-closed";
  return null;
}

export interface ProposalCandidate {
  member: number;
  canonical: number;
  clusterSize: number;
  evidence: ClusterMember;
}

/** Every pairing not yet proposed, in budget order: largest cluster first, members ascending. */
export function planProposals(
  clusters: readonly DedupeCluster[],
  markersByIssue: ReadonlyMap<number, readonly ProposalMarker[]>,
  openNumbers: ReadonlySet<number>,
): ProposalCandidate[] {
  const queue: ProposalCandidate[] = [];
  for (const c of clusters) {
    for (const m of c.members) {
      if (proposalSkip(markersByIssue.get(m.number) ?? [], c.canonical, openNumbers) !== null) continue;
      queue.push({ member: m.number, canonical: c.canonical, clusterSize: c.members.length + 1, evidence: m });
    }
  }
  return queue;
}

/** Spec "Cadence and cost": new labels or comments posted per run. */
export const PROPOSALS_PER_RUN = 20;

// --- Precision ledger -------------------------------------------------------

export interface LedgerCounts {
  truePositive: number;
  falsePositive: number;
  unreviewed: number;
}

export type Adjudication = "true-positive" | "false-positive" | "unreviewed";

/**
 * Spec "Setting and measuring a precision target", on the two label events
 * only (the spec's comment-agreement path is free text, and a mechanical
 * ledger cannot classify it). `dedupe:confirmed` records agreement. A marker
 * with neither label means a person stripped `dedupe:candidate`: one false
 * positive. A proposal nobody touched still carries `dedupe:candidate` and
 * counts as unreviewed, never as correct.
 */
export function adjudicate(labels: readonly string[]): Adjudication {
  if (labels.includes(CONFIRMED_LABEL)) return "true-positive";
  if (labels.includes(CANDIDATE_LABEL)) return "unreviewed";
  return "false-positive";
}

/** "0.93 (14/15 reviewed)", or "no reviewed proposals yet" on a zero denominator. */
export function formatPrecision(c: LedgerCounts): string {
  const reviewed = c.truePositive + c.falsePositive;
  if (reviewed === 0) return "no reviewed proposals yet";
  return `${(c.truePositive / reviewed).toFixed(2)} (${c.truePositive}/${reviewed} reviewed)`;
}

// --- Cadence: the semantic-pass delta gate ------------------------------------

/** Spec "Cadence and cost": fewer new issues than this since the high-water mark skips the semantic pass. */
export const SEMANTIC_NEW_ISSUE_THRESHOLD = 10;

export interface SemanticGate {
  due: boolean;
  newIssues: number | null;
  reason: string;
}

export function semanticGate(prevHwm: number | null, openNumbers: readonly number[]): SemanticGate {
  if (prevHwm === null) return { due: true, newIssues: null, reason: "no high-water mark yet (first run)" };
  const newIssues = openNumbers.filter((n) => n > prevHwm).length;
  return newIssues >= SEMANTIC_NEW_ISSUE_THRESHOLD
    ? { due: true, newIssues, reason: `${newIssues} issues opened since #${prevHwm}` }
    : { due: false, newIssues, reason: `only ${newIssues} issues opened since #${prevHwm} (threshold ${SEMANTIC_NEW_ISSUE_THRESHOLD})` };
}

// --- Tracker I/O --------------------------------------------------------------

// Every gh call carries --repo FILING_REPO (the issues SSOT, filing.ts) from
// this ONE wrapper, for the same reason filing.ts pins it in its own run():
// a call site that forgets --repo resolves against the checkout's remote,
// which is the public code repo. The error names the verb, never gh's stdout.
function gh(runner: GhRunner, args: string[]): string {
  const { stdout, exitCode } = runner([...args, "--repo", FILING_REPO]);
  if (exitCode !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed (exit ${exitCode})`);
  return stdout;
}

/** A fetch that fills its limit may have been cut short; the run says so rather than reading a partial backlog as whole. */
export const OPEN_FETCH_LIMIT = 2000;
export const MARKER_SCAN_LIMIT = 1000;

interface OpenFetch {
  issues: DedupeIssue[];
  truncated: boolean;
  /** Rows gh returned that did not have the expected shape. */
  malformed: number;
}

const labelNames = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.flatMap((l) => (typeof l === "object" && l !== null && typeof (l as { name?: unknown }).name === "string" ? [(l as { name: string }).name] : []))
    : [];

function fetchOpenIssues(runner: GhRunner): OpenFetch {
  const stdout = gh(runner, ["issue", "list", "--state", "open", "--limit", String(OPEN_FETCH_LIMIT), "--json", "number,title,body,labels"]);
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error("gh issue list returned a non-array payload");
  const issues: DedupeIssue[] = [];
  let malformed = 0;
  for (const row of rows as Array<Record<string, unknown>>) {
    if (typeof row?.number !== "number" || !Number.isInteger(row.number) || typeof row.title !== "string") {
      malformed++;
      continue;
    }
    issues.push({ number: row.number, title: row.title, body: typeof row.body === "string" ? row.body : "", labels: labelNames(row.labels) });
  }
  return { issues, truncated: rows.length >= OPEN_FETCH_LIMIT, malformed };
}

interface MarkedIssue {
  number: number;
  open: boolean;
  labels: string[];
  markers: ProposalMarker[];
}

type MarkerScanStatus = "ok" | "truncated" | "unreadable";

// Advisory: which issues, open or closed, already carry a proposal marker.
// Feeds planning and the ledger. It is NOT what idempotence rests on: the
// authoritative per-member read right before a post is (readMemberMarkers).
// A search miss therefore costs one extra read, never a duplicate post.
function scanMarkers(runner: GhRunner): { status: MarkerScanStatus; issues: MarkedIssue[] } {
  let rows: unknown;
  try {
    rows = JSON.parse(
      gh(runner, [
        "issue",
        "list",
        "--state",
        "all",
        "--search",
        '"sm-dupe-cluster" in:comments',
        "--limit",
        String(MARKER_SCAN_LIMIT),
        "--json",
        "number,state,labels,comments",
      ]),
    );
  } catch {
    return { status: "unreadable", issues: [] };
  }
  if (!Array.isArray(rows)) return { status: "unreadable", issues: [] };
  const issues: MarkedIssue[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (typeof row?.number !== "number") continue;
    const bodies = Array.isArray(row.comments)
      ? (row.comments as Array<{ body?: unknown }>).flatMap((c) => (typeof c?.body === "string" ? [c.body] : []))
      : [];
    const markers = readProposalMarkers(bodies);
    if (markers.length === 0) continue; // search relevance is fuzzy: keep only verified markers
    issues.push({ number: row.number, open: String(row.state).toUpperCase() === "OPEN", labels: labelNames(row.labels), markers });
  }
  return { status: rows.length >= MARKER_SCAN_LIMIT ? "truncated" : "ok", issues };
}

// Authoritative: gh issue view pages through every comment, unlike the list
// payload's first-100 window.
function readMemberMarkers(runner: GhRunner, member: number): ProposalMarker[] {
  const parsed = JSON.parse(gh(runner, ["issue", "view", String(member), "--json", "comments"])) as { comments?: unknown };
  const bodies = Array.isArray(parsed.comments)
    ? (parsed.comments as Array<{ body?: unknown }>).flatMap((c) => (typeof c?.body === "string" ? [c.body] : []))
    : [];
  return readProposalMarkers(bodies);
}

function missingLabels(runner: GhRunner): string[] {
  const rows = JSON.parse(gh(runner, ["label", "list", "--limit", "500", "--json", "name"])) as unknown;
  const have = new Set(labelNames(rows));
  return [CANDIDATE_LABEL, CONFIRMED_LABEL].filter((l) => !have.has(l));
}

function writeScratch(stateDir: string, text: string): string {
  mkdirSync(stateDir, { recursive: true });
  const p = join(stateDir, "dedupe-compose.tmp.md");
  writeFileSync(p, text);
  return p;
}

// --- Rendering ------------------------------------------------------------------

export const REPORT_TITLE = "Backlog dedupe: standing report";
export const LOCAL_REPORT_FILE = "backlog-dedupe.md";

function evidenceLine(p: ProposalCandidate): string {
  const e = p.evidence;
  const through = e.via === p.canonical ? "" : `, and #${e.via} is in #${p.canonical}'s cluster`;
  const anchors = e.anchors.length > 0 ? ` Both name ${e.anchors.join(", ")}.` : "";
  if (e.kind === "semantic") {
    return `the weekly semantic pass judged this issue to describe the same condition as #${e.via}${through}. No title overlap backs the pairing, so it is proposed at medium confidence.${anchors}`;
  }
  const score = (e.score ?? 0).toFixed(2);
  const tierNote = e.tier === "medium" ? " The chain to the canonical includes a semantic link, so it is proposed at medium confidence." : "";
  return `this title and #${e.via}'s share the words ${e.shared.join(", ")} (overlap ${score}, match floor ${NEAR_MATCH_JACCARD})${through}.${anchors}${tierNote}`;
}

export function renderProposalComment(p: ProposalCandidate): string {
  return [
    `Possible duplicate of #${p.canonical}, proposed by the weekly backlog dedupe ceremony. It never closes or edits issues. A person decides.`,
    "",
    `Evidence: ${evidenceLine(p)}`,
    "",
    `To agree, apply \`${CONFIRMED_LABEL}\`. To disagree, remove \`${CANDIDATE_LABEL}\`. Either one is recorded in the precision ledger on the standing report.`,
    "",
    `<!-- sm-dupe-cluster:${p.canonical} -->`,
    `<!-- sm-dupe-tier:${p.evidence.tier} -->`,
  ].join("\n");
}

type MemberState = "proposed" | "kept" | "pending";

function renderClusterTable(clusters: readonly DedupeCluster[], stateOf: (member: number, canonical: number) => MemberState): string {
  if (clusters.length === 0) return "No clusters this run.";
  const rows = clusters.map((c) => {
    const tier: Tier = c.members.some((m) => m.tier === "medium") ? "medium" : "high";
    const proposed = c.members.filter((m) => stateOf(m.number, c.canonical) !== "pending").map((m) => `#${m.number}`);
    const pending = c.members.filter((m) => stateOf(m.number, c.canonical) === "pending").map((m) => `#${m.number}`);
    return `| #${c.canonical} | ${c.members.length + 1} | ${tier} | ${proposed.join(" ") || "none"} | ${pending.join(" ") || "none"} |`;
  });
  return ["| Canonical | Size | Confidence | Proposed | Pending |", "|---|---|---|---|---|", ...rows].join("\n");
}

const fingerprintOf = (table: string): string => createHash("sha256").update(table).digest("hex").slice(0, 16);

const readHwm = (body: string | null): number | null => {
  const m = body?.match(HWM_RE);
  return m ? Number(m[1]) : null;
};
const readFingerprint = (body: string | null): string | null => body?.match(FINGERPRINT_RE)?.[1] ?? null;

// --- The run ------------------------------------------------------------------

export type DedupeMode = "dry-run" | "live";

/** The operator's switch. gates.json dedupePosting defaults OFF; nothing else can turn posting on. */
export function resolveDedupeMode(stateDir: string): DedupeMode {
  return canPostDedupe(loadGates(stateDir)) ? "live" : "dry-run";
}

const localReportPath = (stateDir: string) => join(stateDir, "reports", LOCAL_REPORT_FILE);

function readLocalReport(stateDir: string): string | null {
  try {
    return readFileSync(localReportPath(stateDir), "utf8");
  } catch {
    return null;
  }
}

interface Snapshot {
  mode: DedupeMode;
  fetch: OpenFetch;
  /** The open backlog minus the standing report issue itself. */
  backlog: DedupeIssue[];
  openNumbers: Set<number>;
  maxOpen: number;
  reportIssue: DedupeIssue | null;
  /** The body the previous run left: the tracker report when live, the local report otherwise. */
  previousReport: string | null;
}

// Report identity needs BOTH conditions, not a bare marker substring: the
// title exactly matches REPORT_TITLE (the only string the ceremony itself
// ever passes to `gh issue create --title`) AND the body STARTS WITH the
// marker (the ceremony writes it as line one — see reportBody below). A
// substring-only match adopts any issue that merely quotes the marker as
// evidence (filers routinely quote source lines), losing that issue's body on
// the next live run and never letting it be flagged as a duplicate again.
const isReportIssue = (i: DedupeIssue): boolean => i.title === REPORT_TITLE && i.body.startsWith(REPORT_MARKER);

function snapshot(runner: GhRunner, stateDir: string): Snapshot {
  const mode = resolveDedupeMode(stateDir);
  const fetch = fetchOpenIssues(runner);
  const reportIssue = fetch.issues.filter(isReportIssue).sort((a, b) => a.number - b.number)[0] ?? null;
  const backlog = fetch.issues.filter((i) => !isReportIssue(i));
  const openNumbers = new Set(fetch.issues.map((i) => i.number));
  // Over the backlog, like the delta gate's count: the report issue is not
  // backlog, and counting it there would read it as a new issue.
  const maxOpen = backlog.reduce((m, i) => Math.max(m, i.number), 0);
  const previousReport = mode === "live" ? (reportIssue?.body ?? null) : readLocalReport(stateDir);
  return { mode, fetch, backlog, openNumbers, maxOpen, reportIssue, previousReport };
}

export interface CandidatesOutput {
  mode: DedupeMode;
  semantic: SemanticGate;
  /** Present only when the semantic pass is due. Titles and excerpts are untrusted data. */
  unresolved: Array<{ number: number; title: string; excerpt: string }>;
  clusters: Array<{ canonical: number; size: number; title: string }>;
}

export const EXCERPT_CHARS = 400;

// One line of plain text: control characters and whitespace runs become a
// single space, so JSON escaping can at most double a character (a quote or
// a backslash) and a printed candidate line stays bounded.
const oneLine = (s: string): string => s.replace(/[\p{Cc}\s]+/gu, " ").trim();

const excerptOf = (body: string): string => oneLine(body.replace(/<!--[\s\S]*?-->/g, " ")).slice(0, EXCERPT_CHARS);

/** The semantic pass's input: read-only in every mode. */
export function dedupeCandidates(runner: GhRunner, opts: { stateDir: string }): CandidatesOutput {
  const snap = snapshot(runner, opts.stateDir);
  const semantic = semanticGate(
    readHwm(snap.previousReport),
    snap.backlog.map((i) => i.number),
  );
  if (!semantic.due) return { mode: snap.mode, semantic, unresolved: [], clusters: [] };
  const byNumber = new Map(snap.backlog.map((i) => [i.number, i]));
  const result = clusterIssues(snap.backlog);
  return {
    mode: snap.mode,
    semantic,
    unresolved: result.unresolved.map((n) => {
      const issue = byNumber.get(n)!;
      return { number: n, title: issue.title, excerpt: excerptOf(issue.body) };
    }),
    clusters: result.clusters.map((c) => ({ canonical: c.canonical, size: c.members.length + 1, title: byNumber.get(c.canonical)!.title })),
  };
}

/** Ceiling on one printed line, well under the 2000-character line cut of the Read tool. */
export const CANDIDATE_LINE_MAX = 1500;

/**
 * The candidates output as JSON Lines: a header, then one line per cluster
 * canonical, then one per unresolved issue. On the live backlog this runs to
 * a few hundred KB, which a headless agent's Bash tool saves to a file rather
 * than showing inline. One small object per line keeps that file readable with
 * the Read tool, which cuts any line past 2000 characters. A single JSON
 * document would be one line and arrive cut.
 */
export function formatCandidates(out: CandidatesOutput): string[] {
  const cap = (s: string, n: number) => {
    const t = oneLine(s);
    return t.length > n ? `${t.slice(0, n)}...` : t;
  };
  return [
    JSON.stringify({ mode: out.mode, semantic: out.semantic, clusters: out.clusters.length, unresolved: out.unresolved.length }),
    ...out.clusters.map((c) => JSON.stringify({ cluster: c.canonical, size: c.size, title: cap(c.title, 200) })),
    ...out.unresolved.map((u) => JSON.stringify({ issue: u.number, title: cap(u.title, 200), excerpt: u.excerpt })),
  ];
}

export interface DedupeRunResult {
  mode: DedupeMode;
  openIssues: number;
  fetch: "complete" | "truncated";
  malformedRows: number;
  markerScan: MarkerScanStatus;
  clusters: number;
  clusteredMembers: number;
  /** Posted when live; would have been posted when dry-run. */
  proposals: Array<{ member: number; canonical: number; tier: Tier }>;
  skipped: Array<{ member: number; canonical: number; reason: SkipReason }>;
  deferred: number;
  report: { action: "created" | "updated" | "unchanged"; issue: number | null };
  semantic: { accepted: number; rejected: Array<SemanticPair & { reason: string }> };
  missingLabels: string[];
  localReport: string;
}

export class DedupeSetupError extends Error {}

/**
 * One ceremony run. Reads are identical in both modes, so a dry run shows
 * exactly what a live run would do. Every tracker write sits behind
 * `mode === "live"`, and the mode comes only from gates.json.
 */
export function runDedupe(
  runner: GhRunner,
  opts: { stateDir: string; now: number; semanticPairs?: readonly SemanticPair[] },
): DedupeRunResult {
  const snap = snapshot(runner, opts.stateDir);
  const { mode } = snap;
  const labelsMissing = missingLabels(runner);
  // An unknown label 422s `gh issue edit` mid-run and turns the ceremony
  // silent (the lesson filing.ts records for its own default label). Fail
  // before the first write instead, naming what the operator must create.
  if (mode === "live" && labelsMissing.length > 0) {
    throw new DedupeSetupError(`posting is on but the tracker lacks label(s): ${labelsMissing.join(", ")}`);
  }

  const scan = scanMarkers(runner);
  const markersByIssue = new Map(scan.issues.map((i) => [i.number, i.markers]));
  const result = clusterIssues(snap.backlog, opts.semanticPairs ?? []);
  const queue = planProposals(result.clusters, markersByIssue, snap.openNumbers);

  const proposals: DedupeRunResult["proposals"] = [];
  const skipped: DedupeRunResult["skipped"] = [];
  let deferred = 0;
  for (const p of queue) {
    if (proposals.length >= PROPOSALS_PER_RUN) {
      deferred++;
      continue;
    }
    // Spec "Idempotence": read the member's comments before posting anything.
    const fresh = readMemberMarkers(runner, p.member);
    markersByIssue.set(p.member, fresh);
    const skip = proposalSkip(fresh, p.canonical, snap.openNumbers);
    if (skip !== null) {
      skipped.push({ member: p.member, canonical: p.canonical, reason: skip });
      continue;
    }
    if (mode === "live") {
      // Label first: a comment that lands without its label would read as a
      // stripped label, a recorded false positive nobody made. A label that
      // lands without its comment is simply re-proposed next run.
      gh(runner, ["issue", "edit", String(p.member), "--add-label", CANDIDATE_LABEL]);
      gh(runner, ["issue", "comment", String(p.member), "--body-file", writeScratch(opts.stateDir, renderProposalComment(p))]);
      markersByIssue.set(p.member, [...fresh, { canonical: p.canonical, tier: p.evidence.tier }]);
    }
    proposals.push({ member: p.member, canonical: p.canonical, tier: p.evidence.tier });
  }

  // Member state for the report, read from markers as they stand after this
  // run's posts. A dry run posted nothing, so its would-be proposals stay pending.
  const stateOf = (member: number, canonical: number): MemberState => {
    const skip = proposalSkip(markersByIssue.get(member) ?? [], canonical, snap.openNumbers);
    return skip === "already-proposed" ? "proposed" : skip === "canonical-closed" ? "kept" : "pending";
  };
  const table = renderClusterTable(result.clusters, stateOf);
  const fingerprint = fingerprintOf(table);
  // Spec "Idempotence": the report is rewritten only when the cluster set
  // changed, and the high-water mark advances only with a rewrite.
  const changed = readFingerprint(snap.previousReport) !== fingerprint || (mode === "live" && snap.reportIssue === null);
  const hwm = changed ? snap.maxOpen : (readHwm(snap.previousReport) ?? snap.maxOpen);

  // Ledger: every issue carrying a tiered proposal marker, open or closed.
  // Open issues read their labels from this run's fetch. This run's live posts
  // join as unreviewed.
  const ledger: Record<Tier, LedgerCounts> = {
    high: { truePositive: 0, falsePositive: 0, unreviewed: 0 },
    medium: { truePositive: 0, falsePositive: 0, unreviewed: 0 },
  };
  const openLabels = new Map(snap.fetch.issues.map((i) => [i.number, i.labels]));
  const counted = new Set<number>();
  const tally = (tier: Tier | null, labels: readonly string[]) => {
    if (tier === null) return;
    const verdict = adjudicate(labels);
    const bucket = ledger[tier];
    if (verdict === "true-positive") bucket.truePositive++;
    else if (verdict === "false-positive") bucket.falsePositive++;
    else bucket.unreviewed++;
  };
  for (const issue of scan.issues) {
    counted.add(issue.number);
    const newestTiered = [...issue.markers].reverse().find((m) => m.tier !== null);
    tally(newestTiered?.tier ?? null, issue.open ? (openLabels.get(issue.number) ?? issue.labels) : issue.labels);
  }
  if (mode === "live") for (const p of proposals) if (!counted.has(p.member)) tally(p.tier, [CANDIDATE_LABEL]);

  const clusteredMembers = result.clusters.reduce((n, c) => n + c.members.length, 0);
  const flaggedClusters = result.clusters.filter((c) => c.members.some((m) => stateOf(m.number, c.canonical) !== "pending"));
  const flagged = flaggedClusters.reduce((n, c) => n + c.members.filter((m) => stateOf(m.number, c.canonical) !== "pending").length, 0);
  const openCount = snap.backlog.length; // the report issue is not backlog
  const scanNote = scan.status === "ok" ? "complete" : scan.status === "truncated" ? `TRUNCATED at ${MARKER_SCAN_LIMIT}` : "UNREADABLE, ledger incomplete";
  const reportBody = [
    REPORT_MARKER,
    `# ${REPORT_TITLE}`,
    "",
    `${flagged} of ${openCount} open issues are flagged as duplicates of ${flaggedClusters.length} canonicals, leaving ${openCount - flagged} distinct open issues. ${clusteredMembers - flagged} more clustered members await a proposal.`,
    "",
    `Precision, high confidence: ${formatPrecision(ledger.high)}. ${ledger.high.unreviewed} unreviewed.`,
    `Precision, medium confidence: ${formatPrecision(ledger.medium)}. ${ledger.medium.unreviewed} unreviewed.`,
    "",
    `To adjudicate a proposal, apply \`${CONFIRMED_LABEL}\` to agree or remove \`${CANDIDATE_LABEL}\` to disagree. Only those two label events count. An untouched proposal is unreviewed, never correct.`,
    "",
    `## Clusters (${result.clusters.length}, largest first)`,
    "",
    table,
    "",
    `Fetch: ${openCount} open issues${snap.fetch.truncated ? ` (TRUNCATED at ${OPEN_FETCH_LIMIT})` : ""}. Marker scan: ${scanNote}. This ceremony proposes only. It never closes, edits or dispatches.`,
    "",
    `<!-- sm-dedupe-hwm:${hwm} -->`,
    `<!-- sm-dedupe-clusters:${fingerprint} -->`,
  ].join("\n");

  let action: DedupeRunResult["report"]["action"] = "unchanged";
  let reportNumber = snap.reportIssue?.number ?? null;
  if (changed) {
    action = snap.reportIssue === null ? "created" : "updated";
    if (mode === "live") {
      const file = writeScratch(opts.stateDir, reportBody);
      if (snap.reportIssue === null) {
        const out = gh(runner, ["issue", "create", "--title", REPORT_TITLE, "--body-file", file]);
        const m = out.trim().match(/\/issues\/(\d+)$/);
        reportNumber = m ? Number(m[1]) : null;
      } else {
        gh(runner, ["issue", "edit", String(snap.reportIssue.number), "--body-file", file]);
      }
    }
  }

  const byNumber = new Map(snap.backlog.map((i) => [i.number, i]));
  const titleOf = (n: number) => byNumber.get(n)?.title ?? "(not open)";
  const verb = mode === "live" ? "Posted" : "Would post";
  const local = [
    `# Backlog dedupe run ${new Date(opts.now).toISOString()}`,
    "",
    mode === "live"
      ? "Mode: LIVE. The dedupePosting gate in gates.json is on."
      : "Mode: dry run. The dedupePosting gate in gates.json is off, so nothing was written to the tracker. Everything below is what a live run would have done.",
    `Labels the live mode needs: ${labelsMissing.length === 0 ? "present" : `MISSING ${labelsMissing.join(", ")}`}.`,
    `Standing report: ${mode === "live" ? action : `would be ${action}`}${reportNumber !== null ? ` (#${reportNumber})` : ""}.`,
    "",
    `## ${verb} (${proposals.length} of a ${PROPOSALS_PER_RUN}-per-run budget)`,
    "",
    ...(proposals.length === 0 ? ["None."] : proposals.map((p) => `- #${p.member} (${titleOf(p.member)}) as a duplicate of #${p.canonical} (${titleOf(p.canonical)}), ${p.tier} confidence`)),
    "",
    `Skipped at the pre-post read: ${skipped.length === 0 ? "none" : skipped.map((s) => `#${s.member} (${s.reason})`).join(", ")}. Deferred to later runs by the budget: ${deferred}.`,
    `Semantic pass: ${result.semanticAccepted} pair(s) accepted, ${result.semanticRejected.length} rejected${result.semanticRejected.length > 0 ? `: ${result.semanticRejected.map((r) => `#${r.member}->#${r.target} (${r.reason})`).join(", ")}` : ""}.`,
    "",
    "## Standing report body",
    "",
    reportBody,
    "",
  ].join("\n");
  mkdirSync(join(opts.stateDir, "reports"), { recursive: true });
  writeFileSync(localReportPath(opts.stateDir), local);

  return {
    mode,
    openIssues: openCount,
    fetch: snap.fetch.truncated ? "truncated" : "complete",
    malformedRows: snap.fetch.malformed,
    markerScan: scan.status,
    clusters: result.clusters.length,
    clusteredMembers,
    proposals,
    skipped,
    deferred,
    report: { action, issue: reportNumber },
    semantic: { accepted: result.semanticAccepted, rejected: result.semanticRejected },
    missingLabels: labelsMissing,
    localReport: localReportPath(opts.stateDir),
  };
}
