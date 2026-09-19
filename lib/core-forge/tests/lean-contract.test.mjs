import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { deriveRuntimeName, loadConfigBlock, resolveReleasePaths } from '../paths.mjs';
import { copyRootStructure, isDenied, projectRootStructure, verifyRootStructure } from '../surfaces.mjs';
import { verifyInstructionBodies, writeRuntimeAgentsMd } from '../instructions.mjs';
import { resolveFrameworkPreset } from '../../skill-package/framework-preset.mjs';
import { buildRegistry } from '../../framework-settings/registry.mjs';
import { expectedOutputs } from '../../../scripts/generate-subagent-ports.mjs';
import { sourceFixture } from './_source-fixture.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const product = ['sk-cli', 'sk-commander', 'sk-config-doctor', 'sk-framework-core',
  'sk-hello', 'sk-publish-core', 'sk-scope-switch', 'sk-skill-manager'].sort();
const portable = path => path.split(sep).join('/');

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lean-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, rel, text) {
  const path = join(root, ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('runtime identity follows service ownership across src, worktree and Windows paths', t => {
  const root = temporary(t);
  const cases = [
    ['projects/global/services/sidekicks-core/src', 'sidekicks-core'],
    ['projects/global/services/sidekicks-core/worktrees/chore-publish-sidekicks-core', 'sidekicks-core'],
    ['projects\\global\\services\\sidekicks-core\\worktrees\\chore-publish', 'sidekicks-core'],
    ['C:\\checkout\\projects\\global\\services\\sidekicks-core\\src', 'sidekicks-core'],
    ['delivery/src', 'delivery'], ['delivery/worktrees/feature-forge', 'delivery'],
    ['delivery', 'delivery'],
  ];
  for (const [target, expected] of cases)
    assert.equal(deriveRuntimeName(root, target, { target }, { runtime_name: 'ignored-config' }), expected, target);
  assert.equal(deriveRuntimeName(root, 'delivery', {}, { runtime_name: 'configured' }), 'configured');
  assert.equal(deriveRuntimeName(root, 'delivery', { name: 'explicit' }, { runtime_name: 'configured' }), 'explicit');
  assert.throws(() => deriveRuntimeName(root, 'delivery', { name: '../escape' }), error => error.exitCode === 2);
});

test('marker identity mismatch fails closed unless the operator explicitly names the identity', t => {
  const root = temporary(t);
  put(root, 'delivery/.sidekicks-core.json', JSON.stringify({ name: 'previous-core' }));
  assert.throws(() => deriveRuntimeName(root, 'delivery', { target: 'delivery' }), error =>
    error.exitCode === 2 && /previous-core/.test(error.message) && /delivery/.test(error.message));
  assert.equal(deriveRuntimeName(root, 'delivery', { target: 'delivery', name: 'replacement' }), 'replacement');
  put(root, 'delivery/.sidekicks-core.json', '{');
  assert.throws(() => deriveRuntimeName(root, 'delivery', { target: 'delivery' }), error => error.exitCode === 3);
});

test('publication configuration is root-scoped despite an active project override', t => {
  const root = temporary(t);
  put(root, '.agents/skills/sk-framework-core/SKILL.md', '---\nname: sk-framework-core\ndescription: Fixture\n---\n');
  put(root, '.agents/skills/sk-framework-core/skill.yaml',
    'skill: sk-framework-core\nconfig:\n  block: framework_core\n  family: skills\n  scope: root\n  defaults: config.defaults.yaml\n');
  put(root, '.agents/skills/sk-framework-core/config.defaults.yaml', 'framework_core:\n  preset: framework\n');
  put(root, '.sidekicks/settings.json', JSON.stringify({ active_project: 'other' }));
  put(root, 'projects/other/manifest.yaml', 'name: other\n');
  put(root, '.sidekicks/config/skills.yaml', 'framework_core:\n  target: delivery/root-core\n  runtime_name: root-core\n');
  put(root, 'projects/other/config/skills.yaml', 'framework_core:\n  target: delivery/wrong-project-core\n  runtime_name: wrong-project-core\n');
  assert.equal(loadConfigBlock(root).target, 'delivery/root-core');
  assert.equal(resolveReleasePaths(root).RUNTIME_NAME, 'root-core');
  const explicit = resolveReleasePaths(root, { target: 'delivery/explicit-core' });
  assert.equal(explicit.RUNTIME_NAME, 'explicit-core');
  assert.equal(portable(explicit.SRC_REL), 'delivery/explicit-core');
  rmSync(join(root, '.sidekicks', 'config', 'skills.yaml'));
  assert.equal(loadConfigBlock(root).preset, 'framework');
  assert.notEqual(loadConfigBlock(root).target, 'delivery/wrong-project-core');
});

test('the eight-skill instructions fit 6–8 KiB and preserve all six complete boundary rules', t => {
  const selected = resolveFrameworkPreset(repoRoot);
  assert.deepEqual(selected.errors, []);
  assert.deepEqual([...selected.selected].sort(), product);
  const fixture = sourceFixture(repoRoot);
  t.after(() => fixture.cleanup());
  writeRuntimeAgentsMd(fixture.root, { name: 'sidekicks-core', skillNames: product,
    sourceCommit: '0000000000000000000000000000000000000000', hasVenv: false });
  const text = readFileSync(join(fixture.root, 'AGENTS.md'), 'utf8');
  const size = Buffer.byteLength(text);
  assert.ok(size >= 6144 && size <= 8192, `rendered instruction size ${size} is outside 6144–8192 bytes`);
  const canonical = readFileSync(join(repoRoot, '.sidekicks', 'RULES.md'), 'utf8').replace(/\r\n?/g, '\n');
  const block = canonical.split('## The Six Boundary Rules\n')[1]?.split('\n## ')[0];
  assert.ok(block, 'canonical boundary section must exist');
  const rules = block.match(/\*\*Rule [1-6] — [\s\S]*?(?=\n\*\*Rule [1-6] — |$)/g);
  assert.equal(rules?.length, 6, 'must compare all six full bodies, not just their headings');
  for (const rule of rules) assert.ok(text.includes(rule.trim()), `boundary body changed: ${rule.split('\n')[0]}`);
  assert.deepEqual(verifyInstructionBodies(fixture.root, product), []);
  const owned = buildRegistry(fixture.root).entries.find(entry => entry.source === 'skill' && entry.kind !== 'hook');
  assert.ok(owned?.body_at, 'the pointer mutation must exercise a real owned rule');
  writeFileSync(join(fixture.root, 'AGENTS.md'), text.replaceAll(owned.id, 'removed-rule-pointer'));
  assert.ok(verifyInstructionBodies(fixture.root, product).some(problem => problem.includes(owned.id)), 'missing pointer must fail');
  writeFileSync(join(fixture.root, 'AGENTS.md'), text);
  rmSync(join(fixture.root, owned.body_at));
  assert.ok(verifyInstructionBodies(fixture.root, product).some(problem => problem.includes(owned.id)), 'missing body must fail');
});

test('boundary-body tampering fails even with its heading, byte count and mirrors preserved', t => {
  const fixture = sourceFixture(repoRoot);
  t.after(() => fixture.cleanup());
  writeRuntimeAgentsMd(fixture.root, { name: 'sidekicks-core', skillNames: product,
    sourceCommit: '0000000000000000000000000000000000000000', hasVenv: false });
  const original = readFileSync(join(fixture.root, 'AGENTS.md'), 'utf8');
  const changed = original.replace('**MUST** obtain explicit user permission', '**MAY ** obtain explicit user permission');
  assert.notEqual(changed, original, 'the fixture must actually change the database safety body');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
  assert.ok(changed.includes('**Rule 4 — Database Write Safety (Mandatory Permission & Transaction)**'));
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) put(fixture.root, name, changed);
  put(fixture.root, 'AGENTS.framework.md', '# Mount fixture\n\n' + changed);
  assert.ok(readFileSync(join(fixture.root, 'AGENTS.framework.md'), 'utf8').endsWith(changed));
  const problems = verifyInstructionBodies(fixture.root, product);
  assert.ok(problems.some(problem => /boundary rule body differs.*Rule 4/.test(problem)), problems.join('\n'));
  assert.ok(!problems.some(problem => /missing instruction body marker|lean instruction size/.test(problem)),
    'this must fail because of body content, not a missing heading or size change');
});

test('root projection excludes dotenv overlays and both secret YAML suffixes without copying dummy values', t => {
  const fixture = sourceFixture(repoRoot);
  t.after(() => fixture.cleanup());
  const denied = ['scripts/.env', 'scripts/.env.local', 'scripts/.env.production',
    'scripts/nested/.env.test.local', 'scripts/credentials.secret.yml',
    'scripts/credentials.secret.yaml', 'scripts/nested/CREDENTIALS.SECRET.YML'];
  const value = 'DUMMY_REGRESSION_SECRET_NEVER_REAL';
  for (const path of denied) put(fixture.root, path, value);
  put(fixture.root, '.sidekicks/config/public-fixture.example.yaml', 'enabled: false\n');
  const projection = projectRootStructure(fixture.root, product);
  const target = temporary(t);
  copyRootStructure(fixture.root, target, projection);
  for (const path of denied) {
    assert.equal(isDenied(path), true, path);
    const row = projection.entries.find(entry => entry.path === path);
    assert.equal(row?.included, false, `secret exclusion must be explicit: ${path}`);
    assert.match(row.reason, /secret/);
    assert.equal(projection.contents.has(path), false, `secret bytes entered content map: ${path}`);
    assert.equal(existsSync(join(target, path)), false, `secret copied: ${path}`);
  }
  assert.equal(JSON.stringify(projection).includes(value), false, 'dummy secret value leaked into inventory');
  assert.equal(readFileSync(join(target, '.sidekicks/config/public-fixture.example.yaml'), 'utf8'), 'enabled: false\n');
  assert.equal(isDenied('.claude/settings.json'), false, 'existing explicit public host-wiring exception remains');
});

// This inventory intentionally does NOT use CORE_SURFACES, OPTIONAL_SURFACES, configurationInventory,
// or the projection's own entries to discover required files. Otherwise an omitted surface could
// disappear from both sides of the comparison and pass its own acceptance test.
function originalFiles(rel) {
  const root = join(repoRoot, ...rel.split('/'));
  if (!existsSync(root)) return [];
  const files = [];
  function walk(path) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (['.git', '__pycache__', 'node_modules', '.DS_Store'].includes(name) || name.startsWith('._')) continue;
        walk(join(path, name));
      }
    } else if (stat.isFile()) files.push(portable(relative(repoRoot, path)));
    else assert.fail(`unexpected link/non-file in required source: ${path}`);
  }
  walk(root);
  return files;
}

test('original scripts, agents, ports and example files all appear byte-exact in the projection', t => {
  const roots = ['scripts', '.agents/subagents', '.claude/agents', '.codex/agents', '.agents/plugins'];
  const mandatory = roots.flatMap(originalFiles);
  for (const path of originalFiles('.sidekicks/config'))
    if (/\.(?:example|defaults)\.(?:yaml|json|toml)$/.test(path)) mandatory.push(path);
  for (const path of ['.sidekicks/config.example.yaml', '.sidekicks/settings.example.json'])
    if (existsSync(join(repoRoot, path))) mandatory.push(path);
  for (const root of roots) assert.ok(mandatory.some(path => path.startsWith(root + '/')), `${root} must have real fixture coverage`);
  assert.ok(mandatory.some(path => path.endsWith('.example.yaml')), 'example coverage cannot be empty');
  const projection = projectRootStructure(repoRoot, product);
  const rows = new Map(projection.entries.map(row => [row.path, row]));
  const generated = new Map(expectedOutputs(repoRoot).map(([path, text]) => [portable(relative(repoRoot, path)), Buffer.from(text)]));
  for (const path of mandatory) {
    const row = rows.get(path);
    assert.ok(row?.included && row.kind === 'file', `missing mandatory original-source path: ${path}`);
    assert.deepEqual(projection.contents.get(path), generated.get(path) ?? readFileSync(join(repoRoot, path)), `source bytes changed: ${path}`);
  }
  // Every independently discovered file gets its own destructive-negative check on a TEMP copy.
  // Retain the complete copied operating inventory for every check: an incomplete expected set
  // correctly reports the other files as unexpected under the exact-root contract.
  const target = temporary(t);
  const subset = { entries: mandatory.map(path => rows.get(path)), contents: projection.contents };
  copyRootStructure(repoRoot, target, subset);
  assert.deepEqual(verifyRootStructure(target, subset), []);
  for (const row of subset.entries) {
    const path = join(target, row.path);
    rmSync(path);
    assert.deepEqual(verifyRootStructure(target, subset), ['missing root structure: ' + row.path]);
    writeFileSync(path, projection.contents.get(row.path));
    if (process.platform !== 'win32') chmodSync(path, row.executable ? 0o755 : 0o644);
  }
  assert.deepEqual(verifyRootStructure(target, subset), []);
});

test('sealed root structure rejects extra skills and extra files in selected skills', t => {
  const target = temporary(t);
  const selected = '.agents/skills/sk-cli/SKILL.md';
  put(target, selected, 'selected skill');
  const projection = { entries: [{ path: selected, kind: 'file', included: true, executable: false }] };
  assert.deepEqual(verifyRootStructure(target, projection), []);

  put(target, '.agents/skills/unexpected/SKILL.md', 'unreviewed skill');
  assert.deepEqual(verifyRootStructure(target, projection), [
    'unexpected root structure: .agents/skills/unexpected',
  ]);
  rmSync(join(target, '.agents', 'skills', 'unexpected'), { recursive: true });

  put(target, '.agents/skills/sk-cli/unexpected.mjs', 'unreviewed executable');
  assert.deepEqual(verifyRootStructure(target, projection), [
    'unexpected root structure: .agents/skills/sk-cli/unexpected.mjs',
  ]);
});

test('all eight authoritative assets survive deny filtering and are byte-identical in the copy', t => {
  const assets = ['AGENTS.min.md.tmpl', 'core-readme.md.tmpl', 'install.ps1.tmpl',
    'install.sh.tmpl', 'module-distribution.json', 'presets.yaml', 'py-stdlib.json', 'runtime.gitignore'];
  const paths = originalFiles('lib/core-forge/assets');
  assert.deepEqual(paths.map(path => path.split('/').at(-1)).sort(), assets.sort());
  const projection = projectRootStructure(repoRoot, product);
  const target = temporary(t);
  const entries = paths.map(path => {
    assert.equal(isDenied(path), false, `asset denied: ${path}`);
    const entry = projection.entries.find(row => row.path === path);
    assert.ok(entry?.included, path);
    return entry;
  });
  copyRootStructure(repoRoot, target, { entries, contents: projection.contents });
  for (const path of paths) assert.deepEqual(readFileSync(join(target, path)), readFileSync(join(repoRoot, path)), path);
});
