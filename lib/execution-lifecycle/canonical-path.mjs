// Dependency-free location and JSON reader for canonical execution storage.
// Kept below the composite execution-config module so legacy readers can consult the store
// without creating a circular dependency through registry/preset resolution.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_IO, SidekicksError } from '../sk-cli/errors.mjs';

export const EXECUTION_CONFIG_FILE = 'cli-execution.json';

export function canonicalExecutionConfigPath(repoRoot, _settings = {}) {
  return join(repoRoot, '.sidekicks', 'config', EXECUTION_CONFIG_FILE);
}

export function canonicalExecutionConfigRel(_repoRoot, _settings = {}) {
  return join('.sidekicks', 'config', EXECUTION_CONFIG_FILE);
}

export function readCanonicalExecutionDocument(repoRoot, settings = {}) {
  const path = canonicalExecutionConfigPath(repoRoot, settings);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { throw new SidekicksError(`execution-config: cannot read canonical snapshot ${path}: ${err.message}`, EXIT_IO); }
}
