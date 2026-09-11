// Shared by agent-worktree-gate.ts and agent-write-scope.ts. Not itself a hook: nothing in
// core/claude/templates/settings.hooks.json wires it, and it exits without side effects if it is
// ever run. It lives in this directory anyway because the installer copies
// `core/claude/hooks/*` wholesale into `<target>/.claude/hooks/`
// (install/Install-Harness.ps1), so a module the two hooks import has to sit beside them or the
// import breaks in every installed project. A `core/claude/lib/` would read better and would need
// installer and manifest changes to carry it.
//
// One definition rather than a copy in each hook: the two gates have to agree on what a name is,
// and two regex literals in two files are exactly the drift both hooks' header comments say they
// exist to avoid.

/**
 * The characters an agent-definition basename may hold: an alphanumeric, then any of alphanumeric,
 * underscore, hyphen. That is an ALLOWLIST, not a `..` denylist, and the shape is deliberate —
 * every one of `.`, `/`, `\`, `:`, and whitespace is outside it, so a traversal, a rooted path, a
 * drive letter, and a trailing-space Windows name are all rejected by the same rule rather than by
 * five special cases that have to anticipate each other. Requiring the first character to be
 * alphanumeric is what excludes a leading `-` (which would read as a flag if a name ever reached a
 * command line) and a leading `.` (a dotfile, and the first half of `..`).
 *
 * Every agent definition shipped in this repository and in the account payload matches it:
 * lowercase words joined by hyphens.
 */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * True when `name` is safe to interpolate into `<dir>/<name>.md`. Takes `unknown` because both
 * callers get this value out of `JSON.parse` on hook stdin, where the field can be any JSON type;
 * a non-string is not a name.
 *
 * Callers must map false onto whatever they already do for a definition that is not there —
 * `null` in agent-write-scope, "requires isolation" in agent-worktree-gate — never onto a throw.
 * Both hooks hold a fail-open contract at the process level, and an invalid name is a fact about
 * the payload, not a hook error.
 */
export function isValidAgentName(name: unknown): name is string {
  return typeof name === "string" && AGENT_NAME_RE.test(name);
}
