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
//         bun scripts/strategy-store.ts steer <agentId> --text-b64 <base64>
//   gate  -> exit 0 = run the review, 1 = skip, 2 = error (charter step 0)
//   mark  -> advance the review cursor (post-run bookkeeping)
//   dump  -> print the review dataset JSON (strategy-review-dump.ts)
//   steer -> queue an operator-instruction on the live pilot (#495)
//
// v3 (2026-07-27, #495): `steer` restores the sharpest adapt-lever for a
// headless job. The instruct channel (POST /api/agents/:id/instruct) never
// broke; what died at the A1 pivot was the scheduler's transport to it
// (`docker exec` across hosts, removed as arbitrary-command surface). Rather
// than issue the scheduler a SECOND credential -- the #173 dashboard token,
// which would grant every dashboard route to buy one call -- steer is a
// fourth op on the bearer the job already holds. It is the only op with a
// request BODY, so the text rides as a single base64 argv token
// (--text-b64), the same reason scripts/file-finding.ts takes --body-b64:
// the headless permission layer splits a Bash command on newlines and denies
// the fragments (src/scheduler/body-arg.ts has the full account).
//
// Security posture: op + agentId are validated locally before the request is
// built (fail fast); the server re-validates the same shape on the route
// (defense in depth, the trust boundary). The bearer comes from the
// STORE_BEARER environment variable -- populated by the scheduler's
// buildEnv() from jobs.ts's `extraSecrets: ["store_bearer"]`, i.e. read from
// a secret FILE and exported by the spawner, never passed as an argv token
// or hardcoded here.
import { BodyArgError, decodeBodyArg } from "../src/scheduler/body-arg";
import { INSTRUCTION_MAX_LENGTH, STORE_TOKEN_HEADER } from "../src/server/server";

export const STORE_OPS = ["gate", "mark", "dump", "steer"] as const;
export type StoreOp = (typeof STORE_OPS)[number];

/** The one op that carries a request body, and so the one that takes --text-b64. */
const TEXT_FLAG = "--text-b64";

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
 *
 * SM_STORE_URL is populated by the scheduler's spawn.ts buildEnv() from the
 * strategy job's `extraSecrets: [..., "sm_store_url"]` (#476) -- read from a
 * file under $SCHEDULER_SECRETS and exported as an env var, the SAME seam as
 * STORE_BEARER below. It is not set from a plain host env var, so the source is
 * defined and version-controlled (jobs.ts) rather than silently unset.
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

/**
 * Parse the steer text out of the trailing argv (`--text-b64 <base64>`) and
 * decode it. Throws StoreArgError (CLI maps to exit 2) on a missing flag, a
 * malformed token, or text outside the server's 1..INSTRUCTION_MAX_LENGTH
 * bound -- the bound is IMPORTED from the server, not copied, so the fail-fast
 * check here can never drift from the trust boundary that re-enforces it.
 *
 * A non-steer op carrying the flag is REJECTED rather than ignored: an agent
 * that typed `dump miner --text-b64 ...` meant to steer, and silently
 * dropping the text would report success for a correction that never landed.
 */
export function parseSteerText(op: StoreOp, rest: readonly string[]): string | undefined {
  if (op !== "steer") {
    if (rest.includes(TEXT_FLAG)) throw new StoreArgError(`${TEXT_FLAG} is only valid with the steer op`);
    return undefined;
  }
  if (rest[0] !== TEXT_FLAG || rest[1] === undefined) {
    throw new StoreArgError(`steer requires ${TEXT_FLAG} <base64 of the steer text>`);
  }
  let text: string;
  try {
    // Byte cap is the utf8 worst case (4 bytes/char) for the character bound
    // checked next; the character bound is the real gate and is the same
    // number the server's zod .max() enforces.
    text = decodeBodyArg(rest[1], INSTRUCTION_MAX_LENGTH * 4);
  } catch (e) {
    throw new StoreArgError(e instanceof BodyArgError ? e.message : `invalid ${TEXT_FLAG}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (text.length === 0 || text.length > INSTRUCTION_MAX_LENGTH) {
    throw new StoreArgError(`steer text must be 1..${INSTRUCTION_MAX_LENGTH} characters (got ${text.length})`);
  }
  return text;
}

/**
 * Build the request shape for an op. Exported for the offline arg-shape test (no fetch).
 * `body` is present ONLY for steer -- the three data ops keep the exact
 * two-key shape they had before #495, so nothing about their request changed.
 */
export function buildStoreRequest(
  baseUrl: string, op: StoreOp, agentId: string, text?: string,
): { url: string; method: "GET" | "POST"; body?: string } {
  const url = `${baseUrl}/api/store/${encodeURIComponent(agentId)}/${op}`;
  if (op === "steer") {
    if (text === undefined) throw new StoreArgError(`steer requires ${TEXT_FLAG} <base64 of the steer text>`);
    return { url, method: "POST", body: JSON.stringify({ text }) };
  }
  return { url, method: op === "mark" ? "POST" : "GET" };
}

if (import.meta.main) {
  try {
    const { op, agentId } = validateStoreArgs(process.argv[2], process.argv[3]);
    const steerText = parseSteerText(op, process.argv.slice(4));
    const baseUrl = resolveBaseUrl();
    const token = resolveBearerToken();
    const { url, method, body } = buildStoreRequest(baseUrl, op, agentId, steerText);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined
          ? { [STORE_TOKEN_HEADER]: token }
          : { [STORE_TOKEN_HEADER]: token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });
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
    // A steer succeeds with 204 and an EMPTY body, so echoing the response
    // would print a blank line and read as a silent no-op. Say what actually
    // happened instead, and say it honestly: the instruction is queued on the
    // pilot's inbox, which it consumes at its next replan -- not applied yet,
    // and there is nothing to read back to confirm it (the agent view never
    // exposes inbox contents).
    console.log(op === "steer" ? `steer accepted: queued on ${agentId}, consumed at its next replan` : text);

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
