// Signed releases: the runner package is signed by the operator with an
// Ed25519 key that never goes to central. Central only
// stores and serves the signature; this verifies it against a key pinned per
// server, so a compromised central cannot hand every laptop code of its own.
//
// The signed message is built from what the verifier EXPECTS (its own server
// URL, the kind of artifact, the version it asked for, the hash of
// the bytes it has), never from the fields in the signature file, so a
// signature for one install, kind or release does not verify for another.
//
// Plain erasable TypeScript with no local imports: scripts/sign-runner-release.ts
// (the operator's signer) imports this file directly, so there is one
// definition of the message.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const SIGNATURE_FORMAT = 'nanoclaw-runner-release-signature/1';
const MESSAGE_HEADER = 'nanoclaw-runner-release/1';

/** The runner package. (The agent image was the other kind, until the laptop container was retired.) */
export type ReleaseKind = 'vsix';

/** What a signature vouches for. */
export interface ReleaseFacts {
  kind: ReleaseKind;
  /** The install's URL, as the extension has it (nanoclaw.serverUrl). */
  server: string;
  /** The package's version. */
  subject: string;
  /** sha256 of the .vsix. */
  sha256: string;
}

/** The detached signature file (`<artifact>.sig`), as the signer writes it and central serves it. */
export interface ReleaseSignature extends ReleaseFacts {
  format: string;
  /** The signing key's public half, `ed25519:<base64>`. */
  key: string;
  /** Ed25519 over releaseMessage(facts), base64. */
  signature: string;
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** `https://host[:port][/path]` without a trailing slash, or null. */
export function normalizeServer(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

function normalizeSubject(subject: string): string | null {
  return VERSION.test(subject) ? subject : null;
}

/** The bytes that are signed. Throws on facts that cannot be signed (the signer's input, or a verifier's bug). */
export function releaseMessage(f: ReleaseFacts): Buffer {
  const server = normalizeServer(f.server);
  const subject = normalizeSubject(f.subject);
  const sha256 = f.sha256.toLowerCase();
  if (f.kind !== 'vsix') throw new Error(`unknown kind ${String(f.kind)}`);
  if (!server) throw new Error(`not a server URL: ${f.server}`);
  if (!subject) throw new Error(`not a version: ${f.subject}`);
  if (!HEX64.test(sha256)) throw new Error('sha256 is not a hex digest');
  return Buffer.from(
    [MESSAGE_HEADER, `kind=${f.kind}`, `server=${server}`, `subject=${subject}`, `sha256=${sha256}`, ''].join('\n'),
    'utf8',
  );
}

/** `ed25519:<base64 of the 32-byte key>` in canonical form, or null for anything else. */
export function parsePublicKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^ed25519:([A-Za-z0-9+/]{43}=?)$/.exec(raw.trim());
  if (!m) return null;
  const bytes = Buffer.from(m[1], 'base64');
  return bytes.length === 32 ? `ed25519:${bytes.toString('base64')}` : null;
}

function publicKeyObject(key: string) {
  const raw = Buffer.from(key.slice('ed25519:'.length), 'base64');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

/** What a person compares: `SHA256:<base64>` of the raw key, as ssh prints one. */
export function keyFingerprint(key: string): string {
  const raw = Buffer.from(key.replace(/^ed25519:/, ''), 'base64');
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

/** A signature file's shape, or null. Says nothing about whether it verifies. */
export function parseSignature(raw: unknown): ReleaseSignature | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.format !== SIGNATURE_FORMAT) return null;
  if (r.kind !== 'vsix') return null;
  for (const k of ['server', 'subject', 'sha256', 'signature'] as const) if (typeof r[k] !== 'string') return null;
  const key = parsePublicKey(r.key);
  if (!key || !/^[A-Za-z0-9+/]{86}={0,2}$/.test(r.signature as string)) return null;
  return {
    format: SIGNATURE_FORMAT,
    kind: r.kind,
    server: r.server as string,
    subject: r.subject as string,
    sha256: r.sha256 as string,
    key,
    signature: r.signature as string,
  };
}

/** A signature served in a response header: base64 of the JSON file. Null when absent or unreadable. */
export function decodeSignatureHeader(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Does `raw` (a signature file, parsed JSON) vouch for exactly `expected`,
 * signed by `pinnedKey`? Null when it does, else the one-line reason it does not.
 */
export function verifyRelease(raw: unknown, expected: ReleaseFacts, pinnedKey: string): string | null {
  if (raw === null || raw === undefined) return 'central sent no signature for it';
  const sig = parseSignature(raw);
  if (!sig) return 'its signature is malformed';
  if (sig.key !== pinnedKey)
    return `it is signed by key ${keyFingerprint(sig.key)}, not the pinned ${keyFingerprint(pinnedKey)}`;
  const message = releaseMessage(expected);
  try {
    if (verify(null, message, publicKeyObject(pinnedKey), Buffer.from(sig.signature, 'base64'))) return null;
  } catch {
    return 'its signature does not verify';
  }
  // Say which fact differs when the file names it; otherwise the bytes were tampered with.
  if (sig.kind !== expected.kind) return `its signature is for a ${sig.kind}, not a ${expected.kind}`;
  if (normalizeServer(sig.server) !== normalizeServer(expected.server))
    return `its signature is for ${sig.server}, not ${expected.server}`;
  if (normalizeSubject(sig.subject) !== normalizeSubject(expected.subject))
    return `its signature is for ${sig.subject}, not ${expected.subject}`;
  if (sig.sha256.toLowerCase() !== expected.sha256.toLowerCase())
    return 'its signature is for other bytes than were downloaded';
  return 'its signature does not verify';
}

/** Sign `facts` with a PKCS#8 PEM private key. The operator's machine only. */
export function signRelease(facts: ReleaseFacts, privateKeyPem: string): ReleaseSignature {
  const priv = createPrivateKey(privateKeyPem);
  if (priv.asymmetricKeyType !== 'ed25519') throw new Error('the key is not an Ed25519 key');
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const key = `ed25519:${Buffer.from(der.subarray(SPKI_ED25519.length)).toString('base64')}`;
  return assembleSignature(facts, key, sign(null, releaseMessage(facts), priv).toString('base64'));
}

/**
 * The signature file for a raw Ed25519 signature made elsewhere (a remote
 * signer, a hardware key). Not trusted by assembling it: callers verify it
 * against the key they expect (verifyRelease) before using it.
 */
export function assembleSignature(facts: ReleaseFacts, key: string, signature: string): ReleaseSignature {
  releaseMessage(facts); // throws on facts that cannot be signed
  return {
    format: SIGNATURE_FORMAT,
    kind: facts.kind,
    server: normalizeServer(facts.server)!,
    subject: normalizeSubject(facts.subject)!,
    sha256: facts.sha256.toLowerCase(),
    key,
    signature,
  };
}

/** A fresh key pair: the private half as PKCS#8 PEM, the public half as `ed25519:<base64>`. */
export function generateReleaseKey(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privatePem: String(privateKey.export({ format: 'pem', type: 'pkcs8' })),
    publicKey: `ed25519:${Buffer.from(der.subarray(SPKI_ED25519.length)).toString('base64')}`,
  };
}

/**
 * The install a release belongs to: central's origin. Central is reached at
 * its origin whatever path a URL carries (chat-render.ts apiUrl), so pins and
 * signatures are too; keyed by the full URL, a Connect link with a path
 * (`https://central/x`) would reach the same central with no pin at all.
 */
export function releaseOrigin(serverUrl: string): string | null {
  try {
    const origin = new URL(serverUrl).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** The pinned key for `origin`, including a pin stored under a URL with a path before pins were per origin. */
export function pinFor(pins: Record<string, string>, origin: string): string | null {
  const exact = parsePublicKey(pins[origin]);
  if (exact) return exact;
  for (const [url, key] of Object.entries(pins)) if (releaseOrigin(url) === origin) return parsePublicKey(key);
  return null;
}

export type ReleaseTrust = { verifyWith: string } | { refuse: string } | { unsigned: true };

/**
 * How releases from `serverUrl` are held: to the developer's own key, else to
 * the one pinned for its origin. A key the developer declined refuses them
 * (declining is not "unverified"); only an origin that never offered one is
 * unsigned.
 */
export function releaseTrust(o: {
  own: string | null | undefined;
  pins: Record<string, string>;
  declined: Record<string, string>;
  serverUrl: string;
}): ReleaseTrust {
  if (o.own) return { verifyWith: o.own };
  const origin = releaseOrigin(o.serverUrl) ?? o.serverUrl;
  const pinned = pinFor(o.pins, origin);
  if (pinned) return { verifyWith: pinned };
  const declined = parsePublicKey(o.declined[origin]);
  if (declined)
    return {
      refuse: `${origin} signs its releases with key ${keyFingerprint(declined)}, which you did not trust (reconnect to be asked again)`,
    };
  return { unsigned: true };
}

export type PinDecision =
  | { action: 'none' }
  | { action: 'confirm-first'; key: string }
  | { action: 'confirm-change'; from: string; to: string };

/**
 * What to do with a key central (or its Connect link) offers. The first one
 * is pinned only on the developer's confirmation, and so is any different
 * one later. An offer of nothing never unpins: a server that stops naming a
 * key must not turn verification off.
 */
export function decidePin(pinned: string | null, offered: string | null): PinDecision {
  if (!offered) return { action: 'none' };
  if (!pinned) return { action: 'confirm-first', key: offered };
  if (pinned === offered) return { action: 'none' };
  return { action: 'confirm-change', from: pinned, to: offered };
}
