// spend-tally — a local SSOT for LLM spend over time, across both sources that
// burn our Claude quota:
//   1. "session"   — workstation Claude Code sessions (PM loop + subagents),
//                    parsed from the per-message usage in session transcripts.
//   2. "scheduler" — the durable scheduler's headless `claude -p` jobs on the
//                    scheduler host, parsed from its ~/state/logs/runs-*.jsonl records.
//
// Two subcommands:
//   sync   — pull both sources, upsert into spend-ledger.jsonl (idempotent).
//   report — print today / last 7 days / total, by source and model. OFFLINE:
//            reads only the ledger file, no network, no LLM calls.
//
// The ledger (spend-ledger.jsonl, repo root, GITIGNORED) is append-only in
// spirit — one row per spend unit — but sync rewrites it atomically after an
// upsert keyed on (source, id) so re-running never duplicates a row.
//
// The dollar figures are ESTIMATES. Claude Code / the scheduler run on a flat
// subscription, not metered API billing, and the transcripts carry no price. So
// we price the token counts ourselves at published API rates (below) to get an
// API-equivalent value — a proxy for "how much quota did this burn", not a bill.
// See docs/wiki/spend-tracking.md.
//
// Security posture: the single network op is an SSH fetch built with Bun.spawn's
// argv array (no shell, no string-concat) with a fixed remote command. The key
// path and host come from the environment / repo secrets and are NEVER written
// into ledger rows.
import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

// --- pricing ----------------------------------------------------------------
// Per-million-token USD rates by model family. Source: the `claude-api` skill,
// "Current Models" table (cached 2026-06-24): input / output $/1M. Cache math
// per the skill's prompt-caching doc — cache WRITES bill at 1.25x input for the
// 5-minute TTL and 2x input for the 1-hour TTL; cache READS at 0.1x input.
// Sonnet uses the $3/$15 sticker (the $2/$10 intro is time-boxed; these are
// estimates regardless). One const, not scattered.
const UNKNOWN_RATE = { in: 0, out: 0 };
const RATES: Record<string, { in: number; out: number }> = {
  fable: { in: 10, out: 50 },
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
  unknown: UNKNOWN_RATE,
};
const CACHE_WRITE_5M_MULT = 1.25; // 5-minute-TTL cache write
const CACHE_WRITE_1H_MULT = 2; // 1-hour-TTL cache write (2x input)
const CACHE_READ_MULT = 0.1;

/**
 * Collapse a raw model id/alias to a rate family. Claude Code transcripts carry
 * both full ids ("claude-opus-4-8") and short aliases ("opus") for the same
 * model; families capture the billing tier exactly, which is the grain the
 * operator cares about. "<synthetic>" and anything unrecognized → "unknown"
 * (priced at $0 rather than guessed).
 */
export function modelFamily(raw: string | undefined | null): string {
  const m = (raw ?? "").toLowerCase();
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "unknown";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  // Cache creation is split by TTL tier because the two tiers bill differently
  // (5m at 1.25x input, 1h at 2x). Real Claude transcripts carry the split under
  // usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens.
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
}

/**
 * Split cache-creation tokens into 5-minute and 1-hour TTL tiers. Real Claude
 * transcripts carry usage.cache_creation.{ephemeral_5m_input_tokens,
 * ephemeral_1h_input_tokens}; this project's live traffic is exclusively 1h,
 * which bills at 2x input (5m bills at 1.25x). When the breakdown is absent,
 * fall back to the flat cache_creation_input_tokens priced as 5m (1.25x) —
 * ASSUMED per fix-quality.md: a flat count carries no TTL signal, and 5m is the
 * cheaper, more conservative tier to attribute it to.
 */
function splitCacheCreation(breakdown: any, flat: number): { cache5m: number; cache1h: number } {
  const has5m = breakdown != null && typeof breakdown.ephemeral_5m_input_tokens === "number";
  const has1h = breakdown != null && typeof breakdown.ephemeral_1h_input_tokens === "number";
  if (has5m || has1h) {
    return {
      cache5m: Number(breakdown.ephemeral_5m_input_tokens) || 0,
      cache1h: Number(breakdown.ephemeral_1h_input_tokens) || 0,
    };
  }
  return { cache5m: flat, cache1h: 0 };
}

/** Estimated API-equivalent USD for one usage block at the family's rates. */
export function estimateCostUsd(usage: Usage, family: string): number {
  const r = RATES[family] ?? UNKNOWN_RATE;
  const usd =
    (usage.inputTokens * r.in +
      usage.cacheCreation5mTokens * r.in * CACHE_WRITE_5M_MULT +
      usage.cacheCreation1hTokens * r.in * CACHE_WRITE_1H_MULT +
      usage.cacheReadTokens * r.in * CACHE_READ_MULT +
      usage.outputTokens * r.out) /
    1_000_000;
  // Round to 6 dp to keep float noise out of the ledger; report rounds further.
  return Math.round(usd * 1e6) / 1e6;
}

// --- ledger row schema ------------------------------------------------------
export const SpendRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // UTC calendar day (YYYY-MM-DD)
  source: z.enum(["session", "scheduler"]),
  id: z.string().min(1), // dedup key within a source
  model: z.string(), // rate family: fable|opus|sonnet|haiku|unknown
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  syncedAt: z.string(), // ISO 8601 of the sync that last wrote this row
});
export type SpendRow = z.infer<typeof SpendRowSchema>;

const dayOf = (iso: string): string => iso.slice(0, 10);
// Diff-safe (source, id) map key (#436). A NUL separator here rendered the WHOLE
// file as "Binary files differ" in git/GitHub diffs, blinding review tooling to
// every line. U+241F (SYMBOL FOR UNIT SEPARATOR) is written as an escape so the
// source stays pure ASCII and the file stays text, while remaining collision-
// proof: `source` is a fixed enum (session|scheduler) that can never contain it.
// In-memory only — the ledger persists source/id as separate JSON fields, so
// there is no stored key to migrate.
const rowKey = (source: string, id: string): string => `${source}\u241F${id}`;

// --- source 1: Claude Code session transcripts ------------------------------
/**
 * Parse one transcript file's JSONL content into session spend rows. One row
 * per assistant message that carries a real usage block. Malformed lines and
 * synthetic/usage-less messages are skipped, never thrown (persisted state
 * outlives the schema that wrote it — tolerate, don't crash).
 *
 * The row id is `${message.id}:${requestId}` so the same message appearing in a
 * resumed/forked transcript collapses under the (source, id) upsert.
 */
export function parseSessionTranscript(content: string, syncedAt: string): SpendRow[] {
  const rows: SpendRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // partial/corrupt line — skip
    }
    if (obj?.type !== "assistant") continue;
    const msg = obj.message;
    const usage = msg?.usage;
    const rawModel = msg?.model;
    if (!usage || !rawModel || rawModel === "<synthetic>") continue;
    const { cache5m, cache1h } = splitCacheCreation(usage.cache_creation, Number(usage.cache_creation_input_tokens) || 0);
    const u: Usage = {
      inputTokens: Number(usage.input_tokens) || 0,
      outputTokens: Number(usage.output_tokens) || 0,
      cacheCreation5mTokens: cache5m,
      cacheCreation1hTokens: cache1h,
      cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
    };
    if (u.inputTokens + u.outputTokens + u.cacheCreation5mTokens + u.cacheCreation1hTokens + u.cacheReadTokens === 0) continue;
    const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    if (!ts || !/^\d{4}-\d{2}-\d{2}/.test(ts)) continue;
    const msgId = typeof msg.id === "string" ? msg.id : "";
    const reqId = typeof obj.requestId === "string" ? obj.requestId : "";
    const id = `${msgId}:${reqId}`;
    if (id === ":") continue; // no stable identity → can't dedup, skip
    const family = modelFamily(rawModel);
    rows.push({
      date: dayOf(ts),
      source: "session",
      id,
      model: family,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheTokens: u.cacheCreation5mTokens + u.cacheCreation1hTokens + u.cacheReadTokens,
      costUsd: estimateCostUsd(u, family),
      syncedAt,
    });
  }
  return rows;
}

// --- source 2: scheduler runs-*.jsonl ---------------------------------------
/**
 * Parse concatenated ~/state/logs/runs-*.jsonl content into scheduler spend rows.
 *
 * Run records (src/scheduler/spawn.ts appendRunLog) carry execution metadata plus
 * spend: {ts, jobId, cycleId, model, result, exitCode, timedOut, durationMs, costUsd,
 * inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, error?}.
 * `model` (added #410) is the tier the scheduler spawned with, so a subscription-path
 * row with no total_cost_usd still prices from tokens at the right rate instead of $0.
 * Per persisted-state tolerance every field is optional here: a pre-#410 row without
 * `model` prices at the $0 unknown rate, and any field absent → 0/unknown, never a
 * throw. Never depend on a field being there.
 */
export function parseSchedulerRuns(content: string, syncedAt: string): SpendRow[] {
  const rows: SpendRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // date: prefer an explicit YYYY-MM-DD, else derive from a ms/ISO ts.
    let date: string | undefined;
    if (typeof obj.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.date)) {
      date = obj.date;
    } else if (typeof obj.ts === "number" && Number.isFinite(obj.ts)) {
      date = new Date(obj.ts).toISOString().slice(0, 10);
    } else if (typeof obj.ts === "string" && /^\d{4}-\d{2}-\d{2}/.test(obj.ts)) {
      date = obj.ts.slice(0, 10);
    }
    const id = typeof obj.cycleId === "string" ? obj.cycleId : typeof obj.id === "string" ? obj.id : undefined;
    if (!date || !id) continue; // no day or no stable identity → can't record/dedup
    const inputTokens = Number(obj.inputTokens ?? obj.input_tokens ?? obj.usage?.input_tokens) || 0;
    const outputTokens = Number(obj.outputTokens ?? obj.output_tokens ?? obj.usage?.output_tokens) || 0;
    // #407's appendRunLog writes flat token counts camelCase (cacheCreationInputTokens,
    // cacheReadInputTokens) with NO TTL breakdown — read those first, then snake_case,
    // then a nested usage block, matching how input/output are already resolved above.
    // A flat cache-creation count has no TTL signal, so it takes the 1.25x (5m) fallback
    // in splitCacheCreation (assumed per fix-quality.md).
    const flatCacheCreation =
      Number(obj.cacheCreationInputTokens ?? obj.cache_creation_input_tokens ?? obj.usage?.cache_creation_input_tokens) || 0;
    const { cache5m, cache1h } = splitCacheCreation(obj.cache_creation ?? obj.usage?.cache_creation, flatCacheCreation);
    const cacheRead =
      Number(obj.cacheReadInputTokens ?? obj.cache_read_input_tokens ?? obj.usage?.cache_read_input_tokens) || 0;
    const rawModel = obj.model ?? obj.usage?.model;
    const family = rawModel ? modelFamily(rawModel) : "unknown";
    const explicitCost = Number(obj.costUsd ?? obj.cost);
    const costUsd = Number.isFinite(explicitCost)
      ? Math.round(explicitCost * 1e6) / 1e6
      : estimateCostUsd({ inputTokens, outputTokens, cacheCreation5mTokens: cache5m, cacheCreation1hTokens: cache1h, cacheReadTokens: cacheRead }, family);
    const cacheTotal = cache5m + cache1h + cacheRead;
    rows.push({
      date,
      source: "scheduler",
      id,
      model: family,
      inputTokens,
      outputTokens,
      ...(cacheTotal > 0 ? { cacheTokens: cacheTotal } : {}),
      costUsd,
      syncedAt,
    });
  }
  return rows;
}

// --- ledger load / upsert / write -------------------------------------------
/** Load and validate the ledger; malformed rows are dropped, not fatal. */
export function parseLedger(content: string): SpendRow[] {
  const rows: SpendRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = SpendRowSchema.safeParse(obj);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/**
 * Merge incoming rows over existing, keyed on (source, id). An incoming row
 * replaces the stored one (refreshes syncedAt / re-priced cost); ids only in
 * existing are kept. Deterministically sorted by (date, source, id) so the file
 * diff is stable across runs.
 */
export function upsertRows(existing: SpendRow[], incoming: SpendRow[]): SpendRow[] {
  const map = new Map<string, SpendRow>();
  for (const r of existing) map.set(rowKey(r.source, r.id), r);
  for (const r of incoming) map.set(rowKey(r.source, r.id), r);
  return [...map.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
  );
}

export function serializeLedger(rows: SpendRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

function loadLedgerFile(path: string): SpendRow[] {
  if (!existsSync(path)) return [];
  return parseLedger(readFileSync(path, "utf8"));
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written ledger. */
function writeLedgerFile(path: string, rows: SpendRow[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeLedger(rows));
  renameSync(tmp, path);
}

// --- reporting --------------------------------------------------------------
interface Bucket {
  rows: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  bySource: Record<string, { rows: number; costUsd: number }>;
  byModel: Record<string, { rows: number; costUsd: number }>;
}

function emptyBucket(): Bucket {
  return { rows: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, bySource: {}, byModel: {} };
}

function accumulate(bucket: Bucket, r: SpendRow): void {
  bucket.rows += 1;
  bucket.costUsd += r.costUsd;
  bucket.inputTokens += r.inputTokens;
  bucket.outputTokens += r.outputTokens;
  const src = (bucket.bySource[r.source] ??= { rows: 0, costUsd: 0 });
  src.rows += 1;
  src.costUsd += r.costUsd;
  const mdl = (bucket.byModel[r.model] ??= { rows: 0, costUsd: 0 });
  mdl.rows += 1;
  mdl.costUsd += r.costUsd;
}

export interface Report {
  today: Bucket;
  last7: Bucket;
  total: Bucket;
}

/** Aggregate the ledger into today / last-7-days / all-time buckets (UTC). */
export function buildReport(rows: SpendRow[], now: Date = new Date()): Report {
  const todayStr = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rep: Report = { today: emptyBucket(), last7: emptyBucket(), total: emptyBucket() };
  for (const r of rows) {
    accumulate(rep.total, r);
    if (r.date >= weekAgo) accumulate(rep.last7, r);
    if (r.date === todayStr) accumulate(rep.today, r);
  }
  return rep;
}

const usd = (n: number): string => `$${n.toFixed(4)}`;

function formatBucket(label: string, b: Bucket): string {
  const lines = [`${label}: ${usd(b.costUsd)} est  (${b.rows} rows, ${b.inputTokens.toLocaleString()} in / ${b.outputTokens.toLocaleString()} out tokens)`];
  for (const [s, agg] of Object.entries(b.bySource).sort((a, z) => a[0].localeCompare(z[0]))) {
    lines.push(`    source ${s.padEnd(9)} ${usd(agg.costUsd).padStart(12)}  (${agg.rows} rows)`);
  }
  for (const [m, agg] of Object.entries(b.byModel).sort((a, z) => a[0].localeCompare(z[0]))) {
    lines.push(`    model  ${m.padEnd(9)} ${usd(agg.costUsd).padStart(12)}  (${agg.rows} rows)`);
  }
  return lines.join("\n");
}

export function formatReport(rep: Report): string {
  return [
    "LLM spend (estimated API-equivalent value, not a bill)",
    "",
    formatBucket("Today    ", rep.today),
    "",
    formatBucket("Last 7d  ", rep.last7),
    "",
    formatBucket("All-time ", rep.total),
  ].join("\n");
}

// --- SSH fetch of scheduler runs --------------------------------------------
const REPO_ROOT = join(import.meta.dir, "..");
const LEDGER_PATH = process.env.SM_SPEND_LEDGER ?? join(REPO_ROOT, "spend-ledger.jsonl");
// Worktree-isolated subagents write transcripts to SIBLING dirs named
// `<slug>--claude-worktrees-<name>`, not the main slug dir — enumerating only
// the main dir missed ~52% of real spend ($99 captured vs $208 metered,
// 2026-07-19 calibration). So the session source scans the whole projects root
// and takes every dir that IS the slug or carries the exact worktree prefix.
const PROJECT_SLUG = "E--projects-spacemolt";
const PROJECTS_ROOT = process.env.SM_PROJECTS_ROOT ?? join(homedir(), ".claude", "projects");

function sshBin(): string {
  if (process.env.SM_SSH_BIN) return process.env.SM_SSH_BIN;
  return process.platform === "win32" ? "C:/Windows/System32/OpenSSH/ssh.exe" : "ssh";
}
function schedulerKeyPath(): string {
  return process.env.SCHEDULER_KEY ?? join(REPO_ROOT, "secrets", "scheduler_key");
}
function schedulerHost(): string {
  // Placeholder default (RFC 5737 documentation IP); the real user@host is
  // deploy config, supplied via SCHEDULER_HOST on the workstation that runs this.
  return process.env.SCHEDULER_HOST ?? "scheduler-svc@192.0.2.10";
}

/**
 * Build the SSH argv that dumps the scheduler host's run logs. The remote command is a
 * FIXED constant (no caller input concatenated); ssh joins argv into
 * SSH_ORIGINAL_COMMAND and the remote login shell expands `~` and the glob.
 * Exported for an offline arg-shape test — never spawns there.
 */
export function buildSchedulerSshArgv(bin: string, keyPath: string, host: string): string[] {
  return [
    bin,
    "-o", "IdentityAgent=none",
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-i", keyPath,
    host,
    // Path confirmed against src/scheduler/spawn.ts (appendRunLog writes
    // join(stateDir, "logs", "runs-<day>.jsonl")) and a live probe of the
    // scheduler host: the run logs live under ~/state/logs/, not ~/state/ directly.
    "cat ~/state/logs/runs-*.jsonl",
  ];
}

async function fetchSchedulerRuns(): Promise<{ ok: true; content: string } | { ok: false; err: string }> {
  const keyPath = schedulerKeyPath();
  if (!existsSync(keyPath)) return { ok: false, err: `scheduler key not found (${keyPath})` };
  const argv = buildSchedulerSshArgv(sshBin(), keyPath, schedulerHost());
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [code, out, errText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // `cat` on a non-matching glob exits nonzero with empty output — treat an
    // empty-but-reachable dump as ok (no runs yet), a real SSH failure as not-ok.
    if (code !== 0 && out.trim() === "" && /no such file|not found|Permission denied|Connection|timed out|resolve/i.test(errText)) {
      return { ok: false, err: errText.trim() || `ssh exited ${code}` };
    }
    return { ok: true, content: out };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

// --- subcommands ------------------------------------------------------------
/**
 * Every transcript dir belonging to THIS project: the main slug dir plus the
 * worktree-agent sibling dirs (`<slug>--claude-worktrees-<name>`). Exact prefix
 * match on the slug const so unrelated projects never leak in (a plain
 * `startsWith(slug)` would also grab e.g. `E--projects-spacemolt-fork`).
 * Exported for the fixture-tree test.
 */
export function sessionTranscriptDirs(projectsRoot: string, slug: string = PROJECT_SLUG): string[] {
  if (!existsSync(projectsRoot)) return [];
  const worktreePrefix = `${slug}--claude-worktrees-`;
  return readdirSync(projectsRoot)
    .filter((name) => name === slug || name.startsWith(worktreePrefix))
    .map((name) => join(projectsRoot, name));
}

/**
 * Every `*.jsonl` at ANY depth under `dir`. Modern Claude Code sessions write no
 * top-level transcript — everything nests under a `subagents` dir and a
 * `subagents/workflows/wf_<id>` dir — so a flat `readdirSync` missed a full
 * session's spend (0 top-level, 61 nested, #414). An unreadable subdir is skipped
 * LOUDLY, keeping the rest of the walk alive. Non-usage jsonl (tool results) is
 * harmless: parseSessionTranscript drops zero-token rows, upsert dedups on id.
 */
function collectJsonlFiles(dir: string): string[] {
  const readDirents = () => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // unreadable dir — skip LOUDLY, keep syncing the rest
      console.warn(`sessions: skipping unreadable dir ${dir} — ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };
  const files: string[] = [];
  for (const entry of readDirents()) {
    const full = join(dir, entry.name);
    // Dirent from withFileTypes is lstat-based: a symlinked dir reports
    // isSymbolicLink()=true and isDirectory()=false, so symlinks are never
    // followed and no cycle is possible. Real transcript trees are ~4 deep.
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

export function collectSessionRows(syncedAt: string, projectsRoot: string = PROJECTS_ROOT): SpendRow[] {
  const rows: SpendRow[] = [];
  for (const dir of sessionTranscriptDirs(projectsRoot)) {
    for (const file of collectJsonlFiles(dir)) {
      try {
        rows.push(...parseSessionTranscript(readFileSync(file, "utf8"), syncedAt));
      } catch {
        // unreadable transcript — skip, keep syncing the rest
      }
    }
  }
  return rows;
}

async function runSync(): Promise<number> {
  const syncedAt = new Date().toISOString();
  const existing = loadLedgerFile(LEDGER_PATH);

  const sessionRows = collectSessionRows(syncedAt);
  console.log(`sessions: ${sessionRows.length} usage rows from ${sessionTranscriptDirs(PROJECTS_ROOT).length} dir(s) under ${PROJECTS_ROOT}`);

  let schedulerRows: SpendRow[] = [];
  const fetched = await fetchSchedulerRuns();
  if (fetched.ok) {
    schedulerRows = parseSchedulerRuns(fetched.content, syncedAt);
    console.log(`scheduler: ${schedulerRows.length} run rows from ${schedulerHost()}`);
  } else {
    // DEGRADE GRACEFULLY: loud log, still persist the session rows.
    console.warn(`scheduler: UNREACHABLE — ${fetched.err}. Syncing sessions only; scheduler rows preserved from prior sync.`);
  }

  const merged = upsertRows(existing, [...sessionRows, ...schedulerRows]);
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeLedgerFile(LEDGER_PATH, merged);
  console.log(`ledger: ${merged.length} total rows -> ${LEDGER_PATH}`);
  return 0;
}

function runReport(): number {
  const rows = loadLedgerFile(LEDGER_PATH);
  console.log(formatReport(buildReport(rows)));
  return 0;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const run = cmd === "sync" ? runSync() : cmd === "report" ? Promise.resolve(runReport()) : undefined;
  if (run === undefined) {
    console.error("usage: bun scripts/spend-tally.ts <sync|report>");
    process.exit(2);
  }
  run.then((code) => process.exit(code)).catch((e) => {
    console.error(`spend-tally: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
