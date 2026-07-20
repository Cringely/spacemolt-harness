import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The event-type filter logic lives inline in the served dashboard.html (a
// standalone static asset -- no bundler, so there is no importable module).
// Rather than duplicate the logic here (which could drift from what ships),
// extract the exact pure block between its BEGIN/END markers and evaluate it,
// so this test exercises the real shipped code. If the markers or the block's
// shape change, this fails loudly rather than testing a stale copy.
function loadEventFilter(): {
  KNOWN_TYPES: string[];
  DEFAULT_HIDDEN: string[];
  bucket: (t: string) => string;
  defaults: () => Record<string, boolean>;
  visible: (s: Record<string, boolean>, t: string) => boolean;
} {
  const html = readFileSync(new URL("../src/server/dashboard.html", import.meta.url), "utf8");
  // Slice from the `var EVENT_FILTER` declaration (skipping the marker's own
  // comment prose) to the END marker, so the evaluated text is valid JS.
  const begin = html.indexOf("var EVENT_FILTER");
  const end = html.indexOf("--- pure event-filter helpers (END");
  if (begin === -1 || end === -1) throw new Error("event-filter marker block not found in dashboard.html");
  const block = html.slice(begin, end);
  // The block defines `var EVENT_FILTER = (function(){...})();`
  return new Function(block + "\nreturn EVENT_FILTER;")();
}

const EF = loadEventFilter();

describe("dashboard event-type filter (extracted from dashboard.html)", () => {
  test("default: the high-volume telemetry types are OFF, every other known type and 'other' are ON", () => {
    const d = EF.defaults();
    // The default-hidden set is the dashboard's own (status_snapshot, and since
    // #263 plan_context) -- read from the shipped block rather than restated, so
    // adding a hidden type doesn't need this assertion rewritten.
    expect(EF.DEFAULT_HIDDEN).toContain("status_snapshot");
    expect(EF.DEFAULT_HIDDEN).toContain("plan_context");
    for (const t of EF.DEFAULT_HIDDEN) expect(d[t]).toBe(false);
    for (const t of EF.KNOWN_TYPES) {
      if (EF.DEFAULT_HIDDEN.includes(t)) continue;
      expect(d[t]).toBe(true);
    }
    expect(d.other).toBe(true);
  });

  test("bucket: known types map to themselves, unknown types fall into 'other'", () => {
    expect(EF.bucket("wake")).toBe("wake");
    expect(EF.bucket("status_snapshot")).toBe("status_snapshot");
    // Real emitted-but-untoggled types (planner_transient_error, loop_error,
    // status_error, ...) must bucket to "other" so they stay filterable.
    expect(EF.bucket("planner_transient_error")).toBe("other");
    expect(EF.bucket("loop_error")).toBe("other");
    expect(EF.bucket("some_future_event")).toBe("other");
  });

  test("visible: default hides status_snapshot but shows a wake and an unknown type", () => {
    const d = EF.defaults();
    expect(EF.visible(d, "status_snapshot")).toBe(false);
    expect(EF.visible(d, "wake")).toBe(true);
    expect(EF.visible(d, "planner_transient_error")).toBe(true); // via 'other' = on
  });

  test("visible: toggling 'other' off hides every unknown type as a group", () => {
    const s = EF.defaults();
    s.other = false;
    expect(EF.visible(s, "loop_error")).toBe(false);
    expect(EF.visible(s, "status_error")).toBe(false);
    expect(EF.visible(s, "wake")).toBe(true); // a known type is unaffected
  });

  test("visible: turning status_snapshot on shows it (the operator opt-in path)", () => {
    const s = EF.defaults();
    s.status_snapshot = true;
    expect(EF.visible(s, "status_snapshot")).toBe(true);
  });

  test("the named event types all have a per-type toggle", () => {
    for (const t of [
      "status_snapshot", "progress_heartbeat", "wake", "plan", "action",
      "plan_thrash_backoff", "plan_budget_exceeded", "operator_alert", "deploy_marker",
    ]) {
      expect(EF.KNOWN_TYPES).toContain(t);
    }
  });

  test("notification and ledger are known types, default ON (low-volume, visible without opt-in)", () => {
    // Unlike status_snapshot these are low-volume and are the operator's answer
    // to "what actually happened this tick" (game result feed + credit/cargo
    // deltas), so they ship visible.
    const d = EF.defaults();
    for (const t of ["notification", "ledger"]) {
      expect(EF.KNOWN_TYPES).toContain(t);
      expect(d[t]).toBe(true);
      expect(EF.visible(d, t)).toBe(true);
      expect(EF.bucket(t)).toBe(t);
    }
  });

  test("progress_heartbeat is a known type, default ON (visible without opt-in)", () => {
    // Unlike status_snapshot, the heartbeat is low-volume (once per window) and
    // is the operator's continuous progress pulse, so it ships visible.
    const d = EF.defaults();
    expect(d.progress_heartbeat).toBe(true);
    expect(EF.visible(d, "progress_heartbeat")).toBe(true);
    expect(EF.bucket("progress_heartbeat")).toBe("progress_heartbeat");
  });
});
