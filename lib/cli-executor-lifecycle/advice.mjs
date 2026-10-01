// Shared advisory answer contract. Recovery suggestions are evidence-bound data, never authority
// to dispatch, approve, amend an envelope, or spend an extra attempt.
import { findAbsolutePath } from '../run-events/schema.mjs';
export const ADVICE_PURPOSES = Object.freeze(['plan-advice', 'solution-advice', 'recovery-advice']);
export const RECOVERY_KINDS = Object.freeze(['correct-plan', 'retry-same-seat', 'inspect-evidence', 'ask-user']);
export const RECOVERY_FAILURE_KINDS = Object.freeze(['planner-invalid', 'plan-review-blocking',
  'implementation-failed', 'review-rejected', 'review-unusable']);

export function validateRecoveryFacts(facts) {
  return Boolean(facts && typeof facts === 'object' && !Array.isArray(facts)
    && ['planning', 'execution'].includes(facts.phase)
    && RECOVERY_FAILURE_KINDS.includes(facts.failure_kind)
    && typeof facts.reason === 'string' && facts.reason.trim() && !findAbsolutePath(facts.reason)
    && Array.isArray(facts.artifact_refs) && facts.artifact_refs.length >= 1
    && facts.artifact_refs.length <= 8
    && facts.artifact_refs.every((ref) => typeof ref === 'string' && ref.trim()
      && !ref.startsWith('/') && !ref.includes('..') && !ref.includes('\\')));
}

export const RECOVERY_ADVICE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['alternatives', 'recommended_id'],
  properties: {
    alternatives: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'kind', 'summary', 'evidence_refs'],
      properties: {
        id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        kind: { type: 'string', enum: [...RECOVERY_KINDS] },
        summary: { type: 'string', minLength: 1, maxLength: 500 },
        evidence_refs: { type: 'array', minItems: 1, maxItems: 8,
          items: { type: 'string', minLength: 1 } },
      },
    } },
    recommended_id: { type: 'string' },
  },
});

export function validateRecoveryAdvice(value, allowedRefs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.alternatives) || value.alternatives.length < 1
      || value.alternatives.length > 3 || typeof value.recommended_id !== 'string') {
    return { ok: false, reason: 'recovery advice needs 1-3 alternatives and recommended_id' };
  }
  const refs = new Set(allowedRefs);
  const ids = new Set();
  for (const alt of value.alternatives) {
    if (!alt || typeof alt !== 'object' || Array.isArray(alt)
        || Object.keys(alt).some((key) => !['id', 'kind', 'summary', 'evidence_refs'].includes(key))
        || typeof alt.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(alt.id)
        || ids.has(alt.id) || !RECOVERY_KINDS.includes(alt.kind)
        || typeof alt.summary !== 'string' || !alt.summary.trim() || alt.summary.length > 500
        || findAbsolutePath(alt.summary)
        || !Array.isArray(alt.evidence_refs) || alt.evidence_refs.length < 1
        || alt.evidence_refs.length > 8 || alt.evidence_refs.some((ref) => !refs.has(ref))) {
      return { ok: false, reason: 'recovery alternative is malformed or cites unknown evidence' };
    }
    ids.add(alt.id);
  }
  if (!ids.has(value.recommended_id) || Object.keys(value).some((key) => !['alternatives', 'recommended_id'].includes(key))) {
    return { ok: false, reason: 'recommended_id must name exactly one supplied alternative' };
  }
  return { ok: true, recommendation: value.alternatives.find((alt) => alt.id === value.recommended_id) };
}
