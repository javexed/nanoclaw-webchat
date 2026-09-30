import { createHash, createPrivateKey, createPublicKey, sign } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { deflateRawSync } from 'zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get DATA_DIR() {
    return tmp;
  },
}));
const {
  SignatureRefused,
  checkReleaseSignature,
  decodeSignatureHeader,
  encodeSignatureHeader,
  isNewerVersion,
  parseReleaseKey,
  publishExtension,
  releaseMessage,
  signPublishedExtension,
  publishedExtensionPath,
  readExtensionManifest,
  versionFromVsixName,
  vsixExtensionId,
} = await import('./runner-extension.js');

/** A minimal zip (deflated entries), shaped the way vsce writes a VSIX. */
function zipOf(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-ext-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('served runner extension', () => {
  it('publishes a package, hashes it, and serves the manifest; a missing file makes the manifest void', () => {
    expect(readExtensionManifest()).toBeNull();
    const vsix = path.join(tmp, 'nanoclaw-0.7.3.vsix');
    fs.writeFileSync(vsix, 'PK pretend');
    const m = publishExtension(vsix);
    expect(m).toMatchObject({ version: '0.7.3', file: 'nanoclaw-0.7.3.vsix', size: 10 });
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readExtensionManifest()).toEqual(m);
    const served = publishedExtensionPath()!;
    expect(fs.readFileSync(served.filePath, 'utf8')).toBe('PK pretend');
    fs.rmSync(served.filePath);
    expect(readExtensionManifest()).toBeNull();
  });

  it('reads the version from the package name and compares versions numerically', () => {
    expect(versionFromVsixName('/x/nanoclaw-0.7.3.vsix')).toBe('0.7.3');
    expect(versionFromVsixName('other-1.0.0.vsix')).toBeNull();
    expect(isNewerVersion('0.7.3', '0.7.2')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.7.2', '0.7.2')).toBe(false);
    expect(isNewerVersion('0.7.1', '0.7.2')).toBe(false);
    expect(isNewerVersion('garbage', '0.7.2')).toBe(false);
  });

  it("records the package's own extension id, which the Connect link addresses", () => {
    const manifest =
      '<PackageManifest><Metadata><Identity Language="en-US" Id="nanoclaw" Version="0.13.3" Publisher="acme" /></Metadata></PackageManifest>';
    const vsix = path.join(tmp, 'nanoclaw-0.13.3.vsix');
    fs.writeFileSync(vsix, zipOf({ '[Content_Types].xml': '<Types/>', 'extension.vsixmanifest': manifest }));
    expect(publishExtension(vsix).id).toBe('acme.nanoclaw');
    expect(readExtensionManifest()?.id).toBe('acme.nanoclaw');
    expect(vsixExtensionId(Buffer.from('PK pretend'))).toBeNull();
    expect(vsixExtensionId(zipOf({ 'extension.vsixmanifest': '<Identity Id="x" Publisher="a b" />' }))).toBeNull();
  });
});

// The operator's signer lives in the overlay repo (vscode-extension/src/release-signing.ts);
// this signs the same way so central's checks meet real signatures.
function operatorKey(seedByte: number) {
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seedByte)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const key = `ed25519:${Buffer.from(spki.subarray(12)).toString('base64')}`;
  const signFacts = (f: { kind: 'vsix'; server: string; subject: string; sha256: string }) => ({
    format: 'nanoclaw-runner-release-signature/1',
    ...f,
    key,
    signature: sign(null, releaseMessage(f)!, priv).toString('base64'),
  });
  return { key, sign: signFacts };
}
const SERVER = 'https://chat.example.com';

describe('release signatures', () => {
  it("checks the extension's fixed vector: one message format on both sides", () => {
    const vector = {
      format: 'nanoclaw-runner-release-signature/1',
      kind: 'vsix',
      server: SERVER,
      subject: '1.2.3',
      sha256: 'a'.repeat(64),
      key: 'ed25519:6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=',
      signature: 'sTQsIkVH9ZDFScgb/8LjNkL6bvhh4WSPEaT6FiLqUoQ+TdYXtnw+R71CELhGQ4X0jupu6yBOizlPEV5NCz7tBw==',
    };
    expect(operatorKey(7).key).toBe(vector.key);
    expect(
      checkReleaseSignature(vector, { kind: 'vsix', subject: '1.2.3', sha256: 'a'.repeat(64) }, null),
    ).toMatchObject({ ok: true });
  });

  it('refuses a signature for other bytes, another release, the retired image kind, another key, or tampered', () => {
    const op = operatorKey(1);
    const facts = { kind: 'vsix' as const, server: SERVER, subject: '0.8.0', sha256: 'b'.repeat(64) };
    const sig = op.sign(facts);
    const expect_ = { kind: 'vsix' as const, subject: '0.8.0', sha256: 'b'.repeat(64) };
    expect(checkReleaseSignature(sig, expect_, op.key)).toMatchObject({ ok: true });
    expect(checkReleaseSignature(sig, { ...expect_, sha256: 'c'.repeat(64) }, null)).toMatchObject({
      error: expect.stringContaining('other bytes'),
    });
    expect(checkReleaseSignature(sig, { ...expect_, subject: '0.8.1' }, null)).toMatchObject({
      error: expect.stringContaining('0.8.0, not 0.8.1'),
    });
    // The agent image was a release kind once; its signatures are malformed now.
    expect(checkReleaseSignature({ ...sig, kind: 'image' }, expect_, null)).toMatchObject({
      error: expect.stringContaining('malformed'),
    });
    expect(checkReleaseSignature(sig, expect_, operatorKey(2).key)).toMatchObject({
      error: expect.stringContaining("install's release key"),
    });
    expect(checkReleaseSignature({ ...sig, server: 'https://other.example.com' }, expect_, null)).toMatchObject({
      error: 'that signature does not verify',
    });
    expect(checkReleaseSignature({ nope: 1 }, expect_, null)).toMatchObject({ ok: false });
    expect(parseReleaseKey(op.key)).toBe(op.key);
    expect(parseReleaseKey('ed25519:short')).toBeNull();
    expect(decodeSignatureHeader(encodeSignatureHeader(sig as never))).toEqual(sig);
    expect(decodeSignatureHeader('%%')).toBeNull();
    expect(decodeSignatureHeader(undefined)).toBeUndefined();
  });

  it('publishes a package with its signature, refuses a mismatched one without publishing, and attaches one later', () => {
    const op = operatorKey(3);
    const vsix = path.join(tmp, 'nanoclaw-0.9.0.vsix');
    fs.writeFileSync(vsix, 'PK signed');
    const sha256 = createHash('sha256').update('PK signed').digest('hex');
    const sig = op.sign({ kind: 'vsix', server: SERVER, subject: '0.9.0', sha256 });
    expect(publishExtension(vsix, undefined, sig, op.key).signature).toMatchObject({ key: op.key, subject: '0.9.0' });
    expect(readExtensionManifest()?.signature?.signature).toBe(sig.signature);

    const next = path.join(tmp, 'nanoclaw-0.9.1.vsix');
    fs.writeFileSync(next, 'PK other');
    expect(() => publishExtension(next, undefined, sig)).toThrow(SignatureRefused);
    expect(readExtensionManifest()?.version).toBe('0.9.0'); // nothing published

    // With a release key set, an unsigned package is refused outright.
    expect(() => publishExtension(next, undefined, undefined, op.key)).toThrow(/has a release key/);
    expect(readExtensionManifest()?.version).toBe('0.9.0');

    publishExtension(next);
    expect(readExtensionManifest()?.signature).toBeUndefined();
    expect(() => signPublishedExtension(sig, null)).toThrow(/0.9.0, not 0.9.1/);
    const good = op.sign({
      kind: 'vsix',
      server: SERVER,
      subject: '0.9.1',
      sha256: createHash('sha256').update('PK other').digest('hex'),
    });
    expect(signPublishedExtension(good, op.key).signature?.subject).toBe('0.9.1');
    expect(readExtensionManifest()?.signature?.subject).toBe('0.9.1');
  });
});
