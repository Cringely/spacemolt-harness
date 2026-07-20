# Durable Scheduler Stage 1: Implementation Plan (#114)

> **For agentic workers:** Execution follows `docs/wiki/team-structure.md` (PM → lead → implementer + independent reviewer per task). Batches: A (engine), B (D3 fence), C (spawns + D1), D (entry + health), E (runbook). A and B are independent; C needs A merged; D needs A + C; E lands last. Every batch PR is **security-relevant class** (spec §Security, verbatim: "the security-relevant-PR-class rules apply to the scheduler scripts themselves") — carry the relevant `docs/wiki/security-controls.md` register rows and get task-reviewer treatment. Branches `batch/sched-<x>-<name>`.

**Goal:** Stage 1 of the durable scheduler — a host-side cron poller on the always-on host that fires the four governance jobs (stand-up 2h, strategy 6h, council daily, steward on-merge) as fresh headless `claude -p` spawns against a dedicated host checkout, with anchored schedules + catch-up, flat-JSON state, the D1 capability gate ((a) filing ON with its 5 conditions; (b) dispatch structurally OFF; (c) never), and the D3 policy-path allowlist hook guarding stage 1's own write paths from day one.

**Spec:** `docs/superpowers/specs/2026-07-18-durable-scheduler.md` (council-approved, binding). Spec §Security, §Authority boundary, §Hardening, and the D1–D5 gates are inherited verbatim; this plan restates only what a task implements.

**NOT in stage 1 (YAGNI, per spec §Sequencing):** dead-man file + independent staleness alarm (stage 2); dispatch ledger, orphan sweep, persistent breaker, per-agent heartbeat, poke-first ladder, D4 quota floor (stage 3); quota polling (#183, stage 4); any HTTP surface (never, v1). **No task below depends on dead-vs-quiet heartbeat discrimination** — that is load-bearing unknown 1, stage 3's problem.

## Global constraints

- All tests offline: fake clock, fake fs (temp dirs), injected spawner/gh/git runners. **Zero live `claude -p` spawns, zero live gh calls, zero game traffic in tests.** `bun test && bun run typecheck` green before any task claims done.
- Tests that read `docs/` presence-gate with the `docsPresent` skipIf pattern (`test/doc-size.test.ts:36`) — the container image excludes `docs/` by design (L-20/#130 class; host-green verify-red).
- Zod stays the only runtime dependency. No new deps.
- Secrets: token values travel by child-process ENV only — never in argv, never logged, never in tests as real values (`docs/wiki/security-baseline.md`).
- Persisted-state schema tolerance (AGENTS.md): every state loader discards an artifact that no longer validates instead of crashing; each state file gets a predates-the-schema test.
- Main is PR-only; commits under the user's identity, no AI attribution.

## Design decisions this plan makes (receipts inline)

1. **Per-tick process, not a daemon.** Cron runs the poller every 10 min; it evaluates, spawns due jobs synchronously, exits. Restart-safety falls out of file-backed state; no systemd unit to manage on the host. Rejected daemon: adds lifecycle management stage 1 doesn't need.
2. **Single-instance lock + per-job timeout.** One tick at a time (lock file, stale-break); a hung spawn is killed at its per-job timeout. Without both, one hung `claude -p` blocks every ceremony forever.
3. **Anchor advances on ATTEMPT, success recorded separately.** Due = elapsed since last attempt ≥ cycle. A failing job retries at next grid point, never hot-loops every tick (L-3). Failure visibility = `failStreak` in state + `--health`; escalation/breaker is stage 3 by design.
4. **Grid schedules** (`period + offset`): stand-up 2h @ :07, strategy 6h @ :27, council 24h @ 06:19 local — the mandate's cadences, phase kept. Catch-up is inherent: the newest missed grid point fires immediately, exactly once (a day-long outage costs one cycle, never two — the anchored-schedules directive).
5. **Steward trigger = origin/main sha change + 20-min settle + self-skip.** Settle stops a 4-PR cluster dispatching 4 stewards; the self-skip (all new subjects match `^docs\(steward\)`) stops the steward's own merged PR re-triggering it forever (L-3).
6. **First-tick catch-up replaces ledger import.** Fresh anchors ⇒ all periodic jobs due ⇒ each fires once at install. That IS the absorption of `.claude/ceremony-ledger.json` — zero migration code; the workstation ledger retires at cutover (task E1).
7. **State dir outside the checkout** (`SCHEDULER_STATE_DIR`, default `~/.spacemolt-scheduler`): anchors.json, gates.json, cycle counters, lock, stop file, logs/, reports/. Survives checkout resets; never committed.
8. **Council report artifact stays host-side.** The read+comment PAT structurally cannot push a branch (spec §Security PAT split), so the daily report lands in `stateDir/reports/` + findings as issues; committing to `docs/council/` remains a workstation action. This resolves the spec's job-table/PAT seam in the security section's favor; flagged for the PM in every council run report.

---

## Batch A — schedule engine (pure, no side effects)

### Task A1: state module

**Files:** create `src/scheduler/state.ts`; test `test/scheduler-state.test.ts`.

**Produces:**
- `interface JobAnchor { lastAttemptAt: number | null; lastSuccessAt: number | null; lastResult: "ok" | "fail" | null; failStreak: number; stewardAnchorSha: string | null }`
- `loadAnchors(dir): Record<JobId, JobAnchor>` / `saveAnchors(dir, a)` — atomic write (tmp file + rename), Zod-validated per-job on load, **invalid or corrupt entries replaced by defaults, never a throw**.
- `acquireLock(dir, now, staleMs): boolean` / `releaseLock(dir)`; `stopRequested(dir): boolean` (sentinel stop file, squad checklist 1/3).

**Test — each catches a named breakage (temp dirs, no mocks needed):**
1. Truncated/corrupt `anchors.json` loads as defaults with no throw — catches: a half-written state file bricking every future tick (the chat-enum crash-loop class).
2. An anchors file missing `failStreak` (predates the schema) loads with default 0 — catches: schema tightening crashing on persisted state (binding AGENTS.md rule).
3. Save→load round-trip byte-stable; stale lock (age > staleMs) is broken, fresh lock is respected — catches: a crashed tick holding the lock forever = scheduler silently dead.

- [ ] Failing test → implement → `bun test test/scheduler-state.test.ts && bun run typecheck` → commit `feat(scheduler): flat-JSON state with atomic writes, lock, stop sentinel (#114)`

### Task A2: job table + due evaluation

**Files:** create `src/scheduler/jobs.ts`, `src/scheduler/due.ts`; test `test/scheduler-due.test.ts`.

**Produces:**
- `interface JobDef { id: "standup" | "strategy" | "council" | "steward"; schedule: { kind: "grid"; periodMs: number; offsetMs: number } | { kind: "main-merge"; settleMs: number }; charterPath: string; model: "haiku" | "sonnet"; patSecret: string /* a scoped read+comment PAT, or the steward's write-scoped PAT */; extraSecrets?: string[]; timeoutMs: number; allowedTools: string[] }`
- `JOBS`: stand-up grid 2h offset :07, haiku, `docs/charters/soc-monitor.md`, read+comment PAT, 15 min; strategy grid 6h offset :27, sonnet, `docs/charters/strategy-reviewer.md`, read+comment, `extraSecrets: ["instruct_bearer"]` (spec §Security: the strategy job alone reads the instruct-channel bearer token), 30 min; council grid 24h offset 06:19 local, sonnet, `docs/briefs/council-review.md` (task C4), read+comment, 45 min; steward main-merge settle 20 min, haiku, `docs/charters/doc-steward.md`, **the steward's write-scoped PAT**, 30 min. Cadences/charters are the spec §Job table verbatim — reviewer diffs them against the spec.
- `dueJobs(jobs, anchors, now, main: { headSha; headCommitAt; newSubjectsSinceAnchor: string[] }): { fire: JobDef[]; absorb: Array<{ jobId; sha }> }` — pure. Grid: due when the latest grid point ≤ now is after `lastAttemptAt` (null ⇒ due). Steward: due when `headSha ≠ stewardAnchorSha` AND head age ≥ settleMs AND not all new subjects are steward self-merges (those return as `absorb`).

**Test — fake clock, zero IO:**
1. 26h outage ⇒ exactly ONE catch-up fire per periodic job, then normal cadence — catches: both failure modes the anchored-schedules directive names (make-up burst; counter reset costing a second cycle).
2. Fresh anchors ⇒ all periodic jobs due — catches: first install scheduling nothing (this is the ledger absorption, decision 6).
3. Stand-up fired 09:07 ⇒ not due 10:57, due 11:07 — catches: drift off the mandated :07/2h grid.
4. Steward: sha change with head 5 min old ⇒ not due; ≥ 20 min ⇒ due; all-new-subjects `docs(steward):` ⇒ never fires, sha absorbed — catches: mid-cluster steward spam AND the steward self-trigger loop (L-3).
5. Job with `lastResult: "fail"` just attempted ⇒ not due until next grid point — catches: a failing job re-spawning every 10-min tick (L-3, token burn).

- [ ] Failing test → implement → verify → commit `feat(scheduler): job table + grid/merge due evaluation with catch-up (#114)`

---

## Batch B — D3 policy-path fence (independent of A)

### Task B1: policy-path gate script

**Files:** create `src/scheduler/policy-paths.ts`, `scripts/policy-path-gate.ts`; test `test/policy-path-gate.test.ts`.

**Produces:**
- `HEADLESS_WRITE_ALLOWLIST` (an ALLOWLIST — anything not on it is rejected headless): `docs/STATE.md`, `docs/milestones.md`, `docs/backlog.md`, `docs/decisions.md`, `README.md`, `docs/assets/**`, `docs/archive/**`, `docs/wiki/engineering-lessons.md` — exactly the doc-steward's write surface, nothing more.
- `POLICY_PATHS` (the council's fence list, for the disjointness check): `docs/charters/**`, `docs/briefs/**`, `docs/wiki/working-agreements.md`, `docs/wiki/security-controls.md`, `.claude/guardrails.md`, `AGENTS.md`.
- `isHeadless(username): boolean` — distinguishes the headless service context from an interactive developer. Chosen over an env flag because a spawned agent is harder to spoof this way.
- `checkStagedPaths(paths): { ok; rejected }`; CLI `bun scripts/policy-path-gate.ts --staged` reads `git diff --cached --name-only`, exits 1 naming rejects when headless, exit 0 otherwise.
- Script header documents the residual: a client-side hook can be bypassed (spec load-bearing unknown 2); the morning-read rule — any merge-ready PR touching a policy path gets full human review — is the paired last barrier.

**Test — pure fn + CLI against a temp git repo:**
1. Headless + staged `docs/charters/soc-monitor.md` ⇒ rejected — catches: THE (c) leak, the council pre-mortem's highest severity.
2. Headless + staged novel path (`src/x.ts`, `docs/wiki/new-page.md`) ⇒ rejected — catches: allowlist decaying into a denylist (explicit council condition).
3. Headless + staged `docs/STATE.md` + `docs/milestones.md` ⇒ allowed — catches: fence over-blocking the steward's legitimate PRs.
4. Workstation username, any path ⇒ allowed — catches: fence bricking normal dev commits.
5. Disjointness: no `POLICY_PATHS` entry matches `HEADLESS_WRITE_ALLOWLIST` — catches: a future allowlist edit silently re-opening the leak.

- [ ] Failing test → implement → verify → commit `feat(scheduler): D3 policy-path allowlist gate (#114)`

### Task B2: pre-commit hook shim

**Files:** create `.githooks/pre-commit`; extend `test/policy-path-gate.test.ts`.

**Produces:** sh shim beside the existing `.githooks/pre-push` (same `core.hooksPath` install, already configured per AGENTS.md): resolve repo root, exec `bun scripts/policy-path-gate.ts --staged`. If `bun` is absent: exit 0 for a workstation user, **exit 1 loudly for the service user** (fail closed exactly where the fence matters).

**Test:** temp git repo with `core.hooksPath` set; a commit staging a charter file with headless username injected (test-only env override consumed ONLY by the test harness path, documented) fails; a workstation commit passes. `skipIf` when `git`/`sh` unavailable (image context). Catches: shim wiring rot (non-executable hook, wrong path resolution) turning the fence decorative.

- [ ] Failing test → implement → verify → commit `feat(scheduler): pre-commit shim wires the D3 fence (#114)`

---

## Batch C — spawns + D1 (needs A)

### Task C1: D1 capability gates

**Files:** create `src/scheduler/gates.ts`; test `test/scheduler-gates.test.ts`.

**Produces:** `gates.json` default `{ fileFindings: { enabled: true }, dispatchFixAgents: { enabled: false, verifiedLiveAt: null }, amendOwnCharter: {} }` (lives in the state dir, loaded with the same schema-tolerant discipline as A1); `canFile(g)`; `canDispatch(g)` — true only when `enabled && verifiedLiveAt != null`; `canAmend()` — **returns false unconditionally, ignores the file**. Stage 1 ships no dispatch call site (structurally off); the gate exists so stage 3 wires one check.

**Test:**
1. `canAmend()` false even when a forged file claims enabled — catches: verdict (c) "never" degrading into a config flag.
2. `canDispatch` false with `enabled: true` but `verifiedLiveAt: null` — catches: a flag flip enabling dispatch without stage-3 live verification (verdict (b) condition 1).
3. Defaults: filing on, dispatch off — catches: shipping stage 1 with the gate inverted.

- [ ] Failing test → implement → verify → commit `feat(scheduler): D1 capability gates -- filing on, dispatch off, amend never (#114)`

### Task C2: finding filer (verdict (a) conditions 1–4, mechanical)

**Files:** create `src/scheduler/filing.ts`, `scripts/file-finding.ts`; test `test/scheduler-filing.test.ts`.

**Produces:**
- `fileFinding(gh: GhRunner, stateDir, { jobId, cycleId, dedupKey, title, bodyFile }) → { outcome: "created" | "bumped" | "capped"; issue? }` with `GhRunner` injected (`(args: string[]) ⇒ { stdout; exitCode }`).
- Behavior: dedup marker `<!-- sm-dedup:<key> -->` embedded in every body; dedup query via `gh issue list --state all --search "sm-dedup:<key> in:body" --json number,state,closedAt` (gh's `--json`/`--jq` only — external jq is absent on this host); match open OR closed ≤ 30d ⇒ `gh issue comment` bump carrying the job/cycle provenance line; otherwise `gh issue create` with label `machine-filed` + body line `filed-by: scheduler/<jobId> cycle <cycleId>`; per-cycle counter file in stateDir; **cap 5** (receipt: healthy cycles file 0–2 findings per the strategy ladder and council norms, so 5 is headroom, not a quota; the simpler no-cap alternative is exactly what verdict (a)(4) forbids) — overflow findings append to ONE per-cycle summary issue (created at first overflow).
- CLI `bun scripts/file-finding.ts --job X --cycle Y --dedup-key K --title T --body-file F`. Work orders (C3) instruct agents to file findings ONLY through it.
- Condition (a)(5) — filing decoupled from dispatch — is architectural, not testable as a negative: `filing.ts` imports no spawn/agent module and returns data only. **Reviewer verifies the import graph**; noted here so the check is owned.

**Test — fake gh runner:**
1. Open match ⇒ bump, no create — catches: duplicate-issue flood.
2. Match closed 10d ago ⇒ bump — catches: the closing-keyword incident class (open-only dedup refiling what a merge just closed) — condition (a)(1).
3. Match closed 45d ago ⇒ new issue — catches: dedup over-blocking a genuinely recurring defect.
4. Created issue carries `machine-filed` + provenance line — catches: unattributable machine issues (a)(2).
5. Sixth finding in a cycle ⇒ `capped`, one summary issue, no sixth issue; counter survives a process restart (file-backed) — catches: per-cycle flood (a)(4) and cap-reset-on-crash.

- [ ] Failing test → implement → verify → commit `feat(scheduler): mechanical finding filer under verdict (a) conditions (#114)`

### Task C3: spawn composer + runner

**Files:** create `src/scheduler/spawn.ts`; test `test/scheduler-spawn.test.ts`.

**Produces:**
- `composePrompt(job, { charterText, stateNow, cycleId }): string` — charter inlined VERBATIM (byte-identical block, charters README dispatch rule); STATE `## NOW` extract (empty/missing ⇒ the line `STATE NOW MISSING — flag this in your report`, never a throw); backlog pointer (`docs/backlog.md`); per-job work order: target + cycle id, reporting channel, per-task authorizations (strategy: the LOCAL `docker exec` store path + instruct channel per spec §Job table), and the standing **observe-and-file-only clause** (all jobs, stages 1–2): *"Capability gate D1: dispatch is OFF. Where your charter says dispatch an agent (reviewer, next wave, redispatch), instead FLAG it: comment on the PR or file via `bun scripts/file-finding.ts`. Never dispatch agents. Never merge."*
- `buildArgv(job)`: `["-p", "--output-format", "json", "--model", job.model, "--strict-mcp-config", "--no-session-persistence", "--allowedTools", ...job.allowedTools]` — prompt travels via STDIN (the ENAMETOOLONG lesson, `src/planner/claude-subscription.ts:44`); argv stays flags-only.
- `runJob(job, deps { spawner, clock, stateDir, checkoutDir, secretsDir })`: reads charter + STATE from checkout; child env = process env + `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN` read from `secretsDir` files, plus each `extraSecrets` entry exported as its uppercased filename (`instruct_bearer` → `INSTRUCT_BEARER`, strategy job only) — values touch ENV only; kills the spawn at `timeoutMs`; records result to anchors (ok/fail + failStreak); appends a jsonl run log under `stateDir/logs/`.
- `JOBS.allowedTools` (finalized here): closed per-job lists mirroring spec §What-it-executes — e.g. stand-up: `Read`, `Grep`, `Glob`, `Bash(gh *)`, `Bash(bun run scripts/repo-hygiene.ts)`, `Bash(bun scripts/file-finding.ts *)`; strategy adds its `Bash(docker exec *)` read + steer path and the gate/mark scripts; steward adds `Bash(git add *)`, `Bash(git commit *)`, `Bash(git checkout -b *)`, `Bash(git push origin *)`, `Bash(gh pr create *)`, `Bash(bun scripts/steward-prep.ts)`, vale — enumerated, never a bare `Bash(git *)` wildcard (closed-execution-list posture; the pre-push hook and the D3 fence stay the structural backstops behind the list); council adds `Task` (its outsider/insider/synthesis run as in-session subagents — that is its review method per the brief, not capability-(b) dispatch). No list contains a package manager or an unscoped shell.

**Test — injected spawner/clock/fs, zero live spawns:**
1. Charter text appears byte-identical inside the composed prompt — catches: paraphrase drift, the failure charters exist to kill.
2. Empty `docs/STATE.md` ⇒ prompt carries the MISSING marker and the spawn proceeds — catches: an empty handoff crashing every ceremony. Not hypothetical: STATE.md shipped 0 bytes to main in #375 (restored by #377).
3. Neither token value appears anywhere in argv (assert on joined argv with sentinel token strings) — catches: a secret on a command line (security-baseline; visible in `ps` and logs).
4. Spawner that never resolves ⇒ killed at `timeoutMs`, result fail, failStreak+1, anchor advanced — catches: one hung `claude -p` blocking every later tick (fatal under the single lock, decision 2).
5. All four composed work orders contain the observe-and-file-only clause — catches: the headless stand-up following its charter's "dispatch the next wave" step (a capability-(b) leak at stage 1).
6. Every job's `allowedTools` is explicit, contains no `bun add|install|update|remove` / `npm` form, and the steward list contains no bare `Bash(git *)` wildcard — catches: closed-execution-list violation (spec §Security; LLM output is untrusted input) and wildcard regression on the one write-scoped job.
7. Strategy spawn env contains the `INSTRUCT_BEARER` value; the other three jobs' envs do not — catches: a dead steer lever (spec §Security gives the bearer token to the strategy job) and secret over-broadcast to jobs with no use for it.

- [ ] Failing test → implement → verify → commit `feat(scheduler): charter-armed spawn composer + runner, observe-and-file-only (#114)`

### Task C4: council brief file + charter/tier spanning test

**Files:** create `docs/briefs/council-review.md`; test `test/scheduler-briefs.test.ts`.

**Produces:** the daily-council work-order brief as a versioned file (the #114-body ritual, which today exists only as issue prose written for an in-session PM, with exactly the stage-1 edit the spec §Job table mandates): outsider seat (code + one-paragraph what-this-is, NO rationale context) + insider seat (goals/decisions context) + synthesis; REPORT/PROPOSE only, never auto-remove code; **findings filed as backlog issues via `bun scripts/file-finding.ts` under verdict (a)'s conditions**; dated report written to `stateDir/reports/<date>-council-review.md` and flagged for PM pickup (decision 8 — the read+comment PAT cannot push; `docs/council/` commits stay workstation actions); a `## Tier` line (sonnet). Content fidelity to the #114 body is a PR-review criterion — no invented ritual. This is a brief, not a charter: the four charters stay untouched (spec §Non-goals), and `docs/briefs/**` sits inside the D3 fence (B1), so it is headless-unwritable like the charters.

**Test (`skipIf(!docsPresent)`):**
1. Every `JOBS` charter/brief path exists and is non-empty — catches: a renamed charter arming an empty identity at 2h cadence.
2. Each charter/brief's `## Tier` line names the same model family as `JOBS[i].model` — catches: a charter tier change (the operator's model-pin lever) silently not mirrored into the scheduler = wrong spend on every fire.

- [ ] Failing test → write brief → verify → commit `docs(scheduler): council work-order brief, filing-enabled per verdict (a) (#114)`

---

## Batch D — tick entry + health (needs A + C)

### Task D-Tick: tick orchestration + entry script

**Files:** create `src/scheduler/tick.ts`, `scripts/scheduler.ts`; test `test/scheduler-tick.test.ts`.

**Produces:**
- `tick(deps { clock, stateDir, checkoutDir, secretsDir, gitRunner, spawner })`: stop sentinel ⇒ exit clean before any work; lock or exit; `git fetch origin main` + read head sha/subjects via injected gitRunner (`git pull` of the checkout itself belongs to the wrapper, task E1); `dueJobs()`; run due jobs SEQUENTIALLY via C3, updating anchors per job; absorb steward self-shas; prune `stateDir/logs` + `reports` entries older than 14d (squad checklist 5; receipt: 14d spans two operator morning-read gaps of vacation length while any run worth keeping longer has already been filed as an issue or picked up as a report — the simpler no-prune alternative is the unbounded scratch growth the checklist item exists to stop); release lock.
- `scripts/scheduler.ts` subcommands `tick` (default) and `health` (task D-Health); wires real deps. **Refuses to run (exit 2, usage) when `SCHEDULER_STATE_DIR` is unset** — a bare workstation `bun scripts/scheduler.ts` must never fire four LLM jobs by accident (no-live-calls rule).

**Test — everything injected, one scenario walk:**
1. Fresh state, tick at T ⇒ stand-up + strategy + council spawn once each (catch-up), steward doesn't (no sha delta); tick T+10min ⇒ zero spawns; T+2h ⇒ stand-up only; fake merge sha then tick inside settle ⇒ no steward, after settle ⇒ steward fires — catches: the whole stage-1 contract ("never more than N hours unreviewed") miswired end to end.
2. Stop file present ⇒ zero spawns, zero state writes — catches: sentinel ignored (graceful shutdown/pause).
3. Lock held by a live tick ⇒ second tick exits without spawning — catches: overlapping pollers double-firing a job.
4. First job's spawner rejects ⇒ later jobs still run; failStreak recorded — catches: one failing job silencing all ceremonies.
5. 20d-old log pruned, 2d-old kept — catches: unbounded scratch growth.
6. `SCHEDULER_STATE_DIR` unset ⇒ exit 2 before any side effect — catches: accidental live workstation run.

- [ ] Failing test → implement → verify → commit `feat(scheduler): tick entry -- lock, sentinel, sequential spawns, prune (#114)`

### Task D-Health: `--health` probe

**Files:** create `src/scheduler/health.ts`; extend `scripts/scheduler.ts`; test `test/scheduler-health.test.ts`.

**Produces:** `health(stateDir, jobs, now): string` — per job: last attempt/success, result, failStreak, next due (grid point or "on next main merge"); anchor ages; gates summary (`filing ON / dispatch OFF / amend NEVER`); stop-file and lock presence; last tick time. Positive signal, never inferred from silence (L-17). Ledger summary arrives with stage 3; not printed.

**Test:** fixture state renders a row per job, the gates line, and surfaces `failStreak > 0` prominently — catches: silent job failure invisible to the operator (until stage 2's alarm exists, `--health` is the only window; a probe that hides the failing job is worse than none).

- [ ] Failing test → implement → verify → commit `feat(scheduler): --health probe (#114)`

---

## Batch E — host install runbook (docs; operator/PM hands)

### Task E1: `docs/wiki/scheduler-runbook.md` + tick wrapper

**Files:** create `docs/wiki/scheduler-runbook.md`, `scripts/scheduler-tick.sh` (wrapper: sources a host env file, `git pull --ff-only` the checkout, exports tokens from secret files into env, exec `bun scripts/scheduler.ts tick`); edit `docs/wiki/seam-manifest.md` (append the cron-phase ↔ grid-offset seam row — this task owns that row, step 6 below is where it points).

**Runbook content — numbered install checklist, each step tagged OPERATOR (needs host/GitHub hands) or PM (scriptable over SSH):**
1. OPERATOR — create non-root service user `sched` on the always-on host; home directory `/srv/spacemolt-sched/` (any persistent path the host provides) with `checkout/`, `state/`, `secrets/` (0700, sched-owned).
2. OPERATOR — secrets (all 0600): `claude_oauth_token` (`claude setup-token` on the workstation, transfer via scp); a scoped read+comment PAT — fine-grained, no write scope, structurally merge-incapable (comment/flag only); a steward PAT — same plus write scope confined to the steward role (the named residual: charter + D3 fence + morning read carry that load, spec §Security); `instruct_bearer` (copy from harness secrets). PAT expiry + renewal date noted in the runbook.
3. PM — host prereqs as sched: bun (release tarball, checksum-verified — never curl|bash, security-baseline), `bun install -g @anthropic-ai/claude-code@<pinned version>`, gh CLI (release binary, checksum), verify git + python3 present (steward-prep runs `gen-backlog.py`), install vale + copy the prose-lint styles dir (steward charter step 8 runs on this host now; without vale the steward must report step 8 blocked every pass).
4. PM — checkout: `git clone` via https using the read PAT (`gh auth login --with-token`), `git config core.hooksPath .githooks` (**activates the D3 fence + pre-push guard before the first spawn ever runs**), `bun install --frozen-lockfile`. Provision the filing label before the first fire: `gh label create machine-filed --description "filed by the durable scheduler (#114)"` (idempotent-guarded; C2's `gh issue create --label machine-filed` fails on a repo without it — verified absent today).
5. PM — host env file `~/.config/spacemolt-sched.env`: `SCHEDULER_STATE_DIR`, `SCHEDULER_CHECKOUT`, `SCHEDULER_SECRETS` paths only — no secret values inline.
6. OPERATOR — a cron job on the always-on host (a crontab entry, or the host's cron manager UI): user `sched`, schedule `7,17,27,37,47,57 * * * *`, command `scripts/scheduler-tick.sh`. The :07 tick phase matches the jobs.ts grid offsets — these two MUST agree (seam row added to `docs/wiki/seam-manifest.md`, spanning check = the A2 offset tests pin one side, this runbook line cites the same constants).
7. PM — first-tick verification: expect the catch-up burst (stand-up, strategy, council fire once each — decision 6; this replaces any ceremony-ledger import), then `bun scripts/scheduler.ts health`, read `state/logs/`.
8. PM — cutover: stop the session-side ceremony crons; edit the `docs/wiki/team-ceremonies.md` ledger paragraph to name the scheduler state as the anchor owner (normal docs PR); `.claude/ceremony-ledger.json` retires.
9. Standing operator notes: until stage 2, `--health` is manual — there is no automatic staleness alarm yet; the morning read treats ANY merge-ready PR touching a policy path as full human review (D3 residual: a client-side hook can be bypassed — the hook and this habit are jointly the fence); scheduler-script PRs stay security-relevant class.

**Done-criteria:** a PM with SSH access and this page alone completes every PM-tagged step; every step needing operator hands is tagged inline. No test (docs); prose-lint instead, false positives named in the PR body.

- [ ] Write runbook + wrapper → prose-lint → commit `docs(scheduler): host install runbook + tick wrapper (#114)`

---

## Exit criteria for stage 1

- All batches merged; `bun test && bun run typecheck` green on main.
- Host install completed per E1; first catch-up burst observed; `--health` reads clean; D3 fence verified live by attempting a headless commit of a charter path (must fail).
- Eval check (spec §Mandate): compare the next /usage panel against the 62% / 31% baselines after the jobs have run headless for a representative window.
- Stage 2 (dead-man + staleness alarm) is the next plan; nothing here pre-builds it.
