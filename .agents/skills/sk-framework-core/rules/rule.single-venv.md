# rule.single-venv

Inspect with `sidekicks framework show rule.single-venv`; toggle with
`sidekicks framework disable rule.single-venv` or `sidekicks framework enable rule.single-venv`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

- **Python:** the single repo-root `.venv` only — never per-skill venvs or system Python; all
  pip installs go there.

