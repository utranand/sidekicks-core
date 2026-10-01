// lib/cli-executor-lifecycle/task-verb.mjs
// Shared implementation of the one-shot `sidekicks <cli> task` verbs (`bedrock`, `agy`, `codex`,
// `claude`) and the generic `sidekicks cli-executor task <executor>`: assign exactly one
// self-contained task to ONE registered executor and return its final answer.
//
// Each namespace module is a thin binding over createTaskVerb(). The verb owns no provider URL,
// credential, subprocess flag or retry loop: the scope-resolved executor registry and
// invokeExecutor remain the single authorities for those. One command creates one child session.
//
// Model/effort selection (resolveSelection in profiles.mjs): --model › --tier › the executor's
// registered default_model; --effort › the tier's effort › default_effort. A verb bound with a
// defaultTier (bedrock → mid) keeps its tier-based behaviour when neither --model nor --tier is given.
//
// Zero npm dependencies. Node built-ins plus existing framework modules only; macOS + Windows.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveWorkingFolder } from '../active-scope/scope.mjs';
import { isInside } from '../fs-safety/canonical-path.mjs';
import { writeAtomic } from '../fs-safety/fsx.mjs';
import { resolveRunBase } from '../active-scope/run-base.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { read as readSettings } from '../settings-store/settings.mjs';
import { catalogStatus, effectiveExecutors, MODEL_TIERS, readEffectiveRegistry } from './_shared.mjs';
import { invokeExecutor } from './invoke.mjs';
import { buildInvocation, ROLES } from './profiles.mjs';

const DEFAULT_ROLE = 'plan';
const BOOLEAN_FLAGS = new Set(['json', 'dry-run', 'verbose']);
const VALUE_FLAGS = new Set(['role', 'tier', 'model', 'work-dir', 'prompt-file', 'timeout', 'effort']);
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ answer: Object.freeze({ type: 'string' }) }),
  required: Object.freeze(['answer']),
});

/**
 * Re-parse a task verb's raw argv. The global dispatcher treats unknown valued flags as booleans,
 * so both `--role plan` and `--role=plan` must be recovered here (framework-cli hard rule).
 *
 * @param {string[]} argv
 * @param {string} [label] - the `<namespace> task` prefix used in error messages
 * @param {{executorPositional?: boolean}} [options] - when true, the first positional after the
 *   verb names the executor (the generic `cli-executor task <executor>` form)
 * @returns {{flags: Record<string, string|boolean>, task: string, executor?: string}}
 */
export function parseTaskRequest(argv, label = 'task', { executorPositional = false } = {}) {
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
      throw new SidekicksError(`${label}: unknown flag '--${key}'`, EXIT_USAGE);
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
      throw new SidekicksError(`${label}: --${key} needs a value`, EXIT_USAGE);
    }
    flags[key] = next;
    i += 1;
  }

  // The first two positionals are the namespace and verb. Joining the remainder makes quoting
  // optional for simple tasks while preserving a quoted task byte-for-byte.
  const rest = positionals.slice(2);
  if (executorPositional) {
    return { flags, executor: (rest[0] ?? '').trim(), task: rest.slice(1).join(' ').trim() };
  }
  return { flags, task: rest.join(' ').trim() };
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
    // agy prints its prose and then the schema object on the last line, and its parser leaves both
    // in result_text; prefer the structured answer when that trailing line carries one.
    const lines = result.result_text.trim().split(/\r?\n/);
    const last = lines[lines.length - 1].trim();
    if (last.startsWith('{')) {
      try {
        const parsed = JSON.parse(last);
        if (typeof parsed.answer === 'string' && parsed.answer.trim() !== '') return parsed.answer.trim();
      } catch { /* not a schema object — fall through to the raw text */ }
    }
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
  if (result.failure_kind) return String(result.failure_kind);
  if (result.timed_out) return 'timeout';
  if (result.parse_error) return 'output_parse_failed';
  if (result.error) return 'launch_failed';
  if (result.exit_code !== 0) return 'nonzero_exit';
  return 'empty_result';
}

function safeFailureDiagnostic(result, executor, role, tier) {
  return {
    schema_version: 1,
    created_at: bangkokTimestamp(Date.now()),
    executor,
    role,
    tier: tier || null,
    exit_code: Number.isInteger(result.exit_code) ? result.exit_code : null,
    timed_out: result.timed_out === true,
    failure_class: failureMessage(result),
    parser_status: result.parse_error ? 'failed' : 'no_valid_result',
    stdout_bytes: Buffer.byteLength(String(result.stdout ?? ''), 'utf8'),
    stderr_bytes: Buffer.byteLength(String(result.stderr ?? ''), 'utf8'),
  };
}

/**
 * Bind a one-shot task verb to one executor. With `executor` omitted, the verb reads the executor
 * name from the first positional instead (`sidekicks cli-executor task <executor> "<task>"`), so any
 * registered executor gets the one-shot form without its own namespace module.
 *
 * @param {{namespace: string, executor?: string|null, defaultTier?: string|null}} binding
 * @returns {(ctx: object, args: object, injected?: object) => Promise<{stdout: string, exitCode: number}>}
 */
export function createTaskVerb({ namespace, executor: boundExecutor = null, defaultTier = null }) {
  const label = `${namespace} task`;

  /**
   * Run the CLI verb. The optional third parameter is dependency injection for deterministic tests;
   * the dispatcher supplies only the first two arguments.
   */
  return async function run(ctx, _args, injected = {}) {
    const deps = {
      exists: existsSync,
      readFile: readFileSync,
      readSettings,
      resolveWorkingFolder,
      resolveRunBase,
      readEffectiveRegistry,
      effectiveExecutors,
      invokeExecutor,
      isDirectory,
      isInside,
      ...injected,
    };
    const parsed = parseTaskRequest(ctx.argv, label, { executorPositional: !boundExecutor });
    const { flags, task: inlineTask } = parsed;
    const executor = boundExecutor || parsed.executor;
    if (!executor) {
      throw new SidekicksError(`${label}: name the executor first — ${label} <executor> "<task>"`, EXIT_USAGE);
    }
    const role = nonEmpty(flags.role) || DEFAULT_ROLE;
    const model = nonEmpty(flags.model) || undefined;
    // A bound default tier applies only when the caller named neither a model nor a tier; an
    // explicit --model must not be overridden by the tier's mapped id.
    const tier = nonEmpty(flags.tier) || (model ? null : defaultTier);
    const promptFile = nonEmpty(flags['prompt-file']);
    const effort = nonEmpty(flags.effort) || undefined;

    if (!ROLES.includes(role)) {
      throw new SidekicksError(`${label}: --role must be one of ${ROLES.join(', ')}`, EXIT_VALIDATION);
    }
    if (tier && !MODEL_TIERS.includes(tier)) {
      throw new SidekicksError(`${label}: --tier must be one of ${MODEL_TIERS.join(', ')}`, EXIT_VALIDATION);
    }
    if (inlineTask && promptFile) {
      throw new SidekicksError(`${label}: pass either an inline task or --prompt-file, not both`, EXIT_USAGE);
    }

    let prompt = inlineTask;
    if (promptFile) {
      if (promptFile === '-') {
        prompt = String(deps.readFile(0, 'utf8'));
      } else {
        const absPrompt = isAbsolute(promptFile) ? promptFile : resolve(ctx.repoRoot, promptFile);
        if (!deps.exists(absPrompt)) {
          throw new SidekicksError(`${label}: --prompt-file not found: ${promptFile}`, EXIT_VALIDATION);
        }
        prompt = String(deps.readFile(absPrompt, 'utf8'));
      }
    }
    if (prompt.trim() === '') {
      throw new SidekicksError(`${label}: provide one task as text or with --prompt-file <path|->`, EXIT_USAGE);
    }

    const settings = deps.readSettings(ctx.repoRoot);
    const scope = deps.resolveWorkingFolder(settings, ctx.repoRoot);
    const requestedWorkDir = nonEmpty(flags['work-dir']);
    const workDir = requestedWorkDir
      ? (isAbsolute(requestedWorkDir) ? resolve(requestedWorkDir) : resolve(ctx.repoRoot, requestedWorkDir))
      : scope.workdir;
    if (!deps.isDirectory(workDir)) {
      throw new SidekicksError(`${label}: working directory does not exist: ${requestedWorkDir || workDir}`, EXIT_VALIDATION);
    }
    const scopeBoundary = scope.servicePath || scope.projectPath;
    if (!deps.isInside(workDir, scopeBoundary)) {
      throw new SidekicksError(
        `${label}: --work-dir must stay inside the active scope (${displayPath(scopeBoundary, ctx.repoRoot)})`,
        EXIT_VALIDATION,
      );
    }

    let timeoutMs;
    if (flags.timeout !== undefined) {
      timeoutMs = Number(flags.timeout);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new SidekicksError(`${label}: --timeout must be a positive integer in milliseconds`, EXIT_VALIDATION);
      }
    }

    const registry = deps.readEffectiveRegistry(ctx.repoRoot, settings);
    const spec = deps.effectiveExecutors(registry)[executor];
    if (!spec) {
      throw new SidekicksError(`${label}: executor '${executor}' is not registered in the active scope`, EXIT_VALIDATION);
    }
    if (spec.enabled === false) {
      throw new SidekicksError(`${label}: executor '${executor}' is disabled in the active scope`, EXIT_VALIDATION);
    }

    const selection = {
      ...(tier ? { tier } : { tier: null }),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };

    if (flags['dry-run']) {
      // Use the same builder as the real invocation so dry-run validates role, model, effort and
      // containment without starting a child process.
      const previewSchemaPath = join(tmpdir(), `sidekicks-${namespace}-task-output.schema.json`);
      const invocation = buildInvocation({
        name: executor,
        spec,
        role,
        ...selection,
        prompt,
        workDir,
        schemaPath: previewSchemaPath,
        schemaJson: JSON.stringify(OUTPUT_SCHEMA),
      });
      const catalog = catalogStatus(spec, invocation.model, invocation.effort);
      const preview = {
        executor,
        role,
        tier: tier || null,
        model: invocation.model,
        effort: invocation.effort,
        catalog_status: catalog.status,
        ...(catalog.reason ? { catalog_reason: catalog.reason } : {}),
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
        : `${executor} ${role}${tier ? ` tier=${tier}` : ''} model=${invocation.model}`
          + `${invocation.effort ? ` effort=${invocation.effort}` : ''} [${invocation.containment}] one-shot dry run`;
      return { stdout: `${text}\n`, exitCode: EXIT_OK };
    }

    const schemaDir = mkdtempSync(join(tmpdir(), `sidekicks-${namespace}-task-`));
    const schemaPath = join(schemaDir, 'output.schema.json');
    writeFileSync(schemaPath, `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`, 'utf8');
    let result;
    try {
      result = await deps.invokeExecutor({
        name: executor,
        spec,
        role,
        ...selection,
        prompt,
        cwd: workDir,
        schemaPath,
        schemaJson: JSON.stringify(OUTPUT_SCHEMA),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    } finally {
      rmSync(schemaDir, { recursive: true, force: true });
    }
    const answer = answerFrom(result);
    if (!result.ok || answer === '') {
      const diagnostic = safeFailureDiagnostic(result, executor, role, tier);
      const runBase = deps.resolveRunBase(settings, ctx.repoRoot, { skillId: 'sk-cli-executor' }).runBase;
      const diagnosticPath = join(runBase, 'failures', `one-shot-${Date.now()}.json`);
      mkdirSync(join(runBase, 'failures'), { recursive: true });
      writeAtomic(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
      const pathRef = displayPath(diagnosticPath, ctx.repoRoot);
      if (flags.json) return { stdout: `${JSON.stringify({ ok: false, ...diagnostic, diagnostic: pathRef }, null, 2)}\n`, exitCode: EXIT_VALIDATION };
      throw new SidekicksError(`${label} failed: ${diagnostic.failure_class}; safe diagnostic: ${pathRef}`, EXIT_VALIDATION);
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
  };
}
