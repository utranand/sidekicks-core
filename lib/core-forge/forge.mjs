import { projectRootStructure, verifyRootStructure } from './surfaces.mjs';
import { assertSafeForgeTarget } from './select.mjs';
import { verifyInstructionBodies } from './instructions.mjs';
import { coreDirOf } from '../sk-cli/core-mount.mjs';
import { CoreForgeError } from './exit.mjs';
// Sidekicks core forge — forge. Zero runtime dependencies.
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
import { countAgentPacks, csv, declaredDependencies, listAvailableSkills, loadHostPlugins, loadPresets, loadRequiredSkills, packSkillsFor, referencedSkills, resolveDelegateSelection, resolveRuntime, resolveSkill, resolveSkillSelection, skillVersion, truthyFlag, unionPackSkills, verifyAgentPacks, warnIfProjectScoped } from './select.mjs';
import { BRIDGE_DIRNAME, CLI_WIRING, CORE_INSTRUCTION_DOC, CORE_INSTRUCTION_DOC_LEGACY, CORE_MARKER_REL, CORE_MOUNT_DIR, CORE_PACKS_REL, CORE_RULES_NOT_IN_RUNTIME_INSTRUCTIONS, CORE_SETTINGS_SHIPPED_OFF, CORE_SURFACES, DELEGATES_DIRNAME, DELEGATE_MEMORY_DIR, DELEGATE_SCRIPT_FILES, DELEGATE_SCRIPT_SUBDIRS, DELEGATE_SKILL_RE, DELEGATE_SURFACES, DENY, DENY_PATTERNS, MANIFEST_REL, OPTIONAL_SURFACES, RUNTIME_TEST_COMMAND, RUNTIME_TEST_SCRIPT, SCHEMA, SCRIPT_SUBDIR_OWNERS, delegateWorkDir, die, displayPath, ensureSourceGitignore, gitHead, hashFile, initRuntimeGit, isWindows, listAvailableDelegates, mkdirp, nowBangkok, out, ownedFamilies, resolveDelegate, surfaceFamily } from './_shared.mjs';
import { classifyConfiguration, copyConfigurationSurface, copyCoreSurfaces, copyScriptsSurface, copyTree, isDenied, refreshRuntimeIndex, resolveScriptOwnership } from './surfaces.mjs';
import { adoptIfTargeted, delegateUnitRecord, forgetRuntime, isInRuntimesDir, isInsideRepo, manifestPath, presentDelegates, readManifest, readRegistry, registerRuntime, requireManifest, skillUnitRecord, trackedDelegates, trackedSkills, writeManifest } from './registry.mjs';
import { buildVenv, resolveRequirements, venvBin } from './venv.mjs';
import { isCoreRuntime, requireCoreVersion, snapshotCoreTree, writeCoreDistribution, writeCoreReadme } from './distribution.mjs';
import { pruneHookWiring, prunePluginDeclarations, runtimeCoreRules, runtimeToggleableEntries, syncRuntimeConfig, syncRuntimeFramework, writeRuntimeScaffold } from './settings-sync.mjs';
import { writeInstructionMirrors, writeRuntimeAgentsMd } from './instructions.mjs';
import { STATUS_LABEL, applyDelegatePatch, applyPatch, classifyDelegates, classifySkills, printDriftTable, summarize } from './drift.mjs';

export function preflightSkills(repoRoot, skillNames, derivedFromPacks = []) {
  const missing = skillNames.filter((n) => !resolveSkill(repoRoot, n));
  if (!missing.length) return;
  // An unresolvable REQUIRED member is not the operator's mistake — they never named it — so it is
  // reported as what it is: the source repo's presets.yaml points at a skill that is not there.
  const required = new Set(loadRequiredSkills());
  // Same reasoning one layer over: a skill the operator never named, pulled in because a shipped
  // agent pack declares it. The defect is the pack manifest, not the command line.
  const fromPacks = new Set(derivedFromPacks);
  const brokenFloor = missing.filter((n) => required.has(n));
  const brokenPacks = missing.filter((n) => !required.has(n) && fromPacks.has(n));
  const typos = missing.filter((n) => !required.has(n) && !fromPacks.has(n));
  const lines = [];
  if (typos.length) {
    lines.push(`${typos.length} skill(s) not found in .agents/skills/ or .sidekicks/skill-offloaded/: ${typos.join(", ")}`);
  }
  if (brokenPacks.length) {
    lines.push(`${brokenPacks.length} skill(s) required by a shipped AGENT PACK are missing from this SOURCE repo: ${brokenPacks.join(", ")}`);
    lines.push("A pack declares the skills its agents need. Fix the pack's requires_skills, import the");
    lines.push("skill into this repo, or forge with --pack-skills none.");
  }
  if (brokenFloor.length) {
    lines.push(`${brokenFloor.length} REQUIRED skill(s) missing from this SOURCE repo: ${brokenFloor.join(", ")}`);
    lines.push("That is a defect in assets/presets.yaml's 'required:' block, not in your selection —");
    lines.push("fix the source repo before forging anything from it.");
  }
  lines.push("Nothing was written. List what is inheritable with the 'skills' verb.");
  die(lines.join("\n         "), 4);
}

export function inheritSkills(ctx, repoRoot, runtimeRoot, skillNames, {
  sourceCommit, manifest, verbose, reasons = {}, asCore = false,
}) {
  const avail = listAvailableSkills(repoRoot);
  const universe = new Set([...avail.active, ...avail.offloaded]);
  const inherited = [];
  const warnings = [];
  const projectionErrors = [];

  for (const name of skillNames) {
    const found = resolveSkill(repoRoot, name);
    if (!found) die(`skill not found in .agents/skills/ or .sidekicks/skill-offloaded/: ${name}`, 4);

    // The runtime projection decides what of this skill folder travels. A CORE additionally
    // requires a complete source manifest: publication needs a baseline that says which files were
    // carried on purpose, and a directory walk cannot tell that apart from a file gone missing.
    // An ordinary runtime keeps the walk fallback, which is what general skill transport relies on.
    const projection = projectSkillRuntime(found.dir, {
      skill: name,
      requireManifest: asCore,
      deny: (rel) => isDenied(rel.split("/").join(sep)),
    });
    for (const error of projection.errors) projectionErrors.push(error);

    const dst = join(runtimeRoot, '.agents', 'skills', name);
    rmSync(dst, { recursive: true, force: true });
    const files = copySkillProjection(found.dir, dst, projection);

    manifest.units[`skills/${name}`] = skillUnitRecord(repoRoot, found, dst, sourceCommit);
    if (reasons[name]?.length) {
      manifest.units[`skills/${name}`].selection_reasons = [...reasons[name]];
    }
    // Recorded so `drift` can project the SOURCE side the same way without re-deriving policy, and
    // so a release report can say what this skill left behind rather than only what it carried.
    manifest.units[`skills/${name}`].projection = {
      copied_files: projection.counts.copied_files,
      copied_bytes: projection.counts.copied_bytes,
      excluded_files: projection.counts.excluded_files,
      excluded_bytes: projection.counts.excluded_bytes,
      excluded_by_class: projection.counts.by_class,
      derived: Object.keys(projection.derived).sort(),
    };
    inherited.push({
      name, origin: found.origin, files, version: skillVersion(found.dir), projection,
    });

    // Composition warnings, strongest first: an unmet frontmatter `depends-on` is the skill's own
    // statement that it needs another skill, so it is reported separately from the substring scan.
    const unmetDeps = declaredDependencies(found.dir).filter((d) => !skillNames.includes(d));
    if (unmetDeps.length) {
      warnings.push(`${name}: UNMET declared depends-on — ${unmetDeps.join(", ")} (this skill will fail at that step)`);
    }
    // A bundled script/asset points at a skill that is not being inherited.
    // Prose-only mentions are not reported here — too noisy to be actionable.
    const refs = referencedSkills(found.dir, universe);
    const missing = refs.wired.filter((r) => !skillNames.includes(r) && !unmetDeps.includes(r));
    if (missing.length) {
      warnings.push(`${name}: a bundled script names skills not in this runtime — ${missing.join(", ")}`);
    }
    if (verbose) {
      const dropped = projection.counts.excluded_files;
      out(ctx, `  + ${name} (${found.origin}, ${files} files`
        + `${dropped ? `, ${dropped} excluded from the runtime` : ""})`);
    }
  }

  // Fail closed, and only after every skill has been examined: a forge that stopped at the first
  // problem would make the operator rediscover the next one on the next run.
  if (projectionErrors.length) {
    die(`runtime projection cannot be composed:\n         `
      + [...new Set(projectionErrors)].sort().join("\n         "), 4);
  }
  return { inherited, warnings };
}

export function copySkillProjection(srcDir, dstDir, projection) {
  let written = 0;
  for (const rel of projection.files) {
    const parts = rel.split("/");
    const dst = join(dstDir, ...parts);
    mkdirp(dirname(dst));
    if (Object.hasOwn(projection.derived, rel)) {
      writeFileSync(dst, projection.derived[rel]);
    } else {
      copyFileSync(join(srcDir, ...parts), dst);
    }
    // The recorded executability baseline is authoritative where it exists; otherwise carry the
    // source bit. A Windows checkout cannot report one, which is why `modes{}` is recorded at all.
    const recorded = projection.modes?.[rel];
    try {
      if (recorded === 755) chmodSync(dst, 0o755);
      else if (recorded === undefined) {
        const st = statSync(join(srcDir, ...parts));
        if (st.mode & 0o111) chmodSync(dst, st.mode & 0o777);
      }
    } catch { /* best effort, exactly as copyTree treats it */ }
    written += 1;
  }
  return written;
}

export function unselectedSkills(runtimeRoot, skillNames) {
  const dir = join(runtimeRoot, '.agents', 'skills');
  if (!existsSync(dir)) return [];
  const keep = new Set([...skillNames, ...loadRequiredSkills()]);
  const found = [];
  for (const e of readdirSync(dir).sort()) {
    if (keep.has(e)) continue;
    let st;
    try { st = lstatSync(join(dir, e)); } catch { continue; }
    if (st.isDirectory()) found.push(e);
  }
  return found;
}

export function pruneUnselectedSkills(runtimeRoot, manifest, skillNames) {
  const removed = unselectedSkills(runtimeRoot, skillNames);
  for (const name of removed) {
    rmSync(join(runtimeRoot, '.agents', 'skills', name), { recursive: true, force: true });
    delete manifest.units[`skills/${name}`];
  }
  return removed;
}

export function preflightDelegates(repoRoot, names) {
  const missing = names.filter((n) => !resolveDelegate(repoRoot, n));
  if (missing.length) {
    die([
      `${missing.length} delegate agent(s) not found in .sidekicks/${DELEGATES_DIRNAME}/: ${missing.join(", ")}`,
      "Nothing was written. List what is inheritable with the 'skills' verb.",
    ].join("\n         "), 4);
  }
}

export function inheritDelegates(repoRoot, runtimeRoot, names, { sourceCommit, manifest, includeMemory, skillNames }) {
  const inherited = [];
  const warnings = [];
  const surfaces = includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES;

  for (const name of names) {
    const found = resolveDelegate(repoRoot, name);
    if (!found) die(`delegate agent not found in .sidekicks/${DELEGATES_DIRNAME}/: ${name}`, 4);

    const dst = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, name);
    let files = 0;
    for (const rel of surfaces) {
      const src = join(found.dir, rel);
      if (!existsSync(src)) continue;
      const dstRel = join(dst, rel);
      rmSync(dstRel, { recursive: true, force: true });
      files += copyTree(src, dstRel);
    }

    manifest.units[`agents/${name}`] = delegateUnitRecord(repoRoot, found, dst, sourceCommit, includeMemory);
    inherited.push({ name, files, memory: Boolean(includeMemory) });

    // A charter's default_work_dir names a folder in the SOURCE repo's layout; the runtime has no
    // projects/ at all, so it resolves to nothing there.
    const wd = delegateWorkDir(found.dir);
    if (wd) {
      warnings.push(`${name}: charter default_work_dir='${wd}' points at the source repo's layout — `
        + `re-point it in the runtime with 'sidekicks agent' or clear it`);
    }
  }

  if (names.length && !skillNames.some((s) => DELEGATE_SKILL_RE.test(s))) {
    warnings.push(`${names.length} delegate agent(s) inherited but no sk-agent-* skill is `
      + `selected — the 'sidekicks agent' CLI verbs travel with lib/ and still work, but nothing `
      + `documents how to create, brief or stand them by`);
  }
  return { inherited, warnings };
}

export function unselectedDelegates(runtimeRoot, names) {
  const dir = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME);
  if (!existsSync(dir)) return [];
  const keep = new Set(names);
  const found = [];
  for (const e of readdirSync(dir).sort()) {
    if (keep.has(e) || e === BRIDGE_DIRNAME) continue;
    if (!existsSync(join(dir, e, "agent.yaml"))) continue;
    found.push(e);
  }
  return found;
}

export function pruneUnselectedDelegates(runtimeRoot, manifest, names) {
  const removed = unselectedDelegates(runtimeRoot, names);
  for (const name of removed) {
    rmSync(join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, name), { recursive: true, force: true });
    delete manifest.units[`agents/${name}`];
  }
  return removed;
}

export function reportRequirements(ctx, reqs, { indent = "  " } = {}) {
  if (reqs.pinned.length) out(ctx, `${indent}pinned from source venv: ${reqs.pinned.join(", ")}`);
  if (reqs.unpinned.length) out(ctx, `${indent}unpinned (absent from source venv): ${reqs.unpinned.join(", ")}`);
  if (!reqs.pinned.length && !reqs.unpinned.length) out(ctx, `${indent}(none — no venv needed)`);
  if (reqs.unknown.length) {
    out(ctx, `${indent}UNMAPPED imports — add them to assets/module-distribution.json or the venv will be incomplete:`);
    for (const u of reqs.unknown) out(ctx, `${indent}  ${u.module}  (seen in ${u.files.map((f) => basename(f)).join(", ")})`);
  }
}

export function cmdSkills(ctx, repoRoot) {
  const { active, offloaded } = listAvailableSkills(repoRoot);
  out(ctx, `active (${active.length}):`);
  for (const s of active) out(ctx, `  ${s}`);
  out(ctx, "");
  out(ctx, `offloaded — eligible; inheriting one reactivates it in the runtime only (${offloaded.length}):`);
  for (const s of offloaded) out(ctx, `  ${s}`);
  const delegates = listAvailableDelegates(repoRoot);
  out(ctx, "");
  out(ctx, `delegate agents — .sidekicks/${DELEGATES_DIRNAME}/, inherited only when named with `
    + `--delegates (${delegates.length}):`);
  for (const a of delegates) out(ctx, `  ${a}`);
  out(ctx, `  (charter + routines travel; memory/ only with --delegate-memory; runtime/ and .bridge/ never)`);
  const required = loadRequiredSkills();
  if (required.length) {
    out(ctx, "");
    out(ctx, `required — carried by EVERY runtime whatever you select, no flag turns it off (${required.length}):`);
    for (const s of required) out(ctx, `  ${s}`);
  }
  const presets = loadPresets();
  if (Object.keys(presets).length) {
    out(ctx, "");
    out(ctx, "presets (optional, compose freely — 'required' above is not one of them):");
    for (const [k, v] of Object.entries(presets)) {
      out(ctx, `  ${k}: ${v.skills.join(", ") || "(no skills)"}`);
      if (v.delegates.length) out(ctx, `    delegates: ${v.delegates.join(", ")}`);
    }
  }
}

export function cmdList(ctx, repoRoot) {
  const found = new Map();   // name -> { dir, known: "registry"|"runtimes/" }

  for (const [name, rec] of Object.entries(readRegistry(ctx, repoRoot))) {
    if (rec?.path_rel) found.set(name, { dir: resolve(repoRoot, rec.path_rel), known: "registry" });
  }

  const conventional = join(repoRoot, "runtimes");
  if (existsSync(conventional)) {
    for (const e of readdirSync(conventional).sort()) {
      if (!statSync(join(conventional, e), { throwIfNoEntry: false })?.isDirectory()) continue;
      if (!found.has(e)) found.set(e, { dir: join(conventional, e), known: "runtimes/" });
    }
  }

  if (!found.size) { out(ctx, "no runtimes known yet (none registered, and runtimes/ is empty or absent)"); return; }

  for (const [name, { dir, known }] of [...found.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
    const where = displayPath(repoRoot, dir);
    const outside = !isInsideRepo(repoRoot, dir) ? "  [outside the repo]" : "";
    if (!existsSync(dir)) {
      out(ctx, `${name}  ${where}  MISSING — the directory is gone (drop the entry with 'forget')`);
      continue;
    }
    const m = readManifest(dir);
    if (!m) { out(ctx, `${name}  ${where}  not an inherited runtime — no ${MANIFEST_REL}${outside}`); continue; }
    out(ctx, `${name}  ${where}${outside}`);
    const agentCount = trackedDelegates(m).length;
    out(ctx, `  skills=${trackedSkills(m).length}${agentCount ? `  delegates=${agentCount}` : ""}`
      + `  inherited-from=${m.source?.commit ?? "?"}  at=${m.source?.inherited_at ?? "?"}  (known via ${known})`);
  }
}

export function cmdForget(ctx, repoRoot, flags, positional) {
  const name = flags.name ?? positional[0];
  if (!name) die("missing runtime name (--name <n>)", 2);
  out(ctx, forgetRuntime(ctx, repoRoot, name)
    ? `forgot '${name}' — the registry entry is gone; the runtime's own files were NOT touched`
    : `'${name}' was not registered — nothing to forget`);
}

export function emitPlanJson(ctx, repoRoot, { name, dir, skills, required, reasons, packSkills, asCore, flags }) {
  const requiredSet = new Set(required);
  const byteSort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [];
  const problems = [];
  const totals = { copied_files: 0, copied_bytes: 0, excluded_files: 0, excluded_bytes: 0 };
  const excludedByClass = {};

  // Deliberately a WARNING, not a problem. `plan` writes nothing, and a caller that only wants the
  // composition (status, the bump classifier) never passes --core-version — so counting this as a
  // policy violation would make every ordinary status report one it cannot act on, which is how a
  // violations list stops being read at all.
  const warnings = [];
  if (asCore && !flags["core-version"]) {
    warnings.push("--as-core is in effect and --core-version is absent — create will refuse");
  }

  for (const skill of [...skills].sort(byteSort)) {
    const found = resolveSkill(repoRoot, skill);
    if (!found) {
      rows.push({ skill, found: false, required: requiredSet.has(skill), reasons: reasons[skill] ?? [] });
      problems.push(requiredSet.has(skill)
        ? `required skill '${skill}' is missing from the source repo — a defect in presets.yaml's required: block`
        : `selected skill '${skill}' is missing from the source repo`);
      continue;
    }
    // Projected with the SAME options the forge uses, so what this reports is what would ship.
    const projection = projectSkillRuntime(found.dir, {
      skill,
      requireManifest: asCore,
      deny: (rel) => isDenied(rel.split("/").join(sep)),
    });
    for (const error of projection.errors) problems.push(error);
    totals.copied_files += projection.counts.copied_files;
    totals.copied_bytes += projection.counts.copied_bytes;
    totals.excluded_files += projection.counts.excluded_files;
    totals.excluded_bytes += projection.counts.excluded_bytes;
    for (const [klass, counts] of Object.entries(projection.counts.by_class)) {
      if (!excludedByClass[klass]) excludedByClass[klass] = { files: 0, bytes: 0 };
      excludedByClass[klass].files += counts.files;
      excludedByClass[klass].bytes += counts.bytes;
    }
    const unmet = declaredDependencies(found.dir).filter((d) => !skills.includes(d));
    for (const dep of unmet) problems.push(`${skill} declares depends-on '${dep}', which is not selected`);
    rows.push({
      skill,
      found: true,
      origin: found.origin,
      version: skillVersion(found.dir),
      required: requiredSet.has(skill),
      reasons: [...(reasons[skill] ?? [])].sort(byteSort),
      unmet_dependencies: unmet,
      projection: {
        copied_files: projection.counts.copied_files,
        copied_bytes: projection.counts.copied_bytes,
        excluded_files: projection.counts.excluded_files,
        excluded_bytes: projection.counts.excluded_bytes,
        excluded_by_class: projection.counts.by_class,
      },
    });
  }

  const substrate = [...CORE_SURFACES, ...Object.values(OPTIONAL_SURFACES).flat(), ...CLI_WIRING, "scripts"]
    .filter((s) => existsSync(join(repoRoot, ...s.split("/"))))
    .sort(byteSort);

  ctx.write(`${JSON.stringify({
    schema: 1,
    root_structure: projectRootStructure(repoRoot, skills, {agents: !flags["no-agents"], commands: !flags["no-commands"], as_core: asCore}),
    runtime: name,
    target: displayPath(repoRoot, dir),
    target_exists: existsSync(dir),
    as_core: asCore,
    preset: csv(flags.preset).sort(byteSort),
    pack_skills: packSkills.mode,
    skills: rows,
    skill_names: [...skills].sort(byteSort),
    required_floor: [...required].sort(byteSort),
    substrate,
    agent_packs: {
      shipped: packSkills.packs,
      contributed: [...packSkills.skills].sort(byteSort),
      declared: [...packSkills.seeds].sort(byteSort),
      via_closure: [...packSkills.viaClosure].sort(byteSort),
    },
    payload: { totals, excluded_by_class: excludedByClass },
    // Named here so a consumer grading the FORGED tree does not need a second copy of the policy.
    // The publisher's composition gate reads this rather than importing the projector: a local
    // duplicate of the list is exactly the divergence one projection function exists to prevent.
    runtime_excluded_dirs: [...RUNTIME_EXCLUDED_DIRS],
    problems: [...new Set(problems)].sort(byteSort),
    warnings: [...new Set(warnings)].sort(byteSort),
  }, null, 2)}\n`);
}

export async function cmdPlan(ctx, repoRoot, flags, positional) {
  const { name, dir } = resolveRuntime(ctx, repoRoot, flags, positional);
  const { operator, required, all: selection, reasons } = resolveSkillSelection(repoRoot, flags);
  const requiredSet = new Set(required);
  const delegates = resolveDelegateSelection(repoRoot, flags);
  const includeMemory = truthyFlag(flags["delegate-memory"]);
  const asCore = truthyFlag(flags["no-as-core"])
    ? false : (truthyFlag(flags["as-core"]) || csv(flags.preset).includes("framework"));
  if (!operator.length) die("no skills selected (--skills a,b or --preset <name>; 'skills' lists both)", 2);
  const packSkills = await packSkillsFor(repoRoot, flags, asCore);
  const skills = unionPackSkills(selection, packSkills, reasons);

  // Before ANY prose. A JSON consumer parses this stream, so a warning printed above the payload is
  // not a warning to it — it is a parse error, and the caller's fallback then looks like a missing
  // engine rather than a missing flag. In JSON mode the same fact travels inside `problems`.
  if (truthyFlag(flags.json)) {
    emitPlanJson(ctx, repoRoot, { name, dir, skills, required, reasons, packSkills, asCore, flags });
    return;
  }

  // A warning, not a refusal: `plan` writes nothing, so the missing flag costs nothing here — but
  // saying it now is what stops the operator discovering it after typing out a create.
  if (asCore && !flags["core-version"]) {
    out(ctx, "WARNING: --as-core is in effect and --core-version is absent — `create` will REFUSE.");
    out(ctx, "         The core's version is its own line, not this repo's package.json version.");
    out(ctx, "");
  }

  const avail = listAvailableSkills(repoRoot);
  const universe = new Set([...avail.active, ...avail.offloaded]);

  out(ctx, `plan: runtime '${name}' -> ${displayPath(repoRoot, dir)}`);
  out(ctx, `target exists: ${existsSync(dir) ? "YES — create would refuse without --force" : "no"}`);
  out(ctx, "");
  // The floor is marked rather than listed apart, so the operator reads one skill list and can still
  // see which members they did not ask for.
  out(ctx, `skills (${skills.length}${required.length ? `, including ${required.length} required` : ""}):`);
  const dirs = [];
  const unmetDeps = [];
  for (const s of skills) {
    const f = resolveSkill(repoRoot, s);
    if (!f) {
      out(ctx, `  ${s}  NOT FOUND${requiredSet.has(s)
        ? "  [required — this is a defect in the SOURCE repo's presets.yaml, not a typo]" : ""}`);
      continue;
    }
    dirs.push(f.dir);
    const refs = referencedSkills(f.dir, universe);
    const missingDeps = declaredDependencies(f.dir).filter((d) => !skills.includes(d));
    const unsel = (r) => !skills.includes(r) && !missingDeps.includes(r);
    const wired = refs.wired.filter(unsel);
    const inComment = refs.codeComment.filter(unsel);
    const mentioned = refs.mentioned.filter(unsel);
    const floor = requiredSet.has(s) ? "  [required]" : "";
    const why = reasons[s]?.length ? `  [${reasons[s].join(", ")}]` : "";
    out(ctx, `  ${s}  ${f.origin}  v${skillVersion(f.dir) ?? "-"}${floor}${why}`);
    if (missingDeps.length) {
      out(ctx, `      MISSING DEP (declared depends-on): ${missingDeps.join(", ")}`);
      for (const d of missingDeps) unmetDeps.push(`${s} -> ${d}`);
    }
    if (wired.length) out(ctx, `      wired to (not selected): ${wired.join(", ")}`);
    if (inComment.length) out(ctx, `      named in script comments only (not selected): ${inComment.join(", ")}`);
    if (flags.verbose && mentioned.length) out(ctx, `      mentions in prose only: ${mentioned.join(", ")}`);
  }
  out(ctx, "");
  if (unmetDeps.length) {
    out(ctx, `!! ${unmetDeps.length} declared dependency(ies) unmet — the skill's own frontmatter says it needs these:`);
    for (const d of unmetDeps) out(ctx, `     ${d}`);
    out(ctx, "   Add them with --skills, or accept that the depending skill will fail at that step.");
    out(ctx, "");
  }
  if (packSkills.packs) {
    out(ctx, `agent packs: ${packSkills.packs} shipped, contributing ${packSkills.skills.length} skill(s) `
      + `to this core (--pack-skills ${packSkills.mode})`);
    if (packSkills.seeds.length) out(ctx, `  declared by the packs: ${packSkills.seeds.join(", ")}`);
    if (packSkills.viaClosure.length) {
      out(ctx, `  pulled in by those skills' own declared siblings (${packSkills.viaClosure.length}): ${packSkills.viaClosure.join(", ")}`);
    }
    if (packSkills.mode === "declared") {
      out(ctx, "  --pack-skills closure would also ship each of these skills' declared siblings;");
      out(ctx, "  --pack-skills none ships neither. Default is 'declared' — a core stays substrate.");
    }
    out(ctx, "  These are NOT part of the required floor — they are here because this core ships the packs.");
    out(ctx, "");
  }
  if (delegates.length) {
    out(ctx, `delegate agents (${delegates.length})  surface: agent.yaml + routines/`
      + `${includeMemory ? " + memory/" : " (memory/ NOT included — pass --delegate-memory)"}:`);
    for (const a of delegates) {
      const f = resolveDelegate(repoRoot, a);
      if (!f) { out(ctx, `  ${a}  NOT FOUND`); continue; }
      const wd = delegateWorkDir(f.dir);
      out(ctx, `  ${a}${wd ? `      charter default_work_dir='${wd}' — points at the source repo's layout` : ""}`);
    }
    if (!skills.some((s) => DELEGATE_SKILL_RE.test(s))) {
      out(ctx, "      NOTE: no sk-agent-* skill selected. The 'sidekicks agent' CLI verbs travel");
      out(ctx, "            with lib/ and still work, but nothing documents driving these agents.");
    }
    out(ctx, "      never copied per agent: runtime/ (presence, mailbox, threads, PIDs) and .bridge/");
    out(ctx, "            (bridge token, telegram bot_token) — both recreated locally on demand.");
    out(ctx, `      operating scripts claimed by carrying agents: ${DELEGATE_SCRIPT_FILES.join(", ")}, `
      + `${DELEGATE_SCRIPT_SUBDIRS.map((d) => `${d}/`).join(", ")}`);
    out(ctx, "");
    const staleAgents = unselectedDelegates(dir, delegates);
    if (staleAgents.length) {
      out(ctx, `already in the runtime, NOT in this delegate selection (${staleAgents.length}):`);
      for (const a of staleAgents) out(ctx, `  ${a}`);
      out(ctx, flags["prune-delegates"]
        ? "  --prune-delegates is set: 'create' would DELETE these from the runtime."
        : "  kept as-is; pass --prune-delegates to 'create' to delete them and make the set exact.");
      out(ctx, "");
    }
  }

  // Dry preview of the one destructive part of a re-forge, so it is visible before it runs.
  const stale = unselectedSkills(dir, skills);
  if (stale.length) {
    out(ctx, `already in the runtime, NOT in this selection (${stale.length}):`);
    for (const s of stale) out(ctx, `  ${s}`);
    out(ctx, flags["prune-skills"]
      ? "  --prune-skills is set: 'create' would DELETE these from the runtime."
      : "  kept as-is; pass --prune-skills to 'create' to delete them and make the set exact.");
    out(ctx, "");
  }
  out(ctx, "core substrate — copied, never linked:");
  for (const s of [...CORE_SURFACES, ...Object.values(OPTIONAL_SURFACES).flat(), ...CLI_WIRING, "scripts"]) {
    if (existsSync(join(repoRoot, ...s.split("/")))) out(ctx, `  ${s}`);
  }
  out(ctx, "");
  if (asCore) {
    const inventory = configurationInventory(repoRoot);
    out(ctx, `configuration inventory (${inventory.filter((r) => r.mode).length} safe entries; core only):`);
    for (const row of inventory) {
      if (row.mode) out(ctx, `  ${row.destination}  ${row.classification}  <- ${row.initializer_origin}`);
      else if (row.classification === 'missing-initializer') out(ctx, `  FAIL ${row.destination}  missing ${row.initializer_origin}`);
    }
    out(ctx, "");
  }
  out(ctx, "never copied (secrets / machine state / source memory):");
  out(ctx, `  ${[...DENY].sort().join(", ")}`);
  out(ctx, `  patterns: ${DENY_PATTERNS.map((re) => re.source).join(", ")}`);
  out(ctx, "");
  out(ctx, "scripts/: every safe file travels for root-structure parity; activation remains owner-aware.");
  out(ctx, "");
  out(ctx, "python requirements resolved from the selected skills' imports:");
  reportRequirements(ctx, resolveRequirements(repoRoot, dirs));
}

export async function cmdCreate(ctx, repoRoot, flags, positional) {
  const { name, dir } = resolveRuntime(ctx, repoRoot, flags, positional);
  const { operator, required, all: selection, reasons } = resolveSkillSelection(repoRoot, flags);
  const delegates = resolveDelegateSelection(repoRoot, flags);
  const includeMemory = truthyFlag(flags["delegate-memory"]);
  const presetNames = csv(flags.preset);
  const asCore = truthyFlag(flags["no-as-core"])
    ? false : (truthyFlag(flags["as-core"]) || presetNames.includes("framework"));
  // Derived from the agent packs this core is about to ship — see resolvePackSkills. Resolved
  // AFTER asCore, because an ordinary runtime ships no pack and so derives nothing.
  const packSkills = await packSkillsFor(repoRoot, flags, asCore);
  const skills = unionPackSkills(selection, packSkills, reasons);
  // Resolved HERE, before the first write: the monotonic check reads the marker the target still
  // carries, and --force is about to overwrite it. Deciding this after the forge would compare the
  // new version against itself.
  const coreVersion = asCore ? requireCoreVersion(dir, flags) : null;
  // Gated on the OPERATOR's selection, not the union: the required floor must never turn a
  // selection-less invocation into a silently forged four-skill runtime.
  if (!operator.length) die("no skills selected (--skills a,b or --preset <name>)", 2);
  if (existsSync(dir) && !flags.force) {
    die(`${displayPath(repoRoot, dir)} already exists — use 'add'/'patch' to update it, or --force to rebuild`, 3);
  }
  preflightSkills(repoRoot, skills, packSkills.skills);
  preflightDelegates(repoRoot, delegates);

  if (isInsideRepo(repoRoot, dir)) warnIfProjectScoped(ctx, repoRoot);

  const sourceCommit = gitHead(repoRoot);

  // SCAN THE DESTINATION BEFORE THE FIRST WRITE. A core is regenerated wholesale, so what is there
  // now is the only record of the release being replaced — and the copy below overwrites it. The
  // README's release-delta section is rendered from this snapshot at the end of the forge.
  const destBefore = snapshotCoreTree(dir);

  assertSafeForgeTarget(repoRoot, dir);
  assertWritableTargetBranch(dir, flags);
  mkdirp(dir);

  const manifest = {
    schema: SCHEMA,
    runtime: name,
    direction: "one-way: sidekicks source -> this runtime",
    source: {
      repo: basename(repoRoot),
      commit: sourceCommit,
      inherited_at: nowBangkok(),
      tool: "sk-publish-core",
    },
    // Recorded so later verbs (add, verify) apply the same scripts/ ownership stance.
    options: { full_scripts: true, agents: !flags["no-agents"], commands: !flags["no-commands"], as_core: asCore },
    root_structure: projectRootStructure(repoRoot, skills, {agents: !flags["no-agents"], commands: !flags["no-commands"], as_core: asCore}),
    units: {},
    configuration: [],
  };

  out(ctx, `forging runtime '${name}' at ${displayPath(repoRoot, dir)}`);
  out(ctx, "");
  out(ctx, "skills:");
  const { inherited, warnings } = inheritSkills(ctx, repoRoot, dir, skills, {
    sourceCommit, manifest, verbose: false, reasons, asCore,
  });
  for (const s of inherited) {
    const floor = required.includes(s.name) ? "  [required]" : "";
    const why = reasons[s.name]?.length ? `  [${reasons[s.name].join(", ")}]` : "";
    out(ctx, `  ${s.name}  ${s.origin}  v${s.version ?? "-"}  ${s.files} files`
      + floor + why);
  }

  // Opt-in: make the runtime's skill set EXACTLY the selection. On a --force re-forge this is what
  // removes whatever an earlier inherit left behind.
  const pruned = flags["prune-skills"] ? pruneUnselectedSkills(dir, manifest, skills) : [];
  if (pruned.length) {
    out(ctx, "");
    out(ctx, `pruned (--prune-skills — present in the runtime, not in this selection):`);
    for (const p of pruned) out(ctx, `  ${p}`);
  }

  // Delegate agents travel only when named. Their charters are hand-amended in the runtime, so each
  // one is baselined like a skill and drift-tracked the same way.
  const delegateRes = inheritDelegates(repoRoot, dir, delegates, {
    sourceCommit, manifest, includeMemory, skillNames: skills,
  });
  if (delegates.length) {
    out(ctx, "");
    out(ctx, `delegate agents (charter + routines${includeMemory ? " + memory" : ""}):`);
    for (const a of delegateRes.inherited) out(ctx, `  ${a.name}  ${a.files} files`);
    if (!includeMemory) {
      out(ctx, "  memory/ NOT inherited — an agent's memory records the SOURCE repo's decisions");
      out(ctx, "  (--delegate-memory opts in). runtime/ and .bridge/ never travel at all.");
    }
  }
  const prunedAgents = flags["prune-delegates"] ? pruneUnselectedDelegates(dir, manifest, delegates) : [];
  if (prunedAgents.length) {
    out(ctx, "");
    out(ctx, `pruned (--prune-delegates — delegate agents in the runtime, not in this selection):`);
    for (const p of prunedAgents) out(ctx, `  ${p}`);
  }

  out(ctx, "");
  out(ctx, "core substrate (copies — no link points back at the source repo):");
  for (const c of copyCoreSurfaces(repoRoot, dir, skills, {
    agents: !flags["no-agents"],
    commands: !flags["no-commands"],
    as_core: asCore,
  })) out(ctx, `  ${c}`);
  if (asCore) {
    const configSurface = copyConfigurationSurface(repoRoot, dir);
    manifest.configuration = configSurface.inventory;
    out(ctx, `  configuration (${configSurface.copied.length} safe discovered template(s))`);
    for (const row of configSurface.inventory.filter((r) => r.classification === 'missing-initializer')) {
      out(ctx, `  WARNING configuration contract incomplete: ${row.destination} needs ${row.initializer_origin}`);
    }
  }
  const scriptsRes = await copyScriptsSurface(repoRoot, dir, skills, {
    fullScripts: Boolean(flags["full-scripts"]),
    exact: true,
    hasDelegates: delegates.length > 0,
    hasSubagents: !flags["no-agents"],
  });
  out(ctx, `  scripts (${scriptsRes.copied})`);
  if (scriptsRes.skipped.length) {
    out(ctx, `  scripts skipped — no selected skill owns them (${scriptsRes.skipped.length}):`);
    out(ctx, `    ${scriptsRes.skipped.join(", ")}`);
  }

  writeRuntimeScaffold(dir, name);

  const reqs = resolveRequirements(repoRoot, skills.map((s) => join(dir, '.agents', 'skills', s)));
  const needsVenv = reqs.pinned.length > 0 || reqs.unpinned.length > 0;
  const venvResult = needsVenv
    ? buildVenv(dir, reqs, { install: !flags["no-venv"] })
    : { ok: true, installed: false, note: "no python dependency in the selected skills — no venv created" };
  // A requirements.txt left by an EARLIER forge is not evidence that this one needs Python.
  // v2.0.0 shipped `PyYAML==6.0.2` and `pytest==9.0.3` in a core whose five skills contain no .py
  // at all (F-12): a previous, larger selection had written the file and nothing ever removed it.
  // Only the generated file is removed — a hand-authored one has no engine header to match.
  const staleReq = join(dir, "requirements.txt");
  let reqPruned = false;
  if (!needsVenv && existsSync(staleReq)) {
    if (readFileSync(staleReq, "utf8").startsWith("# Generated by sk-publish-core")) {
      rmSync(staleReq, { force: true });
      reqPruned = true;
    }
  }

  writeRuntimeAgentsMd(dir, {
    name, skillNames: skills, delegateNames: delegates, sourceCommit,
    hasVenv: needsVenv && venvResult.installed,
  });
  writeInstructionMirrors(dir);

  // A runtime forged from the `framework` preset exists to BE the distributable core, so the
  // distribution files are on by default there; --as-core opts any other selection in, --no-as-core
  // out. Must run after writeRuntimeAgentsMd — AGENTS.framework.md is derived from that output.
  const coreDist = asCore
    ? writeCoreDistribution(repoRoot, dir, {
        name,
        sourceCommit,
        skillCount: skills.length,
        remote: flags.remote ? String(flags.remote) : null,
        ref: flags["core-ref"] ? String(flags["core-ref"]) : null,
        version: coreVersion,
      })
    : null;

  const droppedHooks = pruneHookWiring(dir);
  const droppedPlugins = prunePluginDeclarations(dir, loadHostPlugins());
  writeManifest(dir, manifest);

  // Self-heal the runtime's OWN exposure links and index by running its OWN CLI (Rule 3).
  const linkRes = refreshRuntimeIndex(dir);
  const fwRes = syncRuntimeFramework(dir);
  const configRes = syncRuntimeConfig(dir);
  // The example must describe THIS runtime's skills, not the source repo's whole bench.
  const cfgTrim = { dropped: [] };

  // The README goes last: it documents the release, so it can only be written once every file it
  // describes is on disk — after the hook prune, the manifest, the index rebuild and the framework
  // re-sync. Rendering it earlier reported those steps as changes on every forge.
  const readme = coreDist ? writeCoreReadme(dir, coreDist.vars, destBefore) : null;

  const git = initRuntimeGit(dir, flags.remote ? String(flags.remote) : null);
  const gitignoreTouched = isInRuntimesDir(repoRoot, dir) ? ensureSourceGitignore(repoRoot) : false;
  registerRuntime(ctx, repoRoot, name, dir);

  out(ctx, "");
  out(ctx, "python:");
  reportRequirements(ctx, reqs);
  out(ctx, `  ${venvResult.note}`);

  out(ctx, "");
  out(ctx, "generated:");
  out(ctx, "  AGENTS.md — minimal, lists only this runtime's skills");
  out(ctx, "  CLAUDE.md — mirror of AGENTS.md (Rule 6)");
  out(ctx, "  .sidekicks/settings.json, .sidekicks/memory/ — EMPTY; source memory is never inherited");
  if (delegates.length) {
    out(ctx, `  .sidekicks/${DELEGATES_DIRNAME}/ — ${delegates.length} delegate agent(s): `
      + `${delegates.join(", ")} (bring them online with 'sidekicks agent')`);
  }
  out(ctx, `  .sidekicks/config/settings/ — enable map inherited, then re-synced: ${fwRes.note}`);
  out(ctx, `  .sidekicks/config/ — inert templates for inherited skills: ${configRes.note}`);
  if (cfgTrim.dropped.length) {
    out(ctx, `  .sidekicks/config.example.yaml — trimmed to this runtime's skills; dropped `
      + `${cfgTrim.dropped.length} block(s) nothing here declares: ${cfgTrim.dropped.join(", ")}`);
  }
  out(ctx, `  .gitignore, package.json (npm test → ${RUNTIME_TEST_COMMAND})`
    + `${needsVenv ? ", requirements.txt" : " — no requirements.txt: nothing here needs Python"}`
    + `${reqPruned ? " (a stale generated requirements.txt from an earlier forge was removed)" : ""}`);
  out(ctx, `  ${MANIFEST_REL} — baseline hashes for drift detection`);
  if (coreDist) {
    out(ctx, "");
    out(ctx, "core distribution (this runtime is mountable as a framework core):");
    for (const f of coreDist.files) out(ctx, `  ${f}`);
    for (const n of coreDist.notes) out(ctx, `  NOTE: ${n}`);
    out(ctx, "  install it from a workspace with:  sh install.sh --dir <workspace>");
  }
  if (readme) {
    const d = readme.delta;
    out(ctx, "");
    out(ctx, "release delta (destination scanned BEFORE the forge; generated headers masked):");
    if (d.first) {
      out(ctx, `  first release into this destination — all ${readme.total} shipped file(s) are new`);
    } else if (!d.added.length && !d.changed.length && !d.removed.length) {
      out(ctx, `  NO shipped file changed since ${d.prevVersion ? `v${d.prevVersion}` : "the previous forge"}`
        + " — only the generated headers differ");
    } else {
      out(ctx, `  vs ${d.prevVersion ? `v${d.prevVersion}` : "the previous forge"}: `
        + `${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed`);
      for (const s of d.surfaces.slice(0, 8)) {
        out(ctx, `    ${s.surface.replace(/`/g, "")}: +${s.added} ~${s.changed} -${s.removed}`);
      }
      if (d.surfaces.length > 8) out(ctx, `    … ${d.surfaces.length - 8} more surface(s), all in the README table`);
      if (d.skillsRemoved.length) out(ctx, `    SKILLS REMOVED: ${d.skillsRemoved.join(", ")}`);
    }
    out(ctx, "  written into README.md — a consumer reads it before running 'core update'");
  }
  if (droppedHooks.length) {
    out(ctx, "");
    out(ctx, "hooks pruned (referenced a script that did not travel):");
    for (const d of droppedHooks) out(ctx, `  ${d}`);
  }
  if (droppedPlugins.length) {
    out(ctx, "");
    out(ctx, "third-party plugin declarations pruned (not in presets.yaml host_plugins:):");
    for (const d of droppedPlugins) out(ctx, `  ${d}`);
  }
  out(ctx, "");
  out(ctx, `git: ${git.initialized ? "initialized" : "already a repo"}${git.remote ? `, origin=${git.remote}` : ""}${git.note ? ` (${git.note})` : ""}`);
  out(ctx, "     nothing is committed or pushed — review, then commit in the runtime yourself");
  if (gitignoreTouched) out(ctx, "source .gitignore: added /runtimes/");
  out(ctx, `location: ${displayPath(repoRoot, dir)} — remembered as '${name}', so later verbs need only --name`);
  if (!isInsideRepo(repoRoot, dir)) {
    out(ctx, "          this target is OUTSIDE the sidekicks repo, so it is outside the free-write surface;");
    out(ctx, "          you authorized it by passing --target, and the parent repo neither tracks nor ignores it");
  }
  if (!linkRes.ok) {
    out(ctx, `WARNING: the runtime's own CLI did not run cleanly — exposure links may be missing: ${linkRes.note}`);
  }
  if (!fwRes.ok) {
    out(ctx, `WARNING: the runtime's framework enable map was not re-synced — ${fwRes.note}`);
  }
  if (!configRes.ok) {
    out(ctx, `WARNING: runtime configuration templates were not prepared — ${configRes.note}`);
  }
  if (!venvResult.ok) {
    out(ctx, `WARNING: the runtime is assembled but its Python venv is NOT usable — ${venvResult.note}`);
    ctx.exitCode = 11;
  }
  const allWarnings = [...warnings, ...delegateRes.warnings];
  if (allWarnings.length) {
    out(ctx, "");
    out(ctx, "WARNINGS:");
    for (const w of allWarnings) out(ctx, `  ${w}`);
  }
  out(ctx, "");
  out(ctx, `next: cd ${displayPath(repoRoot, dir)} && node bin/sidekicks --help`);
}

export async function cmdAdd(ctx, repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(ctx, repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(ctx, repoRoot, name, dir, source);
  // `add` names only the NEW units, so the floor is deliberately NOT unioned in here: a runtime that
  // is missing one is repaired by `patch` (drift reports it as MISSING REQUIRED), not by every `add`
  // invocation re-reporting the same six skills as "already inherited".
  const { operator: selected, reasons } = resolveSkillSelection(repoRoot, flags);
  const selectedDelegates = resolveDelegateSelection(repoRoot, flags);
  if (!selected.length && !selectedDelegates.length) {
    die("nothing selected (--skills a,b, --preset <name>, or --delegates a,b)", 2);
  }
  // `add` is additive: its selection names only the NEW units, so pruning against it would delete
  // everything already inherited. Refuse rather than reinterpret the flag into something else.
  for (const f of ["prune-skills", "prune-delegates"]) {
    if (!flags[f]) continue;
    die(`--${f} is a 'create' flag; 'add' is additive and its selection is only the new units, `
      + "so pruning against it would delete the rest of the runtime.\n"
      + `         To make the set exact, re-forge: create --force --${f}`, 2);
  }

  const already = selected.filter((s) => manifest.units[`skills/${s}`]);
  const fresh = selected.filter((s) => !manifest.units[`skills/${s}`]);
  const agentsAlready = selectedDelegates.filter((a) => manifest.units[`agents/${a}`]);
  const agentsFresh = selectedDelegates.filter((a) => !manifest.units[`agents/${a}`]);
  if (already.length) out(ctx, `already inherited — use 'patch' to update: ${already.join(", ")}`);
  if (agentsAlready.length) out(ctx, `delegate agents already inherited — use 'patch': ${agentsAlready.join(", ")}`);

  // A runtime can carry delegate agents while missing the scripts that operate them — either it was
  // forged before those scripts were claimed, or one was deleted. `patch` cannot fix it (it syncs
  // units, not the scripts surface), so an otherwise no-op `add` falls through to re-register the
  // surface instead of dead-ending on "nothing to add". Idempotent: the same claim resolution runs.
  // "Carries delegate agents" is tracked ∪ physically present, matching cmdVerify's check 10: the
  // failure verify emits must be clearable by the command it names, and an agent the manifest lost
  // (or never had) is exactly the case where verify now speaks up.
  const opsStale = presentDelegates(dir, manifest).size > 0 && [
    ...DELEGATE_SCRIPT_FILES.filter((f) => existsSync(join(repoRoot, "scripts", f))
      && !existsSync(join(dir, "scripts", f))),
    ...DELEGATE_SCRIPT_SUBDIRS.filter((d) => existsSync(join(repoRoot, "scripts", d))
      && !existsSync(join(dir, "scripts", d))),
  ].length > 0;

  if (!fresh.length && !agentsFresh.length) {
    if (!opsStale) { out(ctx, "nothing to add"); return; }
    out(ctx, "");
    out(ctx, "nothing new to inherit, but this runtime carries delegate agents without the scripts that");
    out(ctx, "operate them — re-registering the scripts surface.");
  }

  preflightSkills(repoRoot, fresh);
  preflightDelegates(repoRoot, agentsFresh);
  const sourceCommit = gitHead(repoRoot);
  const { inherited, warnings } = inheritSkills(ctx, repoRoot, dir, fresh, {
    sourceCommit, manifest, verbose: false, reasons, asCore: isCoreRuntime(dir),
  });
  if (inherited.length) out(ctx, "added:");
  for (const s of inherited) out(ctx, `  ${s.name}  ${s.origin}  v${s.version ?? "-"}  ${s.files} files`);

  // A delegate added later inherits the memory stance of THIS run, recorded per agent.
  const includeMemory = truthyFlag(flags["delegate-memory"]);
  const delegateRes = inheritDelegates(repoRoot, dir, agentsFresh, {
    sourceCommit, manifest, includeMemory,
    skillNames: [...new Set([...trackedSkills(manifest), ...fresh])],
  });
  if (agentsFresh.length) {
    out(ctx, `delegate agents added (charter + routines${includeMemory ? " + memory" : ""}):`);
    for (const a of delegateRes.inherited) out(ctx, `  ${a.name}  ${a.files} files`);
  }

  // Re-register the scripts/ surface for the FULL tracked set (AAP-111): the new skill's owned
  // scripts travel in, and its hook wiring comes back by re-copying the four per-CLI configs
  // verbatim from the source, then re-pruning whatever still has no script. Those configs are
  // inherited surface — runtime-local edits to them are overwritten here.
  const all = trackedSkills(manifest);
  // Same tracked ∪ present notion as cmdVerify's check 10 — and safe to widen here because this
  // call is made WITHOUT opts.exact, so it only ever ADDS to the scripts surface.
  const scriptsRes = await copyScriptsSurface(repoRoot, dir, all, {
    fullScripts: Boolean(manifest.options?.full_scripts),
    hasDelegates: presentDelegates(dir, manifest).size > 0,
    hasSubagents: existsSync(join(dir, ".agents", "subagents")),
  });
  for (const rel of [".claude/settings.json", ".codex/config.toml", ".agent/settings.json"]) {
    const src = join(repoRoot, ...rel.split("/"));
    if (!existsSync(src)) continue;
    const dst = join(dir, ...rel.split("/"));
    rmSync(dst, { recursive: true, force: true });
    copyTree(src, dst);
  }
  const droppedHooks = pruneHookWiring(dir);
  const droppedPlugins = prunePluginDeclarations(dir, loadHostPlugins());
  out(ctx, "");
  out(ctx, `scripts registered for the full skill set: ${scriptsRes.copied} file(s); hook wiring refreshed`);
  out(ctx, `from source across the four CLI configs (${droppedHooks.length} entr${droppedHooks.length === 1 ? "y" : "ies"} pruned — script did not travel).`);
  if (droppedPlugins.length) {
    out(ctx, `third-party plugin declarations pruned (${droppedPlugins.length}): ${droppedPlugins.join("; ")}`);
  }
  out(ctx, "NOTE: runtime-local edits to those four configs are inherited surface and were overwritten.");

  // A new skill may pull new Python dependencies.
  const reqs = resolveRequirements(repoRoot, all.map((s) => join(dir, '.agents', 'skills', s)));
  let hasVenv = existsSync(join(dir, ".venv"));
  if (reqs.pinned.length || reqs.unpinned.length) {
    const v = buildVenv(dir, reqs, { install: !flags["no-venv"] });
    out(ctx, "");
    out(ctx, "python:");
    reportRequirements(ctx, reqs);
    out(ctx, `  ${v.note}`);
    hasVenv = hasVenv || v.installed;
    if (!v.ok) ctx.exitCode = 11;   // the skill is inherited but cannot run yet — say so
  }

  writeRuntimeAgentsMd(dir, {
    name, skillNames: all, delegateNames: trackedDelegates(manifest),
    sourceCommit: manifest.source?.commit ?? sourceCommit,
    hasVenv,
  });
  writeInstructionMirrors(dir);
  writeManifest(dir, manifest);
  const idx = refreshRuntimeIndex(dir);
  // A new skill may own rules or criteria the runtime's enable map does not list yet.
  const fw = syncRuntimeFramework(dir);
  const config = syncRuntimeConfig(dir);
  out(ctx, "");
  out(ctx, `AGENTS.md regenerated with the new skill set; ${idx.note}; ${fw.note}; ${config.note}`);
  if (!config.ok) out(ctx, "WARNING: runtime configuration templates were not prepared — run config sync in the runtime before using the new skill.");
  const allWarnings = [...warnings, ...delegateRes.warnings];
  if (allWarnings.length) {
    out(ctx, "");
    out(ctx, "WARNINGS:");
    for (const w of allWarnings) out(ctx, `  ${w}`);
  }
}

export function cmdDrift(ctx, repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(ctx, repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  const rows = classifySkills(repoRoot, dir, manifest);
  const agentRows = classifyDelegates(repoRoot, dir, manifest);
  const configurationRows = classifyConfiguration(repoRoot, dir, manifest);
  const rootProblems = verifyRootStructure(dir, projectRootStructure(repoRoot, trackedSkills(manifest), manifest.options));
  const rootRows = rootProblems.map(name => ({ name, status: "conflict" }));
  const all = [...rows, ...agentRows, ...configurationRows, ...rootRows];

  if (flags.json) {
    out(ctx, JSON.stringify({
      runtime: name,
      source_commit_at_inherit: manifest.source?.commit ?? null,
      source_commit_now: gitHead(repoRoot),
      skills: rows,
      delegates: agentRows,
      configuration: configurationRows,
      root_structure: rootRows,
    }, null, 2));
    if (all.some((r) => r.status !== "up-to-date")) ctx.exitCode = 10;
    return;
  }

  out(ctx, `runtime '${name}'  inherited from ${manifest.source?.commit ?? "?"}  source now at ${gitHead(repoRoot)}`);
  out(ctx, "");
  printDriftTable(ctx, rows);
  if (agentRows.length) {
    out(ctx, "");
    out(ctx, "delegate agents (charter + routines; runtime/ state is never compared):");
    printDriftTable(ctx, agentRows);
  }
  if (configurationRows.length) {
    out(ctx, "");
    out(ctx, "generated configuration:");
    printDriftTable(ctx, configurationRows);
  }
  out(ctx, "");
  out(ctx, `summary: skills ${summarize(rows) || "nothing tracked"}`
    + `${agentRows.length ? ` · delegates ${summarize(agentRows)}` : ""}`
    + `${configurationRows.length ? ` · configuration ${summarize(configurationRows)}` : ""}`);
  const ff = all.filter((r) => r.status === "ff" || r.status === "missing-required");
  const conflict = all.filter((r) => r.status === "conflict");
  if (ff.length) out(ctx, `patchable now: ${ff.map((r) => r.name).join(", ")}`);
  if (conflict.length) out(ctx, `needs a human: ${conflict.map((r) => r.name).join(", ")} — both sides changed; patch refuses without --force`);

  // Non-zero when anything is out of date, so a caller can gate on it.
  if (all.some((r) => r.status !== "up-to-date")) ctx.exitCode = 10;
}

export function cmdPatch(ctx, repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(ctx, repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(ctx, repoRoot, name, dir, source);
  const rows = classifySkills(repoRoot, dir, manifest);
  const agentRows = classifyDelegates(repoRoot, dir, manifest);
  const configurationRows = classifyConfiguration(repoRoot, dir, manifest);
  const only = flags.only ? csv(flags.only) : null;
  const force = Boolean(flags.force);

  if (flags["dry-run"]) {
    out(ctx, `dry run — runtime '${name}'`);
    out(ctx, "");
    printDriftTable(ctx, rows);
    if (agentRows.length) {
      out(ctx, "");
      out(ctx, "delegate agents:");
      printDriftTable(ctx, agentRows);
    }
    out(ctx, "");
    const scoped = [...rows, ...agentRows].filter((r) => (only ? only.includes(r.name) : true));
    const would = scoped.filter((r) => r.status === "ff" || r.status === "missing-required"
      || (force && r.status !== "up-to-date" && r.status !== "untracked"));
    out(ctx, would.length ? `would patch: ${would.map((r) => r.name).join(", ")}` : "would patch: nothing");
    const held = scoped.filter((r) => r.status === "conflict" || r.status === "local-only");
    if (held.length && !force) out(ctx, `would hold back (runtime-side edits): ${held.map((r) => r.name).join(", ")}`);
    return;
  }

  const sourceCommit = gitHead(repoRoot);
  const skillRes = applyPatch(repoRoot, dir, manifest, rows, { force, only, sourceCommit });
  const agentRes = applyDelegatePatch(repoRoot, dir, manifest, agentRows, { force, only, sourceCommit });
  const applied = [...skillRes.applied, ...agentRes.applied];
  const refused = [...skillRes.refused, ...agentRes.refused];

  // A core's generated configuration is a release artifact, not user state. Refresh it wholesale
  // when the recorded inventory moved; ordinary runtimes have no configuration inventory at all.
  const configNeedsPatch = configurationRows.some((row) => row.status !== 'up-to-date');
  if (configNeedsPatch) {
    const surface = copyConfigurationSurface(repoRoot, dir, manifest.configuration);
    manifest.configuration = surface.inventory;
    applied.push({ name: 'configuration inventory', from: null, to: null,
      detail: `${surface.copied.length} safe entries refreshed${surface.removed.length ? `; ${surface.removed.length} obsolete entries removed` : ''}` });
    syncRuntimeFramework(dir);
    syncRuntimeConfig(dir);
  }

  if (applied.length) {
    manifest.source = { ...(manifest.source ?? {}), last_patch_commit: sourceCommit, last_patch_at: nowBangkok() };
    writeManifest(dir, manifest);
    refreshRuntimeIndex(dir);
    out(ctx, "patched:");
    for (const a of skillRes.applied) {
      out(ctx, `  ${a.name}  ${a.from ?? "-"} -> ${a.to ?? "-"}${a.backup ? `  (previous runtime copy saved to ${a.backup})` : ""}`);
    }
    for (const a of agentRes.applied) {
      out(ctx, `  ${a.name}  (delegate agent)${a.backup ? `  (previous runtime copy saved to ${a.backup})` : ""}`);
    }
    const all = trackedSkills(manifest);
    writeRuntimeAgentsMd(dir, {
      name, skillNames: all, delegateNames: trackedDelegates(manifest),
      sourceCommit, hasVenv: existsSync(join(dir, ".venv")),
    });
    // Package requirements may have shifted with the new skill versions.
    const reqs = resolveRequirements(repoRoot, all.map((s) => join(dir, '.agents', 'skills', s)));
    if (reqs.pinned.length || reqs.unpinned.length) {
      const v = buildVenv(dir, reqs, { install: !flags["no-venv"] });
      out(ctx, "");
      out(ctx, `python: ${v.note}`);
      if (reqs.unknown.length) reportRequirements(ctx, reqs);
      if (!v.ok) ctx.exitCode = 11;
    }
  } else {
    out(ctx, "patched: nothing");
  }

  if (refused.length) {
    out(ctx, "");
    out(ctx, "held back:");
    for (const r of refused) out(ctx, `  ${r.name}  ${STATUS_LABEL[r.status]}${r.detail ? `  [${r.detail}]` : ""}`);
    out(ctx, "");
    out(ctx, "A conflict means the source AND the runtime both changed since inherit. Sync is one-way, so");
    out(ctx, "the runtime's version is never promoted upstream: resolve by hand, or re-run with --force");
    out(ctx, "(the runtime copy is saved under this run's resolved folder's backups/ first — see");
    out(ctx, "`applied[].backup` above, or the pre-v2 artifacts/runs/inherit/backups/ on an older runtime).");
    ctx.exitCode = 10;
  }
}

export function cmdVenv(ctx, repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(ctx, repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  adoptIfTargeted(ctx, repoRoot, name, dir, source);
  const skills = trackedSkills(manifest);
  const reqs = resolveRequirements(repoRoot, skills.map((s) => join(dir, '.agents', 'skills', s)));

  out(ctx, `runtime '${name}' python dependencies (from ${skills.length} skill(s)):`);
  reportRequirements(ctx, reqs);
  if (flags.verbose && reqs.skipped.length) out(ctx, `  skipped: ${reqs.skipped.join(", ")}`);

  if (!reqs.pinned.length && !reqs.unpinned.length) return;
  if (flags["dry-run"]) { out(ctx, "dry run — requirements.txt not written"); return; }
  if (flags.rebuild) rmSync(join(dir, ".venv"), { recursive: true, force: true });
  const v = buildVenv(dir, reqs, { install: !flags["no-venv"], force: Boolean(flags.rebuild) });
  out(ctx, v.note);
  if (!v.ok) ctx.exitCode = 11;
}

export async function cmdVerify(ctx, repoRoot, flags, positional) {
  const { name, dir, source } = resolveRuntime(ctx, repoRoot, flags, positional);
  const manifest = requireManifest(dir, name);
  const problems = verifyRootStructure(dir, projectRootStructure(repoRoot, trackedSkills(manifest), manifest.options));
  problems.push(...verifyInstructionBodies(dir, trackedSkills(manifest)));
  const ok = [];
  if (!problems.length) ok.push("root structure parity complete — scripts, agents, ports, examples and instruction bodies match");
  const runtimeReal = realpathSync(dir);

  // 1. The no-link-back invariant: nothing inside the runtime may resolve outside it.
  const leaks = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs)) {
      if (e === ".git" || e === ".venv" || e === "node_modules") continue;
      const p = join(abs, e);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        const raw = readlinkSync(p);
        const target = isAbsolute(raw) ? raw : resolve(dirname(p), raw);
        let real = target;
        try { real = realpathSync(target); } catch { /* dangling — judge the literal target */ }
        const rel = relative(runtimeReal, resolve(real));
        if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) leaks.push(`${relative(dir, p)} -> ${real}`);
      } else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  if (leaks.length) problems.push(`links escape the runtime (would bind it to the source repo):\n          ${leaks.join("\n          ")}`);
  else ok.push("no link escapes the runtime — copies only");

  // 2. The runtime's own CLI must run.
  const cli = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "index", "show", "--json"],
    { cwd: dir, encoding: "utf8" });
  if (cli.status !== 0) problems.push(`the runtime's CLI failed: ${(cli.stderr || cli.stdout || "").trim().split("\n")[0]}`);
  else ok.push("runtime CLI runs (index show)");

  // 3. Skills must be discoverable through the runtime's own exposure link.
  if (!existsSync(join(dir, ".claude", "skills"))) {
    problems.push(".claude/skills exposure link missing — run the runtime's own CLI once to self-heal it");
  } else ok.push(".claude/skills exposure link present");

  // 3a. The REQUIRED skill floor must be physically present. Every other check here asks whether
  // what the runtime carries is coherent; this one asks whether it carries enough to be operated at
  // all — a runtime that cannot orient itself, drive a CLI verb, align scope or validate its config
  // is broken even when every file in it is internally consistent. Judged on disk rather than from
  // the manifest, because a floor skill deleted after inheriting is exactly the case worth catching.
  const requiredFloor = loadRequiredSkills();
  if (requiredFloor.length) {
    const absent = requiredFloor.filter((s) => !existsSync(join(dir, '.agents', 'skills', s, "SKILL.md")));
    if (absent.length) {
      problems.push(`required skills missing from the runtime: ${absent.join(", ")} — `
        + "restore them with 'patch --name <n>' (no --force needed) or re-forge with 'create --force'");
    } else ok.push(`all ${requiredFloor.length} required skills present`);
  }

  // 4. Hooks must reference scripts that exist in the runtime.
  const settings = join(dir, ".claude", "settings.json");
  if (existsSync(settings)) {
    const text = readFileSync(settings, "utf8");
    const missing = [...text.matchAll(/(?:scripts|\.sidekicks[/\\]hooks)[/\\][\w.-]+\.(?:mjs|sh|py|js)/g)]
      .map((m) => m[0].replace(/\\/g, "/"))
      .filter((rel) => !existsSync(join(dir, ...rel.split("/"))));
    if (missing.length) problems.push(`hooks reference scripts that did not travel: ${[...new Set(missing)].join(", ")}`);
    else ok.push("every hook script resolves inside the runtime");
  }

  // 5. Python: a declared requirement set needs the runtime's own venv behind it.
  if (existsSync(join(dir, "requirements.txt"))) {
    const declared = readFileSync(join(dir, "requirements.txt"), "utf8")
      .split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
    if (declared.length && !existsSync(join(venvBin(dir), isWindows ? "pip.exe" : "pip"))) {
      problems.push(`requirements.txt declares ${declared.length} package(s) but the runtime has no usable .venv`);
    } else if (declared.length) ok.push(`runtime has its own .venv for ${declared.length} package(s)`);
  }

  // 6. The framework enable map must be present and materialised against the runtime's own
  // registry — otherwise the runtime silently re-enables whatever the source disabled, and the
  // committed file stops showing which rules and criteria this runtime actually carries.
  // Any layout the map has shipped in counts. Canonically it is the per-kind SETTINGS files at
  // .sidekicks/config/settings/{rules,criteria,hooks}.yaml (booleans, split by kind); a runtime
  // forged from a source that has not run `framework sync --split` still carries the pre-split
  // monolith, at .sidekicks/config/framework.yaml or the older top-level path — both of which the
  // framework reader also still honours.
  const settingsPresent = ["rules", "criteria", "hooks"].some((block) =>
    existsSync(join(dir, ".sidekicks", "config", "settings", `${block}.yaml`)));
  const fwPresent = settingsPresent
    || existsSync(join(dir, ".sidekicks", "config", "framework.yaml"))
    || existsSync(join(dir, ".sidekicks", "framework.yaml"));
  if (!fwPresent) {
    problems.push(".sidekicks/config/settings/ did not travel — every rule/criterion/hook "
      + "would resolve to the built-in default, re-enabling anything the source disabled");
  } else {
    const fw = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "framework", "sync", "--check", "--json"],
      { cwd: dir, encoding: "utf8" });
    let payload = null;
    try { payload = JSON.parse(fw.stdout || "null"); } catch { /* fall through to the raw status */ }
    if (payload && payload.ok === false) {
      const missing = (payload.missing || []).join(", ");
      const unknown = (payload.unknown || []).join(", ");
      problems.push("the runtime's framework enable map is out of sync — run "
        + `'node bin/sidekicks framework sync --prune' in the runtime${missing ? `; unlisted: ${missing}` : ""}`
        + `${unknown ? `; orphaned: ${unknown}` : ""}`);
    } else if (fw.status !== 0) {
      problems.push(`framework sync --check failed in the runtime: ${(fw.stderr || fw.stdout || "").trim().split("\n")[0]}`);
    } else {
      const listed = payload ? `${payload.listed}/${payload.toggleable} entries` : "all entries";
      ok.push(`framework enable map materialised (${listed})`);
    }
  }

  // 6a. Every config block declared by a carried skill must be scaffolded in this runtime's root
  // scope. `config sync --check` is the canonical gap detector: it knows which defaults belong to
  // which installed skills and intentionally ignores live-block drift it cannot safely rewrite.
  {
    const config = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "config", "sync", "--check", "--json"],
      { cwd: dir, encoding: "utf8" });
    let payload = null;
    try { payload = JSON.parse(config.stdout || "null"); } catch { /* fall through to raw status */ }
    if (config.status !== 0) {
      const missing = payload?.scopes?.flatMap((scope) => scope.items ?? [])
        .filter((item) => item.action === "add")
        .map((item) => item.block);
      problems.push("runtime configuration templates are incomplete — run "
        + `'node bin/sidekicks config sync' in the runtime${missing?.length ? `; missing: ${missing.join(", ")}` : ""}`);
    } else {
      const documented = payload?.totals?.skip ?? 0;
      ok.push(`configuration templates materialised for inherited skills (${documented} existing scaffold(s))`);
    }
  }

  // 6b. A framework core has an additional, source-independent configuration contract.
  // The manifest records the exact safe inventory that was forged, so verify can detect a
  // removed template or a value that was replaced with an unsafe source-side canonical file.
  if (Array.isArray(manifest.configuration) && manifest.configuration.length) {
    const missingInitializers = manifest.configuration.filter((row) => row.classification === 'missing-initializer');
    for (const row of missingInitializers) {
      problems.push(`configuration contract incomplete: ${row.destination} needs safe initializer ${row.initializer_origin}`);
    }
    const mismatched = [];
    for (const row of manifest.configuration) {
      // Settings and framework.yaml are deliberately reconciled by the forged runtime's
      // own registry, so their safe source establishes presence, not byte identity.
      if (!row.mode || !row.hash || row.classification === 'settings'
        || row.destination === '.sidekicks/config/framework.yaml') continue;
      const path = join(dir, ...row.destination.split('/'));
      if (!existsSync(path)) { mismatched.push(`${row.destination} missing`); continue; }
      if (hashFile(path) !== row.hash) mismatched.push(`${row.destination} differs from its safe initializer`);
    }
    if (mismatched.length) problems.push(`generated configuration inventory mismatch: ${mismatched.join(', ')}`);
    else if (!missingInitializers.length) ok.push(`safe configuration inventory complete (${manifest.configuration.filter((row) => row.mode).length} entries)`);
  }

  // 7. No machine-absolute path may be persisted in the manifest (portable-paths rule).
  const rawManifest = readFileSync(manifestPath(dir), "utf8");
  if (/"[A-Za-z]:\\\\|"\/(?:Users|home)\//.test(rawManifest)) {
    problems.push("the manifest contains a machine-absolute path — it must stay portable");
  } else ok.push("manifest paths are portable");

  // 8. A runtime forged --as-core must carry the whole distribution, not part of it. A core missing
  //    its marker is the worst case: it mounts, looks fine, and silently captures the root from every
  //    hook — so this is checked rather than assumed.
  if (existsSync(join(dir, CORE_MARKER_REL))) {
    let marker = null;
    try { marker = JSON.parse(readFileSync(join(dir, CORE_MARKER_REL), "utf8")); } catch { /* below */ }
    if (!marker || marker.schema !== 1 || !marker.version) {
      problems.push(`${CORE_MARKER_REL} is unparseable or missing schema/version — a workspace cannot pin it`);
    } else ok.push(`core marker present (v${marker.version}, layout ${marker.layout})`);

    // The instruction doc is checked under EITHER name: a core forged before the rename carries
    // CLAUDE.framework.md, and it is a healthy core — the consumer-side readers accept both.
    const instructionDoc = [CORE_INSTRUCTION_DOC, CORE_INSTRUCTION_DOC_LEGACY]
      .find((f) => existsSync(join(dir, f))) || null;
    const missing = ["install.sh", "install.ps1", "README.md"]
      .filter((f) => !existsSync(join(dir, f)));
    if (!instructionDoc) missing.push(CORE_INSTRUCTION_DOC);
    for (const f of missing) problems.push(`core distribution is incomplete — ${f} is missing`);
    if (!missing.length) {
      ok.push(`core distribution complete (install.sh, install.ps1, README.md, ${instructionDoc})`);
    }

    const installSh = join(dir, "install.sh");
    if (existsSync(installSh)) {
      const text = readFileSync(installSh, "utf8");
      if (text.includes("{{")) problems.push("install.sh still contains an unsubstituted {{PLACEHOLDER}}");
      else if (!text.includes(CORE_MOUNT_DIR)) problems.push(`install.sh does not mount at ${CORE_MOUNT_DIR}`);
      else ok.push("install.sh is fully rendered and mounts at the expected path");
    }

    // 8a. Agent packs, when the core carries any. Same failure class as the distribution files: a
    //     pack that ships broken looks like a pack that shipped, and the consumer only finds out
    //     when `agent pack install` refuses on their machine. The check is CONDITIONAL because a
    //     core carrying no packs is legitimate — but a directory that exists and holds nothing
    //     installable is not, since that is what a copy that silently dropped its payload looks like.
    const packsDir = join(dir, CORE_PACKS_REL);
    if (existsSync(packsDir)) {
      const count = countAgentPacks(packsDir);
      if (count === 0) {
        problems.push(`${CORE_PACKS_REL}/ is present but holds no pack — a shipped packs directory must carry at least one`);
      } else {
        const packProblems = verifyAgentPacks(dir, packsDir);
        if (packProblems.length) problems.push(...packProblems);
        else ok.push(`agent packs valid (${count} pack(s), manifests and charters parse and are portable)`);
      }
    }
  }

  // 8b. THE INSTRUCTION-SURFACE CONTRACT. Every framework-core rule and criterion must either be
  //     STATED in the generated instruction surface or be DECLARED not carried and turned off.
  //
  //     This is the check whose absence let a lightweight core ship without seven safety-floor
  //     rules — Teleport-only production access, the cluster-ops prod hard stop, headful Google
  //     automation, outward-action confirmation, secret-manifest placement, forced-worktree consent,
  //     and the autonomous-auditor floor — while `framework doctor` and `framework show` both
  //     reported them healthy, because `body_at` named a file that existed rather than prose that
  //     did. Runs against the FORGED artifact, which is the thing a consumer actually mounts.
  {
    const surfaces = ["AGENTS.md", CORE_INSTRUCTION_DOC, CORE_INSTRUCTION_DOC_LEGACY]
      .map((f) => join(dir, f))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"));
    if (!surfaces.length) {
      problems.push("the runtime has no AGENTS.md — nothing states the rules it claims to follow");
    } else {
      const declaredOff = new Set(CORE_RULES_NOT_IN_RUNTIME_INSTRUCTIONS);
      const coreRules = runtimeCoreRules(dir);
      if (!coreRules) {
        problems.push("could not read the runtime's framework registry — the instruction-surface "
          + "contract could not be checked (run the runtime's own `framework list --json`)");
      }
      for (const rule of coreRules || []) {
        const floor = rule.floor;
        if (declaredOff.has(rule.id) && floor) {
          // Belt and braces: resolve.mjs already refuses a floor id in any settings layer, and
          // `framework disable` refuses one outright. Assert it here too, because the guarantee is
          // enforced at a distance and this list is where someone would try to reach past it.
          problems.push(`${rule.id} is a SAFETY-FLOOR rule and may never be declared uncarried`);
          continue;
        }
        if (!rule.body_marker) {
          problems.push(`${rule.id} is a framework-core rule with no body marker — nothing can prove `
            + "its prose survived the forge (add `marker:` in lib/framework-settings/core-registry.mjs)");
          continue;
        }
        if (surfaces.some((t) => t.includes(rule.body_marker))) continue;
        if (!declaredOff.has(rule.id)) {
          problems.push(
            `${rule.id} is registered${floor ? " as a SAFETY-FLOOR rule" : ""} but its body is absent `
            + `from the runtime instructions (marker: "${rule.body_marker}") — state it in `
            + "assets/AGENTS.min.md.tmpl, or (non-floor only) declare it in "
            + "CORE_SETTINGS_SHIPPED_OFF with `notStated: true` and a reason"
          );
        } else if (rule.enabled) {
          problems.push(
            `${rule.id} is declared uncarried but the runtime's enable map still has it ON — the `
            + "runtime would claim a rule it never states"
          );
        }
      }
      if (coreRules && !problems.length) {
        const stated = coreRules.length - declaredOff.size;
        ok.push(`instruction surface states every framework-core rule (${stated} stated, ${declaredOff.size} declared uncarried and off)`);
      }
    }
  }

  // 8b. THE ENABLE MAP IS A DECLARED DEFAULT — every toggleable entry ships ON unless a reason says
  //     otherwise. Before this gate the forge copied the source repo's working-tree toggles, so
  //     v1.4.4 shipped `hook.enforce-branch-safety: false` — the hook that enforces a rule the same
  //     tarball calls hard — and nothing anywhere said so (INC-2026-09-06-06 B-1). Two escapes, both
  //     narrow and both stated: an id DECLARED in CORE_SETTINGS_SHIPPED_OFF with a reason, and a hook
  //     whose owning skills verifiably did not travel.
  {
    const toggleable = runtimeToggleableEntries(dir);
    if (!toggleable) {
      problems.push("could not read the runtime's framework registry — the enable-map default "
        + "contract could not be checked (run the runtime's own `framework list --json`)");
    } else {
      const undeclared = toggleable.filter((e) => !e.enabled
        && !CORE_SETTINGS_SHIPPED_OFF[e.id]
        && !(e.kind === "hook" && e.owner_absent));
      for (const e of undeclared) {
        problems.push(
          `${e.id} ships DISABLED with no declared reason — a consumer would get the framework's own `
          + "default silently switched off. Name it in CORE_SETTINGS_SHIPPED_OFF with a reason, or "
          + "let normalizeRuntimeEnableMap write it ON"
        );
      }
      if (!undeclared.length) {
        const off = toggleable.filter((e) => !e.enabled).length;
        ok.push(`enable map is a declared default (${toggleable.length - off} on, ${off} off with a stated reason)`);
      }
    }
  }

  // 8c. NO PLUGIN DECLARATION THE ALLOW-LIST DOES NOT NAME. The wiring is copied wholesale, so
  //     without this the source author's personal plugin set rides into every consumer and
  //     `sk-hello --apply` installs it non-interactively (INC-2026-09-06-06 B-5). Checked against the
  //     forged artifact so a hand-edited wiring file cannot slip past the forge-time prune.
  {
    const allowed = new Set(loadHostPlugins());
    const allowedMarkets = new Set([...allowed].map((id) => id.split("@")[1]).filter(Boolean));
    const before = problems.length;
    for (const relConfig of [".claude/settings.json", ".agent/settings.json"]) {
      const p = join(dir, ...relConfig.split("/"));
      if (!existsSync(p)) continue;
      let cfg;
      try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
      for (const id of Object.keys(cfg.enabledPlugins ?? {})) {
        if (allowed.has(id)) continue;
        problems.push(`${relConfig} declares the third-party plugin '${id}', which assets/presets.yaml `
          + "host_plugins: does not allow — a consumer would inherit it, and `sk-hello --apply` "
          + "installs every declared plugin without asking");
      }
      for (const name of Object.keys(cfg.extraKnownMarketplaces ?? {})) {
        if (allowedMarkets.has(name)) continue;
        problems.push(`${relConfig} declares the marketplace '${name}', which no allowed plugin needs`);
      }
    }
    // Only when nothing was found: an `ok` printed beside a `FAIL` about the same thing reads as a
    // contradiction, and this gate exists to be believed.
    if (allowed.size && problems.length === before) {
      ok.push(`third-party plugin declarations limited to the allow-list (${[...allowed].join(", ")})`);
    }
  }

  // "The runtime holds agents" — tracked ∪ physically present. Hoisted above checks 9 and 10 so
  // both halves of cmdVerify answer that question the same way: check 9 uses it to justify the
  // operating scripts a runtime ships, check 10 to demand them. Gating check 10 on the manifest
  // alone let a `create --force` that omits --delegates strip those scripts from a runtime whose
  // charters are still on disk, and report clean.
  const agentsPresent = presentDelegates(dir, manifest);

  // 9. Scripts-payload ownership (AAP-111): the runtime must ship no scripts/ entry nothing owns,
  //    and no hook script whose every owner skill is absent — the two defects the v1.1.0 core had.
  //    "Present" = tracked by the manifest ∪ physically present (an operator-added skill counts).
  {
    const present = new Set(trackedSkills(manifest));
    const skillsDir = join(dir, '.agents', 'skills');
    if (existsSync(skillsDir)) {
      for (const e of readdirSync(skillsDir).sort()) {
        if (existsSync(join(skillsDir, e, "SKILL.md"))) present.add(e);
      }
    }
    const ownership = await resolveScriptOwnership(repoRoot, [...present], {
      hasDelegates: agentsPresent.size > 0,
      hasSubagents: existsSync(join(dir, ".agents", "subagents")),
    });
    const fullScripts = true; // dormant scripts travel; wiring still requires an owner

    // 9a — every shipped scripts/ entry is claimed by something present.
    const unclaimed = [];
    const scriptsDir = join(dir, "scripts");
    if (existsSync(scriptsDir)) {
      for (const e of readdirSync(scriptsDir).sort()) {
        let st;
        try { st = lstatSync(join(scriptsDir, e)); } catch { continue; }
        if (st.isDirectory()) {
          const owners = SCRIPT_SUBDIR_OWNERS[e];
          const claimed = ownership.subdirs.has(e)
            || Boolean(owners && owners.some((o) => present.has(o)));
          if (!claimed) unclaimed.push(`${e}/`);
        } else if (!ownership.files.has(e)) {
          unclaimed.push(e);
        }
      }
    }
    if (!unclaimed.length) {
      ok.push("every shipped scripts/ entry is owned by the framework floor or a present skill");
    } else if (fullScripts) {
      ok.push(`scripts/ carries ${unclaimed.length} unowned entr(ies) — permitted, forged with --full-scripts: ${unclaimed.join(", ")}`);
    } else {
      problems.push(`scripts/ ships unclaimed entr(ies) — no present skill or framework hook owns: ${unclaimed.join(", ")}`);
    }

    // 9b — an orphan-owned hook (every owner absent) must ship neither script nor wiring.
    const orphanShipped = [...ownership.orphanHookScripts].filter((f) => existsSync(join(scriptsDir, f)));
    const orphanWired = [];
    for (const rel of [".claude/settings.json", ".codex/config.toml", ".agent/settings.json"]) {
      const p = join(dir, ...rel.split("/"));
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      for (const f of ownership.orphanHookScripts) {
        if (text.includes(f)) orphanWired.push(`${rel}: ${f}`);
      }
    }
    if (orphanShipped.length && !fullScripts) {
      problems.push(`hook script(s) shipped although every owner skill is absent: ${orphanShipped.join(", ")}`);
    }
    if (orphanWired.length) {
      problems.push(`hook wiring references script(s) of absent-owner hooks: ${orphanWired.join(", ")}`);
    }
    if (!orphanWired.length) {
      ok.push("no hook whose owner skills are all absent has active wiring; dormant scripts travel");
    }
  }

  // 9c — the same question for AGENTS and COMMANDS, on every CLI (INC-2026-09-04-02, N-4).
  //
  // Nothing asked it, so the published core shipped 37 `/bmad:*` commands loading a bmad/ tree it
  // does not carry, 16 Codex agents and 4 Claude agent packs for skills it does not carry, and 14
  // host command stubs the forge was not even aware of. Every one of those is a consumer-visible
  // defect that no consumer can fix, because the payload is the framework's.
  {
    // "Present" the same way 9 defines it: tracked by the manifest, or physically in the runtime.
    const present = new Set(trackedSkills(manifest));
    const skillsDir = join(dir, '.agents', 'skills');
    if (existsSync(skillsDir)) {
      for (const e of readdirSync(skillsDir).sort()) {
        if (existsSync(join(skillsDir, e, "SKILL.md"))) present.add(e);
      }
    }
    const families = ownedFamilies([...present]);
    const strays = [];
    const walk = (absDir, relBase, surface) => {
      let entries;
      try { entries = readdirSync(absDir); } catch { return; }
      for (const entry of entries.sort()) {
        const rel = relBase ? join(relBase, entry) : entry;
        const family = surfaceFamily(rel);
        if (family !== null && !families.has(family)) { strays.push(`${surface}/${rel}`); continue; }
        let st;
        try { st = lstatSync(join(absDir, entry)); } catch { continue; }
        if (st.isDirectory()) walk(join(absDir, entry), rel, surface);
      }
    };
    for (const surface of OPTIONAL_SURFACES.commands) {
      const abs = join(dir, ...surface.split("/"));
      if (existsSync(abs)) walk(abs, "", surface);
    }
    if (strays.length) {
      problems.push(`agent/command path(s) shipped for a family no present skill owns — every one of `
        + `them fails at first use, in every consumer's menu: ${strays.slice(0, 8).join(", ")}`
        + (strays.length > 8 ? ` … and ${strays.length - 8} more` : ""));
    } else {
      ok.push("every shipped agent and command belongs to the framework floor or a present skill");
    }
  }

  // 10. The agent bridge must NOT be here. .sidekicks/agents/.bridge/ holds the bridge token and
  //     the Telegram bot_token/chat_id — same safety class as .sidekicks/config.yaml — plus PID
  //     files that would make the runtime claim another machine's daemons are alive. It is
  //     recreated on demand by lib/agent-lifecycle/_bridge.mjs, so its presence here can only mean
  //     it was copied in.
  {
    const bridge = join(dir, ".sidekicks", DELEGATES_DIRNAME, BRIDGE_DIRNAME);
    if (existsSync(bridge)) {
      problems.push(`.sidekicks/${DELEGATES_DIRNAME}/${BRIDGE_DIRNAME}/ is present — it carries the `
        + "bridge token and Telegram credentials and must never travel; delete it (the runtime "
        + "recreates its own on first use)");
    } else ok.push("no agent bridge inherited — no bridge token or Telegram credential travelled");

    // A tracked delegate whose charter is gone cannot be stood by; report it here too so `verify`
    // alone is enough to trust the runtime (drift reports it as MISSING IN RUNTIME).
    const gone = trackedDelegates(manifest)
      .filter((a) => !existsSync(join(dir, ".sidekicks", DELEGATES_DIRNAME, a, "agent.yaml")));
    if (gone.length) {
      problems.push(`delegate agent(s) recorded in the manifest but absent from the runtime: ${gone.join(", ")}`);
    } else if (trackedDelegates(manifest).length) {
      ok.push(`${trackedDelegates(manifest).length} inherited delegate agent(s) present with a charter`);
    }

    // A runtime that carries agents must carry the scripts that START and SUPERVISE them —
    // otherwise `agent start --headless` works but nothing survives a logout and no tray can open.
    // Claimed by the agents, so their absence means either a pre-delegate forge or a deletion.
    // "Carries agents" is the same tracked ∪ present notion check 9 uses to JUSTIFY those scripts:
    // an agent on disk that the manifest lost (a --force re-forge without --delegates) or never had
    // (created inside the runtime) still needs them.
    if (agentsPresent.size) {
      const missingOps = [
        ...DELEGATE_SCRIPT_FILES.filter((f) => existsSync(join(repoRoot, "scripts", f))
          && !existsSync(join(dir, "scripts", f))),
        ...DELEGATE_SCRIPT_SUBDIRS.filter((d) => existsSync(join(repoRoot, "scripts", d))
          && !existsSync(join(dir, "scripts", d))).map((d) => `${d}/`),
      ];
      if (missingOps.length) {
        problems.push(`the runtime carries delegate agents but not the scripts that operate them: `
          + `${missingOps.join(", ")} — re-register the surface with 'add --name <n> --delegates <a>' `
          + "or re-forge with 'create --force'");
      } else {
        ok.push(`delegate operating scripts present (${DELEGATE_SCRIPT_FILES.join(", ")}, `
          + `${DELEGATE_SCRIPT_SUBDIRS.map((d) => `${d}/`).join(", ")})`);
      }
    }
  }

  // 11. THE TEST GATE MUST BE REAL (F-05). `npm test` in the v2.0.0 core ran
  //     `node --test 'tests/**/*.test.mjs'` against a runtime with no top-level tests/: Node 22
  //     expanded the glob to nothing, ran zero tests, and EXITED 0. The publisher and the
  //     test-gate skill both read that as a pass while the artifact's 89 real tests — under
  //     lib/artifacts-lifecycle/tests/ — were never loaded. So verify asks three things of the
  //     shipped gate: that package.json invokes the launcher, that the launcher travelled, and
  //     that running its discovery finds at least one file.
  {
    const pkgPath = join(dir, "package.json");
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgPath, "utf8")); } catch { /* reported below */ }
    const cmd = pkg?.scripts?.test ?? null;
    const launcher = join(dir, ...RUNTIME_TEST_SCRIPT.split("/"));

    if (!pkg) {
      problems.push("package.json is missing or unparseable — the runtime has no declared test gate");
    } else if (cmd !== RUNTIME_TEST_COMMAND) {
      problems.push(`package.json test is ${JSON.stringify(cmd)}, not ${JSON.stringify(RUNTIME_TEST_COMMAND)} — `
        + "a bare `node --test <glob>` reports a PASS on zero discovered tests (re-forge to repair it)");
    } else if (!existsSync(launcher)) {
      problems.push(`package.json runs ${RUNTIME_TEST_SCRIPT} but that file did not travel — `
        + "`npm test` in this runtime cannot start");
    } else {
      const disc = spawnSync(process.execPath, [launcher, "--list", "--json"],
        { cwd: dir, encoding: "utf8" });
      let payload = null;
      try { payload = JSON.parse(disc.stdout || "null"); } catch { /* below */ }
      if (!payload) {
        problems.push(`${RUNTIME_TEST_SCRIPT} did not report its discovery: `
          + `${(disc.stderr || disc.stdout || "").trim().split("\n")[0] || `exit ${disc.status}`}`);
      } else if (!payload.count) {
        problems.push("the runtime's test gate discovers NO test files — `npm test` would be a "
          + "runner failure, and any gate that reads it as a pass is reporting false confidence");
      } else {
        ok.push(`test gate real: ${RUNTIME_TEST_SCRIPT} discovers ${payload.count} file(s) `
          + `under ${(payload.roots || []).join(", ")}`);
      }
    }
  }

  for (const o of ok) out(ctx, `  ok    ${o}`);
  for (const p of problems) out(ctx, `  FAIL  ${p}`);
  out(ctx, "");
  out(ctx, problems.length ? `verify: ${problems.length} problem(s)` : "verify: clean");
  if (problems.length) ctx.exitCode = 12;
}

/** Call-scoped output and exit status; importing this module never executes a command. */
export function assertWritableTargetBranch(dir, flags = {}) {
  if (flags['allow-protected'] === true) return;
  let existing = resolve(dir);
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const top = spawnSync('git', ['-C', existing, 'rev-parse', '--show-toplevel'], {encoding:'utf8'});
  if (top.status !== 0) return;
  const root = top.stdout.trim();
  const rel = relative(root, resolve(dir));
  // Ignored disposable candidate trees cannot intentionally modify the enclosing repository.
  if (rel && spawnSync('git', ['-C', root, 'check-ignore', '-q', rel], {encoding:'utf8'}).status === 0) return;
  const branch = spawnSync('git', ['-C', root, 'branch', '--show-current'], {encoding:'utf8'}).stdout?.trim();
  if (/^(main|sit|uat|staging|prod|release\/.*)$/.test(branch ?? ''))
    throw new CoreForgeError(`forge target is owned by protected branch '${branch}'; use a work branch or --allow-protected only with named direct-write authorization`, 2);
}

export async function runProjection(repoRoot, verb, flags = {}, positional = []) {
  const ctx = { stdout: '', stderr: '', exitCode: 0 };
  ctx.write = text => { ctx.stdout += String(text); };
  ctx.warn = text => { ctx.stderr += String(text); };
  try {
    flags = { ...flags };
    if (flags.version && !flags['core-version']) flags['core-version'] = flags.version;
    if (['forge','create'].includes(verb) && flags['dry-run']) verb = 'plan';
    if (['forge','create'].includes(verb) && coreDirOf(repoRoot)) {
      throw new CoreForgeError('core forge refuses a mounted consumer workspace; forge from a standalone core checkout instead', 2);
    }
    const commands = { skills: cmdSkills, list: cmdList, plan: cmdPlan, forge: cmdCreate,
      create: cmdCreate, add: cmdAdd, drift: cmdDrift, check: cmdDrift, patch: cmdPatch,
      venv: cmdVenv, verify: cmdVerify, forget: cmdForget };
    const command = commands[verb];
    if (!command) throw new CoreForgeError('unknown projection operation: '+verb, 2);
    await command(ctx, repoRoot, flags, positional);
  } catch (error) {
    if (!(error instanceof CoreForgeError)) throw error;
    ctx.stderr += 'core: '+error.message+'\n';
    ctx.exitCode = error.exitCode;
  }
  let payload;
  if (flags.json) { try { payload = JSON.parse(ctx.stdout); } catch {} }
  return { stdout: ctx.stdout, stderr: ctx.stderr, exitCode: ctx.exitCode, ...(payload === undefined ? {} : { payload }) };
}
