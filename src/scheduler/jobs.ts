// Durable scheduler (#114) Task A2: the job table. Cadences, charters, tiers,
// and PAT split are the spec §Job table + §Security verbatim — a reviewer
// diffs this file against docs/superpowers/specs/2026-07-18-durable-scheduler.md.
//
// allowedTools (finalized in Task C3): CLOSED per-job lists mirroring spec
// §What-it-executes — LLM output is untrusted input, so anything absent from
// a list is forbidden. No package managers, no unscoped shell, and never a
// bare `Bash(git *)` or `Bash(gh *)` wildcard; the pre-push hook and the D3
// fence stay the structural backstops BEHIND the lists
// (test/scheduler-spawn.test.ts pins the closed-list posture).
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
export interface JobDef {
  id: "standup" | "strategy" | "council" | "steward";
  schedule: { kind: "grid"; periodMs: number; offsetMs: number } | { kind: "main-merge"; settleMs: number };
  charterPath: string;
  model: "haiku" | "sonnet";
  patSecret: "gh_pat_readcomment" | "gh_pat_steward";
  extraSecrets?: string[];
  timeoutMs: number;
  allowedTools: string[];
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
    // three fixed ops (gate/mark/dump) cross an HTTP boundary as authenticated routes on
    // the harness's own server (scripts/strategy-store.ts). NO
    // `Bash(ssh *)`/`Bash(docker exec *)` and NO local gate/mark grants:
    // nothing here can run an arbitrary command on any host -- that surface is
    // what A1 closes, twice now (first the docker-over-SSH `bun run -`
    // arbitrary read, then the forced-command SSH key itself).
    // `bun scripts/strategy-store.ts *` is one single-line argv the headless
    // permission layer matches whole (L-39). The dated report writes through
    // the jailed write-report script (bare Write is banned — Claude Code does
    // not honor Write(path) scoping, and an unscoped Write could tamper
    // docs/charters/* on disk where the commit-time D3 fence never looks).
    // #490: dropped the `Bash(gh *)` wildcard — neither the charter nor this
    // job's work order (spawn.ts) ever calls gh directly. The issue-bump
    // lever routes through file-finding.ts's own dedup (bump-not-refile), and
    // the steer lever is a store-side note, not a gh call. No gh grant at all
    // is the correct-and-smallest fix here, not a narrowed read list.
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Bash(bun scripts/strategy-store.ts *)",
      "Bash(bun scripts/file-finding.ts *)",
      "Bash(bun scripts/write-report.ts *)",
    ],
  },
  {
    id: "council",
    schedule: { kind: "grid", periodMs: 24 * HOUR, offsetMs: 6 * HOUR + 19 * MIN }, // daily at 06:19
    charterPath: "docs/briefs/council-review.md", // versioned brief, task C4
    model: "sonnet",
    patSecret: "gh_pat_readcomment",
    timeoutMs: 45 * MIN,
    // Task = the outsider/insider/synthesis seats as in-session subagents —
    // the brief's review METHOD, not capability-(b) dispatch (plan §C3);
    // the dated report writes through the jailed write-report script (bare
    // Write banned — see the strategy job's note).
    //
    // #490: narrowed the `Bash(gh *)` wildcard to the one read the brief's
    // §Triage step documents (`gh issue list --search`, docs/briefs/
    // council-review.md). `gh issue view` is kept alongside it out of
    // caution — the brief doesn't name it, but ranking a listed issue
    // plausibly needs its full body, so it stays enumerated rather than cut
    // on a guess. No issue-write, no PR access: neither the charter nor the
    // brief documents council reading or touching PRs.
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Task",
      "Bash(gh issue list *)",
      "Bash(gh issue view *)",
      "Bash(bun scripts/file-finding.ts *)",
      "Bash(bun scripts/write-report.ts *)",
    ],
  },
  {
    id: "steward",
    schedule: { kind: "main-merge", settleMs: 20 * MIN }, // origin/main sha change + settle
    charterPath: "docs/charters/doc-steward.md",
    model: "haiku",
    patSecret: "gh_pat_steward", // the one contents:write PAT (spec §Security residual)
    timeoutMs: 30 * MIN,
    // The ONE job whose PAT could technically merge, so nothing here is
    // wildcarded: git and gh are enumerated per-subcommand (no `Bash(git *)`,
    // no `Bash(gh *)`) — create the docs PR, never merge it. Edit is its
    // living-docs remit (all existing files; bare Write is banned fleet-wide
    // — Write(path) scoping is not honored — so a NEW doc file gets flagged
    // for the PM instead of created headless); the D3 fence (policy-path
    // allowlist hook) and the pre-push guard back the list structurally.
    // Read-only git/gh forms (status, diff, list, view) included so
    // reconciliation per the charter does not dead-end on a denied lookup.
    allowedTools: [
      "Read",
      "Grep",
      "Glob",
      "Edit",
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
    ],
  },
];
