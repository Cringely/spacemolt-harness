/**
 * Refreshes docs/game-reference/ — the vendored SSOT for the game's own docs.
 *
 *   bun run scripts/refresh-game-reference.ts          # OFFLINE: rebuild commands.md from the vendored spec
 *   bun run scripts/refresh-game-reference.ts --live   # NETWORK: re-capture upstream/, then rebuild commands.md
 *
 * SAFE BY DEFAULT (#424): a bare run does the OFFLINE index rebuild only — zero
 * network, zero writes to upstream/. Re-capturing the vendored docs makes live
 * HTTP calls and overwrites the SSOT reference, so it is gated behind an explicit
 * `--live` (alias `--fetch`). The old default was inverted: a no-flag run fired
 * live traffic and clobbered upstream/, tripping the binding 'no live calls
 * without authorization' rule on every commands.md regeneration.
 *
 * Two jobs:
 *   1. Capture upstream VERBATIM into docs/game-reference/upstream/ (byte-for-byte,
 *      so a refresh diff shows only what the game changed, never our edits). --live only.
 *   2. Generate docs/game-reference/commands.md — the one-line index of every
 *      action, with a registered/unregistered column read from src/registry/actions.ts.
 *
 * The network path is read-only HTTP GETs against public documentation endpoints.
 * No session, no auth, no game action. The spec endpoints are rate-limited to 1
 * request/min per IP, so they are fetched last, sequentially, with backoff.
 */
import { mkdir, writeFile } from "node:fs/promises";
// Extensionless: the drift gate imports this module, which pulls it into tsconfig's program
// (include: src, test), and `allowImportingTsExtensions` is off there.
import { REGISTRY } from "../src/registry/actions";

const SITE = "https://www.spacemolt.com";
const OUT = "docs/game-reference";
const UP = `${OUT}/upstream`;

/** Paths the drift gate (test/game-reference-drift.test.ts) needs, repo-root-relative. */
export const SPEC_PATH = `${UP}/openapi-v2.json`;
export const COMMANDS_PATH = `${OUT}/commands.md`;

// Pages published as raw markdown (the game serves .md alongside the HTML).
const PAGES = ["skill.md", "api.md", "sitemap.md", "glossary.md"];
const DOCS = [
  "connections", "accounts", "social", "progression", "empires", "travel",
  "exploration", "police", "wildlife", "mining", "crafting", "markets",
  "trading", "storage", "economy", "passengers", "combat", "death", "wrecks",
  "scanning", "ships", "shipyard", "drones", "skills", "factions", "stations",
  "espionage", "hospitality", "missions",
];
const GUIDES = [
  "miner", "trader", "arbitrage", "mission-runner", "passenger-lines",
  "pirate-hunter", "explorer", "base-builder", "crafting", "drones", "fuel",
  "client-dev",
];
// Rate-limited (1/min/IP, own bucket) — fetched last, one at a time.
const SPECS: Array<[string, string]> = [
  ["/api/v2/openapi.json", "openapi-v2.json"],
  ["/api/openapi.json", "openapi-v1.json"],
];

/** Which upstream mechanics pages explain a given tool. Hand-maintained: the game
 *  publishes no machine-readable tool -> doc mapping, so this is our routing table. */
const TOOL_DOCS: Record<string, string[]> = {
  spacemolt: ["travel", "mining", "markets", "combat", "missions", "crafting", "passengers", "exploration"],
  spacemolt_auth: ["accounts", "connections"],
  spacemolt_market: ["markets", "economy"],
  spacemolt_ship: ["ships", "shipyard"],
  spacemolt_catalog: ["ships", "crafting", "skills"],
  spacemolt_fleet: ["travel", "combat"],
  spacemolt_faction: ["factions"],
  spacemolt_faction_admin: ["factions"],
  spacemolt_faction_commerce: ["factions", "markets"],
  spacemolt_battle: ["combat", "death"],
  spacemolt_social: ["social"],
  spacemolt_intel: ["espionage", "scanning"],
  spacemolt_salvage: ["wrecks", "death"],
  spacemolt_storage: ["storage"],
  spacemolt_transfer: ["trading"],
  spacemolt_drone: ["drones"],
  spacemolt_facility: ["stations", "crafting", "hospitality"],
  spacemolt_citizenship: ["empires"],
};

async function get(url: string, retries = 0): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return await res.text();
    if (attempt >= retries) throw new Error(`GET ${url} -> ${res.status}`);
    // 429 on the spec bucket: the limit is per minute, so wait it out.
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

/** A line beginning `> **Correction` is our own dated live-falsification note. Corrections
 *  belong in docs/game-reference/corrections.md — a sidecar this script never captures — precisely
 *  because a verbatim re-capture would silently wipe one written into an upstream file. If a note
 *  is still sitting inline in a captured file, refuse to overwrite it until it is migrated, so the
 *  refresh can never erase the evidence-precedence write-back (AGENTS.md, issue #326). */
export const CORRECTION_MARKER = /^> \*\*Correction/m;

export async function assertNoUnmigratedCorrection(dest: string): Promise<void> {
  // Bun.file(...).text() throws ENOENT on a not-yet-captured file; that path has no note to lose.
  const existing = await Bun.file(dest).text().catch(() => "");
  if (CORRECTION_MARKER.test(existing)) {
    throw new Error(
      `refuse to overwrite ${dest}: it carries an inline correction note. Migrate it to ` +
        `docs/game-reference/corrections.md (the refresh never touches that file), then re-run. See issue #326.`,
    );
  }
}

/**
 * The effectful seam: the network read + the disk writes/mkdirs, injectable so a
 * test can assert the safe (bare) mode fires NEITHER a network call NOR an
 * upstream write, without touching the real filesystem or network. Defaults to
 * the real implementations; `import.meta.main` and every doc build use realIO.
 *
 * Smaller alternative tried and rejected (complexity-needs-a-receipt): mock
 * globalThis.fetch + spy on node:fs/promises instead of adding this interface.
 * Bun's mock.module must run before the target's import graph resolves, which is
 * fragile here because two other suites (drift, corrections) import this module in
 * the same test run — a global fetch/fs mock risks cross-file leakage and load-order
 * coupling. The DI seam has neither hazard and keeps the guarantee a plain assertion.
 */
export interface RefreshIO {
  get: (url: string, retries?: number) => Promise<string>;
  writeFile: (dest: string, body: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

export const realIO: RefreshIO = {
  get,
  writeFile: (dest, body) => writeFile(dest, body),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
};

async function capture(url: string, dest: string, io: RefreshIO) {
  await assertNoUnmigratedCorrection(dest); // fail before the fetch, not after the clobber
  const body = await io.get(url, dest.endsWith(".json") ? 5 : 0);
  await io.writeFile(dest, body);
  console.log(`  ${dest} (${body.length}B)`);
}

/** Transport plumbing, not gameplay. The bar is a REAL call site in src/client/http.ts:
 *  `/api/v2/session` is how the client opens a session (http.ts, session creation), so it can
 *  never appear in the action registry and is not a capability gap.
 *
 *  Deliberately NOT here: `notifications` and `agentlogs`. Neither is called anywhere in src/
 *  (notifications ride along inside mutation-response envelopes; agentlogs we simply never use).
 *  An endpoint we don't call isn't plumbing — it is an unregistered capability, and it renders ⬜
 *  and counts in the gap like every other one. Calling them "transport" flattered the number by 2. */
const TRANSPORT = new Set(["session"]);

/** True only for an explicit network-refresh flag. Bare argv (and the legacy
 *  `--index-only`) stay OFFLINE — this predicate is the whole safe-by-default
 *  decision (#424), exported so a test pins that a no-flag run never goes live. */
export function wantsLive(argv: string[]): boolean {
  return argv.includes("--live") || argv.includes("--fetch");
}

export async function main(argv: string[] = process.argv, io: RefreshIO = realIO): Promise<"index-only" | "live"> {
  if (!wantsLive(argv)) {
    // SAFE DEFAULT: offline local rebuild of commands.md from the vendored spec.
    // No network, no upstream/ write. `--live` (or `--fetch`) opts into capture.
    console.log("mode: index-only (offline local rebuild; pass --live to re-capture upstream)");
    await writeCommands(io);
    return "index-only";
  }

  console.log("mode: live (re-capturing upstream over the network)");
  await io.mkdir(`${UP}/docs`);
  await io.mkdir(`${UP}/guides`);

  console.log("capturing pages...");
  await Promise.all(PAGES.map((p) => capture(`${SITE}/${p}`, `${UP}/${p}`, io)));
  console.log("capturing mechanics docs...");
  await Promise.all(DOCS.map((d) => capture(`${SITE}/docs/${d}.md`, `${UP}/docs/${d}.md`, io)));
  console.log("capturing playstyle guides...");
  await Promise.all(GUIDES.map((g) => capture(`${SITE}/docs/guides/${g}.md`, `${UP}/guides/${g}.md`, io)));
  console.log("capturing specs (rate-limited 1/min, be patient)...");
  for (const [path, name] of SPECS) await capture(`${SITE}${path}`, `${UP}/${name}`, io);

  await writeCommands(io);
  return "live";
}

export type Spec = {
  info?: { version?: string };
  paths: Record<string, { post?: Op; get?: Op }>;
};

type Op = {
  summary?: string;
  "x-is-mutation"?: boolean;
  requestBody?: { content?: { "application/json"?: { schema?: {
    required?: string[]; properties?: Record<string, unknown>;
  } } } };
};

async function writeCommands(io: RefreshIO = realIO) {
  const spec = JSON.parse(await Bun.file(SPEC_PATH).text()) as Spec;
  await io.writeFile(COMMANDS_PATH, renderCommands(spec));
  console.log(`wrote ${COMMANDS_PATH} — ${REGISTRY.length} actions registered`);
}

/**
 * Renders commands.md from the vendored spec + the action registry. Pure (no IO), because
 * test/game-reference-drift.test.ts re-renders it and byte-compares against the committed
 * file — that test IS the guarantee the ✅/⬜ column can't drift from src/registry/actions.ts.
 */
export function renderCommands(spec: Spec): string {
  const registered = new Set(REGISTRY.map((a) => `${a.tool}/${a.name}`));
  const byTool = new Map<string, Array<{ action: string; line: string; reg: boolean }>>();

  for (const [path, methods] of Object.entries(spec.paths)) {
    const op = methods.post ?? methods.get;
    if (!op) continue;
    const seg = path.replace("/api/v2/", "").split("/");
    const tool = seg[0]!;
    const action = seg[1] ?? ""; // spacemolt_catalog and the plumbing routes take no action
    if (action === "help") continue; // every tool has it; documented once in the header

    const schema = op.requestBody?.content?.["application/json"]?.schema;
    const req = schema?.required ?? [];
    const opt = Object.keys(schema?.properties ?? {}).filter((p) => !req.includes(p));
    const params = [...req, ...opt.map((p) => `${p}?`)].join(", ");

    const transport = TRANSPORT.has(tool);
    const reg = registered.has(`${tool}/${action}`);
    const call = `\`${action || tool}(${params})\``;
    const kind = op["x-is-mutation"] ? "M" : "Q";
    const summary = (op.summary ?? "").replace(/\|/g, "\\|");
    const mark = transport ? "🔌" : reg ? "✅" : "⬜";
    const list = byTool.get(tool) ?? [];
    list.push({
      action,
      reg: reg || transport, // transport routes are not capability gaps
      line: `| ${mark} | ${call} | ${kind} | ${summary} |`,
    });
    byTool.set(tool, list);
  }

  const total = [...byTool.values()].flat();
  const regCount = REGISTRY.length;
  const gapCount = total.filter((a) => !a.reg).length;

  const out: string[] = [];
  out.push(
    "<!--",
    "  GENERATED FILE — do not hand-edit.",
    "  Source: upstream/openapi-v2.json (https://www.spacemolt.com/api/v2/openapi.json)",
    "          + src/registry/actions.ts (the ✅/⬜ column)",
    `  Regenerate: bun run scripts/refresh-game-reference.ts`,
    "-->",
    "",
    "# SpaceMolt command index",
    "",
    `Every action the game exposes, one line each. Game API v${spec.info?.version ?? "?"}; ` +
      `${total.length} actions across ${byTool.size} tools. Our harness registers **${regCount}**; ` +
      `**${gapCount} are unregistered** — the game can do them and our pilot cannot.`,
    "",
    "**Columns.** ✅ = registered in `src/registry/actions.ts` (our pilot can call it). " +
      "⬜ = the game supports it and we never wired it — that column *is* the capability-gap list. " +
      "🔌 = transport plumbing: `src/client/http.ts` calls it directly to open the session, so it " +
      "can never be a registry action and is not a gap. It is the only route excluded, and it is " +
      "excluded because there is a real call site — an endpoint we simply don't use (`notifications`, " +
      "`agentlogs`) is an unregistered capability, not plumbing, and stays ⬜. " +
      "`M` = mutation (costs a tick, ~10s, 1 per tick). `Q` = query (free, unlimited).",
    "",
    "Parameters are the request body fields; `?` marks optional. Params and summaries come " +
      "straight from the game's OpenAPI spec — if a line here disagrees with our code, the line is right.",
    "",
    "Need more than one line? Each group links to the game's own mechanics pages, and the full " +
      "request/response schema for every action is in [`upstream/openapi-v2.json`](upstream/openapi-v2.json). " +
      "Every tool also accepts `action=\"help\"` in-game (a free query; omitted from the tables below).",
    "",
  );

  for (const tool of [...byTool.keys()].sort()) {
    const rows = byTool.get(tool)!.sort((a, b) => a.action.localeCompare(b.action));
    const gaps = rows.filter((r) => !r.reg).length;
    const docs = (TOOL_DOCS[tool] ?? [])
      .map((d) => `[${d}](upstream/docs/${d}.md)`)
      .join(" · ");
    const n = rows.length;
    out.push(`## \`${tool}\``);
    out.push("");
    out.push(
      TRANSPORT.has(tool)
        ? "Transport route — called by the HTTP client, not the action registry."
        : `${n} action${n === 1 ? "" : "s"} · ${n - gaps} registered · ${gaps} unregistered` +
          (docs ? `\nMechanics: ${docs}` : ""),
    );
    out.push("");
    out.push("|  | Action | | What it does |");
    out.push("|---|---|---|---|");
    for (const r of rows) out.push(r.line);
    out.push("");
  }

  return out.join("\n");
}

// CLI entry only: importing this module (the drift gate does) must not fetch or write.
if (import.meta.main) await main();
