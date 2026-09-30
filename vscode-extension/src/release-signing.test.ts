import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  decidePin,
  decodeSignatureHeader,
  generateReleaseKey,
  keyFingerprint,
  parsePublicKey,
  parseSignature,
  pinFor,
  releaseMessage,
  releaseOrigin,
  releaseTrust,
  signRelease,
  verifyRelease,
  type ReleaseFacts,
} from './release-signing.js';

// A fixed key and signature: central's copy of the message format
// (runner-extension.ts on central) checks the same vector.
const VECTOR = {
  // The Ed25519 key whose 32-byte seed is all 0x07, as PKCS#8.
  pem: String(
    createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
      format: 'der',
      type: 'pkcs8',
    }).export({ format: 'pem', type: 'pkcs8' }),
  ),
  key: 'ed25519:6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=',
  signature: 'sTQsIkVH9ZDFScgb/8LjNkL6bvhh4WSPEaT6FiLqUoQ+TdYXtnw+R71CELhGQ4X0jupu6yBOizlPEV5NCz7tBw==',
};
const facts: ReleaseFacts = {
  kind: 'vsix',
  server: 'https://chat.example.com',
  subject: '1.2.3',
  sha256: 'a'.repeat(64),
};

describe('release signatures', () => {
  it('signs the fixed vector as central expects', () => {
    const sig = signRelease({ ...facts, server: 'https://chat.example.com/' }, VECTOR.pem);
    expect(sig.key).toBe(VECTOR.key);
    expect(sig.signature).toBe(VECTOR.signature);
    expect(sig.server).toBe('https://chat.example.com');
    expect(releaseMessage(facts).toString()).toBe(
      `nanoclaw-runner-release/1\nkind=vsix\nserver=https://chat.example.com\nsubject=1.2.3\nsha256=${'a'.repeat(64)}\n`,
    );
  });

  it('verifies a good signature', () => {
    const { privatePem, publicKey } = generateReleaseKey();
    const sig = signRelease(facts, privatePem);
    expect(verifyRelease(sig, facts, publicKey)).toBeNull();
    // Served in a header, as base64 JSON.
    const header = Buffer.from(JSON.stringify(sig)).toString('base64');
    expect(verifyRelease(decodeSignatureHeader(header), facts, publicKey)).toBeNull();
  });

  it('refuses a tampered artifact, a tampered signature file, and no signature', () => {
    const { privatePem, publicKey } = generateReleaseKey();
    const sig = signRelease(facts, privatePem);
    expect(verifyRelease(sig, { ...facts, sha256: 'b'.repeat(64) }, publicKey)).toContain('other bytes');
    // The file edited to match the tampered bytes: the signature no longer verifies.
    expect(verifyRelease({ ...sig, sha256: 'b'.repeat(64) }, { ...facts, sha256: 'b'.repeat(64) }, publicKey)).toBe(
      'its signature does not verify',
    );
    expect(verifyRelease(null, facts, publicKey)).toContain('no signature');
    expect(verifyRelease({ ...sig, signature: 'x' }, facts, publicKey)).toContain('malformed');
    expect(verifyRelease(decodeSignatureHeader('%%%'), facts, publicKey)).toContain('no signature');
  });

  it('refuses a signature by another key', () => {
    const pinned = generateReleaseKey().publicKey;
    const sig = signRelease(facts, generateReleaseKey().privatePem);
    expect(verifyRelease(sig, facts, pinned)).toContain(`not the pinned ${keyFingerprint(pinned)}`);
    // Claiming the pinned key does not help: the signature is checked against it.
    expect(verifyRelease({ ...sig, key: pinned }, facts, pinned)).toBe('its signature does not verify');
  });

  it('refuses a signature replayed for another install or release, and any kind but the package', () => {
    const { privatePem, publicKey } = generateReleaseKey();
    const sig = signRelease(facts, privatePem);
    expect(verifyRelease(sig, facts, publicKey)).toBeNull();
    expect(verifyRelease(sig, { ...facts, server: 'https://other.example.com' }, publicKey)).toContain(
      'not https://other.example.com',
    );
    expect(verifyRelease(sig, { ...facts, subject: '9.9.9' }, publicKey)).toContain('its signature is for');
    // The agent image was signed too, once; such a signature is no longer a release.
    expect(parseSignature({ ...sig, kind: 'image' })).toBeNull();
  });

  it('accepts only canonical Ed25519 public keys', () => {
    expect(parsePublicKey(VECTOR.key)).toBe(VECTOR.key);
    expect(parsePublicKey(` ${VECTOR.key} `)).toBe(VECTOR.key);
    expect(parsePublicKey('ed25519:AAAA')).toBeNull();
    expect(parsePublicKey('rsa:' + VECTOR.key.slice(8))).toBeNull();
    expect(parsePublicKey(42)).toBeNull();
    expect(keyFingerprint(VECTOR.key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe('pinning', () => {
  const a = generateReleaseKey().publicKey;
  const b = generateReleaseKey().publicKey;
  it('asks before the first pin, stays quiet on the same key, asks again on a different one', () => {
    expect(decidePin(null, a)).toEqual({ action: 'confirm-first', key: a });
    expect(decidePin(a, a)).toEqual({ action: 'none' });
    expect(decidePin(a, b)).toEqual({ action: 'confirm-change', from: a, to: b });
  });
  it('an offer of nothing never unpins', () => {
    expect(decidePin(a, null)).toEqual({ action: 'none' });
    expect(decidePin(null, null)).toEqual({ action: 'none' });
  });
});

describe('trust per install', () => {
  const a = generateReleaseKey().publicKey;
  const b = generateReleaseKey().publicKey;
  const trust = (over: Partial<Parameters<typeof releaseTrust>[0]>) =>
    releaseTrust({ own: null, pins: {}, declined: {}, serverUrl: 'https://central.example.test', ...over });

  it('belongs to the origin: a path on the server URL is the same install', () => {
    expect(releaseOrigin('https://central.example.test/x/y?z')).toBe('https://central.example.test');
    expect(releaseOrigin('not a url')).toBeNull();
    const pins = { 'https://central.example.test': a };
    expect(trust({ pins, serverUrl: 'https://central.example.test/x' })).toEqual({ verifyWith: a });
    expect(trust({ pins, serverUrl: 'https://other.example.test' })).toEqual({ unsigned: true });
  });

  it('finds a pin stored under a URL with a path (before pins were per origin)', () => {
    expect(pinFor({ 'https://central.example.test/old': a }, 'https://central.example.test')).toBe(a);
    expect(trust({ pins: { 'https://central.example.test/old': a } })).toEqual({ verifyWith: a });
  });

  it("the developer's own key wins; a declined key refuses; only a server with none is unsigned", () => {
    expect(trust({ own: b, pins: { 'https://central.example.test': a } })).toEqual({ verifyWith: b });
    expect(trust({ declined: { 'https://central.example.test': a } })).toEqual({
      refuse: expect.stringContaining('which you did not trust'),
    });
    expect(trust({})).toEqual({ unsigned: true });
  });
});
