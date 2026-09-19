// Shared adapter for the seven publication verbs; mount verbs keep their own semantics.
import { parseCoreFlags } from './_shared.mjs';
import { runProjection } from '../core-forge/forge.mjs';
import { createReleaseEngine } from '../core-forge/release.mjs';
import { resolveReleasePaths } from '../core-forge/paths.mjs';

export async function runCoreCommand(ctx, verb) {
  const flags=parseCoreFlags(ctx.argv,['json','force','dry-run','no-venv','no-agents','no-commands',
    'as-core','no-as-core','prune-skills','prune-delegates','full-scripts','force-downgrade',
    'no-tests','no-mount-check','no-upgrade-check','no-commit','allow-protected','allow-unpushed',
    'allow-unlogged-tags','reland','yes','verbose']);
  let result;
  if(flags['dry-run'] && ['verify','verify-remote'].includes(verb)) {
    return {stdout:`core ${verb} does not support --dry-run; use core plan for a read-only preview.\n`,exitCode:2};
  }
  if(['forge','plan','drift'].includes(verb)) {
    const paths=resolveReleasePaths(ctx.repoRoot,flags);
    result=await runProjection(ctx.repoRoot,verb,{...flags,name:paths.RUNTIME_NAME,target:paths.SRC_REL,
      preset:paths.PRESET,remote:paths.REMOTE,'pack-skills':paths.PACK_SKILLS});
    if(verb==='plan' && result.exitCode===0) {
      const status=await createReleaseEngine({repoRoot:ctx.repoRoot,flags:{...flags,json:true}}).status();
      let state; try { state=JSON.parse(status.stdout); } catch {}
      if(state) {
        result.exitCode=status.exitCode;
        if(flags.json) result.stdout=JSON.stringify({...state,...result.payload},null,2)+'\n';
        else result.stdout+='\nRelease: '+(state.remote_state ?? 'unverified')+'; next version '+(state.next_version ?? '?')+'\n';
      }
    }
  } else {
    const engine=createReleaseEngine({repoRoot:ctx.repoRoot,flags});
    result=await engine[verb==='verify-remote'?'verifyRemote':verb]();
  }
  // The dispatcher contract has one text stream. Successful JSON remains parseable;
  // diagnostics on failure must not disappear because the engine returned stderr.
  return {stdout:result.stdout+(result.stderr || ''),exitCode:result.exitCode};
}
