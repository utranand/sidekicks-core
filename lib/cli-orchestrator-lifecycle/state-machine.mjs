// Pure Phase 2 reducer for queue-supervisor/v1 mutations.
//
// This module deliberately does not launch workers, reserve attempts, choose routes, or supervise.
// Every caller must enter through commands.mjs so the shared fenced transaction store owns revision,
// approval, idempotency, receipt, and lock checks.

import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { canonicalJson } from '../run-events/schema.mjs';

export const QUEUE_MUTATION_KINDS = Object.freeze([
  'run',
  'resume',
  'reconcile',
  'manual-transition',
  'finish-attempt',
  'outcome',
  'verdict',
  'counter',
  'lifecycle',
]);

const COUNTERS = Object.freeze(['attempts', 'failures', 'tokens', 'elapsed_ms', 'cost_micros']);

function invalid(message) {
  throw new SidekicksError(`[queue-mutation-invalid] ${message}`, EXIT_VALIDATION);
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    invalid(`${name} must be a non-empty single-line string`);
  }
  return value;
}

function assertStage(state, input) {
  const from = requireText(input.from, 'from');
  if (state.stage !== from) invalid(`expected stage ${from}, current ${String(state.stage)}`);
  return requireText(input.to, 'to');
}

function requireDigest(value, name) {
  const out = requireText(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(out)) invalid(`${name} must be sha256`);
  return out;
}

function requireSafeInteger(value, name, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) invalid(`${name} must be a safe integer >= ${min}`);
  return value;
}

function lifecycleHistory(next, input, details = {}) {
  next.lifecycle_history = [...(next.lifecycle_history || []), {
    operation: input.operation,
    stage_from: input.from,
    stage_to: input.to,
    ...details,
  }];
}

function nodeById(next, nodeId) {
  const index = next.nodes?.findIndex((node) => node.node_id === nodeId) ?? -1;
  if (index < 0) invalid(`unknown lifecycle node ${String(nodeId)}`);
  return { index, node: next.nodes[index] };
}

const LIFECYCLE_STAGE_ROLE = Object.freeze({
  implementation: 'implementer',
  repair: 'implementer',
  review: 'reviewer',
  final_verification: 'final-verifier',
});

function assertLifecycleRoute(input, allowedFrom, expectedTo) {
  if (!allowedFrom.includes(input.from) || input.to !== expectedTo) {
    invalid(`${input.operation} cannot transition ${input.from} -> ${input.to}`);
  }
}

function chargeAttempt(next, input) {
  const stage = requireText(input.stage, 'stage');
  const elapsedMs = requireSafeInteger(input.elapsed_ms, 'elapsed_ms');
  const limits = next.budget_limits;
  const usage = next.budget_usage;
  if (!limits?.stages?.[stage] || !usage?.stages?.[stage]) invalid(`unknown budget stage ${stage}`);
  const stageUsage = usage.stages[stage];
  if (stageUsage.calls >= limits.stages[stage].max_calls) invalid(`stage budget already exhausted for ${stage}`);
  if (usage.total.calls >= limits.total.max_calls) invalid('total call budget already exhausted');
  stageUsage.calls += 1;
  stageUsage.elapsed_ms += elapsedMs;
  usage.total.calls += 1;
  usage.total.elapsed_ms += elapsedMs;
  return {
    stage_exhausted: stageUsage.elapsed_ms > limits.stages[stage].max_elapsed_ms,
    total_exhausted: usage.total.elapsed_ms > limits.total.max_elapsed_ms,
  };
}

function applyLifecycleMutation(next, input, to) {
  const operation = requireText(input.operation, 'operation');
  if (operation === 'reserve-attempt') {
    if (next.active_attempt != null) invalid('cannot reserve while another attempt is active');
    const stage = requireText(input.stage, 'stage');
    const role = requireText(input.role, 'role');
    const expectedRole = LIFECYCLE_STAGE_ROLE[stage];
    if (!expectedRole || role !== expectedRole) invalid(`invalid lifecycle role ${role} for ${stage}`);
    const routes = {
      implementation: { from: ['ready'], to: 'implementing', status: 'pending' },
      repair: { from: ['ready', 'repair_ready'], to: 'repair_ready', status: 'needs-repair' },
      review: { from: ['ready', 'reviewing'], to: 'reviewing', status: 'awaiting-review' },
      final_verification: { from: ['ready'], to: 'verifying', status: null },
    };
    const route = routes[stage];
    assertLifecycleRoute(input, route.from, route.to);
    const selected = nodeById(next, requireText(input.node_id, 'node_id')).node;
    if (route.status !== null && selected.status !== route.status) {
      invalid(`${stage} requires node status ${route.status}`);
    }
    if (stage === 'implementation'
        && !selected.dependencies.every((dependency) => nodeById(next, dependency).node.status === 'complete')) {
      invalid('implementation dependencies are not complete');
    }
    if (stage === 'final_verification'
        && (next.nodes.some((node) => node.status !== 'complete') || next.tests?.verdict !== 'passed')) {
      invalid('final verification requires complete nodes and passing tests');
    }
    next.active_attempt = {
      attempt_id: requireText(input.attempt_id, 'attempt_id'),
      node_id: selected.node_id,
      role,
      stage,
      attempt_ordinal: requireSafeInteger(input.attempt_ordinal, 'attempt_ordinal', { min: 1 }),
      binding_digest: requireDigest(input.binding_digest, 'binding_digest'),
      rendered_prompt_digest: requireDigest(input.rendered_prompt_digest, 'rendered_prompt_digest'),
    };
    next.stage = to;
    lifecycleHistory(next, input, { attempt_id: next.active_attempt.attempt_id });
    return { operation, attempt_id: next.active_attempt.attempt_id };
  }

  if (operation === 'settle-attempt') {
    const attemptId = requireText(input.attempt_id, 'attempt_id');
    if (next.active_attempt?.attempt_id !== attemptId) invalid(`active attempt is not ${attemptId}`);
    const budget = chargeAttempt(next, input);
    const record = {
      node_id: next.active_attempt.node_id,
      role: next.active_attempt.role,
      stage: next.active_attempt.stage,
      attempt_ordinal: next.active_attempt.attempt_ordinal,
      receipt_id: requireText(input.receipt_id, 'receipt_id'),
      terminal_receipt_digest: requireDigest(input.terminal_receipt_digest, 'terminal_receipt_digest'),
      public_result_ref: requireText(input.public_result_ref, 'public_result_ref'),
      public_result_digest: requireDigest(input.public_result_digest, 'public_result_digest'),
      public_evidence_digest: requireDigest(input.public_evidence_digest, 'public_evidence_digest'),
      binding_digest: next.active_attempt.binding_digest,
      rendered_prompt_digest: next.active_attempt.rendered_prompt_digest,
      classification: requireText(input.classification, 'classification'),
    };
    next.attempts = { ...(next.attempts || {}), [attemptId]: record };
    const disposition = requireText(input.disposition, 'disposition');
    if (input.stage !== next.active_attempt.stage || input.role !== next.active_attempt.role) {
      invalid('settlement stage or role does not match the active attempt');
    }
    const settlementRoutes = {
      implementation: { dispositions: ['implementation-complete', 'parked'], successTo: 'reviewing' },
      repair: { dispositions: ['repair-complete', 'parked'], successTo: 'reviewing' },
      review: { dispositions: ['review-approved', 'review-rejected', 'parked'], successTo: null },
      final_verification: { dispositions: ['final-approved', 'final-reopened', 'parked'], successTo: null },
    };
    const settlementRoute = settlementRoutes[next.active_attempt.stage];
    if (!settlementRoute?.dispositions.includes(disposition)) {
      invalid(`${disposition} cannot settle ${next.active_attempt.stage}`);
    }
    const expectedTo = disposition === 'parked' ? 'held'
      : settlementRoute.successTo
        ?? ({ 'review-approved': 'ready', 'review-rejected': 'repair_ready',
          'final-approved': 'exit_checking', 'final-reopened': 'repair_ready' })[disposition];
    if (input.to !== expectedTo) invalid(`${disposition} must transition to ${expectedTo}`);
    const nodeId = next.active_attempt.node_id;
    const settledStage = next.active_attempt.stage;
    if (['implementation', 'repair', 'review'].includes(settledStage)) {
      const { index, node } = nodeById(next, nodeId);
      next.nodes[index] = {
        ...node,
        implementation_attempts: node.implementation_attempts + (settledStage === 'implementation' ? 1 : 0),
        repair_attempts: node.repair_attempts + (settledStage === 'repair' ? 1 : 0),
        review_attempts: node.review_attempts + (settledStage === 'review' ? 1 : 0),
      };
    }
    next.active_attempt = null;

    if (['implementation-complete', 'repair-complete'].includes(disposition)) {
      const { index, node } = nodeById(next, nodeId);
      const evidenceDigest = requireDigest(input.evidence_digest, 'evidence_digest');
      const evidenceRef = requireText(input.evidence_ref, 'evidence_ref');
      const updated = {
        ...node,
        status: 'awaiting-review',
        evidence_digest: evidenceDigest,
        evidence_ref: evidenceRef,
        review: null,
      };
      if (disposition === 'repair-complete') {
        updated.repair_authorization = null;
        next.final_verification = null;
        next.tests = null;
      }
      next.nodes[index] = updated;
    } else if (['review-approved', 'review-rejected'].includes(disposition)) {
      const { index, node } = nodeById(next, nodeId);
      const verdict = disposition === 'review-approved' ? 'approved' : 'rejected';
      const verdictRef = requireText(input.verdict_ref, 'verdict_ref');
      const evidenceDigest = requireDigest(input.evidence_digest, 'evidence_digest');
      next.nodes[index] = {
        ...node,
        status: verdict === 'approved' ? 'complete' : 'needs-repair',
        terminal_budget_charged: verdict === 'approved'
          ? true
          : node.terminal_budget_charged === true,
        repair_authorization: verdict === 'rejected' ? {
          source: 'independent-review',
          verdict_ref: verdictRef,
          evidence_digest: evidenceDigest,
        } : node.repair_authorization,
        review: {
          verdict,
          verdict_ref: verdictRef,
          evidence_digest: evidenceDigest,
          reviewed_evidence_digest: requireDigest(input.reviewed_evidence_digest, 'reviewed_evidence_digest'),
        },
      };
      // The legacy item budget counts each queue item once when it first reaches a consuming
      // terminal outcome. A later final-verifier reopen invalidates freshness but does not turn the
      // same source item into a second budget item.
      if (verdict === 'approved' && node.terminal_budget_charged !== true) {
        next.queue_counters.terminal_items += 1;
        next.queue_counters.consecutive_item_failures = 0;
        if (next.queue_counters.terminal_items > next.budget_limits.item_budget.max_terminal_items) {
          budget.item_exhausted = true;
        }
      }
    } else if (['final-approved', 'final-reopened'].includes(disposition)) {
      const verdict = disposition === 'final-approved' ? 'approved' : 'reopened';
      const reopened = Array.isArray(input.reopen_node_ids) ? input.reopen_node_ids : [];
      if (verdict === 'reopened' && reopened.length === 0) invalid('reopened final verdict needs at least one node');
      const verdictRef = requireText(input.verdict_ref, 'verdict_ref');
      const evidenceDigest = requireDigest(input.evidence_digest, 'evidence_digest');
      const reopenedSet = new Set(reopened);
      const invalidated = new Set(reopened);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of next.nodes) {
          if (!invalidated.has(candidate.node_id)
              && candidate.dependencies.some((dependency) => invalidated.has(dependency))) {
            invalidated.add(candidate.node_id);
            changed = true;
          }
        }
      }
      for (const reopenId of reopened) {
        const { index, node } = nodeById(next, reopenId);
        next.nodes[index] = {
          ...node,
          status: 'needs-repair',
          review: null,
          repair_authorization: {
            source: 'final-verification',
            verdict_ref: verdictRef,
            evidence_digest: evidenceDigest,
          },
        };
      }
      for (const invalidatedId of invalidated) {
        if (reopenedSet.has(invalidatedId)) continue;
        const { index, node } = nodeById(next, invalidatedId);
        next.nodes[index] = { ...node, status: 'awaiting-review', review: null };
      }
      next.final_verification = {
        verdict,
        verdict_ref: verdictRef,
        evidence_digest: evidenceDigest,
        verified_state_digest: requireDigest(input.verified_state_digest, 'verified_state_digest'),
        reopen_node_ids: [...reopened],
      };
    } else if (disposition === 'parked') {
      next.outcome = 'parked';
      next.parked = { diagnostic: requireText(input.diagnostic, 'diagnostic'), attempt_id: attemptId };
    } else {
      invalid(`unsupported lifecycle settlement disposition ${disposition}`);
    }

    if (disposition !== 'parked') {
      // Successful late settlement retires a recovery hold. Budget checks below may establish a
      // new authoritative hold for the now-settled result.
      next.outcome = 'active';
      next.parked = null;
    }
    if (budget.stage_exhausted || budget.total_exhausted || budget.item_exhausted) {
      next.stage = 'held';
      next.outcome = 'parked';
      next.parked = {
        diagnostic: budget.item_exhausted ? 'item-budget-exhausted'
          : budget.total_exhausted ? 'total-budget-exhausted' : 'role-budget-exhausted',
        attempt_id: attemptId,
      };
    } else {
      next.stage = to;
    }
    lifecycleHistory(next, input, { attempt_id: attemptId, disposition });
    return { operation, attempt_id: attemptId, disposition };
  }

  if (operation === 'reserve-tests') {
    assertLifecycleRoute(input, ['ready'], 'testing');
    if (next.active_attempt != null || next.tests?.status === 'reserved') {
      invalid('cannot reserve tests while work is active');
    }
    next.tests = {
      status: 'reserved',
      attempt_ordinal: requireSafeInteger(input.attempt_ordinal, 'attempt_ordinal', { min: 1 }),
      intent_ref: requireText(input.intent_ref, 'intent_ref'),
      claim_ref: requireText(input.claim_ref, 'claim_ref'),
      result_ref: requireText(input.result_ref, 'result_ref'),
    };
    next.stage = to;
    lifecycleHistory(next, input, { attempt_ordinal: next.tests.attempt_ordinal });
    return { operation, attempt_ordinal: next.tests.attempt_ordinal };
  }

  if (operation === 'settle-tests') {
    if (input.from !== 'testing' || !['ready', 'held', 'stopped'].includes(input.to)) {
      invalid(`settle-tests cannot transition ${input.from} -> ${input.to}`);
    }
    if (next.tests?.status !== 'reserved') invalid('no approved test reservation is active');
    const budget = chargeAttempt(next, input);
    const verdict = input.verdict === 'passed' ? 'passed'
      : input.verdict === 'failed' ? 'failed'
        : input.verdict === 'stopped' ? 'stopped'
          : invalid('test verdict must be passed, failed, or stopped');
    if ((verdict === 'passed' && input.to !== 'ready')
        || (verdict === 'failed' && input.to !== 'held')
        || (verdict === 'stopped' && input.to !== 'stopped')) {
      invalid(`test verdict ${verdict} cannot transition to ${input.to}`);
    }
    next.tests = {
      ...next.tests,
      status: 'settled',
      verdict,
      result_ref: requireText(input.result_ref, 'result_ref'),
      evidence_digest: requireDigest(input.evidence_digest, 'evidence_digest'),
      elapsed_ms: requireSafeInteger(input.elapsed_ms, 'elapsed_ms'),
    };
    if (verdict === 'stopped') {
      next.stage = 'stopped';
      next.outcome = 'stopped';
      next.parked = null;
    } else if (verdict !== 'passed' || budget.stage_exhausted || budget.total_exhausted) {
      next.stage = 'held';
      next.outcome = 'parked';
      next.parked = {
        diagnostic: budget.total_exhausted ? 'total-budget-exhausted'
          : budget.stage_exhausted ? 'role-budget-exhausted'
            : requireText(input.diagnostic, 'diagnostic'),
      };
    } else {
      next.stage = to;
    }
    lifecycleHistory(next, input, { verdict, evidence_digest: next.tests.evidence_digest });
    return { operation, verdict };
  }

  if (operation === 'park') {
    if (to !== 'held') invalid('park must transition to held');
    next.stage = to;
    next.outcome = 'parked';
    next.parked = { diagnostic: requireText(input.diagnostic, 'diagnostic') };
    lifecycleHistory(next, input, { diagnostic: next.parked.diagnostic });
    return { operation, diagnostic: next.parked.diagnostic };
  }

  if (operation === 'stop') {
    assertLifecycleRoute(input, ['ready', 'reviewing', 'repair_ready', 'testing', 'exit_checking', 'reporting'], 'stopped');
    if (next.active_attempt != null) invalid('cannot stop before settling the active attempt');
    next.stage = to;
    next.outcome = 'stopped';
    lifecycleHistory(next, input, { diagnostic: 'stop-present' });
    return { operation };
  }

  if (operation === 'stop-unlaunched') {
    if (to !== 'stopped' || next.active_attempt === null
        || input.attempt_id !== next.active_attempt.attempt_id) {
      invalid('stop-unlaunched requires the current active attempt and stopped target');
    }
    const attemptId = next.active_attempt.attempt_id;
    next.active_attempt = null;
    next.stage = 'stopped';
    next.outcome = 'stopped';
    next.parked = null;
    lifecycleHistory(next, input, { diagnostic: 'stop-present', attempt_id: attemptId });
    return { operation, attempt_id: attemptId };
  }

  if (operation === 'record-exit') {
    assertLifecycleRoute(input, ['exit_checking'], 'reporting');
    if (next.active_attempt != null) invalid('cannot run exit check with an active attempt');
    if (next.final_verification?.verdict !== 'approved') invalid('exit check requires an approved final verification');
    if (next.nodes.some((node) => node.status !== 'complete')) invalid('exit check requires every node complete');
    next.exit_check = {
      verdict: 'passed',
      ref: requireText(input.exit_check_ref, 'exit_check_ref'),
      evidence_digest: requireDigest(input.evidence_digest, 'evidence_digest'),
    };
    next.stage = to;
    lifecycleHistory(next, input, { evidence_digest: next.exit_check.evidence_digest });
    return { operation };
  }

  if (operation === 'record-report') {
    assertLifecycleRoute(input, ['reporting'], 'done');
    if (next.exit_check?.verdict !== 'passed') invalid('durable report requires a passing exit check');
    if (next.final_verification?.verdict !== 'approved') invalid('durable report requires approved final verification');
    if (next.nodes.some((node) => node.status !== 'complete')) invalid('durable report requires every node complete');
    next.report = {
      ref: requireText(input.report_ref, 'report_ref'),
      markdown_ref: requireText(input.markdown_ref, 'markdown_ref'),
      content_digest: requireDigest(input.content_digest, 'content_digest'),
    };
    next.stage = to;
    next.outcome = 'verified';
    lifecycleHistory(next, input, { content_digest: next.report.content_digest });
    return { operation };
  }

  invalid(`unsupported lifecycle operation ${operation}`);
}

export function applyQueueMutation(state, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('input must be an object');
  if (!QUEUE_MUTATION_KINDS.includes(input.kind)) invalid(`unsupported kind ${String(input.kind)}`);
  const next = structuredClone(state);
  const to = assertStage(next, input);

  switch (input.kind) {
    case 'run':
    case 'resume':
    case 'reconcile':
    case 'manual-transition':
      next.stage = to;
      next.last_transition = {
        kind: input.kind,
        reason: requireText(input.reason, 'reason'),
      };
      break;

    case 'finish-attempt': {
      const attemptId = requireText(input.attempt_id, 'attempt_id');
      const evidenceDigest = requireText(input.evidence_digest, 'evidence_digest');
      if (!/^sha256:[0-9a-f]{64}$/.test(evidenceDigest)) invalid('evidence_digest must be sha256');
      next.settlements = { ...(next.settlements || {}) };
      const charges = {};
      for (const counter of COUNTERS) {
        const charge = Number(input.charges?.[counter] ?? 0);
        if (!Number.isSafeInteger(charge) || charge < 0) invalid(`charges.${counter} must be a safe non-negative integer`);
        charges[counter] = charge;
      }
      const terminal = {
        outcome: requireText(input.outcome, 'outcome'),
        evidence_digest: evidenceDigest,
        charges,
      };
      const hasExisting = Object.hasOwn(next.settlements, attemptId);
      const existing = hasExisting ? next.settlements[attemptId] : null;
      if (hasExisting) {
        if (canonicalJson(existing) === canonicalJson(terminal)) {
          return {
            state: next,
            settlement: { kind: input.kind, state_from: input.from, state_to: state.stage,
              subject: attemptId, replayed: true },
          };
        }
        next.stage = 'held';
        next.mutation_halted = true;
        next.settlement_conflicts = [...(next.settlement_conflicts || []), {
          attempt_id: attemptId,
          original_evidence_digest: existing.evidence_digest,
          conflicting_evidence_digest: evidenceDigest,
        }];
        return {
          state: next,
          settlement: { kind: input.kind, state_from: input.from, state_to: 'held',
            subject: attemptId, conflict: true },
        };
      }
      next.settlements = { ...next.settlements, [attemptId]: terminal };
      next.counters = { ...(next.counters || {}) };
      for (const counter of COUNTERS) {
        next.counters[counter] = Number(next.counters[counter] ?? 0) + charges[counter];
      }
      next.stage = to;
      break;
    }

    case 'outcome': {
      const id = requireText(input.outcome_id, 'outcome_id');
      next.outcomes = { ...(next.outcomes || {}), [id]: requireText(input.evidence_digest, 'evidence_digest') };
      next.stage = to;
      break;
    }

    case 'verdict': {
      const id = requireText(input.verdict_id, 'verdict_id');
      next.verdicts = { ...(next.verdicts || {}), [id]: requireText(input.evidence_digest, 'evidence_digest') };
      next.stage = to;
      break;
    }

    case 'counter': {
      const counter = requireText(input.counter, 'counter');
      if (!COUNTERS.includes(counter)) invalid(`unsupported counter ${counter}`);
      const delta = Number(input.delta);
      if (!Number.isSafeInteger(delta) || delta < 0) invalid('delta must be a safe non-negative integer');
      next.counters = { ...(next.counters || {}) };
      next.counters[counter] = Number(next.counters[counter] ?? 0) + delta;
      next.stage = to;
      break;
    }

    case 'lifecycle': {
      const settlement = applyLifecycleMutation(next, input, to);
      return {
        state: next,
        settlement: {
          kind: input.kind,
          state_from: input.from,
          state_to: next.stage,
          subject: input.attempt_id || input.operation,
          ...settlement,
        },
      };
    }

    default:
      invalid(`unsupported kind ${String(input.kind)}`);
  }

  return {
    state: next,
    settlement: {
      kind: input.kind,
      state_from: input.from,
      state_to: to,
      subject: input.attempt_id || input.outcome_id || input.verdict_id || input.counter || null,
    },
  };
}
