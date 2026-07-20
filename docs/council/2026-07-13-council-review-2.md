# Council Review #2 — 2026-07-13 (evening)

Second daily council (the cadence's first regular firing after the inaugural morning review).
Format per the standing brief: an **outsider** agent judged the code cold (src/ + test/ only, one
paragraph of context, no rationale docs), an **insider** agent judged direction against the goals
context (AGENTS.md, decisions.md, lessons, backlog), and the PM reconciled them. Report and
propose only — nothing was removed.

## Verdict

**Code health: ACCEPTABLE** (outsider) — the core loop is dense but almost every guard cites a
live incident and picks the smaller mechanism; bloat is concentrated in two known pockets.
**Direction: ON-TRACK with a real allocation drift** (insider) — the inaugural council's pivot
order (base-pilot economic win via #93/#94/#112) produced zero code in its first day while ~250
lines of dashboard polish shipped, and the pilot then stalled live (#146) on exactly the gap #93
targets.

## Where both perspectives converge (the strongest signal)

1. **The base pilot's economics are the only work that matters right now.** The outsider,
   knowing nothing of the goals, independently flagged the cost machinery and dashboard as the
   least essential surface; the insider showed the pivot items untouched while the pilot thrashed
   on a no-buyers stall. Same conclusion from opposite directions.
2. **`digest.test.ts` carries ~15–20 prose-pinning tests** that assert exact briefing sentences
   back at themselves — they break on every prompt-tuning pass (which this project does
   constantly) and catch only copy-edits. Both reviewers called this the clearest value-density
   violation in the suite. The falsified-claim `not.toContain` regressions and security canaries
   in the same file are earned and stay.
3. **The improv/MCP stack (~850 src + ~500 test lines) is dormant by design and safe to keep
   shelved** — but only if #119 (config REJECTS `mode: "improv"` instead of silently no-opping)
   actually ships. It has been open since the inaugural council and is an hour of work.
4. **`agent.ts`'s five interacting anti-thrash governors are the maintainability frontier.** Each
   has an incident receipt; the cost is the precedence matrix between them, which lives only in
   comments and ~25 mutable private fields. The outsider's "one replan-governor module with an
   explicit small state machine" framing strengthens the existing #120.

## Where they disagree, and the PM ruling

- **Catalog (`src/catalog/`, ~200 lines + 10 tests).** Outsider: fully dead (verified — only its
  own test imports it; a digest comment mentions it but no code does), delete it. Insider: it is
  the designated SSOT for #93/#94, which are the next moves. **Ruling: keep, with a
  consume-or-delete condition** — if #93/#94 haven't made it a real consumer by the next council,
  it goes. Deleting the data layer of next week's work to re-add it days later is churn, but the
  outsider's finding stands as the receipt: it shipped ahead of its consumer, and the consumer is
  now overdue.
- **Improv stack location.** Outsider: park it on a branch. Insider: the inaugural ruling
  (reviewed work stays on main behind the #118 hold) stands. **Ruling: no re-litigation** — the
  hold plus #119 is the agreed mechanism; moving 1,300 lines to a branch buys nothing the config
  rejection doesn't.

## PM's own corrections (honest ledger)

- **One PR of rework was real:** #144 shipped native-`<title>` tooltips and #145 replaced them
  with the crosshair layer the same day. The operator's ask was Grafana-style from the start;
  #144 under-read it. Cheap lesson, but it counts.
- **Operator-ordered features are not drift** — the operator sets direction, and the window
  selector directly operationalizes the trend-review vitals window. The genuine drift is that no
  agent was dispatched on #93/#112 *concurrently*. The correction is allocation, not abstinence.

## Direction: the next moves (in order)

1. **Ship the #146 promotion now** — outcome-class damper key (bucket "no buyers"/"Sold 0" by
   outcome class, not action string) + the relocate-not-replan backstop. This is a promotion
   already owed: the auto_list decision entry recorded this exact recurrence as its trigger.
2. **Capture, then build #93** — the pilot docks at markets constantly; capture real
   `analyze_market`/`view_orders`/`get_missions` responses, then build the "stations that buy
   your ore / missions you can fulfill" digest surfacing against real fixtures. Lands naturally
   with #142's economics panel.
3. **Diagnose the mission flatline** — `missions_completed` is still 1 despite the flow being
   registered (#126) and fixed (#135). Either the planner never reaches for missions (briefing
   salience, the L-12 class) or something structural blocks completion. Cheap to answer from the
   event store; potentially the single biggest credits lever. Filed as its own issue.
4. **Dashboard freeze** until credits move off ~3.3k. Nothing on the dashboard stands between the
   pilot and its first profit.

## Bloat to unwind (proposed, not executed)

| Item | Size | Disposition |
|---|---|---|
| digest.test.ts prose-pinning tests | ~15–20 tests | Collapse to topic checks; keep falsification + canaries (issue filed) |
| Planner `plan()` bodies duplicated (claude-subscription vs ollama) | ~20 lines | One shared retry helper (issue filed) |
| Two-place defaults (agent.ts mirrors config.ts; drift already visible — stale "default 12" comment) | small | Single-source via a test config builder (issue filed) |
| `getPoi()` + `PoiInfoSchema` + `EXCLUDED_MOVEMENT_COUNTERS` export | ~40 lines | Fold into #123, but resolve get_poi's limbo ONE way first (deposit-check home vs prune) |
| JSON-RPC builders living in `tools/mcp-probe.ts` but load-bearing for `client/mcp.ts` | move | Fold into #122: move builders to client/, then archive the probe |
| usage.ts cost machinery (price table for a flat-rate sub) | leave | Documented estimate, mild; not worth touching now |

## What is healthy (named, so the praise is load-bearing)

`http.ts`, `store.ts`, `server.ts`, `params-shape.ts`, `wake.ts`, `reflex.ts`,
`snapshot-throttle.ts`, `parse.ts` — the outsider, primed to find bloat, cleared all of them
explicitly, and rated the test suite ~75% incident-earned ("unusually high"). The insider found
the decision log, independent review, and invariant-promotion machinery all demonstrably working
(#146 correctly identified its own promotion trigger). Process health: ON-TRACK, with one
capture gap (the trend-review lesson — closed in this PR as L-21).

## Actions taken with this report

- L-21 (vitals-over-time from the persisted store; logs wipe on recreation) added to
  engineering-lessons.md.
- Issues filed: mission-flatline diagnosis (pilot-tuning), digest prose-test collapse
  (tech-debt), planner-dedupe (tech-debt), defaults single-sourcing (tech-debt).
- Cross-reference comments on #119 (ship now), #120 (governor state-machine framing), #122
  (builders' home), #123 (resolve one way), #93 (catalog consume-or-delete condition), #146
  (council priority #1).
- backlog.md regenerated.
