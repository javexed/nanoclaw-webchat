/**
 * Runtime egress for workload stacks, the workloads side: the declaration in
 * the policy and the approved shape, the proxy settings in the override,
 * placement on central, the subset rule, and who a listener's caller is.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parse } from 'yaml';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  networks: [] as Array<{ agentGroupId: string; idx: number; network: string }>,
  workloads: [] as unknown[],
  mode: 'host-only' as 'open' | 'host-only' | 'none',
  allowlist: [] as string[],
  own: [] as string[],
}));
vi.mock('./store.js', async (orig) => ({
  ...(await orig<typeof import('./store.js')>()),
  allNetworks: async () => db.networks,
  listWorkloads: async (f: { agentGroupId?: string } = {}) =>
    (db.workloads as Array<{ agentGroupId: string }>).filter(
      (w) => !f.agentGroupId || w.agentGroupId === f.agentGroupId,
    ),
}));
vi.mock('../../channels/webchat/egress-policy.js', async (orig) => ({
  ...(await orig<typeof import('../../channels/webchat/egress-policy.js')>()),
  groupEgressMode: async () => db.mode,
  allowlistFor: async () => db.allowlist,
  ownModelTargetsFor: async () => db.own,
}));

import { workloadEgressListeners, __resetWorkloadEgressForTest } from '../../channels/webchat/workload-egress.js';
import { workDir, writeFiles } from './docker.js';
import {
  checkEgressSubset,
  EGRESS_OFF,
  identifyWorkloadCaller,
  requireWorkloadEgress,
  syncWorkloadEgress,
} from './egress.js';
import { buildOverride } from './override.js';
import { placeWorkload } from './placement.js';
import { __setPreflightForTest } from './preflight.js';
import { checkStack, declaredEgress, EGRESS_KEY } from './policy.js';
import { approvedEgress, decodeApproved, describeShape, encodeApproved, stackShape } from './shape.js';
import type { Workload } from './store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-egress-'));
const created: string[] = [dir];
afterAll(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const D1 = `sha256:${'1'.repeat(64)}`;
const quota = { memoryMb: 8192, cpus: 8 };
const check = (text: string, deny?: string[]) => checkStack(text, dir, quota, { egressDeny: deny });
const stackOf = (text: string) => {
  const r = check(text);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.stack;
};

const STACK = `services:
  web:
    image: nginx:1.27
  api:
    image: node:22-slim
    x-nanoclaw-egress: [api.example.com, "*.example.org", "192.0.2.69:11434"]
`;

beforeEach(() => {
  db.networks = [];
  db.workloads = [];
  db.mode = 'host-only';
  db.allowlist = [];
  db.own = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetWorkloadEgressForTest();
});

describe('the declaration', () => {
  it('is normalized per service and refused with the reason', () => {
    expect(declaredEgress(stackOf(STACK))).toEqual({
      api: ['api.example.com', '*.example.org:443', '192.0.2.69:11434'],
    });
    const bad = check(`services:\n  api:\n    image: node:22\n    x-nanoclaw-egress: ["*", "10.0.0.5"]\n`);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain('api: x-nanoclaw-egress: *: a bare *');
    expect(JSON.stringify(bad)).toContain('needs its port');
    expect(
      check(`services:\n  api:\n    image: node:22\n    x-nanoclaw-egress: ["198.51.100.4:443"]\n`, ['198.51.100.0/24'])
        .ok,
    ).toBe(false);
  });

  it('is part of the approved shape: a change needs a new card, a stack without one keeps its hash', async () => {
    const plain = await stackShape(dir, stackOf('services:\n  api:\n    image: node:22-slim\n'), async () => D1);
    expect(plain.services.api.line).toBe(`api: image node:22-slim ${D1}`);
    expect(plain.services.api.egress).toBeUndefined();
    const shape = await stackShape(dir, stackOf(STACK), async () => D1);
    expect(shape.services.api.line).toContain(', egress api.example.com,*.example.org:443,192.0.2.69:11434');
    expect(shape.services.api.text).toContain('may call');
    expect(shape.hash).not.toBe(
      (await stackShape(dir, stackOf(STACK.replace(', "192.0.2.69:11434"', '')), async () => D1)).hash,
    );
    const approved = decodeApproved(encodeApproved(shape));
    expect(approvedEgress(approved)).toEqual({ api: ['api.example.com', '*.example.org:443', '192.0.2.69:11434'] });
    const more = await stackShape(
      dir,
      stackOf(STACK.replace('api.example.com', 'api.example.com, cdn.example.com')),
      async () => D1,
    );
    expect(describeShape(more, approved).join('\n')).toContain('(changed)');
  });
});

describe('the override', () => {
  it('points only the approved services at the proxy, and keeps the stack’s own traffic off it', () => {
    const o = buildOverride(['web', 'api'], {
      project: 'p',
      network: 'n',
      slice: 's',
      labels: {},
      addresses: { web: '198.18.3.10', api: '198.18.3.11' },
      aliases: { web: ['shop-web'] },
      egress: { gateway: '198.18.3.1', port: 8472, subnet: '198.18.3.0/24', services: ['api'] },
    }) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(o.services.web.environment).toBeUndefined();
    const env = o.services.api.environment!;
    expect(env.HTTPS_PROXY).toBe('http://workload:workload@198.18.3.1:8472');
    expect(env.http_proxy).toBe(env.HTTPS_PROXY);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    expect(env.NO_PROXY.split(',')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '198.18.3.0/24', 'web', 'api', 'shop-web', '198.18.3.10']),
    );
    expect(env.NO_PROXY).not.toContain('198.18.3.1,');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('never writes the declaration into the file Compose runs', () => {
    const w = {
      id: `test-${process.pid}-${Date.now()}-egress`,
      agentGroupId: 'ag-1',
      name: 'shop',
      addresses: { api: '198.18.0.10' },
      stack: { compose: { services: { api: { image: 'node:22', [EGRESS_KEY]: ['api.example.com'] } } } },
    } as unknown as Workload;
    created.push(workDir(w.id));
    const files = writeFiles(
      w,
      'nc-wl-x-0',
      { api: 'node:22' },
      {
        gateway: '198.18.0.1',
        port: 8472,
        subnet: '198.18.0.0/24',
        services: ['api'],
      },
    );
    const stack = parse(fs.readFileSync(files.stack, 'utf-8')) as { services: Record<string, Record<string, unknown>> };
    expect(stack.services.api[EGRESS_KEY]).toBeUndefined();
    const override = parse(fs.readFileSync(files.override, 'utf-8')) as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    expect(override.services.api.environment.HTTP_PROXY).toBe('http://workload:workload@198.18.0.1:8472');
  });
});

describe('placement', () => {
  const deps = (pin: string | null) => ({
    members: async () => [],
    linked: () => true,
    workloads: async () => [],
    pin: async () => pin,
  });

  it('keeps a stack that calls out on central, and refuses an agent pinned to a worker', async () => {
    expect((await placeWorkload('ag', { memoryMb: 512, cpus: 1, egress: true }, deps(null))).node).toBe('local');
    expect((await placeWorkload('ag', { memoryMb: 512, cpus: 1, egress: true }, deps('local'))).node).toBe('local');
    await expect(placeWorkload('ag', { memoryMb: 512, cpus: 1, egress: true }, deps('m-1'))).rejects.toThrow(
      /central only/,
    );
  });
});

describe('the switch and the subset rule', () => {
  it('is off until an owner sets the port', () => {
    expect(() => requireWorkloadEgress()).toThrow(EGRESS_OFF);
    vi.stubEnv('NANOCLAW_WORKLOAD_EGRESS_PORT', 'nope');
    expect(() => requireWorkloadEgress()).toThrow(EGRESS_OFF);
    vi.stubEnv('NANOCLAW_WORKLOAD_EGRESS_PORT', '8472');
    expect(() => requireWorkloadEgress()).toThrow(/still being checked/);
    const passed = { ok: true, reason: '', isolationOpen: false, at: 1 };
    __setPreflightForTest({ ...passed, egress: { port: 8472, ok: false, reason: 'a service listens on port 8472' } });
    expect(() => requireWorkloadEgress()).toThrow('a service listens on port 8472');
    __setPreflightForTest({ ...passed, egress: { port: 8472, ok: true, reason: '' } });
    expect(requireWorkloadEgress()).toBe(8472);
    // Checked on another port: not this one.
    vi.stubEnv('NANOCLAW_WORKLOAD_EGRESS_PORT', '8473');
    expect(() => requireWorkloadEgress()).toThrow(/still being checked/);
    __setPreflightForTest(null);
  });

  it('holds each entry to what the agent may reach itself', async () => {
    const stack = stackOf(STACK);
    db.allowlist = ['api.example.com', '*.example.org'];
    db.own = ['192.0.2.69:11434'];
    await expect(checkEgressSubset('ag-1', stack)).resolves.toBeUndefined();
    db.allowlist = ['api.example.com'];
    await expect(checkEgressSubset('ag-1', stack)).rejects.toThrow(/api: x-nanoclaw-egress \*\.example\.org:443/);
    db.mode = 'open';
    await expect(checkEgressSubset('ag-1', stack)).resolves.toBeUndefined();
    db.mode = 'none';
    await expect(checkEgressSubset('ag-1', stack)).rejects.toThrow(/Model only/);
  });
});

describe('who calls on a listener', () => {
  const approvedShape = encodeApproved({
    hash: 'h',
    lines: [],
    services: { api: { line: 'x', text: 'x', egress: ['api.example.com'] }, web: { line: 'y', text: 'y' } },
  });
  const w = (over: Partial<Workload> = {}): Workload =>
    ({
      id: 'w1',
      agentGroupId: 'ag-1',
      name: 'shop',
      node: 'local',
      state: 'running',
      asleepAt: null,
      addresses: { api: '198.18.3.10', web: '198.18.3.11' },
      approvedShape,
      ...over,
    }) as Workload;

  beforeEach(() => {
    db.networks = [{ agentGroupId: 'ag-1', idx: 3, network: 'nc-wl-x-3' }];
  });

  it('is a running service by its address, with what was approved for it', async () => {
    db.workloads = [w()];
    expect(await identifyWorkloadCaller('198.18.3.1', '198.18.3.10')).toEqual({
      agentGroupId: 'ag-1',
      sessionId: 'workload:w1/api',
      workloadId: 'w1',
      service: 'api',
      approved: ['api.example.com'],
    });
    expect((await identifyWorkloadCaller('198.18.3.1', '198.18.3.11'))?.approved).toEqual([]);
  });

  it('is nobody approved for anything when it is the agent’s own container, or the stack is not running', async () => {
    db.workloads = [w()];
    expect(await identifyWorkloadCaller('198.18.3.1', '198.18.3.130')).toMatchObject({
      agentGroupId: 'ag-1',
      sessionId: 'workload:unknown',
      approved: [],
    });
    db.workloads = [w({ state: 'stopped' })];
    expect((await identifyWorkloadCaller('198.18.3.1', '198.18.3.10'))?.approved).toEqual([]);
    expect(await identifyWorkloadCaller('198.18.9.1', '198.18.9.10')).toBeNull();
  });

  it('opens no listener while the switch is off, and closes one nothing needs', async () => {
    db.workloads = [w()];
    await syncWorkloadEgress();
    expect(workloadEgressListeners()).toEqual([]);
    db.workloads = [w({ state: 'stopped' })];
    vi.stubEnv('NANOCLAW_WORKLOAD_EGRESS_PORT', '8472');
    await syncWorkloadEgress();
    expect(workloadEgressListeners()).toEqual([]);
  });
});
