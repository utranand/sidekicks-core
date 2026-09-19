---
name: sk-publish-core
description: Forge, verify and publish a self-hosting lean Sidekicks core with complete operating surfaces.
user-invocable: true
sidekicks:
  runtime-class: framework
  logical-id: skill:sk-publish-core
  provides:
    - framework-core-publishing
---

# Publish the lean framework core

## Operating contract

The callable engine is in `lib/core-forge/{forge,release,gates}.mjs`; thin adapters in
`lib/core-lifecycle/` expose the commands below. A standalone core carries this engine and
can forge its successor. A consumer mounting `.sidekicks-core/` cannot forge from its link farm.

The dynamic framework preset contains exactly eight skills: the required six
(`sk-cli`, `sk-commander`, `sk-config-doctor`, `sk-hello`, `sk-scope-switch`,
`sk-skill-manager`) plus `sk-framework-core` and `sk-publish-core`.
All safe root scripts, canonical agents, generated host-agent ports, host wiring,
framework example configurations and agent packs travel. Hook activation still requires its
owner; executable BMAD commands require their capability. Only skills and rendered instructions
are deliberately lean. Secrets, projects, memory, state and source-only artifacts do not travel.

## Commands

Run from the standalone source checkout. Inspect `sidekicks core plan --json` first;
its deterministic `root_structure` inventory explains every inclusion and exclusion.

```sh
sidekicks core plan --json
sidekicks core forge --target <directory> --name sidekicks-core --version X.Y.Z
sidekicks core drift --target <directory> --json
sidekicks core verify --target <directory>
sidekicks core publish --target <directory> --dry-run
sidekicks core publish --target <directory>
sidekicks core release --target <directory> --yes
sidekicks core verify-remote --target <directory>
```

`forge` builds a candidate; `--force` explicitly rebuilds an existing target.
`plan` and `drift` are read-only. `publish` derives a version from real changes,
forges, verifies, records the release and commits/tags **locally**.
`release` is the separately authorized outward action: push the tag first, then branches,
then prove the served artifact. `verify-remote` fetches the tag and checks its files against
the sealed root-structure manifest. A local release is never reported as published.

The source repository's `package.json` version is **not** the core version. It versions the
Sidekicks CLI, not the mounted framework product. Core semver derives from the recorded core
release and actual surface changes; `--version` selects an explicit valid core version.
Never stamp the source package version into a core or reset published version history.

## Configuration and flags

Read `sidekicks config get framework_core --json`; never hand-edit configuration values.
Precedence: explicit flags, root-scoped `framework_core`, bundled defaults.
Defaults are target `projects/global/services/sidekicks-core/src`, runtime name
`sidekicks-core`, remote `https://github.com/utranand/sidekicks-core.git`,
preset `framework`, pack skills `none`. Packs travel without installing optional skills.
An explicit `--target` derives identity from the service path; use `--name` to override
deliberately. An existing marker with another identity is refused.

Common controls: `--target`, `--name`, `--preset`, `--remote`, `--json`,
`--dry-run`, `--no-commit`. Dry-run performs no publication or candidate writes.
`--allow-protected` represents already-obtained, named direct-write authorization;
it is never consent by itself. Use work branches by default. Test/mount/upgrade waivers
must be disclosed; self-host verification has no public skip flag.

## Eight release gates

1. **Verify**: source-to-candidate structure, skill projection, rule bodies, wiring and safety floor.
2. **Doctor**: the candidate's own configuration doctor.
3. **Test**: the candidate's own test launcher; zero discovered tests is a failure.
4. **Drift**: one-way projection is current, with no unresolved conflict.
5. **Mount**: install into a clean consumer and run its full checks, core doctor and package dry-run.
6. **Upgrade**: update from the last verified served release; explicitly skipped on a first release.
7. **Composition**: CLI, libraries, examples, complete operating surfaces and lean selection agree.
8. **Self-host**: use the installed standalone core to forge and verify a successor; compare
   normalized trees. The internal recursion guard skips only a second self-host nesting,
   never the successor's seven earlier gates.

A failing gate blocks release. Retain failed disposable mounts and report their recovery paths.
Inspect structured check status, not only the exit code. Keep unrelated source/target edits and
staged paths intact; commits include only managed release paths.

## Consent and completion

The framework safety floor remains mandatory: live database mutations and production writes need
per-action consent; outward release, protected-branch writes, worktree creation and destructive
cleanup retain their separate gates. `--yes` records approval for the named outward release,
not a merge to protected main, deletion of an unlogged tag, or cleanup of unmerged work.
Unlogged local or remote tags block release until history is reconciled with the operator.
Never delete or overwrite the retired harness, its ledger, or someone else's work.

Report target, core version, eight gate results, local versus remotely verified state,
outstanding merges and failed/skipped checks. Consult owned rule bodies with
`sidekicks framework show <id>`; root instruction pointers are not replacement safety rules.
