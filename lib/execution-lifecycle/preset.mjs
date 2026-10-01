// `sidekicks execution preset set <name> --file <json> --expected-revision <sha256:...>`.
// One writer spans the legacy split-preset store and canonical execution storage. The execution
// snapshot remains the sole registry/preset authority; this module creates no parallel store.

import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { parseFlags, effectiveExecutors, routingPolicy } from '../cli-executor-lifecycle/_shared.mjs';
import {
  mutateExecutionConfigFile,
  resolveExecutionConfig,
} from '../cli-executor-lifecycle/execution-config.mjs';
import {
  readPresets,
  resolvePresetPath,
  resolvePresetSnapshot,
  validatePreset,
  writePresets,
} from '../cli-executor-lifecycle/presets.mjs';
import { canonicalExecutionConfigPath } from './canonical-path.mjs';

function invalid(message) {
  throw new SidekicksError(`execution preset: ${message}`, EXIT_VALIDATION);
}

function repoRelative(repoRoot, path) {
  return relative(repoRoot, path).replace(/\\/g, '/') || '.';
}

function validateResolvablePreset(name, preset, snapshot) {
  const value = validatePreset(name, preset);
  resolvePresetSnapshot({
    name,
    preset: value,
    executors: effectiveExecutors(snapshot.sections.registry),
    hostCli: value.host_cli || '',
    prefer: routingPolicy(snapshot.sections.registry),
  });
  return value;
}

/** Write exactly one preset with a full-snapshot optimistic revision. */
export function setExecutionPreset({
  repoRoot, settings = {}, name, preset, expectedRevision,
}) {
  if (typeof expectedRevision !== 'string' || !expectedRevision.startsWith('sha256:')) {
    invalid('--expected-revision is required and must be an execution snapshot revision');
  }
  const current = resolveExecutionConfig(repoRoot, settings);
  if (current.revision !== expectedRevision) invalid('stale execution configuration; reload before writing');
  const declaration = validateResolvablePreset(name, preset, current);
  const canonicalPath = canonicalExecutionConfigPath(repoRoot, settings);
  if (existsSync(canonicalPath)) {
    const next = mutateExecutionConfigFile(canonicalPath, 'presets', expectedRevision, (section, provenance) => ({
      value: {
        ...section,
        schema_version: section.schema_version ?? 2,
        presets: { ...(section.presets || {}), [name]: declaration },
      },
      provenance: {
        ...provenance,
        presets: { ...(provenance?.presets || {}), [name]: { source: 'canonical' } },
      },
    }));
    return Object.freeze({
      ok: true, storage_mode: 'canonical-execution', path: repoRelative(repoRoot, canonicalPath),
      preset: name, previous_revision: expectedRevision, revision: next.revision,
    });
  }

  const { path } = resolvePresetPath(repoRoot, settings, { root: true });
  const document = readPresets(path, { layer: 'root' });
  const nextDocument = {
    ...document,
    presets: { ...(document.presets || {}), [name]: declaration },
    compact_presets: Object.fromEntries(Object.entries(document.compact_presets || {})
      .filter(([presetName]) => presetName !== name)),
  };
  Object.defineProperty(nextDocument, 'passthrough', { value: document.passthrough || {}, enumerable: false });
  writePresets(path, nextDocument, repoRoot, { expectedRevision: document.revision });
  const nextSnapshot = resolveExecutionConfig(repoRoot, settings);
  return Object.freeze({
    ok: true, storage_mode: 'legacy-split-preset', path: repoRelative(repoRoot, path),
    preset: name, previous_revision: expectedRevision, revision: nextSnapshot.revision,
  });
}

function flagsFor(argv) {
  const flags = parseFlags(argv, ['json']);
  const allowed = new Set(['file', 'expected-revision', 'json']);
  const unknown = Object.keys(flags).find((key) => !allowed.has(key));
  if (unknown) throw new SidekicksError(`execution preset: unknown flag --${unknown}`, EXIT_USAGE);
  return flags;
}

/** @param {{repoRoot:string, argv:string[]}} ctx */
export async function run(ctx, args) {
  const action = args.name;
  const name = args.rest?.[0];
  const flags = flagsFor(ctx.argv);
  if (action !== 'set' || !name || !flags.file || !flags['expected-revision']) {
    throw new SidekicksError(
      'execution preset: usage: preset set <name> --file <json> --expected-revision <revision> [--json]',
      EXIT_USAGE,
    );
  }
  let preset;
  try {
    preset = JSON.parse(readFileSync(flags.file, 'utf8'));
  } catch (error) {
    throw new SidekicksError(`execution preset: cannot read --file: ${error.message}`, EXIT_USAGE);
  }
  const result = setExecutionPreset({
    repoRoot: ctx.repoRoot,
    settings: readSettings(ctx.repoRoot),
    name,
    preset,
    expectedRevision: flags['expected-revision'],
  });
  if (flags.json) return { stdout: `${JSON.stringify(result, null, 2)}\n` };
  return { stdout: `execution preset: set ${name} in ${result.storage_mode} (${result.path})\nrevision: ${result.revision}\n` };
}
