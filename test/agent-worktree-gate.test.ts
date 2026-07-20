// Offline tests for the #192 worktree-isolation PreToolUse gate
// (.claude/hooks/agent-worktree-gate.ts). Unit tests hit the exported pure
// decide(); spawn tests pin the stdin→stdout hook contract (deny JSON shape,
// exit codes, fail-open). No network, no repo mutation (temp dirs only).
//
// Classification is derived from .claude/agents/*.md frontmatter (PR #201
// REVISE), so several tests read the real repo definitions on purpose: if a
// role's tool grant changes, the gate's behavior changes, and these tests
// should say so.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, OVERRIDE_TOKEN } from "../.claude/hooks/agent-worktree-gate";

const dispatch = (tool_input: Record<string, unknown>) => ({
  tool_name: "Agent",
  tool_input,
});

// Synthetic agents dir for cases the real repo can't (safely) provide.
const fakeAgentsDir = mkdtempSync(join(tmpdir(), "worktree-gate-test-"));
// Provably read-only frontmatter.
writeFileSync(
  join(fakeAgentsDir, "readonly-role.md"),
  "---\nname: readonly-role\ntools: Read, Grep, Glob\nmodel: haiku\n---\ncharter text\n",
);
// Restricted, but includes a tool NOT on the read-only allowlist.
writeFileSync(
  join(fakeAgentsDir, "shelly-role.md"),
  "---\nname: shelly-role\ntools: Read, PowerShell\n---\ncharter text\n",
);
// A directory where a definition file should be: existsSync true, read throws.
mkdirSync(join(fakeAgentsDir, "broken-role.md"));
afterAll(() => rmSync(fakeAgentsDir, { recursive: true, force: true }));

describe("decide() — derived classification", () => {
  test("denies doc-steward without isolation (no tools: field = all tools)", () => {
    const d = decide(dispatch({ subagent_type: "doc-steward", prompt: "reconcile docs" }));
    expect(d.action).toBe("deny");
    if (d.action === "deny") expect(d.reason).toContain('isolation: "worktree"');
  });

  test("denies docker-expert — the #201 drift bypass (frontmatter grants Write/Edit/Bash)", () => {
    expect(decide(dispatch({ subagent_type: "docker-expert", prompt: "x" })).action).toBe("deny");
  });

  test("denies adversarial-reviewer — read-only-by-prose is not read-only-by-grant", () => {
    expect(decide(dispatch({ subagent_type: "adversarial-reviewer", prompt: "x" })).action).toBe(
      "deny",
    );
  });

  test("exempts a role whose frontmatter is provably read-only (security-auditor: Read, Grep, Glob)", () => {
    expect(decide(dispatch({ subagent_type: "security-auditor", prompt: "audit" })).action).toBe(
      "allow",
    );
  });

  test("exempts the read-only built-ins Explore and Plan", () => {
    for (const subagent_type of ["Explore", "plan"]) {
      expect(decide(dispatch({ subagent_type, prompt: "look around" })).action).toBe("allow");
    }
  });

  test("denies an unknown type — no definition file is not evidence it is read-only", () => {
    expect(decide(dispatch({ subagent_type: "brand-new-role", prompt: "x" })).action).toBe("deny");
  });

  test("omitted subagent_type defaults to general-purpose and is denied (no omission bypass)", () => {
    expect(decide(dispatch({ prompt: "implement the thing" })).action).toBe("deny");
  });

  test("unreadable definition file ⇒ that type requires isolation, not hook fail-open", () => {
    expect(
      decide(dispatch({ subagent_type: "broken-role", prompt: "x" }), fakeAgentsDir).action,
    ).toBe("deny");
  });

  test("a restricted grant with a non-allowlisted tool (PowerShell) still requires isolation", () => {
    // Guards the allowlist shape: a write-token deny-list would wrongly exempt this.
    expect(
      decide(dispatch({ subagent_type: "shelly-role", prompt: "x" }), fakeAgentsDir).action,
    ).toBe("deny");
  });

  test("synthetic read-only frontmatter is exempt (parse path, independent of repo roles)", () => {
    expect(
      decide(dispatch({ subagent_type: "readonly-role", prompt: "x" }), fakeAgentsDir).action,
    ).toBe("allow");
  });

  test("allows a repo-writing dispatch with isolation worktree or remote", () => {
    for (const isolation of ["worktree", "remote"]) {
      expect(
        decide(dispatch({ subagent_type: "doc-steward", isolation, prompt: "x" })).action,
      ).toBe("allow");
    }
  });

  test("prompt text mentioning isolation does not satisfy the gate (grep-regression guard)", () => {
    const d = decide(
      dispatch({
        subagent_type: "general-purpose",
        prompt: 'always dispatch stewards with isolation: "worktree" set',
      }),
    );
    expect(d.action).toBe("deny");
  });

  test("bare override token with no reason is rejected (#201 finding 3)", () => {
    for (const prompt of [OVERRIDE_TOKEN, `do the thing. ${OVERRIDE_TOKEN}   `]) {
      expect(decide(dispatch({ subagent_type: "doc-steward", prompt })).action).toBe("deny");
    }
  });

  test("override token with a written reason allows a conscious non-isolated dispatch", () => {
    const d = decide(
      dispatch({
        subagent_type: "doc-steward",
        prompt: `${OVERRIDE_TOKEN} steward must commit onto this branch deliberately`,
      }),
    );
    expect(d.action).toBe("allow");
  });

  test("other tools and unrecognizable payloads are allowed (fail-open)", () => {
    expect(decide({ tool_name: "Bash", tool_input: { subagent_type: "doc-steward" } }).action).toBe("allow");
    expect(decide(null).action).toBe("allow");
    expect(decide({ tool_name: "Agent", tool_input: "not-an-object" }).action).toBe("allow");
    expect(decide(dispatch({ subagent_type: 42 })).action).toBe("allow");
  });
});

describe("hook stdin→stdout contract", () => {
  const script = `${import.meta.dir}/../.claude/hooks/agent-worktree-gate.ts`;

  const runHook = (stdin: string) => {
    const r = Bun.spawnSync({
      cmd: [process.execPath, script],
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("blocked case: emits PreToolUse deny JSON, exit 0", () => {
    const { code, out } = runHook(
      JSON.stringify(dispatch({ subagent_type: "doc-steward", prompt: "reconcile" })),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("#192");
  });

  test("allowed case: no stdout, exit 0", () => {
    const { code, out } = runHook(
      JSON.stringify(dispatch({ subagent_type: "doc-steward", isolation: "worktree" })),
    );
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("malformed stdin: fail-open — no stdout, logs to stderr, exit 0", () => {
    const { code, out, err } = runHook("this is not json {");
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toContain("allowing dispatch");
  });
});
