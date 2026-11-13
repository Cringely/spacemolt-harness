// Durable scheduler (#114) Task A2: the job table. Cadences, charters, tiers,
// and PAT split are the spec §Job table + §Security verbatim — a reviewer
// diffs this file against docs/superpowers/specs/2026-07-18-durable-scheduler.md.
//
// allowedTools (finalized in Task C3): per-job lists mirroring spec
// §What-it-executes — LLM output is untrusted input, so anything absent from
// a list is not granted. No package managers, no unscoped shell, and never a
// bare `Bash(git *)` or `Bash(gh *)` wildcard; the pre-push hook and the D3
// fence stay the structural backstops BEHIND the lists
// (test/scheduler-spawn.test.ts pins the grant posture).
//
// A list is an ALLOW list, additive on its own: it does not close the tool
// set (Cringely/spacemolt#865: read-only Bash ran with no grant, and a bare
// `Read` matches every path, not just the worktree). The set is closed by
// buildArgv (spawn.ts), which passes `--restricted` and a `--tools` list
// derived from the lists below by toolNames(), so each list stays defined
// here once.
//
// #490: a bare `Bash(gh *)` on council/standup/strategy let the spawned agent
// run `gh issue create`/`gh issue comment` directly, unscoped, bypassing the
// mechanical filer (scripts/file-finding.ts → src/scheduler/filing.ts) that
// scopes every gh issue call to Cringely/spacemolt — the same failure class
// spacemolt-harness#14 fixed for the code path, one layer up. Every job's gh
// grant is now an enumerated read (or, for standup, a PR comment it already
// used) list, mirroring steward's style; filing stays exclusively through
// file-finding.ts, which is unaffected (it runs as the harness process, not
// through the agent's Bash allowedTools).
import { BODY_DIR } from "./body-arg";
import { HEADLESS_WRITE_ALLOWLIST } from "./policy-paths";

// BODY_EDIT: the ONE file-writing grant the four non-steward jobs hold, so a job
// can hand a long body (finding, report, steer text, dedupe pairs) to its script
// as a FILE it writes with the Write tool and names with `--body-file`
// (spawn.ts BODY_FILE_HOWTO; body-arg.ts readBodyFile reads only from BODY_DIR).
// Each work order demands a body, and the first fix granted `Bash(printf *)` +
// `Bash(base64 -w 0)` and told jobs to run `printf '<text>' | base64 -w 0`:
// untrusted text inside a single-quoted shell argument is injection, and
// `printf *` is a free-form wildcard (security review of PR 171, HIGH). The
// second fix granted BARE `Write` and was rated CRITICAL: a job could overwrite
// scripts/file-finding.ts and then run it through its own Bash grant, or write
// gates.json and the state dir. Rejected: that encoder pair; bare Write;
// `gh issue list --jq @base64` (#1002), which only jobs holding a gh grant
// could use; a plain-text flag, which would put untrusted text on a command
// line.
//
// The scoped form is `Edit(./.job-body/**)`, NOT `Write(./.job-body/**)`: the
// permissions docs say Claude Code accepts a `Write(path)` rule but never
// matches a write against it (docs, "Write(path), Glob(path), and Grep(path)
// rules don't match"; read 2026-11-13, not exercised live), and that `Edit`
// rules apply to every built-in file-editing tool, Write included. A
// `Write(path)` allow would therefore grant nothing and read as protection.
// toolNames() adds the Write tool name beside Edit so `--tools` (PR 158) still
// exposes it. buildArgv adds explicit Edit denies over scripts/, src/, .claude/,
// the manifests and the state dir, so a later broader grant cannot reach them
// by omission.
export const BODY_EDIT = `Edit(./${BODY_DIR}/**)`;

export interface JobDef {
  id: "standup" | "strategy" | "council" | "steward" | "dedupe";
  schedule: { kind: "grid"; periodMs: number; offsetMs: number } | { kind: "main-merge"; settleMs: number };
  charterPath: string;
  model: "haiku" | "sonnet";
  patSecret: "gh_pat_readcomment" | "gh_pat_steward";
  extraSecrets?: string[];
  timeoutMs: number;
  allowedTools: string[];
}

/**
 * The built-in tool names a job's grant list names: `Bash(gh pr list *)` becomes
 * `Bash`, deduped. An `Edit` grant also names `Write`: Claude Code checks the
 * Write tool against Edit rules and ignores a `Write(path)` rule, so a scoped
 * Edit grant is the only way to let a job create a file, and without the tool
 * name here `--tools` would close the Write tool the grant exists for.
 */
export function toolNames(allowedTools: string[]): string[] {
  const names = allowedTools.map((t) => t.replace(/\(.*$/, ""));
  if (names.includes("Edit")) names.push("Write");
  return [...new Set(names)];
}

const MIN = 60_000;
const HOUR = 3_600_000;

// Grid schedules are epoch-anchored (period + offset in plain UTC ms): a grid
// point is any t ≡ offsetMs (mod periodMs). That keeps due-evaluation pure and
// timezone-free. ponytail: the council's mandated "~06:19 local" phase is
// expressed here as a UTC offset — matching the LOCAL clock exactly would buy
// TZ+DST math a daily job doesn't need; the runbook (task E1) owns the cron
// seam and can shift this constant if the operator wants the local-hour phase.
export const JOBS: JobDef[] = [
  {
    id: "standup",
    schedule: { kind: "grid", periodMs: 2 * HOUR, offsetMs: 7 * MIN }, // every 2h at :07
    charterPath: "docs/charters/soc-monitor.md",
    model: "haiku",
    patSecret: "gh_pat_readcomment",
    timeoutMs: 15 * MIN,
    // #490: was `Bash(gh *)` — token-bounded by the merge-incapable
    // read+comment PAT, but still let the agent run `gh issue create`/
    // `gh issue comment` directly. Narrowed to the four PR-triage
    // subcommands the charter's step 2 and this job's work order actually
    // use (list/view/checks to triage, comment to flag merge-ready) — no
    // issue read/write; issues route through file-finding.ts only.
    //
    // #654: `bun scripts/read-latest-report.ts *` is the ONE way this job can
    // check council freshness. It has NO `Bash(ls *)`/`Bash(find *)`/
    // `Bash(printenv *)` grant, and none is added here — those would still
    // leave the agent needing to resolve $SCHEDULER_STATE_DIR into a literal
    // path itself, which it structurally cannot do (that is the root cause
    // of the false "council stalled" P0s: every prior lookup attempt was
    // DENIED and the denial got reported as absence). The script resolves
    // the state dir in Node, inside the child process, and always emits an
    // unambiguous FOUND/NO_MATCHING_REPORT_FOUND — nothing left to
    // misinterpret as a permission denial.
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash(gh pr list *)",
      "Bash(gh pr view *)",
      "Bash(gh pr checks *)",
      "Bash(gh pr comment *)",
      "Bash(bun run scripts/repo-hygiene.ts)",
      "Bash(bun scripts/file-finding.ts *)",
      "Bash(bun scripts/read-latest-report.ts *)",
      BODY_EDIT,
    ],
  },
  {
    id: "strategy",
    schedule: { kind: "grid", periodMs: 6 * HOUR, offsetMs: 27 * MIN }, // every 6h at :27
    charterPath: "docs/charters/strategy-reviewer.md",
    model: "sonnet",
    patSecret: "gh_pat_readcomment",
    // #114 A1 pivot (2026-07-19): the operator rejected the SSH forced-command
    // design (a root-equivalent key on the store host). The three store
    // ops now cross an authenticated HTTP boundary instead
    // (scripts/strategy-store.ts → src/server/server.ts /api/store/*), so the
    // job needs a bearer, not an SSH key. store_bearer → STORE_BEARER (env,
    // never argv), read by strategy-store.ts, structurally separate from the
    // dashboard's #173 token and from gh_pat_readcomment above.
    //
    // sm_store_url → SM_STORE_URL (#476): the store's base URL (proto/host/port
    // reachable from the scheduler host) is a deploy-time fact the job needs
    // right beside the bearer, so it rides the SAME extraSecrets seam — a
    // defined, version-controlled source, not an unset host env var that
    // silently ERRORs the step-0 gate (exit 2) and blocks every review. Wired
    // like store_bearer on purpose: buildEnv reads secrets/sm_store_url and
    // aborts the spawn (naming the file) if it is missing, so an unprovisioned
    // URL fails LOUD before a spawn, not silently mid-review (L-21). It is
    // provisioned out-of-band into $SCHEDULER_SECRETS by the operator/PM, the
    // same as the bearer; neither lives in any committed env example.
    extraSecrets: ["store_bearer", "sm_store_url"],
    timeoutMs: 30 * MIN,
    // Store access is the ONE thin caller (#114 A1): the scheduler runs on a
    // separate host, the store lives in a container on another host, so the
    // four fixed ops (gate/mark/dump, plus steer since #495) cross an HTTP
    // boundary as authenticated routes on
    // the harness's own server (scripts/strategy-store.ts). NO
    // `Bash(ssh *)`/`Bash(docker exec *)` and NO local gate/mark grants:
    // nothing here can run an arbitrary command on any host -- that surface is
    // what A1 closes, twice now (first the docker-over-SSH `bun run -`
    // arbitrary read, then the forced-command SSH key itself).
    // `bun scripts/strategy-store.ts *` is one single-line argv the headless
    // permission layer matches whole (L-39). The dated report writes through
    // the jailed write-report script, from a body file the job wrote under
    // BODY_DIR with its scoped grant (see the note above JobDef).
    // #490: dropped the `Bash(gh *)` wildcard — neither the charter nor this
    // job's work order (spawn.ts) ever calls gh directly. The issue-bump
    // lever routes through file-finding.ts's own dedup (bump-not-refile), and
    // the steer lever (#495) is a FOURTH op on the strategy-store grant right
    // above — an authenticated POST to /api/store/:agentId/steer carrying the
    // instruction text as a single base64 argv token, never a gh call. (The
    // comment here previously called the steer "a store-side note"; it was
    // written while the lever had no transport at all, and a note is ladder
    // step 3, a different lever entirely.) No gh grant at all is still the
    // correct-and-smallest fix here, not a narrowed read list — and the steer
    // op needs no allowedTools change, since `Bash(bun scripts/strategy-store.ts *)`
    // already matches the whole single-line command (L-39).
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash(bun scripts/strategy-store.ts *)",
      "Bash(bun scripts/file-finding.ts *)",
      "Bash(bun scripts/write-report.ts *)",
      BODY_EDIT,
    ],
  },
  {
    id: "council",
    schedule: { kind: "grid", periodMs: 24 * HOUR, offsetMs: 6 * HOUR + 19 * MIN }, // daily at 06:19
    charterPath: "docs/briefs/council-review.md", // versioned brief, task C4
    model: "sonnet",
    patSecret: "gh_pat_readcomment",
    timeoutMs: 45 * MIN,
    // No Task: the outsider/insider seats were in-session subagents until
    // Cringely/spacemolt#865, where a Task subagent's Bash was not held to
    // this list. The brief now has the job run the seats itself, in order.
    // The dated report writes through the jailed write-report script, from a
    // body file the job wrote under BODY_DIR (see the note above JobDef).
    //
    // #490: narrowed the `Bash(gh *)` wildcard to the one read the brief's
    // §Triage step documents (`gh issue list --search`, docs/briefs/
    // council-review.md). `gh issue view` is kept alongside it out of
    // caution — the brief doesn't name it, but ranking a listed issue
    // plausibly needs its full body, so it stays enumerated rather than cut
    // on a guess. No issue-write, no PR access: neither the charter nor the
    // brief documents council reading or touching PRs.
    //
    // `bun scripts/read-latest-report.ts *` (Cringely/spacemolt#717): the
    // brief's Triage step needs the previous report's date, and council had
    // no command able to find its own report, so it guessed a 24h window.
    // Same jailed reader stand-up holds (#654), not an `ls`/`find` grant.
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash(gh issue list *)",
      "Bash(gh issue view *)",
      "Bash(bun scripts/file-finding.ts *)",
      "Bash(bun scripts/write-report.ts *)",
      "Bash(bun scripts/read-latest-report.ts *)",
      BODY_EDIT,
    ],
  },
  {
    id: "steward",
    // #1136 fix-round: 20 min was shorter than the QUIET GAPS a real merge
    // cluster leaves between its own merges -- replaying the recorded
    // cluster timestamps found gaps of 46, 35 and 26 minutes where nothing
    // merged mid-cluster, each one long enough to cross a 20-min settle and
    // fire the ceremony BEFORE the cluster was actually done (the #106/#125/
    // #134 first-firing races). 60 min clears all three with margin while
    // staying far inside the issue's week-long done-when horizon. It also
    // means the stewardPrInFlight probe (steward-standdown.ts) now runs
    // after the PM's own dispatched-pass turnaround (observed at 2-17 min
    // post-cluster), not before the PM PR exists to be probed for.
    schedule: { kind: "main-merge", settleMs: 60 * MIN }, // origin/main sha change + settle
    charterPath: "docs/charters/doc-steward.md",
    model: "haiku",
    patSecret: "gh_pat_steward", // the one contents:write PAT (spec §Security residual)
    timeoutMs: 30 * MIN,
    // The ONE job whose PAT could technically merge, so nothing here is
    // wildcarded: git and gh are enumerated per-subcommand (no `Bash(git *)`,
    // no `Bash(gh *)`) — create the docs PR, never merge it. Its Edit grant is
    // scoped to HEADLESS_WRITE_ALLOWLIST (the doc-steward write surface, one
    // definition in policy-paths.ts) plus BODY_DIR: a bare Edit here would let
    // the one contents:write job overwrite scripts/file-finding.ts and run it
    // through its own Bash grant (security review of PR 171, CRITICAL). Nothing
    // is lost: the D3 fence (policy-path allowlist hook) and the pre-push guard
    // already reject a commit touching any path off that list. Edit rules cover
    // the Write tool (see the note above JobDef), so it can create files there.
    // Read-only git/gh forms (status, diff, list, view) included so
    // reconciliation per the charter does not dead-end on a denied lookup.
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      ...HEADLESS_WRITE_ALLOWLIST.map((p) => `Edit(${p})`),
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(git checkout -b *)",
      "Bash(git push origin *)",
      "Bash(gh pr create *)",
      "Bash(gh pr list *)",
      "Bash(gh pr view *)",
      "Bash(gh issue list *)",
      "Bash(gh issue view *)",
      "Bash(bun scripts/steward-prep.ts)",
      "Bash(bun scripts/file-finding.ts *)",
      "Bash(vale *)",
      BODY_EDIT,
    ],
  },
  {
    // #1135: the weekly backlog dedupe ceremony
    // (docs/superpowers/specs/2026-09-22-backlog-dedupe-ceremony.md). The
    // spawned agent is the spec's third, semantic pass and nothing more: the
    // deterministic passes and every tracker write live in
    // scripts/backlog-dedupe.ts, which posts only when the operator's
    // gates.json dedupePosting gate is on (default OFF: a dry run that reads
    // the tracker and writes a local report). No gh grant at all, and — fix
    // round on PR #143 — no `Bash(bun scripts/file-finding.ts *)` grant
    // either: that script writes to the tracker on ITS OWN gate
    // (fileFindings, default ON), a different switch from dedupePosting, so
    // holding it let a dedupePosting-off run still file issues and post bump
    // comments straight from untrusted issue excerpts. backlog-dedupe.ts is
    // now the only thing that talks to the tracker for this job, and the
    // agent hands it bare issue-number pairs (see seam-manifest.md §9).
    id: "dedupe",
    // Weekly, Mondays 03:47 UTC (epoch day 0 was a Thursday, so +4 days).
    schedule: { kind: "grid", periodMs: 7 * 24 * HOUR, offsetMs: 4 * 24 * HOUR + 3 * HOUR + 47 * MIN },
    charterPath: "docs/charters/backlog-dedupe.md",
    model: "sonnet",
    patSecret: "gh_pat_readcomment",
    timeoutMs: 30 * MIN,
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash(bun scripts/backlog-dedupe.ts *)",
      BODY_EDIT,
    ],
  },
];
