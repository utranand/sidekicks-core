// Sidekicks core forge — drift. Zero runtime dependencies.
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
import { loadRequiredSkills, resolveSkill, skillVersion } from './select.mjs';
import { BRIDGE_DIRNAME, DELEGATES_DIRNAME, DELEGATE_MEMORY_DIR, DELEGATE_SURFACES, hashBuffer, hashDelegateSurface, hashFile, hashTree, nowBangkok, out, resolveDelegate, sameHashes } from './_shared.mjs';
import { copyTree, isDenied } from './surfaces.mjs';
import { delegateUnitRecord, skillUnitRecord } from './registry.mjs';

export const STATUS_ORDER = ["conflict", "missing-required", "ff", "local-only", "missing-source",
  "missing-runtime", "untracked", "up-to-date"];

export const STATUS_LABEL = {
  "up-to-date": "up to date",
  ff: "FF (clean, safe to patch)",
  conflict: "CONFLICT (both sides changed)",
  "local-only": "local-only (runtime edited, nothing upstream)",
  "missing-source": "MISSING IN SOURCE",
  "missing-runtime": "MISSING IN RUNTIME",
  "missing-required": "MISSING REQUIRED (floor skill absent — patch restores it)",
  untracked: "untracked",
};

export function classifySkills(repoRoot, runtimeRoot, manifest) {
  const rows = [];
  const tracked = new Set();
  const requiredFloor = new Set(loadRequiredSkills());

  for (const [unit, rec] of Object.entries(manifest.units ?? {})) {
    if (rec.kind !== "skill") continue;
    const name = unit.slice("skills/".length);
    tracked.add(name);

    const found = resolveSkill(repoRoot, name);
    const runtimeDir = join(runtimeRoot, '.agents', 'skills', name);
    const baseline = rec.files ?? {};

    if (!existsSync(join(runtimeDir, "SKILL.md"))) {
      // A REQUIRED skill that went missing is the same defect as one that never arrived, so it gets
      // the same status and the same no-force repair — not `missing-runtime`, which patch holds back
      // behind --force because it is normally an operator's deliberate deletion.
      rows.push(requiredFloor.has(name)
        ? { name, status: "missing-required", from: rec.version ?? null, to: null,
          detail: "required by every runtime and absent — 'patch' restores it without --force" }
        : { name, status: "missing-runtime", from: rec.version ?? null, to: null,
          detail: "recorded in the manifest but absent from the runtime" });
      continue;
    }
    const runtimeHashes = hashTree(runtimeDir);
    const localChanged = !sameHashes(runtimeHashes, baseline);

    if (!found) {
      rows.push({ name, status: "missing-source", from: rec.version ?? null, to: null,
        detail: `gone from the source repo${localChanged ? "; runtime copy also locally modified" : ""}` });
      continue;
    }
    // PROJECTED, not merely deny-filtered. The baseline was hashed from the runtime copy, which is
    // a projection of this folder: development evidence was left behind and the metadata that names
    // files was rewritten to match. Comparing against the raw source tree would therefore report
    // every excluded file AND `skill.manifest.yaml`/`VERSION.json` as "the source moved" — on every
    // run, for ever, since patch re-records from the runtime copy again. The same function that
    // produced the copy produces this side, which is the only way the two can agree.
    const sourceHashes = projectedSourceHashes(
      projectSkillRuntime(found.dir, {
        skill: name,
        deny: (rel) => isDenied(rel.split("/").join(sep)),
      }),
      found.dir,
      (abs, derivedContent) => (derivedContent === null ? hashFile(abs) : hashBuffer(derivedContent))
    );
    const sourceChanged = !sameHashes(sourceHashes, baseline);

    let status;
    if (sourceChanged && localChanged) status = "conflict";
    else if (sourceChanged) status = "ff";
    else if (localChanged) status = "local-only";
    else status = "up-to-date";

    rows.push({
      name, status, from: rec.version ?? null, to: skillVersion(found.dir),
      origin: found.origin,
      detail: describeFileDelta(baseline, sourceHashes, runtimeHashes, status),
    });
  }

  // Skills present in the runtime but never recorded — hand-added, outside the contract.
  const runtimeSkillsDir = join(runtimeRoot, '.agents', 'skills');
  if (existsSync(runtimeSkillsDir)) {
    for (const e of readdirSync(runtimeSkillsDir).sort()) {
      if (tracked.has(e)) continue;
      if (!existsSync(join(runtimeSkillsDir, e, "SKILL.md"))) continue;
      rows.push({ name: e, status: "untracked", from: null, to: null,
        detail: "in the runtime but not the manifest — added outside sk-publish-core" });
    }
  }

  // A REQUIRED skill the runtime does not carry at all. This is the one absence the manifest cannot
  // report on its own: a runtime forged before the floor existed never tracked these units, so there
  // is nothing for the loop above to classify. Reported here so `drift` exits non-zero and `patch`
  // has a row to act on. A required skill that IS tracked is already covered — it lands on
  // `missing-runtime` or a normal status like any other unit.
  for (const name of requiredFloor) {
    if (tracked.has(name)) continue;
    if (existsSync(join(runtimeSkillsDir, name, "SKILL.md"))) continue;
    const inSource = resolveSkill(repoRoot, name);
    rows.push({
      name,
      status: "missing-required",
      from: null,
      to: inSource ? skillVersion(inSource.dir) : null,
      detail: "required by every runtime and absent — 'patch' restores it without --force",
    });
  }

  rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

export function classifyDelegates(repoRoot, runtimeRoot, manifest) {
  const rows = [];
  const tracked = new Set();
  const runtimeDir = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME);

  for (const [unit, rec] of Object.entries(manifest.units ?? {})) {
    if (rec.kind !== "agent") continue;
    const name = unit.slice("agents/".length);
    tracked.add(name);

    const includeMemory = Boolean(rec.include_memory);
    const found = resolveDelegate(repoRoot, name);
    const dir = join(runtimeDir, name);
    const baseline = rec.files ?? {};

    if (!existsSync(join(dir, "agent.yaml"))) {
      rows.push({ name, status: "missing-runtime", from: null, to: null,
        detail: "recorded in the manifest but absent from the runtime" });
      continue;
    }
    const runtimeHashes = hashDelegateSurface(dir, includeMemory);
    const localChanged = !sameHashes(runtimeHashes, baseline);

    if (!found) {
      rows.push({ name, status: "missing-source", from: null, to: null,
        detail: `gone from the source repo${localChanged ? "; runtime copy also locally modified" : ""}` });
      continue;
    }
    const sourceHashes = hashDelegateSurface(found.dir, includeMemory);
    const sourceChanged = !sameHashes(sourceHashes, baseline);

    let status;
    if (sourceChanged && localChanged) status = "conflict";
    else if (sourceChanged) status = "ff";
    else if (localChanged) status = "local-only";
    else status = "up-to-date";

    const delta = describeFileDelta(baseline, sourceHashes, runtimeHashes, status);
    rows.push({
      name, status, from: null, to: null,
      detail: [delta, includeMemory ? "memory tracked" : "charter+routines only"].filter(Boolean).join("; "),
    });
  }

  if (existsSync(runtimeDir)) {
    for (const e of readdirSync(runtimeDir).sort()) {
      if (tracked.has(e) || e === BRIDGE_DIRNAME) continue;
      if (!existsSync(join(runtimeDir, e, "agent.yaml"))) continue;
      rows.push({ name: e, status: "untracked", from: null, to: null,
        detail: "in the runtime but not the manifest — created there, outside sk-publish-core" });
    }
  }

  rows.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

export function describeFileDelta(baseline, source, runtime, status) {
  const diff = (a, b) => ({
    added: Object.keys(b).filter((k) => !(k in a)),
    removed: Object.keys(a).filter((k) => !(k in b)),
    changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]),
  });
  const parts = [];
  if (status === "ff" || status === "conflict") {
    const d = diff(baseline, source);
    parts.push(`source +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
  }
  if (status === "local-only" || status === "conflict") {
    const d = diff(baseline, runtime);
    parts.push(`runtime +${d.added.length} ~${d.changed.length} -${d.removed.length}`);
    const touched = [...d.changed, ...d.added].slice(0, 4);
    if (touched.length) parts.push(`local edits: ${touched.join(", ")}`);
  }
  return parts.join("; ");
}

export const inheritRunBaseCache = new Map();

export function inheritRunBase(runtimeRoot) {
  if (inheritRunBaseCache.has(runtimeRoot)) return inheritRunBaseCache.get(runtimeRoot);
  const fallback = join(runtimeRoot, "artifacts", "runs", "inherit");
  const cli = join(runtimeRoot, "bin", "sidekicks");
  let base = fallback;
  if (existsSync(cli)) {
    const r = spawnSync(process.execPath, [cli, "scope", "run-base", "sk-publish-core"],
      { cwd: runtimeRoot, encoding: "utf8" });
    const resolved = (r.stdout || "").trim();
    if (r.status === 0 && resolved) base = isAbsolute(resolved) ? resolved : join(runtimeRoot, resolved);
  }
  inheritRunBaseCache.set(runtimeRoot, base);
  return base;
}

export function backupSkill(runtimeRoot, name, stamp) {
  const src = join(runtimeRoot, '.agents', 'skills', name);
  if (!existsSync(src)) return null;
  const dst = join(inheritRunBase(runtimeRoot), "backups", stamp, name);
  copyTree(src, dst);
  return relative(runtimeRoot, dst).split(sep).join("/");   // runtime-relative, portable
}

export function applyPatch(repoRoot, runtimeRoot, manifest, rows, { force, only, sourceCommit }) {
  const stamp = nowBangkok().replace(/[:+]/g, "-");
  const applied = [];
  const refused = [];

  for (const row of rows) {
    if (only && !only.includes(row.name)) continue;
    if (row.status === "up-to-date") continue;

    const forceable = row.status === "conflict" || row.status === "local-only" || row.status === "missing-runtime";
    // `missing-required` patches like a clean fast-forward, deliberately without --force: there is no
    // runtime-side work to destroy (the folder is not there) and the floor is not the operator's to
    // opt out of, so demanding --force would only stand between a broken runtime and its repair.
    if (!(row.status === "ff" || row.status === "missing-required" || (force && forceable))) {
      refused.push(row);
      continue;
    }

    const found = resolveSkill(repoRoot, row.name);
    if (!found) { refused.push({ ...row, detail: "no source to patch from" }); continue; }

    // Anything with runtime-side edits is preserved before being overwritten.
    const backup = (row.status === "conflict" || row.status === "local-only")
      ? backupSkill(runtimeRoot, row.name, stamp) : null;

    const dst = join(runtimeRoot, '.agents', 'skills', row.name);
    rmSync(dst, { recursive: true, force: true });
    copyTree(found.dir, dst);
    const previousReasons = manifest.units[`skills/${row.name}`]?.selection_reasons;
    manifest.units[`skills/${row.name}`] = skillUnitRecord(repoRoot, found, dst, sourceCommit);
    if (previousReasons?.length) {
      manifest.units[`skills/${row.name}`].selection_reasons = [...previousReasons];
    }
    applied.push({ ...row, backup });
  }
  return { applied, refused };
}

export function backupDelegate(runtimeRoot, name, stamp, includeMemory) {
  const src = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, name);
  if (!existsSync(src)) return null;
  const dst = join(inheritRunBase(runtimeRoot), "backups", stamp, "agents", name);
  const surfaces = includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES;
  for (const rel of surfaces) {
    if (existsSync(join(src, rel))) copyTree(join(src, rel), join(dst, rel));
  }
  return relative(runtimeRoot, dst).split(sep).join("/");   // runtime-relative, portable
}

export function applyDelegatePatch(repoRoot, runtimeRoot, manifest, rows, { force, only, sourceCommit }) {
  const stamp = nowBangkok().replace(/[:+]/g, "-");
  const applied = [];
  const refused = [];

  for (const row of rows) {
    if (only && !only.includes(row.name)) continue;
    if (row.status === "up-to-date") continue;

    const forceable = row.status === "conflict" || row.status === "local-only" || row.status === "missing-runtime";
    if (!(row.status === "ff" || (force && forceable))) { refused.push(row); continue; }

    const found = resolveDelegate(repoRoot, row.name);
    if (!found) { refused.push({ ...row, detail: "no source to patch from" }); continue; }

    const rec = manifest.units[`agents/${row.name}`] ?? {};
    const includeMemory = Boolean(rec.include_memory);
    const backup = (row.status === "conflict" || row.status === "local-only")
      ? backupDelegate(runtimeRoot, row.name, stamp, includeMemory) : null;

    const dst = join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, row.name);
    for (const rel of (includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES)) {
      const src = join(found.dir, rel);
      rmSync(join(dst, rel), { recursive: true, force: true });
      if (existsSync(src)) copyTree(src, join(dst, rel));
    }
    manifest.units[`agents/${row.name}`] = delegateUnitRecord(repoRoot, found, dst, sourceCommit, includeMemory);
    applied.push({ ...row, backup });
  }
  return { applied, refused };
}

export function printDriftTable(ctx, rows) {
  if (!rows.length) { out(ctx, "  (no skills tracked)"); return; }
  const w = Math.max(...rows.map((r) => r.name.length), 4);
  for (const r of rows) {
    const ver = r.from && r.to && r.from !== r.to ? `${r.from} -> ${r.to}` : (r.from ?? r.to ?? "-");
    out(ctx, `  ${r.name.padEnd(w)}  ${String(ver).padEnd(16)}  ${STATUS_LABEL[r.status]}${r.detail ? `  [${r.detail}]` : ""}`);
  }
}

export function summarize(rows) {
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(", ");
}
