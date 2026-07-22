#!/bin/sh
# Durable scheduler (#459) HOST-SIDE tick bootstrap -- the one piece of the tick
# chain that MUST live OUTSIDE the shared checkout, and the one piece that stays
# frozen. cron points at THIS file (installed to ~/bin, outside the checkout),
# never at the checkout's own wrapper.
#
# Why it exists (the 32h outage, 2026-07-19 06:50Z -> 2026-07-20 ~15:30Z):
# cron invoked $SCHEDULER_CHECKOUT/scripts/scheduler-tick.sh -- the wrapper rode
# INSIDE the artifact it was meant to heal. A headless steward left the checkout
# stranded on a PR branch. The wrapper on that branch was the OLD wrapper, whose
# `git pull --ff-only` aborts under `set -eu` on a branch with no tracking, BEFORE
# any self-heal code could run -- including the fix (#438) that had by then merged
# to origin/main but could not be reached because the broken copy is the copy that
# executes. Self-healing code whose deployment path runs THROUGH the broken state
# cannot heal it.
#
# The cure moves the un-stranding OUT of the checkout. This script does the
# irreducible minimum: get the checkout back onto the latest origin/main so a
# KNOWN-GOOD wrapper is on disk, then hand off. Everything that evolves -- env
# loading, secrets, day-rotated logging, the full checkout self-heal, the bun
# handoff -- stays in the checkout's scheduler-tick.sh, which this script execs.
#
# FROZEN BY DESIGN. This file is tiny and changes only as a MANUAL runbook step
# (edit repo copy, then re-install to ~/bin by hand). It deliberately has NO
# self-update: copying itself from the checkout would route its own deployment
# path back through the checkout and recreate the very trap one level up. The
# checkout's wrapper instead WARNS (never auto-copies) when the installed copy
# drifts from the repo copy -- see scripts/scheduler-bootstrap-staleness.sh.
set -eu

# cron hands a bare PATH (/usr/bin:/bin on Debian). gh installs to
# /usr/local/bin (its git credential helper authenticates the pull below); git
# and coreutils are already in /usr/bin. PREPEND rather than replace so the
# caller's PATH (and git) survive on a dev host too -- same choice as the
# wrapper (scheduler-tick.sh), the opposite of the deadman's hard reset.
PATH="/usr/local/bin:$PATH"
export PATH

# Host env file gives SCHEDULER_CHECKOUT (and, optionally, SCHEDULER_SECRETS) --
# paths only, no secret VALUES (the same file the wrapper and deadman source).
# Override for a manual/test run via SPACEMOLT_SCHED_ENV; production cron leaves
# it unset and gets the default.
ENV_FILE="${SPACEMOLT_SCHED_ENV:-$HOME/.config/spacemolt-sched.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "scheduler-tick-bootstrap: env file not found: $ENV_FILE" >&2
  exit 2
fi
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${SCHEDULER_CHECKOUT:?SCHEDULER_CHECKOUT must be set in $ENV_FILE}"

# Authenticate the pull the same way the wrapper's refresh does, IF a read PAT
# is present -- so a private origin (or the private-repo era) still fast-forwards
# and a public one just ignores it. Read from a FILE, never argv; skip silently
# if unset/unreadable (a public repo pulls anonymously). GH_TOKEN + gh's git
# credential helper (configured on the host) is what git consumes.
if [ -n "${SCHEDULER_SECRETS:-}" ] && [ -r "$SCHEDULER_SECRETS/gh_pat_readcomment" ]; then
  GH_TOKEN="$(cat "$SCHEDULER_SECRETS/gh_pat_readcomment")"
  export GH_TOKEN
fi

cd "$SCHEDULER_CHECKOUT"

# The restore-to-main sequence below (rev-parse -> checkout -f main -> pull
# --ff-only) is DELIBERATELY duplicated from scripts/scheduler-refresh-checkout.sh
# and must NOT be refactored into a shared dependency. That is the whole point of
# #459: this bootstrap runs from OUTSIDE the checkout precisely so it does not
# depend on any file INSIDE the checkout, which may itself be the stale/stranded
# copy being repaired. Sharing the code would route this script's correctness
# back through the artifact it exists to un-strand, recreating the trap one level
# up. Frozen independence is the feature; the ~6 duplicated lines are the price.
#
# 1. Un-strand: pin HEAD to main. `-f` discards any stray working-tree edits a
#    half-finished job left behind (the shared checkout is not a place to
#    preserve work; a committed strand keeps its commit on its own local branch
#    regardless). LOUD marker so the cron log shows the self-heal.
current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$current" != "main" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scheduler-tick-bootstrap: CHECKOUT-STRANDED on '$current' -- forcing main (self-heal, #459)" >&2
  git checkout -f main
fi

# 2. Fast-forward to the latest origin/main so the KNOWN-GOOD wrapper (and the
#    rest of the fix) is on disk before we hand off. --ff-only keeps the original
#    invariant: a genuine non-fast-forward (upstream force-push) aborts loudly
#    rather than the bootstrap rewriting history. On ANY pull failure we stay
#    LOUD and refuse the handoff -- we do NOT swallow it under set -eu. The
#    checkout is already back on main, so the next tick simply retries; a
#    persistent failure keeps surfacing (and trips the dead-man) instead of
#    silently running stale code.
if ! git pull --ff-only origin main; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scheduler-tick-bootstrap: BOOTSTRAP-PULL-FAILED -- could not fast-forward $SCHEDULER_CHECKOUT to origin/main; NOT handing off (checkout is on main, next tick retries)" >&2
  exit 1
fi

# 3. Hand off to the checkout's real, now-current wrapper. Invoked via `sh` (not
#    by exec bit) so a lost mode on the file never blocks the tick -- the same
#    call shape the refresh script's tests use. Everything downstream lives in
#    the checkout and is free to evolve.
exec sh "$SCHEDULER_CHECKOUT/scripts/scheduler-tick.sh"
