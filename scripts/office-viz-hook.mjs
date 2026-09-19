#!/usr/bin/env node
// office-viz-hook.mjs — Stop / SubagentStop / SessionStart hook.
//
// Deterministic refresher for the Sidekicks Agent Office visualization
// (artifacts/office-viz/agent-office.html, rendered by scripts/agent-office-viz.mjs).
// After each agent turn (Stop/SubagentStop on Claude; the nearest equivalent event on
// other CLIs) and at session start, it checks whether any run artifact the office
// renders — registry run.json headers, get-things-done tasks.yaml queues,
// get-plan-done mission-status.yaml ledgers — changed since the last render was
// spawned, and if so respawns the generator DETACHED in the background. The turn is
// never blocked on a render: the hook's own work is one artifact-tree mtime sweep
// plus (at most) one spawn, and it exits immediately.
//
// State: a `.viz-state.json` marker next to the generated HTML (same stance as
// run-notify's per-run .notify-state.json) records the newest artifact mtime the last
// spawn covered plus the spawn time. Change detection is mtime-only on purpose — no
// YAML parsing, no content diff — so the sweep stays cheap enough for every turn.
//
// Best-effort throughout: any failure logs to stderr and exits 0 — never blocks a
// turn. Zero npm dependencies — node:* + the sibling hook module only. macOS +
// Windows (path.join everywhere, process.execPath instead of a PATH `node`,
// windowsHide on the spawn).

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveRoot, scanBases } from './run-notify-hook.mjs';

const MARKER = '.viz-state.json';
// A render spawned moments ago is likely still writing the HTML — don't stack a
// second generator on top of it just because Stop fired again quickly.
const DEBOUNCE_MS = 30_000;
// The artifact filenames the generator reads (see collectBase in agent-office-viz.mjs).
const ARTIFACT_FILES = ['run.json', 'tasks.yaml', 'mission-status.yaml'];

function dirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function mtimeMs(f) {
  try { return statSync(f).mtimeMs; } catch { return 0; }
}

/**
 * Extra runs-roots declared in the office template's runsRoots array — the same knob the
 * generator scans (see resolveRunsRoots in agent-office-viz.mjs). Read raw here rather than
 * importing the generator module: the hook's sweep must stay cheap enough for every turn.
 */
function extraRunsRoots(root) {
  try {
    // Configuration lives in .sidekicks/config/; a checkout that has not moved its copy is read from
    // the old top-level path. Inline rather than importing lib/config-store — a hook must keep working
    // when lib/ is unavailable (the fail-open stance of scripts/lib/hook-gate.mjs).
    const configured = join(root, '.sidekicks', 'config', 'office-config.json');
    const legacy = join(root, '.sidekicks', 'office-config.json');
    const cfg = JSON.parse(readFileSync(existsSync(configured) ? configured : legacy, 'utf8'));
    if (!Array.isArray(cfg?.runsRoots)) return [];
    return cfg.runsRoots
      .map((e) => (typeof e === 'string' ? e : (e && typeof e === 'object') ? e.path : null))
      .filter((p) => typeof p === 'string' && p)
      .flatMap((p) => (p.includes('*') ? expandPattern(root, p) : [resolve(root, p)]));
  } catch { return []; }
}

/** Single-segment '*' expansion — mirrors expandPattern in agent-office-viz.mjs. */
function expandPattern(root, pattern) {
  const segs = String(pattern).split('/').filter(Boolean);
  let acc = [root];
  for (const seg of segs) {
    const next = [];
    for (const base of acc) {
      if (seg === '*') for (const d of dirs(base)) next.push(join(base, d));
      else if (existsSync(join(base, seg))) next.push(join(base, seg));
    }
    acc = next;
    if (!acc.length) break;
  }
  return acc;
}

/** Newest mtime across every run artifact the office renders. 0 = none found. */
export function newestArtifactMtime(root) {
  let newest = 0;
  const roots = scanBases(root).map(({ base }) => join(base, 'artifacts', 'runs'))
    .concat(extraRunsRoots(root));
  for (const runsRoot of roots) {
    for (const skill of dirs(runsRoot)) {
      for (const slug of dirs(join(runsRoot, skill))) {
        for (const f of ARTIFACT_FILES) {
          const t = mtimeMs(join(runsRoot, skill, slug, f));
          if (t > newest) newest = t;
        }
      }
    }
  }
  return newest;
}

export function readMarker(vizDir) {
  try { return JSON.parse(readFileSync(join(vizDir, MARKER), 'utf8')); } catch { return null; }
}

export function writeMarker(vizDir, state) {
  try {
    mkdirSync(vizDir, { recursive: true });
    writeFileSync(join(vizDir, MARKER), JSON.stringify(state, null, 2) + '\n');
  } catch { /* best-effort */ }
}

/**
 * Decide whether to respawn the generator.
 *
 * - debounce: a spawn within the last DEBOUNCE_MS is assumed in flight — skip.
 * - no HTML yet → first render.
 * - no (or malformed) marker → unseeded — render once to seed it.
 * - artifacts newer than what the last spawn covered → re-render.
 * - HTML older than the artifact state the last spawn covered → that spawn died
 *   before writing (or the generator errored) — retry rather than stay stale forever.
 */
export function decide(newestMs, marker, htmlMtimeMs, nowMs) {
  if (marker && Number.isFinite(marker.spawned_at_ms) && nowMs - marker.spawned_at_ms < DEBOUNCE_MS) return false;
  if (!htmlMtimeMs) return true;
  if (!marker || !Number.isFinite(marker.artifacts_mtime_ms)) return true;
  if (newestMs > marker.artifacts_mtime_ms) return true;
  if (htmlMtimeMs < marker.artifacts_mtime_ms) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Entry point (skipped when imported by tests)
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && (
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (invokedDirectly) {
  // Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
  await import('./lib/hook-gate.mjs')
    .then((gate) => gate.exitIfDisabled('hook.office-viz'))
    .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

  try {
    const root = resolveRoot();
    const generator = join(root, 'scripts', 'agent-office-viz.mjs');
    const vizDir = join(root, 'artifacts', 'office-viz');
    if (existsSync(generator)) { // no generator in this clone — silently not our job
      const nowMs = Date.now();
      const newest = newestArtifactMtime(root);
      const htmlMtime = mtimeMs(join(vizDir, 'agent-office.html'));
      if (decide(newest, readMarker(vizDir), htmlMtime, nowMs)) {
        const child = spawn(process.execPath, [generator], {
          cwd: root,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        writeMarker(vizDir, {
          artifacts_mtime_ms: newest,
          spawned_at_ms: nowMs,
          at: new Date(nowMs).toISOString(),
        });
        process.stderr.write('[office-viz] run artifacts changed — regenerating agent office in background\n');
      }
    }
  } catch (e) {
    process.stderr.write(`[office-viz] ${e && e.message ? e.message : e}\n`);
  }
  process.exit(0); // never block the turn
}
