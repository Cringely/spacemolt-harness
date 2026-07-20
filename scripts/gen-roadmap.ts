// Road-to-the-fleet roadmap generator (#gate-path visual for the README).
//
// SSOT: the gate table in docs/milestones.md ("The road to the fleet"
// section). This script parses that table and renders it as two committed
// SVGs (light + dark) that the README embeds via the <picture> pattern.
// test/roadmap-drift.test.ts regenerates them on every `bun test` and fails
// if the committed files differ — so a gate-table edit without regeneration
// is a red suite, never a stale picture.
//
// Design constraints:
// - Zero dependencies, deterministic output (stable ordering/ids, no
//   timestamps) so regeneration is diffable.
// - FAIL LOUDLY on any parse ambiguity (missing table, unknown status
//   marker, malformed row). Never emit a guessed roadmap: a wrong picture
//   published as truth is worse than a crash.
// - No external references in the SVG (GitHub sanitizes them away).
//
// Regenerate after any gate-table change:  bun scripts/gen-roadmap.ts

export const MILESTONES_PATH = "docs/milestones.md";
export const ROADMAP_ASSETS = {
  light: "docs/assets/road-to-fleet.svg",
  dark: "docs/assets/road-to-fleet-dark.svg",
} as const;

export type GateStatus = "done" | "progress" | "open" | "goal";

export interface Gate {
  id: string; // "G1".."G7", or "GOAL" for the 🎯 row
  name: string; // "Harness live"
  status: GateStatus;
  note: string; // short display note, truncated to NOTE_MAX code points
}

// Truncation is part of the committed-output contract: deterministic, by
// code point (never mid-surrogate), with a trailing ellipsis.
export const NOTE_MAX = 30;

const HEADER_RE = /^\|\s*#\s*\|\s*Gate\s*\|\s*Definition of done\s*\|\s*Status\s*\|\s*$/;

function truncateNote(note: string): string {
  const cps = Array.from(note);
  if (cps.length <= NOTE_MAX) return note;
  return cps.slice(0, NOTE_MAX - 1).join("") + "…";
}

/**
 * Parse the road-to-the-fleet gate table out of the milestones markdown.
 * Anchored on the table HEADER row (column names), not on section prose or
 * line numbers, so note-text and surrounding-prose edits can't break it.
 * Throws with a specific message on anything it can't parse unambiguously.
 */
export function parseGates(md: string): Gate[] {
  const lines = md.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  if (headerIdx === -1) {
    throw new Error(
      `gen-roadmap: gate-table header row not found in ${MILESTONES_PATH} ` +
        `(expected a markdown table with columns: # | Gate | Definition of done | Status). ` +
        `Refusing to emit a guessed roadmap.`,
    );
  }
  const sep = lines[headerIdx + 1] ?? "";
  if (!/^\|[\s\-:|]+\|\s*$/.test(sep)) {
    throw new Error(
      `gen-roadmap: expected a markdown separator row after the gate-table header, got: ${JSON.stringify(sep)}`,
    );
  }

  const gates: Gate[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trimStart().startsWith("|")) break; // end of table
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 4) {
      throw new Error(
        `gen-roadmap: gate row has ${cells.length} columns, expected 4: ${JSON.stringify(line)}`,
      );
    }
    const [idRaw, nameRaw, , statusCell] = cells as [string, string, string, string];
    const name = nameRaw.replace(/\*\*/g, "").trim();

    if (idRaw === "🎯") {
      gates.push({ id: "GOAL", name, status: "goal", note: "the goal" });
      continue;
    }
    if (!/^G\d+$/.test(idRaw)) {
      throw new Error(`gen-roadmap: unrecognized gate id ${JSON.stringify(idRaw)} in row: ${JSON.stringify(line)}`);
    }

    let status: GateStatus;
    let rest: string;
    if (statusCell.startsWith("✅")) {
      status = "done";
      rest = statusCell.slice("✅".length);
    } else if (statusCell.startsWith("🔶")) {
      status = "progress";
      rest = statusCell.slice("🔶".length);
    } else if (statusCell.startsWith("⬜")) {
      status = "open";
      rest = statusCell.slice("⬜".length);
    } else {
      throw new Error(
        `gen-roadmap: unknown status marker in ${idRaw} status cell ${JSON.stringify(statusCell)} ` +
          `(expected it to start with ✅ / 🔶 / ⬜). Refusing to guess.`,
      );
    }

    // Note = the detail after the status word ("done (2026-07-14)" →
    // "(2026-07-14)"); the status itself is conveyed by the node style. When
    // the cell carries no detail, show the plain status word.
    const detail = rest
      .trim()
      .replace(/^(done|in progress|open)\b/i, "")
      .replace(/^[\s—–:,-]+/, "")
      .trim();
    const note =
      detail !== "" ? detail : status === "done" ? "done" : status === "progress" ? "in progress" : "open";
    gates.push({ id: idRaw, name, status, note: truncateNote(note) });
  }

  const gateCount = gates.filter((g) => g.status !== "goal").length;
  if (gateCount === 0) {
    throw new Error(`gen-roadmap: gate-table header found but zero G-rows parsed in ${MILESTONES_PATH}.`);
  }
  return gates;
}

// ---------------------------------------------------------------------------
// Rendering. Visual language matches the milestone-tracker Artifact's gate
// path: nodes on a connecting track — done = green check node, in-progress =
// amber glowing node, open = muted outline, goal = dashed amber ring with 🛸.
// ---------------------------------------------------------------------------

interface Palette {
  fg: string;
  muted: string;
  track: string;
  done: string;
  amber: string;
  check: string;
}

const PALETTES: Record<"light" | "dark", Palette> = {
  light: { fg: "#1f2328", muted: "#656d76", track: "#d0d7de", done: "#1a7f37", amber: "#bf8700", check: "#ffffff" },
  dark: { fg: "#e6edf3", muted: "#8b949e", track: "#30363d", done: "#3fb950", amber: "#d29922", check: "#0d1117" },
};

const PAD = 20;
const COL = 150;
const NODE_Y = 34;
const HEIGHT = 100;
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderRoadmapSvg(gates: Gate[], theme: "light" | "dark"): string {
  const p = PALETTES[theme];
  const width = PAD * 2 + COL * gates.length;
  const cx = (i: number) => PAD + COL * i + COL / 2;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="Road to the fleet: gate path from G1 to FLEET DEPLOYED">`,
    `<title>The road to the fleet — generated from docs/milestones.md</title>`,
  );

  // Base track, then a highlighted segment after every DONE gate (the path
  // "filled in" up to where the fleet actually stands).
  parts.push(
    `<line x1="${cx(0)}" y1="${NODE_Y}" x2="${cx(gates.length - 1)}" y2="${NODE_Y}" stroke="${p.track}" stroke-width="2"/>`,
  );
  for (let i = 0; i < gates.length - 1; i++) {
    if (gates[i]!.status === "done") {
      parts.push(
        `<line x1="${cx(i)}" y1="${NODE_Y}" x2="${cx(i + 1)}" y2="${NODE_Y}" stroke="${p.done}" stroke-width="2"/>`,
      );
    }
  }

  gates.forEach((g, i) => {
    const x = cx(i);
    if (g.status === "done") {
      parts.push(
        `<circle cx="${x}" cy="${NODE_Y}" r="10" fill="${p.done}"/>`,
        `<path d="M ${x - 4.5} ${NODE_Y + 0.5} l 3 3 l 6 -6.5" fill="none" stroke="${p.check}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    } else if (g.status === "progress") {
      parts.push(
        `<circle cx="${x}" cy="${NODE_Y}" r="15" fill="${p.amber}" fill-opacity="0.25"/>`,
        `<circle cx="${x}" cy="${NODE_Y}" r="10" fill="${p.amber}"/>`,
      );
    } else if (g.status === "open") {
      parts.push(`<circle cx="${x}" cy="${NODE_Y}" r="10" fill="none" stroke="${p.muted}" stroke-width="2"/>`);
    } else {
      // goal: dashed amber ring with the ship inside
      parts.push(
        `<circle cx="${x}" cy="${NODE_Y}" r="13" fill="none" stroke="${p.amber}" stroke-width="2" stroke-dasharray="4 3"/>`,
        `<text x="${x}" y="${NODE_Y + 4.5}" text-anchor="middle" font-family="${FONT}" font-size="12">🛸</text>`,
      );
    }

    const label = g.status === "goal" ? g.name : `${g.id} · ${g.name}`;
    const labelFill = g.status === "goal" ? p.amber : p.fg;
    parts.push(
      `<text x="${x}" y="66" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="600" fill="${labelFill}">${esc(label)}</text>`,
      `<text x="${x}" y="82" text-anchor="middle" font-family="${FONT}" font-size="9" fill="${p.muted}">${esc(g.note)}</text>`,
    );
  });

  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI entry: read the SSOT, write both themes. File IO lives ONLY here so the
// module is importable inside the container image (where docs/ is absent).
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  // Anchor output to the worktree we run in (CWD toplevel), NOT import.meta.dir:
  // the file location resolves through the MAIN checkout from a linked worktree,
  // leaking the SVGs outside the steward's branch (#321).
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" });
  if (top.status !== 0) {
    throw new Error(`gen-roadmap: 'git rev-parse --show-toplevel' failed: ${(top.stderr ?? "").trim() || "not a git working tree"}`);
  }
  const root = top.stdout.trim();

  const md = readFileSync(join(root, MILESTONES_PATH), "utf8");
  const gates = parseGates(md);
  for (const theme of ["light", "dark"] as const) {
    const out = join(root, ROADMAP_ASSETS[theme]);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderRoadmapSvg(gates, theme));
    // Absolute path so steward-prep can guard the worktree boundary (#321).
    console.log(`wrote ${out} (${gates.length} nodes)`);
  }
}
