#!/bin/sh
# Durable scheduler (#114) cron wrapper -- task E1. The operational runbook is
# kept in a separate private repo.
# The scheduler host's cron fires this every 10 minutes. It owns the three things
# scripts/scheduler.ts deliberately does NOT do itself: read the host env
# file, refresh the checkout, and load secrets into env. Once those are
# ready it hands off to the real entry point exactly once.
set -eu

# Cron hands this script a bare PATH (/usr/bin:/bin on Debian); bun and gh
# install to /usr/local/bin, so the wrapper sets its own PATH instead of
# trusting the caller's. Found live 2026-07-19: every cron-fired tick died
# at the `exec bun` handoff ("bun: not found") while manual runs passed --
# the enable was verified from an interactive shell, not through cron
# itself (engineering-lessons L-39).
PATH="/usr/local/bin:$PATH"
export PATH

# 1. Host env file: sets SCHEDULER_STATE_DIR, SCHEDULER_CHECKOUT,
#    SCHEDULER_SECRETS only -- no secret VALUES ever live here (runbook step
#    5). Override the path for a manual test run via SPACEMOLT_SCHED_ENV;
#    production cron leaves it unset and gets the default.
ENV_FILE="${SPACEMOLT_SCHED_ENV:-$HOME/.config/spacemolt-sched.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "scheduler-tick: env file not found: $ENV_FILE" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${SCHEDULER_STATE_DIR:?SCHEDULER_STATE_DIR must be set in $ENV_FILE}"
: "${SCHEDULER_CHECKOUT:?SCHEDULER_CHECKOUT must be set in $ENV_FILE}"
: "${SCHEDULER_SECRETS:?SCHEDULER_SECRETS must be set in $ENV_FILE}"
export SCHEDULER_STATE_DIR SCHEDULER_CHECKOUT SCHEDULER_SECRETS

# From here on, send every message (this script's own plus whatever the
# handed-off bun process prints) to a day-rotated file under state/logs/, the
# same directory and the same one-file-per-UTC-day scheme runJob's own jsonl
# run log already uses (src/scheduler/spawn.ts appendRunLog). That means
# tick.ts's existing 14-day prune (src/scheduler/tick.ts pruneOld) ages this
# file out automatically -- no separate retention rule to maintain, and no
# unbounded log growth from a wrapper nobody remembered to rotate.
mkdir -p "$SCHEDULER_STATE_DIR/logs"
LOG_FILE="$SCHEDULER_STATE_DIR/logs/cron-$(date -u +%Y-%m-%d).log"
exec >>"$LOG_FILE" 2>&1
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scheduler-tick starting"

# 2. Secrets travel by env only, never on an argv, never echoed (security-
#    baseline.md). CLAUDE_CODE_OAUTH_TOKEN and GH_TOKEN are exported here,
#    before the checkout refresh below, so step 3's `gh auth git-credential`
#    credential helper can authenticate that `git pull`; GH_TOKEN carries
#    the read+comment PAT specifically (least privilege -- a checkout
#    refresh is a read). Each job spawn re-reads its OWN secret file
#    straight from $SCHEDULER_SECRETS at call time (src/scheduler/spawn.ts
#    buildEnv) and overrides these values for its own child process, so
#    exporting the read PAT here never hands the steward's contents:write
#    PAT to every tick.
[ -r "$SCHEDULER_SECRETS/claude_oauth_token" ] || { echo "scheduler-tick: secret unreadable: $SCHEDULER_SECRETS/claude_oauth_token" >&2; exit 2; }
[ -r "$SCHEDULER_SECRETS/gh_pat_readcomment" ] || { echo "scheduler-tick: secret unreadable: $SCHEDULER_SECRETS/gh_pat_readcomment" >&2; exit 2; }
CLAUDE_CODE_OAUTH_TOKEN="$(cat "$SCHEDULER_SECRETS/claude_oauth_token")"
GH_TOKEN="$(cat "$SCHEDULER_SECRETS/gh_pat_readcomment")"
export CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN

# 3. Refresh the checkout BEFORE the tick reads charters/STATE.md from it.
#    tick.ts's own git calls only read origin/main's sha to evaluate the
#    steward job (src/scheduler/tick.ts readMainStatus) -- they never touch
#    the working tree. This refresh is what keeps every charter, STATE.md, and
#    brief the spawns read at its latest merged content. Delegated to
#    scheduler-refresh-checkout.sh (#413): it pins HEAD to main FIRST, so a
#    stranded local branch (a headless steward that branched+committed but
#    could not push -- the 2026-07-19 outage) self-heals loudly instead of
#    aborting the tick under `set -e` and killing every later tick silently.
#    --ff-only is preserved inside it: a genuine non-fast-forward (upstream
#    force-push) still aborts here, loudly, rather than rewriting history.
#    Runs in this process's env, so the GH_TOKEN exported above authenticates
#    its pull.
cd "$SCHEDULER_CHECKOUT"
sh "$SCHEDULER_CHECKOUT/scripts/scheduler-refresh-checkout.sh" "$SCHEDULER_CHECKOUT"

# 4. Hand off. scripts/scheduler.ts refuses to run (exit 2) unless all three
#    SCHEDULER_* vars are set -- already guaranteed above.
exec bun "$SCHEDULER_CHECKOUT/scripts/scheduler.ts" tick
