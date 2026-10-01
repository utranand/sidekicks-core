// Portable planning-time evidence derived from the shared execution-config snapshot.
//
// A complete execution snapshot is a runtime object: generic executor profiles may contain an
// absolute binary or argument path. Goal run state is a portable public artifact, so it records only
// the source revision, delivery mode, and the already-portable provenance that explains which layer
// supplied the configuration. The approved envelope remains the dispatch authority.

import { validateExecutionConfigSnapshot } from '../cli-executor-lifecycle/execution-config.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';

export const EXECUTION_OBSERVATION_SCHEMA_VERSION = 1;
export const EXECUTION_OBSERVATION_KIND = 'execution-config-observation';

const CREDENTIAL_KEY = /(?:api[-_]?key|authorization|credential|cookie|pass(?:word)?|private[-_]?key|secret|token)/i;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

function invalid(message) {
  throw new SidekicksError(`goal execution observation: ${message}`, EXIT_VALIDATION);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function assertPortable(value, label = 'provenance', key = '') {
  if (CREDENTIAL_KEY.test(key)) invalid(`${label} is credential-shaped`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortable(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      assertPortable(item, `${label}.${name}`, name);
    }
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value !== 'string') invalid(`${label} must contain only JSON values`);
  if (value.includes('\0') || /[\r\n]/.test(value)) invalid(`${label} contains a control character`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('//') || WINDOWS_DRIVE.test(value)) {
    invalid(`${label} contains an absolute path`);
  }
  if (normalized.split('/').includes('..')) invalid(`${label} contains path traversal`);
}

/** Create the portable evidence record persisted in a new goal run. */
export function executionConfigObservation(snapshot) {
  const current = validateExecutionConfigSnapshot(snapshot, { allowSecrets: true });
  const provenance = structuredClone(current.provenance);
  assertPortable(provenance);
  return Object.freeze({
    schema_version: EXECUTION_OBSERVATION_SCHEMA_VERSION,
    kind: EXECUTION_OBSERVATION_KIND,
    source_schema_version: current.schema_version,
    source_revision: current.revision,
    delivery_mode: typeof current.sections.delivery?.mode === 'string'
      ? current.sections.delivery.mode
      : null,
    provenance,
  });
}

/** Validate a stored observation without treating it as an executable configuration snapshot. */
export function validateExecutionConfigObservation(value) {
  const observation = object(value, 'observation');
  const allowed = new Set([
    'schema_version', 'kind', 'source_schema_version', 'source_revision', 'delivery_mode', 'provenance',
  ]);
  const extra = Object.keys(observation).find((key) => !allowed.has(key));
  if (extra) invalid(`unsupported field '${extra}'`);
  if (observation.schema_version !== EXECUTION_OBSERVATION_SCHEMA_VERSION) {
    invalid(`unsupported schema_version '${observation.schema_version}'`);
  }
  if (observation.kind !== EXECUTION_OBSERVATION_KIND) invalid(`kind must be '${EXECUTION_OBSERVATION_KIND}'`);
  if (!Number.isInteger(observation.source_schema_version) || observation.source_schema_version < 1) {
    invalid('source_schema_version must be a positive integer');
  }
  if (typeof observation.source_revision !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(observation.source_revision)) {
    invalid('source_revision must be a sha256 revision');
  }
  if (observation.delivery_mode !== null
    && (typeof observation.delivery_mode !== 'string' || observation.delivery_mode === '')) {
    invalid('delivery_mode must be a non-empty string or null');
  }
  object(observation.provenance, 'observation.provenance');
  assertPortable(observation.provenance);
  return Object.freeze(structuredClone(observation));
}
