# What a Harness Is (and why loops matter)

Plain-language reference for the core concepts this project is built to teach. Infra analogies throughout.

## The brain in a jar

An LLM by itself is inert. Text goes in, text comes out, then nothing. It keeps no memory between calls, has no sense of time, and cannot check state, act, or notice events. One call produces one thoughtful answer that evaporates.

## The harness: giving the brain a body

A harness is all the ordinary software wrapped around a model to make it an *agent*.

| Harness part | What it does | In our harness |
|---|---|---|
| Senses | Gather state, feed it in | Poll ship status + notifications each iteration |
| Hands | Turn model output into real actions | Validated calls to the game API (action registry) |
| Memory | Persist across calls | SQLite event log, plan + step cursor (a bookmark marking exactly where execution left off), goals |
| Guardrails | Contain bad output and bad luck | Zod schema validation (checking that data actually has the shape it's supposed to), retries, rate-limit absorption, session recovery |
| Gas gauge | Meter the spend | Token/usage metering per agent (dashboard, Plan 3) |

Config-management analogy: the model is the *policy* (what should be true); the harness is the *agent* that reads current state, compares, acts, and handles failure.

## The loop: turning thoughts into behavior

One model call is one thought. Behavior takes a loop: **gather → decide → act → observe → repeat.** It's a control loop; the thermostat is the exact analogy: sensor, setpoint comparison, actuator, wait, repeat. The loop is what makes a system autonomous instead of interactive.

## The craft: where in the loop does the brain sit?

The expensive design decision in any agent harness. A naive loop calls the LLM every iteration, a consultant on speed-dial for every thermostat tick. Our answer (see the decision log: plan-then-execute):

- The LLM writes a short runbook occasionally (the *planner*)
- Deterministic code executes it tick by tick at zero token cost (the *executor*)
- **Wake conditions**, which work like alerting rules, define when a situation needs the brain again: plan done, step blocked, attacked, low fuel, operator instruction, dead-man timer

Most harness engineering reduces to which decisions need intelligence, which need only a script, and what triggers the escalation between them.

## Harnesses all the way down

This project runs the same pattern at two altitudes:

1. **The product**: our harness loops three game agents (plan → execute → wake → replan).
2. **The process**: Claude Code is itself a harness (tools, memory files, permissions around a model), and the agent team structure adds an org-level loop on top. Dispatch → implement → review → report → repeat, with escalation paths instead of wake conditions and the PM as the planner that's called rarely.

Lessons learned at either level transfer to the other. That is the thesis of the project.

When the org-level loop needs more than one implementer and one reviewer (a scripted team of subagents fanning out over a wide task), see `docs/wiki/multi-agent-workflows.md` for what that buys and when it is worth it.
