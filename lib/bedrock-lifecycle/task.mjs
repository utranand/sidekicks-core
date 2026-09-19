// `sidekicks bedrock task` — assign exactly one self-contained task to the registered
// `bedrock-llm` executor and return its final answer.
//
// This is intentionally a thin convenience surface over cli-executor. It owns no provider URL,
// credential, model id, subprocess flags, or retry loop: the scope-resolved executor registry and
// invokeExecutor remain the single authorities for those. One command creates one child session.
//
// Zero npm dependencies. Node built-ins plus existing framework modules only; macOS + Windows.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveWorkingFolder } from '../active-scope/scope.mjs';
import { effectiveExecutors, MODEL_TIERS, readEffectiveRegistry } from '../cli-executor-lifecycle/_shared.mjs';
import { invokeExecutor } from '../cli-executor-lifecycle/invoke.mjs';
import { ROLES } from '../cli-executor-lifecycle/profiles.mjs';
import { isInside } from '../fs-safety/canonical-path.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';

const EXECUTOR = 'bedrock-llm';
const DEFAULT_ROLE = 'plan';
const DEFAULT_TIER = 'mid';
const BOOLEAN_FLAGS = new Set(['json', 'dry-run', 'verbose']);
const VALUE_FLAGS = new Set(['role', 'tier', 'work-dir', 'prompt-file', 'timeout', 'effort']);
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ answer: Object.freeze({ type: 'string' }) }),
  required: Object.freeze(['answer']),
});

/**
 * Re-parse this verb's raw argv. The global dispatcher treats unknown valued flags as booleans,
 * so both `--role plan` and `--role=plan` must be recovered here (framework-cli hard rule).
 *
 * @param {string[]} argv
 * @returns {{flags: Record<string, string|boolean>, task: string}}
 */
export function parseTaskRequest(argv) {
  const flags = {};
  const positionals = [];
  const list = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < list.length; i += 1) {
    const token = list[i];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      positionals.push(String(token ?? ''));
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    if (!BOOLEAN_FLAGS.has(key) && !VALUE_FLAGS.has(key)) {
      throw new SidekicksError(`bedrock task: unknown flag '--${key}'`, EXIT_USAGE);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }

    if (eq !== -1) {
      flags[key] = body.slice(eq + 1);
      continue;
    }
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new SidekicksError(`bedrock task: --${key} needs a value`, EXIT_USAGE);
    }
    flags[key] = next;
    i += 1;
  }

  // The first two positionals are the namespace and verb. Joining the remainder makes quoting
  // optional for simple tasks while preserving a quoted task byte-for-byte.
  return { flags, task: positionals.slice(2).join(' ').trim() };
}

/** @param {unknown} value */
function nonEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {string} path */
function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Render a path without leaking the machine's repository root into JSON output. */
function displayPath(path, repoRoot) {
  const rel = relative(repoRoot, path);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return rel.split(sep).join('/');
}

function answerFrom(result) {
  if (result.result && typeof result.result.answer === 'string' && result.result.answer.trim() !== '') {
    return result.result.answer.trim();
  }
  if (typeof result.result_text === 'string' && result.result_text.trim() !== '') {
    return result.result_text.trim();
  }
  if (result.result !== null && result.result !== undefined) {
    return typeof result.result === 'string' ? result.result.trim() : JSON.stringify(result.result, null, 2);
  }
  return '';
}

function sanitizedArgs(args, prompt, schemaPath = '') {
  const copy = Array.isArray(args) ? [...args] : [];
  const at = copy.lastIndexOf(prompt);
  if (at !== -1) copy[at] = `<task:${prompt.length} chars>`;
  const schemaAt = schemaPath ? copy.lastIndexOf(schemaPath) : -1;
  if (schemaAt !== -1) copy[schemaAt] = '<temporary-output-schema>';
  return copy;
}

function failureMessage(result) {
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      const message = event.error?.message ?? event.message ?? event.msg?.message;
      if (typeof message === 'string' && message.trim() !== '') return message.trim().slice(0, 500);
    } catch { /* only well-formed JSON error events are safe to surface */ }
  }
  return result.failure_kind || result.parse_error || result.error || `exit ${result.exit_code}`;
}

/**
 * Run the CLI verb. The optional third parameter is dependency injection for deterministic tests;
 * the dispatcher supplies only the first two arguments.
 */
export async function run(ctx, _args, injected = {}) {
  const deps = {
    exists: existsSync,
    readFile: readFileSync,
    readSettings,
    resolveWorkingFolder,
    readEffectiveRegistry,
    effectiveExecutors,
    invokeExecutor,
    isDirectory,
    isInside,
    ...injected,
  };
  const { flags, task: inlineTask } = parseTaskRequest(ctx.argv);
  const role = nonEmpty(flags.role) || DEFAULT_ROLE;
  const tier = nonEmpty(flags.tier) || DEFAULT_TIER;
  const promptFile = nonEmpty(flags['prompt-file']);
  const effort = nonEmpty(flags.effort) || undefined;

  if (!ROLES.includes(role)) {
    throw new SidekicksError(`bedrock task: --role must be one of ${ROLES.join(', ')}`, EXIT_VALIDATION);
  }
  if (!MODEL_TIERS.includes(tier)) {
    throw new SidekicksError(`bedrock task: --tier must be one of ${MODEL_TIERS.join(', ')}`, EXIT_VALIDATION);
  }
  if (inlineTask && promptFile) {
    throw new SidekicksError('bedrock task: pass either an inline task or --prompt-file, not both', EXIT_USAGE);
  }

  let prompt = inlineTask;
  if (promptFile) {
    if (promptFile === '-') {
      prompt = String(deps.readFile(0, 'utf8'));
    } else {
      const absPrompt = isAbsolute(promptFile) ? promptFile : resolve(ctx.repoRoot, promptFile);
      if (!deps.exists(absPrompt)) {
        throw new SidekicksError(`bedrock task: --prompt-file not found: ${promptFile}`, EXIT_VALIDATION);
      }
      prompt = String(deps.readFile(absPrompt, 'utf8'));
    }
  }
  if (prompt.trim() === '') {
    throw new SidekicksError(
      'bedrock task: provide one task as text or with --prompt-file <path|->',
      EXIT_USAGE,
    );
  }

  const settings = deps.readSettings(ctx.repoRoot);
  const scope = deps.resolveWorkingFolder(settings, ctx.repoRoot);
  const requestedWorkDir = nonEmpty(flags['work-dir']);
  const workDir = requestedWorkDir
    ? (isAbsolute(requestedWorkDir) ? resolve(requestedWorkDir) : resolve(ctx.repoRoot, requestedWorkDir))
    : scope.workdir;
  if (!deps.isDirectory(workDir)) {
    throw new SidekicksError(`bedrock task: working directory does not exist: ${requestedWorkDir || workDir}`, EXIT_VALIDATION);
  }
  const scopeBoundary = scope.servicePath || scope.projectPath;
  if (!deps.isInside(workDir, scopeBoundary)) {
    throw new SidekicksError(
      `bedrock task: --work-dir must stay inside the active scope (${displayPath(scopeBoundary, ctx.repoRoot)})`,
      EXIT_VALIDATION,
    );
  }

  let timeoutMs;
  if (flags.timeout !== undefined) {
    timeoutMs = Number(flags.timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new SidekicksError('bedrock task: --timeout must be a positive integer in milliseconds', EXIT_VALIDATION);
    }
  }

  const registry = deps.readEffectiveRegistry(ctx.repoRoot, settings);
  const spec = deps.effectiveExecutors(registry)[EXECUTOR];
  if (!spec) {
    throw new SidekicksError(
      `bedrock task: executor '${EXECUTOR}' is not registered in the active scope`,
      EXIT_VALIDATION,
    );
  }
  if (spec.enabled === false) {
    throw new SidekicksError(`bedrock task: executor '${EXECUTOR}' is disabled in the active scope`, EXIT_VALIDATION);
  }

  if (flags['dry-run']) {
    // Use the same builder as the real invocation so dry-run validates role, tier, profile, model,
    // and containment without starting a child process.
    const { buildInvocation } = await import('../cli-executor-lifecycle/profiles.mjs');
    const previewSchemaPath = join(tmpdir(), 'sidekicks-bedrock-task-output.schema.json');
    const invocation = buildInvocation({
      name: EXECUTOR,
      spec,
      role,
      tier,
      prompt,
      workDir,
      ...(effort !== undefined ? { effort } : {}),
      schemaPath: previewSchemaPath,
      schemaJson: JSON.stringify(OUTPUT_SCHEMA),
    });
    const preview = {
      executor: EXECUTOR,
      role,
      tier,
      model: invocation.model,
      effort: invocation.effort,
      containment: invocation.containment,
      enforcement_gaps: invocation.enforcement_gaps,
      work_dir: displayPath(workDir, ctx.repoRoot),
      task_chars: prompt.length,
      argv: sanitizedArgs(invocation.args, prompt, previewSchemaPath),
      prompt_on_stdin: invocation.stdin !== null,
      one_shot: true,
    };
    const text = flags.json
      ? JSON.stringify(preview, null, 2)
      : `${EXECUTOR} ${role} tier=${tier} model=${invocation.model} [${invocation.containment}] one-shot dry run`;
    return { stdout: `${text}\n`, exitCode: EXIT_OK };
  }

  const schemaDir = mkdtempSync(join(tmpdir(), 'sidekicks-bedrock-task-'));
  const schemaPath = join(schemaDir, 'output.schema.json');
  writeFileSync(schemaPath, `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`, 'utf8');
  let result;
  try {
    result = await deps.invokeExecutor({
      name: EXECUTOR,
      spec,
      role,
      tier,
      prompt,
      cwd: workDir,
      ...(effort !== undefined ? { effort } : {}),
      schemaPath,
      schemaJson: JSON.stringify(OUTPUT_SCHEMA),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } finally {
    rmSync(schemaDir, { recursive: true, force: true });
  }
  const answer = answerFrom(result);
  if (!result.ok || answer === '') {
    throw new SidekicksError(`bedrock task failed: ${failureMessage(result)}`, EXIT_VALIDATION);
  }

  if (flags.json) {
    const { stdout: _stdout, stderr: _stderr, ...summary } = result;
    const payload = {
      ...summary,
      args: sanitizedArgs(summary.args, prompt, schemaPath),
      answer,
      work_dir: displayPath(workDir, ctx.repoRoot),
      one_shot: true,
    };
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };
  }
  return { stdout: `${answer}\n`, exitCode: EXIT_OK };
}
