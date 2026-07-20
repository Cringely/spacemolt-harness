// #424: refresh-game-reference is SAFE BY DEFAULT. A bare (no-flag) run must do
// the OFFLINE index rebuild only — zero network, zero writes to upstream/ — and
// live capture must require an explicit --live/--fetch. These tests inject the
// effectful IO seam so the assertions are deterministic (no real network, no real
// disk write), and ablate the fix: flip the default back to live and the bare-mode
// test fails because io.get would fire.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS_PATH, main, wantsLive, type RefreshIO } from "../scripts/refresh-game-reference";

// Container-context gate (same convention as game-reference-drift):
// .dockerignore excludes docs/ from the image BY DESIGN, and main()'s index rebuild
// READS the vendored reference for real (only network/writes go through the RefreshIO
// seam), so inside the image build these tests throw on the missing tree. The L-20/#130
// class: skip there; every developer `bun test` and the repo CI still run them.
const docsPresent = existsSync(join(import.meta.dir, "..", "docs", "game-reference"));

// A recording IO: get() returns a stub body and records every URL; writeFile/mkdir
// record their targets. Nothing touches the real network or filesystem.
function recordingIO() {
  const gets: string[] = [];
  const writes: string[] = [];
  const mkdirs: string[] = [];
  const io: RefreshIO = {
    get: async (url) => {
      gets.push(url);
      return "{}"; // valid-enough body for both .md and .json capture targets
    },
    writeFile: async (dest) => {
      writes.push(dest);
    },
    mkdir: async (dir) => {
      mkdirs.push(dir);
    },
  };
  return { io, gets, writes, mkdirs };
}

describe("refresh-game-reference safe-by-default (#424)", () => {
  // The load-bearing guard: a bare invocation performs NO network call and writes
  // NOTHING under upstream/. If the default ever inverts back to live, io.get fires
  // and this fails.
  test.skipIf(!docsPresent)("bare invocation does no network and no upstream write", async () => {
    const { io, gets, writes, mkdirs } = recordingIO();
    const mode = await main([], io);
    expect(mode).toBe("index-only");
    expect(gets).toEqual([]); // no network
    expect(mkdirs).toEqual([]); // no directory creation — never touches upstream/
    // The only write is the offline commands.md rebuild; never an upstream/ file.
    expect(writes).toEqual([COMMANDS_PATH]);
    expect(writes.some((w) => w.includes("upstream/"))).toBe(false);
  });

  // The other half of the seam: --live actually captures. Ablates a fix that
  // disabled capture entirely instead of gating it.
  test.skipIf(!docsPresent)("--live captures upstream over the network and rewrites the index", async () => {
    const { io, gets, writes } = recordingIO();
    const mode = await main(["--live"], io);
    expect(mode).toBe("live");
    expect(gets.length).toBeGreaterThan(0); // network fired
    expect(writes.some((w) => w.includes("upstream/"))).toBe(true); // upstream captured
    expect(writes).toContain(COMMANDS_PATH); // index still rebuilt afterwards
  });

  // The predicate that IS the decision: only the explicit network flags are live;
  // bare and the legacy --index-only stay offline.
  test("wantsLive is true only for --live/--fetch", () => {
    expect(wantsLive([])).toBe(false);
    expect(wantsLive(["--index-only"])).toBe(false);
    expect(wantsLive(["--live"])).toBe(true);
    expect(wantsLive(["--fetch"])).toBe(true);
  });
});
