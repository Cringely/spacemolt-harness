import type { StationSighting } from "../planner/types";
import type { DockTrailRow } from "../store/store";

// Station geography (issue #517): the pilot's own memory of WHERE stations are.
//
// The live failure (2026-07-25 00:10-00:58 UTC, miner): cargo 100/100, fuel
// 10 -> 9, no station in the system, and the pilot burned 8 jumps in 48 minutes
// plus 70 planner calls in 6h hunting for somewhere to dock -- while reasoning
// out loud from an NPC's chat prose ("customs NPC references a 'Gold Run
// Extraction Hub', likely a station"). It had DOCKED at Gold Run Extraction Hub
// nine hours earlier and refuelled there. The knowledge was in our own event
// store the whole time; the digest just had nowhere to put it.
//
// Producer-side fix, in the digest's terms: `Connections` only ever named the
// systems ONE hop away, so a `travel_to{system_id}` step -- which reaches any
// system, several jumps out, and which the digest already instructs the planner
// to use -- had no candidate ids to name. This module is the memory that
// supplies them.
//
// Everything here is pure: no clock, no store, no game calls. The Agent owns
// the Map, the event stream and the injectable clock (same split as
// stall-monitor.ts / wake.ts / snapshot-throttle.ts, and it keeps this logic
// unit-testable without standing up an Agent and a fake API).

// Cap on retained station sightings, oldest-evicted -- same sizing discipline
// as MAX_INCOMPATIBLE_POIS/MAX_SPARSE_RULES in agent.ts. Receipt for 8: the
// live store held 12 confirmed station systems after ~10 days of flying, and
// this list is a DESTINATION SHORTLIST, not an atlas -- the 8 most recently
// confirmed keep the pilot's current working neighbourhood while bounding both
// the retained map and the prompt line it renders (a dump is the failure mode
// the digest's clipping discipline exists to prevent). One number for both
// retention and rendering on purpose: two caps would be two things to keep in
// agreement for no gain.
export const MAX_STATION_SIGHTINGS = 8;

// Bound on the retained station NAME. Game-authored text that we persist and
// render, so it is clipped at the producer -- the same "store it bounded"
// discipline as the sparse rule's `detail`. 48 covers every observed name
// ("Cargo Lanes Freight Depot", "Factory Belt Manufacturing Hub").
export const STATION_NAME_MAX = 48;

// Which station SERVICE a successful action proves, when that action succeeded
// while DOCKED.
//
// Admission rule, and it is narrow on purpose: an action earns a place here only
// if the reference documents the station service as REQUIRED, with no fallback
// path that can succeed without it. A service tag routes the pilot somewhere, so
// a wrong one recreates the exact failure this whole fix exists to stop -- a
// confident trip to a station that cannot do the thing.
//
// ADMITTED (openapi-v2.json, docs/game-reference/upstream):
//   sell, buy -> market. /api/v2/spacemolt/sell and /buy document no mode that
//     fills an order away from a market, and the dock description names trading
//     as a thing docking is required for.
//   craft -> crafting. /api/v2/spacemolt/craft opens "Must be docked at a base
//     with crafting AND storage service" -- a stated precondition with no
//     alternative, so a success is proof.
//
// REJECTED, both for the same reason (PR #18 review, F2):
//   refuel. /api/v2/spacemolt/refuel documents FOUR modes, and the two that
//     matter here are "(3) Docked at refuel station with credits -> station
//     refueling" and "(4) Otherwise -> fuel cells from cargo". Mode 4 is
//     "otherwise", NOT "undocked": a refuel while docked at a base with no pump,
//     or with no credits, falls through to burning cargo cells and SUCCEEDS.
//     Tagging that station `refuel` would send the pilot back to it and earn a
//     `no_refueling_pump` -- a class the live incident logged. `docked` cannot
//     discriminate mode 3 from mode 4, and the signal that could
//     (CurrentPoiInfo.fuelReserve, get_system) is not in hand at the seam that
//     learns this. Per #517's own scope -- services are tagged "where the
//     observation is cheap to attribute" -- no tag beats a wrong one.
//   repair. Identical shape: "No target: station repair if docked (credits),
//     else uses repair kits from cargo."
//
// The general lesson, worth stating because it generalizes past these two: an
// action with a cargo-consumable fallback proves nothing about where you are.
export const STATION_SERVICE_BY_ACTION: Record<string, string> = {
  sell: "market",
  buy: "market",
  craft: "crafting",
};

// A dock SUCCESS names the station: "Docked at Gold Run Extraction Hub"
// (live capture, 24h window ending 2026-07-25 -- the same window in which a
// dock FAILURE read "No station at this location" 23 times). The failure text
// is deliberately NOT matched here: success/failure is decided by the
// executor's StepResult kind, never by prose, so a reworded game message can
// only cost us the station's display NAME -- never the load-bearing fact that
// this system has a dockable station. That is the whole reason the name is
// parsed and the fact is not (the 2026-07-12 "don't parse result strings"
// finding: a harness that depends on the game's exact wording breaks silently
// when the wording changes).
const DOCKED_AT_RE = /^\s*docked at\s+(.+)$/i;

/** The station name a dock result names, or undefined if the text doesn't name one. */
export function dockedStationName(resultText: string | undefined): string | undefined {
  if (!resultText) return undefined;
  const m = DOCKED_AT_RE.exec(resultText.split("\n")[0]!);
  if (!m) return undefined;
  const name = m[1]!.trim().replace(/[.\s]+$/, "");
  if (!name) return undefined;
  return name.length > STATION_NAME_MAX ? name.slice(0, STATION_NAME_MAX) : name;
}

/**
 * Fold one confirmed observation into the sightings map. Returns true when a
 * NEW fact was learned (first sighting of this system, a name we didn't have,
 * or a service we hadn't confirmed) -- the caller emits a persistence event
 * only then, so the stored stream stays one event per fact rather than one per
 * dock. `lastSeen` always advances, so recency ordering stays correct even on
 * a re-dock that teaches nothing new.
 *
 * Mutates and evicts in place, oldest-lastSeen first at the cap: the same
 * bounded-map contract as the incompatible-POI and sparse-rule memories.
 */
export function rememberStation(
  sightings: Map<string, StationSighting>,
  obs: { systemId: string; stationPoiId?: string; station?: string; service?: string; now: number },
): boolean {
  const existing = sightings.get(obs.systemId);
  if (!existing) {
    sightings.set(obs.systemId, {
      systemId: obs.systemId,
      stationPoiId: obs.stationPoiId,
      station: obs.station,
      services: obs.service ? [obs.service] : [],
      lastSeen: obs.now,
    });
    evictOldest(sightings);
    return true;
  }
  let learned = false;
  // Ordering: this reset runs BEFORE the name and service merges below, so one
  // observation that both moves us to a new station and proves a service there
  // lands that service on the NEW station.
  // A DIFFERENT station in a system we already know: the record describes one
  // station, so the name and the proven services belong to the station that
  // proved them and are dropped with it (PR #18 review, F3). Without this reset
  // the fields drift apart -- stationPoiId and station are last-write-wins while
  // services accumulate across every station in the system -- and the digest,
  // which renders them as one line, would advertise station B as offering what
  // was only ever proven at station A. That is this fix's own bug pointed at a
  // POI instead of a system: a confident route to a station that cannot do the
  // thing. An observation carrying NO station POI (an unknown position) cannot
  // tell us we moved, so it never resets anything.
  if (obs.stationPoiId && obs.stationPoiId !== existing.stationPoiId) {
    existing.stationPoiId = obs.stationPoiId;
    existing.station = undefined;
    existing.services = [];
    learned = true;
  }
  // A station name we didn't have, or a DIFFERENT one: last dock wins. A
  // system can hold more than one station and we keep one name per system --
  // the id is what travel_to needs, the name is the human/NPC-prose handle
  // that lets the planner connect "Gold Run Extraction Hub" to `gold_run`.
  if (obs.station && obs.station !== existing.station) {
    existing.station = obs.station;
    learned = true;
  }
  if (obs.service && !existing.services.includes(obs.service)) {
    existing.services.push(obs.service);
    learned = true;
  }
  existing.lastSeen = obs.now;
  return learned;
}

/**
 * The station systems recoverable from history alone (issue #525) -- one entry
 * per system, most recently confirmed first.
 *
 * WHY THIS EXISTS. rememberStation above only ever learns FORWARD, from a dock
 * happening now. The live pilot met the cost the day that shipped: stranded at
 * a sun with fuel 2/130 and cargo 100/100, it needed a station to route to,
 * had 482 historical docks in its own event store, and was shown
 * `knownStations === []` in all 58 plans it burned over six hours. The feature
 * could not populate until it docked; it could not dock without the feature.
 * The deadlock breaks from data already on disk, so this reads it.
 *
 * THE WALK, AND WHY IT IS A HEURISTIC. `dock` does not move the ship, so the
 * system a dock happened in is the last position the pilot reported before it
 * -- the nearest preceding `status_snapshot`. Walking the trail in order while
 * carrying that position is the whole algorithm. But the position is only as
 * fresh as the last snapshot, and snapshots are emitted ONLY on wake ticks
 * (agent.ts, inside `if (wake)`) while plan steps also execute on non-wake ones.
 * So a plain `[travel_to X, dock]` plan runs the jump AND its dock with no
 * snapshot between them, and the carried position still names the system the
 * ship left. Clearing the position on a successful `jump`/`travel_to` is what
 * makes that attribution safe: every dock after a move is DROPPED until a
 * snapshot re-establishes where the ship is. Losing a dock costs one candidate
 * destination; keeping a wrong one manufactures the exact false "there is a
 * station here" belief this feature exists to prevent.
 *
 * WHAT THAT DOES AND DOES NOT COVER, stated precisely because the scope is
 * narrower than it looks. It makes the PLAN-STEP attribution safe: a move this
 * harness executed and recorded as succeeding. It does NOT make the position
 * generally trustworthy, because the ship can change system with no successful
 * move on the record at all. On the production snapshot, 164 of 1,234 observed
 * system changes had none: 90 with no action rows whatsoever between the two
 * snapshots, and most of the rest a `jump:wait ... jump:blocked` retry chain
 * where the server moved the ship anyway. The reference says so outright
 * (docs/game-reference/upstream/docs/travel.md:36): "If you abort early the
 * movement still completes server-side; verify where you are with `get_status`
 * before retrying." A snapshot is the only thing that actually establishes
 * position; this rule only keeps us from trusting a position we KNOW we left.
 *
 * Output impact of that gap today is zero, and it was checked rather than
 * assumed. Of the 713 kept docks, 704 are corroborated by the next snapshot that
 * names a system with no successful move in between, 5 have no later evidence
 * either way, and 4 are contradicted. All 4 of those name stations that match
 * the system they were attributed to ("Gold Run Extraction Hub" in `gold_run`,
 * "Cargo Lanes Freight Depot" in `cargo_lanes`), and both systems are confirmed
 * independently by many other docks -- so the derived map is the same 16 systems
 * with or without them. Tracked separately rather than guarded here: a guard
 * with no output to change is a guard no test can hold honest.
 *
 * On today's data the staleness rule itself drops nothing (production snapshot,
 * 718 nameable successful docks: 713 kept, 5 dropped for no position at all, 0
 * dropped as stale, 16 systems either way). That is a property of the data, not
 * of the algorithm -- a cross-system move usually ENDS a plan, so the next tick
 * wakes and snapshots before the dock. It is not a reason to drop the rule: the
 * reviewer drove the real Agent with a two-step plan and got a dock attributed
 * to the wrong system without it.
 *
 * WHAT IS TRUSTED, AND WHAT IS NOT. Success comes off the recorded `outcome`,
 * the executor's own StepResult kind, never off prose -- the same split #517
 * draws, and the reason 279 "No station at this location" rows and a reworded
 * failure that happens to read like a success both teach nothing here. Prose is
 * consulted for the station NAME and nothing else, through the same parser the
 * live path uses. So a game that rewords its dock message costs a display name,
 * never the load-bearing fact that this system has a dockable station.
 *
 * WHAT IS NOT CLAIMED. No `stationPoiId` and no `services`. Neither is derivable
 * from history -- the trail records where the ship SAID it was, not which POI it
 * stood at -- and inventing either would recreate #517's own bug: a confident
 * route to a station that cannot do the thing. A derived row is a weaker record
 * on purpose, and the caller lets any structured sighting outrank it.
 *
 * NO CAP HERE, and that is deliberate. The obvious `.slice(0, MAX)` on the way
 * out is dead: the caller merges these into a map that ALREADY holds structured
 * sightings, so only the caller knows how many slots are left, and its own stop
 * is what has to bind. Two caps would mean one of them could never fail a test
 * -- the same redundant-trim shape PR #18's ablation deleted from the reload
 * path. Sorted newest-first so the caller filling N slots fills them with the
 * N most recent.
 *
 * Pure, like everything else here: the caller supplies the rows.
 */
export function deriveStationSightings(trail: DockTrailRow[]): StationSighting[] {
  const bySystem = new Map<string, StationSighting>();
  // `undefined` means "we do not know where the ship is" -- and it carries BOTH
  // reasons for not knowing: nothing has been reported yet, or a successful move
  // invalidated what was reported. A separate `moved` flag alongside this was
  // redundant: `position` is read at exactly the two sites below, both inside the
  // dock branch, so `moved === true` and `position === undefined` always gated
  // the identical row set. Clearing the position IS the staleness mark.
  let position: string | undefined;
  for (const row of trail) {
    if (row.type === "status_snapshot") {
      // A snapshot whose systemId is absent or null reports an UNKNOWN
      // position, not a fresh one -- the live payload writes `status.systemId
      // ?? null`. It leaves the last known position standing rather than
      // clearing it, because clearing would silently drop real history every
      // time one status call came back thin. It deliberately does NOT clear
      // the position either: a snapshot that names no system re-establishes
      // nothing, so a position that went stale before it is still stale after it.
      if (typeof row.systemId === "string" && row.systemId) position = row.systemId;
      continue;
    }
    const succeeded = row.outcome === "continue" || row.outcome === "plan_done";
    if (row.action === "jump" || row.action === "travel_to") {
      // Only a SUCCESSFUL move invalidates the position. A blocked jump (no
      // fuel, no route) left the ship exactly where it was, and treating it as
      // a move would throw away the dock that a stranded pilot then performs
      // in place -- the state the whole feature exists to get out of.
      if (succeeded) position = undefined;
      continue;
    }
    // Fail closed on anything else. Be honest about what this is: against the
    // store's current WHERE clause it is UNREACHABLE -- that clause admits only
    // `dock`, `jump` and `travel_to`, the two moves are consumed above, and the
    // production snapshot confirms it (0 rows reach this line across 15,244).
    // It is a SEAM CONTRACT, not a live guard, and it earns its line as one:
    // this is an exported pure function whose input is a plain row array, so
    // callers other than dockTrail can and do supply it (the tests below drive
    // it directly), and "not a move, therefore a dock" would be an unchecked
    // assumption about a caller this function cannot see.
    //
    // It is also the coupling that makes the store's action list safe to widen.
    // Add `travel` to that IN list and 2,163 production rows arrive here and are
    // discarded, leaving the derived map byte-identical -- measured. Without
    // this line they would be read as docks. What is NOT safe is teaching the
    // move branch above about `travel`; see the test that pins it.
    if (row.action !== "dock") continue;
    if (!succeeded) continue;
    // No known position: either nothing was ever reported, or a move cleared it.
    // Both mean the same thing here -- drop the dock, never guess a system.
    if (!position) continue;
    const station = dockedStationName(typeof row.result === "string" ? row.result : undefined);
    if (!station) continue;
    // Last dock in a system wins, same as rememberStation: one record per
    // system, carrying the most recently confirmed name.
    bySystem.set(position, { systemId: position, station, services: [], lastSeen: row.ts });
  }
  return [...bySystem.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

function evictOldest(sightings: Map<string, StationSighting>): void {
  while (sightings.size > MAX_STATION_SIGHTINGS) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of sightings) {
      if (v.lastSeen < oldestTs) { oldestTs = v.lastSeen; oldestKey = k; }
    }
    if (oldestKey === undefined) return;
    sightings.delete(oldestKey);
  }
}

/**
 * The destination shortlist for the digest: confirmed station systems, most
 * recently confirmed first, EXCLUDING the system the pilot is in right now.
 *
 * The exclusion is the point of the list -- it exists to answer "where do I go
 * from here", and where you already are is not a destination (the executor's
 * travel_to already short-circuits a no-op move; offering it as a candidate
 * would just invite a wasted step).
 */
export function knownStationSystems(
  sightings: Map<string, StationSighting>,
  currentSystemId?: string | null,
): StationSighting[] {
  // No cap here. The map is already bounded twice -- evictOldest on every
  // write, the SQL LIMIT on every reload -- so a third `.slice(0, MAX)` could
  // never bind. Before the cap tests below existed, raising the SQL limit to
  // 100 left the whole suite green -- that is what exposed the redundancy; the
  // suite catches it now. An unreachable guard makes the
  // reachable one untestable; the same redundant-trim shape was deleted from
  // the constructor last round for the same reason.
  return [...sightings.values()]
    .filter((s) => s.systemId !== currentSystemId)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    // Copies, not the live records (PR #18 review, F6). rememberStation mutates
    // entries in place, so handing out references makes the returned list a
    // window onto memory that keeps changing under whoever holds it -- the
    // PlanContext the planner was given, the payload an eval replays. Nothing
    // exploits that today; the copy costs one allocation per replan and removes
    // the whole class. `services` is copied too: a shallow spread would share
    // the array that push() mutates.
    .map((s) => ({ ...s, services: [...s.services] }));
}
