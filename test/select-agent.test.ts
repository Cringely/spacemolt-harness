import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// selectAgent lives inline in dashboard.html (src/server/dashboard.html:1369)
// and, unlike buildInstructBody (test/instruct-body.test.ts), is not a
// self-contained pure function -- it reads and writes free identifiers for
// its DOM/render dependencies: snapshots, selectedId, commsTarget, textEl,
// sendBtn, standingEl, renderFleet, renderMain, refreshUsage, refreshFailures,
// refreshMissions. A nested function declaration closes over its enclosing
// Function's parameters, so wrapping the extracted declaration in a
// `new Function` whose parameter names match those identifiers exactly runs
// the real shipped body against test doubles instead of the live DOM -- no
// restated copy, no jsdom dependency.
//
// #1106 fix round: selectAgent re-enabled the Standing checkbox
// (`standingEl.disabled = false`) but never cleared `standingEl.checked`, so
// a box left checked while agent A was selected stayed checked after
// switching to agent B, silently pinning the operator's next one-shot
// instruction to the wrong pilot -- the send handler already resets
// `checked` per-send ("Reset per-send, not sticky", dashboard.html ~1421);
// switching agents skipped that same reset entirely.
function loadSelectAgentFactory(): (...args: unknown[]) => (id: string) => void {
  const html = readFileSync(new URL("../src/server/dashboard.html", import.meta.url), "utf8");
  const begin = html.indexOf("function selectAgent(id) {");
  const end = html.indexOf("--- selectAgent (END)");
  if (begin === -1 || end === -1) throw new Error("selectAgent marker block not found in dashboard.html");
  const src = html.slice(begin, end);
  return new Function(
    "snapshots", "selectedId", "commsTarget", "textEl", "sendBtn", "standingEl",
    "renderFleet", "renderMain", "refreshUsage", "refreshFailures", "refreshMissions",
    src + "\nreturn selectAgent;",
  ) as (...args: unknown[]) => (id: string) => void;
}

const makeSelectAgent = loadSelectAgentFactory();

type Stubs = {
  snapshots: Map<string, unknown>;
  commsTarget: { textContent: string };
  textEl: { disabled: boolean };
  sendBtn: { disabled: boolean };
  standingEl: { checked: boolean; disabled: boolean } | null;
  calls: string[];
};

function stubs(): Stubs {
  return {
    snapshots: new Map([["a", {}], ["b", {}]]),
    commsTarget: { textContent: "" },
    textEl: { disabled: true },
    sendBtn: { disabled: true },
    standingEl: { checked: true, disabled: true },
    calls: [],
  };
}

function callSelectAgent(id: string, s: Stubs): void {
  const selectAgent = makeSelectAgent(
    s.snapshots, undefined, s.commsTarget, s.textEl, s.sendBtn, s.standingEl,
    () => s.calls.push("renderFleet"),
    () => s.calls.push("renderMain"),
    (i: string) => s.calls.push("refreshUsage:" + i),
    (i: string) => s.calls.push("refreshFailures:" + i),
    (i: string) => s.calls.push("refreshMissions:" + i),
  );
  selectAgent(id);
}

describe("dashboard selectAgent (extracted from dashboard.html, #1106 fix round)", () => {
  test("switching agents clears a checked Standing box -- it must not carry over to the new pilot", () => {
    const s = stubs();
    s.standingEl!.checked = true;
    callSelectAgent("b", s);
    // toBe, not toBeFalsy: a strict-equality check on a boolean field can only
    // be satisfied by an actual `false` write, so a reverted/deleted reset
    // line (leaving `checked` at its prior `true`) fails this loudly -- a
    // looser truthiness matcher would also pass on `undefined` and could miss
    // the reset line being dropped in favor of something that merely stops
    // erroring.
    expect(s.standingEl!.checked).toBe(false);
  });

  test("switching agents still re-enables the box (pre-existing behavior, unchanged by the fix)", () => {
    const s = stubs();
    s.standingEl!.disabled = true;
    callSelectAgent("b", s);
    expect(s.standingEl!.disabled).toBe(false);
  });

  test("an unknown id is a no-op -- the guard clause returns before touching standingEl or rendering anything", () => {
    const s = stubs();
    s.standingEl!.checked = true;
    callSelectAgent("does-not-exist", s);
    expect(s.standingEl!.checked).toBe(true); // untouched: function returned early
    expect(s.calls).toEqual([]);
  });

  test("a null standingEl (element absent from the DOM) never throws", () => {
    const s = stubs();
    s.standingEl = null;
    expect(() => callSelectAgent("b", s)).not.toThrow();
  });
});
