import { z } from "zod";

export interface ActionDef {
  tool: string; // API tool group: "spacemolt" | "spacemolt_auth"
  name: string; // action name == API path segment
  kind: "mutation" | "query";
  params: z.ZodTypeAny;
  eventLabel: string; // human label for dashboard event feed
}

const none = z.object({}).strict();

// The five VERIFIED chat channels (spacemolt_social/chat `target`). SSOT for
// the set the registry enum below and the planner digest (digest.ts) both draw
// on. VERIFIED 2026-07-12: our pilot sent `chat target:"broadcast"` and the
// game rejected it with "Invalid chat channel", naming exactly this set --
// local (area chat), system (system-wide), faction (your faction), private
// (one player, needs target_id), emergency (distress/help).
export const CHAT_CHANNELS = ["local", "system", "faction", "private", "emergency"] as const;

// The catalog route (issue #219) is the one game endpoint with NO action
// segment -- the OpenAPI path is bare `/api/v2/spacemolt_catalog`. Its registry
// name is therefore "", and this constant is how call sites say that on
// purpose: `api.action(CATALOG_ACTION, { type: "items", id })` reads as an
// intent, `api.action("")` reads as a bug. See the REGISTRY entry below and
// SpacemoltHttp.call (src/client/http.ts), which drops the trailing slash.
export const CATALOG_ACTION = "";

// The single source of truth for every game action agents may use.
// Hand-curated subset of the full API; conformance-tested against the
// OpenAPI spec (see test/registry-conformance.test.ts, Task 3).
export const REGISTRY: ActionDef[] = [
  // --- mutations (one per ~10s tick) ---
  { tool: "spacemolt", name: "travel", kind: "mutation", eventLabel: "Travel to POI",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "jump", kind: "mutation", eventLabel: "Jump to system",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "dock", kind: "mutation", eventLabel: "Dock", params: none },
  { tool: "spacemolt", name: "undock", kind: "mutation", eventLabel: "Undock", params: none },
  { tool: "spacemolt", name: "mine", kind: "mutation", eventLabel: "Mine", params: none },
  { tool: "spacemolt", name: "sell", kind: "mutation", eventLabel: "Sell items",
    // sell takes id + quantity. The API also carries an optional `auto_list`
    // param, deliberately NOT registered (#123): it was added on the theory that
    // auto_list=true clears a no-demand hold by listing the unsold quantity on
    // the player exchange, then FALSIFIED live 2026-07-12 -- the pilot sold
    // palladium_ore with auto_list:true and got the identical "Sold 0 ... N
    // unsold (no buyers)". jettison / create_sell_order (below) are the real
    // escapes for cargo no NPC buys, and the digest briefs those, never
    // auto_list. Don't re-add it without a live capture showing it does anything.
    params: z.object({
      id: z.string(),
      quantity: z.number().int().min(1),
    }).strict() },
  { tool: "spacemolt", name: "buy", kind: "mutation", eventLabel: "Buy items",
    params: z.object({ id: z.string(), quantity: z.number().int().min(1) }).strict() },
  // --- missions (base-earning pivot #1, issue #124): the primary income path ---
  // Missions pay far more than dumping ore on an exchange, and the pilot could
  // not touch them because no mission actions were ever registered
  // (missions_completed sat at 0 forever). Request shapes VERIFIED against
  // test/fixtures/openapi-slim.json (2026-07-12 capture): accept_mission
  // properties [id, template_id] required [], complete_mission / abandon_mission
  // properties [id] required [id]. accept_mission takes EITHER an offered
  // mission's id OR a template_id (accept a fresh instance of a template); both
  // optional to match the API's empty required set exactly (conformance test).
  // NOTE: only the REQUEST shapes are registered here. The get_missions /
  // get_active_missions RESPONSE shapes are uncaptured (the slim OpenAPI fixture
  // is request-only), so nothing downstream parses them yet -- the planner reads
  // the raw query result text. Parse-and-surface (a deterministic "here are the
  // missions you can fulfill" digest section) is a deferred follow-up once we
  // capture the response shapes from the live pilot; no guessed field names.
  { tool: "spacemolt", name: "accept_mission", kind: "mutation", eventLabel: "Accept mission",
    params: z.object({ id: z.string().optional(), template_id: z.string().optional() }).strict() },
  { tool: "spacemolt", name: "complete_mission", kind: "mutation", eventLabel: "Complete mission",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "abandon_mission", kind: "mutation", eventLabel: "Abandon mission",
    params: z.object({ id: z.string() }).strict() },
  // jettison: dump cargo into space -- the disposal escape for WORTHLESS
  // items no NPC buys and auto_list won't clear (auto_list falsified live
  // 2026-07-12: the pilot sold palladium_ore with auto_list:true and the game
  // still returned "Sold 0 ... unsold (no buyers)"). VERIFIED against
  // test/fixtures/openapi-slim.json: /spacemolt/jettison properties
  // [id, items, quantity], required []. We send the two we use (id + quantity);
  // both are real properties, so conformance passes. The fixture's required set
  // is empty, so marking them required on our side is allowed -- the conformance
  // test only checks that every API-REQUIRED field is non-optional in ours, and
  // there are none. CATALOG-GATED (issue #94, operator mandate 2026-07-13):
  // the executor refuses a jettison whose catalog base_value clears
  // JETTISON_VALUE_FLOOR (src/agent/executor.ts) -- "no NPC buyer" never means
  // "worthless"; valuable cargo is held or listed via create_sell_order below.
  { tool: "spacemolt", name: "jettison", kind: "mutation", eventLabel: "Jettison cargo",
    params: z.object({ id: z.string(), quantity: z.number().int().min(1) }).strict() },
  // create_sell_order (issue #94): the value-preserving escape for cargo no
  // NPC buys -- list it on the player exchange instead of destroying it.
  // VERIFIED against test/fixtures/openapi-slim.json:
  // /spacemolt_market/create_sell_order properties [item_id, orders,
  // price_each, quantity], required []. We register the single-listing shape
  // (item_id + quantity + price_each) and skip `orders` (a batch shape we have
  // no captured example of -- no guessed field layouts). The API requires
  // nothing, so requiring item_id/quantity on our side is allowed (conformance
  // checks API-required only). price_each is OPTIONAL on our side because the
  // executor fills it deterministically from the catalog base_value when
  // omitted (src/agent/executor.ts) -- the planner never has to invent a
  // price; an explicit price_each passes through untouched.
  { tool: "spacemolt_market", name: "create_sell_order", kind: "mutation",
    eventLabel: "List sell order on player exchange",
    params: z.object({
      item_id: z.string(),
      quantity: z.number().int().min(1),
      price_each: z.number().positive().optional(),
    }).strict() },
  // create_buy_order (issue #316): the game's own remedy for `item_not_available`
  // -- "0 available" on a purchase estimate means no seller currently exists, and
  // the error text names create_buy_order as the fix (post a standing bid, wait
  // for a fill). VERIFIED against test/fixtures/openapi-slim.json:
  // /spacemolt_market/create_buy_order properties [deliver_to, item_id, orders,
  // price_each, quantity], required []. We register the single-order shape
  // (item_id + quantity + price_each), same subset choice as create_sell_order
  // above -- `orders` (bulk) and `deliver_to` (cargo vs storage routing) are
  // skipped for now, no captured example of either. Mirrors create_sell_order's
  // price_each default: OPTIONAL on our side, filled deterministically from the
  // catalog base_value by the executor when omitted (src/agent/executor.ts) so
  // the planner never has to invent a price. markets.md:31 confirms credits are
  // escrowed immediately from the wallet on posting, same escrow model as sell.
  { tool: "spacemolt_market", name: "create_buy_order", kind: "mutation",
    eventLabel: "List buy order on player exchange",
    params: z.object({
      item_id: z.string(),
      quantity: z.number().int().min(1),
      price_each: z.number().positive().optional(),
    }).strict() },
  // cancel_order (capability audit, Workflow A 2026-07-19): the escape hatch
  // for a create_sell_order/create_buy_order that never fills. Before this,
  // credits or cargo posted to the exchange stayed stuck in escrow with no
  // way back -- the audit's #1 finding was 71 no-buyer sell failures per 72h,
  // several of them a pilot re-listing over an already-dead order instead of
  // reclaiming and relisting it. VERIFIED against the vendored OpenAPI
  // (docs/game-reference/upstream/openapi-v2.json:99291-99704,
  // operationId spacemolt_market_cancel_order): properties [order_id,
  // order_ids], required [] (also cross-checked against
  // test/fixtures/openapi-slim.json:1456-1462 and
  // docs/game-reference/commands.md:337). x-is-mutation:true (line 99698) ->
  // kind:"mutation". order_id is a single order id, or "all"/"*" to cancel
  // every order at the current station; order_ids is the documented bulk
  // alternative (up to 50 ids, "when provided the top-level order_id is
  // ignored"). Both stay optional here, matching the API's empty required set
  // exactly (no captured evidence either field is load-bearing on its own).
  // Per the spec's own description: a sell order's remaining items return to
  // station storage, a buy order's remaining credits return to the wallet;
  // partial fills keep what already filled. No executor guard needed -- unlike
  // jettison/create_sell_order there is no destructive or price-defaulting
  // side effect to intercept; the generic mutation dispatch (executor.ts)
  // sends it straight through.
  { tool: "spacemolt_market", name: "cancel_order", kind: "mutation",
    eventLabel: "Cancel market order",
    params: z.object({
      order_id: z.string().optional(),
      order_ids: z.array(z.string()).max(50).optional(),
    }).strict() },
  // refuel target param (issue #233): registered name-only with params:none
  // blocked ship-to-ship rescue (`refuel target=<player>` transfers fuel,
  // mission-runner.md's distress-rescue economy) and fleet fuel-status reads
  // (target:"fleet"). VERIFIED against the vendored OpenAPI
  // (docs/game-reference/upstream/openapi-v2.json:44481-44510, operationId
  // spacemolt_refuel): schema properties [id, quantity, target], NO required
  // array (all three optional), matching commands.md:95's
  // `refuel(id?, quantity?, target?)`. id = specific fuel-cell item id
  // (auto-selects cheapest if omitted); quantity = cells to burn or units to
  // transfer (default 1, station refueling ignores it); target = player
  // id/username for a ship-to-ship transfer, or "fleet" for fleet fuel
  // status. No x-is-mutation flag override needed -- refuel was already
  // kind:"mutation" and stays so. quantity's positive-integer floor is our
  // own domain bound, not a vendor requirement (the schema itself only
  // declares type:integer) -- same convention as withdraw's z.min(1) above.
  { tool: "spacemolt", name: "refuel", kind: "mutation", eventLabel: "Refuel",
    params: z.object({
      id: z.string().optional(),
      quantity: z.number().int().positive().optional(),
      target: z.string().optional(),
    }).strict() },
  { tool: "spacemolt", name: "repair", kind: "mutation", eventLabel: "Repair hull", params: none },
  // storage.withdraw (capability audit, Workflow A 2026-07-19): the missing
  // half of the buy->install chain. A module bought via deliver_to:"storage"
  // or produced by crafting (upstream/docs/storage.md: "Crafting runs on
  // storage ... Jobs escrow inputs from station storage and deliver outputs
  // there") lands in STATION STORAGE, not cargo -- and install_mod reads
  // cargo only, so the pilot hit module_not_found with the module sitting one
  // withdraw away. VERIFIED against the vendored OpenAPI
  // (docs/game-reference/upstream/openapi-v2.json:117742,
  // /api/v2/spacemolt_storage/withdraw, x-is-mutation:true at line ~117791):
  // properties [bucket, dest_bucket, item_id, items, quantity, source,
  // target], required []. commands.md:436 lists it unregistered. We register
  // only item_id + quantity (both required on our side, matching the one
  // real use case -- withdraw a specific item into cargo), the same "only
  // what we call it with" subset choice as create_sell_order/create_buy_order
  // above. target/source/bucket/dest_bucket are real API properties with no
  // consumer here (default target:"self" source:"storage" is exactly
  // personal-storage-to-cargo, storage.md:33) and are skipped -- unused
  // params are dead data. Deposits/withdrawals always require docking
  // (storage.md:46); the executor's docked guard mirrors install_mod's.
  { tool: "spacemolt_storage", name: "withdraw", kind: "mutation", eventLabel: "Withdraw from storage",
    params: z.object({
      item_id: z.string(),
      quantity: z.number().int().min(1),
    }).strict() },
  // storage.deposit (issue #221, crafting & refining loop): withdraw's mirror
  // and the hard precondition every craft/recycle call has -- craft's own spec
  // text says it plainly: "Materials are escrowed from your station storage at
  // enqueue (NOT cargo) ... deposit your inputs to storage first." VERIFIED
  // against the vendored OpenAPI (docs/game-reference/upstream/openapi-v2.json:
  // 116199, /api/v2/spacemolt_storage/deposit, x-is-mutation:true):
  // properties [bucket, credits, dest_bucket, item_id, items, message,
  // quantity, source, target], required [] -- also cross-checked against
  // test/fixtures/openapi-slim.json and commands.md:432. Same subset choice as
  // withdraw: item_id + quantity required on our side (the one real use case --
  // deposit a specific item from cargo into personal storage before crafting),
  // matching default source:"cargo" target:"self" (storage.md). credits/
  // bucket/dest_bucket/message/items/target/source are real faction-gifting/
  // bulk properties with no consumer here and are skipped as dead data, same
  // reasoning as withdraw's comment above. Deposits always require docking
  // (storage.md:46); mirrors withdraw's docked guard.
  { tool: "spacemolt_storage", name: "deposit", kind: "mutation", eventLabel: "Deposit to storage",
    params: z.object({
      item_id: z.string(),
      quantity: z.number().int().min(1),
    }).strict() },
  // craft / recycle (issue #221): the crafting & refining loop's two job-queue
  // mutations. VERIFIED against the vendored OpenAPI (docs/game-reference/
  // upstream/openapi-v2.json:33612 /api/v2/spacemolt/craft, x-is-mutation:true
  // at line 34087; and :44015 /api/v2/spacemolt/recycle, x-is-mutation:true at
  // line 44475): both have required [] (every property is optional on the
  // API's own side) -- cross-checked against test/fixtures/openapi-slim.json
  // and commands.md:56/94. `id` is the recipe id (craft's own description:
  // "Recipe ID to craft (use catalog with type=recipes to see available
  // recipes)"); we require it here, stricter than the API, because a craft/
  // recycle call with no id only lists or cancels queued jobs (action=queue) --
  // the one real use case this registers is "queue a job for recipe X".
  // quantity/deliver_to/source/facility_id/dry_run stay optional, matching the
  // API exactly. job_id/job_ids/jobs/preset/count are the bulk-cancel/
  // bulk-queue/positional-alias properties with no consumer here and are
  // skipped as dead data (same "only what we call it with" subset choice as
  // withdraw/deposit above).
  //
  // HARNESS-LEVEL FOLLOW-UP (out of scope this wave, flagged per issue #221):
  // craft/recycle do not resolve within the issuing tick or a few
  // transient-block ticks like the rest of the registry -- a job runs over many
  // ticks and completes via an async `crafting_update` notification the harness
  // must correlate back to the job that started it (job_id), with a
  // do-not-reissue guard against double-spending materials by re-queuing a job
  // that's already running. That correlation/digest/planner wiring is NOT built
  // here; this entry only registers the request shape so the planner vocabulary
  // includes craft/recycle at all.
  { tool: "spacemolt", name: "craft", kind: "mutation", eventLabel: "Queue crafting job",
    params: z.object({
      id: z.string(),
      quantity: z.number().int().min(1).optional(),
      deliver_to: z.string().optional(),
      source: z.string().optional(),
      facility_id: z.string().optional(),
      dry_run: z.boolean().optional(),
    }).strict() },
  { tool: "spacemolt", name: "recycle", kind: "mutation", eventLabel: "Queue recycling job",
    params: z.object({
      id: z.string(),
      quantity: z.number().int().min(1).optional(),
      deliver_to: z.string().optional(),
      source: z.string().optional(),
      facility_id: z.string().optional(),
      dry_run: z.boolean().optional(),
    }).strict() },
  { tool: "spacemolt", name: "attack", kind: "mutation", eventLabel: "Attack target",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "scan", kind: "mutation", eventLabel: "Scan target",
    params: z.object({ id: z.string() }).strict() },
  // --- recovery actions (stall-watcher v4) ---
  // Registered so the planner (via a steward re-steer) and the deterministic
  // steward itself can self-rescue a stranded pilot through the normal
  // client.action path. Schemas VERIFIED against test/fixtures/openapi-slim.json
  // (2026-07-10 capture): distress_signal exposes an optional `distress_type`;
  // self_destruct takes no params; tow lives under spacemolt_salvage and REQUIRES
  // `id` (the wreck to tow). distress_type is a required enum on OUR side (the
  // game leaves it optional, but a broadcast with no type is useless) --
  // conformance only checks that every API-required field is required here, so a
  // stricter enum is allowed. Values fuel/repair/combat are the three distress
  // categories named in the spec (docs/superpowers/specs/2026-07-12-pilot-stall-watcher.md).
  { tool: "spacemolt", name: "distress_signal", kind: "mutation", eventLabel: "Broadcast distress signal",
    params: z.object({ distress_type: z.enum(["fuel", "repair", "combat"]) }).strict() },
  { tool: "spacemolt", name: "self_destruct", kind: "mutation", eventLabel: "Self-destruct (respawn home)",
    params: none },
  { tool: "spacemolt_salvage", name: "tow", kind: "mutation", eventLabel: "Tow a wreck",
    params: z.object({ id: z.string() }).strict() },
  // --- social (Task: social capabilities) ---
  { tool: "spacemolt_social", name: "chat", kind: "mutation", eventLabel: "Send chat message",
    // target is the CHANNEL, now a VERIFIED enum (CHAT_CHANNELS above) -- not
    // the old permissive z.string(), which was the actual bug: it let a guessed
    // "broadcast" through to the game, which silently dropped every message.
    // Two independent sources fix the set: the game's own rejection of an
    // off-channel send (2026-07-12 live probe -- target:"broadcast" -> "Invalid
    // chat channel", naming local/system/faction/private/emergency) and the
    // OpenAPI request schema (test/fixtures/openapi-slim.json: spacemolt_social
    // /chat requires [target, content], properties add target_id). content is
    // the message text (required). target_id is the optional recipient for a
    // directed send -- a player id for `private`, a faction for `faction`; the
    // area channels (local/system/emergency) need no target_id.
    params: z.object({
      target: z.enum(CHAT_CHANNELS),
      content: z.string().min(1),
      target_id: z.string().optional(),
    }).strict() },
  { tool: "spacemolt_social", name: "captains_log_add", kind: "mutation", eventLabel: "Captain's log entry",
    // The OpenAPI slim fixture (test/fixtures/openapi-slim.json) captures
    // only required/property names, not maxLength -- refresh-openapi.ts never
    // recorded string length constraints, so the API's real cap is ASSUMED
    // unknown, not VERIFIED absent. 2000 is a defensive local cap: long
    // enough for a real in-character log entry, short enough to bound
    // planner-output cost through the PlanSchema boundary this registry
    // feeds (receipt: simplicity rule 3, new threshold justified here rather
    // than left unbounded).
    params: z.object({ content: z.string().min(1).max(2000) }).strict() },
  // --- queries (unlimited, instant) ---
  { tool: "spacemolt", name: "get_status", kind: "query", eventLabel: "Status check", params: none },
  { tool: "spacemolt", name: "get_system", kind: "query", eventLabel: "System scan", params: none },
  // Progress dimensions for the multi-dimensional no-progress detector
  // (stall-watcher v4): per-skill xp (get_skills) and achievements.summary.earned
  // (get_achievements). Both token-free queries, sampled on the snapshot throttle
  // cadence (see src/agent/agent.ts). Shapes VERIFIED against the live probe
  // fixture test/fixtures/spacemolt-probe-2026-07-12.json.
  { tool: "spacemolt", name: "get_skills", kind: "query", eventLabel: "Skills check", params: none },
  { tool: "spacemolt", name: "get_achievements", kind: "query", eventLabel: "Achievements check", params: none },
  { tool: "spacemolt", name: "get_poi", kind: "query", eventLabel: "POI details", params: none },
  // Remote-POI targeting fix (issue #176): the id source for `scan`. scan is a
  // 100%-broken capability (16/16 lifetime attempts blocked, every recent one
  // `invalid_target: Target '<poi_id>' not found at your current location`) --
  // the planner scanned POI ids because POI ids were the ONLY ids the digest
  // ever showed it, and the game's own error names get_nearby as the source of
  // valid targets (entities AT your location: ships, wrecks, objects). Request
  // shape VERIFIED against test/fixtures/openapi-slim.json (/spacemolt/get_nearby:
  // properties [] required []). kind:"query" so the planner can never plan it
  // (PlanSchema admits only mutations) -- the harness fetches it every replan
  // and the digest hands the planner the ids, the same producer-side pattern as
  // get_missions (#147). RESPONSE shape uncaptured: nothing downstream parses
  // it, the raw text goes into the digest quoted+truncated (no guessed fields).
  { tool: "spacemolt", name: "get_nearby", kind: "query", eventLabel: "Nearby entities", params: none },
  // Capability-audit follow-up (2026-07-19, Workflow A): request VERIFIED
  // against openapi-v2.json /api/v2/spacemolt/get_location (commands.md:69,
  // no params). NOTE on the audit's original framing: the audit named this a
  // fix for "dock fails, no station here" -- checked and that framing does not
  // hold. get_status already returns the SAME v2 state envelope (its own
  // description: "all game state sections ... location"), and the
  // station-dockability signal (has_base per POI) already reaches the digest
  // via get_system (digest.ts:657's [station] marker, a prior fix). The
  // get_location response's `location` object (openapi example) carries no
  // has_base field at all, so it cannot itself decide dockability. Registered
  // anyway as a genuine, additive capability gap: it is the only registered
  // action that returns nearby_player_count / nearby_pirate_count /
  // nearby_empire_npc_count as parsed NUMBERS -- get_nearby above is
  // registered but its response shape is uncaptured (raw text only, see its
  // comment), and get_status's parsed location schema keeps only
  // docked_at/in_transit/system_id (client.ts LocationSchema), not the
  // nearby-entity counts or the transit_* fields. Response shape is ASSUMED
  // from the OpenAPI example (no live get_location capture exists -- same
  // caveat as PoiInfoSchema in client.ts), so parsing is defensive/optional
  // throughout; a shape miss degrades to undefined, never a crash.
  { tool: "spacemolt", name: "get_location", kind: "query", eventLabel: "Location check", params: none },
  // Mission queries (base-earning #124): list what's available and what's
  // already accepted. Both no-param -- VERIFIED against openapi-slim.json:
  // get_missions and get_active_missions both have properties [] required [].
  // Response shapes uncaptured (see the mission mutations block above) -- the
  // planner reads the raw result text for now; parse/surface is deferred.
  { tool: "spacemolt", name: "get_missions", kind: "query", eventLabel: "List missions", params: none },
  { tool: "spacemolt", name: "get_active_missions", kind: "query", eventLabel: "List active missions", params: none },
  { tool: "spacemolt", name: "find_route", kind: "query", eventLabel: "Route planning",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "get_notifications", kind: "query", eventLabel: "Check notifications",
    params: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      types: z.array(z.string()).optional(),
      clear: z.boolean().optional(),
    }).strict() },
  // Market visibility (sell/dock preconditions batch): a docked pilot's read of
  // what THIS station's market will actually buy/sell. The live miss it serves:
  // the pilot sold into a market with no buyer for the held item -- a station
  // buys only certain items, so "sellable at any station" is false. Compact
  // market summary by default (best prices, quantities per item); add item_id
  // for order-book depth on one item. Must be docked. Response includes
  // current_tick. All params optional -- a bare call returns the summary.
  // NOTE: only the REQUEST shape is registered here. The RESPONSE shape was
  // captured ONCE, over MCP, by the Batch 0 probe (test/fixtures/mcp-probe-
  // 2026-07-12.json, spacemolt_market/view_market) and is parsed against that
  // one real shape in mcp-text-parser.ts (parseMarketText); the digest keys
  // the sell precondition to the parsed rows (issue #93 -- see client.ts
  // getMarket and Agent.gatherMarket). No guessed field names anywhere
  // downstream -- but this action's HTTP response was never captured, so the
  // MCP-layout-matches-HTTP claim is load-bearing: ASSUMED (untested
  // divergence class: same text dashboard, renamed columns). parseMarketText
  // guards it: a header missing the consumed columns parses to [], which
  // gatherMarket surfaces as market_error.
  { tool: "spacemolt_market", name: "view_market", kind: "query", eventLabel: "View market",
    params: z.object({
      category: z.string().optional(),
      company_store: z.string().optional(),
      item_id: z.string().optional(),
      since: z.number().int().optional(),
    }).strict() },
  // storage.view (issue #221): read personal storage before/after a
  // deposit-craft-withdraw cycle -- the check that confirms materials landed
  // in station storage (not cargo) and that crafted outputs arrived. VERIFIED
  // against the vendored OpenAPI (docs/game-reference/upstream/openapi-v2.json:
  // 117583, /api/v2/spacemolt_storage/view -- no x-is-mutation flag, a free
  // query per commands.md:435 "Q"): properties [station_id, target], required
  // [] -- cross-checked against test/fixtures/openapi-slim.json. Both stay
  // optional here too, matching the API exactly (a bare call defaults to
  // target:"self", your own storage at your current station). kind:"query" so
  // the planner can never plan it directly (PlanSchema admits only mutations);
  // harness-side fetch/digest wiring for this query is OUT OF SCOPE this wave
  // per the dispatch brief, same deferred-wiring note as craft/recycle above.
  { tool: "spacemolt_storage", name: "view", kind: "query", eventLabel: "View storage",
    params: z.object({
      station_id: z.string().optional(),
      target: z.string().optional(),
    }).strict() },
  // Market intelligence (base-earning #124; view_orders claim CORRECTED #269):
  // the "where does my ore actually sell" problem. view_market (above) only
  // reads THIS station and needs a dock. Of these two, only analyze_market
  // answers the cross-station question -- and the #269 reference re-check
  // overturned this block's original claim about view_orders:
  //   analyze_market -- properties [] required []. "Actionable insights at your
  //     current station, scaled by your Trading skill: higher skill reveals
  //     regional demand, price trends, arbitrage, and specific opportunities. It
  //     only references stations you have actually visited" (markets.md, Market
  //     Intelligence). This IS the buyer finder; the harness runs it and injects
  //     the answer (Agent.gatherAnalyzeMarket -> digest Market intelligence).
  //   view_orders -- properties [item_id, order_type, page, page_size, scope,
  //     search, sort_by, station_id], required []. It is NOT a cross-station
  //     buyer finder: "View your own orders at a station ... your active buy and
  //     sell orders ... including fill progress" (openapi-v2.json; markets.md
  //     Managing Your Orders), scope personal|faction. item_id filters YOUR
  //     orders; it can never reveal a third party's bid. Registered as the
  //     capability (checking your own listings' fill progress), NOT as buyer
  //     discovery -- the old comment/briefing that used it that way was wrong.
  // Response shapes uncaptured (request-only fixture) -- reference wins until a
  // live capture contradicts it (evidence-precedence rule).
  // --- ship tool (issue #219): the shared bottom-rung unblock ---
  // The live miner sat on 17,306cr with zero lifetime module/hull purchases for
  // one reason: no registered action could browse a shipyard or fit a module.
  // Every shape below is VERIFIED against the vendored OpenAPI
  // (docs/game-reference/upstream/openapi-v2.json); `x-is-mutation` in that spec
  // is authoritative for kind, and it says browse_ships and get_ship are FREE
  // QUERIES while buy_listed_ship / install_mod / uninstall_mod cost a tick.
  //
  // The fitting workflow, per the game's own ships.md (upstream/docs/ships.md):
  //   1. buy the module at a station market -- it lands in your CARGO
  //   2. dock, then install_mod(id) -- needs CPU/power headroom and a free slot
  //   3. uninstall_mod(id) frees grid and returns the module to cargo
  // install_mod's id accepts a module TYPE id ("pulse_laser_ii") or an instance
  // id from get_ship (upstream/openapi-v1.json's uninstall_mod description says
  // so explicitly). The executor's fit guard (executor.ts) keys off the type id.
  //
  // /api/v2/spacemolt_ship/browse_ships: properties [base_id, class_id,
  // max_price], required []. A query, so the planner can never plan it
  // (PlanSchema admits only mutations) -- the harness fetches the listing every
  // docked replan and the digest hands the planner the listing_ids, the same
  // producer-side pattern as get_missions (#147) and get_nearby (#176).
  { tool: "spacemolt_ship", name: "browse_ships", kind: "query", eventLabel: "Browse shipyard listings",
    params: z.object({
      base_id: z.string().optional(),
      class_id: z.string().optional(),
      max_price: z.number().int().positive().optional(),
    }).strict() },
  // /api/v2/spacemolt_ship/buy_listed_ship: properties [id], required [id].
  // `id` is the LISTING id (spec: "ID of the listing to purchase (use
  // browse_ships to see listings)") -- not a ship class id. The digest says so.
  { tool: "spacemolt_ship", name: "buy_listed_ship", kind: "mutation", eventLabel: "Buy listed ship",
    params: z.object({ id: z.string() }).strict() },
  // Capability-audit fix (Workflow A, 2026-07-19): buy_listed_ship above puts a
  // second hull in the pilot's fleet, but nothing could ACTIVATE it -- a bought
  // hull sat inert, the direct answer to "the ship never changes." list_ships
  // and switch_ship close that gap.
  //
  // /api/v2/spacemolt_ship/list_ships (openapi-v2.json line 108008): "Shows all
  // owned ships with stats and where they are stored. Does not require docking."
  // properties {} required [] -- same empty-body shape as get_ship. commands.md
  // line 381: `list_ships()` Q "List all ships you own and their locations".
  // kind:"query" -- PlanSchema admits only mutations, so the planner cannot plan
  // this itself; same producer-side pattern as browse_ships above (Agent
  // gathers it once per docked replan and the digest hands the planner the
  // ship_ids switch_ship needs -- see gatherOwnedShips in agent.ts).
  { tool: "spacemolt_ship", name: "list_ships", kind: "query", eventLabel: "List owned ships", params: none },
  // /api/v2/spacemolt_ship/switch_ship (openapi-v2.json line 111020): "Swap your
  // active ship with one stored at this station... Requires shipyard service."
  // properties [id] required [id] -- id is "ID of the ship to switch to (must be
  // stored at current station, use list_ships to see your fleet)", a ship_id,
  // not a listing_id (buy_listed_ship's id is the LISTING; this one is the SHIP
  // already owned and stored here). commands.md line 389: `switch_ship(id)` M
  // "Switch to a different ship stored at this station".
  { tool: "spacemolt_ship", name: "switch_ship", kind: "mutation", eventLabel: "Switch active ship",
    params: z.object({ id: z.string() }).strict() },
  // /api/v2/spacemolt/install_mod and /uninstall_mod: properties [id], required
  // [id]. uninstall_mod is registered alongside install_mod deliberately, not as
  // scope creep: it is the ONLY remedy for the failure the fit guard blocks --
  // ships.md, "If it fails on CPU or power, something has to come out --
  // uninstall_mod frees grid and returns the module to cargo". A guard whose
  // blocked-reason names an unregistered action would be a dead end.
  // NO dry_run parameter exists on either (unlike craft) -- the compatibility
  // check is ours to make client-side, which is what the executor guard does.
  { tool: "spacemolt", name: "install_mod", kind: "mutation", eventLabel: "Install module",
    params: z.object({ id: z.string() }).strict() },
  { tool: "spacemolt", name: "uninstall_mod", kind: "mutation", eventLabel: "Uninstall module",
    params: z.object({ id: z.string() }).strict() },
  // /api/v2/spacemolt/get_ship: properties [], required []. Registered as the
  // capability (commands.md's ✅ column, and the id source ships.md names for a
  // module INSTANCE id when several of one type are fitted). Not called by the
  // harness on the hot path, and that is deliberate rather than an oversight:
  // get_status's response is the SAME V2GameState envelope and already carries
  // ship.cpu_capacity/cpu_used/power_capacity/power_used, the slot counts, and
  // the fitted `modules` array -- VERIFIED in a live capture
  // (test/fixtures/spacemolt-probe-2026-07-12.json). The digest's fit section
  // and the executor's fit guard read that snapshot, so the pilot pays zero
  // extra queries; a second fetch of the same fields would be a DRY violation,
  // not extra safety.
  { tool: "spacemolt", name: "get_ship", kind: "query", eventLabel: "Ship + fitting check", params: none },
  // get_cargo (capability audit, Workflow A 2026-07-19): the other half of the
  // buy->install chain fix (see storage.withdraw above) -- a dedicated ground
  // truth for cargo contents, deliberately NOT the same "just reuse
  // get_status" call the get_ship note above makes: StatusSnapshot.cargo rides
  // on get_status's structuredContent.cargo, which client.ts's CargoItemSchema
  // comment flags as "VERIFIED against the game OpenAPI spec ... though never
  // yet observed in a live capture" -- an assumption, not a confirmed fact, and
  // exactly the kind of gap the audit's live module_not_found finding points
  // at. get_cargo is the endpoint the game's own docs name for this
  // (upstream/docs/storage.md:7, "Check the hold anytime with get_cargo ...
  // it shows every item, quantities, and space used"). VERIFIED against the
  // vendored OpenAPI (openapi-v2.json:35994, /api/v2/spacemolt/get_cargo):
  // empty request body, no x-is-mutation flag -> query, matching
  // commands.md:64's unregistered row. Response is the same V2GameState
  // envelope get_status returns (client.ts's StatusSchema), so
  // GameApi.getCargo (client.ts) reuses that schema rather than duplicating
  // it (SSOT) -- see Agent.gatherCargo (agent.ts) for how the result reaches
  // the digest, preferring this live fetch over the get_status-derived field
  // when available.
  { tool: "spacemolt", name: "get_cargo", kind: "query", eventLabel: "Cargo check", params: none },
  { tool: "spacemolt_market", name: "analyze_market", kind: "query", eventLabel: "Analyze regional market", params: none },
  { tool: "spacemolt_market", name: "view_orders", kind: "query", eventLabel: "View market orders",
    params: z.object({
      item_id: z.string().optional(),
      order_type: z.string().optional(),
      page: z.number().int().optional(),
      page_size: z.number().int().optional(),
      scope: z.string().optional(),
      search: z.string().optional(),
      sort_by: z.string().optional(),
      station_id: z.string().optional(),
    }).strict() },
  // Purchase discovery (issue #220): the BUY-side twin of the market-finders
  // above. The live miss it serves: the pilot's milestone goal was to buy a
  // Deep Core Extractor and the only purchase-discovery action it knew was
  // view_market -- THIS station, docked only -- so its plan was to fly to a
  // station and CHECK. estimate_purchase answers "is it purchasable, how much,
  // from whom" for FREE, with no dock and no travel.
  // VERIFIED against the vendored OpenAPI, /api/v2/spacemolt_market/
  // estimate_purchase (docs/game-reference/upstream/openapi-v2.json):
  //   properties [item_id, quantity], required [item_id, quantity];
  //   quantity minimum 1; item_id accepts an item ID or a full name ("Iron Ore").
  //   NO `x-is-mutation` on the operation -- and that flag is the authority for
  //   kind (every mutation in the spec carries `x-is-mutation: true`; the market
  //   tool's create_buy_order/create_sell_order/modify_order/cancel_order do,
  //   estimate_purchase does not) -- so kind:"query", matching the description's
  //   own first word: "Read-only."
  // Response shape uncaptured (the pilot has never run it), so nothing parses it
  // downstream: the planner reads the raw result text, exactly as for
  // view_orders and analyze_market. Registered as the capability; the digest
  // does NOT name it as an action to plan, because kind:"query" means PlanSchema
  // (plan.ts) structurally cannot admit it -- a harness-side gather is the only
  // way to put its answer in front of the planner (issue #220 follow-up).
  { tool: "spacemolt_market", name: "estimate_purchase", kind: "query", eventLabel: "Estimate purchase",
    params: z.object({
      item_id: z.string().min(1),
      quantity: z.number().int().min(1),
    }).strict() },
  // query_trade_intel (capability audit, Workflow A 2026-07-19): the OTHER
  // half of the no-buyer remedy, alongside cancel_order above. It reads your
  // FACTION's own trade-intel database (prices other faction members already
  // recorded), not a live market call -- "find stations with real buyers
  // before routing cargo" per the audit. VERIFIED against the vendored
  // OpenAPI (docs/game-reference/upstream/openapi-v2.json:97637-97789,
  // operationId spacemolt_intel_query_trade_intel): properties [base_id,
  // item_id, limit, offset, source_faction_id, station_name], required []
  // (cross-checked against test/fixtures/openapi-slim.json:1413-1423 and
  // docs/game-reference/commands.md:323). NO `x-is-mutation` on the operation
  // (confirmed absent in the full block) -> kind:"query", matching the
  // spec's own summary: "Query your faction's intel database." limit/offset
  // carry the spec's own bounds (limit 1-50, default 20; offset >= 0).
  // item_id additionally requires an L2 Commerce Terminal per the
  // description -- that gate is server-side, not something we can validate
  // client-side, so it stays a plain optional string here.
  //
  // NOT wired into the planner briefing (digest.ts) as an action to plan:
  // it is a query, and PlanSchema (plan.ts) structurally cannot admit a
  // query step (the same rule that makes estimate_purchase and view_orders
  // above un-plannable). The codebase already paid for the alternative once
  // -- issue #269 found the digest instructing the planner to "plan
  // view_orders" for buyer discovery, a step PlanSchema rejects every time.
  // Making this action's answer visible to the planner needs a harness-side
  // gather (an Agent.gatherX call in src/agent/agent.ts, the same pattern as
  // gatherAnalyzeMarket/gatherEstimatePurchase) -- out of scope for this task
  // (registry/executor/digest/tests only; agent.ts is other in-flight work).
  // Registered here as the capability (commands.md's ⬜ -> ✅), conformance-
  // tested, ready for that follow-up gather; response shape uncaptured (never
  // run live), so nothing downstream parses it yet.
  { tool: "spacemolt_intel", name: "query_trade_intel", kind: "query",
    eventLabel: "Query faction trade intel",
    params: z.object({
      base_id: z.string().optional(),
      item_id: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().min(0).optional(),
      source_faction_id: z.string().optional(),
      station_name: z.string().optional(),
    }).strict() },
  // Intel & espionage, the rest of the group (issue #229; query_trade_intel
  // above landed separately and is NOT duplicated here). All 7 shapes VERIFIED
  // against the vendored OpenAPI (docs/game-reference/upstream/openapi-v2.json)
  // and cross-checked against test/fixtures/openapi-slim.json:1387-1451.
  //
  // espionage (openapi-v2.json:96888-97279): requestBody schema properties {}
  // (no fields at all) -> params none. x-is-mutation at line 97273, inside
  // this block and before the next path (help, 97279) -> mutation, matching
  // the description's own "Rate limited: This is a mutation command."
  { tool: "spacemolt_intel", name: "espionage", kind: "mutation", eventLabel: "Espionage", params: none },
  // intel_status (openapi-v2.json:97348-97451): requestBody schema properties
  // {} -> params none. No x-is-mutation anywhere in the block (the nearest
  // flag, 97273, belongs to espionage above; the next, 98224, to scan_poi
  // below) -> query, matching the description ("Shows systems known...").
  { tool: "spacemolt_intel", name: "intel_status", kind: "query", eventLabel: "Intel status", params: none },
  // query_intel (openapi-v2.json:97451-97637): properties [limit, offset,
  // poi_type, resource_type, source_faction_id, system_id, system_name],
  // required [] -- all optional here too. limit/offset carry the spec's own
  // bounds (limit 1-100, offset >= 0). No x-is-mutation in the block -> query.
  // NOT wired into the planner briefing (digest.ts): same PlanSchema rule as
  // query_trade_intel above -- a query step can never be admitted, so making
  // this visible to the planner needs a harness-side gather (out of scope).
  { tool: "spacemolt_intel", name: "query_intel", kind: "query", eventLabel: "Query faction intel",
    params: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      poi_type: z.string().optional(),
      resource_type: z.string().optional(),
      source_faction_id: z.string().optional(),
      system_id: z.string().optional(),
      system_name: z.string().optional(),
    }).strict() },
  // scan_poi (openapi-v2.json:97790-98227): properties [poi_id], required
  // [poi_id]. x-is-mutation at line 98224, inside this block and before the
  // next path (submit_intel, 98227) -> mutation, matching the description's
  // "Rate limited: This is a mutation command."
  { tool: "spacemolt_intel", name: "scan_poi", kind: "mutation", eventLabel: "Scan POI",
    params: z.object({ poi_id: z.string().min(1) }).strict() },
  // submit_intel (openapi-v2.json:98227-98666): properties [systems],
  // required [systems]; systems is `{type: "array", items: {type: "object"}}`
  // with no nested schema in the spec itself (the description prose lists the
  // expected shape -- system_id/name required per-entry, description/empire/
  // police_level/connections/pois optional -- but the OpenAPI schema does not
  // encode it, so this stays a loosely-typed record array rather than
  // inventing structure the spec doesn't assert). x-is-mutation at 98663,
  // inside this block and before submit_trade_intel (98666) -> mutation.
  { tool: "spacemolt_intel", name: "submit_intel", kind: "mutation", eventLabel: "Submit intel",
    params: z.object({
      systems: z.array(z.record(z.string(), z.unknown())).min(1),
    }).strict() },
  // submit_trade_intel (openapi-v2.json:98666-99082): properties [stations],
  // required [stations]; same loosely-typed array situation as submit_intel
  // -- the spec's items schema is bare `{type: "object"}`, the 20-station cap
  // is prose-only ("Max 20 stations per submission"), not a JSON Schema
  // maxItems, so it is enforced server-side, not client-side here.
  // x-is-mutation at 99079, inside this block and before trade_intel_status
  // (99082) -> mutation.
  { tool: "spacemolt_intel", name: "submit_trade_intel", kind: "mutation", eventLabel: "Submit trade intel",
    params: z.object({
      stations: z.array(z.record(z.string(), z.unknown())).min(1),
    }).strict() },
  // trade_intel_status (openapi-v2.json:99082-99185): requestBody schema
  // properties {} -> params none. No x-is-mutation in the block (the nearest
  // flag before it, 99079, belongs to submit_trade_intel; the next, 99698, is
  // spacemolt_market/cancel_order) -> query, matching the description ("Shows
  // stations known...").
  { tool: "spacemolt_intel", name: "trade_intel_status", kind: "query", eventLabel: "Trade intel status", params: none },
  //
  // NOT wired into the planner briefing for the 4 query actions above
  // (intel_status, query_intel, trade_intel_status already noted): same
  // PlanSchema rule as query_trade_intel -- registering them makes them
  // capabilities, not planner-visible steps, until a harness-side gather
  // exists (out of scope this task, issue #229 follow-up).
  // The catalog query (issue #219). Unlike every other entry, this route has NO
  // action segment: the spec's path is bare `/api/v2/spacemolt_catalog` (its
  // only sibling is `/help`), so the action NAME is the empty string and
  // SpacemoltHttp.call builds the bare-tool URL for it (see http.ts). The
  // registry stays the SSOT and commands.md's ✅ column keys on `tool/name`,
  // which renders as `spacemolt_catalog/` for exactly this row.
  //
  // Shape VERIFIED against the vendored OpenAPI (/api/v2/spacemolt_catalog):
  // required [type], properties [type, id, category, class, commissionable,
  // empire, page, page_size, search, tier]. `type` is a real enum in the spec.
  // It DOES require a session (security: SessionId) despite being a pure data
  // lookup. We register only the two params we call it with -- an id lookup is
  // how the executor resolves a module's cpu_usage/power_usage/slot before an
  // install_mod (the fit guard); the rest are real properties with no consumer,
  // and unused params are dead data (same convention as CurrentPoiInfo).
  { tool: "spacemolt_catalog", name: CATALOG_ACTION, kind: "query", eventLabel: "Catalog lookup",
    params: z.object({
      type: z.enum(["ships", "skills", "recipes", "items", "facilities"]),
      id: z.string().optional(),
    }).strict() },
  // --- Explorer's second rung (issue #222): deep-space content, wider
  // navigation, stealth. The first rung (jump/travel/get_system/find_route/
  // get_nearby/missions) was already registered; these four close the gap
  // the epic names -- get_map/search_systems for wider navigation than the
  // one-hop-at-a-time get_system walk, survey_system for the deep-core/
  // hidden-POI payoff (shared with the miner's own deep-core rung),
  // cloak for stealth. All four VERIFIED against the vendored OpenAPI
  // (docs/game-reference/upstream/openapi-v2.json) and cross-checked against
  // test/fixtures/openapi-slim.json.
  //
  // /api/v2/spacemolt/cloak (openapi-v2.json:32681-32706, operationId
  // spacemolt_cloak): properties [enable, quantity], required [] (also
  // openapi-slim.json:51-56). x-is-mutation:true within the block
  // (openapi-v2.json:32681-33083, before the next path at :33084) ->
  // kind:"mutation", matching the description's own "Rate limited: mutation
  // command" and commands.md:53's M marker. enable is the boolean toggle;
  // quantity is a "numeric shorthand for enable: 1 activates, 0
  // deactivates" (spec description) -- both optional, matching the API's
  // empty required set exactly.
  { tool: "spacemolt", name: "cloak", kind: "mutation", eventLabel: "Toggle cloak",
    params: z.object({
      enable: z.boolean().optional(),
      quantity: z.number().int().optional(),
    }).strict() },
  // /api/v2/spacemolt/get_map (openapi-v2.json:37237-37256, operationId
  // spacemolt_get_map): properties [system_id], required [] (also
  // openapi-slim.json:151-156). No x-is-mutation flag anywhere in the block
  // (openapi-v2.json:37237-37359, before the next path at :37360) ->
  // kind:"query", matching commands.md:70's Q marker. system_id is
  // "Optional system ID to get details for a single system. Omit to get
  // all systems." -- the actual galaxy map, vs. our existing one-hop-at-a-
  // time get_system walk (epic's own framing).
  { tool: "spacemolt", name: "get_map", kind: "query", eventLabel: "View galaxy map",
    params: z.object({ system_id: z.string().optional() }).strict() },
  // /api/v2/spacemolt/search_systems (openapi-v2.json:46203-46225,
  // operationId spacemolt_search_systems): properties [text], required
  // [text] (also openapi-slim.json:332-338). No x-is-mutation flag in the
  // block (openapi-v2.json:46203-46331, before the next path at :46332) ->
  // kind:"query", matching commands.md:99's Q marker. "Case-insensitive
  // partial match on system names. Returns up to 20 results."
  { tool: "spacemolt", name: "search_systems", kind: "query",
    eventLabel: "Search systems by name",
    params: z.object({ text: z.string().min(1) }).strict() },
  // /api/v2/spacemolt/survey_system (openapi-v2.json:47329-47342,
  // operationId spacemolt_survey_system): empty request schema, properties
  // [], required [] (also openapi-slim.json:361-364). x-is-mutation:true
  // within the block (openapi-v2.json:47329-47784, before the next path at
  // :47785) -> kind:"mutation", matching the description's own "Rate
  // limited: mutation command" and commands.md:103's M marker. "Requires a
  // survey scanner module or a ship with an integrated survey scanner.
  // Reveals hidden POIs based on survey power vs difficulty."
  { tool: "spacemolt", name: "survey_system", kind: "mutation",
    eventLabel: "Survey system", params: none },
];

const byName = new Map(REGISTRY.map((a) => [a.name, a]));

export function getAction(name: string): ActionDef {
  const def = byName.get(name);
  if (!def) throw new Error(`unknown action: ${name}`);
  return def;
}
