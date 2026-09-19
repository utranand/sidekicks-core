import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync,readdirSync,lstatSync } from 'node:fs';
import { join,dirname } from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import { createHash } from 'node:crypto';
import { commitLocally, createReleaseEngine } from '../release.mjs';
import {repoRoot,SCRIPT_REL,RELEASE_REL,SERVICE_REL,SRC_REL,RUN_REL,INHERIT_REL,git,fixture,run,unit,writeStubEngine,writeTargetCli,cleanup,seedCoreTestGate,publishable} from './release-fixtures.mjs';

test('publish forwards only the explicit protected-branch permission to the forge',async()=>{
  for(const allowed of [false,true]) {
    const f=fixture();
    try {
      if(allowed)git(f.dir,['checkout','-q','-B','main']);
      let received;
      const projection=async(_root,verb,flags)=>{
        if(verb==='plan')return {exitCode:0,stdout:'',payload:{skill_names:['alpha'],
          skills:[{skill:'alpha',reasons:['declared']}],substrate:['lib']}};
        assert.equal(verb,'forge');received=flags['allow-protected'];
        return {exitCode:2,stdout:'',stderr:'intentional fixture stop before mutation'};
      };
      const result=await createReleaseEngine({repoRoot:f.dir,flags:{'allow-protected':allowed},projection}).publish();
      assert.equal(result.exitCode,2,result.stdout+result.stderr);
      assert.equal(received,allowed);
    }finally{cleanup(f);}
  }
});

test('release --yes --dry-run preserves remote refs and release records', () => {
  const f=releasable();
  try {
    const before=git(f.bare,['show-ref']).out;
    const state=readFileSync(join(f.dir,RUN_REL,'state.json'),'utf8');
    const log=readFileSync(join(f.dir,RUN_REL,'release-log.md'),'utf8');
    const r=run(f.dir,['release','--yes','--dry-run']);
    assert.equal(r.status,0,r.out+r.err);
    assert.equal(git(f.bare,['show-ref']).out,before);
    assert.equal(readFileSync(join(f.dir,RUN_REL,'state.json'),'utf8'),state);
    assert.equal(readFileSync(join(f.dir,RUN_REL,'release-log.md'),'utf8'),log);
  }finally{cleanupWithRemote(f);}
});

test('publish commits only managed paths and preserves unrelated staged work in both repos', () => {
  const f=publishable({targetIsRepo:true});
  try {
    git(f.dir,['checkout','-q','-b','chore/scoped-release']);
    const src=join(f.dir,SRC_REL);
    const nested=join(f.dir,'unrelated-repo');mkdirSync(nested);
    git(nested,['init','-q']);git(nested,['config','user.email','test@example.com']);git(nested,['config','user.name','Test']);
    writeFileSync(join(nested,'note.txt'),'before\n');git(nested,['add','note.txt']);git(nested,['commit','-qm','before']);
    git(f.dir,['add','unrelated-repo']);git(f.dir,['commit','-qm','record unrelated gitlink']);
    const committedGitlink=git(f.dir,['ls-tree','HEAD','unrelated-repo']).out;
    writeFileSync(join(nested,'note.txt'),'after\n');git(nested,['commit','-qam','after']);git(f.dir,['add','unrelated-repo']);
    const stagedGitlink=git(f.dir,['ls-files','--stage','unrelated-repo']).out;
    for(const dir of [f.dir,src]) {
      writeFileSync(join(dir,'unrelated.txt'),'staged user work\n');
      git(dir,['add','unrelated.txt']);
    }
    const r=run(f.dir,['publish','--no-mount-check']);
    assert.equal(r.status,0,r.out+r.err);
    assert.equal(git(f.dir,['ls-tree','HEAD','unrelated-repo']).out,committedGitlink);
    assert.equal(git(f.dir,['ls-files','--stage','unrelated-repo']).out,stagedGitlink);
    for(const dir of [f.dir,src]) {
      assert.equal(git(dir,['show',':unrelated.txt']).out,'staged user work');
      assert.notEqual(git(dir,['show','HEAD:unrelated.txt']).status,0);
    }
  }finally{cleanup(f);}
});

test('plain-directory release commits removed managed paths without unrelated staged work', () => {
  const f=fixture();
  try {
    const retired=join(SRC_REL,'retired.txt');
    writeFileSync(join(f.dir,retired),'old managed payload');
    git(f.dir,['add',retired]);git(f.dir,['commit','-qm','seed retired payload']);
    rmSync(join(f.dir,retired));
    writeFileSync(join(f.dir,'unrelated.txt'),'staged user work');
    git(f.dir,['add','unrelated.txt']);
    mkdirSync(join(f.dir,RUN_REL),{recursive:true});
    for(const name of ['state.json','release-log.md'])writeFileSync(join(f.dir,RUN_REL,name),'release fixture');
    const result=commitLocally({ROOT:f.dir,SRC_REL,SRC_ABS:join(f.dir,SRC_REL),
      LOG_REL:join(RUN_REL,'release-log.md'),STATE_REL:join(RUN_REL,'state.json'),RUNTIME_NAME:'fixture',
      plan:{root_structure:{entries:[]}},
      previousRootStructure:{entries:[{path:'retired.txt',kind:'file',included:true}]}},'1.0.0','now');
    assert.equal(result.committed,true,JSON.stringify(result));
    assert.equal(git(f.dir,['ls-tree','HEAD','--',retired]).out,'');
    assert.equal(git(f.dir,['status','--porcelain','--',retired]).out,'');
    assert.equal(git(f.dir,['show',':unrelated.txt']).out,'staged user work');
    assert.notEqual(git(f.dir,['show','HEAD:unrelated.txt']).status,0);
  }finally{cleanup(f);}
});

test('release disables configured followTags in both core and source pushes', () => {
  const f=releasable();
  const sourceRemote=mkdtempSync(join(tmpdir(),'sk-source-origin-'));
  try {
    git(sourceRemote,['init','--bare','-q']);
    git(f.dir,['remote','add','origin',sourceRemote]);
    for(const dir of [f.dir,f.src]) {
      git(dir,['config','push.followTags','true']);
      git(dir,['tag','-a','v8.8.8','-m','unlogged local tag']);
    }
    const r=run(f.dir,['release','--yes']);
    assert.equal(r.status,0,r.out+r.err);
    for(const remote of [f.bare,sourceRemote]) {
      assert.notEqual(git(remote,['rev-parse','--verify','refs/tags/v8.8.8']).status,0);
    }
    assert.equal(git(f.bare,['rev-parse','--verify','refs/tags/v1.0.0']).status,0);
    const branch=git(f.dir,['branch','--show-current']).out;
    assert.equal(git(sourceRemote,['rev-parse','--verify','refs/heads/'+branch]).status,0);
  }finally{cleanupWithRemote(f);rmSync(sourceRemote,{recursive:true,force:true});}
});

test('verify-remote rejects changed served bytes even when tag and branch refs match', () => {
  const f=releasable();
  try {
    const src=join(f.dir,SRC_REL);
    const statePath=join(f.dir,RUN_REL,'state.json');
    const state=JSON.parse(readFileSync(statePath,'utf8'));
    const version=state.last_local_release.version;
    const marker=JSON.parse(readFileSync(join(src,'.sidekicks-core.json'),'utf8'));
    writeFileSync(join(src,'.sidekicks-core.json'),JSON.stringify({...marker,corrupt:true})+'\n');
    git(src,['add','.sidekicks-core.json']);git(src,['commit','-qm','corrupt served artifact']);
    git(src,['tag','-f','v'+version]);
    git(src,['push','-q','origin','chore/core-release','refs/tags/v'+version]);
    const r=run(f.dir,['verify-remote','--json']);
    assert.equal(r.status,1,r.out+r.err);
    const result=JSON.parse(r.out);
    assert.equal(result.checks.find(row=>row.ref==='refs/tags/v'+version).ok,true);
    assert.match(result.checks.find(row=>row.ref==='root_structure').detail,/content mismatch: .sidekicks-core.json/);
    assert.equal(JSON.parse(readFileSync(statePath,'utf8')).remote_verified,null);
  }finally{cleanupWithRemote(f);}
});

test('a remote-only unlogged semver tag blocks release before any push', () => {
  const f=releasable();
  try {
    const src=join(f.dir,SRC_REL);
    git(src,['tag','v8.8.8']);git(src,['push','-q','origin','refs/tags/v8.8.8']);
    git(src,['tag','-d','v8.8.8']);
    const before=git(f.bare,['show-ref']).out;
    const r=run(f.dir,['release','--yes']);
    assert.equal(r.status,8,r.out+r.err);
    assert.match(r.err,/v8.8.8/);
    assert.equal(git(f.bare,['show-ref']).out,before);
  }finally{cleanupWithRemote(f);}
});
test('refuses when the core service is not checked out, naming the submodule fix', () => {
  const f = fixture({ withService: false });
  try {
    const r = run(f.dir, ['status']);
    assert.equal(r.status, 3, r.out + r.err);
    assert.match(r.err, /submodule update --init/);
    assert.match(r.err, /projects\/global\/services\/sidekicks-core\/src/);
  } finally {
    cleanup(f);
  }
});

test('unknown verb exits 2 and lists the real verbs', () => {
  const f = fixture();
  try {
    // 'release' used to stand in for "not a verb" here. It is one now, so the stand-in has to be
    // something that will never become one.
    const r = run(f.dir, ['deploy']);
    assert.equal(r.status, 2);
    assert.match(r.err, /status \| publish \| release \| ship \| verify \| verify-remote \| log/);
  } finally {
    cleanup(f);
  }
});

test('status: in sync when the marker commit is HEAD-equivalent for core-bound paths', () => {
  const f = fixture();
  try {
    // The only commit after the marker's base touched projects/ — not a core-bound path.
    const r = run(f.dir, ['status']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /Committed state is in sync/);
    assert.match(r.out, /No release owed/);
    assert.match(r.out, /published:\s+v1\.1\.1/);
  } finally {
    cleanup(f);
  }
});

test('status: a docs-only commit does not create release debt', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, 'docs', 'guide'), { recursive: true });
    writeFileSync(join(f.dir, 'docs', 'guide', 'thing.md'), '# thing\n');
    git(f.dir, ['add', '-A']);
    git(f.dir, ['commit', '-q', '-m', 'docs: add a guide']);

    const r = run(f.dir, ['status']);
    assert.equal(r.status, 0, r.out);
    assert.match(
      r.out,
      /No release owed/,
      'docs/ does not travel into the core — nagging about it would train the operator to ignore the row'
    );
  } finally {
    cleanup(f);
  }
});

test('status: a committed core-bound change is pending, with its commit listed', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'lib', 'placeholder.mjs'), 'export default 2;\n');
    git(f.dir, ['add', '-A']);
    git(f.dir, ['commit', '-q', '-m', 'fix(lib): change the thing']);

    const r = run(f.dir, ['status']);
    assert.equal(r.status, 10, 'a pending release must exit 10 so a step can gate on it');
    assert.match(r.out, /PENDING: 1 commit\(s\)/);
    assert.match(r.out, /fix\(lib\): change the thing/);
    assert.match(r.out, /next version would be v1\.1\.2/);
  } finally {
    cleanup(f);
  }
});

test('status: an uncommitted core-bound file is reported separately from committed debt', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'lib', 'placeholder.mjs'), 'export default 3;\n'); // not committed
    const r = run(f.dir, ['status']);
    assert.equal(r.status, 10);
    assert.match(r.out, /Committed state is in sync/);
    assert.match(r.out, /UNCOMMITTED: 1 core-bound file\(s\)/);
    assert.match(
      r.out,
      /rebuilt from its own commit/,
      'the consequence, not just the count — this is why it matters'
    );
  } finally {
    cleanup(f);
  }
});

test('status: an untracked core-bound file counts as uncommitted', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'lib', 'brand-new.mjs'), 'export default 1;\n');
    const r = run(f.dir, ['status']);
    assert.equal(r.status, 10);
    assert.match(r.out, /UNCOMMITTED: 1 core-bound file\(s\)/);
    assert.match(r.out, /lib\/brand-new\.mjs/);
  } finally {
    cleanup(f);
  }
});

test('status --json exposes the same numbers machine-readably', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'lib', 'placeholder.mjs'), 'export default 4;\n');
    git(f.dir, ['add', '-A']);
    git(f.dir, ['commit', '-q', '-m', 'chore(lib): tweak']);

    const r = run(f.dir, ['status', '--json']);
    const st = JSON.parse(r.out);
    assert.equal(st.published_version, '1.1.1');
    assert.equal(st.next_version, '1.1.2');
    assert.equal(st.pending_commits, 1);
    assert.equal(st.uncommitted_core_files, 0);
    assert.equal(st.version_agrees, true);
    assert.ok(st.core_bound_path_count > 0);
    assert.ok(
      !/^\//.test(st.target) && !/^[A-Za-z]:/.test(st.target),
      'persisted/reported paths must be repo-relative, never machine-absolute'
    );
  } finally {
    cleanup(f);
  }
});

for (const [bump, expected] of [
  ['patch', '1.1.2'],
  ['minor', '1.2.0'],
  ['major', '2.0.0'],
]) {
  test(`--bump ${bump} derives v${expected} from the forged marker`, () => {
    const f = fixture();
    try {
      const r = run(f.dir, ['status', '--bump', bump, '--json']);
      assert.equal(JSON.parse(r.out).next_version, expected);
    } finally {
      cleanup(f);
    }
  });
}

test('--version overrides the bump', () => {
  const f = fixture();
  try {
    const r = run(f.dir, ['status', '--version', '3.0.0-rc1', '--json']);
    assert.equal(JSON.parse(r.out).next_version, '3.0.0-rc1');
  } finally {
    cleanup(f);
  }
});

test('publish --dry-run writes nothing and shows the version it would stamp', () => {
  const f = fixture();
  try {
    const r = run(f.dir, ['publish', '--dry-run']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /dry run — nothing written/);
    assert.match(r.out, /--core-version 1\.1\.2/, 'the stamped version must be visible before running');
    assert.match(r.out, /--prune-skills/, 'the forge must stay exact — a stale skill would ship');
    assert.ok(
      !existsSync(join(f.dir, RUN_REL, 'release-log.md')),
      'a dry run must not create the release log'
    );
    assert.ok(!existsSync(join(f.dir, RUN_REL, 'state.json')));
  } finally {
    cleanup(f);
  }
});

// The published core is the CLI substrate plus the dynamically resolved framework runtime.
// Two halves, and each one silently breaks the release if it drifts: the preset decides what
// travels, and --as-core decides whether the thing is mountable at all. The engine turns --as-core
// on by itself for `--preset framework`, but the publisher passes it explicitly so an override can
// never drop the marker, installers, framework instructions, or generated README. Both are asserted
// here because both are invisible in a passing forge.
test('the forge carries the framework runtime and is explicitly marked as a core', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['sk-hello', 'skill-creator'] });
    const r = run(f.dir, ['publish', '--dry-run']);
    assert.equal(r.status, 0, r.err);
    assert.match(
      r.out,
      /--preset framework\b/,
      'the published core carries the dynamically resolved framework runtime by default'
    );
    assert.match(
      r.out,
      /--as-core\b/,
      '--as-core must remain explicit so a preset override cannot drop the core distribution'
    );
    assert.match(
      r.out,
      /--pack-skills none\b/,
      'a published core ships pack METADATA and lets the consumer import the skills — both pack.yaml '
      + 'files say the skills they declare are never bundled, and `agent pack install` already '
      + 'refuses before writing with the exact import commands'
    );
    assert.match(r.out, /sk-hello\s+\[declared, required-floor\]/);
    assert.match(r.out, /skill-creator\s+\[declared\]/);
  } finally {
    cleanup(f);
  }
});

test('--preset core overrides the framework default, and the core marking survives it', () => {
  const f = fixture();
  try {
    const r = run(f.dir, ['publish', '--preset', 'core', '--dry-run']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /--preset core\b/, 'the legacy floor-only core must stay one flag away');
    assert.match(r.out, /--as-core\b/);
  } finally {
    cleanup(f);
  }
});

test('publish --dry-run records shipped-but-uncommitted files in the entry it would write', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'lib', 'placeholder.mjs'), 'export default 9;\n');
    const r = run(f.dir, ['publish', '--dry-run']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /WARNING: the working tree is dirty/);
    assert.match(
      r.out,
      /Shipped but uncommitted at forge time/,
      'the log entry must record it — a release that shipped uncommitted work must say so'
    );
    assert.match(r.out, /lib\/placeholder\.mjs/);
  } finally {
    cleanup(f);
  }
});

test('publish refuses when the release log and the forged marker disagree on the version', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, RUN_REL), { recursive: true });
    writeFileSync(
      join(f.dir, RUN_REL, 'state.json'),
      JSON.stringify(
        { schema: 1, last_publish: { version: '1.4.0', source_commit: f.base } },
        null,
        2
      ) + '\n'
    );
    const r = run(f.dir, ['publish']);
    assert.equal(r.status, 3, r.out + r.err);
    assert.match(r.err, /version mismatch/);
    assert.match(r.err, /pass --version/);

    // The mismatch is also visible in status, so it is caught before a publish is attempted.
    const s = run(f.dir, ['status']);
    assert.match(s.out, /MISMATCH/);
    assert.equal(JSON.parse(run(f.dir, ['status', '--json']).out).version_agrees, false);
  } finally {
    cleanup(f);
  }
});

test('a marker AHEAD of the log is a resumed attempt, not a hand forge', () => {
  const f = fixture({ markerVersion: '1.2.0' });
  try {
    // The exact state an aborted publish leaves behind: the forge ran and stamped 1.2.0, then a gate
    // failed, so no log entry was written and state.json still records 1.1.5. Deriving the next
    // version from the MARKER here would climb one on every retry while the log stayed at 1.1.5.
    mkdirSync(join(f.dir, RUN_REL), { recursive: true });
    writeFileSync(
      join(f.dir, RUN_REL, 'state.json'),
      JSON.stringify({ schema: 1, last_publish: { version: '1.1.5', source_commit: f.base } }, null, 2) + '\n'
    );

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.resumed_attempt, true);
    assert.equal(st.version_conflict, false);
    assert.equal(st.next_version, '1.1.6', 'the aborted number is reused, derived from the LOG');
    assert.match(run(f.dir, ['status']).out, /RESUMING/);

    const r = run(f.dir, ['publish', '--dry-run']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /--core-version 1\.1\.6/);
    assert.match(r.out, /resume:/);
  } finally {
    cleanup(f);
  }
});

test('a marker BEHIND the log is still a hard stop — the tree is older than the log claims', () => {
  const f = fixture({ markerVersion: '1.1.1' });
  try {
    mkdirSync(join(f.dir, RUN_REL), { recursive: true });
    writeFileSync(
      join(f.dir, RUN_REL, 'state.json'),
      JSON.stringify({ schema: 1, last_publish: { version: '1.4.0', source_commit: f.base } }, null, 2) + '\n'
    );
    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.version_conflict, true);
    assert.equal(st.resumed_attempt, false);
    assert.equal(run(f.dir, ['publish']).status, 3);
  } finally {
    cleanup(f);
  }
});

test('an explicit --version resolves a marker/log mismatch instead of being blocked by it', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.dir, RUN_REL), { recursive: true });
    writeFileSync(
      join(f.dir, RUN_REL, 'state.json'),
      JSON.stringify(
        { schema: 1, last_publish: { version: '1.4.0', source_commit: f.base } },
        null,
        2
      ) + '\n'
    );
    const r = run(f.dir, ['publish', '--version', '1.5.0', '--dry-run']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /--core-version 1\.5\.0/);
  } finally {
    cleanup(f);
  }
});

test('log reports the absence of a log rather than failing', () => {
  const f = fixture();
  try {
    const r = run(f.dir, ['log']);
    assert.equal(r.status, 0);
    assert.match(r.out, /no release log yet/);
  } finally {
    cleanup(f);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Target resolution — the core is no longer a hard-coded path
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('--target forges elsewhere, and its run state lands outside the forge', () => {
  const f = fixture();
  try {
    const other = join(f.dir, 'cores', 'edge');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, '.sidekicks-core.json'),
      JSON.stringify({ schema: 1, name: 'edge', version: '2.0.0', layout: 1, source_commit: f.base }, null, 2) + '\n'
    );

    const st = JSON.parse(run(f.dir, ['status', '--target', 'cores/edge', '--json']).out);
    assert.equal(st.published_version, '2.0.0', 'the version comes from the TARGET marker, not the default core');
    assert.equal(st.target, 'cores/edge');
    // Not `cores/edge/artifacts/…`: a forge does `create --force`, which wipes the target, so run
    // state inside it would be destroyed by the very release it records.
    assert.equal(st.run_state, 'artifacts/runs/edge/core-forge');
    assert.ok(!/^\//.test(st.run_state), 'run state must be reported repo-relative');
  } finally {
    cleanup(f);
  }
});

test('a service-shaped target keeps its run state at the service root', () => {
  const f = fixture();
  try {
    const st = JSON.parse(run(f.dir, ['status', '--target', SRC_REL, '--json']).out);
    assert.equal(
      st.run_state,
      'projects/global/services/sidekicks-core/artifacts/runs/core-forge',
      'a service artifacts base is the service ROOT, never its src/'
    );
  } finally {
    cleanup(f);
  }
});

test('the runtime name is derived from the target rather than reused', () => {
  const f = fixture();
  try {
    const other = join(f.dir, 'cores', 'edge', 'src');
    mkdirSync(other, { recursive: true });
    const st = JSON.parse(run(f.dir, ['status', '--target', 'cores/edge/src', '--json']).out);
    // `src` is a container, not an identity — two cores sharing one name would share a drift
    // baseline, and the second would describe the first one's tree.
    assert.equal(st.runtime, 'edge');
  } finally {
    cleanup(f);
  }
});

test('a missing target is refused before anything is read', () => {
  const f = fixture();
  try {
    const r = run(f.dir, ['status', '--target', 'cores/nope']);
    assert.equal(r.status, 3);
    assert.match(r.err, /not present at cores\/nope/);
  } finally {
    cleanup(f);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Bump classification — which number moves, and why
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the composition comes from the engine as JSON, not from parsing its prose', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha', 'beta'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'beta', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.surface_source, 'core plan --json');
    assert.match(st.bump_reasons.join('; '), /skill added: beta/);
    // The three facts the old prose parser could not carry at all.
    assert.equal(st.pack_skills, 'none');
    assert.equal(st.payload.totals.copied_files, 2);
    assert.deepEqual(st.policy_violations, []);
  } finally {
    cleanup(f);
  }
});

test('inherit plan CRLF output remains authoritative on Windows', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'], planCrlf: true });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.surface_source, 'core plan --json');
    assert.deepEqual(st.skill_selection_reasons.alpha, ['declared', 'required-floor']);
  } finally {
    cleanup(f);
  }
});

// Two shapes, one refusal. "Unparseable" used to mean prose a regex did not match; it now means
// the engine did not state a composition. Both must fail closed rather than silently fall back to
// the hard-coded substrate list, because that fallback reports `skills: null` and the classifier
// reads null as "we could not look" — which is how a release ships an unexamined skill set.
for (const [label, planStdout] of [
  ['output that is not JSON at all', 'plan for runtime x\n  alpha  active\n'],
  ['JSON that names no composition', '{"schema":1,"skills":[]}'],
]) {
  test(`a plan producing ${label} fails closed instead of substituting a fallback surface`, () => {
    const f = fixture();
    try {
      writeStubEngine(f.dir, { skills: ['alpha'], planStdout });
      unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
      unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');

      const result = run(f.dir, ['status', '--json']);
      assert.equal(result.status, 4);
      assert.match(result.err, /cannot resolve framework-core composition from core plan/);
    } finally {
      cleanup(f);
    }
  });
}

test('a failed dynamic framework plan aborts a publisher dry-run', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'], planExit: 4 });
    const result = run(f.dir, ['publish', '--dry-run']);
    assert.equal(result.status, 4);
    assert.match(result.err, /forbidden dependency/);
    assert.doesNotMatch(result.out, /Would run:/);
  } finally {
    cleanup(f);
  }
});

test('a parseable plan that exits nonzero still fails closed', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'], planExit: 4, planExitAfterOutput: true });
    const result = run(f.dir, ['status', '--json']);
    assert.equal(result.status, 4);
    assert.match(result.err, /cannot resolve framework-core composition from core plan \(exit 4\)/);
  } finally {
    cleanup(f);
  }
});

test('a static preset selection is not mislabeled as an agent-pack dependency', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, {
      skills: ['alpha'],
      skillReasons: { alpha: ['selected-by-preset:git'] },
    });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    const result = run(f.dir, ['status', '--preset', 'git', '--json']);
    assert.equal(result.status, 10, result.err);
    const status = JSON.parse(result.out);
    assert.deepEqual(status.skill_selection_reasons.alpha, ['selected-by-preset:git']);
  } finally {
    cleanup(f);
  }
});

test('a skill ARRIVING is minor, and the reason names it', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha', 'beta'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');   // published: alpha only
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'beta', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'minor');
    assert.equal(st.next_version, '1.2.0');
    assert.match(st.bump_reasons.join('; '), /skill added: beta/);
    assert.deepEqual(st.delta.find((r) => r.unit === 'beta'), {
      unit: 'beta', published: null, source: '1.0.0', state: 'added',
    });
  } finally {
    cleanup(f);
  }
});

test('a skill LEAVING is major — it breaks anyone who mounted the core', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'gone', '1.0.0');    // published, now dropped
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'major');
    assert.equal(st.next_version, '2.0.0');
    assert.match(st.bump_reasons.join('; '), /skill removed: gone/);
  } finally {
    cleanup(f);
  }
});

test('removal outranks addition — a release that both adds and drops is still major', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha', 'beta'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'gone', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'beta', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'major');
    assert.match(st.bump_reasons.join('; '), /removed: gone/);
    assert.ok(
      !st.bump_reasons.join('; ').includes('skill added'),
      'the deciding signal is the breaking one; listing the additive one beside it reads as if both decided'
    );
  } finally {
    cleanup(f);
  }
});

test('a new lib module is minor', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join(SRC_REL, 'lib'), 'old-thing', '1.0.0');
    unit(f.dir, 'lib', 'old-thing', '1.0.0');
    unit(f.dir, 'lib', 'brand-new', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'minor');
    assert.match(st.bump_reasons.join('; '), /lib module added: brand-new/);
  } finally {
    cleanup(f);
  }
});

// ── Agent packs are release units too ──────────────────────────────────────────────────────────
// A pack is part of what a consumer mounts, so it moves the version for the same reasons a skill
// does: one that arrives is an additive capability, one that leaves stops being re-installable for
// everybody who had it. Its version lives in pack.yaml, not a VERSION.json, so the delta reader for
// it is separate and needs its own coverage.

/** Write `<root>/<relDir>/.sidekicks/agent-packs/<id>/pack.yaml` at a version. */
function packUnit(root, relDir, id, version) {
  const dir = join(root, relDir, '.sidekicks', 'agent-packs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'),
    `schema: agent-pack/v1\nid: ${id}\nversion: ${version}\ndisplay_name: ${id}\nagents:\n  - someone\nrequires_skills: []\n`);
  return dir;
}

test('an agent pack ARRIVING is minor, and the delta names its version', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    packUnit(f.dir, SRC_REL, 'old-pack', '1.0.0');       // published
    packUnit(f.dir, '.', 'old-pack', '1.0.0');
    packUnit(f.dir, '.', 'core', '1.0.0');               // arriving

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'minor');
    assert.match(st.bump_reasons.join('; '), /agent pack added: core/);
    assert.deepEqual(st.delta.find((r) => r.unit === 'agent-pack/core'), {
      unit: 'agent-pack/core', published: null, source: '1.0.0', state: 'added',
    });
  } finally {
    cleanup(f);
  }
});

test('an agent pack LEAVING is major — a crew stops being re-installable', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    packUnit(f.dir, SRC_REL, 'core', '1.0.0');
    packUnit(f.dir, SRC_REL, 'dropped', '1.0.0');
    packUnit(f.dir, '.', 'core', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'major');
    assert.match(st.bump_reasons.join('; '), /agent pack removed: dropped/);
  } finally {
    cleanup(f);
  }
});

test('a pack version bump shows in the delta and is read from pack.yaml', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    packUnit(f.dir, SRC_REL, 'core', '1.0.0');
    packUnit(f.dir, '.', 'core', '1.1.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'patch', 'content behind an unchanged surface — the pack is still there');
    assert.deepEqual(st.delta.find((r) => r.unit === 'agent-pack/core'), {
      unit: 'agent-pack/core', published: '1.0.0', source: '1.1.0', state: 'changed',
    });
  } finally {
    cleanup(f);
  }
});

test('a release records the packs it shipped, so the next run can classify against them', () => {
  const f = publishable();
  try {
    packUnit(f.dir, '.', 'core', '1.0.0');
    assert.equal(run(f.dir, ['publish', '--no-commit']).status, 0);
    const state = JSON.parse(readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'));
    assert.deepEqual(state.last_local_release.packs, ['core'],
      'without this the next release re-derives the pack set from a tree that has since been overwritten');
  } finally {
    cleanup(f);
  }
});

test('a state file predating agent packs does not invent a removal', () => {
  // The compatibility case: every release recorded before packs existed has no `packs` key. Reading
  // that as "shipped none" is only safe because the fallback distinguishes an empty core from an
  // unreadable one — read as `[]` blindly, a first pack would look like an addition off a release
  // that never had one; read as a removal, it would derive a MAJOR for adding a feature.
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    packUnit(f.dir, '.', 'core', '1.0.0');
    mkdirSync(join(f.dir, RUN_REL), { recursive: true });
    writeFileSync(join(f.dir, RUN_REL, 'state.json'), JSON.stringify({
      schema: 2,
      // `lib: []` because the fixture's lib/ holds a bare .mjs file and no module directories —
      // recording a module that was never there would derive a removal and mask what is under test.
      last_local_release: { version: '1.1.1', source_commit: f.base, skills: ['alpha'], lib: [] },
      history: [],
    }, null, 2) + '\n');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.ok(!st.bump_reasons.join('; ').includes('agent pack removed'),
      'a state file with no packs key must never be read as "packs were removed"');
    assert.notEqual(st.bump_class, 'major');
  } finally {
    cleanup(f);
  }
});

test('content-only change behind an unchanged surface is patch', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.1.0');   // bumped, but still the same unit

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.bump_class, 'patch');
    assert.equal(st.next_version, '1.1.2');
    assert.match(st.bump_reasons.join('; '), /content-only/);
  } finally {
    cleanup(f);
  }
});

test('--bump and --version still override the derived class', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'gone', '1.0.0');   // would derive major
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');

    const forced = JSON.parse(run(f.dir, ['status', '--bump', 'patch', '--json']).out);
    assert.equal(forced.next_version, '1.1.2');
    assert.equal(forced.bump_source, 'explicit --bump');
    assert.equal(forced.bump_class, 'major', 'the DERIVED class is still reported, so the override is visible as one');

    const pinned = JSON.parse(run(f.dir, ['status', '--version', '9.9.9', '--json']).out);
    assert.equal(pinned.next_version, '9.9.9');
    assert.equal(pinned.bump_source, 'explicit --version');
  } finally {
    cleanup(f);
  }
});

test('the published inventory is read from state.json in preference to the forged tree', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha', 'beta'] });
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'beta', '1.0.0');
    // The forged tree says both are already there; state.json — what the last publish actually
    // recorded — says only alpha shipped. State wins, so `beta` still reads as added.
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'beta', '1.0.0');
    mkdirSync(join(f.dir, RUN_REL), { recursive: true });
    writeFileSync(
      join(f.dir, RUN_REL, 'state.json'),
      JSON.stringify(
        { schema: 1, last_publish: { version: '1.1.1', source_commit: f.base, skills: ['alpha'], lib: [] } },
        null, 2
      ) + '\n'
    );

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.inventory_source, 'state.json');
    assert.equal(st.bump_class, 'minor');
    assert.match(st.bump_reasons.join('; '), /skill added: beta/);
  } finally {
    cleanup(f);
  }
});

test('the published inventory comes from the core HEAD, not its working tree', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha', 'beta'] });
    unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
    unit(f.dir, join('.agents', 'skills'), 'beta', '1.0.0');

    // The core is its own repo, and HEAD carries alpha only — that is what was RELEASED.
    const core = join(f.dir, SRC_REL);
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    git(core, ['init', '-q']);
    git(core, ['config', 'user.email', 'test@example.com']);
    git(core, ['config', 'user.name', 'Test']);
    git(core, ['add', '-A']);
    git(core, ['commit', '-q', '-m', 'release 1.1.1']);

    // Then an aborted publish forged beta into the working tree and never committed it. Classifying
    // against the working tree would see beta as already published and derive `patch` for a release
    // that adds it — the exact miss that shipped a v1.1.6 which should have been v1.2.0.
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'beta', '1.0.0');

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.match(st.inventory_source, /committed HEAD/);
    assert.equal(st.bump_class, 'minor');
    assert.match(st.bump_reasons.join('; '), /skill added: beta/);
  } finally {
    cleanup(f);
  }
});

test('the delta table reports version moves and never writes them back', () => {
  const f = fixture();
  try {
    writeStubEngine(f.dir, { skills: ['alpha'] });
    unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
    const sourceSkill = unit(f.dir, join('.agents', 'skills'), 'alpha', '1.4.0');
    writeFileSync(join(f.dir, 'lib', 'placeholder.mjs'), 'export default 2;\n');
    git(f.dir, ['add', '-A']);
    git(f.dir, ['commit', '-q', '-m', 'chore: move things']);

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    const row = st.delta.find((r) => r.unit === 'alpha');
    assert.deepEqual(row, { unit: 'alpha', published: '1.0.0', source: '1.4.0', state: 'changed' });

    // A release process that silently bumped a skill's own VERSION.json would make its history a
    // claim about a decision nobody made.
    assert.equal(JSON.parse(readFileSync(join(sourceSkill, 'VERSION.json'), 'utf8')).version, '1.4.0');
    assert.match(run(f.dir, ['status']).out, /alpha\s+1\.0\.0\s+1\.4\.0\s+changed/);
  } finally {
    cleanup(f);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Gates — a forge that produced files is not a release
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('state.json records a LOCAL release, and asserts nothing about any remote', () => {
  const f = publishable();
  try {
    assert.equal(run(f.dir, ['publish', '--no-commit']).status, 0);
    const state = JSON.parse(readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'));
    assert.ok(state.last_local_release, 'the release key is last_local_release');
    assert.equal(state.last_publish, undefined,
      'nothing `publish` does reaches a remote, so it may not write a key that says "published" — '
      + 'that word belongs to `release`, which pushes and then re-checks');
    assert.equal(state.remote_verified, null,
      'unverified must be null — absent evidence, never a false claim of verification');
    assert.match(state.comment, /never pushes/);
  } finally {
    cleanup(f);
  }
});

test('an existing state file written with the old key still classifies', () => {
  // The rename must not make every prior release invisible to the classifier — that would derive
  // a wrong bump class on the very next run.
  const f = publishable();
  try {
    mkdirSync(join(f.dir, RUN_REL), { recursive: true });
    writeFileSync(
      join(f.dir, RUN_REL, 'state.json'),
      JSON.stringify({ schema: 1, last_publish: { version: '1.4.0', source_commit: f.base } }, null, 2) + '\n'
    );
    const r = run(f.dir, ['status', '--json']);
    assert.equal(r.status, 10, r.out + r.err);
    const payload = JSON.parse(r.out);
    assert.equal(payload.published_version_state ?? '1.4.0', '1.4.0');
    assert.match(r.out, /1\.4\.0/, 'the legacy key must still be read');
  } finally {
    cleanup(f);
  }
});

test('verify-remote refuses to claim anything when there is no local release', () => {
  const f = fixture();
  try {
    const r = run(f.dir, ['verify-remote']);
    assert.notEqual(r.status, 0);
    assert.match(r.out + r.err, /no local release recorded/);
  } finally {
    cleanup(f);
  }
});

/** Rewrite the fixture's stub engine in place, returning the same dir. */
function publishableThen(f, opts) {
  writeStubEngine(f.dir, { skills: ['alpha'], ...opts });
  return f.dir;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Landing it — local commit, protected-branch stop, never a push
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('publish commits locally on a work branch', () => {
  const f = publishable();
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const r = run(f.dir, ['publish']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /committed locally \(nothing pushed\)/);
    const last = git(f.dir, ['log', '-1', '--format=%s']).out;
    assert.match(last, /^chore\(framework\): bump sidekicks-core core gitlink to v/);
    // The push is the outward-facing half and stays a printed instruction. Branch and tag are
    // SEPARATE lines: the one-liner they replaced was shortenable to a bare `git push`, which is
    // how two releases reached the remote untagged.
    assert.match(r.out, /push origin HEAD$/m);
    assert.match(r.out, /push origin v\d+\.\d+\.\d+\s+# NOT optional/);
    assert.equal(git(f.dir, ['status', '--porcelain']).out, '', 'the release must leave a clean tree');
  } finally {
    cleanup(f);
  }
});

for(const protectedOwner of ['source','target']) for(const noCommit of [false,true]) test(`publish refuses protected ${protectedOwner} before writes${noCommit?' with --no-commit':''}`, () => {
  const f = publishable({targetIsRepo:true});
  try {
    const target=join(f.dir,SRC_REL);
    git(protectedOwner==='source'?f.dir:target,['checkout','-q','-B','main']);
    const marker=readFileSync(join(target,'.sidekicks-core.json'),'utf8');
    const before=git(target,['status','--porcelain']).out;
    const r = run(f.dir, ['publish',...(noCommit?['--no-commit']:[])]);
    assert.equal(r.status, 4, r.out+r.err);
    assert.match(r.err, /refused before any writes/);
    assert.equal(readFileSync(join(target,'.sidekicks-core.json'),'utf8'),marker);
    assert.equal(git(target,['status','--porcelain']).out,before);
    assert.equal(existsSync(join(f.dir, RUN_REL, 'release-log.md')),false);
    assert.equal(existsSync(join(f.dir, RUN_REL, 'state.json')),false);
    assert.match(r.err, /--allow-protected/);
    assert.equal(git(f.dir, ['log', '-1', '--format=%s']).out, 'feat(lib): something core-bound');
  } finally {
    cleanup(f);
  }
});

test('--allow-protected is the explicit yes that lets it land', () => {
  const f = publishable();
  try {
    git(f.dir,['checkout','-q','-B','main']);
    const r = run(f.dir, ['publish', '--allow-protected']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /committing anyway/);
    assert.match(git(f.dir, ['log', '-1', '--format=%s']).out, /bump sidekicks-core core gitlink/);
  } finally {
    cleanup(f);
  }
});

test('--no-commit keeps the older print-only behaviour', () => {
  const f = publishable();
  try {
    const r = run(f.dir, ['publish', '--no-commit']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /nothing was committed/);
    assert.match(r.out, /git -C .* commit -m "chore\(release\)/, 'the steps it did not run must be printed');
    assert.equal(git(f.dir, ['log', '-1', '--format=%s']).out, 'feat(lib): something core-bound');
  } finally {
    cleanup(f);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Re-publishing a version — idempotent, or a refusal. Never a silent second release.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The defect these lock down: publishing an already-released version used to be entirely
// undetected. The log grew a duplicate `## vX.Y.Z` section, state.json was overwritten, `git tag`
// failed with "already exists" and that failure became a note — so the run exited 0 with the tag
// still on the OLD commit. v2.0.0 ended up 53 files away from the tree its own tag named.

/** The version a publish run actually cut, read back from its own output. */
function cutVersion(r) {
  const m = /Publishing framework core v(\d+\.\d+\.\d+)/.exec(r.out);
  assert.ok(m, `could not read the cut version from output:\n${r.out}${r.err}`);
  return m[1];
}

/** How many `## vX.Y.Z` sections the log carries for one version. */
function logSections(dir, version) {
  const log = readFileSync(join(dir, RUN_REL, 'release-log.md'), 'utf8');
  return (log.match(new RegExp(`^## v${version.replace(/\./g, '\\.')}(?:\\s|$)`, 'gm')) || []).length;
}

test('re-publishing an unchanged released version does nothing and says so', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const first = run(f.dir, ['publish', '--no-mount-check']);
    assert.equal(first.status, 0, first.out + first.err);
    const v = cutVersion(first);
    const stateBefore = readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8');

    const again = run(f.dir, ['publish', '--no-mount-check', '--version', v]);
    assert.equal(again.status, 0, again.out + again.err);
    assert.match(again.out, /already released and this forge is identical/);
    assert.match(again.out, /Nothing to do/);
    assert.equal(logSections(f.dir, v), 1, 'the log must not grow a second section for one version');
    assert.equal(
      readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'),
      stateBefore,
      'a no-op re-publish must not rewrite state.json'
    );
  } finally {
    cleanup(f);
  }
});

test('the baseline it records is a content_hash, so the check survives a re-forge', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const r = run(f.dir, ['publish', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);
    const state = JSON.parse(readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'));
    assert.match(
      state.last_local_release.content_hash,
      /^[0-9a-f]{64}$/,
      'every release must record the digest a later re-publish is checked against'
    );
  } finally {
    cleanup(f);
  }
});

test('a re-publish that only moves a timestamp still counts as identical', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const first = run(f.dir, ['publish', '--no-mount-check']);
    const v = cutVersion(first);

    // Same content, different wall clock — exactly what a real forge does on every run.
    writeStubEngine(f.dir, { skills: ['alpha'], markerForgedAt: '2026-09-01T23:59:59+07:00' });
    const again = run(f.dir, ['publish', '--no-mount-check', '--version', v]);
    assert.equal(again.status, 0, again.out + again.err);
    assert.match(again.out, /identical/);
    assert.equal(logSections(f.dir, v), 1);
  } finally {
    cleanup(f);
  }
});

test('line endings alone do not make a re-forge look divergent', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const first = run(f.dir, ['publish', '--no-mount-check']);
    const v = cutVersion(first);

    // The same bytes as a Windows forge would write them. A CRLF-only diff is not a content change.
    writeStubEngine(f.dir, { skills: ['alpha'], crlf: true });
    const again = run(f.dir, ['publish', '--no-mount-check', '--version', v]);
    assert.equal(again.status, 0, again.out + again.err);
    assert.match(again.out, /identical/);
  } finally {
    cleanup(f);
  }
});

test('a re-publish whose CONTENT differs is refused with exit 5 and names the paths', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const first = run(f.dir, ['publish', '--no-mount-check']);
    const v = cutVersion(first);
    const logBefore = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');

    writeStubEngine(f.dir, {
      skills: ['alpha'],
      extraFile: { path: 'SMUGGLED.txt', content: 'content that was not in the release\n' },
    });
    const again = run(f.dir, ['publish', '--no-mount-check', '--version', v]);
    assert.equal(again.status, 5, again.out + again.err);
    assert.match(again.err, /DIFFERS from the released content/);
    assert.match(again.err, /SMUGGLED\.txt/, 'the refusal must name what diverged');
    assert.match(again.err, /--reland/, 'the way forward must be named');
    assert.equal(
      readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8'),
      logBefore,
      'a refused re-publish must write nothing'
    );
  } finally {
    cleanup(f);
  }
});

test('--reland re-lands a diverged version: one log section, tag moved', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const first = run(f.dir, ['publish', '--no-mount-check']);
    const v = cutVersion(first);
    const src = join(f.dir, SRC_REL);
    const tagWas = git(src, ['rev-list', '-n', '1', `v${v}`]).out;

    writeStubEngine(f.dir, {
      skills: ['alpha'],
      extraFile: { path: 'SMUGGLED.txt', content: 'content that was not in the release\n' },
    });
    const again = run(f.dir, ['publish', '--no-mount-check', '--version', v, '--reland']);
    assert.equal(again.status, 0, again.out + again.err);
    assert.equal(logSections(f.dir, v), 1, 'the upsert must replace the section, not append a second');
    assert.match(again.out, /tag v.* MOVED/);

    const tagNow = git(src, ['rev-list', '-n', '1', `v${v}`]).out;
    assert.notEqual(tagNow, tagWas, 'the tag must follow the re-landed release');
    assert.equal(tagNow, git(src, ['rev-parse', 'HEAD']).out, 'and must name the commit that was gated');
  } finally {
    cleanup(f);
  }
});

test('a version with no recorded baseline is refused rather than re-released blind', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const first = run(f.dir, ['publish', '--no-mount-check']);
    const v = cutVersion(first);

    // Strip the baseline the way a pre-content_hash state file looks, and dirty the core so the
    // on-disk fallback is not trustworthy either.
    const sp = join(f.dir, RUN_REL, 'state.json');
    const state = JSON.parse(readFileSync(sp, 'utf8'));
    delete state.last_local_release.content_hash;
    writeFileSync(sp, JSON.stringify(state, null, 2) + '\n');
    writeFileSync(join(f.dir, SRC_REL, 'UNCOMMITTED.txt'), 'dirty\n');

    const again = run(f.dir, ['publish', '--no-mount-check', '--version', v]);
    assert.equal(again.status, 3, again.out + again.err);
    assert.match(again.err, /no recorded baseline/);
    assert.match(again.err, /--reland/);
  } finally {
    cleanup(f);
  }
});

test('a tag that already names a different commit stops the landing at exit 4', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    git(f.dir, ['checkout', '-q', '-b', 'chore/cut-a-release']);
    const src = join(f.dir, SRC_REL);
    // The version this run will cut, tagged in advance onto an unrelated commit — the shape the
    // real repo was left in when a half-finished publish tagged and then failed to land.
    const v = cutVersion(run(f.dir, ['publish', '--no-mount-check', '--dry-run']));
    git(src, ['tag', '-a', `v${v}`, '-m', 'stale']);
    const stale = git(src, ['rev-list', '-n', '1', `v${v}`]).out;

    const r = run(f.dir, ['publish', '--no-mount-check']);
    assert.equal(r.status, 4, r.out + r.err);
    assert.match(r.out + r.err, /already exists and points at/);
    assert.match(r.out + r.err, /--reland/);
    assert.equal(git(src, ['rev-list', '-n', '1', `v${v}`]).out, stale, 'the tag must not have moved');
  } finally {
    cleanup(f);
  }
});

// This used to be one file-wide source assertion: no `push` spawn anywhere in the script. `release`
// pushes, so that guard had to go — and the tempting way to keep it passing would have been to build
// the verb dynamically (`git([verb, ...])`), which would disarm it for every future change instead.
// It is replaced by something strictly STRONGER: a behavioural proof that `publish` leaves the remote
// untouched, plus a source assertion narrowed to the one function allowed to push.

test('publish never pushes — the remote is untouched, byte for byte', () => {
  const f = coreWithPrevRelease('1.0.0', { pushTag: true });
  try {
    const before = git(f.bare, ['show-ref']).out;
    const r = run(f.dir, ['publish', '--no-mount-check']);
    // 0 or 4 — the fixture's root repo is on `main`, so the local commit is refused by the
    // protected-branch floor. Either way the forge ran and the remote must be untouched: that
    // invariant is the subject here, and it must hold on the failure path too.
    assert.ok([0, 4].includes(r.status), `${r.status}:\n${r.out}\n${r.err}`);
    assert.equal(
      git(f.bare, ['show-ref']).out,
      before,
      'publish is the LOCAL half — committing and tagging are reversible, publishing is not'
    );
  } finally {
    cleanupWithRemote(f);
  }
});

test('only the release verb may push, and only behind --yes', () => {
  const src = readFileSync(join(repoRoot, RELEASE_REL), 'utf8');

  // The push spawns must all live inside doRelease. Slice from its declaration to the next
  // top-level function, and assert the rest of the file is clean.
  const start = src.indexOf('function doRelease(ctx)');
  assert.ok(start > 0, 'doRelease must exist');
  const after = src.indexOf('\nexport function ', start + 1);
  const inside = src.slice(start, after === -1 ? src.length : after);
  const outside = src.slice(0, start) + (after === -1 ? '' : src.slice(after));

  const pushSpawn = /spawnSync\(\s*["']git["']\s*,\s*\[[^\]]*["']push["']/;
  assert.doesNotMatch(outside, pushSpawn, 'no function other than doRelease may push');
  assert.doesNotMatch(outside, /git\(\s*\[\s*["']push["']/, 'nor through the git() helper');
  assert.match(inside, pushSpawn, 'doRelease is the one place a push lives');

  // …and the yes-gate precedes every one of them.
  const gate = inside.indexOf('if (!has(ctx, "yes") || ctx.DRY)');
  assert.ok(gate > 0, 'release must be plan-only without --yes');
  assert.ok(
    inside.slice(0, gate).search(pushSpawn) === -1,
    'nothing may push before the --yes gate is evaluated'
  );

  assert.match(
    src,
    /git -C \$\{portable\(ctx\.SRC_REL\)\} push/,
    'the printed command block must still show the push step'
  );
});

// ── verify-remote checks the CORE's branch, not this repo's ──────────────────────────────────────
// v1.0.0 was pushed complete — branch and tag — and verify-remote still said "the remote does NOT
// serve this release", because it took `source_branch` (the WORKSPACE branch the release was cut
// from) and asked the CORE's remote for it. Two repositories, two branch namespaces; the check could
// only ever pass while both were called `main`.

test('verify-remote asks the core remote for the CORE branch, not the workspace branch', () => {
  const f = publishable({ targetIsRepo: true });
  try {
    const src = join(f.dir, SRC_REL);
    // Distinct names on purpose: a check that confuses the two cannot pass by coincidence here.
    git(f.dir, ['checkout', '-q', '-b', 'chore/workspace-side']);
    git(src, ['checkout', '-q', '-b', 'chore/core-side']);

    const r = run(f.dir, ['publish', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);
    const state = JSON.parse(readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'));
    assert.equal(state.last_local_release.core_branch, 'chore/core-side',
      'the release must record where the CORE commit landed');
    assert.equal(state.last_local_release.source_branch, 'chore/workspace-side',
      'and must keep recording the workspace branch separately');

    // A bare repo stands in for the remote: verify-remote only ever runs `git ls-remote`.
    const bare = mkdtempSync(join(tmpdir(), 'sk-core-remote-'));
    git(bare, ['init', '-q', '--bare']);
    git(src, ['remote', 'add', 'origin', bare]);
    git(src, ['push', '-q', 'origin', 'chore/core-side']);
    git(src, ['push', '-q', 'origin', '--tags']);

    const v = run(f.dir, ['verify-remote', '--json']);
    const payload = JSON.parse(v.out);
    assert.ok(payload.ok, `a fully pushed release must verify: ${v.out}${v.err}`);
    const refs = payload.checks.map((c) => c.ref);
    assert.ok(refs.includes('refs/heads/chore/core-side'), `checked ${refs.join(', ')}`);
    assert.ok(
      !refs.some((ref) => ref.includes('workspace-side')),
      'the workspace branch must never be looked for in the core remote'
    );
    rmSync(bare, { recursive: true, force: true });
  } finally {
    cleanup(f);
  }
});

test('verify-remote does not fail a release that recorded no core branch', () => {
  // Every release cut before core_branch existed. The tag is the release identity and it is checked;
  // an unrunnable branch check must be reported as unknown rather than scored as a failure.
  const f = publishable({ targetIsRepo: true });
  try {
    const src = join(f.dir, SRC_REL);
    git(f.dir, ['checkout', '-q', '-b', 'chore/workspace-side']);
    git(src, ['checkout', '-q', '-b', 'chore/core-side']);
    const r = run(f.dir, ['publish', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);

    const statePath = join(f.dir, RUN_REL, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    delete state.last_local_release.core_branch;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

    const bare = mkdtempSync(join(tmpdir(), 'sk-core-remote-'));
    git(bare, ['init', '-q', '--bare']);
    git(src, ['remote', 'add', 'origin', bare]);
    git(src, ['push', '-q', 'origin', 'chore/core-side']);
    git(src, ['push', '-q', 'origin', '--tags']);

    const v = run(f.dir, ['verify-remote', '--json']);
    const payload = JSON.parse(v.out);
    assert.ok(payload.ok, `the tag is served, so the release verifies: ${v.out}${v.err}`);
    assert.ok(
      payload.checks.some((c) => c.ref.includes('unrecorded')),
      'and the missing branch must be SAID, not silently dropped'
    );
    rmSync(bare, { recursive: true, force: true });
  } finally {
    cleanup(f);
  }
});

// ── SERVED is not ADVERTISED (INC-2026-09-05-04 V-1 / R-1, R-2) ────────────────────────────────
// `verify-remote` said "the remote serves this release" after checking the tag and the release
// branch. The README's one-liner fetches `install.sh` and `README.md` from the core's `main`, and
// the merge onto `main` is operator-only — so between `release` and that merge, `status` said
// SERVED while a first-time reader still installed the PREVIOUS release. Nothing broke; the release
// simply was not advertised, and no verb could say so because `merges_outstanding` was written once
// and read by nothing.
//
// The load-bearing property in every case below is that `ok` DOES NOT MOVE. The `main` check is
// unscored on purpose: scoring it would fail every release for doing exactly what it was told to do.

/**
 * A published, fully pushed release whose core remote also has a `main` — placed by hand at a
 * chosen commit so a test can say whether it carries the release or trails it.
 *
 * `main` is created explicitly rather than relying on `git init`'s default branch: that default is
 * host configuration (`init.defaultBranch`), so a fixture that assumed it would silently test
 * "the remote has no main" on a host set to `master`.
 *
 * @param {{mainCarriesRelease: boolean}} opts
 */
function servedWithMain({ mainCarriesRelease }) {
  const f = publishable({ targetIsRepo: true });
  const src = join(f.dir, SRC_REL);
  // Both repos onto work branches first: publish refuses to commit onto a protected branch, and
  // the workspace and the core are separate repositories with separate branch namespaces.
  git(f.dir, ['checkout', '-q', '-b', 'chore/workspace-side']);
  git(src, ['checkout', '-q', '-b', 'chore/core-release']);
  const beforeRelease = git(src, ['rev-parse', 'HEAD']).out;

  const r = run(f.dir, ['publish', '--no-mount-check']);
  assert.equal(r.status, 0, r.out + r.err);

  const bare = mkdtempSync(join(tmpdir(), 'sk-core-remote-'));
  git(bare, ['init', '-q', '--bare']);
  git(src, ['remote', 'add', 'origin', bare]);
  git(src, ['push', '-q', 'origin', 'chore/core-release']);
  git(src, ['push', '-q', 'origin', '--tags']);
  // The merge the operator would perform, or the state before they have.
  const mainAt = mainCarriesRelease ? git(src, ['rev-parse', 'HEAD']).out : beforeRelease;
  git(src, ['push', '-q', 'origin', `${mainAt}:refs/heads/main`]);
  return { ...f, src, bare };
}

test('verify-remote reports main BEHIND without failing the release', () => {
  const f = servedWithMain({ mainCarriesRelease: false });
  try {
    const v = run(f.dir, ['verify-remote', '--json']);
    const payload = JSON.parse(v.out);
    assert.equal(v.status, 0, 'an unadvertised release is not a failed one');
    assert.ok(payload.ok, `SERVED must not move: ${v.out}${v.err}`);
    assert.equal(payload.advertised, false);

    const main = payload.checks.find((c) => c.ref === 'refs/heads/main');
    assert.ok(main, `main was not checked at all: ${payload.checks.map((c) => c.ref).join(', ')}`);
    assert.equal(main.scored, false, 'the main check must never be scored');
    assert.match(main.detail, /BEHIND/);

    const human = run(f.dir, ['verify-remote']);
    assert.match(human.out, /the remote serves this release/);
    assert.match(human.out, /NOT yet ADVERTISED/);
    assert.match(human.out, /^ {2}note {2}refs\/heads\/main/m,
      'an unscored row must print as `note`, never as `ok` — it did not pass, it was not scored');
  } finally {
    cleanupWithRemote(f);
  }
});

test('verify-remote reports main CAUGHT UP once the merge has landed', () => {
  const f = servedWithMain({ mainCarriesRelease: true });
  try {
    const v = run(f.dir, ['verify-remote', '--json']);
    const payload = JSON.parse(v.out);
    assert.ok(payload.ok, v.out + v.err);
    assert.equal(payload.advertised, true);
    assert.match(payload.checks.find((c) => c.ref === 'refs/heads/main').detail, /caught up/);

    const human = run(f.dir, ['verify-remote']);
    assert.match(human.out, /also ADVERTISED/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('status says SERVED but NOT ADVERTISED, and lists the outstanding merge', () => {
  const f = servedWithMain({ mainCarriesRelease: false });
  try {
    // `release` is what records the merges; write the same record here so `status` is tested
    // against the shape it actually reads, without pushing anything outward.
    const statePath = join(f.dir, RUN_REL, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const version = state.last_local_release.version;
    state.remote_release = { version, pushed_at: 'x', pushed_by: 'release', refs: [],
      source_branch_pushed: null,
      merges_outstanding: [{ repo: 'core', from: 'chore/core-release', into: 'main',
        why: 'publishes README.md + install.sh' }] };
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

    assert.equal(run(f.dir, ['verify-remote']).status, 0);

    const s = run(f.dir, ['status']);
    assert.match(s.out, /remote: +SERVED/, 'SERVED must still be reported — the tag IS served');
    assert.match(s.out, /NOT ADVERTISED/);
    assert.match(s.out, /core: merge chore\/core-release -> main/,
      'the recorded merge must be read back, not written and forgotten');

    const j = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(j.remote_state, 'served');
    assert.equal(j.advertised, false);
    assert.equal(j.merges_outstanding.length, 1);
  } finally {
    cleanupWithRemote(f);
  }
});

test('verify-remote PRUNES a merge that has landed and keeps one that has not', () => {
  const f = servedWithMain({ mainCarriesRelease: false });
  try {
    const statePath = join(f.dir, RUN_REL, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const version = state.last_local_release.version;
    state.remote_release = { version, pushed_at: 'x', pushed_by: 'release', refs: [],
      source_branch_pushed: null,
      merges_outstanding: [{ repo: 'core', from: 'chore/core-release', into: 'main', why: 'w' }] };
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

    // Still outstanding.
    assert.equal(run(f.dir, ['verify-remote']).status, 0);
    let after = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(after.remote_release.merges_outstanding.length, 1, 'nothing has merged yet');
    assert.ok(after.remote_release.merges_checked_at, 'and the check must be dated');

    // The operator performs it.
    git(f.src, ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/main']);
    const v = run(f.dir, ['verify-remote']);
    assert.match(v.out, /landed: +core: chore\/core-release -> main/);
    after = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(after.remote_release.merges_outstanding.length, 0, 'a landed merge must be pruned');

    assert.match(run(f.dir, ['status']).out, /ADVERTISED/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('a second verify-remote with the same answer leaves state.json byte-identical', () => {
  // INC-2026-09-05-04 V-4: verify-remote rewrote `verified_at` on every run, so a read-only check
  // left the source tree dirty and the audit had to restore the prior bytes by hand.
  const f = servedWithMain({ mainCarriesRelease: true });
  try {
    const statePath = join(f.dir, RUN_REL, 'state.json');
    assert.equal(run(f.dir, ['verify-remote']).status, 0);
    const first = readFileSync(statePath);
    assert.equal(run(f.dir, ['verify-remote']).status, 0);
    assert.deepEqual(readFileSync(statePath), first,
      'a read-only check must not dirty the tree just to move a timestamp');
  } finally {
    cleanupWithRemote(f);
  }
});

// ── The previous release must be SERVED before the next one is cut ─────────────────────────────
// v1.1.0 and v1.1.1 both reached the remote's main with no tag (a bare `git push` instead of the
// printed `push origin HEAD --tags`), and the README pins installs to `--ref v<version>` — so both
// releases were uninstallable by the only name they document, and an installer pinning a commit
// was the first symptom. Nothing caught it because `verify-remote` is a separate verb nobody ran.
// The gate lives at the moment of cutting the NEXT release: the last point where the previous tag
// can still be pushed without archaeology.

/**
 * A publishable core that is its own repo, carrying a RECORDED previous release at `version`
 * whose tag exists locally. `remote` gives it a bare `origin` next door; `pushTag` decides
 * whether the tag ever got there — the distinction the gate is built to notice.
 *
 * The marker is rewritten to the same version on purpose: a marker that disagrees with the
 * recorded release lands on the resumed-attempt path and the run would be refused for an
 * unrelated reason, which would make the test prove nothing about the gate.
 *
 * @param {string} version
 * @param {{remote?: boolean, pushTag?: boolean}} [opts]
 */
function coreWithPrevRelease(version, { remote = true, pushTag = false } = {}) {
  const f = publishable({ targetIsRepo: true });
  const src = join(f.dir, SRC_REL);
  writeFileSync(
    join(src, '.sidekicks-core.json'),
    JSON.stringify(
      { schema: 1, name: 'sidekicks-core', version, layout: 1,
        forged_at: '2026-08-18T09:00:00+07:00', source_commit: f.base },
      null, 2
    ) + '\n'
  );
  mkdirSync(join(f.dir, RUN_REL), { recursive: true });
  const structureEntries=[];
  const inventory=(rel='')=>{
    for(const name of readdirSync(join(src,rel)).sort()) {
      if(name==='.git')continue;
      const path=rel?rel+'/'+name:name,abs=join(src,path),stat=lstatSync(abs);
      structureEntries.push({path,kind:stat.isDirectory()?'directory':'file',included:true,
        ...(stat.isDirectory()?{}:{executable:Boolean(stat.mode&0o111),hash:createHash('sha256').update(readFileSync(abs)).digest('hex')}),
        reason:'synthetic previous release'});
      if(stat.isDirectory())inventory(path);
    }
  };inventory();
  writeFileSync(
    join(f.dir, RUN_REL, 'state.json'),
    JSON.stringify(
      { schema: 2, runtime: 'sidekicks-core', target_rel: SRC_REL,
        last_local_release: { version, source_commit: f.base, core_branch: 'chore/core-release',
          root_structure:{schema:1,entries:structureEntries,
            digest:createHash('sha256').update(JSON.stringify(structureEntries)).digest('hex')} },
        history: [] },
      null, 2
    ) + '\n'
  );
  // Committed, not just written: the mount-check gate clones the core's HEAD, so a marker left in
  // the worktree alone would be invisible to it.
  git(src, ['add', '-A']);
  git(src, ['commit', '-q', '-m', `core: marker v${version}`]);
  git(src, ['tag', '-a', `v${version}`, '-m', `framework core v${version}`]);
  let bare = null;
  if (remote) {
    bare = mkdtempSync(join(tmpdir(), 'sk-core-origin-'));
    git(bare, ['init', '-q', '--bare']);
    git(src, ['remote', 'add', 'origin', bare]);
    git(src, ['push', '-q', 'origin', 'HEAD']);
    if (pushTag) git(src, ['push', '-q', 'origin', `v${version}`]);
  }
  return { ...f, bare };
}

function cleanupWithRemote(f) {
  cleanup(f);
  if (f.bare) rmSync(f.bare, { recursive: true, force: true });
}

test('publish refuses to cut a release while the PREVIOUS tag is missing from the remote', () => {
  const f = coreWithPrevRelease('1.0.0');
  try {
    const r = run(f.dir, ['publish']);
    assert.equal(r.status, 5, r.out + r.err);
    assert.match(r.err, /v1\.0\.0 was released locally but the remote does not serve its tag/);
    assert.match(r.err, /never pushed/);
    assert.match(r.err, /push origin v1\.0\.0/, 'the refusal must name the exact push');
    assert.match(r.err, /--allow-unpushed/, 'and the operator override');
    assert.ok(
      !existsSync(join(f.dir, RUN_REL, 'release-log.md')),
      'the gate must stop the run BEFORE anything is forged or logged'
    );
  } finally {
    cleanupWithRemote(f);
  }
});

test('--allow-unpushed cuts the release anyway and says so', () => {
  const f = coreWithPrevRelease('1.0.0');
  try {
    const r = run(f.dir, ['publish', '--no-commit', '--no-mount-check', '--allow-unpushed']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /--allow-unpushed: cutting v1\.0\.1 while v1\.0\.0 is unpushed/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('a previous release the remote actually serves does not block the next one', () => {
  const f = coreWithPrevRelease('1.0.0', { pushTag: true });
  try {
    const r = run(f.dir, ['publish', '--no-commit', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.doesNotMatch(r.err, /does not serve its tag/);
    assert.doesNotMatch(r.out, /could not confirm/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('an unreachable remote WARNS and continues — connectivity may not block a release', () => {
  const f = coreWithPrevRelease('1.0.0', { remote: false });
  try {
    const r = run(f.dir, ['publish', '--no-commit', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /NOTE: could not confirm that v1\.0\.0 is served/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('publish --dry-run reports the unpushed previous release without refusing', () => {
  const f = coreWithPrevRelease('1.0.0');
  try {
    const r = run(f.dir, ['publish', '--dry-run']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /WOULD REFUSE: v1\.0\.0 is a LOCAL release only/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('the printed push block makes the TAG its own step and names the verification', () => {
  const f = coreWithPrevRelease('1.0.0', { pushTag: true });
  try {
    const r = run(f.dir, ['publish', '--no-commit', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /push origin HEAD$/m, 'the branch push stands alone');
    assert.match(r.out, /push origin v1\.0\.1\s+# NOT optional/, 'and the tag is its own step');
    assert.match(r.out, /sidekicks core verify-remote/, 'with the proof it landed');
    assert.doesNotMatch(r.out, /--tags/, 'the shortenable one-liner must not come back');
  } finally {
    cleanupWithRemote(f);
  }
});


// ── release: making "published" mean "served" (INC-2026-09-04-01, R-1) ─────────────────────────
// v1.4.1 was forged, gated, committed and tagged; `push origin HEAD` ran and `push origin v1.4.1`
// did not. Every local signal said the release was done, the generated README told consumers to
// install `--ref v1.4.1`, and the tag existed nowhere but one laptop. These tests pin the two things
// that stop it recurring: the ORDER (tag before branch) and the PROOF (verify after pushing).

/** A fixture whose local release is landed and tagged, with a bare origin that has neither. */
function releasable() {
  const f = coreWithPrevRelease('1.0.0');   // pushes HEAD, not the tag
  const src = join(f.dir, SRC_REL);
  // A release cut by `publish` always has a log section, so the fixture has one too. Without it
  // v1.0.0 is an UNLOGGED tag, and serving it turns it into a served-unlogged one that then blocks
  // the next release — a real guard firing on a state publish cannot actually produce.
  mkdirSync(join(f.dir, RUN_REL), { recursive: true });
  writeFileSync(join(f.dir, RUN_REL, 'release-log.md'),
    '# Framework core — release log\n\n## v1.0.0 — 2026-09-04\n\nForged.\n');
  // coreWithPrevRelease leaves the core on its release branch with the tag local-only, which is
  // exactly the state the incident produced.
  return { ...f, src };
}

test('release without --yes prints the plan and pushes NOTHING', () => {
  const f = releasable();
  try {
    const before = git(f.bare, ['show-ref']).out;
    const r = run(f.dir, ['release']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /refs\/tags\/v1\.0\.0/);
    assert.match(r.out, /Nothing was pushed/);
    assert.match(r.out, /never self-granted/, 'the yes must read as an authorization, not a flag');
    assert.equal(git(f.bare, ['show-ref']).out, before, 'a plan run must not reach the remote');
  } finally {
    cleanupWithRemote(f);
  }
});

test('release --yes pushes the TAG BEFORE the branch, and proves the remote serves it', () => {
  const f = releasable();
  try {
    const r = run(f.dir, ['release', '--yes']);
    assert.equal(r.status, 0, r.out + r.err);

    const refs = git(f.bare, ['show-ref']).out;
    assert.match(refs, /refs\/tags\/v1\.0\.0/, 'the tag is what --ref resolves to');

    // The ordering is the fix, not a convention: the README reaches the core's default branch only
    // through a merge that is later than both pushes, so a README naming a tag the remote lacks
    // becomes unreachable rather than merely unlikely.
    const tagAt = r.out.indexOf('refs/tags/v1.0.0');
    const branchAt = r.out.indexOf('refs/heads/chore/core-release');
    assert.ok(tagAt > -1 && branchAt > -1 && tagAt < branchAt, `tag must be pushed first:\n${r.out}`);

    const state = JSON.parse(readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'));
    assert.equal(state.schema, 3);
    assert.equal(state.remote_verified.version, '1.0.0');
    assert.equal(state.remote_release.version, '1.0.0');
    assert.ok(state.remote_release.merges_outstanding.some((m) => m.repo === 'core'),
      'the merge this script must never perform has to be named, not implied');
  } finally {
    cleanupWithRemote(f);
  }
});

test('release never passes --tags or --follow-tags', () => {
  // This repo carried four unpushed tags, three of which should never have reached the remote.
  // A release pushes ONE tag, by name.
  const src = readFileSync(join(repoRoot, RELEASE_REL), 'utf8');
  const start = src.indexOf('function doRelease(ctx)');
  const after = src.indexOf('\nexport function ', start + 1);
  const inside = src.slice(start, after === -1 ? src.length : after);
  const code = inside.replace(/\/\/[^\n]*/g, '');   // the comments EXPLAIN these forms; the code must not use them
  assert.doesNotMatch(code, /--tags|--follow-tags/);
  assert.doesNotMatch(code, /"push",\s*"origin",\s*"HEAD"/,
    'the branch is pushed by NAME — a detached HEAD must not decide what ships');
});

test('release records a Published block in the log, once', () => {
  const f = releasable();
  try {
    assert.equal(run(f.dir, ['release', '--yes']).status, 0);
    let log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    assert.match(log, /\*\*Published\*\* — pushed and verified at/);
    assert.match(log, /Outstanding merges \(never performed by this script\)/);

    // Re-running is a no-op, not a second block: `release` has to be safe to repeat.
    assert.equal(run(f.dir, ['release', '--yes']).status, 0);
    log = readFileSync(join(f.dir, RUN_REL, 'release-log.md'), 'utf8');
    assert.equal(log.match(/\*\*Published\*\*/g).length, 1);
  } finally {
    cleanupWithRemote(f);
  }
});

test('release refuses a protected core branch with exit 8, and pushes nothing', () => {
  const f = releasable();
  try {
    // The RECORDED branch is authoritative — that is where the release commit landed — so a
    // protected branch has to be recorded, not merely checked out.
    const statePath = join(f.dir, RUN_REL, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.last_local_release.core_branch = 'main';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    git(f.src, ['branch', '-f', 'main', 'HEAD']);

    const before = git(f.bare, ['show-ref']).out;
    const r = run(f.dir, ['release', '--yes']);
    assert.equal(r.status, 8, r.out + r.err);
    assert.match(r.err, /protected/);
    assert.match(r.err, /merge or PR you approve/);
    assert.equal(git(f.bare, ['show-ref']).out, before);
  } finally {
    cleanupWithRemote(f);
  }
});

test('release refuses a non-fast-forward BEFORE touching anything', () => {
  const f = releasable();
  try {
    // Put a commit on the remote branch that the local one does not contain: pushing would discard
    // it. Refusing has to happen in the read-only preflight, not after the tag is already up.
    const clone = mkdtempSync(join(tmpdir(), 'sk-core-clone-'));
    // --branch explicitly: the bare's HEAD names a ref that does not exist, so a plain clone checks
    // out nothing and the divergent commit would never reach the branch under test.
    git(clone, ['clone', '-q', '--branch', 'chore/core-release', f.bare, 'c']);
    const c = join(clone, 'c');
    git(c, ['config', 'user.email', 'test@example.com']);
    git(c, ['config', 'user.name', 'Test']);
    writeFileSync(join(c, 'other.txt'), 'divergent\n');
    git(c, ['add', '-A']);
    git(c, ['commit', '-q', '-m', 'someone else']);
    const pushed = git(c, ['push', '-q', 'origin', 'HEAD:chore/core-release']);
    assert.equal(pushed.status, 0, `the fixture must actually diverge the remote: ${pushed.err}`);

    const before = git(f.bare, ['show-ref']).out;
    const r = run(f.dir, ['release', '--yes']);
    assert.equal(r.status, 6, r.out + r.err);
    assert.match(r.err, /would DISCARD commits the remote already serves/);
    assert.equal(git(f.bare, ['show-ref']).out, before, 'nothing may be pushed before the refusal');
    rmSync(clone, { recursive: true, force: true });
  } finally {
    cleanupWithRemote(f);
  }
});

test('release refuses when there is no local release to publish', () => {
  const f = fixture();
  try {
    const r = run(f.dir, ['release']);
    assert.equal(r.status, 3);
    assert.match(r.err, /nothing to publish/);
  } finally {
    cleanup(f);
  }
});

test('publish asserts nothing about any remote — every remote-facing block is null', () => {
  const f = publishable();
  try {
    assert.equal(run(f.dir, ['publish', '--no-commit']).status, 0);
    const state = JSON.parse(readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'));
    // `null`, not `undefined`. Both mean "this publish claims nothing about a remote" — which is
    // the property under test — but the key is now written explicitly, because publish rewrites
    // state whole and a key it does not name is a key it DELETES. See the test below.
    assert.equal(state.remote_release, null);
    assert.equal(state.remote_check, null);
    assert.equal(state.remote_verified, null);
    assert.equal(state.schema, 3);
  } finally {
    cleanup(f);
  }
});

test('publish does not ERASE the previous release\'s remote record for the same version', () => {
  // The defect this pins: doPublish builds a fresh object and writes it whole, so `remote_check`
  // and `remote_release` — which only `release` writes — were dropped by any later publish. That
  // took `merges_outstanding` with them, which is the record `verify-remote` and `status` now read
  // back to say whether the README is advertising this release yet (INC-2026-09-05-04 V-1/R-2).
  const f = publishable();
  try {
    assert.equal(run(f.dir, ['publish', '--no-commit']).status, 0);
    const statePath = join(f.dir, RUN_REL, 'state.json');
    const cut = JSON.parse(readFileSync(statePath, 'utf8'));
    const version = cut.last_local_release.version;

    // Stand in for what `release` would have left behind, at THIS version.
    cut.remote_release = { version, pushed_at: 'x', pushed_by: 'release', refs: [],
      source_branch_pushed: null,
      merges_outstanding: [{ repo: 'core', from: 'chore/core-release', into: 'main', why: 'w' }] };
    cut.remote_check = { version, checked_at: 'x', ok: true, advertised: false, checks: [] };
    writeFileSync(statePath, JSON.stringify(cut, null, 2) + '\n');

    // Re-publishing the SAME version (a resumed cut) must leave both intact.
    assert.equal(run(f.dir, ['publish', '--no-commit', '--version', version, '--reland']).status, 0);
    const after = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(after.remote_release?.merges_outstanding?.length, 1,
      'the outstanding-merge record was erased by a re-publish of the same version');
    assert.equal(after.remote_check?.ok, true);
  } finally {
    cleanup(f);
  }
});

test('status distinguishes NOT VERIFIED from NOT SERVED', () => {
  const f = coreWithPrevRelease('1.0.0');
  try {
    // Absence is not a negative. state.json's own comment fixes this: a fresh clone has asked
    // nobody, and calling that NOT SERVED would make every clone look like a failed release.
    let st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.remote_state, 'unverified');
    assert.equal(st.unpushed_release, '1.0.0');
    assert.match(run(f.dir, ['status']).out, /NOT VERIFIED/);

    // A RECORDED negative is a negative.
    assert.equal(run(f.dir, ['verify-remote']).status, 1);
    st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.remote_state, 'not_served');
    const human = run(f.dir, ['status']).out;
    assert.match(human, /NOT SERVED/);
    assert.match(human, /release --yes/, 'the report must name the way out');

    // …and a verified release reads as served.
    assert.equal(run(f.dir, ['release', '--yes']).status, 0);
    st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.equal(st.remote_state, 'served');
    assert.equal(st.unpushed_release, null);
  } finally {
    cleanupWithRemote(f);
  }
});

test('status reports a history entry the release log has no section for', () => {
  // INC-2026-09-04-02, N-9. `history` is appended from whatever the core MARKER said at each cut, so
  // a hand-forge that stamped a version it never released leaves a row nothing backs. The real repo
  // carried a phantom `1.2.3` — no tag locally, none on the remote, no log entry — sitting out of
  // order before `1.2.0`, while `1.2.1`, a version the remote genuinely serves, was missing from
  // history entirely. Two incidents went by with nothing reporting the disagreement.
  const f = releasable();
  try {
    const statePath = join(f.dir, RUN_REL, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.history = [...(state.history || []), { version: '9.9.9', source_commit: 'deadbeef' }];
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.deepEqual(st.history_without_log.map((h) => h.version), ['9.9.9']);

    const human = run(f.dir, ['status']).out;
    assert.match(human, /HISTORY WITHOUT A LOG ENTRY/);
    assert.match(human, /v9\.9\.9/);
    assert.match(human, /source deadbeef/);
    assert.match(human, /re-land and refused without --reland/,
      'the report must say why it is not cosmetic — publishedVersions reads this list');
    assert.match(human, /an operator decision either way; this never edits it/,
      'a ledger of published history is not something a command may quietly rewrite');
  } finally {
    cleanupWithRemote(f);
  }
});

test('an unlogged tag the REMOTE SERVES stops a release; a local-only one does not', () => {
  const f = releasable();
  try {
    // A local-only orphan: listed, never blocking. Deleting it is the safe repair.
    git(f.src, ['tag', '-a', 'v0.9.0', '-m', 'cut by hand']);
    const st = JSON.parse(run(f.dir, ['status', '--json']).out);
    assert.deepEqual(st.unlogged_tags.map((t) => [t.tag, t.served]), [['v0.9.0', false]]);
    assert.match(run(f.dir, ['status']).out, /local only, never pushed/);
    assert.equal(run(f.dir, ['release', '--yes']).status, 0, 'a local-only orphan must not block');

    // Once the remote serves it, deleting it would break anyone pinned to it — so the repair is the
    // LOG, and the release stops until that is faced.
    git(f.src, ['push', '-q', 'origin', 'v0.9.0']);
    const blocked = run(f.dir, ['release', '--yes']);
    assert.equal(blocked.status, 8, blocked.out + blocked.err);
    assert.match(blocked.err, /v0\.9\.0/);
    assert.match(blocked.err, /deleting them breaks anyone pinned to them/);
    assert.match(run(f.dir, ['status']).out, /do NOT delete it/);

    assert.equal(run(f.dir, ['release', '--yes', '--allow-unlogged-tags']).status, 0);
  } finally {
    cleanupWithRemote(f);
  }
});


// ── ship: the whole release in one command ────────────────────────────────────────────────────
// `ship` exists because the ORDER is the part people get wrong, and getting it wrong is what the
// incident was. It is a composition of the other verbs — it re-invokes this same script rather than
// re-implementing them — so these tests pin the composition and the two refusals, not the verbs.

test('ship without --yes prints the plan and does nothing at all', () => {
  const f = releasable();
  try {
    const before = git(f.bare, ['show-ref']).out;
    const r = run(f.dir, ['ship']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /ship — /);
    assert.match(r.out, /Nothing was done/);
    assert.match(r.out, /never self-granted/);
    assert.equal(git(f.bare, ['show-ref']).out, before, 'a plan run must not reach the remote');
    // …and it must not have cut anything locally either.
    assert.equal(git(join(f.dir, SRC_REL), ['tag', '-l']).out, 'v1.0.0');
  } finally {
    cleanupWithRemote(f);
  }
});

test('ship REFUSES a dirty core-bound tree, and names the files', () => {
  const f = releasable();
  try {
    // The forge copies the WORKING TREE, so an uncommitted core-bound file ships while the log
    // records a commit that does not contain it — a release nobody can rebuild from its own sha.
    writeFileSync(join(f.dir, 'lib', 'placeholder.mjs'), 'export default 99;\n');
    const r = run(f.dir, ['ship', '--yes']);
    assert.equal(r.status, 3, r.out + r.err);
    assert.match(r.err, /lib\/placeholder\.mjs/);
    assert.match(r.err, /copies the WORKING TREE/);
    assert.match(r.err, /not something this command guesses at/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('a dirty file that is NOT core-bound does not block a ship', () => {
  const f = releasable();
  try {
    // Refusing on any dirty path at all would make `ship` unusable in a real checkout, where
    // unrelated gitlinks and project files are routinely dirty.
    writeFileSync(join(f.dir, 'unrelated.md'), 'not part of the core\n');
    const r = run(f.dir, ['ship']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.doesNotMatch(r.err, /uncommitted/);
  } finally {
    cleanupWithRemote(f);
  }
});

test('ship serves an ALREADY-CUT release before trying to publish the next one', () => {
  // publish refuses (exit 5) while the previous tag is missing from a reachable remote, so an
  // unserved release has to be finished before a new one can start. Ordering this correctly is the
  // whole reason the command exists.
  const f = releasable();
  try {
    const r = run(f.dir, ['ship', '--yes', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /serving the previous release/);

    const refs = git(f.bare, ['show-ref']).out;
    assert.match(refs, /refs\/tags\/v1\.0\.0/, 'the already-cut release must reach the remote');
    assert.match(refs, /refs\/tags\/v1\.0\.1/, 'and so must the one this run cut');

    // remote_verified names the version most recently SERVED, which is the new one — the older tag
    // being present is what proves the ordering, not the state field.
    const state = JSON.parse(readFileSync(join(f.dir, RUN_REL, 'state.json'), 'utf8'));
    assert.equal(state.remote_verified.version, '1.0.1');
  } finally {
    cleanupWithRemote(f);
  }
});

test('ship moves a PROTECTED repo onto a work branch before publishing', () => {
  const f = releasable();
  try {
    // Commit fixture ledger/gitlink changes so the actual HEAD move is clean.
    git(f.dir,['add','-A']);git(f.dir,['commit','-qm','record fixture release']);
    git(f.dir,['checkout','-q','-B','main']);
    assert.equal(git(f.dir, ['branch', '--show-current']).out, 'main');
    const r = run(f.dir, ['ship', '--yes', '--no-mount-check']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /'main' is protected → switch -c chore\/framework-core-release/);
    assert.equal(git(f.dir, ['branch', '--show-current']).out, 'chore/framework-core-release');
  } finally {
    cleanupWithRemote(f);
  }
});

for (const scenario of ['tracked changes', 'branch collision']) test('ship preserves every checkout and remote on protected ' + scenario, () => {
  const f = releasable();
  try {
    writeFileSync(join(f.dir,'unrelated.md'),'committed unrelated file');
    git(f.dir,['add','-A']);git(f.dir,['commit','-qm','record fixture baseline']);
    git(f.dir,['checkout','-q','-B','main']);
    if (scenario === 'tracked changes') {
      writeFileSync(join(f.dir,'unrelated.md'),'staged unrelated change');
      git(f.dir,['add','unrelated.md']);
    } else {
      // A collision in the SECOND moving repo must stop the FIRST move too.
      git(f.src,['checkout','-q','-B','main']);
      git(f.src,['branch','chore/framework-core-release']);
    }
    const snapshot = dir => ({head:git(dir,['rev-parse','HEAD']).out,
      branch:git(dir,['branch','--show-current']).out,refs:git(dir,['show-ref']).out,
      index:git(dir,['ls-files','--stage']).out,status:git(dir,['status','--porcelain','-z']).out});
    const before = [snapshot(f.dir),snapshot(f.src)], remote = git(f.bare,['show-ref']).out;
    const r = run(f.dir,['ship','--yes','--no-mount-check']);
    assert.equal(r.status,scenario === 'tracked changes' ? 3 : 4,r.out+r.err);
    assert.match(r.err,scenario === 'tracked changes' ? /tracked changes/ : /already exists/);
    assert.deepEqual([snapshot(f.dir),snapshot(f.src)],before);
    assert.equal(git(f.bare,['show-ref']).out,remote);
  } finally { cleanupWithRemote(f); }
});

test('ship reports nothing to do when the core is in sync and the remote serves it', () => {
  const f = releasable();
  try {
    const first = run(f.dir, ['ship', '--yes', '--no-mount-check']);
    assert.equal(first.status, 0, first.out + first.err);
    // Second run: no core-bound change since, and the remote already serves the release.
    const again = run(f.dir, ['ship', '--yes', '--no-mount-check']);
    assert.equal(again.status, 0, again.out + again.err);
    assert.match(again.out, /Nothing to publish and nothing unserved/);
  } finally {
    cleanupWithRemote(f);
  }
});
