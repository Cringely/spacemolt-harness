import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The mission-expiry humanizer lives inline in the served dashboard.html (a
// standalone static asset -- no bundler, so there is no importable module).
// Same pattern as test/event-filter.test.ts: extract the exact pure block
// between its markers and evaluate it, so this exercises the real shipped
// code instead of a copy that could drift.
function loadMissionExpiry(): {
  TICK_SECONDS: number;
  humanizeTicks: (ticks: number) => string;
} {
  const html = readFileSync(new URL("../src/server/dashboard.html", import.meta.url), "utf8");
  const begin = html.indexOf("var MISSION_EXPIRY");
  const end = html.indexOf("--- pure mission-expiry helper (END");
  if (begin === -1 || end === -1) throw new Error("mission-expiry marker block not found in dashboard.html");
  return new Function(html.slice(begin, end) + "\nreturn MISSION_EXPIRY;")();
}

const ME = loadMissionExpiry();

describe("dashboard mission-expiry humanizer (extracted from dashboard.html)", () => {
  test("a tick is 10 seconds (docs/game-reference/upstream/api.md: 'default tick = 10 seconds')", () => {
    expect(ME.TICK_SECONDS).toBe(10);
  });

  test("under an hour: whole minutes, floored at 1m so tiny counts never show 0m", () => {
    expect(ME.humanizeTicks(30)).toBe("~5m");   // 300s
    expect(ME.humanizeTicks(2)).toBe("~1m");    // 20s -> clamped up
    expect(ME.humanizeTicks(359)).toBe("~60m"); // 3590s, still under the hour cutoff
  });

  test("under a day: one-decimal hours (the operator's screenshot case)", () => {
    expect(ME.humanizeTicks(1870)).toBe("~5.2h"); // 18700s = 5.19h
    expect(ME.humanizeTicks(360)).toBe("~1.0h");  // exactly 3600s crosses into hours
  });

  test("a day or more: one-decimal days (the operator's screenshot case)", () => {
    expect(ME.humanizeTicks(46352)).toBe("~5.4d"); // 463520s = 5.36d
    expect(ME.humanizeTicks(8640)).toBe("~1.0d");  // exactly 86400s crosses into days
  });
});
