// Writes the `strategy_review` cursor marker AFTER a strategy-review run
// completes, so the next gate (scripts/strategy-review-gate.ts) counts only
// plans that arrive after this point. Run this only on a run that actually
// produced a report -- a skipped or crashed run must NOT advance the cursor.
//
// Remote use (from the charter, final step):
//   docker exec -i spacemolt-harness bun run scripts/strategy-review-mark.ts <agentId>
import { Database } from "bun:sqlite";
import { markReviewRan } from "../src/review/review-gate";

const agentId = process.argv[2] ?? "miner";
const path = process.env.HARNESS_DB ?? "/app/data/harness.sqlite";

const db = new Database(path);
markReviewRan(db, agentId, Date.now());
console.log(JSON.stringify({ marked: agentId, ts: Date.now() }));
