---
name: prose-lint
description: Run the deterministic Vale prose linter (ai-tells + Cringely styles) against a markdown or text file and report AI-tell findings. Use when the user invokes /prose-lint, asks to "lint this doc for AI tells", or wants a mechanical style check on written prose before delivery.
---

# Prose Lint

Run Vale with the personal lint kit against the file the user names.

## Steps

1. Resolve the target file path from the user's request. If no file is given, ask for one.
2. Run:
   `vale --config "C:\Users\jcgam\.claude\tools\prose-lint\.vale.ini" --output=line "<target-file>"`
3. Report findings grouped by rule, with line numbers, ordered by count. Zero findings: say the file passes and stop.
4. Offer exactly one follow-up: rewrite the flagged passages using the beautiful_prose skill's Edit mode. Only proceed if the user accepts.

## Notes

- The linter is advisory, not a gate. Quoted text, code identifiers, and API names legitimately trigger false positives; call those out instead of "fixing" them.
- If a rule fires repeatedly on legitimate prose, suggest disabling it in `.vale.ini` (never delete from the package), and name the rule.
- If `vale` is missing, tell the user to re-run Task 1 of the prose-system plan; do not install anything without asking.
