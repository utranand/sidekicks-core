import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { read } from '../settings-store/settings.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { parseFlags, resolveRegistryPath, readRegistry, writeRegistry, validateCapabilities, CANDIDATE_VERSION } from './_shared.mjs';

export async function run(ctx) {
  const flags = parseFlags(ctx.argv, ['apply', 'root', 'json']);
  if (!flags.from) throw new SidekicksError('cli-executor sync: --from <candidate.json|-> is required', EXIT_VALIDATION);
  let raw;
  try { raw = flags.from === '-' ? readFileSync(0, 'utf8') : readFileSync(String(flags.from), 'utf8'); }
  catch (err) { throw new SidekicksError(`cli-executor sync: cannot read candidate: ${err.message}`, EXIT_VALIDATION); }
  let candidate;
  try { candidate = JSON.parse(raw); } catch { throw new SidekicksError('cli-executor sync: candidate is not valid JSON', EXIT_VALIDATION); }
  if (!candidate || candidate.candidate_version !== CANDIDATE_VERSION || !candidate.executors || typeof candidate.executors !== 'object') {
    throw new SidekicksError('cli-executor sync: unsupported or malformed candidate', EXIT_VALIDATION);
  }
  // Validate every block before touching the target registry, making apply all-or-nothing.
  const updates = {};
  for (const [name, entry] of Object.entries(candidate.executors)) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => key !== 'capabilities')) throw new SidekicksError(`cli-executor sync: invalid block for '${name}'`, EXIT_VALIDATION);
    updates[name] = validateCapabilities(name, entry.capabilities);
  }
  const { path, pathRel, scopeLabel } = resolveRegistryPath(ctx.repoRoot, read(ctx.repoRoot), { root: flags.root === true });
  const registry = readRegistry(path);
  const diff = [];
  for (const [name, capabilities] of Object.entries(updates)) {
    const previous = registry.executors[name]?.capabilities;
    const oldIds = new Set(previous?.models?.map((row) => row.id) || []);
    const newIds = new Set(capabilities.models.map((row) => row.id));
    diff.push({ executor: name, status: capabilities.status, added: [...newIds].filter((id) => !oldIds.has(id)), removed: [...oldIds].filter((id) => !newIds.has(id)) });
  }
  if (flags.apply) {
    if (registry.schema_version >= 3) {
      const statePath = join(dirname(dirname(path)), 'state', 'cli-executor-capabilities.json');
      let snapshots = [];
      if (existsSync(statePath)) {
        try { snapshots = JSON.parse(readFileSync(statePath, 'utf8')).snapshots || []; }
        catch { throw new SidekicksError(`cli-executor sync: invalid derived capability state ${statePath}`, EXIT_VALIDATION); }
      }
      for (const [name, capabilities] of Object.entries(updates)) {
        const spec = registry.executors[name] || {};
        const fingerprint = createHash('sha256').update(JSON.stringify({ kind: spec.kind, binary: spec.binary,
          invoke: spec.invoke, profile: spec.profile, transport: spec.transport, sandbox: spec.sandbox,
          capabilities_command: spec.capabilities_command }), 'utf8').digest('hex');
        const index = snapshots.findIndex((item) => item.scope === scopeLabel
          && item.executor === name && item.registration_fingerprint === fingerprint
          && item.cli_version === capabilities.cli_version && item.account_context_fingerprint === null);
        const previous = index >= 0 ? snapshots[index] : null;
        const rows = {};
        let completeIdentity = capabilities.status === 'complete';
        for (const row of capabilities.models || []) {
          if (typeof row.canonical_ref !== 'string' || !row.canonical_ref) { completeIdentity = false; continue; }
          rows[row.canonical_ref] = { ...row, invoke_id: row.id };
          delete rows[row.canonical_ref].id;
        }
        const snapshot = { scope: scopeLabel, executor: name,
          registration_fingerprint: fingerprint, cli_version: capabilities.cli_version,
          account_context_fingerprint: null,
          status: capabilities.status === 'unavailable' ? 'unavailable'
            : (completeIdentity ? 'complete' : 'partial'),
          models: completeIdentity ? rows : (previous?.models || {}),
          diagnostic: capabilities.diagnostic || (completeIdentity ? null : 'discovery rows lack authoritative canonical_ref'),
          discovered_at: capabilities.discovered_at };
        if (index >= 0) snapshots[index] = snapshot; else snapshots.push(snapshot);
      }
      mkdirSync(dirname(statePath), { recursive: true });
      writeAtomic(statePath, JSON.stringify({ schema_version: 1, snapshots }, null, 2) + '\n');
    } else {
      for (const [name, capabilities] of Object.entries(updates)) {
        const prior = registry.executors[name] || { kind: 'builtin', enabled: true };
        // v1/v2 compatibility: a transient failure never erases last-known-good rows.
        registry.executors[name] = { ...prior, capabilities: capabilities.status === 'unavailable' && prior.capabilities?.models?.length ? { ...capabilities, models: prior.capabilities.models } : capabilities };
      }
      writeRegistry(path, registry, ctx.repoRoot);
    }
  }
  const output = { target: pathRel, applied: flags.apply === true, diff };
  return { stdout: flags.json ? JSON.stringify(output, null, 2) + '\n' : `${flags.apply ? 'applied' : 'preview'} capability sync for ${pathRel}: ${diff.map((d) => `${d.executor} +${d.added.length}/-${d.removed.length} (${d.status})`).join(', ')}\n`, exitCode: EXIT_OK };
}
