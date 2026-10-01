import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'node:test';

export const MATRIX_PATH = 'tests/fixtures/multi-cli-autonomy-phase08/fault-matrix.json';
// This ceiling covers a complete test file (including all lifecycle/repair cases), not one
// attempt. Keep production budgets untouched and retain an explicit bounded CI execution.
export const FAULT_TEST_LIMITS = Object.freeze({ concurrency: 1, per_file_timeout_ms: 900_000 });
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (code) => { throw new Error(code); };

function safeFile(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\')
      || /[:\x00-\x1f]/u.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('fixture-path-invalid');
  }
  const base = realpathSync(root);
  const path = join(base, ...name.split('/'));
  const rel = relative(base, realpathSync(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !lstatSync(path).isFile()) {
    fail('fixture-path-outside-root');
  }
  return path;
}

// The fixture digest covers both the mapping and all its declared fixture/test inputs.
// The commit separately pins every runtime dependency. Hash raw bytes, never OS-normalized text.
export function fixtureDigest(root, inputs) {
  if (!Array.isArray(inputs) || !inputs.length || new Set(inputs).size !== inputs.length) fail('fixture-inputs-invalid');
  return sha([...inputs].sort().map((name) => `${name}\0${sha(readFileSync(safeFile(root, name)))}\n`).join(''));
}

export function attestCandidate({ root, candidateSha, expectedFixtureDigest, inputs }) {
  if (!/^[a-f0-9]{40}$/u.test(candidateSha ?? '')) fail('candidate-sha-invalid');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', 'HEAD') !== candidateSha) fail('candidate-sha-mismatch');
  const digest = fixtureDigest(root, inputs);
  if (digest !== expectedFixtureDigest) fail('fixture-digest-mismatch');
  if (git('status', '--porcelain', '--untracked-files=all')) fail('candidate-dirty');
  return { candidate_sha: candidateSha, fixture_digest: digest };
}

export function gradeRows(rows, results) {
  return rows.map((row) => {
    const evidence = row.evidence.map((ref) => {
      const matches = results.filter((result) => result.file === ref.file && result.name === ref.name);
      return { ...ref, outcome: matches.length === 1 ? matches[0].outcome : 'unproven' };
    });
    const outcome = evidence.some((item) => item.outcome === 'failed') ? 'failed'
      : evidence.some((item) => item.outcome === 'skipped') ? 'skipped'
        : row.limitation || !evidence.length || evidence.some((item) => item.outcome !== 'passed') ? 'unproven' : 'passed';
    return { id: row.id, scenario: row.scenario, expected: row.expected, outcome, evidence,
      ...(row.limitation ? { limitation: row.limitation } : {}) };
  });
}

export function gradeSupplementalFiles(files, results) {
  return files.map((file) => {
    const tests = results.filter((result) => result.file === file);
    const test_counts = Object.fromEntries(['passed', 'failed', 'skipped'].map((key) => [key, tests.filter((test) => test.outcome === key).length]));
    return { file, outcome: test_counts.failed ? 'failed' : test_counts.skipped ? 'skipped'
      : !tests.length || tests.some((test) => test.outcome !== 'passed') ? 'unproven' : 'passed', test_counts };
  });
}

export function loadMatrix(root) {
  const matrix = JSON.parse(readFileSync(safeFile(root, MATRIX_PATH), 'utf8'));
  if (matrix.schema_version !== 1 || matrix.rows.length !== 32
      || matrix.rows.some((row, i) => row.id !== `F${String(i + 1).padStart(2, '0')}`
        || !Array.isArray(row.evidence) || row.evidence.length === 0)) fail('fault-matrix-invalid');
  if (!Array.isArray(matrix.supplemental_test_files)
      || new Set(matrix.supplemental_test_files).size !== matrix.supplemental_test_files.length) fail('fault-matrix-supplemental-invalid');
  const files = [...new Set([...matrix.rows.flatMap((row) => row.evidence.map((ref) => ref.file)),
    ...matrix.supplemental_test_files])].sort();
  const inputs = [...new Set([MATRIX_PATH, ...matrix.fixture_inputs, ...files])].sort();
  inputs.forEach((name) => safeFile(root, name));
  return { matrix, files, inputs };
}

export async function collectTestResults(root, matrix, files) {
  const results = [];
  // All selected files run, including their setup and non-matrix regressions. Never parse TAP
  // prose or accept a suite pass as a substitute for the exact named leaf test.
  const stream = run({ files: files.map((name) => safeFile(root, name)), concurrency: FAULT_TEST_LIMITS.concurrency,
    execArgv: [], timeout: FAULT_TEST_LIMITS.per_file_timeout_ms });
  for await (const event of stream) {
    if (!['test:pass', 'test:fail'].includes(event.type) || event.data.details?.type === 'suite') continue;
    const data = event.data;
    const observedFile = data.file ? relative(realpathSync(root), data.file).split(sep).join('/') : '';
    const file = files.includes(observedFile) ? observedFile : 'unresolved-test-file';
    const knownName = matrix.rows.some((row) => row.evidence.some((ref) => ref.file === file && ref.name === data.name));
    results.push({ file, name: knownName ? data.name : `test-${sha(String(data.name)).slice(7)}`,
      ...(Number.isInteger(data.line) && data.line > 0 ? { line: data.line } : {}),
      ...(event.type === 'test:fail' ? { failure_class: ['testTimeoutFailure', 'testCodeFailure',
        'subtestsFailed', 'cancelledByParent', 'testAborted'].includes(data.details?.error?.failureType)
        ? data.details.error.failureType : 'testFailure' } : {}),
      outcome: data.skip || data.todo ? 'skipped' : event.type === 'test:fail' ? 'failed' : 'passed' });
  }
  return results;
}

export async function verifyFaultMatrix({ root = ROOT, candidateSha, expectedFixtureDigest }) {
  const { matrix, files, inputs } = loadMatrix(root);
  const attestation = attestCandidate({ root, candidateSha, expectedFixtureDigest, inputs });
  const results = await collectTestResults(root, matrix, files);
  attestCandidate({ root, candidateSha, expectedFixtureDigest, inputs });
  const rows = gradeRows(matrix.rows, results);
  const supplemental = gradeSupplementalFiles(matrix.supplemental_test_files, results);
  const counts = Object.fromEntries(['passed', 'failed', 'skipped', 'unproven'].map((key) => [key, rows.filter((row) => row.outcome === key).length]));
  return { schema_version: 1, kind: 'autonomy-fault-matrix', ...attestation,
    execution_limits: FAULT_TEST_LIMITS,
    platform: process.platform, node_version: process.version,
    outcome: counts.failed || results.some((item) => item.outcome === 'failed') ? 'failed'
      : counts.skipped || counts.unproven || supplemental.some((file) => file.outcome !== 'passed') ? 'parked' : 'passed',
    counts, test_counts: Object.fromEntries(['passed', 'failed', 'skipped'].map((key) => [key, results.filter((item) => item.outcome === key).length])),
    rows, supplemental, tests: results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, candidateSha, expectedFixtureDigest] = process.argv.slice(2);
    if (command === 'digest' && !candidateSha) {
      process.stdout.write(`${fixtureDigest(ROOT, loadMatrix(ROOT).inputs)}\n`);
    } else if (command === 'run' && process.argv.length === 5) {
      const result = await verifyFaultMatrix({ candidateSha, expectedFixtureDigest });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.outcome === 'passed' ? 0 : result.outcome === 'parked' ? 2 : 1;
    } else fail('usage: fault-matrix.mjs digest | run <candidate-sha> <fixture-digest>');
  } catch (error) {
    // Never serialize raw test stderr, provider data, filesystem paths, or Git diagnostics.
    const code = /^(candidate|fixture|fault-matrix|usage:)[a-z0-9 :<>|.-]*$/u.test(error.message) ? error.message : 'fault-matrix-execution-error';
    process.stdout.write(`${JSON.stringify({ schema_version: 1, outcome: 'failed', diagnostic: code })}\n`);
    process.exitCode = 1;
  }
}
