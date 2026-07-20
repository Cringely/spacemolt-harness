# SpaceMolt API — durable facts

Verified against the live OpenAPI spec (a machine-readable contract listing every endpoint the game's API supports) on 2026-07-10 (`https://www.spacemolt.com/api/v2/openapi.json`, 283 paths). When the game updates, regenerate the slim fixture (our trimmed local copy of that spec, used in tests) with `bun run scripts/refresh-openapi.ts`.

## Protocol

- Base: `https://game.spacemolt.com`, pattern `POST /api/v2/{tool}/{action}` with JSON body. Each `{tool}/{action}` combination is an endpoint, a specific URL that does one specific thing.
- Session (your logged-in connection to the game, tied to one account): `POST /api/v2/session` → `{ session: { id } }`; send as `X-Session-Id` header on every call. Sessions expire after ~30 min inactivity; only one active connection per account (new login displaces the old).
- Tools (action groups): `spacemolt` (gameplay), `spacemolt_auth` (register/login/logout/claim), plus market, fleet, faction, social, etc.
- Docs: Swagger UI at `https://game.spacemolt.com/api/v2/docs`; static item/ship/recipe catalog at `GET /api/catalog.json` (fetch once, never paste into prompts).

## Tick model (drives the whole harness design)

- The universe runs on ~10-second ticks. Mutations (mine, travel, attack, buy...) execute once per tick; the HTTP request blocks until the tick resolves.
- `travel`/`jump` block for the full transit, so set HTTP timeouts ≥ 600s.
- Queries (`get_status`, `get_system`, `get_poi`, ...) are unlimited and instant. Poll freely.

## Auth flow

- Register: `spacemolt_auth/register {username, empire, registration_code}` → response `structuredContent.password` (256-bit hex; save it immediately, it is shown once). Registration code comes from https://spacemolt.com/dashboard.
- Login: `spacemolt_auth/login {username, password}`.
- Empires: `solarian` (balanced), `voidborn` (shields/stealth), `crimson` (weapons), `nebula` (cargo), `outerrim` (speed). Username 3–24 chars (spaces allowed).
- The registration code is account-independent: one code registers any number of accounts (operator-confirmed 2026-07-17; verified live 2026-07-16 when both fleet accounts below reused the miner's code).
- Fleet accounts (registered 2026-07-16, dormant until the #118/G4 gate opens; see #159): scout "Vela Farsight" (`nebula`, exploration fit), password in `secrets/scout_password`; corsair "Corvus Marrek" (`crimson`, combat fit), password in `secrets/corsair_password`.

## Response envelope (the standard wrapper every API reply comes in)

```json
{ "result": "human text", "structuredContent": {...}, "notifications": [...], "error": null }
```

- Error object: `{ code, message, retry_after?, details? }`.
- Error codes: `session_required`, `session_invalid`, `not_authenticated` (recreate session + re-login), `rate_limited` (sleep `retry_after` seconds, retry), `command_error`, `invalid_params`, `invalid_json`, `payload_too_large`, `method_not_allowed`, `missing_action`, `unknown_command`. v1's `action_pending`/`wait_seconds` appear consolidated into `rate_limited` in v2; we handle both.
- Every response can carry pending `notifications`: `{ id, type, msg_type, timestamp, data }` where `type` ∈ system|combat|trade|chat|friend|tip. Caution: `player_died` is a `msg_type` (arrives under type `system`), so filtering on `type` alone misses it.
- `get_notifications {limit≤100, types?, clear?}` drains the queue (100-message cap server-side; drain promptly).

## Status shape (`get_status` → structuredContent, "V2GameState")

Kitchen-sink schema (~16KB, all fields optional; different commands populate different subsets). Fields we rely on:

- `ship`: `fuel`, `max_fuel`, `hull`, `max_hull`, `cargo_used`, `cargo_capacity` (also shield, cpu/power, class, slots)
- `cargo`: array of `{item_id, item_name, quantity, size}` — per-item manifest (from the OpenAPI spec's V2GameState; not yet confirmed in a live capture)
- `player`: `credits`, `username`, `empire`, `faction_id`, `is_cloaked`
- `location`: `docked_at` (base id or null), `in_transit` (bool), `connections` (adjacent system ids)

## Gotchas learned so far

- An MCP endpoint exists (`https://game.spacemolt.com/mcp` — MCP is a different protocol for connecting AI tools to services; not what we use), but we deliberately chose HTTP v2 (see decision log).
- The game's own agent skill mandates community forum participation and captain's-log upkeep — social features we may use later for the agents' personas.
- Sell/buy accept an `auto_list` flag. The vendored reference says it posts any unfilled remainder as a standing order (1% listing fee on the listed portion). Live-falsified for *no-demand* goods (2026-07-12): the game returned "Sold 0 ... (no buyers)" and listed nothing, so it does NOT clear cargo nothing bids on. Issue #123 tracks pruning that assumed path; see engineering-lessons L-15. Whether it lists a partial-fill or temporarily-absent-buyer remainder is uncaptured.
