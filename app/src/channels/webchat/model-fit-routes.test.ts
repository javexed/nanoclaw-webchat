/**
 * The owner-only model and trace settings routes, through the real server:
 * the fit-context check/start guards and id handling, the turn-trace settings
 * guards, and the fit check's deadline against a host that never answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebchatModel } from './db.js';
import type { WebchatServer } from './server.js';
import { PROXY_ENV, resetServerModules, seeder, startServer } from './test-server.js';

const fit = vi.hoisted(() => ({
  checked: [] as string[],
  started: [] as string[],
  worth: new Set<string>(),
}));
vi.mock('./model-autofit.js', async (orig) => ({
  ...(await orig<object>()),
  fitBenefit: async (m: { id: string }) => {
    fit.checked.push(m.id);
    return fit.worth.has(m.id) ? { worth: true, served: 4096, maxContext: 32768 } : { worth: false, reason: 'no' };
  },
  startFits: (models: Array<{ id: string }>) => {
    fit.started.push(...models.map((m) => m.id));
    return models.length;
  },
}));

const model = (id: string): WebchatModel => ({
  id,
  name: id,
  kind: 'ollama',
  endpoint: 'http://192.0.2.10:11434',
  model_id: `${id}:8b`,
  credential_ref: null,
  created_at: 0,
});
/** m0 … m59, registered. */
const IDS = Array.from({ length: 60 }, (_, i) => `m${i}`);

describe('owner-only model and trace settings routes', () => {
  let server: typeof import('./server.js');
  let wc: WebchatServer;
  let port: number;

  beforeEach(async () => {
    Object.assign(fit, { checked: [], started: [], worth: new Set<string>() });
    ({ server, wc, port } = await startServer(PROXY_ENV, async (db) => {
      const { user, role } = seeder(db, new Date().toISOString());
      await role('webchat:owner', 'owner', null);
      await user('webchat:nobody');
    }));
    const { createWebchatModel } = await import('./db.js');
    for (const id of IDS) await createWebchatModel(model(id));
  });

  afterEach(async () => {
    if (wc) await server.stopWebchatServer(wc);
    await resetServerModules();
  });

  const call = async (method: string, path: string, who: string, body?: unknown, csrf = true) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'x-forwarded-user': who,
        'content-type': 'application/json',
        ...(csrf ? { 'x-webchat-csrf': '1' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  for (const route of ['/api/models/fit-context/check', '/api/models/fit-context/start']) {
    it(`${route}: refuses anyone but the owner, and a request without the CSRF header`, async () => {
      expect((await call('POST', route, 'nobody', { ids: ['m1'] })).status).toBe(403);
      expect((await call('POST', route, 'owner', { ids: ['m1'] }, false)).status).toBe(403);
      expect(fit.checked).toEqual([]);
      expect(fit.started).toEqual([]);
    });

    it(`${route}: an empty or missing id list is a 400`, async () => {
      for (const body of [{}, { ids: [] }, { ids: 'm1' }, { ids: [1, null, {}] }])
        expect((await call('POST', route, 'owner', body)).status).toBe(400);
      expect(fit.checked).toEqual([]);
      expect(fit.started).toEqual([]);
    });
  }

  it('check: unknown ids are dropped, at most 50 are looked at, and only models worth fitting come back', async () => {
    fit.worth = new Set(['m1', 'm55']);
    const r = await call('POST', '/api/models/fit-context/check', 'owner', { ids: ['nope', ...IDS] });
    expect(r.status).toBe(200);
    // 'nope' takes one of the 50 places and is not registered: m0 … m48 are checked.
    expect(fit.checked).toEqual(IDS.slice(0, 49));
    expect(r.body.models).toEqual([{ id: 'm1', served: 4096, maxContext: 32768 }]);
  });

  it('start: unknown ids are dropped and at most 50 are started', async () => {
    const r = await call('POST', '/api/models/fit-context/start', 'owner', { ids: ['nope', ...IDS] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, started: 49 });
    expect(fit.started).toEqual(IDS.slice(0, 49));
    expect((await call('POST', '/api/models/fit-context/start', 'owner', { ids: ['nope'] })).body).toEqual({
      ok: true,
      started: 0,
    });
  });

  it('turn-trace settings: the owner reads and changes them; anyone else is refused', async () => {
    expect((await call('GET', '/api/webchat/turn-traces', 'nobody')).status).toBe(403);
    expect((await call('PUT', '/api/webchat/turn-traces', 'nobody', { enabled: false })).status).toBe(403);
    expect((await call('PUT', '/api/webchat/turn-traces', 'owner', { enabled: false }, false)).status).toBe(403);
    const before = await call('GET', '/api/webchat/turn-traces', 'owner');
    expect(before.status).toBe(200);
    expect((await call('PUT', '/api/webchat/turn-traces', 'owner', { enabled: !before.body.enabled })).status).toBe(
      200,
    );
    expect((await call('GET', '/api/webchat/turn-traces', 'owner')).body.enabled).toBe(!before.body.enabled);
  });
});

describe('fitBenefit against a host that never answers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gives up by its deadline with "not worth it" instead of hanging the check', async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on a timer fake timers cannot reach: route it through one they can.
    const asked: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      asked.push(ms);
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
      return c.signal;
    });
    // Accepts the connection, never answers; lets go only when the caller aborts.
    const hang = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    const { fitBenefit } = await vi.importActual<typeof import('./model-autofit.js')>('./model-autofit.js');
    let settled = false;
    const out = fitBenefit(model('m1'), hang).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await out).toMatchObject({ worth: false });
    expect(asked).toEqual([5_000]);
  });
});
