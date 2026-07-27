// Durable scheduler (#585): ephemeral per-job git worktrees.
//
// The invariant this restores: the shared scheduler checkout is a read-only
// reference clone that no ceremony job ever writes to, so a job's own git
// mistakes (branch, commit, push) can never leave the checkout the NEXT
// tick's `git pull --ff-only` depends on stranded or diverged.
//
// The incident (#585, and its two predecessors #413/#459): every prior fix
// hardened the CONSUMER of a shared mutable checkout (force-restore after the
// steward, a pull-failure self-heal, a frozen host-side bootstrap) and each
// guard worked correctly — the outage happened anyway, because the shared
// checkout itself stayed writable. This removes the shared mutable state
// instead of adding a fourth guard around it (fix the producer, not the
// consumer).
//
// Design: one detached worktree per job run, pinned to a single commit,
// rooted under stateDir/worktrees (state, not the checkout — so a git
// worktree is never nested inside another git worktree), created just before
// the job's `claude -p` spawns and removed right after, success or failure.
// `--detach` (not a branch checkout) is load-bearing, not cosmetic: git
// refuses to check the SAME branch out in two worktrees at once, so a
// detached HEAD is what lets an ephemeral worktree exist at all alongside the
// shared checkout's own `main` checkout — and it is also what makes the
// ORIGINAL failure mode (committing without branching first) harmless here:
// a commit made on a detached HEAD updates no ref at all, so removing the
// worktree simply discards it.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GitRunner } from "./git";

export const WORKTREES_SUBDIR = "worktrees";

export function worktreesRoot(stateDir: string): string {
  return join(stateDir, WORKTREES_SUBDIR);
}

/**
 * Create a detached worktree pinned to `sha`, named `name` (the caller passes
 * the job's cycleId, already unique per job per tick — no separate naming
 * scheme needed). Throws on git failure; runJob's existing try/catch already
 * treats any thrown error as a job failure, so worktree creation needs no
 * error handling of its own.
 */
export function createJobWorktree(git: GitRunner, stateDir: string, name: string, sha: string): string {
  const root = worktreesRoot(stateDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  const res = git(["worktree", "add", "--detach", path, sha]);
  if (res.exitCode !== 0) {
    throw new Error(`git worktree add failed (exit ${res.exitCode}): ${res.stdout.slice(0, 300)}`);
  }
  return path;
}

/**
 * Remove one ephemeral worktree. `git worktree remove --force` handles the
 * common case; `--force` is required (not optional) because a killed job or
 * one that left untracked/modified files makes a plain `remove` refuse. An
 * `fs.rmSync` backstop runs regardless of that call's exit code: a worktree
 * whose directory was already hand-deleted, or corrupted by a crash mid-job,
 * makes `git worktree remove` error out while the directory or git's admin
 * metadata for it can still linger — and the disk-bound requirement needs
 * the directory gone, not just a clean git exit code. `git worktree prune`
 * clears any leftover admin metadata afterward. Best-effort and idempotent:
 * safe to call on a path that is already gone.
 */
export function removeJobWorktree(git: GitRunner, path: string): void {
  git(["worktree", "remove", "--force", path]);
  rmSync(path, { recursive: true, force: true });
  git(["worktree", "prune"]);
}

/**
 * Reap worktrees left behind by a tick that crashed or was killed mid-job.
 * runJob's own removeJobWorktree call is in a `finally`, which only fires if
 * the tick PROCESS survives to run it — a per-job timeout kill only kills the
 * spawned `claude` child (spawn.ts's existing handle.kill()), so that path is
 * already covered; this covers the outer `bun scheduler.ts tick` process
 * itself dying (host OOM-kill, LXC restart) before its own finally runs.
 * Safe to call unconditionally at the start of every tick: the per-tick lock
 * (state.ts acquireLock) guarantees no other tick is using worktreesRoot
 * concurrently, so anything found here is orphaned from a previous tick, not
 * live. Returns the count reaped for the caller's own observability field.
 */
export function reapStaleWorktrees(git: GitRunner, stateDir: string): number {
  const root = worktreesRoot(stateDir);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0; // worktrees dir never created — nothing to reap
  }
  for (const name of entries) removeJobWorktree(git, join(root, name));
  return entries.length;
}
