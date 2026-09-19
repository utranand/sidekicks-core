# rule.cross-platform

Inspect with `sidekicks framework show rule.cross-platform`; toggle with
`sidekicks framework disable rule.cross-platform` or `sidekicks framework enable rule.cross-platform`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

- **Cross-platform:** primary dev machine is macOS but everything MUST also run on Windows — one
  unified implementation, never an OS fork. Watch paths (`path.join`, repo root via
  `git rev-parse --show-toplevel`), line endings (tolerate `\r\n`), Git-Bash shell, executable
  suffixes (`.venv/bin` vs `.venv/Scripts`). Fix the canonical script in `lib/` or the skill's
  `scripts/`, add a test if the bug was silent.

