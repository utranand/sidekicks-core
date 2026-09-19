#!/usr/bin/env node
// fable-escalation-hook.mjs — UserPromptSubmit hook (condition-triggered)
//
// Why this exists: the Fable fleet's auto-escalation ladder (CLAUDE.md → "Fable
// fleet — standing seat bindings") says stuck-ness should trigger a fleet seat
// WITHOUT the user naming one — but a written convention only binds the model
// when it recalls it at the right moment. This hook is the deterministic nudge:
// when a prompt REPORTS stuck-ness or repeated failure ("still failing", "same
// error", "didn't work", "I'm stuck", …) it injects a one-line reminder of the
// escalation ladder, so the moment of stuck-ness and the reminder always
// coincide.
//
// It does NOT decide to spawn anything — dispatch stays the model's judgment,
// bounded by the ladder's one-dispatch-per-failure-point rule. It is silent on
// every prompt that does not report stuck-ness, silent on slash commands, and
// never blocks a prompt: any error is swallowed.
//
// Wired in .claude/settings.json (UserPromptSubmit)
// (BeforeAgent), and .codex/config.toml (UserPromptSubmit) — same script, per
// Rule 6. Antigravity has no prompt-hook event; the CLAUDE.md ladder alone
// covers it there. Zero dependencies.

import { readFileSync } from 'node:fs';

// High-precision stuck-report phrases. Bare "fail"/"error"/"broken" do NOT
// fire — only phrasings that report a repeated or persistent failure state.
const STUCK = new RegExp(
  String.raw`\b(` +
    [
      String.raw`still\s+(failing|fails|broken|stuck|not\s+work\w*)`,
      String.raw`same\s+(error|failure|problem)`,
      String.raw`didn'?t\s+work`,
      String.raw`doesn'?t\s+work`,
      String.raw`failed\s+again`,
      String.raw`keeps?\s+(failing|breaking)`,
      String.raw`tried\s+everything`,
      String.raw`no\s+luck`,
      String.raw`can'?t\s+(fix|figure|resolve|get\s+past)`,
      String.raw`giv(e|ing)\s+up`,
      String.raw`stuck`,
      String.raw`unresolv(ed|able)`,
    ].join('|') +
    String.raw`)\b`,
  'i'
);

const DIRECTIVE =
  `[fable-escalation] This prompt reports stuck-ness or repeated failure. Before ` +
  `another identical attempt, apply the auto-escalation ladder (CLAUDE.md → "Fable ` +
  `fleet — standing seat bindings"): a technical blocker → ONE bounded ` +
  `sk-fable-resolver dispatch (reproduce, root-cause, smallest fix at the cause); a ` +
  `judgment blocker or an urge to give up / de-scope → sk-fable-thinker, or convene ` +
  `sk-fable-council when a blind spot would be expensive; a load-bearing ` +
  `external claim asserted from memory → sk-fable-researcher. One dispatch per ` +
  `failure point, ever — if a seat already ran on this same failure, surface its ` +
  `evidence to the user instead of re-dispatching. Hard gates (Rule 4 DB writes, ` +
  `Teleport-only prod, irreversible/outward actions) are unchanged by escalation.`;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  // Delegate wakes are exempt: the wake prompt's conversation-context block can
  // quote past chat ("still failing", "same error") and would false-positive
  // the stuck regex on an autonomous session that is not stuck. The escalation
  // ladder still reaches wakes via CLAUDE.md. Interactive sessions only.
  if (process.env.SIDEKICKS_DELEGATE_WAKE === '1') return;

  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return; // malformed payload — stay out of the way
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt) return;
  if (/^\s*\//.test(prompt)) return; // slash command — never annotate
  if (!STUCK.test(prompt)) return; // no stuck report — silent

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: DIRECTIVE,
      },
    })
  );
}

// Framework gate: `sidekicks framework disable <id>` makes this hook a no-op (exit 0).
await import('./lib/hook-gate.mjs')
  .then((gate) => gate.exitIfDisabled('hook.fable-escalation'))
  .catch(() => {}); // gate module absent (partial copy) ⇒ run anyway

main();
