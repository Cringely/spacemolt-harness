import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentConfig } from "../src/agent/agent";
import { MockPlanner } from "../src/planner/mock";
import { Store } from "../src/store/store";
import { harvestCases } from "../src/eval/harvest";
import { LISTING_TEXT_SNIPPET_LEN, buildDigest, clipPlanContext } from "../src/planner/digest";
import type { GameApi, StatusSnapshot } from "../src/client/client";
import type { V2Result } from "../src/client/http";
import type { PlanContext } from "../src/planner/types";
import type { Plan } from "../src/registry/plan";

// The structural bound on the plan_context event (issue #272).
//
// PR #267 bounded the event field by field and wrote the invariant into a
// comment. PR #270 added purchaseEstimates and the bound was gone -- the raw
// game envelope text of N candidate items, persisted every replan, on the live
// pilot's hot path. Neither PR is wrong alone; the union is. So the bound stops
// being a habit and becomes a mechanism: clipPlanContext walks EVERY string leaf,
// and this test walks the EMITTED event the same way. A field added tomorrow and
// left unclipped fails HERE, without anyone remembering to come back and add an
// assertion for it -- which is the only kind of bound that survives the next PR.

const config: AgentConfig = {
  fuelPct: 20, hullPct: 30, heartbeatMinutes: 15, wakeNotificationTypes: [],
  stallThreshold: 5, subscriptionCooldownMinutes: 60,
};

const status: StatusSnapshot = {
  credits: 500, fuel: 80, maxFuel: 100, hull: 100, maxHull: 100,
  cargoUsed: 0, cargoCapacity: 50, docked: true, inTransit: false,
};

const plan: Plan = { goal: "survey the belt", steps: [{ action: "undock", params: {} }] };

/** +1 for the ellipsis clipUntrusted appends when it cuts. */
const LEAF_CAP = LISTING_TEXT_SNIPPET_LEN + 1;

/** Every string reachable in the payload, with the path that reached it. */
function stringLeaves(value: unknown, path = "ctx"): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, `${path}.${k}`));
  }
  return [];
}

describe("plan_context is bounded by construction", () => {
  test("no string leaf of the EMITTED event exceeds the listing cap -- including leaves of fields the bound never heard of", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sm-bound-")), "events.sqlite");
    const store = new Store(dbPath);
    const fat = "x".repeat(20_000);
    const api: GameApi = {
      async action(): Promise<V2Result> { return { result: "ok" }; },
      async status() { return status; },
      async notifications() {
        return [{ id: "n1", type: "chat", msg_type: "chat_message", timestamp: "t", data: { sender: fat, text: fat } }];
      },
      async getMissions() { return fat; },
      async getActiveMissions() { return { text: fat }; },
      async getNearby() { return fat; },
      async getShipyard() { return fat; },
      // The field #270 added, which #267's per-field bound could not know about.
      async estimatePurchase() { return fat; },
    };
    const agent = new Agent({
      id: "a1", persona: "Solarian miner", api, store,
      planner: new MockPlanner([plan]), config, now: () => 1_000,
    });
    // A goal that names a catalog item is what makes the harness run
    // estimate_purchase at all (goal-items.ts); the instruction becomes a goal.
    agent.instruct("buy a Deep Core Extractor");
    await agent.runOnce();

    const ev = store.recentEventsByType("a1", "plan_context", 1)[0]!;
    const ctx = (ev.payload as { ctx: PlanContext }).ctx;
    store.close();

    // The whole guard, in one assertion: walk what was WRITTEN, not what we
    // remembered to clip. Reported with paths so a failure names the new field.
    const oversized = stringLeaves(ctx).filter((l) => l.text.length > LEAF_CAP).map((l) => `${l.path} (${l.text.length} chars)`);
    expect(oversized).toEqual([]);

    // ... and the regression that prompted it: purchaseEstimates IS persisted
    // (so the walk above is not passing on an absent field) and IS clipped.
    expect(ctx.purchaseEstimates!.length).toBeGreaterThan(0);
    expect(ctx.purchaseEstimates![0]!.text.length).toBe(LEAF_CAP);

    // The eval's schema no longer strips it on the way back out (defect 2): a
    // purchase-aware scorer would have seen `undefined` and scored against data
    // that was never there.
    const c = harvestCases(dbPath, "a1")[0]!;
    expect(c.ctx.purchaseEstimates?.[0]?.itemId).toContain("deep_core_extractor");
  });
});

// The blanket cap above is a CEILING, not the invariant. The invariant #263's
// replay needs is FIDELITY: the persisted text equals what the planner was SHOWN.
// A field with its own TIGHTER render cap passes the ceiling test while persisting
// text the planner never saw -- which is exactly what shipped in PR #272's first
// cut (wake.detail on a blocked wake: rendered at 200, persisted at 1014, so a
// scorer would grade a model against 5x its input). So the seams are checked
// against the DIGEST, not against a number: every untrusted string clipPlanContext
// persists must appear VERBATIM in buildDigest's output for the same ctx. The next
// field with a tight render cap fails here without anyone remembering it exists.
describe("plan_context stores exactly what the planner was SHOWN", () => {
  // Distinct per seam: identical filler would let one seam's clipped text pass as
  // a substring of another seam's longer render, and the test would prove nothing.
  const fat = (tag: string) => `${tag}-${"x".repeat(3_000)}`;

  const ctx: PlanContext = {
    persona: "Solarian miner",
    goals: ["buy a Deep Core Extractor"],
    wake: { reason: "blocked", detail: fat("wakeDetail") },
    statusSummary: "credits 500, fuel 80/100, hull 100/100, cargo 19/50, docked",
    recentEvents: [],
    cargo: { used: 19, capacity: 50, items: [{ itemId: "iron_ore", name: "Iron Ore", quantity: 19 }] },
    marketRows: [
      { itemId: "iron_ore", bestBuy: 12, buyQty: 100 },
      { itemId: "palladium_ore", bestBuy: 900, buyQty: 5 },
    ],
    chatMessages: [{ sender: fat("chatSender"), text: fat("chatText") }],
    missionsText: fat("missionsText"),
    activeMissionsText: fat("activeMissionsText"),
    nearbyText: fat("nearbyText"),
    shipyardText: fat("shipyardText"),
    purchaseEstimates: [{ itemId: "deep_core_extractor", name: "Deep Core Extractor", text: fat("purchaseText") }],
  };

  const digest = buildDigest(ctx);
  const persisted = clipPlanContext(ctx);

  // Every untrusted-text seam the digest renders, and where it lands in the event.
  const seams: Array<[name: string, text: string | undefined]> = [
    ["wake.detail (blocked -- rendered at the 200-char untrusted cap, not the 1500 backstop)", persisted.wake.detail],
    ["chatMessages[0].sender", persisted.chatMessages?.[0]?.sender],
    ["chatMessages[0].text", persisted.chatMessages?.[0]?.text],
    ["missionsText", persisted.missionsText],
    ["activeMissionsText", persisted.activeMissionsText],
    ["nearbyText", persisted.nearbyText],
    ["shipyardText", persisted.shipyardText],
    ["purchaseEstimates[0].text", persisted.purchaseEstimates?.[0]?.text],
  ];

  for (const [name, text] of seams) {
    test(`${name}: the persisted text is text the planner actually saw`, () => {
      expect(text).toBeString();
      expect(text!.length).toBeGreaterThan(0);
      // The whole invariant: not "short enough" -- PRESENT IN THE DIGEST.
      expect(digest.includes(text!)).toBe(true);
    });
  }

  test("marketRows persists only the rows the digest rendered (the held-item shaping pass)", () => {
    // The digest's market check renders held items only; the raw listing runs ~482
    // rows. Same fidelity rule, structural rather than textual.
    expect(persisted.marketRows!.map((r) => r.itemId)).toEqual(["iron_ore"]);
  });
});
