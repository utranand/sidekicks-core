// `sidekicks claude task` — assign exactly one self-contained task to the built-in `claude` executor
// and return its final answer.
//
// A thin binding over the shared one-shot task verb (lib/cli-executor-lifecycle/task-verb.mjs).
// Model/effort come from --model/--effort, else --tier, else the executor's registered
// default_model/default_effort (`sidekicks cli-executor register claude --default-model <id>`).
//
// Zero npm dependencies. Node built-ins plus existing framework modules only; macOS + Windows.

import { createTaskVerb, parseTaskRequest as parseShared } from '../cli-executor-lifecycle/task-verb.mjs';

/** @param {string[]} argv */
export function parseTaskRequest(argv) {
  return parseShared(argv, 'claude task');
}

export const run = createTaskVerb({ namespace: 'claude', executor: 'claude' });
