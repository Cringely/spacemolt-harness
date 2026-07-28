// #114 A1 store-access boundary tests (v2, 2026-07-19 pivot: authenticated
// HTTP replaces the SSH forced-command dispatcher). scripts/strategy-store.ts
// is the scheduler-host caller's arg validation + request-shape construction, pure and
// platform-neutral (no fetch). The route-side auth/logic is covered in
// test/server.test.ts (the routes live on the harness's own server).
import { test, expect, describe } from "bun:test";
import {
  validateStoreArgs, resolveBaseUrl, resolveBearerToken, buildStoreRequest, parseSteerText,
  StoreArgError, STORE_OPS,
} from "../scripts/strategy-store";
import { INSTRUCTION_MAX_LENGTH } from "../src/server/server";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("strategy-store.ts arg validation", () => {
  test("accepts every op with a well-formed agentId, steer among them (#495)", () => {
    for (const op of STORE_OPS) {
      expect(validateStoreArgs(op, "miner").op).toBe(op);
    }
    // Named explicitly, not just covered by the loop: a `steer` dropped from
    // STORE_OPS would make the loop pass over three ops and prove nothing.
    expect(STORE_OPS).toContain("steer");
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

// #495: steer is the one op with a request BODY. The text rides as a single
// base64 argv token for the same reason file-finding.ts's --body-b64 does --
// the headless permission layer splits a Bash command on newlines and denies
// the fragments. These stay offline (no fetch), same as the block above; the
// route half is covered in test/server.test.ts.
describe("strategy-store.ts steer op (#495)", () => {
  test("buildStoreRequest emits a POST with the JSON body, and the other ops gain NO body key", () => {
    // toStrictEqual, not toEqual: toEqual treats a present-but-undefined
    // `body` as absent, so it would pass a build that always emitted the key.
    // The three data ops must keep the exact two-key shape they had pre-#495.
    expect(buildStoreRequest("http://h:1", "steer", "miner", "go dock")).toStrictEqual({
      url: "http://h:1/api/store/miner/steer", method: "POST", body: '{"text":"go dock"}',
    });
    for (const op of ["dump", "gate", "mark"] as const) {
      expect("body" in buildStoreRequest("http://h:1", op, "miner")).toBe(false);
    }
  });

  test("buildStoreRequest refuses to build a bodyless steer", () => {
    // Belt-and-braces behind parseSteerText: a caller that forgets the text
    // must fail here rather than POST `undefined` into the planner prompt.
    expect(() => buildStoreRequest("http://h:1", "steer", "miner")).toThrow(StoreArgError);
  });

  test("parseSteerText decodes --text-b64 and requires it", () => {
    expect(parseSteerText("steer", ["--text-b64", b64("stop mining, go dock")])).toBe("stop mining, go dock");
    // Base64 is what makes a multi-line steer survive the permission layer:
    // the decoded text may contain newlines, the ARGV token may not.
    expect(parseSteerText("steer", ["--text-b64", b64("line one\nline two")])).toBe("line one\nline two");
    expect(() => parseSteerText("steer", [])).toThrow(StoreArgError);
    expect(() => parseSteerText("steer", ["--text-b64"])).toThrow(StoreArgError);
    expect(() => parseSteerText("steer", ["--text", "plain"])).toThrow(StoreArgError);
    expect(() => parseSteerText("steer", ["--text-b64", "not base64!!"])).toThrow(StoreArgError);
  });

  test("parseSteerText enforces the SERVER's character bound, imported not copied", () => {
    const atCap = "x".repeat(INSTRUCTION_MAX_LENGTH);
    expect(parseSteerText("steer", ["--text-b64", b64(atCap)])!.length).toBe(INSTRUCTION_MAX_LENGTH);
    expect(() => parseSteerText("steer", ["--text-b64", b64(`${atCap}x`)])).toThrow(StoreArgError);
    expect(() => parseSteerText("steer", ["--text-b64", b64("")])).toThrow(StoreArgError);
  });

  test("a non-steer op carrying --text-b64 is REJECTED, never silently stripped", () => {
    // The failure this catches: an agent types `dump miner --text-b64 <steer>`,
    // the flag is ignored, the command exits 0, and a correction that never
    // reached the pilot is reported as a lever pulled.
    expect(() => parseSteerText("dump", ["--text-b64", b64("go dock")])).toThrow(StoreArgError);
    expect(parseSteerText("dump", [])).toBeUndefined();
  });
});
