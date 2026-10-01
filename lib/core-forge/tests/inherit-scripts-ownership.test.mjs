// tests/skills/inherit-scripts-ownership.test.mjs
//
// Root scripts travel completely; hook ACTIVATION remains ownership-aware.
//
// The v1.1.0 framework core shipped 17 scripts/ files no shipped skill owned: 7 orphan hook
// scripts that stayed wired and enabled in consumer workspaces, plus build residue. These tests
// pin the fix end to end on a real forge:
//   - every root script travels, including dormant scripts for optional skills
//   - scripts/lib/ (hook-gate.mjs) always travels, so runtime hooks stay gateable
//   - hook wiring for absent owners is pruned from every per-CLI config
//   - the forged runtime's own `framework doctor` is green (owner-absent hooks tolerated)
//   - `inherit verify` fails on changed/missing projected payload and passes on a clean one
//   - `inherit add` re-registers the new skill's scripts and restores its wiring

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceFixture } from './_source-fixture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const engine = join(repoRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');

const RUNTIME_NAME = 'aap111-ownership-test';
const CONFIGS = ['.claude/settings.json', '.codex/config.toml', '.agent/settings.json'];

// Owner-bearing hook scripts (core-registry.mjs) — none of their owners is selected below.
const ORPHAN_HOOK_SCRIPTS = [
  'recompile-validation-checklist.mjs',
  'artifact-autotrigger-hook.mjs',
  'fable-escalation-hook.mjs',
  'gtd-orphan-watch-hook.mjs',
  'run-notify-hook.mjs',
  'office-viz-hook.mjs',
  'artifact-liveness-hook.mjs',
];

// Framework-floor hook scripts (owners: []) — always travel.
const FLOOR_HOOK_SCRIPTS = [
  'skill-advisor-hook.mjs',
  'enforce-local-memory.mjs',
  'enforce-db-offload.mjs',
  'enforce-flow-headful.mjs',
  'enhance-prompt-hook.mjs',
  'load-local-memory-hook.mjs',
];

// Residue / absent-owner extras the v1.1.0 core wrongly shipped.
const RESIDUE = [
  'start-john.sh', 'webmcp-demo.mjs', 'office-viz-demo-loop.mjs',
  'office-viz-demo-subagents.mjs', 'agent-office-viz.mjs',
  'agent-tray.sh', 'start-agent-delegate.sh',
  'install-delegate-launchagent.sh', 'uninstall-delegate-launchagent.sh',
];

// The runtime registry is ONE shared file resolved from the source repo, so without this
// override every run of this suite mutates the developer's real
// artifacts/runs/inherit/runtimes.json — and `node --test` runs these files in parallel, which
// is precisely the concurrent read-modify-write that lost entries and made the gate flaky.
// The override moves the leaf path only; the engine's real registry code still runs.
const REGISTRY = join(mkdtempSync(join(tmpdir(), 'sk-publish-core-registry-')), 'runtimes.json');
const ENGINE_ENV = { ...process.env, SIDEKICKS_INHERIT_REGISTRY: REGISTRY };

function inherit(...args) {
  const r = spawnSync(process.execPath, [engine, ...args], { cwd: repoRoot, encoding: 'utf8', env: ENGINE_ENV });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

let target;   // forged once, shared read-only by the payload/wiring/doctor/verify tests
let fixture;

before(() => {
  fixture = sourceFixture(repoRoot, {
    'sk-slack-connector': {
      'skill.yaml': 'skill: sk-slack-connector\nhooks:\n  - hook.run-notify\nconfig:\n  block: slack\n  family: comms\n  defaults: config.defaults.yaml\n',
      'config.defaults.yaml': 'slack: {}\n',
    },
  });
  ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = fixture.root;
  // Plant both an optional carried owner and an absent owner in every host's source wiring.
  // A previously forged source has already pruned them, so relying on its live config is vacuous.
  for (const rel of ['.claude/settings.json', '.agent/settings.json']) {
    const path = join(fixture.root, ...rel.split('/'));
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.hooks ??= {};
    config.hooks.UserPromptSubmit ??= [];
    config.hooks.UserPromptSubmit.push({ hooks: ['run-notify-hook.mjs', 'office-viz-hook.mjs']
      .map(script => ({ type: 'command', command: `node scripts/${script}` })) });
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  }
  const codex = join(fixture.root, '.codex', 'config.toml');
  writeFileSync(codex, readFileSync(codex, 'utf8')
    + '\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "node scripts/run-notify-hook.mjs"\n'
    + '\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "node scripts/office-viz-hook.mjs"\n');
  target = join(mkdtempSync(join(tmpdir(), 'sk-aap111-')), 'rt');
  // sk-hello claims install-hooks.mjs + setup-windows.mjs; sk-config-doctor claims
  // send-mail.py. Neither owns any of the 7 owner-bearing hooks.
  const r = inherit('create', '--name', RUNTIME_NAME, '--target', target,
    '--skills', 'sk-hello,sk-config-doctor', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(r.status, 0, `forge failed:\n${r.stdout}\n${r.stderr}`);
});

after(() => {
  inherit('forget', '--name', RUNTIME_NAME);
  rmSync(dirname(target), { recursive: true, force: true });
  fixture?.cleanup();
});

test('forge payload: every root script travels, including dormant optional scripts', () => {
  for (const f of FLOOR_HOOK_SCRIPTS) {
    assert.ok(existsSync(join(target, 'scripts', f)), `floor hook must travel: scripts/${f}`);
  }
  assert.ok(existsSync(join(target, 'scripts', 'lib', 'hook-gate.mjs')),
    'scripts/lib/hook-gate.mjs must travel — without it runtime hooks cannot be gated');
  for (const f of ['install-hooks.mjs', 'setup-windows.mjs', 'send-mail.py']) {
    assert.ok(existsSync(join(target, 'scripts', f)), `claimed by a selected skill, must travel: scripts/${f}`);
  }
  for (const f of [...ORPHAN_HOOK_SCRIPTS, ...RESIDUE]) {
    assert.equal(existsSync(join(target, 'scripts', f)), existsSync(join(repoRoot, 'scripts', f)),
      `root-structure parity requires scripts/${f}`);
  }
  for (const d of ['office-viz-themes', 'office-viz-vendor', 'launchd']) {
    assert.equal(existsSync(join(target, 'scripts', d)), existsSync(join(repoRoot, 'scripts', d)),
      `root-structure parity requires scripts/${d}/`);
  }
  assert.ok(!readdirSync(join(target, 'scripts')).some((e) => /\.log$/i.test(e)),
    'no *.log may ship (DENY_PATTERNS)');
});

test('wiring parity: no per-CLI config references an orphan hook script; surviving entries stay', () => {
  for (const rel of CONFIGS) {
    const p = join(target, ...rel.split('/'));
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    for (const f of ORPHAN_HOOK_SCRIPTS) {
      assert.ok(!text.includes(f), `${rel} still references pruned hook script ${f}`);
    }
  }
  // Floor wiring survives where the source wires it.
  const claude = readFileSync(join(target, '.claude', 'settings.json'), 'utf8');
  assert.ok(claude.includes('load-local-memory-hook.mjs'), 'floor hook wiring must survive in .claude/settings.json');
  const codex = readFileSync(join(target, '.codex', 'config.toml'), 'utf8');
  assert.ok(codex.includes('load-local-memory-hook.mjs'), 'floor hook wiring must survive in .codex/config.toml');
  // The TOML preamble banner is comment prose the pruner must not eat.
  assert.match(codex.split('\n')[0], /^# Codex CLI project config/, 'codex banner comment must survive pruning');
});

test('the forged runtime passes its own framework doctor (the v1.1.0 repro turned green)', () => {
  const r = spawnSync(process.execPath, [join(target, 'bin', 'sidekicks'), 'framework', 'doctor', '--json'],
    { cwd: target, encoding: 'utf8' });
  const payload = JSON.parse(r.stdout || '{}');
  assert.equal(r.status, 0,
    `runtime framework doctor found drift:\n${(payload.findings || []).map((f) => `  [${f.check}] ${f.detail}`).join('\n')}`);
  assert.ok(payload.counts.hooks_owner_absent >= ORPHAN_HOOK_SCRIPTS.length,
    'the orphan-owned hooks must be tolerated as owner-absent, not silently wired');
});

test('inherit verify: clean forge passes; changed dormant script fails root-structure parity', () => {
  const clean = inherit('verify', '--name', RUNTIME_NAME);
  assert.equal(clean.status, 0, `verify must pass on a clean forge:\n${clean.stdout}`);
  assert.match(clean.stdout, /root.structure.*(?:complete|parity|matches)/i);
  assert.match(clean.stdout, /no hook whose owner skills are all absent/);

  const plant = join(target, 'scripts', 'office-viz-hook.mjs');
  const original = readFileSync(plant);
  writeFileSync(plant, '// planted orphan\n');
  try {
    const dirty = inherit('verify', '--name', RUNTIME_NAME);
    assert.equal(dirty.status, 12, `verify must fail on a planted orphan:\n${dirty.stdout}`);
    assert.match(dirty.stdout, /office-viz-hook\.mjs/);
  } finally {
    writeFileSync(plant, original);
  }
});

test('inherit add re-registers the new skill\'s scripts and restores its wiring in every config', () => {
  const r = inherit('add', '--name', RUNTIME_NAME, '--skills', 'sk-slack-connector', '--no-venv');
  assert.equal(r.status, 0, `add failed:\n${r.stdout}\n${r.stderr}`);
  assert.ok(existsSync(join(target, 'scripts', 'run-notify-hook.mjs')),
    'the added skill\'s hook script must be registered back into scripts/');

  // Wherever the SOURCE wires run-notify, the runtime must again too.
  for (const rel of CONFIGS) {
    const src = join(fixture.root, ...rel.split('/'));
    const dst = join(target, ...rel.split('/'));
    if (!existsSync(src) || !readFileSync(src, 'utf8').includes('run-notify-hook.mjs')) continue;
    assert.ok(existsSync(dst) && readFileSync(dst, 'utf8').includes('run-notify-hook.mjs'),
      `${rel} must reference run-notify-hook.mjs again after add`);
  }
  // Still-absent owners stay pruned.
  const claude = readFileSync(join(target, '.claude', 'settings.json'), 'utf8');
  assert.ok(!claude.includes('office-viz-hook.mjs'), 'other orphan hooks must stay pruned after add');

  // The venv check may fail here (--no-venv while the added skill declares Python deps — a
  // pre-existing, unrelated verify concern); the OWNERSHIP checks must stay green.
  const verify = inherit('verify', '--name', RUNTIME_NAME);
  assert.match(verify.stdout, /ok\s+.*root.structure.*(?:complete|parity|matches)/i,
    `ownership check 9a must stay green after add:\n${verify.stdout}`);
  assert.match(verify.stdout, /ok {4}no hook whose owner skills are all absent/,
    `ownership check 9b must stay green after add:\n${verify.stdout}`);
});

test('--full-scripts keeps the escape hatch: everything travels except DENY patterns, verify stays clean', () => {
  const base = mkdtempSync(join(tmpdir(), 'sk-aap111-full-'));
  mkdirSync(join(base, '.sidekicks'), { recursive: true });
  const dir = join(base, 'rt');
  const name = 'aap111-fullscripts-test';
  try {
    const r = inherit('create', '--name', name, '--target', dir,
      '--skills', 'sk-hello', '--full-scripts', '--no-venv', '--no-agents', '--no-commands');
    assert.equal(r.status, 0, `forge failed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(existsSync(join(dir, 'scripts', 'office-viz-hook.mjs')), '--full-scripts must keep unowned files');
    assert.ok(!readdirSync(join(dir, 'scripts')).some((e) => /\.log$/i.test(e)
      && lstatSync(join(dir, 'scripts', e)).isFile()), 'DENY_PATTERNS still applies under --full-scripts');
    const verify = inherit('verify', '--name', name);
    assert.equal(verify.status, 0, `a deliberate --full-scripts forge must verify clean (informational):\n${verify.stdout}`);
    assert.match(verify.stdout, /root.structure.*(?:complete|parity|matches)/i);
  } finally {
    inherit('forget', '--name', name);
    rmSync(base, { recursive: true, force: true });
  }
});
