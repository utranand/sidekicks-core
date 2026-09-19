import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runProjection } from '../forge.mjs';
import { snapshotCoreTree } from '../distribution.mjs';
import { sourceFixture } from './_source-fixture.mjs';

const repoRoot=join(dirname(fileURLToPath(import.meta.url)),'../../..');

test('standalone core forges itself through its own CLI with identical masked content', async t=>{
  const source=sourceFixture(repoRoot);
  const tmp=mkdtempSync(join(tmpdir(),'core-self-host-spec-'));
  t.after(()=>{source.cleanup();rmSync(tmp,{recursive:true,force:true});});
  const a=join(tmp,'generation-a'),b=join(tmp,'generation-b');
  const flags={name:'self-host-spec',target:a,preset:'framework','as-core':true,
    'core-version':'3.2.1','core-ref':'v3.2.1',remote:'https://example.invalid/self-host.git',
    'pack-skills':'none','no-venv':true,force:true};
  const first=await runProjection(source.root,'forge',flags);
  assert.equal(first.exitCode,0,(first.stdout??'')+(first.stderr??''));
  const marker=JSON.parse(readFileSync(join(a,'.sidekicks-core.json'),'utf8'));
  const args=[join(a,'bin','sidekicks'),'core','forge','--target',b,'--name',marker.name,
    '--version',marker.version,'--core-ref','v3.2.1','--remote',flags.remote,
    '--preset','framework','--pack-skills','none','--no-venv'];
  const second=spawnSync(process.execPath,args,{cwd:a,encoding:'utf8',timeout:120000});
  assert.equal(second.status,0,(second.stdout??'')+(second.stderr??''));
  const own=await import(pathToFileURL(join(a,'lib','core-forge','forge.mjs')).href);
  const checked=await own.runProjection(a,'verify',{name:marker.name,target:b});
  const before=snapshotCoreTree(a),after=snapshotCoreTree(b);
  assert.ok(before.files.size>0,'fixed-point evidence cannot be an empty snapshot');
  const differences=[...new Set([...before.files.keys(),...after.files.keys()])]
    .filter(path=>before.files.get(path)!==after.files.get(path)).sort();
  assert.deepEqual({verification:checked.exitCode,differences},{verification:0,differences:[]},
    (checked.stdout??'')+(checked.stderr??'')+'\nsecond generation differs: '+differences.join(', '));
  const help=spawnSync(process.execPath,[join(b,'bin','sidekicks'),'--help'],{cwd:b,encoding:'utf8'});
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/forge/);
});

test('a mounted consumer cannot forge its linked workspace into another core',async t=>{
  const ws=mkdtempSync(join(tmpdir(),'core-consumer-refusal-'));
  t.after(()=>rmSync(ws,{recursive:true,force:true}));
  mkdirSync(join(ws,'.sidekicks-core'));
  writeFileSync(join(ws,'.sidekicks-core','.sidekicks-core.json'),JSON.stringify({schema:1,name:'mounted',version:'1.0.0'}));
  const target=join(ws,'must-not-exist');
  const result=await runProjection(ws,'forge',{target,name:'refused',preset:'framework','core-version':'1.0.0'});
  assert.notEqual(result.exitCode,0);
  assert.match((result.stdout??'')+(result.stderr??''),/consumer|mount/i);
  assert.equal(existsSync(target),false);
});
