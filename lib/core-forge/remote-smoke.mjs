// Independent served-artifact smoke check. No publishing or public gate waivers.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { snapshotCoreTree } from './distribution.mjs';

export function runRemoteSmoke({ remote, ref }, write = text => process.stdout.write(text)) {
  if (typeof remote !== 'string' || !remote.trim() || remote.startsWith('-') || /[\r\n\0]/.test(remote)
      || typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\r\n\0]/.test(ref)) {
    throw new Error('usage: remote-smoke.mjs --remote URL --ref TAG');
  }
  const valid = spawnSync('git', ['check-ref-format', 'refs/tags/' + ref], { encoding: 'utf8' });
  if (valid.status !== 0) throw new Error('invalid tag ref: ' + ref);
  const owned = [];
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8',
      timeout: 3_600_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.code}): `
      + (result.stderr || result.stdout || result.error?.message || '').trim());
    return result.stdout || '';
  };
  try {
    for (const prefix of ['sk-remote-served-', 'sk-remote-successor-']) {
      const path = mkdtempSync(join(tmpdir(), prefix));
      owned.push(path);
      write('temporary root: ' + path + '\n');
    }
    const served = join(owned[0], 'served'), successor = join(owned[1], 'successor');
    write(`remote: ${remote}\nref: refs/tags/${ref}\nserved: ${served}\nsuccessor: ${successor}\n`);
    run('git', ['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--no-checkout',
      '--no-hardlinks', '--', remote, served], owned[0]);
    run('git', ['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--depth=1',
      'origin', 'refs/tags/' + ref], served);
    const sha = run('git', ['rev-parse', 'FETCH_HEAD^{commit}'], served).trim();
    run('git', ['checkout', '--quiet', '--detach', sha], served);
    write('served commit: ' + sha + '\n');
    const marker = JSON.parse(readFileSync(join(served, '.sidekicks-core.json'), 'utf8'));
    for (const key of ['name', 'version', 'remote', 'ref']) {
      if (typeof marker[key] !== 'string' || !marker[key]) throw new Error('served marker lacks ' + key);
    }
    write(run(process.execPath, [join(served, 'bin', 'sidekicks'), 'core', 'forge',
      '--target', successor, '--name', marker.name, '--core-version', marker.version,
      '--core-ref', marker.ref, '--remote', marker.remote, '--preset', 'framework',
      '--pack-skills', 'none', '--no-venv'], served));
    // Import the SUCCESSOR's engine. Internal depth bounds only gate 8; gates 1–7
    // run normally, including the artifact's test launcher and real mounted checks.
    const probe = `import {pathToFileURL} from 'node:url';import {join} from 'node:path';
      const {createReleaseEngine}=await import(pathToFileURL(join(process.argv[1],'lib/core-forge/release.mjs')).href);
      const result=await createReleaseEngine({repoRoot:process.cwd(),verificationDepth:1,
        flags:{target:process.argv[1],name:process.argv[2]}}).verify();
      process.stdout.write(result.stdout || '');process.stderr.write(result.stderr || '');
      process.exitCode=result.exitCode;`;
    write(run(process.execPath, ['--input-type=module', '-e', probe, successor, marker.name], served));
    const before = snapshotCoreTree(served).files, after = snapshotCoreTree(successor).files;
    if (!before.size || !after.size) throw new Error('empty artifact snapshot');
    const differences = [...new Set([...before.keys(), ...after.keys()])].sort()
      .filter(path => before.get(path) !== after.get(path));
    if (differences.length) throw new Error('masked tree mismatch: ' + differences.join(', '));
    write(`PASS: ${ref} at ${sha} forges and verifies an equivalent successor\n`);
    return { ref, sha };
  } finally {
    const failures = [];
    for (const path of owned.reverse()) {
      try { rmSync(path, { recursive: true, force: true }); write('cleanup: ' + path + '\n'); }
      catch (error) { failures.push(path + ': ' + error.message); write('cleanup FAILED: ' + path + '\n'); }
    }
    if (failures.length) throw new Error('temporary cleanup failed: ' + failures.join('; '));
  }
}

export function parseSmokeArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--remote', '--ref'].includes(key) || Object.hasOwn(flags, key.slice(2))
        || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('usage: remote-smoke.mjs --remote URL --ref TAG (no gate waivers)');
    }
    flags[key.slice(2)] = argv[i + 1];
  }
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runRemoteSmoke(parseSmokeArgs(process.argv.slice(2))); }
  catch (error) { process.stderr.write('remote smoke failed: ' + error.message + '\n'); process.exitCode = 1; }
}
