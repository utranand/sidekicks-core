# scripts/legacy/ — parked, unclaimed repo-root scripts

Everything in this folder is a repo-root script that **no skill and no framework hook owns**. It is
kept for reference, not wired into anything, and not part of any skill's declared closure.

## Why they are parked here rather than in `scripts/`

`scripts/` travels by ownership. When `sk-inherit` forges a standalone runtime or a mountable
framework core, `resolveScriptOwnership()` copies a top-level `scripts/` entry only when something
present claims it:

- a `CORE_HOOKS` entry with `owners: []` (the framework floor), or
- a `CORE_HOOKS` entry whose owners intersect the shipped skill set, or
- a shipped skill's `skill.manifest.yaml` → `requires.framework_files[].path` /
  `requires.framework_hooks[].script`.

An unclaimed file never travels, so leaving it at the top level only made `scripts/` look like a
payload it was not. Publishing v1.1.0 of the framework core shipped 17 such files into consumer
workspaces — 7 of them hooks that stayed wired and enabled with no owning skill (see
`projects/global/services/sidekicks-framework/artifacts/runs/incident-reports/framework-core-scripts-payload-20260813/incident-report.md`).
This folder makes the unclaimed set visible instead of implicit.

`scripts/legacy/` has no entry in `SCRIPT_SUBDIR_OWNERS` and is not in `SCRIPT_SUBDIR_FLOOR`, so it
never travels into a forged runtime.

## Contents

| Script | What it is | Canonical copy elsewhere |
|---|---|---|
| `office-viz-demo-loop.mjs` | Live demo loop for the Agent Office viz — spawns 3 temporary demo agents, drives their status for a minute, cleans up | none |
| `office-viz-demo-subagents.mjs` | Creates deterministic synthetic subagent run artifacts for Agent Office demos | yes — `.agents/skills/sk-office-viz/scripts/office-viz-demo-subagents.mjs`, which is the copy `sk-office-viz` bundles, documents and travels with. The file here was a byte-identical duplicate |
| `webmcp-demo.mjs` | Verified runnable WebMCP + Puppeteer example backing `docs/research/webmcp.md` | none |

## Reviving one

Do not run a parked script from here as if it were wired — nothing gates it. To put one back into
service:

1. `git mv scripts/legacy/<file> scripts/<file>`
2. Give it an owner, or it will be parked again by the next forge:
   - a skill helper the skill spawns → add it to that skill's `skill.manifest.yaml` under
     `requires.framework_files`, most easily with `sidekicks skill manifest <skill> --apply`; or
   - a hook → add a `CORE_HOOKS` entry in `lib/framework-settings/core-registry.mjs`, wire it in
     **all four** per-CLI configs (`.claude/settings.json`, `.codex/config.toml`,
     `.agent/settings.json`) in the same change (Rule 6), have it import
     `scripts/lib/hook-gate.mjs` so it can be gated off, then run `sidekicks framework sync`.
3. Verify with `sidekicks framework doctor` and `sidekicks skill doctor`.

Better still, ask whether the script belongs inside its skill's own folder
(`.agents/skills/<name>/scripts/`) instead. A skill-folder script travels with the skill through
both channels — `inherit` and `skill export`/`import` — and needs no ownership declaration. Only
scripts that must import repo `lib/`, are shared by several owners, or run when no skill is invoked
(hooks) genuinely belong at the repo root.

## Do not move a claimed script in here

The ownership gate treats a `scripts/` subdirectory as a single unit, so a claimed script parked
here would silently stop travelling and its skill would ship broken. Check first:

```sh
git grep -n "path: scripts/\|script: scripts/" -- .agents/skills/*/skill.manifest.yaml
grep -n "script: 'scripts/" lib/framework-settings/core-registry.mjs
```
