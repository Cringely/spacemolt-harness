import type { EnvelopeNotification } from "../client/http";
import type { StatusSnapshot } from "../client/client";

export type WakeReason = {
  reason: "no_plan" | "plan_done" | "blocked" | "instruction" | "notification"
    | "low_fuel" | "low_hull" | "heartbeat";
  detail?: string;
};

export interface WakeInput {
  planState: "none" | "running" | "done" | "blocked";
  blockedReason?: string;
  instruction?: string;
  notifications: EnvelopeNotification[];
  status: StatusSnapshot | null;
  lastPlanAt: number;
  now: number;
  heartbeatMs: number;
  fuelPct: number; // wake when fuel below this % of max
  // stall-watcher v4 fuel-reserve floor (strand PREVENTION): while UNDOCKED,
  // raise the low_fuel concern at this higher threshold so the planner heads for
  // fuel while it still can, before 0. Docked stays on fuelPct (the reflex
  // refuels there anyway). Optional -- when unset only fuelPct applies, so the
  // floor is purely additive and never lowers the existing bar. A heuristic
  // backstop; true "enough to reach known fuel" needs the fuel-location map
  // from the next spec (per-pilot memory).
  fuelReservePct?: number;
  hullPct: number;
  wakeNotificationTypes: string[]; // e.g. ["combat", "chat"]
  // Layer 1 (producer fix): the in-flight plan still carries an unexecuted
  // refuel/repair step, so a low_fuel/low_hull wake would preempt the plan's
  // own remedy and reset the cursor -- a livelock (ground truth: 231/233 wakes
  // low_fuel, plan frozen at step 0). Set from the steps remaining at the
  // current cursor (agent.ts), so once the remedy step has been passed and the
  // condition still holds the flag drops and the wake fires again -- genuine
  // new information, not a preemption.
  planRemediesFuel?: boolean;
  planRemediesHull?: boolean;
}

// No-buyers outcome CLASS (issue #146, live 2026-07-13). The game words a
// buyer-less sell differently per item ("Sold 0 Gold Ore for 0cr … (no
// buyers)" vs "…Vanadium Ore…"), so exact-string consumers -- the thrash
// damper's key (agent.ts) and the digest's relocate briefing (digest.ts) --
// must classify by pattern, not equality. Defined ONCE, at the seam where a
// blocked reason becomes a wake detail (evaluateWake below), so the two
// consumers can never drift apart on what counts as "no buyers". The
// alternation covers both message shapes: the "(no buyers)" tail and the
// "Sold 0 X for 0cr" head -- the head sits at the front of the text, so it
// survives even when snippet() truncation clips the tail.
export const NO_BUYERS_CLASS = "sell:no_buyers";
const NO_BUYERS_RE = /no buyers|sold 0 .* for 0cr/i;
export function isNoBuyersBlock(detail: string | undefined): boolean {
  return detail !== undefined && NO_BUYERS_RE.test(detail);
}

// Same-error-repeat loop-breaker key (issue #95). The GENERAL classification
// the consecutive thrash damper (agent.ts BLOCKED_THRASH_THRESHOLD) is a
// special case of. That damper keys on the block REASON and needs CONSECUTIVE
// wakes, so an INTERLEAVED repeat -- the same doomed action retried with other
// work in between -- never builds a streak, and only the slow 30-min
// no-progress window catches it (and that window is itself defeated when OTHER
// progress dimensions climb: the #291 mission mask, 12 complete_mission blocks
// over 14.6h while gold-mining counters advanced). This key is STABLE across
// attempts where the reason text is NOT: the action verb plus the action's
// TARGET (the item/mission/system/POI it names), with quantities and prices
// excluded, so "sell gold_ore x33" and "x12" are one target (the #158
// strip-quantities idea). A recognized outcome CLASS whose target legitimately
// varies per attempt (the no-buyers class, #146/#155) collapses to the class
// token, so a loop that cycles items still counts as one -- DETECTION
// generalizes freely (a class need not be proven to thrash to be COUNTED; only
// SUPPRESSION stays conservative). Tolerant of an unknown params shape (an
// older or foreign action event): a non-object params or a missing target
// yields a bare "action:" key rather than throwing.
const TARGET_PARAM_KEYS = ["id", "item_id", "system_id", "template_id", "target"] as const;

export interface BlockedOutcome {
  key: string;
  label: string; // human phrase for the re-steer / event ("sell on 'gold_ore'")
}

export function blockedOutcomeKey(
  action: string, params: unknown, reason: string | undefined,
): BlockedOutcome {
  if (isNoBuyersBlock(reason)) return { key: NO_BUYERS_CLASS, label: `${action} (no buyers)` };
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  let target = "";
  for (const k of TARGET_PARAM_KEYS) {
    const v = p[k];
    if (typeof v === "string" && v) { target = v; break; }
  }
  return { key: `${action}:${target}`, label: target ? `${action} on '${target}'` : action };
}

// Always wake on these regardless of the configured type filter — they can
// arrive under type "system", which the default filter excludes.
const CRITICAL_MSG_TYPES = ["player_died"];

/** First matching wake reason wins; null means the executor keeps driving. */
export function evaluateWake(i: WakeInput): WakeReason | null {
  if (i.instruction) return { reason: "instruction", detail: i.instruction };
  if (i.planState === "blocked") return { reason: "blocked", detail: i.blockedReason };
  if (i.planState === "none") return { reason: "no_plan" };
  if (i.planState === "done") return { reason: "plan_done" };

  const notable = i.notifications.find(
    (n) => i.wakeNotificationTypes.includes(n.type) || CRITICAL_MSG_TYPES.includes(n.msg_type)
  );
  if (notable) return { reason: "notification", detail: notable.msg_type };

  if (i.status) {
    const { fuel, maxFuel, hull, maxHull, docked } = i.status;
    // Fuel-reserve floor: undocked, the effective threshold rises to
    // fuelReservePct (a strand backstop -- reach fuel before 0). Docked keeps
    // fuelPct; the reflex refuels there regardless. Same planRemediesFuel
    // suppression as before, so an in-flight refuel step still defers the wake.
    const effectiveFuelPct = !docked && i.fuelReservePct != null
      ? Math.max(i.fuelPct, i.fuelReservePct)
      : i.fuelPct;
    if (maxFuel > 0 && (fuel / maxFuel) * 100 < effectiveFuelPct && !i.planRemediesFuel)
      return { reason: "low_fuel", detail: `${fuel}/${maxFuel}` };
    if (maxHull > 0 && (hull / maxHull) * 100 < i.hullPct && !i.planRemediesHull)
      return { reason: "low_hull", detail: `${hull}/${maxHull}` };
  }

  if (i.now - i.lastPlanAt > i.heartbeatMs) return { reason: "heartbeat" };
  return null;
}
