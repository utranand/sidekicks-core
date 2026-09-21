// lib/core-lifecycle/_wiring.mjs
// Per-CLI wiring for a workspace whose framework lives in a submodule (AAP-110).
//
// THE PROBLEM. Every supported CLI is wired to hook scripts by path, and each spells that path its
// own way (Rule 6 parity, docs/guide/multi-cli-compatibility.md):
//
//   .claude/settings.json   node "$CLAUDE_PROJECT_DIR/scripts/<hook>.mjs"
//   .agent/settings.json    node "$AGENT_PROJECT_DIR/scripts/<hook>.mjs"
//   .codex/config.toml      node scripts/<hook>.mjs            (cwd is the workspace root)
//   (all four)              .sidekicks/hooks/rtk-hook.mjs
//
// In a mounted workspace those scripts are NOT at <workspace>/scripts/ — they are at
// <workspace>/.sidekicks-core/scripts/. So the wiring is copied out of the core and every hook path
// is re-pointed through the mount. Nothing else in the files is touched.
//
// TEXTUAL, NOT PARSE-AND-REEMIT. `.codex/config.toml` carries load-bearing comments explaining which
// hooks cannot be ported to Codex and why; a round-trip through a TOML emitter would drop them. The
// same rule the framework enable map follows (lib/framework-settings/framework-config.mjs writes
// line-level so comments survive) applies here.
//
// Every rule is IDEMPOTENT by construction: after a rewrite the text no longer matches its own
// pattern, so `core update` can re-apply the whole set without doubling a prefix.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeAtomic, mkdirp } from '../fs-safety/fsx.mjs';
import { CORE_DIR } from '../sk-cli/core-mount.mjs';

/**
 * Wiring files whose hook paths must be re-pointed at the mount.
 * Keep in sync with CLI_WIRING in .agents/skills/sk-inherit/scripts/inherit.mjs and the
 * parity matrix in docs/guide/multi-cli-compatibility.md — adding a CLI means adding a row here.
 */
export const WIRING_FILES = Object.freeze([
  join('.claude', 'settings.json'),
  join('.codex', 'config.toml'),
  join('.agent', 'settings.json'),
]);

/**
 * Wiring directories copied verbatim — subagents, commands and plugins carry no hook paths.
 */
export const WIRING_DIRS = Object.freeze([
  join('.agents', 'subagents'),
  join('.claude', 'agents'),
  join('.claude', 'commands'),
  join('.codex', 'agents'),
  join('.agents', 'plugins'),
]);

/**
 * The receipt that records which files under WIRING_DIRS the mounted core last shipped here.
 *
 * WHY IT EXISTS. The directories above are copied with `cpSync`, which adds and overwrites but
 * never deletes. So a file the core RENAMES or DROPS survives in the workspace for the rest of that
 * workspace's life, and `core update` reports success while leaving both generations live — sixteen
 * `bmm-*` Codex agents beside their sixteen `sk-*` replacements, or a `/bmad:*` command stub loading
 * a tree the new core no longer carries. That second one is INC-2026-09-04-02 arriving by upgrade
 * instead of by forge. The skill overlay already fixed exactly this class for itself
 * (see `applyDerived`'s prune note in _derive.mjs: "a trimmed core left 13 dangling links behind,
 * and re-running `core init` could not clear them because the overlay step was additive only");
 * the wiring directories beside it did not get the same treatment.
 *
 * WHY A RECEIPT AND NOT "DELETE WHAT THE CORE DOES NOT SHIP". The overlay can prune safely because
 * a core skill is a LINK and a workspace-authored skill is a real directory, so the two are
 * distinguishable on disk. A wiring file is a plain copy and carries no such marker: "not in the
 * core" is equally true of a retired port and of an agent the consumer wrote themselves. The
 * receipt is what separates them — a path is removed only when a PREVIOUS core demonstrably shipped
 * it AND the current core does not. Anything the consumer authored was never in a receipt, so it is
 * never a candidate.
 *
 * IT IS A RECEIPT, NOT STATE. It records an event nothing on disk can reconstruct afterwards and is
 * read in order to undo it — the same contract as `.sidekicks/registry/skills/`, which is why it
 * lives beside it and is COMMITTED rather than git-ignored. State would be wrong here: a consumer
 * who clones their workspace fresh would lose the ability to prune on the very next upgrade.
 *
 * FAILURE IS SAFE IN ONE DIRECTION ONLY. A missing, unreadable or unrecognised receipt prunes
 * NOTHING and simply writes a fresh one, so the worst case is today's behaviour plus a baseline for
 * next time. That is also the bootstrap path: the first init/update after this lands removes
 * nothing, and every one after it prunes correctly.
 */
const WIRING_RECEIPT = join('.sidekicks', 'registry', 'core-wiring.json');

/**
 * Write the receipt from a core that is STILL CHECKED OUT, when the workspace has none.
 *
 * This closes the one gap the receipt otherwise leaves. A workspace bootstrapped by a core that
 * predates the receipt has nothing to prune against, so its FIRST upgrade — the one actually
 * carrying the rename — would strand the old ports and only then write a baseline. `core update`
 * calls this before it moves the gitlink, while the outgoing core's tree is still on disk, so the
 * incoming core prunes against what its predecessor really shipped rather than against nothing.
 *
 * Does nothing when a receipt already exists: the recorded one is the authority, and overwriting it
 * from the current tree would erase the very difference the prune depends on.
 *
 * @param {string} repoRoot - workspace root
 * @param {string} coreDir  - the OUTGOING core, still checked out
 * @returns {boolean} whether a receipt was seeded
 */
export function seedWiringReceipt(repoRoot, coreDir) {
  const abs = join(repoRoot, WIRING_RECEIPT);
  if (existsSync(abs)) return false;
  const dirs = {};
  for (const rel of WIRING_DIRS) {
    const src = join(coreDir, rel);
    dirs[portableRel(rel)] = existsSync(src) ? shippedUnder(src) : [];
  }
  mkdirp(dirname(abs));
  writeAtomic(abs, `${JSON.stringify({ schema: 1, dirs }, null, 2)}\n`);
  return true;
}

/**
 * Forward-slash spelling of a `join`ed relative path, so a receipt written on Windows is readable
 * on POSIX and the other way round.
 *
 * @param {string} rel
 * @returns {string}
 */
function portableRel(rel) {
  return rel.split('\\').join('/');
}

/**
 * Every file under `root`, as sorted forward-slash paths relative to it.
 *
 * Uses `statSync`, not the readdir Dirent type, deliberately: the copy below passes
 * `dereference: true`, so a symlink in the core lands in the workspace as whatever it pointed at.
 * Enumerating with the Dirent type would classify it as a link and mis-record what was shipped.
 *
 * @param {string} root
 * @returns {string[]}
 */
function shippedUnder(root) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else out.push(childRel);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Read the previous receipt, or null when there is nothing trustworthy to act on.
 *
 * @param {string} repoRoot
 * @returns {Record<string, string[]> | null}
 */
function readWiringReceipt(repoRoot) {
  const abs = join(repoRoot, WIRING_RECEIPT);
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, 'utf8'));
    if (!parsed || parsed.schema !== 1) return null;
    if (!parsed.dirs || typeof parsed.dirs !== 'object') return null;
    return parsed.dirs;
  } catch {
    return null;
  }
}

/**
 * Remove the files a previous core shipped under one wiring directory that the current one does not.
 *
 * @param {string} repoRoot
 * @param {string} rel        - the wiring directory, as joined for this platform
 * @param {string[]|undefined} previous - what the last receipt recorded for it
 * @param {string[]} shipped  - what the core ships for it now
 * @param {string[]} removed  - accumulator, portable paths relative to the workspace
 */
function pruneRetired(repoRoot, rel, previous, shipped, removed) {
  if (!Array.isArray(previous) || previous.length === 0) return;
  const keep = new Set(shipped);
  for (const relPath of previous) {
    if (typeof relPath !== 'string' || keep.has(relPath)) continue;
    const abs = join(repoRoot, rel, ...relPath.split('/'));
    if (!existsSync(abs)) continue;
    try {
      rmSync(abs, { force: true });
      removed.push(`${portableRel(rel)}/${relPath}`);
    } catch {
      // A file the consumer has open or has made read-only is left alone; the next run retries it.
    }
  }
}

/**
 * Drop directories left empty by a prune, bottom-up. The wiring directory itself always survives —
 * a core that ships no `.claude/agents` at all is reported as `skipped`, not deleted out from under
 * a consumer who keeps their own files beside it.
 *
 * @param {string} rootAbs
 */
function pruneEmptyDirs(rootAbs) {
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = join(abs, name);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(child);
    }
    if (abs === rootAbs) return;
    try {
      if (readdirSync(abs).length === 0) rmdirSync(abs);
    } catch {
      // Not empty, or removed underneath us. Either way there is nothing to do.
    }
  };
  walk(rootAbs);
}

/**
 * Path rewrites, applied in order. Each entry is [pattern, replacement].
 *
 * @type {ReadonlyArray<[RegExp, string]>}
 */
const REWRITES = Object.freeze([
  // Claude / Antigravity: an env-var-anchored absolute path.
  [/(\$(?:CLAUDE|AGENT)_PROJECT_DIR)\/scripts\//g, `$1/${CORE_DIR}/scripts/`],
  // Codex: workspace-root-relative, no env var.
  [/\bnode scripts\//g, `node ${CORE_DIR}/scripts/`],
  // The shell hook under .sidekicks/hooks/ travels inside the core too, and it is spelled TWO ways:
  // env-var-anchored on Claude (like every other hook in that file) and workspace-relative
  // on Codex (like every other hook in that file). The env-var form must come first — the bare rule's
  // lookbehind excludes a preceding `/`, so it would never fire on it, and a cwd-relative hook path
  // in a mounted workspace resolves to a <workspace>/.sidekicks/hooks/ that does not exist.
  [/(\$(?:CLAUDE|AGENT)_PROJECT_DIR)\/\.sidekicks\/hooks\//g, `$1/${CORE_DIR}/.sidekicks/hooks/`],
  // Workspace-relative (Codex). The lookbehind is what makes this idempotent: after either rewrite
  // the match is preceded by `-core/`, which the class excludes.
  [/(?<![\w./-])\.sidekicks\/hooks\//g, `${CORE_DIR}/.sidekicks/hooks/`],
]);

/**
 * Apply every path rewrite to one wiring file's text.
 *
 * @param {string} text
 * @returns {string}
 */
export function rewireText(text) {
  let out = text;
  for (const [pattern, replacement] of REWRITES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Does this text still reference a hook path that does NOT go through the mount?
 * Used by `core doctor` — a wiring file the rewrite missed produces hooks that silently never run.
 *
 * @param {string} text
 * @returns {string[]} the offending fragments (empty when clean)
 */
export function unroutedHookPaths(text) {
  const offenders = [];
  for (const [pattern] of REWRITES) {
    // Fresh regex per check: the shared literals carry /g and therefore lastIndex state.
    const re = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = re.exec(text)) !== null) offenders.push(m[0]);
  }
  return offenders;
}

/**
 * Copy the per-CLI wiring out of the core into the workspace, re-pointing hook paths at the mount.
 *
 * Overwrites: the wiring files are framework-owned (the "System" class in
 * lib/package-lifecycle/overlay.mjs's vocabulary) and are regenerated on every `core init` /
 * `core update`. A workspace that needs its own hooks adds them in the host CLI's local settings
 * (e.g. `.claude/settings.local.json`), which is never touched here.
 *
 * Prunes: a file under WIRING_DIRS that a PREVIOUS core shipped here and the current one does not
 * is removed, so a renamed or retired port does not outlive its core. The receipt that makes that
 * safe is documented at WIRING_RECEIPT above; a workspace's own files are never candidates.
 *
 * @param {string} repoRoot - workspace root
 * @param {string} coreDir  - absolute path of the mounted core
 * @returns {{files: string[], dirs: string[], skipped: string[], removed: string[]}}
 */
export function applyWiring(repoRoot, coreDir) {
  const files = [];
  const dirs = [];
  const skipped = [];
  const removed = [];

  for (const rel of WIRING_FILES) {
    const src = join(coreDir, rel);
    if (!existsSync(src)) { skipped.push(rel); continue; }
    const dest = join(repoRoot, rel);
    mkdirp(dirname(dest));
    writeAtomic(dest, rewireText(readFileSync(src, 'utf8')));
    files.push(rel);
  }

  // The receipt is read BEFORE the copy, because the copy is what makes the old and new sets
  // indistinguishable on disk. See WIRING_RECEIPT above for why a receipt and not a diff.
  const previous = readWiringReceipt(repoRoot);
  const shippedNow = {};

  for (const rel of WIRING_DIRS) {
    const key = portableRel(rel);
    const src = join(coreDir, rel);
    const dest = join(repoRoot, rel);

    if (!existsSync(src)) {
      // The core ships this directory no longer. Whatever it shipped LAST time still has to go —
      // a core that stops carrying `.claude/commands` must not leave its stubs behind — so this
      // records an empty shipped set and prunes against it rather than skipping the prune.
      skipped.push(rel);
      shippedNow[key] = [];
      pruneRetired(repoRoot, rel, previous?.[key], [], removed);
      if (existsSync(dest)) pruneEmptyDirs(dest);
      continue;
    }

    mkdirp(dirname(dest));
    cpSync(src, dest, { recursive: true, dereference: true });

    const shipped = shippedUnder(src);
    shippedNow[key] = shipped;
    pruneRetired(repoRoot, rel, previous?.[key], shipped, removed);
    pruneEmptyDirs(dest);
    dirs.push(rel);
  }

  // Written on every run, including the one that pruned nothing: that is what establishes the
  // baseline a later upgrade prunes against.
  const receiptAbs = join(repoRoot, WIRING_RECEIPT);
  mkdirp(dirname(receiptAbs));
  writeAtomic(receiptAbs, `${JSON.stringify({ schema: 1, dirs: shippedNow }, null, 2)}\n`);

  return { files, dirs, skipped, removed };
}

/**
 * Read the workspace's wiring files and report any hook path that still bypasses the mount.
 *
 * @param {string} repoRoot
 * @returns {Array<{file: string, offenders: string[]}>}
 */
export function auditWiring(repoRoot) {
  const problems = [];
  for (const rel of WIRING_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const offenders = unroutedHookPaths(text);
    if (offenders.length) problems.push({ file: rel, offenders: [...new Set(offenders)] });
  }
  return problems;
}
