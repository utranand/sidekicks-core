// Candidate B's queue-native approval boundary.
//
// `durable-execution/schema.mjs` owns exact execution bindings, approval digests, durable jobs and
// receipts. This module owns only the selected queue driver's document identity. It deliberately
// contains no executor/model/preset registry and performs no runtime transition.

import {
  QUEUE_DRIVER_ID,
  approvalEnvelopeDigest,
  normalizeApprovalEnvelope,
} from '../durable-execution/schema.mjs';

export { QUEUE_DRIVER_ID };

export function buildQueueApprovalEnvelope(value) {
  return normalizeApprovalEnvelope(value);
}

export function queueApprovalDigest(value) {
  return approvalEnvelopeDigest(value);
}
