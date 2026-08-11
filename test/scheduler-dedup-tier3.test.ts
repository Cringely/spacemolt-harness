// Tier-3 near-match dedup (producer) + the grooming report (consumer).
//
// The fixture is not invented. Every key below was pulled from a live dump of
// the open `machine-filed` issues in Cringely/spacemolt on 2026-08-11: 19 of
// them are the SAME finding — PR #83's red CI — filed nineteen times because a
// headless spawn has no memory of last cycle and re-words the key every run.
// #618 is the negative control: a real, different finding about PR #40 that a
// looser rule merged into the pile.
//
// Offline: fake gh runners and temp state dirs, zero live gh, zero tokens.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILING_LOG_FILE,
  entityAnchors,
  fileFinding,
  isNearDuplicate,
  keySegments,
  readDedupKey,
  type FilingLogEntry,
  type GhRunner,
} from "../src/scheduler/filing";
import { clusterItems, newCanonicals, type GroomItem } from "../scripts/groom-report";

const tmp = () => mkdtempSync(join(tmpdir(), "dedup-t3-"));

// --- live fixture ------------------------------------------------------------

/** The 19 open issues filed for PR #83's red CI (issue number → dedup key). */
const PR83: ReadonlyArray<readonly [number, string]> = [
  [807, "pr-83-red-ci-8d"],
  [804, "pr-83-red-ci-hung-8-days"],
  [802, "pr-83-red-ci-stalled"],
  [796, "pr83-red-ci-8days-unresolved"],
  [782, "pr-83-red-ci-unfixed-7d"],
  [779, "pr-83-red-ci-7-days"],
  [778, "pr-83-ci-red-fix-loop-stalled"],
  [772, "pr-83-red-ci-hung"],
  [768, "pr-83-ci-red-stalled"],
  [763, "pr-83-red-stalled"],
  [759, "pr-83-red-5d"],
  [750, "pr-83-ci-red-unfixed"],
  [748, "pr-83-ci-red-4days"],
  [741, "pr-83-red-ci-unfixed"],
  [739, "pr-83-red-ci-unaddressed"],
  [733, "red-pr-83-unaddressed-3d"],
  [724, "pr-83-red-ci-blocked"],
  [712, "pr-83-test-failure-opaque"],
  [707, "red-pr-unfixed-9h"], // same finding, but the key never names the PR
];

/** Negative control: a real, DIFFERENT finding about a different PR. */
const PR40: readonly [number, string] = [618, "pr-40-red-ci-merge"];

/** The other live pile: ten open issues for one stale STATE.md NOW block. */
const STATE_MD: ReadonlyArray<readonly [number, string]> = [
  [805, "state-now-block-stale-8-days"],
  [799, "state-now-block-stale-8d"],
  [797, "state-md-stale-8days"],
  [784, "state-now-block-stale"],
  [783, "state-md-stale-7d"],
  [780, "state-md-now-block-overdue"],
  [777, "state-md-stale-6d"],
  [769, "state-refresh-overdue"],
  [746, "state-md-refresh-overdue"],
  [723, "state-md-stale-2d"],
];

const asItems = (pairs: ReadonlyArray<readonly [number, string]>): GroomItem[] =>
  pairs.map(([number, key]) => ({ number, key, title: `#${number}` }));

// --- the rule ----------------------------------------------------------------

describe("tier-3 near-match: the live PR #83 pile", () => {
  // Catches: the shipped-but-inert producer fix. Against this exact fixture the
  // #635 normalizer (severity strip + separator fold) collapses NOTHING, which
  // is why a stronger tier exists at all. Ablation performed: reverting
  // findNearMatch/clusterItems to normalized-string equality drops this from
  // two clusters to zero and turns the test red.
  //
  // Matcher blind spot checked: `toContain` on the member list is count-blind —
  // it would pass a clustering that merged 19 keys into one giant blob. Asserted
  // on exact cluster SIZES and on the full sorted membership instead.
  test("the 19 PR-83 keys collapse into clusters; #618 (PR #40) joins none of them", () => {
    const clusters = clusterItems(asItems([...PR83, PR40]));
    expect(clusters.map((c) => c.members.length)).toEqual([13, 3]);

    const clustered = clusters.flatMap((c) => c.members.map((m) => m.number));
    expect(clustered).not.toContain(PR40[0]);
    // 16 of the 19 collapse. The three that do not are named, not hidden:
    // #778 and #712 describe narrower conditions (a hung fix loop, an opaque
    // test failure) and #707 never names the PR at all, so the anchor rule
    // refuses to fold it in. Under-collapsing is the safe direction.
    expect(clustered.sort((a, b) => a - b)).toEqual(
      [724, 733, 739, 741, 748, 750, 759, 763, 768, 772, 779, 782, 796, 802, 804, 807].sort((a, b) => a - b),
    );
  });

  // Catches: the false collapse an earlier cut of this rule actually produced —
  // dropping `40` and `83` as if they were durations, which merged a real
  // "PR #40 merged on RED CI" violation into the PR #83 pile. Ablation:
  // deleting the setsEqual(anchors) line from isNearDuplicate turns this red.
  test("keys naming DIFFERENT entities never match, however similar the wording", () => {
    expect(isNearDuplicate("pr-83-red-ci-stalled", "pr-40-red-ci-merge")).toBe(false);
    expect(isNearDuplicate("pr-83-red-ci-stalled", "pr-81-red-ci-stalled")).toBe(false);
    expect(isNearDuplicate("issue-114-scheduler-hung", "issue-115-scheduler-hung")).toBe(false);
    // …and the same entity written two ways IS one entity.
    expect(entityAnchors("pr83-red-ci-8days-unresolved")).toEqual(entityAnchors("pr-83-red-ci-8d"));
    expect(isNearDuplicate("pr83-red-ci-8days-unresolved", "pr-83-red-ci-8d")).toBe(true);
  });

  // Catches: an anchorless generic key swallowing an entity-specific one. The
  // rule is "anchor sets EQUAL, or both empty" — not "compatible".
  //
  // `red-ci-stalled` is CONSTRUCTED, and deliberately so: the real anchorless
  // key (#707 `red-pr-unfixed-9h`) also fails the Jaccard bar, so a test built
  // on it would pass even with the anchor rule deleted — it would be structurally
  // unable to fail. This pair overlaps perfectly on segments, so ONLY the anchor
  // rule can reject it. Ablation: deleting that line turns this red.
  test("an anchored key never folds into an anchorless one", () => {
    expect(keySegments("pr-83-red-ci-stalled")).toEqual(keySegments("red-ci-stalled"));
    expect(isNearDuplicate("pr-83-red-ci-stalled", "red-ci-stalled")).toBe(false);
  });

  // Catches: the `union > 0` guard's own doc comment going unenforced — "a
  // pathological key made entirely of noise words cannot swallow the
  // backlog." Both keys here reduce to the empty segment set (only staleness
  // words survive stripping), so 0/0 is NaN in JS, which already fails
  // `>= NEAR_MATCH_JACCARD` on its own — the guard is what stops a DIFFERENT
  // bug (inverting it to short-circuit true on an empty union) from making
  // every all-noise key match every other one. Matcher note: `toBe(false)` is
  // strict, so it would not have passed a `false`-shaped bug silently — the
  // gap was that nothing exercised two all-noise keys at all.
  // Ablation performed: changed `union > 0 && ...` to `union === 0 || ...`
  // in isNearDuplicate — this test alone went red; reverted after confirming.
  test("two keys that reduce to nothing (only staleness/duration words) never match each other", () => {
    expect(keySegments("stalled-8d")).toEqual(new Set());
    expect(keySegments("overdue-now")).toEqual(new Set());
    expect(isNearDuplicate("stalled-8d", "overdue-now")).toBe(false);
  });

  // Catches: two things at once, both live. Anchorless keys must still collapse
  // (the "or both empty" half of the rule), and clustering must be TRANSITIVE —
  // these ten do not all pair with each other, they chain through intermediate
  // wordings (`state-md-now-block-overdue` bridges the `now-block` and `md`
  // spellings). A pairwise-only grouping would report four or five fragments.
  // Ablation: replacing the union-find with "group by first match" turns this red.
  test("the 10 STATE.md staleness keys chain into ONE cluster", () => {
    const clusters = clusterItems(asItems(STATE_MD));
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.members.length).toBe(STATE_MD.length);
    expect(isNearDuplicate("state-md-stale-7d", "state-md-stale-2d")).toBe(true);
    // Not a direct pair — proof the single cluster came from transitivity.
    expect(isNearDuplicate("state-now-block-stale", "state-md-stale-2d")).toBe(false);
  });

  // Catches: the noise vocabulary silently going missing. These are the exact
  // segments that vary cycle to cycle; if any stops being stripped the PR-83
  // pile fragments. Blind spot: `toEqual` on a Set compares membership, so an
  // EXTRA surviving segment fails — which is the direction that matters here.
  test("durations, staleness adjectives and severity words are stripped; meaning is not", () => {
    expect(keySegments("pr-83-red-ci-hung-8-days")).toEqual(new Set(["red", "ci"]));
    expect(keySegments("pr83-red-ci-8days-unresolved")).toEqual(new Set(["red", "ci"]));
    expect(keySegments("red-pr-83-unaddressed-3d")).toEqual(new Set(["red"]));
    expect(keySegments("p0-core-harvest-unimplemented")).toEqual(new Set(["core", "harvest", "unimplemented"]));
    // A word that merely CONTAINS a noise word survives — segment-exact, not substring.
    expect(keySegments("staleness-detector-missing")).toEqual(new Set(["staleness", "detector", "missing"]));
  });
});

// --- the producer path -------------------------------------------------------

interface GhCall {
  args: string[];
  body?: string;
}

/** Stateful gh double: `issue list` (no --search) sees everything created so far. */
function statefulGh() {
  const calls: GhCall[] = [];
  const created: Array<{ number: number; body: string }> = [];
  let next = 900;
  const gh: GhRunner = (args) => {
    const bodyIdx = args.indexOf("--body-file");
    const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, "utf8") : undefined;
    calls.push({ args, body });
    if (args[0] === "issue" && args[1] === "list") {
      if (args.includes("--search")) return { stdout: "[]", exitCode: 0 }; // exact-key path never hits here by construction
      return { stdout: JSON.stringify(created), exitCode: 0 };
    }
    if (args[0] === "issue" && args[1] === "create") {
      const number = next++;
      created.push({ number, body: body ?? "" });
      return { stdout: `https://github.com/x/y/issues/${number}\n`, exitCode: 0 };
    }
    return { stdout: "", exitCode: 0 };
  };
  return { gh, calls };
}

const finding = (dedupKey: string) => ({
  jobId: "standup",
  cycleId: "standup-1",
  dedupKey,
  title: `finding ${dedupKey}`,
  body: `body for ${dedupKey}`,
});

const logLines = (dir: string): FilingLogEntry[] =>
  readFileSync(join(dir, FILING_LOG_FILE), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FilingLogEntry);

describe("tier-3 in fileFinding (the producer)", () => {
  // Catches: the whole point. Thirteen live PR-83 findings, replayed in the
  // order they were actually filed and one per cycle (production filed them
  // across 13 stand-up cycles, so a single cycleId here would hit the
  // per-cycle cap and measure that instead), must open 2 issues rather than 13.
  //
  // NOT 1, and the gap is real rather than a rounding error: the filer compares
  // each arrival against what is ALREADY open, pairwise, so `pr-83-red-5d`
  // (which reduces to the single segment `red`) misses the `red`+`ci` issue at
  // 0.5 and opens a second. Transitive clustering closes that; an incremental
  // filer structurally cannot, which is the argument for shipping the report
  // alongside it. Pinned as 2 so a future change in either direction is visible.
  //
  // Ablation performed: reverting findNearMatch to tier-2 equality only makes
  // every one of the 13 return "created".
  // Blind spot: asserting only the final outcome would pass even if an earlier
  // call had opened a third issue, so the CREATE COUNT is asserted directly.
  test("13 live PR-83 findings, one per cycle, open 2 issues instead of 13", () => {
    const dir = tmp();
    const { gh, calls } = statefulGh();
    const cluster = [
      "pr-83-red-ci-blocked", "pr-83-red-ci-unaddressed", "pr-83-red-ci-unfixed",
      "pr-83-ci-red-4days", "pr-83-ci-red-unfixed", "pr-83-red-5d", "pr-83-red-stalled",
      "pr-83-ci-red-stalled", "pr-83-red-ci-hung", "pr-83-red-ci-7-days",
      "pr-83-red-ci-unfixed-7d", "pr83-red-ci-8days-unresolved", "pr-83-red-ci-stalled",
    ];
    const outcomes = cluster.map((k, i) => fileFinding(gh, dir, { ...finding(k), cycleId: `standup-${i}` }));
    expect(calls.filter((c) => c.args[1] === "create").length).toBe(2);
    expect(outcomes.filter((o) => o.outcome === "created").length).toBe(2);
    expect(outcomes.filter((o) => o.outcome === "bumped").length).toBe(11);
    expect(outcomes.filter((o) => o.outcome === "capped").length).toBe(0); // the cap never fired
  });

  // Catches: the false-collapse regression at the filer level rather than in the
  // pure rule — a genuinely different finding must still get its own issue.
  // Ablation: deleting the anchor check makes this return "bumped".
  test("the PR #40 finding still files fresh after the PR #83 issue exists", () => {
    const dir = tmp();
    const { gh } = statefulGh();
    const first = fileFinding(gh, dir, finding("pr-83-red-ci-stalled"));
    const second = fileFinding(gh, dir, finding("pr-40-red-ci-merge"));
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    expect(second.issue).not.toBe(first.issue);
  });

  // Catches: the near-match scan silently reading only the first page. 400 is a
  // LITERAL here on purpose (the R2 lesson from PR #29): asserting against the
  // constant would pass at any value, including the old 200 that truncated the
  // 170-issue backlog's headroom away. Ablation: setting the limit back to 200
  // turns this red.
  test("the near-match fetch asks for 400 issues", () => {
    const dir = tmp();
    const { gh, calls } = statefulGh();
    fileFinding(gh, dir, finding("pr-83-red-ci-stalled"));
    const scan = calls.find((c) => c.args[1] === "list" && !c.args.includes("--search"))!;
    expect(scan.args[scan.args.indexOf("--limit") + 1]).toBe("400");
  });
});

// --- the side channel --------------------------------------------------------

describe("filing side channel (LOUD degradation, #654 class)", () => {
  // Catches: a filing outcome that leaves no trace anywhere the scheduler can
  // read. FindingOutcome goes to the CLI's stdout, which is read by the spawned
  // AGENT — a field added there reaches the run log only if the agent volunteers
  // it. This file needs no agent cooperation.
  //
  // Blind spot: `toEqual` on a partial object ignores keys the entry is missing,
  // so an entry that dropped `issue` entirely would pass a partial match. The
  // whole object minus the timestamp is asserted instead.
  test("every filing appends one line carrying key, outcome and issue number", () => {
    const dir = tmp();
    const { gh } = statefulGh();
    const created = fileFinding(gh, dir, finding("pr-83-red-ci-stalled"));
    const bumped = fileFinding(gh, dir, finding("pr-83-red-ci-8d"));
    const lines = logLines(dir);
    expect(lines.length).toBe(2);
    const { ts, ...first } = lines[0]!;
    expect(typeof ts).toBe("string");
    expect(first).toEqual({
      jobId: "standup",
      cycleId: "standup-1",
      key: "pr-83-red-ci-stalled",
      outcome: "created",
      issue: created.issue!,
      nearMatch: "ok",
    });
    expect(lines[1]!.outcome).toBe("bumped");
    expect(lines[1]!.issue).toBe(bumped.issue!);
  });

  // Catches: THE degradation bug. A scan that could not parse its input and a
  // scan that found nothing both produce "no bump" and a byte-identical
  // `{"outcome":"created"}` — which is exactly how a broken dedup scan hides
  // for weeks. Ablation: returning `{ fetch: "ok" }` from the catch block in
  // findNearMatch turns this red while leaving every other test green.
  test("an unparseable near-match answer is recorded as unparseable, not as a clean miss", () => {
    const broken: GhRunner = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: args.includes("--search") ? "[]" : "not json", exitCode: 0 };
      }
      if (args[0] === "issue" && args[1] === "create") return { stdout: "https://x/y/issues/1\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };
    const dirBroken = tmp();
    expect(fileFinding(broken, dirBroken, finding("pr-83-red-ci-stalled")).outcome).toBe("created");
    const dirClean = tmp();
    const { gh } = statefulGh();
    expect(fileFinding(gh, dirClean, finding("pr-83-red-ci-stalled")).outcome).toBe("created");
    // Same outcome, same issue-less result — and distinguishable anyway.
    expect(logLines(dirBroken)[0]!.nearMatch).toBe("unparseable");
    expect(logLines(dirClean)[0]!.nearMatch).toBe("ok");
  });

  // Catches: findNearMatch's `!Array.isArray(hits)` guard going unenforced. A
  // JSON-encoded STRING (`"oops"`) is valid JSON, so JSON.parse succeeds and
  // hits does not throw the try/catch below — it is also ITERABLE (a for-of
  // over a string walks its characters), so without the guard the loop just
  // runs over single-character "hits" (each missing `.body`), finds no match,
  // and returns `{ fetch: "ok" }` — the guard is what stops a malformed-but-
  // parseable gh answer from being silently reported as a clean miss instead
  // of the #654 "denial-as-absence" class the sibling test above names. A
  // null/number/object payload would instead throw on `.length` or the
  // for-of and fail loudly on its own; the string case is the one that
  // degrades silently, so it is the one that needs a guard-specific test.
  // Matcher note: asserting only `.outcome` (`"created"` either way, since no
  // bump is ever found) is the blind spot here — it would stay green with the
  // guard deleted. The assertion has to land on `nearMatch`.
  // Ablation performed: deleted the `if (!Array.isArray(hits)) return {
  // fetch: "unparseable" };` line in findNearMatch — nearMatch flipped from
  // "unparseable" to "ok" and this test went red; reverted after confirming.
  test("a near-match answer that parses to a non-array is recorded as unparseable, not silently scanned", () => {
    const gh: GhRunner = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: args.includes("--search") ? "[]" : JSON.stringify("oops"), exitCode: 0 };
      }
      if (args[0] === "issue" && args[1] === "create") return { stdout: "https://x/y/issues/1\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };
    const dir = tmp();
    expect(fileFinding(gh, dir, finding("pr-83-red-ci-stalled")).outcome).toBe("created");
    expect(logLines(dir)[0]!.nearMatch).toBe("unparseable");
  });

  // Catches: a full page read as a complete backlog. At the ceiling a miss means
  // "not in the first 400", not "not present", and the difference has to be
  // visible. Ablation: dropping the `hits.length >= LIMIT` branch turns this red.
  test("a fetch that fills the page is recorded as truncated", () => {
    const full = Array.from({ length: 400 }, (_, i) => ({ number: i + 1, body: `<!-- sm-dedup:unrelated-key-${i} -->` }));
    const gh: GhRunner = (args) => {
      if (args[0] === "issue" && args[1] === "list") {
        return { stdout: args.includes("--search") ? "[]" : JSON.stringify(full), exitCode: 0 };
      }
      if (args[0] === "issue" && args[1] === "create") return { stdout: "https://x/y/issues/1\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    };
    const dir = tmp();
    fileFinding(gh, dir, finding("pr-83-red-ci-stalled"));
    expect(logLines(dir)[0]!.nearMatch).toBe("truncated");
  });
});

// --- the consumer ------------------------------------------------------------

describe("groom-report (the consumer)", () => {
  // Catches: a report that buries today's pile under July's. The operator reads
  // the top of this output, so newest cluster first, and within a cluster the
  // survivor suggestion must be the OLDEST issue — where the conversation and
  // any human triage already live.
  test("clusters print newest-first; the suggested canonical is the oldest member", () => {
    const clusters = clusterItems(asItems([...PR83, ...STATE_MD, PR40]));
    const newest = clusters.map((c) => c.members[0]!.number);
    expect(newest).toEqual([...newest].sort((a, b) => b - a));
    for (const c of clusters) {
      expect(c.canonical.number).toBe(Math.min(...c.members.map((m) => m.number)));
      expect(c.members.map((m) => m.number)).toEqual([...c.members.map((m) => m.number)].sort((a, b) => b - a));
    }
  });

  // Catches: a "new since last run" count that just re-reports every cluster
  // forever (useless) or counts a GROWING cluster as new (noise). The canonical
  // is the stable identity: adding #900 to a cluster does not make it new.
  test("clusters formed since the last run counts only genuinely new canonicals", () => {
    const before = clusterItems(asItems(STATE_MD));
    expect(newCanonicals(before, [])).toEqual([before[0]!.canonical.number]);
    expect(newCanonicals(before, before.map((c) => c.canonical.number))).toEqual([]);
    // The STATE.md cluster grows by one; still not a new cluster.
    const grown = clusterItems(asItems([...STATE_MD, [900, "state-md-stale-11d"]]));
    expect(grown[0]!.members.length).toBe(STATE_MD.length + 1);
    expect(newCanonicals(grown, before.map((c) => c.canonical.number))).toEqual([]);
    // A genuinely different pile IS new.
    const withPr83 = clusterItems(asItems([...STATE_MD, ...PR83]));
    expect(newCanonicals(withPr83, before.map((c) => c.canonical.number)).length).toBe(2);
  });

  // Catches: the report and the filer drifting to two different marker readers,
  // which would make the report describe a backlog the filer cannot see.
  test("the report reads the dedup marker through the filer's own function", () => {
    const body = "some finding text\n\n<!-- sm-dedup:pr-83-red-ci-stalled -->\nfiled-by: scheduler/standup cycle x\n";
    expect(readDedupKey(body)).toBe("pr-83-red-ci-stalled");
    expect(readDedupKey("no marker here")).toBeUndefined();
    expect(readDedupKey("<!-- sm-dedup:pipeline_idle_wave_ready -->")).toBe("pipeline_idle_wave_ready"); // legacy keys still read
  });
});
