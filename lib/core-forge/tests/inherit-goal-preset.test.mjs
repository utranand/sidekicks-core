// tests/skills/inherit-goal-preset.test.mjs
//
// The `goal` preset — the goal engine (sk-get-plan-done + the sidekicks goal CLI it drives) plus
// the multi-CLI delegation pair — and the portability property that lets it exist.
//
// Two concerns:
//   1. The preset resolves to real skills, carries the orchestrator/executor pair together, and
//      forges a runtime holding NO `sk-bmad-*` skill. A goal-engine runtime that drags the BMAD
//      family in is the exact thing this preset was added to avoid.
//   2. The portability invariant underneath it: no skill outside the `sk-bmad-*` family may name a
//      `sk-bmad-*` skill in its SKILL.md frontmatter `depends-on`. That list has no optional
//      marker (core-forge.mjs `declaredDependencies()` parses a flat list), so one entry there makes
//      BMAD a hard dependency of the depending skill and un-closes every preset carrying it.
//      BMAD is a DETECTED CAPABILITY instead: skills probe `framework check rule.bmad-first` plus
//      the skill directory and take a named fallback route. This test is what keeps that from
//      rotting back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const skillDir = join(repoRoot, '.agents', 'skills', 'sk-publish-core');
const engine = join(repoRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');
const presetsFile = join(repoRoot, 'lib', 'core-forge', 'assets', 'presets.yaml');
const skillsTree = join(repoRoot, '.agents', 'skills');

// Same registry isolation as inherit-framework-preset.test.mjs: the runtime registry is ONE shared
// file resolved from the source repo, and `node --test` runs these files in parallel.
const REGISTRY = join(mkdtempSync(join(tmpdir(), 'sk-goal-registry-')), 'runtimes.json');
const ENGINE_ENV = { ...process.env, SIDEKICKS_INHERIT_REGISTRY: REGISTRY };

/** Run the engine from the repo root and return {status, stdout, stderr}. */
function inherit(...args) {
  const r = spawnSync(process.execPath, [engine, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: ENGINE_ENV,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Parse presets.yaml the way the engine does: name at column 0 ending in ':', indented '- item'. */
function parsePresets() {
  const presets = {};
  let current = null;
  for (const raw of readFileSync(presetsFile, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;
    const head = /^([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) { current = head[1]; presets[current] = []; continue; }
    const item = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (item && current) presets[current].push(item[1]);
  }
  return presets;
}

const skillExists = (name) => existsSync(join(skillsTree, name))
  || existsSync(join(repoRoot, '.sidekicks', 'skill-offloaded', name));

/**
 * Every skill's declared frontmatter dependencies, mirroring core-forge.mjs `declaredDependencies()`:
 * the `depends-on:` list inside the `---` frontmatter, `skill:` prefix optional, list ending at the
 * first non-item line.
 * @returns {Map<string, string[]>}
 */
function declaredDependenciesBySkill() {
  const out = new Map();
  for (const name of readdirSync(skillsTree)) {
    const file = join(skillsTree, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'));
    if (!fm) continue;
    const lines = fm[1].split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*depends-on:\s*$/.test(l));
    if (start === -1) continue;
    const deps = [];
    for (let i = start + 1; i < lines.length; i++) {
      const item = /^\s*-\s*(?:skill:)?([A-Za-z0-9._-]+)\s*$/.exec(lines[i]);
      if (!item) break;
      if (item[1] !== 'sidekicks') deps.push(item[1]);
    }
    out.set(name, deps);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Preset integrity
// ---------------------------------------------------------------------------

test('goal preset exists and every member resolves to a real skill', (t) => {
  if (parsePresets().goal.some(s => !skillExists(s))) return t.skip('source-only goal preset integration: optional goal skills are not shipped');
  const presets = parsePresets();
  assert.ok(presets.goal, 'presets.yaml must define a "goal" preset');
  const missing = presets.goal.filter((s) => !skillExists(s));
  assert.deepEqual(missing, [], `goal preset names skills that do not exist: ${missing.join(', ')}`);
});

test('goal preset carries the goal engine and the inseparable multi-CLI pair', () => {
  const preset = new Set(parsePresets().goal);
  for (const required of ['sk-get-plan-done', 'sk-cli-orchestrator', 'sk-cli-executor']) {
    assert.ok(preset.has(required), `goal preset must carry ${required}`);
  }
});

test('goal preset names no BMAD skill', () => {
  const bmad = parsePresets().goal.filter((s) => s.startsWith('sk-bmad-'));
  assert.deepEqual(bmad, [], `the goal preset is BMAD-free on purpose — remove: ${bmad.join(', ')}`);
});

test('the engine lists the goal preset', () => {
  const { status, stdout } = inherit('skills');
  assert.equal(status, 0, 'inherit skills must exit 0');
  assert.match(stdout, /^\s+goal: /m, 'inherit skills must list the goal preset');
});

// ---------------------------------------------------------------------------
// 2. Dependency closure — `plan` writes nothing, so this is safe to run anywhere
// ---------------------------------------------------------------------------

test('the goal preset plans with zero declared-dependency warnings and pulls in no BMAD skill', (t) => {
  if (parsePresets().goal.some(s => !skillExists(s))) return t.skip('source-only goal preset integration: optional goal skills are not shipped');
  const target = join(tmpdir(), 'sk-goal-plan-only-never-written');
  const { status, stdout } = inherit(
    'plan', '--name', 'goal-plan-probe', '--target', target, '--preset', 'goal',
  );
  assert.equal(status, 0, 'inherit plan must exit 0');

  // The goal preset is dependency-closed like every other shipped preset (sk-skill-manager's own
  // real dependency on skill-creator lives only in its manifest as an optional sibling, never in
  // SKILL.md frontmatter depends-on — see inherit-required-skills.test.mjs), so this asserts BOTH
  // that zero composition warning fires at all, and that none of it names a BMAD skill, which is
  // the property this preset specifically exists to keep.
  const depWarnings = stdout.split(/\r?\n/).filter((l) => /MISSING DEP|UNMET declared depends-on/.test(l));
  assert.deepEqual(
    depWarnings, [],
    `the goal preset must plan with zero declared-dependency warnings:\n${depWarnings.join('\n')}`,
  );
  const bmadDep = depWarnings.filter((l) => /sk-bmad-/.test(l));
  assert.deepEqual(
    bmadDep, [],
    'a goal-preset member declares a BMAD skill in depends-on — make it a detected capability '
      + `(optional sibling + a probed fallback route) instead:\n${bmadDep.join('\n')}`,
  );
  assert.ok(!existsSync(target), 'plan must not write anything to the target');
});

// ---------------------------------------------------------------------------
// 3. The portability invariant this preset rests on
// ---------------------------------------------------------------------------

test('no non-BMAD skill declares a BMAD skill in frontmatter depends-on', () => {
  const offenders = [];
  for (const [skill, deps] of declaredDependenciesBySkill()) {
    if (skill.startsWith('sk-bmad-')) continue;          // intra-family deps are fine
    for (const dep of deps) if (dep.startsWith('sk-bmad-')) offenders.push(`${skill} -> ${dep}`);
  }
  assert.deepEqual(
    offenders, [],
    '`depends-on` has no optional marker, so each of these makes BMAD a HARD dependency and '
      + 'un-closes every preset carrying the skill. Move it to skill.manifest.yaml '
      + `sibling_skills with 'optional: true' and give SKILL.md a probed fallback route:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// 4. A forged runtime holds the preset, the floor, and no BMAD
// ---------------------------------------------------------------------------

test('forging --preset goal lands the members plus the floor, with no BMAD skill', (t) => {
  if (parsePresets().goal.some(s => !skillExists(s))) return t.skip('source-only goal preset integration: optional goal skills are not shipped');
  const dir = mkdtempSync(join(tmpdir(), 'sk-goal-forge-'));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const runtime = join(dir, 'rt');
  const name = 'test-goal-rt';
  t.after(() => {
    inherit('forget', '--name', name);
    rmSync(dir, { recursive: true, force: true });
  });

  // --no-venv keeps this fast: the preset's two Python skills are not executed here, only placed.
  const r = inherit('create', '--name', name, '--target', runtime,
    '--preset', 'goal', '--no-venv', '--no-agents', '--no-commands');
  assert.equal(r.status, 0, `create failed: ${r.stderr || r.stdout}`);

  const landed = readdirSync(join(runtime, '.agents', 'skills')).sort();
  const expected = [...new Set([...parsePresets().goal, ...parsePresets().required])].sort();
  assert.deepEqual(landed, expected, 'a goal forge must land exactly the preset plus the required floor');
  assert.deepEqual(
    landed.filter((s) => s.startsWith('sk-bmad-')), [],
    'a goal runtime must carry no BMAD skill — compose --preset goal,bmad for that',
  );
});
