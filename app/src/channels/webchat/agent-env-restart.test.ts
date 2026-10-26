/**
 * A setting that only a fresh container sees — an environment variable, or a
 * move to or from Open egress — restarts the agent's containers once it is idle,
 * so it applies without anyone remembering to restart. A change that applies
 * live (between the two filtered modes) restarts nothing.
 *
 * The env store is in memory here (the real one writes under the project's
 * data/), and the idle restart is recorded rather than run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebchatServer } from './server.js';
import type { DbDriver } from '../../db/driver.js';
import { httpRequest, PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

const h = vi.hoisted(() => ({
  restarts: [] as Array<[string, string]>,
  running: 1,
  env: new Map<string, Map<string, string>>(),
}));

vi.mock('../../container-restart-idle.js', () => ({
  restartAgentGroupContainersWhenIdle: async (agentGroupId: string, reason: string) => {
    h.restarts.push([agentGroupId, reason]);
    return h.running;
  },
}));

vi.mock('../../modules/agent-env/store.js', async (orig) => {
  const real = await orig<typeof import('../../modules/agent-env/store.js')>();
  const of = (g: string) => h.env.get(g) ?? h.env.set(g, new Map()).get(g)!;
  return {
    ...real,
    listAgentEnvNames: (g: string) => [...of(g).keys()].sort(),
    setAgentEnv: (g: string, name: string, value: string) => void of(g).set(name, value),
    deleteAgentEnv: (g: string, name: string) => of(g).delete(name),
  };
});

afterEach(resetServerModules);

const now = '2026-10-14T00:00:00.000Z';
async function seed(db: DbDriver): Promise<void> {
  const { group, role } = seeder(db, now);
  await group('ag-env');
  await role('webchat:owner', 'owner', null);
}

describe('settings that need a fresh container restart the agent when idle', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;
  beforeEach(async () => {
    h.restarts.length = 0;
    h.running = 1;
    h.env.clear();
    ({ server, wc, port } = await startServer(PROXY_ENV, seed));
  });
  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
  });
  const hdr = { 'x-forwarded-user': 'owner', 'content-type': 'application/json', 'x-webchat-csrf': '1' };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await httpRequest(port, method, path, hdr, body === undefined ? undefined : JSON.stringify(body));
    return { status: r.status, body: JSON.parse(r.body || '{}') as Record<string, unknown> };
  };

  it('adding an environment variable restarts the agent once it is idle, and says how many', async () => {
    const r = await call('PUT', '/api/agents/ag-env/env', { name: 'MOUSER_API_KEY', value: 'x' });
    expect(r.status).toBe(200);
    expect(r.body.restarted).toBe(1);
    expect(h.restarts).toEqual([['ag-env', 'Environment changed']]);
  });

  it('removing one does too; an unknown name restarts nothing', async () => {
    await call('PUT', '/api/agents/ag-env/env', { name: 'A_KEY', value: 'x' });
    h.restarts.length = 0;
    expect((await call('DELETE', '/api/agents/ag-env/env?name=NOPE')).status).toBe(404);
    expect(h.restarts).toEqual([]);
    const r = await call('DELETE', '/api/agents/ag-env/env?name=A_KEY');
    expect(r.status).toBe(200);
    expect(h.restarts).toEqual([['ag-env', 'Environment changed']]);
  });

  it('a refused variable restarts nothing', async () => {
    expect((await call('PUT', '/api/agents/ag-env/env', { name: 'bad name', value: 'x' })).status).toBe(400);
    expect(h.restarts).toEqual([]);
  });

  it('an agent with nothing running reports 0 — it picks the change up at its next start', async () => {
    h.running = 0;
    expect((await call('PUT', '/api/agents/ag-env/env', { name: 'A_KEY', value: 'x' })).body.restarted).toBe(0);
  });

  it('moving to or from Open restarts when idle; between the filtered modes it applies live, no restart', async () => {
    let r = await call('PUT', '/api/agents/ag-env/egress', { egress: 'none' });
    expect(r.body).toMatchObject({ appliesNow: true, restarted: 0 });
    expect(h.restarts).toEqual([]);

    r = await call('PUT', '/api/agents/ag-env/egress', { egress: 'open' });
    expect(r.body).toMatchObject({ appliesNow: false, restarted: 1 });
    expect(h.restarts).toEqual([['ag-env', 'Network mode changed']]);

    // Saving the mode it already has changes nothing, so nothing restarts.
    h.restarts.length = 0;
    r = await call('PUT', '/api/agents/ag-env/egress', { egress: 'open' });
    expect(r.body).toMatchObject({ restarted: 0 });
    expect(h.restarts).toEqual([]);

    r = await call('PUT', '/api/agents/ag-env/egress', { egress: 'host-only' });
    expect(r.body).toMatchObject({ appliesNow: false, restarted: 1 });
    expect(h.restarts).toEqual([['ag-env', 'Network mode changed']]);
  });
});
