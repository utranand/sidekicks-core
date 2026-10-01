// lib/database-lifecycle/offload.mjs
// Implements `sidekicks database offload <alias>... [--match <glob>] [--tier <t>] [--reason <r>]
//   [--dry-run] [--json] [--root]` and its inverse `sidekicks database offload <alias>...
//   --restore [--json] [--match <glob>] [--root]`.
//
// PARKS a `database_connector` / `teleport_database_connector` alias by commenting every one of its
// own lines out IN PLACE (lib/database-lifecycle/_offload-marks.mjs) — no twin block, no resolver
// deny-list: every reader in this repo already skips a `#`-prefixed line at any indent, so a parked
// alias is simply unknown the moment its lines carry the marker.
//
// SEALED, ON TOP OF COMMENTED-OUT. A hook can deny a shell command; it cannot stop an agent that
// deliberately rewrites the config text itself. So every `password:` value the alias carries, in
// EVERY scope file (the committed family file included — cheap, since its own value is normally the
// blank `""` placeholder, but a real value must never slip through just because it landed somewhere
// unexpected) is sealed with the scope's own X25519 public key (lib/database-lifecycle/_seal.mjs)
// BEFORE the entry is commented out. Offload therefore needs only that public key — no interaction —
// but `--restore` needs the PRIVATE key, which only ever exists decrypted in memory, for the
// duration of one restore, after the user's own passphrase (typed hidden, at an interactive TTY)
// unlocked it. `--yes` is not a substitute for that passphrase and is refused outright.
//
// KEY-ROTATION SAFETY. Every `#[offloaded:meta]` line records `key=<fp>` — the sha256 fingerprint
// (16 hex chars) of the public key active at the moment of offload. `offload` refuses outright when
// the scope already has an alias sealed under a DIFFERENT fingerprint than the one currently loaded
// (mixing keys silently is worse than refusing); `--restore` refuses per-alias on the same mismatch,
// before touching anything, so a rotated-and-archived key never gets misapplied to old ciphertext.
//
// PASSWORD SHAPES THE SEALER CANNOT SAFELY REWRITE (a block scalar `|`/`>`, a flow-mapping-embedded
// key, an anchor/alias `&`/`*`, an unterminated multi-line quote) are detected BEFORE anything is
// sealed or commented — the whole offload refuses, naming the file and line, never the value, so a
// shape this module cannot handle never gets silently left unsealed.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_USAGE, EXIT_VALIDATION, EXIT_IO, SidekicksError } from '../sk-cli/errors.mjs';
import { resolveBlock } from '../config-store/read.mjs';
import { isSecretFileName, renderScalar } from '../config-store/write.mjs';
import { parseValue } from '../config-store/block.mjs';
import { commentEntry, uncommentEntry, listOffloaded, entryLinesFor } from './_offload-marks.mjs';
import { writeAtomic, writeSecretAtomic } from '../fs-safety/fsx.mjs';
import { assertWritable } from '../fs-safety/fs-guard.mjs';
import {
  sealValue, unsealValue, isSealed, readSealKeyFile, decryptPrivateKey, promptPassphrase,
  keyFingerprint,
} from './_seal.mjs';
import {
  DB_TIERS, OFFLOAD_BLOCKS, RESERVED_KEYS, dbTierFromAlias, formatBangkokIso, gitUserName,
  tokenizeOffloadArgv, stripVerbPrefix, globToRegExp, resolveOffloadScope,
} from './_offload-shared.mjs';

/** Boolean-only flags — a `--flag=value` spelling on any of these is a usage error. `yes` stays
 * recognised (so `--yes=…` still hits that check) even though restore no longer accepts it at all —
 * see the explicit refusal below, which gives a clearer message than "unrecognised flag". */
const BOOL_FLAGS = ['restore', 'dry-run', 'json', 'root', 'yes'];

/** C0 + C1 control characters, plus the two Unicode line/paragraph separators U+2028/U+2029 — any
 * of these could inject a second, hostile line into what must stay a single YAML comment. */
const UNSAFE_TEXT_RE = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/;

/** A `password:` line at any indent, key optionally single/double-quoted (the key's own spelling is
 * captured and preserved on rewrite — sealing must never change `'password':` into `password:`, or a
 * restore would no longer be byte-identical to the file the offload started from), value captured
 * raw (still quoted/escaped as written). */
const PASSWORD_LINE_RE = /^(\s*)(password|'password'|"password")\s*:\s*(.*)$/;

/** Reserved routing keys for one block, or an empty set when it has none. */
function reservedFor(block) {
  return RESERVED_KEYS[block] || new Set();
}

/**
 * The alias names a set of blocks currently carry LIVE (resolvable), tolerating an undeclared
 * block (contributes nothing rather than failing the whole verb). Reserved routing keys
 * (`teleport_database_connector.defaults`) never appear here.
 *
 * @param {string} repoRoot
 * @param {string[]} blockNames
 * @returns {Set<string>}
 */
function liveAliasSet(repoRoot, blockNames) {
  const out = new Set();
  for (const block of blockNames) {
    let resolved;
    try {
      resolved = resolveBlock(repoRoot, block);
    } catch {
      continue;
    }
    const reserved = reservedFor(block);
    for (const key of Object.keys(resolved.config || {})) {
      if (!reserved.has(key)) out.add(key);
    }
  }
  return out;
}

/**
 * Every `listOffloaded` record across a set of scope files, tagged with which block it belongs to.
 *
 * @param {string} repoRoot
 * @param {string[]} scopeFiles - repo-relative
 * @returns {Array<object>}
 */
function allOffloadedRecords(repoRoot, scopeFiles) {
  const out = [];
  for (const rel of scopeFiles) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    out.push(...listOffloaded(text));
  }
  return out;
}

/**
 * The alias names currently PARKED under a set of blocks, read straight off the scope's own files
 * (committed values only — never needs the secret file's contents to answer "what is parked").
 *
 * @param {string} repoRoot
 * @param {string[]} scopeFiles - repo-relative
 * @param {string[]} blockNames
 * @returns {Set<string>}
 */
function offloadedAliasSet(repoRoot, scopeFiles, blockNames) {
  const out = new Set();
  const blocks = new Set(blockNames);
  for (const rec of allOffloadedRecords(repoRoot, scopeFiles)) {
    if (blocks.has(rec.block)) out.add(rec.alias);
  }
  return out;
}

/**
 * Resolve the alias list this invocation acts on, and validate every EXPLICITLY named one.
 *
 * @param {string} repoRoot
 * @param {{positionals: string[], match: string|null, tier: string|null, restore: boolean, scopeFiles: string[]}} opts
 * @returns {string[]}
 */
function resolveCandidateAliases(repoRoot, { positionals, match, tier, restore, scopeFiles }) {
  const known = restore
    ? offloadedAliasSet(repoRoot, scopeFiles, OFFLOAD_BLOCKS)
    : liveAliasSet(repoRoot, OFFLOAD_BLOCKS);

  let candidates;
  if (positionals.length) {
    candidates = [...new Set(positionals)];
    const missing = candidates.filter((a) => !known.has(a));
    if (missing.length) {
      if (!restore) {
        const offloaded = offloadedAliasSet(repoRoot, scopeFiles, OFFLOAD_BLOCKS);
        const alreadyOffloaded = missing.filter((a) => offloaded.has(a));
        const unknown = missing.filter((a) => !offloaded.has(a));
        if (alreadyOffloaded.length) {
          throw new SidekicksError(
            `database offload: ${alreadyOffloaded.map((a) => `'${a}'`).join(', ')} already offloaded`
            + ` — run 'sidekicks database offload ${alreadyOffloaded.join(' ')} --restore' first`,
            EXIT_VALIDATION
          );
        }
        throw new SidekicksError(
          `database offload: unknown alias ${unknown.map((a) => `'${a}'`).join(', ')}`
          + " — run 'sidekicks config get database_connector --json' to see what's connectable",
          EXIT_VALIDATION
        );
      }
      throw new SidekicksError(
        `database offload --restore: unknown alias ${missing.map((a) => `'${a}'`).join(', ')}`
        + " — run 'sidekicks database offloaded' to see what's parked",
        EXIT_VALIDATION
      );
    }
  } else {
    candidates = [...known];
    if (match) {
      const re = globToRegExp(match);
      candidates = candidates.filter((a) => re.test(a));
    }
    if (!restore && tier) {
      candidates = candidates.filter((a) => dbTierFromAlias(a) === tier);
    }
  }
  return candidates;
}

/** Does `value` (a password's own YAML scalar text, trimmed) have a closing quote for `q`? Our own
 * tolerant reader (`lib/config-store/block.mjs` `parseValue`) takes the first same-line `q` it finds
 * after the opening one — "closed", for our purposes, means one exists at all. */
function hasClosingQuote(value, q) {
  return value.indexOf(q, 1) !== -1;
}

/**
 * A `password:` shape (any indent, optionally quoted key) the sealer cannot safely rewrite, or
 * `null` when the line is fine — including "this line is not a password assignment at all".
 * Detection only, never a rewrite: the caller decides what to do with the description.
 *
 * @param {string} line
 * @returns {string|null}
 */
function detectUnsealablePasswordShape(line) {
  const m = PASSWORD_LINE_RE.exec(line);
  if (m) {
    const value = m[3].trim();
    if (value === '') return null; // nothing to seal — an empty/placeholder value
    if (/^[|>]/.test(value)) return 'a block-scalar (| or >) password value';
    if (/^[&*]/.test(value)) return 'an anchor/alias (& or *) password value';
    if (value.startsWith('"') && !hasClosingQuote(value, '"')) {
      return 'an unterminated double-quoted password value (possibly multi-line)';
    }
    if (value.startsWith("'") && !hasClosingQuote(value, "'")) {
      return 'an unterminated single-quoted password value (possibly multi-line)';
    }
    return null;
  }
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return null; // a comment mentioning the word is not an assignment
  // A password key appearing anywhere OTHER than the start of the line — most commonly a flow
  // mapping (`{ host: h, password: x }`) or a sequence row (`- password: x`) — never matches the
  // anchored form above, and would otherwise leave its value silently unsealed.
  if (/(?:password|'password'|"password")\s*:/.test(line)) {
    return 'a password key in a shape this sealer does not recognise (flow mapping, sequence row, or embedded key)';
  }
  return null;
}

/**
 * Refuse the WHOLE offload — before anything is sealed, commented, or written — if any candidate's
 * entry carries a password shape `detectUnsealablePasswordShape` cannot safely rewrite, in ANY scope
 * file. Named by file and line; the value itself never appears in the message.
 *
 * @param {string} repoRoot
 * @param {Map<string,string>} fileTexts
 * @param {string[]} candidates
 */
function assertSealablePasswordShapes(repoRoot, fileTexts, candidates) {
  for (const [relFile, text] of fileTexts) {
    for (const block of OFFLOAD_BLOCKS) {
      const reserved = reservedFor(block);
      for (const alias of candidates) {
        if (reserved.has(alias)) continue;
        for (const occurrence of entryLinesFor(text, block, alias)) {
          for (const { line, lineNumber } of occurrence.lines) {
            const problem = detectUnsealablePasswordShape(line);
            if (problem) {
              throw new SidekicksError(
                `database offload: '${alias}' has ${problem} at ${relFile}:${lineNumber} — refusing `
                + 'the whole offload rather than silently leaving it unsealed; rewrite it as a '
                + 'single-line quoted or bare scalar first',
                EXIT_VALIDATION
              );
            }
          }
        }
      }
    }
  }
}

/** Seal a `password:` line's value in place, for the OFFLOAD direction. Any other line, or a
 * `password:` line whose value is already empty or already sealed, is returned untouched. */
function sealPasswordLine(line, alias, publicKeyPem) {
  const m = PASSWORD_LINE_RE.exec(line);
  if (!m) return line;
  const [, indent, keyText, rawValue] = m;
  const value = parseValue(rawValue);
  if (value === '' || value === null || value === undefined || isSealed(value)) return line;
  const sealed = sealValue(publicKeyPem, alias, String(value));
  // The sealed string is base64 + literal colons only — always double-quote-safe, no escaping.
  // `keyText` preserves the original key's own spelling (`password` / `'password'` / `"password"`)
  // so sealing never changes what a restore would need to reproduce byte-for-byte.
  return `${indent}${keyText}: "${sealed}"`;
}

/** Unseal a `password:` line's value in place, for the RESTORE direction. Any other line, or a
 * `password:` line that was never sealed, is returned untouched. A failed unseal (wrong passphrase,
 * corrupted ciphertext, alias mismatch) is already a `SidekicksError` (`_seal.mjs` `unsealValue`). */
function unsealPasswordLine(line, alias, privateKeyObject) {
  const m = PASSWORD_LINE_RE.exec(line);
  if (!m) return line;
  const [, indent, keyText, rawValue] = m;
  const value = parseValue(rawValue);
  if (!isSealed(value)) return line;
  const plaintext = unsealValue(privateKeyObject, alias, String(value));
  return `${indent}${keyText}: ${renderScalar(plaintext)}`;
}

/**
 * Execute the `database offload`/`database offload … --restore` verb.
 *
 * @param {{repoRoot: string, argv?: string[], _stdin?: object}} ctx
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const { flags, positionals: rawPositionals } = tokenizeOffloadArgv(
    Array.isArray(ctx.argv) ? ctx.argv : []
  );
  const positionals = stripVerbPrefix(rawPositionals, 'database', 'offload');

  // `--flag=value` on a boolean flag is a usage error (the tokenizer reports it back as a string,
  // never coerced to `true`).
  for (const name of BOOL_FLAGS) {
    if (typeof flags[name] === 'string') {
      throw new SidekicksError(`database offload: --${name} does not take a value`, EXIT_USAGE);
    }
  }

  const restore = Boolean(flags.restore);
  const dryRun = Boolean(flags['dry-run']);
  const json = Boolean(flags.json);
  const match = typeof flags.match === 'string' && flags.match !== '' ? flags.match : null;
  const reason = typeof flags.reason === 'string' ? flags.reason : '';

  // `--yes` bypassed the whole consent gate in v1's checkpoint (the finding that got it superseded)
  // and is not merely ignored now — it is refused outright, so stale automation learns immediately
  // rather than silently hanging on a passphrase prompt it was never going to answer.
  if (restore && flags.yes !== undefined) {
    throw new SidekicksError(
      'database offload --restore: --yes is no longer accepted — restore always requires the '
      + 'sealing passphrase, typed at an interactive TTY',
      EXIT_USAGE
    );
  }

  if (UNSAFE_TEXT_RE.test(reason)) {
    throw new SidekicksError(
      'database offload: --reason must not contain a control character (no YAML injection)',
      EXIT_USAGE
    );
  }

  let tier = null;
  if (!restore && flags.tier !== undefined) {
    tier = String(flags.tier);
    if (!DB_TIERS.includes(tier)) {
      throw new SidekicksError(
        `database offload: --tier '${tier}' is not one of ${DB_TIERS.join('|')}`,
        EXIT_USAGE
      );
    }
  }

  if (!positionals.length && !match && !(!restore && tier)) {
    throw new SidekicksError(
      restore
        ? 'usage: sidekicks database offload <alias>... --restore [--json] [--match <glob>] [--root]'
        : 'usage: sidekicks database offload <alias>... [--match <glob>] [--tier <t>] '
          + '[--reason <r>] [--dry-run] [--json] [--root]',
      EXIT_USAGE
    );
  }

  const scope = resolveOffloadScope(repoRoot, flags);
  const candidates = resolveCandidateAliases(repoRoot, {
    positionals, match, tier, restore, scopeFiles: scope.files,
  });
  if (!candidates.length) {
    throw new SidekicksError(
      `database ${restore ? 'offload --restore' : 'offload'}: no aliases matched — nothing to do`,
      EXIT_VALIDATION
    );
  }

  const stamp = formatBangkokIso();
  const user = gitUserName(repoRoot);
  if (UNSAFE_TEXT_RE.test(user)) {
    throw new SidekicksError(
      'database offload: git user.name must not contain a control character — fix it with '
      + "'git config user.name <name>' before offloading",
      EXIT_USAGE
    );
  }

  // ── Sealing key material — public key only for offload; the decrypted private key, behind an
  // interactive passphrase, only for restore. Resolved BEFORE any file is read for mutation, so a
  // missing key, a key-rotation mismatch, or a wrong passphrase is refused before anything else
  // happens.
  let publicKeyPem = null;
  let privateKeyObject = null;
  let currentFingerprint = null;
  if (!restore) {
    const sealKey = readSealKeyFile(repoRoot, scope.base);
    if (!sealKey) {
      throw new SidekicksError(
        "database offload: no sealing key for this scope yet — run 'sidekicks database seal-init' "
        + 'in your own terminal first (offload needs only its PUBLIC key; nothing interactive)',
        EXIT_VALIDATION
      );
    }
    publicKeyPem = sealKey.publicKeyPem;
    currentFingerprint = keyFingerprint(publicKeyPem);

    // A scope MUST NOT mix keys silently: if anything already parked here was sealed under a
    // DIFFERENT fingerprint than the one this offload would use, refuse rather than let a rotated
    // key quietly become two incompatible populations of ciphertext.
    const otherFingerprints = new Set(
      allOffloadedRecords(repoRoot, scope.files)
        .map((r) => r.key_fingerprint)
        .filter((fp) => fp && fp !== currentFingerprint)
    );
    if (otherFingerprints.size) {
      throw new SidekicksError(
        'database offload: this scope already has one or more aliases sealed under a DIFFERENT key '
        + `(fingerprint ${[...otherFingerprints].join(', ')}) than the one currently loaded `
        + `(${currentFingerprint}) — restore those aliases with the ORIGINAL key first, or run `
        + "'sidekicks database seal-init --force' only once nothing is sealed under the old one",
        EXIT_VALIDATION
      );
    }
  } else {
    const stdinStream = ctx._stdin || process.stdin;
    if (!stdinStream.isTTY) {
      throw new SidekicksError(
        'database offload --restore: refused — stdin is not an interactive TTY; run this in your '
        + 'own terminal',
        EXIT_VALIDATION
      );
    }
    const sealKey = readSealKeyFile(repoRoot, scope.base);
    if (!sealKey || !sealKey.wrapped) {
      throw new SidekicksError(
        "database offload --restore: no sealing key for this scope — run 'sidekicks database "
        + "seal-init' first if this scope never had one",
        EXIT_VALIDATION
      );
    }
    currentFingerprint = keyFingerprint(sealKey.publicKeyPem);

    // Per-alias key-rotation check, BEFORE prompting for the passphrase: an alias sealed under a
    // fingerprint that does not match the key file currently loaded can never be unsealed with it —
    // refuse by name rather than let the passphrase prompt run for nothing.
    const fingerprintsByAlias = new Map();
    for (const rec of allOffloadedRecords(repoRoot, scope.files)) {
      if (!OFFLOAD_BLOCKS.includes(rec.block) || !rec.key_fingerprint) continue;
      if (!fingerprintsByAlias.has(rec.alias)) fingerprintsByAlias.set(rec.alias, new Set());
      fingerprintsByAlias.get(rec.alias).add(rec.key_fingerprint);
    }
    const mismatched = candidates.filter((a) => {
      const fps = fingerprintsByAlias.get(a);
      return fps && fps.size && !fps.has(currentFingerprint);
    });
    if (mismatched.length) {
      throw new SidekicksError(
        `database offload --restore: ${mismatched.map((a) => `'${a}'`).join(', ')} `
        + `${mismatched.length === 1 ? 'was' : 'were'} sealed under a DIFFERENT key than the one `
        + `currently loaded (fingerprint ${currentFingerprint}) — restore with the ORIGINAL key `
        + 'file for that alias; nothing written',
        EXIT_VALIDATION
      );
    }

    const passphrase = await promptPassphrase(
      'Passphrase to unseal the sealing private key: ', stdinStream
    );
    privateKeyObject = decryptPrivateKey(sealKey.wrapped, passphrase);
    if (!privateKeyObject) {
      throw new SidekicksError(
        'database offload --restore: wrong passphrase — nothing written',
        EXIT_VALIDATION
      );
    }
  }

  /** @type {Map<string, string>} repo-relative path -> in-memory (possibly mutated) text */
  const fileTexts = new Map();
  for (const relFile of scope.files) {
    const abs = join(repoRoot, relFile);
    if (existsSync(abs)) fileTexts.set(relFile, readFileSync(abs, 'utf8'));
  }

  // Every scope file gets the seal/unseal transform, the committed family file included — its own
  // `password:` is normally the blank `""` placeholder, so this is cheap, but a real value must
  // never slip through unsealed just because it landed somewhere unexpected.
  if (!restore) {
    assertSealablePasswordShapes(repoRoot, fileTexts, candidates);
  }

  /** @type {Map<string, {blocks: Set<string>, files: Set<string>}>} */
  const touched = new Map(candidates.map((a) => [a, { blocks: new Set(), files: new Set() }]));
  const note = (alias, block, relFile) => {
    touched.get(alias).blocks.add(block);
    touched.get(alias).files.add(relFile);
  };

  for (const [relFile, original] of fileTexts) {
    let text = original;
    for (const block of OFFLOAD_BLOCKS) {
      const reserved = reservedFor(block);
      for (const alias of candidates) {
        // An alias literally named `defaults` (a perfectly ordinary `database_connector` alias) must
        // never touch Teleport's UNRELATED, reserved `defaults:` dedup key just because the name
        // matches — skip a (block, alias) pair whenever that block reserves this exact name.
        if (reserved.has(alias)) continue;
        if (restore) {
          const result = uncommentEntry(text, block, alias, {
            transformLine: (line) => unsealPasswordLine(line, alias, privateKeyObject),
          });
          if (result.found) { text = result.text; note(alias, block, relFile); }
        } else {
          const result = commentEntry(
            text, block, alias, { stamp, user, reason, keyFingerprint: currentFingerprint },
            { transformLine: (line) => sealPasswordLine(line, alias, publicKeyPem) }
          );
          if (result.found) { text = result.text; note(alias, block, relFile); }
        }
      }
    }
    fileTexts.set(relFile, text);
  }

  // `config/pending-removal.config.yaml` is retired — read by nothing (docs/guide/v1.5/
  // configuration.md, "Migrating a scope"). An alias restored ONLY there is byte-accurate but not
  // live again; that is reported, not treated as success-with-no-caveat.
  const pendingRemovalRel = scope.files[3];

  /** @type {Array<{alias: string, tier: string, blocks: string[], files: string[], retired_only: boolean}>} */
  const moved = [];
  for (const alias of candidates) {
    const t = touched.get(alias);
    if (t.blocks.size === 0) {
      throw new SidekicksError(
        `database ${restore ? 'offload --restore' : 'offload'}: '${alias}' was not found in `
        + `${restore ? 'the offloaded' : 'the live'} configuration files for this scope`,
        EXIT_VALIDATION
      );
    }
    const files = [...t.files];
    const retiredOnly = restore && files.length > 0 && files.every((f) => f === pendingRemovalRel);
    moved.push({ alias, tier: dbTierFromAlias(alias), blocks: [...t.blocks], files, retired_only: retiredOnly });
  }

  const changedFiles = [...fileTexts.keys()].filter(
    (rel) => moved.some((m) => m.files.includes(rel))
  );

  if (!dryRun) {
    // Pre-check: every file this run is about to change must be writable BEFORE any of them is
    // written — a partial write (some files changed, one refused mid-loop) is worse than refusing
    // up front.
    for (const rel of changedFiles) {
      assertWritable(join(repoRoot, rel), repoRoot);
    }

    // Write order: the password-BEARING files (the git-ignored secret file, the legacy monolith, its
    // retired pending-removal copy) go first; the committed family file — structure only, no live
    // credential — goes last. scope.files is always [family, secret, legacy, pending-removal], so
    // "everything except index 0" first, then index 0.
    const familyFileRel = scope.files[0];
    const orderedChanged = [
      ...changedFiles.filter((rel) => rel !== familyFileRel),
      ...changedFiles.filter((rel) => rel === familyFileRel),
    ];

    for (const rel of orderedChanged) {
      const abs = join(repoRoot, rel);
      const text = fileTexts.get(rel);
      if (isSecretFileName(rel)) {
        writeSecretAtomic(abs, text);
      } else {
        // Preserve the file's own mode — the writer must not silently loosen or tighten
        // permissions an operator set on a live scope's committed config.
        let mode;
        try { mode = statSync(abs).mode & 0o777; } catch { mode = undefined; }
        writeAtomic(abs, text, mode !== undefined ? { mode } : undefined);
      }
    }

    // Post-verify: confirm the write actually produced the state this run promises, before telling
    // the caller it succeeded. A retired-only restore is the one expected exception — nothing reads
    // that file, so it correctly never becomes live again.
    const liveAfter = liveAliasSet(repoRoot, OFFLOAD_BLOCKS);
    for (const m of moved) {
      if (restore) {
        if (m.retired_only) continue;
        if (!liveAfter.has(m.alias)) {
          throw new SidekicksError(
            `database offload --restore: '${m.alias}' did not resolve live again after writing — `
            + 'internal inconsistency, please report this',
            EXIT_IO
          );
        }
      } else if (liveAfter.has(m.alias)) {
        throw new SidekicksError(
          `database offload: '${m.alias}' still resolves live after writing — internal `
          + 'inconsistency, please report this',
          EXIT_IO
        );
      }
    }
  }

  const summary = {
    action: restore ? 'restore' : 'offload',
    scope: scope.projectName,
    dry_run: dryRun,
    moved,
    files_changed: changedFiles,
  };

  if (json) {
    return { stdout: JSON.stringify(summary, null, 2) + '\n', exitCode: EXIT_OK };
  }

  const verbed = restore ? 'restored' : 'offloaded';
  const lines = moved.map((m) => {
    const note = m.retired_only
      ? ' — parked only in a file nothing reads; this alias is NOT live again'
      : '';
    return `${dryRun ? '[dry-run] would be ' : ''}${verbed} '${m.alias}' `
      + `(${m.blocks.join(', ')}) in ${m.files.join(', ')}${note}`;
  });
  lines.push('');
  lines.push(dryRun
    ? 'no files written (--dry-run)'
    : `${changedFiles.length} file(s) changed: ${changedFiles.join(', ')}`);
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_OK };
}
