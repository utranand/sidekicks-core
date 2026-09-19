import { CoreForgeError } from './exit.mjs';
// Sidekicks core forge — _shared. Zero runtime dependencies.
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


export const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");

export const isWindows = process.platform === "win32";

export const MANIFEST_REL = join(".sidekicks", "inherit.json");

export const SCHEMA = 1;

export const REQUIRED_KEY = "required";

export const HOST_PLUGINS_KEY = "host_plugins";

export const CORE_MARKER_REL = ".sidekicks-core.json";

export const CORE_MOUNT_DIR = ".sidekicks-core";

export const CORE_LAYOUT = 1;

export const CORE_INSTRUCTION_DOC = "AGENTS.framework.md";

export const CORE_INSTRUCTION_DOC_LEGACY = "CLAUDE.framework.md";

export const DELTA_SKIP_DIRS = new Set([".git", "artifacts", "node_modules", ".venv", "__pycache__", "output", "tmp"]);

export const DELTA_SKIP_RELS = new Set([
  CORE_MARKER_REL,
  "README.md",
  ".sidekicks/inherit.json",
  ".sidekicks/settings.json",
]);

export const DELTA_SKIP_PREFIXES = [".sidekicks/state/"];

export const TEXTUAL = /\.(md|mjs|js|cjs|json|ya?ml|sh|ps1|toml|txt|py|gitignore)$|(^|\/)\.gitignore$/i;

export const CORE_PACKS_REL = join(".sidekicks", "agent-packs");

export const PACK_MANIFEST_NAME = "pack.yaml";

export const CORE_SURFACES = [
  "bin",
  "lib",
  // scripts/install-hooks.mjs travels with every runtime and installs core.hooksPath from
  // .githooks/. Without the directory the runtime's readiness check reports a git-hooks failure it
  // can never clear ("Expected hook not found at <runtime>/.githooks/pre-commit").
  //
  // Repo-root tests/ does NOT travel. The hook is written to survive that: its mirror guard runs
  // lib/framework-lifecycle/tests/agent-context-mirror.test.mjs where the file exists and checks the
  // CLAUDE.md -> AGENTS.md invariant directly where it does not. Before that, installing
  // the hook in a forged runtime made every commit there fail on a test file it never carried.
  // (That suite and its parity sibling now live under lib/, so a forged runtime DOES carry them —
  // the fallback stays because a trimmed lib/ or a pre-move core still needs it.)
  ".githooks",
  ".sidekicks/RULES.md",
  ".sidekicks/hooks",
  // The framework enable map. Without it a runtime resolves every rule, criterion and hook to
  // the built-in default, so anything the source deliberately DISABLED comes back on — silently.
  // Copied, then re-synced against the runtime's own (smaller) registry, see syncRuntimeFramework.
  //
  // The map is SETTINGS (booleans), not configuration values, and lives in its own directory:
  // .sidekicks/config/settings/{rules,criteria,hooks}.yaml — see
  // docs/guide/settings-vs-configuration.md. Every layout this repo has shipped is listed because a
  // source that has not migrated still carries the older paths and a missing surface is skipped
  // silently; the config/ directory itself is NEVER a copy surface — it holds the SOURCE repo's
  // own values and its git-ignored *.secret.yaml siblings, so only these files are named.
  // The ignore rule that keeps the credential half of every family file out of git, WHICHEVER repo
  // this directory ends up in — which is the whole point of it living inside config/ rather than in
  // a repo-root .gitignore. A runtime is a different repo by construction, so omitting it shipped
  // runtimes whose config/ directory would happily stage a *.secret.yaml. Caught by `config doctor`
  // (secret-files-not-ignored) run INSIDE a forged core.
  ".sidekicks/config/settings/rules.yaml",
  ".sidekicks/config/settings/criteria.yaml",
  ".sidekicks/config/settings/hooks.yaml",
  ".sidekicks/config/framework.example.yaml",
  ".sidekicks/config/.gitignore",
];

export const CORE_SETTINGS_SHIPPED_OFF = Object.freeze({});

export const CORE_RULES_NOT_IN_RUNTIME_INSTRUCTIONS = Object.freeze(
  Object.entries(CORE_SETTINGS_SHIPPED_OFF).filter(([, v]) => v.notStated).map(([id]) => id),
);

export const OPTIONAL_SURFACES = {
  agents: [".agents/subagents", ".claude/agents", ".codex/agents", ".agents/plugins"],
  commands: [".claude/commands"],
};

export const FAMILY_TOKENS = Object.freeze({
  bmad: [/^bmad(-|$)/i, /^bmm(-|$)/i],
});

export const FAMILY_OWNERS = Object.freeze({
  bmad: [/^sk-bmad-/],
});

export function surfaceFamily(rel) {
  for (const seg of String(rel).split(/[\\/]/).filter(Boolean)) {
    const token = seg.replace(/\.[^.]+$/, "");
    for (const [family, tokens] of Object.entries(FAMILY_TOKENS)) {
      if (tokens.some((re) => re.test(token))) return family;
    }
  }
  return null;
}

export function ownedFamilies(skillNames) {
  const kept = new Set();
  for (const [family, owners] of Object.entries(FAMILY_OWNERS)) {
    if (skillNames.some((s) => owners.some((re) => re.test(s)))) kept.add(family);
  }
  return kept;
}

export const DELEGATES_DIRNAME = "agents";

export const DELEGATE_SURFACES = ["agent.yaml", "routines"];

export const DELEGATE_MEMORY_DIR = "memory";

export const DELEGATE_SKILL_RE = /^sidekicks-agent-/;

export const BRIDGE_DIRNAME = ".bridge";

export const DELEGATE_SCRIPT_FILES = [
  "start-agent-delegate.sh",              // headless delegate runner, one command
  "install-delegate-launchagent.sh",      // survive logout/reboot
  "uninstall-delegate-launchagent.sh",
  "agent-tray.sh",                        // menu-bar Agent Tray launcher
];

export const DELEGATE_SCRIPT_SUBDIRS = ["launchd"];

export const CLI_WIRING = [
  ".claude/settings.json",
  ".codex/config.toml",
  ".agent/settings.json",
];

export const SCRIPT_SUBDIR_OWNERS = {
  "office-viz-themes": ["sk-office-viz"],
  "office-viz-vendor": ["sk-office-viz"],
  launchd: ["sk-agent-standby", "sk-agent-master", "sk-agent-tray"],
};

export const SCRIPT_SUBDIR_FLOOR = ["lib"];

export const SCRIPT_FILE_FLOOR = ["run-tests.mjs"];

export const SUBAGENT_PORT_SCRIPT_FILES = ["generate-subagent-ports.mjs"];

export const RUNTIME_TEST_SCRIPT = "scripts/run-tests.mjs";

export const RUNTIME_TEST_COMMAND = `node ${RUNTIME_TEST_SCRIPT}`;

export const DENY = new Set([
  ".git", ".venv", "node_modules", ".env", ".DS_Store",
  "artifacts", "output", "tmp", "projects", "docs-history", "experiments",
  "settings.local.json", "config.yaml", "running-agents.json",
  "scheduled_tasks.lock", "index.json", "settings.json",
  // "agents" is deliberately NOT here. It was a bare segment matched at ANY depth, so it also ate
  // .agents/plugins/sidekicks-agents/agents/ (41 Antigravity subagents — a Rule 6 parity hole),
  // .claude/commands/bmad/{core,bmm}/agents/, and four first-party skills' own agents/ directory
  // (which also produced a permanent false FF, since the baseline was hashed from the truncated
  // runtime copy while drift compared the full source tree). The bulk copy of .sidekicks/agents/
  // that the entry was written to stop is held back STRUCTURALLY, not by this set: .sidekicks is
  // never a copy surface (only .sidekicks/RULES.md, /hooks, /config.example.yaml and the two named
  // framework enable-map files under config/ are — see CORE_SURFACES), and a selected delegate
  // travels through inheritDelegates' explicit
  // per-surface list (agent.yaml + routines, memory only on request), which never walks the folder.
  // Guarded by tests/skills/inherit-delegate-agents.test.mjs. ".bridge" and "memory" stay bare
  // segments and are what actually keeps credentials out — do not fold them into anything narrower.
  ".bridge", "memory", "skill-offloaded", "artifacts-inventory.json",
  "artifacts-inventory.md", "__pycache__",
  // The derived-state directory (.sidekicks/state/ — scope index, running agents, artifact
  // inventory). Its individual files are already denied by basename above, so this is the rule that
  // keeps holding when a new state file is added. A runtime rebuilds its own.
  "state",
]);

// Whole-root copying must not pick up developer dotenv overlays or either YAML
// spelling of credential siblings. Public *.example.yaml/json templates do not match.
export const DENY_PATTERNS = [/\.log$/i, /\.secret\.ya?ml$/i, /^\.env(?:\.|$)/i];

export const DENY_EXCEPTIONS = new Set([
  join(".claude", "settings.json"),
  join(".claude", "agents"),
  join(".codex", "agents"),
]);

export function die(msg, code = 1) { throw new CoreForgeError(msg, code); }

export function out(ctx, msg = "") {
  ctx.write(`${msg}\n`);
}

export function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
}

export function displayPath(repoRoot, target) {
  const rel = relative(repoRoot, target);
  return !rel ? "." : (rel.startsWith("..") ? target : rel);
}

export function nowBangkok() {
  const ms = Date.now() + 7 * 3600 * 1000;
  return `${new Date(ms).toISOString().replace(/\.\d{3}Z$/, "")}+07:00`;
}

export function gitHead(repoRoot) {
  const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

export function hashFile(path) {
  return hashBuffer(readFileSync(path));
}

export function hashBuffer(buf) {
  const isBinary = buf.subarray(0, 8192).includes(0);
  const payload = isBinary ? buf : Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(payload).digest("hex");
}

export function hashTree(dir) {
  const map = {};
  if (!existsSync(dir)) return map;
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs).sort()) {
      if (entry === "__pycache__") continue;
      const childAbs = join(abs, entry);
      const childRel = rel ? `${rel}/${entry}` : entry;
      let st;
      try { st = lstatSync(childAbs); } catch { continue; }
      if (st.isSymbolicLink()) continue;          // links are never inherited content
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) map[childRel] = hashFile(childAbs);
    }
  };
  walk(dir, "");
  return map;
}

export function sameHashes(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i] || a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}

export function delegatesRoot(repoRoot) {
  return join(repoRoot, ".sidekicks", DELEGATES_DIRNAME);
}

export function resolveDelegate(repoRoot, name) {
  if (name === BRIDGE_DIRNAME) return null;
  const dir = join(delegatesRoot(repoRoot), name);
  return existsSync(join(dir, "agent.yaml")) ? { name, dir } : null;
}

export function listAvailableDelegates(repoRoot) {
  const root = delegatesRoot(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().filter((e) => e !== BRIDGE_DIRNAME
    && existsSync(join(root, e, "agent.yaml")));
}

export function hashDelegateSurface(agentDir, includeMemory) {
  const map = {};
  const surfaces = includeMemory ? [...DELEGATE_SURFACES, DELEGATE_MEMORY_DIR] : DELEGATE_SURFACES;
  for (const rel of surfaces) {
    const abs = join(agentDir, rel);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isFile()) { map[rel] = hashFile(abs); continue; }
    if (!st.isDirectory()) continue;
    for (const [k, v] of Object.entries(hashTree(abs))) map[`${rel}/${k}`] = v;
  }
  return map;
}

export function delegateWorkDir(agentDir) {
  const f = join(agentDir, "agent.yaml");
  if (!existsSync(f)) return "";
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return ""; }
  const m = /^default_work_dir:\s*(.*)$/m.exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

export function ensureSourceGitignore(repoRoot) {
  const gi = join(repoRoot, ".gitignore");
  if (!existsSync(gi)) return false;
  const text = readFileSync(gi, "utf8");
  if (/^\/runtimes\/\s*$/m.test(text)) return false;
  const block = [
    "# Inherited standalone runtimes (sk-publish-core). Each runtimes/<name>/ is its own git",
    "# repo with its own remote — the parent repo never tracks it.",
    "/runtimes/",
    "",
  ].join("\n");
  writeFileSync(gi, `${text.endsWith("\n") ? text : `${text}\n`}\n${block}`, "utf8");
  return true;
}

export function initRuntimeGit(runtimeRoot, remote) {
  const res = { initialized: false, remote: null, note: "" };
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) {
    res.note = "git not on PATH — runtime left un-initialized";
    return res;
  }
  if (!existsSync(join(runtimeRoot, ".git"))) {
    const r = spawnSync("git", ["-C", runtimeRoot, "init", "-q"], { encoding: "utf8" });
    if (r.status !== 0) { res.note = `git init failed: ${(r.stderr || "").trim()}`; return res; }
    res.initialized = true;
  }
  if (remote) {
    const has = spawnSync("git", ["-C", runtimeRoot, "remote", "get-url", "origin"], { encoding: "utf8" });
    const verb = has.status === 0 ? "set-url" : "add";
    const r = spawnSync("git", ["-C", runtimeRoot, "remote", verb, "origin", remote], { encoding: "utf8" });
    if (r.status === 0) res.remote = remote;
    else res.note = `could not set origin: ${(r.stderr || "").trim()}`;
  }
  return res;
}
