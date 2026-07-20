import { z } from "zod";
import { CATALOG_ACTION, getAction } from "../registry/actions";
import { SpacemoltError, SpacemoltHttp, type EnvelopeNotification, type V2Result } from "./http";
import { parseMarketText } from "./mcp-text-parser";

export interface StatusSnapshot {
  credits: number;
  fuel: number;
  maxFuel: number;
  hull: number;
  maxHull: number;
  cargoUsed: number;
  cargoCapacity: number;
  docked: boolean;
  inTransit: boolean;
  systemId?: string | null; // added for travel_to (Plan 2 Task 9); optional so
                            // existing StatusSnapshot literals elsewhere in
                            // the test suite don't need updating just to add
                            // a field they don't use.
  dockedAt?: string | null; // base id if docked, else null; added for F-1
                            // surroundings (see planner/types.ts) -- same
                            // "optional, additive" reasoning as systemId above.
  // stall-watcher v4: the monotonic lifetime counters from
  // get_status.player.stats -- the substrate for the multi-dimensional
  // no-progress detector (src/agent/no-progress-detector.ts). One map of every
  // numeric stat the game returns (non-numeric entries like
  // credits_earned_taxable_by_category are dropped in status() below); the
  // detector picks its allowlist from this. Optional/additive for the same
  // reason as the fields above: existing StatusSnapshot literals in the test
  // suite don't set it. undefined = the stats block was absent (dimension
  // UNKNOWN -> the detector fails safe and suppresses).
  stats?: Record<string, number>;
  // Mining-precondition fix (2026-07-12): get_status's structuredContent
  // carries a top-level `modules` array (fitted ship modules), a sibling of
  // ship/player/location. The executor's mine pre-check reads it to short-
  // circuit a mine when NO mining module is fitted (a guaranteed game error).
  // undefined = the modules block was absent or malformed (UNKNOWN -> the
  // guard fails safe and skips, letting classifyGameError catch any real
  // block at the call site); an array (possibly empty) = the known fitted set.
  // Optional/additive for the same reason as the fields above: existing
  // StatusSnapshot literals in the test suite don't set it.
  modules?: FittedModule[];
  // Ship tool (issue #219): the fitting grid. VERIFIED in a live capture
  // (test/fixtures/spacemolt-probe-2026-07-12.json, get_status.structuredContent
  // .ship = { cpu_capacity: 13, cpu_used: 2, power_capacity: 26, power_used: 5,
  // weapon_slots: 1, defense_slots: 1, utility_slots: 2, ... }) and in the
  // vendored OpenAPI's Ship schema. get_status and get_ship return the SAME
  // V2GameState envelope, so the fit is already in this tick's snapshot -- the
  // digest's fit section and the executor's install_mod guard read it here and
  // pay no extra query. undefined = the ship block didn't carry it (UNKNOWN ->
  // both consumers fail open), never 0.
  fit?: ShipFit;
  // Ship-details panel (operator request 2026-07-17): the hull's identity --
  // the player-assigned ship name and the class display name. VERIFIED live
  // (test/fixtures/spacemolt-probe-2026-07-12.json, get_status.structuredContent
  // .ship = { class_id: "prospect", class_name: "Prospect", name: "Prospect",
  // ... }) and in the vendored Ship schema (docs/game-reference/upstream/
  // api.md:1057 -- Ship carries class_id + name). class_id stays unparsed:
  // no consumer yet (the dashboard shows the display name). Optional/additive
  // like the fields above; undefined = the ship block didn't carry it, so a
  // stored status predating this field still loads and simply renders no
  // identity line.
  shipName?: string;
  shipClass?: string;
  cargo?: CargoItem[]; // SM-6 fix: cargoUsed/cargoCapacity were numbers only --
                            // no item names, so the digest could show "19/50"
                            // but never "19x gold_ore", the thing that actually
                            // tells a planner (especially a cheap-tier one)
                            // there's something sellable sitting in the hold.
                            // Optional for the same reason as systemId/dockedAt
                            // above: existing StatusSnapshot literals in the
                            // test suite don't need updating just to add a
                            // field they don't use; status() below always
                            // populates it (possibly empty).
}

// SM-6 fix: get_status's structuredContent carries a cargo array -- not
// independently verified against a live capture (unlike the get_system shapes
// above), so this schema and mapping are VERIFIED against the game OpenAPI spec (V2GameState.cargo: item_id/item_name/quantity/size, extracted 2026-07-10) though never yet observed in a live capture per the repo's existing
// convention for unverified shapes (see PoiInfoSchema below): parsed
// defensively, and any entry missing a required field is dropped rather than
// throwing the whole get_status parse. Subset only: `size` is a real field on
// the live response but has no consumer yet (mirrors CurrentPoiInfo's
// has_base/base_id/fuel_price note above), so it's left unparsed.
export interface CargoItem {
  itemId: string;
  name: string;
  quantity: number;
}

// Mining-precondition fix (2026-07-12): a fitted ship module, trimmed to the
// fields the mine pre-check and the (deferred) deposit-support math consume.
// VERIFIED shape from the live probe fixture
// (test/fixtures/spacemolt-probe-2026-07-12.json, get_status.modules[]):
// { module_id, type_id, name, type, slot, stats: { mining_power }, ... }. The
// executor's guard keys on `type === "mining"` OR `miningPower > 0` -- either
// alone identifies a mining laser, so a module carrying only one of the two
// still counts. cpu_usage/power_usage/wear are real fields with no consumer
// here, so they stay unparsed (no dead data, per CurrentPoiInfo's note).
export interface FittedModule {
  typeId: string;      // e.g. "mining_laser_i"
  type: string;        // module category, e.g. "mining"
  miningPower?: number; // stats.mining_power when present
  // Ship tool (issue #219): the slot this module occupies -- "weapon",
  // "defense" or "utility" (VERIFIED live: the miner's Mining Laser I reports
  // slot "utility", which is why the fit guard reads the game's own answer
  // rather than ships.md's prose table). Consumed by the executor's slot-
  // occupancy check and rendered in the digest's fit section. name is the
  // display name from the same entry, rendered beside the id.
  slot?: string;
  name?: string;
}

// Ship tool (issue #219): the hull's fitting grid -- the hard caps every
// install_mod is checked against. Fields map 1:1 to the live get_status
// ship block (see StatusSnapshot.fit). Slot COUNTS (capacity), not occupancy:
// occupancy is counted from the fitted modules' `slot` field.
export interface ShipFit {
  cpuUsed: number;
  cpuCapacity: number;
  powerUsed: number;
  powerCapacity: number;
  slots: { weapon: number; defense: number; utility: number };
}

// Ship tool (issue #219): the catalog's stats for ONE module type -- the fit
// requirements an install_mod is checked against before the tick is spent.
// Shape VERIFIED against the vendored OpenAPI's Module schema
// (docs/game-reference/upstream/openapi-v2.json, components.schemas.Module:
// required [id, type_id, type, slot, name, description, size, base_value,
// cpu_usage, power_usage]), returned by spacemolt_catalog(type:"items", id:X).
// Only the three fields the guard consumes are carried. required_skills is NOT,
// and the skill gate is not guarded: the spec gives that field a value shape
// (`additionalProperties: {type: integer}` -- a level) but not a KEY namespace,
// so whether its keys match get_skills' keys is uncaptured, and a gate built on
// a mismatched key blocks a legal install. A live capture of a skill-gated
// module's required_skills, compared against get_skills, would settle it.
//
// The catalog's cpu_usage/power_usage are ALSO not known to be pre- or
// post-Engineering-discount (upstream/docs/ships.md:26) -- see moduleGridFloor()
// in src/agent/executor.ts, which is built to be correct either way.
export interface ModuleSpec {
  cpuUsage: number;
  powerUsage: number;
  slot?: string;
}

// F-1 fix: map-awareness types for the surroundings the digest renders (see
// src/planner/types.ts). Subset only, per the finding: ids, names, types,
// resource fields, connections -- not the full get_system/get_poi payload.
export interface SystemInfo {
  id: string | null;
  name: string | null;
  connections: string[];
  // VERIFIED 2026-07-10: sourced from get_system's own system.pois list (see
  // SystemInfoSchema below) -- the system query already carries type/class
  // for every POI in the system, so gatherSurroundings() (src/agent/agent.ts)
  // no longer needs a second getPoi() round trip to build this.
  pois: PoiInfo[];
  // SM-4 fix: get_system's top-level `poi` (current location), parsed below.
  // Ground truth (2026-07-10 21:01 live flight): AT commerce_fields, blocked
  // by "deposits too sparse", the planner planned "Relocate to Commerce
  // Fields" -- it had no way to know it was already there. Undefined when
  // get_system doesn't return one (defensive, same as the rest of this type).
  currentPoi?: CurrentPoiInfo;
}

export interface PoiInfo {
  id: string;
  name: string;
  type: string;
  class?: string;
  resources?: string[];
  // station-awareness fix: get_system's system.pois entries each carry
  // has_base (VERIFIED in test/fixtures/spacemolt-probe-2026-07-12.json --
  // every POI in the list has it). Dropping it left the digest unable to say
  // which POIs are dockable, so the planner kept planning `dock` in systems
  // with no station and got blocked. Optional/additive like class/resources:
  // undefined when the game omits it, which the digest renders as "not a
  // station". fuel_reserve is on the same list entries but has no consumer, so
  // it stays unparsed (no dead data, per CurrentPoiInfo's note above).
  hasBase?: boolean;
}

// SM-4 fix: current-location POI (get_system's top-level `poi`, a sibling of
// `system` -- see the VERIFIED shape note above SystemInfoSchema). Trimmed to
// the fields the digest's "You are at" line consumes (planner/digest.ts);
// has_base/base_id/fuel_price are real fields on the live response but have
// no consumer yet, so they're left unparsed rather than carried as dead data.
export interface CurrentPoiInfo {
  id: string;
  name: string;
  type: string;
  // stall-watcher v4: the strand detector (src/agent/agent.ts) reads these to
  // tell "at a base, the docked reflex will refuel" from "nowhere to refuel
  // here." VERIFIED shape from the live probe fixture
  // (test/fixtures/spacemolt-probe-2026-07-12.json): get_system.poi carries
  // has_base:false and fuel_reserve:0 at the stranded location. No fuel-cost or
  // reachability math is attempted -- these two fields only.
  hasBase?: boolean;
  fuelReserve?: number;
}

// Buyable-here surfacing (issue #93): one row of the view_market summary,
// trimmed to the sell-relevant fields. Shape VERIFIED over MCP only — the
// only captured view_market response (test/fixtures/mcp-probe-2026-07-12
// .json) is a tab-table with columns category/item_id/item_name/best_sell/
// best_buy/spread/sell_qty/buy_qty; whether HTTP renders the same columns is
// load-bearing: ASSUMED (see getMarket below). The parse lives in
// mcp-text-parser.ts
// (parseMarketText), which documents the order-book semantics. bestBuy is
// the standing bid (cr/unit the market pays when you sell here), undefined
// when the cell is blank (no bid); buyQty is the bid's demand. A held item
// is sellable at this station iff bestBuy is present AND buyQty > 0 — the
// digest's market check (planner/digest.ts) keys the sell precondition on
// exactly that. best_sell/spread/sell_qty/item_name are real columns with no
// consumer yet, so they stay unparsed (no dead data, per CurrentPoiInfo).
export interface MarketRow {
  itemId: string;
  bestBuy?: number; // cr/unit the market pays you; undefined = no standing bid
  buyQty: number;   // units the market stands ready to buy
}

// Mission-progress bridge (issue #291): one active mission's structured facts,
// parsed from the SAME structuredContent.missions.active array the zero-case
// detection (#170/PR #175) already reads. Shape citation: openapi-v2.json
// components.schemas.V2GameState.missions.active -- mission_id, accepted_at
// (date-time), expires_in_ticks, percent_complete, objectives[] with item_id,
// required, current, in_cargo, completed, target_base, system_id. Every field
// is optional here (the spec marks none of them required), so a live envelope
// missing any of them still parses -- and a whole entry that fails the parse
// degrades to missions:undefined while the raw text keeps flowing (fail-soft,
// same discipline as every other gather). Display prose: the mission `title`
// and per-objective `item_name`/`description` ARE parsed (operator request
// 2026-07-19 -- the dashboard's mission card names them; citation:
// openapi-v2.json V2GameState.missions.active `title` string, objectives[]
// `item_name`/`description` strings). They exist for the DASHBOARD consumer
// (src/server/missions.ts) only -- the deterministic digest block still
// renders ids and numbers, never this prose (see renderMissionObjectiveCheck,
// digest.ts). Giver dialog and reward prose stay unparsed: the raw listing
// already carries them quoted+truncated.
export interface ActiveMissionObjective {
  type?: string;
  itemId?: string;
  itemName?: string;    // display prose (dashboard objective label)
  description?: string; // display prose (dashboard label fallback)
  required?: number;
  current?: number;
  inCargo?: number;
  completed?: boolean;
  targetBase?: string;
  systemId?: string;
}

export interface ActiveMissionInfo {
  missionId?: string;
  title?: string; // display prose (dashboard mission name)
  acceptedAt?: string; // ISO date-time, per the spec's format: date-time
  expiresInTicks?: number;
  percentComplete?: number;
  objectives: ActiveMissionObjective[];
}

// Mission-progress bridge (issue #291): getActiveMissions now returns BOTH
// reads off the one envelope -- the raw listing text (unchanged contract:
// "" = no active missions) and the parsed mission facts when the array
// validates. One call, two consumers; a second query for the same envelope
// would be the wasteful alternative.
export interface ActiveMissionsResult {
  text: string;
  missions?: ActiveMissionInfo[];
}

// Mining preconditions (issue #188): one deposit at the current POI, trimmed
// to the two fields the mining-feasibility check consumes. Shape citation:
// openapi-v2.json GetPOIResponse branch 0 resources[] -- resource_id is
// REQUIRED on every entry; supported_power is OPTIONAL there ("The maximum
// mining-beam power the deposit can currently feed", mining.md:38), so it is
// optional here too and every consumer fails OPEN when it is absent (#94:
// absence is never a verdict). richness/remaining/depletion_percent are real
// fields with no consumer yet, so they stay unparsed (no dead data, per
// CurrentPoiInfo's note).
export interface PoiDeposit {
  resourceId: string;
  supportedPower?: number;
}

// Mining preconditions (issue #188): the get_poi read, upgraded from a bare
// resource-id list (#291/PR #302) to the deposits plus the POI's own id --
// the id keys the learned-blocker lookup (same envelope, no second query).
// poiId undefined = the response's poi block was absent/unparsed, and the
// learned check simply skips (fail-open).
export interface PoiDepositsResult {
  poiId?: string;
  deposits: PoiDeposit[];
}

// Capability-audit follow-up (2026-07-19): get_location's `location` object,
// trimmed to fields NOT already carried by get_status's parsed location
// (docked_at/in_transit/system_id -- see the LocationSchema `location` field
// above) or by get_system's per-POI has_base (PoiInfo.hasBase). Deliberately
// does not re-parse those overlapping fields: two producers of the same fact
// is a seam that can silently disagree (docs/wiki/seam-manifest.md). What is
// genuinely new: nearby-entity COUNTS as parsed numbers (get_nearby is
// registered but its response is raw, uncaptured text -- see its comment) and
// the transit_* fields (get_status's location schema keeps only the boolean
// in_transit, not the destination/ETA). Every field optional/ASSUMED per the
// get_location registry comment -- a shape miss degrades that field to
// undefined, never the whole parse.
export interface LocationInfo {
  poiType?: string;
  nearbyPlayerCount?: number;
  nearbyPirateCount?: number;
  nearbyEmpireNpcCount?: number;
  inTransit?: boolean;
  transitDestPoiName?: string;
  transitArrivalTick?: number;
}

export interface GameApi {
  action(name: string, params?: Record<string, unknown>): Promise<V2Result>;
  status(): Promise<StatusSnapshot>;
  notifications(): Promise<EnvelopeNotification[]>;
  // Optional: most fakes/mocks in the test suite have no need for map data.
  // Agent.gatherSurroundings() (src/agent/agent.ts) checks for this before
  // calling it and degrades to no surroundings when absent.
  getSystem?(): Promise<SystemInfo>;
  // stall-watcher v4 progress dimensions (token-free queries, sampled on the
  // snapshot throttle cadence in Agent). Optional like getSystem: fakes/mocks
  // that don't implement them make those dimensions UNKNOWN, and the detector
  // fails safe by suppressing. getSkills returns per-skill { level, xp } (the
  // monotonic xp/level fingerprint); getAchievements returns summary.earned (a
  // monotonic count).
  getSkills?(): Promise<Record<string, { level: number; xp: number }>>;
  getAchievements?(): Promise<number>;
  // Mission-funnel fix (issue #147): get_missions is kind:"query" so the
  // planner can never plan it (PlanSchema admits only mutations) -- the
  // harness fetches the listing instead, once per docked replan (see
  // Agent.gatherMissions in src/agent/agent.ts). Returns the RAW listing
  // text, not a parsed shape: the get_missions RESPONSE has never been
  // captured live (see the actions.ts missions block), so no schema is
  // guessed here -- the digest passes the text through quoted+truncated and
  // the planner reads template_ids straight off it. Optional like getSystem:
  // fakes/mocks without it degrade to "no mission section".
  getMissions?(): Promise<string>;
  // Active-mission visibility fix (issue #170, the predicted #147 follow-up):
  // get_active_missions is kind:"query" like get_missions, so the planner can
  // never plan it -- yet accepted missions are the pilot's work-in-progress
  // and complete_mission needs an id from somewhere. Same raw-text
  // pass-through as getMissions for the listing body, but UNLIKE get_missions
  // this response IS captured live (test/fixtures/spacemolt-probe-2026-07-12
  // .json, get_active_missions), and the capture drives one parsed read: the
  // zero-active reply is the NON-EMPTY text "No active missions.", so
  // emptiness is decided off structuredContent.missions.active and returned
  // as "" (see the implementation). Optional like getMissions: fakes/mocks
  // without it degrade to "no active-mission section".
  // Mission-progress bridge (issue #291): the return carries the raw text
  // (same "" = none contract) PLUS the parsed mission facts when the captured
  // structuredContent.missions.active array validates against the vendored
  // openapi-v2 shape -- see ActiveMissionsResult above.
  getActiveMissions?(): Promise<ActiveMissionsResult>;
  // Mission-progress bridge (issue #291), widened for the mining
  // preconditions (issue #188): what the deposit at the pilot's CURRENT POI
  // can yield, plus each deposit's supported_power and the POI's own id.
  // Shape citation: openapi-v2.json GetPOIResponse (branch 0) top-level
  // resources[] -- resource_id required, supported_power optional -- and the
  // sibling poi.id; mining.md:29-38 documents the same node list. undefined =
  // the response carried no resources array (a station POI, the in-transit
  // response branch, or a shape divergence) -- NOT "this deposit yields
  // nothing"; absence is never a verdict (#94).
  getPoiDeposits?(): Promise<PoiDepositsResult | undefined>;
  // Remote-POI targeting fix (issue #176): the raw get_nearby listing --
  // the entities AT the pilot's current location, which are the ONLY valid
  // scan targets (the game's own invalid_target error says so). Same
  // producer-side pattern and same raw-text discipline as getMissions above:
  // get_nearby is kind:"query" so the planner can never plan it, the harness
  // fetches it once per replan (Agent.gatherNearby), and the response shape
  // has never been captured live -- so nothing here parses it. The digest
  // renders the text quoted+truncated and the planner copies target ids
  // straight off it. Optional like getMissions: fakes/mocks without it degrade
  // to "no nearby section" (and the digest then tells the planner there is
  // nothing to scan).
  getNearby?(): Promise<string>;
  // Capability-audit follow-up (2026-07-19): get_location is kind:"query" so
  // the planner can never plan it -- the harness fetches it every replan, same
  // producer-side pattern as getNearby above. UNLIKE getNearby this response
  // IS parsed (LocationSchema), but only for fields getStatus/getSystem do not
  // already carry (see LocationInfo's comment) -- nearby-entity counts and
  // transit_* ETA fields. undefined = the fetch failed or the response carried
  // nothing new (no nearby entities, not in transit); the digest then renders
  // no location section (ABSENCE IS NOT A VERDICT, #94). Optional like
  // getNearby: fakes/mocks without it degrade to "no location section".
  getLocation?(): Promise<LocationInfo | undefined>;
  // Buyable-here surfacing (issue #93): view_market is kind:"query" like
  // get_missions, so the planner can never plan it — yet the no-buyers thrash
  // class is exactly a sell decision made without knowing what THIS station
  // buys. Same producer-side pattern as getMissions: the harness fetches the
  // listing once per docked-with-cargo replan (Agent.gatherMarket) and the
  // digest keys the sell precondition to the parsed rows. UNLIKE the mission
  // listing this response IS parsed (parseMarketText in mcp-text-parser.ts):
  // its shape is captured, and the raw 482-row text is far too large to quote
  // into the prompt. Optional like getMissions: fakes/mocks without it
  // degrade to "no market check section".
  getMarket?(): Promise<MarketRow[]>;
  // Ship tool (issue #219): the shipyard listings at THIS station. browse_ships
  // is kind:"query" so the planner can never plan it -- same producer-side
  // pattern as getMissions: the harness fetches it once per docked replan
  // (Agent.gatherShipyard) and the digest hands the planner the listing_ids that
  // buy_listed_ship needs. Raw text, unparsed: the response HAS a schema in the
  // vendored spec (BrowseShipsResponse) but has never been captured live, and
  // the envelope's human-readable `result` already carries the ids and prices --
  // parsing a shape we have never seen to re-render the same numbers would add a
  // guessed-shape failure mode and buy nothing (the SM-2 lesson). Optional like
  // getMissions: fakes/mocks without it degrade to "no shipyard section".
  getShipyard?(): Promise<string>;
  // Capability-audit fix (Workflow A, 2026-07-19): the pilot's OWNED ships, not
  // the shipyard's for-sale ones -- switch_ship needs a ship_id from here, the
  // same way buy_listed_ship needs a listing_id from getShipyard above.
  // list_ships is kind:"query" so the planner can never plan it directly; same
  // producer-side pattern as getShipyard (Agent.gatherOwnedShips fetches it once
  // per docked replan, since switch_ship itself requires "shipyard service" at
  // the current station). Raw text, unparsed: ListShipsResponse exists in the
  // vendored spec but is schema-example data, never a live capture (same
  // discipline as getShipyard -- parsing a shape we have never seen live would
  // add a guessed-shape failure mode, the SM-2 lesson). Optional like
  // getShipyard: fakes/mocks without it degrade to "no owned-ships section".
  getOwnedShips?(): Promise<string>;
  // Ship tool (issue #219): the catalog's fit requirements for one module type
  // -- the input to the executor's install_mod guard (CPU/power/slot). Free
  // query (spacemolt_catalog), fired only on an install_mod step. undefined =
  // UNKNOWN (not a module id, no catalog entry, or a shape we can't read), and
  // the guard fails open on it. Optional like getMissions.
  getModuleSpec?(typeId: string): Promise<ModuleSpec | undefined>;
  // Capability audit (Workflow A, 2026-07-19): dedicated ground truth for
  // cargo contents, backing the buy->install chain fix alongside
  // spacemolt_storage/withdraw (see actions.ts). Deliberately a SEPARATE call
  // from status() above, not a "get_ship-style" no-op registration -- the
  // get_status-derived StatusSnapshot.cargo field this file's CargoItemSchema
  // comment already flags as unverified live is exactly the gap the audit's
  // module_not_found finding points at. undefined = the fetch failed or the
  // response didn't parse; Agent.gatherCargo (agent.ts) falls back to the
  // get_status-derived manifest on undefined (fail-open, same convention as
  // every optional GameApi method here). Optional like getShipyard: fakes/
  // mocks without it degrade to the old get_status-only path.
  getCargo?(): Promise<{ used: number; capacity: number; items: CargoItem[] } | undefined>;
  // Purchase discovery (issue #220): "is this item purchasable, at what cost,
  // from whom." estimate_purchase is kind:"query" (no `x-is-mutation` on
  // /api/v2/spacemolt_market/estimate_purchase in the vendored spec), so the
  // planner can never plan it, and the pilot's only purchase-discovery action
  // was view_market: this station, docked only. Hence the travel-and-hope plan
  // the fix exists to kill ("dock at the Extraction Hub and CHECK FOR the Deep
  // Core Extractor"). GATED ON DOCKED at the call site
  // (Agent.gatherPurchaseEstimates, issue #315): the vendored spec documents
  // this as callable from anywhere, but it was live-falsified 2026-07-17 --
  // 15/15 undocked calls returned purchase_estimate_error, "You must be docked
  // at a station...".
  // Same producer-side pattern and same raw-text discipline as getMissions: the
  // response has never been captured live, so nothing here parses it -- the
  // digest renders the envelope text quoted+truncated. Empty string = no answer
  // (the agent maps it to no section; ABSENCE IS NEVER A "not purchasable"
  // verdict). Optional like getMissions.
  estimatePurchase?(itemId: string, quantity: number): Promise<string>;
  // Market-intelligence injection (issue #269): "who buys what I hold, and
  // WHERE" -- the question the no-buyers remedy was asking with the wrong tool.
  // REFERENCE-CHECKED, and the check overturned our own registry comment:
  //   - view_orders is YOUR OWN orders ("View your own orders at a station ...
  //     your active buy and sell orders", openapi-v2.json /api/v2/
  //     spacemolt_market/view_orders; markets.md "Managing Your Orders"), with
  //     scope personal|faction. It can NEVER reveal a third party's bid, so the
  //     briefing that told the pilot to "check view_orders for a standing buy
  //     order anywhere" was asking a question the endpoint does not answer.
  //   - analyze_market IS the buyer-discovery query: "actionable insights at
  //     your current station, scaled by your Trading skill: higher skill reveals
  //     regional demand, price trends, arbitrage, and specific opportunities. It
  //     only references stations you have actually visited" (markets.md, "Market
  //     Intelligence"; openapi-v2 properties [] required []).
  // kind:"query" (no `x-is-mutation`), so the planner structurally cannot plan
  // it -- the harness fetches it, same producer-side pattern as getMissions.
  // Raw text, unparsed: the response has never been captured live, so no schema
  // is guessed here (the SM-2 lesson). Empty string = no answer, which the agent
  // maps to no section -- ABSENCE IS NEVER a "no buyer anywhere" verdict (#94:
  // "no NPC buyer" never means worthless). Optional like getMissions.
  analyzeMarket?(): Promise<string>;
}

// Defensive parse of the V2GameState subset we consume; missing fields fall
// back via ?? at the call site. Documented deviation from the spec's
// "generate API types from OpenAPI": response types are hand-written because
// V2GameState is a 16KB kitchen-sink schema where every field is optional —
// generated types would be all-optional anyway, and the conformance test
// (Task 3) guards the request side where drift actually breaks calls.
// SM-6 fix: per-entry .partial() so one malformed cargo entry drops just that
// entry (filtered out by the type guard in status() below) rather than
// failing StatusSchema.parse() for the whole get_status response -- fuel/
// hull/credits shouldn't go dark because of a bad cargo shape.
const CargoItemSchema = z.object({
  item_id: z.string(),
  item_name: z.string(),
  quantity: z.number(),
}).partial();

// Mining-precondition fix (2026-07-12): fitted-module subset. .partial() so a
// module missing an unconsumed field doesn't fail the whole status parse; the
// mapping below keeps every entry (the mine guard tolerates junk entries --
// one with no type/mining_power simply doesn't match).
const ModuleSchema = z.object({
  type: z.string(),
  type_id: z.string(),
  stats: z.object({ mining_power: z.number() }).partial().optional(),
  // Ship tool (issue #219): slot + display name (see FittedModule).
  slot: z.string(),
  name: z.string(),
}).partial();

const StatusSchema = z.object({
  ship: z.object({
    fuel: z.number(), max_fuel: z.number(),
    hull: z.number(), max_hull: z.number(),
    cargo_used: z.number(), cargo_capacity: z.number(),
    // Ship tool (issue #219): the fitting grid (see StatusSnapshot.fit).
    // .partial() below means any of these can be absent; shipFit() maps the
    // block to undefined unless the CPU and power caps are both present, so a
    // half-reported ship never fabricates a fit the guard would act on.
    cpu_used: z.number(), cpu_capacity: z.number(),
    power_used: z.number(), power_capacity: z.number(),
    weapon_slots: z.number(), defense_slots: z.number(), utility_slots: z.number(),
    // Ship-details panel: identity (see StatusSnapshot.shipName/shipClass).
    // .partial() above already makes both optional.
    name: z.string(), class_name: z.string(),
  }).partial().default({}),
  player: z.object({
    credits: z.number(),
    // stall-watcher v4: the lifetime stats map. Values are z.unknown() because
    // the block mixes numbers with a nested object
    // (credits_earned_taxable_by_category); status() below keeps only the
    // numeric entries, so a shape surprise degrades one counter, never the
    // whole get_status parse.
    stats: z.record(z.string(), z.unknown()).optional(),
  }).partial().default({}),
  location: z.object({
    docked_at: z.string().nullable(),
    in_transit: z.boolean(),
    system_id: z.string().nullable().optional(),
  }).partial().default({}),
  // .catch([]) rather than .default([]): defends against the whole `cargo`
  // key being present but not an array (wrong type entirely), not just absent
  // -- either way we degrade to "no cargo known" instead of throwing away the
  // rest of the status parse.
  cargo: z.array(CargoItemSchema).catch([]),
  // Mining-precondition fix: absent key -> undefined (UNKNOWN, guard skips);
  // a present array -> the known fitted set; present-but-garbage -> undefined
  // via .catch (treat as UNKNOWN, NOT empty -- treating a shape surprise as
  // "no modules fitted" would wrongly block a mine that is actually fine).
  // This is the inverse of cargo's .catch([]): "unknown" is the safe default
  // for a guard that short-circuits an action, "empty" for a manifest that
  // only informs.
  modules: z.array(ModuleSchema).optional().catch(undefined),
});

// VERIFIED 2026-07-10 (live get_system capture, SM-2 flight diagnosis -- see
// docs/STATE.md): the previous schema below guessed get_system -> { system:
// {...} } with connections as bare id strings. Real shape nests differently
// and connections/pois are objects, not strings:
//   { action, poi: {id,name,type,has_base,base_id?,fuel_price?}, security_status,
//     system: { id, name, empire, connections: [{system_id,name,distance}],
//               pois: [{id,name,type,class?,has_base}] } }
// The top-level `poi` (current-location detail) is a sibling of `system`, not
// nested inside it -- noted here so a future reader doesn't reintroduce that
// mistake. SM-4 fix (2026-07-10 21:01 live flight): status.dockedAt only
// covers the DOCKED half of current-location awareness -- when undocked (in
// a POI like an asteroid belt, not at a base), dockedAt is null and
// Surroundings had no current-location signal at all, so the planner
// re-targeted the POI it was already sitting in. `poi` is now parsed below
// and surfaced as SystemInfo.currentPoi (consumer: Agent.gatherSurroundings
// in src/agent/agent.ts, rendered by planner/digest.ts's "You are at" line).
const SystemConnectionSchema = z.object({
  system_id: z.string(),
  name: z.string(),
  distance: z.number(),
}).partial();

const SystemPoiSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  class: z.string().optional(),
  // station-awareness fix: the dockable flag for each POI in the system (see
  // PoiInfo.hasBase). Optional/defensive like class -- a POI without it
  // degrades to "not a station" rather than failing the parse.
  has_base: z.boolean().optional(),
});

const CurrentPoiSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  // stall-watcher v4: consumed by the strand detector (see CurrentPoiInfo).
  // Optional/defensive like the rest of this schema.
  has_base: z.boolean().optional(),
  fuel_reserve: z.number().optional(),
});

// stall-watcher v4: get_skills structuredContent.skills -- keyed by skill name,
// each { level, xp, ... }. VERIFIED against the live probe fixture. Only
// level/xp are read (the monotonic no-progress fingerprint); next_level_xp /
// max_level / category have no consumer here.
const SkillsSchema = z.object({
  skills: z.record(z.string(), z.object({
    level: z.number(),
    xp: z.number(),
  }).partial()).default({}),
});

// stall-watcher v4: get_achievements structuredContent.summary.earned -- a
// monotonic count of achievements earned. VERIFIED against the live probe
// fixture (summary: { earned, points, total }).
const AchievementsSchema = z.object({
  summary: z.object({ earned: z.number() }).partial().default({}),
});

const SystemInfoSchema = z.object({
  poi: CurrentPoiSchema.optional(),
  system: z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    connections: z.array(SystemConnectionSchema).default([]),
    pois: z.array(SystemPoiSchema).default([]),
  }).partial().default({}),
});

// ASSUMED shape of get_location's response -- unverified, no live get_location
// capture exists (same caveat as PoiInfoSchema above). Citation:
// openapi-v2.json /api/v2/spacemolt/get_location's response example,
// structuredContent.location: { poi_type, nearby_player_count,
// nearby_pirate_count, nearby_empire_npc_count, in_transit,
// transit_dest_poi_name, transit_arrival_tick, ... (docked_at/system_id also
// present but deliberately not parsed here -- see the LocationInfo comment).
// Everything optional so a live envelope missing any field, or the whole
// `location` key, still parses to {} rather than throwing.
const LocationSchema = z.object({
  location: z.object({
    poi_type: z.string(),
    nearby_player_count: z.number(),
    nearby_pirate_count: z.number(),
    nearby_empire_npc_count: z.number(),
    in_transit: z.boolean(),
    transit_dest_poi_name: z.string(),
    transit_arrival_tick: z.number(),
  }).partial().default({}),
});

// Mission-progress bridge (issue #291): the active-mission entry, per
// openapi-v2.json V2GameState.missions.active (the vendored reference's own
// response schema -- evidence level 2; no live capture of a NON-EMPTY active
// list exists yet, so the reference is the best available shape). Everything
// optional, mirroring the spec (it marks no field required): a live envelope
// missing any field still parses, and schema tolerance is the point -- this
// parse must never take down the raw-text path that shipped in #170.
const ActiveMissionObjectiveSchema = z.object({
  type: z.string().optional(),
  item_id: z.string().optional(),
  item_name: z.string().optional(),
  description: z.string().optional(),
  required: z.number().optional(),
  current: z.number().optional(),
  in_cargo: z.number().optional(),
  completed: z.boolean().optional(),
  target_base: z.string().optional(),
  system_id: z.string().optional(),
});

const ActiveMissionSchema = z.object({
  mission_id: z.string().optional(),
  title: z.string().optional(),
  accepted_at: z.string().optional(),
  expires_in_ticks: z.number().optional(),
  percent_complete: z.number().optional(),
  objectives: z.array(ActiveMissionObjectiveSchema).default([]),
});

// Mission-progress bridge (issue #291): get_poi's deposit list. Citation:
// openapi-v2.json GetPOIResponse branch 0 carries a top-level resources[]
// whose entries REQUIRE resource_id (with name/remaining/richness/
// depletion_percent alongside) and OPTIONALLY carry supported_power; branch 1
// is the in-transit response and has no resources at all. Mining
// preconditions (issue #188): supported_power and the sibling poi.id are now
// parsed too -- supported_power feeds the array-vs-deposit lock check
// (mining.md:38,42) and poi.id keys the learned-blocker lookup. Both stay
// optional/defensive: a missing supported_power or poi block degrades that
// check to fail-open, never fails the parse. richness/remaining still have no
// consumer and stay unparsed (no dead data, per CurrentPoiInfo's note).
const PoiDepositsSchema = z.object({
  poi: z.object({ id: z.string() }).partial().optional(),
  resources: z.array(z.object({
    resource_id: z.string(),
    supported_power: z.number().optional(),
  })).optional(),
});

// Ship tool (issue #219): the grid, or nothing. All-or-nothing on the two hard
// caps (cpu_capacity + power_capacity) deliberately: a fit with an unknown cap
// is a fit the install_mod guard must NOT reason about -- a missing cap read as
// 0 would block every install forever (a fabricated block from missing data,
// the failure mode every other guard here is written to avoid). Slot counts
// default to 0 because a hull genuinely has zero of a slot type it lacks, and
// the slot check treats "0 of this slot" as a real block, not as unknown.
function shipFit(ship: {
  cpu_used?: number; cpu_capacity?: number; power_used?: number; power_capacity?: number;
  weapon_slots?: number; defense_slots?: number; utility_slots?: number;
}): ShipFit | undefined {
  if (ship.cpu_capacity === undefined || ship.power_capacity === undefined) return undefined;
  return {
    cpuUsed: ship.cpu_used ?? 0,
    cpuCapacity: ship.cpu_capacity,
    powerUsed: ship.power_used ?? 0,
    powerCapacity: ship.power_capacity,
    slots: {
      weapon: ship.weapon_slots ?? 0,
      defense: ship.defense_slots ?? 0,
      utility: ship.utility_slots ?? 0,
    },
  };
}

// Ship tool (issue #219): the catalog entry for one module type. The response
// carries `items` (CatalogResponse.items -- an Item OR a Module, per the
// spec's own oneOf), so a non-module id (ore, a fuel cell) parses to a row with
// no cpu_usage/power_usage and yields undefined: UNKNOWN, and the fit guard
// fails open rather than blocking on a shape it can't read.
const CatalogModuleSchema = z.object({
  items: z.array(z.object({
    cpu_usage: z.number(),
    power_usage: z.number(),
    slot: z.string().optional(),
  }).partial()).default([]),
});

export class SpacemoltClient implements GameApi {
  private credentials: { username: string; password: string } | null = null;

  constructor(private http: SpacemoltHttp) {}

  async register(username: string, empire: string, registrationCode: string): Promise<{ password: string }> {
    await this.http.createSession();
    const res = await this.http.call("spacemolt_auth", "register", {
      username, empire, registration_code: registrationCode,
    });
    const sc = res.structuredContent as { password?: string } | undefined;
    if (!sc?.password) throw new SpacemoltError("register_failed", "no password in register response");
    return { password: sc.password };
  }

  async login(username: string, password: string): Promise<void> {
    this.credentials = { username, password };
    await this.http.createSession();
    // reauth hook: on session loss the transport replays this login
    this.http.onReauth = async () => {
      await this.http.call("spacemolt_auth", "login", { ...this.credentials });
    };
    await this.http.call("spacemolt_auth", "login", { username, password });
  }

  async action(name: string, params: Record<string, unknown> = {}): Promise<V2Result> {
    const def = getAction(name);
    const parsed = def.params.safeParse(params);
    if (!parsed.success) {
      throw new SpacemoltError("invalid_params", `${name}: ${parsed.error.message}`);
    }
    return this.http.call(def.tool, def.name, parsed.data as Record<string, unknown>);
  }

  async status(): Promise<StatusSnapshot> {
    const res = await this.action("get_status");
    const s = StatusSchema.parse(res.structuredContent ?? {});
    return {
      credits: s.player.credits ?? 0,
      fuel: s.ship.fuel ?? 0, maxFuel: s.ship.max_fuel ?? 0,
      hull: s.ship.hull ?? 0, maxHull: s.ship.max_hull ?? 0,
      cargoUsed: s.ship.cargo_used ?? 0, cargoCapacity: s.ship.cargo_capacity ?? 0,
      docked: s.location.docked_at != null,
      inTransit: s.location.in_transit ?? false,
      systemId: s.location.system_id ?? null,
      dockedAt: s.location.docked_at ?? null,
      // stall-watcher v4: keep only the numeric stats (drop the nested
      // credits_earned_taxable_by_category object). undefined when the block is
      // absent -- the detector treats that as UNKNOWN and suppresses.
      stats: s.player.stats
        ? Object.fromEntries(
            Object.entries(s.player.stats).filter((e): e is [string, number] => typeof e[1] === "number"),
          )
        : undefined,
      // SM-6 fix: drop any entry missing a required field instead of letting
      // it through with undefined itemId/name/quantity -- the digest's
      // manifest line (planner/digest.ts) renders every item it's given, so a
      // half-parsed entry would otherwise show up as "undefinedx undefined".
      cargo: s.cargo
        .filter((c): c is { item_id: string; item_name: string; quantity: number } =>
          typeof c.item_id === "string" && typeof c.item_name === "string" && typeof c.quantity === "number")
        .map((c) => ({ itemId: c.item_id, name: c.item_name, quantity: c.quantity })),
      // Mining-precondition fix: undefined stays undefined (UNKNOWN); an array
      // maps entry-by-entry. Missing type/type_id default to "" so the entry is
      // harmless to the mine guard (it matches neither the type nor the power
      // test) rather than throwing.
      modules: s.modules?.map((m) => ({
        typeId: m.type_id ?? "", type: m.type ?? "", miningPower: m.stats?.mining_power,
        slot: m.slot, name: m.name,
      })),
      fit: shipFit(s.ship),
      shipName: s.ship.name,
      shipClass: s.ship.class_name,
    };
  }

  async notifications(): Promise<EnvelopeNotification[]> {
    const res = await this.action("get_notifications", { limit: 50 });
    return res.notifications ?? [];
  }

  async getSystem(): Promise<SystemInfo> {
    const res = await this.action("get_system");
    const s = SystemInfoSchema.parse(res.structuredContent ?? {});
    const connections = s.system.connections ?? [];
    const pois = s.system.pois ?? [];
    return {
      id: s.system.id ?? null,
      name: s.system.name ?? null,
      connections: connections
        .map((c) => c.system_id)
        .filter((id): id is string => typeof id === "string"),
      pois: pois.map((p) => ({ id: p.id, name: p.name, type: p.type, class: p.class, hasBase: p.has_base })),
      currentPoi: s.poi
        ? { id: s.poi.id, name: s.poi.name, type: s.poi.type, hasBase: s.poi.has_base, fuelReserve: s.poi.fuel_reserve }
        : undefined,
    };
  }

  // stall-watcher v4: per-skill { level, xp } from get_skills, for the
  // no-progress fingerprint. Token-free query. Missing level/xp default to 0
  // so a partial entry degrades to "no movement on that skill" rather than
  // throwing.
  async getSkills(): Promise<Record<string, { level: number; xp: number }>> {
    const res = await this.action("get_skills");
    const parsed = SkillsSchema.parse(res.structuredContent ?? {});
    const out: Record<string, { level: number; xp: number }> = {};
    for (const [name, s] of Object.entries(parsed.skills)) {
      out[name] = { level: s.level ?? 0, xp: s.xp ?? 0 };
    }
    return out;
  }

  // stall-watcher v4: achievements.summary.earned (monotonic count). Token-free.
  async getAchievements(): Promise<number> {
    const res = await this.action("get_achievements");
    const parsed = AchievementsSchema.parse(res.structuredContent ?? {});
    return parsed.summary.earned ?? 0;
  }

  // Mission-funnel fix (issue #147): raw mission-listing text for the digest.
  // `result` is the envelope-level human-readable text field present on every
  // v2 response (http.ts's V2Result -- VERIFIED envelope shape, unlike the
  // uncaptured get_missions payload); when the game answers with only
  // structuredContent, it's stringified as-is rather than parsed through a
  // guessed schema. Empty string = "no listing known" (the agent renders no
  // mission section for it).
  async getMissions(): Promise<string> {
    const res = await this.action("get_missions");
    if (typeof res.result === "string" && res.result.trim()) return res.result;
    return res.structuredContent != null ? JSON.stringify(res.structuredContent) : "";
  }

  // Active-mission visibility fix (issue #170), revised per the PR #175
  // review: the zero-active state is NOT an empty result. The live capture
  // (test/fixtures/spacemolt-probe-2026-07-12.json, get_active_missions --
  // taken over this same SpacemoltHttp transport) shows result
  // "No active missions." alongside structuredContent.missions.active = [],
  // so a gate keyed on non-empty text fires a false completion-priority
  // instruction for every unmissioned pilot. Emptiness is decided off the
  // captured array (machine truth, immune to phrasing drift) rather than a
  // sentinel regex on the English text; no text fallback is needed because
  // the capture is transport-exact. Contract: text "" = no active missions
  // (gatherActiveMissions maps it to undefined; the digest renders no active
  // section and no priority line). Non-empty listings still pass through as
  // raw envelope text -- same extraction as getMissions above.
  // Mission-progress bridge (issue #291): the same captured array now feeds a
  // SECOND read -- the parsed mission facts (objectives, progress numbers,
  // accepted_at, expires_in_ticks) the deterministic objective-check digest
  // block consumes. Parse failure degrades to missions:undefined with the raw
  // text still flowing, so a live shape divergence can never regress the #170
  // listing. Shape citation: openapi-v2.json V2GameState.missions.active (see
  // ActiveMissionSchema above).
  async getActiveMissions(): Promise<ActiveMissionsResult> {
    const res = await this.action("get_active_missions");
    const active = (res.structuredContent as { missions?: { active?: unknown } } | null | undefined)
      ?.missions?.active;
    if (Array.isArray(active) && active.length === 0) return { text: "" };
    const text = typeof res.result === "string" && res.result.trim()
      ? res.result
      : res.structuredContent != null ? JSON.stringify(res.structuredContent) : "";
    let missions: ActiveMissionInfo[] | undefined;
    if (Array.isArray(active) && active.length) {
      const parsed = z.array(ActiveMissionSchema).safeParse(active);
      if (parsed.success) {
        missions = parsed.data.map((m) => ({
          missionId: m.mission_id,
          title: m.title,
          acceptedAt: m.accepted_at,
          expiresInTicks: m.expires_in_ticks,
          percentComplete: m.percent_complete,
          objectives: m.objectives.map((o) => ({
            type: o.type,
            itemId: o.item_id,
            itemName: o.item_name,
            description: o.description,
            required: o.required,
            current: o.current,
            inCargo: o.in_cargo,
            completed: o.completed,
            targetBase: o.target_base,
            systemId: o.system_id,
          })),
        }));
      }
    }
    return { text, missions };
  }

  // Mission-progress bridge (issue #291) / mining preconditions (issue #188):
  // what the deposit at the current POI can yield -- resource ids plus each
  // deposit's supported_power and the POI's own id. See PoiDepositsSchema
  // above for the shape citation. safeParse (not parse): a divergent live
  // shape degrades to undefined -- the caller (Agent.gatherPoiDeposits, the
  // executor's mine guard) makes that divergence visible with an event rather
  // than this method throwing.
  async getPoiDeposits(): Promise<PoiDepositsResult | undefined> {
    const res = await this.action("get_poi");
    const parsed = PoiDepositsSchema.safeParse(res.structuredContent ?? {});
    if (!parsed.success || !parsed.data.resources) return undefined;
    return {
      poiId: parsed.data.poi?.id,
      deposits: parsed.data.resources.map((r) => ({
        resourceId: r.resource_id,
        supportedPower: r.supported_power,
      })),
    };
  }

  // Remote-POI targeting fix (issue #176): raw nearby-entity text for the
  // digest. Identical extraction to getMissions above (envelope `result` first,
  // structuredContent stringified as a fallback) and for the identical reason:
  // the get_nearby RESPONSE has never been captured, so a schema here would be
  // a guessed shape (the SM-2 mistake). Empty string = "nothing known nearby",
  // which the agent maps to undefined and the digest renders as no section.
  async getNearby(): Promise<string> {
    const res = await this.action("get_nearby");
    if (typeof res.result === "string" && res.result.trim()) return res.result;
    return res.structuredContent != null ? JSON.stringify(res.structuredContent) : "";
  }

  // Capability-audit follow-up (2026-07-19): parsed subset of get_location's
  // response -- see LocationInfo/LocationSchema above for what is and is not
  // carried, and why. safeParse (not parse, mirrors getPoiDeposits): a
  // divergent live shape degrades to undefined rather than throwing. undefined
  // is also returned when the parse succeeds but yields nothing worth telling
  // the planner (no nearby entities AND not in transit) -- an all-zeros/absent
  // section is noise, not a finding.
  async getLocation(): Promise<LocationInfo | undefined> {
    const res = await this.action("get_location");
    const parsed = LocationSchema.safeParse(res.structuredContent ?? {});
    if (!parsed.success) return undefined;
    const loc = parsed.data.location;
    const info: LocationInfo = {
      poiType: loc.poi_type,
      nearbyPlayerCount: loc.nearby_player_count,
      nearbyPirateCount: loc.nearby_pirate_count,
      nearbyEmpireNpcCount: loc.nearby_empire_npc_count,
      inTransit: loc.in_transit,
      transitDestPoiName: loc.transit_dest_poi_name,
      transitArrivalTick: loc.transit_arrival_tick,
    };
    const hasNearby = (info.nearbyPlayerCount ?? 0) > 0 || (info.nearbyPirateCount ?? 0) > 0
      || (info.nearbyEmpireNpcCount ?? 0) > 0;
    const hasTransit = info.inTransit && info.transitDestPoiName;
    return hasNearby || hasTransit ? info : undefined;
  }

  // Buyable-here surfacing (issue #93): fetch and parse THIS station's market
  // summary. The only captured view_market response arrived as a text
  // dashboard (the MCP probe fixture). What is VERIFIED: the HTTP envelope's
  // `result` field carries human-readable text in general (http.ts's
  // V2Result; getMissions' precedent). What is load-bearing: ASSUMED: that
  // HTTP view_market's result text matches the MCP capture's column layout —
  // this action was never captured over HTTP, and the transports already
  // diverge per shape for other actions (get_status is structured over HTTP,
  // text-only over MCP; see mcp-text-parser.ts's header). Untested divergence
  // class: an HTTP rendering with the same "Market summary" intro and
  // tab-table structure but renamed/differently-named columns. The backstop
  // is deterministic, not hopeful: parseMarketText rejects a table whose
  // header lacks the consumed columns, so an absent/non-text result OR a
  // near-miss shape parses to [] — the agent (gatherMarket) surfaces that as
  // a visible market_error rather than letting a live shape divergence
  // degrade silently (the SM-2 lesson). No structuredContent fallback:
  // view_market's
  // structured payload has never been captured, so no schema is guessed here.
  async getMarket(): Promise<MarketRow[]> {
    const res = await this.action("view_market");
    return typeof res.result === "string" ? parseMarketText(res.result) : [];
  }

  // Ship tool (issue #219): raw shipyard-listing text for the digest. Identical
  // extraction to getMissions/getNearby above (envelope `result` first,
  // structuredContent stringified as the fallback) -- see the GameApi comment
  // for why the listing is not parsed. Empty string = "no listings known here",
  // which the agent maps to undefined and the digest renders as no section.
  async getShipyard(): Promise<string> {
    const res = await this.action("browse_ships");
    if (typeof res.result === "string" && res.result.trim()) return res.result;
    return res.structuredContent != null ? JSON.stringify(res.structuredContent) : "";
  }

  // Capability-audit fix (Workflow A, 2026-07-19): raw owned-ship-listing text
  // for the digest. Identical extraction to getShipyard above (envelope
  // `result` first, structuredContent stringified as the fallback) and for the
  // identical reason: ListShipsResponse is a schema-example shape in the
  // vendored spec, never captured from a live call, so parsing it here would be
  // a guessed shape. Empty string = "no owned ships known", which the agent
  // maps to undefined and the digest renders as no section.
  async getOwnedShips(): Promise<string> {
    const res = await this.action("list_ships");
    if (typeof res.result === "string" && res.result.trim()) return res.result;
    return res.structuredContent != null ? JSON.stringify(res.structuredContent) : "";
  }

  // Ship tool (issue #219): resolve a module type id to its fit requirements
  // via the catalog (CATALOG_ACTION -- the one bare-tool route, see actions.ts).
  // Fires only from the executor's install_mod guard, once, on a step that is
  // about to spend a tick; free query, so the cost of being sure is zero ticks
  // and zero credits against a purchase that can run to thousands.
  async getModuleSpec(typeId: string): Promise<ModuleSpec | undefined> {
    const res = await this.action(CATALOG_ACTION, { type: "items", id: typeId });
    const parsed = CatalogModuleSchema.safeParse(res.structuredContent ?? {});
    if (!parsed.success) return undefined;
    const entry = parsed.data.items[0];
    if (entry?.cpu_usage === undefined || entry.power_usage === undefined) return undefined;
    return { cpuUsage: entry.cpu_usage, powerUsage: entry.power_usage, slot: entry.slot };
  }

  // Capability audit (Workflow A, 2026-07-19): dedicated get_cargo fetch (see
  // the GameApi comment above for why this exists alongside status()).
  // get_cargo's structuredContent is the same V2GameState envelope get_status
  // returns (openapi-v2.json:35994's description: "Returns cargo items ...
  // in the v2 state envelope"), so this reuses StatusSchema rather than
  // hand-rolling a second cargo schema (SSOT) -- same defensive per-entry
  // drop as status() below, for the identical reason (a malformed cargo entry
  // must not fail the whole parse).
  async getCargo(): Promise<{ used: number; capacity: number; items: CargoItem[] } | undefined> {
    const res = await this.action("get_cargo");
    const parsed = StatusSchema.safeParse(res.structuredContent ?? {});
    if (!parsed.success) return undefined;
    const s = parsed.data;
    return {
      used: s.ship.cargo_used ?? 0,
      capacity: s.ship.cargo_capacity ?? 0,
      items: s.cargo
        .filter((c): c is { item_id: string; item_name: string; quantity: number } =>
          typeof c.item_id === "string" && typeof c.item_name === "string" && typeof c.quantity === "number")
        .map((c) => ({ itemId: c.item_id, name: c.item_name, quantity: c.quantity })),
    };
  }

  // Purchase discovery (issue #220): raw estimate text for the digest. Identical
  // extraction to getMissions/getShipyard above (envelope `result` first,
  // structuredContent stringified as the fallback) and for the identical reason:
  // the estimate_purchase RESPONSE has never been captured, so a schema here
  // would be a guessed shape. Params VERIFIED against the vendored OpenAPI
  // (/api/v2/spacemolt_market/estimate_purchase: required [item_id, quantity],
  // quantity minimum 1). Free query -- no tick, no credits -- but DOES require a
  // dock (issue #315, live-falsified 2026-07-17; the caller gates on it, see
  // Agent.gatherPurchaseEstimates).
  async estimatePurchase(itemId: string, quantity: number): Promise<string> {
    const res = await this.action("estimate_purchase", { item_id: itemId, quantity });
    if (typeof res.result === "string" && res.result.trim()) return res.result;
    return res.structuredContent != null ? JSON.stringify(res.structuredContent) : "";
  }

  // Market-intelligence injection (issue #269): raw analyze_market insight text
  // for the digest. Identical extraction to getMissions/getShipyard above
  // (envelope `result` first, structuredContent stringified as the fallback) and
  // for the identical reason: the analyze_market RESPONSE has never been
  // captured, so a schema here would be a guessed shape. No params (openapi-v2:
  // properties [] required []). Free query -- no tick, no credits. Empty string
  // = no insight (the agent maps it to no section; ABSENCE IS NEVER a verdict).
  async analyzeMarket(): Promise<string> {
    const res = await this.action("analyze_market");
    if (typeof res.result === "string" && res.result.trim()) return res.result;
    return res.structuredContent != null ? JSON.stringify(res.structuredContent) : "";
  }

}
