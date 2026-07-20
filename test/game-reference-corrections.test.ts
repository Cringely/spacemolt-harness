// Correction notes must survive a vendored-reference re-capture (issue #326). The refresh
// script overwrites every upstream/*.md file byte-for-byte, so a dated live-falsification note
// written into a captured page would be silently wiped on the next run — which breaks the
// evidence-precedence write-back the whole reference-checking discipline rests on (AGENTS.md).
// The fix: corrections live in docs/game-reference/corrections.md (a sidecar the refresh never
// captures), and capture() refuses to overwrite any file that still carries an inline marker.
// These tests fail if the guard stops refusing (a re-capture could then drop a correction) or
// over-fires on a clean page (which would break every normal refresh).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoUnmigratedCorrection, CORRECTION_MARKER } from "../scripts/refresh-game-reference";

const root = join(import.meta.dir, "..");

// Container-context gate (same convention as game-reference-drift / roadmap-drift):
// .dockerignore excludes docs/ from the image BY DESIGN, so the corrections sidecar and the
// captured markets.md this suite reads are absent inside the image build — skip there; every
// developer `bun test` and the repo CI still run the gate on the host.
const correctionsPresent = existsSync(join(root, "docs/game-reference/corrections.md"));

describe.skipIf(!correctionsPresent)("game-reference corrections survive a re-capture (issue #326)", () => {
  test("refresh refuses to overwrite a captured file that still carries an inline correction note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gr-corrections-"));
    const dest = join(dir, "markets.md");
    writeFileSync(
      dest,
      "- `estimate_purchase` — read-only preview.\n\n" +
        "> **Correction (2026-07-17, live-falsified, issue #315):** requires a dock.\n",
    );
    // capture() calls exactly this before writeFile; a throw aborts the overwrite, so the
    // correction on disk is never silently wiped — that untouched file IS the survival.
    await expect(assertNoUnmigratedCorrection(dest)).rejects.toThrow(/correction note/i);
  });

  test("refresh overwrites a clean page normally (guard doesn't block a real refresh)", async () => {
    // Without this, a guard that always threw would pass the test above yet break every refresh.
    const dir = mkdtempSync(join(tmpdir(), "gr-corrections-"));
    const dest = join(dir, "markets.md");
    writeFileSync(dest, "- `estimate_purchase` — read-only preview.\n\n- `analyze_market` — insights.\n");
    await expect(assertNoUnmigratedCorrection(dest)).resolves.toBeUndefined();
  });

  test("the migrated markets.md correction resolves in the sidecar the refresh never touches", () => {
    const sidecar = readFileSync(join(root, "docs/game-reference/corrections.md"), "utf8");
    expect(sidecar).toContain("estimate_purchase");
    expect(sidecar).toContain("issue #315");
    // And it is gone from the captured page, so the page is back to a byte-for-byte upstream copy.
    const captured = readFileSync(join(root, "docs/game-reference/upstream/docs/markets.md"), "utf8");
    expect(CORRECTION_MARKER.test(captured)).toBe(false);
  });
});
