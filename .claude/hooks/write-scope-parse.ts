// The one parser for the `writeScope` key in an agent definition's frontmatter. The scratch-scope
// gate (agent-write-scope.ts) reads it. It lives in its own file so a second consumer, such as the
// worktree gate once #312 settles how it may rely on `writeScope`, shares this answer instead of
// adding a parser that disagrees on a duplicate key or CRLF line endings. This file sits flat beside the hooks, like
// agent-name.ts, because the installer copies that directory file by file and not recursively.

export type WriteScopeParser = (text: string) => string | null;

/**
 * The value of the first `writeScope:` key in the frontmatter, or null.
 *
 * Frontmatter is the text between a leading `---` line and the next `---` line, and nothing else
 * counts. A fence is three dashes and optional trailing ASCII spaces or tabs, not Unicode whitespace,
 * so a no-break space or U+FEFF after the dashes is not a fence: a `writeScope:` line in the body is prose, not a declaration. Lines split on a CRLF-
 * agnostic pattern, since a Windows checkout without a `.gitattributes` rule leaves a `\r` on every
 * line and a `$` anchor sits behind it. There is no length cap on the frontmatter. The first key
 * wins, so a definition that repeats the key reads the same everywhere this parser is used.
 */
export function parseWriteScope(text: string): string | null {
  // One leading byte order mark is dropped first. An editor that saves a definition with a BOM
  // would otherwise fail the opening-fence match and read as undeclared, which silently lifts the
  // confinement the definition asked for.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (!/^---[ \t]*\r?$/.test(lines[0] ?? "")) return null;
  let value: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*\r?$/.test(lines[i])) return value;
    value ??= lines[i].match(/^writeScope:\s*(\S+)\s*$/)?.[1] ?? null;
  }
  // No closing delimiter: not frontmatter, so no declaration.
  return null;
}
