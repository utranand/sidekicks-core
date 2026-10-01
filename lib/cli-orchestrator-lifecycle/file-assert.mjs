// The one built-in contained test operation. This opcode is an interpreter for a frozen
// predicate, never a program name: no shell, child process, import, network or writes occur.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveWithinRoot, normalizePortableRelativePath } from '../durable-execution/paths.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';

const MAX_BYTES = 65_536; // Version-1 opcode contract, not a configurable command runner.
function reject() {
  throw new SidekicksError('[test-command-not-contained] expected a bounded, approved regular-file SHA-256 assertion', EXIT_VALIDATION);
}
function unchanged(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function withoutLinks(root, rel) {
  let current = realpathSync(root);
  for (const segment of rel.split('/')) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink()) reject();
  }
  return current;
}

/** Exact argv: [sidekicks-file-assert-v1, cwd-relative file, sha256:<expected raw bytes>]. */
export function runReadOnlyFileAssertion({ repoRoot, cwd, test, timeoutMs, allowedPaths }) {
  const start = performance.now();
  const command = test?.command;
  if (!Array.isArray(command) || command.length !== 3 || command[0] !== 'sidekicks-file-assert-v1'
      || typeof command[1] !== 'string' || command[1].includes('\\')
      || !/^sha256:[a-f0-9]{64}$/u.test(command[2])
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Array.isArray(allowedPaths)) reject();
  let fd;
  let matches = false;
  try {
    const portable = normalizePortableRelativePath(command[1], { allowRoot: false });
    if (portable !== command[1]) reject();
    const root = realpathSync(repoRoot);
    const candidate = resolve(realpathSync(cwd), portable);
    const rel = relative(root, candidate).split(sep).join('/');
    if (normalizePortableRelativePath(rel, { allowRoot: false }) !== rel) reject();
    if (!allowedPaths.some(p => p === '.' || rel === p || rel.startsWith(`${p}/`))) reject();
    const target = resolveWithinRoot(root, rel);
    if (withoutLinks(root, rel) !== target) reject();
    const before = lstatSync(target);
    if (!before.isFile() || before.size > MAX_BYTES) reject();
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !unchanged(before, opened)) reject();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_BYTES || !unchanged(opened, fstatSync(fd))
        || !unchanged(opened, lstatSync(target)) || withoutLinks(root, rel) !== target
        || resolveWithinRoot(root, rel) !== target) reject();
    matches = `sha256:${createHash('sha256').update(bytes.subarray(0,size)).digest('hex')}` === command[2];
  } catch {
    reject(); // Never copy filesystem errors, target bytes, paths or computed hashes into output.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const duration = Math.ceil(performance.now() - start);
  const timedOut = duration > timeoutMs;
  return { exit_code: matches && !timedOut ? 0 : 1, duration_ms: duration,
    timed_out: timedOut, launch_error: false,
    stdout: matches && !timedOut ? 'file assertion passed' : 'file assertion failed', stderr: '' };
}
