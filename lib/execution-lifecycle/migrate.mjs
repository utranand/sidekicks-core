// `sidekicks execution migrate --dry-run|--apply` — one-release move to canonical execution storage.

import { existsSync } from 'node:fs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { parseFlags } from '../cli-executor-lifecycle/_shared.mjs';
import {
  canonicalExecutionConfigPath, canonicalExecutionConfigRel, readCanonicalExecutionConfig,
  resolveLegacyExecutionConfig, validateExecutionConfigSnapshot,
} from '../cli-executor-lifecycle/execution-config.mjs';

function flagsFor(argv) {
  const flags = parseFlags(argv, ['dry-run', 'apply', 'json']);
  const unknown = Object.keys(flags).find((key) => !['dry-run', 'apply', 'json'].includes(key));
  if (unknown || (flags['dry-run'] && flags.apply)) {
    throw new SidekicksError('execution migrate: use exactly one of --dry-run or --apply', EXIT_USAGE);
  }
  if (!flags['dry-run'] && !flags.apply) throw new SidekicksError('execution migrate: specify --dry-run or --apply', EXIT_USAGE);
  return flags;
}

function candidate(repoRoot, settings) {
  const legacy = resolveLegacyExecutionConfig(repoRoot, settings);
  return Object.freeze({ ...legacy, migration: { legacy_revision: legacy.revision, compatibility: 'legacy-read-fallback-one-release' } });
}

/** @param {{repoRoot: string, argv: string[]}} ctx */
export async function run(ctx, _args) {
  const flags = flagsFor(ctx.argv);
  const settings = readSettings(ctx.repoRoot);
  const path = canonicalExecutionConfigPath(ctx.repoRoot, settings);
  const pathRel = canonicalExecutionConfigRel(ctx.repoRoot, settings);
  const next = candidate(ctx.repoRoot, settings);
  // Validate before the first write: a non-secret canonical store must never be created with
  // placeholders for a legacy credential, because that would not be configuration-equivalent.
  validateExecutionConfigSnapshot(next);
  if (flags['dry-run']) {
    return { stdout: JSON.stringify({ ok: true, dry_run: true, path: pathRel, candidate: next }, null, 2) + '\n' };
  }
  if (existsSync(path)) {
    const current = readCanonicalExecutionConfig(path);
    if (current.revision !== next.revision) {
      throw new SidekicksError(`execution migrate: canonical storage already exists at ${pathRel}; inspect execution doctor before replacing it`, EXIT_USAGE);
    }
    return { stdout: JSON.stringify({ ok: true, applied: false, path: pathRel, revision: current.revision }, null, 2) + '\n' };
  }
  assertWritable(path, ctx.repoRoot);
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  const verified = readCanonicalExecutionConfig(path);
  if (verified.revision !== next.revision) throw new SidekicksError('execution migrate: post-write equivalence check failed', EXIT_USAGE);
  return { stdout: JSON.stringify({ ok: true, applied: true, path: pathRel, revision: verified.revision }, null, 2) + '\n' };
}
