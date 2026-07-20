# Team Ceremonies

Human dev teams tune themselves through recurring rituals: stand-ups, retros, design reviews. This page holds this team's versions of those rituals, plus the rule that keeps their schedules honest when the machinery running them goes down. It split out of `team-structure.md` (#237) when that page outgrew the wiki size line: the org chart and roles stay there, and the day-to-day mechanics (communication protocol, git/PR workflow) live in `team-workflow.md`.

## Stand-up loop (standing, operator-directed 2026-07-13)

A human stand-up is a short daily meeting: what's moving, what's blocked, what's next. This team runs the same loop as a scheduled check every two hours, adapted to what agents actually need. The key difference from the human version: agents report automatically when they *finish*, so the stand-up is not for collecting status. It exists for the cases completion-notifications can't cover.

What each stand-up checks, in order:

1. **Liveness of in-flight work.** A hung agent emits nothing: no error, no report, just silence (a background task once sat "running" for 45 hours on a two-second job). Anything running far past its expected duration is presumed hung: stop it, redispatch or queue it. Silence is not progress; this is the team-level version of the pilot's progress heartbeat.
2. **PRs driven to resolution.** Red CI gets the fix-push-comment loop (re-dispatched if the author agent is gone). Green-and-reviewed gets merged by the PM when the stand-up runs in-session; a headless stand-up (the #114 future) flags merge-ready instead, because merge authority stays with the PM. Unreviewed gets a fresh reviewer.
3. **Pipeline primed.** If nothing is in flight and ordered work exists (council ordering first, then backlog epics), the next wave dispatches. An idle pipeline with an ordered backlog is a bug, not a pause.
4. **Blockers surfaced.** Anything genuinely needing the operator gets one line; everything else gets handled, not reported.

Output is stand-up-sized: a few lines, one or two when healthy. The heavyweight layers already exist and are not duplicated here. The daily council is the direction/architecture review, the 6-hour trend review owns the pilot, and STATE.md's `NOW` block is the written status report. The stand-up deliberately does NOT steer the pilot (deterministic guardrails own that) and does not start reviews of its own.

Scheduling note: the loop currently runs as a session-scheduled job (it dies with the PM session), the same durability limitation tracked for the council and strategy review in #114/#142.

## Ceremonies: the scrum mapping (operator-directed 2026-07-13)

Beyond the stand-up, human teams run retros, design reviews, and onboarding. This team runs the same functions under different names. The table below is the honest mapping, kept here so nobody mistakes a missing *name* for a missing *function*, and so each ceremony's trigger discipline stays deliberate. The squad council found that always-on auto-triggered ceremonies tax every task to catch rare events; event- and stage-triggered ones don't.

| Ceremony | Our mechanism | Trigger |
|---|---|---|
| Daily stand-up | 2h stand-up loop (liveness, PRs, pipeline, blockers) | scheduled |
| Sprint retro (product) | Postmortems + engineering-lessons + invariant promotion | event: a failure taught something |
| **Sprint retro (process)** | **Council process-retro section (below)** | **scheduled: daily council** |
| Design review | Spec→plan review gates; seam-manifest check (#165) before dispatch | stage-gated |
| Onboarding | Work orders w/ verbatim tasks + AGENTS.md context map + role charters (#164) | per-dispatch |
| Sprint review | Daily council (direction/bloat) + milestone gates | scheduled + gated |

**The process-retro (the gap the mapping exposed).** Event-triggered retros only fire when a failure announces itself, and process rules can break *quietly and repeatedly*: the concurrent-writer rule broke twice in three days before anything counted the recurrence. So the daily council carries a mandatory third section beyond outsider/insider: mine the period since the last council for **rule violations, near-misses, and friction** (dispatch mistakes, review escapes, conventions honored in the breach), and every finding becomes a **tracked issue, charter edit, or guardrail change, never prose**. That last discipline is borrowed from squad's own measured result: retro action items went 0% completed as markdown checklists, 100% as tracked issues. A retro whose findings aren't tracked artifacts is a feelings meeting.

The process-retro also carries the **backlog-hygiene sweep** (operator-directed 2026-07-13): scan the open issues for staleness (premises the code or plan has moved past, duplicates of newer issues, missing size/epic labels) and flag each for PM close/merge/label action. Hygiene rides an existing scheduled ceremony instead of a dedicated groomer role because at this backlog size a standing groomer would be busywork; promote it to its own role only if the sweep repeatedly finds more than the council can carry.

## Core-harvest (operator-directed 2026-07-19)

This project's process layer (reviewer agents, hooks, guardrails) came from and feeds back into `E:\projects\agent-harness-core`, the shared source for all projects. Lessons recorded here are worth nothing to the next project until someone carries them across; this ceremony is that carrier, on a 48-hour cycle in `.claude/ceremony-ledger.json` (`core_harvest`).

What a harvest run does, in order:

1. **Mine the decision log.** Read `docs/decisions.md` entries newer than the ceremony's `last_run`. For each, ask: is the lesson project-agnostic (a failure class, a process rule, a harness mechanism), or spacemolt-specific (a game rule, an API shape)? Entries already flag the former with "the transferable lesson" phrasing, but absence of the phrase is not absence of a lesson.
2. **Check mechanical drift both directions.** Run `pwsh E:\projects\agent-harness-core\install\Install-Harness.ps1 -Target E:\projects\spacemolt -Audit`. `project-modified`/`untracked (differs from core)` files are promotion candidates upward; `core-updated`/`not-installed` files mean core moved on and this project should pull (re-run the installer, reconciling any local edits first).
3. **File, don't summarize.** Per the findings flow in `~/.claude/rules/harness-core.md`: first occurrence of a lesson becomes a memory note; second occurrence across projects gets committed to agent-harness-core (pattern doc, agent def, hook, or template edit) and pushed. Drift worth acting on becomes a tracked issue or an immediate reconcile, never prose in a report. A harvest whose findings aren't artifacts is a feelings meeting.
4. **Stamp completion.** Update `core_harvest.last_run` in the ledger only after steps 1-3 finish; the timestamp is the next run's mining cursor.

`approx` is true: harvest cadence is a floor, not a deadline, and a run that finds nothing new is a healthy two-line result.

## Ceremony catch-up rule (operator-directed 2026-07-13)

Scheduled ceremonies are ANCHORED to their last completed run, not to the scheduler's uptime. Every ceremony records a completion timestamp in `.claude/ceremony-ledger.json` (local, gitignored: it is operational state, not history; the durable scheduler #114 must own this natively). At session boot, and whenever the ledger is consulted, any ceremony whose last completed run is older than its cycle (stand-up 2h, strategy review 6h, council 24h) fires IMMEDIATELY, then resumes its normal cadence. A scheduler that was down for a day must not silently restart every counter from zero: the outage already cost one cycle; resetting the anchor costs a second one. Why it matters (loop-engineering): wall-clock cron encodes "run every N hours the scheduler happens to be alive," but the ceremony's contract is "never let more than N hours of work go unreviewed." The ledger anchors the schedule to the contract, not to process uptime.
