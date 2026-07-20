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
