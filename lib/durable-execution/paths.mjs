// Portable path and filesystem-root validation for durable execution artifacts.
// Pure path normalization is shared by every schema. Filesystem resolution is read-only and
// rejects traversal or a symlink/junction whose real target escapes the expected root.

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';

export const PUBLIC_RUN_ROOT = 'artifacts/runs';
export const PRIVATE_RECEIPT_ROOT = '.sidekicks/private/execution-receipts';

function invalid(code, message) {
  throw new SidekicksError(`[${code}] durable execution path: ${message}`, EXIT_VALIDATION);
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const WIN32_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const WIN32_INVALID_RE = /[<>:"|?*\u0001-\u001f]/;

function assertPortableSegment(segment, value) {
  if (WIN32_INVALID_RE.test(segment) || /[. ]$/.test(segment) || WIN32_DEVICE_RE.test(segment)) {
    invalid('artifact-path-invalid', `non-portable path segment in ${JSON.stringify(value)}`);
  }
}

function statWithoutFollowing(target) {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    invalid('artifact-path-invalid', `path cannot be inspected (${error?.code ?? 'unknown'})`);
  }
}

/**
 * Normalize one persisted path into repo/root-relative POSIX form.
 * Backslashes are separators, never ordinary filename characters, so the same validation runs on
 * macOS and Windows. CR/LF and NUL are refused before normalization.
 */
export function normalizePortableRelativePath(value, { allowRoot = true } = {}) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    invalid('artifact-path-invalid', 'path must be a non-empty trimmed string');
  }
  if (/[\r\n\0]/.test(value)) invalid('artifact-path-invalid', 'path must not contain CR, LF, or NUL');
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')
      || /^[A-Za-z]:/.test(value) || value.startsWith('//')) {
    invalid('artifact-path-invalid', `absolute path is forbidden: ${JSON.stringify(value)}`);
  }

  const segments = value.replaceAll('\\', '/').split('/');
  const normalized = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') invalid('artifact-path-invalid', `traversal is forbidden: ${JSON.stringify(value)}`);
    assertPortableSegment(segment, value);
    normalized.push(segment);
  }
  if (normalized.length === 0) {
    if (allowRoot) return '.';
    invalid('artifact-path-invalid', 'root path is not allowed here');
  }
  return normalized.join('/');
}

/**
 * Resolve an existing artifact beneath `root`. Both the lexical and real path must remain inside
 * the real root, which rejects `..`, POSIX symlinks, and Windows junctions that escape it.
 */
export function resolveWithinRoot(root, portablePath, { mustExist = true } = {}) {
  if (typeof root !== 'string' || root === '') invalid('artifact-root-invalid', 'root must be a path');
  const normalized = normalizePortableRelativePath(portablePath);
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(lexicalRoot, normalized === '.' ? '' : normalized);
  if (!inside(lexicalRoot, lexicalTarget)) {
    invalid('artifact-path-outside-root', `${JSON.stringify(portablePath)} escapes its lexical root`);
  }

  let realRoot;
  try {
    realRoot = realpathSync(lexicalRoot);
  } catch (error) {
    invalid('artifact-root-invalid', `root cannot be resolved (${error?.code ?? 'unknown'})`);
  }

  const targetStat = statWithoutFollowing(lexicalTarget);
  if (targetStat === null) {
    if (mustExist) invalid('artifact-path-missing', `${JSON.stringify(portablePath)} does not exist`);
    const parent = resolve(lexicalTarget, '..');
    if (statWithoutFollowing(parent) === null) invalid('artifact-path-missing', 'nearest parent does not exist');
    let realParent;
    try {
      realParent = realpathSync(parent);
    } catch (error) {
      invalid('artifact-path-outside-root', `parent cannot be contained (${error?.code ?? 'unknown'})`);
    }
    if (!inside(realRoot, realParent)) {
      invalid('artifact-path-outside-root', `${JSON.stringify(portablePath)} resolves through an escaping parent`);
    }
    return lexicalTarget;
  }

  let realTarget;
  try {
    realTarget = realpathSync(lexicalTarget);
  } catch (error) {
    if (targetStat.isSymbolicLink()) {
      invalid('artifact-path-outside-root', `${JSON.stringify(portablePath)} is a dangling link whose target cannot be contained`);
    }
    invalid('artifact-path-invalid', `path cannot be resolved (${error?.code ?? 'unknown'})`);
  }
  if (!inside(realRoot, realTarget)) {
    invalid('artifact-path-outside-root', `${JSON.stringify(portablePath)} resolves outside its expected root`);
  }
  return lexicalTarget;
}
