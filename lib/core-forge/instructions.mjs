// Sidekicks core forge — instructions. Zero runtime dependencies.
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
import { buildRegistry } from '../framework-settings/registry.mjs';
import { CORE_RULES } from '../framework-settings/core-registry.mjs';

/** A missing owner must fail even though its descriptor disappeared from discovery. */
export function verifyInstructionBodies(runtimeRoot, expectedSkills = []) {
  const problems=[];
  for(const name of expectedSkills) if(!existsSync(join(runtimeRoot,'.agents','skills',name,'SKILL.md'))) problems.push('missing owning skill: '+name);
  let entries; try { entries=buildRegistry(runtimeRoot).entries; } catch(e) {return [...problems,e.message];}
  const text=existsSync(join(runtimeRoot,'AGENTS.md'))?readFileSync(join(runtimeRoot,'AGENTS.md'),'utf8'):'';
  const canonicalPath = join(runtimeRoot,'.sidekicks','RULES.md');
  if (existsSync(canonicalPath)) {
    const section = readFileSync(canonicalPath,'utf8').replace(/\r\n?/g,'\n')
      .split('## The Six Boundary Rules\n')[1]?.split('\n## ')[0];
    const boundaries = section?.match(/\*\*Rule [1-6] — [\s\S]*?(?=\n\*\*Rule [1-6] — |$)/g) ?? [];
    if (boundaries.length !== 6) problems.push('canonical six boundary bodies are incomplete');
    for (const body of boundaries) if (!text.replace(/\r\n?/g,'\n').includes(body.trim()))
      problems.push('boundary rule body differs from canonical: ' + body.split('\n')[0]);
  } else problems.push('missing canonical boundary rules: .sidekicks/RULES.md');
  if (expectedSkills.length === 8 && expectedSkills.includes('sk-framework-core') && expectedSkills.includes('sk-publish-core')) {
    const bytes = Buffer.byteLength(text);
    if (bytes < 6144 || bytes > 8192) problems.push(`lean instruction size ${bytes} bytes is outside 6144–8192`);
  }
  for(const entry of entries.filter(e=>e.kind!=='hook')) {
    if(entry.source==='core') {
      if(!text.includes(entry.body_marker)) problems.push('missing instruction body marker: '+entry.id);
    } else if(!entry.body_at || !existsSync(join(runtimeRoot,entry.body_at))) problems.push('missing skill rule body: '+entry.id+' '+entry.body_at);
    else if(!text.includes(entry.id)) problems.push('missing skill rule pointer: '+entry.id);
  }
  return problems;
}

export function rulePointers(runtimeRoot) {
  return buildRegistry(runtimeRoot).entries.filter(e=>e.source==='skill' && e.kind!=='hook')
    .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(e=>e.id).join(', ');
}
import { ASSETS, CORE_MOUNT_DIR, DELEGATES_DIRNAME, die, nowBangkok } from './_shared.mjs';

export function renderTemplate(file, vars) {
  const p = join(ASSETS, file);
  if (!existsSync(p)) die(`missing bundled asset: ${file}`, 3);
  let text = readFileSync(p, "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
  return text;
}

/** Installer values are data, never shell/PowerShell source. Comments cannot gain a new line. */
export function renderInstallerTemplate(file, vars) {
  const escaped = {};
  for (const [key, raw] of Object.entries(vars)) {
    const value = String(raw);
    if (/[\r\n\0]/.test(value)) die('installer value must be a single line: ' + key, 2);
    escaped[key] = file.endsWith('.ps1.tmpl') ? value.replaceAll("'", "''")
      : value.replace(/[\\$"`]/g, char => '\\' + char);
  }
  return renderTemplate(file, escaped);
}

export const ABBREV = /(?:e\.g|i\.e|etc|vs|cf|approx|Dr|Mr|Ms|No|Fig|al)\.$/i;

export function firstLineDescription(skillDir) {
  const f = join(skillDir, "SKILL.md");
  if (!existsSync(f)) return "";
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return ""; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return "";

  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^description:/.test(l));
  if (start === -1) return "";

  const parts = [lines[start].replace(/^description:\s*/, "").replace(/^[|>]-?\s*$/, "")];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z_][\w-]*:/.test(lines[i])) break;   // next frontmatter key at column 0
    parts.push(lines[i]);
  }

  const flat = parts.join(" ").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "").trim();
  if (!flat) return "";

  // First sentence, skipping abbreviation dots.
  let sentence = flat;
  for (const m of flat.matchAll(/\.\s/g)) {
    const head = flat.slice(0, m.index + 1);
    if (!ABBREV.test(head)) { sentence = head; break; }
  }
  const clean = sentence.replace(/\|/g, "\\|").trim();
  return clean.length > 170 ? `${clean.slice(0, 167)}…` : clean;
}

export function delegateSpecialty(agentDir) {
  const f = join(agentDir, "agent.yaml");
  if (!existsSync(f)) return "";
  let text;
  try { text = readFileSync(f, "utf8"); } catch { return ""; }
  const m = /^specialty:\s*(.*)$/m.exec(text);
  if (!m) return "";
  const flat = m[1].trim().replace(/^["']|["']$/g, "").replace(/\|/g, "\\|").trim();
  return flat.length > 170 ? `${flat.slice(0, 167)}…` : flat;
}

export function writeRuntimeAgentsMd(runtimeRoot, { name, skillNames, delegateNames = [], sourceCommit, hasVenv }) {
  const rows = skillNames.map((s) => {
    const desc = firstLineDescription(join(runtimeRoot, '.agents', 'skills', s)).split(/\s+/).slice(0,4).join(' ');
    return `| \`${s}\` | ${desc} |`;
  }).join("\n");

  const agentRows = delegateNames.map((a) => {
    const spec = delegateSpecialty(join(runtimeRoot, ".sidekicks", DELEGATES_DIRNAME, a));
    return `| \`${a}\` | ${spec} |`;
  }).join("\n");

  const delegateSection = delegateNames.length ? [
    "",
    "## Delegate agents in this runtime",
    "",
    "| Agent | Specialty |",
    "|---|---|",
    agentRows,
    "",
    `Charters are canonical at \`.sidekicks/${DELEGATES_DIRNAME}/<name>/\` and are reached ONLY through`,
    "the `sidekicks agent` verbs — never by hand-editing the store (Rule 1). Each one arrived with its",
    "charter and routines; their `runtime/` state (presence, control gate, mailbox, threads) and the",
    "shared `.bridge/` are created here on first use and never travelled — so no credential or PID",
    "from the source repo is in this runtime. A charter amended here diverges from the source: the next",
    "sync reports it as a conflict and refuses to overwrite it without `--force`.",
  ].join("\n") : "";

  // AGENTS.min.md.tmpl: it renders AGENTS.md, the canonical instruction file (Rule 6). It shipped as
  // CLAUDE.min.md.tmpl until the instruction surface moved, which left the asset named after a file
  // that is now only a mirror.
  const text = renderTemplate("AGENTS.min.md.tmpl", {
    RUNTIME_NAME: name,
    GENERATED_AT: nowBangkok(),
    SOURCE_COMMIT: sourceCommit,
    // The mount path. AGENTS.framework.md is this same body with a mount preamble prepended, and the
    // body used to describe only the standalone case — so a mounted consumer read a preamble saying
    // "your instructions go in the workspace's AGENTS.md" followed by a body saying "put them in
    // AGENTS.local.md here", in a read-only submodule (INC-2026-09-04-02, N-6). One body, true for
    // both readers: the invariant that AGENTS.framework.md ENDS WITH AGENTS.md is what keeps the two
    // from drifting, and forging a second mount-flavoured body would break it deliberately.
    CORE_DIR: CORE_MOUNT_DIR,
    SKILL_COUNT: String(skillNames.length),
    SKILL_TABLE: rows || "| _(none)_ | |",
    RULE_POINTER_TABLE: rulePointers(runtimeRoot),
    DELEGATE_SECTION: delegateSection,
    // Both branches state rule.single-venv and carry its registry marker verbatim. They differ only
    // in whether the venv is here YET — the rule ("one venv, at the repo root") is the same either
    // way, and making its presence conditional on --no-venv would mean a forged runtime could drop a
    // registered rule with nothing recording that it had.
    PYTHON_SECTION: hasVenv
      ? "- **Python:** the single repo-root `.venv` only — this runtime's own, never another repo's venv, never system Python. All pip installs go there. The package set is pinned in `requirements.txt`."
      : "- **Python:** this runtime carries none yet. Use only the single repo-root `.venv` at the "
        + "WORKSPACE root, never system Python or the mounted read-only tree.",
  });
  writeFileSync(join(runtimeRoot, "AGENTS.md"), text, "utf8");
}

export function writeInstructionMirrors(runtimeRoot) {
  for (const mirror of ["CLAUDE.md", "GEMINI.md"]) {
    const p = join(runtimeRoot, mirror);
    rmSync(p, { force: true });          // no-op when absent; clears a stale link or copy
    try {
      symlinkSync("AGENTS.md", p, "file");
    } catch {
      copyFileSync(join(runtimeRoot, "AGENTS.md"), p);   // Windows without symlink privilege
    }
  }
}
