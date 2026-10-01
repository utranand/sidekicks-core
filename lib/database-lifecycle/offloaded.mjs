// lib/database-lifecycle/offloaded.mjs
// Implements `sidekicks database offloaded [--json] [--root]` — lists every alias `database
// offload` has parked in the active scope: the tier `_offload-shared.mjs` derives from its own
// name, which block(s) it was parked out of, and the reason recorded in its `#[offloaded:meta]`
// annotation line.
//
// Read-only — no writes, so no assertWritable/fs-guard gate is needed.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../sk-cli/errors.mjs';
import { listOffloaded } from './_offload-marks.mjs';
import { OFFLOAD_BLOCKS, dbTierFromAlias, tokenizeOffloadArgv, resolveOffloadScope } from './_offload-shared.mjs';

/**
 * Execute the `database offloaded` verb.
 *
 * @param {{repoRoot: string, argv?: string[]}} ctx
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const { flags } = tokenizeOffloadArgv(Array.isArray(ctx.argv) ? ctx.argv : []);
  const scope = resolveOffloadScope(repoRoot, flags);
  const blocks = new Set(OFFLOAD_BLOCKS);

  /** @type {Map<string, {alias: string, tier: string, blocks: Set<string>, reason: string, offloaded_at: string, by: string}>} */
  const byAlias = new Map();

  for (const relFile of scope.files) {
    const abs = join(repoRoot, relFile);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const rec of listOffloaded(text)) {
      if (!blocks.has(rec.block)) continue;
      const existing = byAlias.get(rec.alias) || {
        alias: rec.alias, tier: dbTierFromAlias(rec.alias), blocks: new Set(),
        reason: '', offloaded_at: '', by: '',
      };
      existing.blocks.add(rec.block);
      if (!existing.reason && !existing.offloaded_at) {
        existing.reason = rec.reason;
        existing.offloaded_at = rec.stamp;
        existing.by = rec.user;
      }
      byAlias.set(rec.alias, existing);
    }
  }

  const aliases = [...byAlias.values()]
    .map((r) => ({ ...r, blocks: [...r.blocks] }))
    .sort((a, b) => a.alias.localeCompare(b.alias));

  if (flags.json) {
    return {
      stdout: JSON.stringify({ scope: scope.projectName, count: aliases.length, aliases }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }

  if (!aliases.length) {
    return {
      stdout: `No offloaded database aliases in scope '${scope.projectName}'.\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = aliases.map((a) => `${a.alias.padEnd(28)} tier=${a.tier.padEnd(8)} `
    + `blocks=${a.blocks.join('+').padEnd(28)} `
    + `${a.reason ? `reason="${a.reason}"` : '(no reason recorded)'}`);
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
