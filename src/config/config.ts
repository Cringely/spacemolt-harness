import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SpacemoltClient } from "../client/client";
import { PROGRESS_COUNTERS } from "../agent/no-progress-detector";

// base_url / api_key_file exist for openai-compat (#240): the endpoint is
// per-planner config (a LAN LM Studio box), not a harness-wide URL like
// ollama_url. api_key_file is a PATH to a secret (the _FILE pattern,
// security-baseline.md) -- an inline api_key field deliberately does not
// exist, and .strict() rejects it at load. Keys stay snake_case through the
// PlannerSpec interface below because the spec travels to planner-factory.ts
// as parsed (no camelCase mapping layer for a 2-field growth).
const PlannerSpecSchema = z.object({
  provider: z.enum(["mock", "claude-subscription", "codex-subscription", "ollama", "openai-compat"]),
  model: z.string().optional(),
  base_url: z.string().url().optional(),
  api_key_file: z.string().optional(),
}).strict().superRefine((spec, ctx) => {
  // Fail at load, not first replan (the .strict() philosophy): an
  // openai-compat planner with no endpoint or no model id cannot work, and
  // there is no safe default for either -- model ids differ per LM Studio
  // install, and a guessed URL would just burn transient-retry cycles.
  if (spec.provider === "openai-compat") {
    if (!spec.base_url) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "openai-compat planner requires base_url" });
    if (!spec.model) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "openai-compat planner requires model" });
  }
});

// Deterministic A/B exit condition (#240, the #251 lesson: an experiment's
// revert condition must be machine-evaluated, not a prose promise -- SM-8's
// haiku trial failed its own prose revert condition and idled a day). When an
// agent carries this block, the harness watches the named progress counter
// ("any" = the whole PROGRESS_COUNTERS allowlist summed, the same SSOT the
// no-progress detector and heartbeat use) and, if it hasn't advanced within
// within_hours, latches the agent onto its fallback_planner (which is REQUIRED
// alongside this block -- enforced in loadConfig) and emits experiment_reverted.
// One-way: it never flips back until the experiment config changes.
const ExperimentSpecSchema = z.object({
  revert_if_no: z.enum([...PROGRESS_COUNTERS, "any"]),
  // 14 days is a generous ceiling; the bound exists to catch a fat-fingered
  // value (a typo'd extra zero) at load, same rationale as improv budgets.
  within_hours: z.number().min(1).max(24 * 14),
}).strict();

// Improv-mode block (improv-mode plan Batch B). Optional and additive: an agent
// with no `improv:` block runs plan-then-execute, exactly as before this schema
// existed (back-compat: a stored/committed agents.yaml that predates improv keeps
// loading unchanged). `enabled:false` is the same as absent for the mode default;
// the block is still parsed/validated so a fat-finger budget is caught at load,
// not at the first improv window.
//   - model:              the LLM the improv chooser uses (Batch C). A string,
//                         validated against a planner registry there, not here.
//   - token_budget:       soft per-window ceiling (chars/4-estimated; the wall
//                         clock is the true hard stop — Batch D/E). Bounded to
//                         catch an obviously-wrong value (a negative or a typo'd
//                         extra zero) at load.
//   - wall_clock_minutes: hard per-window limit (Batch D/E revert trigger).
//   - preset:             MCP tool preset the transport requests (Batch A/§3):
//                         "standard" (9 tools) or "full" (16).
//   - schedule:           optional daily window (Batch E). "HH:MM" local start/end.
const ImprovScheduleSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/, "schedule.start must be HH:MM"),
  end: z.string().regex(/^\d{2}:\d{2}$/, "schedule.end must be HH:MM"),
}).strict();

const ImprovSpecSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().optional(),
  token_budget: z.number().int().min(1000).max(100_000_000).default(200_000),
  wall_clock_minutes: z.number().int().min(1).max(1440).default(60),
  preset: z.enum(["standard", "full"]).default("standard"),
  schedule: ImprovScheduleSchema.optional(),
}).strict();

// Single source of truth for the agent tuning defaults that BOTH the config
// loader (the Zod .default() calls below) and the Agent runtime consume. These
// seven values used to be written twice -- here as Zod defaults, and again as
// DEFAULT_* constants in agent.ts (the fallback when a partial AgentConfig built
// in a test omits the field) -- and drifted (issue #150: the max_plans comment
// read "default 12" while both copies were 36). One object, imported by agent.ts,
// ends the two-place bookkeeping. loadConfig always supplies concrete values in
// production; the agent.ts fallback only fires for test-built partial configs.
export const AGENT_DEFAULTS = {
  maxPlansPerWindow: 36,
  planBudgetWindowMinutes: 60,
  fuelReservePct: 25,
  stuckWindowMinutes: 30,
  progressHeartbeatMinutes: 30,
  repeatBlockThreshold: 3,
  repeatBlockWindowMinutes: 30,
} as const;

const AgentEntrySchema = z.object({
  id: z.string().min(1),
  username: z.string().min(3).max(24),
  empire: z.enum(["solarian", "voidborn", "crimson", "nebula", "outerrim"]),
  persona: z.string().min(1),
  // Standing goals (#216): the first-class source for durable operator
  // objectives (milestones). Persona prose is style/priorities the planner
  // reads as flavor; the deterministic goal machinery -- the digest's Goals
  // section and goalPurchaseCandidates (goal-items.ts) -- acts ONLY on
  // this.goals. A milestone written into persona never reached either (the
  // Mining Laser III goal sat 35h+ untouched at 56x the credits). Merged into
  // this.goals at Agent construction, deduped against persisted goals so a
  // restart never duplicates. max(5) mirrors MAX_GOALS (agent.ts, the
  // retained-goal cap; a value import would cycle config <-> agent): a 6th
  // standing goal could never all be live at once, so reject at load rather
  // than silently evict -- the .strict() philosophy.
  // Duplicates rejected too (PR #294 REVISE, LOW): the Agent-side merge dedupes
  // against PERSISTED goals only, so goals: [A, A] would enter twice on first
  // boot, burning a second cap slot. Same .strict() philosophy: a load error,
  // not a runtime surprise.
  goals: z.array(z.string().min(1)).max(5)
    .refine((g) => new Set(g).size === g.length, { message: "duplicate standing goals" })
    .default([]),
  planner: PlannerSpecSchema,
  fallback_planner: PlannerSpecSchema.optional(),
  fuel_pct: z.number().min(0).max(100).default(20),
  hull_pct: z.number().min(0).max(100).default(30),
  heartbeat_minutes: z.number().min(1).default(15),
  wake_notification_types: z.array(z.string()).default(["combat", "chat"]),
  // default 5: spec's "5 consecutive failures (default, configurable)"
  stall_threshold: z.number().int().min(1).default(5),
  // default 60: Claude subscription rate windows are commonly hourly; long
  // enough to avoid a hot-retry loop into a closed window, short enough to
  // recover the same day without an operator restart.
  subscription_cooldown_minutes: z.number().min(1).default(60),
  // Layer 3 (cost-safety guard): a signature-agnostic hard cap on replan
  // batches per rolling window, backstopping any thrash a finer damper misses.
  // default 36 (AGENT_DEFAULTS.maxPlansPerWindow): comfortably above the 4-10/hr
  // design plan-rate, so a healthy agent never trips it, while still bounding a
  // runaway an order of magnitude below the ~75/hr incident rate.
  max_plans_per_window: z.number().int().min(1).default(AGENT_DEFAULTS.maxPlansPerWindow),
  plan_budget_window_minutes: z.number().int().min(1).default(AGENT_DEFAULTS.planBudgetWindowMinutes),
  // stall-watcher v4. fuel_reserve_pct (25): undocked fuel-reserve floor, above
  // fuel_pct (20) so a moving pilot heads for fuel before 0. stuck_window_minutes
  // (30): the long no-progress / steward window. strand_auto_self_destruct
  // (false): opt-in to let the steward auto-destroy a hopelessly-stranded ship
  // (destructive: loses cargo); default OFF = distress + alert only. Conservative
  // defaults, annotate as experiments in agents.yaml when tuned.
  fuel_reserve_pct: z.number().min(0).max(100).default(AGENT_DEFAULTS.fuelReservePct),
  stuck_window_minutes: z.number().int().min(1).default(AGENT_DEFAULTS.stuckWindowMinutes),
  strand_auto_self_destruct: z.boolean().default(false),
  // progress heartbeat cadence (deterministic, dashboard-visible). default 30:
  // an at-a-glance "is the pilot still advancing?" pulse the operator can watch
  // continuously, distinct from heartbeat_minutes (15, the planner wake cadence)
  // and from stuck_window_minutes (30, the stall-watcher's ACT-on-stall window).
  // This one only REPORTS -- it never acts -- so a coarse cadence is fine.
  progress_heartbeat_minutes: z.number().int().min(1).default(AGENT_DEFAULTS.progressHeartbeatMinutes),
  // Same-error-repeat loop-breaker (#95). repeat_block_threshold (3): identical
  // blocked (action, target) outcomes that break the loop -- mirrors the
  // consecutive thrash threshold, few enough to catch the loop early. A SAME-KEY
  // success resets the running count, so a flaky-then-working action never
  // accrues. repeat_block_window_minutes (30): the RE-STEER COOLDOWN -- an
  // armed key is nudged at most once per window. It does not bound accrual
  // (#291 third occurrence: a doomed action blocking 5x over 4+ hours never
  // put K repeats in one trailing window); repeats accrue since the last
  // same-key success, however slowly they arrive, and fire even while other
  // progress dimensions climb (the #291 mask). Annotate as experiments in
  // agents.yaml when tuned.
  repeat_block_threshold: z.number().int().min(1).default(AGENT_DEFAULTS.repeatBlockThreshold),
  repeat_block_window_minutes: z.number().int().min(1).default(AGENT_DEFAULTS.repeatBlockWindowMinutes),
  reflex: z.object({
    keep_fuel_above: z.number().min(0).max(100).optional(),
    repair_below_hull: z.number().min(0).max(100).optional(),
  }).strict().optional(),
  improv: ImprovSpecSchema.optional(),
  experiment: ExperimentSpecSchema.optional(),
}).strict();

const ConfigSchema = z.object({
  server_url: z.string().url(),
  db_path: z.string().default("./harness.sqlite"),
  ollama_url: z.string().url().default("http://localhost:11434"),
  // Dev-mode default per security-baseline.md: 127.0.0.1 only. LAN exposure
  // is an explicit operator override in agents.yaml, never a code default --
  // Plan 4 replaces this bind entirely with a reverse proxy + SSO forwardAuth
  // and no published host port.
  dashboard_host: z.string().min(1).default("127.0.0.1"),
  dashboard_port: z.number().int().min(1).max(65535).default(8642),
  agents: z.array(AgentEntrySchema).min(1),
}).strict();

export interface PlannerSpec {
  provider: "mock" | "claude-subscription" | "codex-subscription" | "ollama" | "openai-compat";
  model?: string;
  base_url?: string;      // openai-compat only (required there, load-checked)
  api_key_file?: string;  // optional path to a bearer-token secret, never the key itself
}

// The per-agent driver mode. "plan-then-execute" is the default (and the value
// whenever no improv block is configured); "improv" is model-in-the-loop over MCP
// (Batch C wires the loop; Batch B provides the config + client seam).
export type DriverMode = "plan-then-execute" | "improv";

export interface ImprovConfig {
  enabled: boolean;
  model?: string;
  tokenBudget: number;
  wallClockMinutes: number;
  preset: "standard" | "full";
  schedule?: { start: string; end: string };
}

export interface AgentEntry {
  id: string;
  username: string;
  empire: "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim";
  persona: string;
  // Standing goals (#216): durable operator objectives, fed into the Agent's
  // structured goal channel at construction. Always present ([] when the
  // config omits the field).
  goals: string[];
  planner: PlannerSpec;
  fallbackPlanner?: PlannerSpec;
  fuelPct: number;
  hullPct: number;
  heartbeatMinutes: number;
  wakeNotificationTypes: string[];
  stallThreshold: number;
  subscriptionCooldownMinutes: number;
  maxPlansPerWindow: number;
  planBudgetWindowMinutes: number;
  fuelReservePct: number;
  stuckWindowMinutes: number;
  strandAutoSelfDestruct: boolean;
  progressHeartbeatMinutes: number;
  repeatBlockThreshold: number;
  repeatBlockWindowMinutes: number;
  reflex?: { keepFuelAbovePct?: number; repairBelowHullPct?: number };
  // Improv seam (Batch B). `improv` is present only when the block is configured;
  // `mode` is DERIVED — "improv" iff the block exists and is enabled, else
  // "plan-then-execute" (the default when the block is absent). Kept as a derived
  // field so callers select the driver without re-checking enabled everywhere.
  improv?: ImprovConfig;
  mode: DriverMode;
  // Deterministic A/B exit (#240/#251): present only when configured. The
  // Agent evaluates it every tick and latches onto fallbackPlanner when it
  // trips -- see Agent.maybeRevertExperiment.
  experiment?: { revertIfNo: string; withinHours: number };
}

export interface HarnessConfig {
  serverUrl: string;
  dbPath: string;
  ollamaUrl: string;
  dashboardHost: string;
  dashboardPort: number;
  agents: AgentEntry[];
}

export function loadConfig(path: string): HarnessConfig {
  const raw = ConfigSchema.parse(Bun.YAML.parse(readFileSync(path, "utf8")));
  // Invariant: a configured driver mode must have a real execution loop behind
  // it. The improv loop is HELD (#118) — runOnce never calls activeApi() — so an
  // agent with `improv.enabled: true` would silently run plan-then-execute while
  // the config claims improv. Fail fast at load instead (the .strict() philosophy
  // from the reflexes-typo incident: a config that lies is a load error, not a
  // runtime surprise). The improv BLOCK stays parseable — `enabled: false` still
  // validates budgets/schedule for the future — only the mode that would no-op
  // is rejected. Batch C deletes this check when it wires the loop.
  for (const a of raw.agents) {
    if (a.improv?.enabled) {
      throw new Error(
        `agent "${a.id}": improv mode is HELD (#118) and has no execution loop yet; ` +
        `set improv.enabled: false (or remove the block) or wait for Batch C`,
      );
    }
    // Same fail-fast philosophy: an experiment block whose revert has no
    // target is a config that lies -- the exit condition would trip into
    // "no planner available" instead of a fallback. Load error, not a
    // runtime surprise.
    if (a.experiment && !a.fallback_planner) {
      throw new Error(
        `agent "${a.id}": experiment requires a fallback_planner to revert to (#240)`,
      );
    }
  }
  return {
    serverUrl: raw.server_url,
    dbPath: raw.db_path,
    ollamaUrl: raw.ollama_url,
    dashboardHost: raw.dashboard_host,
    dashboardPort: raw.dashboard_port,
    agents: raw.agents.map((a) => ({
      id: a.id, username: a.username, empire: a.empire, persona: a.persona,
      goals: a.goals,
      planner: a.planner,
      fallbackPlanner: a.fallback_planner,
      fuelPct: a.fuel_pct, hullPct: a.hull_pct,
      heartbeatMinutes: a.heartbeat_minutes,
      wakeNotificationTypes: a.wake_notification_types,
      stallThreshold: a.stall_threshold,
      subscriptionCooldownMinutes: a.subscription_cooldown_minutes,
      maxPlansPerWindow: a.max_plans_per_window,
      planBudgetWindowMinutes: a.plan_budget_window_minutes,
      fuelReservePct: a.fuel_reserve_pct,
      stuckWindowMinutes: a.stuck_window_minutes,
      strandAutoSelfDestruct: a.strand_auto_self_destruct,
      progressHeartbeatMinutes: a.progress_heartbeat_minutes,
      repeatBlockThreshold: a.repeat_block_threshold,
      repeatBlockWindowMinutes: a.repeat_block_window_minutes,
      reflex: a.reflex
        ? { keepFuelAbovePct: a.reflex.keep_fuel_above, repairBelowHullPct: a.reflex.repair_below_hull }
        : undefined,
      improv: a.improv
        ? {
            enabled: a.improv.enabled,
            model: a.improv.model,
            tokenBudget: a.improv.token_budget,
            wallClockMinutes: a.improv.wall_clock_minutes,
            preset: a.improv.preset,
            schedule: a.improv.schedule,
          }
        : undefined,
      experiment: a.experiment
        ? { revertIfNo: a.experiment.revert_if_no, withinHours: a.experiment.within_hours }
        : undefined,
      // Derive the driver mode: improv only when the block exists AND is enabled.
      mode: a.improv?.enabled ? "improv" : "plan-then-execute",
    })),
  };
}

/**
 * Idempotent first-run registration: password file exists -> reuse it;
 * otherwise register (consumes the shared registration code) and persist
 * the returned password before anything else can fail.
 */
export async function ensureCredentials(
  client: SpacemoltClient, entry: AgentEntry, secretsDir: string,
): Promise<string> {
  // Read directly and treat "not found" as the register path, rather than
  // existsSync-then-read (a check-then-use file race). Any other read error
  // (e.g. permissions) still propagates.
  const pwFile = join(secretsDir, `${entry.id}_password`);
  try {
    return readFileSync(pwFile, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const codeFile = join(secretsDir, "registration_code");
  let code: string;
  try {
    code = readFileSync(codeFile, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new Error(`missing ${codeFile} — get a registration code from https://spacemolt.com/dashboard`);
  }
  const { password } = await client.register(entry.username, entry.empire, code);
  writeFileSync(pwFile, password + "\n", { mode: 0o644 });
  return password;
}
