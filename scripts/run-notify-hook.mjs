#!/usr/bin/env node
// run-notify-hook.mjs — Stop / SubagentStop / SessionStart hook.
//
// Deterministic run-completion notifier: the "alternate path" to run reporting that is
// NOT wired into any skill. Skills only leave their normal run state behind (a registry
// run.json via `sidekicks artifacts register`, or a get-things-done tasks.yaml); this hook
// scans that state after each agent turn (Stop/SubagentStop) and at session start
// (catch-up for runs that finished while no session was open), and delivers a Slack
// message — or an email via scripts/send-mail.py — for every run that newly reached a
// notify-worthy status. No model involvement, no skill text, no CLAUDE.md policy needed:
// the whole behavior is config + this script.
//
// Opt-in per scope via a `run_notify:` block in the scope config
// (.sidekicks/config.yaml for root, projects/<p>/config.yaml for a project):
//
//   run_notify:
//     enabled: true            # REQUIRED true — absent/false = this hook does nothing
//     transports: [slack]      # any of: slack, email (default [slack])
//     env: my-workspace        # slack: alias to use (default: first alias in slack:)
//     skills: []               # optional allow-list of skill names (short or full);
//                              # empty/absent = all skills
//     catchup_hours: 24        # runs already terminal but last updated more than this
//                              # many hours ago are marked seen WITHOUT notifying, so
//                              # enabling the hook never floods history (default 24)
//
// Slack delivery reuses the sk-slack-connector config shape (`slack:` block in
// the same scope config): channel resolves notifications.skills.<name> ->
// notifications.channel -> default_channel; notify_user prepends an @mention of
// default_user. Sent natively via fetch (chat.postMessage) — no python, no deps.
// Email delivery shells out to scripts/send-mail.py with the scope config
// (mail_sender.default_recipient), via the repo-root .venv python.
//
// State: a `.notify-state.json` marker inside each run dir records the last status
// notified; a run is (re-)notified only when its status changed since the marker.
// Best-effort throughout: any failure logs to stderr and exits 0 — never blocks a turn.
//
// Zero npm dependencies — node:* + lib/ back-edges only. Works on macOS and Windows.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Root + scope resolution (same CLI-agnostic pattern as gtd-orphan-watch-hook)
// ---------------------------------------------------------------------------

export function resolveRoot() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR || process.env.AGENT_PROJECT_DIR;
  if (fromEnv && existsSync(resolve(fromEnv, '.sidekicks'))) return fromEnv;
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir && dir !== dirname(dir)) {
    if (existsSync(resolve(dir, '.sidekicks'))) return dir;
    dir = dirname(dir);
  }
  return fromEnv || process.cwd();
}

function dirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Parse a YAML file with the repo's zero-dep yaml-subset parser. Returns null when the
 * file is absent or the parser rejects it (a hand-written config can contain constructs
 * outside the subset — that must never crash a hook).
 */
export function readYaml(file) {
  try {
    if (!existsSync(file)) return null;
    return yamlParse(readFileSync(file, 'utf8'));
  } catch (err) {
    // An UNREADABLE file is this function's contract: return null and let the caller treat the
    // scope as unconfigured. A MISSING PARSER is not — it means initYaml() was never awaited, and
    // swallowing it turns a programming error into "no scope has run_notify enabled", which is
    // indistinguishable from the hook working correctly and having nothing to send. That is
    // exactly how a Node 20 hook-ordering bug hid nine silent failures in this file's test suite.
    if (err instanceof YamlNotInitialized) throw err;
    return null;
  }
}

/** Thrown when readYaml runs before initYaml — a programming error, never a config condition. */
class YamlNotInitialized extends Error {}

let _parse = null;
function yamlParse(text) {
  // The ESM parser must be loaded async up front — main() (and tests) await initYaml()
  // before any readYaml call, so this only throws on a programming error.
  if (!_parse) throw new YamlNotInitialized('yaml parser not initialized — call initYaml(root) first');
  return _parse(text);
}

export async function initYaml(root) {
  const mod = await import(pathToFileURL(join(root, 'lib', 'yaml-subset', 'yaml.mjs')).href);
  _parse = mod.parse;
}

// ---------------------------------------------------------------------------
// Run discovery — registry run.json headers + get-things-done queues
// ---------------------------------------------------------------------------

/** Bases where run artifacts anchor: repo root, each project, each service src. */
export function scanBases(root) {
  const bases = [{ base: root, scope: 'root' }];
  for (const p of dirs(join(root, 'projects'))) {
    bases.push({ base: join(root, 'projects', p), scope: p });
    const svcRoot = join(root, 'projects', p, 'services');
    for (const s of dirs(svcRoot)) {
      bases.push({ base: join(svcRoot, s, 'src'), scope: p });
    }
  }
  return bases;
}

/** Discover registry runs (run.json) and GTD queues (tasks.yaml) under one base. */
export function discoverRuns(root, base, scope) {
  const runs = [];
  const runsRoot = join(base, 'artifacts', 'runs');
  for (const skill of dirs(runsRoot)) {
    for (const slug of dirs(join(runsRoot, skill))) {
      const runDir = join(runsRoot, skill, slug);
      const runJson = join(runDir, 'run.json');
      const tasksYaml = join(runDir, 'tasks.yaml');
      if (existsSync(runJson)) {
        try {
          const m = JSON.parse(readFileSync(runJson, 'utf8'));
          runs.push({
            kind: 'registry', runDir, scope,
            skill: m.skill || skill, slug: m.slug || slug,
            status: m.status || 'running',
            title: m.title || '', jiraCard: m.jira_card || null, goal: m.goal || '',
            updatedAt: m.updated_at || m.created_at || null,
            detail: null,
          });
        } catch { /* unreadable header is not this hook's problem */ }
      } else if (skill === 'get-things-done' && existsSync(tasksYaml)) {
        const q = readGtdQueue(tasksYaml);
        if (q) runs.push({ ...q, runDir, scope, skill: 'get-things-done', slug });
      }
    }
  }
  return runs;
}

/** Reduce a GTD tasks.yaml to a notifiable status + task-count detail. */
export function readGtdQueue(file) {
  const q = readYaml(file);
  if (!q || typeof q !== 'object') return null;
  const stage = q.control && q.control.stage ? String(q.control.stage) : '';
  const status = q.status ? String(q.status) : '';
  const tasks = Array.isArray(q.tasks) ? q.tasks : [];
  const counts = {};
  for (const t of tasks) {
    const s = t && t.status ? String(t.status) : 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  const blocked = counts.blocked || 0;
  const failed = counts.failed || 0;
  // Queue-level effective status: terminal when the stop stage ran (or status says so);
  // otherwise surface blocked/failed as a critical mid-run state.
  let effective = 'running';
  if (stage === 'stop' || ['done', 'stopped', 'failed', 'blocked'].includes(status)) {
    effective = status && status !== 'running' && status !== 'idle' ? status : 'done';
  } else if (blocked > 0 || failed > 0) {
    effective = failed > 0 ? 'failed' : 'blocked';
  }
  const mt = statSafe(file);
  return {
    kind: 'gtd',
    status: effective,
    title: q.queue ? `queue ${q.queue}` : '',
    jiraCard: q.jira && q.jira.card ? q.jira.card : null,
    goal: q.status_note || '',
    updatedAt: mt ? new Date(mt).toISOString() : null,
    detail: Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '),
  };
}

function statSafe(f) {
  try { return statSync(f).mtimeMs; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Notify decision — marker state per run dir
// ---------------------------------------------------------------------------

export const NOTIFY_STATUSES = ['done', 'blocked', 'failed', 'paused', 'halted', 'awaiting-merge', 'stopped'];
const MARKER = '.notify-state.json';

export function readMarker(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, MARKER), 'utf8')); } catch { return null; }
}

export function writeMarker(runDir, state) {
  try { writeFileSync(join(runDir, MARKER), JSON.stringify(state, null, 2) + '\n'); } catch { /* best-effort */ }
}

/**
 * Decide what to do with a run: 'notify' (send + mark), 'seed' (mark silently — the run
 * was already terminal before the hook ever saw it, don't flood history), or null (skip).
 */
export function decide(run, marker, nowMs, catchupHours) {
  if (!NOTIFY_STATUSES.includes(run.status)) return null;
  if (marker && marker.last_status === run.status) return null; // already notified this state
  const updatedMs = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  const ageH = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / 3600000 : Infinity;
  if (!marker && ageH > catchupHours) return 'seed';
  return 'notify';
}

/**
 * Does the scope's allow-list admit this skill? Accepts short and full names, under EITHER
 * prefix — the list is operator-written configuration that may predate the `sidekicks-` → `sk-`
 * rename, and a silently-narrowed allow-list just stops sending notifications.
 */
export function skillAllowed(allowList, skill) {
  if (!Array.isArray(allowList) || allowList.length === 0) return true;
  return allowList.some((s) => s === skill || s === `sk-${skill}` || s === `sidekicks-${skill}`);
}

// ---------------------------------------------------------------------------
// Slack + email transports
// ---------------------------------------------------------------------------

/** notifications.skills.<name> -> notifications.channel -> default_channel */
export function resolveChannel(alias, skill) {
  const n = alias.notifications || {};
  const skills = n.skills || {};
  // Both spellings, for the same reason as skillAllowed: this map is operator-written config.
  return skills[`sk-${skill}`] || skills[`sidekicks-${skill}`] || skills[skill]
    || n.channel || alias.default_channel || null;
}

export function composeMessage(run) {
  const icon = run.status === 'done' ? ':white_check_mark:'
    : ['failed', 'blocked'].includes(run.status) ? ':rotating_light:' : ':warning:';
  const head = `${icon} *sk-${run.skill}* \`${run.slug}\` → *${run.status.toUpperCase()}*`;
  const lines = [head];
  if (run.title) lines.push(`> ${run.title}`);
  if (run.jiraCard) lines.push(`> card: ${run.jiraCard}`);
  if (run.detail) lines.push(`> tasks: ${run.detail}`);
  if (run.goal) lines.push(`> ${String(run.goal).slice(0, 300)}`);
  lines.push(`> run: \`${run.runDir}\``);
  return lines.join('\n');
}

export async function sendSlack(alias, skill, text, fetchImpl = fetch) {
  const channel = resolveChannel(alias, skill);
  if (!alias.bot_token || !channel) return { ok: false, error: 'slack config incomplete (bot_token/channel)' };
  const mention = alias.notify_user && alias.default_user ? `<@${alias.default_user}> ` : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alias.bot_token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text: mention + text, unfurl_links: false }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return body.ok ? { ok: true, channel } : { ok: false, error: body.error || `http ${res.status}` };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function venvPython(root) {
  const posix = join(root, '.venv', 'bin', 'python');
  const win = join(root, '.venv', 'Scripts', 'python.exe');
  if (existsSync(posix)) return posix;
  if (existsSync(win)) return win;
  return null;
}

export function sendEmail(root, configPath, subject, body) {
  const py = venvPython(root);
  const script = join(root, 'scripts', 'send-mail.py');
  if (!py || !existsSync(script)) return { ok: false, error: 'no .venv python or send-mail.py' };
  const r = spawnSync(py, [script, '--config', configPath, '--subject', subject, '--body', body], {
    timeout: 20000, encoding: 'utf8',
  });
  return r.status === 0
    ? { ok: true }
    : { ok: false, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

export function scopeConfigPath(root, scope) {
  return scope === 'root'
    ? join(root, '.sidekicks', 'config.yaml')
    : join(root, 'projects', scope, 'config.yaml');
}

/**
 * Read a scope config tolerating constructs yaml-subset rejects. Real config.yaml files
 * carry anchors/aliases and other full-YAML features in unrelated blocks (database envs
 * etc.); a whole-file parse failure must not silently disable notifications. Fallback:
 * slice each top-level block this hook needs (run_notify, slack, mail_sender) out of the
 * raw text — from its column-0 key to the next column-0 key — and parse the slices
 * independently.
 */
/**
 * The blocks this hook reads, and the family file they now live in.
 *
 * All three are `comms` family members (`sidekicks config list`), so one file covers them. The names
 * are repeated here rather than imported because a hook must keep working when lib/ is unavailable —
 * the same fail-open stance as scripts/lib/hook-gate.mjs.
 */
const NOTIFY_BLOCKS = ['run_notify', 'slack', 'mail_sender'];
const NOTIFY_FAMILY = 'comms';

/**
 * Read a scope's family files for the notification blocks: the committed `comms.yaml` and its
 * git-ignored `comms.secret.yaml` sibling, which carries the bot tokens and the SMTP password.
 *
 * Returned merged per key with the secret half on top — the same order lib/config-store/read.mjs
 * uses inside one scope group.
 *
 * @param {string} scopeDir - the scope base directory (.sidekicks/ or projects/<p>/)
 * @returns {object|null}
 */
function readFamilyConfig(scopeDir) {
  const merged = {};
  // Secret file FIRST, then the committed one: highest precedence is read first and lower layers only
  // fill what is missing — the same direction lib/config-store/read.mjs uses.
  for (const name of [`${NOTIFY_FAMILY}.secret.yaml`, `${NOTIFY_FAMILY}.yaml`]) {
    const file = join(scopeDir, 'config', name);
    if (!existsSync(file)) continue;
    const parsed = readScopeConfigFile(file);
    if (!parsed) continue;
    for (const [block, value] of Object.entries(parsed)) {
      if (!NOTIFY_BLOCKS.includes(block)) continue;
      if (!value || typeof value !== 'object') continue;
      merged[block] = merged[block] ? fillMissingDeep(merged[block], value) : structuredClone(value);
    }
  }
  return Object.keys(merged).length ? merged : null;
}

/**
 * Fill what `target` lacks from `source`, recursively. An empty string or null in `target` is a
 * placeholder (the committed family file keeps `bot_token: ""` so a fresh clone can see what to
 * supply), so a real value from a lower layer replaces it.
 *
 * DEEP on purpose: a shallow merge would let `comms.secret.yaml`'s `slack.ws` mapping replace the
 * committed file's `slack.ws` outright, silently dropping `default_channel` — the split would break
 * exactly the notifications it was meant to make portable.
 *
 * @param {object} target - mutated and returned
 * @param {object} source
 * @returns {object}
 */
function fillMissingDeep(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    const bothMappings = existing && typeof existing === 'object' && !Array.isArray(existing)
      && value && typeof value === 'object' && !Array.isArray(value);
    if (bothMappings) { fillMissingDeep(existing, value); continue; }
    const missing = !Object.prototype.hasOwnProperty.call(target, key)
      || existing === '' || existing === null;
    if (missing && value !== '' && value !== null) target[key] = value;
    else if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = value;
  }
  return target;
}

/**
 * Read one config FILE, tolerating the constructs yaml-subset rejects (see readScopeConfig).
 *
 * @param {string} file
 * @returns {object|null}
 */
function readScopeConfigFile(file) {
  const whole = readYaml(file);
  if (whole) return whole;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = {};
  for (const key of NOTIFY_BLOCKS) {
    const start = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (start === -1) continue;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      // Next top-level key (column-0 word + colon) ends the block; blank/comment lines don't.
      if (/^[A-Za-z_][\w-]*:/.test(lines[i])) { end = i; break; }
    }
    try {
      const slice = yamlParse(lines.slice(start, end).join('\n'));
      if (slice && typeof slice === 'object') Object.assign(out, slice);
    } catch { /* this block itself is unparseable — leave it out */ }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A scope's notification configuration: its `config/comms.yaml` pair first, then the legacy monolith
 * below it. Per key, so a scope part-way through `config migrate` resolves the same values it did
 * before the split.
 *
 * @param {string} file - the scope's legacy config.yaml path (its directory is the scope base)
 * @returns {object|null}
 */
export function readScopeConfig(file) {
  const family = readFamilyConfig(dirname(file));
  const legacy = readScopeConfigFile(file);
  if (!family) return legacy;
  if (!legacy) return family;
  const merged = { ...family };
  for (const [block, value] of Object.entries(legacy)) {
    if (!NOTIFY_BLOCKS.includes(block)) continue;
    merged[block] = { ...(value && typeof value === 'object' ? value : {}), ...(merged[block] || {}) };
  }
  return merged;
}

export async function sweep(root, { fetchImpl = fetch, nowMs = Date.now(), log = () => {} } = {}) {
  const configCache = new Map();
  const cfg = (scope) => {
    if (!configCache.has(scope)) configCache.set(scope, readScopeConfig(scopeConfigPath(root, scope)));
    return configCache.get(scope);
  };

  const sent = [];
  for (const { base, scope } of scanBases(root)) {
    const conf = cfg(scope);
    const rootConf = cfg('root');
    // Root config is the inherited base (same pattern as local memory): a project with no
    // run_notify block of its own falls back to root's; a project block overrides wholesale.
    const rn = (conf && conf.run_notify) || (rootConf && rootConf.run_notify);
    if (!rn || rn.enabled !== true) continue; // hard opt-in per scope (or inherited from root)

    const transports = Array.isArray(rn.transports) && rn.transports.length ? rn.transports : ['slack'];
    const catchup = Number.isFinite(Number(rn.catchup_hours)) ? Number(rn.catchup_hours) : 24;

    for (const run of discoverRuns(root, base, scope)) {
      if (!skillAllowed(rn.skills, run.skill)) continue;
      const marker = readMarker(run.runDir);
      const action = decide(run, marker, nowMs, catchup);
      if (!action) continue;
      if (action === 'seed') {
        writeMarker(run.runDir, { last_status: run.status, seeded: true, at: new Date(nowMs).toISOString() });
        continue;
      }

      const results = [];
      if (transports.includes('slack')) {
        // Slack block resolves scope-first, root-fallback — so one root workspace config
        // serves every project that hasn't configured its own.
        const slackBlock = (conf && conf.slack) || (rootConf && rootConf.slack) || {};
        const aliasName = rn.env || Object.keys(slackBlock)[0];
        const alias = aliasName ? slackBlock[aliasName] : null;
        results.push(alias
          ? await sendSlack(alias, run.skill, composeMessage(run), fetchImpl)
          : { ok: false, error: 'no slack alias configured' });
      }
      if (transports.includes('email')) {
        const subject = `[sidekicks] ${run.skill} ${run.slug}: ${run.status.toUpperCase()}`;
        const body = composeMessage(run).replace(/[*`>]/g, '').replace(/:\w+:/g, '');
        // mail_sender likewise: prefer the scope's own config file, else root's.
        const mailCfg = conf && conf.mail_sender ? scopeConfigPath(root, scope) : scopeConfigPath(root, 'root');
        results.push(sendEmail(root, mailCfg, subject, body));
      }

      const anyOk = results.some((r) => r.ok);
      for (const r of results) if (!r.ok) log(`[run-notify] ${run.skill}/${run.slug}: ${r.error}`);
      // Mark only on at least one successful delivery, so a transient failure retries
      // on the next hook firing instead of being swallowed forever.
      if (anyOk) {
        writeMarker(run.runDir, { last_status: run.status, at: new Date(nowMs).toISOString() });
        sent.push(`${run.skill}/${run.slug} → ${run.status}`);
      }
    }
  }
  return sent;
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
    .then((gate) => gate.exitIfDisabled('hook.run-notify'))
    .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

  const root = resolveRoot();
  try {
    await initYaml(root);
    const sent = await sweep(root, { log: (m) => process.stderr.write(m + '\n') });
    if (sent.length) process.stderr.write(`[run-notify] delivered: ${sent.join('; ')}\n`);
  } catch (e) {
    process.stderr.write(`[run-notify] ${e && e.message ? e.message : e}\n`);
  }
  process.exit(0); // never block the turn
}
