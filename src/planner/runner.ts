export interface RunResult {
  stdout: string;
  exitCode: number;
}

/**
 * The seam: claude-subscription.ts calls this instead of Bun.spawn directly.
 * Production uses defaultRunner(); tests inject a stub that returns canned
 * {stdout, exitCode} pairs -- zero tokens, zero subprocess, zero network.
 */
export type Runner = (args: string[], env: Record<string, string>, stdin?: string) => Promise<RunResult>;

/**
 * Spawns a real subprocess. Defaults to the `claude` binary on PATH; `bin` is
 * overridable so tests can point it at a harmless stand-in (e.g. `bun`) to
 * exercise the spawn/stdout/exit-code plumbing without invoking Claude.
 */
export function defaultRunner(bin = "claude"): Runner {
  return async (args, env, stdin) => {
    const proc = Bun.spawn([bin, ...args], {
      env,
      stdin: stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (stdin !== undefined) {
      const writer = proc.stdin as unknown as { write(data: string): void; end(): void };
      writer.write(stdin);
      writer.end();
    }
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { stdout, exitCode };
  };
}
