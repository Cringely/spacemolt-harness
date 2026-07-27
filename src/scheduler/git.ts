// Shared git-runner seam (#585 ephemeral-worktree dispatch). tick.ts (origin/
// main status reads) and spawn.ts (per-job worktree lifecycle) both need the
// same injectable `git <args>` seam. Hoisted into its own file rather than
// spawn.ts importing tick.ts's copy of the type: tick.ts imports the `runJob`
// VALUE from spawn.ts, so spawn.ts importing a type back from tick.ts would
// be a module cycle. tick.ts re-exports these two names so scripts/
// scheduler.ts's existing `import type { GitRunner } from "../src/scheduler/
// tick"` keeps working unchanged.
export interface GitResult {
  stdout: string;
  exitCode: number;
}
export type GitRunner = (args: string[]) => GitResult;
