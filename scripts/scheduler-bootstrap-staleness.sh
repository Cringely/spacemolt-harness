#!/bin/sh
# Durable scheduler (#459) bootstrap-drift warning. The tick bootstrap
# (scripts/scheduler-tick-bootstrap.sh) is installed OUTSIDE the checkout (~/bin)
# and is frozen: it updates only when a human re-installs it. That deliberate
# manual step can be forgotten, leaving the installed copy behind the repo copy.
#
# This check compares the two and WARNS LOUDLY when they differ. It deliberately
# does NOT auto-copy the repo copy over the installed one: an auto-update would
# route the bootstrap's own deployment path back through the checkout and
# recreate the exact "the broken copy is the copy that runs" trap the bootstrap
# exists to break (#459). The manual re-install is the circuit breaker; this is
# only its smoke detector.
#
# ADVISORY, never fatal: it always exits 0. Drift is a heads-up, not a reason to
# skip a tick -- the installed bootstrap still runs well enough to have reached
# here. The wrapper calls it best-effort so a warning can never kill a tick.
set -eu

# Repo copy: $1, else the copy next to this script. Installed copy: $2, else
# SCHEDULER_BOOTSTRAP from the env, else the runbook default ~/bin.
REPO_COPY="${1:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/scheduler-tick-bootstrap.sh}"
INSTALLED="${2:-${SCHEDULER_BOOTSTRAP:-$HOME/bin/scheduler-tick-bootstrap.sh}}"

warn() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scheduler-bootstrap-staleness: $*" >&2; }

if [ ! -r "$REPO_COPY" ]; then
  warn "BOOTSTRAP-CHECK-SKIPPED -- repo copy unreadable at $REPO_COPY"
  exit 0
fi
if [ ! -r "$INSTALLED" ]; then
  warn "BOOTSTRAP-MISSING -- no installed bootstrap at $INSTALLED; cron may still point at the checkout copy (re-run the install step, #459)"
  exit 0
fi
if cmp -s "$REPO_COPY" "$INSTALLED"; then
  # Up to date: silent by default (this runs every tick). One line only when a
  # human sets SCHEDULER_BOOTSTRAP_VERBOSE, for a manual install verification.
  [ -z "${SCHEDULER_BOOTSTRAP_VERBOSE:-}" ] || warn "installed bootstrap matches repo copy"
  exit 0
fi

warn "BOOTSTRAP-STALE -- installed $INSTALLED differs from repo $REPO_COPY; re-install by hand (cp repo copy -> ~/bin). NOT auto-updated on purpose (#459)."
exit 0
