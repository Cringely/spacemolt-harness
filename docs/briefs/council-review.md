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

Run both seats yourself, one after the other, as separate passes. You hold no Task tool (a
Task subagent's Bash escaped the job's tool list, Cringely/spacemolt#865). The outsider pass
MUST read only code and the one-paragraph what-this-is before you open any rationale doc;
the insider pass comes second, so the outsider verdict is written down before rationale
context can contaminate it.

1. **Outsider seat.** Fresh eyes, LOW context BY DESIGN: the code plus a one-paragraph
   what-this-is, and NO rationale context (no decisions.md, no wiki, no goals). It sees
   complexity cold, with no attachment to why it exists.
2. **Insider seat.** Full goals context (README, `docs/decisions.md`, `docs/wiki/`): judges
   direction against goals and whether complexity earns its learning keep.
3. **Synthesis (you).** Weigh both seats; a defect both seats flag independently outranks
   either alone. REPORT/PROPOSE only.

## Triage — re-rank the backlog inflow (added v1.3)

Issues now arrive machine-speed (strategy/council/steward file autonomously) while ranking was
PM-speed only; this step closes that gap. First find the previous report's date:
`bun scripts/read-latest-report.ts --glob '*-council-review.md'`, the WHOLE command on ONE LINE. It
prints `FOUND <file> mtime=<ISO8601>` then the report, or the literal `NO_MATCHING_REPORT_FOUND`
(then use the last 48 hours). You have no `ls`/`find`/`printenv` grant, and a denial from any
other lookup is not evidence that no report exists. After the two seats return, list the issues OPENED OR
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
   <stable-key> --title <title> --body-file <path>` — the WHOLE command on ONE LINE, your
   finding body written with the Write tool to a file under `.job-body/` and that path as the
   `--body-file` value, as the work order describes (no heredoc, no pipe, no newline in this
   command: a headless job's permission layer denies a multi-line Bash command). The
   mechanical filer enforces the #114 verdict-(a) conditions (dedup incl. recently-closed,
   machine-filed label + provenance, bump-not-refile, per-cycle cap). Never `gh issue create`
   directly.
2. **Dated report**, written ONLY via `bun scripts/write-report.ts --file
   <YYYY-MM-DD>-council-review.md --body-file <path>` — the WHOLE command on ONE LINE, the
   report body written to a file under `.job-body/` first (same one-line rule). It lands under
   `$SCHEDULER_STATE_DIR/reports/` and the jailed writer accepts nothing outside it (your
   Write tool is for the body file in your checkout, not for the report itself). Contents: outsider verdict, insider verdict, synthesis, findings
   filed (with issue numbers). That directory is the record: nothing is committed or picked up
   from it (your PAT cannot push, stage-1 plan, decision 8).

## PR numbers are claims, not evidence

You hold no `gh pr` grant (#490), so you cannot look a PR up. Any PR number you read in a
stand-up report, an issue body, or STATE.md is an unverified claim. Quote it as "unverified claim
from <source>" if you mention it at all. Never present it as evidence, name it as a blocker, rank
a Triage line on it, or file or bump a finding whose only support is that number. The same
triple (462/463/467) was filed as a blocker repeatedly and none of those numbers was a
PR in this repo. Tracker issues (Cringely/spacemolt) share the number space with this repo's PRs, so
"#88" is not a PR until someone has run `gh pr view 88 -R Cringely/spacemolt-harness`.
The stand-up job holds that grant and owns the lookup (docs/charters/soc-monitor.md step 2).

## Tier

Sonnet, medium reasoning effort — the seats do the reading; the synthesis is the judgment.

## NEVER

- Never auto-remove code, open code PRs, or merge anything — REPORT/PROPOSE only (#114).
- Never dispatch persistent or fix agents; the two seats run in-session and end with you.
- Never file an issue outside `scripts/file-finding.ts`.
- Never make live game calls; LLM calls are this run and its two seats only.
- Never cite a PR number you did not verify as a blocker or as a finding's evidence.

## CHANGELOG

- v1.6 (2026-11-13) — Triage names `bun scripts/read-latest-report.ts` as the way to find the
  previous report's date (the job now holds that grant). Findings and the report pass their
  body as a file written with the Write tool under `.job-body/` (`--body-file`), not as base64 computed in a shell
  (the shell-encoder design was rejected in security review: untrusted text in a shell
  argument). Dropped the PM-pickup / `docs/council/`
  commit expectation: the state-dir report is the record (operator default).
- v1.5 (2026-11-13) — added "PR numbers are claims, not evidence": the council cannot verify a PR
  (no `gh pr` grant, #490), so a PR number from a stand-up report or issue is an unverified claim
  and never evidence, a blocker, or a Triage rank. Fixes the fabricated PR triples the council
  relayed into findings (Cringely/spacemolt#912, #956, #958, #962, #964, #970, #974, #979).
- v1.4 (2026-11-12) — seats run as two sequential passes in the job's own context; the Task
  tool left the council grant (Cringely/spacemolt#865, appsec P1). Trade-off: the outsider's
  "no rationale context" is now ordering discipline, not a fresh-context guarantee.
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
