// Explicit legacy inspection and single-owner migration for queue-supervisor/v1.
//
// Dry-run is read-only. Apply binds a fresh authorization to the exact canonical proposal,
// prepares the new run while it is still inactive, then commits one immutable ownership record in
// the legacy source directory. Both supported legacy writers and the new driver consult that same
// record, so the atomic record creation is the only ownership transition.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { parse as parseYaml } from '../yaml-subset/yaml.mjs';
import { canonicalJson } from '../run-events/schema.mjs';
import { acquireLock, releaseLock } from '../run-events/store.mjs';
import { EXIT_IO, EXIT_USAGE, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import {
  normalizePortableRelativePath,
  resolveWithinRoot,
} from '../durable-execution/paths.mjs';
import {
  QUEUE_DRIVER_ID,
  approvalEnvelopeDigest,
  assertPublicDocument,
  normalizeApprovalEnvelope,
} from '../durable-execution/schema.mjs';
import { initializeFencedRun, readFencedRun } from '../durable-execution/store.mjs';
import { createInitialQueueState } from './driver.mjs';

const SOURCE_FILE = 'migration-source.json';
const OWNERSHIP_FILE = 'migration-ownership.json';
const MIGRATION_RECEIPT_FILE = 'migration-receipt.json';
const SOURCE_REFERENCE_FILE = 'migration-source-reference.json';
const APPROVAL_FILE = 'approval-envelope.json';
const LOCK_DIR = '.migration-mutation.lock';
const ARCHIVE_DIR = '.legacy-migration-archive';
const SUPPORTED_LEGACY_VERSIONS = new Set([0, 1]);
const SUPPORTED_LEGACY_DRIVERS = new Set(['cli-orchestrator/python-v1']);
const SUPPORTED_LEGACY_STATES = new Set([
  'resolving', 'gating', 'awaiting-run-approval', 'executing', 'done', 'stopped', 'failed',
]);
const MIGRATABLE_LEGACY_STATES = new Set(['resolving', 'gating', 'awaiting-run-approval']);
const SUPPORTED_MAPPING_RESULTS = new Set([
  'preserved',
  'preserved-as-history',
  'requires-new-approval',
  'requires-fresh-verification',
  'never-transferred',
]);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const LEGACY_LEDGER_FIELDS = new Set([
  'schema_version', 'run_slug', 'mode', 'status', 'created_at', 'updated_at',
  'work_dir', 'docs_dir', 'artifacts_dir', 'work_item', 'guardrails', 'counters',
  'gate', 'exit_check', 'items', 'steps', 'preset', 'preview', 'held_action_grants',
]);
const LEGACY_ITEM_FIELDS = new Set([
  'id', 'goal', 'executor', 'execution_transport', 'acceptance_criteria', 'work_dir',
  'model_tier', 'model', 'effort', 'binding', 'file_refs', 'routing_fallbacks',
  'state', 'attempts', 'verdict', 'verified', 'parked_reason', 'block_reason',
  'digest_ref', 'transcript_ref', 'started_at', 'ended_at',
]);

function invalid(code, message, exitCode = EXIT_VALIDATION) {
  throw new SidekicksError(`[${code}] ${message}`, exitCode);
}

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestDocument(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'));
}


function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { invalid('migration-source-invalid', `${label} is unreadable: ${error.message}`, EXIT_USAGE); }
}

function closed(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('migration-source-invalid', `${label} must be an object`, EXIT_USAGE);
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid('migration-field-unsupported', `${label}.${key} is unsupported`, EXIT_USAGE);
  }
  return value;
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function repoRelative(repoRoot, absolute) {
  const rel = relative(repoRoot, absolute);
  if (!within(repoRoot, absolute)) invalid('migration-path-escape', `${absolute} is outside the repository`);
  return rel.split(sep).join('/');
}

function publicRunsRoot(repoRoot) {
  const lexical = resolve(repoRoot, 'artifacts', 'runs');
  let actual;
  try { actual = realpathSync(lexical); }
  catch (error) { invalid('migration-path-escape', `artifacts/runs cannot be resolved: ${error.message}`); }
  const sameAnchor = process.platform === 'win32'
    ? actual.toLocaleLowerCase('en-US') === lexical.toLocaleLowerCase('en-US')
    : actual === lexical;
  if (!sameAnchor) {
    invalid('migration-path-escape', 'artifacts/runs and its ancestors must not redirect the public run root');
  }
  return actual;
}

function sourceRoot(repoRootValue, sourceDirValue) {
  const repoRoot = realpathSync(repoRootValue);
  const sourceDir = realpathSync(sourceDirValue);
  const publicRoot = publicRunsRoot(repoRoot);
  if (!within(publicRoot, sourceDir)) invalid('migration-path-escape', 'legacy source must be below artifacts/runs');
  return { repoRoot, sourceDir };
}

function ensureContainedDirectory(root, portablePath, mode = 0o700) {
  const normalized = normalizePortableRelativePath(portablePath);
  const realRoot = realpathSync(root);
  let current = realRoot;
  if (normalized === '.') return current;
  for (const segment of normalized.split('/')) {
    const next = join(current, segment);
    if (!existsSync(next)) mkdirSync(next, { recursive: false, mode });
    const stat = lstatSync(next);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      invalid('migration-path-escape', `${portablePath} crosses a non-directory or filesystem link`);
    }
    const actual = realpathSync(next);
    if (!within(realRoot, actual)) invalid('migration-path-escape', `${portablePath} escapes the public run root`);
    current = actual;
  }
  return current;
}

function evidenceRows(sourceDir, evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    invalid('migration-source-invalid', 'source evidence must be a non-empty array', EXIT_USAGE);
  }
  const seen = new Set();
  const diagnostics = [];
  const rows = evidence.map((row, index) => {
    closed(row, `evidence[${index}]`, ['path', 'class', 'digest']);
    const portable = normalizePortableRelativePath(row.path, { allowRoot: false });
    if (typeof row.class !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(row.class)) {
      invalid('migration-source-invalid', `evidence[${index}].class must be a portable evidence class`, EXIT_USAGE);
    }
    if (seen.has(portable)) invalid('migration-source-invalid', `duplicate evidence path ${portable}`, EXIT_USAGE);
    seen.add(portable);
    if (!DIGEST_RE.test(row.digest)) {
      invalid('migration-source-invalid', `evidence ${portable} has an invalid declared digest`, EXIT_USAGE);
    }
    const lexical = resolve(sourceDir, ...portable.split('/'));
    let actual = null;
    try { actual = realpathSync(lexical); }
    catch {
      diagnostics.push('legacy-receipt-missing');
      return Object.freeze({
        path: portable,
        class: row.class,
        digest: row.digest,
        declared_digest: row.digest,
        bytes: null,
        status: 'missing',
      });
    }
    if (!within(sourceDir, actual)) invalid('migration-path-escape', `evidence ${portable} escapes the source root`);
    let bytes;
    try { bytes = readFileSync(actual); }
    catch {
      diagnostics.push('legacy-receipt-missing');
      return Object.freeze({
        path: portable,
        class: row.class,
        digest: row.digest,
        declared_digest: row.digest,
        bytes: null,
        status: 'unreadable',
      });
    }
    const observed = digestBytes(bytes);
    if (row.digest !== observed) diagnostics.push('migration-source-changed');
    return Object.freeze({
      path: portable,
      class: row.class,
      digest: observed,
      declared_digest: row.digest,
      bytes: bytes.length,
      status: row.digest === observed ? 'verified' : 'changed',
    });
  });
  return { rows, diagnostics };
}

function readLegacyLedger(sourceDir, descriptor) {
  const ref = normalizePortableRelativePath(descriptor.ledger_ref, { allowRoot: false });
  if (dirname(ref) !== '.') {
    invalid('legacy-ledger-layout-unsupported', 'legacy ledger must be directly inside the named source run directory');
  }
  const path = resolveWithinRoot(sourceDir, ref);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    invalid('legacy-ledger-layout-unsupported', 'legacy ledger must be a regular unaliased file in the source root');
  }
  let bytes;
  try { bytes = readFileSync(path); }
  catch (error) { invalid('legacy-receipt-missing', `legacy ledger ${ref} is unreadable: ${error.message}`); }
  try {
    const text = bytes.toString('utf8');
    return {
      ref,
      value: ref.endsWith('.json') ? JSON.parse(text) : parseYaml(text),
      digest: digestBytes(bytes),
      bytes: bytes.length,
    };
  } catch (error) {
    invalid('legacy-state-unsupported', `legacy ledger ${ref} cannot be parsed: ${error.message}`);
  }
}

function proposalCore({ descriptor, ledger, sourceEvidence, approvalDigest, sourceRef, targetRunId, semanticMapping }) {
  return {
    schema_version: 1,
    kind: 'legacy-migration-proposal',
    source: {
      ref: sourceRef,
      driver: descriptor.source_driver,
      fixture_only: descriptor.fixture_only,
      schema_version: ledger.schema_version,
      revision: descriptor.source_revision,
      evidence: sourceEvidence.map(({ path, class: evidenceClass, digest, declared_digest, bytes, status }) => ({
        path, class: evidenceClass, digest, declared_digest: declared_digest ?? null, bytes, status: status ?? 'verified',
      })),
    },
    target: {
      driver: QUEUE_DRIVER_ID,
      run_id: targetRunId,
      approval_digest: approvalDigest,
    },
    semantic_mapping: semanticMapping,
    ownership_transition: {
      from: descriptor.source_driver,
      to: QUEUE_DRIVER_ID,
      commit_record: `${sourceRef}/${OWNERSHIP_FILE}`,
      old_driver_refusal_required: true,
      new_driver_activation_requires_commit: true,
    },
  };
}

function derivedSemanticMapping(ledger) {
  const mapping = Object.fromEntries(Object.keys(ledger).sort().map((field) => [
    field,
    field === 'held_action_grants' ? 'never-transferred' : 'preserved-as-history',
  ]));
  mapping.target_framing = 'requires-new-approval';
  mapping.review_and_repair = 'requires-new-approval';
  mapping.final_verification = 'requires-fresh-verification';
  return mapping;
}

function ledgerRiskDiagnostics(ledger, sourceDir) {
  const diagnostics = [];
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return ['legacy-state-unsupported'];
  }
  for (const field of Object.keys(ledger)) {
    if (!LEGACY_LEDGER_FIELDS.has(field)) diagnostics.push(`legacy-field-unsupported:${field}`);
  }
  if (!Array.isArray(ledger.items)) diagnostics.push('legacy-state-unsupported');
  const items = Array.isArray(ledger.items) ? ledger.items : [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    for (const field of Object.keys(item)) {
      if (!LEGACY_ITEM_FIELDS.has(field)) diagnostics.push(`legacy-field-unsupported:items[${index}].${field}`);
    }
  }
  const consumedItem = items.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
    || item.state !== 'pending'
    || !Number.isSafeInteger(item.attempts) || item.attempts !== 0
    || item.verdict != null || item.digest_ref != null || item.transcript_ref != null
    || item.started_at != null || item.ended_at != null
    || item.parked_reason != null || item.block_reason != null
    || (item.routing_fallbacks != null
      && (!Array.isArray(item.routing_fallbacks) || item.routing_fallbacks.length !== 0))
    || (item.verified != null && item.verified !== false));
  if (consumedItem) diagnostics.push('attempt-outcome-unknown');
  if (items.some((item) => item && typeof item === 'object'
      && item.routing_fallbacks != null
      && (!Array.isArray(item.routing_fallbacks) || item.routing_fallbacks.length !== 0))) {
    diagnostics.push('legacy-fallback-unverifiable');
  }
  if (items.some((item) => item && typeof item === 'object'
      && (item.parked_reason != null || item.block_reason != null))) {
    diagnostics.push('legacy-state-ambiguous');
  }
  const counters = ledger.counters;
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)
      || Object.keys(counters).some((key) => !['items_driven', 'consecutive_failures'].includes(key))
      || !Number.isSafeInteger(counters.items_driven) || counters.items_driven !== 0
      || !Number.isSafeInteger(counters.consecutive_failures) || counters.consecutive_failures !== 0) {
    diagnostics.push('legacy-budget-unverifiable');
  }
  if (existsSync(join(sourceDir, 'STOP'))) diagnostics.push('stop-present');
  if (Array.isArray(ledger.held_action_grants) && ledger.held_action_grants.length > 0) {
    diagnostics.push('held-action-approval-required');
  }
  return diagnostics;
}

function diagnosticsFor(descriptor, ledger, sourceEvidence, semanticMapping, evidenceDiagnostics, {
  sourceDir,
  lockHeldByCaller,
}) {
  const diagnostics = [];
  diagnostics.push(...evidenceDiagnostics);
  if (!SUPPORTED_LEGACY_DRIVERS.has(descriptor.source_driver)) diagnostics.push('legacy-driver-unsupported');
  if (!SUPPORTED_LEGACY_VERSIONS.has(ledger.schema_version)) diagnostics.push('legacy-version-unsupported');
  if (!SUPPORTED_LEGACY_STATES.has(ledger.status)) diagnostics.push('legacy-state-unsupported');
  else if (!MIGRATABLE_LEGACY_STATES.has(ledger.status)) diagnostics.push('legacy-state-ambiguous');
  diagnostics.push(...ledgerRiskDiagnostics(ledger, sourceDir));
  const terminalReceiptPresent = sourceEvidence.some((row) => row.class === 'terminal-receipt');
  if (!['complete', 'not-required', 'missing'].includes(descriptor.receipts)) {
    diagnostics.push('legacy-receipt-status-unsupported');
  } else if (descriptor.receipts === 'missing'
      || (descriptor.receipts === 'complete' && !terminalReceiptPresent)
      || (ledger.status === 'running' && !terminalReceiptPresent)) {
    diagnostics.push('legacy-receipt-missing');
  }
  if (descriptor.side_effects !== 'none') diagnostics.push('legacy-side-effects-unknown');
  if (descriptor.ownership.state === 'live') diagnostics.push('legacy-owner-live');
  else if (descriptor.ownership.state === 'foreign') diagnostics.push('legacy-owner-foreign');
  else if (descriptor.ownership.state !== 'quiescent'
      || descriptor.ownership.process_tree_terminated !== true) diagnostics.push('legacy-owner-unknown');
  if (!lockHeldByCaller && existsSync(join(sourceDir, LOCK_DIR))) {
    diagnostics.push('migration-ownership-uncertain');
  }
  if (!descriptor.approval_provenance?.authorization_ref
      || descriptor.approval_provenance.approved_by !== 'human') diagnostics.push('approval-provenance-missing');
  if (descriptor.target.approval?.authority?.grants?.length) diagnostics.push('migration-held-grant-forbidden');
  if (canonicalJson(descriptor.semantic_mapping) !== canonicalJson(semanticMapping)) {
    diagnostics.push('legacy-semantic-claim-mismatch');
  }
  if (Object.values(semanticMapping).some((result) => !SUPPORTED_MAPPING_RESULTS.has(result))) {
    diagnostics.push('legacy-semantic-unsupported');
  }
  return [...new Set(diagnostics)];
}

function descriptorAt(sourceDir) {
  const descriptorPath = resolveWithinRoot(sourceDir, SOURCE_FILE);
  const descriptor = readJson(descriptorPath, SOURCE_FILE);
  closed(descriptor, SOURCE_FILE, [
    'schema_version', 'kind', 'fixture_only', 'source_driver', 'source_revision', 'ledger_ref',
    'evidence', 'ownership', 'side_effects', 'receipts', 'approval_provenance',
    'semantic_mapping', 'target',
  ]);
  if (descriptor.schema_version !== 1 || descriptor.kind !== 'legacy-migration-source') {
    invalid('legacy-version-unsupported', 'expected legacy-migration-source schema version 1', EXIT_USAGE);
  }
  if (typeof descriptor.source_driver !== 'string' || descriptor.source_driver === QUEUE_DRIVER_ID) {
    invalid('driver-ownership-conflict', 'source driver must name a legacy engine', EXIT_USAGE);
  }
  if (typeof descriptor.fixture_only !== 'boolean') {
    invalid('migration-source-invalid', 'fixture_only must explicitly classify the source', EXIT_USAGE);
  }
  if (!DIGEST_RE.test(descriptor.source_revision)) {
    invalid('migration-source-invalid', 'source_revision must be a sha256 digest', EXIT_USAGE);
  }
  closed(descriptor.ownership, 'ownership', ['state', 'process_tree_terminated']);
  closed(descriptor.semantic_mapping, 'semantic_mapping', Object.keys(descriptor.semantic_mapping || {}));
  if (Object.keys(descriptor.semantic_mapping).length === 0
      || Object.entries(descriptor.semantic_mapping).some(([field, result]) => (
        !/^[a-z][a-z0-9_]*$/u.test(field) || typeof result !== 'string' || result === ''
      ))) {
    invalid('migration-source-invalid', 'semantic_mapping must name at least one field and explicit result', EXIT_USAGE);
  }
  closed(descriptor.target, 'target', ['driver', 'run_id', 'approval']);
  if (descriptor.target.driver !== QUEUE_DRIVER_ID) {
    invalid('driver-ownership-conflict', `target driver must be ${QUEUE_DRIVER_ID}`, EXIT_USAGE);
  }
  return descriptor;
}

export function migrationOwnershipPath(sourceDir) {
  return join(sourceDir, OWNERSHIP_FILE);
}

/** Read and classify legacy evidence without writing anything. */
export function inspectLegacyMigration({
  repoRoot: repoRootValue,
  sourceDir: sourceDirValue,
  lockHeldByCaller = false,
}) {
  const { repoRoot, sourceDir } = sourceRoot(repoRootValue, sourceDirValue);
  const descriptor = descriptorAt(sourceDir);
  const ledgerDocument = readLegacyLedger(sourceDir, descriptor);
  const ledger = ledgerDocument.value;
  const semanticMapping = derivedSemanticMapping(ledger);
  const evidenceResult = evidenceRows(sourceDir, descriptor.evidence);
  const sourceEvidence = evidenceResult.rows;
  const evidenceDiagnostics = [...evidenceResult.diagnostics];
  const ledgerEvidence = sourceEvidence.find((row) => row.path === ledgerDocument.ref);
  if (!ledgerEvidence || ledgerEvidence.class !== 'legacy-ledger') {
    evidenceDiagnostics.push('legacy-ledger-evidence-missing');
    sourceEvidence.push(Object.freeze({
      path: ledgerDocument.ref,
      class: 'legacy-ledger',
      digest: ledgerDocument.digest,
      declared_digest: null,
      bytes: ledgerDocument.bytes,
      status: 'unlisted',
    }));
  }
  if (descriptor.source_revision !== ledgerDocument.digest) evidenceDiagnostics.push('migration-source-changed');
  const descriptorBytes = readFileSync(join(sourceDir, SOURCE_FILE));
  sourceEvidence.push(Object.freeze({
    path: SOURCE_FILE,
    class: 'migration-source-descriptor',
    digest: digestBytes(descriptorBytes),
    bytes: descriptorBytes.length,
  }));
  const targetRunId = normalizePortableRelativePath(descriptor.target.run_id, { allowRoot: false });
  const approval = normalizeApprovalEnvelope(descriptor.target.approval);
  if (approval.run_id !== targetRunId || approval.driver !== QUEUE_DRIVER_ID) {
    invalid('migration-source-invalid', 'target approval identity does not match the proposed target');
  }
  const approvalDigest = approvalEnvelopeDigest(approval);
  const sourceRef = repoRelative(repoRoot, sourceDir);
  const core = proposalCore({
    descriptor,
    ledger,
    sourceEvidence,
    approvalDigest,
    sourceRef,
    targetRunId,
    semanticMapping,
  });
  const proposalDigest = digestDocument(core);
  const existingOwnership = existsSync(migrationOwnershipPath(sourceDir))
    ? readJson(migrationOwnershipPath(sourceDir), OWNERSHIP_FILE)
    : null;
  const diagnostics = diagnosticsFor(
    descriptor,
    ledger,
    sourceEvidence,
    semanticMapping,
    evidenceDiagnostics,
    { sourceDir, lockHeldByCaller },
  );
  if (existingOwnership && existingOwnership.proposal_digest !== proposalDigest) {
    diagnostics.push('driver-ownership-conflict');
  }
  const proposal = {
    ...core,
    proposal_digest: proposalDigest,
    source_driver: descriptor.source_driver,
    source_revision: descriptor.source_revision,
    source_evidence: core.source.evidence,
    target_driver: QUEUE_DRIVER_ID,
    target_run_id: targetRunId,
    proposed_ownership_transition: core.ownership_transition,
    reports: {
      semantic_mapping: semanticMapping,
      field_or_semantic_loss: Object.entries(semanticMapping)
        .filter(([, result]) => !['preserved', 'preserved-as-history'].includes(result))
        .map(([field, result]) => ({ field, result }))
        .concat(diagnostics.filter((code) => code.startsWith('legacy-field-unsupported:'))
          .map((code) => ({ field: code.slice('legacy-field-unsupported:'.length), result: 'unsupported' }))),
      unsupported_states: diagnostics.filter((code) => code.includes('state') || code.includes('version')),
      missing_receipts: diagnostics.includes('legacy-receipt-missing'),
      approval_provenance: descriptor.approval_provenance ?? { status: 'missing' },
      ambiguous_side_effects: descriptor.side_effects !== 'none',
      existing_engine_ownership: existingOwnership ?? {
        driver: descriptor.source_driver,
        ...descriptor.ownership,
      },
      exact_target_driver_identity: QUEUE_DRIVER_ID,
      fixture_only: descriptor.fixture_only,
    },
    diagnostics: [...new Set(diagnostics)],
    outcome: diagnostics.length === 0 ? 'eligible' : 'parked',
  };
  assertPublicDocument(proposal, 'legacy-migration-proposal');
  return Object.freeze(proposal);
}

function assertAuthorization(authorization, proposal, expectedProposalDigest) {
  if (expectedProposalDigest !== proposal.proposal_digest) {
    invalid('migration-proposal-changed', 'source evidence, revision, mapping, or ownership proposal changed');
  }
  const historicalRef = proposal.reports.approval_provenance?.authorization_ref;
  const historicalRequestDigest = proposal.reports.approval_provenance?.request_digest;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)
      || typeof authorization.approval_ref !== 'string' || authorization.approval_ref.trim() === ''
      || authorization.approval_ref === historicalRef
      || authorization.approved_by !== 'human'
      || typeof authorization.approved_at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(authorization.approved_at)
      || Number.isNaN(Date.parse(authorization.approved_at))
      || !DIGEST_RE.test(authorization.request_digest)
      || authorization.request_digest === historicalRequestDigest
      || authorization.source_driver !== proposal.source_driver
      || authorization.target_driver !== QUEUE_DRIVER_ID
      || authorization.target_run_id !== proposal.target_run_id
      || authorization.proposal_digest !== proposal.proposal_digest) {
    invalid('migration-authorization-invalid', 'fresh authorization must bind the exact proposal, source, target, and driver identities');
  }
}

function writeImmutable(path, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return body;
}

function ensureImmutable(path, value, label) {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const observed = readFileSync(path, 'utf8');
    if (observed !== expected) invalid('migration-receipt-conflict', `${label} differs from the approved proposal`);
    return observed;
  }
  return writeImmutable(path, value);
}

function publishImmutable(path, value) {
  const temporary = `${path}.pending`;
  ensureImmutable(temporary, value, 'pending ownership record');
  if (existsSync(path)) invalid('driver-ownership-conflict', 'migration ownership was committed concurrently');
  renameSync(temporary, path);
}

function migrationLockPaths(repoRoot, sourceDir) {
  return {
    lock: join(sourceDir, LOCK_DIR),
    recovery: join(sourceDir, '.migration-lock-recovery'),
    lockMutationGuard: join(sourceDir, '.migration-lock-mutation'),
  };
}

function releaseMigrationLock(lease) {
  releaseLock(lease.paths, lease.nonce);
}

function acquireMigrationLock(repoRoot, sourceDir) {
  const paths = migrationLockPaths(repoRoot, sourceDir);
  try {
    const lease = acquireLock(paths, { timeoutMs: 0 });
    return { paths, nonce: lease.nonce };
  } catch {
    invalid('migration-ownership-uncertain', 'another legacy mutation or migration owns the source lock', EXIT_IO);
  }
}

function faultAt(options, boundary) {
  options.onBoundary?.(boundary);
  if (options.hardExitAt === boundary) process.exit(86);
  if (options.faultAt === boundary) throw new Error(`fault-injected:${boundary}`);
}

function archivePlan(proposal) {
  const suffix = proposal.proposal_digest.slice('sha256:'.length);
  const rootRef = `${proposal.source.ref}/${ARCHIVE_DIR}/${suffix}`;
  const files = proposal.source_evidence.map((row) => ({
    source_path: row.path,
    archive_ref: `${rootRef}/${row.path}`,
    digest: row.digest,
    bytes: row.bytes,
  }));
  const manifest = {
    schema_version: 1,
    kind: 'legacy-migration-archive',
    proposal_digest: proposal.proposal_digest,
    source_ref: proposal.source.ref,
    source_revision: proposal.source_revision,
    files,
  };
  return {
    root_ref: rootRef,
    manifest_ref: `${rootRef}/archive-manifest.json`,
    manifest,
    manifest_digest: digestDocument(manifest),
  };
}

function targetBundle({ repoRoot, sourceDir, proposal, descriptor, authorization }) {
  const approval = normalizeApprovalEnvelope(descriptor.target.approval);
  const archive = archivePlan(proposal);
  const ownerPath = migrationOwnershipPath(sourceDir);
  const ownerRef = repoRelative(repoRoot, ownerPath);
  const receiptRef = `artifacts/runs/${proposal.target_run_id}/${MIGRATION_RECEIPT_FILE}`;
  const state = createInitialQueueState(approval);
  state.migration = {
    proposal_digest: proposal.proposal_digest,
    source_driver: proposal.source_driver,
    source_ref: proposal.source.ref,
    source_revision: proposal.source_revision,
    ownership_ref: ownerRef,
    receipt_ref: receiptRef,
    archive_ref: archive.manifest_ref,
    archive_manifest_digest: archive.manifest_digest,
  };
  const sourceReference = {
    schema_version: 1,
    kind: 'legacy-migration-source-reference',
    source_ref: proposal.source.ref,
    source_revision: proposal.source_revision,
    source_evidence: proposal.source_evidence,
    archive_ref: archive.manifest_ref,
    archive_manifest_digest: archive.manifest_digest,
    proposal_digest: proposal.proposal_digest,
  };
  const receipt = {
    schema_version: 1,
    kind: 'legacy-migration-receipt',
    driver: QUEUE_DRIVER_ID,
    source_driver: proposal.source_driver,
    target_run_id: proposal.target_run_id,
    proposal_digest: proposal.proposal_digest,
    source_revision: proposal.source_revision,
    original_evidence: proposal.source_evidence.map((row) => ({
      ...row,
      archive_ref: `${archive.root_ref}/${row.path}`,
    })),
    archive_ref: archive.manifest_ref,
    archive_manifest_digest: archive.manifest_digest,
    semantic_mapping: proposal.reports.semantic_mapping,
    historical_approval_provenance: descriptor.approval_provenance,
    held_action_grants: [],
    migration_approval: {
      approval_ref: authorization.approval_ref,
      approved_by: authorization.approved_by,
      approved_at: authorization.approved_at,
      request_digest: authorization.request_digest,
      source_driver: authorization.source_driver,
      target_driver: authorization.target_driver,
      target_run_id: authorization.target_run_id,
      proposal_digest: authorization.proposal_digest,
    },
    target_digests: {
      approval: approvalEnvelopeDigest(approval),
      state: digestDocument(state),
      source_reference: digestDocument(sourceReference),
    },
    ownership_transition: proposal.proposed_ownership_transition,
  };
  assertPublicDocument(receipt, 'legacy-migration-receipt');
  return { approval, state, sourceReference, receipt, archive };
}

function exactDocument(path, expected, label) {
  let observed;
  try { observed = readFileSync(path, 'utf8'); }
  catch (error) { invalid('migration-recovery-required', `${label} is missing or unreadable: ${error.message}`, EXIT_IO); }
  const exact = `${JSON.stringify(expected, null, 2)}\n`;
  if (observed !== exact) invalid('migration-receipt-conflict', `${label} differs from the exact approved target bundle`);
  return Buffer.from(observed, 'utf8');
}

function validateTargetBundle(targetDir, bundle) {
  exactDocument(join(targetDir, APPROVAL_FILE), bundle.approval, 'target approval envelope');
  exactDocument(join(targetDir, 'run.json'), bundle.state, 'target run state');
  exactDocument(join(targetDir, SOURCE_REFERENCE_FILE), bundle.sourceReference, 'target source reference');
  const receiptBytes = exactDocument(
    join(targetDir, MIGRATION_RECEIPT_FILE),
    bundle.receipt,
    'target migration receipt',
  );
  return { receipt: bundle.receipt, receiptDigest: digestBytes(receiptBytes) };
}

function validateCommittedTarget(targetDir, bundle) {
  exactDocument(join(targetDir, APPROVAL_FILE), bundle.approval, 'target approval envelope');
  exactDocument(join(targetDir, SOURCE_REFERENCE_FILE), bundle.sourceReference, 'target source reference');
  const receiptBytes = exactDocument(
    join(targetDir, MIGRATION_RECEIPT_FILE),
    bundle.receipt,
    'target migration receipt',
  );
  const state = readFencedRun(targetDir);
  if (state.run_id !== bundle.state.run_id || state.driver !== QUEUE_DRIVER_ID
      || state.migration?.proposal_digest !== bundle.state.migration.proposal_digest
      || state.migration?.archive_manifest_digest !== bundle.state.migration.archive_manifest_digest) {
    invalid('migration-receipt-conflict', 'progressed target no longer carries the approved migration identity');
  }
  return { receipt: bundle.receipt, receiptDigest: digestBytes(receiptBytes) };
}

function materializeArchive(repoRoot, sourceDir, proposal, archive) {
  const relativeRoot = relative(sourceDir, resolve(repoRoot, ...archive.root_ref.split('/')))
    .split(sep).join('/');
  const archiveDir = ensureContainedDirectory(sourceDir, relativeRoot);
  for (const row of proposal.source_evidence) {
    const sourcePath = resolveWithinRoot(sourceDir, row.path);
    const bytes = readFileSync(sourcePath);
    if (digestBytes(bytes) !== row.digest) invalid('migration-source-changed', `source evidence changed before archive: ${row.path}`);
    const parentRef = dirname(row.path).split(sep).join('/');
    ensureContainedDirectory(archiveDir, parentRef);
    const target = resolveWithinRoot(archiveDir, row.path, { mustExist: false });
    if (existsSync(target)) {
      if (!readFileSync(target).equals(bytes)) invalid('migration-receipt-conflict', `archived evidence conflicts: ${row.path}`);
    } else {
      let fd;
      try {
        fd = openSync(target, 'wx', 0o400);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    chmodSync(target, 0o400);
    chmodSync(sourcePath, 0o400);
  }
  ensureImmutable(join(archiveDir, 'archive-manifest.json'), archive.manifest, 'legacy archive manifest');
  chmodSync(join(archiveDir, 'archive-manifest.json'), 0o400);
  return archive.manifest_digest;
}

function ownershipRecord(proposal, receiptDigest) {
  return {
    schema_version: 1,
    kind: 'legacy-migration-ownership',
    driver: QUEUE_DRIVER_ID,
    source_driver: proposal.source_driver,
    target_run_id: proposal.target_run_id,
    proposal_digest: proposal.proposal_digest,
    migration_receipt_ref: `artifacts/runs/${proposal.target_run_id}/${MIGRATION_RECEIPT_FILE}`,
    migration_receipt_digest: receiptDigest,
  };
}

/** Apply only the exact currently-inspected proposal. No provider or worker is launched. */
export function applyLegacyMigration(options) {
  const { repoRoot, sourceDir } = sourceRoot(options.repoRoot, options.sourceDir);
  // Preliminary inspection suppresses only the lock diagnostic so exact authorization can be
  // checked before ANY mutating lock acquisition/recovery. The shared CAS lock is then acquired,
  // and the complete proposal is re-read under that lock before any target/source write.
  const proposal = inspectLegacyMigration({ repoRoot, sourceDir, lockHeldByCaller: true });
  assertAuthorization(options.authorization, proposal, options.expectedProposalDigest);
  const publicRoot = publicRunsRoot(repoRoot);
  const targetParentRef = dirname(proposal.target_run_id).split(sep).join('/');
  ensureContainedDirectory(publicRoot, targetParentRef);
  const targetDir = resolveWithinRoot(publicRoot, proposal.target_run_id, { mustExist: false });
  const ownerPath = migrationOwnershipPath(sourceDir);
  const descriptor = descriptorAt(sourceDir);
  const initialBundle = targetBundle({
    repoRoot, sourceDir, proposal, descriptor, authorization: options.authorization,
  });

  if (existsSync(ownerPath)) {
    const owner = readJson(ownerPath, OWNERSHIP_FILE);
    if (owner.proposal_digest !== proposal.proposal_digest || owner.driver !== QUEUE_DRIVER_ID) {
      invalid('driver-ownership-conflict', 'legacy source is already owned by a different proposal');
    }
    const existing = validateCommittedTarget(targetDir, initialBundle);
    if (owner.migration_receipt_digest !== existing.receiptDigest) {
      invalid('migration-receipt-conflict', 'ownership and immutable receipt digests differ');
    }
    return Object.freeze({ result: 'replayed', receipt_digest: existing.receiptDigest, proposal_digest: proposal.proposal_digest });
  }
  if (proposal.outcome !== 'eligible') {
    invalid('migration-source-parked', `legacy source requires inspection: ${proposal.diagnostics.join(', ')}`);
  }

  const lock = acquireMigrationLock(repoRoot, sourceDir);
  try {
    const refreshed = inspectLegacyMigration({ repoRoot, sourceDir, lockHeldByCaller: true });
    assertAuthorization(options.authorization, refreshed, options.expectedProposalDigest);
    if (refreshed.outcome !== 'eligible') invalid('migration-source-parked', refreshed.diagnostics.join(', '));
    const refreshedDescriptor = descriptorAt(sourceDir);
    const bundle = targetBundle({
      repoRoot, sourceDir, proposal: refreshed, descriptor: refreshedDescriptor,
      authorization: options.authorization,
    });

    let receipt;
    let receiptDigest;
    if (existsSync(targetDir)) {
      ({ receipt, receiptDigest } = validateTargetBundle(targetDir, bundle));
    } else {
      const stagingName = `.migration-${refreshed.proposal_digest.slice('sha256:'.length)}`;
      const stagingRef = targetParentRef === '.' ? stagingName : `${targetParentRef}/${stagingName}`;
      const staging = ensureContainedDirectory(publicRoot, stagingRef);
      receipt = bundle.receipt;
      faultAt(options, 'before-approval-written');
      ensureImmutable(join(staging, APPROVAL_FILE), bundle.approval, 'staged approval envelope');
      faultAt(options, 'after-approval-written');
      faultAt(options, 'before-receipt-written');
      const receiptBody = ensureImmutable(
        join(staging, MIGRATION_RECEIPT_FILE),
        receipt,
        'staged migration receipt',
      );
      faultAt(options, 'after-receipt-written');
      receiptDigest = digestBytes(Buffer.from(receiptBody, 'utf8'));
      faultAt(options, 'before-source-reference-written');
      ensureImmutable(join(staging, SOURCE_REFERENCE_FILE), {
        ...bundle.sourceReference,
      }, 'staged source reference');
      faultAt(options, 'after-source-reference-written');
      faultAt(options, 'before-run-initialized');
      const stagedStatePath = join(staging, 'run.json');
      if (existsSync(stagedStatePath)) {
        const expectedState = `${JSON.stringify(bundle.state, null, 2)}\n`;
        if (readFileSync(stagedStatePath, 'utf8') !== expectedState) {
          invalid('migration-receipt-conflict', 'staged target state differs from the approved proposal');
        }
      } else {
        initializeFencedRun(staging, bundle.state);
      }
      faultAt(options, 'after-run-initialized');
      faultAt(options, 'after-target-staged');
      faultAt(options, 'before-target-published');
      renameSync(staging, targetDir);
      faultAt(options, 'after-target-published');
    }

    ({ receipt, receiptDigest } = validateTargetBundle(targetDir, bundle));

    // Revalidate all source bytes while the shared legacy-mutation lock is held. Supported legacy
    // writers acquire the same lock immediately before save, closing the final-observation race.
    const finalProposal = inspectLegacyMigration({ repoRoot, sourceDir, lockHeldByCaller: true });
    if (finalProposal.proposal_digest !== refreshed.proposal_digest) {
      invalid('migration-proposal-changed', 'legacy evidence changed before ownership commit');
    }
    if (finalProposal.outcome !== 'eligible') {
      invalid('migration-source-parked', `legacy source changed before ownership commit: ${finalProposal.diagnostics.join(', ')}`);
    }
    faultAt(options, 'before-source-archived');
    materializeArchive(repoRoot, sourceDir, finalProposal, bundle.archive);
    faultAt(options, 'after-source-archived');
    validateTargetBundle(targetDir, bundle);
    faultAt(options, 'before-ownership-committed');
    publishImmutable(ownerPath, ownershipRecord(finalProposal, receiptDigest));
    faultAt(options, 'after-ownership-committed');
    return Object.freeze({
      result: 'applied',
      proposal_digest: finalProposal.proposal_digest,
      receipt_digest: receiptDigest,
      target_run_id: finalProposal.target_run_id,
      driver: QUEUE_DRIVER_ID,
    });
  } finally {
    releaseMigrationLock(lock);
  }
}

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(2),
      options: {
        'dry-run': { type: 'boolean', default: false },
        apply: { type: 'boolean', default: false },
        'proposal-digest': { type: 'string' },
        'approval-ref': { type: 'string' },
        'approved-by': { type: 'string' },
        'approved-at': { type: 'string' },
        'approval-request-digest': { type: 'string' },
        'source-driver': { type: 'string' },
        'target-driver': { type: 'string' },
        'target-run-id': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new SidekicksError(`cli-orchestrator migrate: ${error.message}`, EXIT_USAGE);
  }
  const apply = parsed.values.apply;
  if (parsed.positionals.length !== 1 || parsed.values['dry-run'] === apply
      || (apply && (!parsed.values['proposal-digest'] || !parsed.values['approval-ref']
        || !parsed.values['approved-by'] || !parsed.values['approved-at']
        || !parsed.values['approval-request-digest']
        || !parsed.values['source-driver'] || !parsed.values['target-driver']
        || !parsed.values['target-run-id']))) {
    throw new SidekicksError(
      'cli-orchestrator migrate: usage: migrate <legacy-source-dir> --dry-run | --apply --proposal-digest <sha256> --approval-ref <fresh-ref> --approved-by human --approved-at <rfc3339> --approval-request-digest <sha256> --source-driver <id> --target-driver queue-supervisor/v1 --target-run-id <id> [--json]',
      EXIT_USAGE,
    );
  }
  return parsed;
}

/** CLI entrypoint. */
export function run(ctx) {
  const parsed = parse(ctx.argv);
  const sourceDir = resolve(ctx.repoRoot, parsed.positionals[0]);
  if (parsed.values['dry-run']) {
    const proposal = inspectLegacyMigration({ repoRoot: ctx.repoRoot, sourceDir });
    return { stdout: `${JSON.stringify(proposal, null, 2)}\n` };
  }
  const proposal = inspectLegacyMigration({ repoRoot: ctx.repoRoot, sourceDir });
  const result = applyLegacyMigration({
    repoRoot: ctx.repoRoot,
    sourceDir,
    expectedProposalDigest: parsed.values['proposal-digest'],
    authorization: {
      approval_ref: parsed.values['approval-ref'],
      approved_by: parsed.values['approved-by'],
      approved_at: parsed.values['approved-at'],
      request_digest: parsed.values['approval-request-digest'],
      source_driver: parsed.values['source-driver'],
      target_driver: parsed.values['target-driver'],
      target_run_id: parsed.values['target-run-id'],
      proposal_digest: parsed.values['proposal-digest'],
    },
  });
  return {
    stdout: parsed.values.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `legacy migration ${result.result}: ${proposal.source_driver} -> ${QUEUE_DRIVER_ID} (${proposal.target_run_id})\n`,
  };
}
