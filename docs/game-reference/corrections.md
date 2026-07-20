<!--
  Provenance: written by us (not upstream). The refresh script NEVER captures or
  overwrites this file, which is the whole point. See scripts/refresh-game-reference.ts.
-->

# Game-reference corrections: where a live falsification is written down

Everything under [`upstream/`](upstream/) is a byte-for-byte copy of the game's own
docs. When we play the game and reality contradicts what a captured page says, the
evidence-precedence rule (AGENTS.md) is: reality wins, and the contradiction gets
noted in the reference with a dated correction. This file is where that note lives.

**Why a separate file, not a note inside the captured page?** A live refresh
(`bun run scripts/refresh-game-reference.ts --live`) re-downloads every `upstream/` file and
overwrites it verbatim. A correction written into `upstream/docs/markets.md` would be
silently erased the next time someone runs a refresh. That is exactly the bug issue
#326 fixed. Corrections live here, in a file the refresh never touches, so a re-capture
can never wipe them.

**A second guard, in the script itself.** The refresh also refuses to overwrite any
`upstream/` file that still carries an inline correction marker (a line beginning
`> **Correction`) until the note is moved here. So even a correction someone drops into a
captured page by habit cannot be lost to a re-capture. The refresh stops and tells them
to migrate it.

**How to add one.** Play surfaced a contradiction, you captured a fixture, and you want
it recorded: add a dated entry below (date, the item or action, the issue/PR reference,
and what the live behavior actually was). One entry per falsification. If you also
annotate the captured page in place, know the refresh will strip that annotation. This
file is the source of truth, not the page.

---

## `estimate_purchase` requires a dock (`upstream/docs/markets.md`)

**Correction (2026-07-17, live-falsified, issue #315):** this page and the OpenAPI spec describe `estimate_purchase` as callable from anywhere. In production, 15 of 15 calls made while undocked returned `purchase_estimate_error`: "You must be docked at a station to perform this action." Zero succeeded undocked in that window; docked calls succeeded normally. Treat `estimate_purchase` as requiring a dock, like `buy`/`sell`, until upstream corrects this page — our harness now gates its own fetch on docked state (see `docs/decisions.md`, 2026-07-17).

## Titanium sourcing: titanomagnetide deposits + overclocked laser (`upstream/docs/mining.md`)

**Addition (2026-07-19, operator-sourced, UNVERIFIED by capture):** the operator reports titanium ore is primarily mined from **titanomagnetide** deposits in asteroid fields and requires an **overclocked mining laser**. Neither term appears in our vendored pages or any live capture to date. Partial corroboration: `overclock_chip` exists in the captured catalog (consumable, uncommon, base 230cr), and the pilot's live experience matches the constraint (repeatedly blocked seeking titanium deposits at ordinary mineral fields, 2026-07-19 captures). Evidence tier: operator statement — below the vendored reference, above bare assumption. Confirm by live capture (a successful titanium pull naming the deposit, or a `deposit`/`mine` error naming the requirement), then upgrade this entry with the fixture. Steered the pilot with this lead the same day.

## `auto_list` on `sell` does not clear a no-demand hold (`upstream/openapi-v2.json`, `upstream/docs/markets.md`)

**Correction (2026-07-12, live-falsified, issue #123 / PR #454):** the `sell` action's optional `auto_list` param reads as the escape for cargo no NPC buys — set `auto_list=true` and the unsold quantity is listed on the player exchange, freeing the hold. In production it did nothing of the sort: the pilot sold `palladium_ore` with `auto_list:true` and got the identical `"Sold 0 ... N unsold (no buyers)"` result, hold unchanged. It does NOT reliably clear an item nothing buys. The real no-demand escapes are `jettison` (worthless cargo) and `create_sell_order` (valuable cargo listed on the player exchange); the digest briefs those. The param is now removed from the harness `sell` schema (`src/registry/actions.ts`, PR #454) — don't re-add it without a live capture showing it does something.

## Platinum sourcing: deep-space asteroid belts (`upstream/docs/mining.md`)

**Addition (2026-07-19, operator-sourced, UNVERIFIED by capture):** the operator reports platinum ore spawns across deep-space asteroid belts and is mineable with standard gear. The vendored pages deliberately document no spawn locations ("None of it is documented here", mining.md deep-core section), so this fills a real gap rather than contradicting anything. Related mechanics already vendored: hidden deep-core deposits require a survey scanner module + `survey_system` (mining.md L50-58). The operator's companion claim of a "live SpaceMolt Market Report" for cross-sector price tracking maps to the faction trade-intel API (station market reports, openapi-v2) and/or a website feature; our pilot already receives per-station market insights in its digest. Confirm by live capture: a platinum pull at a deep-space belt POI. Pilot steered with the lead the same day.
