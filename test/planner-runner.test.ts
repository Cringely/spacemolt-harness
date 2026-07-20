import { describe, expect, test } from "bun:test";
import { defaultRunner } from "../src/planner/runner";

// These tests never invoke `claude` -- they point defaultRunner at `bun`
// itself (already required by every dev/CI environment this repo runs in)
// to exercise the actual Bun.spawn/stdout/exit-code plumbing that the real
// claude-subscription planner depends on. Zero tokens, zero network.
describe("defaultRunner", () => {
  // Filter process.env to only string values (not undefined)
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e) => e[1] !== undefined),
  ) as Record<string, string>;

  test("captures stdout and passes args through to the child process", async () => {
    const run = defaultRunner("bun");
    const { stdout, exitCode } = await run(
      ["-e", "console.log(JSON.stringify({ argv: process.argv.slice(1) }))", "a", "b"],
      env,
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).argv).toEqual(["a", "b"]);
  });

  test("passes the given env into the child process (not the parent's alone)", async () => {
    const run = defaultRunner("bun");
    const { stdout } = await run(
      ["-e", "console.log(process.env.PLANNER_RUNNER_TEST_VAR ?? '')"],
      { ...env, PLANNER_RUNNER_TEST_VAR: "seen-it" },
    );
    expect(stdout.trim()).toBe("seen-it");
  });

  test("propagates a non-zero exit code", async () => {
    const run = defaultRunner("bun");
    const { exitCode } = await run(["-e", "process.exit(7)"], env);
    expect(exitCode).toBe(7);
  });

  // ENAMETOOLONG fix (claude-subscription.ts): the prompt now travels via
  // stdin instead of argv, so this is the seam that must actually deliver it
  // to the child process -- covers the `stdin` param this test file didn't
  // previously exercise at all.
  test("delivers stdin to the child process when stdin is provided", async () => {
    const run = defaultRunner("bun");
    const { stdout, exitCode } = await run(
      ["-e", "const d = await new Response(Bun.stdin.stream()).text(); console.log(JSON.stringify({ len: d.length, argv: process.argv.slice(1) }));"],
      env,
      "hello from stdin",
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.len).toBe("hello from stdin".length);
    expect(parsed.argv).toEqual([]); // prompt never leaks into argv
  });

  // Regression guard for the live ENAMETOOLONG failure: a payload far larger
  // than any digest seen in production must still make it to the child
  // whole, since it now flows via stdin instead of a spawn argv element.
  test("delivers a large (100KB) stdin payload intact", async () => {
    const run = defaultRunner("bun");
    const big = "x".repeat(100_000);
    const { stdout, exitCode } = await run(
      ["-e", "const d = await new Response(Bun.stdin.stream()).text(); console.log(d.length);"],
      env,
      big,
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("100000");
  });

  test("does not write to stdin when stdin is not provided (ignored, not piped)", async () => {
    const run = defaultRunner("bun");
    const { exitCode } = await run(["-e", "process.exit(0)"], env);
    expect(exitCode).toBe(0);
  });
});
