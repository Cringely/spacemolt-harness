// Batch C / Task C4 (#114): the charter/brief ↔ job-table spanning test.
// Two files must agree with no shared schema forcing it (a seam): the charter
// or brief a job arms, and the JOBS row that spawns it. Presence-gated with
// the docsPresent skipIf pattern (test/doc-size.test.ts) — the container
// image excludes docs/ by design (L-20/#130 class).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JOBS } from "../src/scheduler/jobs";

const root = join(import.meta.dir, "..");
const docsPresent = existsSync(join(root, "docs", "charters"));

// First non-empty line under `## Tier` — the charters' shape is "Model, effort — why".
function tierLine(md: string): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Tier");
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("#")) return null; // empty Tier section
    if (line !== "") return line;
  }
  return null;
}

describe.skipIf(!docsPresent)("scheduler charters/briefs spanning test (C4)", () => {
  // Catches: a renamed charter arming an EMPTY identity at 2h cadence — the
  // spawn would read "" and run a charterless agent every fire.
  test("every JOBS charter/brief path exists and is non-empty", () => {
    for (const job of JOBS) {
      const p = join(root, job.charterPath);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, "utf8").trim().length).toBeGreaterThan(0);
    }
  });

  // Catches: a charter tier change (the operator's model-pin lever) silently
  // not mirrored into the scheduler = wrong spend on every fire.
  test("each charter/brief `## Tier` line names the same model family as JOBS[i].model", () => {
    const families = ["haiku", "sonnet"] as const;
    for (const job of JOBS) {
      const line = tierLine(readFileSync(join(root, job.charterPath), "utf8"));
      expect(line).not.toBe(null);
      const lower = (line as string).toLowerCase();
      expect(lower.includes(job.model)).toBe(true);
      // The line must be UNAMBIGUOUS — naming both families would let the
      // seam drift while the inclusion check still passes.
      for (const other of families) {
        if (other !== job.model) expect(lower.includes(other)).toBe(false);
      }
    }
  });

  // Catches: a charter/brief's INSTRUCTIONS reintroducing a dead filing/report
  // form (#114). Findings and reports now carry the body as a single-line
  // `--body-b64` argv token; the `--body-file` outbox jail and the STDIN/heredoc
  // form are both denied headless (no fleet tool could write the outbox file;
  // the permission layer splits a Bash command on newlines). scheduler-spawn's
  // work-order test runs the same STDIN/`<<` check on the spawn.ts template, but
  // only sees stubbed strings — this pins the REAL charter/brief files, closing
  // the seam-manifest entry-9 gap. Scoped to the instruction body: a
  // `## CHANGELOG` may legitimately name the old forms as history, not instruction.
  test("no charter/brief instructs a dead filing/report form (--body-file, STDIN, heredoc)", () => {
    for (const job of JOBS) {
      const instructions = readFileSync(join(root, job.charterPath), "utf8").split(/^## CHANGELOG/m)[0]!;
      expect(instructions).not.toContain("--body-file");
      expect(instructions).not.toContain("STDIN");
      expect(instructions).not.toContain("<<");
    }
  });
});
