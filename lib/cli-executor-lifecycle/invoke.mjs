// lib/cli-executor-lifecycle/invoke.mjs
// `sidekicks cli-executor invoke` — run ONE agent-CLI session in a named role, and the reusable API
// the goal engine dispatches through.
//
// ASYNCHRONOUS, ALWAYS. Every long-running agent call uses `spawn`, never `spawnSync`: the parent
// has to persist the child's pid and native session id BEFORE it blocks, or a crash mid-attempt
// leaves a run that cannot tell "this child is still alive" from "this child never started" — and
// the wrong answer there means a duplicate dispatch. `spawnSync` survives in exactly one place: the
// sub-millisecond `where`/`which` probe that resolves the binary.
//
// WINDOWS IS NOT A FOOTNOTE. Agent CLIs install as `.cmd` shims, and since the CVE-2024-24576
// hardening Node REFUSES to spawn a batch shim with `shell: false` — it is a hard EINVAL, so a
// naive port does not degrade, it never launches. The fix is a `cmd.exe` layer built from an audited
// encoder, and this module IMPORTS that encoder (lib/agent-lifecycle/_win-argv.mjs) rather than
// carrying a second copy: model- and user-derived text reaches this argv verbatim, so one reviewed
// escaping implementation is worth more than a tidier dependency graph. `shell: true` is never the
// answer — it would hand the same text to a shell one layer further out.
//
// THE PARENT IS THE ONLY WRITER. This function writes nothing under the run folder. It captures,
// parses and RETURNS; the caller persists. That is what makes a parallel fan-out (the plan contest)
// safe without a second lock.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { read as readSettings } from '../settings-store/settings.mjs';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { cmdShimSpawn, isCmdShim } from '../agent-lifecycle/_win-argv.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { parseFlags, readEffectiveRegistry, effectiveExecutors } from './_shared.mjs';
import {
  ROLES,
  WINDOWS_COMMAND_LIMIT,
  buildInvocation,
  containmentNote,
} from './profiles.mjs';

/** Keep only enough stdout in memory to parse a result; the transcript is the caller's business. */
const STDOUT_CAP = 4 * 1024 * 1024;
/** Enough stderr to classify a failure (a quota wall vs a crash) without unbounded growth. */
const STDERR_CAP = 64 * 1024;
/** Default per-attempt ceiling. Long, because a real implementation turn is slow; still bounded. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Grace between SIGTERM and SIGKILL on a timeout. */
const KILL_GRACE_MS = 10_000;
/** Final grace for Node to observe process closure after SIGKILL before the parent settles anyway. */
const CLOSE_GRACE_MS = 1_000;
const GROUP_VERIFY_MS = 1_000;

export function executorSpecDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function assertApprovedInvocation(input) {
  if (input.approvedExecutorSpecDigest === undefined && input.approvedBinding === undefined
      && input.bindingDigest === undefined) return;
  if (typeof input.approvedExecutorSpecDigest !== 'string'
      || executorSpecDigest(input.spec) !== input.approvedExecutorSpecDigest) {
    throw new SidekicksError('[executor-snapshot-drift] invocation spec differs from the approved frozen snapshot', EXIT_VALIDATION);
  }
  if (!input.approvedBinding || typeof input.bindingDigest !== 'string') {
    throw new SidekicksError('[executor-binding-invalid] approved binding and digest are required together', EXIT_VALIDATION);
  }
  const approved = input.approvedBinding;
  const actualDigest = `sha256:${createHash('sha256').update(canonicalJson(approved), 'utf8').digest('hex')}`;
  if (actualDigest !== input.bindingDigest
      || canonicalJson(input.approvedContainment) !== canonicalJson(approved.containment)
      || approved.executor !== input.name
      || approved.role !== input.role
      || approved.model_ref !== input.model
      || approved.invoke_id !== input.invokeId
      || approved.effort !== input.effort
      || approved.containment?.profile !== input.spec?.sandbox) {
    throw new SidekicksError('[executor-binding-drift] invocation arguments differ from the approved binding', EXIT_VALIDATION);
  }
}

// Keep the process-group leader alive until its direct CLI child has finished. This gives the
// supervisor an owned, non-reusable group id when it kills surviving descendants on normal exit.
// IPC carries only the exit code; stdout and stderr remain ordinary streams.
const GROUP_LEADER = String.raw`
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
process.once('message', ([command, args, options]) => {
const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.on('error', error => process.send?.({ type: 'done', code: null, error: error.message }));
child.on('close', code => process.stdout.write('', () => process.stderr.write('',
  () => process.send?.({ type: 'done', code }))));
});
`;

async function verifyProcessGroupGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const deadline = Date.now() + GROUP_VERIFY_MS;
  do {
    try { process.kill(-pid, 0); }
    catch (error) { if (error?.code === 'ESRCH') return true; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return false;
}

/** Validation vocabulary used by the schemas this lifecycle supplies to agent CLIs. */
const SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', '$defs', 'definitions', 'title', 'description', 'default', 'examples',
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minimum', 'maximum',
  '$ref', 'anyOf', 'allOf', 'oneOf',
]);
const SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

function jsonEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left);
  const b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

/** Check the whole supported schema before any executor is launched. */
export function validateOutputSchema(root) {
  const visited = new Set();
  const active = new Set();
  const record = (condition, path, message) => {
    if (!condition) throw new Error(`${path}: ${message}`);
  };
  const schemaObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const resolveRef = (ref, path) => {
    record(typeof ref === 'string' && ref.startsWith('#/'), path, 'unsupported schema reference');
    let target = root;
    for (const raw of ref.slice(2).split('/')) {
      record(!/~(?![01])/.test(raw), path, 'invalid reference escape');
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      record(schemaObject(target) && Object.hasOwn(target, key), path, `unresolved schema reference ${ref}`);
      target = target[key];
    }
    return target;
  };
  const visit = (schema, path, depth = 0) => {
    record(depth <= 64, path, 'schema recursion limit exceeded');
    if (typeof schema === 'boolean') return;
    record(schemaObject(schema), path, 'schema must be an object or boolean');
    record(!active.has(schema), path, 'cyclic schema reference');
    if (visited.has(schema)) return;
    active.add(schema);
    for (const key of Object.keys(schema)) record(SCHEMA_KEYWORDS.has(key), path, `unsupported schema keyword ${key}`);
    for (const key of ['$schema', '$id', 'title', 'description']) {
      if (Object.hasOwn(schema, key)) record(typeof schema[key] === 'string', path, `${key} must be a string`);
    }
    if (Object.hasOwn(schema, 'examples')) record(Array.isArray(schema.examples), path, 'examples must be an array');
    if (Object.hasOwn(schema, 'type')) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      record(types.length > 0 && types.every((type) => SCHEMA_TYPES.has(type))
        && new Set(types).size === types.length, path, 'invalid type');
    }
    if (Object.hasOwn(schema, 'enum')) record(Array.isArray(schema.enum) && schema.enum.length > 0, path, 'enum must be a nonempty array');
    if (Object.hasOwn(schema, 'required')) {
      record(Array.isArray(schema.required) && schema.required.every((key) => typeof key === 'string')
        && new Set(schema.required).size === schema.required.length, path, 'required must be an array of unique strings');
    }
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (Object.hasOwn(schema, key)) record(Number.isSafeInteger(schema[key]) && schema[key] >= 0, path, `${key} must be a nonnegative integer`);
    }
    for (const key of ['minimum', 'maximum']) {
      if (Object.hasOwn(schema, key)) record(typeof schema[key] === 'number' && Number.isFinite(schema[key]), path, `${key} must be a number`);
    }
    if (Object.hasOwn(schema, 'pattern')) {
      record(typeof schema.pattern === 'string', path, 'pattern must be a string');
      try { new RegExp(schema.pattern, 'u'); } catch { throw new Error(`${path}: invalid schema pattern`); }
    }
    for (const key of ['$defs', 'definitions', 'properties']) {
      if (!Object.hasOwn(schema, key)) continue;
      record(schemaObject(schema[key]), path, `${key} must be an object`);
      for (const [name, part] of Object.entries(schema[key])) visit(part, `${path}.${key}.${name}`, depth + 1);
    }
    for (const key of ['items', 'additionalProperties']) {
      if (Object.hasOwn(schema, key)) visit(schema[key], `${path}.${key}`, depth + 1);
    }
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (!Object.hasOwn(schema, key)) continue;
      record(Array.isArray(schema[key]) && schema[key].length > 0, path, `${key} must be a nonempty array`);
      schema[key].forEach((part, index) => visit(part, `${path}.${key}[${index}]`, depth + 1));
    }
    if (Object.hasOwn(schema, '$ref')) visit(resolveRef(schema.$ref, path), `${path}.$ref`, depth + 1);
    active.delete(schema);
    visited.add(schema);
  };
  visit(root, '$');
}

/**
 * Validate the parsed document against the exact schema sent to the CLI. Unknown assertion
 * keywords fail closed: accepting them without checking would turn an unvalidated result into a
 * successful attempt. Semantic rules beyond JSON Schema remain the goal engine's responsibility.
 * Returns one useful error path, or null on success.
 */
function schemaViolation(value, schema, root = schema, path = '$', depth = 0) {
  if (depth > 64) return `${path}: schema recursion limit exceeded`;
  if (schema === true) return null;
  if (schema === false) return `${path}: schema rejects this value`;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return `${path}: invalid schema`;
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) return `${path}: unsupported schema keyword ${key}`;
  }
  const check = (part, next = value, at = path) => schemaViolation(next, part, root, at, depth + 1);
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) {
      return `${path}: unsupported schema reference ${String(schema.$ref)}`;
    }
    let target = root;
    for (const segment of schema.$ref.slice(2).split('/')) {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      target = target?.[key];
    }
    if (target === undefined) return `${path}: unresolved schema reference ${schema.$ref}`;
    const issue = check(target);
    if (issue) return issue;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = (type) => {
      if (type === 'null') return value === null;
      if (type === 'array') return Array.isArray(value);
      if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
      return typeof value === type;
    };
    if (!types.some(matches)) return `${path}: expected ${types.join(' or ')}`;
  }
  if (schema.enum !== undefined && !schema.enum.some((item) => jsonEqual(item, value))) {
    return `${path}: value is not in enum`;
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) {
    return `${path}: value does not match const`;
  }
  for (const [keyword, count] of [['anyOf', 1], ['oneOf', 1]]) {
    if (schema[keyword] !== undefined) {
      if (!Array.isArray(schema[keyword])) return `${path}: ${keyword} must be an array`;
      const matches = schema[keyword].filter((part) => check(part) === null).length;
      if (keyword === 'anyOf' ? matches < count : matches !== count) return `${path}: ${keyword} failed`;
    }
  }
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf)) return `${path}: allOf must be an array`;
    for (const part of schema.allOf) {
      const issue = check(part);
      if (issue) return issue;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return `${path}: below minLength`;
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return `${path}: above maxLength`;
    if (schema.pattern !== undefined) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) return `${path}: does not match pattern`;
      } catch { return `${path}: invalid schema pattern`; }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above maximum`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: below minItems`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: above maxItems`;
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i += 1) {
        const issue = check(schema.items, value[i], `${path}[${i}]`);
        if (issue) return issue;
      }
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${path}.${key}: required property missing`;
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        const issue = check(properties[key], item, `${path}.${key}`);
        if (issue) return issue;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key}: additional property forbidden`;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const issue = check(schema.additionalProperties, item, `${path}.${key}`);
        if (issue) return issue;
      }
    }
  }
  return null;
}

/**
 * Classify failures that are safe for the goal engine's bounded runtime fallback.
 *
 * This is intentionally descriptive, not a policy decision: the goal engine still decides whether
 * a substitute is allowed. Keeping the cause on the invocation result makes context exhaustion and
 * a broken VPN distinguishable from an ordinary program exit in session.json and routing events.
 *
 * @param {{timedOut?: boolean, error?: unknown, stderr?: string, stdout?: string,
 *          exitCode?: number|null, invalidOutput?: boolean, parseError?: string|null}} input
 * @returns {'timeout'|'rate-limit'|'auth'|'permission-denied'|'context-limit'|'network'|'launch'|'process-exit'|'invalid-output'|null}
 */
export function classifyExecutorFailure(input = {}) {
  if (input.timedOut) return 'timeout';
  if (input.exitCode === 0 && (input.invalidOutput || input.parseError)) return 'invalid-output';
  if (!input.error && input.exitCode === 0 && !input.invalidOutput && !input.parseError) return null;
  const text = [input.error, input.stderr, input.stdout]
    .filter((v) => v !== null && v !== undefined)
    .map(String)
    .join('\n');

  if (/context(?:[_ -](?:window|length))?(?:[_ -]is)?[_ -](?:exceeded|too[_ -](?:large|long))|maximum context (?:length|window)|too many (?:input )?tokens|input (?:is )?too long|prompt (?:is )?too long|token limit (?:is )?exceeded/i.test(text)) {
    return 'context-limit';
  }
  if (/\b(?:429|rate[_ -]?limit(?:[_ -]?exceeded|ed|ing)?|quota(?: exceeded)?|too many requests|session limit|resource[_ -]?exhausted)\b/i.test(text)) {
    return 'rate-limit';
  }
  if (/\b(?:401|unauthori[sz]ed|unauthenticated|invalid[_ -]?(?:api[_ -]?)?key|expired token|authentication[_ -](?:error|failed)|login required|not logged in)\b/i.test(text)) {
    return 'auth';
  }
  if (/\b(?:403|forbidden|permission[_ -]?denied|access denied|operation not permitted|sandbox denied|EACCES|EPERM)\b/i.test(text)) {
    return 'permission-denied';
  }
  if (/\b(?:ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN)\b|socket hang up|network is unreachable|connection (?:was )?(?:reset|refused|terminated)|fetch failed|TLS handshake|(?:502|503|504) (?:bad gateway|service unavailable|gateway timeout)/i.test(text)) {
    return 'network';
  }
  if (input.error) return 'launch';
  if (input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0) return 'process-exit';
  if (input.invalidOutput || input.parseError) return 'invalid-output';
  return null;
}

/**
 * Resolve the spawnable binary for a CLI name.
 *
 * On Windows the `.cmd` form is probed FIRST, because that is what an npm install actually puts on
 * PATH; resolving the bare name there yields something `spawn` cannot execute.
 *
 * @param {string} bin
 * @returns {{bin: string, resolved: string|null, shim: boolean}}
 */
export function resolveExecutorBinary(bin) {
  // An absolute path is already the answer. `which`/`where` on an absolute path is inconsistent
  // across platforms and shells, and a registry entry is allowed to name a binary outside PATH.
  if (isAbsolute(bin) && existsSync(bin)) {
    return { bin, resolved: bin, shim: isCmdShim(bin) };
  }
  if (process.platform === 'win32') {
    for (const candidate of [`${bin}.cmd`, `${bin}.bat`, bin]) {
      const probe = spawnSync('where', [candidate], { encoding: 'utf8', windowsHide: true });
      if (!probe.error && probe.status === 0) {
        const first = String(probe.stdout || '').split(/\r?\n/).find((l) => l.trim() !== '');
        const resolved = first ? first.trim() : candidate;
        return { bin: resolved, resolved, shim: isCmdShim(resolved) };
      }
    }
    return { bin, resolved: null, shim: false };
  }
  const probe = spawnSync('which', [bin], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) {
    const resolved = String(probe.stdout || '').trim();
    return { bin: resolved || bin, resolved: resolved || bin, shim: false };
  }
  return { bin, resolved: null, shim: false };
}

/**
 * Parse a CLI's stdout into the structured result, session id and usage figures it exposes.
 *
 * Deliberately tolerant about SHAPE and strict about SOURCE: only documented terminal output is
 * read, and anything not found comes back null so the caller's own validator fails closed rather
 * than this function inventing a plausible value.
 *
 * @param {string} parser - one of profiles.mjs OUTPUT_PARSERS
 * @param {string} stdout
 * @param {{schemaExpected?: boolean}} [options]
 * @returns {{result: unknown, text: string|null, sessionId: string|null,
 *            usage: {tokens: number|null, usd: number|null}, parseError: string|null}}
 */
export function parseExecutorOutput(parser, stdout, options = {}) {
  const empty = { result: null, text: null, sessionId: null, usage: { tokens: null, usd: null }, parseError: null };
  const raw = String(stdout ?? '');
  if (raw.trim() === '') return { ...empty, parseError: 'the CLI produced no stdout' };

  /** Try to read a JSON document out of possibly-noisy stdout. */
  const asObject = () => {
    try {
      return JSON.parse(raw);
    } catch { /* fall through to a bounded recovery */ }
    // Some CLIs prepend a banner line. Recover the outermost object, and nothing cleverer.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  };

  /** A payload that may be a JSON string OR an object already. */
  const unwrap = (value) => {
    if (value === null || value === undefined) return { result: null, text: null };
    if (typeof value === 'object') return { result: value, text: null };
    const text = String(value);
    try {
      return { result: JSON.parse(text), text };
    } catch {
      // Some OpenAI-compatible gateways accept Codex's --output-schema flag but do not enforce it
      // at the wire. The model can then wrap the otherwise-valid result document in one explicit
      // ```json fence, with prose on either side. Recovery is safe only when the CALLER actually
      // supplied a schema and the message contains exactly one such fence; schema-less examples or
      // multiple competing documents remain text-only for the caller to reject.
      if (options.schemaExpected === true) {
        const fences = [...text.matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
        if (fences.length === 1) {
          try {
            return { result: JSON.parse(fences[0][1].trim()), text };
          } catch { /* preserve the original text-only result below */ }
        }
      }
      return { result: null, text };
    }
  };

  if (parser === 'codex-jsonl') {
    let sessionId = null;
    let tokens = null;
    let usd = null;
    let last = null;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.startsWith('{')) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // Session/thread identity, in each spelling the installed CLI has used.
      for (const key of ['session_id', 'thread_id', 'conversation_id']) {
        if (typeof rec[key] === 'string') sessionId = rec[key];
        if (rec.msg && typeof rec.msg[key] === 'string') sessionId = rec.msg[key];
        if (rec.item && typeof rec.item[key] === 'string') sessionId = rec.item[key];
      }
      const usage = rec.usage || rec.msg?.usage || rec.item?.usage || rec.info?.total_token_usage;
      if (usage && typeof usage === 'object') {
        const total = Number(
          usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
        );
        if (Number.isFinite(total) && total > 0) tokens = total;
      }
      // The final assistant payload, in each documented spelling.
      const candidate = rec.msg?.message ?? rec.item?.text ?? rec.item?.message ?? rec.message ?? null;
      if (typeof candidate === 'string' && candidate.trim() !== '') last = candidate;
      if (typeof rec.msg?.last_agent_message === 'string') last = rec.msg.last_agent_message;
    }
    const { result, text } = unwrap(last);
    return {
      result,
      text,
      sessionId,
      usage: { tokens, usd },
      parseError: last === null ? 'no agent message found in the JSONL event stream' : null,
    };
  }

  const doc = asObject();
  if (doc === null) {
    return { ...empty, text: raw.slice(0, STDERR_CAP), parseError: 'stdout is not JSON' };
  }

  if (parser === 'claude-json') {
    // Claude Code emits the schema-validated document in `structured_output` when
    // `--json-schema` is present. `result` remains the human-facing final text. Prefer the
    // enforced payload, while retaining the older result/response shapes for sessions without a
    // schema and for older CLI versions.
    // `text` / `sessionId` are Grok's single-object `--output-format json` spellings
    // (docs: user-guide/14-headless-mode.md). Claude's names stay preferred.
    const { result, text } = unwrap(doc.structured_output ?? doc.result ?? doc.response ?? doc.text ?? null);
    const usageObj = doc.usage || {};
    const tokens = Number(
      usageObj.total_tokens
      ?? ((usageObj.input_tokens ?? 0) + (usageObj.output_tokens ?? 0)),
    );
    const sessionId = typeof doc.session_id === 'string' ? doc.session_id
      : typeof doc.sessionId === 'string' ? doc.sessionId : null;
    return {
      result,
      text,
      sessionId,
      usage: {
        tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : null,
        usd: Number.isFinite(Number(doc.total_cost_usd)) ? Number(doc.total_cost_usd) : null,
      },
      parseError: doc.is_error === true ? String(doc.result ?? 'the CLI reported is_error') : null,
    };
  }

  if (parser === 'agy-json') {
    const { result, text } = unwrap(doc.response ?? doc.result ?? doc.output ?? null);
    const stats = doc.stats || doc.usage || {};
    const tokens = Number(stats.total_tokens ?? stats.totalTokens ?? NaN);
    return {
      result,
      text,
      sessionId: typeof doc.session_id === 'string' ? doc.session_id : null,
      usage: { tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : null, usd: null },
      parseError: result === null && text === null ? 'no response field in the JSON output' : null,
    };
  }

  // 'text' — the whole stdout is the payload.
  const { result, text } = unwrap(raw);
  return { result, text, sessionId: null, usage: { tokens: null, usd: null }, parseError: null };
}

/**
 * The spawn triple for a resolved binary — the ONE place the Windows shim decision is made.
 *
 * Exported and platform-explicit so the argv boundary is testable on either OS: the failure mode
 * being guarded (a metacharacter in model- or user-derived text escaping the quoted region and
 * appending commands to the launch line) is not reproducible only on the machine that has the shim.
 *
 * @param {string} bin - the RESOLVED executable path
 * @param {string[]} args
 * @returns {{command: string, args: string[], options: object, shim: boolean}}
 */
export function buildLaunch(bin, args) {
  if (isCmdShim(bin)) {
    const shim = cmdShimSpawn([bin, ...args]);
    return { ...shim, shim: true };
  }
  return { command: bin, args: args.slice(), options: {}, shim: false };
}

/**
 * A floor on the command-line length the OS will see, in characters.
 *
 * A floor rather than an exact figure: on Windows the caret escaping in `cmdCommandLine` expands
 * metacharacters, so the real line is at least this long and usually longer. Comparing a floor
 * against the ceiling is the safe direction — it can refuse a command that would just have fitted,
 * never accept one that would have been truncated.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {number}
 */
export function commandLineFloor(bin, args) {
  return [bin, ...args].reduce((n, a) => n + String(a).length + 3, 0);
}

/**
 * Refuse an over-length command line before dispatch.
 *
 * Truncation is not a degraded mode: a schema cut in half is a DIFFERENT schema, and a prompt cut in
 * half is a different instruction. Both would run, and both would look like a model failure.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{platform?: string, role?: string, limit?: number}} [opts]
 * @throws {SidekicksError} EXIT_VALIDATION
 */
export function assertCommandLength(bin, args, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return;
  const limit = opts.limit ?? WINDOWS_COMMAND_LIMIT;
  const floor = commandLineFloor(bin, args);
  if (floor <= limit) return;
  throw new SidekicksError(
    `cli-executor invoke: the ${opts.role || 'agent'} command line is at least ${floor} characters, past `
    + `the Windows ${limit} ceiling. Shrink the inline schema or move the prompt to a file — it is `
    + 'never truncated silently, because a schema cut in half is a different schema.',
    EXIT_VALIDATION,
  );
}

/**
 * Merge caller environment over the parent's, case-insensitively for PATH.
 *
 * WINDOWS SPELLS IT `Path`. A plain `{...process.env, ...extra}` with `extra.PATH` set leaves BOTH keys
 * in the object there, and which one the child sees is not something to rely on — a caller that
 * prepends a directory to PATH would find its addition silently ignored. Since the whole point of
 * setting PATH here is the goal engine's command guard, "silently ignored" is a boundary that is not
 * there.
 *
 * @param {Record<string, string|undefined>} base
 * @param {Record<string, string>|undefined} extra
 * @returns {Record<string, string|undefined>}
 */
export function mergeEnv(base, extra) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (key.toLowerCase() === 'path') {
      for (const existing of Object.keys(merged)) {
        if (existing.toLowerCase() === 'path') delete merged[existing];
      }
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Build the environment for one executor child.
 *
 * Claude Code sets `CLAUDECODE` in its own process tree and refuses to start another Claude Code
 * process while that marker is present. A Sidekicks supervisor deliberately launches a separate,
 * bounded worker process, so remove the marker from that child only. The parent environment and
 * every non-Claude executor keep it unchanged.
 *
 * It is also where the child learns WHO dispatched it. Four `SIDEKICKS_*` variables identify the
 * invocation, so an executor that keeps its own record — `bedrock-llm`, whose shim writes a call log
 * — can attribute a row to the run that caused it instead of recording an anonymous `direct` call.
 * Purely additive: an executor that ignores them behaves exactly as before, and their absence is a
 * meaningful answer rather than a gap (a shell invocation genuinely IS direct).
 *
 * @param {Record<string, string|undefined>} base
 * @param {Record<string, string>|undefined} extra
 * @param {string} parser
 * @param {{executor?: string, invocationId?: string, role?: string, tier?: string}} [stamp]
 * @returns {Record<string, string|undefined>}
 */
export function childEnvironment(base, extra, parser, stamp = {}) {
  const merged = mergeEnv(base, extra);
  if (parser === 'claude-json') {
    for (const key of Object.keys(merged)) {
      if (key.toLowerCase() === 'claudecode') delete merged[key];
    }
  }
  const stamps = {
    // A nested Sidekicks call belongs to this child CLI, not to the supervisor's host.
    SIDEKICKS_HOST_CLI: stamp.executor,
    SIDEKICKS_EXECUTOR: stamp.executor,
    SIDEKICKS_INVOCATION_ID: stamp.invocationId,
    SIDEKICKS_EXECUTOR_ROLE: stamp.role,
    SIDEKICKS_EXECUTOR_TIER: stamp.tier,
  };
  for (const [key, value] of Object.entries(stamps)) {
    // An explicit `env` entry from the caller wins: a test or a supervisor that set one meant it.
    if (value && (key === 'SIDEKICKS_HOST_CLI' || merged[key] === undefined)) merged[key] = String(value);
  }
  return merged;
}

/**
 * Signal a child AND everything it spawned.
 *
 * An agent CLI shells out constantly, and `child.kill()` reaches only the direct process. POSIX
 * uses a detached group leader held alive through CLI completion, so the group id is owned when
 * signalled. Windows has no stdlib Job Object: only the ChildProcess handle is signalled, and the
 * result remains cleanup-unknown because a PID tree walk could target a recycled process.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {'SIGTERM'|'SIGKILL'} signal
 */
export function signalTree(child, signal) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    // Never launch `taskkill /PID`: the numeric pid can be recycled between observation and kill.
    // libuv owns the direct ChildProcess handle, so this is the only process safe to signal here.
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * Run one agent-CLI session to completion.
 *
 * @param {{name: string, spec: object, role: string, tier?: string|null, prompt: string, cwd: string,
 *          model?: string|null, effort?: string|null,
 *          schemaPath?: string|null, schemaJson?: string|null, resumeSession?: string|null,
 *          timeoutMs?: number, env?: Record<string, string>, invocationId?: string|null,
 *          onSpawn?: (info: {pid: number|null, bin: string, args: string[]}) => void,
 *          baseEnv?: Record<string, string|undefined>,
 *          spawnImpl?: Function, now?: () => number, killGraceMs?: number,
 *          closeGraceMs?: number,
 *          verifyProcessGroupGoneImpl?: (pid: number) => Promise<boolean>}} input
 * @returns {Promise<object>}
 */
export async function invokeExecutor(input) {
  assertApprovedInvocation(input);
  const schemaExpected = Boolean(input.schemaPath || input.schemaJson);
  let outputSchema = null;
  if (schemaExpected) {
    try {
      outputSchema = JSON.parse(input.schemaJson ?? readFileSync(input.schemaPath, 'utf8'));
      if (outputSchema === null || (typeof outputSchema !== 'object' && typeof outputSchema !== 'boolean')) {
        throw new Error('schema must be an object or boolean');
      }
      validateOutputSchema(outputSchema);
    } catch (error) {
      throw new SidekicksError(`cli-executor invoke: invalid output schema: ${error.message}`, EXIT_VALIDATION);
    }
  }
  const invocation = buildInvocation({
    name: input.name,
    spec: input.spec,
    role: input.role,
    tier: input.tier,
    prompt: input.prompt,
    ...(input.model ? { model: input.model } : {}),
    ...(input.invokeId ? { invokeId: input.invokeId } : {}),
    workDir: input.cwd ?? null,
    // Forwarded only when the caller actually supplied one: `undefined` keeps the registry's
    // per-tier map in charge, while an explicit `null` means "no effort flag".
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    schemaPath: input.schemaPath ?? null,
    schemaJson: input.schemaJson ?? null,
    resumeSession: input.resumeSession ?? null,
  });
  if (input.approvedBinding && (
    (invocation.model_ref !== null && invocation.model_ref !== input.approvedBinding.model_ref)
    || invocation.invoke_id !== input.approvedBinding.invoke_id
    || invocation.effort !== input.approvedBinding.effort
  )) {
    throw new SidekicksError('[executor-built-invocation-drift] built invocation differs from the approved exact route', EXIT_VALIDATION);
  }

  const requestedTimeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(invocation.maxRuntimeMs)
    ? Math.min(requestedTimeoutMs, invocation.maxRuntimeMs)
    : requestedTimeoutMs;

  const resolved = resolveExecutorBinary(invocation.bin);
  if (resolved.resolved === null) {
    const error = `cli-executor invoke: '${invocation.bin}' is not on PATH — install the CLI or register a `
      + 'different executor. A missing binary fails closed rather than falling back to another CLI.';
    return {
      ok: false,
      execution_transport: 'external-cli',
      executor: input.name,
      role: input.role,
      tier: input.tier,
      model: invocation.model,
      model_ref: invocation.model_ref,
      invoke_id: invocation.invoke_id,
      effort: invocation.effort,
      family: invocation.family,
      containment: invocation.containment,
      containment_note: containmentNote(input.name, input.spec, input.role),
      schema_transport: invocation.schema,
      resumed: invocation.resumed,
      bin: invocation.bin,
      args: invocation.args,
      pid: null,
      exit_code: null,
      killed: false,
      cleanup_status: 'not-started',
      timed_out: false,
      timeout_ms: timeoutMs,
      timeout_capped: timeoutMs < requestedTimeoutMs,
      failure_kind: 'launch',
      duration_ms: 0,
      stdout: '',
      stderr: '',
      result: null,
      result_text: null,
      session_id: null,
      usage: { tokens: null, usd: null },
      parse_error: null,
      error,
    };
  }

  // The ceiling is checked with the RESOLVED binary in hand, because the shim path is part of what
  // has to fit.
  assertCommandLength(resolved.bin, invocation.args, { role: input.role });

  const launch = buildLaunch(resolved.bin, invocation.args);

  const killGraceMs = Number(input.killGraceMs ?? KILL_GRACE_MS);
  const closeGraceMs = Number(input.closeGraceMs ?? CLOSE_GRACE_MS);
  const spawnFn = input.spawnImpl || spawn;
  const groupLeader = process.platform !== 'win32' && !input.spawnImpl;
  const verifyGroupGone = input.verifyProcessGroupGoneImpl || verifyProcessGroupGone;
  const now = input.now || Date.now;
  const startedAt = now();

  return new Promise((settle) => {
    const child = spawnFn(groupLeader ? process.execPath : launch.command,
      groupLeader ? ['-e', GROUP_LEADER] : launch.args, {
      ...launch.options,
      cwd: input.cwd,
      env: childEnvironment(input.baseEnv ?? process.env, input.env, invocation.parser, {
        executor: input.name,
        invocationId: input.invocationId,
        role: input.role,
        tier: input.tier,
      }),
      // stdin is `pipe` ONLY when there is something to write. An OPEN, empty stdin makes
      // `codex exec` wait for EOF forever; 'ignore' is EOF immediately.
      stdio: groupLeader
        ? [invocation.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe', 'ipc']
        : [invocation.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let acknowledgementError = null;

    let out = '';
    let err = '';
    let killed = false;
    let timedOut = false;
    let settled = false;
    let groupDone = null;
    // A direct child has no independently verified process-tree boundary. Even after a normal
    // close, surviving descendants cannot be excluded; durable callers map `unsupported` to an
    // unknown/parked terminal receipt instead of claiming success from one pid.
    let cleanupStatus = groupLeader ? 'pending' : 'unsupported';
    let hardKillTimer = null;
    let forceSettleTimer = null;

    const releaseChildHandles = () => {
      // A transport bug can keep pipe handles referenced after the process tree is gone. Closing
      // those handles and detaching the ChildProcess object keeps a force-settled invocation from
      // pinning the whole orchestrator process in Node's event loop.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { stream?.destroy?.(); } catch { /* best-effort cleanup after a hard timeout */ }
      }
      try { child.unref?.(); } catch { /* the process may already have fully closed */ }
    };

    child.stdout.on('data', (chunk) => {
      if (out.length < STDOUT_CAP) out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err = (err + chunk.toString()).slice(-STDERR_CAP);
    });

    const killTimer = setTimeout(() => {
      killed = true;
      timedOut = true;
      signalTree(child, 'SIGTERM');
      hardKillTimer = setTimeout(() => {
        signalTree(child, 'SIGKILL');
        // A broken transport can leave Node waiting for pipe closure even after the process tree is
        // gone. The run must still settle: late child events are ignored by finish's settled guard.
        forceSettleTimer = setTimeout(
          () => {
            releaseChildHandles();
            finish(null, new Error('executor did not close after its process tree was killed'));
          },
          closeGraceMs,
        );
        if (forceSettleTimer.unref) forceSettleTimer.unref();
      }, killGraceMs);
      if (hardKillTimer.unref) hardKillTimer.unref();
    }, timeoutMs);
    if (killTimer.unref) killTimer.unref();

    const finish = async (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      // The group leader was killed while it still owned its pid, so verification here cannot
      // accidentally target a reused pid. A lingering group fails closed in the matrix.
      if (groupLeader && child.pid) cleanupStatus = await verifyGroupGone(child.pid) ? 'verified' : 'failed';
      else if (!groupLeader && (timedOut || acknowledgementError !== null)) cleanupStatus = 'unknown';
      const parsed = parseExecutorOutput(invocation.parser, out, {
        schemaExpected,
      });
      let schemaError = null;
      if (schemaExpected) {
        if (parsed.result === null || parsed.result === undefined) {
          schemaError = 'schema-backed invocation returned no structured result';
        } else {
          try { schemaError = schemaViolation(parsed.result, outputSchema); }
          catch (error) { schemaError = `schema validation failed: ${error.message}`; }
        }
      }
      const parseError = parsed.parseError ?? schemaError;
      const classifiedFailure = classifyExecutorFailure({
        timedOut,
        error: spawnError,
        stderr: err,
        stdout: out,
        exitCode: code,
        invalidOutput: schemaError !== null,
        parseError,
      });
      const failureKind = acknowledgementError !== null
        ? 'acknowledgement'
        : cleanupStatus === 'failed' ? 'cleanup-failed' : classifiedFailure;
      settle({
        ok: acknowledgementError === null && code === 0 && !timedOut && !spawnError
          && parseError === null && cleanupStatus !== 'failed',
        execution_transport: 'external-cli',
        executor: input.name,
        role: input.role,
        tier: input.tier,
        model: invocation.model,
        model_ref: invocation.model_ref,
        invoke_id: invocation.invoke_id,
        effort: invocation.effort,
        family: invocation.family,
        containment: invocation.containment,
        containment_note: containmentNote(input.name, input.spec, input.role),
        schema_transport: invocation.schema,
        resumed: invocation.resumed,
        bin: launch.command,
        args: launch.args,
        pid: child.pid ?? null,
        exit_code: code,
        killed,
        cleanup_status: cleanupStatus,
        timed_out: timedOut,
        timeout_ms: timeoutMs,
        timeout_capped: timeoutMs < requestedTimeoutMs,
        failure_kind: failureKind,
        duration_ms: Math.max(0, now() - startedAt),
        stdout: out,
        stderr: err,
        result: parsed.result,
        result_text: parsed.text,
        session_id: parsed.sessionId,
        usage: parsed.usage,
        parse_error: parseError,
        provider_activity: acknowledgementError === null ? null : 'unknown',
        error: acknowledgementError !== null
          ? `launch acknowledgement persistence failed: ${acknowledgementError.message}`
          : spawnError ? String(spawnError.message || spawnError) : null,
      });
    };

    if (groupLeader) {
      child.on('message', (message) => {
        if (message?.type !== 'done' || groupDone) return;
        groupDone = message;
        // The leader is alive at this point, so its process-group id cannot have been reused.
        signalTree(child, 'SIGKILL');
      });
    }
    child.on('error', (e) => { void finish(null, e); });
    child.on('close', (code) => { void finish(groupDone ? groupDone.code : code,
      groupDone?.error ? new Error(groupDone.error) : null); });

    // Install every terminal listener before calling external persistence code. The pid is still
    // handed back synchronously before the prompt is written or the POSIX group leader is told to
    // create the provider. If persistence fails, cleanup cannot race past an unattached `close`
    // listener and the prompt is never sent. A direct Windows/custom-spawn child may already have
    // crossed into provider code, so its returned activity remains `unknown`; only the owned direct
    // child handle is signalled, never a numeric-pid tree walk.
    if (input.onSpawn) {
      try {
        input.onSpawn({ pid: child.pid ?? null, bin: launch.command, args: launch.args });
      } catch (error) {
        acknowledgementError = error instanceof Error ? error : new Error(String(error));
        signalTree(child, 'SIGKILL');
      }
    }
    if (acknowledgementError === null) {
      if (groupLeader) child.send([launch.command, launch.args, launch.options]);
      if (invocation.stdin !== null && child.stdin) {
        child.stdin.on('error', () => { /* the CLI closed stdin early; the prompt is already flushed */ });
        child.stdin.end(invocation.stdin);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The CLI verb
// ---------------------------------------------------------------------------

/**
 * `sidekicks cli-executor invoke --executor <n> --tier <t> --role <r> [--work-dir <p>]
 *  --prompt-file <p> [--output-schema <p>] [--timeout <ms>] [--dry-run] [--json]`
 *
 * Every valued flag is read by re-parsing `ctx.argv`: the dispatcher's own `parseArgs` is
 * booleans-only with `strict: false`, so `--role plan` would otherwise arrive as `{role: true}` plus
 * a stray positional `plan` — silently working in the `--role=plan` spelling and silently breaking
 * in the other.
 *
 * @param {{repoRoot: string, argv: string[], flags: object, log: Function}} ctx
 * @param {object} _args
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx, _args) {
  const flags = parseFlags(ctx.argv, ['json', 'dry-run', 'root']);

  const executor = str(flags.executor);
  const role = str(flags.role);
  const tier = str(flags.tier);
  const promptFile = str(flags['prompt-file']);
  const schemaFile = str(flags['output-schema']);
  const workDir = str(flags['work-dir']) || ctx.repoRoot;
  // An explicit effort overrides the executor's own `efforts[tier]` map for this one session — the
  // same override an orchestration preset applies per role, exposed here so a seat can be checked
  // by hand before it is pinned into a preset.
  const effortFlag = str(flags.effort);
  const effort = effortFlag ? effortFlag : undefined;

  if (!executor || !role || !tier || !promptFile) {
    throw new SidekicksError(
      'cli-executor invoke: usage: cli-executor invoke --executor <name> --tier <top|high|mid|low> '
      + '--role <plan|implement|review|final-verify> --prompt-file <path> [--work-dir <path>] '
      + '[--effort <value>] [--output-schema <path>] [--timeout <ms>] [--dry-run] [--json]',
      EXIT_USAGE,
    );
  }
  if (!ROLES.includes(role)) {
    throw new SidekicksError(
      `cli-executor invoke: --role must be one of ${ROLES.join(', ')} (got '${role}')`,
      EXIT_VALIDATION,
    );
  }

  const settings = readSettings(ctx.repoRoot);
  const registry = readEffectiveRegistry(ctx.repoRoot, settings);
  const executors = effectiveExecutors(registry);
  const spec = executors[executor];
  if (!spec) {
    throw new SidekicksError(
      `cli-executor invoke: unknown executor '${executor}' — 'cli-executor list' shows the effective `
      + 'set. An unknown executor fails closed; nothing is substituted for it.',
      EXIT_VALIDATION,
    );
  }
  if (spec.enabled === false) {
    throw new SidekicksError(`cli-executor invoke: executor '${executor}' is disabled in this scope`, EXIT_VALIDATION);
  }

  const promptPath = isAbsolute(promptFile) ? promptFile : resolvePath(ctx.repoRoot, promptFile);
  if (!existsSync(promptPath)) {
    throw new SidekicksError(`cli-executor invoke: --prompt-file not found: ${promptFile}`, EXIT_VALIDATION);
  }
  const prompt = readFileSync(promptPath, 'utf8');

  let schemaPath = null;
  let schemaJson = null;
  if (schemaFile) {
    const abs = isAbsolute(schemaFile) ? schemaFile : resolvePath(ctx.repoRoot, schemaFile);
    if (!existsSync(abs)) {
      throw new SidekicksError(`cli-executor invoke: --output-schema not found: ${schemaFile}`, EXIT_VALIDATION);
    }
    schemaPath = abs;
    // An inline-schema CLI needs the compact JSON text, not the path. Reading it here means the
    // caller passes ONE flag regardless of which transport the CLI uses.
    schemaJson = JSON.stringify(JSON.parse(readFileSync(abs, 'utf8')));
  }

  if (flags['dry-run']) {
    const invocation = buildInvocation({
      name: executor, spec, role, tier, prompt, schemaPath, schemaJson, workDir,
      ...(effort !== undefined ? { effort } : {}),
    });
    const resolved = resolveExecutorBinary(invocation.bin);
    const payload = {
      execution_transport: 'external-cli',
      executor,
      role,
      tier,
      model: invocation.model,
      effort: invocation.effort,
      family: invocation.family,
      containment: invocation.containment,
      containment_note: containmentNote(executor, spec, role),
      schema_transport: invocation.schema,
      binary: resolved.resolved,
      cmd_shim: resolved.shim,
      argv: invocation.args,
      prompt_on_stdin: invocation.stdin !== null,
      command_length: invocation.commandLength,
    };
    return { stdout: `${JSON.stringify(payload, null, 2)}\n`, exitCode: EXIT_OK };
  }

  const result = await invokeExecutor({
    name: executor,
    spec,
    role,
    tier,
    prompt,
    cwd: workDir,
    ...(effort !== undefined ? { effort } : {}),
    schemaPath,
    schemaJson,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
  });

  if (flags.json) {
    // stdout/stderr are deliberately NOT in the JSON payload: a transcript belongs in a file, not in
    // a machine-readable summary a caller may log wholesale.
    const { stdout, stderr, ...summary } = result;
    return { stdout: `${JSON.stringify(summary, null, 2)}\n`, exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
  }

  const lines = [
    `${executor} ${role} [${result.containment}] model=${result.model}`
    + `${result.effort ? ` effort=${result.effort}` : ''} exit=${result.exit_code}`
    + `${result.timed_out ? ' TIMED OUT' : ''} ${result.duration_ms}ms`,
    result.failure_kind ? `failure: ${result.failure_kind}` : null,
    result.parse_error ? `parse: ${result.parse_error}` : null,
    result.error ? `error: ${result.error}` : null,
    result.result_text ? result.result_text : (result.result ? JSON.stringify(result.result, null, 2) : null),
  ].filter(Boolean);

  return { stdout: `${lines.join('\n')}\n`, exitCode: result.ok ? EXIT_OK : EXIT_VALIDATION };
}

/**
 * A flag value as a non-empty string, or ''. `parseFlags` yields `''` for a valued flag given with
 * no value and `true` for a boolean, so both collapse to "not supplied".
 *
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}
