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
import { EXIT_OK, SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { effectiveExecutors, readEffectiveRegistry, parseFlags, MODEL_TIERS } from './_shared.mjs';
import {
  PRESET_ROLES,
  readPresets,
  readEffectivePresets,
  resolveDefaultPreset,
  resolvePresetPath,
  writePresets,
  validatePreset,
  resolvePresetSnapshot,
  FALLBACK_MODES,
} from './presets.mjs';

// The dispatcher's non-strict parseArgs leaks a space-form flag VALUE (`--planner codex:high`) into
// the positional list, so `args.rest` would carry 'codex:high' as if it were a preset name. Re-derive
// the true positionals from raw argv with the same consumption rule parseFlags applies. Same reason,
// same shape as route.mjs — a verb taking both positionals and valued flags needs it.
const GLOBAL_BOOLEANS = ['verbose', 'help', 'version', 'json', 'root', 'clear', 'allow-same-family-review', 'no-allow-same-family-review'];
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

/** `--planner` ↔ `planner`, `--final-verifier` ↔ `final_verifier`. */
const ROLE_FLAGS = Object.freeze({
  planner: 'planner',
  implementer: 'implementer',
  reviewer: 'reviewer',
  'final-verifier': 'final_verifier',
});

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
  const inherited = seat.inherited ? '  [inherited from reviewer]' : '';
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
    lines.push(`  ${roleName.padEnd(15)} ${seat.executor}:${seat.model_tier}${effort}`);
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

  const flags = parseFlags(ctx.argv, ['root', 'json', 'clear', 'allow-same-family-review', 'no-allow-same-family-review']);
  const settings = read(repoRoot);
  const layer = resolvePresetPath(repoRoot, settings, { root: flags.root === true });
  const executors = effectiveExecutors(readEffectiveRegistry(repoRoot, settings));

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
        .map((role) => `${role}=${preset[role].executor}:${preset[role].model_tier}`)
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
      `cli-executor preset: unknown action '${action}' — use list, show, set, remove or default`,
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

  // Two gates, in order: the declaration must be structurally valid, and it must RESOLVE against
  // the live registry. Writing a preset whose reviewer cannot hold the review role would only defer
  // the failure to the first dispatch, long after the operator stopped watching.
  const declared = validatePreset(presetName, next);
  const snapshot = resolvePresetSnapshot({ name: presetName, preset: declared, executors });

  doc.presets[presetName] = declared;
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
