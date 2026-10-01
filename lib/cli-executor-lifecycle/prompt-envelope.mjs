// lib/cli-executor-lifecycle/prompt-envelope.mjs
//
// Phase 2 of the automated multi-CLI execution mode: deterministic prompt compilation.
//
// Compiles one approved implementation step plus the parent's FROZEN delivery binding into an
// immutable prompt envelope with a canonical framing digest.  Parent engines compare a persisted
// approval's framing digest against the prompt they are about to dispatch (a mismatch parks the
// step for re-approval), and attempt records pin the digest to each external invocation so a
// resumed run can prove which approved prompt it is executing.
//
// This module is pure and provider-neutral: it reads no config, resolves no executor, and never
// alters the frozen binding.  The binding arrives already validated by `delivery-policy`; only
// a `multi_cli` binding may carry an executor prompt.

import { createHash } from 'node:crypto';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { bindingDigest, validateFrozenBinding } from '../delivery-policy/policy.mjs';

export const PROMPT_ENVELOPE_SCHEMA_VERSION = 1;

const LIST_FIELDS = Object.freeze(['constraints', 'non_goals', 'dependencies', 'handoff_artifacts']);
const ALL_FIELDS = Object.freeze([
  'schema_version', 'step_id', 'objective', 'scope', 'work_dir', 'branch', 'base_revision',
  'allowed_write_roots', 'criteria', 'verification', ...LIST_FIELDS, 'binding',
]);

// Field names that must never cross into a compiled prompt.  The check is name-based, so
// ordinary prose that merely MENTIONS one of these words (e.g. "rotate the API token") is
// still allowed in objective/criteria; the value patterns below catch the credentials themselves.
const SECRET_FIELD_RE = /(secret|token|password|passwd|credential|api_?key|access_?key|private_?key)/i;

// High-confidence credential shapes.  Deliberately narrow: these never appear in acceptance
// criteria or verification instructions, so a hit is a redaction failure, not a false positive.
const CREDENTIAL_VALUE_RES = Object.freeze([
  /AKIA[0-9A-Z]{16}/,                       // AWS access key id
  /\bsk-[A-Za-z0-9_-]{20,}\b/,              // OpenAI-style API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,         // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,       // Slack token
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,   // Authorization header value
]);

// The report-back contract every compiled prompt carries verbatim: the child's run report is the
// parent's only window into the external run, so its shape is part of the framing.
const REPORT_BACK_LINES = Object.freeze([
  'list every changed file as a repo-relative path',
  'record the commands you ran and their outcomes',
  'report the result against each acceptance criterion',
  'surface blockers and any required human gate verbatim; never skip a gate',
  'end with exactly one final status: done, needs-review, or failed',
]);

function invalid(message) {
  throw new SidekicksError(`prompt envelope: ${message}`, EXIT_VALIDATION);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, label);
}

function stringList(value, label, { required = false } = {}) {
  if (value === undefined || value === null) value = [];
  if (!Array.isArray(value)) invalid(`${label} must be a list of strings`);
  const list = value.map((item) => requiredString(item, `${label} entry`));
  if (required && list.length === 0) invalid(`${label} must be a non-empty list of strings`);
  return list;
}

function pathList(value, label, { required = false } = {}) {
  const list = stringList(value, label, { required });
  return list.map((item) => repoRelativePath(item, `${label} entry`));
}

// Persisted envelope paths are repo-relative by contract: an absolute path would leak the
// dispatching machine's layout into a prompt that may be re-dispatched from another host.
function repoRelativePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${label} must be a non-empty repo-relative path`);
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    invalid(`${label} must be repo-relative, got the absolute path '${value}'`);
  }
  return value;
}

function scopeObject(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) invalid('scope must be a non-empty object of strings');
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = requiredString(item, `scope.${key}`);
  }
  return out;
}

function assertNoSecrets(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${label}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD_RE.test(key)) invalid(`${label}.${key} looks like a secret-bearing field; redact it before compiling`);
      assertNoSecrets(item, `${label}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && CREDENTIAL_VALUE_RES.some((re) => re.test(value))) {
    invalid(`${label} contains a credential-looking value; redact it before compiling`);
  }
}

function deepFreeze(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  Object.freeze(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item);
  return value;
}

/**
 * Validate and normalize an approved step into the canonical envelope form.  Idempotent:
 * re-normalizing a normalized envelope returns an equal one, which is what makes "equivalent
 * approved inputs" render identically regardless of how the caller ordered its keys.
 */
export function normalizePromptEnvelope(input) {
  if (!isPlainObject(input)) invalid('envelope must be an object');
  const unknown = Object.keys(input).find((key) => !ALL_FIELDS.includes(key));
  if (unknown) invalid(`envelope contains unsupported field '${unknown}'`);
  assertNoSecrets(input, 'envelope');

  let schema_version = PROMPT_ENVELOPE_SCHEMA_VERSION;
  if (input.schema_version !== undefined) {
    if (input.schema_version !== PROMPT_ENVELOPE_SCHEMA_VERSION) invalid(`schema_version must be ${PROMPT_ENVELOPE_SCHEMA_VERSION}`);
    schema_version = input.schema_version;
  }

  const binding = validateFrozenBinding(input.binding);
  if (binding.mode !== 'multi_cli') invalid('envelope binding must be a multi_cli binding');

  const out = {
    schema_version,
    step_id: requiredString(input.step_id, 'step_id'),
    objective: requiredString(input.objective, 'objective'),
    scope: scopeObject(input.scope),
    work_dir: repoRelativePath(input.work_dir, 'work_dir'),
    allowed_write_roots: pathList(input.allowed_write_roots, 'allowed_write_roots', { required: true }),
    criteria: stringList(input.criteria, 'criteria', { required: true }),
    verification: stringList(input.verification, 'verification', { required: true }),
    constraints: stringList(input.constraints, 'constraints'),
    non_goals: stringList(input.non_goals, 'non_goals'),
    dependencies: stringList(input.dependencies, 'dependencies'),
    handoff_artifacts: pathList(input.handoff_artifacts, 'handoff_artifacts'),
    binding,
  };
  const branch = optionalString(input.branch, 'branch');
  const base_revision = optionalString(input.base_revision, 'base_revision');
  if (branch !== undefined) out.branch = branch;
  if (base_revision !== undefined) out.base_revision = base_revision;
  return deepFreeze(out);
}

/**
 * Canonical framing digest of an envelope: the whole normalized framing plus the binding's
 * EXECUTION digest (which already excludes the diagnostic `host`), so re-detecting the host CLI
 cannot invalidate an otherwise-unchanged approval while a changed executor, model, effort,
 * scope, criterion or any other framing field always produces a different digest.
 */
export function promptEnvelopeDigest(envelope) {
  const e = normalizePromptEnvelope(envelope);
  const framing = { ...e, binding: bindingDigest(e.binding) };
  return `sha256:${createHash('sha256').update(canonicalJson(framing), 'utf8').digest('hex')}`;
}

/**
 * Render the byte-stable prompt text for one envelope.  Deterministic in the normalized
 * framing: equivalent inputs (same content, any key order, any host diagnostic) render to
 * identical bytes, and the emitted framing_digest is the digest of those exact bytes' source.
 */
export function renderPromptEnvelope(envelope) {
  const e = normalizePromptEnvelope(envelope);
  const digest = promptEnvelopeDigest(e);
  const lines = [];
  const push = (line = '') => lines.push(line);
  const section = (title, bodyLines) => {
    if (!bodyLines.length) return;
    push(title);
    for (const line of bodyLines) push(line);
    push();
  };

  push(`# Prompt Envelope v${e.schema_version}`);
  push(`step: ${e.step_id}`);
  push(`framing_digest: ${digest}`);
  push();
  push('## Objective');
  push(e.objective);
  push();
  push('## Scope');
  for (const key of Object.keys(e.scope).sort()) push(`${key}: ${e.scope[key]}`);
  push();
  push('## Working Directory');
  push(e.work_dir);
  push();
  push('## Allowed Write Roots');
  for (const root of e.allowed_write_roots) push(`- ${root}`);
  section('## Base', [
    e.branch !== undefined ? `branch: ${e.branch}` : null,
    e.base_revision !== undefined ? `base_revision: ${e.base_revision}` : null,
  ].filter(Boolean));
  push('## Acceptance Criteria');
  e.criteria.forEach((criterion, index) => push(`${index + 1}. ${criterion}`));
  push();
  push('## Verification');
  e.verification.forEach((instruction, index) => push(`${index + 1}. ${instruction}`));
  push();
  section('## Constraints', e.constraints.map((item) => `- ${item}`));
  section('## Non-Goals', e.non_goals.map((item) => `- ${item}`));
  section('## Dependencies', e.dependencies.map((item) => `- ${item}`));
  section('## Handoff Artifacts', e.handoff_artifacts.map((item) => `- ${item}`));
  const b = e.binding;
  push('## Binding');
  push(`executor: ${b.executor}`);
  push(`model: ${b.model}`);
  push(`effort: ${b.effort ?? 'default'}`);
  push(`preset: ${b.preset} (revision ${b.preset_revision})`);
  push(`binding_digest: ${bindingDigest(b)}`);
  push();
  push('## Report Back');
  for (const line of REPORT_BACK_LINES) push(`- ${line}`);
  return lines.join('\n') + '\n';
}
