/**
 * The Cloudflare API calls the Cloudflare route makes, host-side, through the
 * OneCLI gateway: NanoClaw never holds the API token. The vault adds it as
 * `Authorization: Bearer …` on api.cloudflare.com requests from the
 * `nanoclaw-cloudflare` identity only (credential.ts).
 *
 *   tunnel   find or create this install's remotely-managed tunnel, fetch its
 *            connector token (written to a 0600 file, never logged), set its
 *            ingress (one hostname per app), read its health
 *   DNS      one proxied CNAME per app, <app>.<domain> → <tunnel>.cfargotunnel.com
 *   Access   the catch-all deny application on *.<domain>, and one
 *            application per app with that app's "who can open" as its policy
 */
import { log } from '../../../log.js';
import { vaultDispatcher } from '../vault-proxy.js';

export const API_BASE = 'https://api.cloudflare.com';
export const API_PATH = '/client/v4';
/** The OneCLI identity the host's Cloudflare calls go out as; the API token is assigned to it. */
export const CLOUDFLARE_IDENTITY = 'nanoclaw-cloudflare';
export const CLOUDFLARE_IDENTITY_NAME = 'NanoClaw Cloudflare publishing';

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** One request to the Cloudflare API (path below /client/v4). Injectable: tests use a fake API. */
export type CloudflareHttp = (
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { json?: unknown },
) => Promise<HttpResponse>;

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Cloudflare's own error text, never the body (a token response is a secret). */
const describe = (r: HttpResponse): string => {
  const errs = (r.body as { errors?: Array<{ code?: unknown; message?: unknown }> } | null)?.errors;
  const e = Array.isArray(errs) ? errs[0] : undefined;
  return typeof e?.message === 'string'
    ? `${e.message.slice(0, 200)}${typeof e.code === 'number' ? ` (${e.code})` : ''}`
    : `HTTP ${r.status}`;
};

const result = <T>(r: HttpResponse): T | undefined =>
  (r.body as { success?: unknown; result?: unknown } | null)?.success === true
    ? ((r.body as { result: T }).result ?? undefined)
    : undefined;

const scopeHint = (r: HttpResponse, what: string): string =>
  r.status === 401
    ? 'Cloudflare refused the API token (is it in the vault, assigned to nanoclaw-cloudflare?)'
    : r.status === 403
      ? `the API token may not ${what} (see the scopes in the docs)`
      : `Cloudflare did not ${what}: ${describe(r)}`;

export interface IngressRule {
  hostname?: string;
  service: string;
  originRequest?: Record<string, unknown>;
}

export interface AccessAppBody {
  name: string;
  domain: string;
  type: 'self_hosted';
  session_duration: string;
  app_launcher_visible: boolean;
  http_only_cookie_attribute: boolean;
  same_site_cookie_attribute: 'lax' | 'strict' | 'none';
  policies: Array<{
    name: string;
    decision: 'allow' | 'deny';
    include: Array<Record<string, unknown>>;
    precedence: number;
  }>;
}

export interface AccessApp {
  id: string;
  aud: string;
  domain: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_RE = /^[0-9a-zA-Z-]{1,64}$/;
const id = (v: string, what: string): string => {
  if (!ID_RE.test(v)) throw new CloudflareApiError(`Cloudflare gave an unexpected ${what} id`, 0);
  return encodeURIComponent(v);
};

export class CloudflareApi {
  constructor(
    private readonly http: CloudflareHttp,
    private readonly accountId: () => string,
    private readonly zoneId: () => string,
  ) {}

  private get acct(): string {
    return `/accounts/${id(this.accountId(), 'account')}`;
  }

  private get zone(): string {
    return `/zones/${id(this.zoneId(), 'zone')}`;
  }

  // --- Tunnel -----------------------------------------------------------------

  /** This install's tunnel by name (not deleted), or null. Also the status line's "can we talk to Cloudflare". */
  async findTunnel(name: string): Promise<{ id: string; status: string } | null> {
    const r = await this.http('GET', `${this.acct}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`, {});
    const list = result<Array<{ id?: unknown; name?: unknown; status?: unknown }>>(r);
    if (r.status !== 200 || !Array.isArray(list)) throw new CloudflareApiError(scopeHint(r, 'list tunnels'), r.status);
    const t = list.find((x) => x.name === name && typeof x.id === 'string' && UUID_RE.test(x.id));
    return t ? { id: t.id as string, status: typeof t.status === 'string' ? t.status : '' } : null;
  }

  /** A remotely-managed tunnel: its ingress lives in Cloudflare and is set with putTunnelConfig. */
  async createTunnel(name: string): Promise<string> {
    const r = await this.http('POST', `${this.acct}/cfd_tunnel`, { json: { name, config_src: 'cloudflare' } });
    const t = result<{ id?: unknown }>(r);
    if (r.status !== 200 || typeof t?.id !== 'string' || !UUID_RE.test(t.id))
      throw new CloudflareApiError(scopeHint(r, 'create the tunnel'), r.status);
    return t.id;
  }

  /** The connector token. A secret: the caller writes it to a 0600 file and nowhere else. */
  async tunnelToken(tunnelId: string): Promise<string> {
    const r = await this.http('GET', `${this.acct}/cfd_tunnel/${id(tunnelId, 'tunnel')}/token`, {});
    const t = result<unknown>(r);
    if (r.status !== 200 || typeof t !== 'string' || !/^[A-Za-z0-9+/=_-]{40,4096}$/.test(t))
      throw new CloudflareApiError(scopeHint(r, 'give the tunnel token'), r.status);
    return t;
  }

  /** Replace the tunnel's ingress. The last rule must be the catch-all. */
  async putTunnelConfig(tunnelId: string, ingress: IngressRule[]): Promise<void> {
    if (!ingress.length || ingress[ingress.length - 1].hostname !== undefined)
      throw new Error('cloudflare: ingress must end with a catch-all rule');
    const r = await this.http('PUT', `${this.acct}/cfd_tunnel/${id(tunnelId, 'tunnel')}/configurations`, {
      json: { config: { ingress, 'warp-routing': { enabled: false } } },
    });
    if (r.status !== 200 || result(r) === undefined)
      throw new CloudflareApiError(scopeHint(r, 'set the tunnel’s hostnames'), r.status);
  }

  // --- DNS --------------------------------------------------------------------

  async findDns(name: string): Promise<Array<{ id: string; type: string; content: string }>> {
    const r = await this.http('GET', `${this.zone}/dns_records?name=${encodeURIComponent(name)}`, {});
    const list = result<Array<{ id?: unknown; type?: unknown; content?: unknown; name?: unknown }>>(r);
    if (r.status !== 200 || !Array.isArray(list))
      throw new CloudflareApiError(scopeHint(r, 'read DNS records'), r.status);
    return list
      .filter((x) => typeof x.id === 'string' && x.name === name)
      .map((x) => ({ id: x.id as string, type: String(x.type ?? ''), content: String(x.content ?? '') }));
  }

  async createCname(name: string, target: string, comment: string): Promise<string> {
    const r = await this.http('POST', `${this.zone}/dns_records`, {
      json: { type: 'CNAME', name, content: target, proxied: true, ttl: 1, comment },
    });
    const rec = result<{ id?: unknown }>(r);
    if (r.status !== 200 || typeof rec?.id !== 'string')
      throw new CloudflareApiError(scopeHint(r, `create the DNS record for ${name}`), r.status);
    return rec.id;
  }

  /** Gone already counts as done. */
  async deleteDns(recordId: string): Promise<void> {
    const r = await this.http('DELETE', `${this.zone}/dns_records/${id(recordId, 'DNS record')}`, {});
    if (r.status !== 200 && r.status !== 404)
      throw new CloudflareApiError(scopeHint(r, 'delete a DNS record'), r.status);
  }

  // --- Access -----------------------------------------------------------------

  /** Access applications on exactly this domain. */
  async findAccessApps(domain: string): Promise<AccessApp[]> {
    const r = await this.http('GET', `${this.acct}/access/apps?domain=${encodeURIComponent(domain)}&per_page=100`, {});
    const list = result<Array<Record<string, unknown>>>(r);
    if (r.status !== 200 || !Array.isArray(list))
      throw new CloudflareApiError(scopeHint(r, 'list Access applications'), r.status);
    return list.map(toApp).filter((a): a is AccessApp => a !== null && a.domain === domain);
  }

  async createAccessApp(body: AccessAppBody): Promise<AccessApp> {
    const r = await this.http('POST', `${this.acct}/access/apps`, { json: body });
    const a = toApp(result<Record<string, unknown>>(r));
    if (r.status !== 200 && r.status !== 201)
      throw new CloudflareApiError(scopeHint(r, 'create an Access application'), r.status);
    if (!a)
      throw new CloudflareApiError('Cloudflare created an Access application without an id or audience', r.status);
    return a;
  }

  async updateAccessApp(appId: string, body: AccessAppBody): Promise<AccessApp> {
    const r = await this.http('PUT', `${this.acct}/access/apps/${id(appId, 'Access application')}`, { json: body });
    const a = toApp(result<Record<string, unknown>>(r));
    if (r.status !== 200 || !a) throw new CloudflareApiError(scopeHint(r, 'update an Access application'), r.status);
    return a;
  }

  /** Gone already counts as done. */
  async deleteAccessApp(appId: string): Promise<void> {
    const r = await this.http('DELETE', `${this.acct}/access/apps/${id(appId, 'Access application')}`, {});
    if (r.status !== 200 && r.status !== 202 && r.status !== 404)
      throw new CloudflareApiError(scopeHint(r, 'delete an Access application'), r.status);
  }
}

function toApp(v: Record<string, unknown> | undefined): AccessApp | null {
  if (!v || typeof v.id !== 'string' || typeof v.aud !== 'string' || !/^[0-9a-f]{64}$/.test(v.aud)) return null;
  return {
    id: v.id,
    aud: v.aud,
    domain: typeof v.domain === 'string' ? v.domain.toLowerCase() : '',
    name: typeof v.name === 'string' ? v.name : '',
  };
}

// --- The real transport: undici through OneCLI's proxy. -----------------------

const MAX_BODY = 256 * 1024;

export const realCloudflareHttp: CloudflareHttp = async (method, path, opts) => {
  if (process.env.VITEST) throw new Error('cloudflare: no real Cloudflare API calls under the test runner');
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`${API_BASE}${API_PATH}${path}`, {
    method,
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    dispatcher: await vaultDispatcher(CLOUDFLARE_IDENTITY, CLOUDFLARE_IDENTITY_NAME, 'the Cloudflare route'),
  } as unknown as RequestInit);
  const text = (await res.text()).slice(0, MAX_BODY);
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  // The path only: query strings name nothing secret, bodies may (the tunnel token).
  if (res.status >= 500) log.warn('Cloudflare API error', { path: path.split('?')[0], status: res.status });
  return { status: res.status, body: parsed };
};
