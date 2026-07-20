# SpaceMolt Harness Plan 4: Containerization + Domain Deployment

> **For agentic workers:** Execution follows `docs/wiki/team-structure.md`'s batch model. Batch J (Tasks 1-3): production Dockerfile, docker-compose.yml, preflight gate + `.dockerignore` — fully offline, buildable and testable without touching docker-staging or any live service. Batch K (Tasks 4-5): deploy runbook (executable against docker-staging) + operations doc. **Batch K cannot be offline-tested** — see "Declared deviation" below. No council gate is scheduled in the spec's phasing for this plan; the deploy runbook's own verification checklist (Task 4) is the gate, and it runs against the real docker-staging host with the user watching, the same posture as the first-flight campaign.

**Goal:** Ship the harness as one container — bun runtime, the harness source, and a version-pinned Claude CLI in a single image — and deploy it to docker-staging behind an existing reverse proxy and SSO forwardAuth, with no host port published. This is the last plan before the harness runs unattended in production; every constraint here traces back to the security audit (`docs/wiki/security-baseline.md`) or a named user decision (`docs/STATE.md`, spec's "Plan 4 Constraints"), not a hunch.

**Architecture:** A multi-stage `Dockerfile` (Task 1) resolves the spike's open question — "final harness image needs bun + the claude CLI in one image" (`docs/superpowers/specs/spike-claude-container-auth.md`, follow-up 3) — by giving each runtime its own trusted install path instead of forcing one base image to serve both: the `claude` CLI installs via its official npm package onto a `node:22-bookworm-slim` runtime base (security-baseline.md: "claude CLI installed only via version-pinned npm, never the curl installer" — node is the CLI's own distribution channel), and the `bun` binary is copied in from the official `oven/bun` image via a multi-stage `COPY --from=`, never curl-installed, never apt-installed. A dedicated `test` build stage runs `bun test`, `tsc --noEmit`, and `bun audit` (via `scripts/preflight.ts`, Task 3) and the final stage's only path to existing is a `COPY --from=test` of a marker file — so a failing gate makes the image un-buildable, not just un-recommended. `docker-compose.yml` (Task 2) runs that image hardened (`no-new-privileges`, `cap_drop: ALL`, `read_only: true` with a bounded `tmpfs` for `/tmp`), with SQLite on a named volume, `secrets/` bind-mounted read-write (the harness itself writes newly-registered agent passwords there — see Task 2's note), and the container joined to an existing external reverse-proxy network with router labels for `spacemolt.<domain>` behind SSO forwardAuth. No `ports:` stanza — the dashboard is reachable only through the proxy.

**Tech Stack:** unchanged runtime — Bun ≥ 1.2.21, TypeScript, Zod as the only npm dependency; this plan adds none. New tooling, all external to the harness itself: Docker (multi-stage build, BuildKit), Docker Compose, an existing reverse-proxy + SSO stack (referenced, never reconfigured by this plan), SSH + git for deployment (no rsync/scp, per a git-based deploy convention).

**Spec:** `docs/superpowers/specs/2026-07-10-spacemolt-harness-design.md`, "Plan 4 Constraints" (binding, quoted inline where each constraint is satisfied). **Security:** `docs/wiki/security-baseline.md`, "Container" and "Secrets" sections. **Spike:** `docs/superpowers/specs/spike-claude-container-auth.md` — the env-var-token auth mechanism this plan transplants into production without re-deriving it. **Assumption stated up front:** this plan is authored assuming Plan 3 is fully merged (dashboard server exists, binds `127.0.0.1:8642` by default, host/port config-driven per `docs/superpowers/plans/2026-07-10-dashboard.md`). At authoring time Batch H (server skeleton, instruction endpoint, usage endpoint) is merged; Batch I (SPA, ops doc, main.ts wiring) is the remaining Plan 3 work. Task 5 of this plan assumes `docs/wiki/operations.md` already exists with a development-mode section from Plan 3 Batch I, and *adds* a production section to it — if Batch I lands the file with different section names, Task 5's implementer adjusts the insertion point, not the content.

## Declared deviation from the tests-are-offline rule

AGENTS.md is binding: "Tests are offline: fake server + mocked planner, zero live-game traffic, zero LLM tokens." Batch J honors this completely — the Dockerfile's test gate runs the existing offline suite inside the build, no exception needed. Batch K cannot: deploying a container to a real host and confirming reverse-proxy/SSO routing, in-container token auth, and a running agent loop are inherently live operations against docker-staging. This is a documented, one-time deviation, not a precedent — the "tests" for Batch K are a verification **checklist** (Task 4), executed once against staging with the user able to watch, in the same spirit as the first-flight campaign's console-watched sorties. Zero *game* traffic is still guaranteed beyond what the running agents themselves generate (no new live-game or LLM probes introduced by the deploy process itself).

## Global Constraints

- **Base images pinned by digest** (`@sha256:...`), never a floating tag (spec's Plan 4 Constraints; security-baseline.md "Supply Chain"). **OPERATOR-CONFIRM:** no Docker daemon was available in the authoring environment (worktree agent, no local `docker` binary) to resolve real digests for `oven/bun:1.3.14-slim` and `node:22-bookworm-slim`. Task 1's Dockerfile ships with the digest field present but unresolved (`@sha256:REPLACE_WITH_RESOLVED_DIGEST`) and the exact resolve command inline. Fabricating a plausible-looking hash would be a silent correctness bug baked into the one artifact everything else depends on — flagged instead, per the simplicity rules' "no load-bearing unknowns in plans."
- **Non-root `USER`** in the final image; **claude CLI via version-pinned npm only** (`@anthropic-ai/claude-code@2.1.206`, the exact version the spike proved, per `docs/superpowers/specs/spike-claude-container-auth.md`); **`bun install --frozen-lockfile`** for every install in the build (lockfile decides what installs, not a mood — security-baseline.md).
- **`bun audit` gate.** Runs inside the build's `test` stage via `scripts/preflight.ts`, alongside `bun test` and `tsc --noEmit`. A failing audit fails the image build.
- **Token handling.** `CLAUDE_CODE_OAUTH_TOKEN` never appears on a command line, in an image layer, or in a log line. The harness code already satisfies this by construction — `src/planner/claude-subscription.ts:47` reads the token from a **file** (`secrets/claude_oauth_token`, path configurable via `HARNESS_SECRETS`) at call time and sets it only in the *spawned child's* environment (`claude-subscription.ts:60`), never the parent process's. Compose's job is to bind-mount `secrets/` correctly (Task 2) — not to also inject the token as a compose-level environment variable, which would be a second, unused transport path for the same secret. See Task 2's note and Decision 2 in this plan's closing "Decisions for PM scrutiny" section.
- **Secrets bind-mount mode.** security-baseline.md / change-management.md invariant: "bind-mounted container secrets become 0644 — non-root container users can't read 0600." Verified already satisfied in code: `src/config/config.ts:118` writes newly-registered agent passwords with `{ mode: 0o644 }` — no code change needed. See Decision 1 in this plan's closing "Decisions for PM scrutiny" section for the corollary this task surfaced (directory-level write access, not just file-mode).
- **Compose hardening:** `no-new-privileges`, `cap_drop: ALL`, `read_only: true` with `tmpfs` where a write path is genuinely needed. No capability is dropped that the harness process actually uses (it binds a high port internally, spawns no privileged operations) — verified by absence, not asserted.
- **Dashboard exposure** (user decision, spec's Plan 4 Constraints): reachable only via the reverse proxy + SSO forwardAuth; **no published host port**; the container joins the existing external reverse-proxy network. Reverse-proxy/SSO label *values* are operator-supplied — this plan never invents a middleware or network name (see Task 2's OPERATOR-CONFIRM list).
- **Deploy is git-based**, no rsync/scp (`docs/wiki/team-structure.md`'s spirit extended to ops): clone/pull on the host over SSH, `git config core.hooksPath .githooks` as a one-time per-clone step (AGENTS.md).
- **`.dockerignore`** excludes `secrets/`, `harness.sqlite*`, `node_modules/`, `.git/`, `docs/` — the exact scope named in this plan's brief — plus a small number of obviously-necessary additions (see Task 1).
- Commit author is the user's identity only. No co-author trailers.
- Every operator-facing placeholder (domain, reverse-proxy entrypoint name, SSO middleware name, external network name, deploy path, SSH host alias) is called out explicitly as **OPERATOR-CONFIRM** at the point it appears, and summarized again in this plan's closing summary. None is guessed at.

---

## Batch J — Image + Compose

### Task 1: Production Dockerfile + `.dockerignore`

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/preflight.ts`
- Modify: `package.json` (add `"preflight": "bun run scripts/preflight.ts"` script)

**Image composition decision (the spike's open question, resolved):**

The spike (`spike/Dockerfile`) used a plain `node:22-bookworm-slim` base because the claude CLI is an npm package and deliberately punted the bun question: "final harness image composition (bun + claude) is a follow-up finding of this spike." Two shapes were considered:

1. **Rejected — bun-base image, apt-install node/npm.** `FROM oven/bun:1.3.14-slim` then `apt-get install nodejs npm`. Rejected because: (a) it pulls in Debian's apt package graph as a second, unpinned-by-digest dependency surface on top of the base image itself; (b) Debian bookworm's `apt` nodejs package is not the same build the spike verified (`node:22-bookworm-slim` is the official Node image, not a distro package) — reintroducing exactly the "did we verify this or assume it" gap the spike existed to close; (c) it still needs npm afterward for the claude CLI, so it buys nothing simpler than the alternative.
2. **Chosen — node-base runtime, bun binary copied in via multi-stage `COPY --from=`.** The claude CLI installs onto `node:22-bookworm-slim` exactly as the spike proved (official npm package, no apt, no curl). The `bun` binary is copied from the official `oven/bun:1.3.14-slim` image's `/usr/local/bin/bun` (confirmed path — `https://bun.com/docs/guides/ecosystem/docker`, the documented multi-stage pattern is literally `COPY --from=bun /usr/local/bin/bun /usr/local/bin/`) into the node-based runtime stage. Both images are Debian bookworm-based (glibc), matching the runtime base — the load-bearing assumption is that a bun binary built against bookworm's glibc runs unmodified when copied onto another bookworm image. **OPERATOR-CONFIRM (build-time smoke check):** after the first successful build, run `docker run --rm <image> bun --version` before deploying; if the copied binary fails to start (missing shared library), the fallback is `oven/bun:1.3.14-debian` (the non-slim variant, more shared libs present) as the source stage instead of `-slim`.
3. **Bun version:** pinned to `1.3.14` — not a new choice, it is the version security-baseline.md already documents as in current use ("we run 1.3.14, the fix landed in 1.3.5"). Using a different pin here would create a second bun version in the project with no stated reason.

**`Dockerfile`:**
```dockerfile
# syntax=docker/dockerfile:1
#
# Multi-stage build. Resolves the spike's open question (spike-claude-
# container-auth.md, "final harness image needs bun + the claude CLI in
# one image"): the claude CLI installs via its official npm package onto
# a node base (security-baseline.md: npm only, never the curl installer);
# the bun binary is copied in from the official oven/bun image via
# multi-stage COPY, never curl- or apt-installed. See Plan 4 Task 1 for
# the full receipt (rejected alternative: bun-base + apt nodejs/npm).
#
# Both base images MUST be pinned by digest before the first production
# build. No Docker daemon was available when this Dockerfile was authored
# to resolve the real digests — resolve them with:
#   docker pull oven/bun:1.3.14-slim && \
#     docker inspect --format='{{index .RepoDigests 0}}' oven/bun:1.3.14-slim
#   docker pull node:22-bookworm-slim && \
#     docker inspect --format='{{index .RepoDigests 0}}' node:22-bookworm-slim
# and replace the two ARG defaults below before `docker compose build`.
# OPERATOR-CONFIRM.

ARG BUN_IMAGE=oven/bun:1.3.14-slim@sha256:REPLACE_WITH_RESOLVED_DIGEST
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:REPLACE_WITH_RESOLVED_DIGEST
# Pinned to the exact version the spike verified end-to-end
# (spike-claude-container-auth.md). Bump deliberately, never floating.
ARG CLAUDE_VERSION=2.1.206

# ---- deps: full install (incl. devDependencies) — feeds the test gate ----
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- test: build gate. No path to the runtime stage skips this. ----
FROM deps AS test
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY test ./test
RUN bun run scripts/preflight.ts && touch /app/.preflight-ok

# ---- prod-deps: production-only install, keeps devDependencies (tsc,
# @types/bun, the test framework) out of the shipped image ----
FROM ${BUN_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime: node base for the claude CLI's npm install; bun copied in ----
FROM ${NODE_IMAGE} AS runtime
ARG CLAUDE_VERSION
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun

# No --create-home: ENV HOME=/tmp below is the real home; /home/harness
# would be a dead, never-read layer.
RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --shell /usr/sbin/nologin harness

WORKDIR /app
# Volume mount point created + owned before USER switch, so a fresh named
# volume mounted here inherits this ownership (standard Docker behavior:
# an empty named volume takes on the mount point's existing permissions).
RUN mkdir -p /app/data && chown harness:harness /app/data

# The build gate: this COPY only succeeds if the `test` stage's RUN
# succeeded. A failing test/typecheck/audit makes the image un-buildable.
COPY --from=test /app/.preflight-ok /app/.preflight-ok

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json bun.lock agents.example.yaml ./
COPY src ./src
RUN chown -R harness:harness /app

USER harness
# HOME=/tmp: no persistent writable Claude home is needed (the spike's
# whole point — long-lived token sidesteps the OAuth refresh-write
# problem), but HOME=/tmp gives any incidental ephemeral write
# (CLI cache/log) a place to land under the read_only + tmpfs compose
# config (Task 2) instead of failing on a read-only root filesystem.
ENV HOME=/tmp \
    NODE_ENV=production \
    HARNESS_CONFIG=/app/agents.yaml \
    HARNESS_SECRETS=/app/secrets

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "process.exit((await fetch('http://127.0.0.1:' + (process.env.HARNESS_DASHBOARD_PORT || 8642) + '/api/agents').then(r => r.ok).catch(() => false)) ? 0 : 1)"

ENTRYPOINT ["bun", "run", "src/main.ts"]
```

Note on the `HEALTHCHECK`: it calls `bun` directly rather than `curl`/`wget` — per the change-management invariant "container images may lack curl or wget; verify the binary exists before writing healthchecks that depend on it." `node:22-bookworm-slim` is not guaranteed to carry either, and bun is already in the image and already the thing that would need to be broken for the healthcheck to be meaningfully wrong.

**`.dockerignore`:**
```
secrets/
harness.sqlite
harness.sqlite-*
node_modules/
.git/
docs/
spike/
.claude/
*.md
.env
agents.yaml
```
`test/` and `scripts/` are deliberately **not** ignored — the `test` build stage needs both copied into the build context for the gate to run. `.dockerignore` governs what reaches the Docker daemon at all, not what ends up in the final image (multi-stage `COPY --from=` already controls that per-stage).

**`scripts/preflight.ts`:**
```ts
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
```

**`package.json` addition** (in `"scripts"`):
```json
"preflight": "bun run scripts/preflight.ts"
```

**Verification (offline, this task):**
- `bun run scripts/preflight.ts` passes locally before the Dockerfile is ever built (same gate, same script, zero Docker required).
- `docker build .` — build fails at the `test` stage if `bun test`/`tsc`/`bun audit` fail (verify by deliberately breaking a test locally against a scratch branch, confirming the build stops there, per verification-before-completion discipline — do this once, don't leave the breakage in).
- Image inspection: `docker run --rm <image> whoami` prints `harness`, not `root`.

---

### Task 2: `docker-compose.yml`

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example` (non-secret placeholders only, per security.md: "`.env` files: non-sensitive config only")

**`docker-compose.yml`:**
```yaml
services:
  harness:
    build:
      context: .
      dockerfile: Dockerfile
    # Tag scheme: the short git SHA of the deployed commit, supplied by the
    # deploy runbook (Task 4: HARNESS_IMAGE_TAG=$(git rev-parse --short HEAD)).
    # Never :latest — a floating tag is overwritten by every rebuild, which
    # silently destroys the previous image and with it the fast-rollback
    # promise (change-management.md: "keep previous image tags available").
    # The :?err form makes compose FAIL LOUDLY if the tag isn't set, rather
    # than quietly building an untraceable default.
    image: spacemolt-harness:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG to the short git SHA, see deploy runbook}
    container_name: spacemolt-harness
    restart: unless-stopped

    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      # 64m bounds tmpfs RAM use (tmpfs is RAM-backed); the claude CLI's
      # per-call scratch under HOME=/tmp is the only writer and is well
      # under this on a stateless single-shot invocation (spike numbers:
      # ~3k input tokens, no persistent state).
      - /tmp:size=64m

    volumes:
      - harness_data:/app/data
      # Read-write, not read-only: src/config/config.ts's ensureCredentials
      # (config.ts:118) writes newly-registered agents' password files
      # into this directory at first run, already at mode 0o644 (the
      # bind-mount invariant is satisfied by existing code — verified,
      # not assumed). See this plan's Decision 1 for the directory-level
      # corollary (host-side write permission for a non-root container UID).
      - ./secrets:/app/secrets
      - ./agents.yaml:/app/agents.yaml:ro

    env_file:
      - .env

    networks:
      - proxy

    labels:
      # OPERATOR-CONFIRM: every value below is a placeholder. Match this
      # host's EXISTING reverse-proxy/SSO conventions exactly — do not
      # invent middleware, entrypoint, or router names. Pull the real
      # values from another service already running behind the same
      # reverse proxy and mirror its pattern.
      - "traefik.enable=true"
      - "traefik.http.routers.spacemolt.rule=Host(`spacemolt.${DOMAIN}`)"
      - "traefik.http.routers.spacemolt.entrypoints=${TRAEFIK_ENTRYPOINT}"
      - "traefik.http.routers.spacemolt.tls=true"
      - "traefik.http.routers.spacemolt.tls.certresolver=${TRAEFIK_CERT_RESOLVER}"
      - "traefik.http.routers.spacemolt.middlewares=${AUTHENTIK_FORWARDAUTH_MIDDLEWARE}"
      - "traefik.http.services.spacemolt.loadbalancer.server.port=${HARNESS_DASHBOARD_PORT}"
    # Deliberately no `ports:` stanza — the dashboard is reachable only
    # through the `proxy` network, per the user's decision (spec's Plan 4
    # Constraints: "no published host port once deployed").

networks:
  proxy:
    external: true
    # OPERATOR-CONFIRM: the name of the already-existing external
    # reverse-proxy network on this host. Find it with `docker network ls`
    # on the staging host and set TRAEFIK_NETWORK_NAME in .env accordingly.
    name: ${TRAEFIK_NETWORK_NAME}

volumes:
  harness_data:
```

**`.env.example`:**
```
# Non-secret only, per security-baseline.md — passwords/tokens live in
# secrets/, never here. Copy to .env and fill in real values before
# `docker compose up`. Every value is OPERATOR-CONFIRM: pull from this
# host's existing reverse-proxy/SSO conventions, don't invent one.
DOMAIN=
TRAEFIK_ENTRYPOINT=
TRAEFIK_CERT_RESOLVER=
AUTHENTIK_FORWARDAUTH_MIDDLEWARE=
TRAEFIK_NETWORK_NAME=
# MUST equal agents.yaml's dashboard_port (default 8642) — see "Port
# consistency" note below. OPERATOR-CONFIRM.
HARNESS_DASHBOARD_PORT=8642
```

**Port consistency (`HARNESS_DASHBOARD_PORT` vs `agents.yaml`).** The harness never reads `HARNESS_DASHBOARD_PORT`: the app's listen port comes solely from `agents.yaml`'s `dashboard_port` (`src/config/config.ts:43`, wired at `src/main.ts:51`). The `.env` value exists only so the reverse-proxy `loadbalancer.server.port` label and the Dockerfile's `HEALTHCHECK` know where to point. The two values MUST be equal — if they drift, the container runs, the healthcheck probes a dead port, and the reverse proxy forwards into nothing. **Receipt for keeping this a documented constraint instead of a code change:** teaching `config.ts` to also read the env var would create a second configuration source for one value (precedence rules, a new test, and a break from "agents.yaml is the config" that every other setting follows) — all to save the operator one cross-check at deploy time; the stated-equality constraint plus a Task 4 checklist line is the smaller fix. Verification lives in Task 4's checklist (the port-consistency pre-up check), and a drift would also surface immediately as a never-healthy container. **OPERATOR-CONFIRM** (listed in the summary).

**Config note carried into the deploy runbook (Task 4), not a code change here:** the harness's `dashboard_host` config defaults to `127.0.0.1` (Plan 3's dev-mode default — correct for a bare-metal run, wrong inside a container where the reverse proxy reaches the service over the docker network, not loopback). The operator's `agents.yaml` must set `dashboard_host: 0.0.0.0` for the container deploy. This does not weaken the "no published host port" decision — `0.0.0.0` here only means "listen on the container's network namespace," which the reverse proxy reaches via the `proxy` network; nothing changes about what the host's own network interfaces expose, since there is still no `ports:` mapping.

**Verification (offline, this task):**
- `HARNESS_IMAGE_TAG=test docker compose config` — validates YAML syntax and variable interpolation without building or starting anything (the non-destructive-first check named in change-management.md); the throwaway tag value satisfies the `:?` guard, and running it *without* the variable must fail with the guard's message (checks the guard actually guards).
- Confirm `read_only: true` + the two writable exceptions (`harness_data` volume, `secrets/` bind mount) are the only writable paths by reading the compose file against the Dockerfile's `WORKDIR`/`COPY` layout — no `RUN`-time write target in the image is missing a corresponding volume or tmpfs entry.

---

### Task 3: `bun audit` + typecheck + test as a pre-build gate

Already delivered as part of Task 1 (`scripts/preflight.ts`, wired into the Dockerfile's `test` stage). This task exists in the spec's numbering as its own line item because the constraint ("bun audit + typecheck + test as a pre-build script") could have been satisfied purely at the compose/CI layer instead of inside the image build — the decision to fold it into the Dockerfile itself (rather than, say, a separate `docker compose run` step or a CI-only check) is deliberate: it makes the gate travel with the image everywhere the image is built, including a laptop rebuild months from now with no CI in front of it, and it makes "the image exists" and "the image passed its gates" the same fact instead of two facts that can drift apart.

No additional files. **Verification:** covered by Task 1's verification (the deliberate-breakage build-failure check already exercises this).

---

## Batch K — Deploy + Verify

### Task 4: Deploy runbook (executable)

This task is instructions plus commands, not code — it runs once against docker-staging, with the user able to watch, per the declared deviation above. Every OPERATOR-CONFIRM item is called out again in this plan's summary report.

**Step 1 — SSH host entry (OPERATOR-CONFIRM).** Per `ssh.md`'s binding rule, every host must be in `~/.ssh/config` before connecting — no raw-IP connections. A check of the current config during this plan's authoring found no `docker-staging` entry yet. Before running anything below, add one:
```
Host docker-staging
    HostName <docker-staging's real IP or hostname>
    User <deploy user>
```
This plan does not fill in the real hostname/user — that's host inventory the operator holds, not something to guess into a committed file.

**Step 2 — clone or pull, git-based (no rsync/scp):**
```bash
ssh docker-staging "test -d /opt/spacemolt/.git || git clone <repo-url> /opt/spacemolt"
ssh docker-staging "cd /opt/spacemolt && git fetch origin && git checkout main && git pull --ff-only"
ssh docker-staging "cd /opt/spacemolt && git config core.hooksPath .githooks"
```
**OPERATOR-CONFIRM:** the repo URL/remote (and whether the staging host authenticates to it via a deploy key or HTTPS token — this plan does not choose one), and the deploy path (`/opt/spacemolt` above is this plan's placeholder convention, matching a conventional `/opt/<service>` deploy layout; confirm it matches this host's actual convention before running).

**Step 3 — provision secrets on the host (never in git, per `.gitignore`'s existing `secrets/` rule):**
- `secrets/registration_code` — from https://spacemolt.com/dashboard (already in the repo's dev environment per `docs/STATE.md`; copy the same value or mint a fresh one if agents on docker-staging are meant to be distinct accounts — **OPERATOR-CONFIRM** which).
- `secrets/claude_oauth_token` — via `claude setup-token` (per the spike). This typically needs a browser for the OAuth flow; run it wherever that's available and copy only the resulting token file to docker-staging over the same trusted channel used for everything else in `secrets/` (scp/SSH is fine for a one-time credential copy — the "no rsync/scp" rule above is about *code* deploy, not secret provisioning). **OPERATOR-CONFIRM** the exact provisioning path.
- `agents.yaml` (real config, gitignored) — start from `agents.example.yaml`, set `dashboard_host: 0.0.0.0` (Task 2's note) and `db_path: /app/data/harness.sqlite` (matching the named volume's mount point). **OPERATOR-CONFIRM** the actual agent personas/planners for the production run — this plan does not choose them.
- `.env` — copy `.env.example`, fill every placeholder from this host's existing reverse-proxy/SSO setup. **OPERATOR-CONFIRM.**
- Host-side permission for the bind-mounted `secrets/` directory: the container's non-root UID (10001) must be able to **write** new per-agent password files there, not just read the operator-provisioned ones. A bind-mounted host directory keeps host-side ownership; if it's owned by the deploying user (a different UID than 10001), the container's first-run registration write will fail with a permission error. **OPERATOR-CONFIRM:** either `chown` the directory to UID 10001 on the host, or set host-side permissions the container's UID can write to (`chmod 0775` with matching group membership is the minimal-privilege option; broader `0777` is the blunt fallback). This is new ground the security-baseline invariant (file-mode 0644) didn't cover — see this plan's Decision 1.

**Step 4 — build and start.** The image tag is the short git SHA of the checked-out commit (Task 2's tag scheme) — each deploy produces a distinctly-tagged image, so the previous one survives for rollback instead of being overwritten:
```bash
ssh docker-staging 'cd /opt/spacemolt && HARNESS_IMAGE_TAG=$(git rev-parse --short HEAD) docker compose build'
ssh docker-staging 'cd /opt/spacemolt && HARNESS_IMAGE_TAG=$(git rev-parse --short HEAD) docker compose up -d'
```
Pre-up port-consistency check (Task 2's note — the app reads its port only from `agents.yaml`; `.env`'s copy feeds the reverse proxy and the healthcheck):
```bash
ssh docker-staging "cd /opt/spacemolt && grep dashboard_port agents.yaml; grep HARNESS_DASHBOARD_PORT .env"
```
The two numbers must match (an absent `dashboard_port` line means the default, 8642 — then `.env` must say 8642).

**Step 5 — verification checklist** (same spirit as `docs/wiki/first-flight-checklist.md`: concrete signal per item, not a vibe):

- [ ] **Container healthy.** `docker compose ps` shows `harness` as `Up (healthy)` — the Dockerfile's `HEALTHCHECK` (Task 1) polls the dashboard's own `/api/agents` endpoint from inside the container every 30s.
- [ ] **Dashboard reachable via the reverse proxy + SSO** (**OPERATOR step — needs the user's browser**): visiting `https://spacemolt.<domain>` redirects through the SSO login, then lands on the dashboard SPA showing live agent panels.
- [ ] **Agent loop running.** `docker compose logs -f harness` shows each configured agent's startup line (`agent <id> (<username>) started`, from `src/main.ts:47`) followed by periodic event lines (`store.onEvent`, `src/main.ts:19`) as the loop ticks — this is the SQLite-backed event flow the task asks to confirm, readable directly from the existing stdout logging without needing a sqlite client in the image.
- [ ] **Token auth working in-container.** Watch the logs for the first `planner_*` event from a `claude-subscription`-configured agent: a `planner_error`/`token_invalid`-classified event means the token file didn't make it into the bind mount correctly or lost its permissions in transit; a normal plan/replan cycle means the mechanism transplanted cleanly. The auth *mechanism itself* (env-var token, no writable Claude home) was already proven by the spike — this step re-verifies only that the new image/compose plumbing carries it correctly, not the mechanism from scratch.

**Rollback:** `docker compose down` (not `-v` — preserves the `harness_data` volume and the bind-mounted `secrets/`). Because each deploy is tagged with its commit SHA (Step 4), the previous image still exists locally — roll back by starting it explicitly:
```bash
ssh docker-staging 'cd /opt/spacemolt && HARNESS_IMAGE_TAG=<last-good-short-sha> docker compose up -d --no-build'
```
(`docker images spacemolt-harness` lists the available tags; `git log --oneline` on the host maps SHAs to what changed.) If the compose file or Dockerfile itself is the problem, `git checkout <last-good-sha>` on the host first, then the same command.

---

### Task 5: Operations doc — production section

**Files:**
- Modify: `docs/wiki/operations.md` (adds a new "Production (docker-staging)" section; assumes Plan 3 Batch I already created this file with a development-mode section, per this plan's header note)

**Content to add** (educational register, per AGENTS.md's binding convention for wiki pages):

```markdown
## Production (docker-staging)

The harness runs in production as one Docker container on the docker-staging
host, reachable at `https://spacemolt.<domain>` (OPERATOR-CONFIRM: fill in
the real domain here once assigned) — never on a directly-exposed port.
The reverse proxy terminates TLS and routes the request; the SSO forwardAuth
middleware checks you're logged in before the proxy ever forwards the request
to the harness container. If you're not logged in, you'll be bounced to
the SSO login page first, then redirected back.

**Logs.** `docker compose logs -f harness` on docker-staging streams the same
event log the harness prints in development — one line per game action, wake,
or planner call, timestamped. This is the fastest way to see what an agent is
doing right now without opening the dashboard.

**Restart.** `docker compose restart harness` — the agent loop and dashboard
both come back up from where SQLite left off; plan cursors resume mid-step
(the crash-recovery design from Plan 1), nothing replays.

**Update procedure.** Each deploy tags its image with the short git commit
SHA, so the previous version's image stays on disk for instant rollback:
```bash
ssh docker-staging 'cd /opt/spacemolt && git pull --ff-only && HARNESS_IMAGE_TAG=$(git rev-parse --short HEAD) docker compose build && HARNESS_IMAGE_TAG=$(git rev-parse --short HEAD) docker compose up -d'
```
The Dockerfile's build gate (`bun test`, `tsc`, `bun audit`) runs as part of
that `build` step — if the new commit broke something, the build fails
before the running container is ever touched, so a bad update never reaches
production silently. To roll back, rerun the `up -d` command with
`HARNESS_IMAGE_TAG` set to the previous commit's short SHA and add
`--no-build`.

**Secrets rotation (token re-mint).** The Claude subscription token
(`secrets/claude_oauth_token`) is read fresh from disk on every planner call
(`src/planner/claude-subscription.ts`), not cached at container start — so
rotating it is a **hot** operation. Run `claude setup-token` again wherever
the OAuth flow is available, overwrite `secrets/claude_oauth_token` on
docker-staging with the new value (keep the file at mode 0644 — non-root
containers can't read 0600), and the very next planner call picks it up. No
container restart needed.

**Backup (the one SQLite file).** All harness state — event log, plan
cursors, everything the dashboard shows — lives in one file on the
`harness_data` named volume. Back it up with:
```bash
docker cp spacemolt-harness:/app/data/harness.sqlite ./backup/harness-$(date +%Y%m%d).sqlite
```
`docker cp` reads through the running container without needing a shell or
sqlite client inside the image, and needs no extra image pull.
```

**Verification (offline for this task's content; the runbook itself is verified live in Task 4):** the doc renders as valid markdown, the code fences are runnable commands (spot-check by reading them against the actual `docker-compose.yml` service/container names from Task 2 — `spacemolt-harness`, `harness_data` — for consistency).

---

## Summary of every OPERATOR-CONFIRM item (collected)

1. Resolved digests for `oven/bun:1.3.14-slim` and `node:22-bookworm-slim` (Task 1) — no Docker daemon available at authoring time.
2. Post-build smoke check that the copied `bun` binary runs on the node base; fallback to `oven/bun:1.3.14-debian` if not (Task 1).
3. `HARNESS_DASHBOARD_PORT` in `.env` must equal `agents.yaml`'s `dashboard_port` — the app reads only the latter; `.env`'s copy feeds the reverse-proxy label and healthcheck (Task 2 note, Task 4 pre-up check).
4. `DOMAIN`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERT_RESOLVER`, `AUTHENTIK_FORWARDAUTH_MIDDLEWARE`, `TRAEFIK_NETWORK_NAME` — every reverse-proxy/SSO value, matched to this host's existing conventions, never invented (Task 2).
5. SSH `~/.ssh/config` entry for `docker-staging` — confirmed missing during authoring (Task 4).
6. Repo remote URL/auth method and the real deploy path on docker-staging (Task 4).
7. Registration code / token provisioning path onto docker-staging, and whether production agents are the same accounts as dev/flight-campaign agents or fresh ones (Task 4).
8. Host-side write permission on the bind-mounted `secrets/` directory for the container's non-root UID (Task 4) — the new corollary this plan surfaced (see Decision 1 below).
9. Production `agents.yaml` persona/planner configuration (Task 4) — this plan doesn't choose the production roster.
10. Real domain value in the ops doc (Task 5).

None of these block authoring this plan; all of them block *running* Task 4 against docker-staging.

---

## Decisions for PM scrutiny

The three places where this plan exercised judgment beyond restating a constraint — each is reversible before Batch J dispatches if the PM disagrees.

**Decision 1 — `secrets/` bind-mounted read-write, and the directory-permission corollary.** A read-only mount looks safer but breaks first-run behavior: `ensureCredentials` (`src/config/config.ts:118`) writes each newly-registered agent's password file into `secrets/` at registration time, already at the invariant-required mode 0644. The existing security-baseline invariant covers file *mode* only; a non-root container UID (10001) writing into a host-owned bind-mounted *directory* additionally needs host-side directory write permission — new ground, surfaced as an explicit OPERATOR-CONFIRM step in Task 4 (chown to 10001 or group-writable 0775) rather than silently assumed. If this pattern recurs on another service, it's an invariant-promotion candidate for change-management.md.

**Decision 2 — no compose-level `env_file` transport for `CLAUDE_CODE_OAUTH_TOKEN`.** The brief suggested delivering the token via `env_file`. Verified against the actual code instead: the planner reads the token from a file (`src/planner/claude-subscription.ts:47`, path via `HARNESS_SECRETS`) per call and sets it only in the spawned CLI child's environment (`claude-subscription.ts:60`) — the parent process never carries it. A compose-level env var would be a second, *unused* transport path for the same secret: visible in `docker inspect` output for zero benefit. The bind-mounted file is the single path; `.env` stays non-secret-only per security-baseline.md. The security-baseline sentence "environment inheritance or `--env-file`" describes the *CLI child's* auth mechanism (which the file-read-then-child-env flow satisfies), not a mandate to also put the token in compose's environment.

**Decision 3 — image composition: node base + copied bun binary (the spike's open question).** Full receipt in Task 1. Short form: the claude CLI's only baseline-permitted install path is version-pinned npm, which wants a node runtime; bun ships as a single static-ish binary the official image documents copying via `COPY --from`. The rejected alternative (bun base + apt nodejs) adds an unpinned apt dependency surface and abandons the exact node build the spike verified. Residual risk, flagged as OPERATOR-CONFIRM: the copied bun binary's shared-library needs on the slim node base — one `bun --version` smoke check after first build settles it, with `oven/bun:1.3.14-debian` as the named fallback source stage.
