// `sidekicks bedrock task` — assign exactly one self-contained task to the registered
// `bedrock-llm` executor and return its final answer.
//
// A thin binding over the shared one-shot task verb (lib/cli-executor-lifecycle/task-verb.mjs). It
// owns no provider URL, credential, model id, subprocess flags, or retry loop: the scope-resolved
// executor registry and invokeExecutor remain the single authorities for those. Bedrock keeps its
// tier-based default (`mid`) when neither --model nor --tier is given.
//
// Zero npm dependencies. Node built-ins plus existing framework modules only; macOS + Windows.

import { createTaskVerb, parseTaskRequest as parseShared } from '../cli-executor-lifecycle/task-verb.mjs';

/** @param {string[]} argv */
export function parseTaskRequest(argv) {
  return parseShared(argv, 'bedrock task');
}

export const run = createTaskVerb({ namespace: 'bedrock', executor: 'bedrock-llm', defaultTier: 'mid' });
