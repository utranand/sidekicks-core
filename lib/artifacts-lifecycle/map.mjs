// lib/artifacts-lifecycle/map.mjs
// Implements `sidekicks artifacts map [<cloud-path>] [--project <p>] [--service <svc>]
//                                     [--check] [--unmap] [--yes] [--json]`.
//
// Relocate a scope's `artifacts/` tree onto a cloud-drive folder and leave a directory link
// behind, so every skill that resolves `scope artifacts-base` keeps writing to the same path
// while the bytes land in the synced folder.
//
//   projects/<p>/artifacts  ->  <cloud-root>/…/projects/<p>/artifacts
//
// WHY THE LINK POINTS THIS WAY, and not the other. A cloud client (Google Drive for desktop,
// Dropbox, OneDrive) syncs the files it finds inside its own folder; it does not follow a link
// out of that folder to some other part of the disk. So the only arrangement that actually
// syncs is: the real directory lives in the cloud folder, the repo carries the link. Putting a
// link INSIDE the cloud folder pointing back at the repo syncs a broken shortcut and nothing
// else — that is the version of this that silently does not work.
//
// Three gates stand between the caller and the move, each for a failure that is expensive and
// quiet rather than loud:
//
//   1. TRACKED FILES. Moving a git-tracked file out of the tree and leaving a symlink deletes it
//      from the index. The repo root's own `artifacts/` carries ~180 tracked files today, so this
//      is not hypothetical. Refused outright; `--yes` does not override it, because the honest fix
//      (commit, or untrack) belongs to the caller and takes a minute.
//
//   2. AN UNMOUNTED CLOUD FOLDER. `/Users/<u>/Library/CloudStorage/GoogleDrive-<acct>/My Drive/…`
//      is a mount point. When the client is signed out or not running, that path is simply absent —
//      and a reflexive `mkdir -p` would happily build a real local directory there, move 800MB into
//      it, and sync exactly none of it. So the PARENT of the cloud path must already exist; only
//      the leaf is created.
//
//   3. THE UPLOAD IS AN OUTWARD ACTION. Moving repository artifacts into a synced folder publishes
//      them to a third party. `--yes` is that consent, stated in the disclosure the verb prints
//      when it is missing — never assumed, and never inferred from the fact that a path was given.
//
// The move itself is copy → verify → remove, never a bare rename: a cloud mount is a different
// device, where `rename(2)` fails with EXDEV. The verification compares file count and total
// bytes at both ends and aborts before deleting anything if they disagree.
//
// Reversal is `--unmap`: the cloud copy is brought back to a real local directory and the cloud
// copy is LEFT IN PLACE. Deleting the remote side would make an unmap the destructive half of a
// pair whose other half is safe, and the caller can delete it themselves once they are satisfied.
//
// Zero npm dependencies — node:* and relative lib/ imports only. All git spawns delegated to
// git-delegation/git.mjs.

import {
  existsSync, lstatSync, statSync, readlinkSync, readdirSync, mkdirSync, cpSync, rmSync,
  renameSync,
} from 'node:fs';
import { join, resolve as resolvePath, dirname, isAbsolute, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

import { SidekicksError, EXIT_OK, EXIT_VALIDATION, EXIT_NOT_FOUND, EXIT_IO } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { resolveWorkingFolder } from '../active-scope/scope.mjs';
import { createDirLink, removeDirLink } from '../fs-safety/fsx.mjs';
import { topLevel, trackedUnder, ensureLocalExclude, dropLocalExclude } from '../git-delegation/git.mjs';
import { parseArtifactFlags } from './_shared.mjs';

/** Flags that never take a value. */
const BOOLEANS = ['check', 'unmap', 'yes', 'json', 'help', 'verbose', 'version'];

/** The directory name this verb maps. Never caller-supplied — the whole path is derived. */
const ARTIFACTS_DIRNAME = 'artifacts';

// ---------------------------------------------------------------------------
// Small path helpers
// ---------------------------------------------------------------------------

/** Real path with platform-correct case folding, for comparing two spellings of one directory. */
function samePathKey(p) {
  const abs = resolvePath(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Is `child` the same path as `parent`, or inside it? Case-folded on Windows. */
function isInside(child, parent) {
  const c = samePathKey(child);
  const p = samePathKey(parent);
  return c === p || c.startsWith(p + sep);
}

/** POSIX-form relative path, so a report reads identically on macOS and Windows. */
const posixRel = (from, to) => relative(from, to).split(/[\\/]/).join('/');

/** Is `p` a link (POSIX symlink or NTFS junction)? Non-throwing. */
function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Where a link points, resolved absolute. null when `p` is not a readable link. */
function linkTarget(p) {
  try {
    const raw = readlinkSync(p);
    return isAbsolute(raw) ? resolvePath(raw) : resolvePath(dirname(p), raw);
  } catch { return null; }
}

/** Directory entry count, or 0 for a path that is absent or unreadable. */
function entryCount(dir) {
  try { return readdirSync(dir).length; } catch { return 0; }
}

/**
 * Recursive file count and total byte size below `dir`.
 *
 * The verification the copy is checked against. Links are counted but never followed — a link
 * inside an artifacts tree is a pointer, and following it would both inflate the total and risk
 * a cycle.
 *
 * @param {string} dir
 * @returns {{files: number, bytes: number}}
 */
function measure(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (abs) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (entry.isSymbolicLink()) { files += 1; continue; }
      if (entry.isDirectory()) { walk(child); continue; }
      files += 1;
      try { bytes += statSync(child).size; } catch { /* raced away — counted, not sized */ }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Human byte size, for a report a person reads before approving an upload. */
function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * The artifacts base this invocation acts on, and a label naming it.
 *
 * `--project` / `--service` address a scope WITHOUT switching the active one: mapping a folder is
 * administration, and making the caller `project use` first would leave their session pointed
 * somewhere they did not ask to be. With neither flag the active scope's artifacts base is used,
 * which is the same answer `sidekicks scope artifacts-base` prints.
 *
 * @param {string} repoRoot
 * @param {Record<string, string|boolean>} flags
 * @returns {{base: string, label: string}}
 * @throws {SidekicksError}
 */
function resolveBase(repoRoot, flags) {
  const project = typeof flags.project === 'string' && flags.project !== '' ? flags.project : null;
  const service = typeof flags.service === 'string' && flags.service !== '' ? flags.service : null;

  if (!project) {
    if (service) {
      throw new SidekicksError(
        'artifacts map: --service needs --project — a service name alone does not name a scope',
        EXIT_VALIDATION
      );
    }
    const scope = resolveWorkingFolder(readSettings(repoRoot), repoRoot);
    const label = scope.serviceName
      ? `project '${scope.projectName}', service '${scope.serviceName}' (active scope)`
      : `project '${scope.projectName}' (active scope)`;
    return { base: scope.artifactsbase, label };
  }

  const projectPath = join(repoRoot, 'projects', project);
  if (!existsSync(projectPath)) {
    throw new SidekicksError(
      `artifacts map: no such project 'projects/${project}'`,
      EXIT_NOT_FOUND
    );
  }
  if (!service) return { base: projectPath, label: `project '${project}'` };

  // The service ROOT, never its src/ — the same split `scope artifacts-base` makes.
  const servicePath = join(projectPath, 'services', service);
  if (!existsSync(servicePath)) {
    throw new SidekicksError(
      `artifacts map: no such service 'projects/${project}/services/${service}'`,
      EXIT_NOT_FOUND
    );
  }
  return { base: servicePath, label: `project '${project}', service '${service}'` };
}

/**
 * The owning git repository of `artifactsDir`, and the directory's path relative to it.
 *
 * A project can be a submodule (`projects/shp-sk` is one here), so the repo that would lose a
 * tracked file — and the repo whose `info/exclude` must carry the link — is the NEAREST one, not
 * the outer workspace.
 *
 * The probe starts at the PARENT, never at the artifacts directory itself. Once mapped, that path
 * is a link pointing OUT of the repository, and `git rev-parse --show-toplevel` run with it as cwd
 * follows the link and answers about the cloud folder — which is not a repo, so the owner came
 * back null and `--unmap` silently left its exclude entry behind. The parent is always a real
 * directory inside the repo, and is walked further up only when the scope's base does not exist.
 *
 * @param {string} artifactsDir
 * @returns {{repo: string, rel: string}|null} null when nothing above it is a git working tree.
 */
function owningRepo(artifactsDir) {
  let probe = dirname(artifactsDir);
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
  const repo = topLevel(probe);
  if (!repo) return null;
  return { repo, rel: posixRel(repo, artifactsDir) };
}

// ---------------------------------------------------------------------------
// Copy + verify
// ---------------------------------------------------------------------------

/**
 * Copy `from` into `to`, then verify both ends agree on file count and total bytes.
 *
 * The verification is the whole point of doing this in two steps rather than one. A cloud mount
 * can accept writes and then fail to persist them (quota, a signed-out client, a paused sync),
 * and the caller only finds out when the source has already been deleted. Nothing is removed
 * until the two measurements match.
 *
 * @param {string} from
 * @param {string} to
 * @returns {{files: number, bytes: number}} the verified measurement
 * @throws {SidekicksError(EXIT_IO)} when the copy fails or the two ends disagree.
 */
function copyVerified(from, to) {
  const before = measure(from);
  try {
    // verbatimSymlinks: an artifacts tree may hold links; recreate them as links rather than
    // silently inlining whatever they point at (which can be another 800MB, or a cycle).
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: true });
  } catch (err) {
    throw new SidekicksError(
      `artifacts map: copy to '${to}' failed: ${err.message}\n` +
        'Nothing was removed — the source directory is untouched.',
      EXIT_IO
    );
  }
  const after = measure(to);
  if (after.files !== before.files || after.bytes !== before.bytes) {
    throw new SidekicksError(
      `artifacts map: copy verification FAILED — source has ${before.files} file(s) / ` +
        `${before.bytes} byte(s), destination has ${after.files} / ${after.bytes}.\n` +
        `Nothing was removed. The partial copy is at '${to}' — inspect or delete it, then retry. ` +
        'A cloud folder that accepts writes without persisting them (paused client, full quota) ' +
        'looks exactly like this.',
      EXIT_IO
    );
  }
  return after;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * `--check` — report the mapping state of one artifacts directory. Writes nothing.
 *
 * Exit code carries the answer for a script: 0 mapped, EXIT_VALIDATION not mapped (or mapped
 * somewhere other than a `<cloud-path>` the caller named).
 */
function runCheck(artifactsDir, wanted, label) {
  const linked = isLink(artifactsDir);
  const target = linked ? linkTarget(artifactsDir) : null;
  const exists = existsSync(artifactsDir);

  /** @type {{state: string, target: string|null, detail?: string}} */
  let out;
  if (!linked && !exists) out = { state: 'absent', target: null };
  else if (!linked) out = { state: 'local', target: null };
  else if (!target) out = { state: 'broken-link', target: null };
  else if (!existsSync(target)) {
    out = {
      state: 'target-missing',
      target,
      detail: 'the link resolves, but nothing is there — the cloud client is probably signed out or not running',
    };
  } else if (wanted && samePathKey(target) !== samePathKey(wanted)) {
    out = { state: 'mapped-elsewhere', target };
  } else out = { state: 'mapped', target };

  const ok = out.state === 'mapped';
  return { ...out, label, artifacts_dir: artifactsDir, exitCode: ok ? EXIT_OK : EXIT_VALIDATION };
}

/**
 * `--unmap` — restore a mapped artifacts directory to a real local one.
 *
 * Order matters and is chosen so no window exists where the artifacts path is absent: the cloud
 * copy is staged into a sibling temp directory FIRST, verified, and only then does the link come
 * out and the staged copy take its place by rename (same directory, so the rename is atomic and
 * cannot hit EXDEV). The cloud copy is left where it is.
 */
function runUnmap(artifactsDir, base) {
  if (!isLink(artifactsDir)) {
    throw new SidekicksError(
      `artifacts map --unmap: '${artifactsDir}' is not a mapped link — nothing to unmap`,
      EXIT_VALIDATION
    );
  }
  const target = linkTarget(artifactsDir);
  if (!target) {
    // A link nobody can read is still a link: remove it and say the content is gone.
    removeDirLink(artifactsDir);
    return { unmapped: true, target: null, restored: { files: 0, bytes: 0 }, broken: true };
  }
  if (!existsSync(target)) {
    throw new SidekicksError(
      `artifacts map --unmap: the link target '${target}' does not exist.\n` +
        'Refusing to unmap: removing the link now would leave an EMPTY artifacts directory and ' +
        'no way back to the content. If the cloud client is signed out, start it and retry; if ' +
        'the folder is genuinely gone, remove the link yourself.',
      EXIT_VALIDATION
    );
  }

  const staging = join(base, `.${ARTIFACTS_DIRNAME}.unmap-${randomBytes(4).toString('hex')}`);
  let restored;
  try {
    restored = copyVerified(target, staging);
  } catch (err) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }

  removeDirLink(artifactsDir);
  try {
    renameSync(staging, artifactsDir);
  } catch (err) {
    throw new SidekicksError(
      `artifacts map --unmap: restored the content to '${staging}' but could not move it into ` +
        `place at '${artifactsDir}': ${err.message}\nRename it yourself — the cloud copy at ` +
        `'${target}' is also still intact.`,
      EXIT_IO
    );
  }

  return { unmapped: true, target, restored, broken: false };
}

// ---------------------------------------------------------------------------
// Verb
// ---------------------------------------------------------------------------

/**
 * Execute the `artifacts map` verb.
 *
 * @param {{ repoRoot: string, argv: string[] }} ctx
 * @param {{ name: string|undefined, rest: string[], flags: object }} args
 * @returns {Promise<{ stdout: string, exitCode: number }>}
 * @throws {SidekicksError} on any failure — cli.mjs is the single error boundary.
 */
export async function run(ctx, args) {
  const { repoRoot } = ctx;
  const argv = (ctx && ctx.argv) || [];
  const flags = parseArtifactFlags(argv, BOOLEANS);

  // The dispatcher's positional list cannot be trusted for a verb taking valued flags: it runs
  // parseArgs with strict:false and declares only --help/--version/--verbose, so `--project shp-sk`
  // arrives as a stray positional. Re-derive the cloud path from argv, flag values excluded.
  const cloudArg = firstPositional(argv);

  const asJson = Boolean(flags.json);
  const checkOnly = Boolean(flags.check);
  const unmap = Boolean(flags.unmap);

  if (checkOnly && unmap) {
    throw new SidekicksError(
      'artifacts map: --check and --unmap are mutually exclusive',
      EXIT_VALIDATION
    );
  }

  const { base, label } = resolveBase(repoRoot, flags);
  const artifactsDir = join(base, ARTIFACTS_DIRNAME);

  // The path is derived from the scope, never taken from the caller — but assert the invariant
  // anyway, because everything below deletes and relinks whatever this resolves to.
  if (!isInside(artifactsDir, repoRoot)) {
    throw new SidekicksError(
      `artifacts map: resolved artifacts directory '${artifactsDir}' is outside the repository`,
      EXIT_VALIDATION
    );
  }

  const owner = owningRepo(artifactsDir);

  // ---- --unmap ------------------------------------------------------------
  if (unmap) {
    const result = runUnmap(artifactsDir, base);
    let excluded = 'skipped';
    if (owner) excluded = dropLocalExclude(owner.repo, owner.rel);

    if (asJson) {
      return {
        stdout: `${JSON.stringify({
          mode: 'unmap', scope: label, artifacts_dir: artifactsDir,
          was_mapped_to: result.target, restored: result.restored, exclude: excluded,
        }, null, 2)}\n`,
        exitCode: EXIT_OK,
      };
    }
    const lines = [`scope     : ${label}`, `artifacts : ${artifactsDir}`, ''];
    if (result.broken) {
      lines.push('Removed a BROKEN link — its target could not be read, so nothing was restored.');
    } else {
      lines.push(`Unmapped. Restored ${result.restored.files} file(s), ${humanBytes(result.restored.bytes)} from:`);
      lines.push(`  ${result.target}`);
      lines.push('');
      lines.push('The cloud copy was LEFT IN PLACE — delete it yourself once you are satisfied the');
      lines.push('local directory is complete.');
    }
    if (excluded === 'removed') {
      lines.push(`Dropped the local exclude for '${owner.rel}'; git can see this directory again.`);
    }
    return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
  }

  // ---- resolve the cloud path (required for map, optional for --check) ----
  let cloudPath = null;
  if (cloudArg) {
    if (!isAbsolute(cloudArg)) {
      throw new SidekicksError(
        `artifacts map: <cloud-path> must be absolute — got '${cloudArg}'. A cloud folder lives ` +
          'outside the repository, so a relative path is never what was meant.',
        EXIT_VALIDATION
      );
    }
    cloudPath = resolvePath(cloudArg);
  }

  // ---- --check ------------------------------------------------------------
  if (checkOnly) {
    const state = runCheck(artifactsDir, cloudPath, label);
    if (asJson) {
      const { exitCode, ...body } = state;
      return { stdout: `${JSON.stringify({ mode: 'check', ...body }, null, 2)}\n`, exitCode };
    }
    const lines = [
      `scope     : ${label}`,
      `artifacts : ${artifactsDir}`,
      `state     : ${state.state}`,
    ];
    if (state.target) lines.push(`target    : ${state.target}`);
    if (state.detail) lines.push(`note      : ${state.detail}`);
    return { stdout: `${lines.join('\n')}\n`, exitCode: state.exitCode };
  }

  if (!cloudPath) {
    throw new SidekicksError(
      'usage: sidekicks artifacts map <cloud-path> [--project <p>] [--service <svc>] [--yes]\n' +
        '       sidekicks artifacts map [<cloud-path>] --check\n' +
        '       sidekicks artifacts map --unmap',
      EXIT_VALIDATION
    );
  }

  // ---- cloud-path preconditions -------------------------------------------
  if (isInside(cloudPath, repoRoot)) {
    throw new SidekicksError(
      `artifacts map: <cloud-path> '${cloudPath}' is inside the repository. The point of the ` +
        'mapping is to put the bytes in a folder a cloud client syncs; a path in the repo is ' +
        'not one.',
      EXIT_VALIDATION
    );
  }

  const cloudParent = dirname(cloudPath);
  if (!existsSync(cloudParent)) {
    throw new SidekicksError(
      `artifacts map: the parent of <cloud-path> does not exist:\n  ${cloudParent}\n\n` +
        'Refusing to create it. A cloud folder is a MOUNT POINT — when the client is signed out ' +
        'or not running the whole path is simply absent, and creating it here would build an ' +
        'ordinary local directory that syncs nothing while looking exactly like success. Start ' +
        'the cloud client (or create the parent folder yourself) and retry.',
      EXIT_VALIDATION
    );
  }
  if (existsSync(cloudPath) && !statSync(cloudPath).isDirectory()) {
    throw new SidekicksError(
      `artifacts map: <cloud-path> '${cloudPath}' exists and is not a directory`,
      EXIT_VALIDATION
    );
  }

  // ---- current state of the artifacts directory ---------------------------
  if (isLink(artifactsDir)) {
    const current = linkTarget(artifactsDir);
    if (current && samePathKey(current) === samePathKey(cloudPath)) {
      const excluded = owner ? ensureLocalExclude(owner.repo, owner.rel) : 'skipped';
      if (asJson) {
        return {
          stdout: `${JSON.stringify({
            mode: 'map', state: 'already-mapped', scope: label,
            artifacts_dir: artifactsDir, target: cloudPath, exclude: excluded,
          }, null, 2)}\n`,
          exitCode: EXIT_OK,
        };
      }
      return {
        stdout:
          `scope     : ${label}\nartifacts : ${artifactsDir}\n\n` +
          `Already mapped to ${cloudPath} — nothing to do.\n`,
        exitCode: EXIT_OK,
      };
    }
    throw new SidekicksError(
      `artifacts map: '${artifactsDir}' is already mapped to a DIFFERENT target:\n` +
        `  ${current ?? '(unreadable)'}\n\n` +
        'Run `sidekicks artifacts map --unmap` first, then map it to the new path. Repointing ' +
        'the link in place would strand whatever is at the old target.',
      EXIT_VALIDATION
    );
  }

  // ---- gate 1: tracked files ----------------------------------------------
  if (owner) {
    const tracked = trackedUnder(owner.repo, owner.rel);
    if (tracked.length > 0) {
      const sample = tracked.slice(0, 5).map((f) => `  ${f}`).join('\n');
      throw new SidekicksError(
        `artifacts map: '${owner.rel}' holds ${tracked.length} git-TRACKED file(s) in ` +
          `${owner.repo}:\n${sample}${tracked.length > 5 ? `\n  … and ${tracked.length - 5} more` : ''}\n\n` +
          'Refusing to map. Moving these out of the tree and leaving a symlink deletes every one ' +
          'of them from the index — a deletion git reports only on the next `git status`, long ' +
          'after the move. Commit them elsewhere or untrack them first, then retry. This gate is ' +
          'not waivable with --yes.',
        EXIT_VALIDATION
      );
    }
  }

  const localExists = existsSync(artifactsDir);
  const localCount = localExists ? entryCount(artifactsDir) : 0;
  const cloudCount = existsSync(cloudPath) ? entryCount(cloudPath) : 0;

  // ---- gate 2: two populated directories ----------------------------------
  if (localCount > 0 && cloudCount > 0) {
    throw new SidekicksError(
      `artifacts map: both directories already hold content —\n` +
        `  local : ${artifactsDir} (${localCount} entr${localCount === 1 ? 'y' : 'ies'})\n` +
        `  cloud : ${cloudPath} (${cloudCount} entr${cloudCount === 1 ? 'y' : 'ies'})\n\n` +
        'Refusing to merge two artifact histories silently — a run folder that exists on both ' +
        'sides with different contents would be resolved by whichever copy landed last. Decide ' +
        'which one is authoritative, move or delete the other, then retry.',
      EXIT_VALIDATION
    );
  }

  // ---- gate 3: the upload is an outward action ----------------------------
  const moving = localCount > 0;
  if (moving && !flags.yes) {
    const { files, bytes } = measure(artifactsDir);
    throw new SidekicksError(
      `artifacts map: this publishes ${files} file(s) (${humanBytes(bytes)}) to a synced folder.\n\n` +
        `  from : ${artifactsDir}\n` +
        `  to   : ${cloudPath}\n\n` +
        'Everything under that path is uploaded to the cloud account that owns it, and a provider ' +
        'may retain or index it after a later delete. Artifact trees routinely carry run logs, ' +
        'captured query output and ticket content, so read the list before agreeing.\n' +
        'Re-run with --yes once you have. Reverse it with `artifacts map --unmap` (the local copy ' +
        'is removed only after a byte-for-byte verified copy lands at the destination).',
      EXIT_VALIDATION
    );
  }

  // ---- do it ---------------------------------------------------------------
  mkdirSync(cloudPath, { recursive: true });

  /** @type {{files: number, bytes: number}} */
  let moved = { files: 0, bytes: 0 };
  if (moving) {
    moved = copyVerified(artifactsDir, cloudPath);
    rmSync(artifactsDir, { recursive: true, force: true });
  } else if (localExists) {
    // An empty real directory — remove it so the link can take its place.
    rmSync(artifactsDir, { recursive: true, force: true });
  }

  createDirLink(cloudPath, artifactsDir);
  const excluded = owner ? ensureLocalExclude(owner.repo, owner.rel) : 'skipped';

  if (asJson) {
    return {
      stdout: `${JSON.stringify({
        mode: 'map', state: 'mapped', scope: label, artifacts_dir: artifactsDir,
        target: cloudPath, moved, exclude: excluded,
      }, null, 2)}\n`,
      exitCode: EXIT_OK,
    };
  }

  const lines = [`scope     : ${label}`, `artifacts : ${artifactsDir}`, ''];
  lines.push(`Mapped to ${cloudPath}`);
  if (moving) {
    lines.push(`Moved ${moved.files} file(s), ${humanBytes(moved.bytes)} — verified at the destination before the local copy was removed.`);
  } else {
    lines.push('The artifacts directory was empty, so nothing was moved.');
  }
  if (excluded === 'added') {
    lines.push(`Excluded '${owner.rel}' locally — the link target is a path on this machine, so it must never be committed.`);
  }
  lines.push('');
  lines.push('Every skill that resolves `scope artifacts-base` keeps writing to the same path; the');
  lines.push('bytes now land in the synced folder. Reverse it with `sidekicks artifacts map --unmap`.');

  return { stdout: `${lines.join('\n')}\n`, exitCode: EXIT_OK };
}

/**
 * The first positional after `artifacts map` in the raw argv, flag VALUES excluded.
 *
 * @param {string[]} argv
 * @returns {string|null}
 */
function firstPositional(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      if (body.includes('=') || BOOLEANS.includes(body)) continue;
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1; // consumed as this flag's value
      continue;
    }
    out.push(tok);
  }
  const idx = out.indexOf('artifacts');
  const tail = idx === -1 ? out : out.slice(idx + 2); // drop namespace + verb
  return tail.length > 0 ? tail[0] : null;
}
