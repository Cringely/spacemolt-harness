// Batch C / Task C2 (#114): mechanical finding filer under verdict (a)
// conditions 1-4. Offline: fake gh runner, temp state dirs, zero live gh.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FINDINGS_PER_CYCLE_CAP,
  FilingInputError,
  fileFinding,
  readActiveCycle,
  writeActiveCycle,
  type GhRunner,
} from "../src/scheduler/filing";
import { BodyArgError, decodeBodyArg } from "../src/scheduler/body-arg";

const tmp = () => mkdtempSync(join(tmpdir(), "sched-filing-"));
const DAY = 86_400_000;

interface GhCall {
  args: string[];
  body?: string; // --body-file content captured AT CALL TIME (file is scratch)
}

// Canned gh: `issue list` answers from `listResponse`, `issue create` mints
// sequential numbers, everything else succeeds silently.
function fakeGh(listResponse: Array<{ number: number; state: string; closedAt: string | null }>) {
  const calls: GhCall[] = [];
  let nextIssue = 100;
  const gh: GhRunner = (args) => {
    const bodyIdx = args.indexOf("--body-file");
    const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, "utf8") : undefined;
    calls.push({ args, body });
    if (args[0] === "issue" && args[1] === "list") return { stdout: JSON.stringify(listResponse), exitCode: 0 };
    if (args[0] === "issue" && args[1] === "create")
      return { stdout: `https://github.com/x/y/issues/${nextIssue++}\n`, exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  return { gh, calls };
}

// The finding body is the text itself, passed as a string (in production the
// CLI reads it from STDIN) — there is no file to write and no outbox jail.
const finding = (n = 1) => ({
  jobId: "standup",
  cycleId: "standup-1752800000000",
  dedupKey: `test-finding-${n}`,
  title: `Test finding ${n}`,
  body: `finding body ${n}`,
});

describe("finding filer (C2)", () => {
  // Catches: duplicate-issue flood — an open match must bump, never re-create.
  test("open match ⇒ bump, no create", () => {
    const dir = tmp();
    const { gh, calls } = fakeGh([{ number: 42, state: "OPEN", closedAt: null }]);
    const res = fileFinding(gh, dir, finding());
    expect(res.outcome).toBe("bumped");
    expect(res.issue).toBe(42);
    expect(calls.some((c) => c.args[1] === "comment" && c.args[2] === "42")).toBe(true);
    expect(calls.some((c) => c.args[1] === "create")).toBe(false);
    // Dedup searches the literal marker as a QUOTED PHRASE, never a bare
    // token an attacker-shaped key could extend with search operators.
    const list = calls.find((c) => c.args[1] === "list")!;
    expect(list.args[list.args.indexOf("--search") + 1]).toBe('"<!-- sm-dedup:test-finding-1 -->" in:body');
  });

  // Catches: the closing-keyword incident class — open-only dedup refiling
  // what a merge just closed (verdict (a) condition 1).
  test("match closed 10d ago ⇒ bump", () => {
    const dir = tmp();
    const closedAt = new Date(Date.now() - 10 * DAY).toISOString();
    const { gh, calls } = fakeGh([{ number: 43, state: "CLOSED", closedAt }]);
    const res = fileFinding(gh, dir, finding());
    expect(res.outcome).toBe("bumped");
    expect(res.issue).toBe(43);
    expect(calls.some((c) => c.args[1] === "create")).toBe(false);
  });

  // Catches: dedup over-blocking a genuinely recurring defect.
  test("match closed 45d ago ⇒ new issue", () => {
    const dir = tmp();
    const closedAt = new Date(Date.now() - 45 * DAY).toISOString();
    const { gh, calls } = fakeGh([{ number: 44, state: "CLOSED", closedAt }]);
    const res = fileFinding(gh, dir, finding());
    expect(res.outcome).toBe("created");
    expect(calls.some((c) => c.args[1] === "create")).toBe(true);
  });

  // Catches: unattributable machine issues (verdict (a) condition 2) — and a
  // body built on argv instead of --body-file (the ENAMETOOLONG class).
  test("created issue carries machine-filed label, dedup marker, provenance line", () => {
    const dir = tmp();
    const { gh, calls } = fakeGh([]);
    const res = fileFinding(gh, dir, finding());
    expect(res.outcome).toBe("created");
    expect(res.issue).toBe(100);
    const create = calls.find((c) => c.args[1] === "create");
    expect(create).toBeDefined();
    const args = create as GhCall;
    expect(args.args).toContain("--label");
    expect(args.args[args.args.indexOf("--label") + 1]).toBe("machine-filed");
    expect(args.args).toContain("--body-file"); // body never travels on argv
    expect(args.body).toContain("<!-- sm-dedup:test-finding-1 -->");
    expect(args.body).toContain("filed-by: scheduler/standup cycle standup-1752800000000");
  });

  // Catches: the ON-ARRIVAL filing defect (#114) — a job that produced the
  // finding body as a STRING (there is no outbox file-jail to write to) must
  // file successfully. The whole capability was dead when the only file-CREATING
  // tool was jailed to a different dir than the filer read from.
  test("body passed as a string ⇒ files successfully, body reaches the created issue", () => {
    const dir = tmp();
    const { gh, calls } = fakeGh([]);
    const res = fileFinding(gh, dir, {
      jobId: "standup",
      cycleId: "standup-1752800000000",
      dedupKey: "body-as-string",
      title: "String body finding",
      body: "the finding body travels as a string, not a file path",
    });
    expect(res.outcome).toBe("created");
    const create = calls.find((c) => c.args[1] === "create")!;
    expect(create.body).toContain("the finding body travels as a string, not a file path");
    expect(create.body).toContain("<!-- sm-dedup:body-as-string -->");
  });

  // Catches: per-cycle flood (verdict (a) condition 4) and cap-reset-on-crash
  // — the counter is file-backed, so a process restart must not re-open it.
  test("sixth finding ⇒ capped into ONE summary issue; counter survives restart", () => {
    const dir = tmp();
    const { gh, calls } = fakeGh([]); // no dedup matches: every finding is new
    for (let n = 1; n <= FINDINGS_PER_CYCLE_CAP; n++) {
      expect(fileFinding(gh, dir, finding(n)).outcome).toBe("created");
    }
    // Sixth: capped. Every fileFinding call re-reads the counter from disk, so
    // this is exactly what a fresh process after a crash would see.
    const sixth = fileFinding(gh, dir, finding(6));
    expect(sixth.outcome).toBe("capped");
    // One summary issue created at first overflow, no sixth finding issue.
    const creates = calls.filter((c) => c.args[1] === "create");
    expect(creates.length).toBe(FINDINGS_PER_CYCLE_CAP + 1); // 5 findings + 1 summary
    const summary = creates[creates.length - 1]!;
    expect(summary.args[summary.args.indexOf("--title") + 1]).toContain("over cap");
    // Seventh: appends to the SAME summary issue — no second summary.
    const seventh = fileFinding(gh, dir, finding(7));
    expect(seventh.outcome).toBe("capped");
    expect(seventh.issue).toBe(sixth.issue);
    expect(calls.filter((c) => c.args[1] === "create").length).toBe(FINDINGS_PER_CYCLE_CAP + 1);
    // File-backed counter on disk (restart-safe by construction).
    const counterFiles = readdirSync(dir).filter((f) => f.startsWith("filing-"));
    expect(counterFiles.length).toBe(1);
    const counter = JSON.parse(readFileSync(join(dir, counterFiles[0]!), "utf8"));
    expect(counter.count).toBe(7);
  });
});

// The filer's caller is a spawned agent; every input is untrusted (spec
// §Security: LLM output is untrusted input). These reject BEFORE any gh
// invocation. Exfiltration via a body-file path is gone by construction: the
// body is the text itself, never a filesystem path — no host file to read, no
// jail to escape.
describe("finding filer input hardening (C2, security review)", () => {
  // Catches: an unbounded body overrunning gh/argv limits or flooding an issue
  // — the 64KB cap is enforced on the string before any gh call.
  test("oversized body (>64KB) ⇒ rejected", () => {
    const dir = tmp();
    const { gh, calls } = fakeGh([]);
    expect(() => fileFinding(gh, dir, { ...finding(), body: "x".repeat(64 * 1024 + 1) })).toThrow(FilingInputError);
    expect(calls.length).toBe(0);
  });

  // Catches: search-operator injection through the dedup key into gh --search.
  test("hostile dedup key ⇒ rejected before any gh invocation", () => {
    const dir = tmp();
    const { gh, calls } = fakeGh([]);
    for (const key of ['x" OR label:secret', "a b", "k\nnewline", "", "y".repeat(65)]) {
      expect(() => fileFinding(gh, dir, { ...finding(), dedupKey: key })).toThrow(FilingInputError);
    }
    expect(calls.length).toBe(0);
  });

  // Catches: the (a)(4) flood cap keyed on caller-supplied identity — the
  // cycle id must be scheduler-owned (runJob writes it; the CLI reads it).
  test("active-cycle file round-trips; corrupt file reads as null", () => {
    const dir = tmp();
    expect(readActiveCycle(dir)).toBe(null);
    writeActiveCycle(dir, { jobId: "standup", cycleId: "standup-123" });
    expect(readActiveCycle(dir)).toEqual({ jobId: "standup", cycleId: "standup-123" });
    writeFileSync(join(dir, "active-cycle.json"), '{"jobId":'); // truncated
    expect(readActiveCycle(dir)).toBe(null); // never a throw
  });
});

// The body must reach the script as a SINGLE-LINE, newline-free argv token:
// headless Claude Code's permission layer splits a Bash command on newlines and
// matches each fragment against allowedTools independently, so a heredoc body
// never matches `Bash(bun scripts/file-finding.ts *)` and the run is denied.
// base64 (not \n-escaping) because bodies carry quotes, $, and backticks.
describe("base64 argv body transport (headless-safe, #114 filing fix)", () => {
  // Catches: a body with shell-hostile chars corrupted in transit — encode →
  // argv token → decode must be byte-identical, and the token must be one line.
  test("round-trips a realistic body (newlines, quotes, $, backticks) byte-identical", () => {
    const body = [
      "Finding: the guard misfires.",
      "It's a \"quoted\" line with $VAR and `backticks` and a trailing pipe |.",
      "second paragraph",
    ].join("\n");
    const b64 = Buffer.from(body, "utf8").toString("base64");
    expect(b64).not.toContain("\n"); // one argv token, no newline to split on
    expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/); // standard base64 alphabet only
    expect(decodeBodyArg(b64, 64 * 1024)).toBe(body); // byte-identical after decode
  });

  test("malformed base64 ⇒ BodyArgError", () => {
    expect(() => decodeBodyArg("not valid base64!!", 1024)).toThrow(BodyArgError);
    expect(() => decodeBodyArg("YWJj", 1024)).not.toThrow(); // "abc" is valid
  });

  test("decoded body over the cap ⇒ BodyArgError", () => {
    const b64 = Buffer.from("x".repeat(2000), "utf8").toString("base64");
    expect(() => decodeBodyArg(b64, 1024)).toThrow(BodyArgError);
  });
});

// Spawns the REAL CLI offline. Each case stops BEFORE any gh call (bad args,
// gate off, or a bad body), so nothing here touches the network or files an
// issue — it proves the CLI decodes the base64 argv body, never a file path.
describe("file-finding CLI (base64 argv body)", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "file-finding.ts");
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  function runCli(args: string[], stateDir?: string) {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.SCHEDULER_STATE_DIR;
    if (stateDir !== undefined) env.SCHEDULER_STATE_DIR = stateDir;
    const res = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT, ...args],
      env: env as Record<string, string>,
      stdin: new TextEncoder().encode(""),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: res.exitCode, stderr: res.stderr.toString() };
  }

  const withCycle = () => {
    const dir = tmp();
    writeActiveCycle(dir, { jobId: "standup", cycleId: "standup-1" });
    return dir;
  };

  // Catches: the CLI reverting to a body FILE/STDIN — the body is a required
  // --body-b64 flag now, and the usage line names it.
  test("missing --body-b64 ⇒ exit 2, usage names --body-b64", () => {
    const res = runCli(["--dedup-key", "k", "--title", "t"], withCycle());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage");
    expect(res.stderr).toContain("--body-b64");
  });

  // Catches: the base64 body not being validated — a non-base64 token is
  // rejected input (exit 2), never passed through to gh.
  test("malformed --body-b64 ⇒ exit 2 before any gh call", () => {
    const res = runCli(["--dedup-key", "k", "--title", "t", "--body-b64", "not base64!!"], withCycle());
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("base64");
  });

  // (The 64KB decoded cap is exercised at the unit level: `decodeBodyArg` over
  // its cap throws BodyArgError, and the CLI maps that to exit 2 the same way it
  // maps the malformed-base64 case above. A subprocess probe cannot cover it —
  // the >64KB body's ~87KB base64 token exceeds the Windows host's ~32KB command
  // line, so the arg can't even be passed here; production runs on Linux, 128KB.)

  // Catches: the D1 kill switch not honored at the CLI — disabled ⇒ exit 3.
  test("D1 gate disabled ⇒ exit 3 before any gh call", () => {
    const dir = withCycle();
    writeFileSync(join(dir, "gates.json"), JSON.stringify({ fileFindings: { enabled: false } }));
    const res = runCli(["--dedup-key", "k", "--title", "t", "--body-b64", b64("a finding body")], dir);
    expect(res.exitCode).toBe(3);
  });
});
