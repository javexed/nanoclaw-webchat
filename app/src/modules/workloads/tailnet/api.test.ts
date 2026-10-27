/**
 * The Tailscale API client against a fake API, and the vault side of the
 * OAuth client against a fake OneCLI.
 */
import { describe, expect, it } from 'vitest';

import type { OnecliAdmin, SecretRow } from '../../user-credentials/onecli-admin.js';
import { TailscaleApi, TOKEN_PATH, type TailscaleHttp } from './api.js';
import { checkVault, connectTailnetClient, SECRET_NAME, SECRET_SPEC } from './credential.js';

interface Call {
  method: string;
  path: string;
  opts: Parameters<TailscaleHttp>[2];
}

function fakeApi(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const http: TailscaleHttp = async (method, path, opts) => {
    const c = { method, path, opts };
    calls.push(c);
    return handler(c);
  };
  return { calls, http };
}

let tokens = 0;
const tokenOk = () => ({ status: 200, body: { access_token: `at-${++tokens}`, expires_in: 3600 } });

describe('Tailscale API client', () => {
  it('asks for a token with no credentials of its own (the vault adds them) and keeps it', async () => {
    let now = 0;
    const { calls, http } = fakeApi((c) => (c.path === TOKEN_PATH ? tokenOk() : { status: 200, body: {} }));
    const api = new TailscaleApi(http, () => now);
    const t = await api.accessToken();
    expect(await api.accessToken()).toBe(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: TOKEN_PATH,
      opts: { form: { grant_type: 'client_credentials' } },
    });
    now += 3600_000;
    expect(await api.accessToken()).not.toBe(t);
  });

  it('says what is wrong when the client is refused', async () => {
    const api = new TailscaleApi(fakeApi(() => ({ status: 401, body: { message: 'API token invalid' } })).http);
    await expect(api.accessToken()).rejects.toThrow(/refused the OAuth client/);
  });

  it('mints a single-use, not ephemeral, preauthorized, tagged key', async () => {
    const { calls, http } = fakeApi((c) =>
      c.path === TOKEN_PATH ? tokenOk() : { status: 200, body: { id: 'k123', key: 'tskey-auth-k123-xyz' } },
    );
    const key = await new TailscaleApi(http).mintAuthKey('tag:nanoclaw-app', 'nanoclaw app notes');
    expect(key).toEqual({ id: 'k123', key: 'tskey-auth-k123-xyz' });
    const mint = calls.find((c) => c.path === '/api/v2/tailnet/-/keys')!;
    expect(mint.method).toBe('POST');
    expect(mint.opts.bearer).toMatch(/^at-/);
    expect(mint.opts.json).toEqual({
      capabilities: {
        devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: ['tag:nanoclaw-app'] } },
      },
      expirySeconds: 600,
      description: 'nanoclaw app notes',
    });
  });

  it('retries once with a fresh token on 401, and names a missing scope on 403', async () => {
    let first = true;
    const { calls, http } = fakeApi((c) => {
      if (c.path === TOKEN_PATH) return tokenOk();
      if (first) {
        first = false;
        return { status: 401, body: {} };
      }
      return { status: 403, body: { message: 'forbidden' } };
    });
    await expect(new TailscaleApi(http).deleteDevice('nABC')).rejects.toThrow(/devices:core/);
    expect(calls.filter((c) => c.path === TOKEN_PATH)).toHaveLength(2);
  });

  it('counts a device or key that is already gone as removed', async () => {
    const { calls, http } = fakeApi((c) => (c.path === TOKEN_PATH ? tokenOk() : { status: 404, body: {} }));
    const api = new TailscaleApi(http);
    await api.deleteDevice('nABC/../x');
    await api.deleteAuthKey('k1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('DELETE /api/v2/device/nABC%2F..%2Fx');
  });
});

function fakeAdmin(init: {
  secrets?: SecretRow[];
  agents?: Array<{ id: string; identifier: string; secretMode: string }>;
}) {
  const secrets = [...(init.secrets ?? [])];
  const agents = [...(init.agents ?? [])];
  const assigned = new Map<string, string[]>();
  const log: string[] = [];
  const admin = {
    listAllSecrets: async () => secrets,
    listAgents: async () => agents,
    listAgentSecretIds: async (id: string) => assigned.get(id) ?? [],
    createGenericSecret: async (name: string, value: string, spec: object) => {
      log.push(`create ${name} ${value} ${JSON.stringify(spec)}`);
      secrets.push({
        id: 's1',
        name,
        type: 'generic',
        hostPattern: SECRET_SPEC.hostPattern,
        pathPattern: SECRET_SPEC.pathPattern,
      });
      return 's1';
    },
    updateGenericSecret: async (id: string, value: string) => void log.push(`update ${id} ${value}`),
    updateSecretPathPattern: async (id: string, p: string) => void log.push(`path ${id} ${p}`),
    ensureAgent: async (_name: string, identifier: string) => {
      let a = agents.find((x) => x.identifier === identifier);
      if (!a) agents.push((a = { id: 'a1', identifier, secretMode: 'all' }));
      return a.id;
    },
    setSecretMode: async (id: string, mode: string) => {
      agents.find((a) => a.id === id)!.secretMode = mode;
      log.push(`mode ${id} ${mode}`);
    },
    setSecrets: async (id: string, ids: string[]) => void assigned.set(id, ids),
  };
  return { admin: admin as unknown as OnecliAdmin, log, assigned, agents };
}

describe('the OAuth client in the vault', () => {
  it('is stored as HTTP Basic, injected on the token request only, for the tailnet identity alone', async () => {
    const f = fakeAdmin({});
    await connectTailnetClient(f.admin, 'kClient123', 'tskey-client-kClient123-SECRETSECRET');
    const value = Buffer.from('kClient123:tskey-client-kClient123-SECRETSECRET').toString('base64');
    expect(f.log[0]).toBe(
      `create ${SECRET_NAME} ${value} ${JSON.stringify({
        hostPattern: 'api.tailscale.com',
        pathPattern: '/api/v2/oauth/token',
        headerName: 'Authorization',
        valueFormat: 'Basic {value}',
      })}`,
    );
    expect(f.log).toContain('mode a1 selective');
    expect(f.assigned.get('a1')).toEqual(['s1']);
    expect(await checkVault(f.admin)).toEqual({ ok: true, warnings: [] });
  });

  it('replaces the stored client in place', async () => {
    const f = fakeAdmin({
      secrets: [{ id: 's9', name: SECRET_NAME, hostPattern: 'api.tailscale.com', pathPattern: '/api/v2/*' }],
    });
    await connectTailnetClient(f.admin, 'kNew1', 'tskey-client-kNew1-ABCDEFGH');
    expect(f.log[0]).toMatch(/^update s9 /);
    expect(f.log).toContain('path s9 /api/v2/oauth/token');
    expect(f.assigned.get('a1')).toEqual(['s9']);
  });

  it('refuses what is not a client id and secret', async () => {
    const f = fakeAdmin({});
    await expect(connectTailnetClient(f.admin, 'kClient1', 'tskey-auth-abc')).rejects.toThrow(/client secret/);
    await expect(connectTailnetClient(f.admin, 'bad id', 'tskey-client-abcdefgh')).rejects.toThrow(/client ID/);
    expect(f.log).toEqual([]);
  });

  it('says what is missing, and warns about identities in "all" mode', async () => {
    const f = fakeAdmin({
      agents: [
        { id: 'g1', identifier: 'ag-1', secretMode: 'all' },
        { id: 'd1', identifier: 'webchat-drafter', secretMode: 'all' },
      ],
    });
    expect(await checkVault(f.admin)).toEqual({
      ok: false,
      missing: expect.stringMatching(/not in the vault/),
      warnings: [expect.stringMatching(/1 OneCLI identity is in "all" secret mode/)],
    });
    await connectTailnetClient(f.admin, 'kClient123', 'tskey-client-kClient123-SECRETSECRET');
    f.assigned.set('a1', []);
    expect(await checkVault(f.admin)).toMatchObject({ ok: false, missing: expect.stringMatching(/not assigned/) });
  });
});
