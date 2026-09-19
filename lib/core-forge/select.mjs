// Sidekicks core forge — select. Zero runtime dependencies.
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync,
  statSync, lstatSync, realpathSync, readlinkSync, rmSync, symlinkSync, chmodSync,
  renameSync, openSync, closeSync,
} from "node:fs";
import { join, dirname, relative, resolve, basename, sep, isAbsolute } from "node:path";
import path from 'node:path';
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
import { ASSETS, CLI_WIRING, CORE_SURFACES, OPTIONAL_SURFACES, CORE_PACKS_REL, HOST_PLUGINS_KEY, PACK_MANIFEST_NAME, REQUIRED_KEY, die, displayPath, listAvailableDelegates, out } from './_shared.mjs';
import { isInsideRepo, lookupRuntime } from './registry.mjs';

export function verifyAgentPacks(dir, packsDir) {
  const r = spawnSync(process.execPath, [join(dir, "bin", "sidekicks"), "agent", "pack", "list", "--json"],
    { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) {
    const first = String(r.stderr || r.stdout || "").trim().split("\n")[0];
    return [`the core cannot read its own agent packs — 'agent pack list' failed: ${first}`];
  }
  let payload = null;
  try { payload = JSON.parse(r.stdout || "null"); } catch { /* below */ }
  if (!payload || !Array.isArray(payload.packs)) {
    return ["'agent pack list --json' produced no readable payload in the forged core"];
  }
  const onDisk = countAgentPacks(packsDir);
  if (payload.packs.length !== onDisk) {
    return [`${CORE_PACKS_REL}/ holds ${onDisk} pack(s) but the core discovers ${payload.packs.length}`
      + " — a pack that cannot be discovered has shipped invisibly"];
  }
  const problems = [];
  for (const p of payload.packs) {
    if (p.state !== "invalid") continue;
    const why = (p.errors || []).join("; ") || "no reason reported";
    problems.push(`agent pack '${p.id}' is invalid in the forged core — ${why}`);
  }
  return problems;
}

export async function resolvePackSkills(repoRoot) {
  const empty = { skills: [], packs: 0, seeds: [], viaClosure: [] };
  const packsDir = join(repoRoot, CORE_PACKS_REL);
  if (!existsSync(packsDir) || countAgentPacks(packsDir) === 0) return empty;

  let discoverPacks, skillClosure;
  try {
    ({ discoverPacks } = await import(pathToFileURL(join(repoRoot, "lib", "agent-lifecycle", "_pack.mjs")).href));
    ({ skillClosure } = await import(pathToFileURL(join(repoRoot, "lib", "skill-package", "closure.mjs")).href));
  } catch (e) {
    die(`cannot resolve agent-pack skills — the source repo's lib/ did not load: ${e.message}`, 3);
  }

  const packs = discoverPacks(repoRoot);
  const seeds = new Set();
  // Which pack asked for each seed, so a skill that only travels because a pack named it can say
  // so. Without this, pack-derived skills were the ONLY selection with no recorded reason — and
  // they are precisely the ones nobody named on the command line, so they are the hardest to
  // justify six months later. The publisher was inventing an 'agent-pack' label from the ABSENCE
  // of a reason, which meant the release log and .sidekicks/inherit.json disagreed.
  const seedOwners = new Map();
  const noteOwner = (skill, reason) => {
    if (!seedOwners.has(skill)) seedOwners.set(skill, new Set());
    seedOwners.get(skill).add(reason);
  };
  for (const pack of packs) {
    if (!pack.manifest) continue;
    for (const dep of pack.manifest.requires_skills) {
      // A REQUIRED row always travels. An OPTIONAL one travels when the source repo has it: the
      // pack says what is lost without it, so shipping it when we can is free, and omitting it when
      // we cannot is exactly the documented degraded install rather than a broken core.
      if (dep.required || resolveSkill(repoRoot, dep.name)) {
        seeds.add(dep.name);
        noteOwner(dep.name, `agent-pack:${pack.id}:declared`);
      }
    }
  }
  if (!seeds.size) return { ...empty, packs: packs.length };

  const seedList = [...seeds].sort();
  let all = seedList;
  try {
    const closure = skillClosure(repoRoot, seedList, { scope: "runtime" });
    all = [...new Set([...seedList, ...closure.selected.map((x) => x.skill)])].sort();
    for (const row of closure.selected) {
      if (seeds.has(row.skill)) continue;
      // `via` names every requester the walk passed through, so the reason says which declared seed
      // dragged this one in rather than only that a pack did.
      for (const parent of row.via?.length ? row.via : ["unknown"]) {
        noteOwner(row.skill, `agent-pack:closure:${parent}`);
      }
    }
  } catch { /* a closure that cannot run must not lose the declared seeds */ }
  const reasons = {};
  for (const skill of [...seedOwners.keys()].sort()) reasons[skill] = [...seedOwners.get(skill)].sort();
  return {
    skills: all,
    packs: packs.length,
    seeds: seedList,
    viaClosure: all.filter((n) => !seeds.has(n)),
    reasons,
  };
}

export function countAgentPacks(packsDir) {
  let entries;
  try { entries = readdirSync(packsDir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (existsSync(join(packsDir, e.name, PACK_MANIFEST_NAME))) n += 1;
  }
  return n;
}

export function resolveSkill(repoRoot, name) {
  const active = join(repoRoot, '.agents', 'skills', name);
  if (existsSync(join(active, "SKILL.md"))) return { name, dir: active, origin: "active" };
  const off = join(repoRoot, ".sidekicks", "skill-offloaded", name);
  if (existsSync(join(off, "SKILL.md"))) return { name, dir: off, origin: "offloaded" };
  return null;
}

export function listAvailableSkills(repoRoot) {
  const res = { active: [], offloaded: [] };
  for (const [key, sub] of [["active", "skills"], ["offloaded", "skill-offloaded"]]) {
    const dir = join(repoRoot, ".sidekicks", sub);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir).sort()) {
      if (existsSync(join(dir, e, "SKILL.md"))) res[key].push(e);
    }
  }
  return res;
}

export function skillVersion(skillDir) {
  const vf = join(skillDir, "VERSION.json");
  if (!existsSync(vf)) return null;
  try { return JSON.parse(readFileSync(vf, "utf8")).version ?? null; } catch { return null; }
}

export function declaredDependencies(skillDir) {
  const f = join(skillDir, "SKILL.md");
  if (!existsSync(f)) return [];
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return []; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return [];

  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*depends-on:\s*$/.test(l));
  if (start === -1) return [];

  const deps = [];
  for (let i = start + 1; i < lines.length; i++) {
    const item = /^\s*-\s*(?:skill:)?([A-Za-z0-9._-]+)\s*$/.exec(lines[i]);
    if (!item) break;                      // list ends at the first non-item line
    if (item[1] !== "sidekicks") deps.push(item[1]);
  }
  return [...new Set(deps)].sort();
}

export function stripComments(text, file) {
  if (/\.py$/i.test(file)) {
    return text
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, " ")
      .replace(/(^|\s)#[^\n]*/g, "$1");
  }
  if (/\.(mjs|js|ts|json)$/i.test(file)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  }
  if (/\.(sh|ya?ml|toml)$/i.test(file)) {
    return text.replace(/(^|\s)#[^\n]*/g, "$1");
  }
  return text;
}

export function referencedSkills(skillDir, universe) {
  const wired = new Set();
  const codeComment = new Set();
  const mentioned = new Set();
  const self = basename(skillDir);

  const scan = (dir, inBundle) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { scan(p, inBundle || e === "scripts"); continue; }
      if (!st.isFile() || !/\.(md|mjs|js|sh|py|ya?ml|json|txt|toml)$/i.test(e)) continue;
      let text;
      try { text = readFileSync(p, "utf8"); } catch { continue; }
      if (!inBundle) {
        for (const cand of universe) {
          if (cand !== self && text.includes(cand)) mentioned.add(cand);
        }
        continue;
      }
      const code = stripComments(text, e);
      for (const cand of universe) {
        if (cand === self || !text.includes(cand)) continue;
        (code.includes(cand) ? wired : codeComment).add(cand);
      }
    }
  };
  scan(skillDir, false);

  for (const w of wired) { codeComment.delete(w); mentioned.delete(w); }   // wired is strongest
  for (const c of codeComment) mentioned.delete(c);
  return {
    wired: [...wired].sort(),
    codeComment: [...codeComment].sort(),
    mentioned: [...mentioned].sort(),
  };
}

export function loadPresetFile() {
  const f = join(ASSETS, "presets.yaml");
  if (!existsSync(f)) return {};
  const presets = {};
  let current = null;
  let section = "skills";
  for (const raw of readFileSync(f, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const head = line.match(/^([A-Za-z0-9._-]+):\s*$/);
    if (head) {
      current = head[1];
      section = "skills";
      presets[current] = { skills: [], delegates: [] };
      continue;
    }
    const sub = line.match(/^\s+(skills|delegates):\s*$/);
    if (sub && current) { section = sub[1]; continue; }
    const item = line.match(/^\s+-\s+(\S+)\s*$/);
    if (item && current) presets[current][section].push(item[1]);
  }
  return presets;
}

export function loadPresets() {
  const { [REQUIRED_KEY]: _floor, [HOST_PLUGINS_KEY]: _plugins, ...presets } = loadPresetFile();
  return presets;
}

export function loadHostPlugins() {
  return loadPresetFile()[HOST_PLUGINS_KEY]?.skills ?? [];
}

export function loadRequiredSkills() {
  return loadPresetFile()[REQUIRED_KEY]?.skills ?? [];
}

export function csv(v) {
  if (!v || v === true) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

export function truthyFlag(v) {
  return v !== undefined && v !== false && v !== "false" && v !== "0" && v !== "";
}

function insideOrEqual(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

// realpath also resolves junctions and case aliases. Preserve the missing tail so a new
// destination below an existing symlink is checked before mkdir creates anything.
function canonicalTarget(path) {
  let cursor = resolve(path);
  const tail = [];
  while (true) {
    try { return join(realpathSync(cursor), ...tail); }
    catch (error) {
      let entry;
      try { entry = lstatSync(cursor); } catch {}
      if (entry || !['ENOENT', 'ENOTDIR'].includes(error.code)) {
        die('cannot safely resolve forge target: ' + path, 2);
      }
      const parent = dirname(cursor);
      if (parent === cursor) die('cannot resolve forge target: ' + path, 2);
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** Cross-volume Windows paths cannot be recorded as portable repo-relative paths. */
export function assertSameForgeVolume(source, target, pathApi = path) {
  if (pathApi.parse(source).root.toLowerCase() !== pathApi.parse(target).root.toLowerCase()
    || pathApi.isAbsolute(pathApi.relative(source, target))) {
    die('forge target must be on the same filesystem volume as the source repository', 2);
  }
}

function assertIndependentGitMetadata(source, target) {
  const marker = join(target, '.git');
  let entry;
  try { entry = lstatSync(marker); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink()) die('forge target .git must not be a symlink or junction', 2);
  const git = (cwd, args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  const common = cwd => {
    const result = git(cwd, ['rev-parse', '--git-common-dir']);
    return result.status === 0 ? canonicalTarget(resolve(cwd, result.stdout.trim())) : null;
  };
  const targetCommon = common(target);
  if (!targetCommon) die('cannot validate forge target Git metadata', 2);
  const sourceCommon = common(source);
  if (sourceCommon && relative(sourceCommon, targetCommon) === '') {
    die('forge target shares the source repository Git metadata', 2);
  }
  // A genuine worktree/submodule is listed at its real working-tree location. A
  // hand-written gitdir pointer into some other checkout is not a registered owner.
  const listed = git(target, ['worktree', 'list', '--porcelain', '-z']);
  let registered = listed.status === 0 && listed.stdout.split('\0')
    .filter(field => field.startsWith('worktree '))
    .some(field => relative(canonicalTarget(field.slice(9)), target) === '');
  // Submodule repositories report their metadata location in worktree-list on
  // some Git versions. Their explicit core.worktree is the ownership backlink.
  if (!registered) {
    const backlink = git(target, ['config', '--local', '--get', 'core.worktree']);
    const metadata = git(target, ['rev-parse', '--absolute-git-dir']);
    registered = backlink.status === 0 && metadata.status === 0
      && relative(canonicalTarget(resolve(metadata.stdout.trim(), backlink.stdout.trim())), target) === '';
  }
  if (!registered) die('forge target Git metadata does not register this working tree', 2);
}

/** Validate before every forge write, including re-forges of an existing checkout. */
export function assertSafeForgeTarget(repoRoot, dir) {
  const source = canonicalTarget(repoRoot);
  const target = canonicalTarget(dir);
  assertSameForgeVolume(source, target);
  if (insideOrEqual(target, source)) {
    die('forge target is the source repository or an ancestor of it', 2);
  }
  const copiedRoots = new Set([
    ...CORE_SURFACES, ...Object.values(OPTIONAL_SURFACES).flat(), ...CLI_WIRING,
    'scripts', '.agents/skills', '.gemini',
  ].map(path => path.replaceAll('\\', '/').split('/')[0]));
  for (const root of copiedRoots) {
    if (insideOrEqual(canonicalTarget(join(repoRoot, root)), target)) {
      die('forge target is inside copied source surface: ' + root, 2);
    }
  }
  // A symlink at the target itself is never an independent generated checkout.
  try {
    if (lstatSync(dir).isSymbolicLink()) die('forge target must not be a symlink or junction', 2);
  } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  // Do not let an in-repository path escape through a symlink in its missing tail.
  const lexicalSource = resolve(repoRoot), lexicalTarget = resolve(dir);
  if (insideOrEqual(lexicalSource, lexicalTarget)) {
    let cursor = dirname(lexicalTarget);
    while (cursor !== lexicalSource && insideOrEqual(lexicalSource, cursor)) {
      try {
        if (lstatSync(cursor).isSymbolicLink()) die('forge target has a symlink ancestor: ' + cursor, 2);
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      cursor = dirname(cursor);
    }
  }

  const permittedLinks = new Map([
    ['CLAUDE.md', 'AGENTS.md'], ['GEMINI.md', 'AGENTS.md'],
    ['.claude/skills', '.agents/skills'], ['.agent/skills', '.agents/skills'],
    ['.gemini/skills', '.agents/skills'],
  ]);
  const inspect = (absolute, rel) => {
    let entry;
    try { entry = lstatSync(absolute); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (entry.isSymbolicLink()) {
      const expected = permittedLinks.get(rel);
      const actual = canonicalTarget(absolute);
      if (!expected || actual !== canonicalTarget(join(target, expected)) || !insideOrEqual(target, actual)) {
        die('forge target managed surface contains an unsafe symlink: ' + rel, 2);
      }
      return;
    }
    if (entry.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) inspect(join(absolute, name), rel + '/' + name);
    }
  };
  for (const root of new Set([...copiedRoots, 'AGENTS.md', 'AGENTS.framework.md', 'CLAUDE.md',
    'GEMINI.md', 'package.json', '.gitignore', 'README.md', 'install.sh', 'install.ps1', '.sidekicks-core.json'])) {
    inspect(join(target, root), root);
  }
  assertIndependentGitMetadata(source, target);
  return target;
}

export function resolveRuntime(ctx, repoRoot, flags, positional) {
  const name = flags.name ?? positional[0];
  if (!name) die("missing runtime name (--name <n>)", 2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) die(`invalid runtime name: ${name}`, 2);

  let dir;
  let source;
  if (flags.target) {
    const t = String(flags.target);
    dir = isAbsolute(t) ? resolve(t) : resolve(repoRoot, t);
    source = "flag";
  } else {
    const registered = lookupRuntime(ctx, repoRoot, name);
    if (registered) { dir = registered; source = "registry"; }
    else { dir = join(repoRoot, "runtimes", name); source = "default"; }
  }

  if (resolve(dir) === resolve(repoRoot)) die("the target may not be the sidekicks source repo itself", 2);
  // Refuse a target that would swallow the source repo (e.g. --target ..).
  if (isInsideRepo(dir, repoRoot)) {
    die(`the target ${displayPath(repoRoot, dir)} contains the sidekicks source repo — pick a location that is not an ancestor of it`, 2);
  }
  assertSafeForgeTarget(repoRoot, dir);
  return { name, dir, source };
}

export function warnIfProjectScoped(ctx, repoRoot) {
  const p = join(repoRoot, ".sidekicks", "settings.json");
  if (!existsSync(p)) return;
  let active = null;
  try { active = JSON.parse(readFileSync(p, "utf8")).active_project ?? null; } catch { return; }
  if (!active || active === "sidekicks") return;
  out(ctx, `NOTE: project '${active}' is the active scope, but a runtime is written at the repo root.`);
  out(ctx, `      Switch with 'sidekicks project use sidekicks' to keep the Rule 2 boundary aligned.`);
  out(ctx, "");
}

export function resolveSkillSelection(repoRoot, flags) {
  const presets = loadPresets();
  const names = csv(flags.skills);
  const reasonSets = new Map();
  const addReason = (skill, reason) => {
    if (!reasonSets.has(skill)) reasonSets.set(skill, new Set());
    reasonSets.get(skill).add(reason);
  };
  for (const skill of names) addReason(skill, "selected-by-operator");
  for (const p of csv(flags.preset)) {
    if (!presets[p]) die(`unknown preset '${p}' (available: ${Object.keys(presets).join(", ") || "none"})`, 2);
    if (p === "framework") {
      const resolved = resolveFrameworkPreset(repoRoot, { requiredFloor: loadRequiredSkills() });
      if (resolved.errors.length) {
        die(`framework preset cannot be composed:\n         ${resolved.errors.join("\n         ")}`, 4);
      }
      names.push(...resolved.selected);
      for (const [skill, reasons] of Object.entries(resolved.reasons)) {
        for (const reason of reasons) addReason(skill, reason);
      }
    } else {
      names.push(...presets[p].skills);
      for (const skill of presets[p].skills) addReason(skill, `selected-by-preset:${p}`);
    }
  }
  const operator = [...new Set(names)];
  const required = loadRequiredSkills();
  for (const skill of required) addReason(skill, "required-floor");
  const reasons = {};
  for (const skill of [...reasonSets.keys()].sort()) reasons[skill] = [...reasonSets.get(skill)].sort();
  return { operator, required, all: [...new Set([...required, ...operator])], reasons };
}

export async function packSkillsFor(repoRoot, flags, asCore) {
  const none = { skills: [], packs: 0, seeds: [], viaClosure: [], mode: "none" };
  const mode = String(flags["pack-skills"] ?? "declared").trim() || "declared";
  if (!PACK_SKILL_MODES.includes(mode)) {
    die(`--pack-skills must be one of: ${PACK_SKILL_MODES.join(", ")}`, 2);
  }
  if (!asCore || mode === "none") return none;
  const derived = await resolvePackSkills(repoRoot);
  // DEFAULT `declared`: exactly the skills the pack manifests name, and nothing else. That is what
  // makes the shipped pack installable — `agent pack install` checks the declared rows and refused
  // on all three of them before this existed — while keeping a core the lean substrate presets.yaml
  // says it is. `closure` adds each of those skills' own declared siblings, which they will fail
  // without; it is the honest-but-heavy answer (3 skills become 28 here) and stays opt-in, because
  // the consumer can import a sibling with one `skill import` and cannot un-ship 25 skills.
  if (mode === "declared") return { ...derived, skills: derived.seeds, viaClosure: [], mode };
  return { ...derived, mode };
}

export const PACK_SKILL_MODES = ["closure", "declared", "none"];

export function unionPackSkills(selection, packSkills, reasons = null) {
  if (!packSkills.skills.length) return selection;
  if (reasons) {
    for (const [skill, why] of Object.entries(packSkills.reasons ?? {})) {
      if (!packSkills.skills.includes(skill)) continue;   // `declared` mode ships a subset
      reasons[skill] = [...new Set([...(reasons[skill] ?? []), ...why])].sort();
    }
    for (const skill of packSkills.skills) {
      if (reasons[skill]?.length) continue;
      // The closure could not run (its one catch above) yet the seed still travels. Say that,
      // rather than leaving the only unexplained row in the file.
      reasons[skill] = ["agent-pack:unattributed"];
    }
  }
  return [...new Set([...selection, ...packSkills.skills])];
}

export function resolveDelegateSelection(repoRoot, flags) {
  if (truthyFlag(flags["all-delegates"])) return listAvailableDelegates(repoRoot);
  const presets = loadPresets();
  const names = csv(flags.delegates);
  for (const p of csv(flags.preset)) {
    if (!presets[p]) die(`unknown preset '${p}' (available: ${Object.keys(presets).join(", ") || "none"})`, 2);
    names.push(...presets[p].delegates);
  }
  return [...new Set(names)];
}
