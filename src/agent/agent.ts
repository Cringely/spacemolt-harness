import type { GameApi, StatusSnapshot, CargoItem, MarketRow, FittedModule, ShipFit, ActiveMissionInfo, PoiDepositsResult, LocationInfo } from "../client/client";
import type { Store, PlanCursor } from "../store/store";
import { PlanSchema, type Plan } from "../registry/plan";
import type { Planner, PlanContext, Surroundings, PreviousGoal, PurchaseEstimate, ActiveMissionStatus } from "../planner/types";
import { goalPurchaseCandidates } from "./goal-items";
import { TransientPlannerError, SubscriptionLimitError, TokenInvalidError } from "../planner/errors";
import { summarizeStatus, clipPlanContext, EXTRACTION_MODULE_BY_POI_TYPE } from "../planner/digest";
import { executeTick, miningEquipmentKey, type LearnedSparseRule } from "./executor";
import { failureClass } from "../server/failures";
import { evaluateWake, isNoBuyersBlock, NO_BUYERS_CLASS, blockedOutcomeKey, type BlockedOutcome, type WakeReason } from "./wake";
import { evaluateReflex, type ReflexConfig } from "./reflex";
import { normalizePlanLocations, type PlanRewrite } from "./normalize-plan";
import { extractChatMessages } from "./chat";
import { shouldEmitSnapshot, snapshotKey, type SnapshotThrottleState } from "./snapshot-throttle";
import { progressCountersTotal, progressCounters, skillsSignature, PROGRESS_COUNTERS } from "./no-progress-detector";
import {
  NO_PROGRESS_REPLANS, STRAND_FUEL_BLOCK_THRESHOLD, STRAND_SELF_DESTRUCT_WINDOW_MULT,
  progressFingerprint, progressGrandTotal, fuelBelowReserve, isStranded, noProgressJudge,
} from "./stall-monitor";
import type { EnvelopeNotification } from "../client/http";
import { AGENT_DEFAULTS, type DriverMode } from "../config/config";

export interface PlannerHealth {
  stalled: boolean;
  usingFallback: boolean;
  claudeDisabled: boolean;
  backoffUntil: number; // epoch ms; 0 means "not in backoff"
  consecutiveTransientFailures: number;
  // Layer 4 (no-progress detector): sticky flag set when the game-state
  // fingerprint stays identical across NO_PROGRESS_REPLANS replan boundaries
  // (a frozen-state freeze -- the low_fuel-livelock shape). Stays true until a
  // replan boundary observes a differing fingerprint, so the operator sees the
  // agent is stuck rather than merely momentarily quiet under backoff.
  stuck: boolean;
}

// The ship-vitals subset of the last StatusSnapshot the loop fetched, flattened
// for the dashboard (src/server/dashboard.html Overview cells + SHIP block).
// Retain-and-expose only: every field here is one runOnce() already pulls via
// api.status() each tick -- no new game call. `system` is StatusSnapshot's own
// systemId (the game's system id). No secrets: credits/fuel/hull/cargo/location
// carry no session token or key, so they're safe to serialize on /api/agents.
export interface AgentStatusView {
  credits: number;
  system: string | null;
  docked: boolean;
  inTransit: boolean;
  fuel: number;
  maxFuel: number;
  hull: number;
  maxHull: number;
  cargoUsed: number;
  cargoCapacity: number;
  cargo: CargoItem[];
  // Ship-details panel (operator request 2026-07-17): identity + fitting grid
  // + fitted modules, all retained from the SAME api.status() fetch the loop
  // already makes each tick -- no new game call. Optional: undefined means the
  // game's status didn't carry the block (UNKNOWN, the dashboard renders
  // nothing rather than fabricating "empty"). No secrets: class/module names
  // and grid numbers carry no session token or key.
  shipName?: string;
  shipClass?: string;
  fit?: ShipFit;
  modules?: FittedModule[];
}

export interface AgentSnapshot {
  id: string;
  planState: "none" | "running" | "done" | "blocked";
  blockedReason?: string;
  goal?: string;
  stepIndex?: number;
  totalSteps?: number;
  goals: string[];
  plannerHealth: PlannerHealth;
  // Null until the first successful api.status() fetch (see runOnce()).
  status: AgentStatusView | null;
}

export interface AgentConfig {
  fuelPct: number;
  hullPct: number;
  heartbeatMinutes: number;
  wakeNotificationTypes: string[];
  stallThreshold: number;              // consecutive transient failures before a "stalled" event
  subscriptionCooldownMinutes: number; // cooldown when no fallback planner is configured
  reflex?: ReflexConfig;
  // Layer 3 (per-agent rolling ceiling): hard cap on replan batches per
  // trailing window. Optional so AgentConfig literals built directly in tests
  // don't all need updating; production always passes explicit values wired
  // from agents.yaml (config.ts). Defaults below mirror the config schema.
  maxPlansPerWindow?: number;
  planBudgetWindowMinutes?: number;
  // stall-watcher v4. All optional so test AgentConfig literals need no update;
  // loadConfig (config.ts) always supplies concrete values.
  //   fuelReservePct       -- undocked fuel-reserve floor (strand prevention).
  //   stuckWindowMinutes   -- the long no-progress / steward window.
  //   strandAutoSelfDestruct -- opt-in: let the steward auto-destroy a
  //                             hopelessly-stranded ship (default OFF; by
  //                             default it only distress-calls + alerts).
  fuelReservePct?: number;
  stuckWindowMinutes?: number;
  strandAutoSelfDestruct?: boolean;
  // Progress-heartbeat cadence (minutes). Optional so test AgentConfig literals
  // need no update; loadConfig (config.ts) always supplies a concrete value.
  // The heartbeat only REPORTS a per-window progress delta -- it never acts.
  progressHeartbeatMinutes?: number;
  // Deterministic A/B exit (#240/#251): revert to fallbackPlanner when the
  // named progress counter ("any" = the PROGRESS_COUNTERS sum) hasn't advanced
  // within withinHours. Absent = no experiment running (the default).
  experiment?: { revertIfNo: string; withinHours: number };
  // Same-error-repeat loop-breaker (#95). Both optional so test AgentConfig
  // literals need no update; loadConfig (config.ts) always supplies concrete
  // values. See config.ts's AGENT_DEFAULTS for the tuning receipts.
  repeatBlockThreshold?: number;
  repeatBlockWindowMinutes?: number;
}

// Layer 3 defaults (max_plans_per_window / plan_budget_window_minutes) live in
// config.ts's AGENT_DEFAULTS -- one source for the Zod loader default and this
// runtime fallback. The fallback applies only when an AgentConfig is constructed
// without them (tests); loadConfig always supplies concrete values.

// 30s base: a few ticks, not an instant hammer on a possibly-recovering
// network. 10min cap: keeps backoff from drifting far past the default
// 15-minute heartbeat, so the two retry mechanisms stay roughly in step
// instead of fighting each other.
const TRANSIENT_BACKOFF_BASE_MS = 30_000;
const TRANSIENT_BACKOFF_MAX_MS = 10 * 60_000;

// Invariant: 3 consecutive wakes sharing the same "reason:detail" identity
// (blocked-reason repetition, or plan_done repeating the identical goal) arm
// a plan-call cooldown -- tolerates one exploratory recovery step, catches a
// real thrash loop before it burns the plan budget. See docs/decisions.md
// (2026-07-10, F-3; 2026-07-13, issue #146) for the incident history.
const BLOCKED_THRASH_THRESHOLD = 3;

// Same-error-repeat loop-breaker (issue #95). The GENERAL mechanism the
// consecutive thrash damper above is a special case of: K identical blocked
// (action, normalized-target) outcomes with no same-key SUCCESS in between
// break the loop -- even while other progress dimensions climb (the #291
// mission mask). The consecutive damper catches only CONSECUTIVE same-REASON
// streaks, which an interleaved retry (the doomed action fired with other work
// between attempts) defeats: the streak resets and only the slow stall window
// escapes. See blockedOutcomeKey (wake.ts) for the stable key this counts.
// The two tuning values (threshold 3, window 30) and their receipts live in
// config.ts's AGENT_DEFAULTS (repeatBlockThreshold / repeatBlockWindowMinutes):
// the threshold rules out a one-off blip while catching the loop early (mirrors
// BLOCKED_THRASH_THRESHOLD); a same-key SUCCESS resets the running count; and
// the window is a re-steer cooldown, NOT an accrual bound (#291 third
// occurrence: accrual runs since the last same-key success, however slow).

// The payload shape of the `action` events the loop-breaker (#95) counts,
// emitted in executeOne. All fields optional: the breaker reads persisted
// events, and an older or foreign action event may lack a field -- it is
// skipped (schema tolerance), never a crash.
interface ActionEventPayload {
  action?: string;
  params?: unknown;
  outcome?: string;
  result?: string;
}

// NO_PROGRESS_REPLANS, STRAND_FUEL_BLOCK_THRESHOLD and
// STRAND_SELF_DESTRUCT_WINDOW_MULT moved to stall-monitor.ts (the pure
// stall-watcher substrate) and are imported above -- they are stall-internal,
// not agent tuning defaults. The two tuning defaults the stall path also needs
// -- fuelReservePct and stuckWindowMinutes -- plus the progress-heartbeat
// cadence live in config.ts's AGENT_DEFAULTS (one source for the Zod loader
// default and this runtime fallback); agent.ts passes them into the
// stall-monitor functions. The fallback applies only when an AgentConfig is
// built without the field (tests); loadConfig always supplies concrete values.
// Payload labels for the heartbeat's two slow dimensions (the steward's cached
// skill-level signature and achievements-earned count). Labels only: the
// progressing/stalled VERDICT comes from progressGrandTotal (the stall-watcher's
// own scalar), so a dimension added there later is judged here on day one even
// before it gets a payload line of its own. Neither name is a game stat key,
// and the delta loop iterates an allowlist, so collision is impossible anyway.
const HEARTBEAT_SLOW_DIMS = ["skill_levels", "achievements_earned"] as const;
// Movement actions whose fuel-blocks feed the strand signal (travel_to expands
// into jumps; jump/travel are the raw registry verbs).
const MOVEMENT_ACTIONS = new Set(["travel_to", "jump", "travel"]);

// Deterministic server-failure retry (#431, live 2026-07-19: each travel 503
// bought a full ~19.5k-char planner call whose new plan re-issued the
// byte-identical step; second occurrence of the class after the 2026-07-13
// travel/get_status 503 cluster). A MOVEMENT step (MOVEMENT_ACTIONS) whose
// call dies on the transport's transient-server class (executor
// `server_retry` -- 5xx / network / open breaker) is resubmitted unchanged;
// the planner wakes only when the cap is spent. Non-movement mutations are
// deliberately excluded -- see the #137 gate in executeOne.
// 3 total submissions: each one already sits behind http.ts's own 3 in-call
// transport retries (~1s/2s/4s), so 3 step attempts ~= 9 transport tries
// spread over ~1.5 min -- a 503 that survives that is an outage, and the
// blocked wake is then the right escalation, not more silence.
export const SERVER_RETRY_MAX_ATTEMPTS = 3;
// 2 ticks (~20s at the 10s tick) between submissions: with http.ts's ~7s of
// in-call backoff on top, attempts land ~27s apart -- inside #431's suggested
// 2-3 ticks, long enough for a server restart blip, and a fraction of the
// ~4-min replan cycle it replaces.
export const SERVER_RETRY_BACKOFF_TICKS = 2;

// Observability (SM-11): cap on the notification-dedupe set (see
// seenNotificationIds). 10x the game's ~50-notification recent batch, so an id
// evicted at this bound is far past the newest window and can't reappear.
const SEEN_NOTIFICATIONS_MAX = 500;

// Instruction supersession (issue #186, live 2026-07-13): every operator
// instruction used to accrue into `goals` forever (until restart), and the
// digest spliced them all in with no recency signal -- so a stale "ignore
// Palladium Ore" steer outvoted the operator's newer contradicting "sell
// palladium if a buyer is detected" (events 12418->12424). Invariant: a newer
// operator instruction beats an older conflicting one. Two-part fix: the
// digest briefs goals NEWEST-FIRST with an explicit supersession rule
// (digest.ts), and this cap bounds the retained history so stale steers age
// out instead of accumulating unboundedly -- when the cap evicts, it evicts
// oldest. 5 because steers arrive rarely (a handful per session, operator-
// typed) and the incident's stale steer was many instructions old: 5 keeps a
// session's worth of live intent while guaranteeing the list can't grow into
// an archive of expired steers. Enforced at both producers of `goals`: the
// replan() push and the constructor's persisted-goals reload (a stored list
// written before this cap may exceed it; trimming on load keeps the invariant
// without any schema change -- goals stay a plain string[]).
const MAX_GOALS = 5;

// POI-extraction backstop (issue #253): cap on the learned incompatible-POI
// map, oldest-evicted like MAX_GOALS. 32 because the memory only needs to
// cover POIs the pilot actually revisits (a system holds ~5-10 POIs, and the
// pilot works a handful of systems), while a bound guarantees a long-lived
// pilot can't grow an unbounded map -- the same reasoning that sized the
// goals cap. Enforced at both producers: learnIncompatiblePoi's set and the
// constructor's persisted-events reload (which passes it as the query LIMIT).
const MAX_INCOMPATIBLE_POIS = 32;

// Learned sparse-deposit rules (issue #188, part 3): cap and TTL for the
// per-(POI, mining-fit) too-sparse memory behind the executor's learned mine
// refusal and the digest's [mine learned-blocked ...] marker.
//   MAX_SPARSE_RULES (32): same sizing receipt as MAX_INCOMPATIBLE_POIS
//     directly above -- the memory only needs the POIs a pilot revisits.
//   SPARSE_RULE_TTL_HOURS (6): deposits REGENERATE (mining.md:3, "depletes as
//     players work it and regenerates slowly over time" -- rate undocumented),
//     so a permanent rule would eventually block a recovered belt. The
//     observed repeat cadence for this failure class is minutes-to-hours
//     (#291's loop ran one doomed attempt every 20-40min; the 2026-07-13
//     incident repeated within a session), so 6h kills every observed repeat
//     loop; after expiry, one probe mine re-learns the rule if the deposit is
//     still sparse -- the same one-tick tuition the first encounter cost,
//     paid at most once per 6h per (POI, fit). A cadence throttle over a
//     change signal the game does not expose (fix-quality: cadence beats a
//     dirty-key you cannot enumerate).
const MAX_SPARSE_RULES = 32;
const SPARSE_RULE_TTL_HOURS = 6;

// The too-sparse refusal class, matched via the SAME classifier the failure
// taxonomy uses (failureClass, src/server/failures.ts: /deposits too sparse|
// beam disperses/i -> "too_sparse") so the learner and the dashboard can
// never disagree about what counts as this class.
const TOO_SPARSE_CLASS = "too_sparse";

// POI-extraction backstop (issue #253): the game's extraction-refusal shape,
// VERIFIED live 2026-07-14 (events store, deploy dev-2026-07-14T15:51:47Z):
// `mine` at a gas POI with only a mining laser blocks with "You need a gas
// harvester module to collect resources here" (27x gas + 12x ice in 72h).
// The "to collect resources" tail is load-bearing: it scopes the match to
// POI-specific extraction refusals, so ship-wide module errors that share the
// "need a ... module" prefix (e.g. survey_system's missing survey scanner, or
// our own executor mine-guard text "a mine action NEEDS a mining laser
// module") can never mark a POI incompatible. The capture is constrained to
// lowercase letters/spaces, bounded at 40 chars -- game text, but safe to
// interpolate in the digest after this filter.
const EXTRACTION_BLOCK_RE = /you need an? ([a-z][a-z ]{2,40}?) module to collect resources/i;

// progressFingerprint (the Layer-4 salient-state fingerprint) moved to
// stall-monitor.ts and is imported above.

export class Agent {
  readonly id: string;
  private persona: string;
  private api: GameApi;
  // Improv seam (improv-mode plan Batch B). The Agent may hold BOTH the
  // plan-then-execute driver (`api`, over HTTP) and the improv driver
  // (`improvApi`, over MCP) at once — Batch 0 proved the two sessions coexist, so
  // there is no teardown/handover. `mode` selects which one drives; `activeApi()`
  // resolves it. The plan-then-execute loop (runOnce) deliberately keeps using
  // `this.api` directly and is UNCHANGED by this seam — Batch C flips runOnce to
  // dispatch to an ImprovController via `activeApi()` when mode is "improv". Until
  // then an improv-configured agent still runs plan-then-execute; the improv LOOP
  // is Batch C. `improvApi` is undefined for a plan-then-execute-only agent.
  private improvApi?: GameApi;
  private mode: DriverMode;
  private store: Store;
  private planner: Planner;
  private fallbackPlanner?: Planner;
  private config: AgentConfig;
  private now: () => number;

  private inbox: string[] = [];
  private plan: Plan | null = null;
  private cursor: PlanCursor = { step: 0, iteration: 0 };
  private goals: string[] = [];
  // Standing goals from agents.yaml (#216): the durable source mergeStandingGoals
  // re-applies at construction and at every replan. Held separately from
  // this.goals because the goals list is push-evicted (#186) and re-persisted;
  // the config list is the fixed point the merge restores from.
  private standingGoals: string[] = [];
  private planState: "none" | "running" | "done" | "blocked" = "none";
  private blockedReason?: string;
  private lastPlanAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  // One-shot "the last action was accepted but is still resolving, so skip
  // the next submission" flag; consumed on the very next executeOne (see the
  // settle branch there). See docs/archive/decisions-2026-07-12.md (2026-07-12,
  // "Pacing repeated actions to the game tick", SM-12) for the incident and
  // rejected alternatives.
  private awaitingResolution = false;

  // #431: consecutive transient-server (`server_retry`) failures of the
  // CURRENT step, counted in executeOne where the outcomes surface. Reset by
  // ANY other outcome (mirrors fuelBlockedMoves: the count must mean "N
  // server-failed submissions in a row with nothing in between") and by
  // replan() (a fresh plan's step is a fresh episode). serverRetryHoldTicks
  // paces the retries: while >0, executeOne spends the tick as a `wait`
  // instead of resubmitting. Both in-memory only, deliberately unpersisted
  // (persisted-state rule untouched): a restart forgets the episode, and the
  // worst case is extra retries -- never an extra planner wake.
  private serverRetries = 0;
  private serverRetryHoldTicks = 0;

  // Last successful api.status() fetch, retained purely so snapshot() can hand
  // the dashboard real ship vitals (credits/fuel/hull/cargo/system). Nothing in
  // the loop reads it -- it is write-only from runOnce() and read-only from
  // snapshot(). Null until the first successful fetch. See runOnce() for why a
  // failed fetch (status null) leaves the previous known-good value in place.
  private lastStatus: StatusSnapshot | null = null;

  // Observability (SM-11): the per-tick LEDGER baseline -- the PREVIOUS status
  // this agent diffed against, so a cargo-item quantity rise or a credit change
  // surfaces as a compact `ledger` delta event ("+3 Carbon Ore, cargo 8->11",
  // "+4cr", "-186cr"). This is the reliable answer to "how much ore per tick,
  // which resource, sell revenue" because `mine`'s yield resolves a tick LATER,
  // in status, not in the action result. Separate from lastStatus on purpose:
  // lastStatus is a display cache the loop overwrites every good tick, whereas
  // this must hold the prior value long enough to compute the delta. In-memory
  // and minimal (like the heartbeat baseline): a restart re-seeds on the first
  // status it sees and the next real change emits -- an acceptable one-tick gap
  // over a process boundary versus persisting a baseline whose only payoff is a
  // single seamless delta across restarts. Moves only in maybeEmitLedger.
  private ledgerBaseline: StatusSnapshot | null = null;

  // Observability (SM-11): ids of game notifications already surfaced as
  // `notification` events, so the SAME notification isn't re-emitted on every
  // poll (the game returns the recent batch each tick until entries age out).
  // Insertion-ordered and capped (SEEN_NOTIFICATIONS_MAX) so a long-running
  // process can't grow it without bound: the game returns at most ~50 recent
  // notifications, so a 10x cap guarantees an aged-out id never reappears once
  // evicted. Written only in the notification-emit block in runOnce().
  private seenNotificationIds = new Set<string>();

  // status_snapshot throttle state (SM-10). Null until the first snapshot is
  // emitted this process. Read and written only in the emit block in runOnce()
  // -- see snapshot-throttle.ts for the "once per 60s OR on salient change"
  // rule this drives. Separate from Layer-4/wake state on purpose: it gates
  // telemetry recording, not replanning.
  private snapshotThrottle: SnapshotThrottleState | null = null;

  // failure-classification state (Plan 2 Task 4)
  private consecutiveTransientFailures = 0;
  private plannerBackoffUntil = 0;
  private stalled = false;
  private usingFallback = false;
  private claudeDisabled = false;

  // Thrash damping: count of consecutive wakes sharing the same "identity"
  // (see BLOCKED_THRASH_THRESHOLD above). Both fields are read and written
  // together, only in runOnce()'s "blocked"/"plan_done" wake branch --
  // intra-plan progress (successful steps between blocks) touches neither.
  private consecutiveThrashWakes = 0;
  private lastThrashKey: string | undefined;

  // Same-error-repeat loop-breaker (#95). lastRepeatBreakAt/Key latch the
  // re-steer to at most once per key per window -- a damped duty cycle, like
  // the thrash damper's post-arm reset -- so a still-looping planner is
  // re-steered at a bounded cadence, never every tick. repeatBreakFloorTs is
  // the coordination with the consecutive thrash gate: when THAT gate arms it
  // OWNS the episode, so the floor advances to now and the windowed breaker
  // ignores the blocks it already handled -- the same double-arm guard the gate
  // applies to Layer 4. All read/written only in runOnce's blocked-wake path.
  private lastRepeatBreakAt = Number.NEGATIVE_INFINITY;
  private lastRepeatBreakKey: string | undefined;
  private repeatBreakFloorTs = Number.NEGATIVE_INFINITY;

  // Layer 3: throttle so plan_budget_exceeded is emitted once per over-budget
  // episode, not once per capped tick. Cleared the moment the trailing window
  // drains back under the ceiling and a replan is permitted again.
  private planBudgetExceeded = false;

  // Layer 4 (no-progress detector): the previous replan boundary's fingerprint
  // and a run-length count of identical ones. `stuck` is the sticky operator
  // signal exposed via snapshot()'s PlannerHealth. All three move together only
  // at the replan boundary in runOnce() -- see the Layer 4 block there.
  private lastFingerprint: string | undefined;
  private noProgressReplans = 0;
  private stuck = false;

  // SM-6 fix: executeOne()'s "plan_done" branch nulls this.plan out (see
  // below) before replan() ever runs for the resulting "plan_done" wake, so
  // the completed plan's goal would otherwise be unrecoverable by the time
  // derivePreviousGoal() needs it. Captured at the moment of completion,
  // nowhere else -- see derivePreviousGoal for the read side.
  private lastCompletedGoal: string | undefined;

  // stall-watcher v4 steward + strand state.
  // cachedSkillsSig / cachedAchievementsEarned: last-known slow-dimension
  // values, sampled on the snapshot throttle cadence (sampleSlowProgressDims).
  // null = UNKNOWN (never sampled, method absent, or the query threw) -> the
  // no-progress judge fails safe and suppresses.
  private cachedSkillsSig: number | null = null;
  private cachedAchievementsEarned: number | null = null;
  // The monotonic progress scalar last observed, and WHEN it last advanced.
  // "Stuck" is measured as (now - lastProgressAt) >= the stuck window. Both move
  // together only in runSteward.
  private lastProgressTotal: number | undefined;
  private lastProgressAt: number | undefined;
  // Consecutive fuel-blocked movement attempts (strand behavioral signal),
  // counted in executeOne where the blocks are produced -- NOT in the wake
  // branch, so the count survives even when the thrash damper would otherwise
  // arm and return first.
  private fuelBlockedMoves = 0;
  // Whether the CURRENT POI has a refuelling base (cached from gatherSurroundings'
  // get_system). A base here means the docked reflex can refuel, so it is NOT a
  // strand; false (incl. unknown) leaves the behavioral signal to decide.
  private currentPoiHasBase = false;
  // POI-extraction backstop (issue #253): poiId -> the module the game named
  // when a mine there blocked ("gas harvester", "ice harvester"). The map
  // memory behind the digest's [mine blocked here ...] marker -- the
  // deterministic lesson that stops a replan loop at a POI whose type the
  // digest's type-derived markers don't cover. Bounded (MAX_INCOMPATIBLE_POIS,
  // oldest-evicted) and restart-safe: rebuilt in the constructor from
  // persisted poi_incompatible events (store.recentEventsByType), the same
  // events-table-as-durable-state pattern as countWakesSince. Entries
  // self-heal: applyIncompatiblePois drops an entry once a matching module is
  // fitted, because incompatibility is a fact about (POI, ship fit), not the
  // POI alone -- the fitted set is a dynamic input, so a fit change must
  // invalidate (simplicity rule 5: enumerate every cache input).
  private incompatiblePois = new Map<string, string>();
  // Learned sparse-deposit rules (issue #188, part 3): poiId -> the mining-fit
  // key + clipped game text + learn time of a "deposits too sparse" refusal
  // the game taught there. Feeds the executor's learned mine refusal (as
  // plain, TTL-filtered data -- see currentSparseRules) and the digest's
  // [mine learned-blocked ...] marker (applySparseMarkers). Bounded
  // (MAX_SPARSE_RULES, oldest-evicted) and restart-safe via persisted
  // mine_sparse_learned events, the same events-table-as-durable-state
  // pattern as incompatiblePois above. Invalidation is two-fold, matching the
  // rule's two cache inputs (simplicity rule 5): the mining FIT is captured
  // in the key (a refit stops the match), and the DEPOSIT state -- which
  // regenerates with no change signal -- ages out on SPARSE_RULE_TTL_HOURS.
  private sparseRules = new Map<string, { equipmentKey: string; detail: string; learnedAt: number }>();
  // Rung-1 latch: the timestamp of the last steward re-steer. THE bound on the
  // instruction-class re-steer burn (see runSteward). Gated now - last >= window.
  // Seeded to -Infinity ("never steered") so the FIRST re-steer is always
  // allowed the moment a condition is confirmed -- otherwise a run starting near
  // t=0 (tests, or a fresh process) would wrongly wait a full window before the
  // first nudge.
  private lastStewardSteerAt = Number.NEGATIVE_INFINITY;
  // Strand escalation bookkeeping: when the strand was first confirmed, whether
  // the rung-2 no-progress alert has fired this episode, and whether the
  // (opt-in) self_destruct has fired this strand.
  private strandedSince: number | undefined;
  private stuckAlerted = false;
  private selfDestructFired = false;

  // Progress heartbeat (dashboard-visible pilot-progress validation). A
  // deterministic, always-on pulse: every progressHeartbeatMinutes it emits a
  // progress_heartbeat event whose progressing/stalled verdict is the
  // stall-watcher's OWN scalar (progressGrandTotal: PROGRESS_COUNTERS + skill
  // levels + achievements earned -- #96), so the heartbeat and the steward
  // cannot disagree on what "progress" means. It REPORTS ONLY; acting on a
  // stall stays the steward's job.
  //
  // In-memory cursor by choice (KISS): a restart just re-baselines against the
  // first measurable status it sees and the next heartbeat fires a window later
  // -- an acceptable one-window gap on the rare restart, versus a persisted
  // baseline whose only payoff is a single seamless window across process
  // boundaries. progressHeartbeatBaseline holds the per-dimension values AND
  // the grand-total scalar captured at the last heartbeat (or the seed) -- one
  // object so the two can never desync; progressHeartbeatAt is when that
  // baseline was taken. Both move together, only in maybeEmitProgressHeartbeat.
  private progressHeartbeatBaseline: { dims: Record<string, number>; total: number } | undefined;
  private progressHeartbeatAt = 0;

  // Deterministic A/B exit (#240, the #251 lesson). experimentReverted is a
  // ONE-WAY latch: once the configured revert condition trips, activePlanner()
  // serves fallbackPlanner for the rest of the experiment -- later progress
  // under the fallback must never flap the agent back onto the planner under
  // test (that progress is the FALLBACK's, not evidence the experiment
  // recovered). Durable across restarts via the events table (the
  // poi_incompatible pattern): the constructor re-latches from a persisted
  // experiment_reverted event whose payload matches the CURRENT experiment
  // config, so a harness restart doesn't silently grant the failed planner a
  // fresh trial -- only an actual config change (new counter or window) does.
  // Baseline/lastAdvanceAt mirror the steward's fail-safe semantics: unknown
  // stats refresh the clock (never accumulate a revert window across a gap),
  // any value CHANGE re-seeds.
  private experimentReverted = false;
  private experimentBaselineValue: number | undefined;
  private experimentLastAdvanceAt: number | undefined;

  constructor(opts: {
    id: string; persona: string; api: GameApi; store: Store;
    planner: Planner; fallbackPlanner?: Planner; config: AgentConfig; now?: () => number;
    // Standing goals from agents.yaml (#216): merged into the structured goal
    // channel below. Optional so existing constructions (tests, agents with no
    // goals: block) are untouched.
    goals?: string[];
    // Improv seam (Batch B). Optional so every existing Agent construction (tests,
    // plan-then-execute-only agents) is untouched. `improvApi` is the MCP-backed
    // GameApi; `mode` defaults to "plan-then-execute".
    improvApi?: GameApi; mode?: DriverMode;
  }) {
    this.id = opts.id;
    this.persona = opts.persona;
    this.api = opts.api;
    this.improvApi = opts.improvApi;
    this.mode = opts.mode ?? "plan-then-execute";
    this.store = opts.store;
    this.planner = opts.planner;
    this.fallbackPlanner = opts.fallbackPlanner;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    // crash recovery: resume persisted plan mid-step. lastPlanAt starts at
    // now() so a restart doesn't fire an immediate heartbeat that would
    // discard the resumed cursor. Documented deviation from the spec's
    // restart-wake: we resume silently; the next blocked step or heartbeat
    // re-engages the planner, which re-validates against fresh state.
    this.lastPlanAt = this.now();
    // Seed the heartbeat clock to construction time so the first progress
    // heartbeat fires one full window in, not immediately (the baseline is
    // seeded lazily on the first status with stats).
    this.progressHeartbeatAt = this.now();
    const saved = this.store.loadPlan(this.id);
    if (saved) {
      this.plan = saved.plan;
      this.cursor = saved.cursor;
      // Cap on load too (issue #186): a persisted goals list written before
      // the cap existed (or by a future config with a larger one) may exceed
      // MAX_GOALS -- keep the newest, same eviction order as the push side.
      this.goals = saved.goals.slice(-MAX_GOALS);
      this.planState = "running";
    }
    // Standing config goals (#216): merge into the structured goal channel at
    // load, alongside -- never instead of -- the persisted goals. Invariant: a
    // stated standing objective lives in this.goals DURABLY across the
    // agent's runtime lifecycle, where the digest's Goals section and
    // goalPurchaseCandidates act on it; persona prose is invisible to both
    // (the Mining Laser III milestone sat there 35h+ unacted-on). The same
    // merge re-runs at the top of every replan -- see mergeStandingGoals for
    // the semantics and the runtime-eviction hole it closes.
    this.standingGoals = opts.goals ?? [];
    this.mergeStandingGoals();
    // POI-extraction backstop (issue #253): rebuild the incompatible-POI map
    // from persisted events so a restart doesn't forget a lesson the pilot
    // already paid a blocked plan for (the live incident: a restart came back
    // up AT the same gas-only POI and re-blocked within 11 seconds). Tolerant
    // loader per the persisted-state schema-tolerance convention: a payload
    // that doesn't carry both strings (older schema, hand-edited store,
    // future shape change) is SKIPPED, never a crash.
    for (const e of this.store.recentEventsByType(this.id, "poi_incompatible", MAX_INCOMPATIBLE_POIS)) {
      const p = e.payload as { poiId?: unknown; module?: unknown } | null;
      if (p && typeof p.poiId === "string" && typeof p.module === "string") {
        this.incompatiblePois.set(p.poiId, p.module);
      }
    }
    // Learned sparse-deposit rules (issue #188): rebuild from persisted
    // events, same pattern and same tolerant-loader discipline as the
    // poi_incompatible reload above -- a payload missing either string is
    // SKIPPED, never a crash. learnedAt comes from the event's own stored ts,
    // so the TTL keeps aging across restarts instead of resetting.
    for (const e of this.store.recentEventsByType(this.id, "mine_sparse_learned", MAX_SPARSE_RULES)) {
      const p = e.payload as { poiId?: unknown; equipmentKey?: unknown; detail?: unknown } | null;
      if (p && typeof p.poiId === "string" && typeof p.equipmentKey === "string") {
        this.sparseRules.set(p.poiId, {
          equipmentKey: p.equipmentKey,
          detail: typeof p.detail === "string" ? p.detail : "",
          learnedAt: e.ts,
        });
      }
    }
    // Experiment latch (#240): re-latch from a persisted experiment_reverted
    // event, but only when its payload matches the CURRENT experiment config --
    // an operator who changes the counter or window has started a NEW
    // experiment and gets a fresh trial. Tolerant loader per the
    // persisted-state convention: a payload missing either field is skipped,
    // never a crash.
    if (this.config.experiment) {
      for (const e of this.store.recentEventsByType(this.id, "experiment_reverted", 10)) {
        const p = e.payload as { counter?: unknown; withinHours?: unknown } | null;
        if (p && p.counter === this.config.experiment.revertIfNo && p.withinHours === this.config.experiment.withinHours) {
          this.experimentReverted = true;
          break;
        }
      }
    }
  }

  instruct(text: string): void {
    this.inbox.push(text);
  }

  // Standing-goal merge (#216): idempotent, so it runs at construction AND at
  // the top of every replan. Dedupe by exact string: savePlan persists
  // this.goals, so after one run the persisted list already CONTAINS the
  // standing goals and a re-merge must not re-append them. Fresh goals take
  // the FRONT (oldest) slots -- the digest briefs newest-first with
  // newer-supersedes-older, so a later operator steer outranks the standing
  // baseline. On overflow the OLDEST persisted steers are evicted (same
  // direction as the push side), never the standing goals.
  //
  // Why re-merge instead of tagging goals with a source field (PR #294
  // REVISE, HIGH): the push-side #186 eviction is standing-goal-blind, so 5
  // operator steers since the last restart silently evicted the standing goal
  // until the next restart re-merged it. A source tag would fix eviction at
  // its site but changes the goal shape everywhere it flows -- savePlan/
  // loadPlan rows, snapshot(), the digest renderer, every goals fixture --
  // for the same end state this one extra call of the already-shipped merge
  // restores each pass.
  private mergeStandingGoals(): void {
    const fresh = this.standingGoals.filter((g) => !this.goals.includes(g));
    if (!fresh.length) return;
    const keep = Math.max(0, MAX_GOALS - fresh.length);
    this.goals = [...fresh.slice(0, MAX_GOALS), ...(keep ? this.goals.slice(-keep) : [])];
  }

  // --- Improv driver-mode seam (Batch B) -----------------------------------
  // The switch primitive Batch C's ImprovController and Batch E's window
  // triggers/reversion consume. Kept tiny and side-effect-free: flipping the mode
  // is a pointer flip, NOT a session handover — both the HTTP and MCP GameApi
  // stay held and live (Batch 0 finding #3), so a revert is just setMode back.

  getMode(): DriverMode {
    return this.mode;
  }

  /** Flip the driving mode. A no-op teardown by design: neither client is torn
   * down, so switching modes cannot invalidate the other session (concurrent-
   * capable). Ignores a request to enter "improv" with no improv client wired
   * (stays plan-then-execute) so a misconfiguration degrades safely rather than
   * driving a null api. */
  setMode(mode: DriverMode): void {
    if (mode === "improv" && !this.improvApi) return;
    this.mode = mode;
  }

  /** The GameApi that drives under the current mode: the MCP-backed improv client
   * when mode is "improv" (and one is wired), else the HTTP plan-then-execute
   * client. runOnce() still uses `this.api` directly until Batch C wires the
   * improv loop; this is the accessor that loop will call. */
  activeApi(): GameApi {
    return this.mode === "improv" && this.improvApi ? this.improvApi : this.api;
  }

  /**
   * Read-only introspection surface for the dashboard server (Plan 3 Task 1).
   * Deliberately narrow: exposes only status/plan/goal/step and the planner
   * health the flight campaign named as required observability (docs/STATE.md
   * 2026-07-10: "sticky-flag observability + recovery") -- the
   * claudeDisabled/usingFallback/backoffUntil fields that let an operator see
   * WHY an agent stopped calling its primary planner, without restarting it
   * to find out. Never exposes api/store/planner instances, inbox contents,
   * or the F-3/SM-9 thrash-damper's internal counters (consecutiveThrashWakes,
   * lastThrashKey) -- those have no dashboard consumer today; add one here
   * only alongside a render consumer in Task 4, not on spec.
   */
  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      planState: this.planState,
      blockedReason: this.blockedReason,
      goal: this.plan?.goal,
      stepIndex: this.plan ? this.cursor.step : undefined,
      totalSteps: this.plan?.steps.length,
      goals: [...this.goals],
      plannerHealth: {
        stalled: this.stalled,
        usingFallback: this.usingFallback,
        claudeDisabled: this.claudeDisabled,
        backoffUntil: this.plannerBackoffUntil,
        consecutiveTransientFailures: this.consecutiveTransientFailures,
        stuck: this.stuck,
      },
      status: this.lastStatus
        ? {
            credits: this.lastStatus.credits,
            system: this.lastStatus.systemId ?? null,
            docked: this.lastStatus.docked,
            inTransit: this.lastStatus.inTransit,
            fuel: this.lastStatus.fuel,
            maxFuel: this.lastStatus.maxFuel,
            hull: this.lastStatus.hull,
            maxHull: this.lastStatus.maxHull,
            cargoUsed: this.lastStatus.cargoUsed,
            cargoCapacity: this.lastStatus.cargoCapacity,
            cargo: this.lastStatus.cargo ?? [],
            shipName: this.lastStatus.shipName,
            shipClass: this.lastStatus.shipClass,
            fit: this.lastStatus.fit,
            modules: this.lastStatus.modules,
          }
        : null,
    };
  }

  private emit(type: string, payload: unknown): void {
    this.store.appendEvent({ agentId: this.id, ts: this.now(), type, payload });
  }

  // Observability (SM-11): emit each not-yet-seen game notification once, keyed
  // on its stable id, and bound the dedupe set. Payload keeps the fields a human
  // reading the feed needs (type/msg_type/timestamp/data) -- data is game result
  // content (yields, sale proceeds, combat), carrying no session token or key.
  private emitNewNotifications(notifications: EnvelopeNotification[]): void {
    for (const n of notifications) {
      if (this.seenNotificationIds.has(n.id)) continue;
      this.seenNotificationIds.add(n.id);
      // Evict the oldest id (insertion order) once over the cap.
      if (this.seenNotificationIds.size > SEEN_NOTIFICATIONS_MAX) {
        const oldest = this.seenNotificationIds.values().next().value;
        if (oldest !== undefined) this.seenNotificationIds.delete(oldest);
      }
      this.emit("notification", {
        id: n.id, notifType: n.type, msgType: n.msg_type, timestamp: n.timestamp, data: n.data,
      });
    }
  }

  // Observability (SM-11): the per-tick ledger. Diff this status against the
  // retained baseline and emit a compact `ledger` delta when credits changed or
  // any cargo item's quantity moved. First call only seeds the baseline (nothing
  // to diff). Cargo is diffed by itemId so a rename can't masquerade as a change;
  // an item that vanished entirely (fully sold/dropped) reads as a negative delta
  // to its prior quantity. cargoUsed from/to rides along only when cargo moved,
  // to render the "cargo 8->11" context. Deliberately a DELTA, never absolutes --
  // status_snapshot already carries the absolute series (and is hidden by
  // default), so the two never double-count.
  private maybeEmitLedger(status: StatusSnapshot): void {
    const prev = this.ledgerBaseline;
    this.ledgerBaseline = status;
    if (!prev) return; // first tick: seed only

    const creditDelta = status.credits - prev.credits;

    const prevByItem = new Map<string, CargoItem>();
    for (const it of prev.cargo ?? []) prevByItem.set(it.itemId, it);
    const cargo: Array<{ itemId: string; name: string; delta: number; from: number; to: number }> = [];
    for (const it of status.cargo ?? []) {
      const before = prevByItem.get(it.itemId)?.quantity ?? 0;
      const d = it.quantity - before;
      if (d !== 0) cargo.push({ itemId: it.itemId, name: it.name, delta: d, from: before, to: it.quantity });
      prevByItem.delete(it.itemId);
    }
    // Whatever remains in prevByItem was present last tick but absent now -- it
    // left the hold entirely (a full sale/drop), a real loss worth surfacing.
    for (const it of prevByItem.values()) {
      cargo.push({ itemId: it.itemId, name: it.name, delta: -it.quantity, from: it.quantity, to: 0 });
    }

    if (creditDelta === 0 && cargo.length === 0) return; // no-change tick: no noise

    this.emit("ledger", {
      ...(creditDelta !== 0 ? { credits: { delta: creditDelta, from: prev.credits, to: status.credits } } : {}),
      ...(cargo.length ? { cargo, cargoUsed: { from: prev.cargoUsed, to: status.cargoUsed } } : {}),
    });
  }

  /** One loop iteration. Never throws on planner/game failures. */
  async runOnce(): Promise<void> {
    const [notifications, status] = await Promise.all([
      this.api.notifications().catch(() => []),
      this.api.status().catch((e) => {
        this.emit("status_error", { message: e instanceof Error ? e.message : String(e) });
        return null;
      }),
    ]);

    // Retain the last good status for the dashboard's ship-vitals block. Pure
    // retain-and-expose: this is the SAME per-tick status the reflex/wake path
    // consumes below (no extra game call), and only snapshot() reads the field
    // -- loop behavior is untouched. A failed fetch (status null) keeps the
    // prior known-good telemetry rather than blanking the display.
    if (status) this.lastStatus = status;

    // Observability (SM-11): surface the game's OWN result feed. Notifications
    // carry the outcomes the action result can't -- a `mine`'s yield, a sale's
    // proceeds, combat results -- and they land a tick after the action. Emit
    // each new one once as a `notification` event; the dedupe set holds ids we
    // already surfaced so a notification the game keeps returning across polls
    // doesn't restamp the feed every tick. Runs regardless of status (the two
    // fetches are independent).
    this.emitNewNotifications(notifications);

    // Observability (SM-11): the per-tick LEDGER. Diff this tick's status
    // against the previous and emit the credit/cargo deltas when something
    // changed -- the reliable, always-available answer to "how much ore this
    // tick, which resource, sell revenue" (derived from data the loop already
    // fetched, no extra call). Emits nothing on a no-change tick. Runs before
    // the reflex/backoff/steward/wake gates (which can return early) so no
    // delta is ever missed. Skipped when the status fetch failed (nothing to
    // diff).
    if (status) this.maybeEmitLedger(status);

    // Progress heartbeat: a deterministic, dashboard-visible pulse reporting
    // whether the pilot advanced any progress dimension since the last
    // heartbeat. Evaluated BEFORE the reflex/backoff/steward/wake gates (all of
    // which can `return` early) so it fires every cycle regardless of outcome --
    // a healthy pilot shows a stream of `progressing` heartbeats, a stalled one
    // a stream of `stalled:true`. It only reports; it never acts. Skipped when
    // the tick's status fetch failed (nothing to measure).
    if (status) this.maybeEmitProgressHeartbeat(status);

    // Deterministic A/B exit (#240): evaluate the configured revert condition
    // on the same always-runs footing as the heartbeat (BEFORE the gates that
    // can return early), so the exit fires on schedule even while the planner
    // under test is failing -- exactly the scenario the exit exists for.
    if (status) this.maybeRevertExperiment(status);

    // Reflex check first, before wake evaluation: zero-token, declarative
    // rules (auto-refuel/repair while docked) that don't need the planner at
    // all. A successful fire suppresses the wake entirely for this tick. A
    // failed fire ("can't afford") still spends this tick's one mutation, but
    // lets the low_fuel/low_hull wake fire normally so the planner sees the
    // problem it couldn't reflexively solve.
    const reflex = evaluateReflex(status, this.config.reflex ?? {});
    let reflexSpentTick = false;
    if (reflex) {
      reflexSpentTick = true;
      const fired = await this.fireReflex(reflex);
      if (fired) return; // succeeded: this tick's mutation budget spent, wake suppressed entirely
    }

    // Peek, don't consume yet: if backoff below suppresses the replan, the
    // instruction must stay queued rather than being silently dropped. The
    // pre-Task-4 code shifted the inbox unconditionally before evaluating
    // wake, which was safe in Plan 1 because wake firing and replanning
    // always happened together -- Task 4 introduces a path where wake fires
    // but replan is deliberately skipped (backoff), so eager shift became a
    // real bug (dropped operator instructions) if left unchanged.
    const instruction = this.inbox[0];
    // Layer 1 (producer fix): while a plan is running, suppress the
    // low_fuel/low_hull wake if the plan still carries the matching remedy
    // ahead of the cursor. Scanning from cursor.step onward is the correct
    // window -- once the refuel/repair step has been passed and the condition
    // still holds, the remedy demonstrably failed and a fresh wake is
    // warranted (genuine new information). Only while running: a none/done/
    // blocked plan has no in-flight remedy to defer to.
    const remaining = this.plan && this.planState === "running"
      ? this.plan.steps.slice(this.cursor.step)
      : [];
    const planRemediesFuel = remaining.some((s) => s.action === "refuel");
    const planRemediesHull = remaining.some((s) => s.action === "repair");
    const wake = evaluateWake({
      planState: this.planState,
      blockedReason: this.blockedReason,
      instruction,
      notifications,
      status,
      lastPlanAt: this.lastPlanAt,
      now: this.now(),
      heartbeatMs: this.config.heartbeatMinutes * 60_000,
      fuelPct: this.config.fuelPct,
      fuelReservePct: this.config.fuelReservePct,
      hullPct: this.config.hullPct,
      wakeNotificationTypes: this.config.wakeNotificationTypes,
      planRemediesFuel,
      planRemediesHull,
    });

    if (wake) {
      // status_snapshot (Layer 5): a lightweight game-state sample -- the raw
      // material for the credits/fuel/hull trend charts. Emitted on every wake
      // (the heartbeat wake guarantees a floor sampling cadence even when the
      // agent is idle) from the status ALREADY fetched at tick start -- no
      // extra get_status call. Skipped when that fetch failed (status null): a
      // snapshot of nothing would poison the series with phantom points.
      if (status) {
        // SM-10: throttle to at most one snapshot per 60s per agent, unless a
        // salient vital (credits/system/cargo/docked/fuel-band/hull-band)
        // changed -- then emit immediately so real trend movement isn't
        // delayed. A parked idle ship no longer stamps out ~150 identical
        // snapshots per 30 min. See snapshot-throttle.ts.
        const vitals = {
          credits: status.credits, systemId: status.systemId ?? null,
          cargoUsed: status.cargoUsed, docked: status.docked,
          fuel: status.fuel, maxFuel: status.maxFuel,
          hull: status.hull, maxHull: status.maxHull,
        };
        if (shouldEmitSnapshot(this.snapshotThrottle, vitals, this.now())) {
          // stall-watcher v4: sample the slow progress dimensions (skills,
          // achievements) on the SAME throttle cadence -- token-free queries,
          // not run every tick. Between samples the detector reuses the cache.
          await this.sampleSlowProgressDims();
          // Progress counters ride on the snapshot for the dashboard trend. Only
          // added when stats are present, so a caller with no stats gets the
          // byte-identical pre-v4 payload.
          const progress = progressCounters(status.stats);
          this.emit("status_snapshot", {
            credits: status.credits, fuel: status.fuel, hull: status.hull,
            cargoUsed: status.cargoUsed, systemId: status.systemId ?? null,
            ...(progress ? { progress } : {}),
          });
          this.snapshotThrottle = { lastEmitAt: this.now(), lastKey: snapshotKey(vitals) };
        }
      }
      if (this.now() < this.plannerBackoffUntil) {
        // Backoff active (transient failures, or a closed subscription
        // window with no fallback configured): don't call the planner again
        // yet, but don't stall in-progress execution just because a wake
        // (often the heartbeat, which fires regardless of plan state) also
        // triggered this tick.
        if (!reflexSpentTick && this.plan && this.planState === "running") await this.executeOne(status);
        return;
      }
      // stall-watcher v4 steward: long-window no-progress + behavioral strand.
      // Placed AFTER the backoff gate (so an active backoff -- including an armed
      // Layer 4 -- suppresses it) but BEFORE the ceiling/thrash/Layer-4 gates: a
      // steward re-steer is instruction-class and bypasses those by design, so
      // the per-window timestamp latch inside runSteward is its only bound.
      // Requires status; a null status makes every progress dimension UNKNOWN,
      // so we skip (fail-safe) and fall through to the normal path.
      //
      // Cadence is per-WAKE, not per-tick, and that is intentional: wakes are the
      // replan boundaries, so the no-progress judge accumulates across exactly
      // the points where the pilot (re)decides what to do, and execute-only ticks
      // (a plan step running with no wake) need no re-evaluation. The strand
      // fuel-block count is maintained separately in executeOne, so it still sees
      // every tick.
      if (status && await this.runSteward(status, wake, notifications, this.now())) return;
      // Layer 3 (per-agent rolling ceiling): count this agent's own `wake`
      // events (one emitted per replan(), see replan() below) in a trailing
      // window straight from the events table -- NOT plannerBackoffUntil,
      // which a *successful* replan resets to 0, so it can't bound a
      // succeeding thrash loop like the low_fuel livelock. Signature-agnostic:
      // it caps any wake reason the thrash damper misses (low_fuel, heartbeat,
      // notification). Self-clearing: as old wakes age out of the window the
      // count falls and replanning resumes at the capped rate, no latch and no
      // operator action. Placed before the thrash gate so a capped tick never
      // perturbs the blocked/plan_done streak counters.
      // An operator instruction is the human escape hatch: it must be able to
      // steer a thrashing agent even at budget, so it bypasses the cap. Every
      // other wake reason is subject to it.
      const windowMs = (this.config.planBudgetWindowMinutes ?? AGENT_DEFAULTS.planBudgetWindowMinutes) * 60_000;
      const maxPlans = this.config.maxPlansPerWindow ?? AGENT_DEFAULTS.maxPlansPerWindow;
      if (wake.reason !== "instruction" && this.store.countWakesSince(this.id, this.now() - windowMs) >= maxPlans) {
        if (!this.planBudgetExceeded) {
          this.planBudgetExceeded = true;
          this.emit("plan_budget_exceeded", {
            maxPlans,
            windowMinutes: this.config.planBudgetWindowMinutes ?? AGENT_DEFAULTS.planBudgetWindowMinutes,
          });
        }
        // Mirror the backoff branch: keep any in-flight plan executing
        // deterministically (reflex-only), leave a queued instruction queued.
        if (!reflexSpentTick && this.plan && this.planState === "running") await this.executeOne(status);
        return;
      }
      this.planBudgetExceeded = false;
      // evaluateWake (wake.ts) returns "blocked"/"plan_done" only when no
      // instruction is queued, so a queued operator instruction always
      // bypasses this gate. See BLOCKED_THRASH_THRESHOLD's comment.
      if (wake.reason === "blocked" || wake.reason === "plan_done") {
        // Compound key, not a bare detail string: a blocked wake's block
        // reason and a plan_done wake's completed goal are different kinds
        // of "identity" that happen to share a string type. Prefixing with
        // wake.reason means a switch between the two thrash KINDS is always
        // "different" and resets the streak, without a separate branch to
        // keep in sync.
        // Invariant: the thrash key identifies the outcome CLASS a wake
        // repeats, not the literal detail string -- established here, the
        // single place the key is built. See docs/decisions.md (2026-07-13,
        // issue #146) for why (a no-buyers sell loop that varied item per
        // attempt evaded a literal-string key for 40+ minutes).
        const rawDetail = wake.reason === "blocked" ? wake.detail : this.lastCompletedGoal;
        const detail = wake.reason === "blocked" && isNoBuyersBlock(rawDetail)
          ? NO_BUYERS_CLASS
          : rawDetail;
        const key = `${wake.reason}:${detail ?? ""}`;
        if (key === this.lastThrashKey) {
          this.consecutiveThrashWakes++;
        } else {
          // A genuinely different identity is a new problem, not a repeat of
          // the old one -- starts a fresh streak at 1 rather than carrying
          // over the previous (unrelated) count.
          this.consecutiveThrashWakes = 1;
          this.lastThrashKey = key;
        }
        if (this.consecutiveThrashWakes >= BLOCKED_THRASH_THRESHOLD) {
          this.plannerBackoffUntil = this.now() + this.config.heartbeatMinutes * 60_000;
          this.emit("plan_thrash_backoff", {
            consecutiveWakes: this.consecutiveThrashWakes,
            wakeReason: wake.reason,
            detail,
            deferMinutes: this.config.heartbeatMinutes,
          });
          // Reset at the moment the gate arms -- review-confirmed defect fix
          // (original F-3 fix). Without this reset every post-expiry wake
          // with the same identity would re-arm the backoff forever:
          // permanent grounding. Resetting here yields the intended damped
          // duty cycle -- after the window expires the next matching wake
          // replans normally, and sustained thrash needs another
          // BLOCKED_THRASH_THRESHOLD identical-identity wakes to re-arm.
          this.consecutiveThrashWakes = 0;
          this.lastThrashKey = undefined;
          // Hand off to the damper: the string-keyed thrash gate has armed, so
          // it OWNS this thrash episode. Clear Layer 4's freeze counter so the
          // two guards don't double-arm on the same identical-key thrash. With
          // NO_PROGRESS_REPLANS (6) > BLOCKED_THRASH_THRESHOLD (3), the damper
          // always reaches its threshold first on identical-key thrash and this
          // reset keeps Layer 4 below 6; Layer 4 only arms when the damper
          // CAN'T (a varying key that never builds a streak) -- its intended
          // backstop role.
          this.noProgressReplans = 0;
          this.lastFingerprint = undefined;
          // #95: the consecutive gate owns this thrash episode, so floor the
          // windowed same-error breaker past these blocks -- it must not
          // re-fire on repeats the gate already broke (mirrors the Layer 4
          // reset just above).
          this.repeatBreakFloorTs = this.now();
          return;
        }
      }

      // Same-error-repeat loop-breaker (issue #95). The GENERAL form of the
      // consecutive thrash gate above: count blocked (action, normalized-
      // target) outcomes since the last same-key SUCCESS and, at threshold,
      // break the loop with a transient re-steer -- catching the INTERLEAVED
      // repeats the consecutive gate misses (its streak resets whenever other
      // work lands between the doomed retries), and doing so even while other
      // progress dimensions climb (the #291 mission mask).
      // Reads the persisted `action` stream (restart-safe, zero new schema), not
      // an in-memory counter. Placed AFTER the consecutive gate on purpose: a
      // pure same-reason streak is OWNED by that gate (it returns first at its
      // threshold, and floors this breaker on arm), so this fires only when the
      // streak never built. Escalation is the SMALLEST safe one: it ENRICHES the
      // replan this blocked wake was already going to make with a steer
      // instruction (persistInstruction:false, like the steward) -- zero added
      // LLM call -- and never hard-abandons the action. Receipt for rejecting a
      // deterministic cooldown-suppression of the exact action: that temporarily
      // ABANDONS the action, which can kill a legitimately-retrying step (the
      // pilot may be one mine away from the mission it keeps trying to complete)
      // -- and #158/#155 bind suppression to conservative, only classes proven
      // to thrash; a steer informs without abandoning. Bounded to once per key
      // per window by the latch.
      if (wake.reason === "blocked" && status) {
        const k = this.config.repeatBlockThreshold ?? AGENT_DEFAULTS.repeatBlockThreshold;
        const winMin = this.config.repeatBlockWindowMinutes ?? AGENT_DEFAULTS.repeatBlockWindowMinutes;
        const winMs = winMin * 60_000;
        // #291 third occurrence: accrual has NO trailing time window. The old
        // `now - winMs` lower bound made K=3 need repeats faster than ~1 per
        // 15 min; the live doomed loop blocked 5x over 4+ hours (never 2 in
        // any 30-min window) and the breaker sat blind. A doomed action that
        // fails slowly forever must still accumulate, so the read reaches back
        // to the last consecutive-gate episode floor (clamped to 0: the floor
        // starts at -Infinity, and every event ts is a positive epoch ms) and
        // the count loop below resets on a same-key success. winMs survives as
        // the re-steer cooldown latch only -- pacing, not memory.
        // ponytail: this reads the full retained action stream on a blocked
        // wake. Retention is the STARTUP-ONLY 30-day prune (main.ts) plus
        // whatever accrues over process uptime -- short in practice, since
        // prod recreates the container on every auto-deploy. A chunked
        // backward scan with early exit at K would bound the read; rejected
        // until the flat read is measurably slow -- one indexed fetch a few
        // times an hour is cheap.
        const lower = Math.max(this.repeatBreakFloorTs, 0);
        const events = this.store.eventsByTypeSince(this.id, "action", lower);
        // The current block is the most recent blocked action event (the one
        // that caused this wake); its key is what we count repeats of.
        let current: BlockedOutcome | undefined;
        for (let i = events.length - 1; i >= 0; i--) {
          const p = events[i]!.payload as ActionEventPayload | null;
          if (p && p.outcome === "blocked" && typeof p.action === "string") {
            current = blockedOutcomeKey(p.action, p.params, p.result);
            break;
          }
        }
        if (current) {
          // Running count of same-key blocks since the last SAME-KEY success: a
          // continue/plan_done of this key means the action WORKED, so it resets
          // the count (an action that occasionally blocks then succeeds is not
          // looping). Other keys' events are ignored -- that interleaving is
          // exactly what the consecutive gate cannot see through. A `wait`
          // (transient hold) neither counts nor resets.
          //
          // No-buyers-class exception (#95 review, #348): the collapsed class key
          // NO_BUYERS_CLASS is reached only via a blocked reason matching the
          // no-buyers text, so a genuine SALE success -- which never carries that
          // text -- keys to `sell:<item>`, not the class. Without this branch the
          // "same-key success resets" invariant is structurally UNREACHABLE for
          // the no-buyers class: the sale that resolves the thrash is invisible to
          // the counter. A successful sell means buyers were found (or the pilot
          // relocated to a market that has them), so the no-buyer thrash for the
          // class is resolved -- reset the class count on it.
          let count = 0;
          for (const e of events) {
            const p = e.payload as ActionEventPayload | null;
            if (!p || typeof p.action !== "string") continue; // tolerate a foreign/old shape
            const isSuccess = p.outcome === "continue" || p.outcome === "plan_done";
            if (blockedOutcomeKey(p.action, p.params, p.result).key === current.key) {
              if (p.outcome === "blocked") count++;
              else if (isSuccess) count = 0;
            } else if (current.key === NO_BUYERS_CLASS && isSuccess && p.action === "sell") {
              count = 0;
            }
          }
          const inCooldown = current.key === this.lastRepeatBreakKey
            && (this.now() - this.lastRepeatBreakAt) < winMs;
          if (count >= k && !inCooldown) {
            this.lastRepeatBreakAt = this.now();
            this.lastRepeatBreakKey = current.key;
            this.emit("repeat_block_break", { key: current.key, count, cooldownMinutes: winMin });
            // No-buyers damper (issue #348). The generic steer below tells the
            // planner to "drop it and pursue a different goal" -- correct for a
            // precondition-block loop, but WRONG for the no-buyers class, whose
            // remedy is to LIST or RELOCATE held cargo (never drop valuable
            // cargo, #94), and whose failing move is RE-SEARCHING for a buyer by
            // retrying the sell across stations. When #95's counter tripped on
            // the collapsed NO_BUYERS_CLASS key (N consecutive no-buyer results,
            // interleave-tolerant, item-agnostic -- see wake.ts and the class
            // count above), escalate with the list/relocate/hold remedy instead
            // of the contradictory generic "drop it". Same counter/threshold/
            // cooldown/event -- only the steer text branches, so the detection
            // the #95 tests already cover is untouched. Paired improv-mode line:
            // docs/superpowers/specs/2026-07-12-improv-mode.md section 4.
            const steer = current.key === NO_BUYERS_CLASS
              ? `You have hit "no buyers" ${count} times trying to sell held cargo -- each a market with no buyer for that item. ` +
                `Re-searching for a buyer by retrying the sell, here or by hopping to another market, will keep failing. ` +
                `Do not re-attempt the sell. Instead: list the item on the player exchange with create_sell_order ` +
                `(item_id, quantity, price_each -- omit price_each for the catalog base value); or travel to a station the ` +
                `Market intelligence section names as having demand and sell there; or HOLD the cargo and do other productive work. ` +
                `Valuable cargo is never jettisoned.`
              : `You have repeated the same failing action -- ${current.label} -- ${count} times with no success in between, ` +
                `each with the same blocked result. Retrying it will not change the outcome. ` +
                `Either satisfy its precondition (gather what it needs, move where it is valid, fit the module), ` +
                `or drop it and pursue a different productive goal from here.`;
            // Transient nudge, not a persisted goal (steward pattern): enriches
            // the replan this wake was already going to make -- no extra call.
            await this.replan(wake, status, steer, notifications, { persistInstruction: false });
            return;
          }
        }
      }
      // Layer 4 (no-progress detector): fingerprint salient GAME state at this
      // replan boundary and compare to the previous one. Placed HERE -- past
      // the backoff/ceiling/thrash gates that all `return` without replanning,
      // immediately before the actual replan -- so it fingerprints exactly the
      // ticks that DO replan. This is what makes it immune to the executor's
      // `wait` outcomes: a ship in transit holds its step and produces no wake
      // and no replan (see executeOne's "wait" branch and executeTick's
      // inTransit guard), so a long transit never reaches this code and can't
      // false-trigger the freeze detector. If status is null we can't
      // fingerprint, so skip the check this tick and don't count it.
      //
      // Runs on EVERY replan boundary, including blocked/plan_done: those are
      // the string-keyed thrash damper's primary domain, but the damper only
      // arms on an IDENTICAL key streak. A plan_done loop that reruns to
      // completion each cycle with slightly-reworded goal text and frozen game
      // state defeats the damper (varying key -> streak never builds) and must
      // still be caught -- that is exactly this detector's backstop role. The
      // damper-arm branch above clears this counter, so on identical-key thrash
      // (where the damper DOES arm, first, at threshold 3) the two guards never
      // double-arm; Layer 4 only reaches its threshold (6) when the damper
      // couldn't.
      if (status) {
        const fp = progressFingerprint(status, this.cursor.step);
        if (fp === this.lastFingerprint) {
          this.noProgressReplans++;
        } else {
          // A differing fingerprint is real progress: reset the run to 1 and
          // clear the sticky stuck flag. This IS replan()'s success precondition
          // -- the differing state is observed at the boundary just before the
          // replan that consumes it -- consolidated to a single locus so the
          // fingerprint isn't recomputed inside replan() (simplicity: one
          // producer for the flag, not two).
          this.noProgressReplans = 1;
          this.lastFingerprint = fp;
          this.stuck = false;
        }
        if (this.noProgressReplans >= NO_PROGRESS_REPLANS) {
          this.stuck = true;
          this.plannerBackoffUntil = this.now() + this.config.heartbeatMinutes * 60_000;
          this.emit("operator_alert", {
            class: "no_progress", fingerprint: fp, replans: this.noProgressReplans,
          });
          // Reset the run like the thrash gate does: after backoff expires, the
          // next still-frozen wake starts counting again and needs another full
          // NO_PROGRESS_REPLANS run to re-arm -- a damped duty cycle, not a
          // permanent latch. `stuck` deliberately stays true across this reset;
          // only a differing fingerprint (above) clears it.
          this.noProgressReplans = 0;
          return; // do not replan this tick -- arming exists to stop the spend
        }
      }
      if (instruction !== undefined) this.inbox.shift(); // now actually consumed
      await this.replan(wake, status, instruction, notifications);
      return;
    }
    if (!reflexSpentTick && this.plan && this.planState === "running") {
      await this.executeOne(status);
    }
  }

  private async fireReflex(reflex: ReturnType<typeof evaluateReflex>): Promise<boolean> {
    if (!reflex) return false;
    try {
      await this.api.action(reflex.action);
      this.emit("reflex", { action: reflex.action, reason: reflex.reason });
      return true;
    } catch (e) {
      this.emit("reflex_failed", {
        action: reflex.action, reason: reflex.reason,
        message: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  // stall-watcher v4: sample the slow progress dimensions (skills xp/level
  // fingerprint, achievements earned) on the snapshot throttle cadence. A thrown
  // query marks that dimension UNKNOWN (null) so progressGrandTotal suppresses.
  private async sampleSlowProgressDims(): Promise<void> {
    if (this.api.getSkills) {
      try {
        this.cachedSkillsSig = skillsSignature(await this.api.getSkills());
      } catch (e) {
        this.cachedSkillsSig = null;
        this.emit("progress_sample_error", { dim: "skills", message: e instanceof Error ? e.message : String(e) });
      }
    }
    if (this.api.getAchievements) {
      try {
        this.cachedAchievementsEarned = await this.api.getAchievements();
      } catch (e) {
        this.cachedAchievementsEarned = null;
        this.emit("progress_sample_error", { dim: "achievements", message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // The combined monotonic progress scalar (stall-monitor.ts), or null when ANY
  // dimension is UNKNOWN. Thin wrapper: supplies the agent's sampled slow-
  // dimension state to the pure function so callers keep a single-arg call.
  private progressGrandTotal(status: StatusSnapshot): number | null {
    return progressGrandTotal(status.stats, this.cachedSkillsSig, this.cachedAchievementsEarned);
  }

  // Progress heartbeat: emit a per-window progress delta when the cadence
  // elapses. Deterministic and token-free -- it reads the stats block already
  // parsed onto this tick's StatusSnapshot plus the steward's cached slow
  // dimensions (no extra game call). The progressing/stalled verdict is the
  // stall-watcher's OWN scalar (progressGrandTotal), so the two can no longer
  // disagree: a skills-only or achievements-only window reads `progressing`
  // (#96, closing PR #78's known gap). The alignment INHERITS both exclusions
  // from the shared signal instead of re-deciding them here: movement counters
  // (jumps/distance/systems/time) aren't in PROGRESS_COUNTERS, and ambient
  // sub-level skill XP never moves skillsSignature (#250: LEVEL-only).
  private maybeEmitProgressHeartbeat(status: StatusSnapshot): void {
    // ANY dimension UNKNOWN -> progress is UNMEASURABLE this cycle -- the same
    // suppress rule the steward applies to the same scalar. Skip without
    // advancing the baseline or clock, so a missing-stats tick or a failed
    // skills/achievements sample neither emits a phantom heartbeat nor loses
    // the window. progressGrandTotal is the authoritative gate; the null
    // re-checks after it exist only to narrow types for the payload reads.
    const total = this.progressGrandTotal(status);
    const counters = progressCounters(status.stats);
    const skillLevels = this.cachedSkillsSig;
    const achievementsEarned = this.cachedAchievementsEarned;
    if (total === null || counters === undefined || skillLevels === null || achievementsEarned === null) return;

    // The slow dimensions ride the same per-dimension record as the counters
    // (informational payload -- the dashboard's "what moved").
    const dims: Record<string, number> = {
      ...counters, skill_levels: skillLevels, achievements_earned: achievementsEarned,
    };

    // First measurable cycle: seed the baseline and start the clock from here.
    // Nothing to compare against yet, so emit nothing until a window elapses.
    // (On a live loop the slow dims are first sampled on the snapshot cadence,
    // one tick -- seconds -- after the first stats sighting; seeding waits.)
    if (this.progressHeartbeatBaseline === undefined) {
      this.progressHeartbeatBaseline = { dims, total };
      this.progressHeartbeatAt = this.now();
      return;
    }

    const windowMinutes = this.config.progressHeartbeatMinutes ?? AGENT_DEFAULTS.progressHeartbeatMinutes;
    if (this.now() - this.progressHeartbeatAt < windowMinutes * 60_000) return;

    // Per-dimension delta since the last heartbeat. A key absent from the
    // current sample means that counter simply didn't move (progressCounters
    // omits absent keys), so it holds its baseline value. Only changed
    // dimensions ride in the payload.
    const base = this.progressHeartbeatBaseline.dims;
    const deltas: Record<string, number> = {};
    for (const k of [...PROGRESS_COUNTERS, ...HEARTBEAT_SLOW_DIMS]) {
      const prev = base[k] ?? 0;
      const cur = dims[k] ?? prev;
      const d = cur - prev;
      if (d !== 0) deltas[k] = d;
    }

    // The verdict comes from the SHARED scalar, not the payload breakdown:
    // `progressing` iff the grand total ADVANCED. A negative delta (a data
    // glitch -- every dimension is monotonic) shows in `deltas` but does NOT
    // count as progress, matching the pre-#96 rule.
    const progressed = total > this.progressHeartbeatBaseline.total;

    this.emit("progress_heartbeat", {
      windowMinutes,
      progressing: progressed,
      stalled: !progressed,
      deltas,
      position: {
        credits: status.credits,
        cargoUsed: status.cargoUsed,
        systemId: status.systemId ?? null,
      },
    });

    this.progressHeartbeatBaseline = { dims, total };
    this.progressHeartbeatAt = this.now();
  }

  // Deterministic A/B exit (#240, the #251 lesson: a revert condition the
  // harness evaluates, not a prose promise). Watches ONE config-named progress
  // counter -- or "any", the summed PROGRESS_COUNTERS allowlist (SSOT with the
  // no-progress detector and heartbeat) -- and trips when it hasn't advanced
  // within the configured window. Tripping is three things and only three:
  // latch (one-way, see the field comment), emit experiment_reverted
  // (dashboard-visible, and the durable record the constructor re-latches
  // from), and from then on activePlanner() serves the fallback. No un-trip
  // path exists by design: flapping between planners mid-experiment would
  // corrupt the A/B the exit is protecting.
  private maybeRevertExperiment(status: StatusSnapshot): void {
    const exp = this.config.experiment;
    if (!exp || this.experimentReverted || !this.fallbackPlanner) return;

    // Resolve the watched value. Missing stats -> null (unmeasurable); a
    // present stats block with the named key absent counts as 0 (that counter
    // simply isn't moving), mirroring progressCountersTotal's semantics.
    let value: number | null;
    if (exp.revertIfNo === "any") {
      value = progressCountersTotal(status.stats);
    } else if (!status.stats) {
      value = null;
    } else {
      const v = status.stats[exp.revertIfNo];
      value = typeof v === "number" ? v : 0;
    }

    if (value === null) {
      // Fail-safe (steward semantics): progress is UNMEASURABLE this tick, so
      // we cannot rule it out. Refresh the clock -- never accumulate a revert
      // window across an unknown gap -- and drop the baseline for a clean
      // re-seed on the next known sample.
      this.experimentLastAdvanceAt = this.now();
      this.experimentBaselineValue = undefined;
      return;
    }
    if (this.experimentBaselineValue === undefined || value !== this.experimentBaselineValue) {
      // First known sample, or ANY change (advance / anomalous drop of a
      // monotonic counter): re-seed. A change means the window restarts, so
      // the exit is "no advance for withinHours STRAIGHT", the rolling window
      // the issue's scope update asks for.
      this.experimentBaselineValue = value;
      this.experimentLastAdvanceAt = this.now();
      return;
    }
    const windowMs = exp.withinHours * 3_600_000;
    if (this.experimentLastAdvanceAt !== undefined && this.now() - this.experimentLastAdvanceAt >= windowMs) {
      this.experimentReverted = true; // the one-way latch
      this.emit("experiment_reverted", {
        counter: exp.revertIfNo,
        withinHours: exp.withinHours,
        stalledMs: this.now() - this.experimentLastAdvanceAt,
      });
    }
  }

  // Thin wrapper over stall-monitor.ts's fuelBelowReserve: supplies the agent's
  // configured reserve threshold so callers keep a single-arg call.
  private fuelBelowReserve(status: StatusSnapshot): boolean {
    return fuelBelowReserve(status, this.config.fuelReservePct ?? AGENT_DEFAULTS.fuelReservePct);
  }

  /**
   * The steward (stall-watcher v4). Returns true when it CONSUMES the tick (a
   * transient re-steer replan, or an opt-in self_destruct), so runOnce returns
   * without the normal replan.
   *
   * Bounded by construction. Because it sits ahead of the ceiling and thrash
   * gates and re-steers via the instruction path (which bypasses both), the
   * lastStewardSteerAt timestamp latch (now - last >= windowMs) is the SOLE
   * bound on the re-steer burn -- load-bearing. It also stands down entirely
   * while Layer 4 owns a state-frozen episode (this.stuck), so the short-window
   * freeze detector and this long-window progress judge never double-act.
   */
  private async runSteward(
    status: StatusSnapshot, wake: WakeReason,
    notifications: EnvelopeNotification[], now: number,
  ): Promise<boolean> {
    if (this.stuck) return false; // Layer 4 owns the episode

    const windowMs = (this.config.stuckWindowMinutes ?? AGENT_DEFAULTS.stuckWindowMinutes) * 60_000;

    // --- long-window no-progress judge (stall-monitor.ts) ---
    // The pure judge steps the (total, at) baseline and reports EXACTLY-flat-for-
    // a-window; the agent stores the returned baseline back. See noProgressJudge
    // for the fail-safe (null re-seeds the clock, any change re-seeds).
    const judged = noProgressJudge({
      total: this.progressGrandTotal(status),
      prevTotal: this.lastProgressTotal,
      prevAt: this.lastProgressAt,
      now,
      windowMs,
    });
    this.lastProgressTotal = judged.total;
    this.lastProgressAt = judged.at;
    const noProgress = judged.noProgress;

    // --- behavioral strand (stall-monitor.ts) ---
    const stranded = isStranded({
      docked: status.docked,
      fuelBelowReserve: this.fuelBelowReserve(status),
      fuelBlockedMoves: this.fuelBlockedMoves,
      currentPoiHasBase: this.currentPoiHasBase,
      fuelBlockThreshold: STRAND_FUEL_BLOCK_THRESHOLD,
    });

    if (stranded) {
      if (this.strandedSince === undefined) this.strandedSince = now;
    } else {
      this.strandedSince = undefined;
      this.selfDestructFired = false;
    }

    if (!stranded && !noProgress) {
      // Condition cleared. Reset the episode latches (spec §3: "reset when the
      // condition clears") so a pilot that recovers -- which means real progress
      // was observed -- and later re-stalls gets a fresh rung-1 nudge and a
      // fresh rung-2 alert, rather than waiting out the prior window. Safe from
      // burn: clearing requires an actual progress advance, not mere time.
      this.stuckAlerted = false;
      this.lastStewardSteerAt = Number.NEGATIVE_INFINITY;
      return false;
    }

    // --- strand self_destruct escalation (CONFIG-GATED, default OFF) ---
    // Auto-destroying the ship is destructive (loses cargo), so by default the
    // steward only distress-calls, alerts, and re-steers to refuel. Only when
    // the operator opts in does it fire self_destruct, and only after a longer
    // window than rung 1.
    if (
      stranded && this.config.strandAutoSelfDestruct && !this.selfDestructFired &&
      this.strandedSince !== undefined &&
      (now - this.strandedSince) >= windowMs * STRAND_SELF_DESTRUCT_WINDOW_MULT
    ) {
      // Latch on ATTEMPT, not success (deliberate): self_destruct can be
      // rejected (escalating fees past the free 2/24h, per the spec), and
      // retrying a destructive, fee-incurring action every tick would be worse
      // than the strand. A failed attempt emits steward_action_failed and leaves
      // the loud per-window distress re-steers as the remaining escalation.
      this.selfDestructFired = true;
      this.emit("operator_alert", { class: "stranded", action: "self_destruct", strandedMs: now - this.strandedSince });
      try {
        await this.api.action("self_destruct");
        this.emit("steward_self_destruct", { strandedMs: now - this.strandedSince });
      } catch (e) {
        this.emit("steward_action_failed", { action: "self_destruct", message: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // --- rung 2 (no-progress): still stuck a full window past rung 1 -> loud alert ---
    if (
      noProgress && !this.stuckAlerted && this.lastProgressAt !== undefined &&
      (now - this.lastProgressAt) >= windowMs * 2
    ) {
      this.stuckAlerted = true;
      this.emit("operator_alert", { class: "stuck_no_progress", stalledMs: now - this.lastProgressAt });
      // fall through: rung 1 may still re-steer this window
    }

    // --- rung 1: one transient re-steer per window (LATCHED) ---
    if ((now - this.lastStewardSteerAt) < windowMs) {
      // Latched this window. A confirmed STRAND is a hard stop -- the pilot has
      // no fuel to move -- so consume the tick (return true) rather than fall
      // through to the thrash gate: otherwise the generic damper arms a
      // heartbeat-length backoff that starves the strand's own escalation
      // (distress re-steer, then the opt-in self_destruct) of the ticks it needs
      // to run. The strand detector is the specific diagnosis and OWNS the
      // episode over the generic damper. NO-PROGRESS is soft by contrast: let
      // normal operation (execute/replan, incl. thrash damping) resume between
      // the once-per-window nudges, so fall through with false.
      return stranded;
    }
    this.lastStewardSteerAt = now;

    let instructionText: string;
    if (stranded) {
      // Loud strand alert, once per window regardless of the self_destruct config.
      this.emit("operator_alert", {
        class: "stranded", fuel: `${status.fuel}/${status.maxFuel}`, system: status.systemId ?? null,
      });
      // Deterministic mayday, rung 1 of the strand path: fire distress_signal
      // OURSELVES rather than only cueing the planner. Producer-fix, not a
      // consumer guard: a re-steer that merely INSTRUCTS distress can be starved
      // -- with fuel ~0 the low_fuel wake preempts execution unless the planner
      // happens to return a plan carrying a downstream refuel step, so the SOS
      // may never actually go out. Sending it directly (like self_destruct
      // below) guarantees the call regardless of planner compliance. Bounded by
      // this same once-per-window rung-1 latch; it's a game mutation, not an LLM
      // call, so once per strand window is cheap and safe. The re-steer still
      // follows, to cue the pilot to reach fuel and refuel.
      try {
        await this.api.action("distress_signal", { distress_type: "fuel" });
        this.emit("steward_distress", { distress_type: "fuel" });
      } catch (e) {
        this.emit("steward_action_failed", { action: "distress_signal", message: e instanceof Error ? e.message : String(e) });
      }
      instructionText =
        "You appear STRANDED: undocked, nearly out of fuel, and travel keeps failing for lack of fuel with no refuel base here. " +
        "A distress call for fuel has already been broadcast on your behalf. Head to the nearest reachable fuel base and refuel.";
    } else {
      instructionText =
        "No measurable progress in any dimension (credits, ore, missions, trades, skills, achievements) for a while. " +
        "Change approach: pick a concrete productive goal you can act on from here, and pursue it.";
    }
    this.emit("steward_resteer", { class: stranded ? "stranded" : "stuck_no_progress", instruction: instructionText });
    await this.replan(wake, status, instructionText, notifications, { persistInstruction: false });
    return true;
  }

  private activePlanner(): Planner | undefined {
    // Experiment exit first (#240): a tripped revert is an explicit,
    // config-driven verdict on the primary planner; nothing below may
    // reinstate it. maybeRevertExperiment only latches when fallbackPlanner
    // exists, so this branch always has a planner to serve.
    if (this.experimentReverted && this.fallbackPlanner) return this.fallbackPlanner;
    if (this.claudeDisabled) return this.fallbackPlanner;
    if (this.usingFallback) return this.fallbackPlanner ?? this.planner;
    return this.planner;
  }

  private async replan(
    wake: WakeReason, status: unknown, instruction?: string,
    notifications: EnvelopeNotification[] = [],
    opts: { persistInstruction?: boolean } = {},
  ): Promise<void> {
    this.emit("wake", wake);
    // Inbox instructions persist as goals (the operator's standing intent); a
    // steward re-steer passes persistInstruction:false so it lands in
    // PlanContext.instruction ONLY, never the persisted goals -- a transient
    // nudge, not a new standing goal.
    if (instruction && opts.persistInstruction !== false) {
      this.goals.push(instruction);
      // Cap the retained history (issue #186): evict oldest so stale steers
      // age out instead of accumulating forever. See MAX_GOALS for the value
      // receipt; the digest renders survivors newest-first with the paired
      // supersession rule.
      if (this.goals.length > MAX_GOALS) this.goals.splice(0, this.goals.length - MAX_GOALS);
    }
    // Re-merge the standing config goals AFTER the push-side eviction above:
    // if the cap just pushed a standing goal off the front, this restores it
    // (displacing the oldest transient steer) before the gathers and the plan
    // context read this.goals. See mergeStandingGoals for the eviction-hole
    // receipt. Usually a no-op (the goal is already present).
    this.mergeStandingGoals();

    // Instruction salience (issue #355): the newest operator instruction
    // still standing = the newest goals entry that is NOT a standing config
    // goal (#216). No new persisted state -- goals already persist, and every
    // non-config entry in them is an operator instruction (steward re-steers
    // pass persistInstruction:false and never land here). Suppressed when it
    // equals this wake's transient `instruction` (the arrival wake already
    // renders its own dedicated line; without this check the same text would
    // shout twice AND a hallucinated instruction_done on the arrival plan
    // could clear an order the operator typed seconds ago). Satisfaction is
    // honored against this exact derived value below, so the digest's block
    // and the clearing site can never disagree about WHICH instruction the
    // planner reported done.
    let standingInstruction: string | undefined;
    for (let i = this.goals.length - 1; i >= 0; i--) {
      const g = this.goals[i]!;
      if (!this.standingGoals.includes(g)) { standingInstruction = g; break; }
    }
    if (standingInstruction === instruction) standingInstruction = undefined;

    const planner = this.activePlanner();
    if (!planner) {
      this.emit("planner_error", { message: "no planner available (claude disabled, no fallback configured)" });
      return;
    }

    // SM-6 fix: read before anything below touches this.plan (the reassignment
    // happens only after a successful plan/normalize, further down this
    // method) -- derivePreviousGoal needs the OUTGOING plan, still intact here.
    const previousGoal = this.derivePreviousGoal(wake);

    try {
      const surroundings = await this.gatherSurroundings(status as StatusSnapshot | null);
      const statusSnap = status as StatusSnapshot | null;
      // POI-extraction backstop (issue #253): learn BEFORE stamping, so the
      // very replan that follows the blocked mine already shows the marker --
      // the pilot hasn't moved between the block and this replan (a blocked
      // mine doesn't move the ship), so surroundings.currentPoi IS the POI
      // that refused it.
      this.learnIncompatiblePoi(wake, surroundings);
      this.applyIncompatiblePois(surroundings, statusSnap?.modules);
      // Learned sparse-deposit rules (issue #188): same learn-before-stamp
      // ordering and same seam as the #253 pair above -- a blocked mine
      // doesn't move the ship, so surroundings.currentPoi IS the POI that
      // refused it and THIS replan already shows the marker.
      this.learnSparseDeposit(wake, surroundings, statusSnap);
      this.applySparseMarkers(surroundings, statusSnap?.modules);
      // Mission-funnel fix (issue #147): fetched here, on the same
      // once-per-replan cadence as gatherSurroundings above -- not per tick.
      const missionsText = await this.gatherMissions(statusSnap);
      // Active-mission visibility fix (issue #170): fetched every replan,
      // NOT gated on docked like the available listing above -- see
      // gatherActiveMissions for the invariant behind the divergence.
      // Mission-progress bridge (issue #291): the same fetch now also yields
      // the parsed mission facts (see gatherActiveMissions).
      const activeMissionsRes = await this.gatherActiveMissions();
      const activeMissionsText = activeMissionsRes.text;
      const activeMissions = activeMissionsRes.missions;
      // Mission-progress bridge (issue #291) / mining preconditions (#188):
      // what the CURRENT deposit can yield and what beam power it supports --
      // fetched at any mineable current POI (see gatherPoiDeposits).
      const poiDeposits = await this.gatherPoiDeposits(surroundings);
      // Capability audit (Workflow A, 2026-07-19): dedicated get_cargo fetch,
      // fired every replan (ungated -- see gatherCargo). undefined falls back
      // to the get_status-derived manifest below, same fail-open convention
      // as every other optional gather in this method.
      const cargoDetail = await this.gatherCargo();
      // Buyable-here surfacing (issue #93): fetched here, on the same
      // once-per-replan cadence as the mission listings above, gated tighter
      // (docked AND cargo aboard) — see gatherMarket.
      const marketRows = await this.gatherMarket(statusSnap);
      // Remote-POI targeting fix (issue #176): the scannable entities at the
      // pilot's position -- fetched every replan, ungated, like the active
      // missions above (what is around you is a fact of your position, not of
      // a station). See gatherNearby.
      const nearbyText = await this.gatherNearby();
      // Capability-audit follow-up (2026-07-19): fetched on the same
      // ungated, every-replan cadence as nearbyText above -- see gatherLocation.
      const locationInfo = await this.gatherLocation();
      // Ship tool (issue #219): the purchasable hulls at this station -- the
      // reachability half of #216. Docked-gated like the available-mission
      // listing above, and for the same reason: a shipyard is a station's.
      const shipyardText = await this.gatherShipyard(statusSnap);
      // Capability-audit fix (Workflow A, 2026-07-19): the ships the pilot
      // already OWNS at this station -- the activation half of #216's sibling
      // gap (a bought hull with no way to become the active one). Same docked
      // gate and cadence as the shipyard listing directly above.
      const ownedShipsText = await this.gatherOwnedShips(statusSnap);
      // Purchase discovery (issue #220): what the goal item would cost and who
      // sells it -- fetched every DOCKED replan (issue #315: live-falsified
      // dock requirement, gate added 2026-07-17; the anti-tour goal survives
      // because the check now piggybacks on a dock the pilot already has, not
      // a dedicated trip). See gatherPurchaseEstimates.
      const purchaseEstimates = await this.gatherPurchaseEstimates(statusSnap);
      // Market-intelligence injection (issue #269): the buyer-discovery half of
      // the no-buyers remedy. Same docked-with-cargo gate and once-per-replan
      // cadence as gatherMarket above -- see gatherAnalyzeMarket.
      const marketInsightsText = await this.gatherAnalyzeMarket(statusSnap);
      const ctx: PlanContext = {
        persona: this.persona,
        goals: this.goals,
        wake,
        statusSummary: summarizeStatus(statusSnap),
        recentEvents: this.store.recentEvents(this.id, 5).map((e) => e.type),
        instruction,
        standingInstruction,
        surroundings,
        // SM-6 fix, extended by the capability audit (Workflow A, 2026-07-19):
        // cargoDetail (the dedicated get_cargo fetch above) is preferred as
        // ground truth over the get_status-derived StatusSnapshot.cargo,
        // which client.ts's CargoItemSchema comment flags as unverified live
        // -- see GameApi.getCargo's comment for why. Falls back to the old
        // statusSnap-derived manifest when getCargo is absent or fails (fakes/
        // mocks without it, or a live fetch error), so no existing behavior
        // regresses. digest.ts (buildDigest) is the single place that decides
        // whether an empty manifest is worth rendering.
        cargo: cargoDetail
          ?? (statusSnap
            ? { used: statusSnap.cargoUsed, capacity: statusSnap.cargoCapacity, items: statusSnap.cargo ?? [] }
            : undefined),
        previousGoal,
        // Social capabilities task: same notifications batch runOnce() already
        // fetched for wake evaluation, not a second call -- extractChatMessages
        // (src/agent/chat.ts) is a pure filter/map over it.
        chatMessages: extractChatMessages(notifications),
        missionsText,
        activeMissionsText,
        activeMissions,
        // Issue #188: ids + supported_power ride one field now; the legacy
        // currentPoiDepositIds stays a replay-only type field (see types.ts)
        // and is deliberately NOT written here.
        currentPoiDeposits: poiDeposits?.deposits,
        nearbyText,
        // Broken-fuel-chain fix (issue #152): the same below-reserve check the
        // strand detector uses, over the same snapshot -- gates the digest's
        // fuel-acquisition briefing (exact catalog fuel ids + dock/buy/refuel).
        lowFuel: statusSnap ? this.fuelBelowReserve(statusSnap) : undefined,
        marketRows,
        // Ship tool (issue #219): from the SAME snapshot as statusSummary --
        // get_status already carries the ship's CPU/power grid and fitted
        // modules, so the fit costs no extra query (see StatusSnapshot.fit).
        shipFit: statusSnap?.fit,
        fittedModules: statusSnap?.modules,
        shipyardText,
        ownedShipsText,
        purchaseEstimates,
        marketInsightsText,
        locationInfo,
      };
      const raw = await planner.plan(ctx);
      // Offline planner eval (issue #263, born from SM-9): record the exact
      // digest inputs the planner was shown and the RAW plan it returned, so a
      // candidate model can be scored against real recorded states with zero
      // live traffic (src/eval/harvest.ts reads this event). Emitted BEFORE the
      // PlanSchema boundary below and BEFORE id-normalization on purpose: a plan
      // that fails validation, or whose ids only survived because the normalizer
      // rewrote them, is exactly the evidence the eval needs -- validating or
      // repairing it first would hide the failure we are trying to measure.
      // Size receipt (simplicity rule 3), corrected in the PR #267 review and made
      // STRUCTURAL in #272. This is a live-pilot hot-path event, so every unbounded
      // field it persists is unbounded growth in the events table -- and #267's
      // per-field clipping grew a hole the moment #270 added purchaseEstimates.
      // clipPlanContext (digest.ts) is now the only builder of this payload: it
      // clips every string leaf at the digest's OWN caps, so a field added
      // tomorrow arrives bounded. Ceiling: ~6KB of listing text per plan, at a
      // rate ceiling of 12 plans/hr, prunable like every other event.
      this.emit("plan_context", { ctx: clipPlanContext(ctx), plan: raw.plan });
      // Runtime Zod boundary on planner output, enforced once at the single
      // seam every Planner implementation's output flows through (receipt:
      // per-implementation enforcement would be N copies of the same check;
      // the compile-time Plan type alone is no barrier to a hallucinated
      // repeat:1e9 arriving via `as Plan`). A violation of plan.ts's bounds
      // (steps<=30, repeat<=50, .strict() objects) throws ZodError here,
      // lands in handlePlannerFailure's catch-all -> planner_error event
      // (existing path, not a crash), and never reaches the executor.
      let plan = PlanSchema.parse(raw.plan);
      let rewrites: PlanRewrite[] = [];
      // Cost capture (Layer 5): accumulate prompt/response chars across BOTH
      // the planner's own call(s) and the agent-level id-normalization retry
      // below -- the retry is a second full planner.plan() invocation, so its
      // chars are real spend that a single-call count would miss. model comes
      // from the planner (same instance across the retry), attributed on the
      // plan event so usage.ts can group calls/cost per model.
      let promptChars = raw.promptChars;
      let responseChars = raw.responseChars;
      const model = raw.model;

      // Name/id confusion (docs/archive/decisions-2026-07-10-to-2026-07-11.md,
      // 2026-07-10, "The first flight campaign", SM-3) caught here,
      // deterministically, against the SAME fresh surroundings gathered above
      // (not re-gathered, per simplicity rule 5). Skipped when surroundings is
      // undefined: the game rejects an invalid id regardless, so the agent
      // still wakes on the resulting blocked step.
      if (surroundings) {
        const norm = normalizePlanLocations(plan, surroundings);
        if (norm.ok) {
          plan = norm.plan;
          rewrites = norm.rewrites;
        } else {
          // Routed into the same single-retry pattern every Planner
          // implementation already applies to JSON/schema validation
          // failures (see claude-subscription.ts and ollama.ts): one more
          // call to the same planner with the error appended, so the model
          // gets a chance to self-correct using the ids it was actually
          // shown, instead of the whole replan being silently discarded.
          // Cost receipt: the retries COMPOUND -- this correction retry
          // wraps each planner's internal JSON-validation retry
          // (claude-subscription.ts:37-38), so the worst case is 4 CLI
          // invocations per replan (correction retry x planner-internal
          // retry). Acceptable because replans are rare by design (4-10/hr
          // target) and the F-3 thrash damper caps sustained frequency.
          const errorText = `Previous plan invalid: ${norm.error}. ` +
            `Params take the id exactly as shown in surroundings, never the display name.`;
          const retryCtx: PlanContext = {
            ...ctx,
            instruction: ctx.instruction ? `${ctx.instruction} ${errorText}` : errorText,
          };
          const raw2 = await planner.plan(retryCtx);
          plan = PlanSchema.parse(raw2.plan);
          promptChars += raw2.promptChars;
          responseChars += raw2.responseChars;
          const norm2 = normalizePlanLocations(plan, surroundings);
          if (!norm2.ok) {
            throw new Error(`plan id-normalization failed after retry: ${norm2.error}`);
          }
          plan = norm2.plan;
          rewrites = norm2.rewrites;
        }
      }

      this.plan = plan;
      this.cursor = { step: 0, iteration: 0 };
      this.planState = "running";
      this.blockedReason = undefined;
      this.lastPlanAt = this.now();
      // A fresh plan has submitted nothing yet, so any pending-settle from the
      // outgoing plan's last action is moot -- clear it (see awaitingResolution).
      this.awaitingResolution = false;
      // #431: likewise for the server-retry episode -- the attempt count and
      // pacing belong to a step of the outgoing plan, which no longer exists.
      this.serverRetries = 0;
      this.serverRetryHoldTicks = 0;
      // Instruction satisfaction (issue #355): the planner reported the
      // standing operator instruction ALREADY carried out, so retire it from
      // goals -- the digest's STANDING OPERATOR INSTRUCTION block and the
      // Goals list both drop it, and the savePlan below persists the removal.
      // Honored ONLY when the block was actually shown this wake
      // (standingInstruction set): a flag on the arrival wake's own plan
      // cannot clear the instruction that just arrived, and a flag with no
      // standing instruction at all is a no-op -- fail-open in the safe
      // direction (an unearned flag is ignored; a missing flag just keeps the
      // block showing). The exact-string filter can never remove a standing
      // config goal, because the derivation above excluded those.
      if (plan.instruction_done && standingInstruction) {
        this.goals = this.goals.filter((g) => g !== standingInstruction);
        this.emit("instruction_done", { instruction: standingInstruction });
      }
      this.store.savePlan(this.id, plan, this.goals);
      // promptChars/responseChars/model recorded here are the cost seam usage.ts
      // reads (estimated tokens = chars/4 x per-model price table). model may be
      // undefined for a planner that doesn't report one; usage.ts buckets those
      // under "unknown".
      this.emit("plan", {
        goal: plan.goal, steps: plan.steps.length, wake: wake.reason,
        promptChars, responseChars, model,
      });
      if (rewrites.length) this.emit("plan_normalized", { rewrites });

      if (this.consecutiveTransientFailures > 0 || this.stalled) {
        this.emit("planner_recovered", { afterFailures: this.consecutiveTransientFailures });
      }
      this.consecutiveTransientFailures = 0;
      this.plannerBackoffUntil = 0;
      this.stalled = false;
    } catch (e) {
      this.handlePlannerFailure(e);
    }
  }

  // Invariant (docs/archive/decisions-2026-07-10-to-2026-07-11.md, 2026-07-11,
  // "The SM-8 experiment" / "Correction to SM-8"): a wake with no status/cargo
  // change must still carry what the OUTGOING plan was doing.
  // Enumerated inputs: this.plan (the
  // outgoing plan -- read here before replan() reassigns it further down, in
  // the same tick), this.lastCompletedGoal (set only in executeOne()'s
  // "plan_done" branch below, since this.plan is already null by the time
  // replan() runs after a completion), and wake.reason (only to pick the
  // blocked/superseded label when a plan is still set). Branches on
  // `this.plan` truthiness first, NOT on wake.reason === "plan_done": an
  // operator instruction can race ahead of the "plan_done" wake (instruct()
  // is called from outside the tick loop -- evaluateWake in wake.ts checks
  // `instruction` before `planState`), landing in this method with
  // wake.reason "instruction" while this.plan is already null and
  // lastCompletedGoal is already set. Gating on wake.reason alone (an earlier
  // version of this fix did) silently dropped the just-completed goal in
  // that race -- reviewer-caught and reproduced, not hypothetical.
  //   - this.plan set    -> blocked (blocked wake) or superseded (anything
  //     else preempting a still-running plan: instruction, notification,
  //     low_fuel/low_hull, heartbeat).
  //   - this.plan null   -> completed via lastCompletedGoal if a plan JUST
  //     finished (whatever wake reason got here first), else undefined (no
  //     plan has ever existed yet -- the genuine first-ever replan).
  private derivePreviousGoal(wake: WakeReason): PreviousGoal | undefined {
    if (this.plan) {
      return { goal: this.plan.goal, outcome: wake.reason === "blocked" ? "blocked" : "superseded" };
    }
    return this.lastCompletedGoal ? { goal: this.lastCompletedGoal, outcome: "completed" } : undefined;
  }

  // F-1 fix: map awareness for the digest (src/planner/digest.ts renders this
  // as the "System / POIs / Connections" section) so the planner has real ids
  // to ground a destination in instead of inventing one (ground truth:
  // maiden-flight "alpha_mining" hallucination, no location data available to
  // check the destination against). Enumerated inputs: api.getSystem() and
  // status.dockedAt -- the two sources Surroundings is built from (see
  // src/planner/types.ts and src/client/client.ts's SystemInfo -- get_system's
  // own system.pois list carries POI type/class, so a separate getPoi() call
  // is no longer needed here as of the 2026-07-10 shape fix). No caching:
  // called fresh from this tick's already-fresh status on every replan()
  // invocation, same as summarizeStatus above. Optional on GameApi (client.ts)
  // so fakes/mocks that don't implement getSystem (most of the existing test
  // suite) just get undefined surroundings, which digest.ts already renders
  // as "no surroundings section" -- not a new failure mode.
  //
  // Invariant: a getSystem()/getPoi() failure must be VISIBLE, never a silent
  // degrade to blank surroundings -- see docs/archive/decisions-2026-07-10-to-2026-07-11.md
  // (2026-07-10, "The first flight campaign", SM-2) for why. Both failure
  // modes below emit `surroundings_error` (mirroring
  // `status_error` in runOnce()) before degrading; replanning still proceeds
  // without map context.
  private async gatherSurroundings(status: StatusSnapshot | null): Promise<Surroundings | undefined> {
    if (!this.api.getSystem) return undefined;
    try {
      const system = await this.api.getSystem();
      if (system.id == null) {
        this.emit("surroundings_error", { message: "get_system returned no usable location data" });
        return undefined;
      }
      // stall-watcher v4: cache whether the current POI can refuel us, for the
      // strand detector. A base OR a positive fuel_reserve here means the docked
      // reflex can top up -> not a strand. Refreshed every replan from fresh
      // get_system data; false when there's no currentPoi (unknown -> the
      // behavioral fuel-block signal decides).
      const cp = system.currentPoi;
      this.currentPoiHasBase = !!(cp && (cp.hasBase || (cp.fuelReserve ?? 0) > 0));
      return {
        systemId: system.id,
        systemName: system.name,
        connections: system.connections,
        pois: system.pois,
        dockedAt: status?.dockedAt ?? null,
        currentPoi: system.currentPoi,
      };
    } catch (e) {
      this.emit("surroundings_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined; // best-effort: a broken map query shouldn't block replanning
    }
  }

  // POI-extraction backstop (issue #253): when a blocked wake carries the
  // game's extraction-refusal text (EXTRACTION_BLOCK_RE -- "You need a gas
  // harvester module to collect resources here"), remember the current POI as
  // incompatible with the ship's fit. Called from replan() right after
  // gatherSurroundings, the one seam where the blocked detail and the POI id
  // are both fresh in hand. Emits poi_incompatible only on a NEW lesson, so
  // the persisted event stream (the restart-safe source the constructor
  // rebuilds from) stays one event per fact, not one per replay.
  private learnIncompatiblePoi(wake: WakeReason, surroundings: Surroundings | undefined): void {
    if (wake.reason !== "blocked" || !wake.detail || !surroundings?.currentPoi) return;
    const m = EXTRACTION_BLOCK_RE.exec(wake.detail);
    if (!m) return;
    const module = m[1]!.toLowerCase();
    const poiId = surroundings.currentPoi.id;
    if (this.incompatiblePois.get(poiId) === module) return;
    this.incompatiblePois.set(poiId, module);
    if (this.incompatiblePois.size > MAX_INCOMPATIBLE_POIS) {
      const oldest = this.incompatiblePois.keys().next().value;
      if (oldest !== undefined) this.incompatiblePois.delete(oldest);
    }
    this.emit("poi_incompatible", { poiId, module });
  }

  // POI-extraction backstop (issue #253): stamp the learned incompatibilities
  // onto this replan's fresh surroundings so the digest renders the
  // [mine blocked here ...] marker (digest.ts renderSurroundings). Self-heal
  // pass in the same loop: an entry whose required module is NOW fitted is
  // dropped instead of stamped -- the memory's inputs are the POI's resource
  // type AND the ship's fitted modules, and the second one changes when the
  // pilot buys the harvester the marker told it to buy. Matching is on the
  // catalog id prefix ("gas harvester" -> gas_harvester_*), the same
  // id-over-prose discipline as the fuel-cell fix.
  private applyIncompatiblePois(surroundings: Surroundings | undefined, modules?: FittedModule[]): void {
    if (!surroundings) return;
    for (const p of surroundings.pois) {
      const module = this.incompatiblePois.get(p.id);
      if (!module) continue;
      const snake = module.replace(/ /g, "_");
      const nowFitted = modules?.some(
        (mod) => mod.typeId.toLowerCase().startsWith(snake) ||
          (mod.name ?? "").toLowerCase().replace(/ /g, "_").startsWith(snake),
      );
      if (nowFitted) {
        this.incompatiblePois.delete(p.id);
        continue;
      }
      p.incompatible = module;
    }
  }

  // Learned sparse-deposit rules (issue #188, part 3): when a blocked wake
  // carries the game's too-sparse refusal (failureClass "too_sparse" --
  // "deposits too sparse" / "the beam disperses"), remember (current POI,
  // current mining fit) so the SAME repeat never costs a second tick. Called
  // from replan() right after learnIncompatiblePoi, the one seam where the
  // blocked detail, the POI id and the fitted set are all fresh in hand (a
  // blocked mine doesn't move the ship). The detail is stored CLIPPED at the
  // digest's untrusted-text bound -- it re-surfaces inside the executor's
  // refusal reason, so it must stay bounded game text. Re-learning after TTL
  // expiry is a NEW lesson (fresh learnedAt, fresh event); a still-valid
  // duplicate is skipped so the persisted stream stays one event per fact.
  private learnSparseDeposit(
    wake: WakeReason, surroundings: Surroundings | undefined, status: StatusSnapshot | null,
  ): void {
    if (wake.reason !== "blocked" || !wake.detail || !surroundings?.currentPoi) return;
    if (failureClass(wake.detail) !== TOO_SPARSE_CLASS) return;
    const equipmentKey = miningEquipmentKey(status?.modules);
    if (!equipmentKey) return; // unknown or laser-less fit -> nothing to key the lesson on
    const poiId = surroundings.currentPoi.id;
    const existing = this.sparseRules.get(poiId);
    if (existing && existing.equipmentKey === equipmentKey && this.sparseRuleValid(existing)) return;
    const detail = wake.detail.length > 200 ? wake.detail.slice(0, 200) : wake.detail;
    this.sparseRules.set(poiId, { equipmentKey, detail, learnedAt: this.now() });
    if (this.sparseRules.size > MAX_SPARSE_RULES) {
      const oldest = this.sparseRules.keys().next().value;
      if (oldest !== undefined) this.sparseRules.delete(oldest);
    }
    this.emit("mine_sparse_learned", { poiId, equipmentKey, detail });
  }

  private sparseRuleValid(rule: { learnedAt: number }): boolean {
    return this.now() - rule.learnedAt < SPARSE_RULE_TTL_HOURS * 3_600_000;
  }

  // Learned sparse-deposit rules (issue #188): the currently-valid rules as
  // plain data for the executor's mine guard -- TTL filtered HERE so the
  // executor stays clockless (the agent owns the injectable clock). Expired
  // entries are pruned as they are seen, so the map never accumulates dead
  // rules between restarts.
  private currentSparseRules(): LearnedSparseRule[] {
    const out: LearnedSparseRule[] = [];
    for (const [poiId, rule] of this.sparseRules) {
      if (!this.sparseRuleValid(rule)) { this.sparseRules.delete(poiId); continue; }
      out.push({ poiId, equipmentKey: rule.equipmentKey, detail: rule.detail });
    }
    return out;
  }

  // Learned sparse-deposit rules (issue #188): stamp the digest-side marker
  // (the #351 pairing -- every executor guard gets a digest verdict) onto this
  // replan's fresh surroundings. A POI is stamped only while its rule is
  // valid (TTL) AND keyed to the CURRENT mining fit -- a refit un-stamps it,
  // the same fit-is-a-cache-input self-heal as applyIncompatiblePois above.
  // Boolean only: the marker text is fixed in the digest, so no game text
  // rides the field.
  private applySparseMarkers(surroundings: Surroundings | undefined, modules?: FittedModule[]): void {
    if (!surroundings) return;
    const key = miningEquipmentKey(modules);
    if (!key) return;
    for (const p of surroundings.pois) {
      const rule = this.sparseRules.get(p.id);
      if (rule && rule.equipmentKey === key && this.sparseRuleValid(rule)) p.sparse = true;
    }
  }

  // Mission-funnel fix (issue #147): the digest's mission briefing used to
  // instruct the planner to plan get_missions -- a kind:"query" action
  // (actions.ts) that PlanSchema structurally rejects (only mutations are
  // plan steps), so the mission funnel was unreachable: 11 planner_errors/48h
  // from plans carrying get_missions, 4 empty accept_mission attempts blocked
  // by the executor guard, zero mission steps ever executed. Producer fix:
  // the HARNESS fetches the listing (a free query, same family as
  // status/getSystem) and the digest hands the planner the data instead of an
  // unplannable action. Enumerated inputs: status.docked and api.getMissions
  // -- fetched ONLY when DOCKED (missions need a station; an undocked or
  // unknown-status tick makes no call at all), once per replan like
  // gatherSurroundings. Fail-soft, mirroring gatherSurroundings: a missing
  // api method, a thrown fetch, or an empty listing all degrade to undefined
  // (digest renders no mission section) and never block the replan;
  // missions_error mirrors surroundings_error so a live failure is visible in
  // the event feed instead of degrading silently.
  private async gatherMissions(status: StatusSnapshot | null): Promise<string | undefined> {
    if (!status?.docked || !this.api.getMissions) return undefined;
    try {
      const text = await this.api.getMissions();
      return text.trim() ? text : undefined;
    } catch (e) {
      this.emit("missions_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Active-mission visibility fix (issue #170, the predicted #147 follow-up):
  // accepted missions were invisible at plan time -- get_active_missions is
  // kind:"query" (unplannable by design) and nothing fetched it, so the
  // planner treated every dock as a fresh start and complete_mission had no
  // id source. Same producer-side pattern as gatherMissions above (harness
  // fetches the raw listing, digest hands it to the planner), with ONE
  // deliberate divergence from #156: NO docked gate. The invariant: the
  // planner must always see work-in-progress -- an accepted mission's
  // objective is worked in space (haul, mine, travel), so gating this fetch
  // on docked would hide the pilot's own commitments for exactly the ticks
  // it should be acting on them. The available listing stays docked-only
  // (missions are offered at stations); this listing is docked-or-not.
  // Kept as a separate method rather than folded into gatherMissions
  // (the "one combined gather step" option): combining would change that
  // method's return shape and ripple through its call site and tests for no
  // behavioral gain, and separate try/catches are the point -- a failure of
  // either fetch degrades that section only. Fail-soft mirrors gatherMissions;
  // active_missions_error mirrors missions_error so a live failure is visible
  // in the event feed instead of degrading silently.
  // Zero-case (PR #175 revision): the game's zero-active reply is the
  // NON-EMPTY text "No active missions." -- the client detects it off the
  // captured structuredContent.missions.active = [] and returns "", which
  // the trim below maps to undefined: no active section, no priority line.
  // Mission-progress bridge (issue #291): the one fetch now yields BOTH the
  // raw listing (unchanged #170 contract) and the parsed mission facts, each
  // mapped to undefined when empty so the digest's presence-gates stay
  // meaningful. Fail-soft covers both reads with the one try/catch: they ride
  // the same envelope, so there is no failure of one without the other.
  private async gatherActiveMissions(): Promise<{ text?: string; missions?: ActiveMissionStatus[] }> {
    if (!this.api.getActiveMissions) return {};
    try {
      const res = await this.api.getActiveMissions();
      const missions = res.missions?.map((m) => this.summarizeActiveMission(m));
      return {
        text: res.text.trim() ? res.text : undefined,
        missions: missions?.length ? missions : undefined,
      };
    } catch (e) {
      this.emit("active_missions_error", { message: e instanceof Error ? e.message : String(e) });
      return {};
    }
  }

  // Mission-progress bridge (issue #291), the staleness derivation (Gap B).
  // The live receipt: the Titanium Extraction Contract sat at 0/20 for ~57h
  // and nothing ever weighed abandoning it -- abandon_mission has been
  // registered since #124 (actions.ts) and was never once planned, because no
  // datum ever said "this contract is going nowhere". zeroProgressHours is
  // that datum: hours since accepted_at, derived ONLY when progress is
  // actually zero (percent_complete === 0, or -- when the game omits
  // percent_complete -- every objective at current 0 and not completed) AND
  // accepted_at parses. Anything else leaves it undefined: staleness UNKNOWN,
  // no advisory (absence is not a verdict, #94). Computed here at the
  // producer against this.now() (the injectable clock), never in buildDigest
  // -- the digest must stay a pure function of its ctx so the plan_context
  // event replays byte-identically for the offline eval (#263).
  private summarizeActiveMission(m: ActiveMissionInfo): ActiveMissionStatus {
    const zeroProgress = m.percentComplete === 0 ||
      (m.percentComplete === undefined && m.objectives.length > 0 &&
        m.objectives.every((o) => (o.current ?? 0) === 0 && !o.completed));
    let zeroProgressHours: number | undefined;
    if (zeroProgress && m.acceptedAt) {
      const accepted = Date.parse(m.acceptedAt);
      if (Number.isFinite(accepted)) {
        const hours = (this.now() - accepted) / 3_600_000;
        if (hours >= 0) zeroProgressHours = hours;
      }
    }
    return {
      missionId: m.missionId,
      title: m.title,
      expiresInTicks: m.expiresInTicks,
      percentComplete: m.percentComplete,
      zeroProgressHours,
      objectives: m.objectives,
    };
  }

  // Mission-progress bridge (issue #291), the deposit cross-check fetch
  // (Gap A). The live miss: the pilot planned "Mine titanium at Gold Run
  // Mineral Fields" for ~57h while the belt yielded palladium/vanadium/
  // carbon/gold and zero titanium -- WHERE a resource spawns is deliberately
  // undocumented discovery content (mining.md:69), but WHAT THIS DEPOSIT
  // CONTAINS is one free get_poi away (mining.md:29-38; GetPOIResponse
  // resources[].resource_id), and nothing ever ran it.
  // Gate: fetch when the current POI is a mineable type (the same
  // EXTRACTION_MODULE_BY_POI_TYPE map the digest's markers key on -- at a
  // station or planet there is no deposit to check). The #302 cut also
  // required an active mission wanting an item; issue #188 dropped that
  // half: the mining-feasibility verdict (supported_power vs the fitted
  // array, digest.ts renderDepositCheck) consumes the fetch at ANY mineable
  // POI -- the very incident this issue reopens had no mission attached.
  // Fail-soft like every gather; a fetch that succeeds but yields NO
  // parseable resources at a mineable POI emits poi_deposits_error (shape
  // divergence must be visible, the SM-2 lesson) and returns undefined --
  // never an empty list the digest could read as "this deposit yields
  // nothing" (#94).
  private async gatherPoiDeposits(
    surroundings: Surroundings | undefined,
  ): Promise<PoiDepositsResult | undefined> {
    if (!this.api.getPoiDeposits) return undefined;
    const poiType = surroundings?.currentPoi?.type;
    if (!poiType || !EXTRACTION_MODULE_BY_POI_TYPE[poiType]) return undefined;
    try {
      const res = await this.api.getPoiDeposits();
      if (!res || res.deposits.length === 0) {
        this.emit("poi_deposits_error", { message: "get_poi returned no parseable resources at a mineable POI" });
        return undefined;
      }
      return res;
    } catch (e) {
      this.emit("poi_deposits_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Remote-POI targeting fix (issue #176): scan was a 100%-broken capability
  // (16/16 lifetime attempts blocked, every recent one `invalid_target: Target
  // '<poi_id>' not found at your current location`) for a producer-side reason:
  // the planner was only ever SHOWN POI ids (the digest's surroundings block),
  // and a POI is a place, not a scannable entity. The game's own error names
  // get_nearby as the source of valid targets, but get_nearby is kind:"query"
  // -- the planner structurally cannot plan it (PlanSchema admits only
  // mutations). Same producer-side pattern as gatherMissions/gatherActiveMissions:
  // the harness fetches the listing and the digest hands the planner the ids.
  // NO gate (unlike the docked-only available-mission listing): what is near you
  // is a fact of your POSITION, and scanning happens in space, so gating this on
  // docked would hide the targets for exactly the ticks the pilot can act on
  // them. Fail-soft mirrors gatherMissions -- a missing api method, a thrown
  // fetch, or an empty listing degrade to undefined (the digest then briefs that
  // there is nothing to scan here) and never block the replan; nearby_error
  // mirrors missions_error so a live failure is visible in the event feed.
  private async gatherNearby(): Promise<string | undefined> {
    if (!this.api.getNearby) return undefined;
    try {
      const text = await this.api.getNearby();
      return text.trim() ? text : undefined;
    } catch (e) {
      this.emit("nearby_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Capability-audit follow-up (2026-07-19): fetched every replan, ungated,
  // same reasoning as gatherNearby above -- what is around you and whether
  // you're mid-transit are facts of your position, not of a station.
  // client.getLocation already filters to "something worth telling the
  // planner" (undefined otherwise), so this method is a thin fail-soft wrapper
  // mirroring gatherNearby's error-emit contract, not a second filter.
  private async gatherLocation(): Promise<LocationInfo | undefined> {
    if (!this.api.getLocation) return undefined;
    try {
      return await this.api.getLocation();
    } catch (e) {
      this.emit("location_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Buyable-here surfacing (issue #93): the no-buyers thrash class (38
  // identical "Sold 0 Palladium Ore ... (no buyers)" blocks at one station,
  // live 2026-07-13) is a sell decision made blind — view_market is
  // kind:"query" so the planner can never plan it, and nothing else told the
  // planner what THIS station buys. Same producer-side pattern as
  // gatherMissions (harness fetches the query, digest hands the planner the
  // data), with a TIGHTER gate: docked AND cargo aboard. Docked because
  // view_market requires a dock; cargo because the rows exist to answer "can
  // I sell what I hold HERE" — with an empty hold there is no sell decision,
  // so the feature's one extra game query per replan is spent only when the
  // answer is decidable (an empty-hold docked replan makes no call at all).
  // Fail-soft mirrors gatherMissions, with one addition: a fetch that
  // SUCCEEDS but parses to zero rows also degrades to undefined AND emits
  // market_error — the parse is keyed to the single captured view_market
  // shape (parseMarketText), so an empty parse at a real market most likely
  // means the live HTTP response shape diverged from that capture, and that
  // must be visible in the event feed, not silent (the SM-2 lesson). The
  // digest renders nothing rather than claiming "no buyer" from missing data.
  // Capability audit (Workflow A, 2026-07-19): dedicated get_cargo fetch,
  // preferred over the get_status-derived StatusSnapshot.cargo the digest
  // otherwise falls back to (see the PlanContext.cargo assembly in replan()
  // below). Ungated -- unlike gatherMarket/gatherShipyard this is not a
  // docked-only fact, cargo travels with the ship -- and free (a query, no
  // tick). Fail-soft mirrors gatherShipyard: a missing api method, a thrown
  // fetch, or an undefined parse all degrade to undefined, and the caller
  // falls back to the older get_status path rather than losing the section
  // entirely. cargo_error mirrors market_error/shipyard_error so a live
  // failure is visible in the event feed instead of degrading silently.
  private async gatherCargo(): Promise<{ used: number; capacity: number; items: CargoItem[] } | undefined> {
    if (!this.api.getCargo) return undefined;
    try {
      return await this.api.getCargo();
    } catch (e) {
      this.emit("cargo_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  private async gatherMarket(status: StatusSnapshot | null): Promise<MarketRow[] | undefined> {
    if (!status?.docked || !status.cargo?.length || !this.api.getMarket) return undefined;
    try {
      const rows = await this.api.getMarket();
      if (!rows.length) {
        this.emit("market_error", { message: "view_market returned no parseable market rows" });
        return undefined;
      }
      return rows;
    } catch (e) {
      this.emit("market_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Market-intelligence injection (issue #269): the no-buyers remedy (shipped
  // after the palladium/M-33 incident) was INERT because it told the planner to
  // "check view_orders / analyze_market" for a buyer elsewhere -- but both are
  // kind:"query" so PlanSchema can never admit them, AND (reference-checked) the
  // briefing had the wrong tool: view_orders shows the pilot's OWN orders, not a
  // third party's bid. analyze_market IS the game's buyer-discovery query
  // (regional demand, skill-gated, visited-stations-only per markets.md), so the
  // harness fetches it -- the exact producer-side pattern the M-28/#147 mission
  // funnel used when get_missions was likewise unplannable. Gate mirrors
  // gatherMarket (docked AND cargo): docked because analyze_market reads the
  // CURRENT station's regional view, cargo because the insight exists to answer
  // "where do I sell what I hold" -- an empty-hold docked replan makes no call.
  // Fail-soft mirrors gatherMissions, and (like gatherPurchaseEstimates)
  // ABSENCE IS NOT A VERDICT: a missing api method, a thrown fetch, or an empty
  // answer all yield undefined (the digest renders no insight section) -- never
  // a "no buyer anywhere" claim (#94). analyze_market_error mirrors
  // market_error so a live failure is visible in the event feed.
  private async gatherAnalyzeMarket(status: StatusSnapshot | null): Promise<string | undefined> {
    if (!status?.docked || !status.cargo?.length || !this.api.analyzeMarket) return undefined;
    try {
      const text = await this.api.analyzeMarket();
      return text.trim() ? text : undefined;
    } catch (e) {
      this.emit("analyze_market_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Ship tool (issue #219): the shipyard listings at THIS station. Same
  // producer-side pattern as gatherMissions -- browse_ships is kind:"query", so
  // the planner can never plan it, yet buy_listed_ship needs a listing_id that
  // exists nowhere else. Gated on docked (a shipyard belongs to a station; an
  // undocked browse has nothing to browse) and, unlike gatherMarket, NOT gated
  // on cargo: buying a hull is a credits decision, not a cargo one. Fail-soft
  // mirrors gatherMissions -- a missing api method, a thrown fetch, or an empty
  // listing all degrade to undefined (the digest renders no shipyard section)
  // and never block the replan; shipyard_error mirrors missions_error so a live
  // failure is visible in the event feed instead of degrading silently.
  private async gatherShipyard(status: StatusSnapshot | null): Promise<string | undefined> {
    if (!status?.docked || !this.api.getShipyard) return undefined;
    try {
      const text = await this.api.getShipyard();
      return text.trim() ? text : undefined;
    } catch (e) {
      this.emit("shipyard_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Capability-audit fix (Workflow A, 2026-07-19): the pilot's OWNED ships --
  // the activation half of the bought-hull gap. list_ships itself does not
  // require docking, but switch_ship (the only action this listing feeds) does
  // ("Requires shipyard service"), so this is gated on docked like
  // gatherShipyard rather than fetched every replan like gatherNearby -- an
  // undocked pilot has a ship_id it structurally cannot act on yet. Fail-soft
  // mirrors gatherShipyard: a missing api method, a thrown fetch, or an empty
  // listing all degrade to undefined (the digest renders no owned-ships
  // section) and never block the replan; owned_ships_error mirrors
  // shipyard_error so a live failure is visible in the event feed instead of
  // degrading silently.
  private async gatherOwnedShips(status: StatusSnapshot | null): Promise<string | undefined> {
    if (!status?.docked || !this.api.getOwnedShips) return undefined;
    try {
      const text = await this.api.getOwnedShips();
      return text.trim() ? text : undefined;
    } catch (e) {
      this.emit("owned_ships_error", { message: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  // Purchase discovery (issue #220): the buy-side twin of gatherMarket. The live
  // incident: the pilot's goal was to buy a Deep Core Extractor, and its plan was
  // to mine, then dock at a station and CHECK whether that station sells it --
  // because view_market (this station, docked) was the only purchase-discovery
  // action it had, so LOOKING and TRAVELLING were the same act. estimate_purchase
  // answers it for free (no credits, no tick), but it is kind:"query" --
  // unplannable -- so the harness fetches it, same producer-side pattern as
  // gatherMissions.
  // GATED ON DOCKED (issue #315, live-falsified 2026-07-17): the vendored
  // reference and the OpenAPI spec both document estimate_purchase as callable
  // from anywhere, but 15 live calls while undocked all returned
  // purchase_estimate_error -- "You must be docked at a station to perform
  // this action" (0 successes undocked in that window, vs 8 successes docked).
  // Reality overrides the docs (AGENTS.md evidence precedence); see the dated
  // correction in docs/game-reference/upstream/docs/markets.md and
  // docs/decisions.md. NOT gated on cargo (a purchase decision, not a hold
  // decision); the goal-item gate below still applies: candidates come from
  // goal-items.ts, which returns nothing unless the goals literally name a
  // catalog item.
  // Fan-out is capped at MAX_CANDIDATES (3), fired once per docked replan --
  // free queries, but the replan path is the pilot's hot path. Candidates cut by
  // the cap surface as purchase_candidate_overflow: the pre-#216-fix mode
  // (drop the WHOLE list, say nothing) kept this pipeline inert for a day.
  // FAIL-SOFT, AND ABSENCE IS NOT A VERDICT (M-34): a missing api method, an
  // undocked status, a thrown fetch, or an empty answer all yield NO section --
  // never "not purchasable". purchase_estimate_error mirrors market_error so a
  // live failure while docked is still visible in the event feed instead of
  // degrading silently.
  private async gatherPurchaseEstimates(status: StatusSnapshot | null): Promise<PurchaseEstimate[] | undefined> {
    if (!status?.docked || !this.api.estimatePurchase) return undefined;
    const { candidates, dropped } = goalPurchaseCandidates(this.goals);
    if (dropped.length) {
      this.emit("purchase_candidate_overflow", { kept: candidates.map((i) => i.id), dropped });
    }
    if (!candidates.length) return undefined;
    const estimates: PurchaseEstimate[] = [];
    for (const item of candidates) {
      try {
        const text = await this.api.estimatePurchase(item.id, 1);
        if (text.trim()) estimates.push({ itemId: item.id, name: item.name, text });
      } catch (e) {
        this.emit("purchase_estimate_error", {
          itemId: item.id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return estimates.length ? estimates : undefined;
  }

  private handlePlannerFailure(e: unknown): void {
    if (e instanceof TokenInvalidError) {
      this.claudeDisabled = true;
      this.emit("operator_alert", { class: "token_invalid", message: e.message, fallback: !!this.fallbackPlanner });
      return;
    }
    if (e instanceof SubscriptionLimitError) {
      if (this.fallbackPlanner) {
        this.usingFallback = true;
        this.emit("planner_subscription_limit", { message: e.message, action: "switched_to_fallback" });
      } else {
        this.plannerBackoffUntil = this.now() + this.config.subscriptionCooldownMinutes * 60_000;
        this.emit("planner_subscription_limit", {
          message: e.message, action: "cooldown", cooldownMinutes: this.config.subscriptionCooldownMinutes,
        });
      }
      return;
    }
    if (e instanceof TransientPlannerError) {
      this.consecutiveTransientFailures++;
      const backoffMs = Math.min(
        TRANSIENT_BACKOFF_BASE_MS * 2 ** (this.consecutiveTransientFailures - 1),
        TRANSIENT_BACKOFF_MAX_MS,
      );
      this.plannerBackoffUntil = this.now() + backoffMs;
      this.emit("planner_transient_error", {
        message: e.message, consecutiveFailures: this.consecutiveTransientFailures, backoffMs,
      });
      if (!this.stalled && this.consecutiveTransientFailures >= this.config.stallThreshold) {
        this.stalled = true;
        this.emit("stalled", { consecutiveFailures: this.consecutiveTransientFailures });
      }
      return;
    }
    // Not one of the three classified failure modes (e.g. a plan that failed
    // validation on both the original attempt and its retry) -- existing
    // Plan-1 catch-all behavior, unchanged and not duplicated above.
    this.emit("planner_error", { message: e instanceof Error ? e.message : String(e) });
  }

  // status is this tick's snapshot, already fetched in runOnce -- forwarded so
  // executeTick's inTransit guard (SM-11) and travel_to/sell pre-snapshots
  // reuse it instead of paying for a second get_status. May be null if the
  // tick's fetch failed; executeTick treats that as "no snapshot" and proceeds.
  private async executeOne(status: StatusSnapshot | null): Promise<void> {
    const step = this.plan!.steps[this.cursor.step];

    // Tick-pacing settle: spend THIS tick letting the game tick boundary pass
    // rather than re-submitting the same step (see awaitingResolution). Not a
    // permanent hold -- the heartbeat wake and no-progress detector (Layer 4)
    // still escalate a step that stays pending forever.
    if (this.awaitingResolution) {
      this.awaitingResolution = false;
      this.emit("action", {
        action: step?.action, params: step?.params, outcome: "wait",
        result: "pending action resolving; pacing to tick",
      });
      return;
    }

    // #431: mid-backoff between server-failure retries of the current step --
    // spend this tick as a hold, same shape as the settle skip above (visible
    // in the feed, no submission made). Not a permanent hold: the counter
    // strictly decrements, and the attempt cap below bounds the whole episode.
    if (this.serverRetryHoldTicks > 0) {
      this.serverRetryHoldTicks--;
      this.emit("action", {
        action: step?.action, params: step?.params, outcome: "wait",
        result: "backing off before retrying after transient server failure",
      });
      return;
    }

    // Issue #188: currently-valid learned sparse rules ride along as plain
    // data -- TTL-filtered here so the executor stays clockless.
    let result = await executeTick(this.api, this.plan!, this.cursor, status, this.currentSparseRules());

    // #431: a transient server failure (HTTP 5xx / network / open breaker) of
    // a MOVEMENT step is retried deterministically -- replanning adds zero
    // information for a 503 (live 2026-07-19: every 503 bought a full planner
    // call whose new plan re-issued the identical step). Below the cap: emit
    // the retry telemetry, arm the tick backoff, and rewrite the outcome to
    // `wait` so the existing hold-the-step path runs unchanged (cursor
    // untouched, no wake). At the cap: rewrite to the pre-#431 `blocked`
    // outcome, so the ordinary blocked wake fires AND everything keyed on
    // blocked action events (repeat-block breaker, thrash damper,
    // blockedOutcomeKey scans) sees a normal block.
    //
    // MOVEMENT_ACTIONS only (PR #442 review). Every plan step is a mutation,
    // and an ambiguous 5xx can land AFTER a server-side commit -- a blind
    // resubmit of sell/buy/mine/craft is the #137 at-least-once double-spend
    // class this codebase already fenced off (the buy-id correction
    // deliberately never auto-retries, executor.ts; http.ts's own retry note
    // calls the post-commit 5xx ambiguous and wants LESS mutation retry, not
    // more -- 3 step attempts x 3 in-call tries is a 3x widening with ~27s
    // gaps for an async commit to land before the resubmit). Movement
    // converges on re-issue (a travel/jump toward where the ship already is
    // is harmless), and ALL live #431 evidence (both incidents) is
    // travel/get_status. A non-movement server failure degrades straight to
    // today's blocked outcome: one wasted planner call beats a double-spend.
    if (result.kind === "server_retry" && !MOVEMENT_ACTIONS.has(step?.action ?? "")) {
      this.serverRetries = 0;
      const reason = result.resultText ?? result.code;
      result = { kind: "blocked", reason, resultText: reason };
    } else if (result.kind === "server_retry") {
      this.serverRetries++;
      if (this.serverRetries < SERVER_RETRY_MAX_ATTEMPTS) {
        this.emit("step_retry_5xx", {
          action: step?.action, code: result.code, attempt: this.serverRetries,
          maxAttempts: SERVER_RETRY_MAX_ATTEMPTS, backoffTicks: SERVER_RETRY_BACKOFF_TICKS,
          result: result.resultText,
        });
        this.serverRetryHoldTicks = SERVER_RETRY_BACKOFF_TICKS;
        result = { kind: "wait", resultText: result.resultText };
      } else {
        this.serverRetries = 0;
        const reason =
          `${result.resultText ?? result.code}: transient server failure persisted through ` +
          `${SERVER_RETRY_MAX_ATTEMPTS} deterministic attempts with backoff`;
        result = { kind: "blocked", reason, resultText: reason };
      }
    } else {
      this.serverRetries = 0;
    }
    // Invariant: result.resultText is stored on every action event, not just
    // blocked ones -- a future silent-failure class won't necessarily surface
    // as "blocked". See executor.ts's StepResult doc comment for why.
    this.emit("action", {
      action: step?.action, params: step?.params, outcome: result.kind, result: result.resultText,
    });

    // stall-watcher v4 strand signal: count CONSECUTIVE fuel-blocked movement
    // attempts here (the producer of blocks), so the count accrues even on ticks
    // the wake-branch thrash gate would return first. A fuel-blocked movement is
    // the ONLY thing that increments; every other outcome -- a successful move, a
    // non-fuel block, a `wait`, OR any non-movement action (mine, dock, ...) --
    // resets it. Resetting on ANY non-fuel-block outcome (not just movement ones)
    // is deliberate: it keeps the count meaning "N fuel-blocked moves in a row
    // with nothing else in between," so a stale-high count can't survive
    // intervening activity and later assert a strand without a FRESH failed move.
    if (step) {
      const fuelBlockedMove =
        result.kind === "blocked" && MOVEMENT_ACTIONS.has(step.action) && /fuel/i.test(result.reason);
      this.fuelBlockedMoves = fuelBlockedMove ? this.fuelBlockedMoves + 1 : 0;
    }

    if (result.kind === "continue") {
      this.cursor = result.cursor;
      this.store.saveCursor(this.id, this.cursor);
      // The accept is still resolving -- pace the NEXT tick (see the settle
      // branch at the top of executeOne). Only set by a same-step continue.
      if (result.settle) this.awaitingResolution = true;
    } else if (result.kind === "wait") {
      // Hold the CURRENT step (cursor untouched, planState stays "running")
      // for a transient, self-resolving block -- see classifyGameError in
      // executor.ts. A block that never clears is caught by the heartbeat wake.
    } else if (result.kind === "plan_done") {
      // SM-6 fix: captured before the null-out below -- see
      // derivePreviousGoal's comment for why this can't just read this.plan
      // at replan() time for the "plan_done" case.
      this.lastCompletedGoal = this.plan?.goal;
      this.planState = "done";
      this.plan = null;
      this.store.clearPlan(this.id);
    } else {
      this.planState = "blocked";
      this.blockedReason = result.reason;
      // F-3 thrash-streak counting (consecutiveThrashWakes/lastThrashKey)
      // no longer happens here -- SM-4 found that a no-op travel_to's
      // successful "continue" (travelToTick's same-position short-circuit)
      // moved the cursor off {0,0} before the SAME block recurred, so the old
      // cursor-based check here never saw it. Counting moved to runOnce()'s
      // "blocked" wake branch, keyed on result.reason repetition instead of
      // cursor position -- see BLOCKED_THRASH_THRESHOLD's comment.
    }
  }

  /** Production loop: one iteration per game tick. */
  start(intervalMs = 10_000): void {
    if (this.timer) return;
    let running = false;
    this.timer = setInterval(async () => {
      if (running) return; // travel calls can outlast the interval
      running = true;
      try {
        await this.runOnce();
      } catch (e) {
        this.emit("loop_error", { message: e instanceof Error ? e.message : String(e) });
      } finally {
        running = false;
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
