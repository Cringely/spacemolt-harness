// The ONE authorized filing path for headless scheduler jobs (#114 Task C2).
// Work orders (src/scheduler/spawn.ts) instruct every spawned agent to file
// findings ONLY through this command — never `gh issue create` directly — so
// verdict (a)'s conditions (dedup incl. recently-closed, machine-filed label +
// provenance, bump-not-refile, per-cycle cap) are enforced mechanically, not
// by prose the agent might drift from.
//
//   bun scripts/file-finding.ts --dedup-key <stable-key> --title <title> --body-file <path>
//   bun scripts/file-finding.ts --dedup-key <stable-key> --title <title> --body-b64 <base64>
//
// #635: a headless spawn has no memory across cycles, so three cycles once
// minted three spellings of one finding (a severity-word affix riding inside
// the key). fileFinding() (src/scheduler/filing.ts) now catches that itself —
// a create whose key differs from an OPEN machine-filed issue's key only by a
// severity word (p0/blocker/…) bumps that issue instead of opening a new one.
// Nothing here changed to support it: it is internal to fileFinding, so this
// CLI's surface (flags, exit codes) is unaffected.
//
// Every created issue gets a fixed priority label (src/scheduler/filing.ts
// DEFAULT_TRIAGE_LABEL) with no caller input — an earlier draft let the
// caller escalate via `--priority`, but review (R7, PR #29) cut it: every
// filed issue already got the label with or without the flag, so it served
// no invariant and only reintroduced the exact failure class this filer
// exists to remove (correctness depending on an LLM volunteering a field).
//
// The finding body is a base64 token on argv — a SINGLE, newline-free argument
// (src/scheduler/body-arg.ts explains why): headless Claude Code's permission
// layer splits a Bash command on newlines and matches each fragment against the
// closed allowedTools list independently, so a heredoc/STDIN body is DENIED,
// while a one-line `--body-b64 <token>` matches `Bash(bun scripts/file-finding.ts *)`.
// The form the work orders teach is `--body-file <path>`: the job writes the
// body with the Write tool into .job-body/ in its checkout and passes the path, which
// readBodyFile confines to .job-body/. That keeps the text out of every shell command
// (a `printf '<text>' | base64` step would put untrusted text inside a
// single-quoted shell argument). The old `--body-file <under outbox/>` jail was
// dead on arrival because no fleet tool could create a file there; this one
// lives in the checkout, where Write can.
//
// The caller is a spawned agent, so its arguments are UNTRUSTED input (Batch C
// security review): job/cycle identity comes from the scheduler-written
// active-cycle.json, never from flags; the body is validated + capped at 64KB
// (decoded) before any gh call; dedup-key is allowlisted (see filing.ts).
//
// Requires SCHEDULER_STATE_DIR (identity + counters + gates.json live there).
// Exit codes: 0 filed (outcome JSON on stdout), 1 gh/runtime failure,
// 2 usage/missing env/rejected input/no active cycle, 3 filing disabled by
// the D1 gate (gates.json).
import { spawnSync } from "node:child_process";
import { BodyArgError, resolveBody } from "../src/scheduler/body-arg";
import { canFile, loadGates } from "../src/scheduler/gates";
import { FilingInputError, MAX_BODY_BYTES, fileFinding, readActiveCycle, type GhRunner } from "../src/scheduler/filing";

function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: bun scripts/file-finding.ts --dedup-key <key> --title <title> (--body-file <path inside your checkout> | --body-b64 <base64 of the body>)",
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
const { title } = opts;
const dedupKey = opts["dedup-key"];
const bodyB64 = opts["body-b64"];
const bodyFile = opts["body-file"];
if (!dedupKey || !title || (!bodyB64 && !bodyFile)) usage("missing required argument");

const stateDir = process.env.SCHEDULER_STATE_DIR;
if (!stateDir) usage("SCHEDULER_STATE_DIR is not set");

// Scheduler-owned identity: written by runJob at spawn. Absent ⇒ this is not
// a scheduled job run, and filing is not available.
const active = readActiveCycle(stateDir);
if (!active) usage("no active cycle recorded — file-finding runs only inside a scheduled job");

// D1 gate: capability (a) is ON at stage 1 by default, but the gate file is
// the operator's kill switch — honor it here, at the capability's call site.
if (!canFile(loadGates(stateDir))) {
  console.error("filing is disabled by the D1 capability gate (gates.json: fileFindings.enabled=false)");
  process.exit(3);
}

// Decode or read + validate + cap the body BEFORE any gh call. Malformed
// base64, a body file outside the checkout, or an oversized body is rejected
// input (exit 2), never a gh failure.
let body: string;
try {
  body = resolveBody({ b64: bodyB64, file: bodyFile }, MAX_BODY_BYTES);
} catch (e) {
  usage(e instanceof BodyArgError ? e.message : `invalid body: ${e instanceof Error ? e.message : String(e)}`);
}

const gh: GhRunner = (ghArgs) => {
  const res = spawnSync("gh", ghArgs, { encoding: "utf8" });
  if (res.error) throw res.error;
  return { stdout: res.stdout ?? "", exitCode: res.status ?? 1 };
};

try {
  const outcome = fileFinding(gh, stateDir, {
    jobId: active.jobId,
    cycleId: active.cycleId,
    dedupKey,
    title,
    body,
  });
  console.log(JSON.stringify(outcome));
} catch (e) {
  if (e instanceof FilingInputError) usage(e.message);
  console.error(`file-finding failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
