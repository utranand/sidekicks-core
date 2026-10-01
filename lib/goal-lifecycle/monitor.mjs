// Read-only projection plus the bounded monitor driver for a durable goal ledger.
//
// `goal status --monitor` remains observational. `goal monitor --drive` is deliberately a
// separate opt-in surface: it only delegates to the existing resume/run verbs, which retain their
// leases and every normal gate. In particular it never invokes approve or approve-action.
import { hostname } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { goalPositionals, loadRun, parseGoalFlags, RELATIVE } from './commands.mjs';
import { inspectRunLease, readJsonIfPresent, stopPresent, goalPaths } from './store.mjs';
import { run as resumeRun } from './resume.mjs';
import { run as executeRun } from './run.mjs';

export const STALE_AFTER_MS = 120_000;
const TERMINAL = new Set(['done', 'failed']);
const WAITING = new Set(['new', 'awaiting_approval', 'awaiting_action_approval', 'needs_user', 'stopped']);

function elapsed(start, end) {
  const a = Date.parse(start ?? '');
  const b = Date.parse(end ?? '');
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
}

function child(pid, host, localHost, alive) {
  if (host && host !== localHost) return 'foreign';
  if (!Number.isInteger(pid) || pid <= 0) return 'missing';
  if (!host) return 'unknown';
  return alive(pid) ? 'live' : 'dead';
}

function systemAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

export function buildMonitor({ state, envelope = {}, lease, runDir, stopPresent = false,
  now = Date.now(), localHost = hostname(), alive = systemAlive, artifactExists = () => false }) {
  const nowIso = new Date(now).toISOString();
  const terminal = TERMINAL.has(state.phase);
  const heartbeat = state.lease?.heartbeat_at ?? null;
  const lastActivity = heartbeat ?? state.updated_at ?? state.created_at;
  const ageMs = elapsed(lastActivity, nowIso);
  const attempts = Object.entries(state.nodes || {}).flatMap(([node, rec]) =>
    (rec.attempts || []).map((a) => ({
      node, id: a.id, result: a.result, executor: a.executor ?? null,
      execution_transport: a.execution_transport ?? null, hostname: a.hostname ?? state.lease?.hostname ?? null,
      model: a.model ?? null, tier: a.tier ?? null, role: a.role ?? null,
      started_at: a.dispatched_at ?? null, heartbeat_at: heartbeat,
      finished_at: a.ended_at ?? null,
      duration_ms: elapsed(a.dispatched_at, a.ended_at ?? (terminal ? state.updated_at : nowIso)),
      pid: a.pid ?? null, child_liveness: a.ended_at ? 'finished'
        : child(a.pid, a.hostname ?? state.lease?.hostname, localHost, alive),
      failure_class: a.failure_class ?? null, error: a.error ?? null,
      routing_fallback: a.routing_fallback ?? null,
      transcript: a.transcript ?? null, review: a.review ?? null,
    })));
  const jobs = Object.values(state.planning?.jobs || {}).map((j) => ({
    id: j.id, role: j.kind, executor: j.executor ?? null,
    model: j.model ?? null, tier: j.tier ?? null,
    substate: j.substate, started_at: j.dispatched_at ?? null,
    heartbeat_at: heartbeat, finished_at: j.ended_at ?? null,
    duration_ms: elapsed(j.dispatched_at, j.ended_at ?? (terminal ? state.updated_at : nowIso)),
    pid: j.pid ?? null, child_liveness: j.ended_at ? 'finished'
      : j.substate === 'pending' ? 'not-dispatched'
        : child(j.pid, j.hostname, localHost, alive),
    failure_class: j.outcome ?? null, error: j.error ?? null,
    retries: j.retries ?? 0,
  }));
  const advisory = Object.values(state.advisory?.calls || {}).map((c) => ({
    id: c.id, purpose: c.purpose, substate: c.substate,
    execution_transport: c.execution_transport ?? null, pid: c.pid ?? null, hostname: c.hostname ?? null,
    executor: c.seat?.executor ?? null, model: c.seat?.model ?? null,
    tier: 'top', role: 'advisor', requested_at: c.requested_at ?? null,
    started_at: c.dispatched_at ?? null, finished_at: c.ended_at ?? null,
    duration_ms: elapsed(c.dispatched_at ?? c.requested_at, c.ended_at ?? (terminal ? state.updated_at : nowIso)),
    child_liveness: c.ended_at ? 'finished' : c.substate === 'pending' ? 'not-dispatched'
      : child(c.pid, c.hostname, localHost, alive),
    request: c.facts ?? null, decision: c.recommendation ?? null,
    error: c.error ?? null,
    request_ref: /^[\w-]+$/.test(c.id) && artifactExists(`advisory/${c.id}.request.json`)
      ? `advisory/${c.id}.request.json` : null,
    result_ref: /^[\w-]+$/.test(c.id) && artifactExists(`advisory/${c.id}.result.json`)
      ? `advisory/${c.id}.result.json` : null,
  }));
  const current = [
    ...jobs.filter((j) => !j.finished_at && j.substate !== 'pending').map((j) => ({ kind: 'job', id: j.id })),
    ...attempts.filter((a) => !a.finished_at).map((a) => ({ kind: 'attempt', id: a.id, node: a.node })),
    ...advisory.filter((a) => !a.finished_at).map((a) => ({ kind: 'advisory', id: a.id })),
  ];
  const brokenChild = [...jobs, ...attempts, ...advisory].some((r) =>
    !r.finished_at && ['dead', 'missing'].includes(r.child_liveness));
  const unknownOwner = ['foreign', 'malformed'].includes(lease.state)
    || [...jobs, ...attempts, ...advisory].some((r) =>
      !r.finished_at && ['foreign', 'unknown'].includes(r.child_liveness));
  let classification = 'active';
  if (terminal) classification = state.phase === 'done' ? 'completed' : 'finished';
  else if (WAITING.has(state.phase)) classification = 'waiting';
  else if (unknownOwner) classification = 'unknown';
  else if (brokenChild || (lease.state === 'active' && ageMs !== null && ageMs > STALE_AFTER_MS)) {
    classification = 'stalled';
  } else if (['gone', 'reclaimable'].includes(lease.state)
    && ageMs !== null && ageMs > STALE_AFTER_MS) classification = 'stale';

  return {
    run_id: state.run_id, run_dir: runDir, phase: state.phase, classification,
    created_at: state.created_at ?? null, updated_at: state.updated_at ?? null,
    heartbeat_at: heartbeat, finished_at: state.final?.at ?? (terminal ? state.updated_at : null),
    duration_ms: elapsed(state.created_at, state.final?.at ?? (terminal ? state.updated_at : nowIso)),
    last_activity_age_ms: ageMs,
    lease: { state: lease.state, reason: lease.reason, owner: lease.owner ?? null,
      persisted: state.lease ?? null },
    stop_present: stopPresent, current, jobs, attempts, advisory,
    routing: envelope.routing ?? [], routing_fallbacks: state.routing_fallbacks ?? [],
    budgets: envelope.budgets ?? null,
    counters: { spent: state.spent ?? {}, breaker: state.breaker ?? {},
      advisory: { planning_calls: state.advisory?.planning_calls ?? 0,
        execution_calls: state.advisory?.execution_calls ?? 0 } },
    final: state.final ?? null,
  };
}

export function renderMonitor(m) {
  const lines = [`goal run ${m.run_id} — ${m.phase} (${m.classification})`,
    `  lease: ${m.lease.state} · heartbeat: ${m.heartbeat_at ?? 'none'}`,
    `  elapsed: ${m.duration_ms ?? '?'} ms · last activity: ${m.last_activity_age_ms ?? '?'} ms ago`,
    `  current: ${m.current.map((c) => `${c.kind} ${c.id}`).join(', ') || 'none'}`,
    `  budget: ${JSON.stringify(m.budgets)} · counters: ${JSON.stringify(m.counters)}`];
  for (const j of m.jobs) lines.push(`  job ${j.id}: ${j.executor ?? '?'} ${j.model ?? '?'} ${j.tier ?? '?'} ${j.role} ${j.substate} · child ${j.child_liveness} · start ${j.started_at ?? '?'} · finish ${j.finished_at ?? '?'} · ${j.duration_ms ?? '?'} ms`);
  for (const a of m.attempts) lines.push(`  attempt ${a.id}: ${a.executor ?? '?'} ${a.model ?? '?'} ${a.tier ?? '?'} ${a.role ?? '?'} · execution transport ${a.execution_transport ?? 'unknown'} · ${a.result} · child ${a.child_liveness} · start ${a.started_at ?? '?'} · finish ${a.finished_at ?? '?'} · ${a.duration_ms ?? '?'} ms · failure ${a.failure_class ?? 'none'} · transcript ${a.transcript ?? 'none'}`);
  for (const f of m.routing_fallbacks) lines.push(`  fallback ${f.role}: ${f.primary?.executor ?? '?'} → ${f.fallback?.executor ?? '?'} (${f.failure?.class ?? '?'})`);
  for (const a of m.advisory) lines.push(`  advisory ${a.id}: ${a.substate} · ${a.executor ?? '?'} ${a.model ?? '?'} · execution transport ${a.execution_transport ?? 'unknown'} · start ${a.started_at ?? '?'} · finish ${a.finished_at ?? '?'} · ${a.duration_ms ?? '?'} ms · request ${a.request_ref ?? 'none'} · decision ${a.decision?.summary ?? 'none'} · result ${a.result_ref ?? 'none'}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Decide the one safe next step from an observational snapshot. This is intentionally pure so
 * callers and tests can prove an approval/action gate can never become an execution action.
 */
export function monitorDecision(view) {
  if (view.stop_present || view.phase === 'stopped') return { action: 'park', reason: 'STOP gate is present' };
  if (view.phase === 'done' || view.phase === 'failed') return { action: 'complete', reason: 'terminal run' };
  if (view.phase === 'awaiting_approval') return { action: 'park', reason: 'plan approval requires a human-held digest' };
  if (view.phase === 'awaiting_action_approval') return { action: 'park', reason: 'outward or destructive action requires an explicit grant' };
  if (view.phase === 'needs_user') return { action: 'park', reason: 'run recorded a non-automatic decision or safety gate' };
  if (view.classification === 'unknown') return { action: 'park', reason: 'lease or child ownership is foreign or unknown' };
  if (view.lease.state === 'active' || view.current.some((entry) =>
    (entry.kind === 'attempt' || entry.kind === 'job' || entry.kind === 'advisory'))) {
    return { action: 'wait', reason: 'a local run process or child is still active' };
  }
  if (view.phase === 'planning' || view.phase === 'plan_review' || view.classification === 'stalled'
    || view.classification === 'stale') return { action: 'resume', reason: 'reconcile durable state before another dispatch' };
  if (view.phase === 'running' || view.phase === 'final_verification') return { action: 'run', reason: 'approved run is idle and runnable' };
  return { action: 'park', reason: `phase '${view.phase}' has no safe automatic transition` };
}

const BOOLEANS = ['json', 'drive'];

function cyclesFrom(flags) {
  const raw = flags['max-cycles'];
  if (raw === undefined) return 16;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new SidekicksError('goal monitor: --max-cycles must be an integer from 1 to 100', EXIT_VALIDATION);
  }
  return value;
}

function snapshot(repoRoot, runId) {
  const { runDir, state } = loadRun(repoRoot, runId);
  return buildMonitor({ state, runDir: RELATIVE(repoRoot, runDir), lease: inspectRunLease(runDir),
    stopPresent: stopPresent(runDir), envelope: readJsonIfPresent(goalPaths(runDir).envelope) ?? {},
    artifactExists: (relative) => existsSync(join(runDir, relative)) });
}

/**
 * `sidekicks goal monitor <run-id> [--drive] [--max-cycles N] [--json]`.
 * Without --drive it is a one-shot decision report. With --drive it advances only recoverable,
 * already-approved work until it reaches a live child, terminal state, or a gate that must stay
 * human-held. It never waits forever and never self-approves a digest or action.
 */
export async function run(ctx, _args) {
  const flags = parseGoalFlags(ctx.argv, BOOLEANS);
  const runId = goalPositionals(ctx.argv, BOOLEANS)[0];
  if (!runId) throw new SidekicksError('goal monitor: usage: goal monitor <run-id> [--drive] [--max-cycles N] [--json]', EXIT_USAGE);
  const drive = flags.drive === true;
  const maxCycles = cyclesFrom(flags);
  const history = [];
  let view = snapshot(ctx.repoRoot, runId);
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const decision = monitorDecision(view);
    history.push({ cycle, phase: view.phase, classification: view.classification, ...decision });
    if (!drive || !['resume', 'run'].includes(decision.action)) break;
    const childCtx = { ...ctx, argv: ['goal', decision.action, runId, '--json'] };
    try {
      await (decision.action === 'resume' ? resumeRun(childCtx, {}) : executeRun(childCtx, {}));
    } catch (error) {
      if (!(error instanceof SidekicksError)) throw error;
      history.push({ cycle, action: 'park', reason: `automatic ${decision.action} refused: ${error.message}` });
      break;
    }
    view = snapshot(ctx.repoRoot, runId);
  }
  const payload = { run_id: runId, drive, max_cycles: maxCycles, history, monitor: view,
    outcome: history.at(-1)?.action ?? 'observe' };
  if (flags.json === true) return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };
  const lines = [`goal monitor ${runId} — ${payload.outcome}`];
  for (const h of history) lines.push(`  #${h.cycle} ${h.phase} (${h.classification}) → ${h.action}: ${h.reason}`);
  lines.push(`  current: ${view.phase} (${view.classification})`);
  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}
