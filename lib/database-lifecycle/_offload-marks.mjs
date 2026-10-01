// lib/database-lifecycle/_offload-marks.mjs
// Pure text-level mechanic for `sidekicks database offload` v2 (comment-out parking).
//
// A parked alias is never moved to a second block — every one of its own lines (the header line
// through its last deeper-indented line, blank lines inside the range included) gets a column-0
// `#[offloaded] ` marker (bare `#[offloaded]`, no trailing space, for an originally-blank line —
// trailing whitespace on an empty line is exactly what an editor's save-time trim silently eats),
// preceded by one `#[offloaded:meta] <stamp> by <user>[: <reason>]` line.
// Every reader in this repo already skips a `#`-prefixed line at ANY indent
// (lib/config-store/block.mjs `parseRegion`/`readBlock`, `lib/config-store/write.mjs`
// `findBlockBody`), so a parked alias is simply UNKNOWN everywhere — no deny-list, no twin block,
// nothing to reveal. `uncommentEntry` is the exact inverse: strip the meta line, strip the prefix
// from what follows, and the file is byte-identical to what it was before the offload.
//
// `commentEntry`/`uncommentEntry` act on every occurrence of a duplicated key inside the given
// block — a duplicate alias is a tolerated, documented defect in at least one live scope, and this
// module preserves that count round-trip.
//
// `listOffloaded` is dependency-light and pure (no fs, no repoRoot) ON PURPOSE: the safety hook
// dynamic-imports it to check a would-be connection against every currently-parked target, and a
// hook must load fast and never touch anything beyond the text it was handed.
//
// Zero npm dependencies — no imports at all.

/**
 * Column-0 marker written on every line of a parked entry. A NON-blank original line becomes
 * `OFFLOAD_MARK + ' ' + line`; a blank original line becomes the bare marker with NOTHING after it
 * (no trailing space) — trailing whitespace on an otherwise-empty line is exactly the kind of thing
 * an editor's "trim trailing whitespace on save" silently eats, which would have made a blank line
 * inside a parked entry unrestorable. Every parser therefore accepts either shape:
 * `^#\[offloaded\](?: |$)`.
 */
export const OFFLOAD_MARK = '#[offloaded]';
/** Column-0 prefix of the one annotation line written directly above a parked entry. */
export const OFFLOAD_META_PREFIX = '#[offloaded:meta] ';

/** Recognise an `OFFLOAD_MARK`-marked line (a parked entry's own, now-commented, line) — bare or
 * followed by a space and the rest of the original line. */
const MARK_RE = /^#\[offloaded\](?: |$)/;
/**
 * Recognise + parse a `#[offloaded:meta] <stamp> by <user> key=<fp>[: <reason>]` line. `key=<fp>`
 * (the sealing public key's fingerprint, `lib/database-lifecycle/_seal.mjs` keyFingerprint — 16
 * lowercase hex characters) is a fixed, unambiguous token, so `user` is captured as "everything up
 * to ` key=`" rather than "everything up to the first colon" — a reason may still contain colons
 * freely, and a user name containing one no longer confuses the split.
 */
const META_RE = /^#\[offloaded:meta\] (\S+) by (.+?) key=([0-9a-f]{16})(?::\s*(.*))?$/;

/** Recognised per-entry fields `listOffloaded` extracts from a parked entry's own body lines. */
const ENTRY_FIELDS = ['host', 'port', 'dbname', 'cluster', 'db_name'];

// ── map-entry scanning — ported from v1 lib/config-store/write.mjs, trimmed ────────────────────
// (cutMapEntry/appendMapEntry and the position-anchor bookkeeping they existed for are NOT ported:
// v2 never moves an entry's lines to a second block, so there is nothing to reinsert "after".)

/**
 * A mapping block's raw body span within pre-split `lines`: the header's next line up to the first
 * column-0, non-comment line — a column-0 COMMENT belongs to the block that FOLLOWS it, never to
 * this one's tail, so it is skipped over rather than treated as a boundary. This is what lets a
 * `#[offloaded]`-marked run sit ANYWHERE inside a block (including its own tail) without truncating
 * the scan that finds the block's true extent.
 *
 * A header carrying an EMPTY inline mapping (`block: {}`) is scanned forward the SAME way as an
 * ordinary multi-line body, rather than short-circuited to "no body" — a block emptied of every
 * LIVE entry (because all of them are parked) still carries its parked runs as trailing lines, and
 * those must stay reachable by `commentEntry`/`uncommentEntry`/`listOffloaded` for that block. Only
 * a genuine SCALAR value (`block: something-else`) short-circuits: that is not a mapping at all, and
 * no line below it can belong to this block.
 *
 * @param {string[]} lines
 * @param {string} block
 * @returns {{headerIndex: number, bodyStart: number, bodyEnd: number, inline: string}|null}
 */
function findBlockBody(lines, block) {
  const headerRe = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline !== '' && inline !== '{}' && !inline.startsWith('#')) {
      return { headerIndex: i, bodyStart: i + 1, bodyEnd: i + 1, inline };
    }
    let end = i + 1;
    for (; end < lines.length; end++) {
      const line = lines[end];
      if (line.trim() === '') continue;
      if (/^\S/.test(line)) {
        if (line.startsWith('#')) continue; // a column-0 comment belongs to the NEXT block
        break;
      }
    }
    return { headerIndex: i, bodyStart: i + 1, bodyEnd: end, inline };
  }
  return null;
}

/**
 * Every top-level mapping-key entry directly inside a block's body, as raw line ranges — the same
 * indentation/comment-skipping rules `parseRegion` uses to read the block back, so an entry found
 * here is exactly what that parser would hand a caller as one value. A key appearing more than once
 * (a tolerated, documented defect in at least one live scope) produces more than one entry, in file
 * order.
 *
 * @param {string[]} lines
 * @param {number} bodyStart
 * @param {number} bodyEnd
 * @returns {{childIndent: number, entries: Array<{key: string, start: number, end: number}>}}
 */
function scanMapEntries(lines, bodyStart, bodyEnd) {
  let childIndent = null;
  for (let i = bodyStart; i < bodyEnd; i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('#')) continue;
    childIndent = lines[i].length - lines[i].trimStart().length;
    break;
  }
  if (childIndent === null) return { childIndent: 0, entries: [] };

  const entries = [];
  let i = bodyStart;
  while (i < bodyEnd) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) { i++; continue; }
    const indent = line.length - line.trimStart().length;
    if (indent !== childIndent) { i++; continue; } // a stray deeper/shallower line — not an entry
    const m = trimmed.match(/^([^:]+):(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1].trim().replace(/^['"]|['"]$/g, '');
    let end = i + 1;
    for (; end < bodyEnd; end++) {
      const l = lines[end];
      if (l.trim() === '') continue;
      const li = l.length - l.trimStart().length;
      if (li <= childIndent) break;
    }
    // Trailing blank lines belong BETWEEN entries, not to this one's own extent.
    let realEnd = end;
    while (realEnd > i + 1 && lines[realEnd - 1].trim() === '') realEnd--;
    entries.push({ key, start: i, end: realEnd });
    i = end;
  }
  return { childIndent, entries };
}

// ── the mechanic ─────────────────────────────────────────────────────────────────────────────────

/** Split preserving the file's own EOL convention (CRLF or bare LF); never pops or adds a line. */
function splitPreserving(text) {
  const crlf = /\r\n/.test(text);
  const eol = crlf ? '\r\n' : '\n';
  return { lines: text.replace(/\r\n?/g, '\n').split('\n'), eol };
}

/**
 * Build the one meta line written directly above a parked entry.
 *
 * @param {string} stamp
 * @param {string} user
 * @param {string} keyFingerprint - the sealing public key's fingerprint at the moment of offload
 *   (`lib/database-lifecycle/_seal.mjs` `keyFingerprint`) — recorded even for an alias with no
 *   password to seal, so a later offload/restore can detect a key rotation either way.
 * @param {string} [reason]
 * @returns {string}
 */
export function buildOffloadMetaLine(stamp, user, keyFingerprint, reason = '') {
  return `${OFFLOAD_META_PREFIX}${stamp} by ${user} key=${keyFingerprint}${reason ? `: ${reason}` : ''}`;
}

/** Mark one original (already-transformed, if `opts.transformLine` ran) line: bare for blank. */
function markLine(line) {
  return line === '' ? OFFLOAD_MARK : `${OFFLOAD_MARK} ${line}`;
}

/** The inverse of `markLine`: strip the marker, bare or followed by a space + the rest. */
function stripMark(line) {
  if (line === OFFLOAD_MARK) return '';
  return line.slice(OFFLOAD_MARK.length + 1);
}

/**
 * Comment out EVERY occurrence of `key` inside block `block`'s body, in place. Each occurrence gets
 * its own meta line directly above it. Everything else in the file — other entries, comments,
 * blank-line layout, CRLF — is untouched byte-for-byte.
 *
 * @param {string} text
 * @param {string} block
 * @param {string} key
 * @param {{stamp: string, user: string, keyFingerprint: string, reason?: string}} meta
 * @param {{transformLine?: (line: string) => string}} [opts] - `transformLine`, when given, runs on
 *   every ORIGINAL line of the entry before it is marked — `database offload` uses this to seal a
 *   `password:` line's value in place, so the marker mechanic and the sealing mechanic each stay a
 *   single, independent pass over the same lines rather than two separate line-range rewrites that
 *   could disagree about which lines belong to the entry.
 * @returns {{found: boolean, text: string, count: number}}
 */
export function commentEntry(text, block, key, meta, opts = {}) {
  const { lines, eol } = splitPreserving(text);
  const found = findBlockBody(lines, block);
  if (!found) return { found: false, text, count: 0 };

  const { entries } = scanMapEntries(lines, found.bodyStart, found.bodyEnd);
  const matches = entries.filter((e) => e.key === key);
  if (!matches.length) return { found: false, text, count: 0 };

  const metaLine = buildOffloadMetaLine(meta.stamp, meta.user, meta.keyFingerprint, meta.reason);

  // Bottom-up, so earlier match indices stay valid as later ones are spliced.
  const out = [...lines];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const original = out.slice(m.start, m.end);
    const transformed = opts.transformLine ? original.map(opts.transformLine) : original;
    const prefixed = transformed.map(markLine);
    out.splice(m.start, m.end - m.start, metaLine, ...prefixed);
  }
  return { found: true, text: out.join(eol), count: matches.length };
}

/**
 * A READ-ONLY companion to `commentEntry`: every occurrence of `key` inside block `block`'s body, as
 * its own raw lines, each tagged with its 1-based line number in `text` — for a caller that needs to
 * inspect an entry's own content BEFORE deciding whether it is safe to touch at all. `database
 * offload` uses this to refuse sealing a `password:` shape it cannot safely rewrite (a block scalar,
 * a flow mapping, an anchor/alias, an unterminated quote) — naming the file and line, never the
 * value — before anything is written anywhere.
 *
 * @param {string} text
 * @param {string} block
 * @param {string} key
 * @returns {Array<{lines: Array<{line: string, lineNumber: number}>}>}
 */
export function entryLinesFor(text, block, key) {
  const { lines } = splitPreserving(text);
  const found = findBlockBody(lines, block);
  if (!found) return [];
  const { entries } = scanMapEntries(lines, found.bodyStart, found.bodyEnd);
  return entries
    .filter((e) => e.key === key)
    .map((m) => ({
      lines: lines.slice(m.start, m.end).map((line, i) => ({ line, lineNumber: m.start + i + 1 })),
    }));
}

/**
 * The inverse of `commentEntry`: restore EVERY parked run for `key` inside block `block`'s (full,
 * comment-inclusive) extent — drop its meta line, strip the marker from what follows. A pure
 * offload → restore round trip on an otherwise-untouched file reproduces the original text
 * byte-for-byte.
 *
 * @param {string} text
 * @param {string} block
 * @param {string} key
 * @param {{transformLine?: (line: string) => string}} [opts] - `transformLine`, when given, runs on
 *   every line AFTER the marker is stripped, before it is written back — `database offload
 *   --restore` uses this to unseal a `password:` line's value. Any error it throws (a wrong
 *   passphrase, a corrupted ciphertext) propagates out of this call unmodified, before this
 *   function has produced any output — the caller builds every file's new text in memory first and
 *   writes only afterwards, so a thrown unseal error means nothing was written anywhere.
 * @returns {{found: boolean, text: string, count: number}}
 */
export function uncommentEntry(text, block, key, opts = {}) {
  const { lines, eol } = splitPreserving(text);
  const found = findBlockBody(lines, block);
  if (!found) return { found: false, text, count: 0 };

  const out = [];
  let count = 0;
  let i = 0;
  while (i < lines.length) {
    if (i >= found.bodyStart && i < found.bodyEnd) {
      const metaMatch = META_RE.exec(lines[i]);
      if (metaMatch) {
        let j = i + 1;
        const body = [];
        while (j < found.bodyEnd && MARK_RE.test(lines[j])) {
          body.push(stripMark(lines[j]));
          j++;
        }
        const alias = aliasOfEntryBody(body);
        if (alias === key) {
          const restored = opts.transformLine ? body.map(opts.transformLine) : body;
          out.push(...restored);
          count++;
          i = j;
          continue;
        }
      }
    }
    out.push(lines[i]);
    i++;
  }
  if (!count) return { found: false, text, count: 0 };

  // A block emptied down to `block: {}` by every LIVE entry having been offloaded stays readable
  // (a parked run keeps it discoverable by this module — see findBlockBody above), but
  // `lib/config-store/block.mjs` `readBlock` treats a literal inline `{}` as authoritative and never
  // looks past it: restoring an entry BEHIND that header would put live content the config reader
  // can never reach. The header's own line index is stable across this rewrite — it sits before
  // `found.bodyStart`, so no restoration (which only ever touches lines at or after that point) can
  // have shifted it.
  if (found.inline === '{}') {
    out[found.headerIndex] = out[found.headerIndex].replace(/\s*\{\}\s*$/, '');
  }
  return { found: true, text: out.join(eol), count };
}

/** The alias name off a parked entry's own (already-dedented) first line, or null. */
function aliasOfEntryBody(body) {
  if (!body.length) return null;
  const headerLine = body[0].trim();
  const m = headerLine.match(/^([^:]+):/);
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Every offloaded entry recorded anywhere in `text`, tagged with the top-level block it sits under.
 * Committed files carry `host`/`dbname` (and, for a Teleport target, `cluster`/`db_name`) in the
 * clear, so this never needs to read a secret file to answer "what is parked".
 *
 * PURE — no fs, no repoRoot: the safety hook dynamic-imports this function alone and must stay
 * dependency-light.
 *
 * @param {string} text
 * @returns {Array<{block: string, alias: string, host: string, port: string, dbname: string,
 *   cluster: string, db_name: string, stamp: string, user: string, key_fingerprint: string,
 *   reason: string}>}
 */
export function listOffloaded(text) {
  const { lines } = splitPreserving(text);
  const HEADER_RE = /^([^\s#][^:]*):(.*)$/;
  const results = [];
  let currentBlock = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    if (line.startsWith('#')) {
      const metaMatch = META_RE.exec(line);
      if (metaMatch) {
        let j = i + 1;
        const body = [];
        while (j < lines.length && MARK_RE.test(lines[j])) {
          body.push(stripMark(lines[j]));
          j++;
        }
        const alias = aliasOfEntryBody(body);
        if (alias !== null && currentBlock) {
          results.push(buildOffloadedRecord(currentBlock, alias, body, metaMatch));
        }
        i = j;
        continue;
      }
      i++;
      continue;
    }
    if (/^\S/.test(line)) {
      const m = HEADER_RE.exec(line);
      currentBlock = m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
    }
    i++;
  }
  return results;
}

/** Assemble one `listOffloaded` record from a parked entry's block name, alias and raw body. */
function buildOffloadedRecord(block, alias, body, metaMatch) {
  const fields = { host: '', port: '', dbname: '', cluster: '', db_name: '' };
  for (const raw of body.slice(1)) {
    const t = raw.trim();
    const km = t.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!km) continue;
    if (ENTRY_FIELDS.includes(km[1])) {
      fields[km[1]] = km[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  const [, stamp, user, keyFingerprint, reason] = metaMatch;
  return {
    block, alias, ...fields, stamp, user: user.trim(), key_fingerprint: keyFingerprint,
    reason: reason ? reason.trim() : '',
  };
}

/**
 * The (possibly several) contiguous `#[offloaded…]` marker runs sitting inside a raw line range —
 * used by `lib/config-store/write.mjs` `upsertBlock` to collect a block's parked entries BEFORE its
 * body is re-rendered from a parsed value (which would otherwise silently drop them, since a parked
 * entry is invisible to the parser that built that value), so they can be re-appended verbatim.
 *
 * @param {string[]} lines - the FULL file, already split
 * @param {number} start - inclusive
 * @param {number} end - exclusive
 * @returns {string[][]} each element is one run's raw lines, meta line first
 */
export function collectOffloadRuns(lines, start, end) {
  const runs = [];
  let i = start;
  while (i < end) {
    if (META_RE.test(lines[i])) {
      const run = [lines[i]];
      let j = i + 1;
      while (j < end && MARK_RE.test(lines[j])) { run.push(lines[j]); j++; }
      if (run.length > 1) { runs.push(run); i = j; continue; }
    }
    i++;
  }
  return runs;
}
