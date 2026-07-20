// Durable scheduler (#114) Task C1: the D1 per-capability gates (spec
// §Self-correction boundary). One explicit gate per capability:
//   (a) file findings   — ON at stage 1 (verdict (a), five conditions in C2);
//   (b) dispatch agents — OFF, bound to stage-3-VERIFIED: an enabled flag
//       alone is NOT enough — verifiedLiveAt is set by a human only after the
//       breaker+heartbeat is observed working in production (verdict (b)
//       condition 1, "merged is not enough"). Stage 1 ships no dispatch call
//       site (structurally off); canDispatch exists so stage 3 wires ONE check.
//   (c) amend own charter — NEVER. Not a flag, not a file entry.
// gates.json lives in the state dir and loads with the same schema tolerance
// as anchors (state.ts): invalid or missing pieces degrade to defaults, never
// a throw (binding AGENTS.md persisted-state rule).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const GATES_FILE = "gates.json";

const GatesSchema = z.object({
  fileFindings: z.object({ enabled: z.boolean().catch(true) }).catch({ enabled: true }),
  dispatchFixAgents: z
    .object({
      enabled: z.boolean().catch(false),
      verifiedLiveAt: z.number().nullable().catch(null),
    })
    .catch({ enabled: false, verifiedLiveAt: null }),
  // Kept in the file shape so a forged/edited entry parses and is then
  // visibly IGNORED — canAmend never reads it.
  amendOwnCharter: z.record(z.string(), z.unknown()).catch({}),
});

export type CapabilityGates = z.infer<typeof GatesSchema>;

export function defaultGates(): CapabilityGates {
  return {
    fileFindings: { enabled: true },
    dispatchFixAgents: { enabled: false, verifiedLiveAt: null },
    amendOwnCharter: {},
  };
}

export function loadGates(dir: string): CapabilityGates {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, GATES_FILE), "utf8"));
  } catch {
    return defaultGates(); // missing, truncated, or corrupt file
  }
  const parsed = GatesSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultGates();
}

export function canFile(g: CapabilityGates): boolean {
  return g.fileFindings.enabled;
}

export function canDispatch(g: CapabilityGates): boolean {
  return g.dispatchFixAgents.enabled && g.dispatchFixAgents.verifiedLiveAt !== null;
}

// Verdict (c): DENIED, permanently. The parameter exists so call sites read
// like the other two gates; it is deliberately ignored — "never" must not
// degrade into a config flag someone can flip in a state file.
export function canAmend(_g?: CapabilityGates): boolean {
  return false;
}
