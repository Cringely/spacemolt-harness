# First-Flight Verification Checklist

The first live flight (one agent, miner persona, console-watched, started with `bun run src/main.ts` from this workstation) is **the event that discharges Plan 2's declared unknowns** — resolving the documentation ambiguity the Plan 2 council gate caught: earlier plan text said "verify during Plan 4's first live run" because flight was then assumed to happen at containerization; the flight moved earlier, the verification obligation moves with it. (Plan 4's container deployment re-verifies only the container-specific parts: env-var auth, image composition.)

## Unknowns to discharge, with concrete signals

1. **Claude CLI failure classification** — VERIFIED PRE-FLIGHT (2026-07-10): a deliberately invalid token against a clean container (claude-spike image, docker-staging) returned exit code 1 and this envelope verbatim (full capture preserved as classifier-fixture provenance):
```json
{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"duration_ms":2111,"duration_api_ms":0,"num_turns":1,"result":"Failed to authenticate. API Error: 401 Invalid bearer token","stop_reason":"stop_sequence","session_id":"de1fe80c-08d8-40bf-9bc7-36708f468ca5","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"terminal_reason":"api_error"}
``` Classifier updated to key on `api_error_status` (fix/classifier-ground-truth). Remaining sub-unknown: the rate-limit variant (expected `api_error_status: 429`) — watch for the first natural `planner_subscription_limit` event; if a real rate-limit instead produces `planner_error` or `planner_transient` with a 429 visible in the stored payload, the classifier missed and needs its 429 branch checked. Signal location: SQLite `events` table, `type LIKE 'planner_%'`.
2. **find_route response shape** — first `travel_to` step in a plan. Success signal: `action` events showing sequential jumps. Failure signal: immediate `blocked` step with reason mentioning route/shape → fix `nextHop()` in src/agent/executor.ts (one function, isolated).
3. **Ollama structured-output subset** — first replan on an ollama-planner agent. Success: valid plan first try. Acceptable: one retry then valid (schema keyword partially honored). Failure: `planner_error` after retry → inspect stored stdout payload, adjust `PLAN_JSON_SCHEMA` keywords in src/planner/ollama.ts.
4. **Subscription cooldown default (60 min)** — unverifiable until a real window closes. Signal: after a `planner_subscription_limit` cooldown, does the next attempt succeed (window actually reset) or immediately re-limit (default too short)? Tune `subscription_cooldown_minutes` in agents.yaml from observation.

## Go/no-go preconditions (all met except the go itself)

- [x] 129 offline tests green, typecheck clean
- [x] Token-invalid path verified against real CLI output
- [x] Registration code + token in secrets/
- [x] Gate 2 blocking items closed
- [ ] **User's explicit go** — agents play publicly under the user's account; inferred consent is not consent

## During flight, watch for

Wake-reason distribution (heartbeat-dominant = plans too short), reflex events (auto-refuel working), any `status_error` (safety-wake path degrading), session displacement (only one connection per account — don't run the MCP dashboard session and the harness for the same character simultaneously).
