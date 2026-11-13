// A job passes a long body (finding, report, steer text, dedupe pairs) as a FILE
// it wrote with the Write tool, not as base64 it computed in the shell. The old
// design granted `Bash(printf *)` + `base64` and told jobs to run
// `printf '<untrusted text>' | base64 -w 0`: untrusted text inside a
// single-quoted shell argument is injection, and `printf *` is a free-form
// wildcard (security review of PR 171, HIGH). These tests pin the replacement:
// the path is confined to the job's cwd, and no job holds a shell encoder.
//
// Offline: temp dirs and `bun` subprocesses, zero network, zero LLM tokens.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BodyArgError, readBodyFile, resolveBody } from "../src/scheduler/body-arg";
import { writeActiveCycle } from "../src/scheduler/filing";

const tmp = () => mkdtempSync(join(tmpdir(), "sched-bodyfile-"));
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// A job's cwd with a scratch dir, plus a sibling "host" file outside it.
function makeJail() {
  const root = tmp();
  const cwd = join(root, "checkout");
  mkdirSync(join(cwd, ".scratch"), { recursive: true });
  writeFileSync(join(root, "outside.md"), "OUTSIDE SECRET");
  return { root, cwd };
}

describe("readBodyFile: path confined to the job's cwd", () => {
  // Catches: the body arriving corrupted or the happy path regressing. A body
  // with quotes, `$`, backticks and a newline lands byte-identical, with no
  // shell or base64 step in between.
  test("reads a body written inside cwd byte-identical (relative and absolute)", () => {
    const { cwd } = makeJail();
    const body = "# Finding\n\nit's \"quoted\" ($HOME) `a | b` $(rm -rf /)\nline2\n";
    writeFileSync(join(cwd, ".scratch", "f.md"), body);
    expect(readBodyFile(".scratch/f.md", 64 * 1024, cwd)).toBe(body);
    expect(readBodyFile(join(cwd, ".scratch", "f.md"), 64 * 1024, cwd)).toBe(body);
  });

  // Catches: `..` walking out of the checkout to read a host file into a public
  // or tracker-bound body. Includes a `..` that re-enters (still inside = ok).
  test(".. traversal out of cwd is rejected, a .. that stays inside is fine", () => {
    const { cwd } = makeJail();
    expect(() => readBodyFile("../outside.md", 1024, cwd)).toThrow(BodyArgError);
    expect(() => readBodyFile(".scratch/../../outside.md", 1024, cwd)).toThrow(BodyArgError);
    writeFileSync(join(cwd, "in.md"), "ok");
    expect(readBodyFile(".scratch/../in.md", 1024, cwd)).toBe("ok");
  });

  // Catches: an absolute path to a file outside cwd (the secrets dir, gates.json,
  // the host env file all live outside the checkout).
  test("an absolute path outside cwd is rejected", () => {
    const { root, cwd } = makeJail();
    expect(() => readBodyFile(join(root, "outside.md"), 1024, cwd)).toThrow(BodyArgError);
  });

  // Catches: a sibling directory whose name merely starts with cwd's name
  // ("checkout-evil") passing a naive string-prefix containment check.
  test("a sibling directory sharing cwd's name prefix is outside", () => {
    const { root, cwd } = makeJail();
    mkdirSync(join(root, "checkout-evil"), { recursive: true });
    writeFileSync(join(root, "checkout-evil", "x.md"), "evil");
    expect(() => readBodyFile(join(root, "checkout-evil", "x.md"), 1024, cwd)).toThrow(BodyArgError);
  });

  // Catches: a symlink inside cwd pointing at a host path. A lexical check passes
  // it, only resolving the link catches it. (junction: works unprivileged on
  // Windows, plain dir symlink on Linux.)
  test("a symlink inside cwd that points outside is rejected", () => {
    const { root, cwd } = makeJail();
    try {
      symlinkSync(root, join(cwd, "link"), "junction");
    } catch {
      return; // no symlink privilege on this host; the realpath guard still runs on the Linux host
    }
    expect(() => readBodyFile("link/outside.md", 1024, cwd)).toThrow(BodyArgError);
  });

  // Catches: reading a directory, a missing file, an over-cap file (cap is
  // enforced BEFORE the read), and an empty path as anything but a clean error.
  test("directory, missing file, empty path and over-cap file are rejected", () => {
    const { cwd } = makeJail();
    expect(() => readBodyFile(".scratch", 1024, cwd)).toThrow(BodyArgError);
    expect(() => readBodyFile(".scratch/nope.md", 1024, cwd)).toThrow(BodyArgError);
    expect(() => readBodyFile("", 1024, cwd)).toThrow(BodyArgError);
    writeFileSync(join(cwd, ".scratch", "big.md"), "x".repeat(2000));
    expect(() => readBodyFile(".scratch/big.md", 1024, cwd)).toThrow(BodyArgError);
    expect(readBodyFile(".scratch/big.md", 2000, cwd).length).toBe(2000);
  });
});

describe("resolveBody: exactly one of the base64 token or the file", () => {
  // Catches: both given (ambiguous, one silently wins) or neither given.
  test("both or neither is rejected; either alone works and the b64 flag still decodes", () => {
    const { cwd } = makeJail();
    writeFileSync(join(cwd, "a.md"), "from file");
    expect(resolveBody({ b64: b64("from b64") }, 1024, cwd)).toBe("from b64");
    expect(resolveBody({ file: "a.md" }, 1024, cwd)).toBe("from file");
    expect(() => resolveBody({ b64: b64("x"), file: "a.md" }, 1024, cwd)).toThrow(BodyArgError);
    expect(() => resolveBody({}, 1024, cwd)).toThrow(BodyArgError);
  });
});

// CLI wiring: each script must actually route its file flag through the
// confinement, with cwd = the job's checkout. Spawns the real scripts.
const SCRIPTS = join(import.meta.dir, "..", "scripts");

function run(script: string, args: string[], cwd: string, env: Record<string, string>) {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.SCHEDULER_STATE_DIR;
  const res = Bun.spawnSync({
    cmd: [process.execPath, join(SCRIPTS, script), ...args],
    cwd,
    env: { ...base, ...env } as Record<string, string>,
    stdin: new TextEncoder().encode(""),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

describe("scripts/write-report.ts --body-file", () => {
  // Catches: write-report ignoring the file flag, or letting a body file escape
  // the checkout. The report lands under the state dir; the body comes from cwd.
  test("happy path writes the file's body; a traversal body path exits 2 and writes nothing", () => {
    const { root, cwd } = makeJail();
    const stateDir = join(root, "state");
    const body = "# Council\n\n`code` $x 'q'\n";
    writeFileSync(join(cwd, ".scratch", "r.md"), body);
    const ok = run("write-report.ts", ["--file", "r.md", "--body-file", ".scratch/r.md"], cwd, { SCHEDULER_STATE_DIR: stateDir });
    expect(ok.exitCode).toBe(0);
    expect(readFileSync(join(stateDir, "reports", "r.md"), "utf8")).toBe(body);

    const bad = run("write-report.ts", ["--file", "r2.md", "--body-file", "../outside.md"], cwd, { SCHEDULER_STATE_DIR: stateDir });
    expect(bad.exitCode).toBe(2);
    expect(existsSync(join(stateDir, "reports", "r2.md"))).toBe(false);
  });

  // Catches: both body sources accepted at once.
  test("--body-b64 together with --body-file exits 2", () => {
    const { root, cwd } = makeJail();
    writeFileSync(join(cwd, "a.md"), "x");
    const res = run("write-report.ts", ["--file", "r.md", "--body-b64", b64("y"), "--body-file", "a.md"], cwd, {
      SCHEDULER_STATE_DIR: join(root, "state"),
    });
    expect(res.exitCode).toBe(2);
  });
});

describe("scripts/file-finding.ts --body-file", () => {
  const withCycle = (root: string) => {
    const dir = join(root, "state");
    mkdirSync(dir, { recursive: true });
    writeActiveCycle(dir, { jobId: "standup", cycleId: "standup-1" });
    return dir;
  };

  // Catches: file-finding reading a body path outside the checkout. Rejected
  // (exit 2) before any gh call.
  test("a body path outside cwd exits 2 before any gh call", () => {
    const { root, cwd } = makeJail();
    const res = run("file-finding.ts", ["--dedup-key", "k", "--title", "t", "--body-file", "../outside.md"], cwd, {
      SCHEDULER_STATE_DIR: withCycle(root),
    });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).not.toContain("OUTSIDE SECRET");
  });

  // Catches: the file flag being unwired (a valid file would then exit 2 as
  // "missing required argument"). With gh made unreachable, an accepted body
  // proceeds to the gh call and fails there: exit 1, not 2.
  test("a valid body file is accepted: the run reaches the gh call (exit 1, not a usage exit 2)", () => {
    const { root, cwd } = makeJail();
    writeFileSync(join(cwd, ".scratch", "f.md"), "a finding body");
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);
    const env: Record<string, string> = { SCHEDULER_STATE_DIR: withCycle(root), PATH: emptyBin, Path: emptyBin };
    const res = run("file-finding.ts", ["--dedup-key", "k", "--title", "t", "--body-file", ".scratch/f.md"], cwd, env);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("file-finding failed");
  });
});

describe("scripts/backlog-dedupe.ts --semantic-file", () => {
  // Catches: the semantic pairs file escaping the checkout. Rejected (exit 2)
  // before the tracker is touched.
  test("a pairs path outside cwd exits 2", () => {
    const { root, cwd } = makeJail();
    const res = run("backlog-dedupe.ts", ["run", "--semantic-file", "../outside.md"], cwd, {
      SCHEDULER_STATE_DIR: join(root, "state"),
    });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("outside");
  });

  // Catches: the flag being unwired. A pairs file that is inside cwd but not
  // valid pairs fails on the PAIRS (exit 2, "semantic pairs"), proving the file
  // was read and parsed rather than the flag rejected as unknown.
  test("a pairs file inside cwd is read and parsed", () => {
    const { root, cwd } = makeJail();
    writeFileSync(join(cwd, ".scratch", "p.json"), "not json");
    const res = run("backlog-dedupe.ts", ["run", "--semantic-file", ".scratch/p.json"], cwd, {
      SCHEDULER_STATE_DIR: join(root, "state"),
    });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("semantic pairs are not valid JSON");
  });
});
