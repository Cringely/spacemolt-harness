# Project State

> The handoff file. Any session (primarily Claude Code from terminal) resumes from here.
>
> **Standing rule (STATE freshness):** the `## NOW` block below is PM-owned and MUST be refreshed at every wave of work, every merge cluster, and every compaction/away-transition, **including IN-FLIGHT work**, so progress is visible remotely without reading the code. STATE.md is a living handoff with no logic to review; keep it current via a lightweight self-merged docs PR rather than letting it lag behind batch merges.

**Last updated:** 2026-07-20 (PUBLIC REPO LIVE — this is now the primary repo, github.com/Cringely/spacemolt-harness)

## NOW, live status

_Refreshed 2026-07-20 (scrub verified + merged to main). Boot from this block + `docs/backlog.md` (GitHub Issues are SSOT) + `docs/game-reference/commands.md`. Capped at 500 words by `test/doc-size.test.ts`._

**P0 — PUBLIC FLIP COMPLETE (2026-07-20).** `github.com/Cringely/spacemolt-harness` is LIVE and PUBLIC, seeded as one clean initial commit (null history, so none of the 93 internal-referencing commit messages ship). Why: CI was billing-dead on the private free tier (frozen at image `eb0056b`); a fresh public repo (option B) restores free Actions. Seed = the private `spacemolt` main tree after the full scrub (S1 #468, S2 #471, S3 #469, G1/G2/G3 #475/#473/#474) + residual cleanup (#479/#480/#481/#484). VERIFIED CLEAN before exposure four ways: whole-tree audit PUBLIC-READY; gitleaks history + dir (0 leaks); export sweep; GitHub tree check. Post-flip hardening this session: MIT LICENSE added; branch protection + Actions contributor-approval set. STILL OPEN (operator): GHCR image visibility (image at `eb0056b`, private namespace); private `spacemolt` repo fate (archive per plan). #478 re-homes the compose-hardening check privately.

**MODEL POLICY.** Fable = prose seats, Opus everything else, cheap tiers for bulk. Usage 34% all-models / 25% Fable, boosted limits.

**PILOT.** Codex/gpt-5.6-terra re-armed as pilot (offload until #240; first GPT plan 17:16Z, model-stamped, 6h revert latch, sonnet fallback). Overnight: Deep Core Prospecting COMPLETED (first via M-40 gate); 120,600cr wasted buying titanium at ~400× catalog, since mine_resource counts MINED only (#458 P1: buy guard). Credits ~52k. Fresh titanium contract 0/20.

**WIRING LIVE (operator caught the plaintext draft).** Dead-man alarm delivering to the alert topic (phone-confirmed). Strategy store path over a TLS reverse-proxy carve-out (plaintext LAN port vetoed + replaced; per-gate verified; split-horizon on-LAN); 546 plans queued, first strategy review next 6h window. Decisions entry 2026-07-20.

**SCHEDULER (#114).** Stages 1-3 + Stage-4 capture merged. 32h outage Jul 19-20 (steward stranded checkout; #438 self-heal can't deploy through its own break, #459 P1 host bootstrap). Stage-4 first poll HTTP 403 (#183). Dispatch gate OFF.

**CODEX REVIEW SEAT (#460) LIVE.** `bun scripts/codex-review.ts <PR>` advisory; smoke ADVANCE on #446. Run beside Claude reviewer.

**RECENT MERGES LIVE (07-19).** #442 5xx backoff; #444/#446 missions UI; #449 escrow; #450 usage slice; #451/#452/#454/#455 tech-debt. Closed #121/#122/#123/#150/#215/#322/#427/#431/#436.

**THEN:** public repo creation + post-flip hardening (P0, operator hands — see P0 block); #213 goal-ladders workflow off-peak; #459 bootstrap + #458 buy guard (both P1); #456 main-checkout gate; #466 merge-chain gate; #453 stall phase 2. Milestone Artifact current through M-49.

### (history: 2026-07-12 layers archived to docs/archive/STATE-2026-07-17.md; earlier to docs/archive/STATE-2026-07-13.md)
