#!/usr/bin/env node
// scripts/update-golden-contracts.mjs
// The ONE way a golden fixture is refreshed — a deliberate local review step, never automation.
//
//   node scripts/update-golden-contracts.mjs            # regenerate into a temp folder, print the diff, write NOTHING
//   node scripts/update-golden-contracts.mjs --apply     # replace the fixtures, after showing what changed
//   node scripts/update-golden-contracts.mjs --case help-top [--apply]
//   npm run snapshots:update -- --apply                  # the same thing through package.json
//
// WHY REFRESHING IS ITS OWN PROGRAM. A gate that can rewrite the expectation it checks proves only
// that the code agrees with itself: any behaviour change, intended or catastrophic, ends the run
// green with a quietly edited fixture. So the replay path (tests/golden-contracts.test.mjs and the
// golden.replay gate) has no write capability at all, and the write path lives here, behind a human.
//
// THREE REFUSALS, ON PURPOSE.
//   * CI set             -> refuse outright. In CI there is nobody to review the diff, and a green
//                           pipeline that silently rewrote its own snapshots is worse than a red one.
//   * no --apply         -> regenerate into a temporary review folder, print what WOULD change, exit 0
//                           without touching tests/fixtures/golden/. This is the default because the
//                           common case is "show me what drifted", not "make it stop complaining".
//   * a case that throws -> refuse to write ANY fixture. A partially refreshed set is a set nobody can
//                           reason about; the run is all-or-nothing.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASES, GOLDEN_DIR, readFixture } from './lib/golden-cases.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const EXIT_OK = 0;
const EXIT_REFUSED = 2;
const EXIT_FAILED = 3;

function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const only = valueOf(argv, '--case');

  if (argv.some((a) => a.startsWith('--') && !['--apply', '--case', '--help'].includes(a.split('=')[0]))) {
    fail(`unknown flag. usage:\n${usage()}`, EXIT_REFUSED);
  }
  if (argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }

  // REFUSAL 1 — CI. Checked before anything is generated, so the refusal is unconditional and cheap.
  if (process.env.CI) {
    fail(
      'refusing to run with CI set.\n'
      + 'A golden fixture is refreshed by a human who reads the diff. In CI there is nobody to read\n'
      + 'it, and a pipeline that rewrites its own expectations reports success no matter what changed.\n'
      + 'If a fixture is genuinely stale, refresh it locally and commit the result.',
      EXIT_REFUSED,
    );
  }
  // The replay-only marker the golden.replay gate sets. Belt and braces: the gate spawns the SUITE,
  // never this program, but if that ever changes the refusal should already be here.
  if (process.env.SIDEKICKS_GOLDEN_REPLAY_ONLY) {
    fail('refusing to run: SIDEKICKS_GOLDEN_REPLAY_ONLY is set, which means a replay-only context.',
      EXIT_REFUSED);
  }

  const cases = only ? CASES.filter((c) => c.name === only) : [...CASES];
  if (only && cases.length === 0) {
    fail(`no such case '${only}'. known cases:\n  ${CASES.map((c) => c.name).join('\n  ')}`, EXIT_REFUSED);
  }

  // Generate EVERYTHING into a temp review folder first. Nothing under tests/fixtures/golden/ is
  // touched until every case has succeeded.
  const review = mkdtempSync(join(tmpdir(), 'sk-golden-review-'));
  const results = [];
  try {
    for (const c of cases) {
      process.stderr.write(`generating ${c.name} …\n`);
      let body;
      try {
        body = c.produce({ repoRoot });
      } catch (e) {
        // REFUSAL 3 — a case that cannot be produced aborts the whole run.
        fail(
          `case '${c.name}' failed to produce its fixture: ${e.message}\n`
          + 'NOTHING was written. A partially refreshed fixture set cannot be reviewed as a whole,\n'
          + 'so this is all-or-nothing by design. Fix the cause and re-run.',
          EXIT_FAILED,
        );
      }
      writeFileSync(join(review, c.file), body, 'utf8');
      const before = readFixture(repoRoot, c.file);
      results.push({
        c,
        body,
        state: before === null ? 'new' : (before === body ? 'unchanged' : 'changed'),
        before,
      });
    }

    const changed = results.filter((r) => r.state !== 'unchanged');
    report(results, review, apply);

    if (changed.length === 0) {
      process.stdout.write('\nEvery fixture is already current — nothing to apply.\n');
      return EXIT_OK;
    }

    // REFUSAL 2 — no --apply. Show, do not write.
    if (!apply) {
      process.stdout.write(
        `\n${changed.length} fixture(s) WOULD change. Nothing was written.\n`
        + `Candidates are in ${review}\n`
        + 'Review the diff above, then re-run with --apply to replace the fixtures:\n'
        + '  npm run snapshots:update -- --apply\n',
      );
      return EXIT_OK;
    }

    const dir = join(repoRoot, GOLDEN_DIR);
    mkdirSync(dir, { recursive: true });
    for (const r of changed) writeFileSync(join(dir, r.c.file), r.body, 'utf8');
    process.stdout.write(
      `\nApplied ${changed.length} fixture(s) to ${GOLDEN_DIR}/:\n`
      + changed.map((r) => `  ${r.state === 'new' ? 'created' : 'updated'} ${r.c.file}`).join('\n')
      + '\nCommit them together with the change that caused them, so a reviewer sees both halves.\n',
    );
    return EXIT_OK;
  } finally {
    if (!apply) {
      // Keep the review folder when nothing was applied — the message above points at it.
    } else {
      try { rmSync(review, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Print one section per case: its state, why it is frozen, and a line-level diff when it changed.
 *
 * @param {Array<{c: {name: string, file: string, why: string}, body: string, state: string, before: string|null}>} results
 * @param {string} review
 * @param {boolean} apply
 */
function report(results, review, apply) {
  process.stdout.write(`\ngolden contracts — ${apply ? 'APPLY' : 'review only (nothing written)'}\n`);
  process.stdout.write(`candidates: ${review}\n\n`);
  for (const r of results) {
    process.stdout.write(`${pad(r.state)} ${r.c.file}\n`);
    if (r.state === 'unchanged') continue;
    process.stdout.write(`  why frozen: ${r.c.why}\n`);
    if (r.state === 'new') {
      process.stdout.write(`  (new fixture, ${r.body.split('\n').length} lines)\n`);
      continue;
    }
    const e = (r.before ?? '').split('\n');
    const a = r.body.split('\n');
    let shown = 0;
    for (let i = 0; i < Math.max(e.length, a.length) && shown < 24; i += 1) {
      if (e[i] === a[i]) continue;
      if (e[i] !== undefined) { process.stdout.write(`  -${e[i]}\n`); shown += 1; }
      if (a[i] !== undefined) { process.stdout.write(`  +${a[i]}\n`); shown += 1; }
    }
    if (shown >= 24) process.stdout.write('  … diff truncated at 24 lines\n');
  }
}

const pad = (s) => `[${s}]`.padEnd(11);

function valueOf(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === flag) {
      const next = argv[i + 1];
      return next && !next.startsWith('--') ? next : null;
    }
    if (tok.startsWith(`${flag}=`)) return tok.slice(flag.length + 1);
  }
  return null;
}

function usage() {
  return [
    'usage: node scripts/update-golden-contracts.mjs [--case <name>] [--apply]',
    '',
    '  (no flag)   regenerate into a temp folder, print what would change, write nothing',
    '  --apply     replace the fixtures under tests/fixtures/golden/',
    '  --case <n>  only this case',
    '',
    `cases: ${CASES.map((c) => c.name).join(', ')}`,
    '',
    'Refuses to run when CI is set: a fixture refresh is a human review step.',
  ].join('\n');
}

function fail(message, code) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(code);
}

process.exit(main());
