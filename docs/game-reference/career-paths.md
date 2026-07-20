<!--
  Provenance: synthesized by us from the game's own playstyle guides (upstream/guides/*.md),
  progression.md's ship ladders, and commands.md's ✅/⬜ registration column. Every ladder number
  and end-state claim below is cited to a guide file; nothing here is invented. Captured/written
  2026-07-14. Refresh alongside progression.md — same refresh script, same staleness risk.
-->

# Career paths — the full capability map

**What this answers:** if a pilot commits to a playstyle, what does it climb toward, what does it
need from our harness to climb, and what's the smallest fix that unblocks the next rung? This is
the catalog operator directive 2026-07-14 asked for — every path the game documents, mapped to
what we've registered and what we haven't — so persona decisions and backlog priority are read
off a map instead of guessed.

**Source discipline.** Every ladder table below is transcribed from the game's own guide (cited
per section). Every ✅/⬜ call is read from [`commands.md`](commands.md), which is itself generated
from `src/registry/actions.ts` — so the gap columns here cannot drift from the code without
someone noticing. Where a guide is silent on a number (e.g. exact facility rent, exact combat
damage formulas), this doc says so and names what a `get_guide`/`catalog` live capture would
settle, rather than filling the gap with a guess (the L-16 discipline this whole reference exists
to enforce).

**The ten paths.** [`progression.md`](progression.md)'s "where each playstyle ends up" table names
ten guides as distinct career paths (the other two vendored guides, `fuel.md` and `client-dev.md`,
are cross-cutting reference and dev-integration material, not playstyles — they don't get an
end-state section here). In the order they appear there: Miner, Crafter, Trader, Arbitrage/Hauler,
Explorer, Base Builder, Drone Pilot, Mission Runner, Passenger Carrier, Pirate Hunter.

---

## 1. Miner — *live persona #1 (Rockhopper Kess)*

**End-state** (per [miner.md](upstream/guides/miner.md)): "command industrial mining fleets" —
deep-core deposits, a refining pipeline (ore → steel/circuits/alloys sold at 2–5× the raw price),
T3 Deep Survey hull. The guide is blunt that raw ore sales are the *floor*, not the plan: "Don't
just sell raw ore to NPCs... you'll make 10x more from one mission" and refining is the "big
profit boost."

**Ladder** (verbatim, miner.md):

| Tier | Ship | Cost | Cargo | Gate |
|---|---|---|---|---|
| T0 | Starter | Free | 50 | — |
| T1 | Archimedes | 2,200cr | 185 | — |
| T2 | Excavation | 8,000cr | 250 | `piloting 10` |
| T3 | Deep Survey | 30,000cr | 660 | `piloting 20` |

| Laser | Cost | Effect | Gate |
|---|---|---|---|
| Mining Laser I | 150cr | baseline | none |
| Mining Laser II | 500cr | 2.4× | `mining 2` |
| Mining Laser III | 1,500cr | 2.2× over II | `mining 4` |

Deep-core mining (rarer, higher-value ore) gates on `mining 5` + `survey_system` to find the
deposits. Refining runs at any Station Workshop (skill-scaled ×1–×3) or a facility (tier-scaled
×1/×3/×9/×27) — see [crafting.md](upstream/guides/crafting.md).

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `mine`, `sell`, `travel`, `dock`/`undock`, `get_missions`/`accept_mission`/`complete_mission`, `create_sell_order`, `refuel` | ✅ | the base loop, already live |
| `get_ship` | ✅ | read fitted laser's `mining_power` + hull CPU/power budget before buying a module (miner.md's own deposit-richness check needs this) |
| `spacemolt_catalog` | ✅ | look up ship/module/recipe ids and prices — the ONLY way to find what to buy without guessing an id |
| `browse_ships`, `buy_listed_ship` (spacemolt_ship) | ✅ | the T1→T3 hull ladder |
| `install_mod`, `uninstall_mod` | ✅ | the laser ladder (I→II→III) and Cargo Expander I/II |
| `survey_system` | ⬜ | deep-core deposit discovery (mining 5+ content) |
| `craft`, `recycle` (facility-gated recipes: `refine_steel`, `forge_titanium_alloy`, `fabricate_circuit_boards`) | ⬜ | the guide's "big profit boost" — refining ore before selling |
| `storage` (deposit/withdraw) | ⬜ | crafting reads from *station storage*, not cargo — this is the precondition for every craft |

**Critical path (first rung, per #107's live-costed proposal):** `browse_ships` + `buy_listed_ship`
+ `install_mod` + `get_ship` + `spacemolt_catalog` — **REGISTERED, #219 / PR #235.** These five
were the literal blocker behind #107/#216: the pilot had 17.3k credits, had cleared both the Deep
Core Extractor Mk I (~3,000cr) and Mining Laser III (~8,000cr, mining 4) thresholds, and could not
execute either purchase because no action in the registry could browse a shipyard or fit a module.

**Unknowns a capture would settle:** (1) whether `spacemolt_catalog`'s `cpu_usage`/`power_usage`
for a module are the RAW figures or already discounted by the pilot's Engineering skill (1%/level;
[ships.md](upstream/docs/ships.md) says `get_ship` and `install_mod` show the discounted number but
is silent on the catalog). The capture: `get_ship`'s reported usage for a module already fitted by
a pilot with Engineering > 0, next to `spacemolt_catalog(type:items, id=<that module>)`. Until then
the executor's fit guard blocks only on the module's cost *floor* — the smallest value the live
cost could take under either reading — so it cannot refuse a legal install. (2) There is no
`dry_run` on `install_mod` the way `craft` has one (ASSUMED-none, no capture yet), which is why the
guard is client-side at all.

---

## 2. Explorer — *live persona #2 (per the gate map, #159)*

**End-state** ([explorer.md](upstream/guides/explorer.md)): "map distant systems, find what nobody
has surveyed" — wormhole traversal, prestige galaxy-spanning circuits (Five Empire Tour, The Long
Haul), deep survey work. "The galaxy has ~500 star systems. Most players never leave their home
region."

**Ladder** (verbatim, explorer.md):

| Tier | Ship | Cost | Speed | Cargo | Slots |
|---|---|---|---|---|---|
| T0 | Starter | Free | 2 | 50 | 2–3 |
| T1 | Lemma (Scout) | 2,100cr | 5 | 30 | 3 |
| T1 | Principia (Shuttle) | 1,800cr | 3 | 60 | 4 |
| T2 | Hypothesis (Explorer) | 10,000cr | 3 | 135 | 4 |
| T3 | Perigee (Expedition) | 42,000cr | 2 | 270 | 6 |

Skill gates: `exploration` unlocks T2 hulls, `exploration 5` unlocks T3; `stealth 1` needs
`scanning 3` first. Modules: Afterburner I (400cr, +1 speed) → II (1,200cr, `navigation 2`);
Scanner I (500cr) → II (1,500cr, `scanning 2`); Cloaking Device I (2,000cr).

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `jump`, `travel`, `get_system`, `get_poi`, `find_route`, `get_nearby`, `get_missions`/`accept`/`complete` | ✅ | the base loop, already live |
| `browse_ships`, `buy_listed_ship`, `install_mod` | ✅ | **the same gap as the miner** — Lemma/Hypothesis purchase, Afterburner/Scanner/Cloak fit |
| `survey_system` | ⬜ | the guide's endgame content — hidden POIs and deep-core deposits |
| `get_map` | ⬜ | "view all star systems in the galaxy" — the actual map, vs. our current one-hop-at-a-time `get_system` walk |
| `search_systems` | ⬜ | find a named system instead of walking the graph |
| `cloak` | ⬜ | safety in unpoliced space — explorer.md calls invisibility "your best defense" |
| `get_system_agents` | ⬜ | who else is in-system (situational awareness the guide assumes) |

**Critical path (first rung):** shares the ship-tool gap with the miner exactly — `browse_ships`
+ `buy_listed_ship` + `install_mod` unlocks Lemma/Principia + Afterburner I in one wave. Explorer's
*second* rung (`survey_system`, `get_map`, `search_systems`) is genuinely explorer-specific and
doesn't overlap with any other path's critical path.

**Unknowns:** the exact fuel cost of a multi-jump route beyond what `find_route` estimates — see
[fuel.md](upstream/guides/fuel.md), not captured in depth for this doc since it's cross-cutting
reference, not a playstyle.

---

## 3. Crafter

**End-state** ([crafting.md](upstream/guides/crafting.md)): run production at scale — tier-4
facilities running 27× faster than a tier-1 of the same chain, feeding shipyards and other
players' facilities with intermediates, "not a vending machine" but a real job-queue economy with
escrow and rent.

**Ladder:** no ship table in this guide (crafting is venue-based, not hull-based) — the three
venues *are* the ladder: Station Workshop (free, skill-scaled ×1–×3, so a maxed-skill Workshop is
only ~9× slower than a tier-4 facility, not 27×) → own/rented facility tier 1 (×1) → tier 2 (×3) →
tier 3 (×9) → tier 4 (×27, this multiplier is tier-to-tier, not facility-to-Workshop). Tiers cost
roughly ×3 each to build. Facilities bill rent every cycle regardless of use.

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `craft`, `recycle` | ⬜ | the entire mechanic — queue a job, get notified on completion |
| `storage` (deposit/withdraw/view) | ⬜ | crafting's inputs/outputs live in station storage, never cargo |
| `spacemolt_catalog` (`type=recipes`) | ✅ | discover what a recipe needs/yields — required before queuing anything real |
| `spacemolt_facility` (build/upgrade/job_add/job_list/set_output_price/set_access) | ⬜ | own a facility once Workshop-scale isn't enough |
| `sell`, `create_sell_order` | ✅ | already live — sell the output |

**Critical path (first rung):** `craft` + `storage` (deposit/withdraw) + `spacemolt_catalog`. Three
actions unlock the entire Station-Workshop tier — no facility needed. This is the smallest
career-path unlock in this catalog, and it's the miner's own documented "big profit boost" rung.

**Harness work beyond registration:** crafting is the one mechanic in this entire catalog with a
genuinely new *shape* — every action we've registered so far resolves within the tick it's issued
(or the transient-block wait pattern, M-12, for at most a few ticks of travel). A `craft` job runs
over many ticks and completes via an async `crafting_update` notification the harness must
correlate back to the job it started — closer to "fire a job, get paged later" than "issue a
command, read the result." The guide is explicit that re-issuing because "nothing happened yet"
double-spends materials — a distinct failure mode our stall-watcher's wait-in-transit logic
doesn't already cover (that pattern is bounded to a few ticks; a craft job can run much longer).

---

## 4. Trader

**End-state** ([trader.md](upstream/guides/trader.md)): "bulk freight on known routes" — cargo
capacity, not speed, is the trader's whole game. T3 Compendium bulk hauler, 500,000+ credits.

**Ladder** (verbatim, trader.md):

| Tier | Ship | Cost | Cargo | Speed |
|---|---|---|---|---|
| T0 | Starter | Free | 50 | 2 |
| T1 | Principia (Shuttle) | 1,800cr | 60 | 3 |
| T2 | Meridian (Freighter) | 7,000cr | 265 | 2 |
| T3 | Compendium (Bulk Hauler) | 32,000cr | 625 | 1 |

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `view_market`, `view_orders`, `analyze_market`, `buy`, `sell`, `create_sell_order`, `get_missions`/`accept`/`complete` | ✅ | delivery-mission loop and the sell side of arbitrage, already live |
| `browse_ships`, `buy_listed_ship` | ✅ | the Meridian upgrade — "the real trading ship," 3× the cargo of the starter |
| `create_buy_order` | ⬜ | the *buy* side of the order book — post a standing bid instead of only reading asks |
| `estimate_purchase` | ⬜ | preview a bulk buy's real cost before committing (the guide's own anti-"1-credit trap" advice, mirrored on the buy side) |
| `cancel_order`, `modify_order` | ⬜ | manage a standing order once placed |
| `subscribe_market`/`unsubscribe_market` | ⬜ | live order-book stream instead of polling `view_market` |

**Critical path (first rung):** delivery missions are ALREADY fully reachable — this path's
"safest, easiest" income stream (the guide's own words) needs nothing new. The genuine gap is
arbitrage: `create_buy_order` + `estimate_purchase` unlocks buying (not just selling), which is the
other half of "buy low, sell high." Ship upgrade (Meridian) shares the miner/explorer ship-tool gap.

---

## 5. Arbitrage / Hauler

**End-state** ([arbitrage.md](upstream/guides/arbitrage.md)): market-making — quoting both sides of
a station's book, alts parked at hubs as a standing presence, faction trade ledgers feeding a route
board. Explicitly the trader's "graduate" path once buy-low-sell-high becomes the main income.

**Ladder:** shares the trader's ship progression (same hulls, arbitrage.md defers to trader.md).

**Tools required:** identical gap to Trader above (`create_buy_order`, `estimate_purchase`,
`cancel_order`, `modify_order`, `subscribe_market`) — this guide is explicitly the advanced
continuation of the same mechanic, not a separate tool surface. One addition:

| Action | Status | Role |
|---|---|---|
| `query_trade_intel`/`submit_trade_intel` (spacemolt_intel) | ⬜ | faction-scale price-map sharing — the guide's endgame ("a faction of scouts sees the whole board") |

**Critical path:** identical to Trader's — `create_buy_order` + `estimate_purchase` is the same
five-line fix that unblocks both guides at once, since they share one mechanic.

---

## 6. Base Builder

**End-state** ([base-builder.md](upstream/guides/base-builder.md)): "establish personal and faction
facilities at stations... eventually command an industrial network that generates passive income"
— a distributed production network, a 20+ member faction, facilities across empires. Explicitly
the slowest, highest-ceiling path: "This path is slower than mining or trading but scales to
impressive size." (The literal phrase "found a faction station in lawless space" is
`commands.md`'s description of the `found_station` action, not base-builder.md's own words — the
guide's Phase 3 covers the same ground as "create a faction," not that specific action.)

**Ladder:** capital gates, not ship gates — Crew Bunk (10,000cr), Faction Lockbox (200,000cr),
Hiring Board (75,000cr), Market Runner (150,000cr), Mission Board (50,000cr), Intel Terminal
(150,000cr), Trade Ledger (200,000cr). The guide's own grinding summary puts the first faction
facility at Day 5–10 and calls the 6-month goal "aspirational."

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `facility` (`personal_build`, `build`, `types`, `upgrade`, all 48 actions) | ⬜ | the entire mechanic — personal quarters, production, faction facilities |
| `faction` (`create`, `invite`, `join`, `leave`, `list`, all 28 actions) | ⬜ | founding and running the faction itself |
| `faction_admin` (`create_role`, `edit`, `post_mission`, all 6 actions) | ⬜ | faction governance |
| `faction_commerce` (`create_buy_order`, `create_sell_order`, faction-backed) | ⬜ | faction treasury trading |
| `storage` (faction deposit/withdraw, buckets) | ⬜ | shared vault mechanics |

**Critical path (first rung):** `facility action=personal_build` + `spacemolt_faction action=create`
— two actions get a pilot from "has credits" to "has quarters and a faction," which is the guide's
own Phase 1→3. Everything past that (production facilities, Storage Extensions, faction ops
buildings) is the same `facility`/`faction` tool surface at greater scale, not new actions.

**This is the heaviest lift in the catalog** — 84 unregistered actions across four tools, a
30,000–200,000cr capital requirement, and a genuinely multi-agent end-state (the guide says
outright: "building an industrial empire isn't a solo activity"). Cataloged in full; not a
near-term persona candidate for that reason (see §Fleet personas below).

---

## 7. Drone Pilot

**End-state** ([drones.md](upstream/guides/drones.md)): autonomous drone fleets running DroneLang
scripts — mining while you sleep, salvage fields worked unattended, a combat drone camping a
chokepoint. "The only autonomous units in SpaceMolt... every other action requires you to issue a
command." Carrier-class hulls (5–8 utility slots) stacking multiple drone bays; `drone_control`
skill caps at level 20 (+40% damage/mining yield/repair rate at max).

**Ladder:** bay-module driven, not hull-tiered in the usual sense — Light Drone Bay (tier 2,
capacity 2/bandwidth 25, `drone_control 1`) → Combat Drone Bay (tier 3, 3/50) → Advanced Drone Bay
(tier 4, 5/80, `drone_control 3`). Ten dedicated carrier hulls exist across the five empires
(5–8 utility slots each) once a pilot outgrows a starter's 2–3 slots.

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `spacemolt_drone` (`load`, `deploy`, `recall`, `unload`, `upload` [DroneLang script], `get`, `list`) — all 8 | ⬜ | the entire mechanic |
| `install_mod` (drone bay modules) | ✅ | shared ship-tool gap |
| `browse_ships`, `buy_listed_ship` (carrier hulls) | ✅ | shared ship-tool gap |

**Critical path (first rung):** `load_drone` + `deploy_drone` + `upload_drone_script` +
`get_drones`/`get_drone` (4–5 actions) plus `install_mod` for the Light Drone Bay. DroneLang itself
(the scripting language a deployed drone runs) is entirely outside our registry's concern — it's
a payload string the game's own interpreter executes, not an action our planner calls repeatedly.
Registering `upload_drone_script` is a one-time wiring; writing good DroneLang scripts is a
planning-time content problem, not a registration gap.

**Why this is cataloged but not detailed further as a near-term build:** a whole "sub-game" (the
guide's own description) with its own scripting language, three independent capacity limits, and
five drone types each with a distinct action set. High standalone learning value, but the
prerequisite ship-tool gap it shares with every other path should land first.

---

## 8. Mission Runner

**End-state** ([mission-runner.md](upstream/guides/mission-runner.md)): "the career with the least
guesswork" — 5 mission slots kept full along one route, empire storyline chains and multi-capital
circuits as the spine, distress rescues as a side income ("the paid samaritan").

**Ladder:** no ship tier of its own — "a mission runner wants a generalist... a T2 freighter with
a weapon mount covers 90% of boards," i.e. it borrows the trader's Meridian.

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `get_missions`, `accept_mission`, `get_active_missions`, `complete_mission`, `abandon_mission`, `distress_signal` | ✅ | **the entire core loop is already live** (#124/M-27, #147/#156/M-28) |
| `decline_mission` | ⬜ | politeness/flavor only — no penalty either way per the guide |
| `completed_missions`, `view_completed_mission` | ⬜ | historical record — QoL, not a blocker |
| `get_chat_history` (emergency channel) | ⬜ | reviewing recent MAYDAYs — QoL |
| `refuel target=<player>` (ship-to-ship) | ⚠️ **name registered, `target` param is not** | the rescue-economy half of this path — see note below |

**A registry-level gap the ✅ symbol hides.** `commands.md` marks `refuel` ✅ because the action
*name* is wired, but `src/registry/actions.ts` currently registers it with `params: none` —
zero fields — while the game's own schema takes `id?`/`quantity?`/`target?`. So even once
`install_mod` lands and a pilot fits a Refueling Pump, a ship-to-ship `refuel target=<player>`
call still can't be issued through our harness; the registry needs its own small schema widening,
independent of any of the epics filed alongside this doc. Caught by independent review of this
cartography, not by the ✅/⬜ column alone — a reminder that the column answers "is the name
registered," not "is every param the game accepts actually wired."

**Critical path:** the closest thing to "none" in this catalog — the funnel this project already
built (missions_completed 1→3, M-27/M-28) *is* the mission runner's core loop, and every gap above
is either cosmetic (decline/completed-missions history) or shared with another path (`install_mod`
for the cabin/pump modules). The one exception is the `refuel` param gap just above, which is a
small, self-contained fix, not a new-capability project. Rejected as a fleet-persona candidate
because the core loop teaches nothing new we haven't already built and verified.

---

## 9. Passenger Carrier

**End-state** ([passenger-lines.md](upstream/guides/passenger-lines.md)): a full "airline game" —
hub-and-spoke faction networks, Transit Lounges/Terminals/Concourses, feeder and long-haul pilot
roles, layover revenue at faction-owned bars. "You can fly it solo as a space taxi or build a
faction airline with a departure board."

**Ladder:** cabin-module driven — Economy Passenger Cabin (6,000cr, 12 berths) → Business
(22,000cr, 6 berths) → First-Class Suite (75,000cr, 3 berths; the only class that earns empire
standing). Faction infrastructure: Transit Lounge (L1, 20 passengers) → Terminal (L2, 60,
+180 tick deadline extension) → Concourse (L3, 150, +360 ticks).

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `list_station_passengers`, `load_passenger`, `list_passengers`, `unload_passenger` | ⬜ | the entire mechanic |
| `install_mod` (cabin modules) | ✅ | shared ship-tool gap |
| `spacemolt_facility` (Transit Lounge/Terminal/Concourse) | ⬜ | shared facility gap with Base Builder, for the faction-airline endgame only |

**Critical path (first rung):** `list_station_passengers` + `load_passenger` + `unload_passenger`
+ `install_mod` (Economy Cabin) — four actions for the solo space-taxi loop described in the
guide's own Day 1. The hub-and-spoke faction airline is a much later rung sharing Base Builder's
facility gap.

---

## 10. Pirate Hunter

**End-state** ([pirate-hunter.md](upstream/guides/pirate-hunter.md)): tiered bounty hunting —
Tier-1 through Tier-3 pirates, stronghold raid mission chains, T3 Quorum cruiser, wreck salvage as
bonus income.

**Ladder** (verbatim, pirate-hunter.md):

| Tier | Ship | Cost | Hull | Weapon slots |
|---|---|---|---|---|
| T0 | Starter | Free | 100 | 1 |
| T1 | Axiom (Fighter) | 2,500cr | 130 | 2 |
| T2 | Theorem (Heavy Fighter) | 8,000cr | 200 | 3 |
| T3 | Quorum (Cruiser) | 35,000cr | 500 | 4 |

Weapons: Pulse Laser I (200cr) → II (600cr, `weapons 2`) → III (1,800cr, `weapons 4`). Defense:
Shield Booster I/II/III (300/900/2,500cr), Armor Plate I/II (200/600cr).

**Tools required:**

| Action | Status | Role |
|---|---|---|
| `attack`, `scan`, `get_nearby`, `get_missions`/`accept`/`complete`, `distress_signal` | ✅ | initiating a fight and the bounty-mission loop are already live |
| `spacemolt_battle` (`advance`, `engage`, `retreat`, `stance`, `target`, `status`, `log`, `summary`, `reload`) — all 9 | ⬜ | **battle *management* once a fight starts** — the guide's flee-and-monitor loop (`get_ship` between ticks, `travel` to flee) may be a workaround for a tool that was never wired, not the intended interface |
| `hunt` | ⬜ | wildlife-creature combat (distinct from `attack`, which targets players/pirates/NPCs) |
| `spacemolt_salvage` (`loot`, `wrecks`, `scrap`, `sell`, `insure`, `quote`, `policies`) | ⬜ | wreck looting and the insurance safety net the guide insists on before every risky hunt |
| `install_mod` (weapons/shields/armor) | ✅ | shared ship-tool gap |
| `browse_ships`, `buy_listed_ship` (Axiom/Theorem/Quorum) | ✅ | shared ship-tool gap |

**Critical path (first rung):** `spacemolt_battle` (at minimum `status`, `advance`, `retreat`,
`stance`) + `install_mod` (weapon/shield) + `browse_ships`/`buy_listed_ship`. Combat is the one path
whose core loop tool (`spacemolt_battle`) is **entirely unregistered, 0 of 9** — a clean, isolated
capability cluster, but also the one whose failure mode (ship destruction, cargo lost to a wreck)
is catastrophic and irreversible in a way no other unregistered path is.

---

## The shared bottleneck

Every ladder above runs through the same three tool clusters at its first or second rung:

1. **`spacemolt_ship`** (browse/buy/switch/fit a hull) + `install_mod`/`uninstall_mod` — blocked
   Miner, Explorer, Trader, Pirate Hunter, Drone Pilot, and Passenger Carrier identically. This was
   the P1 finding: one registration wave unblocks six of ten paths' first rung simultaneously.
   **CLEARED — #219 / PR #235** registered `browse_ships`, `buy_listed_ship`, `install_mod`,
   `uninstall_mod`, `get_ship`. (`switch_ship` is still unregistered.)
2. **`spacemolt_catalog`** — the only way to discover a ship/module/recipe's id and price without
   guessing. Every path that needs to buy anything needs this. **CLEARED — #219 / PR #235.**
3. **`spacemolt_facility`** — blocks Crafter (tier-2+), Base Builder (all of it), and Passenger
   Carrier's faction-airline endgame.

---

## What this catalog changes about existing assumptions

- **#159 named Explorer and Smuggler as the "one more" candidates.** "Smuggler" is not one of the
  ten guide-named paths — the closest concept in the actual guides is Arbitrage's "contraband and
  manifests... a later concern" (one paragraph) and Mission Runner's "smuggling jobs" (one bullet).
  There is no dedicated Smuggler guide, ladder, or end-state to cite. If a Smuggler persona is
  still wanted, it would need to be assembled from Trader + Arbitrage + Mission-Runner fragments
  rather than pointed at one authoritative guide — worth flagging back to #159 before committing.
- **Mission Runner needs nothing new.** The existing funnel (#124/M-27, #147/#156/M-28) already
  *is* this career path's complete core loop. Any future "mission runner persona" would be a
  briefing/persona-prompt change, not a capability-registration project.
- **#215's root cause is a briefing gap, not a capability gap.** `create_sell_order` is already ✅
  registered; the pilot's 0 lifetime uses is a digest-surfacing problem (the action isn't briefed
  concretely at the moment it's needed), not something this catalog's ⬜ column can fix. Flagged so
  the epics below don't accidentally claim credit for #215's fix.
- **`refuel`'s ✅ mark hides a registry-level gap.** Independent review of this doc caught it: the
  action name is registered but with `params: none`, so the `target` param a ship-to-ship rescue
  needs (Mission Runner §8) isn't actually callable. Filed as its own small issue (#233), separate
  from every epic below, since it's a one-line schema fix, not a new-capability project.

---

## Epics and issues filed from this catalog (2026-07-14)

| # | Title | Priority | Unblocks |
|---|---|---|---|
| [#219](https://github.com/Cringely/spacemolt/issues/219) | EPIC: Ship tool — buy, fit, switch hulls | P1 | Miner §1, Explorer §2, shared bottleneck §1 above |
| [#220](https://github.com/Cringely/spacemolt/issues/220) | EPIC: Market buy-side (create_buy_order, estimate_purchase) | P2 | Trader §4, Arbitrage §5 |
| [#221](https://github.com/Cringely/spacemolt/issues/221) | EPIC: Crafting & refining loop | P2 | Crafter §3, Miner's refining rung |
| [#222](https://github.com/Cringely/spacemolt/issues/222) | EPIC: Explorer's second rung (survey/map/cloak) | P2 | Explorer §2 |
| [#223](https://github.com/Cringely/spacemolt/issues/223) | EPIC: Combat & battle management | P3 | Pirate Hunter §10 |
| [#224](https://github.com/Cringely/spacemolt/issues/224) | EPIC: Salvage, wrecks & insurance | P3 | Pirate Hunter §10 |
| [#225](https://github.com/Cringely/spacemolt/issues/225) | EPIC: Drone autonomy | P3 | Drone Pilot §7 |
| [#226](https://github.com/Cringely/spacemolt/issues/226) | EPIC: Faction & facility empire | P3 (size:XL) | Base Builder §6 |
| [#227](https://github.com/Cringely/spacemolt/issues/227) | EPIC: Passenger transit | P3 | Passenger Carrier §9 |
| [#228](https://github.com/Cringely/spacemolt/issues/228) | EPIC: Fleet coordination (spacemolt_fleet) | P3 | our own multi-pilot fleet, not a guide path |
| [#229](https://github.com/Cringely/spacemolt/issues/229) | Intel & espionage | P3 | Arbitrage §5, Explorer §2 (small, not an epic) |
| [#230](https://github.com/Cringely/spacemolt/issues/230) | Citizenship & empire relations | P3 | cross-cutting reputation (small, not an epic) |
| [#231](https://github.com/Cringely/spacemolt/issues/231) | Social extras | P3 | roleplay/QoL (small, not an epic) |
| [#232](https://github.com/Cringely/spacemolt/issues/232) | Player transfer & storage gifting | P3 | Arbitrage §5, Base Builder §6 (small, not an epic) |
| [#233](https://github.com/Cringely/spacemolt/issues/233) | `refuel` registry gap (target param missing) | P2 | Mission Runner §8 — bug, not an epic |

Persona-#3 recommendation (Crafter, with the counter-argument for Pirate Hunter) posted to #159
rather than duplicated here, since #159 is the fleet-persona decision's home issue.

---

## Sources

[`progression.md`](progression.md), [`commands.md`](commands.md), and every guide under
[`upstream/guides/`](upstream/guides/) cited inline above. Ship/module costs are the guides' own
numbers (themselves sourced from `catalog.json`, per #107's proposal) — not independently
re-verified against a live capture for this pass; a `spacemolt_catalog` probe once that action is
registered is the way to confirm prices haven't drifted since doc_version 0.2 (all guides carry
`last_updated: 2018-10-20`, which reads as a template placeholder rather than a real capture date —
flagged as a genuine unknown, not silently trusted).
