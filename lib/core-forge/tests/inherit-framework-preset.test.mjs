// tests/skills/inherit-framework-preset.test.mjs
//
// AAP-94 — the `framework` preset and the `--prune-skills` flag of sk-publish-core.
//
// Two concerns:
//   1. The preset stays in step with docs/skill-modular-category.md §1 and resolves to real
//      skills with no unmet `depends-on` — the thing that silently rots when either side moves.
//   2. `--prune-skills` makes a re-forge produce the EXACT selection, which is what "redo able"
//      means for the framework runtime, and `add` refuses the flag rather than reinterpreting it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveFrameworkPreset } from '../../skill-package/framework-preset.mjs';
import { sourceFixture } from './_source-fixture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(__dirname, '..', '..', '..');
const sourceSnapshot = sourceFixture(sourceRoot);
const repoRoot = sourceSnapshot.root;
after(() => sourceSnapshot.cleanup());
const skillDir = join(repoRoot, '.agents', 'skills', 'sk-publish-core');
const engine = join(sourceRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');
const presetsFile = join(repoRoot, 'lib', 'core-forge', 'assets', 'presets.yaml');
const categoryDoc = join(repoRoot, 'docs', 'skill-modular-category.md');

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
  const r = spawnSync(process.execPath, [engine, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: ENGINE_ENV,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function textFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files;
}

/**
 * Parse presets.yaml the same way the engine does: a preset name at column 0 ending in ':',
 * members as indented '- <name>' items. Kept independent of the engine on purpose — if the two
 * parsers disagree, that is itself the bug this test should catch.
 */
function parsePresets() {
  const presets = {};
  let current = null;
  for (const raw of readFileSync(presetsFile, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const head = /^([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (head) { current = head[1]; presets[current] = []; continue; }
    const item = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (item && current) presets[current].push(item[1]);
  }
  return presets;
}

/** The bullet list under "## 1. Sidekicks framework skills" in the category doc. */
function categoryOneSkills() {
  const text = readFileSync(categoryDoc, 'utf8');
  const start = text.indexOf('## 1. Sidekicks framework skills');
  assert.notEqual(start, -1, 'docs/skill-modular-category.md must still have a "## 1." section');
  const rest = text.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section
    .split(/\r?\n/)
    .map((l) => /^-\s+(\S+)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

function skillExists(name) {
  return existsSync(join(repoRoot, '.agents', 'skills', name))
    || existsSync(join(repoRoot, '.sidekicks', 'skill-offloaded', name));
}

function frameworkSelection() {
  const floor = parsePresets().required;
  const result = resolveFrameworkPreset(repoRoot, { requiredFloor: floor });
  assert.deepEqual(result.errors, [], `framework resolution failed: ${result.errors.join('; ')}`);
  return result;
}

// ---------------------------------------------------------------------------
// 1. Preset integrity
// ---------------------------------------------------------------------------

test('framework preset is a dynamic sentinel and every resolved member is a real skill', () => {
  const presets = parsePresets();
  assert.ok(presets.framework, 'presets.yaml must define a "framework" preset');
  assert.deepEqual(presets.framework, [], 'framework membership must not be duplicated in presets.yaml');
  const missing = frameworkSelection().selected.filter((s) => !skillExists(s));
  assert.deepEqual(missing, [], `framework preset names skills that do not exist: ${missing.join(', ')}`);
});

test('dynamic framework selection is exactly the eight-skill product', () => {
  assert.deepEqual(frameworkSelection().selected.sort(),
    [...parsePresets().required, 'sk-framework-core', 'sk-publish-core'].sort());
});

test('the optional improvement funnel does not join the lean product', () => {
  const selected = frameworkSelection().selected;
  for (const name of ['skill-creator', 'sk-self-improve', 'sk-jira-connector'])
    assert.ok(!selected.includes(name), name);
});

test('the engine lists the framework preset', () => {
  const { status, stdout } = inherit('skills');
  assert.equal(status, 0, 'inherit skills must exit 0');
  assert.match(stdout, /^\s+framework: /m, 'inherit skills must list the framework preset');
});

test('static presets and explicit selections keep distinct provenance reasons', (t) => {
  const fixture = sourceFixture(repoRoot, {
    'sk-git-ship': {}, 'sk-git-sweep': {}, 'sk-report': {},
  });
  ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = fixture.root;
  t.after(() => { ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = repoRoot; fixture.cleanup(); });
  const planned = inherit(
    'plan', '--name', `test-static-reasons-${process.pid}`, '--preset', 'git',
    '--skills', 'sk-report', '--no-as-core', '--pack-skills', 'none'
  );
  assert.equal(planned.status, 0, planned.stderr || planned.stdout);
  assert.match(planned.stdout, /^  sk-git-ship\b.*\[selected-by-preset:git\]/m);
  assert.match(planned.stdout, /^  sk-report\b.*\[selected-by-operator\]/m);
});

// ---------------------------------------------------------------------------
// 2. Dependency closure — `plan` writes nothing, so this is safe to run anywhere
// ---------------------------------------------------------------------------

test('framework preset has no unmet declared depends-on', () => {
  const target = join(tmpdir(), 'sk-publish-core-plan-only-never-written');
  // --pack-skills none: the property under test is that the PRESET is dependency-closed. A core
  // forge also derives the skills its shipped agent packs declare, and `declared` (the default)
  // deliberately stops at the declared rows — so one of those skills can legitimately report a
  // MISSING DEP without the preset having drifted. Mixing the two would make this gate report the
  // wrong defect.
  const { status, stdout } = inherit('plan', '--name', 'framework-plan-probe', '--target', target,
    '--preset', 'framework', '--pack-skills', 'none');
  assert.equal(status, 0, 'inherit plan must exit 0');
  assert.doesNotMatch(
    stdout,
    /MISSING DEP/,
    'the framework preset must be dependency-closed — add the named skill to the preset',
  );
  assert.ok(!existsSync(target), 'plan must not write anything to the target');
});

test('framework create records deterministic selection reasons in the inherited manifest', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-publish-core-framework-reasons-'));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  const name = `test-framework-reasons-${process.pid}`;
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });

  const created = inherit('create', '--name', name, '--target', runtime,
    '--preset', 'framework', '--no-as-core', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(created.status, 0, `create failed: ${created.stderr || created.stdout}`);
  const manifest = JSON.parse(readFileSync(join(runtime, '.sidekicks', 'inherit.json'), 'utf8'));
  assert.deepEqual(manifest.units['skills/sk-publish-core'].selection_reasons,
    ['declared', 'dependency-of:sk-framework-core']);
  assert.deepEqual(
    manifest.units['skills/sk-hello'].selection_reasons,
    ['declared', 'required-floor'],
  );
  assert.equal(manifest.units['skills/skill-creator'], undefined);

  const config = spawnSync(
    process.execPath,
    [join(runtime, 'bin', 'sidekicks'), 'config', 'get', 'skill_manager', '--json'],
    { cwd: runtime, encoding: 'utf8' },
  );
  assert.equal(config.status, 0, config.stderr);
  const skillRepo = JSON.parse(config.stdout).config.skill_repo;
  assert.deepEqual(Object.keys(skillRepo).filter((key) => key !== 'layout'), ['public']);
  assert.equal(skillRepo.public.remote, 'https://github.com/utranand/sidekicks-skills.git');
  assert.equal(skillRepo.public.checkout, '');

  const forbidden = [
    ['sidekicks-skills', 'private'].join('-'),
    ['projects/global/services/sidekicks-skills', 'private/src'].join('-'),
  ];
  const leaks = [];
  for (const file of textFiles(runtime)) {
    const text = readFileSync(file, 'utf8');
    for (const needle of forbidden) {
      if (text.includes(needle)) leaks.push(`${file}: ${needle}`);
    }
  }
  assert.deepEqual(leaks, [], `private destination leaked into forged runtime:\n${leaks.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 3. --prune-skills
// ---------------------------------------------------------------------------

// The selection here is deliberately made of NON-required skills. Every member of the `required:`
// floor survives a prune by design (see inherit-required-skills.test.mjs), so pruning down to
// `--skills sk-cli` — which this test used to do — can no longer delete anything, and would
// assert nothing about pruning.
test('--prune-skills makes a re-forge produce exactly the selection plus the required floor', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-publish-core-prune-'));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  const name = 'test-prune-rt';
  const floor = [...parsePresets().required];
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });

  // --no-venv keeps this fast; neither git skill needs Python.
  const first = inherit('create', '--name', name, '--target', runtime,
    '--skills', 'sk-framework-core,sk-publish-core', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(first.status, 0, `create failed: ${first.stderr || first.stdout}`);
  assert.deepEqual(
    readdirSync(join(runtime, '.agents', 'skills')).sort(),
    [...floor, 'sk-framework-core', 'sk-publish-core'].sort(),
    'create must land the selection plus the required floor',
  );

  // plan previews the deletion before it happens.
  const preview = inherit('plan', '--name', name, '--skills', 'sk-framework-core', '--prune-skills');
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /NOT in this selection \(1\)/, 'plan must preview what prune would delete');
  assert.match(preview.stdout, /would DELETE these/, 'plan must say the skills would be deleted');
  assert.match(preview.stdout, /sk-publish-core/, 'the unselected non-floor skill is what goes');
  assert.equal(
    readdirSync(join(runtime, '.agents', 'skills')).length, floor.length + 2,
    'plan must not delete anything itself',
  );

  const second = inherit('create', '--name', name, '--target', runtime,
    '--skills', 'sk-framework-core', '--force', '--prune-skills', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(second.status, 0, `re-forge failed: ${second.stderr || second.stdout}`);
  assert.deepEqual(
    readdirSync(join(runtime, '.agents', 'skills')).sort(),
    [...floor, 'sk-framework-core'].sort(),
    'after --prune-skills the runtime must hold exactly the selection plus the floor',
  );

  const manifest = JSON.parse(readFileSync(join(runtime, '.sidekicks', 'inherit.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(manifest.units).filter((u) => u.startsWith('skills/')).sort(),
    [...floor, 'sk-framework-core'].map((s) => `skills/${s}`).sort(),
    'pruned skills must lose their manifest unit too, or drift keeps reporting them missing',
  );

  const verify = inherit('verify', '--name', name);
  assert.equal(verify.status, 0, `verify must stay clean after a prune: ${verify.stdout}`);
});

test('without --prune-skills a re-forge leaves earlier skills alone', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-publish-core-noprune-'));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  const name = 'test-noprune-rt';
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(inherit('create', '--name', name, '--target', runtime,
    '--skills', 'sk-hello,sk-cli,sk-skill-manager,sk-config-doctor,sk-commander,sk-scope-switch', '--no-venv', '--no-agents', '--no-commands').status, 0);
  assert.equal(inherit('create', '--name', name, '--target', runtime,
    '--skills', 'sk-cli', '--force', '--no-venv', '--no-agents', '--no-commands').status, 0);

  assert.deepEqual(
    readdirSync(join(runtime, '.agents', 'skills')).sort(),
    [...parsePresets().required].sort(),
    'prune must be strictly opt-in — a plain --force must not delete a runtime\'s other skills',
  );
});

test('add refuses --prune-skills instead of reinterpreting it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-publish-core-addprune-'));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  const name = 'test-addprune-rt';
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(inherit('create', '--name', name, '--target', runtime,
    '--skills', 'sk-hello,sk-cli,sk-skill-manager,sk-config-doctor,sk-commander,sk-scope-switch', '--no-venv', '--no-agents', '--no-commands').status, 0);

  const r = inherit('add', '--name', name, '--skills', 'sk-packager', '--prune-skills', '--no-venv');
  assert.equal(r.status, 2, 'add --prune-skills must exit 2 (usage)');
  assert.match(r.stderr, /--prune-skills is a 'create' flag/, 'the refusal must name the right verb');
  assert.deepEqual(
    readdirSync(join(runtime, '.agents', 'skills')).sort(),
    [...parsePresets().required].sort(),
    'the refused add must not have touched the runtime',
  );
});

// ---------------------------------------------------------------------------
// 4. A fresh forge must be able to reach a clean drift
// ---------------------------------------------------------------------------

test('drift is clean immediately after a create that carries skill-creator', (t) => {
  const fixture = sourceFixture(repoRoot, {
    'skill-creator': { 'agents/openai.yaml': 'interface:\n  display_name: Fixture creator\n' },
  });
  ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = fixture.root;
  t.after(() => { ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = repoRoot; fixture.cleanup(); });
  // The permanent-FF regression. skill-creator bundles agents/openai.yaml; while "agents" was a
  // bare DENY segment the file was stripped from the runtime, the baseline was hashed from that
  // truncated copy, and drift compared it against the full SOURCE tree — so `sourceChanged` was
  // unconditionally true, `patch` re-recorded from the runtime copy again, and the skill reported
  // `FF` with exit 10 forever. Three first-party skills are in the same shape.
  const dir = mkdtempSync(join(tmpdir(), 'sk-publish-core-driftclean-'));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  const name = 'test-driftclean-rt';
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });

  const created = inherit('create', '--name', name, '--target', runtime,
    '--skills', 'skill-creator', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(created.status, 0, `create failed: ${created.stderr || created.stdout}`);

  assert.ok(existsSync(join(runtime, '.agents', 'skills', 'skill-creator', 'agents', 'openai.yaml')),
    'a skill\'s own agents/ directory must travel with it');

  const drift = inherit('drift', '--name', name, '--json');
  assert.equal(drift.status, 0,
    `a freshly forged runtime must have nothing to patch:\n${drift.stdout}${drift.stderr}`);
  const rows = JSON.parse(drift.stdout).skills;
  const creator = rows.find((r) => r.name === 'skill-creator');
  assert.ok(creator, 'skill-creator must be tracked in the manifest');
  assert.equal(creator.status, 'up-to-date',
    `skill-creator drifted straight out of the forge: ${creator.status} ${creator.detail ?? ''}`);

  // Rule 6 parity: the Antigravity mirror shipped a plugin.json with zero agents behind it while
  // the segment rule ate .agents/plugins/sidekicks-agents/agents/.
  const plugin = join(runtime, '.agents', 'plugins', 'sidekicks-agents');
  if (existsSync(join(plugin, 'plugin.json'))) {
    assert.ok(existsSync(join(plugin, 'agents')) && readdirSync(join(plugin, 'agents')).length > 0,
      'a shipped Antigravity plugin.json must be accompanied by a non-empty agents/');
  }
});

test('internal pruning remains implemented and the skill identifies the framework product', () => {
  const source = readFileSync(join(repoRoot, 'lib', 'core-forge', 'forge.mjs'), 'utf8');
  assert.match(source, /prune-skills/, 'callable engine must preserve the pruning operation');
  const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skillMd, /framework/, 'SKILL.md must identify the framework product');
});
