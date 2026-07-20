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
    code: { file: "src/agent/executor.ts", marker: 'step.action === "mine"' },
    anchors: [/mining laser/i, /fit/i],
  },
  {
    guard: "sell effect-verification (SM-9 phantom sells)",
    code: { file: "src/agent/executor.ts", marker: "verifySellEffect" },
    anchors: [/phantom/i, /re-query|confirm/i],
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
    guard: "complete_mission objective guard (#291 regression: current<required -> blocked wake before the doomed tick)",
    code: { file: "src/agent/executor.ts", marker: "completeMissionBlock" },
    anchors: ["complete_mission", /mission_incomplete/i, /before completing/i],
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
