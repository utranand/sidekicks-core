// lib/database-lifecycle/seal-init.mjs
// Implements `sidekicks database seal-init [--force] [--root]`.
//
// Generates the X25519 keypair `database offload` (public key only, non-interactive) and `database
// offload --restore` (private key, unwrapped at an interactive TTY) use to seal and unseal every
// parked alias's password. TTY only — the passphrase that wraps the private key is typed twice,
// hidden, and never touches argv, an environment variable, or a file.
//
// REGENERATING (`--force`) IS A KEY-SUBSTITUTION HAZARD, not a convenience flag: every password
// currently sealed under the scope's key would become permanently unreadable the moment a new key
// replaces it — there is no way back in without the OLD private key. So `--force` is refused
// outright while ANY file in this scope still carries a `sealed:v1:` value, no exceptions; only once
// every one of them has been restored does regeneration proceed, and even then the OLD key file is
// archived next to the new one (`.bak`, mode 600) rather than being overwritten or deleted.
//
// Zero npm dependencies — node:* + lib/ back-edges only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_VALIDATION, SidekicksError } from '../sk-cli/errors.mjs';
import {
  generateSealKeypair, writeSealKeyFile, archiveSealKeyFile, sealKeyRelPath, promptPassphrase,
  scopeHasSealedValues, MIN_PASSPHRASE_LENGTH,
} from './_seal.mjs';
import { formatBangkokIso, gitUserName, tokenizeOffloadArgv, resolveOffloadScope } from './_offload-shared.mjs';

/** A filesystem-safe stamp for a `.bak` filename — no `:`, which Windows paths refuse. */
function compactStamp(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(iso));
  if (!m) return String(Date.now());
  return `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}`;
}

/**
 * Execute the `database seal-init` verb.
 *
 * @param {{repoRoot: string, argv?: string[], _stdin?: object}} ctx
 * @returns {Promise<{stdout: string, exitCode: number}>}
 */
export async function run(ctx) {
  const { repoRoot } = ctx;
  const { flags } = tokenizeOffloadArgv(Array.isArray(ctx.argv) ? ctx.argv : []);
  const scope = resolveOffloadScope(repoRoot, flags);
  const force = Boolean(flags.force);

  const rel = sealKeyRelPath(scope.base);
  const abs = join(repoRoot, rel);
  const hadExisting = existsSync(abs);
  if (hadExisting && !force) {
    throw new SidekicksError(
      `database seal-init: '${rel}' already exists — pass --force to regenerate it. Every password `
      + 'already sealed under the OLD key becomes permanently unreadable once you do — restore those '
      + 'aliases first if you still need them live',
      EXIT_VALIDATION
    );
  }
  if (hadExisting && force && scopeHasSealedValues(repoRoot, scope.files)) {
    throw new SidekicksError(
      "database seal-init --force: refused — this scope still has one or more passwords sealed "
      + "under the CURRENT key. Restore those aliases first ('sidekicks database offload <alias> "
      + "--restore' for each, or 'sidekicks database offloaded' to see what is parked); regenerating "
      + 'the key now would make them permanently unrecoverable',
      EXIT_VALIDATION
    );
  }

  const stdinStream = ctx._stdin || process.stdin;
  if (!stdinStream.isTTY) {
    throw new SidekicksError(
      'database seal-init: refused — stdin is not an interactive TTY; run this in your own terminal',
      EXIT_VALIDATION
    );
  }

  const first = await promptPassphrase(
    'Set a passphrase to protect the sealing private key (never stored in the clear): ',
    stdinStream
  );
  if (!first) {
    throw new SidekicksError('database seal-init: an empty passphrase is refused', EXIT_VALIDATION);
  }
  if (first.length < MIN_PASSPHRASE_LENGTH) {
    throw new SidekicksError(
      `database seal-init: a passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
      EXIT_VALIDATION
    );
  }
  const second = await promptPassphrase('Type it again to confirm: ', stdinStream);
  if (first !== second) {
    throw new SidekicksError(
      'database seal-init: the two passphrases did not match — nothing written',
      EXIT_VALIDATION
    );
  }

  const { publicKeyPem, wrapped } = generateSealKeypair(first);
  const stamp = formatBangkokIso();
  const user = gitUserName(repoRoot);

  let archivedRel = null;
  if (hadExisting) {
    archivedRel = archiveSealKeyFile(repoRoot, scope.base, compactStamp(stamp));
  }
  const result = writeSealKeyFile(repoRoot, scope.base, { publicKeyPem, wrapped, stamp, user });

  const note = archivedRel
    ? `\nThe previous key was archived to ${archivedRel} rather than deleted. This scope had no `
      + 'password still sealed under it, so nothing here becomes unreadable — but a password sealed '
      + 'under it OUTSIDE this scope (a different project, a copy elsewhere) would only ever be '
      + 'restorable with that archived key, never this new one.'
    : '';

  return {
    stdout: `database seal-init: wrote ${result.path} (scope '${scope.projectName}')${note}\n`,
    exitCode: EXIT_OK,
  };
}
