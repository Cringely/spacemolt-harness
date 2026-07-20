# Durable Scheduler — Design Spec (#114)

Date: 2026-07-18
Status: Council-approved. The spec-gate council settled the self-correction boundary on 2026-07-18 (verdict recorded on #114); sections marked binding are not up for re-litigation. Stage-1 build follows, per the operator mandate.

## Mandate

Operator direction (#114 mandate comment, 2026-07-14, verbatim): "build the system portable and durable enough that they can continue interacting with the PM in the current conversational manner via CLI — the interface stays, the plumbing beneath becomes session-independent."

The build is the resilience fix and the cost fix at once (#114 mandate comment):

- **Resilience.** Every governance loop (2h stand-up, 6h strategy review, daily council) runs today as a session-scheduled cron that dies with the PM session (team-ceremonies.md, scheduling notes). The 6h strategy review died when the workstation shut down on 2026-07-14 (the operator's motivating datum, #114 session-close comment); the ceremony catch-up rule papers over the gap but doesn't close it.
- **Cost.** The operator's /usage panel (2026-07-14, logged in #183) attributes 62% of usage to sessions at >150k context and 31% to general-purpose subagents — the long-running PM session is itself a first-order cost driver. A fresh charter-armed spawn boots on ~5-10k tokens (charter + STATE.md + backlog) against 150k+ inside a standing session: a 15-30x per-job reduction (#114 mandate comment).

## Goals

1. Every scheduled ceremony survives workstation sleep, PM-session death, and scheduler restarts — the schedule's durability is never coupled to an LLM session (#114 squad-council comment, point 1).
2. Per-job cost drops to the fresh-spawn floor: each job boots from charter + STATE.md `## NOW` + backlog pointer alone.
3. PM portability: any fresh CLI session boots as PM from repo state alone (STATE `## NOW` + charters + working-agreements + memory). The conversational interface the operator keeps is a view onto durable state, not the container of it; the compaction-handoff protocol becomes the boot protocol (#114 mandate comment, point 3).

**Eval (before/after, per house rules — sdlc-practices.md).** The next /usage panel: the >150k-context share (baseline 62%) and the general-purpose-subagent share (baseline 31%) both drop, or this didn't work (#114 mandate comment; baselines from #183, 2026-07-14).

## Architecture

### Placement

The always-on host: the machine that runs the harness container, always powered. Not the workstation (sleeps), not an LLM session (dies). Plain OS cron / systemd-timer entries drive it (#114 mandate comment, point 1). The scheduler is a host process, not a compose service — it adds no container and no network surface.

### Dumb poller / smart agent

The decomposition the squad council specified (#114 squad-council comment, point 1; squad-evaluation comment: poller writes a context snapshot, the spawned agent decides — the dispatcher-never-does-domain-work rule). The poller is deterministic script, zero tokens, zero judgment:

```
cron/systemd tick
  └─ poller
       evaluate anchors (catch-up rule)      ── job due? ──► spawn fresh headless agent
       write dead-man timestamp                                (charter verbatim + STATE NOW
       sweep dispatch ledger (orphans)                          + backlog pointer + work order)
       prune stale scratch dirs/logs                                  │
                                                                      ▼
                                                            report artifact + gh comments
                                                            (flag merge-ready, never merge)
```

Work selection, interpretation, and reporting belong to the spawned agent; the poller only decides *that* a job is due, never *what* the job should do.

### Spawns

Fresh headless `claude -p` per job. The charter file is inlined verbatim (docs/charters/README.md, dispatch rule — never paraphrased); the work order adds the task-specific part (target, per-task authorizations, reporting channel). Spawns execute on the host against a dedicated repo checkout, `git fetch`/`pull`ed before each spawn — not against the container image, which does not carry `docs/` (L-20 class; see Security). Moving any spawn into a container later must carry its files into the image's copy path and re-verify (L-20, engineering-lessons.md).

### Job table

| Job | Cadence / trigger | Charter / brief | Tier (from charter) |
|---|---|---|---|
| Stand-up | every 2h at :07 | `docs/charters/soc-monitor.md` | Haiku, low |
| Strategy review | every 6h | `docs/charters/strategy-reviewer.md` (its step-0 gate self-skips a quiet pilot) | Sonnet, medium |
| Council review | daily (today ~06:19 local as a session cron) | #114 body: outsider + insider + synthesis → dated report in `docs/council/` | per brief |
| Doc steward | event: new merge commits on `main` since the last steward anchor, checked each tick | `docs/charters/doc-steward.md` | Haiku, low |

Cadences and charter assignments are the mandate comment's, verbatim ("stand-up :07/2h → soc-monitor.md, strategy review 6h → strategy-reviewer.md, council daily → its brief, steward on merge-cluster").

- The steward job automates the PM's dispatch of the steward, not the PM's merge of its PR: the steward still opens one docs-only PR and never merges it (doc-steward charter, NEVER list).
- The strategy-reviewer charter's remote access path (ssh → docker exec) collapses to a local `docker exec` when the spawn already runs on the host; the work order states the local path. Charter unchanged.
- The council job files its findings as backlog issues directly, under verdict (a)'s five conditions (Self-correction boundary); its brief (#114 body, written for an in-session PM) gets the matching edit at stage 1.

### Scheduler state

Flat JSON files on the host beside the scheduler: per-job anchors (last-completed-run), the dispatch ledger, the dead-man timestamp, per-job breaker state, and the D1 capability-gate flags (Self-correction boundary). This absorbs and replaces `.claude/ceremony-ledger.json`, the interim from PR #191 that #114's anchored-schedules comment says the scheduler must own natively. Files, not a database: same shape as the interim ledger, restart-safe, inspectable with `cat`.

## Hardening (binding)

Sources: the squad watch-mode resilience checklist and the squad-council P2 additions, both filed in #114; the anchored-schedules operator directive (#114, 2026-07-13).

1. **Anchored schedules with catch-up.** Every job persists a last-completed-run timestamp. On scheduler start and on every evaluation, a job whose elapsed-since-last-run exceeds its cycle fires IMMEDIATELY, then resumes normal cadence. Wall-clock cron encodes "run every N hours the scheduler happens to be alive"; the ceremony contract is "never let more than N hours go unreviewed" — the anchor is persisted to the contract, and a day-long outage must not cost a second cycle by resetting counters (#114 anchored-schedules comment, near-verbatim; team-ceremonies.md catch-up rule).
2. **Dead-man file + independent staleness alarm.** Every poller tick writes a timestamp artifact. A SEPARATE host cron entry — not the scheduler — alarms the operator when the artifact is more than 2 intervals stale. Never ship a watcher without a watcher-of-the-watcher (#114 squad-council comment, point 2). This covers the poller only; per-agent liveness is D2's heartbeat, stage 3 (Self-correction boundary).
3. **Dispatch ledger + orphan sweep + persistent breaker.** The ledger persists dispatched-agent ids and expected durations. Every tick and every restart: sweep it, and remediate a stale entry with the poke-first ladder — poke, wait, re-poke, kill-and-restart only after pokes fail (council D2) — before redispatching or queueing. Stage 3 pairs the sweep with a per-agent heartbeat that distinguishes dead from working-quietly (D2). Per-job circuit-breaker state survives restarts and carries the D4 quota reserve floor. Error handling is tiered escalation ending in a long back-off — L-3: a loop that can call itself forever will (#114 squad-council comment, point 3; squad checklist item 2).
4. **Sentinel-file graceful shutdown.** Touching a stop-file makes the poller finish the current round and exit clean (squad checklist item 1). The same mechanism, driven by config, covers overnight/pause windows (checklist item 3).
5. **`--health` probe.** Prints PID, uptime, per-job last/next fire, anchor ages, and a ledger summary. Positive health signal, never inferred from silence — L-17 (squad checklist item 4).
6. **Scratch pruning.** Stale scratch dirs and logs are pruned automatically each tick (squad checklist item 5).

## Security (binding)

Source: the security seat's priority review (#114, 2026-07-13) and security-baseline.md. The seat framed the scheduler as a RISK-ADDER — a new long-lived host process spawning charter-armed agents — so least privilege applies from day one, enumerated below.

**What it executes.** The poller script; `git fetch/pull` and reads on the dedicated checkout; `claude -p` spawns; `gh` calls under the scoped PAT; and, for the strategy-review job only, that charter's authorized read + steer path (read-only store scripts via `docker exec`, plus the instruct channel). The list is closed: anything absent from it (package managers, shell built from job output) is forbidden, because LLM output is untrusted input (security-baseline.md).

**As whom.** A dedicated non-root service user on the host, owning the checkout, the state files, and the secrets it reads. Not root's crontab.

**Which secrets, per job.**

- The Claude OAuth token: environment inheritance only — never on a command line, never in a log (security-baseline.md).
- Scoped GitHub PATs in `secrets/` (host-only, mode 0600 per security-baseline.md), split per job: a read+comment PAT for stand-up, strategy review, and council (PR/issue read, comment write — enough to flag merge-ready), and a write-scoped PAT confined to the steward job (docs branch push + PR create). The residual: the steward's write-scoped PAT is broader than merge-incapable, so for that one job the never-merge rule is enforced by charter + audit rather than by token scope alone. Every other job is structurally unable to merge. The policy-path slice of that residual is sealed by D3: policy-class paths sit outside every headless write path behind the commit-time allowlist hook (Self-correction boundary), which carries the load precisely because the PAT cannot be scoped tighter. Fix agents dispatched under verdict (b) run token-enforced merge-incapable — the boundary lives in the credential (verdict (b), condition 2; the enforcement mechanism is load-bearing unknown 2).
- The strategy-review job also reads the instruct-channel bearer token (#173's second barrier) for its steer lever.
- No job receives game credentials or the registration code.

**No HTTP/API control plane.** The seat's constraint — expose none before #173 lands — is met by not building one at all: the scheduler's control surface is files (sentinel, config) and CLI (`--health`). #173 is now closed (in-process token on mutating routes), and the scheduler adds no new network surface for it to cover.

**Compose drift baseline.** #172 (closed) landed the compose hardening drift-check the seat required with-or-before this build. The v1 scheduler touches compose not at all (host process); anything it ever adds to compose is covered by that check from first deploy.

**L-20 class.** Binding constraint the build inherits (#114 session-close comment): whatever moves into the image must not assume repo files the image doesn't carry. The image excludes `docs/` (charters, STATE, backlog), so spawns run on the host checkout (Architecture, Spawns).

**The scheduler's own scripts are security-relevant PRs** (the seat, verbatim: "the security-relevant-PR-class rules apply to the scheduler scripts themselves"). Their PRs carry the relevant register rows from docs/wiki/security-controls.md and get the task-reviewer treatment that class requires.

## Authority boundary (binding)

Standing council rule, restated by the operator at session close (#114, 2026-07-14): unattended agents flag merge-ready, NEVER merge. Merge/accept authority stays with the durable accountable seat — the PM at a workstation CLI, or the operator. Concretely: the headless stand-up flags merge-ready where the in-session stand-up would merge (team-ceremonies.md, stand-up check 2; soc-monitor charter NEVER list); the steward opens its docs PR and never merges it (doc-steward charter NEVER list); the council files findings as issues under verdict (a)'s conditions and merges nothing. Token scoping (Security) enforces this structurally for every job except the steward, whose residual is named there and whose policy-path slice the D3 fence seals (Self-correction boundary).

## Self-correction boundary (SETTLED at the spec-gate council, 2026-07-18)

The question the operator posed at session close (#114, 2026-07-14) — may the in-container layer file issues, dispatch charter-armed fix agents, or amend its own briefing lines without a workstation session in the loop — went to the spec-gate council on 2026-07-18: five advisors, three anonymized peer reviews, chairman synthesis, adopted by the PM. The full record (operator framing, steelmen, pre-mortem, dissent) is the "Spec-gate council verdict" comment on #114; this section encodes the outcome as binding spec and repeats none of the argument.

### Verdicts

**(a) File backlog issues — GRANTED**, on five binding conditions: (1) dedup queries open AND recently-closed (~30d) issues, never open-only (the closing-keyword incident class); (2) every filed issue carries a machine-provenance label plus its job/cycle id; (3) a dedup match gets a comment-bump on the existing issue, not a new issue (the adapt ladder's issue-bump rung made mechanical); (4) a per-cycle volume cap — at cap, one summary note, not N issues; (5) filing stays architecturally DECOUPLED from dispatch: no issue-created event may trigger a dispatch.

**(b) Dispatch charter-armed fix agents — GRANTED, gated on stage 3 verified LIVE**, on six conditions: (1) breaker + dispatch ledger + heartbeat sweep observed working in production before the capability enables (merged is not enough); (2) dispatched agents are token-enforced merge-incapable — the boundary lives in the credential, not the instruction; (3) each dispatch is bounded to a named, closed defect class; (4) ledger dedup — no dispatch while an open PR or in-flight dispatch exists for the same issue; (5) a hard per-cycle concurrency cap plus the D4 quota reserve check; (6) flip-to-deny on measured reviewer rubber-stamping, which requires the D-reviewer sampling mechanism to exist.

**(c) Amend own briefing/charter — DENIED, and the leak sealed.** The layer may FLAG a charter defect (an (a)-issue proposing wording); it may not INITIATE the change. The bare deny leaks — (a)+(b) compose to open a policy-class PR headless, and the steward's write-scoped PAT does not distinguish `docs/` from `docs/charters/` — so the seal has two parts: (1) policy-class paths (`docs/charters/`, working-agreements, guardrails, security-controls, AGENTS.md) are fenced out of EVERY headless write path by a commit-time path ALLOWLIST hook the headless agent cannot bypass — an allowlist, not a denylist; (2) the morning read treats any merge-ready PR touching a policy-class path as full-human-review, never trust-the-label. That human review is the last barrier; the council directed the spec to say so, and it does.

### Council defects, encoded (binding gates on the P2 order, not a reorder)

- **D1 — per-capability gate, built with stage 1.** An explicit gate per capability: (a) on at stage 1; (b) bound to stage-3-VERIFIED (observed live, not merged); (c) never. So stages 1-2 run observe-and-file-only, dispatch structurally off (Sequencing).
- **D2 — per-agent heartbeat + poke-first remediation (stage 3).** The stage-2 dead-man covers the poller only. Stage 3 adds a per-agent heartbeat that distinguishes dead from working-quietly, and the sweep's remediation ladder is POKE-FIRST: poke, wait, re-poke, kill-and-restart only after pokes fail. Incident-backed: a poke revived two silent agents this week that a kill-sweep would have destroyed mid-work (#114 council verdict).
- **D3 — policy-path fence: named control, named enforcement point.** The (c) seal's allowlist hook, enforced at commit time in every headless write path. The PAT cannot be scoped narrowly enough to fence policy paths by credential alone, so the hook carries the load — the credential's limitation is exactly why the fence is a hook and not a token scope.
- **D4 — quota reserve floor in the stage-3 breaker.** Dispatch refuses below a floor that protects the pilot's planner from starvation. This is the minimal check pulled forward; full quota-awareness stays stage 4.
- **D5 — charter sanity tripwire, fail safe.** The (c) deny means a broken charter waits for a workstation, and a broken charter bites exactly when the human is absent. So the layer fails safe instead of fixing itself: a charter sanity check HALTS dispatch (never auto-fixes) on invariant failure, and the residual charter-fix latency is documented as a known limit of headless operation.
- **D-reviewer — human sampling of headless reviews.** Merge stays the human gate (token-enforced), and a human samples headless reviews on a set cadence; measured rubber-stamping revokes (b). Without a real sampling mechanism, (b)'s flip-to-deny never fires.

### Load-bearing unknowns (prove, don't assume — simplicity-rules.md)

1. The stage-3 heartbeat can distinguish a dead agent from a quiet-but-working one. A load-bearing UNKNOWN — the council's one medium-confidence call. Prove it before gating dispatch on it; until proven, (b) stays off.
2. A hook can enforce merge-incapability + path scoping the headless agent cannot bypass; if not, (b) and the (c) seal fail together.
3. A readable shared-quota counter exists for the D4 floor.
4. Reviewer rubber-stamping is detectable; otherwise (b)(6) is cosmetic.

**Future evolution (deferred with receipt):** an append-only capability manifest outside every headless write path (workstation-only writes, headless reads) structurally solves (c)+D3 as an allowlist; rejected for this build because it needs a signing/manifest mechanism P2 does not otherwise need — it is the fence's designed successor when a second capability class needs the same treatment (#114 council verdict).

The constraints the operator attached to the debate (squad watch-mode patterns, charter model pins, token ration, L-20) are encoded in Hardening, the job table, D4, and Security respectively.

## Sequencing

P2 priority order per the squad-council comment — scheduler first, dead-man second, ledger third — with the council's D1 capability gate laid over it: stages 1-2 run observe-and-file-only, dispatch structurally off until stage 3 is verified live.

1. **Stage 1 — scheduler.** Cron/systemd entries, poller, anchored schedules with catch-up, job table, host-checkout spawns, and the D1 per-capability gate ((a) on; (b) off, bound to stage-3-verified; (c) never). Absorbs `.claude/ceremony-ledger.json`. Anchors belong to stage 1: the catch-up requirement binds the first version that runs (#114 anchored-schedules comment).
2. **Stage 2 — dead-man.** Timestamp artifact + the independent staleness alarm. Poller coverage only; per-agent liveness arrives with D2 in stage 3.
3. **Stage 3 — dispatch ledger.** Ledger, orphan sweep, persistent breaker with tiered back-off, the D2 per-agent heartbeat with the poke-first ladder, and the D4 quota reserve floor in the breaker. Capability (b) enables only after this stage is observed working in production — verified live, not merged (D1; verdict (b) condition 1) — and only once the heartbeat's dead-vs-quiet discrimination is proven (load-bearing unknown 1).
4. **Stage 4 (conditional) — quota-aware cadence (#183).** Checked 2026-07-18: #183 is OPEN; its probe (2026-07-13) confirmed the endpoint EXISTS — `GET https://api.anthropic.com/api/oauth/usage` accepts our token — but is throttled on an hourly per-token budget that the pilot's continuous `claude -p` spawns re-exhaust, so its 200-response shape is still uncaptured. #183's adopted recommendation folds the capture into this build: the scheduler polls at low frequency, honors `retry-after` exactly (the 429's `retry-after` is itself the window-reset time — a usable scheduling signal), and logs the first successful body redacted into #183. Self-throttling — skip non-critical ticks past a weekly threshold (#114 mandate comment, point 5) — builds only after that first capture defines the shape; until then the learned-ceiling model and the operator's /usage panel remain the sources. No predictive regression: rejected at the 2026-07-13 council as machinery without a receipt (#183).

The spec gate passed on 2026-07-18 (#114, council verdict comment). Stage 1 is next; build starts after the usage-week reset, per the mandate.

## Non-goals

- No HTTP/API control plane, dashboard page, or any network surface for the scheduler (v1). Control is files + CLI.
- No merge or accept authority for any unattended job — a standing rule, not a deferral.
- The poller does no domain work: it schedules, spawns, sweeps, and prunes; judgment, LLM calls, and game calls belong to the spawned agents.
- No new charters and no charter rewrites in this build: the four existing charters are armed as-is; charter edits remain reviewed PRs, and headless charter amendment is denied and fenced (verdict (c)).
- No predictive quota regression (#183; rejected with reasons, 2026-07-13 council).
- No replacement of the PM seat: the workstation stays the dev-team and accountable seat. The self-correction middle is settled above — filing granted, dispatch gated on stage 3 verified live, self-amendment denied — and none of it moves merge/accept authority.
- No new persistence tech: scheduler state is flat files on the host, like the interim ledger it replaces.
