/**
 * Served runner updates.
 *
 * Central keeps the current VS Code runner package and tells every runner the
 * version it should be on (in the welcome frame). The runner downloads it over
 * the same authenticated path it already uses, verifies the hash, and installs
 * it through VS Code's own command - no more passing .vsix files around.
 *
 * Publishing is an operator action on central: `scripts/publish-runner-extension.ts <vsix>`
 * (or the admin API later). The manifest is read per request so a publish
 * takes effect without a restart.
 *
 * Releases may carry the operator's signature (scripts/sign-runner-release.ts
 * in the overlay repo, run on the operator's machine with a key central never
 * holds). Central only checks that a signature is well formed, matches the
 * artifact it is attached to and is by the install's release key, then stores
 * and serves it; the extension is what verifies it against its pinned key.
 */
import { createHash, createPublicKey, verify } from 'crypto';
import fs from 'fs';
import path from 'path';
import { inflateRawSync } from 'zlib';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

export interface ExtensionManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  publishedAt: string;
  /**
   * The extension's id (`publisher.name`), read from the package itself: the
   * web app's Connect link addresses the extension by it, and an install may
   * package it under an id of its own (vscode-extension/scripts/package.mjs).
   */
  id?: string;
  /** The operator's signature over this package, when one was published with it or attached later. */
  signature?: ReleaseSignature;
}

// ── Release signatures ───────────────────────────────────────────────────
// The message format is vscode-extension/src/release-signing.ts's; the two
// test suites check the same fixed vector so they cannot drift apart.

export const SIGNATURE_FORMAT = 'nanoclaw-runner-release-signature/1';
/** The runner package; the agent image was the other kind, until the laptop container was retired. */
export type ReleaseKind = 'vsix';
export interface ReleaseSignature {
  format: string;
  kind: ReleaseKind;
  server: string;
  subject: string;
  sha256: string;
  key: string;
  signature: string;
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const HEX64 = /^[0-9a-f]{64}$/;

/** `ed25519:<base64 of 32 bytes>` in canonical form, or null. */
export function parseReleaseKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^ed25519:([A-Za-z0-9+/]{43}=?)$/.exec(raw.trim());
  if (!m) return null;
  const bytes = Buffer.from(m[1], 'base64');
  return bytes.length === 32 ? `ed25519:${bytes.toString('base64')}` : null;
}

function normalizeSubject(subject: string): string | null {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(subject) ? subject : null;
}

function normalizeServer(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The signed bytes, or null for facts that cannot have been signed. */
export function releaseMessage(f: {
  kind: ReleaseKind;
  server: string;
  subject: string;
  sha256: string;
}): Buffer | null {
  const server = normalizeServer(f.server);
  const subject = f.kind === 'vsix' ? normalizeSubject(f.subject) : null;
  const sha256 = f.sha256.toLowerCase();
  if (!server || !subject || !HEX64.test(sha256)) return null;
  return Buffer.from(
    [
      'nanoclaw-runner-release/1',
      `kind=${f.kind}`,
      `server=${server}`,
      `subject=${subject}`,
      `sha256=${sha256}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * A signature an admin hands central, checked before it is stored: well
 * formed, for this kind, subject (the version) and bytes, verifying
 * under the key it names, and — when the install names a release key — by
 * that key. The server it names is the extension's to check.
 */
export function checkReleaseSignature(
  raw: unknown,
  expect: { kind: ReleaseKind; subject: string; sha256: string },
  releaseKey: string | null,
): { ok: true; signature: ReleaseSignature } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!r || r.format !== SIGNATURE_FORMAT) return { ok: false, error: 'not a release signature file' };
  const key = parseReleaseKey(r.key);
  const kind = r.kind;
  const fields = ['server', 'subject', 'sha256', 'signature'] as const;
  if (!key || fields.some((k) => typeof r[k] !== 'string') || kind !== 'vsix')
    return { ok: false, error: 'the signature file is malformed' };
  const sig: ReleaseSignature = {
    format: SIGNATURE_FORMAT,
    kind,
    server: r.server as string,
    subject: r.subject as string,
    sha256: (r.sha256 as string).toLowerCase(),
    key,
    signature: r.signature as string,
  };
  if (sig.kind !== expect.kind)
    return { ok: false, error: `that signature is for a ${sig.kind}, not a ${expect.kind}` };
  if (normalizeSubject(sig.subject) !== normalizeSubject(expect.subject))
    return { ok: false, error: `that signature is for ${sig.subject}, not ${expect.subject}` };
  if (sig.sha256 !== expect.sha256.toLowerCase())
    return { ok: false, error: 'that signature is for other bytes than central serves' };
  if (releaseKey && key !== releaseKey)
    return { ok: false, error: "that signature is not by this install's release key" };
  const message = releaseMessage(sig);
  let good = false;
  try {
    const pub = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(key.slice('ed25519:'.length), 'base64')]),
      format: 'der',
      type: 'spki',
    });
    good = !!message && verify(null, message, pub, Buffer.from(sig.signature, 'base64'));
  } catch {
    good = false;
  }
  return good ? { ok: true, signature: sig } : { ok: false, error: 'that signature does not verify' };
}

/** A signature carried in a header (an upload's, a download's): base64 of its JSON. Undefined when absent. */
export function decodeSignatureHeader(value: string | string[] | undefined): unknown {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
export const encodeSignatureHeader = (sig: ReleaseSignature): string =>
  Buffer.from(JSON.stringify(sig)).toString('base64');

/** A signature checkReleaseSignature refused: the caller's mistake, not central's fault. */
export class SignatureRefused extends Error {}

export const extensionDir = (): string => path.join(DATA_DIR, 'runner-extension');
const manifestPath = (): string => path.join(extensionDir(), 'manifest.json');

export function readExtensionManifest(): ExtensionManifest | null {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as ExtensionManifest;
    if (!m || typeof m.version !== 'string' || typeof m.file !== 'string' || typeof m.sha256 !== 'string') return null;
    if (!fs.existsSync(path.join(extensionDir(), m.file))) return null;
    return m;
  } catch {
    return null;
  }
}

/** Absolute path of the published package, or null. */
export function publishedExtensionPath(): { manifest: ExtensionManifest; filePath: string } | null {
  const manifest = readExtensionManifest();
  if (!manifest) return null;
  return { manifest, filePath: path.join(extensionDir(), manifest.file) };
}

/** The version in `nanoclaw-<version>.vsix`, as vsce names packages. */
export function versionFromVsixName(file: string): string | null {
  const m = /^nanoclaw-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.vsix$/.exec(path.basename(file));
  return m ? m[1] : null;
}

/**
 * `publisher.name` from a VSIX's `extension.vsixmanifest`, or null for bytes
 * that are not a readable VSIX. A zip is read from its central directory; the
 * one entry needed is small, stored or deflated.
 */
export function vsixExtensionId(bytes: Buffer): string | null {
  try {
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return null;
    const count = bytes.readUInt16LE(eocd + 10);
    let at = bytes.readUInt32LE(eocd + 16);
    for (let i = 0; i < count && bytes.readUInt32LE(at) === 0x02014b50; i++) {
      const method = bytes.readUInt16LE(at + 10);
      const size = bytes.readUInt32LE(at + 20);
      const nameLen = bytes.readUInt16LE(at + 28);
      const extraLen = bytes.readUInt16LE(at + 30);
      const commentLen = bytes.readUInt16LE(at + 32);
      const local = bytes.readUInt32LE(at + 42);
      const name = bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8');
      at += 46 + nameLen + extraLen + commentLen;
      if (name !== 'extension.vsixmanifest') continue;
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const raw = bytes.subarray(start, start + size);
      const xml = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
      const identity = /<Identity\b[^>]*>/.exec(xml)?.[0] ?? '';
      const id = /\sId="([^"]+)"/.exec(identity)?.[1];
      const publisher = /\sPublisher="([^"]+)"/.exec(identity)?.[1];
      const full = id && publisher ? `${publisher}.${id}` : '';
      return /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/.test(full) ? full : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Copy a package into the served directory and point the manifest at it.
 * Older packages are kept for rollback. A signature, when given, must be for
 * exactly this package (SignatureRefused otherwise, and nothing is published).
 */
export function publishExtension(
  vsixPath: string,
  version?: string,
  signature?: unknown,
  releaseKey: string | null = null,
): ExtensionManifest {
  const v = version ?? versionFromVsixName(vsixPath);
  if (!v) throw new Error(`cannot tell the version from ${path.basename(vsixPath)}; pass it explicitly`);
  const bytes = fs.readFileSync(vsixPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let signed: ReleaseSignature | undefined;
  // With a release key set, laptops that pinned it refuse an unsigned package:
  // central does not serve one either.
  if (signature === undefined && releaseKey)
    throw new SignatureRefused(
      'this install has a release key: publish the package with its signature (the .sig beside it)',
    );
  if (signature !== undefined) {
    const checked = checkReleaseSignature(signature, { kind: 'vsix', subject: v, sha256 }, releaseKey);
    if (!checked.ok) throw new SignatureRefused(checked.error);
    signed = checked.signature;
  }
  const dir = extensionDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `nanoclaw-${v}.vsix`;
  fs.writeFileSync(path.join(dir, file), bytes);
  const manifest: ExtensionManifest = {
    version: v,
    file,
    sha256,
    size: bytes.length,
    publishedAt: new Date().toISOString(),
  };
  const id = vsixExtensionId(bytes);
  if (id) manifest.id = id;
  if (signed) manifest.signature = signed;
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2));
  log.info('Runner extension published', { version: v, id: manifest.id, size: bytes.length, signed: !!signed });
  return manifest;
}

/** Attach the operator's signature to the package central serves now. */
export function signPublishedExtension(signature: unknown, releaseKey: string | null): ExtensionManifest {
  const manifest = readExtensionManifest();
  if (!manifest) throw new SignatureRefused('no runner extension published');
  const checked = checkReleaseSignature(
    signature,
    { kind: 'vsix', subject: manifest.version, sha256: manifest.sha256 },
    releaseKey,
  );
  if (!checked.ok) throw new SignatureRefused(checked.error);
  const next: ExtensionManifest = { ...manifest, signature: checked.signature };
  fs.writeFileSync(manifestPath(), JSON.stringify(next, null, 2));
  log.info('Runner extension signature attached', { version: manifest.version });
  return next;
}

/** Semver-ish: is `a` newer than `b`? Only the three numbers count; malformed input is never "newer". */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d > 0;
  }
  return false;
}
