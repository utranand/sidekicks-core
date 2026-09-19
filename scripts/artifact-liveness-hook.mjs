#!/usr/bin/env node
// artifact-liveness-hook.mjs — SessionStart / Stop / SubagentStop hook.
//
// The artifact LIVENESS WATCHER. The consolidated inventory
// (.sidekicks/artifacts-inventory.{json,md}) derives, per run, an "actually running" vs
// "stale / orphaned" classification by comparing each run's most-recent heartbeat/updated_at
// against a staleness threshold. But that classification is only as current as the last
// `sidekicks artifacts scan`: a run whose ledger says `running` but whose worker crashed
// (or was killed, or whose session was /cleared) keeps LOOKING running until someone
// re-scans. This hook is that re-scan — it re-derives liveness each turn and re-persists the
// inventory, so the "stale/orphaned" bucket reflects NOW without a human running scan.
//
// It NEVER mutates a run's own ledger. Liveness is a DERIVED signal: computed at scan time
// and written ONLY into the derived inventory cache (under .sidekicks/, via the same
// buildInventory/writeInventory lifecycle code the CLI `artifacts scan` verb uses — Rule 1,
// no hand-written ledger files). So a genuinely-active run is never touched; only the cache
// is refreshed. Detection is timestamp-staleness (portable by construction) — NOT per-engine
// PID/lock probing: run.json.lock is held only transiently during a write (not a liveness
// signal), and no engine keeps a persistent PID file, so a heartbeat comparison is the only
// reliable signal and needs no OS-specific process check.
//
// Debounced via the inventory's own built_at (skip if refreshed within DEBOUNCE_MS) so firing
// on every turn is cheap; liveness changes on a 30-min scale, so a slightly stale cache is
// harmless. Best-effort: any failure logs to stderr and exits 0 — never blocks a turn. Zero
// npm dependencies — node:* + lib/ back-edges only. Works on macOS and Windows.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoot } from './run-notify-hook.mjs';
// scripts/ and lib/ are co-located in the framework install and travel together, so the
// lifecycle module is a stable relative import — no dependence on the resolved data-root.
import {
  buildInventory,
  writeInventory,
  ensureInventoryIgnore,
  buildRunningAgents,
  writeRunningAgents,
} from '../lib/artifacts-lifecycle/_manage.mjs';
import { readLivenessConfig } from '../lib/artifacts-lifecycle/liveness-config.mjs';
import { resolveWatchRoots } from '../lib/artifacts-lifecycle/watch-config.mjs';

// Default watcher debounce (config `debounce_seconds` overrides). A scan moments ago already
// reflects current liveness — don't re-walk the repo on every Stop/SubagentStop; 60s is well
// under the staleness threshold, so the cache never lags in a way that matters.
export const DEBOUNCE_MS = 60_000;

/**
 * The inventory cache, wherever this checkout keeps it. A hook must not hard-depend on lib/ (it runs
 * on every tool call and has to survive a partial tree), so the two-location resolution of
 * lib/state-store/paths.mjs is repeated here rather than imported.
 */
function inventoryJsonPath(root) {
  const preferred = join(root, '.sidekicks', 'state', 'artifacts-inventory.json');
  if (existsSync(preferred)) return preferred;
  const legacy = join(root, '.sidekicks', 'artifacts-inventory.json');
  return existsSync(legacy) ? legacy : preferred;
}

/** ms-since-epoch of the inventory's built_at, or 0 if absent/unreadable. */
export function lastBuiltMs(root) {
  try {
    // Derived state lives in .sidekicks/state/; the legacy top-level path is still read so a checkout
    // that has not moved its files keeps a warm cache instead of rebuilding on every hook.
    const inv = JSON.parse(readFileSync(inventoryJsonPath(root), 'utf8'));
    const t = inv && inv.built_at ? Date.parse(inv.built_at) : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/**
 * Re-derive + persist the inventory unless disabled or a recent scan already covered it.
 * Reads centralized config from .sidekicks/agents-liveness.yaml: `enabled` (default true —
 * only an explicit false opts out), `stale_seconds` (the classification threshold), and
 * `debounce_seconds` (min gap between refreshes). Returns the count of stale/orphaned runs
 * found, or null when skipped (disabled / debounced) or on failure. Best-effort.
 */
export function refresh(root, { nowMs = Date.now(), force = false } = {}) {
  const cfg = readLivenessConfig(root);
  if (!cfg.enabled) return null; // watcher opt-out (manual `artifacts scan` still works)
  const debounceMs = cfg.debounceSeconds * 1000;
  if (!force && nowMs - lastBuiltMs(root) < debounceMs) return null;
  // Fold in the agents-watch.yaml extra roots and persist BOTH derived views — the
  // inventory and the centralized running-agents file the office-viz live UI consumes —
  // so every turn keeps the "who is running right now" picture fresh.
  const watchRoots = resolveWatchRoots(root);
  const inv = buildInventory(root, { nowMs, staleSeconds: cfg.staleSeconds, watchRoots });
  writeInventory(root, inv);
  writeRunningAgents(root, buildRunningAgents(inv));
  try { ensureInventoryIgnore(root); } catch { /* best-effort */ }
  return (inv.totals && inv.totals.stale_running) || 0;
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
    .then((gate) => gate.exitIfDisabled('hook.artifact-liveness'))
    .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

  try {
    const root = resolveRoot();
    const stale = refresh(root);
    if (stale) {
      process.stderr.write(
        `[artifact-liveness] ${stale} stale/orphaned running run(s) — see .sidekicks/state/artifacts-inventory.md\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`[artifact-liveness] ${e && e.message ? e.message : e}\n`);
  }
  process.exit(0); // never block the turn
}
