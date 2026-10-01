import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { modelReferenceFor, parseFlags } from './_shared.mjs';
import { runSkillPython } from './_python.mjs';

export async function run(ctx, args) {
  const flags = parseFlags(ctx.argv, ['metadata-only', 'json']);
  const names = [args.name, ...(args.rest || [])].filter(Boolean);
  const command = ['--root', ctx.repoRoot, ...(flags['metadata-only'] ? ['--metadata-only'] : []), ...names];
  const result = runSkillPython(ctx.repoRoot, 'capabilities.py', command);
  if (result.status !== 0) throw new SidekicksError(`cli-executor discover failed: ${result.stderr.trim()}`, EXIT_VALIDATION);
  let candidate;
  try { candidate = JSON.parse(result.stdout); } catch { throw new SidekicksError('cli-executor discover returned invalid JSON', EXIT_VALIDATION); }
  // Native CLIs report provider-local model ids.  v3 stores a provider-neutral, executor-scoped
  // reference, so attach the deterministic reference before `sync` persists the snapshot.  Without
  // this bridge every successful native discovery is downgraded to partial and selected seats can
  // never become verified.
  for (const [name, entry] of Object.entries(candidate.executors || {})) {
    const models = entry?.capabilities?.models;
    if (!Array.isArray(models)) continue;
    entry.capabilities.models = models.map((row) => ({
      ...row,
      ...(typeof row?.canonical_ref === 'string' && row.canonical_ref
        ? {} : (typeof row?.id === 'string' && row.id ? { canonical_ref: modelReferenceFor(name, row.id) } : {})),
    }));
  }
  if (flags.json) return { stdout: JSON.stringify(candidate, null, 2) + '\n', exitCode: EXIT_OK };
  const lines = [`cli-executor capability discovery — ${Object.keys(candidate.executors).length} executor(s)`];
  for (const [name, entry] of Object.entries(candidate.executors)) {
    const c = entry.capabilities;
    lines.push(`  ${name}: ${c.status}; ${c.models.length} model(s) via ${c.source.kind}`);
  }
  for (const d of candidate.diagnostics || []) lines.push(`  ${d.executor}: ${d.message}`);
  lines.push('Review then apply explicitly: sidekicks cli-executor sync --from <candidate.json> --apply');
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
