// tests/skills/inherit-instruction-floor.test.mjs
//
// F-01 — the FORGED instruction surface must state every safety rule the runtime claims to follow.
//
// What went wrong. Every framework-core rule records `body_at: 'CLAUDE.md'`, so the only check that
// existed — `existsSync(body_at)` — was satisfied by the file being there, whatever it contained.
// The lightweight v2.0.0 core shipped a hand-curated CLAUDE.md missing SEVEN safety-floor rules
// (Teleport-only production access, the cluster-ops prod hard stop, headful Google automation,
// outward-action confirmation, secret-manifest placement, forced-worktree consent, and the
// autonomous-auditor floor) while `framework show` reported `body_exists: true` for every one of
// them. A consumer agent would never have been told any of it.
//
// The contract now: every framework-core entry is EITHER stated in the generated instructions —
// proven by its registry marker, a phrase from its own prose — OR explicitly declared uncarried and
// turned off in the runtime's enable map. Never silently absent while reported enabled.
//
// A forge is not cheap, so one core is built in before() and every assertion reads it.
// Imports only node:* built-ins.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceFixture } from './_source-fixture.mjs';

import { CORE_RULES } from '../../framework-settings/core-registry.mjs';
import { LOCKED_IDS } from '../../framework-settings/floor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(__dirname, '..', '..', '..');
const sourceSnapshot = sourceFixture(sourceRoot);
const repoRoot = sourceSnapshot.root;
after(() => sourceSnapshot.cleanup());
const engine = join(sourceRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');
const REMOTE = 'https://github.com/utranand/sidekicks-framework.git';

let base = null;
let core = null;
// The runtime registry is ONE shared file resolved from the source repo, so without this
// override every run of this suite mutates the developer's real
// artifacts/runs/inherit/runtimes.json — and `node --test` runs these files in parallel, which
// is precisely the concurrent read-modify-write that lost entries and made the gate flaky.
// The override moves the leaf path only; the engine's real registry code still runs.
const REGISTRY = join(mkdtempSync(join(tmpdir(), 'sk-publish-core-registry-')), 'runtimes.json');
const ENGINE_ENV = { ...process.env, SIDEKICKS_INHERIT_REGISTRY: REGISTRY,
  SIDEKICKS_TEST_PROJECTION_SOURCE: repoRoot };

/** @type {Array<{id:string, kind:string, floor:boolean, enabled:boolean, body_marker:string|null, registry_source:string}>} */
let runtimeEntries = [];

function inherit(...args) {
  const r = spawnSync(process.execPath, [engine, ...args], { cwd: repoRoot, encoding: 'utf8', env: ENGINE_ENV });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Read the FORGED runtime's own registry, resolved against its own enable map. */
function runtimeFrameworkList(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'bin', 'sidekicks'), 'framework', 'list', '--json'],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `the forged runtime could not list its own framework:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Both instruction surfaces the runtime ships. Either may carry a rule's body. */
function surfaces(dir) {
  return ['AGENTS.md', 'AGENTS.framework.md']
    .map((f) => join(dir, f))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8'));
}

before(() => {
  base = mkdtempSync(join(tmpdir(), 'sk-instr-floor-'));
  core = join(base, 'core');
  const r = inherit('create', '--name', 'instr-floor-test', '--target', core,
    '--skills', 'sk-hello,sk-cli,sk-skill-manager,sk-config-doctor,sk-commander,sk-scope-switch', '--force', '--no-venv', '--remote', REMOTE, '--as-core',
    // --as-core has no default version: it must be stated (INC-2026-09-04-01, F-5).
    '--core-version', '2.0.0',
    // This suite is about the INSTRUCTION floor and forges --no-venv to stay fast. A skill an agent
    // pack declares may carry Python, and verify rightly fails a runtime that needs a venv and has
    // none — an unrelated failure that would read here as an instruction-floor regression.
    '--pack-skills', 'none');
  assert.equal(r.status, 0, `forge failed:\n${r.stdout}\n${r.stderr}`);
  runtimeEntries = runtimeFrameworkList(core);
});

after(() => {
  if (base) { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
  inherit('forget', '--name', 'instr-floor-test');
});

// ═══════════════════════════════════════════════════════════════════════════════
// The floor: no exemption, no exception
// ═══════════════════════════════════════════════════════════════════════════════

test('every safety-floor rule is STATED in the forged instruction surface', () => {
  const texts = surfaces(core);
  assert.ok(texts.length, 'the forged core ships no instruction surface at all');

  const missing = [];
  for (const rule of CORE_RULES) {
    if (!LOCKED_IDS.has(rule.id)) continue;
    if (!texts.some((t) => t.includes(rule.marker))) missing.push(`${rule.id} ("${rule.marker}")`);
  }
  assert.deepEqual(missing, [],
    'these SAFETY-FLOOR rules are absent from the forged runtime instructions — the exact v2.0.0 '
    + `defect:\n${missing.map((m) => `  ${m}`).join('\n')}`);
});

test('the rules v2.0.0 dropped are each present by name', () => {
  // Named individually rather than derived, so a future edit to LOCKED_IDS cannot quietly shrink
  // what this test proves. These are the seven the audit found missing, minus
  // rule.cluster-ops-prod-hardstop: that entry was RETIRED 2026-08-17 (operator-directed) when
  // sk-cluster-ops gained direct production access, so there is no longer a marker to find.
  //
  // rule.teleport-prod-access was DE-FLOORED 2026-09-17 (operator-directed) — see floor.mjs — but
  // it stays in this list on purpose: it is still an enabled-by-default rule whose body is still
  // stated in AGENTS.md, and a forged runtime that drops the prose is still the v2.0.0 defect this
  // test exists to catch. Floor status is what changed; the presence guarantee did not. The five
  // others below are unchanged and still floor.
  const texts = surfaces(core).join('\n');
  const byId = new Map(CORE_RULES.map((r) => [r.id, r.marker]));
  for (const id of [
    'rule.teleport-prod-access',
    'rule.headful-google-automation',
    'rule.irreversible-outward-confirm',
    'rule.secrets-never-under-artifacts',
    'rule.worktree-force-consent',
    'rule.auditor-autonomous-safety-floor',
  ]) {
    assert.ok(texts.includes(byId.get(id)),
      `${id} is still missing from the forged instructions (marker: "${byId.get(id)}")`);
  }
});

test('forged protected-branch policy checks write owners and permits untouched enclosing repos', () => {
  const texts = surfaces(core).join('\n');
  const start = texts.indexOf('Protected branches — explicit waiver required');
  assert.notEqual(start, -1, 'the forged protected-branch rule is missing');
  const block = texts.slice(start, start + 1800);
  assert.match(block, /nearest owning\n?\s*Git worktree/,
    'the forged runtime must resolve intended writes to their nested repository owner');
  assert.match(block, /may stay protected/,
    'the forged runtime must permit an untouched enclosing repository to remain protected');
  assert.match(block, /parent-owned metadata or artifacts/,
    'the forged runtime must still check a parent repository that receives a tracked write');
});

test('a floor rule can never be declared uncarried, in the runtime or the source', () => {
  // The escape hatch below must not reach the floor. It cannot: `framework disable` refuses a floor
  // id, and lib/framework-settings/resolve.mjs throws on one present in ANY settings layer, `true`
  // or `false` alike. Asserted anyway, because that guarantee holds at a distance from the list.
  for (const e of runtimeEntries) {
    if (!e.floor) continue;
    assert.equal(e.enabled, true, `${e.id} is a floor entry and resolved DISABLED in the runtime`);
  }
  // The exemplar must be an id that is STILL floor: rule.teleport-prod-access was de-floored
  // 2026-09-17 (operator-directed) and `framework disable` now accepts it by design.
  const disable = spawnSync(process.execPath,
    [join(core, 'bin', 'sidekicks'), 'framework', 'disable', 'rule.headful-google-automation'],
    { cwd: core, encoding: 'utf8' });
  assert.notEqual(disable.status, 0, 'the runtime must refuse to disable a floor rule');
});

// ═══════════════════════════════════════════════════════════════════════════════
// The either/or, for everything else
// ═══════════════════════════════════════════════════════════════════════════════

test('every framework-core entry is either stated or explicitly turned off', () => {
  const texts = surfaces(core);
  const violations = [];
  for (const e of runtimeEntries) {
    if (e.registry_source !== 'core' || e.kind === 'hook') continue;
    assert.ok(e.body_marker, `${e.id} reached the runtime with no body marker to check`);
    const stated = texts.some((t) => t.includes(e.body_marker));
    if (stated || !e.enabled) continue;
    violations.push(`${e.id} is ENABLED but not stated (marker: "${e.body_marker}")`);
  }
  assert.deepEqual(violations, [],
    `the runtime claims rules its instructions never state:\n${violations.map((v) => `  ${v}`).join('\n')}`);
});

test('an entry the lean surface drops is turned OFF, not silently absent', () => {
  // The other direction, and the one that makes the either/or honest: if the forge stops carrying a
  // rule's prose it must also stop claiming the rule. Anything the surface omits must resolve
  // disabled in the runtime's own enable map.
  const texts = surfaces(core);
  const claimed = [];
  for (const e of runtimeEntries) {
    if (e.registry_source !== 'core' || e.kind === 'hook' || !e.body_marker) continue;
    if (texts.some((t) => t.includes(e.body_marker))) continue;
    if (e.enabled) claimed.push(e.id);
  }
  assert.deepEqual(claimed, [], `omitted from the instructions yet still enabled: ${claimed.join(', ')}`);
});

/** The ids the engine DECLARES a forged runtime may ship switched off, read out of its source. */
function declaredShippedOff() {
  const engineText = readFileSync(join(repoRoot, 'lib', 'core-forge', '_shared.mjs'), 'utf8');
  const block = /CORE_SETTINGS_SHIPPED_OFF = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(engineText);
  assert.ok(block, 'the declared shipped-off map must exist in the inherit engine');
  const ids = [...block[1].matchAll(/^\s*"([a-z]+\.[a-z0-9-]+)":/gm)].map((m) => m[1]);
  return ids;
}

test('the forge actually turned off what it declared uncarried', () => {
  // Guards the mechanism rather than the outcome: the declared map is only meaningful if
  // normalizeRuntimeEnableMap ran and its writes landed.
  const declared = declaredShippedOff();
  const byId = new Map(runtimeEntries.map((e) => [e.id, e]));
  for (const id of declared) {
    assert.ok(!LOCKED_IDS.has(id), `${id} is a FLOOR id and may never be declared uncarried`);
    const entry = byId.get(id);
    assert.ok(entry, `${id} is declared uncarried but is not in the runtime's registry at all`);
    assert.equal(entry.enabled, false,
      `${id} is declared uncarried but the forged runtime still has it ON`);
  }
});

test('the shipped enable map is a DECLARED DEFAULT, not the source repo\'s toggles', () => {
  // INC-2026-09-06-06, B-1. The forge copied `.sidekicks/config/settings/*.yaml` straight out of the
  // source working tree, so a consumer inherited whatever the author had switched off that
  // afternoon. v1.4.4 shipped `hook.enforce-branch-safety: false` — the hook enforcing a rule the
  // very same tarball calls hard — and nothing in the install said so.
  const declared = new Set(declaredShippedOff());
  const off = runtimeEntries.filter((e) => !e.floor && e.enabled === false);
  const undeclared = off.filter((e) => !declared.has(e.id)
    && !(e.kind === 'hook' && e.owner_absent === true));
  assert.deepEqual(undeclared.map((e) => e.id), [],
    'every disabled entry must be named in CORE_SETTINGS_SHIPPED_OFF, or be a hook whose owning '
    + 'skill verifiably did not travel');

  // The specific regression: the branch-safety hook is framework-core-owned, so nothing can make it
  // owner-absent, and no reason exists to declare it off.
  const branchSafety = runtimeEntries.find((e) => e.id === 'hook.enforce-branch-safety');
  assert.ok(branchSafety, 'the branch-safety hook must be in the forged registry');
  assert.equal(branchSafety.enabled, true,
    'the hook enforcing the shared-working-tree rule must ship ON');
});

test('the forge ships only the plugin declarations its allow-list names', () => {
  // INC-2026-09-06-06, B-5. `.claude/settings.json` travels whole, so the source author's personal
  // plugin set — ralph-loop, claude-hud, slack — rode into every consumer, and `sk-hello --apply`
  // installs every declared plugin non-interactively.
  const presets = readFileSync(
    join(repoRoot, 'lib', 'core-forge', 'assets', 'presets.yaml'), 'utf8');
  const block = /^host_plugins:\n((?:\s+-\s+\S+\n)+)/m.exec(presets);
  assert.ok(block, 'assets/presets.yaml must carry the host_plugins allow-list');
  const allowed = new Set([...block[1].matchAll(/-\s+(\S+)/g)].map((m) => m[1]));
  const allowedMarkets = new Set([...allowed].map((id) => id.split('@')[1]));

  const settings = JSON.parse(readFileSync(join(core, '.claude', 'settings.json'), 'utf8'));
  for (const id of Object.keys(settings.enabledPlugins ?? {})) {
    assert.ok(allowed.has(id), `the forged core declares '${id}', which the allow-list does not name`);
  }
  for (const name of Object.keys(settings.extraKnownMarketplaces ?? {})) {
    assert.ok(allowedMarkets.has(name),
      `the forged core declares the marketplace '${name}', which no allowed plugin needs`);
  }

  // A declaration with no stated owner is what the rule forbids: the instruction surface the same
  // core ships must say what each surviving plugin does and how to turn it off.
  const text = surfaces(core).join('\n');
  for (const id of Object.keys(settings.enabledPlugins ?? {})) {
    assert.ok(text.includes(id.split('@')[0]),
      `'${id}' is declared but the runtime's own instructions never mention it`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// The gate itself
// ═══════════════════════════════════════════════════════════════════════════════

test('inherit verify enforces the contract over the forged artifact', () => {
  const r = inherit('verify', '--name', 'instr-floor-test');
  assert.equal(r.status, 0,
    `verify failed on a correctly forged core:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /instruction surface states every framework-core rule/,
    'verify must report the instruction-surface check, or a future regression passes unnoticed');
});

test('inherit verify FAILS when a floor rule is cut out of the forged instructions', () => {
  // The regression test proper: reproduce the v2.0.0 state by deleting one floor rule's prose from
  // the artifact, and require the gate to catch it. Without this, every other assertion here only
  // proves the current template happens to be complete.
  const agents = join(core, 'AGENTS.md');
  const framework = join(core, 'AGENTS.framework.md');
  const savedAgents = readFileSync(agents, 'utf8');
  const savedFramework = existsSync(framework) ? readFileSync(framework, 'utf8') : null;
  // Exemplar must still be FLOOR: rule.teleport-prod-access was de-floored 2026-09-17
  // (operator-directed), so cutting its prose is now generic drift, not a safety-floor failure.
  const marker = CORE_RULES.find((r) => r.id === 'rule.headful-google-automation').marker;

  try {
    const strip = (text) => text.split('\n').filter((l) => !l.includes(marker)).join('\n');
    writeFileSync(agents, strip(savedAgents), 'utf8');
    if (savedFramework !== null) writeFileSync(framework, strip(savedFramework), 'utf8');

    const r = inherit('verify', '--name', 'instr-floor-test');
    assert.notEqual(r.status, 0, 'a core missing a safety-floor rule must FAIL verify');
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /rule\.headful-google-automation/);
    assert.match(out, /SAFETY-FLOOR/, 'the failure must say it is a safety rule, not a generic drift');
  } finally {
    writeFileSync(agents, savedAgents, 'utf8');
    if (savedFramework !== null) writeFileSync(framework, savedFramework, 'utf8');
  }
});
