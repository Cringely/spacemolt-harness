// The weekly backlog dedupe ceremony's one tracker path (#1135, spec
// docs/superpowers/specs/2026-09-22-backlog-dedupe-ceremony.md). The spawned
// dedupe job (src/scheduler/jobs.ts) holds a grant for this script and no gh
// grant at all.
//
//   bun scripts/backlog-dedupe.ts candidates
//   bun scripts/backlog-dedupe.ts run [--semantic-b64 <base64 of a JSON array of {"member":N,"target":M}>]
//
// `candidates` is read-only in every mode: the semantic-pass gate and, when
// the pass is due, the issues the deterministic pass left unresolved, printed
// as JSON Lines (formatCandidates says why).
// `run` re-derives the clusters, applies the semantic pairs, and either posts
// (gates.json dedupePosting ON) or writes a local dry-run report (OFF, the
// default). No flag on this command can turn posting on. The switch lives in
// gates.json, which the spawned agent has no tool to write.
//
// The semantic pairs are model output, so they are untrusted input: a
// single-line base64 argv token (src/scheduler/body-arg.ts explains why argv),
// capped, shape-checked here, and then validated against the fresh fetch in
// clusterIssues before they can shape a proposal. Only issue numbers cross.
//
// Requires SCHEDULER_STATE_DIR. Exit codes: 0 ok (JSON on stdout), 1 gh or
// runtime failure (including posting ON with the labels missing), 2 usage or
// rejected input.
import { spawnSync } from "node:child_process";
import { BodyArgError, decodeBodyArg } from "../src/scheduler/body-arg";
import { dedupeCandidates, formatCandidates, runDedupe, type SemanticPair } from "../src/scheduler/dedupe";
import type { GhRunner } from "../src/scheduler/filing";

const MAX_PAIRS_BYTES = 16 * 1024;

function usage(msg: string): never {
  console.error(msg);
  console.error(
    'usage: bun scripts/backlog-dedupe.ts candidates | run [--semantic-b64 <base64 of [{"member":N,"target":M}]>]',
  );
  process.exit(2);
}

export function parseSemanticPairs(json: string): SemanticPair[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("semantic pairs are not valid JSON");
  }
  if (!Array.isArray(raw)) throw new Error("semantic pairs must be a JSON array");
  return raw.map((p, i) => {
    const member = (p as { member?: unknown })?.member;
    const target = (p as { target?: unknown })?.target;
    if (typeof member !== "number" || typeof target !== "number" || !Number.isInteger(member) || !Number.isInteger(target) || member < 1 || target < 1) {
      throw new Error(`semantic pair ${i} must be {"member": <issue number>, "target": <issue number>}`);
    }
    return { member, target };
  });
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "candidates" && command !== "run") usage(`unknown command: ${command ?? "(none)"}`);
  if (command === "candidates" && rest.length > 0) usage("candidates takes no arguments");
  let pairs: SemanticPair[] = [];
  if (command === "run" && rest.length > 0) {
    if (rest.length !== 2 || rest[0] !== "--semantic-b64") usage("run takes only --semantic-b64 <base64>");
    try {
      pairs = parseSemanticPairs(decodeBodyArg(rest[1]!, MAX_PAIRS_BYTES));
    } catch (e) {
      usage(e instanceof BodyArgError || e instanceof Error ? e.message : String(e));
    }
  }

  const stateDir = process.env.SCHEDULER_STATE_DIR;
  if (!stateDir) usage("SCHEDULER_STATE_DIR is not set");

  // The fetch carries every open issue's body, well past spawnSync's 1MB default buffer.
  const gh: GhRunner = (ghArgs) => {
    const res = spawnSync("gh", ghArgs, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    if (res.error) throw res.error;
    return { stdout: res.stdout ?? "", exitCode: res.status ?? 1 };
  };

  try {
    if (command === "candidates") for (const line of formatCandidates(dedupeCandidates(gh, { stateDir }))) console.log(line);
    else console.log(JSON.stringify(runDedupe(gh, { stateDir, now: Date.now(), semanticPairs: pairs })));
  } catch (e) {
    console.error(`backlog-dedupe failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
