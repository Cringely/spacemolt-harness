// Scheduler-side thin caller for the strategy-review store (#114 A1).
//
// The durable scheduler runs on the scheduler host; the harness store lives
// inside the `spacemolt-harness` container on a different host. This script is
// the ONLY store transport the strategy job is granted (jobs.ts allowedTools:
// `Bash(bun scripts/strategy-store.ts *)`).
//
// v2 (2026-07-19, #114 A1 pivot): the operator rejected the original design
// (SSH under a forced-command key whose authorized_keys entry effectively put
// a root-equivalent credential on the store host). This version calls
// three authenticated HTTP routes on the harness's OWN web server instead
// (src/server/server.ts /api/store/:agentId/{dump,gate,mark}) -- no SSH, no
// key on the host, no docker-exec across hosts. The routes carry their own
// bearer auth, structurally separate from the dashboard's #173 token.
//
// Usage:  bun scripts/strategy-store.ts <gate|mark|dump> <agentId>
//   gate  -> exit 0 = run the review, 1 = skip, 2 = error (charter step 0)
//   mark  -> advance the review cursor (post-run bookkeeping)
//   dump  -> print the review dataset JSON (strategy-review-dump.ts)
//
// Security posture: op + agentId are validated locally before the request is
// built (fail fast); the server re-validates the same shape on the route
// (defense in depth, the trust boundary). The bearer comes from the
// STORE_BEARER environment variable -- populated by the scheduler's
// buildEnv() from jobs.ts's `extraSecrets: ["store_bearer"]`, i.e. read from
// a secret FILE and exported by the spawner, never passed as an argv token
// or hardcoded here.
import { STORE_TOKEN_HEADER } from "../src/server/server";

export const STORE_OPS = ["gate", "mark", "dump"] as const;
export type StoreOp = (typeof STORE_OPS)[number];

// Same character class the server-side route enforces (src/server/server.ts
// STORE_AGENT_ID_RE). Kept in sync deliberately: the client rejects early
// with a clear message, the server rejects again as the trust boundary.
const AGENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class StoreArgError extends Error {}

/** Validate the op + agentId. Throws StoreArgError (CLI maps to exit 2). */
export function validateStoreArgs(op: string | undefined, agentId: string | undefined): { op: StoreOp; agentId: string } {
  if (op === undefined || !(STORE_OPS as readonly string[]).includes(op)) {
    throw new StoreArgError(`op must be one of ${STORE_OPS.join("|")} (got ${op === undefined ? "nothing" : `'${op}'`})`);
  }
  if (agentId === undefined || !AGENT_ID_RE.test(agentId)) {
    throw new StoreArgError("agentId must match ^[A-Za-z0-9._-]{1,64}$");
  }
  return { op: op as StoreOp, agentId };
}

/**
 * Resolve the harness's base URL from the environment. Required, no guessed
 * default -- the scheduler and the harness live on different hosts and the correct
 * reachable address (proto/host/port) is a deploy-time fact, not something
 * safe to assume here. Throws StoreArgError when unset.
 */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SM_STORE_URL && env.SM_STORE_URL.trim() !== "") return env.SM_STORE_URL.trim().replace(/\/+$/, "");
  throw new StoreArgError("no store URL: set SM_STORE_URL to the harness's base URL (e.g. http://10.0.x.x:8642)");
}

/**
 * Resolve the bearer token. STORE_BEARER is populated by the scheduler's
 * spawn.ts buildEnv() from the job's `extraSecrets: ["store_bearer"]` --
 * read from a secret file, exported as an env var, never an argv token.
 */
export function resolveBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env.STORE_BEARER && env.STORE_BEARER.trim() !== "") return env.STORE_BEARER;
  throw new StoreArgError("no store bearer: STORE_BEARER env var not set (see jobs.ts extraSecrets: store_bearer)");
}

/** Build the request shape for an op. Exported for the offline arg-shape test (no fetch). */
export function buildStoreRequest(baseUrl: string, op: StoreOp, agentId: string): { url: string; method: "GET" | "POST" } {
  return { url: `${baseUrl}/api/store/${encodeURIComponent(agentId)}/${op}`, method: op === "mark" ? "POST" : "GET" };
}

if (import.meta.main) {
  try {
    const { op, agentId } = validateStoreArgs(process.argv[2], process.argv[3]);
    const baseUrl = resolveBaseUrl();
    const token = resolveBearerToken();
    const { url, method } = buildStoreRequest(baseUrl, op, agentId);

    let res: Response;
    try {
      res = await fetch(url, { method, headers: { [STORE_TOKEN_HEADER]: token } });
    } catch (e) {
      // Network-level failure (host unreachable, DNS, TLS) degrades LOUDLY --
      // never silently treated as a skip. An absent/unreachable store looks
      // exactly like a healthy quiet pilot (L-21) and must not be allowed to.
      console.error(`strategy-store: request failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }

    const text = await res.text();
    if (!res.ok) {
      console.error(`strategy-store: ${res.status} ${text}`);
      process.exit(2);
    }
    console.log(text);

    if (op === "gate") {
      let parsed: { run?: unknown };
      try {
        parsed = JSON.parse(text) as { run?: unknown };
      } catch {
        console.error("strategy-store: gate response was not valid JSON");
        process.exit(2);
      }
      process.exit(parsed.run === true ? 0 : 1);
    }
    process.exit(0);
  } catch (e) {
    if (e instanceof StoreArgError) {
      console.error(`strategy-store: ${e.message}`);
      process.exit(2);
    }
    console.error(`strategy-store: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
