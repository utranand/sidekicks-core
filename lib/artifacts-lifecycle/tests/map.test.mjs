// lib/artifacts-lifecycle/tests/map.test.mjs
// `sidekicks artifacts map` — relocate a scope's artifacts/ tree onto a cloud folder and leave a
// directory link behind.
//
// Every case runs the real CLI in a temp repo with a temp "cloud" directory outside it. The three
// refusal gates get the most coverage, because each one exists for a failure that is silent when
// it happens for real: a tracked file deleted from the index, an unmounted cloud mount turned into
// an ordinary local directory, and two artifact histories merged by whichever copy landed last.
//
// node: stdlib + the shared artifacts test helpers only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync,
  rmSync, realpathSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sk, makeRepo, addProject, cleanup } from './helpers.mjs';

/** A temp directory OUTSIDE the repo, standing in for a mounted cloud folder. */
function makeCloudRoot() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'sk-cloud-')));
}

/** Write `content` to `<dir>/<rel>`, creating parents. */
function put(dir, rel, content) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** Recursive list of file paths below `dir`, repo-relative and sorted. */
function filesUnder(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Run git in `cwd`, asserting success. */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** Turn `dir` into a git repo with an identity, so commits work in CI. */
function initRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
}

// ── mapping an empty / absent artifacts directory ────────────────────────────

test('maps an absent artifacts directory by creating the cloud folder and linking to it', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    const target = join(cloudRoot, 'demo', 'artifacts');
    mkdirSync(join(cloudRoot, 'demo'));

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo']);
    assert.equal(r.status, 0, r.stderr);

    const link = join(root, 'projects', 'demo', 'artifacts');
    assert.ok(lstatSync(link).isSymbolicLink(), 'artifacts/ should be a link');
    assert.equal(realpathSync(readlinkSync(link)), target);
    assert.match(r.stdout, /The artifacts directory was empty/);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('an empty real artifacts directory is replaced by the link', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    mkdirSync(join(root, 'projects', 'demo', 'artifacts'));
    const target = join(cloudRoot, 'artifacts');

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(lstatSync(join(root, 'projects', 'demo', 'artifacts')).isSymbolicLink());
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── moving content ───────────────────────────────────────────────────────────

test('--yes moves the tree, verifies it at the destination, then removes the local copy', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    const local = join(proj, 'artifacts');
    put(local, 'runs/skill-a/run-1/run.json', '{"status":"done"}\n');
    put(local, 'runs/skill-a/run-1/log/out.txt', 'hello\n');
    put(local, 'notes.md', '# notes\n');
    const target = join(cloudRoot, 'artifacts');

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo', '--yes']);
    assert.equal(r.status, 0, r.stderr);

    assert.deepEqual(filesUnder(target), ['notes.md', 'runs/skill-a/run-1/log/out.txt', 'runs/skill-a/run-1/run.json']);
    assert.equal(readFileSync(join(target, 'runs/skill-a/run-1/log/out.txt'), 'utf8'), 'hello\n');
    assert.ok(lstatSync(local).isSymbolicLink(), 'the local path is now a link');
    // Reading through the link sees the moved content — the whole point of the mapping.
    assert.equal(readFileSync(join(local, 'notes.md'), 'utf8'), '# notes\n');
    assert.match(r.stdout, /Moved 3 file\(s\)/);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('without --yes it refuses and names what would be published', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    put(join(proj, 'artifacts'), 'runs/a/run.json', '{}\n');
    const target = join(cloudRoot, 'artifacts');

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /publishes 1 file\(s\)/);
    assert.match(r.stderr, /Re-run with --yes/);
    // Nothing happened.
    assert.ok(!existsSync(target));
    assert.ok(!lstatSync(join(proj, 'artifacts')).isSymbolicLink());
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── gate 1: tracked files ────────────────────────────────────────────────────

test('refuses a tree holding git-tracked files, and --yes does not override it', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    initRepo(proj);
    put(join(proj, 'artifacts'), 'kept.md', 'tracked\n');
    git(proj, ['add', 'artifacts/kept.md']);
    git(proj, ['commit', '-qm', 'add artifact']);
    const target = join(cloudRoot, 'artifacts');

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo', '--yes']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /git-TRACKED file/);
    assert.match(r.stderr, /artifacts\/kept\.md/);
    assert.match(r.stderr, /not waivable with --yes/);
    assert.ok(!lstatSync(join(proj, 'artifacts')).isSymbolicLink());
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── gate 2: an unmounted cloud folder ────────────────────────────────────────

test('refuses when the cloud parent does not exist, rather than creating a local stub', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    const target = join(cloudRoot, 'GoogleDrive-nobody', 'My Drive', 'artifacts');

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo', '--yes']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /parent of <cloud-path> does not exist/);
    assert.match(r.stderr, /MOUNT POINT/);
    assert.ok(!existsSync(join(cloudRoot, 'GoogleDrive-nobody')), 'no stub tree was created');
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('refuses a relative cloud path and one inside the repository', () => {
  const root = makeRepo();
  try {
    addProject(root, 'demo');

    const rel = sk(root, ['artifacts', 'map', 'some/where', '--project', 'demo']);
    assert.notEqual(rel.status, 0);
    assert.match(rel.stderr, /must be absolute/);

    const inside = sk(root, ['artifacts', 'map', join(root, 'elsewhere'), '--project', 'demo']);
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /inside the repository/);
  } finally { cleanup(root); }
});

// ── gate 3: two populated directories ────────────────────────────────────────

test('refuses to merge two populated artifact trees', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    put(join(proj, 'artifacts'), 'local.md', 'local\n');
    const target = join(cloudRoot, 'artifacts');
    put(target, 'remote.md', 'remote\n');

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo', '--yes']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /both directories already hold content/);
    assert.ok(existsSync(join(proj, 'artifacts', 'local.md')), 'the local tree is untouched');
    assert.ok(existsSync(join(target, 'remote.md')), 'the cloud tree is untouched');
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── idempotency and re-pointing ──────────────────────────────────────────────

test('mapping to the same target twice is a no-op; a different target is refused', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    const target = join(cloudRoot, 'artifacts');
    const other = join(cloudRoot, 'other');

    assert.equal(sk(root, ['artifacts', 'map', target, '--project', 'demo']).status, 0);

    const again = sk(root, ['artifacts', 'map', target, '--project', 'demo']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Already mapped/);

    const moved = sk(root, ['artifacts', 'map', other, '--project', 'demo']);
    assert.notEqual(moved.status, 0);
    assert.match(moved.stderr, /already mapped to a DIFFERENT target/);
    assert.match(moved.stderr, /--unmap/);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── --check ──────────────────────────────────────────────────────────────────

test('--check reports each state and writes nothing', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    const target = join(cloudRoot, 'artifacts');

    const absent = sk(root, ['artifacts', 'map', '--check', '--project', 'demo', '--json']);
    assert.notEqual(absent.status, 0, 'not mapped is a non-zero exit');
    assert.equal(JSON.parse(absent.stdout).state, 'absent');

    mkdirSync(join(proj, 'artifacts'));
    assert.equal(JSON.parse(sk(root, ['artifacts', 'map', '--check', '--project', 'demo', '--json']).stdout).state, 'local');

    assert.equal(sk(root, ['artifacts', 'map', target, '--project', 'demo']).status, 0);

    const mapped = sk(root, ['artifacts', 'map', target, '--check', '--project', 'demo', '--json']);
    assert.equal(mapped.status, 0);
    const body = JSON.parse(mapped.stdout);
    assert.equal(body.state, 'mapped');
    assert.equal(realpathSync(body.target), target);

    const elsewhere = sk(root, ['artifacts', 'map', join(cloudRoot, 'nope'), '--check', '--project', 'demo', '--json']);
    assert.notEqual(elsewhere.status, 0);
    assert.equal(JSON.parse(elsewhere.stdout).state, 'mapped-elsewhere');

    rmSync(target, { recursive: true, force: true });
    const gone = sk(root, ['artifacts', 'map', '--check', '--project', 'demo', '--json']);
    assert.equal(JSON.parse(gone.stdout).state, 'target-missing');
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('--check and --unmap together are refused', () => {
  const root = makeRepo();
  try {
    addProject(root, 'demo');
    const r = sk(root, ['artifacts', 'map', '--check', '--unmap', '--project', 'demo']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/);
  } finally { cleanup(root); }
});

// ── --unmap ──────────────────────────────────────────────────────────────────

test('--unmap restores a real local directory and leaves the cloud copy in place', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    const local = join(proj, 'artifacts');
    put(local, 'runs/a/run.json', '{"status":"done"}\n');
    put(local, 'runs/a/log.txt', 'x\n');
    const target = join(cloudRoot, 'artifacts');

    assert.equal(sk(root, ['artifacts', 'map', target, '--project', 'demo', '--yes']).status, 0);

    const r = sk(root, ['artifacts', 'map', '--unmap', '--project', 'demo']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!lstatSync(local).isSymbolicLink(), 'artifacts/ is a real directory again');
    assert.deepEqual(filesUnder(local), ['runs/a/log.txt', 'runs/a/run.json']);
    assert.ok(existsSync(join(target, 'runs/a/run.json')), 'the cloud copy is left in place');
    assert.match(r.stdout, /LEFT IN PLACE/);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('--unmap on a directory that is not mapped is refused', () => {
  const root = makeRepo();
  try {
    const proj = addProject(root, 'demo');
    mkdirSync(join(proj, 'artifacts'));
    const r = sk(root, ['artifacts', 'map', '--unmap', '--project', 'demo']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is not a mapped link/);
  } finally { cleanup(root); }
});

test('--unmap refuses when the link target has gone missing, rather than losing the path', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    const target = join(cloudRoot, 'artifacts');
    assert.equal(sk(root, ['artifacts', 'map', target, '--project', 'demo']).status, 0);
    rmSync(target, { recursive: true, force: true });

    const r = sk(root, ['artifacts', 'map', '--unmap', '--project', 'demo']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /link target .* does not exist/);
    assert.ok(lstatSync(join(root, 'projects', 'demo', 'artifacts')).isSymbolicLink(), 'the link survives');
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── the local exclude ────────────────────────────────────────────────────────

test('the machine-specific link is excluded locally, and the exclude is dropped on unmap', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    initRepo(proj);
    const target = join(cloudRoot, 'artifacts');

    assert.equal(sk(root, ['artifacts', 'map', target, '--project', 'demo']).status, 0);

    const excludeFile = join(proj, '.git', 'info', 'exclude');
    assert.match(readFileSync(excludeFile, 'utf8'), /^artifacts$/m);
    // The proof the exclude is doing its job: git no longer reports the link as untracked.
    assert.equal(git(proj, ['status', '--porcelain', '--', 'artifacts']).trim(), '');

    assert.equal(sk(root, ['artifacts', 'map', '--unmap', '--project', 'demo']).status, 0);
    assert.doesNotMatch(readFileSync(excludeFile, 'utf8'), /^artifacts$/m);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('a repo that already ignores the path needs no exclude entry', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    const proj = addProject(root, 'demo');
    initRepo(proj);
    writeFileSync(join(proj, '.gitignore'), 'artifacts\n');
    const target = join(cloudRoot, 'artifacts');

    assert.equal(sk(root, ['artifacts', 'map', target, '--project', 'demo']).status, 0);
    const excludeFile = join(proj, '.git', 'info', 'exclude');
    const body = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    assert.doesNotMatch(body, /^artifacts$/m);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── scope resolution ─────────────────────────────────────────────────────────

test('a service maps its own artifacts tree, anchored at the service ROOT not src/', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo', { withService: 'api' });
    const target = join(cloudRoot, 'artifacts');

    const r = sk(root, ['artifacts', 'map', target, '--project', 'demo', '--service', 'api', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.artifacts_dir, join(root, 'projects', 'demo', 'services', 'api', 'artifacts'));
    assert.ok(lstatSync(body.artifacts_dir).isSymbolicLink());
    assert.ok(!existsSync(join(root, 'projects', 'demo', 'services', 'api', 'src', 'artifacts')));
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('with no --project the active scope is used', () => {
  const root = makeRepo({ active_project: 'demo' });
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    const target = join(cloudRoot, 'artifacts');

    const r = sk(root, ['artifacts', 'map', target, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.artifacts_dir, join(root, 'projects', 'demo', 'artifacts'));
    assert.match(body.scope, /active scope/);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('an unknown project and a bare --service are refused', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    const target = join(cloudRoot, 'artifacts');

    const noProj = sk(root, ['artifacts', 'map', target, '--project', 'nope']);
    assert.notEqual(noProj.status, 0);
    assert.match(noProj.stderr, /no such project/);

    const noSvc = sk(root, ['artifacts', 'map', target, '--project', 'demo', '--service', 'nope']);
    assert.notEqual(noSvc.status, 0);
    assert.match(noSvc.stderr, /no such service/);

    const bare = sk(root, ['artifacts', 'map', target, '--service', 'api']);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--service needs --project/);
  } finally { cleanup(root); cleanup(cloudRoot); }
});

test('a bare invocation with no cloud path prints usage', () => {
  const root = makeRepo();
  try {
    addProject(root, 'demo');
    const r = sk(root, ['artifacts', 'map', '--project', 'demo']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage: sidekicks artifacts map <cloud-path>/);
  } finally { cleanup(root); }
});

test('the flag=value spelling is accepted for --project', () => {
  const root = makeRepo();
  const cloudRoot = makeCloudRoot();
  try {
    addProject(root, 'demo');
    const target = join(cloudRoot, 'artifacts');
    const r = sk(root, ['artifacts', 'map', target, `--project=demo`, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).artifacts_dir, join(root, 'projects', 'demo', 'artifacts'));
  } finally { cleanup(root); cleanup(cloudRoot); }
});

// ── help registration ────────────────────────────────────────────────────────

test('the verb is registered and appears in artifacts help', () => {
  const root = makeRepo();
  try {
    const r = sk(root, ['artifacts', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /map \[<cloud-path>\]/);
  } finally { cleanup(root); }
});
