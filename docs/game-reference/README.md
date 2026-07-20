<!--
  Provenance: index page, written by us (not upstream).
  Everything under upstream/ is a verbatim capture from www.spacemolt.com, 2026-07-13.
  Re-capture upstream (network): bun run scripts/refresh-game-reference.ts --live
  Rebuild commands.md offline (default): bun run scripts/refresh-game-reference.ts
-->

# Game reference — the vendored SSOT

The game's own documentation, copied into the repo. When an implementer or a reviewer needs to
know what an action does, what it takes, or what it returns, the answer is here — not in a guess,
not in a web search, and not in a live probe against the account our pilot is flying.

**Why this exists.** Every "miss the mark" bug we have shipped came from the same place: nobody
had the reference, so the implementer guessed and the reviewer had no way to check the guess.
We assumed `auto_list` would clear a no-demand hold (it doesn't). We assumed palladium was
worthless (it isn't). We guessed the shape of `view_market` and `get_system`. Issue #105 called
that root cause by name. The fix is not "be more careful" — it is to put the authoritative text
one file away and make checking it cheaper than guessing.

**Evidence precedence: (1) a live capture from the game beats (2) the vendored reference, which
beats (3) any assumption.** The vendored reference is authoritative until reality contradicts it —
at which point reality wins and the contradiction gets captured as a fixture and noted in the
reference with a dated correction. This project has been burned both ways: the game's own refuel
prose taught `fuel_cells` when the real item id is `fuel_cell` (#179), and the `auto_list` behavior
the docs implied was falsified live (2026-07-12). Never guess; prefer the reference over your
instinct; prefer a capture over the reference.

## Start here

| File | Authoritative for |
|---|---|
| [`commands.md`](commands.md) | **The index.** Every action in the game, one line each: params, mutation-or-query, and whether our harness registers it. Open this first. |
| [`progression.md`](progression.md) | What each playstyle is climbing toward — ship/skill/module ladders and end-states. Feeds #213 and #216. |
| [`corrections.md`](corrections.md) | **Where a live falsification overrides the vendored page.** Dated notes, one per contradiction, kept in a sidecar the refresh never touches so a re-capture can't wipe them (issue #326). |
| [`upstream/`](upstream/) | The verbatim capture. Nothing in here is edited by us. |

## What's in `upstream/`

Captured 2026-07-13 from `www.spacemolt.com`. These are byte-for-byte copies — we add nothing to
them, not even a provenance header, because the moment we edit a captured file a refresh diff stops
telling us what the *game* changed. So provenance comes from where the file sits, not from a header
we pasted on: the URL pattern in the table below is the canonical source for every path, and the
capture date is this line. The 12 `guides/*.md` pages happen to carry upstream's own front-matter
(`title`, `doc_version`, `last_updated`, `canonical`) because upstream publishes them that way; the
29 `docs/*.md` mechanics pages do not, and we leave them as they are.

| Path | Source | Authoritative for |
|---|---|---|
| `openapi-v2.json` (4.5MB) | `/api/v2/openapi.json` | **The API SSOT.** OpenAPI 3.1, 286 paths as `/api/v2/{tool}/{action}` — the transport we actually speak. Full request *and response* schemas, plus `x-is-mutation`. This is where guessed response shapes go to die. |
| `openapi-v1.json` (1.5MB) | `/api/openapi.json` | The legacy flat-command spec (210 paths, `/api/v1/{command}`). Kept because the published guides and `skill.md` use v1 command names (`loot_wreck`, `deposit_items`) where v2 uses tool/action (`spacemolt_salvage.loot`, `spacemolt_storage.deposit`). Use it to translate. |
| `skill.md` (71KB) | `/skill.md` | The agent manual the game hands to any AI playing it: the command set grouped by purpose, the combat system, notifications, session rules, and its own advice on how to play. |
| `api.md` (64KB) | `/api.md` | Protocol reference: HTTP v1/v2, WebSocket v1/v2 framing, session lifecycle, error shapes, rate limits, the catalog download. |
| `docs/*.md` (29 files) | `/docs/<topic>.md` | Mechanics, one topic per file: mining, markets, crafting, combat, factions, stations, drones, espionage, taxes, wildlife, death, salvage, passengers, and more. |
| `guides/*.md` (12 files) | `/docs/guides/<name>.md` | Playstyle guides with the progression ladders. `drones.md` and `fuel.md` are 25KB each and effectively sub-manuals. |
| `sitemap.md`, `glossary.md` | `/sitemap.md`, `/glossary.md` | The full page directory and the terminology. |

**Not vendored:** `https://game.spacemolt.com/api/catalog.json` — every item, ship, module,
recipe, skill, facility, and achievement in one file. It is a download-once-per-version artifact
and belongs to issue #104 (catalog ingestion), which wants it parsed rather than pasted. The
`version` field tells you when to refetch; it is rate-limited to 1 request/minute.

## Refreshing

```
bun run scripts/refresh-game-reference.ts          # OFFLINE (default): rebuild commands.md from the vendored spec
bun run scripts/refresh-game-reference.ts --live   # NETWORK: re-capture upstream/, then rebuild commands.md
```

Safe by default: a bare run rebuilds `commands.md` offline from the already-vendored spec and never
touches the network or the `upstream/` files. Re-capturing the vendored docs makes live HTTP calls
and overwrites the reference, so it is gated behind an explicit `--live` (alias `--fetch`). No
regeneration of the command index can fire live traffic by accident (#424).

The `--live` path is read-only HTTP GETs against public documentation URLs. No session, no login, no
game action — nothing here touches the account the pilot is flying. The spec endpoints are
rate-limited to one request per minute per IP, so the script fetches them last and backs off; the
whole run takes a couple of minutes, most of it waiting politely.

`commands.md` is generated — do not hand-edit it. Its ✅/⬜ column is read from
`src/registry/actions.ts` at generation time, so it cannot drift from our code without someone
noticing: register an action, regenerate, and a ⬜ turns ✅.

Run it when the game ships a release (`get_version` moves), or when a captured shape stops
matching reality. The upstream files are byte-for-byte copies, so a refresh diff shows only what
the game changed.

## The capability gap

The game exposes **268 actions**. Our harness registers **34**. One more (`session`) is transport
plumbing the HTTP client calls directly, so it can never be a registry action. The other **233**
are things the game can do and our pilot cannot — that is not a bug list, it is the shape of the
map we have not walked. The ⬜ column in [`commands.md`](commands.md) is the gap, kept honest by
generation and by a drift test (`test/game-reference-drift.test.ts`) that fails `bun test` if the
committed table stops matching the spec and the registry — not by a table someone has to remember
to update.

The exclusion bar is deliberately narrow: a route is 🔌 only if `src/client/http.ts` really calls
it. `notifications` and `agentlogs` are *not* excluded — nothing in `src/` calls either one, so
they are unregistered capabilities exactly like the other 231, and calling them "plumbing" would
have flattered the gap by 2.

The three that hurt most today, all of them on the critical path from "mine ore" to "get anywhere":

1. **`spacemolt.craft` / `recycle`, and all 48 `spacemolt_facility` actions.** Refining is what
   the game's own miner guide calls the big profit boost. Our pilot sells raw ore, which is the
   floor of the economy, and it has no way to do anything else.
2. **The entire `spacemolt_ship` tool (19 actions) plus `install_mod` / `uninstall_mod`.** No
   `browse_ships`, no `buy_listed_ship`, no `switch_ship`, no `commission_ship`, and no way to
   fit a better mining laser. The pilot cannot buy or improve a ship. Every progression ladder in
   [`progression.md`](progression.md) runs through these.
3. **`survey_system` and the buy side of the market** (`create_buy_order`, `modify_order`,
   `cancel_order`, `estimate_purchase`). No surveying means no finding a richer deposit when the
   current one goes sparse; no buy orders means no arbitrage, which is a documented income stream
   we simply do not have.

Also entirely unwired, in case a persona wants them: `spacemolt_battle` (9), `spacemolt_fleet`
(10), `spacemolt_drone` (8), `spacemolt_intel` (8), `spacemolt_citizenship` (4), passenger
transit, and 28 faction actions.

This is the third time we have found capability we never wired (#124 missions, #176) — which is
the argument for reading the reference before building, and for this file existing at all.
