// sk-publish-core must seed the runtime's own configuration registry rather than copying source values.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceFixture } from './_source-fixture.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const engine = join(repoRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');
const registry = join(mkdtempSync(join(tmpdir(), 'sk-publish-core-config-registry-')), 'runtimes.json');
const env = { ...process.env, SIDEKICKS_INHERIT_REGISTRY: registry };
const name = 'runtime-config-test';
let base;
let target;
let fixture;

function inherit(...args) {
  return spawnSync(process.execPath, [engine, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function runtimeCli(...args) {
  return spawnSync(process.execPath, [join(target, 'bin', 'sidekicks'), ...args], {
    cwd: target, encoding: 'utf8',
  });
}

before(() => {
  fixture = sourceFixture(repoRoot, {
    'sk-jira-connector': {
      'skill.yaml': 'skill: sk-jira-connector\nconfig:\n  block: jira\n  family: jira\n  defaults: config.defaults.yaml\n',
      'config.defaults.yaml': 'jira: {}\n',
    },
    'sk-slack-connector': {
      'skill.yaml': 'skill: sk-slack-connector\nconfig:\n  block: slack\n  family: comms\n  defaults: config.defaults.yaml\n',
      'config.defaults.yaml': 'slack: {}\n',
    },
  });
  env.SIDEKICKS_TEST_PROJECTION_SOURCE = fixture.root;
  base = mkdtempSync(join(tmpdir(), 'sk-publish-core-config-'));
  target = join(base, 'runtime');
  const result = inherit('create', '--name', name, '--target', target,
    '--skills', 'sk-jira-connector', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(result.status, 0, `forge failed:\n${result.stdout}\n${result.stderr}`);
});

after(() => {
  inherit('forget', '--name', name);
  rmSync(base, { recursive: true, force: true });
  rmSync(dirname(registry), { recursive: true, force: true });
  fixture?.cleanup();
});

test('create prepares inert family templates for carried skills', () => {
  const family = join(target, '.sidekicks', 'config', 'jira.yaml');
  assert.ok(existsSync(family), 'the carried jira connector must seed its committed family file');
  assert.match(readFileSync(family, 'utf8'), /^# jira:/m, 'the jira block must remain inert');
  assert.doesNotMatch(readFileSync(family, 'utf8'), /^jira:/m, 'no live source value may travel');

  const check = runtimeCli('config', 'sync', '--check', '--json');
  assert.equal(check.status, 0, `fresh runtime config is incomplete:\n${check.stdout}\n${check.stderr}`);
});

test('add seeds new skill configuration without overwriting existing runtime values', () => {
  const jira = join(target, '.sidekicks', 'config', 'jira.yaml');
  const live = readFileSync(jira, 'utf8').replace('# jira: {}', 'jira:\n  url: https://runtime.example.invalid');
  writeFileSync(jira, live);

  const result = inherit('add', '--name', name, '--skills', 'sk-slack-connector', '--no-venv');
  assert.equal(result.status, 0, `add failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(readFileSync(jira, 'utf8'), live, 'config sync must preserve a runtime-owned live block');

  const comms = join(target, '.sidekicks', 'config', 'comms.yaml');
  assert.ok(existsSync(comms), 'adding slack must create its comms family file');
  assert.match(readFileSync(comms, 'utf8'), /^# slack:/m, 'new block must be inert');
});

test('verify reports a missing generated configuration block with its repair command', () => {
  const jira = join(target, '.sidekicks', 'config', 'jira.yaml');
  rmSync(jira);
  const result = inherit('verify', '--name', name);
  assert.equal(result.status, 12, `verify should fail when config scaffolding is missing:\n${result.stdout}`);
  assert.match(result.stdout, /runtime configuration templates are incomplete/);
  assert.match(result.stdout, /node bin\/sidekicks config sync/);
});
