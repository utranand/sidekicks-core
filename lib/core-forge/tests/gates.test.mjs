import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync,symlinkSync,realpathSync } from 'node:fs';
import { join,dirname } from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import { targetIsOwnRepo } from '../_release-shared.mjs';
import {repoRoot,SCRIPT_REL,RELEASE_REL,SERVICE_REL,SRC_REL,RUN_REL,INHERIT_REL,git,fixture,run,unit,writeStubEngine,writeTargetCli,cleanup,seedCoreTestGate,publishable} from './release-fixtures.mjs';
function publishableThen(f, opts) {
  writeStubEngine(f.dir, { skills: ['alpha'], ...opts });
  return f.dir;
}

test('own-repository detection resolves aliases without accepting a nested plain directory',t=>{
  const base=mkdtempSync(join(tmpdir(),'core-repo-identity-'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  const repo=join(base,'repo'),alias=join(base,'alias'),nested=join(repo,'nested');
  mkdirSync(repo);git(repo,['init','-q']);mkdirSync(nested);
  symlinkSync(realpathSync(repo),alias,process.platform==='win32'?'junction':'dir');
  for(const target of [repo,realpathSync(repo),alias])
    assert.equal(targetIsOwnRepo({ROOT:base,SRC_ABS:target}),true,target);
  assert.equal(targetIsOwnRepo({ROOT:base,SRC_ABS:nested}),false,
    'git walking up from an ordinary directory does not make it an independent repository');
});
test('publish runs every gate and records them in the log entry', () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.equal(r.status, 0, r.out + r.err);
    for (const gate of ['inherit verify', 'config doctor', 'framework doctor', 'post-forge drift', 'mount check']) {
      assert.match(r.out, new RegExp(gate.replace(/ /g, '\\s')), `gate '${gate}' must run and be reported`);
    }
    const log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    assert.match(log, /\*\*Verification gates\*\*/);
    assert.match(log, /inherit verify — pass/);
  } finally {
    cleanup(f);
  }
});

for (const [label, opts, expect] of [
  ['inherit verify', { verifyExit: 12 }, /inherit verify FAILED/],
  ['a doctor inside the core', { doctorExit: 1 }, /doctor FAILED/],
  ['post-forge drift', { driftExit: 10 }, /post-forge drift FAILED/],
]) {
  test(`a failing gate (${label}) aborts before the log is written`, () => {
    const f = publishable(opts);
    try {
      const r = run(f.dir, ['publish']);
      assert.notEqual(r.status, 0);
      assert.match(r.err, expect);
      assert.ok(
        !existsSync(join(f.dir, RUN_REL, 'release-log.md')),
        'a core that does not verify is not a release — the log must not claim it'
      );
      assert.ok(!existsSync(join(f.dir, RUN_REL, 'state.json')));
    } finally {
      cleanup(f);
    }
  });
}

// ── The composition gate ───────────────────────────────────────────────────────────────────────
// Every other gate asks whether the artifact WORKS. This one asks whether it is the RIGHT artifact,
// and the two came apart badly: a core forged from a policy nobody re-read shipped 43 skills with
// every skill's improvement funnel inside, and all six gates were green.

test('publish reports the composition gate alongside the others', () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /composition/, 'the gate must be reported, not silently satisfied');
    assert.match(readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8'), /composition — pass/);
  } finally {
    cleanup(f);
  }
});

for (const [label, opts, expect] of [
  [
    'a development surface reached the runtime',
    { shipDevSurfaces: ['improvements'] },
    /development surfaces shipped: alpha\/improvements\//,
  ],
  [
    'the forged skill set is not the one the plan resolved',
    { forgeExtraSkills: ['smuggled'] },
    /forged but not planned: smuggled/,
  ],
  [
    'a skill carries no inclusion reason',
    { skillReasons: { alpha: [] } },
    /'alpha' carries no inclusion reason/,
  ],
]) {
  test(`the composition gate fails when ${label}`, () => {
    const f = publishable(opts);
    try {
      const r = run(f.dir, ['publish']);
      assert.notEqual(r.status, 0);
      assert.match(r.err, /composition FAILED/);
      assert.match(r.err, expect);
      assert.ok(
        !existsSync(join(f.dir, RUN_REL, 'release-log.md')),
        'a core that is not its own composition is not a release — the log must not claim it'
      );
    } finally {
      cleanup(f);
    }
  });
}

// ── R-8: the log's file lists ──────────────────────────────────────────────────────────────────
// Two lists, two questions. The entry used to answer both with `git diff` over the SOURCE repo,
// which is how v1.4.1's entry named AGENTS.md as shipped while the forged core carried no such
// change. What a release CONTAINS can only come from the forged tree.

test("the log's core-file list comes from the forged tree, not the source diff", () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.equal(r.status, 0, r.out + r.err);
    const log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');

    const core = log.slice(log.indexOf('<summary>Core files</summary>'), log.indexOf('<summary>Source files'));
    const source = log.slice(log.indexOf('<summary>Source files'));

    assert.match(log, /\*\*What this release changed in the core\*\*/);
    // The stub forge writes SUBSTRATE.txt; it exists in no source path and in no git diff.
    assert.match(core, /SUBSTRATE\.txt/, 'a file only the forge writes must appear in the core list');
    assert.doesNotMatch(
      core,
      /lib\/placeholder\.mjs/,
      'a SOURCE path that never reached the forged tree must not be listed as shipped'
    );
    // …and the provenance list still carries it, labelled as the reason rather than the payload.
    assert.match(source, /lib\/placeholder\.mjs/);
    assert.match(log, /the REASON for the release, not its contents/);
  } finally {
    cleanup(f);
  }
});

test('the core-file list marks added, removed and modified paths', () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.equal(r.status, 0, r.out + r.err);
    const log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    // The marker is rewritten by every forge (the version moves), so it is always an M row.
    assert.match(log, /`M \.sidekicks-core\.json`/);
  } finally {
    cleanup(f);
  }
});

test('a re-forge of identical content reports that NOTHING changed in the core', () => {
  const f = publishable();
  try {
    const first = run(f.dir, ['publish', '--no-commit']);
    assert.equal(first.status, 0, first.out + first.err);
    // Re-land the SAME version: the forge reproduces the same tree, so the core diff is empty even
    // though the entry is rewritten. That combination — a release whose source churn never reached
    // the core — is exactly what the two-list split exists to make visible.
    const again = run(f.dir, ['publish', '--version', '1.1.2', '--reland', '--no-commit']);
    assert.equal(again.status, 0, again.out + again.err);
    const log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    assert.match(log, /this release is a re-forge of the same content/);
  } finally {
    cleanup(f);
  }
});

test('a baseline forge lists no core files and says every file is new', () => {
  // No core service at all: nothing on disk to diff the forged tree against.
  const f = fixture({ withService: false });
  try {
    mkdirSync(join(f.dir, SRC_REL), { recursive: true });
    writeStubEngine(f.dir, { skills: ['alpha'] });
    writeTargetCli(f.dir);
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    seedCoreTestGate(f.dir, {});
    const r = run(f.dir, ['publish', '--version', '1.0.0', '--no-commit']);
    assert.equal(r.status, 0, r.out + r.err);
    const log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    assert.match(log, /baseline forge: no previously published core to diff against/);
    assert.doesNotMatch(log, /<summary>Core files<\/summary>/);
  } finally {
    cleanup(f);
  }
});

test('publish --dry-run cannot claim a core diff — nothing has been forged yet', () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['publish', '--dry-run']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.doesNotMatch(
      r.out,
      /What this release changed in the core/,
      'a dry run has no forged tree, so it must not present one'
    );
  } finally {
    cleanup(f);
  }
});

test('--no-tests skips the suite and SAYS SO in the log', () => {
  const f = publishable();
  try {
    mkdirSync(join(f.dir, SRC_REL, 'tests'), { recursive: true });
    const r = run(f.dir, ['publish', '--no-commit', '--no-tests']);
    assert.equal(r.status, 0, r.out + r.err);
    const log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    assert.match(
      log,
      /core test suite — SKIPPED \(--no-tests \(explicit, recorded waiver\)\)/,
      'an omitted gate recorded as omitted is a fact; omitting the row would read as a pass'
    );
  } finally {
    cleanup(f);
  }
});

test('verify gates an already-forged core without publishing anything', () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['verify']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /Every gate passed/);
    assert.ok(!existsSync(join(f.dir, RUN_REL, 'release-log.md')), 'verify publishes nothing');

    const bad = run(publishableThen(f, { verifyExit: 12 }), ['verify']);
    assert.equal(bad.status, 1);
  } finally {
    cleanup(f);
  }
});

// ── F-05: the test gate must be able to fail ───────────────────────────────────────────────────
// v2.0.0 recorded "core test suite — skipped (the core ships no tests/ directory)" while the
// artifact carried 89 real tests under lib/artifacts-lifecycle/tests/, and its own `npm test`
// discovered nothing and exited 0. A gate that cannot notice either of those is not a gate.

test('a core that ships no test launcher FAILS the gate instead of skipping it', () => {
  const f = fixture();
  writeStubEngine(f.dir, { skills: ['alpha'], shipLauncher: false, shipTests: false });
  writeTargetCli(f.dir, {});
  unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
  unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
  git(f.dir, ['add', '-A']);
  git(f.dir, ['commit', '-q', '-m', 'feat(lib): core-bound']);
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.notEqual(r.status, 0, 'a core with no test gate must not publish');
    assert.match(r.out + r.err, /no scripts\/run-tests\.mjs/);
    assert.ok(!existsSync(join(f.dir, RUN_REL, 'release-log.md')),
      'a failed gate writes no log entry');
  } finally {
    cleanup(f);
  }
});

test('a launcher that discovers ZERO tests FAILS the gate — a green empty suite is not a pass', () => {
  const f = fixture();
  writeStubEngine(f.dir, { skills: ['alpha'], shipLauncher: true, shipTests: false });
  writeTargetCli(f.dir, {});
  unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
  unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
  git(f.dir, ['add', '-A']);
  git(f.dir, ['commit', '-q', '-m', 'feat(lib): core-bound']);
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.notEqual(r.status, 0);
    assert.match(r.out + r.err, /discovers ZERO test files/);
  } finally {
    cleanup(f);
  }
});

test('the passing gate records what it actually ran, not just "pass"', () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.equal(r.status, 0, r.out + r.err);
    const log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    assert.match(log, /core test suite — pass \(1 file\(s\) under tests\)/,
      'the count is the evidence the suite was not empty');
  } finally {
    cleanup(f);
  }
});

// ── F-13: local release state must not claim to be published ───────────────────────────────────
