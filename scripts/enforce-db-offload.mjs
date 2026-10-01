#!/usr/bin/env node
// scripts/enforce-db-offload.mjs
//
// PreToolUse guard for the OFFLOAD contract (`sidekicks database offload`, v2 "comment-out
// parking" mechanic): an alias is parked by commenting its lines out in place, each original line
// prefixed at column 0 with `#[offloaded] `, preceded by one `#[offloaded:meta] <ts> by <user>[:
// <reason>]` line — inside `database_connector:` / `teleport_database_connector:`, in
// `config/database.yaml`, the git-ignored `config/database.secret.yaml`, legacy `config.yaml` and
// `config/pending-removal.config.yaml`. Every config reader already skips `#` lines, so a parked
// alias is simply *unknown* to `sidekicks config get` — this hook is the layer for everything that
// does NOT go through that reader: a shell command an agent types directly, or a Read/Grep/Glob/
// Edit/Write/MultiEdit tool call that reaches the same files by another route.
//
// Modelled on scripts/enforce-branch-safety.mjs: same `segments/tokens/stripEnv/unwrap/isShell`
// best-effort shell parsing, same OPAQUE ($()/``/${}) fail-toward-ask handling, same
// `--command "<cmd>" [--cwd dir]` direct-test mode, same hook-shaped stdin JSON for the live path,
// same fail-open contract (an internal error ALLOWS the call — a hook must never wedge the agent).
//
// ONE exception to fail-open, called out because it is the only one: the secret-file read rule
// (below) is pure string/path matching, so it has nothing to fail open ON — it runs first,
// unconditionally, before any shell parsing that could throw.
//
// Rules:
//   DENY  — a direct read/copy of `*/database.secret.yaml` (or a glob form, e.g. `*.secret.y*`) or
//           `*/pending-removal.*.yaml` — from a Bash command (with a read verb or a redirect-into)
//           OR from a Read/Grep/Glob tool's path/pattern fields (the tool call itself IS the read).
//   DENY  — psql/pg_dump/pg_dumpall/pg_restore/pgcli (flag incl. `-hHOST`/`-dDB` attached forms,
//           conninfo string, URI, or PGHOST/PGDATABASE env form, incl. `export`ed across segments)
//           whose host+dbname matches a PARKED target (host compared lowercased/trailing-dot
//           stripped; dbname compared verbatim).
//   ASK   — the same client with a host match but no dbname named (ambiguous — the same host often
//           serves many databases, only some of them offloaded); with `PGSERVICE`/`service=` (this
//           guard cannot see through pg_service.conf); or with an OPAQUE host ($(...), `...`, ${...}).
//   DENY  — inline python/node (`psycopg2.connect(...)` / `pg.Client(...)` / `new Client(...)`)
//           whose literal host+dbname matches a parked target.
//   DENY  — `tsh proxy db` / `tsh db connect|login` whose cluster+db_name matches a parked
//           Teleport target.
//   ASK   — `sidekicks database offload <alias>... --restore[=...]` (also `node bin/sidekicks ...`,
//           any path to the `sidekicks` binary) — restore is consented by the user every time,
//           never self-granted; also ASKS, as a catch-all, on any command segment that mentions
//           both "offload" and "restore" in any shape this guard did not recognize precisely.
//   ASK   — `sed -i` / `perl -i` in place, or an output redirect, targeting a
//           `database*.yaml`/`config.yaml`/`pending-removal*` file that CURRENTLY carries a
//           `#[offloaded]` marker — it might strip it.
//   ASK   — an Edit/Write/MultiEdit tool payload that removes a `#[offloaded]` marker from one of
//           those files — hand-uncommenting a parked alias is a restore.
// Everything else is allowed, including ordinary reads of the COMMITTED `database.yaml` (host +
// dbname only, no credential) and a live alias on a host that also carries a parked one.
//
// WHY NO ESCAPE HATCH: this is a floor hook (LOCKED_IDS, lib/framework-settings/floor.mjs) and the
// offload verb's own contract is "restore-only, no env-var grant, no bypass path" — the same
// design carries here. `SIDEKICKS_BRANCH_SAFETY=off` is a DIFFERENT hook's escape hatch and does
// nothing here on purpose.
//
// Rule 6 wiring (same script, per CLI):
//   - Claude Code : .claude/settings.json → PreToolUse (matcher: Bash; a second matcher for
//                   Read|Grep|Glob covers the secret-file read rule for those tools)
//   - Codex CLI   : .codex/config.toml    → PreToolUse (Codex sees every tool already)
// Antigravity has no tool-call hook event — omitted from LOGICAL_HOOKS like enforce-branch-safety.
//
// MARKER SOURCE: `listOffloaded(text)` is canonically `lib/database-lifecycle/_offload-marks.mjs`
// (dynamic-imported, try/catch). A tiny local fallback parses the SAME marker shape when that
// module is not present yet (a partial checkout, or this hook built ahead of it) — this hook works
// either way, and switches to the shared module automatically once it lands.
//
// Direct test mode (prints the decision it WOULD return):
//   node scripts/enforce-db-offload.mjs --command "<shell command>" [--cwd <dir>]
//   node scripts/enforce-db-offload.mjs --event  # hook-shaped JSON on stdin, gate bypassed for tests

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, dirname, join, basename } from 'node:path';

// ── shared shell-parsing primitives (copied from scripts/enforce-branch-safety.mjs) ───────────

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

const SEPARATOR = /\r?\n|&&|\|\||;|(?<!&)&(?!&)|(?<!\|)\|(?!\|)/g;

/** Split a shell command into sequential segments, quoted spans masked first. */
function segments(command) {
  const text = String(command);
  const chars = [...text];
  let masked = '';
  let quote = null;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === '\\' && quote !== "'" && !(quote === '"' && chars[i + 1] === quote)) {
      masked += ch + (chars[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (quote) {
      masked += ch === quote ? ch : (/[&|;\r\n]/.test(ch) ? ' ' : ch);
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; }
    masked += ch;
  }
  const source = quote === null ? masked : text;

  const out = [];
  let last = 0;
  let m;
  SEPARATOR.lastIndex = 0;
  while ((m = SEPARATOR.exec(source)) !== null) {
    out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Tokenize a segment, honouring simple single/double quotes. */
function tokens(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Split leading `VAR=value` assignments off an argv. */
function stripEnv(toks) {
  let i = 0;
  while (i < toks.length && ASSIGNMENT.test(toks[i])) i += 1;
  return { assignments: toks.slice(0, i), argv: toks.slice(i) };
}

/** Wrappers that run their argument as a command. */
const WRAPPERS = new Set([
  'command', 'sudo', 'doas', 'nice', 'ionice', 'nohup', 'time', 'xargs', 'stdbuf', 'setsid',
  'timeout', 'proxychains', 'strace', 'ltrace',
]);

/** Shells that take `-c <script>`; the script is a nested command line, not an argument. */
const isShell = (tok) => /(?:^|[\\/])(?:ba|z|k|da|a)?sh(?:\.exe)?$/i.test(String(tok));

/** A construct this tokenizer cannot see through. */
const OPAQUE = /\$\(|`|\$\{/;

/** Peel command wrappers (`env`, `sudo`, `timeout`, …) until the real argv is exposed. */
function unwrap(argv) {
  let cur = argv.slice();
  const assignments = [];
  for (let guard = 0; guard < 8 && cur.length > 0; guard += 1) {
    const head = basename(String(cur[0]));
    if (head === 'env' || head === 'env.exe') {
      cur = cur.slice(1);
      while (cur.length > 0) {
        if (ASSIGNMENT.test(cur[0])) { assignments.push(cur[0]); cur = cur.slice(1); }
        else if (cur[0] === '-u' || cur[0] === '--unset') cur = cur.slice(2);
        else if (String(cur[0]).startsWith('-')) cur = cur.slice(1);
        else break;
      }
      continue;
    }
    if (WRAPPERS.has(head)) {
      cur = cur.slice(1);
      while (cur.length > 0 && (String(cur[0]).startsWith('-') || ASSIGNMENT.test(cur[0]))) {
        if (ASSIGNMENT.test(cur[0])) assignments.push(cur[0]);
        cur = cur.slice(1);
      }
      continue;
    }
    break;
  }
  return { argv: cur, assignments };
}

// ── Rule 1: secret-file / pending-removal reads — PURE STRING / PATH MATCHING ─────────────────
//
// Precision matters here as much as recall: `rg pending-removal lib/` is a literal-string CODE
// SEARCH for the marker filename convention, not a file/glob reference, and must be ALLOWED. So a
// bare word (no path separator before it, no `.` or `*` immediately after it) never matches — only
// a shape that could actually RESOLVE to a file: `config/pending-removal.yaml` (path prefix),
// `pending-removal.config.yaml` (dot-suffixed real name) or `pending-removal*` (an explicit glob).
// `database.secret.` and `db-seal.secret.`/`db-seal.` already carry a literal dot before the
// variable part, so they are inherently filename-shaped and need no extra guard. For a Bash command
// this also needs a read verb or a redirect-into (below) before it denies; for a Read/Grep/Glob tool
// call the field naming the file IS the read, so a bare match is enough.

const PATHLIKE_PREFIX = '(?:[^\\s"\'`)]*[/\\\\])';
const SECRET_FILE_RE = new RegExp(
  '(?:^|[\\s"\'`(=<])(?:'
    + `${PATHLIKE_PREFIX}?database\\.secret\\.[\\w*?.-]*` // database.secret.* — bare or pathed
    + `|${PATHLIKE_PREFIX}?db-seal[\\w*?.-]*\\.secret\\.[\\w*?.-]*` // db-seal*.secret.* — bare or pathed
    + `|${PATHLIKE_PREFIX}db-seal[\\w*?.-]*` // pathed db-seal... (path prefix required if bare below fails)
    + '|db-seal\\*[\\w*?.-]*' // bare + explicit glob star
    + '|db-seal\\.[\\w*?.-]*' // bare + dot-suffixed real name
    + `|${PATHLIKE_PREFIX}pending-removal[\\w*?.-]*` // pathed pending-removal...
    + '|pending-removal\\*[\\w*?.-]*' // bare + explicit glob star
    + '|pending-removal\\.[\\w*?.-]*' // bare + dot-suffixed real name
    + ')(?=$|[\\s"\'`)])',
  'i',
);
const READ_VERB_RE =
  /\b(?:cat|less|more|head|tail|sed|awk|gawk|grep|egrep|fgrep|rg|cp|mv|copy|base64|xxd|od|strings|python[23]?|node|ruby|perl|type|Get-Content)\b/i;
const REDIRECT_INTO_RE =
  /<\s*['"]?[^\s'"]*(?:database\.secret\.[\w*?.-]*|pending-removal[\w*?.-]*|db-seal[\w*?.-]*\.secret\.[\w*?.-]*)/i;

function secretReadDecision(rawText) {
  const text = String(rawText ?? '');
  if (!SECRET_FILE_RE.test(text)) return null;
  if (REDIRECT_INTO_RE.test(text) || READ_VERB_RE.test(text)) {
    return {
      decision: 'deny',
      reason:
        'BLOCKED: this command reads a secret-bearing configuration file directly — a live ' +
        "database password (`database.secret.yaml`), the seal keypair (`db-seal.secret.yaml`), " +
        "or a scope's retired legacy config (`pending-removal.*.yaml`), any of which may still " +
        "carry an offloaded alias's credential material. " +
        'Use `sidekicks config get <block> --json` instead, which never returns an offloaded ' +
        'alias, or `sidekicks database offload <alias> --restore` if the alias genuinely needs ' +
        'to be reachable again — that always asks the user first.',
    };
  }
  return null;
}

/** A bare path/glob (Read `file_path`, Grep `path`/`glob`, Glob `pattern`) naming the secret file. */
function pathNamesSecretFile(pathLike) {
  return SECRET_FILE_RE.test(String(pathLike ?? ''));
}

/** Does `pathLike` point AT (or end in) a directory literally named `config`? */
function targetsConfigDir(pathLike) {
  const p = String(pathLike ?? '').replace(/[\\/]+$/, '');
  const base = p.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase() === 'config';
}

/** Every string leaf in a (possibly nested) tool_input payload — Read/Grep/Glob field names vary. */
function collectStrings(value, acc = []) {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) { for (const v of value) collectStrings(v, acc); }
  else if (value && typeof value === 'object') { for (const v of Object.values(value)) collectStrings(v, acc); }
  return acc;
}

function secretPathToolDecision(toolName, toolInput) {
  // A Grep call recursing into a scope's config/ directory will read the secret file even
  // though its `pattern` never names it — the directory IS the secret-bearing surface.
  if (toolName === 'Grep' && targetsConfigDir(toolInput?.path)) {
    return {
      decision: 'deny',
      reason:
        'BLOCKED: this Grep call targets a scope\'s `config/` directory, which contains ' +
        '`database.secret.yaml` / `db-seal.secret.yaml` — a search rooted there reads the secret ' +
        'file even when the pattern never names it. Search a narrower path, or use ' +
        '`sidekicks config get <block> --json` instead.',
    };
  }
  for (const s of collectStrings(toolInput ?? {})) {
    if (pathNamesSecretFile(s)) {
      return {
        decision: 'deny',
        reason:
          'BLOCKED: this tool call targets a secret-bearing configuration file directly — a live ' +
          "database password (`database.secret.yaml`), the seal keypair (`db-seal.secret.yaml`), " +
          "or a scope's retired legacy config (`pending-removal.*.yaml`). " +
          'Use `sidekicks config get <block> --json` instead, which never returns an offloaded ' +
          'alias.',
      };
    }
  }
  return null;
}

// ── marker parsing: `#[offloaded]` runs → [{block, alias, host, port, dbname, cluster, db_name}] ─
//
// Canonical source: lib/database-lifecycle/_offload-marks.mjs (Lane A). Dynamic-imported so a
// partial checkout (or this hook built ahead of that module landing) still works — the fallback
// below parses the SAME marker shape from the Mechanic contract.

const OFFLOAD_PREFIX = '#[offloaded]';
// Canonical shape (lib/database-lifecycle/_offload-marks.mjs): `#[offloaded:meta] <stamp> by
// <user> key=<16-hex fingerprint>[: <reason>]` — the `key=` fragment names which seal key
// encrypted the password, so a restore can detect a stale key. The `key=...` group is OPTIONAL
// here so this fallback still parses a pre-sealing-era meta line if one is ever encountered.
const OFFLOAD_META_RE =
  /^#\[offloaded:meta\]\s*(\S+)\s+by\s+(.+?)(?:\s+key=([0-9a-f]{16}))?(?:\s*:\s*(.*))?\s*$/;
const OFFLOAD_LINE_RE = /^#\[offloaded\](?: (.*))?$/;
const TOP_LEVEL_KEY_RE = /^([A-Za-z_][\w-]*):\s*(?:#.*)?$/;
const ALIAS_KEY_RE = /^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/;
const PROP_RE = /^(host|port|dbname|database|db|cluster|db_name):\s*(.*?)\s*(?:#.*)?$/;

function stripQuotes(v) {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Fallback marker parser — used only until lib/database-lifecycle/_offload-marks.mjs exists.
 * Best-effort: a file this cannot parse contributes nothing rather than throwing.
 *
 * @param {string} text
 * @returns {Array<{block: string|null, alias: string, host: string|null, port: string|null,
 *   dbname: string|null, cluster: string|null, db_name: string|null, stamp: string|null,
 *   user: string|null, reason: string|null}>}
 */
function listOffloadedFallback(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let currentBlock = null;
  let inDefaults = false;
  let defaultsIndent = null;
  let teleportClusterDefault = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const meta = OFFLOAD_META_RE.exec(line);
    if (meta) {
      i += 1;
      const runLines = [];
      while (i < lines.length && OFFLOAD_LINE_RE.test(lines[i])) {
        const m = OFFLOAD_LINE_RE.exec(lines[i]);
        runLines.push(m[1] ?? '');
        i += 1;
      }
      let alias = null;
      const entry = {
        block: currentBlock,
        alias: null,
        host: null,
        port: null,
        dbname: null,
        cluster: currentBlock === 'teleport_database_connector' ? teleportClusterDefault : null,
        db_name: null,
        stamp: meta[1] ?? null,
        user: meta[2] ? meta[2].trim() : null,
        reason: meta[4] ?? null,
      };
      for (const raw of runLines) {
        const trimmed = raw.trim();
        if (trimmed === '') continue;
        if (alias === null) {
          const am = ALIAS_KEY_RE.exec(trimmed);
          if (am) { alias = am[1]; continue; }
        }
        const pm = PROP_RE.exec(trimmed);
        if (pm) {
          const key = pm[1];
          const val = stripQuotes(pm[2]);
          if (key === 'host') entry.host = val;
          else if (key === 'port') entry.port = val;
          else if (key === 'dbname' || key === 'database' || key === 'db') entry.dbname = val;
          else if (key === 'cluster') entry.cluster = val;
          else if (key === 'db_name') entry.db_name = val;
        }
      }
      if (alias) { entry.alias = alias; out.push(entry); }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { i += 1; continue; }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const km = TOP_LEVEL_KEY_RE.exec(line);
      if (km) {
        currentBlock = km[1];
        inDefaults = false;
        teleportClusterDefault = null;
      }
      i += 1;
      continue;
    }
    if (currentBlock === 'teleport_database_connector') {
      if (!inDefaults && indent === 2 && /^defaults:\s*(?:#.*)?$/.test(trimmed)) {
        inDefaults = true;
        defaultsIndent = indent;
      } else if (inDefaults) {
        if (indent <= defaultsIndent) {
          inDefaults = false;
        } else {
          const cm = /^cluster:\s*(.*?)\s*(?:#.*)?$/.exec(trimmed);
          if (cm) teleportClusterDefault = stripQuotes(cm[1]);
        }
      }
    }
    i += 1;
  }
  return out;
}

let _listOffloadedCache = null;

/** @returns {Promise<(text: string) => Array<object>>} */
async function getListOffloaded() {
  if (_listOffloadedCache) return _listOffloadedCache;
  try {
    const mod = await import(new URL('../lib/database-lifecycle/_offload-marks.mjs', import.meta.url));
    if (typeof mod.listOffloaded === 'function') {
      _listOffloadedCache = mod.listOffloaded;
      return _listOffloadedCache;
    }
  } catch { /* module not present yet (parallel lane, or partial checkout) — use the fallback */ }
  _listOffloadedCache = listOffloadedFallback;
  return _listOffloadedCache;
}

// ── offloaded-target lookup: read the scope's committed/legacy config files, never the secret ──

/** Walk up from `dir` to the nearest ancestor carrying a `.sidekicks/` directory. */
function findRepoRoot(dir) {
  let cur = resolvePath(dir);
  for (;;) {
    if (existsSync(join(cur, '.sidekicks'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Repo-relative config files that may carry a parked block. NEVER `database.secret.yaml` — the
 * committed/legacy files carry host + dbname for the same alias, so no secret read is needed.
 */
function configFiles(root) {
  const files = [
    join(root, '.sidekicks', 'config', 'database.yaml'),
    join(root, '.sidekicks', 'config.yaml'),
    join(root, '.sidekicks', 'config', 'pending-removal.config.yaml'),
  ];
  const projectsDir = join(root, 'projects');
  let entries = [];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch { /* no projects/ — nothing more to scan */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    files.push(join(projectsDir, entry.name, 'config', 'database.yaml'));
    files.push(join(projectsDir, entry.name, 'config.yaml'));
    files.push(join(projectsDir, entry.name, 'config', 'pending-removal.config.yaml'));
  }
  return files.filter((f) => existsSync(f));
}

/**
 * `teleport_database_connector:`'s own `defaults: → cluster:` value. A parked alias entry's body
 * never repeats it (it is a block-wide default, shared by every alias), and the canonical
 * `listOffloaded` is deliberately pure text-per-entry — it does not cross-reference `defaults:` —
 * so a parked Teleport alias with no `cluster:` of its own needs this looked up separately.
 *
 * @param {string} text
 * @returns {string|null}
 */
function teleportDefaultCluster(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let inBlock = false;
  let inDefaults = false;
  let defaultsIndent = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      inBlock = /^teleport_database_connector:\s*$/.test(trimmed);
      inDefaults = false;
      continue;
    }
    if (!inBlock) continue;
    if (!inDefaults && indent === 2 && /^defaults:\s*$/.test(trimmed)) {
      inDefaults = true;
      defaultsIndent = indent;
      continue;
    }
    if (inDefaults) {
      if (indent <= defaultsIndent) { inDefaults = false; continue; }
      const m = /^cluster:\s*(.*)$/.exec(trimmed);
      if (m) return stripQuotes(m[1]);
    }
  }
  return null;
}

/**
 * Every parked entry across every config layer this scope owns.
 *
 * @param {string} root
 * @returns {Promise<Array<object>>}
 */
async function offloadedTargets(root) {
  const targets = [];
  const listOffloaded = await getListOffloaded();
  for (const file of configFiles(root)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let entries;
    try {
      entries = listOffloaded(text) || [];
    } catch {
      continue; // best-effort — a file this cannot parse contributes nothing
    }
    let clusterDefault;
    for (const e of entries) {
      if (e.block === 'teleport_database_connector' && !e.cluster) {
        if (clusterDefault === undefined) clusterDefault = teleportDefaultCluster(text);
        if (clusterDefault) e.cluster = clusterDefault;
      }
      targets.push(e);
    }
  }
  return targets;
}

const normalizeHost = (h) => String(h ?? '').trim().toLowerCase().replace(/\.$/, '');
const sameHost = (a, b) => normalizeHost(a) === normalizeHost(b);

/** @returns {{kind:'deny'|'ask'}|null} */
function matchDirectTarget(targets, host, dbname) {
  if (!host) return null;
  const onHost = targets.filter((t) => t.block === 'database_connector' && t.host && sameHost(t.host, host));
  if (onHost.length === 0) return null;
  if (dbname == null || dbname === '') return { kind: 'ask' };
  const norm = String(dbname).trim();
  const hit = onHost.some((t) => t.dbname != null && String(t.dbname).trim() === norm);
  return hit ? { kind: 'deny' } : null;
}

/** @returns {{kind:'deny'}|null} */
function matchTeleportTarget(targets, cluster, dbName) {
  if (!cluster || !dbName) return null; // need both — avoid over-blocking on a bare cluster name
  const c = String(cluster).trim().toLowerCase();
  const d = String(dbName).trim();
  const hit = targets.some((t) => t.block === 'teleport_database_connector'
    && t.cluster && String(t.cluster).trim().toLowerCase() === c
    && t.db_name && String(t.db_name).trim() === d);
  return hit ? { kind: 'deny' } : null;
}

// ── Rule 2/3: db-client / inline-connect target extraction ────────────────────────────────────

const DB_CLIENT_RE = /^(?:psql|pg_dump|pg_dumpall|pg_restore|pgcli)(?:\.exe)?$/i;
const TSH_RE = /^tsh(?:\.exe)?$/i;
const GREP_FAMILY_RE = /^(?:grep|egrep|fgrep|rg|ag|ack)(?:\.exe)?$/i;

/**
 * `sed --in-place[=SUFFIX]`, or any bundled short-flag cluster CONTAINING `i` — perl freely mixes
 * digits into a cluster (`-0pi` null-separator + in-place + script-follows, `-8pi`), and either
 * tool accepts a stuck backup-extension suffix (`-i.bak`, `-pi.bak`) — so the cluster match stops
 * at the first non-alphanumeric character rather than requiring letters only.
 */
function hasInPlaceFlag(cmdName, argv) {
  for (const raw of argv) {
    const tok = String(raw);
    if (cmdName.toLowerCase() === 'sed' && (tok === '--in-place' || tok.startsWith('--in-place='))) return true;
    if (tok.startsWith('--') || !tok.startsWith('-')) continue;
    const m = /^-([a-zA-Z0-9]+)/.exec(tok); // e.g. "-0pi" from "-0pi.bak" — digits allowed too
    if (m && m[1].includes('i')) return true;
  }
  return false;
}

/** `host=... dbname=... service=...` — a conninfo string, whether positional or the `-d` value. */
function parseConninfoLike(str) {
  const s = String(str ?? '');
  const hostM = /\bhost\s*=\s*([^\s'"]+)/.exec(s);
  const dbM = /\bdbname\s*=\s*([^\s'"]+)/.exec(s);
  const svcM = /\bservice\s*=\s*([^\s'"]+)/.exec(s);
  return {
    host: hostM ? hostM[1] : null,
    dbname: dbM ? dbM[1] : null,
    service: svcM ? svcM[1] : null,
  };
}

const looksLikeConninfo = (v) => /\b(?:host|dbname|service)\s*=/.test(String(v ?? ''));

/** Flags shared by psql/pg_dump/pg_dumpall/pg_restore/pgcli that name a host, database or service. */
function extractFlagTarget(argv) {
  let host = null;
  let dbname = null;
  let service = null;
  for (let i = 1; i < argv.length; i += 1) {
    const tok = String(argv[i]);
    let m;
    if ((m = /^(?:-h|--host)=(.+)$/.exec(tok))) { host = m[1]; continue; }
    if ((tok === '-h' || tok === '--host') && argv[i + 1] != null) { host = String(argv[i + 1]); i += 1; continue; }
    if (tok !== '-h' && (m = /^-h(.+)$/.exec(tok))) { host = m[1]; continue; } // -hHOST attached
    if ((m = /^(?:-d|--dbname)=(.+)$/.exec(tok))) {
      if (looksLikeConninfo(m[1])) {
        const c = parseConninfoLike(m[1]);
        host = host ?? c.host; dbname = dbname ?? c.dbname; service = service ?? c.service;
      } else dbname = m[1];
      continue;
    }
    if ((tok === '-d' || tok === '--dbname') && argv[i + 1] != null) {
      const v = String(argv[i + 1]); i += 1;
      if (looksLikeConninfo(v)) {
        const c = parseConninfoLike(v);
        host = host ?? c.host; dbname = dbname ?? c.dbname; service = service ?? c.service;
      } else dbname = v;
      continue;
    }
    if (tok !== '-d' && (m = /^-d(.+)$/.exec(tok))) { // -dDB attached (or -d"host=…" attached)
      if (looksLikeConninfo(m[1])) {
        const c = parseConninfoLike(m[1]);
        host = host ?? c.host; dbname = dbname ?? c.dbname; service = service ?? c.service;
      } else dbname = m[1];
      continue;
    }
    if ((m = /^--service=(.+)$/.exec(tok))) { service = m[1]; continue; }
    if (tok === '--service' && argv[i + 1] != null) { service = String(argv[i + 1]); i += 1; continue; }
    if (/^postgres(?:ql)?:\/\//i.test(tok)) {
      try {
        const url = new URL(tok);
        host = host ?? (url.hostname || null);
        const path = url.pathname.replace(/^\//, '');
        dbname = dbname ?? (path ? decodeURIComponent(path) : null);
      } catch { /* not a parseable URI — leave whatever flags already found */ }
      continue;
    }
    // Bare positional conninfo string: `psql "host=... dbname=..."`.
    if (!tok.startsWith('-') && looksLikeConninfo(tok)) {
      const c = parseConninfoLike(tok);
      host = host ?? c.host; dbname = dbname ?? c.dbname; service = service ?? c.service;
    }
  }
  return { host, dbname, service };
}

/** PGHOST / PGDATABASE / PGSERVICE from an assignment list (leading env, `env VAR=`, sticky `export`). */
function extractEnvTarget(assignments) {
  let host = null;
  let dbname = null;
  let service = null;
  for (const raw of assignments) {
    const m = ASSIGNMENT.exec(String(raw));
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (m[1] === 'PGHOST') host = value;
    if (m[1] === 'PGDATABASE') dbname = value;
    if (m[1] === 'PGSERVICE') service = value;
  }
  return { host, dbname, service };
}

/** `tsh proxy db --db-user=… --db-name=X [--port=N] CLUSTER` / `tsh db connect|login …`. */
function extractTeleportTarget(argv) {
  let cluster = null;
  let dbName = null;
  for (let i = 3; i < argv.length; i += 1) {
    const tok = String(argv[i]);
    let m;
    if ((m = /^--db-name=(.+)$/.exec(tok))) { dbName = m[1]; continue; }
    if (tok === '--db-name' && argv[i + 1] != null) { dbName = argv[i + 1]; i += 1; continue; }
    if ((m = /^--cluster=(.+)$/.exec(tok))) { cluster = m[1]; continue; }
    if (tok === '--cluster' && argv[i + 1] != null) { cluster = argv[i + 1]; i += 1; continue; }
    if (!tok.startsWith('-')) cluster = cluster ?? tok; // trailing positional = cluster name
  }
  return { cluster, dbName };
}

/** Inline python/node connect calls: `psycopg2.connect(host="...", dbname="...")`, `pg.Client({host, database})`. */
const INLINE_CONNECT_RE = /\b(?:psycopg2\.connect|pg\.Client|new\s+Client)\s*\(/;

function extractInlineTarget(scriptText) {
  const text = String(scriptText ?? '');
  if (!INLINE_CONNECT_RE.test(text)) return null;
  const hostM = /\bhost\s*[:=]\s*['"]([^'"]+)['"]/.exec(text);
  const dbM = /\b(?:dbname|database)\s*[:=]\s*['"]([^'"]+)['"]/.exec(text);
  if (hostM || dbM) return { host: hostM ? hostM[1] : null, dbname: dbM ? dbM[1] : null };
  // `psycopg2.connect(dsn="host=... dbname=...")` / `connect(conninfo="...")` / a bare positional
  // conninfo string: `psycopg2.connect("host=... dbname=...")`.
  const dsnM = /\b(?:dsn|conninfo)\s*=\s*['"]([^'"]+)['"]/.exec(text)
    ?? /connect\s*\(\s*['"]([^'"]+)['"]/.exec(text);
  if (dsnM && looksLikeConninfo(dsnM[1])) {
    const c = parseConninfoLike(dsnM[1]);
    return { host: c.host, dbname: c.dbname };
  }
  return null;
}

// ── Rule 4: `sidekicks database offload ... --restore` ────────────────────────────────────────

/** Does this argv invoke the `sidekicks` CLI, and if so, what is its OWN argv (past `node bin/sidekicks`)? */
function sidekicksArgv(argv) {
  const head = basename(String(argv[0] ?? ''));
  if (/^sidekicks(?:\.exe|\.cmd|\.ps1)?$/i.test(head)) return argv.slice(1);
  if (/^node(?:\.exe)?$/i.test(head) && argv[1] != null
    && /(?:^|[\\/])bin[\\/]sidekicks$/i.test(String(argv[1]).replace(/\\/g, '/'))) {
    return argv.slice(2);
  }
  return null;
}

/** Undo a shell no-op backslash-escape ahead of a literal character: `re\store` → `restore`. */
const unescapeToken = (t) => String(t ?? '').replace(/\\(.)/g, '$1');

/**
 * `$`, a backtick, or a residual/unpaired quote anywhere in the segment: this guard's tokenizer
 * cannot resolve a shell variable/command substitution, and an odd quote count (or an adjacent
 * empty-quote splice like `res''tore`, used to defeat a literal `--restore` match) means the
 * reconstructed argv may not be what actually runs. Scoped to `database offload` segments — a
 * `sidekicks database offload <alias>` invocation, forward OR `--restore`, that carries any of
 * these ASKS rather than silently trusting a possibly-incomplete parse.
 *
 * @param {string} seg - the RAW (unmasked) segment text
 * @returns {boolean}
 */
function hasSuspiciousQuoting(seg) {
  const s = String(seg ?? '');
  if (/\$/.test(s) || /`/.test(s)) return true;
  if (/(['"])\1/.test(s)) return true; // adjacent empty quotes: '' or ""
  const single = (s.match(/'/g) || []).length;
  const double = (s.match(/"/g) || []).length;
  return single % 2 !== 0 || double % 2 !== 0;
}

function classifySidekicks(argv, seg) {
  const sk = sidekicksArgv(argv);
  if (!sk || sk.length === 0) return null;

  if (sk[0] === 'database' && sk[1] === 'offload') {
    if (hasSuspiciousQuoting(seg)) {
      return {
        decision: 'ask',
        reason:
          'PERMISSION NEEDED: this `sidekicks database offload` invocation contains a shell ' +
          'variable/command substitution or an unresolved quote (`$`, a backtick, or an ' +
          'unpaired/adjacent-empty quote), so this guard cannot reliably tell which flags or alias ' +
          'it actually passes — including whether `--restore` is hidden behind it. Spell it out ' +
          'literally, or confirm with the user before running it.',
      };
    }
    if (sk.some((t) => /^--restore(?:=|$)/.test(unescapeToken(t)))) {
      return {
        decision: 'ask',
        reason:
          'PERMISSION NEEDED: `sidekicks database offload ... --restore` would make a parked ' +
          'database alias reachable again. Restore is consented by the user every time — there is ' +
          'no standing grant for it (the offload contract is restore-only, never a bypass). Confirm ' +
          'the alias and the reason with the user before running this.',
      };
    }
  }

  if (sk[0] === 'database' && sk[1] === 'seal-init') {
    return {
      decision: 'ask',
      reason:
        'PERMISSION NEEDED: `sidekicks database seal-init` generates (or overwrites, with ' +
        '`--force`) the seal keypair every offloaded password is encrypted against — it is meant ' +
        'to run interactively, typed by the user in their own terminal. Confirm with the user ' +
        'before running this on their behalf.',
    };
  }
  return null;
}

/**
 * Catch-all: any segment mentioning both "offload" and "restore", in a shape `classifySidekicks`
 * did not parse — EXCEPT a recognised `sidekicks skill offload <name> --restore` (skill-management
 * restore, an unrelated verb that happens to share both words), which this fallback must not catch.
 */
function looksLikeOffloadRestore(seg, sk) {
  if (sk && sk[0] === 'skill') return false;
  return /\boffload\b/i.test(seg) && /\brestore\b/i.test(seg);
}

// ── ASK: a PTY-emulation wrapper driving `sidekicks` — defeats the TTY-only checks on seal-init/
// restore, so it is treated as suspicious regardless of which sidekicks subcommand it names ──────

const PTY_WRAPPER_RE = /^(?:script|unbuffer|expect)(?:\.exe)?$/i;
const PTY_SPAWN_RE = /\bpty\.spawn\s*\(/;

/**
 * `script`/`unbuffer`/`expect` (headBase) or a `pty.spawn(...)` call (anywhere in the segment
 * text — e.g. inside a `python -c "..."` payload) fake an interactive terminal specifically to
 * satisfy a TTY-only prompt; combined with the word `sidekicks` anywhere in the same segment, that
 * is exactly the shape of an attempt to script past `seal-init`'s or `--restore`'s TTY gate.
 *
 * @param {string} headBase
 * @param {string} seg - the RAW segment text
 * @returns {boolean}
 */
function isPtyWrapperOnSidekicks(headBase, seg) {
  const s = String(seg ?? '');
  return (PTY_WRAPPER_RE.test(headBase) || PTY_SPAWN_RE.test(s)) && /\bsidekicks\b/i.test(s);
}

// ── ASK: hand-editing a `#[offloaded]` marker out of a parked config file ──────────────────────

const MARKER_TARGET_BASENAME_RE = /^(?:database.*\.ya?ml|config\.yaml|pending-removal.*)$/i;
/** Always risky regardless of current marker state — see `isRiskyConfigFile` below. */
const DATABASE_YAML_BASENAME_RE = /^database.*\.ya?ml$/i;
/** ANY `db-seal*` file — the keypair, a backup, a rotated copy, not just the one canonical name. */
const SEAL_ANY_BASENAME_RE = /^db-seal/i;

function isMarkerTargetPath(p) {
  const base = String(p ?? '').split(/[\\/]/).pop() ?? '';
  return MARKER_TARGET_BASENAME_RE.test(base);
}

function isSealFile(p) {
  const base = String(p ?? '').split(/[\\/]/).pop() ?? '';
  return SEAL_ANY_BASENAME_RE.test(base);
}

function currentlyHasMarkers(absPath) {
  try {
    return readFileSync(absPath, 'utf8').includes(OFFLOAD_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Is `p` a file worth asking about before an operation that can replace it wholesale touches it?
 * Three independent triggers: it is a `database*.yaml` (a whole-file overwrite/restore can
 * silently reintroduce an OLDER, unparked copy of a since-offloaded alias — the marker-diff check
 * below only catches an in-place EDIT, not a full file replacement); it is a `db-seal*` file (losing
 * or replacing it stops every future restore — the STRONGER, DENY-level protection for this one
 * lives in `isSealWriteTarget`/the dedicated Bash check, this ASK-level path only fires for the
 * commands that dedicated check does not cover); or it currently carries a `#[offloaded]` marker
 * (any other marker-bearing file: legacy `config.yaml`, `pending-removal*`).
 *
 * @param {string} p - path or bare filename as it appeared in the command
 * @param {string} dir - the resolved cwd to join a relative `p` against
 * @returns {boolean}
 */
function isRiskyConfigFile(p, dir) {
  const base = String(p ?? '').split(/[\\/]/).pop() ?? '';
  if (isSealFile(base)) return true;
  if (DATABASE_YAML_BASENAME_RE.test(base)) return true;
  if (isMarkerTargetPath(base)) {
    const abs = isAbsolute(String(p)) ? String(p) : resolvePath(dir, String(p));
    return currentlyHasMarkers(abs);
  }
  return false;
}

/** `"re" + "store"` / `"--re" + "store"` (JS or Python quoting) — `sidekicks ... --restore` built
 * from concatenated string fragments specifically to defeat a literal `--restore` substring match. */
const SPLIT_RESTORE_RE = /['"]-{0,2}re['"]\s*\+\s*['"]store['"]/i;

const SPLIT_RESTORE_ASK_REASON =
  'PERMISSION NEEDED: this inline script mentions `sidekicks` alongside a `restore` flag/word ' +
  'that appears to be ASSEMBLED from concatenated string fragments (e.g. `"re" + "store"`) — a ' +
  'shape whose only purpose is defeating a literal-flag match. Confirm with the user before ' +
  'running it.';

/** Does an external script FILE's own content mention a risky filename or the marker convention? */
function scriptFileLooksRisky(content) {
  const s = String(content ?? '');
  return /offloaded/i.test(s) || /database.*\.ya?ml/i.test(s) || /pending-removal/i.test(s)
    || /db-seal/i.test(s);
}

/** `ex` (always batch/scriptable), `vim -es`, `nvim --headless` — non-interactive editor drivers. */
function isBatchEditorInvocation(headBase, argv) {
  const h = headBase.toLowerCase();
  if (h === 'ex') return true;
  if (h === 'vim' && argv.some((a) => String(a) === '-es' || String(a) === '-s')) return true;
  if (h === 'nvim' && argv.some((a) => String(a) === '--headless')) return true;
  return false;
}

const SEAL_WRITE_DENY_REASON =
  'BLOCKED: this command writes to (or replaces) a `db-seal*` file — the seal keypair every ' +
  'offloaded password is encrypted against. Losing or replacing it strands every future restore, ' +
  'or (if replaced with an attacker-controlled key) lets someone else decrypt future offloads. ' +
  '`sidekicks database seal-init` is the only way to create or rotate it, and that always runs ' +
  'interactively, typed by the user in their own terminal.';

/** cp/mv/tee/install/rsync/ln naming a `db-seal*` file as ANY argument — source or destination,
 * this guard cannot always tell which — DENIES outright; `dd of=` is checked separately below. */
const SEAL_WRITE_CMDS_RE = /^(?:cp|mv|tee|install|rsync|ln)(?:\.exe)?$/i;

/** `#[offloaded]`-prefixed lines at COLUMN 0 — bare `#[offloaded]` (blank original line) accepted. */
const MARKER_LINE_RE = /^#\[offloaded\](?: |$)/;

/** The SET of column-0 marker lines in `text` (order-independent; exact line content matters). */
function markerLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => MARKER_LINE_RE.test(l));
}

/**
 * True when some marker line that existed (at column 0) in `oldText` no longer exists AS A
 * COLUMN-0 MARKER LINE in `newText` — whether it was deleted, uncommented, or merely MOVED off
 * column 0 (e.g. appended as a trailing comment on a live line, which reactivates the alias while
 * the substring `#[offloaded]` still appears somewhere in the file). A raw substring/count compare
 * would miss exactly that move, which is why this compares the SET of column-0 lines instead.
 */
function removesMarkers(oldText, newText) {
  const before = markerLines(oldText);
  if (before.length === 0) return false;
  const afterSet = new Set(markerLines(newText));
  return before.some((l) => !afterSet.has(l));
}

const MARKER_ASK_REASON =
  'PERMISSION NEEDED: this would remove (or move off column 0) a `#[offloaded]` marker from a ' +
  'parked database alias entry. Hand-uncommenting — or relocating — a parked alias\'s marker is a ' +
  'restore — `sidekicks database offload <alias> --restore` is the consented way back; confirm ' +
  'this is really meant to restore it.';

const RISKY_FILE_ASK_REASON =
  'PERMISSION NEEDED: this command names a database config file directly (`database*.yaml`, the ' +
  'seal keypair `db-seal.secret.yaml`, or a file currently carrying a `#[offloaded]` marker) with ' +
  'an operation that can replace or move it wholesale — that can silently reintroduce an older, ' +
  'unparked copy of a since-offloaded alias, or displace the seal keypair a restore needs. Confirm ' +
  'this is intended, or go through `sidekicks database offload <alias> --restore` instead.';

/**
 * Parse a `*** Begin Patch … *** End Patch` payload (Codex's `apply_patch` tool) into the file it
 * targets plus its effective "before" and "after" text — the same shape Edit/Write already hand to
 * `removesMarkers`. Best-effort: an unparseable/absent patch answers `null` (allowed).
 *
 * @param {string} patchText
 * @returns {{filePath: string, oldText: string, newText: string}|null}
 */
function parseApplyPatch(patchText) {
  const text = String(patchText ?? '');
  const fileMatch = /^\*\*\*\s*(?:Update|Add|Delete) File:\s*(.+)$/m.exec(text);
  if (!fileMatch) return null;
  const filePath = fileMatch[1].trim();
  const oldLines = [];
  const newLines = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('*** ') || raw.startsWith('@@')) continue;
    if (raw.startsWith('-')) { oldLines.push(raw.slice(1)); continue; }
    if (raw.startsWith('+')) { newLines.push(raw.slice(1)); continue; }
    if (raw.startsWith(' ')) { oldLines.push(raw.slice(1)); newLines.push(raw.slice(1)); continue; }
    // An unprefixed context line (rare) — carried through to both sides unchanged.
    oldLines.push(raw); newLines.push(raw);
  }
  return { filePath, oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

// ── decision engine (Bash-shaped commands) ─────────────────────────────────────────────────────

const PREFILTER =
  /psql|pg_dump(?:all)?|pg_restore|pgcli|psycopg2|pg\.Client|new\s+Client\s*\(|require\(['"]pg['"]\)|dsn\s*=|conninfo|database\.secret|db-seal|pending-removal|database\s+offload|offload|restore|PGHOST|PGDATABASE|PGSERVICE|service\s*=|postgres(?:ql)?:\/\/|\btsh\b|\bsed\b|\bperl\b|\bcp\b|\btee\b|\bmv\b|\bcheckout\b|>>?|\$|`|grep|rg\b|ag\b|ack\b|\bpython[23]?\b|\bnode\b|database.*\.ya?ml|\bconfig\.yaml\b|\bdd\b|\binstall\b|\brsync\b|\bln\b|\bex\b|\bvim\b|\bnvim\b|\bscript\b|\bunbuffer\b|\bexpect\b|pty\.spawn|sidekicks|seal-init/i;

/**
 * @param {string} command
 * @param {string} cwd
 * @param {number} [depth]
 * @param {Record<string,string>} [sticky] - env assignments carried across `export`/segments.
 * @returns {Promise<{decision:'ask'|'deny', reason:string}|null>}
 */
async function decide(command, cwd = process.cwd(), depth = 0, sticky = {}) {
  if (!command) return null;
  const text = String(command);

  // Rule 1 runs UNCONDITIONALLY, on the raw text, before anything that could throw.
  const secretDecision = secretReadDecision(text);
  if (secretDecision) return secretDecision;

  if (!PREFILTER.test(text)) return null;

  const root = findRepoRoot(cwd);
  const targets = root ? await offloadedTargets(root) : [];

  let dir = cwd;
  for (const seg of segments(text)) {
    const raw = tokens(seg);
    if (raw.length === 0) continue;
    const { assignments: prefix, argv: afterEnv } = stripEnv(raw);
    for (const a of prefix) {
      const m = ASSIGNMENT.exec(a);
      if (m) sticky[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    if (afterEnv.length === 0) continue;

    if (afterEnv[0] === 'cd' && afterEnv[1] && !String(afterEnv[1]).startsWith('-')) {
      dir = isAbsolute(afterEnv[1]) ? afterEnv[1] : resolvePath(dir, afterEnv[1]);
      continue;
    }
    if (afterEnv[0] === 'export' && afterEnv[1] && ASSIGNMENT.test(afterEnv[1])) {
      // `export FOO=a BAR=b` may carry MORE THAN ONE assignment on the same line — consume every
      // one, not just the first, or a second var (e.g. PGDATABASE after PGHOST) is silently lost.
      let k = 1;
      while (k < afterEnv.length && ASSIGNMENT.test(afterEnv[k])) {
        const m = ASSIGNMENT.exec(afterEnv[k]);
        sticky[m[1]] = m[2].replace(/^["']|["']$/g, '');
        k += 1;
      }
      continue;
    }

    const { argv, assignments: inner } = unwrap(afterEnv);
    if (argv.length === 0) continue;
    for (const a of inner) {
      const m = ASSIGNMENT.exec(a);
      if (m) sticky[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }

    // Nested shell script: recurse with the same sticky env and target list already resolved
    // against THIS cwd (the script runs in the same directory).
    if (isShell(argv[0]) && depth < 4) {
      let ci = -1;
      for (let k = 1; k < argv.length; k += 1) {
        const tok = String(argv[k]);
        if (!tok.startsWith('-')) break;
        if (/^-[a-zA-Z]*c$/.test(tok) || tok === '--command') { ci = k; break; }
      }
      const script = ci >= 0 ? argv[ci + 1] : null;
      if (script) {
        const d = await decide(script, dir, depth + 1, sticky);
        if (d) return d;
        continue;
      }
    }

    const headBase = basename(String(argv[0]));

    // A PTY-emulation wrapper driving `sidekicks` — defeats the seal-init/--restore TTY-only gate.
    if (isPtyWrapperOnSidekicks(headBase, seg)) {
      return {
        decision: 'ask',
        reason:
          'PERMISSION NEEDED: this command drives `sidekicks` through a PTY-emulation wrapper ' +
          '(`script`/`unbuffer`/`expect`/`pty.spawn`), which exists specifically to fake an ' +
          'interactive terminal — the exact thing `seal-init` and `--restore`\'s TTY-only checks ' +
          'rely on. Confirm with the user before running this.',
      };
    }

    const sk = sidekicksArgv(argv);
    const skDecision = classifySidekicks(argv, seg);
    if (skDecision) return skDecision;
    if (looksLikeOffloadRestore(seg, sk)) {
      return {
        decision: 'ask',
        reason:
          'PERMISSION NEEDED: this command mentions both "offload" and "restore" — if it is ' +
          'restoring a parked database alias, that is consented by the user every time. Confirm ' +
          'before running it, or use `sidekicks database offload <alias> --restore` directly.',
      };
    }

    // sed --in-place / -[a-zA-Z]*i / perl -*i* in place on a file that currently carries a marker.
    if (/^(?:sed|perl)$/i.test(headBase) && hasInPlaceFlag(headBase, argv)) {
      const target = argv.slice(1).find((a) => !String(a).startsWith('-') && isMarkerTargetPath(a));
      if (target) {
        const abs = isAbsolute(target) ? target : resolvePath(dir, target);
        if (currentlyHasMarkers(abs)) {
          return { decision: 'ask', reason: MARKER_ASK_REASON };
        }
      }
    }

    // An output redirect into a `db-seal*` file DENIES outright; into a file that currently
    // carries a `#[offloaded]` marker ASKS (the marker-diff checks have no "before" to diff here).
    const redirectMatch = /(?:>>?|1>>?|2>>?)\s*['"]?([^\s'">]+)/.exec(seg);
    if (redirectMatch && isSealFile(redirectMatch[1])) {
      return { decision: 'deny', reason: SEAL_WRITE_DENY_REASON };
    }
    if (redirectMatch && isMarkerTargetPath(redirectMatch[1])) {
      const target = redirectMatch[1];
      const abs = isAbsolute(target) ? target : resolvePath(dir, target);
      if (currentlyHasMarkers(abs)) {
        return { decision: 'ask', reason: MARKER_ASK_REASON };
      }
    }

    // cp/mv/tee/install/rsync/ln naming a `db-seal*` file as any argument — DENY outright, before
    // the general (weaker, ASK-level) risky-file check below ever sees it.
    if (SEAL_WRITE_CMDS_RE.test(headBase)) {
      const hit = argv.slice(1).some((a) => !String(a).startsWith('-') && isSealFile(a));
      if (hit) return { decision: 'deny', reason: SEAL_WRITE_DENY_REASON };
    }
    // `dd of=<file>` — the destination is a `=`-attached value, not a bare positional argument.
    if (headBase.toLowerCase() === 'dd') {
      const ofArg = argv.find((a) => /^of=/i.test(String(a)));
      if (ofArg && isSealFile(String(ofArg).slice(3))) {
        return { decision: 'deny', reason: SEAL_WRITE_DENY_REASON };
      }
    }

    // grep-family recursive search rooted at a scope's config/ directory reads the secret file
    // even when the search PATTERN never names it.
    if (GREP_FAMILY_RE.test(headBase)) {
      const recursive = argv.some((a) => {
        const t = String(a);
        return t === '--recursive' || (/^-[a-zA-Z]+$/.test(t) && t.includes('r'));
      });
      if (recursive) {
        const dirArg = argv.slice(1).find((a) => !String(a).startsWith('-') && targetsConfigDir(a));
        if (dirArg) {
          return {
            decision: 'deny',
            reason:
              `BLOCKED: \`${headBase} -r\` recurses into \`${dirArg}\`, a scope's \`config/\` ` +
              'directory — that reads `database.secret.yaml` / `db-seal.secret.yaml` even though ' +
              'the search pattern never names them. Search a narrower path instead.',
          };
        }
      }
      continue;
    }

    // dd/install/rsync/ln naming a risky (non-seal — that DENIES above) config file as any argument.
    if (headBase.toLowerCase() === 'dd') {
      const ofArg = argv.find((a) => /^of=/i.test(String(a)));
      if (ofArg && isRiskyConfigFile(String(ofArg).slice(3), dir)) {
        return { decision: 'ask', reason: RISKY_FILE_ASK_REASON };
      }
    }
    if (/^(?:install|rsync|ln)(?:\.exe)?$/i.test(headBase)) {
      const riskyArg = argv.slice(1).find((a) => !String(a).startsWith('-') && isRiskyConfigFile(a, dir));
      if (riskyArg) return { decision: 'ask', reason: RISKY_FILE_ASK_REASON };
    }

    // ex / vim -es / nvim --headless — non-interactive editor drivers that can rewrite a file
    // wholesale via a script, with no Edit/Write payload for the marker-diff checks to see.
    if (isBatchEditorInvocation(headBase, argv)) {
      const riskyArg = argv.slice(1).find((a) => !String(a).startsWith('-') && isRiskyConfigFile(a, dir));
      if (riskyArg) return { decision: 'ask', reason: RISKY_FILE_ASK_REASON };
    }

    // python/node/cp/tee/mv/`git checkout|restore` naming a risky config file wholesale — a full
    // overwrite/replace is invisible to the marker-diff checks above (Edit/Write/MultiEdit,
    // sed/perl -i, a redirect) because there is no "before" text to diff against in this shape.
    if (/^(?:python[23]?|node|cp|tee|mv)(?:\.exe)?$/i.test(headBase)
      || (headBase === 'git' && (argv[1] === 'checkout' || argv[1] === 'restore'))) {
      const startAt = headBase === 'git' ? 2 : 1;
      const riskyArg = argv.slice(startAt).find((a) => !String(a).startsWith('-') && isRiskyConfigFile(a, dir));
      if (riskyArg) {
        return { decision: 'ask', reason: RISKY_FILE_ASK_REASON };
      }
    }

    if (DB_CLIENT_RE.test(headBase)) {
      if (OPAQUE.test(seg)) {
        return {
          decision: 'ask',
          reason:
            `PERMISSION NEEDED: \`${headBase}\` targets a host built from a shell substitution ` +
            `(\`${seg.trim()}\`), so this guard cannot tell whether it reaches a parked database. ` +
            'Run it with the host spelled out literally, or confirm you know it is not an ' +
            'offloaded target.',
        };
      }
      const flag = extractFlagTarget(argv);
      const env = extractEnvTarget([...Object.entries(sticky).map(([k, v]) => `${k}=${v}`), ...prefix, ...inner]);
      if (flag.service || env.service) {
        return {
          decision: 'ask',
          reason:
            `PERMISSION NEEDED: \`${headBase}\` resolves its target through PGSERVICE/service=, ` +
            'which this guard cannot see through — the real host and database live in ' +
            'pg_service.conf. Confirm this connection is not meant to reach a parked target.',
        };
      }
      const host = flag.host ?? env.host;
      const dbname = flag.dbname ?? env.dbname;
      const hit = matchDirectTarget(targets, host, dbname);
      if (hit?.kind === 'deny') {
        return {
          decision: 'deny',
          reason:
            `BLOCKED: \`${headBase}\` targets '${host}'/'${dbname}', which is a PARKED database ` +
            'alias (`sidekicks database offload`). It has been deliberately taken out of reach — ' +
            '`sidekicks database offload <alias> --restore` is the only way back, and that always ' +
            'asks the user first.',
        };
      }
      if (hit?.kind === 'ask') {
        return {
          decision: 'ask',
          reason:
            `PERMISSION NEEDED: \`${headBase}\` targets host '${host}' with no database named, and ` +
            'that host also serves at least one PARKED alias (the same host commonly serves many ' +
            'databases, only some of them offloaded). Name the database explicitly, or confirm this ' +
            'connection is not meant to reach the parked one.',
        };
      }
      continue;
    }

    if (TSH_RE.test(headBase)) {
      const isProxyDb = argv[1] === 'proxy' && argv[2] === 'db';
      const isDbConnectOrLogin = argv[1] === 'db' && (argv[2] === 'connect' || argv[2] === 'login');
      if (isProxyDb || isDbConnectOrLogin) {
        if (OPAQUE.test(seg)) {
          return {
            decision: 'ask',
            reason:
              `PERMISSION NEEDED: \`tsh ${argv[1]} ${argv[2]}\` targets a value built from a shell ` +
              'substitution, so this guard cannot tell whether it reaches a parked Teleport target. ' +
              'Run it with the cluster/database spelled out literally.',
          };
        }
        const { cluster, dbName } = extractTeleportTarget(argv);
        const hit = matchTeleportTarget(targets, cluster, dbName);
        if (hit?.kind === 'deny') {
          return {
            decision: 'deny',
            reason:
              `BLOCKED: tsh ${argv[1]} ${argv[2]} targets cluster '${cluster}' database ` +
              `'${dbName}', which is a PARKED Teleport database target (sidekicks database ` +
              'offload). `sidekicks database offload <alias> --restore` is the only way back, ' +
              'and that always asks the user first.',
          };
        }
      }
      continue;
    }

    if (/^(?:python[23]?|node)(?:\.exe)?$/i.test(headBase)) {
      // The literal script text: either after -c, or the whole segment for a python/node file
      // whose contents this guard cannot read anyway — scan what IS visible on the command line.
      const ci = argv.indexOf('-c');
      const scriptText = ci >= 0 ? argv[ci + 1] : seg;

      // `sidekicks` alongside a `--restore`/`restore` built from concatenated string fragments —
      // defeats a literal-flag match on purpose.
      if (/\bsidekicks\b/i.test(scriptText) && SPLIT_RESTORE_RE.test(scriptText)) {
        return { decision: 'ask', reason: SPLIT_RESTORE_ASK_REASON };
      }

      const inline = extractInlineTarget(scriptText);
      if (inline) {
        const hit = matchDirectTarget(targets, inline.host, inline.dbname);
        if (hit?.kind === 'deny') {
          return {
            decision: 'deny',
            reason:
              `BLOCKED: this inline ${headBase} script connects to '${inline.host}'/'${inline.dbname}', ` +
              'a PARKED database alias. `sidekicks database offload <alias> --restore` is the only ' +
              'way back, and that always asks the user first.',
          };
        }
      }

      // An EXTERNAL script file argument (not `-c`) whose OWN content mentions a risky filename or
      // the marker convention — a command line naming no risky argument at all can still be risky
      // if the invoked script references one internally. Best-effort: an unreadable/absent file
      // (not on disk yet, a remote path) contributes nothing rather than throwing.
      if (ci < 0) {
        const scriptFileArg = argv.slice(1)
          .find((a) => !String(a).startsWith('-') && /\.(?:py|js|mjs|cjs|ts)$/i.test(String(a)));
        if (scriptFileArg) {
          const abs = isAbsolute(scriptFileArg) ? scriptFileArg : resolvePath(dir, scriptFileArg);
          let fileContent = null;
          try { fileContent = readFileSync(abs, 'utf8'); } catch { /* unreadable — best effort */ }
          if (fileContent && scriptFileLooksRisky(fileContent)) {
            return { decision: 'ask', reason: RISKY_FILE_ASK_REASON };
          }
        }
      }
      continue;
    }
  }
  return null;
}

/**
 * Handle a `tool_input.command` that may be a STRING or an ARGV ARRAY. Joining an array into a
 * string and re-tokenizing loses a nested `sh -c "<script with spaces>"` argument as a single
 * unit — so an array is inspected directly: when argv[0] is a shell and the next flag is
 * `-c`/`-lc`/…, argv[2] (the nested script) is decided as its own command line.
 *
 * @param {string|string[]} raw
 * @param {string} cwd
 * @returns {Promise<{decision:'ask'|'deny', reason:string}|null>}
 */
async function decideCommand(raw, cwd) {
  if (Array.isArray(raw)) {
    const argv = raw.map(String);
    const joined = argv.join(' ');
    const secretDecision = secretReadDecision(joined);
    if (secretDecision) return secretDecision;
    if (argv.length > 0 && isShell(argv[0])) {
      let ci = -1;
      for (let k = 1; k < argv.length; k += 1) {
        const tok = argv[k];
        if (!tok.startsWith('-')) break;
        if (/^-[a-zA-Z]*c$/.test(tok) || tok === '--command') { ci = k; break; }
      }
      const script = ci >= 0 ? argv[ci + 1] : null;
      if (script != null) return decide(script, cwd);
    }
    return decide(joined, cwd);
  }
  return decide(String(raw ?? ''), cwd);
}

// ── ASK: Edit/Write/MultiEdit/Codex apply_patch payloads that remove a `#[offloaded]` marker ───

function decideWriteTool(evt, cwd) {
  const ti = evt?.tool_input ?? {};
  const filePath = ti.file_path;
  if (!filePath) return null;
  // ANY Write/Edit/MultiEdit on a `db-seal*` file DENIES outright — there is no safe edit to a
  // keypair file; `sidekicks database seal-init` is the only sanctioned way to create/rotate one.
  if (isSealFile(filePath)) {
    return { decision: 'deny', reason: SEAL_WRITE_DENY_REASON };
  }
  if (!isMarkerTargetPath(filePath)) return null;
  const toolName = evt?.tool_name;
  let hit = false;
  if (toolName === 'Edit') {
    hit = removesMarkers(ti.old_string, ti.new_string);
  } else if (toolName === 'MultiEdit' && Array.isArray(ti.edits)) {
    hit = ti.edits.some((e) => removesMarkers(e?.old_string, e?.new_string));
  } else if (toolName === 'Write') {
    const abs = isAbsolute(String(filePath)) ? String(filePath) : resolvePath(cwd, String(filePath));
    let current;
    try { current = readFileSync(abs, 'utf8'); } catch { return null; } // new file — nothing to remove
    hit = removesMarkers(current, ti.content);
  }
  if (!hit) return null;
  return { decision: 'ask', reason: MARKER_ASK_REASON };
}

/** Codex's `apply_patch` tool: a `*** Begin Patch … *** End Patch` payload, wherever it is carried. */
function decideApplyPatch(evt) {
  const ti = evt?.tool_input ?? {};
  const patchText = ti.patch ?? ti.input ?? ti.command ?? ti.cmd ?? '';
  const parsed = parseApplyPatch(Array.isArray(patchText) ? patchText.join('\n') : String(patchText));
  if (!parsed) return null;
  if (isSealFile(parsed.filePath)) {
    return { decision: 'deny', reason: SEAL_WRITE_DENY_REASON };
  }
  if (!isMarkerTargetPath(parsed.filePath)) return null;
  if (!removesMarkers(parsed.oldText, parsed.newText)) return null;
  return { decision: 'ask', reason: MARKER_ASK_REASON };
}

/**
 * @param {object} evt - the hook-shaped event payload.
 * @returns {Promise<{decision:'ask'|'deny', reason:string}|null>}
 */
async function decideForEvent(evt) {
  const toolName = evt?.tool_name;
  const cwd = evt?.cwd || process.cwd();
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    return secretPathToolDecision(toolName, evt?.tool_input);
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    return decideWriteTool(evt, cwd);
  }
  if (toolName === 'apply_patch' || toolName === 'shell.apply_patch') {
    return decideApplyPatch(evt);
  }
  const ti = evt?.tool_input ?? {};
  const raw = ti.command ?? ti.cmd ?? ti.script ?? '';
  return decideCommand(raw, cwd);
}

// ── entry points ───────────────────────────────────────────────────────────────────────────────

async function main() {
  const cmdIdx = process.argv.indexOf('--command');
  if (cmdIdx !== -1) {
    const cwdIdx = process.argv.indexOf('--cwd');
    const cwd = cwdIdx !== -1 ? process.argv[cwdIdx + 1] : process.cwd();
    const d = await decide(process.argv[cmdIdx + 1] ?? '', cwd);
    console.log(JSON.stringify(d ?? { allow: true }));
    process.exit(0);
  }

  let evt;
  try {
    evt = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // unreadable stdin — allow
  }
  const d = await decideForEvent(evt);
  if (!d) process.exit(0);
  process.stderr.write(`${d.reason}\n`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: d.reason,
    },
  }));
  process.exit(0);
}

// Direct-test mode stays testable even when the operator disabled the live hook — but this hook
// is a floor entry, so `hookEnabled` always answers true anyway; the gate is called for parity
// with every other wired hook, not because this one can actually be turned off.
if (!process.argv.includes('--command') && !process.argv.includes('--event')) {
  await import('./lib/hook-gate.mjs')
    .then((gate) => gate.exitIfDisabled('hook.enforce-db-offload'))
    .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway
}

try {
  await main();
} catch {
  process.exit(0); // best-effort: never wedge the agent
}
