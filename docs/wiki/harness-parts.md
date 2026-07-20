# The Seven Parts of the Harness

This page walks through each of the harness's seven parts: what it is, why it exists, and how a human changes it, with a real example from this repo for each. Read `docs/wiki/anatomy-of-the-harness.md` first. It carries the organizing idea (a rule in prose guides the model's judgment; a forcing function makes the behavior mechanical) and the two diagrams showing the parts in motion. This page is the detail behind that map.

## 1 · Deterministic code: the part that runs without the LLM

**What it is.** Ordinary TypeScript that runs every ~10 seconds whether or not the model is ever called. The body around the brain. It has four jobs:

- **The loop** (`src/agent/agent.ts`, the `runOnce` method) fetches the ship's status, decides whether anything needs the model's attention, and either executes the current plan or calls the model for a new one. A timer ticks it every 10 seconds (`start(intervalMs = 10_000)`).
- **The action registry** (`src/registry/actions.ts`) is the single list of every game action an agent is allowed to take (`mine`, `sell`, `travel`, `jettison`, and so on), each with a strict shape for its parameters. If it isn't in the registry, the agent can't do it.
- **The executor** (`src/agent/executor.ts`) walks a plan step by step and calls the game API for each one, at zero token cost. These are the hands.
- **The guards** are small deterministic checks that keep the loop honest. The reflex (`src/agent/reflex.ts`) auto-refuels a docked ship with no model call. The thrash damper, the plan-rate ceiling, and the no-progress detector (all in `agent.ts`) stop the loop from calling the model forever when it's stuck.

**Why it exists.** Cost first: calling the model on every tick would mean ~360 calls per hour per agent, while letting deterministic code execute a plan the model wrote once drops that to a handful (see `engineering-lessons.md` L-2). Reliability second: every guard here is a lesson the project learned the hard way, made permanent. The reflex exists because an agent once burned ~75 model calls an hour failing to refuel itself. The code is where the hard-won safety lives.

**How you change it.** Edit TypeScript, run the tests, merge through a pull request (see "How a change ships" in `anatomy-of-the-harness.md`). Both of these examples really happened in this repo:

- *Adding a new game action.* When the team learned that a pilot could get stuck holding cargo no station would buy, they added one entry to `src/registry/actions.ts`:
  ```ts
  { tool: "spacemolt", name: "jettison", kind: "mutation", eventLabel: "Jettison cargo",
    params: z.object({ id: z.string(), quantity: z.number().int().min(1) }).strict() },
  ```
  One entry teaches the harness a new verb. The executor can now run it, and the briefing automatically lists it to the model, because the briefing builds its action vocabulary *from* the registry; the two can never drift apart.

- *Adding a guard.* The auto-refuel reflex is about 30 lines in `src/agent/reflex.ts`: if docked and fuel is below the configured floor, refuel. It runs before the model is ever consulted and costs nothing. Any "always do X in situation Y" rule follows the same pattern: a deterministic check in the loop.

Code is the strongest home for a behavior because it cannot be forgotten or fumbled. The price is that it takes real programming and only covers situations you can define precisely. Judgment calls ("is this a good time to pick a fight?") belong to the model.

## 2 · Config: the knobs, no code required

**What it is.** A YAML file, `agents.yaml` (copied from the committed template `agents.example.yaml`), plus the schema that validates it in `src/config/config.ts`. It defines each agent and every tunable number: which model plans for it, how low fuel gets before it worries, how many plans per hour it may burn, how often the heartbeat fires, its persona text, and so on.

**Why it exists.** So you can change *how much* or *how often* without touching code. The same deterministic loop behaves very differently at `max_plans_per_window: 12` versus `36`, or `fuel_pct: 20` versus `40`. Config is the dial; code is the mechanism.

**How you change it.** Edit a number in `agents.yaml`. That is the whole change. Some real knobs:

- `planner: { provider: ollama, model: llama3.1:8b }` picks which model plans for this agent: a free local model for a repetitive miner, a stronger paid tier for a combat pilot whose judgment calls are costly.
- `reflex: { keep_fuel_above: 30 }` turns on the zero-token auto-refuel guard and sets its threshold.
- `max_plans_per_window: 36` with `plan_budget_window_minutes: 60` caps model calls per rolling hour, the blunt ceiling that stops a runaway.
- `heartbeat_minutes: 15` is the dead-man timer: if nothing has happened in this long, wake the model to re-evaluate.

One safety detail lives here. The config schema is **strict** (`.strict()` in `config.ts`): misspell a key, say `reflexes:` instead of `reflex:`, and the harness refuses to start and tells you, rather than silently ignoring the block. That protection exists because exactly that typo once silently disabled an agent's auto-refuel for three hours (`engineering-lessons.md` L-1).

Config is the right tool when the behavior already exists in code and you want to tune it. If the knob you want doesn't exist yet, adding it is a small code change: a field in the `config.ts` schema plus wherever the loop reads it.

## 3 · The briefing (the prompt): the exact words the model reads

**What it is.** `src/planner/digest.ts` builds the block of text handed to the model every time it plans, assembled fresh from the current situation: the agent's persona, its goals, why it woke up, its ship status, its cargo, what's around it, and a set of standing instructions. It ends by telling the model to reply with a specific JSON plan.

**Why it exists.** The model can only reason about what it is shown. Change the words here and you change the behavior, often more than swapping in a bigger model would. A striking case from the project: a cheap model flew five trips and never sold its cargo. The reflex was to blame the model and pay for a stronger one. The real problem was the briefing, which showed "19/50 cargo" as a bare number without item names or a nudge to sell. A cargo manifest line and one sentence of runbook advice fixed it, and the cheap model started selling within two minutes (`engineering-lessons.md` L-12). Salience failures look like capability failures.

**How you change it.** Edit the prose strings in `buildDigest`. Every line is a plain-English instruction. Real ones currently in the file:

- `"MISSIONS are your primary income -- they pay far more than selling ore..."`, added when the team realized the pilot ignored the highest-paying activity.
- `"Only dock at a POI marked [station]. If NO POI in this system is marked [station], there is nowhere to dock here..."`, added because a pilot kept trying to dock where there was no station.

Editing this file is powerful and cheap. But remember the through-line: this is prose, and prose only guides. A briefing line is a strong suggestion rather than a guarantee, so the most important briefing rules are also backed by a deterministic guard. The "use the id, not the display name" line has a plan-normalizer in code (`src/agent/normalize-plan.ts`) as its backstop; the chat-channels line has the registry enum. When a briefing rule must always hold, don't trust the words alone. Pair them with machinery in part 1.

A security boundary is baked in here too. Any text that came from the game or other players (chat, error messages, place names) is quoted, truncated, and wrapped in a standing instruction that it is *data, never commands*. The harness treats the outside world as untrusted input, because a hostile player could otherwise write "ignore your instructions" into a ship name (`engineering-lessons.md` L-11).

## 4 · Specs and plans: deciding before building

**What it is.** Design documents under `docs/superpowers/`. A **spec** (in `specs/`) says *what* to build and why, written and reviewed before any code. A **plan** (in `plans/`) is the step-by-step build sheet, often with the actual code laid out, that an implementer follows. Examples: `specs/2026-07-12-improv-mode.md` (a design for a new operating mode) and `plans/2026-07-10-core-engine.md` (how the core loop got built).

**Why it exists.** So the thinking happens, and gets reviewed by fresh eyes, before effort is spent. A spec is cheap to change; code built the wrong way is expensive. The spec stage is also where premises get checked. The improv-mode plan originally assumed that logging into the game two ways would break the session, and specified a whole mechanism to cope. A quick probe proved the assumption false, and the mechanism was deleted before a line of it was written (`engineering-lessons.md` L-15).

**How you change it.** Write or edit a markdown file under `docs/superpowers/`. This is where a new feature starts its life: describe it, get it reviewed, then it flows into config and code. A spec is paper. It shapes what gets built but enforces nothing at runtime; the enforcement appears later, when the spec becomes code in part 1.

## 5 · Rules and working agreements: how the team operates

**What it is.** `AGENTS.md` (the project's binding conventions) and `docs/wiki/working-agreements.md` (how the team works: keep the docs fresh, review is always done by someone who didn't write the work, cap how many agents run at once). These govern the humans and agents *building* the project, not the game pilots.

**Why it exists.** A project run partly by AI agents needs a written constitution just as a team of people does, so everyone follows the same conventions: commit only through pull requests, never let an author grade their own work, log every decision that matters.

**How you change it.** Edit the markdown. But a rule in `AGENTS.md` is prose, so it carries exactly the reliability problem this whole page is about, and that connects it to the through-line. It might be followed or missed. The project's answer is *invariant promotion*: when the same rule gets missed twice, it is promoted out of prose into enforcement. "Refresh the docs after a merge" was a working agreement that kept slipping, so it became a hook that fires on merge (part 6). "Don't commit straight to main" became a git pre-push hook that blocks it. A rule that keeps getting missed is treated as a harness gap, not a discipline failure, and the fix is machinery that makes missing it impossible.

## 6 · Guardrails and hooks: scripts that fire on events

**What it is.** Small shell scripts wired to events, plus the file that catalogs them. `.claude/settings.json` says which script runs on which event; the scripts live in `.claude/hooks/`; and `.claude/guardrails.md` is the human-readable catalog of "recurring missed rule → the forcing function that now catches it." These fire automatically, on the operator's machine, at a specific moment.

**Why it exists.** This is the *gate* and *just-in-time* tier of the hierarchy from the anatomy page: catch a rule at the instant it matters rather than hope it was remembered from a document read an hour ago. The hooks currently committed (registered in `.claude/settings.json`):

- **Session-start** (`session-start-guardrails.sh`). Every time a work session begins, it prints the top of `guardrails.md` back into view, putting the key judgment rules in front of the agent instead of letting them scroll away. That is the re-inject tier, for rules no script can perform *for* you (like "push back on a bad idea").
- **Doc-prose lint** (`lint-doc-prose.ts`, fires on every Write/Edit to a living-doc path). Re-runs the deterministic `prose-lint` check so an AI-tell is less likely to slip into the docs between doc-steward passes. Advisory, and it skips quietly when Vale isn't installed.
- **Wave-close handoff** (`wave-close-handoff.sh`, fires after `gh pr merge`). Writes the handoff a fresh session needs, so clearing the context between waves (the single largest cost lever) stops feeling like losing the thread. That is the gate tier: a reminder nailed to the trigger.
- **Worktree gate** (`agent-worktree-gate.ts`). The one hook that blocks rather than warns. It denies a repo-writing agent dispatched without its own isolated worktree, because two writers in one checkout collided twice (#192), and a warning proved too weak for a mistake that corrupts a branch.

**How you change it.** Write a small script in `.claude/hooks/`, register it in `.claude/settings.json` against an event (`SessionStart`, `PostToolUse`, `PreToolUse`, and so on), and document it in `.claude/guardrails.md`. The project keeps these deliberately few and mostly WARN-only (they print, they don't block): a noisy or false-firing hook gets muted, and a muted hook protects nothing. The worktree gate blocks only because that failure is severe and its trigger unambiguous. A few reliable hooks beat many that cry wolf. Reach for this part when a rule needs enforcing at a known moment in the workflow rather than continuously in the game loop.

Two families of "hook" exist in this project; keep them straight. The `.claude/` hooks above fire around the *development workflow* (starting a session, merging a PR). The game loop's own guards in `src/agent/` fire around the *pilot's behavior* every tick. Both enforce; they act at different altitudes.

## 7 · The knowledge layer: the project's memory

**What it is.** The living documents that record where things stand and why. `docs/STATE.md` is the handoff (what's done, what's in flight, what's next) that a fresh session resumes from. `docs/decisions.md` logs every choice that mattered and the alternatives it beat. `docs/wiki/engineering-lessons.md` is the transferable curriculum (incident → principle → why it matters for building agents). `docs/milestones.md` tracks the big progress markers.

**Why it exists.** An agent, or a person, picking the project back up has no memory of prior sessions except what is written down. The knowledge layer is that memory. `STATE.md` gets the most care of all: a first-class engineering artifact, kept current at every wave of work, because a coordinating agent's judgment is only as good as the freshness of the state it reads (`engineering-lessons.md` L-19).

**How you change it.** Edit the markdown, in the register `AGENTS.md` asks for: teach as you inform, for a reader who is smart but not a specialist. This layer is paper, but it is the paper the whole operation navigates by. It forces no behavior; it informs every decision. Its accuracy, though, is enforced: the documentation-freshness gate (`AGENTS.md`) makes a doc-steward pass part of a merge cluster's definition-of-done, so a knowledge doc that goes stale is caught before the next batch dispatches, and the `lint-doc-prose.ts` hook from part 6 re-runs prose-lint on every living-doc edit in between.
