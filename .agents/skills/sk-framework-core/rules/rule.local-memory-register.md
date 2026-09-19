# rule.local-memory-register

Inspect with `sidekicks framework show rule.local-memory-register`; toggle with
`sidekicks framework disable rule.local-memory-register` or `sidekicks framework enable rule.local-memory-register`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

### Local memory — register decisions that matter

Use `sidekicks memory` as the sole writer of the central, git-ignored store. Record choices,
non-obvious constraints and rejected alternatives a future agent would otherwise miss; avoid
secrets, transient status and facts already captured in code or Git.

