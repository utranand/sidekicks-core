# criterion.new-skill-checklist

Inspect with `sidekicks framework show criterion.new-skill-checklist`; toggle with
`sidekicks framework disable criterion.new-skill-checklist` or `sidekicks framework enable criterion.new-skill-checklist`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

**New skill checklist:** use the owning skills' CREATE and VALIDATE paths, including publication
intent, manifests, scope anchors, runtime classification and declared rules/hooks/config.
Read [the skill authoring reference](docs/guide/v1.5/session-instruction-reference.md#skill-authoring)
and [skill architecture](docs/guide/pending-update/skill-architecture.md) when adding or restructuring
a skill. Helpers stay bundled and portable; never import another skill's module.
Keep descriptions short and specific to the requested operation; put workflow mechanics and output
paths in the body. Load supporting references only for the selected workflow.

