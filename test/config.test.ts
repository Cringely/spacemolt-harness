import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ensureCredentials, AGENT_DEFAULTS } from "../src/config/config";
import { SpacemoltHttp } from "../src/client/http";
import { SpacemoltClient } from "../src/client/client";
import { startFakeServer, type FakeServer } from "./fake-server";

let server: FakeServer;
afterEach(() => server?.stop());

const yaml = `
server_url: http://localhost:9999
db_path: ./harness.sqlite
agents:
  - id: miner
    username: Test Miner
    empire: nebula
    persona: "A patient ore miner."
    planner: { provider: mock }
  - id: scout
    username: Test Scout
    empire: outerrim
    persona: "A curious explorer."
    planner: { provider: mock }
    fuel_pct: 35
    heartbeat_minutes: 5
`;

describe("loadConfig", () => {
  test("parses yaml with defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml);
    const cfg = loadConfig(path);
    expect(cfg.serverUrl).toBe("http://localhost:9999");
    expect(cfg.agents.length).toBe(2);
    const miner = cfg.agents[0]!;
    expect(miner.fuelPct).toBe(20); // default
    expect(miner.heartbeatMinutes).toBe(15); // default
    expect(miner.wakeNotificationTypes).toEqual(["combat", "chat"]); // default
    expect(cfg.agents[1]!.fuelPct).toBe(35); // override
    expect(cfg.agents[1]!.heartbeatMinutes).toBe(5);
  });

  test("rejects bad empire", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml.replace("nebula", "klingon"));
    expect(() => loadConfig(path)).toThrow();
  });

  const yamlWithGrowth = `
server_url: http://localhost:9999
db_path: ./harness.sqlite
ollama_url: http://ollama.local:11434
agents:
  - id: miner
    username: Test Miner
    empire: nebula
    persona: "A patient ore miner."
    planner: { provider: claude-subscription, model: sonnet }
    fallback_planner: { provider: ollama, model: llama3.1:8b }
    stall_threshold: 3
    subscription_cooldown_minutes: 30
`;

  test("parses fallback_planner, stall_threshold, subscription_cooldown_minutes, ollama_url", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yamlWithGrowth);
    const cfg = loadConfig(path);
    expect(cfg.ollamaUrl).toBe("http://ollama.local:11434");
    const miner = cfg.agents[0]!;
    expect(miner.fallbackPlanner).toEqual({ provider: "ollama", model: "llama3.1:8b" });
    expect(miner.stallThreshold).toBe(3);
    expect(miner.subscriptionCooldownMinutes).toBe(30);
  });

  test("defaults ollama_url, stall_threshold, subscription_cooldown_minutes, no fallback_planner", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml);
    const cfg = loadConfig(path);
    expect(cfg.ollamaUrl).toBe("http://localhost:11434");
    expect(cfg.agents[0]!.fallbackPlanner).toBeUndefined();
    expect(cfg.agents[0]!.stallThreshold).toBe(5);
    expect(cfg.agents[0]!.subscriptionCooldownMinutes).toBe(60);
  });

  test("defaults dashboard_host and dashboard_port", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml);
    const cfg = loadConfig(path);
    expect(cfg.dashboardHost).toBe("127.0.0.1"); // security-baseline: LAN bind is a deploy-time override, not a default
    expect(cfg.dashboardPort).toBe(8642);
  });

  test("overrides dashboard_host and dashboard_port", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml + "\ndashboard_host: 0.0.0.0\ndashboard_port: 9000\n");
    const cfg = loadConfig(path);
    expect(cfg.dashboardHost).toBe("0.0.0.0");
    expect(cfg.dashboardPort).toBe(9000);
  });

  // Layer 2 (reflex-key fix): the incident config used `reflexes:` (plural)
  // while the schema reads `reflex:` (singular), and AgentEntrySchema was not
  // .strict(), so the whole reflex block was silently dropped -- free
  // auto-refuel-while-docked never armed. With .strict(), the misspelled key
  // now throws at load instead of vanishing, and the correct key parses.
  const reflexYaml = `
server_url: http://localhost:9999
db_path: ./harness.sqlite
agents:
  - id: miner
    username: Test Miner
    empire: nebula
    persona: "A patient ore miner."
    planner: { provider: mock }
    reflex:
      keep_fuel_above: 30
      repair_below_hull: 60
`;

  test("reflex: (singular) parses and arms the reflex config", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, reflexYaml);
    const cfg = loadConfig(path);
    expect(cfg.agents[0]!.reflex).toEqual({ keepFuelAbovePct: 30, repairBelowHullPct: 60 });
  });

  test("reflexes: (the incident's misspelling) throws at load instead of silently dropping the block", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, reflexYaml.replace("    reflex:", "    reflexes:"));
    expect(() => loadConfig(path)).toThrow();
  });

  test("any unknown agent key throws at load (.strict()), not just reflexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml + "    typo_key: 1\n");
    expect(() => loadConfig(path)).toThrow();
  });

  test("defaults max_plans_per_window and plan_budget_window_minutes", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml);
    const cfg = loadConfig(path);
    expect(cfg.agents[0]!.maxPlansPerWindow).toBe(36);
    expect(cfg.agents[0]!.planBudgetWindowMinutes).toBe(60);
  });

  test("defaults progress_heartbeat_minutes to 30, overridable", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    // Base yaml: miner takes the default. The appended key lands on the second
    // agent (scout), so assert the override there.
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml + "    progress_heartbeat_minutes: 10\n");
    const cfg = loadConfig(path);
    expect(cfg.agents[0]!.progressHeartbeatMinutes).toBe(30); // miner: default
    expect(cfg.agents[1]!.progressHeartbeatMinutes).toBe(10); // scout: override
  });

  // Single-source guard (#150): the loader's effective default for each tuning
  // field must come from AGENT_DEFAULTS, the same object agent.ts imports for its
  // runtime fallback. Before this object the values lived twice (Zod defaults +
  // agent.ts DEFAULT_* constants) and drifted. Asserting against the object (not
  // a stray literal) catches a schema .default() being edited back to a literal
  // that diverges from the shared source. A miner agent omits all seven fields.
  test("loader applies AGENT_DEFAULTS for every tuning default (single source)", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, yaml);
    const miner = loadConfig(path).agents[0]!;
    expect(miner.maxPlansPerWindow).toBe(AGENT_DEFAULTS.maxPlansPerWindow);
    expect(miner.planBudgetWindowMinutes).toBe(AGENT_DEFAULTS.planBudgetWindowMinutes);
    expect(miner.fuelReservePct).toBe(AGENT_DEFAULTS.fuelReservePct);
    expect(miner.stuckWindowMinutes).toBe(AGENT_DEFAULTS.stuckWindowMinutes);
    expect(miner.progressHeartbeatMinutes).toBe(AGENT_DEFAULTS.progressHeartbeatMinutes);
    expect(miner.repeatBlockThreshold).toBe(AGENT_DEFAULTS.repeatBlockThreshold);
    expect(miner.repeatBlockWindowMinutes).toBe(AGENT_DEFAULTS.repeatBlockWindowMinutes);
  });

  // Fix 1 (review): the reflex sub-object is .strict() too, so a typo one level
  // down (keep_fuel_abov) throws at load instead of silently dropping to {} --
  // the same silent-config-drop class L2 closes, inside the reflex block.
  test("a bad key inside reflex: throws at load (reflex sub-schema is strict)", () => {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, reflexYaml.replace("keep_fuel_above", "keep_fuel_abov"));
    expect(() => loadConfig(path)).toThrow();
  });

  // Fix 4 (review): the one shipped config artifact must keep parsing through
  // the now-strict loader -- guards against schema/example drift.
  test("the committed agents.example.yaml parses through the strict loader", () => {
    const cfg = loadConfig(join(import.meta.dir, "..", "agents.example.yaml"));
    expect(cfg.agents.length).toBeGreaterThan(0);
  });

  // --- improv block + derived driver mode (Batch B) -----------------------

  function writeYaml(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "smconf-"));
    const path = join(dir, "agents.yaml");
    writeFileSync(path, body);
    return path;
  }

  test("no improv block -> mode plan-then-execute, improv undefined (back-compat default)", () => {
    const cfg = loadConfig(writeYaml(yaml));
    expect(cfg.agents[0]!.mode).toBe("plan-then-execute");
    expect(cfg.agents[0]!.improv).toBeUndefined();
  });

  // #119: improv has no execution loop until Batch C (#118 hold), so a config
  // enabling it must fail LOUDLY at load — on pre-fix code this yaml loaded
  // fine and the agent silently ran plan-then-execute while claiming improv.
  test("improv enabled -> load-time error naming the #118 hold (no silent no-op)", () => {
    const path = writeYaml(yaml + "    improv: { enabled: true }\n");
    expect(() => loadConfig(path)).toThrow(/improv mode is HELD \(#118\)/);
    expect(() => loadConfig(path)).toThrow(/scout/); // names the offending agent
  });

  test("improv enabled:false -> mode stays plan-then-execute even though the block is present", () => {
    const path = writeYaml(yaml + "    improv: { enabled: false, model: sonnet }\n");
    const cfg = loadConfig(path);
    const scout = cfg.agents[1]!;
    expect(scout.mode).toBe("plan-then-execute");
    expect(scout.improv?.enabled).toBe(false);
    expect(scout.improv?.model).toBe("sonnet");
  });

  // enabled:false keeps the block parseable (schema intact for Batch C) — only
  // the enabled mode is rejected, so field mapping is still exercised here.
  test("improv fields override the defaults (enabled:false — block stays parseable under the #118 hold)", () => {
    const path = writeYaml(
      yaml + "    improv:\n      enabled: false\n      model: haiku\n      token_budget: 50000\n" +
        "      wall_clock_minutes: 30\n      preset: full\n      schedule: { start: \"02:00\", end: \"04:00\" }\n",
    );
    const scout = loadConfig(path).agents[1]!;
    expect(scout.improv).toEqual({
      enabled: false, model: "haiku", tokenBudget: 50_000, wallClockMinutes: 30,
      preset: "full", schedule: { start: "02:00", end: "04:00" },
    });
    expect(scout.mode).toBe("plan-then-execute");
  });

  test("rejects an out-of-range token_budget (a fat-fingered negative/zero)", () => {
    expect(() => loadConfig(writeYaml(yaml + "    improv: { enabled: true, token_budget: -5 }\n"))).toThrow();
    expect(() => loadConfig(writeYaml(yaml + "    improv: { enabled: true, token_budget: 0 }\n"))).toThrow();
  });

  test("rejects a malformed schedule time and an unknown improv key (strict)", () => {
    expect(() => loadConfig(writeYaml(yaml + "    improv: { enabled: true, schedule: { start: \"2am\", end: \"04:00\" } }\n"))).toThrow();
    expect(() => loadConfig(writeYaml(yaml + "    improv: { enabled: true, budget: 5 }\n"))).toThrow();
  });

  // --- standing goals channel (#216) ---------------------------------------

  // Breakage caught: the #216 producer fix not existing -- a standing milestone
  // having no first-class config field, so it lives in persona prose where the
  // structured goal machinery (goalPurchaseCandidates, the digest Goals
  // section) never sees it.
  test("goals: parses into entry.goals; absent -> [] (a pre-#216 config loads unchanged)", () => {
    const cfg = loadConfig(writeYaml(
      yaml + "    goals:\n      - \"Milestone: buy and fit a Mining Laser III\"\n",
    ));
    expect(cfg.agents[1]!.goals).toEqual(["Milestone: buy and fit a Mining Laser III"]); // scout: the appended key
    expect(cfg.agents[0]!.goals).toEqual([]); // miner: absent field, unchanged
  });

  // Breakage caught: a config that lies -- an empty goal matches nothing, and a
  // 6th standing goal would be silently evicted by the agent's retained-goal
  // cap (MAX_GOALS = 5). Both are load errors, not runtime surprises.
  test("rejects an empty-string goal and more standing goals than the retained cap (5)", () => {
    expect(() => loadConfig(writeYaml(yaml + "    goals: [\"\"]\n"))).toThrow();
    expect(() => loadConfig(writeYaml(yaml + "    goals: [g1, g2, g3, g4, g5, g6]\n"))).toThrow();
  });

  // Breakage caught (PR #294 REVISE, LOW): the Agent merge dedupes only against
  // persisted goals, so an internal config duplicate would enter twice on first
  // boot and burn a second cap slot. Reject at load.
  test("rejects duplicate standing goals in one config list", () => {
    expect(() => loadConfig(writeYaml(yaml + "    goals: [buy a laser, buy a laser]\n"))).toThrow();
  });

  // --- openai-compat planner + experiment exit (#240) ----------------------

  // Self-contained fixture builder (appending a second planner: to the shared
  // yaml would create a duplicate YAML key on scout).
  function abYaml(plannerLine: string, extra = ""): string {
    return `
server_url: http://localhost:9999
db_path: ./harness.sqlite
agents:
  - id: pilot
    username: Test Pilot
    empire: nebula
    persona: "p"
    planner: ${plannerLine}
${extra}`;
  }

  // Breakage caught (#311): the zod provider enum and the PlannerSpec TS type
  // are SEPARATE declarations -- dropping "codex-subscription" from the enum
  // would reject every codex agents.yaml at load while the factory tests
  // (typed specs, no zod) stayed green.
  test("codex-subscription planner parses; model stays optional", () => {
    const cfg = loadConfig(writeYaml(abYaml("{ provider: codex-subscription, model: gpt-5.6-terra }")));
    expect(cfg.agents[0]!.planner).toEqual({ provider: "codex-subscription", model: "gpt-5.6-terra" });
    expect(loadConfig(writeYaml(abYaml("{ provider: codex-subscription }"))).agents[0]!.planner)
      .toEqual({ provider: "codex-subscription" });
  });

  // Breakage caught: the new provider failing to parse, or its per-planner
  // endpoint/model not surviving the load (they'd silently fall to a factory
  // default that can't exist for this provider).
  test("openai-compat planner parses with base_url and model", () => {
    const cfg = loadConfig(writeYaml(abYaml(
      "{ provider: openai-compat, model: qwen3-30b, base_url: \"http://192.168.1.50:1234\" }",
    )));
    expect(cfg.agents[0]!.planner).toEqual({
      provider: "openai-compat", model: "qwen3-30b", base_url: "http://192.168.1.50:1234",
    });
  });

  // Breakage caught: a half-configured openai-compat planner reaching runtime.
  // No safe default exists for either field, so absence must be a LOAD error.
  test("openai-compat without base_url or without model throws at load", () => {
    expect(() => loadConfig(writeYaml(abYaml("{ provider: openai-compat, model: qwen3-30b }"))))
      .toThrow(/base_url/);
    expect(() => loadConfig(writeYaml(abYaml("{ provider: openai-compat, base_url: \"http://x.lan:1234\" }"))))
      .toThrow(/model/);
  });

  // Breakage caught: an inline credential sneaking into agents.yaml. Only
  // api_key_file (a PATH) exists; a literal api_key must be rejected, not
  // silently dropped (security-baseline.md).
  test("inline api_key is rejected (strict) -- only api_key_file exists", () => {
    expect(() => loadConfig(writeYaml(abYaml(
      "{ provider: openai-compat, model: m, base_url: \"http://x.lan:1234\", api_key: \"sk-inline\" }",
    )))).toThrow();
    const cfg = loadConfig(writeYaml(abYaml(
      "{ provider: openai-compat, model: m, base_url: \"http://x.lan:1234\", api_key_file: secrets/lm_key }",
    )));
    expect(cfg.agents[0]!.planner.api_key_file).toBe("secrets/lm_key");
  });

  const withFallback = "    fallback_planner: { provider: claude-subscription, model: sonnet }\n";
  const compatLine = "{ provider: openai-compat, model: qwen3-30b, base_url: \"http://192.168.1.50:1234\" }";

  // Breakage caught: the deterministic A/B exit (#251) not being expressible,
  // or its fields not reaching the Agent.
  test("experiment block parses (named counter and 'any') and maps to the entry", () => {
    const cfg = loadConfig(writeYaml(abYaml(
      compatLine, withFallback + "    experiment: { revert_if_no: missions_completed, within_hours: 12 }\n",
    )));
    expect(cfg.agents[0]!.experiment).toEqual({ revertIfNo: "missions_completed", withinHours: 12 });

    const anyCfg = loadConfig(writeYaml(abYaml(
      compatLine, withFallback + "    experiment: { revert_if_no: any, within_hours: 6 }\n",
    )));
    expect(anyCfg.agents[0]!.experiment).toEqual({ revertIfNo: "any", withinHours: 6 });
  });

  // Breakage caught: a counter name outside the PROGRESS_COUNTERS allowlist
  // (a typo, or a movement counter like jumps_completed) arming an exit that
  // watches nothing -- the SM-8 failure shape, a revert condition that can't fire.
  test("experiment rejects a counter outside the progress allowlist and unknown keys", () => {
    expect(() => loadConfig(writeYaml(abYaml(
      compatLine, withFallback + "    experiment: { revert_if_no: jumps_completed, within_hours: 12 }\n",
    )))).toThrow();
    expect(() => loadConfig(writeYaml(abYaml(
      compatLine, withFallback + "    experiment: { revert_if_no: any, within_hours: 12, revert_to: ollama }\n",
    )))).toThrow();
  });

  // Breakage caught: an experiment whose exit has nowhere to revert TO --
  // tripping would strand the agent with "no planner available".
  test("experiment without a fallback_planner throws at load, naming the agent", () => {
    expect(() => loadConfig(writeYaml(abYaml(
      compatLine, "    experiment: { revert_if_no: any, within_hours: 12 }\n",
    )))).toThrow(/pilot.*fallback_planner/);
  });

  // Persisted-state tolerance (binding convention): this yaml is the exact
  // pre-#240 fixture shape (planner + fallback_planner with no base_url /
  // api_key_file / experiment). Breakage caught: the schema growth invalidating
  // every agents.yaml already deployed.
  test("a config that PREDATES #240 loads unchanged (no new fields required)", () => {
    const cfg = loadConfig(writeYaml(yamlWithGrowth));
    const miner = cfg.agents[0]!;
    expect(miner.planner).toEqual({ provider: "claude-subscription", model: "sonnet" });
    expect(miner.fallbackPlanner).toEqual({ provider: "ollama", model: "llama3.1:8b" });
    expect(miner.experiment).toBeUndefined();
  });
});

describe("ensureCredentials", () => {
  test("registers once, then reuses password file", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "secret-pw" },
    }));
    const secretsDir = mkdtempSync(join(tmpdir(), "smsec-"));
    writeFileSync(join(secretsDir, "registration_code"), "REG123\n");

    const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const entry = {
      id: "miner", username: "Test Miner", empire: "nebula" as const,
      persona: "p", goals: [], planner: { provider: "mock" as const },
      fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
      stallThreshold: 5, subscriptionCooldownMinutes: 60,
      maxPlansPerWindow: 12, planBudgetWindowMinutes: 60,
      fuelReservePct: 25, stuckWindowMinutes: 30, strandAutoSelfDestruct: false,
      progressHeartbeatMinutes: 30, repeatBlockThreshold: 3, repeatBlockWindowMinutes: 30,
      mode: "plan-then-execute" as const,
    };

    const pw1 = await ensureCredentials(client, entry, secretsDir);
    expect(pw1).toBe("secret-pw");
    expect(existsSync(join(secretsDir, "miner_password"))).toBe(true);
    expect(readFileSync(join(secretsDir, "miner_password"), "utf8").trim()).toBe("secret-pw");
    expect(server.calls.filter((c) => c.action === "register").length).toBe(1);

    const pw2 = await ensureCredentials(client, entry, secretsDir);
    expect(pw2).toBe("secret-pw");
    expect(server.calls.filter((c) => c.action === "register").length).toBe(1); // no second register
  });

  test("missing registration_code throws friendly error, does not register", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "secret-pw" },
    }));
    // Empty secretsDir: no password file AND no registration_code file. The
    // codeFile read hits ENOENT and must throw the friendly guidance error.
    const secretsDir = mkdtempSync(join(tmpdir(), "smsec-"));

    const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const entry = {
      id: "miner", username: "Test Miner", empire: "nebula" as const,
      persona: "p", goals: [], planner: { provider: "mock" as const },
      fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
      stallThreshold: 5, subscriptionCooldownMinutes: 60,
      maxPlansPerWindow: 12, planBudgetWindowMinutes: 60,
      fuelReservePct: 25, stuckWindowMinutes: 30, strandAutoSelfDestruct: false,
      progressHeartbeatMinutes: 30, repeatBlockThreshold: 3, repeatBlockWindowMinutes: 30,
      mode: "plan-then-execute" as const,
    };

    await expect(ensureCredentials(client, entry, secretsDir)).rejects.toThrow(/registration code/);
    await expect(ensureCredentials(client, entry, secretsDir)).rejects.toThrow("https://spacemolt.com/dashboard");
    expect(server.calls.filter((c) => c.action === "register").length).toBe(0);
  });

  test("non-ENOENT read error (EISDIR) propagates unmodified", async () => {
    server = startFakeServer();
    server.setHandler("spacemolt_auth", "register", () => ({
      structuredContent: { password: "secret-pw" },
    }));
    const secretsDir = mkdtempSync(join(tmpdir(), "smsec-"));
    // Make the password path a DIRECTORY so readFileSync(pwFile) throws EISDIR,
    // not ENOENT. That error must propagate as-is, never be swallowed into the
    // register path nor masked by the friendly "registration code" message.
    mkdirSync(join(secretsDir, "miner_password"));

    const http = new SpacemoltHttp(server.url, { sleep: async () => {} });
    const client = new SpacemoltClient(http);
    const entry = {
      id: "miner", username: "Test Miner", empire: "nebula" as const,
      persona: "p", goals: [], planner: { provider: "mock" as const },
      fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: ["combat"],
      stallThreshold: 5, subscriptionCooldownMinutes: 60,
      maxPlansPerWindow: 12, planBudgetWindowMinutes: 60,
      fuelReservePct: 25, stuckWindowMinutes: 30, strandAutoSelfDestruct: false,
      progressHeartbeatMinutes: 30, repeatBlockThreshold: 3, repeatBlockWindowMinutes: 30,
      mode: "plan-then-execute" as const,
    };

    let caught: NodeJS.ErrnoException | undefined;
    try {
      await ensureCredentials(client, entry, secretsDir);
    } catch (e) {
      caught = e as NodeJS.ErrnoException;
    }
    expect(caught).toBeDefined();
    expect(caught?.code).toBe("EISDIR");
    // The EISDIR error must NOT be replaced by the friendly missing-code text.
    expect(caught?.message ?? "").not.toContain("registration code");
    expect(server.calls.filter((c) => c.action === "register").length).toBe(0);
  });
});
