#!/usr/bin/env node
// scripts/project-behavior-preflight-hook.mjs — PreToolUse hook (matchers: Skill, Bash)
//
// Why this exists: a project's TTSR register — the mistakes it has already been bitten by —
// is only worth maintaining if it is read BEFORE the write, not cited in the post-mortem
// afterwards. `criterion.project-behavior-preflight` states that obligation, and the PREFLIGHT
// exit-code contract is its authority on every CLI. This hook is the immediacy half: the FIRST
// time a session performs an implementation-shaped action under a project scope, it injects
// that project's Top TTSR table as additionalContext, BEFORE the tool call runs.
//
// Once per session, per domain set. A dedup marker under `.sidekicks/state/` (git-ignored,
// per-machine, never repo content and never `artifacts/runs/`) records what a session already
// received, so the second implementation action costs nothing.
//
// Cross-CLI action resolution (the only thing that differs between CLIs):
//   Claude Code  → tool_name 'Skill', skill in tool_input.skill
//   Gemini       → BeforeTool with matcher 'activate_skill' (same payload shape)
//   Claude shell → 'Bash', command in tool_input.command (string OR argv array)
//   Codex CLI    → reads SKILL.md inline, so no PreToolUse fires on skill activation;
//                  its shell calls still match the command path.
// Antigravity has no tool-call event at all — there this hook never fires, and the PREFLIGHT
// contract in the criterion is the whole enforcement. Documented in the manifest's `degraded:`.
//
// It NEVER blocks a tool call and never denies: it either adds context or says nothing.
// Any error is swallowed and treated as "no trigger". Zero npm dependencies.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A mounted framework core (<workspace>/.sidekicks-core/) carries its own .sidekicks/ but is a
// read-only submodule, not a repo root. Constants duplicated from lib/sk-cli/core-mount.mjs
// so this hook static-imports nothing outside node:* (same reason memory-trigger-hook does).
const CORE_MARKER = '.sidekicks-core.json';
const CORE_DIR = '.sidekicks-core';
const sameName = (a, b) => (process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b);

function resolveRepoRoot(startDir) {
  let dir = startDir;
  let coreFallback = null;
  while (dir && dir !== dirname(dir)) {
    const hasSidekicks = existsSync(resolve(dir, '.sidekicks'));
    const isCore = sameName(basename(dir), CORE_DIR) && existsSync(resolve(dir, CORE_MARKER));
    if (hasSidekicks && !isCore) return dir;
    if (existsSync(resolve(dir, CORE_DIR, CORE_MARKER))) return dir;
    if (coreFallback === null && hasSidekicks && isCore) coreFallback = dir;
    dir = dirname(dir);
  }
  return coreFallback;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function commandOf(toolInput) {
  const raw = toolInput?.command;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.join(' ');
  return '';
}

// Which behaviour domains an action is about to touch. Deliberately generous on the read side
// and silent when nothing matches: injecting the wrong domain costs a few hundred tokens, while
// a missed match costs the lesson the register exists to deliver.
const DOMAIN_SIGNALS = [
  ['database', /\b(psql|pg_dump|pg_restore|sql|migration|schema|insert into|update .*set|alter table|database|db-)\b/i],
  ['deploy', /\b(deploy|redeploy|helm|argocd|release|publish|ecr|docker push|semantic-release)\b/i],
  ['cluster', /\b(kubectl|kube|k8s|cluster|namespace|externalsecret|secretsmanager)\b/i],
  ['jira', /\b(jira|card|subtask|SDHPT-|DSHPT-|DSHPH)\b/i],
  ['architecture', /\b(architect|component|module|dto|controller|service layer)\b/i],
  ['implementation', /\b(implement|develop|build|fix|refactor|patch|commit|merge|git )\b/i],
];

// Skills whose activation IS an implementation/execution run under a project. A skill that only
// reads, explains or plans is deliberately absent: it writes nothing there is a mistake to repeat.
// The fallback for a skill name that scores ZERO hits above — every alternative here is a real
// skill that owns a write under a project scope. Audited against the installed skill list: an
// alternative matching no skill (`sk-service-implementer`, which is a subagent) is dead weight
// that reads as coverage. Names that already hit DOMAIN_SIGNALS are kept for legibility, not need.
const IMPLEMENTING_SKILLS = /^(sk-bmad-developer|sk-get-things-done|sk-get-plan-done|sk-jira-autopilot|sk-get-jira-done|sk-commander|sk-implementation-planner|sk-framework-dev|sk-fable-mission|sk-squad|sk-loop-fleet|sk-security-remediation|sk-git-ship|sk-worktree-integrate|sk-shp-|sk-database-|sk-safe-data-importer|sk-cluster-ops|sk-argocd-ops)/;

function domainsFor({ skill, command }) {
  const hay = [skill || '', command || ''].join(' ');
  const hits = DOMAIN_SIGNALS.filter(([, rx]) => rx.test(hay)).map(([d]) => d);
  if (skill && IMPLEMENTING_SKILLS.test(skill) && hits.length === 0) return ['implementation'];
  return hits;
}

function dedupPath(repoRoot, sessionId) {
  const id = String(sessionId || 'no-session').replace(/[^A-Za-z0-9._-]/g, '_');
  return join(repoRoot, '.sidekicks', 'state', `behavior-preflight-${id}.json`);
}

function readDelivered(file) {
  try {
    return new Set(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return new Set();
  }
}

function writeDelivered(file, set) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([...set]), 'utf8');
  } catch {
    // a per-machine dedup marker that cannot be written costs a repeat injection, never a failure
  }
}

function activeProject(repoRoot) {
  try {
    const raw = readFileSync(join(repoRoot, '.sidekicks', 'settings.json'), 'utf8');
    return JSON.parse(raw).active_project || null;
  } catch {
    return null; // root scope, or no settings file — never an error
  }
}

async function main() {
  const input = JSON.parse(readStdin() || '{}');
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const skill = toolName === 'Skill' || toolName === 'activate_skill' ? toolInput.skill || '' : '';
  const command = toolName === 'Bash' ? commandOf(toolInput) : '';
  if (!skill && !command) return;

  const repoRoot = resolveRepoRoot(process.cwd()) || resolveRepoRoot(process.env.CLAUDE_PROJECT_DIR || '');
  if (!repoRoot) return;

  // Root scope has no project behaviour document; the criterion is satisfied trivially.
  const project = activeProject(repoRoot);
  if (!project || project === 'sidekicks') return;

  const domains = domainsFor({ skill, command });
  if (domains.length === 0) return;

  const marker = dedupPath(repoRoot, input.session_id);
  const delivered = readDelivered(marker);
  const fresh = domains.filter((d) => !delivered.has(d));
  if (fresh.length === 0) return; // already paid for this session

  const py = ['.venv/bin/python', '.venv/Scripts/python.exe']
    .map((p) => resolve(repoRoot, p))
    .find((p) => existsSync(p)) || 'python3';
  const script = resolve(repoRoot, '.agents/skills/sk-forge-project-behavior/scripts/behavior.py');
  if (!existsSync(script)) return; // skill not installed here

  // PREFLIGHT first: a stale document is reported as stale rather than injected as current.
  const pre = spawnSync(py, [script, 'preflight', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  fresh.forEach((d) => delivered.add(d));
  writeDelivered(marker, delivered);

  let context;
  if (pre.status === 3) {
    let remedy = '';
    try {
      remedy = JSON.parse(pre.stdout || '{}').remedy || '';
    } catch { /* the human-readable form is on stderr; the directive below still stands */ }
    context = [
      'BEHAVIOUR PREFLIGHT [hook]: this project has a behaviour document (SSOT/TTSR) and it is',
      'NOT current, so the register of mistakes this project has already been bitten by cannot be',
      'trusted for this run. Forge it before the first write, or state the blocker and proceed on',
      'the underlying rules — do not treat a stale document as current.',
      remedy ? `  ${remedy}` : '',
    ].filter(Boolean).join('\n');
  } else if (pre.status === 0) {
    const sel = spawnSync(py, [script, 'select', '--domain', fresh.join(',')],
      { cwd: repoRoot, encoding: 'utf8' });
    const text = (sel.stdout || '').trim();
    if (!text || sel.status !== 0) return;
    context = [
      'BEHAVIOUR PREFLIGHT [hook]: this action touches a domain this project has recorded',
      'mistakes in. The entries below are THINGS TO STOP REPEATING — each one already happened',
      'here. Read them before the first write; they constrain what you are about to do. Injected',
      'ONCE per session per domain. Full document: '
        + `projects/${project}/docs/behavior/PROJECT-BEHAVIOR.md`,
      '',
      text,
    ].join('\n');
  } else {
    return; // the gate itself could not run — say nothing rather than guess
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: context,
      },
    })
  );
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.project-behavior-preflight'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

// Best-effort in every path: a PreToolUse hook that exits non-zero BLOCKS the tool call
// on Claude Code, so "nothing to say" and "something went wrong" must look identical.
try {
  await main();
} catch {
  // fall through to a clean exit
}
process.exit(0);
