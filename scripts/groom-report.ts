// Read-only grooming report over the machine-filed backlog.
//
// The producer fix (src/scheduler/filing.ts, tier 3) stops the NEXT duplicate
// from being created. It cannot touch the 170 already sitting in the backlog,
// and nineteen open issues for one red CI do not un-file themselves. This is
// the consumer half: the same clustering functions, run over what is already
// there, printed for a human to act on.
//
//   bun scripts/groom-report.ts
//
// It REPORTS. It does not close an issue, does not apply a label, and does not
// comment. Applying `duplicate` stays a human action (or one dispatched agent
// working from this output), for one reason worth stating plainly: this script
// reads ~400 untrusted issue bodies, and a standing job that both reads them
// and holds a write verb is a prompt-injection surface with a local precedent —
// the game's own error text acted as instruction on the pilot and locked ~21,800
// credits. A reporter has no verb to hijack.
//
// There is also no cron entry and no scheduler job by design. The backlog is a
// finite pile that converges in days and then idles; a standing 12h ceremony to
// re-report an empty set would cost three JobId type seams, a charter, a gate
// field and a jailed script for that idling. Run it when the backlog looks
// duplicated.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FILING_REPO, MACHINE_LABEL, isNearDuplicate, readDedupKey } from "../src/scheduler/filing";

/** Same ceiling as the filer's near-match scan; a full page means truncation. */
const FETCH_LIMIT = 400;

export interface GroomItem {
  number: number;
  key: string;
  title: string;
}

export interface Cluster {
  /** Suggested survivor: the OLDEST issue, where the conversation started. */
  canonical: GroomItem;
  /** Every member, newest first. Includes the canonical. */
  members: GroomItem[];
}

/**
 * Group items by the producer's own near-duplicate rule, transitively: A~B and
 * B~C put all three in one cluster even when A and C do not pair directly.
 * That transitivity is doing real work on the live data — the ten STATE.md
 * staleness keys chain together through intermediate wordings rather than all
 * matching each other.
 *
 * Returned newest-first (by the newest issue in each cluster), singletons
 * dropped: a cluster of one is not a duplicate.
 */
export function clusterItems(items: GroomItem[]): Cluster[] {
  const parent = items.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (!isNearDuplicate(items[i]!.key, items[j]!.key)) continue;
      const [ri, rj] = [find(i), find(j)];
      if (ri !== rj) parent[ri] = rj;
    }
  }
  const groups = new Map<number, GroomItem[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(items[i]!);
    groups.set(root, g);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const members = [...g].sort((a, b) => b.number - a.number);
      return { canonical: members[members.length - 1]!, members };
    })
    .sort((a, b) => b.members[0]!.number - a.members[0]!.number);
}

/**
 * Clusters not present in the previous run, identified by canonical issue —
 * the survivor is stable as a cluster grows, so a cluster that merely gained a
 * new duplicate is not a new cluster.
 */
export function newCanonicals(clusters: Cluster[], seen: readonly number[]): number[] {
  const before = new Set(seen);
  return clusters.map((c) => c.canonical.number).filter((n) => !before.has(n));
}

function loadSeen(file: string): number[] {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return []; // missing/corrupt → treat every cluster as new, same tolerance as the state files
  }
}

function main(): void {
  // Beside the scheduler's other state when run on the scheduler host; a stable
  // per-host temp path otherwise, so a workstation run still has a "last run"
  // to compare against without writing into the repo.
  const seenFile = process.env.SCHEDULER_STATE_DIR
    ? join(process.env.SCHEDULER_STATE_DIR, "groom-report-seen.json")
    : join(tmpdir(), "spacemolt-groom-report-seen.json");

  const res = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--label", MACHINE_LABEL, "--limit", String(FETCH_LIMIT),
     "--json", "number,title,body", "--repo", FILING_REPO],
    { encoding: "utf8" },
  );
  if (res.error) throw res.error;
  if ((res.status ?? 1) !== 0) {
    console.error(`gh issue list failed (exit ${res.status}): ${(res.stderr ?? "").slice(0, 300)}`);
    process.exit(1);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(res.stdout ?? "");
  } catch {
    console.error("gh returned an unparseable issue list");
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error("gh returned an unparseable issue list");
    process.exit(1);
  }
  const issues = raw as Array<{ number: number; title?: string; body?: string }>;

  const items: GroomItem[] = [];
  for (const i of issues) {
    const key = typeof i.body === "string" ? readDedupKey(i.body) : undefined;
    if (key !== undefined) items.push({ number: i.number, key, title: i.title ?? "" });
  }

  const clusters = clusterItems(items);
  const collapsible = clusters.reduce((n, c) => n + c.members.length - 1, 0);

  console.log(`repo ${FILING_REPO} — ${issues.length} open ${MACHINE_LABEL}, ${items.length} carrying a dedup key`);
  if (issues.length >= FETCH_LIMIT) {
    console.log(`WARNING: fetch hit the ${FETCH_LIMIT} ceiling — this report is over a TRUNCATED backlog`);
  }
  console.log(`${clusters.length} duplicate clusters, ${collapsible} issues collapsible\n`);

  for (const c of clusters) {
    console.log(`CLUSTER (${c.members.length}) — suggested canonical #${c.canonical.number} (${c.canonical.key})`);
    for (const m of c.members) {
      const mark = m.number === c.canonical.number ? "keep" : "dup ";
      console.log(`  ${mark} #${m.number}  ${m.key}  |  ${m.title.slice(0, 70)}`);
    }
    console.log("");
  }

  const fresh = newCanonicals(clusters, loadSeen(seenFile));
  console.log(`${fresh.length} clusters formed since the last run (state: ${seenFile})`);
  mkdirSync(dirname(seenFile), { recursive: true });
  writeFileSync(seenFile, JSON.stringify(clusters.map((c) => c.canonical.number)));
}

if (import.meta.main) main();
