// lib/cli-executor-lifecycle/preset.mjs
// `sidekicks cli-executor preset <list|show|set|remove|default>` — CRUD for named orchestration
// presets, plus the scope's `default_preset` pointer.
//
// A preset pins the host CLI plus one executor + model tier + optional reasoning effort per
// goal-engine role, so `goal plan --preset <name>` routes every phase deterministically instead of
// re-resolving a seat at each dispatch. The store and the resolver live in presets.mjs; this file
// is the operator surface over them.
//
// A ROLE IS ONE PACKED VALUE, not three flags. `--planner codex:high:medium` reads as a seat, and
// there is no half-set state where a tier has been changed but its executor has not:
//
//   sidekicks cli-executor preset set codex-build-claude-review --host-cli codex \
//     --planner codex:high:high --implementer codex:mid:medium --reviewer claude:high:high
//   sidekicks cli-executor preset show codex-build-claude-review --json
//   sidekicks cli-executor preset set codex-build-claude-review --final-verifier ''   # clear a seat
//   sidekicks cli-executor preset remove codex-build-claude-review
//   sidekicks cli-executor preset pin [<name>...] [--repin]      # pin models + add advisor to older presets
//   sidekicks cli-executor preset default codex-build-claude-review   # what `goal plan` picks up
//   sidekicks cli-executor preset default --clear                     # back to per-run routing
//
// `default` always reads and writes the ROOT layer, whatever project is active: the default is the
// repo's house routing answer, and a per-project one would make a bare `goal plan` route by
// whichever project happened to be active.
//
// `set` carries forward every field it is not given (the `register` convention) and REFUSES to
// write a preset the live registry cannot honour — an invalid seat arrangement never reaches disk.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { read } from '../settings-store/settings.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { effectiveExecutors, readEffectiveRegistry, parseFlags, MODEL_TIERS, currentHostContext, routingPolicy } from './_shared.mjs';
import { invokeExecutor } from './invoke.mjs';
import { profileFor } from './profiles.mjs';
import { ADVICE_PURPOSES, RECOVERY_ADVICE_SCHEMA, validateRecoveryAdvice,
  validateRecoveryFacts } from './advice.mjs';
import {
  PRESET_ROLES,
  PRESET_SCHEMA_VERSION,
  readPresets,
  readEffectivePresets,
  resolveDefaultPreset,
  resolveDefaultPresetForHost,
  resolveAdvisorSeat,
  advisorFallbackSeat,
  checkSeat,
  resolvePresetPath,
  writePresets,
  validatePreset,
  resolvePresetSnapshot,
  FALLBACK_MODES,
  GOAL_ROLE_OF,
  defaultAdvisorDeclaration,
  pinSeatModel,
} from './presets.mjs';

// The dispatcher's non-strict parseArgs leaks a space-form flag VALUE (`--planner codex:high`) into
// the positional list, so `args.rest` would carry 'codex:high' as if it were a preset name. Re-derive
// the true positionals from raw argv with the same consumption rule parseFlags applies. Same reason,
// same shape as route.mjs — a verb taking both positionals and valued flags needs it.
const GLOBAL_BOOLEANS = ['verbose', 'help', 'version', 'json', 'root', 'clear', 'no-preset', 'allow-same-family-review', 'no-allow-same-family-review', 'repin'];
function cleanPositionals(argv) {
  const boolSet = new Set(GLOBAL_BOOLEANS);
  const out = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (!body.includes('=') && !boolSet.has(body)) {
        const next = list[i + 1];
        if (next !== undefined && !next.startsWith('--')) i++; // the flag's value token
      }
      continue;
    }
    out.push(tok);
  }
  return out;
}

const NO_TOP_ADVISOR = 'no registered executor maps a top tier for the read-only advisor';

/** `--planner` ↔ `planner`, `--final-verifier` ↔ `final_verifier`. */
const ROLE_FLAGS = Object.freeze({
  planner: 'planner',
  implementer: 'implementer',
  reviewer: 'reviewer',
  'final-verifier': 'final_verifier',
  advisor: 'advisor',
});

const ADVICE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { advice: { type: 'string', minLength: 1 } },
  required: ['advice'],
});

/** Apply the same answer contract to every attempt, including a fallback seat. */
function checkAdvice(result, transport) {
  if (!result.ok) return result;
  const answer = transport === 'none'
    ? (typeof result.result === 'string' ? result.result : result.result_text ?? result.stdout)
    : result.result?.advice;
  if (typeof answer === 'string' && answer.trim()) return result;
  return { ...result, ok: false, failure_kind: 'invalid-output',
    parse_error: 'advisory output must contain non-empty advice' };
}

/**
 * Parse one packed seat value: `<executor>:<tier>[:<effort>]`.
 * An EMPTY value means "clear this seat" and is returned as null, so `--final-verifier ''` drops
 * the optional seat back to inheriting the reviewer.
 */
function parseSeatFlag(flag, value) {
  if (value === '' || value === true) return null;
  const parts = String(value).split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) {
    throw new SidekicksError(
      `cli-executor preset: --${flag} takes <executor>:<tier>[:<effort>] — got '${value}'`,
      EXIT_VALIDATION
    );
  }
  const [executor, model_tier, effort] = parts;
  if (!MODEL_TIERS.includes(model_tier)) {
    throw new SidekicksError(
      `cli-executor preset: --${flag} tier '${model_tier}' must be one of ${MODEL_TIERS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const seat = { executor, model_tier };
  if (effort) seat.effort = effort;
  return seat;
}

/** Render one resolved seat as a single line. */
function renderSeat(roleName, seat) {
  const effort = seat.effort ? `${seat.effort} (${seat.effort_source})` : `none (${seat.effort_source})`;
  const inherited = (seat.inherited ? '  [inherited from reviewer]' : '')
    + (seat.model_source === 'preset-pin' ? '  [pinned model]' : '');
  return `  ${roleName.padEnd(15)} ${seat.executor} · ${seat.tier} · ${seat.model} · effort ${effort}`
    + `  [family ${seat.family || 'unknown'}, catalog ${seat.catalog}]${inherited}`;
}

/** Render a stored declaration (never resolved — `show` must work when resolution fails). */
function renderDeclaration(name, preset) {
  const lines = [`preset '${name}':`];
  if (preset.host_cli) lines.push(`  host_cli        ${preset.host_cli}`);
  for (const roleName of PRESET_ROLES) {
    const seat = preset[roleName];
    if (!seat) continue;
    const effort = seat.effort ? `:${seat.effort}` : '';
    const model = seat.model ? `  (${seat.model})` : '';
    lines.push(`  ${roleName.padEnd(15)} ${seat.executor}:${seat.model_tier}${effort}${model}`);
  }
  lines.push(`  allow_same_family_review  ${preset.allow_same_family_review === true}`);
  const fallback = preset.fallback ?? { mode: 'default-routing', max_role_fallbacks: 1 };
  lines.push(`  fallback        ${fallback.mode} (max ${fallback.max_role_fallbacks} per role attempt)`);
  return lines;
}

/**
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name?: string, rest?: string[] }} _args - unused; positionals are re-derived from argv
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 */
export async function run(ctx, _args) {
  const { repoRoot } = ctx;
  const positionals = cleanPositionals(ctx.argv);
  const action = positionals[2] || 'list';
  const presetName = positionals[3];

  const flags = parseFlags(ctx.argv, ['root', 'json', 'clear', 'no-preset', 'allow-same-family-review', 'no-allow-same-family-review', 'repin']);
  const settings = read(repoRoot);
  const layer = resolvePresetPath(repoRoot, settings, { root: flags.root === true });
  const registry = readEffectiveRegistry(repoRoot, settings);
  const executors = effectiveExecutors(registry);

  // Resolve returns a concrete binding without dispatch. Advise uses that same binding and returns
  // its result without writing run state.
  if (action === 'resolve' || action === 'advise') {
    const role = String(flags.role || 'advisor').replace(/-/g, '_');
    if (!PRESET_ROLES.includes(role)) throw new SidekicksError(`cli-executor preset resolve: unknown role '${role}'`, EXIT_VALIDATION);
    if (action === 'advise' && role !== 'advisor') throw new SidekicksError('cli-executor preset advise only supports advisor', EXIT_VALIDATION);
    if (flags['no-preset'] && flags.preset) throw new SidekicksError('cli-executor preset resolve: --preset and --no-preset conflict', EXIT_VALIDATION);
    const host = currentHostContext(flags['host-cli'] === true ? '' : flags['host-cli']);
    // Queue items can name their own executor/tier. Freeze that exact binding through the same
    // registry predicate as a preset seat, before their combined preview is approved.
    if (action === 'resolve' && flags.executor) {
      const tier = String(flags.tier || '');
      if (!MODEL_TIERS.includes(tier)) throw new SidekicksError('cli-executor preset resolve: --executor requires --tier', EXIT_VALIDATION);
      const goalRole = role === 'advisor' ? 'plan' : ({ planner: 'plan', implementer: 'implement',
        reviewer: 'review', final_verifier: 'final-verify' })[role];
      if (role === 'advisor' && tier !== 'top') throw new SidekicksError('cli-executor preset resolve: advisor requires top', EXIT_VALIDATION);
      const checked = checkSeat({ executors, executor: String(flags.executor), goalRole, tier,
        effort: flags.effort === undefined ? null : String(flags.effort) });
      if (!checked.ok) throw new SidekicksError(`cli-executor preset resolve: ${checked.reason}`, EXIT_VALIDATION);
      const seat = checked.seat;
      return { stdout: JSON.stringify({ role, source: 'item_override', preset: null,
        host_context: host, executor: seat.executor, model_tier: seat.tier, model: seat.model,
        invoke_id: seat.invoke_id, effort: seat.effort, effort_source: seat.effort_source,
        family: seat.family, containment: role === 'advisor' ? 'read-only' : null,
        execution_role: goalRole, selection_trail: [{ executor: seat.executor, eligible: true, reason: null }],
        fallback_policy: { mode: 'default-routing', max_role_fallbacks: 1 } }, null, 2) + '\n',
        exitCode: EXIT_OK };
    }
    const effective = readEffectivePresets(repoRoot, settings, { rootOnly: flags.root === true });
    const selected = flags['no-preset'] ? null : (flags.preset
      ? { name: String(flags.preset), source: 'explicit_preset' }
      : resolveDefaultPresetForHost(effective, host.host_cli));
    if (selected && !effective.presets[selected.name]) throw new SidekicksError(`cli-executor preset resolve: unknown preset '${selected.name}'`, EXIT_VALIDATION);
    const prefer = routingPolicy(registry);
    const snapshot = selected && !(role === 'advisor' && flags.advisor !== undefined)
      ? resolvePresetSnapshot({ name: selected.name, preset: effective.presets[selected.name],
        executors, hostCli: host.host_cli, prefer }) : null;
    let source = selected?.source || null;
    let seat = snapshot?.roles?.[role] ?? null;
    if (role === 'advisor') {
      if (flags.advisor !== undefined) {
        const declaration = parseSeatFlag('advisor', flags.advisor);
        if (!declaration) throw new SidekicksError('cli-executor preset resolve: --advisor needs <executor>:top', EXIT_VALIDATION);
        seat = resolveAdvisorSeat({ executors, declaration, hostCli: host.host_cli, prefer });
        source = 'advisor_override';
      } else if (!seat) {
        seat = resolveAdvisorSeat({ executors, hostCli: host.host_cli, prefer });
        source = 'neutral_auto';
      }
    }
    if (!seat) throw new SidekicksError(`cli-executor preset resolve: no ${role} seat is selected`, EXIT_VALIDATION);
    const payload = { role, purpose: role === 'advisor' ? String(flags.purpose || 'plan-advice') : null,
      source, preset: selected?.name || null, host_context: host,
      executor: seat.executor, model_tier: seat.tier, model: seat.model,
      invoke_id: seat.invoke_id, effort: seat.effort, effort_source: seat.effort_source,
      family: seat.family, containment: role === 'advisor' ? 'read-only' : null,
      execution_role: role === 'advisor' ? 'plan' : seat.role,
      selection_trail: seat.selection_trail || [{ executor: seat.executor, eligible: true, reason: null }],
      fallback_policy: snapshot?.fallback ?? effective.presets[selected?.name]?.fallback
        ?? { mode: 'default-routing', max_role_fallbacks: 1 } };
    if (role === 'advisor' && !ADVICE_PURPOSES.includes(payload.purpose)) {
      throw new SidekicksError(`cli-executor preset resolve: purpose must be ${ADVICE_PURPOSES.join(', ')}`, EXIT_VALIDATION);
    }
    if (action === 'resolve') return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
    let prompt = flags['prompt-file'] ? readFileSync(String(flags['prompt-file']), 'utf8') : String(flags.prompt || '');
    if (!prompt.trim()) throw new SidekicksError('cli-executor preset advise needs --prompt or --prompt-file', EXIT_VALIDATION);
    const facts = payload.purpose === 'recovery-advice'
      ? JSON.parse(flags['failure-facts'] ? String(flags['failure-facts'])
        : (flags['failure-facts-file'] ? readFileSync(String(flags['failure-facts-file']), 'utf8') : '{}')) : null;
    if (facts && !validateRecoveryFacts(facts)) {
      throw new SidekicksError('cli-executor preset advise: recovery-advice needs typed failure facts with artifact_refs', EXIT_VALIDATION);
    }
    if (facts) prompt += `\n\nStructured failure facts (cite only these artifact_refs):\n${JSON.stringify(facts, null, 2)}\n`;
    const schemaJson = JSON.stringify(facts ? RECOVERY_ADVICE_SCHEMA : ADVICE_SCHEMA);
    let schemaDir;
    let schemaPath;
    const invokeAdvice = async (binding) => {
      const name = binding.executor;
      const spec = executors[name];
      const transport = profileFor(name, spec).schema;
      if (transport === 'file' && !schemaPath) {
        schemaDir = mkdtempSync(join(tmpdir(), 'sidekicks-preset-advice-'));
        schemaPath = join(schemaDir, 'output.schema.json');
        writeFileSync(schemaPath, `${schemaJson}\n`, 'utf8');
      }
      const result = await invokeExecutor({ name, spec, role: 'plan', tier: 'top', prompt,
        cwd: repoRoot, model: binding.model, invokeId: binding.invoke_id,
        effort: binding.effort,
        ...(transport === 'file' ? { schemaPath } : {}),
        ...(transport === 'inline' ? { schemaJson } : {}) });
      // The file is ephemeral; do not return its machine-local path in recorded argv.
      if (schemaPath && Array.isArray(result.args)) {
        result.args = result.args.map((arg) => arg === schemaPath ? '<temporary-output-schema>' : arg);
      }
      if (!facts) return checkAdvice(result, transport);
      if (!result.ok) return result;
      let answer = result.result;
      if (!answer && typeof result.result_text === 'string') {
        try { answer = JSON.parse(result.result_text); } catch { /* invalid output below */ }
      }
      const check = validateRecoveryAdvice(answer, facts.artifact_refs);
      return check.ok ? { ...result, result: answer }
        : { ...result, ok: false, failure_kind: 'invalid-output', parse_error: check.reason };
    };
    try {
      let result = await invokeAdvice(payload);
      if (!result.ok && payload.fallback_policy.mode === 'default-routing'
          && payload.fallback_policy.max_role_fallbacks > 0) {
        const primary = payload.executor;
        try {
          const fallback = advisorFallbackSeat({ executors, failedExecutor: primary,
            hostCli: host.host_cli, prefer, policy: payload.fallback_policy });
          payload.fallback = { primary, actual: fallback.executor, reason: result.failure_kind || 'failed',
            policy: 'bounded-one-retry' };
          payload.selection_trail = [...payload.selection_trail, ...fallback.selection_trail];
          payload.executor = fallback.executor;
          payload.model = fallback.model;
          payload.invoke_id = fallback.invoke_id;
          payload.effort = fallback.effort;
          payload.effort_source = fallback.effort_source;
          payload.family = fallback.family;
          result = await invokeAdvice(fallback);
        } catch (err) {
          payload.fallback = { primary, actual: null, reason: err.message, policy: 'exhausted' };
        }
      }
      return { stdout: JSON.stringify({ routing: payload, result }, null, 2) + '\n',
        exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
    } finally {
      if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
    }
  }

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const effective = readEffectivePresets(repoRoot, settings, { rootOnly: flags.root === true });
    const names = Object.keys(effective.presets).sort();
    if (flags.json === true) {
      const payload = {
        path: layer.pathRel,
        scope: layer.scopeLabel,
        schema_version: effective.schema_version,
        default_preset: effective.default_preset ?? null,
        host_default_presets: effective.host_default_presets ?? null,
        seats: effective.seats,
        compact_presets: effective.compact_presets,
        presets: effective.presets,
        provenance: effective.provenance,
      };
      return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
    }
    if (!names.length) {
      return {
        stdout: `no orchestration presets declared (${layer.pathRel}).\n`
          + `  Declare one:  sidekicks cli-executor preset set <name> --planner <exec>:<tier> `
          + `--implementer <exec>:<tier> --reviewer <exec>:<tier>\n`,
        exitCode: EXIT_OK,
      };
    }
    const lines = [`orchestration presets (${layer.pathRel}):`];
    for (const name of names) {
      const source = effective.provenance.presets[name]?.source ?? 'root';
      const preset = effective.presets[name];
      const seats = PRESET_ROLES
        .filter((role) => preset[role])
        .map((role) => `${role}=${preset[role].executor}:${preset[role].model_tier}`
          + (preset[role].model ? `(${preset[role].model})` : ''))
        .join('  ');
      const isDefault = effective.default_preset === name ? '  ← default' : '';
      lines.push(`  ${name}  [${source}]  ${seats}${isDefault}`);
    }
    lines.push('');
    lines.push(effective.default_preset
      ? `default_preset  ${effective.default_preset}`
        + `  [${effective.provenance.default_preset?.source ?? 'root'}]`
        + '  — bound by `goal plan` when no --preset is given (--no-preset declines it)'
      : 'default_preset  none — `goal plan` resolves each seat per run unless --preset is given');
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  // ── default ───────────────────────────────────────────────────────────────
  // Reading, setting and clearing the ROOT layer's `default_preset`. Setting one is gated the same
  // way `set` is — the name must be declared AND resolve — because a default that cannot run is a
  // failure every future `goal plan` inherits.
  if (action === 'default') {
    // Root-only by construction: `--root` is redundant here rather than required, and an active
    // project never gets a competing copy of the key.
    const rootLayer = resolvePresetPath(repoRoot, settings, { root: true });
    const effective = readEffectivePresets(repoRoot, settings, { rootOnly: flags.root === true });
    const clearing = flags.clear === true;

    if (!presetName && !clearing) {
      const current = effective.default_preset || null;
      if (flags.json === true) {
        return {
          stdout: JSON.stringify({
            path: rootLayer.pathRel,
            scope: 'root (default_preset is root-only)',
            default_preset: current,
            source: current ? 'root' : null,
            declared: current ? (effective.presets[current] ?? null) : null,
          }, null, 2) + '\n',
          exitCode: EXIT_OK,
        };
      }
      if (!current) {
        return {
          stdout: `no default preset (${rootLayer.pathRel}).\n`
            + '  Set one:  sidekicks cli-executor preset default <name>\n',
          exitCode: EXIT_OK,
        };
      }
      // Surfaces a dangling default here rather than at the next `goal plan`.
      resolveDefaultPreset(effective);
      return {
        stdout: `default preset '${current}' [root] (${rootLayer.pathRel})\n`
          + '  `goal plan` binds it when no --preset is given; --no-preset declines it.\n',
        exitCode: EXIT_OK,
      };
    }

    const doc = readPresets(rootLayer.path, { layer: 'root' });
    if (clearing) {
      if (presetName) {
        throw new SidekicksError(
          'cli-executor preset default: --clear takes no preset name',
          EXIT_VALIDATION
        );
      }
      delete doc.default_preset;
      writePresets(rootLayer.path, doc, repoRoot);
      return { stdout: `cleared the default preset in ${rootLayer.pathRel}\n`, exitCode: EXIT_OK };
    }

    const declared = effective.presets[presetName];
    if (!declared) {
      const known = Object.keys(effective.presets).sort();
      throw new SidekicksError(
        `cli-executor preset default: unknown preset '${presetName}'`
        + (known.length ? ` — declared presets: ${known.join(', ')}` : ' — none are declared in this scope'),
        EXIT_VALIDATION
      );
    }
    resolvePresetSnapshot({ name: presetName, preset: declared, executors });
    doc.default_preset = presetName;
    writePresets(rootLayer.path, doc, repoRoot);
    if (flags.json === true) {
      return {
        stdout: JSON.stringify({ default_preset: presetName, path: rootLayer.pathRel }, null, 2) + '\n',
        exitCode: EXIT_OK,
      };
    }
    return {
      stdout: `default preset is now '${presetName}' (${rootLayer.pathRel}, root-level)\n`
        + `  Every 'sidekicks goal plan "<goal>"' binds it unless --preset or --no-preset says otherwise.\n`,
      exitCode: EXIT_OK,
    };
  }

  if (action === 'host-default') {
    const host = presetName;
    const target = positionals[4];
    const rootLayer = resolvePresetPath(repoRoot, settings, { root: true });
    const effective = readEffectivePresets(repoRoot, settings);
    if (!host) {
      return { stdout: JSON.stringify({ host_default_presets: effective.host_default_presets ?? null,
        legacy_default: effective.default_preset ?? null, path: rootLayer.pathRel }, null, 2) + '\n', exitCode: EXIT_OK };
    }
    if (flags.clear === true || target === '--clear') {
      const doc = readPresets(rootLayer.path, { layer: 'root' });
      doc.schema_version = PRESET_SCHEMA_VERSION;
      doc.host_default_presets = { ...(doc.host_default_presets || {}) };
      delete doc.host_default_presets[host];
      writePresets(rootLayer.path, doc, repoRoot);
      return { stdout: `cleared host default for '${host}' (${rootLayer.pathRel})\n`, exitCode: EXIT_OK };
    }
    if (!target) throw new SidekicksError('cli-executor preset host-default: use <host> <preset|--clear>', EXIT_VALIDATION);
    const declared = effective.presets[target];
    if (!declared || declared.host_cli !== host) throw new SidekicksError(
      `cli-executor preset host-default: '${target}' must be an effective preset declared for host '${host}'`, EXIT_VALIDATION);
    resolvePresetSnapshot({ name: target, preset: declared, executors });
    const doc = readPresets(rootLayer.path, { layer: 'root' });
    doc.schema_version = PRESET_SCHEMA_VERSION;
    doc.host_default_presets = { ...(doc.host_default_presets || {}), [host]: target };
    writePresets(rootLayer.path, doc, repoRoot);
    return { stdout: JSON.stringify({ host, preset: target, path: rootLayer.pathRel }, null, 2) + '\n', exitCode: EXIT_OK };
  }

  if (action === 'migrate') {
    if (layer.scopeLabel !== 'sidekicks (root)') throw new SidekicksError('cli-executor preset migrate: run this at the root scope', EXIT_VALIDATION);
    const doc = readPresets(layer.path, { layer: 'root' });
    const completeCompact = Object.keys(doc.presets).filter((name) => doc.presets[name] !== null)
      .every((name) => Object.prototype.hasOwnProperty.call(doc.compact_presets || {}, name));
    if (doc.schema_version >= PRESET_SCHEMA_VERSION && doc.seats && Object.keys(doc.seats).length && completeCompact) {
      return { stdout: `presets already use schema v${doc.schema_version}\n`, exitCode: EXIT_OK };
    }
    const source = readFileSync(layer.path, 'utf8');
    const raw = JSON.parse(source);
    const seats = {};
    const tupleToSeat = new Map();
    const compact = {};
    for (const [name, preset] of Object.entries(doc.presets)) {
      if (!preset) { compact[name] = null; continue; }
      const roles = {};
      for (const role of PRESET_ROLES) {
        const tuple = preset[role];
        if (!tuple) continue;
        const key = JSON.stringify(tuple);
        let seatName = tupleToSeat.get(key);
        if (!seatName) {
          const stem = `${tuple.executor}-${tuple.model_tier}${tuple.effort ? `-${tuple.effort}` : ''}`.replace(/[^a-z0-9._-]/g, '-');
          seatName = stem; let suffix = 2;
          while (seats[seatName] && JSON.stringify(seats[seatName]) !== key) seatName = `${stem}-${suffix++}`;
          seats[seatName] = tuple; tupleToSeat.set(key, seatName);
        }
        roles[role] = seatName;
      }
      const { planner, implementer, reviewer, final_verifier, advisor, ...meta } = preset;
      compact[name] = { ...meta, roles };
    }
    // Verify migration expansion against every v1 source preset before any config write.
    for (const [name, preset] of Object.entries(doc.presets)) {
      if (!preset) continue;
      const expanded = {};
      for (const [role, seatName] of Object.entries(compact[name].roles)) expanded[role] = seats[seatName];
      for (const key of Object.keys(preset)) {
        if (PRESET_ROLES.includes(key)) continue;
        expanded[key] = preset[key];
      }
      if (!isDeepStrictEqual(expanded, preset)) throw new SidekicksError(`cli-executor preset migrate: '${name}' did not round-trip`, EXIT_VALIDATION);
    }
    const hostDefaults = {};
    for (const [host, presetName] of [['codex', 'codex-agy-build-codex-review'], ['claude', 'claude-agy-build-claude-review']]) {
      if (doc.presets[presetName]?.host_cli === host) hostDefaults[host] = presetName;
    }
    const payload = { schema_version: PRESET_SCHEMA_VERSION, default_preset: raw.default_preset ?? null,
      host_default_presets: hostDefaults, seats, presets: compact };
    writePresets(layer.path, payload, repoRoot);
    return { stdout: `migrated ${Object.keys(compact).length} presets into ${Object.keys(seats).length} reusable seats (${layer.pathRel})\n`, exitCode: EXIT_OK };
  }

  // ── pin ───────────────────────────────────────────────────────────────────
  // Backfill for presets written before `set` pinned models: give every preset in this layer (or
  // only the named ones) a top-tier advisor and pin each seat to the exact versioned model its tier
  // maps in the live registry. `--repin` refreshes existing pins after a deliberate tier remap. A
  // seat the registry cannot resolve is reported and left as it is, never guessed.
  if (action === 'pin') {
    const doc = readPresets(layer.path, { layer: layer.scopeLabel === 'sidekicks (root)' ? 'root' : 'project' });
    const wanted = positionals.slice(3);
    for (const name of wanted) {
      if (!doc.presets[name]) {
        throw new SidekicksError(`cli-executor preset pin: '${name}' is not declared in ${layer.pathRel}`, EXIT_VALIDATION);
      }
    }
    const names = wanted.length ? wanted : Object.keys(doc.presets).filter((name) => doc.presets[name]).sort();
    const repin = flags.repin === true;
    const seats = { ...(doc.seats || {}) };
    const compact = { ...(doc.compact_presets || {}) };
    const presets = { ...doc.presets };
    const changes = [];
    const skipped = [];
    const settled = new Set();
    const pinInline = (name, role, seat) => {
      const result = pinSeatModel({ executors, seat, goalRole: GOAL_ROLE_OF[role], repin });
      if (result.reason) skipped.push({ preset: name, role, reason: result.reason });
      else if (result.changed) changes.push({ preset: name, role, model: result.seat.model });
      return result.seat;
    };
    const advisorSeatName = (advisor) => {
      const same = Object.keys(seats).find((key) => isDeepStrictEqual(seats[key], advisor));
      if (same) return same;
      const stem = `${advisor.executor}-top`;
      let seatName = stem;
      for (let suffix = 2; seats[seatName]; suffix++) seatName = `${stem}-${suffix}`;
      seats[seatName] = advisor;
      return seatName;
    };
    for (const name of names) {
      const declaration = compact[name];
      if (!declaration) {
        const next = { ...presets[name] };
        for (const role of PRESET_ROLES) if (next[role]) next[role] = pinInline(name, role, next[role]);
        if (!next.advisor) {
          const advisor = defaultAdvisorDeclaration({ executors, hostCli: next.host_cli || '' });
          if (!advisor) skipped.push({ preset: name, role: 'advisor', reason: NO_TOP_ADVISOR });
          else {
            next.advisor = advisor;
            changes.push({ preset: name, role: 'advisor', model: advisor.model ?? null, added: true });
          }
        }
        presets[name] = validatePreset(name, next);
        continue;
      }
      const next = { ...declaration, roles: { ...declaration.roles } };
      for (const role of PRESET_ROLES) {
        const seatName = next.roles[role];
        if (!seatName) {
          if (next[role]) next[role] = pinInline(name, role, next[role]);
          continue;
        }
        if (settled.has(seatName)) continue;
        if (!seats[seatName]) {
          skipped.push({ preset: name, role, seat: seatName, reason: `seat '${seatName}' is inherited from the root layer — pin it there` });
          continue;
        }
        const result = pinSeatModel({ executors, seat: seats[seatName], goalRole: GOAL_ROLE_OF[role], repin });
        if (result.reason) { skipped.push({ preset: name, role, seat: seatName, reason: result.reason }); continue; }
        settled.add(seatName);
        if (result.changed) {
          seats[seatName] = result.seat;
          changes.push({ preset: name, role, seat: seatName, model: result.seat.model });
        }
      }
      if (!next.roles.advisor && !next.advisor) {
        const advisor = defaultAdvisorDeclaration({ executors, hostCli: next.host_cli || '' });
        if (!advisor) skipped.push({ preset: name, role: 'advisor', reason: NO_TOP_ADVISOR });
        else {
          next.roles.advisor = advisorSeatName(advisor);
          settled.add(next.roles.advisor);
          changes.push({ preset: name, role: 'advisor', seat: next.roles.advisor, model: advisor.model ?? null, added: true });
        }
      }
      compact[name] = next;
    }
    // Validate every compact declaration against the pinned seat map before anything is written:
    // a seat is shared, so one pin can reach presets that were not named on this call.
    for (const [name, declaration] of Object.entries(compact)) {
      if (!declaration) continue;
      const { roles, ...expanded } = declaration;
      for (const [role, seatName] of Object.entries(roles || {})) {
        const seat = seats[seatName] ?? doc.presets[name]?.[role];
        if (!seat) throw new SidekicksError(`cli-executor preset pin: '${name}' references missing seat '${seatName}'`, EXIT_VALIDATION);
        expanded[role] = seat;
      }
      presets[name] = validatePreset(name, expanded);
    }
    if (changes.length) {
      const nextDoc = { ...doc, seats, presets, compact_presets: compact };
      Object.defineProperty(nextDoc, 'passthrough', { value: doc.passthrough || {}, enumerable: false });
      writePresets(layer.path, nextDoc, repoRoot, { expectedRevision: doc.revision });
    }
    if (flags.json === true) {
      return { stdout: JSON.stringify({ path: layer.pathRel, written: changes.length > 0, changes, skipped }, null, 2) + '\n',
        exitCode: EXIT_OK };
    }
    const lines = [changes.length
      ? `pinned ${changes.length} seat(s) in ${layer.pathRel}:`
      : `every preset seat in ${layer.pathRel} is already pinned and advised`];
    for (const change of changes) {
      lines.push(`  ${change.preset.padEnd(36)} ${change.role.padEnd(15)} ${change.added ? 'added ' : ''}`
        + `${change.model ?? 'auto:top'}${change.seat ? `  [seat ${change.seat}]` : ''}`);
    }
    if (skipped.length) {
      lines.push('left unpinned (the registry cannot resolve them):');
      for (const skip of skipped) lines.push(`  ${skip.preset.padEnd(36)} ${skip.role.padEnd(15)} ${skip.reason}`);
    }
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  if (!presetName) {
    throw new SidekicksError(`cli-executor preset ${action}: a preset name is required`, EXIT_VALIDATION);
  }


  // ── show ──────────────────────────────────────────────────────────────────
  if (action === 'show') {
    const effective = readEffectivePresets(repoRoot, settings, { rootOnly: flags.root === true });
    const preset = effective.presets[presetName];
    if (!preset) {
      throw new SidekicksError(
        `cli-executor preset show: unknown preset '${presetName}' — see 'sidekicks cli-executor preset list'`,
        EXIT_VALIDATION
      );
    }
    // Resolution may legitimately fail (a model map changed, a CLI was disabled). Report that
    // rather than refusing to show — an operator debugging a broken preset needs to SEE it.
    let snapshot = null;
    let resolveError = null;
    try {
      snapshot = resolvePresetSnapshot({ name: presetName, preset, executors });
    } catch (err) {
      resolveError = err.message;
    }
    if (flags.json === true) {
      const payload = {
        preset: presetName,
        source: effective.provenance.presets[presetName]?.source ?? 'root',
        declared: preset,
        declared_compact: effective.compact_presets?.[presetName] ?? null,
        resolved: snapshot,
        resolve_error: resolveError,
      };
      return { stdout: JSON.stringify(payload, null, 2) + '\n', exitCode: EXIT_OK };
    }
    const lines = renderDeclaration(presetName, preset);
    lines.push('');
    if (snapshot) {
      lines.push('resolved against the current registry:');
      for (const roleName of PRESET_ROLES) {
        const seat = snapshot.roles[roleName];
        if (seat) lines.push(renderSeat(roleName, seat));
      }
    } else {
      lines.push('DOES NOT RESOLVE against the current registry:');
      lines.push(`  ${resolveError}`);
    }
    return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
  }

  // ── remove ────────────────────────────────────────────────────────────────
  if (action === 'remove') {
    const doc = readPresets(layer.path, { layer: layer.scopeLabel === 'sidekicks (root)' ? 'root' : 'project' });
    if (!Object.prototype.hasOwnProperty.call(doc.presets, presetName)) {
      throw new SidekicksError(
        `cli-executor preset remove: '${presetName}' is not declared in ${layer.pathRel}`,
        EXIT_VALIDATION
      );
    }
    delete doc.presets[presetName];
    if (doc.compact_presets) delete doc.compact_presets[presetName];
    // Removing the preset the ROOT layer points at takes the pointer with it — a `default_preset`
    // naming a preset that no longer exists would break every later `goal plan`. Only the root doc
    // can carry the key, so a project removal never finds one here.
    const wasDefault = doc.default_preset === presetName;
    if (wasDefault) delete doc.default_preset;
    writePresets(layer.path, doc, repoRoot);
    return {
      stdout: `removed preset '${presetName}' from ${layer.pathRel}\n`
        + (wasDefault ? '  it was this layer\'s default_preset, so the default is now cleared\n' : ''),
      exitCode: EXIT_OK,
    };
  }

  // ── set ───────────────────────────────────────────────────────────────────
  if (action !== 'set') {
    throw new SidekicksError(
      `cli-executor preset: unknown action '${action}' — use list, show, set, remove, default, host-default, migrate, pin, resolve or advise`,
      EXIT_VALIDATION
    );
  }

  const doc = readPresets(layer.path, { layer: layer.scopeLabel === 'sidekicks (root)' ? 'root' : 'project' });
  // Carry every field forward that this call does not mention — the `register` convention, so a
  // one-seat correction never silently drops the other three.
  const prior = doc.presets[presetName] && typeof doc.presets[presetName] === 'object'
    ? doc.presets[presetName]
    : {};
  const next = { ...prior };

  if (flags['host-cli'] !== undefined) {
    if (flags['host-cli'] === '' || flags['host-cli'] === true) delete next.host_cli;
    else next.host_cli = String(flags['host-cli']);
  }

  for (const [flag, roleName] of Object.entries(ROLE_FLAGS)) {
    if (flags[flag] === undefined) continue;
    const seat = parseSeatFlag(flag, flags[flag]);
    if (seat === null) delete next[roleName];
    else next[roleName] = seat;
  }

  if (flags['allow-same-family-review'] === true) next.allow_same_family_review = true;
  if (flags['no-allow-same-family-review'] === true) next.allow_same_family_review = false;

  if (flags.fallback !== undefined) {
    const mode = flags.fallback === true ? '' : String(flags.fallback);
    if (!FALLBACK_MODES.includes(mode)) {
      throw new SidekicksError(
        `cli-executor preset set: --fallback must be one of ${FALLBACK_MODES.join(', ')}`,
        EXIT_VALIDATION
      );
    }
    next.fallback = { ...(next.fallback ?? {}), mode };
  }
  if (flags['max-role-fallbacks'] !== undefined) {
    const raw = flags['max-role-fallbacks'] === true ? '' : String(flags['max-role-fallbacks']);
    const max = Number(raw);
    if (!Number.isInteger(max) || max < 0) {
      throw new SidekicksError(
        'cli-executor preset set: --max-role-fallbacks must be an integer >= 0',
        EXIT_VALIDATION
      );
    }
    next.fallback = { mode: next.fallback?.mode ?? 'default-routing', max_role_fallbacks: max };
  }

  // Every stored preset carries a top-tier advisor (`--advisor ''` resets it to this default rather
  // than dropping it), and every seat is pinned to the exact versioned model its tier maps right
  // now, so the file says which model runs instead of leaving it to a later tier remap. A seat whose
  // executor cannot be resolved stays unpinned and fails the resolve gate below.
  if (!next.advisor) {
    const advisor = defaultAdvisorDeclaration({ executors, hostCli: next.host_cli || '' });
    if (advisor) next.advisor = advisor;
  }
  for (const roleName of PRESET_ROLES) {
    if (next[roleName]) next[roleName] = pinSeatModel({ executors, seat: next[roleName], goalRole: GOAL_ROLE_OF[roleName] }).seat;
  }

  // Two gates, in order: the declaration must be structurally valid, and it must RESOLVE against
  // the live registry. Writing a preset whose reviewer cannot hold the review role would only defer
  // the failure to the first dispatch, long after the operator stopped watching.
  const declared = validatePreset(presetName, next);
  const snapshot = resolvePresetSnapshot({ name: presetName, preset: declared, executors });

  doc.presets[presetName] = declared;
  if (doc.compact_presets) delete doc.compact_presets[presetName];
  writePresets(layer.path, doc, repoRoot);

  if (flags.json === true) {
    return {
      stdout: JSON.stringify({ preset: presetName, path: layer.pathRel, declared, resolved: snapshot }, null, 2) + '\n',
      exitCode: EXIT_OK,
    };
  }
  const lines = [`wrote preset '${presetName}' to ${layer.pathRel}`];
  if (snapshot.host_cli) lines.push(`  host_cli        ${snapshot.host_cli}`);
  for (const roleName of PRESET_ROLES) {
    const seat = snapshot.roles[roleName];
    if (seat) lines.push(renderSeat(roleName, seat));
  }
  lines.push(`  fallback        ${snapshot.fallback.mode} (max ${snapshot.fallback.max_role_fallbacks} per role attempt)`);
  lines.push(`  Use it:  sidekicks goal plan "<goal>" --preset ${presetName}`);
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
