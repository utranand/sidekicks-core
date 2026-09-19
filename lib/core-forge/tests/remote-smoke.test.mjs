import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSmokeArgs, runRemoteSmoke } from '../remote-smoke.mjs';

const helper = fileURLToPath(new URL('../remote-smoke.mjs', import.meta.url));
function fixture(t, mode = 'pass') {
  const root = mkdtempSync(join(tmpdir(), 'remote-smoke-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'lib', 'core-forge'), { recursive: true });
  const marker = { name: 'smoke-fixture', version: '3.2.1', remote: 'https://example.invalid/canonical.git', ref: 'v3.2.1' };
  writeFileSync(join(root, '.sidekicks-core.json'), JSON.stringify(marker));
  writeFileSync(join(root, 'bin', 'sidekicks'), `
    const {cpSync,readFileSync,writeFileSync}=require('node:fs');const {join,basename}=require('node:path');
    const a=process.argv.slice(2),flag=n=>a[a.indexOf('--'+n)+1];
    const m=JSON.parse(readFileSync('.sidekicks-core.json','utf8'));
    if(a[0]!=='core'||a[1]!=='forge'||flag('name')!==m.name||flag('core-version')!==m.version
      ||flag('remote')!==m.remote||flag('core-ref')!==m.ref)process.exit(9);
    cpSync(process.cwd(),flag('target'),{recursive:true,filter:p=>basename(p)!=='.git'});
    if(${JSON.stringify(mode)}==='mismatch')writeFileSync(join(flag('target'),'extra.txt'),'different');
  `);
  writeFileSync(join(root, 'lib', 'core-forge', 'release.mjs'), `
    export function createReleaseEngine({repoRoot,verificationDepth,flags}) {
      if(verificationDepth!==1||repoRoot!==process.cwd()||flags.name!=='smoke-fixture'
        ||!import.meta.url.includes('successor'))throw new Error('wrong artifact engine or recursion context');
      if(Object.keys(flags).some(k=>k.startsWith('no-')))throw new Error('gate waiver');
      return {verify:async()=>({exitCode:${mode === 'verify-failure' ? 7 : 0},stdout:'own bounded verification ran\\n',stderr:''})};
    }
  `);
  git(['add', '.']); git(['commit', '-qm', 'served fixture']); git(['tag', 'v3.2.1']);
  return { root, sha: git(['rev-parse', 'HEAD']) };
}

function assertCleanup(stdout) {
  const paths = [...stdout.matchAll(/^temporary root: (.+)$/gm)].map(match => match[1]);
  assert.equal(paths.length, 2, stdout);
  for (const path of paths) {
    assert.equal(existsSync(path), false, 'temporary root remains: ' + path);
    assert.ok(stdout.includes('cleanup: ' + path));
  }
}

test('remote smoke runs served CLI and successor engine with exact metadata and cleans both roots', t => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [helper, '--remote', f.root, '--ref', 'v3.2.1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('served commit: ' + f.sha));
  assert.match(r.stdout, /own bounded verification ran/);
  assert.match(r.stdout, /PASS:/);
  assertCleanup(r.stdout);
});

for (const mode of ['verify-failure', 'mismatch']) test('remote smoke fails and cleans roots: ' + mode, t => {
  const f = fixture(t, mode);
  const r = spawnSync(process.execPath, [helper, '--remote', f.root, '--ref', 'v3.2.1'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, mode === 'mismatch' ? /masked tree mismatch/ : /failed \(7\)/);
  assertCleanup(r.stdout);
});

test('remote smoke refuses malformed inputs and public gate bypasses before allocating roots', () => {
  for (const args of [[], ['--remote', 'x'], ['--remote', '-upload-pack=bad', '--ref', 'v1'],
    ['--remote', 'x\nother', '--ref', 'v1'], ['--remote', 'x', '--ref', 'bad\0ref'],
    ['--remote', 'x', '--ref', '-v1'], ['--remote', 'x', '--ref', 'bad..ref'],
    ['--remote', 'x', '--ref', 'v1', '--no-tests'], ['--remote', 'x', '--ref', 'v1', '--verificationDepth', '1'],
    ['--remote', 'x', '--remote', 'y', '--ref', 'v1']]) {
    let output = '';
    assert.throws(() => runRemoteSmoke(parseSmokeArgs(args), text => { output += text; }));
    assert.equal(output, '');
  }
});

test('remote smoke cleans both roots when the requested served tag is missing', t => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [helper, '--remote', f.root, '--ref', 'v9.9.9'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assertCleanup(r.stdout);
});
