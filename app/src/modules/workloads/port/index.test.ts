/** The tailnet ports route with Tailscale, the gateway and the state file stood in. */
import { beforeEach, describe, expect, it } from 'vitest';

import type { RunResult } from '../../../channels/webchat/tailscale-serve.js';
import type { GatewaySettings } from '../gateway/config.js';
import { publishingRoute } from '../gateway/publishing.js';
import type { AppRoute } from '../routes.js';
import {
  __refreshPortStatusForTest,
  __setPortDepsForTest,
  portStatus,
  setupRange,
  tickPorts,
  UNCLAIMED_MS,
} from './index.js';
import type { PortState } from './state.js';

const GW: GatewaySettings = {
  on: true,
  ok: true,
  cfg: { bind: '127.0.0.1', port: 8470, internalPort: 8471, image: 'caddy@sha256:' + 'a'.repeat(64) },
};
const ok = (stdout: string): RunResult => ({ ok: true, notFound: false, stdout, stderr: '' });
const STATUS = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'node.tail1.ts.net.' } });
const served = (ports: number[]) =>
  JSON.stringify({
    TCP: Object.fromEntries(ports.map((p) => [String(p), { HTTPS: true }])),
    Web: Object.fromEntries(
      ports.map((p) => [`node.tail1.ts.net:${p}`, { Handlers: { '/': { Proxy: `http://127.0.0.1:${p}` } } }]),
    ),
  });

let range = '9001-9002';
let up = [9001, 9002];
let gw: GatewaySettings = GW;
let saved: PortState = { apps: {} };
let routes: AppRoute[] = [];
let now = 1_000_000;

const appRoute = (app: string): AppRoute => ({
  id: '0b0f7c3e-5a8e-4d3b-9a43-2f1d9c3b7e11',
  app,
  workloadId: 'w1',
  agentGroupId: 'ag-1',
  service: 'web',
  port: 8080,
  kind: 'port',
  who: 'only-me',
  emails: [],
  ownerUserId: 'webchat:tailscale:bob@x.example',
  ticket: null,
  createdBy: 'agent:ag-1',
  createdAt: 0,
  updatedAt: 0,
  lastOpenedAt: null,
});

beforeEach(() => {
  range = '9001-9002';
  up = [9001, 9002];
  gw = GW;
  saved = { apps: {} };
  routes = [];
  now = 1_000_000;
  __setPortDepsForTest({
    settings: () => {
      const [lo, hi] = range.split('-').map(Number);
      const ports = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      return { on: true, ok: true, ports, range };
    },
    gateway: () => gw,
    workloadsOn: () => true,
    tailscale: async (args) => ok(args[0] === 'status' ? STATUS : served(up)),
    routes: async () => routes,
    load: () => structuredClone(saved),
    save: (s) => void (saved = structuredClone(s)),
    now: () => now,
  });
});

const port = () => publishingRoute('port')!;

describe('tailnet ports route', () => {
  it('is connected when at least one port is set up, and gives each app its own', async () => {
    await __refreshPortStatusForTest();
    expect(portStatus().state).toBe('connected');
    expect(await port().enabled()).toBe(true);
    expect(await port().hostnameFor('notes')).toBe('node.tail1.ts.net:9001');
    expect(await port().hostnameFor('wiki')).toBe('node.tail1.ts.net:9002');
    expect(await port().hostnameFor('notes')).toBe('node.tail1.ts.net:9001');
    expect(await port().hostnameFor('third')).toBeNull();
    expect(saved.apps.notes.port).toBe(9001);
  });

  it('gives a port back on unpublish', async () => {
    await __refreshPortStatusForTest();
    await port().hostnameFor('notes');
    await port().detach!(appRoute('notes'));
    expect(saved.apps.notes).toBeUndefined();
    expect(await port().hostnameFor('wiki')).toBe('node.tail1.ts.net:9001');
  });

  it('gives back a port nobody took up after a week, never a published app’s', async () => {
    await __refreshPortStatusForTest();
    await port().hostnameFor('notes');
    await port().hostnameFor('wiki');
    routes = [appRoute('notes')];
    now += UNCLAIMED_MS + 1;
    await tickPorts(true);
    expect(Object.keys(saved.apps)).toEqual(['notes']);
  });

  it('names the setup command while ports are missing, and is not on before any is set up', async () => {
    up = [];
    await __refreshPortStatusForTest();
    expect(portStatus()).toMatchObject({ state: 'missing' });
    expect((portStatus() as { missing: string }).missing).toMatch(/workloads-tailnet-ports\.sh --ports 9001-9002/);
    expect(setupRange()).toBe('9001-9002');
    expect(await port().hostnameFor('notes')).toBeNull();
    up = [9001];
    await __refreshPortStatusForTest();
    expect(portStatus().state).toBe('connected');
    expect(portStatus().warnings.join()).toMatch(/1 of the ports/);
    expect(setupRange()).toBe('9001-9002');
  });

  it('refuses a range that takes the gateway’s own port, or a gateway that is off', async () => {
    range = '8470-8471';
    await __refreshPortStatusForTest();
    expect((portStatus() as { missing: string }).missing).toMatch(/clash with the app gateway/);
    range = '9001-9002';
    gw = { on: false };
    await __refreshPortStatusForTest();
    expect((portStatus() as { missing: string }).missing).toMatch(/app gateway is off/);
  });

  it('believes a Tailscale identity only from loopback, where serve reaches the gateway', async () => {
    const app = { id: 'r1', app: 'notes', hostname: 'node.tail1.ts.net:9001', agentGroupId: 'ag-1' };
    const headers = { 'tailscale-user-login': 'alice@x.example', 'tailscale-user-name': 'Alice' };
    expect(await port().identify({ headers, peer: '127.0.0.1' }, app)).toEqual({
      userId: 'webchat:tailscale:alice@x.example',
      displayName: 'Alice',
    });
    expect(await port().identify({ headers, peer: '198.51.100.2' }, app)).toBeNull();
    expect(await port().identify({ headers: {}, peer: '127.0.0.1' }, app)).toBeNull();
  });

  it('says an app is not ready while its port is not set up', async () => {
    await __refreshPortStatusForTest();
    await port().hostnameFor('notes');
    expect(await port().edgeState!(appRoute('notes'))).toEqual({ ready: true });
    up = [9002];
    await __refreshPortStatusForTest();
    expect((await port().edgeState!(appRoute('notes'))).ready).toBe(false);
  });
});
