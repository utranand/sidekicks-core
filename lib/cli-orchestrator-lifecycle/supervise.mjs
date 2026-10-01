// `sidekicks cli-orchestrator supervise <run-id> <once|start|status|stop>`.
// This is the sole Phase 5 command namespace. It delegates lifecycle transitions to the selected
// Node driver and never creates a second executor/model registry.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { executionConsumers, resolveExecutionSnapshot } from '../execution-lifecycle/snapshot.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { normalizePortableRelativePath } from '../durable-execution/paths.mjs';
import {
  supervisorOnce, supervisorStart, supervisorStatus, supervisorStop,
} from './supervisor.mjs';

function parse(argv) {
  const values = parseArgs({
    args: argv.slice(2),
    options: {
      json: { type: 'boolean', default: false },
      reason: { type: 'string' },
      'max-cycles': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const [runId, action, ...extra] = values.positionals;
  if (!runId || !action || extra.length !== 0 || !['once', 'start', 'status', 'stop'].includes(action)) {
    throw new SidekicksError(
      'cli-orchestrator supervise: usage: supervise <run-id> <once|start|status|stop> [--json] [--max-cycles N] [--reason <text>]',
      EXIT_USAGE,
    );
  }
  const canonical = normalizePortableRelativePath(runId, { allowRoot: false });
  if (canonical !== runId) throw new SidekicksError('cli-orchestrator supervise: run-id is not canonical', EXIT_USAGE);
  if (values.values['max-cycles'] !== undefined
      && (!/^\d+$/u.test(values.values['max-cycles'])
        || !Number.isSafeInteger(Number(values.values['max-cycles']))
        || Number(values.values['max-cycles']) < 1)) {
    throw new SidekicksError('cli-orchestrator supervise: --max-cycles must be a positive safe integer', EXIT_USAGE);
  }
  if (action !== 'start' && values.values['max-cycles'] !== undefined) {
    throw new SidekicksError('cli-orchestrator supervise: --max-cycles is valid only for start', EXIT_USAGE);
  }
  if (action !== 'stop' && values.values.reason !== undefined) {
    throw new SidekicksError('cli-orchestrator supervise: --reason is valid only for stop', EXIT_USAGE);
  }
  return { runId, action, flags: values.values };
}

function load(repoRoot, runId) {
  const runDir = join(repoRoot, 'artifacts', 'runs', ...runId.split('/'));
  const approvalPath = join(runDir, 'approval-envelope.json');
  if (!existsSync(approvalPath)) {
    throw new SidekicksError(`cli-orchestrator supervise: run ${runId} has no approval-envelope.json`, EXIT_USAGE);
  }
  let approval;
  try { approval = JSON.parse(readFileSync(approvalPath, 'utf8')); }
  catch (error) {
    throw new SidekicksError(`cli-orchestrator supervise: approval envelope is unreadable: ${error.message}`, EXIT_USAGE);
  }
  return { repoRoot: realpathSync(repoRoot), runDir: realpathSync(runDir), approval };
}

function presentation(result) {
  const state = result.state;
  return {
    status: result.status ?? (result.stop_present === true ? 'stop-signal-set'
      : state?.stage === 'done' ? 'terminal' : 'observed'),
    run_id: state?.run_id ?? result.run_id,
    revision: state?.revision ?? null,
    stage: state?.stage ?? null,
    outcome: state?.outcome ?? null,
    decision: result.decision?.action ?? null,
    diagnostic: result.decision?.diagnostic ?? state?.parked?.diagnostic ?? null,
    report_ref: state?.report?.ref ?? null,
    stop_present: result.stop_present ?? null,
    supervisor: result.supervisor ?? null,
  };
}

export function superviseExitCode(action, status) {
  return action === 'start' && status !== 'terminal' ? EXIT_VALIDATION : EXIT_OK;
}

export async function run(ctx, _args) {
  const command = parse(ctx.argv);
  const input = load(ctx.repoRoot, command.runId);
  let result;
  if (command.action === 'status') result = supervisorStatus(input);
  else if (command.action === 'stop') result = supervisorStop({
    ...input, reason: command.flags.reason ?? 'operator requested',
  });
  else {
    const snapshot = resolveExecutionSnapshot(ctx.repoRoot, readSettings(ctx.repoRoot));
    const executorSpecs = executionConsumers(snapshot).executors;
    result = command.action === 'once'
      ? await supervisorOnce({ ...input, executorSpecs })
      : await supervisorStart({
        ...input,
        executorSpecs,
        maxCycles: command.flags['max-cycles'] === undefined
          ? undefined : Number(command.flags['max-cycles']),
      });
  }
  const value = presentation(result);
  const exitCode = superviseExitCode(command.action, value.status);
  const human = command.action === 'stop'
    ? `queue supervisor ${value.run_id}: STOP signal set${result.already_present ? ' (refreshed)' : ''}; current attempts may settle, no new dispatch is allowed\n`
    : command.action === 'status'
      ? `queue supervisor ${value.run_id}: stage=${value.stage}; revision=${value.revision}; outcome=${value.outcome}; liveness=${value.supervisor?.liveness ?? 'unobserved'}; STOP=${value.stop_present === true ? 'present' : 'absent'}; report=${value.report_ref ?? 'none'}${value.diagnostic ? `; diagnostic=${value.diagnostic}` : ''}\n`
      : `queue supervisor ${value.run_id}: ${value.status}; stage=${value.stage ?? 'n/a'}; revision=${value.revision ?? 'n/a'}; decision=${value.decision ?? 'none'}; report=${value.report_ref ?? 'none'}${value.diagnostic ? `; diagnostic=${value.diagnostic}` : ''}\n`;
  return {
    stdout: command.flags.json === true
      ? `${JSON.stringify(value, null, 2)}\n`
      : human,
    exitCode,
  };
}
