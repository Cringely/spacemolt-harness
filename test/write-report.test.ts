// Batch C review fix (#114, HIGH): the jailed report writer. Every probe
// spawns the real CLI offline (bun subprocess, temp dirs) — zero LLM tokens,
// zero network. The caller in production is a spawned agent, so --file and
// --body-b64 are untrusted input; violations must exit 2 WITHOUT writing.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "write-report.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "sched-report-"));
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function runWriter(args: string[], stateDir?: string) {
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
  return { exitCode: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

// Everything under the state dir EXCEPT reports/ content — a traversal probe
// must leave the whole tree untouched, not merely miss reports/.
const treeSnapshot = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

describe("write-report jail (Batch C review, HIGH)", () => {
  // Catches: the base64 argv body being corrupted in transit — a realistic
  // report (newlines, quotes, $, backticks) must land byte-identical. STDIN is
  // gone (denied to headless jobs); the body rides a single --body-b64 token.
  test("happy path: --body-b64 round-trips a realistic body byte-identical, exit 0", () => {
    const stateDir = tmp();
    const body = "# Council report\n\nOutsider: it's \"over-engineered\" ($SEAM) `foo | bar`\nline2\n";
    const res = runWriter(["--file", "2026-07-18-council-review.md", "--body-b64", b64(body)], stateDir);
    expect(res.exitCode).toBe(0);
    const target = join(stateDir, "reports", "2026-07-18-council-review.md");
    expect(readFileSync(target, "utf8")).toBe(body);
    expect(JSON.parse(res.stdout).bytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  // Catches: the charter-tamper path — `..` walking out of reports/ into the
  // checkout (docs/charters/*) or anywhere else on the host.
  test(".. traversal ⇒ exit 2, nothing written outside reports/", () => {
    const container = tmp(); // stands in for the host: stateDir + a fake checkout beside it
    const stateDir = join(container, "state");
    mkdirSync(stateDir, { recursive: true });
    const before = treeSnapshot(container);
    const res = runWriter(
      ["--file", join("..", "..", "docs", "charters", "soc-monitor.md"), "--body-b64", b64("TAMPERED CHARTER")],
      stateDir,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage");
    expect(existsSync(join(container, "docs"))).toBe(false); // the ../../ target was never created
    expect(treeSnapshot(container)).toEqual(before); // and nothing else moved
  });

  test("absolute path outside the jail ⇒ exit 2, no write", () => {
    const stateDir = tmp();
    const outside = join(tmp(), "evil.md");
    const res = runWriter(["--file", outside, "--body-b64", b64("x")], stateDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage");
    expect(existsSync(outside)).toBe(false);
  });

  // Catches: a symlinked component inside reports/ silently redirecting the
  // write outside the jail (lstat sees the link itself, not its target).
  test("symlink component under reports/ ⇒ exit 2, no write through the link", () => {
    const stateDir = tmp();
    const outsideDir = tmp();
    mkdirSync(join(stateDir, "reports"), { recursive: true });
    try {
      symlinkSync(outsideDir, join(stateDir, "reports", "sub"), "dir");
    } catch {
      return; // no symlink privilege on this host (Windows non-admin); the lstat guard still runs on the Linux host
    }
    const res = runWriter(["--file", join("sub", "escape.md"), "--body-b64", b64("escaped")], stateDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("symlink");
    expect(readdirSync(outsideDir).length).toBe(0);
  });

  // Catches: malformed base64 passed through instead of rejected as input.
  test("malformed --body-b64 ⇒ exit 2, no write", () => {
    const stateDir = tmp();
    const res = runWriter(["--file", "r.md", "--body-b64", "not base64!!"], stateDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("base64");
    expect(existsSync(join(stateDir, "reports", "r.md"))).toBe(false);
  });

  // (The 90KB decoded cap is exercised at the unit level via `decodeBodyArg`;
  // the CLI maps its BodyArgError to exit 2 the same way as the malformed case
  // above. A subprocess probe cannot cover it — the >90KB body's ~120KB base64
  // token exceeds the Windows host's ~32KB command line, so the arg can't be
  // passed here; production runs on Linux, where MAX_ARG_STRLEN is 128KB.)

  // Catches: a bare workstation invocation writing into a phantom jail —
  // same refusal posture as file-finding.ts and scheduler.ts.
  test("SCHEDULER_STATE_DIR unset ⇒ exit 2 before any side effect", () => {
    const res = runWriter(["--file", "r.md", "--body-b64", b64("x")]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("SCHEDULER_STATE_DIR");
  });

  test("malformed args (missing --file) ⇒ exit 2 with usage", () => {
    const stateDir = tmp();
    const res = runWriter(["--body-b64", b64("x")], stateDir);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage");
  });
});
