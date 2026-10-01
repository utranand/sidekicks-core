// `sidekicks cli-executor task <executor>` — assign exactly one self-contained task to ANY registered
// executor and return its final answer.
//
// The generic form of the per-CLI `agy|codex|claude|bedrock task` shortcuts, over the same shared
// factory (task-verb.mjs): an executor registered later gets the one-shot verb, --model and its
// registered default model/effort without a namespace module of its own. No bound default tier —
// the model comes from --model, --tier, or the executor's default_model, and fails closed otherwise.
//
// Zero npm dependencies. Node built-ins plus existing framework modules only; macOS + Windows.

import { createTaskVerb, parseTaskRequest as parseShared } from './task-verb.mjs';

/** @param {string[]} argv */
export function parseTaskRequest(argv) {
  return parseShared(argv, 'cli-executor task', { executorPositional: true });
}

export const run = createTaskVerb({ namespace: 'cli-executor' });
