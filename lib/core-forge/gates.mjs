import { finish } from './exit.mjs';
// Sidekicks core forge — gates. Zero runtime dependencies.
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
import { corePaths, git, readJson, subdirs, targetIsOwnRepo } from './_release-shared.mjs';
import { snapshotCoreTree } from './distribution.mjs';

export function step(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const text = `${r.stdout || ""}${r.stderr || ""}`.trimEnd();
  const tail = text.split("\n").slice(-25).join("\n");
  return { ok: r.status === 0, status: r.status ?? -1, tail, text };
}

export const nodeStep = (args, cwd) => step(process.execPath, args, cwd);

export function candidateCommit(ctx) {
  const indexDir = mkdtempSync(join(tmpdir(), "sk-core-gate-index-"));
  const idx = join(indexDir,"index");
  const g = (args) => spawnSync("git", args, {
    cwd: ctx.SRC_ABS, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: idx },
  });
  try {
    const added = g(["add", "-A"]);
    if (added.status !== 0) {
      return { ok: false, note: `could not stage the forged tree for the mount check: ${(added.stderr || "").trim()}` };
    }
    const tree = g(["write-tree"]);
    if (tree.status !== 0 || !tree.stdout.trim()) {
      return { ok: false, note: `could not write a tree for the mount check: ${(tree.stderr || "").trim()}` };
    }
    // Parented on HEAD when there is one, so the clone below has ordinary history to check out. A core
    // repo with no commit at all yields a parentless commit, which is equally mountable.
    const head = git(ctx, ["rev-parse", "HEAD"], ctx.SRC_ABS);
    const args = ["-c", "user.name=Sidekicks verification", "-c", "user.email=verification@sidekicks.invalid",
      "commit-tree", tree.stdout.trim(), "-m", "mount-check candidate (throwaway)"];
    if (head.ok && head.out) args.push("-p", head.out);
    const commit = g(args);
    if (commit.status !== 0 || !commit.stdout.trim()) {
      return { ok: false, note: `could not create the mount-check commit: ${(commit.stderr || "").trim()}` };
    }
    return { ok: true, sha: commit.stdout.trim() };
  } finally {
    try {
      rmSync(indexDir, { recursive:true, force:true });
    } catch {
      /* a leftover temp index is not worth failing a release over */
    }
  }
}

export async function mountCheck(ctx) {
  if (!targetIsOwnRepo(ctx)) {
    return { ok: true, skipped: true, note: "the target is not its own git repository, so there is nothing to mount" };
  }
  const candidate = candidateCommit(ctx);
  if (!candidate.ok) return { ok: false, note: candidate.note };
  let ws = null;
  let keep = false;
  let mountNote = undefined;
  try {
    ws = mkdtempSync(join(tmpdir(), "sk-core-mount-"));
    const g = (args) => spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd: ws, encoding: "utf8" });
    g(["init", "-q", "."]);
    g(["config", "user.email", "publish@sidekicks.local"]);
    g(["config", "user.name", "framework-core-publish"]);
    // Pre-populate the submodule at the candidate commit before registering it.
    // A first-ever forge has an unborn HEAD; submodule add cannot check that out.
    const cloned = g(["clone", "-q", "--no-checkout", ctx.SRC_ABS, ".sidekicks-core"]);
    if (cloned.status !== 0) {
      return { ok: false, note: `could not clone the candidate: ${(cloned.stderr || "").trim()}` };
    }
    // Move the mount onto the candidate. `submodule add` cloned HEAD; the release being gated is the
    // working tree, so fetch the throwaway commit by sha and detach onto it.
    const mount = join(ws, ".sidekicks-core");
    const fetched = spawnSync("git", ["-c", "protocol.file.allow=always", "fetch", "-q", ctx.SRC_ABS, candidate.sha],
      { cwd: mount, encoding: "utf8" });
    if (fetched.status !== 0) {
      return { ok: false, note: `could not fetch the candidate into the mount: ${(fetched.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    const checkedOut = spawnSync("git", ["checkout", "-q", "--detach", candidate.sha], { cwd: mount, encoding: "utf8" });
    if (checkedOut.status !== 0) {
      return { ok: false, note: `could not check the candidate out in the mount: ${(checkedOut.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    const added = g(["submodule", "add", "-q", ctx.SRC_ABS, ".sidekicks-core"]);
    if (added.status !== 0) return { ok: false, note: `could not register the candidate submodule: ${(added.stderr || "").trim()}` };
    // From here on the failures are about the WORKSPACE's behaviour, and that workspace is the only
    // reproduction of them there is — so these keep it and name the path (see the `finally` below).
    // The git-plumbing failures above are not routed through this: a bare `git init` with a failed
    // submodule add holds nothing to inspect.
    const failInMount = (note, tail) => {
      keep = true;
      return { ok: false, note: `${note} — mount KEPT for inspection: ${ws}`, tail };
    };

    const init = nodeStep([join(ws, ".sidekicks-core", "bin", "sidekicks"), "core", "init"], ws);
    if (!init.ok) return failInMount("core init failed in a fresh workspace", init.tail);
    // `--all`, not a bare `core doctor` (F-06/F-09). A bare run judges the MOUNT, and the mount was
    // sound in the release this gate passed: the workspace it produced failed framework doctor,
    // config doctor and skill verify, and this gate never asked any of them. --all composes all
    // four, so the gate's question is finally "is the installed workspace healthy" rather than
    // "did the submodule land".
    const doctor = nodeStep([join(ws, "bin", "sidekicks"), "core", "doctor", "--all"], ws);
    if (!doctor.ok) {
      return failInMount("core doctor --all failed in the mounted workspace", doctor.tail);
    }
    // The doctors answer "is this workspace healthy". They do not answer "does this workspace pass
    // its own gates", and the two came apart: `check run quick` was red in EVERY mounted workspace
    // while this gate was green, because catalog.check resolved framework paths against the
    // workspace root and tests.contract named files a mount does not carry at that path. The release
    // path already builds a real mount here; it simply never asked (INC-2026-09-04-01, F-3).
    //
    // `full`, not `quick` — asking only the cheapest profile is how the SECOND round of the same bug
    // shipped. v1.4.2 passed this gate with a green `quick` while `parity` named two suites living
    // in repo-root tests/, which travels into no core, so `check run full` was red in every consumer
    // install and `release` scored 9/13 (INC-2026-09-04-02, N-3). `full` adds parity, the whole test
    // suite and skill.doctor --strict inside the mount. Not `release`: its `core.mounted` gate would
    // build a core from this core, and `package.clean` is covered directly below instead.
    const check = nodeStep([join(ws, "bin", "sidekicks"), "check", "run", "full", "--json"], ws);
    // The PROFILE's verdict decides, not the exit code, and the failing ROWS are what gets reported.
    // Both are readCheckRun's whole subject — see it for why either alone is wrong.
    const run = readCheckRun(check.text);
    if (!run) {
      // An unreadable --json result is only a problem when the run also failed; a green run whose
      // json this cannot parse would be a silent pass, so it is not treated as one either.
      return failInMount("check run full produced a --json result that could not be read in the "
        + "mounted workspace", check.tail);
    }
    if (run.status !== "passed" || run.failed.length) {
      return failInMount("check run full failed in the mounted workspace", run.tail || check.tail);
    }
    // A non-blocking skip does not fail a release, and it does not vanish either: it rides out on
    // the passing gate's note, which is what `verify` and `ship` print.
    if (run.skipped.length) {
      mountNote = `check run full passed in the mount; not run there: `
        + run.skipped.map((g) => g.id).join(", ");
    }
    // `package.clean` is release-profile only, so `full` does not reach it — and it is the gate that
    // died in a mount with "validateSource: lib/sk-cli not found", taking two more down with it as
    // BLOCKED. Ask it directly rather than recursing through the whole release profile.
    const pkg = nodeStep(
      [join(ws, "bin", "sidekicks"), "package", "create", "--output", join(ws, "..", "pkg-smoke"), "--dry-run"],
      ws
    );
    if (!pkg.ok) {
      return failInMount("package create could not resolve the framework from the mounted workspace",
        pkg.tail);
    }
    const selfHost=ctx.verificationDepth ? null : await selfHostCheck(ctx,mount);
    if(selfHost && !selfHost.ok) return failInMount(selfHost.note,selfHost.tail);
    return { ok: true, note: mountNote, selfHost };
  } catch (err) {
    return { ok: false, note: `mount check could not run: ${err && err.message ? err.message : String(err)}` };
  } finally {
    // KEPT ON FAILURE. This mount is the only reproduction of a mount-only defect that exists: the
    // candidate commit is a throwaway that no ref holds, so once this directory is gone the failing
    // workspace cannot be rebuilt except by re-running the whole forge. INC-2026-09-09's recovery
    // plan asked for "the first failing test and stack trace" from a mount that had already been
    // deleted by this block. A temp directory the operator can re-run `check run full` inside is
    // worth more than a tidy /tmp; a green run still cleans up.
    if (ws && !keep) {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing a release over */
      }
    }
  }
}

export function upgradeCheck(ctx) {
  if (!targetIsOwnRepo(ctx)) {
    return { ok: true, skipped: true, note: "the target is not its own git repository, so there is nothing to upgrade" };
  }
  // The previous release must be one the REMOTE actually served: an upgrade path only exists from a
  // version a consumer could have installed. state.json's remote_verified is the only field that
  // means that (last_local_release is explicitly not evidence anyone can fetch it).
  const stateNow = readJson(ctx, ctx.STATE_REL) || {};
  const prev = stateNow.remote_verified && stateNow.remote_verified.version
    ? String(stateNow.remote_verified.version)
    : null;
  if (!prev) {
    return { ok: true, skipped: true, note: "no verified remote release to upgrade FROM — nothing to check yet" };
  }
  const prevTag = `v${prev}`;
  const prevSha = git(ctx, ["rev-parse", "--verify", `${prevTag}^{commit}`], ctx.SRC_ABS);
  if (!prevSha.ok || !prevSha.out) {
    return { ok: true, skipped: true, note: `${prevTag} was served but does not resolve in this checkout — cannot mount it` };
  }
  const candidate = candidateCommit(ctx);
  if (!candidate.ok) return { ok: false, note: candidate.note };

  let ws = null;
  try {
    ws = mkdtempSync(join(tmpdir(), "sk-core-upgrade-"));
    const g = (args, cwd = ws) => spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8" });
    g(["init", "-q", "."]);
    g(["config", "user.email", "publish@sidekicks.local"]);
    g(["config", "user.name", "framework-core-publish"]);
    const added = g(["submodule", "add", "-q", ctx.SRC_ABS, ".sidekicks-core"]);
    if (added.status !== 0) {
      return { ok: false, note: `could not mount the previous release: ${(added.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    const mount = join(ws, ".sidekicks-core");

    // 1. Put the mount on the previous SERVED release, and record it as the tracked ref the way both
    //    installers do — the pin is what makes this an upgrade rather than a re-install.
    const onPrev = g(["checkout", "-q", "--detach", prevSha.out], mount);
    if (onPrev.status !== 0) {
      return { ok: false, note: `could not check out ${prevTag} in the mount: ${(onPrev.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }
    g(["config", "-f", ".gitmodules", "submodule..sidekicks-core.branch", prevTag]);
    g(["add", ".gitmodules"]);

    // 2. The OLD core seeds the workspace. Through its own bin, because the workspace has no shim yet.
    const init = nodeStep([join(mount, "bin", "sidekicks"), "core", "init"], ws);
    if (!init.ok) {
      return { ok: false, note: `${prevTag} could not seed a workspace — the upgrade path starts from a broken install`, tail: init.tail };
    }
    // Asked explicitly: a `core init` that exits 0 without writing the shim leaves every step below
    // failing as MODULE_NOT_FOUND, which names the symptom and not the cause.
    if (!existsSync(join(ws, "bin", "sidekicks"))) {
      return {
        ok: false,
        note: `${prevTag} seeded a workspace with no bin/sidekicks shim, so there is nothing to upgrade THROUGH`,
        tail: init.tail,
      };
    }

    // 3. The candidate is an unreferenced throwaway commit, so `core update`'s own
    //    `fetch origin --tags` cannot reach it — and that fetch failing is non-fatal by design.
    //    Put the object in the mount first, so the ref ladder resolves it locally.
    const fetched = spawnSync("git", ["-c", "protocol.file.allow=always", "fetch", "-q", ctx.SRC_ABS, candidate.sha],
      { cwd: mount, encoding: "utf8" });
    if (fetched.status !== 0) {
      return { ok: false, note: `could not fetch the candidate into the mount: ${(fetched.stderr || "").trim().split("\n").slice(-3).join(" ")}` };
    }

    // 4. THE UPGRADE, through the WORKSPACE shim — i.e. run by the OLD core, which is the point.
    const upd = nodeStep([join(ws, "bin", "sidekicks"), "core", "update", "--ref", candidate.sha], ws);
    if (!upd.ok) {
      return { ok: false, note: `core update from ${prevTag} to the candidate failed`, tail: upd.tail };
    }

    // 5. THE ASSERTION. The new core's own doctor, in a workspace that got here by upgrading.
    const doctor = nodeStep([join(ws, "bin", "sidekicks"), "core", "doctor", "--all"], ws);
    if (!doctor.ok) {
      return {
        ok: false,
        note: `core doctor --all failed after upgrading a ${prevTag} workspace to this candidate — `
          + "the tail of the update did not run the new core's rules",
        tail: doctor.tail,
      };
    }

    // 6. U-2 directly: the branch key reached the INDEX, not just the worktree. Left unstaged, a
    //    commit records a pin with no tracked ref and a fresh clone falls back to main.
    const inIndex = spawnSync("git", ["show", ":.gitmodules"], { cwd: ws, encoding: "utf8" });
    const onDisk = readFileSync(join(ws, ".gitmodules"), "utf8");
    if (inIndex.status !== 0 || inIndex.stdout.trim() !== onDisk.trim()) {
      return {
        ok: false,
        note: "after the upgrade .gitmodules disagrees with itself — the tracked ref was written to "
          + "the worktree and never staged, so a commit would record a pin with no ref",
        tail: `index:\n${inIndex.stdout}\nworktree:\n${onDisk}`,
      };
    }
    return { ok: true, note: `upgraded a ${prevTag} workspace to the candidate` };
  } catch (err) {
    return { ok: false, note: `upgrade check could not run: ${err && err.message ? err.message : String(err)}` };
  } finally {
    if (ws) {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing a release over */
      }
    }
  }
}

export async function runGates(ctx, inheritAbs) {
  const gates = [];
  let selfHost = null;
  const targetCli = join(ctx.SRC_ABS, "bin", "sidekicks");

  const record = (name, result, note, tail) => {
    gates.push({ name, result, note });
    return { gates, failed: result === "FAIL" ? { name, note, tail } : null };
  };

  // 1 — self-containment, runnability, core distribution, scripts ownership.
  const verify = await ctx.projectionStep("verify");
  if (!verify.ok) return record("inherit verify", "FAIL", `exit ${verify.status}`, verify.tail);
  gates.push({ name: "inherit verify", result: "pass" });

  // 2 — the doctors, run INSIDE the core so they read its config, not this repo's.
  for (const [ns, label] of [["config", "config doctor"], ["framework", "framework doctor"]]) {
    const d = nodeStep([targetCli, ns, "doctor"], ctx.SRC_ABS);
    if (!d.ok) return record(label, "FAIL", `exit ${d.status} inside the core`, d.tail);
    gates.push({ name: label, result: "pass" });
  }

  // 3 — the core's own suite, run through the ARTIFACT'S OWN declared gate.
  //
  // This gate used to lie in two ways at once (F-05). It skipped silently whenever the core had no
  // top-level tests/ — which the v2.0.0 core did not, so the release recorded "skipped" while 89
  // real tests sat unrun under lib/artifacts-lifecycle/tests/. And when it did run, it ran a glob
  // of its own choosing rather than the command the artifact ships, so it could not have caught
  // that `npm test` in the artifact discovers nothing and exits 0.
  //
  // Now: run the artifact's launcher, require a NON-ZERO discovered test count, and treat an
  // absent gate as a failure. --no-tests remains the one waiver, and it is recorded in the log.
  if (ctx.NO_TESTS) {
    gates.push({ name: "core test suite", result: "SKIPPED", note: "--no-tests (explicit, recorded waiver)" });
  } else {
    const launcher = join(ctx.SRC_ABS, "scripts", "run-tests.mjs");
    if (!existsSync(launcher)) {
      return record("core test suite", "FAIL",
        "the core ships no scripts/run-tests.mjs — it has no test gate that can fail honestly. "
        + "Re-forge with an engine that carries it, or waive with --no-tests.");
    }
    const disc = spawnSync(process.execPath, [launcher, "--list", "--json"],
      { cwd: ctx.SRC_ABS, encoding: "utf8" });
    let found = null;
    try { found = JSON.parse(disc.stdout || "null"); } catch { /* handled below */ }
    if (!found || !found.count) {
      return record("core test suite", "FAIL",
        "the core's own test gate discovers ZERO test files — a green `npm test` there would be "
        + "false confidence, not a passing suite",
        (disc.stderr || disc.stdout || "").trim().split("\n").slice(-10).join("\n"));
    }
    const t = nodeStep([launcher], ctx.SRC_ABS);
    if (!t.ok) return record("core test suite", "FAIL", `exit ${t.status} over ${found.count} file(s)`, t.tail);
    gates.push({ name: "core test suite", result: "pass",
      note: `${found.count} file(s) under ${(found.roots || []).join(", ")}` });
  }

  // 4 — the forge produced what the source says it should have.
  const drift = await ctx.projectionStep("drift", {json:true});
  if (!drift.ok) return record("post-forge drift", "FAIL", `exit ${drift.status} — the forged core is already out of step with its source`, drift.tail);
  gates.push({ name: "post-forge drift", result: "pass" });

  // 5 — a consumer's install actually works.
  if (ctx.NO_MOUNT_CHECK) {
    gates.push({ name: "mount check", result: "SKIPPED", note: "--no-mount-check" });
  } else {
    const m = await mountCheck(ctx);
    if (!m.ok) return record("mount check", "FAIL", m.note, m.tail);
    gates.push({ name: "mount check", result: m.skipped ? "skipped" : "pass", note: m.note });
    selfHost=m.selfHost;
  }

  // 6 — a consumer's UPGRADE actually works. Gate 5 installs the candidate fresh, which stays green
  // for every defect that lives in the update tail, because a fresh install never runs it.
  //
  // --no-mount-check waives this one too, and deliberately: both gates ask "does this behave as a
  // thing someone installs", and that flag is what a caller passes when the target is not a real
  // mountable core (the publish suite's synthetic fixtures). Honouring only the fresh half would
  // turn every existing --no-mount-check caller red on a question it had already waived.
  // --no-upgrade-check waives the upgrade half alone.
  if (ctx.NO_UPGRADE_CHECK || ctx.NO_MOUNT_CHECK) {
    gates.push({ name: "upgrade check", result: "SKIPPED",
      note: ctx.NO_UPGRADE_CHECK ? "--no-upgrade-check" : "--no-mount-check" });
  } else {
    const u = upgradeCheck(ctx);
    if (!u.ok) return record("upgrade check", "FAIL", u.note, u.tail);
    gates.push({ name: "upgrade check", result: u.skipped ? "skipped" : "pass", note: u.note });
  }

  // 7 — the forged tree IS the composition the plan resolved.
  //
  // Every gate above asks whether the artifact works. None asks whether it is the RIGHT artifact.
  // Those are different questions, and the second one is how a core ends up shipping a developer
  // workspace while passing everything: 43 skills forged from a policy nobody re-read, with every
  // skill's improvement funnel inside, and all six gates green.
  const composition = compositionCheck(ctx);
  if (!composition.ok) return record("composition", "FAIL", composition.note, composition.tail);
  gates.push({ name: "composition", result: "pass", note: composition.note });

  // Recursion is an engine-call context, never a CLI waiver. Nested validation still
  // exercises gates 1–7 on the successor; only the self-forge recurrence is bounded.
  if(!ctx.verificationDepth) {
    selfHost ??= await selfHostCheck(ctx);
    if(!selfHost.ok) return record('self-host fixed point','FAIL',selfHost.note,selfHost.tail);
    gates.push({name:'self-host fixed point',result:'pass',note:selfHost.note});
  }

  return { gates, failed: null };
}

/** Forge through the INSTALLED artifact's own CLI, in a standalone temporary clone. */
export async function selfHostCheck(ctx, installedCore = null) {
  const scratch=mkdtempSync(join(tmpdir(),'sk-core-self-host-'));
  const standalone=join(scratch,'standalone'), successor=join(scratch,'successor');
  let keep=true;
  const fail=(note,tail)=>({ok:false,note:note+' — self-host scratch KEPT: '+scratch,tail});
  try {
    const source=installedCore || ctx.SRC_ABS;
    const candidate=installedCore ? null : candidateCommit(ctx);
    if(candidate && !candidate.ok) return fail(candidate.note);
    let r=step('git',['-c','protocol.file.allow=always','clone','-q','--no-hardlinks',source,standalone],scratch);
    if(!r.ok) return fail('cannot clone standalone self-host source',r.tail);
    if(candidate) {
      r=step('git',['-c','protocol.file.allow=always','fetch','-q',source,candidate.sha],standalone);
      if(!r.ok) return fail('cannot fetch self-host candidate',r.tail);
      r=step('git',['checkout','-q','--detach',candidate.sha],standalone);
      if(!r.ok) return fail('cannot checkout self-host candidate',r.tail);
    }
    const marker=JSON.parse(readFileSync(join(standalone,'.sidekicks-core.json'),'utf8'));
    const args=[join(standalone,'bin','sidekicks'),'core','forge','--target',successor,'--name',marker.name,
      '--preset',ctx.PRESET,'--pack-skills',ctx.PACK_SKILLS,'--core-version',marker.version,
      '--core-ref',marker.ref || 'main','--remote',marker.remote || ctx.REMOTE,'--no-venv'];
    r=nodeStep(args,standalone);
    if(!r.ok) return fail('artifact CLI could not forge its successor',r.tail);
    // This code imports ONLY the standalone artifact's module, never the source's.
    const probe=`import {pathToFileURL} from 'node:url';import {join} from 'node:path';
      const {createReleaseEngine}=await import(pathToFileURL(join(process.argv[1],'lib/core-forge/release.mjs')).href);
      const r=await createReleaseEngine({repoRoot:process.cwd(),verificationDepth:1,flags:{target:process.argv[1],name:process.argv[2]}}).verify();
      process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.exitCode;`;
    r=nodeStep(['--input-type=module','-e',probe,successor,marker.name],standalone);
    if(!r.ok) return fail('successor failed its own bounded core verification',r.tail);
    const before=snapshotCoreTree(ctx.SRC_ABS).files, after=snapshotCoreTree(successor).files;
    const changed=[...new Set([...before.keys(),...after.keys()])].sort().filter(p=>before.get(p)!==after.get(p));
    if(changed.length) return fail('self-host tree is not a masked fixed point',changed.join('\n'));
    keep=false;
    return {ok:true,note:'artifact CLI forged and verified an equivalent standalone successor'};
  }catch(error){return fail('self-host check failed: '+error.message);}
  finally {if(!keep)rmSync(scratch,{recursive:true,force:true});}
}

export function compositionCheck(ctx) {
  const plan = corePaths(ctx);
  if (!plan.skills) {
    return { ok: false, note: "the inherit engine is absent, so the forged composition cannot be checked against a plan" };
  }
  const failures = [];

  // (a) selection equality. The plan is what status reported and what the bump classifier read; a
  // forge that produced a different set makes both of those a description of something else.
  const skillsDir = join(ctx.SRC_ABS, ".agents", "skills");
  const forged = subdirs(skillsDir).sort();
  const planned = [...plan.skills].sort();
  const extra = forged.filter((s) => !planned.includes(s));
  const missing = planned.filter((s) => !forged.includes(s));
  if (extra.length) failures.push(`forged but not planned: ${extra.join(", ")}`);
  if (missing.length) failures.push(`planned but not forged: ${missing.join(", ")}`);

  // (b) every skill can say why it is there. An unexplained skill in a published core is a skill
  // nobody can decide to remove later.
  for (const skill of forged) {
    const why = plan.reasons?.[skill];
    if (!why?.length || why.includes("unattributed")) {
      failures.push(`'${skill}' carries no inclusion reason`);
    }
  }

  // (c) a default build ships no pack-derived skill. An explicit broader mode records the additions
  // as intentional rather than failing — the point is that the choice is visible, not that it is
  // forbidden.
  if (ctx.PACK_SKILLS === "none") {
    for (const skill of forged) {
      const why = plan.reasons?.[skill] || [];
      if (why.some((r) => r.startsWith("agent-pack:"))) {
        failures.push(`'${skill}' is pack-derived but --pack-skills is none`);
      }
    }
  }

  // (d) no development surface reached the runtime. Checked on the ARTIFACT, not on the projection
  // that produced it: a gate that re-asks the projector the question it already answered proves
  // only that the projector is self-consistent.
  // The excluded set is named by the ENGINE in its plan, not imported here. Importing the
  // projection module would bind this script to the whole skill-manifest chain, and a second local
  // copy of the list is precisely the divergence the projection exists to prevent.
  const excludedDirs = plan.runtimeExcludedDirs?.length ? plan.runtimeExcludedDirs : [];
  const forbidden = [];
  for (const skill of forged) {
    for (const dir of excludedDirs) {
      if (existsSync(join(skillsDir, skill, dir))) forbidden.push(`${skill}/${dir}/`);
    }
  }
  if (!excludedDirs.length) {
    failures.push("the plan named no runtime-excluded directories — this core was forged by an "
      + "engine that predates runtime projection, so its payload cannot be graded");
  }
  if (forbidden.length) {
    failures.push(`development surfaces shipped: ${forbidden.sort().join(", ")}`);
  }

  // (e) no family adapter outlived its family. A command or agent port for a skill set the core no
  // longer carries is a menu entry that fails when someone picks it.
  for (const orphan of orphanFamilyAdapters(ctx, forged)) failures.push(`orphan adapter: ${orphan}`);

  if (failures.length) {
    return {
      ok: false,
      note: `the forged core is not the composition its plan resolved (${failures.length} problem(s))`,
      tail: failures.join("\n"),
    };
  }
  return {
    ok: true,
    note: `${forged.length} skill(s), preset ${ctx.PRESET}, --pack-skills ${ctx.PACK_SKILLS}, `
      + `no development surface, every skill attributed`,
  };
}

export function orphanFamilyAdapters(ctx, forged) {
  const families = [
    { prefix: "sk-bmad-", paths: [".claude/commands/bmad", ".gemini/commands/bmad"] },
  ];
  const orphans = [];
  for (const family of families) {
    if (forged.some((s) => s.startsWith(family.prefix))) continue;
    for (const rel of family.paths) {
      if (existsSync(join(ctx.SRC_ABS, ...rel.split("/")))) orphans.push(rel);
    }
  }
  return orphans.sort();
}
