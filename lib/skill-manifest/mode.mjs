// lib/skill-package/mode.mjs
// Deciding whether one file is EXECUTABLE, on a platform that may not be able to tell you.
//
// WHY THIS EXISTS. `fsx.execAwareMode()` answers the question from the source `stat`, which is
// correct on the way OUT of this repo — the local filesystem is authoritative about a file it
// holds. It is wrong on the way IN. Windows/NTFS has no execute bit at all: libuv reports one only
// for `.exe/.cmd/.bat/.com`, and `chmodSync` there succeeds while doing nothing
// (docs/guide/pending-update/windows-compatibility.md §6). So a skill that passes through ANY
// Windows checkout loses `+x` on every `.sh` and `.py` it carries, silently, and nothing
// downstream can notice: the manifest `bundle{}` records content hashes only, so `skill verify`
// and `skill doctor` are structurally blind to the loss (INC-2026-09-05-02, X-3, and before it
// memory `skill-export-drops-file-mode`, where five non-executable scripts were published through
// a full export run in which every gate passed).
//
// The answer is to stop deriving executability from whichever filesystem the bytes are sitting on
// and read it from the most authoritative signal available, in this order:
//
//   1. A recorded `modes{}` in the incoming manifest. Someone already decided this, on a machine
//      that could tell. Nothing observed later outranks a recorded decision.
//   2. The source repository's git index, for tracked files only. `git ls-files -s` reports
//      100755 vs 100644 independently of the working tree, even when it is on NTFS. An untracked
//      file has no index mode, so the next signal must decide it.
//   3. The source `stat`. Right on POSIX, uninformative (never executable) on Windows.
//   4. A `#!` shebang. A file that names an interpreter was meant to be run. Weakest of the four
//      and used only when the three above said nothing, because it is an inference about intent
//      rather than an observation.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** The two modes this framework ever writes. A raw mode copy drags umask and platform bits along. */
export const MODE_EXEC = 0o755;
export const MODE_PLAIN = 0o644;

/** `755`/`644` as the manifest records them, from a numeric file mode. */
export function modeDigits(mode) {
  return (mode & 0o111) ? 755 : 644;
}

/** A manifest `modes{}` digit back to a real file mode. */
export function modeFromDigits(digits) {
  return Number(digits) === 755 ? MODE_EXEC : MODE_PLAIN;
}

/**
 * Does this file begin with `#!`?
 *
 * Reads two bytes, not the file: a skill may carry a multi-megabyte asset and this runs per file.
 *
 * @param {string} abs
 * @returns {boolean}
 */
export function hasShebang(abs) {
  let fd = null;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Every tracked regular file's mode, skill-folder-relative and POSIX. An absent path is unknown,
 * not plain: ignored or untracked staging files still have a meaningful POSIX stat.
 *
 * Returns null when the source is not a git worktree or git is unavailable. An empty map means
 * Git was asked but tracks no regular files in this skill folder.
 *
 * One spawn per skill folder, not per file. `shell: false`, so a path with a space or a shell
 * metacharacter is an argument rather than syntax.
 *
 * @param {string} skillDir - absolute
 * @returns {Map<string, number>|null} MODE_EXEC or MODE_PLAIN for each tracked regular file
 */
export function gitExecPaths(skillDir) {
  const r = spawnSync('git', ['-C', skillDir, 'ls-files', '-s', '-z', '--', '.'], {
    encoding: 'utf8', shell: false,
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  const out = new Map();
  for (const line of r.stdout.split('\0')) {
    if (!line) continue;
    // `-z` leaves special characters unquoted. The path is relative to -C because of `-- .`.
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const mode = line.slice(0, 6);
    const stage = line.slice(line.lastIndexOf(' ', tab) + 1, tab);
    if (stage !== '0') continue; // An unmerged index has no authoritative mode yet.
    if (mode === '100755') out.set(line.slice(tab + 1), MODE_EXEC);
    else if (mode === '100644') out.set(line.slice(tab + 1), MODE_PLAIN);
  }
  return out;
}

/**
 * The mode one incoming file should land with.
 *
 * @param {string} abs - the source file
 * @param {object} [ctx]
 * @param {Record<string, number>} [ctx.recorded] - the incoming manifest's `modes{}`
 * @param {Map<string, number>|null} [ctx.gitExec] - tracked regular-file modes from gitExecPaths()
 * @param {string} [ctx.rel] - the file's skill-relative POSIX path, for the two lookups above
 * @param {boolean} [ctx.allowShebang=true] - consult step 4 at all; see recordModes()
 * @returns {number} MODE_EXEC or MODE_PLAIN
 */
export function resolveSourceMode(abs, ctx = {}) {
  const rel = ctx.rel;
  // 1. A recorded decision outranks anything observed now.
  if (rel && ctx.recorded && Object.prototype.hasOwnProperty.call(ctx.recorded, rel)) {
    return modeFromDigits(ctx.recorded[rel]);
  }
  // 2. The source's git index is platform-independent, but only authoritative for paths it
  //    tracks. A missing entry must fall through, especially for ignored staging directories.
  if (rel && ctx.gitExec?.has(rel)) return ctx.gitExec.get(rel);
  // 3. The local stat. Authoritative on POSIX; always says "not executable" on Windows.
  let statSaidExec = null;
  try {
    statSaidExec = (statSync(abs).mode & 0o111) !== 0;
  } catch { /* unreadable; fall through */ }
  if (statSaidExec) return MODE_EXEC;
  // 4. Intent, when nothing OBSERVED it. Deliberately last, and skippable — see recordModes().
  if (ctx.allowShebang === false) return MODE_PLAIN;
  return hasShebang(abs) ? MODE_EXEC : MODE_PLAIN;
}

/**
 * The `modes{}` block for one skill folder: only the paths that are executable.
 *
 * NO SHEBANG INFERENCE WHERE THE FILESYSTEM CAN ANSWER. Recording is not the same job as copying.
 * When a copy arrives from somewhere the mode is unknowable, guessing from `#!` is better than
 * losing the bit. But this writes the baseline `mode-drift` is graded against, and on POSIX the
 * local stat IS the truth — so inferring here would make a deliberate `chmod -x` unrecordable: the
 * re-record would put 755 straight back, `mode-drift` would fire for ever, and `skill doctor`'s own
 * advice ("re-record if it is deliberately no longer executable") would be a lie. The inference is
 * therefore allowed only where nothing else can answer: Windows, where NTFS has no bit to read and
 * git has already had its say above.
 *
 * @param {string} skillDir - absolute
 * @param {Array<{rel: string, abs: string}>} files
 * @returns {Record<string, number>} possibly empty
 */
export function recordModes(skillDir, files) {
  const gitExec = gitExecPaths(skillDir);
  const allowShebang = process.platform === 'win32';
  const out = {};
  for (const f of files) {
    const mode = resolveSourceMode(f.abs, { rel: f.rel, gitExec, allowShebang });
    if (mode === MODE_EXEC) out[f.rel] = 755;
  }
  return out;
}
