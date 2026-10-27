/**
 * Agent → Apps and Admin → Publishing over HTTP: who may call them, the CSRF
 * header on every write, a narrowing applied at once and a widening answered
 * 202 with a card raised (never applied), and Connect handing a secret on
 * without ever sending it back.
 *
 * Same boot/teardown as agent-egress.test.ts. Docker, the vault and the
 * approval cards are stood in; the database is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbDriver } from '../../db/driver.js';
import type { WebchatServer } from './server.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

const fx = vi.hoisted(() => ({
  cards: [] as Array<Record<string, unknown>>,
  env: [] as Array<[string, string | null]>,
  connected: [] as string[][],
  control: [] as string[],
}));

vi.mock('../../modules/approvals/sessionless.js', () => ({
  registerSessionlessApprovalHandler: () => undefined,
  resolveSessionlessApproval: async () => false,
  requestSessionlessApproval: async (req: Record<string, unknown>) => {
    fx.cards.push(req);
    return 'appr-1';
  },
}));
vi.mock('./env-write.js', () => ({
  upsertEnv: (_root: string, k: string, v: string) => void fx.env.push([k, v]),
  removeEnv: (_root: string, k: string) => void fx.env.push([k, null]),
}));
vi.mock('../../modules/workloads/tailnet/credential.js', async (orig) => ({
  ...(await orig<typeof import('../../modules/workloads/tailnet/credential.js')>()),
  connectTailnetClient: async (_a: unknown, id: string, secret: string) => {
    if (!secret.startsWith('tskey-client-')) throw new Error(`OneCLI refused ${secret}`);
    fx.connected.push([id, secret]);
  },
}));
vi.mock('../../modules/workloads/control.js', () => ({
  startWorkload: async (_g: string, n: string) => (fx.control.push(`start ${n}`), { state: 'running' }),
  stopWorkload: async (_g: string, n: string) => (fx.control.push(`stop ${n}`), { state: 'stopped' }),
  deleteWorkload: async (_g: string, n: string) => (fx.control.push(`delete ${n}`), { state: 'deleted' }),
  logsWorkload: async () => 'web-1  | listening on 8080',
  backupsOf: async () => [{ stamp: '20261026T010000Z', at: '2026-10-26 01:00 UTC', volumes: [] }],
  restoreWorkload: async (_g: string, n: string, b: string) => (fx.control.push(`restore ${n} ${b}`), {}),
}));

afterEach(resetServerModules);

const now = '2026-10-26T00:00:00.000Z';
async function seed(db: DbDriver): Promise<void> {
  const { user, group, role } = seeder(db, now);
  await group('ag-a');
  await group('ag-b');
  await role('webchat:owner', 'owner', null);
  await role('webchat:admina', 'admin', 'ag-a');
  await user('webchat:member');
  await db.run(
    `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    'webchat:member',
    'ag-a',
    now,
  );
}

describe('Agent → Apps and Admin → Publishing', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    fx.cards = [];
    fx.env = [];
    fx.connected = [];
    fx.control = [];
    vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '8470');
    ({ server, wc, port } = await startServer(PROXY_ENV, seed));
    const pub = await import('../../modules/workloads/gateway/publishing.js');
    pub.registerPublishingRoute({
      kind: 'tailnet',
      label: 'your tailnet',
      enabled: async () => true,
      hostnameFor: async (app) => `${app}.tail1.ts.net`,
      identify: async () => null,
    });
    const store = await import('../../modules/workloads/store.js');
    const routes = await import('../../modules/workloads/routes.js');
    const mk = async (name: string) => {
      const w = await store.insertWorkload({
        agentGroupId: 'ag-a',
        name,
        composeText: 'services: {}',
        stack: {
          compose: { services: { web: { image: 'nginx:1.27', expose: ['8080'] } } },
          limits: { web: { memoryMb: 256, cpus: 0.25 } },
          total: { memoryMb: 256, cpus: 0.25 },
        },
        addresses: { web: '198.18.0.10' },
        expiresAt: null,
        createdBy: 'agent:ag-a',
        approvedShape: null,
      });
      return store.updateWorkload(w.id, { state: 'running' });
    };
    const notes = await mk('notes');
    await mk('wiki');
    await routes.insertRoute({
      app: 'notes',
      workloadId: notes.id,
      agentGroupId: 'ag-a',
      service: 'web',
      port: 8080,
      kind: 'tailnet',
      who: 'signed-in',
      ownerUserId: 'webchat:owner',
      ticket: null,
      createdBy: 'test',
    });
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });

  const as = (n: string, csrf = true) => ({
    'x-forwarded-user': n,
    'content-type': 'application/json',
    ...(csrf ? { 'x-webchat-csrf': '1' } : {}),
  });
  const req = (method: string, path: string, who: string, body?: unknown, csrf = true) =>
    httpRequest(port, method, path, as(who, csrf), body === undefined ? undefined : JSON.stringify(body));
  const route = async (app: string) => (await import('../../modules/workloads/routes.js')).findRouteByApp(app);

  describe('who may see an agent’s apps', () => {
    it('its scoped admin and the owner; not a member, not another agent’s admin', async () => {
      const a = await req('GET', '/api/agents/ag-a/apps', 'admina');
      expect(a.status).toBe(200);
      const v = JSON.parse(a.body);
      expect(v.routes).toEqual(['tailnet']);
      expect(v.apps.map((x: { app: string | null; workload: string }) => x.app ?? x.workload)).toEqual([
        'notes',
        'wiki',
      ]);
      expect((await req('GET', '/api/agents/ag-a/apps', 'owner')).status).toBe(200);
      expect((await req('GET', '/api/agents/ag-a/apps', 'member')).status).toBe(403);
      expect((await req('GET', '/api/agents/ag-b/apps', 'admina')).status).toBe(403);
      expect((await req('GET', '/api/agents/ag-nope/apps', 'owner')).status).toBe(404);
    });
  });

  describe('changing an app', () => {
    it('every write needs the CSRF header', async () => {
      const r = await req(
        'PUT',
        '/api/agents/ag-a/apps',
        'admina',
        { workload: 'notes', app: 'notes', route: 'off' },
        false,
      );
      expect(r.status).toBe(403);
      expect(await route('notes')).not.toBeNull();
      expect((await req('POST', '/api/agents/ag-a/workloads/notes/stop', 'admina', {}, false)).status).toBe(403);
      expect((await req('DELETE', '/api/agents/ag-a/workloads/notes', 'admina', undefined, false)).status).toBe(403);
      expect(fx.control).toEqual([]);
    });

    it('a member cannot change anything', async () => {
      const r = await req('PUT', '/api/agents/ag-a/apps', 'member', { workload: 'notes', app: 'notes', route: 'off' });
      expect(r.status).toBe(403);
      expect(await route('notes')).not.toBeNull();
    });

    it('narrowing applies at once: unpublish, a narrower rule', async () => {
      const narrower = await req('PUT', '/api/agents/ag-a/apps', 'admina', {
        workload: 'notes',
        app: 'notes',
        route: 'tailnet',
        who: 'agent-members',
      });
      expect(narrower.status).toBe(200);
      expect((await route('notes'))?.who).toBe('agent-members');
      const off = await req('PUT', '/api/agents/ag-a/apps', 'admina', {
        workload: 'notes',
        app: 'notes',
        route: 'off',
      });
      expect(off.status).toBe(200);
      expect(JSON.parse(off.body)).toEqual({ change: 'narrow', applied: true, pending: false });
      expect(await route('notes')).toBeNull();
      expect(fx.cards).toEqual([]);
    });

    it('widening answers 202 and raises a card, even for the owner; nothing changes yet', async () => {
      const r = await req('PUT', '/api/agents/ag-a/apps', 'owner', { workload: 'wiki', route: 'tailnet' });
      expect(r.status).toBe(202);
      expect(JSON.parse(r.body)).toEqual({ change: 'widen', applied: false, pending: true });
      expect(await route('wiki')).toBeNull();
      expect(fx.cards).toHaveLength(1);
      expect(fx.cards[0]).toMatchObject({ action: 'workloads_publish', title: 'Publish wiki' });
    });

    it('refusals come back as 400 with the reason', async () => {
      const r = await req('PUT', '/api/agents/ag-a/apps', 'admina', {
        workload: 'notes',
        app: 'notes',
        route: 'sideways',
      });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).error).toMatch(/route must be/);
      expect((await req('PUT', '/api/agents/ag-a/apps', 'admina', { workload: 'ghost', route: 'off' })).status).toBe(
        404,
      );
    });
  });

  describe('a person’s workload actions', () => {
    it('stop, start, logs, backups, restore and delete, for the agent’s admins', async () => {
      expect((await req('POST', '/api/agents/ag-a/workloads/notes/stop', 'admina', {})).status).toBe(200);
      expect((await req('POST', '/api/agents/ag-a/workloads/notes/start', 'admina', {})).status).toBe(200);
      expect(JSON.parse((await req('GET', '/api/agents/ag-a/workloads/notes/logs', 'admina')).body).logs).toContain(
        'listening',
      );
      expect(
        JSON.parse((await req('GET', '/api/agents/ag-a/workloads/notes/backups', 'admina')).body).backups,
      ).toHaveLength(1);
      expect(
        (await req('POST', '/api/agents/ag-a/workloads/notes/restore', 'admina', { backup: '20261026T010000Z' }))
          .status,
      ).toBe(200);
      expect((await req('DELETE', '/api/agents/ag-a/workloads/notes', 'admina')).status).toBe(200);
      expect(fx.control).toEqual(['stop notes', 'start notes', 'restore notes 20261026T010000Z', 'delete notes']);
      expect((await req('POST', '/api/agents/ag-a/workloads/notes/stop', 'member', {})).status).toBe(403);
      expect((await req('GET', '/api/agents/ag-a/workloads/notes/logs', 'member')).status).toBe(403);
      expect((await req('POST', '/api/agents/ag-a/workloads/notes/logs', 'admina', {})).status).toBe(405);
    });
  });

  describe('Admin → Publishing', () => {
    it('is the owner’s alone', async () => {
      expect((await req('GET', '/api/publishing', 'owner')).status).toBe(200);
      expect((await req('GET', '/api/publishing', 'admina')).status).toBe(403);
      expect((await req('PUT', '/api/publishing/tailnet', 'admina', { on: true })).status).toBe(403);
      expect((await req('PUT', '/api/publishing/tailnet', 'owner', { on: true }, false)).status).toBe(403);
      expect(fx.env).toEqual([]);
    });

    it('the switch writes the .env key and the status line answers', async () => {
      const r = await req('PUT', '/api/publishing/tailnet', 'owner', { on: true, domain: 'tail1234.ts.net' });
      expect(r.status).toBe(200);
      expect(fx.env).toEqual([
        ['NANOCLAW_WORKLOAD_TAILNET_DOMAIN', 'tail1234.ts.net'],
        ['NANOCLAW_WORKLOAD_TAILNET', '1'],
      ]);
      const v = JSON.parse(r.body);
      expect(v.tailnet).toMatchObject({ on: true, domain: 'tail1234.ts.net' });
      expect(typeof v.tailnet.status.text).toBe('string');
      expect((await req('PUT', '/api/publishing/tailnet', 'owner', { on: false })).status).toBe(200);
      expect(fx.env.at(-1)).toEqual(['NANOCLAW_WORKLOAD_TAILNET', null]);
    });

    it('refuses a Cloudflare app domain on NanoClaw’s own site, inline', async () => {
      vi.stubEnv('WEBCHAT_PUBLIC_URL', 'https://chat.example.com');
      const r = await req('PUT', '/api/publishing/cloudflare', 'owner', { domain: 'apps.example.com' });
      expect(r.status).toBe(400);
      const b = JSON.parse(r.body);
      expect(b.field).toBe('domain');
      expect(b.error).toBe('Same site as NanoClaw (example.com)');
      expect(fx.env).toEqual([]);
      const ok = await req('PUT', '/api/publishing/cloudflare', 'owner', {
        domain: 'example-apps.net',
        accountId: 'a'.repeat(32),
      });
      expect(ok.status).toBe(200);
    });

    it('Connect hands the secret on and never sends it back, not even in an error', async () => {
      const ok = await req('POST', '/api/publishing/tailnet/connect', 'owner', {
        clientId: 'kXyz123',
        clientSecret: 'tskey-client-abcdefgh123',
      });
      expect(ok.status).toBe(200);
      expect(fx.connected).toEqual([['kXyz123', 'tskey-client-abcdefgh123']]);
      expect(ok.body).not.toContain('tskey-client-abcdefgh123');
      const bad = await req('POST', '/api/publishing/tailnet/connect', 'owner', {
        clientId: 'kXyz123',
        clientSecret: 'nottherightshape',
      });
      expect(bad.status).toBe(400);
      expect(bad.body).not.toContain('nottherightshape');
    });
  });
});
