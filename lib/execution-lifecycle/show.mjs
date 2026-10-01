// `sidekicks execution show [--json]` — one effective, safe-to-display view.

import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { parseFlags } from '../cli-executor-lifecycle/_shared.mjs';
import { resolveExecutionSnapshot } from './snapshot.mjs';
import { maskCredentials } from '../cli-executor-lifecycle/execution-config.mjs';

function flagsFor(argv) {
  const flags = parseFlags(argv, ['json']);
  const unknown = Object.keys(flags).find((key) => key !== 'json');
  if (unknown) throw new SidekicksError(`execution show: unknown flag '--${unknown}'`, EXIT_USAGE);
  return flags;
}

/** @param {{repoRoot: string, argv: string[]}} ctx */
export async function run(ctx, _args) {
  const flags = flagsFor(ctx.argv);
  const snapshot = resolveExecutionSnapshot(ctx.repoRoot, readSettings(ctx.repoRoot));
  if (flags.json) return { stdout: JSON.stringify(maskCredentials(snapshot), null, 2) + '\n' };

  const lines = [
    'execution configuration (effective, credentials masked)',
    `  schema:    ${snapshot.schema_version}`,
    `  revision:  ${snapshot.revision}`,
    `  delivery:  ${snapshot.sections.delivery.mode} [${snapshot.provenance.delivery.mode}]`,
    `  registry:  ${snapshot.provenance.registry.root}`,
    `  presets:   ${snapshot.provenance.presets.root}`,
    '',
    'Run `sidekicks execution show --json` for the complete effective configuration and provenance.',
  ];
  return { stdout: lines.join('\n') + '\n' };
}
