#!/bin/sh
# Refresh the shared scheduler checkout to a clean origin/main BEFORE a tick
# reads charters/STATE.md from it (#413). This is the consumer-side self-heal
# for a stranded shared checkout.
#
# The failure it fixes (2026-07-19, the SECOND silent scheduler outage): a
# headless doc-steward run branched + committed IN the shared `~/checkout` and
# left HEAD on a local branch it could not push. scheduler-tick.sh's old
# `git pull --ff-only` then failed ("no tracking information") under the
# wrapper's `set -e`, so EVERY subsequent tick aborted before reaching the
# scheduler -- a 4h outage, same silent-death class as the cron-PATH one (#394).
#
# Fix: pin to main FIRST. A checkout sitting on any other ref is a stranded
# shared checkout; recover it loudly (distinct CHECKOUT-STRANDED marker so the
# cron log shows the self-heal) and continue, instead of aborting the tick. A
# stray local branch now costs at most the recovery, never an outage, and never
# silently. The producer-side restore lives in src/scheduler/tick.ts (force main
# right after the steward job); this guard is the structural backstop for ANY
# future strander -- including a scheduler that crashed before its own restore
# ran, which tick.ts can never cover.
set -eu

# Checkout dir: first positional arg, else SCHEDULER_CHECKOUT from the env.
CHECKOUT="${1:-${SCHEDULER_CHECKOUT:-}}"
[ -n "$CHECKOUT" ] || { echo "scheduler-refresh-checkout: no checkout dir given (\$1) and SCHEDULER_CHECKOUT unset" >&2; exit 2; }
cd "$CHECKOUT"

# Pin to main. `-f` discards any stray working-tree edits a half-finished job
# left behind -- the shared checkout is not a place to preserve work, and a
# committed strand keeps its commit on its own local branch regardless.
current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$current" != "main" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scheduler-refresh: CHECKOUT-STRANDED on '$current' -- forcing main (self-heal, #413)" >&2
  git checkout -f main
fi

# --ff-only preserves the original invariant: a checkout that genuinely cannot
# fast-forward (an upstream force-push, NOT a local strand) still aborts loudly
# under the caller's `set -e` rather than the wrapper rewriting history to match.
# Explicit `origin main` so the pull never depends on branch-tracking config
# (which a fresh `checkout -f main` above may not have re-established).
git pull --ff-only origin main
