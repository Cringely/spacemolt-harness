// Roadmap drift gate. The README's road-to-fleet SVGs are GENERATED from the
// gate table in docs/milestones.md (the SSOT — see scripts/gen-roadmap.ts).
// The first two tests ARE the maintenance forcing function: they regenerate
// from the current table and compare byte-for-byte against the committed
// files, so a gate-table edit without `bun scripts/gen-roadmap.ts` fails the
// suite instead of leaving a stale picture on the README. The remaining
// tests pin the fail-loud parser contract: a broken/ambiguous table throws,
// it never emits a guessed roadmap.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MILESTONES_PATH,
  NOTE_MAX,
  ROADMAP_ASSETS,
  parseGates,
  renderRoadmapSvg,
} from "../scripts/gen-roadmap";

const root = join(import.meta.dir, "..");

// Container-context gate (same convention as guardrails-slice.test.ts):
// .dockerignore excludes docs/ from the image BY
// DESIGN, so inside the image build the SSOT and the committed SVGs are both
// absent — skip there; every developer `bun test` and the repo CI still run
// the gate. The L-20/#130 class: this test's DATA inputs live outside the
// image's copy path. A missing asset FILE with the SSOT present still fails
// loudly (readFileSync throws inside the test).
const ssotPresent = existsSync(join(root, MILESTONES_PATH));

describe.skipIf(!ssotPresent)("roadmap drift gate (README road-to-fleet SVGs)", () => {
  // .gitattributes pins `* text=auto eol=lf`, so a byte comparison is safe
  // across checkouts; the generator emits LF only.
  const md = ssotPresent ? readFileSync(join(root, MILESTONES_PATH), "utf8") : "";

  for (const theme of ["light", "dark"] as const) {
    test(`committed ${theme} SVG matches regeneration from the gate table (this IS the gate)`, () => {
      const committed = readFileSync(join(root, ROADMAP_ASSETS[theme]), "utf8");
      expect(committed).toBe(renderRoadmapSvg(parseGates(md), theme));
    });
  }
});

describe("gate-table parser fails loudly (never a guessed roadmap)", () => {
  const table = [
    "| # | Gate | Definition of done | Status |",
    "|---|---|---|---|",
    "| G1 | Harness live | stuff | ✅ done |",
    "| 🎯 | **FLEET DEPLOYED** | trio flying | — |",
  ];

  test("a missing gate-table header row throws", () => {
    expect(() => parseGates("# Milestones\n\nno table here\n")).toThrow(/header row not found/);
  });

  test("an unknown status marker throws instead of guessing", () => {
    const mutated = table.map((l) => l.replace("✅ done", "❓ maybe")).join("\n");
    expect(() => parseGates(mutated)).toThrow(/unknown status marker/);
  });

  test("note truncation is deterministic: code points, cut with a trailing ellipsis", () => {
    const long = "in progress — " + "x".repeat(60);
    const mutated = table.map((l) => l.replace("✅ done", `🔶 ${long}`)).join("\n");
    const note = parseGates(mutated)[0]!.note;
    expect(Array.from(note).length).toBe(NOTE_MAX);
    expect(note).toBe("x".repeat(NOTE_MAX - 1) + "…");
  });

  test("the 🎯 row parses as the goal node, markdown bold stripped", () => {
    const gates = parseGates(table.join("\n"));
    expect(gates.at(-1)).toEqual({ id: "GOAL", name: "FLEET DEPLOYED", status: "goal", note: "the goal" });
  });
});
