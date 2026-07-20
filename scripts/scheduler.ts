// Durable scheduler (#114) Task D: the cron entry point. Subcommands:
//   tick (default) — one poller pass (src/scheduler/tick.ts)
//   health         — operator probe (task D-Health)
// Refuses to run (exit 2, usage) when SCHEDULER_STATE_DIR is unset: a bare
// workstation `bun scripts/scheduler.ts` must never fire four live LLM jobs
// by accident (the no-live-calls rule, enforced as an exit code). The host
// env file (runbook E1 step 5) is what sets the three variables; `git pull`
// of the checkout belongs to the E1 wrapper, not here.
import { spawnSync } from "node:child_process";
import { defaultBreaker, loadBreakers, manualReset, saveBreakers } from "../src/scheduler/breaker";
import { health } from "../src/scheduler/health";
import { JOBS } from "../src/scheduler/jobs";
import type { Spawner } from "../src/scheduler/spawn";
import { JOB_IDS, type JobId } from "../src/scheduler/state";
import { tick, type GitRunner } from "../src/scheduler/tick";
import { makeUsageFetcher } from "../src/scheduler/usage-poll";

function usage(msg: string): never {
  console.error(msg);
  console.error(
    "usage: SCHEDULER_STATE_DIR=... SCHEDULER_CHECKOUT=... SCHEDULER_SECRETS=... bun scripts/scheduler.ts [tick|health|reset-breaker <job|--all>]",
  );
  process.exit(2);
}

const cmd = process.argv[2] ?? "tick";
if (cmd !== "tick" && cmd !== "health" && cmd !== "--health" && cmd !== "reset-breaker")
  usage(`unknown subcommand: ${cmd}`);

const stateDir = process.env.SCHEDULER_STATE_DIR;
if (!stateDir) usage("SCHEDULER_STATE_DIR is not set — refusing to run outside a configured scheduler host");

// health needs only the state dir — an operator probe must never demand the
// checkout/secrets wiring a read-only look doesn't use (runbook E1 step 7).
if (cmd === "health" || cmd === "--health") {
  console.log(health(stateDir, JOBS, Date.now()));
  process.exit(0);
}

// reset-breaker — the ONLY path that closes a latched dispatch breaker (stage
// 3; the breaker never auto-resets). An explicit operator action, so it lives
// behind its own subcommand and needs only the state dir. `--all` clears every
// job; a single job id clears one.
if (cmd === "reset-breaker") {
  const target = process.argv[3];
  if (!target) usage("reset-breaker needs a job id or --all");
  if (target !== "--all" && !(JOB_IDS as readonly string[]).includes(target))
    usage(`reset-breaker: unknown job '${target}' (expected one of ${JOB_IDS.join(", ")} or --all)`);
  const breakers = loadBreakers(stateDir);
  const now = Date.now();
  const targets: JobId[] = target === "--all" ? [...JOB_IDS] : [target as JobId];
  for (const id of targets) breakers[id] = manualReset(breakers[id] ?? defaultBreaker(), now);
  saveBreakers(stateDir, breakers);
  console.log(`reset-breaker: ${targets.join(", ")} → closed`);
  process.exit(0);
}

// tick — needs the checkout and secrets too.
const checkoutDir = process.env.SCHEDULER_CHECKOUT;
const secretsDir = process.env.SCHEDULER_SECRETS;
if (!checkoutDir || !secretsDir) usage("SCHEDULER_CHECKOUT and SCHEDULER_SECRETS must both be set for tick");

const gitRunner: GitRunner = (args) => {
  const res = spawnSync("git", args, { cwd: checkoutDir, encoding: "utf8" });
  if (res.error) return { stdout: "", exitCode: 1 };
  return { stdout: res.stdout ?? "", exitCode: res.status ?? 1 };
};

// Real spawner: `claude` + the flags-only argv from spawn.ts; the prompt goes
// to stdin (ENAMETOOLONG lesson). stdout is PIPED (not inherited) so runJob can
// read the `--output-format json` result envelope for the spawn's cost/usage;
// it is teed straight back to our stdout so the E1 cron wrapper's log
// redirection still captures the child's output. stderr inherits. The
// structured outcome (now including spend) lands in stateDir/logs via runJob.
const spawner: Spawner = (argv, opts) => {
  const child = Bun.spawn(["claude", ...argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "inherit",
  });
  const exited = (async () => {
    const stdout = await new Response(child.stdout).text();
    process.stdout.write(stdout); // tee to the cron log, unchanged
    const exitCode = await child.exited;
    return { exitCode, stdout };
  })();
  return { exited, kill: () => child.kill() };
};

// Stage-4 usage capture (#183): the real outbound GET to the usage endpoint,
// polled at low frequency from the tick. Token read from the secret file at
// call time, header-only, never logged.
const usageFetcher = makeUsageFetcher();

const result = await tick({ clock: Date.now, stateDir, checkoutDir, secretsDir, gitRunner, spawner, usageFetcher });
console.log(JSON.stringify(result));
