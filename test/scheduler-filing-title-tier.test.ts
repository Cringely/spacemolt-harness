// #1133: the filer's title tier. Every key tier compares wording a headless
// spawn invented, so two runs that describe one defect in different words, or
// a finding that duplicates an operator-authored issue (no key at all), used to
// open a new issue. fileFinding now checks the finding's title against the open
// backlog through the dedupe ceremony's own isNearDuplicateTitle before it
// creates anything.
//
// Titles and keys below are real, read from the tracker's 2026-09-22 open
// backlog, except where a test says a title is constructed.
//
// Offline: fake gh runner, temp state dirs, zero live gh, zero tokens.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config";
import { isNearDuplicateTitle, titleToSegments } from "../src/scheduler/dedupe";
import { fileFailureAlarm } from "../src/scheduler/failure-alarm";
import {
  FILING_LOG_FILE,
  FLEET_PILOT_IDS,
  SUPPRESSION_NOTICE_KEY,
  TITLE_BUMP_NOTE,
  fileFinding,
  isNearDuplicate,
  type FilingLogEntry,
  type GhResult,
  type GhRunner,
} from "../src/scheduler/filing";

const tmp = () => mkdtempSync(join(tmpdir(), "filing-title-"));

interface OpenIssue {
  number: number;
  title: string;
  body: string;
  machine: boolean;
}

interface GhCall {
  args: string[];
  body?: string;
}

const marked = (key: string, text = "finding text") => `${text}\n\n<!-- sm-dedup:${key} -->\nfiled-by: scheduler/standup cycle old\n`;

// Answers each `issue list` by its signature: `--state closed` is the consumer
// probe, `--search` the exact-key tier, `--label` the tier-3 key scan (machine-
// filed rows only), and anything else the title tier's whole-backlog read.
function backlogGh(open: OpenIssue[], opts: { exact?: OpenIssue; titleList?: GhResult } = {}) {
  const calls: GhCall[] = [];
  let next = 2000;
  const gh: GhRunner = (args) => {
    const bodyIdx = args.indexOf("--body-file");
    const body = bodyIdx >= 0 ? readFileSync(args[bodyIdx + 1]!, "utf8") : undefined;
    calls.push({ args, body });
    if (args[0] === "issue" && args[1] === "list") {
      const state = args[args.indexOf("--state") + 1];
      if (state === "closed") return { stdout: JSON.stringify([{ number: 1, closedAt: new Date(Date.now() - 86_400_000).toISOString() }]), exitCode: 0 };
      if (args.includes("--search")) {
        const hit = opts.exact ? [{ number: opts.exact.number, state: "OPEN", closedAt: null, body: opts.exact.body }] : [];
        return { stdout: JSON.stringify(hit), exitCode: 0 };
      }
      if (args.includes("--label")) {
        return { stdout: JSON.stringify(open.filter((i) => i.machine).map(({ number, body }) => ({ number, body }))), exitCode: 0 };
      }
      return opts.titleList ?? { stdout: JSON.stringify(open.map(({ number, title, body }) => ({ number, title, body }))), exitCode: 0 };
    }
    if (args[0] === "issue" && args[1] === "create") return { stdout: `https://github.com/x/y/issues/${next++}\n`, exitCode: 0 };
    return { stdout: "", exitCode: 0 };
  };
  return { gh, calls };
}

const isTitleRead = (c: GhCall) => c.args[1] === "list" && c.args[c.args.indexOf("--json") + 1] === "number,title,body";
const logLines = (dir: string): FilingLogEntry[] =>
  readFileSync(join(dir, FILING_LOG_FILE), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FilingLogEntry);

// #1014 and #1022: one Corsair battle lockout, filed twice under keys that
// share 3 of 7 segments, so neither key tier can see the pair.
const CORSAIR_OPEN: OpenIssue = {
  number: 1014,
  title: "corsair: unresolved in_battle deadlock -- 26 blocked actions + 2 attack timeouts, ~4h flat",
  body: marked("corsair-in-battle-deadlock-unresolved"),
  machine: true,
};
const CORSAIR_ARRIVAL = {
  jobId: "standup",
  cycleId: "standup-1789000000000",
  dedupKey: "corsair-in-battle-no-flee-lever",
  title: "corsair in_battle deadlock escalating: 65 blocks, 15 attack timeouts, 7.6h flat",
  body: "65 in_battle blocks and 15 attack timeouts this window.",
};

describe("title tier in fileFinding (#1133)", () => {
  // Catches: the defect itself, a reworded re-report opening its own issue.
  // The key precondition is asserted first so this test cannot pass through a
  // key tier. The comment is compared EXACTLY, not with toContain: a substring
  // check stays green if the heading, the note, or the marker line is dropped,
  // and "nothing lost, only redirected" is the whole bar for a title bump.
  // Ablation performed: made findTitleMatch return { fetch: "ok" } without
  // scanning; outcome went "created" and this test went red.
  test("a reworded finding bumps the open issue whose title it matches, carrying its full text", () => {
    expect(isNearDuplicate(CORSAIR_OPEN.body.match(/sm-dedup:(\S+) /)![1]!, CORSAIR_ARRIVAL.dedupKey)).toBe(false);
    const dir = tmp();
    const { gh, calls } = backlogGh([CORSAIR_OPEN]);
    const res = fileFinding(gh, dir, CORSAIR_ARRIVAL);
    expect(res).toEqual({ outcome: "bumped", issue: 1014 });
    expect(calls.filter((c) => c.args[1] === "create").length).toBe(0);
    const comment = calls.find((c) => c.args[1] === "comment")!;
    expect(comment.args[2]).toBe("1014");
    const findingText = `${CORSAIR_ARRIVAL.body}\n\n<!-- sm-dedup:${CORSAIR_ARRIVAL.dedupKey} -->\nfiled-by: scheduler/standup cycle ${CORSAIR_ARRIVAL.cycleId}\n`;
    expect(comment.body).toBe([`## ${CORSAIR_ARRIVAL.title}`, "", TITLE_BUMP_NOTE, "", findingText].join("\n"));
    expect(logLines(dir)[0]!.titleMatch).toBe("ok");
  });

  // Catches: a title tier that reads only machine-filed or marker-bearing
  // issues, which is how the key tiers work and exactly why an operator-
  // authored issue was invisible to them. #703 is real and operator-authored.
  // The arriving title is CONSTRUCTED as a plausible ceremony re-report.
  // Ablation performed: made findTitleMatch skip rows with no dedup marker;
  // this test went red while the Corsair test above stayed green.
  test("an operator-authored issue with no key and no machine-filed label is a bump target", () => {
    const operator: OpenIssue = {
      number: 703,
      title: "corsair soft-locked: detained for a 27cr bounty it cannot pay, and the fleet has no way to send it credits",
      body: "Written by hand. No dedup marker.",
      machine: false,
    };
    const dir = tmp();
    const { gh } = backlogGh([operator]);
    const res = fileFinding(gh, dir, {
      ...CORSAIR_ARRIVAL,
      dedupKey: "corsair-detained-bounty-unpaid",
      title: "Corsair still soft-locked: detained for a 27cr bounty it cannot pay, no way to send it credits",
    });
    expect(res).toEqual({ outcome: "bumped", issue: 703 });
  });

  // Catches: the PR #40 into PR #83 merge, at the filer. The two titles reduce
  // to IDENTICAL segments, so only the entity gate can refuse the pair. #707 is
  // real. The PR #40 title is CONSTRUCTED from it.
  // Ablation performed: deleted the titleAnchorsConflict check from
  // preparedTitlesMatch (dedupe.ts); outcome went "bumped" into #707.
  test("a title naming a different PR number files fresh, however identical the wording", () => {
    const pr83: OpenIssue = { number: 707, title: "PR #83 red CI blocking merge (doc-size + test, 9h)", body: marked("red-pr-unfixed-9h"), machine: true };
    const pr40Title = "PR #40 red CI blocking merge (doc-size + test, 9h)";
    expect(titleToSegments(pr40Title)).toEqual(titleToSegments(pr83.title));
    const dir = tmp();
    const { gh } = backlogGh([pr83]);
    const res = fileFinding(gh, dir, { ...CORSAIR_ARRIVAL, dedupKey: "pr-40-red-ci-merge", title: pr40Title });
    expect(res.outcome).toBe("created");
    expect(res.issue).not.toBe(707);
  });

  // Catches: one defect on two pilots, two actions or two jobs merged into one
  // issue. #1133 calls those related, not duplicates, and the ceremony's bar
  // matches every such twin (replayed: 139 of 139 pilot swaps, 93 of 93
  // action swaps, 98 of 98 job swaps over the snapshot). Open titles are real
  // (#991, #1076, #765). Arrivals are CONSTRUCTED by swapping one word.
  // Blind spot: "created" is also what a skipped or failed scan returns, and
  // what a pair that never scored similar returns. So each case first asserts
  // the ceremony DOES match the pair, and then that the scan ran ("ok").
  // Ablation performed: dropped the titlesNameDifferentEntities call from
  // findTitleMatch, and the pilot case bumped #991. Then removed each word
  // list from TITLE_ENTITY_WORDS in turn (pilots, actions, jobs). Each removal
  // went red at its own case, with every earlier case still passing.
  test("a title naming a different pilot, action or job files fresh, however identical the wording", () => {
    const cases: Array<[OpenIssue, string]> = [
      [
        { number: 991, title: "Miner: withdraw 100% broken (49/49 lifetime, 3/3 window) - no storage guard", body: marked("miner-withdraw-broken"), machine: true },
        "Scout: withdraw 100% broken (49/49 lifetime, 3/3 window) - no storage guard",
      ],
      [
        { number: 1076, title: "Miner: craft blocked 98x/72h -- planner attempts craft before depositing inputs", body: marked("miner-craft-blocked"), machine: true },
        "Miner: recycle blocked 98x/72h -- planner attempts recycle before depositing inputs",
      ],
      [
        { number: 765, title: "scheduler: council ceremony run failed", body: marked("scheduler-council-fail"), machine: true },
        "scheduler: strategy ceremony run failed",
      ],
    ];
    for (const [open, title] of cases) {
      expect(isNearDuplicateTitle(open.title, title)).toBe(true);
      const dir = tmp();
      const { gh, calls } = backlogGh([open]);
      const res = fileFinding(gh, dir, { ...CORSAIR_ARRIVAL, dedupKey: "twin-finding", title });
      expect(res.outcome).toBe("created");
      expect(calls.some((c) => c.args[1] === "comment")).toBe(false);
      expect(logLines(dir)[0]!.titleMatch).toBe("ok");
    }
  });

  // Catches: a pilot added to the fleet but not to FLEET_PILOT_IDS, whose
  // findings would then merge into another pilot's issue. The scheduler never
  // loads agents.yaml, so the committed example is the roster this can check.
  // Sorted both sides: toEqual on arrays is order-sensitive, and order carries
  // no meaning here.
  // Ablation performed: removed "corsair" from FLEET_PILOT_IDS; this went red.
  test("the pilot list the title tier vetoes on is the fleet agents.example.yaml defines", () => {
    const roster = loadConfig(join(import.meta.dir, "..", "agents.example.yaml")).agents.map((a) => a.id);
    expect([...FLEET_PILOT_IDS].sort() as string[]).toEqual([...roster].sort());
  });

  // Catches: the suppression notice's contract ("created once and never
  // commented on again") broken through the new route. #1031 is the real
  // notice. The arriving title is CONSTRUCTED to match it.
  // Ablation performed: deleted the notice guard in findTitleMatch; the
  // finding was bumped onto #1031.
  test("the suppression notice is never a title-tier target", () => {
    const notice: OpenIssue = {
      number: 1031,
      title: "scheduler: new-issue filing is suppressed — no one is consuming the backlog",
      body: `Notice text.\n\n<!-- sm-dedup:${SUPPRESSION_NOTICE_KEY} -->`,
      machine: true,
    };
    const dir = tmp();
    const { gh, calls } = backlogGh([notice]);
    const res = fileFinding(gh, dir, {
      ...CORSAIR_ARRIVAL,
      dedupKey: "filing-suppressed-no-consumer",
      title: "scheduler: new-issue filing suppressed, no one consuming the backlog",
    });
    expect(res.outcome).toBe("created");
    expect(calls.some((c) => c.args[1] === "comment")).toBe(false);
  });

  // Catches: the minted-key home losing to a title match. The exact-key tier
  // must still decide first, and the backlog read must not even happen.
  // Ablation performed: moved the title scan ahead of the key tiers; the
  // finding bumped #1014 instead of its key home #1200.
  test("an exact-key match still wins, and the title read is never made", () => {
    const keyHome: OpenIssue = { number: 1200, title: "unrelated wording", body: marked(CORSAIR_ARRIVAL.dedupKey), machine: true };
    const dir = tmp();
    const { gh, calls } = backlogGh([CORSAIR_OPEN, keyHome], { exact: keyHome });
    expect(fileFinding(gh, dir, CORSAIR_ARRIVAL)).toEqual({ outcome: "bumped", issue: 1200 });
    expect(calls.filter(isTitleRead).length).toBe(0);
    expect(logLines(dir)[0]!.titleMatch).toBe("skipped");
  });

  // Catches: a backlog read that fails taking the finding down with it. The
  // required fallback is today's behaviour (file by key), never a skip. Two
  // shapes: gh exits non-zero, which run() turns into a throw, and gh answers
  // with something that is not a JSON array. Blind spot: the outcome is
  // "created" whether the scan failed or found nothing, so the log line is
  // what tells the two apart, and it is asserted.
  // Ablation performed: removed the try/catch in findTitleMatch; the exit-code
  // case threw out of fileFinding. Returning "ok" for a non-array turned the
  // log assertion red.
  test("an unreadable backlog files the finding as before and records the scan as unreadable", () => {
    for (const titleList of [
      { stdout: "gh: rate limited", exitCode: 1 },
      { stdout: JSON.stringify("oops"), exitCode: 0 },
    ]) {
      const dir = tmp();
      const { gh, calls } = backlogGh([CORSAIR_OPEN], { titleList });
      expect(fileFinding(gh, dir, CORSAIR_ARRIVAL).outcome).toBe("created");
      expect(calls.filter((c) => c.args[1] === "create").length).toBe(1);
      expect(logLines(dir)[0]!.titleMatch).toBe("unreadable");
    }
  });

  // Catches: the failure alarm reaching the title tier at all. Its contract is
  // one issue per job under a code-minted key, so the key tiers are its whole
  // dedup. At the ceremony's bar the "strategy" and "standup" alarms title-
  // match the "council" alarm (2026-09-22 snapshot). #765 is the real council
  // alarm.
  // Ablation performed: removed skipTitleMatch from fileFailureAlarm. Before
  // the job-id veto the strategy failure bumped #765. With the veto it files
  // fresh anyway, so the title-read assertion is the one that goes red.
  test("a strategy failure alarm files its own issue rather than landing on the council alarm", () => {
    const council: OpenIssue = { number: 765, title: "scheduler: council ceremony run failed", body: marked("scheduler-council-fail"), machine: true };
    const dir = tmp();
    const { gh, calls } = backlogGh([council]);
    fileFailureAlarm(gh, dir, { jobId: "strategy", cycleId: "strategy-1", failStreak: 1, timedOut: false, exitCode: 1 });
    const create = calls.find((c) => c.args[1] === "create");
    expect(create?.args[create.args.indexOf("--title") + 1]).toBe("scheduler: strategy ceremony run failed");
    expect(calls.some((c) => c.args[1] === "comment")).toBe(false);
    expect(calls.filter(isTitleRead).length).toBe(0);
  });
});
