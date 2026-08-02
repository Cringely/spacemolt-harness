// Regression guard for the frontmatter key on .claude/agents/*.md: it is
// `effort`, not `reasoning_effort`. An unrecognized frontmatter key is
// ignored silently by the agent runtime — no error, no warning — so a
// mis-keyed def just runs at inherited session effort forever (PR #59).
//
// This is the SECOND occurrence of the identical typo class: upstream
// agent-harness-core carried it too, fixed in b91a087. AGENTS.md's
// invariant-promotion rule says a failure class appearing twice earns a
// permanent constraint, not another manual rename — this test is that
// constraint.
//
// Three independent failure modes, each its own assertion so a future
// regression names which one broke and where:
//   1. `reasoning_effort:` anywhere in a def — the direct typo this PR fixes.
//   2. `effort:` on a `model: haiku` def — the key parses fine but does
//      nothing: Haiku has no effort support at all (core's b91a087 commit
//      message: "Haiku 4.5 turns out not to support the parameter"). Carrying
//      it reads as configured behavior and is inert, which is worse than
//      carrying nothing.
//   3. `effort:` with a value outside the known set — a typo'd VALUE is just
//      as silent as a typo'd key.
//
// Pattern follows test/doc-size.test.ts: assert directly over checked-in
// markdown text, no agent runtime, no mocking a consumer. The frontmatter
// regex shape matches the one already shipped in
// .claude/hooks/agent-write-scope.ts's readWriteScope().

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const AGENTS_DIR = join(root, ".claude", "agents");

/** Every effort tier the runtime actually recognizes (model-config docs). */
const KNOWN_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface AgentDef {
  file: string;
  model: string | null;
  effort: string | null;
  hasReasoningEffortKey: boolean;
}

/** Parse the fields this guard cares about out of one agent def's frontmatter. */
export function parseAgentDef(file: string, content: string): AgentDef {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return {
    file,
    model: frontmatter.match(/^model:\s*(\S+)\s*$/m)?.[1] ?? null,
    effort: frontmatter.match(/^effort:\s*(\S+)\s*$/m)?.[1] ?? null,
    hasReasoningEffortKey: /^reasoning_effort:/im.test(frontmatter),
  };
}

function loadDefs(): AgentDef[] {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  return files.map((f) => parseAgentDef(f, readFileSync(join(AGENTS_DIR, f), "utf8")));
}

describe("agent defs: effort frontmatter key regression guard", () => {
  const defs = loadDefs();

  // Sanity check the fixture load itself found real files — an empty glob
  // would make every offender-list assertion below pass for the wrong reason.
  test("setup: at least one real agent def is loaded", () => {
    expect(defs.length).toBeGreaterThan(0);
  });

  test("no agent def carries reasoning_effort, in any casing", () => {
    const offenders = defs.filter((d) => d.hasReasoningEffortKey).map((d) => d.file);
    expect(offenders).toEqual([]);
  });

  test("no haiku-model def carries an effort key — Haiku has no effort support", () => {
    const offenders = defs
      .filter((d) => d.model === "haiku" && d.effort !== null)
      .map((d) => `${d.file} (effort: ${d.effort})`);
    expect(offenders).toEqual([]);
  });

  test("every declared effort value is from the known set", () => {
    const offenders = defs
      .filter((d) => d.effort !== null && !KNOWN_EFFORT_VALUES.has(d.effort))
      .map((d) => `${d.file} (effort: ${d.effort})`);
    expect(offenders).toEqual([]);
  });
});
