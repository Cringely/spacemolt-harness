// Durable scheduler (#114): decode a body passed as a SINGLE base64 argv token.
//
// Why argv-base64 and not STDIN/heredoc: a spawned job runs headless under a
// CLOSED allowedTools list. Claude Code's headless permission layer splits a
// Bash command on NEWLINES (and shell operators) and matches each fragment
// against the allowlist independently — so a heredoc body, or a `printf ... |`
// pipe, produces fragments that match no rule and the whole `claude -p` run is
// denied (there is no bypass flag in spawn.ts buildArgv). A single-line
// `--body-b64 <token>` is one fragment that matches `Bash(bun scripts/...ts *)`.
//
// Why base64 and not backslash-escaping: finding/report bodies carry quotes,
// `$`, and backticks; base64 is quoting-robust, escaping is fragile.
//
// Size: one argv string is bounded by Linux MAX_ARG_STRLEN (128KB). Callers cap
// the DECODED bytes well under that (a 64KB body → ~87KB base64; a 90KB report →
// ~120KB base64) so the token always fits.
//
// A body can also arrive as a FILE the job wrote with the Write tool into BODY_DIR
// and named with a `--body-file <path>` flag (readBodyFile below). That is the
// form the work orders teach: the job never computes base64 in a shell, so no
// `printf '<untrusted text>' | base64` command, no `Bash(printf *)` grant, and
// the command carries only a path. The base64 token stays accepted.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The one directory a job may write, relative to its checkout. The scheduler
 * pre-creates it (spawn.ts runJob), jobs.ts grants `Edit(./.job-body/**)` on it
 * and nothing else, and readBodyFile reads from nowhere else. Those three must
 * name the same directory, hence one constant.
 */
export const BODY_DIR = ".job-body";

export class BodyArgError extends Error {}

// Standard base64 alphabet, `=` padding only at the end, whole-string. A token
// that fails this could still be leniently decoded by Buffer, so validate FIRST
// — the caller (a spawned agent) is untrusted input.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode a base64 argv token to a utf8 string, rejecting malformed input and a
 * decoded body over `maxBytes` with BodyArgError (the CLIs map this to exit 2).
 */
export function decodeBodyArg(b64: string, maxBytes: number): string {
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new BodyArgError("body is not valid base64 (single-line standard base64 expected)");
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new BodyArgError(`decoded body exceeds ${maxBytes} bytes`);
  }
  return bytes.toString("utf8");
}

function strictlyInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Read a body from a file the job wrote, confined to `<cwd>/BODY_DIR`. The path
 * is untrusted: it is resolved against cwd, then realpath'd, and the REAL path
 * must sit strictly inside the REAL body directory, which must itself sit inside
 * the real cwd. That rejects `..` traversal, an absolute path elsewhere, a
 * sibling directory sharing the body dir's name prefix, a file in cwd but
 * outside BODY_DIR (a job can write nowhere else, but a script that reads
 * anywhere in cwd would let it name a source file as its "body"), and a symlink
 * (or Windows junction) that points out, including BODY_DIR itself. The target
 * must be a regular file within `maxBytes`, checked before it is read. Throws
 * BodyArgError (the CLIs map it to exit 2).
 */
export function readBodyFile(path: string, maxBytes: number, cwd: string = process.cwd()): string {
  if (path === "" || path.includes("\0")) throw new BodyArgError("body file path is empty or malformed");
  const outside = () => new BodyArgError(`body file is outside the job body directory (${BODY_DIR}/): ${path}`);
  const bodyDir = resolve(cwd, BODY_DIR);
  let realCwd: string;
  let realDir: string;
  try {
    realCwd = realpathSync(cwd);
    realDir = realpathSync(bodyDir);
  } catch {
    throw new BodyArgError(`job body directory is not readable: ${BODY_DIR}/`);
  }
  if (!strictlyInside(realCwd, realDir)) throw new BodyArgError(`job body directory leaves the checkout: ${BODY_DIR}/`);
  // Lexical check first, so an outside path answers "outside" whether or not it
  // exists (no existence oracle for host files), then the realpath check for
  // links that lead out.
  // (An absolute path may spell the dir through a link, so inside-either is
  // enough here; the realpath check below is the authoritative one.)
  const target = resolve(cwd, path);
  if (!strictlyInside(bodyDir, target) && !strictlyInside(realDir, target)) throw outside();
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new BodyArgError(`body file not found: ${path}`);
  }
  if (!strictlyInside(realDir, real)) throw outside();
  // Open ONCE and judge the file through that descriptor, never by path again: a
  // stat-by-path then read-by-path lets the file be swapped between the two
  // (CodeQL js/file-system-race). O_NOFOLLOW refuses a final component swapped
  // for a link after the realpath above (ELOOP), and O_NONBLOCK keeps a FIFO from
  // hanging the open so the regular-file check below can reject it. Both are
  // undefined on Windows, where node exposes neither. A swapped ANCESTOR
  // directory stays unguarded, which needs a link the job's Edit grant cannot
  // create.
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw outside();
    throw new BodyArgError(`body file not found or unreadable: ${path}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new BodyArgError(`body file is not a regular file: ${path}`);
    if (st.size > maxBytes) throw new BodyArgError(`body file exceeds ${maxBytes} bytes`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The body from whichever of the two sources the caller passed: a base64 argv
 * token or a file path. Exactly one, never both (one silently winning would
 * hide a mistake) and never neither.
 */
export function resolveBody(
  src: { b64?: string | undefined; file?: string | undefined },
  maxBytes: number,
  cwd: string = process.cwd(),
): string {
  if (src.b64 !== undefined && src.file !== undefined) {
    throw new BodyArgError("give the body as a base64 token or as a file path, not both");
  }
  if (src.b64 !== undefined) return decodeBodyArg(src.b64, maxBytes);
  if (src.file !== undefined) return readBodyFile(src.file, maxBytes, cwd);
  throw new BodyArgError("no body given: pass a file path or a base64 token");
}
