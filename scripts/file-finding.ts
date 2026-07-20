// The ONE authorized filing path for headless scheduler jobs (#114 Task C2).
// Work orders (src/scheduler/spawn.ts) instruct every spawned agent to file
// findings ONLY through this command — never `gh issue create` directly — so
// verdict (a)'s conditions (dedup incl. recently-closed, machine-filed label +
// provenance, bump-not-refile, per-cycle cap) are enforced mechanically, not
// by prose the agent might drift from.
//
//   bun scripts/file-finding.ts --dedup-key <stable-key> --title <title> --body-b64 <base64>
//
// The finding body is a base64 token on argv — a SINGLE, newline-free argument
// (src/scheduler/body-arg.ts explains why): headless Claude Code's permission
// layer splits a Bash command on newlines and matches each fragment against the
// closed allowedTools list independently, so a heredoc/STDIN body is DENIED,
// while a one-line `--body-b64 <token>` matches `Bash(bun scripts/file-finding.ts *)`.
// The old `--body-file <under outbox/>` form was dead on arrival too — no fleet
// tool could CREATE a file in that jail (bare Write is banned, write-report.ts
// is jailed to reports/).
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
import { BodyArgError, decodeBodyArg } from "../src/scheduler/body-arg";
import { canFile, loadGates } from "../src/scheduler/gates";
import { FilingInputError, MAX_BODY_BYTES, fileFinding, readActiveCycle, type GhRunner } from "../src/scheduler/filing";

function usage(msg: string): never {
  console.error(msg);
  console.error("usage: bun scripts/file-finding.ts --dedup-key <key> --title <title> --body-b64 <base64 of the body>");
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
if (!dedupKey || !title || !bodyB64) usage("missing required argument");

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

// Decode + validate + cap the body BEFORE any gh call. Malformed base64 or an
// oversized decoded body is rejected input (exit 2), never a gh failure.
let body: string;
try {
  body = decodeBodyArg(bodyB64, MAX_BODY_BYTES);
} catch (e) {
  usage(e instanceof BodyArgError ? e.message : `invalid --body-b64: ${e instanceof Error ? e.message : String(e)}`);
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
