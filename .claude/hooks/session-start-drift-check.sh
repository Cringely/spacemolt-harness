#!/bin/sh
# SessionStart drift-check hook (advisory: prints at most one line, never blocks).
# It has no deny path at all: nothing it emits can refuse a tool call, and it runs where no
# tool call is pending. CONTRIBUTING.md:47 asks anything under core/claude/hooks/ for a test with
# "a boundary-crossing input asserted to DENY", and there is no denial here for a test to assert,
# so the file beside it (test/session-start-drift-check.test.ts) pins output shape instead and
# says so at the top.
# Issue #87 is the open question about that rule's scope.
#
# What it does: read .claude/.harness-manifest.json, resolve the core checkout the layer
# was installed from, run that checkout's audit against this project, and print one
# summary line when files need attention. Silent when nothing does.
#
# Every failure degrades to silence and exit 0 — no manifest, no coreRepo, a coreRepo that
# is not a core checkout (an unmounted NAS is the ordinary case here), no pwsh, an audit
# that throws. A drift check that breaks a session start is worse than no drift check, so
# there is no path here that reports its own failure.
#
# SECURITY: coreRepo comes out of a project-local JSON file. It is untrusted input naming a
# directory this hook is about to run a script from, so before anything executes it must
# resolve to a real directory, hold install/Install-Harness.ps1, and sit outside the project
# being audited. It is then passed as a single argv element. Never interpolated into a shell
# string, never eval'd.
#   Two limits worth stating rather than implying. This is a containment check, not an
# authenticity check: a core checkout anywhere outside the project is trusted on its name and
# location alone, so an attacker who can already write outside the repo is not stopped here.
# And a project that is itself the core checkout gets no drift check, since its coreRepo would
# name its own root; that degrades to silence like every other refusal.

set -eu
# pipefail where the shell has it. Guarded rather than bare, which is the simpler form and
# the one adopted for the other -eu hooks: `set -o pipefail`
# predates POSIX Issue 8, older /bin/sh implementations reject the option, and `set` is a
# special builtin whose error aborts a non-interactive shell. Bare, this hook would die at
# line 2 on such a host and take the session start with it. The subshell absorbs that abort.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

# Every external command below carries `2>/dev/null || exit 0`, uniformly and without
# exception. Under `set -e` a command that is missing from PATH aborts the hook at 127 with
# "command not found" on stderr, which is the single output a SessionStart hook must never
# produce. Measured: run from a PowerShell session whose PATH does not carry Git's usr/bin,
# the sed two blocks down took the whole hook down that way.
#   Rejected a `command -v sed tr awk` preflight at the top, which reads tidier: ablated, it
# changed nothing, because the per-site guards already cover a missing tool and also cover
# the cases a preflight cannot (a manifest that exists and cannot be read, a tool present and
# failing). One general mechanism beats two overlapping ones.

root="${CLAUDE_PROJECT_DIR:-.}"
manifest="$root/.claude/.harness-manifest.json"

[ -f "$manifest" ] || exit 0

# coreRepo by sed rather than by a JSON parser: jq is not a dependency of this repo and is
# not bundled with Git for Windows (checked: `command -v jq` misses in its shell), and pwsh,
# which does parse JSON, cannot be reached until the path this extracts is known and
# validated. Anchored on the key, first match wins, `q` stops the stream there. The value
# pattern walks escape pairs (\" \\ \/) so it cannot end early on an escaped quote. A
# malformed or absent key yields the empty string and exits silent below. A trailing CR from
# a CRLF manifest falls outside the capture: it sits after the closing quote, which the
# trailing `.*` consumes.
# The `2>/dev/null || exit 0` is not belt-and-braces over the [ -f ] above: a manifest that
# exists and cannot be read (mode, ACL, a dangling symlink) makes sed write to stderr and exit
# non-zero, and under `set -e` that aborts the hook with its complaint in the session start.
core_repo=$(sed -n '/"coreRepo"[[:space:]]*:/{s/.*"coreRepo"[[:space:]]*:[[:space:]]*"\([^"\\]*\(\\.[^"\\]*\)*\)".*/\1/p;q;}' "$manifest" 2>/dev/null) || exit 0
[ -n "$core_repo" ] || exit 0

# JSON escapes back to a real path. A Windows coreRepo is written with doubled separators
# ("E:\\projects\\core"), and some encoders escape the forward slash as well. Order matters:
# collapsing the pairs first stops a "\\/" from being read as an escaped slash.
core_repo=$(printf '%s\n' "$core_repo" | sed 's|\\\\|\\|g; s|\\/|/|g' 2>/dev/null) || exit 0

[ -d "$core_repo" ] || exit 0

# coreRepo must not name a directory inside the project being audited. Without this the check
# below is only a name-shape test: any directory holding install/Install-Harness.ps1 gets run,
# so a PR touching one JSON string value in .harness-manifest.json plus an
# install/Install-Harness.ps1 anywhere in the tree buys arbitrary PowerShell at every session
# start on every equipped machine. That is a real escalation over editing the hook, which is
# visible in review and prompted by Claude Code. A core checkout is by definition not part of
# a consumer project, so nothing legitimate is refused.
#   cd+pwd rather than a string compare on the raw values: the manifest holds a native path
# written by PowerShell and $root arrives in whatever form the harness set it, so the two are
# only comparable once both have been through the same normalization. CDPATH= because a
# relative coreRepo would otherwise resolve against it, and `--` because one starting with a
# dash would otherwise parse as an option.
core_abs=$(CDPATH= cd -- "$core_repo" 2>/dev/null && pwd) || exit 0
root_abs=$(CDPATH= cd -- "$root" 2>/dev/null && pwd) || exit 0
case "$core_abs/" in "$root_abs"/*) exit 0 ;; esac

# The same test again, case-folded, because pwd reports the case it was given rather than the
# case on disk: on Windows `cd` into a case-variant of the project root succeeds and the exact
# compare above then misses a path that is genuinely inside the project. Rejected the simpler
# single exact compare with the bypass written down as accepted risk: this repo is developed
# and run on Windows, so that would leave the check weakest on the platform it matters on.
# Folding both sides over-refuses only where a core checkout sits inside a case-variant
# sibling of the project root, which is not a configuration anyone has. If tr is absent the
# compare is not reached at all and the hook exits silent, which is the safe direction and
# the same silence as any other failure here.
core_lc=$(printf '%s' "$core_abs" | tr '[:upper:]' '[:lower:]' 2>/dev/null) || exit 0
root_lc=$(printf '%s' "$root_abs" | tr '[:upper:]' '[:lower:]' 2>/dev/null) || exit 0
case "$core_lc/" in "$root_lc"/*) exit 0 ;; esac

installer="$core_abs/install/Install-Harness.ps1"
[ -f "$installer" ] || exit 0

# Checked here rather than at the top of the file so the validation above still runs on a
# host with no pwsh, which is what keeps the security assertions in the test meaningful
# there instead of passing by an early exit.
command -v pwsh >/dev/null 2>&1 || exit 0

# stderr to /dev/null and a non-zero exit swallowed: an audit that throws is a degradation
# path like the rest, and its message belongs in an operator-run audit rather than in every
# session start. -NoProfile/-NonInteractive so a profile cannot print into this and a prompt
# cannot hang the session start.
out=$(pwsh -NoProfile -NonInteractive -File "$installer" -Target "$root" -Audit -Quiet 2>/dev/null) || exit 0
[ -n "$out" ] || exit 0

# One line per attention row in, one summary line out. The three statuses the design spec
# fixes wording for carry their action; every other status prints under its own audit name,
# so a status added to the audit later is still counted rather than silently dropped, and
# zero-count statuses never reach here at all. Ranked ones first, in the spec's order, then
# anything unranked in the order the audit emitted it: rejected plain first-seen ordering,
# which buries the two statuses that have a standing answer behind whichever row the audit
# happened to reach first.
printf '%s\n' "$out" | awk -F'\t' '
BEGIN {
  ranked = split("project-modified|core-updated|overlay (changed)", rank, "|")
  label["project-modified"] = "project-modified (promote?)"
  label["core-updated"] = "core-updated (re-run installer)"
  label["overlay (changed)"] = "overlay-changed (re-review, re-pin with -Accept)"
}
{
  sub(/\r$/, "")
  if ($1 == "") next
  if (!($1 in count)) { seen[++n] = $1 }
  count[$1]++
  total++
}
END {
  if (total == 0) exit 0
  line = ""
  for (i = 1; i <= ranked; i++) {
    s = rank[i]
    if (s in count) {
      line = line (line == "" ? "" : ", ") count[s] " " label[s]
      done[s] = 1
    }
  }
  for (i = 1; i <= n; i++) {
    s = seen[i]
    if (s in done) continue
    line = line (line == "" ? "" : ", ") count[s] " " s
  }
  print "harness drift: " line
}
' 2>/dev/null || exit 0

exit 0
