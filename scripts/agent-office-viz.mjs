#!/usr/bin/env node
// scripts/agent-office-viz.mjs — "Sidekicks Agent Office": render the repo's live agent
// run state (registry run.json headers, get-things-done queues, get-plan-done missions)
// as a self-contained 3D office simulation (Three.js, vendored + inlined).
//
// v5 — PLUGGABLE THEMES: the scene renderer is no longer baked in. Each theme is either
//   one self-contained client script at office-viz-themes/<name>/theme.js or an ordered
//   theme.manifest.json files[] bundle, registering window.OFFICE_THEMES[<name>] =
//   { label, boot(ctx) }. ALL bundled themes are embedded in the page; an in-page
//   selector switches between them, office-config.json's "theme" field sets the default,
//   and --theme <name> pins it
//   for one render/serve. Bundled themes: minecraft (default voxel world) and darken-theme.
//   To add a theme, add a folder with theme.js or a manifest.
//
// v4 — a real IT-company campus, driven by an EDITABLE, REUSABLE TEMPLATE:
//   · On first run the generator computes a default floor plan from the live data and
//     SAVES it to .sidekicks/office-config.json (the template). Every later
//     run reads that file, so your edits — rooms, palette, decor, lighting — persist.
//   · New projects are auto-appended to the template as new department rooms; new runs
//     become new officers. No code change needed to scale.
//   · Common rooms out of the box: Lobby (reception + sofas), Meeting Room, Presentation
//     Room, Coffee Bar, Arcade — plus one department room per project.
//   · Cozy pass: two-tone wallpaper walls, procedural paintings, windows that glow at
//     night, pendant lamps + warm room lights, rugs, plants, and Sims-style auto-cutaway
//     perimeter walls (the wall facing the camera fades so the interior stays visible).
//
// Dependencies: node:* builtins + the repo's own yaml-subset parser (via run-notify-hook.mjs)
// + ONE vendored asset, scripts/office-viz-vendor/three.min.js (Three.js r147 UMD, MIT),
// inlined into the generated HTML so the page works offline and under a strict CSP.
//
// Usage:
//   node scripts/agent-office-viz.mjs                  # writes artifacts/office-viz/agent-office.html
//   node scripts/agent-office-viz.mjs --out <path>     # custom output path
//   node scripts/agent-office-viz.mjs --config <path>  # custom template path (default: .sidekicks/office-config.json)
//   node scripts/agent-office-viz.mjs --json           # dump the collected model to stdout instead
//   node scripts/agent-office-viz.mjs --serve [port]   # LIVE mode: zero-dep node:http server (default port 4680)
//                                                      # watches artifacts/runs/ everywhere, pushes payloads over SSE
//                                                      # (/events); the page updates in place — officers spawn, walk
//                                                      # out, and change state without a reload. The static file path
//                                                      # above keeps working unchanged when opened without the server.
//                                                      # Serve mode shows ACTIVE officers only (fresh activity within
//                                                      # 2h + live lease) so the floor answers "what is being worked
//                                                      # on right now"; add --all after --serve for the full floor.
//                                                      # SINGLETON: one live server per repo — a second --serve
//                                                      # refuses to start while the lock's pid is alive
//                                                      # (artifacts/office-viz/.serve.lock.json); add --replace to
//                                                      # stop the running server and take over.
//   node scripts/agent-office-viz.mjs --active-only    # static mode with the same active-only filter
//   node scripts/agent-office-viz.mjs --theme <name>   # pin the scene theme for this render/serve
//                                                      # (a folder under office-viz-themes/; the in-page
//                                                      # selector is disabled while pinned)
//   node scripts/agent-office-viz.mjs --runs-root <p>  # scan an EXTRA run-artifact location (repeatable) —
//                                                      # skills can anchor run state outside the standard
//                                                      # <base>/artifacts/runs bases (artifacts_dir overrides,
//                                                      # plan-centric trees). Persistent equivalents: the
//                                                      # "runsRoots" array in .sidekicks/office-config.json
//                                                      # (strings, or { path, dept } to pin the room), and
//                                                      # the SHARED watch config .sidekicks/agents-watch.yaml
//                                                      # (agents_watch.watch_roots — also read by the
//                                                      # artifact-manager's running-agents monitor, so the
//                                                      # office and running-agents.json cover the same folders).
//
// Read-only over run artifacts: this script never mutates queue/mission/registry state.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync, watch } from 'node:fs';
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { resolveRoot, initYaml, readYaml } from './run-notify-hook.mjs';

// ---------------------------------------------------------------------------
// Collection — walk the same artifact bases the run-notify hook watches
// ---------------------------------------------------------------------------

const STALE_MS = 2 * 60 * 60 * 1000; // a "running" lease silent for 2h = asleep at the desk

/**
 * The office template path. Configuration lives in .sidekicks/config/; a checkout that has not moved
 * its copy is read from the old top-level path. Inline rather than importing lib/config-store, because
 * this script also ships inside the sk-office-viz skill, which must run when lifted out.
 */
function officeConfigPath(root) {
  const configured = join(root, ".sidekicks", "config", "office-config.json");
  return existsSync(configured) ? configured : join(root, ".sidekicks", "office-config.json");
}

function dirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => {
      if (d.isDirectory()) return true;
      if (!d.isSymbolicLink()) return false;
      try { return statSync(join(p, d.name)).isDirectory(); } catch { return false; }
    }).map((d) => d.name);
  } catch {
    return [];
  }
}

function scanBases(root) {
  const bases = [{ base: root, scope: 'root' }];
  for (const p of dirs(join(root, 'projects'))) {
    bases.push({ base: join(root, 'projects', p), scope: p });
    const svcRoot = join(root, 'projects', p, 'services');
    for (const s of dirs(svcRoot)) {
      // A service's artifacts base is the service ROOT (artifacts/runs hangs off the
      // service root, never src/ — CLAUDE.md "Artifacts folder"). Scan src/ too so the
      // legacy src/artifacts/runs tree from older skills still surfaces; getRunsRoots
      // dedupes the overlap.
      bases.push({ base: join(svcRoot, s), scope: p });
      bases.push({ base: join(svcRoot, s, 'src'), scope: p });
    }
  }
  return bases;
}

export function projectDepartments(root) {
  return [...new Set(scanBases(root).map((b) => b.scope))].map((id) => ({
    id,
    label: id === 'root' ? 'HQ · sidekicks' : id,
  }));
}

// Expand single-segment '*' wildcards in a repo-relative path against the filesystem
// (e.g. "artifacts/runs/sidekicks-implementation-planner/*/artifacts/runs" — or the legacy
// "docs/implementation-plans/*/artifacts/runs" — → one path per plan). No '**';
// a literal segment must exist to keep matching. Returns absolute paths.
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

/**
 * Normalize one configured extra runs-root (a string path, or { path, dept }) into
 * [{ runsRoot, scope }]. Paths are repo-relative (portable-artifact rule; absolute
 * tolerated for wildcard-free entries). A path may carry single-segment '*' wildcards,
 * expanded at resolve time — so plan-centric trees created later are picked up without
 * a config edit. Without an explicit dept the department is derived from a
 * projects/<p>/ prefix, else root.
 */
function normalizeExtra(root, entry) {
  const p = typeof entry === 'string' ? entry
    : (entry && typeof entry === 'object' && typeof entry.path === 'string') ? entry.path : null;
  if (!p) return [];
  const paths = p.includes('*') ? expandPattern(root, p) : [resolve(root, p)];
  const pinned = (entry && typeof entry === 'object' && entry.dept) ? String(entry.dept) : null;
  return paths.map((abs) => {
    let scope = pinned;
    if (!scope) {
      const rel = relative(root, abs).split(sep).join('/');
      const m = /^projects\/([^/]+)\//.exec(rel);
      scope = m ? m[1] : 'root';
    }
    return { runsRoot: abs, scope };
  });
}

/**
 * Every runs-root to scan: the standard bases' artifacts/runs (repo root, each project,
 * each service src) PLUS configured extras — skills can anchor run state elsewhere via
 * artifacts_dir (plan-centric trees, custom anchors), so the office's coverage is
 * configurable rather than hardcoded. Deduped by resolved path.
 */
export function resolveRunsRoots(root, extras = []) {
  const roots = [];
  const seen = new Set();
  const add = (runsRoot, scope) => {
    const key = resolve(runsRoot);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ runsRoot: key, scope });
  };
  for (const { base, scope } of scanBases(root)) add(join(base, 'artifacts', 'runs'), scope);
  for (const e of Array.isArray(extras) ? extras : []) {
    for (const n of normalizeExtra(root, e)) add(n.runsRoot, n.scope);
  }
  return roots;
}

function mtimeIso(f) {
  try { return new Date(statSync(f).mtimeMs).toISOString(); } catch { return null; }
}

function firstIso(...values) {
  for (const value of values) {
    const t = Date.parse(value || '');
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/** Map any run/task status string onto an office state. */
export function officeState(status, { stale = false } = {}) {
  const s = String(status || '').toLowerCase();
  if (['done', 'stopped', 'shipped', 'complete', 'completed', 'skipped'].includes(s)) return 'offshift';
  if (s === 'failed' || s === 'error') return 'failed';
  if (['blocked', 'halted', 'awaiting-merge'].includes(s)) return 'blocked';
  if (s === 'paused') return 'coffee';
  if (['pending', 'idle', 'todo', 'planned', 'ready'].includes(s)) return 'idle';
  // running / executing / in_progress / anything active
  return stale ? 'asleep' : 'working';
}

function leaseStale(obj, nowMs, fallbackIso = null) {
  // Freshest recency evidence, best first: explicit lease heartbeat > updated_at >
  // the file's own mtime. The mtime fallback matters when a run's header can't be
  // read for a heartbeat/updated_at (e.g. a mission-status.yaml whose folded block
  // scalars defeat the zero-dep parser) — without it such a run has no staleness
  // signal and reads "working" on the active floor forever, however old the file is.
  const hb = obj?.control?.lease?.heartbeat_at || obj?.lease?.heartbeat_at || obj?.updated_at || fallbackIso || null;
  if (!hb) return false;
  const t = Date.parse(hb);
  return Number.isFinite(t) && nowMs - t > STALE_MS;
}

/** Collect every run unit under one runs-root. Returns unit objects (see render for shape). */
function collectRunsRoot(runsRoot, scope, nowMs) {
  const units = [];
  for (const skill of dirs(runsRoot)) {
    for (const slug of dirs(join(runsRoot, skill))) {
      const runDir = join(runsRoot, skill, slug);
      const runJson = join(runDir, 'run.json');
      const tasksYaml = join(runDir, 'tasks.yaml');
      const missionYaml = join(runDir, 'mission-status.yaml');
      const ledgerYaml = join(runDir, 'ledger.yaml');
      if (existsSync(runJson)) {
        try {
          const m = JSON.parse(readFileSync(runJson, 'utf8'));
          units.push({
            type: 'registry', scope, skill: m.skill || skill, slug: m.slug || slug,
            title: m.title || m.goal || '', status: m.status || 'running',
            stale: leaseStale(m, nowMs, mtimeIso(runJson)),
            jira: m.jira_card || null,
            startedAt: firstIso(m.started_at, m.created_at),
            updatedAt: firstIso(m.updated_at, m.created_at),
            enginePointer: m.pointer?.engine_artifact || null,
            runDir,
          });
        } catch { /* unreadable header — skip, same stance as run-notify */ }
      } else if (existsSync(tasksYaml)) {
        const q = readYaml(tasksYaml);
        if (!q || typeof q !== 'object') continue;
        const tasks = Array.isArray(q.tasks) ? q.tasks : [];
        const stale = leaseStale(q, nowMs, mtimeIso(tasksYaml));
        units.push({
          type: 'gtd', scope, skill: 'get-things-done', slug,
          title: q.queue ? `queue ${q.queue}` : slug,
          status: q.status || 'running', note: q.status_note || '',
          jira: q.jira?.card || null,
          startedAt: firstIso(q.started_at, q.created_at, mtimeIso(tasksYaml)),
          updatedAt: firstIso(q.updated_at, mtimeIso(tasksYaml)),
          stale,
          tasks: tasks.map((t) => ({
            id: t?.id || '?', title: t?.title || '', status: t?.status || 'pending',
            kind: t?.kind || '', model: t?.model || '',
            attempts: t?.attempts || 0,
            issue: Array.isArray(t?.issues) && t.issues.length ? String(t.issues[t.issues.length - 1]?.summary || '') : '',
          })),
          runDir,
        });
      } else if (existsSync(missionYaml)) {
        const m = readYaml(missionYaml);
        if (!m || typeof m !== 'object') continue;
        const crit = Array.isArray(m.acceptance_criteria) ? m.acceptance_criteria : [];
        units.push({
          type: 'gpd', scope, skill: 'get-plan-done', slug: m.mission_slug || slug,
          title: m.mission_slug || slug, status: m.status || 'running',
          jira: m.jira?.card || null,
          startedAt: firstIso(m.started_at, m.created_at, mtimeIso(missionYaml)),
          updatedAt: firstIso(m.updated_at, mtimeIso(missionYaml)),
          stale: leaseStale(m, nowMs, mtimeIso(missionYaml)),
          criteria: crit.map((c) => ({ id: c?.id || '', text: c?.text || '', met: c?.state === 'met' })),
          iteration: m.current_iteration ?? 0,
          runDir,
        });
      } else if (existsSync(ledgerYaml)) {
        // jira-autopilot single-card ledger: the run artifact BEFORE (or without) a
        // registry run.json — the card is being driven but its engine run.json may not
        // exist yet. Recognize it so the office shows the card the moment autopilot starts.
        const m = readYaml(ledgerYaml);
        if (!m || typeof m !== 'object') continue;
        const steps = Array.isArray(m.steps) ? m.steps : [];
        const gates = Array.isArray(m.gates) ? m.gates : [];
        const lastStepAt = steps.length ? steps[steps.length - 1]?.at : null;
        const lastGateAt = gates.length ? gates[gates.length - 1]?.at : null;
        const updatedAt = firstIso(lastStepAt, lastGateAt, m.created_at, mtimeIso(ledgerYaml));
        units.push({
          type: 'jira-autopilot', scope, skill: 'jira-autopilot',
          slug: m.card || slug, title: m.goal || slug, status: m.status || 'running',
          jira: m.card || null,
          startedAt: firstIso(m.created_at, mtimeIso(ledgerYaml)),
          updatedAt,
          stale: leaseStale({ updated_at: updatedAt }, nowMs),
          enginePointer: m.engine_artifact || null,
          runDir,
        });
      }
    }
  }
  return units;
}

export function collect(root, nowMs = Date.now(), extraRunsRoots = []) {
  const units = [];
  for (const { runsRoot, scope } of resolveRunsRoots(root, extraRunsRoots)) {
    units.push(...collectRunsRoot(runsRoot, scope, nowMs));
  }
  // A registry run or jira-autopilot ledger whose pointer targets a collected engine run
  // (gpd mission / gtd queue) absorbs it (one officer, not two).
  const byPath = new Map(units.filter((u) => u.type === 'gpd' || u.type === 'gtd').map((u) => [resolve(u.runDir), u]));
  for (const u of units) {
    if ((u.type !== 'registry' && u.type !== 'jira-autopilot') || !u.enginePointer) continue;
    const target = byPath.get(resolve(root, dirname(u.enginePointer)));
    if (target) {
      u.mission = target;
      target.absorbed = true;
    }
  }
  const kept = units.filter((u) => !u.absorbed);
  for (const u of kept) u.state = officeState(u.status, { stale: u.stale });
  // Active desks first, newest first.
  const rank = { failed: 0, blocked: 1, working: 2, asleep: 3, coffee: 4, idle: 5, offshift: 6 };
  kept.sort((a, b) => (rank[a.state] - rank[b.state]) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return kept;
}

// ---------------------------------------------------------------------------
// Simulation payload — units → one officer per run, grouped by department
// ---------------------------------------------------------------------------

export function visibleDepartments(departments = [], cfg = {}) {
  const hidden = new Set((Array.isArray(cfg?.deptRooms) ? cfg.deptRooms : [])
    .filter((r) => r && r.display === false)
    .map((r) => r.dept));
  return departments.filter((d) => d && !hidden.has(d.id));
}

function departmentCandidates(units, departments = []) {
  const byId = new Map();
  for (const d of departments) {
    if (d && d.id && !byId.has(d.id)) byId.set(d.id, d);
  }
  for (const u of units) {
    if (u && u.scope && !byId.has(u.scope)) {
      byId.set(u.scope, { id: u.scope, label: u.scope === 'root' ? 'HQ · sidekicks' : u.scope });
    }
  }
  return [...byId.values()];
}

export function buildPayload(units, { generatedAt, branch, activeOnly = false, nowMs = Date.now(), departments = [] }) {
  // Active-only (the --serve default): an officer earns a desk only with a live pulse —
  // a non-stale lease AND artifact activity within STALE_MS — so the floor shows what is
  // being worked on right now; stale/abandoned runs stay off shift instead.
  const live = (u) => {
    if (u.stale) return false;
    const t = Date.parse(u.updatedAt || '');
    return Number.isFinite(t) && nowMs - t <= STALE_MS;
  };
  const onFloor = (u) => u.state !== 'offshift' && (!activeOnly || live(u));
  const visibleDeptIds = departments.length ? new Set(departments.map((d) => d.id)) : null;
  const visible = (u) => !visibleDeptIds || visibleDeptIds.has(u.scope);
  const active = units.filter((u) => onFloor(u) && visible(u));
  const offshift = units.filter((u) => !onFloor(u) && visible(u));
  const agents = [];
  const celebrations = [];
  const completions = [];
  const deptLabelById = new Map(departments.map((d) => [d.id, d.label || (d.id === 'root' ? 'HQ · sidekicks' : d.id)]));
  const elapsedMs = (startedAt) => {
    const t = Date.parse(startedAt || '');
    return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
  };
  const runMeta = (u, dept, fallback = null) => {
    const startedAt = u.startedAt || fallback?.startedAt || null;
    return {
      deptLabel: deptLabelById.get(dept) || (dept === 'root' ? 'HQ · sidekicks' : dept),
      startedAt,
      elapsedMs: elapsedMs(startedAt),
    };
  };
  const push = (a) => agents.push({ progress: null, issue: '', note: '', startedAt: null, elapsedMs: null, ...a });
  const completed = (status) => officeState(status) === 'offshift';
  const celebrate = (id) => {
    if (id && !celebrations.includes(id)) celebrations.push(id);
  };
  const currentGtdTask = (u) => {
    const tasks = Array.isArray(u.tasks) ? u.tasks : [];
    return tasks.find((t) => officeState(t.status, { stale: u.stale }) === 'working')
      || tasks.find((t) => officeState(t.status, { stale: u.stale }) === 'blocked')
      || tasks.find((t) => !completed(t.status))
      || tasks[tasks.length - 1]
      || null;
  };
  const completionRecord = (u) => {
    const dept = u.scope;
    const base = {
      id: u.runDir,
      name: u.jira || u.slug,
      role: u.skill,
      dept,
      skill: u.skill,
      state: 'offshift',
      status: u.status,
      title: u.title,
      jira: u.jira,
      summary: u.title || u.slug,
      detail: '',
      progress: null,
      ...runMeta(u, dept, u.mission || null),
    };
    if (u.type === 'gtd') {
      const t = currentGtdTask(u);
      return {
        ...base,
        role: t?.kind || 'queue',
        status: t?.status || u.status,
        title: t?.title || u.title,
        summary: t?.title || u.title || u.slug,
        detail: t?.issue || u.note || '',
      };
    }
    if (u.type === 'gpd' || (u.type === 'registry' && u.mission)) {
      const m = u.type === 'gpd' ? u : u.mission;
      const met = m.criteria.filter((c) => c.met).length;
      const total = m.criteria.length;
      return {
        ...base,
        role: 'mission',
        title: u.title || m.title,
        summary: u.title || m.title || m.slug,
        detail: total ? `${met}/${total} acceptance criteria met` : '',
        progress: total ? { met, total } : null,
        criteria: m.criteria.map((c) => ({ text: c.text, met: c.met })),
        ...runMeta(u, dept, m),
      };
    }
    return base;
  };

  for (const u of units.filter(visible)) {
    if (completed(u.status)) {
      celebrate(u.runDir);
      completions.push(completionRecord(u));
    }
  }

  for (const u of active) {
    const dept = u.scope;
    if (u.type === 'gtd') {
      // A GTD queue is one fired agent. Task rows are folded into that officer's
      // current activity instead of becoming extra characters.
      const t = currentGtdTask(u);
      const taskState = t ? officeState(t.status, { stale: u.stale && officeState(t.status) === 'working' }) : u.state;
      push({
        id: u.runDir, name: u.slug, role: t?.kind || 'queue', dept,
        skill: u.skill, state: taskState === 'offshift' ? u.state : taskState,
        status: t?.status || u.status, title: t?.title || u.title, jira: u.jira,
        issue: t?.issue || '', note: u.note,
        ...runMeta(u, dept),
      });
    } else if (u.type === 'gpd' || ((u.type === 'registry' || u.type === 'jira-autopilot') && u.mission)) {
      const m = u.type === 'gpd' ? u : u.mission;
      const met = m.criteria.filter((c) => c.met).length;
      push({
        id: u.runDir, name: u.jira || m.slug, role: 'mission', dept,
        skill: u.skill, state: u.state, status: u.status, title: u.title || m.title, jira: u.jira,
        progress: m.criteria.length ? { met, total: m.criteria.length } : null,
        criteria: m.criteria.map((c) => ({ text: c.text, met: c.met })),
        ...runMeta(u, dept, m),
      });
    } else {
      push({
        id: u.runDir, name: u.jira || u.slug, role: u.skill, dept,
        skill: u.skill, state: u.state, status: u.status, title: u.title, jira: u.jira,
        ...runMeta(u, dept),
      });
    }
  }

  const deptById = new Map();
  for (const d of departments) {
    if (d && d.id && !deptById.has(d.id)) deptById.set(d.id, {
      id: d.id,
      label: d.label || (d.id === 'root' ? 'HQ · sidekicks' : d.id),
    });
  }
  for (const d of agents.map((a) => a.dept)) {
    if (!deptById.has(d)) deptById.set(d, {
      id: d,
      label: d === 'root' ? 'HQ · sidekicks' : d,
    });
  }
  const depts = [...deptById.values()];

  const counts = {
    working: agents.filter((a) => ['working', 'asleep', 'coffee', 'idle'].includes(a.state)).length,
    blocked: agents.filter((a) => a.state === 'blocked').length,
    failed: agents.filter((a) => a.state === 'failed').length,
    offshift: offshift.length,
  };

  return {
    generatedAt, branch, depts, agents, counts, celebrations, completions,
  };
}

// ---------------------------------------------------------------------------
// Office template — editable, reusable configuration (auto-saved on first run)
// ---------------------------------------------------------------------------

export function defaultConfig(depts) {
  return {
    schema_version: 1,
    _readme: [
      'Sidekicks Agent Office template — edit freely, the generator re-reads it every run.',
      'commonRooms: reorder/rename/remove shared rooms (kinds: lobby, meeting, presentation, coffee, fun, dept).',
      'deptRooms: one per project/run scope; new departments are auto-appended here with display=true; set display=false to hide one from the UI.',
      'runsRoots: EXTRA run-artifact locations to scan besides the standard <base>/artifacts/runs bases —',
      'each entry a repo-relative path to a runs folder (children are <skill>/<slug>/ run dirs),',
      'or { "path": "...", "dept": "<room>" } to pin the department (default: derived from projects/<p>/, else HQ).',
      'Single-segment * wildcards are expanded live (e.g. artifacts/runs/sidekicks-implementation-planner/*/artifacts/runs covers every plan tree; legacy docs/implementation-plans/*/artifacts/runs still works).',
      'palette/lighting/decor/building: cosmetic knobs. Delete this file to regenerate the default template.',
      'theme: default scene renderer (a folder name under scripts/office-viz-themes/, e.g. minecraft, darken-theme);',
      'the in-page theme selector records a localStorage viewer preference; --theme pins the render and disables switching.',
    ].join(' '),
    theme: 'minecraft',
    runsRoots: [],
    building: { width: 110, depth: 80, corridor: 7, footprintScale: 1, innerWallHeight: 1.7, outerWallHeight: 3.6 },
    palette: {
      grass: '#7FA06A', path: '#B9B2A4',
      outerWall: '#EAE0CE', innerWall: '#F0E7D7', wainscot: '#9DAF9A', trim: '#FBF7EE',
      corridorFloor: '#C9BFA9', woodFloor: '#C8A97C',
      deptFloors: ['#D8CFC0', '#CDD6CE', '#D6CCD6', '#D9D3C4', '#C9D2D9'],
      accents: ['#D98E2B', '#7A93A8', '#A87F9B', '#7FA88B', '#B0685A'],
    },
    lighting: { pendantsPerRoom: 2, roomLightDay: 0.32, roomLightNight: 1.05, corridorLights: true },
    decor: { paintingsPerRoom: 2, plants: true, rugs: true, windows: true },
    commonRooms: [
      { id: 'coffee', kind: 'coffee', label: 'Coffee Bar', weight: 5 },
      { id: 'lobby', kind: 'lobby', label: 'Lobby', weight: 6 },
      { id: 'meeting', kind: 'meeting', label: 'Meeting Room', weight: 5 },
      { id: 'presentation', kind: 'presentation', label: 'Presentation', weight: 5 },
      { id: 'fun', kind: 'fun', label: 'Arcade', weight: 5 },
    ],
    deptRooms: depts.map((d) => ({ dept: d.id, label: d.label, display: true })),
  };
}

/**
 * Cheap raw read of the template's runsRoots — collection needs the extras BEFORE the
 * full config load/create cycle runs (which itself needs collection's depts). Missing or
 * unreadable config simply means no extras.
 */
export function readRunsRootsConfig(configPath) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    return Array.isArray(cfg?.runsRoots) ? cfg.runsRoots : [];
  } catch { return []; }
}

/**
 * Extra runs-roots from the SHARED watch config `.sidekicks/agents-watch.yaml` — the same
 * file the artifact-manager's running-agents monitor reads, so the live office and the
 * centralized running-agents.json always cover the same folders. Entries have the same
 * shape as runsRoots (string paths with single-segment `*` wildcards, or { path, dept }).
 * Requires initYaml() to have run (main() awaits it before any collection). Missing,
 * unparseable, or `enabled: false` config simply means no extras.
 */
export function readWatchRootsConfig(root) {
  const raw = readYaml(join(root, '.sidekicks', 'agents-watch.yaml'));
  if (!raw || typeof raw !== 'object') return [];
  const b = (raw.agents_watch && typeof raw.agents_watch === 'object') ? raw.agents_watch : raw;
  if (b.enabled === false) return [];
  return Array.isArray(b.watch_roots) ? b.watch_roots.filter((e) =>
    (typeof e === 'string' && e.trim() !== '')
    || (e && typeof e === 'object' && typeof e.path === 'string' && e.path.trim() !== '')) : [];
}

export function loadOrCreateConfig(configPath, depts) {
  let cfg = null, created = false, changed = false;
  if (existsSync(configPath)) {
    try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch { cfg = null; }
  }
  if (!cfg || typeof cfg !== 'object') { cfg = defaultConfig(depts); created = true; }
  // Backfill any missing top-level sections from the default (template authored by an older version).
  const def = defaultConfig(depts);
  for (const k of Object.keys(def)) {
    if (cfg[k] == null) { cfg[k] = def[k]; changed = true; }
  }
  if (!Array.isArray(cfg.commonRooms) || cfg.commonRooms.length === 0) { cfg.commonRooms = def.commonRooms; changed = true; }
  if (!Array.isArray(cfg.deptRooms)) { cfg.deptRooms = []; changed = true; }
  for (const r of cfg.deptRooms) {
    if (r && r.display == null) { r.display = true; changed = true; }
  }
  // Auto-append new projects into the saved template.
  for (const d of depts) {
    if (!cfg.deptRooms.some((r) => r && r.dept === d.id)) {
      cfg.deptRooms.push({ dept: d.id, label: d.label, display: true });
      changed = true;
    }
  }
  if (created || changed) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
  }
  return { cfg, created, changed };
}

// ---------------------------------------------------------------------------
// Rendering — one self-contained HTML page (Three.js Sims-style simulation)
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderHTML(payload, threeSrc, themes = []) {
  const { generatedAt, branch, counts } = payload;
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  const themeScripts = themes.map((t) => `<script data-office-theme="${esc(t.name)}">\n${t.js}\n</script>`).join('\n');

  return `<title>Sidekicks Agent Office</title>
<style>
:root{
  --wall:#F7F6F2; --card:#FFFFFF; --line:#D8DAD4;
  --ink:#22282B; --ink2:#5A6268; --ink3:#8B9298;
  --accent:#D98E2B;
  --run:#2F6EA8; --done:#2E7D53; --blocked:#A5721F; --failed:#B23A31; --idle:#6E7478;
  --night:0;
}
@media (prefers-color-scheme: dark){:root{
  --wall:#0F1315; --card:#1B2124; --line:#2C3438;
  --ink:#E8EAE6; --ink2:#AEB6B2; --ink3:#7C8480;
  --accent:#E9A64A;
  --run:#4E92D1; --done:#3FA873; --blocked:#BD8526; --failed:#DB5F52; --idle:#9AA0A4;
  --night:1;
}}
:root[data-theme="dark"]{
  --wall:#0F1315; --card:#1B2124; --line:#2C3438;
  --ink:#E8EAE6; --ink2:#AEB6B2; --ink3:#7C8480;
  --accent:#E9A64A;
  --run:#4E92D1; --done:#3FA873; --blocked:#BD8526; --failed:#DB5F52; --idle:#9AA0A4;
  --night:1;
}
:root[data-theme="light"]{
  --wall:#F7F6F2; --card:#FFFFFF; --line:#D8DAD4;
  --ink:#22282B; --ink2:#5A6268; --ink3:#8B9298;
  --accent:#D98E2B;
  --run:#2F6EA8; --done:#2E7D53; --blocked:#A5721F; --failed:#B23A31; --idle:#6E7478;
  --night:0;
}
*{box-sizing:border-box}
body{margin:0;background:var(--wall);color:var(--ink);
  font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif;}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.wrap{max-width:1160px;margin:0 auto;padding:24px 18px 70px}
header.door{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:14px}
header.door h1{font-family:"Futura","Avenir Next","Century Gothic",sans-serif;
  font-size:clamp(20px,3.4vw,30px);letter-spacing:.14em;text-transform:uppercase;margin:0;text-wrap:balance}
header.door .sub{color:var(--ink2);font-size:12.5px}

/* Scene */
.scene{position:relative;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#0d1420}
canvas#office{display:block;width:100%;height:auto;cursor:default;touch-action:none}
.hud{position:absolute;top:10px;left:10px;display:flex;gap:6px;flex-wrap:wrap;pointer-events:none;max-width:70%}
.hud .chip{display:inline-flex;align-items:center;gap:6px;background:rgba(20,26,32,.62);
  backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:3px 10px;
  font-size:12px;color:#E8EAE6;font-variant-numeric:tabular-nums}
.hud .dot{width:8px;height:8px;border-radius:50%}
.topbar{position:absolute;top:10px;right:10px;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.topbar-row{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.ctl{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;max-width:min(100%,860px)}
.ctl button,.fs-fab{border:1px solid rgba(255,255,255,.16);background:rgba(20,26,32,.62);backdrop-filter:blur(4px);
  color:#D9DDD9;font:600 11.5px/1 -apple-system,"Segoe UI",system-ui,sans-serif;border-radius:6px;
  padding:6px 9px;cursor:pointer;letter-spacing:.04em}
.ctl button[aria-pressed="true"],.fs-fab[aria-pressed="true"]{background:var(--accent);color:#fff;border-color:var(--accent)}
.ctl button:focus-visible,.fs-fab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ctl select,.topbar select{border:1px solid rgba(255,255,255,.16);background:rgba(20,26,32,.62);backdrop-filter:blur(4px);
  color:#D9DDD9;font:600 11.5px/1 -apple-system,"Segoe UI",system-ui,sans-serif;border-radius:6px;
  padding:5px 7px;cursor:pointer;letter-spacing:.04em}
.ctl select:focus-visible,.topbar select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.ctl .sep{width:6px}
.scene:fullscreen{border:0;border-radius:0;display:flex;align-items:center;justify-content:center;background:#0d1420}
.scene:-webkit-full-screen{border:0;border-radius:0;display:flex;align-items:center;justify-content:center;background:#0d1420}
.hint{position:absolute;bottom:10px;right:12px;color:rgba(233,236,232,.55);font-size:11px;pointer-events:none}
.tip{position:absolute;z-index:6;max-width:260px;background:rgba(16,20,24,.92);color:#EDEFEA;
  font-size:11.5px;line-height:1.45;padding:7px 9px;border-radius:6px;pointer-events:none;
  box-shadow:0 3px 10px rgba(0,0,0,.35);display:none}
.tip b{display:block;font-size:12px}

/* Sims-style selected panel */
.panel{position:absolute;left:10px;right:10px;bottom:10px;display:none;align-items:center;gap:12px;
  background:rgba(18,23,28,.82);backdrop-filter:blur(6px);
  border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:10px 14px;box-shadow:0 4px 16px rgba(0,0,0,.3);
  color:#E8EAE6}
.panel.show{display:flex}
.panel .portrait{flex:none;width:46px;height:46px;border-radius:10px;display:grid;place-items:center;
  font:700 18px/1 "Futura","Avenir Next",sans-serif;color:#fff;overflow:hidden;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.24)}
.panel .portrait canvas{width:40px;height:40px;image-rendering:pixelated}
.panel .info{min-width:0;flex:1}
.panel .who{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.panel .who b{font-size:14px}
.panel .who .role{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:rgba(233,236,232,.6)}
.panel .title{font-size:12.5px;color:rgba(233,236,232,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.panel .bar{height:6px;border-radius:3px;background:rgba(255,255,255,.18);margin-top:6px;overflow:hidden;max-width:280px}
.panel .bar i{display:block;height:100%;background:var(--done)}
.panel .bar-l{font-size:10.5px;color:rgba(233,236,232,.6);margin-top:3px}
.panel .close{flex:none;border:none;background:none;color:rgba(233,236,232,.6);font-size:16px;cursor:pointer;padding:4px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#E8EAE6;
  border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:1px 8px}
.pill .dot{width:7px;height:7px;border-radius:50%}
.finish-pop{position:absolute;right:12px;bottom:58px;z-index:7;width:min(380px,calc(100% - 24px));
  display:none;grid-template-columns:54px minmax(0,1fr);gap:12px;align-items:center;
  background:rgba(18,23,28,.9);backdrop-filter:blur(8px);color:#E8EAE6;
  border:1px solid rgba(255,255,255,.18);border-left:4px solid var(--done);border-radius:10px;
  padding:12px 42px 12px 12px;box-shadow:0 10px 28px rgba(0,0,0,.42)}
.finish-pop.show{display:grid}
.finish-pop .finish-portrait{width:54px;height:54px;border-radius:9px;display:grid;place-items:center;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.24);overflow:hidden}
.finish-pop .finish-portrait canvas{width:48px;height:48px;image-rendering:pixelated}
.finish-pop .finish-kicker{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:rgba(233,236,232,.62)}
.finish-pop .finish-name{font-weight:750;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.finish-pop .finish-title{font-size:12.5px;color:rgba(233,236,232,.82);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.finish-pop .finish-detail{font-size:11.5px;color:rgba(233,236,232,.65);margin-top:3px}
.finish-pop .finish-close{position:absolute;top:7px;right:8px;border:none;background:none;color:rgba(233,236,232,.62);
  font-size:16px;cursor:pointer;padding:3px}

/* Archive */
footer{color:var(--ink3);font-size:12px;margin-top:14px}
footer code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.nogl{padding:60px 20px;text-align:center;color:#C9CFCB;font-size:14px}
</style>
<div class="wrap">
  <header class="door">
    <h1>Sidekicks · Agent Office</h1>
    <div class="sub">live 3D campus — generated <span id="gen-at">${esc(generatedAt)}</span>${branch ? ` · branch <span class="mono">${esc(branch)}</span>` : ''}</div>
  </header>

  <div class="scene" id="scene">
    <canvas id="office"></canvas>
    <div class="hud" aria-hidden="true">
      <span class="chip"><span class="dot" style="background:var(--run)"></span><span id="c-working">${counts.working} on duty</span></span>
      <span class="chip"><span class="dot" style="background:var(--blocked)"></span><span id="c-blocked">${counts.blocked} blocked</span></span>
      <span class="chip"><span class="dot" style="background:var(--failed)"></span><span id="c-failed">${counts.failed} failed</span></span>
      <span class="chip"><span class="dot" style="background:var(--done)"></span><span id="c-offshift">${counts.offshift} off shift</span></span>
      <span class="chip" id="wx">☀️ clear</span>
      <span class="chip" id="clk">--:--</span>
      <span class="chip" id="live" hidden></span>
    </div>
    <div class="topbar">
      <div class="topbar-row">
        <select id="theme-sel" title="office theme" aria-label="office theme"></select>
        <button id="fs-btn" class="fs-fab" aria-pressed="false" title="toggle full screen (f)">⛶</button>
      </div>
      <div class="ctl" role="group" aria-label="view and speed">
        <button data-view="iso" aria-pressed="true" title="isometric view">ISO</button>
        <button data-view="top" aria-pressed="false" title="top-down view">TOP</button>
        <button data-view="street" aria-pressed="false" title="lobby entrance view">STREET</button>
        <button data-view="tour" aria-pressed="false" title="slow auto-orbit">TOUR</button>
        <span class="sep"></span>
        <button data-speed="0" aria-pressed="false" title="pause">⏸</button>
        <button data-speed="1" aria-pressed="true" title="normal speed">1×</button>
        <button data-speed="2" aria-pressed="false" title="double speed">2×</button>
        <button data-speed="3" aria-pressed="false" title="triple speed">3×</button>
      </div>
    </div>
    <div class="hint">drag to orbit · wheel to zoom · right-drag to pan · click an officer</div>
    <div class="tip" id="tip"></div>
    <div class="finish-pop" id="finish-pop" hidden aria-live="polite">
      <button class="finish-close" id="finish-close" aria-label="close completion popup">✕</button>
      <div class="finish-portrait" id="finish-portrait"><canvas id="finish-head" width="48" height="48"></canvas></div>
      <div class="finish-copy">
        <div class="finish-kicker" id="finish-kicker">Finished</div>
        <div class="finish-name" id="finish-name"></div>
        <div class="finish-title" id="finish-title"></div>
        <div class="finish-detail" id="finish-detail"></div>
      </div>
    </div>
    <div class="panel" id="panel">
      <div class="portrait" id="p-portrait"><canvas id="p-head" width="48" height="48"></canvas></div>
      <div class="info">
        <div class="who"><b id="p-name"></b><span class="role" id="p-role"></span><span class="pill" id="p-pill"><span class="dot" id="p-dot"></span><span id="p-state"></span></span></div>
        <div class="title" id="p-title"></div>
        <div class="bar" id="p-bar" hidden><i id="p-bar-i"></i></div>
        <div class="bar-l" id="p-bar-l" hidden></div>
      </div>
      <button class="close" id="p-close" aria-label="close panel">✕</button>
    </div>
  </div>

  <footer>Click an officer for a closer look · the floor plan is an editable template at <code>.sidekicks/office-config.json</code> (rooms, palette, decor, lighting) — new projects are auto-added to it · Regenerate: <code>node scripts/agent-office-viz.mjs</code>. Read-only over run artifacts. 3D: Three.js (MIT, vendored).</footer>
</div>
<script>${threeSrc}</script>
<script>window.OFFICE_DATA = ${data};</script>
${themeScripts}
<script>
${RUNTIME_JS}
</script>
`;
}

// ---------------------------------------------------------------------------
// Themes — pluggable scene renderers, one folder per theme
// ---------------------------------------------------------------------------
//
// A theme is a single self-contained client script at
//   office-viz-themes/<name>/theme.js   (sibling of this generator)
// or an ordered local bundle listed in
//   office-viz-themes/<name>/theme.manifest.json  as { "files": ["...js"] }
// Entries are theme-folder-relative by default. Entries under _shared/ are resolved from
// office-viz-themes/_shared/ so common renderer modules live in one file. Value-driven
// themes load theme-values.js first, then the shared renderer modules.
// that registers itself:
//   window.OFFICE_THEMES[<name>] = { label: '<display name>', boot: function (ctx) {...} }
// boot(ctx) receives { data } (the OFFICE_DATA payload — agents, counts,
// config) and builds its scene into the fixed page DOM (#scene, #office canvas, #tip,
// #panel, the .ctl view/speed buttons). It returns { applyPayload(payload) } for live
// SSE updates, or undefined when it cannot render (e.g. WebGL unavailable).
// The page runtime below owns everything theme-independent: the theme selector,
// HUD counts, and the SSE client. ALL bundled themes are embedded
// in the page; the selector switch persists to localStorage and reloads, so each theme
// always boots fresh. Default theme: config.theme (office-config.json), overridden by
// a viewer's saved selector choice unless --theme pins the render.

export function loadThemes(scriptDir) {
  const themesDir = join(scriptDir, 'office-viz-themes');
  const themes = [];
  for (const name of dirs(themesDir).sort()) {
    const file = join(themesDir, name, 'theme.js');
    const manifest = join(themesDir, name, 'theme.manifest.json');
    if (!existsSync(file) && !existsSync(manifest)) continue;
    let js;
    if (existsSync(manifest)) {
      const spec = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!Array.isArray(spec.files) || spec.files.length === 0) {
        throw new Error(`theme "${name}" manifest must contain a non-empty files array`);
      }
      const themeDir = join(themesDir, name);
      js = spec.files.map((rel) => {
        if (typeof rel !== 'string' || rel.includes('\0') || !rel.endsWith('.js')) {
          throw new Error(`theme "${name}" manifest entries must be relative .js paths`);
        }
        const base = rel.startsWith('_shared/') ? themesDir : themeDir;
        const guard = rel.startsWith('_shared/') ? join(themesDir, '_shared') : themeDir;
        const abs = resolve(base, rel);
        const inside = relative(guard, abs);
        if (inside.startsWith('..') || isAbsolute(inside)) {
          throw new Error(`theme "${name}" manifest entry escapes the theme folder or shared folder: ${rel}`);
        }
        return readFileSync(abs, 'utf8');
      }).join('\n');
    } else {
      js = readFileSync(file, 'utf8');
    }
    // </script would terminate the embedding <script> block early — defang it.
    themes.push({ name, js: js.replace(/<\/script/gi, '<\\/script') });
  }
  return themes;
}

export function resolveOfficeTheme({ cfg = {}, themes = [], themeOverride = null, configPath = null } = {}) {
  const bundled = themes.map((t) => t.name).filter(Boolean);
  const available = new Set(bundled);
  const configured = themeOverride || (typeof cfg.theme === 'string' && cfg.theme.trim() ? cfg.theme.trim() : 'minecraft');
  if (!available.has(configured)) {
    const source = themeOverride ? '--theme' : (configPath || officeConfigPath(resolveRoot()));
    throw new Error(`office theme "${configured}" from ${source} is not bundled; bundled themes: ${bundled.join(', ') || '(none)'}`);
  }
  return configured;
}

// The shared in-page runtime: theme registry → selector → boot, plus HUD
// refresh and the SSE client (which hands each payload to the booted theme).
// Plain script (no backticks / template interpolation) so it embeds safely inside
// the generator's template literal.
export const RUNTIME_JS = String.raw`
(function () {
  'use strict';
  var DATA = window.OFFICE_DATA;
  var THEMES = window.OFFICE_THEMES || {};
  var names = Object.keys(THEMES);
  if (names.length === 0) return;
  var KEY = 'sidekicks-office-theme';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { /* sandboxed storage */ }
  var configTheme = (DATA.config && DATA.config.theme) || 'minecraft';
  var pinned = !!(DATA.config && DATA.config.themePinned);
  var name = pinned && THEMES[configTheme] ? configTheme
    : ((stored && THEMES[stored]) ? stored : (THEMES[configTheme] ? configTheme : names[0]));

  var sel = document.getElementById('theme-sel');
  if (sel) {
    names.sort().forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      o.textContent = THEMES[k].label || k;
      if (k === name) o.selected = true;
      sel.appendChild(o);
    });
    if (names.length < 2) sel.style.display = 'none';
    if (pinned) {
      sel.disabled = true;
      sel.title = 'office theme pinned by --theme';
    }
    sel.addEventListener('change', function () {
      try { localStorage.setItem(KEY, sel.value); } catch (e) { /* best-effort */ }
      location.reload(); // each theme boots fresh — no cross-theme teardown needed
    });
  }

  var api = null;
  try { api = THEMES[name].boot({ data: DATA }); } catch (e) {
    if (window.console && console.error) console.error('office theme "' + name + '" failed to boot', e);
  }

  function setText(id, s) { var el = document.getElementById(id); if (el) el.textContent = s; }
  function applyShared(p) {
    setText('gen-at', p.generatedAt || '');
    var counts = p.counts || {};
    setText('c-working', (counts.working || 0) + ' on duty');
    setText('c-blocked', (counts.blocked || 0) + ' blocked');
    setText('c-failed', (counts.failed || 0) + ' failed');
    setText('c-offshift', (counts.offshift || 0) + ' off shift');
  }

  // live updates (SSE — active only when the page is served via --serve; the static
  // file:// path never opens the stream)
  var liveEl = document.getElementById('live');
  if (/^https?:$/.test(location.protocol) && window.EventSource) {
    var es = new EventSource('/events');
    es.onopen = function () { if (liveEl) { liveEl.hidden = false; liveEl.textContent = '🔴 live'; } };
    es.onerror = function () { if (liveEl) { liveEl.hidden = false; liveEl.textContent = '⚪ reconnecting…'; } };
    es.onmessage = function (ev) {
      var p;
      try { p = JSON.parse(ev.data); } catch (e) { return; /* malformed frame — skip it */ }
      applyShared(p);
      if (api && api.applyPayload) {
        try { api.applyPayload(p); } catch (e) {
          if (window.console && console.error) console.error('office theme "' + name + '" applyPayload failed', e);
        }
      }
    };
  }
})();
`;


// ---------------------------------------------------------------------------
// Live server (--serve) — zero-dependency node:http + SSE push on artifact change
// ---------------------------------------------------------------------------

const SERVE_DEFAULT_PORT = 4680;
const WATCH_DEBOUNCE_MS = 300;
const WATCH_RESCAN_MS = 10_000;
const SSE_HEARTBEAT_MS = 25_000;
const SERVE_LOCK = '.serve.lock.json'; // singleton marker next to the generated HTML

// ---- serve singleton — one live office server per repo ---------------------------
// The lock records {pid, port}. A second `--serve` refuses to start while the recorded
// pid is alive (pass --replace to stop it and take over); EADDRINUSE on listen is the
// backstop for a foreign process already bound to the port.

function serveLockPath(root) { return join(root, 'artifacts', 'office-viz', SERVE_LOCK); }

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); } // EPERM = alive but not ours
}

export function readServeLock(root) {
  try { return JSON.parse(readFileSync(serveLockPath(root), 'utf8')); } catch { return null; }
}

function writeServeLock(root, port, host = '127.0.0.1') {
  try {
    mkdirSync(dirname(serveLockPath(root)), { recursive: true });
    writeFileSync(serveLockPath(root), JSON.stringify({
      pid: process.pid, port, host, started_at: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch { /* best-effort */ }
}

function clearServeLock(root) {
  try {
    const l = readServeLock(root);
    if (l && l.pid === process.pid) rmSync(serveLockPath(root), { force: true });
  } catch { /* best-effort */ }
}

/** True when this process may start the server (stale locks are swept; --replace kills the live holder). */
export async function acquireServeSingleton(root, { replace = false, log = (m) => process.stderr.write(m + '\n') } = {}) {
  const lock = readServeLock(root);
  if (!lock || lock.pid === process.pid || !pidAlive(lock.pid)) return true; // free or stale
  if (!replace) {
    const host = lock.host || '127.0.0.1';
    log(`[agent-office-viz] a live office server is already running (pid ${lock.pid}, http://${host}:${lock.port || SERVE_DEFAULT_PORT}/)`
      + ' — refusing to start a second one; rerun with --replace to take over');
    return false;
  }
  log(`[agent-office-viz] --replace: stopping previous office server (pid ${lock.pid})`);
  try { process.kill(lock.pid); } catch { /* already gone */ }
  for (let i = 0; i < 30 && pidAlive(lock.pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(lock.pid)) {
    log(`[agent-office-viz] previous server (pid ${lock.pid}) did not exit — aborting`);
    return false;
  }
  return true;
}

function readBranch(root) {
  try {
    return readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim().replace(/^ref: refs\/heads\//, '');
  } catch { return ''; } // detached or no git — omit
}

function bangkokNow() {
  const t = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour12: false });
  return `${t} (Asia/Bangkok)`;
}

/**
 * Watch every base's artifacts/runs/ tree for changes. Prefers one recursive
 * fs.watch per runs-root (macOS/Windows, and Linux on modern Node); when the
 * platform rejects { recursive: true } it falls back to watching every directory
 * in the tree individually, re-walking on each ensure() to pick up new subdirs.
 * ensure() is also re-run on a slow interval so a runs-root created AFTER boot
 * (first run of a new project/service) starts being watched without a restart.
 */
export function watchRuns(root, onEvent, getExtras = () => []) {
  const watched = new Map(); // dir → FSWatcher
  let recursiveOk = true;

  function tryWatch(dir, recursive) {
    try {
      const w = watch(dir, recursive ? { recursive: true } : {}, onEvent);
      w.on('error', () => { try { w.close(); } catch { /* already dead */ } watched.delete(dir); });
      watched.set(dir, w);
      return true;
    } catch (e) {
      if (recursive && e && e.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') return false;
      return true; // dir vanished between scan and watch — ensure() will retry
    }
  }

  function walkDirs(dir, acc) {
    acc.push(dir);
    for (const d of dirs(dir)) walkDirs(join(dir, d), acc);
  }

  function ensure() {
    for (const { runsRoot } of resolveRunsRoots(root, getExtras())) {
      if (!existsSync(runsRoot)) continue;
      if (recursiveOk) {
        if (!watched.has(runsRoot) && !tryWatch(runsRoot, true)) {
          recursiveOk = false; // fall through to per-directory mode below
        }
      }
      if (!recursiveOk) {
        const all = [];
        walkDirs(runsRoot, all);
        for (const d of all) if (!watched.has(d)) tryWatch(d, false);
      }
    }
  }

  ensure();
  const rescan = setInterval(ensure, WATCH_RESCAN_MS);
  rescan.unref();
  return { ensure, close() { clearInterval(rescan); for (const w of watched.values()) { try { w.close(); } catch { /* noop */ } } } };
}

export function startServer(root, { port, host = '127.0.0.1', configPath, threeSrc, themes = [], themeOverride = null, activeOnly = true, extraRunsRoots = [], log = (m) => process.stderr.write(m + '\n') }) {
  let clients = [];
  let lastCore = ''; // last payload minus the timestamp — suppress no-op pushes

  // Config-declared roots (office-config runsRoots + the shared agents-watch.yaml) are
  // re-read per snapshot/rescan, so adding an entry to
  // the template while the server runs starts covering it live (within the 10s rescan).
  const allExtras = () => [...extraRunsRoots, ...readRunsRootsConfig(configPath), ...readWatchRootsConfig(root)];

  function snapshot() {
    const units = collect(root, Date.now(), allExtras());
    const departments = departmentCandidates(units, projectDepartments(root));
    const { cfg } = loadOrCreateConfig(configPath, departments);
    return buildPayload(units, {
      generatedAt: bangkokNow(),
      branch: readBranch(root),
      activeOnly,
      departments: visibleDepartments(departments, cfg),
    });
  }

  function broadcast() {
    const payload = snapshot();
    const core = JSON.stringify({ ...payload, generatedAt: null });
    if (core === lastCore) return;
    lastCore = core;
    const line = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const c of clients) c.write(line);
    log(`[agent-office-viz] change → pushed ${payload.agents.length} officers to ${clients.length} client${clients.length === 1 ? '' : 's'}`);
  }

  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      const payload = snapshot();
      const { cfg } = loadOrCreateConfig(configPath, projectDepartments(root));
      const theme = resolveOfficeTheme({ cfg, themes, themeOverride, configPath });
      payload.config = { ...cfg, theme, themePinned: !!themeOverride };
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderHTML(payload, threeSrc, themes));
    } else if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
      clients.push(res);
      req.on('close', () => { clients = clients.filter((c) => c !== res); });
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });

  let debounce = null;
  const watcher = watchRuns(root, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { watcher.ensure(); broadcast(); }, WATCH_DEBOUNCE_MS);
  }, allExtras);

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      log(`[agent-office-viz] port ${port} is already in use — another office server (or process) is bound there; not starting a second one`);
      process.exit(2);
    }
    throw e;
  });
  server.listen(port, host, () => {
    writeServeLock(root, port, host);
    const mode = activeOnly ? 'active officers only — pass --all for the full floor' : 'full floor (--all)';
    log(`[agent-office-viz] live office at http://${host}:${port}/ — watching artifacts/runs, ${mode} (Ctrl-C to stop)`);
  });
  process.on('exit', () => clearServeLock(root));
  ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { clearServeLock(root); process.exit(0); }));
  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const root = resolveRoot();
  await initYaml(root);
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf('--config');
  const configPath = cfgIdx >= 0 && args[cfgIdx + 1]
    ? resolve(args[cfgIdx + 1])
    : officeConfigPath(root);
  // Extra run-artifact locations: repeatable --runs-root <path> flags, plus the template's
  // persistent runsRoots entries, plus the SHARED .sidekicks/agents-watch.yaml watch roots
  // (the running-agents monitor's coverage) — additive on top of the standard scan bases.
  const cliRunsRoots = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs-root' && args[i + 1]) cliRunsRoots.push(args[++i]);
  }
  const extraRunsRoots = [...cliRunsRoots, ...readRunsRootsConfig(configPath), ...readWatchRootsConfig(root)];
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(collect(root, Date.now(), extraRunsRoots), null, 2) + '\n');
    process.exit(0);
  }
  const vendor = join(dirname(fileURLToPath(import.meta.url)), 'office-viz-vendor', 'three.min.js');
  if (!existsSync(vendor)) {
    process.stderr.write('[agent-office-viz] missing vendored Three.js at ' + vendor + '\n'
      + '  fetch it once: curl -sL -o scripts/office-viz-vendor/three.min.js https://unpkg.com/three@0.147.0/build/three.min.js\n');
    process.exit(1);
  }
  const threeSrc = readFileSync(vendor, 'utf8');

  // Bundled scene themes (office-viz-themes/<name>/theme.js siblings of this script) —
  // all are embedded in the page; --theme <name> pins the default for this render/serve
  // (viewer's in-page selector choice still wins on their own browser).
  const themes = loadThemes(dirname(fileURLToPath(import.meta.url)));
  if (themes.length === 0) {
    process.stderr.write('[agent-office-viz] no themes found under office-viz-themes/ next to the generator — the page would render no scene\n');
    process.exit(1);
  }
  const themeIdx = args.indexOf('--theme');
  const themeArg = themeIdx >= 0 && args[themeIdx + 1] ? args[themeIdx + 1] : null;
  if (themeArg && !themes.some((t) => t.name === themeArg)) {
    process.stderr.write(`[agent-office-viz] unknown theme "${themeArg}" — bundled: ${themes.map((t) => t.name).join(', ')}\n`);
    process.exit(1);
  }

  const serveIdx = args.indexOf('--serve');
  if (serveIdx >= 0) {
    const p = args[serveIdx + 1];
    const port = p && /^\d+$/.test(p) ? Number(p) : SERVE_DEFAULT_PORT;
    const hostIdx = args.indexOf('--host');
    const host = hostIdx >= 0 && args[hostIdx + 1] ? args[hostIdx + 1] : '127.0.0.1';
    // Live mode defaults to active officers only (the point of watching live is "what is
    // being worked on RIGHT NOW"); --all restores the full floor including stale runs.
    // Config-declared runsRoots are re-read live inside the server; only CLI flags pin here.
    const preflightUnits = collect(root, Date.now(), extraRunsRoots);
    const preflightDepartments = departmentCandidates(preflightUnits, projectDepartments(root));
    const { cfg: preflightCfg } = loadOrCreateConfig(configPath, preflightDepartments);
    try {
      resolveOfficeTheme({ cfg: preflightCfg, themes, themeOverride: themeArg, configPath });
    } catch (e) {
      process.stderr.write(`[agent-office-viz] ${e.message}\n`);
      process.exit(1);
    }
    if (!(await acquireServeSingleton(root, { replace: args.includes('--replace') }))) process.exit(2);
    startServer(root, { port, host, configPath, threeSrc, themes, themeOverride: themeArg, activeOnly: !args.includes('--all'), extraRunsRoots: cliRunsRoots });
  } else {
    const units = collect(root, Date.now(), extraRunsRoots);
    const outIdx = args.indexOf('--out');
    const out = outIdx >= 0 && args[outIdx + 1]
      ? resolve(args[outIdx + 1])
      : join(root, 'artifacts', 'office-viz', 'agent-office.html');
    const departments = departmentCandidates(units, projectDepartments(root));
    const { cfg, created, changed } = loadOrCreateConfig(configPath, departments);
    const payload = buildPayload(units, {
      generatedAt: bangkokNow(), branch: readBranch(root),
      activeOnly: args.includes('--active-only'), // static default: full floor, unchanged
      departments: visibleDepartments(departments, cfg),
    });
    let theme;
    try {
      theme = resolveOfficeTheme({ cfg, themes, themeOverride: themeArg, configPath });
    } catch (e) {
      process.stderr.write(`[agent-office-viz] ${e.message}\n`);
      process.exit(1);
    }
    payload.config = { ...cfg, theme, themePinned: !!themeArg };
    const html = renderHTML(payload, threeSrc, themes);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    if (created) process.stderr.write(`[agent-office-viz] office template created → ${configPath} (edit it, it persists)\n`);
    else if (changed) process.stderr.write(`[agent-office-viz] office template updated (new projects appended) → ${configPath}\n`);
    process.stderr.write(`[agent-office-viz] ${payload.agents.length} officers on the 3D campus, ${payload.counts.offshift} off shift → ${out}\n`);
  }
}
