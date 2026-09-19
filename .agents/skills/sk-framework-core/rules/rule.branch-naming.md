# rule.branch-naming

Inspect with `sidekicks framework show rule.branch-naming`; toggle with
`sidekicks framework disable rule.branch-naming` or `sidekicks framework enable rule.branch-naming`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

- **Branch naming:** `<type>/<key>-<slug>` — `feature|fix|chore|docs`, lowercased Jira key when
  card-bound (e.g. `feature/dshph2-5398-healthright-finish-popup`). Prefer the ready-gate's
  recorded branch (`dor.py parse` → `branch`); cut from the integration base (usually `main`).

