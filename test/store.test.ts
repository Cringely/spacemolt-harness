import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store";
import type { Plan } from "../src/registry/plan";

const plan: Plan = {
  goal: "test",
  steps: [{ action: "mine", params: {}, until: "cargo_full" }],
};

describe("Store", () => {
  test("appends and reads events, fires onEvent", () => {
    const store = new Store(":memory:");
    const seen: number[] = [];
    store.onEvent = (e) => seen.push(e.id);
    const id = store.appendEvent({ agentId: "a1", ts: 1000, type: "action", payload: { x: 1 } });
    expect(id).toBeGreaterThan(0);
    expect(seen).toEqual([id]);
    const events = store.recentEvents("a1", 10);
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toEqual({ x: 1 });
    expect(store.recentEvents("other", 10).length).toBe(0);
  });

  test("plan round-trips with cursor and goals", () => {
    const store = new Store(":memory:");
    expect(store.loadPlan("a1")).toBeNull();
    store.savePlan("a1", plan, ["get rich"]);
    store.saveCursor("a1", { step: 0, iteration: 3 });
    const loaded = store.loadPlan("a1")!;
    expect(loaded.plan).toEqual(plan);
    expect(loaded.cursor).toEqual({ step: 0, iteration: 3 });
    expect(loaded.goals).toEqual(["get rich"]);
    store.clearPlan("a1");
    expect(store.loadPlan("a1")).toBeNull();
  });

  test("savePlan resets cursor to step 0", () => {
    const store = new Store(":memory:");
    store.savePlan("a1", plan, []);
    store.saveCursor("a1", { step: 0, iteration: 5 });
    store.savePlan("a1", plan, []); // replan
    expect(store.loadPlan("a1")!.cursor).toEqual({ step: 0, iteration: 0 });
  });

  test("prunes old events", () => {
    const store = new Store(":memory:");
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1000;
    store.appendEvent({ agentId: "a1", ts: old, type: "action", payload: null });
    store.appendEvent({ agentId: "a1", ts: now, type: "action", payload: null });
    const pruned = store.pruneEvents(30);
    expect(pruned).toBe(1);
    expect(store.recentEvents("a1", 10).length).toBe(1);
  });
});

// Issue #670 producer fix: the reflex's range signal is read back from the
// persisted action-event stream, not an in-memory field, so it survives a
// restart (same convention as reflexGaveUpAt's reflex_failed reads).
describe("Store.lastMeasuredFuelPerJump", () => {
  test("undefined with no measured jump on record", () => {
    const store = new Store(":memory:");
    expect(store.lastMeasuredFuelPerJump("a1", "Prospect")).toBeUndefined();
  });

  test("returns the most recent measurement for the given ship class", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "action", payload: { action: "travel_to", fuelPerJump: 1, shipClass: "Prospect" } });
    store.appendEvent({ agentId: "a1", ts: 2, type: "action", payload: { action: "travel_to", fuelPerJump: 3, shipClass: "Prospect" } });
    expect(store.lastMeasuredFuelPerJump("a1", "Prospect")).toBe(3);
  });

  // switch_ship staleness guard: a measurement recorded under a DIFFERENT ship
  // class must not answer for the current one -- a stale, cheaper number would
  // understate range on a costlier hull, exactly the direction issue #526
  // warns against.
  test("a measurement recorded under a different ship class does not match", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "action", payload: { fuelPerJump: 1, shipClass: "Prospect" } });
    expect(store.lastMeasuredFuelPerJump("a1", "Dreadnought")).toBeUndefined();
  });

  test("undefined when the current ship class is unknown", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "action", payload: { fuelPerJump: 1, shipClass: "Prospect" } });
    expect(store.lastMeasuredFuelPerJump("a1", undefined)).toBeUndefined();
    expect(store.lastMeasuredFuelPerJump("a1", null)).toBeUndefined();
  });

  test("ignores events with no fuelPerJump (ordinary action noise)", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "action", payload: { action: "mine" } });
    expect(store.lastMeasuredFuelPerJump("a1", "Prospect")).toBeUndefined();
  });

  // #54 review, finding 1: json_extract THROWS on text that is not JSON, and
  // this query runs unconditionally every tick from agent.ts's hot path over
  // an events table that can hold rows from older builds. One malformed row
  // anywhere in history must not crash-loop the pilot -- same tolerance as
  // dockTrail's json_valid guard (PR #22 review, F2), applied here.
  test("a malformed stored payload is discarded, not thrown, and the valid measurement still returns", () => {
    const dbPath = join(tmpdir(), `spacemolt-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    cleanupPaths.push(dbPath);
    const store = new Store(dbPath);
    store.appendEvent({ agentId: "a1", ts: 1, type: "action", payload: { action: "travel_to", fuelPerJump: 2, shipClass: "Prospect" } });
    // Written past the appendEvent seam on purpose: appendEvent JSON.stringifys,
    // so no typed writer can produce this.
    const raw = new Database(dbPath);
    raw.query("INSERT INTO events (agent_id, ts, type, payload) VALUES (?, ?, ?, ?)")
      .run("a1", 2, "action", '{"action":"travel_to","fuelPerJump":');
    raw.close();
    expect(() => store.lastMeasuredFuelPerJump("a1", "Prospect")).not.toThrow();
    expect(store.lastMeasuredFuelPerJump("a1", "Prospect")).toBe(2);
    store.close();
  });
});

describe("Store.loadPlan schema tolerance", () => {
  // A plan an OLDER build stored before the chat.target enum tightening: the
  // then-permissive z.string() let "broadcast" through, which the current
  // strict CHAT_CHANNELS enum rejects. savePlan does no runtime validation, so
  // this is exactly what such a row looks like on disk. This is the prod crash
  // (2026-07-12): PlanSchema.parse throws through the Agent constructor and
  // crash-loops the harness on boot. On the pre-fix throwing loadPlan this test
  // fails (throws instead of returning null).
  const stalePlan = {
    goal: "greet the sector",
    steps: [{ action: "chat", params: { target: "broadcast", content: "hi" } }],
  } as unknown as Plan;

  test("discards an invalid stored plan and returns no-plan instead of throwing", () => {
    const store = new Store(":memory:");
    store.savePlan("a1", stalePlan, ["say hi"]);
    expect(() => store.loadPlan("a1")).not.toThrow();
    expect(store.loadPlan("a1")).toBeNull();
  });

  test("clears the invalid row so a second boot does not re-discard it", () => {
    const store = new Store(":memory:");
    store.savePlan("a1", stalePlan, []);
    store.loadPlan("a1"); // discards + clears + emits one plan_discarded event
    store.loadPlan("a1"); // row gone: must hit the no-row path, not re-discard
    const discards = store
      .recentEvents("a1", 10)
      .filter((e) => e.type === "plan_discarded");
    expect(discards.length).toBe(1);
  });

  test("a valid stored plan still loads intact (happy path unchanged)", () => {
    const store = new Store(":memory:");
    const good: Plan = { goal: "mine ore", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    store.savePlan("a1", good, ["get rich"]);
    store.saveCursor("a1", { step: 0, iteration: 2 });
    const loaded = store.loadPlan("a1")!;
    expect(loaded.plan).toEqual(good);
    expect(loaded.cursor).toEqual({ step: 0, iteration: 2 });
    expect(loaded.goals).toEqual(["get rich"]);
  });

  // Goals are JSON only (no schema), but the goals parse lives INSIDE the same
  // guard: a corrupt goals column must degrade to no-plan too, not throw. This
  // catches a regression that moves the goals parse back outside the try/catch.
  test("discards when the goals column is corrupt JSON", () => {
    const dbPath = join(tmpdir(), `spacemolt-store-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    cleanupPaths.push(dbPath);
    const store = new Store(dbPath);
    const good: Plan = { goal: "mine ore", steps: [{ action: "mine", params: {}, until: "cargo_full" }] };
    store.savePlan("a1", good, ["ok"]);
    // Corrupt only the goals column out-of-band, leaving the plan JSON valid.
    const raw = new Database(dbPath);
    raw.query("UPDATE plans SET goals = ? WHERE agent_id = ?").run("{not valid json", "a1");
    raw.close();
    expect(() => store.loadPlan("a1")).not.toThrow();
    expect(store.loadPlan("a1")).toBeNull();
    store.close();
  });
});

const cleanupPaths: string[] = [];
afterEach(() => {
  while (cleanupPaths.length) {
    const p = cleanupPaths.pop()!;
    try { rmSync(p, { force: true }); rmSync(`${p}-wal`, { force: true }); rmSync(`${p}-shm`, { force: true }); } catch { /* best effort */ }
  }
});

describe("Store.eventsSince", () => {
  test("returns only events at or after the cutoff, ascending by id, scoped to the agent", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 50, type: "wake", payload: {} });  // before cutoff -- excluded
    store.appendEvent({ agentId: "a1", ts: 100, type: "wake", payload: {} });
    store.appendEvent({ agentId: "a1", ts: 200, type: "wake", payload: {} });
    store.appendEvent({ agentId: "a2", ts: 250, type: "wake", payload: {} }); // different agent -- excluded

    const events = store.eventsSince("a1", 100);
    expect(events.map((e) => e.ts)).toEqual([100, 200]);
    expect(events.every((e) => e.agentId === "a1")).toBe(true);
  });

  test("returns an empty array when nothing is in range", () => {
    const store = new Store(":memory:");
    store.appendEvent({ agentId: "a1", ts: 1, type: "wake", payload: {} });
    expect(store.eventsSince("a1", 1000)).toEqual([]);
  });
});
