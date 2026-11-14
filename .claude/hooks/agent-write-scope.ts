// PreToolUse hook (matcher: Write|Edit|NotebookEdit) — the scratch-scope gate.
//
// A subagent that only needs somewhere to drop a report should not hold an
// unrestricted write. The obvious lever, dropping Write from its `tools:`
// grant, over-corrects: an agent with no write tool has no file to leave its
// findings in, so its whole report comes back as a message, into the
// dispatcher's context and the operator's view. That is the problem the
// scratch file existed to solve, reintroduced by the fix.
//
// So the grant stays and the PATH gets constrained. An agent definition
// declaring `writeScope: scratch` may write inside a scratch directory and
// nowhere else; every other file write it attempts is denied here, before the
// permission system is consulted.
//
// Why a hook rather than a permission rule: `Edit(path)` rules do exactly this
// job, but they live in settings.json and apply session-wide. There is no
// per-subagent permission block, so a rule tight enough for a research agent
// would also bind the main session. A PreToolUse hook is the only layer that
// sees `agent_type` on the call and can scope by it. (Note the umbrella
// oddity while you are here: a `Write(path)` permission rule is accepted and
// never matched — `Edit(path)` is what governs Write, Edit, and NotebookEdit
// alike. That trap is why this gate keys on the tool call instead.)
//
// Scope is DERIVED from `.claude/agents/<type>.md` frontmatter, not from a
// list kept in this file. A hand-maintained list drifts the first time
// someone adds an agent and forgets to update it, which is the failure class
// the gate exists to close. An agent with no `writeScope` declared gets no
// opinion from this hook at all, so adding it to a project changes nothing
// until a definition opts in.
//
// Coverage boundary, stated because it is easy to over-trust: this gate sees
// the Claude Code tool call. It does not see a shell redirect or a script that
// opens a file itself. An agent holding Bash can write wherever the OS lets
// it regardless of what this hook says. Pair `writeScope` with a tools grant
// that excludes Bash, or with OS-level sandbox filesystem rules, if the agent
// is untrusted rather than merely narrow.
//
// Scratch-named ancestors. SCRATCH_SEGMENTS matches a path segment, and a segment
// counts only when the directory it names does not contain the project root. Without
// that condition a project checked out under `/home/x/scratch/myrepo` put every file
// in scope, so decide() allowed every write by every agent and nothing logged it.
// Now:
//
//   - A scratch-named directory that contains the project root is not scratch.
//   - A project whose root sits inside a scratch directory therefore gets denies for
//     scoped writes outside a deeper scratch folder. That is the fail-closed
//     direction: the scoped agent can still write under `<project>/.claude/scratch`
//     and in any scratch folder that does not contain the project root.
//   - Inside the project root only `<project>/.claude/scratch` is scratch. A folder
//     named `scratch`, `scratchpad` or `.scratch` anywhere else in the project is
//     tracked content the main session can load (`.claude/skills/scratch/SKILL.md`,
//     `scratch/CLAUDE.md`), so a scoped agent is denied it.
//   - The target and the project root are resolved with realpathSync.native first (the
//     deepest existing ancestor, plus the tail that does not exist yet), and the
//     decision is made on the resolved paths. A path that cannot be resolved and a
//     dangling link are "not scratch". Inside the project, the spelling must also match
//     the project's own: a junction, symlink or 8.3 short name that reaches a project
//     file by another route is denied, since textual comparison alone let any such
//     spelling make a scratch ancestor count again. Outside the project the resolved
//     path decides, so a session scratchpad under a linked temp directory (macOS
//     /var versus /private/var) still counts.
//   - A long-path (backslash backslash question mark) or UNC (two leading separators)
//     file path is never scratch. Those spellings alias a project file under a form
//     that does not match the project's own segments, which would let a scratch
//     ancestor count again, so a scoped agent is denied them outright.
//   - Nothing at or under the account Claude folder (`os.homedir()` plus `.claude`, and
//     CLAUDE_CONFIG_DIR when set) is scratch, judged on the resolved paths and on the
//     paths as given. Every session loads rules, skills, agent definitions and hooks from
//     there, so a scratch-named folder in that tree (`~/.claude/skills/scratch/SKILL.md`)
//     is denied like any other file in it, including when `skills` is a link out of the
//     tree. A session scratchpad under the temp folder is unaffected. Residual: a write
//     that names a linked-out folder by its own target path (the dotfiles folder the
//     `skills` link points at) or reaches a file through a hard link never mentions the
//     account folder, so it is judged as an ordinary path outside the project.
//     When the home folder cannot be looked up, the account folder could be anywhere, so
//     no path is scratch and every write by a scoped agent is denied.
//
// The project root is CLAUDE_PROJECT_DIR when set and the session cwd otherwise. A
// relative filePath resolves against the session cwd, which arrives on stdin as
// `payload.cwd`. readSessionCwd() below type-checks that field but cannot narrow it
// further, since a cwd IS a directory path, so the project root and the base for
// relative paths are both payload- or environment-driven with no narrower shape.
//
// Fail-open contract, matching agent-worktree-gate.ts: malformed stdin,
// missing fields, an unreadable definition, or our own bugs all log to stderr
// and exit 0 with no stdout, which Claude Code reads as "no opinion" and the
// normal permission flow proceeds. Only a well-formed deny emits JSON. A
// broken gate must never brick writing.
//
// Decision logic is the exported decide(). It touches the filesystem only through the
// realpathSync and lstatSync calls in inScratch() and claudeConfigRoots(), which resolve paths
// that need not exist, so `bun test test/agent-write-scope.test.ts` exercises most of it with no
// spawn and no fixture.
// The cases about links, short names and dangling links build real temporary directories.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isValidAgentName } from "./agent-name";
import { parseWriteScope } from "./write-scope-parse";

/**
 * Marks the scratch-parent fix, the project-only drop box and the shared writeScope parser (2), and
 * the account Claude folder deny (3). Nothing reads it yet: a consumer that wants to rely on what
 * `writeScope: scratch` confines (the worktree gate, once #312 redesigns that trust) can compare an
 * installed copy against it. Bump it whenever a change to this gate alters what `writeScope: scratch`
 * confines.
 */
export const WRITE_SCOPE_GATE_VERSION = 3;

/**
 * Directory names that count as scratch OUTSIDE the project root: a path is in scope if a segment
 * matches and that directory does not contain the project root (see the header). Inside the
 * project root these names mean nothing. There the only scratch folder is `<project>/.claude/scratch`,
 * the drop box `install/Install-Harness.ps1` creates, matched by its exact location rather than by
 * name, because a scratch-named folder elsewhere in the project is tracked content the main session
 * can load.
 */
const SCRATCH_SEGMENTS = new Set(["scratchpad", ".scratch", "scratch"]);

/** Two leading separators of either kind: a long-path prefix, a device path, or a UNC share. */
const ALIASED_PREFIX = /^[\\/]{2}/;

export type Decision = { action: "allow" } | { action: "deny"; reason: string };

/**
 * The real location of `p`: `realpathSync.native` of its deepest existing ancestor, with the
 * not-yet-existing tail appended. A write target usually does not exist yet, so the file itself
 * cannot be resolved. Throws on anything but plain absence, and also on a dangling link, because a
 * write through one lands somewhere this cannot know.
 */
function canonicalize(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      let linkExists = true;
      try {
        lstatSync(head);
      } catch {
        linkExists = false;
      }
      if (linkExists) throw err; // present but unresolvable: a dangling link
      const parent = dirname(head);
      if (parent === head) throw err;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Segment separators on this host. A backslash separates segments only on Windows. On POSIX it is
 * an ordinary file-name character, so splitting on it there would read the single file name
 * `scratch\..\x.md` as a scratch directory followed by a traversal, and call a file that lands in
 * `.claude` scratch. Matching what the filesystem will do is the whole point of comparing segments.
 */
const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;

/**
 * Lowercased segments of a resolved path, without a trailing empty one. A filesystem root splits as
 * `["", ""]` for `/` and `["c:", ""]` for `C:\`, and with that last empty segment kept, no file
 * path starts with the project's segments, so every target would read as outside a project at a
 * root. A resolved file path never ends in a separator, so only a root is affected.
 */
function segmentsOf(p: string): string[] {
  const parts = p.split(SEPARATORS).map((s) => s.toLowerCase());
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
const startsWith = (a: string[], b: string[]): boolean => a.length >= b.length && b.every((s, i) => a[i] === s);

/**
 * This host's home folder, or null when it cannot be known. `os.homedir()` throws when the lookup
 * fails (HOME unset and no password entry on POSIX, a failed profile lookup on Windows), and an
 * uncaught throw here would reach the hook's outer handler, which exits with no opinion and so
 * allows every write the gate would have denied. An empty or relative answer is unknown too, since
 * resolving it would make the session cwd the home folder. `lookup` is injectable for tests.
 */
export function accountHome(lookup: () => string = homedir): string | null {
  try {
    const home = lookup();
    return typeof home === "string" && home !== "" && isAbsolute(home) ? home : null;
  } catch {
    return null;
  }
}

/**
 * The account Claude folders, `<home>/.claude` and CLAUDE_CONFIG_DIR when set, each under the
 * spelling it was given and under its canonical one. Every session loads rules, skills, agent
 * definitions and hooks from there, so no path at or under one is scratch, whatever its segments
 * are named. Both spellings are kept because a linked folder (`.claude` itself, or `skills` inside
 * it, kept in a dotfiles repo) puts the given and the resolved path in different trees, and either
 * one starting inside a root is enough to deny. Home comes from `os.homedir()`, not `$HOME`, which
 * Git Bash on Windows can point at another folder. A relative CLAUDE_CONFIG_DIR resolves against
 * this process's cwd. A folder that cannot be canonicalised keeps only its given spelling.
 *
 * Null means the account folder is unknown: the home lookup failed or gave an empty or relative
 * answer (see accountHome). It is never an empty list, because an empty list means "no account
 * folder exists" and would let a scratch-named folder inside the real one count as scratch.
 * inScratch() reads null as "no path is scratch". `env` and `home` are injectable for tests.
 */
export function claudeConfigRoots(
  env: Record<string, string | undefined> = process.env,
  home: string | null = accountHome(),
): string[] | null {
  if (typeof home !== "string" || home === "" || !isAbsolute(home)) return null;
  const given: string[] = [join(home, ".claude")];
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (typeof configDir === "string" && configDir !== "") given.push(resolve(configDir));
  const roots: string[] = [...given];
  for (const dir of given) {
    try {
      roots.push(canonicalize(dir));
    } catch {
      // Given spelling only, see above.
    }
  }
  return roots;
}

/**
 * Is `filePath` a place a scratch-scoped agent may write? Resolved against `cwd` when relative, so
 * a bare `../../etc/hosts` cannot slip through as "not absolute".
 *
 * Both the target and the project root are canonicalised first (see canonicalize), and failing to
 * canonicalise is "not scratch". The decision is then made on the canonical paths:
 *   - Inside the project root, only `<project>/.claude/scratch` is scratch. Any other scratch-named
 *     folder there is tracked content the main session can load (`.claude/skills/scratch/SKILL.md`,
 *     `scratch/CLAUDE.md`), so a write to it is refused. The spelling used must also lead to that
 *     folder through the project's own path, resolved or as given. A junction, symlink or 8.3 short
 *     name that reaches it by another route is a deny, not an unrelated folder.
 *   - Outside the project root, a scratch-named segment of the canonical path counts only when that
 *     directory does not contain the project root. The spelling does not matter here, so a
 *     scratchpad under a linked temp directory (macOS `/var` to `/private/var`) is still scratch,
 *     and a scratch-named link to a folder that is not scratch is not.
 *   - Before either rule, nothing at or under an account Claude folder (claudeConfigRoots) is
 *     scratch, judged on the canonical path and on the path as given, so a subfolder linked out
 *     of that tree is still denied when written through it. That holds inside the project too, so
 *     a project rooted at the home folder has no drop box, since its `.claude` is the account one.
 * Compared lowercased on every platform: case-insensitive containment can only add denies.
 * `configRoots` is injectable for tests and defaults to this host's account folders. When those are
 * unknown (null), no path is scratch, since any path could sit inside the account folder.
 */
export function inScratch(
  filePath: string,
  cwd: string,
  projectDir: string,
  configRoots: string[] | null = claudeConfigRoots(),
): boolean {
  if (configRoots === null) return false;
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
  // Long-path and UNC spellings alias a path the segment comparison below cannot match. Checked on
  // the raw input and on the resolved form, since a relative path can inherit a UNC cwd.
  if (ALIASED_PREFIX.test(filePath) || ALIASED_PREFIX.test(abs)) return false;
  let canonicalAbs: string;
  let canonicalProject: string;
  try {
    canonicalAbs = canonicalize(abs);
    canonicalProject = canonicalize(resolve(projectDir));
  } catch {
    return false;
  }
  const raw = segmentsOf(abs);
  const real = segmentsOf(canonicalAbs);
  const project = segmentsOf(canonicalProject);
  if (configRoots.some((root) => startsWith(real, segmentsOf(root)) || startsWith(raw, segmentsOf(root)))) {
    return false;
  }
  if (startsWith(real, project)) {
    // Inside the project the route taken must be the project's own, either resolved or as the
    // project was given. A link standing in for an ancestor of the project matches neither.
    const dropBox = [...project, ".claude", "scratch"];
    const givenDropBox = [...segmentsOf(resolve(projectDir)), ".claude", "scratch"];
    return (
      real.length > dropBox.length &&
      startsWith(real, dropBox) &&
      (startsWith(raw, dropBox) || startsWith(raw, givenDropBox))
    );
  }
  return real.some((segment, i) => SCRATCH_SEGMENTS.has(segment) && !startsWith(project, real.slice(0, i + 1)));
}

/** A writeScope line anywhere in a file, key case-insensitive. Only the fallback in readWriteScope uses it. */
const LOOSE_WRITE_SCOPE = /^[ \t]*writeScope[ \t]*:[ \t]*(\S+)[ \t]*\r?$/im;

/**
 * The `writeScope` value declared in an agent definition's frontmatter, or null
 * when the file is absent, unreadable, or declares nothing. When the frontmatter cannot be read
 * with confidence, a loose scan of the whole file stands in (see the body). Null means this
 * hook has no opinion — absence of a declaration is not a reason to block.
 *
 * `agentType` is payload text and becomes a path one line down, so it is checked against the
 * agent-name allowlist first (backlog item 38). A name that fails is treated as a name with no
 * definition — the same null this returns for an absent file — because that is already the
 * outcome for every unrecognized type, and because a throw here would break the hook's fail-open
 * contract. The check subsumes the empty-string guard that used to sit on this line: "" has no
 * first character, so the allowlist rejects it, and it must be rejected — `${""}.md` names the
 * readable file `.md`.
 */
export function readWriteScope(agentType: string, projectDir: string): string | null {
  if (!isValidAgentName(agentType)) return null;
  const defPath = join(projectDir, ".claude", "agents", `${agentType}.md`);
  if (!existsSync(defPath)) return null;
  try {
    const text = readFileSync(defPath, "utf8");
    // The strict frontmatter reading is the first choice. It returns null both for "no declaration"
    // and for a block it cannot read with confidence (a fence followed by a no-break space, no
    // closing fence), and the second must not lift the confinement the definition asked for. This
    // gate decides what to confine, so it over-detects: when the strict reading finds nothing, a
    // loose scan of the whole file for a writeScope line decides. The key is matched without regard
    // to case, any position counts, and the value is lowercased so decide()'s exact comparison holds.
    return parseWriteScope(text) ?? text.match(LOOSE_WRITE_SCOPE)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * The session working directory from the hook payload, or this process's own when the payload
 * does not carry a usable one.
 *
 * Why this is a TYPE check and not the charset check `agent_type` gets. Both fields arrive on the
 * same stdin, and the difference is what they are, not where they come from. `agent_type` names a
 * definition file, so a filename-safe segment is the whole of what it may be, and anything else is
 * malformed. `cwd` IS a directory path — it is the base `inScratch()` resolves a relative write
 * against, and it stands in for projectDir when CLAUDE_PROJECT_DIR is unset — so there is no
 * narrower shape to demand. Treating it as untrusted text would mean rejecting the legitimate
 * value.
 *
 * What it does need is to be a string. `join(42, …)` and `resolve({}, …)` throw, the throw is
 * caught by the outermost handler below, and the hook then exits 0 with no stdout — so a
 * malformed cwd used to convert a deny this gate would have made into silence. Falling back keeps
 * the gate deciding. */
export function readSessionCwd(payload: unknown): string {
  const value = (payload as Record<string, unknown> | null | undefined)?.cwd;
  return typeof value === "string" && value !== "" ? value : process.cwd();
}

/**
 * Deny a write that a scratch-scoped agent aims outside its scratch directory.
 * Every other combination allows: unscoped agents, the main session (no
 * agent_type), and in-scope writes. `configRoots` is passed to inScratch() and left undefined
 * outside tests, so the account folders are looked up only for a scoped write.
 */
export function decide(
  scope: string | null,
  filePath: string | undefined,
  cwd: string,
  projectDir: string,
  configRoots?: string[] | null,
): Decision {
  if (scope !== "scratch") return { action: "allow" };
  if (!filePath) return { action: "allow" };
  if (inScratch(filePath, cwd, projectDir, configRoots)) return { action: "allow" };
  return {
    action: "deny",
    reason:
      `This agent declares writeScope: scratch, so it may only write inside a ` +
      `scratch directory. ${filePath} is outside one. Write your report to the ` +
      `session scratchpad and send the path, or report your findings in a message ` +
      `if they are short enough to fit in one.`,
  };
}

if (import.meta.main) {
  try {
    const raw = await Bun.stdin.text();
    // Copilot CLI also runs .claude/settings.json hooks and fails closed on them (#227). Stand
    // down there, but never while CLAUDECODE is set, so a Claude Code session always runs the rest.
    if (process.env.COPILOT_CLI && !process.env.CLAUDECODE) process.exit(0);
    const payload = JSON.parse(raw);
    const cwd = readSessionCwd(payload);
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? cwd;
    const scope = readWriteScope(payload.agent_type ?? "", projectDir);
    const verdict = decide(
      scope,
      payload.tool_input?.file_path ?? payload.tool_input?.notebook_path,
      cwd,
      projectDir,
    );
    if (verdict.action === "deny") {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: verdict.reason,
          },
        }),
      );
    }
  } catch (err) {
    console.error(`agent-write-scope: ${err}`);
  }
  process.exit(0);
}
