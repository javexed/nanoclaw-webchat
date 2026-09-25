/**
 * Sign-in methods, edited from Admin → Sign-in: Tailscale, OIDC (Microsoft or
 * any OpenID Connect provider) and the trusted proxy. The bearer token keeps
 * its own on/off (a DB flag; the token itself is fixed at boot).
 *
 * Each writes the same WEBCHAT_* keys .env always held — so a restart, a backup
 * or a hand edit all see one source — AND this process's environment, which
 * auth.ts reads on every use, so a change applies at once.
 *
 * OIDC is configured from DISCOVERY, never assembled by hand: Microsoft from
 * the tenant's own OpenID configuration on login.microsoftonline.com (a
 * token's `iss` carries the tenant GUID, so a domain typed here would never
 * match), any other provider from <issuer>/.well-known/openid-configuration,
 * whose `issuer` must be exactly the one typed. That lookup is also the test
 * that the provider exists and is reachable. Every endpoint must be https.
 *
 * The client secret is write-only: it can be set, replaced or cleared, never
 * read back.
 */
import { DEFAULT_PROXY_HEADER, oidcCfg, type OidcProvider } from './auth.js';
import { removeEnv, upsertEnv } from './env-write.js';

type Env = NodeJS.ProcessEnv;

const MS_AUTHORITY = 'https://login.microsoftonline.com';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** Multi-tenant endpoints: a per-tenant issuer check cannot accept their tokens. */
const SHARED_TENANTS = new Set(['common', 'organizations', 'consumers']);

export const OIDC_KEYS = [
  'WEBCHAT_OIDC_PROVIDER',
  'WEBCHAT_OIDC_NAME',
  'WEBCHAT_OIDC_ISSUER',
  'WEBCHAT_OIDC_AUDIENCE',
  'WEBCHAT_OIDC_JWKS_URI',
  'WEBCHAT_OIDC_AUTHORIZE_URL',
  'WEBCHAT_OIDC_TOKEN_URL',
  'WEBCHAT_OIDC_TOKEN_AUTH',
  'WEBCHAT_OIDC_CLIENT_SECRET',
  'WEBCHAT_OIDC_LOGIN',
] as const;

function put(root: string, env: Env, key: string, val: string): void {
  upsertEnv(root, key, val);
  env[key] = val;
}
function drop(root: string, env: Env, key: string): void {
  removeEnv(root, key);
  delete env[key];
}

// ── The view ────────────────────────────────────────────────────────────────

export interface OidcView {
  enabled: boolean;
  provider: OidcProvider;
  /** Microsoft: the tenant GUID from the issuer. */
  tenantId: string;
  /** Other: the issuer. */
  issuer: string;
  name: string;
  clientId: string;
  secretSet: boolean;
}

export interface ProxyView {
  enabled: boolean;
  /** The IP/CIDR list; empty when `auto` (set in .env only). */
  ips: string;
  auto: boolean;
  header: string;
}

export function readOidc(env: Env = process.env): OidcView {
  const c = oidcCfg(env);
  return {
    enabled: c.enabled,
    provider: c.provider,
    tenantId: /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/.exec(c.issuer)?.[1] ?? '',
    issuer: c.issuer,
    name: c.provider === 'other' ? (env.WEBCHAT_OIDC_NAME || '').trim() : '',
    clientId: c.audience,
    secretSet: Boolean((env.WEBCHAT_OIDC_CLIENT_SECRET || '').trim()),
  };
}

export function readProxy(env: Env = process.env): ProxyView {
  const raw = (env.WEBCHAT_TRUSTED_PROXY_IPS || '').trim();
  const auto = raw === 'auto' || raw === '*';
  return {
    enabled: raw.length > 0,
    ips: auto ? '' : raw,
    auto,
    header: (env.WEBCHAT_TRUSTED_PROXY_HEADER || DEFAULT_PROXY_HEADER).trim().toLowerCase(),
  };
}

// ── Tailscale ───────────────────────────────────────────────────────────────

export function applyTailscale(root: string, enabled: boolean, env: Env = process.env): void {
  if (enabled) put(root, env, 'WEBCHAT_TAILSCALE', 'true');
  else drop(root, env, 'WEBCHAT_TAILSCALE');
}

// ── Trusted proxy ───────────────────────────────────────────────────────────

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The proxy's address(es), IPv4 or IPv4/CIDR (what auth.ts matches), and the
 * identity header. "auto" / "*" — trust ANY caller's headers — is refused here:
 * it is safe only when nothing but the proxy can reach the port, which this
 * page cannot check, and one click would otherwise hand the install to anyone
 * who can send a header. It stays possible in .env for those who can check.
 */
export function validateProxyInput(input: {
  ips?: unknown;
  header?: unknown;
}): { ok: true; ips: string; header: string } | { ok: false; error: string } {
  const raw = typeof input.ips === 'string' ? input.ips : '';
  const entries = raw
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  if (!entries.length) return { ok: false, error: 'Enter the proxy’s IP address.' };
  if (entries.some((e) => e === 'auto' || e === '*'))
    return { ok: false, error: 'Name the proxy’s address; trusting any address is .env-only.' };
  if (entries.length > 50) return { ok: false, error: 'At most 50 addresses.' };
  for (const e of entries) {
    const [ip, prefix, extra] = e.split('/');
    const okPrefix = prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32);
    if (extra !== undefined || !IPV4.test(ip) || !okPrefix)
      return { ok: false, error: `${e} is not an IPv4 address or CIDR.` };
  }
  const header = (typeof input.header === 'string' ? input.header : '').trim().toLowerCase() || DEFAULT_PROXY_HEADER;
  if (!HEADER.test(header)) return { ok: false, error: 'That header name is not valid.' };
  return { ok: true, ips: entries.join(','), header };
}

export function applyProxy(root: string, v: { ips: string; header: string }, env: Env = process.env): void {
  put(root, env, 'WEBCHAT_TRUSTED_PROXY_IPS', v.ips);
  if (v.header === DEFAULT_PROXY_HEADER) drop(root, env, 'WEBCHAT_TRUSTED_PROXY_HEADER');
  else put(root, env, 'WEBCHAT_TRUSTED_PROXY_HEADER', v.header);
}

export function clearProxy(root: string, env: Env = process.env): void {
  drop(root, env, 'WEBCHAT_TRUSTED_PROXY_IPS');
  drop(root, env, 'WEBCHAT_TRUSTED_PROXY_HEADER');
}

// ── OIDC ────────────────────────────────────────────────────────────────────

export interface OidcInput {
  provider?: unknown;
  /** Microsoft: tenant GUID or verified domain. */
  tenant?: unknown;
  /** Other: the issuer URL. */
  issuer?: unknown;
  /** Other: the name on the login button. */
  name?: unknown;
  clientId?: unknown;
  /** Set or replace; omit to keep. */
  clientSecret?: unknown;
  clearSecret?: unknown;
}

export type ValidOidc = {
  provider: OidcProvider;
  /** Microsoft: the tenant; other: the issuer. */
  where: string;
  name: string;
  clientId: string;
  secret?: string;
  clearSecret: boolean;
};

/** An https URL with no credentials, query or fragment. */
function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    return u;
  } catch {
    return null;
  }
}

export function validateOidcInput(input: OidcInput): ({ ok: true } & ValidOidc) | { ok: false; error: string } {
  const provider = input.provider === 'other' ? 'other' : input.provider === 'microsoft' ? 'microsoft' : null;
  if (!provider) return { ok: false, error: 'Choose Microsoft or Other.' };
  let where: string;
  let name = '';
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  if (provider === 'microsoft') {
    where = typeof input.tenant === 'string' ? input.tenant.trim().toLowerCase() : '';
    if (!where) return { ok: false, error: 'Tenant ID is required.' };
    if (SHARED_TENANTS.has(where))
      return { ok: false, error: `"${where}" is not one tenant. Use your tenant's ID or domain.` };
    if (!GUID.test(where) && !DOMAIN.test(where))
      return { ok: false, error: 'Tenant must be a tenant ID (GUID) or a domain.' };
    if (!GUID.test(clientId))
      return { ok: false, error: 'Client ID must be the app registration’s Application (client) ID.' };
  } else {
    const raw = typeof input.issuer === 'string' ? input.issuer.trim() : '';
    if (!httpsUrl(raw)) return { ok: false, error: 'Issuer must be an https URL.' };
    where = raw;
    name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length > 40 || /[\p{Cc}<>]/u.test(name)) return { ok: false, error: 'That name is not valid.' };
    if (!clientId || clientId.length > 256 || /\s/.test(clientId))
      return { ok: false, error: 'Client ID is required.' };
  }
  let secret: string | undefined;
  if (typeof input.clientSecret === 'string' && input.clientSecret.trim()) {
    secret = input.clientSecret.trim();
    if (secret.length > 1024 || /[\r\n]/.test(secret)) return { ok: false, error: 'That client secret is not valid.' };
  }
  return { ok: true, provider, where, name, clientId, secret, clearSecret: input.clearSecret === true };
}

export interface Discovered {
  issuer: string;
  jwksUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** The provider takes the client secret only as HTTP Basic. */
  tokenAuthBasic: boolean;
}

/**
 * The provider's issuer and endpoints, from its OpenID configuration. For
 * Microsoft only login.microsoftonline.com is contacted (the tenant is
 * validated before it goes into the URL); for any other provider only the
 * issuer the admin typed, and its answer must name that same issuer.
 */
export async function discover(
  v: Pick<ValidOidc, 'provider' | 'where'>,
  fetchImpl: typeof fetch = fetch,
): Promise<({ ok: true } & Discovered) | { ok: false; error: string }> {
  const who = v.provider === 'microsoft' ? 'Microsoft' : 'The provider';
  const url =
    v.provider === 'microsoft'
      ? `${MS_AUTHORITY}/${encodeURIComponent(v.where)}/v2.0/.well-known/openid-configuration`
      : `${v.where.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  } catch {
    return { ok: false, error: `${who} could not be reached.` };
  }
  if (res.status === 400 || res.status === 404)
    return {
      ok: false,
      error:
        v.provider === 'microsoft' ? 'Microsoft does not know that tenant.' : 'No OpenID configuration at that issuer.',
    };
  if (!res.ok) return { ok: false, error: `${who} answered HTTP ${res.status}.` };
  const doc = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof doc[k] === 'string' ? (doc[k] as string) : '');
  const issuer = str('issuer');
  const jwksUri = str('jwks_uri');
  const authorizeUrl = str('authorization_endpoint');
  const tokenUrl = str('token_endpoint');
  if (v.provider === 'microsoft') {
    // Only a single-tenant issuer on Microsoft's own authority, and keys served from it.
    if (!/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(issuer))
      return { ok: false, error: 'That tenant’s configuration does not name a single tenant.' };
    if (!jwksUri.startsWith(`${MS_AUTHORITY}/`))
      return { ok: false, error: 'That tenant’s signing keys are not on Microsoft’s authority.' };
  } else if (issuer !== v.where && issuer !== v.where.replace(/\/+$/, '')) {
    // OpenID Connect Discovery §4.3: the issuer in the document MUST be the one asked for.
    return { ok: false, error: `The provider names a different issuer (${issuer.slice(0, 120) || 'none'}).` };
  }
  for (const [k, u] of [
    ['jwks_uri', jwksUri],
    ['authorization_endpoint', authorizeUrl],
    ['token_endpoint', tokenUrl],
  ] as const) {
    if (!httpsEndpoint(u)) return { ok: false, error: `The provider’s ${k} is not an https URL.` };
  }
  const algs = doc.id_token_signing_alg_values_supported;
  if (Array.isArray(algs) && !algs.includes('RS256') && !algs.includes('ES256'))
    return { ok: false, error: 'The provider signs id tokens with neither RS256 nor ES256.' };
  const auth = doc.token_endpoint_auth_methods_supported;
  const tokenAuthBasic =
    Array.isArray(auth) && auth.includes('client_secret_basic') && !auth.includes('client_secret_post');
  return { ok: true, issuer, jwksUri, authorizeUrl, tokenUrl, tokenAuthBasic };
}

/** An endpoint: https, no credentials or fragment; a query is allowed (some providers carry a policy in it). */
function httpsEndpoint(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

/** Apply validated, discovered settings: .env and this process, together. */
export function applyOidc(root: string, v: ValidOidc & Discovered, env: Env = process.env): void {
  put(root, env, 'WEBCHAT_OIDC_PROVIDER', v.provider);
  if (v.provider === 'other' && v.name) put(root, env, 'WEBCHAT_OIDC_NAME', v.name);
  else drop(root, env, 'WEBCHAT_OIDC_NAME');
  put(root, env, 'WEBCHAT_OIDC_ISSUER', v.issuer);
  put(root, env, 'WEBCHAT_OIDC_AUDIENCE', v.clientId);
  put(root, env, 'WEBCHAT_OIDC_JWKS_URI', v.jwksUri);
  put(root, env, 'WEBCHAT_OIDC_AUTHORIZE_URL', v.authorizeUrl);
  put(root, env, 'WEBCHAT_OIDC_TOKEN_URL', v.tokenUrl);
  if (v.tokenAuthBasic) put(root, env, 'WEBCHAT_OIDC_TOKEN_AUTH', 'basic');
  else drop(root, env, 'WEBCHAT_OIDC_TOKEN_AUTH');
  // The old "show the button" switch: when OIDC is on, the button is.
  drop(root, env, 'WEBCHAT_OIDC_LOGIN');
  if (v.secret) put(root, env, 'WEBCHAT_OIDC_CLIENT_SECRET', v.secret);
  else if (v.clearSecret) drop(root, env, 'WEBCHAT_OIDC_CLIENT_SECRET');
}

/** Turn OIDC off: every key removed, and the sessions it started stop authenticating. */
export function clearOidc(root: string, env: Env = process.env): void {
  for (const k of OIDC_KEYS) drop(root, env, k);
}
