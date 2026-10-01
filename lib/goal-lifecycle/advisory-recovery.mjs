// Bounded, durable diagnostic consultations. Advice cannot alter the state machine, routing or gates.
import { hostname } from 'node:os';
import { join } from 'node:path';
import { invokeExecutor } from '../cli-executor-lifecycle/invoke.mjs';
import { RECOVERY_ADVICE_SCHEMA, validateRecoveryAdvice, validateRecoveryFacts } from '../cli-executor-lifecycle/advice.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { findAbsolutePath } from '../run-events/schema.mjs';
import { writeSchemaFile } from './planner.mjs';
import { mkdirp, stopPresent, writeJson, writeRunState } from './store.mjs';

export const ADVISORY_LIMITS = Object.freeze({ planning: 2, execution: 2 });

export function classifyAdvisoryCalls(state, { hostname: here, aliveCheck }) {
  return Object.values(state.advisory?.calls || {})
    .filter((call) => ['pending', 'dispatched'].includes(call.substate))
    .map((call) => ({ call, verdict: call.substate === 'pending' ? 'unspawned'
      : call.hostname !== here || !Number.isInteger(call.pid) || call.pid <= 0 ? 'unknown'
        : aliveCheck(call.pid) ? 'live' : 'dead' }));
}

export function recoveryFacts({ phase, failure_kind, reason, artifact_refs }) {
  const normalized = { phase, failure_kind,
    reason: findAbsolutePath(reason) ? 'Failure details are in the cited artifacts' : reason,
    artifact_refs };
  if (!validateRecoveryFacts(normalized)) {
    throw new Error('invalid structured recovery facts or artifact references');
  }
  return { ...normalized, reason: normalized.reason.slice(0, 1000) };
}

/** A consultation is charged before spawn. An interrupted call is never silently repeated. */
export async function consultRecovery({ repoRoot, runDir, state, preset, executors, facts, id,
  invoke = invokeExecutor, approvedPolicy = null }) {
  const seat = preset?.roles?.advisor;
  if (!seat || stopPresent(runDir)) return { state, call: null };
  const advisory = state.advisory || { planning_calls: 0, execution_calls: 0, calls: {} };
  const key = `${facts.phase}_calls`;
  const limit = Math.min(ADVISORY_LIMITS[facts.phase],
    advisory.policy?.[`${facts.phase}_max_calls`] ?? 0,
    facts.phase === 'execution' && approvedPolicy
      ? (approvedPolicy.execution_max_calls ?? 0) : ADVISORY_LIMITS[facts.phase]);
  if (advisory[key] >= limit || advisory.calls[id]) return { state, call: null };
  const spec = executors[seat.executor];
  const call = { id, purpose: 'recovery-advice', facts, seat: {
    executor: seat.executor, model: seat.model, invoke_id: seat.invoke_id, effort: seat.effort,
  }, substate: 'pending', pid: null, hostname: null, requested_at: bangkokTimestamp(Date.now()) };
  advisory[key] += 1;
  advisory.calls[id] = call;
  state.advisory = advisory;
  state = writeRunState(runDir, state);
  if (stopPresent(runDir)) {
    call.substate = 'failed'; call.error = 'STOP gate appeared before advisor dispatch';
    call.ended_at = bangkokTimestamp(Date.now());
    return { state: writeRunState(runDir, state), call };
  }
  if (!spec || spec.enabled === false) {
    call.substate = 'failed'; call.error = 'frozen advisor executor is unavailable';
    return { state: writeRunState(runDir, state), call };
  }
  const prompt = `You are a read-only recovery advisor. You cannot approve, dispatch, change routing,`
    + ` relax a gate, or increase a budget. Return 1-3 evidence-backed alternatives and one selected`
    + ` recommended_id. Every evidence_refs entry MUST be an artifact_refs value below.\n\n`
    + `${JSON.stringify(facts, null, 2)}\n`;
  try {
    const schema = writeSchemaFile(runDir, `recovery-${id}`, RECOVERY_ADVICE_SCHEMA,
      { executor: seat.executor, spec });
    mkdirp(join(runDir, 'advisory'));
    writeJson(join(runDir, 'advisory', `${id}.request.json`), { facts, prompt, seat: call.seat });
    const result = await invoke({ name: seat.executor, spec, role: 'plan', tier: 'top',
      model: seat.model, invokeId: seat.invoke_id, effort: seat.effort, cwd: repoRoot, prompt,
      schemaPath: schema.path, schemaJson: schema.json,
      onSpawn: ({ pid }) => {
        call.substate = 'dispatched'; call.pid = pid; call.hostname = hostname();
        call.execution_transport = 'external-cli';
        call.dispatched_at = bangkokTimestamp(Date.now());
        writeRunState(runDir, state);
      },
    });
    if (result.execution_transport && !call.execution_transport) {
      call.execution_transport = result.execution_transport;
    }
    let answer = result.result;
    if (result.ok && !answer && typeof result.result_text === 'string') {
      try { answer = JSON.parse(result.result_text); } catch { /* validation below fails closed */ }
    }
    const check = result.ok ? validateRecoveryAdvice(answer, facts.artifact_refs)
      : { ok: false, reason: result.failure_kind || result.error || 'advisor invocation failed' };
    call.substate = check.ok ? 'completed' : 'failed';
    call.result = check.ok ? answer : null;
    call.recommendation = check.ok ? check.recommendation : null;
    call.error = check.ok ? null : (findAbsolutePath(check.reason) ? 'advisor failed; inspect cited artifacts' : check.reason);
    writeJson(join(runDir, 'advisory', `${id}.result.json`), {
      ok: check.ok, output: check.ok ? answer : null, error: call.error,
    });
  } catch (error) {
    call.substate = 'failed'; call.error = `advisor invocation failed (${error.name || 'Error'})`;
  }
  call.ended_at = bangkokTimestamp(Date.now());
  return { state: writeRunState(runDir, state), call };
}

export function advisoryNote(call) {
  const choice = call?.recommendation;
  if (!choice) return null;
  return `Read-only advisor suggests ${choice.kind}: ${choice.summary} `
    + `(evidence: ${choice.evidence_refs.join(', ')}). This is diagnostic advice; all normal gates apply.`;
}
