/**
 * `ncl workloads up --publish`: one card that deploys AND publishes, against a
 * real database with Docker and the publishing route stood in. What the card
 * shows and pins, what is refused before it, what is checked again on
 * approve (before anything runs), and the line the room reads afterwards.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const GROUPS = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-launch-'));
const DIR = path.join(GROUPS, 'g1');
const D1 = `sha256:${'1'.repeat(64)}`;

const calls = vi.hoisted(() => ({ compose: [] as string[][] }));

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  GROUPS_DIR: GROUPS,
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => (id === 'ag-1' ? { id, folder: 'g1', name: 'G1' } : undefined),
}));
vi.mock('./docker.js', async (orig) => ({
  ...(await orig<typeof import('./docker.js')>()),
  compose: async (_w: unknown, args: string[]) => {
    calls.compose.push(args);
    return '';
  },
  ensureNetwork: async (i: number) => `net-${i}`,
  joinAgentContainers: async () => 0,
  pruneOldImages: async () => undefined,
  refuseReservedImageLabels: async () => undefined,
  sliceStatus: async () => ({ ok: true, memoryMaxMb: 16384 }),
}));

const { closeDb, getDb, initTestDb } = await import('../../db/connection.js');
const { runMigrations } = await import('../../db/migrations/index.js');
const { lookup } = await import('../../cli/registry.js');
await import('./cli.js');
const control = await import('./control.js');
const publish = await import('./publish.js');
const { describeApprovedOutcome } = await import('../approvals/words.js');
const { __setPreflightForTest } = await import('./preflight.js');
const { registerPublishingRoute, __clearPublishingRoutesForTest } = await import('./gateway/publishing.js');
const { workDir } = await import('./docker.js');
const { claimTicket, findRouteByApp, insertRoute } = await import('./routes.js');
const { findWorkload, listWorkloads } = await import('./store.js');

const agent = { caller: 'agent' as const, sessionId: 's1', agentGroupId: 'ag-1', messagingGroupId: 'mg1' };
const up = lookup('workloads-up')!;
const ids = new Set<string>();
let tailnetOn = true;
let cloudflareOn = false;
let tailnetName = 'tail1';
const attached: string[] = [];

const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    expose: ["8080"]\n  db:\n    image: postgres:17\n';

beforeEach(async () => {
  await initTestDb();
  await runMigrations(getDb());
  vi.stubEnv('NANOCLAW_WORKLOADS', '1');
  vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '8470');
  vi.stubEnv('WEBCHAT_TRUSTED_PROXY_IPS', '');
  __setPreflightForTest({ ok: true, reason: '', isolationOpen: false, at: Date.now() });
  control.__setResolverForTest(async () => D1);
  calls.compose = [];
  attached.length = 0;
  tailnetOn = true;
  cloudflareOn = false;
  tailnetName = 'tail1';
  __clearPublishingRoutesForTest();
  registerPublishingRoute({
    kind: 'tailnet',
    label: 'your tailnet',
    enabled: async () => tailnetOn,
    hostnameFor: async (app) => `${app}.${tailnetName}.ts.net`,
    identify: async () => null,
    attach: async (r) => void attached.push(r.app),
  });
  registerPublishingRoute({
    kind: 'cloudflare',
    label: 'Cloudflare',
    enabled: async () => cloudflareOn,
    hostnameFor: async (app) => `${app}.example-apps.net`,
    identify: async () => null,
  });
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'compose.yml'), COMPOSE);
});
afterEach(async () => {
  for (const w of await listWorkloads({ includeDeleted: true })) ids.add(w.id);
  await closeDb();
  vi.unstubAllEnvs();
  __setPreflightForTest(null);
  control.__setResolverForTest(null);
  __clearPublishingRoutesForTest();
});
afterAll(() => {
  for (const id of ids) fs.rmSync(workDir(id), { recursive: true, force: true });
  fs.rmSync(GROUPS, { recursive: true, force: true });
});

const base = { name: 'homeboard', file: 'compose.yml', reason: 'a board for the house' };
const card = async (a: Record<string, unknown> = {}) => (await up.precheck!(up.parseArgs({ ...base, ...a }), agent))!;
/** What the approved card runs: the agent's args with the card's pins on top. */
const approve = async (a: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const c = await card(a);
  return { ...base, ...a, ...c.pin };
};

describe('one card for deploy and publish', () => {
  it('shows what runs AND where people open it, and pins both', async () => {
    const c = await card({ publish: 'tailnet' });
    expect(c.title).toBe('Deploy and publish homeboard');
    expect(c.summary!.split('\n')).toEqual([
      '{agent} wants to deploy the workload "homeboard" and publish it on your tailnet for the agent’s members.',
      'Why: "a board for the house"',
    ]);
    const detail = c.detail!.split('\n');
    expect(detail[0]).toBe('Runs:');
    expect(detail.some((l) => l.includes('"nginx:1.27"'))).toBe(true);
    expect(detail).toContain('Size: 1 GB memory, 1 CPU');
    expect(detail.slice(-3)).toEqual([
      'Address: https://homeboard.tail1.ts.net/',
      'Serves: service "web", port 8080',
      'Who can open: the agent’s members',
    ]);
    const checked = await control.checkWorkload('ag-1', 'homeboard', 'compose.yml');
    expect(c.pin).toEqual({
      approved: control.approvalPin(checked),
      publish: 'tailnet',
      service: 'web',
      port: 8080,
      who: 'agent-members',
      app: 'homeboard',
      hostname: 'homeboard.tail1.ts.net',
      ticket: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // Every pin is a flag up knows, so the card's command line shows it under Details.
    expect(() => up.parseArgs({ ...base, ...c.pin })).not.toThrow();
  });

  it('a plain up is the card it always was', async () => {
    const c = await card();
    expect(c.title).toBe('Deploy workload homeboard');
    expect(Object.keys(c.pin!)).toEqual(['approved']);
    await expect(card({ who: 'signed-in' })).rejects.toThrow(/--who goes with --publish/);
  });

  it('is refused before any card while the route is off, pointing to the switch and to deploying only', async () => {
    tailnetOn = false;
    const err = await card({ publish: 'tailnet' }).catch((e: Error) => e.message);
    expect(err).toMatch(/the tailnet route is not on on this host: an owner can turn on Tailnet in Admin → Publishing/);
    expect(err).toMatch(/deploy without --publish/);
    __clearPublishingRoutesForTest();
    await expect(card({ publish: 'cloudflare' })).rejects.toThrow(/turn on Cloudflare in Admin → Publishing/);
    await expect(card({ publish: 'funnel' })).rejects.toThrow(/--publish must be tailnet, cloudflare or port/);
  });

  it('is refused while the app gateway is off', async () => {
    vi.stubEnv('NANOCLAW_WORKLOAD_GATEWAY_PORT', '');
    await expect(card({ publish: 'tailnet' })).rejects.toThrow(/gateway is off.*deploy without --publish/);
  });

  it('refuses what expose refuses, before a card', async () => {
    await expect(card({ publish: 'tailnet', who: 'anyone' })).rejects.toThrow(/--who must be/);
    await expect(card({ publish: 'tailnet', who: 'specific', emails: 'a@x.example' })).rejects.toThrow(
      /cloudflare route only/,
    );
    await expect(card({ publish: 'tailnet', app: 'nanoclaw-x' })).rejects.toThrow(/--app must be/);
    await expect(card({ publish: 'tailnet', service: 'cache' })).rejects.toThrow(/no service "cache"/);
    // db declares no port: it needs one.
    await expect(card({ publish: 'tailnet', service: 'db' })).rejects.toThrow(/--port is required/);
    await insertRoute({
      app: 'homeboard',
      workloadId: 'someone-else',
      agentGroupId: 'ag-2',
      service: 'web',
      port: 80,
      kind: 'tailnet',
      who: 'only-me',
      ownerUserId: null,
      ticket: null,
      createdBy: 'host',
    });
    await expect(card({ publish: 'tailnet' })).rejects.toThrow(/app name homeboard is taken/);
    expect(calls.compose).toEqual([]);
  });

  it('cards named people on Cloudflare by address, and the widening from what was published', async () => {
    cloudflareOn = true;
    const c = await card({ publish: 'cloudflare', who: 'specific', emails: 'Carol@Example.org, bob@example.com' });
    expect(c.summary!.split('\n')[0]).toBe(
      '{agent} wants to deploy the workload "homeboard" and publish it on Cloudflare for 2 named people.',
    );
    expect(c.detail).toContain('People: "bob@example.com", "carol@example.org"');
    expect(c.pin).toMatchObject({
      publish: 'cloudflare',
      who: 'specific',
      emails: 'bob@example.com,carol@example.org',
    });
  });
});

describe('approving it', () => {
  it('deploys, then publishes with what the card pinned; the approver becomes "only me"', async () => {
    const args = await approve({ publish: 'tailnet', who: 'only-me' });
    const out = (await up.handler(up.parseArgs(args), agent)) as Record<string, unknown>;
    expect(out).toMatchObject({ name: 'homeboard', state: 'running' });
    expect(out.published).toMatchObject({
      app: 'homeboard',
      route: 'tailnet',
      who: 'only-me',
      url: 'https://homeboard.tail1.ts.net/',
      state: 'live',
      open_for: 'only you',
    });
    expect(calls.compose).toContainEqual(['up', '-d', '--remove-orphans', '--no-build', '--pull', 'never']);
    expect(attached).toEqual(['homeboard']);
    const r = (await findRouteByApp('homeboard'))!;
    expect(r).toMatchObject({ service: 'web', port: 8080, ownerUserId: null, ticket: args.ticket });
    const approval = {
      action: 'cli_command',
      payload: JSON.stringify({ frame: { id: 'f1', command: 'workloads-up', args } }),
    };
    const a = publish.approverOf({ approval, outcome: 'approve', userId: 'webchat:owner@x.example' })!;
    expect(a).toEqual({ ticket: args.ticket, userId: 'webchat:owner@x.example' });
    expect(await claimTicket(a.ticket, a.userId)).toBe(true);
    expect((await findRouteByApp('homeboard'))!.ownerUserId).toBe('webchat:owner@x.example');

    // The line the agent and the room's card read.
    const o = describeApprovedOutcome({ id: 'f1', command: 'workloads-up', args }, { id: 'f1', ok: true, data: out });
    expect(o.line).toBe(
      'Approved and done. homeboard is running · open it at https://homeboard.tail1.ts.net (only you)',
    );
    expect(o.failed).toBe(false);
  });

  it('runs only from a card for an agent', async () => {
    await expect(up.handler(up.parseArgs({ ...base, publish: 'tailnet' }), agent)).rejects.toThrow(
      /runs from an approval card/,
    );
    const noTicket = await approve({ publish: 'tailnet' });
    delete noTicket.ticket;
    await expect(up.handler(up.parseArgs(noTicket), agent)).rejects.toThrow(/runs from an approval card/);
    expect(await findWorkload('ag-1', 'homeboard')).toBeNull();
  });

  it('refuses the whole of it, before anything runs, when the route went off after the card', async () => {
    const args = await approve({ publish: 'tailnet' });
    tailnetOn = false;
    await expect(up.handler(up.parseArgs(args), agent)).rejects.toThrow(/tailnet route is not on/);
    expect(calls.compose).toEqual([]);
    expect(await findWorkload('ag-1', 'homeboard')).toBeNull();
  });

  it('refuses when the address changed after the card', async () => {
    const args = await approve({ publish: 'tailnet' });
    tailnetName = 'tail2';
    await expect(up.handler(up.parseArgs(args), agent)).rejects.toThrow(/address changed after the approval/);
    expect(await findWorkload('ag-1', 'homeboard')).toBeNull();
  });

  it('refuses a stack that changed after the card, as up always does', async () => {
    const args = await approve({ publish: 'tailnet' });
    fs.writeFileSync(path.join(DIR, 'compose.yml'), `${COMPOSE}    command: [sh]\n`);
    await expect(up.handler(up.parseArgs(args), agent)).rejects.toThrow(/changed after the approval/);
    expect(await findRouteByApp('homeboard')).toBeNull();
  });

  it('a pinned narrow rule cannot be widened by editing the args after the card', async () => {
    const args = await approve({ publish: 'tailnet', who: 'only-me' });
    // The pins are laid over the agent's args, so the card's "only you" is what runs.
    const out = (await up.handler(up.parseArgs({ ...base, who: 'signed-in', ...args }), agent)) as Record<
      string,
      unknown
    >;
    expect((out.published as Record<string, unknown>).who).toBe('only-me');
  });

  it('a widening re-publish cards what it was', async () => {
    const first = await approve({ publish: 'tailnet', who: 'only-me' });
    await up.handler(up.parseArgs(first), agent);
    const c = await card({ publish: 'tailnet', who: 'agent-members' });
    expect(c.title).toBe('Update and publish homeboard');
    expect(c.detail).toContain('Who can open: the agent’s members (was: only you)');
  });
});

describe('the result line', () => {
  const run = (published: Record<string, unknown>) =>
    describeApprovedOutcome(
      { id: 'f', command: 'workloads-up', args: { name: 'homeboard', publish: 'tailnet' } },
      { id: 'f', ok: true, data: { name: 'homeboard', state: 'running', published } },
    );

  it('says when the address is not reachable yet, and how to find the link', () => {
    expect(run({ app: 'homeboard', url: null, state: 'starting', open_for: 'only you' }).line).toBe(
      "Approved and done. homeboard is running · its address isn't reachable yet (starting); `ncl workloads routes` shows the link once it is live",
    );
  });

  it('is a failure, with its cause, when it deployed but did not publish', () => {
    const o = run({ error: 'the tailnet route is not on on this host' });
    expect(o.failed).toBe(true);
    expect(o.line).toBe(
      'Approved. homeboard is running, but publishing it failed: the tailnet route is not on on this host.',
    );
  });
});
