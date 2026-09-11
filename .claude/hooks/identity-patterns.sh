#!/bin/sh
# Shared identity-string matcher for the two git-hook gates that enforce
# security.md's mandate: the operator's legal name, personal email
# addresses, the workstation username, and the machine hostname must never
# reach a remote repository, and only a human may waive that. Sourced by
# core/claude/hooks/pre-commit and core/claude/hooks/pre-push. This file is
# a POSIX sh function library, not a hook itself -- it carries no shebang-
# driven behaviour of its own and is never invoked directly, only `.`-sourced.
#
# WHY A SHARED LIBRARY INSTEAD OF A SECOND COPY
# install/Export-Account.ps1 already carries pattern-matching logic for the
# same mandate (word-boundary lookarounds over a declared name/email list
# plus the derived workstation username). That script is PowerShell and only
# ever runs on Windows, on demand, by the operator. These two hooks are
# POSIX sh so they run identically under git for Windows, WSL, and Linux, on
# every commit and push regardless of who or what made them -- the exporter
# is not a dependency either hook can take. This file is the sh-side
# equivalent of the exporter's identity gate, shared between pre-commit and
# pre-push so the two cannot silently drift on what counts as an
# identifying string.
#
# WHY grep -E's \b, NOT A LOOKAROUND
# The exporter's regex uses `(?<!...)...(?!...)` lookarounds, which need
# PCRE. GNU grep's -P flag supports lookarounds, but measured on this
# workstation with LANG and LC_ALL both unset -- the default a git hook
# inherits -- `grep -P` exits 2 with "supports only unibyte and UTF-8
# locales" before it reads a single line, and setting LC_ALL=en_US.UTF-8 or
# LC_ALL=C.UTF-8 first makes it work. A check whose engine can refuse to run
# depending on the caller's locale is exactly the failure this file exists
# to close, so -P is not used anywhere here. GNU grep -E's `\b` extension
# needs no locale. Measured against the exact collision the exporter's own
# comment and its Export-Account.Tests.ps1 fixture record
# (Export-Account.Tests.ps1's "does not read a declared name out of an
# ordinary word that contains it"):
# skills/owasp-llm/references/08-vector-and-embedding-weaknesses.md:117
# reads "adjusting the augmentation process", which contains the operator's
# declared first name as a substring. That test
# fixture uses a synthetic four-letter declaration rather than the real
# name for the reason recorded there -- writing the real name into a file
# in this repo is the thing being prevented -- and this comment does the
# same: `printf 'adjusting\nJust arrived\n' | grep -iE '\bjust\b'` matches
# only the second line, exactly as it would for the real name this
# demonstrates without spelling it out.
#
# WHY grep -E, NEVER grep -F
# 2026-09-05's incident: MSYS grep -F aborted mid-scan on this workstation
# on one check in a batch (a hostname check, specifically), and the
# surrounding `|| echo NONE` printed a clean result over the crash -- every
# -F result in that batch was a false negative. -E is what the recovery
# re-ran with. Nothing in this file uses -F, and identity_control below is
# the check that catches a recurrence of exactly this failure shape,
# whatever causes it this time.
#
# KNOWN LIMIT: NON-ASCII CASE FOLDING
# `grep -i` folds ASCII case only under the locale this file runs with (LANG
# and LC_ALL both unset, by design, above). A declared name containing a
# non-ASCII letter -- "Zoë Farbleworth" -- is matched exactly as declared and
# in any all-lowercase or all-uppercase rendering of its ASCII letters, but
# a rendering that also case-folds the non-ASCII letter itself ("ZOË") does
# not fold to match, because grep -i never touches that byte. Measured
# 2026-09-05. Fixing this needs a UTF-8-aware locale (LC_ALL=C.UTF-8 or
# similar) for -i's folding, which reopens the `grep -P` locale-crash class
# of failure this file exists to avoid for a gap this narrow, so it is
# documented here rather than patched. The same byte-orientation is why
# identity_edge_ok below treats a non-ASCII byte at either edge of a
# declared entry as non-word: it is the same limitation, not a second one.

# --- pattern-set construction -------------------------------------------

# ERE-escapes a literal string for use inside the alternation this file
# builds. The bracket expression below is ordered so `]` sits first (POSIX:
# only literal there, never the closing delimiter) and `.` never
# immediately follows the bracket's own opening `[` -- `[.` inside a POSIX
# bracket expression opens a collating-symbol construct ([.ch.]), not a
# literal `[` followed by a literal `.`, and a naive `[.^$(){}...]` ordering
# sends sed hunting for a `.]` that never arrives, failing the whole
# expression with "unterminated `s' command". Measured: reordering so `.`
# is not bracket-adjacent to `[` is what fixes it; every other ERE
# metacharacter in the class is a plain literal inside `[...]` regardless
# of position.
identity_regex_escape() {
    printf '%s' "$1" | sed 's/[].^$(){}?+*|\\[]/\\&/g'
}

# Pulls every double-quoted string out of a JSON array value for $2 ("names"
# or "emails") in the raw text $1, one per output line. No jq dependency,
# matching session-start-drift-check.sh's precedent (jq ships with neither
# this repo nor Git for Windows). Handles the array spanning multiple lines
# by flattening newlines to spaces first; does not attempt general JSON
# parsing beyond the flat {"key": ["a", "b"]} shape
# install/Export-Account.ps1's -IdentityFile doc declares. An absent key or
# an empty array both produce no output, which the caller treats as "zero
# declared entries in this category", not as a malformed file.
identity_json_array() {
    raw=$1
    key=$2
    flat=$(printf '%s' "$raw" | tr '\n' ' ')
    seg=$(printf '%s' "$flat" | sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p")
    [ -n "$seg" ] || return 0
    printf '%s' "$seg" | grep -o '"\([^"\\]\|\\.\)*"' | sed 's/^"//; s/"$//; s/\\"/"/g'
}

# Resolves the identity file, derives the workstation username and machine
# hostname, and builds IDENTITY_PATTERN (one grep -iE alternation covering
# every declared name, every declared email, the username, and the
# hostname) plus IDENTITY_CANARIES (one line per entry in that alternation,
# consumed by identity_control below so every arm gets proved, not just
# one).
#
# THREE RETURN STATES, NOT TWO. 0 configured and loaded. 1 configured and
# BROKEN, which is fail-closed with a message on stderr: a file that exists
# and cannot be read, one that is not JSON-shaped, one declaring no names and
# no emails, an environment where the username or hostname cannot be
# discovered, or a declared entry that could never match anything once
# wrapped in \b (see identity_edge_ok below). 2 not configured at all, which
# prints a notice and lets the caller continue.
#
# That third state is a correction made 2026-09-06, and the reasoning matters
# more than the change. Issue #64's mandate reads "the gate exits non-zero
# when its pattern file is missing or unreadable. It must never scan for
# nothing and report clean", and this file implemented it literally, which
# meant a project that installed the harness had every commit refused from
# its first one. The mandate conflated two states. A file that EXISTS and
# cannot be read means something was declared and the gate cannot see it,
# which is dangerous and still refuses. A file that does not exist means no
# identity was declared, and a gate cannot protect an identity nobody named:
# refusing there protects nothing and only blocks.
#
# "Never scan for nothing and report clean" is still honoured, because state 2
# does not report clean. It says on stderr, on every single commit, that
# identity checks are skipped and how to enable them. Silence would be the
# violation; a notice is not.
#
# Export-Account.ps1's own loader warns and continues on a missing identity
# file, and has since before this hook existed. This now agrees with it.
#
# NO ENV-VAR OVERRIDE FOR THE FILE PATH OR THE DERIVED USERNAME/HOSTNAME.
# An earlier revision read CLAUDE_IDENTITY_FILE, IDENTITY_USERNAME_OVERRIDE
# and IDENTITY_HOSTNAME_OVERRIDE ahead of the real sources below, labelled
# "test seams, not operator-facing knobs" in a comment. Nothing enforced
# that label: pointing CLAUDE_IDENTITY_FILE at an empty or unpopulated file
# disabled every channel silently, with the hook still reporting success --
# worse than --no-verify, because a log shows a gate that ran and passed.
# Measured 2026-09-05. Tests get the same coverage a different way: set
# USERPROFILE (and HOME, for the Git-Bash-on-Windows case below) to a
# fixture directory holding a real .claude-account-identity.json, and set
# USERNAME/COMPUTERNAME directly -- both already read below, so a test
# needs no special-cased knob to control them.
identity_load() {
    # Prove the matcher works before ANYTHING trusts it, the parse below
    # included. identity_json_array uses grep to pull values out of the
    # identity file, so a grep that answers "no match" to everything makes a
    # populated file parse as empty -- and every downstream check then reports
    # accurately on a pattern set that was never built. Found by breaking grep
    # deliberately: the empty-arrays guard fired first and blamed the file,
    # which is a confident, wrong diagnosis of a broken tool.
    #
    # A fixed literal, not a value from the file, because at this point the
    # file has not been read and its contents cannot be assumed. Same grep
    # resolved off the same PATH, same -iE invocation as every later scan.
    if ! printf '%s\n' "identity-gate-canary" | grep -qiE 'identity-gate-canary'; then
        echo "identity gate: the matcher did not find its own canary in a fixed literal, before any file was read. grep is broken, shadowed on PATH, or crashing. Refusing rather than trusting anything it says -- 2026-09-05's incident was exactly this shape, a crashed grep -F whose surrounding '|| echo NONE' printed a clean result over the top." >&2
        return 1
    fi

    identity_file=${USERPROFILE:-$HOME}/.claude-account-identity.json

    # NO FILE AT ALL IS "NOT CONFIGURED", NOT "BROKEN", AND THE TWO ARE NOT THE
    # SAME STATE. This returned 1 until 2026-09-06, which meant a project that
    # installed this harness had every commit refused from the first one, with
    # nothing in the Quick Start saying an identity file had to exist. The
    # repository's whole purpose is installing into other projects, so that made
    # the shipped product unusable for its stated job on day one.
    #
    # The conflation was mine to make and worth naming: a missing file means the
    # operator has declared no identity, and a gate cannot protect an identity
    # nobody declared. Refusing there protects nothing; it only blocks. A file
    # that EXISTS and cannot be read is the genuinely dangerous state, because
    # something was declared and the gate cannot see it, and that still refuses
    # below.
    #
    # Return 2 rather than 0 or 1 so callers can tell the three states apart:
    # 0 configured, 1 broken and must refuse, 2 not configured. The notice goes
    # to stderr on every commit rather than staying silent, because a security
    # gate that is off should say so every time and not once.
    if [ ! -f "$identity_file" ]; then
        echo "identity gate: not configured, so identity checks are SKIPPED. To enable them, create '$identity_file' with the shape {\"names\": [...], \"emails\": [...]} naming the strings that must never reach a remote. Until then this hook checks nothing for identifying content." >&2
        return 2
    fi
    if [ ! -r "$identity_file" ]; then
        echo "identity gate: '$identity_file' exists but is not readable." >&2
        return 1
    fi

    raw=$(cat "$identity_file" 2>/dev/null)
    if [ -z "$raw" ]; then
        echo "identity gate: '$identity_file' is empty." >&2
        return 1
    fi
    case $raw in
        *'{'*'}'*) : ;;
        *)
            echo "identity gate: '$identity_file' does not look like a JSON object. A gate must not silently check less than it claims to; fix the file." >&2
            return 1
            ;;
    esac

    names=$(identity_json_array "$raw" names)
    emails=$(identity_json_array "$raw" emails)

    # Both empty is fail-closed, and the count check further down does not
    # cover it. That check fires only when the WHOLE pattern set is empty, and
    # the username and hostname arms below always contribute because they are
    # derived from the environment rather than read from the file. So a file
    # declaring `{"names": [], "emails": []}` -- or one whose keys got renamed
    # by an edit -- builds a pattern that still matches a username and a
    # hostname, passes the canary, and reports clean on a staged legal name.
    # Measured on 2026-09-05: with both arrays empty, a commit whose content
    # carried the name in the file was allowed.
    #
    # The name is the channel that actually leaked. Thirty commits carried one
    # in author and committer while a content scan of the same repository
    # reported clean, which is the incident this gate exists for. Degrading
    # silently to username-and-hostname is checking less than the gate claims
    # to, and the JSON-shape refusal above already states that rule; this
    # applies it to the case where the file parses and says nothing.
    if [ -z "$names" ] && [ -z "$emails" ]; then
        echo "identity gate: '$identity_file' parsed but declares no names and no emails. A file that names nothing cannot protect the channel this gate exists for -- populate it, or the gate is checking only the username and hostname it derived from the environment." >&2
        return 1
    fi

    # Derived, not read from the identity file: install/Export-Account.ps1's
    # own doc comment on -IdentityFile draws this line already -- the file
    # declares "the identifying strings that cannot be derived from the
    # environment", and a username or hostname is, by definition, sitting
    # right there in the environment the gate is already running in.
    # $USERNAME/$COMPUTERNAME first (Windows env vars Git Bash also
    # exports), because $HOME's leaf -- what the exporter uses -- carries
    # the same Git-Bash-vs-real-profile hazard hooks/pre-commit's own
    # USERPROFILE fallback exists for, and a git hook's inherited
    # environment cannot be assumed to be an interactive Git Bash session.
    username=${USERNAME:-}
    if [ -z "$username" ]; then
        username=$(whoami 2>/dev/null || id -un 2>/dev/null)
    fi
    if [ -z "$username" ]; then
        echo "identity gate: could not derive the workstation username (\$USERNAME unset, whoami and id -un both failed)." >&2
        return 1
    fi

    hostname_val=${COMPUTERNAME:-}
    if [ -z "$hostname_val" ]; then
        hostname_val=$(hostname 2>/dev/null)
    fi
    if [ -z "$hostname_val" ]; then
        echo "identity gate: could not derive the machine hostname (\$COMPUTERNAME unset, hostname failed)." >&2
        return 1
    fi

    entries=$(printf '%s\n%s\n%s\n%s\n' "$names" "$emails" "$username" "$hostname_val")

    # A single newline character, built once here rather than at every
    # accumulation site below. Needed because ${var:+word} requires "word" to
    # be inline text, and the plain single-quoted assignment spanning two
    # physical lines is the ordinary POSIX sh way to get one literal newline
    # into a variable without spawning a subshell for it.
    identity_nl='
'

    pattern=
    canaries=
    count=0
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        if ! identity_edge_ok "$entry"; then
            echo "identity gate: '$identity_file' or the derived username/hostname declares an entry whose first or last character is not a word character. Wrapped in \\b<entry>\\b, an entry like that can never match anything -- a dead arm that would otherwise report healthy from both identity_load and identity_control (finding 9, 2026-09-05: a name pasted as a whole author line, 'Name <email>', or with a trailing space). The offending value is deliberately not printed; check names/emails in '$identity_file' for a pasted author line or stray leading/trailing punctuation or whitespace." >&2
            return 1
        fi
        escaped=$(identity_regex_escape "$entry")
        pattern="${pattern}${pattern:+|}\\b${escaped}\\b"
        canaries="${canaries}${canaries:+$identity_nl}canary-${entry}-canary"
        count=$((count + 1))
    done <<EOF
$entries
EOF

    if [ "$count" -eq 0 ] || [ -z "$pattern" ]; then
        echo "identity gate: built an empty pattern set from '$identity_file' and the environment." >&2
        return 1
    fi

    IDENTITY_PATTERN=$pattern
    IDENTITY_CANARIES=$canaries
    return 0
}

# True (0) when $1's first and last characters are both a "word" character
# ([A-Za-z0-9_], the exact byte class \b tests a transition against in the C
# locale this file already runs under -- LANG and LC_ALL both unset). \b
# requires a word/non-word transition at that position; a non-word
# character AT either edge of the literal text makes that transition
# impossible for any real content the entry could appear in, so the arm
# this entry builds can never fire. A non-ASCII character at an edge is
# byte-wise non-word here too (every byte of a multi-byte UTF-8 sequence
# has its high bit set, outside [A-Za-z0-9_]) and gets refused for the same
# reason grep's own \b would not treat it as a word character in this
# locale -- the same ASCII-oriented limitation already accepted for case
# folding elsewhere in this file, not a new one, and fail-closed (refusing
# the whole load) rather than silently building a dead arm.
identity_edge_ok() {
    case $1 in
        '') return 1 ;;
        [A-Za-z0-9_]) return 0 ;;
        [A-Za-z0-9_]*[A-Za-z0-9_]) return 0 ;;
        *) return 1 ;;
    esac
}

# Before trusting any negative result from identity_match below, prove the
# exact matcher (same grep binary resolved off PATH, same -iE invocation,
# same pattern variable) still finds a string built from EVERY entry in the
# pattern set, not only one. A single fixed canary (originally just the
# username) proved the matcher works in general but left every other arm
# unproven -- a declared name could be a completely dead arm (identity_edge_ok
# above closes the known way that happens) while this control still reported
# healthy, because it never actually tried to match that arm. This is also
# what would have caught 2026-09-05's incident in the first place: a grep
# that crashes, or a PATH-shadowed grep that silently answers "no match" to
# everything, fails every one of these canaries before either hook ever
# trusts a clean scan.
identity_control() {
    identity_control_ok=1
    while IFS= read -r canary; do
        [ -n "$canary" ] || continue
        if ! printf '%s\n' "$canary" | grep -qiE "$IDENTITY_PATTERN"; then
            identity_control_ok=0
        fi
    done <<EOF
$IDENTITY_CANARIES
EOF
    if [ "$identity_control_ok" -eq 0 ]; then
        echo "identity gate: the matcher did not find the canary for at least one declared entry. Refusing rather than trusting a scan where an arm may be dead -- 2026-09-05's incident was exactly this shape for the whole matcher; this is the same check applied per declared entry, so one dead arm does not read as a healthy gate. The failing entry is deliberately not printed." >&2
        return 1
    fi
    return 0
}

# True (exit 0) when $1 carries any pattern in the resolved set. Never
# echoes $1 or the matched substring: the exporter's own identity gate
# names the file and the class of match and deliberately never the matched
# value, because printing it would put the string this gate exists to
# contain into console output, CI logs, and any transcript of the run. This
# function is the one shared call site every real check below goes through,
# so the exact invocation identity_control just proved works is the one
# that runs against real content.
identity_match() {
    # Not configured (identity_load returned 2, IDENTITY_PATTERN never set):
    # match nothing. Guarding here rather than at each of the six call sites
    # across the two hooks, because a call site added later would not know to
    # guard itself, and an unset pattern handed to `grep -iE` matches every
    # line rather than none -- the failure would be a gate that refuses
    # everything, not one that lets things past, but it is still wrong and it
    # would look like the gate working.
    [ -n "${IDENTITY_PATTERN:-}" ] || return 1
    printf '%s\n' "$1" | grep -qiE "$IDENTITY_PATTERN"
}
