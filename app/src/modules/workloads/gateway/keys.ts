/**
 * The gateway's signing key (ES256). An app learns who is calling from
 * X-NanoClaw-Identity, a short-lived token for its own hostname, and verifies
 * it against the public key at /.nanoclaw/jwks.json on its own address. The
 * private key stays on this host: 0600 under DATA_DIR, outside the folder the
 * gateway container mounts.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../../config.js';

/** Identity tokens live this long; an app must not keep one past it. */
export const IDENTITY_TTL_S = 120;
export const ISSUER = 'nanoclaw-gateway';

export const gatewayDir = (): string => path.join(DATA_DIR, 'workload-gateway');
const keyFile = (): string => path.join(gatewayDir(), 'signing-key.pem');

let cached: { key: KeyObject; kid: string; jwk: Record<string, string> } | null = null;

function load(): NonNullable<typeof cached> {
  if (cached) return cached;
  const file = keyFile();
  let key: KeyObject;
  if (fs.existsSync(file)) {
    key = createPrivateKey(fs.readFileSync(file));
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    ({ privateKey: key } = generateKeyPairSync('ec', { namedCurve: 'P-256' }));
    fs.writeFileSync(file, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const pub = createPublicKey(key).export({ format: 'jwk' }) as Record<string, string>;
  // RFC 7638 thumbprint: the required members, lexically ordered.
  const kid = createHash('sha256')
    .update(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y }))
    .digest('base64url');
  cached = { key, kid, jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' } };
  return cached;
}

export function jwks(): { keys: Array<Record<string, string>> } {
  return { keys: [load().jwk] };
}

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

export interface IdentityClaims {
  /** NanoClaw user id. */
  sub: string;
  name: string;
  /** The publishing route kind that proved it: tailnet | cloudflare. */
  amr: string;
}

/** A compact JWS for one app (aud = its hostname), valid IDENTITY_TTL_S. */
export function signIdentity(claims: IdentityClaims, audience: string, now = Date.now()): string {
  const { key, kid } = load();
  const iat = Math.floor(now / 1000);
  const head = b64({ alg: 'ES256', typ: 'JWT', kid });
  const body = b64({
    ...claims,
    iss: ISSUER,
    aud: audience,
    iat,
    nbf: iat - 5,
    exp: iat + IDENTITY_TTL_S,
    jti: randomUUID(),
  });
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export function __resetKeysForTest(): void {
  cached = null;
}
