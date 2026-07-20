// Seam 10 (#seam-manifest): council brief §Triage ↔ soc-monitor step 3.
// The council brief PRODUCES a `## Triage` section in its dated report; the
// stand-up charter CONSUMES "council ordering" from that exact section name
// and reports path. No schema forces the two prose files to agree — this test
// does. Presence-gated with the docsPresent skipIf pattern (the container
// image excludes docs/ by design, L-20/#130 class).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const docsPresent = existsSync(join(root, "docs", "charters"));

describe.skipIf(!docsPresent)("triage ordering seam (council brief ↔ soc-monitor)", () => {
  const brief = () =>
    readFileSync(join(root, "docs", "briefs", "council-review.md"), "utf8");
  const charter = () =>
    readFileSync(join(root, "docs", "charters", "soc-monitor.md"), "utf8");

  // Catches: renaming the producer's section (say `## Priorities`) while the
  // consumer still greps reports for `## Triage` — stand-up silently falls
  // back to bare backlog order on every run and nobody notices the ceremony
  // stopped steering.
  test("council brief instructs producing a `## Triage` report section", () => {
    expect(brief()).toContain("## Triage");
    expect(brief()).toMatch(/`## Triage` section/);
  });

  test("soc-monitor names the same section and the reports path as its ordering source", () => {
    const c = charter();
    expect(c).toMatch(/`## Triage` section/);
    expect(c).toContain("$SCHEDULER_STATE_DIR/reports/");
    expect(c).toContain("council-review.md");
  });

  // Catches: the consumer losing its staleness fallback — an ordering source
  // with no expiry would let a week-old triage silently outrank fresh epics.
  test("soc-monitor keeps a staleness fallback on the triage source", () => {
    expect(charter()).toMatch(/48h/);
  });
});
