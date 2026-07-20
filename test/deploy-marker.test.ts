import { describe, expect, test } from "bun:test";
import { Store } from "../src/store/store";
import {
  resolveBuildId, emitDeployMarkers, DEPLOY_MARKER_TYPE, type DeployMarkerPayload,
} from "../src/deploy-marker";

describe("resolveBuildId", () => {
  test("prefers HARNESS_IMAGE_TAG when set", () => {
    expect(resolveBuildId({ HARNESS_IMAGE_TAG: "v1.4.2" }, 0)).toBe("v1.4.2");
  });

  test("falls back to HARNESS_BUILD_ID when no image tag", () => {
    expect(resolveBuildId({ HARNESS_BUILD_ID: "abc123" }, 0)).toBe("abc123");
  });

  test("trims surrounding whitespace and ignores a blank tag", () => {
    expect(resolveBuildId({ HARNESS_IMAGE_TAG: "  v2  " }, 0)).toBe("v2");
    // A blank/whitespace tag must not win over the start-time fallback.
    const fb = resolveBuildId({ HARNESS_IMAGE_TAG: "   " }, 1_700_000_000_000);
    expect(fb.startsWith("dev-")).toBe(true);
  });

  test("an explicitly empty image tag does not shadow a valid build id", () => {
    // compose `${TAG:-}` with TAG unset passes HARNESS_IMAGE_TAG="" (not unset);
    // `??` would return "" and never consult HARNESS_BUILD_ID. First-non-blank fixes it.
    expect(resolveBuildId({ HARNESS_IMAGE_TAG: "", HARNESS_BUILD_ID: "abc123" }, 0)).toBe("abc123");
    expect(resolveBuildId({ HARNESS_IMAGE_TAG: "   ", HARNESS_BUILD_ID: "abc123" }, 0)).toBe("abc123");
  });

  test("with no env, stamps a distinct dev id from the process start time", () => {
    // Two different start times must yield two different markers so successive
    // restarts remain orderable/distinct on the chart even without a tag.
    const a = resolveBuildId({}, 1_700_000_000_000);
    const b = resolveBuildId({}, 1_700_000_060_000);
    expect(a).not.toBe(b);
    expect(a.startsWith("dev-")).toBe(true);
  });
});

describe("emitDeployMarkers", () => {
  test("writes one deploy_marker per agent with the build id and start time", () => {
    const store = new Store(":memory:");
    emitDeployMarkers(store, ["miner", "scout"], "v9", 12345);

    for (const id of ["miner", "scout"]) {
      const events = store.recentEvents(id, 10);
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe(DEPLOY_MARKER_TYPE);
      expect(events[0]!.ts).toBe(12345);
      const p = events[0]!.payload as DeployMarkerPayload;
      expect(p.buildId).toBe("v9");
      expect(p.startedAt).toBe(12345);
    }
  });

  test("emits nothing when there are no agents", () => {
    const store = new Store(":memory:");
    emitDeployMarkers(store, [], "v9", 1);
    expect(store.recentEvents("anyone", 10).length).toBe(0);
  });
});
