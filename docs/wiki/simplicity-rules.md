# Simplicity Rules — lessons from an earlier project

An earlier harness project paid for one hard lesson, and this page imports its portable core. The language- and game-specific mechanics stayed behind.

## The story these rules come from

That earlier project sent a pull request to a third-party project maintained by an experienced author. Every bug diagnosis in it was *correct*. The maintainer rejected the code anyway and reimplemented each fix himself, smaller. One fix that took ~30 of our lines took 1 of his, because he fixed where the bad data was *produced* while we had guarded where it *crashed*. A thread-safety lock we added defended against a caller that, once finally traced, turned out not to exist. The lesson was not "be smarter." A correct diagnosis wrapped in an oversized fix is still a failed contribution. These rules exist to keep fixes and features as small as the problem actually is.

## The rules (binding on all implementation and review work)

**1. Fix the producer, not the consumer.** Before writing a fix, state the violated invariant (the condition that should always hold) in one sentence: "X should hold Y, established at Z." Then patch where the bad state is *created*, not where it blows up. Guarding the crash site (null checks, wrappers, defensive copies) is a last resort that requires written justification. A fix that can't state its invariant gets a minimal local workaround, never a structural change.

**2. Isolate before bundling.** When two defects appear at one failure site: fix one, re-confirm the second still reproduces against the fixed build, and only then write code for it. In that project, a whole synchronization layer shipped for a "second bug" that evaporated once the first fix was in. Never ship entangled fixes as a bundle.

**3. Complexity needs a receipt.** Every new primitive (a lock, a cache, a tunable threshold, a fallback path, a config option) carries a one-line justification naming the simpler alternative that was tried and rejected. Trigger by construct kind, not diff size. Concurrency specifically: no synchronization without an actual traced caller that needs it. "Might be called concurrently someday" earns a comment, not a lock.

**4. Review verdict is joint: correct AND smallest.** A change passes review only if it fixes the named problem and is the smallest change that does so. Correct-but-larger is a revision request, not a pass. Don't bolt on a separate "simplicity check" stage; a separate gate is a separate objective that the author learns to game. Note the structural trick that makes this cheap: the reviewer gets the finished diagnosis, so their task ("find a smaller patch or certify none exists") is far easier than the original diagnose-and-fix.

**5. A cache is only as correct as its enumerated inputs.** Before shipping any memoization, dirty flag, or fingerprint: list *every* input the cached result depends on, including sneaky live ones (settings, collections, clocks), and show each is either captured by the cache key or provably immutable. This bit that project twice. When inputs have no change signal, a simple time-based refresh usually beats a clever dirty-key design. (Directly relevant here: Plan 2's digest templates and reflex policies are caches of game state.)

**6. No plan ships with a load-bearing unknown.** A design that depends on an unverified mechanism ("this API probably works like...") gets the mechanism verified against ground truth before approval, not asserted from plausibility. This project already lives the rule: the phase-0 container-auth spike exists because subscription auth in Docker is our load-bearing unknown.

**7. Shallow scans don't grant clean bills of health.** In that project, a quick agent survey rated a resource-leak pair "correctly paired"; a deeper read found the leak. Fan-out scans are for *finding* candidates. Any contested or load-bearing finding gets verified by actually reading the source.

**8. Set the right target.** The deliverable for any fix or contribution is a minimal, provably-correct change plus a diagnosis clean enough that a maintainer could accept it or reimplement it in minutes. Don't try to guess the whole architecture's intent; hand over something small and true.

## How these are enforced here

- The global fix-quality rules (user-level, active in every session) already encode 1-4 for the PM.
- Batch lead briefs from Batch C onward include the joint verdict rule (4) in reviewer prompts.
- The council gate audits the shipped suite against 4 and the no-busywork bar together.
- Plan 2's cache-shaped features (digests, reflexes) must pass rule 5's input enumeration in their spec.
