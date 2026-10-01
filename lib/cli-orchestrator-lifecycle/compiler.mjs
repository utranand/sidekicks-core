// Strict queue-source/v1 -> queue-supervisor-import/v1 compiler.
// Compilation freezes the current execution snapshot and produces an approval envelope; it never
// launches work. Unknown semantics are rejected before projection so no queue field disappears.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { effectiveExecutors, routingPolicy } from '../cli-executor-lifecycle/_shared.mjs';
import { validateExecutionConfigSnapshot } from '../cli-executor-lifecycle/execution-config.mjs';
import { executorSpecDigest } from '../cli-executor-lifecycle/invoke.mjs';
import { resolvePresetSnapshot, presetRevision } from '../cli-executor-lifecycle/presets.mjs';
import { enforcementGaps, profileFor } from '../cli-executor-lifecycle/profiles.mjs';
import {
  DURABLE_EXECUTION_SCHEMA_VERSION,
  QUEUE_DRIVER_ID,
  approvalEnvelopeDigest,
  assertPublicDocument,
  executionBindingDigest,
  normalizeApprovalEnvelope,
} from '../durable-execution/schema.mjs';
import { normalizePortableRelativePath, resolveWithinRoot } from '../durable-execution/paths.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';

export const QUEUE_SOURCE_VERSION = 1;
export const QUEUE_IMPORT_FORMAT = 'queue-supervisor-import/v1';

const ITEM_FIELDS = Object.freeze([
  'id', 'goal', 'instructions', 'work_dir', 'acceptance_criteria', 'executor', 'model_tier',
  'model', 'effort', 'file_refs', 'depends_on', 'required', 'source', 'routing_provenance',
  'execution_transport', 'tests', 'allowed_paths', 'artifact_expectations',
]);
const RUN_FIELDS = Object.freeze([
  'work_item', 'mode', 'project', 'service', 'work_dir', 'docs_dir', 'artifacts_dir', 'guardrails',
  'stage_budgets', 'routing', 'routing_preset', 'supervision', 'approval_provenance',
  'action_policy', 'ownership', 'notifications', 'goal', 'evidence_policy',
  'prompt_template_policy',
]);
const ROLE_NAMES = Object.freeze(['planner', 'implementer', 'reviewer', 'advisor', 'final_verifier']);
const ROLE_TO_INVOCATION = Object.freeze({
  planner: 'plan', implementer: 'implement', reviewer: 'review', advisor: 'plan',
  final_verifier: 'final-verify',
});
const ROLE_TO_STAGE = Object.freeze({
  planner: 'planner', implementer: 'implementation', reviewer: 'review', advisor: 'advisor',
  final_verifier: 'final_verification',
});
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function fail(code, path, message) {
  throw new SidekicksError(`[${code}] ${path}: ${message}`, EXIT_VALIDATION);
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('queue-field-invalid', path, 'must be an object');
  return value;
}

function closed(value, path, fields) {
  const out = object(value, path);
  const unknown = Object.keys(out).find((key) => !fields.includes(key));
  if (unknown) fail('queue-field-unsupported', `${path}.${unknown}`, 'field is not supported by queue-source/v1');
  return out;
}

function text(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail('queue-field-invalid', path, 'must be a non-empty string');
  if (value.includes('\0')) fail('queue-field-invalid', path, 'must not contain NUL');
  return value;
}

function id(value, path) {
  const out = text(value, path);
  if (!ID_RE.test(out)) fail('queue-id-invalid', path, 'must be a portable identifier no longer than 192 characters');
  return out;
}

function integer(value, path, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) fail('queue-budget-semantics-unsupported', path, `must be an integer >= ${min}`);
  return value;
}

function digest(value, path) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('approval-provenance-missing', path, 'must be sha256:<64 lowercase hex>');
  return value;
}

function array(value, path, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) fail('queue-field-invalid', path, `must be ${nonempty ? 'a non-empty' : 'an'} array`);
  return value;
}

function portable(value, path, allowRoot = true) {
  try {
    return normalizePortableRelativePath(value, { allowRoot }, path);
  } catch (error) {
    fail('queue-reference-invalid', path, error.message);
  }
}

function sha(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeRepoRoot(repoRoot) {
  return repoRoot instanceof URL ? fileURLToPath(repoRoot) : String(repoRoot);
}

function referenceIdentity(repoRoot, path, label) {
  const rel = portable(path, label, false);
  let absolute;
  try { absolute = resolveWithinRoot(repoRoot, rel); }
  catch (error) { fail('queue-reference-invalid', label, error.message); }
  try {
    return { path: rel, content_digest: sha(readFileSync(absolute)) };
  } catch (error) {
    fail('queue-reference-invalid', label, `cannot read referenced file: ${error.message}`);
  }
}

function canonicalContainment(role, executor, spec) {
  const invocationRole = ROLE_TO_INVOCATION[role];
  const readOnly = invocationRole !== 'implement';
  const profile = profileFor(executor, spec);
  const enforces = readOnly
    ? ['read-only', ...(executor === 'codex' ? ['hard-stopped-actions-denied', 'network-denied'] : [])]
    : [...(profile.enforcement?.enforces || [])];
  const gaps = readOnly ? [] : enforcementGaps(executor, spec);
  return {
    profile: text(spec.sandbox, `execution.registry.executors.${executor}.sandbox`),
    digest: executorSpecDigest(spec),
    enforces: [...new Set(enforces)].sort(),
    gaps: [...new Set(gaps)].sort(),
  };
}

function frozenRouting(snapshot, presetName) {
  const presets = object(snapshot.sections?.presets, 'execution.sections.presets');
  const declaration = presets.presets?.[presetName];
  if (!declaration) fail('queue-routing-unresolved', 'run.routing_preset', `preset '${presetName}' does not exist`);
  const executors = effectiveExecutors(object(snapshot.sections?.registry, 'execution.sections.registry'));
  let resolved;
  try {
    resolved = resolvePresetSnapshot({
      name: presetName,
      preset: declaration,
      executors,
      hostCli: declaration.host_cli || '',
      prefer: routingPolicy(snapshot.sections.registry),
    });
  } catch (error) {
    fail('queue-routing-unresolved', 'run.routing_preset', error.message);
  }
  if (!resolved.roles.advisor) fail('queue-role-binding-missing', 'routing.advisor', 'preset must bind an advisor explicitly');
  const revision = presetRevision(declaration);
  const source = presets.provenance?.presets?.[presetName]?.source
    ?? snapshot.provenance?.presets?.root ?? 'execution-snapshot';
  const routing = {};
  const metadata = {};
  for (const role of ROLE_NAMES) {
    const seat = resolved.roles[role];
    if (!seat) fail('queue-role-binding-missing', `routing.${role}`, 'resolved preset role is missing');
    const spec = executors[seat.executor];
    routing[role] = {
      executor: seat.executor,
      model_ref: seat.model,
      invoke_id: seat.invoke_id,
      effort: seat.effort ?? null,
      role: ROLE_TO_INVOCATION[role],
      containment: canonicalContainment(role, seat.executor, spec),
      provenance: { source: String(source), preset: presetName, preset_revision: revision },
    };
    metadata[role] = {
      tier: seat.tier,
      effort_source: seat.effort_source,
      source_preset: presetName,
    };
  }
  return { routing, metadata, fallback: resolved.fallback };
}

function validateSourceRouting(runRouting, frozen, fallback) {
  const source = closed(runRouting, 'source.run.routing', ROLE_NAMES);
  for (const [role, value] of Object.entries(source)) {
    const row = closed(value, `source.run.routing.${role}`,
      ['executor', 'model_ref', 'invoke_id', 'effort', 'role', 'containment', 'fallback']);
    const actual = frozen[role];
    for (const [field, expected] of [
      ['executor', actual.executor], ['model_ref', actual.model_ref], ['invoke_id', actual.invoke_id],
      ['effort', actual.effort], ['role', actual.role],
    ]) {
      if (row[field] !== expected) fail('queue-routing-unresolved', `source.run.routing.${role}.${field}`,
        `source value does not equal the frozen preset binding (${JSON.stringify(expected)})`);
    }
    const expectedContainment = actual.role === 'implement' ? ['bounded-edit', 'workspace-write', actual.containment.profile] : ['read-only', actual.containment.profile];
    if (!expectedContainment.includes(row.containment)) {
      fail('containment-unsupported', `source.run.routing.${role}.containment`, 'does not match the frozen role containment');
    }
    const declaredFallback = closed(row.fallback, `source.run.routing.${role}.fallback`, ['mode', 'max_role_fallbacks']);
    if (declaredFallback.mode !== fallback.mode || declaredFallback.max_role_fallbacks !== fallback.max_role_fallbacks) {
      fail('fallback-not-frozen', `source.run.routing.${role}.fallback`, 'must equal the frozen preset fallback');
    }
  }
}

function validateItemRouting(items, frozen, metadata) {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    for (const [field, expected] of [
      ['executor', frozen.implementer.executor],
      ['model_tier', metadata.implementer.tier],
      ['model', frozen.implementer.model_ref],
      ['effort', frozen.implementer.effort],
    ]) {
      if (item[field] !== expected) {
        fail('queue-routing-unresolved', `source.items[${index}].${field}`,
          `item implementation binding must equal the frozen preset value ${JSON.stringify(expected)}`);
      }
    }
  }
}

function compileItem(itemValue, index, repoRoot, ids, criteria, tests, aliases) {
  const item = closed(itemValue, `source.items[${index}]`, ITEM_FIELDS);
  const nodeId = id(item.id, `source.items[${index}].id`);
  if (ids.has(nodeId)) fail('queue-id-invalid', `source.items[${index}].id`, 'node ids must be unique');
  ids.add(nodeId);
  if (item.required !== true) fail('queue-optional-unsupported', `source.items[${index}].required`, 'v1 requires every item');
  if (item.execution_transport !== 'external-cli') {
    fail('queue-transport-unsupported', `source.items[${index}].execution_transport`, 'v1 requires external-cli');
  }
  const declaredAllowedPaths = array(item.allowed_paths, `source.items[${index}].allowed_paths`);
  if (declaredAllowedPaths.length === 0) {
    fail('queue-write-scope-required', `source.items[${index}].allowed_paths`, 'at least one path is required');
  }
  const allowedPaths = declaredAllowedPaths
    .map((entry, pathIndex) => portable(entry, `source.items[${index}].allowed_paths[${pathIndex}]`, false));
  const dependencies = array(item.depends_on, `source.items[${index}].depends_on`)
    .map((entry, dependencyIndex) => id(entry, `source.items[${index}].depends_on[${dependencyIndex}]`));
  const fileRefs = array(item.file_refs, `source.items[${index}].file_refs`)
    .map((entry, refIndex) => referenceIdentity(repoRoot, entry, `source.items[${index}].file_refs[${refIndex}]`));
  const nodeCriteria = array(item.acceptance_criteria, `source.items[${index}].acceptance_criteria`, { nonempty: true });
  aliases[nodeId] = {};
  for (let criterionIndex = 0; criterionIndex < nodeCriteria.length; criterionIndex += 1) {
    const criterion = closed(nodeCriteria[criterionIndex],
      `source.items[${index}].acceptance_criteria[${criterionIndex}]`, ['id', 'text']);
    const sourceId = id(criterion.id, `source.items[${index}].acceptance_criteria[${criterionIndex}].id`);
    const alias = `${nodeId}.${sourceId}`;
    if (!ID_RE.test(alias) || criteria.some((candidate) => candidate.id === alias)) {
      fail('queue-criterion-identity-invalid', `source.items[${index}].acceptance_criteria[${criterionIndex}].id`,
        'node-qualified criterion id is invalid or collides');
    }
    aliases[nodeId][sourceId] = alias;
    criteria.push({ id: alias, text: text(criterion.text, `source.items[${index}].acceptance_criteria[${criterionIndex}].text`) });
  }
  const sourceTests = array(item.tests, `source.items[${index}].tests`, { nonempty: true });
  for (let testIndex = 0; testIndex < sourceTests.length; testIndex += 1) {
    const sourceTest = closed(sourceTests[testIndex], `source.items[${index}].tests[${testIndex}]`,
      ['argv', 'cwd', 'role', 'expected_exit', 'timeout_ms']);
    if (sourceTest.role !== 'test') fail('queue-test-format-unsupported', `source.items[${index}].tests[${testIndex}].role`, 'must be test');
    const command = array(sourceTest.argv, `source.items[${index}].tests[${testIndex}].argv`, { nonempty: true })
      .map((entry, argIndex) => text(entry, `source.items[${index}].tests[${testIndex}].argv[${argIndex}]`));
    tests.push({
      id: `${nodeId}.test-${testIndex + 1}`,
      cwd: portable(sourceTest.cwd, `source.items[${index}].tests[${testIndex}].cwd`),
      command,
      expected_exit: integer(sourceTest.expected_exit, `source.items[${index}].tests[${testIndex}].expected_exit`),
      timeout_ms: sourceTest.timeout_ms === undefined ? 60_000
        : integer(sourceTest.timeout_ms, `source.items[${index}].tests[${testIndex}].timeout_ms`, 1),
    });
  }
  const expectations = array(item.artifact_expectations,
    `source.items[${index}].artifact_expectations`, { nonempty: true }).map((entry, expectationIndex) => {
    const path = `source.items[${index}].artifact_expectations[${expectationIndex}]`;
    const expectation = closed(entry, path, ['path', 'kind', 'exists', 'allow_empty', 'touch']);
    if (expectation.kind !== 'file' || expectation.exists !== true
        || expectation.allow_empty !== false || expectation.touch !== 'run') {
      fail('queue-output-semantics-unsupported', path,
        'v1 supports only {kind:file, exists:true, allow_empty:false, touch:run}');
    }
    const outputPath = portable(expectation.path, `${path}.path`, false);
    if (!allowedPaths.some((allowed) => outputPath === allowed || outputPath.startsWith(`${allowed}/`))) {
      fail('node-write-scope-violation', `${path}.path`, 'expected output is outside the item allowed_paths');
    }
    return { path: outputPath, kind: 'file', exists: true, allow_empty: false, touch: 'run' };
  });
  closed(item.source, `source.items[${index}].source`, ['plan', 'section']);
  text(item.source.plan, `source.items[${index}].source.plan`);
  text(item.source.section, `source.items[${index}].source.section`);
  if (!['explicit-item', 'preset'].includes(item.routing_provenance)) {
    fail('queue-routing-provenance-missing', `source.items[${index}].routing_provenance`, 'must be explicit-item or preset');
  }
  return {
    node_id: nodeId,
    source_ordinal: index,
    goal: text(item.goal, `source.items[${index}].goal`),
    instructions: [text(item.instructions, `source.items[${index}].instructions`)],
    work_dir: portable(item.work_dir, `source.items[${index}].work_dir`),
    file_refs: fileRefs,
    allowed_paths: [...new Set(allowedPaths)].sort(),
    dependencies: [...new Set(dependencies)].sort(),
    artifact_expectations: expectations,
  };
}

function assertGraph(nodes) {
  const ids = new Set(nodes.map((node) => node.node_id));
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency)) fail('missing-dependency', `source.items.${node.node_id}.depends_on`, `unknown node '${dependency}'`);
      if (dependency === node.node_id) fail('cyclic-dependency', `source.items.${node.node_id}.depends_on`, 'self-dependency');
    }
  }
  const active = new Set();
  const done = new Set();
  const visit = (id) => {
    if (active.has(id)) fail('cyclic-dependency', `source.items.${id}.depends_on`, 'cycle detected');
    if (done.has(id)) return;
    active.add(id);
    for (const dependency of nodes.find((node) => node.node_id === id).dependencies) visit(dependency);
    active.delete(id);
    done.add(id);
  };
  nodes.forEach((node) => visit(node.node_id));
}

function normalizeBudgets(run, itemCount, testCount) {
  const budget = closed(run.stage_budgets, 'source.run.stage_budgets', [
    'planner', 'implementer', 'repair', 'reviewer', 'advisor', 'final_verifier', 'tests',
    'total_role_calls', 'max_wall_clock_ms_per_attempt', 'max_wall_clock_ms_total',
  ]);
  const perAttempt = integer(budget.max_wall_clock_ms_per_attempt,
    'source.run.stage_budgets.max_wall_clock_ms_per_attempt', 1);
  const stageBudget = (sourceName, { minimumCalls = 0 } = {}) => {
    const maxCalls = integer(budget[sourceName], `source.run.stage_budgets.${sourceName}`, minimumCalls);
    const cumulative = perAttempt * Math.max(maxCalls, 1);
    if (!Number.isSafeInteger(cumulative)) {
      fail('queue-budget-semantics-unsupported', `source.run.stage_budgets.${sourceName}`,
        'per-attempt limit multiplied by stage calls exceeds the safe integer range');
    }
    return { max_calls: maxCalls, max_elapsed_ms: cumulative, max_elapsed_ms_per_attempt: perAttempt };
  };
  const stages = {};
  for (const role of ROLE_NAMES) {
    stages[ROLE_TO_STAGE[role]] = stageBudget(role);
  }
  stages.repair = stageBudget('repair');
  stages.tests = stageBudget('tests', { minimumCalls: 1 });
  const guardrails = closed(run.guardrails, 'source.run.guardrails', ['item_budget', 'failure_breaker', 'attempt_limit']);
  if (integer(guardrails.item_budget, 'source.run.guardrails.item_budget', 1) !== itemCount) {
    fail('queue-budget-semantics-unsupported', 'source.run.guardrails.item_budget', 'must equal the required item count');
  }
  return {
    total: {
      // Source `total_role_calls` intentionally excludes contained test processes. The lifecycle
      // total counts every reservation, so add the separately frozen tests budget once.
      max_calls: integer(budget.total_role_calls, 'source.run.stage_budgets.total_role_calls', 1)
        + integer(budget.tests, 'source.run.stage_budgets.tests', 1),
      max_elapsed_ms: integer(budget.max_wall_clock_ms_total, 'source.run.stage_budgets.max_wall_clock_ms_total', 1),
    },
    stages,
    item_budget: { max_terminal_items: itemCount },
    failure_breaker: {
      max_consecutive_item_failures: integer(guardrails.failure_breaker, 'source.run.guardrails.failure_breaker', 1),
      reset_on_item_success: true,
    },
    attempt_limit: { max_attempts_per_item: integer(guardrails.attempt_limit, 'source.run.guardrails.attempt_limit', 1) },
  };
}

function normalizeSupervision(run, frozenFallback) {
  const supervision = closed(run.supervision, 'source.run.supervision', ['mode', 'poll_interval_ms', 'max_idle_ms', 'retry', 'fallback']);
  if (!['once', 'continuous'].includes(supervision.mode)) {
    fail('queue-field-unsupported', 'source.run.supervision.mode', 'must be once or continuous');
  }
  const retry = closed(supervision.retry, 'source.run.supervision.retry', [
    'max_attempts_per_role', 'replay_safe_classes', 'requires_terminal_receipt',
    'requires_cleanup_complete', 'requires_process_tree_terminated',
  ]);
  const fallback = closed(supervision.fallback, 'source.run.supervision.fallback', ['mode', 'max_role_fallbacks', 'roles']);
  if (fallback.mode !== frozenFallback.mode || fallback.max_role_fallbacks !== frozenFallback.max_role_fallbacks) {
    fail('fallback-not-frozen', 'source.run.supervision.fallback', 'must equal the resolved preset fallback');
  }
  return {
    mode: supervision.mode,
    poll_interval_ms: integer(supervision.poll_interval_ms, 'source.run.supervision.poll_interval_ms', 1),
    max_idle_ms: integer(supervision.max_idle_ms, 'source.run.supervision.max_idle_ms', 1),
    retry: {
      max_attempts_per_role: integer(retry.max_attempts_per_role, 'source.run.supervision.retry.max_attempts_per_role', 1),
      replay_safe_classes: array(retry.replay_safe_classes, 'source.run.supervision.retry.replay_safe_classes'),
      requires_terminal_receipt: retry.requires_terminal_receipt === true,
      requires_cleanup_complete: retry.requires_cleanup_complete === true,
      requires_process_tree_terminated: retry.requires_process_tree_terminated === true,
    },
    fallback: { mode: fallback.mode, max_role_fallbacks: fallback.max_role_fallbacks, roles: fallback.roles || {} },
    stop_behavior: 'settle-active-only',
    notifications: { use_configured_run_reporting: run.notifications.use_configured_run_reporting === true },
  };
}

/** Convert the three Phase 0 architecture fixtures into the strict production source shape. */
export function phase0FixtureSource(value, additions) {
  const fixture = closed(value, 'phase0-fixture', [
    'fixture_purpose', 'source_contract', 'compiler_metadata', 'new_fields_requiring_future_support', 'items', 'run',
  ]);
  if (fixture.compiler_metadata?.adapter !== 'synthetic-architecture-fixture') {
    fail('queue-source-incomplete', 'phase0-fixture.compiler_metadata.adapter', 'expected the named Phase 0 fixture adapter');
  }
  const run = structuredClone(fixture.run);
  run.project = 'sidekicks';
  run.service = null;
  run.routing_preset = text(additions.routing_preset, 'phase0-adapter.routing_preset');
  run.approval_provenance = structuredClone(additions.approval_provenance);
  run.evidence_policy = structuredClone(additions.evidence_policy);
  run.prompt_template_policy = structuredClone(additions.prompt_template_policy);
  run.stage_budgets.tests = Math.max(1, fixture.items.reduce((total, item) => total + item.tests.length, 0));
  run.supervision.poll_interval_ms = 2000;
  run.supervision.max_idle_ms = 120000;
  run.supervision.retry.replay_safe_classes = ['launch-failure', 'pre-acknowledgement-refusal'];
  run.supervision.retry.requires_terminal_receipt = true;
  run.supervision.retry.requires_cleanup_complete = true;
  run.supervision.retry.requires_process_tree_terminated = true;
  run.supervision.fallback.roles = {};
  run.ownership.driver = QUEUE_DRIVER_ID;
  return {
    schema_version: QUEUE_SOURCE_VERSION,
    kind: 'queue-source',
    compiler_metadata: {
      contract_version: 'queue-source/v1',
      adapter: 'sk-plan-to-cli-queue',
      source_plan: fixture.compiler_metadata.source_plan,
    },
    items: structuredClone(fixture.items),
    run,
  };
}

/** Compile without writing or launching. */
export function compileQueueSource({ source: sourceValue, repoRoot: inputRoot, executionSnapshot, presetName }) {
  assertPublicDocument(sourceValue, 'source');
  const execution = validateExecutionConfigSnapshot(executionSnapshot);
  const source = closed(sourceValue, 'source', ['schema_version', 'kind', 'compiler_metadata', 'items', 'run']);
  if (source.schema_version !== QUEUE_SOURCE_VERSION || source.kind !== 'queue-source') {
    fail('queue-version-unsupported', 'source', 'expected queue-source schema_version 1');
  }
  const metadata = closed(source.compiler_metadata, 'source.compiler_metadata', ['contract_version', 'adapter', 'source_plan']);
  if (metadata.contract_version !== 'queue-source/v1' || metadata.adapter !== 'sk-plan-to-cli-queue') {
    fail('queue-source-incomplete', 'source.compiler_metadata', 'requires the authoritative queue-source/v1 compiler adapter');
  }
  portable(metadata.source_plan, 'source.compiler_metadata.source_plan', false);
  const run = closed(source.run, 'source.run', RUN_FIELDS);
  if (run.mode !== 'interactive') fail('queue-field-unsupported', 'source.run.mode', 'v1 supports interactive approval only');
  const repoRoot = normalizeRepoRoot(inputRoot);
  const preset = text(presetName || run.routing_preset, 'source.run.routing_preset');
  if (preset !== run.routing_preset) fail('queue-routing-unresolved', 'source.run.routing_preset', 'CLI preset and source preset differ');
  const frozen = frozenRouting(execution, preset);
  validateSourceRouting(run.routing, frozen.routing, frozen.fallback);

  const ids = new Set();
  const criteria = [];
  const tests = [];
  const criterionAliases = {};
  const items = array(source.items, 'source.items', { nonempty: true });
  validateItemRouting(items, frozen.routing, frozen.metadata);
  const nodes = items.map((item, index) => compileItem(item, index, repoRoot, ids, criteria, tests, criterionAliases));
  assertGraph(nodes);
  const workItem = id(run.work_item, 'source.run.work_item');
  if (run.docs_dir !== null) {
    fail('queue-field-unsupported', 'source.run.docs_dir', 'queue-supervisor/v1 has no separate docs root');
  }
  const artifactsDir = portable(run.artifacts_dir, 'source.run.artifacts_dir', false);
  if (artifactsDir !== `artifacts/runs/${workItem}`) {
    fail('queue-source-incomplete', 'source.run.artifacts_dir',
      `must be the canonical artifacts/runs/${workItem} run root`);
  }
  const notifications = closed(run.notifications, 'source.run.notifications', ['use_configured_run_reporting']);
  if (typeof notifications.use_configured_run_reporting !== 'boolean') {
    fail('queue-field-invalid', 'source.run.notifications.use_configured_run_reporting', 'must be boolean');
  }
  const action = closed(run.action_policy, 'source.run.action_policy', ['held', 'grants']);
  if (array(action.grants, 'source.run.action_policy.grants').length !== 0) {
    fail('held-action-unsupported', 'source.run.action_policy.grants', 'consumable held-action grants are not importable');
  }
  const ownership = closed(run.ownership, 'source.run.ownership', ['driver', 'legacy_owner', 'migration_receipt']);
  if (ownership.driver !== QUEUE_DRIVER_ID || ownership.legacy_owner !== null || ownership.migration_receipt !== null) {
    fail('driver-ownership-conflict', 'source.run.ownership', `new imports must be owned only by ${QUEUE_DRIVER_ID}`);
  }
  const approval = closed(run.approval_provenance, 'source.run.approval_provenance',
    ['authorization_ref', 'approved_by', 'approved_at', 'request_digest']);
  if (approval.approved_by !== 'human') fail('approval-provenance-missing', 'source.run.approval_provenance.approved_by', 'must be human');
  digest(approval.request_digest, 'source.run.approval_provenance.request_digest');
  const evidence = closed(run.evidence_policy, 'source.run.evidence_policy', ['allowed_classes', 'max_items_per_attempt']);
  const template = closed(run.prompt_template_policy, 'source.run.prompt_template_policy', ['template_id', 'template_version', 'repair_mode']);
  const sourceDigest = sha(canonicalJson(source));
  const allowedPaths = [...new Set(nodes.flatMap((node) => node.allowed_paths))].sort();
  const fileRefs = [...new Set(nodes.flatMap((node) => node.file_refs.map((ref) => ref.path)))].sort();
  const framingScope = {
    project: text(run.project, 'source.run.project'),
    service: run.service === null ? null : text(run.service, 'source.run.service'),
    work_dir: portable(run.work_dir, 'source.run.work_dir'),
    file_refs: fileRefs,
    allowed_paths: allowedPaths,
  };
  const envelope = normalizeApprovalEnvelope({
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'queue-approval-envelope',
    driver: QUEUE_DRIVER_ID,
    run_id: workItem,
    execution_revision: digest(executionSnapshot.revision, 'execution.revision'),
    source_digest: sourceDigest,
    framing: {
      goal: text(run.goal, 'source.run.goal'),
      instructions: [...new Set(nodes.flatMap((node) => node.instructions))],
      scope: framingScope,
      dependencies: [],
      criteria,
      tests,
      node_scopes: nodes,
      evidence_policy: {
        allowed_classes: array(evidence.allowed_classes, 'source.run.evidence_policy.allowed_classes', { nonempty: true }),
        max_items_per_attempt: integer(evidence.max_items_per_attempt, 'source.run.evidence_policy.max_items_per_attempt', 1),
      },
      prompt_template_policy: {
        template_id: text(template.template_id, 'source.run.prompt_template_policy.template_id'),
        template_version: integer(template.template_version, 'source.run.prompt_template_policy.template_version', 1),
        repair_mode: template.repair_mode,
      },
    },
    routing: frozen.routing,
    supervision: normalizeSupervision({ ...run, notifications }, frozen.fallback),
    budgets: normalizeBudgets(run, nodes.length, tests.length),
    authority: {
      scope_revision: sha(canonicalJson({ scope: framingScope, nodes })),
      allowed_evidence_classes: evidence.allowed_classes,
      held_action_classes: action.held,
      grants: [],
    },
    approval_provenance: approval,
    display: {
      title: `Durable queue ${workItem}`,
      summary: `Compiled from ${metadata.source_plan} with preset ${preset}.`,
      updated_at: approval.approved_at,
    },
  });
  const compiled = {
    schema_version: 1,
    import_format: QUEUE_IMPORT_FORMAT,
    driver: QUEUE_DRIVER_ID,
    run_id: workItem,
    source_digest: sourceDigest,
    execution_revision: execution.revision,
    approval: envelope,
    approval_digest: approvalEnvelopeDigest(envelope),
    invocation_bindings: structuredClone(envelope.routing),
    binding_metadata: frozen.metadata,
    preservation: {
      compiler_metadata: structuredClone(source.compiler_metadata),
      source_items: structuredClone(source.items),
      source_run: structuredClone(source.run),
      criterion_aliases: criterionAliases,
      field_mappings: Object.freeze([
        'objective/instructions -> approval.framing.goal/node_scopes',
        'working directory/file references/dependencies/allowed paths -> approval.framing.node_scopes',
        'tests/artifact expectations -> approval.framing.tests/node_scopes.artifact_expectations',
        'budgets -> approval.budgets',
        'routing/fallback -> approval.routing/approval.supervision.fallback',
        'approval provenance -> approval.approval_provenance',
        'review/repair/final verification -> approval.supervision/approval.budgets',
      ]),
    },
  };
  return Object.freeze(compiled);
}

export function redactModelRef(value) {
  return `[redacted:${sha(value).slice(0, 19)}]`;
}

/** One safe projection used by CLI output, skill runbooks, and parity tests. */
export function previewFrozenBindings(compiled) {
  const roles = {};
  for (const role of ROLE_NAMES) {
    const binding = compiled.approval.routing[role];
    roles[role] = {
      role,
      executor: binding.executor,
      tier: compiled.binding_metadata[role].tier,
      model_ref: redactModelRef(binding.model_ref),
      invoke_id: binding.invoke_id,
      effort: binding.effort,
      containment: structuredClone(binding.containment),
      source_preset: compiled.binding_metadata[role].source_preset,
      binding_digest: executionBindingDigest(binding),
    };
  }
  return {
    schema_version: 1,
    driver: compiled.driver,
    run_id: compiled.run_id,
    execution_revision: compiled.execution_revision,
    approval_digest: compiled.approval_digest,
    policy: {
      framing: structuredClone(compiled.approval.framing),
      fallback: structuredClone(compiled.approval.supervision.fallback),
      supervision: structuredClone(compiled.approval.supervision),
      budgets: structuredClone(compiled.approval.budgets),
      evidence_policy: structuredClone(compiled.approval.framing.evidence_policy),
      prompt_template_policy: structuredClone(compiled.approval.framing.prompt_template_policy),
      scope_revision: compiled.approval.authority.scope_revision,
      authority: structuredClone(compiled.approval.authority),
      approval_provenance: structuredClone(compiled.approval.approval_provenance),
    },
    roles,
  };
}
