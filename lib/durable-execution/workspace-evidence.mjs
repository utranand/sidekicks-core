// Independent, byte-exact evidence. No gitignore filtering and no provider-reported inputs.
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
  readlinkSync, realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { normalizePortableRelativePath } from './paths.mjs';

function invalid(code, message) {
  throw new SidekicksError(`[${code}] workspace evidence: ${message}`, EXIT_VALIDATION);
}

function pathList(values, allowRoot) {
  if (!Array.isArray(values)) invalid('workspace-evidence-invalid', 'paths must be an array');
  return [...new Set(values.map((value) => normalizePortableRelativePath(value, { allowRoot })))].sort();
}

function covered(path, roots) {
  return roots.some((root) => root === '.' || path === root || path.startsWith(`${root}/`));
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/**
 * Capture every entry below repoRoot except explicitly excluded subtrees. Returned evidence is
 * JSON-safe and contains only portable paths, types, modes and digests (never bytes/link targets).
 * Limits fail closed; real dependency trees are scanned, not silently omitted. Two matching scans
 * detect ordinary concurrent changes; this is evidence, not an OS sandbox against a hostile owner.
 */
export function snapshotWorkspace(repoRoot, {
  excludePaths = [], maxEntries = 100000, maxBytes = 512 * 1024 * 1024,
  maxDurationMs = 30000,
} = {}) {
  const exclusions = pathList(excludePaths, false);
  for (const value of [maxEntries, maxBytes, maxDurationMs]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      invalid('workspace-evidence-invalid', 'scan limits must be positive safe integers');
    }
  }
  const deadline = performance.now() + maxDurationMs;
  let currentPath = '.';
  const limit = () => {
    if (performance.now() > deadline) invalid('workspace-evidence-limit', 'scan duration exceeded');
  };
  try {
    const root = realpathSync(repoRoot);
    if (!lstatSync(root).isDirectory()) invalid('workspace-evidence-invalid', 'workspace root must be a directory');
    const scan = () => {
      const entries = Object.create(null);
      const identities = Object.create(null);
      let count = 0;
      let bytes = 0;
      const visit = (absolute, portable) => {
        currentPath = portable;
        limit();
        if (covered(portable, exclusions)) return;
        if (++count > maxEntries) invalid('workspace-evidence-limit', 'entry limit exceeded');
        const before = lstatSync(absolute, { bigint: true });
        const entry = { type: '', mode: Number(before.mode) & 0o7777 };
        if (before.isSymbolicLink()) {
          entry.type = 'symlink';
          entry.digest = createHash('sha256').update(readlinkSync(absolute, { encoding: 'buffer' })).digest('hex');
        } else if (before.isDirectory()) {
          entry.type = 'directory';
          for (const name of readdirSync(absolute).sort()) {
            // Ambiguous/nonportable names cannot be safely mapped into an approval envelope.
            const child = portable === '.' ? name : `${portable}/${name}`;
            if (name.includes('\\') || normalizePortableRelativePath(child) !== child) {
              invalid('workspace-evidence-invalid', 'workspace contains a nonportable entry name');
            }
            visit(join(absolute, name), child);
          }
        } else if (before.isFile()) {
          entry.type = 'file';
          if (before.size > BigInt(maxBytes - bytes)) invalid('workspace-evidence-limit', 'byte limit exceeded');
          const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
          try {
            if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) {
              invalid('workspace-evidence-unstable', `entry changed during scan: ${JSON.stringify(portable)}`);
            }
            const hash = createHash('sha256');
            const buffer = Buffer.allocUnsafe(64 * 1024);
            let size = 0;
            for (;;) {
              limit();
              const read = readSync(fd, buffer, 0, buffer.length, null);
              if (!read) break;
              bytes += read;
              size += read;
              if (bytes > maxBytes) invalid('workspace-evidence-limit', 'byte limit exceeded');
              hash.update(buffer.subarray(0, read));
            }
            if (BigInt(size) !== before.size || identity(fstatSync(fd, { bigint: true })) !== identity(before)) {
              invalid('workspace-evidence-unstable', `entry changed during scan: ${JSON.stringify(portable)}`);
            }
            entry.digest = hash.digest('hex');
          } finally {
            closeSync(fd);
          }
        } else {
          invalid('workspace-evidence-unsupported', `unsupported entry: ${JSON.stringify(portable)}`);
        }
        currentPath = portable;
        if (identity(lstatSync(absolute, { bigint: true })) !== identity(before)) {
          invalid('workspace-evidence-unstable', `entry changed during scan: ${JSON.stringify(portable)}`);
        }
        identities[portable] = identity(before);
        entries[portable] = entry;
      };
      visit(root, '.');
      return { entries, identities };
    };
    const first = scan();
    const second = scan();
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      invalid('workspace-evidence-unstable', 'workspace changed between scans');
    }
    return { version: 1, exclude_paths: exclusions, entries: second.entries };
  } catch (error) {
    if (error instanceof SidekicksError) throw error;
    // Native errors include absolute paths and may expose symlink targets. Do not forward them.
    invalid('workspace-evidence-unreadable', `cannot inspect entry: ${JSON.stringify(currentPath)}`);
  }
}

function validateSnapshot(snapshot) {
  const record = (value) => value !== null && typeof value === 'object'
    && [null, Object.prototype].includes(Object.getPrototypeOf(value));
  if (!record(snapshot) || snapshot.version !== 1
      || Object.keys(snapshot).sort().join(',') !== 'entries,exclude_paths,version'
      || !record(snapshot.entries) || !Object.hasOwn(snapshot.entries, '.')
      || snapshot.entries['.']?.type !== 'directory') {
    invalid('workspace-evidence-invalid', 'invalid snapshot');
  }
  const exclusions = pathList(snapshot.exclude_paths, false);
  if (JSON.stringify(exclusions) !== JSON.stringify(snapshot.exclude_paths)) {
    invalid('workspace-evidence-invalid', 'snapshot exclusions must be canonical');
  }
  for (const [path, entry] of Object.entries(snapshot.entries)) {
    if (normalizePortableRelativePath(path) !== path || covered(path, exclusions)
        || !record(entry) || !['file', 'directory', 'symlink'].includes(entry.type)
        || Object.keys(entry).sort().join(',') !== (entry.type === 'directory' ? 'mode,type' : 'digest,mode,type')
        || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
        || (entry.type !== 'directory' && (typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)))) {
      invalid('workspace-evidence-invalid', 'invalid snapshot entry');
    }
    if (path !== '.') {
      const slash = path.lastIndexOf('/');
      const parent = slash < 0 ? '.' : path.slice(0, slash);
      if (!Object.hasOwn(snapshot.entries, parent) || snapshot.entries[parent]?.type !== 'directory') {
        invalid('workspace-evidence-invalid', 'snapshot entry must have a real directory parent');
      }
    }
  }
  return exclusions;
}

/** Return the independently observed delta, or reject any change outside approved path roots. */
export function assertAllowedWorkspaceDelta(before, after, allowedPaths) {
  const beforeExclusions = validateSnapshot(before);
  const afterExclusions = validateSnapshot(after);
  if (JSON.stringify(beforeExclusions) !== JSON.stringify(afterExclusions)) {
    invalid('workspace-evidence-invalid', 'snapshot exclusions differ');
  }
  const allowed = pathList(allowedPaths, true);
  const delta = [];
  for (const path of [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].sort()) {
    const prior = Object.hasOwn(before.entries, path) ? before.entries[path] : undefined;
    const next = Object.hasOwn(after.entries, path) ? after.entries[path] : undefined;
    if (prior && next && prior.type === next.type && prior.mode === next.mode && prior.digest === next.digest) continue;
    delta.push({ path, change: !prior ? 'created' : !next ? 'deleted' : prior.type !== next.type ? 'type-changed' : 'modified' });
  }
  const violations = delta.filter(({ path, change }) => {
    if (covered(path, allowed)) return false;
    // An approved new file/root may need missing ancestors. Only newly created real directories
    // qualify; replacing a file/link or changing an existing ancestor's permissions never does.
    const necessaryAncestor = change === 'created' && after.entries[path].type === 'directory'
      && allowed.some((root) => root.startsWith(`${path}/`));
    return !necessaryAncestor;
  });
  if (violations.length) {
    invalid('workspace-scope-violation', `outside approved paths: ${violations.map(({ path, change }) => `${change} ${JSON.stringify(path)}`).join(', ')}`);
  }
  return delta;
}
