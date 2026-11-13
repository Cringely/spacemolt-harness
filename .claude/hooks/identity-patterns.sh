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
# LC_ALL=C.UTF-8 first makes it work. Unset is not the same claim as no
# locale variable at all being set: #135's review measured, through a
# real git commit, that Git for Windows launches hooks with
# LC_CTYPE=C.UTF-8 regardless of LANG/LC_ALL. `grep -P`'s crash above
# does not depend on LC_CTYPE, so that finding still holds; LC_CTYPE is
# what matters for the byte-vs-character counting elsewhere in this file
# (identity_json_array's own LOCALE note covers where and why). A check
# whose engine can refuse to run depending on the caller's locale is
# exactly the failure this file exists to close, so -P is not used
# anywhere here. GNU grep -E's `\b` extension needs no locale. Measured
# against the exact collision the exporter's own
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
# `grep -i` folds ASCII case only under the locale this file runs with
# (LANG and LC_ALL both unset, by design, above -- though #135's review
# measured Git for Windows setting LC_CTYPE=C.UTF-8 regardless of that,
# a fact this paragraph does not depend on since it is about what grep
# folds, not about byte-vs-character counting; identity_json_array's own
# LOCALE note is where LC_CTYPE actually matters in this file). A
# declared name containing a non-ASCII letter -- "Zoë Farbleworth" -- is
# matched exactly as declared and
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

# ERE-escapes literal text for use inside the alternation this file builds,
# leaving the result in the global $identity_escaped. Escapes exactly the
# fourteen characters ] . ^ $ ( ) { } ? + * | \ [ and nothing else. Both
# directions matter and neither is cosmetic: an arm that escapes too little
# turns operator-declared text into live regex metacharacters, and an arm
# that escapes too much is an arm that can never fire.
# test/identity-gate.test.ts pins the set against a recorded input matrix
# rather than against this sentence.
#
# ONE CALL FOR THE WHOLE ENTRY LIST, NOT ONE PER ENTRY (#113). $1 may be a
# single entry or the entire newline-separated list of them, and the result
# is the same either way: `s///g` applies per line, and none of the fourteen
# characters is a newline. identity_load passes the whole list once and
# peels one escaped line per raw entry, so a twelve-name identity file runs
# this once rather than twelve times, and the sed count a pre-commit spawns
# stops growing with the number of declared entries -- which is #113's
# claim, and is what test/identity-gate.test.ts's counting test measures.
# The shape it replaced was this same pipeline read back through
# `escaped=$(identity_regex_escape "$entry")` INSIDE the per-entry loop,
# which spent four process spawns on every entry -- the $(...) subshell,
# both halves of the pipeline, and sed itself.
#
# WHY NOT A PER-CHARACTER PARAMETER-EXPANSION LOOP, WHICH IS WHAT #113
# SHIPPED FIRST. That loop peeled one character at a time with
# `tail=${rest#?}` and `char=${rest%"$tail"}`, and it is not byte-
# transparent. `${var%"$word"}` drops into bash's wide-character matcher
# whenever the word holds a backslash, and a byte that is not valid UTF-8
# comes back out of that matcher re-encoded: measured here, 0xE5 immediately
# followed by a backslash became 0xEF 0xBF 0xA5 under LC_CTYPE=C.UTF-8 --
# the LC_CTYPE Git for Windows sets for every hook it runs, per #135's
# review, and this function runs in the hook's own shell rather than in
# identity_json_array's forced-C subshell. A sweep of every lead byte
# 0xC0-0xF4 against six following characters, 318 cases, found 53
# divergences: one per lead byte, every one of them in the backslash column
# and none in the other five. Zero under LC_ALL=C. It failed
# CLOSED, because identity_control builds its canary from the raw entry and
# the arm from the escaped one, so a divergence refuses the commit instead
# of quietly narrowing detection. Fail-closed is not the bar: a security
# control's pattern set must not depend on the caller's locale at all, and
# sed never sees the shell's matcher, so the program below produces the same
# bytes under every locale.
#
# THE SENTINEL. `$(...)` strips every trailing newline, so writing an X
# inside the subshell and stripping one X back off is what keeps an entry
# that ends in a newline exact -- the one inexactness the old call site had,
# fixed rather than carried forward. `&&` rather than `;` so the sentinel is
# written only when sed succeeded and the status the caller tests is sed's:
# a crashed sed has to refuse, not hand back a short pattern set.
# 2026-09-05's incident was exactly that shape, a crashed `grep -F` whose
# surrounding `|| echo NONE` printed a clean result over the top.
#
# ON A NON-ZERO RETURN, $identity_escaped IS EMPTY (#172). A crashed sed can
# still write partial output to stdout before it dies, and `$(...)` captures
# whatever made it out, so the failure branch clears the variable explicitly
# rather than leaving that partial text sitting in a global a future caller
# might read without checking the status first.
#
# The bracket expression's ordering is load-bearing, which is why it is
# copied rather than retyped: `]` has to sit first (POSIX: only literal
# there, never the closing delimiter) and `.` can never immediately follow
# the bracket's own opening `[`, because `[.` opens a collating-symbol
# construct ([.ch.]) rather than matching a literal `[` then a literal `.`,
# and a naive `[.^$(){}...]` ordering sent sed hunting for a `.]` that never
# arrived, failing the whole expression with "unterminated `s' command".
identity_regex_escape() {
    identity_escaped=$(printf '%s' "$1" | sed 's/[].^$(){}?+*|\\[]/\\&/g' && printf X) || { identity_escaped=; return 1; }
    identity_escaped=${identity_escaped%X}
}

# Converts one hex digit character ($1, already validated by the caller as
# [0-9A-Fa-f]) to its decimal value 0-15, using plain `+`/`*` arithmetic:
# POSIX sh's `$(( ))` is not guaranteed to support the `16#XX` base-N
# literal ksh/bash add as an extension, and this file already avoids
# anything outside plain POSIX for the identical reason `grep -P` is
# avoided elsewhere in this header.
#
# Sets the global $identity_hexval rather than printing a value for the
# caller to capture with $(...). #135's review measured about 12 process
# spawns per \uXXXX escape in the printf-and-capture shape this used to
# have (6 cut, 4 of them this function's own command substitution, 2
# printf), enough that one declared entry with 150 escapes took 973s at
# pre-commit -- identity_json_unescape below calls this up to four times
# per escape, and a command substitution forks a subshell to capture
# output even when the command is a shell function, so the fork was the
# same cost regardless of how little work ran inside it. Called as a
# plain function call instead, this costs nothing beyond the case
# dispatch itself.
identity_hex_digit_value() {
    case $1 in
        [0-9]) identity_hexval=$1 ;;
        [Aa]) identity_hexval=10 ;;
        [Bb]) identity_hexval=11 ;;
        [Cc]) identity_hexval=12 ;;
        [Dd]) identity_hexval=13 ;;
        [Ee]) identity_hexval=14 ;;
        [Ff]) identity_hexval=15 ;;
        *) return 1 ;;
    esac
}

# Strips leading whitespace from $1 into the global $identity_trimmed, by
# repeated one-character parameter expansion rather than a sed fork.
# Used where identity_json_array needs this more than once per token
# (comma-and-whitespace between array elements, and whitespace after a
# closing ']') and the amount stripped is always small -- a handful of
# loop iterations beats one process spawn on the cost this file is
# written against (#135's review, same incident as above).
identity_ltrim() {
    identity_trimmed=$1
    while :; do
        case $identity_trimmed in
            [[:space:]]*) identity_trimmed=${identity_trimmed#?} ;;
            *) break ;;
        esac
    done
}

# Decodes JSON string escapes in $1 (the text strictly between a token's
# own quotes -- the caller strips those first). Prints the decoded text
# and returns 0. Returns 1, printing nothing, on an escape this function
# will not decode; the caller (identity_json_array) turns that into a load
# failure naming the identity file rather than silently emitting the
# literal, undecoded escape text the way this file did before issue #91d:
# a name declared as "F\u0069ctional Persona" never matched the plain
# "Fictional Persona" text it was meant to catch, because the \u0069 sat in
# the built grep pattern unchanged -- load succeeded, the per-arm canary
# passed (it is built from this same parse), and the plain text went
# straight through, a silent false negative rather than a loud one.
#
# \" \\ \/ decode always. \b \f \t decode to their real control bytes.
# \n and \r do NOT decode, on purpose: identity_load represents the whole
# parsed pattern set as one newline-delimited list (the `entries` variable
# a `while IFS= read -r entry` loop consumes, and the per-arm canaries
# built the same way), and a decoded \n or \r would inject a raw line
# break into that list, silently splitting one declared entry into two or
# merging it with its neighbour -- a new fail-open path in exchange for
# closing this one. No legitimate name or email plausibly needs an
# embedded line break; a JSON writer's actual reason to escape something
# in a declared identity string is a quote, a backslash, a slash, or (a
# \uXXXX run) something it will not write raw -- PowerShell's
# ConvertTo-Json escapes `'` `<` `>` `&` as \u0027 \u003c \u003e \u0026
# even for otherwise pure-ASCII input, which is the concrete case this
# fix targets, not a hypothetical one.
#
# \uXXXX decodes only for the printable-ASCII range \u0020-\u007e. Outside
# it (a JSON control character, a UTF-16 surrogate half, or a genuine
# non-ASCII code point) this refuses rather than guessing: emitting the
# right bytes needs a multi-byte UTF-8 encoder this POSIX sh + sed + grep
# + cut toolchain does not have, and this file's header already accepts
# an ASCII-only limit for `grep -i` case folding for the identical reason.
# A wrong guess here would build a dead or mismatched pattern arm exactly
# as silently as the undecoded escape did; refusing is loud instead.
#
# Byte-oriented throughout (cut -c, ${#var}, the `?` glob wildcard),
# which needs LC_ALL forced to C to be true, not merely LANG/LC_ALL being
# unset. #135's round-1 review measured, through a real git commit, that
# Git for Windows launches hooks with LC_CTYPE=C.UTF-8 set -- this file's
# header ("WHY grep -E's \b") is correct that a git hook inherits LANG
# and LC_ALL unset, but that is not the same claim as no locale variable
# being set, and LC_CTYPE alone is enough: under C.UTF-8, `cut -c` still
# counts bytes but ${#var} and `?` both count characters, and those
# disagree on any non-ASCII declared entry. identity_json_array, this
# function's only caller, forces LC_ALL=C in its own $(...) subshell
# before ever calling this (see that function's own LOCALE note), which
# is what actually makes "one byte is one character" true here.
#
# COST: #135's round-1 review measured about 12 process spawns per escape in this
# function's previous shape (6 cut, 4 digit subshells, 2 printf) -- one
# declared entry with 150 escapes took 973s at pre-commit, still 973s
# after #91c/#91d landed since this cost predates both. Below, escape
# detection, hex-digit extraction, and the advance past a decoded escape
# or a literal run all use `${var#pattern}`/`${var%%pattern}` parameter
# expansion instead of a `cut`/`sed` subprocess per character: no fork,
# run in the shell that is already running. \uXXXX's byte value is
# likewise computed with plain `/` and `%` arithmetic rather than
# `printf '%03o'`. What is left, one `printf` per escape to turn that
# numeric byte value into an actual character, has no POSIX parameter-
# expansion or arithmetic form -- emitting a byte from a number is not
# string manipulation, and `printf` is the smallest thing in this
# toolchain that can do it.
identity_json_unescape() {
    in=$1
    out=
    while [ -n "$in" ]; do
        case $in in
            '\'*)
                # A single-quoted shell literal is not escape-processed:
                # '\\' between single quotes is the two-character string
                # \\, not one backslash. '\'* -- a lone backslash closing
                # the quote, then an unquoted wildcard -- is what matches
                # "starts with one backslash". $rest, below, is everything
                # after that one backslash; matching on ITS first
                # character with a wildcard case pattern reads the escape
                # type without a `cut` fork to extract it into its own
                # variable first.
                rest=${in#\\}
                case $rest in
                    '"'*) out="${out}\"" ; in=${rest#?} ;;
                    '\'*) out="${out}\\" ; in=${rest#?} ;;
                    /*)   out="${out}/"  ; in=${rest#?} ;;
                    b*)
                        byte=$(printf '\010') || return 1
                        out="${out}${byte}" ; in=${rest#?}
                        ;;
                    f*)
                        byte=$(printf '\014') || return 1
                        out="${out}${byte}" ; in=${rest#?}
                        ;;
                    t*)
                        byte=$(printf '\011') || return 1
                        out="${out}${byte}" ; in=${rest#?}
                        ;;
                    u????*)
                        # Peels the four hex digits straight off $rest (no
                        # `cut`, and no separate $hex variable to strip
                        # back off again for the tail advance): each
                        # ${work%"${work#?}"} isolates $work's own first
                        # character the same way identity_hex_digit_value's
                        # caller used to isolate one out of a four-
                        # character $hex, just run four times in place, and
                        # $work IS the correctly-advanced remainder once
                        # all four are gone -- one fewer thing to
                        # reconstruct, not just one fewer fork. #135's
                        # review (cost, F5 in the original #91 review):
                        # this and the arithmetic below in place of
                        # `printf '%03o'` are what took this escape from
                        # about 3 process spawns down to the one left --
                        # actually emitting a byte from a numeric value has
                        # no POSIX parameter-expansion or arithmetic form,
                        # only `printf`.
                        work=${rest#u}
                        h1=${work%"${work#?}"}
                        work=${work#?}
                        h2=${work%"${work#?}"}
                        work=${work#?}
                        h3=${work%"${work#?}"}
                        work=${work#?}
                        h4=${work%"${work#?}"}
                        work=${work#?}
                        case $h1$h2$h3$h4 in
                            [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]) : ;;
                            *) return 1 ;;
                        esac
                        identity_hex_digit_value "$h1" || return 1 ; d1=$identity_hexval
                        identity_hex_digit_value "$h2" || return 1 ; d2=$identity_hexval
                        identity_hex_digit_value "$h3" || return 1 ; d3=$identity_hexval
                        identity_hex_digit_value "$h4" || return 1 ; d4=$identity_hexval
                        cp=$((d1 * 4096 + d2 * 256 + d3 * 16 + d4))
                        [ "$cp" -ge 32 ] && [ "$cp" -le 126 ] || return 1
                        o1=$((cp / 64))
                        o2=$(((cp / 8) % 8))
                        o3=$((cp % 8))
                        byte=$(printf "\\${o1}${o2}${o3}") || return 1
                        out="${out}${byte}"
                        in=$work
                        ;;
                    *) return 1 ;;
                esac
                ;;
            *)
                # One literal run up to (not including) the next backslash,
                # rather than one byte at a time -- most of a declared
                # entry's text has no escapes in it at all. `${in%%\\*}`
                # is the parameter-expansion form of `sed 's/\\.*$//'`:
                # strip the longest suffix starting at a backslash, i.e.
                # keep everything before the FIRST one.
                lit=${in%%\\*}
                [ -n "$lit" ] || return 1
                out="${out}${lit}"
                in=${in#"$lit"}
                ;;
        esac
    done
    printf '%s' "$out"
}

# Peels one complete JSON string token off the front of $1 into the global
# $identity_token, both of its own quotes included, and leaves
# $identity_token EMPTY when $1 does not start with a complete, terminated
# token. identity_json_array's only caller of this treats empty as a parse
# failure and refuses, so the empty result is the fail-closed answer, never
# "no entry here".
#
# EXACTLY WHAT IT REPLACED (#113). This was
# `sed -n 's/^\("\([^"\\]\|\\.\)*"\).*/\1/p'` run through a command
# substitution once per declared entry, which is three of the process
# spawns that issue counts. The BRE and the loop below agree by
# construction, and the agreement is the whole point, so it is worth
# writing down rather than leaving to a reader to re-derive:
#   - `^"` means the token must start with a quote. The `case` above does
#     that, and returns empty rather than scanning when it does not -- the
#     caller already checks, but a helper that silently mis-parses an input
#     its caller happens never to send is a trap for the next caller.
#   - `[^"\\]` is any byte that is neither a quote nor a backslash: the
#     literal branch below.
#   - `\\.` is a backslash and whatever follows it, consumed as a pair, so
#     an escaped quote cannot end the token: the backslash branch below.
#     `.` in a BRE does not match a newline, and neither does the branch
#     below need to care, because identity_json_array flattens every
#     newline to a space before any of this runs.
#   - The closing `"` is therefore the first quote not preceded by a
#     backslash, and `\(...\)*` cannot reach past it however greedy it is,
#     because neither inner branch can consume a bare quote.
#   - No closing quote, or a lone trailing backslash, means the BRE does
#     not match at all and sed prints nothing. Both return empty below.
#
# LOCALE: `?` counts bytes here rather than characters, because
# identity_json_array forces LC_ALL=C in its own subshell before calling
# this -- the same thing that made the old sed byte-oriented. See that
# function's LOCALE note, and #135's F1 for what the byte/character
# disagreement did when it was allowed to happen.
identity_json_token() {
    identity_token=
    case $1 in
        '"'*) : ;;
        *) return 0 ;;
    esac
    identity_tok_acc='"'
    identity_tok_rest=${1#\"}
    while :; do
        case $identity_tok_rest in
            '')
                # Ran out of input without a closing quote: unterminated.
                return 0
                ;;
            '"'*)
                identity_token="${identity_tok_acc}\""
                return 0
                ;;
            '\'*)
                # A single-quoted shell literal is not escape-processed, so
                # '\'* is "starts with one backslash" -- the same reading
                # identity_json_unescape's own header spells out.
                identity_tok_after=${identity_tok_rest#\\}
                [ -n "$identity_tok_after" ] || return 0
                identity_tok_tail=${identity_tok_after#?}
                identity_tok_char=${identity_tok_after%"$identity_tok_tail"}
                identity_tok_acc="${identity_tok_acc}\\${identity_tok_char}"
                identity_tok_rest=$identity_tok_tail
                ;;
            *)
                identity_tok_tail=${identity_tok_rest#?}
                identity_tok_char=${identity_tok_rest%"$identity_tok_tail"}
                identity_tok_acc="${identity_tok_acc}${identity_tok_char}"
                identity_tok_rest=$identity_tok_tail
                ;;
        esac
    done
}

# Pulls every double-quoted string out of a JSON array value for $2 ("names"
# or "emails") in the raw text $1, one per output line, with JSON string
# escapes decoded (identity_json_unescape, above). No jq dependency,
# matching session-start-drift-check.sh's precedent (jq ships with neither
# this repo nor Git for Windows). Handles the array spanning multiple lines
# by flattening newlines to spaces first; does not attempt general JSON
# parsing beyond the flat {"key": ["a", "b"]} shape
# install/Export-Account.ps1's -IdentityFile doc declares. An absent key or
# an empty array both produce no output, which the caller treats as "zero
# declared entries in this category", not as a malformed file.
#
# Peels one complete string token off the front of the array's contents at
# a time, rather than the single regex this used before that captured
# "everything up to the FIRST `]`" in one shot. Issue #91c: a `]` inside a
# declared entry's own text (a bracketed aside, redacted text, anything)
# is not a delimiter, and that regex stopped there -- the truncated,
# unterminated fragment left over then matched no quoted-string pattern at
# all, so the whole array read as empty rather than merely short one
# entry, silently losing that entry AND every entry declared after it.
# Consuming a whole token at a time (the same quote-and-backslash-aware
# shape the old code used for extraction, applied per-token instead of to
# an already-truncated segment) means a `]` inside a token's own text is
# already inside the token by the time anything looks at it; only a real
# `]`, seen after skipping the comma/whitespace between elements, ends the
# loop.
#
# Returns non-zero, printing nothing further, when a token cannot be
# decoded (identity_json_unescape's fail-closed cases, above) or the
# array's contents are malformed enough that no further complete token can
# be found before running out of input without ever seeing the closing
# `]`. identity_load treats that as a load failure and refuses -- a
# `]`-in-an-entry defect and a \uXXXX-in-an-entry defect are both a case of
# this parser checking less than it claims to, and this file's answer to
# "checks less than it claims" is to refuse, never to guess.
#
# LOCALE (#135's review): forced to C for the whole function, in this
# function's own $(...) subshell only. See identity_json_unescape's own
# LOCALE note for what breaks without it and why here, not there, is
# where forcing it is enough: this is the only caller of that function,
# and both use `cut -c`/`${#var}`/the `?` glob wildcard for length and
# offset work that must agree on bytes vs. characters to be correct.
# Scoped to this $(...) subshell rather than identity_load's own
# environment, so neither identity_load's rest nor the final `grep -iE`
# match sees a changed locale -- that match must keep whatever locale the
# top-level hook actually runs under (this file's header, "WHY grep -E's
# \b").
#
# KEY MATCH IS CASE-INSENSITIVE, NOT A LOCALE-DEPENDENT FOLD (issue #91). $2
# is always the literal "names" or "emails" from identity_load's two call
# sites, and the sed below used to match that literal case-sensitively, so
# a file declaring "Names" (a hand-edit, a differently-cased export from
# some other tool) read as the key never having been declared at all --
# the same silent-empty-channel shape as the missing-key case this
# function's own header already treats as "zero declared entries", except
# here the operator DID declare entries and the gate never saw them. Never
# `sed`'s `I` substitution flag, a GNU extension outside what this file's
# header commits to running under any sed, and never grep -i's locale-
# dependent case fold, the exact hazard this file's own "KNOWN LIMIT:
# NON-ASCII CASE FOLDING" header section already declines for the same
# reason. Both cases of each ASCII letter are spelled out explicitly
# instead, in a bracket expression, which needs no locale and no
# extension and works identically under any POSIX sed.
identity_json_array() {
    LC_ALL=C
    export LC_ALL

    raw=$1
    key=$2
    case $key in
        names) key_ci='[Nn][Aa][Mm][Ee][Ss]' ;;
        emails) key_ci='[Ee][Mm][Aa][Ii][Ll][Ss]' ;;
        *)
            echo "identity gate: internal error, identity_json_array called with an unknown key '$key'." >&2
            return 1
            ;;
    esac
    # Every tool whose output is read below appends a trailing x sentinel to
    # its input and the sentinel is checked before it is stripped: $(...)
    # strips trailing newlines, and a tool that exits 0 with empty or
    # truncated output must refuse, never read as "the key was not there".
    flat=$(printf '%sx' "$raw" | tr '\n' ' ') || return 1
    case $flat in
        *x) flat=${flat%x} ;;
        *)
            echo "identity gate: flattening '$identity_file' returned truncated or empty output. Refusing rather than reading what is left as the whole file." >&2
            return 1
            ;;
    esac

    # KEY PRESENCE (issue #91). Decided here in the shell, fail closed, over
    # one rule rather than a list of spellings: if the key word occurs
    # anywhere in the text (case-insensitive), it must occur exactly once,
    # as one double-quoted key followed by optional whitespace, ':',
    # optional whitespace and '['. Any other occurrence refuses: an unquoted
    # or single-quoted key, a comment between the key and its ':' or '[', the
    # word inside a comment or inside another key or value, a duplicate at
    # any depth, a string where the array belongs. Only a text that never
    # mentions the word reads as absent. Every earlier round patched one
    # lenient-JSON spelling that read as absent and the next review found
    # another. This rule has no list of spellings to fall behind.
    # Fail-closed false refusals: an entry or another key containing the
    # word, as in "nicknames" or "names@example.test".
    #
    # ESCAPED KEYS. JSON's only escape that yields a letter is backslash-u.
    # The presence test runs over a copy with backslash-u escapes for the
    # letters of both key words decoded, so a key spelled with escapes is
    # seen by the same rule. A key word found in that copy but not in the
    # raw text is an escaped key and refuses, since this parser does not
    # decode keys. Skipped without a fork when the text holds no backslash,
    # the usual case. Over-decoding an escaped backslash before a u can
    # only add an occurrence, never remove one, so it refuses rather than
    # reading as absent.
    case $flat in
        *'\'*)
            identity_arr_dec=$(printf '%sx' "$flat" | sed -e 's/\\u00[46]1/a/g' -e 's/\\u00[46]5/e/g' -e 's/\\u00[46]9/i/g' -e 's/\\u00[46][Cc]/l/g' -e 's/\\u00[46][Dd]/m/g' -e 's/\\u00[46][Ee]/n/g' -e 's/\\u00[57]3/s/g') || {
                echo "identity gate: the escaped-key check in '$identity_file' did not run cleanly. Refusing rather than reading a crashed check as no escaped key." >&2
                return 1
            }
            case $identity_arr_dec in
                *x) identity_arr_dec=${identity_arr_dec%x} ;;
                *)
                    echo "identity gate: the escaped-key check in '$identity_file' returned truncated or empty output. Refusing rather than reading it as no key." >&2
                    return 1
                    ;;
            esac
            ;;
        *) identity_arr_dec=$flat ;;
    esac
    case $identity_arr_dec in
        *${key_ci}*) ;;
        *) return 0 ;;
    esac
    identity_arr_before=${identity_arr_dec%%${key_ci}*}
    identity_arr_after=${identity_arr_dec#*${key_ci}}
    case $identity_arr_after in
        *${key_ci}*)
            echo "identity gate: '$identity_file' mentions \"$key\" (matched case-insensitively) more than once. It declares a key matching \"$key\" twice (a differently-cased key at the same level, or the key nested inside another object), or the word also appears in an entry, another key or a comment. Refusing rather than guessing which occurrence is the declaration. Keep exactly one '$key' key and no other mention of the word." >&2
            return 1
            ;;
    esac
    case $identity_arr_before in
        *'"') identity_arr_bad= ;;
        *) identity_arr_bad=1 ;;
    esac
    case $identity_arr_after in
        '"'*) ;;
        *) identity_arr_bad=1 ;;
    esac
    if [ -n "$identity_arr_bad" ]; then
        echo "identity gate: '$identity_file' mentions \"$key\" (matched case-insensitively) without double quotes around it as a key: an unquoted or single-quoted key, the word in a comment, or the word inside another key. This parser reads only a double-quoted key. Refusing rather than reading it as absent. Write it as \"$key\": [\"...\"]." >&2
        return 1
    fi
    case $flat in
        *${key_ci}*) ;;
        *)
            echo "identity gate: '$identity_file' has a key written with a JSON escape. This parser does not decode keys, so it cannot tell whether that key is \"names\" or \"emails\". Refusing rather than reading it as absent. Write every key with plain characters." >&2
            return 1
            ;;
    esac
    identity_ltrim "${identity_arr_after#\"}"
    case $identity_trimmed in
        ':'*) identity_ltrim "${identity_trimmed#:}" ;;
        *)
            echo "identity gate: '$identity_file' has \"$key\" (matched case-insensitively) not followed directly by ':'. Refusing rather than reading the key as absent." >&2
            return 1
            ;;
    esac
    case $identity_trimmed in
        '['*) ;;
        *)
            echo "identity gate: the '$key' value in '$identity_file' is not an array -- a string, a comment or other text sits where its '[' belongs. Refusing rather than reading the key as absent. Declare it as \"$key\": [\"...\"]." >&2
            return 1
            ;;
    esac

    # ONE sed takes the array's contents from the raw text, after the one
    # strict key the checks above proved is there. It must find it, so no
    # output (no sentinel) refuses: with the key present, an empty
    # extraction is a broken tool, not an absent key. #135's round-2 review
    # (N1): a crashed sed here once read as an absent key, so its status is
    # checked too.
    tail=$(printf '%sx' "$flat" | sed -n "s/.*\"${key_ci}\"[[:space:]]*:[[:space:]]*\\[//p") || {
        echo "identity gate: the '$key' key lookup in '$identity_file' did not run cleanly. Refusing rather than reading a crashed extraction as an absent key." >&2
        return 1
    }
    case $tail in
        *x) tail=${tail%x} ;;
        *)
            echo "identity gate: the '$key' key lookup in '$identity_file' returned truncated or empty output although the key is present. Refusing rather than reading it as absent." >&2
            return 1
            ;;
    esac

    while :; do
        identity_ltrim "$tail"
        rest=$identity_trimmed
        case $rest in
            ,*)
                identity_ltrim "${rest#,}"
                rest=$identity_trimmed
                ;;
        esac
        case $rest in
            ']'*)
                # #135's review (F7): breaking here on the first bare ']'
                # without checking what follows accepts a document where
                # this array's real content ends earlier than the ']'
                # just matched, with a stray value sitting between them --
                # e.g. ["Bob Example"] "Alice Example"], which is not
                # valid JSON. A well-formed object continues with ','
                # (another key) or '}' (the object ends); anything else
                # means this ']' is not trustworthy as this array's close.
                identity_ltrim "${rest#\]}"
                case $identity_trimmed in
                    ''|','*|'}'*) break ;;
                    *)
                        echo "identity gate: the '$key' array in '$identity_file' closes with ']' but is followed by something other than ',' or '}' -- not well-formed JSON here. Refusing rather than silently accepting it." >&2
                        return 1
                        ;;
                esac
                ;;
            '"'*)
                identity_json_token "$rest"
                token=$identity_token
                if [ -z "$token" ]; then
                    echo "identity gate: could not parse a declared '$key' entry in '$identity_file' -- an unterminated or malformed quoted string. Refusing rather than silently dropping it and whatever follows it." >&2
                    return 1
                fi
                inner=${token#\"}
                inner=${inner%\"}
                case $inner in
                    *'\'*)
                        decoded=$(identity_json_unescape "$inner") || {
                            echo "identity gate: a declared '$key' entry in '$identity_file' uses a JSON escape this parser will not decode (a \\uXXXX outside printable ASCII, or \\n/\\r, which would inject a line break into this file's own newline-delimited entry list). Refusing rather than silently building a pattern arm that would never match the entry's plain form. Rewrite the entry using the literal character instead of the escape." >&2
                            return 1
                        }
                        ;;
                    *)
                        # No backslash at all -- the common case for a
                        # plain declared name or email. Skip
                        # identity_json_unescape entirely rather than
                        # forking a subshell to run a loop that would
                        # just copy the string through unchanged: #135's
                        # review found this is most of the branch's added
                        # cost on an ordinary identity file (no escapes
                        # anywhere), separate from the \uXXXX cost above.
                        decoded=$inner
                        ;;
                esac
                printf '%s\n' "$decoded"
                tail=${rest#"$token"}
                ;;
            *)
                echo "identity gate: could not find the closing ']' for '$key' in '$identity_file' -- the declared array is malformed. Refusing rather than silently returning a truncated list." >&2
                return 1
                ;;
        esac
    done
    return 0
}

# WHY NOT ONE BATCHED awk/sed PASS FOR THE WHOLE SET (#113, #169). #113's
# own suggestion was "a single awk or a single sed invocation could produce
# the whole set" -- parsing the JSON, escaping every entry, and building
# IDENTITY_PATTERN and IDENTITY_CANARIES in one program, in place of the
# fixed few sed calls plus shell loops that shipped instead (identity_load
# below, and identity_regex_escape and identity_json_array above). #163's
# PR body named and rejected three narrower alternatives but never this
# one, the one #113 actually asked for, so the reason was undocumented
# until #169 flagged the gap.
#
# personal_terms_parse below already runs exactly this: a single batched
# awk pass over this same flat {"key": ["..."]} shape, token by token, with
# the same \uXXXX policy (its own COST note, #113). This file already does
# the walk a batched pass here would need, in the language #113 asked for
# -- so the hold-off is not that this file avoids awk/sed for that shape.
#
# The hold-off is what a rewrite would put at risk. identity_json_array is
# the parser #91 and #135 took four review rounds to harden, proved
# against the 43-row ARRAY_MATRIX in test/identity-gate.test.ts, and
# folding it into one pass means re-proving that matrix byte for byte on
# new code.
#
# What IS batched already: identity_regex_escape below takes one sed call
# for the whole newline-joined entry list rather than one per entry (see
# its own "ONE CALL FOR THE WHOLE ENTRY LIST" note), and identity_json_array
# above takes one tr call plus one sed call per key to find where that
# key's array starts. Moving identity_json_array onto a
# personal_terms_parse-style pass would save that fixed tr plus sed per
# key per run -- a real but small win on a control that already dropped
# from per-entry to fixed cost, against re-proving a parser #91 and #135
# already had to repair twice. Recorded here as a follow-up worth
# reconsidering if that cost is ever paid for another reason, not as a
# rejected idea.
#
# Detects a byte-order mark or an embedded NUL byte in the identity file at
# $1, before anything downstream reads it into a shell variable (issue #91).
# Neither POSIX sh nor bash can hold a NUL byte in a variable, so by the
# time bytes would reach identity_load's `raw=$(cat ...)` any NUL is
# already gone -- a UTF-16 file (with or without a byte-order mark) encodes
# every ASCII character as itself plus a NUL, and Windows PowerShell 5.1's
# `Out-File` default is UTF-16LE with a BOM, a realistic way this file gets
# written. An ASCII-only UTF-16 file happens to survive that NUL-stripping
# looking like plain text, but a non-ASCII declared name does not: each of
# its UTF-16 code units loses its NUL half and what remains is not valid
# UTF-8, so the pattern arm built from it never matches that name's real
# UTF-8 form in a scanned commit. Load succeeds, the per-arm canary in
# identity_control below is built from this same broken parse and passes,
# and the declared name goes straight through -- a silent false negative
# for the exact channel this gate exists to close, the same shape issue
# #91d already fixed for an undecoded \uXXXX escape.
#
# Checked with `od`, the only thing here that ever sees the file's actual
# bytes: everything captured through $(...) below is od's own hex TEXT
# output, which never contains a byte from the file itself, so it is safe
# to carry through a variable. `-v` disables od's repeated-line elision so
# a long run of NUL bytes cannot hide the first one. The shell's own word
# splitting then turns that output into one positional parameter per byte,
# and the loop below reads each one whole. That matters because two
# ordinary, non-NUL neighbouring bytes (0xd0 then 0x0f) concatenate to
# "d00f", and a bare substring search for "00" would misread that as a NUL
# that was never there.
#
# NO TOOL'S OUTPUT IS TRUSTED UNREAD, AND "NO EVIDENCE" IS NEVER "CLEAN"
# (issue #91, rounds 2 to 4). The round-2 probe split od's output with a
# `tr | sed` stage whose exit status nothing read, then asked
# `grep -qx 00`, where a crash reads the same as "no match": a sed stub
# that exited 1 emptied the byte list, and a UTF-16LE file loaded with its
# NULs dropped and its non-ASCII name unmatched. Round 3 checked every
# tool's exit status, and its review then showed that a tool which exits 0
# while lying still got through: an od printing two-byte words, octal or
# prose, a grep whose printed count and exit status disagree, and a split
# that followed the caller's IFS or expanded a glob. So grep is gone from
# the probe, and every word od printed is read in the shell itself. 00 is
# a NUL, any other two hex digits are a byte, and anything else refuses
# (3), because output this loop cannot read as bytes is not a measurement.
# An od that exits 0 with a dump in some other format therefore refuses,
# and so does a caller whose IFS splits od's output into words that are not
# bytes. IFS is not pinned here. No shipped hook changes it, and refusing
# under an unusual one is the fail-closed answer.
#
# The body runs in a subshell, ( ) rather than { }, so the `set -f` it
# needs never reaches the caller's shell: a glob character in od's output
# (only a lying od prints one) would otherwise be expanded against the
# working directory, and a file there named like a hex byte would turn it
# into a clean-looking one. Inside the subshell, `exit` ends the probe with
# its status. That costs one fork per identity_load.
#
# What no check here can catch: an od that exits 0 with well-formed hex
# bytes that are not the file's bytes (a dump truncated or fabricated at
# read time). Nothing in od's output alone tells that from the real thing.
#
# Returns:
#   0  clean -- no BOM, no NUL byte, and well-formed UTF-8 throughout
#   1  a UTF-16 byte-order mark, or a NUL byte anywhere in the file (with
#      or without a leading UTF-8 BOM -- non-BOM UTF-16, a UTF-8 BOM
#      pasted onto a UTF-16 body, or some other encoding this
#      byte-oriented parser cannot read), or any byte sequence that is
#      not valid UTF-8, such as a Latin-1 file (#206) -- the caller
#      refuses. The message is printed here, since only this function
#      still has the byte-level evidence
#   2  a UTF-8 byte-order mark and nothing else wrong -- EF BB BF is
#      three ordinary, non-NUL bytes, so $(...) carries it through
#      untouched and every parser in this file already skips past it on
#      the way to the first quoted key -- this reads correctly today
#      without this function's help. Reported anyway so the caller can
#      strip it before reading, so a byte-exact comparison against the
#      declared text is never carrying three bytes the operator never
#      typed. The NUL scan below still runs first, so a file starting
#      with a UTF-8 BOM but carrying a NUL later (a UTF-16 body pasted
#      behind it) returns 1, not 2.
#   3  the probe itself failed: od could not be run (missing, or the file
#      vanished between the readability check above and here), od printed
#      no bytes for a file that is not empty, or od printed a word that is
#      not one two-digit hex byte (a lying od, or an unusual IFS in the
#      calling shell) -- the caller refuses rather than reading a file
#      that might not be UTF-8 as though it were
identity_check_encoding() (
    identity_enc_file=$1
    identity_enc_out=$(od -An -tx1 -v "$identity_enc_file" 2>/dev/null) || {
        echo "identity gate: could not read '$identity_enc_file' byte-by-byte to check its encoding (od failed or is unavailable). Refusing rather than reading a file that might not be UTF-8 as if it were." >&2
        exit 3
    }
    # Unquoted on purpose: one positional parameter per hex byte. Globbing
    # is off first, so a glob character reaches the loop below as the word
    # od printed and is refused there.
    set -f
    set -- $identity_enc_out
    if [ "$#" -eq 0 ]; then
        # A genuinely empty file is identity_load's to report, below.
        [ -s "$identity_enc_file" ] || exit 0
        echo "identity gate: od printed no bytes for '$identity_enc_file', which is not empty. Refusing rather than reading an empty measurement as a clean file." >&2
        exit 3
    fi
    identity_enc_head=$1${2-}${3-}
    case $identity_enc_head in
        fffe*|feff*)
            echo "identity gate: '$identity_enc_file' starts with a UTF-16 byte-order mark. This parser reads bytes, not UTF-16 code units, and cannot decode it correctly -- silently misreading it would build a pattern that looks fine and does not match real content (issue #91: this is exactly what a UTF-16LE file with a non-ASCII declared name did). Re-save the file as UTF-8 and retry." >&2
            exit 1
            ;;
    esac
    # #91/round-2 review: the efbbbf case used to `return 2` right here,
    # before the NUL scan below ever ran. A UTF-8 BOM followed by a
    # UTF-16LE body (three ordinary bytes, then a body this byte-oriented
    # parser cannot read) matched that case and returned 2 -- "clean,
    # just strip the BOM" -- without the NUL scan ever seeing the body,
    # so the file loaded with rc 0 and a non-ASCII declared name went
    # straight through. That contradicts this function's own contract
    # just above: 0 or 2 is supposed to mean no NUL byte anywhere in the
    # file, not "no NUL byte before this early return". The BOM case now
    # only records that a strip is needed, and the NUL scan always runs.
    identity_enc_utf8_bom=0
    case $identity_enc_head in
        efbbbf*) identity_enc_utf8_bom=1 ;;
    esac
    # The digits are listed rather than written as ranges, so what counts
    # as a hex digit never depends on the locale's collation order.
    # #206: the same pass also walks the bytes as UTF-8 (RFC 3629: no
    # overlong forms, no surrogates, nothing above U+10FFFF). A Latin-1 or
    # Windows-1252 file has no NUL and no BOM, so everything above passes it,
    # but its accented letter is one byte that is not valid UTF-8, and the
    # arm built from it can never match the same name as git stores it. The
    # verdict is recorded rather than acted on in the loop, so a NUL later in
    # the file still gets its own, more specific, refusal first. Digit and
    # letter classes are listed, never ranged, for the same locale reason.
    identity_enc_need=0
    identity_enc_kind=any
    identity_enc_bad=0
    for identity_enc_byte do
        case $identity_enc_byte in
            00)
                echo "identity gate: '$identity_enc_file' contains a NUL byte, which no valid UTF-8 JSON document does. This is very likely UTF-16 without a byte-order mark, which this parser cannot decode correctly -- silently misreading it would build a pattern that looks fine and does not match real content. Re-save the file as UTF-8 and retry." >&2
                exit 1
                ;;
            [0123456789abcdef][0123456789abcdef]) : ;;
            *)
                echo "identity gate: od's output for '$identity_enc_file' is not one two-digit hex byte per word, so it is not a byte measurement this probe can read (an od printing some other format, or an unusual IFS in the calling shell). Refusing rather than reading it as a clean file." >&2
                exit 3
                ;;
        esac
        if [ "$identity_enc_need" -gt 0 ]; then
            # A continuation byte is owed. The first one after e0, ed, f0 and
            # f4 is narrower than 80-bf (overlong, surrogate, over U+10FFFF).
            identity_enc_ok=0
            case $identity_enc_kind in
                any) case $identity_enc_byte in [89ab]?) identity_enc_ok=1 ;; esac ;;
                e0) case $identity_enc_byte in [ab]?) identity_enc_ok=1 ;; esac ;;
                ed) case $identity_enc_byte in [89]?) identity_enc_ok=1 ;; esac ;;
                f0) case $identity_enc_byte in 9?|[ab]?) identity_enc_ok=1 ;; esac ;;
                f4) case $identity_enc_byte in 8?) identity_enc_ok=1 ;; esac ;;
            esac
            if [ "$identity_enc_ok" = 1 ]; then
                identity_enc_need=$((identity_enc_need - 1))
                identity_enc_kind=any
            else
                identity_enc_bad=1
                identity_enc_need=0
                identity_enc_kind=any
            fi
        else
            case $identity_enc_byte in
                [01234567]?) : ;;
                c[23456789abcdef]|d?) identity_enc_need=1 ;;
                e0) identity_enc_need=2 identity_enc_kind=e0 ;;
                ed) identity_enc_need=2 identity_enc_kind=ed ;;
                e[123456789abcef]) identity_enc_need=2 ;;
                f0) identity_enc_need=3 identity_enc_kind=f0 ;;
                f[123]) identity_enc_need=3 ;;
                f4) identity_enc_need=3 identity_enc_kind=f4 ;;
                *) identity_enc_bad=1 ;;
            esac
        fi
    done
    # A sequence cut off at end of file is as malformed as a stray byte.
    [ "$identity_enc_need" -gt 0 ] && identity_enc_bad=1
    if [ "$identity_enc_bad" = 1 ]; then
        echo "identity gate: '$identity_enc_file' is not valid UTF-8. It is most likely Latin-1 or Windows-1252, where an accented letter is one byte that git's UTF-8 never contains, so a declared name using one would build a pattern arm that cannot match it and the gate would report clean (issue #206). Re-save the file as UTF-8 and retry." >&2
        exit 1
    fi
    [ "$identity_enc_utf8_bom" = 1 ] && exit 2
    exit 0
)

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
    # included. identity_json_array once used grep to pull values out of the
    # identity file (it uses none since #91's residual fix), and a grep that
    # answered "no match" to everything made a populated file parse as empty
    # -- every downstream check then reported accurately on a pattern set
    # that was never built. Found by breaking grep
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

    identity_check_encoding "$identity_file"
    identity_enc_rc=$?
    identity_skip_bom=0
    case $identity_enc_rc in
        0) : ;;
        2) identity_skip_bom=1 ;;
        *) return 1 ;;
    esac

    if [ "$identity_skip_bom" = 1 ]; then
        # A UTF-8 byte-order mark: three ordinary bytes, skipped rather
        # than read, so nothing downstream carries three bytes the
        # operator never typed. See identity_check_encoding's own header.
        raw=$(tail -c +4 "$identity_file" 2>/dev/null)
    else
        raw=$(cat "$identity_file" 2>/dev/null)
    fi
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

    # identity_json_array itself already named the file and the specific
    # defect on stderr before returning non-zero (issue #91c, #91d): an
    # unparseable entry or an escape it will not decode. Propagate rather
    # than re-explain -- fail closed either way.
    names=$(identity_json_array "$raw" names) || return 1
    emails=$(identity_json_array "$raw" emails) || return 1

    # An absent names key refuses (issue #91, operator ruling 2026-11-11). The
    # name is the channel that leaked, and a file that never mentions the key
    # reads exactly like a hand-edit that dropped it, so silence cannot be a
    # choice. An explicit empty list ("names": []) is the deliberate opt-out
    # and stays accepted. identity_json_array has already refused every
    # malformed or escaped spelling of the key, so a key word still missing
    # from the text here means the key was never declared. Bracket classes,
    # not a case fold, for the same locale reason as identity_json_array.
    if [ -z "$names" ]; then
        case $raw in
            *[Nn][Aa][Mm][Ee][Ss]*) ;;
            *)
                echo "identity gate: '$identity_file' has no \"names\" key. The name is the channel this gate exists to protect, so a file that omits it is refused rather than read as declaring none. Add \"names\": [\"...\"], or write \"names\": [] to opt out explicitly." >&2
                return 1
                ;;
        esac
    fi

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

    # ONE escape for the whole list, ahead of the loop, rather than one call
    # per entry inside it (#113). `s///g` runs per line, so escaping the list
    # in a single pass produces exactly the bytes escaping each entry
    # separately would, and the loop below peels one escaped line per raw
    # entry. A sed that crashed rather than substituting would otherwise hand
    # back a short or empty pattern set that still passed every later check,
    # which is 2026-09-05's `grep -F` incident wearing a different binary's
    # name, so this refuses instead.
    if ! identity_regex_escape "$entries"; then
        echo "identity gate: escaping the declared entries did not run cleanly. sed failed, is shadowed on PATH, or crashed mid-substitution. Refusing rather than building a pattern set out of whatever it managed to print." >&2
        return 1
    fi
    identity_escaped_rest=$identity_escaped

    pattern=
    canaries=
    count=0
    while IFS= read -r entry; do
        # Peel this entry's escaped twin BEFORE the blank-line skip below, so
        # the two lists stay in lockstep: a blank raw line has a blank
        # escaped line facing it and both have to be consumed. The pattern
        # here is a literal newline followed by `*`, built in this file and
        # never from operator data -- it can never acquire the backslash that
        # sends ${var%...} into the wide-character matcher this function's
        # own header records re-encoding non-UTF-8 bytes. On the last line
        # there is no newline left to match, so `%%` returns the whole
        # remainder and `#` leaves it alone; the loop ends there either way.
        identity_escaped_one=${identity_escaped_rest%%"$identity_nl"*}
        identity_escaped_rest=${identity_escaped_rest#*"$identity_nl"}
        [ -n "$entry" ] || continue
        if ! identity_edge_ok "$entry"; then
            echo "identity gate: '$identity_file' or the derived username/hostname declares an entry whose first or last character is not a word character. Wrapped in \\b<entry>\\b, an entry like that can never match anything -- a dead arm that would otherwise report healthy from both identity_load and identity_control (finding 9, 2026-09-05: a name pasted as a whole author line, 'Name <email>', or with a trailing space). The offending value is deliberately not printed; check names/emails in '$identity_file' for a pasted author line or stray leading/trailing punctuation or whitespace." >&2
            return 1
        fi
        # The arm comes from the escaped line, the canary from the raw entry.
        # That asymmetry is deliberate and is what makes any future escaping
        # divergence fail closed: identity_control below feeds the canaries
        # through this same pattern, so an arm that no longer corresponds to
        # its entry refuses the commit rather than silently matching less
        # than was declared.
        pattern="${pattern}${pattern:+|}\\b${identity_escaped_one}\\b"
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
# ([A-Za-z0-9_], the exact byte class \b tests a transition against in the
# locale this file already runs under -- LANG and LC_ALL both unset,
# though #135's review measured Git for Windows setting LC_CTYPE=C.UTF-8
# regardless of that; grep -E's \b needs no locale either way, per this
# file's own "WHY grep -E's \b" header section, so that does not change
# the byte class \b tests here). \b requires a word/non-word transition
# at that position; a non-word
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

# --- personal-term channel (#147) ----------------------------------------
# Terms the operator wants kept out of a public repo that are not identity
# strings (project names and similar), read from a local-only JSON list:
#   {"terms": ["..."], "excludeMcpServers": ["..."]}
# install/Export-Account.ps1 reads the same file; these hooks use only
# "terms".
#
# OPT-IN PER CLONE, through local git config `harness.personalTermsFile`,
# not through a fixed path like the identity file. The list names one
# operator's material, and this library ships to every project that
# installs the harness and runs in CI; neither has the list, and neither
# should refuse for lacking it. Unset: this channel is skipped, silently.
# Set: a missing, empty, unparseable or term-less list refuses, because the
# clone opted in and a list the gate cannot read would check nothing. Read
# with --local so an environment or `-c` override cannot opt a clone out.
#
# COST (#113): one git config, one awk parse, one canary grep and one match
# grep per hook invocation, whatever the number of terms. No subprocess per
# term: the terms travel as one newline-separated -e pattern list, which
# grep -F treats as one pattern per line.
#
# grep -iF, AGAINST THIS FILE'S "NEVER grep -F" HEADER, BUT NEVER BARE. The
# 2026-09-05 abort that header records is Git Bash grep -iF exiting 134
# without a UTF-8 locale. Every -F call here sets LC_ALL=C.UTF-8, never
# tests grep with a bare `if`, and runs only after personal_terms_load's
# canary proved the same invocation finds every listed term. A regex form
# would need every term escaped, which is the per-term cost #113 names.
#
# No message here prints a term, the list's path, or a matched line.

personal_terms_nl='
'

# Parses the list at $1 in one awk process. Prints each term on its own
# line. Exit 0 parsed, 2 malformed, 3 an escape it will not decode, 4 no
# "terms" array, 5 a blank term. Accepts only the flat shape above: one
# object whose values are all arrays of strings. \uXXXX decodes only in
# printable ASCII and \n \r \b \f not at all, for the reasons
# identity_json_unescape gives. Backslash, quote, tab and CR come from
# sprintf("%c") so this program carries no escape sequence of its own.
personal_terms_parse() {
    LC_ALL=C awk '
function ws() {
    while (p <= n) {
        c = substr(s, p, 1)
        if (c == " " || c == tab || c == nl || c == cr) p++
        else break
    }
}
function str(   out, c, e, h, i, d, cp) {
    out = ""
    p++
    while (p <= n) {
        c = substr(s, p, 1)
        if (c == dq) { p++; return out }
        if (c == bs) {
            e = substr(s, p + 1, 1)
            if (e == dq || e == bs || e == "/") { out = out e; p += 2; continue }
            if (e == "t") { out = out tab; p += 2; continue }
            if (e == "u") {
                h = tolower(substr(s, p + 2, 4))
                if (length(h) != 4) { err = 3; return "" }
                cp = 0
                for (i = 1; i <= 4; i++) {
                    d = index(hex, substr(h, i, 1))
                    if (d == 0) { err = 3; return "" }
                    cp = cp * 16 + d - 1
                }
                if (cp < 32 || cp > 126) { err = 3; return "" }
                out = out sprintf("%c", cp)
                p += 6
                continue
            }
            err = 3
            return ""
        }
        if (c < " ") { err = 2; return "" }
        out = out c
        p++
    }
    err = 2
    return ""
}
BEGIN {
    bs = sprintf("%c", 92); dq = sprintf("%c", 34); tab = sprintf("%c", 9)
    nl = sprintf("%c", 10); cr = sprintf("%c", 13); hex = "0123456789abcdef"
}
{ doc = doc $0 nl }
END {
    s = doc; n = length(s); p = 1; err = 0; nterms = -1
    ws()
    if (substr(s, p, 1) != "{") exit 2
    p++
    ws()
    if (substr(s, p, 1) == "}") p++
    else {
        for (;;) {
            ws()
            if (substr(s, p, 1) != dq) exit 2
            key = str()
            if (err) exit err
            ws()
            if (substr(s, p, 1) != ":") exit 2
            p++
            ws()
            if (substr(s, p, 1) != "[") exit 2
            p++
            count = 0
            ws()
            if (substr(s, p, 1) == "]") p++
            else {
                for (;;) {
                    ws()
                    if (substr(s, p, 1) != dq) exit 2
                    v = str()
                    if (err) exit err
                    count++
                    vals[count] = v
                    ws()
                    c = substr(s, p, 1)
                    p++
                    if (c == ",") continue
                    if (c == "]") break
                    exit 2
                }
            }
            if (key == "terms") {
                if (nterms >= 0) exit 2
                nterms = count
                for (i = 1; i <= count; i++) terms[i] = vals[i]
            }
            ws()
            c = substr(s, p, 1)
            p++
            if (c == ",") continue
            if (c == "}") break
            exit 2
        }
    }
    ws()
    if (p <= n) exit 2
    if (nterms < 0) exit 4
    for (i = 1; i <= nterms; i++) {
        t = terms[i]
        blank = 1
        for (j = 1; j <= length(t); j++) {
            c = substr(t, j, 1)
            if (c != " " && c != tab) { blank = 0; break }
        }
        if (blank) exit 5
        print t
    }
    exit 0
}' "$1"
}

# Three states, like identity_load: 0 loaded and proved, 1 opted in and
# broken (message on stderr, caller refuses), 2 not opted in (silent).
# Sets PERSONAL_TERMS to the newline-separated term list on 0.
personal_terms_load() {
    PERSONAL_TERMS=
    personal_terms_file=$(git config --local --type=path --get harness.personalTermsFile 2>/dev/null)
    personal_terms_rc=$?
    case $personal_terms_rc in
        0) : ;;
        1) return 2 ;;
        *)
            echo "personal-term gate: could not read git config harness.personalTermsFile (git config exited $personal_terms_rc). Refusing rather than reading a config error as opted out." >&2
            return 1
            ;;
    esac
    if [ -z "$personal_terms_file" ]; then
        echo "personal-term gate: git config harness.personalTermsFile is set but empty. Point it at the list, or unset it to opt this clone out." >&2
        return 1
    fi
    if [ ! -f "$personal_terms_file" ] || [ ! -r "$personal_terms_file" ]; then
        echo "personal-term gate: git config harness.personalTermsFile is set, but the file it names is missing or unreadable. Refusing: this clone opted in, and a list the gate cannot read checks nothing. Restore the file, or unset the key to opt this clone out." >&2
        return 1
    fi
    if [ ! -s "$personal_terms_file" ]; then
        echo "personal-term gate: the list named by git config harness.personalTermsFile is empty. A list naming nothing protects nothing." >&2
        return 1
    fi

    personal_terms_list=$(personal_terms_parse "$personal_terms_file")
    personal_terms_rc=$?
    case $personal_terms_rc in
        0) : ;;
        3)
            echo "personal-term gate: the list named by git config harness.personalTermsFile uses a JSON escape this parser will not decode (\\n, \\r, \\b, \\f, or \\uXXXX outside printable ASCII). Write the character itself. The entry is not printed." >&2
            return 1
            ;;
        4)
            echo "personal-term gate: the list named by git config harness.personalTermsFile has no \"terms\" array." >&2
            return 1
            ;;
        5)
            echo "personal-term gate: the list named by git config harness.personalTermsFile holds a blank term, which would match every line." >&2
            return 1
            ;;
        *)
            echo "personal-term gate: the list named by git config harness.personalTermsFile is not the JSON shape {\"terms\": [\"...\"]} (parser exited $personal_terms_rc). Refusing rather than checking less than it claims to." >&2
            return 1
            ;;
    esac
    if [ -z "$personal_terms_list" ]; then
        echo "personal-term gate: the list named by git config harness.personalTermsFile declares no terms. A list naming nothing protects nothing." >&2
        return 1
    fi

    # One canary line per term, matched in ONE grep -c against the whole
    # list: the count must equal the number of terms. A grep that aborts
    # (exit >1, empty count), answers "no match" to everything, or ignores
    # the locale fails this before any scan is trusted.
    personal_terms_canaries=
    personal_terms_count=0
    while IFS= read -r personal_term; do
        [ -n "$personal_term" ] || continue
        personal_terms_canaries="${personal_terms_canaries}${personal_terms_canaries:+$personal_terms_nl}personal-term-canary-${personal_term}-canary"
        personal_terms_count=$((personal_terms_count + 1))
    done <<EOF
$personal_terms_list
EOF
    personal_terms_hits=$(printf '%s\n' "$personal_terms_canaries" | LC_ALL=C.UTF-8 grep -ciF -e "$personal_terms_list")
    personal_terms_rc=$?
    if [ "$personal_terms_rc" -gt 1 ] || [ "$personal_terms_hits" != "$personal_terms_count" ]; then
        echo "personal-term gate: the matcher did not find the canary built from every listed term (grep exited $personal_terms_rc). grep is broken, shadowed on PATH, or aborting. Refusing rather than trusting a scan it cannot prove. No term is printed." >&2
        return 1
    fi

    PERSONAL_TERMS=$personal_terms_list
    return 0
}

# Returns grep's own status: 0 a term matched, 1 none, anything else the
# scan failed. Callers must treat "anything else" as a refusal; a bare
# `if personal_term_match` reads an abort as clean.
personal_term_match() {
    [ -n "${PERSONAL_TERMS:-}" ] || return 1
    LC_ALL=C.UTF-8 grep -qiF -e "$PERSONAL_TERMS" <<EOF
$1
EOF
}

# $1 hook name, $2 what carries the term. Never the term itself.
personal_term_refuse() {
    echo "$1: refused. $2 carries a term from the personal-terms list (the file git config harness.personalTermsFile names). The matched term is deliberately not printed. Remove it, then retry." >&2
    exit 1
}

# $1 hook name, $2 grep's exit status.
personal_term_scan_failed() {
    echo "$1: refused. The personal-term scan did not run cleanly (grep exited $2). Refusing rather than reading a failed scan as clean." >&2
    exit 1
}
