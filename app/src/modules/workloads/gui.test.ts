/**
 * Agent → Apps, against a real database with a publishing route stood in:
 * a person's narrowing applies at once, a widening only raises a card (whoever
 * asks), and the card's answer applies exactly what it pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cards = vi.hoisted(() => ({
  requests: [] as Array<{ action: string; payload: Record<string, unknown>; title: string; question: string }>,
  handler: null as
    | null
    | ((ctx: { payload: Record<string, unknown>; outcome: string; userId: string }) => Promise<void>),
  answer: 'appr-1' as string | null,
}));
vi.mock('../approvals/sessionless.js', () => ({
  registerSessionlessApprovalHandler: (_a: string, h: typeof cards.handler) => {
    cards.handler = h;
  },
  requestSessionlessApproval: async (req: (typeof cards.requests)[number]) => {
    cards.requests.push(req);
    return cards.answer;
  },
}));

const { closeDb, getDb, initTestDb } = await import('../../db/connection.js');
const { runMigrations } = await import('../../db/migrations/index.js');
const { createPendingApproval } = await import('../../db/sessions.js');
const gui = await import('./gui.js');
const { registerPublishingRoute, __clearPublishingRoutesForTest } = await import('./gateway/publishing.js');
const { insertWorkload, updateWorkload } = await import('./store.js');
const { findRouteByApp, insertRoute } = await import('./routes.js');

let routesOn: Array<'tailnet' | 'cloudflare'> = ['tailnet', 'cloudflare'];
let admins = new Set(['webchat:admin']);

async function workload(name: string, expose: unknown[] = ['8080']) {
  const w = await insertWorkload({
    agentGroupId: 'ag-1',
    name,
    composeText: 'services: {}',
    stack: {
      compose: { services: { web: { image: 'nginx:1.27', expose } } },
      limits: { web: { memoryMb: 256, cpus: 0.25 } },
      total: { memoryMb: 256, cpus: 0.25 },
    },
    addresses: { web: '198.18.0.10' },
    expiresAt: null,
    createdBy: 'agent:ag-1',
    approvedShape: null,
  });
  return updateWorkload(w.id, { state: 'running' });
}

async function published(name: string, kind: 'tailnet' | 'cloudflare', who: string, emails: string[] = []) {
  const w = await workload(name);
  return insertRoute({
    app: name,
    workloadId: w.id,
    agentGroupId: 'ag-1',
    service: 'web',
    port: 8080,
    kind,
    who: who as never,
    emails,
    ownerUserId: 'webchat:owner',
    ticket: null,
    createdBy: 'test',
  });
}

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '8470');
  vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', '');
  cards.requests = [];
  cards.answer = 'appr-1';
  routesOn = ['tailnet', 'cloudflare'];
  admins = new Set(['webchat:admin']);
  gui.setPublishDeps({ isAdmin: async (u) => admins.has(u) });
  __clearPublishingRoutesForTest();
  for (const kind of ['tailnet', 'cloudflare'] as const)
    registerPublishingRoute({
      kind,
      label: kind === 'tailnet' ? 'your tailnet' : 'Cloudflare',
      enabled: async () => routesOn.includes(kind),
      hostnameFor: async (app) => (kind === 'tailnet' ? `${app}.tail1.ts.net` : `${app}.apps.net`),
      identify: async () => null,
    });
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  __clearPublishingRoutesForTest();
});

describe('classifyChange', () => {
  const s = (route: 'off' | 'tailnet' | 'cloudflare', who = 'only-me', emails: string[] = []) => ({
    route,
    who: who as never,
    emails,
  });
  it('narrowing: Off, a narrower rule, fewer people', () => {
    expect(gui.classifyChange(s('tailnet', 'signed-in'), s('off'))).toBe('narrow');
    expect(gui.classifyChange(s('tailnet', 'signed-in'), s('tailnet', 'agent-members'))).toBe('narrow');
    expect(
      gui.classifyChange(s('cloudflare', 'specific', ['a@x.io', 'b@x.io']), s('cloudflare', 'specific', ['a@x.io'])),
    ).toBe('narrow');
  });
  it('widening: publish, a route change, a wider rule, anyone new', () => {
    expect(gui.classifyChange(s('off'), s('tailnet'))).toBe('widen');
    expect(gui.classifyChange(s('cloudflare'), s('tailnet'))).toBe('widen');
    expect(gui.classifyChange(s('tailnet'), s('tailnet', 'agent-members'))).toBe('widen');
    expect(gui.classifyChange(s('cloudflare', 'specific', ['a@x.io']), s('cloudflare', 'specific', ['b@x.io']))).toBe(
      'widen',
    );
  });
  it('the same setting is nothing', () => {
    expect(gui.classifyChange(s('off'), s('off'))).toBe('none');
    expect(gui.classifyChange(s('tailnet', 'signed-in'), s('tailnet', 'signed-in'))).toBe('none');
  });
});

describe('exposable / pickTarget', () => {
  const w = (services: Record<string, Record<string, unknown>>, addresses: Record<string, string>) => ({
    stack: { compose: { services }, limits: {}, total: { memoryMb: 0, cpus: 0 } } as never,
    addresses,
  });
  it('each service with an address that declares an expose port', () => {
    const one = w({ web: { expose: ['3000/tcp'] }, db: {} }, { web: 'a', db: 'b' });
    expect(gui.exposable(one)).toEqual([{ service: 'web', port: 3000 }]);
    expect(gui.pickTarget(one)).toEqual({ service: 'web', port: 3000 });
    expect(gui.exposable(w({ web: {} }, { web: 'a' }))).toEqual([]);
    expect(gui.exposable(w({ web: { expose: ['8080'] } }, {}))).toEqual([]);
  });
  it('several: only the one the person picked', () => {
    const two = w({ b: { expose: [81] }, a: { expose: [80] } }, { a: 'x', b: 'y' });
    expect(gui.exposable(two).map((t) => t.service)).toEqual(['a', 'b']);
    expect(gui.pickTarget(two)).toBeNull();
    expect(gui.pickTarget(two, 'b')).toEqual({ service: 'b', port: 81 });
    expect(gui.pickTarget(two, 'c')).toBeNull();
  });
});

describe('a person’s change', () => {
  it('unpublishing applies at once, with no card', async () => {
    await published('notes', 'tailnet', 'signed-in');
    const r = await gui.changeApp('ag-1', 'webchat:admin', { workload: 'notes', app: 'notes', route: 'off' });
    expect(r).toEqual({ change: 'narrow', applied: true, pending: false });
    expect(await findRouteByApp('notes')).toBeNull();
    expect(cards.requests).toHaveLength(0);
  });

  it('a narrower rule applies at once and keeps who "only me" means', async () => {
    await published('notes', 'tailnet', 'signed-in');
    const r = await gui.changeApp('ag-1', 'webchat:admin', {
      workload: 'notes',
      app: 'notes',
      route: 'tailnet',
      who: 'only-me',
    });
    expect(r.applied).toBe(true);
    const row = await findRouteByApp('notes');
    expect(row?.who).toBe('only-me');
    expect(row?.ownerUserId).toBe('webchat:owner');
    expect(cards.requests).toHaveLength(0);
  });

  it('removing people applies at once; adding one is a card', async () => {
    await published('notes', 'cloudflare', 'specific', ['a@x.io', 'b@x.io']);
    const fewer = await gui.changeApp('ag-1', 'webchat:admin', {
      workload: 'notes',
      app: 'notes',
      route: 'cloudflare',
      who: 'specific',
      emails: ['a@x.io'],
    });
    expect(fewer.applied).toBe(true);
    expect((await findRouteByApp('notes'))?.emails).toEqual(['a@x.io']);
    const more = await gui.changeApp('ag-1', 'webchat:admin', {
      workload: 'notes',
      app: 'notes',
      route: 'cloudflare',
      who: 'specific',
      emails: 'a@x.io, c@x.io',
    });
    expect(more).toEqual({ change: 'widen', applied: false, pending: true });
    expect((await findRouteByApp('notes'))?.emails).toEqual(['a@x.io']);
    expect(cards.requests[0].payload).toMatchObject({ app: 'notes', who: 'specific', emails: ['a@x.io', 'c@x.io'] });
  });

  it('publishing an unpublished workload raises a card and changes nothing yet', async () => {
    await workload('notes');
    const r = await gui.changeApp('ag-1', 'webchat:owner', { workload: 'notes', route: 'tailnet' });
    expect(r.pending).toBe(true);
    expect(await findRouteByApp('notes')).toBeNull();
    expect(cards.requests).toHaveLength(1);
    const c = cards.requests[0];
    expect(c.action).toBe(gui.PUBLISH_ACTION);
    expect(c.title).toBe('Publish notes');
    expect(c.question).toContain('on your tailnet for only them');
    expect(c.question).toContain('https://notes.tail1.ts.net/');
    expect(c.payload).toMatchObject({
      agentGroupId: 'ag-1',
      workload: 'notes',
      app: 'notes',
      service: 'web',
      port: 8080,
      route: 'tailnet',
      who: 'only-me',
      requestedBy: 'webchat:owner',
    });
  });

  it('a route change and a wider rule are cards too', async () => {
    await published('notes', 'tailnet', 'only-me');
    expect(
      (await gui.changeApp('ag-1', 'webchat:admin', { workload: 'notes', app: 'notes', route: 'cloudflare' })).pending,
    ).toBe(true);
    await published('wiki', 'tailnet', 'only-me');
    expect(
      (
        await gui.changeApp('ag-1', 'webchat:admin', {
          workload: 'wiki',
          app: 'wiki',
          route: 'tailnet',
          who: 'signed-in',
        })
      ).pending,
    ).toBe(true);
    expect((await findRouteByApp('notes'))?.kind).toBe('tailnet');
    expect((await findRouteByApp('wiki'))?.who).toBe('only-me');
  });

  it('refuses a second request while one waits, a route that is off, and an unknown service', async () => {
    await workload('notes');
    await createPendingApproval({
      approval_id: 'appr-x',
      session_id: null,
      request_id: 'appr-x',
      action: gui.PUBLISH_ACTION,
      payload: JSON.stringify({ agentGroupId: 'ag-1', app: 'notes', workload: 'notes' }),
      created_at: new Date().toISOString(),
      instance: null,
      title: 'Publish notes',
      question: 'q',
      options_json: '[]',
      approver_user_id: null,
    } as never);
    await expect(gui.changeApp('ag-1', 'webchat:admin', { workload: 'notes', route: 'tailnet' })).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    routesOn = ['cloudflare'];
    await workload('wiki');
    await expect(gui.changeApp('ag-1', 'webchat:admin', { workload: 'wiki', route: 'tailnet' })).rejects.toThrow(
      /tailnet route is not on/,
    );
    await workload('db', []);
    await expect(gui.changeApp('ag-1', 'webchat:admin', { workload: 'db', route: 'cloudflare' })).rejects.toThrow(
      /ask the agent to publish it/,
    );
  });

  it('several exposable services: the person picks one, else it is refused', async () => {
    const w = await insertWorkload({
      agentGroupId: 'ag-1',
      name: 'pair',
      composeText: 'services: {}',
      stack: {
        compose: { services: { api: { image: 'x', expose: ['9000'] }, web: { image: 'y', expose: ['8080'] } } },
        limits: {},
        total: { memoryMb: 0, cpus: 0 },
      } as never,
      addresses: { api: '198.18.0.11', web: '198.18.0.12' },
      expiresAt: null,
      createdBy: 'agent:ag-1',
      approvedShape: null,
    });
    await updateWorkload(w.id, { state: 'running' });
    expect((await gui.appsOf('ag-1')).apps.find((a) => a.workload === 'pair')?.services).toEqual(['api', 'web']);
    await expect(gui.changeApp('ag-1', 'webchat:admin', { workload: 'pair', route: 'tailnet' })).rejects.toThrow(
      /Pick a service/,
    );
    const r = await gui.changeApp('ag-1', 'webchat:admin', { workload: 'pair', route: 'tailnet', service: 'api' });
    expect(r.pending).toBe(true);
    expect(cards.requests[0].payload).toMatchObject({ service: 'api', port: 9000 });
  });

  it('Specific people is Cloudflare only and needs someone named', async () => {
    await workload('notes');
    await expect(
      gui.changeApp('ag-1', 'webchat:admin', {
        workload: 'notes',
        route: 'tailnet',
        who: 'specific',
        emails: 'a@x.io',
      }),
    ).rejects.toThrow(/Cloudflare only/);
    await expect(
      gui.changeApp('ag-1', 'webchat:admin', { workload: 'notes', route: 'cloudflare', who: 'specific', emails: '' }),
    ).rejects.toThrow(/at least one/);
  });

  it('another agent’s app is not found', async () => {
    await published('notes', 'tailnet', 'only-me');
    await expect(
      gui.changeApp('ag-2', 'webchat:admin', { workload: 'notes', app: 'notes', route: 'off' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('the card’s answer', () => {
  async function ask() {
    await workload('notes');
    await gui.changeApp('ag-1', 'webchat:admin', { workload: 'notes', route: 'tailnet', who: 'agent-members' });
    return cards.requests[0].payload;
  }

  it('approve applies what the card pinned; the asker becomes its "only me"', async () => {
    const payload = await ask();
    await cards.handler!({ payload, outcome: 'approve', userId: 'webchat:owner' });
    const r = await findRouteByApp('notes');
    expect(r).toMatchObject({
      kind: 'tailnet',
      who: 'agent-members',
      ownerUserId: 'webchat:admin',
      service: 'web',
      port: 8080,
    });
  });

  it('reject changes nothing', async () => {
    const payload = await ask();
    await cards.handler!({ payload, outcome: 'reject', userId: 'webchat:owner' });
    expect(await findRouteByApp('notes')).toBeNull();
  });

  it('nothing happens when the asker lost the agent, or the app moved since', async () => {
    const payload = await ask();
    admins.delete('webchat:admin');
    await cards.handler!({ payload, outcome: 'approve', userId: 'webchat:owner' });
    expect(await findRouteByApp('notes')).toBeNull();
    admins.add('webchat:admin');
    await cards.handler!({
      payload: { ...payload, hostname: 'elsewhere.tail1.ts.net' },
      outcome: 'approve',
      userId: 'webchat:owner',
    });
    expect(await findRouteByApp('notes')).toBeNull();
    await expect(gui.applyApprovedPublish({ ...payload, route: 'nowhere' })).rejects.toThrow(/malformed/);
  });
});

describe('the list', () => {
  it('one row per app, unpublished workloads with route Off, cards waiting as Needs approval', async () => {
    await published('notes', 'tailnet', 'agent-members');
    await workload('wiki');
    await createPendingApproval({
      approval_id: 'appr-cli',
      session_id: null,
      request_id: 'appr-cli',
      action: 'cli_command',
      payload: JSON.stringify({
        frame: { command: 'workloads-up', args: { name: 'blog' } },
        callerContext: { caller: 'agent', agentGroupId: 'ag-1' },
      }),
      created_at: new Date().toISOString(),
      instance: null,
      title: 't',
      question: 'q',
      options_json: '[]',
      approver_user_id: null,
    } as never);
    const v = await gui.appsOf('ag-1');
    expect(v.routes).toEqual(['tailnet', 'cloudflare']);
    expect(v.apps.map((a) => [a.app, a.workload, a.route, a.state, a.canPublish, a.deployed])).toEqual([
      ['notes', 'notes', 'tailnet', 'running', true, true],
      [null, 'wiki', 'off', 'running', true, true],
      [null, 'blog', 'off', 'needs-approval', false, false],
    ]);
    expect((await gui.appsOf('ag-2')).apps).toEqual([]);
  });
});
