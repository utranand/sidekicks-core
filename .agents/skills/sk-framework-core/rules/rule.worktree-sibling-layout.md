# rule.worktree-sibling-layout

Inspect with `sidekicks framework show rule.worktree-sibling-layout`; toggle with
`sidekicks framework disable rule.worktree-sibling-layout` or `sidekicks framework enable rule.worktree-sibling-layout`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

Layout: always a **sibling** of the
  repo (`../worktrees/<name>/`), never nested inside the repo root (nested copies crash indexers —
  that one the hook denies outright).

