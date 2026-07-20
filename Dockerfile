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
# build. Resolve on docker-staging with:
#   docker pull oven/bun:1.3.14-slim && \
#     docker inspect --format='{{index .RepoDigests 0}}' oven/bun:1.3.14-slim
#   docker pull node:22-bookworm-slim && \
#     docker inspect --format='{{index .RepoDigests 0}}' node:22-bookworm-slim
# and replace the two ARG defaults below before `docker compose build`.
# OPERATOR-CONFIRM until resolved against the real registry.

ARG BUN_IMAGE=oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf
# Pinned to the exact version the spike verified end-to-end
# (spike-claude-container-auth.md). Bump deliberately, never floating.
ARG CLAUDE_VERSION=2.1.206
# OpenAI's Codex CLI — the second zero-marginal-cost planner (#311,
# codex-subscription). Pinned to the exact version the invocation contract was
# verified live against (src/planner/codex-subscription.ts header: codex-cli
# 0.144.3, 2026-07-17). npm package is @openai/codex; its bin is `codex`.
# Bump deliberately, never floating (security-baseline.md supply-chain rule).
ARG CODEX_VERSION=0.144.3

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
# The three .claude test inputs (see .dockerignore's carve-outs): the
# worktree-isolation hook is imported by its test, the derivation tests read
# the real agents/*.md tool grants, and the guardrails-slice test reads
# guardrails.md + the session-start hook (so the build gate also enforces the
# always-on safety-prompt slice). Test-stage only, never copied to runtime.
COPY .claude/hooks ./.claude/hooks
COPY .claude/agents ./.claude/agents
COPY .claude/guardrails.md ./.claude/guardrails.md
COPY agents.example.yaml ./
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
ARG CODEX_VERSION
# ca-certificates: the codex CLI is a Rust binary that reads TLS roots from
# the SYSTEM store (/etc/ssl/certs) — empty on the slim base. node, bun, and
# the claude CLI all ship bundled Mozilla roots, which is why the build and
# every other HTTPS path worked while EVERY codex call (login --device-auth,
# exec) failed with the bare "error sending request" (prod, 2026-07-17).
# Pinned by test/image-contents.test.ts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Two zero-marginal-cost planner CLIs (#311): the Claude Code CLI drives
# claude-subscription, OpenAI's Codex CLI drives codex-subscription. Both are
# installed ONLY via version-pinned npm (security-baseline.md: never the curl
# installer), each pinned to the exact version its planner verified live. One
# RUN + one cache clean keeps it a single layer.
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
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
# scripts/ ships in the runtime image (#290): the charters run the strategy-
# review gate + marker CLIs via `docker exec ... bun run scripts/...`, and an
# image without them fails 'Module not found' at the first gated review (the
# marker CLI missing is worse: the review cursor can never advance). Pinned by
# test/image-contents.test.ts. Cost is a few KB of TypeScript; the host-only
# steward tools ride along inert.
COPY scripts ./scripts
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

# The dashboard's shared-secret gate (#173 / PR #202) covers EVERY route by
# design — and the healthcheck is a caller too, so it must present the token
# when the gate is configured (HARNESS_DASHBOARD_TOKEN_FILE set). Without it
# the check 401s and the health-gated auto-deploy rollback-flaps. Bonus: a
# mis-provisioned token file (missing/empty/wrong) now surfaces as UNHEALTHY
# instead of silently wrong — detection for the barrier-misconfig residual.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "const t = process.env.HARNESS_DASHBOARD_TOKEN_FILE; const headers = t ? { 'X-Dashboard-Token': (await Bun.file(t).text()).trim() } : {}; process.exit((await fetch('http://127.0.0.1:' + (process.env.HARNESS_DASHBOARD_PORT || 8642) + '/api/agents', { headers }).then(r => r.ok).catch(() => false)) ? 0 : 1)"

ENTRYPOINT ["bun", "run", "src/main.ts"]
