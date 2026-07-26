#!/usr/bin/env python3
"""Regenerate docs/backlog.md from the backlog repo's GitHub Issues.

The backlog SSOT is the GitHub Issues of the PRIVATE `Cringely/spacemolt`
repo, not this (public `spacemolt-harness`) repo the script lives in. The
2026-07-21 public flip moved code here and left issues there — see
AGENTS.md's repo-split banner. This script always targets `BACKLOG_REPO`
explicitly via `gh --repo`, never the CWD-inferred repo, so running it from
any checkout still reads the real backlog (#550: an implicit `gh` call
silently regenerated this file from spacemolt-harness's own 3 leftover
issues, nearly deleting the operator's only remote view of the 48-issue
backlog).

This renders a versioned, in-git VIEW of them so the backlog is portable and
lives in git history, not in an account-hosted Projects board. The doc-steward
re-runs this after a merge cluster (see docs/wiki/working-agreements.md).

Usage:  python3 scripts/gen-backlog.py   (needs `gh` authenticated with read
        access to Cringely/spacemolt)
Groups open issues by epic label; `[P]` = parked; size from the size:* label.
"""
import json, os, re, subprocess, sys

# The backlog SSOT, per AGENTS.md's repo-split banner (#550). Passed to every
# `gh` call explicitly — never rely on CWD inference, which resolves against
# whatever repo the script happens to run from.
BACKLOG_REPO = "Cringely/spacemolt"

# A regen finding fewer than this fraction of the PREVIOUS run's open-issue
# count almost always means `gh` asked the wrong server, not that the backlog
# emptied out (#550). FLOOR_ABSOLUTE backstops the first-run case, where there
# is no previous count to compare against.
FLOOR_FRACTION = 0.5
FLOOR_ABSOLUTE = 10

EPIC_ORDER = ["epic:improv-mode", "epic:pilot-tuning", "epic:observability",
              "epic:tech-debt", "epic:fleet", "epic:process"]
EPIC_NAME = {"epic:improv-mode": "Improv mode", "epic:pilot-tuning": "Pilot tuning",
             "epic:observability": "Observability", "epic:tech-debt": "Tech debt",
             "epic:fleet": "Fleet (parked)", "epic:process": "Process"}


def labels(it):
    return {l["name"] for l in it["labels"]}


def size(it):
    for s in ("size:S", "size:M", "size:L", "size:XL"):
        if s in labels(it):
            return s.split(":")[1]
    return ""


def epic(it):
    for e in EPIC_ORDER:
        if e in labels(it):
            return e
    return "epic:process"


def previous_count(out_path):
    """Best-effort read of the last `_Regenerated from N open issues._` count
    out of the existing file. Returns None when there is nothing usable to
    compare against (no file yet, or the header no longer matches this
    pattern) — the caller must treat None as "no calibration data", not as
    "no floor applies" (see FLOOR_ABSOLUTE), or the check goes vacuous on
    exactly the run that most needs it: the very first one."""
    if not os.path.exists(out_path):
        return None
    with open(out_path, encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"_Regenerated from (\d+) open issues\._", text)
    return int(m.group(1)) if m else None


def check_floor(n_open, prev, out_path):
    """Refuse to proceed when `n_open` is implausibly small. Self-calibrating:
    the floor is half of whatever the last successful run wrote, so it holds
    at any backlog size without a magic constant that rots as the backlog
    grows or shrinks for real reasons. FLOOR_ABSOLUTE covers the case with no
    prior count to calibrate from (first run, or a hand-edited/corrupted
    header) — without it, that path would have no floor at all, exactly the
    gap that let #550 slip through population zero."""
    floor = max(FLOOR_ABSOLUTE, int(prev * FLOOR_FRACTION)) if prev is not None else FLOOR_ABSOLUTE
    if n_open < floor:
        basis = f"half of the last known {prev}" if prev is not None else "the first-run minimum"
        sys.exit(
            f"gen-backlog: REFUSING to write {out_path}: found only {n_open} open "
            f"issues, below the floor of {floor} ({basis}). This almost always means "
            f"`gh` resolved against the wrong repo, not that the backlog emptied out "
            f"(#550) — confirm `gh issue list --repo {BACKLOG_REPO} --state open` "
            f"returns the real count before re-running. Existing file left untouched."
        )


def repo_root():
    # The worktree we will commit from, resolved from CWD — NOT a fixed path or
    # the git common-dir, both of which point at the MAIN checkout from a linked
    # worktree and would leak the generated file outside the steward's branch
    # (#321). A relative "docs/backlog.md" trusts CWD; anchoring to the toplevel
    # is correct even when the script is invoked from a subdirectory.
    return subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True).stdout.strip()


def main():
    root = repo_root()
    out_path = os.path.join(root, "docs", "backlog.md")
    raw = subprocess.run(
        ["gh", "issue", "list", "--repo", BACKLOG_REPO, "--state", "all", "--limit", "300",
         "--json", "number,title,labels,state"],
        capture_output=True, text=True, check=True).stdout
    issues = json.loads(raw)
    open_by_epic = {e: [] for e in EPIC_ORDER}
    done = []
    for it in issues:
        (done if it["state"] == "CLOSED" else open_by_epic[epic(it)]).append(it)

    n_open = sum(len(v) for v in open_by_epic.values())
    check_floor(n_open, previous_count(out_path), out_path)
    out = ["# Backlog\n",
           "> **Generated file — do not hand-edit.** The GitHub Issues in the "
           f"private `{BACKLOG_REPO}` repo are the source of truth for the "
           "backlog (this file lives in `spacemolt-harness`); this is a "
           "versioned, in-git VIEW of them, regenerated by "
           "`scripts/gen-backlog.py` (the doc-steward runs it after a merge "
           "cluster — see `docs/wiki/working-agreements.md`). It lives in the "
           "repo so the backlog is versioned and portable, not "
           "account-hosted. `[P]` = parked; size is S/M/L/XL.\n",
           f"_Regenerated from {n_open} open issues._\n"]
    for e in EPIC_ORDER:
        its = sorted(open_by_epic[e], key=lambda x: x["number"])
        if not its:
            continue
        out.append(f"\n## {EPIC_NAME[e]}\n")
        for it in its:
            p = " `[P]`" if "parked" in labels(it) else ""
            sz = f" `{size(it)}`" if size(it) else ""
            out.append(f"- #{it['number']}{sz}{p} — {it['title']}")
    if done:
        out.append("\n## Recently done (closed)\n")
        for it in sorted(done, key=lambda x: -x["number"])[:20]:
            out.append(f"- ~~#{it['number']} — {it['title']}~~")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    # Absolute path so steward-prep can confirm the write landed inside the tree
    # it will commit from (#321), not just that a file was written somewhere.
    print(f"wrote {out_path} ({n_open} open issues)")


if __name__ == "__main__":
    main()
