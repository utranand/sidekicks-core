// One durable attempt boundary shared by every queue role.
//
// The queue supervisor prepares an immutable reservation and private request, then launches this
// module as a detached Node worker. The worker is the sole durable dispatcher and terminal-receipt
// writer. It deliberately does not advance queue state, choose retries/fallbacks, review output, or
// implement the driver loop; the queue-supervisor lifecycle owns those decisions.

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  executorSpecDigest,
  invokeExecutor as invokeExecutorReal,
} from '../cli-executor-lifecycle/invoke.mjs';
import { SECRET_DIR_MODE, SECRET_FILE_MODE, writeAtomic } from '../fs-safety/fsx.mjs';
import { canonicalJson, findAbsolutePath } from '../run-events/schema.mjs';
import { bangkokTimestamp } from '../run-events/store.mjs';
import { EXIT_IO, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import { observeDarwinProcessStartToken } from './process-start.mjs';
import { assertWritableBranches } from './branch-guard.mjs';
import {
  PRIVATE_RECEIPT_ROOT,
  PUBLIC_RUN_ROOT,
  normalizePortableRelativePath,
  resolveWithinRoot,
} from './paths.mjs';
import {
  DURABLE_EXECUTION_SCHEMA_VERSION,
  QUEUE_DRIVER_ID,
  approvalEnvelopeDigest,
  buildAttemptPromptRecord,
  executionBindingDigest,
  normalizeApprovalEnvelope,
  normalizeDurableJob,
  normalizeLaunchAcknowledgement,
  normalizeLaunchReservation,
  normalizePublicResult,
  normalizeTerminalReceipt,
  renderedPromptDigest,
} from './schema.mjs';

const WORKER_FILENAME = fileURLToPath(import.meta.url);
const APPROVAL_ENVELOPE_REF = 'approval-envelope.json';

function invalid(code, message) {
  throw new SidekicksError(`[${code}] durable attempt: ${message}`, EXIT_VALIDATION);
}

function io(code, message) {
  throw new SidekicksError(`[${code}] durable attempt: ${message}`, EXIT_IO);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function documentDigest(value) {
  return sha256(canonicalJson(value));
}

function opaqueId(prefix) {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`;
}

function pathToken(value, length = 32) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonClone(value, field) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('value is not JSON');
    return JSON.parse(encoded);
  } catch (error) {
    invalid('worker-request-invalid', `${field} must be JSON-serializable: ${error.message}`);
  }
}

function rejectPersistedProviderEnv(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid('worker-request-invalid', 'providerEnv must be a plain object when supplied');
  }
  if (Object.keys(value).length > 0) {
    invalid('provider-env-persistence-forbidden', 'provider environment values must be inherited at invocation time and cannot enter a durable request');
  }
}

function normalizedTimeout(value, job) {
  const timeout = value ?? job.budget.max_elapsed_ms;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > job.budget.max_elapsed_ms) {
    invalid('worker-request-invalid', 'timeoutMs must be a positive integer within the approved stage budget');
  }
  return timeout;
}

function assertPortablePersistedValue(value, field) {
  if (typeof value === 'string') {
    const withoutUrls = value.replace(/\bhttps?:\/\/[^\s"'`<>]+/giu, '');
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
        || value.startsWith('~/') || findAbsolutePath(withoutUrls) !== null
        || /(^|[\s"'`(,;:=[{<])\/(?!\/)[^\s"'`<>]+/u.test(withoutUrls)) {
      invalid('artifact-path-invalid', `${field} contains a machine-absolute path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPortablePersistedValue(entry, `${field}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertPortablePersistedValue(key, `${field}.<key>`);
      assertPortablePersistedValue(entry, `${field}.${key}`);
    }
  }
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalRef(value, field) {
  const normalized = normalizePortableRelativePath(value, { allowRoot: false });
  if (value !== normalized) invalid('artifact-path-not-canonical', `${field} must use canonical POSIX separators`);
  return normalized;
}

function ensureContainedDirectory(root, portablePath, { privateDirectory = false } = {}) {
  const normalized = normalizePortableRelativePath(portablePath);
  let current = realpathSync(root);
  if (normalized === '.') return current;
  for (const segment of normalized.split('/')) {
    const next = join(current, segment);
    if (!existsSync(next)) {
      mkdirSync(next, { recursive: false, mode: privateDirectory ? SECRET_DIR_MODE : 0o755 });
    }
    const stat = lstatSync(next);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      invalid('artifact-path-outside-root', `${portablePath} crosses a non-directory or link`);
    }
    const real = realpathSync(next);
    if (!isInside(realpathSync(root), real)) {
      invalid('artifact-path-outside-root', `${portablePath} resolves outside its expected root`);
    }
    if (privateDirectory) hardenOwnerOnly(next, true);
    current = real;
  }
  return current;
}

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:SIDEKICKS_ACL_TARGET
$action = $env:SIDEKICKS_ACL_ACTION
$directory = $env:SIDEKICKS_ACL_DIRECTORY -eq '1'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($action -eq 'set') {
  $acl = Get-Acl -LiteralPath $target
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inheritance = if ($directory) {
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
$acl = Get-Acl -LiteralPath $target
if (-not $acl.AreAccessRulesProtected) { exit 21 }
$ownerSid = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate(
  [Security.Principal.SecurityIdentifier]
).Value
if ($ownerSid -ne $sid.Value) { exit 22 }
$rules = @($acl.Access)
if ($rules.Count -ne 1) { exit 23 }
$ruleSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
if ($ruleSid -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow') { exit 24 }
if (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
    [Security.AccessControl.FileSystemRights]::FullControl) { exit 25 }
`;

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    io('private-acl-unavailable', 'Windows SystemRoot is unavailable');
  }
  const candidate = resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let actual;
  try { actual = realpathSync(candidate); }
  catch { io('private-acl-unavailable', 'the absolute system PowerShell executable is unavailable'); }
  if (!lstatSync(actual).isFile()) io('private-acl-unavailable', 'the system PowerShell path is not a regular file');
  return actual;
}

function windowsAcl(target, directory, action) {
  const result = spawnSync(windowsPowerShellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      SIDEKICKS_ACL_ACTION: action,
      SIDEKICKS_ACL_DIRECTORY: directory ? '1' : '0',
      SIDEKICKS_ACL_TARGET: target,
    },
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    invalid('private-permission-invalid', `owner-only Windows ACL ${action} failed for ${target}: ${detail}`);
  }
}

function hardenOwnerOnly(target, directory) {
  if (process.platform !== 'win32') {
    chmodSync(target, directory ? SECRET_DIR_MODE : SECRET_FILE_MODE);
    return;
  }
  windowsAcl(target, directory, 'set');
}

function assertPrivatePermissions(target) {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('private-permission-invalid', 'private evidence must be a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    invalid('private-permission-invalid', `${target} is accessible outside its owner`);
  }
  if (process.platform === 'win32') windowsAcl(target, false, 'check');
}

function assertPrivateDirectoryChain(repoRoot, privateRoot, target) {
  const attemptParent = dirname(target);
  const rel = relative(privateRoot, attemptParent);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    invalid('artifact-root-mismatch', 'private evidence parent escapes the receipt root');
  }
  const directories = [resolve(repoRoot, '.sidekicks', 'private'), privateRoot];
  let current = privateRoot;
  for (const segment of rel === '' ? [] : rel.split(sep)) {
    current = join(current, segment);
    directories.push(current);
  }
  for (const directory of directories) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      invalid('artifact-path-outside-root', 'private evidence crosses a non-directory or link');
    }
    if (process.platform === 'win32') windowsAcl(directory, true, 'check');
    else if ((stat.mode & 0o077) !== 0) {
      invalid('private-permission-invalid', `${directory} is accessible outside its owner`);
    }
  }
}

function fsyncParent(path) {
  let fd;
  try {
    fd = openSync(dirname(path), 'r');
    fsyncSync(fd);
  } catch (error) {
    const unsupportedOnWindows = process.platform === 'win32'
      && ['EBADF', 'EINVAL', 'EISDIR', 'ENOSYS', 'EPERM'].includes(error?.code);
    if (!unsupportedOnWindows) {
      io('attempt-evidence-fsync-failed', `${dirname(path)} could not be durably synced: ${error.message}`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publishExclusive(path, content, { privateFile = false, observeConflict = false } = {}) {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temp, 'wx', privateFile ? SECRET_FILE_MODE : 0o644);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (privateFile) hardenOwnerOnly(temp, false);
    try {
      linkSync(temp, path);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (observeConflict) {
        if (privateFile) assertPrivatePermissions(path);
        return false;
      }
      const existing = readFileSync(path, 'utf8');
      if (existing !== content) invalid('attempt-evidence-conflict', `${path} already contains different evidence`);
      if (privateFile) assertPrivatePermissions(path);
      return false;
    }
    if (privateFile) hardenOwnerOnly(path, false);
    fsyncParent(path);
    return true;
  } catch (error) {
    if (error instanceof SidekicksError) throw error;
    io('attempt-evidence-write-failed', `${path} could not be published: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function writeJsonExclusive(path, value, options) {
  return publishExclusive(path, jsonText(value), options);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    invalid('attempt-evidence-unreadable', `${label} cannot be read: ${error.message}`);
  }
}

function ensurePrivateRoot(repoRoot) {
  const sidekicksRoot = resolveWithinRoot(repoRoot, '.sidekicks');
  // `.sidekicks/` also carries ordinary committed framework files. Restrict only its dedicated
  // private child; never chmod the shared parent as a side effect of preparing an attempt.
  ensureContainedDirectory(sidekicksRoot, 'private/execution-receipts', { privateDirectory: true });
  return resolveWithinRoot(repoRoot, PRIVATE_RECEIPT_ROOT);
}

/**
 * Publish one immutable owner-only execution record below the authoritative receipt root.
 * Queue lifecycle code uses this for non-provider subprocess evidence (for example approved
 * test claims/results) without creating a second private-write implementation.
 */
export function persistPrivateExecutionRecord(repoRootValue, refValue, value, options = {}) {
  const repoRoot = realpathSync(repoRootValue);
  const privateRoot = ensurePrivateRoot(repoRoot);
  const ref = canonicalRef(refValue, 'private execution record ref');
  ensureContainedDirectory(privateRoot, dirname(ref), { privateDirectory: true });
  const path = resolveWithinRoot(privateRoot, ref, { mustExist: false });
  return writeJsonExclusive(path, value, {
    privateFile: true,
    observeConflict: options.observeConflict === true,
  });
}

/** Read one authoritative owner-only execution record, or null when it does not exist. */
export function readPrivateExecutionRecord(repoRootValue, refValue, label = 'private execution record') {
  const repoRoot = realpathSync(repoRootValue);
  const privateRoot = ensurePrivateRoot(repoRoot);
  const ref = canonicalRef(refValue, 'private execution record ref');
  ensureContainedDirectory(privateRoot, dirname(ref), { privateDirectory: true });
  const path = resolveWithinRoot(privateRoot, ref, { mustExist: false });
  if (!existsSync(path)) return null;
  assertPrivateDirectoryChain(repoRoot, privateRoot, path);
  assertPrivatePermissions(path);
  return readJson(path, label);
}

/**
 * Atomically replace one mutable owner-only execution record below the authoritative receipt root.
 * Immutable claims/results continue to use persistPrivateExecutionRecord; this narrow surface is
 * for the closed supervisor/worker heartbeat paths whose latest complete generation is the
 * durable value. Every immutable request, claim, receipt, settlement, payload and transcript path
 * is rejected by this writer.
 */
export function writePrivateExecutionRecord(repoRootValue, refValue, value) {
  const repoRoot = realpathSync(repoRootValue);
  const privateRoot = ensurePrivateRoot(repoRoot);
  const ref = canonicalRef(refValue, 'private execution record ref');
  if (!/^runs\/[A-Za-z0-9._-]+\/(?:supervisor\/lease|attempts\/[A-Za-z0-9._-]+\/worker-heartbeat)\.json$/u.test(ref)) {
    invalid('private-record-mutable-refused', 'only supervisor and worker heartbeat records are mutable');
  }
  ensureContainedDirectory(privateRoot, dirname(ref), { privateDirectory: true });
  const path = resolveWithinRoot(privateRoot, ref, { mustExist: false });
  if (existsSync(path)) {
    assertPrivateDirectoryChain(repoRoot, privateRoot, path);
    assertPrivatePermissions(path);
  }
  writeAtomic(path, jsonText(value), { mode: SECRET_FILE_MODE });
  hardenOwnerOnly(path, false);
  fsyncParent(path);
  return ref;
}

function repoRootFromRequestPath(requestPath) {
  let current = realpathSync(dirname(requestPath));
  const requestReal = realpathSync(requestPath);
  while (true) {
    const privateDir = dirname(current);
    const sidekicksDir = dirname(privateDir);
    if (basename(current) === 'execution-receipts' && basename(privateDir) === 'private'
        && basename(sidekicksDir) === '.sidekicks' && isInside(current, requestReal)) {
      return realpathSync(dirname(sidekicksDir));
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  invalid('artifact-root-mismatch', 'worker request is not below the canonical private receipt root');
}

function portableLaunchValue(value, repoRoot) {
  const text = String(value);
  if (isAbsolute(text)) {
    let rel;
    try { rel = relative(repoRoot, realpathSync(text)); }
    catch { rel = relative(repoRoot, text); }
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return `repo:${normalizePortableRelativePath(rel === '' ? '.' : rel)}`;
    }
    return `host-path:${basename(text)}:${sha256(text)}`;
  }
  if (findAbsolutePath(text) !== null || /(^|[\s"'`(,;:=[{<])\/(?!\/)[^\s"'`<>]+/u.test(text)) {
    return `host-argument:${sha256(text)}`;
  }
  return text;
}

const MACHINE_PATH_TOKEN_RE = /(^|[\s"'`(,;:=[{<])((?:~[/\\]|[A-Za-z]:[/\\]|[/\\]{2}[A-Za-z0-9._-]+[/\\]|\/(?!\/))[^\s"'`<>]*)/gmu;

function portableEvidenceString(value, repoRoot) {
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) {
    return portableLaunchValue(value, repoRoot);
  }
  return value.split(/(https?:\/\/[^\s"'`<>]+)/giu).map((part) => {
    if (/^https?:\/\//iu.test(part)) return part;
    return part.replace(MACHINE_PATH_TOKEN_RE, (_match, prefix, token) => (
      `${prefix}<host-path:${sha256(token)}>`
    ));
  }).join('');
}

function portableEvidenceClone(value, repoRoot) {
  if (typeof value === 'string') return portableEvidenceString(value, repoRoot);
  if (Array.isArray(value)) return value.map((entry) => portableEvidenceClone(entry, repoRoot));
  if (value && typeof value === 'object') {
    const out = {};
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
    for (const [key, entry] of entries) {
      const portableKey = portableEvidenceString(key, repoRoot);
      let storedKey = portableKey === key ? key : `${portableKey}#key-${pathToken(key, 16)}`;
      if (Object.hasOwn(out, storedKey)) storedKey = `${storedKey}#collision-${pathToken(key, 32)}`;
      out[storedKey] = portableEvidenceClone(entry, repoRoot);
    }
    return out;
  }
  return value;
}

function validatePublicRunRoot(repoRoot, publicRunDir, job) {
  const publicRoot = resolveWithinRoot(repoRoot, PUBLIC_RUN_ROOT);
  const runRef = canonicalRef(job.run_id, 'job.run_id');
  const expected = resolveWithinRoot(publicRoot, runRef);
  let actualReal;
  try { actualReal = realpathSync(publicRunDir); }
  catch { invalid('artifact-root-mismatch', 'public run directory does not exist at the canonical run root'); }
  // Compare real identities, not the caller's spelling: macOS commonly exposes `/var` while
  // realpath returns `/private/var`. Containment was already checked from the real repo root.
  if (actualReal !== realpathSync(expected)) {
    invalid('artifact-root-mismatch', 'public run directory is not the canonical run root for this job');
  }
  return expected;
}

function validateBindingSnapshot(job, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    invalid('executor-binding-invalid', 'executor snapshot must be an object');
  }
  if (spec.enabled === false) invalid('executor-binding-invalid', 'approved executor is disabled in the frozen snapshot');
  if (executorSpecDigest(spec) !== job.binding.containment.digest) {
    invalid('executor-snapshot-drift', 'executor snapshot differs from the digest frozen by approval');
  }
  if (spec.sandbox !== job.binding.containment.profile) {
    invalid('executor-containment-drift', 'executor snapshot containment differs from the approved binding');
  }
  const mapped = spec.model_bindings?.[job.binding.model_ref];
  const mappedInvokeId = mapped?.invoke_id
    ?? (job.binding.effort === null ? null : mapped?.invoke_ids_by_effort?.[job.binding.effort]);
  if (typeof mappedInvokeId !== 'string') {
    invalid('executor-routing-drift', 'executor snapshot has no exact binding for the approved model reference and effort');
  }
  if (mappedInvokeId !== job.binding.invoke_id) {
    invalid('executor-routing-drift', 'executor snapshot maps the approved model reference to another invocation id');
  }
}

function validateApprovedAttempt(job, approvalValue, renderedPrompt, evidenceValue) {
  const approval = normalizeApprovalEnvelope(approvalValue);
  const approvalDigest = approvalEnvelopeDigest(approval);
  if (approval.run_id !== job.run_id) {
    invalid('approval-run-mismatch', 'durable job run_id differs from the approved envelope');
  }
  if (job.approval_digest !== approvalDigest || job.approved_framing_digest !== approvalDigest) {
    invalid('approval-framing-drift', 'durable job is not bound to the current approved envelope');
  }
  const seat = job.role === 'final-verifier' ? 'final_verifier' : job.role;
  if (canonicalJson(job.binding) !== canonicalJson(approval.routing[seat])) {
    invalid('approval-binding-drift', 'durable job binding differs from the approved role binding');
  }
  const node = approval.framing.node_scopes.find((candidate) => candidate.node_id === job.node_id);
  if (!node) invalid('approval-node-unknown', 'durable job node is absent from the approved envelope');
  if (job.source_ordinal !== node.source_ordinal
      || job.work_dir !== node.work_dir
      || canonicalJson(job.file_refs) !== canonicalJson(node.file_refs.map((entry) => entry.path))
      || canonicalJson(job.file_ref_identities) !== canonicalJson(node.file_refs)
      || canonicalJson(job.allowed_paths) !== canonicalJson(node.allowed_paths)) {
    invalid('approval-scope-drift', 'durable job scope differs from its approved node framing');
  }
  const approvedBudget = approval.budgets.stages[job.stage];
  if (job.budget.max_calls !== approvedBudget.max_calls
      || job.budget.max_elapsed_ms > approvedBudget.max_elapsed_ms
      || (approvedBudget.max_elapsed_ms_per_attempt !== undefined
        && job.budget.max_elapsed_ms > approvedBudget.max_elapsed_ms_per_attempt)) {
    invalid('approval-budget-drift', 'durable job budget differs from the approved stage budget');
  }
  if (job.approval_provenance.authorization_ref !== approval.approval_provenance.authorization_ref
      || job.approval_provenance.request_digest !== approval.approval_provenance.request_digest) {
    invalid('approval-provenance-drift', 'durable job provenance differs from the approved authorization');
  }
  const promptRecord = buildAttemptPromptRecord({
    approval,
    node_id: job.node_id,
    role: job.role,
    stage: job.stage,
    evidence: evidenceValue,
    rendered_prompt: renderedPrompt,
  });
  if (promptRecord.approval_digest !== approvalDigest
      || promptRecord.binding_digest !== executionBindingDigest(job.binding)
      || promptRecord.rendered_prompt_digest !== job.rendered_prompt_digest) {
    invalid('approval-prompt-drift', 'rendered attempt identity differs from the approved envelope');
  }
  return { approval, approvalDigest, evidence: promptRecord.evidence };
}

/** Canonical public/private references for one immutable attempt identity. */
export function canonicalAttemptRefs(value) {
  const job = normalizeDurableJob(value);
  const node = pathToken(job.node_id, 16);
  const attempt = pathToken(`${job.run_id}\0${job.node_id}\0${job.attempt_id}`, 32);
  const publicBase = `attempts/${node}/${job.role}/${attempt}`;
  const privateBase = `runs/${pathToken(job.run_id, 32)}/attempts/${attempt}`;
  return Object.freeze({
    public_intent_ref: `${publicBase}/intent.json`,
    public_result_ref: `${publicBase}/result.json`,
    private_request_ref: `${privateBase}/request.json`,
    private_worker_start_ref: `${privateBase}/worker-start.json`,
    private_worker_heartbeat_ref: `${privateBase}/worker-heartbeat.json`,
    private_launch_ack_ref: `${privateBase}/launch-acknowledgement.json`,
    private_launch_evidence_ref: `${privateBase}/launch-evidence.json`,
    private_raw_result_ref: `${privateBase}/raw-result.json`,
    private_transcript_ref: `${privateBase}/transcript.json`,
    private_settlement_ref: `${privateBase}/settlement.json`,
    private_terminal_receipt_ref: `${privateBase}/terminal-receipt.json`,
  });
}

/**
 * Persist the reservation and private launch request before any process is spawned.
 * This is preparation only; no executor or worker is launched here.
 */
export function prepareDurableAttempt(input) {
  const repoRoot = realpathSync(input.repoRoot);
  const job = normalizeDurableJob(input.job);
  const executorSpec = jsonClone(input.executorSpec, 'executorSpec');
  rejectPersistedProviderEnv(input.providerEnv);
  const outputSchema = input.outputSchema === undefined ? null : jsonClone(input.outputSchema, 'outputSchema');
  const timeoutMs = normalizedTimeout(input.timeoutMs, job);
  assertPortablePersistedValue(input.renderedPrompt, 'renderedPrompt');
  assertPortablePersistedValue(executorSpec, 'executorSpec');
  assertPortablePersistedValue(outputSchema, 'outputSchema');
  validateBindingSnapshot(job, executorSpec);
  const publicRunDir = validatePublicRunRoot(repoRoot, input.publicRunDir, job);
  const approvalRef = canonicalRef(input.approvalRef, 'approvalRef');
  if (approvalRef !== APPROVAL_ENVELOPE_REF) {
    invalid('approval-reference-invalid', `approvalRef must be ${APPROVAL_ENVELOPE_REF}`);
  }
  const approvalPath = resolveWithinRoot(publicRunDir, approvalRef);
  const approved = validateApprovedAttempt(
    job,
    readJson(approvalPath, 'approval envelope'),
    input.renderedPrompt,
    input.evidence ?? [],
  );
  const privateRoot = ensurePrivateRoot(repoRoot);
  const refs = canonicalAttemptRefs(job);
  const expectedPublicResultRef = canonicalRef(input.expectedPublicResultRef, 'expectedPublicResultRef');
  const expectedPrivateReceiptRef = canonicalRef(input.expectedPrivateReceiptRef, 'expectedPrivateReceiptRef');
  if (expectedPublicResultRef !== refs.public_result_ref) {
    invalid('artifact-root-mismatch', 'expected public result path differs from the canonical attempt path');
  }
  if (expectedPrivateReceiptRef !== refs.private_terminal_receipt_ref) {
    invalid('artifact-root-mismatch', 'expected private receipt path differs from the canonical attempt path');
  }
  if (job.public_result_ref !== null && job.public_result_ref !== refs.public_result_ref) {
    invalid('artifact-root-mismatch', 'job public_result_ref differs from the canonical attempt path');
  }

  ensureContainedDirectory(publicRunDir, dirname(refs.public_intent_ref));
  ensureContainedDirectory(privateRoot, dirname(refs.private_request_ref), { privateDirectory: true });

  const now = bangkokTimestamp(Date.now());
  const jobDigest = documentDigest(job);
  const reservation = normalizeLaunchReservation({
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'launch-reservation',
    driver: QUEUE_DRIVER_ID,
    reservation_id: opaqueId('reservation'),
    run_id: job.run_id,
    node_id: job.node_id,
    attempt_id: job.attempt_id,
    job_digest: jobDigest,
    expected_receipt_id: job.terminal_receipt_id ?? opaqueId('receipt'),
    reserved_at: now,
  });
  const privateRequestDigest = documentDigest({
    job,
    reservation,
    approval_ref: approvalRef,
    evidence: approved.evidence,
    rendered_prompt: input.renderedPrompt,
    executor_spec: executorSpec,
    output_schema: outputSchema,
    timeout_ms: timeoutMs,
    refs,
  });
  const intent = {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'durable-attempt-intent',
    driver: QUEUE_DRIVER_ID,
    job,
    job_digest: jobDigest,
    reservation,
    approval_ref: approvalRef,
    expected_public_result_ref: refs.public_result_ref,
    private_request_digest: privateRequestDigest,
  };
  const publicIntentPath = resolveWithinRoot(publicRunDir, refs.public_intent_ref, { mustExist: false });
  const publicResultPath = resolveWithinRoot(publicRunDir, refs.public_result_ref, { mustExist: false });
  const privateRequestPath = resolveWithinRoot(privateRoot, refs.private_request_ref, { mustExist: false });
  const privateWorkerStartPath = resolveWithinRoot(privateRoot, refs.private_worker_start_ref, { mustExist: false });
  const privateWorkerHeartbeatPath = resolveWithinRoot(privateRoot, refs.private_worker_heartbeat_ref, { mustExist: false });
  const privateLaunchAckPath = resolveWithinRoot(privateRoot, refs.private_launch_ack_ref, { mustExist: false });
  const privateLaunchEvidencePath = resolveWithinRoot(privateRoot, refs.private_launch_evidence_ref, { mustExist: false });
  const privateRawResultPath = resolveWithinRoot(privateRoot, refs.private_raw_result_ref, { mustExist: false });
  const privateTranscriptPath = resolveWithinRoot(privateRoot, refs.private_transcript_ref, { mustExist: false });
  const privateSettlementPath = resolveWithinRoot(privateRoot, refs.private_settlement_ref, { mustExist: false });
  const privateTerminalReceiptPath = resolveWithinRoot(privateRoot, refs.private_terminal_receipt_ref, { mustExist: false });

  const request = {
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'durable-attempt-worker-request',
    driver: QUEUE_DRIVER_ID,
    refs,
    intent_digest: documentDigest(intent),
    private_request_digest: privateRequestDigest,
    job,
    reservation,
    approval_ref: approvalRef,
    evidence: approved.evidence,
    rendered_prompt: input.renderedPrompt,
    executor_spec: executorSpec,
    output_schema: outputSchema,
    timeout_ms: timeoutMs,
  };
  writeJsonExclusive(publicIntentPath, intent);
  writeJsonExclusive(privateRequestPath, request, { privateFile: true });

  return Object.freeze({
    request_path: privateRequestPath,
    public_run_dir: publicRunDir,
    public_intent_path: publicIntentPath,
    approval_path: approvalPath,
    public_result_path: publicResultPath,
    private_request_path: privateRequestPath,
    private_worker_start_path: privateWorkerStartPath,
    private_worker_heartbeat_path: privateWorkerHeartbeatPath,
    private_launch_ack_path: privateLaunchAckPath,
    private_launch_evidence_path: privateLaunchEvidencePath,
    private_raw_result_path: privateRawResultPath,
    private_transcript_path: privateTranscriptPath,
    private_settlement_path: privateSettlementPath,
    private_terminal_receipt_path: privateTerminalReceiptPath,
    reservation,
    refs,
  });
}

function validateWorkerRequest(requestPath) {
  if (!isAbsolute(requestPath)) invalid('artifact-path-invalid', 'worker request path must be absolute at the process boundary');
  assertPrivatePermissions(requestPath);
  const repoRoot = repoRootFromRequestPath(requestPath);
  const privateRoot = resolveWithinRoot(repoRoot, PRIVATE_RECEIPT_ROOT);
  const request = readJson(requestPath, 'worker request');
  if (request.kind !== 'durable-attempt-worker-request' || request.driver !== QUEUE_DRIVER_ID
      || request.schema_version !== DURABLE_EXECUTION_SCHEMA_VERSION) {
    invalid('worker-request-invalid', 'request kind, driver, or schema version is unsupported');
  }
  const requestKeys = [
    'schema_version', 'kind', 'driver', 'refs', 'intent_digest', 'private_request_digest',
    'job', 'reservation', 'approval_ref', 'evidence', 'rendered_prompt',
    'executor_spec', 'output_schema', 'timeout_ms',
  ];
  const unknownRequestKey = Object.keys(request).find((key) => !requestKeys.includes(key));
  if (unknownRequestKey) invalid('worker-request-invalid', `unsupported request field ${unknownRequestKey}`);
  const job = normalizeDurableJob(request.job);
  const refs = canonicalAttemptRefs(job);
  if (canonicalJson(refs) !== canonicalJson(request.refs)) invalid('artifact-root-mismatch', 'worker request references are not canonical');
  const publicRunDir = resolveWithinRoot(resolveWithinRoot(repoRoot, PUBLIC_RUN_ROOT), canonicalRef(job.run_id, 'job.run_id'));
  validatePublicRunRoot(repoRoot, publicRunDir, job);
  const approvalRef = canonicalRef(request.approval_ref, 'request.approval_ref');
  if (approvalRef !== APPROVAL_ENVELOPE_REF) {
    invalid('approval-reference-invalid', `request approval_ref must be ${APPROVAL_ENVELOPE_REF}`);
  }
  const approvalPath = resolveWithinRoot(publicRunDir, approvalRef);
  const approved = validateApprovedAttempt(
    job,
    readJson(approvalPath, 'approval envelope'),
    request.rendered_prompt,
    request.evidence,
  );
  const paths = {};
  for (const [key, ref] of Object.entries({
    public_intent: refs.public_intent_ref,
    public_result: refs.public_result_ref,
  })) {
    paths[key] = resolveWithinRoot(publicRunDir, ref, { mustExist: key === 'public_intent' });
  }
  for (const [key, ref] of Object.entries({
    private_request: refs.private_request_ref,
    private_worker_start: refs.private_worker_start_ref,
    private_worker_heartbeat: refs.private_worker_heartbeat_ref,
    private_launch_ack: refs.private_launch_ack_ref,
    private_launch_evidence: refs.private_launch_evidence_ref,
    private_raw_result: refs.private_raw_result_ref,
    private_transcript: refs.private_transcript_ref,
    private_settlement: refs.private_settlement_ref,
    private_terminal_receipt: refs.private_terminal_receipt_ref,
  })) {
    paths[key] = resolveWithinRoot(privateRoot, ref, { mustExist: key === 'private_request' });
  }
  if (realpathSync(requestPath) !== realpathSync(paths.private_request)) {
    invalid('artifact-root-mismatch', 'worker request does not belong to its canonical private root');
  }
  assertPrivateDirectoryChain(repoRoot, privateRoot, requestPath);
  if (renderedPromptDigest(request.rendered_prompt) !== job.rendered_prompt_digest) {
    invalid('rendered-prompt-digest-mismatch', 'private rendered prompt no longer matches the approved digest');
  }
  const timeoutMs = normalizedTimeout(request.timeout_ms, job);
  assertPortablePersistedValue(request.rendered_prompt, 'renderedPrompt');
  assertPortablePersistedValue(request.executor_spec, 'executorSpec');
  assertPortablePersistedValue(request.output_schema, 'outputSchema');
  const intent = readJson(paths.public_intent, 'public attempt intent');
  if (documentDigest(intent) !== request.intent_digest) invalid('attempt-identity-changed', 'public attempt intent changed');
  const privateRequestDigest = documentDigest({
    job,
    reservation: request.reservation,
    approval_ref: approvalRef,
    evidence: approved.evidence,
    rendered_prompt: request.rendered_prompt,
    executor_spec: request.executor_spec,
    output_schema: request.output_schema,
    timeout_ms: timeoutMs,
    refs,
  });
  if (privateRequestDigest !== request.private_request_digest
      || privateRequestDigest !== intent.private_request_digest) {
    invalid('attempt-identity-changed', 'private worker request changed after reservation');
  }
  validateBindingSnapshot(job, request.executor_spec);
  return {
    ...request,
    job,
    refs,
    repoRoot,
    privateRoot,
    public_run_dir: publicRunDir,
    approval_ref: approvalRef,
    approval_path: approvalPath,
    evidence: approved.evidence,
    paths,
    intent,
    timeout_ms: timeoutMs,
  };
}

function verifyAttemptIdentity(request) {
  const current = readJson(request.paths.public_intent, 'public attempt intent');
  validateApprovedAttempt(
    request.job,
    readJson(request.approval_path, 'approval envelope'),
    request.rendered_prompt,
    request.evidence,
  );
  if (documentDigest(current) !== request.intent_digest
      || current.job?.attempt_id !== request.job.attempt_id
      || current.job?.idempotency_key !== request.job.idempotency_key
      || current.reservation?.expected_receipt_id !== request.reservation.expected_receipt_id
      || current.approval_ref !== request.approval_ref
      || current.expected_public_result_ref !== request.refs.public_result_ref
      || current.private_request_digest !== request.private_request_digest) {
    invalid('attempt-identity-changed', 'attempt identity or expected result path changed before settlement');
  }
}

function observeProcessStartToken(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const afterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
      // `/proc/<pid>/stat` field 22 is the kernel start tick. `afterCommand[0]` is field 3.
      const kernelStartTick = afterCommand[19];
      if (/^\d+$/u.test(kernelStartTick) && /^[0-9a-f-]{36}$/iu.test(bootId)) {
        return `start-${pathToken(`linux:${bootId}:${kernelStartTick}`, 40)}`;
      }
    } else if (process.platform === 'darwin') {
      return observeDarwinProcessStartToken(pid);
    } else if (process.platform === 'freebsd') {
      // `ps lstart` has only second resolution on this platform. Recording it as verified can
      // mistake rapid PID reuse for the same process, so remain explicitly unverified instead.
      return null;
    } else if (process.platform === 'win32') {
      const script = "$p=Get-Process -Id ([int]$env:SIDEKICKS_PROCESS_PID) -ErrorAction Stop; "
        + "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)";
      const result = spawnSync(windowsPowerShellPath(), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ], {
        encoding: 'utf8', windowsHide: true, shell: false,
        env: { ...process.env, SIDEKICKS_PROCESS_PID: String(pid) },
      });
      const observed = String(result.stdout ?? '').trim();
      if (result.status === 0 && /^\d+$/u.test(observed)) return `start-${pathToken(`win32:${observed}`, 40)}`;
    }
  } catch {
    // An unavailable observation is evidence of ambiguity, not permission to trust a PID.
  }
  return null;
}

function processIdentity(pid, prefix, sessionRef = opaqueId(`${prefix}-session`)) {
  if (!Number.isInteger(pid) || pid < 1) return { identity: null, verified: false };
  const startToken = observeProcessStartToken(pid);
  return {
    verified: startToken !== null,
    identity: {
      host_id: `host-${pathToken(hostname(), 32)}`,
      pid,
      start_token: startToken ?? opaqueId(`${prefix}-unverified`),
      session_ref: sessionRef,
      observed_state: 'live',
      observed_at: bangkokTimestamp(Date.now()),
    },
  };
}

/** Create private-only process ownership evidence for a non-provider execution claim. */
export function createPrivateExecutionClaim(prefix = 'execution-claim') {
  const observed = processIdentity(process.pid, prefix);
  return Object.freeze({
    claim_id: opaqueId('execution-claim'),
    owner: observed.identity,
    identity_state: observed.verified ? 'known' : 'unverified',
  });
}

/** Observe a private claim owner without signalling it or authorizing redispatch. */
export function observePrivateExecutionClaim(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)
      || typeof claim.claim_id !== 'string' || !/^execution-claim-[a-f0-9]{32}$/u.test(claim.claim_id)
      || !claim.owner || typeof claim.owner !== 'object'
      || !Number.isInteger(claim.owner.pid) || claim.owner.pid < 1
      || !['known', 'unverified'].includes(claim.identity_state)) {
    invalid('attempt-evidence-conflict', 'private execution claim owner is malformed');
  }
  const local = processIdentity(process.pid, 'execution-claim-host-observation');
  if (local.identity && claim.owner.host_id !== local.identity.host_id) {
    return Object.freeze({ liveness: 'unknown', identity: 'foreign-host' });
  }
  const liveness = processLiveness(claim.owner.pid);
  if (liveness !== 'live') return Object.freeze({ liveness, identity: 'unknown' });
  const observed = processIdentity(
    claim.owner.pid,
    'execution-claim-observation',
    claim.owner.session_ref,
  );
  return Object.freeze({
    liveness,
    identity: compareProcessIdentity(claim.owner, observed.identity),
  });
}

/** Observe a private worker/provider identity without signalling it. */
export function observePrivateProcessIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
      || typeof identity.host_id !== 'string' || identity.host_id === ''
      || !Number.isInteger(identity.pid) || identity.pid < 1
      || typeof identity.start_token !== 'string' || identity.start_token === ''
      || typeof identity.session_ref !== 'string' || identity.session_ref === '') {
    invalid('attempt-evidence-conflict', 'private process identity is malformed');
  }
  const local = processIdentity(process.pid, 'process-host-observation');
  if (local.identity && identity.host_id !== local.identity.host_id) {
    return Object.freeze({ liveness: 'unknown', identity: 'foreign-host' });
  }
  const liveness = processLiveness(identity.pid);
  if (liveness !== 'live') {
    return Object.freeze({
      liveness,
      identity: identity.start_token.includes('-unverified-') ? 'unverified' : 'verified',
    });
  }
  const current = processIdentity(identity.pid, 'process-observation', identity.session_ref);
  return Object.freeze({ liveness, identity: compareProcessIdentity(identity, current.identity) });
}

function processLiveness(pid) {
  if (!Number.isInteger(pid) || pid < 1) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    // EPERM means that an incarnation exists but cannot be inspected. Every other platform error
    // is ambiguity, never evidence that the recorded worker died.
    if (error?.code === 'EPERM') return 'live';
    return 'unknown';
  }
}

/** Compare independently observed incarnations; PID equality alone never verifies identity. */
export function compareProcessIdentity(expected, observed) {
  if (!expected || !observed) return 'unverified';
  if (expected.start_token?.includes('-unverified-') || observed.start_token?.includes('-unverified-')) {
    return 'unverified';
  }
  if (expected.host_id !== observed.host_id) return 'foreign-host';
  if (expected.pid !== observed.pid) return 'different-pid';
  if (expected.start_token !== observed.start_token) return 'pid-reused';
  return 'verified';
}

function cleanupClass(value) {
  if (value === 'verified') return 'complete';
  if (value === 'not-started' || value === 'not-required') return 'not-required';
  if (value === 'failed' || value === 'incomplete') return 'incomplete';
  return 'unknown';
}

/** Closed terminal classification used by every role. */
export function classifyInvocationTerminal(value = {}) {
  let classification;
  if (value.cancelled === true) classification = 'cancelled';
  else if (value.timed_out === true) classification = 'timeout';
  else if (value.failure_kind === 'acknowledgement' || value.failure_kind === 'unknown-termination') classification = 'unknown';
  else if (['permission-denied', 'policy-refusal', 'refusal'].includes(value.failure_kind)) classification = 'policy-refusal';
  else if (value.parse_error || ['invalid-output', 'parse', 'parse-schema'].includes(value.failure_kind)) classification = 'parse-failure';
  else if (['launch', 'unavailable', 'spawn'].includes(value.failure_kind)) classification = 'launch-failure';
  else if (Number.isInteger(value.exit_code) && value.exit_code !== 0) classification = 'nonzero-exit';
  else if (value.ok === true && value.exit_code === 0) classification = 'success';
  else classification = 'unknown';
  const cleanup = cleanupClass(value.cleanup_status);
  if (classification === 'success' && cleanup === 'unknown') classification = 'unknown';
  const replaySafe = classification === 'launch-failure' && cleanup === 'not-required' && value.possible_writes !== true;
  return Object.freeze({ classification, cleanup, replay_safe: replaySafe });
}

/**
 * Recovery observation matrix. PID alone never authorizes a signal or duplicate dispatch.
 * A later supervisor may wait for a verified live worker, but ambiguity always parks.
 */
export function classifyAttemptObservation(observation = {}) {
  if (observation.worker === 'live' && observation.provider === 'live' && observation.identity === 'verified') {
    return Object.freeze({ state: 'running', action: 'wait', may_kill: false, may_redispatch: false });
  }
  if (observation.worker === 'live' && observation.provider === 'dead' && observation.identity === 'verified') {
    return Object.freeze({ state: 'running', action: 'worker-classifies-terminal', may_kill: false, may_redispatch: false });
  }
  return Object.freeze({ state: 'parked', action: 'park-unknown', may_kill: false, may_redispatch: false });
}

function outcomeFor(classification) {
  if (classification === 'success') return 'needs-review';
  if (classification === 'unknown' || classification === 'cancelled' || classification === 'timeout') return 'parked';
  return 'failed';
}

function safeChangedPaths(job, invocation) {
  const candidates = Array.isArray(invocation?.result?.changed_paths) ? invocation.result.changed_paths : [];
  const allowed = job.allowed_paths;
  const safe = [];
  for (const candidate of candidates) {
    let normalized;
    try { normalized = canonicalRef(candidate, 'changed_path'); }
    catch { continue; }
    if (allowed.some((root) => normalized === root || normalized.startsWith(`${root}/`))) safe.push(normalized);
  }
  return [...new Set(safe)].sort();
}

function diagnosticFor(classification, special) {
  if (special) return [special];
  return ({
    success: [],
    'nonzero-exit': ['executor-nonzero-exit'],
    'launch-failure': ['executor-launch-failure'],
    timeout: ['executor-timeout-cleanup-required'],
    'parse-failure': ['executor-output-invalid'],
    'policy-refusal': ['executor-permission-refusal'],
    cancelled: ['attempt-stop-observed'],
    unknown: ['provider-activity-unknown'],
  })[classification];
}

function summaryFor(classification) {
  return ({
    success: 'Executor output was captured and awaits independent review.',
    'nonzero-exit': 'Executor exited non-zero; private evidence contains the diagnostic payload.',
    'launch-failure': 'Executor launch failed before a confirmed provider session.',
    timeout: 'Executor timed out; possible effects require inspection before any retry.',
    'parse-failure': 'Executor output failed parsing or schema validation.',
    'policy-refusal': 'Executor refused the attempt at a permission or policy boundary.',
    cancelled: 'The attempt was cancelled after STOP was observed.',
    unknown: 'Provider activity is ambiguous; the attempt is parked without kill or duplicate dispatch.',
  })[classification];
}

const SPECIAL_DIAGNOSTICS = new Set([
  'attempt-identity-changed',
  'invocation-binding-mismatch',
  'launch-acknowledgement-unpersisted',
  'process-incarnation-unobservable',
  'provider-launch-unacknowledged',
  'worker-incarnation-replaced-before-settlement',
  'worker-termination-before-settlement',
]);

function publicResultFor(request, rawResult, terminalReceipt, specialDiagnostic) {
  if (specialDiagnostic !== null && !SPECIAL_DIAGNOSTICS.has(specialDiagnostic)) {
    invalid('attempt-evidence-conflict', 'settlement carries an unsupported diagnostic');
  }
  return normalizePublicResult({
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'public-attempt-result',
    driver: QUEUE_DRIVER_ID,
    receipt_id: terminalReceipt.receipt_id,
    run_id: terminalReceipt.run_id,
    node_id: terminalReceipt.node_id,
    attempt_id: terminalReceipt.attempt_id,
    role: request.job.role,
    classification: terminalReceipt.classification,
    outcome: outcomeFor(terminalReceipt.classification),
    summary: summaryFor(terminalReceipt.classification),
    approval_digest: terminalReceipt.approval_digest,
    rendered_prompt_digest: terminalReceipt.rendered_prompt_digest,
    evidence_digest: terminalReceipt.result_digest,
    changed_paths: terminalReceipt.classification === 'success'
      ? safeChangedPaths(request.job, rawResult) : [],
    diagnostics: diagnosticFor(terminalReceipt.classification, specialDiagnostic),
    completed_at: terminalReceipt.terminal_at,
  });
}

function makeSettlement(request, invocation, classification, process, specialDiagnostic = null) {
  const rawResult = invocation === null ? null : portableEvidenceClone(invocation, request.repoRoot);
  assertPortablePersistedValue(rawResult, 'rawResult');
  const rawText = jsonText(rawResult);
  const evidenceDigest = sha256(rawText);
  const transcript = rawResult === null ? null : {
    stdout: rawResult.stdout ?? '',
    stderr: rawResult.stderr ?? '',
    result_text: rawResult.result_text ?? null,
  };
  const transcriptDigest = transcript === null ? null : sha256(jsonText(transcript));
  const completedAt = bangkokTimestamp(Date.now());
  const terminalReceipt = normalizeTerminalReceipt({
    schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
    kind: 'terminal-receipt',
    driver: QUEUE_DRIVER_ID,
    receipt_id: request.reservation.expected_receipt_id,
    run_id: request.job.run_id,
    node_id: request.job.node_id,
    attempt_id: request.job.attempt_id,
    reservation_id: request.reservation.reservation_id,
    job_digest: request.reservation.job_digest,
    approval_digest: request.job.approval_digest,
    binding_digest: executionBindingDigest(request.job.binding),
    rendered_prompt_digest: request.job.rendered_prompt_digest,
    classification: classification.classification,
    exit_code: Number.isInteger(invocation?.exit_code) && invocation.exit_code >= 0 ? invocation.exit_code : null,
    cleanup: classification.cleanup,
    result_digest: evidenceDigest,
    raw_result_ref: invocation === null ? null : request.refs.private_raw_result_ref,
    transcript_ref: invocation === null ? null : request.refs.private_transcript_ref,
    process,
    terminal_at: completedAt,
  });
  const publicResult = publicResultFor(request, rawResult, terminalReceipt, specialDiagnostic);
  return {
    rawResult,
    rawResultDigest: evidenceDigest,
    transcript,
    transcriptDigest,
    specialDiagnostic,
    terminalReceipt,
    publicResult,
  };
}

function settlementBundle(request, settlement) {
  return {
    private_request_digest: request.private_request_digest,
    worker_claim_id: settlement.workerClaimId,
    raw_result: settlement.rawResult,
    raw_result_digest: settlement.rawResultDigest,
    transcript: settlement.transcript,
    transcript_digest: settlement.transcriptDigest,
    special_diagnostic: settlement.specialDiagnostic,
    terminal_receipt: settlement.terminalReceipt,
    public_result: settlement.publicResult,
  };
}

function assertSameDocument(actual, expected, label) {
  if (documentDigest(actual) !== documentDigest(expected)) {
    invalid('attempt-evidence-conflict', `${label} diverges from the authoritative settlement bundle`);
  }
}

function validateSettlementBundle(request, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('attempt-evidence-conflict', 'private settlement bundle must be an object');
  }
  const keys = [
    'private_request_digest', 'worker_claim_id', 'raw_result', 'raw_result_digest', 'transcript',
    'transcript_digest', 'special_diagnostic', 'terminal_receipt', 'public_result',
  ];
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    invalid('attempt-evidence-conflict', 'private settlement bundle has unsupported or missing fields');
  }
  if (value.private_request_digest !== request.private_request_digest) {
    invalid('attempt-evidence-conflict', 'private settlement belongs to another invocation envelope');
  }
  const workerClaim = readWorkerClaim(request);
  if (value.worker_claim_id !== workerClaim.claim_id) {
    invalid('attempt-evidence-conflict', 'private settlement is not fenced by the current worker claim');
  }
  const terminalReceipt = normalizeTerminalReceipt(value.terminal_receipt);
  const publicResult = normalizePublicResult(value.public_result);
  const expectedBindingDigest = executionBindingDigest(request.job.binding);
  if (terminalReceipt.receipt_id !== request.reservation.expected_receipt_id
      || terminalReceipt.run_id !== request.job.run_id
      || terminalReceipt.node_id !== request.job.node_id
      || terminalReceipt.attempt_id !== request.job.attempt_id
      || terminalReceipt.reservation_id !== request.reservation.reservation_id
      || terminalReceipt.job_digest !== request.reservation.job_digest
      || terminalReceipt.approval_digest !== request.job.approval_digest
      || terminalReceipt.binding_digest !== expectedBindingDigest
      || terminalReceipt.rendered_prompt_digest !== request.job.rendered_prompt_digest) {
    invalid('attempt-evidence-conflict', 'terminal receipt belongs to another attempt identity');
  }
  if (terminalReceipt.result_digest !== value.raw_result_digest
      || sha256(jsonText(value.raw_result)) !== value.raw_result_digest) {
    invalid('attempt-evidence-conflict', 'raw result digest does not match the settlement bundle');
  }
  const hasRaw = value.raw_result !== null;
  if ((terminalReceipt.raw_result_ref !== null) !== hasRaw
      || (terminalReceipt.transcript_ref !== null) !== hasRaw
      || (hasRaw && (terminalReceipt.raw_result_ref !== request.refs.private_raw_result_ref
        || terminalReceipt.transcript_ref !== request.refs.private_transcript_ref))) {
    invalid('attempt-evidence-conflict', 'terminal private evidence references do not match the canonical attempt paths');
  }
  if (hasRaw) {
    if (value.transcript === null || value.transcript_digest !== sha256(jsonText(value.transcript))) {
      invalid('attempt-evidence-conflict', 'transcript digest does not match the settlement bundle');
    }
  } else if (value.transcript !== null || value.transcript_digest !== null) {
    invalid('attempt-evidence-conflict', 'an empty raw result cannot carry transcript evidence');
  }
  if (publicResult.receipt_id !== terminalReceipt.receipt_id
      || publicResult.run_id !== terminalReceipt.run_id
      || publicResult.node_id !== terminalReceipt.node_id
      || publicResult.attempt_id !== terminalReceipt.attempt_id
      || publicResult.role !== request.job.role
      || publicResult.classification !== terminalReceipt.classification
      || publicResult.approval_digest !== terminalReceipt.approval_digest
      || publicResult.rendered_prompt_digest !== terminalReceipt.rendered_prompt_digest
      || publicResult.evidence_digest !== terminalReceipt.result_digest
      || publicResult.completed_at !== terminalReceipt.terminal_at) {
    invalid('attempt-evidence-conflict', 'public result does not project the terminal receipt identity');
  }
  const expectedPublicResult = publicResultFor(
    request,
    value.raw_result,
    terminalReceipt,
    value.special_diagnostic,
  );
  assertSameDocument(publicResult, expectedPublicResult, 'public result');
  return {
    workerClaimId: value.worker_claim_id,
    rawResult: value.raw_result,
    rawResultDigest: value.raw_result_digest,
    transcript: value.transcript,
    transcriptDigest: value.transcript_digest,
    specialDiagnostic: value.special_diagnostic,
    terminalReceipt,
    publicResult,
  };
}

function materializeOrVerify(path, value, { privateFile = false, label }) {
  if (existsSync(path)) {
    if (privateFile) assertPrivatePermissions(path);
    assertSameDocument(readJson(path, label), value, label);
    return false;
  }
  writeJsonExclusive(path, value, { privateFile });
  return true;
}

function completeSettlementPublication(request, settlement, dependencies = {}) {
  const afterPublication = dependencies.afterPublication ?? (() => {});
  if (settlement.rawResult !== null) {
    materializeOrVerify(request.paths.private_raw_result, settlement.rawResult, {
      privateFile: true, label: 'private raw result',
    });
    afterPublication('raw-result');
    materializeOrVerify(request.paths.private_transcript, settlement.transcript, {
      privateFile: true, label: 'private transcript',
    });
    afterPublication('transcript');
  }
  materializeOrVerify(request.paths.private_terminal_receipt, settlement.terminalReceipt, {
    privateFile: true, label: 'terminal receipt',
  });
  afterPublication('terminal-receipt');
  materializeOrVerify(request.paths.public_result, settlement.publicResult, {
    label: 'public attempt result',
  });
  afterPublication('public-result');
}

function persistSettlement(request, settlement, dependencies = {}, workerClaimId) {
  assertWorkerClaimOwner(request, workerClaimId);
  settlement.workerClaimId = workerClaimId;
  ensureContainedDirectory(request.privateRoot, dirname(request.refs.private_terminal_receipt_ref), { privateDirectory: true });
  ensureContainedDirectory(request.public_run_dir, dirname(request.refs.public_result_ref));
  writeJsonExclusive(request.paths.private_settlement, settlementBundle(request, settlement), { privateFile: true });
  (dependencies.afterPublication ?? (() => {}))('settlement');
  completeSettlementPublication(request, settlement, dependencies);
  return {
    replayed: false,
    terminal_receipt: settlement.terminalReceipt,
    public_result: settlement.publicResult,
  };
}

function replaySettlement(request) {
  if (!existsSync(request.paths.private_settlement)) {
    if (existsSync(request.paths.private_terminal_receipt) || existsSync(request.paths.public_result)) {
      invalid('attempt-evidence-conflict', 'derived settlement evidence exists without its authoritative private bundle');
    }
    return null;
  }
  assertPrivatePermissions(request.paths.private_settlement);
  const settlement = validateSettlementBundle(
    request,
    readJson(request.paths.private_settlement, 'private settlement bundle'),
  );
  completeSettlementPublication(request, settlement);
  return {
    replayed: true,
    terminal_receipt: settlement.terminalReceipt,
    public_result: settlement.publicResult,
  };
}

function readWorkerClaim(request) {
  assertPrivatePermissions(request.paths.private_worker_start);
  const claim = readJson(request.paths.private_worker_start, 'worker claim');
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)
      || typeof claim.claim_id !== 'string' || !/^worker-claim-[a-f0-9]{32}$/u.test(claim.claim_id)
      || claim.reservation_id !== request.reservation.reservation_id
      || !['known', 'unverified'].includes(claim.identity_state)
      || !claim.worker || typeof claim.worker !== 'object'
      || !Number.isInteger(claim.worker.pid) || claim.worker.pid < 1) {
    invalid('attempt-evidence-conflict', 'worker claim is malformed or belongs to another reservation');
  }
  return claim;
}

function assertWorkerClaimOwner(request, claimId) {
  const claim = readWorkerClaim(request);
  if (claim.claim_id !== claimId) {
    invalid('attempt-evidence-conflict', 'worker claim ownership changed before dispatch or settlement');
  }
  return claim;
}

function incumbentResult(state, action, identity) {
  return {
    replayed: false,
    incumbent: true,
    state,
    action,
    identity,
    terminal_receipt: null,
    public_result: null,
  };
}

function observeIncumbentWorker(request, dependencies) {
  const claim = readWorkerClaim(request);
  const liveness = processLiveness(claim.worker.pid);
  if (liveness === 'unknown') {
    return incumbentResult('parked', 'wait-unverifiable-incumbent', 'unverified');
  }
  if (liveness === 'live') {
    const observed = processIdentity(claim.worker.pid, 'worker-observation', claim.worker.session_ref);
    const identity = compareProcessIdentity(claim.worker, observed.identity);
    if (identity === 'verified') return incumbentResult('running', 'wait', identity);
    if (identity === 'unverified') {
      return incumbentResult('parked', 'wait-unverifiable-incumbent', identity);
    }
    const unknown = makeSettlement(request, null, {
      classification: 'unknown', cleanup: 'unknown', replay_safe: false,
    }, null, 'worker-incarnation-replaced-before-settlement');
    return persistSettlement(request, unknown, dependencies, claim.claim_id);
  }
  const unknown = makeSettlement(request, null, {
    classification: 'unknown', cleanup: 'unknown', replay_safe: false,
  }, null, 'worker-termination-before-settlement');
  return persistSettlement(request, unknown, dependencies, claim.claim_id);
}

function invocationBindingMatches(job, result) {
  return result?.executor === job.binding.executor
    && result?.role === job.binding.role
    && result?.invoke_id === job.binding.invoke_id
    && result?.effort === job.binding.effort
    && (result?.model_ref === null || result?.model_ref === undefined || result.model_ref === job.binding.model_ref);
}

/**
 * Reconcile a prepared attempt without ever claiming or dispatching it in the caller process.
 * The lifecycle driver uses this after a detached launch so a failed worker start cannot silently
 * fall back to an inline provider invocation.
 */
export function reconcilePreparedAttempt(requestPath, dependencies = {}) {
  const request = validateWorkerRequest(requestPath);
  const replay = replaySettlement(request);
  if (replay) return replay;
  if (!existsSync(request.paths.private_worker_start)) {
    return {
      replayed: false,
      incumbent: false,
      unclaimed: true,
      state: 'unknown',
      action: 'park-unclaimed-worker',
      identity: 'unknown',
      terminal_receipt: null,
      public_result: null,
    };
  }
  return observeIncumbentWorker(request, dependencies);
}

/** Run exactly one prepared attempt and settle it. No queue transition occurs here. */
export async function runPreparedAttempt(requestPath, dependencies = {}) {
  const request = validateWorkerRequest(requestPath);
  const replay = replaySettlement(request);
  if (replay) return replay;

  const workerProcess = processIdentity(process.pid, 'worker');
  const workerClaimId = opaqueId('worker-claim');
  const claimed = writeJsonExclusive(request.paths.private_worker_start, {
    claim_id: workerClaimId,
    worker: workerProcess.identity,
    identity_state: workerProcess.verified ? 'known' : 'unverified',
    reservation_id: request.reservation.reservation_id,
    started_at: bangkokTimestamp(Date.now()),
  }, { privateFile: true, observeConflict: true });
  if (!claimed) return observeIncumbentWorker(request, dependencies);

  if (existsSync(join(request.public_run_dir, 'STOP'))) {
    const cancelled = makeSettlement(request, null, {
      classification: 'cancelled', cleanup: 'not-required', replay_safe: false,
    }, null);
    return persistSettlement(request, cancelled, dependencies, workerClaimId);
  }

  let acknowledgement = null;
  let acknowledgementError = null;
  let heartbeatTimer = null;
  let heartbeatError = null;
  const heartbeat = (provider) => {
    try {
      writePrivateExecutionRecord(request.repoRoot, request.refs.private_worker_heartbeat_ref, {
        schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
        kind: 'durable-worker-heartbeat',
        driver: QUEUE_DRIVER_ID,
        run_id: request.job.run_id,
        attempt_id: request.job.attempt_id,
        reservation_id: request.reservation.reservation_id,
        worker_claim_id: workerClaimId,
        worker: workerProcess.identity,
        provider,
        observed_at: bangkokTimestamp(Date.now()),
      });
    } catch (error) {
      heartbeatError = error instanceof Error ? error : new Error(String(error));
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      throw heartbeatError;
    }
  };
  const persistAcknowledgement = dependencies.persistAcknowledgement ?? ((path, value) => {
    writeJsonExclusive(path, value, { privateFile: true });
  });
  const onSpawn = (launch) => {
    const providerProcess = processIdentity(launch.pid, 'provider');
    writeJsonExclusive(request.paths.private_launch_evidence, {
      worker_pid: process.pid,
      provider_pid: launch.pid,
      provider_identity_state: providerProcess.verified ? 'known' : 'unknown',
      binary: portableLaunchValue(launch.bin, request.repoRoot),
      arguments: launch.args.map((entry) => portableLaunchValue(entry, request.repoRoot)),
      arguments_digest: sha256(canonicalJson(launch.args)),
      observed_at: bangkokTimestamp(Date.now()),
    }, { privateFile: true });
    try {
      if (!Number.isInteger(launch.pid) || launch.pid < 1) throw new Error('provider pid is unavailable');
      heartbeat(providerProcess.identity);
      heartbeatTimer = setInterval(() => {
        try { heartbeat(providerProcess.identity); } catch { /* classified after invocation */ }
      }, 1000);
      heartbeatTimer.unref?.();
      const candidate = normalizeLaunchAcknowledgement({
        schema_version: DURABLE_EXECUTION_SCHEMA_VERSION,
        kind: 'launch-acknowledgement',
        driver: QUEUE_DRIVER_ID,
        reservation_id: request.reservation.reservation_id,
        run_id: request.job.run_id,
        attempt_id: request.job.attempt_id,
        state: 'acknowledged',
        process: {
          worker: workerProcess.identity,
          provider_state: providerProcess.verified ? 'known' : 'unknown',
          provider: providerProcess.verified ? providerProcess.identity : null,
        },
        acknowledged_at: bangkokTimestamp(Date.now()),
      });
      persistAcknowledgement(request.paths.private_launch_ack, candidate);
      if (!existsSync(request.paths.private_launch_ack)) {
        throw new Error('acknowledgement writer returned without publishing evidence');
      }
      assertPrivatePermissions(request.paths.private_launch_ack);
      acknowledgement = normalizeLaunchAcknowledgement(readJson(request.paths.private_launch_ack, 'launch acknowledgement'));
    } catch (error) {
      acknowledgementError = error instanceof Error ? error : new Error(String(error));
      throw acknowledgementError;
    }
  };

  const invoke = dependencies.invokeExecutor ?? invokeExecutorReal;
  let invocation;
  const invocationStartedAt = Date.now();
  try {
    assertWorkerClaimOwner(request, workerClaimId);
    const workDir = resolveWithinRoot(request.repoRoot, request.job.work_dir);
    if (['implementation', 'repair'].includes(request.job.stage)) {
      assertWritableBranches(request.repoRoot, request.job.allowed_paths);
    }
    invocation = await invoke({
      name: request.job.binding.executor,
      spec: request.executor_spec,
      role: request.job.binding.role,
      model: request.job.binding.model_ref,
      invokeId: request.job.binding.invoke_id,
      effort: request.job.binding.effort,
      prompt: request.rendered_prompt,
      cwd: workDir,
      timeoutMs: request.timeout_ms,
      ...(request.output_schema === null ? {} : { schemaJson: JSON.stringify(request.output_schema) }),
      onSpawn,
      approvedContainment: request.job.binding.containment,
      approvedBinding: request.job.binding,
      approvedExecutorSpecDigest: request.job.binding.containment.digest,
      bindingDigest: executionBindingDigest(request.job.binding),
    });
  } catch (error) {
    if (acknowledgementError !== null || acknowledgement !== null) {
      invocation = {
        ok: false,
        exit_code: null,
        cleanup_status: 'unknown',
        failure_kind: 'acknowledgement',
        error: 'launch acknowledgement boundary failed',
        duration_ms: Math.max(0, Date.now() - invocationStartedAt),
      };
    } else {
      const message = String(error?.message ?? error);
      invocation = {
        ok: false,
        exit_code: null,
        cleanup_status: 'not-started',
        failure_kind: /schema|parse/i.test(message) ? 'parse-schema'
          : /permission|refus|denied|policy/i.test(message) ? 'permission-denied' : 'launch',
        error: message,
        duration_ms: Math.max(0, Date.now() - invocationStartedAt),
      };
    }
  } finally {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  }

  let specialDiagnostic = null;
  let classified = classifyInvocationTerminal(invocation);
  if (heartbeatError !== null) {
    classified = { classification: 'unknown', cleanup: 'unknown', replay_safe: false };
    specialDiagnostic = 'worker-heartbeat-unpersisted';
  } else if (acknowledgementError !== null || (invocation?.failure_kind === 'acknowledgement' && acknowledgement === null)) {
    classified = { classification: 'unknown', cleanup: 'unknown', replay_safe: false };
    specialDiagnostic = 'launch-acknowledgement-unpersisted';
  } else if (acknowledgement?.state !== 'acknowledged'
      && classified.classification !== 'launch-failure'
      && classified.classification !== 'parse-failure'
      && classified.classification !== 'policy-refusal') {
    classified = { classification: 'unknown', cleanup: 'unknown', replay_safe: false };
    specialDiagnostic = 'process-incarnation-unobservable';
  } else if (acknowledgement === null && classified.classification !== 'launch-failure'
      && classified.classification !== 'parse-failure' && classified.classification !== 'policy-refusal') {
    classified = { classification: 'unknown', cleanup: 'unknown', replay_safe: false };
    specialDiagnostic = 'provider-launch-unacknowledged';
  } else if (acknowledgement !== null && !invocationBindingMatches(request.job, invocation)) {
    classified = { classification: 'unknown', cleanup: 'unknown', replay_safe: false };
    specialDiagnostic = 'invocation-binding-mismatch';
  }

  try {
    verifyAttemptIdentity(request);
  } catch (error) {
    classified = { classification: 'unknown', cleanup: 'unknown', replay_safe: false };
    specialDiagnostic = 'attempt-identity-changed';
  }
  const processEvidence = acknowledgement?.process ?? null;
  return persistSettlement(request, makeSettlement(
    request,
    invocation,
    classified,
    processEvidence,
    specialDiagnostic,
  ), dependencies, workerClaimId);
}

/** Launch the durable Node worker and return after the worker process itself is accepted by the OS. */
export async function launchPreparedAttempt(requestPath) {
  validateWorkerRequest(requestPath);
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(process.execPath, [WORKER_FILENAME, '--request', requestPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    child.once('error', rejectLaunch);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch({ launched: true, pid: child.pid });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(WORKER_FILENAME) && process.argv[2] === '--request') {
  runPreparedAttempt(process.argv[3]).then(
    () => { process.exitCode = 0; },
    () => { process.exitCode = 1; },
  );
}
