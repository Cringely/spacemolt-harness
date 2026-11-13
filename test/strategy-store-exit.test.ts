// Exit-code contract of scripts/strategy-store.ts, observed on the real script
// as a subprocess (Cringely/spacemolt#1139, #1143). The strategy job reads the
// gate's exit code as: 0 = run the review, 1 = SKIP (a healthy quiet pilot),
// 2 = error. A crash that exits 1 is therefore indistinguishable from a skip
// and the review silently never runs. Invariant: exit 1 only for a real SKIP.
import { test, expect, describe } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "strategy-store.ts");
const PRELOAD = join(import.meta.dir, "fixtures", "strategy-store-preload.ts");

async function runGate(mode: string | undefined, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SM_STORE_URL: "http://127.0.0.1:1",
    STORE_BEARER: "test-bearer",
    ...extraEnv,
  };
  if (mode) env.STORE_TEST_MODE = mode;
  const proc = Bun.spawn(["bun", "--preload", PRELOAD, SCRIPT, "gate", "miner"], {
    cwd: ROOT, env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("strategy-store.ts gate exit codes", () => {
  // Firing controls: without these a dead rig (preload not applied, fetch not
  // faked) would make the crash tests below read as a pass.
  test("control: run:true exits 0", async () => {
    expect((await runGate("run")).code).toBe(0);
  });

  test("control: run:false is the one real SKIP, exit 1", async () => {
    expect((await runGate("skip")).code).toBe(1);
  });

  test("import graph reaches no zod: a poisoned zod import cannot crash the script", async () => {
    // Missing SM_STORE_URL is a normal arg error -> 2. If the script (or
    // anything it imports) pulls in zod, the poison throws at import time
    // before any catch can run and bun exits 1: a crash dressed as a SKIP.
    const r = await runGate("zod-poison", { SM_STORE_URL: "" });
    expect(r.stderr).not.toContain("zod imported");
    expect(r.code).toBe(2);
  });

  test("an unexpected throw (not a StoreArgError) maps to exit 2, never 1", async () => {
    const r = await runGate("text-throws");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("boom reading body");
  });
});
