// tests/skills/inherit-delegate-agents.test.mjs
//
// Delegate agents as an inheritable unit of sk-publish-core: `--delegates a,b`,
// `--all-delegates`, `--delegate-memory`, `--prune-delegates`, a preset's `delegates:` section, and
// the safety floor around the agent bridge.
//
// The invariants worth a test, because each one fails silently:
//   1. Nothing travels unless it is named — a runtime forged without --delegates has no agent store.
//   2. Only agent.yaml + routines/ travel. memory/ needs --delegate-memory (an agent's memory
//      records the SOURCE repo's decisions), and .sidekicks/agents/.bridge/ NEVER travels — it holds
//      the bridge token and the Telegram bot_token. `verify` must FAIL when one is present.
//   3. Drift is measured over the inherited surface only, so the runtime/ state a live delegate
//      writes (presence, mailbox, threads) never reads as a local modification.
//   4. A charter amended in the runtime is held back, not clobbered — charters are hand-amended, so
//      this is the normal case, not an edge one.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceFixture } from './_source-fixture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(__dirname, '..', '..', '..');
const fixture = sourceFixture(sourceRoot);
const repoRoot = fixture.root;
after(() => fixture.cleanup());
for (const name of ['debby', 'steve']) {
  const agent = join(repoRoot, '.sidekicks', 'agents', name);
  mkdirSync(join(agent, 'memory'), { recursive: true });
  mkdirSync(join(agent, 'runtime'), { recursive: true });
  mkdirSync(join(agent, 'routines'), { recursive: true });
  writeFileSync(join(agent, 'agent.yaml'), readFileSync(join(sourceRoot, '.sidekicks', 'agent-packs', 'core', 'agents', name, 'agent.yaml')));
  writeFileSync(join(agent, 'memory', 'fixture.md'), '# Fixture memory\n');
  writeFileSync(join(agent, 'runtime', 'fixture.json'), '{}\n');
  writeFileSync(join(agent, 'routines', 'fixture.md'), '# Fixture routine\n');
}
mkdirSync(join(repoRoot, '.sidekicks', 'agents', '.bridge'), { recursive: true });
writeFileSync(join(repoRoot, '.sidekicks', 'agents', '.bridge', 'token'), 'test-only-token');
mkdirSync(join(repoRoot, '.sidekicks', 'memory'), { recursive: true });
writeFileSync(join(repoRoot, '.sidekicks', 'memory', 'fixture.md'), '# Source-only memory\n');
const skillDir = join(repoRoot, '.agents', 'skills', 'sk-publish-core');
const engine = join(sourceRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');
const presetsFile = join(repoRoot, 'lib', 'core-forge', 'assets', 'presets.yaml');
const agentsRoot = join(repoRoot, '.sidekicks', 'agents');

// The runtime registry is ONE shared file resolved from the source repo, so without this
// override every run of this suite mutates the developer's real
// artifacts/runs/inherit/runtimes.json — and `node --test` runs these files in parallel, which
// is precisely the concurrent read-modify-write that lost entries and made the gate flaky.
// The override moves the leaf path only; the engine's real registry code still runs.
const REGISTRY = join(mkdtempSync(join(tmpdir(), 'sk-publish-core-registry-')), 'runtimes.json');
const ENGINE_ENV = { ...process.env, SIDEKICKS_INHERIT_REGISTRY: REGISTRY,
  SIDEKICKS_TEST_PROJECTION_SOURCE: repoRoot };

/** Run the engine from the repo root (it refuses to run from inside a runtime). */
function inherit(...args) {
  const r = spawnSync(process.execPath, [engine, ...args], { cwd: repoRoot, encoding: 'utf8', env: ENGINE_ENV });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Delegate agents this repo actually carries, chosen from the filesystem rather than hard-coded:
 * the test must not start failing because a particular agent was retired.
 */
function sourceDelegates() {
  if (!existsSync(agentsRoot)) return [];
  return readdirSync(agentsRoot).sort()
    .filter((e) => e !== '.bridge' && existsSync(join(agentsRoot, e, 'agent.yaml')));
}

function tmpTarget(label) {
  return join(mkdtempSync(join(tmpdir(), `inherit-delegates-${label}-`)), 'rt');
}

/** Forge a minimal runtime (no venv, four core skills) and drop its registry entry afterwards. */
function forge(name, target, ...extra) {
  return inherit('create', '--name', name, '--target', target,
    '--skills', 'sk-hello,sk-cli,sk-skill-manager,sk-config-doctor,sk-commander,sk-scope-switch', '--no-venv', ...extra);
}

function cleanup(name, target) {
  inherit('forget', '--name', name);
  rmSync(dirname(target), { recursive: true, force: true });
}

function manifestOf(target) {
  return JSON.parse(readFileSync(join(target, '.sidekicks', 'inherit.json'), 'utf8'));
}

function agentUnits(target) {
  return Object.fromEntries(Object.entries(manifestOf(target).units)
    .filter(([, v]) => v.kind === 'agent'));
}

// ---------------------------------------------------------------------------
// Selection surface
// ---------------------------------------------------------------------------

test('the skills verb lists delegate agents as a separate inheritable set', () => {
  const r = inherit('skills');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /delegate agents/, 'the listing must name delegate agents');
  for (const a of sourceDelegates().slice(0, 3)) {
    assert.ok(r.stdout.includes(a), `expected delegate '${a}' in the listing`);
  }
  assert.match(r.stdout, /--delegate-memory/, 'the listing must say memory is opt-in');
});

test('presets support a delegates: section without breaking the flat form', () => {
  const text = readFileSync(presetsFile, 'utf8');
  assert.match(text, /^delegate-crew:$/m, 'the delegate-crew preset must exist');
  assert.match(text, /^ {2}delegates:$/m, 'a preset must be able to name delegate agents');

  const r = inherit('skills');
  assert.equal(r.status, 0, r.stderr);
  // The flat presets still resolve to skills, and the sectioned one lists its skills too.
  assert.match(r.stdout, /git: sk-git-ship/, 'a flat preset must still parse as skills');
  assert.match(r.stdout, /delegate-crew: sk-agent-creator/,
    'a sectioned preset must expose its skills: block as the skill selection');
});

test('an unknown delegate is refused before anything is written (exit 4)', () => {
  const target = tmpTarget('unknown');
  const r = forge('rt-unknown-delegate', target, '--delegates', 'definitely-not-an-agent');
  assert.equal(r.status, 4, `expected exit 4, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /delegate agent\(s\) not found/);
  assert.equal(existsSync(join(target, 'bin')), false, 'nothing may be written on a bad selection');
  cleanup('rt-unknown-delegate', target);
});

// ---------------------------------------------------------------------------
// What travels
// ---------------------------------------------------------------------------

test('no delegate travels unless it is named', () => {
  const target = tmpTarget('none');
  try {
    const r = forge('rt-no-delegates', target);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(target, '.sidekicks', 'agents')), false,
      'a runtime forged without --delegates must carry no agent store at all');
    assert.deepEqual(agentUnits(target), {}, 'no agent unit may be recorded');
    assert.equal(readFileSync(join(target, 'CLAUDE.md'), 'utf8').includes('Delegate agents in this runtime'),
      false, 'the generated CLAUDE.md must not grow an empty delegate section');
    assert.equal(inherit('verify', '--name', 'rt-no-delegates').status, 0, 'verify must stay clean');
  } finally {
    cleanup('rt-no-delegates', target);
  }
});

test('a selected delegate travels as charter + routines only — never memory, runtime state or the bridge', (t) => {
  const [agent] = sourceDelegates();
  if (!agent) return t.skip('this repo carries no delegate agent to inherit');
  const target = tmpTarget('surface');
  try {
    const r = forge('rt-surface', target, '--delegates', agent);
    assert.equal(r.status, 0, r.stderr);

    const dir = join(target, '.sidekicks', 'agents', agent);
    assert.ok(existsSync(join(dir, 'agent.yaml')), 'the charter must travel');
    assert.equal(existsSync(join(dir, 'memory')), false,
      'memory/ must NOT travel without --delegate-memory — it records the source repo\'s decisions');
    assert.equal(existsSync(join(dir, 'runtime')), false,
      'runtime/ is per-clone volatile state and must never travel');
    assert.equal(existsSync(join(target, '.sidekicks', 'agents', '.bridge')), false,
      '.bridge/ holds the bridge token and Telegram credentials and must never travel');

    const unit = agentUnits(target)[`agents/${agent}`];
    assert.ok(unit, 'the agent must be recorded as a manifest unit');
    assert.equal(unit.include_memory, false);
    assert.equal(unit.kind, 'agent');
    assert.ok(Object.keys(unit.files).includes('agent.yaml'), 'the baseline must cover the charter');
    assert.equal(Object.keys(unit.files).some((f) => f.startsWith('runtime/')), false,
      'the baseline must not cover runtime state');

    const claude = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
    assert.match(claude, /## Delegate agents in this runtime/);
    assert.ok(claude.includes(`\`${agent}\``), 'the agent must appear in the generated CLAUDE.md');

    // The runtime's OWN CLI must see the inherited agent — a copied charter that the runtime cannot
    // enumerate is not an inherited agent.
    const list = spawnSync(process.execPath, [join(target, 'bin', 'sidekicks'), 'agent', 'list'],
      { cwd: target, encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.ok((list.stdout ?? '').includes(agent), 'the runtime\'s own CLI must list the agent');

    assert.equal(inherit('verify', '--name', 'rt-surface').status, 0, 'verify must be clean');
  } finally {
    cleanup('rt-surface', target);
  }
});

test('--delegate-memory opts memory in and records that it did', (t) => {
  const withMemory = sourceDelegates().find((a) => existsSync(join(agentsRoot, a, 'memory')));
  if (!withMemory) return t.skip('no delegate agent in this repo carries a memory store');
  const target = tmpTarget('memory');
  try {
    const r = forge('rt-memory', target, '--delegates', withMemory, '--delegate-memory');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(target, '.sidekicks', 'agents', withMemory, 'memory')),
      'memory/ must travel when it was asked for');
    const unit = agentUnits(target)[`agents/${withMemory}`];
    assert.equal(unit.include_memory, true, 'the stance must be recorded, not inferred later');
    assert.ok(Object.keys(unit.files).some((f) => f.startsWith('memory/')),
      'the drift baseline must cover the memory that travelled');
  } finally {
    cleanup('rt-memory', target);
  }
});

test('--all-delegates inherits every agent the source carries', (t) => {
  const all = sourceDelegates();
  if (all.length < 2) return t.skip('needs at least two delegate agents in the source repo');
  const target = tmpTarget('all');
  try {
    const r = forge('rt-all', target, '--all-delegates');
    assert.equal(r.status, 0, r.stderr);
    const units = Object.keys(agentUnits(target)).map((k) => k.slice('agents/'.length)).sort();
    assert.deepEqual(units, all, 'every source agent must be inherited and recorded');
    assert.equal(existsSync(join(target, '.sidekicks', 'agents', '.bridge')), false,
      '--all-delegates must not sweep the bridge in');
  } finally {
    cleanup('rt-all', target);
  }
});

// ---------------------------------------------------------------------------
// Drift, patch and the bridge floor
// ---------------------------------------------------------------------------

test('drift ignores runtime state, reports a locally amended charter, and patch holds it back', (t) => {
  const [agent] = sourceDelegates();
  if (!agent) return t.skip('this repo carries no delegate agent to inherit');
  const target = tmpTarget('drift');
  try {
    assert.equal(forge('rt-drift', target, '--delegates', agent).status, 0);

    const clean = inherit('drift', '--name', 'rt-drift', '--json');
    assert.equal(clean.status, 0, 'a fresh forge must be clean');
    const payload = JSON.parse(clean.stdout);
    assert.equal(payload.delegates.length, 1);
    assert.equal(payload.delegates[0].status, 'up-to-date');

    // What a live delegate writes in the runtime: presence, control gate, mailbox, threads.
    const rtState = join(target, '.sidekicks', 'agents', agent, 'runtime', 'inbox');
    mkdirSync(rtState, { recursive: true });
    writeFileSync(join(rtState, 'msg-1.json'), '{"from":"someone"}', 'utf8');
    const stillClean = inherit('drift', '--name', 'rt-drift', '--json');
    assert.equal(stillClean.status, 0, 'runtime/ state must not register as drift');
    assert.equal(JSON.parse(stillClean.stdout).delegates[0].status, 'up-to-date');

    // An agent created in the runtime is untracked, never touched.
    const local = join(target, '.sidekicks', 'agents', 'made-here');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'agent.yaml'), 'schema: agent-charter/v1\nname: made-here\n', 'utf8');

    // A charter amended in the runtime: reported, and held back by patch.
    appendFileSync(join(target, '.sidekicks', 'agents', agent, 'agent.yaml'), '\n# amended here\n', 'utf8');
    const dirty = inherit('drift', '--name', 'rt-drift', '--json');
    assert.equal(dirty.status, 10, 'drift must exit 10 when something is not up to date');
    const byName = Object.fromEntries(JSON.parse(dirty.stdout).delegates.map((d) => [d.name, d.status]));
    assert.equal(byName[agent], 'local-only');
    assert.equal(byName['made-here'], 'untracked');

    const patched = inherit('patch', '--name', 'rt-drift');
    assert.equal(patched.status, 10, 'a held-back unit must exit 10');
    assert.match(patched.stdout, /held back/);
    assert.ok(readFileSync(join(target, '.sidekicks', 'agents', agent, 'agent.yaml'), 'utf8')
      .includes('# amended here'), 'the local amendment must survive an unforced patch');

    // --force overwrites, but only after backing the runtime's copy up.
    const forced = inherit('patch', '--name', 'rt-drift', '--only', agent, '--force');
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /previous runtime copy saved to/);
    assert.equal(readFileSync(join(target, '.sidekicks', 'agents', agent, 'agent.yaml'), 'utf8')
      .includes('# amended here'), false, '--force must restore the source charter');
    assert.ok(existsSync(join(target, '.sidekicks', 'agents', agent, 'runtime', 'inbox', 'msg-1.json')),
      'a patch must not delete the runtime\'s own agent state');
  } finally {
    cleanup('rt-drift', target);
  }
});

test('verify FAILS when the agent bridge is present in a runtime', (t) => {
  const [agent] = sourceDelegates();
  if (!agent) return t.skip('this repo carries no delegate agent to inherit');
  const target = tmpTarget('bridge');
  try {
    assert.equal(forge('rt-bridge', target, '--delegates', agent).status, 0);
    assert.equal(inherit('verify', '--name', 'rt-bridge').status, 0, 'clean forge must verify clean');

    const bridge = join(target, '.sidekicks', 'agents', '.bridge', 'runtime');
    mkdirSync(bridge, { recursive: true });
    writeFileSync(join(bridge, 'bridge.json'), '{"token":"planted"}', 'utf8');

    const r = inherit('verify', '--name', 'rt-bridge');
    assert.equal(r.status, 12, 'a bridge in the runtime must fail verify');
    assert.match(r.stdout, /\.bridge\/ is present/);
    assert.match(r.stdout, /token/, 'the failure must say why it matters');

    // A tracked agent whose charter is gone is a verify failure too, not only a drift row.
    rmSync(join(target, '.sidekicks', 'agents', '.bridge'), { recursive: true, force: true });
    rmSync(join(target, '.sidekicks', 'agents', agent), { recursive: true, force: true });
    const missing = inherit('verify', '--name', 'rt-bridge');
    assert.equal(missing.status, 12);
    assert.match(missing.stdout, /recorded in the manifest but absent|absent from the runtime/);
  } finally {
    cleanup('rt-bridge', target);
  }
});

// ---------------------------------------------------------------------------
// Exactness
// ---------------------------------------------------------------------------

test('--prune-delegates makes a re-forge produce exactly the delegate selection', (t) => {
  const all = sourceDelegates();
  if (all.length < 2) return t.skip('needs at least two delegate agents in the source repo');
  const [keep, drop] = all;
  const target = tmpTarget('prune');
  try {
    assert.equal(forge('rt-prune', target, '--delegates', `${keep},${drop}`).status, 0);
    assert.ok(existsSync(join(target, '.sidekicks', 'agents', drop)));

    // Without the flag, a re-forge leaves the earlier agent behind.
    assert.equal(forge('rt-prune', target, '--delegates', keep, '--force').status, 0);
    assert.ok(existsSync(join(target, '.sidekicks', 'agents', drop)),
      'a plain re-forge must not silently delete an agent');

    const r = forge('rt-prune', target, '--delegates', keep, '--force', '--prune-delegates');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pruned \(--prune-delegates/);
    assert.equal(existsSync(join(target, '.sidekicks', 'agents', drop)), false,
      '--prune-delegates must make the set exact');
    assert.deepEqual(Object.keys(agentUnits(target)), [`agents/${keep}`],
      'the pruned agent\'s manifest unit must go with it');
    assert.equal(inherit('verify', '--name', 'rt-prune').status, 0, 'verify must stay clean after a prune');
  } finally {
    cleanup('rt-prune', target);
  }
});

test('add inherits a further delegate and refuses --prune-delegates', (t) => {
  const all = sourceDelegates();
  if (all.length < 2) return t.skip('needs at least two delegate agents in the source repo');
  const [first, second] = all;
  const target = tmpTarget('add');
  try {
    assert.equal(forge('rt-add', target, '--delegates', first).status, 0);

    const added = inherit('add', '--name', 'rt-add', '--delegates', second, '--no-venv');
    assert.equal(added.status, 0, added.stderr);
    assert.ok(existsSync(join(target, '.sidekicks', 'agents', second, 'agent.yaml')));
    assert.deepEqual(Object.keys(agentUnits(target)).sort(),
      [`agents/${first}`, `agents/${second}`].sort());
    assert.ok(readFileSync(join(target, 'CLAUDE.md'), 'utf8').includes(`\`${second}\``),
      'CLAUDE.md must be regenerated with the added agent');

    const refused = inherit('add', '--name', 'rt-add', '--delegates', first, '--prune-delegates');
    assert.equal(refused.status, 2, 'add must refuse the create-only prune flag');
    assert.match(refused.stderr, /--prune-delegates is a 'create' flag/);
  } finally {
    cleanup('rt-add', target);
  }
});

// ---------------------------------------------------------------------------
// The delegate operating surface (runner, LaunchAgent installers, tray, plists)
// ---------------------------------------------------------------------------

const OPS_FILES = [
  'start-agent-delegate.sh',
  'install-delegate-launchagent.sh',
  'uninstall-delegate-launchagent.sh',
  'agent-tray.sh',
];

test('carrying a delegate agent claims the scripts that start and supervise it', (t) => {
  const [agent] = sourceDelegates();
  if (!agent) return t.skip('this repo carries no delegate agent to inherit');
  const target = tmpTarget('ops');
  try {
    assert.equal(forge('rt-ops', target, '--delegates', agent).status, 0);

    for (const f of OPS_FILES) {
      const p = join(target, 'scripts', f);
      assert.ok(existsSync(p), `${f} must travel with a delegate agent`);
      // A wrapper that lost its executable bit is a wrapper nobody can run.
      assert.ok((statSync(p).mode & 0o111) !== 0, `${f} must stay executable`);
    }
    assert.ok(existsSync(join(target, 'scripts', 'launchd', 'com.sidekicks.agent-delegate.plist')),
      'the delegate plist template must travel');
    assert.ok(existsSync(join(target, 'scripts', 'launchd', 'com.sidekicks.agent-tray.plist')),
      'the tray plist template must travel');

    // The plists are token templates — a plist carrying a machine-absolute path would pin the
    // runtime to whoever forged it.
    for (const p of ['com.sidekicks.agent-delegate.plist', 'com.sidekicks.agent-tray.plist']) {
      const text = readFileSync(join(target, 'scripts', 'launchd', p), 'utf8');
      assert.ok(text.includes('__REPO_ROOT__'), `${p} must keep its __REPO_ROOT__ token`);
      assert.equal(/<string>\/Users\//.test(text), false, `${p} must carry no absolute path`);
    }

    // The wrapper's own contract: refuse with usage when handed no agent.
    const noArgs = spawnSync('sh', [join(target, 'scripts', 'start-agent-delegate.sh')], {
      cwd: target, encoding: 'utf8',
    });
    assert.equal(noArgs.status, 2, 'the wrapper must refuse a missing agent name');
    assert.match(noArgs.stderr, /usage: scripts\/start-agent-delegate\.sh/);

    // And it must reach the RUNTIME's own CLI (it resolves its root from its own location, so a
    // wrapper bound to the source repo would answer about the source's agents instead). The verdict
    // is deliberately not asserted: a charter with unmet preconditions of its own — a bound primary
    // mission needing the journal store, say — legitimately exits 2 here, and that is the CLI
    // talking, which is exactly what this checks.
    // A runtime deliberately does not inherit the source checkout's concrete tier→model
    // registry: those IDs belong to the destination machine/account. This assertion exercises the
    // wrapper path, not registry provisioning, so temporarily make a tier-based charter launchable
    // without that unrelated local configuration. Restore it before verify so drift remains clean.
    const runtimeCharter = join(target, '.sidekicks', 'agents', agent, 'agent.yaml');
    const inheritedCharter = readFileSync(runtimeCharter, 'utf8');
    const launchableCharter = inheritedCharter.replace(
      /^model:\s*(?:top|high|mid|low)\s*$/m,
      'model: inherit-wrapper-test-model',
    );
    writeFileSync(runtimeCharter, launchableCharter);
    const dry = spawnSync('sh', [join(target, 'scripts', 'start-agent-delegate.sh'), agent], {
      cwd: target, encoding: 'utf8', env: { ...process.env, SIDEKICKS_AGENT_START_NO_EXEC: '1' },
    });
    writeFileSync(runtimeCharter, inheritedCharter);
    const said = `${dry.stdout}${dry.stderr}`;
    assert.ok([0, 2].includes(dry.status), `unexpected wrapper exit ${dry.status}: ${said}`);
    assert.ok(said.includes(agent), `the wrapper must act on the agent it was given: ${said}`);
    assert.match(said, /headless \(delegate runner\)|agent start|agent daemon/,
      'the output must come from the runtime\'s own agent-lifecycle CLI');

    assert.equal(inherit('verify', '--name', 'rt-ops').status, 0, 'verify must be clean');
  } finally {
    cleanup('rt-ops', target);
  }
});

test('a runtime with no delegate agents still carries every operating script', () => {
  const target = tmpTarget('noops');
  try {
    assert.equal(forge('rt-noops', target).status, 0);
    for (const f of [...OPS_FILES, join('launchd', 'com.sidekicks.agent-tray.plist')]) {
      assert.equal(existsSync(join(target, 'scripts', f)), existsSync(join(repoRoot, 'scripts', f)),
        `${f} travels as root structure even when no delegate is selected`);
    }
    assert.equal(inherit('verify', '--name', 'rt-noops').status, 0, 'verify must stay clean');
  } finally {
    cleanup('rt-noops', target);
  }
});

test('verify FAILS when a delegate-carrying runtime lost an operating script', (t) => {
  const [agent] = sourceDelegates();
  if (!agent) return t.skip('this repo carries no delegate agent to inherit');
  const target = tmpTarget('opsgone');
  try {
    assert.equal(forge('rt-opsgone', target, '--delegates', agent).status, 0);
    rmSync(join(target, 'scripts', 'start-agent-delegate.sh'), { force: true });

    const r = inherit('verify', '--name', 'rt-opsgone');
    assert.equal(r.status, 12, 'a missing operating script must fail verify');
    assert.match(r.stdout, /carries delegate agents but not the scripts that operate them/);
    assert.match(r.stdout, /start-agent-delegate\.sh/);

    // The repair path the failure names must actually repair it.
    const repaired = inherit('add', '--name', 'rt-opsgone', '--delegates', agent, '--no-venv');
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.match(repaired.stdout, /re-registering the scripts surface/);
    assert.ok(existsSync(join(target, 'scripts', 'start-agent-delegate.sh')));
    assert.equal(inherit('verify', '--name', 'rt-opsgone').status, 0, 'verify must be clean again');
  } finally {
    cleanup('rt-opsgone', target);
  }
});

test('verify FAILS when an untracked on-disk agent has lost its operating scripts', () => {
  // The re-forge SKILL.md itself recommends — `create --force --prune-skills` without repeating
  // --delegates — leaves the charters on disk and empties `units`, and rebuilds scripts/ from the
  // command line (exact: true). Gating check 10 on the manifest alone let that land a runtime that
  // holds agents it cannot start and supervise, and report itself clean. The release path
  // (scripts/framework-core-publish.mjs) runs exactly that shape and gates on verify.
  const target = tmpTarget('untracked-ops');
  try {
    const forged = forge('rt-untracked-ops', target);
    assert.equal(forged.status, 0, forged.stderr);
    assert.equal(inherit('verify', '--name', 'rt-untracked-ops').status, 0,
      'a runtime with no agents at all must verify clean');
    assert.equal(existsSync(join(target, 'scripts', 'start-agent-delegate.sh')), true,
      'the operating script travels with the complete root structure');
    rmSync(join(target, 'scripts', 'start-agent-delegate.sh'));

    // An agent the manifest does not track, exactly as a --force re-forge or a runtime-side
    // `agent create` leaves one.
    const local = join(target, '.sidekicks', 'agents', 'made-here');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'agent.yaml'), 'schema: agent-charter/v1\nname: made-here\n', 'utf8');
    assert.deepEqual(agentUnits(target), {}, 'the planted agent must be manifest-untracked');

    const r = inherit('verify', '--name', 'rt-untracked-ops');
    assert.equal(r.status, 12, 'an on-disk agent without its operating scripts must fail verify');
    assert.match(r.stdout, /carries delegate agents but not the scripts that operate them/);
    assert.match(r.stdout, /start-agent-delegate\.sh/);
  } finally {
    cleanup('rt-untracked-ops', target);
  }
});

test('a planted .bridge still fails verify after the DENY set stopped denying "agents"', () => {
  // Regression guard on the DENY change: "agents" left the deny set, ".bridge" and "memory" did
  // not. The bridge carries the bridge token and the Telegram bot_token/chat_id, so its exit-12
  // check must be entirely independent of what happened to the agents segment.
  const target = tmpTarget('bridge-floor');
  try {
    const forged = forge('rt-bridge-floor', target);
    assert.equal(forged.status, 0, forged.stderr);
    assert.equal(inherit('verify', '--name', 'rt-bridge-floor').status, 0, 'clean forge verifies clean');

    const bridge = join(target, '.sidekicks', 'agents', '.bridge', 'runtime');
    mkdirSync(bridge, { recursive: true });
    writeFileSync(join(bridge, 'bridge.json'), '{"token":"planted"}', 'utf8');

    const r = inherit('verify', '--name', 'rt-bridge-floor');
    assert.equal(r.status, 12, 'a planted bridge must still fail verify with exit 12');
    assert.match(r.stdout, /\.bridge\/ is present/);
  } finally {
    cleanup('rt-bridge-floor', target);
  }
});

test('dropping "agents" from DENY did not open a bulk copy of .sidekicks/agents/', () => {
  // The bulk copy is now held back structurally — .sidekicks is not a copy surface and a delegate
  // travels only through inheritDelegates' explicit per-surface list. This asserts that directly,
  // because the deny entry that used to be the belt is gone.
  const target = tmpTarget('nobulk');
  try {
    const forged = forge('rt-nobulk', target);
    assert.equal(forged.status, 0, forged.stderr);
    assert.equal(existsSync(join(target, '.sidekicks', 'agents')), false,
      'a runtime forged without --delegates must carry no .sidekicks/agents content at all');
    // "memory" is still a bare DENY segment. The runtime scaffolds its OWN empty store, so the
    // assertion is that none of the SOURCE's decision entries travelled into it.
    const rtMemory = join(target, '.sidekicks', 'memory');
    const inherited = existsSync(rtMemory) ? readdirSync(rtMemory) : [];
    const sourceEntries = readdirSync(join(repoRoot, '.sidekicks', 'memory'))
      .filter((e) => e !== 'MEMORY.md');
    assert.deepEqual(inherited.filter((e) => sourceEntries.includes(e)), [],
      'the source repo\'s memory entries must still never travel');
  } finally {
    cleanup('rt-nobulk', target);
  }
});

test('an add with nothing new still says so when the operating surface is intact', (t) => {
  const [agent] = sourceDelegates();
  if (!agent) return t.skip('this repo carries no delegate agent to inherit');
  const target = tmpTarget('noop-add');
  try {
    assert.equal(forge('rt-noop-add', target, '--delegates', agent).status, 0);
    const r = inherit('add', '--name', 'rt-noop-add', '--delegates', agent, '--no-venv');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to add/);
    assert.equal(/re-registering the scripts surface/.test(r.stdout), false,
      'a healthy runtime must not be rewritten by a no-op add');
  } finally {
    cleanup('rt-noop-add', target);
  }
});

// ---------------------------------------------------------------------------
// Documentation drift
// ---------------------------------------------------------------------------

test('internal delegate transport keeps explicit flags and the bridge deny boundary', () => {
  const source = ['forge.mjs', 'select.mjs'].map(file =>
    readFileSync(join(repoRoot, 'lib', 'core-forge', file), 'utf8')).join('\n');
  for (const flag of ['delegates', 'all-delegates', 'delegate-memory', 'prune-delegates'])
    assert.ok(source.includes(flag), flag);
  const shared = readFileSync(join(repoRoot, 'lib', 'core-forge', '_shared.mjs'), 'utf8');
  assert.match(shared, /\.bridge/);
});
