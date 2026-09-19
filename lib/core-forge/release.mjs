import { resolveReleasePaths } from './paths.mjs';
import { runProjection } from './forge.mjs';
import { sealRootStructure, verifyRootStructure } from './surfaces.mjs';
import { ReleaseExit, CoreForgeError } from './exit.mjs';
import { finish } from './exit.mjs';
// Sidekicks core forge — release. Zero runtime dependencies.
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
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve, relative, isAbsolute, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { configurationInventory } from "../core-lifecycle/config-templates.mjs";
import { readCheckRun } from "../check-lifecycle/_shared.mjs";
import { INHERIT_REL, LOG_HEADER, bumpVersion, classifyBump, corePaths, coreTreeClean, deltaRows, flag, git, has, hashDiff, headInfo, isProtected, lastRelease, normalizedTreeHash, nowBangkok, pendingSince, portable, publishedVersion, readJson, referenceContent, releaseBase, releasedVersions, renderDelta, renderLogEntry, renderSkillReasons, sameVersion, targetIsOwnRepo, uncommittedCoreFiles, upsertLogEntry } from './_release-shared.mjs';
import { nodeStep, runGates } from './gates.mjs';

export async function doStatus(ctx) {
  const ver = publishedVersion(ctx);
  const {
    paths, skills, reasons: skillReasons, source,
    packSkills: planPackSkills, payload, problems: planProblems,
  } = corePaths(ctx);
  const head = headInfo(ctx);
  const base = ver.markerCommit || ver.stateCommit;
  const pending = pendingSince(ctx, base, paths);
  const uncommitted = uncommittedCoreFiles(ctx, paths);
  const cls = await classifyBump(ctx, skills);
  const rows = deltaRows(ctx, cls);
  const bump = flag(ctx, "bump") || cls.kind;
  const { base: versionBase, resumed, conflict } = releaseBase(ver);
  const next = flag(ctx, "version") || bumpVersion(versionBase, bump);

  // What the REMOTE has to say, read from state.json only — `status` never reaches the network.
  // Three states, not two, and the distinction is the one state.json's own comment fixes: absence
  // means "not verified", NEVER "verified false". A fresh clone has asked nobody, and reporting that
  // as NOT SERVED would make every clone look like a failed release. Only a recorded negative is a
  // negative. Before this, a never-pushed release looked identical to a published one — which is how
  // v1.4.1 sat unpushed while every local signal said the release was done.
  const stateNow = readJson(ctx, ctx.STATE_REL) || {};
  const lastLocal = lastRelease(stateNow);
  const verified = stateNow.remote_verified && lastLocal
    && String(stateNow.remote_verified.version) === String(lastLocal.version)
    ? stateNow.remote_verified
    : null;
  const negative = stateNow.remote_check && lastLocal
    && String(stateNow.remote_check.version) === String(lastLocal.version)
    && stateNow.remote_check.ok === false
    ? stateNow.remote_check
    : null;
  const remoteState = verified ? "served" : negative ? "not_served" : "unverified";
  // Three states here too, and for the same reason as remoteState: a release nobody has verified has
  // not been found "behind", it has not been looked at. Only a recorded boolean is an answer.
  const advertisedRecord = verified || negative;
  const advertised = advertisedRecord && typeof advertisedRecord.advertised === "boolean"
    ? advertisedRecord.advertised
    : null;
  // What `release` recorded as owed and `verify-remote` has not yet been able to cross off. Read
  // from state only — status never reaches the network, so it reports the last answer and says when.
  const outstandingMerges = sameVersion(stateNow.remote_release, lastLocal?.version)
    && Array.isArray(stateNow.remote_release.merges_outstanding)
    ? stateNow.remote_release.merges_outstanding
    : [];
  const mergesCheckedAt = sameVersion(stateNow.remote_release, lastLocal?.version)
    ? stateNow.remote_release.merges_checked_at || null
    : null;
  // Only classified against the remote when there ARE orphans, so an ordinary status stays offline.
  const orphanTags = unloggedTags(ctx);
  const phantomHistory = historyWithoutLog(ctx, stateNow);

  const result = {
    runtime: ctx.RUNTIME_NAME,
    target: portable(ctx.SRC_REL),
    run_state: portable(ctx.RUN_REL),
    preset: ctx.PRESET,
    published_version: ver.marker,
    published_source_commit: ver.markerCommit,
    state_version: ver.state,
    version_agrees: !ver.state || !ver.marker || ver.state === ver.marker,
    // A marker ahead of the log is an ABORTED publish (forged, stamped, a gate failed), not the
    // hand-forge the mismatch guard exists for. Reported separately so a caller can tell them apart.
    resumed_attempt: resumed,
    version_conflict: conflict,
    head: head.sha,
    branch: head.branch,
    working_tree_dirty: head.dirty,
    // Split from working_tree_dirty on purpose (INC-2026-09-04-03, U-4). head.dirty is
    // `git status --porcelain` over the WHOLE repo, so four unrelated project gitlinks made a
    // release whose every core-bound surface was committed report "working tree DIRTY" — a warning
    // that named nothing the release could act on, next to a refusal (below) that correctly gates on
    // core-bound files only. The honest number was already being computed; it just was not reported.
    core_bound_dirty: uncommitted.length,
    core_bound_path_count: paths.length,
    surface_source: source,
    skill_selection_reasons: skillReasons,
    // The composition POLICY, reported next to the composition itself. `preset` alone never said
    // how much of the shipped agent packs' skill graph came with it, so two releases with the same
    // preset and wildly different skill sets were indistinguishable in the record.
    pack_skills: planPackSkills ?? ctx.PACK_SKILLS,
    // What the runtime projection carried and what it left behind, by class. A release that ships
    // a skill's improvement funnel and one that does not are otherwise the same release here.
    payload,
    policy_violations: planProblems,
    pending_commits: pending.commits.length,
    pending_files: pending.files.length,
    uncommitted_core_files: uncommitted.length,
    unknown_base: pending.unknownBase,
    bump_class: cls.kind,
    bump_reasons: cls.reasons,
    bump_source: flag(ctx, "version") ? "explicit --version" : flag(ctx, "bump") ? "explicit --bump" : "derived",
    inventory_source: cls.inventory_source,
    delta: rows,
    next_version: next,
    remote_state: remoteState,
    remote_verified_version: verified ? String(verified.version) : null,
    remote_checked_at: (verified && verified.verified_at)
      || (negative && negative.checked_at)
      || null,
    unpushed_release: remoteState === "served" || !lastLocal ? null : String(lastLocal.version),
    // Whether the core's main carries this release — the fact that decides which version the
    // README one-liner actually installs. null means nobody has checked, not "no".
    advertised,
    merges_outstanding: outstandingMerges,
    merges_checked_at: mergesCheckedAt,
    unlogged_tags: orphanTags,
    // The mirror image of unlogged_tags: history claiming a release the log has no section for.
    history_without_log: phantomHistory,
  };

  if (ctx.JSON_OUT) {
    ctx.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const out = [];
    out.push(`Framework core: ${portable(ctx.SRC_REL)}`);
    out.push(`  published:   v${ver.marker || "?"} (source ${ver.markerCommit || "?"})`);
    // Four consecutive audits have filed the repo-root package.json version as stale (INC-2026-09-04
    // -01 F-5, -02 N-9, -03 U-4, INC-2026-09-05-04 V-4). It is not: the core's version is stamped
    // into the FORGED package.json by --core-version, and the source file versions the source repo,
    // which is a different artifact on a different cadence. Decided by the operator 2026-09-04 and
    // written up at the top of this file — but an auditor reads `status`, not the source header,
    // which is exactly why it kept getting re-reported. So the pointer lives where they look.
    out.push(`  note:        this is the CORE's version. The repo-root package.json versions the`);
    out.push(`               source repo and is deliberately unrelated — see the VERSIONING note at`);
    out.push(`               framework-core publishing instructions (decided 2026-09-04).`);
    if (resumed) {
      out.push(
        `  RESUMING:    marker says v${ver.marker}, log's last release is v${ver.state} — a publish ` +
          `forged and stamped, then a gate failed. That number is reused, not skipped.`
      );
    } else if (!result.version_agrees) {
      out.push(
        `  MISMATCH:    release log says v${ver.state} but the forged marker says v${ver.marker} — ` +
          `the forged core is OLDER than the log claims; reconcile before bumping`
      );
    }
    out.push(`  HEAD:        ${head.sha}${head.branch ? ` (${head.branch})` : ""}`
      + (head.dirty
        ? ` — working tree DIRTY (${uncommitted.length} core-bound)`
        : ""));
    out.push(`  surfaces:    ${paths.length} core-bound path(s) — from ${source}`);
    out.push(`  resolved skills:`);
    out.push(...renderSkillReasons(skillReasons));
    out.push("");
    if (pending.unknownBase) {
      out.push("  Cannot diff: the published source commit is unknown or not in this repo's history.");
      out.push("  Publish once to establish the baseline.");
    } else if (!pending.commits.length && !pending.files.length) {
      out.push("  Committed state is in sync — no core-bound commit since the last publish.");
    } else {
      out.push(`  PENDING: ${pending.commits.length} commit(s), ${pending.files.length} file(s) since v${ver.marker}`);
      for (const c of pending.commits.slice(0, 15)) out.push(`    ${c.sha}  ${c.subject}`);
      if (pending.commits.length > 15) out.push(`    … ${pending.commits.length - 15} more`);
      out.push("");
      out.push(`  units changed (inventory read from ${cls.inventory_source}):`);
      out.push(...renderDelta(rows));
      out.push("");
      out.push(
        `  next version would be v${next} — ${bump.toUpperCase()}` +
          (flag(ctx, "version") ? " (explicit --version)" : flag(ctx, "bump") ? " (explicit --bump)" : `, derived: ${cls.reasons.join("; ")}`)
      );
    }
    if (uncommitted.length) {
      out.push("");
      out.push(
        `  UNCOMMITTED: ${uncommitted.length} core-bound file(s) not in HEAD. The forge copies the`
      );
      out.push(
        "  working tree, so these WOULD ship — but the log records HEAD, so the release could not be"
      );
      out.push("  rebuilt from its own commit. Commit them first.");
      for (const f of uncommitted.slice(0, 15)) out.push(`    ${f}`);
      if (uncommitted.length > 15) out.push(`    … ${uncommitted.length - 15} more`);
    }
    if (pending.commits.length || pending.files.length || uncommitted.length) {
      out.push("");
      // The derived class is the default, so the suggested command carries --bump only when
      // the operator already overrode it — otherwise the hint would train them to pin it.
      const targetArg = flag(ctx, "target") ? ` --target ${portable(ctx.SRC_REL)}` : "";
      const bumpArg = flag(ctx, "bump") ? ` --bump ${bump}` : "";
      out.push(`  run: node bin/sidekicks core publish${targetArg}${bumpArg}`);
    } else {
      out.push("  No release owed.");
    }

    out.push("");
    if (remoteState === "served") {
      out.push(`  remote:      SERVED — v${result.remote_verified_version} verified at ${result.remote_checked_at}`);
    } else if (remoteState === "not_served") {
      // Scored checks only. The refs/heads/main check is deliberately unscored, so an outstanding
      // merge can sit at ok:false in the record — naming it as the reason a release is NOT SERVED
      // would point the operator at `release --yes` for something a merge fixes.
      const first = (negative.checks || []).find((c) => c && c.ok === false && c.scored !== false);
      out.push(`  remote:      NOT SERVED — v${lastLocal.version}: ${first ? first.detail : "the remote does not serve this release"}`);
      out.push("               finish it: node bin/sidekicks core release --yes");
    } else if (lastLocal) {
      out.push(`  remote:      NOT VERIFIED — v${lastLocal.version} is a LOCAL release; nothing has asked the remote.`);
      out.push("               run: node bin/sidekicks core verify-remote");
    }

    // ── advertised: a second sentence, because SERVED does not imply it ───────
    // INC-2026-09-05-04 V-1. SERVED means the tag and the release branch are on the remote.
    // ADVERTISED means the core's main carries them, which is what the README one-liner actually
    // fetches — so between `release` and the operator's merge, a first-time reader installs the
    // PREVIOUS release while every local signal says the release is done. Rendered from the record
    // `verify-remote` left, never by reaching the network: status stays offline.
    if (lastLocal && advertised === true) {
      out.push(`               ADVERTISED — the core's main carries v${lastLocal.version}`
        + `${mergesCheckedAt ? ` (checked ${mergesCheckedAt})` : ""}`);
    } else if (lastLocal && advertised === false) {
      out.push("               NOT ADVERTISED — the core's main is behind, so the README one-liner");
      out.push("               still installs the previous release.");
      if (outstandingMerges.length) {
        out.push("               outstanding, and yours alone — this script never merges:");
        for (const m of outstandingMerges) {
          out.push(`                 ${m.repo}: merge ${m.from} -> ${m.into}`
            + `${m.unresolved ? "   (could not be checked from here)" : ""}`);
        }
      }
      out.push(`               re-check: node bin/sidekicks core verify-remote`
        + `${mergesCheckedAt ? `   (last checked ${mergesCheckedAt})` : ""}`);
    }

    if (orphanTags.length) {
      out.push("");
      out.push(`  UNLOGGED TAGS: ${orphanTags.length} tag(s) in the core with no release-log entry —`);
      out.push("  cut outside this script, so nothing recorded what they contain.");
      for (const t of orphanTags) {
        const where = t.served === true
          ? "SERVED by the remote — do NOT delete it; backfill its log entry instead"
          : t.served === false
            ? "local only, never pushed — deleting it is safe"
            : "remote unreachable, so whether it is published is unknown";
        out.push(`    ${t.tag}  ${where}`);
      }
    }

    if (phantomHistory.length) {
      out.push("");
      out.push(`  HISTORY WITHOUT A LOG ENTRY: ${phantomHistory.length} version(s) that `
        + `${portable(ctx.STATE_REL)} records as released and ${portable(ctx.LOG_REL)} has no section for.`);
      out.push("  `history` is appended from whatever the core marker said at each cut, so a hand-forge");
      out.push("  that stamped a version it never released leaves an entry nothing else backs. It is not");
      out.push("  cosmetic: publishedVersions() reads it, so a re-publish of one of these is graded a");
      out.push("  re-land and refused without --reland.");
      for (const h of phantomHistory) {
        out.push(`    v${h.version}${h.source_commit ? `  (source ${h.source_commit})` : ""}`);
      }
      out.push("  Fix by backfilling the log entry if the release was real, or by removing the history");
      out.push("  row if it never was — an operator decision either way; this never edits it.");
    }
    ctx.write(out.join("\n") + "\n");
  }
  // Exit 10 on a pending release so a hook or sequence step can gate on it; a dirty
  // tree alone is not a failure (the operator may be mid-change and only checking).
  finish(pending.commits.length || pending.files.length || uncommitted.length ? 10 : 0);
}

export function commitLocally(ctx, version, when) {
  const out = [];
  const ownRepo = targetIsOwnRepo(ctx);
  const coreBranch = ownRepo ? git(ctx, ["branch", "--show-current"], ctx.SRC_ABS).out : null;
  const rootBranch = git(ctx, ["branch", "--show-current"]).out;
  const blocked = [];
  if (isProtected(coreBranch)) blocked.push(`the core is on '${coreBranch}'`);
  if (isProtected(rootBranch)) blocked.push(`this repo is on '${rootBranch}'`);

  if (blocked.length && !ctx.ALLOW_PROTECTED) {
    return {
      committed: false,
      blocked: true,
      lines: [
        `  NOT COMMITTED: ${blocked.join(" and ")} — protected.`,
        "  A release commit is still a commit, and CLAUDE.md's protected-branch rule holds in every",
        "  repo a run touches. Move onto a work branch, or re-run with --allow-protected if landing",
        "  on the protected branch is deliberate.",
      ],
    };
  }
  if (blocked.length) out.push(`  --allow-protected: committing anyway (${blocked.join(", ")}).`);

  const tag = `v${version}`;
  if (!ownRepo) {
    // A target that is a plain directory inside this repo has no history of its own; its content
    // rides in the root commit below. Committing "in the core" would silently commit the ROOT repo.
    out.push("  core:  not its own git repository — its content lands in this repo's commit instead");
  } else {
    const managed=[...new Set([...(ctx.plan.root_structure?.entries??[]),...(ctx.previousRootStructure?.entries??[])]
      .filter(row=>row.included && row.kind!=='directory').map(row=>row.path))];
    const commit = commitManagedPaths(ctx.SRC_ABS,managed,`chore(release): framework core ${tag}`);
    if (!commit.ok && !/nothing to commit/i.test(commit.out + commit.err)) {
      return { committed: false, error: `core commit failed: ${commit.err || commit.out}` };
    }
    const head = git(ctx, ["rev-parse", "HEAD"], ctx.SRC_ABS);

    // A tag that already exists is NOT a benign note. Left alone it keeps naming an older commit,
    // so the release the tag points at is not the tree that just passed the gates — which is
    // exactly how v2.0.0 ended up 53 files away from its own tag while the run exited 0. Only a
    // tag that already names THIS commit is benign; anything else is a stop or an explicit --reland.
    const existing = git(ctx, ["rev-list", "-n", "1", tag], ctx.SRC_ABS);
    if (existing.ok && existing.out && existing.out !== head.out) {
      if (!ctx.RELAND) {
        return {
          committed: false,
          error:
            `tag ${tag} already exists and points at ${existing.out.slice(0, 7)}, not the release ` +
            `commit ${(head.out || "").slice(0, 7)}. Moving a released tag is not something this ` +
            `script does on its own — re-run with --reland to move it, or cut a new version.`,
        };
      }
      const moved = git(ctx, ["tag", "-f", "-a", tag, "-m", `framework core ${tag}`], ctx.SRC_ABS);
      if (!moved.ok) return { committed: false, error: `could not move tag ${tag}: ${moved.err || moved.out}` };
      out.push(`  core:  committed on '${coreBranch || "(detached)"}', tag ${tag} MOVED ` +
        `${existing.out.slice(0, 7)} → ${(head.out || "").slice(0, 7)} (--reland)`);
    } else if (existing.ok && existing.out) {
      out.push(`  core:  committed on '${coreBranch || "(detached)"}', tag ${tag} already on this commit`);
    } else {
      const tagged = git(ctx, ["tag", "-a", tag, "-m", `framework core ${tag}`], ctx.SRC_ABS);
      if (!tagged.ok) {
        return { committed: false, error: `tag ${tag} could not be created: ${tagged.err || tagged.out}` };
      }
      out.push(`  core:  committed + tagged ${tag} on '${coreBranch || "(detached)"}'`);
    }
  }

  // Register the moved submodule in this repo, then commit the gitlink together with the
  // release log — they describe the same event and must not land in separate commits.
  const rootPaths=[ctx.LOG_REL,ctx.STATE_REL];
  if(!ctx.SRC_REL.startsWith('..'+sep) && ctx.SRC_REL!=='..') {
    if(ownRepo && git(ctx,['ls-files','--stage','--',ctx.SRC_REL]).out.startsWith('160000 ')) rootPaths.push(ctx.SRC_REL);
    else if(!ownRepo) for(const row of [...(ctx.plan.root_structure?.entries??[]),...(ctx.previousRootStructure?.entries??[])]) {
      if(row.included && row.kind!=='directory')rootPaths.push(join(ctx.SRC_REL,row.path));
    }
  }
  const rootCommit = commitManagedPaths(ctx.ROOT,rootPaths,`chore(framework): bump ${ctx.RUNTIME_NAME} core gitlink to ${tag}`);
  if (rootCommit.ok) out.push(`  root:  committed the gitlink bump + release log on '${rootBranch}'`);
  else if (/nothing to commit/i.test(rootCommit.out + rootCommit.err)) out.push("  root:  nothing to commit (gitlink already current)");
  else return { committed: false, error: `root commit failed: ${rootCommit.err || rootCommit.out}` };

  return { committed: true, lines: out, tag, when };
}

/** Exact paths only: unrelated staged work must survive in both repositories. */
export function commitManagedPaths(cwd, paths, message) {
  const safe=[...new Set(paths)].filter(p=>typeof p==='string' && p && !isAbsolute(p)
    && !p.split(/[\\/]/).includes('..'));
  if(!safe.length)return {ok:false,out:'',err:'no managed release paths to commit'};
  // An already-pruned path can be absent from both disk and index.
  const tracked=spawnSync('git',['ls-files','-z'],{cwd,encoding:'utf8'});
  const known=new Set((tracked.stdout||'').split('\0'));
  const selected=safe.filter(p=>existsSync(join(cwd,p))||known.has(portable(p)));
  if(!selected.length)return {ok:true,out:'nothing to commit',err:''};
  const input=selected.map(portable).join('\0')+'\0';
  const exec=args=>{
    const r=spawnSync('git',['--literal-pathspecs',...args,'--pathspec-from-file=-','--pathspec-file-nul'],{cwd,input,encoding:'utf8'});
    return {ok:r.status===0,out:r.stdout||'',err:r.stderr||''};
  };
  const added=exec(['add','-A']);if(!added.ok)return added;
  return exec(['commit','--only','-m',message]);
}

export async function doVerify(ctx) {
  const inheritAbs = join(ctx.ROOT, INHERIT_REL);
  ctx.write(`Verifying ${portable(ctx.SRC_REL)}\n\n`);
  const { gates, failed } = await runGates(ctx, inheritAbs);
  for (const g of gates) {
    ctx.write(`  ${g.result.padEnd(8)} ${g.name}${g.note ? ` — ${g.note}` : ""}\n`);
  }
  if (failed) {
    ctx.warn(`\n${failed.name} FAILED — ${failed.note || ""}\n${failed.tail ? failed.tail + "\n" : ""}`);
    finish(1);
  }
  ctx.write("\nEvery gate passed — this core is publishable.\n");
  finish(0);
}

export function previousReleaseServed(ctx) {
  if (!targetIsOwnRepo(ctx)) return null;
  const last = lastRelease(readJson(ctx, ctx.STATE_REL));
  if (!last) return null;
  const res = verifyRemote(ctx);
  const tag = res.checks.find((c) => c.ref.startsWith("refs/tags/"));
  // No tag check at all means verifyRemote returned early — no origin, or ls-remote failed.
  if (!tag) {
    const why = res.checks[0] ? res.checks[0].detail : "the remote could not be queried";
    return { ok: false, version: String(last.version), detail: why, blocking: false };
  }
  return { ok: tag.ok, version: String(last.version), detail: tag.detail, blocking: !tag.ok };
}

export async function doPublish(ctx) {
  // Publishing writes candidate files and the source ledger even with --no-commit.
  // Check both owning checkouts before the forge, not merely at commit time.
  if(!ctx.DRY && !ctx.ALLOW_PROTECTED) {
    const owners=new Map();
    for(const [label,cwd] of [['source ledger',ctx.ROOT],['core target',ctx.SRC_ABS]]) {
      const top=git(ctx,['rev-parse','--show-toplevel'],cwd);
      if(!top.ok)continue;
      const branch=git(ctx,['branch','--show-current'],top.out).out;
      if(isProtected(branch))owners.set(resolve(top.out),`${label} is on '${branch}'`);
    }
    if(owners.size) {
      ctx.warn(`publish refused before any writes: ${[...owners.values()].join(' and ')} — protected. Move onto a work branch or pass --allow-protected explicitly.\n`);
      finish(4);
    }
  }
  const ver = publishedVersion(ctx);
  const { paths, skills, reasons: skillReasons, source } = corePaths(ctx);
  const head = headInfo(ctx);
  const base = ver.markerCommit || ver.stateCommit;
  const pending = pendingSince(ctx, base, paths);
  const uncommitted = uncommittedCoreFiles(ctx, paths);
  // Classify BEFORE the forge — afterwards the target holds the new content and the
  // published-versus-source comparison would report every unit as already up to date.
  const cls = await classifyBump(ctx, skills);
  const rows = deltaRows(ctx, cls);
  const bump = flag(ctx, "bump") || cls.kind;
  const explicit = flag(ctx, "version");
  const { base: versionBase, resumed, conflict } = releaseBase(ver);
  const version = explicit || bumpVersion(versionBase || "1.0.0", bump);
  const ref = flag(ctx, "ref") || "main";
  const when = nowBangkok();

  if (!version) {
    ctx.warn(
      `cannot resolve the next version: published marker is ${JSON.stringify(ver.marker)} — pass --version X.Y.Z\n`
    );
    finish(2);
  }
  if (conflict && !explicit) {
    ctx.warn(
      `version mismatch: release log says v${ver.state}, forged marker says v${ver.marker}. ` +
        `The forged core is OLDER than the log claims, so the log describes a release that is not in ` +
        `the tree. Reconcile, or pass --version X.Y.Z explicitly.\n`
    );
    finish(3);
  }

  // The previous release must be on the remote before a new one buries it (see the gate above).
  const served = previousReleaseServed(ctx);
  if (served && !served.ok) {
    const push = [
      `  git -C ${portable(ctx.SRC_REL)} push origin v${served.version}`,
      `  node bin/sidekicks core verify-remote`,
    ].join("\n");
    if (!served.blocking) {
      ctx.write(
        `NOTE: could not confirm that v${served.version} is served by the core's remote — ` +
          `${served.detail}. Continuing; run verify-remote once the remote is reachable.\n\n`
      );
    } else if (ctx.ALLOW_UNPUSHED) {
      ctx.write(
        `--allow-unpushed: cutting v${version} while v${served.version} is unpushed ` +
          `(${served.detail}).\n\n`
      );
    } else if (ctx.DRY) {
      ctx.write(
        `WOULD REFUSE: v${served.version} is a LOCAL release only — ${served.detail}. ` +
          `Push it before cutting v${version}:\n${push}\n\n`
      );
    } else {
      ctx.warn(
        `v${served.version} was released locally but the remote does not serve its tag: ` +
          `${served.detail}.\n\n` +
          `  The core's README pins installs to \`--ref v<version>\`, so a tag the remote does not\n` +
          `  carry makes that release uninstallable by the name it documents — an installer silently\n` +
          `  falls back to pinning a commit. Cutting v${version} now buries the problem one release\n` +
          `  deeper, so it is refused here instead.\n\n` +
          `  Push the previous release first:\n${push}\n\n` +
          `  Or cut this one deliberately anyway:  --allow-unpushed\n`
      );
      finish(5);
    }
  }

  // ── Already released? ─────────────────────────────────────────────────────
  // Re-publishing a released version used to be entirely undetected: the log grew a duplicate
  // section, state.json was overwritten, and the tag silently stayed on the OLD commit. Capture
  // the baseline HERE, before the forge overwrites the target — rung 2 of referenceContent()
  // reads the tree that is about to be destroyed.
  const stateNow = readJson(ctx, ctx.STATE_REL);
  ctx.previousRootStructure=lastRelease(stateNow)?.root_structure;
  // A FORGED MARKER IS NOT A RELEASE ON ITS OWN. publish forges and stamps BEFORE it gates, so a run
  // that fails a gate leaves `.sidekicks-core.json` claiming a version that was never released — no
  // log entry, no state record, no tag, no commit. releaseBase() already reasons exactly this way when
  // picking the bump base ("The stamped version was never released"); this check did not, and it took
  // `ver.marker === version` as proof.
  //
  // The consequence was that a FIRST-EVER release could not be retried. The failed attempt's own
  // marker made the retry look like a re-land, and a re-land needs --reland, which is the operator's
  // explicit per-invocation yes and never self-granted — so the run was stuck with nothing published
  // and no non-operator way forward.
  //
  // So the marker's claim is believed only when something CORROBORATES it: a state/log record of any
  // release, or that version's tag. Releases cut before content_hash existed still wrote both.
  //
  // The corroboration is deliberately attached to the MARKER clause rather than replacing it. Making
  // a bare tag mean "already released" on its own looks tidier and is wrong: it short-circuits the
  // tag-safety stop further down, which exists precisely to catch a tag that already names a
  // DIFFERENT commit and says so with a message this refusal cannot give.
  const markerCorroborated = ver.marker === version
    && (Boolean(lastRelease(stateNow))
      || (targetIsOwnRepo(ctx) && git(ctx, ["rev-parse", "-q", "--verify", `refs/tags/v${version}`], ctx.SRC_ABS).ok));
  const alreadyReleased = releasedVersions(stateNow).has(version) || markerCorroborated;
  const reference = alreadyReleased && !ctx.DRY ? referenceContent(ctx, version, stateNow, ver) : null;

  // A digest recorded in state.json proves WHETHER a re-forge diverged but cannot say WHICH paths
  // did — and that is the usual baseline. When the tree still on disk hashes to that same digest it
  // IS the released content, so borrow its per-file map now, before the forge overwrites it, and a
  // refusal can name the files instead of two opaque hashes.
  if (reference && !reference.files) {
    const onDisk = normalizedTreeHash(ctx.SRC_ABS);
    if (onDisk.digest === reference.digest) reference.files = onDisk.files;
  }

  if (alreadyReleased && !ctx.RELAND && !ctx.DRY && !reference) {
    ctx.warn(
      `v${version} has already been released, and there is no recorded baseline to check a re-forge ` +
        `against (no content_hash in ${portable(ctx.STATE_REL)}, and the target on disk is not a clean ` +
        `v${version} tree). Refusing rather than silently appending a second v${version} to the log ` +
        `and leaving the tag where it is.\n\n` +
        `  Note: a PREVIOUS refused re-publish may itself be why the core is dirty — it forges before\n` +
        `  it compares, so the second run finds the tree it wrote rather than the released one. Only\n` +
        `  releases cut before content_hash existed depend on that on-disk fallback.\n\n` +
        `  Re-land it deliberately:  --version ${version} --reland\n` +
        `  Or cut a new version:     omit --version, or pass a higher one\n`
    );
    finish(3);
  }

  const inherit = portable(INHERIT_REL);
  const forgeArgs = [
    "create",
    "--name",
    ctx.RUNTIME_NAME,
    "--target",
    portable(ctx.SRC_REL),
    "--preset",
    ctx.PRESET,
    // Explicit, not inferred. The engine turns --as-core on by itself only for `--preset framework`,
    // so the day this script stopped forging that preset the core-distribution files (the
    // .sidekicks-core.json marker, install.sh, install.ps1, AGENTS.framework.md, the generated
    // README) would have silently stopped travelling. What is published is a mountable core whatever
    // skill set it carries, so the flag says so rather than riding on the preset name.
    "--as-core",
    "--pack-skills",
    ctx.PACK_SKILLS,
    "--force",
    "--prune-skills",
    "--core-version",
    version,
    "--core-ref",
    ref,
    "--remote",
    ctx.REMOTE,
  ];
  const forgeCmd = `node ${inherit} \\\n  ${forgeArgs.join(" ").replace(/ --/g, " \\\n  --")}`;

  const out = [];
  out.push(`Publishing framework core v${version}${ctx.DRY ? " (dry run — nothing written)" : ""}`);
  out.push(`  from:   ${head.sha}${head.branch ? ` (${head.branch})` : ""}${head.dirty ? " — working tree DIRTY" : ""}`);
  out.push(`  target: ${portable(ctx.SRC_REL)}`);
  out.push(
    `  since:  ${base ? `v${ver.marker} (${base})` : "no baseline"} — ${pending.commits.length} commit(s), ` +
      `${pending.files.length} committed file(s), ${uncommitted.length} uncommitted file(s)`
  );
  out.push(
    `  class:  ${bump.toUpperCase()}` +
      (explicit ? " (explicit --version)" : flag(ctx, "bump") ? " (explicit --bump)" : ` — ${cls.reasons.join("; ")}`)
  );
  if (resumed) {
    out.push(
      `  resume: the marker says v${ver.marker} but the log's last release is v${ver.state} — a previous ` +
        `publish forged and stamped, then a gate failed. Deriving from the LOG, so that number is reused.`
    );
  }
  out.push("");
  out.push(`  resolved skills (from ${source}):`);
  out.push(...renderSkillReasons(skillReasons));
  out.push("");
  out.push(`  units added, removed, or version-bumped (inventory from ${cls.inventory_source}):`);
  out.push(...renderDelta(rows));
  out.push("");

  if (head.dirty) {
    // Not fatal: the forge copies the WORKING TREE, so publishing from a dirty tree is
    // legitimate. But the log records a commit that does not contain those edits, so the
    // release would not be reproducible from that sha — say so loudly.
    out.push(
      "  WARNING: the working tree is dirty. The forge copies working-tree content, but the log"
    );
    out.push(
      `  records ${head.sha}, which does NOT contain the uncommitted edits — the release will not be`
    );
    out.push("  reproducible from that commit. Commit first unless this is deliberate.");
    out.push("");
  }

  if (alreadyReleased) {
    out.push(
      ctx.RELAND
        ? `  reland: v${version} is already released — its log entry will be REPLACED and its tag moved.`
        : `  NOTE:   v${version} is already released. The forge will be compared against the recorded` +
          ` release after the gates; identical means nothing is written, different means this stops.`
    );
    out.push("");
  }

  if (ctx.DRY) {
    out.push("Would run:");
    out.push("");
    out.push(forgeCmd);
    out.push("");
    out.push(
      ctx.RELAND
        ? `Would REPLACE the ## v${version} section in ${portable(ctx.LOG_REL)} with:`
        : `Would append to ${portable(ctx.LOG_REL)}:`
    );
    out.push("");
    out.push(
      // coreDiff is null: the forge has not run, so there is no forged tree to diff against.
      renderLogEntry({ version, prevVersion: ver.marker, head: head.sha, branch: head.branch, pending, uncommitted, when, forgeCmd, surfaceSource: source, cls, rows, gates: null, coreDiff: null })
    );
    ctx.write(out.join("\n") + "\n");
    finish(0);
  }

  // The tree as it stands BEFORE the forge overwrites it. This is the only moment it can be
  // captured, and it is what turns the log's file list from "what changed in the SOURCE repo" into
  // "what changed in the CORE" — two different questions the log used to answer with one list, which
  // is how v1.4.1's entry came to name AGENTS.md as shipped when the forged core carried no such
  // change. `coreTreeClean()` decides whether the snapshot is the previous release's tree or merely
  // whatever is on disk; the entry SAYS which, rather than presenting a dirty diff as an exact one.
  //
  // Deliberately a second walk rather than reusing the opportunistic snapshot at the already-released
  // check above: that one sits before this function's dry-run exit and before the no-baseline
  // refusal, and hoisting it would move a filesystem walk across both.
  const preForge = normalizedTreeHash(ctx.SRC_ABS);
  // "Is this tree the previous release?" is a cleanliness question, and which repo answers it
  // depends on who tracks the core: its own repo when it has one, otherwise this repo's index over
  // the target path. Asking only `coreTreeClean()` would call every non-submodule target dirty and
  // stamp a correct diff with a false warning.
  const preForgeDirty = targetIsOwnRepo(ctx)
    ? !coreTreeClean(ctx)
    : (() => {
        const st = git(ctx, ["status", "--porcelain", "--", ctx.SRC_REL]);
        return !st.ok || st.out !== "";
      })();

  // 1) Forge. Inherited from the working tree, one-way, prune-exact.
  out.push("── forge ───────────────────────────────────────────");
  ctx.write(out.join("\n") + "\n");
  const forgeResult = await ctx.projection(ctx.ROOT, "forge", {name:ctx.RUNTIME_NAME,target:ctx.SRC_REL,preset:ctx.PRESET,"pack-skills":ctx.PACK_SKILLS,"as-core":true,force:true,"prune-skills":true,"core-version":version,"core-ref":ref,remote:ctx.REMOTE,"allow-protected":ctx.ALLOW_PROTECTED});
  ctx.write(forgeResult.stdout); ctx.warn(forgeResult.stderr);
  const forge = {status:forgeResult.exitCode};
  if (forge.status !== 0) {
    ctx.warn(`\nforge FAILED (exit ${forge.status}) — nothing logged, no version stamped.\n`);
    finish(forge.status || 1);
  }

  // 2) Verify — five gates (self-containment, the doctors inside the core, its own test
  //    suite, post-forge drift, and a real mount). A core that does not verify is not a
  //    release, so the log entry is written only after every gate has passed.
  ctx.write("\n── verify ──────────────────────────────────────────\n");
  const { gates, failed } = await runGates(ctx, join(ctx.ROOT, INHERIT_REL));
  for (const g of gates) {
    ctx.write(`  ${g.result.padEnd(8)} ${g.name}${g.note ? ` — ${g.note}` : ""}\n`);
  }
  if (failed) {
    ctx.warn(
      `\n${failed.name} FAILED — ${failed.note || ""}\n${failed.tail ? failed.tail + "\n" : ""}` +
        `\nThe core was forged but is NOT publishable, so no log entry was written and nothing was ` +
        `committed. Fix, then re-run publish.\n`
    );
    finish(1);
  }

  // 2b) Reproducibility gate — only when this version was already released.
  //     Everything above proves the forged core is GOOD. This proves it is the SAME good core the
  //     version already names. It runs after the gates and before the first write, so a divergent
  //     re-forge costs a forge but never a log entry, a state overwrite, a commit or a tag.
  const forged = normalizedTreeHash(ctx.SRC_ABS);
  if (reference) {
    const same = reference.digest === forged.digest;
    ctx.write(
      `  ${(same ? "pass" : "FAIL").padEnd(8)} matches the released v${version} ` +
        `— baseline: ${reference.source}\n`
    );
    if (same && !ctx.RELAND) {
      ctx.write(
        `\nv${version} is already released and this forge is identical to it (wall-clock timestamps ` +
          `ignored).\nNothing to do — no log entry, no state change, no commit, no tag.\n`
      );
      finish(0);
    }
    if (!same && !ctx.RELAND) {
      const diff = reference.files ? hashDiff(reference.files, forged.files) : [];
      ctx.warn(
        `\nv${version} is already released, but this forge DIFFERS from the released content ` +
          `(baseline: ${reference.source}).\n` +
          `Publishing would put two different trees behind one version number.\n` +
          (diff.length
            ? `\n  differing paths (${diff.length}):\n${diff.slice(0, 40).map((d) => `    ${d}`).join("\n")}\n` +
              (diff.length > 40 ? `    … and ${diff.length - 40} more\n` : "")
            : `\n  recorded digest ${reference.digest.slice(0, 12)} vs forged ${forged.digest.slice(0, 12)} ` +
              `(per-file detail is unavailable when the baseline came from state.json)\n`) +
          `\nCut a new version instead, or re-land deliberately with ` +
          `--version ${version} --reland.\n`
      );
      finish(5);
    }
  }

  // What this release changed IN THE CORE, from the two forged-tree hashes. `baseline` is carried
  // with it so the entry can qualify itself instead of overstating: only a clean core repo whose
  // marker names the previous release makes `preForge` that release's tree.
  const coreDiff = {
    rows: preForge.digest ? hashDiff(preForge.files, forged.files) : [],
    // "none" keys off the MARKER, not off an empty directory: what makes a diff meaningful is a
    // previously published core to diff against, and a target carrying stray files but no marker
    // has none. Reporting those strays as a release delta would be the same overstatement in a new
    // place.
    baseline: !ver.marker || !preForge.digest
      ? "none"
      : preForgeDirty
        ? "on-disk-dirty"
        : "previous-release",
    baselineVersion: ver.marker || null,
    fileCount: Object.keys(forged.files).length,
  };

  // 3) Auto log + state. Both under the service root, both portable-path only.
  mkdirSync(join(ctx.ROOT, ctx.RUN_REL), { recursive: true });
  const logPath = join(ctx.ROOT, ctx.LOG_REL);
  if (!existsSync(logPath)) writeFileSync(logPath, LOG_HEADER);
  const entry = renderLogEntry({ version, prevVersion: ver.marker, head: head.sha, branch: head.branch, pending, uncommitted, when, forgeCmd, surfaceSource: source, cls, rows, gates, coreDiff });
  if (ctx.RELAND) upsertLogEntry(logPath, version, entry);
  else appendFileSync(logPath, entry);

  const prevState = readJson(ctx, ctx.STATE_REL) || {};
  const history = Array.isArray(prevState.history) ? prevState.history : [];
  if (ver.marker && ver.markerCommit && !history.some((h) => h.version === ver.marker)) {
    // Carry the superseded release's content_hash into history too, so a much later re-publish of
    // an old version still has a baseline to check against (rung 1 of referenceContent).
    const prev = lastRelease(prevState);
    const carried =
      prev && String(prev.version) === String(ver.marker) && prev.content_hash
        ? { content_hash: String(prev.content_hash) }
        : {};
    history.push({ version: ver.marker, source_commit: ver.markerCommit, ...carried });
  }
  writeFileSync(
    join(ctx.ROOT, ctx.STATE_REL),
    JSON.stringify(
      {
        schema: 3,
        comment:
          "Framework-core release state. Written by sidekicks core publish; paths are "
          + "repo-relative. `last_local_release` is what `publish` cut — it forges, gates, commits "
          + "and tags, all local and all reversible, and never pushes — so its presence is NOT "
          + "evidence that any remote serves this version. That evidence is `remote_verified`, "
          + "written by `verify-remote`, and by `release`/`ship` once they have pushed and "
          + "re-checked. schema 2 carries no `remote_release`; schema 3 adds it, recording which "
          + "refs a release actually pushed and which merges it deliberately left to the operator. "
          + "`remote_release.merges_outstanding` is READ BACK by verify-remote, which resolves each "
          + "entry against the remote and prunes the ones that have landed, and by `status`, which "
          + "renders what is left. SERVED and ADVERTISED are different facts: SERVED means the tag "
          + "and the release branch are on the remote; ADVERTISED means the core's `main` carries "
          + "them too, which is what the README one-liner actually fetches.",
        runtime: ctx.RUNTIME_NAME,
        target_rel: portable(ctx.SRC_REL),
        // Renamed from `last_publish` (F-13): local state called v2.0.0 "published" while the
        // GitHub remote still served v1.1.5 and carried no v2.0.0 tag. The reader still accepts
        // the old key, so an existing state file keeps classifying correctly.
        last_local_release: {
          root_structure: sealRootStructure(ctx.SRC_ABS,ctx.plan.root_structure),
          version,
          source_commit: head.sha,
          source_branch: head.branch || null,
          // Where the CORE's own release commit lands, which is a different repository's branch
          // namespace from `source_branch` above. Recorded because verify-remote had nothing else to
          // check and reached for `source_branch` — asking the core's remote for a branch that only
          // ever existed in THIS repo, so the check could pass only while both happened to be called
          // `main`. `core_ref` is not it either: that is the `--ref` INPUT (default 'main'), not
          // where the commit went. Read here rather than after commitLocally() because the branch is
          // already decided — that function reads the same value to make the same commit.
          core_branch: targetIsOwnRepo(ctx) ? (git(ctx, ["branch", "--show-current"], ctx.SRC_ABS).out || null) : null,
          core_ref: ref,
          published_at: when.stamp,
          commits: pending.commits.length,
          files: pending.files.length,
          working_tree_dirty: head.dirty,
          uncommitted_core_files: uncommitted.length,
          bump_class: bump,
          bump_reasons: cls.reasons,
          // sha256 over the forged tree with wall-clock timestamps masked out (normalizedTreeHash).
          // This is the baseline a later re-publish of this same version is checked against — it is
          // what makes "the same version always forges the same core" an enforced invariant rather
          // than a hope. Absent on releases cut before this field existed; the reader falls back.
          content_hash: forged.digest,
          // The inventory THIS release shipped. Recording it is what lets the next run
          // classify against what was actually published rather than re-deriving it from a
          // forged tree that has since been overwritten.
          skills: cls.source.skills || [],
          lib: cls.source.lib || [],
          packs: cls.source.packs || [],
          configuration: cls.source.configuration || [],
          gates: gates.map((g) => ({ name: g.name, result: g.result, note: g.note || null })),
        },
        // Null until the release is pushed AND re-checked — by `release`/`ship`, or by a bare
        // `verify-remote` after a hand push. Absence means "not verified", never "verified false"
        // — the distinction matters, because the failure this records was reporting an unpushed
        // release as published.
        remote_verified: sameVersion(prevState.remote_verified, version)
          ? prevState.remote_verified
          : null,
        // Carried forward on the SAME terms, and for the same reason. This object is written whole,
        // so anything not named here is dropped — and `remote_check` and `remote_release` used to be
        // exactly that: a `publish` after a `release` silently erased both, taking the outstanding
        // merge record with them. A re-publish of the SAME version leaves them true (the refs it
        // pushed and the merges it owed have not changed); a new version genuinely invalidates both,
        // and they go back to null rather than describing the wrong release.
        remote_check: sameVersion(prevState.remote_check, version) ? prevState.remote_check : null,
        remote_release: sameVersion(prevState.remote_release, version) ? prevState.remote_release : null,
        history,
      },
      null,
      2
    ) + "\n"
  );

  // 4) Land it locally. Committing and tagging are reversible and local; PUSHING is
  //    neither, so it stays printed — publishing a core to other people is the operator's
  //    call (CLAUDE.md § irreversible / outward-facing actions).
  const steps = [
    "",
    "── forged and verified. Release log updated: ────────",
    `  ${portable(ctx.LOG_REL)}`,
    `  ${portable(ctx.STATE_REL)}`,
    "",
  ];

  let landed = null;
  if (ctx.NO_COMMIT) {
    steps.push("  --no-commit: nothing was committed. The steps below are yours to run.");
  } else {
    landed = commitLocally(ctx, version, when);
    if (landed.error) {
      steps.push(`  COMMIT FAILED: ${landed.error}`);
      steps.push("  The forge and the log stand; land them by hand with the steps below.");
    } else if (landed.blocked) {
      steps.push(...landed.lines);
    } else {
      steps.push("── committed locally (nothing pushed) ──────────────");
      steps.push(...landed.lines);
    }
  }

  const pushOnly = Boolean(landed && landed.committed);
  steps.push("");
  steps.push(
    pushOnly
      ? "Remaining step is OUTWARD-FACING and is not run for you:"
      : "Remaining steps are OUTWARD-FACING or were not run for you:"
  );
  steps.push("");
  steps.push("Finish it in one step, which pushes the TAG FIRST and then PROVES the remote serves it:");
  steps.push("");
  steps.push("```sh");
  steps.push(`node bin/sidekicks core release          # the plan, pushes nothing`);
  steps.push(`node bin/sidekicks core release --yes    # actually push`);
  steps.push("```");
  steps.push("");
  steps.push("or by hand:");
  steps.push("");
  steps.push("```sh");
  if (!pushOnly) {
    steps.push(`# 1) commit + tag inside the core submodule`);
    steps.push(`git -C ${portable(ctx.SRC_REL)} add -A`);
    steps.push(`git -C ${portable(ctx.SRC_REL)} commit -m "chore(release): framework core v${version}"`);
    steps.push(`git -C ${portable(ctx.SRC_REL)} tag -a v${version} -m "framework core v${version}"`);
  }
  // ONE `push origin HEAD --tags` line was too easy to shorten to a bare `git push`, and that is
  // exactly how v1.1.0 and v1.1.1 reached the remote with no tag. The tag is its own step, says
  // why it is not optional, and the verification that proves it landed is printed with it.
  steps.push(`git -C ${portable(ctx.SRC_REL)} push origin HEAD`);
  steps.push(
    `git -C ${portable(ctx.SRC_REL)} push origin v${version}   ` +
      `# NOT optional — the README pins installs to --ref v${version}`
  );
  if (!pushOnly) {
    steps.push("");
    steps.push(`# 2) register the service state in this repo`);
    steps.push(`node bin/sidekicks service sync`);
    steps.push(`node bin/sidekicks index rebuild`);
    steps.push("");
    steps.push(`# 3) commit the gitlink bump + the release log here`);
    steps.push(`git add ${portable(ctx.SRC_REL)} ${portable(ctx.RUN_REL)}`);
    steps.push(`git commit -m "chore(framework): bump ${ctx.RUNTIME_NAME} core gitlink to v${version}"`);
  }
  steps.push("");
  steps.push(`# ${pushOnly ? "2" : "4"}) prove the remote actually serves it`);
  steps.push(`node bin/sidekicks core verify-remote`);
  steps.push("```");
  steps.push("");
  // The step the hand block never had, and half of why the release stalled: the gitlink bump and
  // the release log sat on a work branch that was pushed nowhere, so this repo's own record of the
  // release was as unpublished as the tag.
  steps.push("Then, in BOTH repos — this script never pushes to a protected branch:");
  steps.push("");
  steps.push(`    core:   merge the release branch into main   (publishes README.md + install.sh)`);
  steps.push(`    source: push this work branch and merge it   (lands the gitlink bump + the log)`);
  ctx.write(steps.join("\n") + "\n");
  // A blocked or failed local commit is not a failed release — the core is forged, verified
  // and logged — but it is unfinished, so it must not exit 0 into an unattended sequence.
  finish(landed && !landed.committed ? 4 : 0);
}

export async function selfRun(ctx, args) {
  const [verb,...argv]=args;
  const flags={};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i].replace(/^--/,'');
    flags[key]=argv[i+1] && !argv[i+1].startsWith('--')?argv[++i]:true;
  }
  const engine=createReleaseEngine({repoRoot:ctx.ROOT,flags,projection:ctx.projection,verificationDepth:ctx.verificationDepth});
  const result=await engine[verb]();ctx.write(result.stdout);ctx.warn(result.stderr);
  return result.exitCode;
}

export function shipPassthru(ctx, drop = []) {
  const out = [];
  const verbAt = ctx.argv.indexOf(ctx.VERB);
  for (let i = 0; i < ctx.argv.length; i += 1) {
    if (i === verbAt) continue;
    if (drop.includes(ctx.argv[i])) continue;
    out.push(ctx.argv[i]);
  }
  return out;
}

export async function doShip(ctx) {
  const yes = has(ctx, "yes");
  const state = readJson(ctx, ctx.STATE_REL) || {};
  const last = lastRelease(state);

  // ── refuse a dirty tree, in EITHER repo ───────────────────────────────────
  const dirty = [];
  const rootStatus = git(ctx, ["status", "--porcelain"]);
  // Only paths that would actually travel: an unrelated dirty gitlink elsewhere in the repo is not
  // this release's business, and refusing on it would make `ship` unusable in a real checkout.
  const bound = corePaths(ctx).paths;
  // NOT `line.slice(3)`: git() trims its output, so the FIRST line has already lost the leading
  // space of its two-column status and a fixed offset cuts into the path. Match the columns
  // instead, and take the destination half of a rename.
  const porcelainPath = (line) => {
    const m = /^\s*\S{1,2}\s+(.+)$/.exec(line);
    if (!m) return null;
    const rel = m[1].trim();
    const arrow = rel.indexOf(" -> ");
    return arrow === -1 ? rel : rel.slice(arrow + 4);
  };
  for (const line of (rootStatus.out || "").split("\n")) {
    const rel = porcelainPath(line);
    if (!rel) continue;
    if (bound.some((p) => rel === p || rel.startsWith(`${p}/`))) dirty.push(`this repo: ${rel}`);
  }
  if (targetIsOwnRepo(ctx) && !coreTreeClean(ctx)) {
    for (const line of (git(ctx, ["status", "--porcelain"], ctx.SRC_ABS).out || "").split("\n")) {
      const rel = porcelainPath(line);
      if (rel) dirty.push(`core: ${rel}`);
    }
  }
  if (dirty.length) {
    ctx.warn(
      `${dirty.length} core-bound file(s) are uncommitted, so this release would not be `
        + "reproducible from the commit its log records — the forge copies the WORKING TREE.\n\n"
        + dirty.slice(0, 20).map((d) => `    ${d}`).join("\n") + "\n"
        + (dirty.length > 20 ? `    … and ${dirty.length - 20} more\n` : "")
        + "\n  Commit them (or stash-free move them to another branch) and re-run. Deciding what "
        + "belongs\n  in a release is not something this command guesses at.\n"
    );
    finish(3);
  }

  // ── what would happen ─────────────────────────────────────────────────────
  const ver = publishedVersion(ctx);
  const head = headInfo(ctx);
  const { paths, skills } = corePaths(ctx);
  const pending = pendingSince(ctx, ver.markerCommit || ver.stateCommit, paths);
  const owed = pending.commits.length > 0 || pending.files.length > 0;
  const cls = await classifyBump(ctx, skills);
  const nextVersion = flag(ctx, "version") || bumpVersion(releaseBase(ver).base, flag(ctx, "bump") || cls.kind);

  const rootBranch = head.branch;
  const coreBranch = targetIsOwnRepo(ctx) ? git(ctx, ["branch", "--show-current"], ctx.SRC_ABS).out : null;
  const branchName = flag(ctx, "branch") || "chore/framework-core-release";
  const moves = [];
  if (isProtected(rootBranch)) moves.push({ what: "this repo", from: rootBranch });
  if (coreBranch && isProtected(coreBranch)) moves.push({ what: "the core", from: coreBranch });

  const servedAlready = Boolean(
    state.remote_verified && last && String(state.remote_verified.version) === String(last.version)
  );

  const plan = [];
  plan.push(`ship — ${ctx.RUNTIME_NAME}`);
  plan.push("");
  if (last) {
    plan.push(`  already cut:  v${last.version} — ${servedAlready ? "served by the remote" : "NOT served yet; it is pushed first"}`);
  }
  plan.push(owed
    ? `  to cut:       v${nextVersion} — ${(flag(ctx, "bump") || cls.kind).toUpperCase()}, ${pending.commits.length} commit(s), ${pending.files.length} file(s)`
    : "  to cut:       nothing — no core-bound change since the last release");
  for (const m of moves) plan.push(`  branch move:  ${m.what}: '${m.from}' is protected → switch -c ${branchName}`);
  plan.push("");
  plan.push("  then: publish (forge, 6 gates, log, commit + tag locally)");
  plan.push("        release (push the TAG first, then the branch, then verify the remote serves it)");

  if (!owed && servedAlready) {
    ctx.write(`${plan.join("\n")}\n\nNothing to publish and nothing unserved — the remote is up to date.\n`);
    finish(0);
  }

  if (!yes) {
    plan.push("");
    plan.push("Nothing was done. This ends in an irreversible outward push, so it needs your");
    plan.push("explicit yes — never self-granted:");
    plan.push("");
    plan.push("```sh");
    plan.push(`node bin/sidekicks core ship --yes${flag(ctx, "bump") ? ` --bump ${flag(ctx, "bump")}` : ""}`);
    plan.push("```");
    ctx.write(`${plan.join("\n")}\n`);
    finish(0);
  }

  ctx.write(`${plan.join("\n")}\n`);

  // Preflight EVERY moving checkout before moving any HEAD. Core-bound cleanliness
  // above is insufficient: unrelated tracked work must not be carried to another branch.
  for (const m of moves) {
    const cwd = m.what === "the core" ? ctx.SRC_ABS : ctx.ROOT;
    const status = git(ctx, ["status", "--porcelain", "-z", "--untracked-files=no"], cwd);
    if (!status.ok || status.out) {
      ctx.warn(`ship refuses to move ${m.what}: tracked changes exist or status could not be checked. No branch was moved.\n`);
      finish(3);
    }
    const valid = git(ctx, ["check-ref-format", "--branch", branchName], cwd);
    const existing = git(ctx, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], cwd);
    if (!valid.ok || existing.ok) {
      ctx.warn(`ship refuses to move ${m.what}: branch '${branchName}' already exists or is invalid. No branch was moved.\n`);
      finish(4);
    }
  }

  // ── 0. create a new work branch; never reset an existing branch.
  for (const m of moves) {
    const cwd = m.what === "the core" ? ctx.SRC_ABS : ctx.ROOT;
    ctx.write(`\n── branch: ${m.what} → ${branchName} ─────────────────\n`);
    const sw = git(ctx, ["switch", "-c", branchName], cwd);
    if (!sw.ok) {
      ctx.warn(`could not move ${m.what} onto ${branchName}: ${sw.err || sw.out}\n`);
      finish(4);
    }
  }

  // ── 1. serve what is already cut, so publish's previous-release gate can pass.
  if (last && !servedAlready) {
    ctx.write("\n── serving the previous release ────────────────────\n");
    const code = await selfRun(ctx, ["release", ...shipPassthru(ctx)]);
    if (code !== 0) finish(code);
  }

  // ── 2. cut it.
  if (owed) {
    ctx.write("\n── publish ─────────────────────────────────────────\n");
    const code = await selfRun(ctx, ["publish", ...shipPassthru(ctx, ["--yes"])]);
    if (code !== 0) finish(code);

    // ── 3. serve it.
    ctx.write("\n── serving it ──────────────────────────────────────\n");
    const served = await selfRun(ctx, ["release", ...shipPassthru(ctx)]);
    if (served !== 0) finish(served);
  }

  ctx.write("\nshipped.\n");
  finish(0);
}

export function remoteRefs(ctx) {
  const url = git(ctx, ["remote", "get-url", "origin"], ctx.SRC_ABS);
  if (!url.ok || !url.out) {
    return { ok: false, url: null, detail: "the core has no 'origin' remote — nothing to verify against" };
  }
  const ls = git(ctx, ["ls-remote", url.out], ctx.SRC_ABS);
  if (!ls.ok) {
    return {
      ok: false,
      url: url.out,
      detail: `could not reach the remote: ${ls.err.split("\n").pop() || "ls-remote failed"}`,
    };
  }
  /** @type {Map<string,string>} */
  const refs = new Map();
  for (const line of ls.out.split("\n")) {
    const [sha, ref] = line.split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return { ok: true, url: url.out, refs };
}

export function remoteTagSha(refs, tag) {
  return refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`) || null;
}

export function unloggedTags(ctx, knownRemote = null) {
  if (!targetIsOwnRepo(ctx)) return [];
  const tags = git(ctx, ["tag", "-l", "v*"], ctx.SRC_ABS);
  const remote = knownRemote ?? remoteRefs(ctx);
  const names=new Set((tags.out||'').split(/\r?\n/).filter(Boolean));
  if(remote.ok)for(const ref of remote.refs.keys())if(/^refs\/tags\/v\d+\.\d+\.\d+$/.test(ref))names.add(ref.slice(10));

  const logged = new Set();
  const logAbs = join(ctx.ROOT, ctx.LOG_REL);
  if (existsSync(logAbs)) {
    for (const line of readFileSync(logAbs, "utf8").split("\n")) {
      const m = /^##\s+v(\d+\.\d+\.\d+)/.exec(line);
      if (m) logged.add(m[1]);
    }
  }

  const orphans = [...names].sort()
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: tag.replace(/^v/, "") }))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t.version) && !logged.has(t.version));
  if (orphans.length === 0) return [];

  return orphans.map((t) => ({
    ...t,
    served: remote.ok ? Boolean(remoteTagSha(remote.refs, t.tag)) : null,
  }));
}

export function historyWithoutLog(ctx, state) {
  const history = Array.isArray(state && state.history) ? state.history : [];
  if (history.length === 0) return [];
  const logAbs = join(ctx.ROOT, ctx.LOG_REL);
  if (!existsSync(logAbs)) return [];
  const logged = new Set();
  for (const line of readFileSync(logAbs, "utf8").split("\n")) {
    const m = /^##\s+v(\d+\.\d+\.\d+)/.exec(line);
    if (m) logged.add(m[1]);
  }
  return history
    .filter((h) => h && h.version && !logged.has(String(h.version)))
    .map((h) => ({ version: String(h.version), source_commit: h.source_commit ? String(h.source_commit) : null }));
}

export function checkLine(c) {
  const verdict = c.scored === false ? "note" : c.ok ? "ok  " : "FAIL";
  return `  ${verdict}  ${c.ref}  ${c.detail}\n`;
}

export function previousVersion(state, version) {
  const history = Array.isArray(state?.history) ? state.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (h && h.version && String(h.version) !== String(version)) return String(h.version);
  }
  return null;
}

export function verifyRemote(ctx) {
  const state = readJson(ctx, ctx.STATE_REL);
  const last = lastRelease(state);
  const checks = [];
  if (!last) {
    return { ok: false, advertised: null, version: null, checks: [{ ref: "(state)", expected: null, remote: null, ok: false,
      detail: `no local release recorded in ${portable(ctx.STATE_REL)} — run publish first` }] };
  }
  const version = String(last.version);
  const tag = `v${version}`;
  // The core's OWN release branch, never this repo's. `source_branch` names the workspace branch the
  // release was cut from and means nothing to the core's remote: checking it against the core told
  // v1.0.0 "the remote has no chore/sk-repos-reforge" while the remote served the release perfectly.
  // Absent on any release cut before core_branch was recorded, and an absent value is reported as
  // unknown rather than checked — a check that cannot run must not be scored either way.
  const branch = last.core_branch || null;

  // The commit the release actually landed on, read from the CORE repo's own tag/branch.
  const localTag = git(ctx, ["rev-parse", `${tag}^{commit}`], ctx.SRC_ABS);
  const expectedSha = localTag.ok ? localTag.out : null;

  const remote = remoteRefs(ctx);
  if (!remote.ok) {
    checks.push({ ref: remote.url || "origin", expected: expectedSha, remote: null, ok: false,
      detail: remote.detail });
    // `advertised` is null, not false: the remote could not be asked, and "unreachable" is not
    // "behind". The same distinction state.json's own comment makes about remote_verified.
    return { ok: false, advertised: null, version, checks };
  }
  const refs = remote.refs;

  // A tag may be annotated: refs/tags/<t> is the tag object and refs/tags/<t>^{} the commit.
  const remoteTag = remoteTagSha(refs, tag);
  checks.push({
    ref: `refs/tags/${tag}`,
    expected: expectedSha,
    remote: remoteTag,
    ok: Boolean(remoteTag) && (!expectedSha || remoteTag === expectedSha),
    detail: !remoteTag
      ? `the remote has no ${tag} — this release was never pushed`
      : expectedSha && remoteTag !== expectedSha
        ? `the remote's ${tag} points at ${remoteTag.slice(0, 12)}, the local one at ${expectedSha.slice(0, 12)}`
        : `the remote serves ${tag} at ${remoteTag.slice(0, 12)}`,
  });

  if (branch) {
    const localBranch = git(ctx, ["rev-parse", `${branch}^{commit}`], ctx.SRC_ABS);
    const remoteBranch = refs.get(`refs/heads/${branch}`) || null;
    checks.push({
      ref: `refs/heads/${branch}`,
      expected: localBranch.ok ? localBranch.out : null,
      remote: remoteBranch,
      ok: Boolean(remoteBranch) && (!localBranch.ok || remoteBranch === localBranch.out),
      detail: !remoteBranch
        ? `the remote has no ${branch}`
        : localBranch.ok && remoteBranch !== localBranch.out
          ? `the remote's ${branch} is at ${remoteBranch.slice(0, 12)}, the local one at ${localBranch.out.slice(0, 12)}`
          : `the remote's ${branch} matches the local one`,
    });
  } else {
    // Not scored. The tag is the release identity and it WAS checked above; the branch this release
    // landed on simply is not recorded, and inventing a branch name to check would be the original
    // bug in a different costume.
    checks.push({
      ref: "refs/heads/(unrecorded)",
      expected: null,
      remote: null,
      ok: true,
      // Was opted out of scoring by simply setting ok:true, which reads as "this passed". It did not
      // pass; it was not run. `scored:false` says that out loud, and the renderer prints it as
      // `note` rather than `ok` — so an unscored row can never be mistaken for a green one.
      scored: false,
      detail: "this release recorded no core branch — the tag above is what identifies it",
    });
  }

  // ── refs/heads/main — checked, never scored (see the doc comment above) ────
  const remoteMain = refs.get("refs/heads/main") || null;
  // Caught up two ways: `main` IS the release commit (the ordinary fast-forward), or `main` has
  // moved on and still CONTAINS it. The second test needs the remote's commit in the local object
  // store; when it is absent the honest answer is "cannot tell from here", not "behind".
  const mainHasRelease = Boolean(remoteMain) && Boolean(expectedSha)
    && (remoteMain === expectedSha
      || git(ctx, ["merge-base", "--is-ancestor", expectedSha, remoteMain], ctx.SRC_ABS).ok);
  const mainKnown = Boolean(remoteMain)
    && (remoteMain === expectedSha || git(ctx, ["cat-file", "-e", `${remoteMain}^{commit}`], ctx.SRC_ABS).ok);
  const prev = previousVersion(state, version);
  const stillAdvertises = prev ? `still advertises v${prev}` : "still advertises the previous release";
  checks.push({
    ref: "refs/heads/main",
    expected: expectedSha,
    remote: remoteMain,
    ok: mainHasRelease,
    scored: false,
    detail: !remoteMain
      ? "the remote has no main — nothing to advertise this release from"
      : mainHasRelease
        ? `caught up — the README one-liner advertises ${tag}`
        : mainKnown
          ? `BEHIND — merge outstanding; the README one-liner ${stillAdvertises}`
          : `BEHIND or diverged — main is at ${remoteMain.slice(0, 12)}, which is not in this clone; `
            + `the README one-liner ${stillAdvertises}`,
  });

  // Verify bytes served by the release tag, against the manifest sealed at publication.
  // Neither the source checkout nor the current target working tree is release evidence.
  const structure=verifyServedStructure(ctx,remote.url,tag,remoteTag,last.root_structure);
  checks.push({ref:'root_structure',expected:last.root_structure?.digest??null,
    remote:structure.ok?last.root_structure?.digest??null:null,ok:structure.ok,detail:structure.detail});
  // Scored checks decide `ok`; unscored ones are reported and nothing else.
  const scored = checks.filter((c) => c.scored !== false);
  // `release_sha` and `refs` ride out so the merge resolver below can answer "has this landed?"
  // without a second `ls-remote` — one network call per run stays the rule.
  return { ok: scored.every((c) => c.ok), advertised: mainHasRelease, version, checks,
    release_sha: expectedSha, remote_refs: refs };
}

export function verifyServedStructure(ctx, url, tag, expectedSha, manifest) {
  if(!manifest?.entries?.length)return {ok:false,detail:'release carries no sealed root_structure manifest'};
  if(manifest.digest!==createHash('sha256').update(JSON.stringify(manifest.entries)).digest('hex')
    || manifest.entries.some(row=>row.included && row.kind!=='directory' && !/^[a-f0-9]{64}$/.test(row.hash??'')))
    return {ok:false,detail:'release root_structure manifest is not sealed or its digest is invalid'};
  if(!expectedSha)return {ok:false,detail:'cannot inspect root_structure: release tag is absent'};
  const ws=mkdtempSync(join(tmpdir(),'sk-served-core-'));
  try {
    const g=args=>spawnSync('git',['-c','protocol.file.allow=always',...args],{cwd:ws,encoding:'utf8'});
    let r=g(['init','-q']);if(r.status!==0)throw new Error(r.stderr);
    r=g(['fetch','-q','--depth=1',url,'refs/tags/'+tag]);if(r.status!==0)throw new Error(r.stderr);
    r=g(['rev-parse','FETCH_HEAD^{commit}']);
    if(r.status!==0||r.stdout.trim()!==expectedSha)throw new Error('served tag changed during verification');
    r=g(['checkout','-q','--detach','FETCH_HEAD']);if(r.status!==0)throw new Error(r.stderr);
    const failures=verifyRootStructure(ws,manifest);
    return {ok:failures.length===0,detail:failures.length?failures.join('; '):'served tree matches sealed root_structure'};
  } catch(error) {return {ok:false,detail:'served root_structure could not be verified: '+error.message};}
  finally {rmSync(ws,{recursive:true,force:true});}
}

export function recordRemoteVerification(state, res, stamp) {
  state.schema = 3;
  state.remote_verified = res.ok
    ? {
      version: res.version,
      verified_at: stamp,
      // Whether the core's main carries the release: SERVED without ADVERTISED is the window in
      // which the README one-liner still installs the previous version. Recorded so `status` can
      // report it offline instead of reaching the network itself.
      advertised: res.advertised,
      refs: res.checks.map((c) => ({ ref: c.ref, sha: c.remote })),
    }
    : null;
  state.remote_check = {
    version: res.version,
    checked_at: stamp,
    ok: res.ok,
    advertised: res.advertised,
    checks: res.checks.map((c) => ({ ref: c.ref, ok: c.ok, scored: c.scored !== false, detail: c.detail })),
  };
}

export function writeStateIfChanged(ctx, state) {
  const abs = join(ctx.ROOT, ctx.STATE_REL);
  const next = `${JSON.stringify(state, null, 2)}\n`;
  const withoutStamps = (text) => text
    .replace(/"verified_at": "[^"]*"/g, '"verified_at": ""')
    .replace(/"checked_at": "[^"]*"/g, '"checked_at": ""')
    .replace(/"merges_checked_at": "[^"]*"/g, '"merges_checked_at": ""');
  let current = null;
  try { current = readFileSync(abs, "utf8"); } catch { /* absent — write it */ }
  if (current !== null && withoutStamps(current) === withoutStamps(next)) return false;
  writeFileSync(abs, next);
  return true;
}

export function resolveOutstandingMerges(ctx, state, res) {
  const rel = state?.remote_release;
  if (!sameVersion(rel, res.version) || !Array.isArray(rel.merges_outstanding)) return null;

  const remaining = [];
  const landed = [];
  let unresolved = 0;

  for (const m of rel.merges_outstanding) {
    if (!m || !m.repo || !m.into) { remaining.push(m); unresolved += 1; continue; }
    let done = null;                                   // null = could not tell
    if (m.repo === "core") {
      const head = res.remote_refs?.get(`refs/heads/${m.into}`) || null;
      if (head && res.release_sha) {
        done = head === res.release_sha
          || git(ctx, ["merge-base", "--is-ancestor", res.release_sha, head], ctx.SRC_ABS).ok;
        // A branch head this clone has never seen cannot be tested for containment, and a false
        // from `merge-base` on a missing object would read as "not merged".
        if (!done && head !== res.release_sha
          && !git(ctx, ["cat-file", "-e", `${head}^{commit}`], ctx.SRC_ABS).ok) done = null;
      }
    } else if (m.repo === "source" && m.from) {
      const target = git(ctx, ["rev-parse", "--verify", `origin/${m.into}`], ctx.ROOT);
      const from = git(ctx, ["rev-parse", "--verify", `${m.from}^{commit}`], ctx.ROOT);
      if (target.ok && from.ok) done = git(ctx, ["merge-base", "--is-ancestor", from.out, target.out], ctx.ROOT).ok;
    }
    if (done === true) landed.push(m);
    else {
      remaining.push(done === null ? { ...m, unresolved: true } : m);
      if (done === null) unresolved += 1;
    }
  }
  return { remaining, landed, unresolved };
}

export function pushKind(ctx, refs, fullRef, localSha) {
  const remoteSha = refs.get(fullRef) || refs.get(`${fullRef}^{}`) || null;
  if (!remoteSha) return { kind: "create", remoteSha: null };
  if (remoteSha === localSha) return { kind: "already", remoteSha };
  const ancestor = git(ctx, ["merge-base", "--is-ancestor", remoteSha, localSha], ctx.SRC_ABS);
  return { kind: ancestor.ok ? "fast-forward" : "non-fast-forward", remoteSha };
}

export function doRelease(ctx) {
  const state = readJson(ctx, ctx.STATE_REL) || {};
  const last = lastRelease(state);
  if (!last) {
    ctx.warn(
      `no local release recorded in ${portable(ctx.STATE_REL)} — there is nothing to publish.\n` +
        "  cut one first:  node bin/sidekicks core publish\n"
    );
    finish(3);
  }
  if (!targetIsOwnRepo(ctx)) {
    ctx.warn(
      "the core target is not its own git repository, so it has no remote to publish to.\n"
    );
    finish(3);
  }

  const version = String(last.version);
  const tag = `v${version}`;
  const coreBranch = last.core_branch || git(ctx, ["branch", "--show-current"], ctx.SRC_ABS).out;

  // ── 1. Preflight, entirely read-only ───────────────────────────────────────
  const localTag = git(ctx, ["rev-parse", `${tag}^{commit}`], ctx.SRC_ABS);
  if (!localTag.ok || !localTag.out) {
    ctx.warn(
      `${tag} does not exist in the core repo, so this release was never landed locally.\n` +
        `  run:  node bin/sidekicks core publish --version ${version}\n`
    );
    finish(3);
  }
  const tagSha = localTag.out;

  if (!coreBranch) {
    ctx.warn(
      "the core repo is on a detached HEAD, so there is no branch to push. Check the release " +
        "branch out first — pushing HEAD would leave the release commit on no branch at all.\n"
    );
    finish(3);
  }
  if (isProtected(coreBranch)) {
    ctx.warn(
      `the core is on '${coreBranch}', which is protected. A protected branch receives work only ` +
        "through a merge or PR you approve — never a push from a script.\n" +
        "  cut the release onto a work branch and merge it there instead.\n"
    );
    finish(8);
  }
  const branchSha = git(ctx, ["rev-parse", coreBranch], ctx.SRC_ABS);
  if (!branchSha.ok || !branchSha.out) {
    ctx.warn(`could not resolve '${coreBranch}' in the core repo.\n`);
    finish(3);
  }

  const rootBranch = git(ctx, ["branch", "--show-current"]).out;
  const sourceProtected = isProtected(rootBranch);

  const remote = remoteRefs(ctx);
  if (!remote.ok) {
    // Unlike `publish`, an unreachable remote IS fatal here: this verb's entire job is to change
    // what the remote serves, and it cannot report success without having seen it.
    ctx.warn(`${remote.detail}\n`);
    finish(6);
  }

  const tagPlan = pushKind(ctx, remote.refs, `refs/tags/${tag}`, tagSha);
  const branchPlan = pushKind(ctx, remote.refs, `refs/heads/${coreBranch}`, branchSha.out);

  if (tagPlan.kind === "non-fast-forward" || branchPlan.kind === "non-fast-forward") {
    const which = tagPlan.kind === "non-fast-forward" ? tag : coreBranch;
    ctx.warn(
      `the remote's ${which} is not an ancestor of the local one, so pushing it would DISCARD ` +
        "commits the remote already serves. Refusing before touching anything.\n" +
        "  fetch and reconcile in the core repo first; this script never force-pushes.\n"
    );
    finish(6);
  }

  // Never counts the version it is CURRENTLY serving: a release cut by hand has no log entry, and
  // refusing to publish it because it has no log entry would leave it permanently unservable. The
  // guard is about OTHER releases whose published history and log disagree.
  const orphans = unloggedTags(ctx, remote).filter((t) => t.served === true && t.version !== version);
  if (orphans.length && !has(ctx, "allow-unlogged-tags")) {
    ctx.warn(
      `the remote already serves ${orphans.length} tag(s) with no release-log entry: ` +
        `${orphans.map((t) => t.tag).join(", ")}.\n` +
        "  Published history and the log disagree, and pushing another release widens the gap.\n" +
        "  Backfill their log entries (they are SERVED — deleting them breaks anyone pinned to " +
        "them), or pass --allow-unlogged-tags.\n"
    );
    finish(8);
  }

  // ── 2. The plan. Nothing outward happens without --yes ─────────────────────
  const describe = (p) => (p.kind === "already"
    ? "already serves this commit"
    : p.kind === "create" ? "create" : `fast-forward from ${(p.remoteSha || "").slice(0, 12)}`);
  const lines = [];
  lines.push(`release v${version} — ${remote.url}`);
  lines.push("");
  lines.push(`  refs/tags/${tag}`.padEnd(52) + describe(tagPlan));
  lines.push(`  refs/heads/${coreBranch}`.padEnd(52) + describe(branchPlan));
  const rootHasRemote = (() => { const r = git(ctx, ["remote", "get-url", "origin"]); return r.ok && Boolean(r.out); })();
  if (rootBranch && !sourceProtected && rootHasRemote) {
    lines.push(`  ${portable(".")} @ ${rootBranch}`.padEnd(52) + "push (source repo)");
  }
  lines.push("");
  lines.push("  The TAG is pushed FIRST, on purpose: the README on the core's default branch names");
  lines.push(`  --ref ${tag}, and it only gets there through a merge that is later than both pushes.`);

  if (!has(ctx, "yes") || ctx.DRY) {
    lines.push("");
    lines.push("Nothing was pushed. These are outward-facing and irreversible, so they need your");
    lines.push("explicit yes — the same shape as --allow-protected and --reland, never self-granted:");
    lines.push("");
    lines.push("```sh");
    lines.push("node bin/sidekicks core release --yes");
    lines.push("```");
    ctx.write(lines.join("\n") + "\n");
    finish(0);
  }

  ctx.write(lines.join("\n") + "\n\n── pushing ─────────────────────────────────────────\n");

  // ── 3-4. The pushes. stdio inherited so a credential helper can prompt ─────
  const pushed = [];
  const push = (label, args, result) => {
    ctx.write(`  ${label}\n`);
    const r = spawnSync("git", ["-c", "push.followTags=false", "-C", ctx.SRC_ABS, "push", "origin", ...args], {
      encoding: "utf8", stdio: "pipe",
    });
    if (r.status !== 0) {
      ctx.warn(`\npush of ${label} was refused by the remote (exit ${r.status}).\n`);
      finish(6);
    }
    pushed.push(result);
  };

  if (tagPlan.kind !== "already") {
    push(`refs/tags/${tag}`, [`refs/tags/${tag}`], { ref: `refs/tags/${tag}`, sha: tagSha, result: tagPlan.kind });
  } else {
    pushed.push({ ref: `refs/tags/${tag}`, sha: tagSha, result: "already" });
  }
  if (branchPlan.kind !== "already") {
    // By NAME, never HEAD: a detached HEAD or a different checked-out branch must not decide what
    // ships. `push origin HEAD` is exactly the line that shortened to a bare `git push` twice before.
    push(`refs/heads/${coreBranch}`, [coreBranch], { ref: `refs/heads/${coreBranch}`, sha: branchSha.out, result: branchPlan.kind });
  } else {
    pushed.push({ ref: `refs/heads/${coreBranch}`, sha: branchSha.out, result: "already" });
  }

  // ── 5. Prove it. A push that reported success is a claim, not evidence ─────
  ctx.write("\n── verifying ───────────────────────────────────────\n");
  const res = verifyRemote(ctx);
  for (const c of res.checks) ctx.write(checkLine(c));

  const stamp = nowBangkok().stamp;
  const fresh = readJson(ctx, ctx.STATE_REL) || {};
  recordRemoteVerification(fresh, res, stamp);

  if (!res.ok) {
    writeFileSync(join(ctx.ROOT, ctx.STATE_REL), `${JSON.stringify(fresh, null, 2)}\n`);
    ctx.warn(
      "\nthe pushes reported success but the remote still does not serve this release.\n" +
        "  Nothing is rolled back — a landed tag is not a problem, and undoing it would be.\n" +
        "  Investigate the remote, then re-run:  node bin/sidekicks core verify-remote\n"
    );
    finish(7);
  }

  // ── 6. The source side. Its work branch, never a protected one ─────────────
  let sourcePushed = null;
  // A source checkout with no `origin` is a legitimate shape (a local-only clone), and by this
  // point the CORE is already served — the release succeeded. Treating "this workspace has no
  // remote" as a failed release would misreport the thing that actually happened.
  const sourceRemote = git(ctx, ["remote", "get-url", "origin"]);
  const sourceHasRemote = sourceRemote.ok && Boolean(sourceRemote.out);
  if (rootBranch && !sourceProtected && !sourceHasRemote) {
    ctx.write(`\n  ${portable(".")} has no 'origin' — nothing to push the source branch to.\n`);
  }
  if (rootBranch && !sourceProtected && sourceHasRemote) {
    ctx.write(`\n  ${portable(".")} @ ${rootBranch}\n`);
    const r = spawnSync("git", ["-c", "push.followTags=false", "push", "origin", rootBranch], { cwd: ctx.ROOT, encoding: "utf8", stdio: "pipe" });
    if (r.status !== 0) {
      ctx.warn(`\npush of the source branch '${rootBranch}' was refused (exit ${r.status}).\n`);
      finish(6);
    }
    sourcePushed = rootBranch;
  }

  const merges = [
    { repo: "core", from: coreBranch, into: "main",
      why: "publishes README.md + install.sh at the raw URL the README's one-liner fetches" },
  ];
  if (sourcePushed) {
    merges.push({ repo: "source", from: sourcePushed, into: "main",
      why: "lands the gitlink bump and the release log" });
  }

  fresh.remote_release = {
    version, pushed_at: stamp, pushed_by: "release",
    refs: pushed, source_branch_pushed: sourcePushed, merges_outstanding: merges,
  };
  writeFileSync(join(ctx.ROOT, ctx.STATE_REL), `${JSON.stringify(fresh, null, 2)}\n`);
  appendPublishedBlock(ctx, version, { stamp, refs: pushed, sourcePushed, merges });

  const out = [""];
  out.push(`v${version} is SERVED by ${remote.url}.`);
  // SERVED is not ADVERTISED, and this is the exact moment the two diverge: the tag and the release
  // branch are up, the merge onto main has not happened, so `--ref v<version>` resolves while the
  // README one-liner a newcomer copies still installs the previous release. Saying it here is what
  // makes the outstanding-merge list below read as a consequence rather than as bookkeeping.
  if (res.advertised === false) {
    out.push("It is NOT yet ADVERTISED: the core's main does not carry it, so the README one-liner");
    out.push("still installs the previous release until the merge below lands.");
  }
  out.push("");
  if (sourceProtected) {
    out.push(`  NOTE: this repo is on '${rootBranch}', which is protected — the source branch was`);
    out.push("  NOT pushed. Move the release commit onto a work branch and push that.");
    out.push("");
  }
  out.push("  Still outstanding, and yours alone — this script never pushes to a protected branch:");
  for (const m of merges) out.push(`    ${m.repo}: merge ${m.from} -> ${m.into}   (${m.why})`);
  ctx.write(out.join("\n") + "\n");
  finish(0);
}

export function appendPublishedBlock(ctx, version, { stamp, refs, sourcePushed, merges }) {
  const logAbs = join(ctx.ROOT, ctx.LOG_REL);
  if (!existsSync(logAbs)) return;
  const text = readFileSync(logAbs, "utf8");
  const head = new RegExp(`^## v${version.replace(/\./g, "\\.")}\\b.*$`, "m").exec(text);
  if (!head) return;

  const after = text.indexOf("\n## ", head.index + 1);
  const end = after === -1 ? text.length : after;
  if (/\*\*Published\*\*/.test(text.slice(head.index, end))) return;   // idempotent re-run

  const block = ["", "**Published** — pushed and verified at " + stamp + ":", ""];
  for (const r of refs) block.push(`- \`${r.ref}\` at \`${(r.sha || "").slice(0, 12)}\` (${r.result})`);
  if (sourcePushed) block.push(`- source branch \`${sourcePushed}\` pushed`);
  block.push("");
  block.push("Outstanding merges (never performed by this script):");
  block.push("");
  for (const m of merges) block.push(`- ${m.repo}: \`${m.from}\` -> \`${m.into}\` — ${m.why}`);
  block.push("");

  writeFileSync(logAbs, text.slice(0, end) + block.join("\n") + text.slice(end));
}

export function doVerifyRemote(ctx) {
  const res = verifyRemote(ctx);
  const state = readJson(ctx, ctx.STATE_REL);
  const merges = resolveOutstandingMerges(ctx, state, res);

  if (ctx.JSON_OUT) {
    // `remote_refs` is a Map — it exists so the merge resolver can avoid a second ls-remote, and it
    // would serialise as `{}`. Drop it rather than emit a field that is always empty.
    const { remote_refs: _refs, ...payload } = res;
    ctx.write(`${JSON.stringify({ ...payload, merges_outstanding: merges?.remaining ?? null }, null, 2)}\n`);
  } else {
    ctx.write(`verify-remote: local release v${res.version || "?"}\n`);
    for (const c of res.checks) ctx.write(checkLine(c));
    ctx.write(res.ok
      ? "\nthe remote serves this release.\n"
      : "\nthe remote does NOT serve this release — it is a LOCAL release only.\n");
    // Served and advertised are separate sentences because they are separate facts.
    if (res.ok && res.advertised === true) {
      ctx.write("it is also ADVERTISED — the core's main carries it, so the README one-liner installs it.\n");
    } else if (res.ok && res.advertised === false) {
      ctx.write("it is NOT yet ADVERTISED — the core's main is behind, so the README one-liner\n"
        + "still installs the previous release. The merge is yours; nothing here performs it.\n");
    }
    if (merges) {
      for (const m of merges.landed) ctx.write(`  landed:      ${m.repo}: ${m.from} -> ${m.into}\n`);
      for (const m of merges.remaining) {
        ctx.write(`  outstanding: ${m.repo}: merge ${m.from} -> ${m.into}`
          + `${m.unresolved ? "   (could not be checked from here)" : ""}\n`);
      }
    }
  }

  // Record the answer either way. "Checked and it is not there" is the fact worth keeping.
  if (state) {
    const stamp = nowBangkok().stamp;
    recordRemoteVerification(state, res, stamp);
    if (merges) {
      state.remote_release.merges_outstanding = merges.remaining;
      state.remote_release.merges_checked_at = stamp;
    }
    writeStateIfChanged(ctx, state);
  }
  finish(res.ok ? 0 : 1);
}

export function doLog(ctx) {
  const p = join(ctx.ROOT, ctx.LOG_REL);
  if (!existsSync(p)) {
    ctx.write(`no release log yet at ${portable(ctx.LOG_REL)} — run publish once.\n`);
    finish(0);
  }
  ctx.write(readFileSync(p, "utf8"));
  finish(0);
}

/** Each invocation owns its flags, config, output buffers and exit state. */
export function createReleaseEngine({repoRoot, flags = {}, projection = runProjection, verificationDepth = 0}) {
  const invoke = async verb => {
    const ctx={...resolveReleasePaths(repoRoot,flags), flags, VERB:verb, projection, verificationDepth, stdout:'',stderr:'',exitCode:0};
    ctx.argv=[verb,...Object.entries(flags).flatMap(([k,v])=>v===false||v==null?[]:v===true?['--'+k]:['--'+k,String(v)])];
    for(const [key,flag] of Object.entries({DRY:'dry-run',JSON_OUT:'json',NO_TESTS:'no-tests',NO_MOUNT_CHECK:'no-mount-check',NO_UPGRADE_CHECK:'no-upgrade-check',NO_COMMIT:'no-commit',ALLOW_PROTECTED:'allow-protected',RELAND:'reland',ALLOW_UNPUSHED:'allow-unpushed'}))ctx[key]=Boolean(flags[flag]);
    ctx.write=text=>{if(text!=null)ctx.stdout+=String(text);};ctx.warn=text=>{if(text!=null)ctx.stderr+=String(text);};
    ctx.projectionStep=async (op,extra={})=>{
      const r=await projection(repoRoot,op,{name:ctx.RUNTIME_NAME,target:ctx.SRC_REL,...extra});
      const text=(r.stdout??'')+(r.stderr??'');
      return {ok:r.exitCode===0,status:r.exitCode,text,tail:text.trim().split('\n').slice(-25).join('\n')};
    };
    try {
      const planned=await projection(repoRoot,'plan',{name:ctx.RUNTIME_NAME,target:ctx.SRC_REL,preset:ctx.PRESET,'pack-skills':ctx.PACK_SKILLS,'as-core':true,json:true});
      if(planned.exitCode!==0) {ctx.warn('cannot resolve framework-core composition from core plan (exit '+planned.exitCode+'):\n'+(planned.stderr||planned.stdout));finish(4);}
      try { ctx.plan=planned.payload ?? JSON.parse(planned.stdout); } catch {}
      if(!ctx.plan?.skill_names?.length || !ctx.plan?.substrate?.length) {ctx.warn('cannot resolve framework-core composition from core plan: no skill or substrate surface\n');finish(4);}
      if(!existsSync(ctx.SRC_ABS) || !statSync(ctx.SRC_ABS).isDirectory()) {ctx.warn('the framework core service is not present at '+portable(ctx.SRC_REL)+' — run git submodule update --init '+portable(ctx.SRC_REL)+' first (or pass --target).\n');finish(3);}
      const commands={status:doStatus,publish:doPublish,verify:doVerify,release:doRelease,'verify-remote':doVerifyRemote,ship:doShip,log:doLog};
      if(!commands[verb]) throw new CoreForgeError('unknown release operation: '+verb,2);
      await commands[verb](ctx);
    }catch(error){
      if(error instanceof ReleaseExit)ctx.exitCode=error.exitCode;
      else if(error instanceof CoreForgeError){ctx.exitCode=error.exitCode;ctx.warn(error.message+'\n');}
      else throw error;
    }
    let payload;try{payload=JSON.parse(ctx.stdout);}catch{}
    return {stdout:ctx.stdout,stderr:ctx.stderr,exitCode:ctx.exitCode,...(payload===undefined?{}:{payload})};
  };
  return {status:()=>invoke('status'),publish:()=>invoke('publish'),verify:()=>invoke('verify'),release:()=>invoke('release'),verifyRemote:()=>invoke('verify-remote'),ship:()=>invoke('ship'),log:()=>invoke('log')};
}
