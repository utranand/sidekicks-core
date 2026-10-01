#!/usr/bin/env node
// .agents/skills/sk-hello/scripts/readiness.mjs
//
// Environment-readiness check for resuming work in a Sidekicks clone after the
// development environment changes — a new machine, a switched OS, or a fresh
// checkout. These are the things git does NOT carry across a clone or a
// macOS<->Windows hop, so they silently break until fixed: the CLAUDE.md mirror
// of AGENTS.md, the host-level skill links, the registered-project git
// submodules, and the per-scope config documentation.
//
// Two further rows are conditional and REPORT-ONLY, added only where they apply:
// BMAD Method (the bmad/ module tree + command stubs the bmad-family skills
// delegate to — installed by an interactive upstream installer, so never
// auto-run), and Framework core release debt (whether the published core owes a
// release — surfaced here so the release log stays automatic, but forging is an
// outward-facing act and stays the operator's call).
//
// Two modes, both idempotent and best-effort (always exit 0 — a not-ready item
// is information for the human, not a failure of this check):
//
//   (default)  REPORT — detect and print state; for anything not ready, print
//              the exact command to run by hand. Mutates nothing.
//
//   --apply    PREPARE — perform every idempotent fix (recreate the CLAUDE.md
//              mirror, self-heal skill links, `git submodule update --init` ONLY
//              the uninitialized submodules, document missing config blocks),
//              then re-detect and report what remains.
//
// Safety: --apply only INITIALIZES submodules that are not yet checked out. An
// already-populated submodule — even one with local modifications — is never
// touched, so apply can never clobber in-progress work.
//
// Pure Node, no shell-isms — runs identically on macOS, Linux, and Windows. The
// only external commands are `node` and `git`.

import {
  existsSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
// A workspace can CONSUME the framework as a git submodule mounted at <root>/.sidekicks-core/.
// That checkout is itself a forged runtime, so it carries its own .sidekicks/ — which makes a naive
// "nearest ancestor with .sidekicks/" walk stop inside the core and report the CORE's state as the
// workspace's. Mirrors the CLI's own core-mount contract; the marker file is the whole test.
const CORE_DIR = ".sidekicks-core";
const CORE_MARKER = ".sidekicks-core.json";

// Case-insensitively on Windows, exactly like the filesystem compares path components.
function isMountedCore(dir) {
  const base = basename(dir);
  const same =
    process.platform === "win32" ? base.toLowerCase() === CORE_DIR : base === CORE_DIR;
  return same && existsSync(join(dir, CORE_MARKER));
}

// Resolve the repo root by walking up from cwd until a .sidekicks/ dir appears, skipping any
// MOUNTED core on the way up. A STANDALONE core clone is still its own root — it is kept as a
// last-resort answer rather than dropped, so running this inside one reports that clone.
function resolveRepoRoot() {
  let cur = process.cwd();
  let coreFallback = null;
  while (true) {
    if (existsSync(join(cur, ".sidekicks"))) {
      if (isMountedCore(cur)) {
        if (!coreFallback) coreFallback = cur;
      } else {
        return cur;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return coreFallback || process.cwd(); // fallback: best-effort
    cur = parent;
  }
}

const ROOT = resolveRepoRoot();
// Path of the core this workspace mounts, or null when the framework is the repo itself.
const MOUNTED_CORE = isMountedCore(join(ROOT, CORE_DIR)) ? join(ROOT, CORE_DIR) : null;
const APPLY = process.argv.includes("--apply");

/**
 * Where this repo's framework core service lives, repo-relative POSIX.
 *
 * Asked of the CLI rather than written down, because the answer is configuration
 * (`framework_core.target`) and a literal goes stale silently: the core repo was renamed
 * sidekicks-framework -> sidekicks-harness, and the hard-coded path did not fail — it simply stopped
 * existing, which the release-debt row below reads as "this is a mounted core, publish nothing".
 *
 * Falls back to the same default the publish script carries, so a checkout whose CLI cannot answer
 * still behaves as before rather than skipping the check.
 */
function coreTargetRel() {
  const fallback = "projects/global/services/sidekicks-harness/src";
  const r = spawnSync(
    process.execPath, [join(ROOT, "bin", "sidekicks"), "config", "get", "framework_core", "--json"],
    { cwd: ROOT, encoding: "utf8" }
  );
  if (r.error || r.status !== 0) return fallback;
  try {
    const target = JSON.parse(String(r.stdout || "")).config?.target;
    return typeof target === "string" && target ? target.split("\\").join("/") : fallback;
  } catch {
    return fallback;
  }
}

// Parse `git submodule status`: first char is the state flag, then `<sha> <path>`.
// Flags: ' ' = in sync, '-' = NOT initialized (empty dir), '+' = checked out at a
// different commit, 'U' = merge conflicts. Only '-' is something apply fixes —
// the rest are already populated and must not be disturbed.
function submoduleStatus() {
  const res = spawnSync("git", ["submodule", "status"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) return [];
  return (res.stdout || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const flag = line[0];
      const rest = line.slice(1).trim().split(/\s+/);
      return { flag, sha: rest[0], path: rest[1] };
    })
    .filter((s) => s.path);
}

// THE SCOPE-CONFIG ENUMERATOR THAT USED TO LIVE HERE IS GONE, DELIBERATELY.
//
// It listed one git-ignored `config.yaml` per scope so the check below could seed the missing ones.
// Configuration is a FOLDER now — one COMMITTED file per family (`config/jira.yaml`,
// `config/comms.yaml`, …) plus a git-ignored `<family>.secret.yaml` sibling for the credentials —
// so what a clone lacks is no longer the whole configuration, only the secrets. The question worth
// asking became "does the committed half document every block an installed skill declares", and
// that is `sidekicks config sync --check`. Re-deriving the scope list here to ask it a second way
// is exactly the parallel implementation that made this skill's capability audit go stale.

// The scaffold itself (fully-INERT: every generated block commented out, so the file parses as
// empty for that block and the skill keeps its own defaults — no placeholder like
// "YOUR_API_KEY" can ever be actuated as a real key) is composed by `sidekicks config sync`
// from every installed skill's own config.defaults.yaml. See the config check below and
// docs/guide/settings-vs-configuration.md.

// ── BMAD Method ─────────────────────────────────────────────────────────────
// The bmad-family skills (.agents/skills/sk-bmad-*) do not implement
// BMAD themselves — every one of them activates a BMAD slash command
// (/bmad:bmm:agents:pm, /bmad:bmm:workflows:prd, …). Those commands are two
// separate halves, and either can arrive without the other:
//
//   (a) the COMMAND STUBS — .claude/commands/bmad/**. Small files, so they
//       travel in a forged framework core even though no bmad skill does.
//   (b) the MODULE TREE — bmad/ (bmad/core/tasks/workflow.xml, bmad/bmm/
//       workflows/…), which every stub LOADS by {project-root}-relative path on
//       its first line.
//
// A workspace that has (a) without (b) looks wired — the slash command exists
// and is offered — then dies at step 1 on a path that is not there. That is the
// state a mounted framework core starts in, so the row must distinguish it from
// plain "BMAD absent" rather than collapsing both into one message.
//
// BMAD is NOT a Claude plugin: it is absent from .claude/settings.json. It
// installs by cloning BMAD-METHOD and running its own installer, which is
// interactive (it asks which IDEs/modules to wire). Hence report-only,
// apply: null — guidance only, never auto-install. The URL is a fixed
// upstream, not a setting.
const BMAD_REPO = "https://github.com/bmad-code-org/BMAD-METHOD.git";

// The one file every command stub loads first. Its absence is what actually
// breaks a run, so it — not the bmad/ directory's mere existence — is the probe.
function bmadModuleTreePresent() {
  return (
    existsSync(join(ROOT, "bmad", "core", "tasks", "workflow.xml")) &&
    existsSync(join(ROOT, "bmad", "bmm", "workflows"))
  );
}

// Command stubs, counted per CLI so the row can say which surface is wired.
function bmadCommandState() {
  let claude = 0;
  const claudeDir = join(ROOT, ".claude", "commands", "bmad");
  if (existsSync(claudeDir)) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".md")) claude += 1;
      }
    };
    try {
      walk(claudeDir);
    } catch {
      /* unreadable tree — treat as none rather than crashing orientation */
    }
  }
  return { claude };
}

// Which bmad-family sidekicks skills this repo carries. Their presence is what
// makes BMAD *required* here; without them the row is not added at all.
function bmadSkillsPresent() {
  const dir = join(ROOT, '.agents', 'skills');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("sk-bmad-"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Build the full check list fresh each time it is called, so --apply can
// re-detect after performing fixes and report the true post-apply state. Each
// check carries an `apply()` that performs its fix idempotently and returns
// { ok, msg }; a check with `apply: null` (BMAD, release debt) is report-only.
function buildChecks() {
  const checks = [];

  // 1) Agent-context mirror — CLAUDE.md must equal AGENTS.md.
  //    They are committed as symlinks; on Windows (core.symlinks=false) they
  //    check out as tiny text stubs containing the literal "AGENTS.md", so the
  //    the Claude CLI reads a 9-byte file instead of the real instructions.
  {
    const target = join(ROOT, "AGENTS.md");
    const mirrorOk = (name) => {
      const link = join(ROOT, name);
      if (!existsSync(link) || !existsSync(target)) return false;
      try {
        if (lstatSync(link).isSymbolicLink()) return true; // POSIX symlink — in sync by construction
        return readFileSync(link, "utf8") === readFileSync(target, "utf8"); // Windows copy fallback
      } catch {
        return false;
      }
    };
    const ok = mirrorOk("CLAUDE.md");
    checks.push({
      ok,
      label: "Agent-context mirror (CLAUDE.md ↔ AGENTS.md)",
      detail: ok ? "in sync" : "stale or text-stub placeholders",
      fix: "node .agents/skills/sk-hello/scripts/readiness.mjs --apply   (symlinks CLAUDE.md, or copies it where symlinks are refused)",
      apply: () => {
        try {
          const target = join(ROOT, "AGENTS.md");
          if (!existsSync(target)) return { ok: false, msg: "no AGENTS.md to mirror" };
          let copied = false;
          for (const name of ["CLAUDE.md"]) {
            const link = join(ROOT, name);
            try {
              rmSync(link, { force: true });
            } catch {
              /* nothing to remove */
            }
            try {
              symlinkSync("AGENTS.md", link, "file"); // repo-relative target, like `ln -sf AGENTS.md`
            } catch {
              // Windows without Developer Mode refuses symlinks; a byte-equal copy is the
              // supported form there, and it is what the mirror check accepts.
              writeFileSync(link, readFileSync(target, "utf8"));
              copied = true;
            }
          }
          return {
            ok: true,
            msg: copied
              ? "CLAUDE.md copied from AGENTS.md (symlinks unavailable)"
              : "CLAUDE.md → AGENTS.md symlinked",
          };
        } catch (e) {
          return { ok: false, msg: e.message };
        }
      },
    });
  }

  // 2) Host skill links — every per-CLI exposure directory must resolve to the
  //    canonical .agents/skills directory, or that CLI discovers no skills. The
  //    sidekicks CLI self-heals these on every invocation, so this is normally
  //    already green; it is only red before the first CLI call of a session, or
  //    if link creation was blocked.
  //
  //    Every exposure link is checked: a missing one means that host CLI sees no
  //    skills. (.agents/skills is not a link — it is the canonical tree itself.)
  {
    const EXPOSURE_LINKS = [".claude/skills", ".agent/skills"];
    const linkIsDir = (rel) => {
      try {
        return statSync(join(ROOT, rel)).isDirectory(); // follows symlink/junction; a stub file -> false
      } catch {
        return false;
      }
    };
    const broken = EXPOSURE_LINKS.filter((rel) => !linkIsDir(rel));
    const ok = broken.length === 0;
    checks.push({
      ok,
      label: `Host skill links (${EXPOSURE_LINKS.join(", ")})`,
      detail: ok ? "resolve to .agents/skills" : `missing or text-stub placeholders: ${broken.join(", ")}`,
      fix: "run any `node bin/sidekicks` verb (auto-heals)",
      apply: () => {
        // Any CLI verb self-heals the links: symlinks on POSIX, junctions on Windows.
        const r = spawnSync("node", ["bin/sidekicks", "index", "show", "--json"], {
          cwd: ROOT,
          encoding: "utf8",
        });
        return {
          ok: r.status === 0,
          msg: r.status === 0 ? "skill links self-healed via CLI" : (r.stderr || "").trim(),
        };
      },
    });
  }

  // 3) Git submodules — registered user projects can be wired as git submodules
  //    (see the repo-root .gitmodules). A clone made without
  //    `--recurse-submodules` leaves those project directories EMPTY, so the
  //    work simply is not there until the submodules are initialized. Only
  //    surface this row when the repo actually declares submodules.
  if (existsSync(join(ROOT, ".gitmodules"))) {
    const subs = submoduleStatus();
    const uninit = subs.filter((s) => s.flag === "-").map((s) => s.path);
    const ok = uninit.length === 0;
    checks.push({
      ok,
      label: "Git submodules (registered projects)",
      detail: ok
        ? `${subs.length} initialized`
        : `${uninit.length} uninitialized: ${uninit.join(", ")}`,
      // Scope the fix to the uninitialized paths so already-checked-out
      // submodules (including ones with local edits) are never disturbed.
      fix:
        "git submodule update --init --recursive" +
        (uninit.length ? " -- " + uninit.join(" ") : ""),
      apply: () => {
        if (!uninit.length) return { ok: true, msg: "nothing to initialize" };
        const r = spawnSync(
          "git",
          ["submodule", "update", "--init", "--recursive", "--", ...uninit],
          { cwd: ROOT, encoding: "utf8" }
        );
        return {
          ok: r.status === 0,
          msg: r.status === 0 ? `initialized ${uninit.join(", ")}` : (r.stderr || "").trim(),
        };
      },
    });
  }

  // 4) Scope configuration — every block an installed skill declares should be DOCUMENTED in the
  //    scope's `config/<family>.yaml`, written inert so it still resolves to the skill's own
  //    defaults until a human uncomments a key. Adding or enhancing a skill changes what is owed,
  //    which is why the question is asked of the CLI rather than answered by comparing paths here.
  //
  //    This check runs LAST so that in --apply mode the submodule init above has already populated
  //    any freshly-pulled project before we look at it (the apply() re-asks, too).
  {
    // `config sync --check` exits non-zero exactly when a sync would close a gap, and prints the
    // gaps it found. Drift inside a live block is deliberately NOT a gap: no command may safely
    // merge into a file that can hold real credentials.
    const probe = spawnSync(
      process.execPath, [join(ROOT, "bin", "sidekicks"), "config", "sync", "--check", "--scope", "all"],
      { cwd: ROOT, encoding: "utf8" }
    );
    const reachable = !probe.error;
    const ok = reachable && probe.status === 0;
    // The gap COUNT and the scopes, not the whole listing: `--check` names every missing block, and
    // sixty of them on one readiness line buries every other row in the report. The command in
    // `fix:` prints the detail for anyone who wants it.
    const report = String(probe.stdout || probe.stderr || "");
    const gapCount = (report.match(/^\s+\S+\.yaml: '/gm) || []).length;
    const scopes = [...new Set(
      (report.match(/^\s+(\S+?)\/config\//gm) || []).map((m) => m.trim().split("/config/")[0])
    )];
    checks.push({
      ok,
      label: "Scope configuration (config/<family>.yaml — every declared block documented)",
      detail: !reachable
        ? "could not run `sidekicks config sync --check`"
        : ok
          ? "every installed skill's blocks are documented, in every scope"
          : `${gapCount || "some"} block(s) undocumented`
            + (scopes.length ? ` in ${scopes.join(", ")}` : ""),
      fix: "sidekicks config sync --scope all   (writes each block INERT — it keeps resolving to the owning skill's defaults)",
      apply: () => {
        // The generator is the CLI verb, not a script bundled here: a structural write under
        // .sidekicks/ belongs to the CLI (Rule 1). `config sync` is additive by construction —
        // it appends blocks a scope lacks, never rewrites one that carries live values — so it is
        // safe to run over every scope without first checking which are fresh.
        const r = spawnSync(
          process.execPath, [join(ROOT, "bin", "sidekicks"), "config", "sync", "--scope", "all"],
          { cwd: ROOT, encoding: "utf8" }
        );
        if (r.error || r.status !== 0) {
          return { ok: false, msg: ((r.stderr || r.stdout) || "config sync failed").trim().split("\n")[0] };
        }
        const wrote = String(r.stdout || "")
          .split("\n").filter((l) => l.includes("wrote:")).join("; ").trim();
        return {
          ok: true,
          msg: wrote || "already documented — nothing to write",
        };
      },
    });
  }


  // 5) BMAD Method — see the helper block above. Every sk-bmad-* skill delegates to a
  //    /bmad:… slash command, so a repo carrying those skills needs the upstream tree
  //    for them to work at all. That — not any mandate — is what this row reports:
  //    rule.bmad-first is a SETTING, and it resolves `disabled` in this checkout, so
  //    service code is not required to take the BMAD route. The native delivery skills
  //    need nothing installed beyond themselves — no external tree, no command stubs —
  //    which is why that route has no readiness row at all. Neither the command stubs nor the
  //    bmad/ module tree is installable by us (the upstream installer is
  //    interactive), so this row is REPORT-ONLY: apply: null, never an auto-clone.
  //
  //    Conditional by design — added only when this repo carries bmad-family
  //    skills or bmad command stubs. A runtime forged without either has nothing
  //    to satisfy, and a standing red row there would be noise, not readiness.
  {
    const skills = bmadSkillsPresent();
    const cmds = bmadCommandState();
    const stubs = cmds.claude;
    if (skills.length || stubs) {
      const tree = bmadModuleTreePresent();
      const surfaces = `Claude: ${cmds.claude ? `${cmds.claude} command(s)` : "none"}`;
      const who = skills.length
        ? `${skills.length} bmad skill(s) require it`
        : "no bmad skills here, but command stubs are present";

      let detail;
      let fix;
      if (tree && stubs) {
        detail = `bmad/ ✓ | ${surfaces} | ${who}`;
        fix = null;
      } else if (tree && !stubs) {
        // The tree is there but nothing exposes it — the skills' `/bmad:…`
        // activations resolve to nothing, which reads as "skill is broken".
        detail = `bmad/ ✓ but NO command stubs on any CLI — /bmad:… activations will not resolve | ${who}`;
        fix = `re-run the BMAD installer in this repo to wire the IDE commands (clone: ${BMAD_REPO})`;
      } else if (!tree && stubs && !skills.length) {
        // Stubs, no tree, AND no bmad skill: nothing here ever wanted them. That is not a missing
        // install, it is PACKAGING RESIDUE — the forge copied the command trees wholesale, so a
        // consumer's menu filled with `/bmad:*` entries that load a tree the core does not carry
        // (INC-2026-09-04-02, N-4). Prescribing `git clone BMAD-METHOD` here told the consumer to
        // install a whole framework to satisfy stubs they never asked for, to fix a defect they
        // cannot reach: the payload belongs to whoever forged the runtime.
        detail =
          `${stubs} command stub(s) present (${surfaces}) but NO bmad skill and no bmad/ tree — ` +
          "every stub loads {project-root}/bmad/core/tasks/workflow.xml and fails at step 1. " +
          "Nothing here needs them: this is packaging residue, not a missing install";
        fix = MOUNTED_CORE
          ? "report it to whoever forged this core — `inherit verify` fails on it (agents and "
            + "commands travel by ownership). Until then the stubs are inert; deleting "
            + ".claude/commands/bmad in this workspace is safe"
          : "remove the orphaned stubs (.claude/commands/bmad), or "
            + `install the skills that own them. Only install BMAD (${BMAD_REPO}) if you actually want it`;
      } else if (!tree && stubs) {
        // Stubs and bmad SKILLS, but no tree: this one really is a missing install, and the failure
        // it produces names a missing file rather than a missing install — so say the real cause.
        detail =
          `${stubs} command stub(s) present (${surfaces}) but bmad/ module tree MISSING — ` +
          `every stub loads {project-root}/bmad/core/tasks/workflow.xml and will fail at step 1 | ${who}`;
        fix = `git clone ${BMAD_REPO} && run its installer against this repo (installs the bmad/ tree; interactive — never auto-run)`;
      } else {
        detail = `not installed — no bmad/ tree and no command stubs | ${who}`;
        fix = `git clone ${BMAD_REPO} && run its installer against this repo (interactive — never auto-run)`;
      }

      checks.push({
        ok: tree && stubs > 0,
        label: "BMAD Method (required by bmad-family skills)",
        detail,
        fix,
        apply: null, // guidance only — the upstream installer is interactive
      });
    }
  }

  // 6) Framework core release debt — only in the repo that PUBLISHES the core, i.e.
  //     one carrying both the core service AND scripts/the framework core lifecycle.
  //     The publish script DOES travel into a forged core (this skill's manifest claims
  //     it under requires.framework_files, and scripts/ travels by ownership), so the
  //     script alone is not the discriminator — the core SERVICE is. A mounted core has
  //     no core service of its own, so the row is absent there, which is correct: a
  //     mounted core publishes nothing.
  //
  //     WHERE that service lives is CONFIGURED (`framework_core.target`), not a literal.
  //     It used to be hard-coded as `.../services/sidekicks-framework/src`, and renaming
  //     the core repo to sidekicks-harness made this row silently stop firing — the path
  //     simply stopped existing, and an absent service reads exactly like a mounted core.
  //     Asking the CLI is also what the framework core lifecycle itself does, so the two
  //     cannot disagree about which core this repo publishes.
  //
  //     This is what makes the release log automatic rather than remembered: the
  //     core plan's release-debt JSON is the single computation, surfaced on
  //     every orientation instead of only when someone thinks to check. Report-only:
  //     forging a release is an outward-facing act and stays the operator's call.
  {
    const publish = join(ROOT, "lib", "core-lifecycle", "plan.mjs");
    const service = join(ROOT, ...coreTargetRel().split("/"));
    if (existsSync(publish) && existsSync(service)) {
      const r = spawnSync(process.execPath, [join(ROOT, "bin", "sidekicks"), "core", "plan", "--json"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      let st = null;
      try {
        st = JSON.parse(r.stdout || "");
      } catch {
        /* unparseable — reported as unknown below rather than crashing orientation */
      }
      if (!st) {
        checks.push({
          ok: true,
          label: "Framework core (release debt)",
          detail: "could not read publish status — reported N/A rather than a false green",
          fix: null,
          apply: null,
        });
      } else {
        const owed = (st.pending_commits || 0) + (st.pending_files || 0);
        const dirty = st.uncommitted_core_files || 0;
        // A release nobody pushed looked exactly like a published one on every orientation, which is
        // how v1.4.1 sat tagged-but-unserved while the README told consumers to install it. Only a
        // RECORDED negative counts: absence means "not verified", never "verified false".
        const notServed = st.remote_state === "not_served";
        const unlogged = Array.isArray(st.unlogged_tags) ? st.unlogged_tags : [];
        const ok = owed === 0 && dirty === 0 && st.version_agrees !== false && !notServed;
        const bits = [st.remote_state === "served"
          ? `published v${st.remote_verified_version || "?"}`
          : `local v${st.published_version || "?"} (not verified published)`];
        if (owed) bits.push(`${st.pending_commits} commit(s) since`);
        if (dirty) bits.push(`${dirty} uncommitted core-bound file(s)`);
        if (st.version_agrees === false) bits.push("log/marker version MISMATCH");
        if (notServed) bits.push(`v${st.unpushed_release} NOT SERVED by the remote`);
        else if (st.remote_state === "unverified") bits.push("remote not verified");
        if (unlogged.length) bits.push(`${unlogged.length} unlogged tag(s)`);
        checks.push({
          ok,
          label: "Framework core (release debt)",
          detail: ok
            ? `${bits.join(", ")} — in sync, no release owed`
            : `${bits.join(", ")} — next would be v${st.next_version || "?"}`,
          fix: ok
            ? null
            : notServed
              ? "node bin/sidekicks core release          (then … release --yes)"
              : "node bin/sidekicks core plan   (then … publish)",
          apply: null, // publishing is outward-facing — never automatic
        });
      }
    }
  }

  return checks;
}

// ── Detect (and, in --apply mode, prepare) ──────────────────────────────────
let checks = buildChecks();
const appliedLog = [];

if (APPLY) {
  for (const c of checks) {
    if (!c.ok && typeof c.apply === "function") {
      const r = c.apply();
      appliedLog.push(`  [${r.ok ? "DONE" : "FAIL"}] ${c.label} — ${r.msg}`);
    }
  }
  checks = buildChecks(); // re-detect so the report below reflects post-apply truth
}

// ── Render ──────────────────────────────────────────────────────────────────
const out = [];
out.push(`Environment readiness (${process.platform}${APPLY ? ", apply" : ", report-only"}):`);

if (APPLY && appliedLog.length) {
  out.push("");
  out.push("Applied fixes:");
  out.push(...appliedLog);
}

out.push("");
for (const c of checks) {
  const tag = c.ok ? "OK " : "FIX";
  out.push(`  [${tag}] ${c.label} — ${c.detail}`);
  if (!c.ok) out.push(`         run: ${c.fix}`);
}

const notReady = checks.filter((c) => !c.ok).length;
// Report-only rows (apply: null — BMAD, core release debt) can never be
// fixed by --apply, so "re-run with --apply" must not be offered when they are all
// that is left. Promising a fix the flag cannot perform is worse than saying nothing.
const fixableByApply = checks.filter((c) => !c.ok && typeof c.apply === "function").length;
out.push("");
if (APPLY) {
  out.push(
    notReady === 0
      ? "All core checks green — clone prepared, safe to resume."
      : `${notReady} item(s) still need attention (commands above; some may require admin/Developer Mode or network access).`
  );
} else {
  out.push(
    notReady === 0
      ? "All core checks green — safe to resume."
      : fixableByApply === 0
        ? `${notReady} item(s) need attention — all of them report-only (run the commands above by hand; --apply cannot perform these).`
        : `${notReady} item(s) need a fix before resuming (${fixableByApply} of them applicable). Re-run with --apply to perform those automatically, or run the commands above by hand.`
  );
}

process.stdout.write(out.join("\n") + "\n");
process.exit(0); // best-effort: never fail the caller
