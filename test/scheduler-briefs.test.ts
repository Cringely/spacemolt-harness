// Batch C / Task C4 (#114): the charter/brief ↔ job-table spanning test.
// Two files must agree with no shared schema forcing it (a seam): the charter
// or brief a job arms, and the JOBS row that spawns it. Presence-gated with
// the docsPresent skipIf pattern (test/doc-size.test.ts) — the container
// image excludes docs/ by design (L-20/#130 class).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JOBS, type JobDef } from "../src/scheduler/jobs";
import { composePrompt } from "../src/scheduler/spawn";

const root = join(import.meta.dir, "..");
const job = (id: JobDef["id"]): JobDef => JOBS.find((j) => j.id === id)!;
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
  // form (#114). The STDIN/heredoc form is denied headless (the permission layer
  // splits a Bash command on newlines), and so was the original outbox jail (no
  // fleet tool could write the outbox file). The live form is `--body-file`
  // pointing inside the job's own checkout at a file it wrote with the Write
  // tool, so the flag itself is no longer a tell: the outbox is. A shell encoder
  // (`printf ... | base64`) is the other banned form (injection, PR 171 review).
  // scheduler-spawn's work-order test runs the same checks on the spawn.ts
  // template, but only sees stubbed strings — this pins the REAL charter/brief
  // files, closing the seam-manifest entry-9 gap. Scoped to the instruction body:
  // a `## CHANGELOG` may legitimately name the old forms as history, not instruction.
  test("no charter/brief instructs a dead filing/report form (outbox, STDIN, heredoc, shell encoder)", () => {
    for (const job of JOBS) {
      const instructions = readFileSync(join(root, job.charterPath), "utf8").split(/^## CHANGELOG/m)[0]!;
      expect(instructions).not.toContain("outbox");
      expect(instructions).not.toContain("STDIN");
      expect(instructions).not.toContain("<<");
      expect(instructions).not.toContain("printf");
      expect(instructions).not.toContain("| base64");
      // The work order names the file flags, so an instruction body still
      // teaching a base64 flag would contradict it (base64 flags still work,
      // they are just no longer how a job is told to pass a body).
      expect(instructions).not.toMatch(/--(body|text|semantic)-b64/);
    }
  });

  // Catches (#495): a charter telling a job the steer lever cannot be reached,
  // after the transport shipped. That text stood from the A1 pivot (2026-07-19)
  // to #495, correct when written and silently disabling the sharpest lever
  // afterwards. Sibling of the dead-filing-form test above with ONE deliberate
  // difference: this reads the WHOLE file, changelog included. That exclusion is
  // right for filing forms (a changelog may name an old form as history) and
  // wrong here, because the charter body's ladder describes the step-1 nudge
  // without mentioning transport at all, so the changelog was the only place in
  // the charter speaking to reachability and it said unreachable. The whole file
  // is inlined verbatim ahead of the work order in every spawn.
  //
  // The failure is asymmetric, which is why it earns a test rather than a
  // reviewer's eye: an instruction NOT to attempt something fails silently. A
  // job that resolves the conflict cautiously files an issue instead, and no log
  // tells that apart from a cycle with nothing worth steering.
  test("no charter/brief tells a job the steer lever is unreachable, and strategy's names the live command", () => {
    // Exact clauses from the pre-#495 text, same shape as the --body-file
    // check above. Each one is an imperative deferral, not a historical note.
    for (const job of JOBS) {
      const charter = readFileSync(join(root, job.charterPath), "utf8");
      expect(charter).not.toContain("pending follow-up");
      expect(charter).not.toContain("use issue/note levers");
      expect(charter).not.toContain("until it lands");
    }
    // The positive half, and the one that fails if v1.6 is ever reverted: the
    // job whose ladder OWNS the steer must name the transport that serves it.
    const strategy = JOBS.find((j) => j.id === "strategy")!;
    const charter = readFileSync(join(root, strategy.charterPath), "utf8");
    expect(charter).toContain("bun scripts/strategy-store.ts steer");
    expect(charter).toContain("POST /api/store/:agentId/steer");
  });

  // Catches (Cringely/spacemolt#912, #956, #958, #962, #964, #970, #974, #979,
  // #886, #1048, #1056): the stand-up citing a PR number it never looked up. The
  // same fabricated triple (462/463/467) was filed as a "blocker" at least four
  // times, and the tracker's own issues #88/#89/#91 were once read as PRs. The
  // charter is inlined verbatim into the spawn, so these pins are the only thing
  // standing between that text and a silent revert. Instruction body only: a
  // CHANGELOG may name the rule as history.
  describe("PR claims are verified before they are cited", () => {
    const instructions = (path: string) =>
      readFileSync(join(root, path), "utf8").split(/^## CHANGELOG/m)[0]!;

    // The `-R` is load-bearing: the tracker repo shares number space with the
    // code repo, so a bare `gh pr view 88` from the wrong cwd answers for the
    // wrong repo (or not at all).
    test("soc-monitor requires a same-cycle gh pr view against the harness repo, open state only", () => {
      const c = instructions("docs/charters/soc-monitor.md");
      expect(c).toMatch(/gh pr view <N> -R Cringely\/spacemolt-harness/);
      expect(c).toMatch(/state.*`OPEN`/s);
      expect(c).toMatch(/THIS cycle/);
    });

    // Catches (#886): a PR that merged or closed since the claim was made.
    test("soc-monitor drops a claim whose PR is missing, merged or closed", () => {
      const c = instructions("docs/charters/soc-monitor.md");
      expect(c).toMatch(/`MERGED`|MERGED/);
      expect(c).toMatch(/Could not resolve to a PullRequest/);
    });

    // Catches (#1048, #1056): GitHub computes mergeability lazily, so UNKNOWN is
    // the never-queried population and must not be read as merge-ready.
    test("soc-monitor does not treat mergeable UNKNOWN as merge-ready", () => {
      const c = instructions("docs/charters/soc-monitor.md");
      expect(c).toMatch(/UNKNOWN[^\n]*NOT merge-ready/);
      expect(c).toContain("MERGEABLE");
    });

    // The council holds no gh pr grant (#490), so it cannot verify a PR and its
    // brief must say to treat the number as a claim. Pairing the prose with the
    // grant keeps them agreeing: if a gh pr grant is ever added, the sentence
    // "you hold no gh pr grant" becomes false and this fails until the brief
    // is rewritten to require the lookup instead.
    test("council brief treats a PR number as an unverified claim and the job holds no gh pr grant", () => {
      const b = instructions("docs/briefs/council-review.md");
      expect(b).toMatch(/PR number[\s\S]{0,120}unverified claim/i);
      expect(b).toMatch(/hold no `gh pr` grant/);
      const council = JOBS.find((j) => j.id === "council")!;
      expect(council.allowedTools.some((t) => t.startsWith("Bash(gh pr"))).toBe(false);
    });
  });

  // Catches (#717, #1131, #1140, #1141, #1144): council's brief Triage step
  // needs the previous report's date, and council had no command that could
  // find its own report. Same L-39 shape as the stand-up test above.
  test("council's brief names read-latest-report and the job holds the grant", () => {
    const grant = "Bash(bun scripts/read-latest-report.ts *)";
    expect(job("council").allowedTools).toContain(grant);
    const prefix = grant.slice("Bash(".length, -" *)".length);
    const brief = readFileSync(join(root, job("council").charterPath), "utf8");
    expect(brief).toContain(`${prefix} --glob '*-council-review.md'`);
    expect(job("council").allowedTools.some((t) => /^Bash\((ls|find|printenv) /.test(t))).toBe(false);
  });

  // Catches: the council report being routed to a docs/council/ commit nobody
  // can make (the job's PAT cannot push, #1130). The reports/ state dir is the
  // record; neither the brief nor the work order may ask for a pickup.
  test("council asks for no PM pickup or docs/council commit", () => {
    const prompt = composePrompt(job("council"), { charterText: "x", stateNow: "y", cycleId: "council-1" });
    expect(prompt).not.toContain("docs/council");
    expect(prompt).not.toContain("pickup");
    const brief = readFileSync(join(root, job("council").charterPath), "utf8");
    const instructions = brief.split(/^## CHANGELOG/m)[0]!;
    expect(instructions).not.toContain("docs/council");
    expect(instructions).not.toContain("pickup");
  });
});
