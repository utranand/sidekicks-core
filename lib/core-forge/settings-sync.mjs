// Sidekicks core forge — settings-sync. Zero runtime dependencies.
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
import { ASSETS, CORE_SETTINGS_SHIPPED_OFF, RUNTIME_TEST_COMMAND, mkdirp } from './_shared.mjs';
import { CORE_HOOKS } from '../framework-settings/core-registry.mjs';
import { skillClosure } from '../skill-package/closure.mjs';

/** Carrying a script does not activate it: only an installed owner may wire it. */
export function projectHostWiring(repoRoot, rel, text, skills, plugins = []) {
  const selected = new Set(skills);
  const allowed = new Set(CORE_HOOKS.filter(h => !h.owners.length || h.owners.some(o => selected.has(o))).map(h => h.script));
  for (const h of skillClosure(repoRoot, skills).framework_hooks) {
    if (h.script && h.needed_by?.some(o => selected.has(o))) allowed.add(h.script);
  }
  const permitted = command => (String(command).match(HOOK_SCRIPT_RE) ?? [])
    .every(p => allowed.has(p.replaceAll('\\', '/')) && existsSync(join(repoRoot, ...p.replaceAll('\\','/').split('/'))));
  if (rel.endsWith('.json')) {
    const config = JSON.parse(text);
    for (const [event, groups] of Object.entries(config.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      config.hooks[event] = groups.map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => permitted(h.command)) })).filter(g => g.hooks.length);
      if (!config.hooks[event].length) delete config.hooks[event];
    }
    const markets = new Set(plugins.map(p=>p.split('@')[1]));
    for (const [key, keep] of [['enabledPlugins',new Set(plugins)],['extraKnownMarketplaces',markets]]) {
      if (!config[key]) continue;
      for (const id of Object.keys(config[key])) if (!keep.has(id)) delete config[key][id];
      if (!Object.keys(config[key]).length) delete config[key];
    }
    return JSON.stringify(config,null,2)+'\n';
  }
  // Preserve all unrelated TOML, including tables following the hook block. A table
  // is bounded by ANY next header, not just the next hook header.
  const segments=text.replace(/\r\n?/g,'\n').split(/(?=^\s*\[)/m);
  const kept=segments.filter(s=>!/^\s*\[\[hooks\.[\w-]+\.hooks\]\]/.test(s) || permitted(s));
  return kept.filter(s=>{
    const event=/^\s*\[\[hooks\.([\w-]+)\]\]/.exec(s)?.[1];
    return !event || kept.some(k=>k.startsWith('[[hooks.'+event+'.hooks]]'));
  }).join('').replace(/\n{3,}/g,'\n\n');
}

export function runtimeToggleableEntries(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return null;
  const r = spawnSync(process.execPath, [cli, "framework", "list", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) return null;
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((e) => !e.floor)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      enabled: e.enabled !== false,
      owner_absent: Boolean(e.owner_absent),
    }));
}

export function normalizeRuntimeEnableMap(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  const entries = runtimeToggleableEntries(runtimeRoot);
  if (!entries) return { on: [], off: [], ok: false };

  const on = [];
  const off = [];
  for (const entry of entries) {
    const declared = CORE_SETTINGS_SHIPPED_OFF[entry.id];
    const reason = declared
      ? declared.reason
      : (entry.kind === "hook" && entry.owner_absent ? "owner skill did not travel" : null);
    const verb = reason ? "disable" : "enable";
    const r = spawnSync(process.execPath, [cli, "framework", verb, entry.id],
      { cwd: runtimeRoot, encoding: "utf8" });
    if (r.status !== 0) continue;
    if (reason) off.push({ id: entry.id, reason });
    else on.push(entry.id);
  }
  return { on, off, ok: true };
}

export function syncRuntimeFramework(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return { ok: false, note: "runtime has no bin/sidekicks" };
  const r = spawnSync(process.execPath, [cli, "framework", "sync", "--prune", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) {
    return { ok: false, note: `framework sync failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}` };
  }
  let payload;
  try { payload = JSON.parse(r.stdout); } catch { payload = null; }
  // The normalization runs whether or not the sync payload parsed: it reads the runtime's registry
  // itself, and shipping the source's toggles is the defect it exists to prevent.
  const norm = normalizeRuntimeEnableMap(runtimeRoot);
  if (!payload) return { ok: true, note: "framework enable map synced and normalized to declared defaults" };
  const bits = [`${payload.listed}/${payload.toggleable} entries listed`];
  if (payload.added?.length) bits.push(`+${payload.added.length} added`);
  if (payload.pruned?.length) bits.push(`-${payload.pruned.length} pruned (owner skill did not travel)`);
  if (norm.ok) {
    bits.push(`${norm.on.length} enabled by default`);
    if (norm.off.length) bits.push(`${norm.off.length} shipped off (declared): ${norm.off.map((o) => o.id).join(", ")}`);
  } else {
    bits.push("NOT normalized — the runtime's framework registry could not be read");
  }
  return { ok: true, note: `framework enable map: ${bits.join(", ")}` };
}

export function syncRuntimeConfig(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return { ok: false, note: "runtime has no bin/sidekicks" };
  const r = spawnSync(process.execPath, [cli, "config", "sync", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) {
    return { ok: false, note: `config sync failed: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}` };
  }
  let payload;
  try { payload = JSON.parse(r.stdout); } catch { payload = null; }
  if (!payload) return { ok: true, note: "configuration templates synced" };
  const scope = payload.scopes?.find((s) => s.base === ".sidekicks") ?? payload.scopes?.[0];
  const families = scope?.written?.length ?? 0;
  const blocks = scope?.items?.filter((i) => i.action === "add").length ?? 0;
  const secrets = scope?.secrets?.length ?? 0;
  const bits = [`${blocks} block(s) documented in ${families} family file(s)`];
  if (secrets) bits.push(`${secrets} inert credential skeleton(s) created (git-ignored)`);

  // Then retire what the copied family files document and NOTHING in this runtime declares.
  // `config sync` is additive — it seeds the blocks the carried skills own but never removes the
  // ones a left-behind skill contributed, so a forged core shipped `run_notify`, `figma`, `teleport`
  // and a nine-key `agent_skill_store` that resolve to nothing at all (INC-2026-09-06-06 B-2), and
  // `config sync --dry-run` inside the core reported each as "the owning skill ships no
  // config.defaults.yaml". --prune-only is the existing verb for exactly that; run it here rather
  // than reimplementing the family registry in this skill.
  const pruned = spawnSync(process.execPath, [cli, "config", "sync", "--scope", "all", "--prune-only", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (pruned.status === 0) {
    let pp;
    try { pp = JSON.parse(pruned.stdout); } catch { pp = null; }
    // `--prune-only` deliberately empties `items[]` (it seeds nothing), so what was actually
    // retired is reported in `scopes[].pruned` — reading `items` here would always find zero.
    const dropped = (pp?.scopes ?? []).flatMap((sc) => sc.pruned ?? []);
    if (dropped.length) bits.push(`${dropped.length} orphan block(s) retired (no skill here declares them)`);
  } else {
    bits.push("orphan-block prune did NOT run — `config sync --prune-only` failed in the runtime");
  }
  return { ok: true, note: `configuration templates: ${bits.join(", ")}` };
}

export function runtimeCoreRules(runtimeRoot) {
  const cli = join(runtimeRoot, "bin", "sidekicks");
  if (!existsSync(cli)) return null;
  const r = spawnSync(process.execPath, [cli, "framework", "list", "--json"],
    { cwd: runtimeRoot, encoding: "utf8" });
  if (r.status !== 0) return null;
  let rows;
  try { rows = JSON.parse(r.stdout); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((e) => e.registry_source === "core" && e.kind !== "hook")
    .map((e) => ({
      id: e.id,
      body_marker: e.body_marker ?? null,
      floor: Boolean(e.floor),
      enabled: e.enabled !== false,
    }));
}

export function writeRuntimeScaffold(runtimeRoot, name) {
  // Root scope, no active project — a minimal runtime has no projects/ tree.
  const settings = join(runtimeRoot, ".sidekicks", "settings.json");
  mkdirp(dirname(settings));
  if (!existsSync(settings)) {
    writeFileSync(settings, `${JSON.stringify({ active_project: null, active_service: null }, null, 2)}\n`, "utf8");
  }
  // The memory store starts EMPTY on purpose — never inherit the source repo's memory.
  mkdirp(join(runtimeRoot, ".sidekicks", "memory"));
  const idx = join(runtimeRoot, ".sidekicks", "memory", "MEMORY.md");
  if (!existsSync(idx)) {
    writeFileSync(idx, `# Local memory — ${name}\n\nNo entries yet. Register decisions with \`sidekicks memory add\`.\n`, "utf8");
  }

  const gi = join(runtimeRoot, ".gitignore");
  if (!existsSync(gi)) copyFileSync(join(ASSETS, "runtime.gitignore"), gi);

  const pkg = join(runtimeRoot, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, `${JSON.stringify({
      name, version: "0.1.0", private: true, type: "module",
      engines: { node: ">=20" },
      scripts: { test: RUNTIME_TEST_COMMAND },
    }, null, 2)}\n`, "utf8");
  } else {
    // The test command is DERIVED, so it is repaired on every forge rather than left at whatever an
    // older engine wrote. A runtime forged before F-05 carries `node --test 'tests/**/*.test.mjs'`,
    // which on Node 22 discovers nothing and still exits 0 — the false-green this replaces. Only
    // that one key is rewritten; anything the operator added to package.json is left alone.
    try {
      const cur = JSON.parse(readFileSync(pkg, "utf8"));
      if (cur && typeof cur === "object" && cur.scripts?.test !== RUNTIME_TEST_COMMAND) {
        cur.scripts = { ...(cur.scripts || {}), test: RUNTIME_TEST_COMMAND };
        writeFileSync(pkg, `${JSON.stringify(cur, null, 2)}\n`, "utf8");
      }
    } catch { /* an unparseable package.json is the operator's to fix; never clobber it */ }
  }
}

export const HOOK_SCRIPT_RE = /(?:scripts|\.sidekicks[/\\]hooks)[/\\][\w.-]+\.(?:mjs|sh|py|js)/g;

export function pruneHooksJson(runtimeRoot, relConfig) {
  const p = join(runtimeRoot, ...relConfig.split("/"));
  if (!existsSync(p)) return [];
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
  const dropped = [];

  for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.filter((h) => {
        for (const ref of String(h.command ?? "").match(HOOK_SCRIPT_RE) ?? []) {
          const relPath = ref.replace(/\\/g, "/");
          if (!existsSync(join(runtimeRoot, ...relPath.split("/")))) {
            dropped.push(`${relConfig}: ${event}: ${relPath}`);
            return false;
          }
        }
        return true;
      });
    }
    cfg.hooks[event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
  }
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return dropped;
}

export function pruneHooksToml(runtimeRoot) {
  const relConfig = ".codex/config.toml";
  const p = join(runtimeRoot, ...relConfig.split("/"));
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n");
  const dropped = [];

  // Parse into segments: [start, end) line ranges, each a header block or the preamble.
  const headerRe = /^\[\[hooks\.([\w-]+)(\.hooks)?\]\]\s*$/;
  const segments = [];   // {start, end, event, isSub, header}
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (m) {
      if (current) current.end = i;
      current = { start: i, end: lines.length, event: m[1], isSub: Boolean(m[2]), header: true };
      segments.push(current);
    }
  }
  const preambleEnd = segments.length ? segments[0].start : lines.length;

  const drop = new Set();   // line indexes to remove
  for (const seg of segments) {
    if (!seg.isSub) continue;
    const body = lines.slice(seg.start, seg.end).join("\n");
    for (const ref of body.match(HOOK_SCRIPT_RE) ?? []) {
      const relPath = ref.replace(/\\/g, "/");
      if (existsSync(join(runtimeRoot, ...relPath.split("/")))) continue;
      dropped.push(`${relConfig}: ${seg.event}: ${relPath}`);
      for (let i = seg.start; i < seg.end; i++) drop.add(i);
      // Comment lines contiguously above the header belong to this block — but never the
      // preamble banner (a blank line always terminates the walk).
      for (let i = seg.start - 1; i >= preambleEnd && /^\s*#/.test(lines[i]); i--) drop.add(i);
      seg.dropped = true;
      break;
    }
  }
  // Bare [[hooks.<Event>]] headers whose sub-blocks all got dropped.
  for (const seg of segments) {
    if (seg.isSub) continue;
    const subs = segments.filter((s) => s.isSub && s.event === seg.event);
    if (subs.length && subs.every((s) => s.dropped)) {
      for (let i = seg.start; i < seg.end; i++) drop.add(i);
      for (let i = seg.start - 1; i >= preambleEnd && /^\s*#/.test(lines[i]); i--) drop.add(i);
    }
  }
  if (!drop.size) return dropped;

  const kept = lines.filter((_, i) => !drop.has(i));
  // Collapse runs of blank lines the removals left behind.
  const compact = [];
  for (const l of kept) {
    if (l.trim() === "" && compact.length && compact[compact.length - 1].trim() === "") continue;
    compact.push(l);
  }
  writeFileSync(p, compact.join("\n"), "utf8");
  return dropped;
}

export function prunePluginDeclarations(runtimeRoot, allowed) {
  const keep = new Set(allowed);
  const keepMarkets = new Set(allowed.map((id) => id.split("@")[1]).filter(Boolean));
  const dropped = [];

  for (const relConfig of [".claude/settings.json", ".agent/settings.json"]) {
    const p = join(runtimeRoot, ...relConfig.split("/"));
    if (!existsSync(p)) continue;
    let cfg;
    try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    let changed = false;

    if (cfg.enabledPlugins && typeof cfg.enabledPlugins === "object") {
      for (const id of Object.keys(cfg.enabledPlugins)) {
        if (keep.has(id)) continue;
        delete cfg.enabledPlugins[id];
        dropped.push(`${relConfig}: plugin: ${id}`);
        changed = true;
      }
      if (Object.keys(cfg.enabledPlugins).length === 0) delete cfg.enabledPlugins;
    }
    if (cfg.extraKnownMarketplaces && typeof cfg.extraKnownMarketplaces === "object") {
      for (const name of Object.keys(cfg.extraKnownMarketplaces)) {
        if (keepMarkets.has(name)) continue;
        delete cfg.extraKnownMarketplaces[name];
        dropped.push(`${relConfig}: marketplace: ${name}`);
        changed = true;
      }
      if (Object.keys(cfg.extraKnownMarketplaces).length === 0) delete cfg.extraKnownMarketplaces;
    }
    if (changed) writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  }
  return dropped;
}

export function pruneHookWiring(runtimeRoot) {
  const skillsRoot = join(runtimeRoot, '.agents', 'skills');
  const skills = existsSync(skillsRoot) ? readdirSync(skillsRoot).filter(name =>
    existsSync(join(skillsRoot, name, 'SKILL.md'))).sort() : [];
  const changed = [];
  for (const rel of ['.claude/settings.json', '.agent/settings.json', '.codex/config.toml']) {
    const path = join(runtimeRoot, ...rel.split('/'));
    if (!existsSync(path)) continue;
    const before = readFileSync(path, 'utf8');
    // Plugin allowlisting has its own pass; preserve those choices here.
    const plugins = rel.endsWith('.json') ? Object.keys(JSON.parse(before).enabledPlugins ?? {}) : [];
    const after = projectHostWiring(runtimeRoot, rel, before, skills, plugins);
    if (after !== before) { writeFileSync(path, after); changed.push(rel + ': absent-owner hooks pruned'); }
  }
  return changed;
}
