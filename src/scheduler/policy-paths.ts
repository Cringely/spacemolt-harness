// D3 policy-path fence (#114): the path lists and pure checks behind
// scripts/policy-path-gate.ts. Council pre-mortem verdict (c): a headless
// spawn must never be able to edit its own instructions, so headless commits
// are ALLOWLISTED to the doc-steward write surface — anything not on the list
// is rejected, and a novel path fails closed by construction.

/**
 * The headless service user on the scheduler host (runbook step 1). Deploy-time
 * config: the REAL username lives in the scheduler host's env file as
 * SCHEDULER_SERVICE_USER, never in this repo. The default is a generic
 * placeholder so a fresh clone and every non-scheduler host recognize no one as
 * headless — the fence stays dormant off the deploy host.
 *
 * SECURITY (fail-OPEN, not closed): if the deploy host's env omits
 * SCHEDULER_SERVICE_USER, the real service user no longer matches this default,
 * isHeadless() returns false for it, and the fence goes DORMANT for the very
 * account it exists to fence — a headless spawn regains the ability to commit
 * outside the doc-steward allowlist. The scheduler env file MUST set
 * SCHEDULER_SERVICE_USER before a deployed tick runs.
 *
 * The same env var + default is duplicated in .githooks/pre-commit's bun-absent
 * branch (sh cannot import this) — change both together.
 */
export const SERVICE_USER = process.env.SCHEDULER_SERVICE_USER ?? "scheduler-svc";

/**
 * Everything a headless commit may touch — exactly the doc-steward's write
 * surface (charter steps: STATE NOW, milestones, backlog, decisions
 * cross-refs, README progress, lessons, archival), nothing more. An edit here
 * is a security-relevant change: the disjointness test in
 * test/policy-path-gate.test.ts must keep passing against POLICY_PATHS.
 */
export const HEADLESS_WRITE_ALLOWLIST = [
  "docs/STATE.md",
  "docs/milestones.md",
  "docs/backlog.md",
  "docs/decisions.md",
  "README.md",
  "docs/assets/**",
  "docs/archive/**",
  "docs/wiki/engineering-lessons.md",
] as const;

/**
 * The council's fence list: the files that DEFINE headless behavior. Rejection
 * never consults this list (the allowlist already rejects everything off it);
 * it exists to pin the fence — the disjointness test fails the build if a
 * future HEADLESS_WRITE_ALLOWLIST edit overlaps any entry here.
 */
export const POLICY_PATHS = [
  "docs/charters/**",
  "docs/briefs/**",
  "docs/wiki/working-agreements.md",
  "docs/wiki/security-controls.md",
  ".claude/guardrails.md",
  "AGENTS.md",
] as const;

/**
 * OS-username check, not an env flag: a spawned agent can unset env for a
 * child `git commit`; it cannot change who it runs as.
 */
export function isHeadless(username: string): boolean {
  return username === SERVICE_USER;
}

/**
 * ponytail: matcher handles exactly the two shapes the lists use — an exact
 * repo-relative path and a `dir/**` prefix. Grow it only when a list entry
 * needs more; a general glob engine here is dead flexibility.
 */
export function pathMatchesPattern(path: string, pattern: string): boolean {
  const p = path.replaceAll("\\", "/");
  if (pattern.endsWith("/**")) return p.startsWith(pattern.slice(0, -2));
  return p === pattern;
}

/** One staged index entry as `git diff --cached --raw -z --no-renames`
 *  reports it: dst (post-image) mode + repo-relative forward-slash path. */
export type StagedEntry = { mode: string; path: string };

/**
 * Modes a headless commit may land: regular file, executable, and 000000
 * (deletion — nothing lands in the tree, the path check still applies, and
 * blocking deletes outright would brick legitimate steward archival moves).
 * Everything else is rejected — a 120000 symlink staged AT an allowlisted
 * path aliases an arbitrary file, so on the Linux deploy target
 * (core.symlinks=true) the steward's next legitimate write would mutate the
 * aliased file through the link.
 */
const HEADLESS_MODES = new Set(["100644", "100755", "000000"]);

/**
 * Parse `git diff --cached --raw -z --no-renames` output into staged entries.
 * Returns null on any record it does not fully recognize; the gate treats
 * null as fail-closed. Rename/copy records (R/C, two paths) are deliberately
 * unrecognized: `--no-renames` keeps them impossible, and if that flag ever
 * regresses the gate refuses the commit instead of checking only the rename
 * destination (the coalescing leak the flag exists to stop).
 */
export function parseStagedRaw(raw: string): StagedEntry[] | null {
  const tokens = raw.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const entries: StagedEntry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const meta = tokens[i];
    const path = tokens[i + 1];
    if (meta === undefined || path === undefined || path.length === 0) return null;
    // :<oldmode> <newmode> <oldsha> <newsha> <status> — single-path statuses only.
    const fields = meta.split(" ");
    if (fields.length !== 5) return null;
    const mode = fields[1];
    const status = fields[4];
    if (!fields[0]?.startsWith(":") || mode === undefined || !/^[0-7]{6}$/.test(mode)) return null;
    if (status === undefined || !/^[AMDTU]$/.test(status)) return null;
    entries.push({ mode, path });
  }
  return entries;
}

/** Allowlist + mode check over staged entries: every path must sit on
 *  HEADLESS_WRITE_ALLOWLIST and every entry must land as a regular file
 *  (or a deletion — see HEADLESS_MODES). */
export function checkStagedEntries(entries: StagedEntry[]): { ok: boolean; rejected: string[] } {
  const rejected: string[] = [];
  for (const { mode, path } of entries) {
    if (!HEADLESS_WRITE_ALLOWLIST.some((pattern) => pathMatchesPattern(path, pattern))) {
      rejected.push(path);
    } else if (!HEADLESS_MODES.has(mode)) {
      rejected.push(`${path} (staged mode ${mode}; headless commits may land regular files only)`);
    }
  }
  return { ok: rejected.length === 0, rejected };
}

/** Path-only convenience over checkStagedEntries (modes assumed regular). */
export function checkStagedPaths(paths: string[]): { ok: boolean; rejected: string[] } {
  return checkStagedEntries(paths.map((path) => ({ mode: "100644", path })));
}
