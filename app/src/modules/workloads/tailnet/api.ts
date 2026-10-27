/**
 * The Tailscale API calls the tailnet route makes, host-side, through the
 * OneCLI gateway: NanoClaw never holds the OAuth client's secret. The vault
 * injects it on the token request only (credential.ts); the access token that
 * comes back lives in memory until it expires (an hour), and is used for
 * three things:
 *
 *   - mint one auth key per sidecar: single-use, not ephemeral,
 *     preauthorized, tagged, valid ten minutes;
 *   - delete a key a sidecar never used;
 *   - delete a sidecar's device when its app is unpublished.
 */
import { log } from '../../../log.js';
import { vaultDispatcher } from '../vault-proxy.js';

export const API_BASE = 'https://api.tailscale.com';
export const TOKEN_PATH = '/api/v2/oauth/token';
/** The OneCLI identity the host's Tailscale calls go out as; the OAuth client's secret is assigned to it. */
export const TAILNET_IDENTITY = 'nanoclaw-tailnet';
export const TAILNET_IDENTITY_NAME = 'NanoClaw tailnet publishing';

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** One request to the Tailscale API. Injectable: tests use a fake API. */
export type TailscaleHttp = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { form?: Record<string, string>; json?: unknown; bearer?: string },
) => Promise<HttpResponse>;

export class TailscaleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const describe = (r: HttpResponse): string => {
  const m = (r.body as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m.slice(0, 200) : `HTTP ${r.status}`;
};

export interface AuthKey {
  id: string;
  key: string;
}

export class TailscaleApi {
  private token: { value: string; until: number } | null = null;

  constructor(
    private readonly http: TailscaleHttp,
    private readonly now: () => number = Date.now,
  ) {}

  /** An access token from the OAuth client (the vault adds the client's credentials to this request). */
  async accessToken(): Promise<string> {
    if (this.token && this.token.until > this.now()) return this.token.value;
    const r = await this.http('POST', TOKEN_PATH, { form: { grant_type: 'client_credentials' } });
    const b = r.body as { access_token?: unknown; expires_in?: unknown } | null;
    if (r.status !== 200 || typeof b?.access_token !== 'string' || !b.access_token)
      throw new TailscaleApiError(
        r.status === 401 || r.status === 403
          ? 'Tailscale refused the OAuth client (is it in the vault, assigned to nanoclaw-tailnet?)'
          : `Tailscale token request failed: ${describe(r)}`,
        r.status,
      );
    const ttl = typeof b.expires_in === 'number' && b.expires_in > 120 ? b.expires_in : 3600;
    this.token = { value: b.access_token, until: this.now() + (ttl - 60) * 1000 };
    return b.access_token;
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, json?: unknown): Promise<HttpResponse> {
    let r = await this.http(method, path, { json, bearer: await this.accessToken() });
    if (r.status === 401) {
      this.token = null;
      r = await this.http(method, path, { json, bearer: await this.accessToken() });
    }
    return r;
  }

  /** One auth key for one sidecar. */
  async mintAuthKey(tag: string, description: string): Promise<AuthKey> {
    const r = await this.call('POST', '/api/v2/tailnet/-/keys', {
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [tag] } } },
      expirySeconds: 600,
      description: description.replace(/[^A-Za-z0-9 -]/g, '-').slice(0, 50),
    });
    const b = r.body as { id?: unknown; key?: unknown } | null;
    if (r.status !== 200 || typeof b?.key !== 'string' || typeof b.id !== 'string')
      throw new TailscaleApiError(
        r.status === 403
          ? `the OAuth client may not create keys for ${tag} (it needs the auth_keys scope with that tag)`
          : `Tailscale did not create an auth key: ${describe(r)}`,
        r.status,
      );
    return { id: b.id, key: b.key };
  }

  async deleteAuthKey(id: string): Promise<void> {
    const r = await this.call('DELETE', `/api/v2/tailnet/-/keys/${encodeURIComponent(id)}`);
    if (r.status !== 200 && r.status !== 404)
      throw new TailscaleApiError(`Tailscale did not delete auth key: ${describe(r)}`, r.status);
  }

  /** Remove a device from the tailnet. Gone already counts as done. */
  async deleteDevice(nodeId: string): Promise<void> {
    const r = await this.call('DELETE', `/api/v2/device/${encodeURIComponent(nodeId)}`);
    if (r.status !== 200 && r.status !== 404)
      throw new TailscaleApiError(
        r.status === 403
          ? 'the OAuth client may not remove devices (it needs the devices:core scope)'
          : `Tailscale did not remove the device: ${describe(r)}`,
        r.status,
      );
  }
}

// --- The real transport: undici through OneCLI's proxy. -----------------------

const MAX_BODY = 64 * 1024;

export const realTailscaleHttp: TailscaleHttp = async (method, path, opts) => {
  if (process.env.VITEST) throw new Error('tailnet: no real Tailscale API calls under the test runner');
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    dispatcher: await vaultDispatcher(TAILNET_IDENTITY, TAILNET_IDENTITY_NAME, 'the tailnet route'),
  } as unknown as RequestInit);
  const text = (await res.text()).slice(0, MAX_BODY);
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text.slice(0, 200) };
  }
  if (res.status >= 500) log.warn('Tailscale API error', { path, status: res.status });
  return { status: res.status, body: parsed };
};
