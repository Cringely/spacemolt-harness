#!/bin/sh
# Durable scheduler (#114) Stage 2: dead-man staleness alarm -- the
# watcher-of-the-watcher. Runs from its OWN cron entry, independent of bun and
# the tick process, so it survives exactly the toolchain failure that silently
# killed the tick on 2026-07-19 (cron's bare PATH lost /usr/local/bin, the
# `exec bun` handoff died as "bun: not found", and nothing alerted for 4h --
# PR #394, engineering-lessons L-39). #114's stage-2 mandate: "DEAD-MAN FILE --
# each tick writes a timestamp artifact; an independent check ... alarms when
# >2 intervals stale". Stage 2 watches the POLLER only; per-agent heartbeats
# are stage 3 (council verdict D2).
#
# Two failure classes it must catch, and neither is visible from INSIDE a tick:
#   (a) cron fires but the tick dies early  -> last-tick stops updating, no lock
#   (b) cron stops firing entirely          -> last-tick stops updating, no lock
# In both, `state/last-tick` stops changing and no lock is held. This script
# needs only POSIX sh + coreutils + one HTTP client -- never the broken
# toolchain the tick depends on.
set -eu

# Cron hands a bare PATH (/usr/bin:/bin on Debian); coreutils live in /usr/bin
# and curl/wget where the distro puts them. Set our own rather than trust the
# caller -- the same defense scheduler-tick.sh adopted after L-39.
PATH="/usr/local/bin:/usr/bin:/bin"
export PATH

# Host env file: paths only, no secret VALUES (same file scheduler-tick.sh
# sources). Override for a manual/test run via SPACEMOLT_SCHED_ENV.
ENV_FILE="${SPACEMOLT_SCHED_ENV:-$HOME/.config/spacemolt-sched.env}"
[ -f "$ENV_FILE" ] || { echo "scheduler-deadman: env file not found: $ENV_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${SCHEDULER_STATE_DIR:?SCHEDULER_STATE_DIR must be set in $ENV_FILE}"
: "${SCHEDULER_SECRETS:?SCHEDULER_SECRETS must be set in $ENV_FILE}"

STATE_DIR="$SCHEDULER_STATE_DIR"
LAST_TICK="$STATE_DIR/last-tick"   # written every real tick (src/scheduler/tick.ts LAST_TICK_FILE)
LOCK="$STATE_DIR/lock"             # held while a tick runs (src/scheduler/state.ts LOCK_FILE)
STOP="$STATE_DIR/stop"             # operator pause sentinel (state.ts STOP_FILE)
# Sentinel: present == a breach we've already announced; its content == epoch
# seconds of the last POST (drives the re-alarm cooldown). One file is the
# whole state machine -- breach-open vs recovered vs within-cooldown.
ALERT_STATE="$STATE_DIR/deadman-alerted"

# Tunables -- each carries a receipt; override via env for testing.
# STALE_THRESHOLD_SEC 1800 = 3 missed 10-min ticks. One miss is a transient (a
#   long job legitimately holds the lock -- suppressed separately below); three
#   consecutive misses with NO lock present is a dead scheduler, not a slow one.
STALE_THRESHOLD_SEC="${STALE_THRESHOLD_SEC:-1800}"
# LOCK_FRESH_SEC 10800 = 3h, mirrors LOCK_STALE_MS in src/scheduler/tick.ts. A
#   lock younger than this proves a tick is legitimately mid-run (a fresh-boot
#   catch-up burst can occupy one tick up to ~2h: the four job timeouts sum to
#   15+30+45+30 min), so last-tick being old is expected -- suppress. An OLDER
#   lock is a crashed tick the next tick self-heals, and it DOES alarm.
LOCK_FRESH_SEC="${LOCK_FRESH_SEC:-10800}"
# ALERT_COOLDOWN_SEC 21600 = 6h between re-alarms within one unbroken outage,
#   so a weekend-long outage pings ~4x/day instead of every 10 minutes.
ALERT_COOLDOWN_SEC="${ALERT_COOLDOWN_SEC:-21600}"

# ntfy URL and topic default to generic placeholders; the real alert channel
# is deploy config and rides the host env file (NTFY_URL/NTFY_TOPIC), so no
# operator-specific server or topic sits in the repo. Token is read from a
# FILE, never argv.
NTFY_URL="${NTFY_URL:-https://ntfy.example.com}"
NTFY_TOPIC="${NTFY_TOPIC:-scheduler-alerts}"

NOW="$(date -u +%s)"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] scheduler-deadman: $*"; }

# mtime in epoch seconds, or empty if the file is absent. GNU stat (Debian
# coreutils / Git Bash). Using mtime keeps all arithmetic in seconds -- the
# dumb path never parses the file's millisecond content.
mtime() {
  if [ -e "$1" ]; then stat -c %Y "$1" 2>/dev/null || true; fi
}

# post_ntfy TYPE TITLE MESSAGE -- the ONLY network egress. In tests
# SCHEDULER_ALARM_SINK points at a file and the notification is appended there
# instead of POSTed, so the suite makes zero network calls and needs no token.
# Returns non-zero (never fatal under set -e -- always called in a guarded
# context) when it could not deliver, so callers leave state un-advanced and
# retry next run once the wiring is fixed.
post_ntfy() {
  _type="$1"; _title="$2"; _msg="$3"
  if [ -n "${SCHEDULER_ALARM_SINK:-}" ]; then
    printf '%s|%s|%s\n' "$_type" "$_title" "$_msg" >>"$SCHEDULER_ALARM_SINK"
    return 0
  fi
  _tok_file="$SCHEDULER_SECRETS/ntfy_token"
  if [ ! -r "$_tok_file" ]; then
    log "ALARM SUPPRESSED -- ntfy token unreadable at $_tok_file; would send [$_title] $_msg"
    return 1
  fi
  _tok="$(cat "$_tok_file")"
  # curl only (no wget fallback): the bearer must stay off the argv, and curl's
  # `-K -` reads the Authorization header from a stdin config where `ps` and
  # /proc/<pid>/cmdline never see it (security-baseline.md); wget has no clean
  # header-off-argv path. curl is a stable Debian package the wiring step
  # verifies present -- unlike bun it does not live in /usr/local/bin and was
  # not the toolchain that broke, so requiring it does not reintroduce the L-39
  # failure. Title and message are not secrets and stay on the argv.
  if command -v curl >/dev/null 2>&1; then
    if printf 'header = "Authorization: Bearer %s"\n' "$_tok" \
        | curl -fsS -m 15 -K - -H "Title: $_title" -d "$_msg" "$NTFY_URL/$NTFY_TOPIC" >/dev/null 2>&1; then
      log "sent $_type notification"; return 0
    fi
    log "ntfy POST failed (curl)"; return 1
  fi
  log "ALARM SUPPRESSED -- curl not on PATH; would send [$_title] $_msg"
  return 1
}

# Intentional pause: the stop sentinel means the operator paused the scheduler
# on purpose (state.ts stopRequested makes the tick a clean no-op). A paused
# scheduler is not a dead one -- never alarm, and clear any standing breach so
# a resume after a real outage does not fire a stale recovery.
if [ -e "$STOP" ]; then
  if [ -e "$ALERT_STATE" ]; then rm -f "$ALERT_STATE"; log "stop sentinel present -- staleness alarm reset"; fi
  log "stop sentinel present -- scheduler intentionally paused; no check"
  exit 0
fi

LT="$(mtime "$LAST_TICK")"
if [ -z "$LT" ]; then
  # last-tick was never written: a brand-new host before its first tick (the
  # deadman cron is wired AFTER first-tick verification -- runbook step 7), or
  # state was wiped. Don't manufacture an outage from a never-run scheduler;
  # the first-tick check is the human gate for "it never ticked at all".
  log "last-tick absent -- scheduler has not ticked yet; not alarming until it has"
  exit 0
fi
AGE=$((NOW - LT))

# A fresh lock proves a tick is legitimately mid-run -> old last-tick is
# expected, not an outage.
LK="$(mtime "$LOCK")"
LOCK_FRESH=0
if [ -n "$LK" ]; then
  if [ $((NOW - LK)) -lt "$LOCK_FRESH_SEC" ]; then LOCK_FRESH=1; fi
fi

STALE=0
if [ "$AGE" -gt "$STALE_THRESHOLD_SEC" ] && [ "$LOCK_FRESH" -eq 0 ]; then STALE=1; fi

LT_ISO="$(date -u -d "@$LT" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"

if [ "$STALE" -eq 1 ]; then
  MSG="No scheduler tick for ~$((AGE / 60))m (threshold $((STALE_THRESHOLD_SEC / 60))m). last-tick=$LT_ISO. Check the scheduler-host cron and scripts/scheduler-tick.sh."
  if [ -e "$ALERT_STATE" ]; then
    LAST_ALERT="$(cat "$ALERT_STATE" 2>/dev/null || echo 0)"
    [ -n "$LAST_ALERT" ] || LAST_ALERT=0
    if [ $((NOW - LAST_ALERT)) -ge "$ALERT_COOLDOWN_SEC" ]; then
      post_ntfy stale "SpaceMolt scheduler STALE" "$MSG" && printf '%s\n' "$NOW" >"$ALERT_STATE" || true
    else
      log "still stale (age $((AGE / 60))m) -- within ${ALERT_COOLDOWN_SEC}s cooldown, no re-alarm"
    fi
  else
    # First breach. Only mark alerted if the POST actually delivered -- a
    # failed POST (missing token/client) leaves the sentinel absent so the
    # alarm retries once the wiring is fixed.
    post_ntfy stale "SpaceMolt scheduler STALE" "$MSG" && printf '%s\n' "$NOW" >"$ALERT_STATE" || true
  fi
else
  # Not stale. If a breach was open, the outage cleared -> recovery ping.
  if [ -e "$ALERT_STATE" ]; then
    if post_ntfy recovery "SpaceMolt scheduler RECOVERED" "Ticks resumed; last-tick $((AGE / 60))m ago ($LT_ISO)."; then
      rm -f "$ALERT_STATE"
    else
      log "recovery POST failed -- leaving alert state so recovery retries next run"
    fi
  else
    log "healthy -- last tick $((AGE))s ago (threshold ${STALE_THRESHOLD_SEC}s)"
  fi
fi

exit 0
