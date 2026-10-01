// Native Phase 4 lifecycle for the selected queue-supervisor/v1 driver.
//
// This is deliberately a bounded in-process driver, not the continuous supervisor added by
// Phase 5. It owns policy and progression while the shared durable worker owns process launch and
// terminal receipts. Every authoritative state change enters through commands.mjs and the fenced
// store; public evidence is deterministic and contains no raw provider data.

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { writeAtomic } from '../fs-safety/fsx.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import {
  DURABLE_EXECUTION_SCHEMA_VERSION,
  QUEUE_DRIVER_ID,
  approvalEnvelopeDigest,
  buildAttemptPromptRecord,
  executionBindingDigest,
  normalizeApprovalEnvelope,
  normalizeDurableJob,
  normalizePublicResult,
  renderApprovedAttemptPrompt,
  renderedPromptDigest,
} from '../durable-execution/schema.mjs';
import {
  initializeFencedRun,
  readFencedRun,
  stopPresent,
} from '../durable-execution/store.mjs';
import {
  PRIVATE_RECEIPT_ROOT,
  PUBLIC_RUN_ROOT,
  normalizePortableRelativePath,
  resolveWithinRoot,
} from '../durable-execution/paths.mjs';
import {
  canonicalAttemptRefs,
  createPrivateExecutionClaim,
  launchPreparedAttempt,
  observePrivateExecutionClaim,
  persistPrivateExecutionRecord,
  prepareDurableAttempt,
  readPrivateExecutionRecord,
  reconcilePreparedAttempt,
} from '../durable-execution/worker.mjs';
import { commitQueueMutation } from './commands.mjs';
import { validateSupervisorLeaseCapability } from './supervisor-lease.mjs';
import { runReadOnlyFileAssertion } from './file-assert.mjs';
import { assertAllowedWorkspaceDelta, snapshotWorkspace } from '../durable-execution/workspace-evidence.mjs';
import { captureGitBoundaries } from '../durable-execution/branch-guard.mjs';

const APPROVAL_REF = 'approval-envelope.json';
const ACTIVE_TEST_CLAIMS = new Set();
const ACTIVE_PREPARATION_CLAIMS = new Set();
const TERMINAL_STAGES = new Set(['done', 'held', 'stopped']);
const ROLE_FOR_STAGE = Object.freeze({
  implementation: 'implementer',
  repair: 'implementer',
  review: 'reviewer',
  advisor: 'advisor',
  final_verification: 'final-verifier',
});
const SEAT_FOR_ROLE = Object.freeze({
  implementer: 'implementer',
  reviewer: 'reviewer',
  advisor: 'advisor',
  'final-verifier': 'final_verifier',
});

function invalid(code, message) {
  throw new SidekicksError(`[${code}] ${message}`, EXIT_VALIDATION);
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function documentDigest(value) {
  return sha256Text(canonicalJson(value));
}

function pathToken(value) {
  const text = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(text)
    ? text
    : `id-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24)}`;
}

function requireActiveSupervisorLease(context, approval, capability) {
  if (!validateSupervisorLeaseCapability(context, approval, capability)) {
    invalid('supervisor-lease-required', 'one-decision mutation requires the current process to own the active supervisor lease');
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    invalid('lifecycle-evidence-invalid', `${label}: ${error.message}`);
  }
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function ensurePublicDirectory(root, portableDirectory) {
  const normalized = normalizePortableRelativePath(portableDirectory);
  const realRoot = realpathSync(root);
  let current = realRoot;
  if (normalized === '.') return current;
  for (const segment of normalized.split('/')) {
    const next = join(current, segment);
    if (!existsSync(next)) mkdirSync(next, { recursive: false, mode: 0o755 });
    const stat = lstatSync(next);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      invalid('artifact-path-outside-root', `${portableDirectory} crosses a non-directory or link`);
    }
    const real = realpathSync(next);
    if (!inside(realRoot, real)) {
      invalid('artifact-path-outside-root', `${portableDirectory} resolves outside the public run root`);
    }
    current = real;
  }
  return current;
}

function publicArtifactPath(runDir, ref, { mustExist = false } = {}) {
  const normalized = normalizePortableRelativePath(ref, { allowRoot: false });
  if (normalized !== ref) invalid('artifact-path-not-canonical', `${ref} is not a canonical public reference`);
  ensurePublicDirectory(runDir, dirname(normalized));
  const target = resolveWithinRoot(runDir, normalized, { mustExist });
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      invalid('artifact-path-outside-root', `${ref} is not a regular public evidence file`);
    }
  }
  return target;
}

function readPublicJson(runDir, ref, label) {
  return readJson(publicArtifactPath(runDir, ref, { mustExist: true }), label);
}

function persistImmutableJson(runDir, ref, value, label) {
  const path = publicArtifactPath(runDir, ref);
  const text = jsonText(value);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== text) invalid('public-evidence-conflict', `${label} already differs`);
    return false;
  }
  writeAtomic(path, text);
  return true;
}

function persistCurrentJson(runDir, ref, value) {
  const path = publicArtifactPath(runDir, ref);
  const text = jsonText(value);
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeAtomic(path, text);
}

function portableRef(...parts) {
  return normalizePortableRelativePath(parts.join('/'), { allowRoot: false });
}

function stageUsage() {
  return { calls: 0, elapsed_ms: 0 };
}

function stateDigestForVerification(state) {
  return documentDigest({
    nodes: state.nodes.map((node) => ({
      node_id: node.node_id,
      status: node.status,
      evidence_digest: node.evidence_digest,
      review: node.review,
      implementation_attempts: node.implementation_attempts,
      repair_attempts: node.repair_attempts,
      review_attempts: node.review_attempts,
    })),
    tests: state.tests,
  });
}

export function createInitialQueueState(approvalValue) {
  const approval = normalizeApprovalEnvelope(approvalValue);
  const budgets = structuredClone(approval.budgets);
  return {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    driver: QUEUE_DRIVER_ID,
    run_id: approval.run_id,
    revision: 0,
    stage: 'ready',
    outcome: 'active',
    approval_digest: approvalEnvelopeDigest(approval),
    source_digest: approval.source_digest,
    nodes: [...approval.framing.node_scopes]
      .sort((a, b) => a.source_ordinal - b.source_ordinal)
      .map((node) => ({
        node_id: node.node_id,
        source_ordinal: node.source_ordinal,
        dependencies: [...node.dependencies],
        status: 'pending',
        implementation_attempts: 0,
        repair_attempts: 0,
        review_attempts: 0,
        terminal_budget_charged: false,
        repair_authorization: null,
        evidence_digest: null,
        evidence_ref: null,
        review: null,
      })),
    active_attempt: null,
    attempts: {},
    budget_limits: budgets,
    budget_usage: {
      total: stageUsage(),
      stages: Object.fromEntries(Object.keys(budgets.stages).map((stage) => [stage, stageUsage()])),
    },
    queue_counters: { terminal_items: 0, consecutive_item_failures: 0 },
    tests: null,
    final_verification: null,
    exit_check: null,
    report: null,
    parked: null,
    lifecycle_history: [],
    transition_receipts: {},
    replay_conflicts: [],
    sidecar_divergence: null,
  };
}

export function initializeQueueLifecycle(runDir, approvalValue, opts = {}) {
  const approval = normalizeApprovalEnvelope(approvalValue);
  const state = createInitialQueueState(approval);
  persistImmutableJson(runDir, APPROVAL_REF, approval, 'approval envelope');
  return initializeFencedRun(runDir, state, opts);
}

function ensureRunLocation(repoRootValue, runDirValue, approval) {
  const repoRoot = realpathSync(repoRootValue);
  const runDir = realpathSync(runDirValue);
  const expected = realpathSync(join(repoRoot, PUBLIC_RUN_ROOT, ...approval.run_id.split('/')));
  if (runDir !== expected) invalid('run-locator-conflict', 'run directory does not match the approved portable run id');
  const portable = relative(repoRoot, runDir).split(sep).join('/');
  if (portable !== `${PUBLIC_RUN_ROOT}/${approval.run_id}`) {
    invalid('run-locator-conflict', 'run directory is outside the canonical public root');
  }
  return { repoRoot, runDir };
}

function codeOf(error) {
  return /^\[([^\]]+)\]/u.exec(String(error?.message ?? error))?.[1] ?? 'lifecycle-driver-error';
}

function bindingProjection(binding) {
  return {
    executor: binding.executor,
    model_ref: binding.model_ref,
    invoke_id: binding.invoke_id,
    effort: binding.effort,
    role: binding.role,
    containment_digest: binding.containment.digest,
    binding_digest: executionBindingDigest(binding),
  };
}

function nodeScope(approval, nodeId) {
  const node = approval.framing.node_scopes.find((candidate) => candidate.node_id === nodeId);
  if (!node) invalid('approval-node-unknown', `node ${nodeId} is not approved`);
  return node;
}

function nodeState(state, nodeId) {
  const node = state.nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node) invalid('run-state-invalid', `node ${nodeId} is not in durable state`);
  return node;
}

function evidenceForStage(state, stage, nodeId) {
  if (stage === 'implementation') return [];
  if (stage === 'review') {
    const node = nodeState(state, nodeId);
    if (!node.evidence_digest) invalid('review-evidence-invalid', `node ${nodeId} has no implementation evidence`);
    return [{ class: 'file-digest', digest: node.evidence_digest }];
  }
  if (stage === 'repair') {
    const node = nodeState(state, nodeId);
    const authorization = node.review?.verdict === 'rejected'
      ? node.review
      : node.repair_authorization;
    if (!authorization?.evidence_digest) {
      invalid('repair-not-authorized', `node ${nodeId} has no current rejection or reopen verdict`);
    }
    return [{ class: 'review-verdict', digest: authorization.evidence_digest }];
  }
  if (stage === 'advisor') {
    const node = nodeState(state, nodeId);
    const digest = node.review?.evidence_digest ?? node.evidence_digest;
    return [{ class: 'review-verdict', digest }];
  }
  if (stage === 'final_verification') {
    if (state.tests?.verdict !== 'passed') {
      invalid('approved-tests-required', 'final verification requires current passing approved tests');
    }
    return [
      ...state.nodes.flatMap((node) => [
        { class: 'file-digest', digest: node.evidence_digest },
        { class: 'review-verdict', digest: node.review?.evidence_digest },
      ]),
      { class: 'test-result', digest: state.tests.evidence_digest },
    ];
  }
  invalid('lifecycle-stage-invalid', `unsupported attempt stage ${stage}`);
}

function attemptIdentity(state, stage, nodeId) {
  const usage = state.budget_usage.stages[stage];
  const ordinal = usage.calls + 1;
  const base = stage === 'final_verification' ? `${state.run_id}-final` : `${nodeId}-${stage}`;
  return {
    ordinal,
    attemptId: `${pathToken(base)}-${ordinal}`,
    idempotencyKey: `${pathToken(state.run_id)}/${pathToken(nodeId)}/${stage}/${ordinal}`,
  };
}

function budgetDiagnostic(state, approval, stage, nodeId) {
  const usage = state.budget_usage;
  const limit = approval.budgets;
  if (usage.total.calls >= limit.total.max_calls || usage.total.elapsed_ms >= limit.total.max_elapsed_ms) {
    return 'total-budget-exhausted';
  }
  if (usage.stages[stage].calls >= limit.stages[stage].max_calls
      || usage.stages[stage].elapsed_ms >= limit.stages[stage].max_elapsed_ms) {
    return stage === 'final_verification' ? 'final-verifier-budget-exhausted' : 'role-budget-exhausted';
  }
  if (stage === 'implementation') {
    const node = nodeState(state, nodeId);
    if (node.terminal_budget_charged !== true
        && state.queue_counters.terminal_items >= limit.item_budget.max_terminal_items) {
      return 'item-budget-exhausted';
    }
  }
  if (['implementation', 'repair'].includes(stage)) {
    const node = nodeState(state, nodeId);
    const attempts = node.implementation_attempts + node.repair_attempts;
    if (attempts >= approval.supervision.retry.max_attempts_per_role) {
      return 'role-retry-budget-exhausted';
    }
    if (attempts >= limit.attempt_limit.max_attempts_per_item) return 'repair-budget-exhausted';
  }
  if (stage === 'review'
      && nodeState(state, nodeId).review_attempts >= approval.supervision.retry.max_attempts_per_role) {
    return 'role-retry-budget-exhausted';
  }
  if (stage === 'final_verification'
      && usage.stages.final_verification.calls >= approval.supervision.retry.max_attempts_per_role) {
    return 'role-retry-budget-exhausted';
  }
  return null;
}

function remainingElapsedBudget(state, approval, stage) {
  const stageLimit = approval.budgets.stages[stage];
  return Math.min(
    stageLimit.max_elapsed_ms_per_attempt ?? stageLimit.max_elapsed_ms,
    stageLimit.max_elapsed_ms - state.budget_usage.stages[stage].elapsed_ms,
    approval.budgets.total.max_elapsed_ms - state.budget_usage.total.elapsed_ms,
  );
}

function executorSpecFor(approval, role, executorSpecs) {
  const seat = SEAT_FOR_ROLE[role];
  const binding = approval.routing[seat];
  const spec = executorSpecs?.[binding.executor];
  if (!spec) invalid('queue-routing-unresolved', `no frozen executor specification for ${binding.executor}`);
  return { binding, spec };
}

function buildJob(state, approval, stage, nodeId, executorSpecs) {
  const role = ROLE_FOR_STAGE[stage];
  const { binding, spec } = executorSpecFor(approval, role, executorSpecs);
  const node = nodeScope(approval, nodeId);
  const evidence = evidenceForStage(state, stage, nodeId);
  const prompt = renderApprovedAttemptPrompt({ approval, node_id: nodeId, role, stage, evidence });
  const promptRecord = buildAttemptPromptRecord({
    approval,
    node_id: nodeId,
    role,
    stage,
    evidence,
    rendered_prompt: prompt,
  });
  const identity = attemptIdentity(state, stage, nodeId);
  const receiptId = `receipt-${createHash('sha256').update(identity.attemptId, 'utf8').digest('hex').slice(0, 24)}`;
  const job = normalizeDurableJob({
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'durable-role-job',
    driver: QUEUE_DRIVER_ID,
    run_id: approval.run_id,
    node_id: nodeId,
    role,
    stage,
    attempt_id: identity.attemptId,
    idempotency_key: identity.idempotencyKey,
    state: 'prepared',
    approval_digest: state.approval_digest,
    approved_framing_digest: state.approval_digest,
    rendered_prompt_digest: renderedPromptDigest(prompt),
    binding,
    work_dir: node.work_dir,
    source_ordinal: node.source_ordinal,
    file_refs: node.file_refs.map((entry) => entry.path),
    file_ref_identities: node.file_refs,
    allowed_paths: node.allowed_paths,
    budget: {
      stage,
      max_calls: approval.budgets.stages[stage].max_calls,
      max_elapsed_ms: remainingElapsedBudget(state, approval, stage),
      attempt_ordinal: identity.ordinal,
    },
    approval_provenance: {
      authorization_ref: approval.approval_provenance.authorization_ref,
      request_digest: approval.approval_provenance.request_digest,
    },
    terminal_receipt_id: receiptId,
    public_result_ref: null,
  });
  const refs = canonicalAttemptRefs(job);
  const normalizedJob = normalizeDurableJob({ ...job, public_result_ref: refs.public_result_ref });
  return { job: normalizedJob, refs, role, binding, spec, evidence, prompt, promptRecord };
}

function lifecycleCommand(state, operation, to, payload = {}) {
  const id = payload.idempotency_key ?? `${pathToken(state.run_id)}/lifecycle/${operation}/${state.revision}`;
  return {
    expected_revision: state.revision,
    expected_approval_digest: state.approval_digest,
    idempotency_key: id,
    input: {
      kind: 'lifecycle',
      from: state.stage,
      to,
      operation,
      ...payload,
    },
  };
}

function commitLifecycle(runDir, state, operation, to, payload, dependencies) {
  const result = commitQueueMutation(runDir, lifecycleCommand(state, operation, to, payload), dependencies.storeOptions);
  dependencies.afterTransition?.({ operation, result });
  return result.state;
}

function park(runDir, state, diagnostic, dependencies) {
  if (state.stage === 'held') return state;
  return commitLifecycle(runDir, state, 'park', 'held', {
    diagnostic,
    idempotency_key: `${pathToken(state.run_id)}/park/${pathToken(diagnostic)}/${state.revision}`,
  }, dependencies);
}

function reserveAttempt(runDir, state, approval, stage, nodeId, executorSpecs, dependencies) {
  const diagnostic = budgetDiagnostic(state, approval, stage, nodeId);
  if (diagnostic) return park(runDir, state, diagnostic, dependencies);
  if (stage === 'review') {
    const implementer = approval.routing.implementer;
    const reviewer = approval.routing.reviewer;
    if (executionBindingDigest(implementer) === executionBindingDigest(reviewer)) {
      return park(runDir, state, 'review-binding-not-independent', dependencies);
    }
  }
  const attempt = buildJob(state, approval, stage, nodeId, executorSpecs);
  const nextStage = ({ implementation: 'implementing', repair: 'repair_ready', review: 'reviewing',
    advisor: 'reviewing', final_verification: 'verifying' })[stage];
  const next = commitLifecycle(runDir, state, 'reserve-attempt', nextStage, {
    attempt_id: attempt.job.attempt_id,
    node_id: nodeId,
    role: attempt.role,
    stage,
    attempt_ordinal: attempt.job.budget.attempt_ordinal,
    binding_digest: executionBindingDigest(attempt.binding),
    rendered_prompt_digest: attempt.job.rendered_prompt_digest,
    idempotency_key: `${pathToken(state.run_id)}/reserve/${attempt.job.attempt_id}`,
  }, dependencies);
  dependencies.afterReservation?.({ job: attempt.job, state: next });
  return next;
}

function privateRequestPath(repoRoot, refs) {
  return join(repoRoot, ...PRIVATE_RECEIPT_ROOT.split('/'), ...refs.private_request_ref.split('/'));
}

function privateRawResultPath(repoRoot, refs) {
  return join(repoRoot, ...PRIVATE_RECEIPT_ROOT.split('/'), ...refs.private_raw_result_ref.split('/'));
}

function prepareOrResumeAttempt(context, state, approval, attempt) {
  const requestPath = privateRequestPath(context.repoRoot, attempt.refs);
  if (existsSync(requestPath)) {
    const workerStartPath = join(
      context.repoRoot,
      ...PRIVATE_RECEIPT_ROOT.split('/'),
      ...attempt.refs.private_worker_start_ref.split('/'),
    );
    return { request_path: requestPath, resumed: true, worker_started: existsSync(workerStartPath) };
  }
  return {
    ...prepareDurableAttempt({
      repoRoot: context.repoRoot,
      publicRunDir: context.runDir,
      job: attempt.job,
      approvalRef: APPROVAL_REF,
      evidence: attempt.evidence,
      renderedPrompt: attempt.prompt,
      executorSpec: attempt.spec,
      outputSchema: outputSchemaFor(attempt.job.stage),
      timeoutMs: remainingElapsedBudget(state, approval, attempt.job.stage),
      expectedPublicResultRef: attempt.refs.public_result_ref,
      expectedPrivateReceiptRef: attempt.refs.private_terminal_receipt_ref,
    }),
    resumed: false,
    worker_started: false,
  };
}

function outputSchemaFor(stage) {
  if (['implementation', 'repair'].includes(stage)) {
    return {
      type: 'object', additionalProperties: false, required: ['status', 'changed_paths'],
      properties: {
        status: { const: 'completed' },
        changed_paths: { type: 'array', items: { type: 'string' } },
      },
    };
  }
  if (stage === 'review') {
    return {
      type: 'object', additionalProperties: false, required: ['verdict'],
      properties: { verdict: { enum: ['approved', 'rejected'] } },
    };
  }
  if (stage === 'advisor') {
    return {
      type: 'object', additionalProperties: false, required: ['recommendation'],
      properties: { recommendation: { enum: ['approve', 'repair', 'park'] } },
    };
  }
  return {
    type: 'object', additionalProperties: false, required: ['verdict', 'reopen_node_ids'],
    properties: {
      verdict: { enum: ['approved', 'reopened'] },
      reopen_node_ids: { type: 'array', items: { type: 'string' } },
    },
  };
}

function elapsedMs(settled) {
  if (settled.terminal_receipt.raw_result_ref === null) return 0;
  const value = settled.private_invocation?.duration_ms;
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('attempt-duration-unavailable', 'terminal provider evidence has no precise duration_ms');
  }
  return value;
}

function attemptPublicBase(attempt) {
  return {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    driver: QUEUE_DRIVER_ID,
    run_id: attempt.job.run_id,
    node_id: attempt.job.node_id,
    attempt_id: attempt.job.attempt_id,
    role: attempt.job.role,
    stage: attempt.job.stage,
    approval_digest: attempt.job.approval_digest,
    rendered_prompt_digest: attempt.job.rendered_prompt_digest,
    binding: bindingProjection(attempt.job.binding),
  };
}

function changedContentEvidence(repoRoot, attempt, settled, requiredPaths = []) {
  if (settled.public_result.changed_paths.length === 0) {
    invalid('implementation-output-missing', 'implementation must report at least one changed file');
  }
  return [...new Set([...settled.public_result.changed_paths, ...requiredPaths])].map((path) => {
    const normalized = normalizePortableRelativePath(path, { allowRoot: false });
    const allowed = attempt.job.allowed_paths.some((root) => normalized === root || normalized.startsWith(`${root}/`));
    if (!allowed) invalid('write-scope-violation', `${normalized} is outside the approved node paths`);
    const target = resolveWithinRoot(repoRoot, normalized);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      invalid('implementation-output-invalid', `${normalized} must be a regular file`);
    }
    if (stat.size === 0) {
      invalid('implementation-output-empty', `${normalized} must be non-empty`);
    }
    const realTarget = realpathSync(target);
    const realAllowed = attempt.job.allowed_paths.some((root) => {
      if (!(normalized === root || normalized.startsWith(`${root}/`))) return false;
      const allowedTarget = resolveWithinRoot(repoRoot, root);
      const allowedStat = lstatSync(allowedTarget);
      if (allowedStat.isSymbolicLink()) return false;
      const allowedReal = realpathSync(allowedTarget);
      return allowedStat.isDirectory() ? inside(allowedReal, realTarget) : allowedReal === realTarget;
    });
    if (!realAllowed) {
      invalid('write-scope-violation', `${normalized} resolves outside its approved write root`);
    }
    return {
      path: normalized,
      content_digest: `sha256:${createHash('sha256').update(readFileSync(target)).digest('hex')}`,
    };
  });
}

function fileContentDigest(repoRoot, path) {
  const normalized = normalizePortableRelativePath(path, { allowRoot: false });
  const target = join(repoRoot, ...normalized.split('/'));
  if (!existsSync(target)) {
    let ancestor = dirname(target);
    while (ancestor !== repoRoot && !existsSync(ancestor)) ancestor = dirname(ancestor);
    const ancestorStat = lstatSync(ancestor);
    if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()
        || !inside(realpathSync(repoRoot), realpathSync(ancestor))) {
      invalid('artifact-path-outside-root', `${path} resolves through an unsafe ancestor`);
    }
    return null;
  }
  const containedTarget = resolveWithinRoot(repoRoot, normalized);
  const stat = lstatSync(containedTarget);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    invalid('artifact-expectation-invalid', `${path} must be a regular file`);
  }
  return `sha256:${createHash('sha256').update(readFileSync(containedTarget)).digest('hex')}`;
}

function artifactBaselineRef(state, attempt) {
  const runToken = createHash('sha256').update(state.run_id, 'utf8').digest('hex').slice(0, 32);
  return portableRef('runs', runToken, 'artifact-baselines', `${pathToken(attempt.job.attempt_id)}.json`);
}

function ensureWorkspaceBaseline(context, state, attempt, prepared) {
  const runToken = createHash('sha256').update(state.run_id, 'utf8').digest('hex').slice(0, 32);
  const ref = portableRef('runs', runToken, 'workspace-baselines', `${pathToken(attempt.job.attempt_id)}.json`);
  const exclusions = ['.git', relative(realpathSync(context.repoRoot), realpathSync(context.runDir)).split(sep).join('/'),
    `${PRIVATE_RECEIPT_ROOT}/runs/${runToken}`].sort();
  // Reading establishes the private parent directories before scanning. Only THIS run's evidence
  // is excluded; ignored files, other runs and unrelated dirty work remain in the baseline.
  let record = readPrivateExecutionRecord(context.repoRoot, ref, 'workspace baseline');
  if (!record) {
    if (prepared.resumed) invalid('workspace-baseline-missing', 'an existing request cannot acquire a post-launch baseline');
    const unsigned = {
      version: 1, kind: 'workspace-baseline', run_id: state.run_id,
      attempt_id: attempt.job.attempt_id, approval_digest: state.approval_digest,
      snapshot: snapshotWorkspace(context.repoRoot, { excludePaths: exclusions }),
    };
    record = { ...unsigned, baseline_digest: documentDigest(unsigned) };
    persistPrivateExecutionRecord(context.repoRoot, ref, record);
  }
  if (record.version !== 1 || record.kind !== 'workspace-baseline'
      || record.run_id !== state.run_id || record.attempt_id !== attempt.job.attempt_id
      || record.approval_digest !== state.approval_digest
      || documentDigest(record.snapshot?.exclude_paths) !== documentDigest(exclusions)
      || record.baseline_digest !== documentDigest(withoutField(record, 'baseline_digest'))) {
    invalid('workspace-baseline-conflict', 'workspace baseline differs from the approved attempt');
  }
  return record.snapshot;
}

function validateWorkspaceChanges(context, baseline, allowedPaths) {
  return assertAllowedWorkspaceDelta(baseline,
    snapshotWorkspace(context.repoRoot, { excludePaths: baseline.exclude_paths }), allowedPaths);
}

function runWorkspaceBaseline(context, state, { initialSnapshot = null, approval = null } = {}) {
  const token = createHash('sha256').update(state.run_id, 'utf8').digest('hex').slice(0, 32);
  const ref = portableRef('runs', token, 'run-workspace-baseline.json');
  let record = readPrivateExecutionRecord(context.repoRoot, ref, 'run workspace baseline');
  if (!record) {
    if (!initialSnapshot || state.budget_usage.total.calls !== 0) {
      invalid('workspace-baseline-missing', 'the original run workspace baseline must remain available');
    }
    const unsigned = { kind: 'run-workspace-baseline', run_id: state.run_id,
      approval_digest: state.approval_digest, snapshot: initialSnapshot,
      git_boundaries: captureGitBoundaries(context.repoRoot, approval.framing.scope.allowed_paths) };
    record = { ...unsigned, digest: documentDigest(unsigned) };
    persistPrivateExecutionRecord(context.repoRoot, ref, record);
  }
  if (record.kind !== 'run-workspace-baseline' || record.run_id !== state.run_id
      || record.approval_digest !== state.approval_digest
      || record.digest !== documentDigest(withoutField(record, 'digest'))) {
    invalid('workspace-baseline-conflict', 'run workspace baseline does not match approval');
  }
  return record;
}

function workspaceSettlementRef(state, attemptId) {
  const token = createHash('sha256').update(state.run_id, 'utf8').digest('hex').slice(0, 32);
  return portableRef('runs', token, 'workspace-settlements', `${pathToken(attemptId)}.json`);
}

function latestWorkspaceSnapshot(context, state) {
  const previous = [...state.lifecycle_history].reverse().find(entry => entry.operation === 'settle-attempt'
    && entry.disposition !== 'parked');
  if (!previous) return runWorkspaceBaseline(context, state).snapshot;
  const record = readPrivateExecutionRecord(context.repoRoot, workspaceSettlementRef(state, previous.attempt_id));
  if (!record || record.kind !== 'workspace-settlement' || record.run_id !== state.run_id
      || record.attempt_id !== previous.attempt_id || record.approval_digest !== state.approval_digest
      || record.digest !== documentDigest(withoutField(record, 'digest'))) {
    invalid('workspace-baseline-conflict', 'latest settled workspace evidence is missing or conflicting');
  }
  return record.snapshot;
}

function validateGitBoundaries(context, state, approval) {
  const initial = runWorkspaceBaseline(context, state);
  if (documentDigest(initial.git_boundaries)
      !== documentDigest(captureGitBoundaries(context.repoRoot, approval.framing.scope.allowed_paths))) {
    invalid('git-boundary-changed', 'Git ownership, branch, ref or security metadata changed during the run');
  }
}

function ensureArtifactBaseline(context, state, attempt, nodeScope, { allowCreate = true } = {}) {
  const expectations = nodeScope.artifact_expectations ?? [];
  if (expectations.length === 0) return null;
  const ref = artifactBaselineRef(state, attempt);
  if (!allowCreate && !readPrivateExecutionRecord(context.repoRoot, ref, 'artifact expectation baseline')) {
    invalid('artifact-baseline-conflict', 'a prepared attempt cannot acquire a new artifact baseline');
  }
  const unsigned = {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'artifact-expectation-baseline',
    driver: QUEUE_DRIVER_ID,
    run_id: state.run_id,
    attempt_id: attempt.job.attempt_id,
    approval_digest: state.approval_digest,
    entries: expectations.map((expectation) => ({
      path: normalizePortableRelativePath(expectation.path, { allowRoot: false }),
      content_digest: fileContentDigest(context.repoRoot, expectation.path),
    })),
  };
  const candidate = { ...unsigned, baseline_digest: documentDigest(unsigned) };
  persistPrivateExecutionRecord(context.repoRoot, ref, candidate, { observeConflict: true });
  const baseline = readPrivateExecutionRecord(context.repoRoot, ref, 'artifact expectation baseline');
  const expectedPaths = candidate.entries.map((entry) => entry.path);
  if (!baseline || baseline.schema_version !== DURABLE_EXECUTION_SCHEMA_VERSION
      || baseline.kind !== candidate.kind || baseline.driver !== QUEUE_DRIVER_ID
      || baseline.run_id !== state.run_id || baseline.attempt_id !== attempt.job.attempt_id
      || baseline.approval_digest !== state.approval_digest
      || !Array.isArray(baseline.entries)
      || documentDigest(baseline.entries.map((entry) => entry.path)) !== documentDigest(expectedPaths)
      || baseline.entries.some((entry) => entry.content_digest !== null
        && !/^sha256:[0-9a-f]{64}$/.test(entry.content_digest))
      || baseline.baseline_digest !== documentDigest(withoutField(baseline, 'baseline_digest'))) {
    invalid('artifact-baseline-conflict', 'durable artifact baseline is malformed or belongs to another attempt');
  }
  return baseline;
}

function prepareWithWorkspaceEvidence(context, state, approval, attempt, nodeScope, dependencies) {
  const runToken = createHash('sha256').update(state.run_id, 'utf8').digest('hex').slice(0, 32);
  const base = portableRef('runs', runToken, 'preparation', pathToken(attempt.job.attempt_id));
  const claimRef = `${base}/claim.json`;
  const doneRef = `${base}/complete.json`;
  const identity = { run_id: state.run_id, attempt_id: attempt.job.attempt_id, approval_digest: state.approval_digest };
  const complete = readPrivateExecutionRecord(context.repoRoot, doneRef, 'workspace preparation receipt');
  if (complete) {
    const requestPath = privateRequestPath(context.repoRoot, attempt.refs);
    const claim = readPrivateExecutionRecord(context.repoRoot, claimRef, 'workspace preparation claim');
    if (complete.kind !== 'workspace-preparation-complete' || documentDigest(complete.identity) !== documentDigest(identity)
        || complete.claim_digest !== documentDigest(claim)
        || !existsSync(requestPath) || complete.request_digest !== sha256Text(readFileSync(requestPath, 'utf8'))) {
      invalid('workspace-baseline-conflict', 'preparation receipt no longer binds the current request');
    }
    const workspaceBaseline = ensureWorkspaceBaseline(context, state, attempt, { resumed: true });
    const initial = runWorkspaceBaseline(context, state);
    if (complete.workspace_digest !== documentDigest(workspaceBaseline)) {
      invalid('workspace-baseline-conflict', 'preparation receipt no longer binds the original workspace');
    }
    if (complete.run_workspace_digest !== initial.digest) {
      invalid('workspace-baseline-conflict', 'preparation receipt no longer binds original run workspace');
    }
    const artifactBaseline = nodeScope
      ? ensureArtifactBaseline(context, state, attempt, nodeScope, { allowCreate: false }) : null;
    if (complete.artifact_digest !== documentDigest(artifactBaseline)) {
      invalid('artifact-baseline-conflict', 'preparation receipt no longer binds original artifact evidence');
    }
    return { prepared: prepareOrResumeAttempt(context, state, approval, attempt), workspaceBaseline, artifactBaseline };
  }
  const candidate = { kind: 'workspace-preparation-claim', identity, claim: createPrivateExecutionClaim('workspace-preparation') };
  persistPrivateExecutionRecord(context.repoRoot, claimRef, candidate, { observeConflict: true });
  const claim = readPrivateExecutionRecord(context.repoRoot, claimRef, 'workspace preparation claim');
  if (claim?.kind !== candidate.kind || documentDigest(claim.identity) !== documentDigest(identity)) {
    invalid('workspace-baseline-conflict', 'preparation claim belongs to a different attempt');
  }
  if (claim.claim.claim_id !== candidate.claim.claim_id) {
    const observed = observePrivateExecutionClaim(claim.claim);
    const abandonedHere = claim.claim.owner.pid === process.pid
      && claim.claim.owner.host_id === candidate.claim.owner.host_id
      && !ACTIVE_PREPARATION_CLAIMS.has(claim.claim.claim_id);
    if (!abandonedHere && observed.liveness === 'live' && observed.identity === 'verified') throw waitSignal();
    invalid('workspace-preparation-unknown', 'interrupted or ambiguous preparation cannot dispatch or acquire a new baseline');
  }
  // Only the exclusive claimant can freeze evidence and publish a dispatchable request.
  if (existsSync(privateRequestPath(context.repoRoot, attempt.refs))) {
    invalid('workspace-baseline-missing', 'an existing request without preparation completion cannot dispatch');
  }
  ACTIVE_PREPARATION_CLAIMS.add(claim.claim.claim_id);
  try {
    dependencies.beforeWorkspaceBaseline?.();
    const artifactBaseline = nodeScope ? ensureArtifactBaseline(context, state, attempt, nodeScope) : null;
    const workspaceBaseline = ensureWorkspaceBaseline(context, state, attempt, { resumed: false });
    const initial = runWorkspaceBaseline(context, state, { initialSnapshot: workspaceBaseline, approval });
    assertAllowedWorkspaceDelta(latestWorkspaceSnapshot(context, state), workspaceBaseline, []);
    validateGitBoundaries(context, state, approval);
    dependencies.afterWorkspaceBaseline?.();
    const prepared = prepareOrResumeAttempt(context, state, approval, attempt);
    dependencies.afterWorkspaceRequest?.();
    persistPrivateExecutionRecord(context.repoRoot, doneRef, {
      kind: 'workspace-preparation-complete', identity, claim_digest: documentDigest(claim),
      workspace_digest: documentDigest(workspaceBaseline), artifact_digest: documentDigest(artifactBaseline),
      run_workspace_digest: initial.digest,
      request_digest: sha256Text(readFileSync(prepared.request_path, 'utf8')),
    });
    return { prepared, workspaceBaseline, artifactBaseline };
  } finally {
    ACTIVE_PREPARATION_CLAIMS.delete(claim.claim.claim_id);
  }
}

function validateArtifactExpectations(repoRoot, nodeScope, reportedPaths, {
  requireTouch, baseline, priorProvenance,
}) {
  const expectations = nodeScope.artifact_expectations ?? [];
  const baselineByPath = new Map((baseline?.entries ?? []).map((entry) => [entry.path, entry]));
  const priorByPath = new Map((priorProvenance ?? []).map((entry) => [entry.path, entry]));
  const provenance = [];
  for (const expectation of expectations) {
    const path = normalizePortableRelativePath(expectation.path, { allowRoot: false });
    if (expectation.kind !== 'file' || expectation.exists !== true
        || expectation.allow_empty !== false || expectation.touch !== 'run') {
      invalid('artifact-expectation-unsupported', `${path} has unsupported runtime semantics`);
    }
    if (requireTouch && !reportedPaths.includes(path)) {
      invalid('artifact-expectation-not-touched', `${path} was not reported as changed by this run`);
    }
    let target;
    try { target = resolveWithinRoot(repoRoot, path); }
    catch { invalid('artifact-expectation-missing', `${path} does not exist beneath the repository root`); }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      invalid('artifact-expectation-invalid', `${path} must be a regular file`);
    }
    if (stat.size === 0) invalid('artifact-expectation-empty', `${path} must be non-empty`);
    const currentDigest = fileContentDigest(repoRoot, path);
    const beforeDigest = baselineByPath.get(path)?.content_digest;
    if (beforeDigest === undefined) {
      invalid('artifact-baseline-conflict', `${path} is absent from the durable attempt baseline`);
    }
    if (requireTouch) {
      if (beforeDigest === currentDigest) {
        invalid('artifact-expectation-not-touched', `${path} content did not change during this run`);
      }
      provenance.push({
        path, touch: 'run', before_content_digest: beforeDigest, after_content_digest: currentDigest,
      });
      continue;
    }
    const prior = priorByPath.get(path);
    if (!prior || prior.touch !== 'run' || !/^sha256:[0-9a-f]{64}$/.test(prior.after_content_digest)) {
      invalid('artifact-provenance-missing', `${path} has no durable prior touch provenance`);
    }
    if (reportedPaths.includes(path)) {
      if (beforeDigest === currentDigest) {
        invalid('artifact-expectation-not-touched', `${path} was reported by repair but its content did not change`);
      }
      provenance.push({ ...prior, after_content_digest: currentDigest });
    } else {
      if (prior.after_content_digest !== currentDigest) {
        invalid('artifact-provenance-conflict', `${path} changed without being reported by repair`);
      }
      provenance.push(prior);
    }
  }
  return { paths: expectations.map((expectation) => expectation.path), provenance };
}

function validateReportedChangedPaths(attempt, result, publicChangedPaths) {
  if (result.changed_paths.length === 0) {
    invalid('implementation-output-missing', 'implementation must report at least one changed file');
  }
  const normalized = result.changed_paths.map((candidate) => {
    if (typeof candidate !== 'string') {
      invalid('implementation-result-invalid', 'every changed path must be a canonical portable string');
    }
    const path = normalizePortableRelativePath(candidate, { allowRoot: false });
    if (path !== candidate) {
      invalid('implementation-result-invalid', `changed path ${candidate} is not canonical`);
    }
    if (!attempt.job.allowed_paths.some((root) => path === root || path.startsWith(`${root}/`))) {
      invalid('write-scope-violation', `${path} is outside the approved node paths`);
    }
    return path;
  });
  if (new Set(normalized).size !== normalized.length) {
    invalid('implementation-result-invalid', 'changed paths must not contain duplicates');
  }
  const expected = [...normalized].sort();
  if (documentDigest(expected) !== documentDigest(publicChangedPaths)) {
    invalid('implementation-result-invalid', 'sanitized changed paths differ from the raw implementation result');
  }
}

function implementationEvidence(context, attempt, settled, nodeScope, {
  requireExpectedTouch, artifactBaseline, priorArtifactProvenance, workspaceBaseline,
}) {
  const result = settled.private_result;
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.status !== 'completed' || !Array.isArray(result.changed_paths)) {
    invalid('implementation-result-invalid', 'implementation must return the real completed result document');
  }
  validateReportedChangedPaths(attempt, result, settled.public_result.changed_paths);
  validateWorkspaceChanges(context, workspaceBaseline, attempt.job.allowed_paths);
  const expected = validateArtifactExpectations(
    context.repoRoot,
    nodeScope,
    settled.public_result.changed_paths,
    {
      requireTouch: requireExpectedTouch,
      baseline: artifactBaseline,
      priorProvenance: priorArtifactProvenance,
    },
  );
  const node = pathToken(attempt.job.node_id);
  const id = pathToken(attempt.job.attempt_id);
  const ref = portableRef('evidence', node, `${id}.json`);
  const currentRef = portableRef('evidence', `${node}.json`);
  const document = {
    ...attemptPublicBase(attempt),
    kind: 'implementation-evidence',
    public_result_ref: attempt.refs.public_result_ref,
    receipt_id: settled.terminal_receipt.receipt_id,
    terminal_receipt_digest: documentDigest(settled.terminal_receipt),
    result_digest: settled.terminal_receipt.result_digest,
    changed_paths: settled.public_result.changed_paths,
    content: changedContentEvidence(context.repoRoot, attempt, settled, expected.paths),
    artifact_provenance: expected.provenance,
    completed_at: settled.public_result.completed_at,
  };
  const digest = documentDigest(document);
  const withDigest = { ...document, evidence_digest: digest };
  persistImmutableJson(context.runDir, ref, withDigest, 'implementation evidence');
  persistCurrentJson(context.runDir, currentRef, withDigest);
  return { ref, digest, document: withDigest };
}

function reviewVerdict(runDir, attempt, settled, state) {
  const result = settled.private_result;
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !['approved', 'rejected'].includes(result.verdict)) {
    invalid('review-evidence-invalid', 'reviewer must return an approved or rejected verdict document');
  }
  const node = nodeState(state, attempt.job.node_id);
  const nodePath = pathToken(attempt.job.node_id);
  const id = pathToken(attempt.job.attempt_id);
  const ref = portableRef('reviews', nodePath, id, 'verdict.json');
  const unsignedDocument = {
    ...attemptPublicBase(attempt),
    kind: 'independent-review-verdict',
    verdict: result.verdict,
    summary: result.verdict === 'approved' ? 'Independent review approved the current evidence.'
      : 'Independent review rejected the current evidence and requested bounded repair.',
    reviewed_evidence_digest: node.evidence_digest,
    public_result_ref: attempt.refs.public_result_ref,
    receipt_id: settled.terminal_receipt.receipt_id,
    terminal_receipt_digest: documentDigest(settled.terminal_receipt),
    result_digest: settled.terminal_receipt.result_digest,
    completed_at: settled.public_result.completed_at,
  };
  const decisionDigest = documentDigest(unsignedDocument);
  const document = { ...unsignedDocument, evidence_digest: decisionDigest };
  persistImmutableJson(runDir, ref, document, 'review verdict');
  return { ref, digest: decisionDigest, verdict: result.verdict, document };
}

function finalVerdict(runDir, attempt, settled, state) {
  const result = settled.private_result;
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !['approved', 'reopened'].includes(result.verdict) || !Array.isArray(result.reopen_node_ids)) {
    invalid('final-verification-evidence-invalid', 'final verifier must return verdict and reopen_node_ids');
  }
  const known = new Set(state.nodes.map((node) => node.node_id));
  const reopen = [...new Set(result.reopen_node_ids)];
  if (reopen.some((nodeId) => !known.has(nodeId))
      || (result.verdict === 'approved' && reopen.length !== 0)
      || (result.verdict === 'reopened' && reopen.length === 0)) {
    invalid('final-verification-scope-invalid', 'final verifier returned an invalid reopen scope');
  }
  const verifiedStateDigest = stateDigestForVerification(state);
  const id = pathToken(attempt.job.attempt_id);
  const ref = portableRef('final-verification', 'verdicts', `${id}.json`);
  const unsignedDocument = {
    ...attemptPublicBase(attempt),
    kind: 'final-verification-verdict',
    verdict: result.verdict,
    summary: result.verdict === 'approved' ? 'Final verification approved the latest durable state.'
      : 'Final verification reopened bounded work on the latest durable state.',
    reopen_node_ids: reopen,
    verified_state_digest: verifiedStateDigest,
    public_result_ref: attempt.refs.public_result_ref,
    receipt_id: settled.terminal_receipt.receipt_id,
    terminal_receipt_digest: documentDigest(settled.terminal_receipt),
    result_digest: settled.terminal_receipt.result_digest,
    completed_at: settled.public_result.completed_at,
  };
  const decisionDigest = documentDigest(unsignedDocument);
  const document = { ...unsignedDocument, evidence_digest: decisionDigest };
  persistImmutableJson(runDir, ref, document, 'final verification verdict');
  persistCurrentJson(runDir, 'final-verification/verdict.json', document);
  return { ref, digest: decisionDigest, verdict: result.verdict, reopen, verifiedStateDigest, document };
}

function withoutField(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function validatePublicAttemptResults(runDir, state) {
  for (const [attemptId, attempt] of Object.entries(state.attempts)) {
    const result = normalizePublicResult(readPublicJson(runDir, attempt.public_result_ref, 'public attempt result'));
    if (documentDigest(result) !== attempt.public_result_digest
        || result.attempt_id !== attemptId
        || result.receipt_id !== attempt.receipt_id
        || result.evidence_digest !== attempt.public_evidence_digest
        || result.classification !== attempt.classification
        || result.approval_digest !== state.approval_digest
        || result.rendered_prompt_digest !== attempt.rendered_prompt_digest) {
      invalid('public-evidence-conflict', `public result for ${attemptId} no longer matches durable state`);
    }
  }
}

function validateNodeEvidence(repoRoot, runDir, node) {
  const evidence = readPublicJson(runDir, node.evidence_ref, `implementation evidence for ${node.node_id}`);
  if (evidence.kind !== 'implementation-evidence'
      || evidence.node_id !== node.node_id
      || evidence.evidence_digest !== node.evidence_digest
      || documentDigest(withoutField(evidence, 'evidence_digest')) !== node.evidence_digest
      || !Array.isArray(evidence.content) || evidence.content.length === 0) {
    invalid('public-evidence-conflict', `implementation evidence for ${node.node_id} is stale or malformed`);
  }
  for (const entry of evidence.content) {
    const path = normalizePortableRelativePath(entry.path, { allowRoot: false });
    const target = resolveWithinRoot(repoRoot, path);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      invalid('terminal-evidence-stale', `${path} is no longer a regular file`);
    }
    if (stat.size === 0) invalid('terminal-evidence-stale', `${path} is now empty`);
    const digest = `sha256:${createHash('sha256').update(readFileSync(target)).digest('hex')}`;
    if (digest !== entry.content_digest) invalid('terminal-evidence-stale', `${path} changed after review`);
  }
  const review = readPublicJson(runDir, node.review?.verdict_ref, `review verdict for ${node.node_id}`);
  const expectedReviewDigest = documentDigest(withoutField(review, 'evidence_digest'));
  if (review.kind !== 'independent-review-verdict'
      || review.node_id !== node.node_id
      || review.verdict !== 'approved'
      || review.reviewed_evidence_digest !== node.evidence_digest
      || review.evidence_digest !== node.review?.evidence_digest
      || expectedReviewDigest !== node.review?.evidence_digest) {
    invalid('terminal-evidence-stale', `review for ${node.node_id} is not current`);
  }
}

function validateTestEvidence(runDir, state, approval) {
  if (state.tests?.verdict !== 'passed') invalid('approved-tests-required', 'approved tests have not passed');
  const intent = approvedTestIntent(state, approval, state.tests);
  const materializedIntent = readPublicJson(runDir, state.tests.intent_ref, 'approved test intent');
  if (documentDigest(materializedIntent) !== documentDigest(intent)) {
    invalid('terminal-evidence-stale', 'approved test intent is stale or malformed');
  }
  const document = readPublicJson(runDir, state.tests.result_ref, 'approved test result');
  validateApprovedTestProjection(document, state, approval, intent, { requirePassed: true });
  if (document.evidence_digest !== state.tests.evidence_digest) {
    invalid('terminal-evidence-stale', 'approved test evidence is stale or malformed');
  }
}

function validateFinalEvidence(repoRoot, runDir, state, approval) {
  validateWorkspaceChanges({ repoRoot, runDir }, latestWorkspaceSnapshot({ repoRoot, runDir }, state), []);
  validateGitBoundaries({ repoRoot, runDir }, state, approval);
  validatePublicAttemptResults(runDir, state);
  for (const node of state.nodes) validateNodeEvidence(repoRoot, runDir, node);
  validateTestEvidence(runDir, state, approval);
  const verdict = readPublicJson(runDir, state.final_verification?.verdict_ref, 'final verification verdict');
  const expectedDigest = documentDigest(withoutField(verdict, 'evidence_digest'));
  if (verdict.kind !== 'final-verification-verdict'
      || verdict.verdict !== 'approved'
      || verdict.evidence_digest !== state.final_verification?.evidence_digest
      || verdict.verified_state_digest !== state.final_verification?.verified_state_digest
      || expectedDigest !== state.final_verification?.evidence_digest) {
    invalid('terminal-evidence-stale', 'final verification evidence is stale or malformed');
  }
}

function readPrivateInvocation(repoRoot, attempt) {
  return readJson(privateRawResultPath(repoRoot, attempt.refs), 'private raw result');
}

function waitSignal() {
  const error = new Error('durable worker is still active');
  error.code = 'LIFECYCLE_WAIT';
  return error;
}

async function runOrReconcilePrepared(context, attempt, prepared, workerDependencies, dependencies) {
  if (dependencies.executePreparedAttempt) {
    return dependencies.executePreparedAttempt(prepared.request_path, workerDependencies);
  }
  const launch = dependencies.launchPreparedAttempt ?? launchPreparedAttempt;
  const reconcile = dependencies.reconcilePreparedAttempt ?? reconcilePreparedAttempt;
  if (!prepared.worker_started) {
    dependencies.afterAttemptPrepared?.({ attempt, prepared });
    dependencies.beforeAttemptLaunch?.({ attempt, prepared });
    const launched = await launch(prepared.request_path, workerDependencies);
    dependencies.afterAttemptLaunch?.({ attempt, prepared, launched });
    if (dependencies.nonBlocking === true) throw waitSignal();
  } else if (dependencies.nonBlocking === true) {
    const observed = await reconcile(prepared.request_path);
    if (observed.incumbent || observed.unclaimed) throw waitSignal();
    return observed;
  }
  const publicResult = join(context.runDir, ...attempt.refs.public_result_ref.split('/'));
  const deadline = Date.now() + attempt.job.budget.max_elapsed_ms + 10_000;
  while (!existsSync(publicResult) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const observed = await reconcile(prepared.request_path);
  if (observed.unclaimed) invalid('durable-worker-start-unknown', 'detached worker never established a durable claim');
  return observed;
}

async function executeActiveAttempt(context, state, approval, executorSpecs, dependencies) {
  const active = state.active_attempt;
  if (!active) invalid('run-state-invalid', `stage ${state.stage} has no active attempt`);
  const attempt = buildJob(state, approval, active.stage, active.node_id, executorSpecs);
  if (attempt.job.attempt_id !== active.attempt_id
      || executionBindingDigest(attempt.binding) !== active.binding_digest
      || attempt.job.rendered_prompt_digest !== active.rendered_prompt_digest) {
    invalid('attempt-identity-changed', 'active durable attempt no longer matches approved state');
  }
  const mutating = ['implementation', 'repair'].includes(active.stage);
  const approvedNodeScope = mutating
    ? approval.framing.node_scopes.find((node) => node.node_id === active.node_id)
    : null;
  if (mutating && !approvedNodeScope) {
    invalid('approval-node-unknown', `node ${active.node_id} is absent from approved framing`);
  }
  const priorNode = active.stage === 'repair' ? nodeState(state, active.node_id) : null;
  const priorEvidence = priorNode
    ? readPublicJson(context.runDir, priorNode.evidence_ref,
      `prior implementation evidence for ${active.node_id}`)
    : null;
  if (priorNode && (!priorEvidence || typeof priorEvidence !== 'object' || Array.isArray(priorEvidence)
      || priorEvidence.kind !== 'implementation-evidence'
      || priorEvidence.run_id !== state.run_id
      || priorEvidence.node_id !== active.node_id
      || priorEvidence.approval_digest !== state.approval_digest
      || priorEvidence.evidence_digest !== priorNode.evidence_digest
      || documentDigest(withoutField(priorEvidence, 'evidence_digest')) !== priorNode.evidence_digest)) {
    invalid('public-evidence-conflict', `prior implementation evidence for ${active.node_id} was modified`);
  }
  const { prepared, workspaceBaseline, artifactBaseline } = prepareWithWorkspaceEvidence(
    context, state, approval, attempt, approvedNodeScope, dependencies,
  );
  const workerDependencies = dependencies.workerDependenciesFor?.(attempt.job) ?? {};
  const settled = await runOrReconcilePrepared(context, attempt, prepared, workerDependencies, dependencies);
  if (settled.incumbent) throw waitSignal();
  settled.private_invocation = settled.terminal_receipt.raw_result_ref === null
    ? null : readPrivateInvocation(context.repoRoot, attempt);
  settled.private_result = settled.private_invocation?.result ?? null;
  dependencies.afterAttempt?.({ job: attempt.job, settled, prepared });
  const terminalDigest = documentDigest(settled.terminal_receipt);
  const base = {
    attempt_id: attempt.job.attempt_id,
    node_id: attempt.job.node_id,
    role: attempt.job.role,
    stage: attempt.job.stage,
    receipt_id: settled.terminal_receipt.receipt_id,
    terminal_receipt_digest: terminalDigest,
    public_result_ref: attempt.refs.public_result_ref,
    public_result_digest: documentDigest(settled.public_result),
    public_evidence_digest: settled.public_result.evidence_digest,
    classification: settled.terminal_receipt.classification,
    elapsed_ms: elapsedMs(settled),
    idempotency_key: `${pathToken(state.run_id)}/settle/${attempt.job.attempt_id}`,
  };
  if (settled.terminal_receipt.classification !== 'success') {
    return commitLifecycle(context.runDir, state, 'settle-attempt', 'held', {
      ...base,
      disposition: 'parked',
      diagnostic: settled.public_result.diagnostics[0] ?? 'attempt-failed',
    }, dependencies);
  }

  let transition;
  try {
    validateGitBoundaries(context, state, approval);
    if (mutating) {
      const evidence = implementationEvidence(context, attempt, settled, approvedNodeScope, {
        requireExpectedTouch: active.stage === 'implementation',
        artifactBaseline,
        priorArtifactProvenance: priorEvidence?.artifact_provenance,
        workspaceBaseline,
      });
      transition = {
        to: 'reviewing',
        payload: {
          ...base,
          disposition: active.stage === 'implementation' ? 'implementation-complete' : 'repair-complete',
          evidence_digest: evidence.digest,
          evidence_ref: evidence.ref,
        },
      };
    } else if (active.stage === 'review') {
      validateWorkspaceChanges(context, workspaceBaseline, []);
      const verdict = reviewVerdict(context.runDir, attempt, settled, state);
      transition = {
        to: verdict.verdict === 'approved' ? 'ready' : 'repair_ready',
        payload: {
          ...base,
          disposition: verdict.verdict === 'approved' ? 'review-approved' : 'review-rejected',
          verdict_ref: verdict.ref,
          evidence_digest: verdict.digest,
          reviewed_evidence_digest: nodeState(state, active.node_id).evidence_digest,
        },
      };
    } else if (active.stage === 'final_verification') {
      validateWorkspaceChanges(context, workspaceBaseline, []);
      const verdict = finalVerdict(context.runDir, attempt, settled, state);
      transition = {
        to: verdict.verdict === 'approved' ? 'exit_checking' : 'repair_ready',
        payload: {
          ...base,
          disposition: verdict.verdict === 'approved' ? 'final-approved' : 'final-reopened',
          verdict_ref: verdict.ref,
          evidence_digest: verdict.digest,
          verified_state_digest: verdict.verifiedStateDigest,
          reopen_node_ids: verdict.reopen,
        },
      };
    } else {
      invalid('lifecycle-stage-invalid', `active stage ${active.stage} is not executable`);
    }
    const finalSnapshot = snapshotWorkspace(context.repoRoot, { excludePaths: workspaceBaseline.exclude_paths });
    assertAllowedWorkspaceDelta(workspaceBaseline, finalSnapshot, mutating ? attempt.job.allowed_paths : []);
    const unsigned = { kind: 'workspace-settlement', run_id: state.run_id,
      attempt_id: attempt.job.attempt_id, approval_digest: state.approval_digest,
      terminal_receipt_digest: terminalDigest, snapshot: finalSnapshot };
    persistPrivateExecutionRecord(context.repoRoot, workspaceSettlementRef(state, attempt.job.attempt_id), {
      ...unsigned, digest: documentDigest(unsigned),
    });
  } catch (error) {
    transition = {
      to: 'held',
      payload: { ...base, disposition: 'parked', diagnostic: codeOf(error) },
    };
  }
  return commitLifecycle(context.runDir, state, 'settle-attempt', transition.to, transition.payload, dependencies);
}

function eligibleNode(state) {
  return state.nodes
    .filter((node) => node.status === 'pending'
      && node.dependencies.every((dependency) => nodeState(state, dependency).status === 'complete'))
    .sort((a, b) => a.source_ordinal - b.source_ordinal)[0] ?? null;
}

function repairNode(state) {
  return state.nodes
    .filter((node) => node.status === 'needs-repair')
    .sort((a, b) => a.source_ordinal - b.source_ordinal)[0] ?? null;
}

function reviewNode(state) {
  return state.nodes
    .filter((node) => node.status === 'awaiting-review')
    .sort((a, b) => a.source_ordinal - b.source_ordinal)[0] ?? null;
}

function testRefs(state) {
  const ordinal = state.budget_usage.stages.tests.calls + 1;
  const base = portableRef('tests', `attempt-${ordinal}`);
  return {
    ordinal,
    intent: `${base}/intent.json`,
    claim: `${base}/claim.json`,
    result: `${base}/result.json`,
  };
}

function privateTestRefs(state, active, test, index) {
  const runToken = createHash('sha256').update(state.run_id, 'utf8').digest('hex').slice(0, 32);
  const base = portableRef('runs', runToken, 'tests', `attempt-${active.attempt_ordinal}`);
  if (test === null) return { settlement: `${base}/settlement.json` };
  const testToken = createHash('sha256').update(test.id, 'utf8').digest('hex').slice(0, 16);
  const testBase = `${base}/case-${index + 1}-${testToken}`;
  return { claim: `${testBase}/claim.json`, result: `${testBase}/result.json` };
}

function approvedTestIntent(state, approval, active) {
  return {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'approved-test-intent',
    driver: QUEUE_DRIVER_ID,
    run_id: state.run_id,
    attempt_ordinal: active.attempt_ordinal,
    approval_digest: state.approval_digest,
    tests: approval.framing.tests,
  };
}

function approvedTestClaim(state, active, intent) {
  return {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'approved-test-claim',
    driver: QUEUE_DRIVER_ID,
    run_id: state.run_id,
    attempt_ordinal: active.attempt_ordinal,
    approval_digest: state.approval_digest,
    intent_digest: documentDigest(intent),
  };
}

function privateTestCaseClaim(state, active, intent, test, index, timeoutMs, ownership) {
  return {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'approved-test-case-claim',
    driver: QUEUE_DRIVER_ID,
    run_id: state.run_id,
    attempt_ordinal: active.attempt_ordinal,
    approval_digest: state.approval_digest,
    intent_digest: documentDigest(intent),
    test_id: test.id,
    test_index: index,
    test_digest: documentDigest(test),
    timeout_ms: timeoutMs,
    claim_id: ownership.claim_id,
    owner: ownership.owner,
    identity_state: ownership.identity_state,
  };
}

function validatePrivateTestCaseClaim(value, state, active, intent, test, index, timeoutMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('test-evidence-conflict', `approved test ${test.id} claim is malformed`);
  }
  const expected = privateTestCaseClaim(state, active, intent, test, index, timeoutMs, {
    claim_id: value.claim_id,
    owner: value.owner,
    identity_state: value.identity_state,
  });
  assertSameEvidence(value, expected, 'test-evidence-conflict');
  observePrivateExecutionClaim(value);
  return value;
}

function assertSameEvidence(actual, expected, diagnostic) {
  if (documentDigest(actual) !== documentDigest(expected)) invalid(diagnostic, 'durable evidence identity differs');
}

function validatePrivateTestCaseResult(value, claim, test) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== 'approved-test-case-result'
      || value.claim_digest !== documentDigest(claim)
      || value.test_id !== test.id
      || value.test_index !== claim.test_index
      || value.test_digest !== documentDigest(test)
      || value.command_digest !== documentDigest(test.command)
      || !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0
      || !(value.actual_exit === null || (Number.isSafeInteger(value.actual_exit) && value.actual_exit >= 0))
      || typeof value.timed_out !== 'boolean'
      || ![null, 'unexpected-test-exit', 'test-launch-failure'].includes(value.diagnostic)
      || !['passed', 'failed'].includes(value.verdict)
      || value.evidence_digest !== documentDigest(withoutField(value, 'evidence_digest'))) {
    invalid('test-evidence-conflict', `approved test ${test.id} result identity is invalid`);
  }
  const passed = value.actual_exit === test.expected_exit
    && value.timed_out === false && value.diagnostic === null;
  if ((value.verdict === 'passed') !== passed) {
    invalid('test-evidence-conflict', `approved test ${test.id} verdict contradicts its result`);
  }
  return value;
}

function validateApprovedTestSettlement(value, state, approval, intent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== 'approved-test-settlement'
      || value.driver !== QUEUE_DRIVER_ID
      || value.schema_version !== DURABLE_EXECUTION_SCHEMA_VERSION
      || value.run_id !== state.run_id
      || value.attempt_ordinal !== state.tests.attempt_ordinal
      || value.approval_digest !== state.approval_digest
      || value.intent_digest !== documentDigest(intent)
      || !['passed', 'failed', 'stopped'].includes(value.verdict)
      || !Number.isSafeInteger(value.elapsed_ms) || value.elapsed_ms < 0
      || !Array.isArray(value.results)
      || value.settlement_digest !== documentDigest(withoutField(value, 'settlement_digest'))) {
    invalid('test-evidence-conflict', 'approved test settlement identity is invalid');
  }
  validateApprovedTestRecords(value, state, approval, { requirePassed: value.verdict === 'passed' });
  return value;
}

function validateApprovedTestRecords(value, state, approval, { requirePassed = false } = {}) {
  let elapsed = 0;
  for (let index = 0; index < value.results.length; index += 1) {
    const record = value.results[index];
    const test = approval.framing.tests[index];
    if (!test || !record || typeof record !== 'object' || Array.isArray(record)
        || record.test_id !== test.id
        || record.test_index !== index
        || record.test_digest !== documentDigest(test)
        || record.command_digest !== documentDigest(test.command)
        || !Number.isSafeInteger(record.duration_ms) || record.duration_ms < 0
        || !Number.isSafeInteger(record.timeout_ms) || record.timeout_ms < 1
        || record.timeout_ms > test.timeout_ms
        || !(record.actual_exit === null
          || (Number.isSafeInteger(record.actual_exit) && record.actual_exit >= 0))
        || typeof record.timed_out !== 'boolean'
        || ![null, 'unexpected-test-exit', 'test-launch-failure'].includes(record.diagnostic)
        || !/^sha256:[0-9a-f]{64}$/u.test(record.claim_digest)
        || !/^sha256:[0-9a-f]{64}$/u.test(record.output_digest)
        || record.evidence_digest !== documentDigest(withoutField(record, 'evidence_digest'))
        || !['passed', 'failed'].includes(record.verdict)) {
      invalid('test-evidence-conflict', 'approved test result set is malformed or out of order');
    }
    const passed = record.actual_exit === test.expected_exit
      && record.timed_out === false && record.diagnostic === null;
    if ((record.verdict === 'passed') !== passed) {
      invalid('test-evidence-conflict', `approved test ${test.id} verdict contradicts its result`);
    }
    elapsed += record.duration_ms;
  }
  if (elapsed !== value.elapsed_ms) invalid('test-evidence-conflict', 'approved test elapsed accounting differs');
  if (requirePassed && (value.results.length !== approval.framing.tests.length
      || value.results.some((record) => record.verdict !== 'passed'))) {
    invalid('test-evidence-conflict', 'passing test evidence does not cover the complete approved test set');
  }
  if (value.verdict === 'passed' && !requirePassed) {
    invalid('test-evidence-conflict', 'passing settlement must be validated as complete');
  }
  if (value.verdict === 'failed' && value.diagnostic === null
      && value.results.every((record) => record.verdict === 'passed')) {
    invalid('test-evidence-conflict', 'failed test evidence has no failure or diagnostic');
  }
}

function publicTestProjection(settlement) {
  const document = {
    schema_version: settlement.schema_version,
    kind: 'approved-test-result',
    driver: settlement.driver,
    run_id: settlement.run_id,
    attempt_ordinal: settlement.attempt_ordinal,
    approval_digest: settlement.approval_digest,
    intent_digest: settlement.intent_digest,
    settlement_digest: settlement.settlement_digest,
    verdict: settlement.verdict,
    diagnostic: settlement.diagnostic,
    elapsed_ms: settlement.elapsed_ms,
    results: settlement.results,
  };
  return { ...document, evidence_digest: documentDigest(document) };
}

function validateApprovedTestProjection(value, state, approval, intent, { requirePassed = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== 'approved-test-result'
      || value.driver !== QUEUE_DRIVER_ID
      || value.schema_version !== DURABLE_EXECUTION_SCHEMA_VERSION
      || value.run_id !== state.run_id
      || value.attempt_ordinal !== state.tests.attempt_ordinal
      || value.approval_digest !== state.approval_digest
      || value.intent_digest !== documentDigest(intent)
      || !/^sha256:[0-9a-f]{64}$/u.test(value.settlement_digest)
      || value.evidence_digest !== documentDigest(withoutField(value, 'evidence_digest'))
      || (requirePassed && value.verdict !== 'passed')) {
    invalid('test-evidence-conflict', 'approved public test projection identity is invalid');
  }
  validateApprovedTestRecords(value, state, approval, { requirePassed });
  return value;
}

function reserveTests(context, state, approval, dependencies) {
  const diagnostic = budgetDiagnostic(state, approval, 'tests', state.nodes[0].node_id);
  if (diagnostic) return park(context.runDir, state, diagnostic, dependencies);
  const refs = testRefs(state);
  return commitLifecycle(context.runDir, state, 'reserve-tests', 'testing', {
    stage: 'tests',
    attempt_ordinal: refs.ordinal,
    intent_ref: refs.intent,
    claim_ref: refs.claim,
    result_ref: refs.result,
    idempotency_key: `${pathToken(state.run_id)}/reserve-tests/${refs.ordinal}`,
  }, dependencies);
}

function runOneApprovedTest(repoRoot, test, timeoutMs, approval, dependencies) {
  const cwd = resolveWithinRoot(repoRoot, test.cwd);
  const containment = approval.routing.final_verifier.containment;
  const required = ['hard-stopped-actions-denied', 'network-denied', 'read-only'];
  if (required.some((capability) => !containment.enforces.includes(capability))
      || containment.gaps.length !== 0) {
    invalid(
      'test-command-not-contained',
      'approved tests require a bound read-only, network-denied, hard-stopped-action boundary',
    );
  }
  const runTest = dependencies.runContainedApprovedTest ?? runReadOnlyFileAssertion;
  return runTest({ repoRoot, cwd, test, timeoutMs, containment,
    allowedPaths: approval.framing.scope.allowed_paths });
}

async function executeApprovedTests(context, state, approval, dependencies) {
  const active = state.tests;
  if (!active || active.status !== 'reserved') invalid('run-state-invalid', 'testing stage has no reservation');
  const intent = approvedTestIntent(state, approval, active);
  const claim = approvedTestClaim(state, active, intent);
  persistImmutableJson(context.runDir, active.intent_ref, intent, 'approved test intent');
  persistImmutableJson(context.runDir, active.claim_ref, claim, 'approved test claim');

  const settlementRef = privateTestRefs(state, active, null, -1).settlement;
  const existingSettlement = readPrivateExecutionRecord(
    context.repoRoot, settlementRef, 'approved test settlement',
  );
  const resultPath = publicArtifactPath(context.runDir, active.result_ref);
  if (existsSync(resultPath) && existingSettlement === null) {
    invalid('public-evidence-conflict', 'approved test projection exists without an authoritative private settlement');
  }

  const records = [];
  let elapsed = 0;
  let terminal = existingSettlement === null ? null
    : validateApprovedTestSettlement(existingSettlement, state, approval, intent);
  for (let index = 0; terminal === null && index < approval.framing.tests.length; index += 1) {
    const test = approval.framing.tests[index];
    const testStageBudget = approval.budgets.stages.tests;
    const remaining = Math.min(
      test.timeout_ms,
      testStageBudget.max_elapsed_ms_per_attempt ?? testStageBudget.max_elapsed_ms,
      testStageBudget.max_elapsed_ms - state.budget_usage.stages.tests.elapsed_ms - elapsed,
      approval.budgets.total.max_elapsed_ms - state.budget_usage.total.elapsed_ms - elapsed,
    );
    if (remaining < 1) {
      terminal = makeApprovedTestSettlement(state, active, intent, records, 'failed', 'test-budget-exhausted');
      break;
    }
    const refs = privateTestRefs(state, active, test, index);
    const priorClaim = readPrivateExecutionRecord(context.repoRoot, refs.claim, 'approved test case claim');
    const priorResult = readPrivateExecutionRecord(context.repoRoot, refs.result, 'approved test case result');
    let caseClaim = priorClaim === null ? null
      : validatePrivateTestCaseClaim(priorClaim, state, active, intent, test, index, remaining);
    if (priorResult !== null) {
      if (priorClaim === null) invalid('test-evidence-conflict', `approved test ${test.id} result has no claim`);
      const validated = validatePrivateTestCaseResult(priorResult, caseClaim, test);
      records.push(validated);
      elapsed += validated.duration_ms;
      if (validated.verdict !== 'passed') {
        terminal = makeApprovedTestSettlement(state, active, intent, records, 'failed', 'approved-tests-failed');
      }
      continue;
    }
    if (priorClaim !== null) {
      const observation = observePrivateExecutionClaim(priorClaim);
      if (ACTIVE_TEST_CLAIMS.has(priorClaim.claim_id)
          || (priorClaim.owner.pid !== process.pid
            && observation.liveness === 'live' && observation.identity === 'verified')) {
        throw waitSignal();
      }
      terminal = makeApprovedTestSettlement(state, active, intent, records, 'failed', 'test-outcome-unknown');
      break;
    }
    if (stopPresent(context.runDir)) {
      terminal = makeApprovedTestSettlement(state, active, intent, records, 'stopped', 'stop-present');
      break;
    }
    caseClaim = privateTestCaseClaim(
      state, active, intent, test, index, remaining, createPrivateExecutionClaim('approved-test'),
    );
    const claimed = persistPrivateExecutionRecord(context.repoRoot, refs.claim, caseClaim, { observeConflict: true });
    if (!claimed) throw waitSignal();
    ACTIVE_TEST_CLAIMS.add(caseClaim.claim_id);
    let observed;
    try {
      observed = await runOneApprovedTest(context.repoRoot, test, remaining, approval, dependencies);
    } catch (error) {
      if (error?.code === 'SIMULATED_CRASH') throw error;
      const diagnostic = codeOf(error) === 'test-command-not-contained'
        ? 'test-command-not-contained' : 'approved-test-execution-error';
      terminal = makeApprovedTestSettlement(
        state, active, intent, records, 'failed', diagnostic,
      );
      break;
    } finally {
      ACTIVE_TEST_CLAIMS.delete(caseClaim.claim_id);
    }
    if (!Number.isSafeInteger(observed.duration_ms) || observed.duration_ms < 0) {
      invalid('test-duration-invalid', `test ${test.id} returned an invalid duration`);
    }
    elapsed += observed.duration_ms;
    const outputDigest = sha256Text(`${observed.stdout ?? ''}\0${observed.stderr ?? ''}`);
    const passed = observed.exit_code === test.expected_exit && observed.timed_out !== true && !observed.launch_error;
    const caseDocument = {
      schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
      kind: 'approved-test-case-result',
      driver: QUEUE_DRIVER_ID,
      run_id: state.run_id,
      attempt_ordinal: active.attempt_ordinal,
      approval_digest: state.approval_digest,
      intent_digest: documentDigest(intent),
      claim_digest: documentDigest(caseClaim),
      test_id: test.id,
      test_index: index,
      test_digest: documentDigest(test),
      verdict: passed ? 'passed' : 'failed',
      expected_exit: test.expected_exit,
      actual_exit: observed.exit_code,
      duration_ms: observed.duration_ms,
      timeout_ms: remaining,
      timed_out: observed.timed_out === true,
      diagnostic: observed.launch_error ? 'test-launch-failure' : (passed ? null : 'unexpected-test-exit'),
      command_digest: documentDigest(test.command),
      output_digest: outputDigest,
    };
    const withDigest = { ...caseDocument, evidence_digest: documentDigest(caseDocument) };
    persistPrivateExecutionRecord(context.repoRoot, refs.result, withDigest);
    records.push(withDigest);
    if (!passed) terminal = makeApprovedTestSettlement(
      state, active, intent, records, 'failed', 'approved-tests-failed',
    );
    else if (stopPresent(context.runDir)) terminal = makeApprovedTestSettlement(
      state, active, intent, records, 'stopped', 'stop-present',
    );
  }
  if (terminal === null) terminal = stopPresent(context.runDir)
    ? makeApprovedTestSettlement(state, active, intent, records, 'stopped', 'stop-present')
    : makeApprovedTestSettlement(state, active, intent, records, 'passed', null);
  persistPrivateExecutionRecord(context.repoRoot, settlementRef, terminal);
  const authoritative = validateApprovedTestSettlement(
    readPrivateExecutionRecord(context.repoRoot, settlementRef, 'approved test settlement'),
    state,
    approval,
    intent,
  );
  const projection = publicTestProjection(authoritative);
  validateApprovedTestProjection(projection, state, approval, intent, {
    requirePassed: projection.verdict === 'passed',
  });
  persistImmutableJson(context.runDir, active.result_ref, projection, 'approved test result');
  const nextStage = authoritative.verdict === 'passed' ? 'ready'
    : authoritative.verdict === 'stopped' ? 'stopped' : 'held';
  return commitLifecycle(context.runDir, state, 'settle-tests', nextStage, {
    stage: 'tests',
    elapsed_ms: authoritative.elapsed_ms,
    verdict: authoritative.verdict,
    result_ref: active.result_ref,
    evidence_digest: projection.evidence_digest,
    diagnostic: authoritative.diagnostic,
    idempotency_key: `${pathToken(state.run_id)}/settle-tests/${active.attempt_ordinal}`,
  }, dependencies);
}

function makeApprovedTestSettlement(state, active, intent, records, verdict, diagnostic) {
  const document = {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'approved-test-settlement',
    driver: QUEUE_DRIVER_ID,
    run_id: state.run_id,
    attempt_ordinal: active.attempt_ordinal,
    approval_digest: state.approval_digest,
    intent_digest: documentDigest(intent),
    verdict,
    diagnostic,
    elapsed_ms: records.reduce((total, record) => total + record.duration_ms, 0),
    results: records,
  };
  return { ...document, settlement_digest: documentDigest(document) };
}

function writeExitCheck(repoRoot, runDir, state, approval) {
  validateFinalEvidence(repoRoot, runDir, state, approval);
  const ref = 'exit-check.json';
  const document = {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'queue-exit-check',
    driver: QUEUE_DRIVER_ID,
    run_id: state.run_id,
    verdict: 'passed',
    approval_digest: state.approval_digest,
    final_verification_ref: state.final_verification.verdict_ref,
    final_verification_digest: state.final_verification.evidence_digest,
    verified_state_digest: state.final_verification.verified_state_digest,
    node_evidence: state.nodes.map((node) => ({
      node_id: node.node_id,
      evidence_ref: node.evidence_ref,
      evidence_digest: node.evidence_digest,
      review_ref: node.review.verdict_ref,
      review_digest: node.review.evidence_digest,
    })),
  };
  const digest = documentDigest(document);
  persistImmutableJson(runDir, ref, { ...document, evidence_digest: digest }, 'exit check');
  return { ref, digest };
}

function reportDocument(state, approval) {
  return {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'queue-lifecycle-report',
    driver: QUEUE_DRIVER_ID,
    run_id: state.run_id,
    outcome: 'verified',
    approval_digest: state.approval_digest,
    source_digest: state.source_digest,
    effective_bindings: Object.fromEntries(Object.entries(approval.routing).map(([seat, binding]) => [
      seat,
      bindingProjection(binding),
    ])),
    nodes: state.nodes.map((node) => ({
      node_id: node.node_id,
      evidence_ref: node.evidence_ref,
      evidence_digest: node.evidence_digest,
      review_ref: node.review.verdict_ref,
      review_digest: node.review.evidence_digest,
      implementation_attempts: node.implementation_attempts,
      repair_attempts: node.repair_attempts,
      review_attempts: node.review_attempts,
      terminal_budget_charged: node.terminal_budget_charged,
    })),
    final_verification: state.final_verification,
    tests: state.tests,
    exit_check: state.exit_check,
    budget_usage: state.budget_usage,
    public_attempt_results: Object.entries(state.attempts).map(([attemptId, attempt]) => ({
      attempt_id: attemptId,
      role: attempt.role,
      stage: attempt.stage,
      receipt_id: attempt.receipt_id,
      public_result_ref: attempt.public_result_ref,
      public_result_digest: attempt.public_result_digest,
      public_evidence_digest: attempt.public_evidence_digest,
      binding_digest: attempt.binding_digest,
    })),
    transition_receipt_ids: Object.values(state.transition_receipts).map((entry) => entry.receipt_id).sort(),
  };
}

function reportMarkdown(report) {
  const lines = [
    '# Durable queue lifecycle report',
    '',
    `Outcome: **${report.outcome}**`,
    `Driver: \`${report.driver}\``,
    `Run: \`${report.run_id}\``,
    `Approval: \`${report.approval_digest}\``,
    '',
    '## Public evidence',
    '',
    ...report.nodes.map((node) => `- \`${node.node_id}\`: \`${node.evidence_ref}\` (${node.evidence_digest}); review \`${node.review_ref}\` (${node.review_digest})`),
    `- Final verification: \`${report.final_verification.verdict_ref}\` (${report.final_verification.evidence_digest})`,
    `- Exit check: \`${report.exit_check.ref}\` (${report.exit_check.evidence_digest})`,
    '',
    '## Effective bindings',
    '',
    ...Object.entries(report.effective_bindings).map(([seat, binding]) => `- ${seat}: ${binding.executor} / ${binding.model_ref} / ${binding.invoke_id} / effort ${binding.effort ?? 'null'} / ${binding.binding_digest}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReport(repoRoot, runDir, state, approval) {
  validateFinalEvidence(repoRoot, runDir, state, approval);
  const exit = readPublicJson(runDir, state.exit_check?.ref, 'exit check');
  if (exit.verdict !== 'passed'
      || exit.evidence_digest !== state.exit_check?.evidence_digest
      || documentDigest(withoutField(exit, 'evidence_digest')) !== state.exit_check?.evidence_digest) {
    invalid('terminal-evidence-stale', 'exit-check evidence is stale or malformed');
  }
  const report = reportDocument(state, approval);
  const digest = documentDigest(report);
  const complete = { ...report, content_digest: digest };
  persistImmutableJson(runDir, 'report.json', complete, 'durable report');
  const markdown = reportMarkdown(complete);
  const markdownPath = publicArtifactPath(runDir, 'report.md');
  if (existsSync(markdownPath) && readFileSync(markdownPath, 'utf8') !== markdown) {
    invalid('public-evidence-conflict', 'durable Markdown report already differs');
  }
  if (!existsSync(markdownPath)) writeAtomic(markdownPath, markdown);
  return { digest, ref: 'report.json', markdownRef: 'report.md' };
}

async function advance(context, state, approval, executorSpecs, dependencies) {
  // A recovery park freezes progression, not receipt settlement. A worker may publish its
  // terminal receipt after the supervisor conservatively parked an ambiguous launch window.
  if (TERMINAL_STAGES.has(state.stage)
      && !(state.stage === 'held' && state.active_attempt !== null)) return state;
  if (stopPresent(context.runDir) && state.active_attempt === null && state.stage !== 'testing') {
    return commitLifecycle(context.runDir, state, 'stop', 'stopped', {
      idempotency_key: `${pathToken(state.run_id)}/stop/${state.revision}`,
    }, dependencies);
  }
  if (state.active_attempt !== null) {
    return executeActiveAttempt(context, state, approval, executorSpecs, dependencies);
  }
  if (state.stage === 'ready') {
    const repair = repairNode(state);
    if (repair) {
      return reserveAttempt(context.runDir, state, approval, 'repair', repair.node_id,
        executorSpecs, dependencies);
    }
    const awaitingReview = reviewNode(state);
    if (awaitingReview) {
      return reserveAttempt(context.runDir, state, approval, 'review', awaitingReview.node_id,
        executorSpecs, dependencies);
    }
    if (state.nodes.every((node) => node.status === 'complete')) {
      if (state.tests?.verdict !== 'passed') return reserveTests(context, state, approval, dependencies);
      const verifierNode = [...state.nodes].sort((a, b) => b.source_ordinal - a.source_ordinal)[0];
      return reserveAttempt(context.runDir, state, approval, 'final_verification', verifierNode.node_id,
        executorSpecs, dependencies);
    }
    const node = eligibleNode(state);
    if (!node) return park(context.runDir, state, 'dependency-held', dependencies);
    return reserveAttempt(context.runDir, state, approval, 'implementation', node.node_id,
      executorSpecs, dependencies);
  }
  if (state.stage === 'reviewing') {
    const node = reviewNode(state);
    if (!node) return park(context.runDir, state, 'review-required', dependencies);
    return reserveAttempt(context.runDir, state, approval, 'review', node.node_id,
      executorSpecs, dependencies);
  }
  if (state.stage === 'repair_ready') {
    const node = repairNode(state);
    if (!node) return park(context.runDir, state, 'repair-target-missing', dependencies);
    return reserveAttempt(context.runDir, state, approval, 'repair', node.node_id,
      executorSpecs, dependencies);
  }
  if (state.stage === 'testing') {
    return executeApprovedTests(context, state, approval, dependencies);
  }
  if (state.stage === 'exit_checking') {
    const exit = writeExitCheck(context.repoRoot, context.runDir, state, approval);
    return commitLifecycle(context.runDir, state, 'record-exit', 'reporting', {
      exit_check_ref: exit.ref,
      evidence_digest: exit.digest,
      idempotency_key: `${pathToken(state.run_id)}/exit-check/${exit.digest.slice(-24)}`,
    }, dependencies);
  }
  if (state.stage === 'reporting') {
    const report = writeReport(context.repoRoot, context.runDir, state, approval);
    return commitLifecycle(context.runDir, state, 'record-report', 'done', {
      report_ref: report.ref,
      markdown_ref: report.markdownRef,
      content_digest: report.digest,
      idempotency_key: `${pathToken(state.run_id)}/report/${report.digest.slice(-24)}`,
    }, dependencies);
  }
  return park(context.runDir, state, 'lifecycle-stage-invalid', dependencies);
}

/**
 * Execute the selected driver's bounded native lifecycle until a verified terminal state or park.
 * A later invocation resumes from durable state and receipts; no continuation text is required.
 */
export async function runQueueLifecycle({
  repoRoot,
  runDir,
  approval: approvalValue,
  executorSpecs,
  dependencies = {},
  maxDecisions = 1000,
}) {
  const approval = normalizeApprovalEnvelope(approvalValue);
  if (approval.supervision.mode === 'continuous') {
    invalid('supervisor-required', 'continuous approvals may mutate only through the leased supervisor');
  }
  const context = ensureRunLocation(repoRoot, runDir, approval);
  let state = readFencedRun(context.runDir);
  if (state.approval_digest !== approvalEnvelopeDigest(approval)) {
    invalid('approval-digest-mismatch', 'durable state does not match the supplied approval envelope');
  }
  let waiting = false;
  for (let decision = 0; decision < maxDecisions && !TERMINAL_STAGES.has(state.stage); decision += 1) {
    try {
      state = await advance(context, state, approval, executorSpecs, dependencies);
    } catch (error) {
      if (error?.code === 'SIMULATED_CRASH') throw error;
      if (error?.code === 'LIFECYCLE_WAIT') {
        waiting = true;
        break;
      }
      state = readFencedRun(context.runDir);
      if (state.stage === 'held') break;
      state = park(context.runDir, state, codeOf(error), dependencies);
    }
  }
  if (!waiting && !TERMINAL_STAGES.has(state.stage)) {
    state = park(context.runDir, state, 'lifecycle-decision-bound-exhausted', dependencies);
  }
  return {
    status: waiting ? 'waiting'
      : state.stage === 'done' ? 'terminal' : state.stage === 'stopped' ? 'stopped' : 'parked',
    state,
    report_ref: state.report?.ref ?? null,
  };
}

/**
 * Execute exactly one native lifecycle decision. Waiting is an observable result, never a park and
 * never a budget charge. Continuous supervision owns repetition and backoff above this boundary.
 */
export async function runQueueDecision({
  repoRoot,
  runDir,
  approval: approvalValue,
  executorSpecs,
  supervisorLeaseCapability,
  dependencies = {},
}) {
  const approval = normalizeApprovalEnvelope(approvalValue);
  const context = ensureRunLocation(repoRoot, runDir, approval);
  requireActiveSupervisorLease(context, approval, supervisorLeaseCapability);
  let state = readFencedRun(context.runDir);
  if (state.approval_digest !== approvalEnvelopeDigest(approval)) {
    invalid('approval-digest-mismatch', 'durable state does not match the supplied approval envelope');
  }
  if (TERMINAL_STAGES.has(state.stage)
      && !(state.stage === 'held' && state.active_attempt !== null)) {
    return {
      status: state.stage === 'done' ? 'terminal' : state.stage === 'stopped' ? 'stopped' : 'parked',
      state,
      report_ref: state.report?.ref ?? null,
    };
  }
  try {
    state = await advance(context, state, approval, executorSpecs, {
      ...dependencies,
      nonBlocking: true,
    });
  } catch (error) {
    if (error?.code === 'SIMULATED_CRASH') throw error;
    if (error?.code === 'LIFECYCLE_WAIT') {
      state = readFencedRun(context.runDir);
      return { status: 'waiting', state, report_ref: state.report?.ref ?? null };
    }
    state = readFencedRun(context.runDir);
    if (state.stage !== 'held') state = park(context.runDir, state, codeOf(error), dependencies);
  }
  return {
    status: state.stage === 'done' ? 'terminal'
      : state.stage === 'stopped' ? 'stopped'
        : state.stage === 'held' ? 'parked' : 'advanced',
    state,
    report_ref: state.report?.ref ?? null,
  };
}

/** Park one recovery ambiguity through the same fenced transition protocol as the native driver. */
export function parkQueueRecovery(runDir, diagnostic, dependencies = {}) {
  const state = readFencedRun(runDir);
  return park(runDir, state, diagnostic, dependencies);
}

/** STOP a positively proven never-launched active attempt without charging an attempt budget. */
export function stopNeverLaunchedAttempt(runDir, dependencies = {}) {
  const state = readFencedRun(runDir);
  if (state.active_attempt === null) return state;
  return commitLifecycle(runDir, state, 'stop-unlaunched', 'stopped', {
    attempt_id: state.active_attempt.attempt_id,
    idempotency_key: `${pathToken(state.run_id)}/stop-unlaunched/${state.active_attempt.attempt_id}`,
  }, dependencies);
}
