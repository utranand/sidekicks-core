import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_POLICY_FAMILY,
  bindingDigest,
  freezeDeliveryBinding,
  resolveConfiguredDeliveryPolicy,
  resolveDeliveryPolicy,
  validateDeliveryPolicy,
  validateFrozenBinding,
} from '../index.mjs';

describe('delivery policy resolution', () => {
  test('declares an inheritable whole-block config family', () => {
    assert.deepEqual(DELIVERY_POLICY_FAMILY, {
      family: 'delivery', block: 'multi_cli_execution', scope: 'any', inherits_root: true, merge: 'whole_block',
    });
  });

  test('uses run override, project, inherited root, then native in that order', () => {
    assert.deepEqual(resolveDeliveryPolicy({
      runOverride: 'native', projectPolicy: { mode: 'multi_cli' }, rootPolicy: { mode: 'multi_cli' },
    }), { mode: 'native', source: 'run' });
    assert.deepEqual(resolveDeliveryPolicy({
      projectPolicy: { mode: 'native' }, rootPolicy: { mode: 'multi_cli' },
    }), { mode: 'native', source: 'project' });
    assert.deepEqual(resolveDeliveryPolicy({ rootPolicy: { mode: 'multi_cli' } }), { mode: 'multi_cli', source: 'root' });
    assert.deepEqual(resolveDeliveryPolicy(), { mode: 'native', source: 'default' });
  });

  test('refuses undeclared policy modes and extra policy fields', () => {
    assert.throws(() => validateDeliveryPolicy({ mode: 'external' }), /mode must be one of/);
    assert.throws(() => validateDeliveryPolicy({ mode: 'native', inherits_root: true }), /may contain only/);
    assert.throws(() => resolveDeliveryPolicy({ runOverride: 'external' }), /run override must be one of/);
  });

  test('uses config-store attribution without reimplementing inheritance', () => {
    const read = () => ({ config: { mode: 'multi_cli' }, sources: { mode: 'root-config' } });
    assert.deepEqual(resolveConfiguredDeliveryPolicy('/repo', { read }), { mode: 'multi_cli', source: 'root' });
    assert.deepEqual(resolveConfiguredDeliveryPolicy('/repo', { runOverride: 'native', read }), { mode: 'native', source: 'run' });
  });
});

describe('frozen automated-delivery bindings', () => {
  const binding = {
    mode: 'multi_cli', preset: 'default-build', preset_revision: 'sha256:abc', executor: 'codex',
    model: 'gpt-5', effort: 'high', host: { name: 'claude', source: 'detected' },
  };

  test('preserves concrete routing facts and diagnostic host without using host as a route', () => {
    const frozen = freezeDeliveryBinding(binding);
    assert.deepEqual(frozen, binding);
    assert.ok(Object.isFrozen(frozen));
    assert.ok(Object.isFrozen(frozen.host));
    binding.executor = 'other';
    assert.equal(frozen.executor, 'codex');
  });

  test('accepts a native binding with optional diagnostic host only', () => {
    assert.deepEqual(validateFrozenBinding({ mode: 'native', host: { name: 'codex', source: 'flag' } }), {
      mode: 'native', host: { name: 'codex', source: 'flag' },
    });
  });

  test('rejects partial, ambiguous, and native-routed external bindings', () => {
    assert.throws(() => validateFrozenBinding({ ...binding, model: '' }), /binding.model must be a non-empty string/);
    assert.throws(() => validateFrozenBinding({ ...binding, tier: 'high' }), /unsupported field 'tier'/);
    assert.throws(() => validateFrozenBinding({ mode: 'native', executor: 'codex' }), /native binding must not declare executor/);
    assert.throws(() => validateFrozenBinding({ ...binding, host: { name: 'codex' } }), /binding.host.source must be a non-empty string/);
  });

  test('canonical digest changes with any frozen execution field but ignores diagnostic host', () => {
    const base = bindingDigest(binding);
    assert.equal(base, bindingDigest({ ...binding, host: { name: 'other-host', source: 'flag' } }));
    assert.equal(base, bindingDigest({ ...binding, host: null }));
    for (const change of [
      { preset: 'other-preset' },
      { preset_revision: 'sha256:def' },
      { executor: 'claude' },
      { model: 'gpt-5-mini' },
      { effort: 'low' },
    ]) {
      assert.notEqual(bindingDigest({ ...binding, ...change }), base);
    }
    assert.equal(bindingDigest({ mode: 'native' }), bindingDigest({ mode: 'native', host: { name: 'x', source: 'flag' } }));
    assert.notEqual(bindingDigest({ mode: 'native' }), base);
  });
});
