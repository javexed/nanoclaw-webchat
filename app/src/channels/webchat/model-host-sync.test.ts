/**
 * The router follows the roster's Ollama hosts (one debounced rebuild per
 * burst, only when the host set changes), a host that comes back is put back
 * into the router, and the routing classifier moves off a host that is down.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reinstalls: [] as Array<{ root: string; hosts: string }>,
  /** Rebuilds waiting behind the router lock (when `defer` is on): their host lists resolve as they run. */
  queued: [] as Array<{ root: string; hosts: () => string }>,
  defer: false,
  fits: [] as string[],
  variants: [] as string[],
}));
vi.mock('./server/http.js', async (orig) => ({
  ...(await orig<object>()),
  readBody: async (req: { body: unknown }) => JSON.stringify(req.body),
  readJsonObject: async (req: { body: unknown }) => req.body,
  json: (res: { out?: unknown }, status: number, body: unknown) => void (res.out = { status, body }),
}));
vi.mock('./ollama-manage.js', async (orig) => ({
  ...(await orig<object>()),
  startRouterReinstall: (root: string, hosts: string | (() => string)) => {
    if (typeof hosts === 'string') h.reinstalls.push({ root, hosts });
    else if (h.defer) h.queued.push({ root, hosts });
    else h.reinstalls.push({ root, hosts: hosts() });
  },
}));
vi.mock('./models.js', async (orig) => ({ ...(await orig<object>()), validateModel: async () => null }));
vi.mock('./reachability.js', () => ({ probeContainerReachability: async () => ({ ok: true }) }));
vi.mock('./model-autofit.js', async (orig) => ({
  ...(await orig<object>()),
  autoFitNewModels: async (models: Array<{ model_id: string }>) => void h.fits.push(...models.map((m) => m.model_id)),
}));
vi.mock('./model-manage.js', async (orig) => ({
  ...(await orig<object>()),
  createContextVariant: async (endpoint: string, tag: string, ctx: number) => {
    h.variants.push(endpoint);
    return `${tag.replace(':', '-')}-${ctx / 1024}k:latest`;
  },
}));
vi.mock('./server/model-wiring.js', async (orig) => ({
  ...(await orig<object>()),
  reloadAgentModelEnv: async () => {},
}));

import { closeDb, initDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrations/index.js';
import { getDb } from '../../db/connection.js';
import { createWebchatModel, listWebchatModels } from './db.js';
import {
  _resetHostHealthForTest,
  _setHostHealthForTest,
  hostHealthSnapshot,
  type HostHealth,
} from './model-host-health.js';
import {
  ROUTER_SYNC_DEBOUNCE_MS,
  _resetHostSyncForTest,
  flushRouterHostSync,
  noteRosterHosts,
  reconcileClassifierHost,
  sweepModelHosts,
} from './model-host-sync.js';
import { bulkCreateModelsHandler, deleteModelHandler, rModelsContextVariantPost } from './server/routes-models.js';

const A = 'http://192.0.2.9:11434';
const B = 'http://192.0.2.10:11434';
const C = 'http://192.0.2.11:11434';
let root: string;

/** An installed router built from `hosts`, with deployments on `deployed`. */
function installRouter(hosts: string[], deployed = hosts): void {
  const inst = path.join(root, '.claude/skills/add-litellm/resources');
  fs.mkdirSync(inst, { recursive: true });
  fs.writeFileSync(path.join(inst, 'install-litellm.sh'), '');
  fs.mkdirSync(path.join(root, 'data/litellm/routing'), { recursive: true });
  const lines = [`# hosts: ${hosts.join(', ')}`, 'model_list:'];
  for (const d of deployed) lines.push('  - model_name: qwen3:8b', '    litellm_params:', `      api_base: "${d}"`);
  fs.writeFileSync(path.join(root, 'data/litellm/config.yaml'), lines.join('\n') + '\n');
}

function writeRoutes(classifier: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(root, 'data/litellm/routing/routes.json'),
    JSON.stringify({ classifier, live: { enabled: true } }),
  );
}
const readClassifier = (): Record<string, unknown> =>
  (
    JSON.parse(fs.readFileSync(path.join(root, 'data/litellm/routing/routes.json'), 'utf8')) as {
      classifier: Record<string, unknown>;
    }
  ).classifier;

async function addModel(id: string, endpoint: string, modelId = 'qwen3:8b'): Promise<void> {
  await createWebchatModel({
    id,
    name: id,
    kind: 'ollama',
    endpoint,
    model_id: modelId,
    credential_ref: null,
    created_at: Date.now(),
  });
}

async function bulk(models: Array<{ endpoint: string; model_id: string }>): Promise<unknown> {
  const res: { out?: unknown } = {};
  const body = { models: models.map((m) => ({ name: m.model_id, kind: 'ollama', ...m })) };
  await bulkCreateModelsHandler({ body } as never, res as never);
  return res.out;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-sync-'));
  await initDb(path.join(root, 'test.db'));
  await runMigrations(getDb());
  h.reinstalls = [];
  h.queued = [];
  h.defer = false;
  h.fits = [];
  h.variants = [];
  _resetHostSyncForTest();
  _resetHostHealthForTest();
});

afterEach(async () => {
  vi.useRealTimers();
  _resetHostSyncForTest();
  _resetHostHealthForTest();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the router follows the roster hosts', () => {
  beforeEach(async () => {
    await addModel('a', A);
    installRouter([A]);
  });

  it('a model on a new host rebuilds the router once, with that host added', async () => {
    await bulk([
      { endpoint: B, model_id: 'qwen3:8b' },
      { endpoint: B, model_id: 'gemma3:4b' },
      { endpoint: A, model_id: 'gemma3:4b' },
    ]);
    expect(flushRouterHostSync(root)).toBe(true);
    expect(h.reinstalls).toEqual([{ root, hosts: `${A},${B}` }]);
    // The new registrations go to the GPU fit as well.
    expect(h.fits).toEqual(['qwen3:8b', 'gemma3:4b', 'gemma3:4b']);
  });

  it('a model on a host the roster already has does not', async () => {
    await bulk([{ endpoint: A, model_id: 'gemma3:4b' }]);
    expect(flushRouterHostSync(root)).toBe(false);
    expect(h.reinstalls).toEqual([]);
  });

  it("deleting a host's last model takes it out; an earlier one does not", async () => {
    await addModel('b1', B);
    await addModel('b2', B, 'gemma3:4b');
    installRouter([A, B]);
    const res: { out?: unknown } = {};
    await deleteModelHandler(res as never, 'b1', false);
    expect(flushRouterHostSync(root)).toBe(false);
    await deleteModelHandler(res as never, 'b2', false);
    expect(flushRouterHostSync(root)).toBe(true);
    expect(h.reinstalls).toEqual([{ root, hosts: A }]);
    expect((await listWebchatModels()).map((m) => m.id)).toEqual(['a']);
  });

  it('a burst is one rebuild after the debounce', async () => {
    vi.useFakeTimers();
    noteRosterHosts([A], [A, B], root);
    noteRosterHosts([A, B], [A, B, C], root);
    await vi.advanceTimersByTimeAsync(ROUTER_SYNC_DEBOUNCE_MS - 1);
    expect(h.reinstalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reinstalls).toEqual([{ root, hosts: `${A},${B},${C}` }]);
  });

  it('a host added then removed inside the window is no rebuild; hosts configured by hand stay', async () => {
    installRouter([A, 'http://198.51.100.7:8000']);
    noteRosterHosts([A], [A, B], root);
    noteRosterHosts([A, B], [A], root);
    expect(flushRouterHostSync(root)).toBe(false);
    noteRosterHosts([A], [A, C], root);
    expect(flushRouterHostSync(root)).toBe(true);
    expect(h.reinstalls).toEqual([{ root, hosts: `${A},http://198.51.100.7:8000,${C}` }]);
  });

  describe('rebuilds queued behind one still to run', () => {
    /** Run the queued rebuilds in order, each writing the header its installer would. */
    function runQueued(): string[] {
      const ran: string[] = [];
      for (const q of h.queued.splice(0)) {
        const hosts = q.hosts();
        ran.push(hosts);
        const cfg = path.join(root, 'data/litellm/config.yaml');
        const text = fs.readFileSync(cfg, 'utf8').replace(/^# hosts:.*$/m, `# hosts: ${hosts.split(',').join(', ')}`);
        fs.writeFileSync(cfg, text);
      }
      return ran;
    }

    it('a host added, then removed before the first rebuild ran, ends up out of the router', () => {
      h.defer = true;
      noteRosterHosts([A], [A, B], root);
      expect(flushRouterHostSync(root)).toBe(true);
      noteRosterHosts([A, B], [A], root);
      // The header still reads A alone, but the queued rebuild will add B: this one must still run.
      expect(flushRouterHostSync(root)).toBe(true);
      expect(runQueued()).toEqual([`${A},${B}`, A]);
    });

    it('two hosts added in separate rebuilds are both kept', () => {
      h.defer = true;
      noteRosterHosts([A], [A, B], root);
      expect(flushRouterHostSync(root)).toBe(true);
      noteRosterHosts([A, B], [A, B, C], root);
      expect(flushRouterHostSync(root)).toBe(true);
      expect(runQueued()).toEqual([`${A},${B}`, `${A},${B},${C}`]);
    });
  });

  it('no router installed: nothing', () => {
    fs.rmSync(path.join(root, 'data/litellm/config.yaml'));
    noteRosterHosts([A], [A, B], root);
    expect(flushRouterHostSync(root)).toBe(false);
    expect(h.reinstalls).toEqual([]);
  });
});

describe('host health sweep', () => {
  const tags = (names: string[]): Response => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }));

  it('a configured host that answers again but was left out of the router gets it rebuilt (once)', async () => {
    await addModel('a', A);
    await addModel('b', B);
    installRouter([A, B], [A]);
    const fetchImpl = vi.fn(async () => tags(['qwen3:8b']));
    await sweepModelHosts(root, fetchImpl, 1_000);
    expect(flushRouterHostSync(root)).toBe(true);
    expect(h.reinstalls).toEqual([{ root, hosts: `${A},${B}` }]);
    // Down and up again within the cooldown: no second rebuild.
    _setHostHealthForTest(B, { status: 'down' });
    await sweepModelHosts(root, fetchImpl, 2_000);
    expect(flushRouterHostSync(root)).toBe(false);
  });

  it('records each host, and the classifier moves to another host serving its model, then back', async () => {
    await addModel('a', A);
    await addModel('b', B);
    installRouter([A, B]);
    writeRoutes({ url: 'http://192.0.2.9:11434/api/chat', model: 'arch-router:latest', timeout_ms: 15000 });
    let aUp = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith(A) && !aUp) throw new TypeError('fetch failed');
      return tags(['qwen3:8b', 'arch-router']);
    });
    await sweepModelHosts(root, fetchImpl, 1_000);
    expect(hostHealthSnapshot()[A]).toMatchObject({ status: 'down', lastError: 'fetch failed' });
    expect(readClassifier()).toEqual({
      url: 'http://192.0.2.10:11434/api/chat',
      home_url: 'http://192.0.2.9:11434/api/chat',
      model: 'arch-router:latest',
      timeout_ms: 15000,
    });
    aUp = true;
    await sweepModelHosts(root, fetchImpl, 2_000);
    expect(readClassifier()).toEqual({
      url: 'http://192.0.2.9:11434/api/chat',
      model: 'arch-router:latest',
      timeout_ms: 15000,
    });
  });
});

describe('classifier failover', () => {
  const state = (s: Record<string, Partial<HostHealth> & { status: 'up' | 'down' }>): Record<string, HostHealth> => {
    for (const [k, v] of Object.entries(s)) _setHostHealthForTest(k, v);
    return hostHealthSnapshot();
  };
  beforeEach(() => installRouter([A]));

  it('a host-local classifier keeps the container form when it comes back', () => {
    writeRoutes({ url: 'http://host.docker.internal:11434/api/chat', model: 'arch' });
    expect(
      reconcileClassifierHost(
        root,
        state({ 'http://localhost:11434': { status: 'down' }, [B]: { status: 'up', models: ['arch:latest'] } }),
      ),
    ).toBe('moved');
    expect(readClassifier().url).toBe('http://192.0.2.10:11434/api/chat');
    expect(reconcileClassifierHost(root, state({ 'http://localhost:11434': { status: 'up' } }))).toBe('restored');
    expect(readClassifier()).toEqual({ url: 'http://host.docker.internal:11434/api/chat', model: 'arch' });
  });

  it('no other host has the model: left alone (the hook skips classification fast)', () => {
    writeRoutes({ url: `${A}/api/chat`, model: 'arch' });
    expect(
      reconcileClassifierHost(root, state({ [A]: { status: 'down' }, [B]: { status: 'up', models: ['qwen3:8b'] } })),
    ).toBeNull();
    expect(readClassifier()).toEqual({ url: `${A}/api/chat`, model: 'arch' });
  });

  it('a host up, or no routing installed: nothing', () => {
    writeRoutes({ url: `${A}/api/chat`, model: 'arch' });
    expect(
      reconcileClassifierHost(root, state({ [A]: { status: 'up' }, [B]: { status: 'up', models: ['arch'] } })),
    ).toBeNull();
    fs.rmSync(path.join(root, 'data/litellm/routing/routes.json'));
    expect(reconcileClassifierHost(root, state({ [A]: { status: 'down' } }))).toBeNull();
  });
});

describe('a context variant on a given host', () => {
  const post = async (body: Record<string, unknown>): Promise<{ status: number; body: any }> => {
    const res: { out?: { status: number; body: any } } = {};
    await rModelsContextVariantPost({ req: { body }, res } as never, [] as never);
    return res.out!;
  };

  it('is made on the named host and registered there; an unregistered host is refused', async () => {
    await addModel('a', A);
    await addModel('b', B);
    expect((await post({ tag: 'qwen3:8b', ctx: 12288, endpoint: B })).status).toBe(200);
    expect(h.variants).toEqual([B]);
    expect((await listWebchatModels()).find((m) => m.model_id === 'qwen3-8b-12k:latest')?.endpoint).toBe(B);
    // The same variant on the first host is its own registration.
    expect((await post({ tag: 'qwen3:8b', ctx: 12288 })).status).toBe(200);
    expect(h.variants).toEqual([B, A]);
    expect((await listWebchatModels()).filter((m) => m.model_id === 'qwen3-8b-12k:latest')).toHaveLength(2);
    expect(await post({ tag: 'qwen3:8b', ctx: 12288, endpoint: 'http://198.51.100.1:11434' })).toEqual({
      status: 400,
      body: { error: 'endpoint is not a registered Ollama host' },
    });
  });
});
