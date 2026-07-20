// spend-tally offline tests. No SSH, no network, no LLM, no fs writes to the
// real ledger — every parser/aggregator takes content strings and returns rows.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelFamily,
  estimateCostUsd,
  parseSessionTranscript,
  parseSchedulerRuns,
  parseLedger,
  upsertRows,
  serializeLedger,
  buildReport,
  buildSchedulerSshArgv,
  sessionTranscriptDirs,
  collectSessionRows,
  SpendRowSchema,
  type SpendRow,
} from "../scripts/spend-tally";

const SYNC_AT = "2026-07-18T12:00:00.000Z";

// --- pricing ----------------------------------------------------------------
describe("modelFamily", () => {
  test("maps full ids and short aliases to rate families", () => {
    expect(modelFamily("claude-opus-4-8")).toBe("opus");
    expect(modelFamily("opus")).toBe("opus");
    expect(modelFamily("claude-fable-5")).toBe("fable");
    expect(modelFamily("claude-sonnet-5")).toBe("sonnet");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(modelFamily("<synthetic>")).toBe("unknown");
    expect(modelFamily(undefined)).toBe("unknown");
  });
});

describe("estimateCostUsd", () => {
  test("prices input, output, and both cache-write TTL tiers at family rates", () => {
    // opus: $5/1M in, $25/1M out. cache write 5m 1.25x in, 1h 2x in, read 0.1x in.
    // 1M in + 1M out + 1M cacheWrite5m + 1M cacheWrite1h + 1M cacheRead
    // = 5 + 25 + 5*1.25 + 5*2 + 5*0.1 = 5 + 25 + 6.25 + 10 + 0.5 = 46.75
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreation5mTokens: 1_000_000, cacheCreation1hTokens: 1_000_000, cacheReadTokens: 1_000_000 },
      "opus",
    );
    expect(cost).toBeCloseTo(46.75, 5);
  });

  test("1h-TTL cache writes bill at 2x input, distinct from 5m at 1.25x", () => {
    // Same token count in each tier must price higher for 1h than 5m.
    const write1h = estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheCreation5mTokens: 0, cacheCreation1hTokens: 1_000_000, cacheReadTokens: 0 }, "opus");
    const write5m = estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheCreation5mTokens: 1_000_000, cacheCreation1hTokens: 0, cacheReadTokens: 0 }, "opus");
    expect(write1h).toBeCloseTo(10.0, 5); // 1M opus input * $5/1M * 2x
    expect(write5m).toBeCloseTo(6.25, 5); // 1M opus input * $5/1M * 1.25x
  });

  test("unknown family prices at $0 rather than guessing", () => {
    expect(estimateCostUsd({ inputTokens: 9e6, outputTokens: 9e6, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0 }, "unknown")).toBe(0);
  });
});

// --- source 1: session transcripts ------------------------------------------
describe("parseSessionTranscript", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const assistant = (opts: Record<string, unknown>) =>
    line({
      type: "assistant",
      timestamp: "2026-07-18T04:44:16.760Z",
      requestId: "req_A",
      message: { id: "msg_A", model: "claude-opus-4-8", usage: { input_tokens: 6, output_tokens: 261, cache_creation_input_tokens: 7013, cache_read_input_tokens: 52009 } },
      ...opts,
    });

  test("extracts one row per assistant usage block with cost + cacheTokens", () => {
    const rows = parseSessionTranscript(assistant({}), SYNC_AT);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.source).toBe("session");
    expect(r.date).toBe("2026-07-18");
    expect(r.id).toBe("msg_A:req_A");
    expect(r.model).toBe("opus");
    expect(r.inputTokens).toBe(6);
    expect(r.outputTokens).toBe(261);
    expect(r.cacheTokens).toBe(7013 + 52009);
    // Flat cache_creation_input_tokens (no TTL breakdown) → priced as 5m (1.25x).
    // (6*5 + 261*25 + 7013*5*1.25 + 52009*5*0.1) / 1e6 = 0.076391
    expect(r.costUsd).toBeCloseTo(0.076391, 6);
    expect(r.syncedAt).toBe(SYNC_AT);
  });

  test("prices the cache_creation TTL breakdown — 1h writes at 2x input (real transcript shape)", () => {
    // Structure copied from a real ~/.claude/projects/*.jsonl usage line
    // (content redacted, token counts illustrative). This project's live traffic
    // is exclusively 1h-TTL cache writes, verified against the transcripts.
    const content = line({
      type: "assistant",
      timestamp: "2026-07-18T05:00:00.000Z",
      requestId: "req_C",
      message: {
        id: "msg_C",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 4,
          output_tokens: 100,
          cache_creation_input_tokens: 80000, // flat mirror; the breakdown is authoritative
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 80000 },
          cache_read_input_tokens: 20000,
        },
      },
    });
    const rows = parseSessionTranscript(content, SYNC_AT);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    // opus $5/1M in, $25/1M out. 1h write @ 2x, read @ 0.1x — the 5m/flat 1.25x
    // path would UNDER-price the 80k 1h tokens ($500 vs $800 per 1M-scaled unit).
    const expected = (4 * 5 + 100 * 25 + 80000 * 5 * 2 + 20000 * 5 * 0.1) / 1_000_000;
    expect(r.costUsd).toBeCloseTo(expected, 6);
    expect(r.cacheTokens).toBe(80000 + 20000);
  });

  test("skips synthetic, usage-less, and non-assistant lines", () => {
    const content = [
      assistant({ message: { id: "m", model: "<synthetic>", usage: { input_tokens: 5, output_tokens: 5 } } }),
      line({ type: "assistant", timestamp: "2026-07-18T00:00:00Z", message: { id: "m2", model: "opus" } }), // no usage
      line({ type: "user", timestamp: "2026-07-18T00:00:00Z", message: { content: "hi" } }),
      assistant({}),
    ].join("\n");
    const rows = parseSessionTranscript(content, SYNC_AT);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("msg_A:req_A");
  });

  test("a malformed/corrupt line is skipped, not thrown", () => {
    const content = ["{ this is not json", assistant({})].join("\n");
    expect(() => parseSessionTranscript(content, SYNC_AT)).not.toThrow();
    expect(parseSessionTranscript(content, SYNC_AT).length).toBe(1);
  });
});

// --- session dir enumeration (worktree-agent transcript dirs) ----------------
// Worktree-isolated subagents write transcripts to sibling dirs named
// `<slug>--claude-worktrees-<name>`; scanning only the main slug dir missed
// ~52% of real spend ($99 captured vs $208 metered, 2026-07-19 calibration).
describe("collectSessionRows across worktree dirs", () => {
  const usageLine = (msgId: string, reqId: string) =>
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-18T04:44:16.760Z",
      requestId: reqId,
      message: { id: msgId, model: "claude-opus-4-8", usage: { input_tokens: 6, output_tokens: 261 } },
    });

  test("ingests main + worktree slug dirs, never unrelated projects", () => {
    const root = mkdtempSync(join(tmpdir(), "spend-tally-test-"));
    try {
      const mainDir = join(root, "E--projects-spacemolt");
      const worktreeDir = join(root, "E--projects-spacemolt--claude-worktrees-agent-abc123");
      const otherDir = join(root, "E--projects-other");
      for (const d of [mainDir, worktreeDir, otherDir]) mkdirSync(d);
      writeFileSync(join(mainDir, "s1.jsonl"), usageLine("msg_main", "req_main"));
      writeFileSync(join(worktreeDir, "s2.jsonl"), usageLine("msg_wt", "req_wt"));
      writeFileSync(join(otherDir, "s3.jsonl"), usageLine("msg_other", "req_other"));

      const dirs = sessionTranscriptDirs(root);
      expect(dirs.sort()).toEqual([mainDir, worktreeDir].sort());

      const ids = collectSessionRows(SYNC_AT, root).map((r) => r.id).sort();
      expect(ids).toEqual(["msg_main:req_main", "msg_wt:req_wt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recurses into nested subagent/workflow subdirs (0 top-level jsonl, #414)", () => {
    // Modern Claude Code sessions write NO top-level transcript — usage nests under
    // <session>/subagents/** and <session>/subagents/workflows/wf_*/**. A flat scan
    // missed a whole session (0 top-level, 61 nested). Assert both nested files ingest.
    const root = mkdtempSync(join(tmpdir(), "spend-tally-test-"));
    try {
      const sessionDir = join(root, "E--projects-spacemolt", "session-xyz");
      const subagentsDir = join(sessionDir, "subagents");
      const workflowDir = join(subagentsDir, "workflows", "wf_1");
      mkdirSync(workflowDir, { recursive: true });
      // NO *.jsonl at any top level of the eligible dir — only nested.
      writeFileSync(join(subagentsDir, "agent-x.jsonl"), usageLine("msg_x", "req_x"));
      writeFileSync(join(workflowDir, "agent-y.jsonl"), usageLine("msg_y", "req_y"));

      const ids = collectSessionRows(SYNC_AT, root).map((r) => r.id).sort();
      expect(ids).toEqual(["msg_x:req_x", "msg_y:req_y"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing projects root yields zero rows, not a crash", () => {
    expect(collectSessionRows(SYNC_AT, join(tmpdir(), "spend-tally-does-not-exist"))).toEqual([]);
  });
});

// --- source 2: scheduler runs -----------------------------------------------
describe("parseSchedulerRuns", () => {
  test("a pre-#410 row (no model field) still loads at $0 unknown-rate, never crashes", () => {
    // Persisted-state tolerance: this is the run-row shape appendRunLog wrote
    // BEFORE #410 added `model`. A stored row that predates the schema must still
    // parse — priced at the $0 "unknown" rate, never a throw — because runs-*.jsonl
    // outlives the schema that wrote it.
    const content = JSON.stringify({
      ts: Date.UTC(2026, 6, 18, 8, 0, 0),
      jobId: "strategy",
      cycleId: "strategy-1752825600000",
      result: "ok",
      exitCode: 0,
      timedOut: false,
      durationMs: 4200,
    });
    const rows = parseSchedulerRuns(content, SYNC_AT);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.source).toBe("scheduler");
    expect(r.date).toBe("2026-07-18");
    expect(r.id).toBe("strategy-1752825600000");
    expect(r.model).toBe("unknown");
    expect(r.inputTokens).toBe(0);
    expect(r.costUsd).toBe(0);
    expect(r.cacheTokens).toBeUndefined();
  });

  test("prices token/model fields when a future record carries them (tolerate extra fields)", () => {
    const content = JSON.stringify({
      ts: Date.UTC(2026, 6, 18, 9, 0, 0),
      cycleId: "soc-1",
      result: "ok",
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const rows = parseSchedulerRuns(content, SYNC_AT);
    expect(rows[0]!.model).toBe("opus");
    expect(rows[0]!.costUsd).toBeCloseTo(5.0, 5); // 1M opus input @ $5/1M
  });

  test("reads merged-#407 camelCase token fields and prices cache (no TTL split → 1.25x fallback)", () => {
    // EXACT field set src/scheduler/spawn.ts appendRunLog writes (camelCase
    // costUsd/inputTokens/outputTokens/cacheReadInputTokens/cacheCreationInputTokens,
    // flat cache counts, no TTL breakdown) plus `model` (added #410). costUsd:null
    // models a subscription run with no total_cost_usd, so pricing falls to the estimate
    // path and the model resolves a non-unknown rate. A full model id ("claude-opus-4-8")
    // is used here to exercise modelFamily's id→family collapse and the cache math.
    const content = JSON.stringify({
      ts: Date.UTC(2026, 6, 18, 10, 0, 0),
      jobId: "strategy",
      cycleId: "strategy-camel-1",
      result: "ok",
      exitCode: 0,
      timedOut: false,
      durationMs: 5000,
      costUsd: null,
      model: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200000,
      cacheCreationInputTokens: 100000,
    });
    const r = parseSchedulerRuns(content, SYNC_AT)[0]!;
    expect(r.model).toBe("opus");
    expect(r.cacheTokens).toBe(100000 + 200000); // camelCase cache tokens read, not dropped to 0
    // opus $5/1M in, $25/1M out. flat cache-creation → 5m 1.25x; read 0.1x.
    // (1000*5 + 500*25 + 100000*5*1.25 + 200000*5*0.1) / 1e6 = 0.7425
    // If the camelCase cache fields were dropped, cost would be only 0.0175.
    expect(r.costUsd).toBeCloseTo(0.7425, 6);
  });

  test("an explicit costUsd wins over token estimation", () => {
    const content = JSON.stringify({ date: "2026-07-18", cycleId: "c9", costUsd: 1.23 });
    expect(parseSchedulerRuns(content, SYNC_AT)[0]!.costUsd).toBe(1.23);
  });

  test("a record missing both a date and an id is skipped, not thrown", () => {
    const content = [JSON.stringify({ result: "ok" }), JSON.stringify({ ts: 123, cycleId: "ok-1" })].join("\n");
    expect(() => parseSchedulerRuns(content, SYNC_AT)).not.toThrow();
    expect(parseSchedulerRuns(content, SYNC_AT).length).toBe(1);
  });
});

// --- ledger load / upsert ---------------------------------------------------
describe("ledger upsert idempotency", () => {
  const row = (over: Partial<SpendRow> = {}): SpendRow => ({
    date: "2026-07-18",
    source: "session",
    id: "msg_A:req_A",
    model: "opus",
    inputTokens: 6,
    outputTokens: 261,
    cacheTokens: 59022,
    costUsd: 0.007,
    syncedAt: SYNC_AT,
    ...over,
  });

  test("re-syncing the same rows never duplicates (keyed on source+id)", () => {
    const first = upsertRows([], [row(), row({ id: "msg_B:req_B" })]);
    expect(first.length).toBe(2);
    const second = upsertRows(first, [row(), row({ id: "msg_B:req_B" })]);
    expect(second.length).toBe(2);
  });

  test("an incoming row replaces the stored one (refreshed cost / syncedAt)", () => {
    const start = upsertRows([], [row({ costUsd: 0.001 })]);
    const merged = upsertRows(start, [row({ costUsd: 0.009, syncedAt: "2026-07-19T00:00:00Z" })]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.costUsd).toBe(0.009);
    expect(merged[0]!.syncedAt).toBe("2026-07-19T00:00:00Z");
  });

  test("same id under a different source is a distinct row", () => {
    const merged = upsertRows([], [row({ id: "x" }), row({ id: "x", source: "scheduler" })]);
    expect(merged.length).toBe(2);
  });

  test("round-trips through serialize/parse", () => {
    const rows = upsertRows([], [row(), row({ id: "y", source: "scheduler" })]);
    const reloaded = parseLedger(serializeLedger(rows));
    expect(reloaded.length).toBe(2);
  });

  test("a stored row that predates/violates the schema is dropped, not fatal", () => {
    const content = [
      JSON.stringify({ date: "bad-date", source: "session", id: "x", model: "opus", inputTokens: 1, outputTokens: 1, costUsd: 0, syncedAt: SYNC_AT }),
      JSON.stringify({ source: "unknown-src", id: "y" }), // missing fields + bad enum
      serializeLedger(upsertRows([], [row()])).trim(),
    ].join("\n");
    const rows = parseLedger(content);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("msg_A:req_A");
  });
});

// --- reporting math ---------------------------------------------------------
describe("buildReport", () => {
  const NOW = new Date("2026-07-18T18:00:00Z");
  const mk = (date: string, source: SpendRow["source"], model: string, cost: number): SpendRow => ({
    date,
    source,
    id: `${date}-${model}-${cost}`,
    model,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: cost,
    syncedAt: SYNC_AT,
  });

  const rows: SpendRow[] = [
    mk("2026-07-18", "session", "opus", 1.0), // today
    mk("2026-07-18", "scheduler", "unknown", 0), // today, $0
    mk("2026-07-15", "session", "sonnet", 0.5), // within 7d
    mk("2026-07-01", "session", "opus", 2.0), // outside 7d, in total
  ];

  test("today / last7 / total buckets partition by UTC date", () => {
    const rep = buildReport(rows, NOW);
    expect(rep.today.rows).toBe(2);
    expect(rep.today.costUsd).toBeCloseTo(1.0, 6);
    expect(rep.last7.rows).toBe(3);
    expect(rep.last7.costUsd).toBeCloseTo(1.5, 6);
    expect(rep.total.rows).toBe(4);
    expect(rep.total.costUsd).toBeCloseTo(3.5, 6);
  });

  test("breaks down by source and by model", () => {
    const rep = buildReport(rows, NOW);
    expect(rep.today.bySource.session!.costUsd).toBeCloseTo(1.0, 6);
    expect(rep.today.bySource.scheduler!.rows).toBe(1);
    expect(rep.total.byModel.opus!.costUsd).toBeCloseTo(3.0, 6);
    expect(rep.total.byModel.sonnet!.costUsd).toBeCloseTo(0.5, 6);
  });

  test("the 7-day window is inclusive of the boundary day", () => {
    // 6 days before 2026-07-18 is 2026-07-12 — a row on that day is in-window.
    const rep = buildReport([mk("2026-07-12", "session", "opus", 9)], NOW);
    expect(rep.last7.rows).toBe(1);
    const before = buildReport([mk("2026-07-11", "session", "opus", 9)], NOW);
    expect(before.last7.rows).toBe(0);
  });
});

// --- SSH arg shape (offline; never spawns) ----------------------------------
describe("buildSchedulerSshArgv", () => {
  test("passes the key/host/remote-command as separate argv tokens, no shell string", () => {
    const argv = buildSchedulerSshArgv("C:/Windows/System32/OpenSSH/ssh.exe", "secrets/scheduler_key", "scheduler-svc@192.0.2.10");
    expect(argv[0]).toContain("ssh");
    expect(argv).toContain("IdentityAgent=none");
    expect(argv).toContain("IdentitiesOnly=yes");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("secrets/scheduler_key");
    // host then the fixed remote command are the last two tokens.
    expect(argv.slice(-2)).toEqual(["scheduler-svc@192.0.2.10", "cat ~/state/logs/runs-*.jsonl"]);
  });

  test("the remote command is a fixed constant (no interpolated caller input)", () => {
    const argv = buildSchedulerSshArgv("ssh", "/k", "h");
    const remote = argv[argv.length - 1];
    expect(remote).toBe("cat ~/state/logs/runs-*.jsonl");
  });
});

// --- schema sanity ----------------------------------------------------------
test("SpendRowSchema rejects a row with a missing required field", () => {
  expect(SpendRowSchema.safeParse({ date: "2026-07-18", source: "session", id: "x" }).success).toBe(false);
});
