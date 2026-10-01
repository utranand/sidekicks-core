// Leased recovery supervisor for the selected queue-supervisor/v1 driver.
//
// Recovery policy is intentionally pure and declared before any filesystem, lease, polling, or
// CLI code. Process observations are evidence; they are never authority to kill or redispatch by
// PID alone. The imperative supervisor below this boundary may only execute one of these closed
// decisions.

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

import { writeAtomic } from '../fs-safety/fsx.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { acquireLock, bangkokTimestamp, releaseLock } from '../run-events/store.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import {
  approvalEnvelopeDigest,
  normalizeApprovalEnvelope,
} from '../durable-execution/schema.mjs';
import {
  readFencedRun, runStorePaths, stopPresent, writeStop,
} from '../durable-execution/store.mjs';
import {
  canonicalAttemptRefs,
  observePrivateExecutionClaim,
  observePrivateProcessIdentity,
  persistPrivateExecutionRecord,
  readPrivateExecutionRecord,
  writePrivateExecutionRecord,
} from '../durable-execution/worker.mjs';
import {
  parkQueueRecovery,
  runQueueDecision,
  stopNeverLaunchedAttempt,
} from './driver.mjs';
import {
  acquireSupervisorLease,
  retireSupervisorLeaseCapability,
  supervisorProtocolRefs,
} from './supervisor-lease.mjs';

export { supervisorProtocolRefs } from './supervisor-lease.mjs';

const PRESENCE = new Set(['absent', 'live', 'dead', 'unknown']);
const IDENTITY = new Set(['verified', 'pid-reused', 'unverified', 'foreign-host', 'unknown']);
const DOCUMENT = new Set(['absent', 'valid', 'invalid', 'conflicting']);

function recoveryResult(action, diagnostic = null, outcome = 'active') {
  return Object.freeze({ action, outcome, diagnostic, consumes_attempt: false });
}

function observed(value, allowed, name) {
  if (!allowed.has(value)) throw new TypeError(`${name} has unsupported value ${String(value)}`);
  return value;
}

/**
 * Pure recovery classification. It receives already-sanitized facts and cannot inspect a PID,
 * filesystem, clock, or network. Absence of acknowledgement is never converted into no-launch
 * proof: the only safe prepared case has a protocol reservation, no dispatch-start record, an
 * identity-resolved owner, no worker/provider/descendant, and positive tree-termination proof.
 */
export function classifyRecoveryObservation(value = {}) {
  const terminalReceipt = observed(value.terminal_receipt, DOCUMENT, 'terminal_receipt');
  const publicResult = observed(value.public_result, DOCUMENT, 'public_result');
  const worker = observed(value.worker, PRESENCE, 'worker');
  const provider = observed(value.provider, PRESENCE, 'provider');
  const workerIdentity = observed(value.worker_identity, IDENTITY, 'worker_identity');
  const providerIdentity = observed(value.provider_identity, IDENTITY, 'provider_identity');
  const facts = Object.freeze({ ...value, terminal_receipt: terminalReceipt, public_result: publicResult,
    worker, provider, worker_identity: workerIdentity, provider_identity: providerIdentity });

  // A complete current-attempt terminal is reconciled ahead of STOP, leases, prepared work, or any
  // other dispatch opportunity. A conflicting/invalid document is never ignored in favour of work.
  if (terminalReceipt === 'valid' && publicResult === 'valid') {
    return Object.freeze({ classification: 'terminal-receipt', diagnostic: null, facts });
  }
  if (terminalReceipt === 'conflicting' || publicResult === 'conflicting') {
    return Object.freeze({ classification: 'terminal-conflict', diagnostic: 'terminal-evidence-conflict', facts });
  }
  if (terminalReceipt === 'invalid' || publicResult === 'invalid'
      || (terminalReceipt === 'valid') !== (publicResult === 'valid')) {
    return Object.freeze({ classification: 'terminal-invalid', diagnostic: 'terminal-evidence-invalid', facts });
  }

  if (value.active_attempt !== true) {
    return Object.freeze({
      classification: value.stop_present === true ? 'idle-stopped' : 'idle', diagnostic: null, facts,
    });
  }
  if (value.held_action_consumed === true) {
    return Object.freeze({
      classification: 'held-action-unknown', diagnostic: 'held-action-outcome-unknown', facts,
    });
  }
  if (workerIdentity === 'foreign-host' || providerIdentity === 'foreign-host'
      || value.dispatch_owner === 'foreign-host') {
    return Object.freeze({ classification: 'foreign-owner', diagnostic: 'foreign-owner', facts });
  }
  if (workerIdentity === 'pid-reused' || providerIdentity === 'pid-reused') {
    return Object.freeze({ classification: 'pid-reuse', diagnostic: 'process-identity-ambiguous', facts });
  }

  // Provider launch evidence without the fail-closed acknowledgement is exactly the crash window
  // that may have produced external effects. The still-"prepared" public job is not a retry grant.
  if (value.launch_evidence === true && value.launch_acknowledgement !== 'valid') {
    return Object.freeze({
      classification: 'spawn-before-acknowledgement',
      diagnostic: 'launch-acknowledgement-missing',
      facts,
    });
  }

  if (value.launch_acknowledgement === 'valid') {
    if (worker === 'live' && workerIdentity === 'verified'
        && provider === 'live' && providerIdentity === 'verified') {
      return Object.freeze({ classification: 'live-pair', diagnostic: null, facts });
    }
    if (worker === 'live' && workerIdentity === 'verified'
        && provider === 'dead' && providerIdentity === 'verified') {
      return Object.freeze({ classification: 'worker-classifying-terminal', diagnostic: null, facts });
    }
    if (worker === 'dead' && ['live', 'unknown'].includes(provider)) {
      return Object.freeze({
        classification: 'provider-outlived-worker', diagnostic: 'provider-activity-unknown', facts,
      });
    }
    if (worker === 'dead' && provider === 'dead'
        && workerIdentity === 'verified' && providerIdentity === 'verified'
        && value.descendants === 'none' && value.process_tree_terminated === true) {
      return Object.freeze({ classification: 'dead-no-receipt', diagnostic: null, facts });
    }
    return Object.freeze({
      classification: 'acknowledged-owner-unknown', diagnostic: 'process-identity-ambiguous', facts,
    });
  }

  if (value.dispatch_started === true || worker !== 'absent' || provider !== 'absent') {
    return Object.freeze({
      classification: 'launch-outcome-unknown', diagnostic: 'attempt-outcome-unknown', facts,
    });
  }

  const neverLaunched = value.intent === 'prepared'
    && value.dispatch_reservation === 'prepared'
    && value.dispatch_started === false
    && ['current', 'dead-verified'].includes(value.dispatch_owner)
    && worker === 'absent'
    && provider === 'absent'
    && value.descendants === 'none'
    && value.process_tree_terminated === true;
  if (neverLaunched) {
    return Object.freeze({ classification: 'prepared-never-launched', diagnostic: null, facts });
  }
  if (value.intent === 'absent' && value.dispatch_reservation === 'absent'
      && worker === 'absent' && provider === 'absent' && value.descendants === 'none') {
    return Object.freeze({ classification: 'reserved-not-prepared', diagnostic: null, facts });
  }
  return Object.freeze({
    classification: 'prepared-ambiguous', diagnostic: 'attempt-outcome-unknown', facts,
  });
}

/** Pure closed decision function over a recovery classification and the frozen retry policy. */
export function decideRecoveryAction(classified, retryPolicy) {
  if (!classified || typeof classified !== 'object') throw new TypeError('classified recovery is required');
  const policy = retryPolicy && typeof retryPolicy === 'object' ? retryPolicy : {};
  switch (classified.classification) {
    case 'terminal-receipt':
      return recoveryResult('reconcile-terminal');
    case 'idle':
      return recoveryResult('advance');
    case 'idle-stopped':
      return recoveryResult('stop-idle', 'stop-present', 'stopped');
    case 'prepared-never-launched':
      return classified.facts.stop_present === true
        ? recoveryResult('stop-unlaunched', 'stop-present', 'stopped')
        : recoveryResult('dispatch-prepared');
    case 'reserved-not-prepared':
      return classified.facts.stop_present === true
        ? recoveryResult('stop-unlaunched', 'stop-present', 'stopped')
        : recoveryResult('prepare-and-dispatch');
    case 'live-pair':
    case 'worker-classifying-terminal':
      return recoveryResult('wait');
    case 'dead-no-receipt': {
      // Schema v1 binds requires_terminal_receipt=true. Keep the other checks explicit so a later
      // compatible version cannot accidentally turn a replay-safe label into sufficient proof.
      if (policy.requires_terminal_receipt === true) {
        return recoveryResult('park', 'terminal-receipt-required', 'parked');
      }
      if (!Array.isArray(policy.replay_safe_classes)
          || !policy.replay_safe_classes.includes(classified.facts.replay_class)
          || policy.requires_cleanup_complete !== true
          || policy.requires_process_tree_terminated !== true
          || classified.facts.process_tree_terminated !== true) {
        return recoveryResult('park', 'attempt-not-replay-safe', 'parked');
      }
      return recoveryResult('retry-terminated');
    }
    case 'terminal-conflict':
    case 'terminal-invalid':
    case 'held-action-unknown':
    case 'foreign-owner':
    case 'pid-reuse':
    case 'spawn-before-acknowledgement':
    case 'provider-outlived-worker':
    case 'acknowledged-owner-unknown':
    case 'launch-outcome-unknown':
    case 'prepared-ambiguous':
      return recoveryResult('park', classified.diagnostic, 'parked');
    default:
      return recoveryResult('park', 'recovery-classification-unknown', 'parked');
  }
}

/** Pure bounded exponential backoff used only when consecutive durable states are unchanged. */
export function supervisorBackoffDelay(pollIntervalMs, maxIdleMs, unchangedCycles) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
      || !Number.isSafeInteger(maxIdleMs) || maxIdleMs < pollIntervalMs
      || !Number.isSafeInteger(unchangedCycles) || unchangedCycles < 0) {
    throw new TypeError('supervisor backoff requires bounded positive integer inputs');
  }
  return Math.min(maxIdleMs, pollIntervalMs * (2 ** Math.min(unchangedCycles, 10)));
}

const STATUS_REF = 'supervisor-status.json';
const TERMINAL_STAGES = new Set(['done', 'held', 'stopped']);

function invalid(code, message) {
  throw new SidekicksError(`[${code}] ${message}`, EXIT_VALIDATION);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { invalid('supervisor-evidence-invalid', `${path}: ${error.message}`); }
}

function regularPublicJson(runDir, ref, label) {
  const path = join(runDir, ...ref.split('/'));
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    invalid('public-evidence-invalid', `${label} is not a regular file`);
  }
  const real = realpathSync(path);
  const rel = relative(runDir, real);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    invalid('artifact-path-outside-root', `${label} resolves outside the public run root`);
  }
  return json(path);
}

function normalizedPublicStatus(value, runId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('supervisor-status-invalid', 'public supervisor status must be an object');
  }
  const keys = [
    'schema_version', 'kind', 'driver', 'run_id', 'lease_id', 'liveness', 'heartbeat_at',
    'decision', 'unchanged_cycles', 'next_poll_ms', 'revision', 'stage', 'outcome',
    'stop_present', 'report_ref', 'diagnostic', 'content_digest',
  ];
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
      || value.schema_version !== 1 || value.kind !== 'queue-supervisor-status'
      || value.driver !== 'queue-supervisor/v1'
      || value.run_id !== runId
      || typeof value.lease_id !== 'string' || value.lease_id.length === 0
      || !['active', 'offline'].includes(value.liveness)
      || typeof value.heartbeat_at !== 'string' || !Number.isFinite(Date.parse(value.heartbeat_at))
      || typeof value.decision !== 'string' || value.decision.length === 0
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isSafeInteger(value.unchanged_cycles) || value.unchanged_cycles < 0
      || (value.next_poll_ms !== null
        && (!Number.isSafeInteger(value.next_poll_ms) || value.next_poll_ms < 1))
      || typeof value.stage !== 'string' || value.stage.length === 0
      || (value.outcome !== null && typeof value.outcome !== 'string')
      || typeof value.stop_present !== 'boolean'
      || (value.report_ref !== null && value.report_ref !== 'report.json')
      || (value.diagnostic !== null && typeof value.diagnostic !== 'string')) {
    invalid('supervisor-status-invalid', 'public supervisor status has an unsupported shape');
  }
  const unsigned = { ...value };
  delete unsigned.content_digest;
  if (value.content_digest !== digest(unsigned)) {
    invalid('supervisor-status-invalid', 'public supervisor status digest differs');
  }
  return value;
}

function safeRun(repoRootValue, runDirValue, approvalValue) {
  const repoRoot = realpathSync(repoRootValue);
  const runDir = realpathSync(runDirValue);
  const approval = normalizeApprovalEnvelope(approvalValue);
  const expected = realpathSync(join(repoRoot, 'artifacts', 'runs', ...approval.run_id.split('/')));
  if (runDir !== expected || relative(repoRoot, runDir).split(sep).join('/')
      !== `artifacts/runs/${approval.run_id}`) {
    invalid('run-locator-conflict', 'supervised run is outside its approved canonical root');
  }
  const state = readFencedRun(runDir);
  if (state.approval_digest !== approvalEnvelopeDigest(approval)) {
    invalid('approval-digest-mismatch', 'supervised state does not match approval-envelope.json');
  }
  return { repoRoot, runDir, approval, state };
}

function publicStatus(runDir, state, value = {}) {
  const document = {
    schema_version: 1,
    kind: 'queue-supervisor-status',
    driver: state.driver,
    run_id: state.run_id,
    lease_id: value.lease_id ?? null,
    liveness: value.liveness ?? 'offline',
    heartbeat_at: value.heartbeat_at ?? null,
    decision: value.decision ?? null,
    unchanged_cycles: value.unchanged_cycles ?? 0,
    next_poll_ms: value.next_poll_ms ?? null,
    revision: state.revision,
    stage: state.stage,
    outcome: state.outcome,
    stop_present: stopPresent(runDir),
    report_ref: state.report?.ref ?? null,
    diagnostic: state.parked?.diagnostic ?? value.diagnostic ?? null,
  };
  const withDigest = { ...document, content_digest: digest(document) };
  writeAtomic(join(runDir, STATUS_REF), `${JSON.stringify(withDigest, null, 2)}\n`);
  return withDigest;
}

function heartbeatLease(context, lease, state, value = {}, now = Date.now) {
  const ref = supervisorProtocolRefs(context.approval.run_id).lease;
  const current = readPrivateExecutionRecord(context.repoRoot, ref, 'supervisor lease');
  if (!current || current.lease_id !== lease.lease_id || current.state !== 'active') {
    invalid('supervisor-lease-lost', 'supervisor lease changed before heartbeat');
  }
  const heartbeatAt = bangkokTimestamp(now());
  const next = { ...current, heartbeat_at: heartbeatAt };
  writePrivateExecutionRecord(context.repoRoot, ref, next);
  publicStatus(context.runDir, state, {
    ...value, lease_id: lease.lease_id, liveness: 'active', heartbeat_at: heartbeatAt,
  });
  return next;
}

function releaseSupervisorLease(context, lease, state, value = {}, now = Date.now) {
  const ref = supervisorProtocolRefs(context.approval.run_id).lease;
  const paths = runStorePaths(context.runDir);
  const lock = acquireLock(paths, { timeoutMs: 1000 });
  try {
    const current = readPrivateExecutionRecord(context.repoRoot, ref, 'supervisor lease');
    if (current?.lease_id !== lease.lease_id || current.state !== 'active') return null;
    writePrivateExecutionRecord(context.repoRoot, ref, {
      ...current, state: 'released', heartbeat_at: bangkokTimestamp(now()),
    });
    // Publish offline while the run lock still excludes a replacement lease. A predecessor can
    // therefore never overwrite a successor's active public liveness.
    return publicStatus(context.runDir, state, {
      ...value, lease_id: lease.lease_id, liveness: 'offline', heartbeat_at: bangkokTimestamp(now()),
    });
  } finally {
    releaseLock(paths, lock.nonce);
  }
}

function walkIntent(directory, attemptId, found = []) {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) invalid('artifact-path-outside-root', 'attempt evidence contains a symbolic link');
    if (entry.isDirectory()) walkIntent(path, attemptId, found);
    else if (entry.isFile() && entry.name === 'intent.json') {
      const value = json(path);
      if (value?.job?.attempt_id === attemptId) found.push(value);
    }
  }
  return found;
}

function documentState(value) {
  return value === null ? 'absent' : 'valid';
}

function processObservation(identity, observe = observePrivateProcessIdentity) {
  if (!identity) return { liveness: 'unknown', identity: 'unknown' };
  const observed = observe(identity);
  return { liveness: observed.liveness, identity: observed.identity };
}

function observeRecovery(context, lease, dependencies = {}) {
  const state = readFencedRun(context.runDir);
  if (state.active_attempt === null) return observationForIdle(state, context.runDir);
  const attemptId = state.active_attempt.attempt_id;
  const intents = walkIntent(join(context.runDir, 'attempts'), attemptId);
  if (intents.length > 1) invalid('attempt-evidence-conflict', 'multiple public intents claim the active attempt');
  const intent = intents[0] ?? null;
  const protocolRefs = intent?.job ? canonicalAttemptRefs(intent.job) : null;
  const dispatch = supervisorProtocolRefs(state.run_id, attemptId);
  const reservation = readPrivateExecutionRecord(context.repoRoot, dispatch.dispatchReservation, 'dispatch reservation');
  const dispatchStart = readPrivateExecutionRecord(context.repoRoot, dispatch.dispatchStart, 'dispatch start');
  const dispatchAck = readPrivateExecutionRecord(context.repoRoot, dispatch.dispatchAck, 'worker launch acknowledgement');
  const record = (ref, label) => protocolRefs?.[ref]
    ? readPrivateExecutionRecord(context.repoRoot, protocolRefs[ref], label) : null;
  const workerStart = record('private_worker_start_ref', 'worker start');
  const workerHeartbeat = record('private_worker_heartbeat_ref', 'worker heartbeat');
  const launchAck = record('private_launch_ack_ref', 'launch acknowledgement');
  const launchEvidence = record('private_launch_evidence_ref', 'launch evidence');
  const settlement = record('private_settlement_ref', 'private settlement');
  const receipt = record('private_terminal_receipt_ref', 'terminal receipt');
  let result = null;
  if (protocolRefs?.public_result_ref) {
    const resultPath = join(context.runDir, ...protocolRefs.public_result_ref.split('/'));
    if (existsSync(resultPath)) result = json(resultPath);
  }
  const heartbeatProvider = workerHeartbeat?.provider ?? null;
  const providerIdentity = launchAck?.process?.provider ?? heartbeatProvider;
  const observeProcess = dependencies.observePrivateProcessIdentity ?? observePrivateProcessIdentity;
  const worker = processObservation(workerStart?.worker ?? null, observeProcess);
  const provider = processObservation(providerIdentity, observeProcess);
  // Heartbeat freshness proves that its writer recently ran, not that a currently live PID is the
  // process incarnation recorded at spawn. The provider does not participate in a fresh challenge,
  // so OS identity uncertainty remains uncertainty and recovery parks on PID reuse ambiguity.
  let dispatchOwner = 'unknown';
  if (reservation?.owner?.claim_id === lease.owner.claim_id) dispatchOwner = 'current';
  else if (reservation?.owner) {
    const owner = (dependencies.observePrivateExecutionClaim ?? observePrivateExecutionClaim)(reservation.owner);
    dispatchOwner = owner.identity === 'foreign-host' ? 'foreign-host'
      : owner.liveness === 'dead' ? 'dead-verified' : 'unknown';
  }
  return {
    state,
    request_ref: protocolRefs?.private_request_ref ?? null,
    settlement,
    facts: {
      active_attempt: true,
      stop_present: stopPresent(context.runDir),
      private_settlement: documentState(settlement),
      terminal_receipt: documentState(receipt),
      public_result: documentState(result),
      intent: intent === null ? 'absent' : 'prepared',
      dispatch_reservation: reservation === null ? 'absent' : 'prepared',
      dispatch_started: dispatchStart !== null,
      dispatch_owner: dispatchOwner,
      launch_acknowledgement: launchAck === null ? 'absent' : 'valid',
      launch_evidence: launchEvidence !== null,
      worker: workerStart === null ? 'absent' : worker.liveness,
      worker_identity: workerStart === null ? 'unknown' : worker.identity,
      provider: providerIdentity ? provider.liveness
        : launchEvidence === null ? 'absent' : 'unknown',
      provider_identity: providerIdentity ? provider.identity : 'unknown',
      descendants: providerIdentity ? (provider.liveness === 'dead' ? 'none' : 'present')
        : launchEvidence === null && workerStart === null ? 'none' : 'unknown',
      process_tree_terminated: workerStart === null && launchEvidence === null,
      replay_class: receipt?.classification ?? null,
      held_action_consumed: false,
    },
  };
}

function observationForIdle(state, runDir) {
  return {
    state,
    request_ref: null,
    settlement: null,
    facts: {
      active_attempt: false, stop_present: stopPresent(runDir), private_settlement: 'absent',
      terminal_receipt: 'absent', public_result: 'absent', intent: 'absent',
      dispatch_reservation: 'absent', dispatch_started: false, dispatch_owner: 'current',
      launch_acknowledgement: 'absent', launch_evidence: false, worker: 'absent',
      worker_identity: 'unknown', provider: 'absent', provider_identity: 'unknown',
      descendants: 'none', process_tree_terminated: true, replay_class: null,
      held_action_consumed: false,
    },
  };
}

function dispatchHooks(context, lease, dependencies) {
  return {
    ...dependencies,
    nonBlocking: true,
    afterAttemptPrepared: ({ attempt }) => {
      const ref = supervisorProtocolRefs(context.approval.run_id, attempt.job.attempt_id).dispatchReservation;
      const existing = readPrivateExecutionRecord(context.repoRoot, ref, 'dispatch reservation');
      if (existing !== null) {
        if (existing.attempt_id !== attempt.job.attempt_id
            || existing.approval_digest !== attempt.job.approval_digest
            || existing.rendered_prompt_digest !== attempt.job.rendered_prompt_digest) {
          invalid('attempt-evidence-conflict', 'dispatch reservation belongs to another attempt identity');
        }
        dependencies.afterDispatchReservation?.(existing);
        return;
      }
      const value = {
        schema_version: 1, kind: 'supervisor-dispatch-reservation', run_id: attempt.job.run_id,
        attempt_id: attempt.job.attempt_id, approval_digest: attempt.job.approval_digest,
        rendered_prompt_digest: attempt.job.rendered_prompt_digest, owner: lease.owner,
        lease_id: lease.lease_id, reserved_at: bangkokTimestamp(Date.now()),
      };
      persistPrivateExecutionRecord(context.repoRoot, ref, value);
      dependencies.afterDispatchReservation?.(value);
    },
    beforeAttemptLaunch: ({ attempt }) => {
      const ref = supervisorProtocolRefs(context.approval.run_id, attempt.job.attempt_id).dispatchStart;
      const value = {
        schema_version: 1, kind: 'supervisor-dispatch-start', run_id: attempt.job.run_id,
        attempt_id: attempt.job.attempt_id, lease_id: lease.lease_id,
        reservation_digest: digest(readPrivateExecutionRecord(
          context.repoRoot,
          supervisorProtocolRefs(context.approval.run_id, attempt.job.attempt_id).dispatchReservation,
          'dispatch reservation',
        )),
        started_at: bangkokTimestamp(Date.now()),
      };
      persistPrivateExecutionRecord(context.repoRoot, ref, value);
      dependencies.afterDispatchStart?.(value);
    },
    afterAttemptLaunch: ({ attempt, launched }) => {
      const value = {
        schema_version: 1, kind: 'supervisor-worker-launch', run_id: attempt.job.run_id,
        attempt_id: attempt.job.attempt_id, lease_id: lease.lease_id,
        launched: launched?.launched === true, observed_at: bangkokTimestamp(Date.now()),
      };
      persistPrivateExecutionRecord(
        context.repoRoot, supervisorProtocolRefs(context.approval.run_id, attempt.job.attempt_id).dispatchAck, value,
      );
      dependencies.afterWorkerLaunch?.(value);
    },
  };
}

async function makeDecision(context, lease, leaseCapability, executorSpecs, dependencies = {}) {
  const observed = observeRecovery(context, lease, dependencies);
  const classified = observed.settlement !== null
    ? Object.freeze({ classification: 'private-settlement', diagnostic: null, facts: observed.facts })
    : classifyRecoveryObservation(observed.facts);
  const decision = classified.classification === 'private-settlement'
    ? recoveryResult('reconcile-terminal')
    : decideRecoveryAction(classified, context.approval.supervision.retry);
  if (decision.action === 'park') {
    const state = parkQueueRecovery(context.runDir, decision.diagnostic, dependencies);
    return { status: 'parked', state, decision };
  }
  if (decision.action === 'stop-unlaunched') {
    const state = stopNeverLaunchedAttempt(context.runDir, dependencies);
    return { status: 'stopped', state, decision };
  }
  if (decision.action === 'stop-idle') {
    const result = await runQueueDecision({
      repoRoot: context.repoRoot, runDir: context.runDir, approval: context.approval,
      executorSpecs, supervisorLeaseCapability: leaseCapability,
      dependencies: dispatchHooks(context, lease, dependencies),
    });
    return { ...result, decision };
  }
  if (decision.action === 'wait') return { status: 'waiting', state: observed.state, decision };
  if (decision.action === 'retry-terminated') {
    const state = parkQueueRecovery(context.runDir, 'automatic-retry-not-supported-by-schema-v1', dependencies);
    return { status: 'parked', state, decision: recoveryResult('park', 'automatic-retry-not-supported-by-schema-v1', 'parked') };
  }
  const result = await runQueueDecision({
    repoRoot: context.repoRoot, runDir: context.runDir, approval: context.approval,
    executorSpecs, supervisorLeaseCapability: leaseCapability,
    dependencies: dispatchHooks(context, lease, dependencies),
  });
  const withDecision = { ...result, decision };
  if (result.state.stage === 'done') await notifyTerminal(context, result.state, dependencies);
  return withDecision;
}

async function configuredRunReport(context, state, dependencies) {
  if (typeof dependencies.notifyConfiguredRun === 'function') {
    return dependencies.notifyConfiguredRun({ context, state });
  }
  const {
    composeMessage, initYaml, readScopeConfig, resolveChannel, scopeConfigPath,
    sendEmail, sendSlack, skillAllowed,
  } = await import('../../scripts/run-notify-hook.mjs');
  await initYaml(context.repoRoot);
  const project = context.approval.framing.scope.project;
  const scope = project === 'sidekicks' ? 'root' : project;
  const rootConfig = readScopeConfig(scopeConfigPath(context.repoRoot, 'root'));
  const scopeConfig = scope === 'root' ? rootConfig
    : readScopeConfig(scopeConfigPath(context.repoRoot, scope));
  const policy = (scopeConfig && scopeConfig.run_notify) || (rootConfig && rootConfig.run_notify);
  if (!policy || policy.enabled !== true || !skillAllowed(policy.skills, 'cli-orchestrator')) {
    return { state: 'skipped', transports: [] };
  }
  const run = {
    status: 'done', skill: 'cli-orchestrator', slug: state.run_id,
    title: 'Durable queue execution completed', runDir: `artifacts/runs/${state.run_id}`,
  };
  const transports = Array.isArray(policy.transports) && policy.transports.length
    ? policy.transports : ['slack'];
  const results = [];
  if (transports.includes('slack')) {
    const slackBlock = (scopeConfig && scopeConfig.slack) || (rootConfig && rootConfig.slack) || {};
    const aliasName = policy.env || Object.keys(slackBlock)[0];
    const alias = aliasName ? slackBlock[aliasName] : null;
    results.push(alias
      ? await sendSlack(alias, 'cli-orchestrator', composeMessage(run), dependencies.fetchImpl)
      : { ok: false, error: 'no-configured-slack-alias' });
  }
  if (transports.includes('email')) {
    const mailConfig = scopeConfig?.mail_sender
      ? scopeConfigPath(context.repoRoot, scope) : scopeConfigPath(context.repoRoot, 'root');
    results.push(sendEmail(
      context.repoRoot, mailConfig, `[sidekicks] cli-orchestrator ${state.run_id}: DONE`,
      composeMessage(run).replace(/[*`>]/gu, '').replace(/:\w+:/gu, ''),
    ));
  }
  // Resolve the configured destination before returning so an incomplete alias cannot masquerade
  // as an authorized delivery. The destination itself remains private.
  if (transports.includes('slack')) {
    const slackBlock = (scopeConfig && scopeConfig.slack) || (rootConfig && rootConfig.slack) || {};
    const aliasName = policy.env || Object.keys(slackBlock)[0];
    if (aliasName && slackBlock[aliasName]) resolveChannel(slackBlock[aliasName], 'cli-orchestrator');
  }
  return { state: results.some((entry) => entry.ok) ? 'delivered' : 'failed', transports, results };
}

async function notifyTerminal(context, state, dependencies) {
  if (context.approval.supervision.notifications.use_configured_run_reporting !== true) return null;
  if (state.report?.ref !== 'report.json') {
    invalid('notification-before-report', 'configured run reporting requires a durable terminal report');
  }
  const report = regularPublicJson(context.runDir, state.report.ref, 'durable terminal report');
  const unsignedReport = report && { ...report };
  if (unsignedReport) delete unsignedReport.content_digest;
  if (!report || report.kind !== 'queue-lifecycle-report' || report.run_id !== state.run_id
      || report.outcome !== 'verified' || report.content_digest !== state.report.content_digest
      || digest(unsignedReport) !== state.report.content_digest) {
    invalid('notification-before-report', 'durable terminal report identity or digest differs');
  }
  const protocol = supervisorProtocolRefs(state.run_id);
  const result = readPrivateExecutionRecord(context.repoRoot, protocol.notificationResult, 'notification result');
  if (result) {
    if (result.kind !== 'configured-run-reporting-result' || result.run_id !== state.run_id
        || result.report_ref !== state.report.ref || result.report_digest !== state.report.content_digest
        || !['skipped', 'delivered', 'failed'].includes(result.state)
        || !Array.isArray(result.transports)) {
      invalid('notification-evidence-invalid', 'durable notification result identity differs');
    }
    const recovered = {
      schema_version: 1, kind: 'queue-notification-status', run_id: state.run_id,
      state: result.state, report_ref: state.report.ref, report_digest: state.report.content_digest,
      transport_count: result.transports.length,
    };
    writeAtomic(join(context.runDir, 'notification-status.json'), `${JSON.stringify({
      ...recovered, content_digest: digest(recovered),
    }, null, 2)}\n`);
    return recovered;
  }
  const claim = readPrivateExecutionRecord(context.repoRoot, protocol.notificationClaim, 'notification claim');
  if (claim) {
    // A send may have crossed the external boundary. Never duplicate it because this process cannot
    // prove whether the provider accepted it before the prior caller died.
    const projection = {
      schema_version: 1, kind: 'queue-notification-status', run_id: state.run_id,
      state: 'unknown', report_ref: state.report.ref, report_digest: state.report.content_digest,
    };
    writeAtomic(join(context.runDir, 'notification-status.json'), `${JSON.stringify({
      ...projection, content_digest: digest(projection),
    }, null, 2)}\n`);
    return projection;
  }
  const privateClaim = {
    schema_version: 1, kind: 'configured-run-reporting-claim', run_id: state.run_id,
    report_ref: state.report.ref, report_digest: state.report.content_digest,
    claim_id: `notify-${randomUUID().replaceAll('-', '')}`, claimed_at: bangkokTimestamp(Date.now()),
  };
  persistPrivateExecutionRecord(context.repoRoot, protocol.notificationClaim, privateClaim);
  dependencies.afterNotificationClaim?.(privateClaim);
  const raw = await configuredRunReport(context, state, dependencies);
  const privateResult = {
    ...privateClaim, kind: 'configured-run-reporting-result', state: raw.state,
    transports: raw.transports, results: raw.results ?? [], completed_at: bangkokTimestamp(Date.now()),
  };
  persistPrivateExecutionRecord(context.repoRoot, protocol.notificationResult, privateResult);
  const projection = {
    schema_version: 1, kind: 'queue-notification-status', run_id: state.run_id,
    state: raw.state, report_ref: state.report.ref, report_digest: state.report.content_digest,
    transport_count: raw.transports.length,
  };
  writeAtomic(join(context.runDir, 'notification-status.json'), `${JSON.stringify({
    ...projection, content_digest: digest(projection),
  }, null, 2)}\n`);
  return projection;
}

export function supervisorStatus({ repoRoot, runDir, approval }) {
  const context = safeRun(repoRoot, runDir, approval);
  let liveness = null;
  const status = regularPublicJson(context.runDir, STATUS_REF, 'public supervisor status');
  if (status) {
    liveness = normalizedPublicStatus(status, context.approval.run_id);
    const heartbeat = Date.parse(liveness.heartbeat_at);
    const staleAfter = context.approval.supervision.max_idle_ms
      + context.approval.supervision.poll_interval_ms;
    if (liveness.liveness === 'active'
        && (!Number.isFinite(heartbeat) || Date.now() - heartbeat > staleAfter)) {
      liveness = { ...liveness, liveness: 'stale' };
    }
  }
  return { state: context.state, supervisor: liveness, stop_present: stopPresent(context.runDir) };
}

export function supervisorStop({ repoRoot, runDir, approval, reason }) {
  const context = safeRun(repoRoot, runDir, approval);
  const already = stopPresent(context.runDir);
  writeStop(context.runDir, { reason });
  return { run_id: context.approval.run_id, already_present: already, stop_present: true };
}

export async function supervisorOnce(input) {
  const context = safeRun(input.repoRoot, input.runDir, input.approval);
  if (!['once', 'continuous'].includes(context.approval.supervision.mode)) {
    invalid('supervision-mode-not-approved', 'once requires an approved once or continuous policy');
  }
  const held = acquireSupervisorLease(context, input.now);
  if (!held.acquired) {
    return { status: held.reason === 'owned' ? 'waiting' : 'parked', state: context.state,
      decision: recoveryResult(held.reason === 'owned' ? 'wait' : 'park', `supervisor-${held.reason}`,
        held.reason === 'owned' ? 'active' : 'parked') };
  }
  let result;
  try {
    heartbeatLease(context, held.lease, context.state, { decision: 'observe' }, input.now);
    result = await makeDecision(
      context, held.lease, held.capability, input.executorSpecs, input.dependencies,
    );
    heartbeatLease(context, held.lease, result.state, { decision: result.decision.action }, input.now);
    return result;
  } finally {
    try {
      const state = result?.state ?? readFencedRun(context.runDir);
      releaseSupervisorLease(context, held.lease, state, {
        decision: result?.decision?.action ?? 'interrupted', diagnostic: result?.decision?.diagnostic ?? null,
      }, input.now);
    } finally {
      retireSupervisorLeaseCapability(held.capability);
    }
  }
}

export async function supervisorStart(input) {
  const context = safeRun(input.repoRoot, input.runDir, input.approval);
  if (context.approval.supervision.mode !== 'continuous') {
    invalid('supervision-mode-not-approved', 'start requires an approved continuous policy');
  }
  if (input.maxCycles !== undefined
      && (!Number.isSafeInteger(input.maxCycles) || input.maxCycles < 1)) {
    invalid('supervisor-cycle-bound-invalid', 'maxCycles must be a positive safe integer when supplied');
  }
  const held = acquireSupervisorLease(context, input.now);
  if (!held.acquired) {
    return {
      status: held.reason === 'owned' ? 'waiting' : 'parked',
      state: context.state,
      decision: recoveryResult(
        held.reason === 'owned' ? 'wait' : 'park',
        `supervisor-${held.reason}`,
        held.reason === 'owned' ? 'active' : 'parked',
      ),
    };
  }
  let unchanged = 0;
  let priorDigest = null;
  let result = { status: 'waiting', state: context.state, decision: recoveryResult('wait') };
  const maxCycles = input.maxCycles ?? Infinity;
  try {
    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      result = await makeDecision(
        context, held.lease, held.capability, input.executorSpecs, input.dependencies,
      );
      const currentDigest = digest(result.state);
      unchanged = currentDigest === priorDigest ? unchanged + 1 : 0;
      priorDigest = currentDigest;
      const base = context.approval.supervision.poll_interval_ms;
      const nextPoll = supervisorBackoffDelay(
        base, context.approval.supervision.max_idle_ms, unchanged,
      );
      heartbeatLease(context, held.lease, result.state, {
        decision: result.decision.action, unchanged_cycles: unchanged, next_poll_ms: nextPoll,
      }, input.now);
      if (TERMINAL_STAGES.has(result.state.stage)) break;
      if (cycle + 1 < maxCycles) await (input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(nextPoll);
    }
    return result;
  } finally {
    try {
      releaseSupervisorLease(context, held.lease, result.state, {
        decision: result.decision?.action ?? 'interrupted', unchanged_cycles: unchanged,
      }, input.now);
    } finally {
      retireSupervisorLeaseCapability(held.capability);
    }
  }
}
