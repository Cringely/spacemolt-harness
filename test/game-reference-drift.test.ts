// Game-reference drift gate. docs/game-reference/commands.md is GENERATED from two
// sources of truth — the vendored OpenAPI v2 spec (what the game can do) and
// src/registry/actions.ts (what our pilot can do) — and its whole value is the ✅/⬜
// column being true. This test IS the forcing function: it re-renders the file from
// both sources and compares byte-for-byte, so registering an action WITHOUT running
// `bun run scripts/refresh-game-reference.ts` (bare = offline index rebuild, the safe
// default since #424) fails the suite instead of leaving a lying capability-gap table
// on disk. Same pattern as roadmap-drift.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMANDS_PATH,
  SPEC_PATH,
  renderCommands,
  type Spec,
} from "../scripts/refresh-game-reference";

const root = join(import.meta.dir, "..");

// Container-context gate (same convention as roadmap-drift /
// guardrails-slice): .dockerignore excludes docs/ from the image BY DESIGN, so inside
// the image build both the vendored spec and the committed commands.md are absent —
// skip there; every developer `bun test` and the repo CI still run the gate. The
// L-20/#130 class: this test's DATA inputs live outside the image's copy path. The
// registry half of the SSOT ships in the image, but half a comparison proves nothing.
const specPresent = existsSync(join(root, SPEC_PATH));

describe.skipIf(!specPresent)("game-reference drift gate (commands.md ✅/⬜ column)", () => {
  test("committed commands.md matches regeneration from the spec + the registry (this IS the gate)", () => {
    const spec = JSON.parse(readFileSync(join(root, SPEC_PATH), "utf8")) as Spec;
    // .gitattributes pins `* text=auto eol=lf`, so a byte comparison is safe across
    // checkouts; the generator emits LF only.
    const committed = readFileSync(join(root, COMMANDS_PATH), "utf8");
    expect(committed).toBe(renderCommands(spec));
  });

  test("the transport exclusion is exactly one route, and it has a real call site", () => {
    // The 🔌 marker shrinks the reported capability gap, so it is only honest for a route
    // src/client/http.ts actually calls. `session` is that route. `notifications` and
    // `agentlogs` are endpoints we never call — unregistered capabilities, not plumbing —
    // and must render ⬜ and count in the gap. (PR #217 review, F2.)
    const md = readFileSync(join(root, COMMANDS_PATH), "utf8");
    expect(md.match(/^\| 🔌 \|/gm)?.length).toBe(1); // exactly one excluded route
    expect(md).toContain("| 🔌 | `session(");
    expect(md).toContain("| ⬜ | `notifications(");
    expect(md).toContain("| ⬜ | `agentlogs(");

    const http = readFileSync(join(root, "src/client/http.ts"), "utf8");
    expect(http).toContain("/api/v2/session");
  });
});
