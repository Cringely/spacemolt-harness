// The ONE authorized report-write path for headless scheduler jobs (#114
// Batch C review, HIGH finding). Claude Code does not honor Write(path)
// scoping — only Edit(path) rules match — so a bare `Write` grant would let
// a prompt-injected job overwrite docs/charters/* ON DISK in the checkout:
// the D3 fence is commit-time and never sees a plain filesystem write, and
// the next spawn reads the tampered charter via readFileSync. Bare `Write`
// is therefore banned from every job's allowedTools
// (test/scheduler-spawn.test.ts pins it); dated reports write through this
// jailed script instead.
//
//   bun scripts/write-report.ts --file <relative path> --body-b64 <base64>
//
// The report body is a base64 token on argv — a SINGLE, newline-free argument
// (src/scheduler/body-arg.ts explains why): headless Claude Code's permission
// layer splits a Bash command on newlines and matches each fragment against the
// closed allowedTools list independently, so a heredoc/STDIN body is DENIED,
// while a one-line `--body-b64 <token>` matches `Bash(bun scripts/write-report.ts *)`.
//
// The caller is a spawned agent, so both --file and --body-b64 are UNTRUSTED
// input (spec §Security: LLM output is untrusted input). Rejected with exit 2 +
// usage BEFORE any write:
// - the target must resolve strictly under $SCHEDULER_STATE_DIR/reports/
//   (path.resolve containment — kills `..` traversal and absolute paths);
// - every EXISTING component under reports/ is lstat'd and symlinks are
//   rejected (lstat sees the link itself, not its target) — a symlinked
//   subdir or file would silently redirect the write outside the jail;
// - the body must be valid base64 and cap at 90KB DECODED — base64 of 90KB
//   (~120KB) stays under Linux MAX_ARG_STRLEN (128KB per argv token), so the
//   whole report fits in the single argument (down from the old 256KB STDIN
//   cap: STDIN is unreachable to headless jobs, argv is size-bounded);
// - refuses to run without SCHEDULER_STATE_DIR (not a scheduled-job run).
// Exit codes: 0 written (outcome JSON on stdout), 2 usage/rejected input.
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { BodyArgError, decodeBodyArg } from "../src/scheduler/body-arg";

const MAX_REPORT_BYTES = 90 * 1024;

function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: bun scripts/write-report.ts --file <relative path under $SCHEDULER_STATE_DIR/reports/> --body-b64 <base64>",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const opts: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (flag === undefined || !flag.startsWith("--") || value === undefined) usage(`bad argument: ${flag}`);
  opts[flag.slice(2)] = value;
}
const file = opts.file;
const bodyB64 = opts["body-b64"];
if (!file || !bodyB64) usage("expected: --file <relative path> --body-b64 <base64>");

const stateDir = process.env.SCHEDULER_STATE_DIR;
if (!stateDir) usage("SCHEDULER_STATE_DIR is not set — write-report runs only inside a scheduled job");

const reportsDir = resolve(stateDir, "reports");
const resolved = resolve(reportsDir, file);
if (!resolved.startsWith(reportsDir + sep)) {
  usage(`--file must resolve under <stateDir>/reports/ (got: ${file})`);
}

// Symlink jail: walk the resolved path component by component below reports/.
let cur = reportsDir;
for (const part of resolved.slice((reportsDir + sep).length).split(sep)) {
  cur = join(cur, part);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(cur);
  } catch {
    break; // component does not exist yet — nothing deeper exists either
  }
  if (st.isSymbolicLink()) usage(`symlink component rejected: ${part}`);
  if (cur === resolved && !st.isFile()) usage(`target exists and is not a regular file: ${file}`);
}

// Decode + validate + cap the body BEFORE any write. Malformed base64 or an
// oversized decoded report is rejected input (exit 2).
let body: string;
try {
  body = decodeBodyArg(bodyB64, MAX_REPORT_BYTES);
} catch (e) {
  usage(e instanceof BodyArgError ? e.message : `invalid --body-b64: ${e instanceof Error ? e.message : String(e)}`);
}

mkdirSync(dirname(resolved), { recursive: true });
writeFileSync(resolved, body);
console.log(JSON.stringify({ written: resolved, bytes: Buffer.byteLength(body, "utf8") }));
