// Offline tests for the scratch-scope PreToolUse gate
// (.claude/hooks/agent-write-scope.ts). Unit tests hit the exported pure
// inScratch()/decide()/readWriteScope(); spawn tests pin the stdin->stdout
// hook contract (deny JSON shape, exit codes, fail-open). No network, no
// mutation of the real repo (temp dirs only, except the read-only scan
// below).
//
// Every installed agent in .claude/agents/ today has no writeScope key
// EXCEPT research-scout, so a regression that turns the no-writeScope case
// into a deny would block writes for every other subagent dispatched in this
// project. That case gets its own test reading the REAL repo definitions,
// not just a synthetic fixture, so a future agent addition is covered
// automatically rather than by a hand-maintained list.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, inScratch, readWriteScope } from "../.claude/hooks/agent-write-scope";

const CWD = "/home/runner/project";
const REPO_ROOT = join(import.meta.dir, "..");
const REAL_AGENTS_DIR = join(REPO_ROOT, ".claude", "agents");

describe("inScratch() — path classification", () => {
  test.each([
    "/tmp/claude/proj/sess/scratchpad/report.md",
    "C:\\Users\\me\\AppData\\Local\\Temp\\claude\\proj\\sess\\scratchpad\\findings.md",
    "/home/runner/project/.scratch/notes.md",
    "scratchpad/relative.md",
    "/tmp/SCRATCHPAD/case-insensitive.md",
  ])("in scope: %s", (p) => {
    expect(inScratch(p, CWD)).toBe(true);
  });

  test.each([
    "/home/runner/project/src/index.ts",
    "C:\\Users\\me\\.claude\\rules\\agent-usage.md",
    "docs/STATE.md",
    "/etc/hosts",
    // Traversal out of a scratch dir resolves away from it, so it must not pass.
    "/tmp/scratchpad/../../etc/passwd",
    // A file merely NAMED scratchpad is not a scratch directory.
    "/home/runner/project/scratchpad.md",
  ])("out of scope: %s", (p) => {
    expect(inScratch(p, CWD)).toBe(false);
  });

  test("relative paths resolve against cwd, not the filesystem root", () => {
    expect(inScratch("../.scratch/x.md", "/home/runner/project/sub")).toBe(true);
    expect(inScratch("../src/x.ts", "/home/runner/project/sub")).toBe(false);
  });
});

describe("readWriteScope() — derived from agent frontmatter, never a hand-list", () => {
  const fakeProject = mkdtempSync(join(tmpdir(), "write-scope-readfm-"));
  const fakeAgentsDir = join(fakeProject, ".claude", "agents");
  mkdirSync(fakeAgentsDir, { recursive: true });
  writeFileSync(
    join(fakeAgentsDir, "scratchy.md"),
    "---\nname: scratchy\nwriteScope: scratch\n---\ncharter text\n",
  );
  writeFileSync(
    join(fakeAgentsDir, "unscoped.md"),
    "---\nname: unscoped\ntools: Read, Write\n---\ncharter text\n",
  );
  // No frontmatter shape at all (no colon-delimited key: value line, no
  // fences) plus embedded NUL/control bytes — readWriteScope reads with utf8
  // decoding (lossy, never throws) and its regex is a plain line match with
  // no fence-awareness, so "unparseable" here means content the regex simply
  // does not match, not a parse error.
  writeFileSync(
    join(fakeAgentsDir, "garbage.md"),
    Buffer.from("not even frontmatter shaped\nrandom prose\x00\x01\x02 binary junk\n"),
  );
  // A key with no colon is not a match either — confirms the reader requires
  // the exact `writeScope:` shape rather than fuzzy-matching the word.
  writeFileSync(join(fakeAgentsDir, "no-colon.md"), "---\nwriteScope scratch\n---\ncharter text\n");
  afterAll(() => rmSync(fakeProject, { recursive: true, force: true }));

  test("declares scratch", () => {
    expect(readWriteScope("scratchy", fakeProject)).toBe("scratch");
  });

  test("no writeScope key ⇒ null (no opinion), not a default", () => {
    expect(readWriteScope("unscoped", fakeProject)).toBeNull();
  });

  test("missing definition file ⇒ null", () => {
    expect(readWriteScope("nonexistent-role", fakeProject)).toBeNull();
  });

  test("empty agentType ⇒ null without touching the filesystem", () => {
    expect(readWriteScope("", fakeProject)).toBeNull();
  });

  test("unparseable content (no key:value shape, embedded binary junk) ⇒ null, no throw", () => {
    expect(readWriteScope("garbage", fakeProject)).toBeNull();
  });

  test("key without a colon does not fuzzy-match ⇒ null", () => {
    expect(readWriteScope("no-colon", fakeProject)).toBeNull();
  });

  // The live regression guard: scan every agent definition actually shipped
  // in this repo. If a future PR adds `writeScope: scratch` to a role other
  // than research-scout without reading this test, it fails here and says so
  // — the alternative, a hand-maintained "these roles are unscoped" list,
  // drifts the first time someone forgets to update it.
  test("every real agent def in .claude/agents/ is unscoped except research-scout", () => {
    const files = readdirSync(REAL_AGENTS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const agentType = file.replace(/\.md$/, "");
      const scope = readWriteScope(agentType, REPO_ROOT);
      if (agentType === "research-scout") {
        expect(scope).toBe("scratch");
      } else {
        expect(scope).toBeNull();
      }
    }
  });
});

describe("decide() — only scratch-scoped agents are gated", () => {
  test("scoped agent writing outside scratch is denied", () => {
    const verdict = decide("scratch", "/home/runner/project/src/index.ts", CWD);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") {
      expect(verdict.reason).toContain("writeScope: scratch");
    }
  });

  test("scoped agent writing inside scratch is allowed", () => {
    expect(decide("scratch", "/tmp/claude/s/scratchpad/r.md", CWD)).toEqual({
      action: "allow",
    });
  });

  // This is the case the reviewer flagged as highest-stakes: every installed
  // agent except research-scout has no writeScope key, so scope arrives here
  // as null. A regression that starts gating null the same as "scratch"
  // blocks every write in every other subagent — the no-op must hold
  // regardless of where the write targets.
  test.each([null, "repo", ""])(
    "unscoped agent (%p) is untouched even for a write far outside any scratch dir",
    (scope) => {
      expect(decide(scope, "/home/runner/project/src/index.ts", CWD)).toEqual({
        action: "allow",
      });
    },
  );

  test("main session (no agent_type, so no scope) is untouched", () => {
    expect(decide(null, "/anywhere/at/all.md", CWD)).toEqual({ action: "allow" });
  });

  test("missing file_path allows rather than crashing — fail open", () => {
    expect(decide("scratch", undefined, CWD)).toEqual({ action: "allow" });
  });
});

describe("hook stdin→stdout contract", () => {
  const script = `${import.meta.dir}/../.claude/hooks/agent-write-scope.ts`;

  const runHook = (stdin: string, env?: Record<string, string>) => {
    const r = Bun.spawnSync({
      cmd: [process.execPath, script],
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  const fakeProject = mkdtempSync(join(tmpdir(), "write-scope-spawn-"));
  const fakeAgentsDir = join(fakeProject, ".claude", "agents");
  mkdirSync(fakeAgentsDir, { recursive: true });
  writeFileSync(
    join(fakeAgentsDir, "scratchy.md"),
    "---\nname: scratchy\nwriteScope: scratch\n---\ncharter text\n",
  );
  afterAll(() => rmSync(fakeProject, { recursive: true, force: true }));

  test("blocked case: emits PreToolUse deny JSON, exit 0", () => {
    const { code, out } = runHook(
      JSON.stringify({
        agent_type: "scratchy",
        cwd: fakeProject,
        tool_input: { file_path: join(fakeProject, "src", "index.ts") },
      }),
      { CLAUDE_PROJECT_DIR: fakeProject },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("writeScope: scratch");
  });

  test("allowed case: write inside scratch, no stdout, exit 0", () => {
    const { code, out } = runHook(
      JSON.stringify({
        agent_type: "scratchy",
        cwd: fakeProject,
        tool_input: { file_path: join(fakeProject, "scratchpad", "report.md") },
      }),
      { CLAUDE_PROJECT_DIR: fakeProject },
    );
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("fail-open: agent has no writeScope key — no stdout, exit 0", () => {
    const { code, out } = runHook(
      JSON.stringify({
        agent_type: "does-not-exist-at-all",
        cwd: fakeProject,
        tool_input: { file_path: join(fakeProject, "src", "index.ts") },
      }),
      { CLAUDE_PROJECT_DIR: fakeProject },
    );
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("fail-open: malformed stdin — no stdout, logs to stderr, exit 0", () => {
    const { code, out, err } = runHook("this is not json {");
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toContain("agent-write-scope:");
  });

  test("fail-open: no agent_type on the payload (main session) — no stdout, exit 0", () => {
    const { code, out } = runHook(
      JSON.stringify({ cwd: fakeProject, tool_input: { file_path: "/anywhere/at/all.md" } }),
      { CLAUDE_PROJECT_DIR: fakeProject },
    );
    expect(code).toBe(0);
    expect(out).toBe("");
  });
});
