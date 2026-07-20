import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Guardrails session-start slice (issue #163, squad issue #1035's warning).
//
// The SessionStart hook (.claude/hooks/session-start-guardrails.sh) injects
// only PART of .claude/guardrails.md into every fresh context: everything
// above the `guardrails:session-start-end` marker line. Squad's #1035 is the
// failure mode this pins: a context-slim moved safety rules out of the
// always-on prompt and their coordinator promptly broke its prime directive.
// If a future edit shuffles the load-bearing blocks below our marker (or
// renames the marker on one side only), the always-on injection silently goes
// hollow -- and nothing notices, because the hook is WARN-only by design.
//
// This test replicates the hook's slice semantics (awk prints lines up to,
// but not including, the first marker line) and asserts the slice still
// carries the two load-bearing blocks guardrails.md itself declares must stay
// above the marker: the read-this-first block and the forcing-function
// hierarchy. Anchors are loose topics (#148/#161 pattern), not prose.

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Container-context gate: the Dockerfile's test stage copies src+test only
// (.dockerignore excludes .claude/ from the image BY DESIGN). When the whole
// .claude tree is absent we are inside that build — skip; repo CI is where
// this enforcement lives. A missing FILE inside an existing tree still fails
// loudly (read() throws at module load).
const claudeDirPresent = existsSync(join(root, ".claude"));

const MARKER = "guardrails:session-start-end";
const catalog = claudeDirPresent ? read(".claude/guardrails.md") : "";
const hook = claudeDirPresent ? read(".claude/hooks/session-start-guardrails.sh") : "";

// Mirror the hook: awk '/marker/ { exit } { print }' -- everything before the
// first line containing the marker.
const lines = catalog.split(/\r?\n/);
const markerIndex = lines.findIndex((l) => l.includes(MARKER));
const slice = lines.slice(0, markerIndex === -1 ? 0 : markerIndex).join("\n");

describe.skipIf(!claudeDirPresent)("guardrails session-start slice (issue #163)", () => {
  // The marker text legitimately appears twice: the comment-form cut point
  // (line ~26) and a prose mention in the hook docs further down. Awk cuts at
  // the FIRST occurrence, so the invariant is: the comment-form marker exists
  // exactly once AND is the first occurrence -- if the real marker were
  // deleted, awk would cut at the prose mention instead and silently inject
  // the wrong slice.
  test("the comment-form marker exists exactly once and is the awk cut point", () => {
    const commentMarkers = lines.filter((l) => l.startsWith("<!--") && l.includes(MARKER));
    expect(commentMarkers.length).toBe(1);
    const firstMarkerLine = lines[markerIndex];
    expect(firstMarkerLine).toBeDefined();
    expect(firstMarkerLine!.startsWith("<!--")).toBe(true);
  });

  test("the hook slices on the same marker literal (no one-sided rename)", () => {
    expect(hook).toContain(MARKER);
    // Pin the awk program itself, not just the marker: this test MIRRORS the
    // hook's slice semantics (everything before the first marker line), so if
    // the hook's awk line changes shape -- different program, inclusive cut,
    // different match -- the mirror above silently diverges from what actually
    // gets injected. Pinning the literal makes that a red test instead.
    expect(hook).toContain(
      "awk '/guardrails:session-start-end/ { exit } { print }'"
    );
  });

  test("the injected slice carries the read-this-first block", () => {
    expect(slice).toMatch(/read this first/i);
    // The meta-lesson that justifies the injection: a missed rule is a
    // harness gap, not a willpower failure.
    expect(slice).toMatch(/harness gap/i);
    expect(slice).toMatch(/forcing function/i);
  });

  test("the injected slice carries the forcing-function hierarchy, tiers in order", () => {
    const automate = slice.search(/AUTOMATE/);
    const gate = slice.search(/GATE/);
    const jit = slice.search(/JUST-IN-TIME/);
    expect(automate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(automate);
    expect(jit).toBeGreaterThan(gate);
  });
});
