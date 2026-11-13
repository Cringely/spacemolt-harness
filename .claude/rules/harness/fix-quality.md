# Fix Quality: Locus and Cost

Born from a public PR postmortem (2026-07-04): every diagnosis was correct, yet the
maintainer reimplemented each fix smaller by fixing causes instead of guarding symptoms. These
rules govern fix selection after root-causing, in any codebase.

## Fix the producer, not the consumer

Before writing a fix, name the violated invariant in one sentence: "field/condition X should
hold Y, established at Z." Then name where the bad state is produced and where it is consumed.
Patch the producer by default. Guarding the consumer (null checks, wrappers, transpilers at the
crash site) is a last resort used only when no writable seam exists at the source, and the
candidate file or commit must say why. A fix that cannot state its invariant is limited to a
minimal local workaround, never a structural change.

## Prove the premise before replacing a mechanism

To replace an existing mechanism, reproduce the failure with only that mechanism at fault.
When two defects co-occur at one crash site: fix one, re-confirm the second still reproduces
against the patched build, and only then write code for it. Never ship entangled fixes as a
bundle. Tag every shipped fix load-bearing: verified (ablated) or assumed (with the reason the
ablation was skipped) — "assumed" is a flag, not a footnote.

## Complexity needs a receipt

Every new primitive (concurrency type, ThreadStatic, tunable constant, threshold, dedup
structure, fallback path) carries a one-line justification naming the simpler cause-site
alternative that was tried and rejected. New synchronization requires an actual call-path trace
to a real off-main-thread caller in the code being shipped. Without one, the fix is a
main-thread-only assertion comment, not a lock. Trigger receipts by construct kind, not diff
size — line-count thresholds are gameable. A diff much larger than the code it fixes is a smell
prompting a restart from the cause, not an automatic reject.

## A dirty cache is only as complete as its enumerated inputs

Before shipping any memoization/dirty-flag/fingerprint, enumerate EVERY input the cached output
depends on — including dynamic ones that don't look like state (current keybindings, live
collections, external singletons) — and show each is captured by the key or provably immutable.
An uncaptured input is a silent staleness bug (bitten twice: a cached value band,
and a rebindable hotkey). When inputs expose no change signal and hand-rolled equality
would sprawl, a cadence throttle is usually the smaller, safer win than a dirty key.

## Review with a joint verdict, not a separate simplicity gate

Review passes (ADVANCE) only when both hold: the diff restores the named invariant, AND it is
the smallest change that does so. The reviewer — a fresh context given the finished diagnosis,
a constrained task far easier than the original diagnose-and-fix — must either produce a
smaller patch fixing the same root cause or certify none exists. Correct-but-larger is REVISE.
Do not add simplicity as a separate stage or checkbox. A separate gate is a separate objective
the authoring context games.

## Pin the correctness baseline

State whose environment defines correct before hardening anything. An issue that reproduces
only under this machine's mods/config/data is a local patch, never an upstream submission.
Upstream cannot justify defending against callers that exist only in third-party extensions.

## Set the right target

When contributing to someone else's codebase, the achievable bar is a correct, minimal patch
plus a clean diagnosis the owner can accept or reimplement in minutes — not matching the
owner's intent model, which no amount of reading their code fully yields. Surfacing a real,
verified defect with a minimal fix is the win condition.
