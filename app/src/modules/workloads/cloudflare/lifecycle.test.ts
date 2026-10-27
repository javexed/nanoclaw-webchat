/**
 * The Cloudflare route's lifecycle against a fake Docker and a fake
 * Cloudflare API: status, enabling (tunnel, token file, connector, catch-all
 * deny), an app's Access application, DNS record and ingress in that order,
 * unpublishing in the reverse order, deletes Cloudflare refused, policies kept
 * in step with membership, switching off, and who the gateway believes (real
 * JWT verification with locally generated keys).
 */
import { createSign, generateKeyPairSync, randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-life-'));
vi.mock('../../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../../config.js')>()),
  DATA_DIR: DATA,
}));
const logged: string[] = [];
vi.mock('../../../log.js', () => {
  const rec =
    (lvl: string) =>
    (msg: string, meta?: unknown): void => {
      logged.push(`${lvl} ${msg} ${JSON.stringify(meta ?? {})}`);
    };
  return { log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') } };
});

const { __setCloudflareDepsForTest, __refreshCloudflareStatusForTest, cloudflareStatus, tickCloudflare } =
  await import('./index.js');
const { publishingRoute } = await import('../gateway/publishing.js');
const { cloudflareSettings } = await import('./config.js');
const { INSTALL_SLUG } = await import('../../../config.js');
const { loadState } = await import('./state.js');
const { connectorName, tokenDir, TOKEN_FILE } = await import('./connector.js');
const { edgeBridgeName } = await import('../tailnet/config.js');
import type { AppRoute } from '../routes.js';
import type { GatewaySettings } from '../gateway/config.js';
import type { OnecliAdmin } from '../../user-credentials/onecli-admin.js';
import type { HttpResponse } from './api.js';

const ACCT = 'a'.repeat(32);
const ZONE = 'b'.repeat(32);
const TUNNEL = '11111111-2222-4333-8444-555555555555';
const TOKEN = Buffer.from(JSON.stringify({ a: ACCT, t: TUNNEL, s: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0' })).toString(
  'base64',
);

const route = (app: string, id: string, who: AppRoute['who'] = 'agent-members', emails: string[] = []): AppRoute => ({
  id,
  app,
  workloadId: 'w1',
  agentGroupId: 'ag-1',
  service: 'web',
  port: 8080,
  kind: 'cloudflare',
  who,
  emails,
  ownerUserId: 'webchat:owner@example.com',
  ticket: null,
  createdBy: 'agent:ag-1',
  createdAt: 0,
  updatedAt: 0,
});
const NOTES = route('notes', '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11');
const WIKI = route('wiki', '1c1f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e22', 'specific', ['carol@example.org']);

// --- Fake Docker ------------------------------------------------------------

let containers: Map<string, { args: string[]; spec: string; running: boolean }>;
let edgeExists: boolean;
let calls: string[][];

const docker = async (args: string[]): Promise<string> => {
  calls.push(args);
  const [cmd, ...rest] = args;
  if (cmd === 'network' && rest[0] === 'inspect') {
    if (!edgeExists) throw new Error('no such network');
    if (rest.some((a) => a.includes('.Containers')))
      return [...containers.keys()].map((n) => `id-${n} ${n}`).join('\n');
    return `${edgeBridgeName()} 198.51.100.0/24 198.51.100.1 false false`;
  }
  if (cmd === 'network' && rest[0] === 'create') {
    edgeExists = true;
    return '';
  }
  if (cmd === 'inspect') {
    const target = rest[rest.length - 1];
    if (target.startsWith('id-')) return containers.has(target.slice(3)) ? ` ${INSTALL_SLUG}` : ' ';
    const c = containers.get(target);
    if (!c) throw new Error('no such container');
    return `${c.running} ${c.spec}`;
  }
  if (cmd === 'rm') {
    containers.delete(rest[rest.length - 1]);
    return '';
  }
  if (cmd === 'run') {
    const name = rest[rest.indexOf('--name') + 1];
    const spec = rest[rest.indexOf('--label') + 1].split('=')[1];
    containers.set(name, { args, spec, running: true });
    return 'cid';
  }
  throw new Error(`fake docker: ${args.join(' ')}`);
};

// --- Fake Cloudflare API ----------------------------------------------------

interface FakeApp {
  id: string;
  aud: string;
  domain: string;
  name: string;
  body: Record<string, unknown>;
}
let apiCalls: string[];
let apiDown: boolean;
let refuseDeletes: boolean;
let tunnels: Array<{ id: string; name: string; status: string }>;
let ingress: Array<Record<string, unknown>> | null;
let dns: Map<string, { id: string; name: string; type: string; content: string }>;
let accessApps: Map<string, FakeApp>;
let nextId = 0;

const ok = (result: unknown, status = 200): HttpResponse => ({ status, body: { success: true, errors: [], result } });
const http = async (method: string, p: string, opts: { json?: unknown }): Promise<HttpResponse> => {
  apiCalls.push(`${method} ${p.split('?')[0]}`);
  if (apiDown) return { status: 503, body: { success: false, errors: [{ code: 1000, message: 'down' }] } };
  const q = new URLSearchParams(p.split('?')[1] ?? '');
  const base = p.split('?')[0];
  const body = (opts.json ?? {}) as Record<string, unknown>;
  if (!base.startsWith(`/accounts/${ACCT}`) && !base.startsWith(`/zones/${ZONE}`))
    return { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } };
  if (base === `/accounts/${ACCT}/cfd_tunnel` && method === 'GET')
    return ok(tunnels.filter((t) => t.name === q.get('name')));
  if (base === `/accounts/${ACCT}/cfd_tunnel` && method === 'POST') {
    tunnels.push({ id: TUNNEL, name: String(body.name), status: 'inactive' });
    expect(body.config_src).toBe('cloudflare');
    return ok({ id: TUNNEL });
  }
  if (base === `/accounts/${ACCT}/cfd_tunnel/${TUNNEL}/token`) return ok(TOKEN);
  if (base === `/accounts/${ACCT}/cfd_tunnel/${TUNNEL}/configurations` && method === 'PUT') {
    ingress = (body.config as { ingress: Array<Record<string, unknown>> }).ingress;
    return ok({ config: body.config });
  }
  if (base === `/zones/${ZONE}/dns_records` && method === 'GET')
    return ok([...dns.values()].filter((r) => r.name === q.get('name')));
  if (base === `/zones/${ZONE}/dns_records` && method === 'POST') {
    const id = `dns${++nextId}`;
    dns.set(id, { id, name: String(body.name), type: String(body.type), content: String(body.content) });
    expect(body.proxied).toBe(true);
    return ok({ id });
  }
  if (base.startsWith(`/zones/${ZONE}/dns_records/`) && method === 'DELETE') {
    if (refuseDeletes) return { status: 500, body: { success: false, errors: [{ message: 'try later' }] } };
    const id = base.split('/').pop()!;
    if (!dns.delete(id)) return { status: 404, body: { success: false } };
    return ok({ id });
  }
  if (base === `/accounts/${ACCT}/access/apps` && method === 'GET')
    return ok([...accessApps.values()].filter((a) => a.domain === q.get('domain')));
  if (base === `/accounts/${ACCT}/access/apps` && method === 'POST') {
    const a: FakeApp = {
      id: `app${++nextId}`,
      aud: randomBytes(32).toString('hex'),
      domain: String(body.domain),
      name: String(body.name),
      body,
    };
    accessApps.set(a.id, a);
    return ok({ id: a.id, aud: a.aud, domain: a.domain, name: a.name }, 201);
  }
  if (base.startsWith(`/accounts/${ACCT}/access/apps/`)) {
    const id = base.split('/').pop()!;
    const a = accessApps.get(id);
    if (!a) return { status: 404, body: { success: false, errors: [{ message: 'not found' }] } };
    if (method === 'PUT') {
      a.body = body;
      return ok({ id: a.id, aud: a.aud, domain: a.domain, name: a.name });
    }
    if (method === 'DELETE') {
      if (refuseDeletes) return { status: 500, body: { success: false, errors: [{ message: 'try later' }] } };
      accessApps.delete(id);
      return ok({ id });
    }
  }
  return { status: 404, body: { success: false, errors: [{ message: `no route ${method} ${base}` }] } };
};

// --- Everything else ------------------------------------------------------

let routes: AppRoute[];
let env: Record<string, string>;
let gateway: GatewaySettings;
let probe: 'blocked' | 'open';
let agents: Array<{ id: string; identifier: string; secretMode: string }>;
let vaultOk: boolean;
let users: string[];
let members: Set<string>;
let ownAud: string;
let now = 1_000_000;

const admin = {
  listAllSecrets: async () =>
    vaultOk
      ? [
          {
            id: 's1',
            name: 'NanoClaw Cloudflare API token',
            hostPattern: 'api.cloudflare.com',
            pathPattern: '/client/v4/*',
          },
        ]
      : [],
  listAgents: async () => agents,
  listAgentSecretIds: async () => ['s1'],
} as unknown as OnecliAdmin;

const ON = {
  NANOCLAW_WORKLOAD_CLOUDFLARE: '1',
  NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN: 'example-apps.net',
  NANOCLAW_WORKLOAD_CLOUDFLARE_ACCOUNT_ID: ACCT,
  NANOCLAW_WORKLOAD_CLOUDFLARE_ZONE_ID: ZONE,
  NANOCLAW_WORKLOAD_CLOUDFLARE_TEAM_DOMAIN: 'team.cloudflareaccess.com',
};

beforeEach(() => {
  fs.rmSync(path.join(DATA, 'workload-cloudflare'), { recursive: true, force: true });
  containers = new Map();
  edgeExists = false;
  calls = [];
  apiCalls = [];
  apiDown = false;
  refuseDeletes = false;
  tunnels = [];
  ingress = null;
  dns = new Map();
  accessApps = new Map();
  logged.length = 0;
  routes = [NOTES];
  env = { ...ON };
  gateway = {
    on: true,
    ok: true,
    cfg: { bind: '198.51.100.1', port: 8470, internalPort: 8471, image: 'caddy@sha256:x' },
  };
  probe = 'blocked';
  agents = [{ id: 'a1', identifier: 'nanoclaw-cloudflare', secretMode: 'selective' }];
  vaultOk = true;
  users = ['webchat:owner@example.com', 'webchat:bob@example.com', 'webchat:tailscale:dan@example.com', 'slack:U1'];
  members = new Set(['webchat:owner@example.com', 'webchat:bob@example.com']);
  ownAud = 'f'.repeat(64);
  __setCloudflareDepsForTest({
    docker,
    http,
    admin,
    settings: () => cloudflareSettings((k) => env[k], { WEBCHAT_PUBLIC_URL: 'https://chat.example.com' }),
    gateway: () => gateway,
    workloadsOn: () => true,
    routes: async () => routes,
    probe: async () => probe,
    tailnetNames: async () => ['nanoclaw.tail1.ts.net'],
    ownAudience: () => ownAud,
    policy: {
      allUserIds: async () => users,
      ownerIds: async () => ['webchat:owner@example.com'],
      canAccessAgentGroup: async (u) => members.has(u),
    },
    now: () => now,
    uid: 1000,
    gid: 1000,
  });
});
afterEach(() => __setCloudflareDepsForTest(null));

const cf = () => publishingRoute('cloudflare')!;
const appFor = (host: string) => [...accessApps.values()].find((a) => a.domain === host);
const emailsIn = (a: FakeApp | undefined): string[] =>
  (
    (a?.body.policies as Array<{ decision: string; include: Array<{ email?: { email: string } }> }> | undefined)?.[0]
      ?.include ?? []
  ).flatMap((i) => (i.email ? [i.email.email] : []));

describe('Cloudflare route status', () => {
  it('is off until switched on, then names the one thing missing', async () => {
    env = {};
    expect(await __refreshCloudflareStatusForTest()).toEqual({ state: 'off', warnings: [] });
    env = { ...ON };
    gateway = { on: false };
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({ missing: /gateway is off/ });
    gateway = { on: true, ok: true, cfg: { bind: '127.0.0.1', port: 8470, internalPort: 8471, image: 'c' } };
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({
      missing: 'the app gateway must listen on the edge address: set NANOCLAW_WORKLOAD_GATEWAY_BIND=198.51.100.1',
    });
    gateway = { on: true, ok: true, cfg: { bind: '198.51.100.1', port: 8470, internalPort: 8471, image: 'c' } };
    vaultOk = false;
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({ missing: /API token is not in the vault/ });
    vaultOk = true;
    agents = [...agents, { id: 'a2', identifier: 'ag-xyz', secretMode: 'all' }];
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({ missing: /1 OneCLI identity is in "all"/ });
    agents = agents.slice(0, 1);
    probe = 'open';
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({
      missing: /host rules for the edge network are missing .*--gateway 198\.51\.100\.1:8470/,
    });
    probe = 'blocked';
    apiDown = true;
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({ missing: /did not list tunnels: down/ });
    apiDown = false;
    expect(await __refreshCloudflareStatusForTest()).toEqual({ state: 'connected', warnings: [] });
    expect(await cf().enabled()).toBe(true);
    expect(await cf().hostnameFor('notes')).toBe('notes.example-apps.net');
  });

  it('refuses an app domain on NanoClaw’s own site', async () => {
    env = { ...ON, NANOCLAW_WORKLOAD_CLOUDFLARE_DOMAIN: 'apps.example.com' };
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({
      missing: /same site as NanoClaw’s own chat\.example\.com/,
    });
  });

  it('turns nothing on while it is not connected', async () => {
    vaultOk = false;
    await tickCloudflare();
    expect(cloudflareStatus().state).toBe('missing');
    expect(containers.size).toBe(0);
    expect(apiCalls).toEqual([]);
  });
});

describe('Cloudflare route lifecycle', () => {
  it('enables: tunnel, token as a 0600 file, connector on the edge, catch-all deny', async () => {
    await tickCloudflare();
    expect(cloudflareStatus()).toEqual({ state: 'connected', warnings: [] });
    expect(tunnels).toEqual([{ id: TUNNEL, name: `nanoclaw-${INSTALL_SLUG}`, status: 'inactive' }]);
    const tokenFile = path.join(tokenDir(), TOKEN_FILE);
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(TOKEN);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(tokenDir()).mode & 0o777).toBe(0o700);
    const c = containers.get(connectorName())!;
    expect(c.running).toBe(true);
    // The token is never an argument or an environment variable: only its file's path.
    expect(c.args.join(' ')).not.toContain(TOKEN);
    expect(c.args.some((a) => /TUNNEL_TOKEN|^-e$/.test(a))).toBe(false);
    expect(c.args).toEqual(expect.arrayContaining(['--token-file', '/run/cf/token', '--ip', '198.51.100.239']));
    const catchAll = appFor('*.example-apps.net')!;
    expect(catchAll.body.policies).toEqual([
      { name: 'Nobody', decision: 'deny', include: [{ everyone: {} }], precedence: 1 },
    ]);
    // The token is in no log line.
    expect(logged.join('\n')).not.toContain(TOKEN);
    // A second pass changes nothing in Cloudflare and leaves the connector running.
    const before = apiCalls.length;
    await tickCloudflare();
    expect(apiCalls.slice(before).filter((c2) => !c2.startsWith('GET'))).toEqual([]);
    expect(calls.filter((x) => x[0] === 'run')).toHaveLength(1);
  });

  it('publishes an app: Access application, then DNS, then ingress — with cloudflared checking the token too', async () => {
    await tickCloudflare();
    const order = apiCalls.filter((c) => /POST .*access\/apps|POST .*dns_records|PUT .*configurations/.test(c));
    expect(order).toEqual([
      `POST /accounts/${ACCT}/access/apps`, // the catch-all
      `POST /accounts/${ACCT}/access/apps`, // notes
      `POST /zones/${ZONE}/dns_records`,
      `PUT /accounts/${ACCT}/cfd_tunnel/${TUNNEL}/configurations`,
    ]);
    const notes = appFor('notes.example-apps.net')!;
    expect(emailsIn(notes)).toEqual(['bob@example.com', 'owner@example.com']);
    expect([...dns.values()]).toEqual([
      expect.objectContaining({ name: 'notes.example-apps.net', type: 'CNAME', content: `${TUNNEL}.cfargotunnel.com` }),
    ]);
    expect(ingress).toEqual([
      {
        hostname: 'notes.example-apps.net',
        service: 'http://198.51.100.1:8470',
        originRequest: { access: { required: true, teamName: 'team', audTag: [notes.aud] } },
      },
      { service: 'http_status:404' },
    ]);
    expect(await cf().edgeState!(NOTES)).toEqual({ ready: true });
  });

  it('names explicit people for "specific", and keeps policies in step with membership', async () => {
    routes = [NOTES, WIKI];
    await tickCloudflare();
    expect(emailsIn(appFor('wiki.example-apps.net'))).toEqual(['carol@example.org']);
    // Someone joins the agent: the next sweep rewrites the policy.
    users.push('webchat:erin@example.com');
    members.add('webchat:erin@example.com');
    await tickCloudflare();
    expect(emailsIn(appFor('notes.example-apps.net'))).toEqual([
      'bob@example.com',
      'erin@example.com',
      'owner@example.com',
    ]);
    // Narrowed to only me: the approver alone.
    routes = [{ ...NOTES, who: 'only-me' }, WIKI];
    await tickCloudflare();
    expect(emailsIn(appFor('notes.example-apps.net'))).toEqual(['owner@example.com']);
    // Nobody left: Access denies everyone rather than allowing an empty list.
    routes = [{ ...NOTES, who: 'specific', emails: [] }, WIKI];
    await tickCloudflare();
    expect(appFor('notes.example-apps.net')!.body.policies).toEqual([
      { name: 'Nobody', decision: 'deny', include: [{ everyone: {} }], precedence: 1 },
    ]);
  });

  it('rewrites an application changed in the dashboard within the hour', async () => {
    await tickCloudflare();
    const notes = appFor('notes.example-apps.net')!;
    notes.body = { ...notes.body, policies: [{ decision: 'allow', include: [{ everyone: {} }] }] };
    await tickCloudflare();
    expect(emailsIn(appFor('notes.example-apps.net'))).toEqual([]);
    now += 61 * 60_000;
    await tickCloudflare();
    expect(emailsIn(appFor('notes.example-apps.net'))).toEqual(['bob@example.com', 'owner@example.com']);
  });

  it('makes an application deleted in the dashboard again, and keeps its hostname out of the tunnel meanwhile', async () => {
    await tickCloudflare();
    accessApps.delete(appFor('notes.example-apps.net')!.id);
    now += 61 * 60_000;
    await tickCloudflare();
    expect(await cf().edgeState!(NOTES)).toMatchObject({ ready: false, problem: /deleted in Cloudflare/ });
    expect(ingress).toEqual([{ service: 'http_status:404' }]);
    await tickCloudflare();
    expect(emailsIn(appFor('notes.example-apps.net'))).toEqual(['bob@example.com', 'owner@example.com']);
    expect(ingress?.[0]).toMatchObject({ hostname: 'notes.example-apps.net' });
    expect(await cf().edgeState!(NOTES)).toEqual({ ready: true });
  });

  it('unpublishes in reverse: out of the ingress, DNS record, then the Access application', async () => {
    await tickCloudflare();
    apiCalls = [];
    await cf().detach!(NOTES);
    expect(apiCalls.filter((c) => !c.startsWith('GET'))).toEqual([
      `PUT /accounts/${ACCT}/cfd_tunnel/${TUNNEL}/configurations`,
      expect.stringMatching(new RegExp(`^DELETE /zones/${ZONE}/dns_records/`)),
      expect.stringMatching(new RegExp(`^DELETE /accounts/${ACCT}/access/apps/`)),
    ]);
    expect(ingress).toEqual([{ service: 'http_status:404' }]);
    expect(dns.size).toBe(0);
    expect(appFor('notes.example-apps.net')).toBeUndefined();
    expect(appFor('*.example-apps.net')).toBeDefined();
    expect(loadState().apps).toEqual({});
  });

  it('retries deletes Cloudflare refused, and an app without a route is unpublished by the sweep', async () => {
    await tickCloudflare();
    refuseDeletes = true;
    routes = [];
    await tickCloudflare();
    expect(
      loadState()
        .pendingDeletes.map((p) => p.kind)
        .sort(),
    ).toEqual(['access', 'dns']);
    expect(ingress).toEqual([{ service: 'http_status:404' }]);
    await __refreshCloudflareStatusForTest();
    expect(cloudflareStatus().warnings).toContain('2 things still to be deleted in Cloudflare');
    refuseDeletes = false;
    await tickCloudflare();
    expect(loadState().pendingDeletes).toEqual([]);
    expect(dns.size).toBe(0);
    expect(appFor('notes.example-apps.net')).toBeUndefined();
  });

  it('refuses a hostname someone else already has in DNS or Access', async () => {
    dns.set('x', { id: 'x', name: 'notes.example-apps.net', type: 'A', content: '192.0.2.1' });
    await tickCloudflare();
    expect(await cf().edgeState!(NOTES)).toMatchObject({ ready: false, problem: /already has a DNS record/ });
    expect(ingress).toEqual([{ service: 'http_status:404' }]);
  });

  it('never accepts an application whose audience is NanoClaw’s own', async () => {
    await tickCloudflare();
    const aud = appFor('notes.example-apps.net')!.aud;
    ownAud = aud;
    expect(await __refreshCloudflareStatusForTest()).toMatchObject({ missing: /equals WEBCHAT_CF_ACCESS_AUD/ });
  });

  it('switched off: connector gone, token removed, every app’s records deleted', async () => {
    routes = [NOTES, WIKI];
    await tickCloudflare();
    await tickCloudflare(false);
    expect(containers.size).toBe(0);
    expect(fs.existsSync(path.join(tokenDir(), TOKEN_FILE))).toBe(false);
    expect(dns.size).toBe(0);
    expect([...accessApps.values()].map((a) => a.domain)).toEqual(['*.example-apps.net']);
    expect(cloudflareStatus().state).toBe('off');
    // Off and settled: later passes do nothing.
    calls = [];
    await tickCloudflare(false);
    expect(calls).toEqual([]);
  });
});

// --- Who the gateway believes -------------------------------------------------

describe('Cloudflare identity', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const sign = (claims: Record<string, unknown>, kid = 'k1'): string => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const fetchSpy = vi.fn(async (url: string | URL) => {
    if (String(url) !== 'https://team.cloudflareaccess.com/cdn-cgi/access/certs') throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const claims = (aud: string, extra: Record<string, unknown> = {}) => ({
    iss: 'https://team.cloudflareaccess.com',
    aud: [aud],
    email: 'Bob@Example.com',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    ...extra,
  });

  it('believes a token for THIS app’s audience, from the connector only', async () => {
    routes = [NOTES, WIKI];
    await tickCloudflare();
    const notesAud = appFor('notes.example-apps.net')!.aud;
    const wikiAud = appFor('wiki.example-apps.net')!.aud;
    const app = { id: NOTES.id, app: 'notes', hostname: 'notes.example-apps.net', agentGroupId: 'ag-1' };
    const ask = (token: string, peer = '198.51.100.239') =>
      cf().identify({ headers: { 'cf-access-jwt-assertion': token }, peer }, app);
    expect(await ask(sign(claims(notesAud)))).toEqual({
      userId: 'webchat:bob@example.com',
      displayName: 'Bob@Example.com',
    });
    // Another app's token, NanoClaw's own, an expired one, a wrong issuer, an unknown key, no email.
    expect(await ask(sign(claims(wikiAud)))).toBeNull();
    expect(await ask(sign(claims(ownAud)))).toBeNull();
    expect(await ask(sign(claims(notesAud, { exp: Math.floor(Date.now() / 1000) - 3600 })))).toBeNull();
    expect(await ask(sign(claims(notesAud, { nbf: Math.floor(Date.now() / 1000) + 3600 })))).toBeNull();
    expect(await ask(sign(claims(notesAud, { iss: 'https://other.cloudflareaccess.com' })))).toBeNull();
    expect(await ask(sign(claims(notesAud), 'k2'))).toBeNull();
    expect(await ask(sign(claims(notesAud, { email: undefined, common_name: 'svc' })))).toBeNull();
    // A forged signature.
    const t = sign(claims(notesAud)).split('.');
    expect(
      await ask(
        `${t[0]}.${Buffer.from(JSON.stringify(claims(notesAud, { email: 'eve@example.com' }))).toString('base64url')}.${t[2]}`,
      ),
    ).toBeNull();
    // The right token, from anywhere but the connector: a sidecar, the host, loopback.
    for (const peer of ['198.51.100.2', '198.51.100.1', '127.0.0.1'])
      expect(await ask(sign(claims(notesAud)), peer)).toBeNull();
  });
});
