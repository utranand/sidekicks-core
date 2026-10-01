// lib/cli-executor-lifecycle/models.mjs
// `sidekicks cli-executor models [<name>...] [--refresh] [--root] [--json]` — the tier↔catalog
// reconciliation surface: which model each tier selects, whether the discovered catalog still
// carries it, and which catalog models no tier has claimed.
//
// This is the verb to run when a vendor ships a new model. `discover`/`sync` refresh the CATALOG
// (`capabilities.models[]`); `register --model-<tier> <id>` sets the SELECTION (`models`). Nothing
// joined the two, so a released top-tier model and a retired mapped model were both invisible.
//
// It NEVER writes a tier map. A discovered model row carries id/display_name/aliases/efforts and no
// tier hint whatsoever, so promoting one to `top` (or any tier) is a routing decision the operator
// owns — the verb prints the exact `register` command and stops. `--refresh` writes only the
// capability snapshot, through the same discover→sync path an operator would run by hand.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { read } from '../settings-store/settings.mjs';
import {
  MODEL_TIERS,
  effectiveExecutors,
  parseFlags,
  readEffectiveRegistry,
  readRegistry,
  resolveRegistryPath,
  selectionStatus,
  MODEL_ID_RE,
  modelReferenceFor,
  readableModelReference,
  validateModelReference,
  writeRegistry,
} from './_shared.mjs';
import { run as runDiscover } from './discover.mjs';
import { run as runSync } from './sync.mjs';

/**
 * Refresh the capability snapshot for the named executors (all, when none are named) by driving the
 * SAME discover→sync path an operator would run by hand — a candidate is discovered, then applied.
 * Touches `capabilities` only; `models`, `efforts` and every routing field are left alone.
 *
 * @param {string} repoRoot
 * @param {string[]} names
 * @param {boolean} rootScope
 * @returns {Promise<{ diff: Array<object>, candidate: object }>}
 */
async function refreshCapabilities(repoRoot, names, rootScope) {
  const discovered = await runDiscover(
    { repoRoot, argv: ['--json', ...names] },
    { name: names[0], rest: names.slice(1) },
  );
  const dir = mkdtempSync(join(tmpdir(), 'sk-cliexec-candidate-'));
  const candidatePath = join(dir, 'candidate.json');
  try {
    writeFileSync(candidatePath, discovered.stdout, 'utf8');
    const applied = await runSync({
      repoRoot,
      argv: ['--from', candidatePath, '--apply', '--json', ...(rootScope ? ['--root'] : [])],
    });
    return { ...JSON.parse(applied.stdout), candidate: JSON.parse(discovered.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A versioned identity is comparable only when every version segment is numeric. */
function versionedIdentity(reference) {
  if (!validateModelReference(reference) || reference.startsWith('opaque/')) return null;
  const match = reference.match(/^([^/]+)\/(.+)@([0-9][A-Za-z0-9._+-]*)(?:\/([^/]+))?$/);
  if (!match || !/^\d+(?:\.\d+)*$/.test(match[3])) return null;
  return { provider: match[1], line: match[2], version: match[3].split('.').map(Number), variant: match[4] || '' };
}

function compareVersion(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

/**
 * Promote only an identity that proves it supersedes the selected one. Catalog ordering, display
 * names, and arbitrary vendor ids are deliberately insufficient evidence for an automatic route.
 */
function adoptNewerModels(registry, candidate, names) {
  if (registry.schema_version < 3) {
    throw new SidekicksError('cli-executor models --adopt-newer requires a v3 registry; run `cli-executor models --migrate` first', EXIT_VALIDATION);
  }
  const catalog = { ...(registry.model_catalog || {}) };
  const changes = [];
  for (const name of names) {
    const spec = registry.executors[name];
    const rows = candidate?.executors?.[name]?.capabilities?.status === 'complete'
      ? candidate.executors[name].capabilities.models || [] : [];
    for (const tier of MODEL_TIERS) {
      const previous = spec?.models?.[tier];
      const oldIdentity = versionedIdentity(previous);
      if (!oldIdentity) continue;
      const candidates = rows.filter((row) => {
        const next = versionedIdentity(row.canonical_ref);
        return next && next.provider === oldIdentity.provider && next.line === oldIdentity.line
          && next.variant === oldIdentity.variant && compareVersion(next.version, oldIdentity.version) > 0;
      });
      candidates.sort((a, b) => compareVersion(versionedIdentity(b.canonical_ref).version, versionedIdentity(a.canonical_ref).version));
      const selected = candidates[0];
      if (!selected) continue;
      const next = selected.canonical_ref;
      spec.models[tier] = next;
      spec.model_bindings = { ...(spec.model_bindings || {}), [next]: { invoke_id: selected.id } };
      catalog[previous] = { ...(catalog[previous] || {}), parked: true, replaced_by: next };
      catalog[next] = { ...(catalog[next] || {}), display_name: selected.display_name || selected.id };
      delete catalog[next].parked;
      delete catalog[next].replaced_by;
      changes.push({ executor: name, tier, from: previous, to: next });
    }
  }
  registry.model_catalog = catalog;
  return changes;
}

/**
 * Register provider ids as invocation bindings on one executor without selecting them for any
 * tier: routing stays an operator decision (`register --model-<tier>`). Idempotent; an id whose
 * reference is already bound to a different id is refused rather than overwritten.
 *
 * @returns {{ added: Array<object>, existing: Array<object> }}
 */
function bindModels(registry, executor, ids) {
  if (registry.schema_version < 3) {
    throw new SidekicksError('cli-executor models --bind requires a v3 registry; run `cli-executor models --migrate` first', EXIT_VALIDATION);
  }
  const spec = registry.executors[executor];
  if (!spec) throw new SidekicksError(`cli-executor models --bind: unknown executor '${executor}' in this registry`, EXIT_VALIDATION);
  if (!ids.length) throw new SidekicksError('cli-executor models --bind <executor> <invoke_id>... needs at least one provider model id', EXIT_VALIDATION);
  const bindings = { ...(spec.model_bindings || {}) };
  const catalog = { ...(registry.model_catalog || {}) };
  const added = [];
  const existing = [];
  for (const id of ids) {
    if (!MODEL_ID_RE.test(id)) throw new SidekicksError(`cli-executor models --bind: '${id}' must match ${MODEL_ID_RE.source}`, EXIT_VALIDATION);
    const ref = modelReferenceFor(executor, id);
    if (bindings[ref]) {
      if (bindings[ref].invoke_id !== id) throw new SidekicksError(`cli-executor models --bind: ${ref} is already bound to '${bindings[ref].invoke_id}'`, EXIT_VALIDATION);
      existing.push({ executor, ref, invoke_id: id });
      continue;
    }
    bindings[ref] = { invoke_id: id };
    catalog[ref] = { ...(catalog[ref] || {}), display_name: id };
    delete catalog[ref].parked;
    delete catalog[ref].replaced_by;
    added.push({ executor, ref, invoke_id: id });
  }
  spec.model_bindings = bindings;
  registry.model_catalog = catalog;
  return { added, existing };
}

/** Raw provider id behind a selection: its committed binding, else the plain value / decoded opaque id. */
function rawIdOf(spec, value) {
  const bound = spec.model_bindings?.[value]?.invoke_id;
  if (typeof bound === 'string' && bound) return bound;
  if (!validateModelReference(value)) return value;
  const opaque = value.match(/^opaque\/[^@]+@(.+)$/);
  return opaque ? Buffer.from(opaque[1], 'base64url').toString('utf8') : null;
}

/**
 * Rewrite opaque (and plain legacy) selections and bindings to the readable canonical reference
 * that `readableModelReference` derives from the provider id. A selected reference keeps its old
 * binding, parked with `replaced_by` (as --adopt-newer does), so an in-flight approval envelope
 * naming it still resolves; an unselected opaque binding is replaced outright. Ids with no version
 * to name stay untouched. Idempotent.
 *
 * @returns {{ changes: Array<object>, left: Array<object> }}
 */
function canonicalizeModels(registry) {
  if (registry.schema_version < 3) {
    throw new SidekicksError('cli-executor models --canonicalize requires a v3 registry; run `cli-executor models --migrate` first', EXIT_VALIDATION);
  }
  const catalog = { ...(registry.model_catalog || {}) };
  const changes = [];
  const left = [];
  for (const [name, spec] of Object.entries(registry.executors)) {
    const bindings = { ...(spec.model_bindings || {}) };
    const selection = (value) => value && (Object.values(spec.models || {}).includes(value) || spec.default_model === value);
    const move = (from, kind) => {
      const raw = rawIdOf(spec, from);
      const to = raw && readableModelReference(raw);
      if (!to || to === from) {
        if (!to && !left.some((row) => row.executor === name && row.ref === from)) left.push({ executor: name, ref: from, invoke_id: raw, reason: 'no version to name' });
        return from;
      }
      if (bindings[to] && bindings[to].invoke_id !== raw) {
        left.push({ executor: name, ref: from, invoke_id: raw, reason: `canonical ${to} already bound to another id` });
        return from;
      }
      bindings[to] = { invoke_id: raw };
      catalog[to] = { ...(catalog[to] || {}), display_name: raw };
      delete catalog[to].parked;
      delete catalog[to].replaced_by;
      if (validateModelReference(from) && bindings[from]) {
        if (selection(from)) catalog[from] = { ...(catalog[from] || {}), parked: true, replaced_by: to };
        else { delete bindings[from]; delete catalog[from]; }
      }
      changes.push({ executor: name, kind, from, to, invoke_id: raw });
      return to;
    };
    for (const tier of MODEL_TIERS) {
      if (spec.models?.[tier]) spec.models[tier] = move(spec.models[tier], `models.${tier}`);
    }
    if (spec.default_model) spec.default_model = move(spec.default_model, 'default_model');
    for (const ref of Object.keys(bindings)) {
      if (bindings[ref]?.invoke_id && ref.startsWith('opaque/') && !catalog[ref]?.parked) move(ref, 'binding');
    }
    if (Object.keys(bindings).length) spec.model_bindings = bindings;
  }
  registry.model_catalog = catalog;
  return { changes, left };
}

/**
 * Catalog model rows that no tier selects. A `hidden` row is excluded: the CLI itself declined to
 * advertise it, so suggesting a binding for it would invent a recommendation the vendor withheld.
 *
 * @param {Record<string, any>} spec
 * @returns {Array<{ id: string, display_name: string, supported_efforts: string[] }>}
 */
function unboundModels(spec) {
  const rows = spec?.capabilities?.models;
  if (!Array.isArray(rows) || !rows.length) return [];
  const selected = new Set(MODEL_TIERS.map((tier) => spec.models?.[tier]).filter(Boolean));
  return rows
    .filter((row) => row && row.hidden !== true)
    .filter((row) => !selected.has(row.id) && !(row.aliases || []).some((alias) => selected.has(alias)))
    .map((row) => ({
      id: row.id,
      display_name: row.display_name || row.id,
      supported_efforts: Array.isArray(row.supported_efforts) ? row.supported_efforts.slice() : [],
    }));
}

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string, rest?: string[] }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  // Valued flags are re-parsed off argv, never read from ctx.flags: the dispatcher's parseArgs
  // turns `--flag value` into a boolean plus a positional, so a verb reading ctx.flags works in
  // the `=` spelling and silently breaks in the space spelling.
  const flags = parseFlags(ctx.argv, ['refresh', 'root', 'json', 'migrate', 'canonicalize', 'bind', 'adopt-newer']);
  const rootScope = flags.root === true;
  const settings = read(repoRoot);
  const { path, pathRel, scopeLabel } = resolveRegistryPath(repoRoot, settings, { root: rootScope });

  if (flags.migrate === true) {
    const registry = readRegistry(path);
    if (registry.schema_version >= 3) return { stdout: `registry already uses schema v${registry.schema_version}\n`, exitCode: EXIT_OK };
    const statePath = join(dirname(dirname(path)), 'state', 'cli-executor-capabilities.json');
    let state = { schema_version: 1, snapshots: [] };
    if (existsSync(statePath)) {
      try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { throw new SidekicksError(`cli-executor models migrate: invalid capability state ${statePath}`, EXIT_VALIDATION); }
    }
    const snapshots = Array.isArray(state.snapshots) ? state.snapshots.slice() : [];
    const migrated = [];
    const catalog = { ...(registry.model_catalog || {}) };
    for (const [name, spec] of Object.entries(registry.executors)) {
      const bindings = { ...(spec.model_bindings || {}) };
      const refFor = (raw) => {
        if (validateModelReference(raw)) return raw;
        const ref = modelReferenceFor(name, raw);
        catalog[ref] ||= { display_name: String(raw), legacy: true };
        bindings[ref] ||= { invoke_id: String(raw) };
        return ref;
      };
      spec.models = Object.fromEntries(Object.entries(spec.models || {}).map(([tier, raw]) => [tier, refFor(raw)]));
      if (spec.default_model) spec.default_model = refFor(spec.default_model);
      if (Object.keys(bindings).length) spec.model_bindings = bindings;
      if (spec.capabilities) {
        const caps = spec.capabilities;
        const rows = {};
        for (const row of caps.models || []) {
          const ref = refFor(row.canonical_ref || row.id);
          rows[ref] = { ...row, invoke_id: row.id };
          delete rows[ref].id;
        }
        const snap = { scope: rootScope ? 'root' : scopeLabel, executor: name,
          registration_fingerprint: null, cli_version: caps.cli_version || null,
          account_context_fingerprint: null, status: caps.status, models: rows,
          diagnostic: caps.diagnostic || null, discovered_at: caps.discovered_at || null };
        const old = snapshots.findIndex((item) => item.scope === snap.scope && item.executor === name);
        if (old >= 0) snapshots[old] = snap; else snapshots.push(snap);
        delete spec.capabilities;
      }
      migrated.push(name);
    }
    mkdirSync(dirname(statePath), { recursive: true });
    writeAtomic(statePath, JSON.stringify({ schema_version: 1, snapshots }, null, 2) + '\n');
    registry.schema_version = 3;
    registry.model_catalog = catalog;
    const { writeRegistry } = await import('./_shared.mjs');
    writeRegistry(path, registry, repoRoot);
    return { stdout: `migrated registry ${pathRel} to v3; moved capability snapshots to ${statePath}; executors: ${migrated.join(', ')}\n`, exitCode: EXIT_OK };
  }

  if (flags.bind === true) {
    const [executor, ...ids] = [args?.name, ...(args?.rest || [])].filter(Boolean);
    const registry = readRegistry(path);
    const { added, existing } = bindModels(registry, executor, ids);
    if (added.length) writeRegistry(path, registry, repoRoot);
    if (flags.json === true) return { stdout: JSON.stringify({ target: pathRel, scope: scopeLabel, added, existing }, null, 2) + '\n', exitCode: EXIT_OK };
    const lines = [`cli-executor models --bind — ${pathRel}: ${added.length} binding(s) added to ${executor}`];
    for (const row of added) lines.push(`  ${row.ref} → ${row.invoke_id}`);
    for (const row of existing) lines.push(`  already bound: ${row.ref}`);
    lines.push('  no tier was changed; select with: sidekicks cli-executor register ' + executor + ' --model-<tier> <ref>');
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  if (flags.canonicalize === true) {
    const registry = readRegistry(path);
    const { changes, left } = canonicalizeModels(registry);
    if (changes.length) writeRegistry(path, registry, repoRoot);
    if (flags.json === true) return { stdout: JSON.stringify({ target: pathRel, scope: scopeLabel, changes, left }, null, 2) + '\n', exitCode: EXIT_OK };
    const lines = [`cli-executor models --canonicalize — ${pathRel}: ${changes.length} reference(s) rewritten`];
    for (const row of changes) lines.push(`  ${row.executor} ${row.kind}: ${row.from} → ${row.to}`);
    for (const row of left) lines.push(`  left as-is: ${row.executor} ${row.invoke_id ?? row.ref} (${row.reason})`);
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  const requested = [args?.name, ...(args?.rest || [])].filter(Boolean);
  if (flags['adopt-newer'] === true && flags.refresh !== true) {
    throw new SidekicksError('cli-executor models --adopt-newer requires --refresh', EXIT_VALIDATION);
  }
  let refreshed = null;
  if (flags.refresh === true) {
    refreshed = await refreshCapabilities(repoRoot, requested, rootScope);
  }

  // At root there is no overlay to compose. Keep the persisted v3 document here rather than the
  // v2-shaped effective facade, because adoption writes model_catalog and bindings to this layer.
  const rootLayer = rootScope || scopeLabel === 'sidekicks (root)';
  let registry = rootLayer
    ? readRegistry(path) : readEffectiveRegistry(repoRoot, settings);
  let effective = rootLayer ? effectiveExecutors(registry) : registry.executors;
  const names = Object.keys(effective).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const selected = requested.length ? names.filter((name) => requested.includes(name)) : names;

  const unknown = requested.filter((name) => !names.includes(name));
  if (unknown.length) {
    throw new SidekicksError(
      `cli-executor models: unknown executor(s): ${unknown.join(', ')} — see 'sidekicks cli-executor list'`,
      EXIT_VALIDATION,
    );
  }

  let adopted = [];
  if (flags['adopt-newer'] === true) {
    // The selected layer is the only one this verb may write. Root scope is the normal shared
    // catalog owner; a project override is already materialised by readEffectiveRegistry.
    adopted = adoptNewerModels(registry, refreshed.candidate, selected);
    if (adopted.length) {
      writeRegistry(path, registry, repoRoot);
      effective = rootLayer ? effectiveExecutors(registry) : registry.executors;
    }
  }

  const drift = [];
  const executors = selected.map((name) => {
    const spec = effective[name];
    const statuses = selectionStatus(spec);
    const caps = spec.capabilities || null;
    for (const tier of MODEL_TIERS) {
      if (statuses[tier] !== 'stale') continue;
      drift.push({
        executor: name,
        tier,
        reason: `selected model '${spec.models[tier]}' is absent from a complete catalog (or its effort is unsupported)`,
      });
    }
    if (caps && caps.status === 'unavailable') {
      drift.push({ executor: name, tier: null, reason: 'capability discovery reported the CLI unavailable' });
    }
    return {
      name,
      enabled: spec.enabled !== false,
      capabilities: caps
        ? {
          status: caps.status,
          cli_version: caps.cli_version || null,
          discovered_at: caps.discovered_at || null,
          source: caps.source?.kind || null,
          model_count: Array.isArray(caps.models) ? caps.models.length : 0,
        }
        : null,
      tiers: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, {
        model: spec.models?.[tier] || null,
        effort: spec.efforts?.[tier] || null,
        status: statuses[tier],
      }])),
      unbound: unboundModels(spec),
    };
  });

  const exitCode = drift.length ? EXIT_VALIDATION : EXIT_OK;

  if (flags.json === true) {
    const payload = { target: pathRel, scope: scopeLabel,
      refreshed: refreshed ? { diff: refreshed.diff } : null, adopted, executors, drift };
    return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode };
  }

  const pad = (value, width) => String(value).padEnd(width);
  const lines = [`cli-executor model tiers — scope: ${scopeLabel} (${pathRel})`, ''];
  if (refreshed) {
    lines.push(`  refreshed capability snapshots: ${refreshed.diff.map((d) => `${d.executor} +${d.added.length}/-${d.removed.length} (${d.status})`).join(', ')}`);
    lines.push('  (a refresh updates the CATALOG only; --adopt-newer is the explicit tier-update request)');
    lines.push('');
  }
  if (adopted.length) {
    lines.push(`  adopted newer models: ${adopted.map((row) => `${row.executor}.${row.tier} ${row.from} → ${row.to}`).join(', ')}`);
    lines.push('  (the replaced references remain in model_catalog as parked history)');
    lines.push('');
  }
  for (const row of executors) {
    const caps = row.capabilities;
    const header = caps
      ? `catalog: ${caps.status}  ${caps.model_count} model(s)  cli ${caps.cli_version || '(unknown)'}  discovered ${caps.discovered_at || '(unknown)'}  via ${caps.source || '(unknown)'}`
      : `catalog: none yet — run \`sidekicks cli-executor models ${row.name} --refresh\``;
    lines.push(`  ${pad(row.name, 14)}${row.enabled ? '' : '(disabled)  '}${header}`);
    for (const tier of MODEL_TIERS) {
      const entry = row.tiers[tier];
      const effort = entry.effort ? ` effort=${entry.effort}` : '';
      lines.push(`    ${pad(tier, 7)}${pad(entry.model ? entry.model + effort : '(unmapped)', 34)}${entry.status.toUpperCase() === 'STALE' ? 'STALE — not in catalog' : entry.status}`);
    }
    if (row.unbound.length) {
      lines.push(`    unbound catalog models (${row.unbound.length}) — the tier is yours to pick; nothing in a catalog row implies one:`);
      for (const model of row.unbound) {
        const efforts = model.supported_efforts.length ? `  efforts: ${model.supported_efforts.join(', ')}` : '';
        const display = model.display_name !== model.id ? `  (${model.display_name})` : '';
        lines.push(`      ${pad(model.id, 32)}${display}${efforts}`);
      }
      lines.push(`      bind one:  sidekicks cli-executor register ${row.name} --model-<tier> <id>`);
    }
    lines.push('');
  }
  if (drift.length) {
    lines.push('  drift:');
    for (const item of drift) {
      lines.push(`    ${item.executor}${item.tier ? ` ${item.tier}` : ''}: ${item.reason}`);
    }
    lines.push('');
  }
  lines.push(`Tiers are ${MODEL_TIERS.join(' | ')} — 'top' is the Fable/Mythos-class rung, mapped only where the CLI truly offers one.`);
  lines.push(`Set one:  sidekicks cli-executor register <name> --model-<tier> <id>   (empty value clears that tier)`);

  return { stdout: lines.join('\n') + '\n', exitCode };
}
