// lib/goal-lifecycle/status.mjs
// `sidekicks goal status [<run-id>] [--json]` — where a run is, and what it is waiting for.
//
// READ-ONLY, AND IT TAKES NO LEASE. Status has to work while another process holds the run — that is
// exactly when someone wants it — so it reads `run.json` without acquiring anything and reports the
// lease's own classification instead. A status command that blocked on the lock it is describing
// would be useless at the only moment it matters.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_OK, EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RELATIVE, goalPositionals, listGoalRuns, loadRun, parseGoalFlags } from './commands.mjs';
import { goalPaths, inspectRunLease, readJsonIfPresent, stopPresent } from './store.mjs';
import { renderStatus } from './render.mjs';
import { buildMonitor, renderMonitor } from './monitor.mjs';

const BOOLEANS = ['json', 'monitor'];

/**
 * Run `goal status`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const runId = goalPositionals(ctx.argv, BOOLEANS)[0];
  if (flags.monitor === true && !runId) {
    throw new SidekicksError('goal status: --monitor requires <run-id>', EXIT_USAGE);
  }

  if (!runId) {
    const runs = listGoalRuns(ctx.repoRoot);
    if (flags.json === true) {
      return { stdout: `${JSON.stringify({ runs }, null, 2)}\n`, exitCode: EXIT_OK };
    }
    if (runs.length === 0) {
      return {
        stdout: 'no goal runs in this scope yet — start one with `sidekicks goal plan "<goal>"`\n',
        exitCode: EXIT_OK,
      };
    }
    const lines = ['goal runs in this scope (newest first):', ''];
    for (const r of runs) {
      lines.push(`  ${r.run_id}  ${String(r.phase).padEnd(24)} ${r.updated_at ?? ''}`);
    }
    lines.push('');
    lines.push('  sidekicks goal status <run-id>   for one run in full');
    return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
  }

  const { runDir, state } = loadRun(ctx.repoRoot, runId);
  const lease = inspectRunLease(runDir);
  const stopped = stopPresent(runDir);
  if (flags.monitor === true) {
    const monitor = buildMonitor({ state, runDir: RELATIVE(ctx.repoRoot, runDir), lease,
      stopPresent: stopped, envelope: readJsonIfPresent(goalPaths(runDir).envelope) ?? {},
      artifactExists: (relative) => existsSync(join(runDir, relative)) });
    return { stdout: flags.json === true ? `${JSON.stringify(monitor, null, 2)}\n`
      : renderMonitor(monitor), exitCode: EXIT_OK };
  }

  if (flags.json === true) {
    return {
      stdout: `${JSON.stringify({
        ...state,
        run_dir: RELATIVE(ctx.repoRoot, runDir),
        lease_state: lease.state,
        lease_reason: lease.reason,
        stop_present: stopped,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }

  return {
    stdout: renderStatus({
      state,
      runDir: RELATIVE(ctx.repoRoot, runDir),
      lease,
      stopPresent: stopped,
    }),
    exitCode: EXIT_OK,
  };
}
