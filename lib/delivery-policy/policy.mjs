// lib/delivery-policy/policy.mjs
//
// The provider-neutral delivery-policy foundation.  Parent engines use this module to decide
// whether implementation is kept native or delegated to the external CLI executor.  It deliberately
// does not read configuration files or select an executor: config-store owns persistence and the
// executor lifecycle owns capability/availability resolution.

import { createHash } from 'node:crypto';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { resolveBlock } from '../config-store/read.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { canonicalExecutionConfigPath, readCanonicalExecutionDocument } from '../execution-lifecycle/canonical-path.mjs';
import { existsSync } from 'node:fs';

export const DELIVERY_MODES = Object.freeze(['native', 'multi_cli']);

/**
 * Registration metadata for config-store.  The root policy is intentionally inherited by projects;
 * an individual project policy can still override it with either mode.
 */
export const DELIVERY_POLICY_FAMILY = Object.freeze({
  family: 'delivery',
  block: 'multi_cli_execution',
  scope: 'any',
  inherits_root: true,
  merge: 'whole_block',
});

function invalid(message) {
  throw new SidekicksError(`delivery policy: ${message}`, EXIT_VALIDATION);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${label} must be a non-empty string`);
  return value;
}

/**
 * Validate a scope-local delivery declaration.  Absence means "inherit/default", whereas an
 * explicit `native` deliberately suppresses a root `multi_cli` policy.
 */
export function validateDeliveryPolicy(value, { label = 'policy', allowUndefined = true } = {}) {
  if (value === undefined && allowUndefined) return null;
  if (!isObject(value)) invalid(`${label} must be an object with mode: native|multi_cli`);
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'mode')) invalid(`${label} may contain only 'mode'`);
  if (!DELIVERY_MODES.includes(value.mode)) invalid(`${label}.mode must be one of ${DELIVERY_MODES.join(', ')}`);
  return { mode: value.mode };
}

function normalizeRunOverride(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    if (!DELIVERY_MODES.includes(value)) invalid(`run override must be one of ${DELIVERY_MODES.join(', ')}`);
    return value;
  }
  return validateDeliveryPolicy(value, { label: 'run override', allowUndefined: false }).mode;
}

/**
 * Resolve the only allowed precedence.  Callers persist this result before any child preparation;
 * subsequent dispatch and resume must use that persisted value instead of calling this again.
 */
export function resolveDeliveryPolicy({ runOverride, projectPolicy, rootPolicy } = {}) {
  const run = normalizeRunOverride(runOverride);
  if (run) return Object.freeze({ mode: run, source: 'run' });

  const project = validateDeliveryPolicy(projectPolicy, { label: 'project policy' });
  if (project) return Object.freeze({ mode: project.mode, source: 'project' });

  const root = validateDeliveryPolicy(rootPolicy, { label: 'root policy' });
  if (root) return Object.freeze({ mode: root.mode, source: 'root' });

  return Object.freeze({ mode: 'native', source: 'default' });
}

/** Resolve the registered delivery block and retain config-store's layer attribution. */
export function resolveConfiguredDeliveryPolicy(repoRoot, { runOverride, read = resolveBlock, canonical = true } = {}) {
  if (normalizeRunOverride(runOverride)) return resolveDeliveryPolicy({ runOverride });
  const canonicalPath = canonicalExecutionConfigPath(repoRoot);
  if (canonical && existsSync(canonicalPath)) {
    const stored = readCanonicalExecutionDocument(repoRoot).sections.delivery;
    const policy = validateDeliveryPolicy({ mode: stored?.mode }, {
      label: 'canonical delivery policy', allowUndefined: false,
    });
    return Object.freeze({ mode: policy.mode, source: 'root' });
  }
  const resolved = read(repoRoot, DELIVERY_POLICY_FAMILY.block);
  const policy = validateDeliveryPolicy(resolved?.config, { label: 'configured delivery policy' });
  const source = resolved?.sources?.mode;
  if (!policy || source === 'skill-builtin' || source === 'skill-defaults') return Object.freeze({ mode: 'native', source: 'default' });
  if (source === 'project-config') return Object.freeze({ mode: policy.mode, source: 'project' });
  if (source === 'root-config') return Object.freeze({ mode: policy.mode, source: 'root' });
  return Object.freeze({ mode: policy.mode, source: 'default' });
}

/**
 * Project the legacy config-store result into the delivery section used by execution-config.
 * It deliberately delegates policy selection to resolveConfiguredDeliveryPolicy, preserving the
 * existing run > project > root > native precedence and its validation behaviour.
 */
export function readDeliveryPolicyProjection(repoRoot, { runOverride, read = resolveBlock, canonical = true } = {}) {
  let resolved;
  const readOnce = (...args) => {
    if (!resolved) resolved = read(...args);
    return resolved;
  };
  const effective = resolveConfiguredDeliveryPolicy(repoRoot, { runOverride, read: readOnce, canonical });
  // A run override does not consult config for its value, but its snapshot still records the
  // underlying layers for an operator inspecting why a later run resolved differently.
  if (!resolved) resolved = read(repoRoot, DELIVERY_POLICY_FAMILY.block);
  const source = effective.source === 'run' ? 'run'
    : effective.source === 'project' ? 'project'
      : effective.source === 'root' ? 'root' : 'default';
  return Object.freeze({
    effective,
    provenance: Object.freeze({ mode: source, config_source: resolved?.sources?.mode ?? 'skill-builtin' }),
    layers: resolved?.layers ?? [],
  });
}

function validateHostDiagnostic(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) invalid('binding.host must be an object or null');
  const keys = Object.keys(value);
  if (keys.some((key) => !['name', 'source'].includes(key))) invalid('binding.host may contain only name and source');
  return Object.freeze({
    name: requiredString(value.name, 'binding.host.name'),
    source: requiredString(value.source, 'binding.host.source'),
  });
}

/**
 * Validate the serializable routing facts an engine freezes at approval time.  `host` is diagnostic
 * only: no resolver may treat it as an executor eligibility constraint for automated delivery.
 */
export function validateFrozenBinding(value) {
  if (!isObject(value)) invalid('binding must be an object');
  const keys = Object.keys(value);
  const allowed = new Set(['mode', 'preset', 'preset_revision', 'executor', 'model', 'effort', 'host']);
  if (keys.some((key) => !allowed.has(key))) invalid(`binding contains an unsupported field '${keys.find((key) => !allowed.has(key))}'`);
  if (!DELIVERY_MODES.includes(value.mode)) invalid(`binding.mode must be one of ${DELIVERY_MODES.join(', ')}`);

  if (value.mode === 'native') {
    for (const key of ['preset', 'preset_revision', 'executor', 'model', 'effort']) {
      if (value[key] !== undefined && value[key] !== null) invalid(`native binding must not declare ${key}`);
    }
    return Object.freeze({ mode: 'native', host: validateHostDiagnostic(value.host) });
  }

  const effort = value.effort ?? null;
  if (effort !== null) requiredString(effort, 'binding.effort');
  return Object.freeze({
    mode: 'multi_cli',
    preset: requiredString(value.preset, 'binding.preset'),
    preset_revision: requiredString(value.preset_revision, 'binding.preset_revision'),
    executor: requiredString(value.executor, 'binding.executor'),
    model: requiredString(value.model, 'binding.model'),
    effort,
    host: validateHostDiagnostic(value.host),
  });
}

/** Return an immutable, JSON-safe copy suitable for embedding in approval state. */
export function freezeDeliveryBinding(value) {
  return validateFrozenBinding(JSON.parse(JSON.stringify(value)));
}

/**
 * Canonical digest of a binding's frozen EXECUTION fields (`mode`, `preset`, `preset_revision`,
 * `executor`, `model`, `effort`). `host` is deliberately excluded: it is diagnostic metadata only
 * (see `validateFrozenBinding`) and must never affect route identity, so re-detecting the host CLI
 * cannot invalidate an otherwise-unchanged binding.
 */
export function bindingDigest(value) {
  const { host, ...execution } = validateFrozenBinding(value);
  return `sha256:${createHash('sha256').update(canonicalJson(execution), 'utf8').digest('hex')}`;
}
