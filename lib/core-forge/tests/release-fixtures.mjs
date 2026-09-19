// Shared fixtures for the retained release and gate incident specifications.
//
// lib/core-forge/release.mjs — the framework core release path: version
// derivation, core-bound change detection, the auto-written release log, and the refusal
// to do the outward-facing half.
//
// What is worth locking down here is not the forge (that is sk-publish-core's, covered
// by tests/skills/inherit-*.test.mjs) but the bookkeeping around it, where a silent wrong
// answer is expensive:
//
//   - a stale --core-version republishes a release under a version already shipped;
//   - a change list computed over the wrong paths reports "no release owed" when the core
//     did change (or the reverse, nagging on every docs commit);
//   - an uncommitted core-bound file SHIPS (the forge copies the working tree) while the
//     log records HEAD, producing a release nobody can rebuild from its own sha;
//   - a log entry written after a failed verify claims a release that is not publishable.
//
// Fixtures are throwaway git repos carrying a .sidekicks/ marker and a fake core service.
// They inject a callable projection into the real release engine, keeping release bookkeeping
// independent of the full source skill catalog. Public CLI and real forge coverage live elsewhere.
// Only node:test + node:assert/strict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT_REL = join('scripts', 'release-fixture.mjs');
const RELEASE_REL = join('lib', 'core-forge', 'release.mjs');
const SERVICE_REL = join('projects', 'global', 'services', 'sidekicks-core');
const SRC_REL = join(SERVICE_REL, 'src');
const RUN_REL = join(SERVICE_REL, 'artifacts', 'runs', 'core-forge');


/** Process isolation belongs to this harness, never to the callable release engine. */
function releaseRunner() {
  return `import { createReleaseEngine } from ${JSON.stringify(pathToFileURL(join(repoRoot, RELEASE_REL)).href)};
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [verb, ...argv] = process.argv.slice(2);
const flags = {};
for(let i=0;i<argv.length;i++) {
  const key=argv[i].replace(/^--/,'');
  flags[key]=argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true;
}
const stub=resolve('fixtures/projection.mjs');
const projection=existsSync(stub) ? (await import(pathToFileURL(stub))).runProjection
  : async()=>({exitCode:0,stdout:JSON.stringify({
    skill_names:['fixture-floor'],skills:[{skill:'fixture-floor',reasons:['required-floor']}],
    substrate:['bin','lib','scripts','AGENTS.md'],pack_skills:'none',
    runtime_excluded_dirs:['improvements','evals','tests'],problems:[]
  }),stderr:''});
try{
 // These synthetic fixtures isolate recorded release incidents; real self-hosting is tested separately.
 const engine=createReleaseEngine({repoRoot:process.cwd(),flags,projection,verificationDepth:1});
 const method=verb==='verify-remote'?'verifyRemote':verb;
 if(!engine[method]) throw Object.assign(new Error("unknown verb '"+verb+"'. Use: status | publish | release | ship | verify | verify-remote | log"),{exitCode:2});
 const result=await engine[method]();
 process.stdout.write(result.stdout);process.stderr.write(result.stderr||'');
 process.exitCode=result.exitCode;
}catch(error){process.stderr.write(error.message+'\\n');process.exitCode=error.exitCode||1;}
`;
}

/** Convert the historical fixture program to a callable test-only projection. */
function callableProjection(source) {
  const start=source.indexOf('const argv = process.argv.slice(2);');
  const imports=source.slice(0,start);
  const body=source.slice(start)
    .replace('const argv = process.argv.slice(2);',
      "const argv=[verb,...Object.entries(flags).flatMap(([key,value])=>value===true?['--'+key]:['--'+key,String(value)])];")
    .replace('const verb = argv[0];','')
    .replaceAll('process.stdout.write(', 'write(')
    .replaceAll('process.stderr.write(', 'warn(')
    .replace(/process\.exit\(([^;]+)\);/g,'return {stdout,stderr,exitCode:$1};')
    .replace("const target = flag('target');","const target = resolve(root, flag('target'));");
  return imports+"\nimport {resolve} from 'node:path';\nexport async function runProjection(root,verb,flags={}) {\n"
    +"let stdout='',stderr='';const write=s=>{stdout+=s;};const warn=s=>{stderr+=s;};\n"
    +body+"\n}\n";
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// The small runner imports the engine from this framework checkout and supplies the temporary
// repoRoot explicitly; no copied engine, source-root inference, or deprecated entrypoint exists.
/**
 * @param {{withService?: boolean, markerVersion?: string, targetIsRepo?: boolean}} [opts]
 *   targetIsRepo makes the core service's src/ its OWN git repository, the way the real one is.
 *   Without it `targetIsOwnRepo()` is false and the core-side `git add/commit/tag` branch — where
 *   the tag handling lives — never runs at all, so nothing in the suite could reach it.
 */
function fixture({ withService = true, markerVersion = '1.1.1', targetIsRepo = false } = {}) {
  const p = mkdtempSync(join(tmpdir(), 'sk-core-publish-'));
  mkdirSync(join(p, '.sidekicks'), { recursive: true });
  mkdirSync(join(p, 'scripts'), { recursive: true });
  writeFileSync(join(p, SCRIPT_REL), releaseRunner());
  mkdirSync(join(p, 'lib'), { recursive: true });
  mkdirSync(join(p, 'lib', 'core-lifecycle'), { recursive: true });
  writeFileSync(join(p, 'lib', 'core-lifecycle', 'config-templates.mjs'),
    readFileSync(join(repoRoot, 'lib', 'core-lifecycle', 'config-templates.mjs'), 'utf8'));
  // The script also reads `check run --json` through the runner's own reader, so the fixture needs
  // it for the import to resolve at all. Both files are import-closed (node:* only).
  mkdirSync(join(p, 'lib', 'check-lifecycle'), { recursive: true });
  writeFileSync(join(p, 'lib', 'check-lifecycle', '_shared.mjs'),
    readFileSync(join(repoRoot, 'lib', 'check-lifecycle', '_shared.mjs'), 'utf8'));
  writeFileSync(join(p, 'lib', 'placeholder.mjs'), 'export default 1;\n');
  writeFileSync(join(p, 'CLAUDE.md'), '# fixture\n');

  git(p, ['init', '-q', '-b', 'chore/fixture']);
  git(p, ['config', 'user.email', 'test@example.com']);
  git(p, ['config', 'user.name', 'Test']);
  git(p, ['add', '-A']);
  git(p, ['commit', '-q', '-m', 'base']);
  const base = git(p, ['rev-parse', '--short', 'HEAD']).out;

  if (withService) {
    mkdirSync(join(p, SRC_REL), { recursive: true });
    writeFileSync(
      join(p, SRC_REL, '.sidekicks-core.json'),
      JSON.stringify(
        {
          schema: 1,
          name: 'sidekicks-core',
          version: markerVersion,
          layout: 1,
          forged_at: '2026-08-13T09:35:21+07:00',
          source_commit: base,
        },
        null,
        2
      ) + '\n'
    );
    if (targetIsRepo) {
      // Init the inner repo BEFORE the root adds anything, so the root records a gitlink rather
      // than the files — which is exactly the real layout (the core is a submodule).
      const src = join(p, SRC_REL);
      git(src, ['init', '-q']);
      git(src, ['config', 'user.email', 'test@example.com']);
      git(src, ['config', 'user.name', 'Test']);
      git(src, ['add', '-A']);
      git(src, ['commit', '-q', '-m', 'core: initial']);
    }
    git(p, ['add', '-A']);
    git(p, ['commit', '-q', '-m', 'add core service']);
  }
  return { dir: p, base };
}

function run(cwd, args) {
  const r = spawnSync(process.execPath, [join(cwd, SCRIPT_REL), ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ── Inventory + stub-engine helpers ────────────────────────────────────────────────────────────
// The classifier compares what the core CARRIES against what the next forge WOULD carry, so a test
// of it has to build both sides. A unit is a directory with a VERSION.json — the same shape skills
// and lib modules both use, which is why one helper serves both.

const INHERIT_REL = join('fixtures', 'projection.mjs');

/** Write `<root>/<relDir>/<name>/VERSION.json` at a version. */
function unit(root, relDir, name, version) {
  const dir = join(root, relDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'VERSION.json'), JSON.stringify({ name, version }, null, 2) + '\n');
  return dir;
}

/**
 * A stub inherit engine.
 *
 * The real one is deliberately absent from these fixtures (no forge runs in the suite), but
 * `corePaths()` reads its `plan` output to learn the core-bound surface AND the skill set, so
 * classification cannot be exercised without something answering `plan`. The stub answers in the
 * exact shape the parser expects, and its `create`/`verify`/`drift` exit codes are dialled in per
 * test so a gate can be made to fail without a real forge.
 */
function writeStubEngine(
  root,
  {
    skills = [], verifyExit = 0, driftExit = 0, createExit = 0, planExit = 0,
    planExitAfterOutput = false, skillReasons = null,
    planCrlf = false,
    // Raw stdout override for the plan verb, so a malformed or truncated payload can be
    // reproduced. The publisher reads `inherit plan --json`, so "unparseable" now means "not
    // JSON" or "JSON that names no composition" rather than "prose the regex did not match".
    planStdout = null,
    // Development surfaces the stub forge writes INTO a skill folder, so the composition gate's
    // forbidden-payload refusal can be exercised against a real tree.
    shipDevSurfaces = [],
    // Skills the stub forge writes that the plan never named, for the selection-equality refusal.
    forgeExtraSkills = [],
    // The real forge ships scripts/run-tests.mjs (a framework-floor script) plus the core's own
    // test files, and gate 3 now runs THAT launcher rather than a glob of its own choosing. Both
    // are switchable so the zero-discovery and no-launcher failures can be reproduced.
    shipLauncher = true, shipTests = true,
    // Knobs for the re-publish reproducibility gate. `markerForgedAt` varies ONLY a timestamp (the
    // gate must ignore it); `extraFile` varies real content (the gate must catch it); `crlf` ships
    // the same bytes with Windows line endings (the gate must ignore that too).
    markerForgedAt = '2026-08-15T10:00:00+07:00', extraFile = null, crlf = false,
  } = {}
) {
  const enginePath = join(root, INHERIT_REL);
  mkdirSync(dirname(enginePath), { recursive: true });
  // The engine answers `plan --json`, so the stub answers in the same shape. The publisher used to
  // regex this command's prose, and the day the human header gained a suffix the release silently
  // lost its whole skill list — pinning the JSON contract here is what keeps that from returning.
  const planPayload = {
    schema: 1,
    root_structure: {schema:1,entries:[
      'SUBSTRATE.txt','.sidekicks-core.json','bin/sidekicks',
      ...(shipLauncher?['scripts/run-tests.mjs']:[]),...(shipTests?['tests/smoke.test.mjs']:[]),
      ...skills.flatMap(s=>['SKILL.md','VERSION.json'].map(file=>'.agents/skills/'+s+'/'+file)),
      ...(extraFile?[extraFile.path]:[]),
    ].map(path=>({path,kind:'file',included:true,executable:false,hash:null,generated:true,
      reason:'synthetic release fixture'}))},
    runtime: null,
    target: 'stub-target',
    target_exists: false,
    as_core: true,
    preset: ['framework'],
    pack_skills: 'none',
    skills: skills.map((skill, i) => ({
      skill,
      found: true,
      origin: 'active',
      version: '1.0.0',
      required: i === 0,
      reasons: skillReasons?.[skill]
        ?? (i === 0 ? ['declared', 'required-floor'] : ['declared']),
      unmet_dependencies: [],
      projection: {
        copied_files: 1, copied_bytes: 10, excluded_files: 0, excluded_bytes: 0,
        excluded_by_class: {},
      },
    })),
    skill_names: [...skills].sort(),
    required_floor: skills.slice(0, 1),
    substrate: ['bin', 'lib'],
    agent_packs: { shipped: 0, contributed: [], declared: [], via_closure: [] },
    payload: {
      totals: {
        copied_files: skills.length, copied_bytes: 10 * skills.length,
        excluded_files: 0, excluded_bytes: 0,
      },
      excluded_by_class: {},
    },
    runtime_excluded_dirs: ['improvements', 'evals', 'tests'],
    problems: [],
    warnings: [],
  };
  writeFileSync(
    enginePath,
    callableProjection(`#!/usr/bin/env node
// Test stub. Answers just enough of the inherit surface for framework-core-publish.
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const verb = argv[0];
const flag = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? null : argv[i + 1]; };
if (verb === 'plan') {
  if (${planExit} && !${planExitAfterOutput}) {
    process.stderr.write('framework preset cannot be composed: forbidden dependency\\n');
    process.exit(${planExit});
  }
  const payload = ${JSON.stringify(JSON.stringify(planPayload, null, 2))};
  const body = ${JSON.stringify(planStdout)} ?? payload;
  process.stdout.write(${planCrlf} ? body.split('\\n').join('\\r\\n') : body);
  process.exit(${planExitAfterOutput ? planExit || 4 : 0});
}
if (verb === 'create' || verb === 'forge') {
  const target = flag('target');
  mkdirSync(join(target, '.sidekicks'), { recursive: true });
  writeFileSync(join(target, '.sidekicks-core.json'), JSON.stringify({
    schema: 1, name: flag('name'), version: flag('core-version'), layout: 1,
    forged_at: '${markerForgedAt}', source_commit: 'stub',
  }, null, 2) + '\\n');
  {
    const body = 'core substrate marker\\nsecond line\\n';
    writeFileSync(join(target, 'SUBSTRATE.txt'), ${crlf} ? body.split('\\n').join('\\r\\n') : body);
  }
  ${extraFile ? `writeFileSync(join(target, ${JSON.stringify(extraFile.path)}), ${JSON.stringify(extraFile.content)});` : ''}
  if (!existsSync(join(target, 'bin'))) mkdirSync(join(target, 'bin'), { recursive: true });
  // The forged skill tree is what the composition gate grades, so the stub has to produce one.
  for (const s of ${JSON.stringify(skills)}.concat(${JSON.stringify(forgeExtraSkills)})) {
    const d = join(target, '.agents', 'skills', s);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), '---\\nname: ' + s + '\\n---\\n');
    // Exact-root verification includes skill metadata. Keep seeded incident versions.
    if (!existsSync(join(d, 'VERSION.json'))) {
      writeFileSync(join(d, 'VERSION.json'), JSON.stringify({ name: s, version: '1.0.0' }));
    }
    for (const dev of ${JSON.stringify(shipDevSurfaces)}) {
      mkdirSync(join(d, dev), { recursive: true });
      writeFileSync(join(d, dev, 'note.md'), 'development evidence\\n');
    }
  }
  if (${shipLauncher}) {
    mkdirSync(join(target, 'scripts'), { recursive: true });
    copyFileSync(${JSON.stringify(join(repoRoot, 'scripts', 'run-tests.mjs'))},
      join(target, 'scripts', 'run-tests.mjs'));
  }
  if (${shipTests}) {
    mkdirSync(join(target, 'tests'), { recursive: true });
    writeFileSync(join(target, 'tests', 'smoke.test.mjs'),
      "import { test } from 'node:test';\\n"
      + "import assert from 'node:assert/strict';\\n"
      + "test('the forged core runs its own tests', () => { assert.ok(true); });\\n");
  }
  process.exit(${createExit});
}
if (verb === 'verify') process.exit(${verifyExit});
if (verb === 'drift') process.exit(${driftExit});
process.exit(0);
`)
  );
  return enginePath;
}

/** A stub CLI inside the target, so gate 2 (`config`/`framework doctor`) has something to run. */
function writeTargetCli(root, { doctorExit = 0 } = {}) {
  const bin = join(root, SRC_REL, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'sidekicks'),
    `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[1] === 'doctor') process.exit(${doctorExit});
process.exit(0);
`
  );
}

function cleanup(f) {
  rmSync(f.dir, { recursive: true, force: true });
}

/** A fixture wired for a full publish: stub engine, stub target CLI, a core-bound change. */
/**
 * Put the real launcher plus one passing test into an already-forged core.
 *
 * @param {string} root - fixture repo root
 * @param {{shipLauncher?: boolean, shipTests?: boolean}} [opts]
 */
function seedCoreTestGate(root, { shipLauncher = true, shipTests = true } = {}) {
  if (shipLauncher) {
    mkdirSync(join(root, SRC_REL, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, SRC_REL, 'scripts', 'run-tests.mjs'),
      readFileSync(join(repoRoot, 'scripts', 'run-tests.mjs'), 'utf8')
    );
  }
  if (shipTests) {
    mkdirSync(join(root, SRC_REL, 'tests'), { recursive: true });
    writeFileSync(
      join(root, SRC_REL, 'tests', 'smoke.test.mjs'),
      "import { test } from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "test('the forged core runs its own tests', () => { assert.ok(true); });\n"
    );
  }
}

function publishable(opts = {}) {
  const f = fixture({ targetIsRepo: Boolean(opts.targetIsRepo) });
  writeStubEngine(f.dir, { skills: ['alpha'], ...opts });
  writeTargetCli(f.dir, opts);
  unit(f.dir, join(SRC_REL, '.agents', 'skills'), 'alpha', '1.0.0');
  unit(f.dir, join('.agents', 'skills'), 'alpha', '1.0.0');
  // A core that is already forged carries its own test gate. `verify` runs against exactly that —
  // no create happens — so the launcher and at least one test file must be there before it runs.
  seedCoreTestGate(f.dir, opts);
  if (opts.targetIsRepo) {
    // A core that is its own repo has its content COMMITTED — the mount-check gate clones HEAD,
    // so anything only sitting in the worktree would be invisible to it.
    git(join(f.dir, SRC_REL), ['add', '-A']);
    git(join(f.dir, SRC_REL), ['commit', '-q', '-m', 'core: seed']);
    // The protected-branch floor holds in BOTH repos, so a core left on its default branch would
    // stop every landing at exit 4 before the tag logic is ever reached.
    git(join(f.dir, SRC_REL), ['checkout', '-q', '-b', 'chore/core-release']);
  }
  writeFileSync(join(f.dir, 'lib', 'placeholder.mjs'), 'export default 42;\n');
  git(f.dir, ['add', '-A']);
  git(f.dir, ['commit', '-q', '-m', 'feat(lib): something core-bound']);
  return f;
}


export {repoRoot,SCRIPT_REL,RELEASE_REL,SERVICE_REL,SRC_REL,RUN_REL,INHERIT_REL,git,fixture,run,unit,writeStubEngine,writeTargetCli,cleanup,seedCoreTestGate,publishable};
