// lib/goal-lifecycle/plan.mjs
// `sidekicks goal plan <goal-or-file> [--executor <n>] [--tier <t>] [--contest] [--planners a,b,c]`
//
// Intake → plan → independent critique → an approval envelope with a digest. Nothing is dispatched
// here that can write to the repository: planning and critique both run in the selected CLI's
// enforced read-only mode, and the ONLY writer of run state is this process.
//
// THE ORDER OF WRITES IS THE CRASH-SAFETY DESIGN. `goal.json` lands before any subprocess starts, so
// a crash during planning leaves a run that can be identified and resumed rather than an orphan
// folder. The lease is taken before the first state write and released in a `finally`, so a crash
// leaves a lock whose owner is a dead pid on this host — which the conservative reclaim rules will
// archive and take over, while never touching a live or foreign one.
//
// WHAT THIS VERB REFUSES TO DO. It does not approve its own plan; it prints the digest and stops. It
// does not loop on critique more than twice. It does not widen the goal to fit what the planner
// happened to return. And when the planner cannot produce a valid document, it moves the run to
// `needs_user` with the validation errors rather than accepting a partial plan — an invalid plan
// dispatched is an unbounded agent run.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join as joinPath, resolve as resolvePath } from 'node:path';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveWorkingFolder } from '../active-scope/scope.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { currentHostContext, currentHostCli } from '../cli-executor-lifecycle/_shared.mjs';
import { resolveFamily, resolveModelFamily, resolveSelection } from '../cli-executor-lifecycle/profiles.mjs';
import { executionConsumers, resolveExecutionSnapshot } from '../execution-lifecycle/snapshot.mjs';
import { executionConfigObservation } from './execution-observation.mjs';
import {
  defaultPresetName,
  fallbackAllowed,
  loadPresetSnapshot,
  presetSeat,
  recordRoutingEvent,
  routingEvent,
  selectFallbackSeat,
} from './preset.mjs';
import {
  RELATIVE,
  assembleEnvelope,
  flagString,
  goalPositionals,
  newRunId,
  parseGoalFlags,
  resolveGoalRunDir,
} from './commands.mjs';
import {
  canonicalEnvelope,
  criterionOwners,
  envelopeDigest,
  goalDigest,
  planDigest,
  validateEnvelope,
  validateGoal,
} from './schema.mjs';
import { topoOrder } from './graph.mjs';
import { defaultActionPolicy, defaultBudgets, planReviewPolicy } from './policy.mjs';
import { advisoryNote, consultRecovery, recoveryFacts } from './advisory-recovery.mjs';
import {
  buildCorrectionPrompt,
  buildCriticPrompt,
  buildPlannerPrompt,
  describeExecutors,
  runCritiqueSession,
  runPlanningSession,
  selectExecutor,
  selectIndependentExecutor,
} from './planner.mjs';
import { renderApprovalSummary, renderPlanMarkdown } from './render.mjs';
import {
  acquireRunLease,
  appendGoalEvent,
  clearLease,
  goalPaths,
  mkdirp,
  newRunState,
  readJsonIfPresent,
  readRunState,
  releaseRunLease,
  stampDivergence,
  stampLease,
  stopPresent,
  writeJson,
  writeRunState,
} from './store.mjs';
import {
  toAwaitingApproval,
  toNeedsUser,
  toPlanCorrection,
  toPlanReview,
  toPlanning,
} from './state-machine.mjs';

/** The plan critique budget. Two passes, then a human — never an unbounded loop. */
export const MAX_CRITIQUE_PASSES = 2;

/** Reserve a call before dispatch; an interrupted call can never be silently spent again. */
function beginPlanningChild(runDir, state, id, kind) {
  if (stopPresent(runDir)) {
    throw new SidekicksError('goal: STOP gate is present; planning child was not dispatched', EXIT_VALIDATION);
  }
  const p = state.planning;
  const key = kind === 'planner' ? 'planner_calls' : 'critic_calls';
  const cap = p.review_policy?.[key];
  if (!Number.isInteger(cap) || p[key] >= cap || p.jobs?.[id]) {
    throw new SidekicksError(`goal: ${kind} call budget exhausted or already dispatched`, EXIT_VALIDATION);
  }
  p[key] += 1;
  if (p.review_policy.epochs > 1) {
    p.jobs = { ...(p.jobs || {}), [id]: { id, kind, substate: 'pending', pid: null,
      hostname: null, retries: 0 } };
  }
  return writeRunState(runDir, state);
}

function planningSpawn(runDir, state, id) {
  return (info) => {
    const job = state.planning.jobs?.[id];
    if (!job) return;
    job.substate = 'dispatched';
    job.pid = info.pid ?? null;
    job.hostname = hostname();
    job.dispatched_at = bangkokTimestamp(Date.now());
    writeRunState(runDir, state);
  };
}

function settlePlanningChild(runDir, state, id, result) {
  const job = state.planning.jobs?.[id];
  if (!job) return state;
  // The terminal state and parsed output are one atomic state write. A resume must never infer a
  // verdict from a transcript or pay for the same child a second time.
  job.result = job.kind === 'planner'
    ? { ok: result.ok, plan: result.plan, errors: result.errors }
    : { ok: result.ok, verdict: result.verdict, findings: result.findings, errors: result.errors };
  job.substate = result.ok ? 'completed' : 'failed';
  job.outcome = result.ok ? 'returned' : 'failed';
  job.ended_at = bangkokTimestamp(Date.now());
  return writeRunState(runDir, state);
}

/** Boolean flags this verb accepts (everything else is a valued flag, re-parsed locally). */
const BOOLEANS = ['contest', 'json', 'no-critique', 'no-preset'];

/**
 * Run `goal plan`.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const positionals = goalPositionals(ctx.argv, BOOLEANS);

  const goalArg = positionals.join(' ').trim();
  const epochFlag = flagString(flags['plan-review-epochs']);
  if (Object.hasOwn(flags, 'plan-review-epochs') && epochFlag === '') {
    throw new SidekicksError('goal plan: --plan-review-epochs requires an integer value', EXIT_VALIDATION);
  }
  let reviewPolicy;
  try {
    reviewPolicy = planReviewPolicy(epochFlag === '' ? 1 : Number(epochFlag));
  } catch (err) {
    throw new SidekicksError(`goal plan: ${err.message}`, EXIT_VALIDATION);
  }
  if (reviewPolicy.epochs > 1 && (flags['no-critique'] === true || flags.contest === true)) {
    throw new SidekicksError('goal plan: additional review epochs require single-planner critique', EXIT_VALIDATION);
  }
  if (goalArg === '') {
    throw new SidekicksError(
      'goal plan: usage: goal plan "<goal>" | <path-to-goal-file> [--preset <name>] [--no-preset] '
      + '[--executor <name>] [--tier <top|high|mid|low>] [--contest] [--planners <a,b,c>] '
      + '[--plan-review-epochs <1|2|3>] [--json]',
      EXIT_USAGE,
    );
  }

  const contest = flags.contest === true;
  const planners = flagString(flags.planners);
  const requestedExecutor = flagString(flags.executor);
  const requestedTier = flagString(flags.tier) || 'high';
  const namedPreset = flagString(flags.preset);
  const declinePreset = flags['no-preset'] === true;
  const hostContext = currentHostContext(flagString(flags['host-cli']));
  const hostCli = hostContext.host_cli;

  // Flag combinations are checked BEFORE anything is written, so an unusable request never leaves a
  // half-created run folder behind.
  if (planners && !contest) {
    throw new SidekicksError(
      'goal plan: --planners names the contestants of a contest, so it requires --contest',
      EXIT_VALIDATION,
    );
  }
  if (contest && (requestedExecutor || flagString(flags.tier))) {
    throw new SidekicksError(
      'goal plan: --contest runs the highest eligible tier of every capable CLI family, so it is '
      + 'mutually exclusive with the single-planner --executor / --tier flags',
      EXIT_VALIDATION,
    );
  }
  // A preset pins ONE planner seat; a contest fans out several and judges them. The two are
  // different answers to the same question, so naming both is a request nobody can satisfy — say so
  // rather than silently discarding whichever flag came second.
  if (namedPreset && contest) {
    throw new SidekicksError(
      'goal plan: --preset pins one planner seat while --contest fans out several capable families, '
      + 'so the two are mutually exclusive. Drop one.',
      EXIT_VALIDATION,
    );
  }
  // With a preset, a divergent per-flag override is refused rather than merged: half a preset is a
  // seat arrangement nobody declared, and the frozen snapshot has to be something an operator can
  // point at by name.
  if (namedPreset && (requestedExecutor || flagString(flags.tier))) {
    throw new SidekicksError(
      `goal plan: --preset ${namedPreset} already pins the executor and tier of every role, so it is `
      + 'mutually exclusive with --executor / --tier',
      EXIT_VALIDATION,
    );
  }
  if (namedPreset && declinePreset) {
    throw new SidekicksError(
      `goal plan: --no-preset declines the configured default, so naming --preset ${namedPreset} `
      + 'alongside it is two answers to one question. Drop one.',
      EXIT_VALIDATION,
    );
  }

  const { goalText, requirementDocs } = readGoal(ctx.repoRoot, goalArg);

  const settings = readSettings(ctx.repoRoot);
  // Automated delivery deliberately resolves the ROOT default, not a host-default.  The host is
  // diagnostic in this path: a user working from Claude must receive the same frozen implementer
  // binding as a user working from Codex or Antigravity.
  const execution = resolveExecutionSnapshot(ctx.repoRoot, settings);
  const executionView = executionConsumers(execution);
  const deliveryPolicy = executionView.deliveryPolicy;
  const automatedDelivery = deliveryPolicy.mode === 'multi_cli';
  // The root-level `default_preset`, when the operator named none. It YIELDS to every explicit routing
  // flag rather than fighting it — `--no-preset`, `--contest` and `--executor`/`--tier` each say
  // plainly how this run should route, and a configured default is the weaker statement. What it
  // never does is apply silently: the pickup is logged, and the approval summary names the preset
  // and its frozen seats like any other.
  const explicitRouting = declinePreset || contest || Boolean(requestedExecutor) || Boolean(flagString(flags.tier));
  const configuredDefault = namedPreset || explicitRouting
    ? null
    : defaultPresetName({ repoRoot: ctx.repoRoot, settings, hostCli: automatedDelivery ? '' : hostCli });
  const presetName = namedPreset || configuredDefault?.name || '';
  const presetOrigin = namedPreset ? 'flag' : (configuredDefault ? `default_preset [${configuredDefault.source}]` : null);

  const scope = resolveWorkingFolder(settings, ctx.repoRoot);
  const { executors, prefer } = executionView;

  // Resolved BEFORE the run folder exists, so an unusable preset never leaves a half-created run
  // behind — the same reason the flag-combination checks run above.
  const preset = presetName
    ? loadPresetSnapshot({ repoRoot: ctx.repoRoot, settings, executors, name: presetName, hostCli: '',
      bindingSource: namedPreset ? 'flag' : configuredDefault?.source || 'default_preset',
      detectedHostCli: hostCli, detectedHostSource: hostContext.source })
    : null;
  if (preset && configuredDefault) {
    ctx.log(`goal plan: no --preset given — binding the configured default_preset '${preset.preset}' `
      + `[${configuredDefault.source}]. Pass --no-preset to plan without it.`);
  }
  if (!automatedDelivery && preset?.host_cli && hostCli && hostCli !== preset.host_cli
      && flagString(flags['host-cli']) !== preset.host_cli) {
    throw new SidekicksError(
      `goal plan: preset '${preset.preset}' prefers host CLI '${preset.host_cli}', but this session `
      + `reports '${hostCli}'. Pass --host-cli ${preset.host_cli} to confirm, or re-plan `
      + `${configuredDefault ? 'with --no-preset' : 'without the preset'}.`,
      EXIT_VALIDATION,
    );
  }

  const runId = newRunId();
  const { runDir } = resolveGoalRunDir(ctx.repoRoot, runId);
  mkdirp(runDir);

  // ---- intake, before any subprocess ------------------------------------------------------------
  const createdAt = bangkokTimestamp(Date.now());
  const goalRecord = {
    schema_version: 1,
    run_id: runId,
    goal: goalText,
    created_at: createdAt,
    work_dir: RELATIVE(ctx.repoRoot, scope.workdir),
    requirement_docs: requirementDocs,
  };
  const goalCheck = validateGoal(goalRecord);
  if (!goalCheck.ok) {
    throw new SidekicksError(`goal plan: invalid goal record: ${goalCheck.errors.join('; ')}`, EXIT_VALIDATION);
  }
  writeJson(goalPaths(runDir).goal, goalRecord);

  let state = newRunState({ run_id: runId, goal_digest: goalDigest(goalRecord) });
  state.delivery_policy = deliveryPolicy;
  // Retain the safe, provenance-bearing view used at planning time. The approved envelope remains
  // the dispatch authority; this snapshot makes later diagnostics reproducible without letting a
  // changed registry rewrite a frozen route.
  state.execution_config_observation = executionConfigObservation(execution);
  state.planning = { ...state.planning, review_policy: reviewPolicy, review_epoch: 1,
    epoch_passes: 0, planner_calls: 0, critic_calls: 0, prior_findings: [] };
  state.advisory.policy = preset?.roles?.advisor
    ? { planning_max_calls: 2, execution_max_calls: 2 } : null;
  const lease = acquireRunLease(runDir);
  try {
    stampLease(state, { nonce: lease.nonce });
    state = commit(runDir, state, toPlanning(state, { reason: 'goal intake' }));

    const executorSummaries = describeExecutors(executors, resolveFamily);
    if (executorSummaries.length === 0) {
      state = commit(runDir, state, toNeedsUser(state, {
        reason: 'no executor maps any model tier, so nothing can be planned or implemented',
        next: "register one: cli-executor register <name> --model-high <id>",
      }));
      return finish(ctx, runDir, state, flags, 'no usable executor');
    }

    // ---- plan --------------------------------------------------------------------------------
    let planDoc = null;
    let planErrors = [];
    let plannerSeat = null;
    let contestRecord = null;

    if (contest) {
      // The request itself is persisted BEFORE the fan-out, because a resume has to reproduce the
      // same field of seats from disk alone: `--planners` and the tier came off a command line that
      // no longer exists by then, and rebuilding the contest from a different field would fold
      // artifacts into a comparison that was never held.
      state.planning = {
        ...(state.planning || {}),
        contest_request: {
          planners: planners ? planners.split(',').map((s) => s.trim()).filter(Boolean) : null,
          tier: requestedTier,
        },
      };
      state = writeRunState(runDir, state);
      const { runContest } = await import('./contest.mjs');
      const outcome = await runContest({
        repoRoot: ctx.repoRoot,
        runDir,
        runId,
        goalText,
        goalRecord,
        executors,
        prefer,
        planners: planners ? planners.split(',').map((s) => s.trim()).filter(Boolean) : null,
        scopeLabel: scopeLabel(scope),
        workDir: goalRecord.work_dir,
        log: ctx.log,
        // The job ledger. Handed the live state and a writer, so every contestant, judge and synthesis
        // dispatch is on disk BEFORE its child exists — a fan-out recorded only on return cannot be
        // resumed without risking a duplicate dispatch.
        state,
        persist: (s) => { state = writeRunState(runDir, s); },
      });
      contestRecord = outcome.contest;
      state.planning = { ...(state.planning || {}), contest: contestRecord };
      planDoc = outcome.plan;
      planErrors = outcome.errors;
      plannerSeat = outcome.seat;
    }

    if (planDoc === null && planErrors.length === 0) {
      // Single-planner path — also the contest's documented degradation.
      // A preset's planner seat replaces the resolver entirely — that determinism IS the feature.
      const pinnedPlanner = presetSeat(preset, 'plan', executors);
      plannerSeat = pinnedPlanner || selectExecutor({
        executors, prefer, hostCli, requested: requestedExecutor || null, role: 'plan', tier: requestedTier,
      });
      const prompt = buildPlannerPrompt({
        goal: goalText,
        workDir: goalRecord.work_dir,
        scope: scopeLabel(scope),
        requirementDocs,
        executors: executorSummaries,
      });
      writePrompt(runDir, 'planner', prompt);
      const plannerTier = plannerSeat.tier || requestedTier;
      state.planning.single_request = { executor: plannerSeat.name, tier: plannerTier,
        preset: preset ?? null, preset_default: configuredDefault };
      state = writeRunState(runDir, state);
      ctx.log(`goal plan: planning with ${plannerSeat.name} at the ${plannerTier} tier (read-only)`
        + `${preset ? ` [preset ${preset.preset} via ${presetOrigin}]` : ''}`);
      state = beginPlanningChild(runDir, state, 'planner-initial', 'planner');
      const session = await runPlanningSession({
        name: plannerSeat.name,
        spec: plannerSeat.spec,
        tier: plannerTier,
        ...(plannerSeat.from_preset ? { model: plannerSeat.model, invokeId: plannerSeat.invoke_id } : {}),
        ...(plannerSeat.from_preset ? { effort: plannerSeat.effort } : {}),
        prompt,
        runDir,
        cwd: ctx.repoRoot,
        onSpawn: planningSpawn(runDir, state, 'planner-initial'),
      });
      state = settlePlanningChild(runDir, state, 'planner-initial', session);
      writeTranscript(runDir, 'planner', session.invocation);
      planDoc = session.plan;
      planErrors = session.errors;

      // A planner that timed out, crashed or returned an unusable document has produced nothing and
      // touched nothing, so ONE fresh fallback session may try — and only one. Cycling providers
      // until something parses is how a run burns its budget and still has no plan.
      if (planDoc === null && preset) {
        const gate = fallbackAllowed({ snapshot: preset, failureClass: 'retryable-runtime' });
        if (gate.allowed) {
          try {
            const sub = selectFallbackSeat({
              executors, prefer, hostCli, role: 'plan', tier: plannerTier, failedExecutor: plannerSeat.name,
            });
            state = recordRoutingEvent(state, routingEvent({
              role: 'plan',
              primary: plannerSeat,
              failureClass: 'retryable-runtime',
              reason: planErrors.join('; ') || 'the planning session produced no usable plan',
              actual: sub,
              at: bangkokTimestamp(Date.now()),
            }));
            state = writeRunState(runDir, state);
            ctx.log(`goal plan: the pinned planner produced no usable plan; one fallback on ${sub.name} · ${plannerTier}`);
            state = beginPlanningChild(runDir, state, 'planner-fallback', 'planner');
            const retry = await runPlanningSession({
              name: sub.name, spec: sub.spec, tier: plannerTier, prompt, runDir, cwd: ctx.repoRoot,
              onSpawn: planningSpawn(runDir, state, 'planner-fallback'),
            });
            state = settlePlanningChild(runDir, state, 'planner-fallback', retry);
            writeTranscript(runDir, 'planner-fallback', retry.invocation);
            if (retry.plan !== null) {
              planDoc = retry.plan;
              planErrors = [];
              plannerSeat = sub;
            }
          } catch { /* no substitute planner; the original failure stands */ }
        }
      }
    }

    if (planDoc === null) {
      const advice = await consultRecovery({ repoRoot: ctx.repoRoot, runDir, state, preset,
        executors, id: 'planner-invalid', facts: recoveryFacts({ phase: 'planning',
          failure_kind: 'planner-invalid', reason: planErrors.join('; ') || 'planner produced no valid plan',
          artifact_refs: ['run.json', 'prompts/planner.md', 'transcripts/planner.log'] }) });
      state = advice.state;
      state = commit(runDir, state, toNeedsUser(state, {
        reason: 'the planning session did not produce a valid plan',
        findings: [...planErrors, ...(advisoryNote(advice.call) ? [advisoryNote(advice.call)] : [])],
        next: 'fix the cause, then run `goal plan` again — an invalid plan is never dispatched',
      }));
      return finish(ctx, runDir, state, flags, 'planning failed');
    }

    return await finishPlanning({
      ctx,
      runDir,
      runId,
      state,
      setState: (next) => { state = next; },
      goalRecord,
      goalText,
      executors,
      prefer,
      hostCli,
      requestedTier,
      scope,
      createdAt,
      planDoc,
      plannerSeat,
      contestRecord,
      preset,
      presetDefault: configuredDefault,
      flags,
      noCritique: flags['no-critique'] === true,
    });
  } finally {
    // Re-READ before clearing the lease. When an exception escaped the loop, `state` in this scope is
    // whatever it was before the failing call — the loop's own last transition (divergence, a
    // needs_user record) was already persisted, and writing this stale copy over it would erase
    // exactly the evidence the operator needs. run.json is the authority, so the authority is what
    // gets amended.
    try {
      const onDisk = readRunState(runDir);
      clearLease(onDisk);
      writeRunState(runDir, onDisk);
    } catch { /* releasing the lock matters more than the bookkeeping */ }
    releaseRunLease(runDir, lease.nonce);
  }
}

/**
 * Continue an interrupted planning phase in the SAME run.
 *
 * Called by `goal resume` once it has classified every planning job: live children are left alone and
 * foreign or unverifiable ownership has already gone to `needs_user`, so what reaches here is a run
 * whose remaining work is safe to do. The contest is re-entered with `resume: true`, which folds every
 * settled job's artifact off disk by its deterministic id and dispatches only what was never
 * dispatched or has a retry left.
 *
 * A run with NO job ledger was a single-planner run: there is nothing to fold, and the caller says so
 * rather than silently re-planning under a fresh digest.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {string} runDir
 * @param {object} loadedState
 * @param {object} flags
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function continuePlanning(ctx, runDir, loadedState, flags) {
  const goalRecord = readJsonIfPresent(goalPaths(runDir).goal);
  if (!goalRecord) {
    throw new SidekicksError(
      `goal resume: ${RELATIVE(ctx.repoRoot, goalPaths(runDir).goal)} is missing, so the goal this run `
      + 'was planning cannot be recovered — nothing is inferred from the artifacts',
      EXIT_VALIDATION,
    );
  }

  const settings = readSettings(ctx.repoRoot);
  const scope = resolveWorkingFolder(settings, ctx.repoRoot);
  const executionView = executionConsumers(resolveExecutionSnapshot(ctx.repoRoot, settings));
  const { executors, prefer } = executionView;
  const hostCli = currentHostCli(flagString(flags['host-cli']));
  const request = loadedState.planning?.contest_request || {};
  const requestedTier = typeof request.tier === 'string' && request.tier !== '' ? request.tier : 'high';

  let state = loadedState;
  const lease = acquireRunLease(runDir);
  try {
    stampLease(state, { nonce: lease.nonce });
    state = writeRunState(runDir, state);

    const { runContest } = await import('./contest.mjs');
    const outcome = await runContest({
      repoRoot: ctx.repoRoot,
      runDir,
      runId: state.run_id,
      goalText: goalRecord.goal,
      goalRecord,
      executors,
      prefer,
      hostCli,
      planners: Array.isArray(request.planners) ? request.planners : null,
      scopeLabel: scopeLabel(scope),
      workDir: goalRecord.work_dir,
      log: ctx.log,
      resume: true,
      state,
      persist: (s) => { state = writeRunState(runDir, s); },
    });
    const contestRecord = outcome.contest;
    state.planning = { ...(state.planning || {}), contest: contestRecord };

    if (outcome.plan === null) {
      state = commit(runDir, state, toNeedsUser(state, {
        reason: outcome.errors.length > 0
          ? 'the resumed contest could not produce a valid plan'
          : 'the resumed contest produced no comparable candidate',
        findings: outcome.errors,
        next: 'the completed candidates remain under plan-candidates/; fix the cause, then resume again',
      }));
      return finish(ctx, runDir, state, flags, 'resumed planning failed');
    }

    return await finishPlanning({
      ctx,
      runDir,
      runId: state.run_id,
      state,
      setState: (next) => { state = next; },
      goalRecord,
      goalText: goalRecord.goal,
      executors,
      prefer,
      hostCli,
      requestedTier,
      scope,
      createdAt: goalRecord.created_at,
      planDoc: outcome.plan,
      plannerSeat: outcome.seat,
      contestRecord,
      flags,
      noCritique: false,
    });
  } finally {
    try {
      const onDisk = readRunState(runDir);
      clearLease(onDisk);
      writeRunState(runDir, onDisk);
    } catch { /* releasing the lock matters more than the bookkeeping */ }
    releaseRunLease(runDir, lease.nonce);
  }
}

/** Fold the persisted single-seat checkpoint without replaying a dispatched child. */
export async function continueSinglePlanning(ctx, runDir, loadedState, flags) {
  const goalRecord = readJsonIfPresent(goalPaths(runDir).goal);
  if (!goalRecord) throw new SidekicksError('goal resume: goal record is missing', EXIT_VALIDATION);
  const settings = readSettings(ctx.repoRoot);
  const scope = resolveWorkingFolder(settings, ctx.repoRoot);
  const executionView = executionConsumers(resolveExecutionSnapshot(ctx.repoRoot, settings));
  const { executors } = executionView;
  const request = loadedState.planning.single_request;
  if (!request || !executors[request.executor]) {
    throw new SidekicksError('goal resume: persisted planner seat is unavailable', EXIT_VALIDATION);
  }
  const jobs = loadedState.planning.jobs || {};
  const lastCorrection = Object.values(jobs).filter((job) => job.kind === 'planner'
    && job.id.startsWith('planner-correction-')).at(-1);
  const correctionId = `planner-correction-${loadedState.planning.critique_passes}`;
  if (loadedState.phase === 'planning' && loadedState.planning.epoch_passes > 0
    && !loadedState.planning.continue_epoch && !jobs[correctionId]
    && loadedState.planning.current_plan) {
    const lastCritic = Object.values(jobs).filter((job) => job.kind === 'critic'
      && job.folded === true && job.result?.verdict === 'correct').at(-1);
    if (!lastCritic) throw new SidekicksError('goal resume: correction has no settled critic', EXIT_VALIDATION);
    const prompt = buildCorrectionPrompt({
      goal: goalRecord.goal, planJson: JSON.stringify(loadedState.planning.current_plan, null, 2),
      findings: lastCritic.result.findings, pass: loadedState.planning.epoch_passes,
      maxPasses: MAX_CRITIQUE_PASSES, priorFindings: loadedState.planning.prior_findings,
    }) + (advisoryNote(loadedState.advisory?.calls?.[`plan-review-${loadedState.planning.review_epoch - 1}`])
      ? `\n\n## Read-only recovery suggestion\n${advisoryNote(loadedState.advisory.calls[`plan-review-${loadedState.planning.review_epoch - 1}`])}\n`
      : '');
    writePrompt(runDir, correctionId, prompt);
    const lease = acquireRunLease(runDir);
    try {
      stampLease(loadedState, { nonce: lease.nonce });
      const seat = executors[request.executor];
      let state = beginPlanningChild(runDir, loadedState, correctionId, 'planner');
      const result = await runPlanningSession({
        name: request.executor, spec: seat, tier: request.tier, prompt, runDir, cwd: ctx.repoRoot,
        onSpawn: planningSpawn(runDir, state, correctionId),
      });
      state = settlePlanningChild(runDir, state, correctionId, result);
      writeTranscript(runDir, correctionId, result.invocation);
    } finally {
      try { const onDisk = readRunState(runDir); clearLease(onDisk); writeRunState(runDir, onDisk); }
      catch { /* preserve the authoritative state */ }
      releaseRunLease(runDir, lease.nonce);
    }
    return continueSinglePlanning(ctx, runDir, readRunState(runDir), flags);
  }
  const source = loadedState.phase === 'planning'
    ? (lastCorrection && !lastCorrection.folded ? lastCorrection
      : (!loadedState.planning.current_plan ? jobs['planner-fallback'] || jobs['planner-initial'] : null))
    : null;
  if (source?.substate === 'pending') {
    const promptName = source.id === 'planner-initial' ? 'planner' : source.id;
    const promptPath = joinPath(runDir, 'prompts', `${promptName}.md`);
    if (!existsSync(promptPath)) throw new SidekicksError('goal resume: reserved planner prompt is missing', EXIT_VALIDATION);
    const lease = acquireRunLease(runDir);
    try {
      stampLease(loadedState, { nonce: lease.nonce });
      const result = await runPlanningSession({
        name: request.executor, spec: executors[request.executor], tier: request.tier,
        prompt: readFileSync(promptPath, 'utf8'), runDir, cwd: ctx.repoRoot,
        onSpawn: planningSpawn(runDir, loadedState, source.id),
      });
      settlePlanningChild(runDir, loadedState, source.id, result);
      writeTranscript(runDir, promptName, result.invocation);
    } finally {
      try { const onDisk = readRunState(runDir); clearLease(onDisk); writeRunState(runDir, onDisk); }
      catch { /* preserve the authoritative state */ }
      releaseRunLease(runDir, lease.nonce);
    }
    return continueSinglePlanning(ctx, runDir, readRunState(runDir), flags);
  }
  if (source && (source.substate !== 'completed' || !source.result?.plan)) {
    if (source.substate === 'completed' || source.substate === 'failed') {
      const state = commit(runDir, loadedState, toNeedsUser(loadedState, {
        reason: 'the settled planning child did not produce a valid plan',
        findings: source.result?.errors || [],
        next: 'inspect the recorded result and start a fresh goal plan',
      }));
      return finish(ctx, runDir, state, flags, 'planning failed');
    }
    throw new SidekicksError('goal resume: planner ownership is not settled', EXIT_VALIDATION);
  }
  const planDoc = source?.result?.plan || loadedState.planning.current_plan;
  if (!planDoc) throw new SidekicksError('goal resume: persisted review plan is missing', EXIT_VALIDATION);
  let state = loadedState;
  const lease = acquireRunLease(runDir);
  try {
    stampLease(state, { nonce: lease.nonce });
    if (source) source.folded = true;
    state.planning.current_plan = planDoc;
    state.planning.continue_epoch = false;
    state = writeRunState(runDir, state);
    return await finishPlanning({
      ctx, runDir, runId: state.run_id, state, setState: (next) => { state = next; },
      goalRecord, goalText: goalRecord.goal, executors, prefer: executionView.prefer,
      hostCli: currentHostCli(flagString(flags['host-cli'])), requestedTier: request.tier,
      scope, createdAt: goalRecord.created_at, planDoc,
      plannerSeat: { name: request.executor, spec: executors[request.executor] },
      contestRecord: null, preset: request.preset, presetDefault: request.preset_default,
      flags, noCritique: false, resumeReview: state.phase === 'plan_review',
    });
  } finally {
    try { const onDisk = readRunState(runDir); clearLease(onDisk); writeRunState(runDir, onDisk); }
    catch { /* preserve the authoritative state */ }
    releaseRunLease(runDir, lease.nonce);
  }
}

/**
 * Everything after a plan document exists: critique, envelope, digest, approval offer.
 *
 * Shared by `goal plan` and by a resumed planning phase, so the two cannot drift into offering
 * differently-assembled envelopes for the same plan — the digest an operator approves has to be a
 * function of the plan and the checkouts, never of which verb happened to produce it.
 *
 * @param {object} input
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
async function finishPlanning(input) {
  const { ctx, runDir, runId, flags, goalRecord, scope, createdAt } = input;
  let state = input.state;
  let planDoc = input.planDoc;
  const { plannerSeat, contestRecord, executors, prefer, hostCli, requestedTier } = input;
  const preset = input.preset ?? null;
  const commitState = (transition) => {
    state = commit(runDir, state, transition);
    input.setState(state);
    return state;
  };

  // ---- critique --------------------------------------------------------------------------------
  let digest = planDigest(planDoc);
  state.planning.current_plan = planDoc;
  state = writeRunState(runDir, state);
  if (!input.resumeReview) commitState(toPlanReview(state, { plan_digest: digest }));

  if (!input.noCritique) {
    let outcome;
    try { outcome = await critiqueLoop({
      ctx,
      runDir,
      goalText: input.goalText,
      executors,
      prefer,
      hostCli,
      tier: requestedTier,
      preset,
      authorFamily: plannerSeat ? resolveFamily(plannerSeat.name, plannerSeat.spec) : null,
      authorExecutor: plannerSeat ? plannerSeat.name : null,
      plan: planDoc,
      state,
      writePlanState: (next) => { state = next; input.setState(next); },
    }); } catch (err) {
      if (!(err instanceof SidekicksError) || !/(call budget exhausted|STOP gate)/.test(err.message)) throw err;
      outcome = { ok: false, reason: err.message,
        findings: (state.planning?.prior_findings || []).flatMap((entry) => entry.findings) };
    }
    if (!outcome.ok) {
      if (outcome.criticId && state.planning.jobs?.[outcome.criticId]) {
        state.planning.jobs[outcome.criticId].folded = true;
      }
      const advice = await consultRecovery({ repoRoot: ctx.repoRoot, runDir, state, preset,
        executors, id: `plan-review-${state.planning.review_epoch || 1}`,
        facts: recoveryFacts({ phase: 'planning', failure_kind: 'plan-review-blocking',
          reason: outcome.reason, artifact_refs: ['run.json', 'prompts/critic-1.md',
            `prompts/critic-${state.planning.critic_calls || 1}.md`] }) });
      state = advice.state;
      input.setState(state);
      commitState(toNeedsUser(state, {
        reason: outcome.reason,
        findings: [...outcome.findings, ...(advisoryNote(advice.call) ? [advisoryNote(advice.call)] : [])],
        next: 'address the findings, then run `goal plan` again',
      }));
      return finish(ctx, runDir, state, flags, 'plan critique unresolved');
    }
    planDoc = outcome.plan;
    digest = planDigest(planDoc);
    if (outcome.criticId && state.planning.jobs?.[outcome.criticId]) {
      state.planning.jobs[outcome.criticId].folded = true;
    }
  }

  // ---- envelope --------------------------------------------------------------------------------
  // A preset OVERWRITES every node's executor and tier before the envelope is assembled. The plan's
  // author chooses ordering, tests, criteria and write roots; under a preset it does not choose who
  // runs a node. This deliberately changes `plan_digest` — approving a plan is approving WHO runs
  // it, so the seat belongs inside the value the operator signs.
  const implementerSeat = preset ? presetSeat(preset, 'implement', executors) : null;
  if (implementerSeat) {
    planDoc = {
      ...planDoc,
      nodes: (planDoc.nodes || []).map((n) => ({
        ...n,
        executor: implementerSeat.name,
        tier: implementerSeat.tier,
      })),
    };
    digest = planDigest(planDoc);
  }

  const { envelope, owners } = assembleEnvelope({
    repoRoot: ctx.repoRoot,
    plan: planDoc,
    goalDigest: goalDigest(goalRecord),
    planDigest: digest,
    scope: { project: scope.projectName, service: scope.serviceName ?? null },
    budgets: defaultBudgets(),
    actionPolicy: defaultActionPolicy({
      allowedTestCommands: [...new Set(planDoc.nodes.flatMap((n) => n.tests || []))],
    }),
    criterionOwners: criterionOwners(planDoc),
    familyOf: (name) => resolveFamily(name, executors[name] || {}),
    bindingOf: (name, tier) => {
      const spec = executors[name] || {};
      const selected = resolveSelection(name, spec, { tier, ...(implementerSeat ? { effort: implementerSeat.effort } : {}) });
      return { model_ref: selected.model_ref, invoke_id: selected.invoke_id, effort: selected.effort,
        family: resolveModelFamily(name, spec, selected.model_ref || '') };
    },
    orchestrationPreset: preset,
    nodeEffort: implementerSeat ? implementerSeat.effort : null,
  });
  const canonical = canonicalEnvelope(envelope);
  const envCheck = validateEnvelope(canonical);
  if (!envCheck.ok) {
    commitState(toNeedsUser(state, {
      reason: 'the approval envelope could not be assembled from this plan and the current checkouts',
      findings: envCheck.errors,
      next: 'usually a plan whose affected paths do not resolve to a Git checkout',
    }));
    return finish(ctx, runDir, state, flags, 'envelope invalid');
  }
  const envDigest = envelopeDigest(canonical);

  const order = topoOrder(planDoc);
  writeJson(goalPaths(runDir).plan, planDoc);
  writeJson(goalPaths(runDir).envelope, canonical);
  writeAtomicText(goalPaths(runDir).planMd, renderPlanMarkdown(planDoc, {
    runId,
    planDigest: digest,
    envelopeDigest: envDigest,
    createdAt,
    contest: contestRecord,
    order: order.ok ? order.order : undefined,
  }));

  commitState(toAwaitingApproval(state, {
    envelope: canonical,
    envelope_digest: envDigest,
    plan_digest: digest,
  }));

  const summary = renderApprovalSummary({
    runId,
    envelope: canonical,
    envelopeDigest: envDigest,
    planPath: RELATIVE(ctx.repoRoot, goalPaths(runDir).planMd),
    contest: contestRecord,
  });

  // The default is configuration, not something this operator typed on this command line, so the
  // run says out loud that it was picked up — `ctx.log` only speaks under --verbose, and a preset
  // nobody asked for must never arrive silently.
  const fromDefault = preset && input.presetDefault
    ? `note: no --preset was given, so the repo's default_preset '${preset.preset}' `
      + '(root) is bound — its frozen seats are below.\n'
      + '      Re-plan with --no-preset to route without it.\n\n'
    : '';

  if (flags.json === true) {
    return {
      stdout: `${JSON.stringify({
        run_id: runId,
        run_dir: RELATIVE(ctx.repoRoot, runDir),
        phase: state.phase,
        plan_digest: digest,
        envelope_digest: envDigest,
        orchestration_preset: preset?.preset ?? null,
        orchestration_preset_source: preset ? (input.presetDefault ? 'default_preset' : 'flag') : null,
        nodes: planDoc.nodes.map((n) => n.id),
        checkouts: canonical.checkouts,
        write_roots: canonical.write_roots,
        owners_assessed: owners.map((o) => ({ path: o.path, branch: o.branch, protected: o.protected })),
        contest: contestRecord,
        approve: `sidekicks goal approve ${runId} --digest ${envDigest}`,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }
  return { stdout: fromDefault + summary, exitCode: EXIT_OK };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The bounded plan/critique loop.
 *
 * The cap is enforced by the state machine (`toPlanCorrection` refuses a third pass), not by this
 * loop's counter — so a future caller that forgets to count cannot spin.
 *
 * @param {object} input
 * @returns {Promise<{ok: boolean, plan: object|null, reason: string, findings: string[]}>}
 */
async function critiqueLoop(input) {
  const { ctx, runDir } = input;
  let plan = input.plan;
  let state = input.state;

  while (true) {
    const pass = Number(state.planning?.critique_passes ?? 0);
    let critic;
    try {
      // The plan critic is the preset's REVIEWER seat: the operator already answered "who checks
      // this work", and answering it a second time with the resolver would mean the seat that
      // critiques the plan and the seat that reviews the code it produces could differ.
      const pinnedCritic = presetSeat(input.preset, 'review', input.executors);
      critic = pinnedCritic
        ? { ...pinnedCritic, same_family_fallback: false }
        : selectIndependentExecutor({
          executors: input.executors,
          prefer: input.prefer,
          hostCli: input.hostCli,
          role: 'review',
          tier: input.tier,
          avoidFamily: input.authorFamily,
          avoidExecutor: input.authorExecutor,
          familyOf: resolveFamily,
      });
    } catch (err) {
      // No seat can review. Better to say so than to let the plan's own author approve it.
      return { ok: false, plan: null, reason: `no executor can review the plan: ${err.message}`, findings: [] };
    }

    const prompt = buildCriticPrompt({
      goal: input.goalText,
      planJson: JSON.stringify(plan, null, 2),
      workDir: '.',
    });
    const previousCritic = Object.values(state.planning?.jobs || {}).filter((job) =>
      job.kind === 'critic' && job.folded !== true
      && (job.substate === 'completed' || job.substate === 'failed')).at(-1);
    const criticId = previousCritic?.id || `critic-${Number(state.planning?.critic_calls ?? 0) + 1}`;
    writePrompt(runDir, criticId, prompt);
    ctx.log(
      `goal plan: critique pass ${pass + 1} with ${critic.name} (${critic.family ?? '?'})`
      + `${critic.same_family_fallback ? ' — SAME FAMILY as the author, recorded as a fallback' : ''}`,
    );

    let session;
    if (previousCritic) {
      if (!previousCritic.result || !Array.isArray(previousCritic.result.findings)) {
        throw new SidekicksError('goal resume: settled critic has no foldable result', EXIT_VALIDATION);
      }
      session = previousCritic.result;
    } else {
      state = beginPlanningChild(runDir, state, criticId, 'critic');
      input.writePlanState(state);
      session = await runCritiqueSession({
      name: critic.name,
      spec: critic.spec,
      tier: critic.tier || input.tier,
      ...(critic.from_preset ? { effort: critic.effort } : {}),
      ...(critic.from_preset ? { model: critic.model, invokeId: critic.invoke_id } : {}),
      prompt,
      runDir,
      cwd: ctx.repoRoot,
      onSpawn: planningSpawn(runDir, state, criticId),
      });
      state = settlePlanningChild(runDir, state, criticId, session);
      input.writePlanState(state);
      writeTranscript(runDir, criticId, session.invocation);
    }

    // Same rule as the planner: one fresh fallback critic, then the user. A critic that returned no
    // verdict has judged nothing, and the plan's own author must never be the one to approve it.
    if (!session.ok && input.preset) {
      const gate = fallbackAllowed({ snapshot: input.preset, failureClass: 'retryable-runtime' });
      if (gate.allowed) {
        try {
          const sub = selectFallbackSeat({
            executors: input.executors,
            prefer: input.prefer,
            hostCli: input.hostCli,
            role: 'review',
            tier: critic.tier || input.tier,
            failedExecutor: critic.name,
            avoidFamily: input.authorFamily,
            independent: true,
          });
          state = recordRoutingEvent(state, routingEvent({
            role: 'review',
            primary: critic,
            failureClass: 'retryable-runtime',
            reason: session.errors.join('; ') || 'the plan critic returned no usable verdict',
            actual: sub,
            at: bangkokTimestamp(Date.now()),
          }));
          input.writePlanState(state);
          ctx.log(`goal plan: the pinned critic returned no verdict; one fallback critique on ${sub.name}`);
          const fallbackId = `${criticId}-fallback`;
          state = beginPlanningChild(runDir, state, fallbackId, 'critic');
          input.writePlanState(state);
          session = await runCritiqueSession({
            name: sub.name, spec: sub.spec, tier: sub.tier, prompt, runDir, cwd: ctx.repoRoot,
            onSpawn: planningSpawn(runDir, state, fallbackId),
          });
          state = settlePlanningChild(runDir, state, fallbackId, session);
          input.writePlanState(state);
          writeTranscript(runDir, fallbackId, session.invocation);
        } catch { /* no substitute critic; the unusable verdict stands */ }
      }
    }

    if (!session.ok) {
      return { ok: false, plan: null, reason: 'the plan critic returned no usable verdict', findings: session.errors, criticId };
    }
    if (session.verdict === 'approve') {
      return { ok: true, plan, reason: '', findings: [], criticId };
    }

    const blocking = session.findings.filter((f) => f.severity === 'blocking');
    const findingLines = blocking.map((f) => `${f.node ? `[${f.node}] ` : ''}${f.what} → ${f.fix}`);
    if (!state.planning.jobs?.[criticId]?.findings_recorded) {
      state.planning.prior_findings = [...(state.planning.prior_findings || []),
        { epoch: state.planning.review_epoch, pass: state.planning.epoch_passes,
          findings: findingLines, plan_digest: planDigest(plan) }];
      if (state.planning.jobs?.[criticId]) state.planning.jobs[criticId].findings_recorded = true;
      state = writeRunState(runDir, state);
    }

    // The state machine refuses the pass past the cap; that refusal is the loop's exit.
    let corrected;
    try {
      corrected = toPlanCorrection(state, { findings: findingLines, max_passes: MAX_CRITIQUE_PASSES });
    } catch {
      return {
        ok: false,
        plan: null,
        reason: `the plan critic still reports ${blocking.length} blocking finding(s) after `
          + `${MAX_CRITIQUE_PASSES} correction passes`,
        findings: findingLines,
        criticId,
      };
    }
    if (state.planning.jobs?.[criticId]) state.planning.jobs[criticId].folded = true;
    state = commit(runDir, state, corrected);
    input.writePlanState(state);

    const pinnedAuthor = presetSeat(input.preset, 'plan', input.executors);
    const author = pinnedAuthor || selectExecutor({
      executors: input.executors,
      prefer: input.prefer,
      hostCli: input.hostCli,
      requested: input.authorExecutor,
      role: 'plan',
      tier: input.tier,
    });
    const fixPrompt = buildCorrectionPrompt({
      goal: input.goalText,
      planJson: JSON.stringify(plan, null, 2),
      findings: blocking,
      pass: state.planning.epoch_passes,
      maxPasses: MAX_CRITIQUE_PASSES,
      priorFindings: state.planning.prior_findings,
    });
    writePrompt(runDir, `planner-correction-${state.planning.critique_passes}`, fixPrompt);
    const correctionId = `planner-correction-${state.planning.critique_passes}`;
    state = beginPlanningChild(runDir, state, correctionId, 'planner');
    input.writePlanState(state);
    const redo = await runPlanningSession({
      name: author.name,
      spec: author.spec,
      tier: author.tier || input.tier,
      ...(author.from_preset ? { effort: author.effort } : {}),
      prompt: fixPrompt,
      runDir,
      cwd: ctx.repoRoot,
      onSpawn: planningSpawn(runDir, state, correctionId),
    });
    state = settlePlanningChild(runDir, state, correctionId, redo);
    writeTranscript(runDir, `planner-correction-${state.planning.critique_passes}`, redo.invocation);
    if (redo.plan === null) {
      return {
        ok: false,
        plan: null,
        reason: 'the correction pass did not produce a valid plan',
        findings: redo.errors,
      };
    }
    plan = redo.plan;
    state.planning.current_plan = plan;
    if (state.planning.jobs?.[correctionId]) state.planning.jobs[correctionId].folded = true;
    state = writeRunState(runDir, state);
    state = commit(runDir, state, toPlanReview(state, { plan_digest: planDigest(plan) }));
    input.writePlanState(state);
  }
}

/**
 * Persist a transition: state first (it is the authority), then the sidecar event.
 *
 * A failed append records divergence and the caller halts. State is never rolled back to match the
 * sidecar — a fabricated history reads as evidence, which is worse than a gap.
 *
 * @param {string} runDir
 * @param {object} _prev
 * @param {{state: object, event: object}} transition
 * @returns {object} the persisted state
 */
export function commit(runDir, _prev, transition) {
  let state = writeRunState(runDir, transition.state);
  const appended = appendGoalEvent(runDir, transition.event);
  if (!appended.ok) {
    stampDivergence(state, { event: transition.event.event, error: appended.error });
    state = writeRunState(runDir, state);
  }
  return state;
}

/**
 * Read the goal from a quoted string or a file path.
 *
 * A path is detected by EXISTENCE, not by shape: `goal plan "docs/req.md"` should read the file, and
 * `goal plan "add a widget"` should not go looking for one.
 *
 * @param {string} repoRoot
 * @param {string} arg
 * @returns {{goalText: string, requirementDocs: string[]}}
 */
export function readGoal(repoRoot, arg) {
  const abs = isAbsolute(arg) ? arg : resolvePath(repoRoot, arg);
  if (!arg.includes('\n') && arg.length < 512 && existsSync(abs)) {
    const text = readFileSync(abs, 'utf8').trim();
    if (text === '') {
      throw new SidekicksError(`goal plan: '${arg}' is empty`, EXIT_VALIDATION);
    }
    return { goalText: text, requirementDocs: [RELATIVE(repoRoot, abs)] };
  }
  return { goalText: arg, requirementDocs: [] };
}

/** A human label for the active scope. */
function scopeLabel(scope) {
  return scope.serviceName
    ? `project ${scope.projectName}, service ${scope.serviceName}`
    : `project ${scope.projectName}`;
}

/** Persist a prompt so the run's evidence includes what was actually asked. */
function writePrompt(runDir, name, prompt) {
  const dir = `${runDir}/prompts`;
  mkdirp(dir);
  writeAtomicText(`${dir}/${name}.md`, prompt);
}

/**
 * Persist a session's transcript and its routing metadata.
 *
 * The transcript is the raw stdout/stderr; the metadata is what the report cites. Kept as two files
 * because one is for a human reading a failure and the other is machine-read.
 */
function writeTranscript(runDir, name, invocation) {
  if (!invocation) return;
  const dir = `${runDir}/transcripts`;
  mkdirp(dir);
  writeAtomicText(`${dir}/${name}.log`, `${invocation.stdout ?? ''}\n--- stderr ---\n${invocation.stderr ?? ''}\n`);
  const { stdout, stderr, args, ...meta } = invocation;
  writeJson(`${dir}/${name}.json`, meta);
}

/**
 * The one text-artifact writer, so every file this verb produces is written the same crash-safe way.
 *
 * @param {string} path
 * @param {string} text
 */
function writeAtomicText(path, text) {
  writeAtomic(path, text.endsWith('\n') ? text : `${text}\n`);
}

/** Emit the terminal report for a run that stopped short of approval. */
function finish(ctx, runDir, state, flags, reason) {
  const payload = {
    run_id: state.run_id,
    run_dir: RELATIVE(ctx.repoRoot, runDir),
    phase: state.phase,
    reason,
    needs_user: state.needs_user ?? null,
  };
  if (flags.json === true) {
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_VALIDATION };
  }
  const lines = [
    `goal run ${state.run_id} — ${state.phase}`,
    '',
    `  ${reason}`,
  ];
  for (const f of state.needs_user?.findings || []) lines.push(`    - ${f}`);
  if (state.needs_user?.next) lines.push(`  next: ${state.needs_user.next}`);
  lines.push('');
  lines.push(`  run folder: ${payload.run_dir}`);
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_VALIDATION };
}
