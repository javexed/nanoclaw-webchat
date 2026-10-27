/**
 * The tailnet route's lifecycle against a fake Docker and a fake Tailscale
 * API: status, a sidecar per app (key minted, handed over as a file, gone
 * after login), name collisions, unpublish (logout, device removed, state
 * gone), devices the API could not remove yet, switching off, strangers on the
 * edge network, and who the gateway believes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-life-'));
vi.mock('../../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../../config.js')>()),
  DATA_DIR: DATA,
}));

const { __setTailnetDepsForTest, __refreshTailnetStatusForTest, tailnetStatus, tickTailnet } =
  await import('./index.js');
const { publishingRoute } = await import('../gateway/publishing.js');
const { TailscaleApi, TOKEN_PATH } = await import('./api.js');
const { edgeBridgeName, tailnetSettings } = await import('./config.js');
const { INSTALL_SLUG } = await import('../../../config.js');
const { loadState } = await import('./state.js');
const { KEY_FILE } = await import('./sidecar.js');
import type { AppRoute } from '../routes.js';
import type { GatewaySettings } from '../gateway/config.js';
import type { OnecliAdmin } from '../../user-credentials/onecli-admin.js';

const route = (app: string, id: string): AppRoute => ({
  id,
  app,
  workloadId: 'w1',
  agentGroupId: 'ag-1',
  service: 'web',
  port: 8080,
  kind: 'tailnet',
  who: 'agent-members',
  emails: [],
  ownerUserId: null,
  ticket: null,
  createdBy: 'agent:ag-1',
  createdAt: 0,
  updatedAt: 0,
});
const NOTES = route('notes', '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11');
const WIKI = route('wiki', '1c1f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e22');

// --- Fake Docker ------------------------------------------------------------

interface Box {
  running: boolean;
  spec: string;
  route: string;
  dir: string;
  app: string;
  nodeId: string;
  loggedIn: boolean;
}
let boxes: Map<string, Box>;
let edgeExists: boolean;
let strangers: string[];
let calls: string[][];
/** What a device ends up named on the tailnet: app → DNS label. */
let dnsLabel: Record<string, string>;
let keySeenAtRun: Array<{ mode: number; key: string }>;
let nodes = 0;

const docker = async (args: string[]): Promise<string> => {
  calls.push(args);
  const [cmd, ...rest] = args;
  if (cmd === 'network' && rest[0] === 'inspect') {
    if (!edgeExists) throw new Error('no such network');
    if (rest.includes('{{range $id, $c := .Containers}}{{$id}} {{$c.Name}}{{"\\n"}}{{end}}'))
      return [...[...boxes.keys()].map((n) => `id-${n} ${n}`), ...strangers.map((s) => `id-${s} ${s}`)].join('\n');
    return `${edgeBridgeName()} 198.51.100.0/24 198.51.100.1 false false`;
  }
  if (cmd === 'network' && rest[0] === 'create') {
    edgeExists = true;
    return '';
  }
  if (cmd === 'network' && rest[0] === 'disconnect') {
    strangers = strangers.filter((s) => `id-${s}` !== rest[3]);
    return '';
  }
  if (cmd === 'ps') return [...boxes.entries()].map(([n, b]) => `${n} ${b.route}`).join('\n');
  if (cmd === 'inspect') {
    const target = rest[rest.length - 1];
    if (target.startsWith('id-')) {
      const n = target.slice(3);
      return boxes.has(n) ? INSTALL_SLUG : '';
    }
    const b = boxes.get(target);
    if (!b) throw new Error('no such container');
    if (rest.includes('{{.RestartCount}}')) return b.loggedIn ? '0' : '3';
    return `${b.running} ${b.spec}`;
  }
  if (cmd === 'rm') {
    boxes.delete(rest[rest.length - 1]);
    return '';
  }
  if (cmd === 'run') {
    const name = rest[rest.indexOf('--name') + 1];
    const spec = rest[rest.indexOf('--label') + 1].split('=')[1];
    const routeId = rest.find((a) => a.startsWith('nanoclaw-workload-tailnet-route='))!.split('=')[1];
    const keyMount = rest.find((a) => a.endsWith(':/run/ts-key:ro'))!;
    const dir = path.dirname(keyMount.split(':')[0]);
    const app = rest.find((a) => a.startsWith('TS_HOSTNAME='))!.split('=')[1];
    const keyFile = path.join(dir, 'key', KEY_FILE);
    const stateFiles = fs.readdirSync(path.join(dir, 'state'));
    let loggedIn = false;
    let nodeId = '';
    if (fs.existsSync(keyFile)) {
      keySeenAtRun.push({ mode: fs.statSync(keyFile).mode & 0o777, key: fs.readFileSync(keyFile, 'utf8') });
      nodeId = `n${++nodes}`;
      loggedIn = true;
      fs.writeFileSync(path.join(dir, 'state', 'tailscaled.state'), nodeId);
    } else if (stateFiles.length) {
      nodeId = fs.readFileSync(path.join(dir, 'state', 'tailscaled.state'), 'utf8');
      loggedIn = nodeId !== '';
    }
    boxes.set(name, { running: true, spec, route: routeId, dir, app, nodeId, loggedIn });
    return 'cid';
  }
  if (cmd === 'exec') {
    const b = boxes.get(rest[0]);
    if (!b) throw new Error('not running');
    if (rest.includes('logout')) {
      b.loggedIn = false;
      return '';
    }
    if (rest.includes('serve'))
      return JSON.stringify({ Web: { [`${dnsLabel[b.app] ?? b.app}.tail1.ts.net:443`]: {} } });
    if (rest.includes('status'))
      return JSON.stringify(
        b.loggedIn
          ? {
              BackendState: 'Running',
              Self: { DNSName: `${dnsLabel[b.app] ?? b.app}.tail1.ts.net.`, ID: b.nodeId, Tags: ['tag:nanoclaw-app'] },
            }
          : { BackendState: 'NeedsLogin', Self: { DNSName: '', ID: '' } },
      );
  }
  throw new Error(`fake docker: ${args.join(' ')}`);
};

// --- Fake Tailscale API ---------------------------------------------------

let apiCalls: string[];
let apiDown: boolean;
let deletedDevices: string[];
let keys = 0;
const api = new TailscaleApi(async (method, p) => {
  apiCalls.push(`${method} ${p}`);
  if (apiDown) return { status: 503, body: { message: 'down' } };
  if (p === TOKEN_PATH) return { status: 200, body: { access_token: 'at', expires_in: 3600 } };
  if (p === '/api/v2/tailnet/-/keys')
    return { status: 200, body: { id: `k${++keys}`, key: `tskey-auth-k${keys}-abc` } };
  if (method === 'DELETE' && p.startsWith('/api/v2/device/')) {
    deletedDevices.push(p.slice('/api/v2/device/'.length));
    return { status: 200, body: {} };
  }
  if (method === 'DELETE') return { status: 200, body: {} };
  return { status: 404, body: {} };
});

// --- Everything else ------------------------------------------------------

let routes: AppRoute[];
let env: Record<string, string>;
let gateway: GatewaySettings;
let probe: 'blocked' | 'open';
let vaultOk: boolean;
let now = 1_000_000;

const admin = {
  listAllSecrets: async () =>
    vaultOk ? [{ id: 's1', name: 'NanoClaw tailnet OAuth client', hostPattern: 'api.tailscale.com' }] : [],
  listAgents: async () => [{ id: 'a1', identifier: 'nanoclaw-tailnet', secretMode: 'selective' }],
  listAgentSecretIds: async () => ['s1'],
} as unknown as OnecliAdmin;

beforeEach(() => {
  fs.rmSync(path.join(DATA, 'workload-tailnet'), { recursive: true, force: true });
  boxes = new Map();
  edgeExists = false;
  strangers = [];
  calls = [];
  dnsLabel = {};
  keySeenAtRun = [];
  apiCalls = [];
  apiDown = false;
  deletedDevices = [];
  nodes = 0;
  keys = 0;
  routes = [NOTES];
  env = { NANOCLAW_WORKLOAD_TAILNET: '1', NANOCLAW_WORKLOAD_TAILNET_DOMAIN: 'tail1.ts.net' };
  gateway = {
    on: true,
    ok: true,
    cfg: { bind: '198.51.100.1', port: 8470, internalPort: 8471, image: 'caddy@sha256:x' },
  };
  probe = 'blocked';
  vaultOk = true;
  __setTailnetDepsForTest({
    docker,
    api,
    admin,
    settings: () => tailnetSettings((k) => env[k]),
    gateway: () => gateway,
    workloadsOn: () => true,
    routes: async () => routes,
    probe: async () => probe,
    sleep: async () => {
      now += 1000;
    },
    now: () => now,
    uid: 1000,
    gid: 1000,
    readyTimeoutMs: 10_000,
  });
});
afterEach(() => __setTailnetDepsForTest(null));

const tailnet = () => publishingRoute('tailnet')!;

describe('tailnet route status', () => {
  it('is off until switched on, then names the one thing missing', async () => {
    env = {};
    expect(await __refreshTailnetStatusForTest()).toEqual({ state: 'off', warnings: [] });
    env = { NANOCLAW_WORKLOAD_TAILNET: '1', NANOCLAW_WORKLOAD_TAILNET_DOMAIN: 'tail1.ts.net' };
    gateway = { on: false };
    expect(await __refreshTailnetStatusForTest()).toMatchObject({ missing: /gateway is off/ });
    gateway = { on: true, ok: true, cfg: { bind: '127.0.0.1', port: 8470, internalPort: 8471, image: 'c' } };
    expect(await __refreshTailnetStatusForTest()).toMatchObject({
      missing: 'the app gateway must listen on the edge address: set NANOCLAW_WORKLOAD_GATEWAY_BIND=198.51.100.1',
    });
    gateway = { on: true, ok: true, cfg: { bind: '198.51.100.1', port: 8470, internalPort: 8471, image: 'c' } };
    vaultOk = false;
    expect(await __refreshTailnetStatusForTest()).toMatchObject({ missing: /not in the vault/ });
    vaultOk = true;
    probe = 'open';
    expect(await __refreshTailnetStatusForTest()).toMatchObject({
      missing: /host rules for the edge network are missing .*--gateway 198\.51\.100\.1:8470/,
    });
    probe = 'blocked';
    apiDown = true;
    expect(await __refreshTailnetStatusForTest()).toMatchObject({ missing: /token request failed/ });
    apiDown = false;
    expect(await __refreshTailnetStatusForTest()).toEqual({ state: 'connected', warnings: [] });
    expect(await tailnet().enabled()).toBe(true);
    expect(await tailnet().hostnameFor('notes')).toBe('notes.tail1.ts.net');
  });

  it('turns nothing on while it is not connected', async () => {
    vaultOk = false;
    await tickTailnet();
    expect(tailnetStatus().state).toBe('missing');
    expect(await tailnet().enabled()).toBe(false);
    expect(boxes.size).toBe(0);
    expect(apiCalls).toEqual([]);
  });
});

describe('a sidecar per tailnet app', () => {
  it('creates the edge network, mints one key, hands it over as a 0600 file and deletes it after login', async () => {
    await tickTailnet();
    expect(calls.find((c) => c[0] === 'network' && c[1] === 'create')).toEqual(
      expect.arrayContaining([
        '--subnet',
        '198.51.100.0/24',
        '--gateway',
        '198.51.100.1',
        'com.docker.network.bridge.enable_icc=false',
      ]),
    );
    expect(apiCalls.filter((c) => c === 'POST /api/v2/tailnet/-/keys')).toHaveLength(1);
    expect(keySeenAtRun).toEqual([{ mode: 0o600, key: 'tskey-auth-k1-abc' }]);
    const rec = loadState().sidecars[NOTES.id];
    expect(rec).toMatchObject({ app: 'notes', address: '198.51.100.2', nodeId: 'n1' });
    expect(fs.existsSync(path.join(DATA, 'workload-tailnet', NOTES.id, 'key', KEY_FILE))).toBe(false);
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run.join(' ')).not.toMatch(/tskey-/);
    expect(await tailnet().edgeState!(NOTES)).toEqual({ ready: true });
  });

  it('leaves a running sidecar alone, and restarts a stopped one from its state without a new key', async () => {
    await tickTailnet();
    await tickTailnet();
    expect(apiCalls.filter((c) => c.endsWith('/keys'))).toHaveLength(1);
    boxes.get([...boxes.keys()][0])!.running = false;
    await tickTailnet();
    expect(apiCalls.filter((c) => c.endsWith('/keys'))).toHaveLength(1);
    expect(loadState().sidecars[NOTES.id].nodeId).toBe('n1');
  });

  it('logs in afresh when a sidecar’s saved login is gone', async () => {
    await tickTailnet();
    const dir = path.join(DATA, 'workload-tailnet', NOTES.id, 'state');
    // The device was removed in the admin console: the saved state no longer logs in.
    fs.writeFileSync(path.join(dir, 'tailscaled.state'), '');
    boxes.clear();
    await tickTailnet();
    expect(apiCalls.filter((c) => c.endsWith('/keys'))).toHaveLength(2);
    expect(deletedDevices).toContain('n1');
    expect(loadState().sidecars[NOTES.id].nodeId).toBe('n2');
  });

  it('gives each app its own address', async () => {
    routes = [NOTES, WIKI];
    await tickTailnet();
    const s = loadState().sidecars;
    expect(s[NOTES.id].address).toBe('198.51.100.2');
    expect(s[WIKI.id].address).toBe('198.51.100.3');
  });

  it('backs out when the tailnet already has a device with the app’s name', async () => {
    dnsLabel.notes = 'notes-1';
    await tickTailnet();
    expect(deletedDevices).toEqual(['n1']);
    expect(boxes.size).toBe(0);
    expect(apiCalls).toContain('DELETE /api/v2/tailnet/-/keys/k1');
    expect(await tailnet().edgeState!(NOTES)).toMatchObject({
      ready: false,
      problem: expect.stringMatching(/a device named notes is already on the tailnet/),
    });
  });

  it('on unpublish logs out, removes the container, the state and the device', async () => {
    await tickTailnet();
    await tailnet().detach!(NOTES);
    expect(calls.some((c) => c[0] === 'exec' && c.includes('logout'))).toBe(true);
    expect(boxes.size).toBe(0);
    expect(deletedDevices).toEqual(['n1']);
    expect(fs.existsSync(path.join(DATA, 'workload-tailnet', NOTES.id))).toBe(false);
    expect(loadState().sidecars).toEqual({});
  });

  it('remembers a device the API could not remove, and removes it later', async () => {
    await tickTailnet();
    routes = [];
    apiDown = true;
    await tickTailnet();
    expect(boxes.size).toBe(0);
    expect(loadState().pendingDeletes).toEqual(['n1']);
    apiDown = false;
    now += 60 * 60_000;
    await tickTailnet();
    expect(deletedDevices).toEqual(['n1']);
    expect(loadState().pendingDeletes).toEqual([]);
  });

  it('takes every sidecar down when the route or workloads are switched off', async () => {
    routes = [NOTES, WIKI];
    await tickTailnet();
    expect(boxes.size).toBe(2);
    await tickTailnet(false);
    expect(boxes.size).toBe(0);
    expect(deletedDevices.sort()).toEqual(['n1', 'n2']);
    expect(tailnetStatus().state).toBe('off');
  });

  it('removes sidecars that belong to no app, and disconnects anything else from the edge network', async () => {
    await tickTailnet();
    boxes.set(`nanoclaw-tailnet-x-old`, {
      running: true,
      spec: '',
      route: 'gone',
      dir: '',
      app: 'old',
      nodeId: '',
      loggedIn: false,
    });
    strangers = ['ncl-agent-1'];
    await tickTailnet();
    expect(boxes.has('nanoclaw-tailnet-x-old')).toBe(false);
    expect(strangers).toEqual([]);
  });
});

describe('who the gateway believes on the tailnet', () => {
  it('Tailscale-User-Login only from the app’s own sidecar address', async () => {
    routes = [NOTES, WIKI];
    await tickTailnet();
    const app = { id: NOTES.id, app: 'notes', hostname: 'notes.tail1.ts.net', agentGroupId: 'ag-1' };
    const headers = { 'tailscale-user-login': 'alice@example.com' };
    expect(await tailnet().identify({ headers, peer: '198.51.100.2' }, app)).toEqual({
      userId: 'webchat:tailscale:alice@example.com',
      displayName: 'alice@example.com',
    });
    // The other app's sidecar, the host itself, loopback: no identity.
    for (const peer of ['198.51.100.3', '198.51.100.1', '127.0.0.1'])
      expect(await tailnet().identify({ headers, peer }, app)).toBeNull();
  });
});
