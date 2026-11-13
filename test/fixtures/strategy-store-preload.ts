// Preload for test/strategy-store-exit.test.ts: bends one thing about the
// runtime, chosen by STORE_TEST_MODE, so the real scripts/strategy-store.ts
// can be run as a subprocess and its EXIT CODE observed.
//   zod-poison  -> any import of `zod` throws (what a missing/mismatched
//                  node_modules does to the scheduler's checkout, #1139/#1143)
//   skip        -> fetch answers a well-formed gate response {"run":false}
//   run         -> fetch answers {"run":true}
//   text-throws -> fetch answers 200 but reading the body throws
import { plugin } from "bun";

const mode = process.env.STORE_TEST_MODE;

if (mode === "zod-poison") {
  plugin({
    name: "zod-poison",
    setup(build) {
      // onLoad, not onResolve: Bun does not route a bare package specifier
      // through onResolve, but every zod file loads from node_modules/zod/.
      build.onLoad({ filter: /node_modules[\\/]zod[\\/]/ }, () => {
        throw new Error("zod imported: strategy-store's import graph must be zod-free");
      });
    },
  });
}

if (mode === "skip" || mode === "run" || mode === "text-throws") {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => {
      if (mode === "text-throws") throw new Error("boom reading body");
      return JSON.stringify({ run: mode === "run" });
    },
  })) as unknown as typeof fetch;
}
