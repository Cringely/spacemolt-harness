import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The dashboard's instruct-POST body builder lives inline in the served
// dashboard.html (a standalone static asset -- no bundler, so there is no
// importable module). Same extraction pattern as test/event-filter.test.ts
// and test/mission-expiry.test.ts: pull the exact pure function between its
// markers and evaluate it, so this exercises the real shipped code rather
// than a copy that could drift.
//
// Issue #1106, sub-claim (a): before this function existed, NO caller ever
// sent `standing` on the wire (dashboard.html always POSTed `{text}` only;
// scripts/strategy-store.ts the same) -- server.ts's InstructBodySchema and
// agent.ts's pin mechanism (#817) were fully wired and completely
// unreachable. This test pins the wire shape: `standing` appears in the body
// if and ONLY if the checkbox was checked, and an unchecked send produces
// the byte-identical body every pre-#1106 caller always sent.
function loadBuildInstructBody(): (text: string, standing: boolean) => Record<string, unknown> {
  const html = readFileSync(new URL("../src/server/dashboard.html", import.meta.url), "utf8");
  const begin = html.indexOf("function buildInstructBody");
  const end = html.indexOf("--- pure instruct-body helper (END");
  if (begin === -1 || end === -1) throw new Error("instruct-body marker block not found in dashboard.html");
  return new Function(html.slice(begin, end) + "\nreturn buildInstructBody;")();
}

const buildInstructBody = loadBuildInstructBody();

describe("dashboard instruct-body builder (extracted from dashboard.html, #1106)", () => {
  test("standing unchecked: body is exactly {text} -- byte-identical to every pre-#1106 caller", () => {
    expect(buildInstructBody("go dock and wait", false)).toEqual({ text: "go dock and wait" });
  });

  test("standing checked: body adds standing:true, text unchanged", () => {
    expect(buildInstructBody("Fuel rule, standing until revoked", true)).toEqual({
      text: "Fuel rule, standing until revoked",
      standing: true,
    });
  });

  test("the unchecked body never carries a `standing` key at all, not even standing:false", () => {
    const body = buildInstructBody("go dock and wait", false);
    expect(Object.prototype.hasOwnProperty.call(body, "standing")).toBe(false);
  });
});
