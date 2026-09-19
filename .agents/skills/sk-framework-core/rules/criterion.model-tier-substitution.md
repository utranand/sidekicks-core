# criterion.model-tier-substitution

Inspect with `sidekicks framework show criterion.model-tier-substitution`; toggle with
`sidekicks framework disable criterion.model-tier-substitution` or `sidekicks framework enable criterion.model-tier-substitution`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

### Subagent model selection — by tier, never exact ID

Shared workflows persist a tier, never a provider model name. The executor registry maps that tier
for each CLI. If the current host has no exact mapping, routing tries another eligible executor; if
none maps it, fail closed and ask for configuration or an explicit agent-level override.

| Tier | Use for | Claude | Antigravity | Codex/OpenAI |
|---|---|---|---|---|
| **Top** | fable-fleet judgment seats | highest available tier | highest available tier | highest available tier |
| **High** | planning, architecture, validation, hard review | high tier | high tier | high tier |
| **Mid** | general dev, drafting, most subagents | mid tier | mid tier | mid tier |
| **Low** | mechanical/bulk fan-out | low tier | low tier | low tier |

**No tier substitution:** `top`, `high`, `mid`, and `low` are distinct contracts. Never silently
replace one with a different tier; update the selected executor's registry mapping or choose another
eligible executor instead.

**Where the mapping lives, and how to keep it current:** each executor's tier→model id map is
`executors.<name>.models` in the scope-resolved `cli-executors.json`, written only by
`sidekicks cli-executor register <name> --model-<tier> <id>`. `sidekicks cli-executor models`
reconciles those selections against each CLI's discovered catalog — per-tier
valid/stale/unverified/unmapped, plus the catalog models no tier claims — and exits 2 on drift; run
it with `--refresh` when a vendor ships a new model. It never remaps a tier itself: a catalog row
carries no tier hint, so the promotion is the operator's call.

