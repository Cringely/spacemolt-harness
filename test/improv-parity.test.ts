import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Improv-briefing parity (issue #163, council adoption #1).
//
// AGENTS.md binds: "every deterministic guard/normalizer/lesson we add also
// gets a paired improv-mode instruction recorded in the improv-mode spec ...
// The improv briefing must never drift behind the code." Until this file, that
// rule was enforced by NOTHING -- prose only, the exact WARN-tier failure the
// squad council flagged (their rules are backed by regression tests; ours
// re-broke twice in three days).
//
// How this test enforces it: SEAMS below is the explicit manifest of every
// deterministic guard the pairing convention covers, each keyed two ways --
//   code:     the file + a structural marker proving the guard still exists
//             (manifest-staleness check: a removed/moved guard fails here,
//             prompting a manifest + spec cleanup, not a silent stale entry)
//   briefing: loose semantic anchors (the #148/#161 topic-anchor pattern:
//             distinctive keyword pairs, never full sentences) that the spec's
//             SECTION 4 standing briefing must satisfy. Prose can be retuned
//             freely; a DELETED rule still fails its anchor.
//
// Anchors match against section 4 ONLY (sliced below), because section 5's
// backstop descriptions repeat the same keywords -- a whole-file match would
// pass even after the briefing rule itself was deleted.
//
// Adding a new deterministic guard? Add its manifest entry here in the same
// PR that adds the paired section-4 rule. This list is also the seed for the
// #165 seam manifest (the guards<->improv-spec seam).
//
// Deliberately ABSENT (not an oversight): the report-only section-5 backstops
// -- progress heartbeat, notification feed / per-tick ledger -- which the spec
// exempts in-place ("No paired improv briefing rule -- they shape no pilot
// behavior, only observe"). Forcing anchors for them would be theater.

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Container-context gate: the Dockerfile's test stage copies src+test only
// (.dockerignore excludes docs/ and .claude/ from the image BY DESIGN — the
// shipped artifact carries no docs). When the whole docs tree is absent we
// are inside that build and there is nothing to check parity against; repo
// CI (which has the tree) is where this enforcement lives. A missing FILE
// inside an existing tree is a real failure: read() below throws at module
// load and fails the run loudly.
const docsPresent = existsSync(join(root, "docs"));

const SPEC_PATH = "docs/superpowers/specs/2026-07-12-improv-mode.md";
const spec = docsPresent ? read(SPEC_PATH) : "";

// The convention (spec section 7) is keyed to these two sections by number:
// rules land "in §4 of this spec (or a note that it's a §5 backstop)". The
// numbers are load-bearing, so slicing by them is the convention, not a hack.
const briefingStart = spec.search(/^## 4\./m);
const backstopStart = spec.search(/^## 5\./m);
const briefing = spec.slice(briefingStart, backstopStart);

type Seam = {
  guard: string; // what the deterministic side is
  code: { file: string; marker: string | RegExp }; // proof the guard still exists
  anchors: (string | RegExp)[]; // topic anchors the §4 briefing must satisfy
};

const SEAMS: Seam[] = [
  {
    guard: "undock no-op guard (executor drops undock when already undocked)",
    code: { file: "src/agent/executor.ts", marker: 'step.action === "undock"' },
    anchors: [/never undock/i, /docked/i],
  },
  {
    guard: "accept_mission empty-param guard + #147 mission funnel",
    code: { file: "src/agent/executor.ts", marker: 'step.action === "accept_mission"' },
    anchors: ["accept_mission", "template_id", /empty/i, "get_missions", "complete_mission"],
  },
  {
    guard: "mine precondition guard (no fitted mining laser -> blocked wake)",
    // Repointed by #757/#736. This used to pin executor.ts's
    // `step.action === "mine"` fitment check, which that change deleted when it
    // generalised the check into the requirement table -- and the marker kept
    // matching two unrelated decoys in the #526 fuel-floor guard, so the seam
    // went green while pinning nothing. `toContain` over a whole-file read is
    // identity- and count-blind; it cannot tell which occurrence matched. The
    // mine requirement now lives as one table row, and deleting that row is
    // what this must catch.
    code: { file: "src/registry/fitment.ts", marker: 'action: "mine"' },
    anchors: [/mining laser/i, /fit/i],
  },
  {
    guard: "module-fitment guard (#757/#736: the mine laser check generalised to a requirement " +
      "table -- survey_system/tow/cloak join it; blocks only a PROVEN-absent module, and consults " +
      "the hull's integrated capabilities first for the two the reference says a hull can supply)",
    // "fitmentBlock" appears four times in executor.ts: the definition, the
    // call site, and two comment mentions. So this marker vanishing proves the
    // guard is gone, but the guard being gone does not guarantee the marker
    // vanishes -- deleting the function while leaving a comment keeps this
    // green. The blocking behaviour is pinned for real by executor-fitment's
    // refusal tests; this entry pins the PAIRED briefing bullet below.
    code: { file: "src/agent/executor.ts", marker: "fitmentBlock" },
    // Each anchor is absent from the rest of §4 (the mining-laser and
    // POI-type bullets above it talk about lasers and harvesters, never about
    // scanners, tow rigs or the game's codes for them), so deleting this
    // bullet fails here rather than passing on a neighbour's vocabulary.
    anchors: ["survey_system", /no_scanner/i, /tow rig/i, /no_tow_rig/i, /integrate/i],
  },
  {
    guard: "sell effect-verification (SM-9 phantom sells)",
    code: { file: "src/agent/executor.ts", marker: "verifySellEffect" },
    anchors: [/phantom/i, /re-query|confirm/i],
  },
  {
    guard: "refuel target precondition guard (#595: non-\"fleet\" target absent from a fresh get_nearby listing -> blocked wake)",
    code: { file: "src/agent/executor.ts", marker: "refuelTargetBlock" },
    anchors: [/Refueling Pump/i, /no_refueling_pump/i, /fill my own tank/i],
  },
  {
    guard: "tick-pacing settle (SM-12: pending accept skips one submission)",
    code: { file: "src/agent/executor.ts", marker: /settle: true/ },
    anchors: [/action pending/i, /wait one tick/i],
  },
  {
    guard: "transient-block hold/resubmit classifier (SM-10/SM-11: wait, never replan)",
    code: { file: "src/agent/executor.ts", marker: "TRANSIENT_BLOCK_MARKERS" },
    anchors: [/resubmit this command/i, /reissue the same command/i, /never replan/i],
  },
  {
    guard: "catalog-gated jettison guard (#94: base_value floor -> blocked wake)",
    code: { file: "src/agent/executor.ts", marker: 'step.action === "jettison"' },
    anchors: [/worthless/i, /never jettisoned/i, "create_sell_order"],
  },
  {
    guard: "target-locality guard (#176: travel to a remote POI / scan of a POI id -> blocked)",
    code: { file: "src/agent/executor.ts", marker: "targetLocalityBlock" },
    anchors: [/never reuse a POI id across a system change/i, "get_nearby", /never scan a POI id/i],
  },
  {
    guard: "scan nearby-membership guard (#368: a scan id absent from the fresh get_nearby text -> blocked before the tick; the #176 POI check knows only THIS system's POIs, so remote-POI ids sailed through it to the game 27/27)",
    // "api.getNearby" appears in executor.ts only inside this check, so the
    // marker vanishing is the guard vanishing.
    code: { file: "src/agent/executor.ts", marker: "api.getNearby" },
    anchors: [/as local as POI ids/i, /fresh listing/i],
  },
  {
    guard: "net-profit trip verdict (#112: digest advisory naming the sell-one-last-item anti-pattern; ADVISORY ONLY -- PR #361 review rejected a deterministic block because catalog value cannot bound player-driven revenue)",
    code: { file: "src/planner/digest.ts", marker: "selling one last item across a paid border" },
    // Anchors never straddle the spec's line wrap (the "one last item across a
    // paid border" phrase wraps mid-sentence, so it is anchored by its halves).
    anchors: [/NET profit/i, /round-trip fuel/i, /one last item/i, /paid border/i, /contraband only/i],
  },
  {
    guard: "install_mod fit guard (#219: undocked / over-grid / no free slot -> blocked wake)",
    code: { file: "src/agent/executor.ts", marker: "installModBlock" },
    // Anchors are distinctive keyword pairs, never full sentences (the #148/#161
    // pattern) -- and never a phrase that straddles the spec's line wrap.
    anchors: ["install_mod", "buy_listed_ship", "uninstall_mod", /CPU, power and slot counts/i, /listing_id/i],
  },
  {
    guard: "install_mod cargo-presence guard (#402: install_mod named a module not in cargo -> blocked before the tick; the fit guard weighs CPU/power/slots, but a module you do not own has none to weigh, so presence is a distinct precondition)",
    // "not in your cargo" appears in executor.ts only inside this guard's reason,
    // so the marker vanishing is the guard vanishing.
    code: { file: "src/agent/executor.ts", marker: "not in your cargo" },
    anchors: [/not in your cargo/i, /buy it first/i],
  },
  {
    guard: "shipyard listing + fit headroom in the digest (#219: the only purchasable-id source)",
    code: { file: "src/agent/agent.ts", marker: "gatherShipyard(" },
    anchors: ["browse_ships", /lands in your CARGO/i],
  },
  {
    guard: "nearby-entity listing in the digest (#176: the only valid scan-target id source)",
    code: { file: "src/agent/agent.ts", marker: "gatherNearby(" },
    anchors: ["get_nearby", /nothing here to scan/i],
  },
  {
    guard: "no-buyers outcome-class damper key + relocate (issue #146)",
    // "(" scopes the match to the call site (the damper-key branch), not the
    // import list -- a comment mentioning the name never carries the paren.
    code: { file: "src/agent/agent.ts", marker: "isNoBuyersBlock(" },
    anchors: [/no buyers/i, /relocate/i],
  },
  {
    guard: "same-error-repeat loop-breaker (#95, accrual un-windowed for #291's third occurrence: (action,target) blocks counted since the key's last success -> transient re-steer at K, catches interleaved AND slow repeats the consecutive gate misses)",
    // The trip-site emit: deleting the breaker removes this event, so the
    // marker vanishing is the guard vanishing (the same "removed guard fails
    // here" staleness check the other agent.ts entries use).
    // The /hours apart/ anchor pins the #291 third-occurrence half of the
    // briefing: a slow repeat is the same doomed loop as a fast one.
    code: { file: "src/agent/agent.ts", marker: "repeat_block_break" },
    anchors: [/same-error-repeat/i, /interleaved/i, "(action, target)", /hours apart/i],
  },
  {
    guard: "dock dead-end forced reroute (#551: N dock refusals for 'no station at this location' -> plan forced to [travel_to{confirmed station system}, dock]; the streak is derived from the action stream, interleave-tolerant like #95's breaker)",
    // The guard's only entry point. Deleting the reroute removes this method,
    // so the marker vanishing is the guard vanishing.
    code: { file: "src/agent/agent.ts", marker: "maybeForceDockReroute" },
    // Anchors sit on the §4 dock-retry bullet, not the §5 backstop paragraph
    // (§5 is sliced out by design). Each is chosen to be absent from the rest
    // of §4, so deleting that bullet fails here rather than passing on the
    // neighbouring station-shortlist rule's vocabulary.
    anchors: [/map fact, not bad luck/i, /Stop retrying that `dock`/i,
      /confirmed station system from your shortlist/i, /back-to-back/i],
  },
  {
    guard: "market-intelligence injection (#269: harness runs analyze_market; the planner cannot plan a query)",
    code: { file: "src/agent/agent.ts", marker: "gatherAnalyzeMarket(" },
    anchors: ["analyze_market", /market intelligence/i],
  },
  {
    guard: "active-mission visibility + completion priority (#170)",
    code: { file: "src/agent/agent.ts", marker: "gatherActiveMissions(" },
    anchors: ["get_active_missions", "complete_mission", /before accepting/i],
  },
  {
    guard: "mission_id-vs-template_id id-source fix (#931: complete_mission/abandon_mission took " +
      "43 fleet-wide mission_not_found refusals because the digest's own completion-priority line " +
      "sent the planner back to the raw, unparsed active-listing prose for an id -- the one place a " +
      "template_id can sit beside the real mission_id, unlabelled; the parser was never the bug, " +
      "the instruction was)",
    // The exact phrase the fix repoints the id-sourcing instruction at; it
    // appears nowhere in the pre-fix file, so a revert of the instruction (or
    // of the matching raw-listing header) removes this marker.
    code: { file: "src/planner/digest.ts", marker: 'mission_id from the "Mission objective check"' },
    // The game's error text straddles the spec's ~100-char line wrap (the
    // #148/#161 pattern this file's own comments warn about), so it needs a
    // regex whose \s bridges the wrap rather than a literal-space string.
    anchors: ["mission_id", "template_id",
      /Use the mission_id from get_active_missions\s*\(not\s+template_id\)/,
      /field name, not the position/i],
  },
  {
    guard: "mission_id id-source fallback when the parse degrades (#931 continuation: activeMissionsText " +
      "and activeMissions are independent fields in client.ts's getActiveMissions -- a safeParse failure, " +
      "or an envelope whose missions.active is absent/not-an-array, leaves activeMissions undefined while " +
      "activeMissionsText still carries the raw envelope prose; the completion-priority line above used to " +
      "name the parsed block as the only sanctioned id source even on that tick, when the block never " +
      "renders)",
    // The fallback phrase itself; it appears nowhere in the pre-fix file, and
    // a revert of the gate (back to the unconditional instruction) removes it.
    code: { file: "src/planner/digest.ts", marker: "mission_id did not parse this tick" },
    anchors: [/mission_id did not parse/i, /wait for a replan/i, /does not render/i],
  },
  // No paired seam for the reward-field zod .catch() fix (#931/#1051
  // follow-up, client.ts's ActiveMissionRewardsSchema): same exemption class
  // as #291's own array-safeParse degradation above (client.ts,
  // getActiveMissions) -- neither has a seam, because both are internal
  // parsing-robustness fixes with no improv-mode behavioral analog. An
  // improv-mode agent reads the raw API response directly; it has no zod
  // array-level parse step to degrade, so nothing in section 4 changes.
  {
    guard: "mission-priority ranking rule (#592: the digest's completion-priority line ranks active " +
      "missions by what each reward does for the operator's Goals, with the clock only as a tiebreak -- " +
      "it no longer calls an auto-assigned distress mission 'accepted' (missions.md:11,70) and no " +
      "longer generalises the board-mission '~10x an ore sale' rule (guides/miner.md:60) onto one)",
    // "A SHORT TIMER IS NOT VALUE" appears in digest.ts only inside this
    // priority line, so the marker vanishing is the ranking rule vanishing.
    code: { file: "src/planner/digest.ts", marker: "A SHORT TIMER IS NOT VALUE" },
    // Anchors kept inside single source lines (the #148/#161/paid-border
    // pattern -- the spec wraps prose at ~100 chars, so a phrase straddling
    // that wrap never matches a literal-space regex).
    anchors: [/A SHORT TIMER IS NOT VALUE/, /AUTO-ASSIGNS a rescue mission/,
      // /never by/i was vacuous: it already matched the unrelated #670 fuel
      // rule ("never by percent of tank capacity") elsewhere in the spec, so it
      // could not fail independently of the three anchors beside it.
      /BOARD missions accepted for their reward/, /break a tie between missions of similar value/i,
      // The expiry cost, keyed on the observable. Unanchored before, and two
      // review rounds found the claim wrong in three different directions with
      // nothing on either side of the seam able to fail.
      /reclaim or charge\s+only goods the mission itself PROVIDED/],
  },
  {
    guard: "mission reward rendering (#1051, split out of #592: the digest's parsed Mission objective " +
      "check now renders rewards.credits and rewards.skill_xp beside the expiry fuse -- #592's ranking " +
      "rule had no reward datum to rank by until this; reference-backed against openapi-v2.json, not " +
      "yet confirmed by a live capture)",
    // The gate that gives the render its #94 absence contract (undefined ->
    // no line, never a false 0). Reverting this branch (or the reward fields
    // it reads) removes the marker.
    code: { file: "src/planner/digest.ts", marker: "m.rewardCredits !== undefined" },
    anchors: ["rewards.credits", "rewards.skill_xp",
      /V2GameState\.missions\.active\.rewards/,
      /renders no reward line, never a false 0/i],
  },
  {
    guard: "mission objective check + deposit cross-ref (#291: objective item vs current POI's deposit resource ids)",
    code: { file: "src/agent/agent.ts", marker: "gatherPoiDeposits(" },
    anchors: ["get_poi", /never yield/i, /deposits DO list it/i],
  },
  {
    guard: "stale-mission advisory (#291: zero progress past MISSION_STALE_HOURS -> abandon_mission advisory)",
    code: { file: "src/planner/digest.ts", marker: "MISSION_STALE_HOURS" },
    anchors: ["abandon_mission", /zero progress/i, /stale mission/i],
  },
  {
    guard: "stale-mission threshold derives from the mission's own expiry (#700: a distress-response " +
      "mission expires in ~3h -- under the flat MISSION_STALE_HOURS=24h, the advisory above was " +
      "structurally incapable of ever firing on the mission class the pilot holds most of, since the " +
      "mission is always gone before 24h of zero progress can accumulate)",
    // Pins the derivation function itself, not just MISSION_STALE_HOURS (the
    // seam above already pins that constant, and it survives unchanged as the
    // long-mission fallback/cap -- so a regression that deletes ONLY the
    // per-mission derivation and restores a flat MISSION_STALE_HOURS comparison
    // must fail HERE, not there).
    code: { file: "src/planner/digest.ts", marker: "function staleAdvisoryThresholdHours(" },
    anchors: [/distress-response rescue expires/, /own HALFWAY point/, /whichever is smaller/,
      /own expiry implies/],
  },
  {
    guard: "complete_mission objective guard (#291 regression: current<required -> blocked wake before the doomed tick)",
    code: { file: "src/agent/executor.ts", marker: "completeMissionBlock" },
    anchors: ["complete_mission", /mission_incomplete/i, /before completing/i],
  },
  {
    guard: "complete_mission membership guard (#553: id absent from a PARSED fresh active list -> blocked before the doomed tick)",
    // Pins the refusal itself, not the enclosing function: `completeMissionBlock`
    // above already matches a rename or a comment mention, and the #553 branch
    // lives INSIDE it, so a marker on the name would stay green with the branch
    // deleted. This one needs the absent-id test AND the guardBlock return AND
    // the refusal's first words, in that order -- prose about the guard cannot
    // satisfy it, and reverting the branch to `return null` fails it.
    code: {
      file: "src/agent/executor.ts",
      marker: /if \(!mission\) \{[\s\S]{0,900}?return guardBlock\(\s*`complete_mission blocked: plan a different step/,
    },
    anchors: ["get_active_missions", "mission_not_found", /Distress/, /1\.5 minutes/],
  },
  {
    guard: "mine deposit guard (#188: array power > 4x every deposit's supported_power -> blocked before the tick; threshold shared with the digest's Deposit check by import)",
    code: { file: "src/agent/executor.ts", marker: "mineDepositBlock" },
    anchors: ["supported_power", /4x/, "get_poi", /mining_power/],
  },
  {
    guard: "learned sparse-deposit rules (#188 part 3: too-sparse refusal persisted per (POI, mining-fit); executor refuses the exact repeat, 6h TTL, refit invalidates)",
    code: { file: "src/agent/agent.ts", marker: "mine_sparse_learned" },
    anchors: [/too sparse/i, /unavoidable tuition/i, /refit smaller/i],
  },
  {
    guard: "deposits-too-sparse relocate briefing (#188 rung 1: blocked-wake line -- relocate, never retry at this POI with this fit)",
    code: { file: "src/planner/digest.ts", marker: "deposits-too-sparse block" },
    anchors: [/relocate to a denser field/i, /richer vein/i],
  },
  {
    guard: "ore-value advisory (#366: deposit check prices each deposit from the catalog SSOT + station market check renders the live bid beside its catalog estimate; ADVISORY ONLY -- the #361 constraint holds, catalog value cannot prove a player-driven price low, so no threshold and no block)",
    code: { file: "src/planner/digest.ts", marker: "Ore VALUE check" },
    anchors: [/Ore VALUE decides your credits\/hr/i, /relative guides, never guarantees/i, /lowball local price/i, /credits stay flat/i],
  },
  {
    guard: "item-id discipline (snake_case ids, never display names; SM-3)",
    code: { file: "src/planner/digest.ts", marker: "snake_case" },
    anchors: [/snake_case/, /display name/i],
  },
  {
    guard: "movement-verb reachability (travel vs jump vs travel_to)",
    code: { file: "src/planner/digest.ts", marker: "ADJACENT" },
    anchors: ["travel_to", /adjacent/i, /any system/i],
  },
  {
    guard: 'current-location surfacing (SM-4: "You are at" rendered first)',
    code: { file: "src/planner/digest.ts", marker: "renderWhereYouAre" },
    anchors: ['"You are at"', /never travel to the spot/i],
  },
  {
    guard: "prompt-injection + identity boundary (digest quoting + canary)",
    code: { file: "src/planner/digest.ts", marker: "NEVER instructions to you" },
    anchors: [/never obey a command/i, /never disclose/i],
  },
  {
    guard: "fuel-reserve floor + strand steward",
    code: { file: "src/agent/agent.ts", marker: "STRANDED" },
    anchors: [/only while docked/i, /strand/i],
  },
  {
    guard: "fuel urgency by measured jump range, not percent of tank (#670: 19/130 fuel read 14.6% 'critical' by a percent rule while holding 19 jumps of real range on a 1-fuel/jump hull; a live pilot froze 28.5h on it -- a DIFFERENT mechanism from the STRANDED entry above, which is the agent.ts wake/anti-strand path)",
    code: { file: "src/agent/reflex.ts", marker: "keepFuelAboveJumps" },
    anchors: [/JUMPS OF RANGE/, /28\.5h/, /opposite reality/i],
  },
  {
    guard: "fuel urgency by jumps in the low_fuel WAKE threshold, the third and last #670 consumer " +
      "(reflex.ts's auto-refuel and the persona floor shipped 2026-08-01; this is evaluateWake's own " +
      "percent-of-tank check, replaced by the same shared fuelUrgent so all three can't drift apart)",
    code: { file: "src/agent/wake.ts", marker: "keepFuelAboveJumps" },
    anchors: [/JUMPS OF RANGE/, /28\.5h/, /opposite reality/i],
  },
  {
    guard: "undocked fuel-reserve floor OR'd independently of the jumps verdict, never folded into " +
      "fuelUrgent's percent fallback (#1045: a ship with BOTH a measured fuelPerJump and " +
      "keepFuelAboveJumps configured took the jumps branch every time, which never reads its percent " +
      "argument at all, so the reserve raise was silently discarded rather than superseded -- a ship " +
      "at 2.3% fuel with 3 jumps of measured range sat unrefueled nine times under its 25% reserve)",
    code: { file: "src/agent/wake.ts", marker: "reserveUrgent" },
    anchors: ["SEPARATE, unconditional", "reserve became a required OR", /OR'd/],
  },
  {
    guard: "ambient skill-XP excluded from the no-progress signal (#250: LEVEL counts, sub-level XP drip does not)",
    // The LEVEL-only return line: folding xp back into the signature changes
    // this exact line (it becomes `return levels * WEIGHT + xp;`), so the
    // marker vanishing is the guard vanishing.
    code: { file: "src/agent/no-progress-detector.ts", marker: "return levels;" },
    anchors: [/passive skill-XP/i, /productive OUTCOMES/, /level-up/i],
  },
  {
    guard: "instruction supersession: newest-first briefing + goal-history cap (#186)",
    code: { file: "src/agent/agent.ts", marker: "MAX_GOALS" },
    anchors: [/newest first/i, /supersede/i],
  },
  {
    guard: "standing-instruction salience + planner-reported satisfaction (#355: the newest operator instruction re-raised every replan until instruction_done)",
    // The digest's re-raise block: deleting the salience mechanism removes
    // this literal header, so the marker vanishing is the guard vanishing.
    code: { file: "src/planner/digest.ts", marker: "STANDING OPERATOR INSTRUCTION" },
    anchors: [/acted on ONCE/i, /is this done yet/i, "instruction_done"],
  },
  {
    guard: "pinned (\"standing until revoked\") instruction survives instruction_done -- only an explicit operator revoke clears it (#817)",
    // #1106: the bare "pinnedInstructions" identifier occurs 14 times in
    // agent.ts (field decl, replay, instruct()'s pin, revokeInstruction,
    // eviction skip x3) -- deleting ONLY the retirement guard's pin check at
    // agent.ts:2731 left 13 occurrences and this SEAM stayed green over a
    // deleted guard (verified live: ablating the guard's pin check left this
    // SEAM's old bare-identifier marker passing, 0 failures). The negated
    // call expression below is the guard's own condition verbatim, and it is
    // NOT reused anywhere else in the file -- including the #1106 digest-truth
    // line this same PR adds (agent.ts ~2548), which calls
    // `pinnedInstructions.has(standingInstruction)` WITHOUT the leading `!`,
    // so that near-duplicate does not collide with this marker. Verified: 1
    // occurrence via `grep -c '!this.pinnedInstructions.has(standingInstruction)'`.
    code: { file: "src/agent/agent.ts", marker: "!this.pinnedInstructions.has(standingInstruction)" },
    // \s+ because the spec wraps "explicit revoke" across a line break, the
    // same reason the msg_type anchor above uses it.
    anchors: [/standing until revoked/i, /explicit\s+revoke/i, "instruction_done"],
  },
  {
    guard: "critical msg_type wake classification (player_died arrives under type system)",
    code: { file: "src/agent/wake.ts", marker: "CRITICAL_MSG_TYPES" },
    // \s+ because the spec wraps this sentence across a line break.
    anchors: ["msg_type", "player_died", /never filter\s+on `type` alone/i],
  },
  {
    guard: "blocked-wake goal-variation salience (#314, #240 eval: goal_diversity failures)",
    code: { file: "src/planner/digest.ts", marker: "BLOCKED wake" },
    anchors: [/BLOCKED wake/, /vary your goal/i],
  },
  {
    guard: "sell/jettison cargo-id quoting (#314, #240 eval: 'ore_common' invented from a display name)",
    code: { file: "src/planner/digest.ts", marker: "item ids are EXACT snake_case ids" },
    anchors: ["ore_common", /display name/i],
  },
  {
    guard: "mine fuel-floor guard (#526: a `mine` step refused once fuel reads below the reserve " +
      "-- the persona's own 'keep fuel above N%' line was a request to the model, never an " +
      "enforced constraint, and the pilot mined to 2/130 (1.5%) and stranded anyway. Shares " +
      "reflex.ts's fuelUrgent check with the docked auto-refuel reflex above, so the two can't " +
      "quietly diverge on the same ship state)",
    code: { file: "src/agent/executor.ts", marker: "fuelReserveConfig?.keepFuelAboveJumps" },
    // Anchors kept inside single source lines (the #148/#161/paid-border
    // pattern -- the spec wraps prose at ~100 chars, so a phrase straddling
    // that wrap never matches a literal-space regex).
    anchors: [/burns no fuel/i, "no route home", /mine refusal/i],
  },
  {
    guard: "create_buy_order duplicate-order guard (#681 round 2: refuse a SECOND standing buy order " +
      "for a station+item pair that already has one open, tracked from the pilot's own order " +
      "placements and cleared on a successful cancel_order or a buy_filled notification; round 1 " +
      "wrongly refused the pilot's legitimate FIRST order by keying on a blocked buy instead of an " +
      "open one, task-reviewer finding on PR #58)",
    code: { file: "src/agent/executor.ts", marker: 'step.action === "create_buy_order" && buyOrderAlreadyOpen' },
    anchors: ["create_buy_order", /duplicate bid/i, /already have one open/i, /the old one FIRST/i],
  },
  {
    guard: "fleet credit-gift guard (#703: a `deposit` in gift form sends credits only to a " +
      "username on this harness's own roster -- irreversible, and the pilot reads a broadcasting " +
      "emergency channel. Split across three files by what each can know: the executor holds WHO " +
      "(runtime config), the registry schema holds HOW MUCH (GIFT_CREDIT_CEILING, so BOTH drivers " +
      "are bound -- the improv pilot never calls executeTick), plan.ts holds HOW OFTEN " +
      "(repeat/until are invisible from inside a params refinement). PR #82 review)",
    // The executor's WHO half. 'step.action === "deposit"' appears exactly once
    // in executor.ts, so the marker vanishing is the roster check vanishing.
    code: { file: "src/agent/executor.ts", marker: 'step.action === "deposit"' },
    // One anchor per rule the model has to carry, since the improv driver
    // reaches NONE of the executor's guards: what a gift is, that it cannot be
    // undone, who may receive one, HOW they are named (#788: the planner wrote
    // the harness agent id where the game wants the in-game username, and the
    // improv driver reaches neither the plan-admission normalizer that now
    // translates it nor the guard that refuses it), how much, how often.
    anchors: ["CREDIT GIFT", /no cancel for a gift/i, /fleet roster/i,
      /never the short internal id/i,
      /5000cr in a single gift/i, /never set up a standing gift/i],
  },
  {
    guard: "zero-balance order guard (#1030: create_sell_order under the exchange's 1cr listing-fee " +
      "floor, or create_buy_order under its own bid, refused before the call -- only on a KNOWN " +
      "balance, never on a status that failed to report one)",
    // Pins the CALL SITE, not the helper's interior and not a mention of it.
    // `orderCreditBlock` appears three times in executor.ts: the definition,
    // this call, and one comment -- so the bare name would stay green if
    // the call were deleted and a comment left behind, which is exactly how the
    // mine seam went vacuous under #757/#736. The assignment prefix appears
    // only where the guard is actually consulted, and a rename takes it with it.
    code: { file: "src/agent/executor.ts", marker: /const creditBlock = orderCreditBlock\(/ },
    // Each anchor is absent from the rest of §4. The neighbouring net-profit
    // bullet already says "1% listing fee", so /listing fee/ would match it and
    // pin nothing -- these pin the game's own floor phrase, the escrow fact,
    // and the remedy, none of which appear anywhere else in the section.
    anchors: ["minimum 1 credit", /escrows the whole bid/i, /balance of zero/i,
      /earn before you list/i],
  },
  {
    guard: "withdraw storage-contents guard (#706: a withdraw whose personal locker provably holds " +
      "fewer than the requested quantity is refused before the tick. 21 of the miner's 30 lifetime " +
      "withdraws were refused by the game with `insufficient_storage: Storage only has 0 x <item>`, " +
      "one tick after a create_buy_order the pilot read as delivery)",
    // Pins the CALL SITE, which is what every other seam in this file does
    // (`step.action === "undock"`, `step.action === "accept_mission"`). An
    // earlier version marked `api.getStorage`, the guard's INTERIOR, and review
    // measured the gap: deleting the `if (step.action === "withdraw")` block in
    // executeTick leaves the guard defined, dead, and this seam GREEN. Existence
    // and wiring have to be pinned together or the seam certifies a function
    // nothing calls.
    //
    // A REGEX, and the parens are the point. The interior marker was a regex
    // for a related reason: ablating it with a rename to `api.getStorageXX`
    // left a `toContain("api.getStorage")` GREEN, because the old name survives
    // as a PREFIX of the new one -- the same substring-blindness that let the
    // #757 marker match two decoys, in its other form. Matching the call with
    // its arguments refuses both a rename and a bare mention in a comment.
    code: { file: "src/agent/executor.ts", marker: /withdrawStorageBlock\(api, step\)/ },
    // Each anchor was absent from §4 before this bullet was added (checked, not
    // assumed), so deleting the bullet fails here rather than passing on a
    // neighbour's vocabulary. create_buy_order is deliberately NOT an anchor:
    // §4 already says it four times in the market-order rules.
    anchors: ["insufficient_storage", "view_storage", "deliver_to=storage", /waits for a seller/i],
  },
  {
    guard: "buy price-sanity guard (#458: a spot `buy` whose estimate_purchase quote prices it over " +
      "BUY_PRICE_SANITY_MULTIPLIER (8x) the item's catalog base_value is refused before the tick -- " +
      "three live incidents burned ~220k credits on 100x-400x asks, and no guard existed on `buy` at " +
      "all before this)",
    // Pins the CALL SITE, the same shape withdrawStorageBlock's seam above
    // explains: the interior function existing proves nothing if nothing
    // calls it. A REGEX (with its arguments) for the same reason that entry
    // gives -- a bare `toContain("buyPriceGuard")` survives a rename to
    // `buyPriceGuardXX` as a substring of the new name. Repointed by #1116,
    // which added a third `preStatus` argument (needed for the fuel_cell
    // refuel steer below) -- the old two-argument marker went stale the
    // moment the signature changed, the same drift the #982/#1003 seam's
    // comment warns about.
    code: { file: "src/agent/executor.ts", marker: /await buyPriceGuard\(api, step, preStatus\)/ },
    // Each anchor was absent from §4 before this bullet was added (checked,
    // not assumed). "Mining Laser III" is deliberately NOT an anchor: the
    // install_mod section above already names it (issue #402), so it would
    // pass on a neighbour's vocabulary rather than on this bullet.
    anchors: ["220,108cr", "100,500cr", /8x the catalog base_value/],
  },
  {
    guard: "buy price-sanity refusal: prose remedy, not a template, plus the fuel_cell refuel steer " +
      "(#1116: the refusal used to render create_buy_order as a filled-in, action-name-followed-by-" +
      "brace command the planner could copy verbatim -- the exact shape a GAME error already got " +
      "obeyed six times and locked ~21,800cr in #681. Docked with fuel_cell specifically, a buy order " +
      "ESCROWS the bid while refuel spends straight from the wallet, so this now steers to refuel " +
      "only when the current POI's station tank reads above zero, never on has_base alone (dock() " +
      "only ever reaches a base, so has_base is true at every docked POI), and never claims refuel " +
      "works when the reading is unknown -- fix round, #1116)",
    // Pins the fuel_cell branch's own condition, not just the call site --
    // the call site marker above survives a rename or a deletion of the
    // fuel_cell steer entirely (buyPriceGuard would still be called), so a
    // seam meant to hold THIS behaviour honest has to pin the behaviour
    // itself, the same distinction the withdrawStorageBlock comment draws
    // between wiring and existence.
    code: {
      file: "src/agent/executor.ts",
      marker: /p\.id === "fuel_cell" && preStatus\?\.docked === true/,
    },
    // Each anchor was absent from §4 before this bullet was added (checked,
    // not assumed, including against the pre-existing #458 bullet this one
    // extends). /station tank reading is above/ is the fix-round addition
    // (#1116 review): the ORIGINAL sentence said refuel steers "when the
    // current POI is confirmed to support it", true at every docked POI
    // since has_base cannot distinguish a stocked station from a dry one --
    // this anchor pins the corrected, tank-dependent wording so a revert
    // back to that vague phrasing fails here.
    anchors: [/weigh `refuel` FIRST/, /ESCROWS the bid until a seller/, /crossed with #681/,
      /obeyed verbatim and locked ~21,800cr/, /station tank reading is above/],
  },
  {
    guard: "item-id plan-admission guard (#982/#1003: a fabricated item id on buy/sell/jettison/" +
      "withdraw/deposit/create_sell_order/create_buy_order -- 'wreck' (a salvage ENTITY, never a " +
      "catalog item) and 'exotic_matter_sample' (no such id exists) -- is rejected before the step " +
      "reaches the executor; the only prior backstop was executor.ts's post-hoc, buy-only " +
      "nearestCatalogItemId correction, which never ran for the other six actions at all)",
    // Repointed by the #982/#1003 fix round: normalizePlanItems moved inside
    // normalize-plan.ts's admitPlan (folded with the location check, see
    // that function's docblock), so the old marker -- a literal
    // `normalizePlanItems(plan)` call in agent.ts -- no longer occurs in
    // that file at all and would fail even with the guard fully intact.
    // Repointed to the stronger invariant the fix round restores: the SAME
    // admitPlan call runs BOTH before the retry AND on the retry-reparsed
    // plan. The prior marker only pinned the first attempt, which is
    // exactly the gap the fix round closed -- a retry-reparsed plan used to
    // reach the executor with no re-validation at all. Verified by
    // ablation: reverting to only the FIRST `admitted = admitPlan(...)`
    // call (dropping the post-retry re-check, reproducing the fixed bug)
    // fails this marker, since the regex requires the call site to occur
    // twice with the second guarding a throw.
    code: {
      file: "src/agent/agent.ts",
      marker: /admitted = admitPlan\(plan, surroundings\);[\s\S]*?admitted = admitPlan\(plan, surroundings\);\s*if \(!admitted\.ok\) \{\s*throw new Error/,
    },
    // Each anchor was absent from §4 before this bullet was added (checked,
    // not assumed): 'wreck' and 'exotic_matter_sample' appear nowhere else in
    // section 4, and "WORLD OBJECT" is this bullet's own coinage.
    anchors: ["wreck", "exotic_matter_sample", "WORLD OBJECT", /plan-admission check rejects/],
  },
  {
    guard: "mine-objective buy-is-a-no-op teaching (#458: the digest's shortfall hint for a mine-type " +
      "objective now states that buying the item does not advance it -- a live capture on the same " +
      "issue bought 12 titanium_ore for 120,600cr and complete_mission was still blocked " +
      "'titanium_ore 8/20 (mine 12 more)' 41 seconds later)",
    // The literal shortfall-hint text the planner reads, the same choice the
    // deposits-too-sparse and Ore-VALUE seams above make (pin the rendered
    // STRING, not a comment near it) -- this lesson lives entirely in that
    // one string, so the string vanishing IS the lesson vanishing.
    code: { file: "src/planner/digest.ts", marker: "buying it does NOT advance this objective, only the mine action does" },
    anchors: ["titanium_ore 8/20 (mine 12 more)", /does NOT count toward a mine-type objective/i],
  },
  {
    guard: "craft deposit-precondition guard (#1076, dupes #932/#997: a craft whose personal " +
      "station storage provably holds NOTHING is refused before the tick -- 98+24+35 identical " +
      "cannot_craft failures across three 72h windows, and neither briefing ever taught the " +
      "planner that crafting reads storage, not cargo, before this fix)",
    // Pins the CALL SITE, the same shape every other seam in this file uses
    // (withdrawStorageBlock's comment explains why: the interior function
    // existing proves nothing if nothing calls it).
    code: { file: "src/agent/executor.ts", marker: /await craftDepositBlock\(api, step\)/ },
    // Each anchor was absent from §4 before this bullet was added (checked
    // against origin/main, not assumed).
    anchors: [
      "escrows its recipe's inputs from your STATION STORAGE",
      "Not enough materials in your station storage",
      /deliberately undocumented/,
    ],
  },
  {
    guard: "fleet-rescue distress briefing (#1114, the #703 gift path's read half: a distress fact " +
      "for a fleet-mate whose credits sit below the refuel floor, so a solvent pilot can think of a " +
      "rescue without a human steer)",
    // Pins the selection call site: the gather runs, and it is keyed on the
    // same condition the briefing above describes (credits below the refuel
    // floor -- round-2 PR #142 review dropped a bare zero-fuel reading as a
    // second trigger, since a credits gift can't fix it).
    code: {
      file: "src/agent/agent.ts",
      marker: /payload\.credits < FLEET_REFUEL_FLOOR_CR/,
    },
    // Each anchor was absent from §4 before this bullet was added (checked
    // against origin/main, not assumed).
    anchors: ["FLEET DISTRESS", /refuel floor/i, /MAYDAY/i],
  },
];

describe.skipIf(!docsPresent)("improv-briefing parity (issue #163)", () => {
  test("the spec keeps its §4 briefing and §5 backstops sections, in order", () => {
    expect(briefingStart).toBeGreaterThanOrEqual(0);
    expect(backstopStart).toBeGreaterThan(briefingStart);
  });

  for (const seam of SEAMS) {
    describe(seam.guard, () => {
      test("the deterministic guard still exists where the manifest says", () => {
        const source = read(seam.code.file);
        if (typeof seam.code.marker === "string") expect(source).toContain(seam.code.marker);
        else expect(source).toMatch(seam.code.marker);
      });

      test("its paired rule is present in the §4 standing briefing", () => {
        for (const anchor of seam.anchors) {
          if (typeof anchor === "string") expect(briefing).toContain(anchor);
          else expect(briefing).toMatch(anchor);
        }
      });
    });
  }

  // Chat channels need bullet scoping: bare channel words ("system", "local")
  // match the whole briefing trivially, so the five-channel enum is asserted
  // inside the single briefing bullet that talks about the chat target --
  // the same line-anchoring the digest tests use for this enum.
  describe("chat channel enum (registry CHAT_CHANNELS)", () => {
    test("the deterministic enum still exists in the registry", () => {
      expect(read("src/registry/actions.ts")).toContain("CHAT_CHANNELS");
    });

    test("the §4 briefing carries the five channels + target_id in its chat rule", () => {
      const bullets = briefing.split(/\r?\n- /);
      const chatRule = bullets.find((b) => /chat/i.test(b) && /target/i.test(b));
      expect(chatRule).toBeDefined();
      for (const ch of ["local", "system", "faction", "private", "emergency"]) {
        expect(chatRule!).toContain(ch);
      }
      expect(chatRule!).toContain("target_id");
    });
  });
});
