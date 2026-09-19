// tests/skills/inherit-as-core.test.mjs
//
// AAP-110 — `sk-publish-core create --as-core`: the files that turn a forged runtime into a
// distributable FRAMEWORK CORE, mountable as a git submodule at <workspace>/.sidekicks-core/.
//
// Four concerns, each one a thing that fails silently:
//   1. The MARKER exists and is well-formed. A core without it mounts, looks fine, and captures the
//      repo root from every hook — the workspace's memory and settings are then invisible.
//   2. Every template renders with NO leftover {{PLACEHOLDER}}. A stray placeholder in install.sh is
//      a broken installer that only fails on a user's machine.
//   3. `--preset framework` implies --as-core (that preset exists to build this repo) while another
//      preset does not, and --no-as-core opts out.
//   4. A forged core is still SELF-RUNNABLE. Its own CLI must work despite the marker, or
//      sk-publish-core cannot self-heal what it just forged.
//
// A forge is not cheap, so the core is built ONCE in before() and the assertions read it.
// Imports only node:* built-ins.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, readdirSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceFixture } from './_source-fixture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(__dirname, '..', '..', '..');
const sourceSnapshot = sourceFixture(sourceRoot);
const repoRoot = sourceSnapshot.root;
after(() => sourceSnapshot.cleanup());
const skillDir = join(repoRoot, '.agents', 'skills', 'sk-publish-core');
const engine = join(sourceRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');
const { copyTree } = await import('../surfaces.mjs');

const REMOTE = 'https://github.com/utranand/sidekicks-framework.git';
const DIST_FILES = ['.sidekicks-core.json', 'install.sh', 'install.ps1', 'README.md', 'AGENTS.framework.md'];

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

function withPackSource(t) {
  const packs = join(repoRoot, '.sidekicks', 'agent-packs');
  const pack = readdirSync(packs).filter(name => existsSync(join(packs, name, 'pack.yaml')))
    .map(name => readFileSync(join(packs, name, 'pack.yaml'), 'utf8')).join('\n');
  const declared = [...pack.matchAll(/^ {2}- name: (\S+)$/gm)].map(m => m[1]);
  assert.ok(declared.length, 'pack fixture must exercise declared skills');
  const fixture = sourceFixture(repoRoot, Object.fromEntries(declared.map(name => [name, {}])));
  ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = fixture.root;
  t.after(() => { ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = repoRoot; fixture.cleanup(); });
}

function inherit(...args) {
  const r = spawnSync(process.execPath, [engine, ...args], { cwd: repoRoot, encoding: 'utf8', env: ENGINE_ENV });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Forge a core into a fresh temp dir. Uses the tiny `core` preset — 4 skills, no venv. */
function forge(dir, ...extra) {
  return inherit('create', '--name', 'as-core-test', '--target', dir,
    '--skills', 'sk-hello,sk-cli,sk-skill-manager,sk-config-doctor,sk-commander,sk-scope-switch', '--pack-skills', 'none', '--force', '--no-venv', '--remote', REMOTE, ...extra);
}

// --core-version is REQUIRED with --as-core: there is no default any more, because the only one
// available was this repo's package.json version, which tracks the repo and not the core.
const CORE_VERSION = '2.0.0';

test('copyTree refuses a symlink before it can disguise denied secret bytes', {
  skip: process.platform === 'win32' ? 'symlink creation needs Developer Mode or elevation' : false,
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'sk-publish-core-symlink-'));
  try {
    const src = join(fixture, 'src');
    const dst = join(fixture, 'dst');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(fixture, '.env'), 'TOKEN=must-not-travel\n', 'utf8');
    symlinkSync(join(fixture, '.env'), join(src, 'safe-name.md'));
    assert.throws(
      () => copyTree(src, dst),
      /refusing symlink in copy surface: safe-name\.md/,
    );
    assert.equal(existsSync(join(dst, 'safe-name.md')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

before(() => {
  base = mkdtempSync(join(tmpdir(), 'sk-as-core-'));
  core = join(base, 'core');
  // `--pack-skills none` on the SHARED fixture, on purpose. This core exists to exercise the
  // distribution surfaces and the verify gates, and it is forged --no-venv to stay fast — but a
  // skill an agent pack declares may carry Python, and verify rightly fails a runtime that needs a
  // venv and has none. That is an unrelated failure mode, so the pack-skill derivation gets its own
  // fixtures further down rather than making every gate here depend on a venv build.
  const r = forge(core, '--as-core', '--core-version', CORE_VERSION, '--pack-skills', 'none');
  assert.equal(r.status, 0, `forge failed:\n${r.stdout}\n${r.stderr}`);
});

after(() => {
  if (base) { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
  // The forge registers the runtime in the source repo; drop the entry so the registry stays honest.
  inherit('forget', '--name', 'as-core-test');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. The marker
// ═══════════════════════════════════════════════════════════════════════════════

test('--as-core writes a well-formed .sidekicks-core.json marker', () => {
  const marker = JSON.parse(readFileSync(join(core, '.sidekicks-core.json'), 'utf8'));
  assert.equal(marker.schema, 1);
  assert.equal(marker.name, 'as-core-test');
  assert.equal(marker.layout, 1);
  assert.match(marker.version, /^\d+\.\d+\.\d+/, 'the version pins what a workspace mounts');
  assert.match(marker.forged_at, /\+07:00$/, 'timestamps are Asia/Bangkok with an explicit offset');
  assert.ok(marker.source_commit, 'the marker records which source commit forged it');
});

test('the marker version is exactly what --core-version stated', () => {
  const marker = JSON.parse(readFileSync(join(core, '.sidekicks-core.json'), 'utf8'));
  assert.equal(marker.version, CORE_VERSION);

  const other = join(base, 'core-pinned');
  const r = forge(other, '--as-core', '--core-version', '9.9.9');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(other, '.sidekicks-core.json'), 'utf8')).version, '9.9.9');
});

test('--as-core without --core-version is REFUSED, and never forges', () => {
  // The removed default read this repo's package.json, which tracks the REPO, not the core's own
  // version line. package.json sat at 1.1.0 while the distributed marker was 1.4.1, so a hand forge
  // silently downgraded every consumer's marker by three minors (INC-2026-09-04-01, F-5).
  const dir = join(base, 'core-no-version');
  const r = forge(dir, '--as-core');
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr + r.stdout, /--as-core requires --core-version/);
  assert.ok(!existsSync(join(dir, '.sidekicks-core.json')), 'a refused forge must write nothing');
});

test('the refusal points at the publish script rather than at a workaround', () => {
  const r = forge(join(base, 'core-no-version-2'), '--as-core');
  assert.match(r.stderr + r.stdout, /bin\/sidekicks core publish/);
});

test('a --core-version LOWER than the marker the target carries is refused', () => {
  const dir = join(base, 'core-downgrade');
  assert.equal(forge(dir, '--as-core', '--core-version', '4.0.0').status, 0);

  const down = forge(dir, '--as-core', '--core-version', '3.9.9');
  assert.equal(down.status, 2, `${down.stdout}\n${down.stderr}`);
  assert.match(down.stderr + down.stdout, /LOWER than the 4\.0\.0 this target already stamps/);
  assert.equal(
    JSON.parse(readFileSync(join(dir, '.sidekicks-core.json'), 'utf8')).version,
    '4.0.0',
    'the refused forge must leave the marker where it was'
  );

  // …and --force-downgrade is the explicit yes that lets a deliberate rollback through.
  const forced = forge(dir, '--as-core', '--core-version', '3.9.9', '--force-downgrade');
  assert.equal(forced.status, 0, `${forced.stdout}\n${forced.stderr}`);
  assert.equal(JSON.parse(readFileSync(join(dir, '.sidekicks-core.json'), 'utf8')).version, '3.9.9');
});

test('a --core-version that is not semver is refused', () => {
  const r = forge(join(base, 'core-bad-version'), '--as-core', '--core-version', 'latest');
  assert.equal(r.status, 2);
  assert.match(r.stderr + r.stdout, /is not a semver/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Rendering
// ═══════════════════════════════════════════════════════════════════════════════

test('the core package.json version matches the marker, so --version and core status agree', () => {
  // `sidekicks --version` reads the package.json next to the CLI it ran — the CORE's, in a mounted
  // workspace. writeRuntimeScaffold seeds it at 0.1.0, which would show the user two different
  // version numbers for one framework.
  const marker = JSON.parse(readFileSync(join(core, '.sidekicks-core.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'));
  assert.equal(pkg.version, marker.version);

  const r = spawnSync(process.execPath, [join(core, 'bin', 'sidekicks'), '--version'],
    { cwd: core, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), marker.version);
});

test('every core distribution file is written', () => {
  for (const f of DIST_FILES) {
    assert.ok(existsSync(join(core, f)), `--as-core did not write ${f}`);
  }
});

test('a core discovers safe configuration templates without copying source-specific office state', () => {
  const manifest = JSON.parse(readFileSync(join(core, '.sidekicks', 'inherit.json'), 'utf8'));
  const inventory = manifest.configuration ?? [];
  const office = inventory.find((row) => row.destination === '.sidekicks/config/office-config.json'
    && row.classification === 'template');
  assert.ok(office, 'the discovered inventory must record the office template initializer');
  assert.equal(office.initializer_origin, '.sidekicks/config/office-config.example.json');
  const rendered = JSON.parse(readFileSync(join(core, '.sidekicks', 'config', 'office-config.json'), 'utf8'));
  assert.deepEqual(rendered.deptRooms, [], 'a core must not inherit the source repository departments');
  assert.ok(existsSync(join(core, '.sidekicks', 'config', 'agents-watch.example.yaml')),
    'paired examples travel by convention, without a CORE_SURFACES entry');
});

test('no distribution file contains an unsubstituted {{PLACEHOLDER}}', () => {
  for (const f of DIST_FILES) {
    const text = readFileSync(join(core, f), 'utf8');
    const leftover = text.match(/\{\{[A-Z_]+\}\}/g);
    assert.equal(leftover, null, `${f} has unsubstituted placeholders: ${leftover?.join(', ')}`);
  }
});

test('the installers carry the real remote and mount path', () => {
  const sh = readFileSync(join(core, 'install.sh'), 'utf8');
  assert.match(sh, /^#!\/bin\/sh/, 'install.sh must be POSIX sh, runnable on macOS, Linux and Git Bash');
  assert.ok(sh.includes(REMOTE), 'the default remote must be baked in');
  assert.ok(sh.includes('.sidekicks-core'), 'it must mount at the path the resolvers know about');
  assert.ok(sh.includes('core init'), 'it must hand off to the CLI rather than seeding by hand');
  // submodule add -b takes a BRANCH only; using it with a release tag half-adds the submodule.
  assert.doesNotMatch(sh, /submodule add[^\n]*-b /,
    'install.sh must not use `submodule add -b` — it cannot check out a tag');

  const ps1 = readFileSync(join(core, 'install.ps1'), 'utf8');
  assert.ok(ps1.includes(REMOTE));
  assert.ok(ps1.includes('core init'));
  assert.doesNotMatch(ps1, /submodule add[^\n]*-b /);
});

test('install.sh is executable on POSIX', { skip: process.platform === 'win32' }, () => {
  const mode = statSync(join(core, 'install.sh')).mode & 0o777;
  assert.ok((mode & 0o111) !== 0, `install.sh is not executable (mode ${mode.toString(8)})`);
});

test('README documents the curl one-liner and the raw URL is derived from a github remote', () => {
  const readme = readFileSync(join(core, 'README.md'), 'utf8');
  assert.match(readme, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/utranand\/sidekicks-framework\/main\/install\.sh/);
  assert.match(readme, /core update/, 'the update path must be documented, not just the install');
  assert.match(readme, /prevents accidents, not intent/i,
    'the push guard\'s real scope must be stated, not overclaimed');
});

test('every version the README names is the one being forged — no hard-coded example tags', () => {
  // INC-2026-09-04-02, N-5. The `core update --ref` example was a literal `v1.2.3`, a tag the remote
  // has never served, so the README's own documented command answered "none of the refs resolve".
  // The unrendered-placeholder check cannot catch this: a literal passes it trivially.
  const readme = readFileSync(join(core, 'README.md'), 'utf8');
  const named = [...readme.matchAll(/--ref\s+(v\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'the README must show how to pin a release at all');
  assert.deepEqual([...new Set(named)], [`v${CORE_VERSION}`],
    'the only version a README may advertise is the release it was forged for');
});

test('the README tells a pre-handoff mount what to run after updating', () => {
  // INC-2026-09-04-03, R-3. Nothing this release ships can reach a workspace already mounted on an
  // affected version — the code that mishandles the upgrade is the code already there. The README on
  // the core's default branch is the ONE surface such a workspace fetches fresh, so it is where the
  // workaround has to live, and it must survive every future forge.
  //
  // INC-2026-09-05-04, R-3 narrowed the boundary from v1.4.3 to v1.4.2. v1.4.3 already shipped the
  // wiring rewrite and the .gitmodules staging; only the handoff was missing, and on the
  // v1.4.3 -> v1.4.4 hop the handoff has nothing left to fix. The release gate proves it on every
  // candidate by upgrading a real previous-release workspace, and the audit measured that hop clean
  // three times — so telling v1.4.3 users to run two commands, and warning them about dangling hooks
  // the gate shows they will not get, was a claim the project's own evidence contradicted.
  const readme = readFileSync(join(core, 'README.md'), 'utf8');
  assert.match(readme, /Updating from v1\.4\.2 or earlier/,
    'the README must name the releases whose update does not finish itself');
  assert.doesNotMatch(readme, /Updating from v1\.4\.3 or earlier/,
    'v1.4.3 -> v1.4.4 is measured clean; do not send those users through a repair they do not need');
  assert.match(readme, /core init/, 'and the wiring re-apply that repairs it');
  assert.match(readme, /git add \.gitmodules/, 'and the staging the old code skipped');
});

test('the README warns Windows users that the instruction mirrors need Developer Mode', () => {
  // INC-2026-09-05-05, W-3/R-5. Directory links are junctions and need no privilege, but CLAUDE.md
  // is a FILE link, which an unprivileged Windows process cannot create without Developer Mode — so
  // it lands as a copy. The install path handles it; the README never said so, which left a Windows
  // reader with a file that looks like the instruction surface and can be behind it.
  const readme = readFileSync(join(core, 'README.md'), 'utf8');
  assert.match(readme, /Developer Mode/, 'the Windows caveat must be in the README, not only in code');
  assert.match(readme, /CLAUDE\.md/, 'and must name the files it is about');
});

test('README names the workspace instruction surface and the doc this core actually ships', () => {
  const readme = readFileSync(join(core, 'README.md'), 'utf8');
  // The rename (CLAUDE.framework.md -> AGENTS.framework.md) exposed the older half of the same bug:
  // the README described a workspace whose instruction file was CLAUDE.md, which has been a symlink
  // to AGENTS.md since the Rule 6 flip. A reader following it edited a mirror.
  assert.match(readme, /`AGENTS\.md` is the instruction surface/,
    'the README must name AGENTS.md, not a mirror, as the file the workspace owner edits');
  assert.match(readme, /`\.sidekicks-core\/AGENTS\.framework\.md`/,
    'the imported doc is templated from the forge — it must name the file this core ships');
  assert.match(readme, /managed blocks inside\n?`?\.gitignore` and `AGENTS\.md`/,
    'core update refreshes the block in AGENTS.md');
  assert.doesNotMatch(readme, /CLAUDE\.md` are yours/,
    'the uninstall section must not call a symlink the user\'s own file');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2b. The release delta — the destination is scanned BEFORE it is overwritten
// ═══════════════════════════════════════════════════════════════════════════════
// A core is regenerated wholesale, so the tree being replaced is the only record of what a release
// changes. Nothing else in the pipeline can reconstruct it afterwards.

test('a first forge reports every file as new, in the README and on stdout', () => {
  const dir = join(base, 'delta-first');
  const r = forge(dir, '--as-core', '--core-version', CORE_VERSION);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /first release into this destination — all \d+ shipped file\(s\) are new/);
  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /## Changes in this release/);
  assert.match(readme, /is the first release forged into this repository/);
});

test('re-forging the same source reports NO shipped change — generated headers are masked', () => {
  const dir = join(base, 'delta-idempotent');
  assert.equal(forge(dir, '--as-core', '--core-version', '3.0.0').status, 0);
  const again = forge(dir, '--as-core', '--core-version', '3.0.0');
  assert.equal(again.status, 0, again.stderr);
  // Every generated file carries a forge timestamp and the source commit. Without masking, this is
  // the case that reports the whole distribution as changed on every release — which is the same as
  // reporting nothing at all.
  assert.match(again.stdout, /NO shipped file changed since v3\.0\.0/);
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /\*\*No shipped file changed\.\*\*/);
});

test('a changed and a missing shipped file land in the right surface of the README table', () => {
  const dir = join(base, 'delta-surfaces');
  assert.equal(forge(dir, '--as-core', '--core-version', '3.1.0').status, 0);

  // Stand in for "the previous release shipped something different here": mutate one library file and
  // remove another. The next forge restores both, so it must report one changed and one added.
  const touched = join(dir, 'lib', 'sk-cli', 'help.mjs');
  writeFileSync(touched, `${readFileSync(touched, 'utf8')}\n// destination drift\n`);
  rmSync(join(dir, 'lib', 'sk-cli', 'core-mount.mjs'), { force: true });

  // The third change is package.json's version stamp, which the bump below really does alter — proof
  // that version strings are NOT masked away with the timestamps.
  const r = forge(dir, '--as-core', '--core-version', '3.2.0');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /vs v3\.1\.0: 1 added, 2 changed, 0 removed/);

  const readme = readFileSync(join(dir, 'README.md'), 'utf8');
  assert.match(readme, /over \*\*v3\.1\.0\*\*/, 'the README names the release it replaced');
  assert.match(readme, /\| `lib\/` — framework libraries \| 1 \| 1 \| 0 \|/,
    'both files belong to the lib/ surface, counted separately as added and changed');
  assert.match(readme, /\| packaging \| 0 \| 1 \| 0 \|/, 'the version stamp is a real, reported change');
  assert.match(readme, /derived by comparing the forged tree/,
    'the table must say it is derived, so no one hand-edits it');
});

test('the instruction body is true for a MOUNT, not only for a standalone clone', () => {
  // INC-2026-09-04-02, N-6. AGENTS.framework.md is a mount preamble prepended to this same body, and
  // the body described only the standalone case — so the preamble said "your instructions go in the
  // workspace's AGENTS.md" and four lines later the body said "put them in AGENTS.local.md here",
  // inside a read-only submodule. The fix is one body true for both readers, because the
  // endsWith invariant below is what keeps the two files from drifting.
  const body = readFileSync(join(core, 'AGENTS.md'), 'utf8');
  assert.match(body, /Mounted at `\.sidekicks-core\/` by a workspace/,
    'the mount case must be named first — it is the usual one');
  assert.match(body, /This tree is read-only/i);
  assert.match(body, /It runs two ways/,
    '"a standalone runtime; git clone is all it takes" was false for every consumer');
  assert.match(body, /moves to a newer runtime with `sidekicks core update`/,
    '"refresh skills by running sk-publish-core in the source repo" is not a consumer instruction');
  assert.match(body, /\.venv[^\n]*WORKSPACE root/,
    'a .venv at "the repo root" would land inside the read-only mount');
});

test('AGENTS.framework.md is the runtime AGENTS.md plus a mount preamble', () => {
  const framework = readFileSync(join(core, 'AGENTS.framework.md'), 'utf8');
  const agents = readFileSync(join(core, 'AGENTS.md'), 'utf8');
  assert.ok(framework.endsWith(agents),
    'it must be the same generated body — one source, so the two cannot drift');
  assert.match(framework, /GENERATED by sk-publish-core/);
  assert.match(framework, /\.sidekicks-core\//, 'the preamble explains the mount context');
  assert.equal(existsSync(join(core, 'CLAUDE.framework.md')), false,
    'the pre-rename name must not survive a forge — two copies of the rules would drift');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. When --as-core applies
// ═══════════════════════════════════════════════════════════════════════════════

test('another preset does NOT get the distribution unless --as-core is passed', () => {
  const plain = join(base, 'core-plain');
  const r = forge(plain);                      // preset `core`, no --as-core
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(plain, '.sidekicks-core.json')), false,
    'an ordinary runtime must not be marked as a core — the marker changes root resolution');
  assert.equal(existsSync(join(plain, 'install.sh')), false);
});

test('--no-as-core opts a framework-preset forge out of the distribution', () => {
  // Asserted on the flag logic rather than by forging the 18-skill framework preset, which would
  // build a venv and dominate this suite's runtime.
  const src = readFileSync(join(repoRoot, 'lib', 'core-forge', 'forge.mjs'), 'utf8');
  assert.match(src, /truthyFlag\(flags\["no-as-core"\]\)\s*\n?\s*\?\s*false/,
    'no-as-core must short-circuit to false before the preset default is consulted');
  assert.match(src, /presetNames\.includes\("framework"\)/,
    'the framework preset must imply --as-core');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. A core is still self-runnable, and verify knows about the distribution
// ═══════════════════════════════════════════════════════════════════════════════

test('a forged core runs its own CLI despite carrying the marker', () => {
  // Tier 3 of resolveRepoRoot: a STANDALONE core is its own root. Without it, inherit cannot
  // self-heal the runtime it just forged — the observed failure when the marker skip was absolute.
  const r = spawnSync(process.execPath, [join(core, 'bin', 'sidekicks'), 'index', 'show', '--json'],
    { cwd: core, encoding: 'utf8' });
  assert.equal(r.status, 0, `the core's own CLI failed:\n${r.stderr}`);
});

test('inherit verify checks the core distribution and passes on a complete one', () => {
  const r = inherit('verify', '--name', 'as-core-test', '--target', core);
  assert.equal(r.status, 0, `verify failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /ok\s+core marker present/);
  assert.match(r.stdout, /ok\s+core distribution complete/);
  assert.match(r.stdout, /ok\s+install\.sh is fully rendered/);
});

test('the forged config/ carries the ignore rule that keeps *.secret.yaml out of git', () => {
  // A runtime is a DIFFERENT repo by construction, so the source's repo-root .gitignore does not
  // reach it — which is exactly why this rule lives inside config/ rather than at the root. Omitting
  // it from the copy surfaces shipped cores whose config/ would happily stage a credential file.
  // Found by running `sidekicks config doctor` INSIDE a forged core (secret-files-not-ignored),
  // which no test did until framework-core-publish made it a release gate.
  const ignore = join(core, '.sidekicks', 'config', '.gitignore');
  assert.ok(existsSync(ignore), 'the forged core must carry .sidekicks/config/.gitignore');
  assert.match(readFileSync(ignore, 'utf8'), /^\*\.secret\.yaml$/m);

  const r = spawnSync(process.execPath, [join(core, 'bin', 'sidekicks'), 'config', 'doctor'],
    { cwd: core, encoding: 'utf8' });
  assert.doesNotMatch(
    `${r.stdout}${r.stderr}`, /secret-files-not-ignored/,
    'the core\'s own config doctor must not report committable credentials'
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Agent packs travel with the DISTRIBUTION, and only with it
// ═══════════════════════════════════════════════════════════════════════════════

test('a forged core carries the built-in agent packs, and can read its own', () => {
  // The release closure question: is the pack actually IN the artifact a user mounts? Asserted on
  // the forged tree rather than on the copy plan, because a plan that says it copied is not a file.
  const manifest = join(core, '.sidekicks', 'agent-packs', 'core', 'pack.yaml');
  assert.ok(existsSync(manifest), 'the core preset must ship the built-in `core` agent pack');
  assert.match(readFileSync(manifest, 'utf8'), /^schema: agent-pack\/v1$/m);
  for (const a of ['ethan', 'debby', 'steve', 'molly']) {
    assert.ok(existsSync(join(core, '.sidekicks', 'agent-packs', 'core', 'agents', a, 'agent.yaml')),
      `the pack shipped without ${a}`);
  }

  // …and the core's own CLI must be able to read them. A pack that copied but does not parse in the
  // artifact is the failure this catches — the consumer would only find out on their machine.
  const r = spawnSync(process.execPath, [join(core, 'bin', 'sidekicks'), 'agent', 'pack', 'list', '--json'],
    { cwd: core, encoding: 'utf8' });
  assert.equal(r.status, 0, `the core cannot list its own packs:\n${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  const pack = payload.packs.find((p) => p.id === 'core');
  assert.ok(pack, 'the forged core does not discover the pack it shipped');
  assert.equal(pack.state, 'not-installed',
    'a freshly forged core must carry the pack UNINSTALLED — shipping is not installing');
  assert.deepEqual(pack.agents.map((a) => a.state), ['absent', 'absent', 'absent', 'absent']);
});

test('the forged core carries NO agents — the pack is shipped, not applied', () => {
  // The whole optionality guarantee in one assertion. `.sidekicks/agents/` must not exist in the
  // artifact: the forge never bulk-copies it, and nothing in the core distribution installs a pack.
  assert.equal(existsSync(join(core, '.sidekicks', 'agents')), false,
    'a published core must ship no agent — a user gets one only by asking for it');
});

test('--pack-skills declared carries the skills its shipped packs declare', (t) => {
  withPackSource(t);
  // The `declared` OVERRIDE, not the publication default. A published core forges `none`: both
  // pack.yaml headers say the skills they name are declared and never bundled, and `agent pack
  // install` already refuses before writing with the exact import commands. This mode stays
  // supported for a deliberately larger distribution, and what it promises is that the pack's own
  // rows resolve — so the assertion reads the shipped manifest rather than naming skills here.
  const withPackSkills = join(base, 'core-pack-skills');
  const forged = forge(withPackSkills, '--as-core', '--core-version', CORE_VERSION,
    '--pack-skills', 'declared');
  assert.equal(forged.status, 0, `forge failed:\n${forged.stdout}\n${forged.stderr}`);
  const manifest = readFileSync(join(withPackSkills, '.sidekicks', 'agent-packs', 'core', 'pack.yaml'), 'utf8');
  const declared = [...manifest.matchAll(/^ {2}- name: (\S+)$/gm)].map((m) => m[1]);
  assert.ok(declared.length, 'the built-in pack declares no skill — this assertion would be vacuous');
  for (const skill of declared) {
    assert.ok(existsSync(join(withPackSkills, '.agents', 'skills', skill)),
      `the core ships the pack but not '${skill}', which the pack declares — install would refuse`);
  }

  // …and the consumer's install path agrees. Asked of the core's OWN CLI, because that is the code
  // that will run on their machine.
  const r = spawnSync(process.execPath,
    [join(withPackSkills, 'bin', 'sidekicks'), 'agent', 'pack', 'list', '--json'],
    { cwd: withPackSkills, encoding: 'utf8' });
  assert.equal(r.status, 0, `the core cannot list its own packs:\n${r.stderr}`);
  const pack = JSON.parse(r.stdout).packs.find((p) => p.id === 'core');
  assert.ok(pack.dependencies?.length, 'no dependency rows came back — the check would be vacuous');
  for (const dep of pack.dependencies) {
    assert.equal(dep.status, 'available',
      `pack dependency '${dep.name}' is ${dep.status} in the forged core`);
  }
});

test('a forged core carries no skill-development evidence', (t) => {
  // A skill folder is a source tree: improvements/ is the funnel's evidence, evals/ holds trigger
  // fixtures, tests/ holds a harness the core's own runner never discovers. None of it is reachable
  // from an invoked runtime path, and shipping it made the published core a copy of the development
  // workspace. Asserted on the ARTIFACT, and only where the SOURCE actually has one — otherwise the
  // check passes for the wrong reason the day the evidence moves.
  const skills = readdirSync(join(core, '.agents', 'skills')).sort();
  assert.ok(skills.length, 'no skills were forged — this assertion would be vacuous');
  let sourcesWithEvidence = 0;
  for (const skill of skills) {
    for (const dir of ['improvements', 'evals', 'tests']) {
      if (existsSync(join(repoRoot, '.agents', 'skills', skill, dir))) sourcesWithEvidence += 1;
      assert.equal(
        existsSync(join(core, '.agents', 'skills', skill, dir)), false,
        `${skill}/${dir}/ is development evidence and must not travel into a runtime`
      );
    }
  }
  // A lean source has already stripped its evidence. Exercise the exclusion with an explicit
  // source fixture as well, so this incident remains non-vacuous when the suite travels.
  const fixture = sourceFixture(repoRoot, {
    'projection-evidence': { 'tests/probe.mjs': 'throw new Error("must not ship");\n',
      'evals/case.json': '{}\n', 'improvements/note.md': '# Evidence\n' },
  });
  ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = fixture.root;
  t.after(() => { ENGINE_ENV.SIDEKICKS_TEST_PROJECTION_SOURCE = repoRoot; fixture.cleanup(); });
  const target = join(base, 'evidence-fixture');
  const result = forge(target, '--skills', 'projection-evidence', '--as-core', '--core-version', CORE_VERSION, '--pack-skills', 'none');
  assert.equal(result.status, 0, result.stderr);
  for (const dir of ['tests', 'evals', 'improvements'])
    assert.equal(existsSync(join(target, '.agents', 'skills', 'projection-evidence', dir)), false, dir);
});

test('every skill in a forged core records why it is there, pack-derived ones included', (t) => {
  withPackSource(t);
  // Pack contribution used to be the ONE selection path that recorded no reason, so the 25 skills
  // hardest to justify later were the 25 with no justification. `--pack-skills declared` is the
  // cheapest mode that exercises it.
  const withReasons = join(base, 'core-pack-reasons');
  const forged = forge(withReasons, '--as-core', '--core-version', CORE_VERSION,
    '--pack-skills', 'declared');
  assert.equal(forged.status, 0, `forge failed:\n${forged.stdout}\n${forged.stderr}`);
  const manifest = JSON.parse(readFileSync(join(withReasons, '.sidekicks', 'inherit.json'), 'utf8'));
  const units = Object.entries(manifest.units).filter(([, rec]) => rec.kind === 'skill');
  assert.ok(units.length, 'no skill units recorded — this assertion would be vacuous');
  let packDerived = 0;
  for (const [unit, rec] of units) {
    assert.ok(rec.selection_reasons?.length, `${unit} carries no selection_reasons`);
    if (rec.selection_reasons.some((r) => r.startsWith('agent-pack:'))) packDerived += 1;
  }
  assert.ok(packDerived > 0, 'no pack-derived skill travelled — the reason check proved nothing');
});

test('--pack-skills none forges a core WITHOUT the packs\' declared skills', () => {
  // The escape hatch has to actually escape: a deliberately bare core is a legitimate artifact, and
  // without this the derivation would be unavoidable once a pack exists.
  const bare = join(base, 'core-no-pack-skills');
  const r = forge(bare, '--as-core', '--core-version', CORE_VERSION, '--pack-skills', 'none');
  assert.equal(r.status, 0, `forge failed:\n${r.stdout}\n${r.stderr}`);
  const manifest = readFileSync(join(bare, '.sidekicks', 'agent-packs', 'core', 'pack.yaml'), 'utf8');
  const declared = [...manifest.matchAll(/^ {2}- name: (\S+)$/gm)].map((m) => m[1]);
  for (const skill of declared) {
    assert.equal(existsSync(join(bare, '.agents', 'skills', skill)), false,
      `--pack-skills none still shipped '${skill}'`);
  }
});

test('the derived pack skills are NOT part of the required floor', () => {
  // The floor is substrate a runtime cannot go without; a crew's skills are not that. Forging an
  // ordinary runtime with the same preset is the check — it derives nothing, so anything the pack
  // contributed would have to have come from `required:`.
  const plain = join(base, 'runtime-floor-check');
  assert.equal(forge(plain).status, 0);                          // preset core, NO --as-core
  const manifest = readFileSync(join(core, '.sidekicks', 'agent-packs', 'core', 'pack.yaml'), 'utf8');
  const declared = [...manifest.matchAll(/^ {2}- name: (\S+)$/gm)].map((m) => m[1]);
  for (const skill of declared) {
    assert.equal(existsSync(join(plain, '.agents', 'skills', skill)), false,
      `'${skill}' reached an ordinary runtime — a pack skill leaked into the required floor`);
  }
});

test('an ordinary runtime does NOT get agent packs', () => {
  // Same reasoning as the marker and the installers: a runtime is used by whoever forged it and
  // already has the agents they want; a core is consumed by strangers who have none.
  const plain = join(base, 'runtime-no-packs');
  assert.equal(forge(plain).status, 0);                          // preset core, NO --as-core
  assert.equal(existsSync(join(plain, '.sidekicks', 'agent-packs')), false);
});

test('the generated core README tells the reader packs are not installed for them', () => {
  const readme = readFileSync(join(core, 'README.md'), 'utf8');
  assert.match(readme, /agent pack list/);
  assert.match(readme, /agent pack install/);
  assert.match(readme, /never installed for you|nothing installs one for you/i,
    'the README is the only doc a public user reads — optionality must be stated there');
});

test('inherit verify FAILS when a shipped agent pack is broken', () => {
  // Gate 8a. A pack that ships broken looks exactly like a pack that shipped.
  const broken = join(base, 'core-bad-pack');
  assert.equal(forge(broken, '--as-core', '--core-version', CORE_VERSION).status, 0);
  writeFileSync(
    join(broken, '.sidekicks', 'agent-packs', 'core', 'pack.yaml'),
    'schema: agent-pack/v1\nid: core\nversion: not-a-version\ndisplay_name: x\nagents:\n  - ethan\nrequires_skills: []\n'
  );
  const r = inherit('verify', '--name', 'as-core-test', '--target', broken);
  assert.notEqual(r.status, 0, 'a core shipping an invalid pack must not verify clean');
  assert.match(r.stdout, /agent pack 'core' is invalid in the forged core/);
});

test('inherit verify FAILS when the packs directory ships empty', () => {
  // An empty packs directory is what a copy that silently dropped its payload looks like.
  const emptied = join(base, 'core-empty-packs');
  assert.equal(forge(emptied, '--as-core', '--core-version', CORE_VERSION).status, 0);
  // Every pack, not a named one: the gate is about an EMPTY directory, and deleting only 'core'
  // would stop emptying it the moment a second pack shipped.
  const packsDir = join(emptied, '.sidekicks', 'agent-packs');
  for (const entry of readdirSync(packsDir)) {
    rmSync(join(packsDir, entry), { recursive: true, force: true });
  }
  const r = inherit('verify', '--name', 'as-core-test', '--target', emptied);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /is present but holds no pack/);
});

test('inherit verify FAILS when a core is missing part of its distribution', () => {
  const broken = join(base, 'core-broken');
  assert.equal(forge(broken, '--as-core', '--core-version', CORE_VERSION).status, 0);
  rmSync(join(broken, 'install.sh'), { force: true });

  const r = inherit('verify', '--name', 'as-core-test', '--target', broken);
  assert.notEqual(r.status, 0, 'an incomplete core must not verify clean');
  assert.match(r.stdout, /core distribution is incomplete — install\.sh is missing/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// The forged .gitignore must not ignore the skills it ships
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Agents and commands travel by ownership (INC-2026-09-04-02, N-4)
//
// Nothing asserted the CONTENTS of these surfaces, which is exactly why the published core shipped
// 37 `/bmad:*` commands loading a bmad/ tree it does not carry, 16 Codex agents and 4 Claude agent
// packs for skills it does not carry, and host command stubs the forge was unaware of. Each is
// a defect visible in every consumer's menu that no consumer can fix.

/** Every file under `rel` in the forged core, as slash-separated paths relative to it. */
function listUnder(rel) {
  const abs = join(core, ...rel.split('/'));
  if (!existsSync(abs)) return null;               // null = the surface did not travel at all
  const out = [];
  const walk = (dir, base) => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      const r = base ? `${base}/${e}` : e;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(abs, '');
  return out;
}

test('the core ships NO bmad command stubs — it carries no bmad skill to run them', () => {
  // The stubs load `{project-root}/bmad/core/tasks/*.xml`, so every one of them fails at step 1.
  assert.deepEqual(listUnder('.claude/commands') ?? [], [],
    'no BMAD command file may travel when the capability is absent');
});

test('the core ships every canonical agent and generated host port', () => {
  const sourceFiles = (rel) => {
    const result = [];
    const walk = (dir, prefix = '') => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name === '.DS_Store') continue;
        if (entry.isDirectory()) walk(join(dir, entry.name), path);
        else if (entry.isFile()) result.push(path);
      }
    };
    walk(join(repoRoot, ...rel.split('/')));
    return result.sort();
  };
  for (const rel of ['.agents/subagents', '.claude/agents', '.codex/agents', '.agents/plugins']) {
    const expected = sourceFiles(rel);
    assert.deepEqual((listUnder(rel) || []).sort(), expected,
      `${rel} must retain the complete source agent surface, including optional skill families`);
    for (const file of expected) {
      assert.equal(readFileSync(join(core, rel, file), 'utf8'),
        readFileSync(join(repoRoot, rel, file), 'utf8'), `${rel}/${file} must retain its content`);
    }
  }
  assert.ok(existsSync(join(core, 'scripts', 'generate-subagent-ports.mjs')),
    'the deterministic port generator must travel with its definitions');
});

test('inherit verify FAILS on an agent absent from the source projection', () => {
  const stray = join(core, '.codex', 'agents', 'bmm-smuggled-in.toml');
  writeFileSync(stray, 'name = "bmm-smuggled-in"\n', 'utf8');
  try {
    const r = inherit('verify', '--name', 'as-core-test', '--target', core);
    assert.notEqual(r.status, 0, 'the gate must bite');
    assert.match(r.stdout + r.stderr, /root.structure|unexpected/i);
    assert.match(r.stdout + r.stderr, /bmm-smuggled-in/);
  } finally {
    rmSync(stray, { force: true });
  }
  assert.equal(inherit('verify', '--name', 'as-core-test', '--target', core).status, 0,
    'and the core must be clean once it is removed');
});

test('a forged core does NOT git-ignore its own canonical skills tree', () => {
  // THE BUG THIS PINS. `assets/runtime.gitignore` listed `.agents/skills` alongside the three
  // per-CLI exposure links. That was right while the canonical tree lived at `.sidekicks/skills` and
  // `.agents/skills` was just another link; Rule 3 made `.agents/skills` the canonical tree, and the
  // line then ignored every skill the core ships.
  //
  // It failed silently and completely: `git add -A` in the core skipped the whole tree, so the
  // release committed and published ZERO skills. A consumer who mounted it got no required floor,
  // `core init` reported "core ships 0", and the only visible symptom was a downstream
  // `framework doctor` complaining that `criterion.command-sequences` — declared by sk-commander,
  // which had not travelled — belonged to no registry entry. Nothing pointed at the ignore file.
  //
  // lib/core-lifecycle/_seed.mjs carries the same warning for the workspace-side list and was fixed
  // when the tree moved; this file's twin was missed, which is why the check is asserted here rather
  // than trusted to a comment.
  const gitignore = readFileSync(join(core, '.gitignore'), 'utf8');
  const lines = gitignore.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  for (const pattern of lines) {
    assert.notEqual(
      pattern.replace(/^\/+/, '').replace(/\/+$/, ''), '.agents/skills',
      'the forged .gitignore ignores the canonical skills tree — the core would publish no skills',
    );
  }

  // Both real exposure links must still be ignored: a committed folder link checks out as a
  // text stub on Windows and breaks discovery, which is what the rule is for.
  for (const link of ['.claude/skills', '.agent/skills']) {
    assert.ok(lines.includes(link), `${link} must stay ignored — it is a link, not the tree`);
  }
});

test('git itself agrees: every skill the core ships is addable', () => {
  // The assertion above reads the file; this one asks git, which is the thing that actually decided
  // to skip the tree. A pattern this test did not think of would still be caught here.
  const skills = join(core, '.agents', 'skills');
  assert.ok(existsSync(skills), 'the forged core must carry .agents/skills');

  const probe = join('.agents', 'skills', 'sk-hello', 'SKILL.md');
  assert.ok(existsSync(join(core, probe)), 'the core preset ships sk-hello');

  const r = spawnSync('git', ['-C', core, 'check-ignore', '-v', probe], { encoding: 'utf8' });
  // check-ignore exits 1 when nothing matches, which is the outcome we want.
  assert.notEqual(r.status, 0, `git ignores a shipped skill: ${r.stdout.trim()}`);
});
