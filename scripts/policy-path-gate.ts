// D3 policy-path fence (#114) — the gate the pre-commit hook execs.
//
// `bun scripts/policy-path-gate.ts --staged`: when the process runs as the
// headless service user (SCHEDULER_SERVICE_USER), every staged path must sit on
// HEADLESS_WRITE_ALLOWLIST (src/scheduler/policy-paths.ts — the doc-steward
// write surface) AND land as a regular file (no symlinks/gitlinks — see
// HEADLESS_MODES there); any other entry rejects the commit, exit 1, rejects
// named. Any other user: exit 0, fence dormant.
//
// RESIDUAL RISK (documented per the stage-1 plan, spec load-bearing unknown
// 2): `git commit --no-verify` bypasses any client-side hook; the
// morning-read rule — any merge-ready PR touching a policy path gets full
// human review — is the paired last barrier. Case-insensitive filesystems can
// over-block case-variant allowlisted paths (over-block, never a leak); the
// runbook owns the target-fs note.
//
// TEST OVERRIDE — POLICY_GATE_TEST_USERNAME: consumed ONLY here, only by the
// test harness (test/policy-path-gate.test.ts), to simulate the service user
// in a temp repo. It is one-directional by construction: the real OS username
// is checked unconditionally first, so the override can only ADD headlessness
// for a workstation test run — a spawn running as the service user cannot set
// or unset any env var to make the fence dormant.

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { checkStagedEntries, isHeadless, parseStagedRaw } from "../src/scheduler/policy-paths";

function main(argv: string[]): number {
  if (argv.length !== 1 || argv[0] !== "--staged") {
    console.error("usage: bun scripts/policy-path-gate.ts --staged");
    return 2;
  }

  const headless =
    isHeadless(userInfo().username) || isHeadless(process.env["POLICY_GATE_TEST_USERNAME"] ?? "");
  if (!headless) return 0;

  // -z: NUL-separated, unquoted — correct for every filename git can hold.
  // --raw: mode + path in one call, so the symlink check shares this producer.
  // --no-renames is load-bearing: rename detection would COALESCE a
  // `git mv docs/charters/x.md docs/archive/y.md` into the destination path
  // only, and the deleted charter path would never reach the check.
  const diff = spawnSync("git", ["diff", "--cached", "--raw", "-z", "--no-renames"], {
    encoding: "utf8",
  });
  if (diff.status !== 0 || typeof diff.stdout !== "string") {
    // Fail CLOSED: a headless commit whose staged set cannot be read is not
    // provably inside the allowlist.
    console.error("policy-path-gate: `git diff --cached` failed; refusing headless commit.");
    return 1;
  }
  const entries = parseStagedRaw(diff.stdout);
  if (entries === null) {
    // Fail CLOSED: an unrecognized record (e.g. a rename record, impossible
    // while --no-renames holds) is not provably inside the allowlist.
    console.error("policy-path-gate: unrecognized staged record; refusing headless commit.");
    return 1;
  }

  const { ok, rejected } = checkStagedEntries(entries);
  if (ok) return 0;
  console.error(
    "policy-path-gate: headless commit rejected — staged path(s) outside the doc-steward allowlist (D3 fence, #114):",
  );
  for (const path of rejected) console.error(`  ${path}`);
  return 1;
}

process.exit(main(process.argv.slice(2)));
