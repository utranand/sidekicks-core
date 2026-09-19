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
  `implementation-workflow-preference` memory for this scope. Accepted choices are `bmad` and
  `inline`; record an explicit durable preference with `sidekicks memory add`.
  With no preference, use BMAD for service implementation when `rule.bmad-first` is enabled;
  otherwise plan inline. Framework work without service stories uses `sk-framework-dev`.
  State the selection and proceed; ask only for a material design fork, not to choose equivalent
  planning mechanisms. A workflow preference never supplies approval for a gated action.

