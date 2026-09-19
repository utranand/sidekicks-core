// tests/skills/inherit-required-skills.test.mjs
//
// The REQUIRED skill floor of sk-publish-core — the `required:` block in assets/presets.yaml that
// every forged runtime carries whatever the operator selected, with no flag that turns it off.
//
// The floor's whole claim is that no code path can drop it, so this file tests the paths that could:
// selection, pruning, deletion after the fact, and a manifest that never tracked it. It also pins
// the two properties that make the floor legible rather than magic — it is not offerable as a
// preset, and an empty selection still fails instead of silently forging a runtime nobody asked for.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceFixture } from './_source-fixture.mjs';
import { resolveFrameworkPreset } from '../../skill-package/framework-preset.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(__dirname, '..', '..', '..');
const sourceSnapshot = sourceFixture(sourceRoot);
const repoRoot = sourceSnapshot.root;
after(() => sourceSnapshot.cleanup());
const skillDir = join(repoRoot, '.agents', 'skills', 'sk-publish-core');
const engine = join(sourceRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');
const presetsFile = join(repoRoot, 'lib', 'core-forge', 'assets', 'presets.yaml');

// The runtime registry is ONE shared file resolved from the source repo, so without this
// override every run of this suite mutates the developer's real
// artifacts/runs/inherit/runtimes.json — and `node --test` runs these files in parallel, which
// is precisely the concurrent read-modify-write that lost entries and made the gate flaky.
// The override moves the leaf path only; the engine's real registry code still runs.
const REGISTRY = join(mkdtempSync(join(tmpdir(), 'sk-publish-core-registry-')), 'runtimes.json');
const ENGINE_ENV = { ...process.env, SIDEKICKS_INHERIT_REGISTRY: REGISTRY,
  SIDEKICKS_TEST_PROJECTION_SOURCE: repoRoot };

/** Run the engine from the repo root and return {status, stdout, stderr}. */
function inherit(...args) {
  const r = spawnSync(process.execPath, [engine, ...args], { cwd: repoRoot, encoding: 'utf8', env: ENGINE_ENV });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Parse presets.yaml independently of the engine — if the two parsers disagree, that is itself the
 * bug this file should catch rather than inherit.
 */
function parseBlocks() {
  const blocks = {};
  let current = null;
  for (const raw of readFileSync(presetsFile, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const head = /^([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (head) { current = head[1]; blocks[current] = []; continue; }
    const item = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (item && current) blocks[current].push(item[1]);
  }
  return blocks;
}

function requiredSkills() {
  const blocks = parseBlocks();
  assert.ok(blocks.required, 'presets.yaml must define a "required:" block');
  return blocks.required;
}

function runtimeSkills(runtime) {
  return readdirSync(join(runtime, '.agents', 'skills')).sort();
}

/** Forge a scratch runtime and register cleanup. Returns its path. */
function forge(t, name, prefix, ...selection) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });
  const r = inherit('create', '--name', name, '--target', runtime,
    ...selection, '--no-venv', '--no-agents', '--no-commands');
  assert.equal(r.status, 0, `create failed: ${r.stderr || r.stdout}`);
  return runtime;
}

// ---------------------------------------------------------------------------
// 1. The block itself
// ---------------------------------------------------------------------------

test('every required skill resolves to a real skill directory', () => {
  const required = requiredSkills();
  assert.ok(required.length, 'the required floor must not be empty');
  for (const name of required) {
    assert.ok(
      existsSync(join(repoRoot, '.agents', 'skills', name))
      || existsSync(join(repoRoot, '.sidekicks', 'skill-offloaded', name)),
      `required skill '${name}' does not exist — a runtime could never be forged from this repo`,
    );
  }
});

test('the floor has one authority and no duplicate static core preset', () => {
  const blocks = parseBlocks();
  assert.equal(blocks.core, undefined);
  assert.equal(blocks.required.length, 6);
});

test('required and core are exactly this six-skill set, and neither carries skill-creator', () => {
  // Pins the floor's actual membership, not just its internal consistency (the test above proves
  // required==core but would pass just as well if both silently grew to seven). skill-creator is
  // named explicitly because it is the one skill this correction had to keep OUT: it is an optional
  // manifest sibling of sk-skill-manager (declared-optional-absent, degraded CREATE/ARCHITECT), never
  // a floor member and never a hard frontmatter depends-on.
  const expected = [
    'sk-hello',
    'sk-cli',
    'sk-commander',
    'sk-scope-switch',
    'sk-config-doctor',
    'sk-skill-manager',
  ].sort();
  const blocks = parseBlocks();
  assert.deepEqual([...blocks.required].sort(), expected,
    'the required floor drifted from the exact six-skill set this correction pins');
  assert.equal(blocks.core, undefined, 'the retired static core preset must not return');
  assert.ok(!blocks.required.includes('skill-creator'), 'skill-creator must never join the required floor');
});

test('--preset core --pack-skills none is dependency-closed: zero MISSING DEP, zero UNMET declared depends-on, no skill-creator', (t) => {
  // The regression for the corrected contract: sk-skill-manager's real dependency on skill-creator
  // now lives only in skill.manifest.yaml (optional sibling), never in SKILL.md frontmatter
  // depends-on, so the bare six-skill floor must plan and forge with NEITHER composition warning —
  // not just the BMAD-specific slice other suites check.
  const planTarget = join(tmpdir(), 'sk-publish-core-core-nodeps-plan-never-written');
  const plan = inherit('plan', '--name', 'core-nodeps-plan-probe', '--target', planTarget,
    '--skills', 'sk-hello,sk-cli,sk-skill-manager,sk-config-doctor,sk-commander,sk-scope-switch', '--pack-skills', 'none');
  assert.equal(plan.status, 0, 'inherit plan must exit 0');
  assert.doesNotMatch(plan.stdout, /MISSING DEP/,
    '--preset core --pack-skills none must be dependency-closed with zero MISSING DEP');
  assert.doesNotMatch(plan.stdout, /UNMET declared depends-on/,
    'plan must not report an unmet frontmatter dependency for the bare core');
  assert.doesNotMatch(plan.stdout, /\bskill-creator\b/,
    '--preset core must never select skill-creator — it is an opt-in optional sibling, not floor');
  assert.ok(!existsSync(planTarget), 'plan must not write anything to the target');

  // The composition-WARNINGS half of the same claim (`UNMET declared depends-on`) is only ever
  // emitted by an actual forge (inheritSkills(), not plan's read-only preview) — prove it there too.
  // Not using the shared forge() helper here because its return value (runtime path only) drops the
  // stdout this assertion needs.
  const dir = mkdtempSync(join(tmpdir(), 'sk-publish-core-corenodeps-'));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  const name = 'test-core-nodeps-forge';
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });
  const created = inherit('create', '--name', name, '--target', runtime,
    '--skills', 'sk-hello,sk-cli,sk-skill-manager,sk-config-doctor,sk-commander,sk-scope-switch', '--pack-skills', 'none', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(created.status, 0, `create failed: ${created.stderr || created.stdout}`);
  assert.doesNotMatch(created.stdout, /UNMET declared depends-on/,
    'a bare core forge must carry zero unmet frontmatter dependency warnings');
  const skills = runtimeSkills(runtime);
  assert.ok(!skills.includes('skill-creator'),
    'skill-creator must not be selected into a bare --preset core --pack-skills none runtime');
});

test('the framework preset is a superset of the required floor', () => {
  const blocks = parseBlocks();
  const resolved = resolveFrameworkPreset(repoRoot, { requiredFloor: blocks.required });
  assert.deepEqual(resolved.errors, [], `framework resolution failed: ${resolved.errors.join('; ')}`);
  for (const name of blocks.required) {
    assert.ok(
      resolved.selected.includes(name),
      `the framework preset omits required skill '${name}' — a published core must carry the floor`,
    );
  }
});

test('required is not offered as a preset', () => {
  const r = inherit('plan', '--name', 'test-required-nopreset', '--preset', 'required');
  assert.notEqual(r.status, 0, "'--preset required' must not resolve — the floor is not a bundle");
  assert.match(
    `${r.stdout}${r.stderr}`,
    /unknown preset 'required'/,
    'the floor must be rejected by name, not silently accepted',
  );
  assert.doesNotMatch(
    `${r.stdout}${r.stderr}`,
    /available:[^\n]*\brequired\b/,
    'the available-preset list must not advertise the floor',
  );
});

test('the skills verb reports the floor apart from the presets', () => {
  const r = inherit('skills');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^required — carried by EVERY runtime/m, 'the floor needs its own heading');
  for (const name of requiredSkills()) {
    assert.match(r.stdout, new RegExp(`^\\s+${name}$`, 'm'), `'${name}' must be listed under it`);
  }
});

// ---------------------------------------------------------------------------
// 2. Selection
// ---------------------------------------------------------------------------

test('an unrelated selection still carries the whole floor', (t) => {
  const runtime = forge(t, 'test-required-union', 'sk-publish-core-required-', '--skills', 'sk-publish-core');
  const skills = runtimeSkills(runtime);
  for (const name of requiredSkills()) {
    assert.ok(skills.includes(name), `'${name}' must travel even though nobody asked for it`);
  }
  assert.ok(skills.includes('sk-publish-core'), 'the operator selection must still be honoured');
});

test('plan marks the floor members it added to the selection', () => {
  const r = inherit('plan', '--name', 'test-required-plan', '--skills', 'sk-publish-core');
  assert.equal(r.status, 0);
  assert.match(
    r.stdout,
    new RegExp(`including ${requiredSkills().length} required`),
    'the count must say how much of the list is floor',
  );
  for (const name of requiredSkills()) {
    assert.match(r.stdout, new RegExp(`${name}\\b.*\\[required\\]`), `'${name}' must be marked`);
  }
});

test('an empty selection still exits 2 — the floor never forges a runtime nobody asked for', () => {
  const r = inherit('plan', '--name', 'test-required-empty');
  assert.equal(r.status, 2, 'the gate is on what the operator selected, not on the union');
  assert.match(`${r.stdout}${r.stderr}`, /no skills selected/);
});

// ---------------------------------------------------------------------------
// 3. The floor survives every removal path
// ---------------------------------------------------------------------------

test('--prune-skills never deletes a required skill', (t) => {
  const runtime = forge(t, 'test-required-prune', 'sk-publish-core-reqprune-',
    '--skills', 'sk-publish-core,sk-framework-core');

  // Re-forge naming ONLY a non-floor skill. Under the old contract this deleted everything else.
  const second = inherit('create', '--name', 'test-required-prune', '--target', runtime,
    '--skills', 'sk-publish-core', '--force', '--prune-skills',
    '--no-venv', '--no-agents', '--no-commands');
  assert.equal(second.status, 0, `re-forge failed: ${second.stderr || second.stdout}`);

  const skills = runtimeSkills(runtime);
  for (const name of requiredSkills()) {
    assert.ok(skills.includes(name), `--prune-skills deleted required skill '${name}'`);
  }
  assert.ok(!skills.includes('sk-framework-core'), 'prune must still remove unselected non-floor skills');
});

test('verify fails when a required skill is missing, and patch restores it without --force', (t) => {
  const name = 'test-required-verify';
  const runtime = forge(t, name, 'sk-publish-core-reqverify-', '--skills', 'sk-publish-core');
  assert.equal(inherit('verify', '--name', name).status, 0, 'a freshly forged runtime must verify clean');

  rmSync(join(runtime, '.agents', 'skills', 'sk-cli'), { recursive: true, force: true });

  const failed = inherit('verify', '--name', name);
  assert.notEqual(failed.status, 0, 'verify must fail a runtime missing a floor skill');
  assert.match(failed.stdout, /required skills missing from the runtime: sk-cli/);

  const drift = inherit('drift', '--name', name);
  assert.match(drift.stdout, /MISSING REQUIRED/, 'drift must report it as its own status');

  // No --force: there is no runtime-side work to protect, and the floor is not opt-out.
  const patched = inherit('patch', '--name', name);
  assert.equal(patched.status, 0, `patch failed: ${patched.stderr || patched.stdout}`);
  assert.equal(inherit('verify', '--name', name).status, 0, 'verify must be clean again after patch');
});

test('a floor skill the manifest never tracked is still restored', (t) => {
  const name = 'test-required-untracked';
  const runtime = forge(t, name, 'sk-publish-core-requntracked-', '--skills', 'sk-publish-core');

  // Simulate a runtime forged before the floor existed: no unit, no folder.
  const manifestPath = join(runtime, '.sidekicks', 'inherit.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.units['skills/sk-cli'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  rmSync(join(runtime, '.agents', 'skills', 'sk-cli'), { recursive: true, force: true });

  const drift = inherit('drift', '--name', name);
  assert.notEqual(drift.status, 0, 'an absent floor skill is drift even with nothing tracking it');
  assert.match(drift.stdout, /MISSING REQUIRED/);

  assert.equal(inherit('patch', '--name', name).status, 0);
  assert.ok(
    existsSync(join(runtime, '.agents', 'skills', 'sk-cli', 'SKILL.md')),
    'patch must re-inherit a floor skill that was never in the manifest',
  );
  assert.equal(inherit('verify', '--name', name).status, 0);
});

// ---------------------------------------------------------------------------
// 4. Documentation
// ---------------------------------------------------------------------------

test('the floor is documented in usage and in SKILL.md', () => {
  const usage = inherit('skills');
  assert.match(usage.stdout, /required/i, 'selection inventory must describe the floor');

  const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skillMd, /required/i, 'SKILL.md must describe the floor');
  for (const name of requiredSkills()) {
    assert.ok(skillMd.includes(name), `SKILL.md must name floor member '${name}'`);
  }
});
