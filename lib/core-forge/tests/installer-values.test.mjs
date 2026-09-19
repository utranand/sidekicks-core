import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { renderInstallerTemplate, renderTemplate } from '../instructions.mjs';

const plain = {
  GENERATED_AT: '2026-09-19', SOURCE_COMMIT: 'abcdef0123', CORE_DIR: '.sidekicks-core',
  FRAMEWORK_REMOTE: 'https://github.com/example/core.git', DEFAULT_REF: 'main',
  DEFAULT_DIR: 'sidekicks', RAW_INSTALL_URL: 'https://example.test/install.sh',
  RAW_INSTALL_PS1_URL: 'https://example.test/install.ps1', CORE_VERSION: '1.0.0',
};

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'core-installer-values-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('plain installer values retain the original template bytes', () => {
  for (const file of ['install.sh.tmpl', 'install.ps1.tmpl']) {
    assert.equal(renderInstallerTemplate(file, plain), renderTemplate(file, plain));
  }
});

test('POSIX installer treats substitution syntax as inert data', t => {
  if (spawnSync('sh', ['-c', 'exit 0']).status !== 0) return t.skip('POSIX sh unavailable');
  const dir = temporary(t);
  const value = 'remote$(touch dollar-sentinel)`touch backtick-sentinel`"quote\\path\'apostrophe';
  const text = renderInstallerTemplate('install.sh.tmpl', {
    ...plain, FRAMEWORK_REMOTE: value, DEFAULT_REF: value,
  });
  const script = join(dir, 'install.sh');
  writeFileSync(script, text);
  const syntax = spawnSync('sh', ['-n', script], { cwd: dir, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const run = spawnSync('sh', [script, '--help'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(dir, 'dollar-sentinel')), false);
  assert.equal(existsSync(join(dir, 'backtick-sentinel')), false);
});

test('PowerShell installer doubles apostrophes and leaves substitutions literal', t => {
  const value = "remote'; New-Item ps-sentinel; # $(New-Item dollar-sentinel)";
  const text = renderInstallerTemplate('install.ps1.tmpl', {
    ...plain, FRAMEWORK_REMOTE: value, DEFAULT_REF: value,
  });
  const quoted = value.replaceAll("'", "''");
  assert.ok(text.includes("[string]$Remote = '" + quoted + "',"));
  assert.ok(text.includes("[string]$Ref    = '" + quoted + "',"));
  // Always check quoting; additionally exercise the real parser where available.
  if (spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0) {
    t.diagnostic('pwsh unavailable: executable PowerShell check skipped');
    return;
  }
  const dir = temporary(t), script = join(dir, 'install.ps1');
  writeFileSync(script, text);
  const run = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Help'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(dir, 'ps-sentinel')), false);
  assert.equal(existsSync(join(dir, 'dollar-sentinel')), false);
});

test('installer placeholders reject newline, carriage return and NUL in any field', () => {
  for (const file of ['install.sh.tmpl', 'install.ps1.tmpl']) {
    for (const control of ['\n', '\r', '\0']) {
      for (const key of ['FRAMEWORK_REMOTE', 'DEFAULT_REF', 'GENERATED_AT']) {
        assert.throws(() => renderInstallerTemplate(file, { ...plain, [key]: 'safe' + control + 'unsafe' }),
          error => error.exitCode === 2 && /single line/.test(error.message));
      }
    }
  }
});
