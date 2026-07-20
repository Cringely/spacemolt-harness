// Pre-build / pre-release gate: typecheck, offline test suite, dependency
// audit. Runs both as `bun run preflight` locally and inside the
// Dockerfile's `test` stage (Task 1) — one script, two callers, so a
// broken build/test/audit fails the image build itself, not a later
// deploy step nobody was watching.
import { spawnSync } from "node:child_process";

const steps: Array<[string, string[]]> = [
  ["typecheck", ["bun", "x", "tsc", "--noEmit"]],
  ["test", ["bun", "test"]],
  ["audit", ["bun", "audit"]],
];

for (const [name, cmd] of steps) {
  console.log(`preflight: running ${name}...`);
  const result = spawnSync(cmd[0]!, cmd.slice(1), { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`preflight: ${name} failed (exit ${result.status ?? "unknown"})`);
    process.exit(result.status ?? 1);
  }
}
console.log("preflight: all gates passed");
