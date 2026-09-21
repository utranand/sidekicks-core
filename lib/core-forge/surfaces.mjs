// Sidekicks core forge — surfaces. Zero runtime dependencies.
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
import { expectedOutputs } from '../../scripts/generate-subagent-ports.mjs';
import { WIRING_FILES } from '../core-lifecycle/_wiring.mjs';
import { projectHostWiring } from './settings-sync.mjs';
import { loadHostPlugins, resolveSkill } from './select.mjs';

const portablePath = p => p.split(sep).join('/');
const codePoint = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const contentHash = b => createHash('sha256').update(b).digest('hex');

/** Single source→candidate operating-surface contract. No machine paths or values. */
export function projectRootStructure(repoRoot, skills = [], opts = {}) {
  const entries = new Map(), contents = new Map();
  const families = ownedFamilies(skills);
  const wiring = new Set(WIRING_FILES.map(portablePath));
  const generated = opts.agents === false ? new Map() : new Map(expectedOutputs(repoRoot).map(([p,t])=>[portablePath(relative(repoRoot,p)),t]));
  const excluded = (path,reason) => entries.set(path,{path,kind:'excluded',included:false,reason});
  const visit = (rel, reason, command = false, root = true) => {
    const p=join(repoRoot,...rel.split('/'));
    if (!existsSync(p)) return;
    if (!root && (isDenied(rel) || basename(rel).startsWith('._'))) { excluded(rel,'secret, local state, or build residue'); return; }
    if (command) { const family=surfaceFamily(rel); if(family && !families.has(family)){ excluded(rel,'command capability absent: '+family); return; } }
    const stat=lstatSync(p);
    if(stat.isSymbolicLink()) throw new Error('root structure refuses source symlink: '+rel);
    if(stat.isDirectory()) {
      for(const child of readdirSync(p).sort()) visit(rel+'/'+child,reason,command,false);
      const hasIncluded = [...entries.values()].some(e => e.included && e.path !== rel && e.path.startsWith(rel + '/'));
      if (hasIncluded) {
        entries.set(rel,{path:rel,kind:'directory',included:true,reason});
      } else {
        excluded(rel, command ? 'command capability absent: ' + (surfaceFamily(rel) || 'bmad') : 'empty directory');
      }
      return;
    }
    if(!stat.isFile()) { excluded(rel,'non-portable filesystem entry'); return; }
    const sourceBytes=readFileSync(p);
    if (generated.has(rel) && sourceBytes.toString('utf8').replace(/\r\n/g,'\n') !== generated.get(rel).replace(/\r\n/g,'\n'))
      throw new Error('stale generated host port: '+rel+'; run node scripts/generate-subagent-ports.mjs');
    let data=generated.has(rel)?Buffer.from(generated.get(rel)):sourceBytes;
    if(wiring.has(rel)) data=Buffer.from(projectHostWiring(repoRoot,rel,data.toString('utf8'),skills,loadHostPlugins()));
    const normalized=rel.startsWith('.sidekicks/config/settings/');
    entries.set(rel,{path:rel,kind:'file',included:true,executable:Boolean(stat.mode & 0o111),hash:normalized?null:contentHash(data),reason:normalized?'normalized framework settings':reason});
    contents.set(rel,data);
  };
  for(const rel of CORE_SURFACES) visit(rel,'framework substrate');
  visit('scripts','root-structure');
  for(const rel of WIRING_FILES.map(portablePath)) visit(rel,'host wiring, owner-aware activation');
  for(const [key,paths] of Object.entries(OPTIONAL_SURFACES)) for(const rel of paths) {
    if(opts[key]===false){ excluded(rel,'explicit --no-'+key); continue; }
    visit(rel,key==='agents'?'canonical agents and generated host ports':'command adapters',key==='commands');
  }
  for(const [rel,text] of generated) {
    const data=Buffer.from(text);
    entries.set(rel,{path:rel,kind:'file',included:true,executable:false,hash:contentHash(data),reason:'generated from canonical subagent'});
    contents.set(rel,data);
  }
  visit('.sidekicks/config.example.yaml','framework example');
  for(const name of readdirSync(join(repoRoot,'.sidekicks')).sort()) {
    if (/\.example\.(?:ya?ml|json)$/i.test(name)) visit('.sidekicks/' + name,'framework example');
  }
  if(opts.as_core) visit('.sidekicks/agent-packs','framework agent packs');
  for(const row of configurationInventory(repoRoot)) {
    if(row.mode==='copy') visit(row.source,'framework configuration '+row.classification);
    else if(!row.mode) excluded(row.destination,row.reason ?? row.classification);
  }
  for(const skill of [...skills].sort()) {
    const source=resolveSkill(repoRoot,skill);
    if(!source) continue; // selection preflight reports a missing skill
    const projected=projectSkillRuntime(source.dir,{skill,deny:rel=>isDenied(rel.split('/').join(sep))});
    if(projected.errors.length) throw new Error(projected.errors.join('\n'));
    for(const rel of projected.files) {
      const path='.agents/skills/'+skill+'/'+rel;
      const data=projected.derived[rel]!==undefined?Buffer.from(projected.derived[rel]):readFileSync(join(source.dir,...rel.split('/')));
      const executable=projected.modes[rel]===755 || Boolean(statSync(join(source.dir,...rel.split('/'))).mode&0o111);
      entries.set(path,{path,kind:'file',included:true,executable,hash:contentHash(data),reason:'selected skill runtime projection'});
      contents.set(path,data);
    }
    for(const row of projected.excluded) excluded('.agents/skills/'+skill+'/'+row.path,row.reason);
  }
  const generatedRoots=['AGENTS.md','CLAUDE.md','GEMINI.md','package.json','.gitignore','.sidekicks/inherit.json'];
  if(opts.as_core) generatedRoots.push('AGENTS.framework.md','README.md','install.sh','install.ps1','.sidekicks-core.json');
  for(const path of generatedRoots) entries.set(path,{path,kind:['CLAUDE.md','GEMINI.md'].includes(path)?'mirror':'file',included:true,
    generated:true,executable:path==='install.sh',hash:null,reason:'generated runtime contract'});
  for(const path of ['projects','artifacts','tests','docs','.sidekicks/state','.sidekicks/memory','.env']) excluded(path,'source-only content, state, or secrets');
  const rows=[...entries.values()].sort((a,b)=>codePoint(a.path,b.path));
  const projection={schema:1,entries:rows,digest:contentHash(JSON.stringify(rows))};
  Object.defineProperty(projection,'contents',{value:contents});
  return projection;
}

export function copyRootStructure(repoRoot, runtimeRoot, projection) {
  for(const row of projection.entries) {
    if(!row.included || row.generated) continue;
    const dst=join(runtimeRoot,...row.path.split('/'));
    if(row.kind==='directory') { mkdirp(dst); continue; }
    mkdirp(dirname(dst));
    writeFileSync(dst,projection.contents.get(row.path));
    if(process.platform!=='win32') chmodSync(dst,row.executable?0o755:0o644);
  }
}

export function verifyRootStructure(runtimeRoot, projection) {
  const problems=[];
  const expected = new Set(projection.entries.filter(row => row.included).map(row => row.path));
  // Exact payload roots may not grow unaccounted files after projection. Mutable
  // config/state and host skill-exposure links are intentionally outside this scan.
  const exactRoots = ['scripts', 'bin', 'lib', '.githooks', '.agents/skills', '.agents/subagents',
    '.claude/agents', '.codex/agents', '.agents/plugins', '.claude/commands', '.sidekicks/agent-packs'];
  const scan = rel => {
    const path = join(runtimeRoot, ...rel.split('/'));
    let entry; try { entry = lstatSync(path); } catch { return; }
    if (!expected.has(rel) && !projection.entries.some(row => row.included && row.path.startsWith(rel + '/'))) {
      problems.push('unexpected root structure: ' + rel); return;
    }
    if (entry.isDirectory()) for (const child of readdirSync(path).sort()) scan(rel + '/' + child);
  };
  for (const root of exactRoots) scan(root);
  for(const row of projection.entries) {
    if(!row.included) continue;
    if(typeof row.path!=='string' || row.path.includes('\\') || row.path.startsWith('/') || /^[A-Za-z]:/.test(row.path) || row.path.split('/').some(p=>!p||p==='..'||p==='.')) {problems.push('unsafe root structure path');continue;}
    const path=join(runtimeRoot,...row.path.split('/'));
    let parent = dirname(path), escaping = false;
    while (parent !== resolve(runtimeRoot) && parent !== dirname(parent)) {
      try { if (lstatSync(parent).isSymbolicLink()) { escaping = true; break; } } catch {}
      parent = dirname(parent);
    }
    if (escaping) { problems.push('symlink in root structure ancestor: ' + row.path); continue; }
    let stat; try {stat=lstatSync(path);}catch{problems.push('missing root structure: '+row.path);continue;}
    if(row.kind==='mirror') {
      if(stat.isSymbolicLink() && readlinkSync(path)!=='AGENTS.md') problems.push('escaping instruction mirror: '+row.path);
      else if(readFileSync(path,'utf8')!==readFileSync(join(runtimeRoot,'AGENTS.md'),'utf8')) problems.push('instruction mirror mismatch: '+row.path);
      continue;
    }
    if(stat.isSymbolicLink() || (row.kind==='directory'?!stat.isDirectory():!stat.isFile())) {problems.push('wrong root structure kind: '+row.path);continue;}
    if(row.kind==='file' && row.hash && contentHash(readFileSync(path))!==row.hash) problems.push('root structure content mismatch: '+row.path);
    if(row.kind==='file' && process.platform!=='win32' && row.executable!==Boolean(stat.mode&0o111)) problems.push('root structure mode mismatch: '+row.path);
  }
  return problems;
}

/** Freeze hashes of generated files AFTER all normalization, outside the candidate. */
export function sealRootStructure(runtimeRoot, projection) {
  const entries=projection.entries.map(row=>row.included && row.kind!=='directory'
    ? {...row,hash:contentHash(readFileSync(join(runtimeRoot,...row.path.split('/'))))}:row);
  return {schema:1,entries,digest:contentHash(JSON.stringify(entries))};
}
import { CLI_WIRING, CORE_SURFACES, DELEGATE_SCRIPT_FILES, DELEGATE_SCRIPT_SUBDIRS, DENY, DENY_EXCEPTIONS, DENY_PATTERNS, OPTIONAL_SURFACES, SCRIPT_FILE_FLOOR, SCRIPT_SUBDIR_FLOOR, SCRIPT_SUBDIR_OWNERS, SUBAGENT_PORT_SCRIPT_FILES, die, hashFile, mkdirp, ownedFamilies, surfaceFamily } from './_shared.mjs';
import { STATUS_ORDER } from './drift.mjs';

export function isDenied(relPath) {
  const portable = relPath.replaceAll('\\', '/');
  if ([...DENY_EXCEPTIONS].some(p => p.replaceAll('\\', '/') === portable)) return false;
  return portable.split('/').some((seg) => DENY.has(seg) || DENY_PATTERNS.some((re) => re.test(seg)));
}

export function copyTree(srcAbs, dstAbs, { relBase = "", onSkip = null, keep = null } = {}) {
  let st;
  try { st = lstatSync(srcAbs); } catch { return 0; }

  if (st.isSymbolicLink()) {
    const shown = relBase || basename(srcAbs);
    throw new Error(`inherit: refusing symlink in copy surface: ${shown}`);
  }

  if (st.isFile()) {
    mkdirp(dirname(dstAbs));
    copyFileSync(srcAbs, dstAbs);
    if (st.mode & 0o111) {
      try { chmodSync(dstAbs, st.mode & 0o777); } catch { /* best effort */ }
    }
    return 1;
  }

  if (!st.isDirectory()) return 0;   // socket/fifo/device — nothing to inherit

  mkdirp(dstAbs);
  let count = 0;
  for (const entry of readdirSync(srcAbs).sort()) {
    const rel = relBase ? join(relBase, entry) : entry;
    if (isDenied(rel)) {
      if (onSkip) onSkip(rel);
      continue;
    }
    // `keep` is the ownership gate (agent/command surfaces). It is asked about DIRECTORIES too, so a
    // whole family folder is refused in one decision rather than file by file.
    if (keep && !keep(rel)) {
      if (onSkip) onSkip(rel);
      continue;
    }
    count += copyTree(join(srcAbs, entry), join(dstAbs, entry), { relBase: rel, onSkip, keep });
  }
  return count;
}

export function copyCoreSurfaces(repoRoot, runtimeRoot, skillNames, opts = {}) {
  const projection = projectRootStructure(repoRoot, skillNames, opts);
  for (const rel of [...CORE_SURFACES, ...Object.values(OPTIONAL_SURFACES).flat(), ...WIRING_FILES.map(portablePath), 'scripts']) {
    rmSync(join(runtimeRoot,...rel.split('/')), {recursive:true,force:true});
  }
  copyRootStructure(repoRoot, runtimeRoot, projection);
  return projection.entries.filter(r=>r.included && r.kind==='file').map(r=>r.path);
}

export function copyConfigurationSurface(repoRoot, runtimeRoot, previousInventory = []) {
  const inventory = configurationInventory(repoRoot);
  const copied = [];
  const current = new Set(inventory.filter((row) => row.mode).map((row) => row.destination));
  const removed = [];
  for (const row of previousInventory.filter((row) => row.mode && !current.has(row.destination))) {
    const dst = join(runtimeRoot, ...row.destination.split('/'));
    rmSync(dst, { force: true });
    removed.push(row.destination);
  }
  for (const row of inventory) {
    if (!row.mode) continue;
    const src = join(repoRoot, ...row.source.split("/"));
    const dst = join(runtimeRoot, ...row.destination.split("/"));
    mkdirp(dirname(dst));
    copyFileSync(src, dst);
    copied.push(`${row.destination} (${row.classification}, ${row.initializer_origin})`);
  }
  return { inventory, copied, removed: removed.sort() };
}

export function classifyConfiguration(repoRoot, runtimeRoot, manifest) {
  if (!Array.isArray(manifest.configuration) || !manifest.configuration.length) return [];
  const source = new Map(configurationInventory(repoRoot).filter((row) => row.mode).map((row) => [row.destination, row]));
  const rows = [];
  for (const baseline of manifest.configuration.filter((row) => row.mode)) {
    const current = source.get(baseline.destination);
    const path = join(runtimeRoot, ...baseline.destination.split('/'));
    if (!existsSync(path)) {
      rows.push({ name: baseline.destination, status: 'missing-runtime', detail: 'generated configuration file is absent' });
      continue;
    }
    // Framework reconciliation changes these files by design; their safe contract is presence.
    const reconciled = baseline.classification === 'settings'
      || baseline.destination === '.sidekicks/config/framework.yaml';
    const sourceChanged = !current || current.hash !== baseline.hash;
    const runtimeChanged = !reconciled && hashFile(path) !== baseline.hash;
    const status = sourceChanged && runtimeChanged ? 'conflict'
      : sourceChanged ? 'ff' : runtimeChanged ? 'local-only' : 'up-to-date';
    rows.push({ name: baseline.destination, status, detail: status === 'up-to-date' ? '' : 'configuration inventory changed' });
  }
  const baselineDestinations = new Set(manifest.configuration.filter((row) => row.mode).map((row) => row.destination));
  for (const row of source.values()) {
    if (!baselineDestinations.has(row.destination)) {
      rows.push({ name: row.destination, status: 'ff', detail: 'new generated configuration template' });
    }
  }
  return rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || codePoint(a.name,b.name));
}

export async function resolveScriptOwnership(repoRoot, skillNames, { hasDelegates = false, hasSubagents = false } = {}) {
  let CORE_HOOKS, skillClosure;
  try {
    ({ CORE_HOOKS } = await import(pathToFileURL(join(repoRoot, "lib", "framework-settings", "core-registry.mjs")).href));
    ({ skillClosure } = await import(pathToFileURL(join(repoRoot, "lib", "skill-package", "closure.mjs")).href));
  } catch (e) {
    die(`cannot resolve script ownership — the source repo's lib/ did not load: ${e.message}`, 3);
  }

  const selected = new Set(skillNames);
  const files = new Set(SCRIPT_FILE_FLOOR);
  const subdirs = new Set(SCRIPT_SUBDIR_FLOOR);
  const orphanHookScripts = new Set();

  // Claims are repo-relative ("scripts/foo.mjs", "scripts/launchd/x.plist"); only scripts/ ones
  // matter here (lib/, .sidekicks/hooks/ travel whole via CORE_SURFACES).
  const claim = (relPath) => {
    const parts = String(relPath ?? "").replace(/\\/g, "/").split("/");
    if (parts[0] !== "scripts" || parts.length < 2) return;
    if (parts.length === 2) files.add(parts[1]);
    else subdirs.add(parts[1]);
  };

  for (const h of CORE_HOOKS) {
    const parts = String(h.script || "").split("/");
    const topLevel = parts[0] === "scripts" && parts.length === 2;
    if (h.owners.length === 0 || h.owners.some((o) => selected.has(o))) claim(h.script);
    else if (topLevel) orphanHookScripts.add(parts[1]);
  }

  const closure = skillClosure(repoRoot, [...selected]);
  const needed = (row) => (row.needed_by || []).some((n) => selected.has(n));
  for (const row of closure.framework_files) if (needed(row)) claim(row.path);
  for (const row of closure.framework_hooks) if (needed(row) && row.script) claim(row.script);

  // Delegate-agent operating surface: present because the runtime carries agents, not because a
  // skill declared it. Only what actually exists in the source is claimed, so a repo that retired
  // one of these scripts does not start failing verify over a phantom claim.
  if (hasDelegates) {
    for (const f of DELEGATE_SCRIPT_FILES) {
      if (existsSync(join(repoRoot, "scripts", f))) files.add(f);
    }
    for (const d of DELEGATE_SCRIPT_SUBDIRS) {
      if (existsSync(join(repoRoot, "scripts", d))) subdirs.add(d);
    }
  }

  if (hasSubagents) {
    for (const f of SUBAGENT_PORT_SCRIPT_FILES) {
      if (existsSync(join(repoRoot, "scripts", f))) files.add(f);
    }
  }

  // A script both claimed (e.g. floor) and named by an orphan hook stays claimed.
  for (const f of files) orphanHookScripts.delete(f);
  return { files, subdirs, orphanHookScripts };
}

export async function copyScriptsSurface(repoRoot, runtimeRoot, skillNames, opts = {}) {
  const projection=projectRootStructure(repoRoot,skillNames,{agents:opts.hasSubagents!==false});
  const entries=projection.entries.filter(r=>r.path==='scripts'||r.path.startsWith('scripts/'));
  if(opts.exact) rmSync(join(runtimeRoot,'scripts'),{recursive:true,force:true});
  copyRootStructure(repoRoot,runtimeRoot,{entries,contents:projection.contents});
  return {copied:entries.filter(r=>r.included && r.kind==='file').length, skipped:entries.filter(r=>!r.included).map(r=>r.path)};
}

export function refreshRuntimeIndex(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return { ok: false, note: "runtime has no bin/sidekicks" };
  const r = spawnSync(process.execPath, [cli, "index", "rebuild"], { cwd: runtimeRoot, encoding: "utf8" });
  return r.status === 0
    ? { ok: true, note: "runtime index rebuilt" }
    : { ok: false, note: `runtime index rebuild failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}` };
}
