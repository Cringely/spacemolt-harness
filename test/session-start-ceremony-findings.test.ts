// SessionStart hook: JIT re-injection of open ceremony-filed findings
// (2026-07-26 operator escalation). Offline: every gh call is an injected
// CeremonyGhRunner, zero live gh/network. See the hook file's header for the
// full rationale.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CEREMONY_FINDINGS_CAP_DEFAULT,
  FILING_REPO as HOOK_FILING_REPO,
  MACHINE_LABEL as HOOK_MACHINE_LABEL,
  fetchOpenCeremonyFindings,
  formatAge,
  formatCeremonyBanner,
  type CeremonyGhRunner,
  type CeremonyIssue,
} from "../.claude/hooks/session-start-ceremony-findings";
import { FILING_REPO, MACHINE_LABEL } from "../src/scheduler/filing";

const HOUR = 3_600_000;
const issue = (n: number, ageMs: number, title = `Finding ${n}`): CeremonyIssue => ({
  number: n,
  title,
  createdAt: new Date(Date.now() - ageMs).toISOString(),
});

describe("fetchOpenCeremonyFindings (degrade-gracefully contract)", () => {
  // Catches: a `gh` binary that answers but with a failure exit (auth
  // expired, rate-limited, etc.) leaking through as "no findings" success
  // rather than being told apart from the real empty-list case at this layer
  // — both must degrade to null here so the caller never prints garbage.
  test("nonzero exit ⇒ null", async () => {
    const runner: CeremonyGhRunner = async () => ({ exitCode: 1, stdout: "error: not authenticated" });
    expect(await fetchOpenCeremonyFindings(runner, 1000)).toBeNull();
  });

  // Catches (R3, PR #29 review): the case above pairs a nonzero exit with
  // stdout that is ALSO invalid JSON, so it passes even if the exit-code
  // check is deleted — JSON.parse's own throw covers for it. This pins the
  // exit-code guard on its own: nonzero exit + WELL-FORMED JSON must still
  // be null. Ablate: remove `result.exitCode !== 0` from the `||` check in
  // fetchOpenCeremonyFindings — this test goes red (the valid array would
  // otherwise parse and return through the filter).
  test("nonzero exit with well-formed JSON body ⇒ still null (exit code checked, not just JSON validity)", async () => {
    const stdout = JSON.stringify([{ number: 9, title: "should not surface", createdAt: new Date().toISOString() }]);
    const runner: CeremonyGhRunner = async () => ({ exitCode: 1, stdout });
    expect(await fetchOpenCeremonyFindings(runner, 1000)).toBeNull();
  });

  // Catches: gh missing from PATH (ENOENT) crashing the hook instead of
  // degrading — a thrown/rejected runner must resolve to null, not throw.
  test("runner throws (e.g. ENOENT) ⇒ null, never propagates", async () => {
    const runner: CeremonyGhRunner = async () => {
      throw new Error("spawn gh ENOENT");
    };
    await expect(fetchOpenCeremonyFindings(runner, 1000)).resolves.toBeNull();
  });

  // Catches: gh returning success but garbage/unexpected shape (a schema
  // drift, an API error page mistaken for JSON) being trusted as data.
  test("malformed JSON ⇒ null", async () => {
    const runner: CeremonyGhRunner = async () => ({ exitCode: 0, stdout: "not json{{{" });
    expect(await fetchOpenCeremonyFindings(runner, 1000)).toBeNull();
  });

  test("JSON that is not an array ⇒ null", async () => {
    const runner: CeremonyGhRunner = async () => ({ exitCode: 0, stdout: JSON.stringify({ oops: true }) });
    expect(await fetchOpenCeremonyFindings(runner, 1000)).toBeNull();
  });

  // Catches: a hung `gh` process (network stall) blocking session start
  // indefinitely — the hard backstop lives in fetchOpenCeremonyFindings
  // itself (Promise.race), independent of whatever the runner does with its
  // own timeoutMs argument, so even a runner whose promise never settles
  // must not hang the hook past the deadline.
  //
  // R4 (PR #29 review): the original version just `await`ed the call
  // directly. If the internal Promise.race is removed, `fetchOpenCeremonyFindings`
  // awaits the never-settling runner forever — the test HANGS rather than
  // failing (confirmed: it outran `bun test` past 60s even with
  // `--timeout 8000`, so the assertions below never ran). Racing the call
  // against the test's OWN bound turns that hang into a fast, red assertion:
  // if the internal timeout is gone, `bounded` resolves via the EXTERNAL
  // race to `TIMED_OUT_SENTINEL` well before the call itself would ever
  // settle, and the `not.toBe` assertion fails immediately instead of the
  // test process hanging.
  test("a runner that never resolves ⇒ null within the timeout, not a hang", async () => {
    const runner: CeremonyGhRunner = () => new Promise(() => {}); // never settles
    const TEST_BOUND_MS = 500; // well above the 50ms timeoutMs given to the function
    const TIMED_OUT_SENTINEL = Symbol("test-bound-exceeded");
    const start = Date.now();
    const bounded = await Promise.race([
      fetchOpenCeremonyFindings(runner, 50),
      new Promise<typeof TIMED_OUT_SENTINEL>((resolve) => setTimeout(() => resolve(TIMED_OUT_SENTINEL), TEST_BOUND_MS)),
    ]);
    const elapsed = Date.now() - start;
    expect(bounded).not.toBe(TIMED_OUT_SENTINEL); // must resolve via the function's OWN timeout, not ours
    expect(bounded).toBeNull();
    expect(elapsed).toBeLessThan(TEST_BOUND_MS);
  });

  // Catches: the success path silently dropping malformed individual
  // entries (a partial API response) instead of filtering them out — a
  // filter that (wrongly) let one bad entry through would still return a
  // non-empty array and pass a looser assertion.
  test("filters out entries missing required fields, keeps well-formed ones", async () => {
    const stdout = JSON.stringify([
      { number: 1, title: "ok", createdAt: "2026-07-26T00:00:00Z" },
      { number: 2, title: "missing createdAt" },
      { title: "missing number", createdAt: "2026-07-26T00:00:00Z" },
    ]);
    const runner: CeremonyGhRunner = async () => ({ exitCode: 0, stdout });
    const result = await fetchOpenCeremonyFindings(runner, 1000);
    expect(result).toEqual([{ number: 1, title: "ok", createdAt: "2026-07-26T00:00:00Z" }]);
  });

  // The success path itself, for completeness against the failure cases above.
  test("exit 0 + well-formed array ⇒ the parsed issues", async () => {
    const stdout = JSON.stringify([{ number: 551, title: "8h dock/no-station stall", createdAt: "2026-07-26T12:37:00Z" }]);
    const runner: CeremonyGhRunner = async () => ({ exitCode: 0, stdout });
    const result = await fetchOpenCeremonyFindings(runner, 1000);
    expect(result).toEqual([{ number: 551, title: "8h dock/no-station stall", createdAt: "2026-07-26T12:37:00Z" }]);
  });
});

describe("formatAge", () => {
  test("under an hour ⇒ <1h", () => {
    expect(formatAge(new Date(Date.now() - 5 * 60_000).toISOString(), Date.now())).toBe("<1h");
  });
  test("hours, under 48h ⇒ Nh", () => {
    expect(formatAge(new Date(Date.now() - 5 * HOUR).toISOString(), Date.now())).toBe("5h");
  });
  test("48h or more ⇒ Nd", () => {
    expect(formatAge(new Date(Date.now() - 50 * HOUR).toISOString(), Date.now())).toBe("2d");
  });
});

describe("formatCeremonyBanner", () => {
  // Catches: printing an empty banner shell (headers with no findings) when
  // there is nothing to report — main must stay fully silent on zero.
  test("empty input ⇒ empty string (no banner at all)", () => {
    expect(formatCeremonyBanner([], CEREMONY_FINDINGS_CAP_DEFAULT, Date.now())).toBe("");
  });

  // Catches: listing in gh's arbitrary/default order instead of the
  // required newest-first read order.
  test("orders newest first regardless of input order", () => {
    const now = Date.now();
    const old = issue(1, 10 * HOUR, "older");
    const fresh = issue(2, 1 * HOUR, "fresher");
    const out = formatCeremonyBanner([old, fresh], 10, now);
    expect(out.indexOf("#2")).toBeLessThan(out.indexOf("#1"));
  });

  // Catches: silent truncation — dropping items past the cap without a
  // trace is worse than the flood it prevents, because it looks like
  // there's nothing more to see.
  test("beyond the cap: shows exactly `cap` items and states how many more exist", () => {
    const now = Date.now();
    const issues = Array.from({ length: 15 }, (_, i) => issue(100 + i, i * HOUR));
    const out = formatCeremonyBanner(issues, 12, now);
    const shownCount = issues.slice(0, 15).filter((i) => out.includes(`#${i.number}`)).length;
    expect(shownCount).toBe(12);
    expect(out).toContain("+3 more");
  });

  // Catches: a banner that blends into scrollback — the whole point of a
  // JIT re-injection is that it's visually distinct enough to be noticed.
  test("carries a visually distinct banner (not bare text)", () => {
    const out = formatCeremonyBanner([issue(1, HOUR)], 12, Date.now());
    expect(out).toContain("CEREMONY FINDINGS");
    expect(out).toMatch(/#{10,}/); // a border line of repeated '#'
  });

  test("at or under the cap: no truncation line", () => {
    const out = formatCeremonyBanner([issue(1, HOUR), issue(2, 2 * HOUR)], 12, Date.now());
    expect(out).not.toContain("more");
  });
});

// R1 (PR #29 review): this hook's FILING_REPO/MACHINE_LABEL are INLINED, not
// imported from src/scheduler/filing, because the hook must run standalone
// in the private backlog clone too (no src/scheduler there). That inlining
// creates a second copy of two literals that can silently drift from the
// canonical ones. Ablate: edit either inlined constant in
// .claude/hooks/session-start-ceremony-findings.ts to a different value —
// this goes red immediately, without touching filing.ts.
describe("hook constants stay in sync with src/scheduler/filing.ts", () => {
  test("FILING_REPO matches", () => {
    expect(HOOK_FILING_REPO).toBe(FILING_REPO);
  });
  test("MACHINE_LABEL matches", () => {
    expect(HOOK_MACHINE_LABEL).toBe(MACHINE_LABEL);
  });
});

// R1: the whole fix is dead unless this hook is actually REGISTERED as a
// SessionStart hook in THIS repo's own .claude/settings.json — an easy thing
// for a future settings.json edit to silently drop. Ablate: comment out or
// delete this hook's SessionStart entry in .claude/settings.json — red.
// (The companion registration in the private backlog clone's own
// .claude/settings.json is verified the same way in that repo's own test
// suite — a cross-repo assertion from here cannot see that file at all,
// least of all in CI, where the private clone does not exist on disk.)
describe("registered as a SessionStart hook in this repo's settings.json", () => {
  test("settings.json's SessionStart hooks include session-start-ceremony-findings.ts", () => {
    const settings = JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude", "settings.json"), "utf8"));
    const sessionStart: Array<{ hooks: Array<{ command: string }> }> = settings.hooks.SessionStart;
    const commands = sessionStart.flatMap((entry) => entry.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes("session-start-ceremony-findings.ts"))).toBe(true);
  });
});
