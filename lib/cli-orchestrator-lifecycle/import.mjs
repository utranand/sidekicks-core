// `sidekicks cli-orchestrator import <queue-source.json> --preset <name> --preview|--apply`.
// Preview is read-only. Apply creates one approved, ready queue-supervisor/v1 run but never launches
// a worker; subsequent progress is exclusively through `cli-orchestrator supervise`.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { maskCredentials, validateExecutionConfigSnapshot } from '../cli-executor-lifecycle/execution-config.mjs';
import { resolveExecutionSnapshot } from '../execution-lifecycle/snapshot.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { renameWithRetry, writeAtomic } from '../fs-safety/fsx.mjs';
import { EXIT_USAGE, SidekicksError } from '../sk-cli/errors.mjs';
import { normalizePortableRelativePath } from '../durable-execution/paths.mjs';
import {
  approvalEnvelopeDigest,
  assertPublicDocument,
  normalizeApprovalEnvelope,
} from '../durable-execution/schema.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { initializeQueueLifecycle } from './driver.mjs';
import { compileQueueSource, previewFrozenBindings } from './compiler.mjs';

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(2),
      options: {
        preset: { type: 'string' },
        preview: { type: 'boolean', default: false },
        apply: { type: 'boolean', default: false },
        'expected-approval-digest': { type: 'string' },
        'expected-execution-revision': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new SidekicksError(`cli-orchestrator import: ${error.message}`, EXIT_USAGE);
  }
  if (parsed.positionals.length !== 1 || !parsed.values.preset
      || parsed.values.preview === parsed.values.apply
      || (parsed.values.apply && (!parsed.values['expected-approval-digest']
        || !parsed.values['expected-execution-revision']))) {
    throw new SidekicksError(
      'cli-orchestrator import: usage: import <queue-source.json> --preset <name> --preview | --apply --expected-approval-digest <sha256> --expected-execution-revision <sha256> [--json]',
      EXIT_USAGE,
    );
  }
  return { sourcePath: parsed.positionals[0], flags: parsed.values };
}

function readSource(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new SidekicksError(`cli-orchestrator import: cannot read source: ${error.message}`, EXIT_USAGE); }
}

function writeNew(path, value) {
  if (existsSync(path)) throw new SidekicksError(`cli-orchestrator import: refusing to overwrite ${path}`, EXIT_USAGE);
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safeRunParent(repoRoot, runId, { create = false } = {}) {
  let current = realpathSync(repoRoot);
  const segments = ['artifacts', 'runs', ...runId.split('/').slice(0, -1)];
  for (const segment of segments) {
    current = join(current, segment);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SidekicksError('[public-root-invalid] import public root and run parents must be real directories', EXIT_USAGE);
    }
  }
  return current;
}

/** Persist a compiled run without dispatching it. */
export function applyCompiledImport({
  repoRoot, compiled, executionSnapshot, expectedApprovalDigest, expectedExecutionRevision,
}) {
  const snapshot = validateExecutionConfigSnapshot(executionSnapshot);
  const approval = normalizeApprovalEnvelope(compiled.approval);
  const approvalDigest = approvalEnvelopeDigest(approval);
  if (compiled.approval_digest !== approvalDigest
      || canonicalJson(compiled.invocation_bindings) !== canonicalJson(approval.routing)) {
    throw new SidekicksError('cli-orchestrator import: compiled approval identity is inconsistent', EXIT_USAGE);
  }
  if (compiled.execution_revision !== snapshot.revision
      || approval.execution_revision !== snapshot.revision) {
    throw new SidekicksError('cli-orchestrator import: compiled execution snapshot is inconsistent', EXIT_USAGE);
  }
  if (expectedApprovalDigest !== approvalDigest) {
    throw new SidekicksError('cli-orchestrator import: reviewed approval digest changed; preview again', EXIT_USAGE);
  }
  if (expectedExecutionRevision !== snapshot.revision) {
    throw new SidekicksError('cli-orchestrator import: reviewed execution revision changed; preview again', EXIT_USAGE);
  }
  const runId = normalizePortableRelativePath(compiled.run_id, { allowRoot: false });
  const parentDir = safeRunParent(repoRoot, runId, { create: true });
  const runDir = join(parentDir, runId.split('/').at(-1));
  if (existsSync(runDir)) {
    throw new SidekicksError(`cli-orchestrator import: run '${runId}' already exists; nothing overwritten`, EXIT_USAGE);
  }
  const stagingDir = join(parentDir, `.queue-import-${randomUUID()}`);
  mkdirSync(stagingDir, { mode: 0o700 });
  const stageIdentity = lstatSync(stagingDir);
  const importDocument = {
    schema_version: compiled.schema_version,
    import_format: compiled.import_format,
    driver: compiled.driver,
    run_id: compiled.run_id,
    source_digest: compiled.source_digest,
    execution_revision: compiled.execution_revision,
    approval_digest: approvalDigest,
    preservation: {
      source_digest: compiled.source_digest,
      field_mappings: compiled.preservation.field_mappings,
    },
    preview: previewFrozenBindings(compiled),
  };
  assertPublicDocument(importDocument, 'queue-import');
  try {
    safeRunParent(repoRoot, runId);
    writeNew(join(stagingDir, 'queue-import.json'), importDocument);
    writeNew(join(stagingDir, 'execution-config.snapshot.json'), maskCredentials(snapshot));
    initializeQueueLifecycle(stagingDir, approval);
    safeRunParent(repoRoot, runId);
    const currentStage = lstatSync(stagingDir);
    if (!currentStage.isDirectory() || currentStage.isSymbolicLink()
        || currentStage.dev !== stageIdentity.dev || currentStage.ino !== stageIdentity.ino) {
      throw new SidekicksError('[public-root-invalid] import staging identity changed', EXIT_USAGE);
    }
    renameWithRetry(stagingDir, runDir);
  } catch (error) {
    // Only remove our own unchanged staging directory. Ambiguous redirected parents retain
    // evidence; cleanup must never follow them into somebody else's files.
    try {
      safeRunParent(repoRoot, runId);
      const observed = lstatSync(stagingDir);
      if (observed.isDirectory() && !observed.isSymbolicLink()
          && observed.dev === stageIdentity.dev && observed.ino === stageIdentity.ino) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    } catch { /* Preserve uncertain staging evidence. */ }
    throw error;
  }
  return Object.freeze({
    ok: true,
    applied: true,
    run_id: runId,
    run_dir: `artifacts/runs/${runId}`,
    driver: compiled.driver,
    execution_revision: snapshot.revision,
    approval_digest: approvalDigest,
    next: `sidekicks cli-orchestrator supervise ${runId} status`,
  });
}

function humanPreview(preview) {
  const lines = [
    `queue import preview: ${preview.run_id}`,
    `  driver: ${preview.driver}`,
    `  execution revision: ${preview.execution_revision}`,
    `  approval digest: ${preview.approval_digest}`,
    '',
    '  role · executor CLI · tier · redacted model_ref · invoke_id · effort · containment · source preset',
  ];
  for (const row of Object.values(preview.roles)) {
    const containment = `${row.containment.profile} enforces=${row.containment.enforces.join(',') || 'none'} gaps=${row.containment.gaps.join(',') || 'none'}`;
    lines.push(`  ${row.role} · ${row.executor} · ${row.tier} · ${row.model_ref} · ${row.invoke_id} · ${row.effort ?? 'null'} · ${containment} · ${row.source_preset}`);
  }
  lines.push('', `  fallback: ${JSON.stringify(preview.policy.fallback)}`,
    `  supervision: ${JSON.stringify(preview.policy.supervision)}`,
    `  budgets: ${JSON.stringify(preview.policy.budgets)}`,
    `  framing: ${JSON.stringify(preview.policy.framing)}`,
    `  authority: ${JSON.stringify(preview.policy.authority)}`,
    `  evidence policy: ${JSON.stringify(preview.policy.evidence_policy)}`,
    `  prompt template policy: ${JSON.stringify(preview.policy.prompt_template_policy)}`,
    `  scope revision: ${preview.policy.scope_revision}`,
    `  approval provenance: ${JSON.stringify(preview.policy.approval_provenance)}`);
  return `${lines.join('\n')}\n`;
}

/** @param {{repoRoot:string, argv:string[]}} ctx */
export async function run(ctx) {
  const command = parse(ctx.argv);
  const snapshot = resolveExecutionSnapshot(ctx.repoRoot, readSettings(ctx.repoRoot));
  const compiled = compileQueueSource({
    source: readSource(command.sourcePath),
    repoRoot: ctx.repoRoot,
    executionSnapshot: snapshot,
    presetName: command.flags.preset,
  });
  if (command.flags.preview) {
    const preview = previewFrozenBindings(compiled);
    return { stdout: command.flags.json ? `${JSON.stringify(preview, null, 2)}\n` : humanPreview(preview) };
  }
  const result = applyCompiledImport({
    repoRoot: ctx.repoRoot,
    compiled,
    executionSnapshot: snapshot,
    expectedApprovalDigest: command.flags['expected-approval-digest'],
    expectedExecutionRevision: command.flags['expected-execution-revision'],
  });
  return {
    stdout: command.flags.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `queue import: created ${result.run_id} (${result.driver}); no worker launched\nnext: ${result.next}\n`,
  };
}
