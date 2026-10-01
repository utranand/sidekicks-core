// Node-owned compatibility boundary for every queue mutation class known in Phase 2.
// CLI wiring and worker launch are intentionally absent until their owning later phases.

import { createHash } from 'node:crypto';

import { commitFencedTransition } from '../durable-execution/store.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { applyQueueMutation } from './state-machine.mjs';

function receiptId(idempotencyKey) {
  return `transition-${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex').slice(0, 20)}`;
}

export function terminalIdempotencyKey(attemptId) {
  return `finish-attempt/${createHash('sha256').update(String(attemptId), 'utf8').digest('hex')}`;
}

export function commitQueueMutation(runDir, command, opts = {}) {
  const idempotencyKey = command.input?.kind === 'finish-attempt'
    ? terminalIdempotencyKey(command.input.attempt_id)
    : command.idempotency_key;
  if (command.idempotency_key !== idempotencyKey) {
    throw new SidekicksError(
      `[queue-idempotency-key-mismatch] expected ${idempotencyKey}`,
      EXIT_VALIDATION,
    );
  }
  return commitFencedTransition(runDir, {
    expected_revision: command.expected_revision,
    expected_approval_digest: command.expected_approval_digest,
    idempotency_key: idempotencyKey,
    transition_id: command.transition_id || idempotencyKey,
    receipt_id: command.receipt_id || receiptId(idempotencyKey),
    state_from: command.input?.from,
    state_to: command.input?.to,
    input: command.input,
    apply: applyQueueMutation,
    ...(command.event ? { event: command.event } : {}),
  }, opts);
}
