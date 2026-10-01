// Shared fenced transaction store for durable execution.
//
// Phase 2 owns only mutation correctness: one nonce-fenced writer, post-acquisition reload,
// expected revisions, idempotency, recoverable state/receipt persistence, independent STOP, and
// fail-closed sidecar divergence. Worker launch and supervision remain later phases.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { writeAtomic } from '../fs-safety/fsx.mjs';
import {
  acquireLock,
  appendEvent,
  bangkokTimestamp,
  readLockOwner,
  releaseLock,
  replayEvents,
} from '../run-events/store.mjs';
import { canonicalJson, normalizedIntent, validateIntent } from '../run-events/schema.mjs';
import { EXIT_IO, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import {
  DURABLE_EXECUTION_SCHEMA_VERSION,
  QUEUE_DRIVER_ID,
  normalizeTransitionReceipt,
} from './schema.mjs';

export const RUN_STATE_FILENAME = 'run.json';
export const RUN_LOCK_FILENAME = 'run.lock';
export const RUN_LOCK_RECOVERY_DIRNAME = 'run.lock.recovery';
export const TRANSITIONS_DIRNAME = 'transitions';
export const TRANSITION_RECOVERY_DIRNAME = 'recovery';
export const STOP_FILENAME = 'STOP';

export function runStorePaths(runDir) {
  const transitions = join(runDir, TRANSITIONS_DIRNAME);
  return {
    runDir,
    state: join(runDir, RUN_STATE_FILENAME),
    lock: join(runDir, RUN_LOCK_FILENAME),
    lockMutationGuard: join(runDir, `${RUN_LOCK_FILENAME}.mutation`),
    lockRecovery: join(runDir, RUN_LOCK_RECOVERY_DIRNAME),
    transitions,
    transitionRecovery: join(transitions, TRANSITION_RECOVERY_DIRNAME),
    events: join(runDir, 'events.v1.jsonl'),
    stop: join(runDir, STOP_FILENAME),
  };
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function internalConflictId(kind, value) {
  return `${kind}/${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function clone(value) {
  return structuredClone(value);
}

function invalid(code, message) {
  throw new SidekicksError(`[${code}] ${message}`, EXIT_VALIDATION);
}

function io(code, message) {
  throw new SidekicksError(`[${code}] ${message}`, EXIT_IO);
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    invalid('run-state-invalid', `${RUN_STATE_FILENAME} must contain an object`);
  }
  if (state.driver !== QUEUE_DRIVER_ID) {
    invalid('driver-ownership-conflict', `expected ${QUEUE_DRIVER_ID}, found ${String(state.driver)}`);
  }
  if (typeof state.run_id !== 'string' || state.run_id === '') {
    invalid('run-state-invalid', 'run_id must be a non-empty string');
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    invalid('run-state-invalid', 'revision must be a safe non-negative integer');
  }
  if (!state.transition_receipts || typeof state.transition_receipts !== 'object'
    || Array.isArray(state.transition_receipts)) {
    invalid('run-state-invalid', 'transition_receipts must be an object');
  }
  if (!Array.isArray(state.replay_conflicts)) {
    invalid('run-state-invalid', 'replay_conflicts must be an array');
  }
  return state;
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function repositoryRootFrom(runDir) {
  let current = realpathSync(runDir);
  while (dirname(current) !== current) {
    if (existsSync(join(current, '.sidekicks'))) return current;
    current = dirname(current);
  }
  io('migration-ownership-uncommitted', 'cannot resolve the repository root for migrated ownership');
}

function assertMigratedOwnership(runDir, state) {
  if (!state.migration) return;
  const migration = state.migration;
  const required = [
    'proposal_digest', 'source_driver', 'source_ref', 'source_revision', 'ownership_ref',
    'receipt_ref', 'archive_ref', 'archive_manifest_digest',
  ];
  if (!migration || typeof migration !== 'object' || Array.isArray(migration)
      || required.some((key) => typeof migration[key] !== 'string' || migration[key] === '')) {
    io('migration-ownership-uncommitted', 'migrated state does not carry a complete ownership boundary');
  }
  const repoRoot = repositoryRootFrom(runDir);
  const resolvePublic = (ref, label) => {
    if (isAbsolute(ref) || ref.includes('\\') || ref.split('/').includes('..')) {
      io('migration-ownership-uncommitted', `${label} is not a portable repository-relative path`);
    }
    const absolute = join(repoRoot, ...ref.split('/'));
    let actual;
    try { actual = realpathSync(absolute); }
    catch { io('migration-ownership-uncommitted', `${label} is missing`); }
    const rel = relative(repoRoot, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      io('migration-ownership-uncommitted', `${label} escapes the repository root`);
    }
    return actual;
  };
  const ownerPath = resolvePublic(migration.ownership_ref, 'migration ownership record');
  const receiptPath = resolvePublic(migration.receipt_ref, 'migration receipt');
  const sourcePath = resolvePublic(migration.source_ref, 'legacy source');
  const archivePath = resolvePublic(migration.archive_ref, 'legacy archive manifest');
  let owner;
  try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); }
  catch { io('migration-ownership-uncommitted', 'migration ownership record is invalid'); }
  const receiptBytes = readFileSync(receiptPath);
  let receipt;
  try { receipt = JSON.parse(receiptBytes); }
  catch { io('migration-ownership-uncommitted', 'migration receipt is invalid'); }
  if (owner.driver !== QUEUE_DRIVER_ID || owner.target_run_id !== state.run_id
      || owner.proposal_digest !== migration.proposal_digest
      || receipt.proposal_digest !== migration.proposal_digest
      || receipt.archive_ref !== migration.archive_ref
      || receipt.archive_manifest_digest !== migration.archive_manifest_digest
      || owner.migration_receipt_digest !== digestBytes(receiptBytes)) {
    io('migration-ownership-uncommitted', 'migration ownership and immutable receipt do not agree');
  }
  if (existsSync(join(sourcePath, 'STOP'))) {
    io('migration-source-stopped', 'legacy STOP appeared after ownership transfer');
  }
  const archiveBytes = readFileSync(archivePath);
  if (digestBytes(Buffer.from(canonicalJson(JSON.parse(archiveBytes.toString('utf8'))), 'utf8'))
      !== migration.archive_manifest_digest) {
    io('migration-source-changed', 'legacy archive manifest does not match the approved migration');
  }
  if (!Array.isArray(receipt.original_evidence) || receipt.original_evidence.length === 0) {
    io('migration-source-changed', 'migration receipt does not enumerate original evidence');
  }
  for (const row of receipt.original_evidence) {
    if (!row || typeof row !== 'object' || typeof row.path !== 'string'
        || typeof row.archive_ref !== 'string' || typeof row.digest !== 'string') {
      io('migration-source-changed', 'migration receipt carries malformed original evidence');
    }
    const current = resolvePublic(`${migration.source_ref}/${row.path}`, 'legacy source evidence');
    const archived = resolvePublic(row.archive_ref, 'archived legacy evidence');
    if (digestBytes(readFileSync(current)) !== row.digest || digestBytes(readFileSync(archived)) !== row.digest) {
      io('migration-source-changed', `legacy evidence changed after migration: ${row.path}`);
    }
  }
}

export function readFencedRun(runDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(runStorePaths(runDir).state, 'utf8'));
  } catch (error) {
    io('run-state-unreadable', `${RUN_STATE_FILENAME} cannot be read: ${error.message}`);
  }
  const state = validateState(parsed);
  assertMigratedOwnership(runDir, state);
  return state;
}

function assertFence(paths, nonce) {
  const owner = readLockOwner(paths.lock);
  if (!owner || owner.nonce !== nonce) {
    io('fencing-token-stale', 'the live ownership token changed before persistence; no state was written');
  }
}

function receiptFileName(receipt) {
  const suffix = createHash('sha256').update(receipt.idempotency_key, 'utf8').digest('hex').slice(0, 16);
  return `${String(receipt.revision_to).padStart(12, '0')}-${suffix}.json`;
}

function receiptDocument(entry) {
  const { settlement: _settlement, event: _event, ...receipt } = entry;
  return normalizeTransitionReceipt(receipt);
}

function normalizedReceiptFile(file) {
  try {
    return normalizeTransitionReceipt(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    io('transition-receipt-invalid', `${basename(file)} cannot be validated: ${error.message}`);
  }
}

function persistJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function uniqueTransitionRecoveryPath(directory, name) {
  mkdirSync(directory, { recursive: true });
  let candidate = join(directory, name);
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = join(directory, `${name}.${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function fault(opts, boundary) {
  if (opts.faultAt === boundary) throw new Error(`fault-injected:${boundary}`);
}

function persistUnderFence(paths, nonce, current, transaction, opts = {}) {
  const now = opts.now || Date.now;
  const next = validateState(clone(transaction.state));
  next.driver = current.driver;
  next.run_id = current.run_id;
  next.revision = current.revision + 1;
  next.transition_receipts = { ...(current.transition_receipts || {}) };
  next.replay_conflicts = Array.isArray(next.replay_conflicts) ? next.replay_conflicts : [];

  const resultDigest = digest(transaction.settlement);
  const receipt = normalizeTransitionReceipt({
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'transition-receipt',
    driver: QUEUE_DRIVER_ID,
    run_id: current.run_id,
    transition_id: transaction.transition_id,
    idempotency_key: transaction.idempotency_key,
    revision_from: current.revision,
    revision_to: next.revision,
    state_from: transaction.state_from,
    state_to: transaction.state_to,
    input_digest: transaction.input_digest,
    result_digest: resultDigest,
    receipt_id: transaction.receipt_id,
    committed_at: bangkokTimestamp(now()),
  });
  next.transition_receipts = {
    ...next.transition_receipts,
    [transaction.idempotency_key]: {
      ...receipt,
      settlement: clone(transaction.settlement),
      ...(transaction.event ? { event: clone(transaction.event) } : {}),
    },
  };

  mkdirSync(paths.transitions, { recursive: true });
  const finalPath = join(paths.transitions, receiptFileName(receipt));
  const pendingPath = `${finalPath}.pending`;
  writeFileSync(pendingPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  fault(opts, 'after-receipt-prepared');

  if (opts.beforePersist) opts.beforePersist({ lockPath: paths.lock, nonce, state: clone(next) });
  assertFence(paths, nonce);
  persistJson(paths.state, next);
  fault(opts, 'after-state-persisted');

  if (existsSync(finalPath)) {
    const existing = readFileSync(finalPath, 'utf8');
    const pending = readFileSync(pendingPath, 'utf8');
    if (existing !== pending) {
      io('transition-receipt-conflict', `${basename(finalPath)} contains different evidence`);
    }
    unlinkSync(pendingPath);
  } else {
    renameSync(pendingPath, finalPath);
  }
  fault(opts, 'after-receipt-published');
  return { state: next, receipt, settlement: clone(transaction.settlement), result_digest: resultDigest };
}

export function initializeFencedRun(runDir, state, opts = {}) {
  const paths = runStorePaths(runDir);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(paths.transitions, { recursive: true });
  const lease = acquireLock(
    { lock: paths.lock, recovery: paths.lockRecovery, lockMutationGuard: paths.lockMutationGuard },
    { timeoutMs: opts.lockTimeoutMs },
  );
  try {
    assertFence(paths, lease.nonce);
    if (existsSync(paths.state)) invalid('run-already-exists', `${RUN_STATE_FILENAME} already exists`);
    const initial = validateState(clone(state));
    if (initial.revision !== 0) invalid('run-state-invalid', 'initial revision must be 0');
    persistJson(paths.state, initial);
    return initial;
  } finally {
    releaseLock(paths, lease.nonce);
  }
}

function parkReplayConflict(paths, nonce, current, request, inputDigest, original, opts) {
  const next = clone(current);
  next.stage = 'held';
  next.mutation_halted = true;
  next.replay_conflicts = [
    ...(current.replay_conflicts || []),
    {
      idempotency_key: request.idempotency_key,
      original_input_digest: original.input_digest,
      conflicting_input_digest: inputDigest,
      observed_at: bangkokTimestamp((opts.now || Date.now)()),
    },
  ];
  const conflictKey = internalConflictId('replay-conflict', `${request.idempotency_key}\0${inputDigest}`);
  const persisted = persistUnderFence(paths, nonce, current, {
    state: next,
    settlement: {
      parked: true,
      original_input_digest: original.input_digest,
      conflicting_input_digest: inputDigest,
    },
    transition_id: conflictKey,
    idempotency_key: conflictKey,
    receipt_id: `replay-conflict-${inputDigest.slice(-16)}`,
    state_from: current.stage,
    state_to: 'held',
    input_digest: inputDigest,
  }, opts);
  return { ...persisted, result: 'conflict', input_digest: inputDigest };
}

function sidecarDigests(runDir, event) {
  const incoming = digest(normalizedIntent(event));
  let original = null;
  try {
    const existing = replayEvents(runDir).events.find((candidate) => candidate.event_id === event.event_id);
    if (existing) original = digest(normalizedIntent(existing));
  } catch { /* the append error remains authoritative; absence is represented by null */ }
  return { original_digest: original || digest({ event_id: event.event_id, evidence: 'unreadable' }), conflicting_digest: incoming };
}

function parkSidecarConflict(paths, nonce, current, request, event, opts) {
  const evidence = sidecarDigests(paths.runDir, event);
  const next = clone(current);
  next.stage = 'held';
  next.mutation_halted = true;
  next.sidecar_divergence = {
    code: 'sidecar-diverged',
    event_id: event.event_id,
    ...evidence,
    observed_at: bangkokTimestamp((opts.now || Date.now)()),
  };
  const key = internalConflictId('sidecar-conflict', `${request.idempotency_key}\0${digest(event)}`);
  const persisted = persistUnderFence(paths, nonce, current, {
    state: next,
    settlement: { parked: true, ...evidence },
    transition_id: key,
    idempotency_key: key,
    receipt_id: `sidecar-conflict-${digest(event).slice(-16)}`,
    state_from: current.stage,
    state_to: 'held',
    input_digest: digest(event),
  }, opts);
  return { ...persisted, result: 'sidecar-conflict', input_digest: request.input_digest };
}

function reconcileDurableEvents(paths, nonce, current, opts = {}) {
  for (const entry of Object.values(current.transition_receipts)) {
    if (!entry.event) continue;
    try {
      appendEvent(paths.runDir, entry.event);
    } catch {
      return parkSidecarConflict(paths, nonce, current, {
        idempotency_key: entry.idempotency_key,
        input_digest: entry.input_digest,
      }, entry.event, opts);
    }
  }
  return null;
}

function assertTransitionFilesConsistent(paths, current) {
  mkdirSync(paths.transitions, { recursive: true });
  const names = readdirSync(paths.transitions);
  if (names.some((name) => name.endsWith('.pending'))) {
    io('transition-recovery-required', 'a prepared transition receipt must be recovered before mutation');
  }
  for (const entry of Object.values(current.transition_receipts)) {
    const receipt = receiptDocument(entry);
    const file = join(paths.transitions, receiptFileName(receipt));
    if (!existsSync(file)) {
      io('transition-recovery-required', `${basename(file)} must be recovered before mutation`);
    }
    if (canonicalJson(normalizedReceiptFile(file)) !== canonicalJson(receipt)) {
      io('transition-receipt-conflict', `${basename(file)} conflicts with authoritative run state`);
    }
  }
}

export function commitFencedTransition(runDir, request, opts = {}) {
  const paths = runStorePaths(runDir);
  if (request.event) {
    const check = validateIntent(request.event);
    if (!check.ok) invalid('transition-event-invalid', check.errors.join('; '));
  }
  const inputDigest = digest({ input: request.input, event: request.event ?? null });
  const lease = acquireLock(
    { lock: paths.lock, recovery: paths.lockRecovery, lockMutationGuard: paths.lockMutationGuard },
    { timeoutMs: opts.lockTimeoutMs },
  );
  try {
    const current = readFencedRun(runDir); // mandatory post-acquisition reload
    assertFence(paths, lease.nonce);

    if (current.mutation_halted) {
      invalid('mutation-halted', 'the run is parked by conflicting durable evidence');
    }
    assertTransitionFilesConsistent(paths, current);
    const reconciliation = reconcileDurableEvents(paths, lease.nonce, current, opts);
    if (reconciliation) return reconciliation;

    const hasOriginal = Object.hasOwn(current.transition_receipts, request.idempotency_key);
    const original = hasOriginal ? current.transition_receipts[request.idempotency_key] : null;
    if (hasOriginal) {
      if (original.input_digest === inputDigest) {
        return {
          result: 'replayed',
          state: current,
          receipt: receiptDocument(original),
          settlement: clone(original.settlement),
          input_digest: inputDigest,
        };
      }
      return parkReplayConflict(paths, lease.nonce, current, request, inputDigest, original, opts);
    }

    if (!Number.isSafeInteger(request.expected_revision)
      || request.expected_revision !== current.revision) {
      invalid(
        'revision-conflict',
        `expected ${String(request.expected_revision)}, current ${current.revision}`,
      );
    }
    if (!Object.hasOwn(request, 'expected_approval_digest')
      || request.expected_approval_digest !== (current.approval_digest ?? null)) {
      invalid(
        'approval-digest-mismatch',
        `expected ${String(request.expected_approval_digest)}, current ${String(current.approval_digest ?? null)}`,
      );
    }
    if (request.state_from !== current.stage) {
      invalid('state-conflict', `expected ${request.state_from}, current ${String(current.stage)}`);
    }
    if (typeof request.apply !== 'function') invalid('transition-invalid', 'apply must be a function');

    const applied = request.apply(clone(current), clone(request.input));
    if (!applied || typeof applied !== 'object' || !applied.state || !('settlement' in applied)) {
      invalid('transition-invalid', 'apply must return {state, settlement}');
    }
    if (applied.state.driver !== current.driver || applied.state.run_id !== current.run_id) {
      invalid('driver-ownership-conflict', 'a transition cannot change run or driver ownership');
    }
    if (typeof applied.state.stage !== 'string' || applied.state.stage === '') {
      invalid('transition-invalid', 'apply must leave a non-empty durable stage');
    }
    const persisted = persistUnderFence(paths, lease.nonce, current, {
      state: applied.state,
      settlement: applied.settlement,
      transition_id: request.transition_id,
      idempotency_key: request.idempotency_key,
      receipt_id: request.receipt_id,
      state_from: request.state_from,
      state_to: applied.state.stage,
      input_digest: inputDigest,
      event: request.event ?? null,
    }, opts);
    const committed = { ...persisted, result: 'committed', input_digest: inputDigest };

    if (request.event) {
      try {
        appendEvent(runDir, request.event);
      } catch {
        return parkSidecarConflict(paths, lease.nonce, committed.state,
          { ...request, input_digest: inputDigest }, request.event, opts);
      }
    }
    return committed;
  } finally {
    releaseLock(paths, lease.nonce);
  }
}

export function recoverFencedRun(runDir, opts = {}) {
  const paths = runStorePaths(runDir);
  const lease = acquireLock(
    { lock: paths.lock, recovery: paths.lockRecovery, lockMutationGuard: paths.lockMutationGuard },
    { timeoutMs: opts.lockTimeoutMs },
  );
  try {
    let state = readFencedRun(runDir);
    assertFence(paths, lease.nonce);
    mkdirSync(paths.transitions, { recursive: true });
    let changed = false;

    for (const name of readdirSync(paths.transitions).filter((entry) => entry.endsWith('.pending'))) {
      const pendingPath = join(paths.transitions, name);
      let pending;
      try { pending = normalizeTransitionReceipt(JSON.parse(readFileSync(pendingPath, 'utf8'))); }
      catch {
        renameSync(pendingPath, uniqueTransitionRecoveryPath(
          paths.transitionRecovery, `${name}.invalid`,
        ));
        changed = true;
        continue;
      }
      const hasEmbedded = Object.hasOwn(state.transition_receipts, pending.idempotency_key);
      const embedded = hasEmbedded ? state.transition_receipts[pending.idempotency_key] : null;
      if (hasEmbedded && embedded.input_digest === pending.input_digest
        && embedded.result_digest === pending.result_digest) {
        const finalPath = pendingPath.slice(0, -'.pending'.length);
        if (existsSync(finalPath)) {
          const published = normalizedReceiptFile(finalPath);
          if (canonicalJson(published) !== canonicalJson(pending)) {
            io('transition-receipt-conflict', `${basename(finalPath)} conflicts with its prepared receipt`);
          }
          unlinkSync(pendingPath);
        } else renameSync(pendingPath, finalPath);
      } else {
        renameSync(pendingPath, uniqueTransitionRecoveryPath(
          paths.transitionRecovery, `${name}.orphan`,
        ));
      }
      changed = true;
    }

    for (const entry of Object.values(state.transition_receipts)) {
      const receipt = receiptDocument(entry);
      const file = join(paths.transitions, receiptFileName(receipt));
      if (!existsSync(file)) {
        persistJson(file, receipt);
        changed = true;
      } else if (canonicalJson(normalizedReceiptFile(file)) !== canonicalJson(receipt)) {
        io('transition-receipt-conflict', `${basename(file)} conflicts with authoritative run state`);
      }
    }
    if (state.mutation_halted) {
      invalid('mutation-halted', 'the run is parked by conflicting durable evidence');
    }
    const reconciliation = reconcileDurableEvents(paths, lease.nonce, state, opts);
    if (reconciliation) {
      state = reconciliation.state;
      return { result: reconciliation.result, state };
    }
    return { result: changed ? 'recovered' : 'clean', state };
  } finally {
    releaseLock(paths, lease.nonce);
  }
}

export function writeStop(runDir, opts = {}) {
  const paths = runStorePaths(runDir);
  mkdirSync(runDir, { recursive: true });
  const reason = String(opts.reason || 'operator requested').replace(/[\r\n]+/g, ' ');
  writeAtomic(paths.stop, [
    `stopped_at: ${bangkokTimestamp((opts.now || Date.now)())}`,
    `reason: ${reason}`,
    'note: independent signal — the current mutation may finish; no new mutation may begin.',
    '',
  ].join('\n'));
  return paths.stop;
}

export function stopPresent(runDir) {
  return existsSync(runStorePaths(runDir).stop);
}
