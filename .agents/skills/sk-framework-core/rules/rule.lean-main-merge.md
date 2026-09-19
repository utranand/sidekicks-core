# rule.lean-main-merge

Inspect with `sidekicks framework show rule.lean-main-merge`; toggle with
`sidekicks framework disable rule.lean-main-merge` or `sidekicks framework enable rule.lean-main-merge`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

- **Landing already-tested work on `main` — leanest safe path (hard rule):** when the operator asks
  for an already-tested commit to be merged to remote `main`, that request is the approval the
  protected-branch rule requires, and it authorises the merge **and nothing else**. Treat the
  existing test results as accepted (`skip_tests=true`): **run no tests, builds, linters, audits or
  validation suites**, and re-verify nothing that was already green. **Create nothing** — no plan,
  no documentation, no subagent, no branch, no commit, no worktree; the commit to land already
  exists. **Include nothing else** — never modify unrelated working-tree changes and never let them
  ride along in the push. The only permitted work is three minimal read-only checks:
  1. the target commit is the intended one (`git log -1 <ref>`),
  2. the source branch is clean (`git status --porcelain` empty),
  3. `main` fast-forwards to it (`git merge-base --is-ancestor origin/main <target>`).

  Then push **without `--force`**, ever. Where repository policy forbids a direct push to `main` —
  the default assumption here, since a protected branch receives work only through an approved
  merge/PR — push the existing feature branch as-is and open the **smallest possible** PR into
  `main`, then merge that; no PR body beyond what the merge needs. Close by confirming remote
  `main` actually contains the target commit (`git ls-remote origin main`, or
  `git merge-base --is-ancestor <target> origin/main`) and **stop there**. Report only: target
  commit, push/merge result, remote `main` SHA, and any blocker — not a summary of the work itself,
  no follow-up, no scope beyond the merge. **Never overrun the task.**

