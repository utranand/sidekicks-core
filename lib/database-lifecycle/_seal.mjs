// lib/database-lifecycle/_seal.mjs
// Credential sealing for `sidekicks database offload`/`seal-init`/`--restore` — zero npm
// dependencies, node:crypto only.
//
// WHY SEALING, ON TOP OF THE COMMENT-OUT MECHANIC. A hook can deny a shell command; it cannot stop
// an agent that deliberately rewrites the text file itself (strip the `#[offloaded] ` prefix by
// hand, or just re-add a plaintext `password:` stub next to the parked entry). Commenting a line out
// only ever removed it from what the CONFIG READER sees — the bytes were always still sitting on
// disk, in the clear, for anything willing to read the raw file. Sealing closes that: the plaintext
// password never survives an offload. What is written to disk is ciphertext bound to the alias name,
// decryptable only with a private key that itself only ever exists decrypted in memory, for the
// duration of one `--restore`, after the user's own passphrase unlocked it.
//
// ECIES (the SEALED VALUE) — ephemeral-X25519 + HKDF-SHA256 + AES-256-GCM, AAD = the alias name:
//   1. `database seal-init` (TTY only) generates one X25519 keypair. The public key is written in
//      the clear; the private key's raw PKCS8 DER is WRAPPED (below) with the user's passphrase and
//      never itself touches disk unencrypted.
//   2. `database offload` needs ONLY the public key: it generates a fresh ephemeral X25519 keypair
//      per password, derives a shared secret via X25519(ephemeral_private, recipient_public), stretches
//      it through HKDF-SHA256 with the alias name as the `info` parameter (so ciphertext sealed for
//      one alias can never be swapped onto another and still authenticate), and seals the plaintext
//      with AES-256-GCM under that derived key, AAD = the same alias name. This needs no interactive
//      session, so an agent can still run `database offload` non-interactively.
//   3. `database offload --restore` needs the PRIVATE key: it prompts for the passphrase (hidden, at
//      an interactive TTY only — see `promptPassphrase` below), unwraps the private key, and for each
//      sealed value derives the SAME shared secret via X25519(recipient_private, ephemeral_public) —
//      X25519 is commutative, so both sides land on the same point — and reverses step 2. A wrong
//      passphrase fails to even unwrap the private key (AES-GCM refuses); a wrong/lost AAD (alias) or
//      a bit-flipped ciphertext fails the GCM tag check. Either way, nothing is written: the caller
//      builds every file's new text in memory before writing any of them.
//
// KEY-WRAPPING (the PRIVATE KEY AT REST) — scrypt(N=2^17, r=8, p=1, 16-byte salt) derives a 32-byte
// key from the passphrase; that key wraps the private key's raw PKCS8 DER with AES-256-GCM (a fresh
// 12-byte IV, its own auth tag). This is a hand-rolled wrap rather than Node's own PEM
// `privateKeyEncoding.cipher` option (PBKDF2-backed, far cheaper to brute-force per guess than
// scrypt) — scrypt's memory-hardness is the point: it is deliberately expensive to parallelize on
// commodity GPU/ASIC hardware, which a fixed-iteration PBKDF2 is not. `decryptPrivateKey` refuses
// outright (returns `null`, same signal as a wrong passphrase) when the stored record is not shaped
// like an encrypted wrap at all — there is no "read a plaintext private key" code path.
//
// The sealed marker `sealed:v1:<b64 epk>:<b64 iv>:<b64 tag>:<b64 ct>` carries no secret of its own —
// the ephemeral public key travels in the clear (that is the whole point of ECIES) — and reveals
// nothing about the plaintext without the recipient's private key and the correct alias.

import {
  generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman, hkdfSync,
  randomBytes, createCipheriv, createDecipheriv, createHash, scryptSync,
} from 'node:crypto';
import { existsSync, readFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { SidekicksError, EXIT_VALIDATION } from '../sk-cli/errors.mjs';
import { readBlock } from '../config-store/block.mjs';
import { ensureSecretIgnore } from '../config-store/write.mjs';
import { writeSecretAtomic, SECRET_FILE_MODE } from '../fs-safety/fsx.mjs';
import { CONFIG_DIR } from '../config-store/families.mjs';

/** The file this module owns outright, one per scope — never touched by `config-store`'s writer. */
export const SEAL_FILE = 'db-seal.secret.yaml';
/** The one block this file ever carries. */
const SEAL_BLOCK = 'db_seal';
/** Sealed-VALUE format tag (the `password:` ciphertext marker) — bumped only if THAT wire shape
 * ever changes; independent of the key-file wrapping scheme below. */
export const SEAL_VERSION = 'v1';
/** The literal prefix every sealed value starts with. */
export const SEAL_PREFIX = `sealed:${SEAL_VERSION}:`;

/** The private-key-at-rest wrapping scheme this module writes and reads. */
export const KEY_WRAP_ALGO = 'scrypt-aes-256-gcm-v1';
/** scrypt cost parameters — N=2^17 is the OWASP-recommended minimum for an interactive passphrase
 * as of this writing; deliberately memory-hard (~128 MiB), unlike a fixed-iteration PBKDF2. */
export const SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
/** scrypt's own memory footprint is ~`128 * N * r` bytes; Node's default 32 MiB `maxmem` cap is far
 * below that at these parameters, so it must be raised explicitly (with headroom) or every call
 * throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS regardless of how much RAM the machine actually has. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** A passphrase shorter than this is refused at `seal-init` time — long enough that the scrypt cost
 * above is not fighting a small, guessable keyspace. */
export const MIN_PASSPHRASE_LENGTH = 12;

/**
 * The repo-relative path to a scope's seal-key file.
 *
 * @param {string} base - `.sidekicks` or `projects/<active>` — the SAME base `resolveOffloadScope`
 *   resolves for `database_connector`, so the seal key always lives beside the config it protects.
 * @returns {string}
 */
export function sealKeyRelPath(base) {
  return join(base, CONFIG_DIR, SEAL_FILE);
}

/**
 * Read a scope's seal-key file, or `null` when it does not exist yet.
 *
 * @param {string} repoRoot
 * @param {string} base
 * @returns {{rel: string, publicKeyPem: string, wrapped: {saltB64: string, ivB64: string,
 *   tagB64: string, ctB64: string, n: number, r: number, p: number}|null,
 *   createdAt: string|null, createdBy: string|null}|null}
 */
export function readSealKeyFile(repoRoot, base) {
  const rel = sealKeyRelPath(base);
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) return null;
  const text = readFileSync(abs, 'utf8');
  const parsed = readBlock(text, SEAL_BLOCK);
  if (!parsed || !parsed.public_key_b64) return null;
  const fromB64Text = (b64) => Buffer.from(String(b64), 'base64').toString('utf8');
  const hasWrap = parsed.kdf_salt_b64 && parsed.wrap_iv_b64 && parsed.wrap_tag_b64
    && parsed.wrapped_private_key_b64;
  return {
    rel,
    publicKeyPem: fromB64Text(parsed.public_key_b64),
    wrapped: hasWrap
      ? {
        saltB64: String(parsed.kdf_salt_b64),
        ivB64: String(parsed.wrap_iv_b64),
        tagB64: String(parsed.wrap_tag_b64),
        ctB64: String(parsed.wrapped_private_key_b64),
        n: Number(parsed.kdf_n) || SCRYPT_N,
        r: Number(parsed.kdf_r) || SCRYPT_R,
        p: Number(parsed.kdf_p) || SCRYPT_P,
      }
      : null,
    createdAt: parsed.created_at != null ? String(parsed.created_at) : null,
    createdBy: parsed.created_by != null ? String(parsed.created_by) : null,
  };
}

/** Derive the 32-byte AES-256 key a passphrase unwraps/wraps the private key with. */
function deriveWrapKey(passphrase, salt, n, r, p) {
  return scryptSync(passphrase, salt, 32, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/**
 * Generate a fresh X25519 keypair and wrap its private key (raw PKCS8 DER) with a passphrase-
 * derived key — scrypt, then AES-256-GCM. Refuses a passphrase shorter than `MIN_PASSPHRASE_LENGTH`.
 *
 * @param {string} passphrase
 * @returns {{publicKeyPem: string, wrapped: {saltB64: string, ivB64: string, tagB64: string,
 *   ctB64: string, n: number, r: number, p: number}}} `wrapped` is the SAME shape
 *   `readSealKeyFile` hands back — base64-string fields throughout, never a raw `Buffer`.
 */
export function generateSealKeypair(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SidekicksError(
      `a sealing passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
      EXIT_VALIDATION
    );
  }
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const rawDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const salt = randomBytes(16);
  const key = deriveWrapKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(rawDer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  // Base64-string fields from the moment of generation, ON PURPOSE: this is the SAME shape
  // `readSealKeyFile` hands back after a write+read round trip, so `decryptPrivateKey` (and every
  // other consumer of a `wrapped` object) has exactly one shape to handle, never "raw buffers before
  // the first write, base64 strings after".
  return {
    publicKeyPem: publicKey,
    wrapped: {
      saltB64: b64(salt), ivB64: b64(iv), tagB64: b64(tag), ctB64: b64(ct),
      n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    },
  };
}

/**
 * Write a scope's seal-key file — mode 600 (via `writeSecretAtomic`), and covered by the SAME
 * `*.secret.yaml` git-ignore rule every other credential file in `config/` already relies on
 * (`ensureSecretIgnore` makes sure that rule exists, the same call `config set` makes before writing
 * a credential).
 *
 * @param {string} repoRoot
 * @param {string} base
 * @param {{publicKeyPem: string, wrapped: object, stamp: string, user: string}} args
 * @returns {{path: string}}
 */
export function writeSealKeyFile(repoRoot, base, { publicKeyPem, wrapped, stamp, user }) {
  const dirRel = join(base, CONFIG_DIR);
  ensureSecretIgnore(repoRoot, dirRel);
  const rel = sealKeyRelPath(base);
  const abs = join(repoRoot, rel);
  const toB64Text = (s) => Buffer.from(s, 'utf8').toString('base64');
  const lines = [
    '# db-seal.secret.yaml — GIT-IGNORED X25519 keypair for sealed database_connector passwords.',
    '#',
    '# The public key here seals a password on every `sidekicks database offload` — no passphrase',
    '# needed, so an agent can still offload non-interactively. The private key is wrapped at rest',
    `# (${KEY_WRAP_ALGO}: scrypt N=${SCRYPT_N} r=${SCRYPT_R} p=${SCRYPT_P}, then AES-256-GCM) and only`,
    '# ever gets unwrapped on `sidekicks database offload --restore`, at an interactive TTY, for the',
    '# duration of that one command.',
    '#',
    '# Regenerating this file (`database seal-init --force`) is refused while ANY password in this',
    '# scope is still sealed under the CURRENT key — restore those aliases first. Once regeneration',
    '# is allowed, the previous key is archived next to this file (`.bak`), never deleted outright.',
    `${SEAL_BLOCK}:`,
    `  algo: ${KEY_WRAP_ALGO}`,
    `  public_key_b64: "${toB64Text(publicKeyPem)}"`,
    '  kdf: scrypt',
    `  kdf_n: ${wrapped.n}`,
    `  kdf_r: ${wrapped.r}`,
    `  kdf_p: ${wrapped.p}`,
    `  kdf_salt_b64: "${wrapped.saltB64}"`,
    `  wrap_iv_b64: "${wrapped.ivB64}"`,
    `  wrap_tag_b64: "${wrapped.tagB64}"`,
    `  wrapped_private_key_b64: "${wrapped.ctB64}"`,
    `  created_at: ${stamp}`,
    `  created_by: "${String(user).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    '',
  ].join('\n');
  writeSecretAtomic(abs, lines);
  return { path: rel };
}

/**
 * Archive an existing seal-key file to a timestamped `.bak` sibling (mode 600), rather than
 * overwriting or deleting it outright — called only once the caller has already confirmed no
 * password in this scope is still sealed under it. Returns the archived path, or `null` when there
 * was nothing to archive.
 *
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} compactStamp - filesystem-safe (no `:`), e.g. `20260926-100000`
 * @returns {string|null}
 */
export function archiveSealKeyFile(repoRoot, base, compactStamp) {
  const rel = sealKeyRelPath(base);
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) return null;
  const archivedRel = `${rel}.${compactStamp}.bak`;
  const archivedAbs = join(repoRoot, archivedRel);
  renameSync(abs, archivedAbs);
  try { chmodSync(archivedAbs, SECRET_FILE_MODE); } catch { /* best-effort on platforms without chmod */ }
  return archivedRel;
}

/**
 * Unwrap a seal-key file's private key with a passphrase. Returns `null` — the SAME signal a wrong
 * passphrase produces — when `wrapped` is missing or is not shaped like an encrypted wrap at all
 * (every field this module itself ever writes present and well-formed): there is no code path that
 * reads a private key that was not encrypted. Also never throws for a wrong passphrase — AES-GCM's
 * own tag check failing is exactly that case.
 *
 * @param {{saltB64: string, ivB64: string, tagB64: string, ctB64: string, n: number, r: number,
 *   p: number}|null|undefined} wrapped
 * @param {string} passphrase
 * @returns {import('node:crypto').KeyObject|null}
 */
export function decryptPrivateKey(wrapped, passphrase) {
  if (!wrapped || !wrapped.saltB64 || !wrapped.ivB64 || !wrapped.tagB64 || !wrapped.ctB64) return null;
  if (!Number.isInteger(wrapped.n) || !Number.isInteger(wrapped.r) || !Number.isInteger(wrapped.p)) return null;
  try {
    const salt = Buffer.from(wrapped.saltB64, 'base64');
    const iv = Buffer.from(wrapped.ivB64, 'base64');
    const tag = Buffer.from(wrapped.tagB64, 'base64');
    const ct = Buffer.from(wrapped.ctB64, 'base64');
    const key = deriveWrapKey(passphrase, salt, wrapped.n, wrapped.r, wrapped.p);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const rawDer = Buffer.concat([decipher.update(ct), decipher.final()]);
    return createPrivateKey({ key: rawDer, format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
}

/** The sha256 fingerprint of a public key's SPKI DER encoding, first 16 hex characters — short
 * enough to sit inline in a `#[offloaded:meta]` line, long enough (64 bits) that two DIFFERENT keys
 * colliding is not a practical concern for this module's purpose (detecting a key ROTATION, not a
 * cryptographic identity proof). */
export function keyFingerprint(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** Is this string shaped like a value `sealValue` produced? (Format check only — not a MAC.) */
export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SEAL_PREFIX)
    && value.slice(SEAL_PREFIX.length).split(':').length === 4;
}

/**
 * Seal `plaintext` for one recipient, bound to `aad` (the alias name) — ephemeral X25519 + HKDF-
 * SHA256 + AES-256-GCM. Needs only the recipient's PUBLIC key.
 *
 * @param {string} recipientPublicKeyPem
 * @param {string} aad
 * @param {string} plaintext
 * @returns {string} `sealed:v1:<b64 epk>:<b64 iv>:<b64 tag>:<b64 ct>`
 */
export function sealValue(recipientPublicKeyPem, aad, plaintext) {
  const recipientPub = createPublicKey(recipientPublicKeyPem);
  const eph = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(aad, 'utf8'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  const epkDer = eph.publicKey.export({ type: 'spki', format: 'der' });
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  return `${SEAL_PREFIX}${b64(epkDer)}:${b64(iv)}:${b64(tag)}:${b64(ct)}`;
}

/**
 * Unseal a value `sealValue` produced. Needs the recipient's PRIVATE key (already unwrapped — see
 * `decryptPrivateKey`) and the SAME `aad` (alias) it was sealed with. Every failure mode — a wrong
 * alias, a corrupted ciphertext, a key that does not match the one it was sealed under — is folded
 * into one `SidekicksError`: node:crypto's own errors are never allowed to reach the CLI dispatcher
 * directly, since an un-wrapped `Error` prints a raw stack trace there instead of the single-line
 * message every OTHER failure in this verb produces.
 *
 * @param {import('node:crypto').KeyObject} recipientPrivateKey
 * @param {string} aad
 * @param {string} sealedString
 * @returns {string}
 */
export function unsealValue(recipientPrivateKey, aad, sealedString) {
  if (!isSealed(sealedString)) {
    throw new SidekicksError(
      `database offload --restore: '${aad}' carries a value that is not a recognised sealed format`,
      EXIT_VALIDATION
    );
  }
  try {
    const [epkB64, ivB64, tagB64, ctB64] = sealedString.slice(SEAL_PREFIX.length).split(':');
    const fromB64 = (s) => Buffer.from(s, 'base64');
    const epk = createPublicKey({ key: fromB64(epkB64), format: 'der', type: 'spki' });
    const shared = diffieHellman({ privateKey: recipientPrivateKey, publicKey: epk });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from(aad, 'utf8'), 32));
    const decipher = createDecipheriv('aes-256-gcm', key, fromB64(ivB64));
    decipher.setAuthTag(fromB64(tagB64));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    const pt = Buffer.concat([decipher.update(fromB64(ctB64)), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    if (err instanceof SidekicksError) throw err;
    throw new SidekicksError(
      `database offload --restore: failed to unseal '${aad}''s password — wrong passphrase, a `
      + 'corrupted value, or a key/alias mismatch',
      EXIT_VALIDATION
    );
  }
}

/**
 * Does ANY file in `scopeFiles` currently carry a sealed password value? Cheap (a literal substring
 * search) and deliberately never inspects the VALUE beyond that — `seal-init --force` uses this to
 * refuse regenerating the scope's key while it would leave an existing password permanently
 * unrecoverable.
 *
 * @param {string} repoRoot
 * @param {string[]} scopeFiles - repo-relative
 * @returns {boolean}
 */
export function scopeHasSealedValues(repoRoot, scopeFiles) {
  for (const rel of scopeFiles) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    if (text.includes(SEAL_PREFIX)) return true;
  }
  return false;
}

// ── passphrase entry — hidden at a real TTY; injectable for tests ──────────────────────────────

/**
 * Test-only override. Production code (`promptPassphrase`) always calls `readHiddenLine` UNLESS a
 * test has set `passphraseHook.read` — a module-level hook rather than a parameter, so `seal-init`
 * and `offload --restore` do not need to thread a test double through their whole call chain just to
 * make the one line that reads a terminal replaceable. Tests MUST reset this to `null` afterwards
 * (a `finally` block) — a hook left set would silently swallow a later, unrelated test's real prompt.
 *
 * @type {{read: null | ((promptText: string, stdinStream: object) => Promise<string>)}}
 */
export const passphraseHook = { read: null };

/**
 * Prompt for a passphrase. Delegates to `passphraseHook.read` when a test has set one; otherwise
 * reads one hidden line from a real, interactive TTY.
 *
 * @param {string} promptText
 * @param {NodeJS.ReadStream} [stdinStream]
 * @returns {Promise<string>}
 */
export async function promptPassphrase(promptText, stdinStream = process.stdin) {
  if (passphraseHook.read) return passphraseHook.read(promptText, stdinStream);
  return readHiddenLine(promptText, stdinStream);
}

/**
 * Read one line from an interactive TTY with the terminal's own echo suppressed (`setRawMode`,
 * supported by Node's tty streams on both macOS/Linux and Windows terminals) — a password prompt
 * with no dependency beyond node:tty's own stream API. Rejects immediately, before touching raw
 * mode, when `stdinStream` is not a TTY at all; every real caller already checks `.isTTY` up front
 * and refuses earlier with its own message, so this is a cheap extra guard, not the primary gate.
 *
 * Code-point safe: both the input scan (`for...of` over a `utf8`-decoded string already yields full
 * Unicode code points, never a lone surrogate half) and backspace (`[...input].slice(0, -1)`, NOT
 * `input.slice(0, -1)` — the latter drops only the trailing UTF-16 code UNIT, which would corrupt a
 * passphrase ending in an astral character such as an emoji by leaving an unpaired surrogate behind).
 *
 * @param {string} promptText
 * @param {NodeJS.ReadStream} stdinStream
 * @returns {Promise<string>}
 */
export function readHiddenLine(promptText, stdinStream = process.stdin) {
  return new Promise((resolve, reject) => {
    if (!stdinStream.isTTY) {
      reject(new Error('readHiddenLine: stdin is not an interactive TTY'));
      return;
    }
    process.stderr.write(promptText);
    const wasRaw = Boolean(stdinStream.isRaw);
    stdinStream.setRawMode(true);
    stdinStream.resume();
    stdinStream.setEncoding('utf8');
    let input = '';
    let settled = false;

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') { finish(false); return; }
        if (ch === '\u0003') { finish(true); return; } // Ctrl+C
        if (ch === '\u0008' || ch === '\u007f') { // backspace/DEL — drop the last CODE POINT
          input = [...input].slice(0, -1).join('');
          continue;
        }
        input += ch;
      }
    };
    const onEnd = () => {
      // stdin closed before a line terminator arrived — an incomplete read, not a valid (even
      // empty) answer. Distinct from Ctrl+C only in wording; both refuse rather than resolve.
      cleanup();
      if (!settled) { settled = true; reject(new Error('readHiddenLine: stdin closed before a passphrase was entered')); }
    };
    const onError = (err) => {
      cleanup();
      if (!settled) { settled = true; reject(err); }
    };

    function cleanup() {
      stdinStream.removeListener('data', onData);
      stdinStream.removeListener('end', onEnd);
      stdinStream.removeListener('error', onError);
      try { stdinStream.setRawMode(wasRaw); } catch { /* stream may not support raw mode */ }
      stdinStream.pause();
    }
    function finish(aborted) {
      if (settled) return;
      settled = true;
      cleanup();
      process.stderr.write('\n');
      if (aborted) reject(new Error('readHiddenLine: aborted'));
      else resolve(input);
    }
    stdinStream.on('data', onData);
    stdinStream.on('end', onEnd);
    stdinStream.on('error', onError);
  });
}
