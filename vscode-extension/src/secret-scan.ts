// Content scan of the propose snapshot. Names catch `.env` and `id_rsa`; this
// catches a key pasted into `config.ts`. A file with a hit is left out of the
// agent's copy whole — never partly redacted: a redaction that misses one
// line is a leak, and a half file misleads the agent anyway.
//
// High-confidence patterns only (fixed prefixes, key blocks, a long quoted
// literal after a secret-like name): a false positive costs the agent a file,
// a noisy scan gets allow-listed wholesale.
import fs from 'node:fs';
import path from 'node:path';

import { matchesExclude } from './policy.js';

/** Files are read in chunks of this size, each overlapping the last so a token across the seam is still seen. */
export const SCAN_CHUNK_BYTES = 1024 * 1024;
const SCAN_OVERLAP_BYTES = 4 * 1024;
/** A NUL byte in this much of the head marks a binary file (unless it is UTF-16 text): copied without a scan. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Token shapes with a fixed prefix or frame. One pass over the text: the alternation of all of them. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/, // PEM, OpenSSH, PGP
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained token
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\b[sr]k_live_[A-Za-z0-9]{16,}/, // Stripe secret / restricted key
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/, // Google API key
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-proj-[A-Za-z0-9_-]{20,}/, // OpenAI project key
  /\bsk-[A-Za-z0-9]{48}\b/, // OpenAI legacy key
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm
];
const TOKENS = new RegExp(TOKEN_PATTERNS.map((r) => `(?:${r.source})`).join('|'));

/**
 * `apiKey: "…"`, `"password": "…"`, `SECRET = '…'`: a secret-like name given a
 * quoted literal of 16+ characters with no whitespace. The value is checked
 * apart (literalLooksReal) so references and placeholders do not count.
 */
const ASSIGNMENT = /(?:api[_-]?key|secret|token|password)['"]?\s*[:=]\s*(['"])([^'"\s]{16,})\1/gi;

/**
 * `password: hunter2hunter2hunter2`, `api.key=AbC…`: the same names given an
 * unquoted value, one per line. Only in configuration files (YAML,
 * .properties, INI, TOML, conf): in code an unquoted value is a variable.
 */
const UNQUOTED =
  /^[ \t]*[\w.-]*(?:api[_.-]?key|secret|token|password)[\w.-]*[ \t]*[:=][ \t]*([A-Za-z0-9_+/=.@-]{16,})[ \t]*(?:#.*)?$/gim;
const CONFIG_FILE = /\.(?:ya?ml|properties|ini|cfg|conf|toml)$/i;

/**
 * A literal, not a reference or a placeholder: not `${VAR}`, `{{ var }}`,
 * `<your-key>`, `%s`, `xxxx…` or `****…`, and mixing at least two of
 * lower case, upper case and digits.
 */
function literalLooksReal(v: string): boolean {
  if (/^[$<%{]/.test(v) || v.includes('${') || v.includes('{{') || /^(.)\1+$/.test(v)) return false;
  const kinds = Number(/[a-z]/.test(v)) + Number(/[A-Z]/.test(v)) + Number(/[0-9]/.test(v));
  return kinds >= 2;
}

/** Whether `text` holds a secret by the patterns above; `file` (its name) turns on the config-file ones. */
export function hasSecret(text: string, file = ''): boolean {
  if (TOKENS.test(text)) return true;
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) if (literalLooksReal(m[2])) return true;
  if (CONFIG_FILE.test(file)) {
    UNQUOTED.lastIndex = 0;
    for (let m = UNQUOTED.exec(text); m; m = UNQUOTED.exec(text)) if (literalLooksReal(m[1])) return true;
  }
  return false;
}

export type ScanVerdict = 'secret' | 'clean' | 'binary';

/**
 * UTF-16 text has a NUL in every other byte, so it looked binary and went
 * unscanned. A byte-order mark, or zeros at nearly all odd (LE) or even (BE)
 * offsets of the head, says it is text.
 */
export function utf16Of(head: Buffer): 'le' | 'be' | null {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'be';
  const pairs = Math.floor(head.length / 2);
  if (pairs < 8) return null;
  let oddZero = 0;
  let evenZero = 0;
  for (let i = 0; i < pairs * 2; i += 2) {
    if (head[i] === 0) evenZero++;
    if (head[i + 1] === 0) oddZero++;
  }
  if (oddZero >= pairs * 0.9 && evenZero <= pairs * 0.1) return 'le';
  if (evenZero >= pairs * 0.9 && oddZero <= pairs * 0.1) return 'be';
  return null;
}

/** One buffer for every read: a snapshot scans up to 150k files. */
let scratch: Buffer | null = null;

/** Scan one file, whole, chunk by chunk. */
export function scanFile(abs: string): { verdict: ScanVerdict; sig: string } {
  const fd = fs.openSync(abs, 'r');
  try {
    const st = fs.fstatSync(fd);
    const sig = `${st.size}:${st.mtimeMs}:${st.ino}`;
    scratch ??= Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let encoding: 'latin1' | 'le' | 'be' = 'latin1';
    for (let pos = 0; pos < st.size; ) {
      let n = 0;
      const want = Math.min(SCAN_CHUNK_BYTES, st.size - pos);
      while (n < want) {
        const got = fs.readSync(fd, scratch, n, want - n, pos + n);
        if (got === 0) break;
        n += got;
      }
      if (n === 0) break;
      if (pos === 0) {
        const head = scratch.subarray(0, Math.min(n, BINARY_SNIFF_BYTES));
        const wide = utf16Of(head);
        if (wide) encoding = wide;
        else if (head.includes(0)) return { verdict: 'binary', sig };
      }
      const chunk = scratch.subarray(0, n);
      // latin1: one char per byte, no decoding work; every pattern is ASCII.
      const text =
        encoding === 'latin1'
          ? chunk.toString('latin1')
          : (encoding === 'be' ? Buffer.from(chunk.subarray(0, n & ~1)).swap16() : chunk).toString('utf16le');
      if (hasSecret(text, abs)) return { verdict: 'secret', sig };
      if (pos + n >= st.size) break;
      // Step back a little (an even amount, for UTF-16) so a token on the seam is read whole.
      pos += Math.max(n - SCAN_OVERLAP_BYTES, 2) & ~1;
    }
    return { verdict: 'clean', sig };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Verdicts by absolute path and signature (size, mtime, inode), for this
 * extension host's life: a refresh re-reads only files that changed.
 */
const verdicts = new Map<string, { sig: string; verdict: ScanVerdict }>();

/**
 * Split a snapshot's file list into what is copied and what is left out.
 * `allow` holds globs (policy.ts matching) the developer vouches for: those
 * are copied whatever they hold. A file that cannot be read is left to the
 * copy, which reports it.
 */
export function leaveOutSecrets(
  root: string,
  files: readonly string[],
  allow: readonly string[] = [],
): { files: string[]; leftOut: string[] } {
  const kept: string[] = [];
  const leftOut: string[] = [];
  for (const rel of files) {
    if (allow.length && matchesExclude(rel, allow)) {
      kept.push(rel);
      continue;
    }
    const abs = path.join(root, rel);
    let verdict: ScanVerdict | undefined;
    try {
      const cached = verdicts.get(abs);
      if (cached) {
        const st = fs.statSync(abs);
        if (cached.sig === `${st.size}:${st.mtimeMs}:${st.ino}`) verdict = cached.verdict;
      }
      if (!verdict) {
        const scanned = scanFile(abs);
        verdicts.set(abs, scanned);
        verdict = scanned.verdict;
      }
    } catch {
      kept.push(rel);
      continue;
    }
    (verdict === 'secret' ? leftOut : kept).push(rel);
  }
  return { files: kept, leftOut };
}
