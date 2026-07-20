import type { Plan } from "../registry/plan";
import type { WakeReason } from "../agent/wake";
import type { ActiveMissionObjective, CargoItem, FittedModule, LocationInfo, MarketRow, PoiDeposit, ShipFit } from "../client/client";

// Mission-progress bridge (issue #291): one active mission's structured facts
// as the DIGEST consumes them -- the client's parsed shape (see
// ActiveMissionInfo in src/client/client.ts, cited against openapi-v2's
// V2GameState.missions.active) plus ONE derived field. zeroProgressHours is
// computed by Agent.summarizeActiveMission from accepted_at against the
// agent's injectable clock, and it is computed at the PRODUCER on purpose:
// buildDigest is a pure function of its ctx (the plan_context event replays
// it for the offline eval, #263), so a Date.now() inside the digest would
// make the recorded prompt unreproducible. undefined = staleness is UNKNOWN
// (no accepted_at, unparseable timestamp, or progress is not zero) -- absence
// is never a verdict (#94), so no advisory renders from missing data.
export interface ActiveMissionStatus {
  missionId?: string;
  // Display prose for the DASHBOARD mission card (missions.ts reads it off the
  // persisted plan_context event; operator request 2026-07-19). Deliberately
  // NOT rendered by buildDigest: the objective-check block's contract is ids
  // and numbers with no untrusted-text quoting, and the planner already gets
  // the title via the quoted raw listing (activeMissionsText). Replay fidelity
  // (#263) is unaffected -- buildDigest ignores the field, so the recorded
  // digest is unchanged; clipPlanContext bounds it like every string leaf.
  title?: string;
  expiresInTicks?: number;
  percentComplete?: number;
  zeroProgressHours?: number;
  objectives: ActiveMissionObjective[];
}

// F-1 fix (ground truth: maiden-flight, planner hallucinated destination
// "alpha_mining" with no location data to check it against): the map context
// the digest can render so the planner has real ids to choose from instead of
// inventing them. Optional -- populated by Agent.gatherSurroundings() each
// replan when the configured GameApi supports the getSystem query; undefined
// for planners/tests that don't need map awareness.
export interface Surroundings {
  systemId: string | null;
  systemName: string | null;
  connections: string[]; // adjacent system ids, from get_system
  // from get_system.system.pois (VERIFIED 2026-07-10); hasBase = dockable
  // station (station-awareness fix). incompatible (issue #253): the module the
  // game named when a mine at this POI blocked with "You need a <module>
  // module to collect resources here" -- stamped by Agent.applyIncompatiblePois
  // from the agent's learned map memory, cleared when a matching module is
  // fitted. Regex-constrained to lowercase letters/spaces (see
  // Agent.learnIncompatiblePoi), so it is safe to interpolate in the digest.
  // sparse (issue #188): true when the agent's learned sparse-deposit memory
  // holds a currently-valid rule for this POI under the CURRENT mining fit
  // (Agent.applySparseMarkers). A boolean, never game text: the digest
  // renders a FIXED marker for it, so no untrusted prose rides this field.
  pois: Array<{ id: string; name: string; type: string; class?: string; resources?: string[]; hasBase?: boolean; incompatible?: string; sparse?: boolean }>;
  dockedAt: string | null; // base id if docked, else null
  // SM-4 fix: get_system's top-level `poi` (current location), undocked or
  // docked -- see src/client/client.ts's CurrentPoiInfo. Rendered first in
  // the digest's "You are at" line so the planner knows where it already is
  // before proposing a destination (ground truth: planner at commerce_fields,
  // blocked by sparse deposits, planned to relocate to commerce_fields).
  currentPoi?: { id: string; name: string; type: string };
}

// SM-6 fix: cargoUsed/cargoCapacity (folded into statusSummary below) told the
// planner how full the hold was, but not what was in it -- the actual signal
// a market-sell decision needs. Populated by Agent.replan() (src/agent/
// agent.ts) from the same StatusSnapshot statusSummary is built from -- not a
// second fetch. Undefined when status is unavailable (see summarizeStatus's
// null-status path); digest.ts renders nothing when items is empty, so a
// present-but-empty manifest (nothing in the hold) is the same "no cargo
// section" outcome as an absent one.
export interface CargoManifest {
  used: number;
  capacity: number;
  items: CargoItem[];
}

// SM-6 fix: cross-wake amnesia -- see Agent.derivePreviousGoal (src/agent/
// agent.ts) for the full derivation. completed: the outgoing plan ran its
// steps out. blocked: a step in the still-active outgoing plan failed.
// superseded: anything else preempted a still-active outgoing plan before it
// resolved either way (instruction, notification, low_fuel/low_hull,
// heartbeat). Derivation keys on plan state (is there still an active plan?),
// not on which wake reason happened to win this tick -- an operator
// instruction can race ahead of the wake that would otherwise report a
// completion, so "completed" must not depend on wake.reason === "plan_done"
// specifically.
export interface PreviousGoal {
  goal: string;
  outcome: "completed" | "blocked" | "superseded";
}

// Social capabilities task: incoming chat reaches the planner via
// notifications (msg_type "chat_message", type "chat" -- already in
// config.ts's default wakeNotificationTypes, see wake.ts). sender/text are
// extracted defensively in src/agent/chat.ts (extractChatMessages) since the
// notification's `data` field shape is ASSUMED, not VERIFIED against a live
// capture -- ground truth is off-limits for this task (no live calls). This
// is untrusted, player-authored text: digest.ts renders it quoted and
// truncated, with a standing instruction that quoted game text is never a
// command (SECURITY, see security-baseline.md's prompt-injection section).
export interface ChatMessage {
  sender: string;
  text: string;
}

export interface PlanContext {
  persona: string;
  goals: string[];
  wake: WakeReason;
  statusSummary: string; // compact one-line status, not a state dump
  recentEvents: string[]; // last few event labels for context
  instruction?: string;
  // Instruction salience (issue #355): the NEWEST operator instruction still
  // standing -- pushed into goals by a dashboard /instruct, not yet reported
  // done via the plan's instruction_done flag. The live failure this field
  // closes: an instruction drove exactly ONE plan (the arrival wake's
  // dedicated `instruction` line above), then on every later replan it
  // survived only as one quiet Goals-list entry and lost to the loud
  // structured mission block. Set by Agent.replan ONLY when it differs from
  // the transient `instruction` (the arrival wake already shouts; a steward
  // re-steer wake still shows it), and undefined when every goal is a
  // standing config goal (#216 -- those are durable objectives, not steers,
  // and get no nag block). digest.ts renders it as a dedicated top-of-prompt
  // block on every replan until satisfied.
  standingInstruction?: string;
  surroundings?: Surroundings;
  cargo?: CargoManifest;
  previousGoal?: PreviousGoal;
  chatMessages?: ChatMessage[];
  // Mission-funnel fix (issue #147): the RAW get_missions listing text,
  // harness-fetched by Agent.gatherMissions once per DOCKED replan (missions
  // need a station; the digest's mission briefing used to instruct the
  // planner to plan get_missions itself, a kind:"query" action PlanSchema
  // structurally rejects). Raw text, not a parsed shape -- the get_missions
  // response has never been captured live, so digest.ts renders it
  // quoted+truncated like every other untrusted game-text seam and the
  // planner copies template_ids straight off it. Undefined when undocked,
  // when the fetch fails (fail-soft, mirrors surroundings), or when the
  // listing is empty.
  missionsText?: string;
  // Active-mission visibility fix (issue #170): the RAW get_active_missions
  // listing text, harness-fetched by Agent.gatherActiveMissions on EVERY
  // replan -- docked or not, unlike missionsText above, because an accepted
  // mission's objective is worked in space and the planner must always see
  // work-in-progress. Same raw-text discipline as missionsText (the digest
  // renders it quoted+truncated, never parsed here, and the planner copies
  // complete_mission ids straight off it; the client's one parsed read --
  // emptiness via structuredContent.missions.active, captured in the
  // 2026-07-12 probe fixture -- happens upstream). Undefined when the fetch
  // fails (fail-soft) or there are no active missions (the game's
  // "No active missions." reply maps to "" at the client, undefined here).
  activeMissionsText?: string;
  // Mission-progress bridge (issue #291): the parsed active-mission facts --
  // mission ids, objective item/progress numbers, expiry, and the derived
  // zero-progress age -- gathered by Agent.gatherActiveMissions off the SAME
  // get_active_missions envelope as activeMissionsText above (one call, two
  // reads). The raw listing shows the planner the mission's prose and its
  // complete_mission id; THIS field feeds the deterministic objective-check
  // block (ids and numbers only, no untrusted prose) that says what each
  // objective still needs and whether the current deposit can supply it.
  // Undefined when the envelope's missions.active array failed the tolerant
  // parse (raw text still flows) or there are no active missions.
  activeMissions?: ActiveMissionStatus[];
  // Mission-progress bridge (issue #291): the resource ids the deposit at the
  // pilot's CURRENT POI can yield, from a harness-run get_poi
  // (Agent.gatherPoiDeposits -- fetched only when a mineable POI is the
  // current location AND an active mission still needs an item, so the query
  // is spent exactly when the objective-vs-deposit check is decidable). The
  // gap this closes (live 2026-07-16): the pilot planned "mine titanium" at a
  // belt for ~57h while the belt filled its hold with palladium/vanadium --
  // nothing it was shown could say the belt does not CONTAIN titanium.
  // Undefined when the fetch fails, the response carries no resources array,
  // or the gate doesn't fire -- ABSENCE IS NOT A VERDICT (#94): the digest
  // must never claim "this deposit lacks X" from missing data, only from a
  // parsed list that omits X.
  // REPLAY-ONLY since issue #188: the agent now writes currentPoiDeposits
  // below (ids + supported_power off the same fetch) and no longer sets this
  // field. It stays on the type so a plan_context event persisted BEFORE the
  // change still replays its deposit-membership verdict byte-identically in
  // the offline eval (#263) -- the digest reads currentPoiDeposits first and
  // falls back to this (persisted-state tolerance: old artifacts degrade
  // gracefully, never crash and never lose data they carry).
  currentPoiDepositIds?: string[];
  // Mining preconditions (issue #188): the deposits at the pilot's CURRENT
  // POI -- resource id + supported_power per entry -- from the same
  // harness-run get_poi that fed currentPoiDepositIds (Agent.gatherPoiDeposits,
  // now fetched at ANY mineable current POI: the mining-feasibility verdict
  // gives the fetch a consumer whether or not a mission wants an item).
  // Feeds two digest blocks: the objective-vs-deposit membership check (ids)
  // and the deterministic can-your-array-lock-it verdict (supported_power vs
  // total fitted mining_power, the mining.md:42 4x rule shared with the
  // executor's mine guard). supportedPower is optional per the vendored
  // GetPOIResponse; an entry without it renders "support unknown" and the
  // verdict fails open (#94).
  currentPoiDeposits?: PoiDeposit[];
  // Remote-POI targeting fix (issue #176): the RAW get_nearby listing text --
  // the entities AT the pilot's current location (ships, wrecks, objects),
  // harness-fetched by Agent.gatherNearby on EVERY replan (docked or not: what
  // is around you is a fact of your position, not of a station). These are the
  // ONLY valid scan targets, and before this field the planner had no id source
  // for them at all -- it was shown POI ids and nothing else, so it scanned
  // POIs and every one of the 16 lifetime scans was rejected
  // (`invalid_target: ... not found at your current location`). Same raw-text
  // discipline as missionsText: the get_nearby response has never been captured
  // live, so nothing parses it -- digest.ts renders it quoted+truncated and the
  // planner copies target ids straight off it. Undefined when the fetch fails
  // (fail-soft) or nothing is known nearby; the digest then briefs that there
  // is nothing here to scan.
  nearbyText?: string;
  // Broken-fuel-chain fix (issue #152): true when this tick's fuel is below
  // the reserve threshold (Agent.fuelBelowReserve over the SAME StatusSnapshot
  // statusSummary is built from -- not a second fetch). Gates the digest's
  // fuel-acquisition briefing (the exact catalog fuel-cell ids + the
  // dock/buy/refuel sequence) so it appears only when fuel actually needs
  // acting on, instead of padding every prompt. A boolean, not the raw
  // numbers: statusSummary already carries fuel/maxFuel for display; this
  // field exists solely because the digest cannot re-derive "below reserve"
  // from the summary string without parsing its own prose. Undefined when
  // status is unavailable (same degradation as cargo above).
  lowFuel?: boolean;
  // Buyable-here surfacing (issue #93): THIS station's market summary rows,
  // harness-fetched by Agent.gatherMarket once per DOCKED replan WITH cargo
  // aboard (no cargo -> no sell decision -> no fetch; the market query is the
  // one extra game call the feature spends, so it's spent only when a sell is
  // actually decidable). PARSED rows, not raw text — the view_market response
  // shape IS captured (mcp-probe fixture; see client.ts's MarketRow), and the
  // raw 482-row listing would blow the prompt budget the mission listings'
  // quoted-text treatment is sized for. digest.ts cross-references these rows
  // against `cargo` above and renders which held items THIS station buys
  // (bid + demand) and which have NO buyer here — the data the no-buyers
  // thrash class was missing. Undefined when undocked, when the hold is
  // empty, when the fetch fails, or when the parse yields no rows (fail-soft,
  // mirrors missionsText; an empty parse also emits market_error so a live
  // shape divergence is visible).
  marketRows?: MarketRow[];
  // Ship tool (issue #219): the pilot's own fitting grid -- CPU/power headroom,
  // slot counts, and what is fitted right now. Taken from the SAME StatusSnapshot
  // statusSummary is built from (get_status already carries the ship's fit block;
  // no extra query), so this is a rendering concern, not a fetch. It exists
  // because the whole upgrade decision -- "can I fit a Mining Laser III?" -- is
  // undecidable from `credits 17306` alone, which is all the planner has ever
  // been shown. Undefined when the ship block didn't carry a grid (UNKNOWN), and
  // the digest then renders no fit section rather than claiming a zero grid.
  shipFit?: ShipFit;
  // Ship tool (issue #219): what is fitted right now, from the same snapshot as
  // shipFit above. Kept as a sibling field rather than folded into ShipFit
  // because ShipFit is the executor's guard input (the hull's hard caps) and the
  // fitted set is the digest's rendering input -- one shape serving two
  // consumers with different needs would carry a field for whichever one didn't
  // ask. Undefined when the modules block was absent (UNKNOWN); the digest then
  // renders the grid without a fitted list rather than claiming an empty ship.
  fittedModules?: FittedModule[];
  // Ship tool (issue #219): the RAW browse_ships listing at this station,
  // harness-fetched by Agent.gatherShipyard once per DOCKED replan (a shipyard
  // is a station's, so an undocked pilot has nothing to browse). browse_ships is
  // kind:"query" -- the planner structurally cannot plan it -- and the
  // listing_ids buy_listed_ship needs live nowhere else. Same raw-text
  // discipline as missionsText: the response has never been captured live, so
  // nothing parses it; the digest renders it quoted+truncated and the planner
  // copies listing_ids straight off it. Undefined when undocked, on a failed
  // fetch, or when this station has no shipyard.
  shipyardText?: string;
  // Capability-audit fix (Workflow A, 2026-07-19): the RAW list_ships listing of
  // ships the pilot OWNS, harness-fetched by Agent.gatherOwnedShips once per
  // DOCKED replan (switch_ship itself requires "shipyard service" at the current
  // station, so the same gate as shipyardText applies even though list_ships
  // itself does not require docking). list_ships is kind:"query" -- the planner
  // structurally cannot plan it -- and the ship_id switch_ship needs to activate
  // a bought hull lives nowhere else. Same raw-text discipline as shipyardText:
  // the response has never been captured live, so nothing parses it; the digest
  // renders it quoted+truncated and the planner copies ship_ids straight off it.
  // Undefined when undocked, on a failed fetch, or when the pilot owns nothing
  // but the active ship.
  ownedShipsText?: string;
  // Purchase discovery (issue #220): a free, dockless estimate_purchase answer
  // for each catalog item the operator's GOALS name (Agent.gatherPurchaseEstimates,
  // candidates from goal-items.ts). The gap it closes: the pilot was saving for a
  // module and the only purchase-discovery action it had was view_market -- this
  // station, docked -- so "find out if the station sells it" and "fly there" were
  // the same act, and the plan became a tour. estimate_purchase is kind:"query",
  // so the planner cannot plan it and the harness must fetch it. Raw text per
  // candidate, unparsed (the response has never been captured live).
  // ABSENCE IS NOT A VERDICT: undefined when the goals name no catalog item, when
  // they name too many to be decidable, or when the fetch fails -- the digest then
  // renders NO purchase section. It must never render "not purchasable" from
  // missing data; a false "your module does not exist" is worse than the
  // tour-the-galaxy behaviour this replaces.
  purchaseEstimates?: PurchaseEstimate[];
  // Market-intelligence injection (issue #269): the RAW analyze_market insight
  // text, harness-fetched by Agent.gatherAnalyzeMarket once per DOCKED-WITH-CARGO
  // replan. This is the no-buyers remedy made plannable: the old briefing told
  // the planner to "check view_orders / analyze_market" for a buyer elsewhere,
  // but both are kind:"query" (PlanSchema rejects them) AND view_orders shows
  // only the pilot's OWN orders -- so the remedy was inert. analyze_market is
  // the game's actual buyer-discovery query (regional demand, skill-gated,
  // visited-stations-only per markets.md), so the harness runs it and the digest
  // hands the planner the insight. Same raw-text discipline as missionsText (the
  // response has never been captured live; digest.ts renders it quoted+truncated
  // and the planner reads station ids straight off it). Undefined when undocked,
  // when the hold is empty, on a failed fetch, or on an empty answer -- ABSENCE
  // IS NOT A VERDICT (#94: the digest must never render "no buyer anywhere" from
  // missing data).
  marketInsightsText?: string;
  // Capability-audit follow-up (2026-07-19): nearby-entity counts and transit
  // ETA from get_location, harness-fetched by Agent.gatherLocation every
  // replan (docked or not, same as nearbyText -- what is around you and
  // whether you're mid-transit are facts of your position). PARSED numbers,
  // not quoted game text (client.ts's LocationSchema), so it needs no
  // untrusted-text treatment. ADDITIVE ONLY: this is not the dock-precondition
  // fix (get_system's has_base already covers "is there a station here", see
  // digest.ts:657) -- get_location carries no has_base field at all. Undefined
  // when the fetch fails or there is nothing worth telling the planner (no
  // nearby entities and not in transit); the digest then renders no location
  // section (ABSENCE IS NOT A VERDICT, #94).
  locationInfo?: LocationInfo;
}

// Purchase discovery (issue #220): one estimate_purchase answer. itemId/name come
// from the catalog (the SSOT we matched the goal against); text is the game's raw
// envelope text, quoted+truncated by the digest like every other untrusted seam.
export interface PurchaseEstimate {
  itemId: string;
  name?: string;
  text: string;
}

// Layer 5 (cost capture): plan() returns the plan PLUS the size of the
// prompt/response it consumed, summed across any internal retry a planner
// makes (claude-subscription/ollama each retry once on a parse failure, so
// those chars are real spend and must be counted). The agent records these on
// the plan event; usage.ts (src/server/usage.ts) turns chars -> estimated
// tokens (chars/4) x a per-model price table. `model` travels here too so the
// plan event can attribute cost/calls per model without the server reaching
// back into per-agent planner config. Chars, not tokens: the Claude
// subscription CLI returns no token usage (VERIFIED -- see claude-subscription.ts's
// envelope, which carries only type/subtype/is_error/result), so an exact token
// count is impossible; chars is the one measurable proxy at this seam. The
// resulting cost is an estimate with a tunable price table, documented as such.
export interface PlanResult {
  plan: Plan;
  promptChars: number;
  responseChars: number;
  model?: string;
}

export interface Planner {
  plan(ctx: PlanContext): Promise<PlanResult>;
}
