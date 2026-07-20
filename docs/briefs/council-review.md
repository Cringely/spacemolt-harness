# Brief: Daily Council Review (headless)

Work-order brief for the durable scheduler's daily council job (#114, stage-1 plan task C4).
This is a BRIEF, not a charter: the four role charters stay untouched (spec §Non-goals).
Dispatched verbatim by the scheduler (src/scheduler/spawn.ts); versioned like policy;
`docs/briefs/**` sits inside the D3 fence, so it is headless-unwritable like the charters.

ROLE: the once-daily in-depth review of the project for over-engineering, code bloat, and
direction-vs-goals (#114). The periodic enforcement of the binding simplicity rules
(`docs/wiki/simplicity-rules.md`: KISS, value-density, complexity-needs-a-receipt). Ephemeral
per run: review, synthesize, file, report, terminate.

## Method — two seats, then synthesis

Run both seats as in-session subagents (Task tool). That is this job's review METHOD — it is
not the capability-(b) agent dispatch the D1 gate keeps off.

1. **Outsider seat.** Fresh eyes, LOW context BY DESIGN: the code plus a one-paragraph
   what-this-is, and NO rationale context (no decisions.md, no wiki, no goals). It sees
   complexity cold, with no attachment to why it exists.
2. **Insider seat.** Full goals context (README, `docs/decisions.md`, `docs/wiki/`): judges
   direction against goals and whether complexity earns its learning keep.
3. **Synthesis (you).** Weigh both seats; a defect both seats flag independently outranks
   either alone. REPORT/PROPOSE only.

## Triage — re-rank the backlog inflow (added v1.3)

Issues now arrive machine-speed (strategy/council/steward file autonomously) while ranking was
PM-speed only; this step closes that gap. After the two seats return, list the issues OPENED OR
REOPENED since the previous council report (`gh issue list --search "created:>=<prev-report-date>"`,
plus any the seats flagged), and rank the top items against the current milestone
(`docs/milestones.md`) and the simplicity rules. Output: a `## Triage` section in the dated
report — an ORDERED list, one line per issue (`#N — why it outranks / parks`), explicitly marking
anything that should jump the current backlog order and anything that looks like noise to close.
Cap it at 10 lines; a full-backlog re-sort is the PM's call, not yours. The stand-up job consumes
this section as "council ordering" (seam: docs/charters/soc-monitor.md step 3 names this report
section as its source; the two files must agree).

## Output

1. **Findings → backlog issues**, filed ONLY via `bun scripts/file-finding.ts --dedup-key
   <stable-key> --title <title> --body-b64 <base64>` — the WHOLE command on ONE LINE, your
   finding body base64-encoded as the `--body-b64` value (no heredoc, no pipe, no newline in
   the command: a headless job's permission layer denies a multi-line Bash command). The
   mechanical filer enforces the #114 verdict-(a) conditions (dedup incl. recently-closed,
   machine-filed label + provenance, bump-not-refile, per-cycle cap). Never `gh issue create`
   directly.
2. **Dated report**, written ONLY via `bun scripts/write-report.ts --file
   <YYYY-MM-DD>-council-review.md --body-b64 <base64>` — the WHOLE command on ONE LINE, the
   report body base64-encoded as the `--body-b64` value (same one-line rule). It lands under
   `$SCHEDULER_STATE_DIR/reports/` and the jailed writer accepts nothing outside it (you have
   no plain file-write tool). Contents: outsider verdict, insider verdict, synthesis, findings
   filed (with issue numbers). FLAG the report for PM pickup in your final output — your PAT
   cannot push, so committing it to `docs/council/` stays a workstation action (stage-1 plan,
   decision 8).

## Tier

Sonnet, medium reasoning effort — the seats do the reading; the synthesis is the judgment.

## NEVER

- Never auto-remove code, open code PRs, or merge anything — REPORT/PROPOSE only (#114).
- Never dispatch persistent or fix agents; the two seats run in-session and end with you.
- Never file an issue outside `scripts/file-finding.ts`.
- Never make live game calls; LLM calls are this run and its two seats only.

## CHANGELOG

- v1.3 (2026-07-19) — added the Triage step: rank issues filed since the last council run
  against the current milestone, emit an ordered `## Triage` section in the dated report
  (operator-approved; closes the machine-speed-inflow vs PM-speed-ranking gap). Stand-up
  consumes it as "council ordering" (seam registered in docs/wiki/seam-manifest.md).
- v1.2 (2026-07-18) — findings AND the dated report carry their body as a single-line
  `--body-b64 <base64>` argv token; the report body no longer rides STDIN. A headless job's
  permission layer splits a Bash command on newlines, so a heredoc/STDIN body is denied by the
  closed allowedTools list. The earlier outbox file-jail was dead a second way: no fleet tool
  could create a file in it (#114 filing fix).
- v1.1 (2026-07-18) — dated report writes through the jailed `scripts/write-report.ts`
  (STDIN body, reports/-confined); bare `Write` dropped from the job's allowedTools (Batch C
  review, HIGH: Claude Code does not honor Write(path) scoping).
- v1.0 (2026-07-18) — extracted from the #114 body ritual (outsider + insider + synthesis,
  REPORT/PROPOSE only, findings → backlog issues) for the durable scheduler's daily job, with
  the stage-1 edits the spec §Job table names: findings file through the mechanical filer under
  verdict (a); the dated report lands host-side in stateDir/reports instead of `docs/council/`
  (read+comment PAT cannot push — plan decision 8); synthesis runs inside the spawn (the
  in-session PM seat is not in the loop).
