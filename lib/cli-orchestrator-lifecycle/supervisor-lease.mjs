// Supervisor lease acquisition and process-local mutation capability.
//
// The durable lease is recovery evidence, but it is not itself an authorization token: a stale
// record can contain a PID later reused by this process. Only this module's locked acquisition path
// mints the non-serializable capability accepted by the one-decision mutation boundary.

import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson } from '../run-events/schema.mjs';
import { acquireLock, bangkokTimestamp, releaseLock } from '../run-events/store.mjs';
import { runStorePaths } from '../durable-execution/store.mjs';
import {
  createPrivateExecutionClaim,
  observePrivateExecutionClaim,
  persistPrivateExecutionRecord,
  readPrivateExecutionRecord,
  writePrivateExecutionRecord,
} from '../durable-execution/worker.mjs';

const CAPABILITIES = new WeakMap();

function token(value, length = 32) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

export function supervisorProtocolRefs(runId, attemptId = null) {
  const base = `runs/${token(runId)}/supervisor`;
  const attempt = attemptId === null ? null : `${base}/dispatch/${token(attemptId)}`;
  return {
    lease: `${base}/lease.json`,
    leaseArchive: (leaseId) => `${base}/leases/${token(leaseId, 40)}.json`,
    dispatchReservation: attempt === null ? null : `${attempt}/reservation.json`,
    dispatchStart: attempt === null ? null : `${attempt}/dispatch-start.json`,
    dispatchAck: attempt === null ? null : `${attempt}/worker-launch.json`,
    notificationClaim: `${base}/notification/claim.json`,
    notificationResult: `${base}/notification/result.json`,
  };
}

function leaseObservation(lease) {
  if (!lease || lease.state === 'released') return { state: 'available', observation: null };
  if (lease.kind !== 'queue-supervisor-lease' || !lease.owner) {
    return { state: 'ambiguous', observation: null };
  }
  const observation = observePrivateExecutionClaim(lease.owner);
  if (observation.identity === 'foreign-host') return { state: 'foreign-host', observation };
  if (observation.liveness === 'live' && observation.identity === 'verified') {
    return { state: 'owned', observation };
  }
  if (observation.liveness === 'live') return { state: 'ambiguous', observation };
  if (observation.liveness === 'dead') return { state: 'reclaimable', observation };
  return { state: 'ambiguous', observation };
}

export function acquireSupervisorLease(context, now = Date.now) {
  const paths = runStorePaths(context.runDir);
  const lock = acquireLock(paths, { timeoutMs: 1000 });
  try {
    const ref = supervisorProtocolRefs(context.approval.run_id);
    const prior = readPrivateExecutionRecord(context.repoRoot, ref.lease, 'supervisor lease');
    const observed = leaseObservation(prior);
    if (!['available', 'reclaimable'].includes(observed.state)) {
      return { acquired: false, reason: observed.state, lease: prior, capability: null };
    }
    if (prior) persistPrivateExecutionRecord(
      context.repoRoot, ref.leaseArchive(prior.lease_id ?? randomUUID()), prior,
    );
    const owner = createPrivateExecutionClaim('queue-supervisor');
    const at = bangkokTimestamp(now());
    const lease = {
      schema_version: 1,
      kind: 'queue-supervisor-lease',
      run_id: context.approval.run_id,
      lease_id: `lease-${randomUUID().replaceAll('-', '')}`,
      owner,
      state: 'active',
      acquired_at: at,
      heartbeat_at: at,
    };
    writePrivateExecutionRecord(context.repoRoot, ref.lease, lease);
    const capability = Object.freeze({});
    CAPABILITIES.set(capability, {
      repo_root: context.repoRoot,
      run_id: context.approval.run_id,
      lease_id: lease.lease_id,
      owner_digest: canonicalJson(lease.owner),
    });
    return { acquired: true, lease, capability, ref: ref.lease };
  } finally {
    releaseLock(paths, lock.nonce);
  }
}

export function validateSupervisorLeaseCapability(context, approval, capability) {
  if (!capability || typeof capability !== 'object') return false;
  const bound = CAPABILITIES.get(capability);
  if (!bound || bound.repo_root !== context.repoRoot || bound.run_id !== approval.run_id) return false;
  const current = readPrivateExecutionRecord(
    context.repoRoot, supervisorProtocolRefs(approval.run_id).lease, 'supervisor lease',
  );
  return current?.kind === 'queue-supervisor-lease'
    && current.run_id === approval.run_id
    && current.state === 'active'
    && current.lease_id === bound.lease_id
    && canonicalJson(current.owner) === bound.owner_digest;
}

export function retireSupervisorLeaseCapability(capability) {
  if (capability && typeof capability === 'object') CAPABILITIES.delete(capability);
}
