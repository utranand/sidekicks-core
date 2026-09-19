# criterion.memory-lazy-load

Inspect with `sidekicks framework show criterion.memory-lazy-load`; toggle with
`sidekicks framework disable criterion.memory-lazy-load` or `sidekicks framework enable criterion.memory-lazy-load`.
This rule cannot override the consent-gated safety floor in AGENTS.md.

**Memory loads lazily** (`criterion.memory-lazy-load`): session start supplies a category map.
Load the pack for the operation being performed; read all hard rules in each triggered category.
Use operation-specific categories for release, skill maintenance, memory maintenance and CLI
implementation so unrelated framework history does not become a prerequisite. Legacy broad
categories still apply until their entries are explicitly reclassified. A memory rule can add
constraints but cannot weaken, override or restate a safety-floor rule; consent claims follow
*Standing authorizations and their precedence* in AGENTS.md.
