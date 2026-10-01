// `sidekicks execution doctor [--json]` — read-only compatibility health check.

import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { parseFlags } from '../cli-executor-lifecycle/_shared.mjs';
import { executionConsumers, resolveExecutionSnapshot } from './snapshot.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { canonicalExecutionConfigPath, canonicalExecutionConfigRel, readCanonicalExecutionConfig, resolveLegacyExecutionConfig } from '../cli-executor-lifecycle/execution-config.mjs';

function flagsFor(argv) {
  const flags = parseFlags(argv, ['json']);
  const unknown = Object.keys(flags).find((key) => key !== 'json');
  if (unknown) throw new SidekicksError(`execution doctor: unknown flag '--${unknown}'`, EXIT_USAGE);
  return flags;
}

/** @param {{repoRoot: string, argv: string[]}} ctx */
export async function run(ctx, _args) {
  const flags = flagsFor(ctx.argv);
  const snapshot = resolveExecutionSnapshot(ctx.repoRoot, readSettings(ctx.repoRoot));
  const view = executionConsumers(snapshot);
  const findings = [];
  const canonicalPath = canonicalExecutionConfigPath(ctx.repoRoot, readSettings(ctx.repoRoot));
  if (existsSync(canonicalPath)) {
    const canonical = readCanonicalExecutionConfig(canonicalPath);
    const legacy = resolveLegacyExecutionConfig(ctx.repoRoot, readSettings(ctx.repoRoot));
    const expected = JSON.parse(readFileSync(canonicalPath, 'utf8')).migration?.legacy_revision;
    if (expected && legacy.revision !== expected) findings.push({ severity: 'notice', check: 'legacy-divergence',
      detail: `canonical ${canonicalExecutionConfigRel(ctx.repoRoot, readSettings(ctx.repoRoot))} wins; legacy execution configuration changed after migration` });
    if (canonical.revision !== snapshot.revision) findings.push({ severity: 'error', check: 'canonical-read', detail: 'canonical execution snapshot changed during doctor read' });
  }
  const presets = Object.keys(view.presets.presets || {});
  const defaultPreset = view.presets.default_preset;
  if (defaultPreset && !view.presets.presets?.[defaultPreset]) {
    findings.push({ severity: 'error', check: 'default-preset',
      detail: `default_preset '${defaultPreset}' is not declared in the effective preset set` });
  }
  if (view.deliveryPolicy.mode === 'multi_cli' && !defaultPreset) {
    findings.push({ severity: 'notice', check: 'multi-cli-default-preset',
      detail: 'multi_cli is enabled without a root default_preset; automated runs require an explicit preset' });
  }
  if (view.deliveryPolicy.mode === 'multi_cli' && defaultPreset && presets.length === 0) {
    findings.push({ severity: 'error', check: 'multi-cli-preset',
      detail: 'multi_cli is enabled but no effective orchestration presets are declared' });
  }
  const errors = findings.filter((finding) => finding.severity === 'error');
  const payload = { ok: errors.length === 0, revision: snapshot.revision, findings };
  if (flags.json) return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: errors.length ? EXIT_VALIDATION : EXIT_OK };
  if (errors.length) throw new SidekicksError(`execution doctor: ${errors.map((f) => f.detail).join('; ')}`, EXIT_VALIDATION);
  const lines = ['execution doctor: OK', `  revision:  ${snapshot.revision}`, `  findings:  0 errors, ${findings.length} notices`];
  for (const finding of findings) lines.push(`  ${finding.severity}: ${finding.detail}`);
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
