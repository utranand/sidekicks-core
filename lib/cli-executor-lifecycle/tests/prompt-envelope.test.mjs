import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_ENVELOPE_SCHEMA_VERSION,
  normalizePromptEnvelope,
  promptEnvelopeDigest,
  renderPromptEnvelope,
} from '../prompt-envelope.mjs';

const BINDING = {
  mode: 'multi_cli', preset: 'default-build', preset_revision: 'sha256:rev1',
  executor: 'codex', model: 'gpt-5', effort: 'high',
  host: { name: 'claude', source: 'detected' },
};

const ENVELOPE = {
  schema_version: PROMPT_ENVELOPE_SCHEMA_VERSION,
  step_id: 'step-7',
  objective: 'repair the retry path in the bedrock client',
  scope: { project: 'sidekicks', service: 'bedrock-llm' },
  work_dir: 'lib/cli-executor-lifecycle',
  allowed_write_roots: ['lib/cli-executor-lifecycle', 'lib/cli-executor-lifecycle/tests'],
  criteria: ['equivalent approved inputs render byte-identical envelopes', 'absolute paths are rejected'],
  verification: ['run node --test lib/cli-executor-lifecycle/tests/prompt-envelope.test.mjs'],
  constraints: ['no redesign of the existing module'],
  non_goals: ['executor discovery'],
  dependencies: ['lib/delivery-policy'],
  handoff_artifacts: ['artifacts/runs/step-7/envelope.md'],
  branch: 'fix/step-7-retry',
  base_revision: 'a2bbcf61',
  binding: BINDING,
};

// Key order reversed so a deterministic renderer must not depend on caller ordering.
function shuffled(input) {
  const out = {};
  for (const key of Object.keys(input).reverse()) out[key] = input[key];
  return out;
}

describe('prompt envelope normalization', () => {
  test('normalizes a multi_cli envelope into a frozen canonical form', () => {
    const norm = normalizePromptEnvelope(ENVELOPE);
    assert.equal(norm.schema_version, PROMPT_ENVELOPE_SCHEMA_VERSION);
    assert.equal(norm.step_id, 'step-7');
    assert.equal(norm.branch, 'fix/step-7-retry');
    assert.equal(norm.base_revision, 'a2bbcf61');
    assert.deepEqual(norm.scope, { project: 'sidekicks', service: 'bedrock-llm' });
    assert.ok(Object.isFrozen(norm) && Object.isFrozen(norm.binding) && Object.isFrozen(norm.scope));
    assert.equal(norm.binding.host.name, 'claude');
  });

  test('is idempotent: re-normalizing a normalized envelope is a no-op', () => {
    const once = normalizePromptEnvelope(ENVELOPE);
    const twice = normalizePromptEnvelope(once);
    assert.deepEqual(twice, once);
    assert.equal(promptEnvelopeDigest(twice), promptEnvelopeDigest(once));
  });

  test('fills optional list fields as empty and drops absent optional strings', () => {
    const { constraints, non_goals, dependencies, handoff_artifacts, branch, base_revision, ...minimal } = ENVELOPE;
    const norm = normalizePromptEnvelope(minimal);
    assert.deepEqual(norm.constraints, []);
    assert.deepEqual(norm.non_goals, []);
    assert.deepEqual(norm.dependencies, []);
    assert.deepEqual(norm.handoff_artifacts, []);
    assert.equal(norm.branch, undefined);
    assert.equal(norm.base_revision, undefined);
  });

  test('rejects unsupported fields, empty required lists, and non-string scope values', () => {
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, api_key: 'x' }), /unsupported field 'api_key'/);
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, criteria: [] }), /criteria must be a non-empty list/);
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, verification: [] }), /verification must be a non-empty list/);
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, allowed_write_roots: [] }), /allowed_write_roots must be a non-empty list/);
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, scope: { project: 7 } }), /scope.project must be a non-empty string/);
  });

  test('refuses anything but a multi_cli binding', () => {
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, binding: { mode: 'native' } }), /must be a multi_cli binding/);
  });

  test('rejects absolute paths anywhere a persisted path is allowed', () => {
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, work_dir: '/Users/someone/code' }), /work_dir must be repo-relative/);
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, work_dir: 'C:\\proj\\code' }), /work_dir must be repo-relative/);
    assert.throws(() => normalizePromptEnvelope({ ...ENVELOPE, work_dir: '\\\\server\\share' }), /work_dir must be repo-relative/);
    assert.throws(
      () => normalizePromptEnvelope({ ...ENVELOPE, allowed_write_roots: ['lib/a', '/etc/passwd'] }),
      /allowed_write_roots entry must be repo-relative/,
    );
    assert.throws(
      () => normalizePromptEnvelope({ ...ENVELOPE, handoff_artifacts: ['/abs/artifact.md'] }),
      /handoff_artifacts entry must be repo-relative/,
    );
  });

  test('rejects secret-bearing field names and credential-looking values', () => {
    assert.throws(
      () => normalizePromptEnvelope({ ...ENVELOPE, scope: { project: 'sidekicks', db_password: 'hunter2' } }),
      /looks like a secret-bearing field/,
    );
    assert.throws(
      () => normalizePromptEnvelope({ ...ENVELOPE, objective: 'call the api with sk-abcdefghijklmnopqrstuvwxyz123456' }),
      /credential-looking value/,
    );
    assert.throws(
      () => normalizePromptEnvelope({ ...ENVELOPE, criteria: ['key AKIAIOSFODNN7EXAMPLE rotates daily'] }),
      /credential-looking value/,
    );
    assert.throws(
      () => normalizePromptEnvelope({ ...ENVELOPE, verification: ['token ghp_abcdefghij0123456789abcd present'] }),
      /credential-looking value/,
    );
  });

  test('allows ordinary prose that merely mentions secret words', () => {
    const norm = normalizePromptEnvelope({
      ...ENVELOPE,
      objective: 'rotate the API token and refresh the access key reference in the docs',
    });
    assert.match(norm.objective, /API token/);
  });
});

describe('prompt envelope framing digest', () => {
  test('is stable across key order and diagnostic host changes', () => {
    const base = promptEnvelopeDigest(ENVELOPE);
    assert.equal(base, promptEnvelopeDigest(shuffled(ENVELOPE)));
    const hostChanged = structuredClone(ENVELOPE);
    hostChanged.binding.host = { name: 'gemini', source: 'flag' };
    assert.equal(base, promptEnvelopeDigest(hostChanged));
    const hostDropped = structuredClone(ENVELOPE);
    delete hostDropped.binding.host;
    assert.equal(base, promptEnvelopeDigest(hostDropped));
  });

  test('changes with any changed executor, model, effort, scope, or criterion', () => {
    const base = promptEnvelopeDigest(ENVELOPE);
    const changes = [
      ['executor', { binding: { ...BINDING, executor: 'claude' } }],
      ['model', { binding: { ...BINDING, model: 'gpt-5-mini' } }],
      ['effort', { binding: { ...BINDING, effort: 'low' } }],
      ['effort to default', { binding: { ...BINDING, effort: null } }],
      ['scope', { scope: { project: 'sidekicks', service: 'other-svc' } }],
      ['criterion', { criteria: ['equivalent approved inputs render byte-identical envelopes (changed)'] }],
      ['verification', { verification: ['run the tests twice'] }],
      ['write roots', { allowed_write_roots: ['lib/cli-executor-lifecycle'] }],
      ['preset', { binding: { ...BINDING, preset: 'other-preset' } }],
      ['preset revision', { binding: { ...BINDING, preset_revision: 'sha256:rev2' } }],
      ['objective', { objective: 'repair the retry path differently' }],
    ];
    for (const [name, patch] of changes) {
      assert.notEqual(promptEnvelopeDigest({ ...ENVELOPE, ...patch }), base, `digest must change for ${name}`);
    }
  });
});

describe('prompt envelope rendering', () => {
  test('renders byte-identical bytes for equivalent approved inputs', () => {
    const a = renderPromptEnvelope(ENVELOPE);
    const b = renderPromptEnvelope(shuffled(ENVELOPE));
    const hostChanged = structuredClone(ENVELOPE);
    hostChanged.binding.host = { name: 'antigravity', source: 'detected' };
    assert.equal(a, b);
    assert.equal(a, renderPromptEnvelope(hostChanged));
    assert.ok(a.endsWith('\n'));
  });

  test('carries the step id, write roots, criteria, verification, binding, and report-back contract', () => {
    const text = renderPromptEnvelope(ENVELOPE);
    assert.match(text, /^step: step-7$/m);
    assert.match(text, /^framing_digest: sha256:[0-9a-f]{64}$/m);
    assert.match(text, /^- lib\/cli-executor-lifecycle$/m);
    assert.match(text, /^- lib\/cli-executor-lifecycle\/tests$/m);
    assert.match(text, /^1\. equivalent approved inputs render byte-identical envelopes$/m);
    assert.match(text, /^1\. run node --test lib\/cli-executor-lifecycle\/tests\/prompt-envelope\.test\.mjs$/m);
    assert.match(text, /^executor: codex$/m);
    assert.match(text, /^model: gpt-5$/m);
    assert.match(text, /^effort: high$/m);
    assert.match(text, /^preset: default-build \(revision sha256:rev1\)$/m);
    assert.match(text, /^binding_digest: sha256:[0-9a-f]{64}$/m);
    assert.match(text, /^- end with exactly one final status: done, needs-review, or failed$/m);
    assert.match(text, /^- surface blockers and any required human gate verbatim; never skip a gate$/m);
  });

  test('renders scope keys deterministically and omits absent optional sections', () => {
    const { constraints, non_goals, dependencies, handoff_artifacts, branch, base_revision, ...minimal } = ENVELOPE;
    const text = renderPromptEnvelope(minimal);
    assert.match(text, /^project: sidekicks\nservice: bedrock-llm$/m);
    assert.doesNotMatch(text, /## Base/);
    assert.doesNotMatch(text, /## Constraints/);
    assert.doesNotMatch(text, /## Non-Goals/);
    assert.doesNotMatch(text, /## Dependencies/);
    assert.doesNotMatch(text, /## Handoff Artifacts/);
    assert.match(text, /## Binding/);
    assert.match(text, /## Report Back/);
  });

  test('renders an absent effort as default while keeping the digest stable', () => {
    const noEffort = structuredClone(ENVELOPE);
    delete noEffort.binding.effort;
    assert.match(renderPromptEnvelope(noEffort), /^effort: default$/m);
    const explicit = structuredClone(ENVELOPE);
    explicit.binding.effort = null;
    assert.equal(promptEnvelopeDigest(noEffort), promptEnvelopeDigest(explicit));
  });

  test('the rendered framing_digest is the digest of the normalized framing', () => {
    const text = renderPromptEnvelope(ENVELOPE);
    const rendered = text.match(/^framing_digest: (sha256:[0-9a-f]{64})$/m);
    assert.ok(rendered, 'framing_digest line present');
    assert.equal(rendered[1], promptEnvelopeDigest(normalizePromptEnvelope(ENVELOPE)));
  });

  test('rendering enforces the same safety rejections as normalization', () => {
    assert.throws(() => renderPromptEnvelope({ ...ENVELOPE, work_dir: '/abs' }), /repo-relative/);
    assert.throws(
      () => renderPromptEnvelope({ ...ENVELOPE, scope: { project: 'sidekicks', api_key: 'x' } }),
      /secret-bearing field/,
    );
  });
});
