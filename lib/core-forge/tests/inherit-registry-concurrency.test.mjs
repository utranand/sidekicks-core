// tests/skills/inherit-registry-concurrency.test.mjs
// DATA-02: the inherit runtime registry under concurrent mutation.
//
// One file, artifacts/runs/inherit/runtimes.json, is shared by every inherited runtime on the
// machine. Registration and forget were an unlocked read-modify-write ending in a bare
// writeFileSync, and a parse failure silently returned {} — so two concurrent runs dropped each
// other's entries, a reader could catch a half-written file, and one damaged registry became an
// EMPTY registry the moment anything wrote next, with the original bytes unrecoverable.
//
// Driven through `forget`, which reaches the same mutateRegistry funnel as `create` without
// paying for a full runtime forge.
//
// Imports only node:* built-ins. The barrier is an absolute epoch, so it behaves the same on
// macOS and Windows — no shell, no sleep binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const engine = join(repoRoot, 'lib', 'core-forge', 'tests', '_projection-cli.mjs');

/** A temp registry pre-seeded with `count` runtimes, plus the env that points the engine at it. */
function seedRegistry(prefix, count) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.sidekicks'), { recursive: true });
  const file = join(dir, 'runtimes.json');
  const runtimes = {};
  for (let i = 0; i < count; i += 1) {
    runtimes[`r${i}`] = { path_rel: `runtimes/r${i}`, outside_repo: false, registered_at: '2026-08-16T00:00:00+07:00' };
  }
  writeFileSync(file, JSON.stringify({ schema: 'inherit-runtimes/v1', runtimes }, null, 2) + '\n', 'utf8');
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const readRuntimes = (file) => JSON.parse(readFileSync(file, 'utf8')).runtimes;

function runEngine(args, registryFile, extraEnv = {}) {
  const r = spawnSync(process.execPath, [engine, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, SIDEKICKS_INHERIT_REGISTRY: registryFile, ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// R1 — concurrent mutation must not lose unrelated entries
// ═══════════════════════════════════════════════════════════════════════════════

const FORGETTER = `
const [engine, registry, name, startAtRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);
const { spawnSync } = await import('node:child_process');
while (Date.now() < startAt) { /* barrier spin — no sleep binary, portable */ }
const r = spawnSync(process.execPath, [engine, 'forget', '--name', name], {
  encoding: 'utf8', shell: false,
  env: { ...process.env, SIDEKICKS_INHERIT_REGISTRY: registry },
});
process.exit(r.status ?? 1);
`;

test('concurrent forgets remove exactly their own entries and lose none of the others',
  { timeout: 120_000 }, () => {
    const seeded = seedRegistry('sk-publish-core-conc-', 20);
    const runner = join(seeded.dir, 'forgetter.mjs');
    writeFileSync(runner, FORGETTER, 'utf8');
    try {
      for (let round = 0; round < 3; round += 1) {
        // Re-seed each round so the assertion is about THIS round's interleaving.
        const fresh = {};
        for (let i = 0; i < 20; i += 1) {
          fresh[`r${i}`] = { path_rel: `runtimes/r${i}`, outside_repo: false, registered_at: 'x' };
        }
        writeFileSync(seeded.file,
          JSON.stringify({ schema: 'inherit-runtimes/v1', runtimes: fresh }, null, 2) + '\n', 'utf8');

        const forgotten = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
        const startAt = Date.now() + 900;
        const kids = forgotten.map((name) => spawnSync(process.execPath,
          [runner, engine, seeded.file, name, String(startAt)],
          { encoding: 'utf8', shell: false, timeout: 60_000 }));
        for (const k of kids) assert.equal(k.status, 0, k.stderr);

        // The file must still be valid JSON — a torn write is the other half of this defect.
        const after = readRuntimes(seeded.file);
        for (const gone of forgotten) {
          assert.ok(!(gone in after), `${gone} was forgotten and must be absent`);
        }
        for (let i = 8; i < 20; i += 1) {
          assert.ok(`r${i}` in after,
            `r${i} was never forgotten — a concurrent writer must not drop an unrelated entry`);
        }
        assert.equal(Object.keys(after).length, 12);
      }
    } finally {
      seeded.cleanup();
    }
  });

// ═══════════════════════════════════════════════════════════════════════════════
// R2 — a corrupt registry is preserved, never silently replaced
// ═══════════════════════════════════════════════════════════════════════════════

test('a registry that cannot be parsed is quarantined with its bytes intact', () => {
  const seeded = seedRegistry('sk-publish-core-corrupt-', 3);
  try {
    const damaged = '{ "schema": "inherit-runtimes/v1", "runtimes": { "keep-me": { "path_r';
    writeFileSync(seeded.file, damaged, 'utf8');

    // A READ-ONLY verb warns but must not touch the file — two readers must not race to move it.
    const listed = runEngine(['list'], seeded.file);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stderr, /NOTICE: inherit registry/);
    assert.equal(readFileSync(seeded.file, 'utf8'), damaged, 'a read must not modify the registry');

    // A MUTATION moves it aside — under the lock — and starts fresh.
    const forgot = runEngine(['forget', '--name', 'anything'], seeded.file);
    assert.match(forgot.stderr, /preserved as 'runtimes\.corrupt-/);
    const kept = readdirSync(dirname(seeded.file)).filter((f) => /^runtimes\.corrupt-.*\.json$/.test(f));
    assert.equal(kept.length, 1, 'exactly one quarantined copy');
    assert.equal(readFileSync(join(dirname(seeded.file), kept[0]), 'utf8'), damaged,
      'the damaged bytes must survive verbatim — they are the only record of what was lost');
  } finally {
    seeded.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// R3 — writes are atomic, so a concurrent reader never sees a partial file
// ═══════════════════════════════════════════════════════════════════════════════

test('a reader running against a mutating registry never sees a partial write',
  { timeout: 120_000 }, () => {
    const seeded = seedRegistry('sk-publish-core-atomic-', 30);
    try {
      // Interleave: forget one, read, forget the next, read… If the write were not atomic, a
      // read landing mid-write would report a parse failure through the NOTICE channel.
      for (let i = 0; i < 12; i += 1) {
        const w = runEngine(['forget', '--name', `r${i}`], seeded.file);
        assert.equal(w.status, 0, w.stderr);
        const r = runEngine(['list'], seeded.file);
        assert.equal(r.status, 0, r.stderr);
        assert.doesNotMatch(r.stderr, /could not parse/,
          'a reader must never observe a half-written registry');
      }
      const leftovers = readdirSync(dirname(seeded.file)).filter((f) => f.startsWith('.runtimes-tmp-'));
      assert.deepEqual(leftovers, [], 'no temp file may be left behind');
      assert.equal(Object.keys(readRuntimes(seeded.file)).length, 18);
    } finally {
      seeded.cleanup();
    }
  });

// ═══════════════════════════════════════════════════════════════════════════════
// R4 — the override is honored, and the real registry stays untouched
// ═══════════════════════════════════════════════════════════════════════════════

test('SIDEKICKS_INHERIT_REGISTRY redirects the registry and leaves the real one alone', () => {
  const seeded = seedRegistry('sk-publish-core-override-', 2);
  const real = join(repoRoot, 'artifacts', 'runs', 'inherit', 'runtimes.json');
  const realBefore = existsSync(real) ? statSync(real).mtimeMs : null;
  try {
    const r = runEngine(['forget', '--name', 'r0'], seeded.file);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!('r0' in readRuntimes(seeded.file)), 'the temp registry is the one that changed');

    const realAfter = existsSync(real) ? statSync(real).mtimeMs : null;
    assert.equal(realAfter, realBefore,
      'the developer\'s real registry must not be created or modified by a test run');
  } finally {
    seeded.cleanup();
  }
});

