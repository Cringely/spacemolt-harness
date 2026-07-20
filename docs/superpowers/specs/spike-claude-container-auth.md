# Spike: Claude subscription auth in a container — GO

Ran 2026-07-10 on the docker-staging VM (Docker 29.2.1, x86_64). Decision: **GO** — headless Claude Code authenticates against the user's subscription from inside a container using a long-lived token in an environment variable. Plan 2's `claude-subscription` planner can be built on this mechanism.

## What was tested

- Image: `node:22-bookworm-slim` + `npm install -g @anthropic-ai/claude-code@2.1.206` (pinned to the host's version). Dockerfile in `spike/Dockerfile`.
- Auth: token minted on the host with `claude setup-token`, stored at `secrets/claude_oauth_token`, passed as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable. Passed by env-var inheritance (`-e CLAUDE_CODE_OAUTH_TOKEN` with the value in the client environment), so the token never appears on a command line or in the image.
- Invocation: `claude -p "Reply with exactly the word: pong" --output-format json`, run twice.

## Results

Both runs succeeded (`"subtype":"success"`, `"result":"pong"`). No writable Claude home directory was needed — the long-lived token path sidesteps the OAuth refresh-write problem entirely, so Test B (persistent volume login) was not needed.

Numbers that matter for the cost model:

- Per-call token overhead for a trivial prompt: ~3,073 input tokens (Claude Code's system prompt) plus prompt-cache reads (~23–28k tokens read, cheap tier). First call created a 1-hour cache entry (~5,277 tokens); the second call reused it with zero cache creation — so bursts of planner calls within an hour share the cached prefix.
- Latency: ~1.5s API time on the warm call; container spawn adds roughly 1–2s. Irrelevant next to the game's 10-second tick.
- Default model resolved to Sonnet; Plan 2 should pass an explicit `--model` per the tiering config rather than relying on defaults.

## Follow-ups for Plan 2

1. The planner invocation should minimize overhead: no MCP servers, restricted tools (the ~3k system-prompt tokens are the floor; MCP/tool definitions would add to it). Evaluate `--strict-mcp-config` and tool restrictions, or the Agent SDK in-process as the plan already contemplates.
2. Token lifecycle: `claude setup-token` tokens are long-lived but do expire eventually — treat "token invalid" as a distinct planner failure class (surfaces as an auth error, not a rate limit) that alerts the operator rather than retrying.
3. Final harness image needs bun + the claude CLI in one image (node base with bun installed, or bun base with node — decide in Plan 4; the spike image is node-only by design).
4. The `claude-spike` image is left on docker-staging for Plan 2 integration testing; remove with `docker rmi claude-spike` when no longer useful.
