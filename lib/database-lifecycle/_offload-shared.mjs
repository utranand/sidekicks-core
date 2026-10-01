// lib/database-lifecycle/_offload-shared.mjs
// Shared helpers for `sidekicks database offload|offloaded` — the alias-park verb pair.
// Trimmed from the v1 checkpoint (4b4c3c72): the tier port, Bangkok timestamp, git user, argv
// tokenizer, glob and scope resolution travel unchanged; the twin-block constants and the
// position-anchor annotation helpers do NOT — v2 never moves an entry to a second block, so there
// is nothing to anchor a reinsertion point against.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveEffectiveScope } from '../active-scope/scope.mjs';
import { blockEntry, CONFIG_DIR, LEGACY_FILE } from '../config-store/families.mjs';
import { PENDING_PREFIX } from '../config-store/write.mjs';

/** The two blocks `database offload`/`offloaded` act on. */
export const OFFLOAD_BLOCKS = Object.freeze(['database_connector', 'teleport_database_connector']);

/** Keys that look like an alias but are reserved routing/tuning keys, never selectable. */
export const RESERVED_KEYS = Object.freeze({
  // `teleport_database_connector.defaults` is the documented dedup block every real alias may
  // inherit from (config.example.yaml) — not an alias, never offloadable, never counted as "known".
  teleport_database_connector: new Set(['defaults']),
});

// ── Environment tier from an alias's own name ──────────────────────────────────

/**
 * Recognised environment tiers, in the same order as `db_tier_from_alias`'s own tuple
 * (.agents/skills/sk-jira-workspace/scripts/workspace.py `DB_TIERS`) — kept in lockstep so a card's
 * declared tier and an offload's `--tier` classify any given alias identically.
 */
export const DB_TIERS = Object.freeze(['local', 'dev', 'sit', 'uat', 'staging', 'prod', 'unknown']);

const TIER_SEGMENT_NAMES = Object.freeze([
  ['prod', ['prod', 'production']],
  ['uat', ['uat']],
  ['staging', ['staging', 'stage']],
  ['sit', ['sit']],
  ['dev', ['dev', 'develop']],
  ['local', ['local', 'localhost']],
]);

/**
 * Environment tier read off the alias's own segments — `'shp-th-province-uat-ret'` -> `'uat'`.
 * Direct JS port of `db_tier_from_alias` (workspace.py, ~L346-360): same segment split, same tier
 * precedence order, same 'unknown' fallback when nothing matches.
 *
 * @param {string} alias
 * @param {string} [fallback='unknown']
 * @returns {string}
 */
export function dbTierFromAlias(alias, fallback = 'unknown') {
  const parts = new Set(String(alias).toLowerCase().split(/[-_.]+/).filter(Boolean));
  for (const [tier, names] of TIER_SEGMENT_NAMES) {
    if (names.some((n) => parts.has(n))) return tier;
  }
  return fallback;
}

// ── Timestamp + attribution ─────────────────────────────────────────────────────

/**
 * Current Asia/Bangkok time as an ISO-8601 string with a fixed `+07:00` offset (Thailand observes
 * no DST). Matches the format `lib/database-lifecycle/add.mjs`'s own `formatBangkokIso` writes for
 * `captured_at` — kept as a separate copy here rather than a shared export, the same call this
 * repo already makes for small per-module timestamp helpers.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function formatBangkokIso(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}+07:00`;
}

/**
 * The current git identity's display name, best-effort. Never throws: an offload annotation
 * without an attributable name still records WHEN and WHY; only WHO is allowed to come back
 * `'unknown'`. The only shell-out this module makes, and it never touches any repository state.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function gitUserName(cwd) {
  try {
    const r = spawnSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', shell: false });
    if (r && r.status === 0 && r.stdout) {
      const name = r.stdout.trim();
      if (name) return name;
    }
  } catch { /* git unavailable or spawn failed — fall through */ }
  return 'unknown';
}

// ── Argv tokenizer ───────────────────────────────────────────────────────────────

/** Flags that never take a value. */
const OFFLOAD_BOOL_FLAGS = new Set(['json', 'root', 'dry-run', 'restore', 'yes']);
/** Flags that always take the next token as their value (unless it looks like another flag). */
const OFFLOAD_VALUE_FLAGS = new Set(['match', 'tier', 'reason']);

/**
 * Tokenize a raw argv slice into `{flags, positionals}` for `database offload`/`offloaded`.
 *
 * WHY NOT `lib/config-lifecycle/_shared.mjs`'s `parseConfigFlags`, and WHY NOT the dispatcher's own
 * `args.name`/`args.rest` split: `cli.mjs`'s global `parseArgs` runs with `strict:false` and only
 * `--help`/`--version`/`--verbose` declared, so an UNRECOGNISED value-taking flag like `--tier prod`
 * is parsed as `{tier: true}` with `'prod'` left as a stray POSITIONAL — verified against Node's own
 * `parseArgs`. `config` verbs never notice because they need at most one positional value, always
 * ahead of any flag; this verb needs an arbitrary NUMBER of alias positionals interleaved with
 * several value-taking flags, so it re-tokenizes `ctx.argv` from scratch instead.
 *
 * A `--flag=value` on a BOOLEAN flag is reported back as a STRING (never coerced to `true`), so a
 * caller can reject it as a usage error instead of silently accepting `--restore=yes` as consent.
 *
 * @param {string[]} argv - `ctx.argv`, the FULL raw argv (starts with the namespace + verb)
 * @returns {{flags: Record<string, string|boolean>, positionals: string[]}}
 */
export function tokenizeOffloadArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (!tok.startsWith('--')) { positionals.push(tok); continue; }
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const key = body.slice(0, eq);
      flags[key] = body.slice(eq + 1); // a boolean flag's caller decides whether this is a usage error
      continue;
    }
    if (OFFLOAD_BOOL_FLAGS.has(body)) { flags[body] = true; continue; }
    if (OFFLOAD_VALUE_FLAGS.has(body)) {
      const next = list[i + 1];
      if (next !== undefined && !String(next).startsWith('--')) { flags[body] = next; i++; }
      else flags[body] = '';
      continue;
    }
    flags[body] = true; // an unrecognised flag — swallowed as boolean, same convention parseConfigFlags uses
  }
  return { flags, positionals };
}

/**
 * Drop a leading `[namespace, verb]` pair from a positionals list, when present. `ctx.argv` in
 * production always starts with them (`['database', 'offload', ...]`); a direct unit test's
 * `ctx.argv` mirrors the same shape so behaviour never diverges from a real invocation.
 *
 * @param {string[]} positionals
 * @param {string} ns
 * @param {string} verb
 * @returns {string[]}
 */
export function stripVerbPrefix(positionals, ns, verb) {
  if (positionals[0] === ns && positionals[1] === verb) return positionals.slice(2);
  return positionals;
}

/**
 * A simple shell-style glob (`*`, `?`) compiled to an anchored RegExp — enough for `--match
 * 'shp-nt-*'`, not a general glob engine.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const special = /[.+^${}()|[\]\\]/;
  let pattern = '';
  for (const ch of String(glob)) {
    if (ch === '*') pattern += '.*';
    else if (ch === '?') pattern += '.';
    else pattern += special.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${pattern}$`);
}

// ── Scope + candidate-file resolution ────────────────────────────────────────────

/**
 * Resolve which scope base (`'.sidekicks'` or `projects/<active>'`) `database offload`/`offloaded`
 * work in, and the (up to 4) files inside it that may carry a `database_connector` /
 * `teleport_database_connector` entry — the family file, its secret sibling, and — when present —
 * the legacy `config.yaml` monolith and its retired `pending-removal.config.yaml`. Mirrors
 * `config set`/`unset`'s own root/project decision exactly, so `--root` means the same thing here.
 *
 * @param {string} repoRoot
 * @param {{root?: boolean}} flags
 * @returns {{base: string, projectName: string, files: string[], entry: object}}
 */
export function resolveOffloadScope(repoRoot, flags) {
  const entry = blockEntry(repoRoot, 'database_connector');
  if (!entry) {
    throw new SidekicksError(
      "database offload: nothing declares block 'database_connector' — run 'sidekicks config list'",
      EXIT_VALIDATION
    );
  }
  const settings = readSettings(repoRoot);
  const { projectName, projectRelPath } = resolveEffectiveScope(settings);
  const useRoot = Boolean(flags && flags.root) || entry.scope === 'root' || projectRelPath === null;
  if (entry.scope === 'project' && useRoot) {
    throw new SidekicksError(
      "database offload: 'database_connector' is project-scoped, so it has no root-scope home"
      + (projectRelPath === null
        ? " — activate a project first: 'sidekicks project use <name>'"
        : ` — drop '--root' to work in '${projectRelPath}/${CONFIG_DIR}/${entry.file}'`),
      EXIT_VALIDATION
    );
  }
  const base = useRoot ? '.sidekicks' : projectRelPath;
  const files = [
    join(base, CONFIG_DIR, entry.file),
    join(base, CONFIG_DIR, entry.secret),
    join(base, LEGACY_FILE),
    join(base, CONFIG_DIR, `${PENDING_PREFIX}config.yaml`),
  ];
  return { base, projectName, files, entry };
}
