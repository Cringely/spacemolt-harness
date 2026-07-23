// Offline tests for the #466 chained-state-change PreToolUse gate
// (.claude/hooks/gh-chain-merge-gate.ts). Unit tests hit the exported pure
// decide()/isChainedStateChange(); spawn tests pin the stdin→stdout hook
// contract (deny JSON shape, exit codes, fail-open). No network, no repo
// mutation.
//
// The two verbatim historical strings are load-bearing regression fixtures: if
// the gate ever stops catching them, these tests fail. #236 and #465 are quoted
// exactly as they were run.

import { describe, expect, test } from "bun:test";
import { decide, isChainedStateChange, OVERRIDE_TOKEN } from "../.claude/hooks/gh-chain-merge-gate";

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

// The verbatim historical failure strings from issue #466.
const HISTORICAL = {
  // #236: a failed check's exit did not stop the merge (merged over red verify).
  pr236: "gh pr checks && gh pr merge",
  // 2026-07-20 #465: the pipe through tail replaced gh's nonzero exit with 0,
  // && passed, and the merge landed on red checks.
  pr465: "gh pr checks 465 --watch | tail -3 && gh pr merge 465",
};

describe("historical failures — the gate must always catch these", () => {
  test("#236 merge-over-red: gh pr merge after &&", () => {
    expect(decide(bash(HISTORICAL.pr236)).action).toBe("deny");
  });

  test("#465 merge-on-red via pipe-masked exit: gh pr merge after `| tail && `", () => {
    expect(decide(bash(HISTORICAL.pr465)).action).toBe("deny");
  });

  test("a `;`-separated gh merge downstream is caught", () => {
    // (The 2026-07-16 #283 incident's destructive step was a chained *git* branch
    // deletion, which this gh-verb gate deliberately does not target — see the
    // hook's scope receipt. This asserts only the `;`-operator gh case.)
    expect(decide(bash("gh pr checks 283 ; gh pr merge 283")).action).toBe("deny");
  });
});

describe("isChainedStateChange — operator coverage", () => {
  test("catches each chaining operator before a state-changer", () => {
    for (const cmd of [
      "gh pr checks && gh pr merge 5",
      "gh pr checks || gh pr merge 5",
      "echo done ; gh pr merge 5",
      "gh pr checks 5 | cat && gh pr merge 5",
      "gh pr view 5\ngh pr merge 5",
    ]) {
      expect(isChainedStateChange(cmd)).toBe(true);
    }
  });

  test("catches gh pr close and gh repo delete downstream too", () => {
    expect(isChainedStateChange("git fetch && gh pr close 5")).toBe(true);
    expect(isChainedStateChange("echo cleaning && gh repo delete owner/x --yes")).toBe(true);
  });

  test("tolerates extra whitespace between tokens", () => {
    expect(isChainedStateChange("echo x &&  gh   pr    merge 5")).toBe(true);
  });

  test("|| is one operator, not two | (does not mis-split)", () => {
    // A single `|` and a `||` both separate commands, but `||` must be consumed
    // whole so downstream detection still works — verified by the operator set.
    expect(isChainedStateChange("false || gh pr merge 5")).toBe(true);
  });

  test("&& is one operator, not two & (does not mis-split) — round-5", () => {
    // `&&` is tried first in the CHAIN_SPLIT alternation, so adding bare `&` to
    // the single-char class must not cause a genuine `&&` to split as two `&`s.
    expect(isChainedStateChange("gh pr checks 5 && gh pr merge 5")).toBe(true);
  });
});

describe("bare & (background) — round-5 (reviewer-prescribed, live-confirmed)", () => {
  // CHAIN_SPLIT omitted bare `&`: `gh pr checks 5 & gh pr merge 5` backgrounds the
  // check and runs the merge unconditionally, an upstream-failure-masking shape as
  // real as `;`. Live-confirmed ALLOW before the fix; must DENY after.
  test("a bare & before a state-changer is a chained state change", () => {
    expect(isChainedStateChange("gh pr checks 5 & gh pr merge 5")).toBe(true);
  });

  test("gh pr checks 5 & gh pr merge 5 denies", () => {
    expect(decide(bash("gh pr checks 5 & gh pr merge 5")).action).toBe("deny");
  });
});

describe("legitimate standalone forms — must NOT be denied", () => {
  test("a state-changer as the sole command is allowed", () => {
    for (const cmd of ["gh pr merge 465", "gh pr close 465", "gh repo delete owner/x --yes"]) {
      expect(decide(bash(cmd)).action).toBe("allow");
    }
  });

  test("a state-changer as the FIRST command with a follow-up is allowed", () => {
    // Its own exit is visible to the caller; nothing upstream could mask it.
    expect(decide(bash("gh pr merge 465 --squash && git checkout main")).action).toBe("allow");
  });

  test("chained read-only gh commands are allowed", () => {
    expect(decide(bash("gh pr checks 465 && gh pr view 465")).action).toBe("allow");
  });

  test("mergequeue and other non-verb words are not matched (word boundary)", () => {
    expect(isChainedStateChange("echo x && gh pr mergequeue")).toBe(false);
  });

  test("a plain non-gh chain is allowed", () => {
    expect(decide(bash("bun test && bun run typecheck")).action).toBe("allow");
  });
});

describe("quote-aware tokenizer — inert text in strings must NOT be denied (#487 HIGH)", () => {
  // Regression for the quote-blind split: an operator or gh verb inside a quoted
  // string or heredoc body is not a real chained statement. These FAIL on the
  // pre-fix code and ALLOW after masking quoted content.
  test("a gh verb mentioned inside a double-quoted echo body is allowed", () => {
    const cmd = 'git status && echo "reminder: never do gh pr merge blind"';
    expect(isChainedStateChange(cmd)).toBe(false);
    expect(decide(bash(cmd)).action).toBe("allow");
  });

  test("a gh pr create --body heredoc that discusses the verbs is allowed", () => {
    // The repo's normal PR-authoring pattern; the body's newlines + verb phrases
    // previously tripped the newline split.
    const cmd = [
      'gh pr create --body "$(cat <<\'EOF\'',
      "This PR gates gh pr merge / gh pr close / gh repo delete.",
      "Example it blocks: gh pr checks && gh pr merge.",
      "EOF",
      ')"',
    ].join("\n");
    expect(isChainedStateChange(cmd)).toBe(false);
    expect(decide(bash(cmd)).action).toBe("allow");
  });

  test("single quotes inside double quotes do not mis-pair (a real chained merge still denies)", () => {
    // The apostrophe-ish single quote is literal inside the double-quoted string;
    // the trailing `&& gh pr merge` is a genuine chained statement.
    const cmd = 'echo "it\'s green" && gh pr merge 5';
    expect(decide(bash(cmd)).action).toBe("deny");
  });
});

describe("comment-aware masking — round-3 (independent re-review of round-2)", () => {
  // Round-2's maskQuoted had no notion of a `#` comment: an apostrophe in comment
  // prose (`don't`, `it's`) opened a fake single-quote span that swallowed
  // everything after it, including a real chained `gh pr merge`. These four FAIL
  // on round-2 (ALLOW) and must DENY after the fix.
  test("override token quoted inside --body prose is not a real comment — still DENY", () => {
    const cmd =
      'gh pr comment 480 --body "Reminder: put # GH-CHAIN-OVERRIDE: reason in a comment" && gh pr merge 465';
    expect(decide(bash(cmd)).action).toBe("deny");
  });

  test("override token inside a -b string on the merge itself is not a real comment — still DENY", () => {
    const cmd = 'gh pr checks 465 --watch | tail -3 && gh pr merge 465 -b "use # GH-CHAIN-OVERRIDE: x"';
    expect(decide(bash(cmd)).action).toBe("deny");
  });

  test("apostrophe in a real comment must not swallow a real chained merge on the next line", () => {
    const cmd = "git status # don't forget\ngh pr checks 5 && gh pr merge 5";
    expect(decide(bash(cmd)).action).toBe("deny");
  });

  test("apostrophe in a same-line comment must not swallow a real chained merge", () => {
    const cmd = "echo hi # don't wait 'ok' && gh pr merge 5";
    expect(decide(bash(cmd)).action).toBe("deny");
  });
});

describe("comment word-boundary — round-4 (independent re-review of round-3, live-confirmed)", () => {
  // Round-3's inComment tracking had no word-boundary check: real bash only opens
  // a comment at a `#` preceded by whitespace/an operator/start-of-string, not a
  // `#` glued to a preceding token. Round-3 let such a `#` both start "comment"
  // mode AND survive verbatim into the masked string, so OVERRIDE_RE (a plain
  // substring search) matched an override token that was never inside a real
  // comment. Live-confirmed on round-3: `bash -c 'echo foo#GH-CHAIN-OVERRIDE: hack
  // && gh pr merge 5'` actually ran the merge. These three FAIL on round-3 (ALLOW)
  // and must DENY after the fix.
  test("override token glued to a preceding word is not a real comment — still DENY", () => {
    const cmd = "echo foo#GH-CHAIN-OVERRIDE: hack && gh pr merge 5";
    expect(decide(bash(cmd)).action).toBe("deny");
  });

  test("no-space variant is still not a real comment — still DENY", () => {
    const cmd = "echo foo#GH-CHAIN-OVERRIDE:hack && gh pr merge 5";
    expect(decide(bash(cmd)).action).toBe("deny");
  });

  test("override token glued to the gh verb's own argument is not a real comment — still DENY", () => {
    const cmd = "gh pr checks 5#GH-CHAIN-OVERRIDE: x && gh pr merge 5";
    expect(decide(bash(cmd)).action).toBe("deny");
  });

  test("a mid-word # with no override text still denies the real chain (unaffected by boundary fix)", () => {
    expect(decide(bash("echo foo#bar && gh pr merge 5")).action).toBe("deny");
  });

  test("a URL fragment's # is not a comment boundary — still denies the real chain", () => {
    expect(decide(bash("gh pr view https://x/y#frag && gh pr merge 5")).action).toBe("deny");
  });

  test("a real boundary comment (space before #) still allows a written override", () => {
    const cmd = "gh pr checks 5 && gh pr merge 5 # GH-CHAIN-OVERRIDE: checks are green";
    expect(decide(bash(cmd)).action).toBe("allow");
  });
});

describe("override token", () => {
  test("token with a written reason allows the chained one-liner", () => {
    const cmd = "gh pr checks 5 && gh pr merge 5 # GH-CHAIN-OVERRIDE: checks are green, batching";
    expect(decide(bash(cmd)).action).toBe("allow");
  });

  test("bare token with no reason does not override", () => {
    const cmd = `gh pr checks 5 && gh pr merge 5 # ${OVERRIDE_TOKEN}`;
    expect(decide(bash(cmd)).action).toBe("deny");
  });

  test("token inside a --body string (not a comment) does not override — still DENY (#487 LOW)", () => {
    const cmd = 'gh pr checks 5 && gh pr merge 5 --body "GH-CHAIN-OVERRIDE: not a real comment"';
    expect(decide(bash(cmd)).action).toBe("deny");
  });
});

describe("fail-open / non-Bash inputs", () => {
  test("non-Bash tools, empty commands, and unrecognizable payloads are allowed", () => {
    expect(decide({ tool_name: "Edit", tool_input: { command: "gh pr checks && gh pr merge" } }).action).toBe("allow");
    expect(decide(bash("")).action).toBe("allow");
    expect(decide(null).action).toBe("allow");
    expect(decide({ tool_name: "Bash", tool_input: "not-an-object" }).action).toBe("allow");
    expect(decide({ tool_name: "Bash", tool_input: { command: 42 } }).action).toBe("allow");
  });
});

describe("hook stdin→stdout contract", () => {
  const script = `${import.meta.dir}/../.claude/hooks/gh-chain-merge-gate.ts`;

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
    const { code, out } = runHook(JSON.stringify(bash("gh pr checks && gh pr merge 465")));
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("#466");
  });

  test("allowed case: no stdout, exit 0", () => {
    const { code, out } = runHook(JSON.stringify(bash("gh pr merge 465")));
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("malformed stdin: fail-open — no stdout, logs to stderr, exit 0", () => {
    const { code, out, err } = runHook("this is not json {");
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toContain("allowing command");
  });
});
