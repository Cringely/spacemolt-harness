// Documentation concision gates. The living docs are read by a human operator
// steering remotely, so their SIZE is a feature, not a side-effect: a decision
// log that reads like a novel is one nobody re-reads, and a handoff block that
// runs 1,800 words hides the three facts the next session actually needs.
//
// The gates here are PER-UPDATE, deliberately: a cap on the unit a writer
// actually adds (one decisions entry, one refresh of the NOW block), never on
// the accumulated whole file. Whole-file byte thresholds never caught the real
// drift anyway — decisions.md grew to 136 KB one 700-word essay at a time while
// every individual entry looked "fine" — and a whole-file cap fails the build
// for the person who writes a legitimate 200-word entry that happens to tip the
// file over, which is a gate punishing the wrong author. Operator ruling
// (2026-07-14): "a cap per update is more appropriate." So whole-file size is a
// doc-steward ARCHIVAL TRIGGER (charter step 7: decisions.md > 150 KB → archive
// the oldest entries to docs/archive/), and wiki page size is steward judgment
// plus prose-lint — neither is a `bun test` failure. What IS a test is the unit
// of work, the same convention as roadmap-drift.test.ts: an over-long NEW
// entry is a red build, not a reviewer's judgment call.
//
// Container-context gate (same convention as roadmap-drift.test.ts): the
// .dockerignore excludes docs/ from the image BY DESIGN, so inside the image
// build these inputs are absent — skip there. Every developer `bun test` and
// the repo CI still run the gates. This is the L-20/#130 class: a test whose
// DATA inputs live outside the image's copy path must presence-gate, never
// silently pass on a missing file.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const DECISIONS = join(root, "docs/decisions.md");
const STATE = join(root, "docs/STATE.md");

const docsPresent = existsSync(DECISIONS) && existsSync(STATE);

// --- caps -------------------------------------------------------------------

/**
 * Per-ENTRY cap for docs/decisions.md, in words (heading included).
 *
 * Derived from the 2026-07-14 slimming pass, not guessed: the five worst
 * entries were rewritten down to their irreducible content — the context, EVERY
 * rejected option with its tradeoff, the decision, and the receipts — and they
 * land at 390-400 words. Below 400 you have to delete either a rejected option
 * or a receipt, and those are the log's entire value. So 400 is the measured
 * floor for the HARDEST entry (four options + caveats), not the target: a
 * typical decision fits in 200-300, and the shortest good entry in the log
 * is 294. Treat 400 as the ceiling that fires, and 300 as the habit.
 */
export const DECISION_ENTRY_WORD_CAP = 400;

/** Cap for the `## NOW` handoff block in docs/STATE.md, in words. */
export const STATE_NOW_WORD_CAP = 500;

/**
 * Entries that predate these rules — exempt from BOTH the word cap and the
 * required shape, because both landed after they were written. This is a
 * RATCHET, not an amnesty: the list may only ever shrink. Three tests keep it
 * honest — a listed entry that no longer exists fails (so a rename cannot
 * smuggle in a new essay), a listed entry that now COMPLIES fails until it is
 * removed (so slimming one forces the exemption to be surrendered), and a key
 * matching two entries fails rather than silently exempting the wrong one.
 * New entries get no exemption at all.
 *
 * The cap is a brevity gate, never a content gate: it may cost an entry its
 * narrative, its repetition, and its self-congratulation, and it may never cost
 * a rejected OPTION, a RECEIPT for a new primitive, or a DESIGN DETAIL. Four
 * entries below (jettison, Batch 0/A/B) were slimmed hard and then had exactly
 * that material restored (PR #236 review), which put them back over 400 words.
 * They are grandfathered rather than re-gutted. That precedence is the rule: if
 * the cap and a receipt ever collide again, the receipt wins and the entry lands
 * here.
 *
 * Each string must match exactly one `## ` heading in decisions.md.
 */
export const LEGACY_EXEMPT: readonly string[] = [
  // 2026-07-12 cluster archived to docs/archive/decisions-2026-07-12.md
  // (2026-07-17): its keys were removed here per the ratchet — the list only
  // shrinks, and archival is a valid exit alongside slimming.
  "Checking mining preconditions deterministically",
  "The mission funnel was structurally dead",
  "Community-harness evaluation #2",
  "Security frameworks: adopt SSDF",
  "Catalog-gated jettison + market-aware disposal",
  "Worktree-isolation gate",
  "Buyable-here market surfacing",
  "Scorecard + gitleaks + compose drift-check",
  "The healthcheck was a caller too",
  "The README gets the gate-path picture",
  "Image provenance: key-based cosign signing",
  "The planner kept aiming at things it could not touch",
  // Landed on main while this gate's PR (#236) was still open — written before
  // the cap existed, and its length is the review-correction story + receipts.
  "The pilot could not spend its money",
  // Under the word cap already, but written before the required shape existed.
  "The main seat is an Orchestrator",
  "Dashboard second auth barrier",
];

// --- parsing ----------------------------------------------------------------

export interface Entry {
  heading: string;
  body: string;
  words: number;
}

/** Split a decision log into its `## ` entries. Fails loudly on an empty log. */
export function parseEntries(md: string): Entry[] {
  const lines = md.split("\n");
  const starts = lines.flatMap((l, i) => (l.startsWith("## ") ? [i] : []));
  if (starts.length === 0) throw new Error("decisions.md: no `## ` entries found");
  return starts.map((start, n) => {
    const end = starts[n + 1] ?? lines.length;
    const body = lines.slice(start, end).join("\n");
    return {
      heading: lines[start]!.slice(3).trim(),
      body,
      words: body.split(/\s+/).filter(Boolean).length,
    };
  });
}

/** Extract the `## NOW` block from STATE.md. Fails loudly if it is missing. */
export function parseNowBlock(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## NOW"));
  if (start < 0) throw new Error("STATE.md: `## NOW` block not found");
  const rest = lines.slice(start + 1).findIndex((l) => l.startsWith("## "));
  const end = rest < 0 ? lines.length : start + 1 + rest;
  return lines.slice(start, end).join("\n");
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

// --- gates ------------------------------------------------------------------

/**
 * The required shape, as line-anchored bold section labels: an options section
 * (terse bullets — the option, its tradeoff, the verdict) and a decision.
 *
 * Anchoring matters. An unanchored `\*\*[^*]*option` matches ACROSS paragraphs,
 * because the `[^*]` class eats newlines — it would pass an entry that merely
 * says "was never an option" in running prose. The label must open a line.
 *
 * The shape IS the concision mechanism. An entry with no options section is a
 * narrative, and a narrative is what the cap exists to stop. AGENTS.md allows
 * "only one option was genuinely considered" — say that under the heading; the
 * heading still ships.
 */
export function hasRequiredShape(body: string): boolean {
  return /^\*\*[^*\n]*options?/im.test(body) && /^\*\*[^*\n]*decisions?/im.test(body);
}

export const isCompliant = (e: Entry): boolean =>
  e.words <= DECISION_ENTRY_WORD_CAP && hasRequiredShape(e.body);

describe.skipIf(!docsPresent)("decisions.md: per-entry concision gate", () => {
  // bun executes describe BODIES even when skipIf skips the tests, so this
  // read must be presence-gated itself (roadmap-drift.test.ts convention) —
  // an unguarded readFileSync here throws ENOENT inside the container image,
  // where .dockerignore excludes docs/ by design.
  const entries = docsPresent ? parseEntries(readFileSync(DECISIONS, "utf8")) : [];
  const isLegacy = (h: string) => LEGACY_EXEMPT.some((k) => h.includes(k));

  test(`no new entry exceeds ${DECISION_ENTRY_WORD_CAP} words`, () => {
    const offenders = entries
      .filter((e) => !isLegacy(e.heading) && e.words > DECISION_ENTRY_WORD_CAP)
      .map((e) => `${e.words}w — ${e.heading}`);
    expect(offenders).toEqual([]);
  });

  test("every new entry carries the required shape (options + decision)", () => {
    const offenders = entries
      .filter((e) => !isLegacy(e.heading) && !hasRequiredShape(e.body))
      .map((e) => e.heading);
    expect(offenders).toEqual([]);
  });

  test("ratchet: every legacy key still matches exactly one entry", () => {
    // A key that matches nothing (renamed/deleted entry) or two entries (an
    // ambiguous substring silently exempting the wrong one) fails loudly rather
    // than quietly widening the amnesty.
    const bad = LEGACY_EXEMPT.filter(
      (k) => entries.filter((e) => e.heading.includes(k)).length !== 1,
    ).map((k) => `${k} (matched ${entries.filter((e) => e.heading.includes(k)).length})`);
    expect(bad).toEqual([]);
  });

  test("ratchet: a legacy entry that now complies must surrender its exemption", () => {
    // The list may only ever SHRINK. Once an entry is cut under the cap and
    // given the shape, its key must come off this list — otherwise a stale
    // exemption would let a future edit quietly re-inflate it to essay length.
    const graduated = LEGACY_EXEMPT.filter((k) => {
      const e = entries.find((x) => x.heading.includes(k));
      return e !== undefined && isCompliant(e);
    });
    expect(graduated).toEqual([]);
  });
});

describe.skipIf(!docsPresent)("STATE.md: the NOW handoff block stays a handoff", () => {
  test(`the NOW block is at most ${STATE_NOW_WORD_CAP} words`, () => {
    const words = countWords(parseNowBlock(readFileSync(STATE, "utf8")));
    // Not a style preference: the NOW block is what a remote operator reads to
    // learn where the project stands. Past ~500 words it stops being status and
    // starts being history, and history has a file (docs/milestones.md).
    expect(words).toBeLessThanOrEqual(STATE_NOW_WORD_CAP);
  });
});

// Deliberately NOT gated here (operator ruling, 2026-07-14): whole-file size for
// decisions.md/STATE.md, and per-page size for docs/wiki/*.md. Those are
// accumulated totals, not units of work — a byte cap on them red-builds whoever
// writes the legitimate entry that tips the file over, and it forces a wiki
// split on a schedule the content did not ask for. Whole-file growth is a
// doc-steward ARCHIVAL TRIGGER instead (charter step 7), and page size is
// steward judgment. Both are cheap to fix when the steward decides; neither is
// worth failing a build a contributor cannot reasonably avoid.

// --- parser contract (fail loudly, never silently pass) ----------------------

describe("the size-gate parsers fail loudly", () => {
  test("a decision log with no entries throws instead of reporting zero offenders", () => {
    expect(() => parseEntries("# Decision Log\n\nnothing here\n")).toThrow(/no `## ` entries/);
  });

  test("a STATE.md with no NOW block throws instead of passing an empty string", () => {
    expect(() => parseNowBlock("# Project State\n\n## Where we are\n")).toThrow(/`## NOW`/);
  });

  test("word counting collapses runs of whitespace and blank lines", () => {
    // "##" "Title" "here" + "one" "two" "three" — a doubled space or a stray
    // blank line must not buy an entry extra headroom against the cap.
    const [entry] = parseEntries("## Title here\n\n\none   two\tthree\n");
    expect(entry!.words).toBe(6);
  });
});
