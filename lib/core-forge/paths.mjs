// Root-scoped publication configuration. Never read project overrides or spawn config get.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { resolveBlock } from '../config-store/read.mjs';
import { CoreForgeError } from './exit.mjs';

export const DEFAULTS = Object.freeze({
  target: 'projects/global/services/sidekicks-core/src', runtime_name: 'sidekicks-core',
  remote: 'https://github.com/utranand/sidekicks-core.git', preset: 'framework', pack_skills: 'none',
});

export function loadConfigBlock(repoRoot) {
  try {
    const resolved = resolveBlock(repoRoot, 'framework_core');
    if (resolved.scope !== 'root') throw new CoreForgeError('framework_core must be declared scope: root', 3);
    return resolved.config ?? {};
  } catch (error) {
    if (/nothing declares block/.test(error.message)) return {};
    throw error;
  }
}

export function deriveRuntimeName(repoRoot, srcRel, flags = {}, config = {}) {
  let name=flags.name || (!flags.target && config.runtime_name);
  if(!name) {
    let parts=String(srcRel).replaceAll('\\','/').split('/').filter(Boolean);
    const worktrees=parts.indexOf('worktrees');
    if(worktrees!==-1) parts=parts.slice(0,worktrees);
    const projects=parts.indexOf('projects');
    name=projects!==-1 && parts[projects+2]==='services' && parts[projects+3]
      ? parts[projects+3] : parts.at(-1)==='src' ? parts.at(-2) : parts.at(-1);
  }
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name??'')) throw new CoreForgeError('invalid runtime name: '+name,2);
  const marker=join(resolve(repoRoot,srcRel),'.sidekicks-core.json');
  if(!flags.name && existsSync(marker)) {
    let previous; try{previous=JSON.parse(readFileSync(marker,'utf8'));}catch{throw new CoreForgeError('unreadable core marker: '+srcRel,3);}
    if(previous.name && previous.name!==name) throw new CoreForgeError(`target identity '${previous.name}' differs from derived '${name}'; pass --name explicitly to change it`,2);
  }
  return name;
}

export function resolveRunRel(srcRel, name) {
  const parts=srcRel.split(sep);
  return parts[0]==='projects' && parts[2]==='services' && parts[3]
    ? join(...parts.slice(0,4),'artifacts','runs','core-forge')
    : join('artifacts','runs',name,'core-forge');
}

export function resolveReleasePaths(repoRoot, flags = {}) {
  const CFG=loadConfigBlock(repoRoot);
  const SRC_ABS=resolve(repoRoot,String(flags.target || CFG.target || DEFAULTS.target));
  const SRC_REL=relative(repoRoot,SRC_ABS);
  const RUNTIME_NAME=deriveRuntimeName(repoRoot,SRC_REL,flags,{...DEFAULTS,...CFG});
  const RUN_REL=resolveRunRel(SRC_REL,RUNTIME_NAME);
  return {ROOT:repoRoot,CFG,SRC_REL,SRC_ABS,RUNTIME_NAME,RUN_REL,
    LOG_REL:join(RUN_REL,'release-log.md'),STATE_REL:join(RUN_REL,'state.json'),
    REMOTE:flags.remote || CFG.remote || DEFAULTS.remote,
    PRESET:flags.preset || CFG.preset || DEFAULTS.preset,
    PACK_SKILLS:flags['pack-skills'] || CFG.pack_skills || DEFAULTS.pack_skills};
}
