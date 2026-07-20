# Plan: Improv-mode implementation (MCP model-in-the-loop)

Date: 2026-07-12
Status: draft (pending independent review + approval)

Implements: `docs/superpowers/specs/2026-07-12-improv-mode.md` (the loop §3, the standing
briefing §4, the deterministic backstops §5, triggers/reversion §6, the two-architecture eval §8).
Bounded-reverses: `docs/decisions.md` "2026-07-10 — HTTP not MCP" (improv runs on the game's MCP
endpoint; plan-then-execute keeps HTTP).

Read the spec first. This document is the *how* and the batch sequencing. It assumes the reader
knows the existing plan-then-execute harness (`src/agent/agent.ts`, `src/client/`, `src/planner/`).

---

## 1. What we are building, in one paragraph

Today an agent runs **plan-then-execute**: the LLM writes a short runbook occasionally, and
deterministic code walks it tick by tick for free. Improv mode swaps the *piloting* half for a
model that decides one action per tick, while keeping the deterministic *safety net* running
around it. The model plays through the game's **MCP interface** (the same endpoint the two
community harnesses use) instead of our HTTP `/api/v2`. The point is an experiment: run the same
agent, in the same world, under both architectures and measure the delta in cost per hour and
progress per hour. Improv is expected to be smarter and much more expensive; the harness bounds
that expense with hard budgets and reverts automatically when a budget, a stuck-detector, or a
schedule window trips.

## 2. The central architecture decision — read this before the batches

There are two honest ways to build "model-in-the-loop via MCP," and they are not equal. Naming
them up front prevents a batch from quietly assuming the wrong one.

**MCP** (Model Context Protocol) is a standard way to expose a set of *tools* to a language model.
The game speaks it: a model connected to `game.spacemolt.com/mcp` sees game actions as callable
tools and can invoke them directly inside its own reasoning turn.

- **Design A — harness-mediated single action (RECOMMENDED, and what the spec describes).** Each
  tick the harness gathers state, hands the model a briefing plus that state, and asks it to return
  **one** chosen action as structured JSON. Our code validates that choice against the action
  registry and executes it over an MCP transport we own. The model reasons; the harness still holds
  every safety switch and executes and verifies every call. This is spec §3 step 5 verbatim
  ("Harness executes via the SAME transport ... verifies effect ... meters improv tokens") and §5
  ("the model gets the wheel, not the safety switches ... the model cannot disable them").

- **Design B — native tool-use loop (DEFERRED).** Point the `claude` CLI at the game MCP server and
  let the model call game tools directly, many calls per turn, with no harness in between. This is
  "genuine autonomy" in the strongest sense, but it surrenders exactly the guarantees §5 makes
  mandatory: we can no longer verify each action's effect, enforce one-action-per-tick, meter or cap
  spend per action, or param-validate against our registry. The only bound left would be killing the
  CLI process on a wall-clock timeout. That is a different, higher-risk experiment.

We build **Design A**. Design B is recorded as the considered-and-deferred alternative in the
decision log; if the operator later wants to measure the fully-autonomous ceiling, it gets its own
spec and its own eval, because its risk profile and its metering are different. Under Design A the
"model-in-the-loop via MCP" claim is still true and the experiment is still real: the model makes
every decision over live game state, and every decision is executed against the actual MCP endpoint.
What Design A withholds from the model is not the wheel, it is the ability to fire an unbounded
burst of un-verified calls. (The one backstop that stays briefing-only even under A is the identity
and prompt-injection boundary, because the model reads raw game text to reason; §7 says exactly how.)

## 3. MCP interface findings from the community references (authoritative)

Cloned read-only and studied: `geleynse/gantry`
(`server/src/proxy/http-game-client-v2.ts`, `game-transport.ts`) and `sacenox/Zoea-Nova`
(`internal/mcp/client.go`, `proxy.go`, `types.go`). These are how two independent harnesses actually
talk to the game over MCP. Extracted facts, with the caveat that they describe *those* clients'
accounts and must be confirmed for *ours* (see §5 unknowns):

**Endpoint and handshake (gantry, the closest match to our stack).** The game MCP URL is
`${base}/mcp/v2?preset=${preset}` where `preset` is `standard` (9 tools) or `full` (16 tools). The
handshake is three steps:

1. `POST ${base}/api/v1/session` (a plain REST call, no MCP) returns `{ session: { id, expires_at } }`.
   This id is the **game session id**.
2. MCP `initialize` (JSON-RPC) on the v2 URL returns an `Mcp-Session-Id` **response header** — the
   **transport session id**, distinct from the game session id.
3. MCP `notifications/initialized` (JSON-RPC notification, no id, no response body needed).

Then authenticate: `tools/call name="spacemolt_auth" arguments={ action:"login", username, password }`.
Critically, **do not** send `session_id` on login — the server rejects it with "Unknown
parameter(s): session_id". The login response is a greeting whose text contains a line
`Session ID: <hex>`; the client parses that hex out and treats **it** as the canonical game session
id from then on (falling back to the transport `Mcp-Session-Id` if the line is absent).

**Tool-call shape.** Every game action is `tools/call` with `params: { name: <tool>, arguments: {
action: <action>, ...params, session_id } }`. The tool names are our exact registry namespaces:
`spacemolt`, `spacemolt_auth`, `spacemolt_social`, `spacemolt_market`, `spacemolt_storage`,
`spacemolt_salvage`, `spacemolt_battle`, `spacemolt_catalog`, and so on. The action lives in
`arguments.action` (e.g. `spacemolt` + `action:"get_status"`, `spacemolt` + `action:"travel"`,
`id:"commerce_fields"`). This maps **one-to-one** onto our registry's existing `{tool}/{action}`
model — `ActionDef.tool` is the MCP tool name, `ActionDef.name` is the `action` argument. The
briefing's movement/sell verb assumptions therefore hold unchanged; only the transport differs.

**Session threading.** `session_id` is auto-injected into `arguments` for **every** tool call except
`spacemolt_catalog` (which the v2 schema does not require it on). This is the big divergence from our
HTTP client, which carries the session in the `X-Session-Id` **header**. Over MCP the game session is
an **argument on every call**, and the `Mcp-Session-Id` header is a separate transport-level id.

**Response shape.** A tool result is JSON-RPC `result.content[0].text` — a **string**. For some
actions that string is JSON to parse; for others (gantry notes `get_status`) it is a human-readable
**text dashboard**, which gantry parses with a dedicated `game-text-parser.ts`. Results may also be
wrapped in the game's standard envelope `{ result, notifications?, session?, error? }`, which gantry
defensively unwraps only when the object's keys are all envelope keys. **This differs from our HTTP
`structuredContent`** — our `StatusSchema` / `SystemInfoSchema` parse a structured object that the MCP
path does not return. Batch 0 RESOLVED this (§5, §5a): every read call returned a **text dashboard**
with no `structuredContent`, so our Zod schemas do NOT apply and a text parser is required.

**Transport can be SSE.** Both clients set `Accept: application/json, text/event-stream` and handle a
`text/event-stream` response by reading the last `data:` line as the JSON-RPC payload. The transport
must be SSE-aware, not assume plain JSON.

**Error and session taxonomy.**
- Session expiry surfaces as JSON-RPC error `-32001` "Session expired (server may have restarted)",
  or tool-level codes `session_expired` / `unauthorized` / `invalid_session` / `not_logged_in`, or
  a `-32600` invalid-request (Zoea recovers on this). The fix is one clean re-login (re-run the
  handshake, re-parse the greeting session id), then retry the call once with the new id. Gantry
  guards this with a single-flight lock (concurrent callers share one renewal) and a sliding-window
  circuit breaker (too many renewals in a window means the server is down — stop hammering).
- Rate limiting is HTTP `429` with a `Retry-After` header, or a tool result whose text carries
  "Try again in N seconds", or a structured `{ code:"rate_limited"/"cooldown", retry_after,
  wait_seconds }`. Honor the server-specified delay (capped for safety). Because all of a fleet's
  agents share one outbound IP, gantry also enforces a **process-wide** session-create spacing gate:
  a rate-limited `/api/v1/session` re-extends a per-IP block, so every instance must park until it
  clears rather than drip-retrying.
- `action_pending` / an "action already in progress" game_error is the one-mutation-per-tick lock;
  retry after `wait_seconds`. `combat_interrupt` returns immediately (the model must handle combat).

**Account model.** Both harnesses assume **one live session per account** and serialize logins.
Zoea runs an account pool (a mysis claims an account, logs in, the login response is reshaped to look
like a register response). We run three fixed accounts, so we do not need a pool. This section reflects
the two references' *pre-probe* assumption; note that **Batch 0 overturned it for our account** — the
HTTP session survived an MCP login, so HTTP-pilot and MCP-improv are concurrent-capable rather than
strictly one-at-a-time (§5 unknown #3, RESOLVED; the §6 serial handover is dropped in favor of a
concurrent seam). Read the §5 resolution before relying on the one-session framing here.

## 4. The seam — three new pieces, parallel to what exists

The design keeps the existing plan-then-execute path byte-for-byte and adds a parallel lane the
config selects per agent. Three new pieces:

**(a) `SpacemoltMcp` transport** (`src/client/mcp.ts`), sibling of `SpacemoltHttp`. Same
responsibilities — session, tool call, session recovery, rate-limit retry — over MCP Streamable HTTP
instead of REST. Reuses `SpacemoltHttp`'s patterns where they map: the retry-loop structure, the
`onReauth` hook, the `MAX_RATE_RETRIES` shape, the `SpacemoltError` type. New because the wire format
differs: JSON-RPC `tools/call`, SSE-aware response parse, `session_id`-as-argument injection, greeting
parse for the game session id, envelope unwrap, the `-32001` recovery code.

**(b) `McpGameApi` adapter** (`src/client/mcp-game-api.ts`), an implementation of the existing
`GameApi` interface (`action` / `status` / `notifications` / `getSystem` / `getSkills` /
`getAchievements`) backed by `SpacemoltMcp`. This is what lets every existing deterministic backstop
keep working unchanged: they consume `StatusSnapshot`, and the adapter produces `StatusSnapshot` from
MCP responses. It also exposes the **raw** text of a state query, because the improv model turn feeds
the model raw game text (spec §4). Batch 0 discharged the reuse-vs-parse question: `status()` /
`getSystem()` need a **text-dashboard parser** (no Zod reuse — §5, §5a), and the raw text they expose
to the model is that same dashboard string.

**(c) Driver-mode seam** in the `Agent`. A per-agent `mode: "plan-then-execute" | "improv"`. In
`runOnce()`, improv mode dispatches to a new `ImprovController` (`src/agent/improv.ts`) instead of the
wake/replan/execute path. The controller reuses the Agent's existing backstop state (budget window
counters, stuck fingerprint, transit handling, effect-verification helpers) rather than duplicating
them — the whole thesis is that the safety net is shared and only the pilot changes.

## 5. Load-bearing unknowns — ALL RESOLVED by the Batch 0 probe (2026-07-12)

We had **never** used the game's MCP endpoint with our own account. The community facts in §3 were a
strong reference, but designing our transport against another account's observed shapes would be
"designing against guessed MCP shapes," which the simplicity rules forbid. Batch 0 was a narrow,
authorized live probe that captured our own shapes into fixtures; every later batch builds and tests
against those fixtures with zero live traffic.

**Status: the Batch 0 probe ran and all three unknowns are RESOLVED.** The scrubbed, verified capture
is `test/fixtures/mcp-probe-2026-07-12.json`. The resolutions below supersede the pre-probe guesses;
where a resolution overturned the plan's own assumption (unknown #3), the batches downstream are
revised to match measured reality, not the guess. The one thing the probe could NOT settle — the
error/recovery taxonomy — stays flagged `assumed` in Batch A, because a read-only probe cannot provoke
a session-expiry or a rate-limit.

The three unknowns, each with the exact question, why it was load-bearing, and the measured finding:

1. **Our player's MCP session/auth handshake.** *(Question)* Does our account's game host expose
   `POST /api/v1/session` and an MCP endpoint at `/mcp/v2?preset=...`? Is the login greeting still the
   text form carrying `Session ID: <hex>`, and is the game session threaded as an **argument** on
   every call (gantry) or as a header, for *our* account? Load-bearing because the entire transport
   (Batch A) is shaped by the answer, and it diverges from the HTTP client we know works.
   **RESOLVED — handshake confirmed; argument-injection is the CHOSEN path (verified-it-works, not
   request-shape-captured).** The handshake works as §3 describes: a REST session bootstrap, then MCP
   `initialize` (which does return an `Mcp-Session-Id` response header — `mcpSessionIdHeader_present:
   true`), then `notifications/initialized`, then a `spacemolt_auth` login whose greeting text carries
   `Session ID: <hex>` (`login.game_session_id_source: "greeting"`). Two things the fixture **proves**:
   the **game session id source is the greeting text** (parsed out of the login response), and a
   **separate transport header exists** (`Mcp-Session-Id`, present at `initialize`). What the fixture
   does **not** prove is the request-argument shape: the capture holds only tool-call **responses** —
   there is no `tools/call` **request** payload anywhere in it (no `params`/`arguments`/request
   `session_id`). And because MCP Streamable HTTP sends the `Mcp-Session-Id` header on *every* call
   regardless, a successful response alone cannot isolate the argument as the authenticator versus the
   header. So the mechanism rests on the probe client's own behavior (it threaded the greeting-parsed
   game session id as a per-call `session_id` **argument**, gantry-style, and every call **succeeded**)
   plus the gantry reference — not on captured request data. Decision for Batch A: **build the
   argument-injection path** (it is the gantry model, and the probe's calls succeeded with it); treat
   the request-argument shape as verified-it-works, and if a doubt ever surfaces, capture one real
   `tools/call` request to confirm the argument is what the server keys on. The Zoea-style
   header-only-threading alternative is not what our probe used. `preset=standard` was used and accepted.

2. **Exact tool names and response shapes over MCP.** *(Question)* Confirm the `spacemolt*` tool names
   and that `action` is the argument key; capture the raw result for `get_status`, `get_system`,
   `get_location`, `get_notifications`, `get_skills`, `get_achievements`, and one mutation — is it JSON
   or a text dashboard, and is it enveloped? This decides whether `McpGameApi.status()`/`getSystem()`
   reuse our Zod schemas or need a text parser like gantry's. Load-bearing for Batch A/B.
   **RESOLVED (fixture `read_only_calls` + `mutation`): TEXT DASHBOARDS, not JSON — `McpGameApi` needs
   a text parser and CANNOT reuse our Zod schemas.** Every read call captured
   (`get_status`/`get_system`/`get_skills`/`get_achievements`/`get_notifications`/`get_location`/
   `view_market`) returned `result.content[0].text` as a human-readable **text dashboard**
   (`shape: "text-dashboard"` on each), none enveloped in this capture (`wasEnveloped: false`), and
   crucially **no `structuredContent`** — the rich JSON object our HTTP client Zod-parses is present on
   the HTTP path (`concurrency_http_before_mcp.body.structuredContent`) but ABSENT on the MCP path.
   The `mine` mutation likewise returned a text line (`"Error: no_resources: Nothing to mine here"`,
   `isError: true`). Implication for Batch A: write a **TEXT PARSER** (reference gantry's
   `game-text-parser.ts` / `parseGetStatusText`) that maps the dashboard into `StatusSnapshot`; the
   `get_status` and `get_system` formats are characterized below.

3. **Can one game account run HTTP-pilot and MCP-improv concurrently?** *(Question)* Both community
   clients assume one session per account. When an agent flips to improv, does establishing an MCP game
   session **invalidate** its live HTTP `X-Session-Id` session? The plan ASSUMED yes (likely), forcing
   a **serial session handover**. Load-bearing for Batch B and Batch E's reversion mechanics.
   **RESOLVED (fixture `concurrency_finding`): OPPOSITE to the plan's assumption — the sessions
   COEXIST.** The probe held an HTTP session, performed the full MCP login, then re-hit the same HTTP
   session: it still returned `200` (`http_session_invalidated_by_mcp_login: false`,
   `before_status: 200`, `after_status: 200`, `after_error: null`). The MCP login did NOT invalidate the
   concurrent HTTP session. Implication for Batch B/E: the session model can be **concurrent-capable** —
   the HTTP pilot and the MCP improv session may run on one account at once — so the serial
   teardown/standup handover the plan specified is likely unnecessary (see revised Batch B/E).
   **Caveat to carry forward:** survival was confirmed *immediately post-login*; longer-run coexistence
   and mutation interference between the two sessions were NOT exercised. Treat "fully concurrent
   operation" as **verified-at-login**, to be confirmed in the first real improv window before we lean
   on dual-session operation under sustained load.

Secondary confirmations folded into the same probe: the `initialize` `instructions` block confirms
queries (`get_status`, `get_system`, `help`) are unlimited and mutations are 1-per-tick; the game
auto-undocks for a mine — an `auto_undock` notification ("Automatically undocked (required for mine)")
appears in the HTTP status poll taken right after the mine
(`concurrency_http_after_mcp.notifications`), not in the MCP `mine` result itself (which returned only
the `no_resources` text error). `in_transit`-during-jump and the "resubmit this command" terminal
wording were NOT exercised (the ship was docked, not mid-jump) and remain as the spec §9 opportunistic
confirmations; the chat channel enum was already verified over HTTP.

### 5a. The text-dashboard format Batch A's parser must handle (from the fixture)

This is the shape the Batch A text parser turns into a `StatusSnapshot` (and `getSystem`'s output).
It is not JSON — it is a line-oriented, mixed-delimiter human dashboard. The parser must be written to
these regularities, not to field position.

**`get_status` → `StatusSnapshot`.** The dashboard is a sequence of labeled sections:

- **Header line** (pipe-delimited): `<username> [<empire>] | <credits>cr | <system_name>` — e.g.
  `Miner [nebula] | 2,750cr | Market Prime`. Credits carry **thousands separators** (`2,750`), so the
  parser must strip commas before `parseInt`.
- **Ship line** (pipe-delimited): `Ship: <name> (<class_id>) | Hull: 95/95 | Shield: 50/50 (+1/tick) |
  Armor: 4 | Speed: 1`. Hull/shield are `cur/max`; shield carries a `(+N/tick)` recharge suffix to
  strip.
- **Capacities line**: `Fuel: 87/130 | Cargo: 30/100 | CPU: 4/13 | Power: 10/26` — four `used/max`
  pairs.
- **`Docked at: <poi_id>`** when docked (this is the current-POI signal; when undocked/in-transit this
  line is expected to differ — NOT captured here, the ship was docked).
- **`Security: <text>`**, then **`Connections: <id>, <id>, <id>`** (comma-separated system ids).
- **Tabular sections**, each introduced by a `<Label> (<count>):` line, then a **TAB-separated header
  row**, then TAB-separated data rows: `Nearby players (7):` (`name ship faction combat status`),
  `Nearby empire NPCs (1):`, `Modules (2):` (`id type slot size wear stats`), `Cargo (3 items):`
  (`item qty size` — note `item` is the display NAME e.g. "Palladium Ore", not the `palladium_ore`
  id), `Skills (6):` (`skill level xp next_level`), `Empire standings:` (`empire rep baseline bounty`).
  Empty cells appear as **consecutive tabs** (a blank `faction`/`combat` column), so split on `\t`
  keeping empties — do not collapse whitespace.
- **Overflow line**: after the players table, a parenthetical like
  `(+26 offline players not listed; POI is busy.)`.
- **`Active missions (1/5):`** then bulleted `- <title> (<type>)` lines.

Parser gotchas the fixture proves matter: (1) **row order is not stable** — the same account's
`get_status` over HTTP (`concurrency_http_before_mcp`) and over MCP lists nearby players and skills in
**different orders**, so key every row by its fields, never by index across calls; (2) the `Modules`
`stats` cell is a space-separated `key:value` bag (`reach:3 cooldown:1 damage:10 damage_type:0
range:10`) and renders `damage_type` as a **numeric code** (`0`) where the HTTP `structuredContent`
gave the string `"energy"` — the text parser loses that enum mapping, so any code path needing the
damage-type name cannot rely on the MCP text; (3) counts in section headers (`(7)`, `(3 items)`) are
authoritative for how many rows follow.

**`get_system` → connections/pois.** `System: <name> (<system_id>) | Empire: <e> | Security: <text>`,
then `POIs (5):` (TAB header `id name type class base online`, where `online` is a player count), then
`Connections (3):` (TAB header `system_id name distance`, distance formatted `326 GU` — strip the
` GU` unit suffix). `view_market` follows the same tabular pattern (a category-grouped TAB table plus
a trailing `current_tick=...` line to use as the `since` diff cursor).

Batch 0 authorization is explicit and narrow: read-only game queries plus at most one reversible
mutation, on ONE account, with the HTTP pilot for that account stopped first (one session per
account). No LLM calls. Captured fixtures are scrubbed of the session token before they land in
`test/fixtures/`.

## 6. The batches

Ordering respects the convention "no load-bearing unknowns hidden inside a batch": Batch 0 discharges
all three unknowns up front; every later batch has none. Each batch lists its offline tests (fake MCP
server + mocked model, zero live traffic, zero tokens) and states its unknowns explicitly.

### Batch 0 — Live MCP probe (AUTHORIZED live calls; no code shipped except fixtures) — DONE (2026-07-12)

- **Status: COMPLETE.** All three §5 unknowns resolved; capture at `test/fixtures/mcp-probe-2026-07-12.json`
  (scrubbed, verified). Findings: (1) session threading is **argument-injection** (gantry-style);
  (2) read responses are **text dashboards** (a text parser is required, no Zod reuse — §5a); (3) the
  HTTP session **survived** the MCP login, so the model is **concurrent-capable, not serial-handover**
  (verified-at-login; see §5 caveat). The three findings and their build implications are the resolved
  §5 above and the revised Batch A/B/E below.
- **Goal.** Answer the three §5 unknowns with our own account. Produce captured fixtures.
- **Work.** A throwaway probe script (gitignored, deleted after — diagnostic-script hygiene) that:
  runs the handshake (`/api/v1/session` → MCP `initialize` → `initialized` → `spacemolt_auth` login),
  records whether the greeting carries `Session ID:` and where the session id must go; calls each
  read query and one reversible mutation and saves the raw JSON-RPC results; and tests whether an MCP
  login invalidates a concurrently-held HTTP session for the same account.
- **Output.** `test/fixtures/mcp-probe-2026-07-12.json` (scrubbed), plus a short findings note
  appended to the decision log and this plan's §5 marked resolved.
- **Offline tests.** None (this batch *is* the ground-truth capture). The fixtures it produces are the
  test inputs for every later batch.
- **Load-bearing unknowns.** This batch exists to discharge them. Nothing downstream proceeds until it
  lands.

### Batch A — `SpacemoltMcp` transport

- **Goal.** A working MCP transport against the Batch 0 fixtures: handshake, login + greeting parse,
  `tools/call` with `session_id` argument injection, SSE-aware response parse, envelope unwrap,
  session recovery on `-32001`/session-expired (single-flight + renewal circuit breaker), rate-limit
  retry (Retry-After / "Try again in N" / structured), `action_pending` retry, one-session-per-account.
- **Session threading is DECIDED: argument-injection (Batch 0, unknown #1 resolved).** The two
  references disagreed — gantry injects the game session as a per-call **argument**, Zoea threads it as
  an `Mcp-Session-Id` **header** — and Batch 0 settled it for our account: **argument-injection**. Build
  the per-call `session_id`-argument path (canonical id parsed from the login greeting text). **Drop the
  header-vs-argument branch entirely**; the `Mcp-Session-Id` header is a transport id we read at
  `initialize` but do NOT use as the game session. No code explores the header-threading alternative.
- **Response parsing is a TEXT PARSER, not Zod reuse (Batch 0, unknown #2 resolved).** MCP read results
  are text dashboards with no `structuredContent` (§5, §5a). The transport returns the raw
  `result.content[0].text` string (SSE-aware, envelope-unwrapped when the object is all-envelope keys);
  the mapping into `StatusSnapshot`/system info is a dedicated text parser in the `McpGameApi` adapter
  (Batch B), modeled on gantry's `game-text-parser.ts`. Our HTTP Zod schemas do NOT apply to the MCP
  path — do not wire them in. Batch A owns the string extraction + envelope unwrap; Batch B owns the
  parse into typed snapshots.
- **`load-bearing: assumed` — the error/recovery taxonomy (UNCHANGED by Batch 0).** One honest caveat:
  the narrow read-only Batch 0 probe that ran did NOT (could not) provoke a session-expiry or a
  rate-limit — the only error it captured was a benign `no_resources` on `mine`. So the `-32001`
  recovery path and the `429`/Retry-After/`rate_limited` handling are still built from the two community
  references
  (gantry + Zoea, independent and agreeing), NOT ablated against our own account's captured fixtures.
  Per the fix-quality convention these are tagged **assumed** (verified against two independent
  references, not verified against us), and they stay low-risk — a wrong assumption here degrades a
  recovery path, it does not corrupt the happy path. Re-verify them **opportunistically** the first
  time a real improv window actually hits a session-expiry or a rate-limit (capture the real shape
  then and drop the "assumed" tag). The rest of the transport (handshake, login, tool-call shape,
  response parse) is fixture-verified from Batch 0 and carries no such tag.
- **Files.** `src/client/mcp.ts` (+ `src/client/mcp-errors.ts` if the taxonomy warrants it; reuse
  `SpacemoltError`).
- **Offline tests** (each catches a distinct real failure): SSE `data:`-line parse returns the right
  payload; envelope unwrap is a no-op on a bare payload and unwraps a wrapped one; a `-32001` result
  triggers exactly one re-login then one retry with the new session id; concurrent expiries share one
  renewal (single-flight); N renewals in the window trip the breaker and stop retrying; a rate-limited
  result waits the server-specified delay; `session_id` is injected on `spacemolt` but not on
  `spacemolt_catalog`; login omits `session_id` and parses the greeting hex.
- **Load-bearing unknowns.** None — all discharged by Batch 0.

### Batch B — `McpGameApi` adapter + driver-mode seam

- **Goal.** (1) A `GameApi` over `SpacemoltMcp` (with the §5a text parser) so existing backstops work
  unchanged. (2) The per-agent mode selector and a **concurrent-capable** session model.
- **Session model is concurrent-capable, not serial-handover (Batch 0, unknown #3 resolved).** The
  probe showed the HTTP session SURVIVES an MCP login on the same account, so the plan's serial
  teardown/standup handover is NOT required for correctness. Build the seam so the Agent can **hold an
  HTTP `GameApi` and an MCP `GameApi` at the same time** and select per mode, without tearing the HTTP
  pilot's session down to stand up the MCP session. This simplifies Batch B (no ordered
  teardown-before-standup dance) and Batch E (revert is a pointer flip, not a session rebuild). **The
  at-login caveat governs how far we lean on this:** dual-session survival is verified only immediately
  post-login, so ship the concurrent seam but keep the first improv window supervised and confirm
  sustained coexistence (no cross-session interference on a mutation) before running HTTP-pilot and
  MCP-improv fully concurrently and unattended. If sustained coexistence ever fails in the field, the
  fallback is a stop-the-HTTP-pilot-first gate around the improv window — a small, localized guard, not
  the pervasive handover machinery the plan originally specified.
- **Files.** `src/client/mcp-game-api.ts` (text parser → `StatusSnapshot`); `src/agent/agent.ts` (mode
  dispatch, no behavior change in plan-then-execute mode); `src/config/config.ts` (an `improv` block on
  the agent entry: `enabled`, `model`, `token_budget`, `wall_clock_minutes`, `schedule`, `preset`);
  `src/main.ts` (build the MCP transport/adapter when improv is configured); a `client-factory` seam so
  the Agent can hold both an HTTP and an MCP `GameApi` concurrently and switch which one drives.
- **Offline tests.** `status()` maps a captured MCP `get_status` **text dashboard** (§5a) to the correct
  `StatusSnapshot` fields; `getSystem()` maps connections/pois/currentPoi from the text; a malformed
  row drops rather than throwing (same tolerance as the HTTP client); a row order different from a prior
  capture still parses correctly (fields keyed by name, not index — the fixture proves order varies);
  config parses/validates the improv block and rejects an out-of-range budget; mode defaults to
  `plan-then-execute` when the block is absent; the mode selector flips the driving `GameApi` **without**
  tearing down the other session (concurrent-capable seam, per Batch 0's concurrency answer).
- **Load-bearing unknowns.** None — the response-shape and concurrency questions were Batch 0.

### Batch C — The improv loop + the standing briefing

- **Goal.** `ImprovController.runTick()` implementing spec §3, and the standing briefing (spec §4) as
  a single source of truth wired into the model turn.
- **The loop.** Query state (over MCP) → harness pre-checks (transit auto-wait skips the model call;
  budget/stuck/heartbeat trip → revert) → build the model turn (cached briefing + current state +
  recent action history + any operator instruction) → model returns ONE action as JSON (a new
  `ImprovActionSchema`: one registry action + params, or `{ wait: true }`) → harness validates against
  the registry and executes over MCP → verify effect where cheap → log an `improv_action` event and
  meter the turn's tokens as its own line → sleep to the tick.
- **The model turn.** Reuses the `claude -p --output-format json` runner (`src/planner/runner.ts`) and
  the char-based cost capture, exactly like `ClaudeSubscriptionPlanner`, but with a single-action
  prompt and schema instead of a Plan. The model does **not** hold MCP tools (Design A); it emits a
  choice our code executes. New module `src/planner/improv-chooser.ts` (or reuse the runner directly
  from the controller).
- **The briefing.** `src/agent/improv-briefing.ts` — the §4 catalog embedded verbatim, including the
  non-negotiable social/security block and the backstops added this session (undock guard,
  jettison/auto_list market lessons, progress heartbeat). This is the SSOT the AGENTS.md convention
  ("deterministic lessons feed improv mode") points at; a new deterministic guard adds its paired line
  here.
- **Offline tests.** A mocked chooser returning a single action drives one clean tick (execute +
  event + meter); an in-transit pre-check skips the model call entirely (token save asserted); a
  chooser returning `{wait}` resolves to no mutation; a chooser emitting an action not in the registry
  is rejected (injection allowlist, see §7) and logged, not executed; the briefing module contains
  each load-bearing lesson (assert the verbatim social/security lines, the undock guard, the jettison
  lesson, the transit-wait rule) so the briefing can never silently drift behind the code.
- **Load-bearing unknowns.** None — transport from A, adapter/seam from B.

### Batch D — The deterministic backstops around the model

- **Goal.** Wire every spec §5 backstop into the improv path and state exactly how each is enforced
  when the model drives. This is the safety net; it is substantial enough to isolate from the loop so
  its tests are unambiguous.
- **The enforcement map** (also §7 below): hard token+wall-clock budget with auto-revert; stuck-watcher
  re-keyed on **game-state-only** fingerprint (improv has no plan cursor); heartbeat liveness floor;
  effect-verification on sell/buy/mine; transit auto-wait; transport recovery (from A, always-on below
  the model); persisted-state tolerance; prompt-injection + identity boundary (briefing + registry
  allowlist).
- **Effect-verification scope — sell reuses, buy/mine is NEW code.** `executor.ts` today has only
  `verifySellEffect` (sell's before/after cargo check). Sell reuses it; **buy and mine
  effect-verification are new code this batch writes** (a before/after check on cargo/credits for
  buy, on cargo for mine), factored so the sell path and the two new paths share one before/after
  helper rather than three copies. Do not describe buy/mine as pure reuse — the helper exists for sell
  only.
- **Files.** `src/agent/improv.ts` (budget window, revert trigger, stuck fingerprint variant, heartbeat
  floor); reuse `src/agent/no-progress-detector.ts` and `executor.ts` verification helpers;
  `src/planner/errors.ts` (subscription-limit classifier reused for budget/limit → revert).
- **Offline tests.** Wall-clock budget exhaustion emits `improv_reverted` and resumes
  plan-then-execute; token (char-estimate) budget exhaustion does the same; the game-state-only
  fingerprint arms `stuck` after N identical improv ticks and reverts; the heartbeat floor forces a
  re-evaluate/revert after a window with no resolved action; an effect-verified phantom sell is caught
  and fed back into the next turn rather than silently repeating; a subscription-limit envelope from
  the chooser reverts (does not thrash); an action outside the registry allowlist never reaches the
  transport.
- **Load-bearing unknowns.** None.

### Batch E — Triggers, reversion, and the two-architecture eval

- **Goal.** The three triggers (scheduled daily window per agent; leftover-subscription-budget near a
  5-hour window's end; manual dashboard toggle), automatic logged reversion, and the metering that
  makes the experiment readable.
- **Reversion.** Window end, budget exhaustion, stuck-flag, or operator toggle all revert
  automatically and log an `improv_reverted` event with the reason; the agent resumes
  plan-then-execute from **live** state and replans on its next natural wake (no stale plan — clear any
  improv-era plan cursor). **The mode switch is a pointer flip, not a session handover (Batch 0,
  unknown #3).** Because the HTTP session coexists with the MCP session, reverting just re-points the
  Agent at its still-live HTTP `GameApi` — no ordered teardown/rebuild of sessions, which is the serial
  handover this bullet previously specified. (At-login caveat from Batch B applies: until sustained
  coexistence is field-confirmed, keep the improv window supervised; the fallback if coexistence ever
  fails is a stop-HTTP-first gate around the window, not a return to pervasive handover.)
- **Metering / eval.** Improv actions/tokens/cost are their own dashboard line in `src/server/usage.ts`
  (a distinct `improv_action` / `improv_turn` accounting alongside the existing `wake`/`plan` lines).
  The comparison artifact is cost/hr and progress/hr on the same agent/world across a
  plan-then-execute window vs an improv window — progress/hr reads the existing multi-dimensional
  progress scalar (the no-progress detector's grand total + the progress heartbeat), not credits
  alone. Ties into the Sonnet-vs-Haiku A/B: judge cost-normalized multi-dimensional progress.
- **Progress telemetry is harness-computed and unfakeable by the model (anti-tamper invariant).** The
  progress heartbeat (spec §5) is report-only AND must stay deterministic: it is computed by harness
  code directly from the queried game `status` (credits/cargo/skills/achievements counters), never by
  the model and never from anything the model emits. The self-driving model cannot suppress it (it is
  a harness timer/reader, not a model action) and cannot fabricate its own progress numbers (the model
  never writes to the telemetry — its only outputs are a single chosen action and its reasoning, and
  neither feeds the heartbeat). This matters because the eval that judges improv "worth it" reads this
  scalar; if the model could touch it, the model could grade its own homework. It cannot.
- **Files.** `src/agent/improv.ts` (schedule + leftover-budget trigger, revert plumbing);
  `src/server/usage.ts` (improv line + delta); `src/server/server.ts` + dashboard (manual toggle —
  depends on Plan 3 UI); `src/config/config.ts` (schedule window fields).
- **Offline tests.** The scheduled window opens/closes improv at the configured times (injected clock);
  the leftover-budget trigger opens improv only when estimated remaining budget exceeds a floor near a
  window boundary; the manual toggle flips mode; reversion on each of the four causes emits the event
  and clears the improv cursor; `summarizeUsage` reports the improv line separately and computes the
  cost/hr and progress/hr delta between two windows.
- **Load-bearing unknowns.** None in the harness. The manual **dashboard toggle** UI depends on Plan 3
  being live (it is), and the two-architecture delta needs enough flight data to size budgets — a
  sequencing dependency, not an unknown (§8).

## 7. How each §5 backstop is enforced when the MODEL is driving

This is the crux of Design A: the model chooses, but it never touches a safety switch. Concretely:

- **Token + wall-clock budget → auto-revert.** The improv window carries a hard wall-clock limit and a
  token budget. Tokens are **estimated from characters** (chars/4, exactly as `usage.ts` already does),
  because the Claude subscription CLI returns no token counts — the wall-clock limit is the true hard
  stop, the token estimate is the soft ceiling. On exhaustion the controller reverts to
  plan-then-execute and logs it. The existing subscription-limit classifier (`planner/errors.ts`) is
  reused: a limit envelope from the chooser reverts rather than retries.
- **Stuck / no-progress watcher, game-state-only.** Plan-then-execute fingerprints game state **plus**
  the plan cursor. Improv has no cursor, so the improv fingerprint is game state alone
  (fuel/credits/hull/system/docked/inTransit/dockedAt/cargoUsed). N consecutive improv ticks with an
  identical fingerprint alert the operator and revert. Enforced by the harness on the state it fetched,
  not by the model.
- **Heartbeat liveness floor.** If a full window passes with no resolved action, the harness forces a
  re-evaluate and reverts. The model cannot suppress this — it is a timer on the controller.
- **Effect-verification.** After the model's chosen sell/buy/mine executes, the harness re-queries and
  confirms cargo/credits actually moved. Sell reuses `executor.ts`'s existing `verifySellEffect`;
  buy and mine get new before/after checks written in Batch D (the helper today covers sell only). A
  phantom "success" is caught by our code and fed back into the next model turn, not trusted.
- **Transit auto-wait.** The pre-check reads `in_transit`; if the ship is mid-travel the harness skips
  the model call entirely (a token save) and sleeps to the tick. The model never gets to "replan"
  during transit because it is never asked.
- **Undock / jettison / market lessons.** These are *piloting* lessons, so under improv they live in
  the briefing (§4) as guidance to the model, not as deterministic guards — with two exceptions kept
  deterministic as monitoring: the undock no-op (the harness can decline to fire an undock when
  `docked_at` is null) and the effect-verify above. The briefing carries the auto_list-falsified and
  jettison lessons verbatim so the model does not loop on no-demand cargo.
- **Transport recovery.** Session recovery, rate-limit retry, one-session-per-account — always on,
  below the controller, in `SpacemoltMcp` (Batch A). The model is unaware of it.
- **Persisted-state tolerance.** Any improv-era stored artifact that no longer validates under an
  evolved schema is discarded gracefully, never crashes the agent (the existing `src/store/store.ts`
  pattern, extended to any improv cursor/state).
- **Prompt-injection + identity boundary — the one briefing-only control.** The model reads raw game
  text (chat, names, error messages) to reason, so the harness cannot pre-sanitize its *reasoning*.
  Two things bound it anyway: the **registry allowlist** is a hard backstop on *actions* — the model
  can only trigger our curated verbs with validated params, so a "transfer all credits to player X"
  injected in chat cannot execute because no such action exists and chat params are enum-validated;
  and the **verbatim §4 briefing** is the only control over what the model *says* and *discloses*. The
  spec is explicit that this seam gives the model raw text, which is exactly why the identity/injection
  lines are non-negotiable and embedded verbatim.

## 8. Sequencing and dependencies

Lands after Plan 3 (needs the toggle UI and usage meters — both live) and after enough flight data to
size the budgets, per the decision-log entry. The internal order is strict: **Batch 0 first** (it
discharges all unknowns and produces the fixtures every other batch tests against); then A → B → C → D
→ E, since each depends on the prior (transport → adapter/seam → loop+briefing → backstops →
triggers/eval). Batch E's manual toggle rides on the existing dashboard; its budget-sizing wants real
flight numbers, so ship E's mechanics with conservative defaults and tune them from the first improv
windows (annotated as experiments in `agents.yaml` per the standing policy).

Design B (native tool-use) is out of scope and recorded as deferred in §2 and the decision log.

## 9. Go-forward conventions this plan is bound by

- Every new deterministic guard added later also gets its paired line in the §4 briefing (AGENTS.md
  "deterministic lessons feed improv mode"); the briefing module (Batch C) is where it lands.
- Any schema tightening on improv-persisted state is tested against a stored artifact that predates it,
  and the loader discards rather than crashes (AGENTS.md persisted-state tolerance).
- Tests stay offline: fake MCP server + mocked chooser, zero live-game traffic, zero tokens, except
  the explicitly-authorized Batch 0 probe. `bun test && bun run typecheck` gates every batch.
- No live MCP or LLM calls in any batch except Batch 0, and Batch 0 only under its narrow written
  authorization (one account, HTTP pilot stopped first, token scrubbed from fixtures).
