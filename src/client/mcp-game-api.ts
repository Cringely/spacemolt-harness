// McpGameApi — a GameApi over the MCP transport (improv-mode plan Batch B).
//
// The whole thesis of improv mode is "swap the pilot, keep the safety net." The
// safety net (no-progress detector, steward, effect-verification, wake/reflex,
// the dashboard) is written against the GameApi interface (src/client/client.ts):
// it consumes StatusSnapshot / SystemInfo / V2Result. This adapter presents that
// SAME interface over the MCP transport (src/client/mcp.ts) + the text-dashboard
// parser (src/client/mcp-text-parser.ts), so every deterministic backstop runs
// UNCHANGED when the model is driving. Nothing in the backstops knows or cares
// whether the bytes came from our HTTP `/api/v2` or the game's MCP endpoint.
//
// Three shape divergences from the HTTP client, all forced by Batch 0 (§5a):
//
//  1. Reads are TEXT DASHBOARDS, not structured JSON. `status()`/`getSystem()`
//     run the dashboard through the text parser; `structuredContent` is always
//     undefined on this path (there is none). The one HTTP consumer that Zod-parsed
//     structuredContent — `find_route`'s route array in executor.ts — belongs to
//     the plan-then-execute PILOT, which runs over HTTP. The improv pilot (Batch C)
//     reads text and issues single actions, so it needs no structuredContent.
//
//  2. `action()` THROWS on a game error, mirroring SpacemoltHttp. The transport
//     deliberately RETURNS a benign game error (e.g. "no_resources") as
//     `isError:true` so a caller can react; but the GameApi contract the executor
//     and reflex/steward paths depend on is HTTP's — `api.action()` throws a
//     SpacemoltError on a game error, and executor.ts's `catch → classifyGameError`
//     turns the message text into a blocked/wait outcome. So this adapter converts
//     `isError` back into a thrown SpacemoltError whose message is the full error
//     text, which is exactly what classifyGameError's transient-marker match needs.
//
//  3. Two StatusSnapshot dimensions the MCP text cannot supply (the missing-
//     dimension decision — see docs/decisions.md 2026-07-12 Batch B):
//       - system_id: SOURCED. The get_status header names the system but drops its
//         machine id; get_system's header carries it. status() best-effort-sources
//         the id from a get_system query (free/unlimited) and merges it, so the
//         improv StatusSnapshot reaches parity with HTTP on this dimension. On any
//         failure the id stays null — a degrade, never a misread.
//       - lifetime stats counters (ore_mined, credits_earned, ...): DARK. The MCP
//         text does not render the stats block at ALL, and there is no other query
//         that returns it, so it is genuinely unsourceable over MCP. Left undefined.
//         The no-progress detector + steward + progress-heartbeat all SUPPRESS/skip
//         when stats is undefined (confirmed in agent.ts / no-progress-detector.ts),
//         so a dark counter dimension can never be misread as progress OR no-progress
//         — it fails safe. This is the acknowledged Batch D/E concern: the long-window
//         multi-dimensional progress judge is inert under improv; the short-window
//         game-state fingerprint (fuel/credits/cargo/dockedAt) is Batch D's improv
//         stuck backstop.

import { getAction } from "../registry/actions";
import { SpacemoltError, type EnvelopeNotification, type V2Result } from "./http";
import type { GameApi, StatusSnapshot, SystemInfo } from "./client";
import type { SpacemoltMcp } from "./mcp";
import { parseStatusText, parseSystemText } from "./mcp-text-parser";

/** Pull a game error code out of the transport's error text, e.g.
 * "Error: no_resources: Nothing to mine here" -> "no_resources". Falls back to
 * "game_error" when the text carries no `code:` prefix (a bare human message).
 * The CODE is best-effort; the load-bearing part is the message (below), which
 * classifyGameError matches against for transient-vs-terminal. */
function parseGameErrorCode(text: string): string {
  // Game error codes are lowercase snake_case ("no_resources", "session_expired").
  // NOT case-insensitive on purpose: with an `i` flag the leading "Error:" prefix
  // (or any capitalized human sentence like "Your ship is mid-jump...") would be
  // matched as the code. Lowercase-only means the "Error: " prefix is skipped and
  // a human message with no lowercase `code:` prefix falls through to "game_error"
  // (the desired outcome — the message text still carries the real signal).
  const m = text.match(/(?:^|Error:\s*)([a-z][a-z0-9_]*):/);
  return m ? m[1]! : "game_error";
}

export class McpGameApi implements GameApi {
  constructor(private mcp: SpacemoltMcp) {}

  /**
   * Run a registry action over MCP. Resolves the action through the registry —
   * the SAME `getAction`/`params.safeParse` the HTTP client uses (SSOT) — so the
   * registry allowlist and param validation are identical on both paths (this is
   * the hard backstop the improv injection defense leans on: the model can only
   * trigger a curated verb with validated params). A game error (`isError`) is
   * re-thrown as a SpacemoltError carrying the full error text, matching the HTTP
   * contract every deterministic consumer already depends on.
   */
  async action(name: string, params: Record<string, unknown> = {}): Promise<V2Result> {
    const def = getAction(name); // throws on an unknown action = registry allowlist
    const parsed = def.params.safeParse(params);
    if (!parsed.success) {
      throw new SpacemoltError("invalid_params", `${name}: ${parsed.error.message}`);
    }
    const r = await this.mcp.call(def.tool, def.name, parsed.data as Record<string, unknown>);
    if (r.isError) {
      const text = r.text ?? "game error";
      throw new SpacemoltError(parseGameErrorCode(text), text, r.raw);
    }
    // structuredContent intentionally omitted (undefined): MCP reads are text
    // dashboards with no structuredContent (Batch 0 §5a). notifications are the
    // ones the transport lifted from an enveloped result (empty for a bare text
    // dashboard).
    return { result: r.text ?? undefined, notifications: r.notifications };
  }

  /**
   * StatusSnapshot for the backstops. Runs get_status through the text parser and
   * best-effort-sources the machine system_id from get_system (the get_status
   * header carries only the system NAME). Both are free/unlimited queries, fired
   * concurrently so sourcing the id costs latency, not a serial round trip. A
   * get_system failure leaves systemId null — the parser's own default — so the
   * snapshot degrades rather than misreads.
   */
  async status(): Promise<StatusSnapshot> {
    const [statusRes, systemId] = await Promise.all([
      this.action("get_status"),
      this.sourceSystemId(),
    ]);
    const snap = parseStatusText(statusRes.result);
    if (systemId) snap.systemId = systemId;
    return snap;
  }

  /** Best-effort machine system_id from get_system, for the status() merge above.
   * Any failure (query error, unparseable header) yields null — the fingerprint,
   * travel awareness, and dashboard all tolerate a null systemId; none treats it
   * as progress or no-progress. See the missing-dimension note at the top. */
  private async sourceSystemId(): Promise<string | null> {
    try {
      return (await this.getSystem()).id;
    } catch {
      return null;
    }
  }

  async getSystem(): Promise<SystemInfo> {
    const res = await this.action("get_system");
    return parseSystemText(res.result);
  }

  /**
   * Structured notifications are DARK on the MCP read path. get_notifications
   * returns a human text dashboard (Batch 0 fixture: "No notifications."), not the
   * structured envelope feed the HTTP client parses, and we do NOT speculatively
   * parse a populated notifications dashboard we have never captured (the
   * no-guessed-shapes rule). Returning [] is the honest answer: under improv the
   * model reads raw game text for chat/combat, and action results still surface any
   * enveloped notifications via the transport. Wiring a richer notifications source
   * (if one is ever needed) is a Batch C/D concern, captured against a real shape.
   */
  async notifications(): Promise<EnvelopeNotification[]> {
    return [];
  }

  // getSkills / getAchievements are deliberately NOT implemented (GameApi marks
  // them optional). Receipt: the steward's progress scalar (progressGrandTotal in
  // agent.ts) returns null the moment the COUNTER dimension (get_status.stats) is
  // undefined — which it always is over MCP text — so it suppresses regardless of
  // whether skills/achievements are known. Sourcing get_skills/get_achievements
  // therefore could not un-dark the progress signal (the counters block is the
  // unsourceable piece), so implementing them would be dead code that fires two
  // extra queries per sample for no behavioral change. Left absent, which honestly
  // marks those dimensions UNKNOWN. See the missing-dimension note at the top.
}
