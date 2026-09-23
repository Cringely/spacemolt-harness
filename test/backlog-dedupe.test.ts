// #1135: the weekly backlog dedupe ceremony, built to
// docs/superpowers/specs/2026-09-22-backlog-dedupe-ceremony.md. Offline: a
// fake in-memory tracker behind the GhRunner seam, temp state dirs, no live gh.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSemanticPairs } from "../scripts/backlog-dedupe";
import {
  CANDIDATE_LABEL,
  CANDIDATE_LINE_MAX,
  CONFIRMED_LABEL,
  DedupeSetupError,
  LOCAL_REPORT_FILE,
  PROPOSALS_PER_RUN,
  adjudicate,
  chooseCanonical,
  clusterIssues,
  crossRefCounts,
  dedupeCandidates,
  formatCandidates,
  formatPrecision,
  isNearDuplicateTitle,
  proposalSkip,
  runDedupe,
  semanticGate,
  titleAnchorsConflict,
  titleEntityAnchors,
  titleToSegments,
  type DedupeIssue,
} from "../src/scheduler/dedupe";
import { FILING_REPO, type GhRunner } from "../src/scheduler/filing";
import { JOBS } from "../src/scheduler/jobs";
import { composePrompt } from "../src/scheduler/spawn";

const sorted = (s: Set<string>) => [...s].sort();
const issue = (number: number, title: string, body = ""): DedupeIssue => ({ number, title, body, labels: [] });

// Real open-backlog titles, verbatim (the spec's worked examples plus two
// clusters the deterministic pass recovers on the live backlog).
const T = {
  707: "PR #83 red CI blocking merge (doc-size + test, 9h)",
  713: "Doc PR cluster stalled: PR #83 red CI, PR #81 unreviewed",
  819: "Unarmed pilot trapped in battle: retreat/get_battle_status unregistered, only self_destruct escapes",
  871: "Corsair re-enters unwinnable combat at nashira post-gift, same trap class as issue 867, new location",
  1067: "PR review/merge accepts a stated live-verification proof bar without checking it (PR #102 case)",
  1083: "Scout: survey_system no_scanner 265x/72h, last ~3.5h ago -- not guard-prevented despite PR102/a892877 fitment-guard fix (merged 2026-09-11)",
  1084: "Batch-two PRs #107/#108 conflicted, awaiting fix loop",
  1085: "Batch-two PRs #107/#108 conflicting — merge gate blocking all downstream G4 fixes",
  1089: "Batch-two PRs #107/#108 merge-conflicted, blocking all downstream G4 fixes (#1069)",
  1098: "Scout survey_system 265x in 72h — verify PR #102 deployed to prod",
  1099: "P1: PR #107 and #108 merge-conflicted, G4 sole blocker, human resolve needed",
  1103: "PRs #107 and #108 merge-conflicted, blocking G4 since 2026-09-11",
  508: "Council 2026-07-24 report needs docs/council/ commit",
  828: "Council report 2026-08-12 requires workstation commit/push",
  842: "Council report 2026-08-14 awaiting workstation push",
  900: "Council report 2026-08-21 needs workstation commit",
} as const;

// --- a fake tracker -----------------------------------------------------------

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: Set<string>;
  comments: string[];
  open: boolean;
}

const WRITE_ISSUE_VERBS = new Set(["create", "edit", "comment", "close", "reopen", "delete", "lock", "unlock", "pin", "unpin", "transfer"]);
const isWrite = (args: string[]) =>
  (args[0] === "issue" && WRITE_ISSUE_VERBS.has(args[1]!)) || (args[0] === "label" && args[1] !== "list");

function fakeTracker(seed: DedupeIssue[], opts: { labels?: string[] } = {}) {
  const db = new Map<number, FakeIssue>(
    seed.map((i) => [i.number, { number: i.number, title: i.title, body: i.body, labels: new Set(i.labels), comments: [], open: true }]),
  );
  const repoLabels = opts.labels ?? [CANDIDATE_LABEL, CONFIRMED_LABEL, "machine-filed"];
  const calls: string[][] = [];
  let nextNumber = 9000;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const gh: GhRunner = (args) => {
    calls.push(args);
    const ok = (v: unknown) => ({ stdout: typeof v === "string" ? v : JSON.stringify(v), exitCode: 0 });
    const labelsOf = (i: FakeIssue) => [...i.labels].map((name) => ({ name }));
    if (args[0] === "issue" && args[1] === "list") {
      if (args.includes("--search")) {
        return ok(
          [...db.values()]
            .filter((i) => i.comments.some((c) => c.includes("sm-dupe-cluster")))
            .map((i) => ({ number: i.number, state: i.open ? "OPEN" : "CLOSED", labels: labelsOf(i), comments: i.comments.map((body) => ({ body })) })),
        );
      }
      return ok([...db.values()].filter((i) => i.open).map((i) => ({ number: i.number, title: i.title, body: i.body, labels: labelsOf(i) })));
    }
    if (args[0] === "issue" && args[1] === "view") return ok({ comments: db.get(Number(args[2]))!.comments.map((body) => ({ body })) });
    if (args[0] === "label" && args[1] === "list") return ok(repoLabels.map((name) => ({ name })));
    if (args[0] === "issue" && args[1] === "edit") {
      const target = db.get(Number(args[2]))!;
      if (args.includes("--add-label")) target.labels.add(flag(args, "--add-label"));
      if (args.includes("--body-file")) target.body = readFileSync(flag(args, "--body-file"), "utf8");
      return ok("");
    }
    if (args[0] === "issue" && args[1] === "comment") {
      db.get(Number(args[2]))!.comments.push(readFileSync(flag(args, "--body-file"), "utf8"));
      return ok("");
    }
    if (args[0] === "issue" && args[1] === "create") {
      const n = nextNumber++;
      db.set(n, { number: n, title: flag(args, "--title"), body: readFileSync(flag(args, "--body-file"), "utf8"), labels: new Set(), comments: [], open: true });
      return ok(`https://github.com/x/y/issues/${n}\n`);
    }
    return { stdout: "", exitCode: 1 };
  };
  const commentCount = () => [...db.values()].reduce((n, i) => n + i.comments.length, 0);
  const labelCount = () => [...db.values()].reduce((n, i) => n + i.labels.size, 0);
  return { gh, calls, db, commentCount, labelCount };
}

const stateDir = () => mkdtempSync(join(tmpdir(), "dedupe-"));
const liveStateDir = () => {
  const dir = stateDir();
  writeFileSync(join(dir, "gates.json"), JSON.stringify({ dedupePosting: { enabled: true } }));
  return dir;
};
const NOW = Date.UTC(2026, 8, 21, 3, 47);

// Two deterministic clusters from real titles, plus unrelated singletons.
const backlog = (): DedupeIssue[] => [
  issue(508, T[508]),
  issue(828, T[828]),
  issue(842, T[842]),
  issue(900, T[900]),
  issue(1085, T[1085]),
  issue(1089, T[1089]),
  issue(707, T[707]),
  issue(819, T[819]),
];

// --- Matching -----------------------------------------------------------------

describe("title matching (spec: Matching)", () => {
  // Catches: the extractor drifting from the spec's worked examples. The
  // plural fold is what keeps #1084 (`PRs #107`) and #1099 (`PR #107`) from
  // being non-empty and disjoint, which would split the cluster the spec
  // itself uses as its example. The second number of a list is not an anchor
  // (#1084 yields pr107 only): the latent fragility the spec records.
  test("titleEntityAnchors reproduces the spec's worked examples on real titles", () => {
    expect(sorted(titleEntityAnchors(T[707]))).toEqual(["pr83"]);
    expect(sorted(titleEntityAnchors(T[1084]))).toEqual(["pr107"]);
    expect(sorted(titleEntityAnchors(T[1099]))).toEqual(["pr107"]);
    expect(sorted(titleEntityAnchors(T[713]))).toEqual(["pr81", "pr83"]);
    expect(sorted(titleEntityAnchors(T[871]))).toEqual(["issue867"]);
    expect(sorted(titleEntityAnchors(T[819]))).toEqual([]);
    for (const n of [1098, 1083, 1067] as const) expect(sorted(titleEntityAnchors(T[n]))).toEqual(["pr102"]);
    expect(sorted(titleEntityAnchors("PR #12345 red"))).toEqual([]); // five digits never anchor on four
  });

  // Catches: an equality gate over prose (it would strand #871 from the
  // 19 anchorless members of its own cluster) and a gate that stops
  // separating PR #83 from PR #107.
  test("titleAnchorsConflict is disjointness over two non-empty sets", () => {
    expect(titleAnchorsConflict(new Set(["pr83"]), new Set(["pr107"]))).toBe(true);
    expect(titleAnchorsConflict(new Set(["pr83", "pr81"]), new Set(["pr83"]))).toBe(false);
    expect(titleAnchorsConflict(titleEntityAnchors(T[871]), titleEntityAnchors(T[819]))).toBe(false);
    expect(titleAnchorsConflict(titleEntityAnchors(T[1099]), titleEntityAnchors(T[1103]))).toBe(false);
  });

  // Catches: the anchor gate dropping out of the exported check (#1133 will
  // call it at mint time). Same words, different PR: must not match.
  test("isNearDuplicateTitle: same wording about different PRs never matches, same PR does", () => {
    expect(isNearDuplicateTitle("PR #83 red CI blocking merge", "PR #107 red CI blocking merge")).toBe(false);
    expect(isNearDuplicateTitle("PR #83 red CI blocking merge", "PR #83 red CI still blocking merge 9d")).toBe(true);
    expect(isNearDuplicateTitle(T[1085], T[1089])).toBe(true);
  });

  // Catches: the title-to-key adapter joining segments with ONE hyphen, which
  // lets filing.ts's slug anchor pattern re-form `pr-830` inside the key and
  // hard-block the title from every title not naming PR 830.
  test("a parenthesised entity number does not re-form a slug anchor inside the adapted key", () => {
    expect(sorted(titleEntityAnchors("PR (830) red CI blocking merge"))).toEqual([]);
    expect(isNearDuplicateTitle("PR (830) red CI blocking merge", "red CI blocking merge")).toBe(true);
  });

  test("titleToSegments drops severity, staleness, duration words and anchors, as keySegments does for keys", () => {
    expect(sorted(titleToSegments("P0 BLOCKER: corsair still stuck in battle 9d"))).toEqual(["battle", "corsair", "in"]);
    expect(sorted(titleToSegments(T[707]))).toEqual(["blocking", "ci", "doc", "merge", "red", "size", "test"]);
  });
});

// --- Clustering and canonical selection ----------------------------------------

describe("clustering and canonical selection", () => {
  // Catches: single-link chaining. Plain union-find joins PR #83 and PR #107
  // through an anchorless title that matches both, the merge the anchor gate
  // exists to prevent.
  test("an anchorless bridge cannot chain a PR #83 title to a PR #107 title", () => {
    const res = clusterIssues([
      issue(1, "PR #83 red CI blocking merge"),
      issue(2, "red CI blocking merge"),
      issue(3, "PR #107 red CI blocking merge"),
    ]);
    const withOne = res.clusters.find((c) => c.canonical === 1 || c.members.some((m) => m.number === 1))!;
    const numbers = [withOne.canonical, ...withOne.members.map((m) => m.number)];
    expect(numbers).toContain(2);
    expect(numbers).not.toContain(3);
    expect(res.unresolved).toEqual([3]);
  });

  test("real council-report titles form one high-confidence cluster, linked back to its canonical", () => {
    const res = clusterIssues(backlog());
    const council = res.clusters.find((c) => c.canonical === 508)!;
    expect(council.members.map((m) => m.number)).toEqual([828, 842, 900]);
    for (const m of council.members) {
      expect(m.tier).toBe("high");
      expect(m.kind).toBe("title");
      expect(m.score!).toBeGreaterThanOrEqual(0.6);
    }
    // #707 and #819 match nothing: they are the semantic pass's input.
    expect(res.unresolved).toEqual([707, 819]);
  });

  // Catches: canonical selection losing a rung of the spec's order.
  test("canonical: cause-naming beats symptom-only, then most cross-referenced, then lowest number", () => {
    const cause = [issue(10, "x", "failed 5 times"), issue(11, "x", "fails because the filer drops it"), issue(12, "x", "failed")];
    expect(chooseCanonical(cause, crossRefCounts(cause))).toBe(11);
    const refs = [issue(20, "x"), issue(21, "x"), issue(30, "unrelated", "see #21")];
    expect(chooseCanonical(refs.slice(0, 2), crossRefCounts(refs))).toBe(21);
    // `PR #20` names a code-repo pull request, not tracker issue 20.
    const prs = crossRefCounts([issue(20, "x"), issue(31, "PR #20 red CI", "PRs #20 and #23 conflicted, see #21")]);
    expect(prs.get(20)).toBeUndefined();
    expect(prs.get(21)).toBe(1);
    expect(chooseCanonical([issue(41, "x"), issue(40, "x")], new Map())).toBe(40);
  });

  // Catches: model output reaching a proposal unvalidated. Every rejection
  // reason is a pair the semantic pass could plausibly send.
  test("semantic pairs: only unresolved members, open targets, non-conflicting anchors; accepted ones are medium", () => {
    const issues = [...backlog(), issue(1101, "Pilot stuck in combat, no flee lever"), issue(1102, "PR #107 still conflicting")];
    const res = clusterIssues(issues, [
      { member: 1101, target: 819 },
      { member: 828, target: 819 }, // already clustered by title
      { member: 1102, target: 707 }, // pr107 vs pr83
      { member: 4242, target: 819 }, // not open
      { member: 1101, target: 1101 },
    ]);
    expect(res.semanticAccepted).toBe(1);
    expect(res.semanticRejected.map((r) => r.member)).toEqual([828, 1102, 4242, 1101]);
    const battle = res.clusters.find((c) => c.members.some((m) => m.number === 1101) || c.canonical === 1101)!;
    const member = battle.members[0]!;
    expect(member.kind).toBe("semantic");
    expect(member.tier).toBe("medium");
  });
});

// --- Idempotence, budget, gate -----------------------------------------------------

describe("idempotence (spec: Idempotence)", () => {
  // Catches: the closed-canonical carve-out and the re-cluster rule collapsing
  // into one another.
  test("proposalSkip: same pairing never reposts; a closed canonical keeps its marker; a new open canonical is a new pairing", () => {
    const open = new Set([1, 2, 3]);
    expect(proposalSkip([{ canonical: 2, tier: "high" }], 2, open)).toBe("already-proposed");
    expect(proposalSkip([{ canonical: 99, tier: "high" }], 2, open)).toBe("canonical-closed");
    expect(proposalSkip([{ canonical: 3, tier: "high" }], 2, open)).toBe(null);
    expect(proposalSkip([], 2, open)).toBe(null);
  });

  // The spec's Done-when, clause two, as a test: a second run over an
  // unchanged backlog posts nothing, and comment and label counts come out
  // equal before and after.
  test("a second live run over an unchanged backlog makes zero tracker writes", () => {
    const tracker = fakeTracker(backlog());
    const dir = liveStateDir();
    const first = runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    expect(first.proposals.map((p) => p.member)).toEqual([828, 842, 900, 1089]);
    expect(first.report.action).toBe("created");
    expect([...tracker.db.get(828)!.labels]).toEqual([CANDIDATE_LABEL]);
    expect(tracker.db.get(828)!.comments[0]).toContain("<!-- sm-dupe-cluster:508 -->");
    // Done-when, clause three: the one line a person reads as distinct open work.
    const report = [...tracker.db.values()].find((i) => i.title === "Backlog dedupe: standing report")!;
    expect(report.body).toContain("4 of 8 open issues are flagged as duplicates of 2 canonicals, leaving 4 distinct open issues.");

    const [comments, labels] = [tracker.commentCount(), tracker.labelCount()];
    tracker.calls.length = 0;
    const second = runDedupe(tracker.gh, { stateDir: dir, now: NOW + 7 * 86_400_000 });
    expect(tracker.calls.filter(isWrite)).toEqual([]);
    expect(second.proposals).toEqual([]);
    expect(second.report.action).toBe("unchanged");
    expect([tracker.commentCount(), tracker.labelCount()]).toEqual([comments, labels]);
    // The report issue is open now, and still does not count as backlog.
    expect(readFileSync(join(dir, "reports", LOCAL_REPORT_FILE), "utf8")).toContain("4 of 8 open issues are flagged");
  });

  // Catches: the pre-post read being skipped. The advisory marker scan is a
  // search that can miss. Here it misses everything, and the authoritative
  // per-member read still stops the repost.
  test("a marker the advisory scan missed still blocks a repost", () => {
    const tracker = fakeTracker(backlog());
    const dir = liveStateDir();
    runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    const blindScan: GhRunner = (args) => (args.includes("--search") ? { stdout: "[]", exitCode: 0 } : tracker.gh(args));
    tracker.calls.length = 0;
    const again = runDedupe(blindScan, { stateDir: dir, now: NOW });
    expect(again.proposals).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(["already-proposed", "already-proposed", "already-proposed", "already-proposed"]);
    expect(tracker.calls.filter((a) => a[0] === "issue" && (a[1] === "comment" || (a[1] === "edit" && a.includes("--add-label"))))).toEqual([]);
  });

  // Catches: the per-run budget or its largest-cluster-first order.
  test(`budget: ${PROPOSALS_PER_RUN} proposals per run, largest cluster first, the rest on later runs`, () => {
    // 1-2 digit numbers drop as durations, so these 26 titles are one cluster.
    // Numbered from 300 so no fixture title's `#107` reference lands on one.
    const big = Array.from({ length: 26 }, (_, i) => issue(300 + i, `Council report needs workstation commit (${i + 1})`));
    const tracker = fakeTracker([...big, issue(1085, T[1085]), issue(1089, T[1089])]);
    const dir = liveStateDir();
    const r1 = runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    expect(r1.proposals.length).toBe(PROPOSALS_PER_RUN);
    expect(r1.proposals.every((p) => p.canonical === 300)).toBe(true);
    expect(r1.deferred).toBe(6); // 5 left in the big cluster + #1089
    const r2 = runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    expect(r2.proposals.map((p) => p.member)).toEqual([321, 322, 323, 324, 325, 1089]);
    tracker.calls.length = 0;
    const r3 = runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    expect(r3.proposals).toEqual([]);
    expect(tracker.calls.filter(isWrite)).toEqual([]);
  });
});

describe("posting gate (operator order: ships OFF)", () => {
  // Catches: the ceremony writing to the tracker without the operator's
  // opt-in. The same fixture DOES write once the gate is on, so the first
  // half cannot pass by the fixture simply having nothing to post, and the
  // write classifier is proven against the verbs this module really uses.
  test("with no gates.json the run makes zero tracker writes, the same fixture writes once dedupePosting is on", () => {
    const dry = fakeTracker(backlog());
    const dryDir = stateDir();
    const r = runDedupe(dry.gh, { stateDir: dryDir, now: NOW });
    expect(r.mode).toBe("dry-run");
    expect(dry.calls.filter(isWrite)).toEqual([]);
    expect(r.proposals.length).toBe(4); // what a live run would post
    expect(r.report.action).toBe("created");
    const local = readFileSync(join(dryDir, "reports", LOCAL_REPORT_FILE), "utf8");
    expect(local).toContain("Mode: dry run");
    expect(local).toContain("#828");

    const live = fakeTracker(backlog());
    const liveRun = runDedupe(live.gh, { stateDir: liveStateDir(), now: NOW });
    expect(liveRun.mode).toBe("live");
    const verbs = new Set(live.calls.filter(isWrite).map((a) => `${a[0]} ${a[1]}`));
    expect([...verbs].sort()).toEqual(["issue comment", "issue create", "issue edit"]);
  });

  test("every gh call is pinned to the issues repo", () => {
    const tracker = fakeTracker(backlog());
    runDedupe(tracker.gh, { stateDir: liveStateDir(), now: NOW });
    dedupeCandidates(tracker.gh, { stateDir: stateDir() });
    for (const args of tracker.calls) expect(args.slice(-2)).toEqual(["--repo", FILING_REPO]);
  });

  // Catches: an unknown label 422ing mid-run after some comments already posted.
  test("posting on with the labels missing fails before the first write", () => {
    const tracker = fakeTracker(backlog(), { labels: ["machine-filed"] });
    expect(() => runDedupe(tracker.gh, { stateDir: liveStateDir(), now: NOW })).toThrow(DedupeSetupError);
    expect(tracker.calls.filter(isWrite)).toEqual([]);
  });
});

// --- Precision ledger -----------------------------------------------------------------

describe("precision ledger (spec: Setting and measuring a precision target)", () => {
  // Catches: silence counting as success, the instrument that cannot come out
  // two ways. An untouched proposal is unreviewed, never a true positive.
  test("adjudicate reads only the two label events; an untouched proposal is unreviewed", () => {
    expect(adjudicate([CANDIDATE_LABEL])).toBe("unreviewed");
    expect(adjudicate([CANDIDATE_LABEL, CONFIRMED_LABEL])).toBe("true-positive");
    expect(adjudicate(["machine-filed"])).toBe("false-positive"); // marker present, candidate label stripped
  });

  test("the ratio names its sample, and a zero denominator prints no ratio", () => {
    expect(formatPrecision({ truePositive: 14, falsePositive: 1, unreviewed: 30 })).toBe("0.93 (14/15 reviewed)");
    expect(formatPrecision({ truePositive: 0, falsePositive: 0, unreviewed: 30 })).toBe("no reviewed proposals yet");
  });

  test("end to end: one confirmation and one stripped label read as 0.50 (1/2 reviewed), the rest unreviewed", () => {
    const tracker = fakeTracker(backlog());
    const dir = liveStateDir();
    runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    tracker.db.get(828)!.labels.add(CONFIRMED_LABEL);
    tracker.db.get(842)!.labels.delete(CANDIDATE_LABEL);
    runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    const local = readFileSync(join(dir, "reports", LOCAL_REPORT_FILE), "utf8");
    expect(local).toContain("Precision, high confidence: 0.50 (1/2 reviewed). 2 unreviewed.");
    expect(local).toContain("Precision, medium confidence: no reviewed proposals yet. 0 unreviewed.");
  });
});

// --- Cadence: delta gate and high-water mark ----------------------------------------------

describe("semantic-pass delta gate (spec: Cadence and cost)", () => {
  test("no mark yet runs the pass; under ten new issues skips it; ten runs it", () => {
    expect(semanticGate(null, [1, 2]).due).toBe(true);
    expect(semanticGate(100, [95, ...Array.from({ length: 9 }, (_, i) => 101 + i)]).due).toBe(false);
    expect(semanticGate(100, Array.from({ length: 10 }, (_, i) => 101 + i)).due).toBe(true);
  });

  // Catches: the high-water mark advancing in a week the report was not
  // rewritten, which would undercount new issues and skip the semantic pass.
  // Both homes of the mark: the tracker report when live, the local report
  // (rewritten every run as the run log) when dry.
  const unrelated = ["Dashboard chart axis mislabelled", "Ollama planner timeout on cold start", "Spend ledger rounding drift"];
  const openUnrelated = (tracker: ReturnType<typeof fakeTracker>) =>
    unrelated.forEach((title, k) => tracker.db.set(1200 + k, { number: 1200 + k, title, body: "", labels: new Set(), comments: [], open: true }));

  test("live: the mark advances only with a report rewrite, and the report issue never counts as new", () => {
    const tracker = fakeTracker(backlog());
    const dir = liveStateDir();
    runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    const reportBody = () => [...tracker.db.values()].find((i) => i.title === "Backlog dedupe: standing report")!.body;
    expect(reportBody()).toContain("<!-- sm-dedupe-hwm:1089 -->");
    openUnrelated(tracker); // the cluster set does not change
    const r = runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    expect(r.report.action).toBe("unchanged");
    expect(reportBody()).toContain("<!-- sm-dedupe-hwm:1089 -->");
    expect(dedupeCandidates(tracker.gh, { stateDir: dir }).semantic.newIssues).toBe(3);
  });

  test("dry run: an unchanged cluster set carries the local report's mark forward", () => {
    const tracker = fakeTracker(backlog());
    const dir = stateDir();
    runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    openUnrelated(tracker);
    runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    expect(readFileSync(join(dir, "reports", LOCAL_REPORT_FILE), "utf8")).toContain("<!-- sm-dedupe-hwm:1089 -->");
    expect(dedupeCandidates(tracker.gh, { stateDir: dir }).semantic.newIssues).toBe(3);
  });

  // Catches: the semantic pass's input arriving cut. On the live backlog it is
  // a few hundred KB. A headless Bash tool saves that to a file, and the Read
  // tool cuts any line past 2000 characters, so one JSON document would reach
  // the model as a fragment.
  test("candidates print as JSON Lines, each line parseable and under the Read tool's line cut", () => {
    const long = "word ".repeat(2000);
    // Worst case for JSON escaping: quotes double, control characters would
    // grow sixfold if they survived (built from a code point, not typed).
    const nasty = `"${String.fromCharCode(7)}`.repeat(600);
    const tracker = fakeTracker([...backlog(), issue(1500, `Title ${long}`, `Body ${long}`), issue(1501, nasty, nasty)]);
    const lines = formatCandidates(dedupeCandidates(tracker.gh, { stateDir: stateDir() }));
    expect(lines.length).toBe(1 + 2 + 4); // header, 2 canonicals, 4 unresolved
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(CANDIDATE_LINE_MAX);
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("candidates hands the semantic pass only unresolved issues, and nothing when the pass is not due", () => {
    const tracker = fakeTracker(backlog());
    const dir = stateDir();
    const first = dedupeCandidates(tracker.gh, { stateDir: dir });
    expect(first.semantic.due).toBe(true);
    expect(first.unresolved.map((u) => u.number)).toEqual([707, 819]);
    expect(first.clusters.map((c) => c.canonical)).toEqual([508, 1085]);
    runDedupe(tracker.gh, { stateDir: dir, now: NOW }); // dry run: the mark lives in the local report
    const second = dedupeCandidates(tracker.gh, { stateDir: dir });
    expect(second.semantic.due).toBe(false);
    expect(second.unresolved).toEqual([]);
  });
});

// --- CLI input and scheduler wiring ---------------------------------------------------------

describe("semantic pair input and scheduler wiring", () => {
  test("parseSemanticPairs accepts number pairs and rejects anything else", () => {
    expect(parseSemanticPairs('[{"member":1101,"target":819}]')).toEqual([{ member: 1101, target: 819 }]);
    expect(() => parseSemanticPairs('{"member":1,"target":2}')).toThrow();
    expect(() => parseSemanticPairs('[{"member":"1101","target":819}]')).toThrow();
    expect(() => parseSemanticPairs('[{"member":1.5,"target":819}]')).toThrow();
    expect(() => parseSemanticPairs('[{"member":-3,"target":819}]')).toThrow();
  });

  // Catches the L-39 class for this job: a work order teaching a command its
  // closed allowedTools list does not cover is denied at run time while every
  // offline test stays green. And the agent holds no gh grant at all, so the
  // script stays the only tracker path.
  //
  // Fix round on PR #143: the ONLY prior check here was the gh-prefixed one —
  // it never looked for the file-finding.ts grant, so a dedupePosting-off run
  // could still hold `Bash(bun scripts/file-finding.ts *)` and file issues /
  // post bump comments through the separate (default-on) fileFindings gate,
  // straight from untrusted issue excerpts. Asserted here too now.
  test("the dedupe job's work order teaches only commands its grant covers, and it holds neither a gh grant nor the file-finding.ts filer", () => {
    const job = JOBS.find((j) => j.id === "dedupe")!;
    const grant = "Bash(bun scripts/backlog-dedupe.ts *)";
    expect(job.allowedTools).toContain(grant);
    expect(job.allowedTools.some((t) => t.startsWith("Bash(gh "))).toBe(false);
    expect(job.allowedTools.some((t) => t.includes("file-finding"))).toBe(false);
    const prefix = grant.slice("Bash(".length, -" *)".length);
    const prompt = composePrompt(job, { charterText: "x", stateNow: "y", cycleId: "dedupe-1" });
    expect(prompt).toContain(`${prefix} candidates`);
    expect(prompt).toContain(`${prefix} run`);
    expect(prompt).toContain("--semantic-b64");
    expect(prompt).not.toContain("file-finding");
  });
});

// --- Report identity (unauthenticated marker match) ----------------------------------------

describe("standing-report identity (fix round, PR #143)", () => {
  // Catches: the report being "whichever open issue's body contains the
  // marker anywhere", with no title check. A filer routinely quotes source
  // lines as evidence, so an unrelated issue that cites the marker string
  // used to be adopted as the standing report itself — dropped from the
  // backlog count, and (in live mode) had its body overwritten on the next
  // run, never to be flagged as a duplicate again. Report identity now needs
  // BOTH the exact REPORT_TITLE and a body that starts with the marker (the
  // ceremony writes it as line one) — a mid-body quote satisfies neither.
  test("an issue that quotes the report marker mid-body is neither adopted as the report nor dropped from the backlog", () => {
    const quoting = issue(
      600,
      "Filer cited the dedupe report marker verbatim as reproduction evidence",
      "Repro: the work order's filing template embeds <!-- sm-dedupe-report --> mid-sentence as a worked example; this issue is not the report.",
    );
    const tracker = fakeTracker([...backlog(), quoting]);
    const dir = liveStateDir();
    const r = runDedupe(tracker.gh, { stateDir: dir, now: NOW });
    expect(r.openIssues).toBe(9); // #600 counted as backlog, never silently dropped
    expect(r.report.action).toBe("created"); // a fresh report issue, never #600 "updated" in place
    const report = [...tracker.db.values()].find((i) => i.title === "Backlog dedupe: standing report")!;
    expect(report.number).not.toBe(600);
    expect(tracker.db.get(600)!.body).toContain("worked example"); // #600's own body untouched
  });
});
