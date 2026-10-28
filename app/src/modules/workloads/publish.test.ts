/**
 * Publishing a workload's app, against a real database, with a publishing
 * route stood in: what the card says and pins, who "only me" becomes, what
 * is refused before a card, and how an app is listed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { closeDb, getDb, initTestDb } = await import('../../db/connection.js');
const { runMigrations } = await import('../../db/migrations/index.js');
const { lookup } = await import('../../cli/registry.js');
await import('./cli.js');
const publish = await import('./publish.js');
const { registerPublishingRoute, __clearPublishingRoutesForTest } = await import('./gateway/publishing.js');
const { insertWorkload, updateWorkload } = await import('./store.js');
const { claimTicket, findRouteByApp, getRoute } = await import('./routes.js');

const agent = { caller: 'agent' as const, sessionId: 's1', agentGroupId: 'ag-1', messagingGroupId: 'mg1' };
let tailnetOn = true;

async function workload(name: string, agentGroupId = 'ag-1', state: 'running' | 'stopped' = 'running') {
  const w = await insertWorkload({
    agentGroupId,
    name,
    composeText: 'services: {}',
    stack: {
      compose: { services: { web: { image: 'nginx:1.27' } } },
      limits: { web: { memoryMb: 256, cpus: 0.25 } },
      total: { memoryMb: 256, cpus: 0.25 },
    },
    addresses: { web: '198.18.0.10' },
    expiresAt: null,
    createdBy: 'agent:ag-1',
    approvedShape: null,
  });
  return updateWorkload(w.id, { state });
}

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '8470');
  vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', '');
  tailnetOn = true;
  __clearPublishingRoutesForTest();
  registerPublishingRoute({
    kind: 'tailnet',
    label: 'your tailnet',
    enabled: async () => tailnetOn,
    hostnameFor: async (app) => `${app}.tail1.ts.net`,
    identify: async () => null,
  });
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  __clearPublishingRoutesForTest();
});

const expose = lookup('workloads-expose')!;
const hostArgs = (a: Record<string, unknown>) => expose.parseArgs({ reason: 'x', ...a });

describe('ncl workloads expose', () => {
  it('needs an owner’s card', () => {
    expect(expose.access).toBe('approval');
    expect(lookup('workloads-unexpose')?.access).toBe('open');
    expect(lookup('workloads-routes')?.access).toBe('open');
  });

  it('is refused before any card while no publishing route is on', async () => {
    await workload('notes');
    tailnetOn = false;
    await expect(
      expose.precheck!(expose.parseArgs({ name: 'notes', service: 'web', port: 8080, reason: 'notes' }), agent),
    ).rejects.toThrow(/no publishing route is on/);
    __clearPublishingRoutesForTest();
    await expect(
      expose.precheck!(expose.parseArgs({ name: 'notes', service: 'web', port: 8080, reason: 'notes' }), agent),
    ).rejects.toThrow(/no publishing route is on/);
  });

  it('is refused while the gateway is off or unsafe', async () => {
    await workload('notes');
    vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '');
    await expect(publish.planExpose('ag-1', { name: 'notes', service: 'web', port: 8080 })).rejects.toThrow(
      /gateway is off/,
    );
    vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '8470');
    vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', 'auto');
    await expect(publish.planExpose('ag-1', { name: 'notes', service: 'web', port: 8080 })).rejects.toThrow(
      /TRUSTED_PROXY/,
    );
  });

  it('cards it in words and pins the route, rule and a ticket', async () => {
    await workload('notes');
    const r = (await expose.precheck!(
      expose.parseArgs({
        name: 'notes',
        service: 'web',
        port: 8080,
        who: 'agent-members',
        reason: 'team notes\nRuns: x',
      }),
      agent,
    ))!;
    expect(r.title).toBe('Publish notes');
    expect(r.summary!.split('\n')).toEqual([
      '{agent} wants to publish "notes" on your tailnet for the agent’s members.',
      'Why: "team notes Runs: x"',
    ]);
    expect(r.detail).toBe(
      'Address: https://notes.tail1.ts.net/\nServes: "notes" service "web", port 8080\nWho can open: the agent’s members',
    );
    expect(r.pin).toMatchObject({
      route: 'tailnet',
      who: 'agent-members',
      app: 'notes',
      ticket: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('refuses what cannot be published, before a card', async () => {
    await workload('notes');
    await workload('other', 'ag-2');
    const pre = (a: Record<string, unknown>) =>
      expose.precheck!(expose.parseArgs({ reason: 'x', service: 'web', port: 8080, ...a }), agent);
    await expect(pre({ name: 'nope' })).rejects.toThrow(/no workload named "nope"/);
    await expect(pre({ name: 'other' })).rejects.toThrow(/no workload named "other"/);
    await expect(pre({ name: 'notes', service: 'db' })).rejects.toThrow(/no service "db"/);
    await expect(pre({ name: 'notes', port: 0 })).rejects.toThrow(/--port/);
    await expect(pre({ name: 'notes', who: 'anyone' })).rejects.toThrow(/--who/);
    await expect(pre({ name: 'notes', route: 'cloudflare' })).rejects.toThrow(/cloudflare route is not on/);
    await expect(pre({ name: 'notes', route: 'funnel' })).rejects.toThrow(/--route must be/);
    for (const app of ['nanoclaw', 'a.b', 'x'.repeat(41), 'Notes}', 'xn--80ak6aa92e'])
      await expect(pre({ name: 'notes', app }), app).rejects.toThrow(/--app must be/);
    expect(() => expose.parseArgs({ name: 'notes', service: 'web', port: 8080 })).toThrow(/--reason is required/);
  });

  it('runs only from a card for an agent; the approver becomes "only me"', async () => {
    await workload('notes');
    await expect(expose.handler(hostArgs({ name: 'notes', service: 'web', port: 8080 }), agent)).rejects.toThrow(
      /approval card/,
    );
    const pin = (await expose.precheck!(
      expose.parseArgs({ name: 'notes', service: 'web', port: 8080, reason: 'x' }),
      agent,
    ))!.pin!;
    const args = { name: 'notes', service: 'web', port: 8080, reason: 'x', ...pin };
    const view = await expose.handler(expose.parseArgs(args), agent);
    expect(view).toMatchObject({
      app: 'notes',
      route: 'tailnet',
      who: 'only-me',
      state: 'live',
      url: 'https://notes.tail1.ts.net/',
    });
    const before = (await findRouteByApp('notes'))!;
    expect(before.ownerUserId).toBeNull();

    const payload = JSON.stringify({ frame: { id: 'f1', command: 'workloads-expose', args } });
    const approval = { action: 'cli_command', payload };
    expect(publish.approverOf({ approval, outcome: 'reject', userId: 'webchat:owner@x.example' })).toBeNull();
    expect(publish.approverOf({ approval, outcome: 'approve', userId: 'prejudge:model' })).toBeNull();
    expect(publish.approverOf({ approval, outcome: 'approve', userId: '' })).toBeNull();
    const a = publish.approverOf({ approval, outcome: 'approve', userId: 'webchat:owner@x.example' })!;
    expect(a).toEqual({ ticket: pin.ticket, userId: 'webchat:owner@x.example' });
    expect(await claimTicket(a.ticket, a.userId)).toBe(true);
    // A ticket is used once.
    expect(await claimTicket(a.ticket, 'webchat:eve@evil.example')).toBe(false);
    expect((await getRoute(before.id))!.ownerUserId).toBe('webchat:owner@x.example');
  });

  it('keeps one name per app across agents, and updates its own app in place', async () => {
    await workload('notes');
    await workload('notes', 'ag-2');
    const host = { caller: 'host' as const };
    await expose.handler(hostArgs({ group: 'ag-1', name: 'notes', service: 'web', port: 8080 }), host);
    await expect(
      expose.handler(hostArgs({ group: 'ag-2', name: 'notes', service: 'web', port: 8080 }), host),
    ).rejects.toThrow(/app name notes is taken/);
    const p = await publish.planExpose('ag-1', { name: 'notes', service: 'web', port: 9000, who: 'signed-in' });
    expect(p.widens).toBe(true);
    expect(
      (await publish.planExpose('ag-1', { name: 'notes', service: 'web', port: 9000, who: 'only-me' })).widens,
    ).toBe(false);
    await expose.handler(hostArgs({ group: 'ag-1', name: 'notes', service: 'web', port: 9000 }), host);
    expect((await findRouteByApp('notes'))!.port).toBe(9000);
  });
});

describe('ncl workloads routes / unexpose / list', () => {
  it('lists an app with its state, and how a person opens the workload', async () => {
    const w = await workload('notes');
    const host = { caller: 'host' as const };
    await expose.handler(
      hostArgs({ group: 'ag-1', name: 'notes', service: 'web', port: 8080, who: 'agent-members' }),
      host,
    );
    const routes = lookup('workloads-routes')!;
    expect(await routes.handler(routes.parseArgs({}), agent)).toEqual([
      {
        app: 'notes',
        workload: 'notes',
        service: 'web',
        port: 8080,
        route: 'tailnet',
        who: 'agent-members',
        url: 'https://notes.tail1.ts.net/',
        state: 'live',
      },
    ]);
    expect(await publish.openLine(w)).toBe('People open it at: https://notes.tail1.ts.net/ (the agent’s members)');
    tailnetOn = false;
    expect(await routes.handler(routes.parseArgs({}), agent)).toMatchObject([{ url: null, state: 'route off' }]);
    tailnetOn = true;
    await updateWorkload(w.id, { state: 'stopped' });
    expect(await routes.handler(routes.parseArgs({}), agent)).toMatchObject([
      { url: null, state: 'workload not running' },
    ]);
    vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '');
    expect(await routes.handler(routes.parseArgs({}), agent)).toMatchObject([{ url: null, state: 'gateway off' }]);
  });

  it('unpublishes at once, only an agent’s own app', async () => {
    await workload('notes');
    await workload('wiki', 'ag-2');
    const host = { caller: 'host' as const };
    await expose.handler(hostArgs({ group: 'ag-1', name: 'notes', service: 'web', port: 8080 }), host);
    await expose.handler(hostArgs({ group: 'ag-2', name: 'wiki', service: 'web', port: 8080 }), host);
    const unexpose = lookup('workloads-unexpose')!;
    await expect(unexpose.handler(unexpose.parseArgs({ app: 'wiki' }), agent)).rejects.toThrow(
      /no published app named "wiki"/,
    );
    expect(await unexpose.handler(unexpose.parseArgs({ app: 'notes' }), agent)).toEqual({
      app: 'notes',
      unpublished: true,
    });
    expect(await findRouteByApp('notes')).toBeNull();
    expect(await findRouteByApp('wiki')).not.toBeNull();
  });

  it('drops the routes of a deleted workload', async () => {
    const w = await workload('notes');
    await expose.handler(hostArgs({ group: 'ag-1', name: 'notes', service: 'web', port: 8080 }), { caller: 'host' });
    expect(await publish.pruneRoutes()).toBe(0);
    await updateWorkload(w.id, { state: 'deleted' });
    expect(await publish.pruneRoutes()).toBe(1);
    expect(await findRouteByApp('notes')).toBeNull();
  });
});

describe('a route’s edge (a tailnet sidecar, say)', () => {
  it('comes up on expose, goes on unexpose and with a deleted workload, and the link waits for it', async () => {
    const w = await workload('notes');
    const events: string[] = [];
    let edge: { ready: boolean; problem?: string } = { ready: false };
    __clearPublishingRoutesForTest();
    registerPublishingRoute({
      kind: 'tailnet',
      label: 'your tailnet',
      enabled: async () => true,
      hostnameFor: async (app) => `${app}.tail1.ts.net`,
      identify: async () => null,
      attach: async (r) => void events.push(`attach ${r.app}`),
      detach: async (r) => void events.push(`detach ${r.app}`),
      edgeState: async () => edge,
    });
    const host = { caller: 'host' as const };
    const view = await expose.handler(hostArgs({ group: 'ag-1', name: 'notes', service: 'web', port: 8080 }), host);
    expect(events).toEqual(['attach notes']);
    expect(view).toMatchObject({ url: null, state: 'starting' });
    const routes = lookup('workloads-routes')!;
    edge = { ready: false, problem: 'a device named notes is already on the tailnet' };
    expect(await routes.handler(routes.parseArgs({}), agent)).toMatchObject([
      { url: null, state: 'not reachable: a device named notes is already on the tailnet' },
    ]);
    edge = { ready: true };
    expect(await routes.handler(routes.parseArgs({}), agent)).toMatchObject([
      { url: 'https://notes.tail1.ts.net/', state: 'live' },
    ]);
    const unexpose = lookup('workloads-unexpose')!;
    await unexpose.handler(unexpose.parseArgs({ app: 'notes' }), agent);
    expect(events).toEqual(['attach notes', 'detach notes']);
    await expose.handler(hostArgs({ group: 'ag-1', name: 'notes', service: 'web', port: 8080 }), host);
    await updateWorkload(w.id, { state: 'deleted' });
    await publish.pruneRoutes();
    expect(events).toEqual(['attach notes', 'detach notes', 'attach notes', 'detach notes']);
  });
});

describe('specific people (Cloudflare)', () => {
  beforeEach(() => {
    registerPublishingRoute({
      kind: 'cloudflare',
      label: 'Cloudflare',
      enabled: async () => true,
      hostnameFor: async (app) => `${app}.example-apps.net`,
      identify: async () => null,
    });
  });

  it('cards the people by address and pins the checked list', async () => {
    await workload('notes');
    const r = (await expose.precheck!(
      expose.parseArgs({
        name: 'notes',
        service: 'web',
        port: 8080,
        route: 'cloudflare',
        who: 'specific',
        emails: 'Carol@Example.org, bob@example.com bob@example.com',
        reason: 'review',
      }),
      agent,
    ))!;
    expect(r.summary!.split('\n')[0]).toBe('{agent} wants to publish "notes" on Cloudflare for 2 named people.');
    expect(r.detail!.split('\n')).toContain('People: "bob@example.com", "carol@example.org"');
    expect(r.pin).toMatchObject({ route: 'cloudflare', who: 'specific', emails: 'bob@example.com,carol@example.org' });
    const view = await expose.handler(
      expose.parseArgs({ name: 'notes', service: 'web', port: 8080, reason: 'review', ...r.pin }),
      agent,
    );
    expect(view).toMatchObject({
      route: 'cloudflare',
      who: 'specific',
      emails: ['bob@example.com', 'carol@example.org'],
    });
  });

  it('is Cloudflare only, needs addresses, and --emails needs it', async () => {
    await workload('notes');
    const plan = (i: Partial<Parameters<typeof publish.planExpose>[1]>) =>
      publish.planExpose('ag-1', { name: 'notes', service: 'web', port: 8080, ...i });
    await expect(plan({ route: 'tailnet', who: 'specific', emails: 'a@example.com' })).rejects.toThrow(
      /cloudflare route only/,
    );
    await expect(plan({ route: 'cloudflare', who: 'specific' })).rejects.toThrow(/needs --emails/);
    await expect(plan({ route: 'cloudflare', who: 'specific', emails: 'not-an-address' })).rejects.toThrow(
      /not an email address/,
    );
    await expect(plan({ route: 'cloudflare', who: 'agent-members', emails: 'a@example.com' })).rejects.toThrow(
      /goes with --who specific/,
    );
    const many = Array.from({ length: 51 }, (_, i) => `p${i}@example.com`).join(',');
    await expect(plan({ route: 'cloudflare', who: 'specific', emails: many })).rejects.toThrow(/at most 50/);
  });

  it('counts adding anyone as widening, and a subset or "only me" as narrowing', () => {
    const w = publish.widensAccess;
    const s = (...emails: string[]) => ({ who: 'specific' as const, emails });
    expect(w(s('a@x.example', 'b@x.example'), s('a@x.example'))).toBe(false);
    expect(w(s('a@x.example'), s('a@x.example', 'c@x.example'))).toBe(true);
    expect(w({ who: 'only-me', emails: [] }, s('a@x.example'))).toBe(true);
    expect(w({ who: 'signed-in', emails: [] }, s('a@x.example'))).toBe(false);
    expect(w(s('a@x.example'), { who: 'only-me', emails: [] })).toBe(false);
    expect(w(s('a@x.example'), { who: 'agent-members', emails: [] })).toBe(true);
    expect(w({ who: 'only-me', emails: [] }, { who: 'agent-members', emails: [] })).toBe(true);
    expect(w({ who: 'signed-in', emails: [] }, { who: 'agent-members', emails: [] })).toBe(false);
  });
});
