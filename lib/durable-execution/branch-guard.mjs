import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { normalizePortableRelativePath, resolveWithinRoot } from './paths.mjs';
import { snapshotWorkspace } from './workspace-evidence.mjs';

function refuse(code, message) {
  throw new SidekicksError(`[${code}] durable attempt policy refused: ${message}`, EXIT_VALIDATION);
}

function existingDirectory(root, path) {
  const normalized = normalizePortableRelativePath(path);
  let ancestor = root;
  // Check every component before realpath can hide an alias (including missing-target parents).
  for (const segment of normalized === '.' ? [] : normalized.split('/')) {
    ancestor = join(ancestor, segment);
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        refuse('branch-ownership-unverifiable', 'allowed paths cannot cross symbolic links or junctions');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  let target = join(root, normalized);
  for (;;) {
    try {
      const stat = lstatSync(target);
      resolveWithinRoot(root, relative(root, target).split(sep).join('/') || '.');
      return {
        cwd: stat.isDirectory() ? realpathSync(target) : dirname(realpathSync(target)),
        scan: target === join(root, normalized) && stat.isDirectory(),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(target);
      if (parent === target) throw error;
      target = parent;
    }
  }
}

function directoriesToCheck(root, path, budget) {
  const { cwd, scan } = existingDirectory(root, path);
  const owners = [cwd];
  if (!scan) return owners;
  const pending = [{ directory: cwd, depth: 0 }];
  while (pending.length) {
    const { directory, depth } = pending.pop();
    if (depth > 64) refuse('branch-ownership-unverifiable', 'allowed directory exceeds the ownership traversal depth bound');
    const handle = opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        budget.entries += 1;
        if (budget.entries > 10000) refuse('branch-ownership-unverifiable', 'allowed directories exceed the ownership traversal entry bound');
        const target = join(directory, entry.name);
        const stat = lstatSync(target);
        // Following links would widen the scope; ignoring them could hide a protected owner.
        if (stat.isSymbolicLink()) refuse('branch-ownership-unverifiable', 'allowed directory contains a symbolic link or junction');
        if (entry.name.toLowerCase() === '.git') {
          owners.push(directory);
        } else if (stat.isDirectory()) {
          pending.push({ directory: target, depth: depth + 1 });
        }
      }
    } finally { handle.closeSync(); }
  }
  return owners;
}

/** Recheck each exact allowed target's nearest Git owner at the dispatch boundary.
 * V1 has no executable protected-branch grant. Truly unversioned sandboxes have no Git owner;
 * detached, unsafe, unreadable and otherwise ambiguous Git repositories fail closed.
 */
function gitOptions() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  Object.assign(env, { LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' });
  return { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, env };
}

function discoverOwners(root, allowedPaths, run, options, additionalDirectories = []) {
  const owners = new Set();
  const budget = { entries: 0 };
  const directories = new Set(additionalDirectories);
  for (const path of allowedPaths) {
    try {
      for (const cwd of directoriesToCheck(root, path, budget)) directories.add(cwd);
    } catch (error) {
      if (error instanceof SidekicksError) throw error;
      refuse('branch-ownership-unverifiable', 'allowed directory ownership could not be inspected');
    }
  }
  for (const cwd of directories) {
    const owner = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], options);
    if (owner?.status === 128 && !owner.error && !owner.signal
        && /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/u.test(owner.stderr ?? '')) continue;
    if (!owner || owner.status !== 0 || owner.error || owner.signal
        || typeof owner.stdout !== 'string' || !isAbsolute(owner.stdout.trim())) {
      refuse('branch-ownership-unverifiable', 'Git ownership could not be verified before dispatch');
    }
    const ownerPath = realpathSync(owner.stdout.trim());
    owners.add(ownerPath);
    if (owners.size > 128) refuse('branch-ownership-unverifiable', 'Git owner count exceeds the inspection bound');
  }
  return [...owners].sort();
}

export function assertWritableBranches(root, allowedPaths, run = spawnSync) {
  const options = gitOptions();
  for (const ownerPath of discoverOwners(root, allowedPaths, run, options)) {
    const branch = run('git', ['-C', ownerPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], options);
    const name = typeof branch?.stdout === 'string' ? branch.stdout.trim() : '';
    if (!branch || branch.status !== 0 || branch.error || branch.signal || !name || /[\r\n]/u.test(name)) {
      refuse('branch-ownership-unverifiable', 'Git branch is detached or unreadable before dispatch');
    }
    if (/^(?:main|sit|uat|staging|prod|release\/.*)$/u.test(name)) {
      refuse('protected-branch-dispatch-refused', `protected branch ${name} cannot receive implementation or repair dispatch`);
    }
  }
}

const SECURITY_METADATA = new Set([
  'head', 'config', 'config.worktree', 'hooks', 'info', 'refs', 'packed-refs',
  'commondir', 'gitdir', 'shallow', 'grafts',
]);

function metadataSnapshot(directory, deadline) {
  let ancestor = parse(resolve(directory)).root;
  for (const segment of relative(ancestor, resolve(directory)).split(sep)) {
    ancestor = join(ancestor, segment);
    if (lstatSync(ancestor).isSymbolicLink()) {
      refuse('git-boundary-unverifiable', 'Git metadata location crosses a symbolic link or junction');
    }
  }
  if (!lstatSync(directory).isDirectory()) refuse('git-boundary-unverifiable', 'Git metadata root is not a real directory');
  // Git may locate linked-worktree/common metadata outside the source root. Inspect it read-only;
  // only digests leave this function, and objects/index/logs are deliberately not authority inputs.
  const excludePaths = readdirSync(directory).filter((name) => !SECURITY_METADATA.has(name.toLowerCase()));
  const snapshot = snapshotWorkspace(directory, {
    excludePaths, maxEntries: 10000, maxBytes: 16 * 1024 * 1024,
    maxDurationMs: Math.max(1, Math.floor(Math.min(5000, deadline - performance.now()))),
  });
  if (Object.values(snapshot.entries).some((entry) => entry.type === 'symlink')) {
    refuse('git-boundary-unverifiable', 'Git security metadata contains a symbolic link or junction');
  }
  return snapshot.entries;
}

/** Capture portable owner identities plus immutable security/branch evidence for settlement.
 * Source edits and staging do not change this record. Commits, branch/ref changes, and writes
 * to either worktree-local or common security metadata do. No raw metadata/path bytes escape.
 */
export function captureGitBoundaries(root, allowedPaths, run = spawnSync) {
  const options = gitOptions();
  const deadline = performance.now() + 30000;
  const checkTime = () => {
    if (performance.now() > deadline) refuse('git-boundary-unverifiable', 'Git boundary capture exceeded its time bound');
  };
  const git = (owner, args) => {
    checkTime();
    const result = run('git', ['-C', owner, ...args], options);
    if (!result || result.status !== 0 || result.error || result.signal || typeof result.stdout !== 'string') {
      refuse('git-boundary-unverifiable', 'Git authority could not be read');
    }
    return result.stdout.trim();
  };
  try {
    const canonicalRoot = realpathSync(root);
    // The workspace evidence excludes root Git metadata. Capture that owner even when all
    // approved writes belong to nested repositories, without scanning unrelated root contents.
    // This is read-only evidence, not branch authorization for writes to the enclosing owner.
    const capture = () => discoverOwners(canonicalRoot, allowedPaths, run, options, [canonicalRoot]).map((owner) => {
      checkTime();
      const path = normalizePortableRelativePath(relative(canonicalRoot, owner).split(sep).join('/') || '.');
      // Even an exact-file allowance must not hide a .git symlink from discovery.
      for (const name of readdirSync(owner).filter((entry) => entry.toLowerCase() === '.git')) {
        if (lstatSync(join(owner, name)).isSymbolicLink()) {
          refuse('git-boundary-unverifiable', 'Git ownership marker is a symbolic link or junction');
        }
      }
      const head = git(owner, ['symbolic-ref', '--quiet', 'HEAD']);
      const commit = git(owner, ['rev-parse', '--verify', 'HEAD']);
      const refs = git(owner, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
      if (!head.startsWith('refs/heads/') || /[\r\n]/u.test(head) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
        refuse('git-boundary-unverifiable', 'Git HEAD is detached or malformed');
      }
      const actual = git(owner, ['rev-parse', '--absolute-git-dir']);
      const common = resolve(owner, git(owner, ['rev-parse', '--git-common-dir']));
      if (!isAbsolute(actual)) refuse('git-boundary-unverifiable', 'Git metadata location is malformed');
      const actualEntries = metadataSnapshot(actual, deadline);
      const commonEntries = realpathSync(common) === realpathSync(actual)
        ? actualEntries : metadataSnapshot(common, deadline);
      checkTime();
      const digest = createHash('sha256').update(JSON.stringify({
        head, commit, refs, actual: realpathSync(actual), common: realpathSync(common),
        actualEntries, commonEntries,
      })).digest('hex');
      return Object.freeze({ path, digest: `sha256:${digest}` });
    }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const first = capture();
    const second = capture();
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      refuse('git-boundary-unverifiable', 'Git authority changed during capture');
    }
    return Object.freeze({ version: 1, owners: Object.freeze(second) });
  } catch (error) {
    if (error instanceof SidekicksError && error.message.includes('[git-boundary-unverifiable]')) throw error;
    refuse('git-boundary-unverifiable', 'Git authority could not be captured safely');
  }
}
