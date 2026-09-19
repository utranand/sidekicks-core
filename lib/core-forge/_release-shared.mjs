import { finish } from './exit.mjs';
// Sidekicks core forge — _release-shared. Zero runtime dependencies.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  readdirSync,
  rmSync,
  statSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve, relative, isAbsolute, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configurationInventory } from "../core-lifecycle/config-templates.mjs";
import { readCheckRun } from "../check-lifecycle/_shared.mjs";
import { samePathName } from '../sk-cli/core-mount.mjs';


export const INHERIT_REL = join("lib", "core-forge", "forge.mjs");

export const flag = (ctx, name) => {
  const i = ctx.argv.indexOf(`--${name}`);
  return i === -1 ? null : ctx.argv[i + 1] && !ctx.argv[i + 1].startsWith("-") ? ctx.argv[i + 1] : "";
};

export const has = (ctx, name) => ctx.argv.includes(`--${name}`);

export function git(ctx, args, cwd = ctx.ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

export function nowBangkok() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    stamp: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+07:00`,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

export function readJson(ctx, rel) {
  const p = join(ctx.ROOT, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // a corrupt state file must never block a publish
  }
}

export const portable = (rel) => rel.split(sep).join("/");

export const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+07:00/g;

export function normalizeForHash(buf) {
  return buf.toString("utf8").split("\r\n").join("\n").replace(TS_RE, "<TS>");
}

export function normalizedTreeHash(dir) {
  const files = {};
  if (!existsSync(dir)) return { digest: "", files };

  const walk = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs).sort();   // sorted: readdir order is not portable
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git") continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(childAbs);           // follows symlinks on purpose (see above)
      } catch {
        continue;                          // a broken link contributes nothing rather than throwing
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) {
        try {
          files[childRel] = createHash("sha256").update(normalizeForHash(readFileSync(childAbs))).digest("hex");
        } catch {
          /* unreadable file: leave it out rather than abort a release */
        }
      }
    }
  };
  walk(dir, "");

  const roll = createHash("sha256");
  for (const rel of Object.keys(files).sort()) roll.update(`${rel}\0${files[rel]}\n`);
  return { digest: roll.digest("hex"), files };
}

export function hashDiff(before, after) {
  const out = [];
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)].sort())) {
    if (!(rel in before)) out.push(`+ ${rel} (added)`);
    else if (!(rel in after)) out.push(`- ${rel} (removed)`);
    else if (before[rel] !== after[rel]) out.push(`M ${rel}`);
  }
  return out.sort();
}

export const PROTECTED = new Set(["main", "master", "sit", "uat", "staging", "stage", "prod", "production"]);

export const isProtected = (branch) => Boolean(branch) && (PROTECTED.has(branch) || branch.startsWith("release/"));

export function targetIsOwnRepo(ctx) {
  const top = git(ctx, ["rev-parse", "--show-toplevel"], ctx.SRC_ABS);
  if (!top.ok) return false;
  try {
    return samePathName(realpathSync(top.out), realpathSync(ctx.SRC_ABS));
  } catch {
    return false;
  }
}

export function lastRelease(state) {
  if (!state) return null;
  return state.last_local_release || state.last_publish || null;
}

export function sameVersion(block, version) {
  return Boolean(block) && String(block.version) === String(version);
}

export function publishedVersion(ctx) {
  const marker = readJson(ctx, join(ctx.SRC_REL, ".sidekicks-core.json"));
  const last = lastRelease(readJson(ctx, ctx.STATE_REL));
  return {
    marker: marker && marker.version ? String(marker.version) : null,
    markerCommit: marker && marker.source_commit ? String(marker.source_commit) : null,
    state: last ? String(last.version) : null,
    stateCommit: last ? String(last.source_commit) : null,
  };
}

export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || "");
    return m ? m.slice(1, 4).map(Number) : [-1, -1, -1];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

export function releaseBase(ver) {
  if (!ver.marker || !ver.state || ver.marker === ver.state) {
    return { base: ver.marker || ver.state, resumed: false, conflict: false };
  }
  if (compareVersions(ver.marker, ver.state) > 0) {
    return { base: ver.state, resumed: true, conflict: false };
  }
  return { base: ver.state, resumed: false, conflict: true };
}

export function bumpVersion(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || "");
  if (!m) return null;
  let [, maj, min, pat] = m.map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function releasedVersions(state) {
  const out = new Set();
  const last = lastRelease(state);
  if (last && last.version) out.add(String(last.version));
  if (Array.isArray(state && state.history)) {
    for (const h of state.history) if (h && h.version) out.add(String(h.version));
  }
  return out;
}

export function coreTreeClean(ctx) {
  if (!targetIsOwnRepo(ctx)) return false;
  const st = git(ctx, ["status", "--porcelain"], ctx.SRC_ABS);
  return st.ok && st.out === "";
}

export function referenceContent(ctx, version, state, ver) {
  const last = lastRelease(state);
  if (last && String(last.version) === version && last.content_hash) {
    return { digest: String(last.content_hash), files: null, source: "state.json content_hash" };
  }
  if (Array.isArray(state && state.history)) {
    const h = state.history.find((x) => x && String(x.version) === version && x.content_hash);
    if (h) return { digest: String(h.content_hash), files: null, source: "state.json history content_hash" };
  }
  if (ver.marker === version && coreTreeClean(ctx)) {
    const snap = normalizedTreeHash(ctx.SRC_ABS);
    if (snap.digest) return { ...snap, source: "the forged tree on disk (clean core repo)" };
  }
  return null;
}

export const SUBSTRATE_FALLBACK = [
  "bin",
  "lib",
  "scripts",
  ".githooks",
  ".sidekicks/RULES.md",
  ".sidekicks/hooks",
  ".sidekicks/config.example.yaml",
  ".sidekicks/framework.yaml",
  ".sidekicks/framework.example.yaml",
  ".claude/agents",
  ".claude/commands",
  ".claude/settings.json",
  ".codex/config.toml",
  ".codex/agents",
  ".gemini/settings.json",
  ".agent/settings.json",
  ".agents/plugins",
  "AGENTS.md",
];

export function corePaths(ctx) {
    const plan=ctx.plan;
    if(!plan?.skill_names?.length || !plan?.substrate?.length) throw new Error('core plan returned no skill or substrate surface');
    const reasons=Object.fromEntries((plan.skills??[]).map(row=>[row.skill,row.reasons?.length?[...row.reasons].sort():['unattributed']]));
    return {paths:[...plan.substrate,"AGENTS.md",...plan.skill_names.map(n=>'.agents/skills/'+n)].sort(),skills:[...plan.skill_names].sort(),reasons,
      packSkills:plan.pack_skills??null,payload:plan.payload??null,runtimeExcludedDirs:plan.runtime_excluded_dirs??[],problems:plan.problems??[],rootStructure:plan.root_structure,source:'core plan --json'};
  }

export function renderSkillReasons(reasons) {
  if (!reasons) return ['  unavailable — inherit engine is absent'];
  return Object.keys(reasons).sort().map((name) => `  ${name}  [${reasons[name].join(', ')}]`);
}

export function unitVersion(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, "VERSION.json"), "utf8"));
    return v && v.version ? String(v.version) : null;
  } catch {
    return null;
  }
}

export function subdirs(abs) {
  if (!existsSync(abs)) return null;
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

export function subdirsAtHead(ctx, relPosix) {
  if (!targetIsOwnRepo(ctx)) return null;
  const r = git(ctx, ["ls-tree", "--name-only", "-d", `HEAD:${relPosix}`], ctx.SRC_ABS);
  if (!r.ok) return null;
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
}

export function packsAtHead(ctx) {
  const listed = subdirsAtHead(ctx, ".sidekicks/agent-packs");
  if (listed) return listed;
  if (!targetIsOwnRepo(ctx)) return null;
  return git(ctx, ["rev-parse", "--verify", "HEAD"], ctx.SRC_ABS).ok ? [] : null;
}

export function readAtHead(ctx, relPosix) {
  if (!targetIsOwnRepo(ctx)) return null;
  const r = git(ctx, ["show", `HEAD:${relPosix}`], ctx.SRC_ABS);
  return r.ok ? r.out : null;
}

export function publishedInventory(ctx) {
  const last = lastRelease(readJson(ctx, ctx.STATE_REL));
  if (last && Array.isArray(last.skills)) {
    return {
      skills: [...last.skills].sort(),
      lib: Array.isArray(last.lib) ? [...last.lib].sort() : null,
      // Absent from every release recorded before agent packs existed, so fall back to the core's
      // committed HEAD rather than to `null`. The distinction that makes this safe is in
      // packsAtHead: a readable HEAD with no agent-packs directory is EMPTY (the release really
      // shipped none, so a new pack is correctly an addition), while an unreadable HEAD stays
      // unknown and the classifier compares nothing.
      packs: Array.isArray(last.packs) ? [...last.packs].sort() : packsAtHead(ctx),
      configuration: Array.isArray(last.configuration) ? last.configuration : null,
      source: "state.json",
      at: "state",
    };
  }
  const headSkills = subdirsAtHead(ctx, ".agents/skills");
  if (headSkills) {
    return {
      skills: headSkills,
      lib: subdirsAtHead(ctx, "lib"),
      packs: packsAtHead(ctx),
      configuration: configurationInventory(ctx.SRC_ABS).filter((row) => row.mode),
      source: "the core's committed HEAD",
      at: "head",
    };
  }
  return {
    skills: subdirs(join(ctx.SRC_ABS, '.agents', 'skills')),
    lib: subdirs(join(ctx.SRC_ABS, "lib")),
    packs: subdirs(join(ctx.SRC_ABS, ".sidekicks", "agent-packs")),
    configuration: configurationInventory(ctx.SRC_ABS).filter((row) => row.mode),
    source: "the forged working tree (unreleased content may be present)",
    at: "worktree",
  };
}

export function sourceInventory(ctx, planSkills) {
  return {
    skills: planSkills, // may be null when `inherit plan` could not run
    lib: subdirs(join(ctx.ROOT, "lib")),
    packs: subdirs(join(ctx.ROOT, ".sidekicks", "agent-packs")),
    configuration: configurationInventory(ctx.ROOT).filter((row) => row.mode),
  };
}

export async function verbIds(rootDir) {
  const help = join(rootDir, "lib", "sk-cli", "help.mjs");
  if (!existsSync(help)) return null;
  try {
    const mod = await import(pathToFileURL(help).href);
    if (!Array.isArray(mod.VERBS)) return null;
    return mod.VERBS.map((v) => `${v.namespace} ${v.verb}`).sort();
  } catch {
    return null;
  }
}

export const setDiff = (a, b) => (a && b ? a.filter((x) => !b.includes(x)) : []);

export async function classifyBump(ctx, planSkills) {
  const pub = publishedInventory(ctx);
  const src = sourceInventory(ctx, planSkills);
  const removedSkills = setDiff(pub.skills, src.skills);
  const addedSkills = setDiff(src.skills, pub.skills);
  const removedLib = setDiff(pub.lib, src.lib);
  const addedLib = setDiff(src.lib, pub.lib);
  // Agent packs move the number for the same reason skills do: a pack the consumer installed and
  // then lost is a crew that stops being re-installable, and a new one is an additive capability.
  const removedPacks = setDiff(pub.packs, src.packs);
  const addedPacks = setDiff(src.packs, pub.packs);
  const configMap = (rows) => new Map((rows || []).map((row) => [row.destination, row.hash || '']));
  const publishedConfig = configMap(pub.configuration);
  const sourceConfig = configMap(src.configuration);
  const removedConfiguration = [...publishedConfig.keys()].filter((p) => !sourceConfig.has(p)).sort();
  const addedConfiguration = [...sourceConfig.keys()].filter((p) => !publishedConfig.has(p)).sort();
  const changedConfiguration = [...sourceConfig.keys()].filter((p) => publishedConfig.has(p)
    && sourceConfig.get(p) !== publishedConfig.get(p)).sort();
  const pubVerbs = await verbIds(ctx.SRC_ABS);
  const srcVerbs = await verbIds(ctx.ROOT);
  const addedVerbs = setDiff(srcVerbs, pubVerbs);
  const removedVerbs = setDiff(pubVerbs, srcVerbs);

  const reasons = [];
  let kind = "patch";
  if (removedSkills.length) reasons.push(`skill removed: ${removedSkills.join(", ")}`);
  if (removedLib.length) reasons.push(`lib module removed: ${removedLib.join(", ")}`);
  if (removedVerbs.length) reasons.push(`CLI verb removed: ${removedVerbs.join(", ")}`);
  if (removedPacks.length) reasons.push(`agent pack removed: ${removedPacks.join(", ")}`);
  if (removedConfiguration.length) reasons.push(`configuration removed: ${removedConfiguration.join(", ")}`);
  if (reasons.length) {
    kind = "major";
  } else {
    if (addedSkills.length) reasons.push(`skill added: ${addedSkills.join(", ")}`);
    if (addedLib.length) reasons.push(`lib module added: ${addedLib.join(", ")}`);
    if (addedVerbs.length) reasons.push(`CLI verb added: ${addedVerbs.join(", ")}`);
    if (addedPacks.length) reasons.push(`agent pack added: ${addedPacks.join(", ")}`);
    if (addedConfiguration.length) reasons.push(`configuration added: ${addedConfiguration.join(", ")}`);
    if (reasons.length) kind = "minor";
    else if (changedConfiguration.length) reasons.push(`configuration template changed: ${changedConfiguration.join(", ")}`);
    else reasons.push("content-only change behind an unchanged surface");
  }
  return {
    kind,
    reasons,
    inventory_source: pub.source,
    added_skills: addedSkills,
    removed_skills: removedSkills,
    added_lib: addedLib,
    removed_lib: removedLib,
    added_verbs: addedVerbs,
    removed_verbs: removedVerbs,
    added_packs: addedPacks,
    removed_packs: removedPacks,
    added_configuration: addedConfiguration,
    removed_configuration: removedConfiguration,
    changed_configuration: changedConfiguration,
    published: pub,
    source: src,
  };
}

export function deltaRows(ctx, cls) {
  const rows = [];
  // The published side is read at the same place the inventory came from — reading a version from
  // the working tree while the inventory came from HEAD would pair a released unit with an
  // unreleased version number and report "unchanged" for a unit that did move.
  const publishedVersionAt = (relPosix, absDir) => {
    if (cls.published.at === "worktree") return unitVersion(absDir);
    const text = readAtHead(ctx, `${relPosix}/VERSION.json`);
    if (text === null) return unitVersion(absDir);
    try {
      const v = JSON.parse(text);
      return v && v.version ? String(v.version) : null;
    } catch {
      return null;
    }
  };
  const add = (label, publishedRel, publishedDir, sourceDir, present) => {
    const before = present.published ? publishedVersionAt(publishedRel, publishedDir) : null;
    const after = present.source ? unitVersion(sourceDir) : null;
    let state = "carried";
    if (!present.published) state = "added";
    else if (!present.source) state = "removed";
    else if (before !== after) state = "changed";
    rows.push({ unit: label, published: before, source: after, state });
  };

  // `null` on either side is UNKNOWN, not empty — the same distinction the classifier keeps.
  // Coercing it to `[]` here reported every published skill as `removed` in the delta table and
  // in the release log, while the classifier (which does guard) called the release a minor.
  const pubSkills = cls.published.skills;
  const srcSkills = cls.source.skills;
  for (const name of pubSkills && srcSkills ? [...new Set([...pubSkills, ...srcSkills])].sort() : []) {
    add(
      name,
      `.agents/skills/${name}`,
      join(ctx.SRC_ABS, '.agents', 'skills', name),
      join(ctx.ROOT, '.agents', 'skills', name),
      { published: pubSkills.includes(name), source: srcSkills.includes(name) }
    );
  }
  const pubLib = cls.published.lib;
  const srcLib = cls.source.lib;
  for (const name of pubLib && srcLib ? [...new Set([...pubLib, ...srcLib])].sort() : []) {
    add(`lib/${name}`, `lib/${name}`, join(ctx.SRC_ABS, "lib", name), join(ctx.ROOT, "lib", name), {
      published: pubLib.includes(name),
      source: srcLib.includes(name),
    });
  }
  // Agent packs. Their version lives in `pack.yaml`, not a VERSION.json, so they get their own
  // reader rather than being forced into a file shape they do not have.
  const pubPacks = cls.published.packs;
  const srcPacks = cls.source.packs;
  for (const name of pubPacks && srcPacks ? [...new Set([...pubPacks, ...srcPacks])].sort() : []) {
    const rel = `.sidekicks/agent-packs/${name}/pack.yaml`;
    const before = pubPacks.includes(name)
      ? (cls.published.at === "worktree"
        ? packVersion(join(ctx.SRC_ABS, ".sidekicks", "agent-packs", name))
        : packVersionFromText(readAtHead(ctx, rel)) ?? packVersion(join(ctx.SRC_ABS, ".sidekicks", "agent-packs", name)))
      : null;
    const after = srcPacks.includes(name)
      ? packVersion(join(ctx.ROOT, ".sidekicks", "agent-packs", name))
      : null;
    let state = "carried";
    if (!pubPacks.includes(name)) state = "added";
    else if (!srcPacks.includes(name)) state = "removed";
    else if (before !== after) state = "changed";
    rows.push({ unit: `agent-pack/${name}`, published: before, source: after, state });
  }
  // A row whose version did not move and which is present on both sides says nothing a
  // reader needs; the commit list already covers content. Keep only what moved.
  return rows.filter((r) => r.state !== "carried");
}

export function packVersion(dir) {
  try {
    return packVersionFromText(readFileSync(join(dir, "pack.yaml"), "utf8"));
  } catch {
    return null;
  }
}

export function packVersionFromText(text) {
  if (!text) return null;
  const m = /^version:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text);
  return m ? m[1] : null;
}

export function renderDelta(rows) {
  if (!rows.length) return ["  (no skill, lib module or agent pack added, removed, or version-bumped)"];
  const w = Math.max(6, ...rows.map((r) => r.unit.length));
  const out = [`  ${"unit".padEnd(w)}  published  source     state`];
  for (const r of rows) {
    out.push(
      `  ${r.unit.padEnd(w)}  ${(r.published || "—").padEnd(9)}  ${(r.source || "—").padEnd(9)}  ${r.state}`
    );
  }
  return out;
}

export function pendingSince(ctx, sinceCommit, paths) {
  if (!sinceCommit) return { commits: [], files: [], unknownBase: true };
  const range = `${sinceCommit}..HEAD`;
  // A unit separator, not a space: commit subjects contain spaces, colons and pipes, so
  // any printable delimiter would eventually split one in the wrong place.
  const SEP = "\u001f";
  const verify = git(ctx, ["cat-file", "-e", `${sinceCommit}^{commit}`]);
  if (!verify.ok) return { commits: [], files: [], unknownBase: true };
  const logRes = git(ctx, ["log", "--no-merges", `--format=%h${SEP}%s`, range, "--", ...paths]);
  const filesRes = git(ctx, ["diff", "--name-only", range, "--", ...paths]);
  const commits = logRes.ok
    ? logRes.out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(SEP);
          return i === -1
            ? { sha: l.trim(), subject: "" }
            : { sha: l.slice(0, i), subject: l.slice(i + 1) };
        })
    : [];
  const files = filesRes.ok ? filesRes.out.split("\n").filter(Boolean) : [];
  return { commits, files, unknownBase: false };
}

export function uncommittedCoreFiles(ctx, paths) {
  const tracked = git(ctx, ["diff", "--name-only", "HEAD", "--", ...paths]);
  const untracked = git(ctx, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  const set = new Set();
  for (const src of [tracked, untracked]) {
    if (!src.ok) continue;
    for (const f of src.out.split("\n").filter(Boolean)) set.add(f);
  }
  return [...set].sort();
}

export function headInfo(ctx) {
  return {
    sha: git(ctx, ["rev-parse", "--short", "HEAD"]).out,
    branch: git(ctx, ["branch", "--show-current"]).out,
    dirty: git(ctx, ["status", "--porcelain"]).out.length > 0,
  };
}

export function renderCoreDiff(coreDiff, prevVersion) {
  const lines = [];
  if (!coreDiff) return lines;
  if (coreDiff.baseline === "none") {
    lines.push(
      "**What this release changed in the core** — baseline forge: no previously published core to " +
        `diff against, so all ${coreDiff.fileCount} forged file(s) are new.`
    );
    return lines;
  }
  if (!coreDiff.rows.length) {
    lines.push(
      "**What this release changed in the core** — nothing. The forged tree is byte-identical " +
        "(wall-clock timestamps masked) to the one that preceded it: this release is a re-forge of " +
        "the same content. Any source churn listed below never reached the core."
    );
    return lines;
  }
  const qualifier =
    coreDiff.baseline === "previous-release"
      ? `against the forged tree of v${coreDiff.baselineVersion}`
      : `against the tree ON DISK, which was DIRTY — treat this as indicative, not as a diff ` +
        `against the previous release. A previously REFUSED ` +
        `re-publish is the usual reason: it forges before it compares, so the next run finds the ` +
        `tree it wrote rather than the released one`;
  lines.push(
    `**What this release changed in the core** — ${coreDiff.rows.length} path(s), ${qualifier}. ` +
      "Computed by hashing the forged tree before and after the forge."
  );
  lines.push("");
  lines.push("<details><summary>Core files</summary>");
  lines.push("");
  for (const row of coreDiff.rows.slice(0, 200)) lines.push(`- \`${row}\``);
  if (coreDiff.rows.length > 200) lines.push(`- … and ${coreDiff.rows.length - 200} more`);
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push(
    "> Counts here will not match the README's `## Changes in this release` table: that delta skips " +
      "symlinks and masks shas, this one follows symlinks and masks only timestamps. Both are " +
      "correct for their audience — the README's is consumer-facing, this one is release-engineering."
  );
  return lines;
}

export function renderLogEntry({ version, prevVersion, head, branch, pending, uncommitted, when, forgeCmd, surfaceSource, cls, rows, gates, coreDiff = null }) {
  const lines = [];
  lines.push("");
  lines.push(`## v${version} — ${when.date}`);
  lines.push("");
  lines.push(
    `Forged from \`${head}\`${branch ? ` on \`${branch}\`` : ""} at ${when.stamp}. ` +
      `Previous release: ${prevVersion ? `v${prevVersion}` : "none (baseline)"}.` +
      (cls ? ` Version class **${cls.kind}** — ${cls.reasons.join("; ")}.` : "")
  );
  lines.push("");
  for (const line of renderCoreDiff(coreDiff, prevVersion)) lines.push(line);
  if (coreDiff) lines.push("");
  if (pending.unknownBase) {
    lines.push(
      "Baseline release — no previous published commit to diff against, so the change list is not derivable."
    );
  } else if (!pending.commits.length && !pending.files.length) {
    lines.push("No core-bound source change since the previous release (re-forge only).");
  } else {
    lines.push(`**Core-bound source changes** — ${pending.commits.length} commit(s), ${pending.files.length} file(s):`);
    lines.push("");
    lines.push("| Commit | Subject |");
    lines.push("|---|---|");
    for (const c of pending.commits) {
      lines.push(`| \`${c.sha}\` | ${c.subject.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
    lines.push("<details><summary>Source files changed (provenance)</summary>");
    lines.push("");
    lines.push(
      "Paths in THIS repo that changed since the previous release's source commit — the REASON for " +
        "the release, not its contents. What actually shipped is the core-file list above."
    );
    lines.push("");
    for (const f of pending.files) lines.push(`- \`${f}\``);
    lines.push("");
    lines.push("</details>");
  }
  if (uncommitted && uncommitted.length) {
    // Recorded, not hidden: these shipped (the forge copies the working tree) but are
    // absent from the commit named above, so this release is NOT rebuildable from it.
    lines.push("");
    lines.push(
      `**Shipped but uncommitted at forge time** — ${uncommitted.length} file(s) not in \`${head}\`, ` +
        `so this release cannot be rebuilt from that commit:`
    );
    lines.push("");
    for (const f of uncommitted) lines.push(`- \`${f}\``);
  }
  if (rows && rows.length) {
    lines.push("");
    lines.push(`**Units added, removed, or version-bumped** — ${rows.length}:`);
    lines.push("");
    lines.push("| Unit | Published | Source | State |");
    lines.push("|---|---|---|---|");
    for (const r of rows) {
      lines.push(`| \`${r.unit}\` | ${r.published || "—"} | ${r.source || "—"} | ${r.state} |`);
    }
  }
  if (gates && gates.length) {
    // Which gates actually ran is part of what a release IS. A skipped suite recorded as
    // "skipped" is a fact a reader can act on; omitting the row would read as "it passed".
    lines.push("");
    lines.push("**Verification gates**:");
    lines.push("");
    for (const g of gates) lines.push(`- ${g.name} — ${g.result}${g.note ? ` (${g.note})` : ""}`);
  }
  lines.push("");
  lines.push(`Surface set derived from: ${surfaceSource}.`);
  lines.push("");
  lines.push("Forge command:");
  lines.push("");
  lines.push("```sh");
  lines.push(forgeCmd);
  lines.push("```");
  return lines.join("\n") + "\n";
}

export const LOG_HEADER = `# Framework core — release log

Auto-generated by \`sidekicks core publish\`. Do not hand-edit: entries are
derived from \`git log\` over the paths that actually travel into the core, and a hand-written note
here would not match the release it describes.

The core repo itself carries no changelog on purpose — its content is forged, so any file written
into it by hand is destroyed at the next \`create --force\` (inheritance is one-way). This log lives
in the root repo, next to the service, and commits with the gitlink bump.

Newest entries are appended at the bottom.
`;

export function upsertLogEntry(logPath, version, entry) {
  const text = readFileSync(logPath, "utf8");
  const lines = text.split("\n");
  const heading = new RegExp(`^## v${version.replace(/\./g, "\\.")}(?:\\s|$)`);
  const anyHeading = /^## v\d+\.\d+\.\d+(?:\s|$)/;

  const kept = [];
  let dropping = false;
  let replaced = false;
  for (const line of lines) {
    if (heading.test(line)) {
      dropping = true;
      replaced = true;
      continue;
    }
    if (dropping && anyHeading.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  if (!replaced) {
    appendFileSync(logPath, entry);
    return { replaced: false };
  }

  // renderLogEntry opens with a blank line, so trim the tail before splicing to avoid growing a
  // run of blank lines every time a version is re-landed.
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  writeFileSync(logPath, `${kept.join("\n")}\n${entry}`);
  return { replaced: true };
}
