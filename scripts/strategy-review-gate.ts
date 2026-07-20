// Deterministic step-0 precheck for the 6h strategy review
// (docs/charters/strategy-reviewer.md). Skips the LLM run when too few new
// plans happened since the last review -- see src/review/review-gate.ts.
//
// Remote use (from the charter): ssh the host, then
//   docker exec -i spacemolt-harness bun run scripts/strategy-review-gate.ts <agentId>
// Prints the gate verdict as JSON. Exit codes are DISTINCT so a caller never
// confuses "nothing to review" with "couldn't read the store":
//   0 = run the review, 1 = skip (too few new plans), 2 = ERROR (report loudly).
// The exit-2 case matters: an absent/unreadable store looks exactly like a
// healthy quiet pilot (L-21), so a crash must be a LOUD error, never a silent
// skip. Read-only handle: this only DECIDES; the marker is written post-run by
// scripts/strategy-review-mark.ts.
import { Database } from "bun:sqlite";
import { evaluateReviewGate } from "../src/review/review-gate";

const agentId = process.argv[2] ?? "miner";
const path = process.env.HARNESS_DB ?? "/app/data/harness.sqlite";

try {
  const db = new Database(path, { readonly: true });
  const gate = evaluateReviewGate(db, agentId);
  console.log(JSON.stringify(gate));
  process.exit(gate.run ? 0 : 1);
} catch (e) {
  console.error(JSON.stringify({ error: "store_unreadable", path, message: e instanceof Error ? e.message : String(e) }));
  process.exit(2);
}
