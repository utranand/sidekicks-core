#!/usr/bin/env node
// gtd-orphan-watch-hook.mjs — SessionStart hook (clear/startup/resume).
//
// Background worker subagents OUTLIVE the session: /clear does not kill them, and their
// completion notifications land in the NEXT session with no context. This hook scans the three
// working-folder anchor shapes for get-things-done queue artifacts that look live (queue
// status: running/idle, or any task in_progress) and injects a context warning so the fresh
// session knows orphan workers/notifications may arrive and how to resume or stop the queue.
//
// Awareness only — it never edits, cancels, or recreates an artifact (resume-after-/clear is a
// designed feature; worker-side cancellation is scripts/assert-artifact.sh in the skill).
// Zero dependencies, silent (exit 0, no output) when nothing live is found.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.gtd-orphan-watch'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

// Resolve the repo root CLI-agnostically. Claude exports CLAUDE_PROJECT_DIR and
// Antigravity exports AGENT_PROJECT_DIR; Codex exports neither (it just runs the hook
// with cwd at the workspace root). So: honor an explicit project-dir env from any
// CLI, else walk up from this script for the `.sidekicks` marker, else fall back to
// cwd. This makes the same hook script work unchanged across Claude/Antigravity/Codex.
function resolveRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR || process.env.AGENT_PROJECT_DIR;
  if (fromEnv && existsSync(resolve(fromEnv, '.sidekicks'))) return fromEnv;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir && dir !== dirname(dir)) {
    if (existsSync(resolve(dir, '.sidekicks'))) return dir;
    dir = dirname(dir);
  }
  return fromEnv || process.cwd();
}

const ROOT = resolveRoot();

function dirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// get-things-done anchors its queue at the active PROJECT level (or repo root). The CURRENT
// location is <base>/artifacts/runs/get-things-done/<slug>/tasks.yaml; the LEGACY location was
// <base>/docs/get-things-done/<slug>/tasks.yaml. Existing queues were left in place on the docs→
// artifacts migration, so scan BOTH layouts under every base. Service src/ bases are kept for
// legacy queues that predate the project-level queue anchor.
function queueFiles() {
  const found = [];
  const bases = [ROOT];
  for (const p of dirs(join(ROOT, 'projects'))) {
    bases.push(join(ROOT, 'projects', p));
    const svcRoot = join(ROOT, 'projects', p, 'services');
    for (const s of dirs(svcRoot)) bases.push(join(svcRoot, s, 'src'));
  }
  // Each base carries the queue tree at two possible roots: artifacts/runs (current) + docs (legacy).
  const gtdRoots = [];
  for (const base of bases) {
    gtdRoots.push(join(base, 'artifacts', 'runs', 'get-things-done'));
    gtdRoots.push(join(base, 'docs', 'get-things-done'));
  }
  for (const gtd of gtdRoots) {
    for (const slug of dirs(gtd)) {
      const f = join(gtd, slug, 'tasks.yaml');
      if (existsSync(f) && statSync(f).isFile()) found.push(f);
    }
  }
  return found;
}

// Cheap field scan — no YAML dependency. Good enough for a warning line.
const LEASE_TTL_SECONDS = 900; // mirrors the skill's lease_ttl_seconds default

function inspect(file) {
  const text = readFileSync(file, 'utf8');
  const stage = (text.match(/^\s*stage:\s*["']?(\w+)/m) || [])[1] || '?';
  const status = (text.match(/^status:\s*["']?(\w+)/m) || [])[1] || '?';
  const inProgress = (text.match(/^\s*status:\s*["']?in_progress/gm) || []).length;
  // Session lease (SKILL.md v0.14.0): one orchestrator per queue. A FRESH foreign lease means
  // another session may still be orchestrating — resume must ask the user before taking over.
  const runId = (text.match(/^\s*run_id:\s*["']?([^\s"'#]+)/m) || [])[1] || null;
  const heartbeat = (text.match(/^\s*heartbeat_at:\s*["']?([^\s"'#]+)/m) || [])[1] || null;
  let lease = 'none (pre-lease artifact — zombie workers cannot be invalidated by run_id)';
  if (runId) {
    const age = heartbeat ? Math.round((Date.now() - Date.parse(heartbeat)) / 1000) : NaN;
    const fresh = Number.isFinite(age) && age >= 0 && age < LEASE_TTL_SECONDS;
    lease = `${runId} (heartbeat ${Number.isFinite(age) ? `${age}s ago` : 'unparseable'}${
      fresh ? ' — FRESH: another session may be LIVE on this queue' : ' — stale'
    })`;
  }
  return { stage, status, inProgress, lease };
}

// Only flag queues with actual in_progress tasks — those have real zombie workers that
// may still write to the artifact. A queue that is status:running but has 0 in_progress
// tasks has no live workers; reporting it causes the model to conflate the old artifact
// with a new task request and auto-resume old tasks.
const live = [];
for (const f of queueFiles()) {
  try {
    const q = inspect(f);
    if (q.inProgress > 0) {
      live.push({ f, ...q });
    }
  } catch {
    /* unreadable artifact is not this hook's problem */
  }
}

if (live.length) {
  const lines = live.map(
    (q) =>
      `- ${q.f} (queue status: ${q.status}, stage: ${q.stage}, in_progress tasks: ${q.inProgress}, lease: ${q.lease})`
  );
  // Output as hookSpecificOutput so Claude Code injects it as structured context, not
  // as a bare stdout message that the model might misread as an instruction.
  // IMPORTANT: do NOT say "invoke sk-get-things-done to resume" here — that
  // phrasing causes the model to auto-resume old queues when the user starts a new task.
  // The user must explicitly ask to resume; this warning is purely informational.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `[gtd-orphan-watch] BACKGROUND WORKER ALERT — do NOT auto-resume these queues.\n` +
          `${lines.join('\n')}\n` +
          `These queues have tasks that were in_progress when the last session ended. Background ` +
          `worker subagents may still be writing to these artifacts — /clear does NOT kill them. ` +
          `WAIT: if a worker completion notification arrives, handle it then. ` +
          `Do NOT resume any of these queues automatically or because a user asks for a new task. ` +
          `Only resume a queue when the user explicitly says "resume the queue at <path>" or ` +
          `"continue the queue at <path>". A new task request is NOT a resume request — create ` +
          `a fresh queue for it instead (the collision guard in the skill handles slug conflicts).`,
      },
    })
  );
}
process.exit(0);
