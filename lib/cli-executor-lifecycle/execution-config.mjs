// A versioned, non-secret read model over delivery policy, executor registry and presets.
//
// Storage remains where the legacy lifecycle owns it.  This module intentionally projects those
// stores instead of moving or rewriting them: callers get one typed shape, while existing CLI
// commands retain their precedence and validation contracts.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { SidekicksError, EXIT_IO, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { readDeliveryPolicyProjection } from '../delivery-policy/policy.mjs';
import { readRegistryProjection } from './_shared.mjs';
import { readPresetProjection } from './presets.mjs';
import { EXECUTION_CONFIG_FILE, canonicalExecutionConfigPath, canonicalExecutionConfigRel,
  readCanonicalExecutionDocument } from '../execution-lifecycle/canonical-path.mjs';

export const EXECUTION_CONFIG_SCHEMA_VERSION = 1;
export const EXECUTION_CONFIG_SECTIONS = Object.freeze(['delivery', 'registry', 'presets']);
export { EXECUTION_CONFIG_FILE, canonicalExecutionConfigPath, canonicalExecutionConfigRel };

/** @typedef {'default'|'root'|'project'|'run'|'builtin'} ExecutionConfigSource */
/** @typedef {{schema_version: number, revision: string, sections: Record<string, unknown>, provenance: Record<string, unknown>}} ExecutionConfigSnapshot */

function invalid(message) {
  throw new SidekicksError(`execution-config: ${message}`, EXIT_VALIDATION);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

/** A deterministic revision used as the compare-and-swap token for a complete snapshot. */
export function executionConfigRevision(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

const CREDENTIAL_KEY = /(?:api[-_]?key|authorization|credential|cookie|pass(?:word)?|private[-_]?key|secret|token)/i;

/** Return a deep copy safe to persist in a run artifact or display to an operator. */
export function maskCredentials(value, key = '') {
  if (CREDENTIAL_KEY.test(key)) return '[masked]';
  if (Array.isArray(value)) return value.map((item) => maskCredentials(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskCredentials(item, name)]));
}

function sourceForRegistry(projection) {
  return {
    root: projection.layers.root.pathRel,
    project: projection.layers.project?.pathRel ?? null,
    executors: projection.effective.provenance?.executors ?? {},
    routing: projection.layers.project && projection.project?.routing ? 'project' : projection.root?.routing ? 'root' : 'builtin',
  };
}

function sourceForPresets(projection) {
  return {
    root: projection.layers.root.pathRel,
    project: projection.layers.project?.pathRel ?? null,
    presets: projection.effective.provenance?.presets ?? {},
    default_preset: projection.effective.provenance?.default_preset ?? null,
  };
}

/**
 * Resolve the three legacy stores with their existing validation and precedence.  This is the
 * runtime form; display commands redact it at their boundary, while migration rejects secrets
 * instead of replacing them with unusable placeholder values.
 *
 * @returns {ExecutionConfigSnapshot}
 */
export function resolveLegacyExecutionConfig(repoRoot, settings = {}, { runOverride, rootOnly = false, read } = {}) {
  const delivery = readDeliveryPolicyProjection(repoRoot, { runOverride, canonical: false, ...(read ? { read } : {}) });
  const registry = readRegistryProjection(repoRoot, settings, { rootOnly });
  const presets = readPresetProjection(repoRoot, settings, { rootOnly });
  const sections = {
    delivery: delivery.effective,
    registry: registry.effective,
    presets: presets.effective,
  };
  const provenance = {
    delivery: delivery.provenance,
    registry: sourceForRegistry(registry),
    presets: sourceForPresets(presets),
  };
  const base = { schema_version: EXECUTION_CONFIG_SCHEMA_VERSION, sections, provenance };
  return Object.freeze({ ...base, revision: executionConfigRevision(base) });
}

/** Read an already-migrated canonical snapshot. It is deliberately all-or-nothing. */
export function readCanonicalExecutionConfig(pathOrRepoRoot, settings = {}) {
  try {
    const raw = pathOrRepoRoot.endsWith?.(EXECUTION_CONFIG_FILE)
      ? JSON.parse(readFileSync(pathOrRepoRoot, 'utf8'))
      : readCanonicalExecutionDocument(pathOrRepoRoot, settings);
    if (!raw) invalid(`canonical snapshot ${canonicalExecutionConfigRel(pathOrRepoRoot, settings)} does not exist`);
    return validateExecutionConfigSnapshot(raw);
  } catch (err) {
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(`execution-config: cannot read canonical snapshot ${pathOrRepoRoot}: ${err.message}`, EXIT_IO);
  }
}

/** Canonical storage wins when present; legacy stores remain the one-release fallback. */
export function resolveExecutionConfig(repoRoot, settings = {}, options = {}) {
  const canonicalPath = canonicalExecutionConfigPath(repoRoot, settings);
  if (existsSync(canonicalPath)) return readCanonicalExecutionConfig(canonicalPath);
  return resolveLegacyExecutionConfig(repoRoot, settings, options);
}

/** Validate the durable, non-secret snapshot shape before a consumer accepts it. */
export function validateExecutionConfigSnapshot(value, { allowSecrets = false } = {}) {
  const snapshot = object(value, 'snapshot');
  if (snapshot.schema_version !== EXECUTION_CONFIG_SCHEMA_VERSION) {
    invalid(`unsupported schema_version '${snapshot.schema_version}'`);
  }
  object(snapshot.sections, 'snapshot.sections');
  object(snapshot.provenance, 'snapshot.provenance');
  for (const section of EXECUTION_CONFIG_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot.sections, section)) invalid(`snapshot.sections.${section} is required`);
    if (!Object.prototype.hasOwnProperty.call(snapshot.provenance, section)) invalid(`snapshot.provenance.${section} is required`);
  }
  if (!allowSecrets) rejectCredentials(snapshot.sections, 'snapshot.sections');
  const base = { schema_version: snapshot.schema_version, sections: snapshot.sections, provenance: snapshot.provenance };
  const revision = executionConfigRevision(base);
  if (typeof snapshot.revision !== 'string' || snapshot.revision !== revision) invalid('snapshot revision does not match its contents');
  return Object.freeze({ ...base, revision });
}

/**
 * Replace one section using an optimistic revision token.  Other known and future sections are
 * copied unchanged, which lets independently-developed sections share a snapshot safely.
 */
export function mutateExecutionConfigSection(snapshot, section, expectedRevision, mutate) {
  const current = validateExecutionConfigSnapshot(snapshot);
  if (typeof section !== 'string' || !section) invalid('section must be a non-empty string');
  if (typeof mutate !== 'function') invalid('mutate must be a function');
  if (expectedRevision !== current.revision) invalid('stale execution configuration; reload before writing');
  const sections = structuredClone(current.sections);
  const provenance = structuredClone(current.provenance);
  const result = mutate(structuredClone(sections[section]), structuredClone(provenance[section]));
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.prototype.hasOwnProperty.call(result, 'value')) {
    invalid('section mutation must return { value, provenance? }');
  }
  sections[section] = result.value;
  if (Object.prototype.hasOwnProperty.call(result, 'provenance')) provenance[section] = result.provenance;
  const base = { schema_version: EXECUTION_CONFIG_SCHEMA_VERSION, sections, provenance };
  return Object.freeze({ ...base, revision: executionConfigRevision(base) });
}

/** Canonical storage is deliberately non-secret; callers must use a secret-bearing legacy layer until split support exists. */
function rejectCredentials(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectCredentials(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key)) invalid(`${label}.${key} is credential-shaped; canonical execution storage is non-secret`);
    rejectCredentials(item, `${label}.${key}`);
  }
}

/**
 * Load, compare and atomically replace a persisted snapshot. Cooperative writers must pass the
 * revision they read; a stale writer is rejected before it can overwrite a newer section.
 */
export function mutateExecutionConfigFile(path, section, expectedRevision, mutate) {
  let parsed;
  try {
    parsed = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch (err) {
    throw new SidekicksError(`execution-config: cannot read ${path}: ${err.message}`, EXIT_IO);
  }
  if (!parsed) invalid(`snapshot ${path} does not exist`);
  const next = mutateExecutionConfigSection(parsed, section, expectedRevision, mutate);
  try {
    writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(`execution-config: cannot write ${path}: ${err.message}`, EXIT_IO);
  }
  return next;
}
