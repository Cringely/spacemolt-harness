<!--
  Provenance: distilled from the game's own playstyle guides, vendored verbatim at
  upstream/guides/*.md (source: https://www.spacemolt.com/docs/guides/<name>.md).
  Captured 2026-07-13. Refresh: bun run scripts/refresh-game-reference.ts --live, then
  re-check the ladders below against the refreshed guides.
  Curated by us — the guides are authoritative, this page is a router into them.
-->

# Progression and end-states, per playstyle

Feeds epic #213 (persona-derived goal ladders) and issue #216. The question this page answers:
**if a pilot picks a playstyle, what is it climbing toward?** A goal ladder that isn't anchored
to a real end-state is just a wish list, and until now we had no anchor — our pilot mined, sold
ore, and had nowhere to go, because nobody had read what "somewhere to go" looks like.

The game publishes a guide per playstyle. They are vendored verbatim under
[`upstream/guides/`](upstream/guides/) — that is the authoritative text. This page is a routing
table plus the ladders themselves, so a planner doesn't have to read 130KB of guides to find them.

## The shape every guide shares

Each guide is built the same way, which is itself the useful finding: progression is not one
track but four that pull on each other.

- **Ship tier** — T0 starter → T1 → T2 → T3. The rung you're on sets cargo, speed, and slots.
- **Skills** — mining, refining, navigation, piloting. Gained by playing; they *gate* the next
  ship and the next module (`piloting 10` for a T2 hull, `mining 2` for a Mining Laser II).
- **Modules** — the fit inside the hull. A better laser beats a bigger hull for a miner.
- **Income stream** — what actually pays: raw ore, refined goods, missions, arbitrage, passengers.

The guides are blunt that raw extraction is the *floor*, not the plan. The miner's guide calls
refining a "big profit boost"; the trader's guide says cargo capacity, not speed, is what makes a
trader. Both are ladders our pilot cannot presently climb (see the gaps at the bottom).

## Ship ladders (verbatim from the guides)

**Miner** — [`upstream/guides/miner.md`](upstream/guides/miner.md)

| Tier | Ship | Cost | Cargo | Key feature |
|---|---|---|---|---|
| T0 | Starter | Free | 50 | Just getting started |
| T1 | Archimedes | 2,200 | 185 | 2x cargo, 3 utility slots |
| T2 | Excavation | 8,000 | 250 | Industrial rig, 4 utility slots |
| T3 | Deep Survey | 30,000 | 660 | Massive cargo, 6 utility slots |

Lasers climb alongside: Mining Laser I (free-ish, 150cr) → II (needs `mining 2`, 2.4x better,
500cr) → III (needs `mining 4`, 1,500cr). Skills gate: `mining 5` unlocks deep-core mining,
`piloting 10` the T2 hull, `piloting 20` T3 industrials.

**Trader** — [`upstream/guides/trader.md`](upstream/guides/trader.md)

| Tier | Ship | Cost | Cargo | Speed | Best for |
|---|---|---|---|---|---|
| T0 | Starter | Free | 50 | 2 | Learning |
| T1 | Principia (Shuttle) | 1,800 | 60 | 3 | Budget option (limited cargo) |
| T2 | Meridian (Freighter) | 7,000 | 265 | 2 | The real trading ship |
| T3 | Compendium (Bulk Hauler) | 32,000 | 625 | 1 | Endgame freight |

**Explorer** — [`upstream/guides/explorer.md`](upstream/guides/explorer.md)

| Tier | Ship | Cost | Speed | Cargo | Slots |
|---|---|---|---|---|---|
| T0 | Starter | Free | 2 | 50 | 2–3 |
| T1 | Lemma (Scout) | 2,100 | 5 | 30 | 3 |
| T1 | Principia (Shuttle) | 1,800 | 3 | 60 | 4 |
| T2 | Hypothesis (Explorer) | 10,000 | 3 | 135 | 4 |
| T3 | Perigee (Expedition) | 42,000 | 2 | 270 | 6 |

Ladders for the base builder, crafter, drone pilot, pirate hunter, mission runner, and passenger
liner are in their guides; each has its own "Ship Progression" and "Skill Progression" section in
the same shape.

## Where each playstyle ends up

One line per guide, so a persona can be pointed at a destination. Read the guide before wiring
any of these into a goal ladder — the one-liner is a signpost, not the map.

| Playstyle | Guide | End-state it aims at |
|---|---|---|
| Miner | [miner](upstream/guides/miner.md) | Industrial mining fleets; deep-core deposits; refine before you sell |
| Crafter | [crafting](upstream/guides/crafting.md) | Run production: recipes, facilities, feeding shipyards with components |
| Trader | [trader](upstream/guides/trader.md) | Bulk freight on known routes; cargo is the constraint |
| Arbitrage | [arbitrage](upstream/guides/arbitrage.md) | Buy-low/sell-high circuits between station exchanges |
| Explorer | [explorer](upstream/guides/explorer.md) | Map distant systems, find what nobody has surveyed |
| Base builder | [base-builder](upstream/guides/base-builder.md) | Found a faction station in lawless space; own the facilities others use |
| Drone pilot | [drones](upstream/guides/drones.md) | Autonomous drones running DroneLang scripts (26KB of guide — a whole sub-game) |
| Mission runner | [mission-runner](upstream/guides/mission-runner.md) | Mission board as the primary income stream |
| Passenger lines | [passenger-lines](upstream/guides/passenger-lines.md) | Liner-class ships and berths; scheduled transit income |
| Pirate hunter | [pirate-hunter](upstream/guides/pirate-hunter.md) | Bounties and loot; police standing as an asset |

Fuel economics cut across all of them: [`upstream/guides/fuel.md`](upstream/guides/fuel.md) (25KB)
is the reference for what a jump actually costs, which is what makes or breaks a hauling route.

## The uncomfortable part

Every ladder above runs through actions our harness has never registered. Buying the next hull is
`spacemolt_ship.browse_ships` + `buy_listed_ship`; fitting the better laser is
`spacemolt.install_mod`; the refining that turns ore into real money is `spacemolt.craft`.
None of the three are wired (see the ⬜ column in [`commands.md`](commands.md)).

So the honest reading: our pilot is not stuck because it plans badly. It is stuck because it is
standing on the bottom rung of a ladder whose next rung was never built into the harness. That is
the same failure class as #124 and #176 — the capability existed and we never wired it — which is
exactly what this reference exists to stop.
