/**
 * MCP OAuth outbound policy: every URL the server's metadata names goes
 * through the SSRF gate, credential requests refuse redirects, credential
 * endpoints must be https (or http on the server's own http host), and a
 * failed grant never echoes the remote body.
 *
 * No real endpoints: global fetch is stubbed, and every host is an IP literal
 * so the gate never consults DNS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const servers = new Map<string, { id: string; url: string | null }>();
const setAuth = vi.fn(async () => {});
vi.mock('./mcp-registry.js', () => ({
  getWebchatMcpServer: async (id: string) => servers.get(id) ?? null,
  setMcpServerAuth: (...a: unknown[]) => setAuth(...(a as [])),
}));

import {
  assertCredentialEndpoint,
  discoverAuthServer,
  effectiveAuthHeader,
  finishOAuthFlow,
  refreshOAuthToken,
  startOAuthFlow,
  type McpAuthOAuth,
} from './mcp-auth.js';
import type { WebchatMcpServer } from './mcp-registry.js';

const PUBLIC = 'https://203.0.113.10';
const METADATA = 'http://169.254.169.254/latest/meta-data';

type Route = (url: string, init?: RequestInit) => Response;
let fetchMock: ReturnType<typeof vi.fn>;
let routes: Record<string, Route>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function redirect(location: string, status = 307): Response {
  return new Response(null, { status, headers: { location } });
}
function calledUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  delete process.env.WEBCHAT_BLOCK_PRIVATE_IPS;
  servers.clear();
  setAuth.mockClear();
  routes = {};
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const r = routes[String(url)];
    return r ? r(String(url), init) : new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function oauth(over: Partial<McpAuthOAuth> = {}): McpAuthOAuth {
  return {
    kind: 'oauth',
    client_id: 'c1',
    token_endpoint: `${PUBLIC}/token`,
    authorization_endpoint: `${PUBLIC}/authorize`,
    resource: `${PUBLIC}/mcp`,
    access_token: 'old',
    refresh_token: 'r1',
    expires_at: Date.now() - 60_000, // expired → refresh is due
    ...over,
  };
}

/** Starts a flow against a well-behaved public AS and returns its state. */
async function startFlow(tokenEndpoint = `${PUBLIC}/token`): Promise<string> {
  servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
  routes[`${PUBLIC}/.well-known/oauth-authorization-server`] = () =>
    json({ authorization_endpoint: `${PUBLIC}/authorize`, token_endpoint: tokenEndpoint });
  const url = await startOAuthFlow('s1', 'https://host.example/cb', { client_id: 'static' }, 'u1');
  return new URL(url).searchParams.get('state')!;
}

describe('assertCredentialEndpoint', () => {
  it('accepts https anywhere', () => {
    expect(() => assertCredentialEndpoint('https://as.example/token', 'https://mcp.example', 'x')).not.toThrow();
  });
  it('accepts http only on the http MCP server’s own host', () => {
    expect(() => assertCredentialEndpoint('http://winbox:9000/token', 'http://winbox:8000/mcp', 'x')).not.toThrow();
    expect(() => assertCredentialEndpoint('http://other:9000/token', 'http://winbox:8000/mcp', 'x')).toThrow(/https/);
    expect(() => assertCredentialEndpoint('http://mcp.example/token', 'https://mcp.example/mcp', 'x')).toThrow(/https/);
    expect(() => assertCredentialEndpoint('http://mcp.example/token', null, 'x')).toThrow(/https/);
  });
  it('refuses non-web schemes', () => {
    expect(() => assertCredentialEndpoint('file:///etc/passwd', 'http://x', 'x')).toThrow(/https/);
  });
});

describe('discovery goes through the SSRF gate', () => {
  it('never fetches the protected-resource document on a metadata origin', async () => {
    await expect(discoverAuthServer(`${METADATA}/mcp`)).rejects.toThrow(/No OAuth authorization server/);
    expect(calledUrls()).toEqual([]);
  });

  it('never fetches authorization-server metadata the resource document points at a metadata IP', async () => {
    routes[`${PUBLIC}/.well-known/oauth-protected-resource`] = () =>
      json({ authorization_servers: ['http://169.254.169.254'] });
    await expect(discoverAuthServer(`${PUBLIC}/mcp`)).rejects.toThrow(/No OAuth authorization server/);
    expect(calledUrls()).toEqual([`${PUBLIC}/.well-known/oauth-protected-resource`]);
  });

  it('refuses a discovery redirect to a metadata IP', async () => {
    routes[`${PUBLIC}/.well-known/oauth-protected-resource`] = () => redirect(`${METADATA}/`, 302);
    routes[`${PUBLIC}/.well-known/oauth-authorization-server`] = () => redirect(`${METADATA}/`, 302);
    routes[`${PUBLIC}/.well-known/openid-configuration`] = () => redirect(`${METADATA}/`, 302);
    await expect(discoverAuthServer(`${PUBLIC}/mcp`)).rejects.toThrow(/No OAuth authorization server/);
    expect(calledUrls().some((u) => u.includes('169.254'))).toBe(false);
  });

  it('refuses private targets on a hardened install', async () => {
    process.env.WEBCHAT_BLOCK_PRIVATE_IPS = 'true';
    await expect(discoverAuthServer('http://10.0.0.5/mcp')).rejects.toThrow(/No OAuth authorization server/);
    expect(calledUrls()).toEqual([]);
  });
});

describe('client registration', () => {
  it('never POSTs to a metadata registration endpoint', async () => {
    servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
    routes[`${PUBLIC}/.well-known/oauth-authorization-server`] = () =>
      json({
        authorization_endpoint: `${PUBLIC}/authorize`,
        token_endpoint: `${PUBLIC}/token`,
        registration_endpoint: 'https://169.254.169.254/register',
      });
    await expect(startOAuthFlow('s1', 'https://host.example/cb', undefined, 'u1')).rejects.toThrow(
      /dynamic registration/,
    );
    expect(calledUrls().some((u) => u.includes('169.254'))).toBe(false);
  });

  it('refuses to follow a registration redirect, even a 307 to a public host', async () => {
    servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
    routes[`${PUBLIC}/.well-known/oauth-authorization-server`] = () =>
      json({
        authorization_endpoint: `${PUBLIC}/authorize`,
        token_endpoint: `${PUBLIC}/token`,
        registration_endpoint: `${PUBLIC}/register`,
      });
    routes[`${PUBLIC}/register`] = () => redirect('https://198.51.100.9/register');
    await expect(startOAuthFlow('s1', 'https://host.example/cb', undefined, 'u1')).rejects.toThrow(
      /dynamic registration/,
    );
    expect(calledUrls()).not.toContain('https://198.51.100.9/register');
  });

  it('refuses an http token endpoint named by an https server', async () => {
    servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
    routes[`${PUBLIC}/.well-known/oauth-authorization-server`] = () =>
      json({ authorization_endpoint: `${PUBLIC}/authorize`, token_endpoint: 'http://10.0.0.1/token' });
    await expect(startOAuthFlow('s1', 'https://host.example/cb', { client_id: 'c' }, 'u1')).rejects.toThrow(
      /token endpoint must use https/,
    );
  });
});

describe('token exchange', () => {
  it('never POSTs the code to a metadata token endpoint', async () => {
    const state = await startFlow('https://169.254.169.254/token');
    await expect(finishOAuthFlow(state, 'code', 'u1')).rejects.toThrow(/169\.254/);
    expect(calledUrls().some((u) => u.includes('169.254'))).toBe(false);
  });

  it('refuses a token-endpoint redirect instead of replaying the grant', async () => {
    const state = await startFlow();
    routes[`${PUBLIC}/token`] = () => redirect('http://169.254.169.254/token', 308);
    await expect(finishOAuthFlow(state, 'code', 'u1')).rejects.toThrow(/redirect/);
    expect(calledUrls().some((u) => u.includes('169.254'))).toBe(false);
  });

  it('reports a failed exchange by status only, never the response body', async () => {
    const state = await startFlow();
    routes[`${PUBLIC}/token`] = () => new Response('SECRET-INTERNAL-PAGE <html>', { status: 400 });
    const err = await finishOAuthFlow(state, 'code', 'u1').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Token exchange failed (HTTP 400)');
    expect((err as Error).message).not.toMatch(/SECRET|html/);
  });

  it('still completes a legitimate exchange', async () => {
    const state = await startFlow();
    routes[`${PUBLIC}/token`] = (_u, init) => {
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('grant_type=authorization_code');
      return json({ access_token: 'a1', refresh_token: 'r1', expires_in: 60 });
    };
    await expect(finishOAuthFlow(state, 'code', 'u1')).resolves.toEqual({ serverId: 's1' });
    expect(setAuth).toHaveBeenCalledOnce();
  });
});

describe('refresh (the relay path)', () => {
  it('never POSTs a refresh token to a stored metadata endpoint', async () => {
    servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
    const r = await refreshOAuthToken('s1', oauth({ token_endpoint: 'https://169.254.169.254/token' }));
    expect(r).toBeNull();
    expect(calledUrls()).toEqual([]);
  });

  it('re-judges a stored http endpoint against the server’s current URL', async () => {
    servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
    const r = await refreshOAuthToken('s1', oauth({ token_endpoint: 'http://203.0.113.10/token' }));
    expect(r).toBeNull();
    expect(calledUrls()).toEqual([]);
  });

  it('refuses a refresh redirect', async () => {
    servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
    routes[`${PUBLIC}/token`] = () => redirect('http://169.254.169.254/token', 307);
    expect(await refreshOAuthToken('s1', oauth())).toBeNull();
    expect(calledUrls()).toEqual([`${PUBLIC}/token`]);
  });

  it('effectiveAuthHeader (what the relay calls per request) refreshes through the same guard', async () => {
    servers.set('s1', { id: 's1', url: `${PUBLIC}/mcp` });
    const server = {
      id: 's1',
      url: `${PUBLIC}/mcp`,
      auth: JSON.stringify(oauth({ token_endpoint: 'https://169.254.169.254/token' })),
    } as unknown as WebchatMcpServer;
    expect(await effectiveAuthHeader(server)).toBe('Bearer old');
    expect(calledUrls()).toEqual([]);

    routes[`${PUBLIC}/token`] = () => json({ access_token: 'fresh', expires_in: 60 });
    const good = { ...server, auth: JSON.stringify(oauth()) } as WebchatMcpServer;
    expect(await effectiveAuthHeader(good)).toBe('Bearer fresh');
  });

  it('keeps a plain-http LAN server working on its own host', async () => {
    servers.set('s1', { id: 's1', url: 'http://10.0.0.20:8000/mcp' });
    routes['http://10.0.0.20:8000/token'] = () => json({ access_token: 'lan', expires_in: 60 });
    const r = await refreshOAuthToken('s1', oauth({ token_endpoint: 'http://10.0.0.20:8000/token' }));
    expect(r?.access_token).toBe('lan');
  });
});
