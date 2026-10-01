// `sidekicks config unset <block>.<key.path> [--root] [--json]`
//
// The inverse of `config set`: a Rule 1-mediated removal for one scope override. It removes the
// requested path from BOTH family halves, because an alias's structure is public while credentials
// commonly live in the git-ignored sibling. Removing only the public half would leave a credential
// that can reappear if the alias is re-added later.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { blockEntry, CONFIG_DIR, LEGACY_FILE } from '../config-store/families.mjs';
import { readBlock } from '../config-store/block.mjs';
import { writeBlock, PENDING_PREFIX } from '../config-store/write.mjs';
import { parseConfigFlags, requireBlock, unsetPath } from './_shared.mjs';
import { listOffloaded } from '../database-lifecycle/_offload-marks.mjs';

/**
 * The two blocks `sidekicks database offload` can park an alias out of. Same refusal reason as
 * `config set`'s own copy of this constant.
 */
const OFFLOADABLE_CONNECTOR_BLOCKS = new Set(['database_connector', 'teleport_database_connector']);

/**
 * Remove one configured key path from the active scope.
 *
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const flags = parseConfigFlags(ctx.argv, ['root', 'json']);
  const target = requireBlock(args.name, 'config unset');
  const dot = target.indexOf('.');
  if (dot === -1) {
    throw new SidekicksError(
      `config unset: '${target}' names a whole block — unset one key path at a time `
      + '(e.g. `config unset database_connector.local-demo`)',
      EXIT_USAGE,
    );
  }
  const blockName = target.slice(0, dot);
  const keyPath = target.slice(dot + 1);
  const entry = blockEntry(repoRoot, blockName);
  if (!entry) {
    throw new SidekicksError(
      `config unset: nothing declares block '${blockName}' — run 'sidekicks config list'`,
      EXIT_USAGE,
    );
  }

  const settings = readSettings(repoRoot);
  const { projectName, projectRelPath } = resolveEffectiveScope(settings);
  const useRoot = Boolean(flags.root) || entry.scope === 'root' || projectRelPath === null;
  if (entry.scope === 'project' && useRoot) {
    throw new SidekicksError(
      `config unset: block '${blockName}' is project-scoped, so it has no root-scope home`
      + (projectRelPath === null
        ? ` — activate a project first: 'sidekicks project use <name>'`
        : ` — drop '--root' to write it to '${projectRelPath}/${CONFIG_DIR}/${entry.file}'`),
      EXIT_USAGE,
    );
  }

  const base = useRoot ? '.sidekicks' : projectRelPath;

  // Same refusal as `config set` — an unset onto an offloaded alias would be a silent no-op, since
  // a parked alias is a comment at any indent and is already invisible to every reader.
  if (OFFLOADABLE_CONNECTOR_BLOCKS.has(blockName)) {
    const offloadedAlias = keyPath.split('.')[0];
    const candidateFiles = [
      join(base, CONFIG_DIR, entry.file),
      join(base, CONFIG_DIR, entry.secret),
      join(base, LEGACY_FILE),
      join(base, CONFIG_DIR, `${PENDING_PREFIX}config.yaml`),
    ];
    for (const candidateRel of candidateFiles) {
      const candidateAbs = join(repoRoot, candidateRel);
      if (!existsSync(candidateAbs)) continue;
      const candidateText = readFileSync(candidateAbs, 'utf8');
      const parked = listOffloaded(candidateText)
        .some((rec) => rec.block === blockName && rec.alias === offloadedAlias);
      if (parked) {
        throw new SidekicksError(
          `config unset: '${offloadedAlias}' is offloaded — restore first with `
          + `'sidekicks database offload ${offloadedAlias} --restore'`,
          EXIT_USAGE
        );
      }
    }
  }

  const changed = [];
  for (const file of [entry.file, entry.secret]) {
    const rel = join(base, CONFIG_DIR, file);
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const current = readBlock(text, entry.block);
    if (!current || !unsetPath(current, keyPath)) continue;
    writeBlock(repoRoot, rel, entry.block, current);
    changed.push(rel);
  }

  if (!changed.length) {
    throw new SidekicksError(
      `config unset: '${blockName}' has no configured key '${keyPath}' in scope `
      + `'${useRoot ? 'sidekicks' : projectName}'`,
      EXIT_USAGE,
    );
  }

  if (flags.json) {
    return {
      stdout: JSON.stringify({
        block: entry.block,
        key: keyPath,
        scope: useRoot ? 'sidekicks' : projectName,
        removed: true,
        files: changed,
      }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  return {
    stdout: `unset ${entry.block}.${keyPath} from ${changed.join(', ')}\n`,
    exitCode: EXIT_OK,
  };
}
