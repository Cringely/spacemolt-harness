# Operating the Harness

A reference for running the SpaceMolt harness and understanding its dashboard. This page assumes you've already installed Bun and configured your `agents.yaml` and `secrets/` directory.

## Starting the harness

Run:
```bash
bun run start
```

This is equivalent to `bun run src/main.ts` and starts three agent loops simultaneously. On startup, the harness reads:
- **`agents.yaml`** (path overridable via the `HARNESS_CONFIG` environment variable): agent personas, wake tuning, planner configurations
- **`secrets/` directory** (overridable via `HARNESS_SECRETS`): SpaceMolt passwords, registration codes, and optional API tokens

### First-run registration

If you're registering new agents for the first time, the harness needs a registration code from SpaceMolt's dashboard. Obtain one at https://spacemolt.com/dashboard and save it to `secrets/registration_code`. 

On first start, the harness checks for each agent: if no password file exists in `secrets/<agent_name>_password`, it registers the character with SpaceMolt, saves the returned password, and logs in. This process is idempotent — if the password file already exists, the harness skips registration and logs in directly. You can run the harness again without re-registering.

## Stopping the harness

Press `Ctrl-C` to send a SIGINT (interrupt signal) to the harness. This gracefully stops every agent's timer loop, closes the dashboard server, and closes the SQLite database connection cleanly. No data loss occurs — the plan cursor (a bookmark marking exactly which step ran last) is persisted to the database on every step transition, not only on shutdown, so restarting the harness resumes where it left off.

## Dashboard URL

The dashboard is served at:
```
http://<dashboard_host>:<dashboard_port>
```

Default: `http://127.0.0.1:8642`

To change the address, edit `agents.yaml` (the config schema, `src/config/config.ts`, uses flat keys, not a nested block):
```yaml
dashboard_host: 127.0.0.1
dashboard_port: 8642
```

### LAN access and security

You can bind the dashboard to a LAN interface IP (e.g., `192.168.1.100`) to access it from other machines on your network. Set `dashboard_host` to that IP in `agents.yaml` and restart the harness.

**Warning: this is development-only.** The dashboard in Plan 3 has no authentication built in. Any device on your LAN can reach it and send instructions to your agents. In Plan 4 (containerization), the dashboard will be served only behind the reverse proxy and SSO forward-auth with no direct published host port. See [Security Baseline](security-baseline.md) for the full chain-of-custody rules.

## Reading the panels

Each agent gets its own panel on the dashboard showing live status, the current plan, and health metrics.

### Plan state

The panel displays the agent's current plan state as one of four values:

- **`none`** — The agent has no plan in memory. This is the initial state at startup and occurs if an instruction cancels the current plan.
- **`running`** — The agent is executing a plan step by step each game tick.
- **`done`** — The agent completed its plan successfully. It will replan on the next wake.
- **`blocked`** — The current step cannot complete (e.g., cargo is full but the step tried to mine, or a destination POI was not found). The step failed, and the planner will be woken to replan.

### Goal and step counter

The panel shows the agent's current goal and which step it's on (e.g., "step 3 of 7"). A goal is a high-level objective (e.g., "accumulate 5000 credits"). The step counter tells you the harness is progressing tick by tick through the plan.

### Planner-health badges

Four badges indicate the health of the planner loop. They turn red when the condition is true; you can hover for a tooltip. Here's what each means and what to do:

- **`stalled`** (red = transient failures maxed out) — The planner hit five consecutive transient failures (network timeouts, game server 5xx errors, etc.) and stopped retrying. The agent still runs (executing the last valid plan or idle), but no new planning happens. **What to do:** Check your network connectivity and whether the game server is up. If Ollama is your fallback planner, verify it's running. Once the issue clears, the heartbeat (see below) will retry and clear the stalled state.

- **`fallback`** (red = using fallback planner) — The configured primary planner ran out of tokens for this subscription window, and the agent switched to its fallback planner (usually Ollama). The agent keeps running, but with a different model. **What to do:** This is informational; nothing breaks. The fallback is intentional. Wait for the subscription window to reset, and the agent will resume using the primary planner.

- **`claude-disabled`** (red = Claude OAuth token is invalid) — The `secrets/claude_oauth_token` is missing, invalid, or expired. **What to do:** Verify the token file exists and is valid. Restart the harness after fixing it.

- **Backoff badge** — Shows a timer if the planner is in exponential backoff after a transient failure. This is temporary and clears as it retries.

### Wake-reason histogram

The histogram shows a breakdown of why the agent has replanned over the last 24 hours. Each bar represents a wake reason:

- **`heartbeat`** — Replanning due to the dead-man timer (default 15 minutes). Too many heartbeat wakes means your plans are too short; the agent is finishing its plan and idling between ticks, waking only to re-check. Consider editing the agent's persona in `agents.yaml` to make longer plans.

- **`blocked`** — Replanning because a plan step couldn't complete. Too many blocked wakes mean the planner is overestimating what's possible (e.g., assuming cargo capacity when full). This usually clears as the planner learns.

- **`low_fuel`**, **`low_hull`** — The agent's fuel or hull dropped below the configured threshold and woke for an emergency replan. This is working as designed.

- **`instruction`** — The agent was steered via the instruction box. See below.

- **`no_plan`** — The agent had no plan in memory at the last wake (e.g., startup, or after an instruction aborted the plan).

- **`plan_done`** — The agent finished its current plan successfully and woke to get a new one. A healthy, expected reason to see in the histogram — it means plans are completing rather than stalling or getting aborted.

- **`notification`** — The game sent the agent an event worth reacting to immediately (e.g., combat or a chat message), and the agent's `wakeNotificationTypes` config includes that type. Frequent notification wakes are normal for an agent configured to watch chat or combat closely; if they're crowding out other planning, narrow `wakeNotificationTypes` in `agents.yaml`.

### Usage numbers

The "replans/24h" badge shows how many times the planner was invoked in the rolling 24-hour window. Below it is the wake-reason histogram.

**Important caveat:** The counter reports `replanAttempts`, which counts "wake" events, not raw LLM calls. A single wake might trigger multiple retries of the planner (if the model throws a transient error and the agent retries). The field is deliberately named `replanAttempts` rather than `callsToday` to acknowledge this inexact count. It's honest: a count of 4–10 per hour per agent is normal; if you see 100+ in an hour, something is thrashing.

### Live event feed

Below the metrics is a scrolling feed of events: every action the agent took ("mine ore", "jump to system"), every time the planner ran ("plan created: 5 steps"), and every time the agent received a notification ("attacked by agent X", "hull at 30%"). This is your real-time view of what the agent is doing.

## The instruction box

At the top of each agent panel is a text input field labeled "instruction." Type a directive here (e.g., "go to station Alpha and dock") and press Enter to send it.

### What happens

When you send an instruction:
1. The current plan is aborted immediately.
2. The instruction is recorded as a goal entry in the agent's persistent goal list.
3. The agent wakes the planner, which produces a new plan honoring the instruction.
4. The agent executes the new plan from the next tick onward.

This is a one-shot input with a persistent effect. The instruction is stored as a goal and stays live after the first plan: every later planning pass shows the newest instruction in a dedicated "standing operator instruction" block until the planner reports the work carried out (a flag in its plan output), at which point the instruction retires from the goal list. A newer instruction supersedes an older conflicting one. Before this re-raise existed, an instruction steered exactly one plan and then lost out to mission work (issue #355).

### Length limit

The instruction box enforces a 500-character maximum. This limit is a security boundary, not a UX limit. The instruction text is injected into the planner's prompt, and the bound contains prompt-injection attacks. The instruction reaches the exact same planner prompt the agent uses for all reasoning — it is not a separate chat window or a sandboxed input; it's part of the control loop.

## Running a codex-subscription pilot

`codex-subscription` is a planner backend (#311) that drives OpenAI's Codex CLI signed in with your ChatGPT subscription. Like `claude-subscription`, it costs nothing per call beyond the subscription you already pay for, and it draws from a separate weekly quota pool, so a pilot can fall back from one vendor to the other when a window runs dry. Before a model flies, gate it offline with `bun run eval:planner --provider codex-subscription --model gpt-5.6-terra` (that model scored 100% on the offline eval, 2026-07-17).

### Providing codex auth

Codex manages its own credential; the harness never touches it beyond checking the file exists. Codex writes this token and refreshes it as it runs, so it lives in a directory the container can write to and that survives a restart: `CODEX_HOME`, a bind-mount to a dedicated `codex-home` host directory. Codex rewrites `auth.json` on each refresh, so unlike the Claude token it cannot be a read-only Docker secret; a read-only mount would break the first refresh. Place the initial token one of two ways.

Primary path, device-auth from inside the container (no browser needed on the host). The container now includes the codex CLI, so you authenticate in the running container itself:

1. Create the `codex-home` host directory and make it writable by the container user (UID 10001) before first run:
   - Local or staging: `./secrets/codex-home`
   - Production host: `<prod-ops-dir>/secrets/spacemolt/codex-home`
2. Start the stack, then run `docker exec -it spacemolt-harness codex login --device-auth`. Codex prints a short code and a URL; open the URL on any device, enter the code, and sign in to ChatGPT. Codex writes `auth.json` into `CODEX_HOME` and refreshes it there from then on. Because the directory is a persistent bind-mount, the refreshed token survives the routine deploy restart.

Alternative, if you already ran `codex login` on your own machine: copy that `~/.codex/auth.json`, unchanged and still called `auth.json`, into the same `codex-home` directory at mode `0644`, owned by UID 10001. Codex picks it up and refreshes it in place. Do not drop it into a read-only secret mount; codex must be able to rewrite it.

Both the codex CLI and the planner find the token at `$CODEX_HOME/auth.json`. We never commit, log, or print it. If it is missing or invalid the agent reports a token-invalid failure and stops calling, the same way a bad Claude token behaves.

### Flipping an agent to codex (deploy step)

This flip is safe only once the writable, persistent `CODEX_HOME` from the previous section is in place and holds a valid `auth.json`. A read-only or ephemeral codex home is not merely suboptimal here; it breaks the pilot on the first token refresh (a read-only mount) or the first restart after one (an ephemeral one), so confirm the `codex-home` bind-mount and its token before you touch `agents.yaml`.

This is applied on the host at deploy time by editing the live `agents.yaml`, not in code. To fly `gpt-5.6-terra` on the miner as a monitored experiment, set its planner block to:

```yaml
    planner: { provider: codex-subscription, model: gpt-5.6-terra }
    fallback_planner: { provider: ollama, model: llama3.1:8b }
    experiment: { revert_if_no: exchange_items_sold, within_hours: 2 }
```

The `experiment` block is the deterministic exit condition (#251, #240): the harness watches one named progress counter and, if it has not advanced within `within_hours`, latches the agent onto its `fallback_planner` and emits an `experiment_reverted` event. The switch is one-way; it never flips back until you change this block. Here the counter is `exchange_items_sold` (the miner's real "did it actually sell anything" signal) and the window is 2 hours. A `fallback_planner` is required whenever `experiment` is present, or the config is rejected at load. Valid `revert_if_no` values are any single progress-counter name (see `PROGRESS_COUNTERS` in `src/agent/no-progress-detector.ts`) or `any`, which sums every progress dimension.

## Logs

The harness logs every event to standard output (stdout) as it happens. Each line is one event in JSON format:

```json
{"agentId":"miner","ts":1720646400000,"type":"action","payload":{"action":"mine","outcome":"ok"}}
```

**Current limitation (honest flag):** This is the only log sink. There's no log rotation, no structured log aggregation, and no persistence beyond the current terminal session. The event table in SQLite holds the permanent record (accessible via the REST API and dashboard); stdout is for immediate observation only.

To persist logs across terminal sessions, redirect output to a file:
```bash
bun run start > harness.log 2>&1
```

This captures both stdout and stderr. For long-running deployments, consider shipping this to a log aggregator (Plan 4 territory).

## Common operations

### Restarting the harness

Restart the entire harness with `Ctrl-C` followed by `bun run start` again. 

**What survives a restart:**
- Plan cursor (resumes mid-step)
- Goals (persistent goal list)
- Event history (SQLite)

**What resets:**
- In-flight backoff/stall state (fresh start, which is intentional — a supervised restart is a chance to reset transient failures)
- Live badges (they rebuild from recent events)

### When to use the instruction box

Use the instruction box when you want to **immediately change course** without restarting. Example: "dock now" to pull an agent out of mining and send it to station for trading.

**Do not use it as a chat.** Each instruction wakes the planner and consumes tokens (or capacity if using a metered backend). Use it sparingly.

### Watching vs. intervening

The harness is designed to run unattended. Check the dashboard occasionally to verify agents are progressing (credits growing, systems explored). If you see:

- **Red `stalled` badge:** Check network/game-server status. Wait for the next heartbeat to auto-retry, or restart the harness if the issue persists.
- **Red `claude-disabled` badge:** Fix the token and restart.
- **Too many heartbeat wakes:** Edit the agent's persona to be more ambitious.
- **Agents stuck on blocked wakes:** Let the planner learn, or steer with an instruction.

Otherwise, let them fly.
