# Change Management: Code Projects

The code-repo half of `change-management.md`. The confirmation list, backups, commit identity, decision notes, invariant promotion and script hygiene stay in the kernel file of that name.

## Decision Documentation

**In commit messages:**
- Why this change was needed (not just what changed)
- What was considered and rejected
- Any trade-offs made

**In code comments:**
- Why non-obvious configuration exists
- Warnings about things that look wrong but are intentional
- References to relevant docs or issues

## Session Close Protocol

Before ending any session with code or config changes:
1. **Commit last known good state** — all working changes must be in a commit before the session closes. Never leave uncommitted working changes.
2. **Push to remote** — ensure the commit is on GitHub, not just local.
3. **Sync production** — pull on the production host if production was the work target.
