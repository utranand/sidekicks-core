import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSafeForgeTarget, assertSameForgeVolume, resolveRuntime } from '../select.mjs';
import { verbIds } from '../_release-shared.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sk-target-safety-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), target = join(root, 'target');
  mkdirSync(source); mkdirSync(target);
  return { root, source, target };
}

function directoryLink(target, link) {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

const refused = action => assert.throws(action, error => error.exitCode === 2);
const haveGit = spawnSync('git', ['--version']).status === 0;
function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '--allow-empty', '-qm', 'fixture');
}

test('different Windows volumes are refused before persisting an absolute registry path', () => {
  refused(() => assertSameForgeVolume('C:\\source', 'D:\\target', win32));
  refused(() => assertSameForgeVolume('\\\\server\\one\\source', '\\\\server\\two\\target', win32));
  assert.doesNotThrow(() => assertSameForgeVolume('C:\\source', 'c:\\target', win32));
});

test('Git directory aliases cannot change source or unrelated repository metadata', { skip: !haveGit }, t => {
  const { root, source, target } = fixture(t);
  gitRepo(source);
  git(source, 'remote', 'add', 'origin', 'https://example.invalid/source.git');
  directoryLink(join(source, '.git'), join(target, '.git'));
  refused(() => assertSafeForgeTarget(source, target));
  rmSync(join(target, '.git'), { recursive: true });
  writeFileSync(join(target, '.git'), `gitdir: ${join(source, '.git')}\n`);
  refused(() => assertSafeForgeTarget(source, target));
  const other = join(root, 'other'); gitRepo(other);
  writeFileSync(join(target, '.git'), `gitdir: ${join(other, '.git')}\n`);
  refused(() => assertSafeForgeTarget(source, target));
  assert.equal(git(source, 'remote', 'get-url', 'origin'), 'https://example.invalid/source.git');
});

test('registered unrelated worktrees are allowed but source worktrees share forbidden metadata', { skip: !haveGit }, t => {
  const { root, source, target } = fixture(t);
  gitRepo(source);
  const other = join(root, 'other'); gitRepo(other);
  git(other, 'worktree', 'add', '--detach', target);
  assert.doesNotThrow(() => assertSafeForgeTarget(source, target));
  const sourceWorktree = join(root, 'source-worktree');
  git(source, 'worktree', 'add', '--detach', sourceWorktree);
  refused(() => assertSafeForgeTarget(source, sourceWorktree));
});

test('a legitimate initialized submodule retains its independent Git metadata', { skip: !haveGit }, t => {
  const { root, source } = fixture(t);
  gitRepo(source);
  const upstream = join(root, 'upstream'); gitRepo(upstream);
  git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'projects/core');
  assert.doesNotThrow(() => assertSafeForgeTarget(source, join(source, 'projects', 'core')));
});

test('forge rejects source equality, ancestor targets and copied-source descendants before writing', t => {
  const { root, source } = fixture(t);
  for (const target of [source, root, join(source, 'lib', 'new-core'), join(source, '.agents', 'skills', 'new-core'),
    join(source, 'scripts', 'nested'), join(source, '.sidekicks', 'new-core')]) {
    refused(() => assertSafeForgeTarget(source, target));
    refused(() => resolveRuntime({ write() {}, warn() {} }, source, { name: 'candidate', target }, []));
  }
});

test('ordinary sibling and excluded project/artifact destinations remain allowed', t => {
  const { source, target } = fixture(t);
  for (const candidate of [target, join(source, 'projects', 'demo', 'src'), join(source, 'artifacts', 'candidate')]) {
    assert.doesNotThrow(() => assertSafeForgeTarget(source, candidate));
  }
});

test('canonical alias to source or its ancestor cannot bypass containment', t => {
  const { root, source } = fixture(t);
  const alias = join(root, 'alias'); directoryLink(source, alias);
  refused(() => assertSafeForgeTarget(source, alias));
  refused(() => assertSafeForgeTarget(source, join(alias, 'lib', 'new-core')));
  const ancestor = join(root, 'ancestor'); directoryLink(root, ancestor);
  refused(() => assertSafeForgeTarget(source, ancestor));
});

test('an existing target link or in-source symlink parent cannot redirect writes', t => {
  const { root, source, target } = fixture(t);
  const targetLink = join(root, 'target-link'); directoryLink(target, targetLink);
  refused(() => assertSafeForgeTarget(source, targetLink));
  const escape = join(source, 'escape'); directoryLink(target, escape);
  refused(() => assertSafeForgeTarget(source, join(escape, 'new-core')));
});

test('managed destination links are refused without altering the linked directory', t => {
  const { root, source, target } = fixture(t);
  const outside = join(root, 'unrelated'); mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'user data');
  directoryLink(outside, join(target, '.agents'));
  refused(() => assertSafeForgeTarget(source, target));
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'user data');
});

test('exact internal host exposure links remain safe on a re-forge', t => {
  const { source, target } = fixture(t);
  const skills = join(target, '.agents', 'skills'); mkdirSync(skills, { recursive: true });
  for (const host of ['.claude', '.agent', '.gemini']) {
    mkdirSync(join(target, host)); directoryLink(skills, join(target, host, 'skills'));
  }
  assert.doesNotThrow(() => assertSafeForgeTarget(source, target));
});

test('an exposure link pointing outside is refused even when its name is allowed', t => {
  const { source, target } = fixture(t);
  mkdirSync(join(target, '.claude'));
  directoryLink(source, join(target, '.claude', 'skills'));
  refused(() => assertSafeForgeTarget(source, target));
});

test('instruction mirrors may link only to the target own AGENTS.md', {
  skip: process.platform === 'win32' ? 'file symlinks require Developer Mode or elevation' : false,
}, t => {
  const { source, target } = fixture(t);
  writeFileSync(join(target, 'AGENTS.md'), 'candidate instructions');
  symlinkSync('AGENTS.md', join(target, 'CLAUDE.md'));
  symlinkSync('AGENTS.md', join(target, 'GEMINI.md'));
  assert.doesNotThrow(() => assertSafeForgeTarget(source, target));
  rmSync(join(target, 'CLAUDE.md'));
  writeFileSync(join(source, 'AGENTS.md'), 'source instructions');
  symlinkSync(join(source, 'AGENTS.md'), join(target, 'CLAUDE.md'));
  refused(() => assertSafeForgeTarget(source, target));
});

test('verb inventory imports filesystem paths containing URL punctuation', async t => {
  const { root } = fixture(t);
  const dir = join(root, 'core # version');
  mkdirSync(join(dir, 'lib', 'sk-cli'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'sk-cli', 'help.mjs'), 'export const VERBS = [{namespace:"core",verb:"forge"}];\n');
  assert.deepEqual(await verbIds(dir), ['core forge']);
});
