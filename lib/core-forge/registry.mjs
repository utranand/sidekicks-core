// Sidekicks core forge — registry. Zero runtime dependencies.
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync,
  statSync, lstatSync, realpathSync, readlinkSync, rmSync, symlinkSync, chmodSync,
  renameSync, openSync, closeSync,
} from "node:fs";
import { join, dirname, relative, resolve, basename, sep, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { configurationInventory } from "../core-lifecycle/config-templates.mjs";
import { resolveFrameworkPreset } from "../skill-package/framework-preset.mjs";
import {
  projectSkillRuntime,
  projectedSourceHashes,
  RUNTIME_EXCLUDED_DIRS,
} from "../skill-package/runtime-projection.mjs";
import { BRIDGE_DIRNAME, DELEGATES_DIRNAME, MANIFEST_REL, SCHEMA, die, displayPath, hashDelegateSurface, hashTree, mkdirp, nowBangkok, out } from './_shared.mjs';
import { skillVersion } from './select.mjs';

export const REGISTRY_REL = join("artifacts", "runs", "_adhoc", "core-forge", "runtimes.json");

export const REGISTRY_LOCK_RETRIES = 100;

export const REGISTRY_LOCK_SLEEP_MS = 20;

export const REGISTRY_LOCK_STALE_MS = 10_000;

export const CORRUPT_KEEP = 3;

export function registryPath(repoRoot) {
  const override = process.env.SIDEKICKS_CORE_FORGE_REGISTRY || process.env.SIDEKICKS_INHERIT_REGISTRY;
  if (override) return isAbsolute(override) ? override : resolve(process.cwd(), override);
  return join(repoRoot, REGISTRY_REL);
}

export function registryNotice(ctx, message) {
  try { ctx.warn(`NOTICE: inherit registry — ${message}\n`); } catch { /* ignore */ }
}

export function registrySleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best-effort */ }
}

export function quarantineCorruptRegistry(ctx, p) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const kept = join(dirname(p), `runtimes.corrupt-${stamp}.json`);
  try {
    renameSync(p, kept);
    registryNotice(ctx, `could not parse '${p}'; preserved as '${basename(kept)}' and starting a new registry`);
  } catch (err) {
    registryNotice(ctx, `could not parse '${p}' and could not preserve it (${err.code || err.message})`);
    return;
  }
  // Keep the newest few so a repeatedly-broken registry cannot fill the artifacts tree.
  try {
    const olds = readdirSync(dirname(p))
      .filter((f) => /^runtimes\.corrupt-.*\.json$/.test(f))
      .sort()
      .reverse()
      .slice(CORRUPT_KEEP);
    for (const f of olds) rmSync(join(dirname(p), f), { force: true });
  } catch { /* pruning is housekeeping, never a failure */ }
}

export function readRegistry(ctx, repoRoot, { quarantine = false } = {}) {
  let p = registryPath(repoRoot);
  const legacy = join(repoRoot, 'artifacts', 'runs', 'inherit', 'runtimes.json');
  // Read old registrations until the first mutation writes the merged map at the new anchor.
  // Never quarantine or write the historical run tree.
  if (!existsSync(p) && !process.env.SIDEKICKS_CORE_FORGE_REGISTRY && !process.env.SIDEKICKS_INHERIT_REGISTRY && existsSync(legacy)) {
    p = legacy;
    quarantine = false;
  }
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed.runtimes === "object" ? parsed.runtimes : {};
  } catch {
    // A corrupt registry must never block a run — but it must never be silently discarded
    // either. Read-only callers just warn; only a mutation (under the lock) moves it aside.
    if (quarantine) quarantineCorruptRegistry(ctx, p);
    else registryNotice(ctx, `could not parse '${p}' — treating it as empty for this read only`);
    return {};
  }
}

export function writeRegistry(repoRoot, runtimes) {
  const p = registryPath(repoRoot);
  mkdirp(dirname(p));
  const body = `${JSON.stringify({
    schema: SCHEMA,
    comment: "Where each inherited runtime lives. Paths are repo-root-relative (portable-paths rule).",
    runtimes,
  }, null, 2)}\n`;
  const tmp = join(dirname(p), `.runtimes-tmp-${process.pid}-${randomBytes(6).toString("hex")}.json`);
  try {
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, p);   // atomic replace on POSIX and on Windows (MoveFileEx REPLACE_EXISTING)
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export function mutateRegistry(ctx, repoRoot, fn) {
  const lockPath = `${registryPath(repoRoot)}.lock`;
  mkdirp(dirname(lockPath));
  let fd = null;
  for (let attempt = 0; attempt <= REGISTRY_LOCK_RETRIES && fd === null; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") {
        registryNotice(ctx, `cannot create the lock (${err.code || err.message}) — proceeding unlocked`);
        break;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch { /* it vanished under us — retry */ }
      if (attempt === REGISTRY_LOCK_RETRIES) {
        registryNotice(ctx, "another process has held the lock for over 2s — proceeding unlocked");
        break;
      }
      registrySleep(REGISTRY_LOCK_SLEEP_MS);
    }
  }
  try {
    // Re-read INSIDE the lock: a snapshot taken before acquiring it is exactly the stale read
    // that loses another process's entry. Quarantine only when the lock was actually acquired
    // (see quarantineCorruptRegistry) — unlocked, a warning is the honest ceiling.
    const runtimes = readRegistry(ctx, repoRoot, { quarantine: fd !== null });
    const changed = fn(runtimes);
    if (changed) writeRegistry(repoRoot, runtimes);
    return changed;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { rmSync(lockPath, { force: true }); } catch { /* stale-reclaim covers a failed unlink */ }
    }
  }
}

export function registerRuntime(ctx, repoRoot, name, dir) {
  mutateRegistry(ctx, repoRoot, (runtimes) => {
    runtimes[name] = {
      path_rel: relative(repoRoot, dir).split(sep).join("/"),
      outside_repo: !isInsideRepo(repoRoot, dir),
      registered_at: nowBangkok(),
    };
    return true;
  });
}

export function forgetRuntime(ctx, repoRoot, name) {
  return mutateRegistry(ctx, repoRoot, (runtimes) => {
    if (!(name in runtimes)) return false;
    delete runtimes[name];
    return true;
  });
}

export function lookupRuntime(ctx, repoRoot, name) {
  const rec = readRegistry(ctx, repoRoot)[name];
  if (!rec?.path_rel) return null;
  return resolve(repoRoot, rec.path_rel);
}

export function isInsideRepo(repoRoot, dir) {
  const rel = relative(repoRoot, dir);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isInRuntimesDir(repoRoot, dir) {
  const rel = relative(join(repoRoot, "runtimes"), dir);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

export function manifestPath(runtimeRoot) { return join(runtimeRoot, MANIFEST_REL); }

export function readManifest(runtimeRoot) {
  const p = manifestPath(runtimeRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) {
    die(`runtime manifest is unreadable (${p}): ${e.message}`, 3);
  }
}

export function writeManifest(runtimeRoot, m) {
  mkdirp(dirname(manifestPath(runtimeRoot)));
  writeFileSync(manifestPath(runtimeRoot), `${JSON.stringify(m, null, 2)}\n`, "utf8");
}

export function requireManifest(runtimeRoot, name) {
  const m = readManifest(runtimeRoot);
  if (!m) die(`no ${MANIFEST_REL} in ${runtimeRoot} — '${name}' is not an inherited runtime (run 'create' first)`, 3);
  return m;
}

export function adoptIfTargeted(ctx, repoRoot, name, dir, resolvedFrom, { quiet = false } = {}) {
  if (resolvedFrom !== "flag") return;
  const known = lookupRuntime(ctx, repoRoot, name);
  if (known && resolve(known) === resolve(dir)) return;   // already registered at this location
  registerRuntime(ctx, repoRoot, name, dir);
  if (quiet) return;
  out(ctx, `registry: '${name}' now points at ${displayPath(repoRoot, dir)} — later verbs need only --name`);
  out(ctx, "");
}

export function skillUnitRecord(repoRoot, found, runtimeSkillDir, sourceCommit) {
  return {
    kind: "skill",
    origin: found.origin,
    version: skillVersion(found.dir),
    source_path: relative(repoRoot, found.dir).split(sep).join("/"),   // repo-relative, portable
    source_commit: sourceCommit,
    inherited_at: nowBangkok(),
    files: hashTree(runtimeSkillDir),
  };
}

export function trackedSkills(manifest) {
  return Object.keys(manifest.units ?? {})
    .filter((k) => k.startsWith("skills/"))
    .map((k) => k.slice("skills/".length));
}

export function delegateUnitRecord(repoRoot, found, runtimeAgentDir, sourceCommit, includeMemory) {
  return {
    kind: "agent",
    source_path: relative(repoRoot, found.dir).split(sep).join("/"),   // repo-relative, portable
    source_commit: sourceCommit,
    inherited_at: nowBangkok(),
    include_memory: Boolean(includeMemory),
    files: hashDelegateSurface(runtimeAgentDir, includeMemory),
  };
}

export function trackedDelegates(manifest) {
  return Object.keys(manifest.units ?? {})
    .filter((k) => k.startsWith("agents/"))
    .map((k) => k.slice("agents/".length));
}

export function presentDelegates(runtimeRoot, manifest) {
  const present = new Set(trackedDelegates(manifest));
  const dir = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME);
  if (existsSync(dir)) {
    for (const e of readdirSync(dir).sort()) {
      if (e !== BRIDGE_DIRNAME && existsSync(join(dir, e, "agent.yaml"))) present.add(e);
    }
  }
  return present;
}
