# Backlog Dedupe Ceremony

Spec for a new scheduled ceremony. Date: 2026-09-22.

Status: not yet reviewed or approved. Written from a one-time measurement pass over the
521-issue open backlog. That pass produced a full cluster-by-cluster report, pasted into the PR
this spec ships with rather than committed as a repo file: a snapshot of 521 issue titles goes
stale within days of the ceremony this spec describes actually running, so it belongs with the
PR that proposed the ceremony, not in `docs/` as a document the doc-steward would then have to
keep current forever. The clusters and counts cited below are drawn from that report.

## Mandate

The backlog carries 521 open issues. A one-time clustering pass found that 389 of them, three in
four, are duplicates of 83 underlying conditions. Forty-three of those clusters are confident
enough that one fix closes every member. The Corsair battle-lockout condition alone is reported
20 times. Three doc PRs stalled on merge conflicts drew 16 reports. This spec designs the
ceremony meant to keep that pile from re-forming, and asks a harder question first: is a
ceremony even the right fix, or does it treat a symptom a producer-side change should prevent
instead? The short answer, argued in "Ceremony vs. producer fix" below, is both.

A *ceremony*, in this project's vocabulary, is one of the scheduled, unattended agent runs: the
standup, the 6-hour strategy review, the doc steward. Each is chartered under `docs/charters/`,
runs headless, and reports through the issue tracker or a PR rather than a chat message no one
reads later.

## Why duplicates exist today

Every ceremony already files issues through one path, `fileFinding()` in
`src/scheduler/filing.ts`, and that path already tries to dedupe. Before designing anything new,
this spec traced why it still misses three of every four duplicates.

It compares minted keys, not findings. A filing agent invents a short `dedupKey` slug
(`corsair-in-battle-lockout`), and `fileFinding()` normalizes that slug: strips severity words
like `p0` and `blocker`, strips staleness words like `still` and `9d`, then checks it against
other open issues' slugs by Jaccard overlap at a 0.6 floor (`NEAR_MATCH_JACCARD`,
`filing.ts:209`). It never reads the issue's title or body. Two agents describing the same
Corsair lockout as `corsair-trapped-unresolvable-battle` and
`spacemolt-battle-0-9-registered-no-flee-lever` share almost no words once normalized, so they
never match, even though a person reading both titles sees one defect in five seconds.

The entity-anchor guard only recognizes `pr`, `issue`, and `gh` plus a number
(`ENTITY_ANCHOR_RE`, `filing.ts:201`). It exists to keep PR #40's red-CI report from merging
into PR #83's. It has no anchor for a pilot name, an action name, or a game mechanic, the actual
entities this backlog's findings are about, so a `corsair` finding and a `scout` finding pass the
anchor check as vacuously equal (an empty set equals an empty set) and fall straight through to
word overlap, the exact layer wording drift already defeats.

Per-agent, per-cycle wording splits one cause into several keys. A headless spawn has no memory
of the last cycle's key, so it describes a standing condition in whatever words that run's
context makes natural. The near-match code's own comments name this drift directly
(`filing.ts:150-167`), and one cluster this pass found, #743 and six related issues, is the
ceremony community reporting on itself: #945 and #1029 measured 31 duplicate issues filed under
the 0.6 bar after the fix meant to close this gap had already merged.

Operator-authored issues carry no key at all. `readDedupKey()` (`filing.ts:146`) reads a
`<!-- sm-dedup:KEY -->` HTML comment out of the issue body. A person typing an issue by hand
never writes that comment, so `findDedupMatch`'s body-text search and `findNearMatch`'s marker
scan both skip it. It is invisible to the existing matcher in both directions, as a candidate and
as a target.

None of this is a defect in `filing.ts`. Its matcher is scoped correctly to what one spawn,
minting one key, at file time, can check cheaply. The gap is a different shape of problem:
clustering the whole open backlog against itself, after the fact. That is what this spec designs.

## What the ceremony does, and what it never does

Each run: fetch every open issue's title, body, labels, and creation date, cluster them, and for
each cluster it is confident in, label every non-canonical member `dedupe:candidate` and post one
comment on it naming the proposed canonical and the evidence. That is the entire authority this
spec asks for.

It never closes an issue, edits a title or body, changes a priority label, dispatches a fix
agent, or amends its own thresholds. Closing is a new authority no ceremony holds today. The
project's one precedent for granting a ceremony a stronger authority is the durable-scheduler
spec's dispatch verdict (`docs/superpowers/specs/2026-07-18-durable-scheduler.md`,
"Self-correction boundary"), which gated fix-agent dispatch on being verified live in production,
not merely merged. Auto-close should clear a comparable bar, not a lower one, because a wrongly
closed issue loses a finding in a way a wrongly posted comment does not.

The evidence that would justify granting auto-close later: a run of consecutive cycles, sampled
by a person, with zero false merges recorded against the precision ledger this spec's
"Precision" section defines below. Even then, the grant would be scoped to high-confidence
clusters only. Medium- and low-confidence clusters never get auto-close authority. They stay
reading lists, the same way the human-made report already treats them.

## Matching

The ceremony reuses the primitives `filing.ts` already exports (`entityAnchors`, `keySegments`,
`isNearDuplicate`) rather than writing a second matcher beside the first, with two seams those
primitives don't cover, both stemming from the same fact: they tokenize a kebab-case dedup key, and
an issue title is prose. The first seam is segmentation, closed by an adapter below. The second is
the anchor gate, which cannot be reused as is and gets its own title-side extractor, argued in full
further down this section. Closing that seam needs a title-to-key adapter, `titleToSegments()`, named here
because leaving that seam unnamed is exactly where a second matcher gets born: lowercase, strip
punctuation, split on whitespace, drop the same severity and staleness words `keySegments`
already strips. `titleToSegments()` stays a pure adapter into the existing scoring math, never a
second scorer. Two dedup implementations in one codebase would be exactly the drift class this
spec exists to close, one level up.

Any issue still carrying an `sm-dedup:` marker is already solved, the cheapest pass there is, and
the ceremony skips it unless a new candidate merges into it.

The second pass is deterministic and calls no model. It runs each issue's title through
`titleToSegments()` and scores it against every other title's segments the way `isNearDuplicate`
scores two keys, except the anchor gate cannot be `isNearDuplicate`'s gate unchanged.
`ENTITY_ANCHOR_RE` requires the entity word and its digits joined by at most one hyphen,
underscore, or dot (the slug form the filer mints), and it returns an empty set on prose. Measured
directly against this backlog's real titles: `PR #83 red CI blocking merge (doc-size + test, 9h)`
(#707) and `Batch-two PRs #107/#108 conflicted, awaiting fix loop` (#1084) both extract zero
anchors under `ENTITY_ANCHOR_RE`. Over an absolute equality gate, empty equals empty, so the two
clusters would pass the gate vacuously and merge on ordinary word overlap alone (both share
"blocking", the "red"/"conflicted" state wording, and "fix loop"). That is the exact failure the
gate exists to prevent.

This pass computes its anchors from a different string, with a function of its own:
`titleEntityAnchors()`, living beside `titleToSegments()` in this ceremony's own module, not
`filing.ts`. `entityAnchors`/`ENTITY_ANCHOR_RE` stay exactly as `filing.ts` defines them, reused
unchanged for `filing.ts`'s own job of comparing two minted keys. `titleEntityAnchors()` matches
`pr`, `prs`, `issue`, `issues`, `gh`, or `ghs` (case-insensitive), followed by up to three
characters drawn from whitespace, `#`, `:`, or `-`, followed by one to four digits. The matched
entity word is normalized to its singular form BEFORE the anchor is built, so the extractor returns
one anchor per match as `<singular word><digits>`. Without that step a plural title anchors
differently from a singular one naming the same thing: measured on the snapshot, six issues write
the #107 entity in plural form and two in singular, which would make #1099 and #1103 (one
condition, near-identical wording) come out non-empty and disjoint, and the conflict predicate
would split the very cluster this section uses as its example. Run against real titles, #707 returns `{pr83}`, #1084
returns `{pr107}`, and #713 (`Doc PR cluster stalled: PR #83 red CI, PR #81 unreviewed`) returns
`{pr83, pr81}`, because the match is global and each qualifying entity-word occurrence contributes
its own anchor.

The gate built on top of it also has to change, because exact set equality is the wrong test over
prose. `isNearDuplicate`'s gate passes two empty sets as equal, correctly, for a minted key, where
an empty set means "this finding names no entity" on purpose. Over titles an empty set usually
means the extraction missed, not that the title names no entity, so an equality gate would block a
title with a stray anchor from every title whose extraction came back empty. That reading is
backwards. Checked against the Corsair cluster, this spec's own regression fixture: 19 of its 20
members return `{}` from `titleEntityAnchors()` (including the canonical, #819), and the
twentieth, #871 (`... same trap class as issue 867, new location`), returns `{issue867}`, a
cross-reference to a fellow cluster member, not a competing PR. An equality gate would strand #871
from the other 19 over that one mention.

So the gate this pass uses is disjointness, not equality. It blocks a match only when both titles
carry a non-empty anchor set and those sets share no anchor. `{pr83}` against `{pr107}` (both
non-empty, disjoint) blocks, recovering the PR-83/PR-107 separation the equality gate could not
reach on prose. `{pr83, pr81}` against `{pr83}` (both non-empty, overlapping) does not block.
`{}` against anything does not block, and falls through to segment scoring, same as before.
`{issue867}` against `{}` does not block, so #871 stays reachable from the rest of its cluster.
This is a new predicate, `titleAnchorsConflict()`, not `isNearDuplicate`'s gate reused as is.
It tests disjointness over prose anchors rather than equality over slug anchors, because a slug
either carries its anchor or the caller left it out on purpose, while a title's anchor is present
only when the extraction happened to fire on that wording.

Pilot names and action or mechanic names pulled from `docs/game-reference/commands.md` are not
folded into `titleAnchorsConflict()`. Checked directly against this spec's own regression fixture:
the Corsair cluster's canonical, #819 ("Unarmed pilot trapped in battle: retreat/get_battle_status
unregistered, only self_destruct escapes"), and at least two other members of that 20-issue
cluster never use the word "corsair" at all. A conflict gate over a widened anchor set (pilot and
action names folded in as anchors) would make each of them unreachable from the seventeen-plus
members that do use it: stricter, not broader, the opposite of what this pass needs. So pilot and
action vocabulary scores as ordinary segments in the Jaccard overlap instead, weighted like any
other `titleToSegments()` output: two titles sharing "corsair" and "battle" score higher, but
neither word is required for a match. This mirrors the split `filing.ts` already draws between an
absolute gate and a similarity score, applied to the vocabulary this pass adds.

Named plainly: this pass does not reuse `filing.ts`'s anchor gate for titles, because that gate
cannot fire on titles at all, measured above. `entityAnchors`/`ENTITY_ANCHOR_RE` stay the one
place the numbered-entity-separation property is defined for minted keys, reused unchanged at
`filing.ts`'s own mint-time gate. `titleEntityAnchors()`, `titleAnchorsConflict()`, and
`titleToSegments()` are this ceremony's own adapters for a job `filing.ts` was never asked to do:
ranking many prose titles against each other rather than comparing two minted keys. `filing.ts`
remains the sole definition of whether a freshly filed finding matches an already-open issue at
mint time. This ceremony owns the separate question of separating and clustering already-filed
prose after the fact, with its own anchor extraction and its own, narrower, conflict rule, both
named here rather than left implicit. Each definition of "these two things are probably the same"
is scoped to one layer, mint-time key comparison or after-the-fact title comparison, and each is
stated for what it actually reads.

The third pass runs on Sonnet, and only on what the second pass leaves unresolved: issues that
stayed singletons or scored below the match floor. It compares title and body meaning directly.
This is the layer the key matcher cannot do at any threshold, because it never reads body text
and has no representation of meaning beyond a slug. It is also the only layer that can catch an
operator-authored issue, since those carry no key for the first two passes to key off at all.

Canonical selection follows the rule the human pass already used and states in its own method
section: cause over symptom, then evidence weight, then lowest, oldest, issue number.
Concretely, the ceremony prefers a member whose text names a cause (it cites a file, a function,
or uses language like "because" or "root cause") over one reporting only a count of failures.
Among cause-naming members it prefers the one with the most cross-references from other open
issues, then breaks any remaining tie on issue number. The key matcher cannot make this call at
all. Its output is a boolean, matches or doesn't, never a ranking, because `fileFinding()` only
ever needs to know whether one candidate already has a home, never which of several existing
issues is the best one to keep.

## Setting and measuring a precision target

The target is precision of 0.95 or better on high-confidence proposals, and 0.85 or better on
medium, measured against reviewed proposals only (see below), never against the full unread
total. A false merge buries a real, distinct finding inside another issue's comment thread,
where the default priority-P2 labeling (#687, #858: every machine-filed issue gets the same
priority regardless of stated severity) already makes it easy to miss. A missed duplicate only
costs one extra line in a report. The bias runs the same direction the human pass took by its
own stated method: when in doubt, split.

A ceremony cannot certify its own precision. Grading a matcher's confidence with the same matcher
is circular. So precision gets measured, not asserted, two ways. Every proposal comment cites its
evidence inline (the matched anchors, the Jaccard score, or the semantic-similarity basis), so a
person can check the specific claim against the two issues without re-deriving it. And a
precision ledger, kept in the tracker rather than a local file, counts only proposals a person
actually adjudicated. A proposal enters the denominator when a person acts on it. Stripping the
`dedupe:candidate` label or commenting disagreement records one false positive. Applying a
`dedupe:confirmed` label or commenting agreement records one true positive. A proposal nobody has
touched contributes to neither count. It stays visible, tallied separately as unreviewed, so the
ratio can never approach 0.95 by inattention on a backlog nobody read.

The ceremony's own standing report (see "Done-when," below) states the ratio as true positives
over reviewed total, in the form "0.93 (14/15 reviewed)," beside the count still unreviewed and
the raw proposal count. A denominator of zero prints as "no reviewed proposals yet," never as a
ratio. This turns "is the ceremony accurate" from a claim into a number that names its own
sample, the same way `filing.ts`'s consumer-evidence probe turns "is anyone closing issues" from
an assumption into a mechanical read of tracker state (`probeConsumerAction`, `filing.ts:471`).

## Idempotence

A year of weekly runs over a backlog that stops changing must produce zero new comments after
the first pass, not 52 reports and not 52 restatements of the same pairing.

Each proposal's marker lives in the issue itself, not on the scheduler host, and is keyed on the
pairing it proposes, this member issue and this canonical issue, never on the cluster's overall
size. Each comment and its paired label carry `<!-- sm-dupe-cluster:<canonical-number> -->` on
the member issue, the same in-tracker-marker pattern `filing.ts` already uses for its own
idempotence (`SM_DEDUP_MARKER_RE`), rather than a second, host-local state file that a redeployed
container or a wiped state directory could silently drop. Before posting anything, the ceremony
reads the target member issue's existing comments. If a marker naming this same canonical is
already present, it does nothing. Because the marker carries no member count, a cluster gaining
or losing members never touches the issues already marked. Corsair gaining a 21st report
proposes one new pairing for that new issue alone, not twenty repeat comments on the nineteen
already marked. A member that gets re-clustered under a different canonical is usually a real
change in the ceremony's conclusion, not churn, and correctly earns one fresh comment naming the
new pairing.

A re-cluster caused by the old canonical closing is carved out and does not earn a fresh
comment. A closed canonical is the good outcome, the underlying defect got fixed, and re-pointing
every remaining member to a freshly chosen canonical would spend a whole run's proposal budget
restating a group that just got resolved, at the cost of clusters nobody has proposed yet. A
member whose existing marker names a canonical that is now closed keeps that marker rather than
earning a repost: a marker pointing at a closed issue already tells a reader "this was resolved
via #NNN" without the ceremony saying it again. Re-clustering for any other reason (a
better cause-naming member surfaces, or a new member changes the ranking) still earns the fresh
comment, unchanged from above.

Cold start against today's 83 clusters (389 members, 249 of them in the 43 high-confidence
clusters, the rest in the 40 medium- and low-confidence ones) proposes at the same 20-per-run
budget "Cadence and cost" sets, largest cluster first. The high-confidence set alone takes
roughly 13 weekly runs to fully propose, and the full 83 clusters roughly 20. The delta gate
described in "Cadence and cost" does not apply during this drain. A run always spends its budget
against the not-yet-proposed set first, regardless of how many issues opened since the last run,
so a quiet week cannot stall a cold start that has not yet finished.

The not-yet-proposed set is never stored as a set. The second pass is deterministic and calls no
model (see "Matching"), so re-deriving all 83 clusters from a fresh fetch costs nothing: every run
re-fetches the open backlog and rebuilds the clusters from scratch. "Not yet proposed" is then this
run's freshly rebuilt clusters minus whatever members already carry a matching
`sm-dupe-cluster:` marker, recoverable every run from the tracker's own markers plus a free
recomputation, never from a stored membership list that could drift from the backlog it describes.
Only the delta gate's own input has to persist between runs: the newest issue number scanned, so
the next run knows how many issues are new. That one number lives in the ceremony's standing
report issue, the one "Done-when" already requires, as the report's machine-readable high-water
mark. Every piece of the ceremony's state stays tracker-resident this way, the same posture the
per-member marker above takes, and it survives a redeployed container or a wiped state directory
exactly as that marker does.

The standing report follows the doc steward's own lesson about empty output. #1049, filed by that
same steward against itself, names the cost of a ceremony that reports even when it found
nothing: a branch, CI runs, and a review obligation spent on a negative. This ceremony's report
updates in place, one issue edited, never a fresh one per run, and only when the cluster set
actually changed from the last run. A stable backlog gets silence, not a weekly "checked, all
clear."

## Cadence and cost

The ceremony runs weekly. Duplicate pressure accumulates slowly. This pass measured roughly ten
weeks of drift, so nothing is lost running less often than the 6-hour strategy review or the
2-hour standup, and every run past the first is cheap: it gates the same way the
strategy-reviewer charter gates its own step 0, by counting how many issues opened since the
last run's high-water mark. A week with fewer than 10 new issues skips the SEMANTIC pass, which is
the only part that costs a model call. The deterministic pass still re-derives every cluster on
every run, because it is free, and that is what makes the not-yet-proposed set recoverable without
storing it: a run rebuilds the clusters, reads each member's marker, and proposes from whatever is
still unmarked. So a week under the threshold still spends its 20-proposal budget and thins the
un-proposed backlog rather than pausing on it. Nothing anywhere stores a cluster membership list.
See "Idempotence".

The fetch is paginated and reports its own truncation, the same honesty `filing.ts`'s
`findNearMatch` already builds in (`NearMatchFetch` is `"ok"`, `"truncated"`, or
`"unparseable"`, `filing.ts:500`), rather than the near-match scanner's fixed 400-issue cap,
which this backlog's 521 open issues already exceed.

The model tier is Sonnet, but only for the third matching pass. The first two passes are
deterministic code with zero LLM calls, matching this project's plan-then-execute cost floor
(AGENTS.md, Stack). Only the issues those passes leave unresolved go to the Sonnet semantic
pass, a shrinking number after the backlog's current 389 duplicates get their first proposal
pass, so the first week is the expensive one and every week after is marginal.

The stopping condition per run is a proposal budget, not a scan budget: a cap of 20 new
labels or comments posted per run, the same shape `FINDINGS_PER_CYCLE_CAP` already caps filing
at (`filing.ts:283`). The ceremony scans the whole backlog every run but spends its proposal
budget on the highest-value clusters first, largest member count first, since that reduces
report noise the most per proposal spent. A cold start against today's 83 clusters spreads its
proposals over several weekly runs instead of posting 249 comments in one pass no reviewer could
plausibly sample-check in one sitting.

## Done-when

The done state is observable in the tracker, never just "the ceremony ran."

The clusters this measurement pass already found and links in its report, the 43 high-confidence
ones covering 249 issues, are independently rediscovered and carry a `dedupe:candidate` label
with a cross-reference comment naming the proposed canonical. That known set is this spec's own
regression fixture: a ceremony that cannot reproduce it against the same snapshot has not built a
working matcher.

A second run over an unchanged backlog posts nothing. This is checkable directly: comment and
label counts before and after a re-run come out equal.

The standing report states, in one line, how many of the 521 open issues are flagged as
duplicates of how many canonicals, the number a person should actually read as "distinct open
work" rather than the raw open count.

At least one human spot-check of a proposal sample has happened, and its result is recorded in
the precision ledger, the concrete evidence "Setting and measuring a precision target" above requires before
auto-close is ever considered.

## Ceremony vs. producer fix

Is a ceremony even the right instrument? Only partly: the producer fix matters more. It is
already filed as its own tracker issue, #1133, and the operator has approved building both the
ceremony and the producer fix, rather than gating one on the other or folding both into one
change.

The root cause, established above, is that `fileFinding()`'s matcher only ever sees a slug an
agent invented, never the finding itself. The producer-side fix, #1133, is to make the filer see
defects instead of key wording: have `fileFinding()` run this ceremony's own title-matching check
against the open backlog before minting a key, so most of the 389 duplicates in today's
report never get filed in the first place, instead of getting filed and cleaned up after. That is
the fix that actually stops the leak. A ceremony only mops the floor under it.

Three reasons to build the ceremony first anyway. `filing.ts` is a security-reviewed, load path
every ceremony calls (the Batch C security-review comments run through the whole file). A
regression in its dedup logic fails silently: a bad match swallows a real new finding into
an unrelated issue's comment thread, invisible until someone goes looking, the exact failure
#1029 and #945 already measured once. A ceremony's wrong proposal is only a label a person can
strip in five seconds. Second, the existing 521-issue pile needs a retrospective pass regardless.
Even a future filer that never mints a bad key again does nothing about the roughly 389
duplicates already open today. Something has to work through the backlog that already exists,
whichever fix lands first. Third, the authorities fit differently. The ceremony proposing labels
and comments is the same shape of authority `filing.ts` already exercises, the comment-bump
verdict in `docs/superpowers/specs/2026-07-18-durable-scheduler.md`, so it needs no new council
verdict. Teaching the filer to predict duplicates at mint time means an LLM call inside the hot
filing path, on every finding, where a wrong call silently discards a finding no one asked to
review. That is closer to the dispatch-authority class of change the same spec's verdict (b)
covers than to a one-line filing tweak, and it deserves its own spec and its own review before it
merges.

What a slow producer fix costs, stated plainly: every week the filer stays dumb is another week
of new near-duplicates for the ceremony to work through next cycle. The report's largest clusters
are still growing week over week by their own timelines. This spec treats the symptom, cheaply
and safely. The producer fix, #1133, is the one that stops the disease. Decision: build this
ceremony now. #1133 stays separate, its own issue and its own future spec, with the operator's
approval to build both rather than bundle them. One change at a time still governs the build
(AGENTS.md, SSOT/DRY/KISS, and simplicity-rules on isolating before bundling): this spec covers
the ceremony, #1133 tracks the filer fix.

## Non-goals

- Auto-closing anything, this build. Deferred to a future spec once the evidence bar in "What the
  ceremony does" is met.
- Dispatching a fix agent for a cluster. Out of scope entirely. That authority belongs to the
  durable-scheduler spec's own verdict (b), unrelated to deduplication.
- Rewriting `filing.ts`'s own matcher. Named above as the real fix and deliberately left for a
  separate spec.
- A second matcher over minted keys. `filing.ts` keeps sole ownership of mint-time sameness, and
  this ceremony does not touch it. The ceremony owns a separate, clearly scoped job: retrospective
  clustering over title and body prose, which needs its own title-side extractor because the
  filer's pattern reads slugs and returns nothing on prose. Two layers, two stated definitions, one
  owner each. What is ruled out is a second matcher doing the SAME job as an existing one, which is
  what drifts.
