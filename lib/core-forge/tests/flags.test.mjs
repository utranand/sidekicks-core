import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoreFlags } from '../../core-lifecycle/_shared.mjs';
import { EXIT_USAGE } from '../../sk-cli/errors.mjs';

const booleans = ['yes', 'allow-protected', 'force', 'dry-run'];
const parse = argv => parseCoreFlags(argv, booleans);
const invalid = argv => assert.throws(() => parse(argv), error => error.exitCode === EXIT_USAGE);

test('explicit false never grants release, protected-write or overwrite consent', () => {
  assert.deepEqual(parse(['--yes=false', '--allow-protected=false', '--force=false']),
    { yes: false, 'allow-protected': false, force: false });
  assert.deepEqual(parse(['--yes', '--allow-protected=true', '--dry-run=true']),
    { yes: true, 'allow-protected': true, 'dry-run': true });
});

test('boolean equals syntax rejects empty or nonliteral values', () => {
  for (const value of ['', '0', '1', 'no', 'yes', 'False', 'TRUE', 'false=extra']) {
    invalid(['--yes=' + value]);
  }
});

test('contradictory repeats cannot silently reverse consent regardless of ordering', () => {
  for (const flag of booleans) {
    invalid(['--' + flag + '=false', '--' + flag]);
    invalid(['--' + flag, '--' + flag + '=false']);
    assert.equal(parse(['--' + flag + '=false', '--' + flag + '=false'])[flag], false);
    assert.equal(parse(['--' + flag, '--' + flag + '=true'])[flag], true);
  }
});

test('detached boolean literals are rejected rather than ignored as consent', () => {
  invalid(['--yes', 'false']);
  invalid(['--allow-protected', 'true']);
});

test('value flags retain their existing equals and separate-value contracts', () => {
  assert.deepEqual(parse(['--target', 'a folder', '--name=false', '--version=1.2.3', '--yes=false']),
    { target: 'a folder', name: 'false', version: '1.2.3', yes: false });
});
