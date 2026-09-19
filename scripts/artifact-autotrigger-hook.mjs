#!/usr/bin/env node
// artifact-autotrigger-hook.mjs — UserPromptSubmit hook
//
// Why this exists: some Sidekicks artifacts are meant to be EXECUTED by a specific
// skill, but skill triggering is a routing decision the model makes from what's in
// context at prompt time. When the user hands over only a *path*, the file's
// `▶ RUN THIS … ◀` banner is invisible (it lives inside the file, not in the
// prompt), so nothing reliably routes the artifact to its skill. This hook closes
// that gap deterministically for two artifact shapes:
//
//   • a COMMAND-SEQUENCE   → invoke the sk-commander skill (run the steps)
//   • a PLAN-INPUTS file   → invoke the sk-implementation-planner skill
//                            (consume the keys and produce the plan)
//   • a MISSION-INPUTS file → invoke the sk-get-plan-done skill
//                            (consume the keys and drive the delivery loop)
//   • a TASKS ARTIFACT     → invoke the sk-get-things-done skill
//                            (enter/resume the stage-gated queue loop)
//
// On every prompt it reads any referenced file, classifies it, and injects a
// directive telling the agent which skill to invoke.
//
// It is intentionally silent on every prompt that does NOT reference one of these
// artifacts — no output, exit 0 — so it never interferes with normal use. It also
// never blocks a prompt: any error is swallowed and treated as "not an artifact".
//
// Wired via .claude/settings.json → hooks.UserPromptSubmit. Zero dependencies.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// Every banner accepts BOTH skill-id spellings. These regexes run against artifact files ALREADY
// WRITTEN TO DISK — hundreds of command-sequences, plans and task queues whose banner text was baked
// in before the `sidekicks-` → `sk-` rename and is never rewritten. Matching only the current prefix
// would silently stop auto-triggering on every one of them, with no error to notice.
// (`get-(?:it|plan)-done` carries the same tolerance for an older rename of that skill.)
const P = '(?:sidekicks|sk)';
const COMMANDER_BANNER = new RegExp(`RUN THIS (?:FILE )?WITH THE ${P}-commander SKILL`, 'i');
const PLANNER_BANNER = new RegExp(`RUN THIS (?:FILE )?WITH THE ${P}-implementation-planner SKILL`, 'i');
const GETPLANDONE_BANNER = new RegExp(`RUN THIS (?:FILE )?WITH THE ${P}-get-(?:it|plan)-done SKILL`, 'i');
const GTD_BANNER = new RegExp(`LIVE TASK ARTIFACT for the ${P}-get-things-done SKILL`, 'i');

// A plan-inputs file with BOTH requirement placeholders still intact has no
// requirement yet — it's a blank draft to fill, not a plan to run. These strings
// come from assets/plan-inputs.template.yaml; the banner tells the user to fill the
// requirement first, and this gate matches that contract.
const REQ_PLACEHOLDERS = [
  '<path/to/requirement-or-architecture.md>',
  '<describe the change here>',
];

function planInputsReady(text) {
  // ready once the user has supplied a requirement (filled doc OR text)
  return !REQ_PLACEHOLDERS.every((p) => text.includes(p));
}

// Same contract for a mission-inputs file: while BOTH goal placeholders are intact
// the goal is still a blank draft (the banner says "fill the goal first"), so it
// must not auto-run. These strings come from assets/mission-inputs.template.yaml.
const GOAL_PLACEHOLDERS = [
  '<path/to/requirement-or-spec.md>',
  '<describe the outcome you want delivered, end to end>',
];

function missionInputsReady(text) {
  // ready once the user has supplied a goal (filled doc OR text)
  return !GOAL_PLACEHOLDERS.every((p) => text.includes(p));
}

// Classify a chunk of text into the skill that should run it, or null for "leave
// alone". `isAssetPath` is true for bundled templates under .../assets/, which are
// reference blanks and must never auto-run.
function classify(text, { isAssetPath = false } = {}) {
  // Plan-inputs file → the implementation-planner. Checked first: its banner is
  // unambiguous and it never carries a steps:/commander shape. A plan-inputs file
  // legitimately keeps several optional <…> placeholders (unused services, verify
  // command, output path), so the generic placeholder count below is NOT applied to
  // it — the planner is built to consume partial files and default the rest.
  if (PLANNER_BANNER.test(text)) {
    if (isAssetPath) return null; // bundled blank template — never run
    return planInputsReady(text) ? 'planner' : null; // unfilled draft — leave alone
  }

  // Mission-inputs file → get-plan-done. Same banner-first handling as plan-inputs: it
  // carries several optional <…> placeholders (criteria, verify, overrides, scope)
  // by design, so the generic placeholder count below must NOT apply — the conductor
  // is built to consume a partial file and derive the rest. Gate only on the goal.
  if (GETPLANDONE_BANNER.test(text)) {
    if (isAssetPath) return null; // bundled blank template — never run
    return missionInputsReady(text) ? 'getplandone' : null; // unfilled draft — leave alone
  }

  // Command-sequence → the commander. A genuine generated sequence has its
  // <placeholder> tokens filled in; a blank sequence template is riddled with them,
  // so several <…> tokens means "template, leave it alone".
  if (isAssetPath) return null;
  const placeholders = text.match(/<[A-Za-z][^>\n]{0,40}>/g) || [];
  if (placeholders.length >= 3) return null;
  if (COMMANDER_BANNER.test(text)) return 'commander';
  if (/^steps:\s*$/m.test(text) && /^\s*-\s*(skill|run|parallel):/m.test(text)) return 'commander';

  // Tasks artifact → get-things-done. The asset/placeholder gates above already
  // filtered the bundled template and unfilled copies (both are <…>-riddled); a live
  // artifact is filled. Banner first, then the structural shape (queue + control +
  // tasks with id'd entries) so a hand-rolled artifact without the banner still routes.
  if (GTD_BANNER.test(text)) return 'gtd';
  if (
    /^queue:/m.test(text) &&
    /^control:/m.test(text) &&
    /^tasks:/m.test(text) &&
    /^\s*-\s*id:/m.test(text) &&
    /^\s*kind:/m.test(text)
  )
    return 'gtd';
  return null;
}

function expandHome(p) {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Classification supplies routing context, never execution authority. User intent remains
// decisive even when a file contains a RUN banner or is pasted without surrounding prose.
const intentBoundary =
  "Follow the user's requested operation: review, explain, validate and edit requests do not " +
  'authorize execution. A bare path, pasted artifact or banner alone is not execution consent. ' +
  'For an ambiguous handoff, inspect and summarize the artifact; do not start its workflow. ' +
  'Execution retains all action-specific approval gates.';

const DIRECTIVES = {
  commander: (refs) =>
    `[sidekicks] Referenced command-sequence: ${refs}. ` +
    'When the user asks to run it, invoke sk-commander; never execute its steps by hand. ' +
    intentBoundary,
  planner: (refs) =>
    `[sidekicks] Referenced implementation plan-inputs: ${refs}. ` +
    'When the user asks to generate the plan, invoke sk-implementation-planner. ' +
    intentBoundary,
  getplandone: (refs) =>
    `[sidekicks] Referenced delivery mission-inputs: ${refs}. ` +
    'When the user asks to run the mission, invoke sk-get-plan-done. ' +
    intentBoundary,
  gtd: (refs) =>
    `[sidekicks] Referenced task queue: ${refs}. ` +
    'When the user asks to run or resume it, invoke sk-get-things-done and use its recorded state. ' +
    intentBoundary,
};

// Returns true when the prompt is primarily a path hand-off — the user typed a file path
// with little or no surrounding text (e.g. "docs/get-things-done/foo/tasks.yaml" or "go"
// followed by a path). False when the user wrote a full conversational sentence: in that
// case the path match was incidental context (e.g. from SessionStart hook output that the
// model quoted back) and firing a GTD resume directive would hijack a new-task request.
function isPathHandoff(prompt, matchedPath) {
  // Strip the matched path token(s) from the prompt, then check what's left.
  const stripped = prompt.replace(matchedPath, '').trim();
  // ≤ 30 remaining characters = "go", "run this", "resume", bare path, etc.
  return stripped.length <= 30;
}

function main() {
  // Delegate wakes are exempt: the wake prompt is machine-built (delegate.mjs)
  // and its conversation-context block can cite artifact paths from past chat —
  // classifying those would inject a "run this skill" directive into an
  // autonomous drain session and misroute it. Interactive sessions only.
  if (process.env.SIDEKICKS_DELEGATE_WAKE === '1') return;

  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return; // malformed payload — stay out of the way
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  if (!prompt) return;

  const hits = { commander: new Set(), planner: new Set(), getplandone: new Set(), gtd: new Set() };
  const record = (kind, ref) => {
    if (kind) hits[kind].add(ref);
  };

  // Case 1 — the user pasted the file CONTENTS (banner is right there in the prompt).
  record(classify(prompt), '(pasted inline)');

  // Case 2 — the prompt references a path to a .yaml/.yml/.md file. Resolve it,
  // read it, and classify it before reacting.
  // Exception for GTD artifacts: only trigger the resume directive when the path is the
  // PRIMARY content of the prompt (user handed over just a path). A conversational message
  // that incidentally contains a tasks.yaml path (e.g. from SessionStart context injected
  // by the orphan-watch hook) must NOT fire a GTD resume — that would hijack a new-task
  // request and replay old terminated tasks.
  const pathTokens = prompt.match(/[~\w./\\:-]+\.(?:ya?ml|md)\b/g) || [];
  for (const tok of pathTokens) {
    try {
      const abs = isAbsolute(expandHome(tok)) ? expandHome(tok) : resolve(cwd, tok);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const text = readFileSync(abs, 'utf8');
      const kind = classify(text, { isAssetPath: /[/\\]assets[/\\]/.test(abs) });
      // GTD artifacts only route on an explicit path hand-off, not an incidental reference.
      if (kind === 'gtd' && !isPathHandoff(prompt, tok)) continue;
      record(kind, tok);
    } catch {
      // unreadable / not a real path — ignore
    }
  }

  const parts = [];
  for (const kind of ['commander', 'planner', 'getplandone', 'gtd']) {
    if (hits[kind].size) parts.push(DIRECTIVES[kind]([...hits[kind]].join(', ')));
  }
  if (parts.length === 0) return; // nothing to do — silent

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: parts.join(' '),
      },
    })
  );
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.artifact-autotrigger'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

main();
