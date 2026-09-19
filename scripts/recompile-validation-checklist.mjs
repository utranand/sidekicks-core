#!/usr/bin/env node
// scripts/recompile-validation-checklist.mjs
//
// Claude Code PostToolUse hook (matchers: Write, Edit) that keeps the project
// validation checklist in sync with the rule files automatically. When the agent
// writes or edits any rule file under a project's `docs/rules/**` (architect-rules,
// implementation-rules, database-rules), this hook recompiles that project's
// compiled checklist (docs/validation/checklist.yaml + checklist.md) by running
// sk-validation-gate's engine `checklist.py compile --project <p>`.
//
// Why a hook: "whenever a rule changes, the checklist updates" is an AUTOMATIC
// behavior — the harness must run it, the model can't be relied on to remember. This
// is the deterministic Claude-Code enforcement of that policy. Cross-CLI parity is
// provided by the rule-authoring skills, which run the same compile after they write
// a rule (so Codex and Antigravity stay in sync too), and by the gate's staleness self-heal at
// VALIDATE time.
//
// No loop risk: the compile writes under docs/validation/ (never docs/rules/), and it
// runs as a child process, not a Write tool — so it never re-triggers this hook.
//
// Contract: BEST-EFFORT. Any error → exit 0 silently (never wedge the agent). Reads
// the PostToolUse JSON on stdin; emits a one-line systemMessage on a successful
// recompile. Zero npm dependencies (node:* only).
//
// Direct test mode:
//   echo '{"tool_name":"Edit","tool_input":{"file_path":"projects/shp-sk/docs/rules/implementation-rules/implementation-rules.md"}}' | node scripts/recompile-validation-checklist.mjs

import { existsSync } from 'node:fs';
import { basename, dirname, resolve, isAbsolute, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

function done(obj) {
  try {
    if (obj) process.stdout.write(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// A mounted framework core (<workspace>/.sidekicks-core/) carries its own .sidekicks/ but is a
// read-only submodule, not a repo root — walk past it. Constant duplicated from
// lib/sk-cli/core-mount.mjs so this hook static-imports nothing outside node:*.
const CORE_MARKER = '.sidekicks-core.json';
const CORE_DIR = '.sidekicks-core';
// NTFS is case-insensitive, so a byte-exact basename compare would silently defeat the skip on Windows.
const sameName = (a, b) => (process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : a === b);   // only a core AT the mount point is skipped

function resolveRepoRoot(startDir) {
  let dir = startDir;
  let coreFallback = null;
  while (dir && dir !== dirname(dir)) {
    const hasSidekicks = existsSync(resolve(dir, '.sidekicks'));
    const isCore = sameName(basename(dir), CORE_DIR) && existsSync(resolve(dir, CORE_MARKER));
    if (hasSidekicks && !isCore) return dir;
    // A workspace that has MOUNTED a core is a root even before `core init` gives it a .sidekicks/,
    // and it beats any .sidekicks/ further up ($HOME/.sidekicks, which skills create for their own
    // state). Same nearness rule as lib/sk-cli/paths.mjs.
    if (existsSync(resolve(dir, CORE_DIR, CORE_MARKER))) return dir;
    if (coreFallback === null && hasSidekicks && isCore) coreFallback = dir;
    dir = dirname(dir);
  }
  return coreFallback;   // a STANDALONE core is its own root; a mounted one defers to the workspace
}

/** Read all of stdin (the hook input JSON). */
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * If `p` (repo-relative, POSIX-normalized) names a file under a `docs/rules/`
 * tree, return { project, family } else null. `project` is "sidekicks" for the
 * root docs tree; `family` is the rule-family SUBDIRECTORY name (whatever it is —
 * architect-rules, database-rules, or a NEW type like jira-rules) so the recompile
 * is surgical; the gate engine resolves any discovered family. `family` is null
 * only when the file sits directly in docs/rules/ with no family subdir → recompile all.
 *   projects/<p>/docs/rules/architect-rules/...          -> { p, architect-rules }
 *   projects/<p>/docs/rules/jira-rules/...                -> { p, jira-rules }
 *   projects/<p>/services/<s>/src/docs/rules/x-rules/...  -> { p, x-rules }
 *   docs/rules/...                                        -> { sidekicks, ... }
 */
function ruleFileInfo(relPosix) {
  if (!/(^|\/)docs\/rules\//.test(relPosix)) return null;
  const pm = relPosix.match(/^projects\/([^/]+)\//);
  const project = pm ? pm[1] : (/^docs\/rules\//.test(relPosix) ? 'sidekicks' : null);
  if (!project) return null;
  const fm = relPosix.match(/docs\/rules\/([^/]+)\//);
  const family = fm ? fm[1] : null; // any subdir name; null → file directly in docs/rules/
  return { project, family };
}

async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    return done(null);
  }

  const tool = input.tool_name || '';
  if (tool !== 'Write' && tool !== 'Edit') return done(null);

  const ti = input.tool_input || {};
  const filePath = ti.file_path || ti.path || '';
  if (!filePath) return done(null);

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = resolveRepoRoot(isAbsolute(filePath) ? dirname(filePath) : cwd) || resolveRepoRoot(cwd);
  if (!root) return done(null);

  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  let rel = abs.startsWith(root) ? abs.slice(root.length).replace(/^[\\/]+/, '') : filePath;
  const relPosix = rel.split(sep).join('/');

  const info = ruleFileInfo(relPosix);
  if (!info) return done(null);
  const { project, family } = info;

  // Resolve the python interpreter: repo-root venv first, else python3/python.
  const venvPy = process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');
  const py = existsSync(venvPy) ? venvPy : (process.platform === 'win32' ? 'python' : 'python3');

  const engine = join(root, '.agents', 'skills', 'sk-validation-gate', 'scripts', 'checklist.py');
  if (!existsSync(engine)) return done(null);

  const compileArgs = [engine, '--project', project, 'compile', '--if-stale'];
  if (family) compileArgs.push('--family', family);
  const res = spawnSync(py, compileArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  });

  if (res.status === 0) {
    const note = (res.stdout || '').split('\n').find((l) => l.includes('Compiled') || l.includes('unchanged')) || '';
    return done({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `[validation-gate] rule file changed (${relPosix}); recompiled ${project}'s validation checklist. ${note}`.trim(),
      },
    });
  }
  // Non-zero (e.g. PyYAML missing) — stay silent, never wedge.
  return done(null);
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.recompile-validation-checklist'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

main().catch(() => done(null));
