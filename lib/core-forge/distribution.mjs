// Sidekicks core forge — distribution. Zero runtime dependencies.
import { renderInstallerTemplate } from './instructions.mjs';
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync,
  statSync, lstatSync, realpathSync, readlinkSync, rmSync, symlinkSync, chmodSync,
  renameSync, openSync, closeSync,
} from "node:fs";
import { join, dirname, relative, resolve, basename, sep, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { configurationInventory } from "../core-lifecycle/config-templates.mjs";
import { resolveFrameworkPreset } from "../skill-package/framework-preset.mjs";
import {
  projectSkillRuntime,
  projectedSourceHashes,
  RUNTIME_EXCLUDED_DIRS,
} from "../skill-package/runtime-projection.mjs";
import { CORE_INSTRUCTION_DOC, CORE_INSTRUCTION_DOC_LEGACY, CORE_LAYOUT, CORE_MARKER_REL, CORE_MOUNT_DIR, CORE_PACKS_REL, DELTA_SKIP_DIRS, DELTA_SKIP_PREFIXES, DELTA_SKIP_RELS, TEXTUAL, die, isWindows, nowBangkok } from './_shared.mjs';
import { countAgentPacks, truthyFlag } from './select.mjs';
import { renderTemplate } from './instructions.mjs';
import { copyTree } from './surfaces.mjs';

export function rawGithubUrl(remote, ref, file) {
  if (!remote) return null;
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remote).trim());
  if (!m) return null;
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${ref}/${file}`;
}

export function markerVersion(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, CORE_MARKER_REL), "utf8"));
    return typeof marker.version === "string" && marker.version ? marker.version : null;
  } catch {
    return null;
  }
}

export function isCoreRuntime(dir) {
  return existsSync(join(dir, CORE_MARKER_REL));
}

export function compareCoreVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function requireCoreVersion(dir, flags) {
  const stated = flags["core-version"] ? String(flags["core-version"]) : null;
  if (!stated) {
    die(
      "--as-core requires --core-version X.Y.Z.\n" +
        "  Without it the marker would be stamped from this repo's package.json, which tracks the\n" +
        "  REPO and not the core's own version line — that is how a hand forge silently downgrades a\n" +
        "  mounted core's marker.\n" +
        "  Derive it instead:  node bin/sidekicks core publish",
      2
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(stated)) {
    die(`--core-version '${stated}' is not a semver X.Y.Z`, 2);
  }
  const current = markerVersion(dir);
  if (current && compareCoreVersions(stated, current) < 0 && !truthyFlag(flags["force-downgrade"])) {
    die(
      `--core-version ${stated} is LOWER than the ${current} this target already stamps.\n` +
        "  A published core's marker is what consumers pin against, so moving it backwards\n" +
        "  un-publishes work that is already mounted somewhere.\n" +
        "  Cut a higher version, or pass --force-downgrade if the rollback is deliberate.",
      2
    );
  }
  return stated;
}

export function maskVolatile(text) {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?/g, "<ts>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
}

export function snapshotCoreTree(root) {
  const files = new Map();
  if (!existsSync(root)) return { present: false, files, version: null, sourceCommit: null };

  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (DELTA_SKIP_DIRS.has(e.name)) continue;
        walk(join(abs, e.name), childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (DELTA_SKIP_RELS.has(childRel)) continue;
      if (DELTA_SKIP_PREFIXES.some((p) => childRel.startsWith(p))) continue;
      let buf;
      try { buf = readFileSync(join(abs, e.name)); } catch { continue; }
      const body = TEXTUAL.test(e.name) ? Buffer.from(maskVolatile(buf.toString("utf8")), "utf8") : buf;
      files.set(childRel, createHash("sha256").update(body).digest("hex"));
    }
  };
  walk(root, "");

  let version = null;
  let sourceCommit = null;
  try {
    const marker = JSON.parse(readFileSync(join(root, CORE_MARKER_REL), "utf8"));
    version = marker.version ?? null;
    sourceCommit = marker.source_commit ?? null;
  } catch { /* not a core, or a first forge */ }
  return { present: true, files, version, sourceCommit };
}

export function deltaSurface(rel) {
  if (rel.startsWith(".agents/skills/")) return `skill \`${rel.split("/")[2]}\``;
  if (rel.startsWith("lib/")) return "`lib/` — framework libraries";
  if (rel.startsWith("scripts/")) return "`scripts/` — hook bodies";
  if (rel.startsWith("bin/")) return "`bin/` — the CLI dispatcher";
  if (rel.startsWith(".sidekicks/agent-packs/")) return "agent packs";
  if (rel.startsWith(".sidekicks/")) return "`.sidekicks/` — rules, config, settings";
  if (/^\.(claude|codex|agent|agents)\//.test(rel)) return "per-CLI wiring (Rule 6)";
  if (rel.startsWith(".githooks/")) return "`.githooks/` — git hooks";
  if (rel.startsWith("docs/") || rel === "AGENTS.local.md") return "docs";
  if (rel === "AGENTS.md" || rel === CORE_INSTRUCTION_DOC || rel === CORE_INSTRUCTION_DOC_LEGACY) return "instructions";
  if (rel === "install.sh" || rel === "install.ps1") return "installers";
  if (/^(package\.json|requirements\.txt|\.gitignore|\.gitattributes)$/.test(rel)) return "packaging";
  return "other";
}

export function coreReleaseDelta(before, after) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [rel, hash] of after.files) {
    if (!before.files.has(rel)) added.push(rel);
    else if (before.files.get(rel) !== hash) changed.push(rel);
  }
  for (const rel of before.files.keys()) if (!after.files.has(rel)) removed.push(rel);

  const skillNames = (list) => [...new Set(
    list.filter((r) => r.startsWith(".agents/skills/")).map((r) => r.split("/")[2]),
  )].sort();
  const before_ = skillNames([...before.files.keys()]);
  const after_ = skillNames([...after.files.keys()]);

  const tally = new Map();
  const bump = (rel, key) => {
    const s = deltaSurface(rel);
    if (!tally.has(s)) tally.set(s, { surface: s, added: 0, changed: 0, removed: 0 });
    tally.get(s)[key] += 1;
  };
  for (const r of added) bump(r, "added");
  for (const r of changed) bump(r, "changed");
  for (const r of removed) bump(r, "removed");

  const surfaces = [...tally.values()].sort((a, b) =>
    (b.added + b.changed + b.removed) - (a.added + a.changed + a.removed) || (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0));

  return {
    first: !before.present || before.files.size === 0,
    prevVersion: before.version,
    prevCommit: before.sourceCommit,
    added, changed, removed, surfaces,
    skillsAdded: after_.filter((s) => !before_.includes(s)),
    skillsRemoved: before_.filter((s) => !after_.includes(s)),
  };
}

export function renderReleaseChanges(d, ctx) {
  const lines = ["## Changes in this release", ""];
  if (d.first) {
    lines.push(
      `**v${ctx.version} is the first release forged into this repository** — all ${ctx.total} shipped`,
      `file(s) are new. Source commit \`${ctx.sourceCommit}\`.`,
    );
    return lines.join("\n") + "\n";
  }

  const prev = d.prevVersion ? `**v${d.prevVersion}**` : "the previous release";
  lines.push(
    `Forged from source commit \`${ctx.sourceCommit}\`, over ${prev}`
    + `${d.prevCommit ? ` (\`${d.prevCommit}\`)` : ""}.`,
    "",
  );

  if (!d.added.length && !d.changed.length && !d.removed.length) {
    lines.push(
      "**No shipped file changed.** Only the generated headers differ — the forge timestamp and the",
      "recorded source commit. Updating to this release changes nothing you can observe.",
    );
    return lines.join("\n") + "\n";
  }

  lines.push(
    `${d.added.length} added · ${d.changed.length} changed · ${d.removed.length} removed`
    + " (generated headers masked, so only real content counts):",
    "",
    "| Surface | Added | Changed | Removed |",
    "|---|---:|---:|---:|",
  );
  for (const s of d.surfaces) lines.push(`| ${s.surface} | ${s.added} | ${s.changed} | ${s.removed} |`);

  if (d.skillsAdded.length || d.skillsRemoved.length) {
    lines.push("");
    if (d.skillsAdded.length) lines.push(`Skills added: ${d.skillsAdded.map((s) => `\`${s}\``).join(", ")}.`);
    if (d.skillsRemoved.length) {
      lines.push(
        `Skills **removed**: ${d.skillsRemoved.map((s) => `\`${s}\``).join(", ")} — a workspace that`,
        "invokes one of them loses it at `core update`.",
      );
    }
  }
  lines.push(
    "",
    "> This table is derived by comparing the forged tree against what this repository held before the",
    "> forge, not written by hand. A surface absent from it did not change.",
  );
  return lines.join("\n") + "\n";
}

export function writeCoreReadme(runtimeRoot, vars, before) {
  const after = snapshotCoreTree(runtimeRoot);
  const delta = coreReleaseDelta(before, after);
  const releaseChanges = renderReleaseChanges(delta, {
    version: vars.CORE_VERSION,
    sourceCommit: vars.SOURCE_COMMIT,
    total: after.files.size,
  });
  writeFileSync(
    join(runtimeRoot, "README.md"),
    renderTemplate("core-readme.md.tmpl", { ...vars, RELEASE_CHANGES: releaseChanges.trimEnd() }),
    "utf8",
  );
  return { delta, total: after.files.size };
}

export function writeCoreDistribution(repoRoot, runtimeRoot, opts) {
  const { name, sourceCommit, skillCount, remote, ref, version } = opts;
  const files = [];
  const notes = [];

  // ── The marker ─────────────────────────────────────────────────────────────────────────────────
  writeFileSync(join(runtimeRoot, CORE_MARKER_REL), `${JSON.stringify({
    schema: 1,
    name,
    version,
    layout: CORE_LAYOUT,
    remote: remote || null,
    ref: ref || "main",
    forged_at: nowBangkok(),
    source_commit: sourceCommit,
  }, null, 2)}\n`, "utf8");
  files.push(`${CORE_MARKER_REL} — the mount marker (both root resolvers walk past a core)`);

  // ── The framework instruction surface a workspace imports ──────────────────────────────────────
  const agentsMd = join(runtimeRoot, "AGENTS.md");
  if (existsSync(agentsMd)) {
    const body = readFileSync(agentsMd, "utf8");
    // The preamble is where the MOUNT is described, because the body below it is the core's own
    // AGENTS.md and speaks for a standalone runtime — "a runtime has no `projects/` tree unless one
    // is created", "skills are canonical at `.agents/skills/`", and no mention at all of the
    // subagents, agent pack, plugin declarations or README that ship in the same tarball. A reader
    // who takes that literally in a mounted workspace is wrong about five things at once
    // (INC-2026-09-06-06 B-4). Correcting it HERE rather than forking the body keeps the invariant
    // cmdVerify depends on: AGENTS.framework.md ends with AGENTS.md, byte for byte.
    const preamble = [
      "<!-- GENERATED by sk-publish-core. Do not edit: the next forge overwrites it. -->",
      "",
      "> **This is the framework's instruction surface.** A workspace that mounts this core at",
      `> \`${CORE_MOUNT_DIR}/\` imports this file from its own \`AGENTS.md\` (a managed block written by`,
      "> `sidekicks core init`), so these rules follow whichever framework version the workspace is",
      "> pinned to. Workspace-specific instructions belong in that `AGENTS.md`, below the block —",
      "> `sidekicks core update` never touches them.",
      "",
      "## Reading this in a mounted workspace",
      "",
      "Everything below the rule is the framework's own instruction file, written from the point of",
      "view of a standalone runtime. Five things read differently where you are:",
      "",
      "- **You have a `projects/` tree.** `core init` creates it, and the root project is the",
      "  workspace itself, so the active scope is the root scope until you run `project create`.",
      "  Rules 1–2 still hold exactly as stated — `projects/` is CLI-mediated, never `mkdir`.",
      `- **Your skills are links.** The entries under \`.agents/skills/\` point into \`${CORE_MOUNT_DIR}/\`, so`,
      "  they are read-only and travel with the pinned version. A REAL directory of the same name",
      "  beside them shadows the core's copy — that is how you override or extend one.",
      `- **The CLI, the hook scripts and \`lib/\` are inside \`${CORE_MOUNT_DIR}/\`.** Your workspace has no`,
      "  root `scripts/`; `bin/sidekicks` is a shim, and every wired hook path routes through the mount.",
      "- **Subagents and an agent pack shipped with the core.** `.agents/subagents/` is canonical,",
      "  with generated `.claude/agents/`, `.codex/agents/`, and `.agents/plugins/sidekicks-agents/` ports;",
      "  `sidekicks agent pack list` shows the packs, which are shipped but not installed.",
      "- **Third-party plugins are DECLARED, never redistributed.** `.claude/settings.json` names them",
      "  and their marketplaces; nothing is installed until you run `sk-hello --apply`.",
      "",
      `Full reference for the mount itself: \`${CORE_MOUNT_DIR}/README.md\`.`,
      "",
      "---",
      "",
    ].join("\n");
    writeFileSync(join(runtimeRoot, CORE_INSTRUCTION_DOC), preamble + body, "utf8");
    files.push(`${CORE_INSTRUCTION_DOC} — the rules a mounted workspace imports (AAP-106)`);
    // A core forged before the rename shipped this body as CLAUDE.framework.md, and a re-forge over
    // that tree would leave the old name behind as a second, drifting copy of the same rules. Drop
    // it: workspaces pinned to the old core still read their own pinned checkout, and any workspace
    // moving to this one has its import line healed by `core init` / `core update`.
    const legacyDoc = join(runtimeRoot, "CLAUDE.framework.md");
    if (existsSync(legacyDoc)) {
      rmSync(legacyDoc, { force: true });
      notes.push("removed the pre-rename CLAUDE.framework.md — AGENTS.framework.md replaces it");
    }
  } else {
    notes.push(`AGENTS.md was not generated, so ${CORE_INSTRUCTION_DOC} was skipped`);
  }

  // ── The installers ─────────────────────────────────────────────────────────────────────────────
  const defaultRef = ref || "main";
  const rawSh = rawGithubUrl(remote, defaultRef, "install.sh");
  const rawPs1 = rawGithubUrl(remote, defaultRef, "install.ps1");
  if (!rawSh) {
    notes.push(
      `${remote ? `remote '${remote}' is not a github.com https URL` : "no --remote was given"} — the `
      + "installer's documented curl URL is a placeholder; the script itself works when run locally"
    );
  }

  const vars = {
    GENERATED_AT: nowBangkok(),
    SOURCE_COMMIT: sourceCommit,
    CORE_DIR: CORE_MOUNT_DIR,
    // The instruction file a mounted workspace imports. Templated rather than written literally so
    // the README can never again document a filename this forge does not ship — the pre-rename
    // README hard-coded CLAUDE.md as the workspace's instruction surface and survived the flip to
    // AGENTS.md unnoticed, telling every reader to edit a symlink.
    FRAMEWORK_DOC: CORE_INSTRUCTION_DOC,
    FRAMEWORK_REMOTE: remote || "<framework-remote>",
    DEFAULT_REF: defaultRef,
    DEFAULT_DIR: "sidekicks",
    RAW_INSTALL_URL: rawSh || "<raw-url-of-install.sh>",
    RAW_INSTALL_PS1_URL: rawPs1 || "<raw-url-of-install.ps1>",
    RUNTIME_NAME: name,
    CORE_VERSION: version,
    // The tag THIS build is. The README's install commands pin it rather than tracking the remote's
    // default branch: a reader who copies the one-liner gets the version the README describes, not
    // whatever main happens to serve. v2.0.0's README documented an install that would have handed
    // the reader v1.1.5, because main had never been pushed (F-12/F-13).
    CORE_TAG: `v${version}`,
    SKILL_COUNT: String(skillCount),
  };

  const sh = join(runtimeRoot, "install.sh");
  writeFileSync(sh, renderInstallerTemplate("install.sh.tmpl", vars), "utf8");
  if (!isWindows) { try { chmodSync(sh, 0o755); } catch { /* non-fatal */ } }
  files.push("install.sh — the curl bootstrap (POSIX sh; macOS, Linux, Git Bash)");

  writeFileSync(join(runtimeRoot, "install.ps1"), renderInstallerTemplate("install.ps1.tmpl", vars), "utf8");
  files.push("install.ps1 — the PowerShell twin");

  // ── The README, which IS the install documentation ─────────────────────────────────────────────
  // Written LAST, by writeCoreReadme, once the hook prune and the index rebuild have run: it reports
  // what this release changed in the destination, so it can only be rendered against a finished tree.
  files.push("README.md — install / update / uninstall / release delta, regenerated on every forge");

  // ── Agent packs ────────────────────────────────────────────────────────────────────────────────
  // OPTIONAL crews the consumer may install with `sidekicks agent pack install <id>`. They ship
  // inside the core and are NEVER installed for the user: `core init` and `core update` write no
  // agent, and the only thing that creates one is that explicit verb.
  //
  // This is a CORE-DISTRIBUTION surface, not a CORE_SURFACE, so an ordinary forged runtime is
  // unchanged — a runtime is used by the person who forged it and already has whatever agents they
  // want, while a core is consumed by strangers who have none.
  //
  // It does NOT weaken the guarantee that `.sidekicks/agents/` never bulk-copies. That guarantee is
  // structural (`.sidekicks` is not a copy surface, so no walk reaches the folder) and it stands:
  // this copies a DIFFERENT, separately-authored directory whose contents are validated as portable
  // before they may ship. See lib/agent-lifecycle/_pack.mjs.
  const packSrc = join(repoRoot, CORE_PACKS_REL);
  if (existsSync(packSrc)) {
    const packCount = countAgentPacks(packSrc);
    if (packCount > 0) {
      const written = copyTree(packSrc, join(runtimeRoot, CORE_PACKS_REL));
      files.push(`${CORE_PACKS_REL}/ — ${packCount} optional agent pack(s), ${written} file(s); shipped, never auto-installed`);
    } else {
      notes.push(`${CORE_PACKS_REL}/ exists but holds no pack (a pack is a directory with pack.yaml) — none shipped`);
    }
  } else {
    notes.push(`the source repo carries no ${CORE_PACKS_REL}/ — this core ships no agent packs`);
  }

  // ── One version number, not two ────────────────────────────────────────────────────────────────
  // `sidekicks --version` reads the package.json next to the CLI it ran, which in a mounted workspace
  // is the CORE's. writeRuntimeScaffold seeds that at 0.1.0 (and only when absent), so without this a
  // user sees `--version 0.1.0` next to `core status → version 1.1.0` for the same framework.
  const pkgPath = join(runtimeRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.version !== version) {
        pkg.version = version;
        writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
        files.push(`package.json — version stamped to ${version}, matching the marker`);
      }
    } catch {
      notes.push("package.json is unparseable — its version was left alone and may disagree with the marker");
    }
  }

  // `vars` travels out so the README can be rendered after the rest of the forge finishes.
  return { files, notes, vars };
}
