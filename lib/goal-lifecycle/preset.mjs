// lib/goal-lifecycle/preset.mjs
// The goal engine's side of orchestration presets: load one, hand each phase its pinned seat, and
// decide — bounded, recorded, never silently — whether a failed seat may be replaced.
//
// The preset itself (storage, overlay, validation, resolution) lives in
// lib/cli-executor-lifecycle/presets.mjs. This module holds only what the ENGINE needs:
//
//   - `loadPresetSnapshot`  resolve `--preset <name>` against the live registry, once, at plan time
//   - `presetSeat`          the seat for a goal role, shaped like `selectExecutor`'s return so a
//                           call site keeps its existing no-preset path behind one falsy check
//   - `assertPresetMatches` `goal run --preset X` must equal the FROZEN snapshot, never re-resolve
//   - `selectFallbackSeat`  one bounded substitution through the EXISTING resolver
//   - `routingEvent`        the audit record: primary, failure, actual
//
// TWO RULES THIS MODULE EXISTS TO KEEP:
//
// 1. THE FROZEN SNAPSHOT IS THE AUTHORITY AFTER APPROVAL. Once an envelope is approved, the preset
//    file on disk is irrelevant to that run — `goal run` reads the snapshot out of the envelope and
//    never re-resolves the name. Editing a preset afterwards changes the envelope digest, which
//    `checkApprovalDrift` already treats as lost approval.
//
// 2. A FALLBACK IS AN EXCEPTION, NOT A ROUTING DEFAULT. It re-enters the engine's own resolver
//    (`selectExecutor` / `selectIndependentExecutor`) with the failed executor removed from the
//    candidate map — there is no second resolver here — and it is capped, per role attempt, by the
//    preset's own `max_role_fallbacks`. `fallback.mode: none` and `--preset-strict` forbid it
//    outright, and NOTHING may fall back after an unsafe implementation failure.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { resolveEffort, resolveFamily } from '../cli-executor-lifecycle/profiles.mjs';
import { catalogStatus } from '../cli-executor-lifecycle/_shared.mjs';
import {
  readEffectivePresets,
  resolveDefaultPreset,
  resolvePresetSnapshot,
  seatForGoalRole,
} from '../cli-executor-lifecycle/presets.mjs';
import { selectExecutor, selectIndependentExecutor } from './planner.mjs';

/**
 * Failure classes a fallback decision is taken against. They mirror what `runner.mjs` already
 * decides when it settles an attempt — this module reads that classification rather than deriving
 * a second opinion about whether a failure was safe.
 */
export const FAILURE_CLASSES = Object.freeze([
  'pre-dispatch',        // binary/auth absent, tier maps nothing, effort refused by a complete catalog
  'retryable-runtime',   // timeout, non-zero exit, unusable output — no world-facing action taken
  'unsafe',              // hard-stop action, write-boundary violation, unknown child ownership
  'effort-rejected',     // the model is fine; the explicit effort is not
]);

/** Classes that may NEVER be answered by swapping in another CLI. */
const NO_FALLBACK_CLASSES = Object.freeze(['unsafe']);

/**
 * The repo's configured `default_preset` (a ROOT-only setting), or null when none is declared.
 *
 * Read ONLY by `goal plan`, and only when the operator named no preset: the default decides which
 * preset a run BINDS, never what an already-planned run dispatches — that stays the frozen snapshot
 * in the envelope, so changing the default cannot reach a run that is already approved.
 *
 * A default naming a preset this scope does not declare throws here rather than being ignored:
 * silently routing by resolver when the operator believes a preset is in force is the one outcome
 * this feature must not produce.
 *
 * @param {{repoRoot: string, settings: object}} input
 * @returns {{name: string, source: string}|null}
 */
export function defaultPresetName({ repoRoot, settings }) {
  return resolveDefaultPreset(readEffectivePresets(repoRoot, settings));
}

/**
 * Resolve `--preset <name>` against the live registry. Called ONCE, at plan time; everything after
 * approval reads the frozen snapshot instead.
 *
 * @param {{repoRoot: string, settings: object, executors: Record<string, any>, name: string,
 *          hostCli?: string}} input
 * @returns {object} the resolved snapshot
 */
export function loadPresetSnapshot({ repoRoot, settings, executors, name, hostCli = '' }) {
  const effective = readEffectivePresets(repoRoot, settings);
  const declared = effective.presets[name];
  if (!declared) {
    const known = Object.keys(effective.presets).sort();
    throw new SidekicksError(
      `goal: unknown orchestration preset '${name}'`
      + (known.length ? ` — declared presets: ${known.join(', ')}` : ' — none are declared in this scope')
      + "\n  Declare one:  sidekicks cli-executor preset set <name> --planner <exec>:<tier> "
      + '--implementer <exec>:<tier> --reviewer <exec>:<tier>',
      EXIT_VALIDATION,
    );
  }
  return resolvePresetSnapshot({ name, preset: declared, executors, hostCli });
}

/**
 * The seat a preset pins for one GOAL role, shaped like `selectExecutor`'s `{name, spec}` plus the
 * pinned tier and effort. `null` when there is no preset or no such seat, so every call site keeps
 * its existing resolver path unchanged behind one falsy check.
 *
 * @param {object|null} snapshot
 * @param {string} goalRole - plan | implement | review | final-verify
 * @param {Record<string, any>} executors
 * @returns {{name: string, spec: object, tier: string, effort: string|null, family: string,
 *            model: string, effort_source: string, from_preset: true}|null}
 */
export function presetSeat(snapshot, goalRole, executors) {
  const seat = seatForGoalRole(snapshot, goalRole);
  if (!seat) return null;
  const spec = executors?.[seat.executor];
  if (!spec) {
    // The snapshot was frozen against a registry that has since lost this executor. Fail loudly:
    // the whole contract of a preset is that the approved seat is the seat that runs.
    throw new SidekicksError(
      `goal: preset '${snapshot.preset}' pins '${seat.executor}' for the ${goalRole} role, but that `
      + 'executor is no longer registered in this scope. Re-register it, or re-plan without the preset.',
      EXIT_VALIDATION,
    );
  }
  return {
    name: seat.executor,
    spec,
    tier: seat.tier,
    effort: seat.effort ?? null,
    effort_source: seat.effort_source,
    family: seat.family || (resolveFamily(seat.executor, spec) ?? ''),
    model: seat.model,
    from_preset: true,
  };
}

/**
 * Guard `goal run --preset X` / `goal resume --preset X` against the frozen snapshot.
 *
 * A preset flag here is an ASSERTION about the run, never a re-selection: naming a different preset
 * than the one approved is a routing change that has to go back through planning and approval.
 *
 * @param {object|null} snapshot - the snapshot frozen in the approved envelope
 * @param {string} requested - the `--preset` value, or '' when the flag was not given
 */
export function assertPresetMatches(snapshot, requested) {
  if (!requested) return;
  const frozen = snapshot?.preset ?? null;
  if (!frozen) {
    throw new SidekicksError(
      `goal: --preset ${requested} was given, but this run was planned WITHOUT a preset. Its routing `
      + 'is already approved and is not re-resolved; re-plan with --preset to bind one.',
      EXIT_VALIDATION,
    );
  }
  if (frozen !== requested) {
    throw new SidekicksError(
      `goal: this run is bound to preset '${frozen}', not '${requested}'. An approved run's routing `
      + 'is frozen; re-plan to change it.',
      EXIT_VALIDATION,
    );
  }
}

/**
 * May a failed seat be replaced at all? Every `false` answer names its reason, because "no fallback
 * happened" and "a fallback was forbidden" are different facts in a report.
 *
 * @param {{snapshot: object|null, failureClass: string, strict?: boolean, used?: number}} input
 * @returns {{allowed: boolean, reason: string|null}}
 */
export function fallbackAllowed({ snapshot, failureClass, strict = false, used = 0 }) {
  if (NO_FALLBACK_CLASSES.includes(failureClass)) {
    return {
      allowed: false,
      reason: 'the attempt failed in a class that may never be answered by another provider '
        + '(a hard-stopped action, a write-boundary violation or unknown child ownership)',
    };
  }
  if (strict) return { allowed: false, reason: '--preset-strict forbids any substitution' };
  if (!snapshot) return { allowed: true, reason: null };
  const mode = snapshot.fallback?.mode ?? 'default-routing';
  if (mode === 'none') return { allowed: false, reason: `preset '${snapshot.preset}' sets fallback.mode: none` };
  const max = snapshot.fallback?.max_role_fallbacks ?? 1;
  if (used >= max) {
    return { allowed: false, reason: `the preset's fallback budget (${max} per role attempt) is spent` };
  }
  return { allowed: true, reason: null };
}

/**
 * Select ONE fallback seat through the engine's existing resolver, with the failed executor removed
 * from the candidate map. There is deliberately no fallback-specific selection logic: a substitute
 * has to clear exactly the same eligibility bar the primary did — role support, containment, a
 * mapped tier — and the one place that bar lives is `selectExecutor`.
 *
 * The fallback uses ITS OWN model map and its own tier-map/provider-default effort. Carrying the
 * primary's explicit effort across would apply one CLI's vocabulary to another's.
 *
 * @param {{executors: Record<string, any>, prefer?: string[], hostCli?: string, role: string,
 *          tier: string, failedExecutor: string, avoidFamily?: string|null,
 *          independent?: boolean}} input
 * @returns {{name: string, spec: object, tier: string, effort: undefined, family: string,
 *            same_family_fallback: boolean}}
 */
export function selectFallbackSeat(input) {
  const { executors, prefer = [], hostCli = '', role, tier, failedExecutor } = input;
  /** @type {Record<string, any>} */
  const pool = {};
  for (const [name, spec] of Object.entries(executors || {})) {
    if (name === failedExecutor) continue;
    pool[name] = spec;
  }
  if (Object.keys(pool).length === 0) {
    throw new SidekicksError(
      `goal: no executor other than '${failedExecutor}' is registered, so the ${role} role has no fallback`,
      EXIT_VALIDATION,
    );
  }
  if (input.independent) {
    const seat = selectIndependentExecutor({
      executors: pool,
      prefer,
      hostCli,
      role,
      tier,
      avoidFamily: input.avoidFamily ?? null,
      avoidExecutor: failedExecutor,
      familyOf: (name, spec) => resolveFamily(name, spec),
    });
    return {
      name: seat.name,
      spec: seat.spec,
      tier,
      // `undefined` on purpose: the substitute derives effort from its OWN registry map, exactly as
      // a no-preset run would.
      effort: undefined,
      family: seat.family ?? '',
      same_family_fallback: seat.same_family_fallback === true,
    };
  }
  const seat = selectExecutor({ executors: pool, prefer, hostCli, requested: null, role, tier });
  return {
    name: seat.name,
    spec: seat.spec,
    tier,
    effort: undefined,
    family: resolveFamily(seat.name, seat.spec) ?? '',
    same_family_fallback: false,
  };
}

/**
 * Settle the effort ONE dispatch will actually carry, degrading before replacing a CLI.
 *
 * An explicit effort the model's own catalog refuses is not a reason to change provider: the model
 * is fine, one knob is not. So the ladder is retry the SAME model at the executor's tier-map effort,
 * then at the provider default (no flag at all), and only a model-level failure escalates to the
 * role fallback.
 *
 * `effort: undefined` is returned for an unpinned run, which leaves `buildInvocation` reading the
 * registry map exactly as it did before presets existed.
 *
 * @param {{spec: object, tier: string, effort: string|null|undefined}} input
 * @returns {{effort: string|null|undefined, effort_fallback: boolean, reason: string|null}}
 */
export function resolveDispatchEffort({ spec, tier, effort }) {
  if (effort === undefined) return { effort: undefined, effort_fallback: false, reason: null };
  const model = spec?.models?.[tier];
  if (!effort || !model) return { effort: effort ?? null, effort_fallback: false, reason: null };
  const graded = catalogStatus(spec, model, effort);
  if (graded.status !== 'stale') return { effort, effort_fallback: false, reason: null };
  const mapped = resolveEffort(spec, tier);
  if (mapped && mapped !== effort && catalogStatus(spec, model, mapped).status !== 'stale') {
    return { effort: mapped, effort_fallback: true, reason: `${graded.reason}; fell back to the executor's ${tier} tier-map effort` };
  }
  return { effort: null, effort_fallback: true, reason: `${graded.reason}; fell back to the provider default` };
}

/**
 * The audit record for one substitution — what was pinned, why it failed, what actually ran.
 * Kept as plain data so it can be appended to `run.json` and rendered by the report without either
 * side re-deriving it.
 *
 * @param {{role: string, node?: string|null, attempt?: number|null, primary: object,
 *          failureClass: string, reason: string, actual: object|null,
 *          effortFallback?: boolean, at: string}} input
 * @returns {object}
 */
export function routingEvent(input) {
  return {
    role: input.role,
    node: input.node ?? null,
    attempt: input.attempt ?? null,
    at: input.at,
    primary: {
      executor: input.primary?.name ?? input.primary?.executor ?? null,
      family: input.primary?.family ?? null,
      tier: input.primary?.tier ?? null,
      model: input.primary?.model ?? null,
      effort: input.primary?.effort ?? null,
    },
    failure: { class: input.failureClass, reason: input.reason },
    fallback: input.actual
      ? {
        executor: input.actual.name ?? input.actual.executor ?? null,
        family: input.actual.family ?? null,
        tier: input.actual.tier ?? null,
        same_family: input.actual.same_family_fallback === true,
      }
      : null,
    effort_fallback: input.effortFallback === true,
  };
}

/**
 * Append a routing event to run state. A separate top-level list rather than only the attempt
 * record, because a pre-dispatch failure happens BEFORE an attempt exists — and that is exactly the
 * case a report must not lose.
 *
 * @param {object} state
 * @param {object} event
 * @returns {object} state
 */
export function recordRoutingEvent(state, event) {
  if (!Array.isArray(state.routing_fallbacks)) state.routing_fallbacks = [];
  state.routing_fallbacks.push(event);
  return state;
}
