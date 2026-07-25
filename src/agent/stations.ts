import type { StationSighting } from "../planner/types";

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
// while DOCKED. Sourced from the game's own dock description
// (docs/game-reference/upstream/openapi-v2.json, /api/v2/spacemolt/dock:
// "You must be at a POI with a base. Docking is required for trading,
// refueling, repairs, and ship upgrades.") -- so a docked success of one of
// these is proof the corresponding service exists at that station, no response
// shape assumed and no extra game call made. refuel is the strongest of them
// and the one the live incident needed: the same reference (refuel, mode 3)
// documents "Docked at refuel station with credits -> station refueling",
// which is exactly why the docked guard is load-bearing -- an UNDOCKED refuel
// burns fuel cells from cargo (mode 4) and proves nothing about geography.
export const STATION_SERVICE_BY_ACTION: Record<string, string> = {
  refuel: "refuel",
  sell: "market",
  buy: "market",
  repair: "repair",
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
  // The in-system leg. Learned separately from the dock itself (a replan in
  // that system supplies it, see stationPoiFromSurroundings) and last one wins,
  // for the same reason the name does: a system can hold more than one station.
  if (obs.stationPoiId && obs.stationPoiId !== existing.stationPoiId) {
    existing.stationPoiId = obs.stationPoiId;
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
 * The station POI id for the CURRENT system, read from get_system's structured
 * POI data -- never from arrival prose. Undefined when this system's station
 * cannot be identified without guessing.
 *
 * Two rules, strongest first:
 *   1. DOCKED: the POI you are docked at IS the station. The reference is
 *      unambiguous -- "`dock` requires being at a POI with a base"
 *      (upstream/docs/travel.md:51) -- so no cross-check against the POI list
 *      adds anything here.
 *   2. UNDOCKED with exactly ONE `hasBase` POI in the system: that is the
 *      station, by elimination. (PoiInfo.hasBase is VERIFIED live -- see
 *      client.ts and test/fixtures/spacemolt-probe-2026-07-12.json.)
 * Two or more bases and no dock means the system genuinely has more than one
 * station and nothing here says which we used, so we learn nothing rather than
 * pick one -- a wrong POI id is worse than an absent one, because the digest
 * would route the pilot confidently to the wrong rock.
 *
 * Rule 2 exists because rule 1 needs a replan to happen while still docked. It
 * recovers the id on ANY later pass through the system, including the pass in
 * the live trace: at 01:01 the pilot sat at `aurelia` in gold_run with the hub
 * sitting right there in its own POI list, one field away from the answer it
 * spent the next two minutes rediscovering.
 */
export function stationPoiFromSurroundings(
  pois: Array<{ id: string; hasBase?: boolean }>,
  currentPoiId: string | undefined,
  docked: boolean,
): string | undefined {
  if (docked && currentPoiId) return currentPoiId;
  const bases = pois.filter((p) => p.hasBase);
  return bases.length === 1 ? bases[0]!.id : undefined;
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
  return [...sightings.values()]
    .filter((s) => s.systemId !== currentSystemId)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_STATION_SIGHTINGS);
}
