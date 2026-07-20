#!/bin/sh
# SessionStart hook (WARN-only, read + print, never blocks).
# Re-injects the top of the guardrails rule-catalog into context at every
# session start, so the key judgment rules land in view instead of scrolling
# away with AGENTS.md. Prints everything from the top of guardrails.md down to
# the `guardrails:session-start-end` marker line, then stops.
#
# Reviewed by the operator before merge: it only reads one repo file and writes
# to stdout. No arguments, no network, no mutation.

set -eu

root="${CLAUDE_PROJECT_DIR:-.}"
catalog="$root/.claude/guardrails.md"

# Missing file is a no-op, not an error — never break a session start.
[ -f "$catalog" ] || exit 0

echo "=== Guardrails (repo forcing functions — re-injected each session) ==="
# Print up to, but not including, the marker line.
awk '/guardrails:session-start-end/ { exit } { print }' "$catalog"
echo "=== Full catalog + hooks: .claude/guardrails.md · How we work: docs/wiki/working-agreements.md ==="

exit 0
