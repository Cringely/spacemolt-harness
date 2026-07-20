// #114 A1 store-access boundary tests (v2, 2026-07-19 pivot: authenticated
// HTTP replaces the SSH forced-command dispatcher). scripts/strategy-store.ts
// is the scheduler-host caller's arg validation + request-shape construction, pure and
// platform-neutral (no fetch). The route-side auth/logic is covered in
// test/server.test.ts (the routes live on the harness's own server).
import { test, expect, describe } from "bun:test";
import {
  validateStoreArgs, resolveBaseUrl, resolveBearerToken, buildStoreRequest, StoreArgError, STORE_OPS,
} from "../scripts/strategy-store";

describe("strategy-store.ts arg validation", () => {
  test("accepts the three ops with a well-formed agentId", () => {
    for (const op of STORE_OPS) {
      expect(validateStoreArgs(op, "miner").op).toBe(op);
    }
    expect(validateStoreArgs("dump", "test.pilot_1-x").agentId).toBe("test.pilot_1-x");
  });

  test("rejects unknown ops and malformed agentIds", () => {
    expect(() => validateStoreArgs("delete", "miner")).toThrow(StoreArgError);
    expect(() => validateStoreArgs(undefined, "miner")).toThrow(StoreArgError);
    expect(() => validateStoreArgs("dump", undefined)).toThrow(StoreArgError);
    expect(() => validateStoreArgs("dump", "")).toThrow(StoreArgError);
    expect(() => validateStoreArgs("dump", "a b")).toThrow(StoreArgError); // space
    expect(() => validateStoreArgs("dump", "x;y")).toThrow(StoreArgError); // metachar
    expect(() => validateStoreArgs("dump", "a".repeat(65))).toThrow(StoreArgError); // overlong
  });

  test("resolveBaseUrl requires SM_STORE_URL, strips a trailing slash", () => {
    expect(() => resolveBaseUrl({} as NodeJS.ProcessEnv)).toThrow(StoreArgError);
    expect(resolveBaseUrl({ SM_STORE_URL: "http://192.0.2.10:8642" } as NodeJS.ProcessEnv)).toBe("http://192.0.2.10:8642");
    expect(resolveBaseUrl({ SM_STORE_URL: "http://192.0.2.10:8642/" } as NodeJS.ProcessEnv)).toBe("http://192.0.2.10:8642");
  });

  test("resolveBearerToken requires STORE_BEARER (populated by jobs.ts extraSecrets, never an argv token)", () => {
    expect(() => resolveBearerToken({} as NodeJS.ProcessEnv)).toThrow(StoreArgError);
    expect(resolveBearerToken({ STORE_BEARER: "tok123" } as NodeJS.ProcessEnv)).toBe("tok123");
  });

  test("buildStoreRequest: dump/gate are GET, mark is POST, agentId is URL-encoded", () => {
    expect(buildStoreRequest("http://h:1", "dump", "miner")).toEqual({ url: "http://h:1/api/store/miner/dump", method: "GET" });
    expect(buildStoreRequest("http://h:1", "gate", "miner")).toEqual({ url: "http://h:1/api/store/miner/gate", method: "GET" });
    expect(buildStoreRequest("http://h:1", "mark", "miner")).toEqual({ url: "http://h:1/api/store/miner/mark", method: "POST" });
    // Encoding matters: a raw '/' or space in an otherwise-rejected agentId
    // must never be smuggled into the path unescaped -- belt-and-braces on
    // top of validateStoreArgs's allowlist, which already rejects such ids.
    expect(buildStoreRequest("http://h:1", "dump", "a b").url).toBe("http://h:1/api/store/a%20b/dump");
  });
});
