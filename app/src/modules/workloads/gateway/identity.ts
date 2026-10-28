/**
 * The two identity proofs a publishing route may bring (publishing.ts). Each
 * is built for one route kind and believes nothing else: the tailnet proof
 * reads no JWT, the Cloudflare proof reads no Tailscale header, and neither
 * reads NanoClaw's cookies, a bearer token or a proxy header.
 *
 * Both return NanoClaw user ids in exactly the shape NanoClaw's own sign-in
 * gives the same person, so "agent members" and "only me" mean the people
 * NanoClaw already knows.
 */
import { canonicalizeWebchatUserId } from '../../../channels/webchat/auth.js';
import type { GatewayIdentity, GatewayRequest, PublishedApp } from './publishing.js';

const first = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v.length === 1 ? v[0] : '') : (v ?? '');

/** One header, present exactly once; a repeated identity header is refused, not merged. */
export function singleHeader(req: GatewayRequest, name: string): string {
  return first(req.headers[name.toLowerCase()]).trim();
}

const LOGIN_RE = /^[^\s,;"<>\\]{1,254}$/;
const plainName = (v: string, fallback: string): string => {
  const s = [...v]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  return s ? s.slice(0, 200) : fallback;
};

/**
 * Tailscale `serve` sends a name with non-ASCII characters as RFC 2047
 * Q-encoded words (`=?utf-8?q?J=C3=B6rg?=`); plain ASCII arrives as is.
 */
export function decodeServeHeader(v: string): string {
  const words = v.trim().split(/\s+/);
  if (!words.length || !words.every((w) => /^=\?utf-8\?q\?[^?\s]*\?=$/i.test(w))) return v;
  const bytes: number[] = [];
  for (const w of words) {
    const body = w.slice(10, -2);
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '_') bytes.push(0x20);
      else if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(body.slice(i + 1, i + 3))) {
        bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(c.charCodeAt(0));
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return '';
  }
}

const normalizePeer = (p: string): string => p.replace(/^::ffff:/, '').toLowerCase();

export interface TailnetIdentityOptions {
  /**
   * The addresses that may speak for this app: its own sidecar(s). A request
   * whose peer is anything else carries no identity, whatever it says.
   */
  trustedPeers(app: PublishedApp): Promise<string[]>;
}

/**
 * Tailscale `serve` adds Tailscale-User-Login (and -Name) for a person on the
 * tailnet, and adds nothing for a tagged device. Believed only from the app's
 * own sidecar: anyone else who reaches the gateway could write the header.
 */
export function tailnetIdentity(
  opts: TailnetIdentityOptions,
): (req: GatewayRequest, app: PublishedApp) => Promise<GatewayIdentity | null> {
  return async (req, app) => {
    const peers = (await opts.trustedPeers(app)).map(normalizePeer);
    if (!req.peer || !peers.includes(normalizePeer(req.peer))) return null;
    const login = decodeServeHeader(singleHeader(req, 'tailscale-user-login'));
    if (!LOGIN_RE.test(login)) return null;
    return {
      userId: canonicalizeWebchatUserId(`webchat:tailscale:${login}`),
      displayName: plainName(decodeServeHeader(singleHeader(req, 'tailscale-user-name')), login),
    };
  };
}

export type JwtVerifier = (
  token: string,
  cfg: { issuer: string; audience: string; jwksUri: string },
) => Promise<{ ok: true; claims: Record<string, unknown> } | { ok: false; reason: string }>;

export interface CloudflareIdentityOptions {
  /** The addresses that may speak for this app: the tunnel connector's. Anything else carries no identity. */
  trustedPeers(app: PublishedApp): Promise<string[]>;
  /** The Access team domain, e.g. myteam.cloudflareaccess.com; empty while not set up. */
  teamDomain(): string;
  /** This app's own Access application audience (AUD tag); null when it has none. */
  audienceFor(app: PublishedApp): Promise<string | null>;
  /** Signature, expiry, issuer and audience (auth.ts verifyJwt). */
  verify: JwtVerifier;
}

/**
 * Cloudflare Access puts a signed token for the app's Access application in
 * Cf-Access-Jwt-Assertion. It is verified for THIS app's audience: a token
 * Access issued for another app, or for NanoClaw itself, is refused. A token
 * without an email (an Access service token) names no person and is refused.
 * Believed only from the connector's address: the tunnel is the one way in
 * that Access stands in front of.
 */
export function cloudflareIdentity(
  opts: CloudflareIdentityOptions,
): (req: GatewayRequest, app: PublishedApp) => Promise<GatewayIdentity | null> {
  return async (req, app) => {
    const peers = (await opts.trustedPeers(app)).map(normalizePeer);
    if (!req.peer || !peers.includes(normalizePeer(req.peer))) return null;
    const team = opts
      .teamDomain()
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    const audience = (await opts.audienceFor(app))?.trim();
    if (!team || !audience) return null;
    const token = singleHeader(req, 'cf-access-jwt-assertion');
    if (!token) return null;
    const issuer = `https://${team}`;
    const r = await opts.verify(token, { issuer, audience, jwksUri: `${issuer}/cdn-cgi/access/certs` });
    if (!r.ok) return null;
    const email = typeof r.claims.email === 'string' ? r.claims.email.trim() : '';
    if (!LOGIN_RE.test(email) || !email.includes('@')) return null;
    const name = typeof r.claims.name === 'string' ? r.claims.name : '';
    return { userId: canonicalizeWebchatUserId(`webchat:${email}`), displayName: plainName(name, email) };
  };
}
