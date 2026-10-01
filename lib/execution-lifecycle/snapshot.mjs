// The execution namespace's compatibility boundary.
//
// The three configuration stores predate the execution namespace and remain their
// respective owners.  Consumers use this module when they need one resolved view;
// legacy cli-executor commands keep reading and writing their own stores unchanged.

import { effectiveExecutors, parseFlags, routingPolicy } from '../cli-executor-lifecycle/_shared.mjs';
import {
  resolveExecutionConfig,
  validateExecutionConfigSnapshot,
} from '../cli-executor-lifecycle/execution-config.mjs';
import { EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { maskCredentials } from '../cli-executor-lifecycle/execution-config.mjs';

/** Resolve a current, redacted execution configuration snapshot. */
export function resolveExecutionSnapshot(repoRoot, settings = {}, options = {}) {
  return resolveExecutionConfig(repoRoot, settings, options);
}

/**
 * Convert a validated snapshot into the shapes legacy Node consumers already
 * understand.  This deliberately does not re-resolve config: callers that pass
 * a stored snapshot get exactly that snapshot, while live callers opt in by
 * calling `resolveExecutionSnapshot` first.
 */
export function executionConsumers(snapshot) {
  const current = validateExecutionConfigSnapshot(snapshot, { allowSecrets: true });
  const registry = current.sections.registry;
  const presets = current.sections.presets;
  return Object.freeze({
    snapshot: current,
    deliveryPolicy: current.sections.delivery,
    registry,
    presets,
    executors: effectiveExecutors(registry),
    prefer: routingPolicy(registry),
  });
}

/** @param {{repoRoot: string, argv: string[]}} ctx */
export async function run(ctx, _args) {
  const flags = parseFlags(ctx.argv, ['json']);
  const unknown = Object.keys(flags).find((key) => key !== 'json');
  if (unknown) throw new SidekicksError(`execution snapshot: unknown flag '--${unknown}'`, EXIT_USAGE);
  const snapshot = resolveExecutionSnapshot(ctx.repoRoot, readSettings(ctx.repoRoot));
  return { stdout: JSON.stringify(maskCredentials(snapshot), null, 2) + '\n' };
}
