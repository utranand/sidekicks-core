# Command-sequences follow the requested operation

> Framework criterion `criterion.command-sequences`, owned by `sk-commander`.
> Inspect with `sidekicks framework show criterion.command-sequences`.

A top-level `steps:` key or RUN banner identifies a sequence and its owning runner.
When the user asks to run or resume it, invoke `sk-commander`; never run its steps by hand.
Review, explain, edit, validate and lint requests do not authorize execution. A bare path or pasted
artifact alone is inspected and summarized; use the conversation to resolve intent.
Authoring and validation belong to `sk-sequence-planner`.
Execution retains every action-specific database, production, destructive and outward gate.
