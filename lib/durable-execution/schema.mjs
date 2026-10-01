// Versioned, zero-dependency schemas for durable multi-CLI execution.
//
// This module defines documents only. It does not launch a process, mutate run state, resolve an
// executor, or read configuration. Exact bindings arrive from the canonical execution snapshot;
// this module freezes and digests them without becoming a second registry.

import { createHash } from 'node:crypto';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { canonicalJson, findAbsolutePath } from '../run-events/schema.mjs';
import { normalizePortableRelativePath } from './paths.mjs';

export const DURABLE_EXECUTION_SCHEMA_VERSION = 1;
export const QUEUE_DRIVER_ID = 'queue-supervisor/v1';
export const DURABLE_ROLES = Object.freeze(['planner', 'implementer', 'reviewer', 'advisor', 'final-verifier']);
export const INVOCATION_ROLES = Object.freeze(['plan', 'implement', 'review', 'final-verify']);
export const JOB_STATES = Object.freeze(['prepared', 'launching', 'running', 'terminal', 'unknown', 'parked']);
export const TERMINAL_CLASSIFICATIONS = Object.freeze([
  'success', 'nonzero-exit', 'launch-failure', 'timeout', 'parse-failure',
  'policy-refusal', 'cancelled', 'unknown',
]);

const DOCUMENT_FAMILIES = Object.freeze([
  'queue-approval-envelope',
  'durable-role-job',
  'launch-reservation',
  'launch-acknowledgement',
  'terminal-receipt',
  'public-attempt-result',
  'transition-receipt',
  'supervision-policy',
]);

const compatibility = Object.fromEntries(DOCUMENT_FAMILIES.map((family) => [family, {
  read_versions: [DURABLE_EXECUTION_SCHEMA_VERSION],
  write_version: DURABLE_EXECUTION_SCHEMA_VERSION,
  older_versions: 'reject-schema-version-too-old',
  future_versions: 'reject-schema-version-unsupported',
}]));
export const DOCUMENT_COMPATIBILITY = deepFreeze(compatibility);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const EXECUTOR_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SECRET_KEY_RE = /(pass(word|wd|phrase)|secret|token|api[-_]?key|private[-_]?key|credential|authorization|auth[-_]?header|bearer|cookie|access[-_]?key|client[-_]?secret|signing[-_]?key)/i;
const PUBLIC_PRIVATE_KEY_RE = /^(raw|raw_.+|payload|vendor_payload|prompt|rendered_prompt|transcript|stdout|stderr|launch_args|hostname|host|host_id|pid|process|process_id|start_token|session|session_id|session_ref)$/i;
const INLINE_RAW_KEY_RE = /^(raw|raw_.+|payload|vendor_payload|prompt|rendered_prompt|transcript|stdout|stderr|launch_args)$/i;
const EMBEDDED_PRIVATE_FIELD_RE = /["']?(?:pass(?:word|wd|phrase)|secret|token|api[-_]?key|private[-_]?key|credential|authorization|auth[-_]?header|bearer|cookie|access[-_]?key|client[-_]?secret|signing[-_]?key|raw(?:_[A-Za-z0-9_-]+)?|payload|vendor_payload|prompt|rendered_prompt|transcript|stdout|stderr|launch_args|hostname|host|host_id|pid|process|process_id|session|session_id|session_ref)["']?\s*[:=]/i;
const CREDENTIAL_VALUE_RES = Object.freeze([
  /AKIA[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/i,
]);
const GENERAL_ABSOLUTE_PATH_RE = /(?:^|[^\p{L}\p{N}._/\\-])(?:\/(?!\/)[^\s"'`<>]+|[A-Za-z]:[\\/][^\s"'`<>]*|\\\\[^\s"'`<>]+)/u;
const WEB_URL_RE = /\bhttps?:\/\/[^\s"'`<>]+/giu;
const REPLAY_SAFE_CLASSES = Object.freeze([
  'launch-failure',
  'pre-acknowledgement-refusal',
  'settled-nonzero-exit',
  'settled-policy-refusal',
]);
const STAGE_NAMES = Object.freeze([
  'planner', 'implementation', 'review', 'advisor', 'repair', 'final_verification', 'tests',
]);
const ROLE_STAGE_MAP = Object.freeze({
  planner: Object.freeze(['planner']),
  implementer: Object.freeze(['implementation', 'repair']),
  reviewer: Object.freeze(['review']),
  advisor: Object.freeze(['advisor']),
  'final-verifier': Object.freeze(['final_verification']),
});
const INVOCATION_ROLE_OF = Object.freeze({
  planner: 'plan',
  implementer: 'implement',
  reviewer: 'review',
  advisor: 'plan',
  'final-verifier': 'final-verify',
  final_verifier: 'final-verify',
});

function invalid(code, path, message) {
  throw new SidekicksError(`[${code}] ${path}: ${message}`, EXIT_VALIDATION);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  Object.freeze(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreeze(child);
  return value;
}

function closedObject(value, path, allowed) {
  if (!isObject(value)) invalid('schema-type-invalid', path, 'must be an object');
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) invalid('schema-field-unsupported', `${path}.${unknown}`, 'field is not part of this schema version');
  return value;
}

function text(value, path, { multiline = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') invalid('schema-value-invalid', path, 'must be a non-empty string');
  if (!multiline && /[\r\n]/.test(value)) invalid('schema-value-invalid', path, 'must be a single-line string');
  return value;
}

function portableText(value, path, opts) {
  const out = text(value, path, opts);
  if (out !== null && containsMachineAbsolutePath(out)) {
    invalid('artifact-path-invalid', path, 'machine-absolute paths are forbidden');
  }
  return out;
}

function containsMachineAbsolutePath(value) {
  const withoutWebUrls = value.replace(WEB_URL_RE, '');
  return findAbsolutePath(withoutWebUrls) !== null || GENERAL_ABSOLUTE_PATH_RE.test(withoutWebUrls);
}

function identifier(value, path) {
  const out = portableText(value, path);
  if (!ID_RE.test(out)) invalid('schema-value-invalid', path, 'must be a portable identifier');
  return out;
}

function digest(value, path) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) invalid('schema-value-invalid', path, 'must be sha256:<64 lowercase hex>');
  return value;
}

function integer(value, path, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) invalid('schema-value-invalid', path, `must be a safe integer >= ${min}`);
  return value;
}

function timestamp(value, path) {
  const out = text(value, path);
  if (!TIMESTAMP_RE.test(out)) invalid('schema-value-invalid', path, 'must be an RFC 3339 timestamp with an explicit offset');
  return out;
}

function enumValue(value, path, values) {
  if (!values.includes(value)) invalid('schema-value-invalid', path, `must be one of ${values.join(', ')}`);
  return value;
}

function strings(value, path, { required = false, portable = true, sort = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    invalid('schema-value-invalid', path, `must be ${required ? 'a non-empty' : 'an'} array of strings`);
  }
  const out = value.map((item, index) => portable
    ? portableText(item, `${path}[${index}]`, { multiline: false })
    : text(item, `${path}[${index}]`, { multiline: false }));
  if (new Set(out).size !== out.length) invalid('schema-value-invalid', path, 'must not contain duplicates');
  return sort ? [...out].sort() : out;
}

function paths(value, path, { required = false, sort = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    invalid('schema-value-invalid', path, `must be ${required ? 'a non-empty' : 'an'} array of paths`);
  }
  const out = value.map((item, index) => normalizePortableRelativePath(item, { allowRoot: true }, `${path}[${index}]`));
  if (new Set(out).size !== out.length) invalid('schema-value-invalid', path, 'must not contain duplicates');
  return sort ? [...out].sort() : out;
}

function scanPublic(value, path = 'document') {
  if (typeof value === 'string') {
    if (containsMachineAbsolutePath(value)) {
      invalid('artifact-path-invalid', path, 'public artifacts must not contain machine-absolute paths');
    }
    if (EMBEDDED_PRIVATE_FIELD_RE.test(value)) {
      invalid('public-evidence-private-field', path, 'embedded secret, raw, host, process, or session fields are forbidden');
    }
    if (CREDENTIAL_VALUE_RES.some((pattern) => pattern.test(value))) {
      invalid('public-evidence-private-field', path, 'credential-looking values are forbidden in public artifacts');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPublic(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const publicAuthorityReference = key === 'authorization_ref';
    if ((!publicAuthorityReference && SECRET_KEY_RE.test(key)) || PUBLIC_PRIVATE_KEY_RE.test(key)) {
      invalid('public-evidence-private-field', `${path}.${key}`, 'secret, raw, host, process, or session metadata is private');
    }
    scanPublic(child, `${path}.${key}`);
  }
}

/** Validate an arbitrary public projection against the durable redaction boundary. */
export function assertPublicDocument(value, path = 'document') {
  scanPublic(value, path);
  return value;
}

function scanPrivateReceipt(value, path = 'receipt') {
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE_RES.some((pattern) => pattern.test(value))) {
      invalid('private-receipt-secret-forbidden', path, 'credentials must not be stored inline');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanPrivateReceipt(child, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const processIncarnationToken = key === 'start_token';
    if (!processIncarnationToken && SECRET_KEY_RE.test(key)) {
      invalid('private-receipt-secret-forbidden', `${path}.${key}`, 'credentials must never be stored in a receipt');
    }
    if (INLINE_RAW_KEY_RE.test(key) && !key.endsWith('_ref')) {
      invalid('private-receipt-inline-raw-forbidden', `${path}.${key}`, 'raw data must be stored by private relative reference and digest');
    }
    scanPrivateReceipt(child, `${path}.${key}`);
  }
}

function assertVersion(kind, value) {
  const policy = DOCUMENT_COMPATIBILITY[kind];
  if (!policy) invalid('schema-family-unsupported', 'kind', `unknown document family ${JSON.stringify(kind)}`);
  const version = value?.schema_version;
  if (!Number.isInteger(version)) invalid('schema-version-unsupported', 'schema_version', 'must be an integer');
  if (version < policy.read_versions[0]) invalid('schema-version-too-old', 'schema_version', `version ${version} is not readable`);
  if (!policy.read_versions.includes(version)) invalid('schema-version-unsupported', 'schema_version', `version ${version} is not readable`);
  if (value.kind !== kind) invalid('schema-kind-mismatch', 'kind', `expected ${kind}`);
}

function normalizeContainment(value, path) {
  const v = closedObject(value, path, ['profile', 'digest', 'enforces', 'gaps']);
  return {
    profile: portableText(v.profile, `${path}.profile`),
    digest: digest(v.digest, `${path}.digest`),
    enforces: strings(v.enforces, `${path}.enforces`, { required: true, sort: true }),
    gaps: strings(v.gaps, `${path}.gaps`, { sort: true }),
  };
}

function normalizeProvenance(value, path) {
  const v = closedObject(value, path, ['source', 'preset', 'preset_revision']);
  return {
    source: portableText(v.source, `${path}.source`),
    preset: portableText(v.preset, `${path}.preset`),
    preset_revision: digest(v.preset_revision, `${path}.preset_revision`),
  };
}

/** Freeze one already-resolved execution binding. No registry lookup or defaulting occurs here. */
export function normalizeExecutionBinding(value, path = 'binding') {
  const v = closedObject(value, path, ['executor', 'model_ref', 'invoke_id', 'effort', 'role', 'containment', 'provenance']);
  if (!EXECUTOR_RE.test(String(v.executor ?? ''))) invalid('schema-value-invalid', `${path}.executor`, 'must be an exact executor id');
  if (!Object.hasOwn(v, 'effort')) invalid('schema-value-invalid', `${path}.effort`, 'must be explicitly present and may be null');
  return deepFreeze({
    executor: v.executor,
    model_ref: portableText(v.model_ref, `${path}.model_ref`),
    invoke_id: portableText(v.invoke_id, `${path}.invoke_id`),
    effort: v.effort === null ? null : portableText(v.effort, `${path}.effort`),
    role: enumValue(v.role, `${path}.role`, INVOCATION_ROLES),
    containment: normalizeContainment(v.containment, `${path}.containment`),
    provenance: normalizeProvenance(v.provenance, `${path}.provenance`),
  });
}

export function executionBindingDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(normalizeExecutionBinding(value)), 'utf8').digest('hex')}`;
}

function normalizeRetry(value, path) {
  const v = closedObject(value, path, [
    'max_attempts_per_role', 'replay_safe_classes', 'requires_terminal_receipt',
    'requires_cleanup_complete', 'requires_process_tree_terminated',
  ]);
  const replaySafeClasses = strings(v.replay_safe_classes, `${path}.replay_safe_classes`, { sort: true });
  for (const replayClass of replaySafeClasses) {
    if (!REPLAY_SAFE_CLASSES.includes(replayClass)) {
      invalid('retry-class-unsupported', `${path}.replay_safe_classes`, `${replayClass} is not replay-safe in schema v1`);
    }
  }
  for (const field of ['requires_terminal_receipt', 'requires_cleanup_complete', 'requires_process_tree_terminated']) {
    if (v[field] !== true) invalid('schema-value-invalid', `${path}.${field}`, 'v1 requires explicit true');
  }
  return {
    max_attempts_per_role: integer(v.max_attempts_per_role, `${path}.max_attempts_per_role`, { min: 1 }),
    replay_safe_classes: replaySafeClasses,
    requires_terminal_receipt: true,
    requires_cleanup_complete: true,
    requires_process_tree_terminated: true,
  };
}

function normalizeFallback(value, path) {
  const v = closedObject(value, path, ['mode', 'max_role_fallbacks', 'roles']);
  const mode = enumValue(v.mode, `${path}.mode`, ['none', 'approved-routing']);
  const count = integer(v.max_role_fallbacks, `${path}.max_role_fallbacks`);
  const roles = closedObject(v.roles, `${path}.roles`, ['planner', 'implementer', 'reviewer', 'advisor', 'final_verifier']);
  const normalizedRoles = {};
  for (const [role, candidates] of Object.entries(roles)) {
    if (!Array.isArray(candidates) || candidates.length === 0) invalid('schema-value-invalid', `${path}.roles.${role}`, 'must be a non-empty binding array');
    normalizedRoles[role] = candidates.map((candidate, index) => normalizeExecutionBinding(candidate, `${path}.roles.${role}[${index}]`));
    const expectedRole = INVOCATION_ROLE_OF[role];
    for (const [index, candidate] of normalizedRoles[role].entries()) {
      if (candidate.role !== expectedRole) {
        invalid('binding-role-mismatch', `${path}.roles.${role}[${index}].role`, `must be ${expectedRole}`);
      }
    }
  }
  if (mode === 'none' && (count !== 0 || Object.keys(normalizedRoles).length !== 0)) {
    invalid('schema-value-invalid', path, 'mode none requires zero fallbacks and no role candidates');
  }
  if (mode === 'approved-routing' && (count < 1 || Object.keys(normalizedRoles).length === 0)) {
    invalid('schema-value-invalid', path, 'approved-routing requires a positive limit and frozen candidates');
  }
  return { mode, max_role_fallbacks: count, roles: normalizedRoles };
}

function normalizeSupervisionCore(value, path) {
  const v = closedObject(value, path, ['mode', 'poll_interval_ms', 'max_idle_ms', 'retry', 'fallback', 'stop_behavior', 'notifications']);
  const notifications = closedObject(v.notifications, `${path}.notifications`, ['use_configured_run_reporting']);
  if (typeof notifications.use_configured_run_reporting !== 'boolean') {
    invalid('schema-value-invalid', `${path}.notifications.use_configured_run_reporting`, 'must be boolean');
  }
  return {
    mode: enumValue(v.mode, `${path}.mode`, ['manual', 'once', 'continuous']),
    poll_interval_ms: integer(v.poll_interval_ms, `${path}.poll_interval_ms`, { min: 1 }),
    max_idle_ms: integer(v.max_idle_ms, `${path}.max_idle_ms`, { min: 1 }),
    retry: normalizeRetry(v.retry, `${path}.retry`),
    fallback: normalizeFallback(v.fallback, `${path}.fallback`),
    stop_behavior: enumValue(v.stop_behavior, `${path}.stop_behavior`, ['settle-active-only']),
    notifications: { use_configured_run_reporting: notifications.use_configured_run_reporting },
  };
}

export function normalizeSupervisionPolicy(value) {
  scanPublic(value, 'supervision-policy');
  const v = closedObject(value, 'supervision-policy', [
    'schema_version', 'kind', 'mode', 'poll_interval_ms', 'max_idle_ms', 'retry', 'fallback',
    'stop_behavior', 'notifications',
  ]);
  assertVersion('supervision-policy', v);
  const { schema_version, kind, ...core } = v;
  return deepFreeze({ schema_version, kind, ...normalizeSupervisionCore(core, 'supervision-policy') });
}

function normalizeStageBudget(value, path) {
  const v = closedObject(value, path, ['max_calls', 'max_elapsed_ms', 'max_elapsed_ms_per_attempt']);
  const out = {
    // An unused role is deliberately budgeted at zero. Total remains positive and must cover the
    // sum of every role/test reservation, so zero disables one stage without weakening the run cap.
    max_calls: integer(v.max_calls, `${path}.max_calls`, { min: 0 }),
    max_elapsed_ms: integer(v.max_elapsed_ms, `${path}.max_elapsed_ms`, { min: 1 }),
  };
  if (Object.hasOwn(v, 'max_elapsed_ms_per_attempt')) {
    out.max_elapsed_ms_per_attempt = integer(
      v.max_elapsed_ms_per_attempt,
      `${path}.max_elapsed_ms_per_attempt`,
      { min: 1 },
    );
    if (out.max_elapsed_ms_per_attempt > out.max_elapsed_ms) {
      invalid('schema-value-invalid', `${path}.max_elapsed_ms_per_attempt`, 'must not exceed the cumulative stage limit');
    }
  }
  return out;
}

function normalizeBudgets(value, path) {
  const v = closedObject(value, path, ['total', 'stages', 'item_budget', 'failure_breaker', 'attempt_limit']);
  const total = normalizeStageBudget(v.total, `${path}.total`);
  const stages = closedObject(v.stages, `${path}.stages`, STAGE_NAMES);
  const out = {};
  for (const stage of STAGE_NAMES) {
    if (!Object.hasOwn(stages, stage)) invalid('schema-value-invalid', `${path}.stages.${stage}`, 'stage budget is required');
    out[stage] = normalizeStageBudget(stages[stage], `${path}.stages.${stage}`);
  }
  const reservedCalls = Object.values(out).reduce((sum, stage) => sum + stage.max_calls, 0);
  if (total.max_calls < reservedCalls) invalid('schema-value-invalid', `${path}.total.max_calls`, 'must cover every reserved stage call');
  const itemBudget = closedObject(v.item_budget, `${path}.item_budget`, ['max_terminal_items']);
  const breaker = closedObject(v.failure_breaker, `${path}.failure_breaker`, ['max_consecutive_item_failures', 'reset_on_item_success']);
  const attemptLimit = closedObject(v.attempt_limit, `${path}.attempt_limit`, ['max_attempts_per_item']);
  if (breaker.reset_on_item_success !== true) {
    invalid('schema-value-invalid', `${path}.failure_breaker.reset_on_item_success`, 'v1 requires an explicit true reset rule');
  }
  return {
    total,
    stages: out,
    item_budget: {
      max_terminal_items: integer(itemBudget.max_terminal_items, `${path}.item_budget.max_terminal_items`, { min: 1 }),
    },
    failure_breaker: {
      max_consecutive_item_failures: integer(
        breaker.max_consecutive_item_failures,
        `${path}.failure_breaker.max_consecutive_item_failures`,
        { min: 1 },
      ),
      reset_on_item_success: true,
    },
    attempt_limit: {
      max_attempts_per_item: integer(attemptLimit.max_attempts_per_item, `${path}.attempt_limit.max_attempts_per_item`, { min: 1 }),
    },
  };
}

function normalizeCriterion(value, path) {
  const v = closedObject(value, path, ['id', 'text']);
  return { id: identifier(v.id, `${path}.id`), text: portableText(v.text, `${path}.text`, { multiline: true }) };
}

function normalizeTest(value, path) {
  const v = closedObject(value, path, ['id', 'cwd', 'command', 'expected_exit', 'timeout_ms']);
  const command = strings(v.command, `${path}.command`, { required: true });
  return {
    id: identifier(v.id, `${path}.id`),
    cwd: normalizePortableRelativePath(v.cwd),
    command,
    expected_exit: integer(v.expected_exit, `${path}.expected_exit`),
    timeout_ms: integer(v.timeout_ms, `${path}.timeout_ms`, { min: 1 }),
  };
}

function normalizeReferenceIdentity(value, path) {
  const v = closedObject(value, path, ['path', 'content_digest']);
  return {
    path: normalizePortableRelativePath(v.path, { allowRoot: false }),
    content_digest: digest(v.content_digest, `${path}.content_digest`),
  };
}

function normalizeNodeScope(value, path) {
  const v = closedObject(value, path, [
    'node_id', 'source_ordinal', 'goal', 'instructions', 'work_dir', 'file_refs', 'allowed_paths',
    'dependencies', 'artifact_expectations',
  ]);
  if (!Array.isArray(v.file_refs)) invalid('schema-value-invalid', `${path}.file_refs`, 'must be an array');
  const fileRefs = v.file_refs.map((entry, index) => normalizeReferenceIdentity(entry, `${path}.file_refs[${index}]`));
  if (new Set(fileRefs.map((entry) => entry.path)).size !== fileRefs.length) {
    invalid('schema-value-invalid', `${path}.file_refs`, 'reference paths must be unique');
  }
  const out = {
    node_id: identifier(v.node_id, `${path}.node_id`),
    source_ordinal: integer(v.source_ordinal, `${path}.source_ordinal`),
    work_dir: normalizePortableRelativePath(v.work_dir),
    file_refs: fileRefs,
    allowed_paths: paths(v.allowed_paths, `${path}.allowed_paths`, { required: true, sort: true }),
    dependencies: strings(v.dependencies, `${path}.dependencies`, { sort: true }),
  };
  if (Object.hasOwn(v, 'goal')) out.goal = portableText(v.goal, `${path}.goal`, { multiline: true });
  if (Object.hasOwn(v, 'instructions')) {
    out.instructions = strings(v.instructions, `${path}.instructions`, { required: true });
  }
  if (Object.hasOwn(v, 'artifact_expectations')) {
    if (!Array.isArray(v.artifact_expectations) || v.artifact_expectations.length === 0) {
      invalid('schema-value-invalid', `${path}.artifact_expectations`, 'must be a non-empty array');
    }
    out.artifact_expectations = v.artifact_expectations.map((entry, index) => {
      const itemPath = `${path}.artifact_expectations[${index}]`;
      const expectation = closedObject(entry, itemPath, ['path', 'kind', 'exists', 'allow_empty', 'touch']);
      if (expectation.kind !== 'file' || expectation.exists !== true
          || expectation.allow_empty !== false || expectation.touch !== 'run') {
        invalid('queue-output-semantics-unsupported', itemPath,
          'v1 supports only a non-empty file that must exist and be touched by this run');
      }
      return {
        path: normalizePortableRelativePath(expectation.path, { allowRoot: false }),
        kind: 'file', exists: true, allow_empty: false, touch: 'run',
      };
    });
  }
  return out;
}

function normalizeFraming(value, path) {
  const v = closedObject(value, path, [
    'goal', 'instructions', 'scope', 'dependencies', 'criteria', 'tests',
    'node_scopes', 'evidence_policy', 'prompt_template_policy',
  ]);
  const scope = closedObject(v.scope, `${path}.scope`, ['project', 'service', 'work_dir', 'file_refs', 'allowed_paths']);
  const evidence = closedObject(v.evidence_policy, `${path}.evidence_policy`, ['allowed_classes', 'max_items_per_attempt']);
  const template = closedObject(v.prompt_template_policy, `${path}.prompt_template_policy`, ['template_id', 'template_version', 'repair_mode']);
  if (!Array.isArray(v.criteria) || v.criteria.length === 0) invalid('schema-value-invalid', `${path}.criteria`, 'must be non-empty');
  if (!Array.isArray(v.tests) || v.tests.length === 0) invalid('schema-value-invalid', `${path}.tests`, 'must be non-empty');
  const criteria = v.criteria.map((criterion, index) => normalizeCriterion(criterion, `${path}.criteria[${index}]`));
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) invalid('schema-value-invalid', `${path}.criteria`, 'criterion ids must be unique');
  if (!Array.isArray(v.node_scopes) || v.node_scopes.length === 0) {
    invalid('schema-value-invalid', `${path}.node_scopes`, 'must be a non-empty array');
  }
  const nodeScopes = v.node_scopes.map((entry, index) => normalizeNodeScope(entry, `${path}.node_scopes[${index}]`));
  if (new Set(nodeScopes.map((entry) => entry.node_id)).size !== nodeScopes.length) {
    invalid('schema-value-invalid', `${path}.node_scopes`, 'node ids must be unique');
  }
  if (new Set(nodeScopes.map((entry) => entry.source_ordinal)).size !== nodeScopes.length) {
    invalid('schema-value-invalid', `${path}.node_scopes`, 'source ordinals must be unique');
  }
  const nodeIds = new Set(nodeScopes.map((entry) => entry.node_id));
  for (const node of nodeScopes) {
    for (const dependency of node.dependencies) {
      if (dependency === node.node_id || !nodeIds.has(dependency)) {
        invalid('schema-value-invalid', `${path}.node_scopes.${node.node_id}.dependencies`, 'must reference another approved node');
      }
    }
  }
  return {
    goal: portableText(v.goal, `${path}.goal`, { multiline: true }),
    instructions: strings(v.instructions, `${path}.instructions`, { required: true }),
    scope: {
      project: portableText(scope.project, `${path}.scope.project`),
      service: scope.service === null ? null : portableText(scope.service, `${path}.scope.service`),
      work_dir: normalizePortableRelativePath(scope.work_dir),
      file_refs: paths(scope.file_refs, `${path}.scope.file_refs`),
      allowed_paths: paths(scope.allowed_paths, `${path}.scope.allowed_paths`, { required: true, sort: true }),
    },
    dependencies: strings(v.dependencies, `${path}.dependencies`),
    node_scopes: nodeScopes,
    criteria,
    tests: v.tests.map((entry, index) => normalizeTest(entry, `${path}.tests[${index}]`)),
    evidence_policy: {
      allowed_classes: strings(evidence.allowed_classes, `${path}.evidence_policy.allowed_classes`, { required: true, sort: true }),
      max_items_per_attempt: integer(evidence.max_items_per_attempt, `${path}.evidence_policy.max_items_per_attempt`, { min: 1 }),
    },
    prompt_template_policy: {
      template_id: portableText(template.template_id, `${path}.prompt_template_policy.template_id`),
      template_version: integer(template.template_version, `${path}.prompt_template_policy.template_version`, { min: 1 }),
      repair_mode: enumValue(template.repair_mode, `${path}.prompt_template_policy.repair_mode`, ['evidence-only']),
    },
  };
}

function normalizeAuthority(value, path, allowedEvidence) {
  const v = closedObject(value, path, ['scope_revision', 'allowed_evidence_classes', 'held_action_classes', 'grants']);
  const evidence = strings(v.allowed_evidence_classes, `${path}.allowed_evidence_classes`, { required: true, sort: true });
  if (canonicalJson(evidence) !== canonicalJson(allowedEvidence)) {
    invalid('schema-value-invalid', `${path}.allowed_evidence_classes`, 'must equal framing.evidence_policy.allowed_classes');
  }
  if (!Array.isArray(v.grants)) invalid('schema-value-invalid', `${path}.grants`, 'must be an array');
  if (v.grants.length !== 0) invalid('held-action-unsupported', `${path}.grants`, 'Phase 1 admits no executable held-action grants');
  return {
    scope_revision: digest(v.scope_revision, `${path}.scope_revision`),
    allowed_evidence_classes: evidence,
    held_action_classes: strings(v.held_action_classes, `${path}.held_action_classes`, { required: true, sort: true }),
    grants: [],
  };
}

function normalizeApprovalProvenance(value, path, { includeApprovedBy = true } = {}) {
  const allowed = includeApprovedBy
    ? ['authorization_ref', 'approved_by', 'approved_at', 'request_digest']
    : ['authorization_ref', 'request_digest'];
  const v = closedObject(value, path, allowed);
  const out = {
    authorization_ref: portableText(v.authorization_ref, `${path}.authorization_ref`),
    request_digest: digest(v.request_digest, `${path}.request_digest`),
  };
  if (includeApprovedBy) {
    out.approved_by = enumValue(v.approved_by, `${path}.approved_by`, ['human']);
    out.approved_at = timestamp(v.approved_at, `${path}.approved_at`);
  }
  return out;
}

export function normalizeApprovalEnvelope(value) {
  scanPublic(value, 'approval-envelope');
  const v = closedObject(value, 'approval-envelope', [
    'schema_version', 'kind', 'driver', 'run_id', 'execution_revision', 'source_digest',
    'framing', 'routing', 'supervision', 'budgets', 'authority', 'approval_provenance', 'display',
  ]);
  assertVersion('queue-approval-envelope', v);
  if (v.driver !== QUEUE_DRIVER_ID) invalid('driver-ownership-conflict', 'approval-envelope.driver', `must be ${QUEUE_DRIVER_ID}`);
  const framing = normalizeFraming(v.framing, 'approval-envelope.framing');
  const routing = closedObject(v.routing, 'approval-envelope.routing', ['planner', 'implementer', 'reviewer', 'advisor', 'final_verifier']);
  const normalizedRouting = {};
  for (const seat of ['planner', 'implementer', 'reviewer', 'advisor', 'final_verifier']) {
    if (!Object.hasOwn(routing, seat)) invalid('queue-role-binding-missing', `approval-envelope.routing.${seat}`, 'binding is required');
    normalizedRouting[seat] = normalizeExecutionBinding(routing[seat], `approval-envelope.routing.${seat}`);
    if (normalizedRouting[seat].role !== INVOCATION_ROLE_OF[seat]) {
      invalid('binding-role-mismatch', `approval-envelope.routing.${seat}.role`, `must be ${INVOCATION_ROLE_OF[seat]}`);
    }
  }
  const display = closedObject(v.display, 'approval-envelope.display', ['title', 'summary', 'updated_at']);
  const out = {
    schema_version: v.schema_version,
    kind: v.kind,
    driver: v.driver,
    run_id: identifier(v.run_id, 'approval-envelope.run_id'),
    execution_revision: digest(v.execution_revision, 'approval-envelope.execution_revision'),
    source_digest: digest(v.source_digest, 'approval-envelope.source_digest'),
    framing,
    routing: normalizedRouting,
    supervision: normalizeSupervisionCore(v.supervision, 'approval-envelope.supervision'),
    budgets: normalizeBudgets(v.budgets, 'approval-envelope.budgets'),
    authority: normalizeAuthority(v.authority, 'approval-envelope.authority', framing.evidence_policy.allowed_classes),
    approval_provenance: normalizeApprovalProvenance(v.approval_provenance, 'approval-envelope.approval_provenance'),
    display: {
      title: portableText(display.title, 'approval-envelope.display.title'),
      summary: portableText(display.summary, 'approval-envelope.display.summary', { multiline: true }),
      updated_at: timestamp(display.updated_at, 'approval-envelope.display.updated_at'),
    },
  };
  return deepFreeze(out);
}

function approvalProjection(value) {
  const { display, ...bound } = normalizeApprovalEnvelope(value);
  return bound;
}

export function approvalEnvelopeDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(approvalProjection(value)), 'utf8').digest('hex')}`;
}

export function assertApprovalStillValid(approvedDigest, candidate) {
  digest(approvedDigest, 'approved_digest');
  const actual = approvalEnvelopeDigest(candidate);
  if (actual !== approvedDigest) invalid('approval-framing-drift', 'approval-envelope', `approved ${approvedDigest}, actual ${actual}`);
  return true;
}

export function renderedPromptDigest(renderedPrompt) {
  if (typeof renderedPrompt !== 'string' || renderedPrompt === '') invalid('schema-value-invalid', 'rendered_prompt', 'must be non-empty UTF-8 text');
  if (renderedPrompt.includes('\0')) invalid('schema-value-invalid', 'rendered_prompt', 'must not contain NUL');
  return `sha256:${createHash('sha256').update(renderedPrompt, 'utf8').digest('hex')}`;
}

function normalizeAttemptEvidence(evidence, normalized) {
  if (!Array.isArray(evidence)) invalid('schema-value-invalid', 'attempt.evidence', 'must be an array');
  if (evidence.length > normalized.framing.evidence_policy.max_items_per_attempt) {
    invalid('schema-value-invalid', 'attempt.evidence', 'exceeds approved evidence limit');
  }
  const allowed = new Set(normalized.framing.evidence_policy.allowed_classes);
  return evidence.map((entry, index) => {
    const v = closedObject(entry, `attempt.evidence[${index}]`, ['class', 'digest']);
    const evidenceClass = portableText(v.class, `attempt.evidence[${index}].class`);
    if (!allowed.has(evidenceClass)) {
      invalid('approval-evidence-class-not-allowed', `attempt.evidence[${index}].class`, `${evidenceClass} is not approved`);
    }
    return { class: evidenceClass, digest: digest(v.digest, `attempt.evidence[${index}].digest`) };
  });
}

function normalizeAttemptContext({ approval, node_id: nodeId, role, stage, evidence }) {
  const normalized = normalizeApprovalEnvelope(approval);
  const normalizedNodeId = identifier(nodeId, 'attempt.node_id');
  const node = normalized.framing.node_scopes.find((candidate) => candidate.node_id === normalizedNodeId);
  if (!node) invalid('approval-node-unknown', 'attempt.node_id', `${normalizedNodeId} is not an approved node`);
  if (!DURABLE_ROLES.includes(role)) invalid('schema-value-invalid', 'attempt.role', 'unknown durable role');
  if (!STAGE_NAMES.includes(stage)) invalid('schema-value-invalid', 'attempt.stage', 'unknown budget stage');
  if (!ROLE_STAGE_MAP[role].includes(stage)) {
    invalid('job-role-stage-mismatch', 'attempt.stage', `${stage} is not valid for ${role}`);
  }
  return { normalized, node, evidenceRefs: normalizeAttemptEvidence(evidence, normalized) };
}

/** Deterministically render only the approved framing, binding and typed evidence references. */
export function renderApprovedAttemptPrompt({ approval, node_id: nodeId, role, stage, evidence }) {
  const { normalized, node, evidenceRefs } = normalizeAttemptContext({
    approval, node_id: nodeId, role, stage, evidence,
  });
  const seat = role === 'final-verifier' ? 'final_verifier' : role;
  const { node_scopes: _allNodeScopes, scope: runScope, ...commonFraming } = normalized.framing;
  const payload = {
    template: normalized.framing.prompt_template_policy,
    driver: normalized.driver,
    run_id: normalized.run_id,
    role,
    stage,
    approval_digest: approvalEnvelopeDigest(normalized),
    binding: normalized.routing[seat],
    framing: {
      ...commonFraming,
      run_scope: { project: runScope.project, service: runScope.service },
      node,
    },
    evidence: evidenceRefs,
  };
  return `SIDEKICKS DURABLE ATTEMPT V1\n${canonicalJson(payload)}\n`;
}

export function buildAttemptPromptRecord({ approval, node_id: nodeId, role, stage, evidence, rendered_prompt: renderedPrompt }) {
  const { normalized, node, evidenceRefs } = normalizeAttemptContext({
    approval, node_id: nodeId, role, stage, evidence,
  });
  const approvedPrompt = renderApprovedAttemptPrompt({
    approval: normalized, node_id: node.node_id, role, stage, evidence: evidenceRefs,
  });
  if (renderedPrompt !== undefined && renderedPrompt !== approvedPrompt) {
    invalid('rendered-prompt-policy-drift', 'attempt.rendered_prompt', 'does not match the approved deterministic template');
  }
  return deepFreeze({
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'rendered-attempt-prompt',
    driver: QUEUE_DRIVER_ID,
    node_id: node.node_id,
    role,
    stage,
    approval_digest: approvalEnvelopeDigest(normalized),
    binding_digest: executionBindingDigest(normalized.routing[role === 'final-verifier' ? 'final_verifier' : role]),
    evidence: evidenceRefs,
    rendered_prompt_digest: renderedPromptDigest(approvedPrompt),
  });
}

export function normalizeDurableJob(value) {
  scanPublic(value, 'durable-job');
  const v = closedObject(value, 'durable-job', [
    'schema_version', 'kind', 'driver', 'run_id', 'node_id', 'role', 'stage', 'attempt_id',
    'idempotency_key', 'state', 'approval_digest', 'approved_framing_digest',
    'rendered_prompt_digest', 'binding', 'work_dir', 'file_refs', 'allowed_paths', 'budget',
    'source_ordinal', 'file_ref_identities', 'approval_provenance', 'terminal_receipt_id', 'public_result_ref',
  ]);
  assertVersion('durable-role-job', v);
  if (v.driver !== QUEUE_DRIVER_ID) invalid('driver-ownership-conflict', 'durable-job.driver', `must be ${QUEUE_DRIVER_ID}`);
  const budget = closedObject(v.budget, 'durable-job.budget', ['stage', 'max_calls', 'max_elapsed_ms', 'attempt_ordinal']);
  const role = enumValue(v.role, 'durable-job.role', DURABLE_ROLES);
  const stage = enumValue(v.stage, 'durable-job.stage', STAGE_NAMES);
  if (!ROLE_STAGE_MAP[role].includes(stage)) invalid('job-role-stage-mismatch', 'durable-job.stage', `${stage} is not valid for ${role}`);
  const binding = normalizeExecutionBinding(v.binding, 'durable-job.binding');
  const expectedBindingRole = INVOCATION_ROLE_OF[role];
  if (binding.role !== expectedBindingRole) {
    invalid('binding-role-mismatch', 'durable-job.binding.role', `must be ${expectedBindingRole}`);
  }
  const budgetStage = enumValue(budget.stage, 'durable-job.budget.stage', STAGE_NAMES);
  if (budgetStage !== stage) {
    invalid('job-budget-stage-mismatch', 'durable-job.budget.stage', `must equal durable-job.stage (${stage})`);
  }
  const maxCalls = integer(budget.max_calls, 'durable-job.budget.max_calls', { min: 1 });
  const attemptOrdinal = integer(budget.attempt_ordinal, 'durable-job.budget.attempt_ordinal', { min: 1 });
  if (attemptOrdinal > maxCalls) {
    invalid('job-budget-exhausted', 'durable-job.budget.attempt_ordinal', 'must not exceed max_calls');
  }
  return deepFreeze({
    schema_version: v.schema_version,
    kind: v.kind,
    driver: v.driver,
    run_id: identifier(v.run_id, 'durable-job.run_id'),
    node_id: identifier(v.node_id, 'durable-job.node_id'),
    role,
    stage,
    attempt_id: identifier(v.attempt_id, 'durable-job.attempt_id'),
    idempotency_key: identifier(v.idempotency_key, 'durable-job.idempotency_key'),
    state: enumValue(v.state, 'durable-job.state', JOB_STATES),
    approval_digest: digest(v.approval_digest, 'durable-job.approval_digest'),
    approved_framing_digest: digest(v.approved_framing_digest, 'durable-job.approved_framing_digest'),
    rendered_prompt_digest: digest(v.rendered_prompt_digest, 'durable-job.rendered_prompt_digest'),
    binding,
    work_dir: normalizePortableRelativePath(v.work_dir),
    source_ordinal: integer(v.source_ordinal, 'durable-job.source_ordinal'),
    file_refs: paths(v.file_refs, 'durable-job.file_refs'),
    file_ref_identities: (() => {
      if (!Array.isArray(v.file_ref_identities)) {
        invalid('schema-value-invalid', 'durable-job.file_ref_identities', 'must be an array');
      }
      const identities = v.file_ref_identities.map((entry, index) => normalizeReferenceIdentity(
        entry,
        `durable-job.file_ref_identities[${index}]`,
      ));
      if (canonicalJson(identities.map((entry) => entry.path)) !== canonicalJson(paths(v.file_refs, 'durable-job.file_refs'))) {
        invalid('schema-value-invalid', 'durable-job.file_ref_identities', 'must identify every file_refs path in order');
      }
      return identities;
    })(),
    allowed_paths: paths(v.allowed_paths, 'durable-job.allowed_paths', { required: true, sort: true }),
    budget: {
      stage: budgetStage,
      max_calls: maxCalls,
      max_elapsed_ms: integer(budget.max_elapsed_ms, 'durable-job.budget.max_elapsed_ms', { min: 1 }),
      attempt_ordinal: attemptOrdinal,
    },
    approval_provenance: normalizeApprovalProvenance(v.approval_provenance, 'durable-job.approval_provenance', { includeApprovedBy: false }),
    terminal_receipt_id: v.terminal_receipt_id === null ? null : identifier(v.terminal_receipt_id, 'durable-job.terminal_receipt_id'),
    public_result_ref: v.public_result_ref === null ? null : normalizePortableRelativePath(v.public_result_ref),
  });
}

export function normalizeLaunchReservation(value) {
  scanPublic(value, 'launch-reservation');
  const v = closedObject(value, 'launch-reservation', [
    'schema_version', 'kind', 'driver', 'reservation_id', 'run_id', 'node_id', 'attempt_id',
    'job_digest', 'expected_receipt_id', 'reserved_at',
  ]);
  assertVersion('launch-reservation', v);
  if (v.driver !== QUEUE_DRIVER_ID) invalid('driver-ownership-conflict', 'launch-reservation.driver', `must be ${QUEUE_DRIVER_ID}`);
  return deepFreeze({
    ...v,
    reservation_id: identifier(v.reservation_id, 'launch-reservation.reservation_id'),
    run_id: identifier(v.run_id, 'launch-reservation.run_id'),
    node_id: identifier(v.node_id, 'launch-reservation.node_id'),
    attempt_id: identifier(v.attempt_id, 'launch-reservation.attempt_id'),
    job_digest: digest(v.job_digest, 'launch-reservation.job_digest'),
    expected_receipt_id: identifier(v.expected_receipt_id, 'launch-reservation.expected_receipt_id'),
    reserved_at: timestamp(v.reserved_at, 'launch-reservation.reserved_at'),
  });
}

function normalizeProcessIdentity(value, path) {
  const v = closedObject(value, path, [
    'host_id', 'pid', 'start_token', 'session_ref', 'observed_state', 'observed_at',
  ]);
  return {
    host_id: identifier(v.host_id, `${path}.host_id`),
    pid: integer(v.pid, `${path}.pid`, { min: 1 }),
    start_token: identifier(v.start_token, `${path}.start_token`),
    session_ref: identifier(v.session_ref, `${path}.session_ref`),
    observed_state: enumValue(v.observed_state, `${path}.observed_state`, ['live', 'dead', 'unknown']),
    observed_at: timestamp(v.observed_at, `${path}.observed_at`),
  };
}

function normalizeProcess(value, path) {
  const v = closedObject(value, path, ['worker', 'provider_state', 'provider']);
  const providerState = enumValue(v.provider_state, `${path}.provider_state`, ['known', 'unknown', 'not-applicable']);
  if (providerState === 'known' && !isObject(v.provider)) {
    invalid('schema-value-invalid', `${path}.provider`, 'known provider requires a distinct identity');
  }
  if (providerState !== 'known' && v.provider !== null) {
    invalid('schema-value-invalid', `${path}.provider`, `${providerState} provider state requires null identity`);
  }
  return {
    worker: normalizeProcessIdentity(v.worker, `${path}.worker`),
    provider_state: providerState,
    provider: v.provider === null ? null : normalizeProcessIdentity(v.provider, `${path}.provider`),
  };
}

export function normalizeLaunchAcknowledgement(value) {
  scanPrivateReceipt(value, 'launch-acknowledgement');
  const v = closedObject(value, 'launch-acknowledgement', [
    'schema_version', 'kind', 'driver', 'reservation_id', 'run_id', 'attempt_id',
    'state', 'process', 'acknowledged_at',
  ]);
  assertVersion('launch-acknowledgement', v);
  if (v.driver !== QUEUE_DRIVER_ID) invalid('driver-ownership-conflict', 'launch-acknowledgement.driver', `must be ${QUEUE_DRIVER_ID}`);
  const state = enumValue(v.state, 'launch-acknowledgement.state', ['acknowledged', 'unknown', 'refused']);
  if (state === 'acknowledged' && !isObject(v.process)) {
    invalid('schema-value-invalid', 'launch-acknowledgement.process', 'acknowledged launch requires bounded process identity');
  }
  if (state === 'refused' && v.process !== null) {
    invalid('schema-value-invalid', 'launch-acknowledgement.process', 'refused launch must not claim a process identity');
  }
  return deepFreeze({
    ...v,
    reservation_id: identifier(v.reservation_id, 'launch-acknowledgement.reservation_id'),
    run_id: identifier(v.run_id, 'launch-acknowledgement.run_id'),
    attempt_id: identifier(v.attempt_id, 'launch-acknowledgement.attempt_id'),
    state,
    process: v.process === null ? null : normalizeProcess(v.process, 'launch-acknowledgement.process'),
    acknowledged_at: timestamp(v.acknowledged_at, 'launch-acknowledgement.acknowledged_at'),
  });
}

export function normalizeTerminalReceipt(value) {
  scanPrivateReceipt(value, 'terminal-receipt');
  const v = closedObject(value, 'terminal-receipt', [
    'schema_version', 'kind', 'driver', 'receipt_id', 'run_id', 'node_id', 'attempt_id',
    'reservation_id', 'job_digest', 'approval_digest', 'binding_digest', 'rendered_prompt_digest',
    'classification', 'exit_code', 'cleanup', 'result_digest', 'raw_result_ref', 'transcript_ref',
    'process', 'terminal_at',
  ]);
  assertVersion('terminal-receipt', v);
  if (v.driver !== QUEUE_DRIVER_ID) invalid('driver-ownership-conflict', 'terminal-receipt.driver', `must be ${QUEUE_DRIVER_ID}`);
  if (v.exit_code !== null && (!Number.isInteger(v.exit_code) || v.exit_code < 0)) {
    invalid('schema-value-invalid', 'terminal-receipt.exit_code', 'must be null or an integer >= 0');
  }
  const classification = enumValue(v.classification, 'terminal-receipt.classification', TERMINAL_CLASSIFICATIONS);
  if (classification === 'success' && v.exit_code !== 0) {
    invalid('schema-value-invalid', 'terminal-receipt.exit_code', 'success requires exit code 0');
  }
  if (classification === 'nonzero-exit' && (v.exit_code === null || v.exit_code === 0)) {
    invalid('schema-value-invalid', 'terminal-receipt.exit_code', 'nonzero-exit requires a non-zero exit code');
  }
  const cleanup = enumValue(v.cleanup, 'terminal-receipt.cleanup', ['not-required', 'complete', 'incomplete', 'unknown']);
  if (classification === 'success' && !['not-required', 'complete'].includes(cleanup)) {
    invalid('schema-value-invalid', 'terminal-receipt.cleanup', 'success requires cleanup to be not-required or complete');
  }
  return deepFreeze({
    schema_version: v.schema_version, kind: v.kind, driver: v.driver,
    receipt_id: identifier(v.receipt_id, 'terminal-receipt.receipt_id'),
    run_id: identifier(v.run_id, 'terminal-receipt.run_id'),
    node_id: identifier(v.node_id, 'terminal-receipt.node_id'),
    attempt_id: identifier(v.attempt_id, 'terminal-receipt.attempt_id'),
    reservation_id: identifier(v.reservation_id, 'terminal-receipt.reservation_id'),
    job_digest: digest(v.job_digest, 'terminal-receipt.job_digest'),
    approval_digest: digest(v.approval_digest, 'terminal-receipt.approval_digest'),
    binding_digest: digest(v.binding_digest, 'terminal-receipt.binding_digest'),
    rendered_prompt_digest: digest(v.rendered_prompt_digest, 'terminal-receipt.rendered_prompt_digest'),
    classification,
    exit_code: v.exit_code,
    cleanup,
    result_digest: digest(v.result_digest, 'terminal-receipt.result_digest'),
    raw_result_ref: v.raw_result_ref === null ? null : normalizePortableRelativePath(v.raw_result_ref, { allowRoot: false }),
    transcript_ref: v.transcript_ref === null ? null : normalizePortableRelativePath(v.transcript_ref, { allowRoot: false }),
    process: v.process === null ? null : normalizeProcess(v.process, 'terminal-receipt.process'),
    terminal_at: timestamp(v.terminal_at, 'terminal-receipt.terminal_at'),
  });
}

export function normalizePublicResult(value) {
  scanPublic(value, 'public-result');
  const v = closedObject(value, 'public-result', [
    'schema_version', 'kind', 'driver', 'receipt_id', 'run_id', 'node_id', 'attempt_id', 'role',
    'classification', 'outcome', 'summary', 'approval_digest', 'rendered_prompt_digest',
    'evidence_digest', 'changed_paths', 'diagnostics', 'completed_at',
  ]);
  assertVersion('public-attempt-result', v);
  if (v.driver !== QUEUE_DRIVER_ID) invalid('driver-ownership-conflict', 'public-result.driver', `must be ${QUEUE_DRIVER_ID}`);
  const classification = enumValue(v.classification, 'public-result.classification', TERMINAL_CLASSIFICATIONS);
  const outcome = enumValue(v.outcome, 'public-result.outcome', ['needs-review', 'approved', 'rejected', 'parked', 'failed']);
  if (classification !== 'success' && outcome === 'approved') {
    invalid('public-result-outcome-mismatch', 'public-result.outcome', `${classification} cannot be approved`);
  }
  return deepFreeze({
    schema_version: v.schema_version, kind: v.kind, driver: v.driver,
    receipt_id: identifier(v.receipt_id, 'public-result.receipt_id'),
    run_id: identifier(v.run_id, 'public-result.run_id'),
    node_id: identifier(v.node_id, 'public-result.node_id'),
    attempt_id: identifier(v.attempt_id, 'public-result.attempt_id'),
    role: enumValue(v.role, 'public-result.role', DURABLE_ROLES),
    classification,
    outcome,
    summary: portableText(v.summary, 'public-result.summary', { multiline: true }),
    approval_digest: digest(v.approval_digest, 'public-result.approval_digest'),
    rendered_prompt_digest: digest(v.rendered_prompt_digest, 'public-result.rendered_prompt_digest'),
    evidence_digest: digest(v.evidence_digest, 'public-result.evidence_digest'),
    changed_paths: paths(v.changed_paths, 'public-result.changed_paths', { sort: true }),
    diagnostics: strings(v.diagnostics, 'public-result.diagnostics'),
    completed_at: timestamp(v.completed_at, 'public-result.completed_at'),
  });
}

export function normalizeTransitionReceipt(value) {
  scanPublic(value, 'transition-receipt');
  const v = closedObject(value, 'transition-receipt', [
    'schema_version', 'kind', 'driver', 'run_id', 'transition_id', 'idempotency_key',
    'revision_from', 'revision_to', 'state_from', 'state_to', 'input_digest', 'result_digest',
    'receipt_id', 'committed_at',
  ]);
  assertVersion('transition-receipt', v);
  if (v.driver !== QUEUE_DRIVER_ID) invalid('driver-ownership-conflict', 'transition-receipt.driver', `must be ${QUEUE_DRIVER_ID}`);
  const from = integer(v.revision_from, 'transition-receipt.revision_from');
  const to = integer(v.revision_to, 'transition-receipt.revision_to', { min: 1 });
  if (from >= Number.MAX_SAFE_INTEGER) {
    invalid('schema-value-invalid', 'transition-receipt.revision_from', 'cannot advance beyond the safe integer range');
  }
  if (to !== from + 1) invalid('schema-value-invalid', 'transition-receipt.revision_to', 'must equal revision_from + 1');
  return deepFreeze({
    schema_version: v.schema_version, kind: v.kind, driver: v.driver,
    run_id: identifier(v.run_id, 'transition-receipt.run_id'),
    transition_id: identifier(v.transition_id, 'transition-receipt.transition_id'),
    idempotency_key: identifier(v.idempotency_key, 'transition-receipt.idempotency_key'),
    revision_from: from, revision_to: to,
    state_from: portableText(v.state_from, 'transition-receipt.state_from'),
    state_to: portableText(v.state_to, 'transition-receipt.state_to'),
    input_digest: digest(v.input_digest, 'transition-receipt.input_digest'),
    result_digest: digest(v.result_digest, 'transition-receipt.result_digest'),
    receipt_id: identifier(v.receipt_id, 'transition-receipt.receipt_id'),
    committed_at: timestamp(v.committed_at, 'transition-receipt.committed_at'),
  });
}

const READERS = Object.freeze({
  'queue-approval-envelope': normalizeApprovalEnvelope,
  'durable-role-job': normalizeDurableJob,
  'launch-reservation': normalizeLaunchReservation,
  'launch-acknowledgement': normalizeLaunchAcknowledgement,
  'terminal-receipt': normalizeTerminalReceipt,
  'public-attempt-result': normalizePublicResult,
  'transition-receipt': normalizeTransitionReceipt,
  'supervision-policy': normalizeSupervisionPolicy,
});

/** Read one explicitly supported document version; never guess or silently upgrade. */
export function readCompatibleDocument(family, value) {
  const reader = READERS[family];
  if (!reader) invalid('schema-family-unsupported', 'kind', `unknown document family ${JSON.stringify(family)}`);
  assertVersion(family, value);
  return reader(value);
}
