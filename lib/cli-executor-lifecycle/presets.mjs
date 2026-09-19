// lib/cli-executor-lifecycle/presets.mjs
// Named orchestration presets — the declarative answer to "which CLI, at which tier, with which
// reasoning effort, holds each role for this run".
//
// A preset pins four seats: `planner`, `implementer`, `reviewer` and an optional `final_verifier`
// that inherits the reviewer when absent. The ROOT layer may also name ONE of them `default_preset`,
// the preset `goal plan` binds when the operator passes no `--preset` — a configured house default,
// not a hidden one: the plan states which preset it picked up and `--no-preset` declines it.
//
// `default_preset` is deliberately a ROOT-ONLY setting, unlike the presets themselves: it is the
// repo's house answer to "who runs a goal run here", and a per-project override would mean the same
// bare `goal plan` routes differently depending on which project happens to be active — a routing
// surprise nobody typed. A project file carrying the key is refused on read, not ignored. Selecting one makes routing DETERMINISTIC: the goal
// engine stops re-resolving a seat at every dispatch and instead freezes the fully resolved
// snapshot into the approval envelope, so a preset edited afterwards cannot reach an approved run.
//
// STORAGE — its own scope-resolved JSON file under the CLI write surface (Rule 1):
//   - root project `sidekicks` (default) → `.sidekicks/config/cli-orchestration-presets.json`
//   - user project `<active>`            → `projects/<active>/config/cli-orchestration-presets.json`
//
// WHY A SIBLING FILE RATHER THAN A `presets` BLOCK IN cli-executors.json: `writeRegistry` rebuilds
// its payload from `{schema_version, executors, routing}` only, so any new top-level key there is
// silently dropped by the next `register`/`route`/`sync` write — and the Python mirror
// (scripts/registry.py) would have to learn the key in lockstep to avoid the same loss.
//
// WHAT THIS MODULE IS NOT: it never selects a seat on its own and never relaxes containment. It
// resolves what an operator declared and refuses what the registry cannot honour; role support,
// enforcement gaps and the write-boundary checks remain exactly where they were.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import { SidekicksError, EXIT_VALIDATION, EXIT_IO } from '../sk-cli/errors.mjs';
import { frameworkConfigPath } from '../config-store/paths.mjs';
import { MODEL_TIERS, NAME_RE, catalogStatus } from './_shared.mjs';
import { ROLES, resolveFamily, resolveModel, resolveEffort, roleSupported } from './profiles.mjs';

/** Bumped only for a BREAKING change; additive fields must not bump it (see _shared.mjs). */
export const PRESET_SCHEMA_VERSION = 1;

/** The file basename, also listed in FRAMEWORK_CONFIG_FILES so `config doctor` recognises it. */
export const PRESET_FILE = 'cli-orchestration-presets.json';

/**
 * The four seats, in dispatch order. `final_verifier` is the only optional one — an absent
 * final verifier inherits the resolved reviewer verbatim rather than falling back to a resolver.
 */
export const PRESET_ROLES = Object.freeze(['planner', 'implementer', 'reviewer', 'final_verifier']);
const REQUIRED_ROLES = Object.freeze(['planner', 'implementer', 'reviewer']);

/** Preset seat → the goal-engine role whose containment it must satisfy. */
export const GOAL_ROLE_OF = Object.freeze({
  planner: 'plan',
  implementer: 'implement',
  reviewer: 'review',
  final_verifier: 'final-verify',
});

/** The inverse, for the engine side. `final-verify` maps to the optional seat. */
export const PRESET_ROLE_OF = Object.freeze({
  plan: 'planner',
  implement: 'implementer',
  review: 'reviewer',
  'final-verify': 'final_verifier',
});

/** How a resolved effort was arrived at — recorded so a report can say which branch was taken. */
export const EFFORT_SOURCES = Object.freeze(['explicit-preset', 'executor-tier-map', 'provider-default']);

/** Fallback postures. `none` is the same prohibition `--preset-strict` imposes per run. */
export const FALLBACK_MODES = Object.freeze(['default-routing', 'none']);

const DEFAULT_MAX_ROLE_FALLBACKS = 1;

// A preset name shares the executor charset: it becomes a CLI flag value and appears in a frozen
// envelope, so keep it filesystem- and enum-safe.
const PRESET_NAME_RE = NAME_RE;

/** Convert an absolute path to a repo-relative, forward-slash form (`.` = repo root). */
function toRepoRelative(repoRoot, abs) {
  const rel = relative(repoRoot, abs).replace(/\\/g, '/');
  return rel === '' ? '.' : rel;
}

/**
 * Resolve the preset file for the active scope — the same root/project rule the executor registry
 * uses, so the two always travel together.
 *
 * @param {string} repoRoot
 * @param {object} settings - parsed .sidekicks/settings.json (may be {})
 * @param {{root?: boolean}} [opts]
 * @returns {{ path: string, pathRel: string, scopeLabel: string }}
 */
export function resolvePresetPath(repoRoot, settings, { root = false } = {}) {
  const scope = resolveEffectiveScope(settings);
  const isRoot = root || scope.projectName === 'sidekicks';
  const base = isRoot ? '.sidekicks' : join('projects', scope.projectName);
  const path = frameworkConfigPath(repoRoot, PRESET_FILE, { base });
  return {
    path,
    pathRel: toRepoRelative(repoRoot, path),
    scopeLabel: isRoot ? 'sidekicks (root)' : scope.projectName,
  };
}

/** Resolve both persistent layers. The root layer is always part of an active user project. */
export function resolvePresetLayers(repoRoot, settings) {
  const root = resolvePresetPath(repoRoot, settings, { root: true });
  const active = resolvePresetPath(repoRoot, settings);
  return { root, project: active.scopeLabel === 'sidekicks (root)' ? null : active };
}

/**
 * Read one layer. A MISSING FILE IS NOT AN ERROR — there are no built-in presets, so an absent
 * file simply means "this repo declares none" and every no-preset path keeps working untouched.
 * A malformed file IS an error: losing a declaration silently is worse than failing loudly.
 *
 * @param {string} path
 * @returns {{ schema_version: number, presets: Record<string, object|null> }}
 */
export function readPresets(path, { layer = 'root' } = {}) {
  if (!existsSync(path)) return { schema_version: PRESET_SCHEMA_VERSION, presets: {} };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SidekicksError(`cli-executor: cannot read presets ${path}: ${err.message}`, EXIT_IO);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SidekicksError(
      `cli-executor: presets ${path} is not valid JSON (${err.message}) — fix or remove it`,
      EXIT_VALIDATION
    );
  }
  const version = parsed?.schema_version;
  if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > PRESET_SCHEMA_VERSION)) {
    throw new SidekicksError(
      `cli-executor: presets ${path} has unsupported schema_version '${version}'`,
      EXIT_VALIDATION
    );
  }
  const rawPresets = (parsed && typeof parsed.presets === 'object' && !Array.isArray(parsed.presets) && parsed.presets) || {};
  const presets = {};
  for (const [name, preset] of Object.entries(rawPresets)) {
    // `null` is meaningful in a PROJECT layer (it deletes an inherited preset), so it survives the
    // read and is resolved by the overlay rather than rejected here.
    if (preset === null) { presets[name] = null; continue; }
    presets[name] = validatePreset(name, preset);
  }
  const doc = { schema_version: version ?? PRESET_SCHEMA_VERSION, presets };
  // `default_preset` is the name `goal plan` falls back to when the operator names none — ROOT ONLY.
  // A project layer carrying it is an error rather than a silently ignored key: a setting that looks
  // declared and does nothing is worse than one that is refused where it was written.
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'default_preset')) {
    if (layer !== 'root') {
      throw new SidekicksError(
        `cli-executor: presets ${path} declares 'default_preset', which is a ROOT-level setting `
        + 'only — a per-project default would make a bare `goal plan` route differently depending on '
        + 'the active project.\n  Remove the key here, and set it at the root:  '
        + 'sidekicks cli-executor preset default <name>',
        EXIT_VALIDATION
      );
    }
    doc.default_preset = normalizeDefaultPreset(parsed.default_preset, path);
  }
  // Whether the named preset EXISTS is not asked here: the root layer may name one the project
  // layer declares, and a broken default must not make every unrelated `preset list` fail. The
  // question is answered where it matters, by `resolveDefaultPreset`.
  return doc;
}

/**
 * Validate the `default_preset` value of one layer. `null`/`''` mean "no default"; anything else
 * must be a preset-shaped name.
 *
 * @param {unknown} value
 * @param {string} path - for the error message
 * @returns {string|null}
 */
function normalizeDefaultPreset(value, path) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !PRESET_NAME_RE.test(value)) {
    throw new SidekicksError(
      `cli-executor: presets ${path} default_preset must be a preset name matching `
      + `${PRESET_NAME_RE.source} (or null for none)`,
      EXIT_VALIDATION
    );
  }
  return value;
}

/**
 * Compose root < active-project. A project layer REPLACES a preset wholesale rather than merging
 * field-by-field: half a root preset and half a project one is a seat arrangement nobody declared,
 * and the frozen snapshot has to be something an operator can point at. `null` deletes.
 *
 * @param {{presets: Record<string, object|null>}} rootLayer
 * @param {{presets: Record<string, object|null>}|null} projectLayer
 * @returns {{ schema_version: number, presets: Record<string, object>, provenance: {presets: Record<string, {source: string}>} }}
 */
export function effectivePresets(rootLayer = { presets: {} }, projectLayer = null) {
  const presets = {};
  const provenance = { presets: {} };
  for (const [name, preset] of Object.entries(rootLayer.presets || {})) {
    if (preset === null) continue;
    presets[name] = preset;
    provenance.presets[name] = { source: 'root' };
  }
  for (const [name, preset] of Object.entries(projectLayer?.presets || {})) {
    if (preset === null) {
      delete presets[name];
      delete provenance.presets[name];
      continue;
    }
    presets[name] = preset;
    provenance.presets[name] = { source: 'project' };
  }
  // The default comes from the ROOT layer and nowhere else — presets overlay, this one does not.
  // A project layer never reaches here with the key (readPresets refuses it), so there is no
  // precedence question to answer and no per-project routing surprise to explain.
  const defaultPreset = rootLayer?.default_preset ?? null;
  provenance.default_preset = defaultPreset ? { source: 'root' } : null;
  return { schema_version: PRESET_SCHEMA_VERSION, default_preset: defaultPreset, presets, provenance };
}

/** Read and compose both layers for the active scope. */
export function readEffectivePresets(repoRoot, settings, { rootOnly = false } = {}) {
  const layers = resolvePresetLayers(repoRoot, settings);
  const root = readPresets(layers.root.path, { layer: 'root' });
  const project = !rootOnly && layers.project
    ? readPresets(layers.project.path, { layer: 'project' })
    : null;
  return effectivePresets(root, project);
}

/**
 * The preset name a run falls back to when the operator names none — the ROOT layer's
 * `default_preset`, validated against what the scope actually declares (root presets plus any the
 * active project overlays), because a default that points at a deleted preset must fail LOUDLY at
 * the moment it would have been used, not route a run somewhere nobody declared.
 *
 * @param {{default_preset?: string|null, presets: Record<string, object>, provenance?: object}} effective
 * @returns {{ name: string, source: string }|null} null when no default is declared
 */
export function resolveDefaultPreset(effective) {
  const name = effective?.default_preset || null;
  if (!name) return null;
  if (!effective.presets?.[name]) {
    const known = Object.keys(effective.presets || {}).sort();
    throw new SidekicksError(
      `cli-executor: default_preset names '${name}', which is not declared in this scope`
      + (known.length ? ` — declared presets: ${known.join(', ')}` : ' — no presets are declared')
      + `\n  Point it elsewhere:  sidekicks cli-executor preset default <name>`
      + `\n  Or clear it:         sidekicks cli-executor preset default --clear`,
      EXIT_VALIDATION
    );
  }
  return { name, source: effective.provenance?.default_preset?.source ?? 'root' };
}

/** Persist one layer atomically (surface-gated). Presets are key-sorted so diffs stay stable. */
export function writePresets(path, doc, repoRoot) {
  const sorted = {};
  for (const key of Object.keys(doc.presets || {}).sort()) sorted[key] = doc.presets[key];
  const payload = { schema_version: PRESET_SCHEMA_VERSION };
  // Carried through verbatim: dropping it here is exactly the silent loss this file exists to avoid
  // (see the header note on why presets are not a key in the executor registry). Written above
  // `presets` so the pointer is visible without scrolling. Only a ROOT document ever carries it —
  // the caller writing a project layer must not put it in the doc, and `readPresets` refuses one
  // that appears there anyway.
  if (Object.prototype.hasOwnProperty.call(doc, 'default_preset')) {
    payload.default_preset = doc.default_preset ?? null;
  }
  payload.presets = sorted;
  assertWritable(path, repoRoot);
  writeAtomic(path, JSON.stringify(payload, null, 2) + '\n');
}

/**
 * Validate ONE declared seat: `{executor, model_tier, effort?}`.
 * Structural only — whether that executor can actually hold the role is a registry question,
 * answered later by `resolvePresetSnapshot`, because the registry can change between a `set` and a
 * dispatch and the answer must be re-asked at the point it matters.
 */
function validateRole(presetName, roleName, role) {
  if (!role || typeof role !== 'object' || Array.isArray(role)) {
    throw new SidekicksError(
      `cli-executor: preset '${presetName}' role '${roleName}' must be an object of {executor, model_tier, effort?}`,
      EXIT_VALIDATION
    );
  }
  if (typeof role.executor !== 'string' || !PRESET_NAME_RE.test(role.executor)) {
    throw new SidekicksError(
      `cli-executor: preset '${presetName}' role '${roleName}' needs an executor name matching ${PRESET_NAME_RE.source}`,
      EXIT_VALIDATION
    );
  }
  if (!MODEL_TIERS.includes(role.model_tier)) {
    throw new SidekicksError(
      `cli-executor: preset '${presetName}' role '${roleName}' model_tier must be one of ${MODEL_TIERS.join(', ')}`,
      EXIT_VALIDATION
    );
  }
  const out = { executor: role.executor, model_tier: role.model_tier };
  if (role.effort !== undefined && role.effort !== null && role.effort !== '') {
    if (typeof role.effort !== 'string') {
      throw new SidekicksError(
        `cli-executor: preset '${presetName}' role '${roleName}' effort must be a non-empty string`,
        EXIT_VALIDATION
      );
    }
    out.effort = role.effort;
  }
  for (const key of Object.keys(role)) {
    if (!['executor', 'model_tier', 'effort'].includes(key)) {
      throw new SidekicksError(
        `cli-executor: preset '${presetName}' role '${roleName}' has unknown field '${key}'`,
        EXIT_VALIDATION
      );
    }
  }
  return out;
}

/**
 * Validate and normalize one preset declaration. Returns the stored shape, key-ordered.
 *
 * @param {string} name
 * @param {unknown} preset
 * @returns {object}
 */
export function validatePreset(name, preset) {
  if (typeof name !== 'string' || !PRESET_NAME_RE.test(name)) {
    throw new SidekicksError(
      `cli-executor: preset name '${name}' must match ${PRESET_NAME_RE.source}`,
      EXIT_VALIDATION
    );
  }
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
    throw new SidekicksError(`cli-executor: preset '${name}' must be an object`, EXIT_VALIDATION);
  }
  const out = {};
  if (preset.host_cli !== undefined && preset.host_cli !== null && preset.host_cli !== '') {
    if (typeof preset.host_cli !== 'string' || !PRESET_NAME_RE.test(preset.host_cli)) {
      throw new SidekicksError(
        `cli-executor: preset '${name}' host_cli must match ${PRESET_NAME_RE.source}`,
        EXIT_VALIDATION
      );
    }
    out.host_cli = preset.host_cli;
  }
  for (const roleName of PRESET_ROLES) {
    const role = preset[roleName];
    if (role === undefined || role === null) {
      if (REQUIRED_ROLES.includes(roleName)) {
        throw new SidekicksError(
          `cli-executor: preset '${name}' is missing the required role '${roleName}'`,
          EXIT_VALIDATION
        );
      }
      continue;
    }
    out[roleName] = validateRole(name, roleName, role);
  }
  if (preset.allow_same_family_review !== undefined) {
    if (typeof preset.allow_same_family_review !== 'boolean') {
      throw new SidekicksError(
        `cli-executor: preset '${name}' allow_same_family_review must be a boolean`,
        EXIT_VALIDATION
      );
    }
    out.allow_same_family_review = preset.allow_same_family_review;
  }
  const fallback = preset.fallback;
  if (fallback !== undefined && fallback !== null) {
    if (typeof fallback !== 'object' || Array.isArray(fallback)) {
      throw new SidekicksError(`cli-executor: preset '${name}' fallback must be an object`, EXIT_VALIDATION);
    }
    const mode = fallback.mode ?? 'default-routing';
    if (!FALLBACK_MODES.includes(mode)) {
      throw new SidekicksError(
        `cli-executor: preset '${name}' fallback.mode must be one of ${FALLBACK_MODES.join(', ')}`,
        EXIT_VALIDATION
      );
    }
    const max = fallback.max_role_fallbacks ?? DEFAULT_MAX_ROLE_FALLBACKS;
    if (!Number.isInteger(max) || max < 0) {
      throw new SidekicksError(
        `cli-executor: preset '${name}' fallback.max_role_fallbacks must be an integer >= 0`,
        EXIT_VALIDATION
      );
    }
    out.fallback = { mode, max_role_fallbacks: max };
  }
  for (const key of Object.keys(preset)) {
    if (!['host_cli', ...PRESET_ROLES, 'allow_same_family_review', 'fallback'].includes(key)) {
      throw new SidekicksError(`cli-executor: preset '${name}' has unknown field '${key}'`, EXIT_VALIDATION);
    }
  }
  return out;
}

/**
 * Resolve the effort a seat will actually run with, and say WHICH branch produced it.
 *
 * Order: the preset's explicit value → the executor's own `efforts[tier]` map → the provider's
 * default (no flag emitted at all). The source is recorded because "no effort flag" and "the
 * effort the CLI happens to default to" look identical in an argv and mean different things in a
 * report.
 *
 * @param {Record<string, any>} spec
 * @param {string} tier
 * @param {string|null|undefined} explicit
 * @returns {{ effort: string|null, effort_source: string }}
 */
export function effortFor(spec, tier, explicit) {
  if (typeof explicit === 'string' && explicit !== '') {
    return { effort: explicit, effort_source: 'explicit-preset' };
  }
  const mapped = resolveEffort(spec, tier);
  if (mapped) return { effort: mapped, effort_source: 'executor-tier-map' };
  return { effort: null, effort_source: 'provider-default' };
}

/**
 * Grade ONE seat against the live registry without throwing — the shared predicate behind both
 * `preset set` validation and the pre-dispatch re-check, so the two can never disagree.
 *
 * @param {{executors: Record<string, any>, executor: string, goalRole: string, tier: string, effort?: string|null}} input
 * @returns {{ ok: boolean, reason: string|null, seat: object|null }}
 */
export function checkSeat({ executors, executor, goalRole, tier, effort }) {
  const spec = executors?.[executor];
  if (!spec) return { ok: false, reason: `executor '${executor}' is not registered`, seat: null };
  if (spec.enabled === false) return { ok: false, reason: `executor '${executor}' is disabled`, seat: null };
  if (!ROLES.includes(goalRole)) return { ok: false, reason: `unknown role '${goalRole}'`, seat: null };
  const support = roleSupported(executor, spec, goalRole);
  if (!support.ok) return { ok: false, reason: support.reason, seat: null };
  if (!spec.models?.[tier]) {
    // A preset tier that maps no model is a FAILED PRIMARY SELECTION, never a silent CLI default:
    // the whole point of pinning a tier is that the run is reproducible.
    return { ok: false, reason: `executor '${executor}' maps no model for the ${tier} tier`, seat: null };
  }
  let model;
  try {
    model = resolveModel(executor, spec, tier);
  } catch (err) {
    return { ok: false, reason: err.message, seat: null };
  }
  const resolvedEffort = effortFor(spec, tier, effort);
  const graded = catalogStatus(spec, model, resolvedEffort.effort);
  if (graded.status === 'stale') {
    return { ok: false, reason: `executor '${executor}' ${graded.reason}`, seat: null };
  }
  return {
    ok: true,
    reason: null,
    seat: {
      executor,
      family: resolveFamily(executor, spec) ?? '',
      tier,
      model,
      effort: resolvedEffort.effort,
      effort_source: resolvedEffort.effort_source,
      catalog: graded.status,
    },
  };
}

/**
 * Resolve a declared preset into the frozen snapshot every consumer reads.
 *
 * This is the ONLY place a preset meets the registry. It runs twice by design — once at
 * `preset set` (so an unusable preset never reaches disk) and again immediately before dispatch
 * (because a model map, a catalog or an `enabled` flag can change in between).
 *
 * @param {{name: string, preset: object, executors: Record<string, any>, hostCli?: string}} input
 * @returns {object} the normalized snapshot
 */
export function resolvePresetSnapshot({ name, preset, executors, hostCli = '' }) {
  const declared = validatePreset(name, preset);
  const errors = [];
  const roles = {};

  for (const roleName of REQUIRED_ROLES) {
    const role = declared[roleName];
    const checked = checkSeat({
      executors,
      executor: role.executor,
      goalRole: GOAL_ROLE_OF[roleName],
      tier: role.model_tier,
      effort: role.effort,
    });
    if (!checked.ok) errors.push(`${roleName}: ${checked.reason}`);
    else roles[roleName] = { ...checked.seat, role: GOAL_ROLE_OF[roleName] };
  }

  if (declared.final_verifier) {
    const role = declared.final_verifier;
    const checked = checkSeat({
      executors,
      executor: role.executor,
      goalRole: 'final-verify',
      tier: role.model_tier,
      effort: role.effort,
    });
    if (!checked.ok) errors.push(`final_verifier: ${checked.reason}`);
    else roles.final_verifier = { ...checked.seat, role: 'final-verify', inherited: false };
  } else if (roles.reviewer) {
    // An absent final verifier INHERITS the reviewer verbatim rather than re-entering the resolver:
    // "the reviewer also signs off" is a choice the operator made by omission, and a silently
    // different seat here would be the one substitution nobody asked for.
    const inheritCheck = checkSeat({
      executors,
      executor: declared.reviewer.executor,
      goalRole: 'final-verify',
      tier: declared.reviewer.model_tier,
      effort: declared.reviewer.effort,
    });
    if (!inheritCheck.ok) {
      errors.push(`final_verifier (inherited from reviewer): ${inheritCheck.reason}`);
    } else {
      roles.final_verifier = { ...inheritCheck.seat, role: 'final-verify', inherited: true };
    }
  }

  const allowSameFamily = declared.allow_same_family_review === true;
  if (!allowSameFamily && roles.implementer) {
    for (const roleName of ['reviewer', 'final_verifier']) {
      const seat = roles[roleName];
      if (!seat) continue;
      if (seat.family && seat.family === roles.implementer.family) {
        errors.push(
          `${roleName}: '${seat.executor}' shares the implementer's family '${seat.family}' — `
          + 'a reviewer from the family that wrote the change is not independent. '
          + 'Pick another executor or set allow_same_family_review.'
        );
      }
    }
  }

  const host = hostCli || declared.host_cli || '';
  if (host) {
    const spec = executors?.[host];
    if (!spec) errors.push(`host_cli: '${host}' is not a registered executor`);
    else if (spec.enabled === false) errors.push(`host_cli: '${host}' is disabled`);
  }

  if (errors.length) {
    throw new SidekicksError(
      `cli-executor: preset '${name}' cannot be resolved against the current registry:\n  `
      + errors.join('\n  '),
      EXIT_VALIDATION
    );
  }

  return {
    schema_version: PRESET_SCHEMA_VERSION,
    preset: name,
    host_cli: host || null,
    roles,
    allow_same_family_review: allowSameFamily,
    fallback: declared.fallback ?? { mode: 'default-routing', max_role_fallbacks: DEFAULT_MAX_ROLE_FALLBACKS },
  };
}

/**
 * The snapshot seat for a GOAL-engine role (`plan|implement|review|final-verify`).
 * Returns `null` for a snapshot that is absent or holds no such seat, so every call site can keep
 * its existing no-preset path unchanged behind one falsy check.
 *
 * @param {object|null} snapshot
 * @param {string} goalRole
 * @returns {object|null}
 */
export function seatForGoalRole(snapshot, goalRole) {
  if (!snapshot || !snapshot.roles) return null;
  const presetRole = PRESET_ROLE_OF[goalRole];
  if (!presetRole) return null;
  return snapshot.roles[presetRole] ?? null;
}
