# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-08-01 (PR #38/#45/#46/#47 merged; scan_poi deregistered, merge-gate deadlock fixed, livelock remedy shipped awaiting live confirmation; backlog regenerated). Primary repo: github.com/Cringely/spacemolt-harness

## NOW, live status

_Refreshed 2026-08-01. Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`._

**FLEET FLIGHT (#591).** F0 steer restore (#495) -> F1 strand/trap fix (#543 live, #526 open) -> F2 launch scout+corsair (#593) -> F3 loops end (#534/#569/#571, +#592 gap) -> F4 exit: 3 pilots/24h/zero strands. Live: 1 of 3 flying (`miner`, image `49c94ec`); scout/corsair registered, unlaunched. F1 status: #543 confirmed live (starvation mechanism fixed), pilot stuck at `market_prime` for different reason (#669, P1).

**MERGED: PR #47 (#543), fix(agent), 49c94ec.** Miner at `market_prime` with fuel 19/130: low_fuel reflex fired every tick consuming time while rescue plan `[buy fuel_cell x111, refuel]` queued unused. A failed reflex consumes the tick whether it succeeded, so low-fuel recycles and starves the plan. Fix: reflex stands down while a pending plan already carries the remedy. Bounded by existing machinery (docked ships lose no fuel passively, `station_fuel_empty` blocks not retries). Guard added: absent `params.target` ensures mis-scoped refuel (transfer vs self-heal) doesn't suppress safety reflex. Offline test: two-tick cycle verifies fuel rises. LIVE CONFIRMED (2026-08-01T03:11:43.382Z): `[2026-08-01T03:11:43.382Z] miner action {"action":"buy","params":{"id":"fuel_cell","quantity":50},"outcome":"blocked"...}`. That is the first plan step executed in 7+ hours; the starvation mechanism is FIXED. Pilot now stuck at `market_prime` unable to complete purchase (#669, P1).

**MERGED: PR #46 (#601), fix(ci), 934f2a2.** Merge-gate deadlock: path-filtered `pull_request` trigger skipped for unmatched paths, leaving contexts blocked on a job never queued. Showed BLOCKED status with green checks + no-context-row (hung indefinitely). Four steward PRs stalled. Fix: drop `paths` from `pull_request` trigger; keep `push` filter so docs-only merges don't rebuild image. Round 1 dropped `paths` from BOTH triggers via a shared YAML anchor; review caught that the `push` half fixes nothing (required checks are pull-request-side only) and would rebuild, sign, and republish the container on every docs merge, moving the `latest-main` tag the production deployer watches. Required contexts now: gitleaks, CodeQL, test, verify, doc-size. The `doc-size` context was re-added after the merge, confirmed by direct read of ruleset `19302008`.

**MERGED: PR #38 (#552), fix(registry), 1a5525f.** Deregistered `scan_poi` action. Game-side: requires faction-aligned Sensor Dome (600k credit facility). All 9 lifetime attempts failed (`not_in_faction`). Filed five separate times as apparent defect. Registry is the SSOT, so removal was complete: stored plans naming it are discarded and replanned by `loadPlan`, not crashed.

**MERGED: PR #45, chore(deps), b7793ee.** GitHub Action version bumps: `docker/login-action` v4.4.0 → v4.5.2, `ossf/scorecard-action` v2.4.3 → v2.4.4.

**REDEPLOY FINDINGS, RESOLVED.** PR #46 fixed the gate that blocked redeploy status confirmation. #657/#660/#663 all closed: production had been running current code (verified by `git merge-base --is-ancestor`). #667 filed: ceremonies cannot confirm a deploy; fix is emitting the image tag into the event log the seat already reads. #668 filed: `workflow_dispatch` also permits manual runs to move production `latest-main` tag (a manual run was demonstrated and cancelled before tagging).

**THEN.** #534, #535, #537, #538, #529 and backlog issues tracked in `docs/backlog.md` (171 open issues).

## Standing operational facts

Not part of the live-status refresh above; persists across waves until it changes. Not word-capped (`test/doc-size.test.ts` only gates the `## NOW` block).

- **Scheduler.** #114 has stayed recovered since 2026-07-21; the dispatch gate is still OFF by design (human-gated). Strategy job works over the TLS store proxy.
- **Merge cluster 2026-07-22/23** (superseded as live status, kept as the record): #12 `SM_STORE_URL` through the strategy job; #13 tick bootstrap moved host-side; #14 finding-filer scoped to the private issues repo; #15 chained-gh-merge gate round 3; #16 per-job gh grants, bypass wildcard dropped. Milestone Artifact current through M-49/50.
- **Model policy.** Fable = prose seats, Opus everything else, cheap tiers for bulk.
- **Spend ledger.** `spend-ledger.jsonl` in the primary clone, gitignored, auto-synced by a local Windows Scheduled Task (daily 4am + logon).
- **Scheduler SSH is slow.** ~30-40s to connect to the scheduler LXC; cause still unknown, `UseDNS` already off.
- **Codex review seat (#460).** `bun scripts/codex-review.ts <PR>`, advisory, run beside the Claude reviewer.
- **#458 buy-guard detail.** `mine_resource` counts MINED only; a prior titanium buy wasted roughly 120k credits, and the guard is not yet merged.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
