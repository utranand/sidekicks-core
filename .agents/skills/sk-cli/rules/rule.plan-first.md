# rule.plan-first

Inspect with `sidekicks framework show rule.plan-first`; toggle with
`sidekicks framework disable rule.plan-first` or `sidekicks framework enable rule.plan-first`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

- **Plan-first — enter plan mode before implementation (hard rule, `rule.plan-first`):**
  before a non-trivial implementation, present a concise plan with the outcome, affected surfaces
  and verification. Execute it immediately when the assignment settles the deliverable and no
  consent gate or material design fork remains. Use blocking plan mode only for such a gate/fork,
  or when the user requested plan review. No separate plan file is required. Trivial edits,
  an explicit instruction to skip planning, and execution of an already-approved sequence are exempt.
  Resolve `rule.plan-first` and `rule.bmad-first` once per work item with `sidekicks framework check`.
  For workflow selection, reuse the user's choice for this task, then a recorded
  `implementation-workflow-preference` memory for this scope. Accepted choices are **`native`,
  `bmad` and `inline`**; record an explicit durable preference with `sidekicks memory add`.
  With no preference: **`native`** for service implementation where the native delivery skills are
  installed; `bmad` where `rule.bmad-first` is enabled and the BMAD skills are present; `inline`
  otherwise. Framework work without service stories uses `sk-framework-dev`.
  **A recorded preference is honoured as recorded, never reinterpreted.** A scope that recorded
  `bmad` keeps selecting BMAD after the native cutover — that is what keeps a pinned legacy run
  finishable. If the skills for the selected workflow are absent, report the capability gap; a
  missing skill is never permission to switch route. A value outside the three above is **rejected
  with a diagnostic naming the accepted set** — never silently read as the nearest match.
  State the selection and proceed; ask only for a material design fork, not to choose equivalent
  planning mechanisms. A workflow preference never supplies approval for a gated action.

