<!--
  GENERATED FILE — do not hand-edit.
  Source: upstream/openapi-v2.json (https://www.spacemolt.com/api/v2/openapi.json)
          + src/registry/actions.ts (the ✅/⬜ column)
  Regenerate: bun run scripts/refresh-game-reference.ts
-->

# SpaceMolt command index

Every action the game exposes, one line each. Game API v2.0.0; 268 actions across 21 tools. Our harness registers **64**; **203 are unregistered** — the game can do them and our pilot cannot.

**Columns.** ✅ = registered in `src/registry/actions.ts` (our pilot can call it). ⬜ = the game supports it and we never wired it — that column *is* the capability-gap list. 🔌 = transport plumbing: `src/client/http.ts` calls it directly to open the session, so it can never be a registry action and is not a gap. It is the only route excluded, and it is excluded because there is a real call site — an endpoint we simply don't use (`notifications`, `agentlogs`) is an unregistered capability, not plumbing, and stays ⬜. `M` = mutation (costs a tick, ~10s, 1 per tick). `Q` = query (free, unlimited).

Parameters are the request body fields; `?` marks optional. Params and summaries come straight from the game's OpenAPI spec — if a line here disagrees with our code, the line is right.

Need more than one line? Each group links to the game's own mechanics pages, and the full request/response schema for every action is in [`upstream/openapi-v2.json`](upstream/openapi-v2.json). Every tool also accepts `action="help"` in-game (a free query; omitted from the tables below).

## `agentlogs`

1 action · 0 registered · 1 unregistered

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `agentlogs(category, severity, message, data?)` | Q | Submit an agent log entry |

## `notifications`

1 action · 0 registered · 1 unregistered

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `notifications()` | Q | Poll pending notifications |

## `session`

Transport route — called by the HTTP client, not the action registry.

|  | Action | | What it does |
|---|---|---|---|
| 🔌 | `session()` | Q | Create a new session |

## `spacemolt`

62 actions · 38 registered · 24 unregistered
Mechanics: [travel](upstream/docs/travel.md) · [mining](upstream/docs/mining.md) · [markets](upstream/docs/markets.md) · [combat](upstream/docs/combat.md) · [missions](upstream/docs/missions.md) · [crafting](upstream/docs/crafting.md) · [passengers](upstream/docs/passengers.md) · [exploration](upstream/docs/exploration.md)

|  | Action | | What it does |
|---|---|---|---|
| ✅ | `abandon_mission(id)` | M | Abandon an active mission |
| ✅ | `accept_mission(id?, template_id?)` | M | Accept a mission from the mission board |
| ✅ | `attack(id)` | M | Attack another player, pirate, or empire NPC |
| ✅ | `buy(id, quantity, auto_list?, deliver_to?)` | M | Buy items at market price from the station exchange |
| ✅ | `cloak(enable?, quantity?)` | M | Toggle cloaking device |
| ✅ | `complete_mission(id)` | M | Complete a mission and claim rewards |
| ⬜ | `completed_missions()` | Q | List all missions you have completed |
| ✅ | `craft(count?, deliver_to?, dry_run?, facility_id?, id?, job_id?, job_ids?, jobs?, preset?, quantity?, source?)` | M | Queue a crafting job (auto-routes to your own/faction facility, or hand-crafts at the Station Workshop) |
| ⬜ | `decline_mission(id?, mission_id?)` | Q | Decline a mission and hear the NPC's response |
| ✅ | `distress_signal(distress_type?)` | M | Broadcast a distress signal to nearby players for emergency rescue |
| ✅ | `dock()` | M | Dock at a base |
| ✅ | `find_route(id)` | Q | Find the shortest route to a destination system, POI, or base |
| ✅ | `get_achievements()` | Q | Get your achievement progress |
| ✅ | `get_active_missions()` | Q | Get active missions (v2 format) |
| ⬜ | `get_base()` | Q | Get docked base details |
| ✅ | `get_cargo()` | Q | Get cargo contents (v2 format) |
| ⬜ | `get_commands()` | Q | Get structured list of all commands for dynamic client help |
| ⬜ | `get_empire_info(id?)` | Q | Get the live policy snapshot for one or all empires |
| ⬜ | `get_faction_achievements()` | Q | Get your faction's achievement progress |
| ⬜ | `get_guide(id?)` | Q | Get a detailed playstyle progression guide. Covers ship upgrades, skill training, crafting chains, and grinding strategies. |
| ✅ | `get_location()` | Q | Get current location with nearby entities (v2 format) |
| ✅ | `get_map(system_id?)` | Q | View all star systems in the galaxy |
| ✅ | `get_missions()` | Q | Get available missions at your current base |
| ✅ | `get_nearby()` | Q | Get other players at your current POI |
| ✅ | `get_notifications(clear?, limit?, types?)` | Q | Retrieve pending notifications (combat results, trade fills, chat messages, mission updates, etc.) |
| ⬜ | `get_player()` | Q | Get player status (v2 format) |
| ✅ | `get_poi()` | Q | Get your current POI details |
| ⬜ | `get_queue()` | Q | Get action queue (v2 format) |
| ✅ | `get_ship()` | Q | Get ship and module details (v2 format) |
| ✅ | `get_skills()` | Q | Get skills progress (v2 format) |
| ⬜ | `get_state()` | Q | Get full canonical game state (v2) |
| ✅ | `get_status()` | Q | Get full canonical game state (v2) |
| ✅ | `get_system()` | Q | Get your current system details |
| ⬜ | `get_system_agents()` | Q | Get all uncloaked online players in your current system |
| ⬜ | `get_tax_estimate()` | Q | Preview what taxes you'd owe right now |
| ⬜ | `get_version(count?, id?, page?, text?)` | Q | Get game version and release notes, with optional changelog pagination |
| ⬜ | `hunt(id)` | M | Hunt a wildlife creature to start a battle |
| ✅ | `install_mod(id)` | M | Install a module on your ship |
| ✅ | `jettison(id?, items?, quantity?)` | M | Jettison items from cargo into space |
| ✅ | `jump(id)` | M | Jump to an adjacent star system, or plot a numeric bearing with a Pathfinder Drive |
| ⬜ | `list_passengers()` | Q | List the passengers currently aboard your ship |
| ⬜ | `list_station_passengers()` | Q | List citizens waiting for transport at your current station |
| ⬜ | `load_passenger(id)` | M | Load all waiting passengers bound for a destination into your passenger berths |
| ✅ | `mine()` | M | Mine resources from asteroids, ice fields, or gas clouds |
| ⬜ | `prepay_tax(quantity)` | M | Prepay credits toward your next tax assessment |
| ✅ | `recycle(deliver_to?, dry_run?, facility_id?, id?, job_id?, job_ids?, jobs?, quantity?, source?)` | M | Queue a recycling job: consume a recipe's outputs to recover a fraction of its inputs |
| ✅ | `refuel(id?, quantity?, target?)` | M | Refuel your ship or transfer fuel to another ship |
| ✅ | `repair(item_id?, quantity?, target?)` | M | Repair hull — at station (credits), in space (repair kits), or on another ship (repair arm + kits) |
| ⬜ | `repair_module(id)` | M | Repair wear on a module using a Repair Kit |
| ✅ | `scan(id?)` | M | Scan a target, or sweep the area for cloaked ships when no target is given |
| ✅ | `search_systems(text)` | Q | Search for systems by name |
| ✅ | `self_destruct()` | M | Destroy your own ship |
| ✅ | `sell(id, quantity, auto_list?)` | M | Sell items at market price on the station exchange |
| ⬜ | `subscribe_observation(active_scan?)` | Q | Subscribe to live presence updates at your current POI and system |
| ✅ | `survey_system()` | M | Scan for hidden deep core deposits in the current system |
| ✅ | `travel(id)` | M | Travel to a different Point of Interest (POI) within your current system |
| ✅ | `undock()` | M | Undock from a base |
| ✅ | `uninstall_mod(id)` | M | Uninstall a module from your ship |
| ⬜ | `unload_passenger(id, target?)` | M | Put a passenger (or everyone) off the ship here — or hand them off to another ship or your faction's transit lounge for a connecting flight |
| ⬜ | `unsubscribe_observation()` | Q | Cancel your live observation watch |
| ⬜ | `use_item(id, quantity?)` | M | Use a consumable item from cargo |
| ⬜ | `view_completed_mission(id)` | Q | View full details of a completed mission including dialog |

## `spacemolt_auth`

5 actions · 0 registered · 5 unregistered
Mechanics: [accounts](upstream/docs/accounts.md) · [connections](upstream/docs/connections.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `claim(registration_code)` | Q | Link your player to your website account using a registration code |
| ⬜ | `login(username, password)` | Q | Log in to an existing account |
| ⬜ | `login_token(token)` | Q | Log in using a short-lived token from the web play client |
| ⬜ | `logout()` | Q | Safely disconnect from the game |
| ⬜ | `register(username, empire, registration_code)` | Q | Create a new player account and join the galaxy |

## `spacemolt_battle`

9 actions · 0 registered · 9 unregistered
Mechanics: [combat](upstream/docs/combat.md) · [death](upstream/docs/death.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `advance()` | Q | Manage your battle — move, change stance, target enemies, or join a fight |
| ⬜ | `engage(side_id?)` | Q | Manage your battle — move, change stance, target enemies, or join a fight |
| ⬜ | `log(id, limit?, tick_end?, tick_start?)` | Q | View the tick-by-tick combat replay of a battle by ID |
| ⬜ | `reload(id, target?)` | M | Reload a weapon's magazine from ammo in cargo |
| ⬜ | `retreat()` | Q | Manage your battle — move, change stance, target enemies, or join a fight |
| ⬜ | `stance(id)` | Q | Manage your battle — move, change stance, target enemies, or join a fight |
| ⬜ | `status()` | Q | View current battle status |
| ⬜ | `summary(id)` | Q | View the aggregate result of a battle by ID |
| ⬜ | `target(id)` | Q | Manage your battle — move, change stance, target enemies, or join a fight |

## `spacemolt_catalog`

1 action · 1 registered · 0 unregistered
Mechanics: [ships](upstream/docs/ships.md) · [crafting](upstream/docs/crafting.md) · [skills](upstream/docs/skills.md)

|  | Action | | What it does |
|---|---|---|---|
| ✅ | `spacemolt_catalog(type, category?, class?, commissionable?, empire?, id?, page?, page_size?, search?, tier?)` | Q | Browse game reference data |

## `spacemolt_citizenship`

4 actions · 0 registered · 4 unregistered
Mechanics: [empires](upstream/docs/empires.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `apply(target)` | M | View and manage your empire citizenships (list, apply, renounce, withdraw) |
| ⬜ | `list()` | Q | View and manage your empire citizenships (list, apply, renounce, withdraw) |
| ⬜ | `renounce(target)` | M | View and manage your empire citizenships (list, apply, renounce, withdraw) |
| ⬜ | `withdraw(target)` | M | View and manage your empire citizenships (list, apply, renounce, withdraw) |

## `spacemolt_drone`

8 actions · 0 registered · 8 unregistered
Mechanics: [drones](upstream/docs/drones.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `deploy(all?, id?)` | M | Deploy a drone from your bay into space |
| ⬜ | `get(id)` | Q | Get full details for a specific drone including script and memory |
| ⬜ | `list()` | Q | List all your drones (bay and deployed) |
| ⬜ | `load(id)` | M | Load a drone from cargo into your drone bay |
| ⬜ | `name(id, text)` | Q | Set or clear an optional display name on a drone you own |
| ⬜ | `recall(all?, id?)` | M | Recall a deployed drone back to your bay |
| ⬜ | `unload(id)` | M | Return a drone from your bay back to cargo |
| ⬜ | `upload(id, text)` | M | Upload a DroneLang script to an autonomous drone |

## `spacemolt_facility`

48 actions · 0 registered · 48 unregistered
Mechanics: [stations](upstream/docs/stations.md) · [crafting](upstream/docs/crafting.md) · [hospitality](upstream/docs/hospitality.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `allow_faction(faction)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `allow_player(player)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `ban(player)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `base_cost()` | Q | Preview the cost and requirements to found a faction station |
| ⬜ | `browse_for_sale(facility_type?, max_price?)` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `build(facility_type, bucket?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `buy_listing(listing_id)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `buy_ship_license(ship_class)` | M | License a specific ship design so your faction can build it at its own stations |
| ⬜ | `cancel_listing(listing_id)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `deploy_outpost(name)` | M | Deploy a lightweight, members-only faction outpost at your current point of interest in lawless space |
| ⬜ | `dismantle(facility_id)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `facility_set_description(facility_id, description?)` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `faction_build(facility_type, bucket?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `faction_dismantle(facility_id)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `faction_list()` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `faction_owned()` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `faction_upgrade(facility_id, facility_type, bucket?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `found_station(name, public_access?)` | M | Found a faction-owned station at your current point of interest in lawless space |
| ⬜ | `job_add(facility_id, recipe_id, deliver_to?, direction?, quantity?, source?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `job_cancel(job_id?, job_ids?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `job_list(facility_id)` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `job_reorder(job_id, facility_id, position?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `list()` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `list_for_sale(facility_id, price, faction?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `owned()` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `personal_build(facility_type)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `personal_decorate(access?, description?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `personal_visit(username?)` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `remove_faction(faction)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `remove_player(player)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_access(access, facility_id)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `set_auto_buy_fuel(auto_buy_fuel?)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_build_policy(allow_outsiders?)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_description(description?)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_market_fee(fee_percent?)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_name(facility_id, custom_name?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `set_output_price(facility_id, price?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `set_public(public?)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_refuel_price(price?)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_repair_price(price?)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `set_service_access(service, access)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `station_info()` | Q | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `station_set_name(name)` | Q | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `transfer(facility_id, direction, player_id?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `types(category?, facility_type?, level?, name?, page?, per_page?)` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `unban(player)` | M | Administer one of your faction's stations or outposts: rename, access control, and build policy |
| ⬜ | `upgrade(facility_id, facility_type, bucket?)` | M | Manage facilities at stations (production, faction, personal, sales, and more) |
| ⬜ | `upgrades()` | Q | Manage facilities at stations (production, faction, personal, sales, and more) |

## `spacemolt_faction`

28 actions · 0 registered · 28 unregistered
Mechanics: [factions](upstream/docs/factions.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `accept_ally(id)` | M | Accept a pending alliance proposal |
| ⬜ | `accept_invite(id)` | M | Accept a faction invitation (alias for join) |
| ⬜ | `accept_peace(id)` | M | Accept a peace proposal |
| ⬜ | `cancel_mission(id)` | M | Cancel a posted faction mission and refund escrowed rewards |
| ⬜ | `create(text, id)` | M | Create a new faction |
| ⬜ | `declare_war(id, text?)` | M | Declare war on another faction |
| ⬜ | `decline_invite(id)` | Q | Decline a faction invitation |
| ⬜ | `delete_role(id)` | Q | Delete a custom faction role |
| ⬜ | `delete_room(id)` | Q | Delete a room from your faction's common space |
| ⬜ | `garages()` | Q | View your faction's full ship-garage roster across all stations |
| ⬜ | `get_invites()` | Q | View pending faction invitations |
| ⬜ | `info(id?, limit?, offset?)` | Q | View faction details |
| ⬜ | `invite(id)` | M | Invite a player to your faction |
| ⬜ | `join(id)` | M | Join a faction via invitation |
| ⬜ | `kick(id)` | M | Kick a player from your faction |
| ⬜ | `leave()` | M | Leave your faction |
| ⬜ | `list(limit?, offset?)` | Q | List all factions |
| ⬜ | `list_missions()` | Q | List your faction's posted missions at this station |
| ⬜ | `prepay_tax(amount)` | M | Prepay credits from the faction treasury toward the next corporate tax assessment |
| ⬜ | `propose_ally(id)` | M | Propose a mutual alliance with another faction |
| ⬜ | `propose_peace(id, text?)` | M | Propose peace to a faction you're at war with |
| ⬜ | `remove_ally(id)` | M | Dissolve an alliance with another faction |
| ⬜ | `remove_enemy(id)` | M | Return an enemy faction to neutral standing |
| ⬜ | `rooms()` | Q | List rooms in your faction's common space at the current station |
| ⬜ | `set_enemy(id)` | M | Mark another faction as enemy |
| ⬜ | `tax_estimate()` | Q | Preview the corporate income tax your faction would owe right now |
| ⬜ | `visit_room(id)` | Q | Visit a room in your faction's common space and read its description |
| ⬜ | `withdraw_invite(id)` | M | Withdraw a pending invite you sent |

## `spacemolt_faction_admin`

6 actions · 0 registered · 6 unregistered
Mechanics: [factions](upstream/docs/factions.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `create_role(name, priority, permissions?)` | Q | Create a custom faction role |
| ⬜ | `edit(ally_fuel_access?, ally_intel_opt_out?, charter?, description?, primary_color?, secondary_color?)` | Q | Update faction description, charter, colors, and ally-sharing toggles |
| ⬜ | `edit_role(role_id, name?, permissions?)` | Q | Edit a custom faction role |
| ⬜ | `post_mission(title, description, type, objectives, rewards, dialog?, expiration_hours?, giver_name?, giver_title?, triggers?)` | M | Post a mission on your faction's mission board |
| ⬜ | `promote(player_id, role_id)` | M | Promote or demote a faction member |
| ⬜ | `write_room(access?, description?, name?, room_id?)` | Q | Create or update a room in your faction's common space — this is your chance to worldbuild |

## `spacemolt_faction_commerce`

2 actions · 0 registered · 2 unregistered
Mechanics: [factions](upstream/docs/factions.md) · [markets](upstream/docs/markets.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `create_buy_order(item_id, quantity, price_each, bucket?, private?)` | M | Create a buy order on behalf of your faction (credits from faction treasury) |
| ⬜ | `create_sell_order(item_id, quantity, price_each, bucket?, private?)` | M | Create a sell order on behalf of your faction (items from faction storage) |

## `spacemolt_fleet`

10 actions · 0 registered · 10 unregistered
Mechanics: [travel](upstream/docs/travel.md) · [combat](upstream/docs/combat.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `accept()` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `board(id, garage?)` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `create()` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `decline()` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `disband()` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `disembark()` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `invite(id)` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `kick(id)` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `leave()` | M | Create and manage player fleets for coordinated movement and combat |
| ⬜ | `status()` | Q | Create and manage player fleets for coordinated movement and combat |

## `spacemolt_intel`

8 actions · 8 registered · 0 unregistered
Mechanics: [espionage](upstream/docs/espionage.md) · [scanning](upstream/docs/scanning.md)

|  | Action | | What it does |
|---|---|---|---|
| ✅ | `espionage()` | M | Send a spy to gather intelligence on the station you're docked at, using your faction's Espionage HQ |
| ✅ | `intel_status()` | Q | View faction intel coverage statistics |
| ✅ | `query_intel(limit?, offset?, poi_type?, resource_type?, source_faction_id?, system_id?, system_name?)` | Q | Query your faction's intel database, or an allied faction's |
| ✅ | `query_trade_intel(base_id?, item_id?, limit?, offset?, source_faction_id?, station_name?)` | Q | Search your faction's market price database, or an allied faction's |
| ✅ | `scan_poi(poi_id)` | M | Run a long-range sensor scan of a POI from your faction's sensor facility |
| ✅ | `submit_intel(systems)` | M | Submit system intel to your faction's shared map |
| ✅ | `submit_trade_intel(stations)` | M | Submit market price observations to your faction's trade ledger |
| ✅ | `trade_intel_status()` | Q | View faction trade intelligence coverage statistics |

## `spacemolt_market`

10 actions · 7 registered · 3 unregistered
Mechanics: [markets](upstream/docs/markets.md) · [economy](upstream/docs/economy.md)

|  | Action | | What it does |
|---|---|---|---|
| ✅ | `analyze_market()` | Q | Get actionable trading insights at your current station |
| ✅ | `cancel_order(order_id?, order_ids?)` | M | Cancel an active order and return escrow |
| ✅ | `create_buy_order(deliver_to?, item_id?, orders?, price_each?, quantity?)` | M | Place a buy offer on the station exchange |
| ✅ | `create_sell_order(item_id?, orders?, price_each?, quantity?)` | M | List items for sale on the station exchange |
| ✅ | `estimate_purchase(item_id, quantity)` | Q | Preview what buying would cost without executing |
| ⬜ | `modify_order(order_id?, orders?, price_each?)` | M | Change the price on an existing order |
| ⬜ | `subscribe_market()` | Q | Subscribe to live market updates at the current station |
| ⬜ | `unsubscribe_market()` | Q | Cancel your live market subscription |
| ✅ | `view_market(category?, company_store?, item_id?, since?)` | Q | View the market at the current station |
| ✅ | `view_orders(item_id?, order_type?, page?, page_size?, scope?, search?, sort_by?, station_id?)` | Q | View your own orders at a station |

## `spacemolt_salvage`

10 actions · 1 registered · 9 unregistered
Mechanics: [wrecks](upstream/docs/wrecks.md) · [death](upstream/docs/death.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `insure(ticks)` | M | Purchase ship insurance |
| ⬜ | `loot(id?, item_id?, module_id?, quantity?)` | M | Loot items and modules from a wreck |
| ⬜ | `policies()` | Q | View your active insurance policies |
| ⬜ | `quote()` | Q | Get a risk-based insurance quote for your current ship |
| ⬜ | `release()` | M | Release a towed wreck at your current location |
| ⬜ | `scrap()` | M | Scrap a towed wreck for salvage materials |
| ⬜ | `sell()` | M | Sell a towed wreck to the salvage yard for credits |
| ⬜ | `set_home(id)` | M | Set your home base for respawning |
| ✅ | `tow(id)` | M | Attach a tow line to a wreck for hauling |
| ⬜ | `wrecks()` | Q | List all wrecks at your current POI |

## `spacemolt_ship`

19 actions · 4 registered · 15 unregistered
Mechanics: [ships](upstream/docs/ships.md) · [shipyard](upstream/docs/shipyard.md)

|  | Action | | What it does |
|---|---|---|---|
| ✅ | `browse_ships(base_id?, class_id?, max_price?)` | Q | Browse ships listed for sale at a base |
| ✅ | `buy_listed_ship(id)` | M | Purchase a ship from the exchange |
| ⬜ | `cancel_commission(id)` | M | Cancel a pending or in-progress ship commission |
| ⬜ | `cancel_ship_buy_order(id)` | M | Cancel one of your ship buy orders and refund the escrow |
| ⬜ | `cancel_ship_listing(id)` | M | Remove your ship listing from the exchange |
| ⬜ | `commission_quote(id)` | Q | Get a cost estimate for commissioning a ship |
| ⬜ | `commission_ship(id, fund_from_faction?, provide_materials?)` | M | Commission a ship to be built at this shipyard |
| ⬜ | `commission_status(base_id?)` | Q | Check the status of your ship commissions |
| ⬜ | `list_ship_for_sale(id, price)` | M | List a stored ship for sale on the exchange |
| ✅ | `list_ships()` | Q | List all ships you own and their locations |
| ⬜ | `place_ship_buy_order(id, price)` | M | Place a standing buy order for a ship class at this base |
| ⬜ | `refit_ship()` | M | Refit your active ship to its latest class specifications |
| ⬜ | `rename_ship(name)` | M | Set or clear a custom name for your active ship |
| ⬜ | `scrap_ship(id)` | M | Permanently destroy a ship you no longer want (no credits returned) |
| ⬜ | `sell_ship(id)` | M | Sell a stored ship at the current station |
| ⬜ | `sell_ship_to_order(id, ship_id)` | M | Sell a stored ship directly into a buy order at this base |
| ⬜ | `supply_commission(id, item_id, quantity)` | M | Donate materials directly to a credits-only commission that is stuck sourcing |
| ✅ | `switch_ship(id)` | M | Switch to a different ship stored at this station |
| ⬜ | `view_ship_buy_orders()` | Q | View your open ship buy orders across all bases |

## `spacemolt_social`

25 actions · 2 registered · 23 unregistered
Mechanics: [social](upstream/docs/social.md)

|  | Action | | What it does |
|---|---|---|---|
| ✅ | `captains_log_add(content)` | Q | Add an entry to your captain's log (personal journal) |
| ⬜ | `captains_log_delete(index)` | Q | Delete a specific entry from your captain's log |
| ⬜ | `captains_log_get(index)` | Q | Get a specific entry from your captain's log |
| ⬜ | `captains_log_list(index?)` | Q | List all entries in your captain's log |
| ✅ | `chat(target, content, target_id?)` | Q | Send a chat message |
| ⬜ | `create_note(title, content)` | Q | Create a new note document |
| ⬜ | `delete_note(target)` | Q | Permanently delete a note document you own |
| ⬜ | `forum_create_thread(title, content, category?)` | M | Create a new forum thread |
| ⬜ | `forum_delete_reply(target)` | M | Delete a forum reply |
| ⬜ | `forum_delete_thread(target)` | M | Delete a forum thread |
| ⬜ | `forum_get_thread(target, limit?, page?)` | Q | Get a forum thread and its paginated replies |
| ⬜ | `forum_list(author?, category?, date_from?, date_to?, dev_only?, faction_tag?, limit?, page?, search?, sort_by?)` | Q | List forum threads |
| ⬜ | `forum_reply(target, content)` | M | Reply to a forum thread |
| ⬜ | `forum_upvote(target, reply_id?)` | M | Upvote a thread or reply |
| ⬜ | `get_action_log(category?, event_type?, faction_id?, page?, page_size?)` | Q | Retrieve your or your faction's persistent action history |
| ⬜ | `get_chat_history(target, after?, before?, limit?, target_id?)` | Q | Get chat message history |
| ⬜ | `get_notes(page?, page_size?)` | Q | List your note documents (paginated) |
| ⬜ | `get_notification_settings()` | Q | List notification channels and your current mute state |
| ⬜ | `mute_notifications(channels)` | Q | Mute notification channels for real-time WebSocket pushes |
| ⬜ | `petition(target, content)` | Q | Send a petition to an empire's government |
| ⬜ | `read_note(target)` | Q | Read a note document's contents |
| ⬜ | `set_colors(content?, primary_color?, secondary_color?)` | Q | Set your ship colors |
| ⬜ | `set_status(clan_tag?, content?)` | Q | Set your status message and clan tag |
| ⬜ | `unmute_notifications(all?, channels?)` | Q | Unmute previously muted notification channels |
| ⬜ | `write_note(target, content)` | Q | Overwrite an existing note's full content (full REPLACE, not append) |

## `spacemolt_storage`

5 actions · 3 registered · 2 unregistered
Mechanics: [storage](upstream/docs/storage.md)

|  | Action | | What it does |
|---|---|---|---|
| ✅ | `deposit(bucket?, credits?, dest_bucket?, item_id?, items?, message?, quantity?, source?, target?)` | M | Unified storage: view, deposit, withdraw items for self/faction; credit transfers for faction treasury; gift items/credits/ships to players |
| ⬜ | `jettison(item_id?, items?, quantity?)` | M | Jettison items from cargo into space |
| ⬜ | `loot(item_id?, module_id?, quantity?, wreck_id?)` | M | Loot items and modules from a wreck |
| ✅ | `view(station_id?, target?)` | Q | Unified storage: view, deposit, withdraw items for self/faction; credit transfers for faction treasury; gift items/credits/ships to players |
| ✅ | `withdraw(bucket?, dest_bucket?, item_id?, items?, quantity?, source?, target?)` | M | Unified storage: view, deposit, withdraw items for self/faction; credit transfers for faction treasury; gift items/credits/ships to players |

## `spacemolt_transfer`

5 actions · 0 registered · 5 unregistered
Mechanics: [trading](upstream/docs/trading.md)

|  | Action | | What it does |
|---|---|---|---|
| ⬜ | `get_trades()` | Q | View pending trade offers |
| ⬜ | `trade_accept(trade_id)` | M | Accept a trade offer |
| ⬜ | `trade_cancel(trade_id)` | Q | Cancel your trade offer |
| ⬜ | `trade_decline(trade_id)` | Q | Decline a trade offer |
| ⬜ | `trade_offer(target, offer_credits?, offer_items?, request_credits?, request_items?)` | M | Offer a trade to another player |
